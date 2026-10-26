/**
 * Типы для `ui-probe-point.mjs` (сверка точки ввода GUI-стенда, ошибка af96d388).
 * Декларация нужна юнит-тесту `tests/ui-probe-point.test.ts`: сам модуль —
 * обычный `.mjs` (исполняется `node` без сборки), а тест — TypeScript.
 */

/** Элемент под указателем — то, что вернул `document.elementFromPoint`. */
export interface PointElement {
  tag: string;
  className: string;
  text?: string;
}

/** Диагностика точки в записи отчёта (`entry.click`/`entry.hover`/`drag.fromCheck`). */
export interface PointCheck {
  x: number;
  y: number;
  retries: number;
  mismatched?: boolean;
  under: PointElement | null;
}

/** Точка, не попавшая в цель (для текста провала шага). */
export interface PointMismatch {
  px: number;
  py: number;
  retries?: number;
  hit: PointElement | null;
}

export const POINT_CHECK_ATTEMPTS: number;

export function hitExpression(px: number, py: number, selector: string): string;

export function describeUnder(element: PointElement | null | undefined): string;

export function mismatchMessage(action: string, selector: string, point: PointMismatch): string;

export function pointCheckText(check: PointCheck, mismatchAllowed?: boolean): string;
