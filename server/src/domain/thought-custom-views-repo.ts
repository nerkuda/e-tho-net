/**
 * Репозиторий внетиповых отборов мысли (`thought_custom_views`, миграция 052;
 * 0.14.1, задача a28d444b; сущность 52d34fed, ADR 6021918b, операция 5e55b7bb
 * «CRUD /thoughts/{id}/views»).
 *
 * Образец — `thought-type-views-repo.ts` (037): ветвимая таблица, чтение через
 * представление `thought_custom_views_v` (правило «ближайший слой побеждает»,
 * db/layer-chain.ts), INSERT — в физическую таблицу текущего слоя, UPDATE — через
 * `materializeShadow`, DELETE — через `deleteRowLayered` (db/layer-write.ts).
 *
 * Отличия от отборов типа:
 *   * владелец — мысль (`thought_id`), имя уникально в пределах мысли;
 *   * уникальность имени — PARTIAL UNIQUE `(thought_id, name_key, layer_id)
 *     WHERE deleted = 0`: надгробие удалённого отбора НЕ занимает имя, повторное
 *     создание того же имени в том же слое — новая живая строка с новым id
 *     (сущность 52d34fed, отличие от 037);
 *   * `id` — случайный UUID (не производный от имени): имя и владелец меняются
 *     (переименование и перенос), детерминированный id конфликтовал бы с
 *     надгробиями при удалении/пересоздании (ADR 6021918b).
 *
 * Доменные правила (уникальность имени с `409 DUPLICATE`, один `is_default` у
 * мысли, перекрытие в эффективном наборе) — в
 * `thought-custom-views-service.ts`.
 */

import { randomUUID } from 'node:crypto';

import type { NetworkDb } from '../db/network-db.js';
import {
  deleteRowLayered,
  materializeShadow,
  type BranchableTable,
} from '../db/layer-write.js';

/** Ветвимая таблица внетиповых отборов мысли. */
type ThoughtCustomViewsTable = Extract<BranchableTable, 'thought_custom_views'>;

/** Raw `thought_custom_views_v` row (INTEGER booleans). */
export interface ThoughtCustomViewRow {
  id: string;
  thought_id: string;
  name: string;
  name_key: string;
  description: string | null;
  definition: string;
  position: number;
  is_default: number;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
}

/** Входные данные для создания внетипового отбора. */
export interface CreateThoughtCustomViewInput {
  thought_id: string;
  name: string;
  description?: string | null;
  definition: string;
  position?: number;
  is_default?: boolean;
}

/** Поля, которые можно править у существующего внетипового отбора. */
export interface UpdateThoughtCustomViewInput {
  name?: string;
  description?: string | null;
  definition?: string;
  position?: number;
  is_default?: boolean;
}

/**
 * Колонки SELECT из представления. Фиксированный список страхует от регрессий
 * при добавлении столбцов; служебные `layer_id`/`deleted`/`base_version`/`pk`
 * наружу не отдаются.
 */
const COLUMNS =
  'id, thought_id, name, name_key, description, definition, position, ' +
  'is_default, version, created_at, updated_at, created_by';

/** Нормализация имени в `name_key` — trim + lowercase (правило хранения). */
function viewNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Проверить формат имени: непустая строка. Длину проверяет домен. */
function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('name must be a non-empty string');
  }
  return name.trim();
}

/** Отбор по id или `null`, если строки нет/она скрыта надгробием в слое. */
export function getThoughtCustomView(
  ndb: NetworkDb,
  id: string,
): ThoughtCustomViewRow | null {
  const row = ndb
    .prepare(`SELECT ${COLUMNS} FROM thought_custom_views_v WHERE id = ?`)
    .get(id) as ThoughtCustomViewRow | undefined;
  return row ?? null;
}

/**
 * Список живых отборов одной мысли, упорядоченный по `position, name`.
 *
 * `currentLayerOnly = true` — «только собственные определения в текущем слое»
 * (контракт `GET /thoughts/{id}/views`: без подтягивания базового слоя до
 * слияния, как у отборов типа). По умолчанию — через `*_v` (свёртка цепочки
 * слоёв) для эффективного набора.
 */
export function listThoughtCustomViewsByThought(
  ndb: NetworkDb,
  thoughtId: string,
  options?: { currentLayerOnly?: boolean },
): ThoughtCustomViewRow[] {
  if (options?.currentLayerOnly === true) {
    return ndb
      .prepare(
        `SELECT ${COLUMNS} FROM thought_custom_views
          WHERE layer_id = ? AND thought_id = ? AND deleted = 0
          ORDER BY position, name`,
      )
      .all(ndb.layerId, thoughtId) as ThoughtCustomViewRow[];
  }
  return ndb
    .prepare(
      `SELECT ${COLUMNS} FROM thought_custom_views_v
        WHERE thought_id = ?
        ORDER BY position, name`,
    )
    .all(thoughtId) as ThoughtCustomViewRow[];
}

/**
 * Создать внетиповой отбор мысли. Запись идёт в `ndb.layerId`.
 *
 * `position` без явного значения — за максимальной среди ВИДИМЫХ отборов мысли
 * (MAX+1): новый отбор встаёт в конец, как у отборов типа (ошибка a62190d1).
 *
 * Уникальность имени держит partial unique index `idx_thought_custom_views_name_live`;
 * домен проверяет дубль заранее, чтобы отдать структурированный `409 DUPLICATE`.
 */
export function insertThoughtCustomView(
  ndb: NetworkDb,
  input: CreateThoughtCustomViewInput,
  actorUserId: string,
): ThoughtCustomViewRow {
  const name = validateName(input.name);
  const nameKey = viewNameKey(name);
  const id = randomUUID();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  ndb.transaction(() => {
    const position =
      input.position ??
      (
        ndb
          .prepare(
            'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM thought_custom_views_v WHERE thought_id = ?',
          )
          .get(input.thought_id) as { p: number }
      ).p;
    ndb
      .prepare(
        `INSERT INTO thought_custom_views
           (id, layer_id, thought_id, name, name_key, description,
            definition, position, is_default,
            version, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        ndb.layerId,
        input.thought_id,
        name,
        nameKey,
        input.description ?? null,
        input.definition,
        position,
        input.is_default ? 1 : 0,
        now,
        now,
        actorUserId,
      );
  });
  const created = getThoughtCustomView(ndb, id);
  if (!created) {
    throw new Error('thought_custom_views row not found after insert');
  }
  return created;
}

/**
 * Править внетиповой отбор (last-write-wins по полям). В слое — сначала
 * `materializeShadow`: первая правка строки предка копирует её в текущий слой,
 * дальнейшие правки обновляют только строку слоя. Так правка одного отбора
 * сливается независимо от мысли и соседних отборов.
 */
export function updateThoughtCustomView(
  ndb: NetworkDb,
  id: string,
  changes: UpdateThoughtCustomViewInput,
): ThoughtCustomViewRow {
  const current = getThoughtCustomView(ndb, id);
  if (!current) {
    throw new Error(`thought_custom_view ${id} not found`);
  }

  const sets: string[] = [];
  const args: unknown[] = [];

  if (changes.name !== undefined) {
    const newName = validateName(changes.name);
    const newKey = viewNameKey(newName);
    if (newKey !== current.name_key || newName !== current.name) {
      sets.push('name = ?', 'name_key = ?');
      args.push(newName, newKey);
    }
  }
  if (changes.description !== undefined) {
    sets.push('description = ?');
    args.push(changes.description);
  }
  if (changes.definition !== undefined) {
    sets.push('definition = ?');
    args.push(changes.definition);
  }
  if (changes.position !== undefined) {
    sets.push('position = ?');
    args.push(changes.position);
  }
  if (changes.is_default !== undefined) {
    sets.push('is_default = ?');
    args.push(changes.is_default ? 1 : 0);
  }

  const now = new Date().toISOString();
  sets.push('version = version + 1', 'updated_at = ?');
  args.push(now);

  ndb.transaction(() => {
    materializeShadow(ndb, 'thought_custom_views' as ThoughtCustomViewsTable, id);
    args.push(id, ndb.layerId);
    ndb
      .prepare(
        `UPDATE thought_custom_views SET ${sets.join(', ')}
          WHERE id = ? AND layer_id = ?`,
      )
      .run(...args);
  });

  const updated = getThoughtCustomView(ndb, id);
  if (!updated) {
    throw new Error(`thought_custom_view ${id} disappeared after update`);
  }
  return updated;
}

/**
 * Удалить отбор: в основе — физический `DELETE`, в слое — надгробие.
 * Возвращает `false`, если строки нет.
 */
export function deleteThoughtCustomView(ndb: NetworkDb, id: string): boolean {
  const before = getThoughtCustomView(ndb, id);
  if (!before) return false;
  ndb.transaction(() => {
    deleteRowLayered(ndb, 'thought_custom_views' as ThoughtCustomViewsTable, id);
  });
  return true;
}

/**
 * Найти живой отбор мысли по `(thought_id, name_key)` — для `409 DUPLICATE`
 * до ловли UNIQUE. `exceptId` исключает сам редактируемый отбор.
 */
export function findThoughtCustomViewByThoughtAndNameKey(
  ndb: NetworkDb,
  thoughtId: string,
  nameKey: string,
  exceptId?: string,
): ThoughtCustomViewRow | null {
  const row = ndb
    .prepare(
      `SELECT ${COLUMNS} FROM thought_custom_views_v
        WHERE thought_id = ? AND name_key = ?
          ${exceptId ? 'AND id <> ?' : ''}
        LIMIT 1`,
    )
    .get(...(exceptId ? [thoughtId, nameKey, exceptId] : [thoughtId, nameKey])) as
    | ThoughtCustomViewRow
    | undefined;
  return row ?? null;
}

/**
 * Коллизия натурального ключа при материализации тени в текущем слое: строка
 * предка несёт имя, которое в слое уже занято живой строкой с другим `id`
 * (слои разошлись). `materializeShadow` упал бы сырым
 * `SQLITE_CONSTRAINT_UNIQUE` уже из-под сервиса; репозиторий сообщает о
 * коллизии типизированно, а домен отдаёт `409 DUPLICATE` (контракт 5e55b7bb,
 * проверка раунда 1 — Б1).
 */
export class ThoughtCustomViewNameCollisionError extends Error {
  constructor(
    readonly thoughtId: string,
    readonly nameKey: string,
    readonly existingId: string,
    readonly existingName: string,
  ) {
    super(
      `thought_custom_view ${existingId} уже занимает имя "${existingName}" в текущем слое`,
    );
    this.name = 'ThoughtCustomViewNameCollisionError';
  }
}

/**
 * Снять пометку «по умолчанию» со всех живых отборов мысли в текущем слое,
 * кроме `exceptId`. У мысли не более одного дефолтного внетипового отбора
 * (требование 045f539a); снятие идёт в одной транзакции с установкой новой
 * пометки. В слое — `materializeShadow` для видимых строк, иначе UPDATE не
 * зацепит строку предка.
 *
 * Перед материализацией проверяется натуральный ключ: живая одноимённая строка
 * слоя с другим `id` — {@link ThoughtCustomViewNameCollisionError} (а не сырой
 * constraint из `materializeShadow`).
 */
export function clearDefaultForThought(ndb: NetworkDb, thoughtId: string, exceptId?: string): number {
  const rows = ndb
    .prepare(
      `SELECT id, name, name_key FROM thought_custom_views_v
        WHERE thought_id = ? AND is_default = 1
          ${exceptId ? 'AND id <> ?' : ''}`,
    )
    .all(...(exceptId ? [thoughtId, exceptId] : [thoughtId])) as Array<{
    id: string;
    name: string;
    name_key: string;
  }>;

  if (rows.length === 0) return 0;

  ndb.transaction(() => {
    for (const row of rows) {
      const clash = ndb
        .prepare(
          `SELECT id, name FROM thought_custom_views
            WHERE layer_id = ? AND thought_id = ? AND name_key = ?
              AND deleted = 0 AND id <> ?
            LIMIT 1`,
        )
        .get(ndb.layerId, thoughtId, row.name_key, row.id) as
        | { id: string; name: string }
        | undefined;
      if (clash) {
        throw new ThoughtCustomViewNameCollisionError(
          thoughtId,
          row.name_key,
          clash.id,
          clash.name,
        );
      }
      materializeShadow(ndb, 'thought_custom_views' as ThoughtCustomViewsTable, row.id);
    }
    ndb
      .prepare(
        `UPDATE thought_custom_views
            SET is_default = 0, version = version + 1, updated_at = ?
          WHERE thought_id = ? AND is_default = 1 AND layer_id = ?
            ${exceptId ? 'AND id <> ?' : ''}`,
      )
      .run(
        new Date().toISOString(),
        thoughtId,
        ndb.layerId,
        ...(exceptId ? [exceptId] : []),
      );
  });

  return rows.length;
}
