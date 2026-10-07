/**
 * Резолвер позиции источника для ленты публикаций (задача 59774016).
 *
 * Тексты ленты собирает серверный `renderPublicationFragment` с включённой
 * разметкой позиций: его `body_html` несёт `data-md-*`-атрибуты относительно
 * `body_md` (тот же механизм, что у `sourceMap` единого рендерера). Двойной
 * клик по слову даёт обычное DOM-выделение; этот модуль переводит его в
 * диапазон исходника общим резолвером `sourceOffsetFromCaret` — поэтому позиция
 * попадает ИМЕННО во вхождение слова под кликом, а не в первое вхождение
 * (ошибка прежнего поведения: ориентир — текст выделенного слова).
 *
 * Модуль чистый (без побочных эффектов): принимает минимальный структурный вид
 * выделения, поэтому тестируется подменой узлов без DOM.
 */

import { sourceOffsetFromCaret, type SourceMapNode } from '@etn/markdown';

/** Диапазон исходника markdown (`body_md`): `anchor` — начало, `head` — конец. */
export interface FeedSourceSelection {
  anchor: number;
  head: number;
}

/**
 * Минимальный структурный вид DOM-выделения, которого достаточно резолверу.
 * Реальный `Selection` подходит (узлы приводятся к {@link SourceMapNode}).
 */
export interface DomSelectionLike {
  readonly isCollapsed?: boolean;
  readonly rangeCount?: number;
  readonly anchorNode: SourceMapNode | null;
  readonly anchorOffset: number;
  readonly focusNode: SourceMapNode | null;
  readonly focusOffset: number;
}

/**
 * Диапазон исходника по DOM-выделению ленты или `null`, если позиция
 * нерезолвима (выделения нет либо у узлов нет разметки позиций). Концы
 * нормализуются: результат всегда `anchor <= head`.
 */
export function feedSelectionFromDom(
  selection: DomSelectionLike | null,
): FeedSourceSelection | null {
  if (selection === null || selection.isCollapsed === true) return null;
  if (selection.rangeCount === 0) return null;
  const anchor = sourceOffsetFromCaret(selection.anchorNode, selection.anchorOffset);
  const head = sourceOffsetFromCaret(selection.focusNode, selection.focusOffset);
  if (anchor === null || head === null) return null;
  return anchor <= head ? { anchor, head } : { anchor: head, head: anchor };
}
