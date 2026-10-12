/**
 * Задача c13762b1 (этап 3 ТП «Ядро AST и операторы»): приём AST-тела в
 * `POST /thoughts/query` и компиляция старых плоских форм в AST.
 *
 * Проверяем:
 *   * плоская форма и её AST-компиляция дают одинаковый результат
 *     (требование 91983c20) — компилятор живёт в едином движке;
 *   * явное `ast`-тело исполняется (группы И/ИЛИ);
 *   * `ast` + плоские критерии одновременно — `VALIDATION_ERROR`;
 *   * неизвестное поле тела — `VALIDATION_ERROR` (контракт `.strict()`);
 *   * поддерево (`parent_ids`) применяется поверх AST-критериев
 *     (требование 3482a399);
 *   * календарный токен AST разрешается через `tokenContext`
 *     (обязательный пункт приёмки — первый день недели сети).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  compileThoughtQueryToAst,
  queryThoughts,
  type AstTokenContext,
  type ThoughtQueryRequest as CanonicalQueryRequest,
} from '../src/domain/query-service.js';
import { FILTER_AST_VERSION, typeNameKey } from '@etn/shared';

import { authHeaders, buildRestContext, closeRestContext, type RestTestContext } from './rest-helpers.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function seedThought(
  ndb: NetworkDb,
  title: string,
  opts: { type_id?: string; created_at?: string; created_by?: string } = {},
): string {
  const id = randomUUID();
  const author = opts.created_by ?? 'u';
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 0, 1, ?, ?, ?, ?)`,
    )
    .run(
      id,
      title,
      title.normalize('NFC').trim().toLowerCase(),
      opts.type_id ?? null,
      opts.created_at ?? '2024-01-01T00:00:00.000Z',
      author,
      opts.created_at ?? '2024-01-01T00:00:00.000Z',
      author,
    );
  return id;
}

function seedThoughtType(ndb: NetworkDb, name: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, name, name_key, version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, name, typeNameKey(name));
  return id;
}

function canon(over: Partial<CanonicalQueryRequest> = {}): CanonicalQueryRequest {
  return { sort: 'alpha', order: 'asc', limit: 100, offset: 0, ...over };
}

describe('filter AST: компиляция плоской формы (задача c13762b1)', { skip: !nativeAvailable() }, () => {
  it('плоская форма и её AST-компиляция дают одинаковый результат (91983c20)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const taskType = seedThoughtType(ndb, 'Задача');
      const errorType = seedThoughtType(ndb, 'Ошибка');
      seedThought(ndb, 'Задача старая', { type_id: taskType, created_at: '2024-01-01T00:00:00.000Z' });
      const fresh = seedThought(ndb, 'Задача свежая', { type_id: taskType, created_at: '2024-02-01T00:00:00.000Z' });
      seedThought(ndb, 'Ошибка свежая', { type_id: errorType, created_at: '2024-02-01T00:00:00.000Z' });

      const flat = canon({ type_ids: [taskType], created_after: '2024-01-15T00:00:00.000Z' });
      const viaFlat = queryThoughts(ndb, 'u', flat, { emptyFilterMode: 'all' });
      const ast = compileThoughtQueryToAst(ndb, flat);
      assert.ok(ast, 'компилятор обязан вернуть дерево для непустого фильтра');
      const viaAst = queryThoughts(ndb, 'u', canon({ ast }), { emptyFilterMode: 'all' });

      assert.deepEqual(
        viaAst.items.map((i) => i.id),
        viaFlat.items.map((i) => i.id),
        'AST-компиляция обязана совпасть с плоской формой',
      );
      assert.deepEqual(viaFlat.items.map((i) => i.id), [fresh]);
    } finally {
      ndb.close();
    }
  });

  it('явное AST-тело с группой И/ИЛИ исполняется единым движком', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const taskType = seedThoughtType(ndb, 'Задача');
      const errorType = seedThoughtType(ndb, 'Ошибка');
      seedThought(ndb, 'Задача', { type_id: taskType });
      seedThought(ndb, 'Ошибка', { type_id: errorType });
      seedThought(ndb, 'Прочее');

      const ast = {
        version: FILTER_AST_VERSION,
        filter: {
          op: 'or' as const,
          children: [
            { entity: { kind: 'type' as const }, operator: 'in' as const, value: [taskType] },
            { entity: { kind: 'type' as const }, operator: 'in' as const, value: [errorType] },
          ],
        },
      };
      const res = queryThoughts(ndb, 'u', canon({ ast }), { emptyFilterMode: 'all' });
      assert.deepEqual(res.items.map((i) => i.title).sort(), ['Задача', 'Ошибка']);
    } finally {
      ndb.close();
    }
  });

  it('поддерево (parent_ids) применяется поверх AST-критериев (3482a399)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const root = seedThought(ndb, 'Версия X');
      const child = seedThought(ndb, 'Работа 1');
      const outside = seedThought(ndb, 'Работа 2');
      ndb
        .prepare(
          `INSERT INTO links (id, source_id, target_id, type_id, active, version, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, NULL, 1, 1, '2024', '2024', 'u', 'u')`,
        )
        .run(randomUUID(), root, child);

      // Критерий AST «актуальна» (истина) + пред-сужение поддеревом [root].
      const ast = {
        version: FILTER_AST_VERSION,
        filter: { entity: { kind: 'active' as const }, operator: 'eq' as const, value: true },
      };
      const res = queryThoughts(
        ndb,
        'u',
        canon({
          ast,
          subtree: { roots: [root], include_roots: true, max_depth: 5, include_inactive_links: false },
        }),
        { emptyFilterMode: 'all' },
      );
      // Корень и потомок входят (требование 3482a399); внешняя мысль — нет.
      assert.deepEqual(res.items.map((i) => i.title).sort(), ['Версия X', 'Работа 1']);
      assert.ok(!res.items.some((i) => i.title === outside));
    } finally {
      ndb.close();
    }
  });

  it('календарный токен AST разрешается через tokenContext (первый день недели сети)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const inWeek = seedThought(ndb, 'На этой неделе', { created_at: '2024-01-09T10:00:00.000Z' });
      seedThought(ndb, 'Давно', { created_at: '2024-01-01T10:00:00.000Z' });

      const ast = {
        version: FILTER_AST_VERSION,
        filter: {
          entity: { kind: 'created_at' as const },
          operator: 'gte' as const,
          value: { token: '$weekStart' },
        },
      };
      // now = среда 2024-01-10, первый день недели — понедельник (1) → 2024-01-08.
      const ctx: AstTokenContext = {
        nowMs: Date.parse('2024-01-10T12:00:00.000Z'),
        userId: 'u',
        firstDayOfWeek: 1,
        withTime: true,
      };
      const res = queryThoughts(ndb, 'u', canon({ ast }), { emptyFilterMode: 'all', tokenContext: ctx });
      assert.deepEqual(res.items.map((i) => i.id), [inWeek]);
    } finally {
      ndb.close();
    }
  });
});

describe('POST /thoughts/query: AST-тело через REST (задача c13762b1)', { skip: !nativeAvailable() }, () => {
  async function post(
    ctx: RestTestContext,
    payload: Record<string, unknown>,
  ): Promise<{ statusCode: number; json: Record<string, unknown> }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/networks/${ctx.networkId}/thoughts/query`,
      headers: authHeaders(ctx),
      payload,
    });
    return { statusCode: res.statusCode, json: res.json() as Record<string, unknown> };
  }

  it('ast: фасадные parent_ids/link_filter совместимы, конфликт — только с критериями', async () => {
    const ctx = await buildRestContext();
    try {
      const root = seedThought(ctx.ndb, 'AST-корень');
      const child = seedThought(ctx.ndb, 'AST-потомок');
      const outside = seedThought(ctx.ndb, 'AST-вне-поддерева');
      ctx.ndb
        .prepare(
          `INSERT INTO links (id, source_id, target_id, type_id, active, version, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, NULL, 1, 1, '2024', '2024', 'u', 'u')`,
        )
        .run(randomUUID(), root, child);

      const ast = {
        version: FILTER_AST_VERSION,
        filter: { entity: { kind: 'trashed' as const }, operator: 'eq' as const, value: false },
      };
      const ok = await post(ctx, { ast, sort: 'alpha', order: 'asc', limit: 10, count: true });
      assert.equal(ok.statusCode, 200, JSON.stringify(ok.json));

      // ast + parent_ids: поддерево применяется поверх дерева, корни входят (3482a399).
      const withSubtree = await post(ctx, {
        ast,
        parent_ids: [root],
        sort: 'alpha',
        order: 'asc',
        limit: 20,
      });
      assert.equal(withSubtree.statusCode, 200, JSON.stringify(withSubtree.json));
      const ids = (withSubtree.json['data'] as Array<{ id: string }>).map((i) => i.id);
      assert.ok(ids.includes(root) && ids.includes(child), 'корень и потомок обязаны войти');
      assert.ok(!ids.includes(outside), 'мысль вне поддерева не входит');

      // ast + link_filter (без parent_ids) — совместимо, 200.
      const withLinkFilter = await post(ctx, {
        ast,
        link_filter: { include_structural: true },
        sort: 'alpha',
        order: 'asc',
      });
      assert.equal(withLinkFilter.statusCode, 200, JSON.stringify(withLinkFilter.json));

      // ast + parent_ids + плоский критерий — конфликт.
      const conflict = await post(ctx, {
        ast,
        parent_ids: [root],
        keywords: 'x',
        sort: 'alpha',
        order: 'asc',
      });
      assert.equal(conflict.statusCode, 422);
      assert.equal((conflict.json['error'] as { code: string }).code, 'VALIDATION_ERROR');

      const unknown = await post(ctx, { ast, bogus_field: 1, sort: 'alpha', order: 'asc' });
      assert.equal(unknown.statusCode, 422);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('веер: tokenContextFor разрешает токены по сети, unresolved агрегируется в ответе', async () => {
    const ctx = await buildRestContext();
    try {
      // Мысль от имени вызывающего — чтобы проверить разрешение `$user`.
      seedThought(ctx.ndb, 'REST-своя', { created_by: ctx.adminId });
      seedThought(ctx.ndb, 'REST-чужая', { created_by: 'u' });

      // `$user` разрешается контекстом сети (иначе created_by='' → 0 хитов).
      const ok = await post(ctx, {
        network_ids: [ctx.networkId],
        ast: {
          version: FILTER_AST_VERSION,
          filter: { entity: { kind: 'author' as const }, operator: 'eq' as const, value: { token: '$user' } },
        },
        sort: 'alpha',
        order: 'asc',
        limit: 10,
        count: true,
      });
      assert.equal(ok.statusCode, 200, JSON.stringify(ok.json));
      const okData = ok.json['data'] as {
        items: Array<{ title: string }>;
        unresolved?: unknown[];
      };
      const titles = okData.items.map((i) => i.title);
      assert.ok(titles.includes('REST-своя'), `$user обязан разрешиться: ${JSON.stringify(ok.json)}`);
      assert.ok(!titles.includes('REST-чужая'), 'мысль другого автора не входит');
      assert.equal(okData.unresolved, undefined);

      // Неразрешимый в сетевом отборе токен — агрегирован по сетям, не молчание.
      const bad = await post(ctx, {
        network_ids: [ctx.networkId],
        ast: {
          version: FILTER_AST_VERSION,
          filter: {
            entity: { kind: 'created_at' as const },
            operator: 'gte' as const,
            value: { token: '$thought.id' },
          },
        },
        sort: 'alpha',
        order: 'asc',
        limit: 10,
      });
      assert.equal(bad.statusCode, 200, JSON.stringify(bad.json));
      const badData = bad.json['data'] as {
        items: unknown[];
        unresolved?: Array<{ network_id: string; token: string; reason: string }>;
      };
      assert.deepEqual(badData.items, []);
      assert.equal(badData.unresolved?.length, 1, JSON.stringify(bad.json));
      assert.equal(badData.unresolved?.[0]?.network_id, ctx.networkId);
      assert.match(badData.unresolved?.[0]?.token ?? '', /\$thought/);
    } finally {
      await closeRestContext(ctx);
    }
  });
});
