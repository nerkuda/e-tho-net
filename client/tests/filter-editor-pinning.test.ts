/**
 * Динамическое приклеивание футера редактора отбора (задача c20b26ef,
 * элемент интерфейса ca905fbc).
 *
 * Постановка владельца: при высоте окна Electron ≤ 1100 px в неподвижном низу
 * редактора остаются только «Применить» и «Очистить», остальное содержимое
 * футера (фраза-превью, имя с 💾/✕/«…», кнопки места, секция сортировки)
 * прокручивается вместе с деревом условий; при высоте > 1100 px неподвижна вся
 * двухрядная панель, как раньше (решение заказчика 2026-10-14).
 *
 * Проверяются две вещи, на которых держится поведение:
 *   1) РАЗМЕТКА: ряд действий `.ff-actions` вынесен из футера в полосу
 *      `.fe-actions` — единственный элемент вне прокручиваемого низа;
 *   2) CSS: медиазапрос порога переключает прокрутку (`.fe` скроллится, `.ft`
 *      нет) и приклеивает полосу действий. Литерал порога сверяется с
 *      константой `FILTER_EDITOR_COMPACT_MAX_HEIGHT`, чтобы они не разъехались.
 *
 * jsdom не нужен — общий DOM-шим (`./dom-shim.js`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { FilterProfileId, LinkType, NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['setTimeout'] = (fn: () => void) => {
    fn();
    return 1;
  };
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

installShim();

const RENDERER = join(import.meta.dirname, '..', 'src', 'renderer');
const CSS_PATH = join(RENDERER, 'styles', 'filter-editor.css');

const mod = await import('../src/renderer/lib/filter-editor.js');
const builder = await import('../src/renderer/lib/filter-builder.js');

const DATA = {
  registry: new Map<string, NetworkProperty>(),
  linkTypes: [] as LinkType[],
  thoughtTypes: [],
};

/** Редактор «Структур мыслей» по умолчанию: дерево, сортировка и футер включены. */
function buildEditor(profile: FilterProfileId = 'thoughts'): any {
  const state = builder.defaultFilterCriteriaState();
  state.tree = builder.defaultFilterTreeGroup('and');
  const handle = mod.buildFilterEditor({
    profile,
    networkId: 'net-1',
    data: DATA,
    getState: () => state,
    host: {
      apply: () => undefined,
      save: () => undefined,
      reset: () => undefined,
      getName: () => '',
      setName: () => undefined,
    },
  });
  return { handle, root: handle.root as unknown as ShimElement };
}

/** Первый потомок с точным классом. */
function one(root: ShimElement, cls: string): ShimElement | null {
  return root.findAll((n) => n.classList.contains(cls))[0] ?? null;
}

describe('футер редактора отбора: динамическое приклеивание (c20b26ef)', () => {
  it('ряд действий вынесен в полосу .fe-actions, остальной футер — в .fe-foot', () => {
    const { root } = buildEditor();
    const layout = root.children.map((child: ShimElement) => child.className);
    assert.equal(
      layout.length,
      3,
      `корень редактора: дерево, низ, полоса действий (${layout.join(' | ')})`,
    );
    assert.match(layout[0]!, /\bft\b/, 'первым — дерево условий');
    assert.match(layout[1]!, /\bfe-foot\b/, 'затем — низ редактора');
    assert.match(layout[2]!, /\bfe-actions\b/, 'последней — полоса действий');

    const actionsBar = root.children[2]!;
    const foot = root.children[1]!;
    assert.ok(one(actionsBar, 'ff-actions') !== null, 'ряд действий — в полосе .fe-actions');
    assert.equal(one(foot, 'ff-actions'), null, 'ряд действий НЕ в прокручиваемом низу');
    assert.ok(one(actionsBar, 'ff-apply') !== null, '«Применить» приклеена');
    assert.ok(one(actionsBar, 'ff-clear') !== null, '«Очистить» приклеена');
    assert.equal(one(actionsBar, 'ff-name'), null, 'ряд имени не приклеен');

    // При низкой высоте окна это содержимое уезжает в прокрутку вместе с деревом.
    assert.ok(one(foot, 'ff-name') !== null, 'поле имени — в низу редактора');
    assert.ok(one(foot, 'ff-preview') !== null, 'фраза-превью — в низу редактора');
    assert.ok(one(foot, 'fs-sort') !== null, 'секция сортировки — в низу редактора');
  });

  it('порог — структурная константа, медиазапрос переключает прокрутку и приклеивает действия', () => {
    // Порог 1100 px — значение постановки владельца; смена — осознанное решение.
    assert.equal(mod.FILTER_EDITOR_COMPACT_MAX_HEIGHT, 1100);

    const css = readFileSync(CSS_PATH, 'utf8');
    const mediaStart = css.indexOf(
      `@media (max-height: ${mod.FILTER_EDITOR_COMPACT_MAX_HEIGHT}px)`,
    );
    assert.ok(
      mediaStart >= 0,
      'медиазапрос порога обязан стоять в модуле стилей (ресайз без перезапуска клиента)',
    );
    const block = css.slice(mediaStart);

    // Прокрутка переезжает с дерева на весь низ редактора.
    assert.match(block, /\.fe\s*\{[^}]*overflow-y:\s*auto/, '.fe прокручивается целиком');
    assert.match(
      block,
      /\.fe > \.ft\s*\{[^}]*overflow-y:\s*visible/,
      '.ft больше не отдельный скролл',
    );

    // Приклеена только полоса действий: непрозрачный фон и шов над ней.
    assert.match(block, /\.fe-actions\s*\{[^}]*position:\s*sticky/, 'полоса действий приклеена');
    assert.match(
      block,
      /\.fe-actions\s*\{[^}]*background:\s*var\(--surface\)/,
      'фон полосы непрозрачен',
    );
    assert.match(
      block,
      /\.fe-actions\s*\{[^}]*border-top:\s*1px solid var\(--border\)/,
      'шов над полосой',
    );
  });
});
