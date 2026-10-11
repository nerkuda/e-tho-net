/**
 * Штатная выгрузка `.etnx` в файл (задача 99c16033, версия 0.12.2).
 *
 * Покрывает уточнённый DoD предполёта:
 *   1. MCP `export.subgraph` с `destination: { kind: "etnx_file", path }` —
 *      сервер пишет архив по пути и возвращает `{ path, size, counts }` БЕЗ
 *      `content_b64`; без `destination` поведение прежнее (base64).
 *   2. Безопасность: путь абсолютный; существующий файл — только при
 *      `overwrite: true`; отсутствующий каталог / относительный путь /
 *      `destination` без `format: etnx` → `VALIDATION_ERROR`.
 *   3. REST `GET /jobs/:id/download` — повторяемая потоковая выдача с
 *      `content-length` и именем `etn-<network>.etnx`.
 *   4. `subtree_depth` до 20 согласован REST↔MCP.
 *
 * Пропускается, если нативный биндинг `better-sqlite3` недоступен.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';
import yauzl from 'yauzl';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';
import {
  buildMcpContext,
  callOp,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  toolJson,
  toolText,
} from './mcp-helpers.js';

/** Temp dirs created by this suite — removed in `after`. */
const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'etnx-dest-'));
  tempDirs.push(dir);
  return dir;
}

const yauzlFromBuffer = promisify(yauzl.fromBuffer) as (
  buffer: Buffer,
  options: yauzl.Options,
) => Promise<yauzl.ZipFile>;

/** Список записей zip-буфера (каталоги пропускаются). */
async function listZipEntries(buffer: Buffer): Promise<string[]> {
  const zip = await yauzlFromBuffer(buffer, { lazyEntries: true });
  const names: string[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      if (!/\/$/.test(entry.fileName)) names.push(entry.fileName);
      zip.readEntry();
    });
    zip.on('end', () => resolve());
    zip.on('error', reject);
    zip.readEntry();
  });
  zip.close();
  return names;
}

describe(
  'MCP export.subgraph destination=etnx_file (99c16033)',
  { skip: !nativeAvailable() },
  () => {
    it('пишет .etnx по пути и возвращает path/size/counts без content_b64', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const root = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Корень выгрузки',
            link: { direction: 'parent', target_thought_id: ctx.homeId },
          });

          const dir = tempDir();
          const target = path.join(dir, 'slice.etnx');

          const res = await callOp(handle.client, 'export.subgraph', {
            network_id: ctx.networkId,
            seed_ids: [root.id],
            radius: 0,
            format: 'etnx',
            destination: { kind: 'etnx_file', path: target },
          });
          assert.equal(res.isError, undefined, toolText(res));
          const data = toolJson<{
            format: string;
            path?: string;
            size?: number;
            counts?: Record<string, number>;
            content_b64?: string;
          }>(res);

          assert.equal(data.format, 'etnx');
          assert.equal(data.path, target);
          assert.equal(data.content_b64, undefined, 'при destination base64 в ответе быть не должно');
          assert.ok((data.size ?? 0) > 0, 'size должен быть положительным');
          assert.equal(data.size, statSync(target).size, 'size совпадает с размером файла на диске');
          assert.ok(existsSync(target), 'файл должен быть записан по указанному пути');
          assert.equal(typeof data.counts?.thoughts, 'number');
          assert.ok((data.counts?.thoughts ?? 0) >= 1);
          assert.ok((data.counts?.thought_types ?? 0) >= 1);

          // Архив валиден: открывается как zip и содержит manifest.json.
          const names = await listZipEntries(readFileSync(target));
          assert.ok(names.includes('manifest.json'), names.join(', '));
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('крупный срез: файл пишется без base64, counts отражает подграф', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          // 30 мыслей прямыми детьми HOME — воспроизводит сценарий «большой
          // сети» без base64 в ответе (DoD предполёта).
          const ids: string[] = [];
          for (let i = 0; i < 30; i += 1) {
            const created = await createThoughtViaWrite(handle.client, ctx.networkId, {
              title: `Узел ${i}`,
              link: { direction: 'parent', target_thought_id: ctx.homeId },
            });
            ids.push(created.id);
          }

          const dir = tempDir();
          const target = path.join(dir, 'big.etnx');
          const res = await callOp(handle.client, 'export.subgraph', {
            network_id: ctx.networkId,
            seed_ids: [ctx.homeId],
            radius: 0,
            format: 'etnx',
            etnx_options: { include_subtree: true, subtree_depth: 1 },
            destination: { kind: 'etnx_file', path: target },
          });
          assert.equal(res.isError, undefined, toolText(res));
          const data = toolJson<{
            content_b64?: string;
            size: number;
            counts: Record<string, number>;
          }>(res);
          assert.equal(data.content_b64, undefined, 'в ответе не должно быть base64');
          assert.ok((data.counts.thoughts ?? 0) >= ids.length + 1, 'подграф должен включать всю цепочку');
          assert.ok(data.size > 0);
          assert.ok(statSync(target).size === data.size);
          const names = await listZipEntries(readFileSync(target));
          assert.ok(names.includes('manifest.json'));
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('без destination формат etnx по-прежнему отдаёт content_b64 (обратная совместимость)', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const root = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Корень base64',
            link: { direction: 'parent', target_thought_id: ctx.homeId },
          });
          const res = await callOp(handle.client, 'export.subgraph', {
            network_id: ctx.networkId,
            seed_ids: [root.id],
            radius: 0,
            format: 'etnx',
          });
          assert.equal(res.isError, undefined, toolText(res));
          const data = toolJson<{ content_b64?: string; path?: string }>(res);
          assert.equal(typeof data.content_b64, 'string');
          assert.equal(data.path, undefined);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('ошибки пути: относительный путь, отсутствующий каталог, существующий файл без overwrite', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const root = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Корень проверок',
            link: { direction: 'parent', target_thought_id: ctx.homeId },
          });
          const base = {
            network_id: ctx.networkId,
            seed_ids: [root.id],
            radius: 0,
            format: 'etnx',
          } as const;

          // Относительный путь → VALIDATION_ERROR.
          const rel = await callOp(handle.client, 'export.subgraph', {
            ...base,
            destination: { kind: 'etnx_file', path: 'relative/slice.etnx' },
          });
          assert.equal(rel.isError, true);
          assert.match(toolText(rel), /VALIDATION_ERROR/);

          // Отсутствующий каталог → VALIDATION_ERROR.
          const dir = tempDir();
          const missingDir = path.join(dir, 'nope', 'slice.etnx');
          const noDir = await callOp(handle.client, 'export.subgraph', {
            ...base,
            destination: { kind: 'etnx_file', path: missingDir },
          });
          assert.equal(noDir.isError, true);
          assert.match(toolText(noDir), /VALIDATION_ERROR/);

          // Существующий файл без overwrite → VALIDATION_ERROR, файл не тронут.
          const existing = path.join(dir, 'exists.etnx');
          writeFileSync(existing, 'not-a-zip');
          const clash = await callOp(handle.client, 'export.subgraph', {
            ...base,
            destination: { kind: 'etnx_file', path: existing },
          });
          assert.equal(clash.isError, true);
          assert.match(toolText(clash), /VALIDATION_ERROR/);
          assert.equal(readFileSync(existing, 'utf8'), 'not-a-zip', 'файл не должен перезаписываться');

          // overwrite: true → успех.
          const overwritten = await callOp(handle.client, 'export.subgraph', {
            ...base,
            destination: { kind: 'etnx_file', path: existing, overwrite: true },
          });
          assert.equal(overwritten.isError, undefined, toolText(overwritten));
          assert.ok(statSync(existing).size > 'not-a-zip'.length);

          // destination без format: etnx → VALIDATION_ERROR.
          const wrongFormat = await callOp(handle.client, 'export.subgraph', {
            network_id: ctx.networkId,
            seed_ids: [root.id],
            radius: 0,
            destination: { kind: 'etnx_file', path: path.join(dir, 'md.etnx') },
          });
          assert.equal(wrongFormat.isError, true);
          assert.match(toolText(wrongFormat), /VALIDATION_ERROR/);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);

describe(
  'REST /jobs/:id/download: потоковая повторяемая выдача .etnx (99c16033)',
  { skip: !nativeAvailable() },
  () => {
    async function startEtnxExport(ctx: RestTestContext, rootId: string): Promise<string> {
      const start = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/export`,
        headers: authHeaders(ctx),
        payload: { thought_ids: [rootId], format: 'etnx' },
      });
      assert.equal(start.statusCode, 202);
      return (start.json().data as { job_id: string }).job_id;
    }

    it('скачивание повторяемо до TTL, есть content-length и имя etn-<network>.etnx', async () => {
      const ctx = await buildRestContext();
      try {
        const created = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Корень REST-выгрузки' },
        });
        assert.equal(created.statusCode, 201);
        const rootId = (created.json().data as { id: string }).id;

        const jobId = await startEtnxExport(ctx, rootId);

        const first = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/jobs/${jobId}/download`,
          headers: authHeaders(ctx),
        });
        assert.equal(first.statusCode, 200, first.body);
        assert.match(String(first.headers['content-type'] ?? ''), /application\/zip/);
        assert.ok(Number(first.headers['content-length'] ?? 0) > 0, 'content-length обязателен');
        assert.match(
          String(first.headers['content-disposition'] ?? ''),
          /filename="etn-.*\.etnx"/,
          'имя файла должно быть etn-<network>.etnx',
        );

        // Повторное скачивание той же джобы до истечения TTL — тоже 200 и теми же байтами.
        const second = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/jobs/${jobId}/download`,
          headers: authHeaders(ctx),
        });
        assert.equal(second.statusCode, 200, 'скачивание должно быть повторяемым');
        assert.deepEqual(second.rawPayload, first.rawPayload, 'повторная выдача — те же байты');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('REST принимает subtree_depth до 20 (паритет с MCP)', async () => {
      const ctx = await buildRestContext();
      try {
        const created = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Корень глубины' },
        });
        const rootId = (created.json().data as { id: string }).id;

        const deep = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/export`,
          headers: authHeaders(ctx),
          payload: {
            thought_ids: [rootId],
            format: 'etnx',
            etnx: { include_subtree: true, subtree_depth: 20 },
          },
        });
        assert.equal(deep.statusCode, 202, deep.body);

        // 21 — по-прежнему вне диапазона.
        const tooDeep = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/export`,
          headers: authHeaders(ctx),
          payload: {
            thought_ids: [rootId],
            format: 'etnx',
            etnx: { include_subtree: true, subtree_depth: 21 },
          },
        });
        assert.equal(tooDeep.statusCode, 422);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
