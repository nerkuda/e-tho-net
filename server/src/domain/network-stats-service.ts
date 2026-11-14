/**
 * Статистика мыслесети (задача c69b078d, версия 0.9.1; 03-server-api.md —
 * `GET /networks/{nid}/statistics`).
 *
 * Агрегат по ВСЕЙ сети: числа суммируются по всем слоям. Слои — область данных
 * (copy-on-write ветки, docs/13-layers.md §3), поэтому отбор по сессионному
 * слою здесь НЕ применяется, и запросы читают физические ветвимые таблицы
 * (не `*_v`) с явной пометкой `layers:physical-read` — иначе линт-сторож
 * `layers-s3` справедливо счёл бы это утечкой контекста слоя. Плата за это —
 * теневая копия сущности в слое считается отдельной строкой: статистика
 * показывает объём хранения по всем ветвям, а не число видимых сущностей.
 *
 * Надгробия (`deleted = 1`) не считаются нигде: это скрытые физические строки.
 * Разбивка мыслей/связей/публикаций: `total` — все живые строки; `active`/
 * `inactive` — не в корзине с `active = 1`/`0`; `trashed` —
 * `marked_for_deletion = 1`. У онтологии (типы, свойства), полок и слоёв
 * разбивок нет — только «всего».
 *
 * Слои считаются как в `listLayers` (13-layers.md §10.1): сервисные
 * (резервные, `is_service = 1`) скрыты по умолчанию и не учитываются, основа
 * входит в счёт. Свойства — реестр без системных структурных
 * («Родители»/«Потомки»), как `countVisibleProperties` в клиентском меню
 * «Свойства мыслей (N)».
 *
 * Пометка `layers:physical-read` стоит ЛИТЕРАЛОМ в одной исходной строке с
 * `FROM <таблица>` (не через константу): сторож физического чтения ищет её
 * подстрокой в строке, и `${CONST}` он бы не увидел — правило без сторожа не
 * действует.
 */

import {
  BASE_LAYER_ID,
  type NetworkStats,
  type StatsAttachments,
  type StatsBreakdown,
  type StatsTasks,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/** Скалярный `COUNT(*)`: строка `{ c }` или 0, если запрос ничего не вернул. */
function count(ndb: NetworkDb, sql: string): number {
  const row = ndb.prepare(sql).get() as { c: number } | undefined;
  return row?.c ?? 0;
}

/** Разбивка сущности по четырём уже собранным SQL-запросам. */
function breakdown(
  ndb: NetworkDb,
  queries: { total: string; active: string; inactive: string; trashed: string },
): StatsBreakdown {
  return {
    total: count(ndb, queries.total),
    active: count(ndb, queries.active),
    inactive: count(ndb, queries.inactive),
    trashed: count(ndb, queries.trashed),
  };
}

/** Вложения: всего, файловых и суммарный размер файловых (байты). */
function attachmentStats(ndb: NetworkDb): StatsAttachments {
  const total = count(
    ndb,
    `SELECT COUNT(*) AS c FROM attachments -- layers:physical-read
     WHERE deleted = 0`,
  );
  const files = ndb
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(file_size), 0) AS bytes FROM attachments -- layers:physical-read
       WHERE deleted = 0 AND kind = 'file'`,
    )
    .get() as { c: number; bytes: number } | undefined;
  return {
    total,
    files: files?.c ?? 0,
    file_size_bytes: files?.bytes ?? 0,
  };
}

/**
 * Задачи: счётчики материализованной проекции (0.16.1). Строки считаются по
 * всем слоям (объём), а состояние субъектов оценивается по видимым редакциям
 * основы (`*_v`): владелец комментария + мысли из ID-ссылок строки.
 */
function taskStats(ndb: NetworkDb): StatsTasks {
  const inactive = `(
    (c.owner_type = 'thought' AND EXISTS (
       SELECT 1 FROM thoughts_v t WHERE t.id = c.owner_id
        AND (t.active = 0 OR t.marked_for_deletion = 1)))
    OR (c.owner_type = 'link' AND EXISTS (
       SELECT 1 FROM links_v l WHERE l.id = c.owner_id
        AND (l.active = 0 OR l.marked_for_deletion = 1)))
    OR (c.owner_type = 'publication' AND EXISTS (
       SELECT 1 FROM publications_v p WHERE p.id = c.owner_id
        AND (p.active = 0 OR p.marked_for_deletion = 1)))
    OR EXISTS (
       SELECT 1 FROM task_row_subjects s
         JOIN thoughts_v st ON st.id = s.thought_id
        WHERE s.comment_id = tr.comment_id
          AND COALESCE(s.layer_id, '') = COALESCE(tr.layer_id, '')
          AND s.line_no = tr.line_no
          AND (st.active = 0 OR st.marked_for_deletion = 1))
  )`;
  const row = ndb
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(tr.done = 0), 0) AS open,
              COALESCE(SUM(tr.done = 1), 0) AS done,
              COALESCE(SUM(CASE WHEN ${inactive} THEN 0 ELSE 1 END), 0) AS subjects_active,
              COALESCE(SUM(CASE WHEN ${inactive} THEN 1 ELSE 0 END), 0) AS subjects_inactive
         FROM task_rows tr -- layers:physical-read
         JOIN comments c -- layers:physical-read
              ON c.id = tr.comment_id
             AND c.layer_id IS COALESCE(tr.layer_id, ?)
        WHERE tr.is_task = 1`,
    )
    .get(BASE_LAYER_ID) as
    | {
        total: number;
        open: number;
        done: number;
        subjects_active: number;
        subjects_inactive: number;
      }
    | undefined;
  return {
    total: row?.total ?? 0,
    open: row?.open ?? 0,
    done: row?.done ?? 0,
    subjects_active: row?.subjects_active ?? 0,
    subjects_inactive: row?.subjects_inactive ?? 0,
  };
}

/**
 * Собирает статистику мыслесети по соединению сети. Контекст слоя соединения
 * роли не играет: все запросы читают физические таблицы и потому видят строки
 * каждого слоя (сумма по слоям).
 */
export function networkStatistics(ndb: NetworkDb): NetworkStats {
  return {
    thought_types: count(
      ndb,
      `SELECT COUNT(*) AS c FROM thought_types -- layers:physical-read
       WHERE deleted = 0`,
    ),
    link_types: count(
      ndb,
      `SELECT COUNT(*) AS c FROM link_types -- layers:physical-read
       WHERE deleted = 0`,
    ),
    // Структурные свойства («Родители»/«Потомки») исключены — так же считает
    // меню «Свойства мыслей (N)» (`countVisibleProperties` на клиенте).
    properties: count(
      ndb,
      `SELECT COUNT(*) AS c FROM properties -- layers:physical-read
       WHERE deleted = 0 AND COALESCE(json_extract(config, '$.structural'), 0) <> 1`,
    ),
    thoughts: breakdown(ndb, {
      total: `SELECT COUNT(*) AS c FROM thoughts -- layers:physical-read
              WHERE deleted = 0`,
      active: `SELECT COUNT(*) AS c FROM thoughts -- layers:physical-read
               WHERE deleted = 0 AND marked_for_deletion = 0 AND active = 1`,
      inactive: `SELECT COUNT(*) AS c FROM thoughts -- layers:physical-read
                 WHERE deleted = 0 AND marked_for_deletion = 0 AND active = 0`,
      trashed: `SELECT COUNT(*) AS c FROM thoughts -- layers:physical-read
                WHERE deleted = 0 AND marked_for_deletion = 1`,
    }),
    links: breakdown(ndb, {
      total: `SELECT COUNT(*) AS c FROM links -- layers:physical-read
              WHERE deleted = 0`,
      active: `SELECT COUNT(*) AS c FROM links -- layers:physical-read
               WHERE deleted = 0 AND marked_for_deletion = 0 AND active = 1`,
      inactive: `SELECT COUNT(*) AS c FROM links -- layers:physical-read
                 WHERE deleted = 0 AND marked_for_deletion = 0 AND active = 0`,
      trashed: `SELECT COUNT(*) AS c FROM links -- layers:physical-read
                WHERE deleted = 0 AND marked_for_deletion = 1`,
    }),
    publications: breakdown(ndb, {
      total: `SELECT COUNT(*) AS c FROM publications -- layers:physical-read
              WHERE deleted = 0`,
      active: `SELECT COUNT(*) AS c FROM publications -- layers:physical-read
               WHERE deleted = 0 AND marked_for_deletion = 0 AND active = 1`,
      inactive: `SELECT COUNT(*) AS c FROM publications -- layers:physical-read
                 WHERE deleted = 0 AND marked_for_deletion = 0 AND active = 0`,
      trashed: `SELECT COUNT(*) AS c FROM publications -- layers:physical-read
                WHERE deleted = 0 AND marked_for_deletion = 1`,
    }),
    shelves: count(
      ndb,
      `SELECT COUNT(*) AS c FROM shelves -- layers:physical-read
       WHERE deleted = 0`,
    ),
    layers: count(ndb, 'SELECT COUNT(*) AS c FROM layers WHERE is_service = 0'),
    attachments: attachmentStats(ndb),
    tasks: taskStats(ndb),
    reminders: count(ndb, "SELECT COUNT(*) AS c FROM reminders WHERE state = 'active'"),
  };
}
