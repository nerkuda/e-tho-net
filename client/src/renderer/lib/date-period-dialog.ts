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
import {
  isValidLocalDay,
  setPeriodFrom,
  setPeriodTimeFrom,
  setPeriodTimeTo,
  setPeriodTo,
  todayLocal,
} from './dates.js';
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
 * Единое отображение периода ДНЕВНИКОВОЙ ЗАПИСИ по её полным UTC-инстансам —
 * одна точка правды для трёх мест: лента экрана «Дневник», колонка «Период»
 * вкладки-«Дневник» редактора и шапка записи (0.10.1, задача 8012a9b0). Время
 * показывается только при `useTime` (запись «учитывает время»): выключено —
 * видна лишь дата. Формат строки задаёт {@link formatDatePeriodValue}.
 */
export function formatRecordPeriod(
  fromInstant: string,
  toInstant: string | null,
  useTime: boolean,
): string {
  const to = toInstant ?? fromInstant;
  const withTime = useTime === true;
  const value = datePeriodValueFromInstants(fromInstant, to, withTime, withTime);
  // `datePeriodValueFromInstants` ставит режим «дата» по совпадению ДАТ, но
  // запись одного дня с разным временем границ — это период: показываем
  // «дата, ЧЧ:ММ - ЧЧ:ММ» (требование чек-листа 8012a9b0).
  if (withTime && value.from === value.to && value.fromTime !== value.toTime) {
    value.mode = 'period';
  }
  return formatDatePeriodValue(value);
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
 * Назначить «С»/«По» периода — реэкспорт общих чистых помощников
 * `lib/dates.ts` (одна точка правды с полями «Даты» панели).
 */
export { setPeriodFrom, setPeriodTo };

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
/** Класс поля даты нижней строки значения. */
export const DPD_DATE_CLASS = 'dpd-date';
/** Класс разделителя-дефиса между границами периода. */
export const DPD_SEP_CLASS = 'dpd-sep';

/**
 * Время по умолчанию, когда у значения времени нет: включение «С указанием
 * времени» подставляет осмысленное `10:00`, а не полночь (приёмка №6, п.1).
 */
export const DPD_DEFAULT_TIME = '10:00';

/**
 * Локальная дата `YYYY-MM-DD` корректна (существует в календаре). Реэкспорт
 * общего валидатора `lib/dates.ts` — историческая точка импорта сохранена.
 */
export { isValidLocalDay };

/** Время `HH:MM` корректно (00:00–23:59). */
export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

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
  // Время берём из значения только когда оно осмысленно (`hasTime`): иначе
  // включение «С указанием времени» подставляет DPD_DEFAULT_TIME, а не полночь.
  let fromTime = hasTime ? (initial.fromTime ?? DPD_DEFAULT_TIME) : DPD_DEFAULT_TIME;
  let toTime = hasTime ? (initial.toTime ?? fromTime) : fromTime;

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

  // Настоящая кнопка словаря (не ghost-надпись): роль `secondary` даёт
  // видимую рамку-кнопку, включённое состояние заливается акцентом
  // (`.ui-btn--secondary.ui-btn--active`, итерация приёмки №7).
  const timeToggle = uiButton({
    label: 'С указанием времени',
    role: 'secondary',
    size: 's',
    title: 'Показывать и учитывать время суток',
    class: DPD_TIME_TOGGLE_CLASS,
    onClick: () => {
      hasTime = !hasTime;
      if (hasTime) {
        // Осмысленное значение по умолчанию вместо полуночи (приёмка №6, п.1).
        if (fromTime === '00:00') fromTime = DPD_DEFAULT_TIME;
        if (toTime === '00:00') toTime = DPD_DEFAULT_TIME;
      }
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

  /** Структурная подпись нижней строки: режим + наличие времени. */
  let lineSignature = '';
  /** Поля нижней строки значения (пересоздаются при смене структуры). */
  let dateFromInput: HTMLInputElement | null = null;
  let dateToInput: HTMLInputElement | null = null;
  let timeFromInput: HTMLInputElement | null = null;
  let timeToInput: HTMLInputElement | null = null;

  function buildDateInput(which: 'from' | 'to', value: string): HTMLInputElement {
    const input = fieldInput({
      type: 'text',
      extraClass: DPD_DATE_CLASS,
      value,
      maxLength: 10,
      ariaLabel: which === 'from' ? 'Дата начала' : 'Дата окончания',
      title: 'Дата в формате ГГГГ-ММ-ДД',
      placeholder: 'ГГГГ-ММ-ДД',
      onChange: (raw) => applyDateInput(which, raw),
    });
    // Поле даты — редактируемый ввод `YYYY-MM-DD` (подсказка мобильной
    // клавиатуре и шаблон формата), а не текстовая надпись (приёмка №6, п.2).
    input.inputMode = 'numeric';
    input.setAttribute('pattern', '\\d{4}-\\d{2}-\\d{2}');
    return input;
  }

  /**
   * Применить введённое время границы с валидацией порядка (ошибка d4fbeaf7).
   * Валидация зеркалит даты ({@link setPeriodFrom}/{@link setPeriodTo}): при
   * ОДИНАКОВЫХ датах «С» и «По» время «По» не раньше «С» — ввод «время с» >
   * «время по» подтягивает «По» к «С» и наоборот. При разных датах период
   * охватывает больше суток, время границ свободно.
   */
  function applyTime(which: 'from' | 'to', time: string): void {
    if (mode === 'period' && from === to) {
      const next =
        which === 'from'
          ? setPeriodTimeFrom(fromTime, toTime, time)
          : setPeriodTimeTo(fromTime, toTime, time);
      fromTime = next.fromTime;
      toTime = next.toTime;
      return;
    }
    if (which === 'from') fromTime = time;
    else toTime = time;
  }

  function buildTimeInput(which: 'from' | 'to'): HTMLInputElement {
    return fieldInput({
      type: 'time',
      extraClass: DPD_TIME_CLASS,
      value: which === 'from' ? fromTime : toTime,
      ariaLabel: which === 'from' ? 'Время начала' : 'Время окончания',
      onChange: (raw) => {
        const time = raw.trim();
        if (!isValidTime(time)) {
          syncValueLineValues();
          return;
        }
        applyTime(which, time);
        repaint();
      },
    });
  }

  /** Ввод в поле даты: валидация формата, автоподгон «По» ≥ «С» (`setPeriod*`). */
  function applyDateInput(which: 'from' | 'to', raw: string): void {
    const day = raw.trim();
    if (!isValidLocalDay(day)) {
      syncValueLineValues();
      return;
    }
    if (mode === 'date') {
      from = day;
      to = day;
    } else if (which === 'from') {
      const next = setPeriodFrom(from, to, day);
      from = next.from;
      to = next.to;
    } else {
      const next = setPeriodTo(from, to, day);
      from = next.from;
      to = next.to;
    }
    syncCalendar();
  }

  /** Пересобрать нижнюю строку под текущую структуру (режим + время). */
  function rebuildValueLine(): void {
    valueLine.replaceChildren();
    dateFromInput = buildDateInput('from', from);
    dateToInput = null;
    timeFromInput = null;
    timeToInput = null;
    valueLine.append(dateFromInput);
    if (hasTime) {
      timeFromInput = buildTimeInput('from');
      valueLine.append(timeFromInput);
    }
    if (mode === 'period') {
      valueLine.append(span('-', DPD_SEP_CLASS));
      dateToInput = buildDateInput('to', to);
      valueLine.append(dateToInput);
      if (hasTime) {
        timeToInput = buildTimeInput('to');
        valueLine.append(timeToInput);
      }
    }
  }

  /** Обновить значения полей без пересборки (сохраняет фокус при вводе). */
  function syncValueLineValues(): void {
    if (dateFromInput !== null) dateFromInput.value = from;
    if (dateToInput !== null) dateToInput.value = to;
    if (timeFromInput !== null) timeFromInput.value = fromTime;
    if (timeToInput !== null) timeToInput.value = toTime;
  }

  /** Перерисовать всё, кроме сетки календаря (она держит своё состояние). */
  function repaint(): void {
    extras.replaceChildren();
    extras.hidden = !allowTime;
    if (allowTime) {
      setButtonActive(timeToggle, hasTime);
      extras.append(timeToggle);
    }
    const signature = `${mode}|${hasTime ? 'time' : 'notime'}`;
    if (signature !== lineSignature) {
      lineSignature = signature;
      rebuildValueLine();
    } else {
      syncValueLineValues();
    }
    valueLine.title = formatDatePeriodDialogValue({
      mode,
      from,
      to,
      hasTime,
      fromTime,
      toTime,
    });
  }

  /**
   * Считать «живые» значения полей нижней строки (0.10.1, итерация приёмки №8,
   * п.1). `getValue()` не доверяет кэшу состояния: пользователь мог ввести
   * время (или дату) и сразу нажать «ОК», не сместив фокус — событие `change`
   * тогда ещё не отработало, а введённое значение обязано попасть в результат.
   * Принимаются только валидные значения (та же валидация, что у обработчиков
   * `change`); невалидное игнорируется и остаётся прежнее состояние.
   */
  function commitLiveInputs(): void {
    if (dateFromInput !== null) {
      const day = dateFromInput.value.trim();
      if (isValidLocalDay(day)) {
        from = day;
        if (mode === 'date') to = day;
      }
    }
    if (dateToInput !== null) {
      const day = dateToInput.value.trim();
      if (isValidLocalDay(day)) to = day;
    }
    // Даты уже сведены выше, поэтому порядок времени проверяется по итоговым
    // датам (ошибка d4fbeaf7): при одинаковых датах «По» не раньше «С».
    if (timeFromInput !== null) {
      const time = timeFromInput.value.trim();
      if (isValidTime(time)) applyTime('from', time);
    }
    if (timeToInput !== null) {
      const time = timeToInput.value.trim();
      if (isValidTime(time)) applyTime('to', time);
    }
  }

  repaint();

  return {
    root,
    getMode: () => mode,
    getValue: () => {
      commitLiveInputs();
      return {
        mode,
        from,
        to: mode === 'date' ? from : to,
        hasTime,
        fromTime,
        toTime,
      };
    },
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
      // Роль `s` — нижняя граница ширины (хватает сетке Пн–Вс на 7 колонок);
      // `fitContent` снимает потолок высоты и прокрутку тела, чтобы календарь
      // (до 6 недель), переключатель, время, значение и футер были видны
      // одновременно (ошибка 214ab5da).
      size: 's',
      fitContent: true,
      body: dialog.root,
      buttons: [
        { label: 'Отмена', onClick: () => finish(null) },
        { label: 'ОК', primary: true, confirm: true, onClick: () => finish(dialog.getValue()) },
      ],
      onClose: () => finish(null),
    });
  });
}
