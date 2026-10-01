/**
 * Trash (mark-for-deletion) domain service (task S13, docs/03-server-api.md
 * §14b; docs/02-data-model.md §3.1.2).
 *
 * There is no separate "trash" table: the trash is the set of rows with
 * `marked_for_deletion = 1` — thoughts, links and (0.11.1, задача c59ce742)
 * publications and shelves. Listing it just reads those rows and precomputes
 * each one's blocking check so the «Корзина» dialog does not fire a per-row
 * request; purging physically deletes every unblocked marked row.
 *
 * The actual delete runs through the same domain functions as a direct
 * `DELETE` ({@link deleteThought} / {@link deleteLink} /
 * {@link purgePublication} / {@link deleteShelf}), so the blocking and
 * base-only rules stay in exactly one place.
 *
 * Веха 9 (задача 8b2efe2d): {@link purgeTrash} не открывает транзакцию сам —
 * она исполняется фасадами через обёртку {@link runWrite}, которая даёт
 * транзакцию и раздаёт события/журнал после коммита (требование 3269a025,
 * ошибка ac8a684b). Исход записи собирается из результата: событие и снимок
 * журнала — по фактически удалённым строкам, а не по списку запрошенных.
 */

import type {
  TrashLinkEntry,
  TrashListResult,
  TrashPublicationEntry,
  TrashPurgeResult,
  TrashShelfEntry,
  TrashThoughtEntry,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { isBaseContext } from '../db/layer-write.js';
import { getLink, checkLinkDeletion, deleteLink } from './link-service.js';
import { getThought, checkThoughtDeletion, deleteThought } from './thought-service.js';
import {
  checkPublicationDeletion,
  checkShelfDeletion,
  deleteShelf,
  getPublication,
  getShelf,
  purgePublication,
} from './publication-service.js';
import type { AnyWriteEvent, WriteActivityEntry, WriteOutcome } from './write-wrapper.js';

/**
 * Full outcome of a purge: the public {@link TrashPurgeResult} plus the ids
 * that were actually deleted, so the route/MCP layer can fan out the standard
 * `thought.deleted` / `link.deleted` / `publication.purged` / `shelf.deleted`
 * real-time events. Callers strip the id lists from the wire response
 * (03-server-api.md §14b exposes only the counts).
 */
export interface TrashPurgeOutcome extends TrashPurgeResult {
  deleted_thought_ids: string[];
  deleted_link_ids: string[];
  deleted_publication_ids: string[];
  deleted_shelf_ids: string[];
}

/** Исход очистки для обёртки записи: результат + события + журнал. */
export type TrashPurgeWrite = WriteOutcome<TrashPurgeOutcome>;

/**
 * Blocking check of one trash entry — the same context-aware check as the
 * `deletion-check` endpoint (03-server-api.md §6.5a): in a working layer the
 * session's own shadow row never holds, but a live base row does (a «delete»
 * there would only be a tombstone, 13-layers.md §5.2), so the trash dialog
 * shows the same blocked/skip picture the single-delete dialog would.
 */
function trashCheckThought(ndb: NetworkDb, id: string) {
  return checkThoughtDeletion(ndb, id);
}

/** Link counterpart of {@link trashCheckThought}. */
function trashCheckLink(ndb: NetworkDb, id: string) {
  return checkLinkDeletion(ndb, id);
}

/**
 * Everything in the trash: every thought and link with
 * `marked_for_deletion = 1`, each with its precomputed blocking result
 * (03-server-api.md §14b). Not paginated — the trash is expected to stay small
 * because «Удалить всё, что возможно» regularly empties it.
 */
export function listTrash(ndb: NetworkDb): TrashListResult {
  const base = isBaseContext(ndb);
  const thoughtIds = (
    ndb.prepare('SELECT id FROM thoughts_v WHERE marked_for_deletion = 1').all() as { id: string }[]
  ).map((r) => r.id);
  const linkIds = (
    ndb.prepare('SELECT id FROM links_v WHERE marked_for_deletion = 1').all() as { id: string }[]
  ).map((r) => r.id);
  const publicationIds = (
    ndb
      .prepare('SELECT id FROM publications_v WHERE marked_for_deletion = 1')
      .all() as { id: string }[]
  ).map((r) => r.id);
  const shelfIds = (
    ndb
      .prepare('SELECT id FROM shelves_v WHERE marked_for_deletion = 1')
      .all() as { id: string }[]
  ).map((r) => r.id);

  const thoughts: TrashThoughtEntry[] = [];
  for (const id of thoughtIds) {
    const thought = getThought(ndb, id);
    if (thought === null) continue; // deleted concurrently — defensive
    const check = trashCheckThought(ndb, id);
    thoughts.push({ ...thought, blocked: check.blocked, blocking: check.blocking });
  }

  const links: TrashLinkEntry[] = [];
  for (const id of linkIds) {
    const link = getLink(ndb, id);
    if (link === null) continue; // deleted concurrently — defensive
    const check = trashCheckLink(ndb, id);
    links.push({ ...link, blocked: check.blocked, blocking: check.blocking });
  }

  // Публикации (0.11.1, задача c59ce742; требование 200b87be): та же проверка
  // блокировки, что у `DELETE /publications/{id}` (живые значения свойств типа
  // «Публикация» + удерживающие слои), плюс физическая очистка возможна только
  // в основе — в рабочем слое строка показывается как заблокированная, чтобы
  // диалог корзины не обещал недоступное удаление.
  const publications: TrashPublicationEntry[] = [];
  for (const id of publicationIds) {
    const publication = getPublication(ndb, id);
    if (publication === null) continue; // deleted concurrently — defensive
    const check = checkPublicationDeletion(ndb, id);
    publications.push({
      ...publication,
      blocked: check.blocked || !base,
      blocking: check.blocking,
    });
  }

  // Полки: блокирует непустой состав (сначала убери публикации) и рабочий слой.
  const shelves: TrashShelfEntry[] = [];
  for (const id of shelfIds) {
    const shelf = getShelf(ndb, id);
    if (shelf === null) continue; // deleted concurrently — defensive
    const check = checkShelfDeletion(ndb, id);
    shelves.push({ ...shelf, blocked: check.blocked || !base, blocking: check.blocking });
  }

  return { thoughts, links, publications, shelves };
}

/**
 * «Удалить всё, что возможно» (03-server-api.md §14b): physically delete every
 * marked thought/link that is not blocked; blocked ones are skipped silently
 * (an expected outcome, not a failure). Returns purged/skipped counts.
 *
 * `ids` narrows the sweep to the listed rows (ошибка 8b4b7a7e: per-item
 * «Удалить совсем» из диалога связи и экрана корзины — `DELETE /links/{id}`
 * снят 0.8.1, физическая чистка одного ребра идёт через purge). A requested id
 * that is not in the trash (unmarked or already gone) counts as skipped, same
 * silent philosophy as a blocked row.
 *
 * In a working layer blocked rows (base-held and other-layer shadows) are
 * skipped just like in the base: the «Удалить» in a layer means a tombstone
 * (13-layers.md §5.2), which the user has not consciously agreed to for rows
 * living elsewhere.
 *
 * Транзакции функция сама не открывает — атомарность всего прохода даёт
 * обёртка {@link runWrite} (требование 3269a025, ошибка ac8a684b): сбой
 * посреди очистки откатывает проход целиком, частичного удаления не
 * остаётся. События и журнал — в исходе, из фактически удалённых строк;
 * обёртка исполняет их после коммита.
 */
export function purgeTrash(ndb: NetworkDb, ids?: string[]): TrashPurgeWrite {
  let purged = 0;
  let skipped = 0;
  const base = isBaseContext(ndb);
  const deletedThoughtIds: string[] = [];
  const deletedLinkIds: string[] = [];
  const deletedPublicationIds: string[] = [];
  const deletedShelfIds: string[] = [];
  const events: AnyWriteEvent[] = [];
  const activity: WriteActivityEntry[] = [];

  const wanted = ids === undefined ? null : new Set(ids);
  const takeId = (id: string): boolean => {
    if (wanted === null) return true;
    if (!wanted.has(id)) return false;
    wanted.delete(id); // count each requested id once
    return true;
  };

  // Снимки помеченных строк ДО физического удаления — журналу активности
  // нужен короткий снимок на момент операции (требование b0c7a57c); после
  // purgeTrash строк уже нет.
  const trash = listTrash(ndb);
  const thoughtSnapshots = new Map(trash.thoughts.map((t) => [t.id, t]));
  const linkSnapshots = new Map(trash.links.map((l) => [l.id, l]));
  const publicationSnapshots = new Map(trash.publications.map((p) => [p.id, p]));
  const shelfSnapshots = new Map(trash.shelves.map((s) => [s.id, s]));

  const thoughtIds = (
    ndb.prepare('SELECT id FROM thoughts_v WHERE marked_for_deletion = 1').all() as { id: string }[]
  )
    .map((r) => r.id)
    .filter(takeId);
  const linkIds = (
    ndb.prepare('SELECT id FROM links_v WHERE marked_for_deletion = 1').all() as { id: string }[]
  )
    .map((r) => r.id)
    .filter(takeId);
  const publicationIds = (
    ndb
      .prepare('SELECT id FROM publications_v WHERE marked_for_deletion = 1')
      .all() as { id: string }[]
  )
    .map((r) => r.id)
    .filter(takeId);
  const shelfIds = (
    ndb.prepare('SELECT id FROM shelves_v WHERE marked_for_deletion = 1').all() as { id: string }[]
  )
    .map((r) => r.id)
    .filter(takeId);
  if (wanted !== null) skipped += wanted.size; // requested but not in the trash

  for (const id of thoughtIds) {
    // A candidate may already be gone mid-sweep. It left the trash all the
    // same, so it counts as purged and its `*.deleted` event still fires —
    // the route-level fan-out is the only event source (the domain cascade of
    // `deleteThought` emits nothing).
    if (getThought(ndb, id) === null) {
      deletedThoughtIds.push(id);
      purged += 1;
      continue;
    }
    if (trashCheckThought(ndb, id).blocked) {
      skipped += 1;
      continue;
    }
    // `null` actor bypasses object-lock checks (task 2031df5e): the trash
    // purge is a system-level cleanup, not a user-driven write.
    deleteThought(ndb, id, undefined, null);
    deletedThoughtIds.push(id);
    purged += 1;
  }
  for (const id of linkIds) {
    // Cascade guard: a link listed for purge is often physically deleted by
    // an earlier thought deletion of this same sweep (deleteThought cascades
    // the thought's links). Counting + reporting it keeps `purged` truthful
    // and delivers the `link.deleted` event the cascade never emitted —
    // before, this spot crashed the whole purge with NOT_FOUND.
    if (getLink(ndb, id) === null) {
      deletedLinkIds.push(id);
      purged += 1;
      continue;
    }
    if (trashCheckLink(ndb, id).blocked) {
      skipped += 1;
      continue;
    }
    deleteLink(ndb, id, undefined);
    deletedLinkIds.push(id);
    purged += 1;
  }

  // Публикации: правила те же, что у `DELETE /publications/{id}` — блокировки
  // (значения свойств «Публикация», удерживающие слои) и физическое удаление
  // только в основе. В рабочем слое помеченная публикация пропускается, пока
  // не сольётся в основу.
  for (const id of publicationIds) {
    if (getPublication(ndb, id) === null) {
      deletedPublicationIds.push(id);
      purged += 1;
      continue;
    }
    if (!base || checkPublicationDeletion(ndb, id).blocked) {
      skipped += 1;
      continue;
    }
    purgePublication(ndb, id);
    deletedPublicationIds.push(id);
    purged += 1;
  }
  // Полки — после публикаций: удаление публикации подчищает её строки состава
  // (cascade), поэтому помеченная полка может опустеть этим же проходом.
  for (const id of shelfIds) {
    const shelf = getShelf(ndb, id);
    if (shelf === null) {
      deletedShelfIds.push(id);
      purged += 1;
      continue;
    }
    if (!base || shelf.items.length > 0) {
      skipped += 1;
      continue;
    }
    deleteShelf(ndb, id);
    deletedShelfIds.push(id);
    purged += 1;
  }

  // События и журнал — из фактически удалённого: снимок берём из
  // предоперационных карт (каскадно исчезнувшие связи в них есть).
  for (const id of deletedThoughtIds) {
    events.push({ type: 'thought.deleted', data: { id } });
    const snapshot = thoughtSnapshots.get(id);
    if (snapshot !== undefined) {
      activity.push({ kind: 'thought', action: 'deleted', thought: snapshot });
    }
  }
  for (const id of deletedLinkIds) {
    events.push({ type: 'link.deleted', data: { id } });
    const snapshot = linkSnapshots.get(id);
    if (snapshot !== undefined) {
      activity.push({ kind: 'link', action: 'deleted', link: snapshot });
    }
  }
  for (const id of deletedPublicationIds) {
    events.push({ type: 'publication.purged', data: { id } });
    const snapshot = publicationSnapshots.get(id);
    if (snapshot !== undefined) {
      activity.push({ kind: 'publication', action: 'deleted', publication: snapshot });
    }
  }
  for (const id of deletedShelfIds) {
    events.push({ type: 'shelf.deleted', data: { id } });
    const snapshot = shelfSnapshots.get(id);
    if (snapshot !== undefined) {
      activity.push({ kind: 'shelf', action: 'deleted', shelf: snapshot });
    }
  }

  return {
    result: {
      purged,
      skipped,
      deleted_thought_ids: deletedThoughtIds,
      deleted_link_ids: deletedLinkIds,
      deleted_publication_ids: deletedPublicationIds,
      deleted_shelf_ids: deletedShelfIds,
    },
    events,
    activity,
  };
}
