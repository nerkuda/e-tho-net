/**
 * Pure state helpers of the «Хроника» view (L20): the L4 envelope
 * (`filter` + `offset` + `savedFilterId`) and its parser.
 *
 * Модель критериев, её парсер и её wire-конвертер живут в едином
 * конструкторе `lib/filter-builder.ts` (задача 3742dd59): здесь только
 * форма персиста этой вкладки, поверх общего отбора.
 */

import type { ChronicleFilterDefinition } from '@etn/shared';

import {
  buildChronicleWire,
  defaultChronicleCriteriaState,
  parseChronicleCriteria,
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

/** Разобрать сохранённый месяц календаря (номер месяца 1..12). */
function parseMonth(value: unknown): { year: number; month: number } | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as { year?: unknown; month?: unknown };
  const year = typeof raw.year === 'number' ? Math.floor(raw.year) : NaN;
  const month = typeof raw.month === 'number' ? Math.floor(raw.month) : NaN;
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
}

/** Parses the L4 `chronicle_state` JSON — never throws, falls back to empty. */
export function parseChronicleState(raw: string): PersistedChronicleState {
  try {
    const parsed = JSON.parse(raw) as Partial<{
      filter: Record<string, unknown>;
      savedFilterId: string | null;
      month: unknown;
    }>;
    return {
      filter: buildChronicleWire(parseChronicleCriteria(parsed.filter ?? {})),
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
