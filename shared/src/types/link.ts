/**
 * Link entity and grouped-link view types.
 *
 * Field names mirror docs/02-data-model.md §3.6 and the REST contract in
 * docs/03-server-api.md §7. SQLite 0/1 INTEGER columns surface as `boolean`.
 */

import { EtnError } from '../errors.js';
import type { LinkStyle } from '../enums.js';
import type { ThoughtRef } from './thought.js';
import type { NetworkProperty } from './thought-type.js';

/**
 * Фильтр обхода графа по типам связей (задача c965ad03, 0.8.1, требование
 * bed23c25 «Фильтр обхода по типам связей»).
 *
 * Единая wire-форма для всех точек обхода: MCP `etn.thoughts.subgraph` /
 * `etn.thoughts.neighbors` / `etn.thoughts.path` / `etn.thoughts.query` и
 * REST `POST /thoughts/{id}/focus` / `GET /thoughts/{id}/neighbors` /
 * `POST /thoughts/query` (+ `GET /thoughts/{id}/hierarchy` для дерева
 * «Структур»).
 *
 * Семантика: связь проходит фильтр, когда её тип входит в раскрытый список
 * `type_ids` (каждый id — вместе с потомками по иерархии `link_types`, L21)
 * ИЛИ она нетипизированная (структурная) и `include_structural === true`.
 * «Только структурные» — пустой `type_ids` + `include_structural: true`.
 * Отсутствие фильтра (undefined) — прежнее поведение: обход по всем рёбрам.
 */
export interface LinkTypeFilterInput {
  /** id типов связей; каждый раскрывается вместе с потомками (L21). */
  type_ids?: string[];
  /**
   * Включить нетипизированные (структурные) связи в обход наравне с
   * перечисленными типами.
   */
  include_structural?: boolean;
}

/** True when the filter carries at least one source (typed or structural). */
export function isLinkTypeFilterActive(filter: LinkTypeFilterInput | undefined): boolean {
  if (filter === undefined) return false;
  return (filter.type_ids?.length ?? 0) > 0 || filter.include_structural === true;
}

/**
 * Parse one wire `link_filter` value (`{ type_ids?, include_structural? }`).
 * `undefined`/`null` → `undefined` (no filter). A present object must carry
 * at least one source — a non-empty `type_ids` or `include_structural: true`;
 * anything else throws `VALIDATION_ERROR` (an empty filter must not silently
 * mean "no filter"). Shared by the REST body/query parsers and the saved
 * saved-filter definition parser.
 */
export function parseLinkTypeFilterValue(
  raw: unknown,
  requestId?: string,
): LinkTypeFilterInput | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'link_filter должен быть объектом { type_ids?: string[], include_structural?: boolean }.',
      { field: 'link_filter' },
      requestId,
    );
  }
  const rec = raw as Record<string, unknown>;
  const typeIdsRaw = rec['type_ids'];
  let typeIds: string[] | undefined;
  if (typeIdsRaw !== undefined) {
    if (
      !Array.isArray(typeIdsRaw) ||
      typeIdsRaw.some((v) => typeof v !== 'string' || v === '')
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'link_filter.type_ids должен быть массивом непустых строк.',
        { field: 'type_ids' },
        requestId,
      );
    }
    typeIds = typeIdsRaw as string[];
  }
  const structuralRaw = rec['include_structural'];
  let includeStructural: boolean | undefined;
  if (structuralRaw !== undefined) {
    if (typeof structuralRaw !== 'boolean') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'link_filter.include_structural должен быть логическим значением.',
        { field: 'include_structural' },
        requestId,
      );
    }
    includeStructural = structuralRaw;
  }
  if ((typeIds?.length ?? 0) === 0 && includeStructural !== true) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'link_filter пуст: укажите непустой type_ids и/или include_structural=true.',
      { field: 'link_filter' },
      requestId,
    );
  }
  const out: LinkTypeFilterInput = {};
  if (typeIds !== undefined && typeIds.length > 0) out.type_ids = typeIds;
  if (includeStructural !== undefined) out.include_structural = includeStructural;
  return out;
}

/**
 * Non-throwing parse of a stored `PREF_KEY.CANVAS_LINK_FILTER` value (requirement
 * «Дефолт и хранение фильтра типов связей на карте», 0.8.1): `null`/`undefined`
 * (no explicit preference — use {@link computeDefaultCanvasLinkFilter}) or a
 * garbled value both resolve to `null`; a well-formed object is validated the
 * same way as the wire `link_filter` and returned as-is.
 */
export function parseStoredCanvasLinkFilter(raw: unknown): LinkTypeFilterInput | null {
  if (raw === null || raw === undefined) return null;
  try {
    return parseLinkTypeFilterValue(raw) ?? null;
  } catch {
    return null;
  }
}

/**
 * Default canvas link-type filter derived from the property registry
 * (requirement «Дефолт и хранение фильтра типов связей на карте», 0.8.1):
 * structural links (свойства «Родители»/«Потомки») are always included, plus
 * every link-property flagged `config.show_on_map === true`. Used server-side
 * to resolve the effective filter for `POST /thoughts/{id}/focus` when the
 * user has no stored preference, and client-side to pre-check the filter
 * dialog's default state.
 */
export function computeDefaultCanvasLinkFilter(
  properties: readonly NetworkProperty[],
): LinkTypeFilterInput {
  const typeIds = properties
    .filter(
      (p) =>
        p.value_type === 'link' &&
        p.config?.structural !== true &&
        p.config?.show_on_map === true,
    )
    .map((p) => p.config?.link_type_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const out: LinkTypeFilterInput = { include_structural: true };
  if (typeIds.length > 0) out.type_ids = typeIds;
  return out;
}

/** A directed link between two thoughts (02-data-model.md §3.6). */
export interface Link {
  id: string;
  /** Thought the link originates from. */
  source_id: string;
  /** Thought the link points at. */
  target_id: string;
  type_id: string | null;
  /** Override of the type's line colour; `null` = inherit from the type. */
  color: string | null;
  /** Override of the type's dash style; `null` = inherit from the type. */
  style: LinkStyle | null;
  /** Override of the type's line width; `null` = inherit from the type. */
  width: number | null;
  active: boolean;
  /** In the trash, awaiting physical deletion (02-data-model.md §3.1.2). */
  marked_for_deletion: boolean;
  /** ISO-8601 moment of the mark; `null` when not marked. */
  marked_for_deletion_at: string | null;
  /** user_id that set the mark; `null` when not marked. */
  marked_for_deletion_by: string | null;
  version: number;
  /** ISO-8601 UTC. */
  created_at: string;
  updated_at: string;
  /** Author id of the link. */
  created_by?: string;
  /** User id of the last edit. */
  updated_by?: string;
  /**
   * Unix-миллисекунды момента `created_at` (02-data-model.md §3.6,
   * требование e6d4165e). Сортировка по ним дешевле ISO; на UI наружу
   * показываются секунды. Выставляется вместе с {@link created_by}.
   */
  created_at_ms?: number;
  /** Unix-миллисекунды `updated_at`; парные правила с {@link created_at_ms}. */
  updated_at_ms?: number;
}

/** Input accepted by `POST /links` (03-server-api.md §7.1). */
export interface LinkCreateInput {
  source_id: string;
  target_id: string;
  type_id?: string | null;
  color?: string | null;
  style?: LinkStyle | null;
  width?: number | null;
  active?: boolean;
  /**
   * Порядок ребра среди «потомков» источника (0.8.1, структурные свойства
   * «Родители»/«Потомки»): позиция в наборе «Потомки» задаёт порядок детей.
   * По умолчанию `0` — рёбра, созданные не через свойства, сохраняют прежний
   * порядок по умолчанию.
   */
  position?: number;
  /**
   * Map of property key → value to apply to the freshly created link
   * (task 053751b5, 0.7.2). Each key is resolved against the network property
   * registry by name; missing key → NOT_FOUND; property not attached to the
   * link-type chain → VALIDATION_ERROR. Ignored when the link has no link
   * type — the property still has to be attached to the link-type chain
   * (typed or untyped alike). Applied inside the same transaction as the
   * link creation so a property write that fails rolls back the link.
   */
  properties?: Record<string, import('./thought-type.js').PropertyValueValue>;
  /**
   * Permanent comment (create-or-update) attached to the new link. Mirrors
   * the permanent comment side of `etn.thoughts.upsert_bundle`. Applied
   * inside the same transaction as the link creation.
   */
  comment?: {
    title?: string | null;
    body_md: string;
  };
}

/** Input accepted by `PATCH /links/{id}` (03-server-api.md §7.1). Also the
 *  `changes` payload of `link.updated` real-time events. */
export interface LinkUpdateInput {
  /** New source thought id — must arrive together with `target_id` (swapping
   *  the endpoints inverts the link's direction). */
  source_id?: string;
  /** New target thought id — must arrive together with `source_id`. */
  target_id?: string;
  type_id?: string | null;
  color?: string | null;
  style?: LinkStyle | null;
  width?: number | null;
  active?: boolean;
  /** «Поместить в корзину» / «Вернуть из корзины» (03-server-api.md §7.1). */
  marked_for_deletion?: boolean;
}

/** A typed group of links returned for the editor (03-server-api.md §7.2). */
export interface ThoughtLinksByTypeGroup {
  type_id: string | null;
  type_name: string;
  items: ThoughtLinkItem[];
}

/** A single link + target thought inside a typed group. */
export interface ThoughtLinkItem {
  link: Link;
  target_thought: ThoughtRef;
}

/** Untyped-link group entry: the link plus the thought on the other side. */
export interface UntypedLinkItem {
  link: Link;
  /** The thought on the side opposite to the queried thought. */
  source_thought?: ThoughtRef;
  target_thought?: ThoughtRef;
}

/** Response of `GET /thoughts/{id}/links?group=type` (03-server-api.md §7.2). */
export interface ThoughtLinksGrouped {
  by_type: ThoughtLinksByTypeGroup[];
  untyped_parents: UntypedLinkItem[];
  untyped_children: UntypedLinkItem[];
}
