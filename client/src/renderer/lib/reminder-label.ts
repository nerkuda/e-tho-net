/**
 * Человекочитаемые подписи напоминаний (0.16.1, задача 173f1540; элементы
 * 24ad3735 «Флаг напоминаний в карточке мысли», ba827eb6 «Индикатор напоминания
 * в облачке», 58cca4f7 «Редактор напоминания»).
 *
 * Один словарь на все поверхности: шапка редактора мысли, Ctrl-подсказка
 * облачка, панель «Напоминания периода» и preview редактора. Раньше подпись
 * повтора жила локально в `screens/chronicle/tasks-panel.ts`; теперь её читают
 * четыре места, поэтому она вынесена в общий модуль (стандарт библиотечности
 * a2488f05 — не плодить вторую формулировку того же повтора).
 *
 * Подпись строится ИЗ ГРАММАТИКИ (`ReminderSchedule`), а не из текста сервера:
 * сервер отдаёт только данные расписания (требование bbca8f7d).
 */

import type { Reminder, ReminderSchedule } from '@etn/shared';

import { formatDate, formatDateTime, getLang, t } from './i18n.js';

/** Кэш названий дней недели по языку: `1..7` (ISO) → подпись. */
const weekdayNames = new Map<string, string[]>();
/** Кэш длинных названий дней недели (для подсказки и редактора). */
const weekdayLongNames = new Map<string, string[]>();

/** Названия дней недели текущего языка; ISO-порядок (пн … вс). */
function weekdayLabels(lang: string, style: 'short' | 'long'): string[] {
  const cache = style === 'short' ? weekdayNames : weekdayLongNames;
  const cached = cache.get(lang);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat(lang, { weekday: style, timeZone: 'UTC' });
  // 2024-01-01 — понедельник: индекс массива = ISO-день − 1.
  const names = Array.from({ length: 7 }, (_, index) =>
    formatter.format(new Date(Date.UTC(2024, 0, 1 + index))),
  );
  cache.set(lang, names);
  return names;
}

/** Подпись одного ISO-дня недели. */
export function weekdayLabel(day: number, style: 'short' | 'long' = 'short'): string {
  const list = weekdayLabels(getLang(), style);
  return list[Math.min(6, Math.max(0, day - 1))] ?? String(day);
}

/** «8 марта» из месяца/дня правила `yearly` (год не важен). */
function monthDayLabel(month: number, day: number): string {
  // Год 2024 — високосный: 29.02 форматируется, остальные дни не зависят от года.
  return formatDate(Date.UTC(2024, month - 1, day), {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

/** Подпись повтора для грамматики (без обращения к карточке напоминания). */
export function scheduleLabel(schedule: ReminderSchedule): string {
  switch (schedule.type) {
    case 'once':
      return t('reminder.once');
    case 'weekdays': {
      const days = schedule.days.map((day) => weekdayLabel(day)).join(', ');
      const everyWeeks = schedule.every_weeks ?? 1;
      return everyWeeks === 1
        ? t('reminder.weekdays', [days])
        : t('reminder.weekdaysEvery', [everyWeeks, days]);
    }
    case 'every_days': {
      const label =
        schedule.every === 1 ? t('reminder.everyDay') : t('reminder.everyNDays', [schedule.every]);
      // Пропуск выходных — часть смысла серии: подпись обязана её называть.
      return schedule.skip_weekends === true
        ? `${label}${t('reminder.skipWeekendsSuffix')}`
        : label;
    }
    case 'weekday_of_month': {
      const weekday = weekdayLabel(schedule.weekday, 'long');
      const everyMonths = schedule.every_months ?? 1;
      if (schedule.nth === 'last') {
        return everyMonths === 1
          ? t('reminder.weekdayOfMonthLast', [weekday])
          : t('reminder.weekdayOfMonthLastEvery', [weekday, everyMonths]);
      }
      return everyMonths === 1
        ? t('reminder.weekdayOfMonth', [weekday, schedule.nth])
        : t('reminder.weekdayOfMonthEvery', [weekday, schedule.nth, everyMonths]);
    }
    case 'day_of_month':
      return schedule.every_months === 1
        ? t('reminder.dayOfMonth', [schedule.day])
        : t('reminder.dayOfMonthEvery', [schedule.day, schedule.every_months]);
    case 'yearly': {
      const date = monthDayLabel(schedule.month, schedule.day);
      const everyYears = schedule.every_years ?? 1;
      return everyYears === 1
        ? t('reminder.yearly', [date])
        : t('reminder.yearlyEvery', [date, everyYears]);
    }
    case 'last_day_of_month':
      return schedule.every_months === 1
        ? t('reminder.lastDayOfMonth')
        : t('reminder.lastDayOfMonthEvery', [schedule.every_months]);
  }
}

/**
 * Подпись напоминания целиком: для `one` — момент, иначе — повтор. Именно это
 * показывают флаг в шапке мысли и подсказка облачка (примеры из решения
 * пользователя: «ежегодно 8 марта», «каждое 18-е»).
 */
export function reminderLabel(reminder: Reminder): string {
  if (reminder.kind === 'one') {
    return t('reminder.onceAt', [
      formatDateTime(reminder.anchor_at, { dateStyle: 'short', timeStyle: 'short' }),
    ]);
  }
  return scheduleLabel(reminder.schedule);
}

/**
 * Текст флага в шапке мысли: активные напоминания через «·». Несколько
 * напоминаний перечисляются (элемент 24ad3735); `''` — напоминаний нет, флаг
 * не показывается.
 */
export function remindersFlagText(reminders: readonly Reminder[]): string {
  const labels = reminders
    .filter((reminder) => reminder.state === 'active')
    .map((reminder) => reminderLabel(reminder))
    .filter((label) => label !== '');
  return labels.join(' · ');
}

/**
 * Строки Ctrl-подсказки облачка: одно напоминание — «повтор · ближайшее».
 * Описание всех напоминаний субъекта перечисляет даты и повторы (ba827eb6).
 */
export function reminderPreviewLines(reminders: readonly Reminder[]): string[] {
  return reminders
    .filter((reminder) => reminder.state === 'active')
    .map((reminder) => {
      const label = reminderLabel(reminder);
      const next =
        reminder.next_at === null
          ? ''
          : ` · ${t('reminder.nextAt', [
              formatDateTime(reminder.next_at, { dateStyle: 'short', timeStyle: 'short' }),
            ])}`;
      return `${label}${next}`;
    });
}
