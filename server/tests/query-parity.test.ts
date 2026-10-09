/**
 * Паритет выборки мыслей REST ↔ MCP (задача c5265deb, веха 7 версии 0.8.2).
 *
 * `POST /thoughts/query` (03-server-api.md §6.10) и `etn.thoughts.query`
 * (05-mcp-server.md §4.1) — фасады над одной доменной функцией
 * `queryThoughts` (`query-service.ts`, ADR 8c93f03a). Тест прогоняет
 * одинаковые наборы фильтров через обе точки входа на одной сети и сверяет:
 *
 *   * `total` — полное число совпадений;
 *   * набор и порядок id страницы (`data[]` REST ↔ `hits[]` MCP);
 *   * `etn.views.run` — исполняет сохранённую сортировку отбора SQL-движком
 *     (контракт как у REST `POST /thoughts/{id}/views/{view}/run`, ошибка
 *     4dd14aa3), а не JS-пересортировкой по названию.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  toolJson,
  toolText,
  type McpClientHandle,
  type McpTestContext,
} from './mcp-helpers.js';
import { openNetworkDb } from '../src/db/network-db.js';

/** Insert a thought directly via SQL — тестам нужны точные даты и авторы. */
function insertThought(
  ndb: ReturnType<typeof openNetworkDb>,
  title: string,
  opts: {
    type_id?: string | null;
    active?: number;
    created_at?: string;
    updated_at?: string;
    created_by?: string;
  } = {},
): string {
  const id = randomUUID();
  const now = opts.created_at ?? '2024-01-01T00:00:00.000Z';
  const upd = opts.updated_at ?? now;
  const author = opts.created_by ?? 'u-admin';
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, icon, icon_kind,
                             icon_attachment_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, updated_at,
                             created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, NULL, 'emoji', NULL, ?, 0, 0,
               0, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ndb.layerId,
      title,
      title.toLowerCase(),
      opts.type_id ?? null,
      opts.active ?? 1,
      now,
      upd,
      author,
      author,
      Date.now(),
      Date.now(),
    );
  return id;
}

/** Insert a directed link source → target. */
function insertLink(
  ndb: ReturnType<typeof openNetworkDb>,
  sourceId: string,
  targetId: string,
): void {
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, NULL, 1, 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'u', 'u')`,
    )
    .run(randomUUID(), sourceId, targetId);
}

/** Insert a synonym row. */
function insertSynonym(ndb: ReturnType<typeof openNetworkDb>, thoughtId: string, synonym: string): void {
  ndb
    .prepare('INSERT INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)')
    .run(thoughtId, synonym, synonym.toLowerCase());
}

/** Insert a property value row on a thought. */
function insertPropertyValue(
  ndb: ReturnType<typeof openNetworkDb>,
  thoughtId: string,
  propertyId: string,
  column: 'value_text' | 'value_number',
  value: string | number,
): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, ${column}, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024-01-01T00:00:00.000Z')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

/** Прогнать REST `POST /thoughts/query` и вернуть `{ ids, total }`. */
async function restQuery(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<{ ids: string[]; total: number }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/query`,
    headers: authHeaders(ctx),
    // `count: true` — паритет сверяет полные числа, а не null (5adebf61).
    payload: { count: true, ...payload },
  });
  assert.equal(res.statusCode, 200, `REST query: ${res.statusCode} ${res.body}`);
  const json = res.json() as {
    data: Array<{ id: string }>;
    meta: { total: number };
  };
  return { ids: json.data.map((t) => t.id), total: json.meta.total };
}

/** Прогнать MCP `etn.thoughts.query` и вернуть `{ ids, total, hits }`. */
async function mcpQuery(
  handle: McpClientHandle,
  networkId: string,
  args: Record<string, unknown>,
): Promise<{ ids: string[]; total: number; hits: Array<{ id: string; depth: number | null }> }> {
  const result = await handle.client.callTool({
    name: 'etn.thoughts.query',
    // `count: true` — см. `restQuery`.
    arguments: { network_id: networkId, count: true, ...args },
  });
  assert.equal(result.isError, undefined, `MCP query: ${toolText(result)}`);
  const data = toolJson<{
    total: number;
    hits: Array<{ id: string; depth: number | null }>;
  }>(result);
  return { ids: data.hits.map((h) => h.id), total: data.total, hits: data.hits };
}

/** Сверить REST и MCP: одинаковый total и одинаковый порядок id страницы. */
function assertParity(
  rest: { ids: string[]; total: number },
  mcp: { ids: string[]; total: number },
  label: string,
): void {
  assert.equal(mcp.total, rest.total, `total ${label}: REST и MCP должны совпадать`);
  assert.deepEqual(mcp.ids, rest.ids, `порядок id ${label}: REST и MCP должны совпадать`);
}

describe(
  'выборка мыслей: паритет REST /thoughts/query и MCP etn.thoughts.query',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('одинаковые фильтры дают одинаковые total и порядок id (имена, типы, свойства, keywords, даты, сортировки, авторы, поддерево, пагинация)', async () => {
      const restCtx = await buildRestContext();
      const overrides = {
        dataDir: restCtx.dataDir,
        systemDb: restCtx.sys,
        networkId: restCtx.networkId,
      };
      let mcpCtx: McpTestContext | undefined;
      let handle: McpClientHandle | undefined;
      try {
        // Тип мысли и свойства — через REST, чтобы адресовать их обоими
        // способами: id (REST) и имя (MCP).
        const typeRes = await restCtx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${restCtx.networkId}/thought-types`,
          headers: authHeaders(restCtx),
          payload: { name: 'задача' },
        });
        assert.equal(typeRes.statusCode, 201);
        const taskTypeId = (typeRes.json().data as { id: string }).id;

        const statusRes = await restCtx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${restCtx.networkId}/properties`,
          headers: authHeaders(restCtx),
          payload: { name: 'Статус', value_type: 'text' },
        });
        assert.equal(statusRes.statusCode, 201);
        const statusPropId = (statusRes.json().data as { id: string }).id;

        const priorityRes = await restCtx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${restCtx.networkId}/properties`,
          headers: authHeaders(restCtx),
          payload: { name: 'Приоритет', value_type: 'number' },
        });
        assert.equal(priorityRes.statusCode, 201);
        const priorityPropId = (priorityRes.json().data as { id: string }).id;

        const ndb = openNetworkDb(restCtx.dataDir, restCtx.networkId);
        // Фикстура: задачи с синонимом, свойствами, разными датами и активностью.
        const root = insertThought(ndb, 'Работы версии', { created_at: '2024-01-01T00:00:00.000Z' });
        const t1 = insertThought(ndb, 'План работ', {
          type_id: taskTypeId,
          created_at: '2024-01-05T00:00:00.000Z',
          updated_at: '2024-01-06T00:00:00.000Z',
        });
        const t2 = insertThought(ndb, 'План отдыха', {
          type_id: taskTypeId,
          active: 0,
          created_at: '2024-02-05T00:00:00.000Z',
          updated_at: '2024-02-06T00:00:00.000Z',
        });
        insertThought(ndb, 'Смета', {
          created_at: '2024-03-05T00:00:00.000Z',
          created_by: 'u-other',
        });
        insertSynonym(ndb, t1, 'roadmap');
        insertPropertyValue(ndb, t1, statusPropId, 'value_text', 'согласовано');
        insertPropertyValue(ndb, t2, statusPropId, 'value_text', 'черновик');
        insertPropertyValue(ndb, t1, priorityPropId, 'value_number', 3);
        insertPropertyValue(ndb, t2, priorityPropId, 'value_number', 8);
        insertLink(ndb, root, t1);
        insertLink(ndb, t1, t2);

        mcpCtx = await buildMcpContext(overrides);
        handle = await connectMcpClient(mcpCtx, restCtx.adminKey);
        const networkId = restCtx.networkId;

        const SORT_ALPHA = { sort: 'alpha', order: 'asc' } as const;
        const steps: Array<{
          label: string;
          rest: Record<string, unknown>;
          mcp: Record<string, unknown>;
        }> = [
          // keywords — мини-синтаксис §6.10 (титул + синонимы).
          {
            label: 'keywords «план*»',
            rest: { keywords: 'план*', ...SORT_ALPHA },
            mcp: { keywords: 'план*', sort: 'title', order: 'asc' },
          },
          {
            label: 'keywords по синониму «roadmap»',
            rest: { keywords: 'roadmap', ...SORT_ALPHA },
            mcp: { keywords: 'roadmap', sort: 'title', order: 'asc' },
          },
          // типы — id (REST) ↔ имя (MCP), L21-поддерево.
          {
            label: 'тип «задача» (REST id ↔ MCP имя)',
            rest: { type_ids: [taskTypeId], ...SORT_ALPHA },
            mcp: { type: ['задача'], sort: 'title', order: 'asc' },
          },
          // свойства — registry id (REST) ↔ имя (MCP).
          {
            label: 'свойство Статус eq (REST id ↔ MCP имя)',
            rest: {
              properties: [{ property_id: statusPropId, op: 'eq', value: 'согласовано' }],
              ...SORT_ALPHA,
            },
            mcp: {
              properties: [{ property: 'Статус', operator: 'eq', value: 'согласовано' }],
              sort: 'title',
              order: 'asc',
            },
          },
          {
            label: 'свойство Статус contains',
            rest: {
              properties: [{ property_id: statusPropId, op: 'contains', value: 'соглас' }],
              ...SORT_ALPHA,
            },
            mcp: {
              properties: [{ property: 'Статус', operator: 'contains', value: 'соглас' }],
              sort: 'title',
              order: 'asc',
            },
          },
          {
            label: 'свойство Приоритет gt',
            rest: {
              properties: [{ property_id: priorityPropId, op: 'gt', value: 5 }],
              ...SORT_ALPHA,
            },
            mcp: {
              properties: [{ property: 'Приоритет', operator: 'gt', value: 5 }],
              sort: 'title',
              order: 'asc',
            },
          },
          {
            label: 'свойство Приоритет gte',
            rest: {
              properties: [{ property_id: priorityPropId, op: 'gt', value: 5 }],
              ...SORT_ALPHA,
            },
            mcp: {
              properties: [{ property: 'Приоритет', operator: 'gte', value: 8 }],
              sort: 'title',
              order: 'asc',
            },
          },
          // диапазоны дат — ISO-8601, границы включающие.
          {
            label: 'created_after',
            rest: { created_after: '2024-02-01T00:00:00.000Z', ...SORT_ALPHA },
            mcp: { created_after: '2024-02-01T00:00:00.000Z', sort: 'title', order: 'asc' },
          },
          {
            label: 'created_before',
            rest: { created_before: '2024-02-01T00:00:00.000Z', ...SORT_ALPHA },
            mcp: { created_before: '2024-02-01T00:00:00.000Z', sort: 'title', order: 'asc' },
          },
          {
            label: 'updated_after',
            rest: { updated_after: '2024-02-06T00:00:00.000Z', ...SORT_ALPHA },
            mcp: { updated_after: '2024-02-06T00:00:00.000Z', sort: 'title', order: 'asc' },
          },
          // сортировки — alpha/title, created, updated; asc/desc.
          {
            label: 'сортировка alpha desc',
            rest: { keywords: 'план*', sort: 'alpha', order: 'desc' },
            mcp: { keywords: 'план*', sort: 'title', order: 'desc' },
          },
          {
            label: 'сортировка created asc',
            rest: { keywords: 'план*', sort: 'created', order: 'asc' },
            mcp: { keywords: 'план*', sort: 'created_at', order: 'asc' },
          },
          {
            label: 'сортировка updated desc',
            rest: { keywords: 'план*', sort: 'updated', order: 'desc' },
            mcp: { keywords: 'план*', sort: 'updated_at', order: 'desc' },
          },
          // актуальность — REST boolean ↔ MCP three-state.
          {
            label: 'active false',
            rest: { active: false, ...SORT_ALPHA },
            mcp: { active: 'false', sort: 'title', order: 'asc' },
          },
          {
            label: 'active true',
            rest: { active: true, ...SORT_ALPHA },
            mcp: { active: 'true', sort: 'title', order: 'asc' },
          },
          // авторы — REST created_by ↔ MCP author_id.
          {
            label: 'автор u-other (created_by ↔ author_id)',
            rest: { created_by: 'u-other', ...SORT_ALPHA },
            mcp: { author_id: 'u-other', sort: 'title', order: 'asc' },
          },
          // пагинация.
          {
            label: 'пагинация limit 2 offset 1',
            rest: { keywords: 'план*', sort: 'alpha', order: 'asc', limit: 2, offset: 1 },
            mcp: { keywords: 'план*', sort: 'title', order: 'asc', limit: 2, offset: 1 },
          },
        ];

        for (const step of steps) {
          const rest = await restQuery(restCtx, step.rest);
          const mcp = await mcpQuery(handle!, networkId, step.mcp);
          assertParity(rest, mcp, step.label);
        }

        // Поддерево: REST parent_ids и MCP in_subtree_of включают корень
        // (ошибка ad1551ea, 0.12.1 — семантика выровнена) — наборы совпадают,
        // depth считает расстояние. Оба идут только по активным связям.
        // Неактивная t2 в дефолтную выдачу не входит (active 'true' у обоих).
        const restSub = await restQuery(restCtx, { parent_ids: [root], ...SORT_ALPHA });
        const mcpSub = await mcpQuery(handle!, networkId, {
          in_subtree_of: root,
          max_depth: 20,
          sort: 'title',
          order: 'asc',
        });
        assert.deepEqual(
          [...restSub.ids].sort(),
          [...mcpSub.hits.map((h) => h.id)].sort(),
          'REST parent_ids = MCP in_subtree_of (корень входит)',
        );
        const depthById = new Map(
          mcpSub.hits.map((h) => [h.id, h.depth] as const),
        );
        assert.equal(depthById.get(root), 0);
        assert.equal(depthById.get(t1), 1);
        assert.equal(depthById.has(t2), false, 'неактивная мысль не входит в дефолтную выдачу');

        // Полная глубина — с active: any (REST show_inactive ↔ MCP 'any'):
        // оба фасада видят корень и неактивную t2 на глубине 2.
        const restSubAny = await restQuery(restCtx, {
          parent_ids: [root],
          show_inactive: true,
          ...SORT_ALPHA,
        });
        const mcpSubAny = await mcpQuery(handle!, networkId, {
          in_subtree_of: root,
          max_depth: 20,
          active: 'any',
          sort: 'title',
          order: 'asc',
        });
        assert.deepEqual(
          [...restSubAny.ids].sort(),
          [...mcpSubAny.hits.map((h) => h.id)].sort(),
          'REST parent_ids + show_inactive = MCP in_subtree_of active any',
        );
        const depthAny = new Map(
          mcpSubAny.hits.map((h) => [h.id, h.depth] as const),
        );
        assert.equal(depthAny.get(root), 0);
        assert.equal(depthAny.get(t1), 1);
        assert.equal(depthAny.get(t2), 2);
      } finally {
        if (handle !== undefined) await handle.close();
        if (mcpCtx !== undefined) await closeMcpContext(mcpCtx, overrides);
        await closeRestContext(restCtx);
      }
    });

    it('etn.views.run исполняет сохранённую сортировку отбора SQL-движком (контракт REST, ошибка 4dd14aa3)', async () => {
      const restCtx = await buildRestContext();
      const overrides = {
        dataDir: restCtx.dataDir,
        systemDb: restCtx.sys,
        networkId: restCtx.networkId,
      };
      let mcpCtx: McpTestContext | undefined;
      let handle: McpClientHandle | undefined;
      try {
        const typeRes = await restCtx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${restCtx.networkId}/thought-types`,
          headers: authHeaders(restCtx),
          payload: { name: 'версия' },
        });
        assert.equal(typeRes.statusCode, 201);
        const versionTypeId = (typeRes.json().data as { id: string }).id;

        const ndb = openNetworkDb(restCtx.dataDir, restCtx.networkId);
        const version = insertThought(ndb, '0.8.2', {
          type_id: versionTypeId,
          created_at: '2024-01-01T00:00:00.000Z',
        });
        const early = insertThought(ndb, 'Ранняя работа', {
          type_id: versionTypeId,
          created_at: '2024-01-05T00:00:00.000Z',
        });
        const late = insertThought(ndb, 'Поздняя работа', {
          type_id: versionTypeId,
          created_at: '2024-02-05T00:00:00.000Z',
        });

        // Отбор: работы того же типа, сортировка created desc — сохранена в
        // определении (клиент кладёт sort/order в definition всегда).
        const viewRes = await restCtx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${restCtx.networkId}/thought-types/${versionTypeId}/views`,
          headers: authHeaders(restCtx),
          payload: {
            name: 'Работы версии',
            definition: JSON.stringify({
              type_ids: [versionTypeId],
              sort: 'created',
              order: 'desc',
            }),
            is_default: true,
          },
        });
        assert.equal(viewRes.statusCode, 201, `create view: ${viewRes.body}`);

        mcpCtx = await buildMcpContext(overrides);
        handle = await connectMcpClient(mcpCtx, restCtx.adminKey);

        // MCP: страница отсортирована движком по created desc — никакой
        // JS-пересортировки по названию (задача c5265deb).
        const runRes = await handle.client.callTool({
          name: 'etn.views.run',
          arguments: {
            network_id: restCtx.networkId,
            thought_id: version,
            view_name: 'Работы версии',
          },
        });
        assert.equal(runRes.isError, undefined, toolText(runRes));
        const run = toolJson<{
          data: Array<{ id: string; title: string }>;
          meta: { total: number; sort: string; order: string };
        }>(runRes);
        // Контекстная мысль исключается из результата отбора (контракт
        // runViewForThought «отбор относительно мысли показывает соседей») —
        // страница отсортирована движком по created desc, никакой
        // JS-пересортировки по названию (задача c5265deb).
        assert.deepEqual(
          run.data.map((t) => t.id),
          [late, early],
          'created desc: самая свежая первая (SQL-движок, не пересортировка по названию)',
        );
        assert.equal(run.meta.sort, 'created');
        assert.equal(run.meta.order, 'desc');
        assert.equal(run.meta.total, 2);

        // REST run того же отбора — тот же порядок (паритет контрактов).
        const restRun = await restCtx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${restCtx.networkId}/thoughts/${version}/views/${encodeURIComponent('Работы версии')}/run`,
          headers: authHeaders(restCtx),
          payload: {},
        });
        assert.equal(restRun.statusCode, 200, `REST run view: ${restRun.body}`);
        const restRunJson = restRun.json() as {
          data: Array<{ id: string }>;
          meta: { sort: string; order: string };
        };
        assert.deepEqual(
          restRunJson.data.map((t) => t.id),
          [late, early],
          'REST и MCP исполняют сохранённую сортировку отбора одинаково',
        );
        assert.equal(restRunJson.meta.sort, 'created');
        assert.equal(restRunJson.meta.order, 'desc');
      } finally {
        if (handle !== undefined) await handle.close();
        if (mcpCtx !== undefined) await closeMcpContext(mcpCtx, overrides);
        await closeRestContext(restCtx);
      }
    });

    it('счётчик только по флагу, keyset-курсор страниц и FTS-keywords — сквозным сценарием REST ↔ MCP (этап 4)', async () => {
      const restCtx = await buildRestContext();
      const overrides = {
        dataDir: restCtx.dataDir,
        systemDb: restCtx.sys,
        networkId: restCtx.networkId,
      };
      let mcpCtx: McpTestContext | undefined;
      let handle: McpClientHandle | undefined;
      try {
        const ndb = openNetworkDb(restCtx.dataDir, restCtx.networkId);
        // Пять мыслей с одинаковыми ключами сортировки: порядок держит только
        // уникальный добор `id` (ADR 5f6cb775).
        const ids = ['Смета A', 'Смета B', 'Смета C', 'Смета D', 'Смета E'].map((title) =>
          insertThought(ndb, title, { created_at: '2024-03-01T00:00:00.000Z' }),
        );
        insertThought(ndb, 'Прочее', { created_at: '2024-03-01T00:00:00.000Z' });

        const queryUrl = `/api/v1/networks/${restCtx.networkId}/thoughts/query`;
        const post = async (payload: Record<string, unknown>) => {
          const res = await restCtx.app.inject({
            method: 'POST',
            url: queryUrl,
            headers: authHeaders(restCtx),
            payload,
          });
          assert.equal(res.statusCode, 200, `REST query: ${res.statusCode} ${res.body}`);
          return res.json() as {
            data: Array<{ id: string }>;
            meta: { total: number | null; has_more?: boolean; next_cursor?: string | null };
          };
        };

        // Без флага COUNT не считается — хвост сообщает has_more + курсор
        // (требование 5adebf61), курсор есть только когда есть продолжение.
        const plain = await post({ keywords: 'Смета', sort: 'created', order: 'asc', limit: 2, offset: 0 });
        assert.equal(plain.meta.total, null);
        assert.equal(plain.meta.has_more, true);
        assert.equal(typeof plain.meta.next_cursor, 'string');

        // С флагом — точное число.
        const counted = await post({
          keywords: 'Смета',
          sort: 'created',
          order: 'asc',
          limit: 2,
          offset: 0,
          count: true,
        });
        assert.equal(counted.meta.total, 5);
        assert.equal(counted.meta.has_more, true);

        // Обход keyset-курсором: каждая строка ровно один раз, порядок совпадает
        // со сплошной страницей.
        const full = await post({ keywords: 'Смета', sort: 'created', order: 'asc', limit: 100, offset: 0 });
        let cursor: string | undefined;
        const seen: string[] = [];
        for (let guard = 0; guard < 10; guard += 1) {
          const page = await post({
            keywords: 'Смета',
            sort: 'created',
            order: 'asc',
            limit: 2,
            offset: 0,
            ...(cursor !== undefined ? { cursor } : {}),
          });
          seen.push(...page.data.map((t) => t.id));
          if (page.meta.has_more !== true) {
            assert.equal(page.meta.next_cursor ?? null, null);
            break;
          }
          assert.equal(typeof page.meta.next_cursor, 'string');
          cursor = page.meta.next_cursor as string;
        }
        assert.deepEqual(seen, full.data.map((t) => t.id));
        assert.equal(new Set(seen).size, 5);

        // MCP: тот же контракт — без флага `total: null`, с флагом — число.
        mcpCtx = await buildMcpContext(overrides);
        handle = await connectMcpClient(mcpCtx, restCtx.adminKey);
        const mcpPlain = toolJson<{ total: number | null; has_more: boolean; hits: unknown[] }>(
          await handle.client.callTool({
            name: 'etn.thoughts.query',
            arguments: { network_id: restCtx.networkId, keywords: 'Смета', limit: 2 },
          }),
        );
        assert.equal(mcpPlain.total, null);
        assert.equal(mcpPlain.has_more, true);
        const mcpCounted = toolJson<{ total: number | null }>(
          await handle.client.callTool({
            name: 'etn.thoughts.query',
            arguments: { network_id: restCtx.networkId, keywords: 'Смета', limit: 2, count: true },
          }),
        );
        assert.equal(mcpCounted.total, 5);

        // Каждая из пяти мыслей найдена FTS-путём keywords (индексный сужатель
        // + LIKE-остаток) — курсорный обход вернул ровно их.
        assert.deepEqual(new Set(seen), new Set(ids));
      } finally {
        if (handle !== undefined) await handle.close();
        if (mcpCtx !== undefined) await closeMcpContext(mcpCtx, overrides);
        await closeRestContext(restCtx);
      }
    });
  },
);
