/**
 * Тесты модели строк общего списка свойств (задача d4e23670, fd4d4927;
 * задача 6ebde54e — модель переехала в общий модуль `lib/property-list.ts`).
 *
 * Список свойств — единый компонент: сортировка (единый алфавит по
 * отображаемому имени), фильтр (каждое слово запроса в имени, любом имени пары
 * связи или описании) и сборка строк (скаляр — одна строка, свойство-связь —
 * две). Клиентские тесты идут без DOM (конвенция соседних тестов) — проверяется
 * чистая модель; рендер и режимы закреплены якорями исходника
 * (`property-list.test.ts`).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { LinkType } from '@etn/shared';

import {
  buildPropertyListRows,
  filterPropertyListRows,
  sortPropertyListRows,
  type PropertyRegistryRow,
} from '../src/renderer/lib/property-list.js';
import { store } from '../src/renderer/state.js';

/** Минимальная реестровая строка для табличных тестов. */
function row(
  id: string,
  name: string,
  description: string | null = null,
  overrides: Partial<PropertyRegistryRow> = {},
): PropertyRegistryRow {
  return {
    id,
    name,
    value_type: 'text',
    config: null,
    description,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    types_count: 0,
    values_count: 0,
    ...overrides,
  };
}

/** Минимальная строка каталога типов связей. */
function linkType(id: string, name_forward: string, name_reverse: string): LinkType {
  return {
    id,
    name_forward,
    name_reverse,
    parent_id: null,
    is_root: true,
    color: null,
    style: null,
    width: null,
    description: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    version: 1,
    created_by: 'u-test',
  };
}

afterEach(() => {
  store.update({ linkTypes: [] });
});

describe('buildPropertyListRows — скаляры и пары концов связи', () => {
  it('скаляр даёт одну строку со стороной null', () => {
    const rows = buildPropertyListRows([row('1', 'Приоритет')], []);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, 'Приоритет');
    assert.equal(rows[0]!.side, null);
    assert.equal(rows[0]!.linkNames, null);
    assert.equal(rows[0]!.typesCount, 0);
  });

  it('свойство-связь даёт две строки: имя источника и имя назначения', () => {
    const rows = buildPropertyListRows(
      [
        row('p1', 'место жительства', 'где живёт', {
          value_type: 'link',
          config: { link_type_id: 'lt-1' },
          types_source_count: 3,
          types_target_count: 5,
        }),
      ],
      [linkType('lt-1', 'место жительства', 'жители')],
    );
    assert.deepEqual(
      rows.map((r) => ({ name: r.name, side: r.side, id: r.id, count: r.typesCount })),
      [
        { name: 'место жительства', side: 'source', id: 'p1:source', count: 3 },
        { name: 'жители', side: 'target', id: 'p1:target', count: 5 },
      ],
    );
    // Обе строки — одна реестровая запись; для поиска несут оба имени.
    assert.equal(rows[0]!.propertyId, 'p1');
    assert.equal(rows[1]!.propertyId, 'p1');
    assert.deepEqual(rows[0]!.linkNames, { forward: 'место жительства', reverse: 'жители' });
  });

  it('тип связи ещё не в каталоге — одна строка (реестровое имя, source)', () => {
    const rows = buildPropertyListRows(
      [row('p1', 'место жительства', null, { value_type: 'link', config: { link_type_id: 'lt-x' } })],
      [],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, 'место жительства');
    assert.equal(rows[0]!.side, 'source');
    assert.equal(rows[0]!.linkNames, null);
  });

  it('структурная связь — одна системная строка', () => {
    const rows = buildPropertyListRows(
      [row('st', 'Родители', null, { value_type: 'link', config: { structural: true } })],
      [],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.structural, true);
    assert.equal(rows[0]!.side, null);
    assert.equal(rows[0]!.visual, null);
  });
});

describe('sortPropertyListRows', () => {
  it('единый алфавит по отображаемому имени: скаляры и концы связей вперемешку', () => {
    const rows = buildPropertyListRows(
      [
        row('a', 'Яблоко'),
        row('b', 'Арбуз'),
        row('c', 'ананас'),
        row('p', 'Брат', null, {
          value_type: 'link',
          config: { link_type_id: 'lt-1' },
        }),
      ],
      [linkType('lt-1', 'Брат', 'Сестра')],
    );
    const sorted = sortPropertyListRows(rows).map((r) => r.name);
    // ru locale: ананас → Арбуз → Брат → Сестра (конец связи) → Яблоко
    assert.deepEqual(sorted, ['ананас', 'Арбуз', 'Брат', 'Сестра', 'Яблоко']);
  });

  it('не мутирует входной массив (безопасность перерисовки)', () => {
    const rows = buildPropertyListRows([row('z', 'Zeta'), row('a', 'Alpha'), row('m', 'Mu')], []);
    const copy = [...rows];
    sortPropertyListRows(rows);
    assert.deepEqual(rows, copy);
  });
});

describe('filterPropertyListRows', () => {
  const sample = sortPropertyListRows(
    buildPropertyListRows(
      [
        row('1', 'Приоритет', 'важность задачи'),
        row('2', 'Исполнитель', 'ссылка на мысль человека'),
        row('3', 'Дедлайн', 'дата сдачи'),
        row('4', 'Тег', 'короткая метка'),
        row('5', 'Примечание', null),
        row('p', 'место жительства', 'адрес', {
          value_type: 'link',
          config: { link_type_id: 'lt-1' },
        }),
      ],
      [linkType('lt-1', 'место жительства', 'жители')],
    ),
  );

  it('пустой запрос оставляет все строки', () => {
    assert.equal(filterPropertyListRows(sample, '').length, sample.length);
    assert.equal(filterPropertyListRows(sample, '   ').length, sample.length);
  });

  it('каждое слово запроса ищется в имени ИЛИ описании (AND по словам)', () => {
    const hits = filterPropertyListRows(sample, 'приоритет важность');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.name, 'Приоритет');
  });

  it('регистронезависим (кириллица)', () => {
    assert.equal(filterPropertyListRows(sample, 'ПРИОРИТЕТ').length, 1);
  });

  it('находит по описанию, а не только по имени', () => {
    const hits = filterPropertyListRows(sample, 'человек');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.name, 'Исполнитель');
  });

  it('пустой результат при отсутствии совпадений', () => {
    assert.equal(filterPropertyListRows(sample, 'нет такого').length, 0);
  });

  it('находит оба конца связи по противоположному имени пары', () => {
    const hits = filterPropertyListRows(sample, 'жители');
    // Строка источника и строка назначения несут ОБА имени пары — находятся обе.
    assert.deepEqual(hits.map((r) => r.name).sort(), ['жители', 'место жительства']);
  });
});
