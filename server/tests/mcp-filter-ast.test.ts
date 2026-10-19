/**
 * MCP: AST-тело в `etn.thoughts.query` и `etn.views.run` (задача cb78315b;
 * требования 91983c20 «Старые тела REST/MCP компилируются в AST», 76e30d9a
 * «Один исполнитель AST…», a50c7872 «Грамматика AST в справочнике etn.guide»).
 *
 * Проверяется через реальную MCP-сессию (production-фабрика `createMcpServer`):
 *   - `ast` принимается и исполняется единым движком; группы И/ИЛИ/НЕ, операнды
 *     иерархии, значения-токены и значения-под-выборки;
 *   - `ast` XOR старые критерии, `ast` только для одной сети, неизвестные поля
 *     AST отвергаются `VALIDATION_ERROR`;
 *   - `tokenContext` прокинут в точки вызова (автор `$user` разрешается);
 *   - старые (плоские) вызовы продолжают работать;
 *   - `etn.views.run` принимает `ast` вместо `view_name` (ровно одно).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { FILTER_AST_VERSION } from '@etn/shared';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { McpRuntime } from '../src/mcp/context.js';
import { mcpTokenContext } from '../src/mcp/tools/token-context.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  nativeAvailable,
  toolText,
  type ClientCallToolResult,
  type McpTestContext,
} from './mcp-helpers.js';
import { authHeaders, buildRestContext, closeRestContext, type RestTestContext } from './rest-helpers.js';
import type { NetworkDb } from '../src/db/network-db.js';

const skip = !nativeAvailable();

/** Вызвать `etn.thoughts.query` сырыми аргументами (для негативных кейсов). */
interface RawQueryJson {
  hits?: Array<{ title: string }>;
  unresolved?: Array<{ network_id?: string; token: string; reason: string }>;
}

async function rawQuery(
  client: Client,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; json: RawQueryJson | null }> {
  const res = await client.callTool({ name: 'etn.thoughts.query', arguments: args });
  const text = toolText(res);
  let json: RawQueryJson | null = null;
  try {
    json = JSON.parse(text) as RawQueryJson;
  } catch {
    json = null;
  }
  return { isError: res.isError === true, text, json };
}

/** Заголовки hits структурной выборки. */
function hitTitles(result: ClientCallToolResult): string[] {
  const text = toolText(result);
  const parsed = JSON.parse(text) as { hits: Array<{ title: string }> };
  return parsed.hits.map((h) => h.title);
}

/** Фикстура: «Родитель» с двумя потомками и отдельная мысль. */
interface Fixture {
  parentId: string;
  soloId: string;
}

async function seedFixture(client: Client, networkId: string): Promise<Fixture> {
  const parent = await createThoughtViaWrite(client, networkId, { title: 'AST-Parent' });
  await createThoughtViaWrite(client, networkId, {
    title: 'AST-Child1',
    link: { direction: 'parent', target_thought_id: parent.id },
  });
  await createThoughtViaWrite(client, networkId, {
    title: 'AST-Child2',
    link: { direction: 'parent', target_thought_id: parent.id },
  });
  const solo = await createThoughtViaWrite(client, networkId, { title: 'AST-Solo' });
  return { parentId: parent.id, soloId: solo.id };
}

describe('MCP etn.thoughts.query: AST-тело (cb78315b)', { skip }, () => {
  it('группы И/ИЛИ/НЕ исполняются единым движком', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await seedFixture(handle.client, ctx.networkId);

        // ИЛИ: два условия по названию.
        const orResult = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            ast: {
              version: 1,
              filter: {
                op: 'or',
                children: [
                  { entity: { kind: 'keywords', scope: ['title'] }, operator: 'matches', value: 'AST-Parent' },
                  { entity: { kind: 'keywords', scope: ['title'] }, operator: 'matches', value: 'AST-Solo' },
                ],
              },
            },
          },
        });
        assert.deepEqual(hitTitles(orResult).sort(), ['AST-Parent', 'AST-Solo']);

        // НЕ: всё, кроме «Родителя».
        const notResult = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            ast: {
              version: 1,
              filter: {
                op: 'not',
                children: [
                  { entity: { kind: 'keywords', scope: ['title'] }, operator: 'matches', value: 'AST-Parent' },
                ],
              },
            },
          },
        });
        const notTitles = hitTitles(notResult);
        assert.ok(!notTitles.includes('AST-Parent'), `«Родитель» не должен попасть: ${notTitles.join(', ')}`);
        assert.ok(notTitles.includes('AST-Solo'));
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('структурный операнд «Потомки» и сортировка из ast.sort', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const fx = await seedFixture(handle.client, ctx.networkId);
        const childrenResult = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            ast: {
              version: 1,
              filter: { entity: { kind: 'children' }, operator: 'not_empty' },
            },
          },
        });
        const titles = hitTitles(childrenResult);
        assert.ok(titles.includes('AST-Parent'), 'мысль с живым структурным потомком обязана попасть');
        assert.ok(!titles.includes('AST-Solo'), 'мысль без потомков попадать не должна');
        assert.ok(titles.includes('AST-Child1') === false, 'сами потомки не обязаны попадать');

        // ast.sort: один ключ — сортировка страницы; потомки по названию вниз.
        const sortedResult = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            ast: {
              version: 1,
              filter: { entity: { kind: 'parents' }, operator: 'in', value: [fx.parentId] },
              sort: [{ key: 'title', order: 'desc' }],
            },
          },
        });
        assert.deepEqual(hitTitles(sortedResult), ['AST-Child2', 'AST-Child1']);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('многоуровневый ast.sort принимается целиком; конфликт с sort/order — ошибка (задача 3a157e66)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const fx = await seedFixture(handle.client, ctx.networkId);
        // Два ключа: title ↑ (Child1, Child2); ограничение «один ключ» снято.
        const multi = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            ast: {
              version: 1,
              filter: { entity: { kind: 'parents' }, operator: 'in', value: [fx.parentId] },
              sort: [
                { key: 'title', order: 'asc' },
                { key: 'created_at', order: 'desc' },
              ],
            },
          },
        });
        assert.equal(multi.isError, undefined, toolText(multi));
        assert.deepEqual(hitTitles(multi), ['AST-Child1', 'AST-Child2']);

        // Два источника порядка (ast.sort и поля sort/order) → VALIDATION_ERROR.
        const conflict = await rawQuery(handle.client, {
          network_id: ctx.networkId,
          ast: {
            version: 1,
            filter: { entity: { kind: 'parents' }, operator: 'in', value: [fx.parentId] },
            sort: [{ key: 'title', order: 'asc' }],
          },
          sort: 'created_at',
        });
        assert.equal(conflict.isError, true);
        assert.match(conflict.text, /VALIDATION_ERROR/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('значение-токен `$user` разрешается (tokenContext прокинут)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await seedFixture(handle.client, ctx.networkId);
        const res = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            ast: {
              version: 1,
              filter: { entity: { kind: 'author' }, operator: 'eq', value: { token: '$user' } },
            },
          },
        });
        // Без tokenContext токен `$user` неразрешим и страница была бы пустой.
        assert.ok(hitTitles(res).length >= 3, 'автор-токен `$user` должен разрешиться в id вызывающего');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('неразрешимый токен даёт пустую страницу и `unresolved`', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await seedFixture(handle.client, ctx.networkId);
        const res = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            ast: {
              version: 1,
              filter: {
                entity: { kind: 'created_at' },
                operator: 'gte',
                value: { token: '$thought.id' },
              },
            },
          },
        });
        const parsed = JSON.parse(toolText(res)) as {
          hits: unknown[];
          unresolved?: Array<{ token: string }>;
        };
        assert.deepEqual(parsed.hits, []);
        assert.ok(
          (parsed.unresolved ?? []).some((u) => u.token.includes('$thought')),
          'неразрешимый токен обязан попасть в unresolved',
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('под-выборка как значение оператора', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await seedFixture(handle.client, ctx.networkId);
        // Мысли, чей родитель подходит под под-выборку (название «AST-Parent»).
        const res = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: {
            network_id: ctx.networkId,
            ast: {
              version: 1,
              filter: {
                entity: { kind: 'parents' },
                operator: 'in',
                value: {
                  query: {
                    entity: { kind: 'keywords', scope: ['title'] },
                    operator: 'matches',
                    value: 'AST-Parent',
                  },
                  operator: 'in',
                },
              },
            },
          },
        });
        assert.deepEqual(hitTitles(res).sort(), ['AST-Child1', 'AST-Child2']);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('ast XOR старые критерии; неизвестные поля AST отвергаются; веер принимает ast', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await seedFixture(handle.client, ctx.networkId);
        const flatAst = {
          version: 1,
          filter: { entity: { kind: 'keywords', scope: ['title'] }, operator: 'matches', value: 'AST-' },
        };
        const mixed = await rawQuery(handle.client, {
          network_id: ctx.networkId,
          ast: flatAst,
          keywords: 'AST',
        });
        assert.equal(mixed.isError, true);
        assert.match(mixed.text, /VALIDATION_ERROR/);

        // Веер тоже принимает ast (паритет с REST) — отбор исполняется по сети.
        const fanOut = await rawQuery(handle.client, { network_ids: [ctx.networkId], ast: flatAst });
        assert.equal(fanOut.isError, false, fanOut.text);
        const fanTitles = (fanOut.json?.hits ?? []).map((h) => h.title);
        assert.ok(fanTitles.includes('AST-Solo'), `веер обязан вернуть совпадения: ${fanTitles.join(', ')}`);

        const bogus = await rawQuery(handle.client, {
          network_id: ctx.networkId,
          ast: {
            version: 1,
            filter: { entity: { kind: 'active' }, operator: 'eq', value: true },
            bogus: 1,
          },
        });
        assert.equal(bogus.isError, true);
        assert.match(bogus.text, /bogus/);

        const badSort = await rawQuery(handle.client, {
          network_id: ctx.networkId,
          ast: { ...flatAst, sort: [{ key: 'title', order: 'asc' }] },
          sort: 'title',
        });
        assert.equal(badSort.isError, true);
        assert.match(badSort.text, /VALIDATION_ERROR/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('веер: tokenContextFor разрешает токены по каждой сети, unresolved агрегируется по сетям', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await seedFixture(handle.client, ctx.networkId);
        // `$user` разрешается контекстом КАЖДОЙ сети (первый день недели у сети
        // свой): без `tokenContextFor` токен неразрешим и хитов не будет.
        const okRes = await rawQuery(handle.client, {
          network_ids: [ctx.networkId],
          ast: {
            version: 1,
            filter: { entity: { kind: 'author' }, operator: 'eq', value: { token: '$user' } },
          },
        });
        assert.equal(okRes.isError, false, okRes.text);
        assert.ok(
          (okRes.json?.hits ?? []).length >= 3,
          `веер обязан разрешить $user по сети: ${JSON.stringify(okRes.json)}`,
        );
        assert.equal(okRes.json?.unresolved, undefined);

        // Неразрешимый в сетевом контексте токен — агрегируется по сетям
        // (та же семантика, что у одиночного `unresolved`, плюс `network_id`).
        const badRes = await rawQuery(handle.client, {
          network_ids: [ctx.networkId],
          ast: {
            version: 1,
            filter: { entity: { kind: 'created_at' }, operator: 'gte', value: { token: '$thought.id' } },
          },
        });
        assert.equal(badRes.isError, false, badRes.text);
        assert.deepEqual(badRes.json?.hits, []);
        const aggregated = badRes.json?.unresolved ?? [];
        assert.equal(aggregated.length, 1, JSON.stringify(badRes.json));
        assert.equal(aggregated[0]?.network_id, ctx.networkId);
        assert.match(aggregated[0]?.token ?? '', /\$thought/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('старые (плоские) вызовы продолжают работать', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await seedFixture(handle.client, ctx.networkId);
        const res = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: { network_id: ctx.networkId, keywords: 'AST-Solo' },
        });
        assert.deepEqual(hitTitles(res), ['AST-Solo']);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

describe('MCP etn.views.run: AST-тело (cb78315b)', { skip }, () => {
  it('принимает ast вместо view_name; ровно одно из двух', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const fx = await seedFixture(handle.client, ctx.networkId);
        const res = await handle.client.callTool({
          name: 'etn.views.run',
          arguments: {
            network_id: ctx.networkId,
            thought_id: fx.parentId,
            ast: {
              version: 1,
              filter: { entity: { kind: 'keywords', scope: ['title'] }, operator: 'matches', value: 'AST-Solo' },
            },
          },
        });
        const parsed = JSON.parse(toolText(res)) as {
          data: Array<{ title: string }>;
          meta: { ast?: boolean; limit?: number };
        };
        assert.deepEqual(parsed.data.map((d) => d.title), ['AST-Solo']);
        assert.equal(parsed.meta.ast, true);
        // Дефолт лимита унифицирован с путём сохранённого отбора (100).
        assert.equal(parsed.meta.limit, 100);

        // Токены AST-пути разрешает tokenContext (как у сохранённого отбора):
        // без него `$user` неразрешим и data пуста.
        const tokenRes = await handle.client.callTool({
          name: 'etn.views.run',
          arguments: {
            network_id: ctx.networkId,
            thought_id: fx.parentId,
            ast: {
              version: 1,
              filter: { entity: { kind: 'author' }, operator: 'eq', value: { token: '$user' } },
            },
          },
        });
        const tokenParsed = JSON.parse(toolText(tokenRes)) as {
          data: Array<{ title: string }>;
          meta: { unresolved?: unknown[] };
        };
        assert.ok(
          tokenParsed.data.length >= 3,
          `$user в ast-параметре обязан разрешиться tokenContext: ${toolText(tokenRes)}`,
        );
        assert.equal(tokenParsed.meta.unresolved, undefined);

        const both = await handle.client.callTool({
          name: 'etn.views.run',
          arguments: {
            network_id: ctx.networkId,
            thought_id: fx.parentId,
            view_name: 'whatever',
            ast: { version: 1, filter: { entity: { kind: 'active' }, operator: 'eq', value: true } },
          },
        });
        assert.equal(both.isError, true);

        const neither = await handle.client.callTool({
          name: 'etn.views.run',
          arguments: { network_id: ctx.networkId, thought_id: fx.parentId },
        });
        assert.equal(neither.isError, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

describe('mcpTokenContext: обязательный пункт tokenContext (cb78315b)', { skip }, () => {
  it('берёт первый день недели из настроек сети и id вызывающего', () => {
    const rt = {
      deps: {
        systemDb: { getNetworkById: () => ({ first_day_of_week: 7 }) },
        auth: { userId: 'caller-1' },
      },
    } as unknown as McpRuntime;
    const ctx = mcpTokenContext(rt, 'net-1');
    assert.equal(ctx.firstDayOfWeek, 7);
    assert.equal(ctx.userId, 'caller-1');
    assert.equal(typeof ctx.nowMs, 'number');
    // Профиль по умолчанию — «мысли»: календарные токены без времени
    // (требование 0095daad, ADR 0c02ab4f).
    assert.equal(ctx.withTime, false);
    // Профиль со временем (хроника/события) — withTime true.
    assert.equal(mcpTokenContext(rt, 'net-1', 'chronicle').withTime, true);
  });

  it('без сети в настройках не выдумывает первый день недели', () => {
    const rt = {
      deps: {
        systemDb: { getNetworkById: () => null },
        auth: { userId: 'caller-1' },
      },
    } as unknown as McpRuntime;
    const ctx = mcpTokenContext(rt, 'net-1');
    assert.equal(ctx.firstDayOfWeek, undefined);
  });
});

// ===========================================================================
// ast + link_filter: паритет MCP ↔ REST (задача c5381a2d)
// ===========================================================================

/** Совместить REST-мир с MCP-сервером поверх него (тот же admin + сеть). */
async function pairedWorld(): Promise<{
  rest: RestTestContext;
  mcp: McpTestContext;
  handle: { client: Client; close(): Promise<void> };
}> {
  const rest = await buildRestContext();
  const mcp = await buildMcpContext({
    dataDir: rest.dataDir,
    networkId: rest.networkId,
    systemDb: rest.sys,
  });
  const handle = await connectMcpClient(mcp, rest.adminKey);
  return { rest, mcp, handle };
}

async function closePairedWorld(
  w: Awaited<ReturnType<typeof pairedWorld>>,
): Promise<void> {
  await w.handle.close();
  await closeMcpContext(w.mcp, {
    dataDir: w.rest.dataDir,
    networkId: w.rest.networkId,
    systemDb: w.rest.sys,
  });
  await closeRestContext(w.rest);
}

/** Вставить мысль напрямую в сетевую БД (быстрая фикстура паритетных проб). */
function seedSqlThought(ndb: NetworkDb, title: string, author: string): string {
  const id = randomUUID();
  const now = '2024-01-01T00:00:00.000Z';
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, 1, 0, 0, 1, ?, ?, ?, ?)`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase(), now, author, now, author);
  return id;
}

/** Вставить структурное ребро напрямую в сетевую БД. */
function seedSqlLink(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  opts: { active?: number; marked?: number } = {},
): void {
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion,
                          version, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, NULL, ?, ?, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(randomUUID(), sourceId, targetId, opts.active ?? 1, opts.marked ?? 0);
}

describe('MCP etn.thoughts.query: ast + link_filter (паритет с REST, c5381a2d)', { skip }, () => {
  it('ast+link_filter принимается и совпадает с REST; ast+link_filter+плоский критерий — VALIDATION_ERROR', async () => {
    const w = await pairedWorld();
    try {
      seedSqlThought(w.rest.ndb, 'C5381-A', w.rest.adminId);
      seedSqlThought(w.rest.ndb, 'C5381-B', w.rest.adminId);
      seedSqlThought(w.rest.ndb, 'C5381-C', w.rest.adminId);

      const ast = {
        version: FILTER_AST_VERSION,
        filter: { entity: { kind: 'trashed' as const }, operator: 'eq' as const, value: false },
      };
      // Тело отбора, собранное под REST: ast + фасадный link_filter.
      const restBody = {
        ast,
        link_filter: { include_structural: true },
        sort: 'alpha',
        order: 'asc',
        limit: 20,
      };
      const restRes = await w.rest.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${w.rest.networkId}/thoughts/query`,
        headers: authHeaders(w.rest),
        payload: restBody,
      });
      assert.equal(restRes.statusCode, 200, JSON.stringify(restRes.json()));
      const restIds = (restRes.json()['data'] as Array<{ id: string }>).map((i) => i.id);

      // То же тело через MCP: link_filter совместим с ast (паритет с REST).
      const mcpRes = await w.handle.client.callTool({
        name: 'etn.thoughts.query',
        arguments: {
          network_id: w.rest.networkId,
          ast,
          link_filter: { include_structural: true },
          sort: 'title',
          order: 'asc',
          limit: 20,
        },
      });
      assert.equal(mcpRes.isError, undefined, toolText(mcpRes));
      const mcpIds = (JSON.parse(toolText(mcpRes)) as { hits: Array<{ id: string }> }).hits.map(
        (h) => h.id,
      );
      assert.deepEqual(mcpIds, restIds, 'одинаковый отбор обязан дать одинаковый результат');

      // ast + link_filter + плоский критерий — по-прежнему конфликт.
      const conflict = await rawQuery(w.handle.client, {
        network_id: w.rest.networkId,
        ast,
        link_filter: { include_structural: true },
        keywords: 'C5381',
      });
      assert.equal(conflict.isError, true);
      assert.match(conflict.text, /VALIDATION_ERROR/);
    } finally {
      await closePairedWorld(w);
    }
  });
});

/**
 * MCP-контракт новых операндов наличия связей (задача 60db9614): направления,
 * состояния (включая пустую пару и wire-дефолт), отказ на `value`/неизвестном
 * состоянии/чужом профиле.
 */
describe('MCP etn.thoughts.query: AST наличия связей (60db9614)', { skip }, () => {
  async function queryIds(
    client: Client,
    networkId: string,
    entity: Record<string, unknown>,
    operator: 'is_empty' | 'not_empty',
  ): Promise<string[]> {
    const res = await client.callTool({
      name: 'etn.thoughts.query',
      arguments: {
        network_id: networkId,
        ast: {
          version: FILTER_AST_VERSION,
          filter: {
            op: 'and',
            children: [
              { entity, operator },
              {
                entity: { kind: 'keywords', scope: ['title'] },
                operator: 'matches',
                value: 'LP-',
              },
            ],
          },
        },
      },
    });
    assert.equal(res.isError, undefined, toolText(res));
    const parsed = JSON.parse(toolText(res)) as { hits: Array<{ id: string }> };
    return parsed.hits.map((hit) => hit.id).sort();
  }

  it('направления: входящие — target, исходящие — source; структурные рёбра учитываются', async () => {
    const w = await pairedWorld();
    try {
      const target = seedSqlThought(w.rest.ndb, 'LP-цель', w.rest.adminId);
      const source = seedSqlThought(w.rest.ndb, 'LP-источник', w.rest.adminId);
      seedSqlLink(w.rest.ndb, source, target);
      const lonely = seedSqlThought(w.rest.ndb, 'LP-без-связей', w.rest.adminId);

      assert.deepEqual(
        await queryIds(w.handle.client, w.rest.networkId, { kind: 'incoming_links' }, 'not_empty'),
        [target].sort(),
        'входящее ребро принадлежит target',
      );
      assert.deepEqual(
        await queryIds(w.handle.client, w.rest.networkId, { kind: 'outgoing_links' }, 'not_empty'),
        [source].sort(),
        'исходящее ребро принадлежит source',
      );
      assert.deepEqual(
        await queryIds(w.handle.client, w.rest.networkId, { kind: 'incoming_links' }, 'is_empty'),
        [source, lonely].sort(),
        'без входящих — source и мысль без рёбер',
      );
      assert.deepEqual(
        await queryIds(w.handle.client, w.rest.networkId, { kind: 'outgoing_links' }, 'is_empty'),
        [target, lonely].sort(),
        'без исходящих — target и мысль без рёбер',
      );
    } finally {
      await closePairedWorld(w);
    }
  });

  it('состояния рёбер: пары по И, пустая пара не ограничивает, пустой/отсутствующий states — все', async () => {
    const w = await pairedWorld();
    try {
      const live = seedSqlThought(w.rest.ndb, 'LP-живое', w.rest.adminId);
      const inactive = seedSqlThought(w.rest.ndb, 'LP-неактуальное', w.rest.adminId);
      const trashed = seedSqlThought(w.rest.ndb, 'LP-корзина', w.rest.adminId);
      const inactiveTrashed = seedSqlThought(
        w.rest.ndb,
        'LP-неактуальное-в-корзине',
        w.rest.adminId,
      );
      seedSqlLink(
        w.rest.ndb,
        seedSqlThought(w.rest.ndb, 'LP-источник-живой', w.rest.adminId),
        live,
        { active: 1, marked: 0 },
      );
      seedSqlLink(
        w.rest.ndb,
        seedSqlThought(w.rest.ndb, 'LP-источник-неактивный', w.rest.adminId),
        inactive,
        { active: 0, marked: 0 },
      );
      seedSqlLink(
        w.rest.ndb,
        seedSqlThought(w.rest.ndb, 'LP-источник-корзина', w.rest.adminId),
        trashed,
        { active: 1, marked: 1 },
      );
      seedSqlLink(
        w.rest.ndb,
        seedSqlThought(w.rest.ndb, 'LP-источник-неактивный-корзина', w.rest.adminId),
        inactiveTrashed,
        { active: 0, marked: 1 },
      );
      const all = [inactive, inactiveTrashed, live, trashed].sort();
      const ids = (states?: readonly string[]): Promise<string[]> =>
        queryIds(
          w.handle.client,
          w.rest.networkId,
          states === undefined
            ? { kind: 'incoming_links' }
            : { kind: 'incoming_links', states },
          'not_empty',
        );

      assert.deepEqual(await ids(['active', 'not_trashed']), [live].sort(), 'обе пары');
      assert.deepEqual(await ids(['inactive']), [inactive, inactiveTrashed].sort(), 'вторая пара пуста');
      assert.deepEqual(await ids(['trashed']), [inactiveTrashed, trashed].sort(), 'первая пара пуста');
      assert.deepEqual(await ids(['active', 'inactive']), all, 'оба члена первой пары');
      assert.deepEqual(await ids(['trashed', 'not_trashed']), all, 'оба члена второй пары');
      assert.deepEqual(await ids([]), all, 'пустой states — wire-дефолт');
      assert.deepEqual(await ids(), all, 'отсутствующий states — все состояния');
    } finally {
      await closePairedWorld(w);
    }
  });

  it('валидация: value, неизвестное состояние и чужой профиль — ошибка', async () => {
    const w = await pairedWorld();
    try {
      const withValue = await rawQuery(w.handle.client, {
        network_id: w.rest.networkId,
        ast: {
          version: FILTER_AST_VERSION,
          filter: {
            entity: { kind: 'incoming_links' },
            operator: 'not_empty',
            value: 'x',
          },
        },
      });
      assert.equal(withValue.isError, true, withValue.text);
      assert.match(withValue.text, /VALIDATION_ERROR/);
      assert.match(withValue.text, /не принимает значение/);

      const badState = await rawQuery(w.handle.client, {
        network_id: w.rest.networkId,
        ast: {
          version: FILTER_AST_VERSION,
          filter: {
            entity: { kind: 'outgoing_links', states: ['active', 'unknown'] },
            operator: 'not_empty',
          },
        },
      });
      assert.equal(badState.isError, true, badState.text);
      assert.match(badState.text, /VALIDATION_ERROR/);
      assert.match(badState.text, /filter\.entity\.states/);

      const badOperator = await rawQuery(w.handle.client, {
        network_id: w.rest.networkId,
        ast: {
          version: FILTER_AST_VERSION,
          filter: { entity: { kind: 'incoming_links' }, operator: 'eq' },
        },
      });
      assert.equal(badOperator.isError, true, badOperator.text);
      assert.match(badOperator.text, /VALIDATION_ERROR/);

      // Чужой профиль (хроника): операнд мысли в её AST невидим.
      const foreign = await w.handle.client.callTool({
        name: 'etn.chronicle.query',
        arguments: {
          network_id: w.rest.networkId,
          ast: {
            version: FILTER_AST_VERSION,
            filter: { entity: { kind: 'incoming_links' }, operator: 'not_empty' },
          },
        },
      });
      assert.equal(foreign.isError, true, toolText(foreign));
      assert.match(toolText(foreign), /VALIDATION_ERROR/);
      assert.match(toolText(foreign), /не виден в точке применения/);
    } finally {
      await closePairedWorld(w);
    }
  });
});
