/**
 * Регресс ошибки 6b28226d (0.16.1): при заведении карточки с типизированной
 * связью в графе остаётся РОВНО одно ребро — с `type_id`.
 *
 * Диагностика 0.16.1: дефект в серверном коде не воспроизводится — батч
 * `etn.thoughts.write` пишет связи одной фазой (`thought-write-service.ts`,
 * phase 3) и передаёт тип сразу в `createLink`, безтипового довеска рядом не
 * появляется. В живой сети такие пары возникали двухшаговой записью агента
 * (structural-родитель батчем, типизированное «затрагивает» — отдельным
 * вызовом через 6–9 с). Тест-сторож фиксирует поведение сервера: если
 * безтиповое ребро снова появится рядом с типизированным — регресс.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID } from '@etn/shared';

import { openNetworkDb } from '../src/db/network-db.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import {
  buildMcpContext,
  callWrite,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
  type McpTestContext,
  type WriteToolResult,
} from './mcp-helpers.js';

/** Актор прямых доменных вызовов (как в mcp-activity.test.ts). */
const USER = 'test-user';

interface LinkRow {
  id: string;
  source_id: string;
  target_id: string;
  type_id: string | null;
}

/** Все рёбра между парой мыслей в основе (в любом направлении). */
function linksBetween(ctx: McpTestContext, leftId: string, rightId: string): LinkRow[] {
  const ndb = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, BASE_LAYER_ID);
  return ndb
    .prepare(
      `SELECT id, source_id, target_id, type_id FROM links
        WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
    )
    .all(leftId, rightId, rightId, leftId) as LinkRow[];
}

describe(
  'thoughts.write: карточка с типизированной связью даёт одно ребро (6b28226d)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('links[{type}] — ровно одно ребро с type_id, direction child и parent', async () => {
      const ctx = await buildMcpContext();
      try {
        const agent = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const base = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, BASE_LAYER_ID);
          const linkTypeId = createLinkType(
            base,
            { name_forward: 'затрагивает', name_reverse: 'затронуто в' },
            USER,
          ).id;

          // Цель-существующая мысль для сценария «direction: child».
          const target = await callWrite(agent.client, ctx.networkId, [
            { ref: 't', thought: { title: 'Регресс: существующая цель' } },
          ]);
          const targetId = target.items[0]!.id;

          const childCard = await callWrite(agent.client, ctx.networkId, [
            {
              ref: 's',
              thought: { title: 'Регресс: карточка child' },
              links: [{ direction: 'child', target_id: targetId, type: 'затрагивает' }],
            },
          ]);
          const childSourceId = childCard.items[0]!.id;
          assert.equal(childCard.items[0]!.links?.length, 1, 'батч вернул ровно одно ребро');
          const childEdges = linksBetween(ctx, childSourceId, targetId);
          assert.equal(childEdges.length, 1, 'в графе ровно одно ребро, без безтипового дубля');
          assert.equal(childEdges[0]!.type_id, linkTypeId, 'ребро несёт тип «затрагивает»');
          assert.equal(childEdges[0]!.source_id, childSourceId);
          assert.equal(childEdges[0]!.target_id, targetId);

          // Цель из того же батча (`target_ref`) для сценария «direction: parent».
          const parentCard = await callWrite(agent.client, ctx.networkId, [
            {
              ref: 'p',
              thought: { title: 'Регресс: карточка parent' },
              links: [{ direction: 'parent', target_ref: 'c', type: 'затрагивает' }],
            },
            { ref: 'c', thought: { title: 'Регресс: родитель из батча' } },
          ]);
          const parentThoughtId = parentCard.items[0]!.id;
          const batchParentId = parentCard.items[1]!.id;
          const parentEdges = linksBetween(ctx, parentThoughtId, batchParentId);
          assert.equal(parentEdges.length, 1, 'target_ref-связь тоже без дубля');
          assert.equal(parentEdges[0]!.type_id, linkTypeId);
          assert.equal(parentEdges[0]!.source_id, batchParentId);
          assert.equal(parentEdges[0]!.target_id, parentThoughtId);

          // Контроль: `direction: parent` БЕЗ типа — это structural-родитель
          // (одно ребро с `type_id: null`), а не дубль типизированного.
          const structural = await callWrite(agent.client, ctx.networkId, [
            {
              ref: 'n',
              thought: { title: 'Регресс: structural-потомок' },
              links: [{ direction: 'parent', target_id: targetId }],
            },
          ]);
          const structuralId = structural.items[0]!.id;
          const structuralEdges = linksBetween(ctx, structuralId, targetId);
          assert.equal(structuralEdges.length, 1, 'structural-связь ровно одна');
          assert.equal(structuralEdges[0]!.type_id, null, 'у structural-ребра типа нет');
        } finally {
          await agent.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('target_ref из local_refs — тоже ровно одно ребро с type_id', async () => {
      const ctx = await buildMcpContext();
      try {
        const agent = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const base = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, BASE_LAYER_ID);
          const linkTypeId = createLinkType(
            base,
            { name_forward: 'затрагивает', name_reverse: 'затронуто в' },
            USER,
          ).id;
          const anchor = await callWrite(agent.client, ctx.networkId, [
            { ref: 'anchor', thought: { title: 'Регресс: якорь local_refs' } },
          ]);
          const anchorId = anchor.items[0]!.id;

          // `local_refs` называет СУЩЕСТВУЮЩУЮ мысль; `links[].target_ref`
          // резолвится по этому имени наравне с `ref` мыслей батча.
          const res = await agent.client.callTool({
            name: 'etn.thoughts.write',
            arguments: {
              network_id: ctx.networkId,
              local_refs: { anchor: anchorId },
              thoughts: [
                {
                  ref: 'card',
                  thought: { title: 'Регресс: карточка через local_refs' },
                  links: [{ direction: 'child', target_ref: 'anchor', type: 'затрагивает' }],
                },
              ],
            },
          });
          assert.equal(res.isError, undefined, toolText(res));
          const written = toolJson<WriteToolResult>(res);
          const cardId = written.items[0]!.id;
          assert.equal(written.items[0]!.links?.length, 1, 'local_refs-связь дала одно ребро');

          const edges = linksBetween(ctx, cardId, anchorId);
          assert.equal(edges.length, 1, 'в графе ровно одно ребро, безтипового дубля нет');
          assert.equal(edges[0]!.type_id, linkTypeId, 'ребро несёт тип «затрагивает»');
          assert.equal(edges[0]!.source_id, cardId);
          assert.equal(edges[0]!.target_id, anchorId);
        } finally {
          await agent.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);
