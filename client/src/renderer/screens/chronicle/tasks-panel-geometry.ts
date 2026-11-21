/**
 * Геометрия колонки центра «Дневника»: сколько места полотно обязано оставить
 * панели задач и ленте (замечания Н1 репроверок `4b755c93` и `7775bca4` по
 * задаче `cfb8cb72`, версия 0.16.1).
 *
 * **Что было не так.** Панель отбора в верхнем положении росла по содержимому
 * (442px) и забирала высоту у `.chron-main`; внутри колонки панель задач имела
 * `flex: 0 0 auto`, то есть не ужималась и переливалась поверх ленты: хост
 * получал высоту 0, строки панели становились некликабельными, лента уходила в
 * overflow. `max-height` хоста `calc(100% - 160px)` считался от уже сжатой
 * колонки (156px) и давал отрицательное значение — он не помогал.
 *
 * **Правило.** Панель отбора получает не всё полотно, а полотно минус резерв
 * ({@link filterPanelReserve}): панель добавления, минимум панели задач, её шов,
 * минимум ленты и шов самой панели отбора. Внутри колонки хост панели задач —
 * `flex: 0 1 auto` с `overflow: hidden`, а сама панель — `flex: 1 1 auto` с
 * `min-height: 0`: она ужимается до высоты хоста и прокручивается внутри.
 * Лента имеет `flex-basis` своего минимума (`--tasks-panel-feed-min`), иначе
 * flex-shrink делит недостаток пропорционально содержимому ленты (~2442px) и
 * хост схлопывается до 31px (репроверка `7775bca4`).
 *
 * **Ограничение резерва.** Резерв не может оставить панель отбора меньше
 * {@link FILTER_PANEL_MIN_H}: при низком полотне содержимое панели (календарь,
 * поиск, дерево, футер) сохраняет рабочие минимумы и прокручивается целиком, а
 * не уничтожается (регрессия `211c2336`: панель 256px давала календарю 8px,
 * дереву — 0).
 *
 * Модуль чистый (только числа и арифметика) — правило проверяется моделью с
 * фиксированными высотами в `tests/chronicle-column-geometry.test.ts`.
 */

import { TASK_LIST_HEIGHT } from '../../lib/ui/task-list.js';

/** Видимый шов-слайдер высоты панели задач (`.chron-tasks-splitter`). */
export const TASKS_PANEL_SPLITTER_H = 6;

/** Шов каркаса панели отбора в верхнем положении (`.fp-splitter`). */
export const FILTER_PANEL_SPLITTER_H = 4;

/**
 * Минимальная рабочая высота панели отбора, px: поиск записей и не менее трёх-
 * четырёх строк дерева условий (`96px`) поверх отступов панели. Меньше этого
 * содержимое отбора перестаёт быть пригодным даже с прокруткой.
 */
export const FILTER_PANEL_MIN_H = 200;

/** Неотрицательная конечная высота, px (мусор от измерений — ноль). */
function height(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Резерв колонки центра под панель задач, её шов и ленту, px. Меньше этого
 * колонка не отдаёт панели отбора: панель задач остаётся хотя бы в своём
 * минимуме (`TASK_LIST_HEIGHT.min`), лента — хотя бы `feedMin`.
 */
export function tasksColumnReserve(addBarHeight: number): number {
  return (
    height(addBarHeight) + TASK_LIST_HEIGHT.min + TASKS_PANEL_SPLITTER_H + TASK_LIST_HEIGHT.feedMin
  );
}

/**
 * Резерв полотна под панелью отбора: колонка центра плюс шов панели отбора, но
 * не больше, чем полотно минус {@link FILTER_PANEL_MIN_H}. Это значение каркас
 * панели отбора ставит в `--fp-results-min` и использует как границу
 * перетаскивания.
 *
 * @param frameHeight фактическая высота полотна (`.chron-frame`), px.
 * @param addBarHeight фактическая высота панели добавления, px.
 */
export function filterPanelReserve(frameHeight: number, addBarHeight: number): number {
  const full = tasksColumnReserve(addBarHeight) + FILTER_PANEL_SPLITTER_H;
  const limit = Math.max(0, height(frameHeight) - FILTER_PANEL_MIN_H);
  return Math.min(full, limit);
}

/**
 * Потолок высоты панели задач по фактической высоте колонки центра, px:
 * остаток после панели добавления, шва и минимума ленты. Ниже минимума слайдер
 * не опускается — иначе панель нечитаема.
 */
export function tasksPanelMaxHeight(mainHeight: number, addBarHeight: number): number {
  const free =
    height(mainHeight) - height(addBarHeight) - TASKS_PANEL_SPLITTER_H - TASK_LIST_HEIGHT.feedMin;
  return Math.max(TASK_LIST_HEIGHT.min, free);
}
