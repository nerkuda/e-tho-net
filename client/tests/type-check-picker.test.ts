/**
 * Pure-logic tests for the inline tree-checkbox type picker
 * (client/src/renderer/lib/type-check-picker.ts, 0.6.5 приёмка — ошибка
 * «Выбор типов в свойстве-ссылке: без иконок, стилей и иерархии»).
 *
 * `filterCheckRows` is the only exported pure piece: it keeps the query-
 * matched rows plus their whole ancestor chain (a match never falls out of
 * its branch), preserving the source tree order. No DOM — the widget itself
 * is exercised through the live dialog.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { filterCheckRows } from '../src/renderer/lib/type-check-picker.js';
import type { TypeOption } from '../src/renderer/lib/type-combobox.js';

/** Builds a tree-shaped option list (mirrors `thoughtTypeOptions` output). */
function opt(
  id: string,
  label: string,
  depth: number,
  parentId: string | null = null,
  hasChildren = false,
): TypeOption {
  return { id, label, parent_id: parentId, depth, has_children: hasChildren };
}

/** A small catalogue: root children «работа» (with kids) and «документ». */
function catalogue(): TypeOption[] {
  return [
    opt('t-work', 'работа', 1, null, true),
    opt('t-task', 'задача', 2, 't-work'),
    opt('t-bug', 'ошибка', 2, 't-work'),
    opt('t-doc', 'документ', 1),
  ];
}

describe('filterCheckRows', () => {
  it('a blank query keeps the whole tree in order', () => {
    const rows = catalogue();
    const out = filterCheckRows(rows, '   ');
    assert.deepEqual(
      out.map((r) => r.id),
      ['t-work', 't-task', 't-bug', 't-doc'],
    );
  });

  it('a matching leaf keeps its ancestor chain so the branch stays readable', () => {
    const out = filterCheckRows(catalogue(), 'задач');
    assert.deepEqual(
      out.map((r) => r.id),
      ['t-work', 't-task'],
    );
  });

  it('matches are case-insensitive and substring-based', () => {
    const out = filterCheckRows(catalogue(), 'РАБ');
    assert.deepEqual(
      out.map((r) => r.id),
      ['t-work'],
    );
  });

  it('two matches in different branches keep both chains in tree order', () => {
    const rows = [
      ...catalogue(),
      opt('t-doc-spec', 'спецификация', 2, 't-doc'),
    ];
    // «а» hits «работа», «задача», «ошибка» and «спецификация»; the last one
    // pulls in its ancestor «документ» even though the name itself has no «а».
    const out = filterCheckRows(rows, 'а');
    assert.deepEqual(
      out.map((r) => r.id),
      ['t-work', 't-task', 't-bug', 't-doc', 't-doc-spec'],
    );
  });

  it('no matches yields an empty list (the widget shows «Ничего не найдено»)', () => {
    const out = filterCheckRows(catalogue(), 'нет такого');
    assert.deepEqual(out, []);
  });

  it('returns a copy — the source array is never mutated or aliased', () => {
    const rows = catalogue();
    const out = filterCheckRows(rows, '');
    assert.notEqual(out, rows);
    assert.equal(rows.length, 4);
  });
});
