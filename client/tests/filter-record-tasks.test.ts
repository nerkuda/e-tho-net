/**
 * Отбор «Дневника»: условие «Есть задачи» записи (0.16.1, уточнение
 * 2026-11-19, пункт 8; профиль `chronicle`).
 *
 * Операнд `record_tasks` — ПРЕДИКАТ НАЛИЧИЯ строк-задач в записи. В
 * конструкторе отбора он должен вести себя как коллекции мысли (`tasks`,
 * `attachments`): ячейка значения «(да)/(нет)», оператор в строке не
 * показывается (его перезаписывает виджет), подпись берётся из словаря.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FILTER_COLLECTION_PREDICATE_KINDS,
  OPERAND_KIND_LABELS,
} from '../src/renderer/lib/filter-builder.js';
import { t } from '../src/renderer/lib/i18n.js';

describe('отбор Дневника: «Есть задачи» записи (пункт 8)', () => {
  it('`record_tasks` входит в словарь предикатов наличия', () => {
    assert.ok(
      FILTER_COLLECTION_PREDICATE_KINDS.has('record_tasks'),
      'ячейка значения — та же триада «(да)/(нет)», что у коллекций',
    );
  });

  it('подпись операнда — из словаря локали', () => {
    assert.equal(OPERAND_KIND_LABELS.record_tasks, t('filter.record_tasks.hasTasks'));
    assert.equal(t('filter.record_tasks.hasTasks'), 'Есть задачи');
  });
});
