/**
 * Исполнение рецепта заголовков публикации (0.11.1, задача e754527d).
 *
 * Рецепт — тот же формат, что у панели «Структуры мыслей» (`SavedFilterDefinition`),
 * поэтому отбор исполняется существующим движком выборки
 * (`parseStructureFilter` + `structureRequestToQuery` + `queryThoughtIds`);
 * локальных реализаций SQL-отбора здесь нет.
 *
 * Модуль выделен из `publication-assembly-service.ts`, чтобы им могли
 * пользоваться обе стороны домена без циклической зависимости: сборка
 * (кандидаты/использование) и CRUD публикаций (срез принятого состояния —
 * создание, сохранение порядка). Зависит только от движка выборки.
 */

import {
  EtnError,
  type SavedFilterDefinition,
  type SortOrder,
  type StructureFilter,
  type StructureSort,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { queryThoughtIds, structureRequestToQuery } from './query-service.js';
import { parseStructureFilter } from './structure-service.js';

/**
 * Потолок числа разделов, извлекаемых из рецепта за одну сборку. Защита от
 * неограниченного отбора; превышение — предупреждение в `warnings`, а не
 * ошибка (требование 6e8bc3f0: усечение, не отказ).
 */
export const PUBLICATION_RECIPE_MAX_NODES = 20000;

/**
 * Размер страницы keyset-обхода рецепта (внутренняя деталь исполнения; не
 * связан с постраничной выдачей сборки `PUBLICATION_ASSEMBLY_PAGE_SIZE`).
 */
const RECIPE_PAGE_SIZE = 20;

/** Валидный `StructureSort` или `null`. */
function asStructureSort(value: unknown): StructureSort | null {
  return value === 'alpha' || value === 'created' || value === 'viewed' || value === 'updated'
    ? value
    : null;
}

/** Валидный `SortOrder` или `null`. */
function asSortOrder(value: unknown): SortOrder | null {
  return value === 'asc' || value === 'desc' ? value : null;
}

/**
 * Исполнить рецепт заголовков существующим движком выборки и вернуть id всех
 * совпавших мыслей в детерминированном порядке. Пагинация — keyset-курсором
 * (единый движок), с потолком {@link PUBLICATION_RECIPE_MAX_NODES}.
 */
export function selectRecipeIds(
  ndb: NetworkDb,
  userId: string,
  recipe: SavedFilterDefinition,
  warnings: string[],
): string[] {
  const raw = recipe as unknown as Record<string, unknown>;
  let filter: StructureFilter;
  try {
    filter = parseStructureFilter(raw);
  } catch (err) {
    if (err instanceof EtnError) {
      warnings.push(`рецепт заголовков не исполнен: ${err.message}`);
      return [];
    }
    throw err;
  }
  const sort = asStructureSort(raw['sort']) ?? 'alpha';
  const order = asSortOrder(raw['order']) ?? 'asc';

  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const query = structureRequestToQuery({
      ...filter,
      sort,
      order,
      limit: RECIPE_PAGE_SIZE,
      offset: 0,
      cursor,
    });
    const page = queryThoughtIds(ndb, userId, query, {
      emptyFilterMode: 'all',
      maxLimit: RECIPE_PAGE_SIZE,
    });
    ids.push(...page.ids);
    if (!page.has_more || page.next_cursor === null) break;
    cursor = page.next_cursor;
    if (ids.length >= PUBLICATION_RECIPE_MAX_NODES) {
      warnings.push('отбор заголовков усечён по потолку узлов сборки');
      break;
    }
  }
  return ids;
}
