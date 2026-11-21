/**
 * Геометрия колонки «Дневника»: панель отбора не выдавливает панель задач и
 * ленту, а содержимое отбора не уничтожается (замечания Н1 репроверок
 * `4b755c93` и `7775bca4` по задаче `cfb8cb72`, 0.16.1).
 *
 * **Что было не так — два механизма.**
 *  1. `.chron-feed-wrap` имел `flex: 1 1 auto`: базис — высота содержимого ленты
 *     (~2442px), поэтому flex-shrink делил недостаток пропорционально ему и хост
 *     панели задач получал 31px вместо 120. Живой эксперимент верификатора:
 *     `feed.flexBasis = '0px'` → хост 120, лента 160.
 *  2. Резерв `--fp-results-min` (346px) не был ограничен минимальной рабочей
 *     высотой панели отбора: на кадре 602 панель получала 256px, календарь
 *     сжимался до 8px, дерево условий — до 0 (`clientH 0 / scrollH 226`).
 *
 * **Как проверяется.** DOM-шим НЕ считает CSS-раскладку, поэтому регресс
 * держится тремя якорями:
 *  1. Модель flex-арифметики колонки с фиксированными высотами: `flex-basis`
 *     ленты — её минимум, shrink пропорционален базисам, `min-height` ленты
 *     замораживает её на минимуме, и хост получает остаток. Модель воспроизводит
 *     живой замер (host 120 / feed 160) и живой эксперимент с `basis: 0`, а её
 *     числа сверены с раскладкой Chromium на offscreen-стенде той же структуры
 *     (кадр 602: host 120 / feed 160 / календарь 140 / дерево 96; кадр 502:
 *     host 76 / feed 160 / панель отбора 200).
 *  2. Ограничение резерва: панель отбора никогда не ниже
 *     `FILTER_PANEL_MIN_H` даже на низком полотне.
 *  3. Контракт CSS, который эту модель реализует: базис ленты от минимума,
 *     рабочие минимумы календаря и дерева, прокрутка самой панели отбора,
 *     резерв `--fp-results-min`. Мутации «вернуть ленте `flex: 1 1 auto`»,
 *     «снять кап резерва» и «снять минимум календаря» краснят тесты.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { TASK_LIST_HEIGHT } from '../src/renderer/lib/ui/task-list.js';
import { filterPanelTopLimit } from '../src/renderer/lib/pure.js';
import {
  FILTER_PANEL_MIN_H,
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
 * 1. Модель колонки: flex-арифметика на фиксированных высотах
 * ---------------------------------------------------------------- */

/** Замеры верификатора: окно 1264×761, кадр 602, панель добавления 56. */
const MEASURED = {
  frameH: 602,
  addBarH: 56,
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
 * Модель колонки. Панель отбора ограничена резервом (с капом), остаток — колонка
 * центра. Внутри колонки панель задач и лента делят место по flex-правилам:
 * базисы `panelWanted` и `feedMin`, shrink пропорционален базису, лента
 * заморожена на `min-height`, остаток недостатка забирает панель.
 */
function layout(
  frameH: number,
  addBarH: number,
  panelWantedH: number,
  filterVisible = true,
): Column {
  const reserve = filterPanelReserve(frameH, addBarH);
  const filterMax = filterPanelTopLimit(frameH, reserve);
  const filterH = filterVisible ? Math.min(MEASURED.filterContentH, Math.max(80, filterMax)) : 0;
  const mainH = frameH - filterH - (filterVisible ? FILTER_PANEL_SPLITTER_H : 0);

  const feedMin = TASK_LIST_HEIGHT.feedMin;
  const free = mainH - addBarH - TASKS_PANEL_SPLITTER_H;
  // Базис ленты — её минимум (chronicle.css `flex: 1 1 var(--…feed-min)`).
  const feedBasis = feedMin;
  const hostBasis = panelWantedH;
  const deficit = hostBasis + feedBasis - free;
  let hostH: number = hostBasis;
  let feedH: number = feedBasis;
  if (deficit <= 0) {
    feedH = feedBasis + Math.max(0, free - hostBasis - feedBasis);
  } else {
    const feedShare = (deficit * feedBasis) / (hostBasis + feedBasis);
    const feedShrink = Math.min(feedBasis - feedMin, feedShare);
    const hostShrink = deficit - feedShrink;
    hostH = Math.max(0, hostBasis - hostShrink);
    feedH = Math.max(feedMin, feedBasis - feedShrink);
  }
  return { filterH, mainH, hostH, feedH };
}

describe('колонка «Дневника»: резерв и flex-арифметика', () => {
  it('резерв включает панель добавления, минимум панели задач, швы и минимум ленты', () => {
    assert.equal(
      tasksColumnReserve(MEASURED.addBarH),
      MEASURED.addBarH + TASK_LIST_HEIGHT.min + 6 + TASK_LIST_HEIGHT.feedMin,
      'колонка центра не отдаёт панели отбора место панели задач и ленты',
    );
    assert.equal(
      filterPanelReserve(MEASURED.frameH, MEASURED.addBarH),
      tasksColumnReserve(MEASURED.addBarH) + 4,
      'на обычном полотне резерв — колонка центра плюс шов отбора',
    );
    assert.equal(
      filterPanelTopLimit(MEASURED.frameH, filterPanelReserve(MEASURED.frameH, MEASURED.addBarH)),
      MEASURED.frameH - filterPanelReserve(MEASURED.frameH, MEASURED.addBarH),
      'потолок панели отбора — полотно минус резерв',
    );
    assert.equal(
      filterPanelTopLimit(200, 400),
      0,
      'резерв больше полотна — потолок 0, не отрицательный',
    );
  });

  it('резерв ограничен рабочей высотой отбора: панель не давится ниже `FILTER_PANEL_MIN_H`', () => {
    // Низкое полотно: полный резерв 346 оставил бы отбору 156px.
    assert.equal(
      filterPanelReserve(502, MEASURED.addBarH),
      502 - FILTER_PANEL_MIN_H,
      'резерв не съедает последнюю рабочую высоту панели отбора',
    );
    assert.ok(
      filterPanelReserve(502, MEASURED.addBarH) < tasksColumnReserve(MEASURED.addBarH) + 4,
      'кап действительно срабатывает на низком полотне',
    );
    assert.equal(
      filterPanelReserve(MEASURED.frameH, MEASURED.addBarH),
      tasksColumnReserve(MEASURED.addBarH) + 4,
      'на обычном полотне кап не срабатывает — резерв полный',
    );
    const column = layout(502, MEASURED.addBarH, MEASURED.panelWantedH);
    assert.equal(column.filterH, FILTER_PANEL_MIN_H, 'панель отбора — ровно рабочая высота');
  });

  it('замер верификатора: базис ленты — минимум, хост получает 120, лента 160 (Б1-Н)', () => {
    const column = layout(MEASURED.frameH, MEASURED.addBarH, MEASURED.panelWantedH);
    // 602 - 346 = 256 панели отбора, 342 колонке центра.
    assert.equal(column.filterH, 256, 'панель отбора сжата до резерва');
    assert.equal(column.mainH, 342, 'колонка центра получила резерв целиком');
    assert.equal(column.hostH, 120, 'хост панели задач — минимум, а не 31');
    assert.equal(column.feedH, TASK_LIST_HEIGHT.feedMin, 'лента ровно в минимуме');
    assert.ok(column.hostH > 0, 'строки панели задач кликабельны: хост имеет высоту');
    assert.ok(
      column.feedH >= TASK_LIST_HEIGHT.feedMin,
      'лента не уходит в overflow: её низ в рамке колонки',
    );
  });

  it('живой эксперимент верификатора: с базисом `auto` хост схлопывается — модель его воспроизводит', () => {
    // С `flex: 1 1 auto` базис ленты — её содержимое (~2442px), shrink
    // пропорционален базису: хост получает 31px. Это и был живой дефект.
    const free = 342 - MEASURED.addBarH - TASKS_PANEL_SPLITTER_H;
    const contentBasis = 2442;
    const hostBasis = MEASURED.panelWantedH;
    const deficit = hostBasis + contentBasis - free;
    const hostH = hostBasis - (deficit * hostBasis) / (hostBasis + contentBasis);
    assert.ok(
      Math.round(hostH) >= 30 && Math.round(hostH) <= 32,
      `содержимое ленты как базис даёт hostH ≈ 31 (получено ${Math.round(hostH)})`,
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

  it('узкое окно и диапазон кадров отбора: инвариант колонки и отбора держится', () => {
    for (const frameH of [500, 542, 602, 650, 700]) {
      for (const addBarH of [56, 62, 70]) {
        const column = layout(frameH, addBarH, MEASURED.panelWantedH);
        assert.ok(
          column.filterH >= FILTER_PANEL_MIN_H,
          `кадр ${frameH}/addBar ${addBarH}: панель отбора не ниже рабочей высоты`,
        );
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
    assert.equal(tasksPanelMaxHeight(342, MEASURED.addBarH), 120, 'слайдер не уводит ленту в ноль');
    assert.equal(
      tasksPanelMaxHeight(602, MEASURED.addBarH),
      380,
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

  it('базис ленты — её минимум, а не высота содержимого', () => {
    const feed = ruleBody(chronicleCss, '.chron-feed-wrap');
    assert.match(
      feed,
      /flex:\s*1 1 var\(--tasks-panel-feed-min, 160px\)/,
      'flex-basis ленты — минимум: иначе shrink считается от ~2442px содержимого',
    );
    assert.match(
      feed,
      /min-height:\s*var\(--tasks-panel-feed-min, 160px\)/,
      'минимум ленты — тот же, что в резерве',
    );
    assert.doesNotMatch(feed, /flex:\s*1 1 auto/, 'базис auto не возвращается');
  });

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

  it('панель отбора сохраняет рабочую высоту содержимого', () => {
    const top = ruleBody(filterCss, '.fp-host.fp-top > .fp-panel');
    assert.match(
      top,
      /max-height:\s*calc\(100% - var\(--fp-results-min, 160px\)\)/,
      'резерв колонки задаёт экран, фолбэк — 160px',
    );
    const area = ruleBody(chronicleCss, '.chron-filter-area');
    assert.match(area, /overflow-y:\s*auto/, 'сжатая панель отбора прокручивается целиком');
    const calendar = ruleBody(chronicleCss, '.chron-cal');
    assert.match(
      calendar,
      /min-height:\s*140px/,
      'календарь не давится до 8px: рабочий минимум и своя прокрутка',
    );
    const tree = ruleBody(chronicleCss, '.chron-filter .fe > .ft');
    assert.match(tree, /min-height:\s*96px/, 'дерево условий не давится до 0');
  });
});
