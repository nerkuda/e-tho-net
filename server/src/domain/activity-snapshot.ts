/**
 * Snapshot helpers for the activity log (задача f2eca5a4, требование b0c7a57c
 * «activity_log — состав записи»).
 *
 * На каждую операцию изменения сущности сервер пишет в `activity_log` строку
 * с коротким описанием сущности на момент события (`entity_title`, лимит 256).
 * Эти функции собирают строку из уже знакомых роуту DTO — без чтения из БД —
 * чтобы вызов `recordActivity(...)` оставался дешёвым и не делал лишних
 * round-trip'ов к `data.db`.
 *
 * Снимок обрезается до {@link ACTIVITY_TITLE_MAX} символов с многоточием «…»;
 * `entity_title` нужен ленте, чтобы запись оставалась читаемой после
 * удаления самой сущности.
 */

import {
  ACTIVITY_TITLE_MAX,
  type ActivityEntityType,
  type Comment,
  type Layer,
  type Link,
  type LinkType,
  type NetworkProperty,
  type Thought,
  type ThoughtType,
} from '@etn/shared';

/**
 * Обрезать строку до {@link ACTIVITY_TITLE_MAX} с многоточием «…».
 * Многоточие — один Unicode-символ, чтобы счётчик байтов оставался
 * предсказуемым (для ширины 256 — 1 символ многоточия + 255 видимых).
 */
export function truncateTitle(value: string): string {
  if (value.length <= ACTIVITY_TITLE_MAX) {
    return value;
  }
  return `${value.slice(0, ACTIVITY_TITLE_MAX - 1)}…`;
}

/** Quote a single thought title for inclusion in a snapshot. */
function quoteTitle(title: string): string {
  return `«${title}»`;
}

/**
 * Snapshot for a thought: «мысль без типа, "Название"» / «мысль типа
 * `<type_id>`, "Название"». `type_id` оставляем id'шником — имя типа в
 * снимке задумано не резолвить, чтобы запись оставалась стабильной при
 * удалении/переименовании самого типа.
 */
export function snapshotThought(thought: Pick<Thought, 'title' | 'type_id'>): string {
  const typeClause = thought.type_id === null ? 'без типа' : `типа ${thought.type_id}`;
  return `мысль ${typeClause}, ${quoteTitle(thought.title)}`;
}

/**
 * Snapshot for a link: «связь <source_id> → <target_id>» / «связь
 * <source_id> → <target_id> типа <type_id>». По тем же причинам, что и
 * для мысли, имена сторон не резолвим.
 */
export function snapshotLink(
  link: Pick<Link, 'source_id' | 'target_id' | 'type_id'>,
): string {
  const typeClause = link.type_id === null ? '' : ` типа ${link.type_id}`;
  return `связь ${link.source_id} → ${link.target_id}${typeClause}`;
}

/** Snapshot for a thought type: «тип мысли "<name>"». */
export function snapshotThoughtType(type: Pick<ThoughtType, 'name'>): string {
  return `тип мысли ${quoteTitle(type.name)}`;
}

/** Snapshot for a link type: «тип связи "<name>"». */
export function snapshotLinkType(type: Pick<LinkType, 'name_forward'>): string {
  return `тип связи ${quoteTitle(type.name_forward)}`;
}

/** Snapshot for a network property: «свойство "<name>"». */
export function snapshotProperty(prop: Pick<NetworkProperty, 'name'>): string {
  return `свойство ${quoteTitle(prop.name)}`;
}

/**
 * Snapshot for a comment: «комментарий к <owner_type> "<…>"». Сам текст
 * комментария длинный — оставляем первые ~80 символов `body_md` в кавычках,
 * чтобы лента оставалась разборчивой без перехода на полное тело.
 */
export function snapshotComment(
  comment: Pick<Comment, 'owner_type' | 'body_md'>,
): string {
  const previewSource = comment.body_md.trim();
  const preview = previewSource.length > 80 ? `${previewSource.slice(0, 79)}…` : previewSource;
  return `комментарий к ${comment.owner_type} ${quoteTitle(preview)}`;
}

/**
 * Snapshot for an attachment: «вложение "<title|url|file_path>"». Подбираем
 * первое непустое «человеческое» поле — заголовок, URL или путь к файлу.
 */
export function snapshotAttachment(att: {
  title?: string | null;
  url?: string | null;
  file_path?: string | null;
}): string {
  const label = (att.title && att.title.trim()) || att.url || att.file_path || '(без названия)';
  return `вложение ${quoteTitle(label)}`;
}

/** Snapshot for a layer: «слой "<title>"». Для базы — фиксированный заголовок. */
export function snapshotLayer(layer: Pick<Layer, 'title'>): string {
  return `слой ${quoteTitle(layer.title)}`;
}

/**
 * Format a snapshot for an already-removed entity whose title needs to come
 * from a snapshot rather than from a live row — например, удалённая
 * мысль в `thought.deleted`. Используется в местах, где DTO уже нет
 * (помечено на удаление → удалено физически).
 */
export function formatBareSnapshot(entityType: ActivityEntityType, title: string): string {
  return `${entityType} ${quoteTitle(title)}`;
}
