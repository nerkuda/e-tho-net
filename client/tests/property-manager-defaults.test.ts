/**
 * Regression tests for the «Свойство / связь» dialog default-value column and
 * the multi-pick of the «Добавить тип» button.
 *
 * 1. Мультивыбор типов в таблицах «Типы мыслей»/«Типы источников»/
 *    «Типы назначений»: общий пикер работает в режиме чек-листа, применение
 *    — кнопкой «Применить и закрыть»; чистый хелпер {@link mergePickedTypeRows}
 *    превращает выбранный набор id в новые строки таблицы без дублей.
 *    Пикер открывается с предзаполнением — чистый хелпер
 *    {@link currentTypeRowIds} отдаёт уже выбранные типы своей стороны
 *    (ошибка 4e9ad1a0: галочки уже выбранных типов при открытии диалога).
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
  currentTypeRowIds,
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

describe('currentTypeRowIds — предзаполнение пикера «Добавить тип»', () => {
  it('возвращает типы своей стороны в порядке строк', () => {
    const rows = [
      makeRow({ thoughtTypeId: 'tt-a', side: 'source' }),
      makeRow({ thoughtTypeId: 'tt-b', side: 'source' }),
    ];
    assert.deepEqual(currentTypeRowIds(rows, 'source'), ['tt-a', 'tt-b']);
  });

  it('чужие стороны не попадают: таблицы «Типы источников» и «Типы назначений» независимы', () => {
    const rows = [
      makeRow({ thoughtTypeId: 'tt-src', side: 'source' }),
      makeRow({ thoughtTypeId: 'tt-dst', side: 'target' }),
    ];
    assert.deepEqual(currentTypeRowIds(rows, 'source'), ['tt-src']);
    assert.deepEqual(currentTypeRowIds(rows, 'target'), ['tt-dst']);
  });

  it('у скаляра сторона null — предзаполняется вся таблица «Типы мыслей»', () => {
    const rows = [
      makeRow({ thoughtTypeId: 'tt-a', side: null }),
      makeRow({ thoughtTypeId: 'tt-b', side: 'source' }),
    ];
    assert.deepEqual(currentTypeRowIds(rows, null), ['tt-a']);
  });

  it('пустая таблица — пустое предзаполнение (ни одна галочка не отмечена)', () => {
    assert.deepEqual(currentTypeRowIds([], 'source'), []);
  });

  it('повторное применение с предзаполнением не добавляет дублей (ошибка 4e9ad1a0)', () => {
    const existing = [makeRow({ thoughtTypeId: 'tt-a', side: 'source' })];
    const prefill = currentTypeRowIds(existing, 'source');
    const fresh = mergePickedTypeRows(existing, prefill, 'source');
    assert.deepEqual(fresh, []);
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
