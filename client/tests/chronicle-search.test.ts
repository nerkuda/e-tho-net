/**
 * Поиск в ленте «Дневника» и переход к записи (0.10.1, задача T7 2d4481cf;
 * элемент спеки «Поиск в дневниковой ленте» 78b80fe9).
 *
 * Чистые помощники (период записи, задержка применения) проверяются без DOM;
 * привязка debounce, переход (период + прокрутка + подсветка) и временная
 * выборка с плашкой — структурно по исходникам (конвенция соседних клиентских
 * тестов, в т.ч. `chronicle-table-height.test.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { assembledStylesFile } from './renderer-css.js';

import {
  SEARCH_DEBOUNCE_MS,
  localDay,
  recordPeriod,
} from '../src/renderer/screens/chronicle/diary.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

describe('дневник: период записи для перехода (T7)', () => {
  it('точечная запись даёт ровно свои локальные сутки', () => {
    const day = localDay('2026-09-26T12:00:00.000Z');
    const period = recordPeriod({
      valid_from: '2026-09-26T12:00:00.000Z',
      valid_to: '2026-09-26T12:00:00.000Z',
    });
    const from = new Date(period.from);
    const to = new Date(period.to);
    // Границы — начало и конец ЛОКАЛЬНОГО дня наблюдателя (запись у полуночи
    // не выпадает из UTC-суток).
    assert.equal(localDay(period.from), day, 'начало — тот же локальный день');
    assert.equal(localDay(period.to), day, 'конец — тот же локальный день');
    assert.equal(from.getHours(), 0);
    assert.equal(from.getMinutes(), 0);
    assert.equal(to.getHours(), 23);
    assert.equal(to.getMinutes(), 59);
  });

  it('длительная запись разворачивается в диапазон локальных суток', () => {
    const period = recordPeriod({
      valid_from: '2026-09-26T12:00:00.000Z',
      valid_to: '2026-09-28T12:00:00.000Z',
    });
    assert.equal(localDay(period.from), localDay('2026-09-26T12:00:00.000Z'));
    assert.equal(localDay(period.to), localDay('2026-09-28T12:00:00.000Z'));
    assert.ok(period.from < period.to, 'границы по возрастанию');
  });

  it('обратный интервал нормализуется, неразобранная дата даёт пусто', () => {
    const swapped = recordPeriod({
      valid_from: '2026-09-28T12:00:00.000Z',
      valid_to: '2026-09-26T12:00:00.000Z',
    });
    assert.ok(swapped.from < swapped.to, 'перевёрнутый диапазон упорядочен');
    assert.deepEqual(recordPeriod({ valid_from: 'не дата', valid_to: null }), {
      from: '',
      to: '',
    });
    // Открытый конец — одни сутки начала.
    const open = recordPeriod({ valid_from: '2026-09-26T12:00:00.000Z', valid_to: null });
    assert.equal(localDay(open.from), localDay(open.to));
  });
});

describe('дневник: строка поиска с debounce (T7)', () => {
  it('задержка применения задана одним именем', () => {
    assert.equal(SEARCH_DEBOUNCE_MS, 300);
  });

  it('поле поиска применяет отбор через паузу, а не на каждое нажатие', () => {
    const panel = read('screens/chronicle/filter-panel.ts');
    assert.match(panel, /SEARCH_DEBOUNCE_MS/, 'debounce панели использует общую задержку');
    assert.match(panel, /window\.clearTimeout\(searchTimer\)/, 'повторный ввод сбрасывает таймер');
    assert.match(panel, /window\.setTimeout\([\s\S]*actions\.apply\(\)/, 'по паузе запускается применение');
    assert.match(panel, /onInput: \(\) => scheduleSearchApply\(\)/, 'секция поиска подключена к debounce');
    // Критерий — тот же keywords, что и в определении отбора/сохранённого фильтра.
    assert.match(panel, /title: 'Ключевые слова'/, 'секция панели подписана «Ключевые слова»');
    assert.match(panel, /keywords: needle/, 'подсказки ищут записи критерием keywords');
  });

  it('секция поиска даёт источник найденных записей для перехода', () => {
    const panel = read('screens/chronicle/filter-panel.ts');
    assert.match(panel, /extraSources: \[recordSearchSource\(\)\]/, 'источник записей подключён');
    assert.match(panel, /recordId: row\.id/, 'строка несёт id найденной записи');
    assert.match(panel, /onPickEntry:/, 'выбор строки-записи обрабатывает панель');
    // Общий каркас формы поддерживает дополнительные источники и отдаёт выбор хосту.
    const form = read('lib/filter-form.ts');
    assert.match(form, /extraSources\?: readonly SuggestSource\[\]/);
    assert.match(form, /onPickEntry\?: \(entry: SuggestEntry\) => boolean/);
    assert.match(form, /opts\.onPickEntry\?\.\(entry\) === true/, 'хост может перехватить выбор');
    assert.match(form, /opts\.onInput\?\.\(input\.value\)/, 'поле сообщает хосту каждый ввод');
    // У строки подсказки есть поле id записи.
    assert.match(read('lib/suggest-dropdown.ts'), /recordId\?: string/);
  });
});

describe('дневник: переход к записи (0.10.1, задача 46057359)', () => {
  const src = read('screens/chronicle/chronicle.ts');

  it('период панели берётся из даты начала записи и применяется программно', () => {
    assert.match(src, /const startDay = localDay\(row\.valid_from\)/, 'дата начала записи');
    assert.match(
      src,
      /from: localDayStart\(startDay\), to: localDayEnd\(startDay\)/,
      'границы — локальные сутки даты начала',
    );
    assert.match(src, /applyPeriodToFilter\(getFilterState\(\), period\)/, 'дата начала подставляется в отбор');
    assert.match(src, /jumpToRecord: \(row\) => void jumpToRecord\(row\)/, 'строка поиска вызывает переход');
  });

  it('лента прокручивается к записи, делает её текущей и подсвечивает', () => {
    assert.match(src, /scrollIntoView\(\{ block: 'center' \}\)/, 'прокрутка к карточке записи');
    assert.match(src, /diary-record-target/, 'карточка перехода получает класс подсветки');
    assert.match(src, /jumpHighlightId = id/, 'подсвеченная запись запоминается');
    assert.match(src, /feedNav\?\.selectRecord\(id, day\)/, 'запись становится текущей лентой');
  });

  it('запись вне отбора: отбор сбрасывается, дата начала остаётся', () => {
    assert.match(src, /if \(await loadUntilRecord\(row\.id\)\)/, 'сначала запись ищется в текущем отборе');
    assert.match(src, /const fresh = defaultChronicleCriteriaState\(\)/, 'не прошла — отбор сбрасывается');
    assert.match(src, /setSavedFilterId\(null\)/, 'сохранённый отбор снимается');
    assert.match(src, /await loadUntilRecord\(row\.id\)/, 'лента догружается до записи');
    assert.ok(
      !src.includes('startTemporarySelection'),
      'временной выборки с плашкой больше нет (решение пользователя 2026-09-27)',
    );
  });
});

describe('дневник: стили подсветки (0.10.1)', () => {
  it('подсветка записи описана в стилях экрана', () => {
    const css = readFileSync(assembledStylesFile(), 'utf8');
    assert.match(css, /\.diary-record-target\s*\{/, 'стиль подсветки записи');
    assert.match(css, /\.diary-body mark\s*\{/, 'подсветка совпадений в тексте записи');
  });
});
