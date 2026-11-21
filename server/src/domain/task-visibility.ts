/**
 * Видимость строк проекции задач и содержимого корзины (0.16.1, пачка 11,
 * задача 173e8368).
 *
 * Одно правило на ВСЕ чтения проекции: GET /tasks (+ MCP `tasks.list`), «Связи
 * дня» и маркеры календаря. Раньше SQL-предикат был скопирован в трёх местах с
 * пометкой «те же правила» — любое уточнение видимости чинилось бы трижды (а
 * четвёртый потребитель, лист отбора «Есть задачи», остался бы в стороне).
 *
 * **Правила.**
 *   1. Постоянные комментарии сущности (мысль/связь/публикация), помеченной на
 *      удаление, задач не дают НИКОГДА — решение 2026-11-12 (спека операции
 *      `GET /tasks`: задачи из других записей со ссылкой на такую мысль
 *      возвращаются).
 *   2. При выключенной настройке «показывать содержимое корзины»
 *      (`show_trash = false`, per-user L3) наружу не выходит ЛЮБОЙ контент
 *      корзины: строки записей помеченных владельцев (хроно-записи тоже) и
 *      строки, адресованные помеченной мысли как субъекту (`[[#uuid]]`).
 *      Возврат из корзины возвращает строки — фильтр читается на лету, таблицы
 *      проекции не переписываются (иначе возврат требовал бы пере-парса).
 *
 * Строка проекции адресуется парой (`comment_id`, `line_no`) и слоем:
 * корреляция субъектов повторяет JOIN видимости комментария. `alias`-ы
 * передаются вызывающим: у GET /tasks это `tr`/`v`, у «Связей дня» — `tr`/`c`,
 * у маркеров — `tr`/`v`.
 */

/**
 * Предикат «владелец комментария помечен на удаление» (мысль, связь или
 * публикация). `alias` — псевдоним выборки `comments_v` в запросе.
 */
export function markedOwnerSql(alias: string): string {
  return `((${alias}.owner_type = 'thought' AND EXISTS (
      SELECT 1 FROM thoughts_v o WHERE o.id = ${alias}.owner_id AND o.marked_for_deletion = 1))
    OR (${alias}.owner_type = 'link' AND EXISTS (
      SELECT 1 FROM links_v o WHERE o.id = ${alias}.owner_id AND o.marked_for_deletion = 1))
    OR (${alias}.owner_type = 'publication' AND EXISTS (
      SELECT 1 FROM publications_v o
       WHERE o.id = ${alias}.owner_id AND o.marked_for_deletion = 1)))`;
}

/**
 * Условие видимости контента комментария по настройке корзины: `true` —
 * тождественно истинное `1 = 1` (корзина показывается), `false` — исключение
 * записей помеченных владельцев. Для чтений, у которых нет строк проекции
 * (интервалы записей календаря); условие всегда можно добавить через `AND`.
 */
export function trashContentSql(commentAlias: string, showTrash: boolean): string {
  return showTrash ? '1 = 1' : `NOT ${markedOwnerSql(commentAlias)}`;
}

/**
 * Предикат видимости СТРОКИ проекции задач. `row` — псевдоним `task_rows`,
 * `comment` — выборки `comments_v` с той же редакцией (JOIN вызывающего).
 *
 * Возвращает готовое SQL-условие без параметров (id — ссылки на колонки), его
 * можно добавлять в `WHERE` любого чтения проекции.
 */
export function taskRowVisibilitySql(row: string, comment: string, showTrash: boolean): string {
  const rules = [`NOT (${comment}.kind = 'permanent' AND ${markedOwnerSql(comment)})`];
  if (!showTrash) {
    rules.push(`NOT ${markedOwnerSql(comment)}`);
    // Строка, адресованная помеченной мысли: облачко субъекта — содержимое
    // корзины, в списке ему не место. Строка остаётся задачей живой записи,
    // поэтому при show_trash = true она возвращается.
    rules.push(`NOT EXISTS (
      SELECT 1 FROM task_row_subjects s
        JOIN thoughts_v st ON st.id = s.thought_id
       WHERE s.comment_id = ${row}.comment_id
         AND COALESCE(s.layer_id, '') = COALESCE(${row}.layer_id, '')
         AND s.line_no = ${row}.line_no
         AND st.marked_for_deletion = 1)`);
  }
  return rules.join(' AND ');
}
