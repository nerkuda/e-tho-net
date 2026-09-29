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
    assert.match(PANEL, /header: \[\.\.\.headerNodes\]/, 'панель кладёт header перед секциями');
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

describe('приёмка «Дневника» 0.10.1: псевдо-запись по заголовку (пункт 4)', () => {
  it('blur заголовка создаёт запись без обходной меры-пробела', () => {
    // Заголовок слота — общий компонент (ошибка 36c330a3): и `Enter`, и `blur`
    // завершают правку и зовут `ensureSlot` с введённым заголовком.
    assert.match(CHRONICLE, /void ensureSlot\(\{ title: next \}\)/);
    assert.match(CHRONICLE, /body_md: body\b/, 'пустой текст отправляется как есть');
    assert.ok(!/\?\s*'\s'\s*:\s*body/.test(CHRONICLE), 'обходная мера «пробел» снята');
  });
});

describe('приёмка «Дневника» 0.10.1: счётчики календаря (пункт 5)', () => {
  it('счётчики считаются отдельным запросом по месяцу, без периода', () => {
    assert.match(CHRONICLE, /async function refreshCalendarCounts\(\)/);
    // Границы месяца — ЛОКАЛЬНЫЕ сутки (приёмка №4, задача fd9eef49): «голая
    // дата» на сервере = сутки UTC и запись у локальной полуночи выпадала бы
    // из счётчиков месяца.
    assert.match(CHRONICLE, /date_from: localDayStart\(first\)/, 'начало локальных суток месяца');
    assert.match(CHRONICLE, /date_to: localDayEnd\(last\)/, 'конец локальных суток месяца');
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
  it('период — панельный вариант с режимами «Пресеты»/«Даты» и виджетом «список + сдвиг»', () => {
    assert.match(PANEL, /variant: 'panel'/);
    assert.match(PERIOD_EDITOR, /variant === 'panel'/);
    assert.match(PERIOD_EDITOR, /pe-preset-bound/, 'строка пресет-границы');
    // Приёмка №3 (0.10.1): составная выпадашка пресетов убрана — её место
    // заняли комбобокс базовых пресетов и сдвиг ±N в каждой границе.
    assert.ok(!/pe-presets/.test(PERIOD_EDITOR), 'составной выпадашки пресетов нет');
    assert.ok(!/periodPresets/.test(PERIOD_EDITOR), 'список составных пресетов удалён');
  });

  it('секции идут набором «Структур», критерии целей — в targets', () => {
    for (const title of [
      'Ключевые слова',
      'Типы мыслей',
      'Типы связей',
      'Родительские мысли',
      'Дополнительно',
    ]) {
      assert.ok(PANEL.includes(`'${title}'`), `секция «${title}» на месте`);
    }
    assert.match(PANEL, /showScope: true/, 'чекбоксы области поиска');
    assert.match(PANEL, /targetsCtx/, 'критерии целей — вложенной моделью targets');
    assert.match(BUILDER, /out\.targets = buildWireFilter/, 'targets едет общим конвертером');
  });

  it('убранное не вернулось: сторона связи, отдельная группа целей', () => {
    assert.ok(!/Сторона связи/.test(PANEL), '«сторона связи» убрана');
    assert.ok(!/title: 'Критерии целей/.test(PANEL), 'отдельная группа «критерии целей» убрана');
    assert.ok(!/link_scope/.test(PANEL), 'панель не пишет link_scope');
    assert.ok(!/title: 'Поиск'/.test(PANEL), 'секция переименована в «Ключевые слова»');
  });
});
