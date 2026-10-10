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

/** Порты/адреса стенда для сборки команды прогона. */
export interface StandPorts {
  cdp: number;
  serverRoot: string;
  apiBase: string;
}

/** Сеид пробной сети (id сущностей для подстановок сценария). */
export interface StandSeed {
  networkId: string;
  networkName: string;
  homeId: string;
  thoughtId: string;
}

/**
 * Собрать argv для `ui-probe.mjs`. В интерактивном режиме (`opts.scenario ===
 * null`) флаг `--scenario` не добавляется; `null` в аргументах не бывает.
 */
export declare function buildProbeArgs(
  opts: StandOptions,
  ports: StandPorts,
  seed: StandSeed | null,
  key: string,
): string[];
