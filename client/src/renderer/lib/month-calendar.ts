/**
 * «Календарь месяца» — общий библиотечный компонент (0.10.1, приёмка №5,
 * задача 7ce662c4; элемент интерфейса 55b07702 «Календарь месяца в «Дневнике»»).
 *
 * Один календарь на два применения: панель отбора «Дневника» (выбор дня или
 * недели = «Применить» с периодом) и диалог «Дата/период»
 * (`lib/date-period-dialog.ts` — выбор дня, перетаскивание диапазона). Двух
 * разных календарей в коде быть не должно.
 *
 * **Навигация.** Строка заголовка: месяц — кликабельная кнопка (открывает
 * ВЫПАДАЮЩИЙ ПОПОВЕР со списком январь–декабрь без года; высота календаря от
 * этого не меняется), год — кнопка, превращающаяся НА СВОЁМ ЖЕ МЕСТЕ в
 * маленькое поле ввода года (4 цифры; Enter/blur — применить, Esc — отмена),
 * справа в той же строке «<» (месяц назад), «○» (сегодня), «>» (месяц вперёд).
 * Дни соседних месяцев приглушены.
 *
 * **Одиночный клик и перетаскивание.** Клик по дню сообщает хозяину день
 * (`onPickDay`). Перетаскивание (mousedown → движение → mouseup) сообщает
 * упорядоченный диапазон (`onRangeChange`). Сетка при старте перетаскивания НЕ
 * перестраивается (меняется только выделение классов) — иначе узел-цель
 * теряется и одиночный `click` по дню не доходит (приёмка №6, п.3).
 *
 * **Что компонент НЕ делает.** Он не применяет период и не трогает данные: клик
 * по дню/неделе лишь сообщает хозяину выбранное (`onPickDay`/`onPickWeek`),
 * перетаскивание диапазона — через `onRangeChange`. Инвариант панели «поля
 * периода — единственный источник дат» остаётся на экране.
 *
 * Чистая сетка месяца ({@link buildMonthWeeks}) и примитивы дат — `lib/dates.ts`
 * (перенесены из `screens/chronicle/diary.ts`, чтобы библиотека не зависела от
 * экрана). DOM собирается на общем словаре кнопок (`lib/ui/button.ts`), поля —
 * `lib/ui/field.ts`, список месяцев — общий поповер `lib/ui/popover.ts` (свои
 * кнопки/поля/панели не пишутся; сторожи `guard-ui-buttons`, `guard-ui-fields`,
 * `guard-ui-popover`).
 */

import { div, el, span } from './dom.js';
import { buildMonthWeeks, firstOfMonth, todayLocal, type CalendarWeek } from './dates.js';
import { defineKeyContext, pushKeyContext } from './keymap.js';
import { uiButton } from './ui/button.js';
import { fieldInput } from './ui/field.js';
import { openPopover, type PopoverHandle } from './ui/popover.js';

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

/**
 * Окно «глушения» повторного открытия списка месяцев: после закрытия поповера
 * кликом по кнопке месяца тот же клик не должен открывать список заново
 * (pointerdown закрывает панель раньше, чем приходит `click`).
 */
const MONTH_REOPEN_GUARD_MS = 400;

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

/**
 * Индикатор записей дня (0.10.2, задача 41ed99ab, элемент 55b07702): число
 * чисел-счётчиков заменено 1–3 вертикальными точками. Пороги: записей нет —
 * 0 точек; ≤ 50 — 1 точка; 51…100 — 2 точки; > 100 — 3 точки. Точки живут
 * только там, где хозяин передал `counts` (панель «Дневника»); в диалоге
 * даты/периода счётчики не задаются — вид прежний.
 */
export function calendarDotCount(count: number): 0 | 1 | 2 | 3 {
  if (count <= 0) return 0;
  if (count <= 50) return 1;
  if (count <= 100) return 2;
  return 3;
}

/** Столбик из `n` точек-индикаторов (слева от номера дня). */
function buildDots(n: number): HTMLElement {
  const box = el('span', 'cal-dots');
  for (let i = 0; i < n; i++) box.append(el('span', 'cal-dot'));
  return box;
}

/** Наименьшая из двух дат. */
function minDay(a: string, b: string): string {
  return a <= b ? a : b;
}

/** Наибольшая из двух дат. */
function maxDay(a: string, b: string): string {
  return a >= b ? a : b;
}

/** Счётчик календарей: у каждого свой контекст сочетаний (замыкание года). */
let yearInputContextSeq = 0;

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
  // Год и поле его ввода стоят в одной ячейке: поле раскрывается НА МЕСТЕ
  // подписи, а не отдельной строкой (приёмка №6, п.5).
  const yearCell = div('cal-year-cell');
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
  head.append(monthBtn, yearCell, spacer, prevBtn, todayBtn, nextBtn);

  const yearInput = fieldInput({
    type: 'number',
    extraClass: 'cal-year-input',
    ariaLabel: 'Год',
    title: 'Год',
    min: MIN_YEAR,
    max: MAX_YEAR,
  });
  yearInput.style.display = 'none';
  yearCell.append(yearBtn, yearInput);

  const grid = div('cal-grid');

  let from = opts.from ?? '';
  let to = opts.to ?? '';
  const today = opts.today ?? todayLocal();
  let year: number;
  let month: number; // 1..12

  const anchor =
    (opts.from ?? '').trim() !== ''
      ? opts.from!
      : today !== ''
        ? today
        : firstOfMonth(new Date().getFullYear(), 1);
  const anchorDate = new Date(`${anchor}T00:00:00Z`);
  year = opts.month?.year ?? anchorDate.getUTCFullYear();
  month = opts.month?.month ?? anchorDate.getUTCMonth() + 1;

  /** Активен ли drag в данный момент. */
  let dragging = false;
  /** День начала drag. */
  let dragStart = '';
  /** Drag ушёл на другой день (тогда click подавляется). */
  let dragMoved = false;
  /** Кнопки дней текущей сетки (для обновления выделения без перестройки). */
  let dayCells: Array<{ day: string; el: HTMLElement }> = [];

  /** Открыт ли inline-ввод года прямо сейчас. */
  let yearEditing = false;
  /** Открытая панель списка месяцев. */
  let monthPopover: PopoverHandle | null = null;
  /** Момент закрытия списка месяцев (защита от повторного открытия). */
  let monthPopoverClosedAt = 0;

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

  /** Тело списка месяцев (январь–декабрь) — уходит в общий поповер. */
  function buildMonthList(): HTMLElement {
    const list = div('cal-months');
    for (let i = 0; i < 12; i++) {
      const index = i;
      list.append(
        uiButton({
          label: MONTHS[i]!,
          role: 'ghost',
          size: 's',
          class: 'cal-month-item',
          onClick: () => pickMonth(index + 1),
        }),
      );
    }
    return list;
  }

  /** Открывает/закрывает выпадающий поповер списка месяцев. */
  function toggleMonthList(): void {
    if (monthPopover !== null) {
      monthPopover.close();
      return;
    }
    // Панель только что закрыта кликом вне (в т.ч. по самой кнопке) — этот
    // же клик не должен открывать её снова.
    if (Date.now() - monthPopoverClosedAt < MONTH_REOPEN_GUARD_MS) return;
    monthPopover = openPopover({
      anchor: { element: monthBtn },
      content: { title: 'Месяц', body: buildMonthList() },
      extraClass: 'cal-months-popover',
      onClose: () => {
        monthPopover = null;
        monthPopoverClosedAt = Date.now();
      },
    });
  }

  function closeMonthList(): void {
    monthPopover?.close();
  }

  /** Открыть поле ввода года вместо кнопки (на том же месте). */
  function openYearInput(): void {
    yearEditing = true;
    yearInput.value = String(year);
    yearInput.style.display = '';
    yearBtn.style.display = 'none';
    yearInput.focus();
    yearInput.select();
  }

  /** Применить введённый год. */
  function commitYear(): void {
    if (!yearEditing) return;
    const value = Number.parseInt(yearInput.value, 10);
    if (Number.isFinite(value)) {
      year = Math.min(MAX_YEAR, Math.max(MIN_YEAR, value));
    }
    closeYearInput();
    notifyMonth();
    render();
  }

  /** Закрыть поле года без применения (Esc). */
  function cancelYear(): void {
    if (!yearEditing) return;
    yearEditing = false;
    yearInput.style.display = 'none';
    yearBtn.style.display = '';
    notifyMonth();
    render();
  }

  function closeYearInput(): void {
    yearEditing = false;
    yearInput.style.display = 'none';
    yearBtn.style.display = '';
  }

  yearInput.addEventListener('change', commitYear);
  yearInput.addEventListener('blur', commitYear);
  // Клавиатура поля года — через общеклиентский диспетчер (ADR b420b08c,
  // задача fd3d84f4). Escape гасит регистрируемый ниже capture-слушатель `window`
  // раньше диспетчера (он должен обогнать capture-Escape каркаса диалога), так
  // что Escape-ветка здесь — страховка для календаря вне диалога.
  const yearContextId = `month-calendar-year-${(yearInputContextSeq += 1)}`;
  const handleYearKey = (event: KeyboardEvent): boolean => {
    if (event.key === 'Enter') {
      commitYear();
      return true;
    }
    if (event.key === 'Escape') {
      cancelYear();
      return true;
    }
    return false;
  };
  defineKeyContext({
    id: yearContextId,
    bindings: [
      { command: 'calendar.year.commit', chord: 'Enter', run: handleYearKey },
      { command: 'calendar.year.cancel', chord: 'Escape', run: handleYearKey },
    ],
  });
  let releaseYearContext: (() => void) | null = null;
  const onYearFocusIn = (): void => {
    releaseYearContext ??= pushKeyContext(yearContextId);
  };
  const onYearFocusOut = (): void => {
    releaseYearContext?.();
    releaseYearContext = null;
  };
  yearInput.addEventListener('focusin', onYearFocusIn as EventListener);
  yearInput.addEventListener('focusout', onYearFocusOut as EventListener);

  // Esc в поле года должен отменить правку года, а НЕ закрыть модальный диалог
  // (`showDialog` слушает Escape на `window` в capture-фазе). Capture-слушатель
  // регистрируется при сборке календаря — то есть раньше, чем диалог повесит
  // свой, — и при открытом поле года гасит нажатие до диалога (приёмка №6, п.5).
  window.addEventListener(
    'keydown',
    (event) => {
      if (!yearEditing || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelYear();
    },
    true,
  );

  function inPeriod(day: string): boolean {
    if (from !== '' && day < from) return false;
    if (to !== '' && day > to) return false;
    return from !== '' || to !== '';
  }

  /** Обновляет классы выделения на существующих кнопках дней. */
  function paintSelection(): void {
    for (const cell of dayCells) {
      cell.el.classList.toggle('is-selected', inPeriod(cell.day));
      cell.el.classList.toggle('is-selected-from', from !== '' && cell.day === from);
      cell.el.classList.toggle('is-selected-to', to !== '' && cell.day === to);
    }
  }

  function renderHead(): void {
    monthBtn.textContent = MONTHS_SHORT[month - 1]!;
    yearBtn.textContent = String(year);
    // Год, показанный в поле ввода, синхронизируем с текущим.
    if (yearEditing || yearInput.style.display !== 'none') yearInput.value = String(year);
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
      label: '',
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
    // Индикатор записей — столбик 1–3 точек СЛЕВА от номера дня, по центру
    // ячейки (0.10.2, задача 41ed99ab); фоновой подсветки `.has-records` больше
    // нет — счётчик-число упразднён.
    const dots = calendarDotCount(count);
    if (dots > 0) button.append(buildDots(dots));
    button.append(span(label, 'cal-day-num'));
    if (dragEnabled) wireDrag(button, cell.day);
    return button;
  }

  /**
   * Перетаскивание диапазона: mousedown → движение → mouseup. Во время drag
   * сетка НЕ пересобирается — обновляются только классы выделения, поэтому
   * узел-цель остаётся на месте и одиночный `click` по дню срабатывает.
   */
  function wireDrag(button: HTMLElement, day: string): void {
    button.addEventListener('mousedown', () => {
      dragging = true;
      dragMoved = false;
      dragStart = day;
      from = day;
      to = day;
      paintSelection();
    });
    button.addEventListener('mousemove', () => {
      if (!dragging) return;
      if (day !== dragStart) dragMoved = true;
      from = minDay(dragStart, day);
      to = maxDay(dragStart, day);
      paintSelection();
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
      paintSelection();
      opts.onRangeChange?.(from, to);
    });
  }

  function renderGrid(): void {
    grid.replaceChildren();
    dayCells = [];
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
      for (const cell of week.days) {
        const button = buildDay(cell);
        dayCells.push({ day: cell.day, el: button });
        row.append(button);
      }
      grid.append(row);
    }
    paintSelection();
  }

  function render(): void {
    renderHead();
    renderGrid();
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
      closeMonthList();
      render();
    },
    getMonth: () => ({ year, month }),
  };
}

/** Показанная неделя (`CalendarWeek`) — реэкспорт типа для потребителей. */
export type MonthCalendarWeek = CalendarWeek;
