/**
 * Приёмочные регрессы «Дневника» 0.10.1, итерация №5 (задача 7ce662c4,
 * версия 0.10.1, слой 1229ad15). Проверяются ПОВЕДЕНЧЕСКИ (DOM-шим) и, где
 * модуль экрана недоступен под Node (Electron-каркас), — структурно по
 * исходнику (конвенция `chronicle-calendar.test.ts`):
 *
 *  1) компоновка карточки записи: строка 1 — дата/период, облачка, «+ мысль»,
 *     «бутерброд» с точными тултипами; строка 2 — заголовок; далее оболочка;
 *  2) рендерер значения диалога — все четыре формы отображения;
 *  3) диалог «Дата/период»: переключатель, клик по дню, drag диапазона с
 *     авто-переключением режима, валидация С/По, список месяцев, смена года,
 *     кнопки < ○ >;
 *  4) интеграции: лента/вкладка редактора/панель «Даты».
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

const CHRONICLE = read('screens/chronicle/chronicle.ts');

/** Минимальный DOM-шим: хватает для сборки диалога и панельного контрола. */
function installShim(): ShimElement {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body,
    activeElement: body,
    // Поповер списка месяцев (`lib/ui/popover.ts`) ставит делегированные
    // слушатели на `document` — шим отдаёт заглушки.
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
  return body;
}

/** Первый элемент с классом (рекурсивно). */
function byClass(root: ShimElement, className: string): ShimElement | undefined {
  return root.querySelector(`.${className}`) ?? undefined;
}

/** Кнопка сегмента по подписи. */
function buttonByText(root: ShimElement, text: string): ShimElement | undefined {
  return root.querySelectorAll('button').find((b) => b.textContent === text);
}

/** Ячейка календаря по полной дате (`title`). */
function dayByDate(root: ShimElement, day: string): ShimElement | undefined {
  return root.querySelectorAll('.cal-day').find((d) => d.title === day);
}

/** Сегмент активен (класс словаря кнопок). */
function isActive(btn: ShimElement | undefined): boolean {
  return btn !== undefined && btn.classList.contains('ui-btn--active');
}

// ---------------------------------------------------------------------------
// Пункт 2: рендерер значения
// ---------------------------------------------------------------------------

describe('приёмка №5, п.2: рендерер значения даты/периода', () => {
  it('четыре формы отображения значения', async () => {
    const { formatDatePeriodValue } = await import(
      '../src/renderer/lib/date-period-dialog.js'
    );
    const base = { hasTime: false, fromTime: '10:00', toTime: '10:15' } as const;
    assert.equal(
      formatDatePeriodValue({ mode: 'date', from: '2026-09-26', to: '2026-09-26', ...base }),
      '2026-09-26',
      'одиночная дата',
    );
    assert.equal(
      formatDatePeriodValue({
        mode: 'date',
        from: '2026-09-26',
        to: '2026-09-26',
        ...base,
        hasTime: true,
      }),
      '2026-09-26 10:00',
      'дата с временем',
    );
    assert.equal(
      formatDatePeriodValue({
        mode: 'period',
        from: '2026-09-26',
        to: '2026-09-26',
        ...base,
        hasTime: true,
        toTime: '10:15',
      }),
      '2026-09-26, 10:00 - 10:15',
      'период одной датой с разным временем',
    );
    assert.equal(
      formatDatePeriodValue({
        mode: 'period',
        from: '2026-09-29',
        to: '2026-10-12',
        ...base,
      }),
      '2026-09-29 - 2026-10-12',
      'период двумя датами',
    );
    assert.equal(
      formatDatePeriodValue({
        mode: 'period',
        from: '2026-09-29',
        to: '2026-10-12',
        ...base,
        hasTime: true,
        fromTime: '10:00',
        toTime: '12:00',
      }),
      '2026-09-29 10:00 - 2026-10-12 12:00',
      'период двумя датами со временем',
    );
  });

  it('строка значения внизу диалога повторяет дату у обеих границ', async () => {
    const { formatDatePeriodDialogValue } = await import(
      '../src/renderer/lib/date-period-dialog.js'
    );
    assert.equal(
      formatDatePeriodDialogValue({
        mode: 'period',
        from: '2026-09-26',
        to: '2026-09-26',
        hasTime: true,
        fromTime: '10:00',
        toTime: '10:00',
      }),
      '2026-09-26 10:00 - 2026-09-26 10:00',
    );
    assert.equal(
      formatDatePeriodDialogValue({
        mode: 'period',
        from: '2026-09-26',
        to: '2026-09-27',
        hasTime: false,
        fromTime: '10:00',
        toTime: '10:00',
      }),
      '2026-09-26 - 2026-09-27',
    );
  });
});

// ---------------------------------------------------------------------------
// Пункт 3: диалог
// ---------------------------------------------------------------------------

describe('приёмка №5, п.3: диалог «Дата/период»', () => {
  it('переключатель режимов и клик по дню в режиме «Дата»', async () => {
    installShim();
    const { buildDatePeriodDialog } = await import(
      '../src/renderer/lib/date-period-dialog.js'
    );
    const dialog = buildDatePeriodDialog({
      allowPeriod: true,
      allowTime: true,
      initial: { mode: 'date', from: '2026-09-10', to: '2026-09-10' },
    });
    const root = dialog.root as unknown as ShimElement;

    assert.ok(buttonByText(root, 'Дата'), 'есть сегмент «Дата»');
    assert.ok(buttonByText(root, 'Период'), 'есть сегмент «Период»');
    assert.ok(isActive(buttonByText(root, 'Дата')), 'режим «Дата» активен при старте');

    dayByDate(root, '2026-09-15')!.click();
    assert.equal(dialog.getValue().mode, 'date');
    assert.equal(dialog.getValue().from, '2026-09-15', 'клик по дню выбрал дату');
    assert.equal(dialog.getValue().to, '2026-09-15', 'одна дата заполняет обе границы');

    // Режим «Период» из переключателя.
    buttonByText(root, 'Период')!.click();
    assert.equal(dialog.getMode(), 'period');
    assert.ok(isActive(buttonByText(root, 'Период')), 'сегмент «Период» стал активным');
  });

  it('drag диапазона ставит С/По и авто-переключает режим в «Период»', async () => {
    installShim();
    const { buildDatePeriodDialog } = await import(
      '../src/renderer/lib/date-period-dialog.js'
    );
    const dialog = buildDatePeriodDialog({
      allowPeriod: true,
      allowTime: false,
      initial: { mode: 'date', from: '2026-09-10', to: '2026-09-10' },
    });
    const root = dialog.root as unknown as ShimElement;

    const d10 = dayByDate(root, '2026-09-10')!;
    const d20 = dayByDate(root, '2026-09-20')!;
    d10.emit('mousedown');
    d20.emit('mousemove');
    d20.emit('mouseup');

    const value = dialog.getValue();
    assert.equal(value.mode, 'period', 'drag автоматически включил режим «Период»');
    assert.equal(value.from, '2026-09-10', 'С = день начала');
    assert.equal(value.to, '2026-09-20', 'По = день окончания');
    assert.ok(isActive(buttonByText(root, 'Период')), 'переключатель перешёл в «Период»');
    assert.ok(
      dayByDate(root, '2026-09-10')!.classList.contains('is-selected-from'),
      'начало диапазона выделено',
    );
    assert.ok(
      dayByDate(root, '2026-09-20')!.classList.contains('is-selected-to'),
      'конец диапазона выделен',
    );
  });

  it('валидация С/По: обе стороны (помощники и клик по сетке)', async () => {
    const { setPeriodFrom, setPeriodTo } = await import(
      '../src/renderer/lib/date-period-dialog.js'
    );
    assert.deepEqual(
      setPeriodFrom('2026-09-20', '2026-09-10', '2026-09-25'),
      { from: '2026-09-25', to: '2026-09-25' },
      'С > По → По автоматически = С',
    );
    assert.deepEqual(
      setPeriodTo('2026-09-20', '2026-09-25', '2026-09-10'),
      { from: '2026-09-10', to: '2026-09-10' },
      'По < С → С автоматически = По',
    );

    installShim();
    const { buildDatePeriodDialog } = await import(
      '../src/renderer/lib/date-period-dialog.js'
    );
    const dialog = buildDatePeriodDialog({
      allowPeriod: true,
      initial: { mode: 'period', from: '2026-09-10', to: '2026-09-20' },
    });
    const root = dialog.root as unknown as ShimElement;
    dayByDate(root, '2026-09-25')!.click();
    assert.equal(dialog.getValue().from, '2026-09-25');
    assert.equal(dialog.getValue().to, '2026-09-25', 'С вышел за По — По подтянулся к С');
  });

  it('«С указанием времени» раскрывает поля времени', async () => {
    installShim();
    const { buildDatePeriodDialog } = await import(
      '../src/renderer/lib/date-period-dialog.js'
    );
    const dialog = buildDatePeriodDialog({
      allowPeriod: true,
      allowTime: true,
      initial: { mode: 'period', from: '2026-09-10', to: '2026-09-12', hasTime: false },
    });
    const root = dialog.root as unknown as ShimElement;
    assert.equal(root.querySelectorAll('.dpd-time').length, 0, 'времени нет, пока не включено');

    byClass(root, 'dpd-time-toggle')!.click();
    const times = root.querySelectorAll('.dpd-time');
    assert.equal(times.length, 2, 'в режиме «Период» — время у обеих границ');
    assert.equal(dialog.getValue().hasTime, true);

    times[0]!.value = '10:00';
    times[0]!.emit('change');
    assert.equal(dialog.getValue().fromTime, '10:00', 'время начала сохранено');
  });

  it('список месяцев — поповер, смена года инлайн, кнопки < ○ >', async () => {
    const body = installShim();
    const { buildDatePeriodDialog } = await import(
      '../src/renderer/lib/date-period-dialog.js'
    );
    const { todayLocal } = await import('../src/renderer/lib/dates.js');
    const dialog = buildDatePeriodDialog({
      allowPeriod: true,
      initial: { mode: 'date', from: '2020-01-15', to: '2020-01-15' },
    });
    const root = dialog.root as unknown as ShimElement;
    const monthLabel = (): string => byClass(root, 'cal-month')!.textContent;

    assert.equal(monthLabel(), 'янв', 'заголовок показывает месяц');

    // Список месяцев — ВЫПАДАЮЩИЙ поповер (не инлайн-раскрытие диалога).
    assert.equal(
      root.querySelectorAll('.cal-months').length,
      0,
      'внутри диалога списка месяцев нет (высота не меняется)',
    );
    byClass(root, 'cal-month')!.click();
    const popover = body.querySelector('.ui-popover');
    assert.ok(popover !== null, 'список месяцев открыт поповером');
    assert.equal(
      popover!.querySelectorAll('.cal-month-item').length,
      12,
      'в поповере 12 месяцев',
    );
    const october = popover!
      .querySelectorAll('.cal-month-item')
      .find((item) => item.textContent === 'Октябрь')!;
    october.click();
    assert.equal(monthLabel(), 'окт', 'выбор месяца из списка переключил месяц');
    assert.equal(
      body.querySelectorAll('.ui-popover').length,
      0,
      'после выбора поповер закрыт',
    );
    assert.equal(byClass(root, 'cal-year')!.textContent, '2020', 'год не менялся');

    // Кнопка «>» — месяц вперёд.
    byClass(root, 'cal-next')!.click();
    assert.equal(monthLabel(), 'ноя', 'кнопка «>» переключает месяц вперёд');
    // Кнопка «<» — месяц назад.
    byClass(root, 'cal-prev')!.click();
    assert.equal(monthLabel(), 'окт', 'кнопка «<» переключает месяц назад');

    // Смена года: инлайн-поле НА МЕСТЕ подписи (в той же ячейке).
    const yearBtn = byClass(root, 'cal-year')!;
    yearBtn.click();
    const yearInput = byClass(root, 'cal-year-input')!;
    assert.notEqual(yearInput.style.display, 'none', 'поле года раскрыто');
    assert.equal(
      yearInput.parent,
      byClass(root, 'cal-year-cell'),
      'поле года стоит в ячейке года',
    );
    assert.equal(yearBtn.style.display, 'none', 'подпись года скрыта на время ввода');
    yearInput.value = '2027';
    yearInput.emit('change');
    assert.equal(byClass(root, 'cal-year')!.textContent, '2027', 'год применён');

    // Кнопка «○» — к текущей дате (месяц становится текущим).
    byClass(root, 'cal-today')!.click();
    const short = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const today = todayLocal();
    assert.equal(monthLabel(), short[Number(today.slice(5, 7)) - 1], '«○» показывает текущий месяц');
  });
});

// ---------------------------------------------------------------------------
// Пункт 1: компоновка карточки (структурно — модуль экрана не грузится под Node)
// ---------------------------------------------------------------------------

describe('приёмка №5, п.1: компоновка карточки записи', () => {
  it('строка 1: дата/период, облачка, «+ мысль», «бутерброд» с точными тултипами', () => {
    // Строку полей собирает ЕДИНЫЙ конструктор шапки (0.10.3, ошибка 47c2bf05) —
    // те же поля у карточки и у слота; в экране остаются доменные привязки.
    const RECORD_HEAD = read('screens/chronicle/record-head.ts');
    assert.match(CHRONICLE, /dateTitle: 'Период дневниковой записи'/, 'тултип даты/периода');
    assert.match(RECORD_HEAD, /label: '\+ мысль'/, 'подпись кнопки — «+ мысль»');
    assert.match(RECORD_HEAD, /title: 'Добавить мысль'/, 'тултип добавления мысли');
    assert.match(
      CHRONICLE,
      /title: 'Действия с дневниковой записью'/,
      'тултип «бутерброда» меню записи',
    );
    assert.ok(!CHRONICLE.includes('Действия…'), 'текстовая кнопка «Действия…» упразднена');
    // Порядок строки полей в конструкторе: дата → привязки → «+ мысль» → завершение.
    const row = RECORD_HEAD.slice(
      RECORD_HEAD.indexOf('const date ='),
      RECORD_HEAD.indexOf('// Заголовок'),
    );
    const order = ["'diary-record-date'", 'hooks.chips', "label: '+ мысль'", 'hooks.trailing'];
    let last = -1;
    for (const token of order) {
      const at = row.indexOf(token);
      assert.ok(at > last, `строка полей в порядке: ${token}`);
      last = at;
    }
    // Экран привязывает к строке чипсы и «бутерброд» меню записи.
    assert.match(CHRONICLE, /chips: buildChipsRow\(row\)/, 'оболочка привязок карточки');
    assert.match(CHRONICLE, /class: 'diary-record-actions'/, '«бутерброд» меню записи');
    assert.match(
      read('styles/screens/chronicle.css'),
      /\.diary-record-actions\s*\{[^}]*margin-left:\s*auto/,
      'CSS прижимает «бутерброд» к правому краю',
    );
  });

  it('строка 2 — заголовок-группа, далее оболочка комментария', () => {
    // 0.10.2 (задача 41ed99ab): заголовок стал сворачиваемой группой записи —
    // в просмотре это крупная текстовая кнопка, а не всегда-редактируемый ввод.
    // 0.10.3 (ошибка 47c2bf05): строка полей и строка заголовка собираются одним
    // конструктором — обе входят в `head.root`, затем идёт тело.
    assert.match(
      CHRONICLE,
      /card\.replaceChildren\(head\.root, buildRecordBody\(row, card\)\)/,
      'порядок: шапка (строка полей + заголовок), затем тело',
    );
    const RECORD_HEAD = read('screens/chronicle/record-head.ts');
    assert.match(
      RECORD_HEAD,
      /root\.append\(row, title\.node\(\)\)/,
      'заголовок — вторая строка шапки (после строки полей)',
    );
    assert.match(
      CHRONICLE,
      /function buildRecordBody\(row: ChronicleRow, card: HTMLElement\)[\s\S]*renderRecordView\(shell, row\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// Пункт 4: интеграции
// ---------------------------------------------------------------------------

describe('приёмка №5, п.4: применения диалога', () => {
  it('лента открывает диалог и переводит результат общим помощником', () => {
    assert.match(CHRONICLE, /openDatePeriodDialog\(\{/);
    // Время разрешено ВСЕГДА (кнопка «С указанием времени» — часть диалога,
    // приёмка №6): запись без `use_time` тоже может включить время.
    assert.match(CHRONICLE, /allowTime: true/, 'время доступно в диалоге записи');
    // Экран переводит значение ДИАЛОГА его же помощником (итерация приёмки №8,
    // п.1): своя реализация конверсии устранена — источник правды один.
    assert.match(CHRONICLE, /resolveDatePeriodInstants\(value, previous\)/);
  });

  it('вкладка «Дневник» редактора — диалог вместо инлайн-контрола', () => {
    const src = read('editor/chrono-tab.ts');
    assert.match(src, /openDatePeriodDialog\(\{/);
    assert.ok(!src.includes('buildPeriodEditor'), 'инлайн-контрол периода убран');
    assert.match(src, /resolveDatePeriodInstants\(/);
  });

  it('панель отбора, режим «Даты»: клик по полю открывает диалог (без времени)', () => {
    const src = read('screens/chronicle/filter-panel.ts');
    assert.match(src, /openDatesDialog:/);
    assert.match(src, /allowTime: false/);
    assert.match(src, /openDatePeriodDialog\(\{/);
  });

  it('панельный контрол: кнопка-календарь отдаёт текущий период и применяет результат', async () => {
    installShim();
    const { buildPeriodEditor } = await import('../src/renderer/lib/period-editor.js');
    let asked: { from: string; to: string } | null = null;
    let resolveDialog: ((value: { from: string; to: string } | null) => void) | null = null;
    const editor = buildPeriodEditor({
      variant: 'panel',
      panelMode: 'dates',
      value: { from: '2026-09-10', to: '2026-09-12' },
      openDatesDialog: (current) => {
        asked = current;
        return new Promise((res) => {
          resolveDialog = res;
        });
      },
    });
    const root = editor.root as unknown as ShimElement;
    // Компонентные поля дат (итерация приёмки №8, п.4): редактируемый ввод +
    // кнопка-календарь + крестик очистки у каждой границы.
    const inputs = root.querySelectorAll('.date-field-input');
    assert.equal(inputs.length, 2, 'две границы режима «Даты» — редактируемые поля');
    assert.equal(inputs[0]!.value, '2026-09-10', 'значение «С» показано в поле');
    assert.equal(root.querySelectorAll('.date-field-clear').length, 2, 'у полей есть очистка');
    const picks = root.querySelectorAll('.date-field-pick');
    assert.equal(picks.length, 2, 'у полей есть кнопка-календарь');
    picks[0]!.click();
    assert.deepEqual(asked, { from: '2026-09-10', to: '2026-09-12' }, 'диалог получил текущий период');
    resolveDialog!({ from: '2026-10-01', to: '2026-10-05' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(editor.getValue().from, '2026-10-01', 'С обновлён из диалога');
    assert.equal(editor.getValue().to, '2026-10-05', 'По обновлён из диалога');
  });
});
