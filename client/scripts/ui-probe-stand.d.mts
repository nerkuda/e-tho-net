/**
 * Типы для `ui-probe-stand.mjs` (подъём изолированного GUI-стенда, задача
 * 38ef87cc; фикстура сценария, прокси задержки и проверка правил серверного
 * лога — ошибка 58c55bb9). Нужны юнит-тестам `tests/ui-probe-stand.test.ts`:
 * проверяются чистые функции разбора аргументов, извлечения ключа, правил
 * лога и отбора задерживаемых запросов.
 */

export interface StandOptions {
  scenario: string | null;
  /** Фикстура сценария: модуль, готовящий данные до запуска клиента. */
  scenarioSeed: string | null;
  /** Дополнительные аргументы фикстуры (`--scenario-seed-arg a=b`). */
  scenarioSeedArgs: string[];
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
  /** Задержка HTTP-ответов засеянной сети, мс (0 — прокси не поднимается). */
  delaySeedMs: number;
  /** Сузить задержку до путей, содержащих подстроку ('' — вся сеть). */
  delaySeedPath: string;
  keep: boolean;
  help: boolean;
}

export declare function parseArgs(argv: string[]): StandOptions;
export declare function parseInitKey(log: string): string;

/**
 * Подставить id засеянных сущностей (`{{networkId}}`, `{{thoughtId}}`,
 * `{{homeId}}`) в путь задержки: сценарий знает мысль только как seed-id
 * (гонка фокуса одной мысли, ошибка 1656ef58).
 */
export declare function resolveDelaySeedPath(
  filter: string,
  seed: StandSeed | null,
): string;

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

/** Правила серверного лога из сценария (`serverLog`). */
export interface ServerLogRules {
  /** Шаблоны, которых в логе быть НЕ ДОЛЖНО. */
  absent?: string[];
  /** Шаблоны, которые в логе ОБЯЗАНЫ быть. */
  present?: string[];
}

/** Нарушение правил лога: вид, шаблон, число строк и первые совпадения. */
export interface ServerLogViolation {
  kind: 'absent' | 'present';
  pattern: string;
  count: number;
  matches: string[];
}

export declare function readScenarioLogRules(file: string): ServerLogRules | null;
export declare function serverLogViolations(log: string, rules: ServerLogRules): ServerLogViolation[];
