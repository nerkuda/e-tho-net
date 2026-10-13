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
 *  5) счётчики записей считаются по месяцу, независимо от периода;
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

describe('приёмка «Дневника» 0.10.1: компоновка (пункт 1)', () => {
  it('календарь — header панели отбора (первый элемент)', () => {
    assert.match(CHRONICLE, /mountChronicleFilterPanel\([\s\S]*header: \[calWrap\]/);
    assert.match(PANEL, /for \(const node of headerNodes\) panel\.append\(node\)/, 'панель кладёт header перед содержимым');
  });

  it('кнопка добавления — в верхней панели над лентой', () => {
    assert.match(CHRONICLE, /div\('chron-addbar'\)/);
    assert.match(CHRONICLE, /main\.append\(addBar, feedWrap\)/);
    assert.match(CHRONICLE, /diary\.addRecord/);
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

describe('приёмка «Дневника» 0.10.1: счётчики календаря (пункт 5)', () => {
  it('счётчики считаются отдельным запросом по месяцу, без периода', () => {
    assert.match(CHRONICLE, /async function refreshCalendarCounts\(\)/);
    // Границы месяца — ЛОКАЛЬНЫЕ сутки (приёмка №4, задача fd9eef49): «голая
    // дата» на сервере = сутки UTC и запись у локальной полуночи выпадала бы
    // из счётчиков месяца.
    // Задача 608ecb79: границы месяца подменяются В ДЕРЕВЕ периода (тело-дерево
    // и плоские `date_from`/`date_to` вместе сервер отвергает).
    assert.match(
      CHRONICLE,
      /chronicleDefinitionForPeriod\(localDayStart\(first\), localDayEnd\(last\)\)/,
      'начало/конец локальных суток месяца — в отборе-дереве',
    );
    assert.ok(
      !/dayCounts\.set\(day\.day, day\.rows\.length\)/.test(CHRONICLE),
      'счётчики больше не берутся из периода-фильтрованной ленты',
    );
  });

  it('день с записями получает индикатор независимо от выделения', () => {
    // 0.10.2 (задача 41ed99ab): число-счётчик заменено столбиком точек слева от
    // номера дня; пороги 50/100 — `calendarDotCount`, класс `cal-dots`.
    assert.match(CALENDAR, /const dots = calendarDotCount\(count\)/);
    assert.match(CALENDAR, /if \(dots > 0\) button\.append\(buildDots\(dots\)\)/);
    assert.match(CALENDAR, /'cal-dots'/);
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
    assert.match(BUILDER, /out\.targets = buildWireFilter/, 'плоская форма targets сохранена для v1');
  });

  it('убранное не вернулось: сторона связи, отдельная группа целей', () => {
    assert.ok(!/Сторона связи/.test(PANEL), '«сторона связи» убрана');
    assert.ok(!/title: 'Критерии целей/.test(PANEL), 'отдельная группа «критерии целей» убрана');
    assert.ok(!/link_scope/.test(PANEL), 'панель не пишет link_scope');
    assert.ok(!/title: 'Поиск'/.test(PANEL), 'секция переименована в «Ключевые слова»');
  });
});
