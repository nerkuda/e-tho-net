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
import { describe, it } from 'node:test';

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
} from './mcp-helpers.js';

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
    assert.equal(ctx.withTime, true);
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
