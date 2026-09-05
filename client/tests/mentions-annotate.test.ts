/**
 * Unit tests of the pure offset-mapping helper behind the mentions
 * auto-annotation (L24). Pure — no DOM (client tests run without jsdom; the
 * DOM-wrapping part of `annotateMentions` is covered by manual verification,
 * per the existing convention for DOM-heavy client modules).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chunkTextsForScan,
  findRangeAtOffset,
  MENTIONS_SCAN_MAX_CHARS,
  MENTIONS_SCAN_MAX_ITEMS,
} from '../src/renderer/editor/mentions-annotate.js';

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

// -----------------------------------------------------------------------------
// chunkTextsForScan — splits texts for POST /mentions/scan so each batch fits
// the contract: ≤50 items and ≤20000 chars total. See error
// 8ca4841b-2f2f-4b1a-b34e-70b3d4111ccd.
// -----------------------------------------------------------------------------

test('chunkTextsForScan: пустой вход → пустой результат', () => {
  assert.deepEqual(chunkTextsForScan([]), []);
});

test('chunkTextsForScan: короткий вход помещается в один батч', () => {
  const texts = ['alpha', 'beta', 'gamma'];
  const batches = chunkTextsForScan(texts);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], texts);
});

test('chunkTextsForScan: 60 коротких текстов → 2 батча (50 + 10)', () => {
  const texts = Array.from({ length: 60 }, (_, i) => `t${i}`);
  const batches = chunkTextsForScan(texts);
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.length, 50);
  assert.equal(batches[1]!.length, 10);
  // порядок сохраняется
  assert.deepEqual(batches[0]![0], 't0');
  assert.deepEqual(batches[0]![49], 't49');
  assert.deepEqual(batches[1]![0], 't50');
  assert.deepEqual(batches[1]![9], 't59');
});

test('chunkTextsForScan: текст длиннее лимита chars отправляется одним батчем', () => {
  const huge = 'x'.repeat(MENTIONS_SCAN_MAX_CHARS + 5000);
  const texts = [huge, 'next'];
  const batches = chunkTextsForScan(texts);
  // один батч с огромным текстом + один с «next»; пустых батчей нет.
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.length, 1);
  assert.equal(batches[0]![0], huge);
  assert.deepEqual(batches[1], ['next']);
});

test('chunkTextsForScan: огромный текст без последующих — единственный батч', () => {
  const huge = 'y'.repeat(MENTIONS_SCAN_MAX_CHARS * 2);
  const batches = chunkTextsForScan([huge]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.equal(batches[0]![0], huge);
});

test('chunkTextsForScan: суммарно > лимита chars делит по границе текста', () => {
  // каждый текст 5000 символов; 5 штук — это 25 000, что больше 20 000.
  const texts = Array.from({ length: 5 }, (_, i) => 'a'.repeat(5000));
  const batches = chunkTextsForScan(texts);
  // 5000 + 5000 + 5000 + 5000 = 20000 — четвёртый уже не влезает.
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.length, 4);
  assert.equal(batches[1]!.length, 1);
});

test('chunkTextsForScan: каждый батч укладывается в оба лимита контракта', () => {
  // свойства-инварианты, которые должен выполнять любой корректный вход.
  const texts: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    texts.push('z'.repeat(100 + (i % 7) * 50));
  }
  texts.push('w'.repeat(MENTIONS_SCAN_MAX_CHARS + 100));
  const batches = chunkTextsForScan(texts);
  assert.ok(batches.length >= 1);
  for (const batch of batches) {
    assert.ok(batch.length <= MENTIONS_SCAN_MAX_ITEMS, `items=${batch.length}`);
    const chars = batch.reduce((sum, t) => sum + t.length, 0);
    // текст больше лимита chars может попасть один — это исключение из инварианта.
    assert.ok(
      batch.length === 1 || chars <= MENTIONS_SCAN_MAX_CHARS,
      `chars=${chars}, items=${batch.length}`,
    );
  }
  // общий порядок сохраняется
  assert.deepEqual(batches.flat(), texts);
});

test('chunkTextsForScan: ровно 50 текстов влезают в один батч', () => {
  const texts = Array.from({ length: 50 }, () => 'a');
  assert.deepEqual(chunkTextsForScan(texts), [texts]);
});
