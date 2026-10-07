/**
 * 0.12.1 — постоянный комментарий: «витрины» и по-id чтение сходятся на
 * видимой редакции (ошибка ec9918b3).
 *
 * Симптом: у одного комментария-инструкции `etn.instructions { instruction_id }`
 * отдавал актуальный текст, а `etn.comments.get { comment_id }` — старый.
 *
 * Корень. Логический id постоянного комментария до фикса 46b93145 был
 * случайным, поэтому слой и основа могли завести каждая свою строку с РАЗНЫМИ
 * id для одного владельца. `comments_v` отдаёт обоих «видимых победителей»;
 * выбор ближайшего слоя (a7d3ef19) применялся в `getPermanentRow` (путь
 * `etn.instructions`/`meta.permanent`), но по-id чтение `getComment` и
 * `listComments(...).find(permanent)` возвращали устаревшую легаси-строку.
 *
 * Проверка сквозная, через реальные MCP-инструменты на изолированной сети:
 * состояния с двумя id (легаси) через API уже не создать (46b93145 сводит id),
 * поэтому строки сидируются физически — как в
 * `layers-comment-permanent-conflict.test.ts`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID } from '@etn/shared';

import { openNetworkDb, type NetworkDb } from '../src/db/network-db.js';

import {
  buildMcpContext,
  callOp,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
} from './mcp-helpers.js';

/** Insert a thought-type directly. */
function makeThoughtType(ndb: NetworkDb, name: string, userId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, name, name_key, is_root, version,
                                  created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?)`,
    )
    .run(id, name, name.toLowerCase(), now, now, userId, userId);
  return id;
}

/** Insert a thought directly into the connection's layer. */
function makeThought(ndb: NetworkDb, title: string, typeId: string, userId: string): string {
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
    .run(id, ndb.layerId, title, title.toLowerCase(), typeId, now, now, userId, userId, Date.now(), Date.now());
  return id;
}

/** Physically insert a permanent comment row into a specific layer (legacy state). */
function seedPhysicalPermanent(
  ndb: NetworkDb,
  ownerId: string,
  layerId: string,
  bodyMd: string,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO comments (id, layer_id, deleted, base_version, owner_type, owner_id,
                             kind, title, body_md, body_html, valid_from, valid_to, use_time,
                             version, created_at, updated_at, created_by, updated_by,
                             created_at_ms, updated_at_ms)
       VALUES (?, ?, 0, 0, 'thought', ?, 'permanent', NULL, ?, '', ?, NULL, 0,
               10, ?, ?, 'u', 'u', 0, 0)`,
    )
    .run(id, layerId, ownerId, bodyMd, bodyMd, now, now);
  return id;
}

/** Set the network's `type_roles` via the system DB. */
function setTypeRoles(
  ctx: Awaited<ReturnType<typeof buildMcpContext>>,
  roles: Record<string, string | null>,
): void {
  ctx.sys.updateNetwork(ctx.networkId, {
    displayName: ctx.sys.getNetworkById(ctx.networkId)!.display_name,
    description: null,
    when_to_use: null,
    conventions: null,
    examples: null,
    type_roles: roles,
  });
}

interface CommentGet {
  id: string;
  body_md: string;
}
interface CommentByThought {
  thought_id: string;
  permanent: CommentGet | null;
}

describe('постоянный комментарий: витрина и по-id чтение сходятся (ec9918b3)', { skip: !nativeAvailable() }, () => {
  it('etn.instructions и etn.comments.get отдают одну видимую редакцию при расхождении по слоям', async () => {
    const ctx = await buildMcpContext();
    try {
      const base = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionTypeId = makeThoughtType(base, 'Инструкция', ctx.adminId);
      const ownerId = makeThought(base, 'Изменяемая инструкция', instructionTypeId, ctx.adminId);

      const agent = await connectMcpClient(ctx, ctx.adminKey);
      try {
        setTypeRoles(ctx, { instructions: instructionTypeId });

        // Слой версии + переключение сессии в него.
        const created = toolJson<{ id: string }>(
          await callOp(agent.client, 'layers.create', {
            network_id: ctx.networkId,
            title: 'Слой 0.12.1',
          }),
        );
        const layerId = created.id;
        await agent.client.callTool({
          name: 'etn.layers.select',
          arguments: { network_id: ctx.networkId, layer_id: layerId },
        });

        // Легаси-расхождение: основа — старая редакция (id X), слой — новая (id Y).
        const baseId = seedPhysicalPermanent(base, ownerId, BASE_LAYER_ID, 'СТАРЫЙ текст (основа)');
        const layerDb = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, layerId);
        const layerCommentId = seedPhysicalPermanent(layerDb, ownerId, layerId, 'НОВЫЙ текст (слой)');
        assert.notEqual(baseId, layerCommentId, 'легаси-строки имеют разные id');

        // Витрина инструкции — актуальная редакция.
        const instr = toolJson<{ body_md: string | null }>(
          await agent.client.callTool({
            name: 'etn.instructions',
            arguments: { network_id: ctx.networkId, instruction_id: ownerId },
          }),
        );
        assert.equal(instr.body_md, 'НОВЫЙ текст (слой)');

        // По-id чтение УСТАРЕВШЕГО легаси-id обязано отдать ту же видимую редакцию
        // (идентичность постоянного комментария — владелец), а не старую строку.
        const byId = toolJson<CommentGet>(
          await agent.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, comment_id: baseId },
          }),
        );
        assert.equal(byId.body_md, 'НОВЫЙ текст (слой)');
        assert.equal(byId.id, layerCommentId);

        // По владельцу — та же редакция.
        const byThought = toolJson<CommentByThought>(
          await agent.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, thought_id: ownerId },
          }),
        );
        assert.equal(byThought.permanent?.body_md, 'НОВЫЙ текст (слой)');

        // И карточка мысли (meta.permanent) — тоже.
        const thought = toolJson<{ meta: { permanent: { body_md: string } | null } }>(
          await agent.client.callTool({
            name: 'etn.thoughts.get',
            arguments: { network_id: ctx.networkId, thought_id: ownerId },
          }),
        );
        assert.equal(thought.meta.permanent?.body_md, 'НОВЫЙ текст (слой)');
      } finally {
        await agent.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
