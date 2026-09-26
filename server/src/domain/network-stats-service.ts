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
 * Разбивка мыслей/связей: `total` — все живые строки; `active`/`inactive` — не
 * в корзине с `active = 1`/`0`; `trashed` — `marked_for_deletion = 1`.
 * У онтологии (типы, свойства) и слоёв разбивок нет — только «всего».
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

import type { NetworkStats, StatsAttachments, StatsBreakdown } from '@etn/shared';

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
    layers: count(ndb, 'SELECT COUNT(*) AS c FROM layers WHERE is_service = 0'),
    attachments: attachmentStats(ndb),
  };
}
