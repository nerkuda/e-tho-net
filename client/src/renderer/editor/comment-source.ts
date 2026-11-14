/**
 * Источник комментария для действий над date-чипом (0.16.1, элемент
 * интерфейса c85ca40d «Контекстное меню date-чипа»).
 *
 * Чип в ПРОСМОТРЕ не знает, какому комментарию он принадлежит: HTML собирает
 * единый рендерер, а id источника живёт в потребителе. Здесь — одна точка
 * регистрации этой связи: поле markdown (`editor/markdown-field.ts`)
 * регистрирует корень поля и геттер `getCommentId`, а меню чипа поднимается от
 * клика до `.md-field` и спрашивает id. Для ленты «Дневника» в режиме
 * просмотра роль источника играет карточка записи (`data-row-key`), её id
 * добывает сам меню.
 *
 * Модуль намеренно без зависимостей от поля/меню (только WeakMap): иначе
 * `markdown-field ↔ date-chip-menu` дал бы цикл импортов.
 */

/** Атрибут корня поля markdown — маркер «здесь живёт комментарий». */
export const COMMENT_FIELD_ATTR = 'data-etn-comment-field';

/** Источник комментария: текущий id (постоянного может ещё не быть — `null`). */
export interface CommentSource {
  /** id комментария в сети или `null`, если он ещё не создан. */
  getCommentId(): string | null;
}

/** Реестр полей: корень поля → источник комментария (слабые ссылки на DOM). */
const fieldSources = new WeakMap<HTMLElement, CommentSource>();

/** Зарегистрировать поле markdown как источник комментария. */
export function registerCommentField(root: HTMLElement, source: CommentSource): void {
  root.setAttribute(COMMENT_FIELD_ATTR, '1');
  fieldSources.set(root, source);
}

/** Источник комментария поля по корню поля или `null`. */
export function commentSourceForField(root: HTMLElement | null): CommentSource | null {
  if (root === null) return null;
  return fieldSources.get(root) ?? null;
}
