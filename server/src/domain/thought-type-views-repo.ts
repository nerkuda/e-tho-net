/**
 * Репозиторий отборов типов мыслей (`thought_type_views`, миграция 037;
 * тех.проект 918833e3 «Отборы для типов мыслей», задача 5361aa33 «Хранение
 * отборов типов: таблица thought_type_views и ветвимость в слоях»).
 *
 * На этом этапе — только хранение и базовые CRUD-операции, согласованные с
 * ветвимостью слоёв (фаза S, docs/13-layers.md §5). Доменная логика —
 * единственный `is_default` в пределах типа (требование 7263e565),
 * эффективный набор по цепочке предков (требование eaca1253) и пометка
 * «по умолчанию» транзакционно (требование 7263e565, «Кто держит инвариант»)
 * — остаётся за задачей 17eb741e «Домен отборов типа». Здесь только проверка
 * уникальности имени внутри типа, которую держит UNIQUE-индекс
 * `(thought_type_id, name_key, layer_id)` миграции 037.
 *
 * Чтение. Все публичные функции читают через представление `thought_type_views_v`,
 * создаваемое `db/layer-chain.ts` (правило «ближайший слой побеждает»,
 * 13-layers.md §4.1): не нужно знать про слои, чтобы получить живую строку.
 *
 * Запись. INSERT идёт в физическую таблицу `thought_type_views` текущего слоя
 * (`ndb.layerId`). UPDATE в слое работает через `materializeShadow`
 * (db/layer-write.ts §5.1) — на первой правке строка предка копируется в
 * текущий слой, дальнейшие правки обновляют только строку слоя. DELETE идёт
 * через `deleteRowLayered` (db/layer-write.ts §5.2): в основе — физическое
 * удаление, в слое — надгробие. Так правки одного отбора в слое сливаются
 * независимо от соседних отборов того же типа — это и есть причина вынести
 * отборы из JSON внутри типа в отдельную таблицу.
 *
 * Поле `definition` хранится как JSON-строка того же формата, что и у
 * `saved_filters.definition` (`StructureFilter` + `sort`/`order`; shared
 * `SavedFilterDefinition`). Этап хранилища не интерпретирует `definition` —
 * это работа этапа 1 «Токены отбора» (задача 20b2fca0).
 */

import { randomUUID } from 'node:crypto';

import type { NetworkDb } from '../db/network-db.js';
import {
  deleteRowLayered,
  materializeShadow,
  type BranchableTable,
} from '../db/layer-write.js';

/**
 * Ветвимая таблица отборов типов. Объявлена как локальная типизация поверх
 * `BRANCHABLE_TABLES` (db/layer-chain.ts) — `BranchableTable` закрыто
 * фиксированным списком, и `thought_type_views` там уже добавлено (миграция
 * 037, правка layer-chain.ts).
 */
type ThoughtTypeViewsTable = Extract<BranchableTable, 'thought_type_views'>;

/** Raw `thought_type_views_v` row (INTEGER booleans). */
export interface ThoughtTypeViewRow {
  id: string;
  thought_type_id: string;
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

/** Имя отбора уникально в пределах одного типа мысли (требование 141c2576). */
export const THOUGHT_TYPE_VIEW_NAME_MAX = 200;

/** Входные данные для создания отбора. */
export interface CreateThoughtTypeViewInput {
  thought_type_id: string;
  name: string;
  description?: string | null;
  definition: string;
  position?: number;
  is_default?: boolean;
}

/** Поля, которые можно править у существующего отбора. */
export interface UpdateThoughtTypeViewInput {
  name?: string;
  description?: string | null;
  definition?: string;
  position?: number;
  is_default?: boolean;
}

/**
 * Колонки для SELECT из представления `thought_type_views_v`.
 *
 * Состав столбцов повторяет физическую таблицу `thought_type_views` за
 * вычетом служебных `layer_id`/`deleted`/`base_version`/`pk` — их не нужно
 * светить вызывающим. Прямой SELECT * с представления тоже сработал бы, но
 * фиксированный список страхует от регрессий при добавлении столбцов.
 */
const COLUMNS =
  'id, thought_type_id, name, name_key, description, definition, position, ' +
  'is_default, version, created_at, updated_at, created_by';

/** Нормализация имени в `name_key` — trim + lowercase, как у `typeNameKey` в shared. */
function viewNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Проверить формат имени: непустая строка до {@link THOUGHT_TYPE_VIEW_NAME_MAX} символов. */
function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('name must be a non-empty string');
  }
  if (name.length > THOUGHT_TYPE_VIEW_NAME_MAX) {
    throw new Error(`name must be at most ${THOUGHT_TYPE_VIEW_NAME_MAX} characters`);
  }
  return name.trim();
}

/**
 * Вернуть отбор по id или `null`, если строки нет (или она скрыта надгробием
 * в текущем слое). Чтение через `*_v` — учитывает ветвимость автоматически.
 */
export function getThoughtTypeView(ndb: NetworkDb, id: string): ThoughtTypeViewRow | null {
  const row = ndb
    .prepare(`SELECT ${COLUMNS} FROM thought_type_views_v WHERE id = ?`)
    .get(id) as ThoughtTypeViewRow | undefined;
  return row ?? null;
}

/**
 * Список живых отборов одного типа мысли в текущем слое, упорядоченный по
 * `position` (требование eaca1253 «Эффективный набор» — порядок кнопок
 * определяется `position` внутри уровня иерархии типов).
 *
 * Не выполняет обход цепочки предков типа — это задача доменного слоя
 * (задача 17eb741e). Здесь только сырьё по одному логическому типу.
 */
export function listThoughtTypeViewsByType(ndb: NetworkDb, thoughtTypeId: string): ThoughtTypeViewRow[] {
  return ndb
    .prepare(
      `SELECT ${COLUMNS} FROM thought_type_views_v
        WHERE thought_type_id = ?
        ORDER BY position, name`,
    )
    .all(thoughtTypeId) as ThoughtTypeViewRow[];
}

/**
 * Создать отбор типа. Запись идёт в `ndb.layerId` — в базу, если соединение
 * открыто в основе, или в текущий слой иначе. UNIQUE
 * `(thought_type_id, name_key, layer_id)` миграции 037 охраняет имя внутри
 * типа в пределах слоя; дубль выльется в `UNIQUE constraint failed`.
 *
 * Ограничение «один is_default в пределах типа» (требование 7263e565)
 * здесь НЕ обеспечивается: доменный слой (задача 17eb741e) снимает пометку
 * с прежнего отбора того же типа в одной транзакции. Уровень хранения
 * принимает несколько `is_default = 1` подряд — это временное состояние
 * внутри одной транзакции, не наблюдаемое читателями.
 */
export function insertThoughtTypeView(
  ndb: NetworkDb,
  input: CreateThoughtTypeViewInput,
  actorUserId: string,
): ThoughtTypeViewRow {
  const name = validateName(input.name);
  const nameKey = viewNameKey(name);
  const id = randomUUID();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  ndb.transaction(() => {
    ndb
      .prepare(
        `INSERT INTO thought_type_views
           (id, layer_id, thought_type_id, name, name_key, description,
            definition, position, is_default,
            version, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        ndb.layerId,
        input.thought_type_id,
        name,
        nameKey,
        input.description ?? null,
        input.definition,
        input.position ?? 0,
        input.is_default ? 1 : 0,
        now,
        now,
        actorUserId,
      );
  });
  // Доступ после транзакции: только что вставленная строка видна через *_v.
  const created = getThoughtTypeView(ndb, id);
  if (!created) {
    // Защита от рассинхрона транзакции и представления; на практике
    // unreachable — UNIQUE-конфликт или другая ошибка проявилась бы раньше.
    throw new Error('thought_type_views row not found after insert');
  }
  return created;
}

/**
 * Править отбор (last-write-wins по полям). В слое — сначала
 * `materializeShadow` (S4, 13-layers.md §5.1): на первой правке строка
 * предка копируется в текущий слой, дальнейшие правки обновляют только
 * строку слоя. Так правка одного отбора сливается независимо от соседних
 * отборов того же типа — это и есть причина вынести отборы из JSON внутри
 * типа в отдельную таблицу.
 *
 * Возвращает обновлённую строку. Бросает ошибку, если строки нет
 * (`NOT_FOUND`-семантика для репозитория — обычный throw).
 */
export function updateThoughtTypeView(
  ndb: NetworkDb,
  id: string,
  changes: UpdateThoughtTypeViewInput,
  actorUserId: string,
): ThoughtTypeViewRow {
  const current = getThoughtTypeView(ndb, id);
  if (!current) {
    throw new Error(`thought_type_view ${id} not found`);
  }

  const sets: string[] = [];
  const args: unknown[] = [];

  if (changes.name !== undefined) {
    const newName = validateName(changes.name);
    const newKey = viewNameKey(newName);
    if (newKey !== current.name_key) {
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

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  sets.push('version = version + 1', 'updated_at = ?', 'created_by = ?');
  args.push(now, actorUserId);

  ndb.transaction(() => {
    // Копия предка в текущий слой перед UPDATE — иначе правка в слое
    // затронула бы строку основы.
    materializeShadow(ndb, 'thought_type_views' as ThoughtTypeViewsTable, id);
    args.push(id, ndb.layerId);
    ndb
      .prepare(
        `UPDATE thought_type_views SET ${sets.join(', ')}
          WHERE id = ? AND layer_id = ?`,
      )
      .run(...args);
  });

  const updated = getThoughtTypeView(ndb, id);
  if (!updated) {
    throw new Error(`thought_type_view ${id} disappeared after update`);
  }
  return updated;
}

/**
 * Удалить отбор. В базе — физическое `DELETE`; в слое — надгробие (S4,
 * 13-layers.md §5.2: `deleteRowLayered`). Возвращает `true`, если строка
 * была видима и удалена/скрыта; `false`, если строки нет вовсе.
 */
export function deleteThoughtTypeView(ndb: NetworkDb, id: string): boolean {
  const before = getThoughtTypeView(ndb, id);
  if (!before) return false;
  ndb.transaction(() => {
    deleteRowLayered(ndb, 'thought_type_views' as ThoughtTypeViewsTable, id);
  });
  return true;
}

/**
 * Найти отбор по паре `(thought_type_id, name_key)`. Используется доменным
 * слоем (задача 17eb741e) для проверки уникальности имени в пределах типа
 * (требование 141c2576) до того, как ловить `UNIQUE constraint failed` от
 * SQLite — чтобы выдать структурированный `409 DUPLICATE` с осмысленными
 * `details.existing_id` / `details.existing_name`.
 *
 * `name_key` — нормализованная форма имени (trim + lowercase); сервис
 * считает её через `viewNameKey`, репозиторий принимает готовое значение,
 * чтобы случайно не разойтись по нормализации.
 *
 * `exceptId` — необязательный id, который надо исключить из поиска
 * (нужен при переименовании, чтобы не считать самого себя дублем).
 */
export function findThoughtTypeViewByTypeAndNameKey(
  ndb: NetworkDb,
  thoughtTypeId: string,
  nameKey: string,
  exceptId?: string,
): ThoughtTypeViewRow | null {
  const row = ndb
    .prepare(
      `SELECT ${COLUMNS} FROM thought_type_views_v
        WHERE thought_type_id = ? AND name_key = ?
          ${exceptId ? 'AND id <> ?' : ''}
        LIMIT 1`,
    )
    .get(...(exceptId ? [thoughtTypeId, nameKey, exceptId] : [thoughtTypeId, nameKey])) as
    | ThoughtTypeViewRow
    | undefined;
  return row ?? null;
}

/**
 * Снять пометку «по умолчанию» со ВСЕХ живых отборов данного типа в текущем
 * слое, кроме `exceptId` (если указан). Используется доменным слоем для
 * переноса пометки (требование 7263e565 «У типа не более одного отбора по
 * умолчанию») — внутри одной транзакции вместе с обновлением нового
 * «дефолтного» отбора.
 *
 * В слое действуем через `materializeShadow` для каждой видимой строки:
 * иначе `UPDATE` текущего слоя не зацепил бы строку предка, у которой нет
 * тени (S4, 13-layers.md §5.1). В основе материализация не нужна — там
 * строка единственная, UPDATE работает напрямую.
 *
 * Возвращает количество строк, у которых пометка была снята (для диагностики
 * и тестов).
 */
export function clearDefaultForThoughtType(
  ndb: NetworkDb,
  thoughtTypeId: string,
  exceptId?: string,
): number {
  const rows = ndb
    .prepare(
      `SELECT id FROM thought_type_views_v
        WHERE thought_type_id = ? AND is_default = 1
          ${exceptId ? 'AND id <> ?' : ''}`,
    )
    .all(...(exceptId ? [thoughtTypeId, exceptId] : [thoughtTypeId])) as Array<{ id: string }>;

  if (rows.length === 0) return 0;

  ndb.transaction(() => {
    for (const row of rows) {
      materializeShadow(ndb, 'thought_type_views' as ThoughtTypeViewsTable, row.id);
    }
    ndb
      .prepare(
        `UPDATE thought_type_views
            SET is_default = 0, version = version + 1, updated_at = ?
          WHERE thought_type_id = ? AND is_default = 1 AND layer_id = ?
            ${exceptId ? 'AND id <> ?' : ''}`,
      )
      .run(
        new Date().toISOString(),
        thoughtTypeId,
        ndb.layerId,
        ...(exceptId ? [exceptId] : []),
      );
  });

  return rows.length;
}
