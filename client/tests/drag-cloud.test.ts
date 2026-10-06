/**
 * Unit tests for the canvas drag module (client/src/renderer/canvas/drag-cloud.ts).
 * The pure link-search helpers (`flattenLinks`/`findDirectedLink`) are checked
 * directly; the pointer-gesture contract is driven on the shared DOM shim
 * (`dom-shim.ts`) — a mousedown on a drag source must suppress the native
 * default so Chromium never starts a page-text selection (ошибка 036bdbe6).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Link, ThoughtLinksGrouped, ThoughtRef } from '@etn/shared';

import {
  findDirectedLink,
  flattenLinks,
  wireCloudDrag,
  wireExternalDragSource,
} from '../src/renderer/canvas/drag-cloud.js';
import { ShimElement } from './dom-shim.js';

function link(id: string, sourceId: string, targetId: string, typeId: string | null = null): Link {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    type_id: typeId,
    color: null,
    style: null,
    width: null,
    active: true,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    version: 1,
    created_at: '',
    updated_at: '',
  };
}

function ref(id: string): ThoughtRef {
  return {
    id,
    title: id,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    marked_for_deletion: false,
    fg_color: null,
    bg_color: null,
    font_bold: false,
    font_italic: false,
    font_underline: false,
    font_strike: false,
  };
}

const grouped: ThoughtLinksGrouped = {
  by_type: [
    {
      type_id: 't1',
      type_name: 'related',
      items: [
        { link: link('l1', 'A', 'B', 't1'), target_thought: ref('B') },
        { link: link('l2', 'C', 'A', 't1'), target_thought: ref('A') },
      ],
    },
  ],
  untyped_parents: [{ link: link('l3', 'D', 'A') }],
  untyped_children: [{ link: link('l4', 'A', 'E') }],
};

describe('flattenLinks', () => {
  it('collects links from by_type, untyped_parents and untyped_children', () => {
    const ids = flattenLinks(grouped).map((l) => l.id);
    assert.deepEqual(ids.sort(), ['l1', 'l2', 'l3', 'l4']);
  });

  it('dedupes by id when the same link appears in several groups', () => {
    const dup: ThoughtLinksGrouped = {
      by_type: [],
      untyped_parents: [{ link: link('lx', 'A', 'B') }],
      untyped_children: [{ link: link('lx', 'A', 'B') }],
    };
    assert.equal(flattenLinks(dup).length, 1);
  });
});

describe('findDirectedLink', () => {
  it('finds an existing directed link A→B', () => {
    assert.equal(findDirectedLink(grouped, 'A', 'B')?.id, 'l1');
  });

  it('distinguishes direction: B→A is a different (absent) link than A→B', () => {
    assert.equal(findDirectedLink(grouped, 'B', 'A'), undefined);
  });

  it('finds links regardless of type_id (typed and untyped)', () => {
    assert.equal(findDirectedLink(grouped, 'D', 'A')?.id, 'l3');
    assert.equal(findDirectedLink(grouped, 'A', 'E')?.id, 'l4');
  });

  it('returns undefined for a non-existent pair', () => {
    assert.equal(findDirectedLink(grouped, 'X', 'Y'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Нативное выделение текста (ошибка 036bdbe6)
// ---------------------------------------------------------------------------

/** Ставит шим-`window` глобалью и отдаёт его (жест вешает слушатели окна). */
function withWindow(): ShimElement {
  const win = new ShimElement('window');
  (globalThis as { window?: unknown }).window = win;
  return win;
}

/**
 * Шлёт `mousedown` на элементе. ShimElement не считает `defaultPrevented` сам,
 * поэтому передаём собственный объект события с `preventDefault`, фиксирующий
 * вызов (конвенция `dom-shim.ts`).
 */
function fireMouseDown(
  el: ShimElement,
  init: { button?: number; target?: ShimElement } = {},
): { defaultPrevented: boolean } {
  const state = { defaultPrevented: false };
  el.emit('mousedown', {
    button: init.button ?? 0,
    clientX: 0,
    clientY: 0,
    target: init.target ?? el,
    preventDefault: () => {
      state.defaultPrevented = true;
    },
    stopPropagation: () => undefined,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
  });
  return state;
}

/** Завершает жест, чтобы модульный `gesture` не остался занятым. */
function endGesture(win: ShimElement): void {
  win.emit('mouseup', { clientX: 0, clientY: 0, shiftKey: false });
}

describe('жест перетаскивания гасит нативное выделение текста (ошибка 036bdbe6)', () => {
  it('mousedown на чипе значения гасит дефолт и возвращает фокус чипу', () => {
    const win = withWindow();
    const chip = new ShimElement('div', 'prop-ref-cloud');
    wireExternalDragSource(chip as unknown as HTMLElement, 'A', 'field-chip');

    const result = fireMouseDown(chip);

    assert.equal(
      result.defaultPrevented,
      true,
      'дефолт не погашен — Chromium начнёт выделение текста страницы',
    );
    assert.equal(chip.focused, true, 'preventDefault снимает фокус мышью — его нужно вернуть');
    endGesture(win);
  });

  it('mousedown на облачке карты (цель внутри .cloud) гасит дефолт', () => {
    const win = withWindow();
    const host = new ShimElement('div');
    const cloud = new ShimElement('div', 'cloud');
    cloud.dataset['id'] = 'A';
    const inner = new ShimElement('span');
    cloud.append(inner);
    host.append(cloud);
    wireCloudDrag(host as unknown as HTMLElement, { getZoneOrder: () => [] });

    const result = fireMouseDown(host, { target: inner });

    assert.equal(result.defaultPrevented, true);
    assert.equal(cloud.focused, true);
    endGesture(win);
  });

  it('нажатие, не начинающее жест, дефолт не гасит', () => {
    withWindow();
    const chip = new ShimElement('div', 'prop-ref-cloud');
    wireExternalDragSource(chip as unknown as HTMLElement, 'A', 'field-chip');
    assert.equal(fireMouseDown(chip, { button: 2 }).defaultPrevented, false);

    const host = new ShimElement('div');
    const free = new ShimElement('span');
    host.append(free);
    wireCloudDrag(host as unknown as HTMLElement, { getZoneOrder: () => [] });
    assert.equal(fireMouseDown(host, { target: free }).defaultPrevented, false);
  });
});
