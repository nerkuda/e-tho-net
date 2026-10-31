/**
 * types.ts — MCP-инструменты области «каталог типов».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 *
 * 0.15.1 (задача 17ff4619): к `etn.types.list` добавлен точечный
 * `etn.types.get` (один тип по `id`/`name`), фильтр `keywords` и режим
 * `compact`, а пагинация стала явной (`meta.has_more`/`meta.next_offset`).
 * Записи обоих инструментов собираются ОДНИМИ И ТЕМИ ЖЕ функциями
 * (`buildThoughtTypeEntry`/`buildLinkTypeEntry`) — форма ответа `get` и
 * `list` не может разъехаться.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';

import {
  EtnError,
  MCP_TOOL_ANNOTATIONS,
  TRAVERSAL_DEFAULTS,
  keywordMatchesText,
  parseFilterKeywords,
} from '@etn/shared';
import type {
  LinkType,
  McpLinkTypeCompactEntry,
  McpLinkTypeEntry,
  McpThoughtTypeCompactEntry,
  McpThoughtTypeEntry,
  McpTypesGetResult,
  McpTypesListMeta,
  McpTypesListResult,
  McpTypesListTruncationReason,
  PropertyConfig,
  ThoughtType,
} from '@etn/shared';
import type { NetworkDb } from '../../db/network-db.js';
import { getThoughtOrThrow } from '../../domain/thought-service.js';
import { TypesGet, TypesList } from '../../contracts.js';
import { isStructuralLinkProperty, listEffectiveTypeProperties } from '../../domain/property-service.js';
import { collectSubtreeTypes } from '../../domain/search-service.js';
import { shrinkTypesListToBudget, type TypesListBudgetPayload } from '../types-list-budget.js';
import { sanitizeIcon } from '../catalogs.js';
import {
  STRUCTURAL_PROPERTIES_NOTE,
  projectTypeRow,
  stripPropertyBindingServiceFields,
} from '../../domain/response-projection.js';
import {
  getThoughtType,
  listThoughtTypes,
  resolveThoughtTypeIdByName,
} from '../../domain/thought-type-service.js';
import {
  getLinkType,
  listLinkTypes,
  resolveLinkTypeIdByName,
} from '../../domain/link-type-service.js';
import { listThoughtTypeViewsByType } from '../../domain/thought-type-views-service.js';
import { createBodyExpander } from '../../domain/transclusion-service.js';
import { openMemberNetwork, runTool } from '../context.js';

/** Разворот трансклюзий в текстах типа (`description`, `comment_template_md`). */
type ExpandText = (text: string | null) => string | null;

/**
 * Снять с записи каталога сервисные поля привязки свойств
 * (`owner_type`/`owner_id`/`defined_on`/…) и структурные «Родители»/«Потомки»
 * — они наследуются всеми типами, их место — одна строка-константа на ответ
 * (0.8.3, требование «Каталоги типов в ответах read-инструментов»).
 */
function projectTypeProperties<T extends { properties: unknown[] }>(entry: T): T {
  return {
    ...entry,
    properties: entry.properties
      .filter(
        (p) => !isStructuralLinkProperty((p as { config?: PropertyConfig | null }).config ?? null),
      )
      .map(stripPropertyBindingServiceFields),
  };
}

/**
 * Полная запись типа мысли — та же форма, что у `etn.types.list` и
 * `etn.types.get`: иерархия L21, AI-описание и шаблон комментария с
 * развёрнутыми трансклюзиями (требование 39e30070), санитайз иконки,
 * эффективные свойства, собственные отборы типа.
 */
function buildThoughtTypeEntry(
  ndb: NetworkDb,
  expandText: ExpandText,
  t: ThoughtType,
  usageCount?: number,
): McpThoughtTypeEntry {
  return projectTypeRow(
    projectTypeProperties({
      id: t.id,
      name: t.name,
      parent_id: t.parent_id,
      is_root: t.is_root,
      description: expandText(t.description),
      comment_template_md: expandText(t.comment_template_md),
      // Bug fix (§5.1e): `etn.types.list`/`get` have no `view` param — always
      // sanitize the inline `data:` icon URL.
      icon: sanitizeIcon(t.icon),
      properties: listEffectiveTypeProperties(ndb, 'thought_type', t.id),
      // Собственные отборы типа (задача c1fa71d4, 0.7.3): без наследования от
      // предков — это контракт каталога; эффективный набор для конкретной мысли
      // идёт через `etn.thoughts.get { meta.views }`. Читаем через
      // `thought_type_views_v` (представление сворачивает слои по правилу
      // «ближайший побеждает»); `currentLayerOnly: true` здесь не уместен —
      // при работе из дочернего слоя он дал бы пустой `views: []` для типов,
      // чьи отборы лежат в базовом слое (ошибка 24632488, 0.7.4).
      views: listThoughtTypeViewsByType(ndb, t.id).map((v) => ({
        id: v.id,
        name: v.name,
        name_key: v.name_key,
        description: v.description,
        position: v.position,
        is_default: v.is_default,
      })),
      ...(usageCount === undefined ? {} : { usage_count: usageCount }),
    }),
  ) as McpThoughtTypeEntry;
}

/** Полная запись типа связи — `etn.types.list`/`etn.types.get`. */
function buildLinkTypeEntry(
  ndb: NetworkDb,
  expandText: ExpandText,
  t: LinkType,
  usageCount?: number,
): McpLinkTypeEntry {
  return projectTypeRow(
    projectTypeProperties({
      id: t.id,
      name_forward: t.name_forward,
      name_reverse: t.name_reverse,
      parent_id: t.parent_id,
      is_root: t.is_root,
      description: expandText(t.description),
      color: t.color,
      style: t.style,
      properties: listEffectiveTypeProperties(ndb, 'link_type', t.id),
      ...(usageCount === undefined ? {} : { usage_count: usageCount }),
    }),
  ) as McpLinkTypeEntry;
}

/** Компактная запись типа мысли (`compact: true`): только идентификация. */
function buildThoughtTypeCompactEntry(
  t: ThoughtType,
  usageCount?: number,
): McpThoughtTypeCompactEntry {
  return {
    id: t.id,
    name: t.name,
    parent_id: t.parent_id,
    is_root: t.is_root,
    ...(usageCount === undefined ? {} : { usage_count: usageCount }),
  };
}

/** Компактная запись типа связи (`compact: true`): только идентификация. */
function buildLinkTypeCompactEntry(t: LinkType, usageCount?: number): McpLinkTypeCompactEntry {
  return {
    id: t.id,
    name_forward: t.name_forward,
    name_reverse: t.name_reverse,
    parent_id: t.parent_id,
    is_root: t.is_root,
    ...(usageCount === undefined ? {} : { usage_count: usageCount }),
  };
}

/**
 * Фильтр `keywords` мини-синтаксиса §6.10 (задача 17ff4619): слова через
 * пробел — AND, `*` — подстановка, `-слово` — исключение, регистронезависимо.
 * Матчер — общий `keywordMatchesText` (`@etn/shared`); запрос из одних
 * исключений допустим. У типа связи имя проверяется по ОБОИМ сторонам
 * (`name_forward`/`name_reverse`) — как резолв `type` в `etn.thoughts.write`.
 */
function matchesTypeKeywords(keywords: string, names: readonly string[]): boolean {
  const { include, exclude } = parseFilterKeywords(keywords);
  const hit = (word: string): boolean => names.some((name) => keywordMatchesText(word, name));
  return include.every(hit) && exclude.every((word) => !hit(word));
}

/** Границы окна страницы: `offset` без `limit` — хвост каталога от позиции. */
function paginateTypes<T>(rows: T[], offset: number, limit: number | undefined): T[] {
  return rows.slice(offset, limit === undefined ? rows.length : offset + limit);
}

export function registerTypesListTool(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.types.list',
    {
      title: 'Каталог типов',
      description:
        'Каталоги типов мыслей и связей: иерархия (`parent_id`/`is_root`), AI-описание, ' +
        'эффективные свойства (свои + унаследованные: `key`, `value_type`, `required`, `config`, ' +
        '`default_value`, `property_id`), `views[]`; тексты — с развёрнутыми трансклюзиями. Для ' +
        'ОДНОГО типа используй `etn.types.get` — не выкачивай каталог целиком. `keywords` — по ' +
        'именам типов (мысли — `name`; связи — обе стороны) в мини-синтаксисе §6.10 (AND, `*`, ' +
        '`-слово`, регистр не важен) ДО `limit`/`offset`; totals — по фильтру. `compact` — только ' +
        '`id`, имена, `parent_id`, `is_root`, `usage_count` (при `in_subtree_of`). `scope` — ' +
        'каталог; `in_subtree_of`(+`max_depth`) — типы поддерева с `usage_count`; `limit`/`offset` ' +
        '(1..500 / ≥0) пагинируют каждый каталог отдельно; `max_chars` (≥1000) — мягкий потолок. ' +
        'Любой из `limit`/`offset`/`max_chars`/`keywords`/`compact` включает `meta`: `truncated`, ' +
        '`reason`, totals, `has_more`, `next_offset` (`null` — выдано всё; `has_more` без сдвига ' +
        '`next_offset` — страница не влезла в `max_chars`).',
      inputSchema: TypesList.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.types.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        // Требование 39e30070, блок «Scope описаний типов» (ТП2, задача bcfc7eb7):
        // тексты типов, отдаваемые MCP (`description`, `comment_template_md`),
        // разворачиваются так же, как body_md комментариев — маркеры ADR 85a7a01e.
        const expand = createBodyExpander(ndb);
        const expandText: ExpandText = (text) => (text === null ? null : expand(text));

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

        // 0.15.1 (задача 17ff4619): фильтры применяются ДО пагинации, поэтому
        // totals в `meta` и в `scope`-эхе отражают отфильтрованный набор.
        const keywords = args.keywords;
        const filteredThoughtTypes = listThoughtTypes(ndb)
          .filter((t) => thoughtTypeCounts === null || thoughtTypeCounts.has(t.id))
          .filter((t) => keywords === undefined || matchesTypeKeywords(keywords, [t.name]));
        const filteredLinkTypes = listLinkTypes(ndb)
          .filter((t) => linkTypeCounts === null || linkTypeCounts.has(t.id))
          .filter(
            (t) =>
              keywords === undefined ||
              matchesTypeKeywords(keywords, [t.name_forward, t.name_reverse]),
          );

        // Task f9c7dbc5 (0.7.4): `limit`/`offset` slice each catalogue after the
        // (subtree + keywords-filtered) sort. The two catalogues are paginated
        // independently. 0.15.1: `offset` без `limit` отдаёт хвост от позиции
        // (раньше `offset` молча игнорировался — спека его не отменяла).
        const offset = args.offset ?? 0;
        const limit = args.limit;
        const compact = args.compact === true;
        const scope = args.scope ?? 'all';
        const includesThoughts = scope !== 'links';
        const includesLinks = scope !== 'thoughts';

        // Записи собираются только для страницы: сборка полной записи типа
        // читает эффективные свойства и отборы, а каталог целиком агенту не нужен.
        const thoughtEntries = includesThoughts
          ? paginateTypes(filteredThoughtTypes, offset, limit).map((t) => {
              const usageCount =
                thoughtTypeCounts === null ? undefined : (thoughtTypeCounts.get(t.id) ?? 0);
              return compact
                ? buildThoughtTypeCompactEntry(t, usageCount)
                : buildThoughtTypeEntry(ndb, expandText, t, usageCount);
            })
          : undefined;
        const linkEntries = includesLinks
          ? paginateTypes(filteredLinkTypes, offset, limit).map((t) => {
              const usageCount =
                linkTypeCounts === null ? undefined : (linkTypeCounts.get(t.id) ?? 0);
              return compact
                ? buildLinkTypeCompactEntry(t, usageCount)
                : buildLinkTypeEntry(ndb, expandText, t, usageCount);
            })
          : undefined;

        const payload: McpTypesListResult = {
          ...(includesThoughts
            ? {
                thought_types: thoughtEntries,
                // Одна строка-константа вместо повтора структурных
                // «Родители»/«Потомки» в каждом типе (0.8.3).
                structural_properties_note: STRUCTURAL_PROPERTIES_NOTE,
              }
            : {}),
          ...(includesLinks ? { link_types: linkEntries } : {}),
          ...(args.in_subtree_of === undefined
            ? {}
            : {
                scope: {
                  in_subtree_of: args.in_subtree_of,
                  max_depth: args.max_depth ?? TRAVERSAL_DEFAULTS.MAX_DEPTH,
                  thought_types_total: filteredThoughtTypes.length,
                  link_types_total: filteredLinkTypes.length,
                },
              }),
        };

        // Budget shrink (task f9c7dbc5). Skip entirely when the caller did not
        // pass `max_chars` — preserves the legacy shape verbatim. The shrinker
        // treats entries as key bags (`description`/`comment_template_md` +
        // tail drop); typed catalogue entries are structurally sufficient for
        // it, the cast is only about the `Record<string, unknown>` index
        // signature it declares.
        let truncated = false;
        let reason: McpTypesListTruncationReason | null = null;
        let originalChars: number | undefined;
        let finalChars: number | undefined;
        if (args.max_chars !== undefined) {
          const result = shrinkTypesListToBudget(
            payload as unknown as TypesListBudgetPayload,
            { max_chars: args.max_chars },
          );
          truncated = result.truncated;
          reason = result.reason;
          originalChars = result.original_chars;
          finalChars = result.final_chars;
        }

        // Явная пагинация (задача 17ff4619, 0.15.1): `meta` присутствует при
        // любом из новых/пагинационных параметров; вызов без них даёт прежний
        // конверт без `meta` (обратная совместимость). `truncated`/`reason`
        // описывают обрезку по `max_chars`; `has_more`/`next_offset` — есть ли
        // недоставленный хвост (страница ИЛИ max_chars), поэтому обрезанный по
        // бюджету ответ не выглядит полным.
        const deliveredThoughts = payload.thought_types?.length ?? 0;
        const deliveredLinks = payload.link_types?.length ?? 0;
        const thoughtsRemaining =
          includesThoughts && offset + deliveredThoughts < filteredThoughtTypes.length;
        const linksRemaining =
          includesLinks && offset + deliveredLinks < filteredLinkTypes.length;
        const hasMore = thoughtsRemaining || linksRemaining;
        // Для двух каталогов — минимальная позиция среди недочитанных: повтор
        // записи лучше пропуска (каталоги пагинируются одним `offset`).
        const nextOffsets: number[] = [];
        if (thoughtsRemaining) nextOffsets.push(offset + deliveredThoughts);
        if (linksRemaining) nextOffsets.push(offset + deliveredLinks);
        const nextOffset = hasMore ? Math.min(...nextOffsets) : null;

        const wantsMeta =
          args.limit !== undefined ||
          args.offset !== undefined ||
          args.max_chars !== undefined ||
          args.keywords !== undefined ||
          args.compact !== undefined;
        if (wantsMeta) {
          payload.meta = {
            truncated,
            reason,
            ...(includesThoughts
              ? {
                  thought_types_total: filteredThoughtTypes.length,
                  thought_types_returned: deliveredThoughts,
                }
              : {}),
            ...(includesLinks
              ? {
                  link_types_total: filteredLinkTypes.length,
                  link_types_returned: deliveredLinks,
                }
              : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
            ...(args.keywords !== undefined ? { keywords: args.keywords } : {}),
            ...(args.compact !== undefined ? { compact: args.compact } : {}),
            has_more: hasMore,
            next_offset: nextOffset,
            ...(args.max_chars === undefined
              ? {}
              : {
                  max_chars: args.max_chars,
                  original_chars: originalChars,
                  final_chars: finalChars,
                }),
          } satisfies McpTypesListMeta;
        }

        return payload;
      }),
  );
}

/**
 * `etn.types.get` (задача 17ff4619, 0.15.1) — один тип по `id` XOR `name`.
 * Закрывает основной сценарий агента: «нужен тип „Автор“», а не каталог из
 * 47 типов, который к тому же обрезается по `max_chars`.
 *
 * Резолв имени — ровно тот же, что у параметра `type` в `etn.thoughts.write`:
 * функции домена `resolveThoughtTypeIdByName`/`resolveLinkTypeIdByName` дают
 * `NOT_FOUND` и `VALIDATION_ERROR` с `details.candidates` (id + имя). При
 * `scope: "all"` отсутствие в одном каталоге не ошибка — совпадения в разных
 * каталогах неоднозначностью не являются, возвращаются оба.
 */
/** Резолв имени для `etn.types.get`.
 *
 * Доменные резолверы `resolveThoughtTypeIdByName`/`resolveLinkTypeIdByName`
 * общие с параметром `type` в `etn.thoughts.write` и `etn.ontology.write`, где
 * `details.field = "type"` — правильное имя параметра. У `etn.types.get`
 * параметр называется `name`, поэтому поле ошибки переписывается здесь:
 * агент, разбирающий `details.field`, обязан увидеть имя того параметра,
 * который он действительно передал (ошибка 2f39e8f0). `candidates` и прочие
 * поля `details` сохраняются как есть.
 */
function resolveTypeNameForGet(resolve: () => string): string {
  try {
    return resolve();
  } catch (err) {
    if (
      err instanceof EtnError &&
      err.details !== null &&
      typeof err.details === 'object' &&
      (err.details as Record<string, unknown>).field === 'type'
    ) {
      throw new EtnError(
        err.code,
        err.message,
        { ...(err.details as Record<string, unknown>), field: 'name' },
        err.requestId,
      );
    }
    throw err;
  }
}

export function registerTypesGetTool(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.types.get',
    {
      title: 'Тип по имени или id',
      description:
        'Один тип по `id` XOR `name` — вместо каталога целиком. `scope` — каталог поиска ' +
        '(`thoughts`/`links`/`all`, дефолт `all`); имя мысли — по `name`, связи — по `name_forward` ' +
        'ИЛИ `name_reverse` (регистр не важен). Несколько совпадений в одном каталоге → ' +
        '`VALIDATION_ERROR` с `details.candidates`; совпадения в разных при `all` — не ' +
        'неоднозначность, возвращаются оба; нет — `NOT_FOUND`. Форма записи — как в ' +
        '`etn.types.list` (трансклюзии, `comment_template_md`, `icon`, эффективные свойства, ' +
        '`views[]`, `structural_properties_note`), без `usage_count`.',
      inputSchema: TypesGet.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.types.get'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const expand = createBodyExpander(ndb);
        const expandText: ExpandText = (text) => (text === null ? null : expand(text));
        const scope = args.scope ?? 'all';
        const includesThoughts = scope !== 'links';
        const includesLinks = scope !== 'thoughts';

        const thoughtTypes: ThoughtType[] = [];
        const linkTypes: LinkType[] = [];

        if (args.id !== undefined) {
          if (includesThoughts) {
            const t = getThoughtType(ndb, args.id);
            if (t !== null) thoughtTypes.push(t);
          }
          if (includesLinks) {
            const t = getLinkType(ndb, args.id);
            if (t !== null) linkTypes.push(t);
          }
          if (thoughtTypes.length === 0 && linkTypes.length === 0) {
            throw new EtnError('NOT_FOUND', `type ${args.id} not found`, {
              field: 'id',
              id: args.id,
            });
          }
        } else {
          const name = args.name!;
          // Домен сам отвечает NOT_FOUND/VALIDATION_ERROR(candidates); при
          // `scope: "all"` NOT_FOUND одного каталога не отменяет поиск в другом.
          if (includesThoughts) {
            try {
              thoughtTypes.push(
                getThoughtType(ndb, resolveTypeNameForGet(() => resolveThoughtTypeIdByName(ndb, name)))!,
              );
            } catch (err) {
              if (!(err instanceof EtnError) || err.code !== 'NOT_FOUND') throw err;
            }
          }
          if (includesLinks) {
            try {
              linkTypes.push(
                getLinkType(ndb, resolveTypeNameForGet(() => resolveLinkTypeIdByName(ndb, name)))!,
              );
            } catch (err) {
              if (!(err instanceof EtnError) || err.code !== 'NOT_FOUND') throw err;
            }
          }
          if (thoughtTypes.length === 0 && linkTypes.length === 0) {
            throw new EtnError('NOT_FOUND', `type "${name}" not found`, {
              field: 'name',
              name,
            });
          }
        }

        const payload: McpTypesGetResult = {
          ...(includesThoughts
            ? {
                thought_types: thoughtTypes.map((t) => buildThoughtTypeEntry(ndb, expandText, t)),
                ...(thoughtTypes.length === 0
                  ? {}
                  : { structural_properties_note: STRUCTURAL_PROPERTIES_NOTE }),
              }
            : {}),
          ...(includesLinks
            ? { link_types: linkTypes.map((t) => buildLinkTypeEntry(ndb, expandText, t)) }
            : {}),
        };
        return payload;
      }),
  );
}
