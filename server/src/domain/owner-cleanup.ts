/**
 * Cascade cleanup of polymorphic dependants — and, since S2, of every table
 * that used to reach a deleted thought through an SQL FK — when their owner
 * disappears (docs/03-server-api.md §6.5, §7.1, §10.1, §11;
 * docs/02-data-model.md §3.5, §3.8, §3.9, §3.10, §3.13).
 *
 * `comments`, `attachments` and `property_values` reference their owner as a
 * polymorphic `(owner_type, owner_id)` pair **without an SQL FK**, so neither
 * SQLite cascades nor a plain `DELETE` of the owner touches them. They must be
 * purged explicitly, in the same transaction, or they stay behind as orphans:
 *
 *   * `DELETE /links/{id}` used to leave the link's attachments and property
 *     values behind (comments were fixed in L20);
 *   * `DELETE /thoughts/{id}` cascades the incident `links` rows silently, so
 *     the comments/attachments/property values owned by those links need the
 *     same treatment as the thought's own ones.
 *
 * Additionally, since S2 removed the SQL FKs from `links`,
 * `thought_synonyms` and the per-user tables to `thoughts` (the logical id is
 * no longer unique, docs/13-layers.md §3), the former FK cascades of a thought
 * deletion run explicitly here as well ({@link purgeThoughtDeletionDependants}).
 *
 * Since S4 there are two flavours of the same cascade:
 *
 *   * **physical** (`purge*`, base-layer context) — the former behaviour: rows
 *     of every layer are deleted outright together with the owner;
 *   * **tombstone** (`tombstone*`, a non-base layer context,
 *     docs/13-layers.md §5.2) — deletion in a layer materialises tombstones for
 *     every *visible* dependent row in that layer: incident links (both ends),
 *     comments, attachments, property values, synonyms and comment targets.
 *     Children are NOT deleted — the cascade hits link rows, not child
 *     thoughts. Server-stored attachment files are never touched here (§5.3).
 *
 * **Attachments are multi-owned since 0.12.1** (ADR 9f90b010): ownership lives
 * in the branchable `attachment_owners` table (one row per (attachment, object)),
 * `attachments.owner_type/owner_id` are a merely approximate mirror that is
 * never trusted here. Deleting an owner therefore removes only ITS ownership
 * rows; the attachment row and its server file go away solely when the last
 * live ownership disappears *anywhere* (working layers only — service/reserve
 * layers do not count, `hasLiveOwnershipAnywhere`, error 1d0620a8). Attachments
 * owned by other objects — and their files — are left untouched.
 *
 * Server-stored attachment files (`networks/<nid>/attachments/`) are removed
 * from disk as well; client-local file paths are never touched.
 */

import { type AttachmentKind } from '@etn/shared';

import path from 'node:path';

import type { NetworkDb } from '../db/network-db.js';
import { materializeTombstone } from '../db/layer-write.js';
import { hasLiveOwnershipAnywhere, removeStoredFile, storedFileInUse } from './attachment-service.js';

/** Polymorphic owner of comments/attachments/property values. */
type OwnerType = 'thought' | 'link';

/**
 * Owner type whose attachment ownerships are purged by
 * {@link purgeOwnerAttachments}. Wider than {@link OwnerType}: publications own
 * attachments (covers) although they do not keep comments/property values in
 * the very same tables.
 */
export type AttachmentPurgeOwnerType = 'thought' | 'link' | 'publication';

/**
 * SQLite's bind-parameter cap is far above this; chunking keeps the `IN (…)`
 * lists bounded regardless of how many owners (e.g. incident links of a hub
 * thought) are passed in.
 */
const OWNER_CHUNK_SIZE = 500;

/**
 * Purge every polymorphic dependant of the given owners: comments primarily
 * owned by them (together with all their m2m targets), target rows pointing at
 * them (secondary attachments are detached, L20 §10.1), attachments (rows,
 * dangling `icon_attachment_id` references and server-stored files) and
 * property values. No-op for an empty list.
 */
export function purgeOwnerDependants(
  ndb: NetworkDb,
  ownerType: OwnerType,
  ownerIds: string[],
): void {
  for (let i = 0; i < ownerIds.length; i += OWNER_CHUNK_SIZE) {
    purgeChunk(ndb, ownerType, ownerIds.slice(i, i + OWNER_CHUNK_SIZE));
  }
}

/**
 * Purge everything removed together with a thought deletion: the thought's
 * polymorphic dependants **and** those of its incident links, then — since S2,
 * when the SQL FKs to `thoughts` were dropped — the former FK cascades
 * themselves: the incident `links` rows, the thought's synonyms and the
 * per-user state pointing at it (views, focus preferences/order, pins, read
 * metrics).
 */
export function purgeThoughtDeletionDependants(ndb: NetworkDb, thoughtId: string): void {
  // layers:physical-read — физический каскад удаляет строки ВО ВСЕХ слоях, поэтому и собирает инцидентные связи по физической таблице (13-layers.md §3.1.2).
  const linkIds = (
    ndb
      .prepare('SELECT id FROM links WHERE source_id = ? OR target_id = ?') // layers:physical-read
      .all(thoughtId, thoughtId) as { id: string }[]
  ).map((row) => row.id);
  purgeOwnerDependants(ndb, 'link', linkIds);
  purgeOwnerDependants(ndb, 'thought', [thoughtId]);

  // Former FK cascades (docs/13-layers.md §3): `thoughts.id` is no longer a
  // unique parent key, so these tables have no SQL FK any more and the app
  // owns the cleanup.
  ndb.prepare('DELETE FROM links WHERE source_id = ? OR target_id = ?').run(thoughtId, thoughtId);
  ndb.prepare('DELETE FROM thought_synonyms WHERE thought_id = ?').run(thoughtId);
  ndb.prepare('DELETE FROM thought_views WHERE thought_id = ?').run(thoughtId);
  ndb.prepare('DELETE FROM user_focus_preferences WHERE focus_thought_id = ?').run(thoughtId);
  ndb
    .prepare('DELETE FROM user_focus_order WHERE focus_thought_id = ? OR thought_id = ?')
    .run(thoughtId, thoughtId);
  ndb.prepare('DELETE FROM user_pinned_thoughts WHERE thought_id = ?').run(thoughtId);
  ndb.prepare('DELETE FROM thought_read_metrics WHERE thought_id = ?').run(thoughtId);
}

// ---------------------------------------------------------------------------
// Tombstone cascade (a layer context, 13-layers.md §5.2)
// ---------------------------------------------------------------------------

/**
 * Надгробия на все видимые зависимые строки владельцев в текущем слое:
 * комментарии (вместе с их привязками `comment_targets`), вторичные привязки
 * комментариев к владельцу, вложения (только строки — физический файл общий
 * для всех слоёв, §5.3) и значения свойств. Для владельца-мысли — ещё и её
 * видимые синонимы. No-op для пустого списка; чтения — только через
 * представления `*_v` (надгробие нужно ставить лишь строкам, которые слой
 * сейчас показывает).
 */
export function tombstoneOwnerDependants(ndb: NetworkDb, ownerType: OwnerType, ownerIds: string[]): void {
  for (let i = 0; i < ownerIds.length; i += OWNER_CHUNK_SIZE) {
    tombstoneChunk(ndb, ownerType, ownerIds.slice(i, i + OWNER_CHUNK_SIZE));
  }
}

/** Single-chunk tombstone sweep; `ownerIds` must be non-empty and ≤ OWNER_CHUNK_SIZE. */
function tombstoneChunk(ndb: NetworkDb, ownerType: OwnerType, ownerIds: string[]): void {
  if (ownerIds.length === 0) return;
  const owners = ownerIds.map(() => '?').join(', ');

  // Комментарии, где владелец — первичный: надгробие самому комментарию и
  // всем его видимым привязкам (m2m).
  const commentIds = (
    ndb
      .prepare(`SELECT id FROM comments_v WHERE owner_type = ? AND owner_id IN (${owners})`)
      .all(ownerType, ...ownerIds) as { id: string }[]
  ).map((r) => r.id);
  for (const commentId of commentIds) {
    const targetIds = (
      ndb.prepare('SELECT id FROM comment_targets_v WHERE comment_id = ?').all(commentId) as {
        id: string;
      }[]
    ).map((r) => r.id);
    for (const targetId of targetIds) materializeTombstone(ndb, 'comment_targets', targetId);
    materializeTombstone(ndb, 'comments', commentId);
  }

  // Вторичные привязки чужих комментариев к этому владельцу — отвязываются
  // (надгробие на строку привязки, L20 §10.1).
  const secondaryIds = (
    ndb
      .prepare(`SELECT id FROM comment_targets_v WHERE owner_type = ? AND owner_id IN (${owners})`)
      .all(ownerType, ...ownerIds) as { id: string }[]
  ).map((r) => r.id);
  for (const targetId of secondaryIds) materializeTombstone(ndb, 'comment_targets', targetId);

  // Вложения: надгробим только ВЛАДЕНИЯ владельца в этом слое — вложение может
  // принадлежать и другим объектам (ADR 9f90b010). Видимую строку вложения
  // прячем, лишь когда живых владений не осталось ни в одном рабочем слое.
  // Физический файл один на все слои, из слоя не трогается (§5.3).
  const ownedAttachments = ndb
    .prepare(
      `SELECT id, attachment_id FROM attachment_owners_v WHERE owner_type = ? AND owner_id IN (${owners})`,
    )
    .all(ownerType, ...ownerIds) as { id: string; attachment_id: string }[];
  const affectedAttachmentIds = new Set<string>();
  for (const ownership of ownedAttachments) {
    materializeTombstone(ndb, 'attachment_owners', ownership.id);
    affectedAttachmentIds.add(ownership.attachment_id);
  }
  for (const attachmentId of affectedAttachmentIds) {
    // Вложение теряет видимость в этом слое, когда в его цепочке не осталось ни
    // одного живого владения (файл общий для всех слоёв — из слоя не трогается).
    const stillVisible = ndb
      .prepare('SELECT 1 FROM attachment_owners_v WHERE attachment_id = ? LIMIT 1')
      .get(attachmentId);
    if (stillVisible === undefined) materializeTombstone(ndb, 'attachments', attachmentId);
  }

  // Значения свойств владельца (и его связей — вызывающий код передаёт их id
  // отдельным вызовом с ownerType='link').
  const valueIds = (
    ndb
      .prepare(`SELECT id FROM property_values_v WHERE owner_type = ? AND owner_id IN (${owners})`)
      .all(ownerType, ...ownerIds) as { id: string }[]
  ).map((r) => r.id);
  for (const valueId of valueIds) materializeTombstone(ndb, 'property_values', valueId);

  // Синонимы есть только у мыслей.
  if (ownerType === 'thought') {
    const synonymIds = (
      ndb
        .prepare(`SELECT id FROM thought_synonyms_v WHERE thought_id IN (${owners})`)
        .all(...ownerIds) as { id: string }[]
    ).map((r) => r.id);
    for (const synonymId of synonymIds) materializeTombstone(ndb, 'thought_synonyms', synonymId);
  }
}

/**
 * Надгробия на всё поддерево зависимых строк мысли в текущем слое
 * (13-layers.md §5.2): сама мысль, её видимые связи (с обеих сторон) вместе с
 * их зависимыми строками, комментарии, вложения, значения свойств и синонимы.
 * Дети не удаляются — каскад бьёт по строкам связей, а не по дочерним мыслям:
 * ребёнок остаётся, но теряет эту связь.
 */
export function tombstoneThoughtDeletionDependants(ndb: NetworkDb, thoughtId: string): void {
  // Сначала зависимые строки инцидентных связей, затем сами связи, затем
  // зависимые строки самой мысли и она сама.
  const linkIds = (
    ndb
      .prepare('SELECT id FROM links_v WHERE source_id = ? OR target_id = ?')
      .all(thoughtId, thoughtId) as { id: string }[]
  ).map((r) => r.id);
  tombstoneOwnerDependants(ndb, 'link', linkIds);
  for (const linkId of linkIds) materializeTombstone(ndb, 'links', linkId);
  tombstoneOwnerDependants(ndb, 'thought', [thoughtId]);
  materializeTombstone(ndb, 'thoughts', thoughtId);
}

/** Single-chunk purge; `ownerIds` must be non-empty and ≤ OWNER_CHUNK_SIZE. */
function purgeChunk(ndb: NetworkDb, ownerType: OwnerType, ownerIds: string[]): void {
  if (ownerIds.length === 0) return;
  const owners = ownerIds.map(() => '?').join(', ');

  // Comments where an owner is the primary owner are deleted with all their
  // m2m targets; target rows pointing at the owner are detached (L20 §10.1).
  // layers:physical-read — суб-SELECT перечисляет логические id по ВСЕМ слоям:
  // физический DELETE ниже выметает строки каждого слоя, включая надгробия.
  ndb
    .prepare(
      `DELETE FROM comment_targets WHERE comment_id IN
         (SELECT id FROM comments WHERE owner_type = ? AND owner_id IN (${owners}))`, // layers:physical-read
    )
    .run(ownerType, ...ownerIds);
  ndb
    .prepare(`DELETE FROM comments WHERE owner_type = ? AND owner_id IN (${owners})`)
    .run(ownerType, ...ownerIds);
  ndb
    .prepare(`DELETE FROM comment_targets WHERE owner_type = ? AND owner_id IN (${owners})`)
    .run(ownerType, ...ownerIds);

  // Вложения: снимаем только ВЛАДЕНИЯ владельца (строки `attachment_owners`);
  // вложение и файл уходят по исчезновению последнего живого владельца (ADR
  // 9f90b010). Чужие владения и их файлы не трогаются.
  purgeOwnerAttachmentsChunk(ndb, ownerType, ownerIds);

  ndb
    .prepare(`DELETE FROM property_values WHERE owner_type = ? AND owner_id IN (${owners})`)
    .run(ownerType, ...ownerIds);
}

// ---------------------------------------------------------------------------
// Multi-owned attachments (ADR 9f90b010): ownership-scoped purge
// ---------------------------------------------------------------------------

/**
 * Снять владения вложениями удаляемых объектов и убрать вложения, оставшиеся
 * без живых владельцев. Единственный источник истины о владении — строки
 * `attachment_owners`; owner-колонки `attachments` не читаются (постоянно
 * неактуальное зеркало, см. предупреждение в attachment-service).
 *
 * Используется физическим каскадом мыслей/связей и физическим удалением
 * публикации (в основе, `is_base_context`). No-op для пустого списка.
 */
export function purgeOwnerAttachments(
  ndb: NetworkDb,
  ownerType: AttachmentPurgeOwnerType,
  ownerIds: string[],
): void {
  for (let i = 0; i < ownerIds.length; i += OWNER_CHUNK_SIZE) {
    purgeOwnerAttachmentsChunk(ndb, ownerType, ownerIds.slice(i, i + OWNER_CHUNK_SIZE));
  }
}

/** Single-chunk ownership purge; `ownerIds` non-empty and ≤ OWNER_CHUNK_SIZE. */
function purgeOwnerAttachmentsChunk(
  ndb: NetworkDb,
  ownerType: AttachmentPurgeOwnerType,
  ownerIds: string[],
): void {
  if (ownerIds.length === 0) return;
  const owners = ownerIds.map(() => '?').join(', ');

  // Вложения, которыми владел удаляемый объект, — по СЫРОЙ таблице, во ВСЕХ
  // слоях: физический каскад выметает строки каждого слоя.
  const attachmentIds = (
    ndb
      .prepare(
        `SELECT DISTINCT attachment_id FROM attachment_owners -- layers:physical-read
          WHERE owner_type = ? AND owner_id IN (${owners})`,
      )
      .all(ownerType, ...ownerIds) as { attachment_id: string }[]
  ).map((r) => r.attachment_id);

  // Снимаем ТОЛЬКО владения удаляемого объекта.
  ndb
    .prepare(`DELETE FROM attachment_owners WHERE owner_type = ? AND owner_id IN (${owners})`)
    .run(ownerType, ...ownerIds);

  if (attachmentIds.length === 0) return;

  // Вложение и файл уходят, только если не осталось ни одного живого владения
  // во всех рабочих слоях (служебные слои не считаются).
  const orphanIds = attachmentIds.filter((id) => !hasLiveOwnershipAnywhere(ndb, id));
  if (orphanIds.length === 0) return;
  removeOrphanAttachments(ndb, orphanIds);
}

/**
 * Физически удалить осиротевшие вложения (живых владений нет) вместе с их
 * серверными файлами и почистить висячие ссылки-иконки/обложки. Строки всех
 * слоёв: вложение — общий ресурс сети.
 */
function removeOrphanAttachments(ndb: NetworkDb, attachmentIds: string[]): void {
  const ids = attachmentIds.map(() => '?').join(', ');
  const rows = ndb
    .prepare(
      `SELECT DISTINCT id, kind, file_path FROM attachments -- layers:physical-read
        WHERE id IN (${ids})`,
    )
    .all(...attachmentIds) as { id: string; kind: AttachmentKind; file_path: string | null }[];

  // Строки владений, оставшиеся в служебных слоях, тоже убираем — иначе они
  // ссылались бы на удалённое вложение.
  ndb.prepare(`DELETE FROM attachment_owners WHERE attachment_id IN (${ids})`).run(...attachmentIds);
  ndb.prepare(`DELETE FROM attachments WHERE id IN (${ids})`).run(...attachmentIds);

  // Висячих ссылок-иконок (L16) и обложек публикаций не оставляем.
  ndb
    .prepare(`UPDATE thoughts SET icon_attachment_id = NULL WHERE icon_attachment_id IN (${ids})`)
    .run(...attachmentIds);
  ndb
    .prepare(`UPDATE publications SET cover_attachment_id = NULL WHERE cover_attachment_id IN (${ids})`)
    .run(...attachmentIds);

  for (const row of rows) {
    // Тот же серверный файл может ещё использоваться другой живой строкой
    // (вторая ссылка через `PATCH …/file_path`) — тогда файл сохраняем.
    if (
      row.kind === 'file' &&
      row.file_path !== null &&
      storedFileInUse(ndb, path.resolve(row.file_path))
    ) {
      continue;
    }
    removeStoredFile(ndb, row.kind, row.file_path);
  }
}
