/**
 * Regression tests for the «Свойство / связь» dialog default-value column and
 * the multi-pick of the «Добавить тип» button (карточка ошибки e6d92dbf —
 * «Ошибки редактора свойства»).
 *
 * 1. Мультивыбор типов в таблицах «Типы мыслей»/«Типы источников»/
 *    «Типы назначений»: общий пикер работает в режиме чек-листа, применение
 *    — кнопкой «Применить и закрыть»; чистый хелпер {@link mergePickedTypeRows}
 *    превращает выбранный набор id в новые строки таблицы без дублей.
 * 2. Колонка «Значение по умолчанию»: режим «(общее)» / «частное» для
 *    унаследованных привязок (per-type override существует только для них —
 *    сервер хранит дефолт собственной привязки только в справочнике):
 *    {@link defaultModeFor} / {@link setDefaultMode} / {@link formatGlobalDefault}
 *    / {@link linkDefaultPayload} — сброс режима «(общее)» даёт `null` и
 *    чистит override через `setPropertyDefaultOverride`.
 *
 * Pure logic — no DOM (client tests run without jsdom, per the existing
 * convention).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defaultModeFor,
  defaultValueChanged,
  formatGlobalDefault,
  linkDefaultPayload,
  mergePickedTypeRows,
  setDefaultMode,
  type TypeRowDraft,
} from '../src/renderer/screens/property-manager.js';

/** Строка таблицы привязок для тестов режима дефолта. */
function makeRow(overrides: Partial<TypeRowDraft> = {}): TypeRowDraft {
  return {
    id: 'bind-1',
    thoughtTypeId: 'tt-1',
    required: false,
    defaultValue: null,
    side: 'source',
    definedOn: 'tt-0',
    dirty: false,
    overriddenHere: false,
    initialDefaultValue: null,
    ...overrides,
  };
}

describe('mergePickedTypeRows — мультивыбор «Добавить тип» (e6d92dbf)', () => {
  it('добавляет несколько типов одной стороной', () => {
    const fresh = mergePickedTypeRows([], ['tt-a', 'tt-b', 'tt-c'], 'source');
    assert.equal(fresh.length, 3);
    assert.deepEqual(
      fresh.map((r) => r.thoughtTypeId),
      ['tt-a', 'tt-b', 'tt-c'],
    );
    assert.ok(fresh.every((r) => r.side === 'source' && r.id === null && r.dirty === true));
    assert.ok(fresh.every((r) => r.definedOn === null && r.overriddenHere === false));
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

describe('defaultModeFor / setDefaultMode — «(общее)»/«частное» (e6d92dbf)', () => {
  it('режим определяется флагом overriddenHere', () => {
    assert.equal(defaultModeFor(makeRow()), 'common');
    assert.equal(defaultModeFor(makeRow({ overriddenHere: true })), 'private');
  });

  it('«частное» сохраняет текущее значение как старт редактора', () => {
    const row = makeRow({ defaultValue: ['t-1'], overriddenHere: false });
    setDefaultMode(row, 'private');
    assert.equal(row.overriddenHere, true);
    assert.equal(row.dirty, true);
    assert.deepEqual(row.defaultValue, ['t-1']);
  });

  it('«(общее)» сбрасывает значение в null и метит строку грязной', () => {
    const row = makeRow({ defaultValue: ['t-1', 't-2'], overriddenHere: true, dirty: false });
    setDefaultMode(row, 'common');
    assert.equal(row.overriddenHere, false);
    assert.equal(row.dirty, true);
    assert.equal(row.defaultValue, null);
  });
});

describe('сброс «частного» в «(общее)» чистит override (e6d92dbf)', () => {
  it('linkDefaultPayload(null) — null (сервер снимает override)', () => {
    assert.equal(linkDefaultPayload(null), null);
    assert.equal(linkDefaultPayload([]), null);
    // Не-строки отфильтровываются; не осталось строк — null.
    assert.equal(linkDefaultPayload([1, 2] as unknown), null);
  });

  it('набор целей сохраняется как string[]', () => {
    assert.deepEqual(linkDefaultPayload(['t-1', 't-2']), ['t-1', 't-2']);
    assert.deepEqual(linkDefaultPayload(['t-1', '', 't-2']), ['t-1', 't-2']);
  });

  it('переход в «(общее)» даёт defaultValueChanged против частного снимка', () => {
    const row = makeRow({
      defaultValue: ['t-1'],
      overriddenHere: true,
      initialDefaultValue: ['t-1'],
      dirty: false,
    });
    setDefaultMode(row, 'common');
    assert.equal(defaultValueChanged(row), true);
    assert.equal(linkDefaultPayload(row.defaultValue), null);
  });
});

describe('formatGlobalDefault — подпись глобального значения (e6d92dbf)', () => {
  it('пустое значение — null (подпись только «(общее)»)', () => {
    assert.equal(formatGlobalDefault(null), null);
    assert.equal(formatGlobalDefault(undefined), null);
  });

  it('скалярные значения читаемы', () => {
    assert.equal(formatGlobalDefault('да'), 'да');
    assert.equal(formatGlobalDefault(42), '42');
    assert.equal(formatGlobalDefault(true), 'да');
    assert.equal(formatGlobalDefault(false), 'нет');
  });

  it('набор целей — со склонением', () => {
    assert.equal(formatGlobalDefault(['a']), '1 цель');
    assert.equal(formatGlobalDefault(['a', 'b']), '2 цели');
    assert.equal(formatGlobalDefault(['a', 'b', 'c', 'd', 'e']), '5 целей');
    assert.equal(formatGlobalDefault(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']), '11 целей');
  });
});
