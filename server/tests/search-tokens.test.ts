/**
 * Задача 56a143ff «Разрешение календарных токенов AST в точке поиска»
 * (требование b7fdab20): точка поиска (`GET /search`, `etn.thoughts.search`)
 * исполняла `ast` без контекста токенов, и лист с календарным токеном
 * разрешался на «чужих» часах/настройках либо молча сворачивался в `AST_FALSE`.
 *
 * Доказываем (DoD карточки):
 *   1. условие с `$monthStart` в точке поиска даёт ТОТ ЖЕ результат, что
 *      эквивалентное условие в «Структурах» (единый движок `queryThoughts`) —
 *      и что контекст (часы) реально учитывается: другой `nowMs` → другой
 *      результат, детерминированно;
 *   2. неразрешимый токен (`$nonexistent`) даёт диагностируемый результат
 *      (`unresolved` с `reason`), а не бесшумный пустой;
 *   3. веер `network_ids` разрешает токены в контексте КАЖДОЙ сети (свой
 *      первый день недели → свой `$weekStart`): и на уровне домена
 *      (`fanOutSearch` + `tokenContextFor`, детерминированно), и на уровне
 *      REST-роута (контекст строится из настроек каждой сети).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import {
  BASE_LAYER_ID,
  FILTER_AST_VERSION,
  type FilterAst,
  type FilterAstNode,
} from '@etn/shared';

import { closeNetworkDb, createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { search } from '../src/domain/search-service.js';
import { queryThoughts } from '../src/domain/query-service.js';
import {
  fanOutSearch,
  type CrossNetworkAccess,
} from '../src/domain/cross-network-search-service.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  createSecondAdminUser,
  openNetworkDbSafe,
  type RestTestContext,
} from './rest-helpers.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  toolText,
} from './mcp-helpers.js';

function nativeOk(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Seed helpers (in-memory and on-disk networks alike)
// ---------------------------------------------------------------------------

function seedThought(ndb: NetworkDb, title: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00.000Z', 'u', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase());
  return id;
}

function seedDateProperty(ndb: NetworkDb, name: string): string {
  const id = randomUUID();
  seedDatePropertyWithId(ndb, id, name);
  return id;
}

/** Вставить дату-свойство с заданным id (один id можно завести в двух сетях). */
function seedDatePropertyWithId(ndb: NetworkDb, id: string, name = 'срок'): void {
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, ?, ?, lower(?), 'date', NULL, NULL, '2024', '2024')`,
    )
    .run(id, BASE_LAYER_ID, name, name);
}

function seedDateValue(ndb: NetworkDb, thoughtId: string, propertyId: string, value: string): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_date, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

/** Мысль с текстом-маркером и датой значения свойства — в одной сети. */
function seedDatedThought(ndb: NetworkDb, title: string, propertyId: string, date: string): string {
  const id = seedThought(ndb, title);
  seedDateValue(ndb, id, propertyId, date);
  return id;
}

/** `YYYY-MM-DD` первого дня недели даты `d` (UTC) при первом дне `fdw` (ISO). */
function weekStartUtc(d: Date, fdw: number): string {
  const day = d.toISOString().slice(0, 10);
  const isoWd = ((new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7) + 1; // пн=1..вс=7
  const back = (isoWd - fdw + 7) % 7;
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - back * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

const leaf = (
  entity: Record<string, unknown>,
  operator: string,
  value?: unknown,
): FilterAstNode =>
  (value === undefined ? { entity, operator } : { entity, operator, value }) as FilterAstNode;

const ast = (filter: FilterAstNode): FilterAst => ({ version: FILTER_AST_VERSION, filter });

// ---------------------------------------------------------------------------
// Domain: контекст поиска ≡ контекст выборки, диагностика неразрешимого токена
// ---------------------------------------------------------------------------

describe(
  'поиск + календарные токены AST (задача 56a143ff): единый контекст и диагностика',
  nativeOk() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('$monthStart: поиск ≡ «Структуры» и чтит переданные часы', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const prop = seedDateProperty(ndb, 'срок');
        const inMonth = seedDatedThought(ndb, 'Secret in month', prop, '2026-09-05');
        const oldMonth = seedDatedThought(ndb, 'Secret old month', prop, '2026-08-20');
        const tree = ast(
          leaf({ kind: 'property', property_id: prop }, 'between', [
            { token: '$monthStart' },
            { token: '$monthEnd' },
          ]),
        );

        const sep = Date.parse('2026-09-09T13:37:45.123Z'); // месяц → сентябрь
        const aug = Date.parse('2026-08-09T13:37:45.123Z'); // месяц → август

        const idsOfSearch = (nowMs: number): string[] =>
          search(ndb, { q: 'secret', ast: tree }, false, { nowMs, firstDayOfWeek: 1 })
            .by_names.map((h) => h.thought_id)
            .sort();
        const titlesOfQuery = (nowMs: number): string[] =>
          queryThoughts(
            ndb,
            'u',
            { ast: tree, count: true, limit: 200, offset: 0, sort: 'alpha', order: 'asc' },
            { emptyFilterMode: 'all', maxLimit: 200, tokenContext: { nowMs, firstDayOfWeek: 1 } },
          )
            .items.map((i) => i.title)
            .sort();

        // Паритет с «Структурами» (единый движок) при том же контексте.
        assert.deepEqual(idsOfSearch(sep), [inMonth], 'сентябрь: только мысль месяца');
        assert.deepEqual(titlesOfQuery(sep), ['Secret in month'], '«Структуры»: тот же результат');

        // Контекст реально учитывается: август даёт другую мысль — и снова паритет.
        assert.deepEqual(idsOfSearch(aug), [oldMonth], 'август: только старая мысль');
        assert.deepEqual(titlesOfQuery(aug), ['Secret old month'], '«Структуры»: тот же результат');
        assert.notDeepEqual(idsOfSearch(sep), idsOfSearch(aug), 'часы влияют на результат');
      } finally {
        ndb.close();
      }
    });

    it('неразрешимый токен → пустой результат с диагностикой unresolved (не бесшумно)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Secret probe');
        const tree = ast(leaf({ kind: 'active' }, 'eq', { token: '$nonexistent' }));
        const res = search(ndb, { q: 'secret', ast: tree }, false, {
          nowMs: Date.parse('2026-09-09T13:37:45.123Z'),
          firstDayOfWeek: 1,
        });
        assert.equal(res.by_names.length, 0, 'неразрешимый токен — пустая выдача');
        assert.ok(res.unresolved !== undefined && res.unresolved.length > 0, 'есть диагностика');
        assert.equal(res.unresolved[0]!.token, '$nonexistent');
        assert.equal(res.unresolved[0]!.reason, 'unknown_token');
        assert.equal(typeof res.unresolved[0]!.message, 'string');
      } finally {
        ndb.close();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// REST: веер network_ids — контекст на каждую сеть
// ---------------------------------------------------------------------------

interface TwoNets extends RestTestContext {
  networkId2: string;
  adminKey2: string;
  adminId2: string;
}

/** Две сети, где ctx.admin (владелец первой) — участник обеих. */
async function buildTwoNets(): Promise<TwoNets> {
  const ctx = await buildRestContext();
  const { userId: adminId2, key: adminKey2 } = createSecondAdminUser(ctx);
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/networks',
    headers: { authorization: `Bearer ${adminKey2}` },
    payload: { display_name: 'Test Net 2' },
  });
  assert.equal(created.statusCode, 201);
  const networkId2 = (created.json().data as { id: string }).id;
  // Владелец второй сети добавляет ctx.admin участником — иначе веер его сеть
  // молча исключит.
  const member = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${networkId2}/members`,
    headers: { authorization: `Bearer ${adminKey2}` },
    payload: { user_id: ctx.adminId },
  });
  assert.equal(member.statusCode, 201, `addMember failed: ${member.payload}`);
  return { ...ctx, networkId2, adminKey2, adminId2 };
}

async function closeTwoNets(ctx: TwoNets): Promise<void> {
  closeNetworkDb(ctx.networkId2);
  await closeRestContext(ctx);
}

/** Установить «первый день недели» сети (ISO 1..7) в системном реестре. */
function setFirstDayOfWeek(ctx: RestTestContext, networkId: string, fdw: number): void {
  const net = ctx.sys.getNetworkById(networkId);
  assert.ok(net !== null, 'сеть в реестре');
  ctx.sys.updateNetwork(networkId, {
    displayName: net.display_name,
    description: net.description,
    when_to_use: net.when_to_use,
    conventions: net.conventions,
    examples: net.examples,
    type_roles: net.type_roles,
    first_day_of_week: fdw,
  });
}

describe(
  'веер network_ids: $weekStart в контексте каждой сети (задача 56a143ff)',
  nativeOk() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('домен fanOutSearch: tokenContextFor задаёт первый день недели на сеть', async () => {
      const ctx = await buildTwoNets();
      try {
        const nowMs = Date.parse('2026-09-09T13:37:45.123Z');
        const ndb2 = openNetworkDbSafe(ctx.dataDir, ctx.networkId2);
        const prop1 = seedDateProperty(ctx.ndb, 'срок');
        const prop2 = seedDateProperty(ndb2, 'срок');
        // Значение в каждой сети — её собственный $weekStart (пн vs вс).
        const in1 = seedDatedThought(ctx.ndb, 'Week secret one', prop1, weekStartUtc(new Date(nowMs), 1));
        const in2 = seedDatedThought(ndb2, 'Week secret two', prop2, weekStartUtc(new Date(nowMs), 7));

        const access: CrossNetworkAccess = {
          networks: [
            { id: ctx.networkId, display_name: 'Test Net' },
            { id: ctx.networkId2, display_name: 'Test Net 2' },
          ],
          accessibleIds: [ctx.networkId, ctx.networkId2],
          dataDir: ctx.dataDir,
          userId: ctx.adminId,
          clientId: 'test-search-tokens',
          logger: ctx.app.appLogger,
        };
        const weekTree = (pid: string): FilterAst =>
          ast(leaf({ kind: 'property', property_id: pid }, 'eq', { token: '$weekStart' }));
        const fdw = (nid: string): 1 | 7 => (nid === ctx.networkId ? 1 : 7);
        const one = (netIndex: 0 | 1, propId: string, firstDayOverride?: number) =>
          fanOutSearch(
            { ...access, networks: [access.networks[netIndex]!], accessibleIds: [access.networks[netIndex]!.id] },
            {
              networkIds: [access.networks[netIndex]!.id],
              q: 'secret',
              ast: weekTree(propId),
              limit: 50,
              offset: 0,
              showInactiveDefault: false,
              tokenContextFor: (nid) => ({
                nowMs,
                firstDayOfWeek: firstDayOverride ?? fdw(nid),
              }),
            },
          );

        // Каждая сеть разрешает $weekStart в своём контексте → своя мысль.
        assert.deepEqual(one(0, prop1).response.by_names.map((h) => h.thought_id), [in1]);
        assert.deepEqual(one(1, prop2).response.by_names.map((h) => h.thought_id), [in2]);
        // Подмена контекста (первая сеть с "воскресным" первым днём) — токен
        // разрешается иначе → пусто: контекст реально участвует.
        assert.equal(one(0, prop1, 7).response.by_names.length, 0, 'чужой fdw не матчит пн-значение');

        // Неразрешимый токен в веере: диагностика агрегируется ПО сетям.
        const diag = fanOutSearch(access, {
          networkIds: [ctx.networkId, ctx.networkId2],
          q: 'secret',
          ast: ast(leaf({ kind: 'active' }, 'eq', { token: '$nonexistent' })),
          limit: 50,
          offset: 0,
          showInactiveDefault: false,
          tokenContextFor: (nid) => ({ nowMs, firstDayOfWeek: fdw(nid) }),
        });
        assert.equal(diag.response.by_names.length, 0);
        assert.equal(diag.response.unresolved?.length, 2, 'диагностика на каждую сеть');
        assert.deepEqual(
          diag.response.unresolved?.map((i) => i.network_id).sort(),
          [ctx.networkId, ctx.networkId2].sort(),
        );
        assert.ok(diag.response.unresolved?.every((i) => i.token === '$nonexistent'));
      } finally {
        await closeTwoNets(ctx);
      }
    });

    it('REST /search?network_ids: контекст строится по настройке каждой сети', async () => {
      const ctx = await buildTwoNets();
      try {
        setFirstDayOfWeek(ctx, ctx.networkId, 1); // понедельник
        setFirstDayOfWeek(ctx, ctx.networkId2, 7); // воскресенье

        const now = new Date();
        const start1 = weekStartUtc(now, 1);
        const start2 = weekStartUtc(now, 7);
        assert.notEqual(start1, start2, 'начала недели при пн/вс различаются');

        // Один id свойства в обеих сетях: веер гоняет ОДИН AST по всем сетям,
        // а ссылка на несуществующее свойство отвергается диагностикой
        // (`filter_entity_deleted`), поэтому берём общий id (id реестра сетей
        // независимы — совпадение допустимо).
        const prop = randomUUID();
        seedDatePropertyWithId(ctx.ndb, prop);
        const ndb2 = openNetworkDbSafe(ctx.dataDir, ctx.networkId2);
        seedDatePropertyWithId(ndb2, prop);
        const in1 = seedDatedThought(ctx.ndb, 'Week secret one', prop, start1);
        const in2 = seedDatedThought(ndb2, 'Week secret two', prop, start2);

        const tree = ast(leaf({ kind: 'property', property_id: prop }, 'eq', { token: '$weekStart' }));

        const call = async (nid: string): Promise<Array<{ thought_id: string; network_id?: string }>> => {
          const url =
            `/api/v1/networks/${nid}/search?` +
            new URLSearchParams({ q: 'secret', ast: JSON.stringify(tree) }).toString();
          const res = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(ctx) });
          assert.equal(res.statusCode, 200, res.payload);
          return (res.json().data as { by_names: Array<{ thought_id: string; network_id?: string }> })
            .by_names;
        };

        // Одиночные сети: каждая разрешает $weekStart по своей настройке.
        assert.deepEqual((await call(ctx.networkId)).map((h) => h.thought_id), [in1]);
        assert.deepEqual((await call(ctx.networkId2)).map((h) => h.thought_id), [in2]);

        // Веер: один AST по обеим сетям. Оба хита с разными network_id
        // доказывают, что каждая сеть разрешила токен в СВОЁМ контексте (общий
        // контекст дал бы пусто в одной из сетей).
        const url =
          `/api/v1/networks/${ctx.networkId}/search?` +
          new URLSearchParams({ q: 'secret', ast: JSON.stringify(tree) }).toString() +
          `&network_ids=${ctx.networkId2}`;
        const fan = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(ctx) });
        assert.equal(fan.statusCode, 200, fan.payload);
        const byNetwork = new Map(
          (
            fan.json().data as { by_names: Array<{ thought_id: string; network_id?: string }> }
          ).by_names.map((h) => [h.network_id, h.thought_id]),
        );
        assert.equal(byNetwork.get(ctx.networkId), in1, 'сеть 1: своё пн-разрешение');
        assert.equal(byNetwork.get(ctx.networkId2), in2, 'сеть 2: своё вс-разрешение');
      } finally {
        await closeTwoNets(ctx);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// MCP: etn.thoughts.search несёт контекст ключа
// ---------------------------------------------------------------------------

describe(
  'MCP etn.thoughts.search: контекст токенов (задача 56a143ff)',
  nativeOk() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('$user разрешается владельцем ключа; неразрешимый токен диагностируется', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const created = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Mcp token secret',
          });

          const byUser = await handle.client.callTool({
            name: 'etn.thoughts.search',
            arguments: {
              network_id: ctx.networkId,
              query: 'secret',
              scope: 'names',
              ast: {
                version: 1,
                filter: { entity: { kind: 'author' }, operator: 'eq', value: { token: '$user' } },
              },
            },
          });
          assert.equal(byUser.isError, undefined, toolText(byUser));
          const parsedUser = JSON.parse(toolText(byUser)) as {
            by_names: Array<{ thought_id: string }>;
          };
          assert.deepEqual(
            parsedUser.by_names.map((h) => h.thought_id),
            [created.id],
            '$user = владелец ключа → его мысль найдена',
          );

          const bad = await handle.client.callTool({
            name: 'etn.thoughts.search',
            arguments: {
              network_id: ctx.networkId,
              query: 'secret',
              scope: 'names',
              ast: {
                version: 1,
                filter: {
                  entity: { kind: 'author' },
                  operator: 'eq',
                  value: { token: '$nonexistent' },
                },
              },
            },
          });
          assert.equal(bad.isError, undefined, toolText(bad));
          const parsedBad = JSON.parse(toolText(bad)) as {
            by_names: unknown[];
            unresolved?: Array<{ token: string; reason: string }>;
          };
          assert.equal(parsedBad.by_names.length, 0, 'неразрешимый токен — пусто');
          assert.equal(parsedBad.unresolved?.[0]?.token, '$nonexistent');
          assert.equal(parsedBad.unresolved?.[0]?.reason, 'unknown_token');
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Токены контекста мысли `$thought*` в точке поиска (задача 4b1cc3d4)
// ---------------------------------------------------------------------------

/** Структурная связь «родитель → потомок» (нетипизированное живое ребро). */
function seedStructuralLink(ndb: NetworkDb, parentId: string, childId: string): void {
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion,
                          version, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, NULL, 1, 0, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(randomUUID(), parentId, childId);
}

describe(
  'поиск + токены контекста мысли $thought (задача 4b1cc3d4)',
  nativeOk() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('с мыслью-фокусом «Мысль в иерархии $thought» находит подкорень', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const root = seedThought(ndb, 'Secret root');
        const child = seedThought(ndb, 'Secret child');
        const outsider = seedThought(ndb, 'Secret outsider');
        seedStructuralLink(ndb, root, child);
        const tree = ast(leaf({ kind: 'id' }, 'in_hierarchy', { token: '$thought' }));

        const res = search(
          ndb,
          { q: 'secret', ast: tree, focus_thought_id: root },
          false,
          { userId: 'u' },
        );
        assert.deepEqual(
          res.by_names.map((h) => h.thought_id).sort(),
          [root, child].sort(),
          'корень и его потомок, без посторонней мысли',
        );
        assert.equal(res.unresolved, undefined, 'токен разрешён — диагностики нет');

        const other = search(
          ndb,
          { q: 'secret', ast: tree, focus_thought_id: outsider },
          false,
          { userId: 'u' },
        );
        assert.deepEqual(
          other.by_names.map((h) => h.thought_id),
          [outsider],
          'другая мысль в фокусе даёт другой подкорень',
        );
      } finally {
        ndb.close();
      }
    });

    it('$thought.<поле> разрешается полем мысли в фокусе', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Secret one');
        const focus = seedThought(ndb, 'Secret two');
        const tree = ast(leaf({ kind: 'active' }, 'eq', { token: '$thought.active' }));
        const res = search(
          ndb,
          { q: 'secret', ast: tree, focus_thought_id: focus },
          false,
          { userId: 'u' },
        );
        assert.equal(res.unresolved, undefined, 'поле мысли разрешилось');
        assert.equal(res.by_names.length, 2, 'активность подставлена (обе мысли активны)');
      } finally {
        ndb.close();
      }
    });

    it('без мысли-фокуса токен диагностируется, а не молчит', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Secret probe');
        const tree = ast(leaf({ kind: 'id' }, 'in_hierarchy', { token: '$thought' }));
        const res = search(ndb, { q: 'secret', ast: tree }, false, { userId: 'u' });
        assert.equal(res.by_names.length, 0, 'без фокуса — пустая выдача');
        assert.ok(res.unresolved !== undefined && res.unresolved.length > 0, 'есть диагностика');
        assert.equal(res.unresolved[0]!.token, '$thought');
        assert.equal(res.unresolved[0]!.reason, 'unknown_token');
        assert.match(res.unresolved[0]!.message, /фокус/i);
      } finally {
        ndb.close();
      }
    });

    it('REST /search?focus_thought_id: подкорень в фокусе разрешается', async () => {
      const ctx = await buildRestContext();
      try {
        const root = seedThought(ctx.ndb, 'Secret rest root');
        const child = seedThought(ctx.ndb, 'Secret rest child');
        seedStructuralLink(ctx.ndb, root, child);
        const tree = ast(leaf({ kind: 'id' }, 'in_hierarchy', { token: '$thought' }));

        const call = async (extra: Record<string, string>): Promise<{
          statusCode: number;
          ids: string[];
          unresolved?: Array<{ token: string; reason: string }>;
        }> => {
          const url =
            `/api/v1/networks/${ctx.networkId}/search?` +
            new URLSearchParams({ q: 'secret', ast: JSON.stringify(tree), ...extra }).toString();
          const res = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(ctx) });
          const data = res.json().data as {
            by_names: Array<{ thought_id: string }>;
            unresolved?: Array<{ token: string; reason: string }>;
          };
          return {
            statusCode: res.statusCode,
            ids: (data.by_names ?? []).map((h) => h.thought_id).sort(),
            ...(data.unresolved !== undefined ? { unresolved: data.unresolved } : {}),
          };
        };

        const withFocus = await call({ focus_thought_id: root });
        assert.equal(withFocus.statusCode, 200);
        assert.deepEqual(withFocus.ids, [root, child].sort(), 'фокус -> корень и потомок');

        const withoutFocus = await call({});
        assert.equal(withoutFocus.statusCode, 200);
        assert.deepEqual(withoutFocus.ids, [], 'без фокуса — пусто');
        assert.equal(withoutFocus.unresolved?.[0]?.token, '$thought');
      } finally {
        await closeRestContext(ctx);
      }
    });

    // Задача 2220340b: `focus_thought_id` — параметр точки поиска и в MCP
    // (паритет с REST). Проба — ОБЩИЙ мир REST+MCP: одно тело `ast` и одна
    // мысль-фокус обязаны дать одинаковый результат в обоих фасадах.
    it('MCP etn.thoughts.search: focus_thought_id разрешает $thought как REST', async () => {
      const rest = await buildRestContext();
      const mcp = await buildMcpContext({
        dataDir: rest.dataDir,
        networkId: rest.networkId,
        systemDb: rest.sys,
      });
      const handle = await connectMcpClient(mcp, rest.adminKey);
      try {
        const root = seedThought(rest.ndb, 'Secret mcp root');
        const child = seedThought(rest.ndb, 'Secret mcp child');
        const outsider = seedThought(rest.ndb, 'Secret mcp outsider');
        seedStructuralLink(rest.ndb, root, child);
        const tree = ast(leaf({ kind: 'id' }, 'in_hierarchy', { token: '$thought' }));

        const url =
          `/api/v1/networks/${rest.networkId}/search?` +
          new URLSearchParams({
            q: 'secret',
            scope: 'names',
            ast: JSON.stringify(tree),
            focus_thought_id: root,
          }).toString();
        const restRes = await rest.app.inject({ method: 'GET', url, headers: authHeaders(rest) });
        assert.equal(restRes.statusCode, 200, JSON.stringify(restRes.json()));
        const restIds = (restRes.json().data as { by_names: Array<{ thought_id: string }> }).by_names
          .map((h) => h.thought_id)
          .sort();

        const mcpRes = await handle.client.callTool({
          name: 'etn.thoughts.search',
          arguments: {
            network_id: rest.networkId,
            query: 'secret',
            scope: 'names',
            ast: tree,
            focus_thought_id: root,
          },
        });
        assert.equal(mcpRes.isError, undefined, toolText(mcpRes));
        const parsed = JSON.parse(toolText(mcpRes)) as {
          by_names: Array<{ thought_id: string }>;
          unresolved?: unknown[];
        };
        assert.deepEqual(
          parsed.by_names.map((h) => h.thought_id).sort(),
          restIds,
          'MCP с focus_thought_id обязан дать тот же результат, что REST',
        );
        assert.deepEqual(parsed.by_names.map((h) => h.thought_id).sort(), [root, child].sort());
        assert.ok(!parsed.by_names.some((h) => h.thought_id === outsider));
        assert.equal(parsed.unresolved, undefined, 'токен разрешён — диагностики нет');

        // Без фокуса — пустая страница и диагностика `unresolved`, не тихая пустота.
        const noFocus = await handle.client.callTool({
          name: 'etn.thoughts.search',
          arguments: {
            network_id: rest.networkId,
            query: 'secret',
            scope: 'names',
            ast: tree,
          },
        });
        assert.equal(noFocus.isError, undefined, toolText(noFocus));
        const nf = JSON.parse(toolText(noFocus)) as {
          by_names: unknown[];
          unresolved?: Array<{ token: string }>;
        };
        assert.deepEqual(nf.by_names, []);
        assert.ok(
          (nf.unresolved ?? []).some((u) => u.token.includes('$thought')),
          `неразрешимый токен обязан попасть в unresolved: ${toolText(noFocus)}`,
        );
      } finally {
        await handle.close();
        await closeMcpContext(mcp, {
          dataDir: rest.dataDir,
          networkId: rest.networkId,
          systemDb: rest.sys,
        });
        await closeRestContext(rest);
      }
    });
  },
);
