/**
 * End-to-end scenario test (task I1, docs/09-scenarios.md).
 *
 * Walks a realistic user journey against a real server: create a network, add
 * thoughts with synonyms via `create_link`, dedupe lookups, comments, search,
 * batch operations, export — and then verifies realtime delivery between two
 * users: network-audience events reach the other participant, user-audience
 * (L3) events do not.
 *
 * Skipped entirely when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import { WebSocket } from 'ws';

import {
  buildRestContext,
  closeRestContext,
  authHeaders,
  type RestTestContext,
} from './rest-helpers.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe(
  'E2E scenarios (I1)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('full journey: network → thoughts → links → comments → search → export', async () => {
      const ctx: RestTestContext = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;

        // C1: create a thought with a child via create_link + synonyms.
        const created = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts`,
          headers: h,
          payload: {
            title: 'Иванов Иван',
            synonyms: ['Ваня', 'Иваныч'],
            create_link: { direction: 'child', target_thought_id: ctx.homeId },
          },
        });
        assert.equal(created.statusCode, 201);
        const ivanov = created.json().data as { id: string; title: string; version: number };

        // D1: permanent comment.
        const comment = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts/${ivanov.id}/comments`,
          headers: h,
          payload: { kind: 'permanent', body_md: 'Сотрудник **фирмы**.' },
        });
        assert.equal(comment.statusCode, 201);

        // B3: search by a synonym finds the thought in by_names.
        const search = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/search?q=Ваня`,
          headers: h,
        });
        assert.equal(search.statusCode, 200);
        const names = (search.json().data as { by_names: Array<{ thought_id: string }> }).by_names;
        assert.ok(names.some((n) => n.thought_id === ivanov.id));

        // H14 helper: duplicates by title/synonym.
        const dups = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/thoughts/duplicates?title=Ваня`,
          headers: h,
        });
        assert.equal(dups.statusCode, 200);

        // B1: focus on HOME shows Иванов as a child.
        const focus = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts/${ctx.homeId}/focus`,
          headers: h,
        });
        assert.equal(focus.statusCode, 200);
        const children = (focus.json().data as { children: Array<{ id: string }> }).children;
        assert.ok(children.some((c) => c.id === ivanov.id));

        // E2: batch set_inactive.
        const batch = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts/batch`,
          headers: h,
          payload: { ids: [ivanov.id], op: 'set_inactive' },
        });
        assert.equal(batch.statusCode, 200);

        // E3: export to markdown → 202 + job done.
        const exp = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/export`,
          headers: h,
          payload: { thought_ids: [ctx.homeId, ivanov.id], format: 'markdown' },
        });
        assert.equal(exp.statusCode, 202);
        const jobId = (exp.json().data as { job_id: string }).job_id;
        const job = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/jobs/${jobId}`,
          headers: h,
        });
        assert.equal((job.json().data as { status: string }).status, 'done');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('REST thoughts/query rejects unknown body keys with 422 (0.4.3)', async () => {
      const ctx: RestTestContext = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;

        // A valid body works.
        const ok = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts/query`,
          headers: h,
          payload: { keywords: 'x', limit: 100 },
        });
        assert.equal(ok.statusCode, 200);

        // The MCP filter name `in_subtree_of` must NOT be silently ignored:
        // it used to return 200 with an empty page and mislead the caller.
        const bad = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts/query`,
          headers: h,
          payload: { in_subtree_of: ctx.homeId, limit: 100 },
        });
        assert.equal(bad.statusCode, 422);
        const err = bad.json().error as {
          code: string;
          details?: { fields?: string[]; allowed?: string[] };
        };
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.deepEqual(err.details?.fields, ['in_subtree_of']);
        assert.ok(err.details?.allowed?.includes('parent_ids'));
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('realtime: network events reach the other user, user-audience events do not', async () => {
      const ctx = await buildRestContext();
      const app = ctx.app;

      // Second user (member, not owner) with its own key + WS connection.
      const memberId = randomUUID();
      ctx.sys.createUser({
        id: memberId,
        username: 'member',
        displayName: 'Member',
        isAdmin: false,
      });
      const gen = generateApiKey();
      ctx.sys.createApiKey({
        id: randomUUID(),
        userId: memberId,
        label: 'member',
        keyHash: hashApiKey(gen.key),
        keyPrefix: gen.keyPrefix,
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/members`,
        headers: authHeaders(ctx),
        payload: { user_id: memberId },
      });

      // Owner's second client (same user_id, different client_id) — should get
      // L3 audience=user events too.
      await app.listen({ host: '127.0.0.1', port: 0 });
      const port = (app.server.address() as { port: number }).port;

      const received: Array<{ type: string; audience: string }> = [];
      const memberWs = new WebSocket(
        `ws://127.0.0.1:${port}/api/v1/realtime?network_id=${ctx.networkId}`,
        { headers: { authorization: `Bearer ${gen.key}`, 'client-id': 'member-client' } },
      );
      await new Promise<void>((resolve, reject) => {
        memberWs.once('open', resolve);
        memberWs.once('error', reject);
      });
      memberWs.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; audience: string };
        if (typeof msg.type === 'string') received.push(msg);
      });

      // Owner creates a thought → network event must reach the member.
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/thoughts`,
        headers: authHeaders(ctx),
        payload: { title: 'Общая мысль' },
      });
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(
        received.some((e) => e.type === 'thought.created'),
        'network-audience event reaches another member',
      );

      // Owner changes a per-user focus preference → user-audience event must NOT
      // reach the member.
      const before = received.length;
      await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/focus-preferences`,
        headers: authHeaders(ctx),
        payload: { dir: 'children', sort: 'alpha', order: 'asc' },
      });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(received.length, before, 'user-audience event is not delivered to another user');

      memberWs.close();
      await app.close();
      await closeRestContext(ctx);
    });
  },
);
