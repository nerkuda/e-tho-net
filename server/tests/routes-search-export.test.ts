/**
 * Integration tests for the /search, /export and /jobs routes (task D6, D8)
 * via app.inject: search across groups with the legacy `scope=thoughts`
 * mapping, export job lifecycle (202 → done → download) and PDF rejection.
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

/** Create a thought via the API and return its id. */
async function createThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201);
  return (res.json().data as { id: string }).id;
}

describe(
  '/search, /export and /jobs routes',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('search finds names and comment texts; legacy scope=thoughts maps to names+texts', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Квантовая физика');

        const comment = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'permanent', body_md: 'Квантовая запутанность — явление.' },
        });
        assert.equal(comment.statusCode, 201);

        // Names group.
        const names = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/search?q=${encodeURIComponent('квантовая')}&scope=names`,
          headers: authHeaders(ctx),
        });
        assert.equal(names.statusCode, 200);
        const namesData = names.json().data as {
          by_names: Array<{ thought_id: string }>;
          by_texts: unknown[];
        };
        assert.ok(namesData.by_names.some((h) => h.thought_id === thoughtId));
        assert.equal(namesData.by_texts.length, 0);

        // Texts group.
        const texts = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/search?q=${encodeURIComponent('запутанность')}&scope=texts`,
          headers: authHeaders(ctx),
        });
        assert.equal(texts.statusCode, 200);
        assert.ok(
          (texts.json().data as { by_texts: Array<{ thought_id: string }> }).by_texts.some(
            (h) => h.thought_id === thoughtId,
          ),
        );

        // Legacy scope=thoughts → both groups populated.
        const legacy = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/search?q=${encodeURIComponent('квантовая')}&scope=thoughts`,
          headers: authHeaders(ctx),
        });
        assert.equal(legacy.statusCode, 200);
        const legacyData = legacy.json().data as {
          by_names: unknown[];
          by_texts: unknown[];
        };
        assert.ok(legacyData.by_names.length > 0);
        assert.ok(legacyData.by_texts.length > 0);

        // Missing q → 422.
        const noQ = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/search`,
          headers: authHeaders(ctx),
        });
        assert.equal(noQ.statusCode, 422);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('export: markdown job goes 202 → done → downloadable; pdf rejected (422)', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Экспортируемая');

        const start = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/export`,
          headers: authHeaders(ctx),
          payload: { thought_ids: [thoughtId], format: 'markdown' },
        });
        assert.equal(start.statusCode, 202);
        const jobId = (start.json().data as { job_id: string }).job_id;

        const status = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/jobs/${jobId}`,
          headers: authHeaders(ctx),
        });
        assert.equal(status.statusCode, 200);
        const job = status.json().data as { status: string; download_url: string };
        assert.equal(job.status, 'done');
        assert.equal(job.download_url, `/api/v1/jobs/${jobId}/download`);

        const download = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/jobs/${jobId}/download`,
          headers: authHeaders(ctx),
        });
        assert.equal(download.statusCode, 200);
        assert.match(download.headers['content-type'] ?? '', /text\/markdown/);
        assert.ok(download.body.includes('# Экспорт мыслесети ETN'));
        assert.ok(download.body.includes('## Экспортируемая'));

        // HTML export carries an html content type.
        const htmlStart = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/export`,
          headers: authHeaders(ctx),
          payload: { thought_ids: [thoughtId], format: 'html' },
        });
        assert.equal(htmlStart.statusCode, 202);
        const htmlJobId = (htmlStart.json().data as { job_id: string }).job_id;
        const htmlDownload = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/jobs/${htmlJobId}/download`,
          headers: authHeaders(ctx),
        });
        assert.equal(htmlDownload.statusCode, 200);
        assert.match(htmlDownload.headers['content-type'] ?? '', /text\/html/);

        // PDF is not implemented on MVP → 422.
        const pdf = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/export`,
          headers: authHeaders(ctx),
          payload: { thought_ids: [thoughtId], format: 'pdf' },
        });
        assert.equal(pdf.statusCode, 422);

        // Unknown job → 404.
        const unknownJob = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/jobs/00000000-0000-0000-0000-000000000000',
          headers: authHeaders(ctx),
        });
        assert.equal(unknownJob.statusCode, 404);

        // Jobs require authentication.
        const noKey = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/jobs/${jobId}`,
        });
        assert.equal(noKey.statusCode, 401);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
