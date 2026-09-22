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
  callWrite,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  nativeAvailable,
  setPropertiesViaWrite,
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
          const created = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Журнальная мысль',
          });
          const thoughtId = created.id;

          // Правка через батч (веха 9: `etn.thoughts.update` удалён) —
          // `on_duplicate: 'update'` находит мысль по названию и правит её.
          const updated = await callWrite(handle.client, ctx.networkId, [
            {
              ref: 'u',
              thought: { title: 'Журнальная мысль', active: false },
              on_duplicate: 'update',
            },
          ]);
          assert.equal(updated.items[0]!.thought_action, 'updated');

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
            ['created', 'updated', 'trashed', 'restored', 'deleted'],
          );
          // Снимок удаления хранит последнее живое имя.
          const deletedRow = rows.find((r) => r.action === 'deleted');
          assert.ok(deletedRow !== undefined);
          assert.match(deletedRow.entity_title, /Журнальная мысль/);
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
          const bundleItem = (title: string): Record<string, unknown> => ({
            ref: 'b',
            thought: { title, type_id: typeId },
            comment: { body_md: `Комментарий к ${title}.` },
            links: [{ direction: 'parent', target_id: ctx.homeId }],
            attachments: [{ kind: 'url', url: 'https://example.com/dune' }],
          });

          const created = await callWrite(handle.client, ctx.networkId, [
            { ...bundleItem('Дюна'), properties: { статус: 'прочитано' } },
          ]);
          const result = created.items[0]!;
          assert.equal(result.thought_action, 'created');

          // Создание бандла через батч: мысль + комментарий + связь +
          // вложение — по строке на каждую сущность (значения свойств
          // внутри батча отдельных строк владельца не пишут — таков
          // контракт `etn.thoughts.write`).
          const thoughtRows = rowsOf(ctx, 'thought', result.id);
          assert.deepEqual(
            thoughtRows.map((r) => r.action),
            ['created'],
            'создание мысли одной строкой',
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
          const updated = await callWrite(handle.client, ctx.networkId, [
            {
              ref: 'u',
              thought: { title: 'Дюна' },
              on_duplicate: 'update',
              comment: { body_md: 'Комментарий к Дюне. Обновлён.' },
            },
          ]);
          const updateResult = updated.items[0]!;
          assert.equal(updateResult.thought_action, 'updated');

          assert.deepEqual(
            rowsOf(ctx, 'thought', updateResult.id).map((r) => r.action),
            ['created', 'updated'],
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
          // Создание мысли с постоянным комментарием одним батчем
          // (веха 9: `etn.comments.upsert` удалён) — журнал получает
          // created-строки и для мысли, и для комментария.
          const created = await callWrite(handle.client, ctx.networkId, [
            {
              ref: 'c',
              thought: { title: 'Хозяин комментария' },
              comment: { body_md: 'Второе тело комментария.' },
            },
          ]);
          const commentId = created.items[0]!.comment!.id;

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
            ['created', 'updated', 'deleted'],
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
          const mkThought = async (title: string): Promise<string> =>
            (await createThoughtViaWrite(handle.client, ctx.networkId, { title })).id;
          const sourceId = await mkThought('Источник связи');
          const targetId = await mkThought('Цель связи');
          const copyTargetId = await mkThought('Получатель вложения');

          // 0.8.1: связь создаётся через свойство-связь (структурные «Потомки»).
          const linkRes = await handle.client.callTool({
            name: 'etn.properties.add',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: sourceId,
              key: 'Потомки',
              value: targetId,
            },
          });
          assert.equal(linkRes.isError, undefined, toolText(linkRes));
          const linkId = toolJson<{ link_id: string }>(linkRes).link_id;

          const removed = await handle.client.callTool({
            name: 'etn.properties.remove',
            arguments: {
              network_id: ctx.networkId,
              owner_type: 'thought',
              owner_id: sourceId,
              key: 'Потомки',
              value: targetId,
            },
          });
          assert.equal(removed.isError, undefined, toolText(removed));
          const restored = await handle.client.callTool({
            name: 'etn.links.restore',
            arguments: { network_id: ctx.networkId, link_id: linkId },
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

          const linkRows = rowsOf(ctx, 'link', linkId);
          assert.deepEqual(
            linkRows.map((r) => r.action),
            ['created', 'trashed', 'restored'],
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
          const created = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Карточка',
            type_id: typeId,
          });
          const thoughtId = created.id;

          await setPropertiesViaWrite(handle.client, ctx.networkId, thoughtId, {
            статус: 'в работе',
            приоритет: 2,
          });

          await setPropertiesViaWrite(handle.client, ctx.networkId, thoughtId, {
            статус: 'готово',
          });

          // Значения свойств внутри батча журнала владельца не пишут
          // (контракт `etn.thoughts.write`) — строка только от создания.
          const rows = rowsOf(ctx, 'thought', thoughtId);
          assert.deepEqual(rows.map((r) => r.action), ['created']);
          assert.match(rows[0]?.entity_title ?? '', /мысль типа .+, «Карточка»/);
          assert.equal(rows[0]?.layer_id, BASE_LAYER_ID);
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
          const thoughtRes = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Мысль в слое',
          });
          const inLayerThoughtId = thoughtRes.id;
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
          const created = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Будет очищен',
          });
          const thoughtId = created.id;
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
