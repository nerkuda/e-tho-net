/**
 * Pure state helpers of the «Хроника» view (L20): the filter criteria shape,
 * the saved-filter/L4 serialization and the persisted-state parser.
 *
 * No DOM/no IPC imports — unit-testable under plain Node (like
 * `structures/layout.ts`).
 */

import type { ChronicleFilterDefinition } from '@etn/shared';

/** Criteria of the chronicle filter as held by the panel (persisted to L4). */
export interface ChronicleFilterState {
  keywords: string;
  /** Root thoughts of the «мысли» field (titles resolved live into chips). */
  thoughtIds: string[];
  includeSubtree: boolean;
  typeIds: string[];
  linkTypeIds: string[];
  linkScope: 'sources' | 'targets' | 'both';
  dateFrom: string;
  dateTo: string;
  order: 'asc' | 'desc';
}

/** The empty filter (all thoughts of the network). */
export const DEFAULT_FILTER: ChronicleFilterState = {
  keywords: '',
  thoughtIds: [],
  includeSubtree: false,
  typeIds: [],
  linkTypeIds: [],
  linkScope: 'both',
  dateFrom: '',
  dateTo: '',
  order: 'asc',
};

/** Serializes the criteria into a chronicle filter definition (save/L4/query). */
export function toDefinition(state: ChronicleFilterState): ChronicleFilterDefinition {
  return {
    ...(state.keywords.trim() !== '' ? { keywords: state.keywords } : {}),
    ...(state.thoughtIds.length > 0 ? { thought_ids: [...state.thoughtIds] } : {}),
    ...(state.includeSubtree ? { include_subtree: true } : {}),
    ...(state.typeIds.length > 0 ? { type_ids: [...state.typeIds] } : {}),
    ...(state.linkTypeIds.length > 0 ? { link_type_ids: [...state.linkTypeIds] } : {}),
    link_scope: state.linkScope,
    ...(state.dateFrom !== '' ? { date_from: state.dateFrom } : {}),
    ...(state.dateTo !== '' ? { date_to: state.dateTo } : {}),
    order: state.order,
  };
}

/** Parses a saved-filter definition back into panel state (safe defaults). */
export function fromDefinition(definition: Partial<ChronicleFilterDefinition>): ChronicleFilterState {
  return {
    keywords: definition.keywords ?? '',
    thoughtIds: definition.thought_ids ?? [],
    includeSubtree: definition.include_subtree === true,
    typeIds: definition.type_ids ?? [],
    linkTypeIds: definition.link_type_ids ?? [],
    linkScope: definition.link_scope ?? 'both',
    dateFrom: definition.date_from ?? '',
    dateTo: definition.date_to ?? '',
    order: definition.order ?? 'asc',
  };
}

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
      filter: toDefinition(fromDefinition(parsed.filter ?? {})),
      offset:
        typeof parsed.offset === 'number' && Number.isFinite(parsed.offset) && parsed.offset >= 0
          ? Math.floor(parsed.offset)
          : 0,
      savedFilterId: typeof parsed.savedFilterId === 'string' ? parsed.savedFilterId : null,
    };
  } catch {
    return { filter: toDefinition(fromDefinition({})), offset: 0, savedFilterId: null };
  }
}
