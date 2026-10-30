/**
 * Режим развёртывания сервера (поле `deployment` кеша проверки обновлений,
 * сущность 6f79610d, задача 8264988a; поведение Docker-развёртывания —
 * задача c79afe43).
 *
 * Три режима:
 *   * `windows-service` — сервер запущен службой Windows (установщик передаёт
 *     режим переменной `ETN_DEPLOYMENT`; шаблон службы WinSW задаёт
 *     окружение процесса);
 *   * `standalone` — обычный процесс: разработка, `node dist/index.js`,
 *     `npx`-запуск;
 *   * `docker` — контейнер: маркер `/.dockerenv` или явная переменная.
 *
 * Порядок определения: явный `ETN_DEPLOYMENT` (значение проверяется на старте,
 * мусор — отказ старта, как у остальных `ETN_*`) → маркер `/.dockerenv` →
 * `standalone`. Явное значение перекрывает маркер: так закрытая сеть может
 * объявить режим, не полагаясь на файловую систему контейнера.
 *
 * Модуль только отвечает на вопрос «где я запущен»; что из этого следует для
 * кнопки обновления, инструкции Docker и ответа `409` — задача c79afe43.
 */

import { existsSync } from 'node:fs';

/** Допустимые значения `ETN_DEPLOYMENT` и поля `deployment` кеша. */
export const DEPLOYMENT_MODES = ['windows-service', 'standalone', 'docker'] as const;

/** Режим развёртывания сервера. */
export type Deployment = (typeof DEPLOYMENT_MODES)[number];

/** Маркер запуска в Linux-контейнере (`docker run`/`docker compose`). */
export const DOCKER_MARKER_PATH = '/.dockerenv';

/**
 * Некорректное значение `ETN_DEPLOYMENT`. `config.ts` перевыбрасывает его как
 * `ConfigError`, чтобы оператор видел единый отказ старта.
 */
export class DeploymentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentConfigError';
  }
}

/** Подменяемые пробы окружения (тесты; в рабочем коде — реальные). */
export interface DeploymentProbe {
  /** Целевая платформа; по умолчанию `process.platform`. */
  platform?: NodeJS.Platform;
  /** Проверка существования файла; по умолчанию `fs.existsSync`. */
  exists?: (path: string) => boolean;
}

/** Type guard: строка — допустимый режим развёртывания. */
export function isDeployment(value: string): value is Deployment {
  return (DEPLOYMENT_MODES as readonly string[]).includes(value);
}

/**
 * Определить режим развёртывания по окружению и пробам файловой системы.
 *
 * @throws {DeploymentConfigError} когда `ETN_DEPLOYMENT` задан, но не входит
 *   в {@link DEPLOYMENT_MODES}.
 */
export function resolveDeployment(
  env: NodeJS.ProcessEnv = process.env,
  probe: DeploymentProbe = {},
): Deployment {
  const raw = env.ETN_DEPLOYMENT?.trim().toLowerCase();
  if (raw !== undefined && raw !== '') {
    if (!isDeployment(raw)) {
      throw new DeploymentConfigError(
        `ETN_DEPLOYMENT must be one of ${DEPLOYMENT_MODES.join(', ')}, got: ${JSON.stringify(raw)}`,
      );
    }
    return raw;
  }

  const platform = probe.platform ?? process.platform;
  const exists = probe.exists ?? existsSync;
  // Маркер есть только в Linux-контейнере: на Windows путь `/.dockerenv`
  // разрешается в корень текущего диска, и проверять его там бессмысленно.
  if (platform !== 'win32' && exists(DOCKER_MARKER_PATH)) {
    return 'docker';
  }

  return 'standalone';
}
