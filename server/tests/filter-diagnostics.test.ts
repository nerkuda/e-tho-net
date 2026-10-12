/**
 * Тесты серверной диагностики отбора (задача e1676e91, требования 44d61c8a
 * «красная», 325efc13 «жёлтая», 0f34a5ff «статистика»; сущность 489c394f).
 *
 * Покрывают:
 *   * красное — удалённое свойство/тип/значение-мысль: запрет применения при
 *     исполнении (явный AST) и при сохранении/исполнении отбора типа, со
 *     снапшотом имени из `labels`;
 *   * жёлтое — свойство отвязано от типа: отбор исполняется, предупреждение
 *     приходит в результате (`warnings`), исполнение не блокируется;
 *   * статистика — собирается только по `collectStats`, несёт время и счётчики.
 *
 * Skip на отсутствии нативной сборки `better-sqlite3` — как прочие доменные тесты.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { EtnError, FILTER_AST_VERSION, type FilterAst } from '@etn/shared';

import type { NetworkDb } from '../src/db/network-db.js';
import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import {
  createNetworkProperty,
  createTypeProperty,
  deleteNetworkProperty,
  deleteTypeProperty,
} from '../src/domain/property-service.js';
import { createThoughtTypeView } from '../src/domain/thought-type-views-service.js';
import { runViewForThought } from '../src/domain/thought-type-views-service.js';
import {
  queryThoughts,
  type ThoughtQueryRequest as CanonicalQueryRequest,
} from '../src/domain/query-service.js';

const USER = 'user-1';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function seedThought(ndb: NetworkDb, typeId: string | null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, 'Мысль', 'мысль', ?, 1, 0, 0, 1,
               '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, typeId);
  return id;
}

/** AST из одного листа-условия. */
function astLeaf(
  entity: Record<string, unknown>,
  operator: string,
  value: unknown,
  labels?: { entity?: string; value?: string },
): FilterAst {
  const entityFull = labels === undefined ? entity : { ...entity };
  const filter: Record<string, unknown> = { entity: entityFull, operator };
  if (value !== undefined) filter['value'] = value;
  if (labels !== undefined) filter['labels'] = labels;
  return { version: FILTER_AST_VERSION, filter: filter as never };
}

function ast(definition: FilterAst): string {
  return JSON.stringify(definition);
}

function runQuery(ndb: NetworkDb, tree: FilterAst, extra: Record<string, unknown> = {}) {
  const req: CanonicalQueryRequest = {
    sort: 'alpha',
    order: 'asc',
    limit: 50,
    offset: 0,
    count: true,
    ast: tree,
  };
  return queryThoughts(ndb, USER, req, { emptyFilterMode: 'all', maxLimit: 200, ...extra });
}

describe(
  'диагностика отбора (задача e1676e91)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    describe('красное: удалённая сущность — запрет применения', () => {
      it('явление: удалённое свойство реестра — VALIDATION_ERROR со снапшотом имени (labels)', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const prop = createNetworkProperty(ndb, { name: 'Статус', value_type: 'text' }, USER);
          deleteNetworkProperty(ndb, prop.id);

          const tree = astLeaf(
            { kind: 'property', property_id: prop.id },
            'eq',
            'x',
            { entity: 'Статус' },
          );
          assert.throws(
            () => runQuery(ndb, tree),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal(err.code, 'VALIDATION_ERROR');
              const details = err.details as { reason?: string; diagnostics?: Array<{ code: string; label: string | null; severity: string }> };
              assert.equal(details.reason, 'filter_entity_deleted');
              assert.equal(details.diagnostics?.[0]?.code, 'entity_deleted');
              assert.equal(details.diagnostics?.[0]?.severity, 'error');
              assert.equal(details.diagnostics?.[0]?.label, 'Статус', 'снапшот имени из labels');
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });

      it('удалённый тип — красное', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tree = astLeaf({ kind: 'type' }, 'in', [randomUUID()]);
          assert.throws(
            () => runQuery(ndb, tree),
            (err: unknown) => err instanceof EtnError && err.code === 'VALIDATION_ERROR',
          );
        } finally {
          ndb.close();
        }
      });

      it('значение-мысль удалено — красное', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const prop = createNetworkProperty(
            ndb,
            { name: 'Ссылка', value_type: 'link', name_forward: 'Ссылается', name_reverse: 'Упоминается' },
            USER,
          );
          const tree = astLeaf(
            { kind: 'property', property_id: prop.id },
            'eq',
            randomUUID(),
            { entity: 'Ссылка', value: randomUUID() },
          );
          assert.throws(
            () => runQuery(ndb, tree),
            (err: unknown) => err instanceof EtnError && err.code === 'VALIDATION_ERROR',
          );
        } finally {
          ndb.close();
        }
      });

      it('сохранение отбора типа с AST на удалённое свойство — VALIDATION_ERROR', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tt = createThoughtType(ndb, { name: 'task' }, USER);
          const prop = createNetworkProperty(ndb, { name: 'Статус', value_type: 'text' }, USER);
          deleteNetworkProperty(ndb, prop.id);
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                tt.id,
                {
                  name: 'Битый',
                  definition: ast(astLeaf({ kind: 'property', property_id: prop.id }, 'eq', 'x', { entity: 'Статус' })),
                },
                USER,
              ),
            (err: unknown) => err instanceof EtnError && err.code === 'VALIDATION_ERROR',
          );
        } finally {
          ndb.close();
        }
      });

      it('исполнение отбора типа с AST на удалённое свойство — VALIDATION_ERROR', async () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tt = createThoughtType(ndb, { name: 'task' }, USER);
          const prop = createNetworkProperty(ndb, { name: 'Статус', value_type: 'text' }, USER);
          const view = createThoughtTypeView(
            ndb,
            tt.id,
            { name: 'Отбор', definition: ast(astLeaf({ kind: 'property', property_id: prop.id }, 'eq', 'x', { entity: 'Статус' })) },
            USER,
          );
          const thoughtId = seedThought(ndb, tt.id);
          // Свойство удаляется уже после сохранения отбора.
          deleteNetworkProperty(ndb, prop.id);
          await assert.rejects(
            () => runViewForThought(ndb, view, thoughtId, USER),
            (err: unknown) => err instanceof EtnError && err.code === 'VALIDATION_ERROR',
          );
        } finally {
          ndb.close();
        }
      });
    });

    describe('жёлтое: свойство отвязано от типа — исполняется с предупреждением', () => {
      it('отбор исполняется, предупреждение приходит в warnings', async () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tt = createThoughtType(ndb, { name: 'task' }, USER);
          const binding = createTypeProperty(
            ndb,
            'thought_type',
            tt.id,
            { key: 'Статус', value_type: 'text' },
            USER,
          );
          const thoughtId = seedThought(ndb, tt.id);
          const view = createThoughtTypeView(
            ndb,
            tt.id,
            {
              name: 'По статусу',
              definition: ast(
                astLeaf({ kind: 'property', property_id: binding.property_id }, 'eq', 'открыта', { entity: 'Статус' }),
              ),
            },
            USER,
          );
          // Свойство отвязано от типа, но осталось в реестре.
          deleteTypeProperty(ndb, binding.id, USER);

          const result = await runViewForThought(ndb, view, thoughtId, USER);
          assert.ok(result.warnings && result.warnings.length === 1, 'одно жёлтое предупреждение');
          assert.equal(result.warnings[0]!.code, 'property_detached');
          assert.equal(result.warnings[0]!.severity, 'warning');
          assert.equal(result.warnings[0]!.label, 'Статус');
          // Исполнение не заблокировано: страница получена (пустая — значений нет).
          assert.deepEqual(result.items, []);
        } finally {
          ndb.close();
        }
      });
    });

    describe('статистика исполнения (требование 0f34a5ff)', () => {
      it('без collectStats статистика не собирается', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tree = astLeaf({ kind: 'type' }, 'in', []);
          const res = runQuery(ndb, tree);
          assert.equal(res.stats, undefined);
        } finally {
          ndb.close();
        }
      });

      it('с collectStats несёт время и число условий', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tree = astLeaf({ kind: 'type' }, 'in', []);
          const res = runQuery(ndb, tree, { collectStats: true });
          assert.ok(res.stats, 'статистика собрана');
          assert.ok(res.stats!.duration_ms >= 0, 'время исполнения измерено');
          assert.equal(res.stats!.conditions, 1, 'одно условие');
          assert.ok(Array.isArray(res.stats!.limits_hit));
        } finally {
          ndb.close();
        }
      });
    });
  },
);
