/**
 * Классификатор realtime-событий «изменился визуал мысли» (0.16.1, задача
 * 739eb698: облачка связанных мыслей в панелях задач).
 *
 * **Зачем отдельный признак.** Название, иконка, цвета и стиль шрифта мысли не
 * меняют ревизию комментариев-источников задач и не двигают маркер проекции
 * `max_revision`. Значит, обычные события панели (`comment.updated`) молчат, а
 * «Обновить» не зажигается — облачка в строках и в списке «Ещё связанные мысли»
 * оставались прежними. Визуал приезжает в `GET /tasks` (поле `subjects`, канон
 * `ThoughtRef`), поэтому потребителю достаточно тихо перечитать свою выборку.
 *
 * **Штатные события (без новых типов).** Смена визуала — `PATCH` мысли, фасад
 * публикует стандартное `thought.updated` с изменёнными полями в `changes`.
 */

import type { AnyRealtimeEvent } from '@etn/shared';

/** Поля `thought.updated`, которые панель показывает в облачках. */
const VISUAL_FIELDS = [
  'title',
  'icon',
  'icon_kind',
  'icon_attachment_id',
  'icon_color',
  'type_id',
  'fg_color',
  'bg_color',
  'font_bold',
  'font_italic',
  'font_underline',
  'font_strike',
  // Блёклость облачка (`dim`) — тоже визуал: канон страницы отдаёт `active`.
  'active',
] as const;

/**
 * Событие меняет визуал мысли, который панели задач рисуют в облачках.
 * `true` — потребитель перечитывает выборку тихо (дебаунс — на его стороне).
 */
export function isThoughtVisualEvent(event: AnyRealtimeEvent): boolean {
  if (event.type !== 'thought.updated') return false;
  const changes = event.data.changes;
  return VISUAL_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(changes, field));
}
