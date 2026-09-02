/**
 * Unit tests for the pure type-tree helpers (L21): tree building/flattening,
 * chain-based resolution of visual settings, subtree expansion and depth
 * bookkeeping. Pure functions — no DOM or IPC involved.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LinkType, ThoughtType } from '@etn/shared';

import {
  buildTypeTree,
  expandTypeIdsToSubtree,
  findRootType,
  flattenTypeTree,
  linkTypeOptions,
  orderedTypeRows,
  resolveLinkTypeVisual,
  resolveThoughtTypeVisual,
  subtreeTypeIds,
  thoughtTypeOptions,
  typeDepth,
  typeChainOf,
} from '../src/renderer/lib/type-tree.js';

/** Builds a minimal thought type for the tests. */
function tt(id: string, name: string, parentId: string | null, extra: Partial<ThoughtType> = {}): ThoughtType {
  return {
    id,
    name,
    parent_id: parentId,
    is_root: parentId === null,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    comment_template_md: null,
    version: 1,
    created_at: '',
    updated_at: '',
    created_by: '',
    ...extra,
  };
}

/** Builds a minimal link type for the tests. */
function lt(
  id: string,
  parentId: string | null,
  extra: Partial<LinkType> = {},
): LinkType {
  return {
    id,
    name_forward: `f${id}`,
    name_reverse: `r${id}`,
    parent_id: parentId,
    is_root: parentId === null,
    color: null,
    style: null,
    width: null,
    description: null,
    version: 1,
    created_at: '',
    updated_at: '',
    created_by: '',
    ...extra,
  };
}

describe('type-tree helpers (L21)', () => {
  it('builds and flattens a tree; the root is the top node', () => {
    const types = [
      tt('root', 'основной тип', null),
      tt('a', 'Персона', 'root'),
      tt('b', 'Коллега', 'a'),
      tt('c', 'Автор', 'a'),
    ];
    const roots = buildTypeTree(types);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]!.type.id, 'root');
    assert.equal(roots[0]!.children.length, 1);

    // Root expanded, others collapsed — only level 2 visible.
    const flat = flattenTypeTree(roots, new Set(['root']));
    assert.deepEqual(flat.map((r) => r.type.id), ['root', 'a']);

    // Everything expanded: depth-first order with depths (children sorted
    // alphabetically by ru-locale: «Автор» before «Коллега»).
    const all = flattenTypeTree(roots, new Set(['root', 'a']));
    assert.deepEqual(
      all.map((r) => `${r.type.id}@${r.depth}`),
      ['root@1', 'a@2', 'c@3', 'b@3'],
    );
    assert.equal(orderedTypeRows(types).map((r) => r.type.id).join(','), 'root,a,c,b');
  });

  it('resolves visual settings along the ancestor chain; untyped → root', () => {
    const types = [
      tt('root', 'основной тип', null, {
        fg_color: '#111111',
        bg_color: '#eeeeee',
        font_bold: true,
        icon: '🌳',
      }),
      tt('a', 'Персона', 'root', { fg_color: '#222222', icon: '🧑' }),
      tt('b', 'Коллега', 'a', { bg_color: '#dddddd' }),
    ];
    const root = resolveThoughtTypeVisual(types, null);
    assert.equal(root.fg_color, '#111111');
    assert.equal(root.bg_color, '#eeeeee');
    assert.equal(root.icon, '🌳');

    const colleague = resolveThoughtTypeVisual(types, 'b');
    // Own bg wins; fg comes from Персона; icon from Персона (nearest set).
    assert.equal(colleague.bg_color, '#dddddd');
    assert.equal(colleague.fg_color, '#222222');
    assert.equal(colleague.icon, '🧑');
    assert.equal(colleague.font_bold, true); // inherited from the root

    assert.equal(findRootType(types)?.id, 'root');
    assert.equal(typeDepth(types, 'b'), 3);
    assert.deepEqual(typeChainOf(types, 'b').map((t) => t.id), ['b', 'a', 'root']);
  });

  it('expands selected type ids to whole subtrees', () => {
    const types = [
      tt('root', 'основной тип', null),
      tt('a', 'A', 'root'),
      tt('b', 'B', 'a'),
      tt('c', 'C', 'b'),
    ];
    assert.deepEqual([...subtreeTypeIds(types, 'a')].sort(), ['a', 'b', 'c'].sort());
    assert.deepEqual(expandTypeIdsToSubtree(types, ['a', 'c']).sort(), ['a', 'b', 'c'].sort());
    // Unknown ids survive — they match nothing.
    assert.deepEqual(expandTypeIdsToSubtree(types, ['zzz']), ['zzz']);
    assert.deepEqual(expandTypeIdsToSubtree(types, []), []);
  });

  it('resolves link-type line style along the chain with app defaults', () => {
    const types = [
      lt('root', null),
      lt('a', 'root', { color: '#123456', style: 'dashed', width: 3 }),
      lt('b', 'a'),
    ];
    const root = resolveLinkTypeVisual(types, null);
    assert.deepEqual(root, { color: null, style: 'solid', width: 1 });
    const a = resolveLinkTypeVisual(types, 'a');
    assert.deepEqual(a, { color: '#123456', style: 'dashed', width: 3 });
    // The child inherits everything from `a`.
    const b = resolveLinkTypeVisual(types, 'b');
    assert.deepEqual(b, { color: '#123456', style: 'dashed', width: 3 });
  });
});

describe('pick-list options without the hierarchy root (L22 review)', () => {
  it('thoughtTypeOptions drops the root and shifts depths up', () => {
    const types = [
      tt('root', 'основной тип', null),
      tt('a', 'Проект', 'root'),
      tt('b', 'Задача', 'a'),
      tt('c', 'Архив', 'root'),
    ];
    const options = thoughtTypeOptions(types);
    // Root gone; former root children at depth 1 (alphabetical per level),
    // their kids indented once.
    assert.deepEqual(
      options.map((o) => [o.id, o.depth, o.parent_id]),
      [
        ['c', 1, 'root'],
        ['a', 1, 'root'],
        ['b', 2, 'a'],
      ],
    );
    // Every row is selectable and carries the type's icon/style.
    assert.ok(options.every((o) => o.selectable !== false));
    assert.ok(options.every((o) => o.icon !== null && o.style !== null));
  });

  it('linkTypeOptions drops the root, labels both names, rows carry line swatches', () => {
    const types = [
      lt('root', null),
      lt('a', 'root'),
      lt('b', 'a', { color: '#123456', style: 'dashed', width: 3 }),
    ];
    const options = linkTypeOptions(types);
    assert.deepEqual(options.map((o) => o.id), ['a', 'b']);
    assert.deepEqual(options.map((o) => o.depth), [1, 2]);
    assert.equal(options[0]!.label, 'fa / ra');
    // The child's swatch resolves through the chain (own overrides).
    assert.deepEqual(options[1]!.line, { color: '#123456', style: 'dashed', width: 3 });
  });
});
