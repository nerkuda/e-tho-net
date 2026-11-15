/**
 * Редактор напоминания — команда «Напомнить», параметры серии, опорное время и
 * preview (0.16.1, задача 173f1540; элемент интерфейса 58cca4f7, грамматика
 * bbca8f7d, операции ae19b1bf/500d1b3d).
 *
 * Концепция переработана по ТЗ пользователя (2026-11-15, ошибка 3ff85ede):
 * переключателя «Вид» больше нет, «Повтор» стал списком «Напомнить» из семи
 * команд, каждая показывает СВОИ поля:
 *   • не напоминать — только у существующего напоминания: удаляет серию
 *     (мягкое удаление, `state=removed`) — будущих показов не остаётся;
 *   • однократно — дата;
 *   • каждый день — «начиная с <дата> каждый <n> день» + «пропускать выходные»;
 *   • каждую неделю — «каждую <n> неделю» + дни недели (порядок от первого дня
 *     недели сети, требование 1b77decd);
 *   • каждое число месяца — «каждый <n> месяц» + число (1..30 | последний день);
 *   • каждый месяц в день недели — «каждый <n> месяц» + порядок (1..5 | последний)
 *     + день недели;
 *   • каждый год в указанную дату — «каждый <n> год» + месяц + дата.
 * Ниже общее поле времени (по умолчанию 09:00), затем «Следующие 5 напоминаний».
 *
 * Субъект фиксирован (мысль или публикация, из карточки которой редактор открыт);
 * «Отложить»/«Убрать» — НЕ здесь: они пишут исключения и живут в меню флага и
 * панели (требование 86cb7451).
 *
 * Дефолты по ТЗ: опорная дата — сегодня (или первое датовое свойство субъекта,
 * элемент 58cca4f7), n = 1, отмечен текущий день недели, «пропускать выходные» —
 * выключено, время 09:00.
 *
 * Preview считает ТОТ ЖЕ вычислитель, что сервер: `expandOccurrences` из
 * `@etn/shared` (одна реализация грамматики — preview и `GET /reminders` не
 * расходятся). Время суток вхождений наследуется от опорного момента.
 *
 * Контролы — только фасады коллекции: `lib/dialog.ts` (каркас), `lib/date-field.ts`
 * + `lib/date-period-dialog.ts` (дата и календарь), `lib/ui/field.ts`
 * (числа/выбор), `lib/ui/choice-row.ts` (флажок), `lib/ui/toggle.ts` (дни недели).
 */

import {
  expandOccurrences,
  kindOfSchedule,
  normalizeAnchor,
  type Reminder,
  type ReminderSchedule,
  type ReminderSubjectType,
} from '@etn/shared';

import { store } from '../state.js';
import { dateField } from './date-field.js';
import { openDatePeriodDialog } from './date-period-dialog.js';
import { resolveFirstDayOfWeek } from './dates.js';
import { showDialog } from './dialog.js';
import { div, el, errText, span } from './dom.js';
import { etn } from './etn.js';
import { formatDateTime, getLang, t } from './i18n.js';
import { weekdayLabel } from './reminder-label.js';
import { checkboxRow } from './ui/choice-row.js';
import { fieldInput, fieldRow, fieldSelect } from './ui/field.js';
import { footerErrorLine } from './ui/messages.js';
import { toggleButton } from './ui/toggle.js';

/** Класс корня тела редактора (DOM-пробы и сторож). */
export const REMINDER_EDITOR_CLASS = 'reminder-editor';
/** Класс списка preview. */
export const REMINDER_PREVIEW_CLASS = 'reminder-preview';

/** Миллисекунд в сутках — окно preview. */
const DAY_MS = 86_400_000;
/** Сколько ближайших вхождений показывает preview (подпись «Следующие 5…»). */
export const PREVIEW_LIMIT = 5;
/** Верхняя граница выбора «число месяца» по ТЗ: 1..30 плюс «последний день». */
export const REMINDER_DAY_LIMIT = 30;

/**
 * Команда списка «Напомнить» (ТЗ 2026-11-15). `not_remind` — не вид повтора, а
 * действие: у несуществующего напоминания его нет, у существующего оно удаляет
 * серию целиком.
 */
export type ReminderCommand =
  | 'not_remind'
  | 'once'
  | 'every_days'
  | 'weekdays'
  | 'day_of_month'
  | 'weekday_of_month'
  | 'yearly';

/** Порядок команд в списке «Напомнить» — ровно как в ТЗ. */
export const REMINDER_COMMANDS: readonly ReminderCommand[] = [
  'once',
  'every_days',
  'weekdays',
  'day_of_month',
  'weekday_of_month',
  'yearly',
];

/** Черновик формы: всё, что пользователь выбрал (живёт вне DOM).
 *  Экспортирован ради юнит-проверок чистых частей редактора. */
export interface ReminderDraft {
  command: ReminderCommand;
  /** Опорная дата `YYYY-MM-DD` (локальная): дата разового, начало серии. */
  date: string;
  /** Время `HH:MM` (локальное), общее для всех вхождений. */
  time: string;
  /** Выбранные дни недели (ISO 1..7) для команды «каждую неделю». */
  days: number[];
  /** Шаг команды: дни / недели / месяцы / годы. */
  interval: number;
  /** «Пропускать выходные» для команды «каждый день». */
  skipWeekends: boolean;
  /** Число месяца 1..31 (для «каждое число месяца» и «каждый год»). */
  day: number;
  /** Выбран вариант «последний день месяца» (команда «каждое число месяца»). */
  dayLast: boolean;
  /** ISO-день недели для команды «каждый месяц в день недели». */
  weekday: number;
  /** Порядок вхождения в месяце: 1..5 или `last`. */
  nth: number | 'last';
  /** Месяц 1..12 для команды «каждый год». */
  month: number;
}

/** Опции открытия редактора. */
export interface ReminderEditorOptions {
  subjectType: ReminderSubjectType;
  subjectId: string;
  /** Существующее напоминание — правка расписания (PATCH). */
  reminder?: Reminder;
  /** Заголовок субъекта для шапки диалога. */
  subjectTitle?: string;
  /** Напоминание сохранено (создано или изменено). */
  onSaved?: (reminder: Reminder) => void;
  /** Напоминание снято командой «не напоминать» (строка удалена). */
  onRemoved?: () => void;
}

/** Дата `YYYY-MM-DD` в локальной зоне из Date. */
function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Время `HH:MM` в локальной зоне из Date. */
function localTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Локальные дата+время → UTC-инстанс; невалидное время даёт полночь. */
function localInstant(day: string, time: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const [hours, minutes] = (time === '' ? '09:00' : time).split(':').map(Number) as [
    number,
    number,
  ];
  return new Date(year, month - 1, date, hours || 0, minutes || 0, 0, 0).getTime();
}

/** ISO-день недели локальной даты (1 = пн … 7 = вс). */
function isoWeekdayOf(day: string): number {
  const dow = new Date(`${day}T12:00:00`).getDay();
  return dow === 0 ? 7 : dow;
}

/** Сколько дней в месяце `month` (1..12); февраль считается високосным. */
function daysInMonthOf(month: number): number {
  return new Date(Date.UTC(2024, month, 0)).getUTCDate();
}

/** Количество дней в месяце, в котором лежит локальная дата `day`. */
function daysInMonthOfDay(day: string): number {
  return daysInMonthOf(Number(day.slice(5, 7)));
}

/** Подпись команды «Напомнить». */
export function commandLabel(command: ReminderCommand): string {
  switch (command) {
    case 'not_remind':
      return t('reminder.cmdNotRemind');
    case 'once':
      return t('reminder.cmdOnce');
    case 'every_days':
      return t('reminder.cmdEveryDays');
    case 'weekdays':
      return t('reminder.cmdWeekdays');
    case 'day_of_month':
      return t('reminder.cmdDayOfMonth');
    case 'weekday_of_month':
      return t('reminder.cmdWeekdayOfMonth');
    case 'yearly':
      return t('reminder.cmdYearly');
  }
}

/** Команда формы по типу расписания (обратный маппинг для правки). */
export function commandOfSchedule(schedule: ReminderSchedule): ReminderCommand {
  switch (schedule.type) {
    case 'once':
      return 'once';
    case 'every_days':
      return 'every_days';
    case 'weekdays':
      return 'weekdays';
    case 'day_of_month':
    case 'last_day_of_month':
      return 'day_of_month';
    case 'weekday_of_month':
      return 'weekday_of_month';
    case 'yearly':
      return 'yearly';
  }
}

/** Расписание из черновика (закрытая грамматика, bbca8f7d). */
export function scheduleOf(draft: ReminderDraft): ReminderSchedule {
  switch (draft.command) {
    case 'not_remind':
      // Команда удаляет серию: расписания у неё нет (ветка не вызывается).
      throw new Error('command "not_remind" has no schedule');
    case 'once':
      return { type: 'once' };
    case 'every_days':
      return {
        type: 'every_days',
        every: Math.max(1, draft.interval),
        skip_weekends: draft.skipWeekends,
      };
    case 'weekdays':
      return {
        type: 'weekdays',
        days:
          draft.days.length > 0
            ? [...draft.days].sort((a, b) => a - b)
            : [isoWeekdayOf(draft.date)],
        every_weeks: Math.max(1, draft.interval),
      };
    case 'day_of_month':
      return draft.dayLast
        ? { type: 'last_day_of_month', every_months: Math.max(1, draft.interval) }
        : {
            type: 'day_of_month',
            day: Math.max(1, draft.day),
            every_months: Math.max(1, draft.interval),
          };
    case 'weekday_of_month':
      return {
        type: 'weekday_of_month',
        weekday: draft.weekday,
        nth: draft.nth,
        every_months: Math.max(1, draft.interval),
      };
    case 'yearly':
      return {
        type: 'yearly',
        month: draft.month,
        day: Math.max(1, draft.day),
        every_years: Math.max(1, draft.interval),
      };
  }
}

/** Начальный черновик нового напоминания (дефолты ТЗ 2026-11-15). */
export function emptyDraft(): ReminderDraft {
  const now = new Date();
  const day = localDay(now);
  const weekday = isoWeekdayOf(day);
  return {
    command: 'once',
    date: day,
    time: '09:00',
    days: [weekday],
    interval: 1,
    skipWeekends: false,
    day: Math.min(REMINDER_DAY_LIMIT, now.getDate()),
    dayLast: false,
    weekday,
    nth: Math.min(5, Math.floor((now.getDate() - 1) / 7) + 1),
    month: now.getMonth() + 1,
  };
}

/** Черновик по существующему напоминанию (правка расписания). */
export function draftOf(reminder: Reminder): ReminderDraft {
  const anchor = new Date(reminder.anchor_at);
  const date = Number.isFinite(anchor.getTime()) ? localDay(anchor) : localDay(new Date());
  const base: ReminderDraft = {
    ...emptyDraft(),
    command: commandOfSchedule(reminder.schedule),
    date,
    time: Number.isFinite(anchor.getTime()) ? localTime(anchor) : '09:00',
    day: Number(date.slice(8, 10)),
    weekday: isoWeekdayOf(date),
    nth: Math.min(5, Math.floor((Number(date.slice(8, 10)) - 1) / 7) + 1),
    month: Number(date.slice(5, 7)),
  };
  const schedule = reminder.schedule;
  switch (schedule.type) {
    case 'weekdays':
      return { ...base, days: [...schedule.days], interval: schedule.every_weeks ?? 1 };
    case 'every_days':
      return {
        ...base,
        interval: schedule.every,
        skipWeekends: schedule.skip_weekends === true,
      };
    case 'weekday_of_month':
      return {
        ...base,
        weekday: schedule.weekday,
        nth: schedule.nth,
        interval: schedule.every_months ?? 1,
      };
    case 'day_of_month':
      return { ...base, day: schedule.day, dayLast: false, interval: schedule.every_months };
    case 'last_day_of_month':
      return { ...base, dayLast: true, interval: schedule.every_months };
    case 'yearly':
      return {
        ...base,
        month: schedule.month,
        day: schedule.day,
        interval: schedule.every_years ?? 1,
      };
    default:
      return base;
  }
}

/**
 * Опорная дата по первому датовому свойству субъекта (элемент 58cca4f7):
 * «напомнить про покупку» подставляет дату покупки, а не сегодня. Свойств нет
 * или они нечитаемы — остаётся сегодня. Публикации датовых свойств в 0.16.1 не
 * несут — для них дефолт всегда «сегодня».
 */
async function defaultDateFromSubject(options: ReminderEditorOptions): Promise<string | null> {
  const networkId = store.state.networkId;
  if (networkId === null || options.subjectType !== 'thought') return null;
  try {
    const values = await etn.properties.get(networkId, 'thought', options.subjectId);
    for (const value of values) {
      if (value.value_type !== 'date') continue;
      const raw = value.value;
      if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    }
  } catch {
    // Нет свойств/нет прав — дефолт «сегодня»; редактор обязан открыться.
    return null;
  }
  return null;
}

/**
 * Открыть редактор напоминания. Возвращает `null` при отказе (закрытие) или
 * после команды «не напоминать», иначе сохранённое напоминание.
 */
export async function openReminderEditor(options: ReminderEditorOptions): Promise<Reminder | null> {
  const networkId = store.state.networkId;
  if (networkId === null) return null;
  const existing = options.reminder;
  let draft = existing === undefined ? emptyDraft() : draftOf(existing);
  if (existing === undefined) {
    const date = await defaultDateFromSubject(options);
    if (date !== null) {
      draft = {
        ...draft,
        date,
        days: [isoWeekdayOf(date)],
        day: Math.min(REMINDER_DAY_LIMIT, Number(date.slice(8, 10))),
        weekday: isoWeekdayOf(date),
        nth: Math.min(5, Math.floor((Number(date.slice(8, 10)) - 1) / 7) + 1),
        month: Number(date.slice(5, 7)),
      };
    }
  }

  return new Promise<Reminder | null>((resolve) => {
    let saved: Reminder | null = null;

    /** Первый день недели сети: порядок флажков и сетка календаря (1b77decd). */
    const firstDayOfWeek = (): number =>
      resolveFirstDayOfWeek(() => store.state.network?.first_day_of_week);

    /** Календарь для поля даты — существующий диалог «Дата/период». */
    const pickDay = async (current: string): Promise<string | null> => {
      const picked = await openDatePeriodDialog({
        allowPeriod: false,
        allowTime: false,
        initial: { from: current, to: current },
        firstDayOfWeek: firstDayOfWeek(),
        title: t('reminder.anchorDate'),
      });
      return picked === null ? null : picked.from;
    };

    const body = div(REMINDER_EDITOR_CLASS);

    // Список «Напомнить»: у несуществующего напоминания «не напоминать» нет —
    // создавать нечего, а удалять несуществующее бессмысленно.
    const commands: ReminderCommand[] = [
      ...(existing === undefined ? [] : (['not_remind'] as ReminderCommand[])),
      ...REMINDER_COMMANDS,
    ];
    const commandSelect = fieldSelect({
      options: commands.map((command) => ({ value: command, label: commandLabel(command) })),
      value: draft.command,
      onChange: (value) => {
        draft.command = value as ReminderCommand;
        renderParams();
        renderPreview();
      },
    });
    body.append(fieldRow({ label: t('reminder.command'), control: commandSelect }));

    const params = div('reminder-params');
    const anchorRow = div('reminder-anchor-row');
    const preview = div(REMINDER_PREVIEW_CLASS);
    const previewTitle = span(
      t('reminder.preview', [String(PREVIEW_LIMIT)]),
      'reminder-preview-title',
    );
    body.append(params, anchorRow, previewTitle, preview);

    /** Пересобрать поля, зависящие от команды (ТЗ: у каждой свой набор). */
    function renderCommandParams(): void {
      params.replaceChildren();
      anchorRow.replaceChildren();

      /** Поле даты с календарём (ТЗ: у дат — пикер из календаря). */
      const dateRow = (labelKey: Parameters<typeof t>[0]): HTMLElement => {
        const control = dateField({
          value: draft.date,
          ariaLabel: t(labelKey),
          onPick: () => pickDay(draft.date),
          onChange: (value) => {
            draft.date = value === '' ? localDay(new Date()) : value;
            syncDerivedFromDate();
            renderParams();
            renderPreview();
          },
        });
        return fieldRow({ label: t(labelKey), control: control.root });
      };

      /** Поле шага серии (дни/недели/месяцы/годы) — целое не меньше 1. */
      const intervalRow = (labelKey: Parameters<typeof t>[0]): HTMLElement => {
        const input = fieldInput({
          type: 'number',
          min: 1,
          step: 1,
          value: String(draft.interval),
          onChange: (value) => {
            draft.interval = Math.max(1, Number(value) || 1);
            renderPreview();
          },
        });
        return fieldRow({ label: t(labelKey), control: input });
      };

      switch (draft.command) {
        case 'not_remind':
          // Ни параметров, ни времени: команда снимает серию целиком.
          return;
        case 'once':
          params.append(dateRow('reminder.anchorDate'));
          return;
        case 'every_days':
          params.append(dateRow('reminder.startFrom'), intervalRow('reminder.everyDays'));
          // Флажок — фасад `choice-row` (ТЗ: «флажок „пропускать выходные“»).
          params.append(
            checkboxRow({
              label: t('reminder.skipWeekends'),
              checked: draft.skipWeekends,
              onChange: (checked) => {
                draft.skipWeekends = checked;
                renderPreview();
              },
            }).row,
          );
          return;
        case 'weekdays': {
          params.append(intervalRow('reminder.everyWeeks'));
          // Порядок флажков — с первого дня недели сети (требование 1b77decd).
          const start = firstDayOfWeek();
          const row = div('reminder-weekdays');
          for (let index = 0; index < 7; index += 1) {
            const day = ((start - 1 + index) % 7) + 1;
            const toggle = toggleButton({
              label: weekdayLabel(day),
              title: weekdayLabel(day, 'long'),
              pressed: draft.days.includes(day),
              extraClass: 'reminder-weekday',
              onChange: (pressed) => {
                draft.days = pressed
                  ? [...new Set([...draft.days, day])].sort((a, b) => a - b)
                  : draft.days.filter((value) => value !== day);
                renderPreview();
              },
            });
            row.append(toggle.root);
          }
          params.append(fieldRow({ label: t('reminder.weekdayField'), control: row }));
          return;
        }
        case 'day_of_month': {
          params.append(intervalRow('reminder.everyMonthsField'));
          // Число месяца по ТЗ: 1..30 плюс «последний день месяца»; сохранённое
          // значение больше 30 (строка из API) не теряется при правке.
          const values = Array.from({ length: REMINDER_DAY_LIMIT }, (_, index) => index + 1);
          if (draft.day > REMINDER_DAY_LIMIT) values.push(draft.day);
          const dayOptions = values.map((value) => ({
            value: String(value),
            label: String(value),
          }));
          dayOptions.push({ value: 'last', label: t('reminder.dayLast') });
          const daySelect = fieldSelect({
            options: dayOptions,
            value: draft.dayLast ? 'last' : String(draft.day),
            onChange: (value) => {
              draft.dayLast = value === 'last';
              if (!draft.dayLast) draft.day = Number(value);
              renderPreview();
            },
          });
          params.append(fieldRow({ label: t('reminder.dayField'), control: daySelect }));
          return;
        }
        case 'weekday_of_month': {
          params.append(intervalRow('reminder.everyMonthsField'));
          const nth = fieldSelect({
            options: [
              ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) })),
              { value: 'last', label: t('reminder.nthLast') },
            ],
            value: String(draft.nth),
            onChange: (value) => {
              draft.nth = value === 'last' ? 'last' : Number(value);
              renderPreview();
            },
          });
          const weekday = fieldSelect({
            options: Array.from({ length: 7 }, (_, index) => ({
              value: String(index + 1),
              label: weekdayLabel(index + 1, 'long'),
            })),
            value: String(draft.weekday),
            onChange: (value) => {
              draft.weekday = Number(value);
              renderPreview();
            },
          });
          params.append(
            fieldRow({ label: t('reminder.nthField'), control: nth }),
            fieldRow({ label: t('reminder.weekdayField'), control: weekday }),
          );
          return;
        }
        case 'yearly': {
          params.append(intervalRow('reminder.everyYears'));
          const months = Array.from({ length: 12 }, (_, index) => ({
            value: String(index + 1),
            label: new Intl.DateTimeFormat(getLang(), { month: 'long' }).format(
              new Date(2024, index, 1),
            ),
          }));
          const monthSelect = fieldSelect({
            options: months,
            value: String(draft.month),
            onChange: (value) => {
              draft.month = Number(value);
              // Дата, которой в новом месяце нет, съезжает к последнему дню.
              draft.day = Math.min(draft.day, daysInMonthOf(draft.month));
              renderParams();
              renderPreview();
            },
          });
          const dayOptions = Array.from({ length: daysInMonthOf(draft.month) }, (_, index) => ({
            value: String(index + 1),
            label: String(index + 1),
          }));
          const daySelect = fieldSelect({
            options: dayOptions,
            value: String(Math.min(draft.day, daysInMonthOf(draft.month))),
            onChange: (value) => {
              draft.day = Number(value);
              renderPreview();
            },
          });
          params.append(
            fieldRow({ label: t('reminder.monthField'), control: monthSelect }),
            fieldRow({ label: t('reminder.dayNumberField'), control: daySelect }),
          );
          return;
        }
      }
    }

    /** Полная пересборка зависимых полей: параметры команды + общее время. */
    function renderParams(): void {
      renderCommandParams();
      renderTime();
    }

    /** Подтянуть параметры за новой датой (день недели, число, месяц). */
    function syncDerivedFromDate(): void {
      const weekday = isoWeekdayOf(draft.date);
      const dayOfMonth = Number(draft.date.slice(8, 10));
      if (draft.command === 'weekdays' && draft.days.length === 1) draft.days = [weekday];
      if (draft.command === 'weekday_of_month') {
        draft.weekday = weekday;
        draft.nth = Math.min(5, Math.floor((dayOfMonth - 1) / 7) + 1);
      }
      if (draft.command === 'day_of_month' && !draft.dayLast) {
        draft.day = Math.min(dayOfMonth, REMINDER_DAY_LIMIT);
      }
      if (draft.command === 'yearly') {
        draft.month = Number(draft.date.slice(5, 7));
        draft.day = Math.min(dayOfMonth, daysInMonthOfDay(draft.date));
      }
    }

    /** Общее поле времени (ТЗ: ниже параметров, по умолчанию 09:00). */
    function renderTime(): void {
      anchorRow.replaceChildren();
      if (draft.command === 'not_remind') return;
      const timeInput = fieldInput({
        type: 'time',
        value: draft.time,
        ariaLabel: t('reminder.anchorTime'),
        onChange: (value) => {
          draft.time = value;
          renderPreview();
        },
      });
      anchorRow.append(fieldRow({ label: t('reminder.anchorTime'), control: timeInput }));
    }

    /** Пересчитать preview по текущему черновику (тот же вычислитель, что сервер). */
    function renderPreview(): void {
      preview.replaceChildren();
      const active = draft.command !== 'not_remind';
      previewTitle.hidden = !active;
      preview.hidden = !active;
      if (!active) return;
      const schedule = scheduleOf(draft);
      const anchorMs = localInstant(draft.date, draft.time);
      const normalized = normalizeAnchor(schedule, anchorMs);
      const from = Math.min(Date.now(), normalized);
      const occurrences = expandOccurrences(
        schedule,
        normalized,
        from,
        from + 366 * DAY_MS,
        new Map(),
      ).slice(0, PREVIEW_LIMIT);
      if (occurrences.length === 0) {
        preview.append(span(t('reminder.previewEmpty'), 'reminder-preview-empty'));
        return;
      }
      for (const occurrence of occurrences) {
        preview.append(
          el(
            'div',
            'reminder-preview-row',
            formatDateTime(occurrence.occurrence_at, { dateStyle: 'medium', timeStyle: 'short' }),
          ),
        );
      }
    }

    // Строка ошибки — только в панели кнопок (footerError, требование 397c5a56,
    // ошибка add8d09d): в тело диалога она не добавляется.
    const errorLine = footerErrorLine();

    renderParams();
    renderPreview();

    showDialog({
      title: existing === undefined ? t('reminder.createTitle') : t('reminder.editTitle'),
      body,
      size: 'm',
      fitContent: true,
      footerError: errorLine,
      buttons: [
        {
          label: t('reminder.cancel'),
          onClick: () => resolve(saved),
        },
        {
          label: t('reminder.save'),
          primary: true,
          keepOpen: true,
          onClick: (close) => {
            errorLine.clear();
            if (draft.command === 'not_remind') {
              // «Не напоминать» — снятие серии: строка удаляется (state=removed),
              // будущих показов не остаётся. У несуществующего команды нет.
              if (existing === undefined) {
                close();
                resolve(null);
                return;
              }
              void etn.reminders
                .remove(networkId, existing.id)
                .then(() => {
                  saved = null;
                  options.onRemoved?.();
                  close();
                  resolve(null);
                })
                .catch((err: unknown) => {
                  errorLine.show(t('reminder.saveFailed', [errText(err)]));
                });
              return;
            }
            const schedule = scheduleOf(draft);
            const kind = kindOfSchedule(schedule);
            const anchorAt = new Date(localInstant(draft.date, draft.time)).toISOString();
            const request =
              existing === undefined
                ? etn.reminders.create(networkId, {
                    subject_type: options.subjectType,
                    subject_id: options.subjectId,
                    kind,
                    schedule,
                    anchor_at: anchorAt,
                  })
                : etn.reminders.update(networkId, existing.id, {
                    kind,
                    schedule,
                    anchor_at: anchorAt,
                  });
            void request
              .then((reminder) => {
                saved = reminder;
                options.onSaved?.(reminder);
                close();
                resolve(reminder);
              })
              .catch((err: unknown) => {
                errorLine.show(t('reminder.saveFailed', [errText(err)]));
              });
          },
        },
      ],
    });
  });
}

/**
 * Тестовый шов: ЧИСТЫЕ части редактора (без диалога и DOM) — грамматика из
 * черновика, черновик из карточки, локальный инстанс опорного момента и
 * дефолт даты из свойства субъекта. Так проверки дефолтов и preview не
 * поднимают модальный диалог.
 */
export const reminderEditorInternals = {
  emptyDraft,
  draftOf,
  scheduleOf,
  commandOfSchedule,
  commandLabel,
  commands: REMINDER_COMMANDS,
  localInstant,
  isoWeekdayOf,
  daysInMonthOf,
  defaultDateFromSubject,
  previewLimit: PREVIEW_LIMIT,
  dayLimit: REMINDER_DAY_LIMIT,
};
