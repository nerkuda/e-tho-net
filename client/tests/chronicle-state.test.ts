/**
 * Unit tests for the chronicle view's pure state helpers (L20): the filter
 * criteria serialization and the persisted L4-state parser. Pure Node, no DOM.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildChronicleWire as toDefinition,
  defaultChronicleCriteriaState as defaultFilter,
  parseChronicleCriteria as fromDefinition,
  type ChronicleCriteriaState as ChronicleFilterState,
} from '../src/renderer/lib/filter-builder.js';
import { parseChronicleState } from '../src/renderer/screens/chronicle/state.js';

const DEFAULT_FILTER = defaultFilter();

describe('toDefinition / fromDefinition', () => {
  it('round-trips a full filter', () => {
    // Общая модель конструктора: критерии записи на верхнем уровне, критерии
    // целей — во вложенной `targets` (0.10.1, требование 306f74cc).
    const base = defaultFilter();
    const state: ChronicleFilterState = {
      ...base,
      keywords: 'счет* -вод*',
      keywordInComment: false,
      dateFrom: '2024-01-01',
      dateTo: '2024-12-31',
      authorOp: 'eq',
      authorId: 'u1',
      authorIds: [],
      editorOp: 'eq',
      editorId: 'u2',
      editorIds: [],
      order: 'desc',
      targets: { ...base.targets, typeIds: ['t1'], linkTypeIds: ['l1'], parentIds: ['p1'] },
    };
    const definition = toDefinition(state);
    assert.equal(definition.keywords, 'счет* -вод*');
    assert.deepEqual(definition.keyword_scope, ['title', 'synonyms']);
    assert.deepEqual(definition.targets?.type_ids, ['t1']);
    assert.deepEqual(definition.targets?.link_type_ids, ['l1']);
    assert.deepEqual(definition.targets?.parent_ids, ['p1']);
    assert.equal(definition.date_from, '2024-01-01');
    assert.equal(definition.date_to, '2024-12-31');
    assert.equal(definition.created_by, 'u1');
    assert.equal(definition.updated_by, 'u2');
    assert.equal(definition.order, 'desc');
    assert.deepEqual(fromDefinition(definition), state);
  });

  it('round-trips the target criteria group (0.10.1, 306f74cc)', () => {
    const base = defaultFilter();
    const state: ChronicleFilterState = {
      ...base,
      targets: { ...base.targets, keywords: 'цель', typeIds: ['t9'] },
    };
    const definition = toDefinition(state);
    assert.equal(definition.targets?.keywords, 'цель');
    assert.deepEqual(definition.targets?.type_ids, ['t9']);
    assert.deepEqual(fromDefinition(definition).targets, state.targets);
  });

  it('omits empty criteria and defaults to asc', () => {
    const definition = toDefinition(DEFAULT_FILTER);
    assert.equal(definition.keywords, undefined);
    assert.equal(definition.targets, undefined);
    assert.equal(definition.link_scope, undefined);
    assert.equal(definition.created_by, undefined);
    assert.equal(definition.updated_by, undefined);
    assert.equal(definition.order, 'asc');
    const back = fromDefinition(definition);
    assert.deepEqual(back, DEFAULT_FILTER);
  });

  it('parses partial definitions with safe defaults', () => {
    assert.deepEqual(fromDefinition({}), DEFAULT_FILTER);
    // Поля прежних версий (`link_scope`) молча пропускаются.
    assert.deepEqual(fromDefinition({ order: 'desc', link_scope: 'targets' }), {
      ...DEFAULT_FILTER,
      order: 'desc',
    });
  });

  it('reads created_by/updated_by back into authorId/editorId', () => {
    assert.deepEqual(
      fromDefinition({ created_by: 'u1', updated_by: 'u2' }),
      { ...DEFAULT_FILTER, authorId: 'u1', editorId: 'u2' },
    );
  });
});

describe('parseChronicleState', () => {
  it('parses a full persisted state', () => {
    const parsed = parseChronicleState(
      JSON.stringify({
        filter: { keywords: 'x', order: 'desc' },
        month: { year: 2026, month: 9 },
        savedFilterId: 'f1',
      }),
    );
    assert.equal(parsed.filter.keywords, 'x');
    assert.equal(parsed.filter.order, 'desc');
    assert.deepEqual(parsed.month, { year: 2026, month: 9 });
    assert.equal(parsed.savedFilterId, 'f1');
  });

  it('оставляет вложенный AST-снимок панели и снимает служебный лист (ad063c2f, L4)', () => {
    // Собственная форма панели: `{ ast, order }`. Плоский конвертер её не
    // понимает и терял дерево; state.ts обязан читать вложенный ast.
    const propertyId = '00000000-0000-4000-8000-0000000000bb';
    const parsed = parseChronicleState(
      JSON.stringify({
        filter: {
          order: 'desc',
          ast: {
            version: 1,
            filter: {
              op: 'and',
              children: [
                {
                  entity: { kind: 'targets' },
                  operator: 'in',
                  value: {
                    query: {
                      op: 'and',
                      children: [
                        {
                          entity: { kind: 'property', property: propertyId },
                          operator: 'eq',
                          value: '2.0',
                        },
                      ],
                    },
                    operator: 'in',
                  },
                },
                // Служебный дефолт места применения — не условие пользователя.
                { entity: { kind: 'trashed' }, operator: 'eq', value: false, service: true },
              ],
            },
          },
        },
      }),
    );
    const filter = parsed.filter as unknown as Record<string, unknown>;
    assert.equal(filter['order'], 'desc', 'направление ленты сохранено');
    const ast = filter['ast'] as Record<string, unknown>;
    assert.equal(ast['version'], 1, 'AST-форма не заменена плоской');
    const wire = JSON.stringify(ast);
    assert.equal(wire.includes(propertyId), true, 'условие по свойству сохранено');
    assert.equal(wire.includes('"service":true'), false, 'служебный лист снят');
  });

  it('falls back to empty on garbage or missing fields', () => {
    const garbage = parseChronicleState('not-json{');
    assert.equal(garbage.month, null);
    assert.equal(garbage.savedFilterId, null);
    assert.equal(garbage.filter.order, 'asc');

    const partial = parseChronicleState(JSON.stringify({ savedFilterId: null }));
    assert.equal(partial.month, null, 'без сохранённого месяца — null');

    const badMonth = parseChronicleState(JSON.stringify({ month: { year: 2026, month: 13 } }));
    assert.equal(badMonth.month, null, 'некорректный номер месяца отбрасывается');
  });
});
