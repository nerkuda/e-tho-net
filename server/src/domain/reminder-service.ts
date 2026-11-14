/**
 * Домен напоминаний (0.16.1, задача b47f1fd2; сущность 62e6787b, ADR 03e429ed,
 * операции ae19b1bf / 500d1b3d).
 *
 * `reminders` — сервисная per-user таблица network-БД, НЕ ветвится по слоям:
 * читается в любом контексте слоя (никакого `layer_id` в таблице). Владелец
 * видит и правит только свои напоминания; чужое напоминание — 403.
 *
 * Серия вхождений и `next_at` считаются движком повторов
 * (`domain/reminder-repeat.ts`); здесь — CRUD, карта исключений и видимость
 * субъекта:
 *   * субъект помечен на удаление или недоступен в текущем контексте слоя —
 *     напоминание не отдаётся и не срабатывает, но НЕ удаляется автоматически
 *     (чистка — ручная, сущность 62e6787b);
 *   * неактуальный субъект — по настройке сети `show_inactive` (серым при
 *     включённой, скрыто при выключенной; решение 2026-11-12).
 *
 * `next_at` продвигается ЛЕНИВО: значение всегда пересчитывается от `anchor_at`
 * при чтении карточки и при каждой записи; в БД обновляется на записях (GET
 * ничего не пишет — классификация обслуживания `guard-maintenance-parity`).
 */

import { randomUUID } from 'node:crypto';

import {
  EtnError,
  REMINDER_DEFAULT_HORIZON_DAYS,
  REMINDER_MAX_HORIZON_DAYS,
  type Reminder,
  type ReminderException,
  type ReminderKind,
  type ReminderListResult,
  type ReminderOccurrence,
  type ReminderSchedule,
  type ReminderState,
  type ReminderSubjectState,
  type ReminderSubjectType,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import {
  MS_PER_DAY,
  assertScheduleKind,
  computeNextAt,
  expandOccurrences,
  firstOccurrenceOnOrAfter,
  kindOfSchedule,
  nextCandidate,
  normalizeAnchor,
  parseInstant,
  validateSchedule,
  type ExceptionMap,
} from './reminder-repeat.js';

/** Сырая строка `reminders`. */
interface ReminderRow {
  id: string;
  user_id: string;
  subject_type: ReminderSubjectType;
  subject_id: string;
  kind: ReminderKind;
  schedule: string;
  anchor_at: string;
  next_at: string | null;
  exceptions: string;
  state: ReminderState;
  created_at: string;
  updated_at: string;
}

/** Видимость субъекта в контексте слоя соединения. */
type SubjectVisibility = ReminderSubjectState | 'unavailable';

/** Вход создания напоминания (REST `POST /reminders`, MCP `reminders.create`). */
export interface ReminderCreateInput {
  subject_type: ReminderSubjectType;
  subject_id: string;
  kind: ReminderKind;
  schedule: unknown;
  anchor_at: string;
}

/** Вход правки расписания (REST `PATCH /reminders/{id}`, MCP `reminders.update`). */
export interface ReminderUpdateInput {
  kind?: ReminderKind;
  schedule?: unknown;
  anchor_at?: string;
}

/** Отбор списка напоминаний (REST `GET /reminders`, MCP `reminders.list`). */
export interface ReminderListOptions {
  /** Начало раскрытия повторов; отсутствует — раскрытия нет. */
  from?: string;
  /** Конец раскрытия; по умолчанию `from + horizon_days`. */
  to?: string;
  /** Потолок дальности раскрытия в днях (1 год по умолчанию). */
  horizon_days?: number;
  subject_type?: ReminderSubjectType;
  subject_id?: string;
  /** Настройка сети «Показывать неактуальные мысли и связи» владельца. */
  show_inactive: boolean;
  /** Часы исполнения (для тестов и ленивого продвижения `next_at`). */
  nowMs?: number;
}

/** Итог управления вхождением: карточка после записи и обработанный момент. */
export interface ReminderOccurrenceChange {
  reminder: Reminder;
  /** Момент вхождения, к которому применилось действие (snooze/dismiss). */
  occurrence_at: string;
}

/** Ошибка «напоминания нет» / «субъект недоступен» — 404. */
function notFound(id: string): never {
  throw new EtnError('NOT_FOUND', `reminder ${id} not found`, { entity: 'reminder', id });
}

/** Ошибка грамматики/состояния входа — 400 (домен, не zod). */
function badRequest(message: string, field: string): never {
  throw new EtnError('VALIDATION_ERROR', message, { status: 400, field });
}

/** Строка чужого владельца — 403 (операция ae19b1bf). */
function forbidden(id: string): never {
  throw new EtnError('FORBIDDEN', `reminder ${id} belongs to another user`, {
    entity: 'reminder',
    id,
  });
}

/** Разобрать JSON расписания из строки; битые данные — INTERNAL. */
function parseStoredSchedule(row: ReminderRow): ReminderSchedule {
  try {
    return validateSchedule(JSON.parse(row.schedule) as unknown);
  } catch (err) {
    if (err instanceof EtnError && err.code === 'VALIDATION_ERROR') {
      throw new EtnError('INTERNAL', `reminder ${row.id} has an invalid stored schedule.`, {
        entity: 'reminder',
        id: row.id,
      });
    }
    throw err;
  }
}

/** Разобрать карту исключений; битые данные — INTERNAL. */
function parseStoredExceptions(row: ReminderRow): Record<string, ReminderException> {
  let raw: unknown;
  try {
    raw = JSON.parse(row.exceptions) as unknown;
  } catch {
    throw new EtnError('INTERNAL', `reminder ${row.id} has corrupted exceptions.`, {
      entity: 'reminder',
      id: row.id,
    });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EtnError('INTERNAL', `reminder ${row.id} has corrupted exceptions.`, {
      entity: 'reminder',
      id: row.id,
    });
  }
  const out: Record<string, ReminderException> = {};
  for (const [moment, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw new EtnError('INTERNAL', `reminder ${row.id} has corrupted exceptions.`, {
        entity: 'reminder',
        id: row.id,
      });
    }
    const entry = value as { kind?: unknown; until?: unknown };
    if (entry.kind === 'dismiss') {
      out[moment] = { kind: 'dismiss' };
    } else if (entry.kind === 'snooze' && typeof entry.until === 'string') {
      out[moment] = { kind: 'snooze', until: entry.until };
    } else {
      throw new EtnError('INTERNAL', `reminder ${row.id} has corrupted exceptions.`, {
        entity: 'reminder',
        id: row.id,
      });
    }
  }
  return out;
}

/** Карта исключений по UTC-миллисекундам момента вхождения. */
function exceptionMap(exceptions: Record<string, ReminderException>): ExceptionMap {
  const map = new Map<number, ReminderException>();
  for (const [moment, exception] of Object.entries(exceptions)) {
    const ms = Date.parse(moment);
    if (Number.isFinite(ms)) map.set(ms, exception);
  }
  return map;
}

/**
 * Строки субъектов в контексте слоя соединения: `thoughts_v`/`publications_v`
 * (ветвимые таблицы — только через представления, сторож `layers-s3`).
 */
function subjectRows(
  ndb: NetworkDb,
  subjectType: ReminderSubjectType,
  ids: readonly string[],
): Map<string, { active: number; marked: number }> {
  if (ids.length === 0) return new Map();
  const table = subjectType === 'thought' ? 'thoughts_v' : 'publications_v';
  const placeholders = ids.map(() => '?').join(', ');
  const rows = ndb
    .prepare(`SELECT id, active, marked_for_deletion FROM ${table} WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; active: number; marked_for_deletion: number }>;
  return new Map(
    rows.map((row) => [row.id, { active: row.active, marked: row.marked_for_deletion }]),
  );
}

/** Видимость набора субъектов одного вида. */
function subjectVisibility(
  ndb: NetworkDb,
  subjectType: ReminderSubjectType,
  ids: readonly string[],
): Map<string, SubjectVisibility> {
  const rows = subjectRows(ndb, subjectType, ids);
  const out = new Map<string, SubjectVisibility>();
  for (const id of ids) {
    const row = rows.get(id);
    if (row === undefined || row.marked !== 0) {
      // Нет живой строки в контексте слоя или пометка на удаление — напоминание
      // не показывается и не срабатывает (сущность 62e6787b).
      out.set(id, 'unavailable');
    } else {
      out.set(id, row.active !== 0 ? 'active' : 'inactive');
    }
  }
  return out;
}

/** Субъект обязан существовать и не быть помеченным на удаление (иначе 404). */
function assertSubjectUsable(
  ndb: NetworkDb,
  subjectType: ReminderSubjectType,
  subjectId: string,
): void {
  const visibility = subjectVisibility(ndb, subjectType, [subjectId]).get(subjectId);
  if (visibility === undefined || visibility === 'unavailable') {
    throw new EtnError('NOT_FOUND', `${subjectType} ${subjectId} not found`, {
      entity: subjectType,
      id: subjectId,
    });
  }
}

/** Собрать карточку напоминания из строки, посчитав `next_at` лениво. */
function toDto(
  row: ReminderRow,
  visibility: SubjectVisibility,
  nowMs: number,
  occurrences?: ReminderOccurrence[],
): Reminder {
  const schedule = parseStoredSchedule(row);
  const anchorMs = parseInstant(row.anchor_at);
  const exceptions = parseStoredExceptions(row);
  const dto: Reminder = {
    id: row.id,
    user_id: row.user_id,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    subject_state: visibility === 'inactive' ? 'inactive' : 'active',
    kind: row.kind,
    schedule,
    anchor_at: row.anchor_at,
    next_at: computeNextAt(schedule, anchorMs, exceptionMap(exceptions), nowMs),
    exceptions,
    state: row.state,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (occurrences !== undefined) dto.occurrences = occurrences;
  return dto;
}

/** Период раскрытия после применения потолка дальности. */
function expansionWindow(
  options: ReminderListOptions,
  nowMs: number,
): { fromMs: number; toMs: number } | null {
  if (options.from === undefined && options.to === undefined) return null;
  const horizonDays = options.horizon_days ?? REMINDER_DEFAULT_HORIZON_DAYS;
  if (horizonDays < 1 || horizonDays > REMINDER_MAX_HORIZON_DAYS) {
    badRequest(`\`horizon_days\` must be from 1 to ${REMINDER_MAX_HORIZON_DAYS}.`, 'horizon_days');
  }
  const fromMs = options.from === undefined ? nowMs : parseInstant(options.from, 'from');
  const ceiling = fromMs + horizonDays * MS_PER_DAY;
  const toMs = options.to === undefined ? ceiling : parseInstant(options.to, 'to');
  if (toMs < fromMs) badRequest('`to` must not be earlier than `from`.', 'to');
  // Жёсткий потолок дальности: период обрезается, а не отвергается
  // (требование 4401beb8 — раскрытие ограничено запрошенным периодом).
  return { fromMs, toMs: Math.min(toMs, ceiling) };
}

/** Строка владельца; чужое — 403, удалённое/отсутствующее — 404. */
function loadOwnedRow(ndb: NetworkDb, userId: string, reminderId: string): ReminderRow {
  const row = ndb.prepare('SELECT * FROM reminders WHERE id = ?').get(reminderId) as
    ReminderRow | undefined;
  if (row === undefined || row.state === 'removed') notFound(reminderId);
  if (row.user_id !== userId) forbidden(reminderId);
  return row;
}

/** Список напоминаний владельца на период (с раскрытием повторов). */
export function listReminders(
  ndb: NetworkDb,
  userId: string,
  options: ReminderListOptions,
): ReminderListResult {
  const nowMs = options.nowMs ?? Date.now();
  const window = expansionWindow(options, nowMs);
  const rows = ndb
    .prepare("SELECT * FROM reminders WHERE user_id = ? AND state = 'active'")
    .all(userId) as ReminderRow[];

  // Субъекты проверяются пакетно по видам — один запрос на вид.
  const idsByType = new Map<ReminderSubjectType, string[]>();
  for (const row of rows) {
    const ids = idsByType.get(row.subject_type) ?? [];
    ids.push(row.subject_id);
    idsByType.set(row.subject_type, ids);
  }
  const visibility = new Map<string, SubjectVisibility>();
  for (const [type, ids] of idsByType) {
    for (const [id, state] of subjectVisibility(ndb, type, [...new Set(ids)])) {
      visibility.set(`${type}:${id}`, state);
    }
  }

  const reminders: Reminder[] = [];
  for (const row of rows) {
    if (options.subject_type !== undefined && row.subject_type !== options.subject_type) continue;
    if (options.subject_id !== undefined && row.subject_id !== options.subject_id) continue;
    const subject = visibility.get(`${row.subject_type}:${row.subject_id}`) ?? 'unavailable';
    if (subject === 'unavailable') continue;
    if (subject === 'inactive' && !options.show_inactive) continue;
    const occurrences =
      window === null
        ? undefined
        : expandOccurrences(
            parseStoredSchedule(row),
            parseInstant(row.anchor_at),
            window.fromMs,
            window.toMs,
            exceptionMap(parseStoredExceptions(row)),
          );
    reminders.push(toDto(row, subject, nowMs, occurrences));
  }

  // Порядок — по близости срабатывания; напоминания без вхождений — в конце.
  reminders.sort((a, b) => {
    if (a.next_at === null && b.next_at === null) return a.created_at.localeCompare(b.created_at);
    if (a.next_at === null) return 1;
    if (b.next_at === null) return -1;
    return a.next_at.localeCompare(b.next_at) || a.created_at.localeCompare(b.created_at);
  });

  return {
    reminders,
    from: window === null ? null : new Date(window.fromMs).toISOString(),
    to: window === null ? null : new Date(window.toMs).toISOString(),
  };
}

/** Создать напоминание владельца (нормализация anchor и next_at — на сервере). */
export function createReminder(
  ndb: NetworkDb,
  userId: string,
  input: ReminderCreateInput,
  nowMs: number = Date.now(),
): Reminder {
  const schedule = validateSchedule(input.schedule);
  assertScheduleKind(input.kind, schedule);
  assertSubjectUsable(ndb, input.subject_type, input.subject_id);
  const anchorMs = normalizeAnchor(schedule, parseInstant(input.anchor_at));
  const nextAt = computeNextAt(schedule, anchorMs, new Map(), nowMs);
  const now = new Date().toISOString();
  const row: ReminderRow = {
    id: randomUUID(),
    user_id: userId,
    subject_type: input.subject_type,
    subject_id: input.subject_id,
    kind: input.kind,
    schedule: JSON.stringify(schedule),
    anchor_at: new Date(anchorMs).toISOString(),
    next_at: nextAt,
    exceptions: '{}',
    state: 'active',
    created_at: now,
    updated_at: now,
  };
  ndb
    .prepare(
      `INSERT INTO reminders
         (id, user_id, subject_type, subject_id, kind, schedule, anchor_at, next_at, exceptions, state, created_at, updated_at)
       VALUES (@id, @user_id, @subject_type, @subject_id, @kind, @schedule, @anchor_at, @next_at, @exceptions, @state, @created_at, @updated_at)`,
    )
    .run(row);
  const visibility = subjectVisibility(ndb, row.subject_type, [row.subject_id]).get(row.subject_id);
  return toDto(row, visibility ?? 'unavailable', nowMs);
}

/**
 * Изменить расписание (PATCH): kind/schedule/anchor, `next_at` пересчитывается
 * полностью, исключения сбрасываются (операция ae19b1bf, требование 86cb7451).
 */
export function updateReminder(
  ndb: NetworkDb,
  userId: string,
  reminderId: string,
  input: ReminderUpdateInput,
  nowMs: number = Date.now(),
): Reminder {
  const row = loadOwnedRow(ndb, userId, reminderId);
  if (input.kind === undefined && input.schedule === undefined && input.anchor_at === undefined) {
    badRequest('provide at least one of `kind`, `schedule`, `anchor_at`.', 'schedule');
  }
  const currentSchedule = parseStoredSchedule(row);
  const schedule =
    input.schedule === undefined ? currentSchedule : validateSchedule(input.schedule);
  const kind = input.kind ?? kindOfSchedule(schedule);
  assertScheduleKind(kind, schedule);
  const anchorSource = input.anchor_at === undefined ? row.anchor_at : input.anchor_at;
  const anchorMs = normalizeAnchor(schedule, parseInstant(anchorSource));
  const nextAt = computeNextAt(schedule, anchorMs, new Map(), nowMs);
  const updated: ReminderRow = {
    ...row,
    kind,
    schedule: JSON.stringify(schedule),
    anchor_at: new Date(anchorMs).toISOString(),
    next_at: nextAt,
    exceptions: '{}',
    updated_at: new Date().toISOString(),
  };
  ndb
    .prepare(
      `UPDATE reminders
          SET kind = @kind, schedule = @schedule, anchor_at = @anchor_at,
              next_at = @next_at, exceptions = @exceptions, updated_at = @updated_at
        WHERE id = @id`,
    )
    .run(updated);
  const visibility = subjectVisibility(ndb, updated.subject_type, [updated.subject_id]).get(
    updated.subject_id,
  );
  return toDto(updated, visibility ?? 'unavailable', nowMs);
}

/**
 * Удалить напоминание владельца. Строка помечается `removed` (per-user
 * сервисные данные в графе не живут; выдачи её не видят).
 */
export function removeReminder(
  ndb: NetworkDb,
  userId: string,
  reminderId: string,
  nowMs: number = Date.now(),
): Reminder {
  const row = loadOwnedRow(ndb, userId, reminderId);
  const removed: ReminderRow = {
    ...row,
    state: 'removed',
    updated_at: new Date().toISOString(),
  };
  ndb
    .prepare('UPDATE reminders SET state = @state, updated_at = @updated_at WHERE id = @id')
    .run(removed);
  const visibility = subjectVisibility(ndb, row.subject_type, [row.subject_id]).get(row.subject_id);
  return toDto(removed, visibility ?? 'unavailable', nowMs);
}

/** Ошибка «обрабатывать нечего» — 409 (операции ae19b1bf/500d1b3d). */
function noActiveOccurrence(): never {
  throw new EtnError('VALIDATION_ERROR', 'the reminder has no active occurrence to process.', {
    status: 409,
    field: 'reminder_id',
  });
}

/**
 * Граница текущих UTC-суток — нижняя граница поиска «наступившего» вхождения.
 *
 * Сервер не решает «сегодня» (требование fcdcd75f: локальные сутки — забота
 * клиента), поэтому для ВЫЗОВОВ БЕЗ явного `occurrence_at` берётся грубая
 * серверная аппроксимация — начало текущих UTC-суток. Этого достаточно, чтобы
 * вхождение, наступившее ранее в тот же день, оставалось активным для
 * snooze/dismiss (хвост приёмки 0.16.1): панель показывает его в секции
 * «Сегодня», а до исправления сервер отвечал 409 «нет активного вхождения».
 * Точный адрес вхождения (в том числе просроченного) клиент передаёт явно.
 */
function utcDayStartMs(nowMs: number): number {
  return Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY;
}

/**
 * Вхождение, к которому применяется snooze/dismiss.
 *
 * `requestedOccurrenceAt` (необязательный `occurrence_at` запроса) адресует
 * КОНКРЕТНОЕ вхождение серии — это путь панели: она показывает несколько
 * вхождений одного напоминания (секции «Просрочено/Сегодня/Период»), и команда
 * строки обязана менять именно показанное вхождение, а не «ближайшее».
 * Вхождение проверяется по расписанию (момент обязан быть вхождением серии) и
 * по карте исключений (уже убранное — 409).
 *
 * Без адреса берётся ближайшее необработанное вхождение не раньше начала
 * текущих UTC-суток: вхождение «сегодня», момент которого уже прошёл, остаётся
 * активным; более старые пропускаются (ленивое продвижение next_at).
 */
function activeOccurrence(
  row: ReminderRow,
  nowMs: number,
  requestedOccurrenceAt?: string,
): { occurrenceAt: string; occurrenceMs: number; showingAt: string } {
  const schedule = parseStoredSchedule(row);
  const anchorMs = parseInstant(row.anchor_at);
  const exceptions = exceptionMap(parseStoredExceptions(row));

  let candidate: { occurrence_at: number; showing_at: number } | null;
  if (requestedOccurrenceAt !== undefined) {
    const atMs = parseInstant(requestedOccurrenceAt, 'occurrence_at');
    // Момент обязан быть вхождением ЭТОЙ серии: иначе клиент адресует чужую
    // строку, и запись исключения легла бы в мёртвый ключ.
    if (firstOccurrenceOnOrAfter(schedule, anchorMs, atMs) !== atMs) noActiveOccurrence();
    const exception = exceptions.get(atMs);
    if (exception?.kind === 'dismiss') noActiveOccurrence();
    const untilMs = exception?.kind === 'snooze' ? Date.parse(exception.until) : Number.NaN;
    const showingAt = Number.isFinite(untilMs) && untilMs > atMs ? untilMs : atMs;
    candidate = { occurrence_at: atMs, showing_at: showingAt };
  } else {
    candidate = nextCandidate(schedule, anchorMs, exceptions, utcDayStartMs(nowMs));
  }
  if (candidate === null) noActiveOccurrence();
  // Исключение адресует МОМЕНТ ВХОЖДЕНИЯ, а не момент показа: повторное
  // «Отложить» уже перенесённого вхождения переписывает его же запись.
  return {
    occurrenceAt: new Date(candidate.occurrence_at).toISOString(),
    occurrenceMs: candidate.occurrence_at,
    showingAt: new Date(candidate.showing_at).toISOString(),
  };
}

/**
 * Отложить вхождение: в `exceptions` пишется `{ kind: snooze, until }` на его
 * момент. Расписание и серия не меняются (требование 86cb7451).
 *
 * `requestedOccurrenceAt` — явный адрес вхождения из панели (см.
 * {@link activeOccurrence}); без него адресуется ближайшее необработанное.
 *
 * `until` обязан быть строго позже МОМЕНТА ВХОЖДЕНИЯ: при `until ≤ момент`
 * вхождение по правилу строгого сравнения не скрывается, запись в exceptions
 * мёртвая, а `next_at` вернулся бы к тому же вхождению — «Отложить» молча не
 * работало (хвост приёмки 0.16.1, требование 4401beb8).
 */
export function snoozeReminder(
  ndb: NetworkDb,
  userId: string,
  reminderId: string,
  until: string,
  nowMs: number = Date.now(),
  requestedOccurrenceAt?: string,
): ReminderOccurrenceChange {
  const row = loadOwnedRow(ndb, userId, reminderId);
  const { occurrenceAt, occurrenceMs } = activeOccurrence(row, nowMs, requestedOccurrenceAt);
  const untilMs = parseInstant(until, 'until');
  if (untilMs <= nowMs) badRequest('`until` must be in the future.', 'until');
  if (untilMs <= occurrenceMs) {
    badRequest('`until` must be later than the occurrence it postpones.', 'until');
  }
  const exceptions = parseStoredExceptions(row);
  exceptions[occurrenceAt] = { kind: 'snooze', until: new Date(untilMs).toISOString() };
  return writeExceptions(ndb, row, exceptions, occurrenceAt, nowMs);
}

/**
 * Убрать вхождение: `{ kind: dismiss }` на его момент; следующее вхождение по
 * расписанию остаётся видимым (сравнение строгое — равномоментное вхождение не
 * скрывается). `requestedOccurrenceAt` — явный адрес вхождения из панели.
 */
export function dismissReminder(
  ndb: NetworkDb,
  userId: string,
  reminderId: string,
  nowMs: number = Date.now(),
  requestedOccurrenceAt?: string,
): ReminderOccurrenceChange {
  const row = loadOwnedRow(ndb, userId, reminderId);
  const { occurrenceAt } = activeOccurrence(row, nowMs, requestedOccurrenceAt);
  const exceptions = parseStoredExceptions(row);
  exceptions[occurrenceAt] = { kind: 'dismiss' };
  return writeExceptions(ndb, row, exceptions, occurrenceAt, nowMs);
}

/** Записать обновлённую карту исключений и пересчитанный `next_at`. */
function writeExceptions(
  ndb: NetworkDb,
  row: ReminderRow,
  exceptions: Record<string, ReminderException>,
  occurrenceAt: string,
  nowMs: number,
): ReminderOccurrenceChange {
  const schedule = parseStoredSchedule(row);
  const anchorMs = parseInstant(row.anchor_at);
  const nextAt = computeNextAt(schedule, anchorMs, exceptionMap(exceptions), nowMs);
  const updated: ReminderRow = {
    ...row,
    exceptions: JSON.stringify(exceptions),
    next_at: nextAt,
    updated_at: new Date().toISOString(),
  };
  ndb
    .prepare(
      'UPDATE reminders SET exceptions = @exceptions, next_at = @next_at, updated_at = @updated_at WHERE id = @id',
    )
    .run(updated);
  const visibility = subjectVisibility(ndb, row.subject_type, [row.subject_id]).get(row.subject_id);
  return {
    reminder: toDto(updated, visibility ?? 'unavailable', nowMs),
    occurrence_at: occurrenceAt,
  };
}
