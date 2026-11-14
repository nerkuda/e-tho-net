/**
 * Материализованная проекция задач (0.16.1, задача 632eca85; ADR d0c07f33,
 * сущность `tasks` 46e00dde).
 *
 * Задача — строка `- [ ]` в `body_md` комментария (хроно-записи ИЛИ постоянного).
 * Текст — источник истины; `task_rows` / `task_row_dates` / `task_row_subjects`
 * — проекция, которую пере-создаёт эта функция парсером `@etn/markdown`
 * ({@link parseTaskLines}). Ручные правки таблиц запрещены.
 *
 * **Хук записи.** Домен комментариев (и импорт/слияние) ставит в очередь
 * `comment_id`; обёртка записи `runWriteCore` после КОММИТА вызывает
 * {@link flushTaskProjection} — пере-парс идёт вне транзакции записи, поэтому
 * упавший разбор не ломает уже применённую запись. Очередь живёт в памяти
 * соединения (WeakMap): откат транзакции её выбрасывает
 * ({@link discardTaskProjectionQueue}).
 *
 * **Слои.** Строка проекции существует только вместе с редакцией комментария,
 * поэтому `layer_id` — атрибут строки (`NULL` = основа), а видимость строк
 * считается по видимости комментария: `comments_v` отдаёт победителя цепочки,
 * строка видима, когда её `layer_id` совпадает со слоем этого победителя.
 * Слияние слоя (таблицы НЕ мержим): строки слоя удаляются, финальные тексты
 * основы пере-парсятся; «отказаться от изменений» удаляет строки слоя.
 *
 * **Актуальность.** `parsed_revision` строки = `version` комментария в момент
 * разбора; глобальный маркер сети — `task_projection_state.max_revision`
 * (максимум ревизий комментариев). Расхождение маркера у клиента — «Обновить».
 * Проекция старых сетей достраивается разовым свипом при старте сервера
 * ({@link sweepTaskProjection}).
 */

import { BASE_LAYER_ID } from '@etn/shared';
import { parseTaskLines } from '@etn/markdown';

import type { Logger } from '../logger.js';
import { openNetworkDb, type NetworkDb } from '../db/network-db.js';
import type { SystemDb } from '../db/system-db.js';

/** Версия схемы проекции: смена пере-парсит сети при старте (как `md.render_version`). */
export const TASK_PROJECTION_VERSION = '1';

/** L1-настройка `_system.db`: последняя развёрнутая версия проекции задач. */
export const TASK_PROJECTION_SETTING = 'tasks.projection_version';

/** Строка проекции одной строки `body_md`. */
export interface ProjectionRow {
  /** Номер строки `body_md` с нуля (операция de4cee18). */
  lineNo: number;
  text: string;
  isTask: boolean;
  done: boolean;
  depth: number;
  /** Ближайшая вышестоящая ЗАДАЧА (её `line_no`), не пункт чек-листа. */
  parentLineNo: number | null;
  subtask: boolean;
  periodFrom: string | null;
  periodTo: string | null;
  due: string | null;
  dates: Array<{ date: string; time: string | null }>;
  subjects: string[];
}

/** Значение `layer_id` проекции: `null` — основа. */
export function projectionLayerOf(commentLayerId: string): string | null {
  return commentLayerId === BASE_LAYER_ID ? null : commentLayerId;
}

/** `layer_id` проекции текущего контекста соединения: `null` — основа. */
export function currentProjectionLayer(ndb: NetworkDb): string | null {
  return projectionLayerOf(ndb.layerId);
}

/** Один разобранный комментарий для записи в проекцию. */
interface ProjectionEntry {
  commentId: string;
  /** `layer_id` строки проекции (`null` = основа). */
  layerId: string | null;
  bodyMd: string;
  revision: number;
}

/**
 * Разобрать `body_md` в строки проекции. Ключ строки — `line_no`:
 * нескольких строк парсера с одним номером (таблица с двумя date-ссылками)
 * схлопываются в одну — задача одна, даты и субъекты собираются со всех.
 */
export function buildTaskRows(bodyMd: string): ProjectionRow[] {
  /** Сырые строки парсера по номеру строки (первая — основа строки). */
  const byLine = new Map<number, ProjectionRow>();
  /** Сырые данные парсера для вычисления родителя-задачи. */
  const raw = new Map<number, { hasCheckbox: boolean; parentLineNo: number | null }>();

  for (const line of parseTaskLines(bodyMd)) {
    const lineNo = line.lineNo - 1;
    let row = byLine.get(lineNo);
    if (row === undefined) {
      row = {
        lineNo,
        text: line.text,
        isTask: false,
        done: line.done,
        depth: line.depth,
        parentLineNo: null,
        subtask: false,
        periodFrom: null,
        periodTo: null,
        due: null,
        dates: [],
        subjects: [],
      };
      byLine.set(lineNo, row);
    }
    if (line.hasCheckbox) row.done = row.done || line.done;
    // Маркер мог прийти только с одной из строк одного line_no; сохраняем
    // факт чекбокса и «сырого» родителя для вычисления задачи.
    const prev = raw.get(lineNo);
    raw.set(lineNo, {
      hasCheckbox: (prev?.hasCheckbox ?? false) || line.hasCheckbox,
      parentLineNo: prev?.parentLineNo ?? line.parentLineNo,
    });
    if (line.depth > row.depth) row.depth = line.depth;
    for (const d of line.dates) {
      if (!row.dates.some((x) => x.date === d.date && x.time === d.time)) row.dates.push(d);
    }
    for (const id of line.subjects) {
      if (!row.subjects.includes(id)) row.subjects.push(id);
    }
  }

  /** Итоговое состояние строки: период, срок, задача/подстрока, родитель-задача. */
  const states = new Map<number, { isTask: boolean; parent: number | null }>();
  const stateOf = (lineNo: number): { isTask: boolean; parent: number | null } => {
    const known = states.get(lineNo);
    if (known !== undefined) return known;
    const info = raw.get(lineNo);
    const row = byLine.get(lineNo);
    // Заглушка от циклов (в корректном списке их нет, но защита дешёвая).
    states.set(lineNo, { isTask: false, parent: null });
    if (info === undefined || row === undefined || !info.hasCheckbox) {
      const result = { isTask: false, parent: null };
      states.set(lineNo, result);
      return result;
    }
    // Ближайший вышестоящий пункт с чекбоксом — родитель; задача-родитель —
    // ближайший ИЗ НИХ, который сам является задачей (пункт чек-листа без
    // даты при задаче-родителе — не задача, см. TaskLine).
    let cursor = info.parentLineNo === null ? null : info.parentLineNo - 1;
    let parentTask: number | null = null;
    while (cursor !== null && byLine.has(cursor)) {
      const candidate = stateOf(cursor);
      if (candidate.isTask) {
        parentTask = cursor;
        break;
      }
      const candidateInfo = raw.get(cursor);
      cursor = candidateInfo?.parentLineNo == null ? null : candidateInfo.parentLineNo - 1;
    }
    const undated = row.dates.length === 0;
    const result = { isTask: undated ? parentTask === null : true, parent: parentTask };
    states.set(lineNo, result);
    return result;
  };

  const rows: ProjectionRow[] = [];
  for (const row of byLine.values()) {
    const state = stateOf(row.lineNo);
    row.isTask = state.isTask;
    row.parentLineNo = state.parent;
    row.subtask = state.isTask === false && state.parent !== null;
    const first = row.dates[0];
    const last = row.dates[row.dates.length - 1];
    row.periodFrom = first?.date ?? null;
    row.periodTo = last?.date ?? null;
    row.due = last?.date ?? null;
    if (row.subtask) row.isTask = false;
    rows.push(row);
  }
  rows.sort((a, b) => a.lineNo - b.lineNo);
  return rows;
}

/** Удалить строки проекции комментария в конкретном слое (`null` — основа). */
export function deleteProjectionRows(
  ndb: NetworkDb,
  commentId: string,
  layerId: string | null,
): void {
  for (const table of ['task_rows', 'task_row_dates', 'task_row_subjects']) {
    ndb
      .prepare(
        `DELETE FROM ${table} WHERE comment_id = ? AND COALESCE(layer_id, '') = COALESCE(?, '')`,
      )
      .run(commentId, layerId);
  }
}

/** Удалить все строки проекции слоя (слияние/отказ: данные слоя уезжают). */
export function dropTaskProjectionLayer(ndb: NetworkDb, layerId: string): void {
  for (const table of ['task_rows', 'task_row_dates', 'task_row_subjects']) {
    ndb.prepare(`DELETE FROM ${table} WHERE layer_id = ?`).run(layerId);
  }
}

/**
 * Удалить строки проекции навсегда исчезнувших комментариев (физическая
 * вычистка корзины): строки всех слоёв, без разбора текста.
 */
export function deleteTaskProjectionOfComments(
  ndb: NetworkDb,
  commentIds: readonly string[],
): void {
  for (let i = 0; i < commentIds.length; i += 500) {
    const chunk = commentIds.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(', ');
    for (const table of ['task_rows', 'task_row_dates', 'task_row_subjects']) {
      ndb.prepare(`DELETE FROM ${table} WHERE comment_id IN (${placeholders})`).run(...chunk);
    }
  }
}

/**
 * Пере-создать строки проекции для набора комментариев: удалить прежние строки
 * этого слоя и вставить свежие. Вызывающий обязан открыть транзакцию.
 */
function replaceProjectionBatch(ndb: NetworkDb, entries: readonly ProjectionEntry[]): void {
  const insertRow = ndb.prepare(
    `INSERT INTO task_rows (comment_id, layer_id, line_no, is_task, text, period_from, period_to,
                            due, done, depth, parent_line_no, subtask, parsed_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertDate = ndb.prepare(
    'INSERT INTO task_row_dates (comment_id, layer_id, line_no, date, time) VALUES (?, ?, ?, ?, ?)',
  );
  const insertSubject = ndb.prepare(
    'INSERT INTO task_row_subjects (comment_id, layer_id, line_no, thought_id) VALUES (?, ?, ?, ?)',
  );

  for (const entry of entries) {
    deleteProjectionRows(ndb, entry.commentId, entry.layerId);
    for (const row of buildTaskRows(entry.bodyMd)) {
      insertRow.run(
        entry.commentId,
        entry.layerId,
        row.lineNo,
        row.isTask ? 1 : 0,
        row.text,
        row.periodFrom,
        row.periodTo,
        row.due,
        row.done ? 1 : 0,
        row.depth,
        row.parentLineNo,
        row.subtask ? 1 : 0,
        entry.revision,
      );
      for (const d of row.dates) {
        insertDate.run(entry.commentId, entry.layerId, row.lineNo, d.date, d.time);
      }
      for (const id of row.subjects) {
        insertSubject.run(entry.commentId, entry.layerId, row.lineNo, id);
      }
    }
  }
}

/**
 * Пере-парсить комментарий так, как его видит ТЕКУЩИЙ контекст слоя. Если
 * комментарий в контексте не виден (удалён надгробием) — строки текущего слоя
 * убираются: проекция не хранит невидимое.
 */
export function reparseVisibleComment(ndb: NetworkDb, commentId: string): ProjectionEntry | null {
  const contextLayer = currentProjectionLayer(ndb);
  const row = ndb
    .prepare('SELECT id, layer_id, body_md, version FROM comments_v WHERE id = ? LIMIT 1')
    .get(commentId) as
    { id: string; layer_id: string; body_md: string; version: number } | undefined;
  if (row === undefined) {
    deleteProjectionRows(ndb, commentId, contextLayer);
    return null;
  }
  const entry: ProjectionEntry = {
    commentId,
    layerId: projectionLayerOf(row.layer_id),
    bodyMd: row.body_md,
    revision: row.version,
  };
  // Строки текущего слоя могли остаться от прежней редакции (правка, надгробие
  // удаления, слияние слоя): победитель цепочки теперь в другом слое.
  if (entry.layerId !== contextLayer) deleteProjectionRows(ndb, commentId, contextLayer);
  replaceProjectionBatch(ndb, [entry]);
  return entry;
}

/**
 * Пере-парсить физическую строку комментария конкретного слоя (`null` —
 * основа) — путь слияния слоёв и свипа: контекст соединения здесь не при чём.
 */
export function reparseCommentAtLayer(
  ndb: NetworkDb,
  commentId: string,
  layerId: string | null,
): void {
  const row = ndb
    .prepare(
      `SELECT id, body_md, version FROM comments -- layers:physical-read
       WHERE id = ? AND layer_id IS ? AND deleted = 0`,
    )
    .get(commentId, layerId ?? BASE_LAYER_ID) as
    { id: string; body_md: string; version: number } | undefined;
  if (row === undefined) {
    deleteProjectionRows(ndb, commentId, layerId);
    return;
  }
  replaceProjectionBatch(ndb, [{ commentId, layerId, bodyMd: row.body_md, revision: row.version }]);
}

// ---------------------------------------------------------------------------
// Очередь пере-парса (хук записи комментария)
// ---------------------------------------------------------------------------

interface PendingProjection {
  comments: Set<string>;
  /** Слои, чьи строки удалить (слияние/отказ от изменений). */
  layers: Set<string>;
  /** Полный пере-парс сети (страховка/свип). */
  rebuild: boolean;
}

const pending = new WeakMap<NetworkDb, PendingProjection>();

function queueOf(ndb: NetworkDb): PendingProjection {
  let entry = pending.get(ndb);
  if (entry === undefined) {
    entry = { comments: new Set(), layers: new Set(), rebuild: false };
    pending.set(ndb, entry);
  }
  return entry;
}

/** Поставить комментарий в очередь пере-парса (внутри транзакции записи). */
export function queueTaskReparse(ndb: NetworkDb, commentId: string): void {
  queueOf(ndb).comments.add(commentId);
}

/** Поставить слой в очередь удаления его строк проекции (слияние/отказ). */
export function queueTaskLayerDrop(ndb: NetworkDb, layerId: string): void {
  queueOf(ndb).layers.add(layerId);
}

/** Запросить полный пере-парс сети при следующем коммите. */
export function queueTaskProjectionRebuild(ndb: NetworkDb): void {
  queueOf(ndb).rebuild = true;
}

/** Выбросить очередь: транзакция записи откатилась, пере-парс не нужен. */
export function discardTaskProjectionQueue(ndb: NetworkDb): void {
  pending.delete(ndb);
}

/** Есть ли отложенная работа (для тестов и диагностики). */
export function hasPendingTaskProjection(ndb: NetworkDb): boolean {
  const entry = pending.get(ndb);
  return entry !== undefined && (entry.comments.size > 0 || entry.layers.size > 0 || entry.rebuild);
}

/**
 * Применить отложенный пере-парс: удалить строки уехавших слоёв, пере-парсить
 * затронутые комментарии (или всю сеть) и сдвинуть маркер актуальности.
 * Вызывается ПОСЛЕ коммита записи. Ошибки разбора не пробрасываются: запись
 * уже применена, а актуальность страхует маркер.
 */
export function flushTaskProjection(ndb: NetworkDb): void {
  const entry = pending.get(ndb);
  if (entry === undefined) return;
  pending.delete(ndb);
  if (entry.comments.size === 0 && entry.layers.size === 0 && !entry.rebuild) return;
  try {
    ndb.transaction(() => {
      for (const layerId of entry.layers) dropTaskProjectionLayer(ndb, layerId);
      if (entry.rebuild) {
        rebuildTaskProjectionRows(ndb);
      } else {
        for (const commentId of entry.comments) reparseVisibleComment(ndb, commentId);
      }
      refreshTaskProjectionMarker(ndb);
    });
  } catch {
    // Пропущенный пере-парс не отменяет запись; проекцию догонит свип/«Обновить».
  }
}

// ---------------------------------------------------------------------------
// Полный пере-парс сети и маркер актуальности
// ---------------------------------------------------------------------------

/** Пере-создать проекцию ВСЕЙ сети по физическим строкам комментариев. */
function rebuildTaskProjectionRows(ndb: NetworkDb): void {
  const rows = ndb
    .prepare(
      `SELECT id, layer_id, body_md, version FROM comments -- layers:physical-read
       WHERE deleted = 0`,
    )
    .all() as Array<{ id: string; layer_id: string; body_md: string; version: number }>;
  for (const table of ['task_rows', 'task_row_dates', 'task_row_subjects']) {
    ndb.prepare(`DELETE FROM ${table}`).run();
  }
  replaceProjectionBatch(
    ndb,
    rows.map((row) => ({
      commentId: row.id,
      layerId: projectionLayerOf(row.layer_id),
      bodyMd: row.body_md,
      revision: row.version,
    })),
  );
}

/**
 * Полный пере-парс проекции сети (свип, регламент «Обновить»): единственный
 * законный способ перестроить таблицы целиком.
 */
export function rebuildTaskProjection(ndb: NetworkDb): number {
  let parsed = 0;
  ndb.transaction(() => {
    parsed = (
      ndb
        .prepare(
          `SELECT COUNT(*) AS c FROM comments WHERE deleted = 0 AND body_md LIKE '%[[%' -- layers:physical-read`,
        )
        .get() as { c: number }
    ).c;
    rebuildTaskProjectionRows(ndb);
    refreshTaskProjectionMarker(ndb);
  });
  return parsed;
}

/** Глобальный маркер актуальности проекции (максимум ревизии комментариев). */
export function readTaskProjectionMarker(ndb: NetworkDb): number {
  const row = ndb.prepare('SELECT max_revision FROM task_projection_state WHERE id = 1').get() as
    { max_revision: number } | undefined;
  return row?.max_revision ?? 0;
}

/** Сдвинуть маркер вперёд до максимума ревизий комментариев сети. */
export function refreshTaskProjectionMarker(ndb: NetworkDb): number {
  ndb
    .prepare(
      `UPDATE task_projection_state
         SET max_revision = MAX(max_revision,
           (SELECT COALESCE(MAX(version), 0) FROM comments)) -- layers:physical-read
       WHERE id = 1`,
    )
    .run();
  return readTaskProjectionMarker(ndb);
}

// ---------------------------------------------------------------------------
// Свип при старте сервера (старые сети: проекции ещё нет)
// ---------------------------------------------------------------------------

/**
 * Разово достроить проекцию во всех сетях, созданных до 0.16.1 (как свип
 * `body_html`): строк в таблицах нет, а задачи у пользователя уже написаны.
 * Признак «сеть не разобрана» — маркер 0. Сеть, где разбор упал, остаётся
 * неразмеченной и повторится при следующем старте.
 */
export function sweepTaskProjection(dataDir: string, systemDb: SystemDb, log: Logger): void {
  if (systemDb.getSetting(TASK_PROJECTION_SETTING) === TASK_PROJECTION_VERSION) return;
  let parsed = 0;
  for (const networkId of systemDb.listAllNetworkIds()) {
    try {
      const ndb = openNetworkDb(dataDir, networkId, log);
      if (readTaskProjectionMarker(ndb) > 0) continue;
      parsed += rebuildTaskProjection(ndb);
    } catch (err) {
      log.warn({ err, networkId }, 'task projection sweep: network skipped');
    }
  }
  systemDb.setSetting(TASK_PROJECTION_SETTING, TASK_PROJECTION_VERSION);
  log.info({ parsed, version: TASK_PROJECTION_VERSION }, 'task projection sweep complete');
}
