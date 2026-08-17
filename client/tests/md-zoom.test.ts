/**
 * Unit tests of the markdown zoom helpers (M9). Pure — no DOM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampMdZoom,
  MD_ZOOM_MAX,
  MD_ZOOM_MIN,
  parseMdZoom,
  zoomByWheel,
} from '../src/renderer/editor/md-zoom.js';

test('parseMdZoom: валидные значения, мусор и пустота → 1', () => {
  assert.equal(parseMdZoom('1.5'), 1.5);
  assert.equal(parseMdZoom('2'), 2);
  assert.equal(parseMdZoom(null), 1);
  assert.equal(parseMdZoom(''), 1);
  assert.equal(parseMdZoom('abc'), 1);
  assert.equal(parseMdZoom('0'), 1, 'ноль недопустим');
});

test('clampMdZoom: диапазон 0.5–2.5', () => {
  assert.equal(clampMdZoom(0.2), MD_ZOOM_MIN);
  assert.equal(clampMdZoom(9), MD_ZOOM_MAX);
  assert.equal(clampMdZoom(1.3), 1.3);
});

test('zoomByWheel: вверх увеличивает, вниз уменьшает, без выхода за границы', () => {
  const grown = zoomByWheel(1, -120);
  const shrunk = zoomByWheel(1, 120);
  assert.ok(grown > 1, 'deltaY<0 — увеличение');
  assert.ok(shrunk < 1, 'deltaY>0 — уменьшение');
  assert.equal(zoomByWheel(MD_ZOOM_MAX, -120), MD_ZOOM_MAX);
  assert.equal(zoomByWheel(MD_ZOOM_MIN, 120), MD_ZOOM_MIN);
});
