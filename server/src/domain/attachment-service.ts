/**
 * Attachment domain service (task C8, docs/03-server-api.md §11,
 * docs/02-data-model.md §3.9).
 *
 * Attachments are polymorphic (`owner_type` + `owner_id`, no SQL FK) and come in
 * two kinds:
 *   * `url` — stores a URL (`url` column populated);
 *   * `file` — stores a path in the user's OS (`file_path` populated); on MVP the
 *     binary is **not** uploaded to the server.
 *
 * `mime_type`/`file_size` are optional hints supplied by the client. The
 * `attachments` table has no `version` column, so updates are last-write-wins
 * without an `If-Match` guard (unlike thoughts/links/comments).
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  ATTACHMENT_KINDS,
  ATTACHMENT_OWNER_TYPES,
  buildLikePattern,
  EtnError,
  parseFilterKeywords,
  type Attachment,
  type AttachmentContent,
  type AttachmentContentUpdateInput,
  type AttachmentContentUpdateResult,
  type AttachmentCopyInput,
  type AttachmentCopyResult,
  type AttachmentCreateInput,
  type AttachmentFileInput,
  type AttachmentInput,
  type AttachmentKind,
  type AttachmentOwnerChangeResult,
  type AttachmentOwnerRef,
  type AttachmentOwnerRemoveResult,
  type AttachmentOwnerType,
  type AttachmentSearchQuery,
  type AttachmentUpdateInput,
  type AttachmentUsage,
  type AttachmentUsageRef,
} from '@etn/shared';

import { DEFAULT_MAX_LENGTH, renderMarkdown } from '@etn/markdown';

import type { NetworkDb } from '../db/network-db.js';
import { isBaseContext, materializeShadow, materializeShadowFromAnyLayer, materializeTombstone } from '../db/layer-write.js';

/** Raw `attachments` row shape. */
interface AttachmentRow {
  id: string;
  owner_type: string;
  owner_id: string;
  kind: string;
  url: string | null;
  file_path: string | null;
  file_size: number | null;
  mime_type: string | null;
  title: string | null;
  description: string | null;
  position: number;
  icon: string | null;
  created_at: string;
  created_by: string;
  /**
   * Id пользователя, последним правившего вложение. Колонка `updated_by`
   * добавлена миграцией 033; ISO-колонки `updated_at` у этой таблицы
   * исторически нет — клиенту показываем `created_at`/`updated_at_ms`
   * как метку свежести.
   */
  updated_by: string;
  created_at_ms: number;
  updated_at_ms: number;
}

/** Convert a raw row into an {@link Attachment}. */
function rowToAttachment(
  row: AttachmentRow,
  owner?: { owner_type: AttachmentOwnerType; owner_id: string; position: number } | undefined,
): Attachment {
  return {
    id: row.id,
    owner_type: (owner?.owner_type ?? row.owner_type) as AttachmentOwnerType,
    owner_id: owner?.owner_id ?? row.owner_id,
    kind: row.kind as AttachmentKind,
    url: row.url,
    file_path: row.file_path,
    file_size: row.file_size,
    mime_type: row.mime_type,
    title: row.title,
    icon: row.icon,
    description: row.description,
    position: owner?.position ?? row.position,
    created_at: row.created_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

/** Validate an attachment kind against the enum tuple. */
function validateKind(kind: unknown): AttachmentKind {
  if (typeof kind !== 'string' || !(ATTACHMENT_KINDS as readonly string[]).includes(kind)) {
    throw new EtnError('VALIDATION_ERROR', `invalid attachment kind: ${String(kind)}`, {
      field: 'kind',
      allowed: ATTACHMENT_KINDS,
    });
  }
  return kind as AttachmentKind;
}

/** Validate a polymorphic owner type against the enum tuple. */
function validateOwnerType(ownerType: unknown): AttachmentOwnerType {
  if (
    typeof ownerType !== 'string' ||
    !(ATTACHMENT_OWNER_TYPES as readonly string[]).includes(ownerType)
  ) {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${String(ownerType)}`, {
      field: 'owner_type',
      allowed: ATTACHMENT_OWNER_TYPES,
    });
  }
  return ownerType as AttachmentOwnerType;
}

/**
 * Ensure the polymorphic owner exists. Attachments have no SQL FK, so this guard
 * prevents orphaned rows and gives the caller a precise 404.
 */
function ensureOwnerExists(ndb: NetworkDb, ownerType: AttachmentOwnerType, ownerId: string): void {
  // Reads go through the layer-resolving views (13-layers.md §4.2).
  // `publication` (0.11.1, задача f37b468d, ADR 73cfcf64) — обложка публикации:
  // публикация текущего слоя (`publications_v`).
  const table =
    ownerType === 'thought' ? 'thoughts_v' : ownerType === 'link' ? 'links_v' : 'publications_v';
  const row = ndb.prepare(`SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`).get(ownerId);
  if (!row) {
    throw new EtnError('NOT_FOUND', `${ownerType} ${ownerId} not found`, {
      entity: ownerType,
      id: ownerId,
    });
  }
}

/** Coerce a string-or-null field: empty string → null. */
function nullable(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : value;
}

// ---------------------------------------------------------------------------
// Ownership (0.12.1, ADR 9f90b010 / task 7678876a)
// ---------------------------------------------------------------------------
//
// Владение вложения живёт в ветвимой таблице `attachment_owners` (одна строка
// = одна пара (вложение, объект)). Владельцев у вложения может быть много;
// владение «липкое» — снимается только явным `removeOwner`.
//
// Переходный период (dual-write): колонки `attachments.owner_type/owner_id/
// position` продолжают поддерживаться как зеркало ПЕРВИЧНОГО владельца, потому
// что их ещё читают merge-service (резервная ветка слияния), owner-cleanup,
// импорт/экспорт `.etnx` и клиентский DTO. Финальное снятие колонок —
// отдельные задачи (DTO 478f8c1f/f77382ba, owner-cleanup da59a4cf); домен уже
// читает и пишет владения ТОЛЬКО через `attachment_owners`.
//
// ВНИМАНИЕ: owner-колонки — НЕТОЧНОЕ зеркало. Их обновляет только создание
// вложения и PATCH-перенос владельца; `addOwners`/`removeOwner` их НЕ трогают.
// Для вложения с несколькими владельцами колонки указывают на одного (первого
// создателя) и после снятия его владения устаревают. Не используйте их как
// источник истины о владении — только `attachment_owners`. Учесть при снятии
// колонок (задача da59a4cf) и редизайне DTO (478f8c1f/f77382ba).

/** Raw `attachment_owners` row shape (joined/live view). */
interface OwnershipRow {
  id: string;
  attachment_id: string;
  owner_type: string;
  owner_id: string;
  position: number;
}

/** SHA-256 hex of a byte buffer (dedup key, ADR e3a35864). */
function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** SHA-256 of a server-resolvable file, or `null` when it cannot be read. */
function fileContentHash(filePath: string): string | null {
  try {
    return sha256Hex(readFileSync(filePath));
  } catch {
    return null;
  }
}

/**
 * Одна живая строка владения парой (вложение, объект) в текущем слое, либо
 * `undefined`. Чтение — через представление `attachment_owners_v` (13-layers.md
 * §4.2): надгробие владения скрывает его из этого слоя.
 */
function liveOwnership(
  ndb: NetworkDb,
  attachmentId: string,
  ownerType: AttachmentOwnerType,
  ownerId: string,
): OwnershipRow | undefined {
  return ndb
    .prepare(
      'SELECT id, attachment_id, owner_type, owner_id, position FROM attachment_owners_v WHERE attachment_id = ? AND owner_type = ? AND owner_id = ? LIMIT 1',
    )
    .get(attachmentId, ownerType, ownerId) as OwnershipRow | undefined;
}

/**
 * Публичная проверка «вложение живо принадлежит объекту» — для валидаций
 * иконки мысли и обложки публикации (0.12.1, задача 7678876a): владелец, а не
 * колонки `attachments`.
 */
export function hasOwnership(
  ndb: NetworkDb,
  attachmentId: string,
  ownerType: AttachmentOwnerType,
  ownerId: string,
): boolean {
  return liveOwnership(ndb, attachmentId, ownerType, ownerId) !== undefined;
}

/** Живые владения вложения в текущем слое, в порядке отображения. */
function listLiveOwners(ndb: NetworkDb, attachmentId: string): OwnershipRow[] {
  return ndb
    .prepare(
      'SELECT id, attachment_id, owner_type, owner_id, position FROM attachment_owners_v WHERE attachment_id = ? ORDER BY position ASC, created_at ASC, id ASC',
    )
    .all(attachmentId) as OwnershipRow[];
}

/**
 * Первичный владелец для DTO `owner_type/owner_id` (переходный период до
 * редизайна DTO, задачи 478f8c1f/f77382ba): владение с наименьшим `position`,
 * при равенстве — ранее созданное. Нет владений — `undefined` (тогда берутся
 * зеркальные колонки строки).
 */
function primaryOwnership(
  ndb: NetworkDb,
  attachmentId: string,
): { owner_type: AttachmentOwnerType; owner_id: string; position: number } | undefined {
  const row = ndb
    .prepare(
      'SELECT owner_type, owner_id, position FROM attachment_owners_v WHERE attachment_id = ? ORDER BY position ASC, created_at ASC, id ASC LIMIT 1',
    )
    .get(attachmentId) as { owner_type: string; owner_id: string; position: number } | undefined;
  if (row === undefined) return undefined;
  return { owner_type: row.owner_type as AttachmentOwnerType, owner_id: row.owner_id, position: row.position };
}

/**
 * Есть ли у вложения ХОТЬ ОДНО живое владение в РАБОЧЕМ (не служебном) слое
 * (13-layers.md §5.3). Физический файл один на все слои: он удаляется только
 * когда живых владений не осталось нигде. Служебные (резервные) слои —
 * технические копии для отката слияния — не считаются (ошибка 1d0620a8,
 * holding-layers.ts §8.2): своих живых правок в них нет. Синхронно с
 * twin-функцией merge-service.
 */
export function hasLiveOwnershipAnywhere(ndb: NetworkDb, attachmentId: string): boolean {
  // layers:physical-read — судьба файла решается по строкам всех РАБОЧИХ слоёв.
  const row = ndb
    .prepare(
      `SELECT 1 FROM attachment_owners o -- layers:physical-read
         JOIN layers l ON l.id = o.layer_id AND l.is_service = 0
        WHERE o.attachment_id = ? AND o.deleted = 0
        LIMIT 1`,
    )
    .get(attachmentId);
  return row !== undefined;
}

/** Наименьшая свободная позиция в конце списка владельца (append). */
function nextOwnerPosition(ndb: NetworkDb, ownerType: AttachmentOwnerType, ownerId: string): number {
  const row = ndb
    .prepare(
      'SELECT COALESCE(MAX(position), -1) AS m FROM attachment_owners_v WHERE owner_type = ? AND owner_id = ?',
    )
    .get(ownerType, ownerId) as { m: number };
  return row.m + 1;
}

/**
 * Вставить строку владения в текущем слое. Если в этом слое УЖЕ есть строка
 * владения той же пары `(вложение, тип, объект)` — она переиспользуется:
 * живая (idempotent-путь уже отсёк этот случай выше) либо НАДГРОБНАЯ
 * (`deleted = 1`) — последняя ВОСКРЕШАЕТСЯ, а не вставляется заново. Физическая
 * строка надгробия остаётся после `removeOwner` в слое, а UNIQUE-индекс
 * `attachment_owners (attachment_id, owner_type, owner_id, layer_id)` не
 * учитывает `deleted` — прямой INSERT падал бы с `UNIQUE constraint failed`
 * (требование 9ff3accb: владение идемпотентно; сценарий «снять вложение и
 * вернуть ту же картинку»).
 */
function insertOwnership(
  ndb: NetworkDb,
  attachmentId: string,
  ownerType: AttachmentOwnerType,
  ownerId: string,
  position: number,
  actorUserId: string,
): string {
  // layers:physical-read — ищем и живую, и надгробную строку в целевом слое.
  const existing = ndb
    .prepare(
      `SELECT id, deleted FROM attachment_owners -- layers:physical-read
        WHERE attachment_id = ? AND owner_type = ? AND owner_id = ? AND layer_id = ? LIMIT 1`,
    )
    .get(attachmentId, ownerType, ownerId, ndb.layerId) as
    | { id: string; deleted: number }
    | undefined;
  if (existing !== undefined) {
    if (existing.deleted !== 0) {
      // Воскрешение надгробия владения (§5.2): строка слоя снова жива.
      ndb
        .prepare(
          'UPDATE attachment_owners SET deleted = 0, position = ? WHERE id = ? AND layer_id = ?',
        )
        .run(position, existing.id, ndb.layerId);
    }
    return existing.id;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO attachment_owners
         (id, layer_id, deleted, base_version, attachment_id, owner_type, owner_id,
          position, created_at, created_by)
       VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, attachmentId, ownerType, ownerId, position, now, actorUserId);
  return id;
}

/** Проверить существование нескольких владельцев одного типа (422 — первый отсутствующий). */
function ensureOwnersExist(
  ndb: NetworkDb,
  ownerType: AttachmentOwnerType,
  ownerIds: readonly string[],
): void {
  const table =
    ownerType === 'thought' ? 'thoughts_v' : ownerType === 'link' ? 'links_v' : 'publications_v';
  const placeholders = ownerIds.map(() => '?').join(', ');
  const existing = new Set(
    (
      ndb.prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders})`).all(...ownerIds) as {
        id: string;
      }[]
    ).map((r) => r.id),
  );
  for (const id of ownerIds) {
    if (!existing.has(id)) {
      throw new EtnError('VALIDATION_ERROR', `${ownerType} ${id} not found`, {
        field: 'owner_ids',
        missing: id,
      });
    }
  }
}

/** Батч-титулы владельцев для OwnerRef (мысль/публикация; у связи названия нет). */
function resolveOwnerRefs(ndb: NetworkDb, refs: readonly { owner_type: AttachmentOwnerType; owner_id: string }[]): AttachmentOwnerRef[] {
  const thoughtIds = refs.filter((r) => r.owner_type === 'thought').map((r) => r.owner_id);
  const publicationIds = refs.filter((r) => r.owner_type === 'publication').map((r) => r.owner_id);
  const thoughtTitles = resolveOwnerTitles(ndb, thoughtIds, 'thoughts_v');
  const publicationTitles = resolveOwnerTitles(ndb, publicationIds, 'publications_v');
  return refs.map((r) => ({
    owner_type: r.owner_type,
    owner_id: r.owner_id,
    title:
      r.owner_type === 'thought'
        ? (thoughtTitles.get(r.owner_id) ?? null)
        : r.owner_type === 'publication'
          ? (publicationTitles.get(r.owner_id) ?? null)
          : null,
  }));
}

/**
 * Добавить одного или нескольких владельцев существующему вложению
 * (`POST /attachments/{id}/owners` и вырождённый `POST …/copy`; 0.12.1, задачи
 * 6ba247cc/45903e1d, ADR 9f90b010).
 *
 * Идемпотентно: живое владение (вложение, объект) — no-op и попадает в
 * `skipped`. `added` — в порядке переданных `ownerIds`.
 *
 * Throws `NOT_FOUND` (404) — вложение не найдено; `VALIDATION_ERROR` (422) —
 * неверный `owner_type` или хотя бы один несуществующий владелец.
 */
export function addOwners(
  ndb: NetworkDb,
  attachmentId: string,
  ownerType: AttachmentOwnerType,
  ownerIds: readonly string[],
  actorUserId: string,
): AttachmentOwnerChangeResult {
  const ot = validateOwnerType(ownerType);
  const ids = Array.from(new Set(ownerIds));
  if (ids.length === 0) return { added: [], skipped: [] };
  return ndb.transaction(() => {
    getAttachmentOrThrow(ndb, attachmentId);
    ensureOwnersExist(ndb, ot, ids);
    const added: { owner_type: AttachmentOwnerType; owner_id: string }[] = [];
    const skipped: { owner_type: AttachmentOwnerType; owner_id: string }[] = [];
    for (const ownerId of ids) {
      if (liveOwnership(ndb, attachmentId, ot, ownerId) !== undefined) {
        skipped.push({ owner_type: ot, owner_id: ownerId });
        continue;
      }
      insertOwnership(
        ndb,
        attachmentId,
        ot,
        ownerId,
        nextOwnerPosition(ndb, ot, ownerId),
        actorUserId,
      );
      added.push({ owner_type: ot, owner_id: ownerId });
    }
    return { added: resolveOwnerRefs(ndb, added), skipped: resolveOwnerRefs(ndb, skipped) };
  });
}

/**
 * Снять владение пары (вложение, объект) — `DELETE /attachments/{id}/owners`
 * (0.12.1, задача 4924d61e, требование 6b524569).
 *
 * Защиты (серверная часть требования; текстовый скан — точка расширения задачи
 * 87c455db, сейчас не реализован, т.к. текстовых использований ещё нет):
 *   * `409 ATTACHMENT_OWNER_IS_ICON` — объект использует вложение как свою
 *     иконку (мысль) или обложку (публикация).
 *
 * Идемпотентность наружу: нет живого владения — `NOT_FOUND` (404). После снятия
 * последнего живого владельца ВО ВСЕХ слоях вложение и его серверный файл
 * удаляются: `attachment_deleted: true`. В слое физический файл не трогается
 * (13-layers.md §5.3) — ставится надгробие владения и (при исчезновении всех
 * владений) строки вложения.
 */
export function removeOwner(
  ndb: NetworkDb,
  attachmentId: string,
  ownerType: AttachmentOwnerType,
  ownerId: string,
  // Точка подтверждения предупреждения о текстах (87c455db) — пока не используется.
  _confirm = false,
): AttachmentOwnerRemoveResult {
  const ot = validateOwnerType(ownerType);
  return ndb.transaction(() => {
    const current = getAttachmentOrThrow(ndb, attachmentId);
    const ownership = liveOwnership(ndb, attachmentId, ot, ownerId);
    if (ownership === undefined) {
      throw new EtnError('NOT_FOUND', `владение ${ownerType} ${ownerId} не найдено`, {
        entity: 'attachment_owner',
        attachment_id: attachmentId,
        owner_type: ownerType,
        owner_id: ownerId,
      });
    }
    // Запрет: объект сам использует вложение как свою иконку/обложку.
    if (ot === 'thought') {
      const icon = ndb
        .prepare('SELECT 1 FROM thoughts_v WHERE id = ? AND icon_attachment_id = ? LIMIT 1')
        .get(ownerId, attachmentId);
      if (icon !== undefined) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'объект использует вложение как свою иконку — снятие владения запрещено',
          { code: 'ATTACHMENT_OWNER_IS_ICON', status: 409, field: 'owner_id' },
        );
      }
    } else if (ot === 'publication') {
      const cover = ndb
        .prepare('SELECT 1 FROM publications_v WHERE id = ? AND cover_attachment_id = ? LIMIT 1')
        .get(ownerId, attachmentId);
      if (cover !== undefined) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'объект использует вложение как свою обложку — снятие владения запрещено',
          { code: 'ATTACHMENT_OWNER_IS_ICON', status: 409, field: 'owner_id' },
        );
      }
    }
    // TODO(87c455db): скан текстов комментариев объекта на `etnimg://attachment/<id>`
    // → `409 ATTACHMENT_OWNER_IN_TEXT` без confirm (точка расширения).

    if (!isBaseContext(ndb)) {
      // Слой: надгробие владения; файл не трогаем.
      materializeTombstone(ndb, 'attachment_owners', ownership.id);
      if (!hasLiveOwnershipAnywhere(ndb, attachmentId)) {
        materializeTombstone(ndb, 'attachments', attachmentId);
      }
      return { removed: true, attachment_deleted: false };
    }

    ndb.prepare('DELETE FROM attachment_owners WHERE id = ?').run(ownership.id);
    if (hasLiveOwnershipAnywhere(ndb, attachmentId)) {
      return { removed: true, attachment_deleted: false };
    }
    // Последнее живое владение в сети ушло — удаляем строку вложения и файл.
    // layers:physical-read — живая иконка в любом слое удерживает файл (L16).
    const iconBacksFile =
      current.kind === 'file' &&
      ndb
        .prepare(
          'SELECT 1 FROM thoughts WHERE icon_attachment_id = ? AND deleted = 0 LIMIT 1', // layers:physical-read
        )
        .get(attachmentId) !== undefined;
    ndb.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentId);
    ndb
      .prepare('UPDATE thoughts SET icon_attachment_id = NULL WHERE icon_attachment_id = ?')
      .run(attachmentId);
    ndb
      .prepare('UPDATE publications SET cover_attachment_id = NULL WHERE cover_attachment_id = ?')
      .run(attachmentId);
    const keepFile =
      iconBacksFile ||
      (current.kind === 'file' &&
        current.file_path !== null &&
        storedFileInUse(ndb, path.resolve(current.file_path)));
    if (!keepFile) removeStoredFile(ndb, current.kind, current.file_path);
    return { removed: true, attachment_deleted: true };
  });
}


/** Return an attachment by id, or `null` when absent. */
export function getAttachment(ndb: NetworkDb, id: string): Attachment | null {
  const row = ndb.prepare('SELECT * FROM attachments_v WHERE id = ? LIMIT 1').get(id) as
    | AttachmentRow
    | undefined;
  if (row === undefined) return null;
  // Владелец в DTO берётся из владений (первичный), колонки строки — лишь
  // резерв для переходного периода (см. блок «Ownership»).
  const attachment = rowToAttachment(row, primaryOwnership(ndb, id));
  withOwnershipAggregates(ndb, [attachment]);
  return attachment;
}

/** Return an attachment or throw `NOT_FOUND` (404). */
function getAttachmentOrThrow(ndb: NetworkDb, id: string): Attachment {
  const a = getAttachment(ndb, id);
  if (!a) {
    throw new EtnError('NOT_FOUND', `attachment ${id} not found`, { entity: 'attachment', id });
  }
  return a;
}

/**
 * List attachments attached to an owner (docs/03-server-api.md §11; 0.12.1, ADR
 * `9f90b010`): вложения-владения объекта, порядок — `attachment_owners.position`
 * (у каждого владельца свой порядок), при равенстве — по времени создания.
 */
export function listAttachments(
  ndb: NetworkDb,
  ownerType: AttachmentOwnerType,
  ownerId: string,
): Attachment[] {
  validateOwnerType(ownerType);
  const rows = ndb
    .prepare(
      `SELECT a.*, o.position AS owner_position FROM attachment_owners_v o
         JOIN attachments_v a ON a.id = o.attachment_id
        WHERE o.owner_type = ? AND o.owner_id = ?
        ORDER BY o.position ASC, a.created_at ASC`,
    )
    .all(ownerType, ownerId) as (AttachmentRow & { owner_position: number })[];
  const override = { owner_type: ownerType, owner_id: ownerId };
  const list = rows.map((row) => rowToAttachment(row, { ...override, position: row.owner_position }));
  // Список запрошен для конкретного объекта — все его строки принадлежат ему.
  for (const a of withOwnershipAggregates(ndb, list)) a.owned_by_current = true;
  return list;
}

/** Порядок групп владельцев в ответе «использование вложения». */
const OWNER_TYPE_RANK: Record<AttachmentOwnerType, number> = {
  thought: 0,
  publication: 1,
  link: 2,
};

/** Батч-резолв названий владельцев из `thoughts_v`/`publications_v`. */
function resolveOwnerTitles(
  ndb: NetworkDb,
  ids: readonly string[],
  table: 'thoughts_v' | 'publications_v',
): Map<string, string> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = ndb
    .prepare(`SELECT id, title FROM ${table} WHERE id IN (${placeholders})`)
    .all(...ids) as { id: string; title: string }[];
  return new Map(rows.map((r) => [r.id, r.title]));
}

/**
 * Батч-агрегаты владения для DTO (0.12.1, задача 478f8c1f, сущность 109be255):
 * по списку id вложений одним запросом собирает живых владельцев каждого и
 * резолвит их названия. Возвращает `attachment_id → AttachmentOwnerRef[]`.
 */
function ownersByAttachment(
  ndb: NetworkDb,
  ids: readonly string[],
): Map<string, AttachmentOwnerRef[]> {
  const out = new Map<string, AttachmentOwnerRef[]>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = ndb
    .prepare(
      `SELECT attachment_id, owner_type, owner_id FROM attachment_owners_v
        WHERE attachment_id IN (${placeholders})
        ORDER BY position ASC, created_at ASC, id ASC`,
    )
    .all(...ids) as { attachment_id: string; owner_type: string; owner_id: string }[];
  const spans: { attachment_id: string; len: number }[] = [];
  const flat: { owner_type: AttachmentOwnerType; owner_id: string }[] = [];
  for (const r of rows) {
    flat.push({ owner_type: r.owner_type as AttachmentOwnerType, owner_id: r.owner_id });
    const last = spans[spans.length - 1];
    if (last !== undefined && last.attachment_id === r.attachment_id) last.len += 1;
    else spans.push({ attachment_id: r.attachment_id, len: 1 });
  }
  // Названия владельцев резолвятся ОДНИМ батчем на весь набор, затем режутся
  // по спанам — иначе был бы запрос на вложение.
  const refs = resolveOwnerRefs(ndb, flat);
  let cursor = 0;
  for (const span of spans) {
    out.set(span.attachment_id, refs.slice(cursor, cursor + span.len));
    cursor += span.len;
  }
  return out;
}

/**
 * Дополнить вложения агрегатами владения (0.12.1, задача 478f8c1f, сущность
 * 109be255): `owners`, `owner_count` и — где есть контекст владельца —
 * `owned_by_current`. Мутирует переданные объекты и возвращает их же.
 */
function withOwnershipAggregates(ndb: NetworkDb, attachments: Attachment[]): Attachment[] {
  if (attachments.length === 0) return attachments;
  const owners = ownersByAttachment(
    ndb,
    attachments.map((a) => a.id),
  );
  for (const a of attachments) {
    const refs = owners.get(a.id) ?? [];
    a.owners = refs;
    a.owner_count = refs.length;
  }
  return attachments;
}

/**
 * Использование вложения (0.11.1, задача 46cf4bcb; 0.12.1, задача f3203ce4):
 * владельцы ЭТОГО вложения и его фактические использования — иконки мыслей,
 * обложки публикаций и (точка расширения 87c455db) вхождения в тексты.
 *
 * Источник владельцев — строки владений `attachment_owners` этого вложения
 * (дедупликация по `content_hash` гарантирует, что один файл = одна строка
 * вложения). Названия мыслей и публикаций подставляются из `*_v`; у связи
 * названия нет (`title: null`). Порядок детерминирован.
 *
 * Throws `NOT_FOUND` (404), если строка вложения не видна в текущем слое.
 */
export function listAttachmentUsage(ndb: NetworkDb, attachmentId: string): AttachmentUsage {
  const source = getAttachmentOrThrow(ndb, attachmentId);
  const refs = listLiveOwners(ndb, attachmentId).map((o) => ({
    owner_type: o.owner_type as AttachmentOwnerType,
    owner_id: o.owner_id,
  }));
  const owners: AttachmentOwnerRef[] = resolveOwnerRefs(ndb, refs).sort(
    (a, b) =>
      OWNER_TYPE_RANK[a.owner_type] - OWNER_TYPE_RANK[b.owner_type] ||
      (a.owner_id < b.owner_id ? -1 : a.owner_id > b.owner_id ? 1 : 0),
  );
  // Фактические использования: иконки мыслей и обложки публикаций, ссылающиеся
  // на это вложение. Текстовые вхождения (usage: 'text') пока не собираются —
  // точка расширения задачи 87c455db (картинки по id в комментариях).
  const usages: AttachmentUsageRef[] = [];
  const iconOwners = ndb
    .prepare('SELECT id AS owner_id, title FROM thoughts_v WHERE icon_attachment_id = ? ORDER BY id ASC')
    .all(attachmentId) as { owner_id: string; title: string }[];
  for (const row of iconOwners) {
    usages.push({ usage: 'icon', owner_type: 'thought', owner_id: row.owner_id, title: row.title });
  }
  const coverOwners = ndb
    .prepare(
      'SELECT id AS owner_id, title FROM publications_v WHERE cover_attachment_id = ? ORDER BY id ASC',
    )
    .all(attachmentId) as { owner_id: string; title: string }[];
  for (const row of coverOwners) {
    usages.push({
      usage: 'cover',
      owner_type: 'publication',
      owner_id: row.owner_id,
      title: row.title,
    });
  }
  return { attachment_id: source.id, owners, usages };
}

/**
 * Create an attachment (docs/03-server-api.md §11).
 *
 * Throws:
 *   * `VALIDATION_ERROR` (422) for an invalid kind/owner or when the required
 *     location field (`url` for `kind='url'`, `file_path` for `kind='file'`) is
 *     missing;
 *   * `NOT_FOUND` (404) if the owner does not exist.
 *
 * @param actorUserId - user creating the attachment (recorded as created_by).
 */
export function createAttachment(
  ndb: NetworkDb,
  ownerType: AttachmentOwnerType,
  ownerId: string,
  input: AttachmentInput,
  actorUserId: string,
): Attachment {
  return createAttachmentResult(ndb, ownerType, ownerId, input, actorUserId).attachment;
}

/**
 * Create an attachment and report whether an existing one was REUSED by
 * `content_hash` (дедупликация, ADR `e3a35864`; 0.12.1, задача 7678876a).
 *
 * При совпадении SHA-256 содержимого с уже существующим файловым вложением
 * сети новая строка и копия файла НЕ создаются: текущий объект становится
 * владельцем существующего вложения (`attachment_owners`), `reused: true`.
 * Поиск ведётся по СЫРОЙ таблице `attachments` по ВСЕМ слоям — физические байты
 * не дублируются никогда.
 */
export function createAttachmentResult(
  ndb: NetworkDb,
  ownerType: AttachmentOwnerType,
  ownerId: string,
  input: AttachmentInput,
  actorUserId: string,
): { attachment: Attachment; reused: boolean } {
  const ot = validateOwnerType(ownerType);
  const kind = validateKind(input.kind);
  const url = nullable(input.url ?? null);
  const filePath = nullable(input.file_path ?? null);
  if (kind === 'url') {
    if (url === null) {
      throw new EtnError('VALIDATION_ERROR', "kind='url' requires a non-empty url", {
        field: 'url',
      });
    }
  } else if (filePath === null) {
    throw new EtnError('VALIDATION_ERROR', "kind='file' requires a non-empty file_path", {
      field: 'file_path',
    });
  }

  return ndb.transaction(() => {
    ensureOwnerExists(ndb, ot, ownerId);
    // Хэш — только для файла, реально читаемого сервером (загрузка/серверный
    // путь); клиентские локальные пути и URL дедупликации не подлежат.
    const hash =
      kind === 'file' && filePath !== null && isResolvableFile(filePath)
        ? fileContentHash(filePath)
        : null;
    if (hash !== null) {
      const reusedId = findReusableByHash(ndb, hash);
      if (reusedId !== null) {
        // Переиспользование строки из ЛЮБОГО слоя (ADR e3a35864): строку и файл
        // не создаём; если строка вне цепочки текущего контекста — материализуем
        // её в текущий слой, затем пишем владение.
        const position = typeof input.position === 'number' ? Math.trunc(input.position) : nextOwnerPosition(ndb, ot, ownerId);
        const reused = reuseAttachmentRow(ndb, reusedId, ot, ownerId, position, actorUserId);
        if (reused !== null) return { attachment: reused, reused: true };
      }
    }
    const id = randomUUID();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const position =
      typeof input.position === 'number' ? Math.trunc(input.position) : nextOwnerPosition(ndb, ot, ownerId);
    ndb
      .prepare(
        `INSERT INTO attachments (id, layer_id, owner_type, owner_id, kind, url, file_path,
                                  content_hash, file_size, mime_type, title, description, position,
                                  created_at, created_by, updated_by,
                                  created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ndb.layerId,
        ot,
        ownerId,
        kind,
        kind === 'url' ? url : null,
        kind === 'file' ? filePath : null,
        hash,
        input.file_size ?? null,
        nullable(input.mime_type ?? null),
        nullable(input.title ?? null),
        nullable(input.description ?? null),
        position,
        now,
        actorUserId,
        actorUserId,
        nowMs,
        nowMs,
      );
    insertOwnership(ndb, id, ot, ownerId, position, actorUserId);
    return { attachment: getAttachmentOrThrow(ndb, id), reused: false };
  });
}

/**
 * Id вложения с тем же хэшем файла, уже существующего в сети — по СЫРОЙ таблице
 * `attachments` ПО ВСЕМ слоям (ADR `e3a35864`). Переиспользуются только ЖИВЫЕ
 * строки (`deleted = 0`): надгробие в слое — «слой тоже удалил это вложение»,
 * воскрешать его нельзя (иначе повторная загрузка тех же байт дала бы
 * невидимое reused-вложение).
 */
function findReusableByHash(ndb: NetworkDb, hash: string): string | null {
  // layers:physical-read — дедупликация ищет по всем слоям: байты не дублируются.
  const row = ndb
    .prepare(
      "SELECT id FROM attachments WHERE kind = 'file' AND content_hash = ? AND deleted = 0 LIMIT 1", // layers:physical-read
    )
    .get(hash) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Переиспользовать найденную по хэшу строку вложения в текущем слое (ADR
 * `e3a35864`): если строка физически лежит ВНЕ цепочки текущего контекста,
 * материализуем её в текущий слой (тот же id, теневая копия метаданных без
 * копии байт) — иначе владение осталось бы висячим; затем добавляем владение.
 * Возвращает вложение (видимое в текущем слое) либо `null`, если материализовать
 * не удалось (нет живой сырой строки) — тогда вызывающий создаёт новую.
 */
function reuseAttachmentRow(
  ndb: NetworkDb,
  attachmentId: string,
  ownerType: AttachmentOwnerType,
  ownerId: string,
  position: number,
  actorUserId: string,
): Attachment | null {
  if (getAttachment(ndb, attachmentId) === null) {
    if (!materializeShadowFromAnyLayer(ndb, 'attachments', attachmentId)) return null;
  }
  if (liveOwnership(ndb, attachmentId, ownerType, ownerId) === undefined) {
    insertOwnership(ndb, attachmentId, ownerType, ownerId, position, actorUserId);
  }
  return getAttachment(ndb, attachmentId);
}

/** Maximum decoded size of an uploaded attachment file, 10 MiB. */
export const ATTACHMENT_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Extension by MIME type (for naming stored upload files). */
const UPLOAD_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/pdf': 'pdf',
};

/** Sanitizes a title into a safe file-name base (no path separators). */
function safeNameBase(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 60);
}

/**
 * Store an uploaded file and attach it (docs/03-server-api.md §11).
 *
 * The payload (base64) is decoded and written under the network's
 * `attachments/` directory — the same directory that hosts `data.db` — so the
 * stored copy lives and is backed up together with the database. The created
 * attachment is `kind='file'` with `file_path` pointing at the stored copy.
 *
 * Throws:
 *   * `VALIDATION_ERROR` (422) for a bad base64 payload, unknown/oversized
 *     content or a missing mime_type;
 *   * `NOT_FOUND` (404) if the owner does not exist.
 */
export function createAttachmentFile(
  ndb: NetworkDb,
  ownerType: AttachmentOwnerType,
  ownerId: string,
  input: AttachmentFileInput,
  actorUserId: string,
): Attachment {
  return createAttachmentFileResult(ndb, ownerType, ownerId, input, actorUserId).attachment;
}

/**
 * {@link createAttachmentFile} с признаком переиспользования (ADR `e3a35864`):
 * если файл с тем же SHA-256 уже есть в сети, копия и строка не создаются —
 * текущий объект становится владельцем существующего вложения (`reused: true`).
 */
export function createAttachmentFileResult(
  ndb: NetworkDb,
  ownerType: AttachmentOwnerType,
  ownerId: string,
  input: AttachmentFileInput,
  actorUserId: string,
): { attachment: Attachment; reused: boolean } {
  const ot = validateOwnerType(ownerType);
  const mime = input.mime_type.trim().toLowerCase();
  if (mime === '') {
    throw new EtnError('VALIDATION_ERROR', 'mime_type is required', { field: 'mime_type' });
  }
  const b64 = input.data_base64.replace(/^data:[^,]*,/, '').trim();
  if (b64 === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new EtnError('VALIDATION_ERROR', 'data_base64 must be base64 content', {
      field: 'data_base64',
    });
  }
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((b64.length * 3) / 4) - padding;
  if (bytes <= 0 || bytes > ATTACHMENT_FILE_MAX_BYTES) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `file exceeds the ${ATTACHMENT_FILE_MAX_BYTES} byte limit (${bytes})`,
      { field: 'data_base64', limit: ATTACHMENT_FILE_MAX_BYTES },
    );
  }
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length !== bytes) {
    throw new EtnError('VALIDATION_ERROR', 'data_base64 is not valid base64', {
      field: 'data_base64',
    });
  }

  // Ensure the owner exists before touching the filesystem.
  ensureOwnerExists(ndb, ot, ownerId);

  // Дедупликация по хэшу содержимого (ADR e3a35864): совпало — не пишем файл и
  // не создаём строку, лишь добавляем владение существующему вложению. Строка
  // ищется по СЫРОЙ таблице во ВСЕХ живых слоях; если она вне цепочки текущего
  // контекста — материализуется в текущий слой.
  const hash = sha256Hex(buffer);
  const reusedId = findReusableByHash(ndb, hash);
  if (reusedId !== null) {
    const reused = ndb.transaction(() =>
      reuseAttachmentRow(ndb, reusedId, ot, ownerId, nextOwnerPosition(ndb, ot, ownerId), actorUserId),
    );
    if (reused !== null) return { attachment: reused, reused: true };
  }

  const dir = path.join(path.dirname(ndb.dbPath), 'attachments');
  mkdirSync(dir, { recursive: true });
  const ext = UPLOAD_MIME_EXT[mime] ?? (mime.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/g, '');
  const stamp = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const base = safeNameBase(nullable(input.title ?? null) ?? 'file');
  const name = `${base === '' ? 'file' : base}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}-${randomUUID().slice(0, 4)}.${ext}`;
  const filePath = path.join(dir, name);
  writeFileSync(filePath, buffer);

  return createAttachmentResult(
    ndb,
    ot,
    ownerId,
    {
      kind: 'file',
      file_path: filePath,
      file_size: buffer.length,
      mime_type: mime,
      title: nullable(input.title ?? null),
    },
    actorUserId,
  );
}

/**
 * `true`, если путь существует и указывает на обычный файл. Каталог (и любой
 * не-файл) здесь отвергается так же, как несуществующий путь — ошибка 6a95ba12.
 */
function isResolvableFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Single attachment-creation entry point for the REST/MCP facades (задача
 * 75c75a2f): ordinary metadata-only creation, or an inline file upload when
 * `data_base64` carries a payload. Both branches delegate to the existing
 * domain primitives ({@link createAttachment} / {@link createAttachmentFile}),
 * so no file-writing logic lives in the facades (ADR 8c93f03a).
 *
 * Throws `VALIDATION_ERROR` (422) when `data_base64` is combined with `kind`
 * other than `'file'` or with fields that only describe a metadata attachment,
 * when a `kind='file'` `file_path` does not resolve on the server or resolves
 * to something other than a regular file — a directory included (ошибки
 * 5fcb8307/6a95ba12: файл должен быть доступен серверу; клиентский файл
 * передаётся через `data_base64`), plus every error of the underlying
 * primitive (bad base64, oversize, missing `mime_type`); `NOT_FOUND` (404)
 * when the owner does not exist.
 */
export function createAttachmentFromInput(
  ndb: NetworkDb,
  ownerType: AttachmentOwnerType,
  ownerId: string,
  input: AttachmentCreateInput,
  actorUserId: string,
): Attachment {
  const hasData =
    input.data_base64 !== undefined &&
    input.data_base64 !== null &&
    input.data_base64.trim() !== '';
  if (!hasData) {
    // Ошибка 5fcb8307: `file_path` — путь в файловой системе СЕРВЕРА. Этот
    // диспетчер обслуживает внешние MCP-вызовы (`etn.ops attachments.add` и
    // `attachments[]` в `etn.thoughts.write`); агент работает с удалённым
    // сервером, его локальный путь там не резолвится — раньше вызов молча
    // создавал битое вложение (`mime_type`/`file_size` пусты, файл недоступен).
    // Теперь нерезолвящийся путь — явная ошибка вызова; клиентский файл
    // передаётся содержимым через `data_base64` ({@link createAttachmentFile}).
    // Ошибка 6a95ba12: путь обязан указывать на обычный файл — каталог проходит
    // `existsSync`, поэтому используется `isResolvableFile` (`statSync().isFile()`).
    // REST-маршрут `POST …/attachments` вызывает {@link createAttachment}
    // напрямую и сохраняет документированный контракт «ссылка на путь в ОС
    // клиента» (требование a5456b79) — его эта проверка не затрагивает.
    if (
      input.kind === 'file' &&
      typeof input.file_path === 'string' &&
      input.file_path.trim() !== '' &&
      !isResolvableFile(input.file_path)
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `file_path не указывает на файл на сервере: ${input.file_path}`,
        {
          field: 'file_path',
          file_path: input.file_path,
          hint: 'файл с машины клиента передавайте содержимым в data_base64',
        },
      );
    }
    return createAttachment(ndb, ownerType, ownerId, input, actorUserId);
  }
  if (input.kind !== 'file') {
    throw new EtnError('VALIDATION_ERROR', "data_base64 requires kind='file'", {
      field: 'kind',
    });
  }
  const conflicts = (['url', 'file_path', 'file_size', 'position', 'description'] as const).filter(
    (field) => input[field] !== undefined && input[field] !== null,
  );
  if (conflicts.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `data_base64 cannot be combined with ${conflicts.join('/')}`,
      { fields: conflicts },
    );
  }
  return createAttachmentFile(
    ndb,
    ownerType,
    ownerId,
    {
      title: input.title ?? null,
      mime_type: input.mime_type ?? '',
      data_base64: input.data_base64 as string,
    },
    actorUserId,
  );
}

/**
 * Планировщик физического копирования файлов вложений при **межсетевом**
 * копировании (ошибка b83a7d89 «При копировании мысли между мыслесетями
 * теряются вложения»).
 *
 * Файл-источник лежит в каталоге вложений СЕТИ-ИСТОЧНИКА; ссылка на него в
 * сети-получателе не работает — `getAttachmentRawByPath` отдаёт только файлы
 * внутри каталога ТЕКУЩЕЙ (целевой) сети, отсюда HTTP 404 «файл вложения не
 * найден». Поэтому при межсетевом копировании файл физически дублируется в
 * `<target net>/attachments/`, а копия вложения ссылается на дубль. При
 * копировании внутри одной сети файл НЕ дублируется (`file_path` переносится
 * как есть) — единственный экземпляр сохраняется.
 *
 * **Схема имён копий** (в духе импортёра `.etnx`, docs/02 §9.3 п.7, и
 * `createAttachmentFile`): `<stem>-<n><ext>`, где `n` — наименьшее целое ≥ 2,
 * при котором имени ещё нет ни среди зарезервированных в этом батче, ни в
 * каталоге целевой сети. Исходный файл остаётся «версией 1», первая копия —
 * «-2», следующая — «-3» и т.д. Схема детерминирована (зависит только от
 * состояния каталога) и не даёт столкновений.
 *
 * **Отсутствующий исходный файл** (метаданные есть, файла нет) — не ошибка:
 * {@link resolveFilePath} возвращает исходный путь без изменений (метаданные
 * как есть) и зовёт `warn`, чтобы дефект был наблюдаем в логе.
 *
 * **Транзакционность.** `resolveFilePath` только РЕЗЕРВИРУЕТ будущее имя и
 * копит пары «источник → назначение»; физическая запись идёт в {@link commit},
 * который вызывающий выполняет ПОСЛЕ успешной фиксации БД. При откате
 * транзакции файлы ещё не созданы — осиротевших файлов не остаётся, удалять
 * ничего не нужно.
 */
export class AttachmentFileCopier {
  /** sourceResolvedPath → destPath (дедуп: один файл — одна копия на батч). */
  private readonly copied = new Map<string, string>();
  /** Отложенные записи: источник → назначение. */
  private readonly pending: Array<{ source: string; dest: string }> = [];
  /** Имена, уже занятые в этом батче (проверяются до `existsSync`). */
  private readonly reserved = new Set<string>();

  constructor(
    private readonly ndb: NetworkDb,
    /** Абсолютный каталог вложений СЕТИ-ИСТОЧНИКА. */
    private readonly sourceDir: string,
    /** Приёмник нефатальных замечаний (отсутствующий файл, сбой записи). */
    private readonly warn?: (message: string, details?: Record<string, unknown>) => void,
  ) {}

  /** Каталог вложений целевой сети (рядом с её `data.db`). */
  private targetDir(): string {
    return path.join(path.dirname(this.ndb.dbPath), 'attachments');
  }

  /**
   * Путь для копии вложения. Файл из каталога сети-источника ставится в
   * очередь на копирование и получает уникальное имя в целевой сети; всё
   * прочее (клиентский локальный путь, отсутствующий файл) возвращается как
   * есть.
   */
  resolveFilePath(filePath: string): string {
    const resolvedSource = path.resolve(filePath);
    const resolvedSourceDir = path.resolve(this.sourceDir);
    const cached = this.copied.get(resolvedSource);
    if (cached !== undefined) return cached;
    // Переносим только файлы, реально лежащие в каталоге вложений источника
    // (та же граница безопасности, что у `getAttachmentRawByPath`): чужой
    // путь не читаем, метаданные остаются как есть.
    if (!resolvedSource.startsWith(resolvedSourceDir + path.sep)) return filePath;
    if (!isResolvableFile(resolvedSource)) {
      // Кэшируем и «не найден», чтобы один и тот же файл не сыпал warn'ами
      // при нескольких строках вложений.
      this.copied.set(resolvedSource, filePath);
      this.warn?.('вложение: исходный файл не найден, копия не создана', {
        file_path: filePath,
      });
      return filePath;
    }
    const dest = this.reserveName(path.basename(resolvedSource));
    this.copied.set(resolvedSource, dest);
    this.pending.push({ source: resolvedSource, dest });
    return dest;
  }

  /**
   * Записать все отложенные копии. Вызывать ПОСЛЕ фиксации БД. Best-effort: сбой
   * отдельного файла логируется и не роняет операцию (строка вложения уже
   * создана; недостачу видно в логе).
   */
  commit(): void {
    if (this.pending.length === 0) return;
    mkdirSync(this.targetDir(), { recursive: true });
    for (const { source, dest } of this.pending) {
      try {
        copyFileSync(source, dest);
      } catch (err) {
        this.warn?.('вложение: не удалось скопировать файл в целевую сеть', {
          source,
          dest,
          error: String(err),
        });
      }
    }
    this.pending.length = 0;
  }

  /** Наименьшее свободное имя `<stem>-<n><ext>` (n ≥ 2) в целевом каталоге. */
  private reserveName(basename: string): string {
    const targetDir = this.targetDir();
    const ext = path.extname(basename);
    const stem = safeNameBase(basename.slice(0, basename.length - ext.length)) || 'file';
    const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '');
    for (let n = 2; ; n += 1) {
      const name = `${stem}-${n}${safeExt}`;
      if (this.reserved.has(name)) continue;
      if (existsSync(path.join(targetDir, name))) continue;
      this.reserved.add(name);
      return path.join(targetDir, name);
    }
  }
}

/**
 * `POST /attachments/{id}/copy` — с приходом мульти-владения (0.12.1,
 * ADR `9f90b010`, задача 45903e1d) операция ВЫРОЖДАЕТСЯ в добавление
 * владельцев: новым целевым объектам НЕ создаются строки-копии, а у того же
 * вложения добавляются владения (`attachment_owners`). Эквивалент
 * {@link addOwners}; ответ — `added`/`skipped` владений (в порядке цели).
 *
 * Throws `NOT_FOUND` (404) — вложение не найдено; `VALIDATION_ERROR` (422) —
 * неверный тип владельца или несуществующий владелец.
 */
export function copyAttachment(
  ndb: NetworkDb,
  sourceId: string,
  input: AttachmentCopyInput,
  actorUserId: string,
): AttachmentCopyResult {
  return addOwners(ndb, sourceId, input.target_owner_type, input.target_owner_ids, actorUserId);
}

/**
 * Search attachments across the whole network by keywords (03-server-api.md §11,
 * workplan L25). `q` is required and uses the same mini-syntax as the thought
 * search (§6.10): AND of include-words, `-word` exclusion, `*` infix wildcard;
 * every include word must match somewhere in the union of `title`,
 * `description`, `url`, `file_path` (case-insensitive LIKE).
 *
 * Used by the editor's «Найти существующее» dialog tab to suggest attachments
 * the user can reuse instead of uploading a fresh copy. The `exclude_owner_*`
 * pair hides rows that already belong to the active owner.
 *
 * No FTS index exists on `attachments`; the search runs as parameterised LIKE.
 * Result order is `created_at DESC` (most recent first).
 */
export function searchAttachments(
  ndb: NetworkDb,
  query: AttachmentSearchQuery,
): { items: Attachment[]; total: number } {
  const keywords = parseFilterKeywords(query.q ?? '');
  if (keywords.include.length === 0) {
    return { items: [], total: 0 };
  }
  const limit = typeof query.limit === 'number' ? Math.max(0, Math.min(200, Math.trunc(query.limit))) : 50;
  const offset = typeof query.offset === 'number' ? Math.max(0, Math.trunc(query.offset)) : 0;

  const where: string[] = [];
  const params: unknown[] = [];
  const fieldConcat =
    "LOWER(COALESCE(title, '') || '\n' || COALESCE(description, '') || '\n' || COALESCE(url, '') || '\n' || COALESCE(file_path, ''))";
  for (const word of keywords.include) {
    const pattern = buildLikePattern(word).toLowerCase();
    where.push(`${fieldConcat} LIKE ? ESCAPE '\\'`);
    params.push(pattern);
  }
  for (const word of keywords.exclude) {
    const pattern = buildLikePattern(word).toLowerCase();
    where.push(`${fieldConcat} NOT LIKE ? ESCAPE '\\'`);
    params.push(pattern);
  }
  if (query.kind !== undefined) {
    where.push('kind = ?');
    params.push(query.kind);
  }
  if (query.exclude_owner_type !== undefined && query.exclude_owner_id !== undefined) {
    // Отбор по владениям (0.12.1, ADR 9f90b010): скрыть вложения, которыми
    // УЖЕ владеет указанный объект.
    where.push(
      'NOT EXISTS (SELECT 1 FROM attachment_owners_v o WHERE o.attachment_id = attachments_v.id AND o.owner_type = ? AND o.owner_id = ?)',
    );
    params.push(query.exclude_owner_type, query.exclude_owner_id);
  }

  const whereSql = where.join(' AND ');
  const totalRow = ndb
    .prepare(`SELECT COUNT(*) AS n FROM attachments_v WHERE ${whereSql}`)
    .get(...params) as { n: number };
  const rows = ndb
    .prepare(
      `SELECT * FROM attachments_v WHERE ${whereSql}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as AttachmentRow[];
  // Владелец в DTO — первичное владение (переходный период, см. блок «Ownership»).
  const items = withOwnershipAggregates(
    ndb,
    rows.map((row) => rowToAttachment(row, primaryOwnership(ndb, row.id))),
  );
  // При отборе `exclude_owner_*` все возвращённые вложения по построению НЕ
  // принадлежат указанному объекту — отмечаем это явно (сущность 109be255).
  if (query.exclude_owner_type !== undefined && query.exclude_owner_id !== undefined) {
    for (const a of items) a.owned_by_current = false;
  }
  return { items, total: totalRow.n };
}

/**
 * Patch an attachment (docs/03-server-api.md §11). Last-write-wins per field;
 * the row has no `version` column so there is no `If-Match` guard. The kind is
 * immutable after creation.
 *
 * Throws `NOT_FOUND` (404) or `VALIDATION_ERROR` (422) when clearing the
 * location field of the current kind.
 */
export function updateAttachment(
  ndb: NetworkDb,
  id: string,
  changes: AttachmentUpdateInput,
  actorUserId: string,
): Attachment {
  return ndb.transaction(() => {
    const current = getAttachmentOrThrow(ndb, id);

    const sets: string[] = [];
    const args: unknown[] = [];
    if (changes.url !== undefined) {
      const url = nullable(changes.url);
      if (current.kind === 'url' && url === null) {
        throw new EtnError('VALIDATION_ERROR', "url cannot be empty for kind='url'", {
          field: 'url',
        });
      }
      sets.push('url = ?');
      args.push(url);
    }
    if (changes.file_path !== undefined) {
      const fp = nullable(changes.file_path);
      if (current.kind === 'file' && fp === null) {
        throw new EtnError('VALIDATION_ERROR', "file_path cannot be empty for kind='file'", {
          field: 'file_path',
        });
      }
      sets.push('file_path = ?');
      args.push(fp);
    }
    if (changes.file_size !== undefined) {
      sets.push('file_size = ?');
      args.push(changes.file_size);
    }
    if (changes.mime_type !== undefined) {
      sets.push('mime_type = ?');
      args.push(nullable(changes.mime_type));
    }
    if (changes.title !== undefined) {
      sets.push('title = ?');
      args.push(nullable(changes.title));
    }
    if (changes.icon !== undefined) {
      const icon = nullable(changes.icon);
      if (icon !== null && !icon.startsWith('data:')) {
        throw new EtnError('VALIDATION_ERROR', 'icon must be a data: URL', {
          field: 'icon',
        });
      }
      sets.push('icon = ?');
      args.push(icon);
    }
    // Moving the attachment to another owner: both fields must describe the
    // target consistently; the new owner must exist (no SQL FK on the table).
    let moved = false;
    let movedType: AttachmentOwnerType = current.owner_type;
    let movedId: string = current.owner_id;
    if (changes.owner_type !== undefined || changes.owner_id !== undefined) {
      const nextType =
        changes.owner_type !== undefined
          ? validateOwnerType(changes.owner_type)
          : current.owner_type;
      const nextId =
        changes.owner_id !== undefined ? nullable(changes.owner_id) : current.owner_id;
      if (nextId === null) {
        throw new EtnError('VALIDATION_ERROR', 'owner_id cannot be empty', {
          field: 'owner_id',
        });
      }
      if (nextType !== current.owner_type || nextId !== current.owner_id) {
        ensureOwnerExists(ndb, nextType, nextId);
        sets.push('owner_type = ?', 'owner_id = ?');
        args.push(nextType, nextId);
        moved = true;
        movedType = nextType;
        movedId = nextId;
      }
    }
    if (changes.description !== undefined) {
      sets.push('description = ?');
      args.push(nullable(changes.description));
    }
    if (changes.position !== undefined) {
      sets.push('position = ?');
      args.push(Math.trunc(changes.position));
    }
    // Колонки авторства обновления (миграция 033, требование e6d4165e).
    // У `attachments` нет своей ISO-колонки `updated_at` — обновляем
    // `updated_by` и `updated_at_ms`, этого достаточно для вкладки «Метаданные».
    const nowMs = Date.now();
    sets.push('updated_by = ?', 'updated_at_ms = ?');
    args.push(actorUserId, nowMs);

    if (sets.length === 0) {
      return current;
    }
    // S4 (13-layers.md §5.1): first edit in a working layer materialises a
    // shadow copy (the table has no version column — the copy is verbatim);
    // the UPDATE targets the connection's layer row only.
    materializeShadow(ndb, 'attachments', id);
    args.push(id, ndb.layerId);
    ndb
      .prepare(`UPDATE attachments SET ${sets.join(', ')} WHERE id = ? AND layer_id = ?`)
      .run(...args);
    // An owner move orphans any thought icon backed by this attachment (L16) —
    // drop the dangling reference (in a working layer: materialise the visible
    // thoughts and null the field in their shadow rows); the icon preview
    // itself stays.
    if (moved) {
      // Перенос владельца (0.12.1): снять прежнее владение и добавить новое
      // (эквивалент addOwners + removeOwner без защиты иконки).
      const srcOwnership = liveOwnership(ndb, id, current.owner_type, current.owner_id);
      if (srcOwnership !== undefined) {
        if (isBaseContext(ndb)) {
          ndb.prepare('DELETE FROM attachment_owners WHERE id = ?').run(srcOwnership.id);
        } else {
          materializeTombstone(ndb, 'attachment_owners', srcOwnership.id);
        }
      }
      if (liveOwnership(ndb, id, movedType, movedId) === undefined) {
        insertOwnership(ndb, id, movedType, movedId, nextOwnerPosition(ndb, movedType, movedId), actorUserId);
      }
      const iconOwners = (
        ndb.prepare('SELECT id FROM thoughts_v WHERE icon_attachment_id = ?').all(id) as {
          id: string;
        }[]
      ).map((r) => r.id);
      for (const ownerId of iconOwners) {
        materializeShadow(ndb, 'thoughts', ownerId);
        ndb
          .prepare(
            'UPDATE thoughts SET icon_attachment_id = NULL WHERE id = ? AND layer_id = ?',
          )
          .run(ownerId, ndb.layerId);
      }
    }
    return getAttachmentOrThrow(ndb, id);
  });
}

/**
 * Best-effort removal of a server-stored upload: only `kind='file'` rows whose
 * `file_path` points **inside the network's `attachments/` directory** are
 * deleted from disk. Client-local paths (drag-and-drop of OS files keeps them
 * on the user's machine) are never touched.
 */
export function removeStoredFile(
  ndb: NetworkDb,
  kind: AttachmentKind,
  filePath: string | null,
): void {
  if (kind !== 'file' || filePath === null) return;
  const storedDir = path.resolve(path.dirname(ndb.dbPath), 'attachments');
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(storedDir + path.sep) && existsSync(resolved)) {
    try {
      rmSync(resolved);
    } catch {
      // File cleanup is best-effort; callers delete the row regardless.
    }
  }
}

/**
 * True when a **live** attachment row still resolves to the same stored file.
 * Callers run this AFTER deleting the row(s) they are purging, so every row
 * left in the table is a real remaining user of the file. Tombstoned rows
 * (`deleted = 1`, 13-layers.md §5.2–§5.3) do not count: the binding is gone
 * from that layer, and a tombstone must not pin the shared file forever.
 */
export function storedFileInUse(ndb: NetworkDb, resolvedPath: string): boolean {
  // layers:physical-read — файл один на все слои (13-layers.md §5.3): его судьбу
  // решают живые привязки ВСЕХ слоёв, а не только разрешённые в текущем контексте.
  const rows = ndb
    .prepare(
      "SELECT file_path FROM attachments WHERE kind = 'file' AND file_path IS NOT NULL AND deleted = 0", // layers:physical-read
    )
    .all() as { file_path: string }[];
  return rows.some((row) => path.resolve(row.file_path) === resolvedPath);
}

/**
 * Delete an attachment (docs/03-server-api.md §11). Throws `NOT_FOUND` (404).
 *
 * S4 (13-layers.md §5.3): in a working layer the deletion materialises a
 * tombstone over the binding only — the physical file is shared by all layers
 * and is never touched from a layer context. Physically (base-layer context)
 * the file goes away with the row — but only when nothing else uses it:
 * another live attachment resolving to the same file keeps it (a second
 * reference is possible via `PATCH …/file_path`), and so does a live thought
 * icon backed by this attachment (`icon_attachment_id`, Ctrl-hover reads the
 * full picture from the file). Otherwise only the row is deleted and the file
 * stays.
 */
export function deleteAttachment(ndb: NetworkDb, id: string): void {
  ndb.transaction(() => {
    const current = getAttachmentOrThrow(ndb, id);
    if (!isBaseContext(ndb)) {
      // A layer never deletes the shared file — tombstone the binding (§5.3).
      materializeTombstone(ndb, 'attachments', id);
      // Владения вложения тоже прячем из слоя (иначе останутся висячие).
      for (const o of listLiveOwners(ndb, id)) {
        materializeTombstone(ndb, 'attachment_owners', o.id);
      }
      return;
    }
    // Check the icon reference BEFORE it is reset below — the file must
    // outlive the row for the icon's full picture (L16). Tombstoned icon
    // references (deleted = 1) do not pin the file: the thought is invisible
    // in that layer anyway.
    // layers:physical-read — файл один на все слои (13-layers.md §5.3): живая иконка в любом слое удерживает его.
    const iconBacksFile =
      current.kind === 'file' &&
      ndb
        .prepare(
          'SELECT 1 FROM thoughts WHERE icon_attachment_id = ? AND deleted = 0 LIMIT 1', // layers:physical-read
        )
        .get(id) !== undefined;
    ndb.prepare('DELETE FROM attachment_owners WHERE attachment_id = ?').run(id);
    ndb.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    // Thoughts may reference this attachment as the backing picture of their
    // icon (L16) — drop the dangling reference; the icon preview itself stays.
    ndb
      .prepare('UPDATE thoughts SET icon_attachment_id = NULL WHERE icon_attachment_id = ?')
      .run(id);
    ndb
      .prepare('UPDATE publications SET cover_attachment_id = NULL WHERE cover_attachment_id = ?')
      .run(id);
    const keepFile =
      iconBacksFile ||
      (current.kind === 'file' &&
        current.file_path !== null &&
        storedFileInUse(ndb, path.resolve(current.file_path)));
    if (!keepFile) removeStoredFile(ndb, current.kind, current.file_path);
  });
}

// ---------------------------------------------------------------------------
// Text content of file attachments (built-in viewer/editor, L7,
// docs/03-server-api.md §11)
// ---------------------------------------------------------------------------

/** Hard cap on the text returned by `GET …/content` (matches the client). */
const CONTENT_TEXT_MAX_CHARS = 200_000;

/**
 * True when the attachment is a `kind='file'` whose content is text-like:
 * `text/*` mime or a `.txt`/`.md`/`.markdown` path. Mirrors the client-side
 * `isViewableText` check (attachments.ts).
 */
function isTextLikeFile(a: Attachment): boolean {
  if (a.kind !== 'file' || a.file_path === null) return false;
  if ((a.mime_type ?? '').startsWith('text/')) return true;
  return /\.(txt|md|markdown)$/i.test(a.file_path);
}

/** True for markdown files (server-rendered `html` in the content response). */
function isMarkdownFile(a: Attachment): boolean {
  const mime = (a.mime_type ?? '').toLowerCase();
  if (mime === 'text/markdown' || mime === 'text/md') return true;
  return /\.(md|markdown)$/i.test(a.file_path ?? '');
}

/**
 * Read the content of a text-like attachment (docs/03-server-api.md §11):
 * the text (truncated at {@link CONTENT_TEXT_MAX_CHARS}) and, for markdown
 * files, the server-rendered html. Non-text attachments return `text: null`.
 *
 * Throws `NOT_FOUND` (404) for a missing attachment and `VALIDATION_ERROR`
 * (422) when the backing file cannot be read.
 */
export function getAttachmentContent(ndb: NetworkDb, id: string): AttachmentContent {
  const a = getAttachmentOrThrow(ndb, id);
  if (!isTextLikeFile(a)) {
    return { mime_type: a.mime_type, text: null, html: null, truncated: false };
  }
  let raw: string;
  try {
    raw = readFileSync(a.file_path!, 'utf8');
  } catch {
    throw new EtnError('VALIDATION_ERROR', 'файл вложения недоступен для чтения', {
      field: 'file_path',
    });
  }
  const truncated = raw.length > CONTENT_TEXT_MAX_CHARS;
  const text = truncated ? raw.slice(0, CONTENT_TEXT_MAX_CHARS) : raw;
  const html = isMarkdownFile(a) ? renderMarkdown(text) : null;
  return { mime_type: a.mime_type, text, html, truncated };
}

/**
 * A server-stored attachment file served as raw bytes (remote clients).
 * `filename` is the base name of the stored copy; `mime_type` falls back to
 * `application/octet-stream` when the row carries no hint.
 */
export interface AttachmentRawFile {
  mime_type: string;
  filename: string;
  body: Buffer;
}

/**
 * Read the raw bytes of a server-stored attachment file by its absolute
 * `file_path` (the path the `etnimg:` scheme of a remote client resolves to).
 *
 * Only files stored **inside the network's `attachments/` directory** (uploads
 * of `POST …/attachments/file`, the same rule as {@link removeStoredFile}) are
 * served: a `file_path` pointing elsewhere belongs to some client's local disk
 * and must not be exposed through the API.
 *
 * Throws `NOT_FOUND` (404) when no `kind='file'` attachment resolves to the
 * path, the path is outside the stored-files directory or the backing file is
 * missing; `VALIDATION_ERROR` (422) when it cannot be read.
 */
export function getAttachmentRawByPath(ndb: NetworkDb, filePath: string): AttachmentRawFile {
  const resolved = path.resolve(filePath);
  const storedDir = path.resolve(path.dirname(ndb.dbPath), 'attachments');
  if (!resolved.startsWith(storedDir + path.sep)) {
    throw new EtnError('NOT_FOUND', 'файл вложения не найден', { field: 'path' });
  }
  const rows = ndb
    .prepare("SELECT mime_type, file_path FROM attachments_v WHERE kind = 'file' AND file_path IS NOT NULL")
    .all() as { mime_type: string | null; file_path: string }[];
  const row = rows.find((r) => path.resolve(r.file_path) === resolved);
  if (row === undefined) {
    throw new EtnError('NOT_FOUND', 'файл вложения не найден', { field: 'path' });
  }
  let body: Buffer;
  try {
    body = readFileSync(resolved);
  } catch {
    throw new EtnError('VALIDATION_ERROR', 'файл вложения недоступен для чтения', {
      field: 'path',
    });
  }
  return {
    mime_type: row.mime_type ?? 'application/octet-stream',
    filename: path.basename(resolved),
    body,
  };
}

/**
 * Overwrite the file of a text-like attachment (docs/03-server-api.md §11).
 * Decodes `data_base64` (≤10 MiB), writes it to `file_path` and refreshes
 * `file_size`/`mime_type` in the row. Last-write-wins (no version column).
 *
 * Throws `NOT_FOUND` (404), `VALIDATION_ERROR` (422) for a non-text
 * attachment, a bad payload, an unwritable file or a markdown body longer than
 * the renderer limit (checked before the file/row are touched, error 9f2e94b0).
 */
export function updateAttachmentContent(
  ndb: NetworkDb,
  id: string,
  input: AttachmentContentUpdateInput,
): AttachmentContentUpdateResult {
  return ndb.transaction(() => {
    const current = getAttachmentOrThrow(ndb, id);
    if (!isTextLikeFile(current)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'контент доступен только для текстовых вложений',
        { field: 'id' },
      );
    }

    const b64 = input.data_base64.replace(/^data:[^,]*,/, '').trim();
    if (b64 === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      throw new EtnError('VALIDATION_ERROR', 'data_base64 must be base64 content', {
        field: 'data_base64',
      });
    }
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    const bytes = Math.floor((b64.length * 3) / 4) - padding;
    if (bytes < 0 || bytes > ATTACHMENT_FILE_MAX_BYTES) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `file exceeds the ${ATTACHMENT_FILE_MAX_BYTES} byte limit (${bytes})`,
        { field: 'data_base64', limit: ATTACHMENT_FILE_MAX_BYTES },
      );
    }
    const buffer = Buffer.from(b64, 'base64');
    if (buffer.length !== bytes) {
      throw new EtnError('VALIDATION_ERROR', 'data_base64 is not valid base64', {
        field: 'data_base64',
      });
    }

    const nextMime =
      input.mime_type !== undefined && input.mime_type.trim() !== ''
        ? input.mime_type.trim().toLowerCase()
        : current.mime_type;
    const text = buffer.toString('utf8');
    const markdown = isMarkdownFile({ ...current, mime_type: nextMime });
    // Лимит рендера проверяется ДО `renderMarkdown` (ошибка 9f2e94b0, тот же
    // класс, что уже исправленный 2764d7bb): единый рендерер отвергает источник
    // длиннее DEFAULT_MAX_LENGTH обычным `Error`, который глобальный обработчик
    // мапит в 500 INTERNAL. Это клиентская ошибка ввода, а не внутренняя.
    // Граница включительна: ровно DEFAULT_MAX_LENGTH символов допустимо.
    if (markdown && text.length > DEFAULT_MAX_LENGTH) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `содержимое вложения превышает лимит рендера (${text.length} > ${DEFAULT_MAX_LENGTH} символов).`,
        { field: 'data_base64', limit: DEFAULT_MAX_LENGTH },
      );
    }
    // Рендер — тоже до записи: любой его сбой не должен оставлять
    // перезаписанный файл при откатанной транзакции (рассогласование файла и БД).
    const html = markdown ? renderMarkdown(text) : null;

    try {
      writeFileSync(current.file_path!, buffer);
    } catch {
      throw new EtnError('VALIDATION_ERROR', 'не удалось записать файл вложения', {
        field: 'file_path',
      });
    }

    // Запись контента — это правка вложения: обновляем `updated_by` и
    // `updated_at_ms` (требование e6d4165e; ISO-колонки `updated_at` у
    // `attachments` исторически нет). Актор — создатель вложения; смена
    // владельца файла идёт отдельным PATCH и имеет своего актора через REST/MCP.
    const nowMs = Date.now();
    materializeShadow(ndb, 'attachments', id);
    ndb
      .prepare(
        'UPDATE attachments SET file_size = ?, mime_type = ?, updated_by = ?, updated_at_ms = ? WHERE id = ? AND layer_id = ?',
      )
      .run(buffer.length, nextMime, current.updated_by || current.created_by, nowMs, id, ndb.layerId);

    return { html };
  });
}

// ---------------------------------------------------------------------------
// URL enrichment (title + favicon), workplan L1
// ---------------------------------------------------------------------------

/** Fetch timeout for page/icon requests. */
const ENRICH_TIMEOUT_MS = 4000;
/** Max bytes of HTML read for title/favicon extraction. */
const ENRICH_HTML_MAX_BYTES = 512 * 1024;
/** Max favicon bytes stored as a `data:` URL. */
const FAVICON_MAX_BYTES = 64 * 1024;

/** Extract `<title>` text from an HTML document (null when absent/empty). */
export function extractHtmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null || match[1] === undefined) return null;
  const decoded = match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return decoded === '' ? null : decoded.slice(0, 300);
}

/**
 * Resolve the favicon URL declared by `link rel=…icon…` elements, falling back
 * to `/favicon.ico` at the site root. Returns an absolute URL or null.
 */
export function extractFaviconUrl(html: string, baseUrl: string): string | null {
  const attr = (tag: string, name: string): string => {
    const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    return (m?.[2] ?? m?.[3] ?? m?.[4] ?? '').trim();
  };
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attr(tag, 'rel').toLowerCase();
    const relOk = rel
      .split(/\s+/)
      .some((r) => r === 'icon' || r === 'shortcut' || r === 'apple-touch-icon');
    if (!relOk) continue;
    const href = attr(tag, 'href');
    if (href === '') continue;
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      // malformed href — try the next link tag
    }
  }
  try {
    return new URL('/favicon.ico', baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Best-effort enrichment of a URL attachment (03-server-api.md §11): fetch the
 * page, fill the missing `title` from `<title>` and store the site favicon as
 * a `data:` URL in `icon`. Network failures are silently ignored — the
 * attachment stays as created.
 */
export async function enrichUrlAttachment(
  ndb: NetworkDb,
  attachment: Attachment,
  fetchImpl: typeof fetch = fetch,
): Promise<Attachment> {
  if (attachment.kind !== 'url' || attachment.url === null) return attachment;
  const changes: { title?: string; icon?: string | null } = {};
  try {
    const res = await fetchImpl(attachment.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
      headers: { 'user-agent': 'ETN-attachment-enricher' },
    });
    if (res.ok && (res.headers.get('content-type') ?? '').includes('text/html')) {
      const html = (await res.text()).slice(0, ENRICH_HTML_MAX_BYTES);
      if (attachment.title === null) {
        const title = extractHtmlTitle(html);
        if (title !== null) changes.title = title;
      }
      const iconUrl = extractFaviconUrl(html, attachment.url);
      if (iconUrl !== null) {
        const icon = await fetchFavicon(fetchImpl, iconUrl);
        if (icon !== null) changes.icon = icon;
      }
    }
  } catch {
    return attachment;
  }
  if (changes.title === undefined && changes.icon === undefined) return attachment;
  try {
    // URL enrichment is triggered by the same user who created the attachment;
    // attribute the auto-update to them so the timeline shows the moment.
    return updateAttachment(ndb, attachment.id, changes, attachment.created_by);
  } catch {
    return attachment;
  }
}

/** Fetch a favicon and encode it as a `data:` URL (null when unusable). */
async function fetchFavicon(fetchImpl: typeof fetch, url: string): Promise<string | null> {
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
      headers: { 'user-agent': 'ETN-attachment-enricher' },
    });
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!mime.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > FAVICON_MAX_BYTES) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}
