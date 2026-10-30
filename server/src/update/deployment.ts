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
 * Кроме определения режима модуль держит текст Docker-инструкции обновления
 * (задача c79afe43): из одного источника его читают `GET /api/v1/system/update`
 * (поле `instruction`) и отказ `409` от `apply` — тексты не расходятся.
 */

import { existsSync } from 'node:fs';

/** Допустимые значения `ETN_DEPLOYMENT` и поля `deployment` кеша. */
export const DEPLOYMENT_MODES = ['windows-service', 'standalone', 'docker'] as const;

/** Режим развёртывания сервера. */
export type Deployment = (typeof DEPLOYMENT_MODES)[number];

/** Маркер запуска в Linux-контейнере (`docker run`/`docker compose`). */
export const DOCKER_MARKER_PATH = '/.dockerenv';

/**
 * Команда обновления Docker-развёртывания (задача c79afe43, сценарий
 * 34a44a7e): compose-файл на хосте скачивает новый образ и пересоздаёт
 * контейнер. Единственный источник команды — её цитируют и `instruction`
 * статуса, и отказ `apply`.
 */
export const DOCKER_UPDATE_COMMAND = 'docker compose pull && docker compose up -d';

/**
 * Инструкция обновления для `deployment = docker` (поле `instruction` ответа
 * `GET /api/v1/system/update`): точная команда и то, что важно знать до её
 * запуска — данные в томе, миграции при старте, резервная копия. Внутри
 * контейнера автообновление невозможно, поэтому других шагов нет.
 */
export const DOCKER_UPDATE_INSTRUCTION =
  `Обновление выполняется на хосте с compose-файлом: ${DOCKER_UPDATE_COMMAND}. ` +
  'Данные хранятся в томе (`ETN_DATA_DIR`), поэтому пересоздание контейнера их не затрагивает, ' +
  'а схема БД обновляется автоматически при старте новой версии. ' +
  'Перед обновлением сделайте резервную копию каталога данных.';

/**
 * Текст отказа `POST /api/v1/system/update/apply` в Docker (`409`,
 * `details.reason = "docker"`): причина и ссылка на инструкцию, а не попытка
 * запустить установщик Windows внутри контейнера.
 */
export const DOCKER_APPLY_UNAVAILABLE_MESSAGE =
  'Сервер развёрнут в Docker — автообновление из клиента невозможно. ' +
  `Обновите контейнер на хосте: ${DOCKER_UPDATE_COMMAND}. ` +
  'Порядок обновления и отката — в инструкции (поле `instruction` ответа GET /api/v1/system/update).';

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
