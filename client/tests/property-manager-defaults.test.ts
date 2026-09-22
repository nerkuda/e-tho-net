/**
 * Regression tests for the «Свойство / связь» dialog default-value column and
 * the multi-pick of the «Добавить тип» button.
 *
 * 1. Мультивыбор типов в таблицах «Типы мыслей»/«Типы источников»/
 *    «Типы назначений»: общий пикер работает в режиме чек-листа, применение
 *    — кнопкой «Применить и закрыть»; чистый хелпер {@link applyPickedTypeRows}
 *    ПЕРЕЗАПИСЫВАЕТ набор строк стороны выбранными id (ошибка a3828b28:
 *    снятый флажок убирает строку, нетронутые строки сохраняют настройки).
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
  applyPickedTypeRows,
  currentTypeRowIds,
  linkDefaultPayload,
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

describe('applyPickedTypeRows — перезапись набора строк пикером «Добавить тип»', () => {
  it('добавляет несколько типов одной стороной', () => {
    const next = applyPickedTypeRows([], ['tt-a', 'tt-b', 'tt-c'], 'source');
    assert.equal(next.length, 3);
    assert.deepEqual(
      next.map((r) => r.thoughtTypeId),
      ['tt-a', 'tt-b', 'tt-c'],
    );
    assert.ok(next.every((r) => r.side === 'source' && r.id === null && r.dirty === true));
    assert.ok(next.every((r) => r.defaultValue === null));
  });

  it('регресс a3828b28: снятый флажок убирает строку, поставленный — добавляет', () => {
    const existing = [
      makeRow({ thoughtTypeId: 'tt-a', side: 'source' }),
      makeRow({ thoughtTypeId: 'tt-b', side: 'source' }),
    ];
    const next = applyPickedTypeRows(existing, ['tt-b', 'tt-c'], 'source');
    assert.deepEqual(
      next.map((r) => r.thoughtTypeId),
      ['tt-b', 'tt-c'],
    );
    // Снятый tt-a исчез из черновика — на записи его снимет removeTypeProperty
    // (applyTypeRows диффит по снимку загрузки).
    assert.equal(next.some((r) => r.thoughtTypeId === 'tt-a'), false);
  });

  it('нетронутый тип сохраняет id привязки, «обязательное» и дефолт', () => {
    const kept = makeRow({
      id: 'bind-b',
      thoughtTypeId: 'tt-b',
      side: 'source',
      required: true,
      defaultValue: ['t-1'],
      dirty: false,
      initialDefaultValue: ['t-1'],
    });
    const next = applyPickedTypeRows([makeRow({ thoughtTypeId: 'tt-a' }), kept], ['tt-b', 'tt-c'], 'source');
    const b = next.find((r) => r.thoughtTypeId === 'tt-b');
    assert.equal(b, kept);
    assert.equal(b?.id, 'bind-b');
    assert.equal(b?.required, true);
    assert.deepEqual(b?.defaultValue, ['t-1']);
    assert.equal(b?.dirty, false);
    // Добавленный tt-c — новая строка с дефолтами по умолчанию.
    const c = next.find((r) => r.thoughtTypeId === 'tt-c');
    assert.equal(c?.id, null);
    assert.equal(c?.required, false);
    assert.equal(c?.defaultValue, null);
    assert.equal(c?.dirty, true);
  });

  it('пустой выбор снимает со стороны все строки', () => {
    const existing = [makeRow({ thoughtTypeId: 'tt-a', side: 'source' })];
    assert.deepEqual(applyPickedTypeRows(existing, [], 'source'), []);
  });

  it('дубль другой стороны не считается (свойство-связь двусторонняя)', () => {
    const existing = [makeRow({ thoughtTypeId: 'tt-a', side: 'target' })];
    const next = applyPickedTypeRows(existing, ['tt-a'], 'source');
    assert.deepEqual(
      next.filter((r) => r.side === 'source').map((r) => r.thoughtTypeId),
      ['tt-a'],
    );
    // Строка чужой стороны осталась нетронутой.
    assert.equal(next.some((r) => r.side === 'target' && r.thoughtTypeId === 'tt-a'), true);
  });

  it('повторы внутри выбора и пустые id отбрасываются', () => {
    assert.equal(applyPickedTypeRows([], ['', 'tt-a'], 'source').length, 1);
    const existing = [makeRow({ thoughtTypeId: 'tt-a', side: 'source' })];
    assert.equal(applyPickedTypeRows(existing, ['tt-a', 'tt-a', ''], 'source').length, 1);
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

  it('повторное применение предзаполненного набора не меняет строки (ошибка 4e9ad1a0)', () => {
    const existing = [makeRow({ thoughtTypeId: 'tt-a', side: 'source' })];
    const prefill = currentTypeRowIds(existing, 'source');
    const next = applyPickedTypeRows(existing, prefill, 'source');
    assert.deepEqual(next, existing);
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
