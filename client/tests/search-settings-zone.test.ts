/**
 * Зона «Настройки поиска» выпадающей панели строки поиска карты (задача
 * a3247f84, 0.8.2; перекомпоновка — задача 4b1cc3d4).
 *
 * Контракт (элемент интерфейса «Строка поиска вида «Карта мыслей»»):
 *  - панель делится на две зоны — «результаты поиска» и «настройки поиска»;
 *  - кнопка-«шестерёнка» рядом со строкой поиска убрана; вместо неё в верхнем
 *    углу панели — кнопка-переключатель с иконкой-лейкой (нажата — настройки
 *    показаны); по умолчанию отжата, нажатость переживает переоткрытие панели
 *    и перезапуск клиента (локальное L4 `ui_state`, как `search_state`);
 *  - ширина окна > 1000 px — настройки справа от результатов (30% ширины
 *    панели), ≤ 1000 px — сверху; положение переключается на ресайзе;
 *  - компоновка настроек (задача 4b1cc3d4): первой строкой — блок «места
 *    поиска» (области FTS), затем единый редактор мыслевых условий (профиль
 *    `thoughts`); поля «Ограничения»/«Автор»/«Редактор» убраны СОВСЕМ
 *    (решение заказчика 2026-10-15);
 *  - внизу зоны — постоянно видимый (не прокручиваемый) подвал команд
 *    «Очистить» и «Добавить отбор…»; прокручивается только тело зоны;
 *  - мыслевые настройки (подкорень, типы, «неактуальные», «корзина») — строки
 *    редактора; корпусные (области поиска) — плоская строка зоны.
 *
 * Клиентские тесты идут без jsdom (конвенция соседних тестов), поэтому чистая
 * логика проверяется напрямую, а привязка слоёв — по якорям исходника и
 * стилей.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  SEARCH_SETTINGS_SIDE_MIN_WIDTH,
  isSearchSettingsOpenStored,
  searchSettingsPlacement,
} from '../src/renderer/lib/pure.js';
import { assembledStylesFile } from './renderer-css.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const SEARCH_TS = resolve(RENDERER, 'search', 'search.ts');
const WORKSPACE_TS = resolve(RENDERER, 'screens', 'workspace.ts');
const STYLES_CSS = assembledStylesFile();
const CONSTANTS_TS = resolve(
  import.meta.dirname,
  '..',
  '..',
  'shared',
  'src',
  'constants.ts',
);

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('переключатель-лейка зоны «Настройки поиска» (задача a3247f84)', () => {
  it('шестерёнки у строки поиска больше нет', () => {
    const workspace = readText(WORKSPACE_TS);
    assert.ok(
      !workspace.includes('searchOptionsButton'),
      'кнопка-шестерёнка рядом со строкой поиска убрана',
    );
    const search = readText(SEARCH_TS);
    assert.ok(
      !search.includes('optionsButton'),
      'chrome панели больше не принимает кнопку опций',
    );
    assert.ok(
      !search.includes('search-options-row'),
      'прежняя строка опций заменена зоной настроек',
    );
  });

  it('лейка (`filter`-иконка) стоит в верхнем углу панели и переключает зону', () => {
    const search = readText(SEARCH_TS);
    assert.match(
      search,
      /svgIcon\('filter'\)/,
      'переключатель несёт иконку-лейку (lucide «filter» — воронка)',
    );
    assert.match(
      search,
      /div\('search-panel-header'\)/,
      'кнопка живёт в заголовочной строке панели (верхний угол)',
    );
    assert.match(
      search,
      /onClick: \(\) => \{\s*setSettingsOpen\(!settingsOpen\);\s*persistSettingsOpen\(\);/,
      'клик по лейке показывает/скрывает зону и сохраняет состояние',
    );
    assert.match(
      search,
      /settingsZone\.classList\.toggle\('hidden', !open\)/,
      'показ зоны — снятие класса hidden',
    );
    assert.match(
      search,
      /settingsToggle\.setAttribute\('aria-pressed', open \? 'true' : 'false'\)/,
      'нажатость отражена в aria-pressed',
    );
    assert.match(search, /let settingsOpen = false;/, 'по умолчанию лейка отжата');
  });

  it('нажатость переживает переоткрытие и перезапуск: локальный `ui_state`, как `search_state`', () => {
    const constants = readText(CONSTANTS_TS);
    assert.match(
      constants,
      /SEARCH_SETTINGS_OPEN: 'search_settings_open'/,
      'ключ L4-состояния объявлен в общем списке ключей клиента',
    );
    const search = readText(SEARCH_TS);
    assert.match(
      search,
      /etn\.ui\s*\.getState\(\s*networkId,\s*UI_STATE_KEY\.SEARCH_SETTINGS_OPEN,?\s*\)/,
      'состояние читается тем же клиентским механизмом, что search_state',
    );
    assert.match(
      search,
      /etn\.ui\s*\.setState\(\s*networkId,\s*UI_STATE_KEY\.SEARCH_SETTINGS_OPEN,\s*settingsOpen \? '1' : '0',?\s*\)/,
      'состояние пишется тем же клиентским механизмом, что search_state',
    );
    assert.match(
      search,
      /void loadSettingsOpen\(\);[\s\S]*?input\.addEventListener\('focus'/,
      'состояние читается при монтировании панели, а не при первом фокусе',
    );
  });

  it('сохранённое состояние читается устойчиво к мусору', () => {
    assert.equal(isSearchSettingsOpenStored(null), false, 'нет записи — отжата');
    assert.equal(isSearchSettingsOpenStored('0'), false);
    assert.equal(isSearchSettingsOpenStored('мусор'), false);
    assert.equal(isSearchSettingsOpenStored('1'), true);
    assert.equal(isSearchSettingsOpenStored('true'), true);
  });
});

describe('положение зоны настроек по ширине окна (задача a3247f84)', () => {
  it('порог — 1000 px: шире — справа, иначе — сверху', () => {
    assert.equal(SEARCH_SETTINGS_SIDE_MIN_WIDTH, 1000);
    assert.equal(searchSettingsPlacement(1600), 'side');
    assert.equal(searchSettingsPlacement(1000 + 1), 'side');
    assert.equal(searchSettingsPlacement(1000), 'top', 'ровно 1000 — уже «сверху»');
    assert.equal(searchSettingsPlacement(700), 'top');
  });

  it('положение переключается на ресайзе, без перезапуска', () => {
    const search = readText(SEARCH_TS);
    // Обработчик ресайза именованный, чтобы его можно было снять на teardown
    // рабочего пространства (ошибка 37b713de); контракт тот же — ресайз окна
    // пересчитывает положение зоны.
    assert.match(
      search,
      /const onWindowResize = \(\): void => \{\s*positionPanel\(\);\s*applySettingsPlacement\(\);/,
      'ресайз окна пересчитывает положение зоны',
    );
    assert.match(
      search,
      /window\.addEventListener\('resize', onWindowResize\);/,
      'обработчик ресайза подписан на window',
    );
    assert.match(
      search,
      /chrome\.host\.classList\.toggle\('search-settings-side', mode === 'side'\)/,
      'положение выражается классом панели',
    );
    assert.match(search, /applySettingsPlacement\(\);\s*void loadSettingsOpen\(\);/);
  });

  it('стили: справа — 30% ширины панели, сверху — во всю ширину', () => {
    const css = readText(STYLES_CSS);
    assert.match(
      css,
      /\.search-panel\.search-settings-side \.search-settings \{\s*flex: 0 0 30%;/,
      'боковая зона занимает 30% ширины панели',
    );
    assert.match(
      css,
      /\.search-panel\.search-settings-top \.search-panel-body \{\s*flex-direction: column;/,
      'узкое окно укладывает зоны в колонку',
    );
    assert.match(
      css,
      /\.search-panel\.search-settings-top \.search-settings \{\s*order: -1;/,
      'в колонке настройки встают СВЕРХУ результатов',
    );
  });
});

describe('прокрутка зон независима (ошибка aa5d0aff; низ зоны — задача 4b1cc3d4)', () => {
  it('панель сама не прокручивается — прокрутка живёт у зон', () => {
    const css = readText(STYLES_CSS);
    assert.match(
      css,
      /\.search-panel \{[^}]*max-height: 50%;[\s\S]*?overflow: hidden;/,
      'панель обрезает содержимое, но не даёт общей полосы прокрутки',
    );
    assert.ok(
      !/\.search-panel \{[^}]*overflow-y: auto;/.test(css),
      'у самой панели нет вертикальной прокрутки — иначе зоны скроллятся вместе',
    );
  });

  it('результаты прокручиваются своей полосой, зона настроек — телом (не сама)', () => {
    const css = readText(STYLES_CSS);
    assert.match(css, /\.search-results \{[^}]*overflow-y: auto;/, 'результаты прокручиваются своей полосой');
    // Зона настроек — flex-колонка без своей прокрутки: полоса у ТЕЛА, поэтому
    // подвал команд не уезжает вместе с условиями (задача 4b1cc3d4).
    assert.match(
      css,
      /\.search-settings \{[^}]*overflow: hidden;/,
      'сама зона настроек не прокручивается',
    );
    assert.ok(
      !/\.search-settings \{[^}]*overflow-y: auto;/.test(css),
      'у зоны настроек нет своей вертикальной прокрутки',
    );
    assert.match(
      css,
      /\.search-settings-body \{[^}]*overflow-y: auto;/,
      'тело зоны настроек прокручивается своей полосой',
    );
  });

  it('подвал команд не прокручивается (flex: 0 0 auto)', () => {
    const css = readText(STYLES_CSS);
    assert.match(
      css,
      /\.search-settings-actions \{[^}]*flex: 0 0 auto;/,
      'подвал команд забирает высоту по содержимому и не уезжает при прокрутке',
    );
  });

  it('сверху высота настроек ограничена, прокручивается их тело', () => {
    const css = readText(STYLES_CSS);
    assert.match(
      css,
      /\.search-panel\.search-settings-top \.search-settings \{[^}]*max-height: min\(240px, 25vh\);/,
      'настройки сверху не выше разумного предела — не съедают результаты',
    );
    assert.ok(
      !/\.search-panel\.search-settings-top \.search-settings \{[^}]*overflow-y: auto;/.test(css),
      'сверху сама зона не прокручивается — прокрутка у её тела',
    );
  });
});

describe('компоновка зоны настроек: места поиска, редактор, подвал команд (задача 4b1cc3d4)', () => {
  it('мыслевые настройки — строки единого редактора (профиль thoughts)', () => {
    const search = readText(SEARCH_TS);
    assert.match(search, /buildFilterEditor\(\{/, 'зона монтирует единый редактор');
    assert.match(search, /profile: 'thoughts'/, 'профиль строки поиска — мысли');
    assert.match(
      search,
      /contextual: \['parents', 'children', 'type', 'active', 'trashed'\]/,
      'подкорень/типы/видимость — операнды редактора',
    );
    assert.match(
      search,
      /title: t\('filterEditor\.titleSearch'\)/,
      'заголовок редактора — свой, из словаря («Отбор мыслей для поиска:»)',
    );
  });

  it('строка «Места поиска» — первая; корпусных полей «Ограничения» нет', () => {
    const search = readText(SEARCH_TS);
    assert.match(search, /span\('Места поиска:', 'search-settings-label'\)/);
    assert.ok(!search.includes("span('Ограничения:'"), 'строки «Ограничения» больше нет');
    assert.equal(
      (search.match(/div\('search-settings-row'\)/g) ?? []).length,
      1,
      'ровно одна плоская строка — места поиска',
    );
    // Порядок зоны: тело собирается как «места поиска → редактор».
    assert.match(
      search,
      /body\.append\(placesRow, searchEditor\.root\)/,
      'места поиска идут ПЕРЕД редактором (первой строкой)',
    );
    assert.match(
      search,
      /zone\.append\(body, actions\)/,
      'зона = прокручиваемое тело + подвал команд',
    );
  });

  it('флажки мест поиска: мысли, связи, хроники (области FTS)', () => {
    const search = readText(SEARCH_TS);
    for (const [label, key] of [
      ["'мысли'", "'onlyThoughts'"],
      ["'связи'", "'onlyLinks'"],
      ["'хроники'", "'onlyChrono'"],
    ] as const) {
      assert.ok(
        search.includes(`mkCheck(${label}, ${key})`),
        `флажок ${label} привязан к ${key}`,
      );
    }
    assert.ok(!search.includes("mkCheck('неактуальные'"), 'неактуальные — строка редактора');
    assert.ok(!search.includes("mkCheck('корзина'"), 'корзина — строка редактора');
  });

  it('корпусные поля сняты совсем (тип связи, Автор, Редактор)', () => {
    const search = readText(SEARCH_TS);
    assert.ok(!search.includes("optionsHeader: 'Типы связей'"), 'поля типов связей нет');
    assert.ok(!search.includes("buildUserSelectWidget({"), 'селектов пользователей нет');
    assert.ok(
      !search.includes("optionsHeader: 'Типы мыслей'"),
      'типы мыслей — строка редактора, а не поле зоны',
    );
  });

  it('при нехватке ширины элементы строки ложатся друг под друга', () => {
    const css = readText(STYLES_CSS);
    assert.match(
      css,
      /\.search-settings-row \{\s*display: flex;\s*flex-wrap: wrap;[\s\S]*?gap: 8px 12px;/,
      'строка настроек переносится и несёт отступы между элементами',
    );
    assert.match(
      css,
      /\.search-settings \{\s*display: flex;\s*flex-direction: column;\s*gap: 10px;/,
      'отступы между блоками задаёт контейнер настроек',
    );
  });
});

describe('единый редактор, подвал команд и запрос поиска (задачи 8f3b2cf2, 4b1cc3d4)', () => {
  it('редактор — общая фабрика, без сортировки и футера; правки применяются', () => {
    const search = readText(SEARCH_TS);
    assert.match(
      search,
      /buildFilterEditor\(\{[\s\S]*?sort: false,[\s\S]*?footer: false,/,
      'у строки поиска нет секции сортировки и футера',
    );
    assert.match(
      search,
      /touch: \(\) => \{\s*persistState\(\);\s*refreshSearchIfVisible\(\);\s*searchEditor\?\.refresh\(\);/,
      'правка мыслевых настроек сохраняется и перезапрашивает результаты',
    );
  });

  it('подвал команд: «Очистить» через handle.clear и меню «Добавить отбор…»', () => {
    const search = readText(SEARCH_TS);
    assert.match(
      search,
      /onClick: \(\) => searchEditor\?\.clear\(\)/,
      '«Очистить» — штатная очистка единого редактора',
    );
    assert.match(search, /openQuickCommandsMenu\(event\)/, 'подменю команд открывается из подвала');
    assert.match(
      search,
      /menuAction\(t\('search\.cmdParentInFocus'\), \(\) => runQuickCommand\('parentInFocus'\)\)/,
      'команда «По родителю в фокусе» — в подменю',
    );
    assert.match(search, /addSearchQuickCondition\(options\.tree \?\? null, SEARCH_QUICK_CONDITIONS\[command\]\(\)\)/,
      'условие команды кладётся в основную группу идемпотентно');
  });

  it('запрос шлёт ast + мысль-фокус, без плоских мыслевых и без корпусных полей', () => {
    const search = readText(SEARCH_TS);
    assert.match(
      search,
      /const focusId = store\.state\.focus\?\.focused\.id \?\? null;/,
      'мысль-фокус читается из состояния карты',
    );
    assert.match(search, /buildSearchAst\(options, focusId\)/, 'мыслевые настройки компилируются в AST');
    assert.match(
      search,
      /\.\.\.\(focusId !== null \? \{ focus_thought_id: focusId \} : \{\}\)/,
      'мысль-фокус едет отдельным параметром запроса (резолв $thought)',
    );
    assert.match(search, /buildSearchCriteriaWire\(options\)/, 'корпусные параметры едут отдельно');
    assert.ok(!/from_thought_id:/.test(search), 'плоский подкорень больше не шлётся');
    assert.ok(!/in: options\.subtree/.test(search), 'плоский `in=subtree` больше не шлётся');
  });

  it('диагностика неразрешённых токенов рисуется над группами результатов', () => {
    const search = readText(SEARCH_TS);
    assert.match(
      search,
      /renderUnresolvedDiagnostics\(resultsBox, response\.unresolved\)/,
      'диагностика `unresolved` показывается пользователю, а не молчит',
    );
    assert.match(
      search,
      /search-diagnostic-warning/,
      'предупреждение о неразрешённых токенах — своим блоком',
    );
  });
});
