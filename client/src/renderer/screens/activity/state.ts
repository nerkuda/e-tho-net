/**
 * Pure state helpers of the «События» view (задача f27809d0 «Вид workspace
 * «События» в клиенте», элемент UI 8cd9ad55, 08-ui-spec.md §18).
 *
 * Filter shape + serialisation/deserialisation to L4 `ui_state`. No DOM, no IPC
 * — unit-testable under plain Node (same shape as `chronicle/state.ts`).
 */

import type { ActivityEntityType } from '@etn/shared';

/** Action values shown in the UI filter — the server log carries the same
 *  vocabulary (`created`/`updated`/`deleted`/`trashed`/`restored`); we keep
 *  the wire value verbatim to avoid a translation table. */
export type ActionFilter = 'created' | 'updated' | 'deleted' | 'trashed' | 'restored';

/** Whitelist of `entity_type` values the user can filter by. Mirrors
 *  `ActivityEntityType` plus the empty option (no entity-type filter applied). */
export const ENTITY_TYPE_OPTIONS: ReadonlyArray<{
  value: ActivityEntityType;
  label: string;
}> = [
  { value: 'thought', label: 'мысль' },
  { value: 'link', label: 'связь' },
  { value: 'thought_type', label: 'тип мысли' },
  { value: 'link_type', label: 'тип связи' },
  { value: 'property', label: 'свойство' },
  { value: 'comment', label: 'комментарий' },
  { value: 'attachment', label: 'вложение' },
  { value: 'layer', label: 'слой' },
];

/** Criteria of the activity filter as held by the panel (persisted to L4). */
export interface ActivityFilterState {
  /** Inclusive lower bound, ms epoch. Empty string = no lower bound. */
  fromMs: string;
  /** Inclusive upper bound, ms epoch. Empty string = no upper bound. */
  toMs: string;
  /** Filter by `user_id` (empty = any participant). */
  userId: string;
  /** Set of selected entity types (empty = any). */
  entityTypes: ActivityEntityType[];
  /** Set of selected actions (empty = any). */
  actions: ActionFilter[];
}

/** Empty filter — show every row of the log. */
export const DEFAULT_FILTER: ActivityFilterState = {
  fromMs: '',
  toMs: '',
  userId: '',
  entityTypes: [],
  actions: [],
};

/** Parsed persisted L4 `activity_state`. */
export interface PersistedActivityState {
  filter: ActivityFilterState;
  offset: number;
}

/** Best-effort parser for the L4 JSON blob (unknown input → defaults). */
export function parseActivityState(raw: string): PersistedActivityState {
  try {
    const parsed = JSON.parse(raw) as Partial<{
      filter: Partial<ActivityFilterState>;
      offset: number;
    }>;
    const f = parsed.filter ?? {};
    const entityTypes = Array.isArray(f.entityTypes)
      ? (f.entityTypes.filter(
          (v): v is ActivityEntityType =>
            v === 'thought' ||
            v === 'link' ||
            v === 'thought_type' ||
            v === 'link_type' ||
            v === 'property' ||
            v === 'comment' ||
            v === 'attachment' ||
            v === 'layer',
        ))
      : [];
    const actions = Array.isArray(f.actions)
      ? (f.actions.filter(
          (v): v is ActionFilter =>
            v === 'created' ||
            v === 'updated' ||
            v === 'deleted' ||
            v === 'trashed' ||
            v === 'restored',
        ))
      : [];
    return {
      filter: {
        fromMs: typeof f.fromMs === 'string' ? f.fromMs : '',
        toMs: typeof f.toMs === 'string' ? f.toMs : '',
        userId: typeof f.userId === 'string' ? f.userId : '',
        entityTypes,
        actions,
      },
      offset:
        typeof parsed.offset === 'number' && Number.isFinite(parsed.offset) && parsed.offset >= 0
          ? Math.floor(parsed.offset)
          : 0,
    };
  } catch {
    return { filter: { ...DEFAULT_FILTER }, offset: 0 };
  }
}
