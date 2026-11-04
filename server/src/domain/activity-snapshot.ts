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
  type Publication,
  type Shelf,
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
  return `"${title}"`;
}

/**
 * Snapshot for a thought: `thought without type, "Title"` / `thought of type
 * <type_id>, "Title"`. `type_id` оставляем id'шником — имя типа в снимке
 * задумано не резолвить, чтобы запись оставалась стабильной при
 * удалении/переименовании самого типа.
 */
export function snapshotThought(thought: Pick<Thought, 'title' | 'type_id'>): string {
  const typeClause = thought.type_id === null ? 'without type' : `of type ${thought.type_id}`;
  return `thought ${typeClause}, ${quoteTitle(thought.title)}`;
}

/**
 * Snapshot for a link: `link <source_id> → <target_id>` / `link
 * <source_id> → <target_id> of type <type_id>`. По тем же причинам, что и
 * для мысли, имена сторон не резолвим.
 */
export function snapshotLink(
  link: Pick<Link, 'source_id' | 'target_id' | 'type_id'>,
): string {
  const typeClause = link.type_id === null ? '' : ` of type ${link.type_id}`;
  return `link ${link.source_id} → ${link.target_id}${typeClause}`;
}

/** Snapshot for a thought type: `thought type "name"`. */
export function snapshotThoughtType(type: Pick<ThoughtType, 'name'>): string {
  return `thought type ${quoteTitle(type.name)}`;
}

/** Snapshot for a link type: `link type "name"`. */
export function snapshotLinkType(type: Pick<LinkType, 'name_forward'>): string {
  return `link type ${quoteTitle(type.name_forward)}`;
}

/** Snapshot for a network property: `property "name"`. */
export function snapshotProperty(prop: Pick<NetworkProperty, 'name'>): string {
  return `property ${quoteTitle(prop.name)}`;
}

/**
 * Snapshot for a comment: `comment on <owner_type> "…"`. Сам текст
 * комментария длинный — оставляем первые ~80 символов `body_md` в кавычках,
 * чтобы лента оставалась разборчивой без перехода на полное тело.
 */
export function snapshotComment(
  comment: Pick<Comment, 'owner_type' | 'body_md'>,
): string {
  const previewSource = comment.body_md.trim();
  const preview = previewSource.length > 80 ? `${previewSource.slice(0, 79)}…` : previewSource;
  return `comment on ${comment.owner_type} ${quoteTitle(preview)}`;
}

/**
 * Snapshot for an attachment: `attachment "<title|url|file_path>"`. Подбираем
 * первое непустое «человеческое» поле — заголовок, URL или путь к файлу.
 */
export function snapshotAttachment(att: {
  title?: string | null;
  url?: string | null;
  file_path?: string | null;
}): string {
  const label = (att.title && att.title.trim()) || att.url || att.file_path || '(untitled)';
  return `attachment ${quoteTitle(label)}`;
}

/** Snapshot for a layer: `layer "title"`. Для базы — фиксированный заголовок. */
export function snapshotLayer(layer: Pick<Layer, 'title'>): string {
  return `layer ${quoteTitle(layer.title)}`;
}

/** Snapshot for a publication: `publication "title"` (0.11.1, d4452908). */
export function snapshotPublication(publication: Pick<Publication, 'title'>): string {
  return `publication ${quoteTitle(publication.title)}`;
}

/** Snapshot for a shelf: `shelf "title"` (0.11.1, d4452908). */
export function snapshotShelf(shelf: Pick<Shelf, 'title'>): string {
  return `shelf ${quoteTitle(shelf.title)}`;
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
