/**
 * Direct smoke test for `exportToEtnx` (phase P, task P2). Skips HTTP so we
 * can isolate whether the file written by `archiver` is a valid zip on disk.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import yauzl from 'yauzl';
import type { Options as YauzlOptions, ZipFile } from 'yauzl';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
} from './rest-helpers.js';
import { exportToEtnx } from '../src/domain/export-service.js';

/** `promisify` picks the callback-only overload of `fromBuffer`, losing `options` — type it explicitly. */
const yauzlFromBuffer = promisify(yauzl.fromBuffer) as (
  buffer: Buffer,
  options: YauzlOptions,
) => Promise<ZipFile>;

describe(
  'exportToEtnx direct (P2 debug)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('writes a valid zip on disk that yauzl can open', async () => {
      const ctx = await buildRestContext();
      try {
        // Create one thought via the API.
        const created = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Тест' },
        });
        assert.equal(created.statusCode, 201);
        const thoughtId = (created.json().data as { id: string }).id;

        const outPath = path.join(tmpdir(), `etnx-debug-${randomUUID()}.zip`);
        const source = {
          network_id: ctx.networkId,
          network_name: ctx.networkId,
          user_id: 'test-user',
        };
        const result = await exportToEtnx(
          ctx.ndb,
          [thoughtId],
          { include_attachments: true, include_chronology: true, include_types: true },
          source,
          outPath,
        );

        assert.ok(existsSync(outPath), `output file should exist at ${outPath}`);
        const size = statSync(outPath).size;
        assert.ok(size > 0, 'output file should be non-empty');
        console.log(`[debug] file size: ${size} bytes (export returned ${result.size})`);

        // Open with yauzl — this is the real test of zip validity.
        const zip = await yauzlFromBuffer(readFileSync(outPath), { lazyEntries: true });
        const entries: string[] = [];
        await new Promise<void>((resolve, reject) => {
          zip.on('entry', (entry) => {
            entries.push(entry.fileName);
            zip.readEntry();
          });
          zip.on('end', resolve);
          zip.on('error', reject);
          zip.readEntry();
        });
        zip.close();
        console.log(`[debug] zip entries: ${entries.join(', ')}`);
        assert.ok(entries.includes('manifest.json'), 'manifest.json must be present');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
