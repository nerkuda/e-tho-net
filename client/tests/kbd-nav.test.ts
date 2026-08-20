/**
 * Unit tests for the spatial candidate picker of the canvas keyboard
 * navigation (client/src/renderer/canvas/kbd-nav.ts, 08-ui-spec.md §2.9).
 * Pure geometry — no DOM required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickSpatialCandidate, type CloudBox } from '../src/renderer/canvas/kbd-nav.js';

function box(id: string, x: number, y: number, w = 100, h = 60): CloudBox {
  return { id, x, y, w, h };
}

describe('pickSpatialCandidate', () => {
  it('picks the cloud straight below over a diagonally closer one', () => {
    const current = box('cur', 200, 200);
    const straight = box('below', 200, 300); // dx=0, dy=100
    const diagonal = box('diag', 230, 260); // dx=30, dy=60 — closer forward
    const next = pickSpatialCandidate([straight, diagonal], current, 0, 1);
    assert.equal(next?.id, 'below');
  });

  it('moves left and right between columns', () => {
    const left = box('left', 0, 100);
    const right = box('right', 220, 100);
    assert.equal(pickSpatialCandidate([right], left, 1, 0)?.id, 'right');
    assert.equal(pickSpatialCandidate([left], right, -1, 0)?.id, 'left');
  });

  it('prefers the smaller lateral offset among forward candidates', () => {
    const current = box('cur', 200, 200);
    const nearAxis = box('near', 210, 300); // lateral 10
    const farAxis = box('far', 320, 280); // lateral 120 — closer forward though
    const next = pickSpatialCandidate([nearAxis, farAxis], current, 0, 1);
    assert.equal(next?.id, 'near');
  });

  it('returns null when nothing lies in the direction', () => {
    const current = box('cur', 200, 200);
    const other = box('other', 200, 100); // above
    assert.equal(pickSpatialCandidate([other], current, 0, 1), null); // asked down
    assert.equal(pickSpatialCandidate([], current, 0, -1), null);
  });

  it('never returns the current cloud itself', () => {
    const current = box('cur', 200, 200);
    const sameSpot = box('cur', 200, 200);
    assert.equal(pickSpatialCandidate([sameSpot], current, 0, 1), null);
  });
});
