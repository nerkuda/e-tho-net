/**
 * Геометрия колонки «Дневника»: панель отбора не выдавливает панель задач и
 * ленту (замечание Н1 репроверки `4b755c93` по задаче `cfb8cb72`, 0.16.1).
 *
 * **Что было не так.** Панель отбора в верхнем положении (442px по содержимому)
 * съедала полотно: колонке центра оставалось 156px, хост панели задач получал
 * высоту 0, панель (304px) переливалась поверх ленты, строки становились
 * некликабельными. `max-height: calc(100% - 160px)` на хосте считался от уже
 * сжатой колонки и давал отрицательное значение. При скрытой панели отбора
 * (колонка 602px) хост тоже схлопывался — потолок не учитывал панель добавления
 * и шов.
 *
 * **Как проверяется.** DOM-шим НЕ считает CSS-раскладку, поэтому регресс
 * держится двумя якорями:
 *  1. Модель с фиксированными высотами контейнеров: резерв
 *     (`tasks-panel-geometry.ts`) → `filterPanelTopLimit` (`lib/pure.ts`) →
 *     остаток колонки → высота хоста и ленты. Для окон реального диапазона
 *     (кадр отбора 500–700px) хост панели задач > 0, а лента не ниже
 *     `feedMin`.
 *  2. Контракт CSS, который эту модель реализует: хост ужимается и прячет
 *     перелив, панель ужимается до хоста и прокручивается сама, панель отбора
 *     ограничена `--fp-results-min`. Мутации «вернуть панели `flex: 0 0 auto`»
 *     и «вернуть хосту процентный `max-height`» краснят эти проверки.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { TASK_LIST_HEIGHT } from '../src/renderer/lib/ui/task-list.js';
import { filterPanelTopLimit } from '../src/renderer/lib/pure.js';
import {
  FILTER_PANEL_SPLITTER_H,
  TASKS_PANEL_SPLITTER_H,
  filterPanelReserve,
  tasksColumnReserve,
  tasksPanelMaxHeight,
} from '../src/renderer/screens/chronicle/tasks-panel-geometry.js';
import { RENDERER_ROOT } from './renderer-css.js';

/** CSS без комментариев: разбираются только правила. */
function cssOf(relativePath: string): string {
  return fs
    .readFileSync(path.join(RENDERER_ROOT, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Тело правила по точному селектору (последнее вхождение). */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
  let body: string | null = null;
  for (const match of css.matchAll(re)) {
    if (match[1] !== undefined) body = match[1];
  }
  assert.ok(body !== null, `правило «${selector}» есть в CSS`);
  return body;
}

/* ---------------------------------------------------------------- *
 * 1. Модель колонки: фиксированные высоты, никакой CSS-раскладки
 * ---------------------------------------------------------------- */

/** Высоты реального замера верификатора (окно 1120×761 и узкое 964×661). */
const MEASURED = {
  frameH: 602,
  addBarH: 62,
  filterContentH: 442,
  panelWantedH: 304,
} as const;

interface Column {
  filterH: number;
  mainH: number;
  hostH: number;
  feedH: number;
}

/**
 * Модель раскладки колонки: панель отбора ограничена резервом, остаток
 * достаётся колонке центра; хост панели задач ужимается до свободного места
 * (панель добавления + шов + минимум ленты), лента получает остаток.
 */
function layout(
  frameH: number,
  addBarH: number,
  panelWantedH: number,
  filterVisible = true,
): Column {
  const reserve = filterPanelReserve(addBarH);
  const filterMax = filterPanelTopLimit(frameH, reserve);
  const filterH = filterVisible ? Math.min(MEASURED.filterContentH, Math.max(80, filterMax)) : 0;
  const mainH = frameH - filterH - (filterVisible ? FILTER_PANEL_SPLITTER_H : 0);
  const hostFree = Math.max(0, mainH - addBarH - TASKS_PANEL_SPLITTER_H - TASK_LIST_HEIGHT.feedMin);
  const hostH = Math.min(panelWantedH, hostFree);
  const feedH = mainH - addBarH - hostH - TASKS_PANEL_SPLITTER_H;
  return { filterH, mainH, hostH, feedH };
}

describe('колонка «Дневника»: резерв под панель задач и ленту', () => {
  it('резерв включает панель добавления, минимум панели задач, швы и минимум ленты', () => {
    assert.equal(
      tasksColumnReserve(MEASURED.addBarH),
      MEASURED.addBarH + TASK_LIST_HEIGHT.min + 6 + TASK_LIST_HEIGHT.feedMin,
      'колонка центра не отдаёт панели отбора место панели задач и ленты',
    );
    assert.equal(
      filterPanelReserve(MEASURED.addBarH),
      tasksColumnReserve(MEASURED.addBarH) + 4,
      'полотно отдаёт панели отбора всё, кроме колонки центра и шва',
    );
    assert.equal(
      filterPanelTopLimit(MEASURED.frameH, filterPanelReserve(MEASURED.addBarH)),
      MEASURED.frameH - filterPanelReserve(MEASURED.addBarH),
      'потолок панели отбора — полотно минус резерв',
    );
    assert.equal(
      filterPanelTopLimit(200, 400),
      0,
      'резерв больше полотна — потолок 0, не отрицательный',
    );
  });

  it('замер верификатора: панель отбора не выдавливает панель задач (Б1-Н)', () => {
    const column = layout(MEASURED.frameH, MEASURED.addBarH, MEASURED.panelWantedH);
    // 602 - (62+120+6+160+4) = 250 панели отбора, 348 колонке центра.
    assert.equal(column.filterH, 250, 'панель отбора сжата до потолка');
    assert.equal(column.mainH, 348, 'колонка центра получила резерв целиком');
    assert.equal(column.hostH, 120, 'хост панели задач не схлопнулся и держит минимум');
    assert.equal(column.feedH, TASK_LIST_HEIGHT.feedMin, 'лента ровно в минимуме');
    assert.ok(column.hostH > 0, 'строки панели задач кликабельны: хост имеет высоту');
    assert.ok(
      column.feedH >= TASK_LIST_HEIGHT.feedMin,
      'лента не уходит в overflow: её низ в рамке колонки',
    );
  });

  it('скрытая панель отбора: панель задач разворачивается, лента не перекрыта', () => {
    const column = layout(MEASURED.frameH, MEASURED.addBarH, MEASURED.panelWantedH, false);
    assert.equal(column.mainH, MEASURED.frameH, 'без панели отбора колонка занимает всё полотно');
    assert.equal(column.hostH, MEASURED.panelWantedH, 'панель задач получает сохранённую высоту');
    assert.ok(column.feedH >= TASK_LIST_HEIGHT.feedMin, 'лента не меньше минимума');
    assert.equal(
      column.hostH + column.feedH + MEASURED.addBarH + TASKS_PANEL_SPLITTER_H,
      column.mainH,
      'панель задач и лента делят колонку без перелива',
    );
  });

  it('узкое окно и диапазон кадров отбора: инвариант колонки держится', () => {
    for (const frameH of [500, 542, 602, 650, 700]) {
      for (const addBarH of [56, 62, 70]) {
        const column = layout(frameH, addBarH, MEASURED.panelWantedH);
        assert.ok(column.hostH > 0, `кадр ${frameH}/addBar ${addBarH}: хост панели задач > 0`);
        assert.ok(
          column.feedH >= TASK_LIST_HEIGHT.feedMin,
          `кадр ${frameH}/addBar ${addBarH}: лента не ниже ${TASK_LIST_HEIGHT.feedMin}px`,
        );
        assert.ok(
          column.hostH + column.feedH + addBarH + TASKS_PANEL_SPLITTER_H <= column.mainH,
          `кадр ${frameH}/addBar ${addBarH}: низ ленты не выходит за колонку`,
        );
      }
    }
  });

  it('потолок слайдера: остаток колонки после панели добавления, шва и ленты', () => {
    assert.equal(tasksPanelMaxHeight(348, MEASURED.addBarH), 120, 'слайдер не уводит ленту в ноль');
    assert.equal(
      tasksPanelMaxHeight(602, MEASURED.addBarH),
      374,
      'потолок панели при скрытом отборе',
    );
    assert.equal(
      tasksPanelMaxHeight(150, MEASURED.addBarH),
      TASK_LIST_HEIGHT.min,
      'ниже минимума панель не опускается даже в тесной колонке',
    );
  });
});

/* ---------------------------------------------------------------- *
 * 2. Контракт CSS, реализующий модель
 * ---------------------------------------------------------------- */

describe('колонка «Дневника»: CSS-контракт', () => {
  const chronicleCss = cssOf(path.join('styles', 'screens', 'chronicle.css'));
  const taskPanelCss = cssOf(path.join('lib', 'ui', 'task-panel.css'));
  const filterCss = cssOf(path.join('styles', 'filter-panel.css'));

  it('хост панели задач ужимается и прячет перелив (нет процентного потолка)', () => {
    const host = ruleBody(chronicleCss, '.chron-tasks-panel-host');
    assert.match(host, /flex:\s*0 1 auto/, 'хост ужимается, когда колонке не хватает места');
    assert.match(host, /min-height:\s*0/, 'ниже нуля не заходит, но сжаться может');
    assert.match(host, /display:\s*flex/, 'хост — колонка для панели');
    assert.match(host, /overflow:\s*hidden/, 'панель не переливается поверх ленты');
    assert.doesNotMatch(
      host,
      /max-height/,
      'процентный max-height не возвращается: он считался от сжатой колонки',
    );
  });

  it('панель задач ужимается до хоста и прокручивается сама', () => {
    const panel = ruleBody(taskPanelCss, '.ui-task-panel');
    assert.match(panel, /flex:\s*1 1 auto/, 'flex-shrink панели — она следует высоте хоста');
    assert.match(panel, /min-height:\s*0/, 'панель обязана мочь сжаться');
    assert.match(panel, /overflow:\s*auto/, 'сжатая панель прокручивает строки внутри себя');
    assert.match(
      panel,
      /height:\s*var\(--task-panel-height, auto\)/,
      'высота из настроек сохранена',
    );
    assert.match(
      panel,
      /max-height:\s*var\(--task-panel-height, 40vh\)/,
      'потолок по умолчанию сохранён',
    );
  });

  it('панель отбора ограничена резервом `--fp-results-min`', () => {
    const top = ruleBody(filterCss, '.fp-host.fp-top > .fp-panel');
    assert.match(
      top,
      /max-height:\s*calc\(100% - var\(--fp-results-min, 160px\)\)/,
      'резерв колонки задаёт экран, фолбэк — 160px',
    );
    const feed = ruleBody(chronicleCss, '.chron-feed-wrap');
    assert.match(
      feed,
      /min-height:\s*var\(--tasks-panel-feed-min, 160px\)/,
      'минимум ленты — тот же, что в резерве',
    );
  });
});
