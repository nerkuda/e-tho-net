/**
 * `.etnx` переносит пометку корзины мысли (0.11.1, ошибка b3e0a1ee).
 *
 * Манифест несёт полный DTO `Thought` (включая `marked_for_deletion`/`_at`/
 * `_by`), но импортёр не писал эти поля ни при создании, ни при обновлении —
 * помеченная мысль после раунд-трипа приезжала живой. Тест проходит полный
 * сценарий: пометить мысль в корзину → экспорт сети → импорт в чистую сеть →
 * импортированная мысль видна в `GET /trash`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { logger } from '../src/logger.js';
import { exportToEtnx } from '../src/domain/export-service.js';
import { importFromEtnx, readManifestFromBuffer } from '../src/domain/import-service.js';
import { updateThought } from '../src/domain/thought-service.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Создать мысль через REST и вернуть её id. */
async function createThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json().data as { id: string }).id;
}

describe(
  '.etnx переносит пометку корзины мысли (b3e0a1ee)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('мысль, помеченная на удаление, остаётся в корзине после раунд-трипа', async () => {
      const src = await buildRestContext();
      const dst = await buildRestContext();
      const outPath = path.join(tmpdir(), `etnx-thought-trash-${randomUUID()}.zip`);
      try {
        const thoughtId = await createThought(src, 'Мысль для корзины RT');
        updateThought(src.ndb, thoughtId, { marked_for_deletion: true }, undefined, src.adminId);

        await exportToEtnx(
          src.ndb,
          [thoughtId],
          { include_attachments: true, include_chronology: true, include_types: true },
          { network_id: src.networkId, network_name: src.networkId, user_id: src.adminId },
          outPath,
        );
        const manifest = await readManifestFromBuffer(readFileSync(outPath), logger);
        assert.equal(
          manifest.thoughts[0]?.marked_for_deletion,
          true,
          'пометка уехала в манифест',
        );

        const result = await importFromEtnx(
          dst.ndb,
          readFileSync(outPath),
          { actorUserId: dst.adminId, parentThoughtId: dst.homeId },
          logger,
        );
        const importedId = result.thoughtIdRemap.get(thoughtId);
        assert.ok(importedId !== undefined, 'мысль импортирована (remap есть)');

        const row = dst.ndb
          .prepare(
            'SELECT marked_for_deletion, marked_for_deletion_at, marked_for_deletion_by FROM thoughts WHERE id = ?',
          )
          .get(importedId) as
          | {
              marked_for_deletion: number;
              marked_for_deletion_at: string | null;
              marked_for_deletion_by: string | null;
            }
          | undefined;
        assert.ok(row !== undefined, 'импортированная мысль есть в БД');
        assert.equal(row.marked_for_deletion, 1, 'пометка корзины восстановлена');
        assert.ok(
          row.marked_for_deletion_at !== null,
          'время пометки перенесено',
        );
        assert.ok(row.marked_for_deletion_by !== null, 'автор пометки перенесён');

        // Импортированная мысль видна в корзине целевой сети (GET /trash).
        const trash = await dst.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${dst.networkId}/trash`,
          headers: authHeaders(dst),
        });
        assert.equal(trash.statusCode, 200, trash.body);
        const entries = (trash.json().data as { thoughts: { id: string }[] }).thoughts;
        assert.ok(
          entries.some((t) => t.id === importedId),
          'импортированная мысль в корзине целевой сети',
        );
      } finally {
        rmSync(outPath, { force: true });
        await closeRestContext(src);
        await closeRestContext(dst);
      }
    });
  },
);
