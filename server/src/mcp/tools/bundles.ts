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
import { NetworkId, TYPE_ID_TYPE_CONFLICT, LinkDirection } from './shared.js';

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
      // Item-level `active` — absorbed from `etn.thoughts.set_active`
      // (bug faf56a02-e884-488b-9b7b-39dfd5d5b275). Applied to the
      // existing thought addressed by `thought_id` (item-level `active`
      // is the only way to toggle it — the item cannot also carry a
      // nested `thought`, XOR).
      active: z.boolean().optional(),
      // Item-level `title` / `synonyms` / `type_id` / `type` — the rename
      // half of the removed `etn.thoughts.update` (bug
      // 870c0c0d-dd2d-46b1-a498-780edcf8e18a). Patch the existing thought
      // addressed by `thought_id`, without a nested `thought` (XOR).
      title: z.string().min(1).optional(),
      synonyms: z.array(z.string().min(1)).optional(),
      type_id: z.string().min(1).nullable().optional(),
      type: z.string().min(1).optional(),
      on_duplicate: z.enum(['fail', 'reuse', 'update']).optional(),
      comment: BundleCommentSchema.optional(),
      chronicle: z.array(WriteChronicleItemSchema).optional(),
      properties: z.record(z.string(), PropertyValueSchema).optional(),
      links: z.array(WriteLinkSpecSchema).optional(),
      attachments: z.array(WriteAttachmentSpecSchema).optional(),
    })
    // Ровно ОДНО из `thought_id` (адресация существующей мысли) или `thought`
    // (новая/совпадающая мысль) — единый источник истины здесь домен
    // (`validateEnvelope` в `thought-write-service.ts`, ошибка
    // 2a679270-75cb-41c6-9c2c-d079f85ca831). Существующую мысль правят
    // item-level полями `title`/`synonyms`/`type`/`type_id`/`active`, а не
    // вложенным `thought`; комбинация обоих отвергается схемой явно, а не
    // неожиданным VALIDATION_ERROR из домена.
    .superRefine((v, ctx) => {
      const hasThoughtId = v.thought_id !== undefined;
      const hasThought = v.thought !== undefined;
      if (hasThoughtId === hasThought) {
        ctx.addIssue({
          code: 'custom',
          path: ['thought_id'],
          message: hasThoughtId
            ? 'each batch item must set exactly one of thought_id or thought: ' +
              'both were given — address an existing thought by thought_id (patch it with ' +
              'item-level title/synonyms/type/type_id/active) OR supply a new thought block'
            : 'each batch item must set exactly one of thought_id or thought: neither was given',
        });
      }
      // Item-level `title`/`synonyms`/`type_id`/`type` patch an EXISTING
      // thought addressed by `thought_id` (bug 870c0c0d) and are not read
      // by the domain when the item carries a `thought` block — reject them
      // explicitly instead of silently dropping (bug 21cbafb8). Item-level
      // `active` stays allowed for a new thought: the domain applies it to
      // the created thought, with priority over `thought.active`.
      if (hasThought) {
        const offenders = (['title', 'synonyms', 'type_id', 'type'] as const).filter(
          (f) => v[f] !== undefined,
        );
        if (offenders.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: [offenders[0]!],
            message:
              `item-level ${offenders.join('/')} apply only to an existing thought addressed by ` +
              `thought_id; for a new thought set them inside the \`thought\` block ` +
              `(thought.${offenders[0]}) — item-level fields would be ignored otherwise`,
          });
        }
      }
    })
    // Если задано `thought` (новая мысль, XOR гарантирован выше), нужен
    // `ref` для возможных `target_ref` в других элементах батча.
    .refine((v) => v.thought === undefined || v.ref !== undefined, {
      message: 'a batch item with `thought` (new thought) must also declare a local `ref`',
    })
    // Item-level `type_id`/`type` (bug 870c0c0d): тип задаётся по id ИЛИ по
    // имени, не одновременно — как у `thought`.
    .refine((v) => v.type_id === undefined || v.type === undefined, {
      message: TYPE_ID_TYPE_CONFLICT,
    });
  const LocalRefsSchema = z.record(z.string().min(1), z.string().uuid()).optional();
  // `.strict()` (ошибка ea4581c5): ключ верхнего уровня вне контракта обязан
  // отвергаться `VALIDATION_ERROR` с полем, а не молча отбрасываться. До этого
  // `links: [...]` на верхнем уровне (вместо `thoughts[].links`) давал тихий
  // успех без создания связи — агент терял запись без сигнала.
  const WriteSchema = z
    .object({
      network_id: NetworkId,
      local_refs: LocalRefsSchema,
      thoughts: z.array(WriteItemSchema).min(1).max(MCP_MAX_THOUGHTS_PER_WRITE),
    })
    .strict();
  mcp.registerTool(
    'etn.thoughts.write',
    {
      title: 'Батч-запись мыслей',
      description:
        'Пишет от 1 до ' +
        MCP_MAX_THOUGHTS_PER_WRITE +
        ' связанных единиц знания одной транзакцией: мысли + постоянные/хронологические комментарии ' +
        '+ свойства + связи + вложения. `thought_id` XOR `thought` (с `ref`); `links[].target_id` XOR ' +
        '`target_ref`; `on_duplicate`: `fail`/`reuse`/`update`. Правка существующей мысли — item-level ' +
        '`title`/`synonyms`/`type`/`type_id`/`active` (несовместимы с `thought`, кроме `active`); ' +
        '`synonyms` ЗАМЕНЯЮТ весь набор. Циклы `ref`/`target_ref` разрешены. Один write-бюджет + одна ' +
        'строка `audit_log` на вызов; `warnings` агрегированы по батчу. Неизвестные ключи верхнего ' +
        'уровня отвергаются `VALIDATION_ERROR` (`details.fields`). Пошагово — `etn.how_to_write_batch`.',
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
            ...(item.active === undefined ? {} : { active: item.active }),
            ...(item.title === undefined ? {} : { title: item.title }),
            ...(item.synonyms === undefined ? {} : { synonyms: item.synonyms }),
            ...(item.type_id === undefined ? {} : { type_id: item.type_id }),
            ...(item.type === undefined ? {} : { type: item.type }),
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
