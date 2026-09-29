/**
 * Объединённый диалог каталога типов и свойств (задача 979761cd).
 *
 * До 0.10.2 «Типы мыслей», «Свойства мыслей» и «Типы связей» открывались тремя
 * отдельными диалогами — неудобно переходить от свойства к типу и обратно.
 * Теперь это три вкладки ОДНОГО диалога, а команды меню «Мыслесеть» открывают
 * его на своей вкладке. Списки не дублируются: панели — те же тела, что были в
 * отдельных диалогах (`buildThoughtTypesPanel` / `buildPropertiesPanel` /
 * `buildLinkTypesPanel`).
 *
 * Проверяется рендер исходников (конвенция соседних guard-тестов):
 *   1. Оболочка `screens/type-catalogue.ts` собирает диалог через общий механизм
 *      вкладок (`DialogOptions.tabs`), три вкладки в требуемом порядке.
 *   2. Содержимое вкладок — ЛЕНИВЫЕ функции (состояние панели строится один раз
 *      и переживает переключение вкладок в рамках открытого диалога).
 *   3. Панели строятся общими модулями списков, а не собственным кодом оболочки.
 *   4. Команды меню «Мыслесеть» разведены по вкладкам; отдельные диалоги
 *      (`showThoughtTypesDialog` и др.) упразднены — дублирования нет.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

const read = (rel: string): string => readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');

const CATALOGUE = read('screens/type-catalogue.ts');
const MENUS = read('screens/workspace-menus.ts');
const TYPE_MANAGER = read('screens/type-manager.ts');
const PROPERTY_MANAGER = read('screens/property-manager.ts');

describe('объединённый каталог типов и свойств (979761cd)', () => {
  it('собирает один вкладочный диалог: три вкладки в требуемом порядке', () => {
    assert.ok(CATALOGUE.includes('showDialog({'), 'оболочка открывает каркас диалога');
    assert.ok(CATALOGUE.includes('tabs,'), 'оболочка передаёт вкладки каркасу (DialogOptions.tabs)');
    const ids = [...CATALOGUE.matchAll(/id:\s*'(thought-types|properties|link-types)'/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(
      ids,
      ['thought-types', 'properties', 'link-types'],
      'вкладки каталога — в порядке: Типы мыслей, Свойства мыслей, Типы связей',
    );
    assert.match(
      CATALOGUE,
      /title:\s*t\('catalogue\.title'\)[\s\S]{0,400}?size:\s*'l'/,
      'роль размера l — единая для трёх списков',
    );
  });

  it('содержимое вкладок — ленивые функции (состояние переживает переключение)', () => {
    // `content` — функция (`uiTabs` строит панель при первом показе и
    // переиспользует узел), а не готовый элемент: поиск и раскрытость дерева
    // сохраняются при переключении вкладок.
    for (const builder of [
      'buildThoughtTypesPanel',
      'buildPropertiesPanel',
      'buildLinkTypesPanel',
    ]) {
      const re = new RegExp(`content:\\s*host\\(\\(\\)\\s*=>\\s*${builder}\\(`);
      assert.match(
        CATALOGUE,
        re,
        `вкладка ${builder}: содержимое обязано строиться ленивой функцией`,
      );
    }
  });

  it('панели берутся из общих модулей списков, собственный код оболочки — только сборка', () => {
    assert.ok(
      CATALOGUE.includes("from './type-manager.js'"),
      'панель типов мыслей берётся из type-manager.ts',
    );
    assert.ok(
      CATALOGUE.includes("from './property-manager.js'"),
      'панели свойств и типов связей берутся из property-manager.ts',
    );
    // Оболочка — лишь вкладки: ни дерева, ни таблицы, ни строки поиска в ней нет.
    assert.ok(!CATALOGUE.includes('createTree'), 'оболочка не строит дерево сама');
    assert.ok(!CATALOGUE.includes('buildPropertyList'), 'оболочка не строит список свойств сама');
    assert.ok(!CATALOGUE.includes('searchInput'), 'оболочка не строит строку поиска сама');
  });

  it('панели освобождают подписки по закрытию диалога', () => {
    assert.match(
      CATALOGUE,
      /onClose:\s*\(\)\s*=>\s*\{[\s\S]{0,200}?panel\.dispose\(\)/,
      'по закрытию диалога панели обязаны освободить realtime-подписки',
    );
  });

  it('каждая команда меню «Мыслесеть» открывает каталог на своей вкладке', () => {
    assert.ok(
      MENUS.includes('showTypeCatalogueDialog'),
      'меню открывает объединённый диалог каталога',
    );
    assert.match(
      MENUS,
      /showTypeCatalogueDialog\('thought-types'\)/,
      'команда «Типы мыслей» — вкладка типов мыслей',
    );
    assert.match(
      MENUS,
      /showTypeCatalogueDialog\('link-types'\)/,
      'команда «Типы связей» — вкладка типов связей',
    );
    assert.match(
      MENUS,
      /showTypeCatalogueDialog\('properties'\)/,
      'команда «Свойства мыслей» — вкладка свойств',
    );
  });

  it('отдельные диалоги списков упразднены — тела вынесены в панели без дублей', () => {
    assert.ok(
      !TYPE_MANAGER.includes('export function showThoughtTypesDialog'),
      'отдельный диалог «Типы мыслей» упразднён',
    );
    assert.ok(
      !PROPERTY_MANAGER.includes('export function showPropertyManagerDialog'),
      'отдельный диалог «Свойства» упразднён',
    );
    assert.ok(
      !PROPERTY_MANAGER.includes('export function showLinkTypesTreeDialog'),
      'отдельный диалог «Типы связей» упразднён',
    );
    assert.ok(
      TYPE_MANAGER.includes('export function buildThoughtTypesPanel'),
      'тело списка типов мыслей — панель объединённого диалога',
    );
    assert.ok(
      PROPERTY_MANAGER.includes('export function buildPropertiesPanel'),
      'тело списка свойств — панель объединённого диалога',
    );
    assert.ok(
      PROPERTY_MANAGER.includes('export function buildLinkTypesPanel'),
      'тело списка типов связей — панель объединённого диалога',
    );
  });
});
