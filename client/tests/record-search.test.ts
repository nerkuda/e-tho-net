/**
 * Строка поиска дневниковых записей (0.10.1, задача 46057359).
 *
 * Проверяется по пунктам DoD:
 *  1) строка — над панелью отбора и лентой, во всю ширину области дневника;
 *  2) выпадающий список совпадений по мере набора, правила — как у строки
 *     поиска карты (мини-синтаксис keywords, debounce, клавиатура), ищет только
 *     записи;
 *  3) кнопка настроек как у карты, две опции — «неактивные мысли»/«корзина»;
 *  4) выбор результата: сброс отбора, дата начала, текущая запись, догрузка;
 *  6) строка — переиспользуемый компонент с общей моделью настроек.
 *
 * Чистая логика (настройки и клиентский отбор результатов) — обычными
 * юнит-тестами; привязка слоёв — структурно по исходникам и стилям (конвенция
 * соседних клиентских тестов: `search-results-zone.test.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { assembledStylesFile } from './renderer-css.js';

import {
  RECORD_SEARCH_DEBOUNCE_MS,
  RECORD_SEARCH_MAX_RESULTS,
  RECORD_SEARCH_MIN_QUERY,
  defaultRecordSearchSettings,
  parseRecordSearchSettings,
  recordVisibleBySettings,
  serializeRecordSearchSettings,
} from '../src/renderer/lib/record-search.js';
import type { ChronicleRow, ThoughtRef } from '@etn/shared';

import {
  buildChronicleWire,
  defaultChronicleCriteriaState,
} from '../src/renderer/lib/filter-builder.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

/** Минимальная мысль-цель записи. */
function thought(active: boolean, marked: boolean): ThoughtRef {
  return {
    id: `t-${active}-${marked}`,
    title: 'Мысль',
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active,
    marked_for_deletion: marked,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
  };
}

/** Запись с заданными мыслями-целями. */
function record(thoughts: ThoughtRef[]): ChronicleRow {
  return {
    id: 'r1',
    title: null,
    valid_from: '2026-09-27T10:00:00.000Z',
    valid_to: null,
    use_time: false,
    version: 1,
    created_at: '2026-09-27T10:00:00.000Z',
    updated_at: '2026-09-27T10:00:00.000Z',
    created_by: 'u',
    updated_by: 'u',
    snippet: '',
    body_html: '',
    targets: thoughts.map((t) => ({ kind: 'thought' as const, thought: t })),
  };
}

describe('строка поиска записей: модель настроек', () => {
  it('по умолчанию скрытые мысли не включаются', () => {
    assert.deepEqual(defaultRecordSearchSettings(), {
      includeInactive: false,
      includeTrashed: false,
    });
  });

  it('парсер и сериализатор — обратные друг другу', () => {
    const settings = { includeInactive: true, includeTrashed: false };
    assert.deepEqual(parseRecordSearchSettings(JSON.parse(serializeRecordSearchSettings(settings))), settings);
    assert.deepEqual(parseRecordSearchSettings(null), defaultRecordSearchSettings());
    assert.deepEqual(parseRecordSearchSettings('мусор'), defaultRecordSearchSettings());
    assert.deepEqual(parseRecordSearchSettings({ includeTrashed: true }), {
      includeInactive: false,
      includeTrashed: true,
    });
  });

  it('константы поиска заданы одним именем', () => {
    assert.equal(RECORD_SEARCH_MIN_QUERY, 3);
    assert.equal(RECORD_SEARCH_DEBOUNCE_MS, 250);
    assert.ok(RECORD_SEARCH_MAX_RESULTS >= 10);
  });
});

describe('строка поиска записей: клиентский отбор по настройкам', () => {
  it('неактуальная мысль-цель скрывает запись, пока опция выключена', () => {
    const row = record([thought(false, false)]);
    assert.equal(recordVisibleBySettings(row, defaultRecordSearchSettings()), false);
    assert.equal(
      recordVisibleBySettings(row, { includeInactive: true, includeTrashed: false }),
      true,
    );
  });

  it('мысль из корзины скрывает запись, пока опция выключена', () => {
    const row = record([thought(true, true)]);
    assert.equal(recordVisibleBySettings(row, defaultRecordSearchSettings()), false);
    assert.equal(
      recordVisibleBySettings(row, { includeInactive: false, includeTrashed: true }),
      true,
    );
  });

  it('запись с активными мыслями проходит всегда; без мыслей — тоже', () => {
    assert.equal(recordVisibleBySettings(record([thought(true, false)]), defaultRecordSearchSettings()), true);
    assert.equal(recordVisibleBySettings(record([]), defaultRecordSearchSettings()), true);
  });

  it('запись с HOME (активный) и неактивной мыслью скрывается, пока опция выключена', () => {
    const row = record([thought(true, false), thought(false, false)]);
    assert.equal(recordVisibleBySettings(row, defaultRecordSearchSettings()), false);
    assert.equal(recordVisibleBySettings(row, { includeInactive: true, includeTrashed: false }), true);
  });
});

describe('строка поиска записей: компонент (DoD 2, 3, 6)', () => {
  const src = read('lib/record-search.ts');

  it('ищет записи, а не мысли: мини-синтаксис keywords и debounce', () => {
    assert.match(src, /RECORD_SEARCH_DEBOUNCE_MS/, 'задержка живого поиска');
    assert.match(src, /window\.setTimeout\([\s\S]*RECORD_SEARCH_DEBOUNCE_MS/, 'ввод применяется через паузу');
    assert.match(src, /await opts\.search\(query, settings\)/, 'поиск делегируется хозяину экрана');
  });

  it('клавиатура и Enter работают по выпадающему списку, как у карты', () => {
    assert.match(src, /event\.key === 'Enter'/, 'Enter выбирает строку/повторяет поиск');
    assert.match(src, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'/, 'стрелки по результатам');
    assert.match(src, /event\.ctrlKey && \(event\.key === 'ArrowUp'/, 'Ctrl+↑/↓ — к первой/последней');
    assert.match(src, /event\.key === 'Escape'/, 'Esc закрывает панель');
    assert.match(src, /watchOutsideTap\(/, 'закрытие вне — общая механика lib/ui');
    assert.match(src, /searchPanelClosesOnTap\(\{/, 'политика «что удерживает панель» — общий предикат');
  });

  it('настройки — кнопка как у карты и две опции (неактивные/корзина)', () => {
    assert.match(src, /class: 'search-settings-toggle'/, 'кнопка-лейка, как у строки поиска карты');
    assert.match(src, /t\('recordSearch\.includeInactive'\)/, 'опция «включать неактивные мысли»');
    assert.match(src, /t\('recordSearch\.includeTrashed'\)/, 'опция «включать корзину»');
    assert.match(src, /searchSettingsPlacement\(window\.innerWidth\)/, 'размещение зоны по ширине — как у карты');
    assert.match(src, /recordVisibleBySettings\(row, settings\)/, 'настройки применяются к результатам');
  });

  it('панель выпадающих результатов — общие классы строки поиска', () => {
    assert.match(src, /div\('search-panel record-search-panel hidden'\)/, 'панель — общий класс `search-panel`');
    assert.match(src, /div\('search-results'\)/, 'зона результатов — общая');
    assert.match(src, /div\('search-settings'\)/, 'зона настроек — общая');
  });
});

describe('строка поиска записей: встраивание в «Дневник» (DoD 1, 4)', () => {
  const src = read('screens/chronicle/chronicle.ts');

  it('строка — над панелью отбора и лентой, на всю ширину области', () => {
    assert.match(src, /const searchArea = div\('chron-search-area'\)/, 'хост строки поиска');
    assert.match(src, /hostEl\.append\(searchArea, frameHost\)/, 'строка идёт первой, выше каркаса');
    assert.match(src, /frameHost\.append\(filterArea, splitter, main\)/, 'панель и лента — внутри каркаса');
    assert.match(src, /mountRecordSearch\(searchArea, \{/, 'строка собирается общим компонентом');
  });

  it('выбор результата — единый переход к записи', () => {
    assert.match(src, /onPick: \(row\) => void jumpToRecord\(row\)/, 'выбор строки ведёт к переходу');
    assert.match(
      src,
      /search: \(query\) => searchRecords\(query\)/,
      'поиск — по дневниковым записям',
    );
    assert.match(src, /etn\.chronicle\.query\(networkId, \{/, 'записи берутся из хроники');
  });

  it('настройки строки персистятся в L4 по общему ключу', () => {
    assert.match(src, /UI_STATE_KEY\.RECORD_SEARCH/, 'ключ L4 `record_search`');
    assert.match(src, /parseRecordSearchSettings\(JSON\.parse\(raw\)\)/, 'настройки читаются общим парсером');
    assert.match(src, /serializeRecordSearchSettings\(settings\)/, 'настройки пишутся общим сериализатором');
  });

  it('строка поиска всегда ищет по тексту записи — scope с comment (задача 46057359)', () => {
    assert.match(src, /keyword_scope: \[\.\.\.STRUCTURE_KEYWORD_SCOPES\]/, 'передаются все области, включая comment');
    assert.match(src, /STRUCTURE_KEYWORD_SCOPES/, 'области — из shared-словаря, не литералы');
  });
});

describe('панель отбора «Дневника»: область ключевых слов (задача 46057359)', () => {
  it('все три области → scope не сужается (comment включён серверным значением)', () => {
    const def = buildChronicleWire({ ...defaultChronicleCriteriaState(), keywords: 'x' });
    assert.equal(def.keyword_scope, undefined, 'все области — серверное значение по умолчанию');
  });

  it('снятый «комментарий» → scope без comment (текст записи не ищется)', () => {
    const state = defaultChronicleCriteriaState();
    state.keywords = 'x';
    state.keywordInComment = false;
    assert.deepEqual(buildChronicleWire(state).keyword_scope, ['title', 'synonyms']);
  });
});

describe('строка поиска записей: стили (DoD 1)', () => {
  it('в стилях есть строка, каркас и панель результатов', () => {
    const css = readFileSync(assembledStylesFile(), 'utf8');
    assert.match(css, /\.record-search\s*\{/, 'вид строки поиска');
    assert.match(css, /\.chron-frame\s*\{/, 'каркас панели и ленты под строкой');
    assert.match(css, /\.record-search \.search-panel\.record-search-panel\s*\{/, 'панель результатов под строкой');
  });
});
