/**
 * Unit tests of the live-preview helpers (task M6). Pure — no DOM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wikiLabel } from '../src/renderer/editor/md-live.js';

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
