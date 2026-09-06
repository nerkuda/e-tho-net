/**
 * Integration tests for the REST /locks routes (task 2031df5e, операция
 * `8919b057` в мыслесети `ETN`).
 *
 * Covers:
 *   * POST /locks              acquire (success, idempotent for own, 409 LOCKED on foreign);
 *   * DELETE /locks/:id        release (204 owner, 403 foreign, 404 unknown);
 *   * GET /locks               list + фильтры ?user_id / ?client_id;
 *   * POST /locks/clear        ручной сброс всех захватов участника;
 *   * чтение мысли НЕ блокируется захватом (GET /thoughts/:id чужого пользователя).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  createPlainUser,
  createSecondAdminUser,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

interface LockRow {
  id: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  client_id: string | null;
  acquired_at_ms: number;
}

/** POST /locks — короткий помощник. */
async function apiAcquire(
  ctx: RestTestContext,
  key: string,
  body: { entity_type: string; entity_id: string },
  clientId?: string,
): Promise<{ statusCode: number; data: LockRow | null; errorCode?: string }> {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (clientId !== undefined) headers['client-id'] = clientId;
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/locks`,
    headers,
    payload: body,
  });
  const json = res.json();
  if (res.statusCode === 200) {
    return { statusCode: res.statusCode, data: json.data as LockRow };
  }
  const errCode = (json.error?.code as string | undefined) ?? undefined;
  return { statusCode: res.statusCode, data: null, errorCode: errCode };
}

/** DELETE /locks/:id — короткий помощник. */
async function apiRelease(
  ctx: RestTestContext,
  key: string,
  lockId: string,
): Promise<{ statusCode: number; errorCode?: string }> {
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/networks/${ctx.networkId}/locks/${lockId}`,
    headers: { authorization: `Bearer ${key}` },
  });
  if (res.statusCode === 204) {
    return { statusCode: res.statusCode };
  }
  const json = res.json();
  return {
    statusCode: res.statusCode,
    errorCode: (json.error?.code as string | undefined) ?? undefined,
  };
}

/** GET /locks — короткий помощник. */
async function apiListLocks(
  ctx: RestTestContext,
  key: string,
  query: string = '',
): Promise<{ statusCode: number; data: LockRow[] }> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/locks${query}`,
    headers: { authorization: `Bearer ${key}` },
  });
  const json = res.json();
  return {
    statusCode: res.statusCode,
    data: (json.data as LockRow[] | undefined) ?? [],
  };
}

/** POST /locks/clear — короткий помощник. */
async function apiClearLocks(
  ctx: RestTestContext,
  key: string,
  userId: string,
): Promise<{ statusCode: number; cleared?: number; errorCode?: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/locks/clear`,
    headers: { authorization: `Bearer ${key}` },
    payload: { user_id: userId },
  });
  const json = res.json();
  if (res.statusCode === 200) {
    return { statusCode: res.statusCode, cleared: json.data.cleared as number };
  }
  return {
    statusCode: res.statusCode,
    errorCode: (json.error?.code as string | undefined) ?? undefined,
  };
}

describe(
  '/locks routes (task 2031df5e)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('acquire → list → release: happy path with one user', async () => {
      const ctx = await buildRestContext();
      try {
        // Создаём мысль, чтобы было что захватывать.
        const create = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Идея' },
        });
        assert.equal(create.statusCode, 201);
        const t = create.json().data as { id: string };

        // Acquire.
        const acq = await apiAcquire(
          ctx,
          ctx.adminKey,
          { entity_type: 'thought', entity_id: t.id },
          'cli-admin',
        );
        assert.equal(acq.statusCode, 200);
        assert.ok(acq.data !== null);
        assert.equal(acq.data?.entity_type, 'thought');
        assert.equal(acq.data?.entity_id, t.id);
        assert.equal(acq.data?.user_id, ctx.adminId);
        assert.equal(acq.data?.client_id, 'cli-admin');

        // List — захват виден.
        const list = await apiListLocks(ctx, ctx.adminKey);
        assert.equal(list.statusCode, 200);
        assert.equal(list.data.length, 1);
        assert.equal(list.data[0]?.id, acq.data?.id);

        // Release.
        const rel = await apiRelease(ctx, ctx.adminKey, acq.data!.id);
        assert.equal(rel.statusCode, 204);

        // Список пуст.
        const listAfter = await apiListLocks(ctx, ctx.adminKey);
        assert.equal(listAfter.data.length, 0);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('acquire повторно своим — идемпотентно (продление, тот же lock_id)', async () => {
      const ctx = await buildRestContext();
      try {
        const create = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Идея' },
        });
        const t = create.json().data as { id: string };

        const first = await apiAcquire(
          ctx,
          ctx.adminKey,
          { entity_type: 'thought', entity_id: t.id },
          'cli-1',
        );
        assert.equal(first.statusCode, 200);
        const second = await apiAcquire(
          ctx,
          ctx.adminKey,
          { entity_type: 'thought', entity_id: t.id },
          'cli-2',
        );
        assert.equal(second.statusCode, 200);
        assert.equal(second.data?.id, first.data?.id, 'lock id стабилен');
        assert.equal(second.data?.client_id, 'cli-2', 'client_id обновляется');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('acquire чужого объекта → 409 LOCKED', async () => {
      const ctx = await buildRestContext();
      try {
        const create = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Идея' },
        });
        const t = create.json().data as { id: string };

        // Admin захватывает.
        const adminAcq = await apiAcquire(
          ctx,
          ctx.adminKey,
          { entity_type: 'thought', entity_id: t.id },
        );
        assert.equal(adminAcq.statusCode, 200);

        // Другой пользователь пытается — отказ.
        const other = createPlainUser(ctx);
        // Делаем plain-юзера участником сети (admin уже участник; для REST
        // нужно членство — для admin-members оно уже есть).
        ctx.sys.addNetworkMember(ctx.networkId, other.userId, 'member', ctx.adminId);
        const foreignAcq = await apiAcquire(
          ctx,
          other.key,
          { entity_type: 'thought', entity_id: t.id },
        );
        assert.equal(foreignAcq.statusCode, 409);
        assert.equal(foreignAcq.errorCode, 'LOCKED');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('DELETE чужого захвата → 403, своего → 204', async () => {
      const ctx = await buildRestContext();
      try {
        const create = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Идея' },
        });
        const t = create.json().data as { id: string };

        const acq = await apiAcquire(
          ctx,
          ctx.adminKey,
          { entity_type: 'thought', entity_id: t.id },
        );
        assert.equal(acq.statusCode, 200);

        const other = createPlainUser(ctx);
        ctx.sys.addNetworkMember(ctx.networkId, other.userId, 'member', ctx.adminId);

        // Чужой release — 403.
        const foreign = await apiRelease(ctx, other.key, acq.data!.id);
        assert.equal(foreign.statusCode, 403);

        // Свой release — 204.
        const own = await apiRelease(ctx, ctx.adminKey, acq.data!.id);
        assert.equal(own.statusCode, 204);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('DELETE неизвестного lock_id → 404 LOCK_NOT_FOUND', async () => {
      const ctx = await buildRestContext();
      try {
        const rel = await apiRelease(ctx, ctx.adminKey, '00000000-0000-4000-8000-000000000000');
        assert.equal(rel.statusCode, 404);
        assert.equal(rel.errorCode, 'LOCK_NOT_FOUND');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('GET /locks фильтры по user_id и client_id', async () => {
      const ctx = await buildRestContext();
      try {
        // Создаём две мысли.
        const a = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'A' },
        });
        const b = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'B' },
        });
        const aId = (a.json().data as { id: string }).id;
        const bId = (b.json().data as { id: string }).id;

        const other = createPlainUser(ctx);
        ctx.sys.addNetworkMember(ctx.networkId, other.userId, 'member', ctx.adminId);

        await apiAcquire(ctx, ctx.adminKey, { entity_type: 'thought', entity_id: aId }, 'cli-1');
        await apiAcquire(ctx, other.key, { entity_type: 'thought', entity_id: bId }, 'cli-2');

        // Без фильтра — два захвата.
        const all = await apiListLocks(ctx, ctx.adminKey);
        assert.equal(all.data.length, 2);

        // Фильтр по user_id.
        const byAdmin = await apiListLocks(ctx, ctx.adminKey, `?user_id=${ctx.adminId}`);
        assert.equal(byAdmin.data.length, 1);
        assert.equal(byAdmin.data[0]?.user_id, ctx.adminId);

        // Фильтр по client_id.
        const byClient = await apiListLocks(ctx, ctx.adminKey, `?client_id=cli-2`);
        assert.equal(byClient.data.length, 1);
        assert.equal(byClient.data[0]?.user_id, other.userId);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('POST /locks/clear снимает все захваты участника', async () => {
      const ctx = await buildRestContext();
      try {
        // Создаём две мысли и admin захватывает обе.
        const a = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'A' },
        });
        const b = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'B' },
        });
        const aId = (a.json().data as { id: string }).id;
        const bId = (b.json().data as { id: string }).id;

        await apiAcquire(ctx, ctx.adminKey, { entity_type: 'thought', entity_id: aId });
        await apiAcquire(ctx, ctx.adminKey, { entity_type: 'thought', entity_id: bId });

        // Чужой пользователь выполняет «Снять все блокировки» для admin.
        const other = createPlainUser(ctx);
        ctx.sys.addNetworkMember(ctx.networkId, other.userId, 'member', ctx.adminId);

        const clear = await apiClearLocks(ctx, other.key, ctx.adminId);
        assert.equal(clear.statusCode, 200);
        assert.equal(clear.cleared, 2);

        // Список пуст.
        const list = await apiListLocks(ctx, ctx.adminKey);
        assert.equal(list.data.length, 0);

        // Теперь admin может снова захватить.
        const reacquire = await apiAcquire(
          ctx,
          ctx.adminKey,
          { entity_type: 'thought', entity_id: aId },
        );
        assert.equal(reacquire.statusCode, 200);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('two-user cooperative scenario: A acquires → B blocked → A releases → B ok', async () => {
      const ctx = await buildRestContext();
      try {
        const create = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Идея' },
        });
        const t = create.json().data as { id: string };

        const other = createPlainUser(ctx);
        ctx.sys.addNetworkMember(ctx.networkId, other.userId, 'member', ctx.adminId);

        // A (admin) берёт захват.
        const aAcq = await apiAcquire(
          ctx,
          ctx.adminKey,
          { entity_type: 'thought', entity_id: t.id },
        );
        assert.equal(aAcq.statusCode, 200);

        // B пытается править — 409 LOCKED.
        const bUpdateBlocked = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${t.id}`,
          headers: { authorization: `Bearer ${other.key}` },
          payload: { title: 'от B' },
        });
        assert.equal(bUpdateBlocked.statusCode, 409);
        assert.equal(bUpdateBlocked.json().error.code, 'LOCKED');

        // Чтение B — без блокировки.
        const bRead = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${t.id}`,
          headers: { authorization: `Bearer ${other.key}` },
        });
        assert.equal(bRead.statusCode, 200);
        assert.equal((bRead.json().data as { title: string }).title, 'Идея');

        // A отпускает.
        const aRelease = await apiRelease(ctx, ctx.adminKey, aAcq.data!.id);
        assert.equal(aRelease.statusCode, 204);

        // B правит — успех.
        const bUpdateOk = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${t.id}`,
          headers: { authorization: `Bearer ${other.key}` },
          payload: { title: 'от B после release' },
        });
        assert.equal(bUpdateOk.statusCode, 200);
        assert.equal(
          (bUpdateOk.json().data as { title: string }).title,
          'от B после release',
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('второй admin (cross-network) видит захваты того же network_id', async () => {
      // Членство проверяется по networkId; глобальный admin обходит проверку
      // и видит /locks — это поведение используется админ-инструментами.
      const ctx = await buildRestContext();
      try {
        const create = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Идея' },
        });
        const t = create.json().data as { id: string };

        const admin2 = createSecondAdminUser(ctx);
        // admin2 — глобальный admin, не нуждается в addNetworkMember.

        const acq = await apiAcquire(
          ctx,
          admin2.key,
          { entity_type: 'thought', entity_id: t.id },
        );
        assert.equal(acq.statusCode, 200);

        const list = await apiListLocks(ctx, admin2.key);
        assert.equal(list.statusCode, 200);
        assert.equal(list.data.length, 1);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
