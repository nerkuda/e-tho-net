/**
 * Тесты исполнения значений вида MCP-инструментов (задача aff41ab1, версия
 * 0.8.3) — закрывают пробелы, найденные сторожем
 * `guard-mcp-view-coverage.test.ts`:
 *
 *   * `etn.thoughts.copy_subtree` — `duplicate_policy` целиком
 *     (`fail`/`reuse`/`skip`/`create_always`); раньше были покрыты только
 *     `reuse` и `create_always`;
 *   * `etn.attachments.add` — `kind` (`url`/`file`); раньше `file` не
 *     проверялся вовсе (все тесты работали с `url`).
 *
 * «Значение вида без ветки поведения» здесь нет: `collision_policy` импорта и
 * `link_direction` mentions_scan — мёртвые параметры (ошибки ebe93450 и
 * cb741cec), в стороже они заведены исключениями, а не поддельными тестами.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
  type McpClientHandle,
  type McpTestContext,
} from './mcp-helpers.js';
import { openNetworkDb } from '../src/db/network-db.js';
import { createThought } from '../src/domain/thought-service.js';
import { createLink } from '../src/domain/link-service.js';

/** Пара сетей для копирования: источник + цель и клиент к целевой сети. */
async function buildPair(): Promise<{
  src: McpTestContext;
  dst: McpTestContext;
  handle: McpClientHandle;
  closeAll(): Promise<void>;
}> {
  const src = await buildMcpContext();
  const dst = await buildMcpContext();
  const handle = await connectMcpClient(dst, dst.adminKey);
  return {
    src,
    dst,
    handle,
    async closeAll() {
      await handle.close();
      await closeMcpContext(dst);
      await closeMcpContext(src);
    },
  };
}

/** Число обычных (не HOME) мыслей сети. */
function countThoughts(ctx: McpTestContext): number {
  const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
  const row = ndb
    .prepare('SELECT COUNT(*) AS c FROM thoughts_v WHERE is_root = 0')
    .get() as { c: number };
  return row.c;
}

describe('etn.thoughts.copy_subtree: значения duplicate_policy (стандарт view-покрытия)', {
  skip: !nativeAvailable(),
}, () => {
  it('etn.thoughts.copy_subtree: каждое значение duplicate_policy отрабатывает свою ветку', async () => {
    const dupTitle = 'Общая тема политики';
    const dupSynonym = 'общий-синоним-политики';

    // Каждое значение вида — свой изолированный мир src→dst.
    for (const policy of ['fail', 'reuse', 'skip', 'create_always'] as const) {
      const w = await buildPair();
      try {
        const srcNdb = openNetworkDb(w.src.dataDir, w.src.networkId);
        const srcRoot = createThought(
          srcNdb,
          { title: dupTitle, synonyms: [dupSynonym] },
          w.src.adminId,
        ).id;
        const dstDup = createThought(
          openNetworkDb(w.dst.dataDir, w.dst.networkId),
          { title: dupTitle, synonyms: [dupSynonym] },
          w.dst.adminId,
        ).id;
        // `reuse` проверяется на дереве из двух узлов: только тогда копирование
        // доходит до материализации и карта id получает переиспользованную пару
        // (ветка «нечего копировать» возвращает пустую карту).
        let child: string | null = null;
        if (policy === 'reuse') {
          child = createThought(srcNdb, { title: 'Уникальный потомок политики' }, w.src.adminId).id;
          createLink(srcNdb, { source_id: srcRoot, target_id: child }, w.src.adminId);
        }

        const result = await w.handle.client.callTool({
          name: 'etn.thoughts.copy_subtree',
          arguments: {
            source_network_id: w.src.networkId,
            target_network_id: w.dst.networkId,
            root_thought_ids: [srcRoot],
            max_depth: 1,
            duplicate_policy: policy,
          },
        });

        if (policy === 'fail') {
          // Ветка fail: дубль title+synonyms запрещает копирование целиком.
          assert.ok(result.isError, 'fail: дубль обязан отвергнуть копирование');
          assert.ok(
            toolText(result).includes('VALIDATION_ERROR'),
            `fail: ожидался VALIDATION_ERROR, получено: ${toolText(result)}`,
          );
          assert.equal(countThoughts(w.dst), 1, 'fail: целевая сеть не изменилась');
          continue;
        }

        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<{
          thoughts_created: number;
          thoughts_reused: number;
          thoughts_skipped: number;
          thought_id_map: Record<string, string>;
        }>(result);

        if (policy === 'reuse') {
          assert.equal(data.thoughts_reused, 1, 'reuse: дубль переиспользован');
          assert.equal(data.thoughts_created, 1, 'reuse: копируется только уникальный потомок');
          assert.equal(
            data.thought_id_map[srcRoot],
            dstDup,
            'reuse: карта id указывает на существующую мысль цели',
          );
          assert.ok(
            child !== null && data.thought_id_map[child] !== undefined,
            'reuse: уникальный потомок получил новый id',
          );
          assert.equal(countThoughts(w.dst), 2, 'reuse: целевая сеть не размножила дубль');
        } else if (policy === 'skip') {
          assert.equal(data.thoughts_skipped, 1, 'skip: дубль пропущен');
          assert.equal(data.thoughts_created, 0, 'skip: новых мыслей нет');
          assert.equal(countThoughts(w.dst), 1, 'skip: целевая сеть не изменилась');
        } else {
          assert.equal(data.thoughts_created, 1, 'create_always: мысль создана вопреки дублю');
          assert.equal(countThoughts(w.dst), 2, 'create_always: в целевой сети две мысли');
        }
      } finally {
        await w.closeAll();
      }
    }
  });
});

describe('etn.attachments.add: значения kind (стандарт view-покрытия)', {
  skip: !nativeAvailable(),
}, () => {
  it('etn.attachments.add: каждое значение kind (url/file) создаёт вложение', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const url = 'https://example.test/view-coverage.pdf';
        const filePath = 'C:/tmp/etn-view-coverage.pdf';

        for (const value of ['url', 'file'] as const) {
          const created = toolJson<{ id: string }>(
            await handle.client.callTool({
              name: 'etn.attachments.add',
              arguments: {
                network_id: ctx.networkId,
                owner_type: 'thought',
                owner_id: ctx.homeId,
                kind: value,
                title: `вложение-${value}`,
                ...(value === 'url' ? { url } : { file_path: filePath }),
              },
            }),
          );
          assert.ok(created.id.length > 0, `${value}: вложение создано`);

          const row = openNetworkDb(ctx.dataDir, ctx.networkId)
            .prepare('SELECT kind, url, file_path FROM attachments WHERE id = ?')
            .get(created.id) as { kind: string; url: string | null; file_path: string | null };
          assert.equal(row.kind, value, `${value}: вид вложения сохранён`);
          if (value === 'url') {
            assert.equal(row.url, url, 'url: адрес сохранён');
            assert.equal(row.file_path, null, 'url: путь файла не заполняется');
          } else {
            assert.equal(row.file_path, filePath, 'file: путь сохранён');
            assert.equal(row.url, null, 'file: адрес не заполняется');
          }
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
