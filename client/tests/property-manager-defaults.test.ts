/**
 * Regression tests for the «Свойство / связь» dialog default-value column and
 * the multi-pick of the «Добавить тип» button.
 *
 * 1. Мультивыбор типов в таблицах «Типы мыслей»/«Типы источников»/
 *    «Типы назначений»: общий пикер работает в режиме чек-листа, применение
 *    — кнопкой «Применить и закрыть»; чистый хелпер {@link mergePickedTypeRows}
 *    превращает выбранный набор id в новые строки таблицы без дублей.
 * 2. Дефолты привязок (0.8.2, ADR «дефолт свойства живёт на привязке»):
 *    колонка «Значение по умолчанию» — редактор значения без режимов
 *    «(общее)»/«частное». {@link linkDefaultPayload} конвертирует набор целей
 *    в тело `setPropertyDefaultOverride`, пустое значение — `null` (сброс
 *    override, действует общее значение стороны привязки).
 *
 * Pure logic — no DOM (client tests run without jsdom, per the existing
 * convention).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  linkDefaultPayload,
  mergePickedTypeRows,
  type TypeRowDraft,
} from '../src/renderer/screens/property-manager.js';

/** Строка таблицы привязок для тестов дефолтов. */
function makeRow(overrides: Partial<TypeRowDraft> = {}): TypeRowDraft {
  return {
    id: 'bind-1',
    thoughtTypeId: 'tt-1',
    required: false,
    defaultValue: null,
    side: 'source',
    dirty: false,
    initialDefaultValue: null,
    ...overrides,
  };
}

describe('mergePickedTypeRows — мультивыбор «Добавить тип»', () => {
  it('добавляет несколько типов одной стороной', () => {
    const fresh = mergePickedTypeRows([], ['tt-a', 'tt-b', 'tt-c'], 'source');
    assert.equal(fresh.length, 3);
    assert.deepEqual(
      fresh.map((r) => r.thoughtTypeId),
      ['tt-a', 'tt-b', 'tt-c'],
    );
    assert.ok(fresh.every((r) => r.side === 'source' && r.id === null && r.dirty === true));
    assert.ok(fresh.every((r) => r.defaultValue === null));
  });

  it('пропускает дубли: уже добавленные и повторы внутри выбора', () => {
    const existing = [makeRow({ thoughtTypeId: 'tt-a', side: 'source' })];
    const fresh = mergePickedTypeRows(existing, ['tt-a', 'tt-b', 'tt-b'], 'source');
    assert.deepEqual(
      fresh.map((r) => r.thoughtTypeId),
      ['tt-b'],
    );
  });

  it('дубль другой стороны не считается (свойство-связь двусторонняя)', () => {
    const existing = [makeRow({ thoughtTypeId: 'tt-a', side: 'target' })];
    const fresh = mergePickedTypeRows(existing, ['tt-a'], 'source');
    assert.deepEqual(
      fresh.map((r) => r.thoughtTypeId),
      ['tt-a'],
    );
  });

  it('пустые id отбрасываются', () => {
    assert.equal(mergePickedTypeRows([], ['', 'tt-a'], 'source').length, 1);
  });
});

describe('linkDefaultPayload — тело setPropertyDefaultOverride (0.8.2)', () => {
  it('пустое значение — null (сброс override, действует общее стороны)', () => {
    assert.equal(linkDefaultPayload(null), null);
    assert.equal(linkDefaultPayload(undefined), null);
    assert.equal(linkDefaultPayload([]), null);
    // Не-строки отфильтровываются; не осталось строк — null.
    assert.equal(linkDefaultPayload([1, 2] as unknown), null);
    assert.equal(linkDefaultPayload(['', '']), null);
  });

  it('набор целей сохраняется как string[]', () => {
    assert.deepEqual(linkDefaultPayload(['t-1', 't-2']), ['t-1', 't-2']);
    assert.deepEqual(linkDefaultPayload(['t-1', '', 't-2']), ['t-1', 't-2']);
  });
});
