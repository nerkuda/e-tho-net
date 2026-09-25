/**
 * Unit tests for the zone-grid anchor (task f45ffc8a): the pure offset formula
 * (`lib/pure.ts`) and the invariants the map layout relies on.
 *
 * The anchor is a pure TRANSLATION of a zone's grid inside its content box:
 * `renderZoneContent` adds it to the virtualization `translateY`. Therefore
 * the cloud ORDER (row-major, `c + r × cols`) and every index derived from a
 * DOM hit-test — including the drag-n-drop insertion index in
 * `canvas/drag-cloud.ts`, which resolves the target by
 * `elementFromPoint(...).closest('.cloud')` rather than by geometry — are
 * anchor-independent. The reversibility test below pins exactly that: shifting
 * a point by the anchor offset and mapping it back to a row-major slot always
 * returns the same index, for every anchor.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  anchorFractions,
  anchorOffset,
  ZONE_ANCHOR_BY_DIR,
  zoneContentWidth,
  type ZoneAnchor,
} from '../src/renderer/lib/pure.js';

const ANCHORS: readonly ZoneAnchor[] = ['right-bottom', 'left-bottom', 'center-top'];

describe('ZONE_ANCHOR_BY_DIR (task f45ffc8a)', () => {
  it('anchors parents right-bottom, siblings left-bottom, children center-top', () => {
    assert.equal(ZONE_ANCHOR_BY_DIR.parents, 'right-bottom');
    assert.equal(ZONE_ANCHOR_BY_DIR.siblings, 'left-bottom');
    assert.equal(ZONE_ANCHOR_BY_DIR.children, 'center-top');
  });
});

describe('anchorFractions', () => {
  it('maps each anchor to its free-space fractions', () => {
    assert.deepEqual(anchorFractions('right-bottom'), { x: 1, y: 1 });
    assert.deepEqual(anchorFractions('left-bottom'), { x: 0, y: 1 });
    assert.deepEqual(anchorFractions('center-top'), { x: 0.5, y: 0 });
  });
});

describe('anchorOffset', () => {
  const container = { width: 1000, height: 600 };
  const content = { width: 400, height: 200 };

  it('right-bottom: content hugs the right and bottom edges', () => {
    assert.deepEqual(anchorOffset(container, content, 'right-bottom'), { x: 600, y: 400 });
  });

  it('left-bottom: content keeps the left edge and hugs the bottom', () => {
    assert.deepEqual(anchorOffset(container, content, 'left-bottom'), { x: 0, y: 400 });
  });

  it('center-top: content is centred horizontally, flush to the top', () => {
    assert.deepEqual(anchorOffset(container, content, 'center-top'), { x: 300, y: 0 });
  });

  it('is zero on both axes when the content exactly fills the container', () => {
    const full = anchorOffset(container, { ...container }, 'right-bottom');
    assert.deepEqual(full, { x: 0, y: 0 });
  });

  it('clamps to the start (never negative) when the content overflows', () => {
    const bigger = { width: 1400, height: 900 };
    for (const anchor of ANCHORS) {
      const off = anchorOffset(container, bigger, anchor);
      assert.equal(off.x, 0, `${anchor} x`);
      assert.equal(off.y, 0, `${anchor} y`);
    }
  });

  it('the offset plus the content size lands exactly on the anchored edge', () => {
    // Bottom anchors: last content row hugs the container's bottom edge.
    for (const anchor of ['right-bottom', 'left-bottom'] as const) {
      const off = anchorOffset(container, content, anchor);
      assert.equal(off.y + content.height, container.height, `${anchor} bottom`);
    }
    // Right anchor: the content's right edge hugs the container's right edge.
    const right = anchorOffset(container, content, 'right-bottom');
    assert.equal(right.x + content.width, container.width);
    // Center: the free space is split evenly.
    const center = anchorOffset(container, content, 'center-top');
    assert.equal(center.x, (container.width - content.width) / 2);
  });
});

describe('zoneContentWidth — the widest ROW, not the grid box (приёмочный дефект f45ffc8a)', () => {
  const width = 210;
  const gap = 10;

  it('a full grid (count ≥ cols) spans every column', () => {
    assert.equal(zoneContentWidth(4, 4, width, gap), 4 * width + 3 * gap);
    assert.equal(zoneContentWidth(4, 9, width, gap), 4 * width + 3 * gap);
  });

  it('a partial single row (count < cols) spans only its own clouds', () => {
    assert.equal(zoneContentWidth(8, 2, width, gap), 2 * width + gap);
    assert.equal(zoneContentWidth(8, 1, width, gap), width);
  });

  it('is zero for an empty zone', () => {
    assert.equal(zoneContentWidth(8, 0, width, gap), 0);
  });
});

describe('horizontal anchor regression (приёмочный дефект f45ffc8a)', () => {
  const width = 210;
  const gap = 10;

  it('children / center: a partial row is wider than empty — offsetX is positive', () => {
    const container = { width: 1200, height: 300 };
    const cols = 8;
    const count = 2;
    const content = {
      width: zoneContentWidth(cols, count, width, gap), // 430
      height: 70,
    };
    // The old bug anchored by the full grid box (8 columns ≈ 1750), so the
    // difference was ≤ 0 and the offset collapsed to 0 — the row stayed left.
    const origin = anchorOffset(container, content, ZONE_ANCHOR_BY_DIR.children);
    assert.equal(origin.x, (1200 - 430) / 2);
    assert.ok(origin.x > 0);
    assert.equal(origin.y, 0); // top anchor unchanged
  });

  it('children / center: content exactly filling the container → offsetX = 0', () => {
    const container = { width: 4 * width + 3 * gap, height: 200 };
    const origin = anchorOffset(container, { ...container }, ZONE_ANCHOR_BY_DIR.children);
    assert.equal(origin.x, 0);
  });

  it('parents / right-bottom: full shift to the right edge (symmetric to left)', () => {
    const container = { width: 1000, height: 400 };
    const content = { width: 400, height: 100 };
    const right = anchorOffset(container, content, ZONE_ANCHOR_BY_DIR.parents);
    assert.equal(right.x, 600); // full free space
    assert.equal(right.y, 300);
  });

  it('siblings / left-bottom: no horizontal shift (rows keep the left edge)', () => {
    const container = { width: 1000, height: 400 };
    const content = { width: 400, height: 100 };
    const left = anchorOffset(container, content, ZONE_ANCHOR_BY_DIR.siblings);
    assert.equal(left.x, 0);
    assert.equal(left.y, 300);
  });
});

// ---------------------------------------------------------------------------
// Invariants relied on by the map
// ---------------------------------------------------------------------------

/** Row-major slot index: `c + r × cols` (08-ui-spec.md §2.1.1). */
function slotIndex(col: number, row: number, cols: number): number {
  return col + row * cols;
}

/**
 * Inverts a container-space point back to the row-major slot a geometry-based
 * hit-test would report: subtract the anchor offset, then divide by the cell
 * size. Mirrors the "cursor position → insertion index" mapping.
 */
function slotAtPoint(
  point: { x: number; y: number },
  origin: { x: number; y: number },
  cell: { width: number; height: number },
  cols: number,
): number {
  const col = Math.floor((point.x - origin.x) / cell.width);
  const row = Math.floor((point.y - origin.y) / cell.height);
  return slotIndex(col, row, cols);
}

describe('anchor is a pure translation (invariants for DnD / order / paging)', () => {
  const cols = 4;
  const rows = 5;
  const cell = { width: 210, height: 70 };
  // Container big enough for every anchor to actually shift something.
  const container = { width: cols * cell.width + 260, height: rows * cell.height + 180 };
  const content = { width: cols * cell.width, height: rows * cell.height };

  it('maps a slot centre to itself after applying and inverting every anchor', () => {
    for (const anchor of ANCHORS) {
      const origin = anchorOffset(container, content, anchor);
      for (let index = 0; index < cols * rows; index++) {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const centre = {
          x: origin.x + col * cell.width + cell.width / 2,
          y: origin.y + row * cell.height + cell.height / 2,
        };
        assert.equal(
          slotAtPoint(centre, origin, cell, cols),
          slotIndex(col, row, cols),
          `${anchor} index ${index}`,
        );
      }
    }
  });

  it('does not depend on the anchor (the row-major order is untouched)', () => {
    // The same pointer expressed in CONTENT coordinates resolves to the same
    // index no matter where the grid sits on screen.
    const contentPoint = { x: 3 * cell.width + 10, y: 2 * cell.height + 10 };
    const expected = slotIndex(3, 2, cols);
    const seen = new Set<number>();
    for (const anchor of ANCHORS) {
      const origin = anchorOffset(container, content, anchor);
      seen.add(
        slotAtPoint({ x: contentPoint.x + origin.x, y: contentPoint.y + origin.y }, origin, cell, cols),
      );
    }
    assert.deepEqual([...seen], [expected]);
  });

  it('virtualization rows stay contiguous — the anchor only moves the grid origin', () => {
    // The rendered window is a row range; its own geometry (prefix sums) does
    // not mention the anchor at all, so the visible row count is unchanged.
    for (const anchor of ANCHORS) {
      const origin = anchorOffset(container, content, anchor);
      const firstRowTop = origin.y;
      const lastRowTop = origin.y + (rows - 1) * cell.height;
      assert.equal(lastRowTop - firstRowTop, (rows - 1) * cell.height, anchor);
      assert.ok(origin.y >= 0, anchor);
    }
  });
});
