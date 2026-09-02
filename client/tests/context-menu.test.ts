/**
 * Unit tests for the thought context menu item list (H15, L23): the
 * «Найти на карте мыслей» command is opt-in via `findOnMapHandler` — only the
 * structures tree passes it (08-ui-spec.md §15.8).
 *
 * The «Изменить порядок» submenu (08-ui-spec.md §2.6, §2.7) is gated on the
 * zone's sort being `manual` and on each row's position in the zone. These
 * tests pin down that behaviour.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FocusNeighbor, FocusResponse, Thought } from '@etn/shared';

import { menuInternals } from '../src/renderer/canvas/context-menu.js';
import { canvasInternals } from '../src/renderer/canvas/canvas.js';
import { store } from '../src/renderer/state.js';

const { buildThoughtMenuItems } = menuInternals;

const target = { id: 't1', title: 'Мысль', dir: 'siblings' } as const;

function labels(items: ReturnType<typeof buildThoughtMenuItems>): string[] {
  return items.map((i) => i.label);
}

function findSubmenu(
  items: ReturnType<typeof buildThoughtMenuItems>,
  label: string,
): { label: string; disabled?: boolean }[] {
  const row = items.find((i) => i.label === label);
  assert.ok(row !== undefined, `expected a menu row «${label}»`);
  assert.ok(row.submenu !== undefined, `«${label}» must be a parent with a submenu`);
  return row.submenu.map((s) => ({ label: s.label, disabled: s.disabled === true }));
}

function thought(id: string, marked = false): Thought {
  return {
    id,
    title: id,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    is_protected: false,
    is_root: false,
    marked_for_deletion: marked,
    marked_for_deletion_at: marked ? '2026-01-01T00:00:00.000Z' : null,
    marked_for_deletion_by: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function neighbor(id: string, linkId: string): FocusNeighbor {
  return {
    id,
    title: id,
    type_id: null,
    icon: null,
    active: true,
    link_id: linkId,
    link_type_id: null,
    link_active: true,
    has_incoming: false,
    has_outgoing: false,
    manual_position: null,
  };
}

function focusFor(opts: {
  parents?: string[];
  children?: string[];
  sort: 'manual' | 'created' | 'alpha' | 'viewed';
  zone?: 'parents' | 'children';
  focusedMarked?: boolean;
}): FocusResponse {
  const zone = opts.zone ?? 'parents';
  const parents: FocusNeighbor[] = (opts.parents ?? []).map((id) => neighbor(id, `lp-${id}`));
  const children: FocusNeighbor[] = (opts.children ?? []).map((id) => neighbor(id, `lc-${id}`));
  return {
    focused: thought('f', opts.focusedMarked === true),
    parents,
    children,
    siblings: [],
    edges: [],
    sorts: {
      parents: { sort: zone === 'parents' ? opts.sort : 'created', order: 'asc' },
      children: { sort: zone === 'children' ? opts.sort : 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

describe('buildThoughtMenuItems — «Найти на карте мыслей» (L23)', () => {
  it('hides the command when no handler is passed (canvas/selection/pinned menus)', () => {
    assert.ok(!labels(buildThoughtMenuItems('net', target)).includes('Найти на карте мыслей'));
    assert.ok(
      !labels(buildThoughtMenuItems('net', target, { hideSelectionCommand: true })).includes(
        'Найти на карте мыслей',
      ),
    );
  });

  it('places the command right after «Импорт…» and calls the handler with the id', () => {
    let called: string | null = null;
    const items = buildThoughtMenuItems('net', target, {
      findOnMapHandler: (id) => (called = id),
    });
    const idx = labels(items).indexOf('Найти на карте мыслей');
    assert.ok(idx > 0, 'the command must be present');
    // Order on the canvas: Открыть редактор → Экспорт… → Импорт… → Найти на карте мыслей.
    // The export + import items (phase P, P7) sit between the editor opener
    // and the structures-only map-jump command.
    assert.equal(labels(items)[idx - 1], 'Импорт…');
    items[idx]!.onClick?.();
    assert.equal(called, 't1');
  });
});

describe('buildThoughtMenuItems — «Изменить порядок» submenu (08-ui-spec.md §2.6)', () => {
  it('is disabled in the siblings zone (manual order is not available there)', () => {
    const focus = focusFor({ parents: ['t1'], sort: 'manual' });
    store.update({
      focus,
      zoneSorts: focus.sorts,
      zoneOrder: { parents: ['t1'], children: [] },
      networkId: 'net',
    });
    const items = buildThoughtMenuItems('net', { id: 't1', title: 't1', dir: 'siblings' });
    const row = items.find((i) => i.label === 'Изменить порядок');
    assert.ok(row !== undefined);
    assert.equal(row.disabled, true, 'submenu parent must be disabled for siblings');
    store.update({ focus: null });
  });

  it('is disabled when the zone sort is not «manual»', () => {
    const focus = focusFor({ parents: ['t1', 't2'], sort: 'created' });
    store.update({
      focus,
      zoneSorts: focus.sorts,
      zoneOrder: { parents: ['t1', 't2'], children: [] },
      networkId: 'net',
    });
    const items = buildThoughtMenuItems('net', { id: 't1', title: 't1', dir: 'parents' });
    const row = items.find((i) => i.label === 'Изменить порядок');
    assert.ok(row !== undefined);
    assert.equal(row.disabled, true, 'submenu parent must be disabled when sort != manual');
    store.update({ focus: null });
  });

  it('exposes all four submenu rows when the zone is sorted «manual»', () => {
    const focus = focusFor({ parents: ['t1', 't2', 't3'], sort: 'manual' });
    store.update({
      focus,
      zoneSorts: focus.sorts,
      zoneOrder: { parents: ['t1', 't2', 't3'], children: [] },
      networkId: 'net',
    });
    const items = buildThoughtMenuItems('net', { id: 't2', title: 't2', dir: 'parents' });
    const row = items.find((i) => i.label === 'Изменить порядок');
    assert.ok(row !== undefined);
    assert.equal(row.disabled, false, 'submenu parent must be enabled');
    const sub = findSubmenu(items, 'Изменить порядок');
    assert.deepEqual(
      sub.map((s) => s.label),
      ['сделать первой', 'сдвинуть назад', 'сдвинуть вперёд', 'сделать последней'],
    );
    store.update({ focus: null });
  });

  it('gates «сделать первой» and «сдвинуть назад» on the first position', () => {
    const focus = focusFor({ parents: ['t1', 't2', 't3'], sort: 'manual' });
    store.update({
      focus,
      zoneSorts: focus.sorts,
      zoneOrder: { parents: ['t1', 't2', 't3'], children: [] },
      networkId: 'net',
    });
    // Middle thought: neither first nor last — both groups active.
    const middle = findSubmenu(
      buildThoughtMenuItems('net', { id: 't2', title: 't2', dir: 'parents' }),
      'Изменить порядок',
    );
    assert.equal(middle[0]?.disabled, false, 'сделать первой — enabled in the middle');
    assert.equal(middle[1]?.disabled, false, 'сдвинуть назад — enabled in the middle');
    assert.equal(middle[2]?.disabled, false, 'сдвинуть вперёд — enabled in the middle');
    assert.equal(middle[3]?.disabled, false, 'сделать последней — enabled in the middle');

    // First thought: top group disabled, bottom group active.
    const first = findSubmenu(
      buildThoughtMenuItems('net', { id: 't1', title: 't1', dir: 'parents' }),
      'Изменить порядок',
    );
    assert.equal(first[0]?.disabled, true, 'сделать первой — disabled on the first thought');
    assert.equal(first[1]?.disabled, true, 'сдвинуть назад — disabled on the first thought');
    assert.equal(first[2]?.disabled, false, 'сдвинуть вперёд — enabled on the first thought');
    assert.equal(first[3]?.disabled, false, 'сделать последней — enabled on the first thought');

    // Last thought: top group active, bottom group disabled.
    const last = findSubmenu(
      buildThoughtMenuItems('net', { id: 't3', title: 't3', dir: 'parents' }),
      'Изменить порядок',
    );
    assert.equal(last[0]?.disabled, false, 'сделать первой — enabled on the last thought');
    assert.equal(last[1]?.disabled, false, 'сдвинуть назад — enabled on the last thought');
    assert.equal(last[2]?.disabled, true, 'сдвинуть вперёд — disabled on the last thought');
    assert.equal(last[3]?.disabled, true, 'сделать последней — disabled on the last thought');
    store.update({ focus: null });
  });

  it('uses the children zone order when the thought lives there', () => {
    // Single-child zone: c1 is both first and last, so every row is disabled.
    const focus = focusFor({ children: ['c1'], sort: 'manual', zone: 'children' });
    store.update({
      focus,
      zoneSorts: focus.sorts,
      zoneOrder: { parents: [], children: ['c1'] },
      networkId: 'net',
    });
    const only = findSubmenu(
      buildThoughtMenuItems('net', { id: 'c1', title: 'c1', dir: 'children' }),
      'Изменить порядок',
    );
    assert.ok(only.every((row) => row.disabled === true), 'single-child zone: all rows disabled');

    // Two-child zone: c1 is only first, c2 is only last — every row matches
    // exactly one of the two gating conditions.
    const focus2 = focusFor({ children: ['c1', 'c2'], sort: 'manual', zone: 'children' });
    store.update({
      focus: focus2,
      zoneSorts: focus2.sorts,
      zoneOrder: { parents: [], children: ['c1', 'c2'] },
      networkId: 'net',
    });
    const first = findSubmenu(
      buildThoughtMenuItems('net', { id: 'c1', title: 'c1', dir: 'children' }),
      'Изменить порядок',
    );
    assert.equal(first[0]?.disabled, true, 'сделать первой — disabled on the first child');
    assert.equal(first[1]?.disabled, true, 'сдвинуть назад — disabled on the first child');
    assert.equal(first[2]?.disabled, false, 'сдвинуть вперёд — enabled on the first child');
    assert.equal(first[3]?.disabled, false, 'сделать последней — enabled on the first child');

    const last = findSubmenu(
      buildThoughtMenuItems('net', { id: 'c2', title: 'c2', dir: 'children' }),
      'Изменить порядок',
    );
    assert.equal(last[0]?.disabled, false, 'сделать первой — enabled on the last child');
    assert.equal(last[1]?.disabled, false, 'сдвинуть назад — enabled on the last child');
    assert.equal(last[2]?.disabled, true, 'сдвинуть вперёд — disabled on the last child');
    assert.equal(last[3]?.disabled, true, 'сделать последней — disabled on the last child');
    store.update({ focus: null });
  });
});

describe('buildThoughtMenuItems — «Удалить» / «Удалить/восстановить» (S13)', () => {
  it('labels the command «Удалить» for an unmarked thought', () => {
    store.update({ focus: null });
    const labelsOf = labels(buildThoughtMenuItems('net', target));
    assert.ok(labelsOf.includes('Удалить'), 'the plain «Удалить» row must be present');
    assert.ok(!labelsOf.includes('Удалить/восстановить'), 'no restore wording for an unmarked thought');
  });

  it('labels the command «Удалить/восстановить» for the marked focused thought', () => {
    const focus = focusFor({ parents: [], sort: 'created', focusedMarked: true });
    store.update({ focus, zoneSorts: focus.sorts, networkId: 'net' });
    const labelsOf = labels(
      buildThoughtMenuItems('net', { id: 'f', title: 'f', dir: 'siblings' }),
    );
    assert.ok(
      labelsOf.includes('Удалить/восстановить'),
      'the focused (marked) thought must offer «Удалить/восстановить»',
    );
    assert.ok(!labelsOf.includes('Удалить'), 'the plain «Удалить» row must be replaced');
    store.update({ focus: null });
  });

  it('labels the command «Удалить/восстановить» for a marked zone neighbour', () => {
    // Zone clouds read the trash flag from the canvas ThoughtRef cache — the
    // same source the 🗑 badge uses (08-ui-spec.md §2.2).
    const focus = focusFor({ parents: ['t1'], sort: 'created' });
    store.update({ focus, zoneSorts: focus.sorts, networkId: 'net' });
    canvasInternals.refCache.set('t1', {
      id: 't1',
      title: 't1',
      type_id: null,
      icon: null,
      icon_kind: 'emoji',
      icon_attachment_id: null,
      active: true,
      marked_for_deletion: true,
      fg_color: null,
      bg_color: null,
      font_bold: null,
      font_italic: null,
      font_underline: null,
      font_strike: null,
    });
    try {
      const labelsOf = labels(
        buildThoughtMenuItems('net', { id: 't1', title: 't1', dir: 'parents' }),
      );
      assert.ok(
        labelsOf.includes('Удалить/восстановить'),
        'a marked neighbour must offer «Удалить/восстановить»',
      );
    } finally {
      canvasInternals.refCache.delete('t1');
      store.update({ focus: null });
    }
  });
});

