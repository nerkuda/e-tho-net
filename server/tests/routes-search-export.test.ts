/**
 * Integration tests for the /search, /export and /jobs routes (task D6, D8)
 * via app.inject: search across groups with the legacy `scope=thoughts`
 * mapping, export job lifecycle (202 → done → download) and PDF rejection.
 * Phase P (task P2) adds .etnx export coverage: zip signature, archive
 * entries, manifest shape.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import yauzl from 'yauzl';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

const yauzlFromBuffer = promisify<
  Buffer,
  yauzl.Options,
  yauzl.ZipFile
>(yauzl.fromBuffer);

interface ZipEntrySummary {
  fileName: string;
  uncompressedSize: number;
}

/** List file entries of a zip buffer (directories skipped). */
async function listZipEntries(buffer: Buffer): Promise<ZipEntrySummary[]> {
  const zip = await yauzlFromBuffer(buffer, { lazyEntries: true });
  const out: ZipEntrySummary[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      if (!/\/$/.test(entry.fileName)) {
        out.push({ fileName: entry.fileName, uncompressedSize: entry.uncompressedSize });
      }
      zip.readEntry();
    });
    zip.on('end', () => resolve());
    zip.on('error', reject);
    zip.readEntry();
  });
  zip.close();
  return out;
}

/** Read one entry's contents from a zip buffer as a Buffer. */
async function readZipEntry(buffer: Buffer, fileName: string): Promise<Buffer> {
  const zip = await yauzlFromBuffer(buffer, { lazyEntries: true });
  return new Promise<Buffer>((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName === fileName) {
        zip.openReadStream(entry, (err, stream) => {
          if (err !== null) {
            reject(err);
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => resolve(Buffer.concat(chunks)));
          stream.on('error', reject);
        });
      } else {
        zip.readEntry();
      }
    });
    zip.on('end', () => reject(new Error(`entry not found: ${fileName}`)));
    zip.on('error', reject);
    zip.readEntry();
  });
}

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
        assert.match(String(download.headers['content-type'] ?? ''), /text\/markdown/);
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
        assert.match(String(htmlDownload.headers['content-type'] ?? ''), /text\/html/);

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

    it('export: .etnx job produces a valid zip with manifest.json (phase P, P2)', async () => {
      const ctx = await buildRestContext();
      try {
        const rootId = await createThought(ctx, 'Корень экспорта');
        const childId = await createThought(ctx, 'Потомок');

        // Link parent → child so include_subtree has something to walk.
        const link = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links`,
          headers: authHeaders(ctx),
          payload: { source_id: rootId, target_id: childId },
        });
        assert.equal(link.statusCode, 201);

        const start = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/export`,
          headers: authHeaders(ctx),
          payload: {
            thought_ids: [rootId],
            format: 'etnx',
            etnx: {
              include_types: true,
              include_attachments: true,
              include_chronology: true,
              include_subtree: true,
              subtree_depth: 1,
            },
          },
        });
        assert.equal(start.statusCode, 202);
        const jobId = (start.json().data as { job_id: string }).job_id;

        const download = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/jobs/${jobId}/download`,
          headers: authHeaders(ctx),
        });
        assert.equal(download.statusCode, 200);
        assert.match(String(download.headers['content-type'] ?? ''), /application\/zip/);
        assert.match(String(download.headers['content-disposition'] ?? ''), /\.etnx/);

        const raw = download.rawPayload;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string, 'binary');
        // Zip magic: PK\x03\x04
        assert.equal(buf[0], 0x50);
        assert.equal(buf[1], 0x4b);
        assert.equal(buf[2], 0x03);
        assert.equal(buf[3], 0x04);

        // Persist to disk and ask the system `unzip` (if available) whether
        // the archive is well-formed — this is the strongest cross-check
        // against any silent corruption along the archiver → Buffer → HTTP
        // → `app.inject` chain that the user's archive manager would also see.
        const onDisk = path.join(tmpdir(), `etnx-test-${jobId}.zip`);
        writeFileSync(onDisk, buf);
        try {
          execFileSync('unzip', ['-t', onDisk], { stdio: 'pipe' });
        } catch (e) {
          // Surface the `unzip` stderr so a CI failure is debuggable.
          const err = e as { stderr?: Buffer };
          const detail = err.stderr !== undefined ? err.stderr.toString('utf8') : '';
          assert.fail(`unzip -t rejected the .etnx archive: ${detail}`);
        }

        const entries = await listZipEntries(buf);
        const names = entries.map((e) => e.fileName);
        assert.ok(names.includes('manifest.json'));

        const manifestRaw = await readZipEntry(buf, 'manifest.json');
        const manifest = JSON.parse(manifestRaw.toString('utf8')) as Record<string, unknown>;
        assert.equal(manifest['format'], 'etnx');
        assert.equal(manifest['version'], '1.1');
        assert.equal(typeof manifest['exported_at'], 'string');
        const thoughts = manifest['thoughts'] as Array<{ id: string; title: string }>;
        assert.ok(thoughts.some((t) => t.id === rootId && t.title === 'Корень экспорта'));
        assert.ok(thoughts.some((t) => t.id === childId && t.title === 'Потомок'));
        const links = manifest['links'] as Array<{ source_id: string; target_id: string }>;
        assert.ok(
          links.some((l) => l.source_id === rootId && l.target_id === childId),
        );

        // Missing format → 422.
        const bad = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/export`,
          headers: authHeaders(ctx),
          payload: { thought_ids: [rootId] },
        });
        assert.equal(bad.statusCode, 422);

        // subtree_depth out of range → 422.
        const tooDeep = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/export`,
          headers: authHeaders(ctx),
          payload: {
            thought_ids: [rootId],
            format: 'etnx',
            etnx: { include_subtree: true, subtree_depth: 99 },
          },
        });
        assert.equal(tooDeep.statusCode, 422);

        // Unknown root id → 404.
        const missing = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/export`,
          headers: authHeaders(ctx),
          payload: { thought_ids: ['00000000-0000-0000-0000-000000000000'], format: 'etnx' },
        });
        assert.equal(missing.statusCode, 404);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
