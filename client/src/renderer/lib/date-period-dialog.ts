/**
 * «Диалог ввода даты/периода» — библиотечный компонент (0.10.1, приёмка №5,
 * задача 7ce662c4; элемент интерфейса «Диалог ввода даты/периода»).
 *
 * Один компонент на три места: карточка записи ленты «Дневника» (период, время
 * по флагу «учитывать время»), вкладка «Дневник» редактора (период, время при
 * включённом флаге) и поля «Даты» панели отбора (без времени, с периодом).
 *
 * **Что отдаёт.** ЛОКАЛЬНЫЕ значения наблюдателя: календарные даты `YYYY-MM-DD`
 * и время `HH:MM`. Никаких UTC-инстансов и сети — конверсию делает вызывающий
 * (`resolveDatePeriodInstants` ниже либо `resolvePeriodInstants` для «голых»
 * дат). Так API/MCP остаются на UTC-сутках, а пояс принадлежности считает
 * клиент (ADR 994d076a, требование d58aa1a4).
 *
 * **Календарь** — общий `lib/month-calendar.ts` (навигация «<»/«○»/«>», список
 * месяцев, смена года, перетаскивание диапазона); модальность — общий
 * `lib/dialog.ts` (`showDialog`); переключатель режима — `lib/ui/segmented.ts`;
 * поля времени — `lib/ui/field.ts`. Своих календарей/диалогов/полей не пишем
 * (стандарт библиотечности a2488f05; сторожи `guard-period-editor`,
 * `guard-ui-dialog`, `guard-ui-fields`).
 */

import { div, span } from './dom.js';
import {
  composeInstant,
  instantToLocalDate,
  instantToLocalTime,
  setInstantDate,
  setInstantTime,
} from './period-editor.js';
import { showDialog } from './dialog.js';
import { buildMonthCalendar } from './month-calendar.js';
import { todayLocal } from './dates.js';
import { fieldInput } from './ui/field.js';
import { segmentedControl } from './ui/segmented.js';
import { setButtonActive, uiButton } from './ui/button.js';

/** Режим значения: одна дата или период. */
export type DatePeriodMode = 'date' | 'period';

/** Локальное значение даты/периода (даты и время наблюдателя). */
export interface DatePeriodValue {
  /** `date` — одна дата, `period` — диапазон. */
  mode: DatePeriodMode;
  /** Начало (или единственная дата) `YYYY-MM-DD`. */
  from: string;
  /** Конец периода `YYYY-MM-DD`; в режиме `date` равен `from`. */
  to: string;
  /** Учитывать ли время суток (только при `allowTime`). */
  hasTime: boolean;
  /** Время начала `HH:MM` (осмысленно при `hasTime`). */
  fromTime: string;
  /** Время конца `HH:MM` (осмысленно при `hasTime` в режиме `period`). */
  toTime: string;
}

/** Опции диалога/значения. */
export interface DatePeriodDialogOptions {
  /** Разрешить режим «Период» (по умолчанию — да). */
  allowPeriod?: boolean;
  /** Разрешить время (по умолчанию — нет). */
  allowTime?: boolean;
  /** Начальное значение. */
  initial?: Partial<DatePeriodValue>;
  /** Заголовок диалога (по умолчанию «Дата/период»). */
  title?: string;
}

/** Рукоятка собранного диалога (для тестов и встраивания). */
export interface DatePeriodDialogHandle {
  root: HTMLElement;
  /** Текущее локальное значение. */
  getValue(): DatePeriodValue;
  /** Текущий режим. */
  getMode(): DatePeriodMode;
}

// ---------------------------------------------------------------------------
// Чистые помощники (значение и его отображение)
// ---------------------------------------------------------------------------

/** Начальное значение из полных UTC-инстансов записи (даты/время наблюдателя). */
export function datePeriodValueFromInstants(
  fromInstant: string,
  toInstant: string,
  hasTime: boolean,
  allowTime = hasTime,
): DatePeriodValue {
  const from = instantToLocalDate(fromInstant) || todayLocal();
  const to = instantToLocalDate(toInstant) || from;
  const withTime = allowTime && hasTime;
  const fromTime = instantToLocalTime(fromInstant) || '00:00';
  const toTime = instantToLocalTime(toInstant) || fromTime;
  return {
    mode: from === to ? 'date' : 'period',
    from,
    to,
    hasTime: withTime,
    fromTime,
    toTime,
  };
}

/**
 * Отображение значения вне диалога (рендерер — часть компонента):
 *  * одиночная дата — `2026-09-26`;
 *  * дата со временем — `2026-09-26 10:00`;
 *  * период одной датой и разным временем — `2026-09-26, 10:00 - 10:15`;
 *  * период с разными датами — `2026-09-29 - 2026-10-12`, при времени —
 *    `2026-09-29 10:00 - 2026-10-12 12:00`.
 */
export function formatDatePeriodValue(value: DatePeriodValue): string {
  const to = value.to || value.from;
  const withTime = value.hasTime;
  if (value.mode === 'date') {
    return withTime ? `${value.from} ${value.fromTime}` : value.from;
  }
  if (value.from === to) {
    return withTime ? `${value.from}, ${value.fromTime} - ${value.toTime}` : value.from;
  }
  return withTime
    ? `${value.from} ${value.fromTime} - ${to} ${value.toTime}`
    : `${value.from} - ${to}`;
}

/**
 * Строка значения ВНИЗУ диалога: у периода одна дата повторяется у обеих границ
 * (`2026-09-26 10:00 - 2026-09-26 10:00`), две даты — `2026-09-26 - 2026-09-27`.
 */
export function formatDatePeriodDialogValue(value: DatePeriodValue): string {
  const to = value.to || value.from;
  const fromText = value.hasTime ? `${value.from} ${value.fromTime}` : value.from;
  if (value.mode === 'date') return fromText;
  const toText = value.hasTime ? `${to} ${value.toTime}` : to;
  return `${fromText} - ${toText}`;
}

/**
 * Назначить «С» периода: при «С» > «По» конец автоматически становится равен
 * началу (валидация диалога — «По» не меньше «С»).
 */
export function setPeriodFrom(
  from: string,
  to: string,
  day: string,
): { from: string; to: string } {
  return { from: day, to: to < day ? day : to };
}

/**
 * Назначить «По» периода: при «По» < «С» начало автоматически становится равно
 * концу (валидация диалога).
 */
export function setPeriodTo(
  from: string,
  to: string,
  day: string,
): { from: string; to: string } {
  return { from: day < from ? day : from, to: day };
}

/** Одна граница значения → полный UTC-инстанс (сохраняя секунды исходного). */
function applyBound(base: string, day: string, time: string | null): string {
  if (day.trim() === '') return base;
  const plain = instantToLocalDate(base);
  let out =
    plain === '' ? composeInstant(day, time ?? '00:00') : setInstantDate(base, day);
  if (out === '') out = composeInstant(day, time ?? '00:00');
  if (time !== null && out !== '') out = setInstantTime(out, time);
  return out;
}

/**
 * Значение диалога → полные UTC-инстансы записи. Дата меняет только дату,
 * сохраняя секунды/миллисекунды исходного инстанса (ADR 994d076a); при
 * `hasTime` время суток выставляется полем диалога. В режиме «Дата» конец равен
 * началу, поэтому `valid_to` непуст (требование d58aa1a4).
 *
 * @param value    локальное значение из `getValue()`/`onChange`.
 * @param previous прежние инстансы записи — источник секунд/мс и запасное время.
 */
export function resolveDatePeriodInstants(
  value: DatePeriodValue,
  previous: { from: string; to: string },
): { from: string; to: string } {
  const from = applyBound(previous.from, value.from, value.hasTime ? value.fromTime : null);
  const to =
    value.mode === 'date'
      ? from
      : applyBound(previous.to, value.to, value.hasTime ? value.toTime : null);
  const nextFrom = from !== '' ? from : previous.from;
  return { from: nextFrom, to: to !== '' ? to : nextFrom };
}

// ---------------------------------------------------------------------------
// Сборка диалога
// ---------------------------------------------------------------------------

/** Класс корня содержимого диалога. */
export const DPD_CLASS = 'dpd';
/** Класс строки значения внизу. */
export const DPD_VALUE_CLASS = 'dpd-value';
/** Класс кнопки «С указанием времени». */
export const DPD_TIME_TOGGLE_CLASS = 'dpd-time-toggle';
/** Класс поля времени. */
export const DPD_TIME_CLASS = 'dpd-time';
/** Класс контейнера полей времени. */
export const DPD_TIMES_CLASS = 'dpd-times';

/**
 * Собирает содержимое диалога (календарь, переключатель режима, время, значение)
 * без модальной оболочки. Возвращает рукоятку с текущим локальным значением —
 * отделено от `showDialog` ради юнит-тестов на DOM-шиме.
 */
export function buildDatePeriodDialog(opts: DatePeriodDialogOptions = {}): DatePeriodDialogHandle {
  const allowPeriod = opts.allowPeriod !== false;
  const allowTime = opts.allowTime === true;

  const initial = opts.initial ?? {};
  let mode: DatePeriodMode = allowPeriod ? (initial.mode ?? 'date') : 'date';
  const today = todayLocal();
  let from = initial.from ?? today;
  let to = allowPeriod ? (initial.to ?? from) : from;
  let hasTime = allowTime && initial.hasTime === true;
  let fromTime = initial.fromTime ?? '00:00';
  let toTime = initial.toTime ?? fromTime;

  const root = div(DPD_CLASS);

  const modes = allowPeriod
    ? segmentedControl({
        items: [
          { id: 'date', label: 'Дата' },
          { id: 'period', label: 'Период' },
        ],
        activeId: mode,
        ariaLabel: 'Режим даты или периода',
        size: 's',
        onChange: (id) => {
          mode = id === 'period' ? 'period' : 'date';
          if (mode === 'date') {
            to = from;
          } else if (to < from) {
            to = from;
          }
          syncCalendar();
        },
      })
    : null;

  const calendar = buildMonthCalendar({
    from,
    to,
    today,
    weekNumbers: false,
    enableRangeDrag: allowPeriod,
    onPickDay: (day) => {
      if (mode === 'date') {
        from = day;
        to = day;
      } else {
        const next = setPeriodFrom(from, to, day);
        from = next.from;
        to = next.to;
      }
      syncCalendar();
    },
    onRangeChange: (nextFrom, nextTo) => {
      const start = setPeriodFrom(from, to, nextFrom);
      const end = setPeriodTo(start.from, start.to, nextTo);
      from = end.from;
      to = end.to;
      if (allowPeriod) {
        mode = 'period';
        modes?.setActive('period');
      }
      syncCalendar();
    },
    onToday: () => {
      from = today;
      to = today;
      syncCalendar();
    },
  });

  const extras = div('dpd-extras');

  const timeToggle = uiButton({
    label: 'С указанием времени',
    role: 'ghost',
    size: 's',
    class: DPD_TIME_TOGGLE_CLASS,
    onClick: () => {
      hasTime = !hasTime;
      repaint();
    },
  });

  const valueLine = div(DPD_VALUE_CLASS);

  if (modes !== null) root.append(modes.root);
  root.append(calendar.root, extras, valueLine);

  function syncCalendar(): void {
    calendar.setSelection(from, to);
    repaint();
  }

  function buildTimeInput(which: 'from' | 'to'): HTMLElement {
    const input = fieldInput({
      type: 'time',
      extraClass: DPD_TIME_CLASS,
      value: which === 'from' ? fromTime : toTime,
      ariaLabel: which === 'from' ? 'Время начала' : 'Время окончания',
    });
    input.addEventListener('change', () => {
      if (which === 'from') fromTime = input.value || fromTime;
      else toTime = input.value || toTime;
      repaint();
    });
    return input;
  }

  /** Перерисовать всё, кроме сетки календаря (она держит своё состояние). */
  function repaint(): void {
    extras.replaceChildren();
    if (allowTime) {
      setButtonActive(timeToggle, hasTime);
      extras.append(timeToggle);
      if (hasTime) {
        const times = div(DPD_TIMES_CLASS);
        times.append(
          span('с', 'dpd-time-tag'),
          buildTimeInput('from'),
          ...(mode === 'period'
            ? [span('по', 'dpd-time-tag'), buildTimeInput('to')]
            : []),
        );
        extras.append(times);
      }
    }
    valueLine.textContent = formatDatePeriodDialogValue({
      mode,
      from,
      to,
      hasTime,
      fromTime,
      toTime,
    });
  }

  repaint();

  return {
    root,
    getMode: () => mode,
    getValue: () => ({
      mode,
      from,
      to: mode === 'date' ? from : to,
      hasTime,
      fromTime,
      toTime,
    }),
  };
}

/**
 * Открывает модальный диалог «Дата/период». `ОК` резолвит локальное значение,
 * `Esc`/`Отмена`/крестик — `null`.
 */
export function openDatePeriodDialog(
  opts: DatePeriodDialogOptions = {},
): Promise<DatePeriodValue | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: DatePeriodValue | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const dialog = buildDatePeriodDialog(opts);
    showDialog({
      title: opts.title ?? 'Дата/период',
      size: 's',
      body: dialog.root,
      buttons: [
        { label: 'Отмена', onClick: () => finish(null) },
        { label: 'ОК', primary: true, confirm: true, onClick: () => finish(dialog.getValue()) },
      ],
      onClose: () => finish(null),
    });
  });
}
