/**
 * Unit tests for the «События» view's pure state helpers (задача f27809d0):
 * the L4-state parser, пересобранный на общую модель критериев
 * (задача 16899243 — плоский пресет ленты компилируется в дерево профиля
 * «события»). Pure Node, no DOM.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FilterAstLeaf, FilterAstNode } from '@etn/shared';

import { buildFilterAst } from '../src/renderer/lib/filter-builder.js';
import {
  DEFAULT_FILTER,
  ENTITY_TYPE_OPTIONS,
  createDefaultActivityFilter,
  parseActivityState,
  type ActivityFilterState,
} from '../src/renderer/screens/activity/state.js';

/** Все листья отбора в виде AST — так проверяется смысл пресета, а не форма дерева. */
function leavesOf(state: ActivityFilterState): FilterAstLeaf[] {
  const out: FilterAstLeaf[] = [];
  const walk = (node: FilterAstNode): void => {
    if ('op' in node) {
      for (const child of node.children) walk(child);
      return;
    }
    out.push(node);
  };
  walk(buildFilterAst(state, { profile: 'events' }).filter);
  return out;
}

function findLeaf(
  leaves: FilterAstLeaf[],
  kind: string,
  operator?: string,
): FilterAstLeaf | undefined {
  return leaves.find(
    (l) => l.entity.kind === kind && (operator === undefined || l.operator === operator),
  );
}

describe('parseActivityState', () => {
  it('returns defaults for empty input', () => {
    const parsed = parseActivityState('');
    assert.deepEqual(parsed.filter, { ...DEFAULT_FILTER });
    assert.equal(parsed.offset, 0);
  });

  it('returns defaults for malformed JSON', () => {
    const parsed = parseActivityState('not-json');
    assert.deepEqual(parsed.filter, { ...DEFAULT_FILTER });
    assert.equal(parsed.offset, 0);
  });

  it('тело отбора ленты не несёт сортировку — порядок строк задаёт сервер', () => {
    // Лента строится с `sort: false` (задача 16899243): порядок — `occurred_at_ms
    // DESC` на сервере, дефолтная пара `sort`/`order` в тело отбора не попадает.
    const ast = buildFilterAst(createDefaultActivityFilter(), { profile: 'events', sort: false });
    assert.equal(ast.sort, undefined, 'сортировки в AST ленты нет');
  });

  it('compiles a populated legacy flat preset into the events tree', () => {
    const json = JSON.stringify({
      filter: {
        fromMs: '2024-06-01',
        toMs: '2024-06-30',
        userId: 'user-123',
        entityTypes: ['thought', 'link'],
        actions: ['created', 'updated'],
      },
      offset: 50,
    });
    const parsed = parseActivityState(json);
    // Старый формат L4 (`fromMs`/`toMs`/`userId`) читается в общую модель.
    assert.equal(parsed.filter.createdAfter, '2024-06-01');
    assert.equal(parsed.filter.createdBefore, '2024-06-30');
    assert.equal(parsed.filter.authorId, 'user-123');
    assert.equal(parsed.offset, 50);
    // Плоские критерии пресета переведены в строки дерева (действие и вид
    // сущности — листья `in`, период — границы `occurred_at`, автор — `user eq`).
    const leaves = leavesOf(parsed.filter);
    assert.deepEqual(findLeaf(leaves, 'occurred_at', 'gte')?.value, '2024-06-01');
    assert.deepEqual(findLeaf(leaves, 'occurred_at', 'lte')?.value, '2024-06-30');
    assert.equal(findLeaf(leaves, 'user')?.operator, 'eq');
    assert.deepEqual(findLeaf(leaves, 'user')?.value, 'user-123');
    assert.deepEqual(findLeaf(leaves, 'action')?.value, ['created', 'updated']);
    assert.deepEqual(findLeaf(leaves, 'entity_type')?.value, ['thought', 'link']);
  });

  it('drops unknown entity types and unknown actions', () => {
    const json = JSON.stringify({
      filter: {
        entityTypes: ['thought', 'mystery-type'],
        actions: ['created', 'something-else'],
      },
    });
    const parsed = parseActivityState(json);
    const leaves = leavesOf(parsed.filter);
    assert.deepEqual(findLeaf(leaves, 'entity_type')?.value, ['thought']);
    assert.deepEqual(findLeaf(leaves, 'action')?.value, ['created']);
  });

  it('clamps negative offset to zero', () => {
    const json = JSON.stringify({ filter: {}, offset: -5 });
    const parsed = parseActivityState(json);
    assert.equal(parsed.offset, 0);
  });

  it('rounds a fractional offset to the nearest integer floor', () => {
    const json = JSON.stringify({ filter: {}, offset: 12.9 });
    const parsed = parseActivityState(json);
    assert.equal(parsed.offset, 12);
  });

  it('exposes the same entity-type options the UI ships', () => {
    // Sanity check: the wire vocabulary must stay in lock-step with the
    // server (`ActivityEntityType`). Any drift here would silently filter
    // out every event for the changed kind.
    const types = ENTITY_TYPE_OPTIONS.map((o) => o.value).sort();
    assert.deepEqual(
      types,
      [
        'attachment',
        'comment',
        'layer',
        'link',
        'link_type',
        'property',
        'thought',
        'thought_type',
      ],
    );
  });

  it('parses a partial filter with safe defaults', () => {
    const json = JSON.stringify({ filter: { userId: 'u-1' } });
    const parsed = parseActivityState(json);
    const expected: ActivityFilterState = {
      ...DEFAULT_FILTER,
      authorId: 'u-1',
      tree: parsed.filter.tree,
    };
    assert.deepEqual(parsed.filter, expected);
    assert.deepEqual(findLeaf(leavesOf(parsed.filter), 'user')?.value, 'u-1');
    assert.equal(parsed.panelWidth, null);
  });

  it('restores panelWidth from L4 (замечание пользователя — сплиттер панели)', () => {
    const parsed = parseActivityState(JSON.stringify({ filter: {}, panelWidth: 360 }));
    assert.equal(parsed.panelWidth, 360);
    const negative = parseActivityState(JSON.stringify({ filter: {}, panelWidth: -10 }));
    assert.equal(negative.panelWidth, null);
    const fractional = parseActivityState(JSON.stringify({ filter: {}, panelWidth: 322.9 }));
    assert.equal(fractional.panelWidth, 322);
  });
});
