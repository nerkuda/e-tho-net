/**
 * Tests for the structures filter panel after ошибка 6158d2ea
 * («Непонятные термины в панели отбора структур»).
 *
 * Proof of the requested behaviour:
 *   * group titles and the panel order are exactly
 *     Ключевые слова, Типы мыслей, Типы связей, Родительские мысли,
 *     Выбирать потомков по связям;
 *   * the group is titled «Выбирать потомков по связям» and its flag reads
 *     «учитывать связи без типа» — the old terms are gone;
 *   * the group is disabled (dimmed, not editable) and dropped from the wire
 *     filter while «Родительские мысли» is empty — an empty group must not
 *     make the filter non-empty (the view would stop showing HOME+orphans);
 *   * with parents filled the group is editable and its `link_filter` is sent.
 *
 * The panel is mounted for real under a minimal DOM shim (the same technique
 * as `structures-dates-filter.test.ts` and `renderer-editor-mount.test.ts`);
 * the wire assertions go through the exported `buildTraversalFilter()` /
 * `buildExtraFilter()` — the very seam `structures.ts::buildFilter` uses.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Concatenated text of a subtree (the shim keeps text per node). */
function textOf(node: ShimElement): string {
  let out = node.textContent;
  for (const child of node.children) out += ` ${textOf(child)}`;
  return out.trim();
}

/** Installs the minimal DOM/window shims the panel and its imports need. */
function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    etn: {
      admin: { listUsers: async () => [] },
      propertyRegistry: { list: async () => [] },
      savedFilters: { list: async () => [] },
      structures: { query: async () => ({ items: [], total: 0 }) },
      thoughts: {
        resolve: async () => [],
        findDuplicates: async () => [],
      },
    },
  };
}

let panel: typeof import('../src/renderer/screens/structures/filter-panel.js');
let host: ShimElement;

/** Top-level groups of the mounted panel, in DOM order. */
function groupBoxes(): ShimElement[] {
  const scroll = host.querySelector('.st-f-scroll');
  assert.notEqual(scroll, null, 'панель обязана быть смонтирована');
  return scroll!.children.filter((c) => c.className.split(/\s+/).includes('st-f-block'));
}

/** The «Выбирать потомков по связям» group of the mounted panel. */
function traversalBox(): ShimElement {
  const box = groupBoxes().find((b) => textOf(b.children[0]!).includes('Выбирать потомков по связям'));
  assert.notEqual(box, undefined, 'группа «Выбирать потомков по связям» обязана быть в панели');
  return box!;
}

before(async () => {
  installShim();
  const { store } = await import('../src/renderer/state.js');
  store.state.networkId = '00000000-0000-4000-8000-0000000000aa';
  panel = await import('../src/renderer/screens/structures/filter-panel.js');
  host = new ShimElement('div');
  panel.mountFilterPanel(host as unknown as HTMLElement, {
    onApply: () => undefined,
    onStatePersist: () => undefined,
    onCommands: () => undefined,
  });
});

describe('structures filter panel — термины и доступность обхода (ошибка 6158d2ea)', () => {
  it('порядок групп: Ключевые слова, Типы мыслей, Типы связей, Родительские мысли, Выбирать потомков по связям', () => {
    const titles = groupBoxes().map((box) => textOf(box.children[0]!).replace(/\s*\*\s*$/, ''));
    assert.deepEqual(titles.slice(0, 5), [
      'Ключевые слова',
      'Типы мыслей',
      'Типы связей',
      'Родительские мысли',
      'Выбирать потомков по связям',
    ]);
  });

  it('новые подписи группы и флага; старые термины убраны', () => {
    const text = textOf(traversalBox());
    assert.ok(text.includes('Выбирать потомков по связям'), 'новая подпись группы');
    assert.ok(text.includes('учитывать связи без типа'), 'новая подпись флага');
    const all = textOf(host);
    assert.ok(!all.includes('Обход по связям'), 'старый термин «Обход по связям» не должен остаться');
    assert.ok(!all.includes('структурные связи'), 'старый термин «структурные связи» не должен остаться');
  });

  it('пустые «Родительские мысли» → группа погашена и в запрос не попадает', () => {
    panel.setFilterState({
      ...panel.getFilterState(),
      parentIds: [],
      linkFilterTypeIds: ['00000000-0000-4000-8000-0000000000ff'],
      linkFilterStructural: true,
    });
    const box = traversalBox();
    // Погашена: заголовок не маркируется, тело недоступно к вводу.
    assert.equal(box.classList.contains('st-f-block-disabled'), true);
    assert.equal(box.children[0]!.classList.contains('st-f-title-active'), false);
    const checkbox = box.querySelectorAll('input').find((i) => i.type === 'checkbox');
    assert.equal(checkbox?.disabled, true, 'флаг обхода недоступен');
    assert.equal(box.querySelector('.entity-chip-input')?.disabled, true, 'поле типов связей недоступно');
    // В запрос не попадает: пустая группа не делает отбор непустым.
    assert.equal(panel.buildTraversalFilter(), undefined);
  });

  it('заполненные «Родительские мысли» → группа доступна и попадает в запрос', () => {
    const parentId = '11111111-1111-4111-8111-111111111111';
    panel.setFilterState({
      ...panel.getFilterState(),
      parentIds: [parentId],
      linkFilterTypeIds: ['00000000-0000-4000-8000-0000000000ff'],
      linkFilterStructural: true,
    });
    const box = traversalBox();
    assert.equal(box.classList.contains('st-f-block-disabled'), false);
    assert.equal(box.children[0]!.classList.contains('st-f-title-active'), true, 'заполненная группа маркируется');
    const checkbox = box.querySelectorAll('input').find((i) => i.type === 'checkbox');
    assert.equal(checkbox?.disabled, false);
    assert.equal(box.querySelector('.entity-chip-input')?.disabled, false);
    assert.deepEqual(panel.buildTraversalFilter(), {
      type_ids: ['00000000-0000-4000-8000-0000000000ff'],
      include_structural: true,
    });
    assert.deepEqual(panel.buildExtraFilter().parent_ids, [parentId]);
  });

  it('обход без ограничений по-прежнему не добавляет link_filter (регрессия)', () => {
    panel.setFilterState({
      ...panel.getFilterState(),
      parentIds: ['11111111-1111-4111-8111-111111111111'],
      linkFilterTypeIds: [],
      linkFilterStructural: false,
    });
    assert.equal(panel.buildTraversalFilter(), undefined);
  });

  it('снятие «Родительских мыслей» снова гасит группу (динамический пересчёт)', () => {
    panel.setFilterState({
      ...panel.getFilterState(),
      parentIds: ['11111111-1111-4111-8111-111111111111'],
      linkFilterTypeIds: ['00000000-0000-4000-8000-0000000000ff'],
      linkFilterStructural: true,
    });
    assert.equal(traversalBox().classList.contains('st-f-block-disabled'), false);
    panel.setFilterState({ ...panel.getFilterState(), parentIds: [] });
    assert.equal(traversalBox().classList.contains('st-f-block-disabled'), true);
    assert.equal(panel.buildTraversalFilter(), undefined);
  });
});
