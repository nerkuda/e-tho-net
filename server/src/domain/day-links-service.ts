/**
 * «Связи дня» — чтение блока дня ленты «Дневника» (0.16.1, задача «0.16.1:
 * связи дня и открытые дела»; требование `1fb1047d`, элемент интерфейса
 * `8ecc30cd`, ADR `d0c07f33`).
 *
 * Два источника, оба — индексные чтения:
 *   1. **датовые факты** — значения-даты свойств мыслей (`property_values_v` +
 *      справочник `properties_v`), календарный день — первые 10 символов
 *      значения (дата-свойство хранит `YYYY-MM-DD`; ISO-инстанс отсекается по
 *      своей календарной части);
 *   2. **date-ссылки** — `task_row_dates` материализованной проекции задач
 *      (INDEX(date), парсинг на лету не выполняется). Берутся строки ВСЕХ
 *      комментариев — хроно-записей и постоянных, — КРОМЕ строк-задач
 *      (`task_rows.is_task = 1`): их даты показывает панель «Задачи», дублировать
 *      их в блоке запрещено.
 *
 * Видимость строки — по видимости её комментария: `comments_v` отдаёт
 * победителя цепочки слоя, строка видима, когда её `layer_id` совпадает со слоем
 * победителя (`NULL` — основа). Правило видимости — общее с GET /tasks и
 * маркерами календаря (`task-visibility.ts`): постоянные комментарии помеченных
 * мысли/связи/публикации исключаются всегда, а при выключенной настройке
 * «показывать содержимое корзины» — и остальные записи помеченных владельцев
 * (пачка 11, задача 173e8368).
 *
 * Сутки наблюдателя сервер не считает (требование `fcdcd75f`): `from`/`to` —
 * календарные дни клиента `YYYY-MM-DD`, интервалы записей-источников отдаются
 * как UTC-инстансы — попадает ли запись в этот день, решает клиент.
 */

import {
  BASE_LAYER_ID,
  EtnError,
  type DayFact,
  type DayLink,
  type DayLinksResult,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { taskRowVisibilitySql } from './task-visibility.js';

/** Параметры выборки «связей дня». */
export interface DayLinksOptions {
  /** Первый день диапазона (`YYYY-MM-DD`). */
  from: string;
  /** Последний день диапазона (`YYYY-MM-DD`); не задан — равен `from`. */
  to?: string;
  /**
   * Показывать содержимое корзины (per-user `show_trash`, по умолчанию `true`):
   * при `false` date-ссылки помеченных на удаление владельцев не отдаются
   * (пачка 11, задача 173e8368).
   */
  showTrash?: boolean;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Проверить календарный день входа: иначе 400 (сервер не угадывает сутки). */
function day(value: string | undefined, field: string): string {
  if (value === undefined || value === '') {
    throw new EtnError('VALIDATION_ERROR', `${field} is required (YYYY-MM-DD).`, { field });
  }
  if (!DAY_RE.test(value)) {
    throw new EtnError('VALIDATION_ERROR', `${field} must be a calendar day (YYYY-MM-DD).`, {
      field,
    });
  }
  return value;
}

/** Строка выборки фактов до сборки DTO. */
interface FactRow {
  day: string;
  thought_id: string;
  title: string;
  property_id: string;
  property_name: string;
  value: string;
}

/**
 * Датовые факты диапазона: значения-даты свойств живых мыслей.
 *
 * Одна мысль может нести несколько датовых свойств одного дня — это разные
 * факты (разные подписи свойства), поэтому дедупликация идёт по паре
 * «мысль + свойство + день».
 */
function readFacts(ndb: NetworkDb, from: string, to: string): DayFact[] {
  const rows = ndb
    .prepare(
      `SELECT substr(pv.value_date, 1, 10) AS day,
              pv.owner_id AS thought_id,
              t.title AS title,
              pv.property_id AS property_id,
              p.name AS property_name,
              pv.value_date AS value
         FROM property_values_v pv
         JOIN properties_v p ON p.id = pv.property_id
         JOIN thoughts_v t ON t.id = pv.owner_id
        WHERE pv.owner_type = 'thought'
          AND p.value_type = 'date'
          AND pv.value_date IS NOT NULL
          AND pv.value_date <> ''
          AND substr(pv.value_date, 1, 10) BETWEEN ? AND ?
          AND t.marked_for_deletion = 0
        ORDER BY t.title, p.name, pv.property_id`,
    )
    .all(from, to) as FactRow[];
  const seen = new Set<string>();
  const facts: DayFact[] = [];
  for (const row of rows) {
    const key = `${row.thought_id}\u0000${row.property_id}\u0000${row.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      day: row.day,
      thought_id: row.thought_id,
      title: row.title,
      property_id: row.property_id,
      property_name: row.property_name,
      value: row.value,
    });
  }
  return facts;
}

/** Строка выборки date-ссылок до сборки DTO. */
interface LinkRow {
  day: string;
  time: string | null;
  comment_id: string;
  layer_id: string | null;
  line_no: number;
  text: string;
  kind: string;
  owner_type: string;
  owner_id: string;
  owner_title: string | null;
  valid_from: string;
  valid_to: string | null;
  title: string | null;
}

/**
 * Date-ссылки диапазона из проекции: строки хроно-записей и постоянных
 * комментариев, кроме строк-задач.
 *
 * Подпись владельца (облачко источника): название мысли/публикации; у связи —
 * «источник — назначение» (у ребра нет собственного названия). Неразрешимый
 * владелец деградирует до его id — блок не теряет строку.
 */
function readLinks(ndb: NetworkDb, from: string, to: string, showTrash: boolean): DayLink[] {
  const rows = ndb
    .prepare(
      `SELECT d.date AS day,
              d.time AS time,
              tr.comment_id AS comment_id,
              tr.layer_id AS layer_id,
              tr.line_no AS line_no,
              tr.text AS text,
              c.kind AS kind,
              c.owner_type AS owner_type,
              c.owner_id AS owner_id,
              COALESCE(
                CASE WHEN c.owner_type = 'thought' THEN owner_t.title END,
                CASE WHEN c.owner_type = 'publication' THEN owner_p.title END,
                CASE WHEN c.owner_type = 'link' THEN src_t.title || ' — ' || dst_t.title END,
                c.owner_id
              ) AS owner_title,
              c.valid_from AS valid_from,
              c.valid_to AS valid_to,
              c.title AS title
         FROM task_row_dates d
         JOIN task_rows tr
           ON tr.comment_id = d.comment_id
          AND tr.line_no = d.line_no
          AND COALESCE(tr.layer_id, '') = COALESCE(d.layer_id, '')
         JOIN comments_v c
           ON c.id = tr.comment_id
          AND ((tr.layer_id IS NULL AND c.layer_id = ?) OR tr.layer_id = c.layer_id)
    LEFT JOIN thoughts_v owner_t ON c.owner_type = 'thought' AND owner_t.id = c.owner_id
    LEFT JOIN publications_v owner_p
           ON c.owner_type = 'publication' AND owner_p.id = c.owner_id
    LEFT JOIN links_v lv ON c.owner_type = 'link' AND lv.id = c.owner_id
    LEFT JOIN thoughts_v src_t ON src_t.id = lv.source_id
    LEFT JOIN thoughts_v dst_t ON dst_t.id = lv.target_id
        WHERE d.date BETWEEN ? AND ?
          AND tr.is_task = 0
          AND ${taskRowVisibilitySql('tr', 'c', showTrash)}
        ORDER BY d.date, COALESCE(d.time, '99:99'), c.valid_from, tr.comment_id, tr.line_no`,
    )
    .all(BASE_LAYER_ID, from, to) as LinkRow[];

  const seen = new Map<string, number>();
  const links: DayLink[] = [];
  for (const row of rows) {
    // Одна строка источника — одна ссылка на день: несколько date-ссылок
    // строки на тот же день (с временем и без) схлопываются в одну. Порядок
    // задан ORDER BY (время по возрастанию, без времени — в конце), поэтому
    // побеждает САМАЯ РАННЯЯ по времени ссылка; у уже добавленной строки без
    // времени более точное время подхватывается.
    const key = `${row.comment_id}\u0000${row.layer_id ?? ''}\u0000${row.line_no}\u0000${row.day}`;
    const existing = seen.get(key);
    if (existing !== undefined) {
      const link = links[existing]!;
      if (link.time === null && row.time !== null) link.time = row.time;
      continue;
    }
    seen.set(key, links.length);
    links.push({
      day: row.day,
      time: row.time,
      source: {
        comment_id: row.comment_id,
        line_no: row.line_no,
        text: row.text,
        kind: row.kind as DayLink['source']['kind'],
        owner_type: row.owner_type as DayLink['source']['owner_type'],
        owner_id: row.owner_id,
        owner_title: row.owner_title ?? row.owner_id,
        source_from: row.kind === 'chronological' ? row.valid_from : null,
        source_to: row.kind === 'chronological' ? row.valid_to : null,
        source_title: row.kind === 'chronological' ? row.title : null,
      },
    });
  }
  return links;
}

/**
 * Выборка «связей дня» за диапазон календарных дней. Чтение синхронное:
 * запросы индексные и точечные (INDEX(date), INDEX справочника), как у
 * хронико-запроса; в reader-пул не уходит.
 */
export function listDayLinks(ndb: NetworkDb, options: DayLinksOptions): DayLinksResult {
  const from = day(options.from, 'from');
  const to = day(options.to ?? options.from, 'to');
  const [start, end] = from <= to ? [from, to] : [to, from];
  return {
    facts: readFacts(ndb, start, end),
    links: readLinks(ndb, start, end, options.showTrash !== false),
  };
}
