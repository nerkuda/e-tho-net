/**
 * MCP-мутации пишут журнал активности (ошибка 0ff98632, требование b0c7a57c
 * «activity_log — состав записи»).
 *
 * Representative-набор по классам мутирующих MCP-инструментов:
 *   * мысли — create/update/set_active/trash/delete (снимки + layer_id);
 *   * upsert_bundle — create/update бандла: строка на каждую часть;
 *   * комментарии — upsert (create/update)/update/delete;
 *   * связи — create/trash/delete + вложения add/copy;
 *   * properties.set — single и bulk: обновление сущности-владельца;
 *   * слои — create/update/delete пишут, select НЕ пишет, merge опирается
 *     на авто-свёртку журнала (паритет с REST-роутами слоёв);
 *   * trash.purge — deleted-строки со снимками до удаления;
 *   * захваты edit.* (locks.acquire/release) журнал НЕ пишут.
 *
 * Читаем `activity_log` напрямую из data.db — журнал не ветвится и живёт
 * в одной глобальной таблице на сеть, так что базового соединения хватает.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID } from '@etn/shared';

import { openNetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createTypeProperty } from '../src/domain/property-service.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
  type McpTestContext,
} from './mcp-helpers.js';

/** Actor-строка для прямых доменных вызовов (как в mcp-tools.test.ts). */
const USER = 'test-user';

interface ActivityDbRow {
  action: string;
  entity_type: string;
  entity_id: string;
  entity_title: string;
  layer_id: string | null;
  user_id: string;
}

/** Все строки журнала сети (свежие контексты стартуют с пустым журналом). */
function allActivity(ctx: McpTestContext): ActivityDbRow[] {
  return openNetworkDb(ctx.dataDir, ctx.networkId)
    .prepare(
      'SELECT action, entity_type, entity_id, entity_title, layer_id, user_id ' +
        'FROM activity_log ORDER BY occurred_at_ms ASC, id ASC',
    )
    .all() as ActivityDbRow[];
}

/** Строки журнала по конкретной сущности. */
function rowsOf(ctx: McpTestContext, entityType: string, entityId: string): ActivityDbRow[] {
  return allActivity(ctx).filter((r) => r.entity_type === entityType && r.entity_id === entityId);
}

/** Seed типа мысли с одним текстовым свойством (как в mcp-tools.test.ts). */
function seedTypeWithTextProperty(ctx: McpTestContext, typeName: string, key: string): string {
  const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
  const typeId = createThoughtType(ndb, { name: typeName }, ctx.adminId).id;
  createTypeProperty(ndb, 'thought_type', typeId, { key, value_type: 'text' }, USER);
  return typeId;
}

describe(
  'MCP-мутации пишут журнал активности (0ff98632, b0c7a57c)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {    it('мысли: create/update/set_active/trash/delete пишут журнал со снимками и layer_id', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const created = await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: {
              network_id: ctx.networkId,
              title: 'Журнальная мысль',
            },
          });
          assert.equal(created.isError, undefined, toolText(created));
          const thoughtId = toolJson<{ id: string }>(created).id;

          const updated = await handle.client.callTool({
            name: 'etn.thoughts.update',
            arguments: {
              network_id: ctx.networkId,
              thought_id: thoughtId,
              changes: { title: 'Журнальная мысль (правка)' },
            },
          });
          assert.equal(updated.isError, undefined, toolText(updated));

          const setActive = await handle.client.callTool({
            name: 'etn.thoughts.set_active',
            arguments: {
              network_id: ctx.networkId,
              thought_id: thoughtId,
              active: false,
            },
          });
          assert.equal(setActive.isError, undefined, toolText(setActive));

          const trashed = await handle.client.callTool({
            name: 'etn.thoughts.trash',
            arguments: {
              network_id: ctx.networkId,
              thought_id: thoughtId,
              trashed: true,
            },
          });
          assert.equal(trashed.isError, undefined, toolText(trashed));

          const restored = await handle.client.callTool({
            name: 'etn.thoughts.trash',
            arguments: {
              network_id: ctx.networkId,
              thought_id: thoughtId,
              trashed: false,
            },
          });
          assert.equal(restored.isError, undefined, toolText(restored));

          const deleted = await handle.client.callTool({
            name: 'etn.thoughts.delete',
            arguments: {
              network_id: ctx.networkId,
              thought_id: thoughtId,
            },
          });
          assert.equal(deleted.isError, undefined, toolText(deleted));

          const rows = rowsOf(ctx, 'thought', thoughtId);
          assert.deepEqual(
            rows.map((r) => r.action),
            ['created', 'updated', 'updated', 'trashed', 'restored', 'deleted'],
          );
          // Снимок удаления хранит последнее живое имя (после правки).
          const deletedRow = rows.find((r) => r.action === 'deleted');
          assert.ok(deletedRow !== undefined);
          assert.match(deletedRow.entity_title, /Журнальная мысль \(правка\)/);
          // Автор — исполнитель операции; слой — текущий слой сессии ключа
          // (свежая сессия сидит на базе).
          for (const row of rows) {
            assert.equal(row.user_id, ctx.adminId);
            assert.equal(row.layer_id, BASE_LAYER_ID);
          }
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('upsert_bundle create/update: журнал получает строку на каждую часть бандла', async () => {
      const ctx = await buildMcpContext();
      try {
        const typeId = seedTypeWithTextProperty(ctx, 'Книга-bundle', 'статус');

        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const bundleArgs = (title: string): Record<string, unknown> => ({
            network_id: ctx.networkId,
            thought: { title, type_id: typeId },
            comment: { body_md: `Комментарий к ${title}.` },
            links: [{ direction: 'parent', target_thought_id: ctx.homeId }],
            attachments: [{ kind: 'url', url: 'https://example.com/dune' }],
          });

          const created = await handle.client.callTool({
            name: 'etn.thoughts.upsert_bundle',
            arguments: {
              ...bundleArgs('Дюна'),
              properties: { статус: 'прочитано' },
            },
          });
          assert.equal(created.isError, undefined, toolText(created));
          const result = toolJson<{
            id: string;
            thought_action: string;
            comment?: { id: string };
            links?: Array<{ id: string }>;
            attachments?: Array<{ id: string }>;
          }>(created);
          assert.equal(result.thought_action, 'created');

          // Создание бандла: мысль + комментарий + владелец свойства + связь
          // + вложение — по одной строке на каждую операцию.
          const thoughtRows = rowsOf(ctx, 'thought', result.id);
          assert.deepEqual(
            thoughtRows.map((r) => r.action),
            ['created', 'updated'],
            'создание мысли + обновление владельца значения свойства',
          );
          assert.ok(result.comment !== undefined);
          const commentRows = rowsOf(ctx, 'comment', result.comment.id);
          assert.deepEqual(commentRows.map((r) => r.action), ['created']);
          const linkId = result.links?.[0]?.id;
          assert.ok(linkId !== undefined);
          assert.deepEqual(
            rowsOf(ctx, 'link', linkId).map((r) => r.action),
            ['created'],
          );
          const attachmentId = result.attachments?.[0]?.id;
          assert.ok(attachmentId !== undefined);
          assert.deepEqual(
            rowsOf(ctx, 'attachment', attachmentId).map((r) => r.action),
            ['created'],
          );

          // Обновление того же бандла: thought.updated + comment.updated.
          const updated = await handle.client.callTool({
            name: 'etn.thoughts.upsert_bundle',
            arguments: {
              network_id: ctx.networkId,
              thought: { title: 'Дюна' },
              on_duplicate: 'update',
              comment: { body_md: 'Комментарий к Дюне. Обновлён.' },
            },
          });
          assert.equal(updated.isError, undefined, toolText(updated));
          const updateResult = toolJson<{
            id: string;
            thought_action: string;
            comment?: { id: string };
          }>(updated);
          assert.equal(updateResult.thought_action, 'updated');

          assert.deepEqual(
            rowsOf(ctx, 'thought', updateResult.id).map((r) => r.action),
            ['created', 'updated', 'updated'],
          );
          assert.ok(updateResult.comment !== undefined);
          assert.deepEqual(
            rowsOf(ctx, 'comment', updateResult.comment.id).map((r) => r.action),
            ['created', 'updated'],
          );
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('комментарии: upsert (create/update)/update/delete пишут журнал', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const thoughtRes = await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: { network_id: ctx.networkId, title: 'Хозяин комментария' },
          });
          const thoughtId = toolJson<{ id: string }>(thoughtRes).id;

          const upsertArgs = (body: string): Record<string, unknown> => ({
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: thoughtId,
            kind: 'permanent',
            body_md: body,
          });

          // Первое upsert — создание постоянного комментария.
          const first = await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: upsertArgs('Первое тело комментария.'),
          });
          assert.equal(first.isError, undefined, toolText(first));
          const commentId = toolJson<{ id: string }>(first).id;

          // Второе upsert того же владельца — обновление существующего.
          const second = await handle.client.callTool({
            name: 'etn.comments.upsert',
            arguments: upsertArgs('Второе тело комментария.'),
          });
          assert.equal(second.isError, undefined, toolText(second));
          assert.equal(toolJson<{ id: string }>(second).id, commentId);

          // Прямой comments.update.
          const updated = await handle.client.callTool({
            name: 'etn.comments.update',
            arguments: {
              network_id: ctx.networkId,
              comment_id: commentId,
              changes: { title: 'Заголовок' },
            },
          });
          assert.equal(updated.isError, undefined, toolText(updated));

          // comments.delete — снимок тела сохраняется.
          const deleted = await handle.client.callTool({
            name: 'etn.comments.delete',
            arguments: { network_id: ctx.networkId, comment_id: commentId },
          });
          assert.equal(deleted.isError, undefined, toolText(deleted));

          const rows = rowsOf(ctx, 'comment', commentId);
          assert.deepEqual(
            rows.map((r) => r.action),
            ['created', 'updated', 'updated', 'deleted'],
          );
          const deletedRow = rows.find((r) => r.action === 'deleted');
          assert.ok(deletedRow !== undefined);
          assert.match(deletedRow.entity_title, /Второе тело комментария/);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('связи и вложения: create/trash/delete + attachments.add/copy пишут журнал', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const mkThought = async (title: string): Promise<string> => {
            const res = await handle.client.callTool({
              name: 'etn.thoughts.create',
              arguments: { network_id: ctx.networkId, title },
            });
            assert.equal(res.isError, undefined, toolText(res));
            return toolJson<{ id: string }>(res).id;
          };
          const sourceId = await mkThought('Источник связи');
          const targetId = await mkThought('Цель связи');
          const copyTargetId = await mkThought('Получатель вложения');

          const linkRes = await handle.client.callTool({
            name: 'etn.links.create',
            arguments: { network_id: ctx.networkId, source_id: sourceId, target_id: targetId },
          });
          assert.equal(linkRes.isError, undefined, toolText(linkRes));
          const linkId = toolJson<{ id: string }>(linkRes).id;

          const trashed = await handle.client.callTool({
            name: 'etn.links.trash',
            arguments: { network_id: ctx.networkId, link_id: linkId, trashed: true },
          });
          assert.equal(trashed.isError, undefined, toolText(trashed));
          const restored = await handle.client.callTool({
            name: 'etn.links.trash',
            arguments: { network_id: ctx.networkId, link_id: linkId, trashed: false },
          });
          assert.equal(restored.isError, undefined, toolText(restored));

          const attRes = await handle.client.callTool({
            name: 'etn.attachments.add',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: sourceId,
              kind: 'url',
              url: 'https://example.com/doc',
              title: 'Документация',
            },
          });
          assert.equal(attRes.isError, undefined, toolText(attRes));
          const attachmentId = toolJson<{ id: string }>(attRes).id;

          const copyRes = await handle.client.callTool({
            name: 'etn.attachments.copy',
            arguments: {
              network_id: ctx.networkId,
              attachment_id: attachmentId,
              target_owner_type: 'thought',
              target_owner_ids: [copyTargetId],
            },
          });
          assert.equal(copyRes.isError, undefined, toolText(copyRes));
          const copiedId = toolJson<Array<{ id: string }>>(copyRes)[0]?.id;
          assert.ok(copiedId !== undefined);

          const linkDelete = await handle.client.callTool({
            name: 'etn.links.delete',
            arguments: { network_id: ctx.networkId, link_id: linkId },
          });
          assert.equal(linkDelete.isError, undefined, toolText(linkDelete));

          const linkRows = rowsOf(ctx, 'link', linkId);
          assert.deepEqual(
            linkRows.map((r) => r.action),
            ['created', 'trashed', 'restored', 'deleted'],
          );
          // Снимок связи — концы в формате REST («связь <id> → <id>»).
          for (const row of linkRows) {
            assert.match(row.entity_title, new RegExp(`связь ${sourceId} → ${targetId}`));
          }

          assert.deepEqual(
            rowsOf(ctx, 'attachment', attachmentId).map((r) => r.action),
            ['created'],
          );
          const copiedRows = rowsOf(ctx, 'attachment', copiedId);
          assert.deepEqual(copiedRows.map((r) => r.action), ['created']);
          assert.match(copiedRows[0]?.entity_title ?? '', /Документация/);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('properties.set single и bulk: журнал пишет обновление владельца, не значение', async () => {
      const ctx = await buildMcpContext();
      try {
        const typeId = seedTypeWithTextProperty(ctx, 'Карточка-set', 'статус');
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        createTypeProperty(ndb, 'thought_type', typeId, {
          key: 'приоритет',
          value_type: 'number',
        }, USER);

        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const created = await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: { network_id: ctx.networkId, title: 'Карточка', type_id: typeId },
          });
          assert.equal(created.isError, undefined, toolText(created));
          const thoughtId = toolJson<{ id: string }>(created).id;

          const bulk = await handle.client.callTool({
            name: 'etn.properties.set',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              values: { статус: 'в работе', приоритет: 2 },
            },
          });
          assert.equal(bulk.isError, undefined, toolText(bulk));

          const single = await handle.client.callTool({
            name: 'etn.properties.set',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: thoughtId,
              key: 'статус',
              value: 'готово',
            },
          });
          assert.equal(single.isError, undefined, toolText(single));

          // Одна строка «владелец обновлён» на каждую установленную пару
          // (как REST PUT properties: снимок самой мысли, не значения).
          const rows = rowsOf(ctx, 'thought', thoughtId);
          assert.deepEqual(rows.map((r) => r.action), ['created', 'updated', 'updated', 'updated']);
          for (const row of rows.filter((r) => r.action === 'updated')) {
            assert.match(row.entity_title, /мысль типа .+, «Карточка»/);
            assert.equal(row.layer_id, BASE_LAYER_ID);
          }
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('слои: create/update/delete пишут журнал, select НЕ пишет, merge сворачивает в базу', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const create = await handle.client.callTool({
            name: 'etn.layers.create',
            arguments: { network_id: ctx.networkId, title: 'Рабочий слой', comment: 'для теста' },
          });
          assert.equal(create.isError, undefined, toolText(create));
          const layerId = toolJson<{ id: string }>(create).id;

          // Создание и правка слоя — свои строки журнала (layer_id — слой
          // сессии на момент операции, т.е. база: create не переключает).
          let layerRows = rowsOf(ctx, 'layer', layerId);
          assert.deepEqual(layerRows.map((r) => r.action), ['created']);
          assert.match(layerRows[0]?.entity_title ?? '', /Рабочий слой/);
          assert.equal(layerRows[0]?.layer_id, BASE_LAYER_ID);

          const update = await handle.client.callTool({
            name: 'etn.layers.update',
            arguments: {
              network_id: ctx.networkId,
              layer_id: layerId,
              comment: 'обновлённый комментарий',
            },
          });
          assert.equal(update.isError, undefined, toolText(update));
          layerRows = rowsOf(ctx, 'layer', layerId);
          assert.deepEqual(layerRows.map((r) => r.action), ['created', 'updated']);

          // select журнал не пишет — переключение сессии не меняет слой.
          const before = allActivity(ctx).length;
          const select = await handle.client.callTool({
            name: 'etn.layers.select',
            arguments: { network_id: ctx.networkId, layer_id: layerId },
          });
          assert.equal(select.isError, undefined, toolText(select));
          assert.equal(allActivity(ctx).length, before);

          // Мутация в слое фиксируется со layer_id этого слоя.
          const thoughtRes = await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: { network_id: ctx.networkId, title: 'Мысль в слое' },
          });
          assert.equal(thoughtRes.isError, undefined, toolText(thoughtRes));
          const inLayerThoughtId = toolJson<{ id: string }>(thoughtRes).id;
          const inLayerRows = rowsOf(ctx, 'thought', inLayerThoughtId);
          assert.deepEqual(inLayerRows.map((r) => r.action), ['created']);
          assert.equal(inLayerRows[0]?.layer_id, layerId);

          // Merge: собственной строки про слой нет, детальные строки слоя
          // сворачиваются в базу (autoRollupLayerActivity внутри mergeLayer).
          const merge = await handle.client.callTool({
            name: 'etn.layers.merge',
            arguments: { network_id: ctx.networkId, layer_id: layerId },
          });
          assert.equal(merge.isError, undefined, toolText(merge));
          const mergedThoughtRows = rowsOf(ctx, 'thought', inLayerThoughtId);
          assert.equal(mergedThoughtRows.length, 1, 'свёртка оставляет одну строку');
          assert.equal(mergedThoughtRows[0]?.action, 'created');
          assert.equal(mergedThoughtRows[0]?.layer_id, null, 'итог авто-свёртки живёт в базе');
          assert.equal(rowsOf(ctx, 'layer', layerId).length, 2, 'строки слоя не тронуты свёрткой');

          // Возвращаемся в базу и удаляем отдельный слой: строка deleted
          // со снимком названия и layer_id родителя.
          const back = await handle.client.callTool({
            name: 'etn.layers.select',
            arguments: { network_id: ctx.networkId, layer_id: BASE_LAYER_ID },
          });
          assert.equal(back.isError, undefined, toolText(back));
          const doomed = await handle.client.callTool({
            name: 'etn.layers.create',
            arguments: { network_id: ctx.networkId, title: 'Обречённый слой' },
          });
          assert.equal(doomed.isError, undefined, toolText(doomed));
          const doomedId = toolJson<{ id: string }>(doomed).id;
          const remove = await handle.client.callTool({
            name: 'etn.layers.delete',
            arguments: { network_id: ctx.networkId, layer_id: doomedId },
          });
          assert.equal(remove.isError, undefined, toolText(remove));
          const doomedRows = rowsOf(ctx, 'layer', doomedId);
          assert.deepEqual(doomedRows.map((r) => r.action), ['created', 'deleted']);
          const deletedLayerRow = doomedRows.find((r) => r.action === 'deleted');
          assert.ok(deletedLayerRow !== undefined);
          assert.match(deletedLayerRow.entity_title, /Обречённый слой/);
          assert.equal(deletedLayerRow.layer_id, BASE_LAYER_ID, 'родитель удалённого слоя');
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('trash.purge: физическое удаление помеченного пишет deleted-строки со снимками', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const created = await handle.client.callTool({
            name: 'etn.thoughts.create',
            arguments: { network_id: ctx.networkId, title: 'Будет очищен' },
          });
          const thoughtId = toolJson<{ id: string }>(created).id;
          const trashed = await handle.client.callTool({
            name: 'etn.thoughts.trash',
            arguments: { network_id: ctx.networkId, thought_id: thoughtId, trashed: true },
          });
          assert.equal(trashed.isError, undefined, toolText(trashed));

          const purge = await handle.client.callTool({
            name: 'etn.trash.purge',
            arguments: { network_id: ctx.networkId },
          });
          assert.equal(purge.isError, undefined, toolText(purge));
          const purged = toolJson<{ purged: number; skipped: number }>(purge);
          assert.ok(purged.purged >= 1);

          const rows = rowsOf(ctx, 'thought', thoughtId);
          assert.deepEqual(
            rows.map((r) => r.action),
            ['created', 'trashed', 'deleted'],
          );
          const deletedRow = rows.find((r) => r.action === 'deleted');
          assert.ok(deletedRow !== undefined);
          assert.match(deletedRow.entity_title, /Будет очищен/);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('захваты edit.* (locks.acquire/release) журнал НЕ пишут', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const acquire = await handle.client.callTool({
            name: 'etn.locks.acquire',
            arguments: {
              network_id: ctx.networkId,
              entity_type: 'thought',
              entity_id: randomUUID(),
            },
          });
          assert.equal(acquire.isError, undefined, toolText(acquire));
          const lockId = toolJson<{ id: string }>(acquire).id;

          const release = await handle.client.callTool({
            name: 'etn.locks.release',
            arguments: { network_id: ctx.networkId, lock_id: lockId },
          });
          assert.equal(release.isError, undefined, toolText(release));
        } finally {
          await handle.close();
        }

        // Требование b0c7a57c: захваты не попадают в журнал активности.
        assert.deepEqual(allActivity(ctx), []);
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);
