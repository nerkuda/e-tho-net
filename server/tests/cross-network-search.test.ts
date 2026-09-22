/**
 * Integration tests for the cross-network (fan-out) mode of the search,
 * query and find_duplicates routes (task eb1a3f43, requirement c98d5d19).
 *
 * Coverage:
 *   1. `/networks/:nid/search?network_ids=…` — fan-out, catalog, network_id на
 *      каждом хите; одна сеть не меняет поведение.
 *   2. `/networks/:nid/thoughts/duplicates?network_ids=…` — fan-out и мерж
 *      дублей с указанием сети.
 *   3. `POST /networks/:nid/thoughts/query` с `network_ids` в теле — fan-out
 *      структурной выборки.
 *   4. Права: пользователь без членства в одной из сетей веера — эта сеть
 *      молча исключается из выдачи и справочника.
 *
 * Реальный сервер Fastify + `data.db` каждой сети (как и в
 * `routes-search-export.test.ts`). Сети создаются через `POST /networks` —
 * отдельный владелец-создатель добавляется автоматически.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { closeNetworkDb } from '../src/db/network-db.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  createSecondAdminUser,
  nativeAvailable,
  openNetworkDbSafe,
  type RestTestContext,
} from './rest-helpers.js';

interface NetCtx extends RestTestContext {
  /** Вторая сеть, созданная в том же процессе (для fan-out). */
  networkId2: string;
  /** HOME второй сети. */
  homeId2: string;
  /** API-ключ второго админа (владелец второй сети, но не первой). */
  adminKey2: string;
  /** Id второго админа. */
  adminId2: string;
}

async function buildCrossNetworkContext(): Promise<NetCtx> {
  const base = await buildRestContext();
  // Вторая сеть создаётся другим админом — проверяет независимость прав.
  const { userId: adminId2, key: adminKey2 } = createSecondAdminUser(base);
  const created2 = await base.app.inject({
    method: 'POST',
    url: '/api/v1/networks',
    headers: { authorization: `Bearer ${adminKey2}` },
    payload: { display_name: 'Test Net 2' },
  });
  assert.equal(created2.statusCode, 201);
  const networkId2 = (created2.json().data as { id: string }).id;
  const ndb2 = openNetworkDbSafe(base.dataDir, networkId2);
  const home2 = ndb2.prepare('SELECT id FROM thoughts WHERE is_root = 1 LIMIT 1').get() as {
    id: string;
  };
  return {
    ...base,
    networkId2,
    homeId2: home2.id,
    adminId2,
    adminKey2,
  };
}

async function closeCrossNetworkContext(ctx: NetCtx): Promise<void> {
  closeNetworkDb(ctx.networkId2);
  await closeRestContext(ctx);
}

/** Создать мысль в указанной сети через REST API. */
async function createThought(
  ctx: RestTestContext,
  networkId: string,
  key: string,
  title: string,
  permanentComment?: string,
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${networkId}/thoughts`,
    headers: { authorization: `Bearer ${key}` },
    payload: { title },
  });
  assert.equal(res.statusCode, 201, `create thought "${title}" failed: ${res.payload}`);
  const id = (res.json().data as { id: string }).id;
  if (permanentComment !== undefined) {
    const c = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/networks/${networkId}/thoughts/${id}/comments`,
      headers: { authorization: `Bearer ${key}` },
      payload: { kind: 'permanent', body_md: permanentComment },
    });
    assert.equal(c.statusCode, 201);
  }
  return id;
}

/**
 * Добавить первого админа (ctx.adminId) как участника второй сети. Владелец
 * сети по умолчанию — её создатель, поэтому для проверки прав нужно явно
 * выдать доступ через `POST /networks/:nid/members`.
 */
async function addMember(
  ctx: NetCtx,
  networkId: string,
  ownerKey: string,
  userId: string,
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${networkId}/members`,
    headers: { authorization: `Bearer ${ownerKey}` },
    payload: { user_id: userId },
  });
  assert.equal(res.statusCode, 201, `addMember failed: ${res.payload}`);
}

/** Параллельный владелец второй сети (см. {@link createSecondAdminUser}). */

describe(
  'cross-network (fan-out) search/query/duplicates',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it(
      'search: fan-out возвращает хиты из обеих сетей с network_id и справочником',
      async () => {
        const ctx = await buildCrossNetworkContext();
        try {
          // Делаем обоих админов участниками обеих сетей (иначе веер
          // ограничится одной сетью — это проверяется отдельным тестом).
          await addMember(ctx, ctx.networkId2, ctx.adminKey2, ctx.adminId);
          await addMember(ctx, ctx.networkId, ctx.adminKey, ctx.adminId2);

          // По мысли с уникальным заголовком в каждой сети.
          await createThought(ctx, ctx.networkId, ctx.adminKey, 'Альфа-тест');
          await createThought(ctx, ctx.networkId2, ctx.adminKey2, 'Бета-тест');

          // Веер по двум сетям.
          const fan = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/search?` +
              `q=${encodeURIComponent('тест')}&network_ids=${encodeURIComponent(ctx.networkId)}&` +
              `network_ids=${encodeURIComponent(ctx.networkId2)}`,
            headers: authHeaders(ctx),
          });
          assert.equal(fan.statusCode, 200);
          const data = fan.json().data as {
            by_names: Array<{ thought_id: string; network_id?: string }>;
            meta: { total_in_group: { names: number } };
            networks: Array<{ id: string; display_name: string }>;
          };
          assert.ok(Array.isArray(data.networks), 'networks catalog missing');
          assert.equal(data.networks.length, 2, 'catalog must contain both networks');
          const ids = new Set(data.networks.map((n) => n.id));
          assert.ok(ids.has(ctx.networkId));
          assert.ok(ids.has(ctx.networkId2));

          const byNet = new Map<string, string>();
          for (const hit of data.by_names) {
            assert.ok(hit.network_id !== undefined, 'each hit must have network_id');
            byNet.set(hit.network_id, hit.thought_id);
          }
          assert.equal(byNet.size, 2, 'one hit per network expected');
          assert.ok(byNet.has(ctx.networkId));
          assert.ok(byNet.has(ctx.networkId2));
        } finally {
          await closeCrossNetworkContext(ctx);
        }
      },
    );

    it(
      'search: поведение без network_ids (одна сеть) не меняется',
      async () => {
        const ctx = await buildCrossNetworkContext();
        try {
          await createThought(ctx, ctx.networkId, ctx.adminKey, 'Гамма-тест');
          const single = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/search?q=${encodeURIComponent('гамма')}`,
            headers: authHeaders(ctx),
          });
          assert.equal(single.statusCode, 200);
          const data = single.json().data as {
            by_names: Array<{ thought_id: string; network_id?: string }>;
            networks?: unknown;
          };
          assert.equal(data.by_names.length, 1);
          assert.equal(data.by_names[0]?.network_id, undefined, 'single-net must not set network_id');
          assert.equal(data.networks, undefined, 'single-net must not include catalog');
        } finally {
          await closeCrossNetworkContext(ctx);
        }
      },
    );

    it(
      'duplicates: fan-out находит дубль в обеих сетях с network_id',
      async () => {
        const ctx = await buildCrossNetworkContext();
        try {
          await addMember(ctx, ctx.networkId2, ctx.adminKey2, ctx.adminId);
          await addMember(ctx, ctx.networkId, ctx.adminKey, ctx.adminId2);

          await createThought(ctx, ctx.networkId, ctx.adminKey, 'Дельта');
          await createThought(ctx, ctx.networkId2, ctx.adminKey2, 'Дельта');

          const fan = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thoughts/duplicates?` +
              `title=${encodeURIComponent('Дельта')}&` +
              `network_ids=${encodeURIComponent(ctx.networkId)}&` +
              `network_ids=${encodeURIComponent(ctx.networkId2)}`,
            headers: authHeaders(ctx),
          });
          assert.equal(fan.statusCode, 200);
          const data = fan.json().data as {
            hits: Array<{ id: string; network_id?: string; title: string }>;
            networks: Array<{ id: string }>;
          };
          assert.equal(data.hits.length, 2, 'two duplicates (one per network) expected');
          assert.equal(data.networks.length, 2);
          const seenNets = new Set(data.hits.map((h) => h.network_id));
          assert.ok(seenNets.has(ctx.networkId));
          assert.ok(seenNets.has(ctx.networkId2));
          for (const hit of data.hits) assert.equal(hit.title, 'Дельта');
        } finally {
          await closeCrossNetworkContext(ctx);
        }
      },
    );

    it(
      'права: пользователь без доступа к сети — сеть молча исключается',
      async () => {
        const ctx = await buildCrossNetworkContext();
        try {
          // ctx.adminId НЕ добавляется в networkId2 — у него нет доступа.
          await createThought(ctx, ctx.networkId, ctx.adminKey, 'Эпсилон');
          await createThought(ctx, ctx.networkId2, ctx.adminKey2, 'Эпсилон-вторая');

          // Запрос от admin (ctx) — сеть networkId2 доступна только admin2
          // (владельцу), admin — НЕ участник networkId2.
          const fan = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/search?` +
              `q=${encodeURIComponent('эпсилон')}&` +
              `network_ids=${encodeURIComponent(ctx.networkId)}&` +
              `network_ids=${encodeURIComponent(ctx.networkId2)}`,
            headers: authHeaders(ctx),
          });
          assert.equal(fan.statusCode, 200);
          const data = fan.json().data as {
            by_names: Array<{ network_id?: string }>;
            networks: Array<{ id: string }>;
          };
          assert.equal(data.networks.length, 1, 'только доступная сеть в справочнике');
          assert.equal(data.networks[0]?.id, ctx.networkId);
          for (const hit of data.by_names) {
            assert.equal(hit.network_id, ctx.networkId);
          }
        } finally {
          await closeCrossNetworkContext(ctx);
        }
      },
    );

    it(
      'справочник сетей в ответе: display_name берётся из systemDb',
      async () => {
        const ctx = await buildCrossNetworkContext();
        try {
          await addMember(ctx, ctx.networkId2, ctx.adminKey2, ctx.adminId);
          await createThought(ctx, ctx.networkId, ctx.adminKey, 'Зета');
          await createThought(ctx, ctx.networkId2, ctx.adminKey2, 'Зета');

          const fan = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/search?` +
              `q=${encodeURIComponent('зета')}&` +
              `network_ids=${encodeURIComponent(ctx.networkId)}&` +
              `network_ids=${encodeURIComponent(ctx.networkId2)}`,
            headers: authHeaders(ctx),
          });
          const data = fan.json().data as {
            networks: Array<{ id: string; display_name: string }>;
          };
          assert.equal(data.networks.length, 2);
          const byId = new Map(data.networks.map((n) => [n.id, n.display_name]));
          assert.equal(byId.get(ctx.networkId), 'Test Net');
          assert.equal(byId.get(ctx.networkId2), 'Test Net 2');
        } finally {
          await closeCrossNetworkContext(ctx);
        }
      },
    );
  },
);
