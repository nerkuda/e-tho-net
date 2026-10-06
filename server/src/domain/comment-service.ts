/**
 * Comment domain service (task C7, docs/03-server-api.md §10,
 * docs/02-data-model.md §3.8).
 *
 * Comments are polymorphic: they attach to thoughts or links. A chronological
 * comment may be attached to **several** owners at once (L20): the m2m table
 * `comment_targets` holds the full set, while `comments.owner_type/owner_id`
 * keep the primary (first) attachment. Two kinds exist:
 *   * `permanent` — at most **one** per owner (enforced by the partial unique
 *     index `idx_comments_permanent_one`) and always exactly one target;
 *     `valid_from = created_at`, `valid_to = NULL`.
 *   * `chronological` — unrestricted count; carries `valid_from`/`valid_to`
 *     (always full UTC instants; `valid_to` is never empty — unset equals
 *     `valid_from`, 0.10.1) and 1..N targets. Detaching the last target
 *     re-attaches the comment to the network HOME thought.
 *
 * The server renders and caches `body_html` from `body_md` via the safe
 * {@link renderMarkdown} renderer. Mutating calls accept an optional
 * `expectedVersion` for the `If-Match` optimistic-concurrency contract.
 */

import { randomUUID } from 'node:crypto';

import {
  CHRONO_PREVIEW_MAX_ENTRIES,
  COMMENT_KINDS,
  COMMENT_OWNER_TYPES,
  COMMENT_PREVIEW_CHARS,
  COMMENT_TARGETS_MAX,
  EtnError,
  type Comment,
  type CommentInput,
  type CommentKind,
  type CommentOwnerType,
  type CommentTarget,
  type CommentUpdateInput,
  type CommentsPreview,
  type MutationWarning,
  type PermanentCommentFull,
  type PermanentCommentPreview,
} from '@etn/shared';

import { DEFAULT_MAX_LENGTH, renderMarkdown } from '@etn/markdown';

import { applySectionOps, type EditOp } from './markdown-sections.js';
import { normaliseInstant } from './dates.js';
import { enforceLock } from './lock-service.js';
import type { BodyExpander } from './transclusion-service.js';
import { transclusionLossWarning } from './transclusion-service.js';
import type { NetworkDb } from '../db/network-db.js';
import {
  deleteRowLayered,
  isBaseContext,
  materializeShadow,
  materializeTombstone,
} from '../db/layer-write.js';

/** Raw `comments` row shape (dates as strings, no booleans). */
interface CommentRow {
  id: string;
  owner_type: string;
  owner_id: string;
  kind: string;
  title: string | null;
  body_md: string;
  body_html: string;
  valid_from: string;
  valid_to: string | null;
  use_time: number;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  created_at_ms: number;
  updated_at_ms: number;
}

/** Convert a raw row into a {@link Comment} (targets are attached separately). */
function rowToComment(row: CommentRow, targets: CommentTarget[] = []): Comment {
  return {
    id: row.id,
    owner_type: row.owner_type as CommentOwnerType,
    owner_id: row.owner_id,
    targets: orderTargets(row, targets),
    kind: row.kind as CommentKind,
    title: row.title,
    body_md: row.body_md,
    body_html: row.body_html,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    use_time: row.use_time === 1,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

/** Stable targets order: the primary owner first, then the rest as stored. */
function orderTargets(row: { owner_type: string; owner_id: string }, targets: CommentTarget[]): CommentTarget[] {
  const primary = targets.filter((t) => t.owner_type === row.owner_type && t.owner_id === row.owner_id);
  const rest = targets.filter((t) => t.owner_type !== row.owner_type || t.owner_id !== row.owner_id);
  return [...primary, ...rest];
}

/**
 * Load the m2m targets of the given comments in one query, grouped by comment
 * id. Rows whose target set is somehow missing fall back to the primary owner
 * (keeps the «at least one target» invariant even on partially-lost data).
 */
function loadTargets(
  ndb: NetworkDb,
  rows: Array<{ id: string; owner_type: string; owner_id: string }>,
): Map<string, CommentTarget[]> {
  const map = new Map<string, CommentTarget[]>();
  if (rows.length === 0) return map;
  const placeholders = rows.map(() => '?').join(', ');
  const targetRows = ndb
    .prepare(
      `SELECT comment_id, owner_type, owner_id FROM comment_targets_v
       WHERE comment_id IN (${placeholders})`,
    )
    .all(...rows.map((r) => r.id)) as Array<{ comment_id: string; owner_type: string; owner_id: string }>;
  for (const tr of targetRows) {
    const list = map.get(tr.comment_id) ?? [];
    list.push({ owner_type: tr.owner_type as CommentOwnerType, owner_id: tr.owner_id });
    map.set(tr.comment_id, list);
  }
  for (const r of rows) {
    if (!map.has(r.id)) {
      map.set(r.id, [{ owner_type: r.owner_type as CommentOwnerType, owner_id: r.owner_id }]);
    }
  }
  return map;
}

/** Validate a comment kind against the enum tuple. */
function validateKind(kind: unknown): CommentKind {
  if (typeof kind !== 'string' || !(COMMENT_KINDS as readonly string[]).includes(kind)) {
    throw new EtnError('VALIDATION_ERROR', `invalid comment kind: ${String(kind)}`, {
      field: 'kind',
      allowed: COMMENT_KINDS,
    });
  }
  return kind as CommentKind;
}

/** Validate a polymorphic owner type against the enum tuple. */
function validateOwnerType(ownerType: unknown): CommentOwnerType {
  if (
    typeof ownerType !== 'string' ||
    !(COMMENT_OWNER_TYPES as readonly string[]).includes(ownerType)
  ) {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${String(ownerType)}`, {
      field: 'owner_type',
      allowed: COMMENT_OWNER_TYPES,
    });
  }
  return ownerType as CommentOwnerType;
}

/**
 * Id защищённой HOME-мысли сети (`is_root = 1`), или `null`, когда её нет.
 * Локальная копия запроса из `thought-service.getHomeThoughtId`: импорт оттуда
 * замкнул бы цикл — `thought-service` уже импортирует этот модуль.
 */
function homeThoughtId(ndb: NetworkDb): string | null {
  const row = ndb.prepare('SELECT id FROM thoughts_v WHERE is_root = 1 LIMIT 1').get() as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

/** Непустой текст: строка, у которой после `trim()` остались символы. */
function isNonEmptyText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Лимит рендера тела комментария (ошибка 2764d7bb, требование 99055dba):
 * единый рендерер `@etn/markdown` отвергает источник длиннее
 * {@link DEFAULT_MAX_LENGTH} обычным `Error`, который глобальный обработчик
 * превращал в `500 INTERNAL`. Проверяем длину ДО рендера и отвечаем
 * `422 VALIDATION_ERROR` с `details.field` — это клиентская ошибка ввода, а не
 * внутренняя. Граница включительна: ровно {@link DEFAULT_MAX_LENGTH} символов
 * допустимо, отвергается только превышение.
 *
 * @param bodyMd - тело в формате Markdown.
 * @param field - путь поля тела в исходном запросе для `details.field`
 *   (`body_md` для `POST /comments`, `comment.body_md` для `POST /thoughts`).
 */
function assertBodyWithinRenderLimit(bodyMd: string, field: string): void {
  if (bodyMd.length > DEFAULT_MAX_LENGTH) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `body_md превышает лимит рендера (${bodyMd.length} > ${DEFAULT_MAX_LENGTH} символов).`,
      { field, limit: DEFAULT_MAX_LENGTH },
    );
  }
}

/**
 * Опции создания комментария.
 */
export interface CreateCommentOptions {
  /**
   * Путь поля тела в исходном запросе для `details.field` при превышении лимита
   * рендера (ошибка 2764d7bb). По умолчанию `body_md`.
   */
  bodyField?: string;
}

/**
 * Есть ли у записи содержательная привязка — цель, отличная от HOME-мысли
 * (требование 26f0aa52): владелец HOME — первичная привязка, а не чипс.
 * Связь или любая чужая мысль считается содержанием записи.
 */
function hasBindingOutsideHome(ndb: NetworkDb, targets: readonly CommentTarget[]): boolean {
  const home = homeThoughtId(ndb);
  if (home === null) return targets.length > 0;
  return targets.some((t) => !(t.owner_type === 'thought' && t.owner_id === home));
}

/**
 * Object-lock enforcement for comment writes (ошибка 68be6829, требование
 * `647fa34a`, ADR `fdb1a271`). Комментарий — часть содержимого своего
 * владельца, поэтому запись в комментарий (создание/правка/удаление) обязана
 * подчиняться тому же захвату, что и правка самой мысли: пока владелец-мысль
 * захвачен другим участником, сервер отвечает `409 LOCKED`. Ранее `enforceLock`
 * вызывался только в `thought-service` — правка комментария захваченной мысли
 * проходила мимо блокировки, из-за чего запись блока трансклюзии в источник не
 * отклонялась.
 *
 * Проверяются все цели комментария (`comment_targets`, L20): блокировка любой
 * из них запрещает запись. Ребро-владелец (инлайн-комментарий связи) тоже
 * проверяется — тип сущности берётся из цели. `actorUserId = null` пропускает
 * проверку (системные операции), как и в {@link enforceLock}.
 */
function enforceCommentLocks(
  ndb: NetworkDb,
  targets: readonly CommentTarget[],
  actorUserId: string | null,
): void {
  for (const t of targets) {
    enforceLock(ndb, t.owner_type, t.owner_id, actorUserId);
  }
}

/**
 * Ensure the polymorphic owner exists. Comments have no SQL FK, so this guard
 * prevents orphaned comments and gives the caller a precise 404. Reads through
 * the layer-resolving views (13-layers.md §4.2): an owner tombstoned in the
 * connection's layer is a valid 404 for a layer-scoped comment.
 */
function ensureOwnerExists(ndb: NetworkDb, ownerType: CommentOwnerType, ownerId: string): void {
  const table = ownerType === 'thought' ? 'thoughts_v' : 'links_v';
  const row = ndb.prepare(`SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`).get(ownerId);
  if (!row) {
    throw new EtnError('NOT_FOUND', `${ownerType} ${ownerId} not found`, {
      entity: ownerType,
      id: ownerId,
    });
  }
}

/**
 * Сдвинуть «последнюю активность» владельца при изменении его комментариев
 * (ошибка 228df7a4): добавление/правка/удаление комментария меняет хронологию
 * владельца, поэтому `updated_at`/`updated_at_ms`/`updated_by` обязаны
 * обновиться — иначе фильтры и сортировки по `updated_at` не видят свежую
 * запись, а карточка выглядит «не обновлявшейся».
 *
 * `version` НЕ трогаем: ревизия содержимого владельца (для optimistic
 * concurrency, требование c9cd976b) от активности комментариев не меняется —
 * правка комментария роняет свою версию сама. Это осознанное отличие от
 * `touchOwner` в `property-service.ts`, где правка значения приравнена к правке
 * владельца требованием e6d4165e (там версия растёт).
 *
 * Открывает теневую копию владельца в текущем слое (S4) и обновляет только
 * строку этого слоя — как остальные доменные записи.
 */
function touchOwnerActivity(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerId: string,
  actorUserId: string,
): void {
  const table = ownerType === 'thought' ? 'thoughts' : 'links';
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  materializeShadow(ndb, table, ownerId);
  ndb
    .prepare(
      `UPDATE ${table} SET updated_at = ?, updated_by = ?, updated_at_ms = ? WHERE id = ? AND layer_id = ?`,
    )
    .run(now, actorUserId, nowMs, ownerId, ndb.layerId);
}

/** Return a comment by id, or `null` when absent. */
export function getComment(ndb: NetworkDb, id: string): Comment | null {
  const row = ndb.prepare('SELECT * FROM comments_v WHERE id = ? LIMIT 1').get(id) as
    CommentRow | undefined;
  if (row === undefined) return null;
  const targets = loadTargets(ndb, [row]).get(id) ?? [];
  return rowToComment(row, targets);
}

/** Return a comment or throw `NOT_FOUND` (404). */
function getCommentOrThrow(ndb: NetworkDb, id: string): Comment {
  const comment = getComment(ndb, id);
  if (!comment) {
    throw new EtnError('NOT_FOUND', `comment ${id} not found`, { entity: 'comment', id });
  }
  return comment;
}

/**
 * List comments attached to an owner (docs/03-server-api.md §10) — the primary
 * `owner_type/owner_id` pair plus every m2m attachment in `comment_targets`
 * (L20). The permanent comment (if any) sorts first, then chronological
 * comments ordered by `valid_from` ascending.
 */
export function listComments(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerId: string,
): Comment[] {
  validateOwnerType(ownerType);
  const rows = ndb
    .prepare(
      `SELECT * FROM comments_v c
       WHERE (c.owner_type = ? AND c.owner_id = ?)
          OR EXISTS (
            SELECT 1 FROM comment_targets_v ct
            WHERE ct.comment_id = c.id AND ct.owner_type = ? AND ct.owner_id = ?
          )
       ORDER BY (c.kind <> 'permanent'), c.valid_from ASC, c.created_at ASC`,
    )
    .all(ownerType, ownerId, ownerType, ownerId) as CommentRow[];
  const targets = loadTargets(ndb, rows);
  return rows.map((row) => rowToComment(row, targets.get(row.id) ?? []));
}

/**
 * Превью постоянного комментария (tasks N2/N5): `body_md` — первые
 * {@link COMMENT_PREVIEW_CHARS} символов с метаданными обрезки; `null`, когда
 * постоянного комментария нет. Один SELECT по частичному уникальному индексу
 * `idx_comments_permanent_one`.
 */
export function getPermanentPreview(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerId: string,
  previewChars: number = COMMENT_PREVIEW_CHARS,
  bodyTransform?: BodyExpander,
): PermanentCommentPreview | null {
  validateOwnerType(ownerType);
  const row = ndb
    .prepare(
      `SELECT id, body_md, valid_from, created_at, updated_at FROM comments_v
       WHERE owner_type = ? AND owner_id = ? AND kind = 'permanent'
       LIMIT 1`,
    )
    .get(ownerType, ownerId) as
    | {
        id: string;
        body_md: string;
        valid_from: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (row === undefined) {
    return null;
  }
  // Трансформация — над ПОЛНЫМ телом, до обрезки превью: иначе развёрнутая
  // трансклюзия разошлась бы с `chars_total`/`truncated` и пробила бы бюджет
  // превью. Транспорт-агностично: REST не передаёт `bodyTransform`.
  const body = bodyTransform === undefined ? row.body_md : bodyTransform(row.body_md);
  const chars_total = body.length;
  const chars_returned = Math.min(chars_total, previewChars);
  return {
    id: row.id,
    body_md: body.slice(0, chars_returned),
    chars_returned,
    chars_total,
    truncated: chars_total > chars_returned,
    valid_from: row.valid_from,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Полный (без обрезки) постоянный комментарий — задача 3ea09a54
 * «Условная обрезка текстов в ответах MCP». Возвращается из
 * `etn.thoughts.get` в `meta.permanent` — единственный случай, когда
 * постоянный комментарий отдаётся целиком без метаданных `chars_*`/
 * `truncated`. Тот же SELECT, что в {@link getPermanentPreview}, без
 * усечения тела.
 */
export function getPermanentFull(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerId: string,
  bodyTransform?: BodyExpander,
): PermanentCommentFull | null {
  validateOwnerType(ownerType);
  const row = ndb
    .prepare(
      `SELECT id, body_md, valid_from, created_at, updated_at FROM comments_v
       WHERE owner_type = ? AND owner_id = ? AND kind = 'permanent'
       LIMIT 1`,
    )
    .get(ownerType, ownerId) as
    | {
        id: string;
        body_md: string;
        valid_from: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    body_md: bodyTransform === undefined ? row.body_md : bodyTransform(row.body_md),
    valid_from: row.valid_from,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Превью комментариев владельца (task N5, MCP `etn.thoughts.subgraph` с
 * `include_comments`): постоянный — через {@link getPermanentPreview};
 * хронология — последние {@link CHRONO_PREVIEW_MAX_ENTRIES} записей (по
 * `valid_from` DESC, затем `created_at` DESC), каждая с телом не длиннее
 * {@link COMMENT_PREVIEW_CHARS} и метаданными обрезки. Уровень списка несёт
 * `total`/`returned`/`truncated` — агент видит, что записей больше и полные
 * доступны отдельным запросом.
 *
 * Пределы превью настраиваются `previewChars` — обзорные перечни (subgraph)
 * ужимают постоянный комментарий сильнее (600 символов), сохраняя хронологию
 * в {@link COMMENT_PREVIEW_CHARS}.
 */
export function getCommentsPreview(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerId: string,
  previewChars: { permanent?: number; chronological?: number } = {},
  bodyTransform?: BodyExpander,
): CommentsPreview {
  validateOwnerType(ownerType);
  const permanentChars = previewChars.permanent ?? COMMENT_PREVIEW_CHARS;
  const chronoChars = previewChars.chronological ?? COMMENT_PREVIEW_CHARS;
  const permanent = getPermanentPreview(ndb, ownerType, ownerId, permanentChars, bodyTransform);
  const total = (
    ndb
      .prepare(
        `SELECT COUNT(*) AS c FROM comments_v c
         WHERE c.kind = 'chronological'
           AND ((c.owner_type = ? AND c.owner_id = ?)
                OR EXISTS (
                  SELECT 1 FROM comment_targets_v ct
                  WHERE ct.comment_id = c.id AND ct.owner_type = ? AND ct.owner_id = ?
                ))`,
      )
      .get(ownerType, ownerId, ownerType, ownerId) as { c: number }
  ).c;
  const rows = ndb
    .prepare(
      `SELECT c.id, c.title, c.body_md, c.valid_from, c.valid_to, c.created_by, c.created_at
       FROM comments_v c
       WHERE c.kind = 'chronological'
         AND ((c.owner_type = ? AND c.owner_id = ?)
              OR EXISTS (
                SELECT 1 FROM comment_targets_v ct
                WHERE ct.comment_id = c.id AND ct.owner_type = ? AND ct.owner_id = ?
              ))
       ORDER BY c.valid_from DESC, c.created_at DESC
       LIMIT ?`,
    )
    .all(ownerType, ownerId, ownerType, ownerId, CHRONO_PREVIEW_MAX_ENTRIES) as Array<{
    id: string;
    title: string | null;
    body_md: string;
    valid_from: string;
    valid_to: string | null;
    created_by: string;
    created_at: string;
  }>;
  const entries = rows.map((row) => {
    const body = bodyTransform === undefined ? row.body_md : bodyTransform(row.body_md);
    const chars_total = body.length;
    const chars_returned = Math.min(chars_total, chronoChars);
    return {
      id: row.id,
      title: row.title,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      created_by: row.created_by,
      created_at: row.created_at,
      body_md: body.slice(0, chars_returned),
      chars_returned,
      chars_total,
      truncated: chars_total > chars_returned,
    };
  });
  return {
    permanent,
    chronological: {
      entries,
      total,
      returned: entries.length,
      truncated: entries.length < total,
    },
  };
}

/**
 * Create a comment attached to a single owner (docs/03-server-api.md §10).
 * Backwards-compatible wrapper over {@link createCommentWithTargets} (L20).
 *
 * @param actorUserId - user creating the comment (recorded as created_by/updated_by).
 */
export function createComment(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerId: string,
  input: CommentInput,
  actorUserId: string,
  options: CreateCommentOptions = {},
): Comment {
  return createCommentWithTargets(
    ndb,
    [{ owner_type: ownerType, owner_id: ownerId }],
    input,
    actorUserId,
    options,
  );
}

/**
 * Create a comment attached to one or more owners at once (L20,
 * docs/03-server-api.md §10). The first target becomes the primary
 * `owner_type/owner_id`; all targets (including the primary) are written to
 * `comment_targets`. Duplicate targets are collapsed. A `permanent` comment
 * must have exactly one target.
 *
 * Throws:
 *   * `VALIDATION_ERROR` (422) for an invalid kind/targets or missing content —
 *     a `permanent` comment needs a non-empty `body_md`, a `chronological` one
 *     at least one of: non-empty `body_md`, non-empty `title`, or a target
 *     other than HOME (требование 26f0aa52);
 *   * `NOT_FOUND` (404) if any target owner does not exist;
 *   * `DUPLICATE` (409) on a second `permanent` comment for the same owner.
 *
 * For `kind = 'permanent'` the `valid_from`/`valid_to` inputs are ignored
 * (`valid_from` becomes `created_at`, `valid_to` is `NULL`). For chronological
 * comments `valid_from` defaults to now, `valid_to` defaults to `valid_from`
 * (0.10.1: `valid_to` у хронологической обязателен). Входные даты принимаются
 * как полный UTC-инстанс или «голая дата» (= сутки UTC) и нормализуются
 * {@link normaliseInstant}; date-only в хранилище не попадает.
 */
export function createCommentWithTargets(
  ndb: NetworkDb,
  rawTargets: CommentTarget[],
  input: CommentInput,
  actorUserId: string,
  options: CreateCommentOptions = {},
): Comment {
  const kind = validateKind(input.kind);
  // Dedup targets preserving order; validate owner types and ids.
  const seen = new Set<string>();
  const targets: CommentTarget[] = [];
  for (const t of rawTargets) {
    const ot = validateOwnerType(t.owner_type);
    if (typeof t.owner_id !== 'string' || t.owner_id === '') {
      throw new EtnError('VALIDATION_ERROR', 'owner_id must be a non-empty string', {
        field: 'targets',
      });
    }
    const key = `${ot}|${t.owner_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ owner_type: ot, owner_id: t.owner_id });
  }
  if (targets.length === 0) {
    throw new EtnError('VALIDATION_ERROR', 'at least one target is required', {
      field: 'targets',
    });
  }
  if (targets.length > COMMENT_TARGETS_MAX) {
    throw new EtnError('VALIDATION_ERROR', `at most ${COMMENT_TARGETS_MAX} targets are allowed`, {
      field: 'targets',
      max: COMMENT_TARGETS_MAX,
    });
  }
  if (kind === 'permanent' && targets.length > 1) {
    throw new EtnError('VALIDATION_ERROR', 'a permanent comment has exactly one owner', {
      field: 'targets',
    });
  }
  // Содержание записи (требование 26f0aa52). Постоянный комментарий — это
  // содержимое мысли, поэтому `body_md` обязателен. Хронологическая запись
  // может создаваться по заголовку или привязке (владелец HOME — первичная
  // привязка, не чипс): пустой `body_md` допустим, пока есть непустой заголовок
  // либо цель вне HOME. Содержание проверяется ПОСЛЕ сборки целей, т.к. зависит
  // от набора привязок.
  if (kind === 'permanent') {
    if (!isNonEmptyText(input.body_md)) {
      throw new EtnError('VALIDATION_ERROR', 'body_md must be a non-empty string', {
        field: 'body_md',
      });
    }
  } else if (
    !isNonEmptyText(input.body_md) &&
    !isNonEmptyText(input.title) &&
    !hasBindingOutsideHome(ndb, targets)
  ) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'a chronological comment must carry content: a non-empty body_md or title, ' +
        'or a target other than HOME',
      { field: 'content' },
    );
  }
  const bodyMd = input.body_md ?? '';
  // Лимит рендера проверяется ДО `renderMarkdown` (ошибка 2764d7bb): иначе
  // единый рендерер бросил бы обычный `Error` и запрос ушёл бы в 500.
  assertBodyWithinRenderLimit(bodyMd, options.bodyField ?? 'body_md');
  const bodyHtml = renderMarkdown(bodyMd);

  return ndb.transaction(() => {
    for (const t of targets) {
      ensureOwnerExists(ndb, t.owner_type, t.owner_id);
    }
    // Захват владельца запрещает запись комментария (ошибка 68be6829).
    enforceCommentLocks(ndb, targets, actorUserId);

    const primary = targets[0];
    if (primary === undefined) {
      throw new EtnError('VALIDATION_ERROR', 'at least one target is required', {
        field: 'targets',
      });
    }
    if (kind === 'permanent') {
      // Enforce the "one permanent per owner" invariant ahead of the unique
      // index so we can raise the canonical DUPLICATE error explicitly.
      const existing = ndb
        .prepare(
          `SELECT 1 FROM comments_v
           WHERE owner_type = ? AND owner_id = ? AND kind = 'permanent' LIMIT 1`,
        )
        .get(primary.owner_type, primary.owner_id);
      if (existing) {
        throw new EtnError('DUPLICATE', 'a permanent comment already exists for this owner', {
          owner_type: primary.owner_type,
          owner_id: primary.owner_id,
        });
      }
    }

    const id = randomUUID();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const title = input.title === undefined ? null : input.title;
    // Permanent comments ignore the validity window (docs/02-data-model.md §3.8).
    const validFrom =
      kind === 'permanent' ? now : (normaliseInstant(input.valid_from, 'valid_from', 'start') ?? now);
    // У хронологической записи `valid_to` обязателен: не задан (или пуст) —
    // равен `valid_from` (0.10.1, ADR 994d076a); у постоянной всегда NULL.
    const validTo =
      kind === 'permanent'
        ? null
        : (normaliseInstant(input.valid_to, 'valid_to', 'end') ?? validFrom);
    // Флаг «учитывать время» — на формат дат не влияет; по умолчанию выключен.
    const useTime = input.use_time === true ? 1 : 0;

    ndb
      .prepare(
        `INSERT INTO comments (id, layer_id, owner_type, owner_id, kind, title, body_md, body_html,
                               valid_from, valid_to, use_time, version,
                               created_at, updated_at, created_by, updated_by,
                               created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ndb.layerId,
        primary.owner_type,
        primary.owner_id,
        kind,
        title,
        bodyMd,
        bodyHtml,
        validFrom,
        validTo,
        useTime,
        now,
        now,
        actorUserId,
        actorUserId,
        nowMs,
        nowMs,
      );
    const insertTarget = ndb.prepare(
      'INSERT INTO comment_targets (comment_id, owner_type, owner_id, layer_id) VALUES (?, ?, ?, ?)',
    );
    for (const t of targets) {
      insertTarget.run(id, t.owner_type, t.owner_id, ndb.layerId);
    }
    // Комментарий появился у владельца — двигаем его «последнюю активность»
    // (ошибка 228df7a4).
    for (const t of targets) {
      touchOwnerActivity(ndb, t.owner_type, t.owner_id, actorUserId);
    }
    return getCommentOrThrow(ndb, id);
  });
}

/**
 * Options of {@link updateComment}.
 */
export interface UpdateCommentOptions {
  /**
   * Отключает защиту «`body_md` не пустое» для вызовов из {@link editComment}
   * (граница 154df95d).
   */
  allowEmptyBody?: boolean;
  /**
   * Коллектор предупреждений записи (требование `822a9149`). Если правка
   * `body_md` теряет существовавшие ранее живые трансклюзии, домен добавляет
   * сюда `TRANSCLUSION_LOST`-предупреждение; сама запись при этом применяется.
   * Так все пути записи комментария (REST PATCH, `etn.comments.update/edit`,
   * комментарий батча `etn.thoughts.write`) получают проверку из одного места,
   * не меняя тип возврата {@link Comment}.
   */
  warnings?: MutationWarning[];
  /**
   * Путь поля тела в исходном запросе для `details.field` при превышении лимита
   * рендера (ошибка 2764d7bb). По умолчанию `body_md`.
   */
  bodyField?: string;
}

/**
 * Patch a comment (docs/03-server-api.md §10). Last-write-wins per field;
 * `body_html` is re-rendered whenever `body_md` changes. `version` is bumped
 * on every successful update.
 *
 * `options.allowEmptyBody` — отключает защиту «`body_md` не пустое» для
 * вызовов из {@link editComment}: удаление единственной секции текста без `#`
 * оставляет пустое тело, но запись в БД сохраняется (граница 154df95d). По
 * умолчанию `false` — REST `PATCH /comments/{id}` и `etn.comments.update`
 * продолжают отвергать опустошение записи.
 *
 * `options.warnings` — коллектор предупреждений записи (требование
 * `822a9149`): правка, теряющая живые трансклюзии, добавляет туда
 * `TRANSCLUSION_LOST`, но всё равно применяется.
 *
 * Содержание (требование 26f0aa52): постоянный комментарий всегда требует
 * непустой `body_md`; хронологическая запись вне `allowEmptyBody` не может
 * стать полностью пустой — правка отвергается, если после неё нет ни
 * непустого `body_md`, ни заголовка, ни привязки вне HOME.
 *
 * Throws `NOT_FOUND` (404), `VERSION_CONFLICT` (409), or `VALIDATION_ERROR`
 * (422) when the edit would leave the comment without content and
 * `allowEmptyBody` is not set.
 */
export function updateComment(
  ndb: NetworkDb,
  id: string,
  changes: CommentUpdateInput,
  expectedVersion: number | undefined,
  actorUserId: string,
  options: UpdateCommentOptions = {},
): Comment {
  return ndb.transaction(() => {
    const current = getCommentOrThrow(ndb, id);
    // Захват владельца запрещает правку его комментария (ошибка 68be6829;
    // требование 647fa34a/ADR fdb1a271 для записи блока трансклюзии в источник).
    enforceCommentLocks(ndb, current.targets, actorUserId);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'comment version mismatch', {
        entity: 'comment',
        id,
        expected: expectedVersion,
        current: current.version,
      });
    }
    // Проверка потери живых трансклюзий (требование 822a9149) — ДО применения
    // правки: предупреждение собирается из «старого → нового» тела, но саму
    // запись не отменяет.
    if (changes.body_md !== undefined && options.warnings !== undefined) {
      const warning = transclusionLossWarning(current.body_md, changes.body_md);
      if (warning !== null) options.warnings.push(warning);
    }

    const sets: string[] = [];
    const args: unknown[] = [];
    if (changes.title !== undefined) {
      sets.push('title = ?');
      args.push(changes.title);
    }
    if (changes.body_md !== undefined) {
      // У постоянного комментария пустое тело — потеря содержимого мысли, вне
      // явного `allowEmptyBody` (граница 154df95d) запрещено. Хронологическая
      // запись проверяется целиком ниже: её содержание может держаться на
      // заголовке или привязке (требование 26f0aa52).
      if (changes.body_md === '' && current.kind === 'permanent' && options.allowEmptyBody !== true) {
        throw new EtnError('VALIDATION_ERROR', 'body_md must not be empty', {
          field: 'body_md',
        });
      }
      sets.push('body_md = ?', 'body_html = ?');
      // Лимит рендера проверяется ДО `renderMarkdown` (ошибка 2764d7bb).
      assertBodyWithinRenderLimit(changes.body_md, options.bodyField ?? 'body_md');
      args.push(changes.body_md, renderMarkdown(changes.body_md));
    }
    // Хронологическая запись не может стать полностью пустой (требование
    // 26f0aa52): правка отвергается, если после неё у записи нет ни непустого
    // текста, ни заголовка, ни привязки вне HOME. `allowEmptyBody` (editComment,
    // граница 154df95d) осознанно снимает и эту защиту — там пустое тело
    // разрешено самим контрактом секционной правки.
    if (current.kind === 'chronological' && options.allowEmptyBody !== true) {
      const nextBody = changes.body_md ?? current.body_md;
      const nextTitle = changes.title !== undefined ? changes.title : current.title;
      if (
        !isNonEmptyText(nextBody) &&
        !isNonEmptyText(nextTitle) &&
        !hasBindingOutsideHome(ndb, current.targets)
      ) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'a chronological comment cannot become empty: keep a non-empty body_md or title, ' +
            'or a target other than HOME',
          { field: 'content' },
        );
      }
    }
    if (current.kind === 'chronological') {
      // Эффективное начало: правка `valid_from` либо текущее значение.
      const nextFrom =
        changes.valid_from === undefined
          ? current.valid_from
          : (normaliseInstant(changes.valid_from, 'valid_from', 'start') ?? new Date().toISOString());
      if (changes.valid_from !== undefined) {
        sets.push('valid_from = ?');
        args.push(nextFrom);
      }
      if (changes.valid_to !== undefined) {
        sets.push('valid_to = ?');
        // Пустое окончание у хронологической = её началу (0.10.1, ADR 994d076a).
        args.push(normaliseInstant(changes.valid_to, 'valid_to', 'end') ?? nextFrom);
      } else if (changes.valid_from !== undefined && current.valid_to === null) {
        // Наследная открытая запись: правка начала обязана закрыть интервал.
        sets.push('valid_to = ?');
        args.push(nextFrom);
      }
    }
    // Флаг «учитывать время» хранится на записи любого рода; на даты не влияет.
    if (changes.use_time !== undefined) {
      sets.push('use_time = ?');
      args.push(changes.use_time ? 1 : 0);
    }

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    sets.push('version = ?', 'updated_at = ?', 'updated_by = ?', 'updated_at_ms = ?');
    args.push(current.version + 1, now, actorUserId, nowMs);
    // S4 (13-layers.md §5.1): first edit in a working layer materialises a
    // shadow copy; the UPDATE targets the connection's layer row only.
    materializeShadow(ndb, 'comments', id);
    args.push(id, ndb.layerId);
    ndb
      .prepare(`UPDATE comments SET ${sets.join(', ')} WHERE id = ? AND layer_id = ?`)
      .run(...args);
    // Правка комментария — активность и у его владельцев (ошибка 228df7a4).
    for (const t of current.targets) {
      touchOwnerActivity(ndb, t.owner_type, t.owner_id, actorUserId);
    }
    return getCommentOrThrow(ndb, id);
  });
}

/** Результат {@link editComment}: новые секции, длина и свежая версия. */
export interface EditCommentResult {
  id: string;
  version: number;
  /**
   * Вид комментария (правкой не меняется) — чтобы эмиттеры `comment.updated`
   * заполняли payload без повторного чтения строки (блокер приёмки b02ef1cf).
   */
  kind: CommentKind;
  /** Список заголовков секций после правки (виртуальная первая строка — для текста без `#`). */
  sections: string[];
  /** Полная длина нового тела в символах. */
  chars_total: number;
  /** Итоговое тело после применения всех ops — для передачи в события и журналы. */
  body_md: string;
  /**
   * Предупреждения записи (требование `822a9149`): если правка потеряла живые
   * трансклюзии — `TRANSCLUSION_LOST` со списком источников. Пусто, когда
   * потерь нет.
   */
  warnings: MutationWarning[];
}

/**
 * Частичная правка комментария ops-ами одной транзакцией (задача d28abe04,
 * версия 0.7.2, спека 154df95d). Поддерживает `append`, `prepend`,
 * `replace_section`, `delete_section`. Применяется к **любому** комментарию
 * — постоянному и хронологическому, на мысли и на связи. Не создаёт и не
 * удаляет сам комментарий: отсутствующий — `NOT_FOUND`, удаление единственной
 * секции оставляет пустое тело.
 *
 * Контракт:
 *   * `ops` применяются последовательно в порядке массива; ошибка любой op
 *     откатывает весь вызов (предыдущие op не применяются — общая транзакция);
 *   * `expected_version` проверяется ДО применения любой op, а не после каждой;
 *   * итоговое тело нормализуется по `\n` (не более двух подряд);
 *   * повторяющиеся заголовки одного уровня дают `VALIDATION_ERROR`;
 *   * неизвестный заголовок даёт `NOT_FOUND` со списком доступных в `details.sections`.
 */
export function editComment(
  ndb: NetworkDb,
  id: string,
  ops: EditOp[],
  expectedVersion: number | undefined,
  actorUserId: string,
): EditCommentResult {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new EtnError('VALIDATION_ERROR', 'ops must be a non-empty array', {
      field: 'ops',
    });
  }
  return ndb.transaction(() => {
    const current = getCommentOrThrow(ndb, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'comment version mismatch', {
        entity: 'comment',
        id,
        expected: expectedVersion,
        current: current.version,
      });
    }
    const result = applySectionOps(current.body_md, ops);
    // Коллектор предупреждений: секционная правка тоже может потерять живые
    // трансклюзии (требование 822a9149) — напр. `replace_section`/`delete_section`.
    const warnings: MutationWarning[] = [];
    const updated = updateComment(
      ndb,
      id,
      { body_md: result.body },
      undefined,
      actorUserId,
      { allowEmptyBody: result.body === '', warnings },
    );
    return {
      id: updated.id,
      version: updated.version,
      kind: updated.kind,
      sections: result.sections,
      chars_total: result.body.length,
      body_md: result.body,
      warnings,
    };
  });
}

/**
 * Delete a comment (docs/03-server-api.md §10) together with its m2m targets.
 *
 * S4 (13-layers.md §5.2): in a working layer the deletion materialises
 * tombstones for the comment and its visible targets instead of deleting
 * physically; the base rows stay intact.
 *
 * Throws `NOT_FOUND` (404) or `VERSION_CONFLICT` (409).
 */
export function deleteComment(
  ndb: NetworkDb,
  id: string,
  expectedVersion: number | undefined,
  actorUserId: string,
): void {
  ndb.transaction(() => {
    const current = getCommentOrThrow(ndb, id);
    // Захват владельца запрещает удаление его комментария (ошибка 68be6829).
    enforceCommentLocks(ndb, current.targets, actorUserId);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'comment version mismatch', {
        entity: 'comment',
        id,
        expected: expectedVersion,
        current: current.version,
      });
    }
    if (!isBaseContext(ndb)) {
      const targetIds = (
        ndb.prepare('SELECT id FROM comment_targets_v WHERE comment_id = ?').all(id) as {
          id: string;
        }[]
      ).map((r) => r.id);
      for (const targetId of targetIds) materializeTombstone(ndb, 'comment_targets', targetId);
      materializeTombstone(ndb, 'comments', id);
    } else {
      ndb.prepare('DELETE FROM comment_targets WHERE comment_id = ?').run(id);
      ndb.prepare('DELETE FROM comments WHERE id = ?').run(id);
    }
    // Удаление комментария — тоже активность владельцев (ошибка 228df7a4).
    for (const t of current.targets) {
      touchOwnerActivity(ndb, t.owner_type, t.owner_id, actorUserId);
    }
  });
}

/**
 * Attach an existing chronological comment to one more owner (L20,
 * docs/03-server-api.md §10). The primary owner does not change.
 *
 * Throws `NOT_FOUND` (404, comment or owner), `VERSION_CONFLICT` (409),
 * `VALIDATION_ERROR` (422, permanent comment or invalid owner type) or
 * `DUPLICATE` (409, already attached).
 */
export function addCommentTarget(
  ndb: NetworkDb,
  commentId: string,
  ownerType: CommentOwnerType,
  ownerId: string,
  expectedVersion: number | undefined,
  actorUserId: string,
): Comment {
  const ot = validateOwnerType(ownerType);
  return ndb.transaction(() => {
    const current = getCommentOrThrow(ndb, commentId);
    // Смена привязок комментария — тоже запись в захваченного владельца
    // (ошибка 68be6829, требование 647fa34a).
    enforceCommentLocks(ndb, current.targets, actorUserId);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'comment version mismatch', {
        entity: 'comment',
        id: commentId,
        expected: expectedVersion,
        current: current.version,
      });
    }
    if (current.kind !== 'chronological') {
      throw new EtnError('VALIDATION_ERROR', 'a permanent comment has exactly one owner', {
        field: 'targets',
      });
    }
    ensureOwnerExists(ndb, ot, ownerId);
    const duplicate = ndb
      .prepare(
        'SELECT 1 FROM comment_targets_v WHERE comment_id = ? AND owner_type = ? AND owner_id = ? LIMIT 1',
      )
      .get(commentId, ot, ownerId);
    if (duplicate) {
      throw new EtnError('DUPLICATE', 'the comment is already attached to this owner', {
        owner_type: ot,
        owner_id: ownerId,
      });
    }
    ndb
      .prepare(
        'INSERT INTO comment_targets (comment_id, owner_type, owner_id, layer_id) VALUES (?, ?, ?, ?)',
      )
      .run(commentId, ot, ownerId, ndb.layerId);
    bumpVersion(ndb, commentId, current.version, actorUserId);
    // Новый владелец получил хроно-запись — двигаем его активность.
    touchOwnerActivity(ndb, ot, ownerId, actorUserId);
    return getCommentOrThrow(ndb, commentId);
  });
}

/**
 * Detach a chronological comment from one owner (L20, docs/03-server-api.md
 * §10). When the primary owner is detached, the primary moves to another
 * remaining target (the FTS triggers rebuild the index row). Detaching the
 * **last** target re-attaches the comment to the network HOME thought, so a
 * chronological comment is never left ownerless.
 *
 * Throws `NOT_FOUND` (404, comment or target), `VERSION_CONFLICT` (409) or
 * `VALIDATION_ERROR` (422, permanent comment).
 */
export function removeCommentTarget(
  ndb: NetworkDb,
  commentId: string,
  ownerType: CommentOwnerType,
  ownerId: string,
  expectedVersion: number | undefined,
  actorUserId: string,
): Comment {
  const ot = validateOwnerType(ownerType);
  return ndb.transaction(() => {
    const current = getCommentOrThrow(ndb, commentId);
    // Смена привязок комментария — тоже запись в захваченного владельца
    // (ошибка 68be6829, требование 647fa34a).
    enforceCommentLocks(ndb, current.targets, actorUserId);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'comment version mismatch', {
        entity: 'comment',
        id: commentId,
        expected: expectedVersion,
        current: current.version,
      });
    }
    if (current.kind !== 'chronological') {
      throw new EtnError('VALIDATION_ERROR', 'a permanent comment has exactly one owner', {
        field: 'targets',
      });
    }
    // S4: the target rows resolved in this layer's chain go first — physically
    // in the base, as tombstones in a working layer (13-layers.md §5.2).
    const targetRows = ndb
      .prepare(
        'SELECT id FROM comment_targets_v WHERE comment_id = ? AND owner_type = ? AND owner_id = ?',
      )
      .all(commentId, ot, ownerId) as { id: string }[];
    for (const row of targetRows) {
      deleteRowLayered(ndb, 'comment_targets', row.id);
    }
    if (targetRows.length === 0) {
      throw new EtnError('NOT_FOUND', 'the comment is not attached to this owner', {
        owner_type: ot,
        owner_id: ownerId,
      });
    }

    const restRows = ndb
      .prepare(
        `SELECT owner_type, owner_id FROM comment_targets_v WHERE comment_id = ?
         ORDER BY owner_type ASC, owner_id ASC`,
      )
      .all(commentId) as Array<{ owner_type: string; owner_id: string }>;
    let rest: CommentTarget[] = restRows.map((r) => ({
      owner_type: r.owner_type as CommentOwnerType,
      owner_id: r.owner_id,
    }));
    // Запоминаем, что комментарий при откреплении последней цели переехал на
    // HOME: у HOME хроно-запись появилась, её активность тоже надо сдвинуть.
    let reattachedToHome: CommentTarget | null = null;
    if (rest.length === 0) {
      // Last target detached — fall back to the protected HOME thought.
      const home = ndb.prepare('SELECT id FROM thoughts_v WHERE is_root = 1 LIMIT 1').get() as
        | { id: string }
        | undefined;
      if (home === undefined) {
        throw new EtnError('INTERNAL', 'network has no HOME thought', {});
      }
      ndb
        .prepare(
          'INSERT INTO comment_targets (comment_id, owner_type, owner_id, layer_id) VALUES (?, ?, ?, ?)',
        )
        .run(commentId, 'thought', home.id, ndb.layerId);
      rest = [{ owner_type: 'thought', owner_id: home.id }];
      reattachedToHome = rest[0]!;
    }

    const wasPrimary = current.owner_type === ot && current.owner_id === ownerId;
    const nextPrimary = rest[0];
    if (nextPrimary === undefined) {
      throw new EtnError('INTERNAL', 'comment has no remaining targets', {});
    }
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    if (wasPrimary) {
      // S4: the primary move is an edit of the comment row — materialise the
      // shadow copy first, then update the connection's layer row only.
      materializeShadow(ndb, 'comments', commentId);
      ndb
        .prepare(
          `UPDATE comments SET owner_type = ?, owner_id = ?, version = ?, updated_at = ?, updated_by = ?, updated_at_ms = ?
           WHERE id = ? AND layer_id = ?`,
        )
        .run(
          nextPrimary.owner_type,
          nextPrimary.owner_id,
          current.version + 1,
          now,
          actorUserId,
          nowMs,
          commentId,
          ndb.layerId,
        );
    } else {
      bumpVersion(ndb, commentId, current.version, actorUserId);
    }
    // Отсоединённый владелец потерял хроно-запись, а при откреплении последней
    // цели её получил HOME — двигаем активность обоих (ошибка 228df7a4).
    touchOwnerActivity(ndb, ot, ownerId, actorUserId);
    if (reattachedToHome !== null) {
      touchOwnerActivity(ndb, reattachedToHome.owner_type, reattachedToHome.owner_id, actorUserId);
    }
    return getCommentOrThrow(ndb, commentId);
  });
}

/** Bump `version`/`updated_at`/`updated_by` of a comment (its layer row). */
function bumpVersion(ndb: NetworkDb, commentId: string, currentVersion: number, actorUserId: string): void {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  materializeShadow(ndb, 'comments', commentId);
  ndb
    .prepare(
      'UPDATE comments SET version = ?, updated_at = ?, updated_by = ?, updated_at_ms = ? WHERE id = ? AND layer_id = ?',
    )
    .run(currentVersion + 1, now, actorUserId, nowMs, commentId, ndb.layerId);
}

