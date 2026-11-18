/**
 * Геометрия колонки центра «Дневника»: сколько места полотно обязано оставить
 * панели задач и ленте (замечание Н1 репроверки `4b755c93` по задаче
 * `cfb8cb72`, версия 0.16.1).
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
 *
 * Модуль чистый (только числа и арифметика) — правило проверяется моделью с
 * фиксированными высотами в `tests/chronicle-column-geometry.test.ts`.
 */

import { TASK_LIST_HEIGHT } from '../../lib/ui/task-list.js';

/** Видимый шов-слайдер высоты панели задач (`.chron-tasks-splitter`). */
export const TASKS_PANEL_SPLITTER_H = 6;

/** Шов каркаса панели отбора в верхнем положении (`.fp-splitter`). */
export const FILTER_PANEL_SPLITTER_H = 4;

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
 * Резерв полотна под панелью отбора: колонка центра плюс шов панели отбора.
 * Это значение каркас панели отбора ставит в `--fp-results-min`.
 */
export function filterPanelReserve(addBarHeight: number): number {
  return tasksColumnReserve(addBarHeight) + FILTER_PANEL_SPLITTER_H;
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
