/**
 * MCP-операция `etn.ops { action: "links.delete" }` (ошибка 7df2b3d1, 0.16.1).
 *
 * Ценность операции — адресация КОНКРЕТНОГО ребра по `link_id` вместе со
 * smart deletion по слоям: `DELETE /links/{id}` упразднён, `properties.remove`
 * удаляет лишь ребро свойства-связи, а bulk-операции
 * `unlink_parents`/`unlink_children` снимают связи по паре мыслей (structural
 * включительно), но не выбирают одно ребро из нескольких между парой.
 *
 * Физическая ветка необратима — действие `destructive`, вызов требует
 * `confirm: true`; ветка «в корзину» обратима через `links.restore`.
 *
 * Сценарии (умное удаление по слоям, ADR a967d865):
 *   1. основа, безтиповое ребро — физическое удаление + `link.deleted`
 *      (без `confirm` — `VALIDATION_ERROR`);
 *   2. повторный вызов и несуществующее ребро — идемпотентный `noop` без события;
 *   3. слой, ребро из основы — корзина (`link.updated`) + `links.restore`;
 *   4. слой, ребро создано в текущем слое — физическое удаление строки слоя.
 *
 * Соединения `openNetworkDb` в тестах не закрываются: фасад MCP работает через
 * пул тех же соединений, и `close()` выключил бы его ручку.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, type Layer } from '@etn/shared';

import { openNetworkDb } from '../src/db/network-db.js';
import { createLink, getLink } from '../src/domain/link-service.js';
import { createThought } from '../src/domain/thought-service.js';
import {
  buildMcpContext,
  callOp,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
  type McpTestContext,
} from './mcp-helpers.js';

/** Актор прямых доменных вызовов (как в mcp-activity.test.ts). */
const USER = 'test-user';

interface DeleteResult {
  link_id: string;
  action: 'deleted' | 'trashed' | 'noop';
}

/** Номер последнего события сети — точка отсчёта для выборки новых. */
function eventCursor(ctx: McpTestContext): number {
  return ctx.sys.readEventsAfter(ctx.networkId, 0, 1000).at(-1)?.seq ?? 0;
}

/** `link.*`-события, появившиеся после точки отсчёта. */
function linkEventsAfter(
  ctx: McpTestContext,
  cursor: number,
): Array<{ type: string; data: unknown }> {
  return ctx.sys
    .readEventsAfter(ctx.networkId, cursor, 100)
    .filter((event) => event.type.startsWith('link.'))
    .map((event) => ({ type: event.type, data: event.data }));
}

/** Пара мыслей и безтиповое (structural) ребро между ними в основе. */
function seedUntypedBaseLink(ctx: McpTestContext, prefix: string): string {
  const base = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, BASE_LAYER_ID);
  const sourceId = createThought(base, { title: `${prefix}: источник` }, USER).id;
  const targetId = createThought(base, { title: `${prefix}: цель` }, USER).id;
  return createLink(base, { source_id: sourceId, target_id: targetId }, USER).id;
}

describe(
  'MCP links.delete: умное удаление ребра по слоям (7df2b3d1)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('основа: безтиповое ребро удаляется физически, событие link.deleted', async () => {
      const ctx = await buildMcpContext();
      try {
        const agent = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const linkId = seedUntypedBaseLink(ctx, 'Основа');
          const base = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, BASE_LAYER_ID);
          assert.ok(getLink(base, linkId) !== null, 'ребро создано');

          // Действие деструктивное: физическая ветка необратима.
          const noConfirm = await callOp(agent.client, 'links.delete', {
            network_id: ctx.networkId,
            link_id: linkId,
          });
          assert.equal(noConfirm.isError, true, 'без confirm удаление запрещено');
          assert.match(toolText(noConfirm), /confirm: true is required/);

          const cursor = eventCursor(ctx);
          const res = await callOp(
            agent.client,
            'links.delete',
            {
              network_id: ctx.networkId,
              link_id: linkId,
            },
            true,
          );
          assert.equal(res.isError, undefined, toolText(res));
          const out = toolJson<DeleteResult>(res);
          assert.equal(out.link_id, linkId);
          assert.equal(out.action, 'deleted');

          assert.equal(getLink(base, linkId), null, 'ребро удалено физически');
          const events = linkEventsAfter(ctx, cursor);
          assert.deepEqual(
            events.map((event) => event.type),
            ['link.deleted'],
          );
          assert.equal((events[0]!.data as { id: string }).id, linkId);

          // Повторный вызов — идемпотентный noop без событий.
          const repeatCursor = eventCursor(ctx);
          const again = await callOp(
            agent.client,
            'links.delete',
            {
              network_id: ctx.networkId,
              link_id: linkId,
            },
            true,
          );
          assert.equal(again.isError, undefined, toolText(again));
          assert.equal(toolJson<DeleteResult>(again).action, 'noop');
          assert.deepEqual(linkEventsAfter(ctx, repeatCursor), [], 'повтор не эмитит link.*');

          // Несуществующее ребро — тоже noop (операция идемпотентна).
          const missing = await callOp(
            agent.client,
            'links.delete',
            {
              network_id: ctx.networkId,
              link_id: randomUUID(),
            },
            true,
          );
          assert.equal(missing.isError, undefined, toolText(missing));
          assert.equal(toolJson<DeleteResult>(missing).action, 'noop');
        } finally {
          await agent.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('слой: ребро основы уходит в корзину слоя и восстанавливается links.restore', async () => {
      const ctx = await buildMcpContext();
      try {
        const agent = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const linkId = seedUntypedBaseLink(ctx, 'Слой');

          const layer = toolJson<Layer>(
            await callOp(agent.client, 'layers.create', {
              network_id: ctx.networkId,
              title: 'Слой удаления',
            }),
          );
          await agent.client.callTool({
            name: 'etn.layers.select',
            arguments: { network_id: ctx.networkId, layer_id: layer.id },
          });

          const cursor = eventCursor(ctx);
          const res = await callOp(
            agent.client,
            'links.delete',
            {
              network_id: ctx.networkId,
              link_id: linkId,
            },
            true,
          );
          assert.equal(res.isError, undefined, toolText(res));
          assert.equal(toolJson<DeleteResult>(res).action, 'trashed');

          // Основа не тронута: ребро живёт в ней и лишь спрятано в слое.
          const base = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, BASE_LAYER_ID);
          const baseLink = getLink(base, linkId);
          assert.ok(baseLink !== null, 'ребро основы обязано остаться');
          assert.equal(baseLink.marked_for_deletion, false);

          const layerDb = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, layer.id);
          assert.equal(getLink(layerDb, linkId)?.marked_for_deletion, true, 'в слое — корзина');

          const events = linkEventsAfter(ctx, cursor);
          assert.deepEqual(
            events.map((event) => event.type),
            ['link.updated'],
          );
          const updated = events[0]!.data as {
            id: string;
            changes: { marked_for_deletion: boolean };
          };
          assert.equal(updated.id, linkId);
          assert.equal(updated.changes.marked_for_deletion, true);

          // Повторный вызов — noop: уже помеченное ребро событий не эмитит.
          const repeatCursor = eventCursor(ctx);
          const again = await callOp(
            agent.client,
            'links.delete',
            {
              network_id: ctx.networkId,
              link_id: linkId,
            },
            true,
          );
          assert.equal(again.isError, undefined, toolText(again));
          assert.equal(toolJson<DeleteResult>(again).action, 'noop');
          assert.deepEqual(linkEventsAfter(ctx, repeatCursor), []);

          // Восстановление — существующая операция корзины.
          const restored = await callOp(agent.client, 'links.restore', {
            network_id: ctx.networkId,
            link_id: linkId,
          });
          assert.equal(restored.isError, undefined, toolText(restored));
          assert.equal(
            getLink(layerDb, linkId)?.marked_for_deletion,
            false,
            'links.restore снимает пометку слоя',
          );
        } finally {
          await agent.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('слой: ребро, созданное в текущем слое, удаляется физически', async () => {
      const ctx = await buildMcpContext();
      try {
        const agent = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const layer = toolJson<Layer>(
            await callOp(agent.client, 'layers.create', {
              network_id: ctx.networkId,
              title: 'Свежий слой',
            }),
          );
          await agent.client.callTool({
            name: 'etn.layers.select',
            arguments: { network_id: ctx.networkId, layer_id: layer.id },
          });

          const layerDb = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, layer.id);
          const sourceId = createThought(layerDb, { title: 'Слой: источник' }, USER).id;
          const targetId = createThought(layerDb, { title: 'Слой: цель' }, USER).id;
          const linkId = createLink(layerDb, { source_id: sourceId, target_id: targetId }, USER).id;

          const cursor = eventCursor(ctx);
          const res = await callOp(
            agent.client,
            'links.delete',
            {
              network_id: ctx.networkId,
              link_id: linkId,
            },
            true,
          );
          assert.equal(res.isError, undefined, toolText(res));
          assert.equal(toolJson<DeleteResult>(res).action, 'deleted');
          assert.equal(getLink(layerDb, linkId), null, 'строка слоя удалена физически');
          assert.deepEqual(
            linkEventsAfter(ctx, cursor).map((event) => event.type),
            ['link.deleted'],
          );
        } finally {
          await agent.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);
