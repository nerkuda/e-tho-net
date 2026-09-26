/**
 * «Календарь месяца в «Дневнике»» (0.10.1, задача T6 64ca2b48; элемент
 * интерфейса 55b07702).
 *
 * Левая колонка вида «Дневник»: календарь текущего месяца. Клик по дню или по
 * номеру строки недели — тот же путь, что кнопка «Применить»: контрол лишь
 * сообщает выбранный период (`onPickDay`/`onPickWeek`), запись периода в поля
 * панели и перезапрос ленты делает хозяин экрана. Это держит инвариант
 * «календарь и поля панели всегда согласованы, поля — единственный источник
 * дат».
 *
 * Чистая сетка месяца ({@link buildMonthWeeks}) проверяется юнит-тестами;
 * сборка DOM — здесь же, на общих фасадах (`lib/ui/button.ts`), свои кнопки не
 * пишутся (сторож `guard-ui-buttons`).
 */

import { div, el, span } from '../../lib/dom.js';
import { uiButton } from '../../lib/ui/button.js';
import { addDays, isoWeekNumber } from './diary.js';

/** Одна ячейка дня календаря. */
export interface CalendarCell {
  /** Локальная дата `YYYY-MM-DD`. */
  day: string;
  /** День принадлежит отображаемому месяцу. */
  inMonth: boolean;
}

/** Одна строка недели календаря (понедельник … воскресенье). */
export interface CalendarWeek {
  /** Номер ISO-недели. */
  week: number;
  days: CalendarCell[];
}

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS_NOMINATIVE = [
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

/** Первый день месяца `YYYY-MM-DD`. */
function firstOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/**
 * Шесть недель сетки месяца (42 дня, всегда одинаковое число строк — высота
 * календаря не прыгает при переключении месяца). `month` — 1..12.
 */
export function buildMonthWeeks(year: number, month: number): CalendarWeek[] {
  const first = firstOfMonth(year, month);
  const firstDate = new Date(`${first}T00:00:00Z`);
  const lead = (firstDate.getUTCDay() + 6) % 7;
  let cursor = addDays(first, -lead);
  const weeks: CalendarWeek[] = [];
  for (let w = 0; w < 6; w++) {
    const days: CalendarCell[] = [];
    for (let d = 0; d < 7; d++) {
      days.push({ day: cursor, inMonth: cursor.slice(0, 7) === first.slice(0, 7) });
      cursor = addDays(cursor, 1);
    }
    const monday = days[0]!.day;
    weeks.push({ week: isoWeekNumber(monday), days });
  }
  return weeks;
}

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
  onPickDay: (day: string) => void;
  /** Клик по строке недели (аргумент — понедельник недели). */
  onPickWeek: (monday: string) => void;
  /** Первоначально показанный месяц (по умолчанию — из `today`/сегодня). */
  month?: { year: number; month: number };
  /** Смена показанного месяца (стрелки/колесо). */
  onMonthChange?: (year: number, month: number) => void;
}

/** Рукоятка календаря. */
export interface MonthCalendarHandle {
  root: HTMLElement;
  /** Перерисовать выделение периода из полей панели. */
  setSelection(from: string, to: string): void;
  /** Показать месяц по дате `YYYY-MM-DD`. */
  showDate(day: string): void;
  /** Показанный месяц. */
  getMonth(): { year: number; month: number };
}

/** Строит календарь месяца. */
export function buildMonthCalendar(opts: MonthCalendarOptions): MonthCalendarHandle {
  const root = div('cal');
  const head = div('cal-head');
  const title = span('', 'cal-title');
  const grid = div('cal-grid');
  head.append(
    uiButton({
      label: '‹',
      role: 'ghost',
      size: 's',
      title: 'Предыдущий месяц',
      class: 'cal-nav',
      onClick: () => shiftMonth(-1),
    }),
    title,
    uiButton({
      label: '›',
      role: 'ghost',
      size: 's',
      title: 'Следующий месяц',
      class: 'cal-nav',
      onClick: () => shiftMonth(1),
    }),
  );

  let from = opts.from ?? '';
  let to = opts.to ?? '';
  const today = opts.today ?? '';
  let year: number;
  let month: number; // 1..12

  const anchor =
    (opts.from ?? '').trim() !== ''
      ? opts.from!
      : today !== ''
        ? today
        : firstOfMonth(new Date().getFullYear(), new Date().getMonth() + 1);
  const anchorDate = new Date(`${anchor}T00:00:00Z`);
  year = opts.month?.year ?? anchorDate.getUTCFullYear();
  month = opts.month?.month ?? anchorDate.getUTCMonth() + 1;

  function shiftMonth(delta: number): void {
    const next = new Date(Date.UTC(year, month - 1 + delta, 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    opts.onMonthChange?.(year, month);
    render();
  }

  function inPeriod(day: string): boolean {
    if (from !== '' && day < from) return false;
    if (to !== '' && day > to) return false;
    return from !== '' || to !== '';
  }

  function render(): void {
    title.textContent = `${MONTHS_NOMINATIVE[month - 1]} ${year}`;
    grid.replaceChildren();
    const headRow = div('cal-row cal-row-head');
    headRow.append(span('', 'cal-week-num'));
    for (const name of WEEKDAYS) headRow.append(span(name, 'cal-wd'));
    grid.append(headRow);

    for (const week of buildMonthWeeks(year, month)) {
      const row = div('cal-row');
      row.append(
        uiButton({
          label: String(week.week),
          role: 'ghost',
          size: 's',
          title: `Неделя ${week.week}: ${week.days[0]!.day} — ${week.days[6]!.day}`,
          class: 'cal-week',
          onClick: () => opts.onPickWeek(week.days[0]!.day),
        }),
      );
      for (const cell of week.days) {
        const classes = ['cal-day'];
        if (!cell.inMonth) classes.push('is-out');
        if (cell.day === today) classes.push('is-today');
        if (inPeriod(cell.day)) classes.push('is-selected');
        const count = opts.counts?.(cell.day) ?? 0;
        // День месяца для подписи — без ведущего нуля.
        const label = String(Number(cell.day.slice(8, 10)));
        const button = uiButton({
          label,
          role: 'ghost',
          size: 's',
          title: cell.day,
          class: classes.join(' '),
          onClick: () => opts.onPickDay(cell.day),
        });
        if (count > 0) {
          button.append(el('span', 'cal-count', String(count)));
          button.classList.add('has-records');
        }
        row.append(button);
      }
      grid.append(row);
    }
  }

  render();
  root.append(head, grid);

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
