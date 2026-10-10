/**
 * Домен подсистемы «Публикации» (0.11.1, задача 8178e007; тех.проект
 * c5261d02; сущности bc147b40 / 18f3bebf / e6aeb7ba / f0a51091; ADR 1d7e4b43;
 * жизненный цикл 200b87be; владелец-вложение 71c2d194; ветвимость e7487d77).
 *
 * Модель данных и CRUD публикаций, поузлового локального порядка, исключений,
 * полок библиотеки и владельца вложений `publication` — без сборки документа
 * (это задача 34119c67) и без REST/MCP-фасадов (c59ce742/8f6857f8).
 *
 * **Ветвимость.** Все таблицы подсистемы — ветвимые: чтения идут через `*_v`
 * (контекст слоя соединения), запись — материализацией теневой строки
 * (`materializeShadow`/`deleteRowLayered`), физическое удаление возможно
 * только в основе. У строк-деталей (`publication_order`,
 * `publication_exclusions`, `shelf_items`) `id` детерминирован от
 * естественного ключа (`db/publication-id.ts`) — иначе независимые первые
 * записи одного узла в разных слоях разошлись бы в два «победителя»
 * (прецедент property_values, ошибка dc119240).
 */

import { randomUUID } from 'node:crypto';

import {
  buildLikePattern,
  EtnError,
  type HoldingLayerRef,
  type Publication,
  type PublicationActiveFilter,
  type PublicationCreateInput,
  type PublicationDeletionCheckResult,
  type PublicationExclusion,
  type PublicationListQuery,
  type PublicationOrderItem,
  type PublicationSort,
  type PublicationUpdateInput,
  type SavedFilterDefinition,
  type Shelf,
  type ShelfDeletionCheckResult,
  type ShelfInput,
  type ShelfItem,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { isBaseContext, materializeShadow, deleteRowLayered } from '../db/layer-write.js';
import {
  publicationExclusionId,
  publicationOrderId,
  shelfItemId,
} from '../db/publication-id.js';
import { listPublicationHoldingLayers } from './holding-layers.js';
import { hasOwnership } from './attachment-service.js';
import { purgeOwnerAttachments } from './owner-cleanup.js';
import { invalidatePublicationMembershipCache } from './publication-membership-cache.js';
import { selectRecipeIds } from './publication-recipe.js';
import { linkPropertyLinkTypeId } from './property-service.js';
import {
  numberingRangeInvalid,
  recipeOverlap,
  summaryHasMarkdownHeadings,
} from './publication-validation.js';
import { normalizeTitle } from './thought-service.js';

/** Cap длины названия — по образцу мыслей (защита от мусора). */
const TITLE_MAX = 500;

/**
 * Имя дефолтной полки (0.11.1, задача 8c2660e6, карточка c80951ea v2). В сети
 * всегда есть хотя бы одна живая полка; при её отсутствии создаётся полка с
 * этим именем (см. {@link ensureDefaultShelf}).
 */
export const DEFAULT_SHELF_TITLE = 'Полка';

/**
 * Детерминированный id дефолтной полки (0.11.1, задача 8c2660e6). Один и тот
 * же во ВСЕХ сетях: так при переносе `.etnx` (`import-service.upsertShelf`
 * ищет строку по id) дефолтные полки двух сетей сходятся в одну и импорт
 * сливает их, а не падает `SQLITE_CONSTRAINT_UNIQUE` на частичном индексе имени
 * `idx_shelves_title_key_live`. Не менять: смена id сломает слияние уже
 * перенесённых сетей. Id уникален в пределах одной `data.db`; совпадение id
 * между разными сетями безопасно — строки живут в разных файлах.
 */
export const DEFAULT_SHELF_ID = '5e1f0000-0000-4000-8000-000000000001';

/** Строка `publications_v` (без вычисляемых полей). */
interface PublicationRow {
  id: string;
  title: string;
  subtitle: string | null;
  summary_md: string | null;
  authorship: string | null;
  cover_attachment_id: string | null;
  cover_url: string | null;
  assembly_date: string | null;
  title_recipe: string | null;
  text_sources: string | null;
  extra_properties: string | null;
  numbering_from: number | null;
  numbering_to: number | null;
  active: number;
  marked_for_deletion: number;
  marked_for_deletion_at: string | null;
  marked_for_deletion_by: string | null;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

// ---------------------------------------------------------------------------
// Чтение и преобразование строк
// ---------------------------------------------------------------------------

/** Пустая строка → `null`; иначе — исходное значение. */
function nullable(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value.trim() === '' ? null : value;
}

/** Разобрать JSON-массив строк; битое значение → `[]` (данные защищены схемой). */
function parseStringArray(text: string | null): string[] {
  if (text === null || text === '') return [];
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Разобрать JSON-объект рецепта; битое значение → `null`. */
function parseRecipe(text: string | null): SavedFilterDefinition | null {
  if (text === null || text === '') return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' ? (value as SavedFilterDefinition) : null;
  } catch {
    return null;
  }
}

/** Источник обложки, вычисляемый из пары полей. */
function coverKindOf(row: PublicationRow): Publication['cover_kind'] {
  if (row.cover_attachment_id !== null) return 'attachment';
  if (row.cover_url !== null) return 'url';
  return 'none';
}

/** Преобразовать строку БД в DTO публикации. */
function rowToPublication(row: PublicationRow): Publication {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    summary_md: row.summary_md,
    authorship: row.authorship,
    cover_attachment_id: row.cover_attachment_id,
    cover_url: row.cover_url,
    cover_kind: coverKindOf(row),
    assembly_date: row.assembly_date,
    title_recipe: parseRecipe(row.title_recipe),
    text_sources: parseStringArray(row.text_sources),
    extra_properties: parseStringArray(row.extra_properties),
    numbering_from: row.numbering_from,
    numbering_to: row.numbering_to,
    active: row.active === 1,
    marked_for_deletion: row.marked_for_deletion === 1,
    marked_for_deletion_at: row.marked_for_deletion_at,
    marked_for_deletion_by: row.marked_for_deletion_by,
    version: row.version,
    created_at: row.created_at,
    created_by: row.created_by,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

/** Публикация по id в контексте слоя соединения; `null` — не видна. */
export function getPublication(ndb: NetworkDb, id: string): Publication | null {
  const row = ndb.prepare('SELECT * FROM publications_v WHERE id = ? LIMIT 1').get(id) as
    | PublicationRow
    | undefined;
  return row === undefined ? null : rowToPublication(row);
}

/** Публикация по id или `NOT_FOUND`. */
function getPublicationOrThrow(ndb: NetworkDb, id: string): Publication {
  const publication = getPublication(ndb, id);
  if (publication === null) {
    throw new EtnError('NOT_FOUND', `publication ${id} not found`, {
      entity: 'publication',
      id,
    });
  }
  return publication;
}

// ---------------------------------------------------------------------------
// Принятый срез (временная семантика кандидатов, задача e754527d; спека f9a20c3f)
// ---------------------------------------------------------------------------

/**
 * Принятый срез публикации — JSON-массив id вошедших в отбор мыслей; `null` —
 * срез не инициализирован (импорт/legacy) и кандидатов нет. Хранится в строке
 * `publications` (см. комментарий колонки `accepted_ids` в миграции 047), а не в
 * отдельной ветвимой таблице: новый раздел .etnx и правка экспорта запрещены
 * границами задачи, а колонка строки проезжает слои штатной материализацией.
 */
export function getPublicationAcceptedIds(ndb: NetworkDb, id: string): string[] | null {
  const row = ndb
    .prepare('SELECT accepted_ids FROM publications_v WHERE id = ? LIMIT 1')
    .get(id) as { accepted_ids: string | null } | undefined;
  if (row === undefined || row.accepted_ids === null) return null;
  return parseStringArray(row.accepted_ids);
}

/**
 * Зафиксировать принятый срез. Специально НЕ трогает `version`/`updated_at`:
 * принятие кандидата — не правка настроек публикации, и не должно уводить
 * открытый у пользователя `If-Match` в конфликт (как и запись порядка). Строка
 * материализуется в текущем слое штатным механизмом теневых строк.
 */
export function setPublicationAcceptedIds(ndb: NetworkDb, id: string, ids: readonly string[]): void {
  if (!materializeShadow(ndb, 'publications', id)) return;
  ndb
    .prepare('UPDATE publications SET accepted_ids = ? WHERE id = ? AND layer_id = ?')
    .run(JSON.stringify(ids), id, ndb.layerId);
}

/**
 * Исполнить рецепт заголовков публикации (read-only) и вернуть id текущего
 * отбора. `userId` влияет лишь на сортировку (`viewed`), не на состав набора,
 * поэтому для проверок принадлежности допустимо передать пустую строку.
 */
function selectCurrentSelection(
  ndb: NetworkDb,
  id: string,
  actorUserId: string,
): string[] {
  const row = ndb
    .prepare('SELECT title_recipe FROM publications_v WHERE id = ? LIMIT 1')
    .get(id) as { title_recipe: string | null } | undefined;
  const recipe = parseRecipe(row?.title_recipe ?? null);
  if (recipe === null) return [];
  const warnings: string[] = [];
  return selectRecipeIds(ndb, actorUserId, recipe, warnings);
}

/** Порядок: узел публикации либо узел, когда-то существовавший (история). */
function assertPublicationOrderKeysKnown(
  ndb: NetworkDb,
  publicationId: string,
  items: readonly PublicationOrderItem[],
  memberThoughtIds: ReadonlySet<string>,
): void {
  // История локального порядка — строки таблицы (включая надгробия и строки
  // других слоёв): «узел когда-то существовал». Позволяет терпеть перестановку
  // исчезнувшего узла (сценарий синхронизации клиентов/слоёв, ошибка 5f23f57d).
  const historyRows = ndb
    .prepare('SELECT node_key FROM publication_order WHERE publication_id = ?') // layers:physical-read
    .all(publicationId) as Array<{ node_key: string }>;
  const history = new Set(historyRows.map((r) => r.node_key));
  const linkLookup = ndb.prepare(
    'SELECT source_id, target_id FROM links_v WHERE id = ? LIMIT 1',
  );
  for (const item of items) {
    if (typeof item.node_key !== 'string' || item.node_key === '') continue;
    const key = item.node_key;
    if (history.has(key)) continue;
    // Мысль-узел (корень раздела) из отбора/принятого среза.
    if (memberThoughtIds.has(key)) continue;
    // Узел-ребро: родительское ребро раздела или ребро-источник текста — одно
    // из его концов входит в публикацию. Произвольный (никогда не
    // существовавший) узел сюда не попадает.
    const link = linkLookup.get(key) as { source_id: string; target_id: string } | undefined;
    if (
      link !== undefined &&
      (memberThoughtIds.has(link.source_id) || memberThoughtIds.has(link.target_id))
    ) {
      continue;
    }
    throw new EtnError('VALIDATION_ERROR', `Узел ${key} не принадлежит публикации.`, {
      field: 'node_key',
      code: 'unknown_node_key',
      node_key: key,
    });
  }
}

/**
 * Ссылка на публикацию для подстановки имени (0.11.1, задача f37b468d,
 * требование 7f583ef9): id + название + актуальность.
 */
export interface PublicationRef {
  id: string;
  title: string;
  active: boolean;
}

/**
 * Серверная подстановка имён: батч-резолв публикаций по id для wiki-ссылок
 * `[[#pub:<id>]]`. Это серверная половина «двух резолверов» требования
 * 7f583ef9 (клиентский wiki-резолвер подставляет имена в комментариях,
 * экспортная подстановка — при сборке документа): обе стороны читают имена
 * ОТСЮДА, повторной реализации разбора/резолва не заводят.
 *
 * Разрешение — в контексте слоя соединения (`publications_v`): невидимая или
 * удалённая публикация в результат не попадает, вызывающий рисует пометку
 * «удалена» (как для удалённой мысли). Порядок результата повторяет порядок
 * входных id (без дублей) — подстановка детерминирована.
 */
export function resolvePublicationRefs(ndb: NetworkDb, ids: readonly string[]): PublicationRef[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.toLowerCase();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  if (unique.length === 0) return [];
  const placeholders = unique.map(() => '?').join(', ');
  const rows = ndb
    .prepare(
      `SELECT id, title, active FROM publications_v WHERE id IN (${placeholders})`,
    )
    .all(...unique) as Array<{ id: string; title: string; active: number }>;
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  const out: PublicationRef[] = [];
  for (const id of unique) {
    const row = byId.get(id);
    if (row === undefined) continue;
    out.push({ id: row.id, title: row.title, active: row.active === 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Валидация (требования карточки CRUD 5af247e4, жизненного цикла 200b87be)
// ---------------------------------------------------------------------------

/**
 * Резюме — markdown БЕЗ заголовков (титул не место для структуры,
 * требование титула): наличие заголовка → `VALIDATION_ERROR`
 * `summary_headings_forbidden`.
 */
function assertSummaryHasNoHeadings(summaryMd: string | null): void {
  if (summaryMd === null) return;
  if (summaryHasMarkdownHeadings(summaryMd)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'резюме публикации не может содержать заголовки (markdown без заголовков)',
      { field: 'summary_md', code: 'summary_headings_forbidden' },
    );
  }
}

/** Диапазон нумерации: `numbering_from ≤ numbering_to`, когда обе заданы. */
function assertNumberingRange(from: number | null, to: number | null): void {
  if (numberingRangeInvalid(from, to)) {
    throw new EtnError('VALIDATION_ERROR', 'numbering_from не может быть больше numbering_to', {
      field: 'numbering_from',
      code: 'numbering_range',
    });
  }
}

/** Ровно один источник обложки: вложение ИЛИ URL (оба `null` допустимы). */
function assertSingleCover(
  coverAttachmentId: string | null,
  coverUrl: string | null,
): void {
  if (coverAttachmentId !== null && coverUrl !== null) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'у публикации может быть только один источник обложки: вложение или URL',
      { field: 'cover_attachment_id', code: 'cover_conflict' },
    );
  }
}

/** Строка-вложение-обложка обязана принадлежать этой публикации (живое владение). */
function assertCoverAttachmentOwned(
  ndb: NetworkDb,
  publicationId: string,
  attachmentId: string | null,
): void {
  if (attachmentId === null) return;
  // 0.12.1 (ADR 9f90b010): владение, а не owner-колонки строки вложения.
  if (!hasOwnership(ndb, attachmentId, 'publication', publicationId)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'обложка должна ссылаться на строку-вложение этой публикации',
      { field: 'cover_attachment_id', code: 'cover_attachment_invalid' },
    );
  }
}

/** Рецепты не пересекаются: `text_sources ∩ extra_properties = ∅`. */
function assertRecipeNoOverlap(textSources: string[], extraProperties: string[]): void {
  const overlap = recipeOverlap(textSources, extraProperties);
  if (overlap.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'свойства текстов и «дополнительных материалов» не должны пересекаться',
      { field: 'text_sources', code: 'recipe_overlap', overlap },
    );
  }
}

/** Нормализовать и проверить список id свойств (существование в реестре). */
function normalizePropertyIds(ndb: NetworkDb, ids: string[] | undefined, field: string): string[] {
  if (ids === undefined) return [];
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return [];
  const placeholders = unique.map(() => '?').join(', ');
  const found = new Set(
    (
      ndb
        .prepare(`SELECT id FROM properties_v WHERE id IN (${placeholders})`)
        .all(...unique) as { id: string }[]
    ).map((r) => r.id),
  );
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new EtnError('VALIDATION_ERROR', 'указаны несуществующие свойства рецепта', {
      field,
      missing,
    });
  }
  return unique;
}

/** Проверить название публикации. */
function validatePublicationTitle(title: unknown): string {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new EtnError('VALIDATION_ERROR', 'title обязателен', { field: 'title' });
  }
  const value = title.trim();
  if (value.length > TITLE_MAX) {
    throw new EtnError('VALIDATION_ERROR', `title длиннее ${TITLE_MAX} символов`, {
      field: 'title',
    });
  }
  return value;
}

/** Итоговые значения полей после создания/правки — единая точка валидации. */
function resolvePublicationFields(
  ndb: NetworkDb,
  publicationId: string,
  current: PublicationRow | null,
  input: PublicationCreateInput | PublicationUpdateInput,
): {
  title: string;
  subtitle: string | null;
  summary_md: string | null;
  authorship: string | null;
  cover_attachment_id: string | null;
  cover_url: string | null;
  title_recipe: string | null;
  text_sources: string | null;
  extra_properties: string | null;
  numbering_from: number | null;
  numbering_to: number | null;
} {
  const pick = <T>(next: T | undefined, prev: T): T => (next === undefined ? prev : next);

  const title =
    current === null || input.title !== undefined
      ? validatePublicationTitle(input.title)
      : current.title;
  const subtitle = pick(
    input.subtitle === undefined ? undefined : nullable(input.subtitle),
    current?.subtitle ?? null,
  );
  const summaryMd = pick(
    input.summary_md === undefined ? undefined : nullable(input.summary_md),
    current?.summary_md ?? null,
  );
  const authorship = pick(
    input.authorship === undefined ? undefined : nullable(input.authorship),
    current?.authorship ?? null,
  );
  const coverAttachmentId = pick(
    input.cover_attachment_id === undefined ? undefined : nullable(input.cover_attachment_id),
    current?.cover_attachment_id ?? null,
  );
  const coverUrl = pick(
    input.cover_url === undefined ? undefined : nullable(input.cover_url),
    current?.cover_url ?? null,
  );

  let titleRecipe = current?.title_recipe ?? null;
  if (input.title_recipe !== undefined) {
    titleRecipe =
      input.title_recipe === null ? null : JSON.stringify(input.title_recipe);
  }

  let textSources = parseStringArray(current?.text_sources ?? null);
  if (input.text_sources !== undefined) {
    textSources = normalizePropertyIds(ndb, input.text_sources, 'text_sources');
  }
  let extraProperties = parseStringArray(current?.extra_properties ?? null);
  if (input.extra_properties !== undefined) {
    extraProperties = normalizePropertyIds(ndb, input.extra_properties, 'extra_properties');
  }

  const numberingFrom = pick(input.numbering_from, current?.numbering_from ?? null);
  const numberingTo = pick(input.numbering_to, current?.numbering_to ?? null);

  assertSummaryHasNoHeadings(summaryMd);
  assertSingleCover(coverAttachmentId, coverUrl);
  assertCoverAttachmentOwned(ndb, publicationId, coverAttachmentId);
  assertRecipeNoOverlap(textSources, extraProperties);
  assertNumberingRange(numberingFrom, numberingTo);

  return {
    title,
    subtitle,
    summary_md: summaryMd,
    authorship,
    cover_attachment_id: coverAttachmentId,
    cover_url: coverUrl,
    title_recipe: titleRecipe,
    text_sources: JSON.stringify(textSources),
    extra_properties: JSON.stringify(extraProperties),
    numbering_from: numberingFrom,
    numbering_to: numberingTo,
  };
}

// ---------------------------------------------------------------------------
// CRUD публикаций
// ---------------------------------------------------------------------------

/** Создать публикацию (POST /publications). */
export function createPublication(
  ndb: NetworkDb,
  input: PublicationCreateInput,
  actorUserId: string,
): Publication {
  return ndb.transaction(() => {
    const id = randomUUID();
    const fields = resolvePublicationFields(ndb, id, null, input);
    // Принятый срез на момент создания: всё, что уже подходит под рецепт,
    // принято; кандидатами станут только вошедшие в отбор позже (задача e754527d).
    const recipe = parseRecipe(fields.title_recipe);
    const warnings: string[] = [];
    const acceptedIds =
      recipe === null ? [] : selectRecipeIds(ndb, actorUserId, recipe, warnings);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    ndb
      .prepare(
        `INSERT INTO publications (id, layer_id, title, subtitle, summary_md, authorship,
                                   cover_attachment_id, cover_url, title_recipe, text_sources,
                                   extra_properties, numbering_from, numbering_to, accepted_ids,
                                   active, version, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ndb.layerId,
        fields.title,
        fields.subtitle,
        fields.summary_md,
        fields.authorship,
        fields.cover_attachment_id,
        fields.cover_url,
        fields.title_recipe,
        fields.text_sources,
        fields.extra_properties,
        fields.numbering_from,
        fields.numbering_to,
        JSON.stringify(acceptedIds),
        now,
        actorUserId,
        now,
        actorUserId,
      );
    invalidatePublicationMembershipCache(id);
    return getPublicationOrThrow(ndb, id);
  });
}

/** Патч настроек публикации. `assembly_date` не меняется — только rebuild. */
export function updatePublication(
  ndb: NetworkDb,
  id: string,
  input: PublicationUpdateInput,
  actorUserId: string,
): Publication {
  return ndb.transaction(() => {
    const current = getPublicationOrThrow(ndb, id);
    const raw = ndb
      .prepare('SELECT * FROM publications_v WHERE id = ? LIMIT 1')
      .get(id) as PublicationRow;
    const fields = resolvePublicationFields(ndb, id, raw, input);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const active = input.active === undefined ? (current.active ? 1 : 0) : input.active ? 1 : 0;

    materializeShadow(ndb, 'publications', id);
    ndb
      .prepare(
        `UPDATE publications
            SET title = ?, subtitle = ?, summary_md = ?, authorship = ?,
                cover_attachment_id = ?, cover_url = ?, title_recipe = ?, text_sources = ?,
                extra_properties = ?, numbering_from = ?, numbering_to = ?, active = ?,
                version = version + 1, updated_at = ?, updated_by = ?
          WHERE id = ? AND layer_id = ?`,
      )
      .run(
        fields.title,
        fields.subtitle,
        fields.summary_md,
        fields.authorship,
        fields.cover_attachment_id,
        fields.cover_url,
        fields.title_recipe,
        fields.text_sources,
        fields.extra_properties,
        fields.numbering_from,
        fields.numbering_to,
        active,
        now,
        actorUserId,
        id,
        ndb.layerId,
      );
    invalidatePublicationMembershipCache(id);
    return getPublicationOrThrow(ndb, id);
  });
}

/**
 * Явная пересборка (POST /publications/{id}/rebuild, карточка f9a20c3f):
 * проставляет `assembly_date` текущей датой и подчищает мёртвые строки
 * `publication_order`. Никаких других данных не меняет.
 *
 * «Мёртвая» строка порядка — `node_key`, которого больше нет ни среди живых
 * рёбер (`links_v`), ни среди живых мыслей (`thoughts_v`): позиция такого
 * узла уже не может быть применена сборкой («узел исчез — позиция мертва»,
 * карточка f6b242fe). Возвращается новая карточка и число удалённых строк.
 */
export function rebuildPublication(
  ndb: NetworkDb,
  id: string,
  actorUserId: string,
): { publication: Publication; pruned_order_rows: number } {
  return ndb.transaction(() => {
    getPublicationOrThrow(ndb, id);
    const now = new Date().toISOString();
    materializeShadow(ndb, 'publications', id);
    ndb
      .prepare(
        `UPDATE publications
            SET assembly_date = ?, version = version + 1, updated_at = ?, updated_by = ?
          WHERE id = ? AND layer_id = ?`,
      )
      .run(now, now, actorUserId, id, ndb.layerId);

    const dead = ndb
      .prepare(
        `SELECT po.id AS id FROM publication_order_v po
          WHERE po.publication_id = ?
            AND NOT EXISTS (SELECT 1 FROM links_v l WHERE l.id = po.node_key)
            AND NOT EXISTS (SELECT 1 FROM thoughts_v t WHERE t.id = po.node_key)`,
      )
      .all(id) as { id: string }[];
    for (const row of dead) {
      deleteRowLayered(ndb, 'publication_order', row.id);
    }
    invalidatePublicationMembershipCache(id);
    return { publication: getPublicationOrThrow(ndb, id), pruned_order_rows: dead.length };
  });
}

/** Пометить публикацию на удаление (корзина). Доступно в любом слое. */
export function trashPublication(ndb: NetworkDb, id: string, actorUserId: string): Publication {
  return markPublicationTrashed(ndb, id, true, actorUserId);
}

/** Снять пометку на удаление. */
export function restorePublication(ndb: NetworkDb, id: string, actorUserId: string): Publication {
  return markPublicationTrashed(ndb, id, false, actorUserId);
}

/** Общая реализация пометки/снятия пометки корзины. */
function markPublicationTrashed(
  ndb: NetworkDb,
  id: string,
  trashed: boolean,
  actorUserId: string,
): Publication {
  return ndb.transaction(() => {
    getPublicationOrThrow(ndb, id);
    const now = new Date().toISOString();
    materializeShadow(ndb, 'publications', id);
    if (trashed) {
      ndb
        .prepare(
          `UPDATE publications
              SET marked_for_deletion = 1, marked_for_deletion_at = ?, marked_for_deletion_by = ?,
                  version = version + 1, updated_at = ?, updated_by = ?
            WHERE id = ? AND layer_id = ?`,
        )
        .run(now, actorUserId, now, actorUserId, id, ndb.layerId);
    } else {
      ndb
        .prepare(
          `UPDATE publications
              SET marked_for_deletion = 0, marked_for_deletion_at = NULL, marked_for_deletion_by = NULL,
                  version = version + 1, updated_at = ?, updated_by = ?
            WHERE id = ? AND layer_id = ?`,
        )
        .run(now, actorUserId, id, ndb.layerId);
    }
    invalidatePublicationMembershipCache(id);
    return getPublicationOrThrow(ndb, id);
  });
}

/**
 * Число живых значений свойств типа «Публикация», ссылающихся на публикацию.
 *
 * Тип значения `publication` реализован задачей f37b468d: значение хранится в
 * `property_values.value_text` — скаляром (single) или JSON-массивом id
 * (multiple), поэтому матч покрывает обе формы: точное равенство и элемент
 * JSON-массива (паттерн `%"<id>"%`, как у legacy thought_ref). Запрос построен
 * на реестре (`properties_v` по `value_type`) и всех `value_*`-колонках
 * `property_values`, поэтому не зависит от имени колонки хранения ссылки.
 */
export function countPublicationRefUsages(ndb: NetworkDb, publicationId: string): number {
  const props = (
    ndb
      .prepare("SELECT id FROM properties_v WHERE value_type = 'publication'")
      .all() as { id: string }[]
  ).map((r) => r.id);
  if (props.length === 0) return 0;

  const columns = (ndb.pragma('table_info(property_values)') as Array<{ name: string; type: string }>)
    .filter((c) => c.name.startsWith('value_'))
    .map((c) => c.name);
  if (columns.length === 0) return 0;

  const placeholders = props.map(() => '?').join(', ');
  // Точное совпадение (single) ИЛИ вхождение id в JSON-массив (multiple).
  const arrayMatch = `%"${publicationId}"%`;
  const match = columns.map((c) => `(${c} = ? OR ${c} LIKE ? ESCAPE '\\')`).join(' OR ');
  const params: unknown[] = [...props];
  for (let i = 0; i < columns.length; i += 1) params.push(publicationId, arrayMatch);
  const row = ndb
    .prepare(
      `SELECT COUNT(*) AS c FROM property_values_v
        WHERE property_id IN (${placeholders}) AND (${match})`,
    )
    .get(...params) as { c: number };
  return row.c;
}

/** Проверка физического удаления публикации (аналог deletion-check мысли). */
export function checkPublicationDeletion(
  ndb: NetworkDb,
  id: string,
): PublicationDeletionCheckResult {
  getPublicationOrThrow(ndb, id);
  const properties = countPublicationRefUsages(ndb, id);
  const layers: HoldingLayerRef[] = listPublicationHoldingLayers(ndb, id);
  return { blocked: properties > 0 || layers.length > 0, blocking: { properties, layers } };
}

/**
 * Физическое удаление публикации — только в основе (в слое
 * `VALIDATION_ERROR purge_base_only`). Каскад: строки `publication_order`,
 * `publication_exclusions`, `shelf_items` и владения вложениями-обложками
 * (`attachment_owners`). Снимаются только владения САМОЙ публикации: вложение
 * и его файл удаляются, лишь когда у них не осталось живых владельцев у других
 * объектов (ADR 9f90b010, задача da59a4cf) — общее вложение не разрушается.
 * Блокировки (`deletion_blocked`): живые значения свойств типа «Публикация» и
 * живая теневая строка в ином слое.
 */
export function purgePublication(ndb: NetworkDb, id: string): void {
  ndb.transaction(() => {
    if (!isBaseContext(ndb)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'физическое удаление публикации доступно только в основе',
        { entity: 'publication', id, code: 'purge_base_only' },
      );
    }
    getPublicationOrThrow(ndb, id);
    const check = checkPublicationDeletion(ndb, id);
    if (check.blocked) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'публикация используется в свойствах или удерживается слоем и не может быть удалена',
        { entity: 'publication', id, blocking: check.blocking, code: 'deletion_blocked' },
      );
    }

    // Вложения обложки: снимаются ТОЛЬКО владения публикации; вложение и файл
    // уходят, лишь если не осталось живых владельцев у других объектов
    // (ADR 9f90b010, задача da59a4cf) — общее вложение не разрушается.
    purgeOwnerAttachments(ndb, 'publication', [id]);

    ndb.prepare('DELETE FROM publication_order WHERE publication_id = ?').run(id);
    ndb.prepare('DELETE FROM publication_exclusions WHERE publication_id = ?').run(id);
    ndb.prepare('DELETE FROM shelf_items WHERE publication_id = ?').run(id);
    ndb.prepare('DELETE FROM publications WHERE id = ?').run(id);
    invalidatePublicationMembershipCache(id);

    // Строки состава полок удалены каскадом — «полки не блокируют удаление».
  });
}

// ---------------------------------------------------------------------------
// Список публикаций
// ---------------------------------------------------------------------------

/** Список публикаций с пагинацией, поиском, фильтром полки и актуальности. */
export function listPublications(
  ndb: NetworkDb,
  query: PublicationListQuery = {},
): { items: Publication[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  let join = '';

  if (query.shelf !== undefined) {
    join = 'JOIN shelf_items_v si ON si.publication_id = p.id AND si.shelf_id = ?';
    params.push(query.shelf);
  }
  const active: PublicationActiveFilter = query.active ?? 'true';
  if (active === 'true') where.push('p.active = 1');
  else if (active === 'false') where.push('p.active = 0');
  if (query.include_trashed !== true) where.push('p.marked_for_deletion = 0');

  if (query.q !== undefined && query.q.trim() !== '') {
    const pattern = buildLikePattern(query.q.trim()).toLowerCase();
    // `unicode_lower` (registerQueryFunctions) сворачивает регистр кириллицы —
    // встроенный SQLite `lower()` умеет только ASCII.
    where.push(
      "(unicode_lower(COALESCE(p.title, '') || '\\n' || COALESCE(p.subtitle, '') || '\\n' || COALESCE(p.authorship, '')) LIKE ? ESCAPE '\\')",
    );
    params.push(pattern);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = ndb
    .prepare(`SELECT COUNT(DISTINCT p.id) AS n FROM publications_v p ${join} ${whereSql}`)
    .get(...params) as { n: number };

  const sort: PublicationSort = query.sort ?? 'manual';
  const orderSql =
    sort === 'title'
      ? 'p.title COLLATE NOCASE ASC'
      : sort === 'date'
        ? 'p.created_at DESC'
        : sort === 'author'
          ? 'COALESCE(p.authorship, p.created_by) COLLATE NOCASE ASC'
          : query.shelf !== undefined
            ? 'si.position ASC'
            : 'p.created_at ASC';

  const limit =
    typeof query.limit === 'number' ? Math.max(0, Math.min(200, Math.trunc(query.limit))) : 50;
  const offset = typeof query.offset === 'number' ? Math.max(0, Math.trunc(query.offset)) : 0;

  const rows = ndb
    .prepare(
      `SELECT p.* FROM publications_v p ${join} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as PublicationRow[];
  return { items: rows.map(rowToPublication), total: totalRow.n };
}

/**
 * ВСЕ публикации среза без пагинации и фильтров — для экспорта `.etnx`
 * (0.11.1, задача 950e0a59, требование de697045: «экспорт — все публикации
 * среза, не фильтруются по содержимому подграфа»). Включает неактуальные и
 * помеченные на удаление: манифест несёт их флаги и повторный экспорт обязан
 * совпасть. Порядок детерминирован (`created_at`, затем `id`) — раунд-трип
 * стабилен, потому что `created_at` и `id` сохраняются при импорте.
 */
export function listAllPublications(ndb: NetworkDb): Publication[] {
  const rows = ndb
    .prepare('SELECT * FROM publications_v ORDER BY created_at ASC, id ASC')
    .all() as PublicationRow[];
  return rows.map(rowToPublication);
}

// ---------------------------------------------------------------------------
// Локальный порядок и исключения
// ---------------------------------------------------------------------------

/** Upsert поузловых строк порядка (без семантики принятого среза). */
function applyPublicationOrder(
  ndb: NetworkDb,
  publicationId: string,
  items: readonly PublicationOrderItem[],
  actorUserId: string,
): void {
  const now = new Date().toISOString();
  for (const item of items) {
    if (typeof item.node_key !== 'string' || item.node_key === '') continue;
    const id = publicationOrderId(publicationId, item.node_key);
    const materialized = materializeShadow(ndb, 'publication_order', id);
    if (materialized) {
      // `deleted = 0` — надгробие той же поузловой строки (детерминированный
      // id) при повторной перестановке оживляется, иначе позиция молча
      // терялась бы (та же семантика, что у исключений и состава полок).
      ndb
        .prepare(
          `UPDATE publication_order
              SET position = ?, deleted = 0, updated_at = ?, updated_by = ?
            WHERE id = ? AND layer_id = ?`,
        )
        .run(item.position, now, actorUserId, id, ndb.layerId);
    } else {
      ndb
        .prepare(
          `INSERT INTO publication_order (id, layer_id, publication_id, node_key, position,
                                          updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ndb.layerId, publicationId, item.node_key, item.position, now, actorUserId);
    }
  }
}

/**
 * Батч перестановок порядка: одна транзакция, upsert поузловых строк.
 *
 * **Что проверяется (ошибка 5f23f57d).** Узел обязан принадлежать публикации:
 * быть мыслью текущего отбора/принятого среза, ребром-узлом публикации
 * (родительское ребро раздела или ребро-источник текста) либо строкой истории
 * `publication_order` (узел существовал и исчез — перестановку терпим, это
 * сценарий синхронизации клиентов/слоёв). Произвольный ключ, никогда не
 * существовавший у публикации, отвергается `VALIDATION_ERROR`.
 *
 * **Принятие (задача e754527d).** Сохранение порядка — явное действие
 * расстановки: после него ВСЁ текущее состояние отбора считается принятым
 * (спека f9a20c3f, DoD «после сохранения порядка все текущие узлы приняты»),
 * поэтому срез пересчитывается исполнением рецепта.
 */
export function setPublicationOrder(
  ndb: NetworkDb,
  publicationId: string,
  items: PublicationOrderItem[],
  actorUserId: string,
): PublicationOrderItem[] {
  return ndb.transaction(() => {
    getPublicationOrThrow(ndb, publicationId);
    const selectedIds = selectCurrentSelection(ndb, publicationId, actorUserId);
    const members = new Set<string>([
      ...selectedIds,
      ...(getPublicationAcceptedIds(ndb, publicationId) ?? []),
    ]);
    assertPublicationOrderKeysKnown(ndb, publicationId, items, members);
    applyPublicationOrder(ndb, publicationId, items, actorUserId);
    setPublicationAcceptedIds(ndb, publicationId, selectedIds);
    invalidatePublicationMembershipCache(publicationId);
    return listPublicationOrder(ndb, publicationId);
  });
}

/**
 * Дописать узел в конец локального порядка, НЕ трогая принятый срез
 * (внутренняя операция действия «расставить» из плашки, задача e754527d:
 * кандидат гасится индивидуально, другие кандидаты остаются).
 *
 * **Идемпотентность.** Если `nodeKey` уже есть в локальном порядке, позиция не
 * трогается (повторный accept — no-op): иначе каждый вызов дописывал бы узел в
 * конец (maxPosition + 1) и «идемпотентная» операция дрейфовала бы.
 */
export function appendPublicationOrderItem(
  ndb: NetworkDb,
  publicationId: string,
  nodeKey: string,
  actorUserId: string,
): PublicationOrderItem[] {
  return ndb.transaction(() => {
    getPublicationOrThrow(ndb, publicationId);
    const order = listPublicationOrder(ndb, publicationId);
    if (order.some((item) => item.node_key === nodeKey)) {
      invalidatePublicationMembershipCache(publicationId);
      return order;
    }
    const maxPosition = order.reduce((max, item) => Math.max(max, item.position), 0);
    applyPublicationOrder(ndb, publicationId, [{ node_key: nodeKey, position: maxPosition + 1 }], actorUserId);
    invalidatePublicationMembershipCache(publicationId);
    return listPublicationOrder(ndb, publicationId);
  });
}

/** Видимый локальный порядок публикации. */
export function listPublicationOrder(
  ndb: NetworkDb,
  publicationId: string,
): PublicationOrderItem[] {
  return (
    ndb
      .prepare(
        `SELECT node_key, position FROM publication_order_v
          WHERE publication_id = ? ORDER BY position ASC`,
      )
      .all(publicationId) as { node_key: string; position: number }[]
  ).map((r) => ({ node_key: r.node_key, position: r.position }));
}

/** Размер порции `IN (…)` — не упираться в лимит переменных SQLite. */
const IN_CHUNK = 400;

/** Разбить список на порции для `IN (…)`. */
function chunk(values: readonly string[]): string[][] {
  if (values.length <= IN_CHUNK) return [values as string[]];
  const out: string[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(values.slice(i, i + IN_CHUNK));
  return out;
}

/**
 * Мысли, входящие в публикацию: узлы текущего отбора заголовков и принятого
 * среза. Плюс содержимое — цели рёбер-источников текстов и «доп. материалов»
 * от узлов публикации; направление/сторона свойства не различаются (берём оба
 * конца ребра), поэтому резолв стороны не нужен, а тип связи свойства сужает
 * выборку. База проверки принадлежности мыслей исключений (ошибка 3882bd46).
 */
function publicationMemberThoughtIds(
  ndb: NetworkDb,
  publicationId: string,
  pub: Publication,
  actorUserId: string,
): Set<string> {
  const ids = new Set<string>([
    ...selectCurrentSelection(ndb, publicationId, actorUserId),
    ...(getPublicationAcceptedIds(ndb, publicationId) ?? []),
  ]);
  const contentProps = [...pub.text_sources, ...pub.extra_properties];
  if (contentProps.length === 0 || ids.size === 0) return ids;
  const linkTypes = new Set<string | null>();
  for (const propId of contentProps) {
    const row = ndb
      .prepare('SELECT value_type, config FROM properties_v WHERE id = ? LIMIT 1')
      .get(propId) as { value_type: string; config: string | null } | undefined;
    if (row === undefined || row.value_type !== 'link') continue;
    let config: unknown = null;
    if (row.config !== null && row.config !== '') {
      try {
        config = JSON.parse(row.config) as unknown;
      } catch {
        config = null;
      }
    }
    linkTypes.add(
      linkPropertyLinkTypeId(
        (config !== null && typeof config === 'object' ? config : null) as Parameters<
          typeof linkPropertyLinkTypeId
        >[0],
      ),
    );
  }
  if (linkTypes.size === 0) return ids;
  const base = new Set(ids);
  const added = new Set<string>();
  for (const linkTypeId of linkTypes) {
    const typeClause = linkTypeId === null ? 'l.type_id IS NULL' : 'l.type_id = ?';
    for (const part of chunk([...base])) {
      const placeholders = part.map(() => '?').join(', ');
      const params = linkTypeId === null ? [...part, ...part] : [linkTypeId, ...part, ...part];
      const rows = ndb
        .prepare(
          `SELECT l.source_id AS source_id, l.target_id AS target_id
             FROM links_v l
            WHERE ${typeClause} AND l.active = 1 AND l.marked_for_deletion = 0
              AND (l.source_id IN (${placeholders}) OR l.target_id IN (${placeholders}))`,
        )
        .all(...params) as Array<{ source_id: string; target_id: string }>;
      for (const r of rows) {
        if (base.has(r.source_id)) added.add(r.target_id);
        else if (base.has(r.target_id)) added.add(r.source_id);
      }
    }
  }
  for (const id of added) ids.add(id);
  return ids;
}

/** Мысль существует и видна (иначе `NOT_FOUND`). */
function assertThoughtVisible(ndb: NetworkDb, thoughtId: string): void {
  const row = ndb.prepare('SELECT 1 FROM thoughts_v WHERE id = ? LIMIT 1').get(thoughtId);
  if (row === undefined) {
    throw new EtnError('NOT_FOUND', `Мысль ${thoughtId} не найдена.`, {
      entity: 'thought',
      id: thoughtId,
    });
  }
}

/** Мысль входит в публикацию (иначе `VALIDATION_ERROR`). */
function assertThoughtInPublication(
  ndb: NetworkDb,
  publicationId: string,
  pub: Publication,
  thoughtId: string,
  actorUserId: string,
): void {
  assertThoughtVisible(ndb, thoughtId);
  const members = publicationMemberThoughtIds(ndb, publicationId, pub, actorUserId);
  if (!members.has(thoughtId)) {
    throw new EtnError('VALIDATION_ERROR', `Мысль ${thoughtId} не входит в публикацию.`, {
      entity: 'thought',
      id: thoughtId,
      code: 'thought_not_in_publication',
    });
  }
}

/** Исключить мысль из публикации (все её вхождения). */
export function addPublicationExclusion(
  ndb: NetworkDb,
  publicationId: string,
  thoughtId: string,
  actorUserId: string,
): PublicationExclusion[] {
  return ndb.transaction(() => {
    const pub = getPublicationOrThrow(ndb, publicationId);
    // Мысль обязана существовать и входить в публикацию (ошибка 3882bd46):
    // посторонний id отвергается, а не молча попадает в список исключений.
    assertThoughtInPublication(ndb, publicationId, pub, thoughtId, actorUserId);
    const id = publicationExclusionId(publicationId, thoughtId);
    const materialized = materializeShadow(ndb, 'publication_exclusions', id);
    if (materialized) {
      ndb
        .prepare(
          `UPDATE publication_exclusions SET deleted = 0 WHERE id = ? AND layer_id = ?`,
        )
        .run(id, ndb.layerId);
    } else {
      const now = new Date().toISOString();
      ndb
        .prepare(
          `INSERT INTO publication_exclusions (id, layer_id, publication_id, thought_id,
                                               created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ndb.layerId, publicationId, thoughtId, now, actorUserId);
    }
    invalidatePublicationMembershipCache(publicationId);
    return listPublicationExclusions(ndb, publicationId);
  });
}

/**
 * Снять исключение мысли.
 *
 * **Осиротевшая строка (3882bd46, дожим).** Если строка исключения физически
 * существует (в т.ч. мысль уже выпала из публикации после смены рецепта),
 * снятие разрешено и чистит её — иначе осиротевшая строка молча подавила бы
 * мысль при возврате в отбор, а снять её было бы нечем. Симметричная валидация
 * (мысль существует и входит в публикацию) применяется только когда строки
 * нет: тогда снятие — no-op либо ошибка, но не «молчаливое» состояние.
 *
 * Чистку осиротевших строк в `rebuild` сознательно НЕ делаем: спека f9a20c3f
 * ограничивает пересборку «assembly_date + мёртвые строки publication_order,
 * никаких других данных».
 *
 * Состав публикации от пользователя не зависит (userId влияет лишь на
 * сортировку рецепта), поэтому он не передаётся.
 */
export function removePublicationExclusion(
  ndb: NetworkDb,
  publicationId: string,
  thoughtId: string,
): PublicationExclusion[] {
  return ndb.transaction(() => {
    const pub = getPublicationOrThrow(ndb, publicationId);
    const id = publicationExclusionId(publicationId, thoughtId);
    // Физическая строка (включая другие слои и надгробия) — признак того, что
    // исключение ставилось: снятие обязано её подчистить.
    const physical = ndb
      .prepare('SELECT 1 FROM publication_exclusions WHERE id = ? LIMIT 1') // layers:physical-read
      .get(id);
    if (physical === undefined) {
      assertThoughtInPublication(ndb, publicationId, pub, thoughtId, '');
    }
    const visible = ndb
      .prepare('SELECT 1 FROM publication_exclusions_v WHERE id = ? LIMIT 1')
      .get(id);
    if (visible !== undefined) {
      deleteRowLayered(ndb, 'publication_exclusions', id);
    }
    invalidatePublicationMembershipCache(publicationId);
    return listPublicationExclusions(ndb, publicationId);
  });
}

/** Видимые исключения публикации. */
export function listPublicationExclusions(
  ndb: NetworkDb,
  publicationId: string,
): PublicationExclusion[] {
  return (
    ndb
      .prepare(
        `SELECT publication_id, thought_id, created_at, created_by
           FROM publication_exclusions_v
          WHERE publication_id = ? ORDER BY created_at ASC, thought_id ASC`,
      )
      .all(publicationId) as PublicationExclusion[]
  );
}

// ---------------------------------------------------------------------------
// Полки библиотеки
// ---------------------------------------------------------------------------

/** Строка `shelves_v`. */
interface ShelfRow {
  id: string;
  title: string;
  position: number;
  version: number;
  marked_for_deletion: number;
  marked_for_deletion_at: string | null;
  marked_for_deletion_by: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** Собрать полку с составом. */
function shelfWithItems(ndb: NetworkDb, row: ShelfRow): Shelf {
  const items = (
    ndb
      .prepare(
        `SELECT shelf_id, publication_id, position FROM shelf_items_v
          WHERE shelf_id = ? ORDER BY position ASC`,
      )
      .all(row.id) as ShelfItem[]
  ).map((i) => ({ ...i }));
  return {
    ...row,
    marked_for_deletion: row.marked_for_deletion === 1,
    items,
  };
}

/**
 * Список полок с составом (общие для участников сети). Пометка корзины
 * скрывает полку из списка (0.11.1, задача c59ce742) — по образцу публикаций.
 */
export function listShelves(ndb: NetworkDb): Shelf[] {
  const rows = ndb
    .prepare('SELECT * FROM shelves_v WHERE marked_for_deletion = 0 ORDER BY position ASC, created_at ASC')
    .all() as ShelfRow[];
  return rows.map((row) => shelfWithItems(ndb, row));
}

/**
 * ВСЕ полки среза без фильтра корзины — для экспорта `.etnx` (0.11.1, задача
 * c59ce742): помеченная полка обязана уехать вместе с пометкой, иначе после
 * импорта она приезжала бы живой. Порядок детерминирован (`position`, затем
 * `created_at`, `id`) — раунд-трип стабилен.
 */
export function listAllShelves(ndb: NetworkDb): Shelf[] {
  const rows = ndb
    .prepare('SELECT * FROM shelves_v ORDER BY position ASC, created_at ASC, id ASC')
    .all() as ShelfRow[];
  return rows.map((row) => shelfWithItems(ndb, row));
}

/** Полка по id в контексте слоя; `null` — не видна. */
export function getShelf(ndb: NetworkDb, id: string): Shelf | null {
  const row = ndb.prepare('SELECT * FROM shelves_v WHERE id = ? LIMIT 1').get(id) as
    | ShelfRow
    | undefined;
  return row === undefined ? null : shelfWithItems(ndb, row);
}

/** Полка по id или `NOT_FOUND`. */
function getShelfOrThrow(ndb: NetworkDb, id: string): Shelf {
  const shelf = getShelf(ndb, id);
  if (shelf === null) {
    throw new EtnError('NOT_FOUND', `shelf ${id} not found`, { entity: 'shelf', id });
  }
  return shelf;
}

/** Проверить название полки (непустое, в пределах слоя уникальное среди ЖИВЫХ). */
function validateShelfTitle(ndb: NetworkDb, title: unknown, excludeId?: string): string {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new EtnError('VALIDATION_ERROR', 'title полки обязателен', { field: 'title' });
  }
  const value = title.trim();
  const key = normalizeTitle(value);
  // Уникальность — только среди живых строк (`shelves_v`); надгробие не
  // считается занятым именем — оно выведено из частичного индекса
  // idx_shelves_title_key_live (миграция 047). Так удаление полки в основе
  // (физическое) не делает её имя невосстановимым.
  //
  // Помеченная в корзину полка (`marked_for_deletion = 1`, `deleted = 0`) имя
  // УДЕРЖИВАЕТ — сознательное решение (пользователь, 2026-10-01): полка
  // восстановима, её имя принадлежит ей до физического удаления (purge);
  // освобождать имя при пометке значило бы отдавать его другой полке и ломать
  // restore.
  const clash = ndb
    .prepare('SELECT id FROM shelves_v WHERE title_key = ? AND id <> ? LIMIT 1')
    .get(key, excludeId ?? '') as { id: string } | undefined;
  if (clash !== undefined) {
    throw new EtnError('VALIDATION_ERROR', 'полка с таким именем уже существует', {
      field: 'title',
      code: 'shelf_title_taken',
    });
  }
  return value;
}

/**
 * Обернуть запись полки: нарушение частичного индекса имени (`SQLITE_CONSTRAINT`)
 * — это гонка двух параллельных созданий/переименований, а не внутренняя
 * ошибка. Отдаём штатную `VALIDATION_ERROR` того же кода, что и доменная
 * проверка, вместо сырого `SqliteError`.
 */
function asShelfTitleConflict<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
      throw new EtnError('VALIDATION_ERROR', 'полка с таким именем уже существует', {
        field: 'title',
        code: 'shelf_title_taken',
      });
    }
    throw err;
  }
}

/** Следующая позиция полки (MAX(position) + 1). */
function nextShelfPosition(ndb: NetworkDb): number {
  return (
    (ndb.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM shelves_v').get() as { p: number })
      .p + 1
  );
}

/**
 * INSERT строки полки с заданным id (общая часть {@link createShelf} и
 * {@link ensureDefaultShelf}). Нарушение уникальности имени превращается в
 * штатную `VALIDATION_ERROR` (`asShelfTitleConflict`).
 */
function insertShelfRow(
  ndb: NetworkDb,
  id: string,
  title: string,
  position: number,
  actorUserId: string,
): Shelf {
  const now = new Date().toISOString();
  asShelfTitleConflict(() =>
    ndb
      .prepare(
        `INSERT INTO shelves (id, layer_id, title, title_key, position, version,
                              created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(id, ndb.layerId, title, normalizeTitle(title), position, now, actorUserId, now, actorUserId),
  );
  return getShelfOrThrow(ndb, id);
}

/** Создать полку. */
export function createShelf(ndb: NetworkDb, input: ShelfInput, actorUserId: string): Shelf {
  return ndb.transaction(() => {
    const title = validateShelfTitle(ndb, input.title);
    const id = randomUUID();
    const position =
      typeof input.position === 'number' ? Math.trunc(input.position) : nextShelfPosition(ndb);
    return insertShelfRow(ndb, id, title, position, actorUserId);
  });
}

/** Переименовать полку / изменить её порядок. */
export function updateShelf(
  ndb: NetworkDb,
  id: string,
  input: ShelfInput,
  actorUserId: string,
): Shelf {
  return ndb.transaction(() => {
    getShelfOrThrow(ndb, id);
    const sets: string[] = [];
    const args: unknown[] = [];
    if (input.title !== undefined) {
      const title = validateShelfTitle(ndb, input.title, id);
      sets.push('title = ?', 'title_key = ?');
      args.push(title, normalizeTitle(title));
    }
    if (input.position !== undefined) {
      sets.push('position = ?');
      args.push(Math.trunc(input.position));
    }
    if (sets.length === 0) return getShelfOrThrow(ndb, id);
    const now = new Date().toISOString();
    sets.push('version = version + 1', 'updated_at = ?', 'updated_by = ?');
    args.push(now, actorUserId, id, ndb.layerId);
    materializeShadow(ndb, 'shelves', id);
    asShelfTitleConflict(() =>
      ndb.prepare(`UPDATE shelves SET ${sets.join(', ')} WHERE id = ? AND layer_id = ?`).run(...args),
    );
    return getShelfOrThrow(ndb, id);
  });
}

/**
 * Проверка физического удаления полки (0.11.1, задача c59ce742). Собственных
 * блокировок у полки нет: состав уходит каскадом, публикации не трогаются
 * (полка — как плейлист, карточка c80951ea). Ограничение одно — контекст:
 * физическое удаление доступно только в основе (см. {@link deleteShelf}),
 * поэтому `blocked` отражает именно рабочий слой. `blocking.items` —
 * информационно: сколько строк состава снесёт каскад.
 */
export function checkShelfDeletion(ndb: NetworkDb, id: string): ShelfDeletionCheckResult {
  const shelf = getShelfOrThrow(ndb, id);
  return {
    blocked: !isBaseContext(ndb),
    blocking: { items: shelf.items.length },
  };
}

/**
 * Пометить полку на удаление (корзина). Доступно в любом слое; пометка —
 * ветвимая правка и уезжает слиянием (0.11.1, требование 200b87be).
 */
export function trashShelf(ndb: NetworkDb, id: string, actorUserId: string): Shelf {
  return markShelfTrashed(ndb, id, true, actorUserId);
}

/** Снять пометку на удаление. */
export function restoreShelf(ndb: NetworkDb, id: string, actorUserId: string): Shelf {
  return markShelfTrashed(ndb, id, false, actorUserId);
}

/**
 * Гарантировать живую дефолтную полку «Полка» (0.11.1, задача 8c2660e6;
 * карточка c80951ea v2). Когда в текущем контексте слоя живых полок нет,
 * возвращает созданную или восстановленную полку, иначе — `null` (живая полка
 * уже есть, ничего не делаем).
 *
 * Почему восстановление, а не только создание: имя помеченной в корзину полки
 * удерживается частичным уникальным индексом `idx_shelves_title_key_live`
 * (миграция 047) — повторный `createShelf` с тем же именем упал бы
 * `shelf_title_taken`. Поэтому одноимённая полка в корзине оживляется; нет
 * такой — создаётся новая.
 *
 * Вызывать в контексте ОСНОВЫ: дефолтная полка сети живёт в основе и видна
 * всем слоям (карточка c80951ea v2: «в основе, не в рабочем слое»).
 */
export function ensureDefaultShelf(ndb: NetworkDb, actorUserId: string): Shelf | null {
  if (listShelves(ndb).length > 0) return null;
  // Дефолтная полка с детерминированным id уже существует, но в корзине, —
  // оживляем её (INSERT с тем же id столкнулся бы с первичным ключом).
  const byId = ndb
    .prepare('SELECT id FROM shelves_v WHERE id = ? LIMIT 1')
    .get(DEFAULT_SHELF_ID) as { id: string } | undefined;
  if (byId !== undefined) return restoreShelf(ndb, byId.id, actorUserId);
  // Иначе — одноимённая полка в корзине (имя удержано, см. выше).
  const byName = ndb
    .prepare('SELECT id FROM shelves_v WHERE title_key = ? LIMIT 1')
    .get(normalizeTitle(DEFAULT_SHELF_TITLE)) as { id: string } | undefined;
  if (byName !== undefined) return restoreShelf(ndb, byName.id, actorUserId);
  return insertShelfRow(ndb, DEFAULT_SHELF_ID, DEFAULT_SHELF_TITLE, nextShelfPosition(ndb), actorUserId);
}

/** Общая реализация пометки/снятия пометки корзины полки. */
function markShelfTrashed(
  ndb: NetworkDb,
  id: string,
  trashed: boolean,
  actorUserId: string,
): Shelf {
  return ndb.transaction(() => {
    getShelfOrThrow(ndb, id);
    const now = new Date().toISOString();
    materializeShadow(ndb, 'shelves', id);
    if (trashed) {
      ndb
        .prepare(
          `UPDATE shelves
              SET marked_for_deletion = 1, marked_for_deletion_at = ?, marked_for_deletion_by = ?,
                  version = version + 1, updated_at = ?, updated_by = ?
            WHERE id = ? AND layer_id = ?`,
        )
        .run(now, actorUserId, now, actorUserId, id, ndb.layerId);
    } else {
      ndb
        .prepare(
          `UPDATE shelves
              SET marked_for_deletion = 0, marked_for_deletion_at = NULL,
                  marked_for_deletion_by = NULL,
                  version = version + 1, updated_at = ?, updated_by = ?
            WHERE id = ? AND layer_id = ?`,
        )
        .run(now, actorUserId, id, ndb.layerId);
    }
    return getShelfOrThrow(ndb, id);
  });
}

/**
 * Физическое удаление полки (purge; 0.11.1, задача c59ce742, карточка
 * c80951ea): только в основе (в слое — `VALIDATION_ERROR` `purge_base_only`).
 * Строки состава удаляются каскадом, публикации НЕ трогаются — полка ведёт
 * себя как плейлист, поэтому удалять её можно и непустой. Отдельной
 * блокировки «есть публикации» нет: это сверхспековое ограничение убрано.
 */
export function deleteShelf(ndb: NetworkDb, id: string): void {
  ndb.transaction(() => {
    if (!isBaseContext(ndb)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'физическое удаление полки доступно только в основе',
        { entity: 'shelf', id, code: 'purge_base_only' },
      );
    }
    getShelfOrThrow(ndb, id);
    const itemIds = (
      ndb.prepare('SELECT id FROM shelf_items_v WHERE shelf_id = ?').all(id) as { id: string }[]
    ).map((r) => r.id);
    for (const itemId of itemIds) {
      deleteRowLayered(ndb, 'shelf_items', itemId);
    }
    deleteRowLayered(ndb, 'shelves', id);
  });
}

/** Положить публикацию на полку / изменить её позицию. */
export function addShelfItem(
  ndb: NetworkDb,
  shelfId: string,
  publicationId: string,
  position: number,
  _actorUserId: string,
): Shelf {
  return ndb.transaction(() => {
    getShelfOrThrow(ndb, shelfId);
    getPublicationOrThrow(ndb, publicationId);
    const id = shelfItemId(shelfId, publicationId);
    const materialized = materializeShadow(ndb, 'shelf_items', id);
    const pos = Math.trunc(position);
    if (materialized) {
      ndb
        .prepare('UPDATE shelf_items SET position = ?, deleted = 0 WHERE id = ? AND layer_id = ?')
        .run(pos, id, ndb.layerId);
    } else {
      ndb
        .prepare(
          `INSERT INTO shelf_items (id, layer_id, shelf_id, publication_id, position)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, ndb.layerId, shelfId, publicationId, pos);
    }
    return getShelfOrThrow(ndb, shelfId);
  });
}

/** Убрать публикацию с полки. */
export function removeShelfItem(
  ndb: NetworkDb,
  shelfId: string,
  publicationId: string,
): Shelf {
  return ndb.transaction(() => {
    getShelfOrThrow(ndb, shelfId);
    const id = shelfItemId(shelfId, publicationId);
    const visible = ndb.prepare('SELECT 1 FROM shelf_items_v WHERE id = ? LIMIT 1').get(id);
    if (visible !== undefined) {
      deleteRowLayered(ndb, 'shelf_items', id);
    }
    return getShelfOrThrow(ndb, shelfId);
  });
}
