/**
 * Сквозной REST-тест межсетевого копирования вложений (ошибка b83a7d89
 * «При копировании мысли между мыслесетями теряются вложения»).
 *
 * Проверяет маршрут `POST /networks/:networkId/thoughts/copy-batch` на свежем
 * коде сервера: файл вложения физически появляется в сети-получателе, копия
 * вложения ссылается на него, и файл отдаётся сервером (не 404 по пути).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { authHeaders, buildRestContext, closeRestContext, nativeAvailable } from './rest-helpers.js';
import { closeNetworkDb } from '../src/db/network-db.js';

describe(
  'POST /thoughts/copy-batch — межсетевое копирование вложений',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('физически переносит файл вложения в сеть-получатель', async () => {
      const ctx = await buildRestContext();
      let netB: string | null = null;
      try {
        // Сеть-источник A: мысль + загруженный на сервер файл.
        const thoughtA = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Источник' },
        });
        assert.equal(thoughtA.statusCode, 201);
        const thoughtAId = (thoughtA.json().data as { id: string }).id;

        const upload = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtAId}/attachments/file`,
          headers: authHeaders(ctx),
          payload: {
            title: 'План',
            mime_type: 'text/plain',
            data_base64: Buffer.from('cross-network payload').toString('base64'),
          },
        });
        assert.equal(upload.statusCode, 201);
        const sourcePath = (upload.json().data as { file_path: string }).file_path;
        assert.ok(existsSync(sourcePath), 'исходный файл должен лежать в сети A');

        // Сеть-получатель B с целевой "облаком".
        const createdB = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: authHeaders(ctx),
          payload: { display_name: 'Target Net' },
        });
        assert.equal(createdB.statusCode, 201);
        netB = (createdB.json().data as { id: string }).id;

        const pasteTarget = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${netB}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Paste target' },
        });
        assert.equal(pasteTarget.statusCode, 201);
        const pasteTargetId = (pasteTarget.json().data as { id: string }).id;

        const copy = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${netB}/thoughts/copy-batch`,
          headers: authHeaders(ctx),
          payload: {
            source_network_id: ctx.networkId,
            parent_thought_id: pasteTargetId,
            thoughts: [
              {
                source_id: randomUUID(),
                thought: {
                  title: 'Копия A',
                  synonyms: [],
                  type: { id: null, name: null },
                  icon: null,
                  icon_kind: 'emoji',
                  active: true,
                  fg_color: null,
                  bg_color: null,
                  font_bold: null,
                  font_italic: null,
                  font_underline: null,
                  font_strike: null,
                },
                attachments: [
                  {
                    kind: 'file',
                    file_path: sourcePath,
                    mime_type: 'text/plain',
                    title: 'План',
                  },
                ],
              },
            ],
            links: [],
          },
        });
        assert.equal(copy.statusCode, 200, copy.body);
        const created = (copy.json().data as { created_attachments: Array<{ file_path: string; kind: string }> })
          .created_attachments;
        assert.equal(created.length, 1);
        const copiedPath = created[0]!.file_path;
        assert.notEqual(copiedPath, sourcePath, 'копия не должна ссылаться на файл сети A');
        assert.equal(path.dirname(copiedPath), path.join(ctx.dataDir, 'networks', netB, 'attachments'));
        assert.ok(existsSync(copiedPath), 'файл копии должен быть создан');
        assert.equal(readFileSync(copiedPath).toString(), 'cross-network payload');

        // Сервер отдаёт файл копии (раньше здесь был HTTP 404 по `path`).
        const raw = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${netB}/attachments/raw?path=${encodeURIComponent(copiedPath)}`,
          headers: authHeaders(ctx),
        });
        assert.equal(raw.statusCode, 200, raw.body);
        assert.equal(raw.body, 'cross-network payload');

        // Исходный файл не тронут.
        assert.equal(readFileSync(sourcePath).toString(), 'cross-network payload');
      } finally {
        if (netB !== null) closeNetworkDb(netB);
        await closeRestContext(ctx);
      }
    });
  },
);
