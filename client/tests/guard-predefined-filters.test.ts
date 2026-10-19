/**
 * Сторож предопределённых наборов отборов (задача 347b307e; арбитраж
 * оркестратора 2026-10-14).
 *
 * Запрет, который можно нарушить кодом: посев предопределённых наборов обязан
 * идти ЕДИНОЙ точкой (`openSavedPicker` → `seedPredefinedFilters`), сопоставление
 * — по каноничным условиям через ОДИН канонизатор (`lib/filter-canonical.ts`), а
 * метка «предопределённый» — общим бейджем дизайн-системы. Экран, который
 * сравнивал бы определения по ИМЕНИ или завёл бы вторую нормализацию, молча
 * разошёлся бы с постановкой.
 *
 * Сторож статический: читает исходники панелей и строки отборов. Поведение
 * (канон, посев, запуск наборов) проверено в `predefined-filters.test.ts`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

const STRUCTURES = fs.readFileSync(path.join(RENDERER, 'screens', 'structures', 'filter-panel.ts'), 'utf8');
const CHRONICLE = fs.readFileSync(path.join(RENDERER, 'screens', 'chronicle', 'filter-panel.ts'), 'utf8');
const BAR = fs.readFileSync(path.join(RENDERER, 'lib', 'saved-filter-bar.ts'), 'utf8');
const CONTROLLER = fs.readFileSync(
  path.join(RENDERER, 'lib', 'saved-filter-controller.ts'),
  'utf8',
);
const CANONICAL = fs.readFileSync(path.join(RENDERER, 'lib', 'filter-canonical.ts'), 'utf8');
const SEED = fs.readFileSync(path.join(RENDERER, 'lib', 'predefined-filters.ts'), 'utf8');

describe('сторож предопределённых наборов отборов (задача 347b307e)', () => {
  it('посев подключён хуком beforePicker ОБЕИХ панелей и идёт до открытия диалога', () => {
    for (const [name, source] of [
      ['structures', STRUCTURES],
      ['chronicle', CHRONICLE],
    ] as const) {
      assert.match(
        source,
        /beforePicker: seedPredefinedFilters/,
        `${name}: посев подключён единым хуком контроллера`,
      );
    }
    // Контроллер — единственная точка открытия списка: посев до диалога.
    const seedAt = CONTROLLER.indexOf('await opts.beforePicker()');
    const dialogAt = CONTROLLER.indexOf('openSavedFilterDialog(');
    assert.notEqual(seedAt, -1, 'контроллер вызывает beforePicker');
    assert.notEqual(dialogAt, -1, 'контроллер открывает диалог');
    assert.ok(seedAt < dialogAt, 'посев ДО открытия диалога');
  });

  it('каждая панель объявляет свои предопределённые наборы и канонизатор', () => {
    for (const source of [STRUCTURES, CHRONICLE]) {
      assert.match(source, /export const PREDEFINED_FILTERS: readonly PredefinedFilter\[\]/, 'наборы объявлены');
      assert.match(source, /export function canonicalDefinition\(/, 'канонизатор объявлен');
      assert.match(source, /canonicalFilterTree\(readFilterDefinition\(def\)\.tree\)/, 'канонизация — через РИДЕР панели и общий канонизатор');
    }
  });

  it('сопоставление — по каноничным условиям (единый модуль), не по имени', () => {
    assert.match(CANONICAL, /export function canonicalFilterTree\(/, 'единый канонизатор экспортирован');
    assert.match(CANONICAL, /normalizeFilterToken\(/, 'токены нормализуются');
    assert.match(SEED, /predefinedFiltersToCreate\(/, 'посев решает по канону');
    assert.match(SEED, /existingCanon\.has\(canonical\)/, 'наличие набора определяется ПО УСЛОВИЯМ');
    assert.match(SEED, /duplicateFilterName\(/, 'конфликт имени — свободное имя');
  });

  it('посев создаёт наборы хранилищем СВОЕГО вида', () => {
    assert.match(STRUCTURES, /etn\.savedFilters\.create\(/, 'структуры — savedFilters.create');
    assert.match(CHRONICLE, /etn\.chronicleFilters\.create\(/, 'дневник — chronicleFilters.create');
  });

  it('метка предопределённого набора — общий бейдж дизайн-системы', () => {
    assert.match(BAR, /entry\.predefined === true/, 'метка по признаку записи');
    assert.match(BAR, /badge\(t\('savedFilters\.predefined'\)/, 'использован фасад badge');
  });
});
