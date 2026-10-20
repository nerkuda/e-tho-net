/**
 * 0.14.1, задача Z2 (58b598d5): умное удаление ребра при удалении цели
 * свойства-связи — ADR a967d865, требование ebb070c2, сценарий 685f27c5.
 *
 * DoD:
 *   * основа — физическое удаление живого ребра без корзины;
 *   * слой — корзина для ребра, существующего в основе/предках;
 *   * слой — физическое удаление строки для ребра, созданного в слое;
 *   * уже помеченное — no-op без события;
 *   * все пути (DELETE свойства, set без цели, properties.remove, usage_clear)
 *     дают один результат;
 *   * слияние — стандартный посрочный реплей: пометка переносится как пометка;
 *   * восстановление PATCH /links и links.restore;
 *   * ветка Д сценария: «Очистить» и «Удалить» на живом/помеченном/смешанном.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, EtnError } from '@etn/shared';
import DatabaseConstructor from 'better-sqlite3';

import {
  createInMemoryNetworkDb,
  openNetworkDb,
  type NetworkDb,
} from '../src/db/network-db.js';
import { mergeLayer } from '../src/domain/merge-service.js';
import { getLink, updateLink } from '../src/domain/link-service.js';
import {
  clearThoughtRefUsages,
  createNetworkProperty,
  deletePropertyValue,
  getLinkPropertyValues,
  removeLinkPropertyValue,
  setPropertyValue,
} from '../src/domain/property-service.js';
import { createThought } from '../src/domain/thought-service.js';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  type RestTestContext,
} from './rest-helpers.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  toolText,
} from './mcp-helpers.js';

const USER = 'user-1';
const LAYER_A = '11111111-1111-4111-8111-111111111111';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Один пользовательский слой A (ребёнок основы). */
function insertLayer(ndb: NetworkDb): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, 'Слой A', 0, 1, 'u', ?, ?)`,
    )
    .run(LAYER_A, BASE_LAYER_ID, now, now);
}

interface Seed {
  owner: string;
  t1: string;
  t2: string;
  key: string;
  linkTypeId: string;
}

/** Свойство-связь в справочнике + три мысли (владелец и две цели). */
function seed(ndb: NetworkDb, name = 'rel'): Seed {
  const prop = createNetworkProperty(
    ndb,
    {
      name,
      value_type: 'link',
      name_forward: name,
      name_reverse: `${name}-обратно`,
    },
    USER,
  );
  const owner = createThought(ndb, { title: `Владелец ${name}` }, USER);
  const t1 = createThought(ndb, { title: `Цель 1 ${name}` }, USER);
  const t2 = createThought(ndb, { title: `Цель 2 ${name}` }, USER);
  return {
    owner: owner.id,
    t1: t1.id,
    t2: t2.id,
    key: name,
    linkTypeId: (prop.config?.link_type_id ?? '') as string,
  };
}

/** Живое ребро свойства к конкретной цели (или `undefined`). */
function linkTo(ndb: NetworkDb, seedValue: Seed, targetId: string): string | undefined {
  return getLinkPropertyValues(ndb, 'thought', seedValue.owner, seedValue.linkTypeId, 'out').find(
    (value) => value.target_id === targetId,
  )?.link_id;
}

/** Сырая строка ребра в конкретном слое. */
function rawLinkRow(
  ndb: NetworkDb,
  linkId: string,
  layerId: string,
): { marked_for_deletion: number; base_version: number; version: number } | undefined {
  return ndb
    .prepare(
      'SELECT marked_for_deletion, base_version, version FROM links WHERE id = ? AND layer_id = ?',
    )
    .get(linkId, layerId) as
    | { marked_for_deletion: number; base_version: number; version: number }
    | undefined;
}

describe(
  '0.14.1 — умное удаление цели свойства-связи (58b598d5)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('основа: живое ребро удаляется физически, цель не трогается', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seed(ndb);
        setPropertyValue(ndb, 'thought', s.owner, s.key, [s.t1], USER);
        const linkId = linkTo(ndb, s, s.t1);
        assert.ok(linkId !== undefined);

        const removed = deletePropertyValue(ndb, 'thought', s.owner, s.key, USER);
        assert.equal(removed.deleted, true);
        assert.deepEqual(
          removed.removals?.map((r) => r.action),
          ['deleted'],
        );
        assert.equal(getLink(ndb, linkId), null, 'ребра физически нет');
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS c FROM links WHERE id = ?').get(linkId) as { c: number }).c,
          0,
        );
        assert.notEqual(ndb.prepare('SELECT 1 FROM thoughts_v WHERE id = ?').get(s.t1), undefined);
        const target = ndb
          .prepare('SELECT marked_for_deletion FROM thoughts_v WHERE id = ?')
          .get(s.t1) as { marked_for_deletion: number };
        assert.equal(target.marked_for_deletion, 0, 'цель не помечена');
      } finally {
        ndb.close();
      }
    });

    it('основа: повторное удаление — no-op без события (removals пуст)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seed(ndb);
        setPropertyValue(ndb, 'thought', s.owner, s.key, [s.t1], USER);
        const first = deletePropertyValue(ndb, 'thought', s.owner, s.key, USER);
        assert.equal(first.deleted, true);
        const again = deletePropertyValue(ndb, 'thought', s.owner, s.key, USER);
        assert.equal(again.deleted, false);
        assert.deepEqual(again.removals ?? [], []);
      } finally {
        ndb.close();
      }
    });

    it('слой: ребро из основы уходит в корзину, повтор — no-op', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seed(ndb);
        setPropertyValue(ndb, 'thought', s.owner, s.key, [s.t1], USER);
        const linkId = linkTo(ndb, s, s.t1);
        assert.ok(linkId !== undefined);
        const baseBefore = rawLinkRow(ndb, linkId, BASE_LAYER_ID);
        assert.ok(baseBefore !== undefined);

        insertLayer(ndb);
        ndb.useLayer(LAYER_A);
        const removed = deletePropertyValue(ndb, 'thought', s.owner, s.key, USER);
        assert.deepEqual(removed.removals?.map((r) => r.action), ['trashed']);

        const baseAfter = rawLinkRow(ndb, linkId, BASE_LAYER_ID);
        assert.equal(baseAfter?.marked_for_deletion, 0, 'основа не тронута');
        const shadow = rawLinkRow(ndb, linkId, LAYER_A);
        assert.equal(shadow?.marked_for_deletion, 1, 'тень слоя в корзине');
        assert.ok((shadow?.base_version ?? 0) > 0, 'тень материализована из основы');
        const visible = ndb
          .prepare('SELECT marked_for_deletion, version FROM links_v WHERE id = ?')
          .get(linkId) as { marked_for_deletion: number; version: number };
        assert.equal(visible.marked_for_deletion, 1);
        const versionAfterFirst = visible.version;

        const again = deletePropertyValue(ndb, 'thought', s.owner, s.key, USER);
        assert.equal(again.deleted, false);
        assert.deepEqual(again.removals ?? [], []);
        assert.equal(
          (ndb.prepare('SELECT version FROM links_v WHERE id = ?').get(linkId) as { version: number })
            .version,
          versionAfterFirst,
          'повторная пометка версию не меняет',
        );
      } finally {
        ndb.close();
      }
    });

    it('слой: свежесозданное в слое ребро удаляется физически', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seed(ndb);
        insertLayer(ndb);
        ndb.useLayer(LAYER_A);
        setPropertyValue(ndb, 'thought', s.owner, s.key, [s.t1], USER);
        const linkId = linkTo(ndb, s, s.t1);
        assert.ok(linkId !== undefined);

        const removed = deletePropertyValue(ndb, 'thought', s.owner, s.key, USER);
        assert.deepEqual(removed.removals?.map((r) => r.action), ['deleted']);
        assert.equal(rawLinkRow(ndb, linkId, LAYER_A), undefined, 'строки слоя нет');
        assert.equal(rawLinkRow(ndb, linkId, BASE_LAYER_ID), undefined, 'в основе ребра не было');
        assert.equal(getLink(ndb, linkId), null);
      } finally {
        ndb.close();
      }
    });

    it('set без цели: основа — физически, слой для ребра основы — корзина', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        // основа
        const base = seed(ndb, 'base-set');
        setPropertyValue(ndb, 'thought', base.owner, base.key, [base.t1, base.t2], USER);
        const removedBase = linkTo(ndb, base, base.t2);
        setPropertyValue(ndb, 'thought', base.owner, base.key, [base.t1], USER);
        assert.equal(getLink(ndb, removedBase!), null, 'лишнее ребро основы удалено физически');

        // слой
        const layered = seed(ndb, 'layer-set');
        setPropertyValue(ndb, 'thought', layered.owner, layered.key, [layered.t1, layered.t2], USER);
        const layeredT2 = linkTo(ndb, layered, layered.t2);
        insertLayer(ndb);
        ndb.useLayer(LAYER_A);
        setPropertyValue(ndb, 'thought', layered.owner, layered.key, [layered.t1], USER);
        assert.equal(
          rawLinkRow(ndb, layeredT2!, BASE_LAYER_ID)?.marked_for_deletion,
          0,
          'ребро основы не тронуто',
        );
        assert.equal(
          rawLinkRow(ndb, layeredT2!, LAYER_A)?.marked_for_deletion,
          1,
          'в слое — корзина',
        );
      } finally {
        ndb.close();
      }
    });

    it('properties.remove с неоднозначной стороной: 422 без side, с side — физически', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        // Симметричное имя (forward = reverse): при обеих живых сторонах
        // направление неоднозначно.
        const prop = createNetworkProperty(
          ndb,
          {
            name: 'sym',
            value_type: 'link',
            name_forward: 'sym',
            name_reverse: 'sym',
          },
          USER,
        );
        const linkTypeId = (prop.config?.link_type_id ?? '') as string;
        const owner = createThought(ndb, { title: 'Владелец sym' }, USER);
        const t1 = createThought(ndb, { title: 'Цель sym' }, USER);

        setPropertyValue(ndb, 'thought', owner.id, 'sym', t1.id, USER, undefined, 'source');
        setPropertyValue(ndb, 'thought', owner.id, 'sym', t1.id, USER, undefined, 'target');
        const outLink = getLinkPropertyValues(ndb, 'thought', owner.id, linkTypeId, 'out');
        const inLink = getLinkPropertyValues(ndb, 'thought', owner.id, linkTypeId, 'in');
        assert.equal(outLink.length, 1);
        assert.equal(inLink.length, 1);

        assert.throws(
          () => removeLinkPropertyValue(ndb, 'thought', owner.id, 'sym', t1.id, USER),
          (err: unknown) =>
            err instanceof EtnError &&
            err.code === 'VALIDATION_ERROR' &&
            (err.details as { field?: string }).field === 'side',
        );

        const removed = removeLinkPropertyValue(
          ndb,
          'thought',
          owner.id,
          'sym',
          t1.id,
          USER,
          'source',
        );
        assert.equal(removed.action, 'deleted', 'основа: физическое удаление');
        assert.equal(getLink(ndb, outLink[0]!.link_id), null);
        assert.equal(
          getLinkPropertyValues(ndb, 'thought', owner.id, linkTypeId, 'in').length,
          1,
          'входящее ребро не задето',
        );
      } finally {
        ndb.close();
      }
    });

    it('usage_clear (блокирующее свойство) идёт той же умной процедурой', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const prop = createNetworkProperty(
          ndb,
          {
            name: 'blocking',
            value_type: 'link',
            name_forward: 'blocking',
            name_reverse: 'blocking-обратно',
            config: { blocks_target_deletion: true },
          },
          USER,
        );
        const linkTypeId = (prop.config?.link_type_id ?? '') as string;
        const owner = createThought(ndb, { title: 'Владелец blocking' }, USER);
        const target = createThought(ndb, { title: 'Цель blocking' }, USER);
        setPropertyValue(ndb, 'thought', owner.id, 'blocking', target.id, USER);
        const linkId = getLinkPropertyValues(ndb, 'thought', owner.id, linkTypeId, 'out')[0]?.link_id;
        assert.ok(linkId !== undefined);

        // Основа: «Очистить использование» удаляет физически.
        assert.equal(clearThoughtRefUsages(ndb, target.id), 1);
        assert.equal(getLink(ndb, linkId), null);

        // Слой для ребра основы: корзина.
        setPropertyValue(ndb, 'thought', owner.id, 'blocking', target.id, USER);
        const secondId = getLinkPropertyValues(ndb, 'thought', owner.id, linkTypeId, 'out')[0]?.link_id;
        assert.ok(secondId !== undefined);
        insertLayer(ndb);
        ndb.useLayer(LAYER_A);
        assert.equal(clearThoughtRefUsages(ndb, target.id), 1);
        assert.equal(rawLinkRow(ndb, secondId, BASE_LAYER_ID)?.marked_for_deletion, 0);
        assert.equal(rawLinkRow(ndb, secondId, LAYER_A)?.marked_for_deletion, 1);
      } finally {
        ndb.close();
      }
    });

    it('слияние переносит пометку слоя в основу КАК ПОМЕТКУ (стандартный реплей)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seed(ndb);
        setPropertyValue(ndb, 'thought', s.owner, s.key, [s.t1], USER);
        const linkId = linkTo(ndb, s, s.t1);
        assert.ok(linkId !== undefined);

        insertLayer(ndb);
        ndb.useLayer(LAYER_A);
        deletePropertyValue(ndb, 'thought', s.owner, s.key, USER);
        assert.equal(rawLinkRow(ndb, linkId, LAYER_A)?.marked_for_deletion, 1);

        mergeLayer(ndb, LAYER_A, undefined, USER);
        ndb.useLayer(BASE_LAYER_ID);

        const baseRow = rawLinkRow(ndb, linkId, BASE_LAYER_ID);
        assert.equal(baseRow?.marked_for_deletion, 1, 'пометка перенесена в основу как пометка');
        assert.equal(rawLinkRow(ndb, linkId, LAYER_A), undefined, 'строка слоя слита');
        assert.equal(getLink(ndb, linkId)?.marked_for_deletion, true);
        assert.notEqual(ndb.prepare('SELECT 1 FROM thoughts_v WHERE id = ?').get(s.t1), undefined);
      } finally {
        ndb.close();
      }
    });

    it('восстановление в слое: updateLink снимает пометку, ребро снова живое', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seed(ndb);
        setPropertyValue(ndb, 'thought', s.owner, s.key, [s.t1], USER);
        const linkId = linkTo(ndb, s, s.t1);
        insertLayer(ndb);
        ndb.useLayer(LAYER_A);
        deletePropertyValue(ndb, 'thought', s.owner, s.key, USER);

        updateLink(ndb, linkId!, { marked_for_deletion: false }, undefined, USER);
        assert.equal(getLink(ndb, linkId!)?.marked_for_deletion, false);
        assert.equal(
          getLinkPropertyValues(ndb, 'thought', s.owner, s.linkTypeId, 'out').length,
          1,
          'ребро вернулось в значения',
        );
      } finally {
        ndb.close();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Ветка Д сценария 685f27c5: «Очистить» и «Удалить» пошагово
// ---------------------------------------------------------------------------

describe(
  '0.14.1 — ветка Д: «Очистить» и «Удалить» на одном свойстве',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('(а) живое → «Очистить»; повторное «Удалить» — no-op', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seed(ndb, 'd-a');
        setPropertyValue(ndb, 'thought', s.owner, s.key, [s.t1], USER);
        const linkId = linkTo(ndb, s, s.t1);
        assert.ok(linkId !== undefined);

        // «Очистить» = DELETE свойства (умное удаление в основе).
        assert.equal(deletePropertyValue(ndb, 'thought', s.owner, s.key, USER).deleted, true);
        assert.equal(getLink(ndb, linkId), null);

        // «Удалить» = properties.remove: ребра уже нет.
        const removed = removeLinkPropertyValue(ndb, 'thought', s.owner, s.key, s.t1, USER);
        assert.equal(removed.link_id, null);
        assert.equal(removed.action, null);
      } finally {
        ndb.close();
      }
    });

    it('(б) помеченное → «Очистить» возвращает; «Удалить» — no-op до восстановления', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seed(ndb, 'd-b');
        setPropertyValue(ndb, 'thought', s.owner, s.key, [s.t1], USER);
        const linkId = linkTo(ndb, s, s.t1);
        assert.ok(linkId !== undefined);
        updateLink(ndb, linkId, { marked_for_deletion: true }, undefined, USER);

        // «Удалить» по помеченному — no-op (живых рёбер нет).
        const noop = removeLinkPropertyValue(ndb, 'thought', s.owner, s.key, s.t1, USER);
        assert.equal(noop.link_id, null);
        assert.equal(getLink(ndb, linkId)?.marked_for_deletion, true);

        // «Очистить» = PATCH marked=false.
        updateLink(ndb, linkId, { marked_for_deletion: false }, undefined, USER);
        assert.equal(getLink(ndb, linkId)?.marked_for_deletion, false);
      } finally {
        ndb.close();
      }
    });

    it('(в) живое + помеченное: «Очистить»/«Удалить» не трогают помеченное', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seed(ndb, 'd-c');
        setPropertyValue(ndb, 'thought', s.owner, s.key, [s.t1, s.t2], USER);
        const liveId = linkTo(ndb, s, s.t1);
        const trashedId = linkTo(ndb, s, s.t2);
        assert.ok(liveId !== undefined && trashedId !== undefined);
        updateLink(ndb, trashedId, { marked_for_deletion: true }, undefined, USER);

        // «Очистить» снимает только живые рёбра.
        assert.equal(deletePropertyValue(ndb, 'thought', s.owner, s.key, USER).deleted, true);
        assert.equal(getLink(ndb, liveId), null);
        assert.equal(getLink(ndb, trashedId)?.marked_for_deletion, true, 'помеченное не тронуто');

        // «Удалить» по живому — ребра уже нет; помеченное остаётся.
        const removed = removeLinkPropertyValue(ndb, 'thought', s.owner, s.key, s.t1, USER);
        assert.equal(removed.link_id, null);
        assert.equal(getLink(ndb, trashedId)?.marked_for_deletion, true);
      } finally {
        ndb.close();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// REST: событие и восстановление PATCH /links
// ---------------------------------------------------------------------------

describe(
  '0.14.1 — REST DELETE свойства: события link.deleted/link.updated',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    async function seedRest(ctx: RestTestContext): Promise<Seed> {
      const s = seed(ctx.ndb, 'rest');
      return s;
    }

    it('основа: DELETE свойства эмитит link.deleted', async () => {
      const ctx = await buildRestContext();
      try {
        const s = await seedRest(ctx);
        setPropertyValue(ctx.ndb, 'thought', s.owner, s.key, [s.t1], USER);
        const linkId = linkTo(ctx.ndb, s, s.t1);
        const before = ctx.sys.readEventsAfter(ctx.networkId, 0, 1000).at(-1)?.seq ?? 0;

        const res = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${s.owner}/properties/${s.key}`,
          headers: authHeaders(ctx),
        });
        assert.equal(res.statusCode, 204, res.body);

        const events = ctx.sys
          .readEventsAfter(ctx.networkId, before, 50)
          .filter((event) => event.type === 'link.deleted');
        assert.equal(events.length, 1);
        assert.equal((events[0]!.data as { id: string }).id, linkId);

        // Повторный DELETE — no-op без событий link.* (уже помеченного нет).
        const afterDelete = ctx.sys.readEventsAfter(ctx.networkId, 0, 1000).at(-1)?.seq ?? 0;
        const again = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${s.owner}/properties/${s.key}`,
          headers: authHeaders(ctx),
        });
        assert.equal(again.statusCode, 204);
        assert.deepEqual(
          ctx.sys
            .readEventsAfter(ctx.networkId, afterDelete, 50)
            .filter((event) => event.type.startsWith('link.')),
          [],
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('слой: DELETE для ребра основы эмитит link.updated и PATCH возвращает ребро', async () => {
      const ctx = await buildRestContext();
      try {
        const s = await seedRest(ctx);
        setPropertyValue(ctx.ndb, 'thought', s.owner, s.key, [s.t1], USER);
        const linkId = linkTo(ctx.ndb, s, s.t1);
        insertLayer(ctx.ndb);
        ctx.ndb.useLayer(LAYER_A);
        const before = ctx.sys.readEventsAfter(ctx.networkId, 0, 1000).at(-1)?.seq ?? 0;

        const res = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${s.owner}/properties/${s.key}`,
          headers: authHeaders(ctx),
        });
        assert.equal(res.statusCode, 204, res.body);

        const updated = ctx.sys
          .readEventsAfter(ctx.networkId, before, 50)
          .filter((event) => event.type === 'link.updated');
        assert.equal(updated.length, 1);
        assert.equal((updated[0]!.data as { id: string }).id, linkId);

        const restore = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/links/${linkId}`,
          headers: authHeaders(ctx),
          payload: { marked_for_deletion: false },
        });
        assert.equal(restore.statusCode, 200, restore.body);
        assert.equal(getLink(ctx.ndb, linkId!)?.marked_for_deletion, false);
      } finally {
        ctx.ndb.useLayer(BASE_LAYER_ID);
        await closeRestContext(ctx);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// MCP: set-запись without target -> события; links.restore
// ---------------------------------------------------------------------------

describe(
  '0.14.1 — MCP set без цели: событие удаления',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('etn.thoughts.write с сужением набора эмитит link.deleted', async () => {
      const ctx = await buildMcpContext();
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const s = seed(ndb, 'mcp-set');
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const write = async (targets: string[]): Promise<void> => {
            const res = await handle.client.callTool({
              name: 'etn.thoughts.write',
              arguments: {
                network_id: ctx.networkId,
                thoughts: [
                  {
                    thought_id: s.owner,
                    properties: { [s.key]: targets },
                  },
                ],
              },
            });
            assert.equal(res.isError, undefined, toolText(res));
          };
          await write([s.t1, s.t2]);
          const t2Link = linkTo(ndb, s, s.t2);
          assert.ok(t2Link !== undefined);
          const before = ctx.sys.readEventsAfter(ctx.networkId, 0, 1000).at(-1)?.seq ?? 0;

          await write([s.t1]);
          const deleted = ctx.sys
            .readEventsAfter(ctx.networkId, before, 50)
            .filter((event) => event.type === 'link.deleted');
          assert.equal(deleted.length, 1);
          assert.equal((deleted[0]!.data as { id: string }).id, t2Link);

          // Повтор без изменений — события удаления нет.
          const afterFirst = ctx.sys.readEventsAfter(ctx.networkId, 0, 1000).at(-1)?.seq ?? 0;
          await write([s.t1]);
          assert.deepEqual(
            ctx.sys
              .readEventsAfter(ctx.networkId, afterFirst, 50)
              .filter((event) => event.type === 'link.deleted'),
            [],
          );
        } finally {
          await handle.client.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);
