/**
 * Пикер списка свойств: исключение уже присутствующих строк (0.14.1, задача
 * 626b29bd, требование 87039bc8).
 *
 * Новый опциональный параметр `excludeRow` убирает строки из ВСЕЙ выдачи
 * пикера — без пометок-блокировок: строки нет ни в таблице, ни в выборе.
 * Исключение — по стороне: у свойства-связи прямая и обратная строки
 * независимы. Без параметра список ведёт себя как раньше (оба существующих
 * потребителя).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPropertyListRows,
  excludePropertyListRows,
  type PropertyListRow,
  type PropertyRegistryRow,
} from '../src/renderer/lib/property-list.js';
import type { LinkType } from '@etn/shared';

function registryRow(overrides: Partial<PropertyRegistryRow> = {}): PropertyRegistryRow {
  return {
    id: 'p1',
    name: 'свойство',
    value_type: 'text',
    config: null,
    description: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    types_count: 0,
    values_count: 0,
    ...overrides,
  };
}

const LINK_TYPE: LinkType = {
  id: 'lt1',
  name_forward: 'вперёд',
  name_reverse: 'назад',
  parent_id: null,
  is_root: true,
  color: null,
  style: null,
  width: null,
  description: null,
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
  version: 1,
  created_by: 'u',
};

function sampleRows(): PropertyListRow[] {
  return buildPropertyListRows(
    [
      registryRow({ id: 'p1', name: 'Альфа' }),
      registryRow({ id: 'p2', name: 'Бета' }),
      registryRow({
        id: 'p3',
        name: 'вперёд',
        value_type: 'link',
        config: { link_type_id: 'lt1' },
        types_source_count: 0,
        types_target_count: 0,
      }),
    ],
    [LINK_TYPE],
  );
}

describe('пикер свойств: исключение присутствующих строк (626b29bd)', () => {
  it('без предиката возвращается полный набор — прежнее поведение потребителей', () => {
    const rows = sampleRows();
    const out = excludePropertyListRows(rows);
    assert.equal(out.length, 4, 'два скаляра + две стороны связи');
    assert.deepEqual(out, rows, 'порядок и состав сохранены');
    assert.notEqual(out, rows, 'вход не отдаётся по ссылке');
  });

  it('исключённая строка отсутствует в выдаче', () => {
    const out = excludePropertyListRows(sampleRows(), (row) => row.id === 'p1');
    assert.equal(out.length, 3, 'скаляр Альфа исключён');
    assert.ok(!out.some((row) => row.id === 'p1'));
  });

  it('исключение по стороне: прямая сторона убрана, обратная осталась', () => {
    const out = excludePropertyListRows(sampleRows(), (row) => row.id === 'p3:source');
    assert.ok(!out.some((row) => row.id === 'p3:source'), 'прямая сторона исключена');
    assert.ok(out.some((row) => row.id === 'p3:target'), 'обратная сторона доступна');
    assert.equal(out.length, 3);
  });

  it('одна сторона исключена — вторая доступна в любом направлении (предикат потребителя)', () => {
    // Потребитель вкладки «Свойства» строит предикат из УЖЕ присутствующих
    // значений: `property_id:side`. Исключение одной стороны не должно
    // скрывать вторую — ни прямую, ни обратную.
    const present = new Set(['p3:target']);
    const withoutTarget = excludePropertyListRows(sampleRows(), (row) => present.has(row.id));
    assert.ok(!withoutTarget.some((row) => row.id === 'p3:target'), 'target исключён');
    assert.ok(withoutTarget.some((row) => row.id === 'p3:source'), 'source остаётся доступен');

    present.clear();
    present.add('p3:source');
    const withoutSource = excludePropertyListRows(sampleRows(), (row) => present.has(row.id));
    assert.ok(!withoutSource.some((row) => row.id === 'p3:source'), 'source исключён');
    assert.ok(withoutSource.some((row) => row.id === 'p3:target'), 'target остаётся доступен');
    assert.equal(withoutSource.length, 3);
  });

  it('одноимённые стороны симметричной связи исключаются независимо', () => {
    const rows = buildPropertyListRows(
      [
        registryRow({
          id: 'p-sym',
          name: 'см. также',
          value_type: 'link',
          config: { link_type_id: 'lt1' },
        }),
      ],
      [{ ...LINK_TYPE, name_forward: 'см. также', name_reverse: 'см. также' }],
    );
    const out = excludePropertyListRows(rows, (row) => row.id === 'p-sym:source');
    assert.equal(out.length, 1, 'вторая строка осталась, хотя имя то же');
    assert.equal(out[0]!.side, 'target');
  });
});
