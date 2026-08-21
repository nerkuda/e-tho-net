/**
 * Unit tests for the thought context menu item list (H15, L23): the
 * «Найти на карте мыслей» command is opt-in via `findOnMapHandler` — only the
 * structures tree passes it (08-ui-spec.md §15.8).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { menuInternals } from '../src/renderer/canvas/context-menu.js';

const { buildThoughtMenuItems } = menuInternals;

const target = { id: 't1', title: 'Мысль', dir: 'siblings' } as const;

function labels(items: ReturnType<typeof buildThoughtMenuItems>): string[] {
  return items.map((i) => i.label);
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

  it('places the command right after «Открыть редактор» and calls the handler with the id', () => {
    let called: string | null = null;
    const items = buildThoughtMenuItems('net', target, {
      findOnMapHandler: (id) => (called = id),
    });
    const idx = labels(items).indexOf('Найти на карте мыслей');
    assert.ok(idx > 0, 'the command must be present');
    assert.equal(labels(items)[idx - 1], 'Открыть редактор');
    items[idx]!.onClick?.();
    assert.equal(called, 't1');
  });
});
