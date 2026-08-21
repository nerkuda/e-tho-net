/**
 * Unit tests of the pure offset-mapping helper behind the mentions
 * auto-annotation (L24). Pure — no DOM (client tests run without jsdom; the
 * DOM-wrapping part of `annotateMentions` is covered by manual verification,
 * per the existing convention for DOM-heavy client modules).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findRangeAtOffset } from '../src/renderer/editor/mentions-annotate.js';

test('находит диапазон, содержащий смещение', () => {
  const ranges = [
    { start: 0, end: 5 },
    { start: 5, end: 9 },
    { start: 9, end: 20 },
  ];
  assert.equal(findRangeAtOffset(ranges, 0), 0);
  assert.equal(findRangeAtOffset(ranges, 3), 0);
  assert.equal(findRangeAtOffset(ranges, 12), 2);
  assert.equal(findRangeAtOffset(ranges, 20), 2);
});

test('граница между соседними диапазонами отдаётся более раннему', () => {
  const ranges = [
    { start: 0, end: 5 },
    { start: 5, end: 9 },
  ];
  // offset 5 удовлетворяет обоим (start<=5<=end первого и start<=5<=end
  // второго) — побеждает первый найденный (эквивалентная DOM-позиция).
  assert.equal(findRangeAtOffset(ranges, 5), 0);
});

test('смещение вне всех диапазонов — null', () => {
  const ranges = [{ start: 0, end: 5 }];
  assert.equal(findRangeAtOffset(ranges, 6), null);
  assert.equal(findRangeAtOffset(ranges, -1), null);
});

test('пустой список диапазонов — всегда null', () => {
  assert.equal(findRangeAtOffset([], 0), null);
});
