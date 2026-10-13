/**
 * Pure state helpers of the «События» view (задача f27809d0 «Вид workspace
 * «События» в клиенте», элемент UI 8cd9ad55, 08-ui-spec.md §18; пересобрана на
 * единый редактор — задача 16899243, требование db5e1063, ADR fc23f9c1).
 *
 * Модель критериев — общая (`FilterCriteriaState`, профиль «события»), дерево
 * условий заполняет единый конструктор: AST-снимок читает
 * `parseActivityCriteriaTree` (ветка `parseFilterDefinitionTree`), прежний
 * плоский снимок `activity_state` компилируется в дерево
 * (`compileActivityCriteriaToAst`). Своей модели/парсера у экрана нет.
 *
 * Здесь — только L4-обёртка вкладки (offset/ширина панели), словарь видов
 * сущностей экрана и клиентская валидация словарей ВОССТАНОВЛЕННОГО прежнего
 * пресета (серверный словарь обязан совпадать с интерфейсом, иначе событие
 * молча выпадет из ленты).
 */

import type { ActivityEntityType, FilterAstLeaf } from '@etn/shared';

import {
  ACTIVITY_ACTION_FILTERS,
  OPERAND_KIND_LABELS,
  astOperatorLabel,
  parseActivityCriteriaTreeDetailed,
  type ActivityActionFilter,
  type FilterCriteriaState,
} from '../../lib/filter-builder.js';

/** Подпись отброшенного миграцией условия: «Автор события — не заполнено». */
function describeDroppedActivityCondition(leaf: FilterAstLeaf): string {
  const operand = OPERAND_KIND_LABELS[leaf.entity.kind] ?? leaf.entity.kind;
  return `${operand} — ${astOperatorLabel(leaf.operator)}`;
}

/** Action values shown in the UI filter — the server log carries the same
 *  vocabulary (`created`/`updated`/`deleted`/`trashed`/`restored`). */
export type ActionFilter = ActivityActionFilter;

/** Whitelist of `entity_type` values the user can filter by. Mirrors
 *  `ActivityEntityType` (серверный словарь) for the editor's enum. */
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

/** Критерии отбора «Событий» — общая модель конструктора (профиль «события»). */
export type ActivityFilterState = FilterCriteriaState;

/** Свежий пустой отбор — «вся лента» (дерево — пустая группа И). */
export function createDefaultActivityFilter(): ActivityFilterState {
  return parseActivityCriteriaTreeDetailed({}).state;
}

/** Empty filter — show every row of the log. Только для сравнения в тестах;
 *  экран берёт {@link createDefaultActivityFilter} (свежий объект с деревом). */
export const DEFAULT_FILTER: ActivityFilterState = createDefaultActivityFilter();

/** Parsed persisted L4 `activity_state`. */
export interface PersistedActivityState {
  filter: ActivityFilterState;
  /**
   * Условия прежнего плоского пресета, отброшенные профилем «события» при
   * миграции (потеря, которую лента показывает жёлтой диагностикой футера):
   * например «Автор события — не заполнено».
   */
  dropped: readonly string[];
  offset: number;
  /** Ширина панели отборов (px), заданная сплиттером. */
  panelWidth: number | null;
}

const ENTITY_TYPE_VALUES: ReadonlySet<string> = new Set(ENTITY_TYPE_OPTIONS.map((o) => o.value));
const ACTION_VALUES: ReadonlySet<string> = new Set(ACTIVITY_ACTION_FILTERS);

/**
 * Клиентская валидация словарей ПРЕЖНЕГО плоского пресета: неизвестные типы
 * сущностей и коды действий отбрасываются (AST-снимок уже нормализован).
 */
function cleanLegacyDictionaries(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record['entityTypes']) && !Array.isArray(record['actions'])) return raw;
  const cleaned: Record<string, unknown> = { ...record };
  if (Array.isArray(record['entityTypes'])) {
    cleaned['entityTypes'] = (record['entityTypes'] as unknown[]).filter(
      (v): v is string => typeof v === 'string' && ENTITY_TYPE_VALUES.has(v),
    );
  }
  if (Array.isArray(record['actions'])) {
    cleaned['actions'] = (record['actions'] as unknown[]).filter(
      (v): v is string => typeof v === 'string' && ACTION_VALUES.has(v),
    );
  }
  return cleaned;
}

/**
 * Best-effort parser for the L4 JSON blob (unknown input → defaults).
 * Читает и прежний плоский формат (`fromMs`/`toMs`/`userOp`/`userId`/`userIds`/
 * `entityTypes`/`actions`), и новый — AST-снимок: и то и другое сводится единым
 * конструктором к дереву условий профиля «события».
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
    return { filter: createDefaultActivityFilter(), dropped: [], offset: 0, panelWidth: null };
  }
  const detailed = parseActivityCriteriaTreeDetailed(cleanLegacyDictionaries(parsed.filter ?? {}));
  return {
    filter: detailed.state,
    dropped: detailed.dropped.map(describeDroppedActivityCondition),
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
