/**
 * «Календарь месяца» — общий библиотечный компонент (0.10.1, приёмка №5,
 * задача 7ce662c4; элемент интерфейса 55b07702 «Календарь месяца в «Дневнике»»).
 *
 * Один календарь на два применения: панель отбора «Дневника» (выбор дня или
 * недели = «Применить» с периодом) и диалог «Дата/период»
 * (`lib/date-period-dialog.ts` — выбор дня, перетаскивание диапазона). Двух
 * разных календарей в коде быть не должно.
 *
 * **Навигация.** Строка заголовка: месяц — отдельная кликабельная кнопка
 * (открывает список январь–декабрь без года), год — отдельная кнопка (клик
 * позволяет ввести год), справа в той же строке кнопки «<» (месяц назад),
 * «○» (сегодня), «>» (месяц вперёд). Дни соседних месяцев приглушены.
 *
 * **Что компонент НЕ делает.** Он не применяет период и не трогает данные: клик
 * по дню/неделе лишь сообщает хозяину выбранное (`onPickDay`/`onPickWeek`),
 * перетаскивание диапазона — через `onRangeChange`. Инвариант панели «поля
 * периода — единственный источник дат» остаётся на экране.
 *
 * Чистая сетка месяца ({@link buildMonthWeeks}) и примитивы дат — `lib/dates.ts`
 * (перенесены из `screens/chronicle/diary.ts`, чтобы библиотека не зависела от
 * экрана). DOM собирается на общем словаре кнопок (`lib/ui/button.ts`), свои
 * кнопки не пишутся (сторож `guard-ui-buttons`).
 */

import { div, el, span } from './dom.js';
import { buildMonthWeeks, firstOfMonth, todayLocal, type CalendarWeek } from './dates.js';
import { uiButton } from './ui/button.js';
import { fieldInput } from './ui/field.js';

export { buildMonthWeeks } from './dates.js';
export type { CalendarCell, CalendarWeek } from './dates.js';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
/** Полные названия месяцев для списка выбора (январь–декабрь). */
const MONTHS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];
/** Короткие подписи месяца в заголовке («сен 2026»). */
const MONTHS_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'май',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];

/** Границы вводимого года. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

/** Опции сборки календаря месяца. */
export interface MonthCalendarOptions {
  /** Начало выделенного периода (пусто — нет). */
  from?: string;
  /** Конец выделенного периода (пусто — нет). */
  to?: string;
  /** Сегодняшний локальный день (подсветка). */
  today?: string;
  /** Сколько записей попало в день (0 — счётчик не рисуется). */
  counts?: (day: string) => number;
  /** Клик по дню. */
  onPickDay?: (day: string) => void;
  /** Клик по строке недели (аргумент — понедельник недели). */
  onPickWeek?: (monday: string) => void;
  /** Перетаскивание диапазона: `from`/`to` — упорядоченные локальные даты. */
  onRangeChange?: (from: string, to: string) => void;
  /** Кнопка «○» (сегодня): перейти к текущей дате. */
  onToday?: () => void;
  /** Первоначально показанный месяц (по умолчанию — из `today`/сегодня). */
  month?: { year: number; month: number };
  /** Смена показанного месяца (стрелки/список месяцев/смена года). */
  onMonthChange?: (year: number, month: number) => void;
  /** Показывать колонку номеров недель (панель — да, диалог — нет). */
  weekNumbers?: boolean;
  /** Разрешить выбор диапазона перетаскиванием (диалог — да). */
  enableRangeDrag?: boolean;
}

/** Рукоятка календаря. */
export interface MonthCalendarHandle {
  root: HTMLElement;
  /** Перерисовать выделение периода извне. */
  setSelection(from: string, to: string): void;
  /** Показать месяц по дате `YYYY-MM-DD`. */
  showDate(day: string): void;
  /** Показанный месяц. */
  getMonth(): { year: number; month: number };
}

/** Наименьшая из двух дат. */
function minDay(a: string, b: string): string {
  return a <= b ? a : b;
}

/** Наибольшая из двух дат. */
function maxDay(a: string, b: string): string {
  return a >= b ? a : b;
}

/** Строит календарь месяца. */
export function buildMonthCalendar(opts: MonthCalendarOptions): MonthCalendarHandle {
  const weekNumbers = opts.weekNumbers !== false;
  const dragEnabled = opts.enableRangeDrag === true;

  const root = div('cal');
  if (!weekNumbers) root.classList.add('cal--no-weeks');

  const head = div('cal-head');
  const monthBtn = uiButton({
    label: '',
    role: 'ghost',
    size: 's',
    title: 'Выбрать месяц',
    class: 'cal-month',
    onClick: () => toggleMonthList(),
  });
  const yearBtn = uiButton({
    label: '',
    role: 'ghost',
    size: 's',
    title: 'Изменить год',
    class: 'cal-year',
    onClick: () => openYearInput(),
  });
  const spacer = div('cal-head-spacer');
  const prevBtn = uiButton({
    label: '‹',
    role: 'ghost',
    size: 's',
    title: 'Предыдущий месяц',
    class: 'cal-nav cal-prev',
    onClick: () => shiftMonth(-1),
  });
  const todayBtn = uiButton({
    label: '○',
    role: 'ghost',
    size: 's',
    title: 'Перейти к текущей дате',
    class: 'cal-today',
    onClick: () => goToday(),
  });
  const nextBtn = uiButton({
    label: '›',
    role: 'ghost',
    size: 's',
    title: 'Следующий месяц',
    class: 'cal-nav cal-next',
    onClick: () => shiftMonth(1),
  });
  head.append(monthBtn, yearBtn, spacer, prevBtn, todayBtn, nextBtn);

  const monthList = div('cal-months');
  monthList.hidden = true;
  const grid = div('cal-grid');

  for (let i = 0; i < 12; i++) {
    const index = i;
    monthList.append(
      uiButton({
        label: MONTHS[i]!,
        role: 'ghost',
        size: 's',
        class: 'cal-month-item',
        onClick: () => pickMonth(index + 1),
      }),
    );
  }

  const yearInput = fieldInput({
    type: 'number',
    extraClass: 'cal-year-input',
    ariaLabel: 'Год',
    min: MIN_YEAR,
    max: MAX_YEAR,
  });
  yearInput.style.display = 'none';

  let from = opts.from ?? '';
  let to = opts.to ?? '';
  const today = opts.today ?? todayLocal();
  let year: number;
  let month: number; // 1..12

  const anchor =
    (opts.from ?? '').trim() !== '' ? opts.from! : today !== '' ? today : firstOfMonth(new Date().getFullYear(), 1);
  const anchorDate = new Date(`${anchor}T00:00:00Z`);
  year = opts.month?.year ?? anchorDate.getUTCFullYear();
  month = opts.month?.month ?? anchorDate.getUTCMonth() + 1;

  /** Активен ли drag в данный момент. */
  let dragging = false;
  /** День начала drag. */
  let dragStart = '';
  /** Drag ушёл на другой день (тогда click подавляется). */
  let dragMoved = false;

  function notifyMonth(): void {
    opts.onMonthChange?.(year, month);
  }

  function shiftMonth(delta: number): void {
    const next = new Date(Date.UTC(year, month - 1 + delta, 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    closeMonthList();
    notifyMonth();
    render();
  }

  function goToday(): void {
    const d = new Date(`${today}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      year = d.getUTCFullYear();
      month = d.getUTCMonth() + 1;
    }
    closeMonthList();
    notifyMonth();
    render();
    opts.onToday?.();
  }

  function pickMonth(next: number): void {
    if (next < 1 || next > 12) return;
    month = next;
    closeMonthList();
    notifyMonth();
    render();
  }

  function toggleMonthList(): void {
    monthList.hidden = !monthList.hidden;
    monthList.classList.toggle('is-open', !monthList.hidden);
  }

  function closeMonthList(): void {
    monthList.hidden = true;
    monthList.classList.remove('is-open');
  }

  /** Открыть поле ввода года вместо кнопки. */
  function openYearInput(): void {
    yearInput.value = String(year);
    yearInput.style.display = '';
    yearBtn.style.display = 'none';
    yearInput.focus();
    yearInput.select();
  }

  /** Применить введённый год (при выходе из поля). */
  function commitYear(): void {
    const value = Number.parseInt(yearInput.value, 10);
    if (Number.isFinite(value)) {
      year = Math.min(MAX_YEAR, Math.max(MIN_YEAR, value));
    }
    yearInput.style.display = 'none';
    yearBtn.style.display = '';
    notifyMonth();
    render();
  }

  yearInput.addEventListener('change', commitYear);
  yearInput.addEventListener('blur', commitYear);
  yearInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commitYear();
  });

  function inPeriod(day: string): boolean {
    if (from !== '' && day < from) return false;
    if (to !== '' && day > to) return false;
    return from !== '' || to !== '';
  }

  function renderHead(): void {
    monthBtn.textContent = MONTHS_SHORT[month - 1]!;
    yearBtn.textContent = String(year);
    // Год, показанный в поле ввода, синхронизируем с текущим.
    if (yearInput.style.display !== 'none') yearInput.value = String(year);
  }

  function buildDay(cell: { day: string; inMonth: boolean }): HTMLElement {
    const classes = ['cal-day'];
    if (!cell.inMonth) classes.push('is-out');
    if (cell.day === today) classes.push('is-today');
    if (inPeriod(cell.day)) classes.push('is-selected');
    if (from !== '' && cell.day === from) classes.push('is-selected-from');
    if (to !== '' && cell.day === to) classes.push('is-selected-to');
    const count = opts.counts?.(cell.day) ?? 0;
    const label = String(Number(cell.day.slice(8, 10)));
    const button = uiButton({
      label,
      role: 'ghost',
      size: 's',
      title: cell.day,
      class: classes.join(' '),
      onClick: () => {
        if (dragMoved) {
          // Завершение перетаскивания: click уже обработан в mouseup.
          dragMoved = false;
          return;
        }
        opts.onPickDay?.(cell.day);
      },
    });
    if (count > 0) {
      button.append(el('span', 'cal-count', String(count)));
      button.classList.add('has-records');
    }
    if (dragEnabled) wireDrag(button, cell.day);
    return button;
  }

  /** Перетаскивание диапазона: mousedown → движение → mouseup. */
  function wireDrag(button: HTMLElement, day: string): void {
    button.addEventListener('mousedown', () => {
      dragging = true;
      dragMoved = false;
      dragStart = day;
      from = day;
      to = day;
      render();
    });
    button.addEventListener('mousemove', () => {
      if (!dragging) return;
      if (day !== dragStart) dragMoved = true;
      from = minDay(dragStart, day);
      to = maxDay(dragStart, day);
      render();
    });
    button.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const start = dragStart;
      const end = day;
      dragStart = '';
      if (start === end) return; // обычный клик — дальше сработает onClick
      from = minDay(start, end);
      to = maxDay(start, end);
      render();
      opts.onRangeChange?.(from, to);
    });
  }

  function renderGrid(): void {
    grid.replaceChildren();
    const headRow = div('cal-row cal-row-head');
    if (weekNumbers) headRow.append(span('', 'cal-week-num'));
    for (const name of WEEKDAYS) headRow.append(span(name, 'cal-wd'));
    grid.append(headRow);

    for (const week of buildMonthWeeks(year, month)) {
      const row = div('cal-row');
      if (weekNumbers) {
        row.append(
          uiButton({
            label: String(week.week),
            role: 'ghost',
            size: 's',
            title: `Неделя ${week.week}: ${week.days[0]!.day} — ${week.days[6]!.day}`,
            class: 'cal-week',
            onClick: () => opts.onPickWeek?.(week.days[0]!.day),
          }),
        );
      }
      for (const cell of week.days) row.append(buildDay(cell));
      grid.append(row);
    }
  }

  function render(): void {
    renderHead();
    renderGrid();
  }

  render();
  root.append(head, monthList, yearInput, grid);

  return {
    root,
    setSelection: (nextFrom, nextTo) => {
      from = nextFrom;
      to = nextTo;
      render();
    },
    showDate: (day) => {
      const d = new Date(`${day}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) return;
      year = d.getUTCFullYear();
      month = d.getUTCMonth() + 1;
      render();
    },
    getMonth: () => ({ year, month }),
  };
}

/** Показанная неделя (`CalendarWeek`) — реэкспорт типа для потребителей. */
export type MonthCalendarWeek = CalendarWeek;
