/**
 * bundles.ts — MCP-инструменты области «registerBundleTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { PropertyValueSchema } from './properties.js';
import { z } from 'zod';
import { ATTACHMENT_KINDS, MCP_MAX_THOUGHTS_PER_WRITE, MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import type {
  McpThoughtWriteItemResult,
  McpThoughtWriteParams,
  McpThoughtWriteResult,
} from '@etn/shared';
import { defineContract } from '../../contracts.js';
import { runThoughtsWrite } from '../../domain/heavy-write.js';
import {
  mcpCrossNetworkAccess,
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  resolveRuntimeLayer,
  runWriteTool,
} from '../context.js';
import { NetworkId, TYPE_ID_TYPE_CONFLICT, LinkDirection } from './shared.js';

export function registerBundleTools(mcp: McpServer, rt: McpRuntime): void {
  // Все вложенные объекты батча — `.strict()` (ошибка 8b76e94e): неизвестный
  // ключ ВНУТРИ элемента `thoughts[]` (например, `comment.links`) обязан
  // отвергаться `VALIDATION_ERROR`, как и ключ верхнего уровня, а не молча
  // отбрасываться вместе с намерением агента. `.strict()` ставится ДО
  // `.refine()`/`.superRefine()` (ZodEffects не имеет метода `.strict()`).
  const BundleThoughtSchema = z
    .object({
      title: z.string().min(1),
      synonyms: z.array(z.string().min(1)).optional(),
      type_id: z.string().min(1).nullable().optional(),
      type: z.string().min(1).optional(),
      active: z.boolean().optional(),
    })
    .strict()
    .refine((v) => v.type_id === undefined || v.type === undefined, {
      message: TYPE_ID_TYPE_CONFLICT,
    });
  const BundleCommentSchema = z
    .object({
      title: z.string().nullable().optional(),
      // Пустое тело допустимо (ошибка 00f1d0e6, ожидание заказчика 2026-10-13:
      // пустой комментарий — не ошибка); поле обязано быть строкой.
      body_md: z.string(),
      valid_from: z.string().min(1).optional(),
      valid_to: z.string().nullable().optional(),
    })
    .strict();

  // =========================================================================
  // `etn.thoughts.write` — задача 053751b5, 0.7.2: батч-запись связанных
  // единиц знания одной транзакцией. Поглощённые инструменты
  // (`etn.thoughts.create`/`update`/`set_active`/`upsert_bundle`,
  // `etn.links.create`, `etn.properties.set`, `etn.comments.upsert`)
  // удалены в 0.8.2 (задача 937480ca).
  // =========================================================================

  const WriteChronicleItemSchema = z
    .object({
      title: z.string().nullable().optional(),
      // `body_md` необязателен (ошибка 00115e7b): хроно-запись создаётся и по
      // непустому заголовку. Полную проверку содержания делает домен
      // (требование 26f0aa52).
      body_md: z.string().optional(),
      valid_from: z.string().min(1).optional(),
      valid_to: z.string().nullable().optional(),
      // Флаг «учитывать время» (0.10.1, требование 91ba5b3f).
      use_time: z.boolean().optional(),
    })
    .strict();
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
          // Пустое тело допустимо — как у комментария мысли (ошибка 00f1d0e6).
          body_md: z.string(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .refine((v) => v.type_id === undefined || v.type === undefined, {
      message: TYPE_ID_TYPE_CONFLICT,
    })
    .refine((v) => (v.target_id !== undefined) !== (v.target_ref !== undefined), {
      message: 'each links[] entry must set exactly one of target_id or target_ref',
    });
  const WriteAttachmentSpecSchema = z
    .object({
      kind: z.enum(ATTACHMENT_KINDS),
      url: z.string().min(1).nullable().optional(),
      file_path: z.string().min(1).nullable().optional(),
      // Загрузка данных файла (задача 75c75a2f): с `mime_type`+`data_base64`
      // сервер сохраняет копию под каталогом вложений сети (паритет с REST
      // `POST …/attachments/file`). Требует `kind='file'`; `data_base64` не
      // сочетается с `url`/`file_path`/`description` — отвергает домен.
      mime_type: z.string().min(1).nullable().optional(),
      data_base64: z.string().min(1).nullable().optional(),
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    })
    .strict();
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
    .strict()
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
        'Пишет 1–' +
        MCP_MAX_THOUGHTS_PER_WRITE +
        ' связанных единиц знания одной транзакцией: мысли + постоянные/хронологические комментарии ' +
        '+ свойства + связи + вложения. `thought_id` XOR `thought` (с `ref`); `links[].target_id` XOR ' +
        '`target_ref`; свойства-связи в `properties` тоже принимают `ref`; ' +
        '`on_duplicate`: `fail`/`reuse`/`update`. Правка существующей — item-level ' +
        '`title`/`synonyms`/`type`/`type_id`/`active`; `synonyms` ЗАМЕНЯЮТ набор. ' +
        'ВНИМАНИЕ: item-level `title` ПЕРЕИМЕНОВЫВАЕТ мысль; заголовок записи — `chronicle[].title`. ' +
        'Один write-бюджет и одна строка `audit_log` на вызов; ' +
        '`warnings` — по батчу. Неизвестные ключи отвергаются `VALIDATION_ERROR` ' +
        '(`details.fields`). Пошагово — `etn.how_to_write_batch`.',
      inputSchema: defineContract('etn.thoughts.write', WriteSchema, {}).schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.write'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
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
        // Батч исполняет write-пул (события — после коммита, журнал — воркером);
        // батч с кросс-сетевыми адресами значений свойств остаётся в главном
        // потоке (живой резолв чужой сети — задача 7849008a, спека п.6).
        const result = await runThoughtsWrite(ndb, fx, writeInput, {
          crossNetworkAccess: mcpCrossNetworkAccess(rt, args.network_id),
        });

        // ONE audit row for the whole batch (per task spec) — половина WriteFx
        // главного потока: пишет фасад по факту коммита.
        fx.audit?.({
          action: 'etn.thoughts.write',
          targetType: 'network',
          targetId: args.network_id,
          details: {
            thought_count: result.thought_count,
            link_count: result.link_count,
            item_count: result.items.length,
          },
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
