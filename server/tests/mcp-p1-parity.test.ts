/**
 * 0.7.2 — P1-паритет MCP↔REST (задача 6d45ab37).
 *
 * Шесть новых инструментов MCP-фасада, добавленных как обёртки над
 * существующими REST-эндпоинтами и доменными функциями:
 *
 *   * `etn.thoughts.resolve` (спека 85b94925) — пакетное чтение по списку id;
 *   * `etn.thoughts.bulk_update` (спека 77502d93) — групповые операции;
 *   * `etn.chronicle.query` (спека 52767bdf) — обёртка REST `POST /chronicle/query`;
 *   * `etn.members.list` (спека 6cccac39) — обёртка REST `GET /networks/{id}/members`;
 *   * `etn.attachments.update` / `etn.attachments.delete` (спека 0b23a32a) — правка
 *     и отвязка вложения.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';
import { openNetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';

/** Insert a thought directly via SQL — тестам нужны быстрые соседи без MCP. */
function insertThought(
  ndb: ReturnType<typeof openNetworkDb>,
  title: string,
  typeId: string | null,
  adminId: string,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, icon, icon_kind,
                             icon_attachment_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, updated_at,
                             created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, NULL, 'emoji', NULL, 1, 0, 0,
               0, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), typeId, now, now, adminId, adminId,
         Date.now(), Date.now());
  return id;
}

// ===========================================================================
// etn.thoughts.resolve (85b94925)
// ===========================================================================

describe('etn.thoughts.resolve (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('items сохраняют порядок первого появления; missing — отсутствующие id', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const a = insertThought(ndb, 'Alpha', null, ctx.adminId);
      const b = insertThought(ndb, 'Beta', null, ctx.adminId);
      const c = insertThought(ndb, 'Gamma', null, ctx.adminId);
      const missing1 = '00000000-0000-4000-8000-000000000001';
      const missing2 = '00000000-0000-4000-8000-000000000002';

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = toolJson<{
          items: Array<{ id: string; title: string; properties: unknown; meta: unknown; comment_preview: unknown; type: unknown }>;
          missing: string[];
          thought_types: Record<string, unknown>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.resolve',
            arguments: {
              network_id: ctx.networkId,
              thought_ids: [a, missing1, b, missing2, c, a], // дубль `a` в конце
            },
          }),
        );
        assert.equal(result.items.length, 3, 'только три найденных, дубли схлопнулись');
        assert.deepEqual(
          result.items.map((i) => i.id),
          [a, b, c],
          'порядок items — по первому появлению',
        );
        assert.deepEqual(result.missing, [missing1, missing2]);
        assert.ok(result.thought_types);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('превышение лимита пачки → VALIDATION_ERROR', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ids = Array.from({ length: 5000 }, () => randomUUID());
        const result = await handle.client.callTool({
          name: 'etn.thoughts.resolve',
          arguments: { network_id: ctx.networkId, thought_ids: ids },
        });
        assert.equal(result.isError, true);
        assert.match(toolText(result), /Invalid arguments|too large/i);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('comment_preview содержит полный body_md постоянного комментария', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: {
              network_id: ctx.networkId,
              title: 'С большим комментарием',
              link: { direction: 'parent', target_thought_id: ctx.homeId },
            },
          }),
        );
        // 3000 символов — больше, чем preview-лимит 2000.
        const big = 'x'.repeat(3000);
        await handle.client.callTool({
          name: 'etn.comments.upsert',
          arguments: {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: created.id,
            kind: 'permanent',
            body_md: big,
          },
        });
        const result = toolJson<{
          items: Array<{ id: string; comment_preview: { body_md: string } | null }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.resolve',
            arguments: { network_id: ctx.networkId, thought_ids: [created.id] },
          }),
        );
        assert.ok(result.items[0]?.comment_preview);
        assert.equal(result.items[0]!.comment_preview!.body_md.length, 3000);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

// ===========================================================================
// etn.thoughts.bulk_update (77502d93)
// ===========================================================================

describe('etn.thoughts.bulk_update (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('set_active на массиве id → affected = N; failures пуст', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const ids = [
        insertThought(ndb, 'bulk-active-1', null, ctx.adminId),
        insertThought(ndb, 'bulk-active-2', null, ctx.adminId),
        insertThought(ndb, 'bulk-active-3', null, ctx.adminId),
      ];
      // Заранее деактивируем одну, чтобы убедиться, что операция включит её.
      ndb.prepare('UPDATE thoughts SET active = 0 WHERE id = ?').run(ids[1]);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = toolJson<{
          affected: number;
          failures: Array<{ id: string; code: string; message: string }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.bulk_update',
            arguments: {
              network_id: ctx.networkId,
              ids,
              op: 'set_active',
            },
          }),
        );
        assert.equal(result.affected, 3);
        assert.deepEqual(result.failures, []);
        // Все три мысли теперь активны.
        for (const id of ids) {
          const row = ndb.prepare('SELECT active FROM thoughts_v WHERE id = ?').get(id) as
            | { active: number }
            | undefined;
          assert.equal(row?.active, 1);
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('несуществующий id → failures[] с NOT_FOUND; остальные выполняются', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const a = insertThought(ndb, 'bulk-fail-a', null, ctx.adminId);
      const b = insertThought(ndb, 'bulk-fail-b', null, ctx.adminId);
      const ghost = '00000000-0000-4000-8000-0000000000ff';

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = toolJson<{
          affected: number;
          failures: Array<{ id: string; code: string; message: string }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.bulk_update',
            arguments: {
              network_id: ctx.networkId,
              ids: [a, ghost, b],
              op: 'set_inactive',
            },
          }),
        );
        assert.equal(result.affected, 2);
        assert.equal(result.failures.length, 1);
        assert.equal(result.failures[0]!.id, ghost);
        assert.equal(result.failures[0]!.code, 'NOT_FOUND');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('set_type с type: "<имя>" резолвится в id и применяется', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const задача = createThoughtType(ndb, { name: 'задача' }, ctx.adminId);
      const a = insertThought(ndb, 'bulk-type-a', null, ctx.adminId);
      const b = insertThought(ndb, 'bulk-type-b', null, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = toolJson<{ affected: number }>(
          await handle.client.callTool({
            name: 'etn.thoughts.bulk_update',
            arguments: {
              network_id: ctx.networkId,
              ids: [a, b],
              op: 'set_type',
              args: { type: 'задача' },
            },
          }),
        );
        assert.equal(result.affected, 2);
        for (const id of [a, b]) {
          const row = ndb
            .prepare('SELECT type_id FROM thoughts_v WHERE id = ?')
            .get(id) as { type_id: string | null } | undefined;
          assert.equal(row?.type_id, задача.id);
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('одновременно type и type_id → VALIDATION_ERROR', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.bulk_update',
          arguments: {
            network_id: ctx.networkId,
            ids: [ctx.homeId],
            op: 'set_type',
            args: {
              type: 'задача',
              type_id: '00000000-0000-4000-8000-0000000000aa',
            },
          },
        });
        assert.equal(result.isError, true);
        assert.match(toolText(result), /Invalid arguments/);
        assert.match(toolText(result), /type_id or type/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

// ===========================================================================
// etn.chronicle.query (52767bdf)
// ===========================================================================

describe('etn.chronicle.query (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('без фильтров возвращает массив записей с пагинацией', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Без хроно-комментариев ответ пустой, но форма правильная.
        const result = toolJson<{
          rows: unknown[];
          meta: { total: number; offset: number; limit: number };
        }>(
          await handle.client.callTool({
            name: 'etn.chronicle.query',
            arguments: { network_id: ctx.networkId, limit: 10, offset: 0 },
          }),
        );
        assert.deepEqual(result.rows, []);
        assert.equal(result.meta.total, 0);
        assert.equal(result.meta.offset, 0);
        assert.equal(result.meta.limit, 10);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('keywords фильтрует хроно-комментарии по тексту', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Создаём хроно-комментарий с уникальным словом.
        const today = new Date().toISOString().slice(0, 10);
        await handle.client.callTool({
          name: 'etn.comments.upsert',
          arguments: {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: ctx.homeId,
            kind: 'chronological',
            title: 'Заметка',
            body_md: 'уникальный-маркер-для-фильтрации',
            valid_from: today,
          },
        });
        const found = toolJson<{
          rows: Array<{ id: string; body_md?: string; snippet: string }>;
          meta: { total: number };
        }>(
          await handle.client.callTool({
            name: 'etn.chronicle.query',
            arguments: { network_id: ctx.networkId, keywords: 'уникальный-маркер' },
          }),
        );
        assert.equal(found.meta.total, 1);
        assert.equal(found.rows.length, 1);
        assert.match(found.rows[0]!.snippet, /уникальный-маркер/);

        const empty = toolJson<{ rows: unknown[]; meta: { total: number } }>(
          await handle.client.callTool({
            name: 'etn.chronicle.query',
            arguments: { network_id: ctx.networkId, keywords: 'абсолютно-отсутствующее-слово' },
          }),
        );
        assert.equal(empty.meta.total, 0);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('type: "<имя>" фильтрует по типу мысли', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      createThoughtType(ndb, { name: 'задача' }, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Неизвестное имя — NOT_FOUND.
        const missing = await handle.client.callTool({
          name: 'etn.chronicle.query',
          arguments: { network_id: ctx.networkId, type: 'несуществующий-тип' },
        });
        assert.equal(missing.isError, true);
        assert.match(toolText(missing), /NOT_FOUND/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

// ===========================================================================
// etn.members.list (6cccac39)
// ===========================================================================

describe('etn.members.list (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('участник сети получает непустой список', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = toolJson<{
          members: Array<{ user_id: string; display_name: string | null; role: string; joined_at: string }>;
        }>(
          await handle.client.callTool({
            name: 'etn.members.list',
            arguments: { network_id: ctx.networkId },
          }),
        );
        assert.ok(result.members.length >= 1, 'минимум один участник — admin');
        const admin = result.members.find((m) => m.user_id === ctx.adminId);
        assert.ok(admin, 'admin присутствует в списке');
        assert.equal(admin!.role, 'owner');
        assert.equal(typeof admin!.joined_at, 'string');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

// ===========================================================================
// etn.attachments.update / delete (0b23a32a)
// ===========================================================================

describe('etn.attachments.update / delete (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('update меняет title и description', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Сначала создаём вложение через MCP с уникальной меткой для поиска.
        const unique = `unique-${randomUUID()}`;
        const created = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.attachments.add',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: ctx.homeId,
              kind: 'url',
              url: `https://example.test/${unique}`,
              title: `Старое ${unique}`,
              description: `Старое описание ${unique}`,
            },
          }),
        );
        const updated = toolJson<{ id: string; version: number }>(
          await handle.client.callTool({
            name: 'etn.attachments.update',
            arguments: {
              network_id: ctx.networkId,
              attachment_id: created.id,
              title: `Новое ${unique}`,
              description: `Новое описание ${unique}`,
            },
          }),
        );
        assert.equal(updated.id, created.id);

        // Поиск по уникальной метке — должны найти обновлённое вложение.
        const searched = toolJson<Array<{ id: string; title: string | null; description: string | null }>>(
          await handle.client.callTool({
            name: 'etn.attachments.search',
            arguments: { network_id: ctx.networkId, q: unique },
          }),
        );
        const hit = searched.find((a) => a.id === created.id);
        assert.ok(hit, 'обновлённое вложение находится поиском');
        assert.equal(hit!.title, `Новое ${unique}`);
        assert.equal(hit!.description, `Новое описание ${unique}`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('delete отвязывает вложение (поиск больше его не находит)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.attachments.add',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: ctx.homeId,
              kind: 'url',
              url: 'https://example.test/to-delete',
              title: 'На удаление',
            },
          }),
        );

        // До удаления — находится поиском.
        const before = toolJson<Array<{ id: string }>>(
          await handle.client.callTool({
            name: 'etn.attachments.search',
            arguments: { network_id: ctx.networkId, q: 'to-delete' },
          }),
        );
        assert.ok(before.find((a) => a.id === created.id), 'находится ДО');

        const deleted = toolJson<{ deleted: boolean; request_id?: string }>(
          await handle.client.callTool({
            name: 'etn.attachments.delete',
            arguments: {
              network_id: ctx.networkId,
              attachment_id: created.id,
            },
          }),
        );
        assert.equal(deleted.deleted, true);

        const after = toolJson<Array<{ id: string }>>(
          await handle.client.callTool({
            name: 'etn.attachments.search',
            arguments: { network_id: ctx.networkId, q: 'to-delete' },
          }),
        );
        assert.equal(
          after.find((a) => a.id === created.id),
          undefined,
          'после удаления запись не находится поиском',
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
