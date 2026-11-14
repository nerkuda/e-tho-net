/**
 * Редактор напоминания — kind, грамматика повтора, опорная дата и preview
 * (0.16.1, задача 173f1540; элемент интерфейса 58cca4f7, грамматика bbca8f7d,
 * операции ae19b1bf/500d1b3d).
 *
 * Один диалог на создание и правку расписания: субъект фиксирован (мысль или
 * публикация, из карточки которой редактор открыт), меняются только вид,
 * грамматика и опорное вхождение. «Отложить»/«Убрать» — НЕ здесь: они пишут
 * исключения и живут в меню флага/панели (требование 86cb7451).
 *
 * Дефолты (элемент 58cca4f7): опорная дата — из первого датового свойства
 * субъекта, иначе сегодня; день недели, число и месяц параметров повтора — из
 * опорной даты, чтобы «каждую среду» не приходилось выбирать вручную.
 *
 * Preview считает ТОТ ЖЕ вычислитель, что сервер: `expandOccurrences` из
 * `@etn/shared` (одна реализация грамматики — preview и `GET /reminders` не
 * расходятся). Время суток вхождений наследуется от опорного момента.
 *
 * Контролы — только фасады коллекции: `lib/dialog.ts` (каркас), `lib/date-field.ts`
 * (дата), `lib/ui/field.ts` (числа/выбор), `lib/ui/segmented.ts` (вид).
 */

import {
  expandOccurrences,
  kindOfSchedule,
  normalizeAnchor,
  type Reminder,
  type ReminderKind,
  type ReminderSchedule,
  type ReminderScheduleType,
  type ReminderSubjectType,
} from '@etn/shared';

import { store } from '../state.js';
import { dateField } from './date-field.js';
import { showDialog } from './dialog.js';
import { div, el, errText, span } from './dom.js';
import { etn } from './etn.js';
import { formatDateTime, t } from './i18n.js';
import { weekdayLabel } from './reminder-label.js';
import { fieldInput, fieldRow, fieldSelect } from './ui/field.js';
import { footerErrorLine } from './ui/messages.js';
import { segmentedControl } from './ui/segmented.js';
import { toggleButton } from './ui/toggle.js';

/** Класс корня тела редактора (DOM-пробы и сторож). */
export const REMINDER_EDITOR_CLASS = 'reminder-editor';
/** Класс списка preview. */
export const REMINDER_PREVIEW_CLASS = 'reminder-preview';

/** Миллисекунд в сутках — окно preview. */
const DAY_MS = 86_400_000;
/** Сколько первых вхождений показывает preview. */
const PREVIEW_LIMIT = 3;

/** Черновик формы: всё, что пользователь выбрал (живёт вне DOM).
 *  Экспортирован ради юнит-проверок чистых частей редактора. */
export interface ReminderDraft {
  kind: ReminderKind;
  type: ReminderScheduleType;
  /** Опорная дата `YYYY-MM-DD` (локальная). */
  date: string;
  /** Опорное время `HH:MM` (локальное). */
  time: string;
  days: number[];
  every: number;
  day: number;
  everyMonths: number;
  weekday: number;
  nth: number | 'last';
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

/** Типы повтора, допустимые для крупного вида (требование bbca8f7d). */
const TYPES_BY_KIND: Record<ReminderKind, ReminderScheduleType[]> = {
  one: ['once'],
  period: ['every_days', 'day_of_month', 'last_day_of_month'],
  rule: ['weekdays', 'weekday_of_month', 'yearly'],
};

/** Подпись типа повтора. */
function typeLabel(type: ReminderScheduleType): string {
  switch (type) {
    case 'once':
      return t('reminder.kindOne');
    case 'weekdays':
      return t('reminder.typeWeekdays');
    case 'every_days':
      return t('reminder.typeEveryDays');
    case 'weekday_of_month':
      return t('reminder.typeWeekdayOfMonth');
    case 'day_of_month':
      return t('reminder.typeDayOfMonth');
    case 'yearly':
      return t('reminder.typeYearly');
    case 'last_day_of_month':
      return t('reminder.typeLastDayOfMonth');
  }
}

/** Расписание из черновика (закрытая грамматика; числа нормализуются внизу). */
function scheduleOf(draft: ReminderDraft): ReminderSchedule {
  switch (draft.type) {
    case 'once':
      return { type: 'once' };
    case 'weekdays':
      return {
        type: 'weekdays',
        days: draft.days.length > 0 ? draft.days : [isoWeekdayOf(draft.date)],
      };
    case 'every_days':
      return { type: 'every_days', every: Math.max(1, draft.every) };
    case 'weekday_of_month':
      return { type: 'weekday_of_month', weekday: draft.weekday, nth: draft.nth };
    case 'day_of_month':
      return {
        type: 'day_of_month',
        day: Math.min(31, Math.max(1, draft.day)),
        every_months: Math.max(1, draft.everyMonths),
      };
    case 'yearly': {
      const [, month, day] = draft.date.split('-').map(Number) as [number, number, number];
      return { type: 'yearly', month, day };
    }
    case 'last_day_of_month':
      return { type: 'last_day_of_month', every_months: Math.max(1, draft.everyMonths) };
  }
}

/** Черновик по существующему напоминанию (правка расписания). */
function draftOf(reminder: Reminder): ReminderDraft {
  const anchor = new Date(reminder.anchor_at);
  const base: ReminderDraft = {
    kind: reminder.kind,
    type: reminder.schedule.type,
    date: localDay(anchor),
    time: localTime(anchor),
    days: [],
    every: 1,
    day: anchor.getDate(),
    everyMonths: 1,
    weekday: isoWeekdayOf(localDay(anchor)),
    nth: Math.min(5, Math.floor((anchor.getDate() - 1) / 7) + 1),
  };
  const schedule = reminder.schedule;
  switch (schedule.type) {
    case 'weekdays':
      return { ...base, days: [...schedule.days] };
    case 'every_days':
      return { ...base, every: schedule.every };
    case 'weekday_of_month':
      return { ...base, weekday: schedule.weekday, nth: schedule.nth };
    case 'day_of_month':
      return {
        ...base,
        day: schedule.day,
        everyMonths: schedule.every_months,
      };
    case 'last_day_of_month':
      return { ...base, everyMonths: schedule.every_months };
    default:
      return base;
  }
}

/** Начальный черновик нового напоминания. */
function emptyDraft(kind: ReminderKind = 'one'): ReminderDraft {
  const now = new Date();
  const day = localDay(now);
  return {
    kind,
    type: TYPES_BY_KIND[kind][0]!,
    date: day,
    time: '09:00',
    days: [isoWeekdayOf(day)],
    every: 1,
    day: now.getDate(),
    everyMonths: 1,
    weekday: isoWeekdayOf(day),
    nth: Math.min(5, Math.floor((now.getDate() - 1) / 7) + 1),
  };
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
 * Открыть редактор напоминания. Возвращает `null` при отказе (закрытие), иначе
 * сохранённое напоминание (созданное или изменённое).
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
        day: Number(date.slice(8, 10)),
        weekday: isoWeekdayOf(date),
        nth: Math.min(5, Math.floor((Number(date.slice(8, 10)) - 1) / 7) + 1),
      };
    }
  }

  return new Promise<Reminder | null>((resolve) => {
    let saved: Reminder | null = null;

    const body = div(REMINDER_EDITOR_CLASS);
    const kindControl = segmentedControl({
      items: [
        { id: 'one', label: t('reminder.kindOne') },
        { id: 'period', label: t('reminder.kindPeriod') },
        { id: 'rule', label: t('reminder.kindRule') },
      ],
      activeId: draft.kind,
      ariaLabel: t('reminder.kind'),
      onChange: (id) => {
        draft.kind = id as ReminderKind;
        draft.type = TYPES_BY_KIND[draft.kind][0]!;
        renderParams();
        renderPreview();
      },
    });
    body.append(fieldRow({ label: t('reminder.kind'), control: kindControl.root }));

    const typeSelect = fieldSelect({
      options: TYPES_BY_KIND[draft.kind].map((type) => ({ value: type, label: typeLabel(type) })),
      value: draft.type,
      onChange: (value) => {
        draft.type = value as ReminderScheduleType;
        renderParams();
        renderPreview();
      },
    });
    const typeRow = fieldRow({ label: t('reminder.repeat'), control: typeSelect });
    body.append(typeRow);

    const dateControl = dateField({
      value: draft.date,
      ariaLabel: t('reminder.anchorDate'),
      onChange: (value) => {
        draft.date = value === '' ? localDay(new Date()) : value;
        const weekday = isoWeekdayOf(draft.date);
        const dayOfMonth = Number(draft.date.slice(8, 10));
        // Дефолты параметров следуют за опорной датой (элемент 58cca4f7).
        if (draft.type === 'weekdays' && draft.days.length === 1) draft.days = [weekday];
        if (draft.type === 'weekday_of_month') {
          draft.weekday = weekday;
          draft.nth = Math.min(5, Math.floor((dayOfMonth - 1) / 7) + 1);
        }
        if (draft.type === 'day_of_month') draft.day = dayOfMonth;
        renderParams();
        renderPreview();
      },
    });
    const timeInput = fieldInput({
      type: 'time',
      value: draft.time,
      ariaLabel: t('reminder.anchorTime'),
      onChange: (value) => {
        draft.time = value;
        renderPreview();
      },
    });
    const anchorRow = div('reminder-anchor-row');
    anchorRow.append(
      fieldRow({ label: t('reminder.anchorDate'), control: dateControl.root }),
      fieldRow({ label: t('reminder.anchorTime'), control: timeInput }),
    );
    body.append(anchorRow);

    const params = div('reminder-params');
    const preview = div(REMINDER_PREVIEW_CLASS);
    const previewTitle = span(t('reminder.preview'), 'reminder-preview-title');
    body.append(params, previewTitle, preview);

    /** Пересобрать поля параметров под выбранный тип повтора. */
    function renderParams(): void {
      params.replaceChildren();
      typeSelect.replaceChildren(
        ...TYPES_BY_KIND[draft.kind].map((type) => {
          const option = document.createElement('option');
          option.value = type;
          option.textContent = typeLabel(type);
          return option;
        }),
      );
      typeSelect.value = draft.type;
      switch (draft.type) {
        case 'once':
          return;
        case 'weekdays': {
          const row = div('reminder-weekdays');
          for (let day = 1; day <= 7; day += 1) {
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
        case 'every_days': {
          const input = fieldInput({
            type: 'number',
            value: String(draft.every),
            onChange: (value) => {
              draft.every = Math.max(1, Number(value) || 1);
              renderPreview();
            },
          });
          params.append(fieldRow({ label: t('reminder.everyDays'), control: input }));
          return;
        }
        case 'weekday_of_month': {
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
          params.append(
            fieldRow({ label: t('reminder.weekdayField'), control: weekday }),
            fieldRow({ label: t('reminder.nthField'), control: nth }),
          );
          return;
        }
        case 'day_of_month': {
          const day = fieldInput({
            type: 'number',
            value: String(draft.day),
            onChange: (value) => {
              draft.day = Math.min(31, Math.max(1, Number(value) || 1));
              renderPreview();
            },
          });
          const every = fieldInput({
            type: 'number',
            value: String(draft.everyMonths),
            onChange: (value) => {
              draft.everyMonths = Math.max(1, Number(value) || 1);
              renderPreview();
            },
          });
          params.append(
            fieldRow({ label: t('reminder.dayField'), control: day }),
            fieldRow({ label: t('reminder.everyMonthsField'), control: every }),
          );
          return;
        }
        case 'yearly':
          return;
        case 'last_day_of_month': {
          const every = fieldInput({
            type: 'number',
            value: String(draft.everyMonths),
            onChange: (value) => {
              draft.everyMonths = Math.max(1, Number(value) || 1);
              renderPreview();
            },
          });
          params.append(fieldRow({ label: t('reminder.everyMonthsField'), control: every }));
          return;
        }
      }
    }

    /** Пересчитать preview по текущему черновику (тот же вычислитель, что сервер). */
    function renderPreview(): void {
      preview.replaceChildren();
      if (draft.date === '') {
        preview.append(span(t('reminder.previewEmpty'), 'reminder-preview-empty'));
        return;
      }
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
            const schedule = scheduleOf(draft);
            const kind = kindOfSchedule(schedule);
            const anchorAt = new Date(localInstant(draft.date, draft.time)).toISOString();
            errorLine.clear();
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
  localInstant,
  isoWeekdayOf,
  defaultDateFromSubject,
  typesByKind: TYPES_BY_KIND,
};
