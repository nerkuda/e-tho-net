/**
 * Чистая логика инкрементального применения realtime-событий к ленте
 * «Дневника» (задача afcfb144, уровень 3 тех.проекта `1d48df6d`
 * «Инкрементальное обновление списков UI»).
 *
 * Модуль не знает ни DOM, ни сети: классифицирует хроно-события
 * (`comment.created/updated/deleted`), сливает частичные изменения в строку
 * ленты и решает, остаётся ли запись в текущем периоде. Сборку строки с
 * привязками (точечный доар мыслей) и сам reconcile делает экран
 * `chronicle.ts`.
 */

import type { ChronicleRow, Comment, CommentTarget } from '@etn/shared';

import { rowDays } from './diary.js';

/**
 * Критерии отбора ленты, от которых зависит применимость события точечно.
 * Дневник отбирает записи по периоду и порядку — если заданы дополнительные
 * критерии (текст, критерии целей, автор), новую/изменённую запись нельзя
 * уверенно признать входящей в отбор без сервера → полный перезапрос.
 */
export interface ChronicleCriteriaSnapshot {
  /** Текстовый критерий панели (по телу/заголовку записи и мыслям целей). */
  keywords: string;
  /** Заданы ли критерии целей записи (группа `targets`). */
  hasTargetCriteria: boolean;
  /** Заданы ли условия автора/редактора записи. */
  hasAuthorCriteria: boolean;
}

/** Можно ли применять хроно-события к ленте точечно (отбор — только период/порядок). */
export function chronicleAllowsIncremental(criteria: ChronicleCriteriaSnapshot): boolean {
  return (
    criteria.keywords.trim() === '' &&
    !criteria.hasTargetCriteria &&
    !criteria.hasAuthorCriteria
  );
}

/**
 * Может ли хроно-запись появиться в ленте «Дневника»: серверный отбор ленты
 * (пустой по мыслям) берёт все хронологические записи, у которых есть ХОТЯ БЫ
 * ОДНА привязка (`anyAttachmentCond`: мысль или связь). Запись без привязок в
 * ленту не попадает.
 */
export function hasDiaryAttachment(targets: readonly CommentTarget[]): boolean {
  return targets.length > 0;
}

/**
 * Слить частичные изменения комментария (`comment.updated`) в строку ленты.
 * Привязки (`targets`) и доар `body_html` выполняет вызывающий — здесь только
 * скалярные поля строки.
 */
export function mergeCommentChanges(row: ChronicleRow, changes: Partial<Comment>): ChronicleRow {
  const next: ChronicleRow = { ...row };
  if (changes.title !== undefined) next.title = changes.title;
  if (changes.body_html !== undefined) next.body_html = changes.body_html;
  if (changes.valid_from !== undefined) next.valid_from = changes.valid_from;
  if (changes.valid_to !== undefined) next.valid_to = changes.valid_to;
  if (changes.use_time !== undefined) next.use_time = changes.use_time === true;
  if (changes.version !== undefined) next.version = changes.version;
  if (changes.updated_at !== undefined) next.updated_at = changes.updated_at;
  if (changes.updated_by !== undefined) next.updated_by = changes.updated_by;
  return next;
}

/**
 * Остаётся ли запись в текущем периоде ленты: её дни пересекают `[from, to]`
 * (границы — локальные сутки; длительность записи учитывается, требование
 * e0970b70). Правка/создание вне периода строку в ленте не показывает.
 */
export function rowVisibleInPeriod(row: ChronicleRow, from: string, to: string): boolean {
  return rowDays(row, from, to).length > 0;
}

/**
 * Требует ли `comment.updated` полного перезапроса при заданных
 * дополнительных критериях: изменение текста/заголовка может вывести запись
 * из отбора по ключевым словам, а смена привязок — из критериев целей.
 * Скалярные поля (даты, служебные) точечно безопасны.
 */
export function commentUpdateNeedsReload(
  changes: Partial<Comment>,
  criteria: ChronicleCriteriaSnapshot,
): boolean {
  if (chronicleAllowsIncremental(criteria)) return false;
  if (
    changes.body_md !== undefined ||
    changes.body_html !== undefined ||
    changes.title !== undefined ||
    changes.targets !== undefined
  ) {
    return true;
  }
  return false;
}
