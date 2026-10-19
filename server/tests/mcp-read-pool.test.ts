/**
 * MCP-паритет при включённом reader-пуле (задача 514dc30f, ошибка 49e05ea0).
 *
 * DoD: `etn.thoughts.resolve|neighbors|find_duplicates`, `etn.comments.get` и
 * `etn.thoughts.subgraph` (превью комментариев) отдают ТОТ ЖЕ ответ, когда
 * чтение уходит в reader-пул, и когда фасад деградирует в синхронный путь.
 *
 * Прогон: один и тот же набор вызовов выполняется дважды — сначала с
 * процессным пулом, затем после `closeReaderPool()` (синхронный фолбэк).
 * Сравнивается JSON ответов инструментов.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { BASE_LAYER_ID } from '@etn/shared';

import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
  type McpTestContext,
} from './mcp-helpers.js';
import { openNetworkDb } from '../src/db/network-db.js';
import { closeReaderPool, configureReaderPool } from '../src/db/reader-pool.js';
import { createComment } from '../src/domain/comment-service.js';

describe(
  'MCP: тяжёлые чтения через reader-пул дают тот же ответ',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let ctx: McpTestContext;
    let ids: string[] = [];
    let commentIds: string[] = [];

    beforeEach(async () => {
      ctx = await buildMcpContext();
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const now = new Date().toISOString();
      const insertThought = ndb.prepare(
        `INSERT INTO thoughts
           (id, layer_id, title, title_norm, type_id, icon, icon_kind,
            icon_attachment_id, active, is_protected, is_root,
            marked_for_deletion, version, created_at, updated_at,
            created_by, updated_by, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, NULL, NULL, 'emoji', NULL, 1, 0, 0,
                 0, 1, ?, ?, ?, ?, ?, ?)`,
      );
      const insertSynonym = ndb.prepare(
        'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm, layer_id) VALUES (?, ?, ?, ?)',
      );
      const insertLink = ndb.prepare(
        `INSERT INTO links
           (id, layer_id, source_id, target_id, type_id, position, active, marked_for_deletion,
            version, created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, NULL, ?, 1, 0, 1, ?, ?, ?, ?, 0, 0)`,
      );
      ids = Array.from({ length: 105 }, () => randomUUID());
      ndb.transaction(() => {
        for (const [i, id] of ids.entries()) {
          const title = `Пул-мысль ${i}`;
          insertThought.run(
            id,
            BASE_LAYER_ID,
            title,
            title.toLowerCase(),
            now,
            now,
            ctx.adminId,
            ctx.adminId,
            Date.now(),
            Date.now(),
          );
          insertSynonym.run(id, `пул-терм-${i}`, `пул-терм-${i}`, BASE_LAYER_ID);
        }
        let seq = 0;
        for (let i = 1; i < 20; i += 1) {
          insertLink.run(randomUUID(), BASE_LAYER_ID, ids[0]!, ids[i]!, seq++, now, now, ctx.adminId, ctx.adminId);
        }
        for (let i = 20; i < 30; i += 1) {
          insertLink.run(randomUUID(), BASE_LAYER_ID, ids[i]!, ids[0]!, seq++, now, now, ctx.adminId, ctx.adminId);
        }
      });
      commentIds = [
        createComment(
          ndb,
          'thought',
          ids[0]!,
          { kind: 'permanent', title: null, body_md: 'Постоянный текст' },
          ctx.adminId,
        ).id,
        createComment(
          ndb,
          'thought',
          ids[1]!,
          { kind: 'permanent', title: null, body_md: 'Второй постоянный' },
          ctx.adminId,
        ).id,
      ];
      // Соединение регистра сети держит MCP-рантайм: не закрываем его —
      // `closeMcpContext` закроет все соединения сети.
      configureReaderPool({ size: 2, taskTimeoutMs: 60_000 });
    });

    afterEach(async () => {
      await closeReaderPool();
      await closeMcpContext(ctx);
    });

    /** Все целевые вызовы одним пакетом (порядок фиксирован). */
    async function runReads(handle: Awaited<ReturnType<typeof connectMcpClient>>): Promise<unknown[]> {
      const args = (name: string, rest: Record<string, unknown>) =>
        handle.client.callTool({ name, arguments: { network_id: ctx.networkId, ...rest } });

      const results = [
        await args('etn.thoughts.resolve', { thought_ids: ids.slice(0, 100) }),
        await args('etn.thoughts.neighbors', { thought_id: ids[0], dir: 'both' }),
        await args('etn.thoughts.neighbors', { thought_id: ids[0], dir: 'children', depth: 2 }),
        await args('etn.thoughts.find_duplicates', { title: 'Пул-мысль 7' }),
        await args('etn.comments.get', { thought_id: ids[0] }),
        await args('etn.comments.get', { comment_id: commentIds[0] }),
        await args('etn.thoughts.subgraph', {
          seed_ids: [ids[0]],
          radius: 1,
          include_comments: true,
        }),
      ];
      return results.map((r, index) => {
        try {
          return toolJson<unknown>(r);
        } catch {
          throw new Error(`instrument #${index} returned a non-JSON error: ${toolText(r)}`);
        }
      });
    }

    it('пул и синхронный фолбэк отдают идентичный JSON', async () => {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const pooled = await runReads(handle);
        // Отключаем пул: тот же код идёт синхронным путём (деградация фасада).
        await closeReaderPool();
        const sync = await runReads(handle);

        for (const [index, viaPool] of pooled.entries()) {
          assert.deepEqual(
            viaPool,
            sync[index],
            `ответ инструмента №${index} разошёлся между пулом и синхронным путём`,
          );
        }
        // Непустые ответы: паритет не должен быть паритетом пустоты.
        const resolve = pooled[0] as { items: unknown[]; missing: unknown[] };
        assert.equal(resolve.items.length, 100);
        const neighbors = pooled[1] as { total: number; neighbors: unknown[] };
        assert.ok(neighbors.total > 0);
        assert.ok(neighbors.neighbors.length > 0);
        const duplicates = pooled[3] as Array<{ title: string }>;
        assert.ok(duplicates.length > 0);
        const commentsByThought = pooled[4] as { permanent: { body_md: string } };
        assert.equal(commentsByThought.permanent.body_md, 'Постоянный текст');
        const commentById = pooled[5] as { body_md: string };
        assert.equal(commentById.body_md, 'Постоянный текст');
        const subgraph = pooled[6] as { comments?: unknown[] };
        assert.ok((subgraph.comments?.length ?? 0) > 0, 'превью комментариев в подграфе');
      } finally {
        await handle.close();
      }
    });
  },
);
