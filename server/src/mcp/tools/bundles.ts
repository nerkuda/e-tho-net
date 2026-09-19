/**
 * bundles.ts — MCP-инструменты области «registerBundleTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import type { AnyWriteEvent, WriteActivityEntry } from '../../domain/write-wrapper.js';
import { PropertyValueSchema } from './properties.js';
import { z } from 'zod';
import { ATTACHMENT_KINDS, MCP_MAX_THOUGHTS_PER_WRITE, MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import type {
  McpThoughtWriteItemResult,
  McpThoughtWriteParams,
  McpThoughtWriteResult,
} from '@etn/shared';
import { getThoughtOrThrow } from '../../domain/thought-service.js';
import { defineContract } from '../../contracts.js';
import { getLink } from '../../domain/link-service.js';
import { getComment } from '../../domain/comment-service.js';
import { getAttachment } from '../../domain/attachment-service.js';
import { writeThoughts } from '../../domain/thought-write-service.js';
import {
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  resolveRuntimeLayer,
  runWrite,
  runWriteTool,
} from '../context.js';
import {
  NetworkId,
  ThoughtId,
  TYPE_ID_TYPE_CONFLICT,
  LinkDirection,
  effectiveThoughtTypeId,
  effectiveLinkTypeId,
} from './shared.js';

export function registerBundleTools(mcp: McpServer, rt: McpRuntime): void {
  const BundleThoughtSchema = z
    .object({
      title: z.string().min(1),
      synonyms: z.array(z.string().min(1)).optional(),
      type_id: z.string().min(1).nullable().optional(),
      type: z.string().min(1).optional(),
      active: z.boolean().optional(),
    })
    .refine((v) => v.type_id === undefined || v.type === undefined, {
      message: TYPE_ID_TYPE_CONFLICT,
    });
  const BundleCommentSchema = z.object({
    title: z.string().nullable().optional(),
    body_md: z.string().min(1),
    valid_from: z.string().min(1).optional(),
    valid_to: z.string().nullable().optional(),
  });

  // =========================================================================
  // `etn.thoughts.write` — задача 053751b5, 0.7.2: батч-запись связанных
  // единиц знания одной транзакцией. Поглощённые инструменты
  // (`etn.thoughts.create`/`update`/`set_active`/`upsert_bundle`,
  // `etn.links.create`, `etn.properties.set`, `etn.comments.upsert`)
  // удалены в 0.8.2 (задача 937480ca).
  // =========================================================================

  const WriteChronicleItemSchema = z.object({
    title: z.string().nullable().optional(),
    body_md: z.string().min(1),
    valid_from: z.string().min(1).optional(),
    valid_to: z.string().nullable().optional(),
  });
  const WriteLinkSpecSchema = z
    .object({
      direction: LinkDirection,
      target_id: z.string().min(1).optional(),
      target_ref: z.string().min(1).optional(),
      type_id: z.string().min(1).nullable().optional(),
      type: z.string().min(1).optional(),
      properties: z.record(z.string(), PropertyValueSchema).optional(),
      comment: z
        .object({
          title: z.string().nullable().optional(),
          body_md: z.string().min(1),
        })
        .optional(),
    })
    .refine((v) => v.type_id === undefined || v.type === undefined, {
      message: TYPE_ID_TYPE_CONFLICT,
    })
    .refine((v) => (v.target_id !== undefined) !== (v.target_ref !== undefined), {
      message: 'each links[] entry must set exactly one of target_id or target_ref',
    });
  const WriteAttachmentSpecSchema = z.object({
    kind: z.enum(ATTACHMENT_KINDS),
    url: z.string().min(1).nullable().optional(),
    file_path: z.string().min(1).nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  });
  const WriteItemSchema = z
    .object({
      ref: z.string().min(1).optional(),
      thought_id: z.string().min(1).optional(),
      thought: BundleThoughtSchema.optional(),
      on_duplicate: z.enum(['fail', 'reuse', 'update']).optional(),
      comment: BundleCommentSchema.optional(),
      chronicle: z.array(WriteChronicleItemSchema).optional(),
      properties: z.record(z.string(), PropertyValueSchema).optional(),
      links: z.array(WriteLinkSpecSchema).optional(),
      attachments: z.array(WriteAttachmentSpecSchema).optional(),
    })
    // Каждый элемент должен иметь ХОТЯ БЫ ОДНО из `thought_id` (адресация
    // существующей мысли) или `thought` (новая/совпадающая мысль). Оба
    // вместе — норм: `thought_id` адресует мысль, `thought` патчит её поля.
    .refine((v) => v.thought_id !== undefined || v.thought !== undefined, {
      message: 'each batch item must set thought_id or thought (at least one)',
    })
    // Если задано `thought` И это новая мысль (нет `thought_id`), нужен
    // `ref` для возможных `target_ref` в других элементах батча. Случай
    // `thought + thought_id` (патч существующей) ref не требует.
    .refine((v) => v.thought_id !== undefined || v.thought === undefined || v.ref !== undefined, {
      message: 'a batch item with `thought` (new thought) must also declare a local `ref`',
    });
  const LocalRefsSchema = z.record(z.string().min(1), z.string().uuid()).optional();
  const WriteSchema = z.object({
    network_id: NetworkId,
    local_refs: LocalRefsSchema,
    thoughts: z.array(WriteItemSchema).min(1).max(MCP_MAX_THOUGHTS_PER_WRITE),
  });
  mcp.registerTool(
    'etn.thoughts.write',
    {
      title: 'Батч-запись мыслей',
      description:
        'Пишет от 1 до ' +
        MCP_MAX_THOUGHTS_PER_WRITE +
        ' связанных единиц знания одной транзакцией: ' +
        'мысли + постоянные/хронологические комментарии + свойства + связи + вложения. ' +
        '`thought_id` XOR `thought` (с `ref`); `links[].target_id` XOR `target_ref`; `on_duplicate`: ' +
        '`fail`/`reuse`/`update`. Циклы `ref`/`target_ref` разрешены (фаза 2 — мысли, фаза 3 — связи). ' +
        'Поглощает `etn.thoughts.create`/`update`/`set_active`/`upsert_bundle`, `links.create`, ' +
        '`properties.set`, `comments.upsert` — удалены в 0.8.2 (задача 937480ca). Один write-бюджет + одна ' +
        'строка `audit_log` на вызов. `warnings` агрегированы по батчу. Подробности — ' +
        '`etn.how_to_write_batch`.',
      inputSchema: defineContract('etn.thoughts.write', WriteSchema, {}).schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.write'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const writeInput: McpThoughtWriteParams = {
          network_id: args.network_id,
          ...(args.local_refs === undefined ? {} : { local_refs: args.local_refs }),
          thoughts: args.thoughts.map((item) => ({
            ...(item.ref === undefined ? {} : { ref: item.ref }),
            ...(item.thought_id === undefined ? {} : { thought_id: item.thought_id }),
            ...(item.thought === undefined ? {} : { thought: item.thought }),
            ...(item.on_duplicate === undefined ? {} : { on_duplicate: item.on_duplicate }),
            ...(item.comment === undefined ? {} : { comment: item.comment }),
            ...(item.chronicle === undefined ? {} : { chronicle: item.chronicle }),
            ...(item.properties === undefined ? {} : { properties: item.properties }),
            ...(item.links === undefined ? {} : { links: item.links }),
            ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
          })),
        };
        const result = runWrite(ndb, fx, () => {
          const written = writeThoughts(ndb, writeInput, rt.deps.auth.userId);

          // Real-time events — one per actually-affected entity (per task
          // spec); журнал — из результата записи. Собираем исход здесь,
          // исполняет обёртка после коммита.
          const events: AnyWriteEvent[] = [];
          const activity: WriteActivityEntry[] = [];
          for (const item of written.items) {
            if (item.thought_action === 'reused') continue;
            if (item.thought_action === 'created') {
              const thought = getThoughtOrThrow(ndb, item.id);
              events.push({ type: 'thought.created', data: { thought } });
              activity.push({ kind: 'thought', action: 'created', thought });
            } else {
              // 'updated' — also covers the 'set_active' scenario: a batch item
              // that only sets `active: false` (HOME is rejected, see domain
              // service) lands here as a normal `thought.updated`. Empty
              // `changes` is the contract for batched updates: the granular
              // changes live across `comment`/`chronicle`/`properties`/`links`/
              // `attachments` blocks of the same item, and the audit_log row
              // carries the full story.
              events.push({
                type: 'thought.updated',
                data: { id: item.id, version: item.version, changes: {} },
              });
              const thought = getThoughtOrThrow(ndb, item.id);
              activity.push({ kind: 'thought', action: 'updated', thought });
            }
            if (item.comment !== undefined) {
              if (item.comment.action === 'created') {
                const c = getComment(ndb, item.comment.id);
                if (c !== null) {
                  events.push({ type: 'comment.created', data: { comment: c } });
                  activity.push({ kind: 'comment', action: 'created', comment: c });
                }
              } else {
                events.push({
                  type: 'comment.updated',
                  data: {
                    id: item.comment.id,
                    version: item.comment.version,
                    changes: { body_md: '' },
                  },
                });
                const c = getComment(ndb, item.comment.id);
                if (c !== null) {
                  activity.push({ kind: 'comment', action: 'updated', comment: c });
                }
              }
            }
            if (item.chronicle !== undefined) {
              for (const entry of item.chronicle) {
                const c = getComment(ndb, entry.id);
                if (c !== null) {
                  events.push({ type: 'comment.created', data: { comment: c } });
                  activity.push({ kind: 'comment', action: 'created', comment: c });
                }
              }
            }
            if (item.links !== undefined) {
              for (const link of item.links) {
                const l = getLink(ndb, link.id);
                if (l !== null) {
                  events.push({ type: 'link.created', data: { link: l } });
                  activity.push({ kind: 'link', action: 'created', link: l });
                }
              }
            }
            if (item.attachments !== undefined) {
              for (const att of item.attachments) {
                const a = getAttachment(ndb, att.id);
                if (a !== null) {
                  events.push({ type: 'attachment.created', data: { attachment: a } });
                  activity.push({ kind: 'attachment', action: 'created', attachment: a });
                }
              }
            }
          }

          return {
            result: written,
            events,
            activity,
            // ONE audit row for the whole batch (per task spec).
            audit: {
              action: 'etn.thoughts.write',
              targetType: 'network',
              targetId: args.network_id,
              details: {
                thought_count: written.thought_count,
                link_count: written.link_count,
                item_count: written.items.length,
              },
            },
          };
        });

        const layer = resolveRuntimeLayer(rt, args.network_id);
        const items: McpThoughtWriteItemResult[] = result.items;
        return {
          items,
          warnings: result.warnings,
          layer: { id: layer.id, title: layer.title },
          request_id: String(extra.requestId),
        } satisfies McpThoughtWriteResult;
      }),
  );

  // =========================================================================
  // Trash + usage-clear (S13)
  // =========================================================================
}
