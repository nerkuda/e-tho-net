/**
 * Приёмочные регрессы «Дневника» 0.10.1 (задача 98297b02, версия 0.10.1).
 *
 * Проверяются шесть замечаний приёмки структурно (по исходникам) и чистыми
 * помощниками:
 *  1) компоновка — календарь первым элементом панели, кнопка добавления в
 *     верхней панели над лентой;
 *  2) JS-ошибка `data-row-key` на клике по дате — атрибут ставится через
 *     `setAttribute`, а не `dataset[...]`;
 *  3) кнопка «Сегодня» в календаре;
 *  4) псевдо-запись по одному заголовку доходит до ленты (нет обходной меры);
 *  5) маркеры дней считаются одним агрегатным запросом по месяцу, независимо
 *     от периода (0.16.1: счётчики-записи заменены маркерами, требование
 *     ab9d627b);
 *  6) панель отбора — состав «Структур» (без «стороны связи» и отдельной
 *     группы «критерии целей», период без переключателя режимов).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

const CHRONICLE = read('screens/chronicle/chronicle.ts');
const CALENDAR = read('lib/month-calendar.ts');
const PANEL = read('screens/chronicle/filter-panel.ts');
const BUILDER = read('lib/filter-builder.ts');
const PERIOD_EDITOR = read('lib/period-editor.ts');
const DATE_PERIOD_DIALOG = read('lib/date-period-dialog.ts');

describe('приёмка «Дневника» 0.10.1: компоновка (пункт 1)', () => {
  it('календарь — header панели отбора (первый элемент)', () => {
    assert.match(CHRONICLE, /mountChronicleFilterPanel\([\s\S]*header: \[calWrap\]/);
    assert.match(
      PANEL,
      /for \(const node of headerNodes\) panel\.append\(node\)/,
      'панель кладёт header перед содержимым',
    );
  });

  it('кнопка добавления — в верхней панели над лентой', () => {
    assert.match(CHRONICLE, /div\('chron-addbar'\)/);
    // 0.16.1 (задача 64f7976a): между панелью добавления и лентой стоит
    // панель «Задачи и напоминания» — одна при любом периоде, вне блоков дней;
    // под ней — слайдер её высоты (0.16.1, пункт B ТЗ).
    assert.match(CHRONICLE, /main\.append\(addBar, tasksHost, tasksSplitter, feedWrap\)/);
    assert.match(CHRONICLE, /diary\.addRecord/);
  });

  it('гриф высоты панели назван сразу при создании, а не только при драге', () => {
    // Доступное имя (title + aria-label) обязано стоять ДО первого
    // взаимодействия: `plan()` зовётся только началом драга, поэтому имя,
    // выставленное лишь там, не читается экранным диктором в покое
    // (замечание проверки 2026-11-17).
    assert.match(
      CHRONICLE,
      /tasksSplitter\.title = t\('tasks\.panelHeightHint'\);\s*\n\s*tasksSplitter\.setAttribute\('aria-label', t\('tasks\.panelHeightAria'\)\);\s*\n\s*wireSplitter\(/,
    );
  });
});

describe('приёмка «Дневника» 0.10.1: JS-ошибка data-row-key (пункт 2)', () => {
  it('ключ строки ставится атрибутом, а не через dataset', () => {
    assert.match(CHRONICLE, /card\.setAttribute\(TABLE_ROW_KEY_ATTR, row\.id\)/);
    assert.ok(
      !/\.dataset\[TABLE_ROW_KEY_ATTR\]/.test(CHRONICLE),
      'dataset[TABLE_ROW_KEY_ATTR] бросает исключение (имя с дефисом)',
    );
  });
});

describe('приёмка «Дневника» 0.10.1: кнопка «Сегодня» (пункт 3)', () => {
  it('календарь несёт кнопку и сообщает хосту', () => {
    // Приёмка №5: текстовая «Сегодня» заменена на «○» (общая навигация < ○ >).
    assert.match(CALENDAR, /label: '○'/);
    assert.match(CALENDAR, /class: 'cal-today'/);
    assert.match(CALENDAR, /onClick: \(\) => goToday\(\)/);
    assert.match(CHRONICLE, /onToday: \(\) => goToday\(\)/);
    assert.match(CHRONICLE, /calendar\?\.showDate\(today\)/, 'переход к текущему месяцу');
  });
});

describe('приёмка «Дневника» 0.10.1/0.12.1: немедленное создание (26f0aa52)', () => {
  it('«Добавить» сразу создаёт пустую запись, псевдозапись демонтирована', () => {
    assert.match(CHRONICLE, /^async function addRecord\(/m, 'создание ведёт `addRecord`');
    assert.match(CHRONICLE, /title: null,\s*\n\s*body_md: '',/, 'запись создаётся пустой');
    assert.ok(!/ensureSlot|startSlot|slotBusy|planSlotCommit/.test(CHRONICLE), 'слот упразднён');
  });
});

describe('приёмка «Дневника» 0.10.1: маркеры календаря (пункт 5, 0.16.1)', () => {
  it('маркеры считаются одним агрегатным запросом по месяцу, без периода', () => {
    // Снимок пары, месяца и «сегодня» снимается в одной точке: маркеры считают
    // отбор ТОЛЬКО своей пары «сеть + вкладка» (ошибка 58c55bb9).
    assert.match(
      CHRONICLE,
      /async function refreshCalendarMarkers\(snapshot: CalendarMarkersSnapshot \| null\)/,
    );
    // Один запрос за месяц: интервалы записей и моменты напоминаний приходят
    // UTC-инстансами, «сегодня» — от клиента (требования fcdcd75f, ab9d627b).
    assert.match(
      CHRONICLE,
      /etn\.chronicle\.calendarMarkers\(pair\.networkId, \{ from, to, today \}\)/,
      'агрегатный запрос маркеров вместо counts-запроса записей',
    );
    assert.match(CHRONICLE, /groupCalendarMarkers\(result, \{ from, to \}\)/, 'раскладка по дням');
    assert.ok(
      !/refreshCalendarCounts|CHRONICLE_QUERY_MAX_LIMIT/.test(CHRONICLE),
      'counts-запрос записей упразднён',
    );
    assert.ok(
      !/dayCounts\.set\(day\.day, day\.rows\.length\)/.test(CHRONICLE),
      'маркеры больше не берутся из периода-фильтрованной ленты',
    );
  });

  it('маркеры есть только у календаря панели; диалог «Дата/период» — markers: off', () => {
    // Панель передаёт источник маркеров (0.16.1, требование ab9d627b).
    assert.match(CHRONICLE, /markers: \(day\) => dayMarkers\(day\)/, 'источник маркеров панели');
    // Компонент рисует столбик четырёх фиксированных мест в порядке
    // `CALENDAR_MARKER_ORDER`; счётчика и точек-порогов больше нет.
    assert.match(CALENDAR, /CALENDAR_MARKER_ORDER/, 'порядок мест — из @etn/shared');
    assert.match(
      CALENDAR,
      /buildMarkers\(new Set\(opts\.markers\(cell\.day\)\)\)/,
      'маркеры клетки',
    );
    assert.ok(!/calendarDotCount|cal-dots|cal-count/.test(CALENDAR), 'счётчики упразднены');
    // Диалог собирает тот же компонент без опции `markers` — режим `markers: off`.
    assert.match(DATE_PERIOD_DIALOG, /buildMonthCalendar\(\{/, 'диалог использует общий календарь');
    assert.ok(
      !/markers\s*:/.test(DATE_PERIOD_DIALOG),
      'диалог «Дата/период» маркеров не показывает',
    );
  });
});

describe('приёмка «Дневника» 0.10.1: состав панели — «Структуры» (пункт 6)', () => {
  it('период — строка «Время записи» дерева; панельный вариант контрола цел', () => {
    // Задача 608ecb79: панель больше не строит контрол периода сама — период
    // живёт строкой «Время записи» единого редактора (профиль со временем), а
    // панельный вариант общего контрола остаётся у других потребителей.
    assert.match(PANEL, /chroniclePeriod\(/);
    assert.match(PANEL, /OP_TIME/);
    assert.match(PERIOD_EDITOR, /variant === 'panel'/);
    assert.match(PERIOD_EDITOR, /pe-preset-bound/, 'строка пресет-границы');
    // Приёмка №3 (0.10.1): составная выпадашка пресетов убрана — её место
    // заняли комбобокс базовых пресетов и сдвиг ±N в каждой границе.
    assert.ok(!/pe-presets/.test(PERIOD_EDITOR), 'составной выпадашки пресетов нет');
    assert.ok(!/periodPresets/.test(PERIOD_EDITOR), 'список составных пресетов удалён');
  });

  it('панель собирается единым редактором с профилем «Дневниковые записи»', () => {
    // Задача 608ecb79 (ADR fc23f9c1): спец-секций в экране нет — условия это
    // строки дерева, а вид строит общая фабрика с профилем `chronicle`.
    assert.match(PANEL, /buildFilterEditor\(\{/, 'вид строит общая фабрика');
    assert.match(PANEL, /FILTER_PROFILE = 'chronicle'/, 'профиль места — со временем');
    assert.match(PANEL, /showScope: true/, 'чекбоксы области поиска строки поиска');
    assert.match(PANEL, /OP_TARGETS, 'in'/, 'цели — под-выборка «в выборке»');
    assert.match(PANEL, /kind: 'subquery'/, 'значение целей — под-выборка мыслей');
    assert.match(
      BUILDER,
      /out\.targets = buildWireFilter/,
      'плоская форма targets сохранена для v1',
    );
  });

  it('убранное не вернулось: сторона связи, отдельная группа целей', () => {
    assert.ok(!/Сторона связи/.test(PANEL), '«сторона связи» убрана');
    assert.ok(!/title: 'Критерии целей/.test(PANEL), 'отдельная группа «критерии целей» убрана');
    assert.ok(!/link_scope/.test(PANEL), 'панель не пишет link_scope');
    assert.ok(!/title: 'Поиск'/.test(PANEL), 'секция переименована в «Ключевые слова»');
  });
});
