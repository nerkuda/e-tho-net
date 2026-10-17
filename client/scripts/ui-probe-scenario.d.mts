/**
 * Типы для `ui-probe-scenario.mjs` (стенд UI-проверок, задача 5c5b30e2).
 * Декларация нужна юнит-тесту `tests/ui-probe-scenario.test.ts`: сам модуль —
 * обычный `.mjs` (исполняется `node` без сборки), а тест — TypeScript.
 */

export type StepKind =
  | 'key'
  | 'click'
  | 'hover'
  | 'drag'
  | 'text'
  | 'waitFor'
  | 'probe'
  | 'shot'
  | 'assert'
  | 'api'
  | 'eval';

export type RegionCheckKind = 'notBlank' | 'colorAt' | 'hasColor' | 'distinct';

/** Нормализованная проверка региона шага `assert`. */
export type RegionCheck =
  | { kind: 'notBlank'; name: string; minRatio: number; tolerance: number }
  | { kind: 'colorAt'; name: string; at: [number, number]; color: string; tolerance: number }
  | { kind: 'hasColor'; name: string; color: string; tolerance: number; minPixels: number }
  | { kind: 'distinct'; name: string; minColors: number };

export interface NormalizedAssert {
  name: string;
  region: NormalizedClip;
  checks: RegionCheck[];
  evidence: boolean;
}

export interface NormalizedApi {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  expression: string | null;
  /** Необязательное JSON-тело запроса (засев/изменение данных из сценария). */
  body?: Record<string, unknown>;
}

/** Прямоугольник обрезки снимка в координатах вьюпорта, CSS-пиксели. */
export interface ClipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Нормализованная обрезка: селектор элемента либо прямоугольник во вьюпорте.
 * Входные формы (строка / [x,y,w,h] / {x,y,width,height}) приводятся к ним.
 */
export type NormalizedClip = { selector: string } | ClipRect;

/** Нормализованное описание клавиши (`modifiers` — битовая маска CDP). */
export interface NormalizedKey {
  key: string;
  code: string;
  keyCode: number;
  modifiers: number;
}

export interface NormalizedClick {
  selector: string | null;
  at: [number, number] | null;
  x: number | null;
  y: number | null;
  /** Число последовательных нажатий (2 — двойной клик; по умолчанию 1). */
  count: number;
}

/** Точка жеста `drag` (та же форма, что у click/hover, без `count`). */
export interface NormalizedDragPoint {
  selector: string | null;
  at: [number, number] | null;
  x: number | null;
  y: number | null;
}

/** Составной жест перетаскивания (pointerdown → mouseMoved × N → pointerup). */
export interface NormalizedDrag {
  from: NormalizedDragPoint;
  to: NormalizedDragPoint;
  /** Селектор, обязанный быть под указателем в точке отпускания. */
  expect: string;
  steps: number;
  /** Длительность серии перемещений, мс. */
  duration: number;
  /** Битовая маска CDP (Shift = 8 — копирование). */
  modifiers: number;
  /** Сколько ждать попадания в цель до отпускания, мс. */
  targetTimeout: number;
}

export interface NormalizedWaitFor {
  expression: string | null;
  frames: number;
}

export interface NormalizedExpression {
  name: string;
  expression: string;
}

export interface NormalizedShot {
  file: string;
  clip: NormalizedClip | null;
}

export interface ScenarioStep {
  index: number;
  kind: StepKind;
  name: string;
  timeout: number;
  expect?: unknown;
  /**
   * Ожидание-снимок: имя ранее выполненного шага `probe`/`api`, чьё значение
   * становится ожиданием этого шага (самопроверка «до ↔ после»). Взаимоисключающе
   * с `expect`.
   */
  expectFrom?: string;
  key?: NormalizedKey;
  click?: NormalizedClick;
  /** Наведение курсора без клика (`mouseMoved`): включает CSS `:hover`. */
  hover?: NormalizedClick;
  /** Составной жест перетаскивания. */
  drag?: NormalizedDrag;
  text?: string;
  waitFor?: NormalizedWaitFor;
  probe?: NormalizedExpression;
  shot?: NormalizedShot;
  assert?: NormalizedAssert;
  api?: NormalizedApi;
  eval?: NormalizedExpression;
}

export interface Scenario {
  name: string;
  steps: ScenarioStep[];
  timeout: number;
}

export declare const DEFAULT_STEP_TIMEOUT: number;
export declare const STEP_ACTION_KEYS: StepKind[];
export declare const REGION_CHECK_KINDS: RegionCheckKind[];

export declare class ScenarioError extends Error {
  constructor(message: string);
}

export declare function stepKind(step: unknown): StepKind;
export declare function normalizeModifiers(mods?: unknown): number;
export declare function resolveKey(spec: unknown): NormalizedKey;
export declare function validateScenario(value: unknown): Scenario;
export declare function parseScenario(text: string): Scenario;
