/**
 * Tests for the pure window-bounds sanitization logic
 * (client/src/main/window-bounds.ts).
 *
 * The Electron side effects (BrowserWindow wiring, `screen.getAllDisplays()`)
 * are not exercised here — only the pure helpers that decide whether stored
 * bounds still fit a connected display and what fallback to use otherwise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BOUNDS,
  MIN_HEIGHT,
  MIN_WIDTH,
  parseBounds,
  sanitizeBounds,
  type DisplayLike,
} from '../src/main/window-bounds.js';

const SINGLE_1080P: DisplayLike[] = [
  { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
];

const DUAL: DisplayLike[] = [
  { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
];

test('parseBounds: валидный JSON-объект → WindowBounds', () => {
  assert.deepEqual(parseBounds('{"x":10,"y":20,"width":800,"height":600}'), {
    x: 10,
    y: 20,
    width: 800,
    height: 600,
  });
});

test('parseBounds: дробные значения округляются', () => {
  assert.deepEqual(parseBounds('{"x":10.4,"y":20.6,"width":800.5,"height":600.5}'), {
    x: 10,
    y: 21,
    width: 801,
    height: 601,
  });
});

test('parseBounds: legacy-формат с w/h тоже читается (для старых строк в БД)', () => {
  assert.deepEqual(parseBounds('{"x":10,"y":20,"w":800,"h":600}'), {
    x: 10,
    y: 20,
    width: 800,
    height: 600,
  });
});

test('parseBounds: битый JSON → null', () => {
  assert.equal(parseBounds('not-json'), null);
});

test('parseBounds: не-объект → null', () => {
  assert.equal(parseBounds('[]'), null);
});

test('parseBounds: отсутствующие поля → null', () => {
  assert.equal(parseBounds('{"x":0,"y":0}'), null);
});

test('parseBounds: нечисловые поля → null', () => {
  assert.equal(parseBounds('{"x":"a","y":0,"width":0,"height":0}'), null);
});

test('parseBounds: NaN/Infinity → null', () => {
  assert.equal(parseBounds('{"x":1e400,"y":0,"width":100,"height":100}'), null);
  assert.equal(parseBounds('{"x":NaN,"y":0,"width":100,"height":100}'), null);
});

test('parseBounds: нулевой/отрицательный размер → null', () => {
  assert.equal(parseBounds('{"x":0,"y":0,"width":0,"height":100}'), null);
  assert.equal(parseBounds('{"x":0,"y":0,"width":100,"height":-10}'), null);
});

test('sanitizeBounds: null → дефолт в центре largest-дисплея', () => {
  const got = sanitizeBounds(null, SINGLE_1080P);
  assert.equal(got.width, DEFAULT_BOUNDS.width);
  assert.equal(got.height, DEFAULT_BOUNDS.height);
  assert.ok(got.x >= 0 && got.x + got.width <= 1920);
  assert.ok(got.y >= 0 && got.y + got.height <= 1080);
});

test('sanitizeBounds: пустой список дисплеев → DEFAULT_BOUNDS', () => {
  assert.deepEqual(sanitizeBounds({ x: 0, y: 0, width: 100, height: 100 }, []), DEFAULT_BOUNDS);
});

test('sanitizeBounds: валидные bounds, попадающие в дисплей → сохраняются', () => {
  const bounds = { x: 100, y: 100, width: 1280, height: 800 };
  assert.deepEqual(sanitizeBounds(bounds, SINGLE_1080P), bounds);
});

test('sanitizeBounds: окно больше дисплея → shrink-to-fit', () => {
  const bounds = { x: 0, y: 0, width: 4000, height: 2000 };
  const got = sanitizeBounds(bounds, SINGLE_1080P);
  assert.ok(got.width <= 1920);
  assert.ok(got.height <= 1080);
  assert.ok(got.width >= MIN_WIDTH);
  assert.ok(got.height >= MIN_HEIGHT);
});

test('sanitizeBounds: окно меньше MIN_* → подтягивается до MIN_*', () => {
  const bounds = { x: 0, y: 0, width: 100, height: 100 };
  const got = sanitizeBounds(bounds, SINGLE_1080P);
  assert.equal(got.width, MIN_WIDTH);
  assert.equal(got.height, MIN_HEIGHT);
});

test('sanitizeBounds: bounds на правом дисплее — принят правым', () => {
  const bounds = { x: 2200, y: 100, width: 1280, height: 800 };
  const got = sanitizeBounds(bounds, DUAL);
  assert.equal(got.x, 2200);
  assert.equal(got.width, 1280);
});

test('sanitizeBounds: bounds, целиком за правым краем единственного дисплея → дефолт', () => {
  const bounds = { x: 5000, y: 0, width: 1280, height: 800 };
  const got = sanitizeBounds(bounds, SINGLE_1080P);
  // Не нашли дисплей, который принимает → fallback на largest display
  assert.ok(got.x + got.width <= 1920);
  assert.ok(got.y + got.height <= 1080);
});

test('sanitizeBounds: title bar не виден ни на одном дисплее → fallback', () => {
  // Окно сдвинуто так, что меньше 80 px его верха попадает в дисплей
  const bounds = { x: 1900, y: 1075, width: 1280, height: 800 };
  const got = sanitizeBounds(bounds, SINGLE_1080P);
  assert.ok(got.x + got.width <= 1920);
  assert.ok(got.y + got.height <= 1080);
});

test('sanitizeBounds: title bar слегка торчит — принимается', () => {
  // Чуть-чуть сдвинуто вправо, верхняя полоска ещё видна
  const bounds = { x: 1800, y: 0, width: 1280, height: 800 };
  const got = sanitizeBounds(bounds, SINGLE_1080P);
  // Должно clampнуться в пределы дисплея, но не до дефолта
  assert.ok(got.x + got.width <= 1920);
  assert.ok(got.x >= 0);
});

test('sanitizeBounds: bounds частично вне дисплея слева → втягивается в дисплей', () => {
  const bounds = { x: -200, y: 100, width: 1280, height: 800 };
  const got = sanitizeBounds(bounds, SINGLE_1080P);
  assert.ok(got.x >= 0);
  assert.ok(got.x + got.width <= 1920);
});

test('sanitizeBounds: выбирается largest-дисплей для дефолта', () => {
  const got = sanitizeBounds(null, DUAL);
  // Правый дисплей 2560×1440 больше — дефолт должен оказаться там
  assert.ok(got.x >= 1920);
});
