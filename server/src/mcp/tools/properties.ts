/**
 * properties.ts — MCP-инструменты области «registerPropertiesTools, registerUsageClearTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import type { AnyWriteEvent, WriteActivityEntry } from '../../domain/write-wrapper.js';
import { z } from 'zod';
import { MCP_TOOL_ANNOTATIONS, PROPERTY_OWNER_TYPES } from '@etn/shared';
import type {
  McpMutationResult,
  McpPropertiesSetResult,
  PropertyDefinition,
  PropertyValueValue,
} from '@etn/shared';
import { getThoughtOrThrow, getThought } from '../../domain/thought-service.js';
import {
  PropertiesAdd,
  PropertiesRemove,
  PropertiesSet,
  ThoughtsUsageClear,
} from '../../contracts.js';
import { getLink } from '../../domain/link-service.js';
import {
  addLinkPropertyValue,
  clearThoughtRefUsages,
  removeLinkPropertyValue,
  resolveDefinition,
  setPropertyValue,
  setPropertyValues,
} from '../../domain/property-service.js';
import { emitDomainEvent } from '../../realtime/emit.js';
import {
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  runWrite,
  runWriteTool,
} from '../context.js';
import { NetworkId, ThoughtId } from './shared.js';

export const PropertyValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string().min(1)),
  z.null(),
]);
export function registerPropertiesTools(mcp: McpServer, rt: McpRuntime): void {
  /**
   * Coerce stringified scalars back to their JSON types at the MCP boundary
   * (0.5.3 bugfix, docs/05-mcp-server.md §5.2). Some MCP hosts (ZCode among
   * them) stringify the scalar `value` parameter of a union-typed tool input,
   * so `value: true` arrives as `"true"`; nested objects (`values`,
   * `properties`) pass through untouched, which is why only the single form of
   * `etn.properties.set` needs this. The rules stay strict on purpose:
   *   * `bool` — only the exact strings "true"/"false" (case-insensitive);
   *   * `number` — only strings `Number()` parses into a finite number
   *     (so "42", "3.5", "1e3" pass; "", "abc", "Infinity" fall through and
   *     are rejected by the domain validation, which itself stays untouched).
   * Text-like properties (`text`, `url`, `date`) never coerce: "true" stays a
   * string there.
   */
  const coerceStringifiedScalar = (
    def: Pick<PropertyDefinition, 'value_type'>,
    value: PropertyValueValue,
  ): PropertyValueValue => {
    if (typeof value !== 'string') {
      return value;
    }
    if (def.value_type === 'bool' && /^(true|false)$/i.test(value)) {
      return value.toLowerCase() === 'true';
    }
    if (def.value_type === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
    return value;
  };
  const SetPropertySchema = z
    .object({
      network_id: NetworkId,
      owner_type: z.enum(PROPERTY_OWNER_TYPES),
      owner_id: z.string().min(1),
      key: z.string().min(1).optional(),
      value: PropertyValueSchema.optional(),
      values: z.record(z.string(), PropertyValueSchema).optional(),
    })
    .refine((v) => (v.key !== undefined && v.value !== undefined) !== (v.values !== undefined), {
      message: 'provide exactly one of { key + value } or { values }',
    });
  mcp.registerTool(
    'etn.properties.set',
    {
      title: 'Установить свойство',
      description:
        'Set (or clear with `value: null`) a property value on a thought/link by key; the value must ' +
        "match the definition's value_type. `config.multiple = true` properties accept an array: " +
        '`url` — URL/file-path strings (JSON array, not comma-join); an empty ' +
        'array clears. Stringified scalars are tolerated in the single form: "true"/"false" for `bool`, ' +
        'finite numeric strings for `number` — coerced back to JSON types. Either one `key`+`value`, or ' +
        '`values: {key: value|null}` for several properties in one transaction (an invalid key rolls back ' +
        "the whole set). Missing key → NOT_FOUND; a property not attached to the owner's type chain → " +
        'VALIDATION_ERROR with `details.property_id` (call `etn.types.list` against it).',
      inputSchema: PropertiesSet.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.properties.set'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        /** Снимок владельца для журнала (требование b0c7a57c — как REST и
         *  прежний MCP-диспетчер: без строки — голый id). */
        const ownerEntity = () =>
          args.owner_type === 'thought'
            ? (getThought(ndb, args.owner_id) ?? { id: args.owner_id })
            : (getLink(ndb, args.owner_id) ?? { id: args.owner_id });

        if (args.values !== undefined) {
          const values = args.values;
          const stored = runWrite(ndb, fx, () => {
            const written = setPropertyValues(
              ndb,
              args.owner_type,
              args.owner_id,
              values,
              rt.deps.auth.userId,
            );
            const events: AnyWriteEvent[] = [];
            const activity: WriteActivityEntry[] = [];
            // Журнал — по строке на каждое записанное значение (как прежний
            // MCP-диспетчер: один `property-value.set` = одно обновление
            // владельца, требование b0c7a57c).
            const owner = ownerEntity();
            for (const value of Object.values(written)) {
              events.push({
                type: 'property-value.set',
                data: {
                  owner_type: args.owner_type,
                  owner_id: args.owner_id,
                  property_id: value.property_id,
                  value: value.value,
                },
              });
              activity.push({ kind: 'owner', entityType: args.owner_type, entity: owner });
            }
            return {
              result: written,
              events,
              activity,
              audit: {
                action: 'etn.properties.set',
                targetType: args.owner_type,
                targetId: args.owner_id,
                details: { values },
              },
            };
          });
          return {
            values: Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, { id: v.id }])),
            version: 0,
            request_id: String(extra.requestId),
          } satisfies McpPropertiesSetResult;
        }

        // Single-property form (backward compatible). The refine guarantees both
        // are present whenever `values` is absent.
        const key = args.key;
        const value = args.value;
        if (key === undefined || value === undefined) {
          throw new Error('ETN error [VALIDATION_ERROR]: key and value are required');
        }
        // Some MCP hosts stringify scalar union parameters ("true" instead of
        // true) — coerce the string back per the resolved definition's
        // value_type before the domain call (docs/05-mcp-server.md §5.2).
        // A missing definition is left to setPropertyValue to report (NOT_FOUND).
        const def = resolveDefinition(ndb, args.owner_type, args.owner_id, key);
        const coerced = def === null ? value : coerceStringifiedScalar(def, value);
        const stored = runWrite(ndb, fx, () => {
          const set = setPropertyValue(
            ndb,
            args.owner_type,
            args.owner_id,
            key,
            coerced,
            rt.deps.auth.userId,
          );
          return {
            result: set,
            events: [
              {
                type: 'property-value.set',
                data: {
                  owner_type: args.owner_type,
                  owner_id: args.owner_id,
                  property_id: set.property_id,
                  value: set.value,
                },
              },
            ],
            activity: [{ kind: 'owner', entityType: args.owner_type, entity: ownerEntity() }],
            audit: {
              action: 'etn.properties.set',
              targetType: args.owner_type,
              targetId: args.owner_id,
              details: { key, value: coerced },
            },
          };
        });
        return {
          id: stored.id,
          version: 0,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  // 0.8.1 (b3ce5014): операции над набором свойства-связи — добавить/убрать одну
  // цель, без чтения текущего набора. `add` принимает необязательный комментарий.
  const AddPropertySchema = z.object({
    network_id: NetworkId,
    owner_type: z.enum(PROPERTY_OWNER_TYPES),
    owner_id: z.string().min(1),
    key: z.string().min(1),
    value: z.string().min(1),
    comment: z.string().min(1).optional(),
  });
  mcp.registerTool(
    'etn.properties.add',
    {
      title: 'Добавить цель в свойство-связь',
      description:
        'Add one target (thought id) to a link property by key — idempotent: an already-live edge is a ' +
        'no-op. Accepts an optional `comment` explaining «why this link». Direction comes from the property ' +
        'definition, never from the call. Returns { link_id, created }.',
      inputSchema: PropertiesAdd.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.properties.add'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const res = runWrite(ndb, fx, () => {
          const result = addLinkPropertyValue(
            ndb,
            args.owner_type,
            args.owner_id,
            args.key,
            args.value,
            args.comment ?? null,
            rt.deps.auth.userId,
          );
          const createdLink = result.created ? getLink(ndb, result.link_id) : null;
          return {
            result,
            ...(createdLink === null
              ? {}
              : {
                  events: [{ type: 'link.created' as const, data: { link: createdLink } }],
                  activity: [
                    { kind: 'link' as const, action: 'created' as const, link: createdLink },
                  ],
                }),
            audit: {
              action: 'etn.properties.add',
              targetType: args.owner_type,
              targetId: args.owner_id,
              details: { key: args.key, value: args.value, comment: args.comment },
            },
          };
        });
        return {
          link_id: res.link_id,
          created: res.created,
          request_id: String(extra.requestId),
        };
      }),
  );

  const RemovePropertySchema = z.object({
    network_id: NetworkId,
    owner_type: z.enum(PROPERTY_OWNER_TYPES),
    owner_id: z.string().min(1),
    key: z.string().min(1),
    value: z.string().min(1),
  });
  mcp.registerTool(
    'etn.properties.remove',
    {
      title: 'Убрать цель из свойства-связи',
      description:
        'Remove one target (thought id) from a link property by key — marks the edge for deletion (trash), ' +
        'preserving its comment. Idempotent: an absent edge is a no-op (`link_id: null`). Returns ' +
        '{ link_id }.',
      inputSchema: PropertiesRemove.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.properties.remove'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const res = runWrite(ndb, fx, () => {
          const result = removeLinkPropertyValue(
            ndb,
            args.owner_type,
            args.owner_id,
            args.key,
            args.value,
            rt.deps.auth.userId,
          );
          // Помечаем в корзину — событие `link.updated` с marked_for_deletion
          // (журнал пишет `trashed`, а не `deleted`).
          const marked = result.link_id !== null ? getLink(ndb, result.link_id) : null;
          return {
            result,
            ...(marked === null
              ? {}
              : {
                  events: [
                    {
                      type: 'link.updated' as const,
                      data: {
                        id: marked.id,
                        changes: { marked_for_deletion: true },
                        version: marked.version,
                      },
                    },
                  ],
                  activity: [{ kind: 'link' as const, action: 'trashed' as const, link: marked }],
                }),
            audit: {
              action: 'etn.properties.remove',
              targetType: args.owner_type,
              targetId: args.owner_id,
              details: { key: args.key, value: args.value },
            },
          };
        });
        return { link_id: res.link_id, request_id: String(extra.requestId) };
      }),
  );
}

export function registerUsageClearTool(mcp: McpServer, rt: McpRuntime): void {
  const UsageClearSchema = z.object({
    network_id: NetworkId,
    thought_id: ThoughtId,
  });
  mcp.registerTool(
    'etn.thoughts.usage_clear',
    {
      title: 'Очистить использование мысли',
      description:
        'Trash every blocking link-property edge of other thoughts that references this one — clears ' +
        'the «использование в свойствах» blocking arm in one call instead of editing each property. ' +
        'Returns { cleared }.',
      inputSchema: ThoughtsUsageClear.schema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const cleared = runWrite(ndb, fx, () => {
          getThoughtOrThrow(ndb, args.thought_id);
          const result = clearThoughtRefUsages(ndb, args.thought_id);
          return {
            result,
            audit: {
              action: 'etn.thoughts.usage_clear',
              targetType: 'thought',
              targetId: args.thought_id,
              details: { cleared: result },
            },
          };
        });
        return { cleared, request_id: String(extra.requestId) };
      }),
  );

  // =========================================================================
  // Object-locks (task a88acf20, операция b6b776ff «etn.locks.*»)
  // -------------------------------------------------------------------------
  // Паритет с REST `/locks` (задача 2031df5e). Семантика ошибок единая:
  //   * `LOCKED` (409)        — acquire чужого захвата, `details.holder`
  //     содержит `{ user_id, client_id, acquired_at_ms }`.
  //   * `LOCK_NOT_FOUND` (404) — release несуществующего lock_id.
  //   * `FORBIDDEN` (403)     — release чужого захвата.
  //   * `VALIDATION_ERROR` (422) — обязательные поля.
  //
  // События real-time `edit.acquired` / `edit.released` / `edit.cleared`
  // эмитятся через `emitAgentEvent` — они доходят до подписчиков через тот же
  // поток, что и REST-события (`emitDomainEvent` использует
  // `REALTIME_EVENT_AUDIENCE[type]`, для `edit.*` это `network`).
  // В журнал активности захваты НЕ пишутся — требование b0c7a57c — поэтому
  // здесь именно `emitAgentEvent`, а не `emitAgentActivityEvent`.
  // =========================================================================
}
