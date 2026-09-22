/**
 * Общий каркас панели отбора (задача 2ebe4206): скрываемость, положение по
 * ширине полотна, размер перетаскиванием границы, локальное сохранение.
 *
 * Клиентские тесты идут без jsdom (конвенция соседних тестов), поэтому чистая
 * логика проверяется напрямую, а привязка каркаса к экранам — по якорям
 * исходника и стилей.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_FILTER_PANEL_STATE,
  FILTER_PANEL_SIDE_MIN_WIDTH,
  clampFilterPanelSize,
  filterPanelPlacement,
  parseFilterPanelState,
  serializeFilterPanelState,
} from '../src/renderer/lib/pure.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const FRAME_TS = resolve(RENDERER, 'lib', 'filter-panel-frame.ts');
const STRUCTURES_TS = resolve(RENDERER, 'screens', 'structures', 'structures.ts');
const CHRONICLE_TS = resolve(RENDERER, 'screens', 'chronicle', 'chronicle.ts');
const ACTIVITY_TS = resolve(RENDERER, 'screens', 'activity', 'activity.ts');
const STYLES_CSS = resolve(RENDERER, 'styles.css');
const CONSTANTS_TS = resolve(import.meta.dirname, '..', '..', 'shared', 'src', 'constants.ts');

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('положение панели по ширине полотна (задача 2ebe4206)', () => {
  it('порог — 1000 px: уже полотна панель вверху, шире — слева', () => {
    assert.equal(FILTER_PANEL_SIDE_MIN_WIDTH, 1000);
    assert.equal(filterPanelPlacement(1400), 'side');
    assert.equal(filterPanelPlacement(1000), 'side', 'ровно 1000 — уже «слева»');
    assert.equal(filterPanelPlacement(999), 'top');
    assert.equal(filterPanelPlacement(700), 'top');
  });

  it('ширина полотна — не окно: каркас меряет контейнер вида (минус редактор)', () => {
    const frame = readText(FRAME_TS);
    assert.match(
      frame,
      /filterPanelPlacement\(container\.clientWidth\)/,
      'положение считается по ширине контейнера вида, в котором лежит панель',
    );
  });

  it('положение переключается на ресайзе, без перезапуска', () => {
    const frame = readText(FRAME_TS);
    assert.match(
      frame,
      /new ResizeObserver\(\(\) => apply\(\)\)/,
      'резкое изменение ширины полотна (окно, панель редактора) пересчитывает положение',
    );
    assert.match(frame, /observer\.observe\(container\)/, 'наблюдается контейнер вида');
    assert.match(
      frame,
      /container\.classList\.toggle\('fp-side', [^)]+\)/,
      'боковое положение выражено классом fp-side',
    );
    assert.match(
      frame,
      /container\.classList\.toggle\('fp-top', [^)]+\)/,
      'верхнее положение выражено классом fp-top',
    );
  });
});

describe('скрываемость панели кнопкой (задача 2ebe4206)', () => {
  it('плавающая кнопка с иконками «скрыть»/«показать» и aria-pressed', () => {
    const frame = readText(FRAME_TS);
    assert.match(frame, /svgIcon\(visible \? 'x' : 'filter'\)/, 'иконка отражает действие');
    assert.match(
      frame,
      /toggle\.setAttribute\('aria-pressed', visible \? 'true' : 'false'\)/,
      'нажатость отражена в aria-pressed',
    );
    assert.match(
      frame,
      /visible \? 'Скрыть панель отбора' : 'Показать панель отбора'/,
      'подсказка кнопки зависит от состояния',
    );
    assert.match(frame, /const TOGGLE_CLASS = 'fp-toggle';/, 'кнопка живёт в классе каркаса');
  });

  it('клик переключает панель и сохраняет состояние локально', () => {
    const frame = readText(FRAME_TS);
    assert.match(
      frame,
      /toggle\.addEventListener\('click', \(\) => \{\s*state = \{ \.\.\.state, hidden: !state\.hidden \};\s*apply\(\);\s*persist\(\);/,
      'клик меняет состояние, применяет его и сохраняет',
    );
  });

  it('скрытость и размер переживают перезапуск: L4 `ui_state`, как `search_settings_open`', () => {
    const constants = readText(CONSTANTS_TS);
    for (const key of [
      /STRUCTURES_FILTER_PANEL: 'structures_filter_panel'/,
      /CHRONICLE_FILTER_PANEL: 'chronicle_filter_panel'/,
      /ACTIVITY_FILTER_PANEL: 'activity_filter_panel'/,
    ]) {
      assert.match(constants, key, 'ключ L4-состояния панели объявлен в общих ключах клиента');
    }
    const frame = readText(FRAME_TS);
    assert.match(
      frame,
      /etn\.ui\.getState\(networkId, stateKey\)/,
      'состояние читается тем же клиентским механизмом, что search_state',
    );
    assert.match(
      frame,
      /etn\.ui\.setState\(networkId, stateKey, serializeFilterPanelState\(state\)\)/,
      'состояние пишется тем же клиентским механизмом, что search_state',
    );
    assert.match(frame, /void reload\(\);/, 'состояние читается при монтировании каркаса');
  });

  it('сохранённое состояние читается устойчиво к мусору', () => {
    assert.deepEqual(parseFilterPanelState(null), DEFAULT_FILTER_PANEL_STATE);
    assert.deepEqual(parseFilterPanelState(''), DEFAULT_FILTER_PANEL_STATE);
    assert.deepEqual(parseFilterPanelState('не json'), DEFAULT_FILTER_PANEL_STATE);
    assert.deepEqual(parseFilterPanelState('[1,2]'), DEFAULT_FILTER_PANEL_STATE);
    assert.deepEqual(parseFilterPanelState('{"hidden":"да"}'), DEFAULT_FILTER_PANEL_STATE);
    assert.deepEqual(
      parseFilterPanelState('{"hidden":true,"width":-5,"height":"240"}'),
      { hidden: true, width: null, height: null },
      'нечисловые и отрицательные размеры отбрасываются',
    );
    assert.deepEqual(parseFilterPanelState('{"hidden":true,"width":320.4,"height":180}'), {
      hidden: true,
      width: 320,
      height: 180,
    });
  });

  it('сериализация обратима', () => {
    const state = { hidden: true, width: 333, height: 210 };
    assert.deepEqual(parseFilterPanelState(serializeFilterPanelState(state)), state);
  });
});

describe('размер панели перетаскиванием границы (задача 2ebe4206)', () => {
  it('размер зажат диапазоном экрана', () => {
    assert.equal(clampFilterPanelSize(100, 230, 420), 230);
    assert.equal(clampFilterPanelSize(999, 230, 420), 420);
    assert.equal(clampFilterPanelSize(300.6, 230, 420), 301);
    assert.equal(clampFilterPanelSize(Number.NaN, 80, 800), 80);
  });

  it('в боковом положении тянется ширина, в верхнем — высота', () => {
    const frame = readText(FRAME_TS);
    assert.match(
      frame,
      /placementAtStart === 'top' \? event\.clientY - startPos : event\.clientX - startPos/,
      'дельта берётся по вертикали вверху и по горизонтали слева',
    );
    assert.match(
      frame,
      /placementAtStart === 'top' \? \{ \.\.\.state, height: size \} : \{ \.\.\.state, width: size \}/,
      'измеренный размер пишется в своё поле состояния',
    );
    assert.match(
      frame,
      /apply\(\);\s*persist\(\);\s*\};\s*\n\s*\n\s*splitter\.addEventListener\('pointerdown'/,
      'конец перетаскивания сохраняет размер',
    );
  });

  it('стили: слева — ширина, вверху — высота, направления курсора различаются', () => {
    const css = readText(STYLES_CSS);
    assert.match(
      css,
      /\.fp-host\.fp-side > \.fp-panel \{\s*flex-basis: var\(--fp-size-side/,
      'боковое положение задаёт ширину панели',
    );
    assert.match(
      css,
      /\.fp-host\.fp-top > \.fp-panel \{\s*flex-basis: var\(--fp-size-top/,
      'верхнее положение задаёт высоту панели',
    );
    assert.match(css, /\.fp-host > \.fp-splitter\.fp-side \{\s*cursor: col-resize;/, 'слева граница тянется по горизонтали');
    assert.match(css, /\.fp-host > \.fp-splitter\.fp-top \{\s*cursor: row-resize;/, 'вверху граница тянется по вертикали');
  });
});

describe('свёртываемость групп как в эталоне «Структур» (задача 2ebe4206)', () => {
  it('«Хроника»: группа «Период» сворачивается', () => {
    const src = readText(resolve(RENDERER, 'screens', 'chronicle', 'filter-panel.ts'));
    assert.match(
      src,
      /\{ get: \(\) => periodCollapsed, set: \(v\) => \(periodCollapsed = v\) \}/,
      'период получает своё состояние сворачивания',
    );
    assert.match(src, /let periodCollapsed = true;/, 'по умолчанию свёрнута');
    assert.match(
      src,
      /periodCollapsed = next\.dateFrom === '' && next\.dateTo === '';/,
      'состояние пересчитывается при восстановлении отбора',
    );
  });

  it('«События»: период, пользователь и два словаря сворачиваются', () => {
    const src = readText(ACTIVITY_TS);
    for (const [name, varName] of [
      ['Период', 'periodCollapsed'],
      ['Пользователь', 'authorCollapsed'],
      ['Тип сущности', 'entitiesCollapsed'],
      ['Действие', 'actionsCollapsed'],
    ] as const) {
      assert.match(
        src,
        new RegExp(`get: \\(\\) => ${varName}, set: \\(v\\) => \\(${varName} = v\\)`),
        `группа «${name}» получает своё состояние сворачивания`,
      );
      assert.match(src, new RegExp(`let ${varName} = true;`), `«${name}» по умолчанию свёрнута`);
    }
    // Словари-пилюли получают состояние параметром сборки `collapse`.
    for (const varName of ['entitiesCollapsed', 'actionsCollapsed'] as const) {
      assert.match(
        src,
        new RegExp(`collapse: \\{ get: \\(\\) => ${varName}, set: \\(v\\) => \\(${varName} = v\\) \\}`),
        `словарь сворачивается параметром collapse (${varName})`,
      );
    }
  });

  it('каркас формы умеет сворачивать группу-словарь (параметр сборки)', () => {
    const src = readText(resolve(RENDERER, 'lib', 'filter-form.ts'));
    assert.match(
      src,
      /collapse\?: \{ get: \(\) => boolean; set: \(value: boolean\) => void \};/,
      'у секции-словаря есть параметр сворачивания',
    );
    const pill = /export function buildPillGroupSection[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    assert.match(pill, /collapsible: true/, 'с переданным состоянием группа сворачивается');
  });
});

describe('однообразие: три экрана на одном каркасе (задача 2ebe4206)', () => {
  it('каждый экран монтирует общий каркас со своим ключом состояния', () => {
    const cases: Array<[string, RegExp]> = [
      [STRUCTURES_TS, /stateKey: UI_STATE_KEY\.STRUCTURES_FILTER_PANEL/],
      [CHRONICLE_TS, /stateKey: UI_STATE_KEY\.CHRONICLE_FILTER_PANEL/],
      [ACTIVITY_TS, /stateKey: UI_STATE_KEY\.ACTIVITY_FILTER_PANEL/],
    ];
    for (const [path, anchor] of cases) {
      const src = readText(path);
      assert.match(src, /mountFilterPanelFrame\(\{/, 'экран монтирует общий каркас панели');
      assert.match(src, anchor, 'ключ локального состояния панели — свой у каждого экрана');
    }
  });

  it('своих сплиттеров панели и своих CSS-переменных ширины у экранов больше нет', () => {
    for (const path of [STRUCTURES_TS, CHRONICLE_TS, ACTIVITY_TS]) {
      const src = readText(path);
      assert.ok(
        !src.includes('wirePanelSplitter'),
        'свой сплиттер панели заменён общим каркасом',
      );
    }
    const css = readText(STYLES_CSS);
    assert.ok(
      !css.includes('--st-filter-w'),
      'переменная ширины панели «Структур» больше не используется',
    );
    assert.ok(
      !css.includes('--act-filter-w'),
      'переменная ширины панели «Событий» больше не используется',
    );
  });
});
