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
  McpUpsertBundleResult,
} from '@etn/shared';
import { getThoughtOrThrow } from '../../domain/thought-service.js';
import { defineContract, ThoughtsUpsertBundle } from '../../contracts.js';
import { getLink } from '../../domain/link-service.js';
import { getComment } from '../../domain/comment-service.js';
import { getAttachment } from '../../domain/attachment-service.js';
import { upsertThoughtBundle } from '../../domain/thought-bundle-service.js';
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
  const BundleLinkSchema = z
    .object({
      direction: LinkDirection,
      target_thought_id: ThoughtId,
      type_id: z.string().min(1).nullable().optional(),
      type: z.string().min(1).optional(),
    })
    .refine((v) => v.type_id === undefined || v.type === undefined, {
      message: TYPE_ID_TYPE_CONFLICT,
    });
  const BundleAttachmentSchema = z.object({
    kind: z.enum(ATTACHMENT_KINDS),
    url: z.string().min(1).nullable().optional(),
    file_path: z.string().min(1).nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  });
  const UpsertBundleSchema = z
    .object({
      network_id: NetworkId,
      thought_id: ThoughtId.optional(),
      thought: BundleThoughtSchema.optional(),
      on_duplicate: z.enum(['fail', 'reuse', 'update']).optional(),
      comment: BundleCommentSchema.optional(),
      properties: z.record(z.string(), PropertyValueSchema).optional(),
      links: z.array(BundleLinkSchema).optional(),
      attachments: z.array(BundleAttachmentSchema).optional(),
    })
    .refine((v) => v.thought_id !== undefined || v.thought !== undefined, {
      message: 'either thought_id or thought must be provided',
    });
  mcp.registerTool(
    'etn.thoughts.upsert_bundle',
    {
      title: 'Составная запись «единицы знания»',
      description:
        'Create (or, via `thought_id`/`on_duplicate`, augment) a thought together with its permanent ' +
        'comment, property values, links and attachments — one atomic transaction, one write-budget ' +
        'slot. `thought_id` addresses an existing thought to augment in place; otherwise `thought.title`/' +
        '`synonyms` are matched as in `etn.thoughts.find_duplicates` and `on_duplicate` decides the match ' +
        'outcome: `fail` (default, errors with `candidates`), `reuse` (attach the other parts to the ' +
        'match unchanged), `update` (also patch its fields). `thought.type`/`links[].type` resolve a type ' +
        'by name (see `etn.types.list`). `links[].direction`: "parent" — attach the bundle thought UNDER ' +
        'the target; "child" — the bundle thought becomes the parent of the target. `warnings` lists the ' +
        "type's `required` properties left unset (empty when complete).",
      inputSchema: ThoughtsUpsertBundle.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.upsert_bundle'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const thoughtTypeId =
          args.thought === undefined
            ? undefined
            : effectiveThoughtTypeId(ndb, args.thought.type_id, args.thought.type);
        const resolvedThought =
          args.thought === undefined
            ? undefined
            : {
                title: args.thought.title,
                ...(args.thought.synonyms === undefined ? {} : { synonyms: args.thought.synonyms }),
                ...(thoughtTypeId === undefined ? {} : { type_id: thoughtTypeId }),
                ...(args.thought.active === undefined ? {} : { active: args.thought.active }),
              };
        const resolvedLinks =
          args.links === undefined
            ? undefined
            : args.links.map((l) => {
                const linkTypeId = effectiveLinkTypeId(ndb, l.type_id, l.type);
                return {
                  // Domain/REST direction now matches the MCP one directly
                  // (docs/03-server-api.md §6.3, docs/05-mcp-server.md §5.2).
                  direction: l.direction,
                  target_thought_id: l.target_thought_id,
                  ...(linkTypeId === undefined ? {} : { type_id: linkTypeId }),
                };
              });
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const result = runWrite(ndb, fx, () => {
          const bundled = upsertThoughtBundle(
            ndb,
            {
              ...(args.thought_id === undefined ? {} : { thought_id: args.thought_id }),
              ...(resolvedThought === undefined ? {} : { thought: resolvedThought }),
              ...(args.on_duplicate === undefined ? {} : { on_duplicate: args.on_duplicate }),
              ...(args.comment === undefined ? {} : { comment: args.comment }),
              ...(args.properties === undefined ? {} : { properties: args.properties }),
              ...(resolvedLinks === undefined ? {} : { links: resolvedLinks }),
              ...(args.attachments === undefined
                ? {}
                : {
                    attachments: args.attachments.map((a) => ({
                      kind: a.kind,
                      url: a.url ?? null,
                      file_path: a.file_path ?? null,
                      title: a.title ?? null,
                      description: a.description ?? null,
                    })),
                  }),
            },
            rt.deps.auth.userId,
          );

          const events: AnyWriteEvent[] = [];
          const activity: WriteActivityEntry[] = [];

          if (bundled.thought_action === 'created') {
            events.push({ type: 'thought.created', data: { thought: bundled.thought } });
            activity.push({ kind: 'thought', action: 'created', thought: bundled.thought });
          } else if (bundled.thought_action === 'updated') {
            events.push({
              type: 'thought.updated',
              data: {
                id: bundled.thought.id,
                changes: resolvedThought ?? {},
                version: bundled.thought.version,
              },
            });
            activity.push({ kind: 'thought', action: 'updated', thought: bundled.thought });
          }
          if (bundled.comment !== undefined) {
            if (bundled.comment_action === 'created') {
              events.push({ type: 'comment.created', data: { comment: bundled.comment } });
              activity.push({ kind: 'comment', action: 'created', comment: bundled.comment });
            } else {
              events.push({
                type: 'comment.updated',
                data: {
                  id: bundled.comment.id,
                  changes: {
                    ...(args.comment?.title === undefined ? {} : { title: args.comment.title }),
                    body_md: args.comment?.body_md,
                  },
                  version: bundled.comment.version,
                },
              });
              activity.push({ kind: 'comment', action: 'updated', comment: bundled.comment });
            }
          }
          if (bundled.properties !== undefined) {
            for (const stored of Object.values(bundled.properties)) {
              events.push({
                type: 'property-value.set',
                data: {
                  owner_type: 'thought',
                  owner_id: bundled.thought.id,
                  property_id: stored.property_id,
                  value: stored.value,
                },
              });
              activity.push({
                kind: 'owner',
                entityType: 'thought',
                entity: bundled.thought,
              });
            }
          }
          if (bundled.links !== undefined) {
            for (const lr of bundled.links) {
              events.push({ type: 'link.created', data: { link: lr.link } });
              activity.push({ kind: 'link', action: 'created', link: lr.link });
            }
          }
          if (bundled.attachments !== undefined) {
            for (const attachment of bundled.attachments) {
              events.push({ type: 'attachment.created', data: { attachment } });
              activity.push({ kind: 'attachment', action: 'created', attachment });
            }
          }

          return {
            result: bundled,
            events,
            activity,
            audit: {
              action: 'etn.thoughts.upsert_bundle',
              targetType: 'thought',
              targetId: bundled.thought.id,
              details: args,
            },
          };
        });

        return {
          id: result.thought.id,
          version: result.thought.version,
          thought_action: result.thought_action,
          matched_on: result.matched_on,
          ...(result.comment === undefined
            ? {}
            : { comment: { id: result.comment.id, version: result.comment.version } }),
          ...(result.properties === undefined
            ? {}
            : {
                properties: Object.fromEntries(
                  Object.entries(result.properties).map(([key, v]) => [key, { id: v.id }]),
                ),
              }),
          ...(result.links === undefined
            ? {}
            : { links: result.links.map((lr) => ({ id: lr.link.id, version: lr.link.version })) }),
          ...(result.attachments === undefined
            ? {}
            : { attachments: result.attachments.map((a) => ({ id: a.id })) }),
          // Task O6: surface unfilled required properties (computed by the
          // bundle service against the freshly written card) so the agent
          // can follow up. `warnings` is always an array here — it is part of
          // the result even when empty — so callers can rely on the shape.
          warnings: result.warnings ?? [],
          request_id: String(extra.requestId),
        } satisfies McpUpsertBundleResult;
      }),
  );

  // =========================================================================
  // `etn.thoughts.write` — задача 053751b5, 0.7.2: батч-запись связанных
  // единиц знания одной транзакцией. Поглощает `etn.thoughts.create`/`update`/
  // `set_active`/`upsert_bundle`, `etn.links.create`, `etn.properties.set`,
  // `etn.comments.upsert` (помечены `deprecated_since: '0.7.2'` — см.
  // `MCP_TOOL_ANNOTATIONS` и механизм пропуска в начале `registerTools`).
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
        "`properties.set`, `comments.upsert` (`deprecated_since: '0.7.2'`). Один write-бюджет + одна " +
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
