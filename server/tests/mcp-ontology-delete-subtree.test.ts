/**
 * MCP-паритет d4802371 «Ошибка удаления группы типов» (0.16.1).
 *
 * `etn.ontology.delete { kind: "thought_type", force: true }` уносит всё
 * поддерево, как REST `DELETE …?force=1`: события `thought-type.deleted` на
 * каждый тип, `thought-type-view.deleted` на каждый каскадно удалённый отбор,
 * а `affected_counts` описывают поддерево (`children_count`,
 * `cascade_types_count`, агрегированные счётчики использования). Без `force`
 * тип с детьми отвергается с `details.children`.
 *
 * Skip при отсутствии нативной сборки `better-sqlite3`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent } from '@etn/shared';

import { openNetworkDb } from '../src/db/network-db.js';
import { createThought } from '../src/domain/thought-service.js';
import { createThoughtType, getThoughtType } from '../src/domain/thought-type-service.js';
import { createThoughtTypeView } from '../src/domain/thought-type-views-service.js';
import {
  buildMcpContext,
  callOp,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

/** `details` из текста ошибки MCP (`ETN error [CODE]: message\nDetails: {...}`). */
function errorDetails(text: string): Record<string, unknown> | undefined {
  const match = /\nDetails: ([\s\S]+)$/.exec(text);
  return match === null ? undefined : (JSON.parse(match[1]!) as Record<string, unknown>);
}

describe(
  'etn.ontology.delete: каскад поддерева типа мысли (d4802371)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('force=true удаляет всё поддерево, эмитит события на каждый тип и отбор, отдаёт счётчики поддерева', async () => {
      const ctx = await buildMcpContext();
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const a = createThoughtType(ndb, { name: 'A' }, ctx.adminId);
        const b = createThoughtType(ndb, { name: 'B', parent_id: a.id }, ctx.adminId);
        const c = createThoughtType(ndb, { name: 'C', parent_id: b.id }, ctx.adminId);
        const thought = createThought(ndb, { title: 'Мысль внука', type_id: c.id }, ctx.adminId);
        const view = createThoughtTypeView(
          ndb,
          c.id,
          { name: 'Отбор внука', definition: '{"sort":"title","order":"asc"}' },
          ctx.adminId,
        );

        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const received: AnyRealtimeEvent[] = [];
          const unsubscribe = ctx.pubsub.subscribe(ctx.networkId, (event: AnyRealtimeEvent) =>
            received.push(event),
          );
          try {
            const del = await callOp(
              handle.client,
              'ontology.delete',
              {
                network_id: ctx.networkId,
                kind: 'thought_type',
                id: a.id,
                force: true,
              },
              true,
            );
            assert.equal(del.isError, undefined, toolText(del));
            const data = toolJson<{
              affected_counts: {
                thoughts_count?: number;
                type_views_count?: number;
                children_count?: number;
                cascade_types_count?: number;
              };
            }>(del);
            assert.equal(data.affected_counts.children_count, 2, 'потомки поддерева');
            assert.equal(data.affected_counts.cascade_types_count, 3, 'типы каскада с корнем');
            assert.equal(data.affected_counts.thoughts_count, 1, 'мысли всех типов поддерева');
            assert.equal(data.affected_counts.type_views_count, 1);

            await new Promise((r) => setImmediate(r));
            assert.deepEqual(
              received
                .filter((e) => e.type === 'thought-type.deleted')
                .map((e) => (e.data as { id: string }).id)
                .sort(),
              [a.id, b.id, c.id].sort(),
              'событие на каждый тип поддерева',
            );
            const viewEvents = received.filter((e) => e.type === 'thought-type-view.deleted');
            assert.equal(viewEvents.length, 1, 'событие на каскадно удалённый отбор');
            const viewData = viewEvents[0]!.data as { thought_type_id: string; view_id: string };
            assert.equal(viewData.thought_type_id, c.id);
            assert.equal(viewData.view_id, view.id);
          } finally {
            unsubscribe();
          }

          for (const id of [a.id, b.id, c.id]) {
            assert.equal(getThoughtType(ndb, id), null, `тип ${id} удалён`);
          }
          const stale = ndb
            .prepare('SELECT type_id FROM thoughts WHERE id = ? -- layers:physical-read')
            .get(thought.id) as { type_id: string | null } | undefined;
          assert.equal(stale?.type_id, null, 'мысль осталась без типа');
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('без force тип с детьми отвергается с details.children', async () => {
      const ctx = await buildMcpContext();
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const a = createThoughtType(ndb, { name: 'A' }, ctx.adminId);
        const b = createThoughtType(ndb, { name: 'B', parent_id: a.id }, ctx.adminId);

        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const del = await callOp(
            handle.client,
            'ontology.delete',
            {
              network_id: ctx.networkId,
              kind: 'thought_type',
              id: a.id,
            },
            true,
          );
          assert.equal(del.isError, true, 'без force поддерево не удаляется');
          const text = toolText(del);
          assert.match(text, /VALIDATION_ERROR/);
          assert.equal(errorDetails(text)?.children, 1, 'details.children — число потомков');
          assert.notEqual(getThoughtType(ndb, a.id), null, 'ничего не удалено');
          assert.notEqual(getThoughtType(ndb, b.id), null);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('без force при использовании И детях отказ несёт details.children, а не children_count', async () => {
      const ctx = await buildMcpContext();
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const a = createThoughtType(ndb, { name: 'A' }, ctx.adminId);
        const b = createThoughtType(ndb, { name: 'B', parent_id: a.id }, ctx.adminId);
        createThoughtType(ndb, { name: 'C', parent_id: b.id }, ctx.adminId);
        createThought(ndb, { title: 'Мысль типа A', type_id: a.id }, ctx.adminId);

        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          // Есть и использование (мысль), и потомки: отказ строится по
          // счётчикам использования, но ключ размера поддерева обязан
          // совпадать с доменным и REST-отказом — `details.children`.
          const del = await callOp(
            handle.client,
            'ontology.delete',
            {
              network_id: ctx.networkId,
              kind: 'thought_type',
              id: a.id,
            },
            true,
          );
          assert.equal(del.isError, true, 'без force удаление отвергается');
          const details = errorDetails(toolText(del));
          assert.equal(details?.children, 2, 'details.children — число потомков поддерева');
          assert.equal(details?.children_count, undefined, 'второго ключа размера в отказе нет');
          assert.equal(details?.thoughts_count, 1, 'счётчик использования сохранён');
          assert.notEqual(getThoughtType(ndb, a.id), null, 'ничего не удалено');
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);
