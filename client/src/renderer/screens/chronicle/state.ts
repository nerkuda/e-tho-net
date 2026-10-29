/**
 * Pure state helpers of the «Хроника» view (L20): the L4 envelope
 * (`filter` + `offset` + `savedFilterId`) and its parser.
 *
 * Модель критериев, её парсер и её wire-конвертер живут в едином
 * конструкторе `lib/filter-builder.ts` (задача 3742dd59): здесь только
 * форма персиста этой вкладки, поверх общего отбора.
 */

import type { ChronicleFilterDefinition, NetworkProperty } from '@etn/shared';

import {
  buildChronicleWire,
  buildFilterAst,
  defaultChronicleCriteriaState,
  parseChronicleCriteria,
  readFilterDefinitionDetailed,
  type ChronicleCriteriaState,
} from '../../lib/filter-builder.js';

/** Критерии отбора «Хроники» — общая модель конструктора. */
export type ChronicleFilterState = ChronicleCriteriaState;

/** Parsed persisted L4 `chronicle_state` (unknown input, safe defaults). */
export interface PersistedChronicleState {
  filter: ChronicleFilterDefinition;
  savedFilterId: string | null;
  /** Показанный месяц календаря (`chronicle_state.month`), если сохранён. */
  month: { year: number; month: number } | null;
}

/** JSON-объект (не массив и не null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * AST-тело снимка, если оно есть: текущая форма панели — `{ ast, order }`,
 * историческая — AST на верхнем уровне (`{ version, filter }`).
 */
function astBodyOf(def: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof def['version'] === 'number') return def;
  const nested = def['ast'];
  return isRecord(nested) && typeof nested['version'] === 'number' ? nested : null;
}

/**
 * Приводит AST-снимок к канонической форме тем же читателем, что и общий
 * читатель определения: строгий разбор + снятие служебных листьев места
 * применения (`stripServiceLeavesAtRoot`). `null` — снимок не AST-формы.
 *
 * Без этой ветки `parseChronicleCriteria` видит `{ast, order}` как плоское
 * определение (AST распознаётся только на верхнем уровне), дерево теряется, и
 * следующий persist записывает пустой отбор — потеря постоянная (ошибка
 * ad063c2f, L4-восстановление).
 */
function normalizeAstSnapshot(def: Record<string, unknown>): ChronicleFilterDefinition | null {
  const astBody = astBodyOf(def);
  if (astBody === null) return null;
  const read = readFilterDefinitionDetailed(astBody);
  // Нечитаемое AST не нормализуем пустым деревом: сохраняем исходную форму,
  // чтобы снимок не был перезаписан потерей (панель покажет пустой отбор).
  if (read.lost.length > 0) return def as unknown as ChronicleFilterDefinition;
  const normalized = buildFilterAst(read.state, {
    sort: (read.state.sortKeys ?? []).length > 0,
  });
  // `ChronicleFilterDefinition` описывает плоскую форму v1; собственная форма
  // панели `{ ast, order }` приводится к ней так же, как в `chronicleDefinition()`.
  return (astBody === def
    ? normalized
    : { ...def, ast: normalized }) as unknown as ChronicleFilterDefinition;
}

/** Разобрать сохранённый месяц календаря (номер месяца 1..12). */
function parseMonth(value: unknown): { year: number; month: number } | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as { year?: unknown; month?: unknown };
  const year = typeof raw.year === 'number' ? Math.floor(raw.year) : NaN;
  const month = typeof raw.month === 'number' ? Math.floor(raw.month) : NaN;
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * Parses the L4 `chronicle_state` JSON — never throws, falls back to empty.
 *
 * `registry` — реестр свойств сети (с обратными сторонами связей): нормализация
 * wire-определения компилирует условия свойств под-выборки целей, и без реестра
 * они выпадают из снимка ещё до разбора панелью (ошибка ad063c2f). Пустой
 * реестр — прежнее поведение чистого разбора без сети.
 */
export function parseChronicleState(
  raw: string,
  registry: ReadonlyMap<string, NetworkProperty> = new Map(),
): PersistedChronicleState {
  try {
    const parsed = JSON.parse(raw) as Partial<{
      filter: Record<string, unknown>;
      savedFilterId: string | null;
      month: unknown;
    }>;
    const rawFilter: unknown = parsed.filter;
    return {
      // AST-форма читается и нормализуется ДО плоского конвертера: иначе
      // `{ast, order}` разбирается как плоское определение и теряет дерево
      // (ошибка ad063c2f, L4-восстановление «Дневника»).
      filter:
        (isRecord(rawFilter) ? normalizeAstSnapshot(rawFilter) : null) ??
        buildChronicleWire(parseChronicleCriteria(rawFilter ?? {}), registry),
      savedFilterId: typeof parsed.savedFilterId === 'string' ? parsed.savedFilterId : null,
      month: parseMonth(parsed.month),
    };
  } catch {
    return {
      filter: buildChronicleWire(defaultChronicleCriteriaState()),
      savedFilterId: null,
      month: null,
    };
  }
}
