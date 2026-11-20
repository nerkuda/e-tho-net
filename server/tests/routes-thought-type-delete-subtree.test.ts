/**
 * REST-регрессия d4802371 «Ошибка удаления группы типов» (версия 0.16.1).
 *
 * `DELETE /thought-types/{id}?force=1` обязан удалить тип вместе со ВСЕМ
 * поддеревом (дети раньше родителя), эмитить `thought-type.deleted` и запись
 * активности `deleted` на каждый тип, а `thought-type-view.deleted` — на каждый
 * каскадно удалённый отбор. Без `force` тип с детьми отвергается 422 с
 * `details.children`. Роль сети на дочернем типе отвергает удаление даже с
 * `force` (проверяется всё поддерево).
 *
 * Skip при отсутствии нативной сборки `better-sqlite3`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

interface TypeDto {
  id: string;
  version: number;
  parent_id: string | null;
}

interface RealtimeEvent {
  type: string;
  data: unknown;
}

/** Создать тип мысли через REST и вернуть его карточку. */
async function createType(
  ctx: RestTestContext,
  name: string,
  parentId: string | null,
): Promise<TypeDto> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types`,
    headers: authHeaders(ctx),
    payload: parentId === null ? { name } : { name, parent_id: parentId },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return res.json().data as TypeDto;
}

describe(
  'DELETE /thought-types/{id}?force=1 — каскад поддерева (d4802371)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('удаляет всё поддерево, эмитит события на каждый тип/отбор и пишет активность', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;
        const a = await createType(ctx, 'A', null);
        const b = await createType(ctx, 'B', a.id);
        const c = await createType(ctx, 'C', b.id);

        const thoughtRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts`,
          headers: h,
          payload: { title: 'Мысль внука', type_id: c.id },
        });
        assert.equal(thoughtRes.statusCode, 201, thoughtRes.body?.toString());
        const thoughtId = (thoughtRes.json().data as { id: string }).id;

        const viewRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types/${b.id}/views`,
          headers: h,
          payload: { name: 'Отбор ребёнка', definition: '{"sort":"title","order":"asc"}' },
        });
        assert.equal(viewRes.statusCode, 201, viewRes.body?.toString());
        const viewId = (viewRes.json().data as { id: string }).id;

        const received: RealtimeEvent[] = [];
        const unsubscribe = ctx.app.pubsub.subscribe(ctx.networkId, (event: RealtimeEvent) =>
          received.push(event),
        );
        try {
          const del = await ctx.app.inject({
            method: 'DELETE',
            url: `/api/v1/networks/${nid}/thought-types/${a.id}?force=1`,
            headers: { ...h, 'If-Match': String(a.version) },
          });
          assert.equal(del.statusCode, 204, del.body?.toString());
          await new Promise((r) => setImmediate(r));

          // Событие на КАЖДЫЙ тип поддерева.
          const deletedTypes = received
            .filter((e) => e.type === 'thought-type.deleted')
            .map((e) => (e.data as { id: string }).id)
            .sort();
          assert.deepEqual(deletedTypes, [a.id, b.id, c.id].sort());

          // Отбор ребёнка удалён каскадом — с полной карточкой и владельцем.
          const deletedViews = received.filter((e) => e.type === 'thought-type-view.deleted');
          assert.deepEqual(
            deletedViews.map((e) => (e.data as { view_id: string }).view_id),
            [viewId],
          );
          const viewData = deletedViews[0]!.data as {
            thought_type_id: string;
            view: { id: string; name: string };
          };
          assert.equal(viewData.thought_type_id, b.id);
          assert.equal(viewData.view.name, 'Отбор ребёнка');
        } finally {
          unsubscribe();
        }

        // Каталог без поддерева: остался только корень.
        const list = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
        });
        assert.equal(list.statusCode, 200);
        const remaining = list.json().data as Array<{ id: string; is_root: boolean }>;
        assert.deepEqual(
          remaining.filter((t) => !t.is_root).map((t) => t.id),
          [],
          'все типы поддерева удалены',
        );

        // Мысль осталась, но без типа.
        const thoughtRow = ctx.ndb
          .prepare('SELECT type_id FROM thoughts WHERE id = ? -- layers:physical-read')
          .get(thoughtId) as { type_id: string | null } | undefined;
        assert.equal(thoughtRow?.type_id, null);

        // Активность `deleted` — на каждый удалённый тип.
        const activity = ctx.ndb
          .prepare(
            `SELECT entity_id FROM activity_log
              WHERE entity_type = 'thought_type' AND action = 'deleted' -- layers:physical-read`,
          )
          .all() as Array<{ entity_id: string }>;
        assert.deepEqual(activity.map((row) => row.entity_id).sort(), [a.id, b.id, c.id].sort());
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('без force тип с детьми отвергается с details.children', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;
        const a = await createType(ctx, 'A', null);
        const b = await createType(ctx, 'B', a.id);

        const del = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${nid}/thought-types/${a.id}`,
          headers: { ...h, 'If-Match': String(a.version) },
        });
        assert.equal(del.statusCode, 422);
        assert.equal(del.json().error.details.children, 1);

        const list = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
        });
        const ids = (list.json().data as Array<{ id: string }>).map((t) => t.id);
        assert.ok(ids.includes(a.id) && ids.includes(b.id), 'ничего не удалено');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('роль сети на дочернем типе отвергает удаление даже с force', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;
        const a = await createType(ctx, 'A', null);
        const b = await createType(ctx, 'B', a.id);

        const roleRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}`,
          headers: h,
          payload: { type_roles: { table_of_contents: b.id } },
        });
        assert.equal(roleRes.statusCode, 200, roleRes.body?.toString());

        const del = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${nid}/thought-types/${a.id}?force=1`,
          headers: { ...h, 'If-Match': String(a.version) },
        });
        assert.equal(del.statusCode, 422);
        const details = del.json().error.details as { id?: string; role?: string };
        assert.equal(details.id, b.id, 'назван занятый ролью дочерний тип');
        assert.equal(details.role, 'table_of_contents');

        const list = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
        });
        const ids = (list.json().data as Array<{ id: string }>).map((t) => t.id);
        assert.ok(ids.includes(a.id) && ids.includes(b.id), 'транзакция откатилась');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
