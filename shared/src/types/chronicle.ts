/**
 * «Хроника» view DTOs (L20): the two-phase chronological-comment query of
 * `POST /chronicle/query` (docs/03-server-api.md §20) and the per-user saved
 * filters of this view.
 *
 * Phase 1 selects **thoughts** (keywords / roots + subtree / thought types);
 * phase 2 lists chronological comments attached to those thoughts or to their
 * links (filtered by link types and the link scope), intersected with the
 * requested date range.
 */

import type { ChronicleLinkScope, SavedFilterView, SortOrder } from '../enums.js';
import type { StructureAuthorOp, StructureFilter } from './structure.js';
import type { ThoughtRef } from './thought.js';

/** Filter criteria of the chronicle query (03-server-api.md §20). */
export interface ChronicleFilter {
  /** Keywords mini-syntax (`*`/`-`, AND) — searched in thought titles,
   *  synonyms, permanent+chronological comment texts of thoughts and links. */
  keywords?: string;
  /** Root thoughts of the «мысли» field; empty = all thoughts of the network. */
  thought_ids?: string[];
  /** Include the roots' subordinates up to depth 20 (undirected, deduped). */
  include_subtree?: boolean;
  /** Thought types (OR inside the list). */
  type_ids?: string[];
  /** Link types (OR inside the list); empty = links of any type. */
  link_type_ids?: string[];
  /** Which endpoint of a link must be a selected thought (03-server-api.md §20). */
  link_scope?: ChronicleLinkScope;
  /**
   * Критерии целей записи — тот же набор, что у панели «Структур»
   * (`StructureFilter`: типы, ключевые слова с `keyword_scope`, свойства,
   * даты, автор и т. д.). Запись проходит отбор, если хотя бы одна её
   * привязанная мысль (`comment_targets`, включая вторичные) удовлетворяет
   * этим критериям; комбинируются с критериями записи по AND (0.10.1,
   * требование 306f74cc).
   */
  targets?: StructureFilter;
  /**
   * Period start — полный UTC-инстанс, «голая дата» (`YYYY-MM-DD` = сутки
   * UTC) или динамический токен дат (`$today`, `$now`, арифметика `±Nd`);
   * empty = unbounded. Токен раскрывается в момент применения отбора
   * (0.10.1, требование 91f8d8dd).
   */
  date_from?: string | null;
  /** Period end; форма значения — как у {@link date_from}; empty = unbounded. */
  date_to?: string | null;
  /**
   * Автор хроно-комментария — id пользователя (`created_by`); absent —
   * фильтр не применяется. Паритет с REST `created_by` в
   * `POST /chronicle/query` (задача 59119797). Для `created_by_op: 'in' |
   * 'not_in'` — массив id.
   */
  created_by?: string | string[];
  /** Оператор условия `created_by` (по умолчанию `eq`). */
  created_by_op?: StructureAuthorOp;
  /**
   * Последний редактор хроно-комментария — id пользователя (`updated_by`);
   * absent — фильтр не применяется. Для `updated_by_op: 'in' | 'not_in'` —
   * массив id.
   */
  updated_by?: string | string[];
  /** Оператор условия `updated_by` (по умолчанию `eq`). */
  updated_by_op?: StructureAuthorOp;
}

/** Filter + paging of `POST /chronicle/query`. */
export interface ChronicleQueryRequest extends ChronicleFilter {
  /**
   * Sort direction of the whole sort key (0.10.1): класс записи → `valid_from`
   * → `valid_to` → `created_at` → `id`.
   */
  order: SortOrder;
  limit: number;
  offset: number;
}

/** A link attachment of a chronicle row, resolved for display. */
export interface ChronicleTargetLink {
  id: string;
  type_id: string | null;
  active: boolean;
  /** Display name of the link type relative to source → target. */
  type_name_forward: string | null;
  /** Display name of the link type relative to target → source. */
  type_name_reverse: string | null;
  source: ThoughtRef;
  target: ThoughtRef;
}

/** One attachment of a chronicle row, resolved for display («мысли/связи»). */
export type ChronicleTarget =
  | { kind: 'thought'; thought: ThoughtRef }
  | { kind: 'link'; link: ChronicleTargetLink };

/** One row of the chronicle table (03-server-api.md §20). */
export interface ChronicleRow {
  id: string;
  title: string | null;
  valid_from: string;
  valid_to: string | null;
  /**
   * Флаг «учитывать время» записи (0.10.1, требование 91ba5b3f). Клиент
   * показывает/правит время суток только при `true`; на хранение дат не
   * влияет.
   */
  use_time: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  /** Plain-text preview of `body_md` (~160 chars, `<mark>` highlights). */
  snippet: string;
  /** All attachments of the comment (m2m), resolved. */
  targets: ChronicleTarget[];
}

/** Result of `POST /chronicle/query` (list envelope: rows + total). */
export interface ChronicleQueryResponse {
  rows: ChronicleRow[];
  total: number;
}

/** Persisted criteria of a chronicle saved filter (03-server-api.md §18). */
export interface ChronicleFilterDefinition extends ChronicleFilter {
  order: SortOrder;
}

/** A named saved filter of the chronicle view (L3, per-user). */
export interface ChronicleSavedFilter {
  id: string;
  view: SavedFilterView;
  name: string;
  definition: ChronicleFilterDefinition;
  /** ISO-8601 UTC. */
  created_at: string;
  /** ISO-8601 UTC. */
  updated_at: string;
}
