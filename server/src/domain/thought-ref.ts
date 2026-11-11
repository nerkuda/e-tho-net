/**
 * Канон отображения мысли — общий список колонок {@link REF_COLUMNS} и
 * конвертер строки в {@link ThoughtRef}.
 *
 * Вынесен из `thought-service.ts` в НЕЙТРАЛЬНЫЙ модуль (0.15.4, задача
 * 6af1be50, замечание приёмки): резолверу привязок `comment-targets.ts` нужен
 * только этот канон, а импорт `thought-service` замыкал цикл
 * `comment-service → comment-targets → thought-service → comment-service`.
 * Зависимости модуля — типы `@etn/shared` и биты шрифта: ни БД, ни сервисов,
 * поэтому циклов он породить не может.
 *
 * `thought-service` реэкспортирует оба имени — прежние потребители
 * (`query-service`, `structure-service`, `property-service`) не меняются.
 */

import type { IconKind, ThoughtRef } from '@etn/shared';

import {
  FONT_BOLD_BIT,
  FONT_ITALIC_BIT,
  FONT_STRIKE_BIT,
  FONT_UNDERLINE_BIT,
  readFont,
} from './font-style.js';

/**
 * Display columns every thought-ref SELECT must carry (см. `resolveThoughts`).
 *
 * `marked_for_deletion` входит в канон отображения (ошибка 8bbc9542, 0.8.2):
 * без него соседи иерархии «Структур» приезжали клиенту без признака корзины
 * и рисовались обычной строкой, хотя помеченная мысль видна (дефолт
 * `show_trash`). Флаг — такая же часть внешнего вида, как `active`.
 *
 * Живёт рядом с {@link rowToThoughtRef} (0.15.4, задача 6af1be50): константой
 * пользуется нейтральный резолвер привязок `comment-targets.ts`, которому
 * нельзя импортировать `query-service` (тот импортирует `search-service`).
 */
export const REF_COLUMNS =
  't.id, t.title, t.type_id, t.icon, t.icon_kind, t.icon_attachment_id, t.icon_color,' +
  ' t.active, t.marked_for_deletion, t.fg_color, t.bg_color,' +
  ' t.font_bold, t.font_italic, t.font_underline, t.font_strike, t.font_manual';

/**
 * Convert a raw row into a lightweight {@link ThoughtRef}. The row must carry
 * the display columns shared by every `SELECT` that builds refs; reused by
 * other domain modules (e.g. the property usage lookup).
 */
export function rowToThoughtRef(row: {
  id: string;
  title: string;
  type_id: string | null;
  icon: string | null;
  icon_kind: string;
  /** Optional — SELECTs that do not carry the column yield `null`. */
  icon_attachment_id?: string | null;
  /** Optional — SELECTs без колонки отдают `null` (задача 4105bd6a). */
  icon_color?: string | null;
  active: number;
  /** Optional — SELECTs that do not carry the column yield `false` (S13). */
  marked_for_deletion?: number;
  fg_color: string | null;
  bg_color: string | null;
  font_bold: number;
  font_italic: number;
  font_underline: number;
  font_strike: number;
  font_manual: number;
}): ThoughtRef {
  const fm = row.font_manual;
  return {
    id: row.id,
    title: row.title,
    type_id: row.type_id,
    icon: row.icon,
    icon_kind: row.icon_kind as IconKind,
    icon_attachment_id: row.icon_attachment_id ?? null,
    icon_color: row.icon_color ?? null,
    active: row.active === 1,
    marked_for_deletion: row.marked_for_deletion === 1,
    fg_color: row.fg_color,
    bg_color: row.bg_color,
    font_bold: readFont(fm, FONT_BOLD_BIT, row.font_bold),
    font_italic: readFont(fm, FONT_ITALIC_BIT, row.font_italic),
    font_underline: readFont(fm, FONT_UNDERLINE_BIT, row.font_underline),
    font_strike: readFont(fm, FONT_STRIKE_BIT, row.font_strike),
  };
}
