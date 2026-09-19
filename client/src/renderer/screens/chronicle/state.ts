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
  offset: number;
  savedFilterId: string | null;
}

/** Parses the L4 `chronicle_state` JSON — never throws, falls back to empty. */
export function parseChronicleState(raw: string): PersistedChronicleState {
  try {
    const parsed = JSON.parse(raw) as Partial<{
      filter: Record<string, unknown>;
      offset: number;
      savedFilterId: string | null;
    }>;
    return {
      filter: buildChronicleWire(parseChronicleCriteria(parsed.filter ?? {})),
      offset:
        typeof parsed.offset === 'number' && Number.isFinite(parsed.offset) && parsed.offset >= 0
          ? Math.floor(parsed.offset)
          : 0,
      savedFilterId: typeof parsed.savedFilterId === 'string' ? parsed.savedFilterId : null,
    };
  } catch {
    return {
      filter: buildChronicleWire(defaultChronicleCriteriaState()),
      offset: 0,
      savedFilterId: null,
    };
  }
}
