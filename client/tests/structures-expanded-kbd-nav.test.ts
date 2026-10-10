/**
 * Клавиатурная навигация дерева «Структур мыслей» по ВСЕМ видимым строкам
 * (задача e80da89f п.3, L15/§15.10).
 *
 * Сценарий пользователя: ↓ выделил мысль в середине списка отбора, Ctrl+↓/Ctrl+↑
 * раскрыл потомков и родителей, ↑ ушёл на соседнюю строку — и ↓ больше НЕ заходил
 * в раскрытый блок. Причина: курсор хранился id МЫСЛИ, а одна мысль может быть
 * видна НЕСКОЛЬКИМИ строками (корень отбора одной ветви и раскрытый родитель/
 * потомок другой — соседи приходят без дедупа между ветвями). Поиск строки по id
 * находил первое вхождение, и ход «залипал» на строках отбора. Курсор обязан
 * храниться по УНИКАЛЬНОМУ ключу строки (`root/child`, `root^parent`).
 *
 * Проверяется интеракционно на контроллере `structures/kbd-nav.ts` через общий
 * DOM-шим (симуляция keydown, проверка класса `.kbd-cursor` на строках).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import {
  initStructuresKbdNav,
  resetStructuresCursor,
  syncStructuresCursor,
} from '../src/renderer/screens/structures/kbd-nav.js';
import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';

// Клавиатура дерева идёт через диспетчер контекстов: стек между тестами чист.
beforeEach(() => keymap.keymapInternals.reset());

/** Одна строка дерева: `data-key` (уникальный путь), `data-id` (мысль), `data-root`. */
function row(key: string, id: string, root = 'r'): ShimElement {
  const rowEl = new ShimElement('div', 'st-row');
  rowEl.dataset['key'] = key;
  rowEl.dataset['id'] = id;
  rowEl.dataset['root'] = root;
  const cloud = new ShimElement('div', 'st-cloud cloud');
  cloud.dataset['id'] = id;
  rowEl.append(cloud);
  return rowEl;
}

/** Ключи строк под пунктирным курсором. */
function cursorKeys(host: ShimElement): string[] {
  return host.querySelectorAll('.kbd-cursor').map((cloud) => cloud.parent?.dataset['key'] ?? '');
}

interface Spy {
  opened: string[];
  toggles: Array<{ key: string; id: string; root: string; dir: string }>;
}

function mount(host: ShimElement): Spy {
  store.update({ activeView: 'structures', editorTarget: null } as never);
  resetStructuresCursor();
  const spy: Spy = { opened: [], toggles: [] };
  initStructuresKbdNav(host as unknown as HTMLElement, {
    openThought: (id) => spy.opened.push(id),
    toggleExpand: (key, id, root, dir) => spy.toggles.push({ key, id, root, dir }),
  });
  return spy;
}

function press(
  host: ShimElement,
  key: string,
  ctrl = false,
  mods: Record<string, boolean> = {},
): void {
  // Фокус внутри хоста кладёт его контекст на вершину стека диспетчера.
  host.emit('focusin', {});
  keymap.dispatchKeyEvent({
    key,
    ctrlKey: ctrl,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
    target: host,
    preventDefault: (): void => undefined,
  } as unknown as KeyboardEvent);
  host.emit('focusout', {});
}

describe('«Структуры»: ↑/↓ по всем видимым строкам, включая раскрытые (e80da89f п.3)', () => {
  it('ход заходит в раскрытые родителей и потомков и возвращается через них', () => {
    const host = new ShimElement('div', 'st-results');
    host.append(row('k1', 'id1'), row('kM', 'idM'), row('k3', 'id3'));
    mount(host);
    press(host, 'ArrowDown');
    press(host, 'ArrowDown');
    assert.deepEqual(cursorKeys(host), ['kM'], 'курсор на строке отбора M');

    // Раскрытие родителей/потомков добавляет строки вокруг M (как renderTree).
    host.replaceChildren(
      row('k1', 'id1'),
      row('kM^p', 'idP'),
      row('kM', 'idM'),
      row('kM/c', 'idC'),
      row('k3', 'id3'),
    );
    syncStructuresCursor();
    assert.deepEqual(cursorKeys(host), ['kM'], 'курсор переприменён после пересборки');

    press(host, 'ArrowUp');
    assert.deepEqual(cursorKeys(host), ['kM^p'], '↑ заходит в блок раскрытых родителей');
    press(host, 'ArrowDown');
    assert.deepEqual(cursorKeys(host), ['kM'], '↓ возвращается через родителя к M');
    press(host, 'ArrowDown');
    assert.deepEqual(cursorKeys(host), ['kM/c'], '↓ заходит в блок раскрытых потомков');
    press(host, 'ArrowDown');
    assert.deepEqual(cursorKeys(host), ['k3'], '↓ выходит к следующей строке отбора');
  });

  it('одна мысль несколькими строками: курсор различает строки по уникальному ключу', () => {
    const host = new ShimElement('div', 'st-results');
    // idX — корень ветви b1 и раскрытый родитель ветви b2 (разные строки).
    host.append(
      row('a', 'idX', 'b1'),
      row('a/c', 'idC', 'b1'),
      row('b', 'idY', 'b2'),
      row('b/p', 'idX', 'b2'),
      row('c', 'idK', 'b2'),
    );
    mount(host);
    press(host, 'ArrowDown'); // a
    press(host, 'ArrowDown'); // a/c
    press(host, 'ArrowDown'); // b
    press(host, 'ArrowDown'); // b/p (idX повторно)
    assert.deepEqual(cursorKeys(host), ['b/p'], 'курсор на второй строке мысли idX');
    press(host, 'ArrowDown');
    assert.deepEqual(cursorKeys(host), ['c'], '↓ идёт дальше по строкам, а не назад к первой idX');
    press(host, 'ArrowUp');
    assert.deepEqual(cursorKeys(host), ['b/p'], '↑ возвращается на ту же строку, а не на первую idX');
  });

  it('Enter открывает мысль СТРОКИ под курсором; Ctrl+↑/↓ раскрывают её направление', () => {
    const host = new ShimElement('div', 'st-results');
    host.append(row('a', 'idX', 'b1'), row('b/p', 'idX', 'b2'), row('c', 'idK', 'b2'));
    const spy = mount(host);
    press(host, 'ArrowDown'); // a
    press(host, 'ArrowDown'); // b/p
    assert.deepEqual(cursorKeys(host), ['b/p']);
    press(host, 'Enter');
    assert.deepEqual(spy.opened, ['idX'], 'Enter открывает мысль строки b/p');
    press(host, 'ArrowDown', true); // Ctrl+↓ — раскрыть потомков
    press(host, 'ArrowUp', true); // Ctrl+↑ — раскрыть родителей
    assert.deepEqual(spy.toggles, [
      { key: 'b/p', id: 'idX', root: 'b2', dir: 'children' },
      { key: 'b/p', id: 'idX', root: 'b2', dir: 'parents' },
    ]);
  });

  it('модификаторные Enter (Shift/Alt) открывают мысль, как прежде; Ctrl+Enter — нет', () => {
    const host = new ShimElement('div', 'st-results');
    host.append(row('a', 'idA'), row('b', 'idB'));
    const spy = mount(host);
    press(host, 'ArrowDown'); // a
    press(host, 'ArrowDown'); // b
    assert.deepEqual(cursorKeys(host), ['b']);

    // Прежний обработчик открывал мысль на ЛЮБОМ Enter без Ctrl/Meta.
    press(host, 'Enter', false, { shiftKey: true });
    press(host, 'Enter', false, { altKey: true });
    assert.deepEqual(spy.opened, ['idB', 'idB'], 'Shift/Alt+Enter открывают строку под курсором');

    // С Ctrl/Meta Enter прежний обработчик молчал — глобальные сочетания целы.
    press(host, 'Enter', true);
    assert.deepEqual(spy.opened, ['idB', 'idB'], 'Ctrl+Enter не открывает строку, как и раньше');
  });

  it('свёртывание блока: пропавшая строка курсора снимает пунктир', () => {
    const host = new ShimElement('div', 'st-results');
    host.append(row('k1', 'id1'), row('kM^p', 'idP'), row('kM', 'idM'));
    mount(host);
    press(host, 'ArrowDown'); // k1
    press(host, 'ArrowDown'); // kM^p
    assert.deepEqual(cursorKeys(host), ['kM^p']);
    // Родителей свернули — строка исчезла; sync не находит ключ и не рисует пунктир.
    host.replaceChildren(row('k1', 'id1'), row('kM', 'idM'));
    syncStructuresCursor();
    assert.deepEqual(cursorKeys(host), [], 'строка курсора исчезла — пунктира нет');
    press(host, 'ArrowDown'); // индекс не найден → курсор сбрасывается
    assert.deepEqual(cursorKeys(host), [], 'шаг с пропавшей строки сбрасывает курсор');
    press(host, 'ArrowDown'); // теперь с нуля — первая строка
    assert.deepEqual(cursorKeys(host), ['k1']);
  });
});
