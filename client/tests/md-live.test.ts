/**
 * Unit tests of the live-preview helpers (task M6). Pure — no DOM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isInRangeInclusive, isNearInline, wikiLabel } from '../src/renderer/editor/md-live.js';

/** Каретка в одной позиции. */
const caret = (pos: number) => [{ from: pos, to: pos, empty: true }];

test('wikiLabel: имя без алиаса', () => {
  assert.deepEqual(wikiLabel('[[имя мысли]]'), {
    target: 'имя мысли',
    label: 'имя мысли',
  });
});

test('wikiLabel: алиас после |', () => {
  assert.deepEqual(wikiLabel('[[имя мысли|синоним]]'), {
    target: 'имя мысли',
    label: 'синоним',
  });
});

test('wikiLabel: не-ссылка и неполные формы — null; пустой алиас = имя', () => {
  for (const source of ['не ссылка', '[[без закрытия', '[[]]', '[[|b]]', '[[a\nb]]']) {
    assert.equal(wikiLabel(source), null, JSON.stringify(source));
  }
  // Пустой алиас допустим — рендерер показывает имя (паритет с markdown-пакетом).
  assert.deepEqual(wikiLabel('[[a|]]'), { target: 'a', label: 'a' });
});

// ---------------------------------------------------------------------------
// Правила активности (M6-фикс): блочные — включительно по диапазону,
// инлайн — плюс одна позиция до/после элемента.
// ---------------------------------------------------------------------------

test('блочное правило: активен от первого до последнего символа включительно', () => {
  const ranges = (pos: number) => caret(pos);
  // [10, 20): каретка на границах и внутри — активна.
  assert.equal(isInRangeInclusive(ranges(10), 10, 20), true);
  assert.equal(isInRangeInclusive(ranges(19), 10, 20), true);
  assert.equal(isInRangeInclusive(ranges(20), 10, 20), true, 'последний символ включён');
  assert.equal(isInRangeInclusive(ranges(9), 10, 20), false);
  assert.equal(isInRangeInclusive(ranges(21), 10, 20), false);
});

test('инлайн-правило: внутри и непосредственно перед/после', () => {
  const ranges = (pos: number) => caret(pos);
  // Элемент [10, 13): каретка в 9 — перед, в 13 — сразу после.
  assert.equal(isNearInline(ranges(9), 10, 13), true, 'непосредственно перед');
  assert.equal(isNearInline(ranges(12), 10, 13), true, 'внутри');
  assert.equal(isNearInline(ranges(13), 10, 13), true, 'непосредственно после');
  assert.equal(isNearInline(ranges(8), 10, 13), false, 'через символ до');
  assert.equal(isNearInline(ranges(14), 10, 13), false, 'через символ после');
});
