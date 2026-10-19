/**
 * Режим чтения открытой формы при чужом захвате (ошибка 4f18d9f5).
 *
 * Симптом: тост говорил «поля заблокированы», но поля в диалогах оставались
 * редактируемыми, а запись падала 409. Контракт `blockEditingSurface`:
 * поля ввода и кнопки записи выключаются, значения и закрытие остаются
 * доступными (чтение не блокируется, ADR 705fb6d3).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.etn = { ui: { setState: async () => undefined, getState: async () => 'main' } };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

installShim();

const { LOCK_BLOCKED_ATTR, blockEditingSurface, unblockEditingSurface } = await import(
  '../src/renderer/lib/lock-surface.js'
);

function field(tag: string): ShimElement {
  return new ShimElement(tag);
}

describe('blockEditingSurface: чужая блокировка переводит форму в чтение', () => {
  it('выключает поля ввода, contenteditable и кнопки записи', () => {
    const root = field('div');
    const input = field('input');
    const textarea = field('textarea');
    const select = field('select');
    const editable = field('div');
    editable.setAttribute('contenteditable', 'true');
    // DOM-шим ищет атрибуты только через `dataset`; в браузере хватает
    // setAttribute (селектор `[contenteditable="true"]`).
    editable.dataset['contenteditable'] = 'true';
    const apply = field('button');
    const cancel = field('button');
    root.append(input, textarea, select, editable, apply, cancel);

    blockEditingSurface({
      root: root as unknown as HTMLElement,
      message: 'Эту мысль редактирует Участник B — поля заблокированы.',
      commitButtons: [apply as unknown as HTMLElement],
    });

    for (const el of [input, textarea, select]) {
      assert.equal(el.disabled, true, `${el.tagName} выключен`);
    }
    assert.equal(editable.getAttribute('contenteditable'), 'false', 'contenteditable снят');
    assert.equal(apply.disabled, true, 'кнопка записи выключена');
    assert.equal(cancel.disabled, false, 'закрытие/отмена остаются доступными');
  });

  it('добавляет ровно одну строку-предупреждение и обновляет её текст', () => {
    const root = field('div');
    root.append(field('input'));

    blockEditingSurface({ root: root as unknown as HTMLElement, message: 'первое' });
    blockEditingSurface({ root: root as unknown as HTMLElement, message: 'второе' });

    const notes = root.querySelectorAll(`[${LOCK_BLOCKED_ATTR}]`);
    assert.equal(notes.length, 1, 'строка не дублируется');
    assert.equal(notes[0]!.textContent, 'второе', 'текст обновлён');
    assert.ok(notes[0]!.className.includes('dialog-text-error'), 'строка оформлена как предупреждение');
  });
});

describe('unblockEditingSurface: снятие захвата возвращает редактирование (2301d73d)', () => {
  it('включает обратно поля и кнопку записи, убирает предупреждение', () => {
    const root = field('div');
    const input = field('input');
    const editable = field('div');
    editable.setAttribute('contenteditable', 'true');
    editable.dataset['contenteditable'] = 'true';
    const apply = field('button');
    root.append(input, editable, apply);

    blockEditingSurface({
      root: root as unknown as HTMLElement,
      message: 'Эту мысль редактирует Участник B — поля заблокированы.',
      commitButtons: [apply as unknown as HTMLElement],
    });
    assert.equal(input.disabled, true);
    assert.equal(apply.disabled, true);

    unblockEditingSurface(root as unknown as HTMLElement);

    assert.equal(input.disabled, false, 'поле снова редактируется');
    assert.equal(apply.disabled, false, 'кнопка записи снова доступна');
    assert.equal(editable.getAttribute('contenteditable'), 'true', 'contenteditable восстановлен');
    assert.equal(
      root.querySelectorAll(`[${LOCK_BLOCKED_ATTR}]`).length,
      0,
      'предупреждение убрано',
    );
  });

  it('восстанавливает ИСХОДНОЕ состояние: изначально выключенное остаётся выключенным', () => {
    const root = field('div');
    const enabled = field('input');
    const disabled = field('input');
    disabled.disabled = true;
    const busy = field('button');
    busy.disabled = true; // например, «Применить» выключен проверкой имени
    root.append(enabled, disabled, busy);

    blockEditingSurface({
      root: root as unknown as HTMLElement,
      message: 'заблокировано',
      commitButtons: [busy as unknown as HTMLElement],
    });
    unblockEditingSurface(root as unknown as HTMLElement);

    assert.equal(enabled.disabled, false);
    assert.equal(disabled.disabled, true, 'изначально выключенное поле не включается');
    assert.equal(busy.disabled, true, 'изначально выключенная кнопка не включается');
  });

  it('блокирует поля, появившиеся при перерисовке, и тоже их отпускает', () => {
    const root = field('div');
    const first = field('input');
    root.append(first);
    blockEditingSurface({ root: root as unknown as HTMLElement, message: 'заблокировано' });
    // Перерисовка вкладки/формы добавила новое поле — оно обязано быть в чтении.
    const fresh = field('input');
    root.append(fresh);
    blockEditingSurface({ root: root as unknown as HTMLElement, message: 'заблокировано' });
    assert.equal(fresh.disabled, true, 'новое поле выключено');

    unblockEditingSurface(root as unknown as HTMLElement);
    assert.equal(first.disabled, false);
    assert.equal(fresh.disabled, false, 'новое поле отпущено вместе с формой');
  });

  it('повторный unblock безопасен', () => {
    const root = field('div');
    root.append(field('input'));
    blockEditingSurface({ root: root as unknown as HTMLElement, message: 'заблокировано' });
    unblockEditingSurface(root as unknown as HTMLElement);
    assert.doesNotThrow(() => unblockEditingSurface(root as unknown as HTMLElement));
  });
});

describe('subscribeForeignLockState: диалог следует за кэшем захватов', () => {
  it('сообщает о появлении и снятии чужого захвата, отписка прекращает вызовы', async () => {
    const { subscribeForeignLockState } = await import('../src/renderer/lib/lock-guard.js');
    const locks = await import('../src/renderer/lib/lock-cache.js');
    const seen: Array<string | null> = [];
    const off = subscribeForeignLockState('thought', 't-2301d73d', (holder) => {
      seen.push(holder === null ? null : holder.id);
    });

    try {
      assert.deepEqual(seen, [null], 'сразу отдаёт текущее состояние (захвата нет)');

      locks.__setForTests([
        {
          id: 'lock-2301d73d',
          entity_type: 'thought',
          entity_id: 't-2301d73d',
          user_id: 'user-other',
          client_id: null,
          acquired_at_ms: 1,
        },
      ]);
      assert.deepEqual(seen, [null, 'lock-2301d73d'], 'чужой захват — режим чтения');

      locks.__setForTests([]);
      assert.deepEqual(seen, [null, 'lock-2301d73d', null], 'снятие захвата — обратно в редактирование');

      off();
      locks.__setForTests([
        {
          id: 'lock-2301d73d',
          entity_type: 'thought',
          entity_id: 't-2301d73d',
          user_id: 'user-other',
          client_id: null,
          acquired_at_ms: 1,
        },
      ]);
      assert.equal(seen.length, 3, 'после отписки вызовов нет');
    } finally {
      off();
      locks.__resetForTests();
    }
  });
});
