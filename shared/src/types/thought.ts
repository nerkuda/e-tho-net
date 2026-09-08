/**
 * Thought entity and focus-related types.
 *
 * Field names mirror docs/02-data-model.md §3.1, §3.10 and the REST contract in
 * docs/03-server-api.md §6. SQLite 0/1 INTEGER columns surface as `boolean`.
 * Internal-only columns (`title_norm`, `created_by`/`updated_by` on some
 * responses) are omitted or marked optional.
 */

import type { EtnErrorCode } from '../errors.js';
import type { FocusDir, IconKind, LinkStyle, SortKind, SortOrder } from '../enums.js';
import type { HoldingLayerRef } from './trash.js';

/** A thought entity (02-data-model.md §3.1, 03-server-api.md §6.1). */
export interface Thought {
  id: string;
  title: string;
  type_id: string | null;
  icon: string | null;
  icon_kind: IconKind;
  /**
   * Id of the attachment (image file of this thought) whose full picture
   * Ctrl-hover shows over the icon; the icon itself stays a self-contained
   * preview (workplan L16). `null` — the icon has no backing attachment.
   */
  icon_attachment_id: string | null;
  active: boolean;
  /** Protected thoughts (HOME) cannot be deleted. */
  is_protected: boolean;
  /** Root thought of the network (HOME). */
  is_root: boolean;
  /** In the trash, awaiting physical deletion (02-data-model.md §3.1.2). */
  marked_for_deletion: boolean;
  /** ISO-8601 moment of the mark; `null` when not marked. */
  marked_for_deletion_at: string | null;
  /** user_id that set the mark; `null` when not marked. */
  marked_for_deletion_by: string | null;
  fg_color: string | null;
  bg_color: string | null;
  /**
   * Font-style flags. `null` means "inherit from the thought's type" (see
   * 02-data-model.md §3.1.1); `true`/`false` is an explicit manual value.
   */
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
  /** Synonyms (from `thought_synonyms`), included on single-thought reads. */
  synonyms: string[];
  version: number;
  /** ISO-8601 UTC. */
  created_at: string;
  updated_at: string;
  /** Author id of the thought. Omitted on lightweight responses. */
  created_by?: string;
  /** User id of the last edit. Omitted on lightweight responses. */
  updated_by?: string;
  /**
   * Unix-миллисекунды момента `created_at` (02-data-model.md §3.1,
   * требование e6d4165e «колонки авторства»). Сортировка по ним дешевле
   * парсинга ISO; на UI наружу показываются секунды. Omitted on lightweight
   * responses — выставлен вместе с {@link created_by}.
   */
  created_at_ms?: number;
  /** Unix-миллисекунды `updated_at`; парные правила с {@link created_at_ms}. */
  updated_at_ms?: number;
}

/** Direction for an inline link created together with a thought (03-server-api.md §6.3). */
export interface ThoughtCreateLink {
  /**
   * Role of `target_thought_id` for the NEW thought: `parent` — the new
   * thought is attached UNDER `target_thought_id` (target becomes the link
   * source/its parent); `child` — the new thought becomes the parent
   * (the link source) of `target_thought_id`. Unified with the MCP tool
   * `etn.thoughts.create`'s `link.direction` — both use the same semantics,
   * no translation at any boundary.
   */
  direction: 'parent' | 'child';
  target_thought_id: string;
  type_id?: string | null;
}

/** Input accepted by `POST /thoughts` (03-server-api.md §6.3). */
export interface ThoughtCreateInput {
  title: string;
  synonyms?: string[];
  type_id?: string | null;
  icon?: string | null;
  icon_kind?: IconKind;
  active?: boolean;
  fg_color?: string | null;
  bg_color?: string | null;
  font_bold?: boolean;
  font_italic?: boolean;
  font_underline?: boolean;
  font_strike?: boolean;
  create_link?: ThoughtCreateLink;
}

/** Input accepted by `PATCH /thoughts/{id}` (03-server-api.md §6.4). Also used
 *  as the `changes` payload of `thought.updated` real-time events. */
export interface ThoughtUpdateInput {
  title?: string;
  synonyms?: string[];
  type_id?: string | null;
  icon?: string | null;
  icon_kind?: IconKind;
  /** Attachment shown by Ctrl-hover over the icon; `null` clears the link (L16). */
  icon_attachment_id?: string | null;
  active?: boolean;
  /** «Поместить в корзину» / «Вернуть из корзины» (03-server-api.md §6.4). */
  marked_for_deletion?: boolean;
  fg_color?: string | null;
  bg_color?: string | null;
  /**
   * `null` clears the manual setting (the field is inherited from the type);
   * `true`/`false` sets an explicit manual value (02-data-model.md §3.1.1).
   */
  font_bold?: boolean | null;
  font_italic?: boolean | null;
  font_underline?: boolean | null;
  font_strike?: boolean | null;
}

/** Operators accepted by `POST /thoughts/batch` (03-server-api.md §6.6). */
export type ThoughtBatchOp =
  | 'set_type'
  | 'clear_type'
  | 'set_active'
  | 'set_inactive'
  | 'delete'
  | 'trash'
  | 'purge'
  | 'link_to_focus'
  | 'unlink_from_focus'
  // Bulk link operations of the structures filter commands (L22, §6.6):
  // anchors come in `parent_ids`/`child_ids`, new links are untyped and
  // existing pairs are left untouched.
  | 'link_parents'
  | 'link_children'
  | 'set_only_parents'
  | 'unlink_parents'
  | 'unlink_children';

/** Arguments for {@link ThoughtBatchInput}. */
export interface ThoughtBatchArgs {
  type_id?: string | null;
  active?: boolean;
  focus_thought_id?: string;
  link_type_id?: string | null;
  direction?: 'parent' | 'child';
  /** Anchor thought ids for `link_parents`/`set_only_parents`/`unlink_parents`. */
  parent_ids?: string[];
  /** Anchor thought ids for `link_children`/`unlink_children`. */
  child_ids?: string[];
}

/** Input accepted by `POST /thoughts/batch` (03-server-api.md §6.6). */
export interface ThoughtBatchInput {
  ids: string[];
  op: ThoughtBatchOp;
  args?: ThoughtBatchArgs;
}

/** Result of `POST /thoughts/batch` (03-server-api.md §6.6). */
export interface ThoughtBatchResult {
  affected: number;
  failures: ThoughtBatchFailure[];
}

/** Per-id failure inside a {@link ThoughtBatchResult}. */
export interface ThoughtBatchFailure {
  id: string;
  code: EtnErrorCode;
  message: string;
}

/**
 * Lightweight thought metadata returned by `POST /thoughts/resolve`
 * (03-server-api.md §6.9). Used for focus history, mentions, etc.
 */
export interface ThoughtRef {
  id: string;
  title: string;
  type_id: string | null;
  icon: string | null;
  icon_kind: IconKind;
  /** Backing attachment of the icon for Ctrl-hover zoom (L16); `null` — none. */
  icon_attachment_id: string | null;
  active: boolean;
  /** In the trash, awaiting physical deletion (S13, 02-data-model.md §3.1.2). */
  marked_for_deletion: boolean;
  fg_color: string | null;
  bg_color: string | null;
  /** Manual (`true`/`false`) or `null` = inherit from the type (§3.1.1). */
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
}

/**
 * One group of the usage response: thoughts referencing the target thought
 * through one `thought_ref` property (03-server-api.md §9.1).
 */
export interface ThoughtUsageGroup {
  property_id: string;
  /** Property name (`type_properties.key`). */
  key: string;
  thoughts: ThoughtRef[];
}

/** Response of `GET /thoughts/{id}/usage` (03-server-api.md §9.1). */
export interface ThoughtUsage {
  /** Total number of referencing values across all groups. */
  total: number;
  groups: ThoughtUsageGroup[];
  /**
   * Layers holding a changed (non-tombstone) shadow row of this thought
   * (13-layers.md §5.1). Empty until layers land in version 0.5.2 (S2).
   */
  holding_layers: HoldingLayerRef[];
}

/** Per-user view mark, drives the "viewed" sort (02-data-model.md §3.10.2). */
export interface ThoughtView {
  user_id: string;
  thought_id: string;
  /** ISO-8601 UTC. */
  last_viewed_at: string;
}

/** Per-user focus-zone sort selection (02-data-model.md §3.10.3). */
export interface UserFocusPreferences {
  user_id: string;
  focus_thought_id: string;
  dir: FocusDir;
  sort: SortKind;
  sort_order: SortOrder;
  updated_at: string;
}

/** A single row of `user_focus_order` — a manual position (02-data-model.md §3.10.4). */
export interface UserFocusOrderEntry {
  user_id: string;
  focus_thought_id: string;
  /** Manual order is only stored for parents/children, never siblings. */
  dir: Exclude<FocusDir, 'siblings'>;
  thought_id: string;
  position: number;
  updated_at: string;
}

/** Input for `PUT /thoughts/{fid}/focus-preferences` (03-server-api.md §6.8). */
export interface FocusPreferencesInput {
  dir: FocusDir;
  sort: SortKind;
  order: SortOrder;
}

/** Input for `POST /thoughts/{fid}/focus-order` (03-server-api.md §6.8). */
export interface FocusOrderInput {
  dir: Exclude<FocusDir, 'siblings'>;
  ordered_ids: string[];
}

/** A neighbour returned inside a focus response (03-server-api.md §6.2). */
export interface FocusNeighbor {
  id: string;
  title: string;
  type_id: string | null;
  icon: string | null;
  active: boolean;
  /** Id of the link connecting the focused thought to this neighbour. */
  link_id: string;
  link_type_id: string | null;
  link_active: boolean;
  /** Whether the neighbour has ANY incoming link (drives the top ellipse fill). */
  has_incoming: boolean;
  /** Whether the neighbour has ANY outgoing link (drives the bottom ellipse fill). */
  has_outgoing: boolean;
  /**
   * Linear row-major position of this neighbour in the zone when the user's
   * sort is `manual` (docs/02-data-model.md §3.10.4): `0` for the first
   * thought, `1` for the second, etc. `null` when the active sort is not
   * `manual` or when the thought has no entry in `user_focus_order`
   * (e.g. it was just added to a `manual`-sorted zone and has not yet
   * been positioned by an explicit reorder — it then falls to the tail
   * of the row-major list, §11-settings-and-state.md §3.2).
   */
  manual_position: number | null;
  /**
   * 0.7.2 (requirement 8ab42ea8) — `true`, когда у связи `link_id` есть
   * хотя бы одно заполненное значение свойства. `false`, если нет ни
   * одного. REST не выставляет эти флаги; MCP `etn.thoughts.neighbors`
   * выставляет всегда (по умолчанию `false`).
   */
  has_properties?: boolean;
  /**
   * 0.7.2 (requirement 8ab42ea8) — `true`, когда у связи `link_id` есть
   * постоянный или хотя бы один хронологический комментарий. REST не
   * выставляет; MCP `etn.thoughts.neighbors` выставляет всегда.
   */
  has_comment?: boolean;
  /**
   * 0.7.2 — направление ребра от точки зрения фокуса. `"in"` — ребро
   * входит в фокус (сосед является `source`); `"out"` — ребро выходит из
   * фокуса (сосед является `target`). Присутствует только когда MCP-фасад
   * отдаёт оба направления одним вызовом (`etn.thoughts.neighbors` с
   * `dir: "both"`). Для `parents` всегда `"in"`, для `children` всегда
   * `"out"`, для `siblings` поле опускается (нет «направления»).
   */
  direction?: 'in' | 'out';
}

/**
 * 0.7.2 — ребро подграфа в ответе `etn.thoughts.subgraph`. Совпадает с
 * минимальной формой, которую возвращает domain `subgraph()` (task N6),
 * плюс два булевых признака наполнения связи (requirement 8ab42ea8).
 * REST-чтение подграфа (когда появится) и старые клиенты эти поля не
 * получают — они опциональные и приходят только из MCP-фасада.
 */
export interface SubgraphEdge {
  id: string;
  source_id: string;
  target_id: string;
  type_id: string | null;
  /** 0.7.2 — у связи есть хотя бы одно заполненное значение свойства. */
  has_properties?: boolean;
  /** 0.7.2 — у связи есть постоянный или хронологический комментарий. */
  has_comment?: boolean;
}

/**
 * A link among the visible thoughts of a focus response (03-server-api.md §6.2).
 * Unlike {@link FocusNeighbor} (which only carries the link to the focus), this
 * lists every active link between any two visible thoughts — including
 * neighbour↔neighbour — so the canvas can draw all visible links.
 */
export interface FocusEdge {
  id: string;
  source_id: string;
  target_id: string;
  type_id: string | null;
  /** Per-link override of the type's colour; `null` = inherit from the type. */
  color: string | null;
  /** Per-link override of the type's dash style; `null` = inherit. */
  style: LinkStyle | null;
  /** Per-link override of the type's width; `null` = inherit. */
  width: number | null;
}

/** Response of `POST /thoughts/{id}/focus` (03-server-api.md §6.2). */
export interface FocusResponse {
  /** The focused thought (full entity). */
  focused: Thought;
  /** Sources of links pointing at the focused thought. */
  parents: FocusNeighbor[];
  /** Targets of links originating at the focused thought. */
  children: FocusNeighbor[];
  /** Thoughts sharing a parent with the focused thought. */
  siblings: FocusNeighbor[];
  /** Every active link among the visible thoughts (focus + parents + children + siblings). */
  edges: FocusEdge[];
  /** Per-zone sort currently applied for this user (siblings is not orderable
   *  to `manual`, but still carries an alpha/created/viewed preference). The
   *  full `{ sort, order }` is returned so the UI can mark the active entry
   *  in the zone context menu (08-ui-spec.md §2.7). */
  sorts: {
    parents: { sort: SortKind; order: SortOrder };
    children: { sort: SortKind; order: SortOrder };
    siblings: { sort: SortKind; order: SortOrder };
  };
}

/**
 * One row of `etn.thoughts.get.meta.link_stats` (0.7.2) — link counts for a
 * single link type in one direction. `direction: "in"` — the link points AT
 * this thought (`target_id = thoughtId`); `direction: "out"` — the link
 * originates FROM this thought (`source_id = thoughtId`). Counted over active
 * links only. `link_type_id` is `null` for the untyped-edges group.
 */
export interface LinkStatEntry {
  /** Registry link type id, or `null` for the untyped-edges group. */
  link_type_id: string | null;
  /** `"in"` — link points at the thought; `"out"` — link originates from it. */
  direction: 'in' | 'out';
  /** Active-link count for `(link_type_id, direction)`. */
  count: number;
}

/**
 * The `link_stats` block of `etn.thoughts.get.meta` (0.7.2): the per-direction
 * counters keyed by link type, paired with the catalogue of every link type
 * actually referenced. Lets an agent read the influence profile of a thought
 * in one MCP call without iterating `etn.thoughts.neighbors`.
 */
export interface LinkStats {
  /** Counters grouped by link type and direction. */
  stats: LinkStatEntry[];
  /** Reference table of link types referenced by `stats` — name_forward,
   *  name_reverse and the AI-facing description so the agent knows what each
   *  counter means. Entries with `link_type_id: null` are absent (untyped). */
  link_types: Record<string, LinkStatsLinkTypeRef>;
}

/** Compact reference of a link type, used as the value shape of
 *  {@link LinkStats.link_types}. Re-declared here (instead of importing from
 *  `./mcp.js`) to avoid a runtime circular import — `mcp.ts` already pulls
 *  thought types from `./thought.js`, so a back-reference would touch the
 *  cycle on the runtime side. The shape matches `LinkTypeRef` exactly. */
export interface LinkStatsLinkTypeRef {
  id: string;
  name_forward: string;
  name_reverse: string;
  description: string | null;
}

/** «Сигналы полноты» мысли для MCP-чтения (task N2, docs/05-mcp-server.md
 * §3): счётчики соседних сущностей и превью постоянного комментария. */
export interface ThoughtMeta {
  /** Активные связи, входящие в мысль. */
  parents_count: number;
  /** Активные связи, исходящие из мысли. */
  children_count: number;
  /** Вложения мысли (url + file). */
  attachments_count: number;
  /** Хронологические комментарии мысли. */
  chrono_count: number;
  /**
   * Сколько раз мысль используется как `thought_ref`-значение свойств
   * других мыслей (формальные связи, «Использование» в редакторе —
   * 03-server-api.md §9.1).
   */
  usage_count: number;
  /**
   * Постоянный комментарий (ровно один на мысль) с обрезкой больших
   * текстов: `body_md` — первые {@link COMMENT_PREVIEW_CHARS}
   * символов; `chars_total` — полная длина, `truncated` — обрезан ли текст.
   * `null`, когда постоянного комментария нет.
   */
  permanent: PermanentCommentPreview | null;
  /**
   * Профиль влияния мысли (0.7.2): счётчики активных связей по
   * `(link_type_id, direction)` + справочник `link_types`. Отвечает на
   * «от чего зависит / на что влияет» одним вызовом, без обхода соседей.
   */
  link_stats: LinkStats;
  /**
   * Эффективный набор отборов для мысли (задача c1fa71d4, 0.7.3, операция
   * cb8d8e43): имя, описание и тип-владелец каждого доступного отбора.
   * `definition` намеренно опущен — агенту нужен смысл, а не внутренности.
   * Пустой массив — у типа мысли нет отборов. Порядок — от корня к типу
   * мысли, внутри уровня по `position` (требование eaca1253).
   */
  views: ThoughtMetaView[];
}

/**
 * Одна запись `meta.views` в карточках мысли (задача c1fa71d4, операция
 * cb8d8e43). Агент видит, какие отборы доступны мысли этого типа, и дёргает
 * `etn.views.run { view_name }` — без поиска id и знания о цепочке типов.
 */
export interface ThoughtMetaView {
  /** Id отбора (для отладки и прямой адресации при исполнении). */
  id: string;
  /** Видимое имя — используется как `view_name` в `etn.views.run`. */
  name: string;
  /** Нормализованное имя (`trim + lowercase`) — фактический ключ сравнения. */
  name_key: string;
  /** Описание отбора; `null`, если его нет. */
  description: string | null;
  /** Id типа мысли, на котором отбор определён (свой или унаследованный). */
  defined_on: string;
  /** `true` — отбор унаследован от типа-предка. */
  inherited: boolean;
  /** `true` — отбор открывается сам при переводе мысли в фокус. */
  is_default: boolean;
}

/** Превью постоянного комментария (task N2). */
export interface PermanentCommentPreview {
  /** Id комментария — адрес для `etn.comments.get` (полный текст). */
  id: string;
  /** Первые 2000 символов markdown-текста. */
  body_md: string;
  /** Сколько символов возвращено в `body_md`. */
  chars_returned: number;
  /** Полная длина тела комментария. */
  chars_total: number;
  /** True, когда текст обрезан (`chars_total > chars_returned`). */
  truncated: boolean;
  /** Для permanent совпадает с `created_at` (02-data-model.md §3.8). */
  valid_from: string;
  created_at: string;
  updated_at: string;
}

/**
 * Полный (без обрезки) постоянный комментарий — форма, которую MCP-фасад
 * `etn.thoughts.get` возвращает в `meta.permanent` (задача 3ea09a54
 * «Условная обрезка текстов в ответах MCP»): единственный случай, когда
 * постоянный комментарий мысли отдаётся целиком без метаданных `chars_*`/
 * `truncated`. В остальных местах (subgraph, structure, списки) —
 * {@link PermanentCommentPreview} по требованию «выборка сущностей →
 * превью».
 */
export interface PermanentCommentFull {
  /** Id комментария. */
  id: string;
  /** Полный markdown-текст без обрезки. */
  body_md: string;
  /** Для permanent совпадает с `created_at` (02-data-model.md §3.8). */
  valid_from: string;
  created_at: string;
  updated_at: string;
}

/**
 * Сигналы полноты мысли с полнотекстовым постоянным комментарием
 * (задача 3ea09a54) — форма `meta` для MCP-фасада `etn.thoughts.get`,
 * запрошенного через `fullPermanent: true`. В остальных местах
 * {@link ThoughtMeta.permanent} остаётся в preview-форме.
 */
export interface ThoughtMetaFull {
  parents_count: number;
  children_count: number;
  attachments_count: number;
  chrono_count: number;
  /**
   * Сколько раз мысль используется как `thought_ref`-значение свойств
   * других мыслей (формальные связи, «Использование» в редакторе —
   * 03-server-api.md §9.1).
   */
  usage_count: number;
  /** Полный текст постоянного комментария; `null`, когда его нет. */
  permanent: PermanentCommentFull | null;
  /**
   * Профиль влияния мысли (0.7.2) — то же, что и {@link ThoughtMeta.link_stats}:
   * счётчики активных связей по `(link_type_id, direction)` + справочник
   * `link_types`. Поле общее у обеих проекций meta — это семантика, а не
   * оформление.
   */
  link_stats: LinkStats;
  /**
   * Эффективный набор отборов для мысли (задача c1fa71d4, 0.7.3, операция
   * cb8d8e43). Содержимое идентично {@link ThoughtMeta.views}.
   */
  views: ThoughtMetaView[];
}

/**
 * Полнотекстовый постоянный комментарий мысли — форма, которую возвращает
 * `etn.thoughts.resolve` в `comment_preview` (задача 6d45ab37, P1-паритет MCP↔REST):
 * единственный случай пакетного чтения, когда постоянный комментарий мысли
 * отдаётся целиком без метаданных `chars_*`/`truncated`. В отличие от
 * `etn.thoughts.get.meta.permanent` (задача 3ea09a54), здесь форма одна —
 * `resolve` не выбирает между preview/full: единственный заход агента по
 * списку id должен вернуть полный текст, чтобы агенту не приходилось
 * отдельно ходить в `etn.comments.get` для каждой карточки.
 */
export interface PermanentCommentFullText {
  /** Id комментария. */
  id: string;
  /** Полный markdown-текст без обрезки. */
  body_md: string;
  /** Для permanent совпадает с `created_at` (02-data-model.md §3.8). */
  valid_from: string;
  created_at: string;
  updated_at: string;
}

/**
 * Превью постоянного комментария в форме `etn.thoughts.resolve` — то же, что
 * {@link PermanentCommentPreview}, но без `chars_*`/`truncated`: либо
 * полный текст (см. {@link PermanentCommentFullText}), либо `null`.
 *
 * Формальное наличие двух близких типов — следствие задачи 3ea09a54
 * «Условная обрезка текстов в ответах MCP»: preview-форма для выборок
 * сущностей, full-форма для одиночных точек входа. `resolve` ближе ко
 * второму — поэтому здесь `body_md` либо полный, либо отсутствует.
 */
export type ResolveCommentPreview = PermanentCommentFullText | null;

/**
 * «Карточка мысли» — единица ответа `etn.thoughts.resolve` (задача 6d45ab37,
 * P1-паритет MCP↔REST, спека 85b94925). Пакетное чтение по списку id
 * возвращает массив таких карточек с теми же полями, что и `etn.thoughts.get`,
 * плюс полнотекстовый постоянный комментарий в `comment_preview`.
 *
 * Семантически совпадает с плоской формой `etn.thoughts.get`: id/title/
 * synonyms/type/properties/meta/comment_preview, без обёрток. Тип, свойства
 * и meta берутся в той же форме, что и у `get` (`view` влияет только на
 * поля самой мысли — id/title/synonyms/... — и `type`, но не на `properties`
 * и `meta`).
 */
export interface ThoughtCard {
  /** Все поля {@link Thought} в выбранной проекции (`compact`/`full`). */
  id: string;
  title: string;
  type_id: string | null;
  icon: string | null;
  icon_kind: IconKind;
  icon_attachment_id: string | null;
  active: boolean;
  marked_for_deletion: boolean;
  fg_color: string | null;
  bg_color: string | null;
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
  synonyms: string[];
  version: number;
  /** ISO-8601 UTC. */
  created_at: string;
  updated_at: string;
  /**
   * Тип мысли в каталожной форме (см. {@link ThoughtTypeRef} в `./mcp.ts`):
   * id, name, AI-facing description. `null`, когда тип не назначен.
   */
  type: import('./mcp.js').ThoughtTypeRef | null;
  /** Свойства мысли в форме `etn.thoughts.get` (резолвнутые `thought_ref`,
   *  пометка `outside_type` для значений вне L21-цепочки). */
  properties: import('./thought-type.js').ResolvedPropertyValue[];
  /** «Сигналы полноты» (см. {@link ThoughtMeta}). */
  meta: ThoughtMeta;
  /** Полнотекстовый постоянный комментарий либо `null`. */
  comment_preview: ResolveCommentPreview;
}

/**
 * Результат `etn.thoughts.resolve` (задача 6d45ab37, спека 85b94925):
 * карточки найденных мыслей в порядке первого появления в запросе
 * (дубли в `thought_ids` схлопываются) плюс список id, которых в сети
 * нет. `missing[]` сохраняет порядок первого появления в запросе.
 */
export interface ResolveResult {
  /** Найденные мысли; порядок — по первому появлению id в `thought_ids`. */
  items: ThoughtCard[];
  /** Не найденные в сети id (порядок — по первому появлению в запросе). */
  missing: string[];
}
