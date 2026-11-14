/**
 * Напоминания — сервисная per-user сущность сети (0.16.1, задача b47f1fd2;
 * ADR 03e429ed, сущность 62e6787b, грамматика повтора bbca8f7d).
 *
 * Напоминание живёт в network-БД (`reminders`), НЕ ветвится по слоям и не
 * является мыслью/связью сети. Владелец видит только свои напоминания;
 * субъект — мысль или публикация (в 0.16.1), связь субъектом быть не может.
 *
 * Серия вхождений вычисляется ЧИСТО из `schedule` + `anchor_at` (никакого
 * материализованного календаря): `next_at` — первое необработанное вхождение,
 * `exceptions` — карта `occurrence_at → { snooze, until } | { dismiss }`.
 * Время суток каждого вхождения наследуется от `anchor_at`; сервер оперирует
 * только UTC-инстансами («сегодня» и границы суток считает клиент — требование
 * fcdcd75f).
 */

/** Вид субъекта напоминания (0.16.1: мысль или публикация). */
export const REMINDER_SUBJECT_TYPES = ['thought', 'publication'] as const;
export type ReminderSubjectType = (typeof REMINDER_SUBJECT_TYPES)[number];

/**
 * Крупный вид напоминания (сущность `reminders`): `one` — один раз (сам
 * `anchor_at`), `period` — периодическая серия фиксированного шага,
 * `rule` — календарное правило. Вид выводится из `schedule.type` и обязан с
 * ним согласовываться.
 */
export const REMINDER_KINDS = ['one', 'period', 'rule'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** Жизненный цикл строки: `removed` — удалено владельцем (в выдачах не видно). */
export const REMINDER_STATES = ['active', 'removed'] as const;
export type ReminderState = (typeof REMINDER_STATES)[number];

/**
 * Типы расписания — закрытая грамматика повтора (требование bbca8f7d):
 * шесть видов повтора плюс `once` для kind=one.
 */
export const REMINDER_SCHEDULE_TYPES = [
  'once',
  'weekdays',
  'every_days',
  'weekday_of_month',
  'day_of_month',
  'yearly',
  'last_day_of_month',
] as const;
export type ReminderScheduleType = (typeof REMINDER_SCHEDULE_TYPES)[number];

/** `once` — единственное вхождение в `anchor_at` (kind=one). */
export interface ReminderScheduleOnce {
  type: 'once';
}

/** Выбранные дни недели (ISO: 1 = понедельник … 7 = воскресенье). */
export interface ReminderScheduleWeekdays {
  type: 'weekdays';
  /** ISO-дни недели, 1..7; дубликаты нормализуются. */
  days: number[];
}

/** Каждый N-й день начиная от опорной даты. */
export interface ReminderScheduleEveryDays {
  type: 'every_days';
  /** N ≥ 1. */
  every: number;
}

/**
 * N-й день недели месяца (`nth` 1..5) или последний такой день (`last`).
 * Отсутствующий в месяце N-й день (например, 5-й четверг) — пропуск вхождения.
 */
export interface ReminderScheduleWeekdayOfMonth {
  type: 'weekday_of_month';
  /** ISO-день недели, 1..7. */
  weekday: number;
  nth: number | 'last';
}

/** Число месяца каждые N месяцев; 31-е в коротком месяце → последний день. */
export interface ReminderScheduleDayOfMonth {
  type: 'day_of_month';
  /** 1..31. */
  day: number;
  /** N ≥ 1. */
  every_months: number;
}

/** Ежегодно по дате (MM-DD); 29.02 в невисокосный год → 28.02. */
export interface ReminderScheduleYearly {
  type: 'yearly';
  /** 1..12. */
  month: number;
  /** 1..31. */
  day: number;
}

/** Последний день месяца каждые N месяцев. */
export interface ReminderScheduleLastDayOfMonth {
  type: 'last_day_of_month';
  every_months: number;
}

/** Закрытая грамматика повтора напоминания. */
export type ReminderSchedule =
  | ReminderScheduleOnce
  | ReminderScheduleWeekdays
  | ReminderScheduleEveryDays
  | ReminderScheduleWeekdayOfMonth
  | ReminderScheduleDayOfMonth
  | ReminderScheduleYearly
  | ReminderScheduleLastDayOfMonth;

/** Исключение на момент вхождения: вхождение убрано. */
export interface ReminderExceptionDismiss {
  kind: 'dismiss';
}

/** Исключение на момент вхождения: показ перенесён на `until` (только это вхождение). */
export interface ReminderExceptionSnooze {
  kind: 'snooze';
  /** Новый UTC-момент показа (ISO-8601). */
  until: string;
}

export type ReminderException = ReminderExceptionDismiss | ReminderExceptionSnooze;

/** Состояние субъекта для выдачи: `inactive` — мысль/публикация неактуальна. */
export const REMINDER_SUBJECT_STATES = ['active', 'inactive'] as const;
export type ReminderSubjectState = (typeof REMINDER_SUBJECT_STATES)[number];

/** Одно вхождение серии в раскрытии на период. */
export interface ReminderOccurrence {
  /** Момент вхождения по расписанию (UTC-инстанс). */
  occurrence_at: string;
  /** `active` — показывается в свой момент; `snoozed` — перенесено на `until`. */
  status: 'active' | 'snoozed';
  /** Момент показа для `status: snoozed` (иначе `null`). */
  until: string | null;
}

/** Напоминание в выдаче API (владелец — вызывающий пользователь). */
export interface Reminder {
  id: string;
  user_id: string;
  subject_type: ReminderSubjectType;
  subject_id: string;
  /** Актуальность субъекта: `inactive` показывается по настройке сети `show_inactive`. */
  subject_state: ReminderSubjectState;
  kind: ReminderKind;
  schedule: ReminderSchedule;
  /** Опорное вхождение: серия и время суток всех вхождений считаются от него. */
  anchor_at: string;
  /** Первое необработанное вхождение; `null` — вхождений больше нет (kind=one убран). */
  next_at: string | null;
  /** Карта исключений: UTC-момент вхождения → исключение. */
  exceptions: Record<string, ReminderException>;
  state: ReminderState;
  /** Раскрытие на запрошенный период; отсутствует, если период не запрашивался. */
  occurrences?: ReminderOccurrence[];
  created_at: string;
  updated_at: string;
}

/**
 * Ответ списка напоминаний: строки владельца плюс фактический период раскрытия
 * (после применения потолка дальности — `horizon_days`).
 */
export interface ReminderListResult {
  reminders: Reminder[];
  /** Начало раскрытого периода (UTC) или `null`, если период не запрашивался. */
  from: string | null;
  /** Конец раскрытого периода (UTC) после применения потолка дальности. */
  to: string | null;
}

/**
 * Ответ изменения вхождения (`POST …/reminders/{id}/snooze`,
 * `POST …/reminders/{id}/dismiss`): обновлённая строка и момент вхождения,
 * к которому применено изменение (UTC).
 */
export interface ReminderOccurrenceChange {
  reminder: Reminder;
  occurrence_at: string;
}

/** Ответ `DELETE …/reminders/{id}`: id удалённого напоминания владельца. */
export interface ReminderDeleteResult {
  id: string;
}

/** Потолок дальности раскрытия по умолчанию — 1 год от `from`. */
export const REMINDER_DEFAULT_HORIZON_DAYS = 366;

/** Жёсткий максимум запрашиваемого потолка дальности — 10 лет. */
export const REMINDER_MAX_HORIZON_DAYS = 3660;
