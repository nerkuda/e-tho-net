/**
 * Client-side tests for the layer UI logic (task S11, 13-layers.md §10.3):
 *
 *   * `lineDiff` — the textual diff of the «Содержание» tab (LCS backtrace);
 *   * `buildLayerMenuItems` — the «Основа» menu composition: base + layers
 *     with the current one checked, service layers hidden, and the
 *     merge/delete/diff commands appearing only while a layer is active.
 *
 * Both are pure functions — no DOM, no Electron.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Layer } from '@etn/shared';

import { lineDiff } from '../src/renderer/lib/diff.js';
import { buildLayerMenuItems } from '../src/renderer/screens/layers.js';

function layer(overrides: Partial<Layer> & { id: string; title: string }): Layer {
  return {
    parent_id: null,
    comment: null,
    git_branch: null,
    is_service: false,
    is_base: false,
    depth: 1,
    created_by: 'u',
    created_at: '2026-08-30T00:00:00Z',
    last_activity_at: '2026-08-30T00:00:00Z',
    version: 1,
    children_count: 0,
    current: false,
    ...overrides,
  };
}

describe('lineDiff (S11)', () => {
  it('returns everything as same for identical documents', () => {
    const entries = lineDiff('a\nb\nc', 'a\nb\nc');
    assert.deepEqual(
      entries.map((e) => e.kind),
      ['same', 'same', 'same'],
    );
  });

  it('reports additions and deletions', () => {
    const entries = lineDiff('a\nb', 'a\nc\nb');
    assert.deepEqual(entries, [
      { kind: 'same', text: 'a' },
      { kind: 'add', text: 'c' },
      { kind: 'same', text: 'b' },
    ]);

    const removed = lineDiff('a\nb\nc', 'a\nc');
    assert.deepEqual(
      removed.filter((e) => e.kind === 'del').map((e) => e.text),
      ['b'],
    );
  });

  it('handles empty sides', () => {
    assert.deepEqual(lineDiff('', 'x'), [{ kind: 'add', text: 'x' }]);
    assert.deepEqual(lineDiff('x', ''), [{ kind: 'del', text: 'x' }]);
  });
});

describe('buildLayerMenuItems (S11)', () => {
  it('lists base + ordinary layers, hides service ones, marks the current', () => {
    const base = layer({ id: 'base', title: 'Основа', is_base: true, depth: 0, current: true });
    const work = layer({ id: 'l1', title: 'Правки', parent_id: 'base', current: false });
    const reserve = layer({ id: 'r1', title: 'Резерв', parent_id: 'l1', is_service: true });

    const items = buildLayerMenuItems('net', [base, work, reserve]);
    const labels = items.map((i) => i.label);
    assert.deepEqual(labels, [
      'Основа',
      'Правки',
      '—',
      'Создать новый слой…',
      'Свойства основы…',
    ]);
    const baseItem = items.find((i) => i.label === 'Основа');
    assert.equal(baseItem?.checked, true);
    assert.equal(items.find((i) => i.label === 'Правки')?.checked, false);
    // The reserve layer never appears in the menu (§2.2, §8.2).
    assert.ok(!labels.some((l) => l.includes('Резерв')));
  });

  it('adds diff/merge/delete only while a non-base layer is current', () => {
    const base = layer({ id: 'base', title: 'Основа', is_base: true, depth: 0, current: false });
    const work = layer({ id: 'l1', title: 'Правки', parent_id: 'base', current: true });

    const onLayer = buildLayerMenuItems('net', [base, work]).map((i) => i.label);
    assert.ok(onLayer.includes('Свойства слоя…'));
    assert.ok(onLayer.includes('Отличия от «Основа»…'));
    assert.ok(onLayer.includes('Слить «Правки» в «Основа»…'));
    assert.ok(onLayer.includes('Удалить «Правки»…'));

    const onBase = buildLayerMenuItems('net', [
      { ...base, current: true },
      work,
    ]).map((i) => i.label);
    assert.ok(onBase.includes('Свойства основы…'));
    assert.ok(!onBase.some((l) => l.includes('Слить')));
    assert.ok(!onBase.some((l) => l.includes('Удалить')));
    assert.ok(!onBase.some((l) => l.includes('Отличия')));
  });
});
