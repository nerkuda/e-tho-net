/**
 * Pure state helpers of the «События» view (задача f27809d0 «Вид workspace
 * «События» в клиенте», элемент UI 8cd9ad55, 08-ui-spec.md §18).
 *
 * Модель критериев, её парсер и план запроса живут в едином конструкторе
 * `lib/filter-builder.ts` (задача 3742dd59): здесь — только L4-обёртка этой
 * вкладки (offset/ширина панели), словарь типов сущностей и КЛИЕНТСКАЯ
 * валидация словарей, которых у модели нет (список типов сущностей нужен
 * интерфейсу «Событий»). Свой `ActivityFilterState` убран — состояние
 * выражается общей моделью.
 */

import type { ActivityEntityType } from '@etn/shared';

import {
  ACTIVITY_ACTION_FILTERS,
  defaultActivityCriteriaState,
  parseActivityCriteria,
  type ActivityActionFilter,
  type ActivityCriteriaState,
} from '../../lib/filter-builder.js';

/** Action values shown in the UI filter — the server log carries the same
 *  vocabulary (`created`/`updated`/`deleted`/`trashed`/`restored`). */
export type ActionFilter = ActivityActionFilter;

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

/** Критерии отбора «Событий» — общая модель конструктора. */
export type ActivityFilterState = ActivityCriteriaState;

/** Empty filter — show every row of the log. */
export const DEFAULT_FILTER: ActivityFilterState = defaultActivityCriteriaState();

/** Parsed persisted L4 `activity_state`. */
export interface PersistedActivityState {
  filter: ActivityFilterState;
  offset: number;
  /** Ширина панели отборов (px), заданная сплиттером. */
  panelWidth: number | null;
}

const ENTITY_TYPE_VALUES: ReadonlySet<string> = new Set(ENTITY_TYPE_OPTIONS.map((o) => o.value));
const ACTION_VALUES: ReadonlySet<string> = new Set(ACTIVITY_ACTION_FILTERS);

/**
 * Best-effort parser for the L4 JSON blob (unknown input → defaults).
 * Читает и старый формат (`fromMs`/`toMs`/`userOp`/`userId`/`userIds`), и
 * новый — общую модель; неизвестные типы сущностей и коды действий
 * отбрасываются по словарям этого экрана.
 */
export function parseActivityState(raw: string): PersistedActivityState {
  let parsed: Partial<{
    filter: unknown;
    offset: number;
    panelWidth: number;
  }>;
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { filter: { ...DEFAULT_FILTER }, offset: 0, panelWidth: null };
  }
  const filter = parseActivityCriteria(parsed.filter ?? {});
  // Клиентская валидация словарей: у модели их нет, а серверный словарь
  // должен совпадать с интерфейсом (иначе событие молча выпадет из ленты).
  filter.entityTypes = filter.entityTypes.filter((v) => ENTITY_TYPE_VALUES.has(v));
  filter.actions = filter.actions.filter((v) => ACTION_VALUES.has(v));
  return {
    filter,
    offset:
      typeof parsed.offset === 'number' && Number.isFinite(parsed.offset) && parsed.offset >= 0
        ? Math.floor(parsed.offset)
        : 0,
    panelWidth:
      typeof parsed.panelWidth === 'number' && Number.isFinite(parsed.panelWidth) && parsed.panelWidth > 0
        ? Math.floor(parsed.panelWidth)
        : null,
  };
}
