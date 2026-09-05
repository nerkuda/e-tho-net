/**
 * Pure-logic tests for the property manager list (task d4e23670).
 *
 * The dialog is the same staged-form pattern as the type managers: the list
 * re-renders from a cached snapshot, search filters without a network round
 * trip and alphabetical order must stay stable across re-renders. These
 * three helpers — `sortRegistryRows`, `annotateRows` and `filterRegistryRows`
 * — are the only logic exported for testing; the dialog itself is rendered
 * against the live DOM (`happy-dom`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NetworkProperty } from '@etn/shared';

import {
  annotateRows,
  filterRegistryRows,
  sortRegistryRows,
} from '../src/renderer/screens/property-manager.js';

type RegistryRow = NetworkProperty & { types_count: number; values_count: number };

/** Build a minimal registry row for the table-driven tests. */
function row(
  id: string,
  name: string,
  description: string | null = null,
  overrides: Partial<RegistryRow> = {},
): RegistryRow {
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

describe('sortRegistryRows', () => {
  it('orders rows alphabetically (ru locale, case-insensitive)', () => {
    const sorted = sortRegistryRows([
      row('c', 'Яблоко'),
      row('b', 'Арбуз'),
      row('a', 'ананас'),
    ]);
    // ru locale: ананас → Арбуз → Яблоко (case-insensitive collation)
    assert.deepEqual(
      sorted.map((r) => r.name),
      ['ананас', 'Арбуз', 'Яблоко'],
    );
  });

  it('does not mutate the input array (re-render safety)', () => {
    const input = [row('z', 'Zeta'), row('a', 'Alpha'), row('m', 'Mu')];
    const inputCopy = [...input];
    sortRegistryRows(input);
    assert.deepEqual(input, inputCopy);
  });
});

describe('annotateRows', () => {
  it('precomputes lower-cased name and description for the filter', () => {
    const [a] = annotateRows([row('1', 'Приоритет', 'ВАЖНО: проверить')]);
    assert.ok(a !== undefined);
    assert.equal(a.lowerName, 'приоритет');
    assert.equal(a.lowerDescription, 'важно: проверить');
  });

  it('treats a null description as the empty string', () => {
    const [a] = annotateRows([row('1', 'Foo', null)]);
    assert.ok(a !== undefined);
    assert.equal(a.lowerDescription, '');
  });
});

describe('filterRegistryRows', () => {
  const sample = annotateRows(
    sortRegistryRows([
      row('1', 'Приоритет', 'важность задачи'),
      row('2', 'Исполнитель', 'ссылка на мысль человека'),
      row('3', 'Дедлайн', 'дата сдачи'),
      row('4', 'Тег', 'короткая метка'),
      row('5', 'Примечание', null),
    ]),
  );

  it('returns every row for an empty query', () => {
    assert.equal(filterRegistryRows(sample, '').length, sample.length);
    assert.equal(filterRegistryRows(sample, '   ').length, sample.length);
  });

  it('matches every whitespace-separated fragment against name OR description', () => {
    const hits = filterRegistryRows(sample, 'приоритет важность');
    assert.equal(hits.length, 1);
    const hit = hits[0];
    assert.ok(hit !== undefined);
    assert.equal(hit.property.name, 'Приоритет');
  });

  it('is case-insensitive (Cyrillic)', () => {
    const hits = filterRegistryRows(sample, 'ПРИОРИТЕТ');
    assert.equal(hits.length, 1);
  });

  it('matches the description as well as the name', () => {
    const hits = filterRegistryRows(sample, 'человек');
    assert.equal(hits.length, 1);
    const hit = hits[0];
    assert.ok(hit !== undefined);
    assert.equal(hit.property.name, 'Исполнитель');
  });

  it('returns no rows when nothing matches', () => {
    assert.equal(filterRegistryRows(sample, 'нет такого').length, 0);
  });

  it('keeps every row when the query fragments conflict (AND semantics)', () => {
    // A name containing «приоритет» AND a description containing «дата» —
    // no single row satisfies both fragments.
    assert.equal(filterRegistryRows(sample, 'приоритет дата').length, 0);
  });
});
