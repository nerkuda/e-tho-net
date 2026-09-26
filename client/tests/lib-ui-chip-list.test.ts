/**
 * Юнит-тесты generic-чип-листа `lib/ui/chip-list.ts` (требование d1cd2095,
 * задача f348e095): чипы выбранных значений с крестиком снятия и поле
 * добавления из кандидатов. Модуль гоняется под Node с минимальным DOM-шимом
 * (тот же подход, что у suggest-dropdown.test.ts).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chipList } from '../src/renderer/lib/ui/chip-list.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
  };
}

/** Окружение одного чип-листа с наблюдаемыми изменениями значений. */
function build(initial: string[], options: string[] = []) {
  installShim();
  let values = [...initial];
  const removed: string[] = [];
  const added: string[] = [];
  const handle = chipList({
    getValues: () => values,
    labelOf: (v) => `#${v}`,
    onRemove: (v) => {
      removed.push(v);
      values = values.filter((x) => x !== v);
    },
    getOptions: () => options.map((v) => ({ value: v, label: `+${v}` })),
    onAdd: (v) => {
      added.push(v);
      values = [...values, v];
    },
    addPlaceholder: 'добавить…',
    emptyText: 'пусто',
    removeTitle: 'Убрать',
  });
  return { handle, removed, added };
}

const chips = (root: ShimElement): ShimElement[] =>
  root.findAll((el) => el.classList.contains('ui-chip'));
const addSelect = (root: ShimElement): ShimElement => root.querySelector('.ui-chip-list-add')!;
const options = (select: ShimElement): ShimElement[] =>
  select.children.filter((c) => c.tagName === 'option');

describe('lib/ui/chip-list', () => {
  it('рисует чипы выбранных значений с подписью и крестиком снятия', () => {
    const { handle } = build(['a', 'b']);
    const root = handle.root as unknown as ShimElement;
    assert.ok(root.classList.contains('ui-chip-list'));
    const items = chips(root);
    assert.equal(items.length, 2, 'по чипу на значение');
    assert.equal(items[0]!.querySelector('.ui-chip-label')?.textContent, '#a');
    assert.equal(items[0]!.querySelector('.ui-chip-remove')?.textContent, '×');
    assert.equal(items[0]!.querySelector('.ui-chip-remove')?.title, 'Убрать');
  });

  it('пустой набор показывает текст пустого состояния', () => {
    const { handle } = build([]);
    const root = handle.root as unknown as ShimElement;
    // Текст пустого состояния — заголовок (+ подсказка) общего компонента
    // `lib/ui/empty-state.ts` внутри хука `.ui-chip-list-empty`.
    const empty = root.querySelector('.ui-chip-list-empty')!;
    assert.ok(empty.flatText().includes('пусто'), 'виден заголовок пустого состояния');
    assert.ok(empty.querySelector('.ui-empty__title') !== null, 'заголовок — общий компонент');
    assert.equal(chips(root).length, 0);
  });

  it('крестик снимает значение и перерисовывает список', () => {
    const { handle, removed } = build(['a', 'b']);
    const root = handle.root as unknown as ShimElement;
    chips(root)[0]!.querySelector('.ui-chip-remove')!.emit('click');
    assert.deepEqual(removed, ['a'], 'владелец уведомлён о снятии');
    assert.equal(chips(root).length, 1, 'чип исчез без ручного refresh');
    assert.equal(chips(root)[0]!.querySelector('.ui-chip-label')?.textContent, '#b');
  });

  it('поле добавления перечисляет кандидатов без уже выбранных', () => {
    const { handle } = build(['a'], ['a', 'b', 'c']);
    const select = addSelect(handle.root as unknown as ShimElement);
    const values = options(select).map((o) => o.value);
    assert.deepEqual(values, ['', 'b', 'c'], 'пустой пункт + невыбранные кандидаты');
    assert.equal(options(select)[0]!.textContent, 'добавить…');
  });

  it('выбор в поле добавления добавляет значение и перерисовывает список', () => {
    const { handle, added } = build([], ['x', 'y']);
    const root = handle.root as unknown as ShimElement;
    const select = addSelect(root);
    select.value = 'y';
    select.emit('change');
    assert.deepEqual(added, ['y'], 'владелец уведомлён о добавлении');
    assert.equal(chips(root).length, 1);
    assert.equal(chips(root)[0]!.querySelector('.ui-chip-label')?.textContent, '#y');
    assert.deepEqual(
      options(addSelect(root)).map((o) => o.value),
      ['', 'x'],
      'добавленный кандидат ушёл из списка добавления',
    );
  });
});
