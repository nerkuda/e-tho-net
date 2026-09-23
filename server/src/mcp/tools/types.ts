/**
 * types.ts — MCP-инструменты области «registerTypesListTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';

import { EtnError, MCP_TOOL_ANNOTATIONS, TRAVERSAL_DEFAULTS, TYPES_LIST_BUDGET_PREVIEW_CHARS } from '@etn/shared';
import type { McpTypesListMeta, McpTypesListResult } from '@etn/shared';
import { getThoughtOrThrow } from '../../domain/thought-service.js';
import { TypesList } from '../../contracts.js';
import { listEffectiveTypeProperties } from '../../domain/property-service.js';
import { collectSubtreeTypes } from '../../domain/search-service.js';
import { shrinkTypesListToBudget } from '../types-list-budget.js';
import { sanitizeIcon } from '../catalogs.js';
import { listThoughtTypes } from '../../domain/thought-type-service.js';
import { listLinkTypes } from '../../domain/link-type-service.js';
import { listThoughtTypeViewsByType } from '../../domain/thought-type-views-service.js';
import { openMemberNetwork, runTool } from '../context.js';

export function registerTypesListTool(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.types.list',
    {
      title: 'Каталог типов',
      description:
        'Both type catalogues in full — thought and link types with hierarchy (`parent_id`/`is_root`), ' +
        'AI-facing `description` and effective property definitions (own + inherited along the type ' +
        'chain): `key`, `value_type`, `required`, `config` (incl. `options`/`allowed_type_ids`), ' +
        '`default_value`, `inherited`, `defined_on`, `property_id` (the registry id). Каждый ' +
        'тип мысли несёт собственные `views[]`: имя, ' +
        'описание и `is_default` отборов этого типа без наследования от предков ' +
        '(эффективный набор для конкретной мысли — через `etn.thoughts.get { meta.views }`). ' +
        'Call before creating a typed thought/link; also lets `type_id` be replaced by a type name in ' +
        '`etn.thoughts.write` (`thought.type`/`links[].type`). `in_subtree_of` ' +
        '(+`max_depth`) scopes to the types actually used inside that subtree, each with a ' +
        '`usage_count`. Пагинация `limit`/`offset` (1..500 / ≥0) применяется к каждому каталогу ' +
        'отдельно; `max_chars` (≥1000) мягко режет payload до бюджета клиента — сначала сужает ' +
        '`description` до ' + String(TYPES_LIST_BUDGET_PREVIEW_CHARS) + ' символов, потом отбрасывает ' +
        'хвостовые типы. Диагностика — `meta.truncated` + `meta.reason`. Поведение без новых ' +
        'параметров не меняется. When the response risks being cut off, fetch a single catalogue via ' +
        '`scope: "links"` / `"thoughts"`.',
      inputSchema: TypesList.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.types.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);

        // O16: subtree-scoped catalogue. If `in_subtree_of` references an
        // unknown thought, surface the same error a `thoughts.get` would.
        let thoughtTypeCounts: Map<string, number> | null = null;
        let linkTypeCounts: Map<string, number> | null = null;
        if (args.in_subtree_of !== undefined) {
          const seed = getThoughtOrThrow(ndb, args.in_subtree_of);
          if (seed === null) {
            throw new EtnError(
              'NOT_FOUND',
              `Thought ${args.in_subtree_of} not found.`,
              { thought_id: args.in_subtree_of },
            );
          }
          const subtree = collectSubtreeTypes(ndb, args.in_subtree_of, {
            maxDepth: args.max_depth,
          });
          thoughtTypeCounts = subtree.thought_type_counts;
          linkTypeCounts = subtree.link_type_counts;
        }

        const fullThoughtTypes = listThoughtTypes(ndb)
          .filter((t) => thoughtTypeCounts === null || thoughtTypeCounts.has(t.id))
          .map((t) => ({
            id: t.id,
            name: t.name,
            parent_id: t.parent_id,
            is_root: t.is_root,
            description: t.description,
            // Bug fix (§5.1e): `etn.types.list` has no `view` param — always
            // sanitize the inline `data:` icon URL.
            icon: sanitizeIcon(t.icon),
            properties: listEffectiveTypeProperties(ndb, 'thought_type', t.id),
            // Собственные отборы типа (задача c1fa71d4, 0.7.3): без
            // наследования от предков — это контракт `etn.types.list`,
            // эффективный набор для конкретной мысли идёт через
            // `etn.thoughts.get { meta.views }`. Читаем через
            // `thought_type_views_v` (представление сворачивает слои
            // по правилу «ближайший побеждает»): отборы, определённые
            // на самом типе в текущем слое, перекрывают базовый слой;
            // отборы же с предков-типов НЕ подтягиваем — это не
            // эффективный набор. Параметр `currentLayerOnly: true`
            // (как у REST `GET /thought-types/{id}/views`, контракт
            // b90bb6e6) здесь НЕ уместен: он фильтрует по
            // `ndb.layerId` и при работе из дочернего слоя
            // возвращает отборы только этого слоя — отсюда пустой
            // `views: []` для типов, чьи отборы лежат в базовом
            // слое (ошибка 24632488-…-…, 0.7.4).
            views: listThoughtTypeViewsByType(ndb, t.id).map((v) => ({
              id: v.id,
              name: v.name,
              name_key: v.name_key,
              description: v.description,
              position: v.position,
              is_default: v.is_default,
            })),
            ...(thoughtTypeCounts === null
              ? {}
              : { usage_count: thoughtTypeCounts.get(t.id) ?? 0 }),
          }));
        const fullLinkTypes = listLinkTypes(ndb)
          .filter((t) => linkTypeCounts === null || linkTypeCounts.has(t.id))
          .map((t) => ({
            id: t.id,
            name_forward: t.name_forward,
            name_reverse: t.name_reverse,
            parent_id: t.parent_id,
            is_root: t.is_root,
            description: t.description,
            color: t.color,
            style: t.style,
            properties: listEffectiveTypeProperties(ndb, 'link_type', t.id),
            ...(linkTypeCounts === null
              ? {}
              : { usage_count: linkTypeCounts.get(t.id) ?? 0 }),
          }));

        // Task f9c7dbc5 (0.7.4): when `limit`/`offset` are present we slice
        // each catalogue after the (subtree-filtered) sort. The two
        // catalogues are paginated independently — `limit: 2` returns 2
        // thought-types + 2 link-types when `scope: "all"`, which is the
        // minimum the agent can iterate over both halves in one round trip.
        const offset = args.offset ?? 0;
        const limit = args.limit;
        const paginate = <T,>(arr: ReadonlyArray<T>): T[] => {
          if (limit === undefined) return arr.slice();
          return arr.slice(offset, offset + limit);
        };
        const paginatedThoughtTypes = paginate(fullThoughtTypes);
        const paginatedLinkTypes = paginate(fullLinkTypes);

        const scope = args.scope ?? 'all';
        const payload: {
          thought_types?: typeof paginatedThoughtTypes;
          link_types?: typeof paginatedLinkTypes;
          scope?: {
            in_subtree_of: string;
            max_depth: number;
            thought_types_total: number;
            link_types_total: number;
          };
          meta?: McpTypesListMeta;
        } = {
          ...(scope === 'thoughts' || scope === 'all'
            ? { thought_types: paginatedThoughtTypes }
            : {}),
          ...(scope === 'links' || scope === 'all'
            ? { link_types: paginatedLinkTypes }
            : {}),
          ...(args.in_subtree_of === undefined
            ? {}
            : {
                scope: {
                  in_subtree_of: args.in_subtree_of,
                  max_depth: args.max_depth ?? TRAVERSAL_DEFAULTS.MAX_DEPTH,
                  thought_types_total: fullThoughtTypes.length,
                  link_types_total: fullLinkTypes.length,
                },
              }),
        };

        // Budget shrink (task f9c7dbc5). Skip entirely when the caller did
        // not pass `max_chars` — preserves the legacy shape verbatim
        // (no `meta` block, identical JSON output).
        if (args.max_chars !== undefined) {
          const result = shrinkTypesListToBudget(payload, {
            max_chars: args.max_chars,
          });
          payload.thought_types = result.payload.thought_types;
          payload.link_types = result.payload.link_types;
          payload.meta = {
            truncated: result.truncated,
            reason: result.reason,
            ...(scope === 'thoughts' || scope === 'all'
              ? { thought_types_total: fullThoughtTypes.length }
              : {}),
            ...(scope === 'links' || scope === 'all'
              ? { link_types_total: fullLinkTypes.length }
              : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
            max_chars: args.max_chars,
            original_chars: result.original_chars,
            final_chars: result.final_chars,
          };
        } else if (args.limit !== undefined || args.offset !== undefined) {
          // Pagination was requested but no `max_chars` — surface totals so
          // the caller knows how much is left, even when nothing was
          // trimmed. The `truncated` flag stays false.
          payload.meta = {
            truncated: false,
            reason: null,
            ...(scope === 'thoughts' || scope === 'all'
              ? { thought_types_total: fullThoughtTypes.length }
              : {}),
            ...(scope === 'links' || scope === 'all'
              ? { link_types_total: fullLinkTypes.length }
              : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
          };
        }

        return payload satisfies McpTypesListResult;
      }),
  );

}
