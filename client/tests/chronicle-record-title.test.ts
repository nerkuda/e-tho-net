/**
 * Заголовок записи «Дневника» — единый компонент «просмотр ↔ правка» (0.10.2,
 * ошибка 36c330a3). Поведенческий DOM-тест на шиме: контракт правки
 * «Enter — завершить, Escape — отменить, blur — завершить» и возврат в группу-
 * просмотр с сохранением индикатора-стрелки.
 *
 * Регресс, который закрепляется: в СЛОТЕ создания заголовок открывался голым
 * полем без обработчика `Enter` — нажатие не делало ничего. Теперь слот берёт
 * тот же компонент (сторож `guard-chronicle-record-title`), и этот тест
 * фиксирует, что после `Enter` на месте поля оказывается кнопка-группа.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import { ShimElement } from './dom-shim.js';

// Клавиатура правки идёт через диспетчер контекстов: стек между тестами чист.
beforeEach(() => keymap.keymapInternals.reset());

/** Минимальный DOM-шим, нужный компоненту и фасадам `lib/ui`. */
function installShim(): void {
  const body = new ShimElement('body');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = {
    documentElement: new ShimElement('html'),
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body,
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win['setTimeout'] = setTimeout;
  win['clearTimeout'] = clearTimeout;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
}

interface TitleHandle {
  node(): ShimElement;
  value(): string;
  isEditing(): boolean;
  beginEdit(): void;
  endEdit(commit: boolean, refocus: boolean): void;
}

async function makeTitle(opts: Record<string, unknown>): Promise<TitleHandle> {
  installShim();
  const { createRecordTitle } = await import(
    '../src/renderer/screens/chronicle/record-title.js'
  );
  return createRecordTitle(opts as never) as unknown as TitleHandle;
}

function pressEnter(node: ShimElement, mods: Record<string, boolean> = {}): void {
  // Контекст правки уже на стеке (beginEdit кладёт его сразу).
  keymap.dispatchKeyEvent({
    key: 'Enter',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
    target: node,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as KeyboardEvent);
}

function pressEscape(node: ShimElement): void {
  keymap.dispatchKeyEvent({
    key: 'Escape',
    target: node,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as KeyboardEvent);
}

/** Последний текстовый узел кнопки-заголовка — её надпись (после replaceChildren). */
function labelOf(view: ShimElement): string {
  const last = view.children[view.children.length - 1];
  return last?.textContent ?? '';
}

describe('компонент заголовка записи: просмотр ↔ правка (ошибка 36c330a3)', () => {
  it('просмотр — кнопка-группа со стрелкой; двойной клик входит в правку', async () => {
    const handle = await makeTitle({
      value: 'Встреча',
      label: 'Встреча',
      editHint: 'Правка',
      placeholder: 'Заголовок',
    });
    const view = handle.node();
    assert.equal(view.tagName, 'button', 'просмотр — кнопка');
    assert.ok(view.classList.contains('diary-record-title'), 'класс заголовка');
    assert.ok(view.firstChild !== null, 'у группы есть индикатор-стрелка');
    assert.equal(view.firstChild!.tagName, 'svg', 'индикатор — svg `chevron-down`');

    view.emit('dblclick', { preventDefault: () => undefined });
    assert.equal(handle.isEditing(), true, 'двойной клик вошёл в правку');
    assert.equal(handle.node().tagName, 'input', 'на месте заголовка — поле ввода');
  });

  it('Enter завершает правку и возвращает группу-просмотр со стрелкой', async () => {
    const committed: string[] = [];
    const handle = await makeTitle({
      value: '',
      label: 'Пустая запись',
      editHint: 'Правка',
      placeholder: 'Заголовок',
      onCommit: (next: string) => {
        committed.push(next);
        return next.trim() || 'Пустая запись';
      },
    });
    const host = new ShimElement('div');
    host.append(handle.node());

    handle.beginEdit();
    const field = handle.node();
    assert.equal(field.tagName, 'input', 'слот открывается в правке');
    field.value = 'Дневник';
    pressEnter(field);

    assert.deepEqual(committed, ['Дневник'], 'введённый заголовок закоммичен');
    assert.equal(handle.isEditing(), false, 'правка завершена');
    assert.equal(handle.node().tagName, 'button', 'вместо поля — кнопка-группа (не «ничего»)');
    assert.ok(handle.node().classList.contains('diary-record-title'), 'класс заголовка сохранён');
    assert.equal(handle.node().firstChild!.tagName, 'svg', 'стрелка-индикатор на месте');
    assert.equal(labelOf(handle.node()), 'Дневник', 'надпись обновилась');
    assert.equal(handle.node().focused, true, 'фокус вернулся в просмотр');
  });

  it('модификаторный Enter (Ctrl/Alt/Meta) тоже завершает правку, как прежде', async () => {
    const committed: string[] = [];
    const handle = await makeTitle({
      value: 'Старый',
      label: 'Старый',
      editHint: 'Правка',
      placeholder: 'Заголовок',
      onCommit: (next: string) => {
        committed.push(next);
        return next;
      },
    });
    const host = new ShimElement('div');
    host.append(handle.node());

    handle.beginEdit();
    handle.node().value = 'Новый';
    pressEnter(handle.node(), { ctrlKey: true });
    assert.deepEqual(committed, ['Новый'], 'Ctrl+Enter завершил правку и закоммитил значение (задача fd3d84f4)');
    assert.equal(handle.isEditing(), false, 'правка завершена');
  });

  it('Escape отменяет правку: значение не коммитится, надпись прежняя', async () => {
    const committed: string[] = [];
    let cancelled = 0;
    const handle = await makeTitle({
      value: 'Старый',
      label: 'Старый',
      editHint: 'Правка',
      placeholder: 'Заголовок',
      onCommit: (next: string) => {
        committed.push(next);
        return next;
      },
      onCancel: () => {
        cancelled++;
      },
    });
    const host = new ShimElement('div');
    host.append(handle.node());

    handle.beginEdit();
    handle.node().value = 'Изменённый';
    pressEscape(handle.node());

    assert.deepEqual(committed, [], 'Escape не коммитит');
    assert.equal(cancelled, 1, 'отмена замечена');
    assert.equal(handle.node().tagName, 'button', 'вернулись в просмотр');
    assert.equal(labelOf(handle.node()), 'Старый', 'надпись прежняя');
  });

  it('blur завершает правку (слот сохраняет черновик по уходу из поля)', async () => {
    const committed: string[] = [];
    const handle = await makeTitle({
      value: '',
      label: 'Пустая запись',
      editHint: 'Правка',
      placeholder: 'Заголовок',
      onCommit: (next: string) => {
        committed.push(next);
        return next.trim() || 'Пустая запись';
      },
    });
    const host = new ShimElement('div');
    host.append(handle.node());

    handle.beginEdit();
    handle.node().value = 'Встреча';
    handle.node().emit('blur');

    assert.deepEqual(committed, ['Встреча'], 'blur сохранил значение');
    assert.equal(handle.node().tagName, 'button', 'после blur — просмотр');
  });

  it('правка сохраняет класс `is-collapsed` кнопки-заголовка (поворот стрелки)', async () => {
    const handle = await makeTitle({
      value: 'Запись',
      label: 'Запись',
      editHint: 'Правка',
      placeholder: 'Заголовок',
    });
    const view = handle.node();
    view.classList.add('is-collapsed');

    handle.beginEdit();
    pressEnter(handle.node());

    assert.ok(handle.node().classList.contains('is-collapsed'), 'состояние свёрнутости не потеряно');
    assert.ok(handle.node() === view, 'узел кнопки сохранён (идентичность)');
  });

  it('`collapsible: false` — просмотр без стрелки (несворачиваемая группа)', async () => {
    const handle = await makeTitle({
      value: '',
      label: 'Пустая запись',
      editHint: 'Правка',
      placeholder: 'Заголовок',
      collapsible: false,
    });
    assert.equal(handle.node().firstChild, null, 'индикатора-стрелки нет');
  });

  it('повторный beginEdit после коммита открывает поле с последним значением', async () => {
    const handle = await makeTitle({
      value: 'A',
      label: 'A',
      editHint: 'Правка',
      placeholder: 'Заголовок',
      onCommit: (next: string) => next,
    });
    const host = new ShimElement('div');
    host.append(handle.node());

    handle.beginEdit();
    handle.node().value = 'B';
    pressEnter(handle.node());

    handle.beginEdit();
    assert.equal(handle.node().tagName, 'input', 'снова правка');
    assert.equal(handle.node().value, 'B', 'поле несёт последнее сохранённое значение');
  });
});
