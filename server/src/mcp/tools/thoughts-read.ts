/**
 * thoughts-read.ts — MCP-инструменты области «registerThoughtsReadTools, registerFindDuplicatesTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { EtnError, MCP_TOOL_ANNOTATIONS, TRAVERSAL_DEFAULTS } from '@etn/shared';
import type { McpViewMode } from '@etn/shared';
import { checkThoughtDeletion, countNeighbors, getNeighbors, getThoughtOrThrow, getThoughtsByIdsResolved } from '../../domain/thought-service.js';
import { ThoughtsBacklinks, ThoughtsDeletionCheck, ThoughtsFindDuplicates, ThoughtsGet, ThoughtsMentions, ThoughtsNeighbors, ThoughtsPath, ThoughtsQuery, ThoughtsResolve, ThoughtsSearch, ThoughtsSubgraph, ThoughtsUsage } from '../../contracts.js';
import { getLinkFillingFlags } from '../../domain/link-service.js';
import { getCommentsPreview } from '../../domain/comment-service.js';
import { findThoughtUsage, getNetworkProperty, getPropertyValuesResolved, resolveConditionPropertyRef } from '../../domain/property-service.js';
import { findBacklinks } from '../../domain/backlinks-service.js';
import { findDuplicates, findMentions, resolveThoughts, search } from '../../domain/search-service.js';
import { shrinkSubgraphToBudget } from '../subgraph-budget.js';
import { mcpRequestToQuery, queryThoughts } from '../../domain/query-service.js';
import { getThoughtMeta } from '../../domain/thought-meta.js';
import { recordReads } from '../../domain/read-metrics-service.js';
import { linkTypeCatalog, linkTypeCatalogCompact, thoughtTypeCatalog, toCompactThought, toCompactThoughtRef, withSanitizedIcon } from '../catalogs.js';
import { findPath, subgraph, traverse } from '../../domain/graph-traversal.js';
import { getThoughtType, resolveThoughtTypeIdByName } from '../../domain/thought-type-service.js';
import { getEffectiveViewsForThought } from '../../domain/thought-type-views-service.js';
import { openMemberNetwork, runTool } from '../context.js';

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
        const ndb = openMemberNetwork(rt, args.network_id);
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
        // (which needs the real icon to render results), so sanitize only at
        // this MCP-facing call site. `by_names`/`by_texts` carry the thought's
        // `icon`; `by_links`/`by_chrono` do not.
        return {
          ...result,
          by_names: result.by_names.map((h) => withSanitizedIcon(h)),
          by_texts: result.by_texts.map((h) => withSanitizedIcon(h)),
          ...(resolvedType !== undefined ? { resolved_type: resolvedType } : {}),
        };
      }),
  );
  mcp.registerTool(
    'etn.thoughts.query',
    {
      title: 'Структурная выборка мыслей',
      description:
        'List thoughts by criteria — no text query required; filters combine with AND. `in_subtree_of` ' +
        '(+`max_depth`) — directed descendants (hits carry `depth`); `type_id[]` (or its name-form `type[]`, ' +
        'resolved case-insensitively via `etn.types.list`; `NOT_FOUND` if no such type, `VALIDATION_ERROR` ' +
        'with `details.candidates` on ambiguity); `active` and `trashed` (`true`/`false`/`any`; `trashed` ' +
        'defaults to `false`); `keywords` — mini-syntax over title and synonyms (words all required, ' +
        '`*` infix wildcard, `-word` exclusion); `properties` — registry `property_id` (or its name-form ' +
        '`property`, same resolve semantics) + operator eq/ne/contains/gt/gte/lt/lte/any_of/all_of/none_of + ' +
        'value (unknown `property_id` matches nothing; the `value_type` picks the column: number → ' +
        'value_number, bool → value_bool, others on their text columns). `value_type: \'link\'` (свойство-связь, ' +
        '0.8.1) переводится в запрос по рёбрам, а не по значениям: `eq`/`ne` со строкой — связь с конкретной ' +
        'целью (id мысли), с boolean — связь такого типа есть/отсутствует независимо от цели; работает в обе ' +
        'стороны (по направлению свойства). `any_of`/`all_of`/`none_of` — операторы для наборов (свойство-связь ' +
        'и `config.multiple` url): `value` — непустой массив id/строк; пересечение непусто / набор ' +
        'содержит все перечисленные / пересечения нет. `created_*`/`updated_*` — ISO-8601 ranges; ' +
        '`author_id`/`editor_id` — id пользователя, создавшего/последним изменившего мысль; ' +
        '`link_filter` — { type_ids?, include_structural? } ограничивает рёбра спуска `in_subtree_of`. Response carries ' +
        'a `thought_types` reference table plus the optional `resolved_types` / `resolved_properties` echoes ' +
        'for inputs that came in by name.',
      inputSchema: ThoughtsQuery.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.query'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
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
        'Fetch one thought with synonyms, type (AI-facing description included) and property values ' +
        '(values whose property is not on the owner\'s type chain ' +
        'are flagged `outside_type: true` — do not treat such a card as empty). `meta.permanent` — the ' +
        'full text of the permanent comment (задача 3ea09a54: в `etn.thoughts.get` обрезка отключена; в ' +
        'остальных выборках — preview 2000 chars, `etn.comments.get` для полного). `meta.link_stats` ' +
        '(0.7.2) — счётчики активных связей по `(link_type_id, direction)` + `link_types`. ' +
        '`meta.views` (0.7.3, задача c1fa71d4) — эффективный набор отборов для мысли: ' +
        'имя, описание и тип-владелец каждого доступного отбора (без `definition`); ' +
        'исполняется через `etn.views.run { view_name }`. ' +
        '`view: "compact"` (default) drops visual fields.',
      inputSchema: ThoughtsGet.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.get'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const rawThought = getThoughtOrThrow(ndb, args.thought_id);
        const rawType = rawThought.type_id === null ? null : getThoughtType(ndb, rawThought.type_id);
        const properties = getPropertyValuesResolved(ndb, 'thought', args.thought_id);
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
        const type = rawType === null ? null : withSanitizedIcon(rawType);
        // Keep the response envelope identical between views — only the
        // thought-level fields differ. `type`, `properties` and `meta` were
        // never affected by the O12 projection change.
        const projected = view === 'full' ? thought : toCompactThought(thought);
        return { ...projected, type, properties, meta };
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
        'схлопываются) + `missing[]`. Карточка несёт мысль, тип, свойства, `meta.link_stats`, ' +
        'полнотекстовый `comment_preview` и `meta.views` (0.7.3, задача c1fa71d4) — ' +
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
        // so sanitising the source once is enough. `card.type` carries the
        // type's icon through `withSanitizedIconLite` which leaves it raw;
        // apply the same fix here.
        const sanitizedItems = result.items.map((card) => ({
          ...withSanitizedIcon(card),
          type: card.type === null ? null : withSanitizedIcon(card.type),
        }));
        // `meta.views` (задача c1fa71d4) — собирается внутри `getThoughtMeta`,
        // которую зовёт `getThoughtsByIdsResolved` (домен, требование eaca1253).
        // Дополнительной обвязки здесь не требуется — `card.meta.views` уже
        // заполнен.
        const itemsWithViews = sanitizedItems;
        const items =
          view === 'full'
            ? itemsWithViews
            : itemsWithViews.map((card) => ({
                // Проекция касается только полей самой мысли (id/title/...);
                // `type`, `properties`, `meta` и `comment_preview` остаются в
                // полной форме — тот же контракт, что и у `etn.thoughts.get`.
                ...card,
                id: card.id,
                title: card.title,
                type_id: card.type_id,
                icon: card.icon,
                icon_kind: card.icon_kind,
                icon_attachment_id: card.icon_attachment_id,
                active: card.active,
                marked_for_deletion: card.marked_for_deletion,
                fg_color: null,
                bg_color: null,
                font_bold: null,
                font_italic: null,
                font_underline: null,
                font_strike: null,
                synonyms: card.synonyms,
                version: card.version,
                created_at: card.created_at,
                updated_at: card.updated_at,
              }));
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
        'Direct neighbours of a thought by direction (`parents`/`children`/`siblings`) or `both` (0.7.2); ' +
        '`depth > 1` does a bounded BFS walk. `dir: "both"` (0.7.2) — оба направления одним вызовом, ' +
        'записи несут `direction: "in"|"out"`. Рёбра (0.7.2) несут `has_properties`/`has_comment` — ' +
        'два агрегирующих запроса на весь набор рёбер, не на ребро. На `depth: 1` страница 50 — ' +
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
          const neighborOpts = { userId: rt.deps.auth.userId, linkFilter: args.link_filter };
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
            const linkTypes =
              view === 'full'
                ? linkTypeCatalog(ndb, annotated.map((n) => n.link_type_id))
                : linkTypeCatalogCompact(ndb, annotated.map((n) => n.link_type_id));
            // Bug fix (0.6.3): honest counts come from the domain `countNeighbors`
            // (one SQL per direction — same shape, no LIMIT). Sum them and
            // compare to the trimmed page; `truncated` is per the page size.
            const parentsTotal = countNeighbors(ndb, args.thought_id, 'parents', neighborOpts);
            const childrenTotal = countNeighbors(ndb, args.thought_id, 'children', neighborOpts);
            const total = parentsTotal + childrenTotal;
            return {
              thought: { id: thought.id, title: thought.title },
              dir: args.dir,
              depth: 1,
              neighbors: annotated,
              total,
              truncated: total > annotated.length,
              link_types: linkTypes,
              thought_types: thoughtTypeCatalog(ndb, annotated.map((n) => n.type_id)),
            };
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
          const linkTypes =
            view === 'full'
              ? linkTypeCatalog(ndb, annotated.map((n) => n.link_type_id))
              : linkTypeCatalogCompact(ndb, annotated.map((n) => n.link_type_id));
          // Bug fix (0.6.3, thought f2c7c7d3): this tool has no limit/offset
          // of its own and silently applied the domain default page size
          // (50) — a thought with more neighbours than that looked complete,
          // with nothing telling the agent otherwise. `total`/`truncated`
          // give the same honesty `etn.thoughts.query` already has; use
          // `etn.thoughts.query { in_subtree_of, max_depth: 1 }` to page
          // through the rest when `truncated` is true.
          const total = countNeighbors(ndb, args.thought_id, args.dir, neighborOpts);
          return {
            thought: { id: thought.id, title: thought.title },
            dir: args.dir,
            depth: 1,
            neighbors: annotated,
            total,
            truncated: total > annotated.length,
            link_types: linkTypes,
            thought_types: thoughtTypeCatalog(ndb, annotated.map((n) => n.type_id)),
          };
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
        });
        // Bug fix (§5.1e): sanitize before the O12 branch so both `view`s drop
        // any inline `data:` icon URL, not just the compact projection.
        const thoughts = resolveThoughts(ndb, walk.ids).map((t) => withSanitizedIcon(t));
        // Depth>1 returns ThoughtRef rows (the lightweight identity slice);
        // project each entry to its compact shape under `view: 'compact'`.
        const projected =
          view === 'full' ? thoughts : thoughts.map((t) => toCompactThoughtRef(t));
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
        'truncated to 2000 chars, last 10 chronological; fetch full texts via `etn.comments.get` when ' +
        '`truncated`). `max_nodes` is capped by the server setting max_nodes_per_subgraph; `max_chars` ' +
        'caps the JSON size — the server first shrinks comment previews, then drops the farthest nodes ' +
        '(BFS level), reporting `truncated: true` + `reason`. Edges (0.7.2) несут `has_properties`/`has_comment`. ' +
        '`meta.views` (0.7.3) для seed-узлов — эффективный набор отборов, ' +
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
                ...getCommentsPreview(ndb, 'thought', id),
              }))
            : undefined;
        // O10: one batched UPSERT covers every node returned by the subgraph.
        recordReads(ndb, result.nodes, { now: new Date().toISOString() });
        const view: McpViewMode = args.view ?? 'compact';
        // The traversal already returns edges with the minimal shape (no
        // colour/style/width — see graph-traversal/subgraph), so the only O12
        // effects here are the node projection and the link-type catalogue.
        const projectedNodes =
          view === 'full' ? nodes : nodes.map((t) => toCompactThought(t));
        const linkTypes =
          view === 'full'
            ? linkTypeCatalog(ndb, result.edges.map((e) => e.type_id))
            : linkTypeCatalogCompact(ndb, result.edges.map((e) => e.type_id));
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
          return {
            ...edge,
            has_properties: flags?.has_properties ?? false,
            has_comment: flags?.has_comment ?? false,
          };
        });
        // When the hard `max_nodes` bound fires during traversal, the response is
        // already structurally incomplete — running the budget shrinker on top
        // would only hide that fact behind a softer reason. Surface the
        // `max_nodes` reason verbatim in that case and skip budget trimming.
        const thoughtTypes = thoughtTypeCatalog(ndb, nodes.map((n) => n.type_id));
        // `meta.views` (задача c1fa71d4) — отборы для seed-узлов. Для
        // остальных узлов поле пустое (агент может прочитать их карточку
        // отдельно через `etn.thoughts.get`).
        const projectedNodesWithViews = projectedNodes.map((n) => {
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
        return {
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
        };
      }),
  );
  mcp.registerTool(
    'etn.thoughts.path',
    {
      title: 'Путь между мыслями',
      description:
        'Shortest path between two thoughts through undirected parent/child edges, bounded by ' +
        '`max_depth`. `link_filter` — { type_ids?, include_structural? } ограничивает рёбра, по ' +
        'которым ищется путь. Returns the id sequence or `path: null` when unreachable.',
      inputSchema: ThoughtsPath.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.path'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const path = findPath(
          ndb,
          args.from_id,
          args.to_id,
          args.max_depth ?? TRAVERSAL_DEFAULTS.MAX_DEPTH,
          args.link_filter,
        );
        // Bug fix (§5.1e): sanitize before returning — `resolveThoughts` gives
        // raw `data:` icon URLs, but the agent can never resolve an image; the
        // place must mirror `subgraph`/`get`/`neighbors`.
        const thoughts =
          path === null ? undefined : resolveThoughts(ndb, path).map((t) => withSanitizedIcon(t));
        return {
          from_id: args.from_id,
          to_id: args.to_id,
          path,
          ...(thoughts === undefined
            ? {}
            : {
                thoughts,
                thought_types: thoughtTypeCatalog(ndb, thoughts.map((t) => t.type_id)),
              }),
        };
      }),
  );
  mcp.registerTool(
    'etn.thoughts.mentions',
    {
      title: 'Где упоминается мысль',
      description:
        'Comments (on thoughts and links) whose text mentions the thought by title or synonym.',
      inputSchema: ThoughtsMentions.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.mentions'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return findMentions(ndb, args.thought_id);
      }),
  );
  mcp.registerTool(
    'etn.thoughts.backlinks',
    {
      title: 'Ссылки на мысль',
      description:
        'Comments whose `body_md` carries an explicit ID-based wiki reference `[[#<id>]]` or ' +
        '`[[n:<net>#<id>]]` to this thought. Distinct from `etn.thoughts.mentions` — that one finds implicit ' +
        'text matches by title/synonym via FTS5, this one explicit UUID references. Returns the same ' +
        '`MentionHit[]` shape; the thought\'s own comments are excluded.',
      inputSchema: ThoughtsBacklinks.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.backlinks'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return findBacklinks(ndb, args.thought_id);
      }),
  );
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
        // `groups[].thoughts[]` is a ThoughtRef[] — project each entry under
        // the compact view. The `total` and `groups` skeleton are preserved.
        const groups =
          view === 'full'
            ? usage.groups
            : usage.groups.map((g) => ({
                property_id: g.property_id,
                key: g.key,
                thoughts: g.thoughts.map((t) => toCompactThoughtRef(t)),
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
  mcp.registerTool(
    'etn.thoughts.deletion_check',
    {
      title: 'Проверка блокировки удаления мысли',
      description:
        'Check what blocks a thought from being physically deleted: use in blocking link properties, holding ' +
        'layers, and future orphans among its children. Accepts an array; returns a map id → ' +
        '{ blocked, blocking, orphaned_children }. See prompt etn.how_to_purge for the two-phase deletion flow.',
      inputSchema: ThoughtsDeletionCheck.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.deletion_check'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const result: Record<string, unknown> = {};
        for (const id of [...new Set(args.thought_ids)]) {
          result[id] = checkThoughtDeletion(ndb, id);
        }
        return result;
      }),
  );

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
        const ndb = openMemberNetwork(rt, args.network_id);
        // Bug fix (§5.1e): `findDuplicates` is shared with the REST add-thought
        // dialog (which needs the real icon to render candidates), so sanitize
        // only at this MCP-facing call site.
        return findDuplicates(ndb, args.title, args.synonyms ?? []).map((hit) =>
          withSanitizedIcon(hit),
        );
      }),
  );

  // =========================================================================
  // Activity log (§4.1) — паритет с REST GET /activity
  // (задача f2eca5a4, операция 70dfe81d).
  // =========================================================================

}
