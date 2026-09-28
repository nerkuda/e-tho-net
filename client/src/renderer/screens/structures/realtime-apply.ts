/**
 * Чистая логика инкрементального применения realtime-событий к снимку экрана
 * «Структуры мыслей» (задача afcfb144, уровень 3 тех.проекта `1d48df6d`
 * «Инкрементальное обновление списков UI»).
 *
 * Модуль не знает ни DOM, ни сети: он классифицирует событие («применить
 * точечно» либо «уйти в полный путь») и меняет переданные ему коллекции
 * снимка — `refs`/`resultIds`/`directions`/`hierarchy`/`edges` экрана
 * `structures.ts`. Так логика покрыта юнит-тестами, а экран остаётся тонкой
 * проводкой.
 *
 * Таблица «событие → действие» и границы fallback — в постоянном комментарии
 * `structures.ts` (единая точка правды для режима realtime).
 */

import type {
  FocusEdge,
  LinkUpdateInput,
  StructureSort,
  ThoughtRef,
  ThoughtUpdateInput,
} from '@etn/shared';

/** Направления связей мысли (наполненность эллипсов дерева). */
export interface StructureDirections {
  has_incoming: boolean;
  has_outgoing: boolean;
}

/** Накопленная страница соседей раскрытого узла направления. */
export interface StructureHierarchyEntry {
  neighbors: ThoughtRef[];
  hasMore: boolean;
}

/** Коллекции снимка «Структур», которые правит realtime-путь. */
export interface StructuresState {
  /** Метаданные видимых мыслей (корни + раскрытые соседи). */
  refs: Map<string, ThoughtRef>;
  /** Активные связи среди видимых мыслей (для линий). */
  edges: Map<string, FocusEdge>;
  /** Мысли-корни текущей страницы отбора. */
  resultIds: string[];
  /** Направления (наполненность эллипсов) по мысли. */
  directions: Map<string, StructureDirections>;
  /** Кэш раскрытых уровней `${nodeKey}|${dir}`. */
  hierarchy: Map<string, StructureHierarchyEntry>;
}

/**
 * Критерии отбора, от которых зависит, выведет ли правка сущность из текущего
 * отбора (тогда — полный путь) или её можно применить к строке точечно.
 */
export interface StructuresCriteriaSnapshot {
  sort: StructureSort;
  keywords: string;
  typeIds: readonly string[];
  showInactive: boolean;
  showTrash: boolean;
}

/**
 * Требует ли `thought.updated` полного перезапроса страницы. Полный путь нужен,
 * когда правка меняет СОСТАВ отбора или ПОРЯДОК строк, а не только оформление:
 *  - заголовок при сортировке по алфавиту;
 *  - синонимы при активном текстовом отборе (область «синонимы»);
 *  - тип мысли при отборе по типам;
 *  - актуальность/корзина, когда неактивные/помеченные скрыты настройкой.
 */
export function thoughtChangeNeedsReload(
  changes: ThoughtUpdateInput,
  criteria: StructuresCriteriaSnapshot,
): boolean {
  if (changes.title !== undefined && criteria.sort === 'alpha') return true;
  if (changes.synonyms !== undefined && criteria.keywords.trim() !== '') return true;
  if (changes.type_id !== undefined && criteria.typeIds.length > 0) return true;
  if (changes.active !== undefined && !criteria.showInactive) return true;
  if (changes.marked_for_deletion !== undefined && !criteria.showTrash) return true;
  return false;
}

/**
 * Требует ли `link.updated` полного перезапроса. Смена концов (направления)
 * меняет структуру видимого графа, а `active` — само наличие линии в выборке
 * `edges`; такие правки идём полным путём. Цвет/стиль/ширина/метка корзины —
 * оформление уже нарисованного ребра, применяются точечно.
 */
export function linkChangeNeedsReload(changes: LinkUpdateInput): boolean {
  return (
    changes.source_id !== undefined ||
    changes.target_id !== undefined ||
    changes.active !== undefined
  );
}

/** Обновлённая `ThoughtRef` из частичных изменений (`updated`-событие). */
export function applyThoughtChanges(ref: ThoughtRef, changes: ThoughtUpdateInput): ThoughtRef {
  const next: ThoughtRef = { ...ref };
  if (changes.title !== undefined) next.title = changes.title;
  if (changes.type_id !== undefined) next.type_id = changes.type_id;
  if (changes.icon !== undefined) next.icon = changes.icon;
  if (changes.icon_kind !== undefined) next.icon_kind = changes.icon_kind;
  if (changes.icon_attachment_id !== undefined) {
    next.icon_attachment_id = changes.icon_attachment_id;
  }
  if (changes.active !== undefined) next.active = changes.active;
  if (changes.marked_for_deletion !== undefined) {
    next.marked_for_deletion = changes.marked_for_deletion;
  }
  if (changes.fg_color !== undefined) next.fg_color = changes.fg_color;
  if (changes.bg_color !== undefined) next.bg_color = changes.bg_color;
  if (changes.font_bold !== undefined) next.font_bold = changes.font_bold;
  if (changes.font_italic !== undefined) next.font_italic = changes.font_italic;
  if (changes.font_underline !== undefined) next.font_underline = changes.font_underline;
  if (changes.font_strike !== undefined) next.font_strike = changes.font_strike;
  return next;
}

/** Обновлённое ребро из частичных изменений (`link.updated`, оформление). */
export function applyLinkChanges(edge: FocusEdge, changes: LinkUpdateInput): FocusEdge {
  const next: FocusEdge = { ...edge };
  if (changes.type_id !== undefined) next.type_id = changes.type_id;
  if (changes.color !== undefined) next.color = changes.color;
  if (changes.style !== undefined) next.style = changes.style;
  if (changes.width !== undefined) next.width = changes.width;
  if (changes.marked_for_deletion !== undefined) {
    next.link_marked_for_deletion = changes.marked_for_deletion;
  }
  return next;
}

/** Точечно обновить `ThoughtRef` в снимке. `false` — мысли нет среди видимых. */
export function applyThoughtUpdateToState(
  state: StructuresState,
  id: string,
  changes: ThoughtUpdateInput,
): boolean {
  const ref = state.refs.get(id);
  if (ref === undefined) return false;
  state.refs.set(id, applyThoughtChanges(ref, changes));
  return true;
}

/** Точечно обновить ребро в снимке. `false` — ребра нет среди нарисованных. */
export function applyLinkUpdateToState(
  state: StructuresState,
  id: string,
  changes: LinkUpdateInput,
): boolean {
  const edge = state.edges.get(id);
  if (edge === undefined) return false;
  state.edges.set(id, applyLinkChanges(edge, changes));
  return true;
}

/** Убрать ребро из снимка; `true`, если оно было. */
export function removeLinkFromState(state: StructuresState, id: string): boolean {
  return state.edges.delete(id);
}

/**
 * Убрать мысль из снимка (событие `thought.deleted`): из корней страницы,
 * метаданных, направлений, страниц соседей и линий. `resultIds` правится
 * НА МЕСТЕ — вызывающий держит ту же ссылку массива. Возвращает `true`, если
 * хоть что-то изменилось (значит, нужен один reconcile списка).
 */
export function removeThoughtFromState(state: StructuresState, id: string): boolean {
  let changed = false;

  const kept = state.resultIds.filter((x) => x !== id);
  if (kept.length !== state.resultIds.length) {
    state.resultIds.length = 0;
    state.resultIds.push(...kept);
    changed = true;
  }
  if (state.refs.delete(id)) changed = true;
  if (state.directions.delete(id)) changed = true;

  for (const [key, entry] of state.hierarchy) {
    const filtered = entry.neighbors.filter((n) => n.id !== id);
    if (filtered.length !== entry.neighbors.length) {
      state.hierarchy.set(key, { ...entry, neighbors: filtered });
      changed = true;
    }
  }

  for (const [edgeId, edge] of state.edges) {
    if (edge.source_id === id || edge.target_id === id) {
      state.edges.delete(edgeId);
      changed = true;
    }
  }

  return changed;
}

/**
 * Подпись строки дерева для keyed-сверки: то, что видно в строке и НЕ входит в
 * сам `TreeRow` (метаданные мысли, наполненность эллипсов, раскрытость узла).
 * Совпала — строку не трогаем (identity, прокрутка, hover); изменилась —
 * сверка зовёт `update` одной строки.
 */
export function rowRenderSignature(
  ref: ThoughtRef | undefined,
  dir: StructureDirections | undefined,
  expansion: Partial<Record<'parents' | 'children', boolean>> | undefined,
): string {
  const r =
    ref === undefined
      ? '∅'
      : [
          ref.title,
          ref.active ? 1 : 0,
          ref.type_id ?? '',
          ref.icon ?? '',
          ref.icon_kind,
          ref.icon_attachment_id ?? '',
          ref.marked_for_deletion ? 1 : 0,
          ref.fg_color ?? '',
          ref.bg_color ?? '',
          ref.font_bold === null ? '' : ref.font_bold ? 1 : 0,
          ref.font_italic === null ? '' : ref.font_italic ? 1 : 0,
          ref.font_underline === null ? '' : ref.font_underline ? 1 : 0,
          ref.font_strike === null ? '' : ref.font_strike ? 1 : 0,
        ].join('\u0001');
  const d = dir === undefined ? '' : `${dir.has_incoming ? 1 : 0}${dir.has_outgoing ? 1 : 0}`;
  const e =
    expansion === undefined
      ? ''
      : `${expansion.parents === true ? 1 : 0}${expansion.children === true ? 1 : 0}`;
  return `${r}\u0002${d}\u0002${e}`;
}
