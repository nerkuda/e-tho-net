/**
 * thoughts-write.ts — MCP-инструменты области «registerThoughtsWriteTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 *
 * Веха 9 (задача 8b2efe2d): каждый изменяющий тул исполняет запись через
 * доменную обёртку {@link runWrite} — «транзакция → событие → журнал →
 * аудит»; тул собирает только исход записи из результата, а публикует и
 * пишет обёртка после коммита.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import type { AnyWriteEvent, WriteActivityEntry } from '../../domain/write-wrapper.js';
import { z } from 'zod';
import type { NetworkDb } from '../../db/network-db.js';
import {
  LinksRestore,
  ThoughtsBulkUpdate,
  ThoughtsDelete,
  ThoughtsTrash,
} from '../../contracts.js';
import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import type { McpMutationResult } from '@etn/shared';
import { deleteThought, getThoughtOrThrow, updateThought } from '../../domain/thought-service.js';
import { updateLink } from '../../domain/link-service.js';
import { applyBulkThoughtOp } from '../../domain/thought-bulk-service.js';
import { resolveThoughtTypeIdByName } from '../../domain/thought-type-service.js';
import { resolveLinkTypeIdByName } from '../../domain/link-type-service.js';
import {
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  runWrite,
  runWriteTool,
} from '../context.js';
import { NetworkId, ThoughtId, LinkId, ExpectedVersion, TYPE_ID_TYPE_CONFLICT } from './shared.js';

export function registerThoughtsWriteTools(mcp: McpServer, rt: McpRuntime): void {
  const BULK_UPDATE_OPS = [
    'set_type',
    'clear_type',
    'set_active',
    'set_inactive',
    'trash',
    'link_parents',
    'link_children',
    'set_only_parents',
    'unlink_parents',
    'unlink_children',
  ] as const;

  /**
   * Разбор `args` для `etn.thoughts.bulk_update`. Возвращает нормализованный
   * объект подмножества `ThoughtBatchArgs`, пригодный для вызова
   * доменного/роутного кода. Используется в фасаде и тестах.
   *
   * XOR-пары (`type`/`type_id`, `link_type`/`link_type_id`) уже отсечены
   * схемой Zod — здесь только нормализация резолва имён в id.
   */
  function normalizeBulkUpdateArgs(
    ndb: NetworkDb,
    op: (typeof BULK_UPDATE_OPS)[number],
    args: {
      type?: string;
      type_id?: string | null;
      parent_ids?: string[];
      child_ids?: string[];
      link_type?: string;
      link_type_id?: string | null;
    },
  ): {
    type_id: string | null | undefined;
    parent_ids: string[] | undefined;
    child_ids: string[] | undefined;
    link_type_id: string | null | undefined;
  } {
    const out: {
      type_id: string | null | undefined;
      parent_ids: string[] | undefined;
      child_ids: string[] | undefined;
      link_type_id: string | null | undefined;
    } = {
      type_id: undefined,
      parent_ids: undefined,
      child_ids: undefined,
      link_type_id: undefined,
    };
    if (op === 'set_type') {
      out.type_id =
        args.type === undefined ? args.type_id : resolveThoughtTypeIdByName(ndb, args.type);
    }
    if (op === 'link_parents' || op === 'set_only_parents' || op === 'unlink_parents') {
      out.parent_ids = args.parent_ids;
    }
    if (op === 'link_children' || op === 'unlink_children') {
      out.child_ids = args.child_ids;
    }
    if (op === 'link_parents' || op === 'link_children' || op === 'set_only_parents') {
      out.link_type_id =
        args.link_type === undefined
          ? args.link_type_id
          : resolveLinkTypeIdByName(ndb, args.link_type);
    }
    return out;
  }

  // Аргументы массовых операций: минимальный, жёсткий контракт.
  // Запрещаем смешение `type`/`type_id`, `link_type`/`link_type_id` —
  // схемой `.refine()` (задача 77351f03).
  const BulkUpdateArgs = z
    .object({
      // set_type
      type: z.string().min(1).optional(),
      type_id: z.string().min(1).nullable().optional(),
      // link_parents / set_only_parents / unlink_parents
      parent_ids: z.array(ThoughtId).min(1).optional(),
      // link_children / unlink_children
      child_ids: z.array(ThoughtId).min(1).optional(),
      // link_parents / link_children / set_only_parents
      link_type: z.string().min(1).optional(),
      link_type_id: z.string().min(1).nullable().optional(),
    })
    .refine((v) => v.type === undefined || v.type_id === undefined, {
      message: TYPE_ID_TYPE_CONFLICT,
    })
    .refine((v) => v.link_type === undefined || v.link_type_id === undefined, {
      message: 'provide at most one of link_type_id or link_type',
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'args must not be empty when provided' })
    .optional();

  const BulkUpdateSchema = z.object({
    network_id: NetworkId,
    ids: z.array(ThoughtId).min(1),
    op: z.enum(BULK_UPDATE_OPS),
    args: BulkUpdateArgs,
  });
  mcp.registerTool(
    'etn.thoughts.bulk_update',
    {
      title: 'Групповые операции над мыслями',
      description:
        'Групповые операции (одна запись бюджета на ВЕСЬ вызов): `op` ∈ {`set_type`,`clear_type`,' +
        '`set_active`,`set_inactive`,`trash`,`link_parents`,`link_children`,`set_only_parents`,' +
        '`unlink_parents`,`unlink_children`}. Возвращает `{ affected, failures[] }`. Без `purge`/`delete`.',
      inputSchema: ThoughtsBulkUpdate.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.bulk_update'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const normalized = normalizeBulkUpdateArgs(ndb, args.op, args.args ?? {});
        const ids = [...new Set(args.ids)];
        // Изменение, журнал активности и real-time-эффекты — в домене
        // (задача fffe76f2, ADR 162d8e7a); исполняет обёртка записи после
        // коммита. Аудит — одна запись на КАЖДЫЙ вызов (контракт бюджета
        // 0ff98632), из результата.
        const result = runWrite(ndb, fx, () => {
          const applied = applyBulkThoughtOp(ndb, fx.userId, ids, args.op, normalized);
          return {
            ...applied,
            audit: {
              action: 'etn.thoughts.bulk_update',
              targetType: 'thought',
              targetId: ids[0] ?? '',
              details: {
                op: args.op,
                ids: ids.length,
                affected: applied.result.affected,
                failures: applied.result.failures.length,
              },
            },
          };
        });
        return { affected: result.affected, failures: result.failures };
      }),
  );

  const DeleteThoughtSchema = z.object({
    network_id: NetworkId,
    thought_id: ThoughtId,
    expected_version: ExpectedVersion,
  });
  mcp.registerTool(
    'etn.thoughts.delete',
    {
      title: 'Удалить мысль',
      description:
        'Delete a thought (cascades to links, comments, attachments, property values). The same blocking ' +
        'check as `etn.thoughts.deletion_check` runs first: a `blocking` error means the thought is the ' +
        'target of blocking link-property edges or held by a layer — it is not deleted. Protected thoughts (HOME) are ' +
        'rejected. Returns { id, version: 0 }. See prompt etn.how_to_purge.',
      inputSchema: ThoughtsDelete.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.delete'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        runWrite(ndb, fx, () => {
          // Снимок мысли до удаления — он уйдёт в журнал (как `getThought`
          // в REST DELETE /thoughts/:id); getThoughtOrThrow даёт тот же
          // NOT_FOUND, что и сам deleteThought.
          const existing = getThoughtOrThrow(ndb, args.thought_id);
          // actorUserId — для object-lock enforcement (задача 2031df5e).
          deleteThought(ndb, args.thought_id, args.expected_version, rt.deps.auth.userId);
          return {
            result: undefined,
            events: [{ type: 'thought.deleted', data: { id: args.thought_id } }],
            activity: [{ kind: 'thought', action: 'deleted', thought: existing }],
            audit: {
              action: 'etn.thoughts.delete',
              targetType: 'thought',
              targetId: args.thought_id,
              details: { expected_version: args.expected_version },
            },
          };
        });
        return {
          id: args.thought_id,
          version: 0,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  const TrashThoughtSchema = z.object({
    network_id: NetworkId,
    thought_id: ThoughtId,
    trashed: z.boolean(),
  });
  mcp.registerTool(
    'etn.thoughts.trash',
    {
      title: 'Поместить мысль в корзину / вернуть',
      description:
        'Mark a thought for deletion (`trashed: true`) or restore it from the trash (`trashed: false`). ' +
        'Does NOT run the blocking check — that only applies to the physical `etn.thoughts.delete`. ' +
        'Returns { id, version }. See prompt etn.how_to_purge.',
      inputSchema: ThoughtsTrash.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.trash'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const thought = runWrite(ndb, fx, () => {
          const updated = updateThought(
            ndb,
            args.thought_id,
            { marked_for_deletion: args.trashed },
            undefined,
            rt.deps.auth.userId,
          );
          return {
            result: updated,
            events: [
              {
                type: 'thought.updated',
                data: {
                  id: updated.id,
                  changes: { marked_for_deletion: args.trashed },
                  version: updated.version,
                },
              },
            ],
            activity: [
              { kind: 'thought', action: args.trashed ? 'trashed' : 'restored', thought: updated },
            ],
            audit: {
              action: 'etn.thoughts.trash',
              targetType: 'thought',
              targetId: updated.id,
              details: { trashed: args.trashed },
            },
          };
        });
        return {
          id: thought.id,
          version: thought.version,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  const RestoreLinkSchema = z.object({
    network_id: NetworkId,
    link_id: LinkId,
  });
  mcp.registerTool(
    'etn.links.restore',
    {
      title: 'Восстановить связь из корзины',
      description:
        'Restore a link from the trash (`trashed: false`). The only remaining operation of the former ' +
        '`etn.links.*` family — creation and deletion moved to property operations (0.8.1). ' +
        'Returns { id, version }.',
      inputSchema: LinksRestore.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.links.restore'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const link = runWrite(ndb, fx, () => {
          const updated = updateLink(
            ndb,
            args.link_id,
            { marked_for_deletion: false },
            undefined,
            rt.deps.auth.userId,
          );
          return {
            result: updated,
            events: [
              {
                type: 'link.updated',
                data: {
                  id: updated.id,
                  changes: { marked_for_deletion: false },
                  version: updated.version,
                },
              },
            ],
            activity: [{ kind: 'link', action: 'restored', link: updated }],
            audit: {
              action: 'etn.links.restore',
              targetType: 'link',
              targetId: updated.id,
              details: {},
            },
          };
        });
        return {
          id: link.id,
          version: link.version,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );
}
