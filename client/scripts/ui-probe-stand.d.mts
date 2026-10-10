/**
 * Типы для `ui-probe-stand.mjs` (подъём изолированного GUI-стенда, задача
 * 38ef87cc). Нужны юнит-тесту `tests/ui-probe-stand.test.ts`: проверяются
 * чистые функции разбора аргументов и извлечения ключа.
 */

export interface StandOptions {
  scenario: string | null;
  dataFrom: string | null;
  apiKey: string | null;
  serverPort: number;
  cdpPort: number;
  out: string | null;
  work: string | null;
  seed: boolean;
  seedName: string;
  seedTitle: string;
  seedComment: string;
  keep: boolean;
  help: boolean;
}

export declare function parseArgs(argv: string[]): StandOptions;
export declare function parseInitKey(log: string): string;
