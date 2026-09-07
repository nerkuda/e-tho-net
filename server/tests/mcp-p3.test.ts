/**
 * P3 MCP-инструменты (задача e488f4c1, версия 0.7.2):
 *   * `etn.thoughts.copy_subtree`
 *   * `etn.thoughts.mentions_scan`
 *   * `etn.import.dry_run`
 *   * `etn.import.subgraph`
 *   * `etn.export.subgraph { format: "etnx" }`
 *
 * Bootstrap — `mcp-helpers.ts`. Каждый тест строит изолированный мир и
 * подключает MCP-клиента через production-фабрику `createMcpServer` — то
 * же, что делают остальные тесты 0.7.2.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';

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
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createAttachment } from '../src/domain/attachment-service.js';
import { createComment } from '../src/domain/comment-service.js';
import { createNetworkProperty } from '../src/domain/property-service.js';

// ---------------------------------------------------------------------------
// Вспомогательные хелперы — отдельные сети, типы, простые деревья.
// ---------------------------------------------------------------------------

interface Worlds {
  src: McpTestContext;
  dst: McpTestContext;
  handle: McpClientHandle;
  srcHandle: McpClientHandle;
  closeAll(): Promise<void>;
}

async function buildPair(): Promise<Worlds> {
  const src = await buildMcpContext();
  const dst = await buildMcpContext();
  const handle = await connectMcpClient(dst, dst.adminKey);
  const srcHandle = await connectMcpClient(src, src.adminKey);
  return {
    src,
    dst,
    handle,
    srcHandle,
    async closeAll() {
      await srcHandle.close();
      await handle.close();
      await closeMcpContext(dst);
      await closeMcpContext(src);
    },
  };
}

/** Создать пользовательский тип мысли в обеих сетях. */
function makeType(ctx: McpTestContext, name: string): string {
  const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
  const type = createThoughtType(ndb, { name }, ctx.adminId);
  // НЕ закрываем соединение — closeMcpContext сделает это при тирдауне.
  // На Windows + SQLite WAL закрытие-открытие внутри одного теста приводит
  // к EBUSY при rmSync temp-каталога.
  return type.id;
}

/** Создать пользовательский тип связи в обеих сетях. */
function makeLinkType(ctx: McpTestContext, name: string): string {
  const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
  const lt = createLinkType(ndb, { name_forward: name, name_reverse: name }, ctx.adminId);
  return lt.id;
}

/** Создать дерево `родитель → ребёнок` в указанной сети. */
function makeTree(
  ctx: McpTestContext,
  titles: string[],
): { root: string; children: string[] } {
  const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
  const ids: string[] = [];
  for (const t of titles) {
    ids.push(createThought(ndb, { title: t }, ctx.adminId).id);
  }
  for (let i = 1; i < ids.length; i++) {
    createLink(ndb, { source_id: ids[0]!, target_id: ids[i]! }, ctx.adminId);
  }
  return { root: ids[0]!, children: ids.slice(1) };
}

function countThoughts(ctx: McpTestContext): number {
  const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
  const row = ndb
    .prepare("SELECT COUNT(*) AS c FROM thoughts_v WHERE is_root = 0")
    .get() as { c: number };
  return row.c;
}

function countLinks(ctx: McpTestContext): number {
  const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
  const row = ndb
    .prepare("SELECT COUNT(*) AS c FROM links_v WHERE active = 1")
    .get() as { c: number };
  return row.c;
}

// ===========================================================================
// Тесты
// ===========================================================================

describe('etn.thoughts.copy_subtree (0.7.2 P3)', { skip: !nativeAvailable() }, () => {
  it('копирует простое дерево из src в dst: новые id, связи, id_remap заполнен', async () => {
    const w = await buildPair();
    try {
      const tree = makeTree(w.src, ['A — корень', 'A.1 — потомок 1', 'A.2 — потомок 2']);

      const result = await w.handle.client.callTool({
        name: 'etn.thoughts.copy_subtree',
        arguments: {
          source_network_id: w.src.networkId,
          target_network_id: w.dst.networkId,
          root_thought_ids: [tree.root],
          max_depth: 5,
          duplicate_policy: 'create_always',
        },
      });
      assert.equal(result.isError, undefined, toolText(result));

      const data = toolJson<{
        thoughts_created: number;
        links_created: number;
        thought_id_map: Record<string, string>;
        link_id_map: Record<string, string>;
      }>(result);
      assert.equal(data.thoughts_created, 3, 'должно скопироваться 3 мысли');
      assert.equal(data.links_created, 2, 'должно скопироваться 2 связи');
      assert.equal(Object.keys(data.thought_id_map).length, 3);
      // id_remap по умолчанию true.
      for (const [, newId] of Object.entries(data.thought_id_map)) {
        assert.ok(typeof newId === 'string' && newId.length > 0, 'id должен быть непустой');
      }

      // Целевая сеть не должна содержать исходные id'ы — это копия, не алиасы.
      for (const srcId of [tree.root, ...tree.children]) {
        const mapped = data.thought_id_map[srcId];
        assert.ok(mapped !== undefined, 'для каждой src-мысли есть новый id');
        assert.notEqual(mapped, srcId, 'новый id не равен исходному');
      }
      assert.equal(countThoughts(w.dst), 3);
      assert.equal(countLinks(w.dst), 2);
    } finally {
      await w.closeAll();
    }
  });

  it('duplicate_policy=reuse переиспользует существующую мысль', async () => {
    const w = await buildPair();
    try {
      // Создаём в src и в dst одинаковую мысль.
      const srcRoot = createThought(
        openNetworkDb(w.src.dataDir, w.src.networkId),
        { title: 'Общая тема', synonyms: ['синоним-общий'] },
        w.src.adminId,
      );
      const dstPre = createThought(
        openNetworkDb(w.dst.dataDir, w.dst.networkId),
        { title: 'Общая тема', synonyms: ['синоним-общий'] },
        w.dst.adminId,
      );
      void srcRoot;
      void dstPre;

      // Дерево в src.
      const childId = createThought(
        openNetworkDb(w.src.dataDir, w.src.networkId),
        { title: 'Дочерняя общая' },
        w.src.adminId,
      ).id;

      // Связь в src.
      const ndb = openNetworkDb(w.src.dataDir, w.src.networkId);
      createLink(ndb, { source_id: srcRoot.id, target_id: childId }, w.src.adminId);

      const result = await w.handle.client.callTool({
        name: 'etn.thoughts.copy_subtree',
        arguments: {
          source_network_id: w.src.networkId,
          target_network_id: w.dst.networkId,
          root_thought_ids: [srcRoot.id],
          max_depth: 3,
          duplicate_policy: 'reuse',
        },
      });
      assert.equal(result.isError, undefined, toolText(result));
      const data = toolJson<{
        thoughts_created: number;
        thoughts_reused: number;
        thought_id_map: Record<string, string>;
      }>(result);

      // «Общая тема» должна быть переиспользована.
      assert.equal(data.thoughts_reused, 1, 'одна мысль reuse');
      assert.equal(data.thoughts_created, 1, 'одна мысль создана (дочерняя)');
      assert.equal(data.thought_id_map[srcRoot.id], dstPre.id, 'reuse-id указывает на существующую мысль в dst');
    } finally {
      await w.closeAll();
    }
  });

  it('онтология целевой сети не покрывает подграф → VALIDATION_ERROR', async () => {
    const w = await buildPair();
    try {
      // В src создаём пользовательский тип мысли и мысль этого типа.
      const typeId = makeType(w.src, 'src-only-type');
      const ndbSrc = openNetworkDb(w.src.dataDir, w.src.networkId);
      const thought = createThought(
        ndbSrc,
        { title: 'Типизированная мысль', type_id: typeId },
        w.src.adminId,
      );

      const result = await w.handle.client.callTool({
        name: 'etn.thoughts.copy_subtree',
        arguments: {
          source_network_id: w.src.networkId,
          target_network_id: w.dst.networkId,
          root_thought_ids: [thought.id],
          duplicate_policy: 'create_always',
        },
      });
      assert.ok(result.isError, 'должна быть ошибка');
      // Контент ошибки приходит в `content[0].text` JSON-RPC ответа.
      const blocks = (result as { content?: Array<{ type?: string; text?: string }> }).content;
      const text = blocks?.[0]?.text ?? '';
      assert.ok(
        text.includes('VALIDATION_ERROR') || text.includes('missing'),
        `неожиданный текст ошибки: ${text}`,
      );
    } finally {
      await w.closeAll();
    }
  });

  it('HOME-мысль как корень → VALIDATION_ERROR', async () => {
    const w = await buildPair();
    try {
      const result = await w.handle.client.callTool({
        name: 'etn.thoughts.copy_subtree',
        arguments: {
          source_network_id: w.src.networkId,
          target_network_id: w.dst.networkId,
          root_thought_ids: [w.src.homeId],
          duplicate_policy: 'create_always',
        },
      });
      assert.ok(result.isError, 'должна быть ошибка');
      assert.ok(toolText(result).includes('HOME'));
    } finally {
      await w.closeAll();
    }
  });
});

describe('etn.thoughts.mentions_scan (0.7.2 P3)', { skip: !nativeAvailable() }, () => {
  it('находит упоминание точного названия с высокой confidence', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        createThought(ndb, { title: 'Электромобиль' }, ctx.adminId);
        createThought(ndb, { title: 'Велосипед' }, ctx.adminId);

        const result = await handle.client.callTool({
          name: 'etn.thoughts.mentions_scan',
          arguments: {
            network_id: ctx.networkId,
            text: 'Сегодня видел новый Электромобиль на улице.',
            min_confidence: 0.6,
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<{
          matches: Array<{ thought_id: string; title: string; confidence: number }>;
        }>(result);
        assert.ok(data.matches.length >= 1);
        const ev = data.matches.find((m) => m.title === 'Электромобиль');
        assert.ok(ev !== undefined, 'Электромобиль должен быть в matches');
        assert.ok(ev.confidence >= 0.9, `confidence должна быть ≥ 0.9, получено ${ev.confidence}`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('находит упоминание по синониму с пониженной confidence', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        createThought(
          ndb,
          { title: 'Квантовый компьютер', synonyms: ['квантовая машина'] },
          ctx.adminId,
        );

        const result = await handle.client.callTool({
          name: 'etn.thoughts.mentions_scan',
          arguments: {
            network_id: ctx.networkId,
            text: 'Расскажи мне про квантовая машина.',
            min_confidence: 0.5,
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<{
          matches: Array<{ thought_id: string; title: string; confidence: number }>;
        }>(result);
        const ev = data.matches.find((m) => m.title === 'Квантовый компьютер');
        assert.ok(ev !== undefined, 'мысль должна быть в matches');
        assert.ok(ev.confidence >= 0.7, `confidence должна быть ≥ 0.7, получено ${ev.confidence}`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('create_links=true создаёт связи от source_thought_id к найденным', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const source = createThought(
          ndb,
          { title: 'Источник-заметка' },
          ctx.adminId,
        );
        createThought(ndb, { title: 'TargetOne' }, ctx.adminId);
        createThought(ndb, { title: 'TargetTwo' }, ctx.adminId);

        const result = await handle.client.callTool({
          name: 'etn.thoughts.mentions_scan',
          arguments: {
            network_id: ctx.networkId,
            text: 'Видел TargetOne и TargetTwo сегодня.',
            min_confidence: 0.6,
            create_links: true,
            source_thought_id: source.id,
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<{
          matches: Array<{ thought_id: string; confidence: number }>;
          links_created: number;
        }>(result);
        assert.ok(data.matches.length >= 2);
        assert.ok(data.links_created >= 2, `должно создаться ≥ 2 связи, получено ${data.links_created}`);

        // В сети должны появиться две новые связи.
        const ndb2 = openNetworkDb(ctx.dataDir, ctx.networkId);
        const linksCount = (ndb2
          .prepare(
            `SELECT COUNT(*) AS c FROM links_v WHERE source_id = ? AND target_id != ?`,
          )
          .get(source.id, source.id) as { c: number }).c;
        assert.equal(linksCount, 2);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('min_confidence=0.9 отсекает низкоуверенные совпадения', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        // Синоним с шаблоном `*` даст низкую confidence.
        createThought(
          ndb,
          { title: 'Обычное название', synonyms: ['вы*'] },
          ctx.adminId,
        );

        const result = await handle.client.callTool({
          name: 'etn.thoughts.mentions_scan',
          arguments: {
            network_id: ctx.networkId,
            text: 'Просто выходной день.',
            min_confidence: 0.9,
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<{ matches: Array<{ confidence: number }> }>(result);
        // Все совпадения либо отсутствуют, либо ≥ 0.9.
        for (const m of data.matches) {
          assert.ok(m.confidence >= 0.9, `confidence ≥ 0.9: получено ${m.confidence}`);
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

describe('etn.import.* + etn.export.subgraph { format: "etnx" } (0.7.2 P3)', {
  skip: !nativeAvailable(),
}, () => {
  it('round-trip: экспорт подграфа → импорт в другую сеть восстанавливает мысли и связи', async () => {
    const w = await buildPair();
    try {
      const tree = makeTree(w.src, ['RT-1', 'RT-2', 'RT-3']);
      // Связь уже создана в makeTree; дополнительно дадим каждой мысли комментарий.
      const ndb = openNetworkDb(w.src.dataDir, w.src.networkId);
      createComment(
        ndb,
        'thought',
        tree.root,
        { kind: 'permanent', title: null, body_md: 'описание RT-1' },
        w.src.adminId,
      );

      const beforeThoughts = countThoughts(w.src);
      const beforeLinks = countLinks(w.src);

      // Экспорт из src.
      const exportRes = await w.srcHandle.client.callTool({
        name: 'etn.export.subgraph',
        arguments: {
          network_id: w.src.networkId,
          seed_ids: [tree.root],
          radius: 2,
          format: 'etnx',
          etnx_options: { include_attachments: false },
        },
      });
      assert.equal(exportRes.isError, undefined, toolText(exportRes));
      const exportData = toolJson<{ format: string; content_b64: string; size: number }>(exportRes);
      assert.equal(exportData.format, 'etnx');
      assert.ok(exportData.content_b64.length > 0);
      assert.ok(exportData.size > 0);

      // Импорт в dst.
      const importRes = await w.handle.client.callTool({
        name: 'etn.import.subgraph',
        arguments: {
          network_id: w.dst.networkId,
          source: { kind: 'etnx_base64', content_base64: exportData.content_b64 },
          confirm: true,
        },
      });
      assert.equal(importRes.isError, undefined, toolText(importRes));
      const importData = toolJson<{
        imported: {
          thoughts_created: number;
          links_created: number;
        };
      }>(importRes);
      assert.equal(importData.imported.thoughts_created, beforeThoughts);
      assert.equal(importData.imported.links_created, beforeLinks);
    } finally {
      await w.closeAll();
    }
  });

  it('dry_run без побочных эффектов', async () => {
    const w = await buildPair();
    try {
      const tree = makeTree(w.src, ['DR-1', 'DR-2']);
      const ndb = openNetworkDb(w.src.dataDir, w.src.networkId);
      createComment(
        ndb,
        'thought',
        tree.root,
        { kind: 'permanent', title: null, body_md: 'dry-run заметка' },
        w.src.adminId,
      );

      const exportRes = await w.srcHandle.client.callTool({
        name: 'etn.export.subgraph',
        arguments: {
          network_id: w.src.networkId,
          seed_ids: [tree.root],
          radius: 2,
          format: 'etnx',
        },
      });
      assert.equal(exportRes.isError, undefined, toolText(exportRes));
      const { content_b64 } = toolJson<{ content_b64: string }>(exportRes);

      const beforeDstThoughts = countThoughts(w.dst);
      const beforeDstLinks = countLinks(w.dst);

      const dryRes = await w.handle.client.callTool({
        name: 'etn.import.dry_run',
        arguments: {
          network_id: w.dst.networkId,
          source: { kind: 'etnx_base64', content_base64: content_b64 },
        },
      });
      assert.equal(dryRes.isError, undefined, toolText(dryRes));
      const dryData = toolJson<{
        ok: boolean;
        plan: {
          thoughts_to_create: number;
          links_to_create: number;
        };
      }>(dryRes);
      assert.equal(dryData.ok, true);
      assert.ok(dryData.plan.thoughts_to_create >= 2);
      assert.ok(dryData.plan.links_to_create >= 1);

      // dst не изменился.
      assert.equal(countThoughts(w.dst), beforeDstThoughts);
      assert.equal(countLinks(w.dst), beforeDstLinks);
    } finally {
      await w.closeAll();
    }
  });

  it('import.subgraph без confirm → VALIDATION_ERROR', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.import.subgraph',
          arguments: {
            network_id: ctx.networkId,
            source: { kind: 'etnx_base64', content_base64: Buffer.from('not-a-zip').toString('base64') },
            // confirm не задан → zod-refine отвергнет на стадии парсинга.
          },
        });
        assert.ok(result.isError, 'должна быть ошибка без confirm');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('export.subgraph format=markdown всё ещё работает (без регрессии)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const id = createThought(ndb, { title: 'Документ-источник' }, ctx.adminId).id;

        const result = await handle.client.callTool({
          name: 'etn.export.subgraph',
          arguments: {
            network_id: ctx.networkId,
            seed_ids: [id],
            radius: 0,
            format: 'markdown',
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<{ format: string; content: string }>(result);
        assert.equal(data.format, 'markdown');
        assert.ok(data.content.includes('Документ-источник'));
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

// Touch the randomUUID import — used by future helpers if any.
void randomUUID;
void createNetworkProperty;
void createAttachment;
void after;
