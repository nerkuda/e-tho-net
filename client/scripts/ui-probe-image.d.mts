/**
 * Типы для `ui-probe-image.mjs` (программные растровые ассерты стенда,
 * задача 38ef87cc). Нужны юнит-тесту `tests/ui-probe-image.test.ts`.
 */

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type RegionCheckInput =
  | { kind: 'notBlank'; name?: string; minRatio?: number; tolerance?: number }
  | { kind: 'colorAt'; name?: string; at: [number, number]; color: string; tolerance?: number }
  | { kind: 'hasColor'; name?: string; color: string; tolerance?: number; minPixels?: number }
  | { kind: 'distinct'; name?: string; minColors?: number };

export interface RegionCheckResult {
  name: string;
  ok: boolean;
  fact: string;
  expect: string;
}

export declare class ImageError extends Error {
  constructor(message: string);
}

export declare function decodePng(buffer: Buffer): RgbaImage;
export declare function hexColor(rgb: [number, number, number]): string;
export declare function parseColor(text: string): [number, number, number];
export declare function runRegionChecks(
  image: RgbaImage,
  checks: ReadonlyArray<RegionCheckInput>,
): RegionCheckResult[];
