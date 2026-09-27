/**
 * Типы для `ui-probe-scenario.mjs` (стенд UI-проверок, задача 5c5b30e2).
 * Декларация нужна юнит-тесту `tests/ui-probe-scenario.test.ts`: сам модуль —
 * обычный `.mjs` (исполняется `node` без сборки), а тест — TypeScript.
 */

export type StepKind = 'key' | 'click' | 'text' | 'waitFor' | 'probe' | 'shot' | 'eval';

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
  key?: NormalizedKey;
  click?: NormalizedClick;
  text?: string;
  waitFor?: NormalizedWaitFor;
  probe?: NormalizedExpression;
  shot?: NormalizedShot;
  eval?: NormalizedExpression;
}

export interface Scenario {
  name: string;
  steps: ScenarioStep[];
  timeout: number;
}

export declare const DEFAULT_STEP_TIMEOUT: number;
export declare const STEP_ACTION_KEYS: StepKind[];

export declare class ScenarioError extends Error {
  constructor(message: string);
}

export declare function stepKind(step: unknown): StepKind;
export declare function normalizeModifiers(mods?: unknown): number;
export declare function resolveKey(spec: unknown): NormalizedKey;
export declare function validateScenario(value: unknown): Scenario;
export declare function parseScenario(text: string): Scenario;
