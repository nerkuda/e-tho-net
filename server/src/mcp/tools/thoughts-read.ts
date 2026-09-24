/**
 * thoughts-read.ts — MCP-инструменты области «registerThoughtsReadTools, registerFindDuplicatesTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 *
 * Cross-network (fan-out) режим (задача eb1a3f43, требование c98d5d19):
 * `etn.thoughts.search`, `etn.thoughts.query` и `etn.thoughts.find_duplicates`
 * принимают опциональный `network_ids`. При его наличии вызов делегирует
 * `cross-network-search-service` (fan-out + merge), фильтруя сети по
 * `hasNetworkAccess`. Сети без доступа молча исключаются.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { EtnError, MCP_TOOL_ANNOTATIONS, SUBGRAPH_PERMANENT_PREVIEW_CHARS, TRAVERSAL_DEFAULTS } from '@etn/shared';
import type { McpViewMode } from '@etn/shared';
import { countNeighbors, getNeighbors, getThoughtOrThrow, getThoughtsByIdsResolved } from '../../domain/thought-service.js';
import { ThoughtsFindDuplicates, ThoughtsGet, ThoughtsNeighbors, ThoughtsQuery, ThoughtsResolve, ThoughtsSearch, ThoughtsSubgraph, ThoughtsUsage } from '../../contracts.js';
import { getLinkFillingFlags } from '../../domain/link-service.js';
import { getCommentsPreview } from '../../domain/comment-service.js';
import { findThoughtUsage, getNetworkProperty, getPropertyValuesResolved, resolveConditionPropertyRef } from '../../domain/property-service.js';
import { findDuplicates, resolveThoughts, search } from '../../domain/search-service.js';
import { shrinkSubgraphToBudget } from '../subgraph-budget.js';
import { mcpRequestToQuery, queryThoughts } from '../../domain/query-service.js';
import { getThoughtMeta } from '../../domain/thought-meta.js';
import { recordReads } from '../../domain/read-metrics-service.js';
import { linkTypeCatalog, thoughtTypeCatalog, toCardThoughtType, toCompactThought, withSanitizedIcon } from '../catalogs.js';
import {
  omitEmptyContainers,
  projectLinkRow,
  projectThoughtRows,
  stripStructuralLinkProperties,
} from '../../domain/response-projection.js';
import { subgraph, traverse } from '../../domain/graph-traversal.js';
import { getThoughtType, resolveThoughtTypeIdByName } from '../../domain/thought-type-service.js';
import { getEffectiveViewsForThought } from '../../domain/thought-type-views-service.js';
import { hasNetworkAccess, mcpLayerClientId, openMemberNetwork, runTool } from '../context.js';
import {
  fanOutFindDuplicates,
  fanOutQuery,
  fanOutSearch,
  type CrossNetworkAccess,
} from '../../domain/cross-network-search-service.js';

/** Собрать кросс-сетевой «доступ»: отфильтровать сети по правам, подтянуть
 *  `display_name` из `systemDb` для справочника. Используется только когда
 *  в MCP-вызове передан `network_ids` (задача eb1a3f43). */
function buildCrossNetworkAccess(
  rt: McpRuntime,
  requested: string[],
): CrossNetworkAccess & { accessibleIds: string[] } {
  const seen = new Set<string>();
  const accessibleIds: string[] = [];
  for (const id of requested) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (hasNetworkAccess(rt, id)) accessibleIds.push(id);
  }
  const networks = accessibleIds
    .map((id) => {
      const row = rt.deps.systemDb.getNetworkById(id);
      return { id, display_name: row?.display_name ?? id };
    });
  return {
    networks,
    accessibleIds,
    dataDir: rt.deps.dataDir,
    userId: rt.deps.auth.userId,
    clientId: mcpLayerClientId(rt),
    logger: rt.deps.logger,
  };
}

export function registerThoughtsReadTools(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.thoughts.search',
    {
      title: 'Полнотекстовый поиск',
      description:
        'Full-text search across thought names, comment texts, link texts and chronology. `scope` selects ' +
        'result groups (`names`/`texts`/`links`/`chronology`/`all`); `in_subtree_of`, `type_id` (or its ' +
        'name-form `type`, resolved case-insensitively via `etn.types.list`; `NOT_FOUND` if no such type, ' +
        '`VALIDATION_ERROR` with `details.candidates` on ambiguity), `author_id`/`editor_id` narrow it. ' +
        '`limit` (1–200, default 50) + `offset` walk the tail; `meta.total_in_group` gives unfiltered totals ' +
        'per group.',
      inputSchema: ThoughtsSearch.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.search'],
    },
    (args) =>
      runTool(async () => {
        // Задача eb1a3f43, требование c98d5d19: веерный режим.
        if (args.network_ids !== undefined) {
          const access = buildCrossNetworkAccess(rt, args.network_ids);
          if (access.networks.length === 0) {
            // Ни одна сеть не доступна — пустой ответ со справочником.
            return {
              by_names: [],
              by_texts: [],
              by_links: [],
              by_chrono: [],
              meta: { total_in_group: { names: 0, texts: 0, links: 0, chronology: 0 } },
              networks: [],
            };
          }
          // Резолв имени типа — только если задано. В веерном режиме одна и та
          // же строка `type` может означать разные id в разных сетях; используем
          // первую сеть как «контекст» для резолва и фильтруем остальные по тому
          // же имени на уровне `expandTypeIdsToSubtree` (внутри `search`).
          let resolvedType: { input: string; id: string; name: string } | undefined;
          if (args.type !== undefined) {
            const firstNdb = openMemberNetwork(rt, access.networks[0]!.id);
            const id = resolveThoughtTypeIdByName(firstNdb, args.type);
            const name = getThoughtType(firstNdb, id)?.name;
            resolvedType = { input: args.type, id, name: name ?? args.type };
          }
          const result = fanOutSearch(access, {
            networkIds: access.accessibleIds,
            q: args.query,
            scope: args.scope,
            in: args.in_subtree_of === undefined ? undefined : 'subtree',
            from_thought_id: args.in_subtree_of,
            type_id: resolvedType !== undefined ? [resolvedType.id] : (args.type_id !== undefined && args.type_id !== null ? [args.type_id] : undefined),
            type: args.type,
            author_id: args.author_id,
            editor_id: args.editor_id,
            show_inactive: args.show_inactive,
            limit: args.limit ?? 50,
            offset: args.offset ?? 0,
            showInactiveDefault: false,
          });
          // O10: count reads for the «head» network — the per-network reads
          // counter is per-network, so we count hits from each network in its
          // own session.
          for (const net of access.networks) {
            const ndb = openMemberNetwork(rt, net.id);
            const thoughtIds = [
              ...result.response.by_names.filter((h) => h.network_id === net.id).map((h) => h.thought_id),
              ...result.response.by_texts.filter((h) => h.network_id === net.id).map((h) => h.thought_id),
              ...result.response.by_chrono
                .filter((h) => h.network_id === net.id && h.owner === 'thought')
                .map((h) => h.owner_id),
            ];
            if (thoughtIds.length > 0) recordReads(ndb, thoughtIds, { now: new Date().toISOString() });
          }
          return {
            ...result.response,
            by_names: projectThoughtRows(result.response.by_names.map((h) => withSanitizedIcon(h))),
            by_texts: projectThoughtRows(result.response.by_texts.map((h) => withSanitizedIcon(h))),
            networks: result.networks,
            ...(resolvedType !== undefined ? { resolved_type: resolvedType } : {}),
          };
        }
        const ndb = openMemberNetwork(rt, args.network_id as string);
        // Резолв имени типа в id (задача d5ab1630). Сбор эха для ответа —
        // `resolved_type` приходит, только если агент передал `type`.
        let resolvedType: { input: string; id: string; name: string } | undefined;
        let typeIdForDomain: string[] | undefined;
        if (args.type !== undefined) {
          const id = resolveThoughtTypeIdByName(ndb, args.type);
          const name = getThoughtType(ndb, id)?.name;
          resolvedType = { input: args.type, id, name: name ?? args.type };
          typeIdForDomain = [id];
        } else if (args.type_id !== undefined && args.type_id !== null) {
          typeIdForDomain = [args.type_id];
        }
        const result = search(ndb, {
          q: args.query,
          scope: args.scope,
          in: args.in_subtree_of === undefined ? undefined : 'subtree',
          from_thought_id: args.in_subtree_of,
          type_id: typeIdForDomain,
          author_id: args.author_id,
          editor_id: args.editor_id,
          limit: args.limit,
          offset: args.offset,
        });
        // O10: count the thoughts referenced by name/text/chrono hits. Link hits
        // (`by_links`) carry only `link_id`, so they don't move a thought counter.
        const thoughtIds = [
          ...result.by_names.map((h) => h.thought_id),
          ...result.by_texts.map((h) => h.thought_id),
          ...result.by_chrono
            .filter((h) => h.owner === 'thought')
            .map((h) => h.owner_id),
        ];
        recordReads(ndb, thoughtIds, { now: new Date().toISOString() });
        // Bug fix (§5.1e): `search` is shared with the REST `/search` route
        // (which needs the real icon to render results), so project only at
        // this MCP-facing call site. Every MCP list record goes through the
        // single `projection.ts` — compact drops visual/service fields and
        // omits empty containers; the icon itself stays and `data:` URLs are
        // sanitized inside the projection.
        return {
          ...result,
          by_names: projectThoughtRows(result.by_names.map((h) => withSanitizedIcon(h))),
          by_texts: projectThoughtRows(result.by_texts.map((h) => withSanitizedIcon(h))),
          ...(resolvedType !== undefined ? { resolved_type: resolvedType } : {}),
        };
      }),
  );
  mcp.registerTool(
    'etn.thoughts.query',
    {
      title: 'Структурная выборка мыслей',
      description:
        'Структурная выборка мыслей без текстового запроса; фильтры комбинируются по AND: ' +
        '`in_subtree_of`(+`max_depth`), `type_id[]` (или имена `type[]`), `active`/`trashed`, ' +
        '`keywords` (мини-синтаксис по названию и синонимам), `properties[]` (операторы ' +
        'eq/ne/contains/gt/gte/lt/lte/any_of/all_of/none_of), диапазоны `created_*`/`updated_*`, ' +
        '`author_id`/`editor_id`, `link_filter`. Ответ несёт справочник `thought_types` и эхо ' +
        '`resolved_types`/`resolved_properties` для входов по имени. Справочник фильтров, семантика ' +
        'свойств-связей и наборов — `etn.guide { topic: "thoughts.query" }`.',
      inputSchema: ThoughtsQuery.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.query'],
    },
    (args) =>
      runTool(async () => {
        // Задача eb1a3f43, требование c98d5d19: веерный режим.
        if (args.network_ids !== undefined) {
          const access = buildCrossNetworkAccess(rt, args.network_ids);
          if (access.networks.length === 0) {
            return {
              total: 0,
              hits: [],
              truncated: false,
              reason: null,
              networks: [],
            };
          }
          // Резолв имён типов — берём первую сеть как контекст, как и в search.
          let resolvedTypes: Array<{ input: string; id: string; name: string }> | undefined;
          let resolvedTypeIds: string[] | undefined;
          if (args.type !== undefined) {
            const firstNdb = openMemberNetwork(rt, access.networks[0]!.id);
            resolvedTypes = [];
            resolvedTypeIds = [];
            for (const name of args.type) {
              const id = resolveThoughtTypeIdByName(firstNdb, name);
              const rowName = getThoughtType(firstNdb, id)?.name;
              resolvedTypes.push({ input: name, id, name: rowName ?? name });
              resolvedTypeIds.push(id);
            }
          }
          // Резолв имён свойств в первой сети (при наличии имён). Другие сети
          // сети будут фильтроваться по тому же `property_id` — если свойства
          // нет, фильтр вернёт пусто, что корректно.
          let resolvedProperties: Array<{ input: string; id: string; name: string }> | undefined;
          let domainProperties = args.properties;
          if (args.properties !== undefined) {
            const firstNdb = openMemberNetwork(rt, access.networks[0]!.id);
            const out: NonNullable<typeof args.properties> = [];
            let resolved: Array<{ input: string; id: string; name: string }> | null = null;
            for (const cond of args.properties) {
              if (cond.property !== undefined) {
                const ref = resolveConditionPropertyRef(firstNdb, cond.property);
                if (ref === null) {
                  throw new EtnError('NOT_FOUND', `property "${cond.property}" not found`, {
                    field: 'property',
                    name: cond.property,
                  });
                }
                const propName = getNetworkProperty(firstNdb, ref.propertyId)?.name;
                out.push({ ...cond, property_id: cond.property });
                if (resolved === null) resolved = [];
                resolved.push({ input: cond.property, id: ref.propertyId, name: propName ?? cond.property });
                continue;
              }
              out.push(cond);
            }
            domainProperties = out;
            if (resolved !== null) resolvedProperties = resolved;
          }
          const result = fanOutQuery(access, {
            networkIds: access.accessibleIds,
            // Используем `mcpRequestToQuery` — единый канонический конвертер,
            // тот же, что и в обычном (односетевом) пути ниже.
            query: mcpRequestToQuery(
              {
                ...args,
                type_id: args.type_id ?? resolvedTypeIds,
                type: undefined,
                properties: domainProperties,
              },
              { maxNodes: rt.limits.maxNodesPerSubgraph },
            ),
            limit: args.limit ?? 50,
            offset: args.offset ?? 0,
          });
          // O10: count reads per network.
          for (const net of access.networks) {
            const ndb = openMemberNetwork(rt, net.id);
            const ids = result.response.hits.filter((h) => h.network_id === net.id).map((h) => h.id);
            if (ids.length > 0) recordReads(ndb, ids, { now: new Date().toISOString() });
          }
          return {
            total: result.response.total,
            hits: result.response.hits,
            truncated: result.response.truncated,
            reason: result.response.reason,
            networks: result.networks,
            ...(resolvedTypes !== undefined ? { resolved_types: resolvedTypes } : {}),
            ...(resolvedProperties !== undefined ? { resolved_properties: resolvedProperties } : {}),
          };
        }
        const ndb = openMemberNetwork(rt, args.network_id as string);
        // Резолв имён типов в id (задача d5ab1630). Сбор эха для ответа —
        // `resolved_types` приходит, только если агент передал `type`.
        let resolvedTypes: Array<{ input: string; id: string; name: string }> | undefined;
        if (args.type !== undefined) {
          resolvedTypes = [];
          for (const name of args.type) {
            const id = resolveThoughtTypeIdByName(ndb, name);
            const rowName = getThoughtType(ndb, id)?.name;
            resolvedTypes.push({ input: name, id, name: rowName ?? name });
          }
        }
        // Резолв имён свойств в id. Сбор эха `resolved_properties` —
        // аналогично, только при наличии условий с `property`.
        // Задача df992826: имя может быть и обратным именем свойства-связи —
        // тогда условие адресует противоположную сторону, и `property_id`
        // остаётся ИМЕНЕМ: направление рёбер разрешает движок отбора
        // (`resolveConditionPropertyRef`) по имени стороны.
        let resolvedProperties:
          | Array<{ input: string; id: string; name: string }>
          | undefined;
        let domainProperties = args.properties;
        if (args.properties !== undefined) {
          const out: NonNullable<typeof args.properties> = [];
          let resolved: Array<{ input: string; id: string; name: string }> | null = null;
          for (const cond of args.properties) {
            if (cond.property !== undefined) {
              const ref = resolveConditionPropertyRef(ndb, cond.property);
              if (ref === null) {
                throw new EtnError('NOT_FOUND', `property "${cond.property}" not found`, {
                  field: 'property',
                  name: cond.property,
                });
              }
              const propName = getNetworkProperty(ndb, ref.propertyId)?.name;
              out.push({ ...cond, property_id: cond.property });
              if (resolved === null) resolved = [];
              resolved.push({ input: cond.property, id: ref.propertyId, name: propName ?? cond.property });
              continue;
            }
            out.push(cond);
          }
          domainProperties = out;
          if (resolved !== null) resolvedProperties = resolved;
        }
        // Единый движок выборки (задача c5265deb): MCP-запрос переводится в
        // канонический адаптером (имена типов/свойств уже отрезолвнуты фасадом
        // выше) и исполняется той же доменной функцией, что REST-фильтр.
        const result = queryThoughts(
          ndb,
          rt.deps.auth.userId,
          mcpRequestToQuery(
            {
              ...args,
              // Передаём уже резолвнутые id (MCP-фасад гарантирует, что
              // XOR-схема соблюдена и обе формы не приходят одновременно).
              type_id:
                args.type_id ??
                (resolvedTypes !== undefined ? resolvedTypes.map((r) => r.id) : undefined),
              type: undefined,
              properties: domainProperties,
            },
            { maxNodes: rt.limits.maxNodesPerSubgraph },
          ),
          { maxLimit: 200, emptyFilterMode: 'all' },
        );
        // O10: count every hit in the structured query.
        recordReads(ndb, result.items.map((h) => h.id), { now: new Date().toISOString() });
        const hits = result.items.map((t) => ({
          id: t.id,
          title: t.title,
          type_id: t.type_id,
          active: t.active,
          depth: result.depths === null ? null : (result.depths.get(t.id) ?? null),
        }));
        return {
          total: result.total,
          hits,
          truncated: result.truncated,
          reason: result.reason,
          thought_types: thoughtTypeCatalog(ndb, result.items.map((h) => h.type_id)),
          ...(resolvedTypes !== undefined ? { resolved_types: resolvedTypes } : {}),
          ...(resolvedProperties !== undefined ? { resolved_properties: resolvedProperties } : {}),
        };
      }),
  );
  mcp.registerTool(
    'etn.thoughts.get',
    {
      title: 'Мысль (полная)',
      description:
        'Одна мысль целиком: синонимы, вложенный тип (`name` + AI-описание, без визуальных полей) и ' +
        'значения свойств (`outside_type: true` — свойство не на цепочке типа владельца, карточка не ' +
        'пустая). Структурные «Родители»/«Потомки» не возвращаются — их числа в `meta`. ' +
        '`meta.permanent` — полный текст постоянного комментария (у других выборок превью 2000 ' +
        'символов; полностью — `etn.comments.get`). `meta.link_stats` — счётчики активных связей по ' +
        '`(link_type_id, direction)` с именами типа; помеченные на удаление рёбра не считаются. ' +
        '`meta.views` — эффективные отборы мысли (имя, описание, тип-владелец), исполняются через ' +
        '`etn.views.run`. `view: "compact"` (default) — без визуальных полей.',
      inputSchema: ThoughtsGet.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.get'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const rawThought = getThoughtOrThrow(ndb, args.thought_id);
        const rawType = rawThought.type_id === null ? null : getThoughtType(ndb, rawThought.type_id);
        // Задача 7849008a, требование 6d4ad9ac: значения `cross_network_ref`
        // фильтруются по правам доступа к целевой сети. Список сетей
        // пользователя запрашивается в системной БД.
        const accessibleNetworkIds = new Set(
          rt.deps.systemDb.listNetworksForUser(rt.deps.auth.userId).map((n) => n.id),
        );
        const properties = getPropertyValuesResolved(
          ndb,
          'thought',
          args.thought_id,
          accessibleNetworkIds,
        );
        // O10: count this single read for `etn.metrics.reads` analytics.
        recordReads(ndb, [rawThought.id], { now: new Date().toISOString() });
        // Задача 3ea09a54: для `etn.thoughts.get` `meta.permanent` отдаётся
        // полным текстом (без `chars_*`/`truncated`). Все остальные выборки
        // сущностей (subgraph, structure, списки) продолжают получать
        // preview-форму — требование «выборка сущностей → превью».
        // `meta.views` (задача c1fa71d4, операция cb8d8e43) собирается
        // внутри `getThoughtMeta` (домен, требование eaca1253): эффективный
        // набор отборов для мысли по цепочке типов. Агент видит, какие
        // отборы доступны, и дёргает их по имени через `etn.views.run`.
        const meta = getThoughtMeta(ndb, args.thought_id, { fullPermanent: true });
        const view: McpViewMode = args.view ?? 'compact';
        // Bug fix (docs/05-mcp-server.md §5.1e): a `data:` icon URL is dropped
        // in every view — see `sanitizeIcon`/`withSanitizedIcon` in
        // ./catalogs.ts for the rationale. Applied before the O12 branch so
        // both `full` and `compact` get the same treatment.
        const thought = withSanitizedIcon(rawThought);
        // 0.8.3 (требование «Каталоги типов в ответах read-инструментов»):
        // вложенный тип карточки — `name` + `description`, без визуальных
        // полей. Полное определение — в `etn.types.list`.
        const type = toCardThoughtType(rawType);
        // 0.8.3 (требование «Карточка отдаёт связи счётчиками»): структурные
        // «Родители»/«Потомки» из `properties` не возвращаются — их числа уже
        // в `meta.parents_count`/`children_count` и в `meta.link_stats`.
        const cardProperties = stripStructuralLinkProperties({ properties }).properties;
        // Keep the response envelope identical between views — only the
        // thought-level fields differ. `type`, `properties` and `meta` were
        // never affected by the O12 projection change.
        const projected = view === 'full' ? thought : toCompactThought(thought);
        return { ...projected, type, properties: cardProperties, meta };
      }),
  );

  // etn.thoughts.resolve — пакетное чтение по списку id (задача 6d45ab37,
  // спека 85b94925, P1-паритет MCP↔REST `POST /thoughts/resolve`).
  // Возвращает карточки в порядке первого появления id в запросе плюс
  // `missing[]` для отсутствующих. Лимит по размеру пачки —
  // `rt.limits.maxNodesPerSubgraph` (тот же, что у `etn.thoughts.subgraph`).
  mcp.registerTool(
    'etn.thoughts.resolve',
    {
      title: 'Пакетное чтение мыслей',
      description:
        'Батч-чтение по списку id: `items[]` (карточки в порядке первого появления, дубли ' +
        'схлопываются) + `missing[]`. Неразрешимый id (в т.ч. короткий префикс — ' +
        'ненайденный или неоднозначный) попадает в `missing[]`, а не отвергает весь батч. ' +
        'Карточка несёт мысль, вложенный тип (`name` + `description`), ' +
        'свойства (без структурных «Родители»/«Потомки» — их числа в `meta`), `meta.link_stats` ' +
        '(счётчики с именами типов связей), ' +
        'полнотекстовый `comment_preview` и `meta.views` — ' +
        'эффективный набор отборов для каждой мысли (по цепочке типов). ' +
        'Лимит — `maxNodesPerSubgraph`.',
      inputSchema: ThoughtsResolve.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.resolve'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const view: McpViewMode = args.view ?? 'compact';
        const result = getThoughtsByIdsResolved(ndb, args.thought_ids);
        // O10: count reads for `etn.metrics.reads` analytics.
        recordReads(
          ndb,
          result.items.map((c) => c.id),
          { now: new Date().toISOString() },
        );
        // Bug fix (§5.1e): `getThoughtsByIdsResolved` returns the raw `data:`
        // icon URL — sanitize in both views so the agent never sees an inline
        // image payload. The compact projection below also reads `card.icon`,
        // so sanitising the source once is enough.
        // 0.8.3: вложенный тип карточки — `name` + `description` без
        // визуальных полей (требование «Каталоги типов в ответах
        // read-инструментов»), поэтому иконку типа больше не санитайзим.
        // Структурные «Родители»/«Потомки» из `properties` убираем: их числа
        // уже в `meta` (требование «Карточка отдаёт связи счётчиками»).
        const sanitizedItems = result.items.map((card) =>
          stripStructuralLinkProperties({
            ...withSanitizedIcon(card),
            type: toCardThoughtType(card.type),
          }),
        );
        // `meta.views` (задача c1fa71d4) — собирается внутри `getThoughtMeta`,
        // которую зовёт `getThoughtsByIdsResolved` (домен, требование eaca1253).
        // Дополнительной обвязки здесь не требуется — `card.meta.views` уже
        // заполнен.
        const itemsWithViews = sanitizedItems;
        // Compact-проекция карточки — единый сериализатор (projection.ts):
        // визуальные поля (цвета, флаги шрифта, вложение иконки) и сервисные
        // (version, авторство) снимаются, пустые synonyms/views не пишутся;
        // `icon`, `type`, `properties`, `meta` и `comment_preview` остаются в
        // полной форме — тот же контракт, что и у `etn.thoughts.get`.
        const items =
          view === 'full'
            ? itemsWithViews
            : projectThoughtRows(itemsWithViews);
        // Reference table: только типы, реально использованные в items.
        const thoughtTypes = thoughtTypeCatalog(
          ndb,
          sanitizedItems.map((c) => c.type_id),
        );
        return { items, missing: result.missing, thought_types: thoughtTypes };
      }),
  );
  mcp.registerTool(
    'etn.thoughts.neighbors',
    {
      title: 'Соседи мысли',
      description:
        'Direct neighbours of a thought by direction (`parents`/`children`/`siblings`) or `both`; ' +
        '`depth > 1` does a bounded BFS walk. `dir: "both"` — оба направления одним вызовом, ' +
        'записи несут `direction: "in"|"out"`. Рёбра несут `has_properties`/`has_comment` — ' +
        'два агрегирующих запроса на весь набор рёбер, не на ребро; `link_marked_for_deletion` ' +
        'говорит, что ребро помечено на удаление (корзина) — оно остаётся ' +
        'видимым, но помеченным. НЕАКТИВНЫЕ соседи (мысль или ребро с `active: false`) ' +
        'скрываются по умолчанию и не входят в `total`; `show_inactive: true` их показывает ' +
        '(как в `search`/`query`) — и на `depth: 1`, и в BFS-обходе. На `depth: 1` страница 50 — ' +
        '`total`/`truncated` показывают остаток; дальше — `etn.thoughts.query { in_subtree_of, max_depth: 1 }`. ' +
        '`link_filter` — { type_ids?, include_structural? } ограничивает связи, по которым считается соседство. ' +
        'Справочники `link_types`/`thought_types`.',
      inputSchema: ThoughtsNeighbors.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.neighbors'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const depth = args.depth ?? 1;
        const view: McpViewMode = args.view ?? 'compact';
        if (depth === 1) {
          const thought = getThoughtOrThrow(ndb, args.thought_id);
          const neighborOpts = {
            userId: rt.deps.auth.userId,
            linkFilter: args.link_filter,
            showInactive: args.show_inactive,
          };
          // `dir: "both"` (0.7.2) — both directions in one call. The domain
          // `getNeighbors` is built for parents/children/siblings (REST trio)
          // and would map `both` to siblings; we call it twice and glue the
          // results here. Each entry carries its own `direction: "in"|"out"`.
          if (args.dir === 'both') {
            const parents = getNeighbors(ndb, args.thought_id, 'parents', neighborOpts).map((n) => ({
              ...n,
              direction: 'in' as const,
            }));
            const children = getNeighbors(ndb, args.thought_id, 'children', neighborOpts).map((n) => ({
              ...n,
              direction: 'out' as const,
            }));
            // Concatenate in arrival order (parents first, then children) — a
            // single thought can appear in both lists when it has both an
            // incoming and an outgoing edge to the focus, in which case BOTH
            // entries surface (separate `link_id`s).
            const rawNeighbors = [...parents, ...children];
            const neighbors = rawNeighbors.map((n) => withSanitizedIcon(n));
            // Edge flags: aggregating on the whole returned set.
            const fillingFlags = getLinkFillingFlags(
              ndb,
              neighbors.map((n) => n.link_id),
            );
            const annotated = neighbors.map((n) => {
              const flags = fillingFlags.get(n.link_id);
              return {
                ...n,
                has_properties: flags?.has_properties ?? false,
                has_comment: flags?.has_comment ?? false,
              };
            });
            // 0.8.3: справочник типов связей в списках — худой (id + оба
            // имени), `view` его не меняет. Описания типов — в `etn.types.list`.
            const linkTypes = linkTypeCatalog(ndb, annotated.map((n) => n.link_type_id));
            // Bug fix (0.6.3): honest counts come from the domain `countNeighbors`
            // (one SQL per direction — same shape, no LIMIT). Sum them and
            // compare to the trimmed page; `truncated` is per the page size.
            const parentsTotal = countNeighbors(ndb, args.thought_id, 'parents', neighborOpts);
            const childrenTotal = countNeighbors(ndb, args.thought_id, 'children', neighborOpts);
            const total = parentsTotal + childrenTotal;
            return omitEmptyContainers({
              thought: { id: thought.id, title: thought.title },
              dir: args.dir,
              depth: 1,
              neighbors: projectThoughtRows(annotated),
              total,
              truncated: total > annotated.length,
              link_types: linkTypes,
              thought_types: thoughtTypeCatalog(ndb, annotated.map((n) => n.type_id)),
            });
          }
          const rawNeighbors = getNeighbors(ndb, args.thought_id, args.dir, neighborOpts);
          // `FocusNeighbor` carries no visual fields of its own (only `icon`,
          // which is semantic), so the only O12 effect at depth=1 is on the
          // link-type catalogue. Bug fix (§5.1e): sanitize the `icon` itself —
          // it is not gated by `view`, a `data:` URL leaks at depth=1 either way.
          const neighbors = rawNeighbors.map((n) => withSanitizedIcon(n));
          // Edge flags: aggregating on the whole returned set.
          const fillingFlags = getLinkFillingFlags(
            ndb,
            neighbors.map((n) => n.link_id),
          );
          const annotated = neighbors.map((n) => {
            const flags = fillingFlags.get(n.link_id);
            return {
              ...n,
              has_properties: flags?.has_properties ?? false,
              has_comment: flags?.has_comment ?? false,
            };
          });
          // 0.8.3: справочник типов связей в списках — худой (`view` его не меняет).
          const linkTypes = linkTypeCatalog(ndb, annotated.map((n) => n.link_type_id));
          // Bug fix (0.6.3, thought f2c7c7d3): this tool has no limit/offset
          // of its own and silently applied the domain default page size
          // (50) — a thought with more neighbours than that looked complete,
          // with nothing telling the agent otherwise. `total`/`truncated`
          // give the same honesty `etn.thoughts.query` already has; use
          // `etn.thoughts.query { in_subtree_of, max_depth: 1 }` to page
          // through the rest when `truncated` is true.
          const total = countNeighbors(ndb, args.thought_id, args.dir, neighborOpts);
          return omitEmptyContainers({
            thought: { id: thought.id, title: thought.title },
            dir: args.dir,
            depth: 1,
            neighbors: projectThoughtRows(annotated),
            total,
            truncated: total > annotated.length,
            link_types: linkTypes,
            thought_types: thoughtTypeCatalog(ndb, annotated.map((n) => n.type_id)),
          });
        }
        // `traverse` already supports `direction: "both"` (graph-traversal.ts)
        // — same BFS in both directions, used here for both `dir: "both"`
        // (explicit) and `dir: "siblings"` (legacy remap). For `parents`/
        // `children` we pass the dir as-is.
        const direction = args.dir === 'siblings' ? 'both' : args.dir;
        const walk = traverse(ndb, [args.thought_id], direction, {
          maxDepth: depth,
          maxNodes: rt.limits.maxNodesPerSubgraph,
          linkFilter: args.link_filter,
          showInactive: args.show_inactive,
        });
        // Bug fix (§5.1e): sanitize before the O12 branch so both `view`s drop
        // any inline `data:` icon URL, not just the compact projection.
        const thoughts = resolveThoughts(ndb, walk.ids).map((t) => withSanitizedIcon(t));
        // Depth>1 returns ThoughtRef rows (the lightweight identity slice);
        // project each entry through the single list serializer under
        // `view: 'compact'`.
        const projected =
          view === 'full' ? thoughts : projectThoughtRows(thoughts);
        return {
          thought_id: args.thought_id,
          dir: args.dir,
          depth,
          ids: walk.ids,
          thoughts: projected,
          truncated: walk.truncated,
          reason: walk.reason ?? null,
          thought_types: thoughtTypeCatalog(ndb, thoughts.map((t) => t.type_id)),
        };
      }),
  );
  mcp.registerTool(
    'etn.thoughts.subgraph',
    {
      title: 'Подграф в радиусе N рёбер',
      description:
        'The key RAG tool: the radius-bounded subgraph around seeds — nodes, active edges, `thought_types`/' +
        '`link_types` reference tables, and with `include_comments` per-node comment previews (permanent ' +
        'truncated to 600 chars, last 10 chronological; fetch full texts via `etn.comments.get` when ' +
        '`truncated`). `max_nodes` is capped by the server setting max_nodes_per_subgraph; `max_chars` ' +
        'caps the JSON size — the server first shrinks comment previews, then drops the farthest nodes ' +
        '(BFS level), reporting `truncated: true` + `reason`. Edges несут `has_properties`/`has_comment`; ' +
        '`link_marked_for_deletion` — ребро помечено на удаление (корзина). ' +
        '`meta.views` для seed-узлов — эффективный набор отборов, ' +
        'исполняется через `etn.views.run { view_name }`. `link_filter` — { type_ids?, include_structural? } ' +
        'ограничивает рёбра подграфа. ' +
        '`view: "compact"` (default) drops visual fields.',
      inputSchema: ThoughtsSubgraph.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.subgraph'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const effectiveMax = Math.min(
          args.max_nodes ?? rt.limits.maxNodesPerSubgraph,
          rt.limits.maxNodesPerSubgraph,
        );
        const result = subgraph(ndb, args.seed_ids, args.radius, {
          maxNodes: effectiveMax,
          linkFilter: args.link_filter,
        });
        // Bug fix (§5.1e): sanitize before the O12 branch so `view: 'full'`
        // subgraphs cannot leak inline `data:` icon URLs either.
        const nodes = result.nodes.map((id) => withSanitizedIcon(getThoughtOrThrow(ndb, id)));
        // `meta.views` (задача c1fa71d4) — эффективный набор отборов только
        // для seed-узлов: для остальных узлов агент может прочитать карточку
        // через `etn.thoughts.get` отдельно.
        const seedViews = new Map<string, ReturnType<typeof getEffectiveViewsForThought>>();
        for (const seedId of args.seed_ids) {
          const seed = nodes.find((n) => n.id === seedId);
          if (seed === undefined) continue;
          seedViews.set(
            seedId,
            getEffectiveViewsForThought(ndb, { type_id: seed.type_id }),
          );
        }
        const comments =
          args.include_comments === true
            ? result.nodes.map((id) => ({
                thought_id: id,
                ...omitEmptyContainers(
                  getCommentsPreview(ndb, 'thought', id, {
                    // Требование «Бюджет ответа subgraph: max_chars», блок
                    // «Актуализация 0.8.3»: постоянный комментарий узла —
                    // 600 символов; хронология остаётся 2000.
                    permanent: SUBGRAPH_PERMANENT_PREVIEW_CHARS,
                  }),
                ),
              }))
            : undefined;
        // O10: one batched UPSERT covers every node returned by the subgraph.
        recordReads(ndb, result.nodes, { now: new Date().toISOString() });
        const view: McpViewMode = args.view ?? 'compact';
        // The traversal already returns edges with the minimal shape (no
        // colour/style/width — see graph-traversal/subgraph), so the only O12
        // effects here are the node projection and the link-type catalogue.
        // 0.8.3: справочник типов связей худой (`view` его не меняет).
        const linkTypes = linkTypeCatalog(ndb, result.edges.map((e) => e.type_id));
        // 0.7.2 (requirement 8ab42ea8) — annotate every edge with two presence
        // flags (`has_properties`, `has_comment`) so the agent sees, in one
        // read, which links hold knowledge worth following up. Two aggregating
        // queries on the whole edge set, not one per edge.
        const fillingFlags = getLinkFillingFlags(
          ndb,
          result.edges.map((e) => e.id),
        );
        const edges = result.edges.map((edge) => {
          const flags = fillingFlags.get(edge.id);
          const annotated = {
            ...edge,
            has_properties: flags?.has_properties ?? false,
            has_comment: flags?.has_comment ?? false,
          };
          return view === 'full' ? annotated : projectLinkRow(annotated);
        });
        // When the hard `max_nodes` bound fires during traversal, the response is
        // already structurally incomplete — running the budget shrinker on top
        // would only hide that fact behind a softer reason. Surface the
        // `max_nodes` reason verbatim in that case and skip budget trimming.
        const thoughtTypes = thoughtTypeCatalog(ndb, nodes.map((n) => n.type_id));
        // `meta.views` (задача c1fa71d4) — отборы для seed-узлов. Для
        // остальных узлов поле пустое (агент может прочитать их карточку
        // отдельно через `etn.thoughts.get`).
        const nodesWithViews = nodes.map((n) => {
          const effectiveViews = seedViews.get(n.id);
          if (effectiveViews === undefined) {
            return { ...n, views: [] };
          }
          return {
            ...n,
            views: effectiveViews.map((v) => ({
              id: v.id,
              name: v.name,
              name_key: v.name_key,
              description: v.description,
              defined_on: v.defined_on,
              inherited: v.inherited,
              is_default: v.is_default,
            })),
          };
        });
        // Единый сериализатор списочных записей (projection.ts): у узлов
        // compact-проекции снимаются визуальные/сервисные поля и пустые
        // `views`. `view: 'full'` сохраняет прежнюю форму.
        const projectedNodesWithViews =
          view === 'full' ? nodesWithViews : projectThoughtRows(nodesWithViews);
        const payload: {
          nodes: typeof projectedNodesWithViews;
          edges: typeof edges;
          thought_types: typeof thoughtTypes;
          link_types: typeof linkTypes;
          comments?: typeof comments;
        } = {
          nodes: projectedNodesWithViews,
          edges,
          thought_types: thoughtTypes,
          link_types: linkTypes,
          ...(comments === undefined ? {} : { comments }),
        };
        const traversalTruncated = result.truncated;
        const budget =
          args.max_chars !== undefined && !traversalTruncated
            ? shrinkSubgraphToBudget(payload, {
                seed_ids: args.seed_ids,
                max_chars: args.max_chars,
              })
            : null;
        return omitEmptyContainers({
          nodes: payload.nodes,
          edges: payload.edges,
          truncated: traversalTruncated || (budget?.truncated ?? false),
          max_nodes: effectiveMax,
          // Reason: explicit `max_nodes` (from `traverse`) takes priority over
          // budget diagnostics — a traversal-level cap is the more informative
          // answer for the agent, because it means *not every reachable node
          // was even considered*. `null` when nothing was trimmed.
          reason: traversalTruncated
            ? 'max_nodes'
            : (budget?.reason ?? null),
          thought_types: payload.thought_types,
          link_types: payload.link_types,
          ...(payload.comments === undefined ? {} : { comments: payload.comments }),
          // Echo of the budget diagnostic so the agent can distinguish "we
          // shrank to 40k chars from 90k" from "we dropped 50 nodes". Absent
          // when the caller did not set `max_chars` or when traversal already
          // truncated.
          ...(budget === null
            ? {}
            : {
                budget: {
                  max_chars: args.max_chars as number,
                  original_chars: budget.original_chars,
                  final_chars: budget.final_chars,
                  steps: budget.reason,
                },
              }),
        });
      }),
  );
  // `etn.thoughts.path` / `etn.thoughts.mentions` / `etn.thoughts.backlinks` /
  // `etn.thoughts.deletion_check` (0.8.3, задача 86ef2ff4) сняты из постоянного
  // набора — упакованы в `etn.ops` (tools/ops.ts).
  mcp.registerTool(
    'etn.thoughts.usage',
    {
      title: 'Где используется мысль',
      description:
        'Thoughts referencing this thought through link-property edges (formal links), grouped by the ' +
        'registry property: { total, groups: [{property_id, key, thoughts[]}], thought_types } — one group ' +
        'per network property. `view: "compact"` (default) drops visual fields from each referencing thought.',
      inputSchema: ThoughtsUsage.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.usage'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const rawUsage = findThoughtUsage(ndb, args.thought_id);
        const view: McpViewMode = args.view ?? 'compact';
        // Bug fix (§5.1e): sanitize before the O12 branch so `view: 'full'`
        // cannot leak an inline `data:` icon URL either.
        const usage = {
          total: rawUsage.total,
          groups: rawUsage.groups.map((g) => ({
            property_id: g.property_id,
            key: g.key,
            thoughts: g.thoughts.map((t) => withSanitizedIcon(t)),
          })),
        };
        // `groups[].thoughts[]` is a ThoughtRef[] — project each entry through
        // the single list serializer under the compact view. The `total` and
        // `groups` skeleton are preserved.
        const groups =
          view === 'full'
            ? usage.groups
            : usage.groups.map((g) => ({
                property_id: g.property_id,
                key: g.key,
                thoughts: projectThoughtRows(g.thoughts),
              }));
        return {
          total: usage.total,
          groups,
          holding_layers: rawUsage.holding_layers,
          thought_types: thoughtTypeCatalog(
            ndb,
            usage.groups.flatMap((g) => g.thoughts.map((t) => t.type_id)),
          ),
        };
      }),
  );
  // `etn.thoughts.deletion_check` (0.8.3, задача 86ef2ff4) снят — в `etn.ops`.

}

export function registerFindDuplicatesTool(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.thoughts.find_duplicates',
    {
      title: 'Поиск дубликатов',
      description:
        'Find existing thoughts matching a proposed title/synonyms (exact title, exact synonym, partial). ' +
        'A partial match requires the typed fragments to occur inside CONSECUTIVE words of the title or of ' +
        'one synonym, in the typed order («исправ ошиб» finds «Исправленные ошибки», but not «исправить ' +
        'старую ошибку»); `-word` excludes. Always call before creating a thought (`etn.thoughts.write`).',
      inputSchema: ThoughtsFindDuplicates.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.find_duplicates'],
    },
    (args) =>
      runTool(async () => {
        // Задача eb1a3f43, требование c98d5d19: веерный режим.
        if (args.network_ids !== undefined) {
          const access = buildCrossNetworkAccess(rt, args.network_ids);
          if (access.networks.length === 0) {
            return { hits: [], networks: [] };
          }
          const result = fanOutFindDuplicates(access, {
            networkIds: access.accessibleIds,
            title: args.title,
            synonyms: args.synonyms,
          });
          return {
            hits: projectThoughtRows(result.hits.map((hit) => withSanitizedIcon(hit))),
            networks: result.networks,
            truncated: result.truncated,
            reason: result.reason,
          };
        }
        const ndb = openMemberNetwork(rt, args.network_id as string);
        // Bug fix (§5.1e): `findDuplicates` is shared with the REST add-thought
        // dialog (which needs the real icon to render candidates), so project
        // only at this MCP-facing call site: every list record goes through the
        // single serializer (`icon` sanitized and kept, visual/service dropped,
        // empty containers omitted).
        return projectThoughtRows(
          findDuplicates(ndb, args.title, args.synonyms ?? []).map((hit) =>
            withSanitizedIcon(hit),
          ),
        );
      }),
  );

  // =========================================================================
  // Activity log (§4.1) — паритет с REST GET /activity
  // (задача f2eca5a4, операция 70dfe81d).
  // =========================================================================

}
