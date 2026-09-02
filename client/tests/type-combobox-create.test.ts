/**
 * Unit tests for the «Создать новый» row decision of the type combobox
 * (client/src/renderer/lib/type-combobox.ts, карточка ETN «Быстрое создание
 * типа из поля ввода»).
 *
 * Pure logic — no DOM (client tests run without jsdom, per the existing
 * convention for DOM-heavy client modules): the decision when the create row
 * is allowed is the acceptance-critical part of the quick type creation flow.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRowName } from '../src/renderer/lib/type-combobox.js';

test('строка создания появляется при непустом запросе без совпадений', () => {
  assert.equal(createRowName('задача', 0, true), 'задача');
  // Имя.trim(): пробелы по краям запроса не попадают в имя типа.
  assert.equal(createRowName('  задача  ', 0, true), 'задача');
});

test('пустой запрос — строки создания нет (показывается всё дерево)', () => {
  assert.equal(createRowName('', 0, true), null);
  assert.equal(createRowName('   ', 0, true), null);
});

test('есть совпадения — строки создания нет', () => {
  assert.equal(createRowName('зада', 1, true), null);
  assert.equal(createRowName('зада', 5, true), null);
});

test('без опции onCreateNew строки создания нет никогда', () => {
  assert.equal(createRowName('задача', 0, false), null);
});
