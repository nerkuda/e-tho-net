/**
 * Тесты исполнения значений вида MCP-инструментов (задача aff41ab1, версия
 * 0.8.3) — закрывают пробелы, найденные сторожем
 * `guard-mcp-view-coverage.test.ts`:
 *
 *   * `etn.thoughts.copy_subtree` — `duplicate_policy` целиком
 *     (`fail`/`reuse`/`skip`/`create_always`); раньше были покрыты только
 *     `reuse` и `create_always`;
 *   * `etn.attachments.add` — `kind` (`url`/`file`); раньше `file` не
 *     проверялся вовсе (все тесты работали с `url`);
 *   * `etn.thoughts.mentions_scan` — `link_direction` (`out`/`in`): обе ветки
 *     направления создаваемых связей (ошибка cb741cec);
 *   * `etn.import.subgraph` — `collision_policy` целиком
 *     (`fail`/`rename`/`skip`/`overwrite`) и `etn.import.dry_run` — отражение
 *     политики в плане превью (ошибка ebe93450).
 *
 * «Значение вида без ветки поведения» здесь больше нет.
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

describe('etn.thoughts.mentions_scan: значения link_direction (стандарт view-покрытия)', {
  skip: !nativeAvailable(),
}, () => {
  it('etn.thoughts.mentions_scan: каждое значение link_direction создаёт связи в нужном направлении', async () => {
    for (const direction of ['out', 'in'] as const) {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
          const source = createThought(ndb, { title: `Источник-${direction}` }, ctx.adminId).id;
          const target = createThought(ndb, { title: `Цель-упоминание-${direction}` }, ctx.adminId).id;

          const result = await handle.client.callTool({
            name: 'etn.thoughts.mentions_scan',
            arguments: {
              network_id: ctx.networkId,
              text: `Сегодня упомянули Цель-упоминание-${direction}.`,
              min_confidence: 0.6,
              create_links: true,
              source_thought_id: source,
              link_direction: direction,
            },
          });
          assert.equal(result.isError, undefined, toolText(result));
          const data = toolJson<{ links_created: number }>(result);
          assert.equal(data.links_created, 1, `${direction}: создана одна связь`);

          const row = openNetworkDb(ctx.dataDir, ctx.networkId)
            .prepare(
              'SELECT source_id, target_id FROM links_v WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)',
            )
            .get(source, target, target, source) as
            | { source_id: string; target_id: string }
            | undefined;
          assert.ok(row !== undefined, `${direction}: связь создана`);
          if (direction === 'out') {
            assert.equal(row.source_id, source, 'out: источник ребра — source_thought_id');
            assert.equal(row.target_id, target, 'out: цель ребра — найденная мысль');
          } else {
            assert.equal(row.source_id, target, 'in: источник ребра — найденная мысль');
            assert.equal(row.target_id, source, 'in: цель ребра — source_thought_id');
          }
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    }
  });
});

describe('etn.import.subgraph: значения collision_policy (стандарт view-покрытия)', {
  skip: !nativeAvailable(),
}, () => {
  it('etn.import.subgraph: каждое значение collision_policy отрабатывает свою ветку', async () => {
    for (const policy of ['fail', 'rename', 'skip', 'overwrite'] as const) {
      const src = await buildMcpContext();
      const dst = await buildMcpContext();
      const srcHandle = await connectMcpClient(src, src.adminKey);
      const dstHandle = await connectMcpClient(dst, dst.adminKey);
      try {
        const srcNdb = openNetworkDb(src.dataDir, src.networkId);
        const dupTitle = `Конфликт-${policy}`;
        const root = createThought(srcNdb, { title: dupTitle }, src.adminId).id;
        const child = createThought(srcNdb, { title: `Потомок-${policy}` }, src.adminId).id;
        createLink(srcNdb, { source_id: root, target_id: child }, src.adminId);

        // В целевой сети уже есть мысль с тем же title — коллизия по title.
        createThought(openNetworkDb(dst.dataDir, dst.networkId), { title: dupTitle }, dst.adminId);

        const exportRes = await srcHandle.client.callTool({
          name: 'etn.export.subgraph',
          arguments: {
            network_id: src.networkId,
            seed_ids: [root],
            radius: 2,
            format: 'etnx',
            etnx_options: { include_attachments: false },
          },
        });
        assert.equal(exportRes.isError, undefined, toolText(exportRes));
        const { content_b64 } = toolJson<{ content_b64: string }>(exportRes);

        const importRes = await dstHandle.client.callTool({
          name: 'etn.import.subgraph',
          arguments: {
            network_id: dst.networkId,
            source: { kind: 'etnx_base64', content_base64: content_b64 },
            confirm: true,
            collision_policy: policy,
          },
        });

        if (policy === 'fail') {
          assert.ok(importRes.isError, 'fail: коллизия обязана отвергнуть импорт');
          assert.ok(toolText(importRes).includes('VALIDATION_ERROR'), toolText(importRes));
          assert.equal(countThoughts(dst), 1, 'fail: целевая сеть не изменилась');
          continue;
        }

        assert.equal(importRes.isError, undefined, toolText(importRes));
        const data = toolJson<{
          imported: {
            thoughts_created: number;
            thoughts_updated: number;
            thoughts_skipped: number;
          };
        }>(importRes);

        if (policy === 'overwrite') {
          assert.equal(data.imported.thoughts_updated, 1, 'overwrite: дубль обновлён');
          assert.equal(data.imported.thoughts_created, 1, 'overwrite: потомок создан');
          assert.equal(countThoughts(dst), 2, 'overwrite: дубль не размножен');
        } else if (policy === 'rename') {
          assert.equal(data.imported.thoughts_created, 2, 'rename: обе мысли созданы заново');
          assert.equal(countThoughts(dst), 3, 'rename: дубль остался + две новые');
          const renamed = openNetworkDb(dst.dataDir, dst.networkId)
            .prepare('SELECT COUNT(*) AS c FROM thoughts_v WHERE title LIKE ?')
            .get(`${dupTitle} (%`) as { c: number };
          assert.equal(renamed.c, 1, 'rename: у новой мысли title уникализирован');
        } else {
          assert.equal(data.imported.thoughts_skipped, 2, 'skip: дубль и его подграф пропущены');
          assert.equal(data.imported.thoughts_created, 0, 'skip: новых мыслей нет');
          assert.equal(countThoughts(dst), 1, 'skip: целевая сеть не изменилась');
        }
      } finally {
        await dstHandle.close();
        await srcHandle.close();
        await closeMcpContext(dst);
        await closeMcpContext(src);
      }
    }
  });

  it('etn.import.dry_run: collision_policy отражается в плане превью', async () => {
    const src = await buildMcpContext();
    const dst = await buildMcpContext();
    const srcHandle = await connectMcpClient(src, src.adminKey);
    const dstHandle = await connectMcpClient(dst, dst.adminKey);
    try {
      const srcNdb = openNetworkDb(src.dataDir, src.networkId);
      const dupTitle = 'Превью-конфликт';
      const root = createThought(srcNdb, { title: dupTitle }, src.adminId).id;
      const child = createThought(srcNdb, { title: 'Превью-потомок' }, src.adminId).id;
      createLink(srcNdb, { source_id: root, target_id: child }, src.adminId);
      createThought(openNetworkDb(dst.dataDir, dst.networkId), { title: dupTitle }, dst.adminId);

      const exportRes = await srcHandle.client.callTool({
        name: 'etn.export.subgraph',
        arguments: {
          network_id: src.networkId,
          seed_ids: [root],
          radius: 2,
          format: 'etnx',
          etnx_options: { include_attachments: false },
        },
      });
      assert.equal(exportRes.isError, undefined, toolText(exportRes));
      const { content_b64 } = toolJson<{ content_b64: string }>(exportRes);

      // skip: превью предупреждает о пропуске дубля и его подграфа.
      const skipRes = await dstHandle.client.callTool({
        name: 'etn.import.dry_run',
        arguments: {
          network_id: dst.networkId,
          source: { kind: 'etnx_base64', content_base64: content_b64 },
          collision_policy: 'skip',
        },
      });
      assert.equal(skipRes.isError, undefined, toolText(skipRes));
      const skipData = toolJson<{
        plan: { thoughts_to_create: number; thoughts_to_reuse: number; thoughts_to_skip: number };
        conflicts: Array<{ kind: string; title?: string }>;
      }>(skipRes);
      assert.equal(skipData.plan.thoughts_to_skip, 2, 'skip-превью: дубль и подграф пропущены');
      assert.equal(skipData.plan.thoughts_to_create, 0, 'skip-превью: новых мыслей нет');
      assert.equal(skipData.conflicts.length, 1, 'skip-превью: конфликт показан');

      // rename: превью обещает создание обеих мыслей без конфликтов-пропусков.
      const renameRes = await dstHandle.client.callTool({
        name: 'etn.import.dry_run',
        arguments: {
          network_id: dst.networkId,
          source: { kind: 'etnx_base64', content_base64: content_b64 },
          collision_policy: 'rename',
        },
      });
      const renameData = toolJson<{ plan: { thoughts_to_create: number; thoughts_to_skip: number } }>(
        renameRes,
      );
      assert.equal(renameData.plan.thoughts_to_create, 2, 'rename-превью: обе мысли создаются');
      assert.equal(renameData.plan.thoughts_to_skip, 0, 'rename-превью: пропусков нет');

      // Превью не пишет в целевую сеть.
      assert.equal(countThoughts(dst), 1, 'dry_run: целевая сеть не изменилась');
    } finally {
      await dstHandle.close();
      await srcHandle.close();
      await closeMcpContext(dst);
      await closeMcpContext(src);
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
