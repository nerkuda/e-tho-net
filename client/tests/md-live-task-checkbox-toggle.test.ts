/**
 * Клики по чекбоксам задач в режиме РЕДАКТИРОВАНИЯ (0.16.1, уточнение
 * 2026-11-19, пункт 10; спека `0e85b66e`).
 *
 * В live-preview CM6 маркер `- [ ]` / `- [x]` заменён живым виджетом-чекбоксом.
 * Клик по нему обязан менять значение В БУФЕРЕ документа (декорация
 * перерисовывается по транзакции), а запись в источник делает штатное
 * сохранение поля — отказ от правки откатывает документ, и ни текст, ни задачи
 * не меняются.
 *
 * Здесь проверяется ядро `toggleTaskMarkerInDoc`: правится РОВНО один символ
 * между скобками, транзакция помечена шагом истории (отмена — штатный undo), а
 * вне диапазона маркера функция молчит.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toggleTaskMarkerInDoc } from '../src/renderer/editor/md-live.js';

/** Фейковый `EditorView`: чтение документа и шпион `dispatch`. */
function fakeView(doc: string): {
  state: { sliceDoc: (from: number, to: number) => string };
  dispatch: (spec: any) => void;
  events: any[];
} {
  const events: any[] = [];
  return {
    state: { sliceDoc: (from, to) => doc.slice(from, to) },
    dispatch: (spec) => events.push(spec),
    events,
  };
}

/** Диапазон маркера `[ ]`/`[x]` в строке `- [ ] текст` — `[2, 5)`. */
const FROM = 2;
const TO = 5;

describe('toggleTaskMarkerInDoc: клик по чекбоксу меняет значение в буфере (пункт 10)', () => {
  it('`[ ]` → `[x]`: правится ровно один символ между скобками', () => {
    const view = fakeView('- [ ] задача');
    const handled = toggleTaskMarkerInDoc(view as any, FROM, TO);
    assert.equal(handled, true, 'переключение выполнено');
    assert.equal(view.events.length, 1, 'одна транзакция в буфер');
    assert.deepEqual(
      view.events[0]!.changes,
      { from: FROM + 1, to: FROM + 2, insert: 'x' },
      'меняется ТОЛЬКО символ отметки, скобки и текст целы',
    );
    assert.equal(view.events[0]!.userEvent, 'input.taskToggle', 'шаг помечен для истории/отмены');
  });

  it('`[x]` → `[ ]`: отметка снимается', () => {
    const view = fakeView('- [x] задача');
    assert.equal(toggleTaskMarkerInDoc(view as any, FROM, TO), true);
    assert.deepEqual(view.events[0]!.changes, { from: FROM + 1, to: FROM + 2, insert: ' ' });
  });

  it('`[X]` (заглавная) → `[ ]`', () => {
    const view = fakeView('- [X] задача');
    assert.equal(toggleTaskMarkerInDoc(view as any, FROM, TO), true);
    assert.equal(view.events[0]!.changes.insert, ' ');
  });

  it('вне диапазона маркера функция молчит (ни транзакции, ни изменения каретки)', () => {
    const view = fakeView('- задача');
    assert.equal(toggleTaskMarkerInDoc(view as any, 2, 2), false, 'пустой диапазон — не маркер');
    assert.equal(
      toggleTaskMarkerInDoc(view as any, 3, 9),
      false,
      'обычный текст вместо `[ ]` — не маркер',
    );
    assert.equal(view.events.length, 0, 'транзакций нет');
  });

  it('запись в источник не делается: функция только правит буфер', () => {
    // Контракт «применение только при сохранении»: у функции нет доступа к
    // `etn.*`, единственный побочный эффект — транзакция `dispatch`.
    const view = fakeView('- [ ] задача');
    toggleTaskMarkerInDoc(view as any, FROM, TO);
    assert.equal(view.events.length, 1);
    assert.deepEqual(Object.keys(view.events[0]!.changes).sort(), ['from', 'insert', 'to']);
  });
});
