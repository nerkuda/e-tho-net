/**
 * Задание обновления сервера: создание, порядок запуска и прогресс (компонент
 * `server/src/update/apply.ts`, задача 0a27a63b; тех.проект 2d9f5cc7,
 * сущность «Задание обновления сервера» 1f39811c).
 *
 * Порядок `apply`:
 *   1. права проверяет маршрут (`requireAdmin`); здесь — валидность целевой
 *      версии, отсутствие активного задания, живость установщика предыдущей
 *      попытки, режим развёртывания и запрет downgrade;
 *   2. сервер запущен не службой — задание сразу `failed` с инструкцией, без
 *      запуска установщика (сценарий 6b7c09a9): прав на остановку чужого
 *      процесса нет, поэтому файлы не заменяются;
 *   3. runner (`48312755`) скачивает установщик и сверяет SHA-256 — ошибки
 *      цели, скачивания и хеша отдаются как `502`, сервер ещё не в обслуживании
 *      и служба не тронута (сценарий e324fc8d);
 *   4. после проверки хеша задание переводит сервер в обслуживание
 *      (`beginUpdating`, ждёт доставки кадра `maintenance` и close `1012`) и
 *      только затем запускает установщик — это требование 20be64a8 и границы
 *      задачи 2f599b67;
 *   5. прогресс пишется в системную БД (`update_jobs`, миграция
 *      `016_update_jobs.sql`) до каждого шага, поэтому переживает остановку
 *      службы установщиком.
 *
 * Наблюдаемые сервером этапы: `preparing` (задание создано, идёт скачивание и
 * сверка хеша), `backing-up` (установщик получает управление: останавливает
 * службу и делает архив БД), `done`/`failed` — итог, который сервер узнаёт,
 * если установщик завершился, не убив процесс. Этапы `stopping`, `installing`,
 * `starting`, `health-check`, `rolling-back` выполняет сам установщик
 * (`bb063ac3`): служба в это время остановлена, и сервер физически не может их
 * записать. Поэтому последний подтверждённый этап перед остановкой службы —
 * `backing-up`; после перезапуска задание читается как `failed` с причиной,
 * называющей этот этап (инвариант сущности: незавершённое задание `failed` и
 * автоматически не возобновляется).
 *
 * Single-flight. Второй `apply` получает `409` с текущим заданием. После
 * {@link InstallerTimeoutError} установщик намеренно оставлен работать (он может
 * быть посреди замены файлов), поэтому флаг «installer alive» запрещает новую
 * попытку, пока процесс не завершился, даже если задание уже `failed`:
 * single-flight самого runner'а снимается по тайм-ауту, а наш — нет.
 *
 * Модуль не скачивает ассеты сам (runner), не выполняет бэкап и замену файлов
 * (установщик) и не реализует HTTP-контракт (маршрут
 * `server/src/routes/system-update.ts`).
 */

import { randomUUID } from 'node:crypto';

import { compareSemver, parseSemver } from '@etn/shared';
import type { UpdateJob, UpdateJobStage } from '@etn/shared';

import type { Logger } from '../logger.js';
import type { SystemDb, UpdateJobRow } from '../db/system-db.js';
import type { MaintenanceService } from '../maintenance.js';
import type { UpdateCache } from './checker.js';
import type { Deployment } from './deployment.js';
import {
  InstallerDownloadError,
  InstallerHashError,
  InstallerLaunchError,
  InstallerRunInProgressError,
  InstallerTargetError,
  InstallerTimeoutError,
  classifyInstallerExitCode,
  createInstallerRunner,
  spawnInstallerProcess,
  type InstallerProcessHandle,
  type InstallerRunResult,
  type InstallerRunnerOptions,
  type InstallerTarget,
} from './installer-runner.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Задание обновления сервера (задача 0a27a63b). Admin-эндпоинты
     * `/api/v1/system/update*` создают задание и читают прогресс.
     */
    updateApply: UpdateApplyService;
  }
}

/**
 * Этапы задания — значения сущности «Задание обновления сервера» 1f39811c.
 * Терминальные — `done` и `failed`. Состав объявлен в `@etn/shared`
 * (`UpdateJobStage`): тот же тип читает клиент.
 */
export const UPDATE_JOB_STAGES = [
  'preparing',
  'backing-up',
  'stopping',
  'installing',
  'starting',
  'health-check',
  'done',
  'rolling-back',
  'failed',
] as const satisfies readonly UpdateJobStage[];

/** Этап задания обновления (общий контракт `@etn/shared`). */
export type { UpdateJobStage };

/** Терминальные этапы: задание завершено и не считается активным. */
export const TERMINAL_UPDATE_JOB_STAGES = ['done', 'failed'] as const;

/** Этап из хранилища — допустимое значение сущности? */
export function isUpdateJobStage(value: string): value is UpdateJobStage {
  return (UPDATE_JOB_STAGES as readonly string[]).includes(value);
}

/** Терминальный этап? */
export function isTerminalUpdateJobStage(stage: UpdateJobStage): boolean {
  return (TERMINAL_UPDATE_JOB_STAGES as readonly UpdateJobStage[]).includes(stage);
}

/**
 * Задание обновления в том виде, в каком его отдают admin-эндпоинты
 * (`GET /progress`, ответ `apply`) — ровно поля сущности 1f39811c. Форма —
 * общий контракт `@etn/shared` (`UpdateJob`), её же читает клиент.
 */
export type { UpdateJob };

/** Текст задания «сервер запущен не службой» (сценарий 6b7c09a9). */
export const NOT_A_SERVICE_MESSAGE =
  'Сервер запущен не службой Windows — автоматическое обновление невозможно: ' +
  'остановите сервер вручную и запустите установщик либо установите ETN как службу Windows.';

/**
 * Причины отказа `apply` со статусом `409` (кроме прав администратора).
 * `job-active` — уже идёт обновление, `installer-alive` — установщик предыдущей
 * попытки ещё работает, `docker` — автообновление в контейнере невозможно,
 * `downgrade` — целевая версия не новее текущей, `version-mismatch` — кеш
 * успел смениться и запрошенная версия больше не предлагается.
 */
export type UpdateApplyConflictReason =
  | 'job-active'
  | 'installer-alive'
  | 'docker'
  | 'downgrade'
  | 'version-mismatch';

/** Отказ `apply` со статусом `409`: несёт текущее задание, если оно есть. */
export class UpdateApplyConflictError extends Error {
  readonly reason: UpdateApplyConflictReason;
  readonly job: UpdateJob | null;

  constructor(reason: UpdateApplyConflictReason, message: string, job: UpdateJob | null = null) {
    super(message);
    this.name = 'UpdateApplyConflictError';
    this.reason = reason;
    this.job = job;
  }
}

/** Причина отказа `apply` со статусом `422`. */
export type UpdateApplyNoUpdateReason = 'no-update' | 'invalid-target';

/** Обновлять нечего или цель непригодна — `422`. */
export class UpdateApplyNoUpdateError extends Error {
  readonly reason: UpdateApplyNoUpdateReason;

  constructor(reason: UpdateApplyNoUpdateReason, message: string) {
    super(message);
    this.name = 'UpdateApplyNoUpdateError';
    this.reason = reason;
  }
}

/**
 * Причина `502`: установщик не запущен, сервер продолжает работать на текущей
 * версии. `installer-launch` — процесс не стартовал уже после перевода в
 * обслуживание (служба при этом не остановлена).
 */
export type UpdateInstallerFailureReason =
  | 'installer-target'
  | 'installer-download'
  | 'installer-hash'
  | 'installer-launch';

/** Скачивание, проверка хеша или запуск установщика не выполнены — `502`. */
export class UpdateInstallerFailureError extends Error {
  readonly reason: UpdateInstallerFailureReason;
  readonly job: UpdateJob;
  /**
   * Этап, на котором задание остановилось (`preparing` для ассета/хеша,
   * `backing-up` для запуска после обслуживания). Уезжает в `details.stage`
   * ошибки `UPDATE_INSTALLER_FAILED`.
   */
  readonly stage: UpdateJobStage;

  constructor(reason: UpdateInstallerFailureReason, job: UpdateJob, stage: UpdateJobStage) {
    super(job.error ?? 'Установщик обновления не запущен');
    this.name = 'UpdateInstallerFailureError';
    this.reason = reason;
    this.job = job;
    this.stage = stage;
  }
}

/** Зависимости сервиса задания обновления. */
export interface UpdateApplyServiceOptions {
  /** Системная БД — хранилище прогресса (`update_jobs`). */
  systemDb: SystemDb;
  /** Режим развёртывания (`update/deployment.ts`): Docker и standalone не обновляются. */
  deployment: Deployment;
  /** Сервис обслуживания: `beginUpdating` переводит сервер в `updating`. */
  maintenance: Pick<MaintenanceService, 'beginUpdating'>;
  /** Текущий кеш проверки обновлений (`app.updateChecker.getCache()`). */
  getCache: () => UpdateCache;
  /** Диагностический журнал. */
  logger?: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  /** Часы (тесты); по умолчанию системное время. */
  now?: () => Date;
  /**
   * Настройки runner'а установщика (тесты подменяют HTTP-клиент, процесс и
   * каталоги). `spawnImpl` оборачивается сервисом для флага «installer alive»,
   * `beforeLaunch` задаёт сам сервис.
   */
  runnerOptions?: InstallerRunnerOptions;
}

/** Сервис задания обновления одной процессной копии сервера. */
export interface UpdateApplyService {
  /**
   * Последнее задание обновления или `null`, если заданий не было. Для Docker
   * всегда `null` — автообновление в контейнере не выполняется.
   */
  getProgress(): UpdateJob | null;
  /** Активное задание прямо сейчас? */
  isJobRunning(): boolean;
  /**
   * Процесс установщика предыдущей попытки ещё жив (после тайм-аута) — новое
   * обновление начинать нельзя.
   */
  isInstallerAlive(): boolean;
  /**
   * Создать задание и довести его до запуска установщика.
   *
   * Резолвится, когда установщик запущен (задание в этапе `backing-up` или уже
   * завершено), либо отклоняется:
   *   * {@link UpdateApplyConflictError} — `409`;
   *   * {@link UpdateApplyNoUpdateError} — `422`;
   *   * {@link UpdateInstallerFailureError} — `502` (установщик не запущен,
   *     сервер продолжает работать).
   *
   * Дальнейший прогресс (итог установщика) пишется в БД в фоне и читается
   * `GET /progress`: после остановки службы HTTP-ответ этому запросу уже не
   * вернётся.
   */
  apply(request: { targetVersion: string }): Promise<UpdateJob>;
}

/**
 * Единый текст причины восстановления после перезапуска: инвариант сущности —
 * незавершённое задание читается как `failed`, этап называет, где остановились.
 */
function interruptedJobMessage(stage: string): string {
  return (
    `Сервер перезапущен до завершения задания обновления (этап «${stage}»); ` +
    'задание автоматически не возобновляется.'
  );
}

/**
 * Перевести незавершённые задания в `failed` — вызывается при создании сервиса,
 * т.е. при старте процесса сервера (служба поднялась после остановки
 * установщиком либо администратор перезапустил её вручную). Возвращает число
 * заданий, переведённых в `failed`.
 */
export function recoverInterruptedUpdateJobs(
  systemDb: SystemDb,
  now: () => Date = () => new Date(),
): number {
  return systemDb.failInterruptedUpdateJobs(now().toISOString(), interruptedJobMessage);
}

/** Строка хранилища → DTO сущности; неизвестный этап читается как `failed`. */
function toUpdateJob(row: UpdateJobRow): UpdateJob {
  return {
    id: row.id,
    target_version: row.target_version,
    // Неизвестное значение — повреждённая строка: она не должна выдавать себя
    // за активное задание, поэтому читается как терминальный сбой.
    stage: isUpdateJobStage(row.stage) ? row.stage : 'failed',
    started_at: row.started_at,
    error: row.error,
    backup_path: row.backup_path,
  };
}

/** Текст итога по ненулевому коду установщика. */
function describeFailureExit(result: InstallerRunResult): string {
  const journal =
    result.logPath === null ? 'журнал установщика не найден' : `журнал: ${result.logPath}`;
  return (
    `Установщик завершился с кодом ${String(result.code)}; ` +
    `откат выполнен установщиком, ${journal}`
  );
}

/** Текст итога для предусловия установщика (код 20). */
function describePreconditionExit(result: InstallerRunResult): string {
  const journal =
    result.logPath === null ? 'журнал установщика не найден' : `журнал: ${result.logPath}`;
  return `Предусловие установщика не выполнено — нужен ручной режим, ${journal}`;
}

/** Создать сервис задания обновления. Один экземпляр на процесс сервера. */
export function createUpdateApplyService(
  options: UpdateApplyServiceOptions,
): UpdateApplyService {
  const systemDb = options.systemDb;
  const now = options.now ?? (() => new Date());
  const logger = options.logger;
  const runnerOptions = options.runnerOptions ?? {};

  // Создание сервиса = старт процесса сервера: активных заданий прошлого
  // процесса быть не может (службу останавливал установщик), поэтому они
  // переводятся в `failed` и не возобновляются — инвариант сущности 1f39811c.
  const recovered = recoverInterruptedUpdateJobs(systemDb, now);
  if (recovered > 0) {
    logger?.warn({ count: recovered }, 'update job: незавершённые задания помечены failed');
  }

  /**
   * Флаг «installer alive»: процесс установщика запущен и ещё не завершился.
   * Ставится обёрткой `spawnImpl` и снимается событием `close`/`error`; в
   * отличие от single-flight runner'а переживает тайм-аут ожидания.
   */
  let installerAlive = false;
  /** Задание, установщик которого запускается/работает (single-flight). */
  let currentJobId: string | null = null;
  /** Установщик текущего задания запущен? (заполняет обёртка `spawnImpl`). */
  let launched = false;
  /** Отпускает `apply` после запуска установщика или провала до запуска. */
  let releaseLaunchGate: (() => void) | null = null;
  /** Причина провала до запуска — для `502` (см. {@link UpdateInstallerFailureReason}). */
  let preLaunchFailure: UpdateInstallerFailureReason | null = null;
  /** Этап, на котором задание остановилось до запуска установщика (`details.stage`). */
  let preLaunchStage: UpdateJobStage = 'preparing';

  const runner = createInstallerRunner({
    ...runnerOptions,
    logger: runnerOptions.logger ?? options.logger,
    // Обёртка нужна ради флага «installer alive»: runner снимает свой
    // single-flight по тайм-ауту, хотя процесс установщика ещё жив.
    spawnImpl: (installerPath, args): InstallerProcessHandle => {
      const child = (runnerOptions.spawnImpl ?? spawnInstallerProcess)(installerPath, args);
      installerAlive = true;
      child.on('close', () => {
        installerAlive = false;
      });
      child.on('error', () => {
        installerAlive = false;
      });
      launched = true;
      releaseLaunchGate?.();
      releaseLaunchGate = null;
      return child;
    },
    // Хук обслуживания: хеш уже проверен, установщик вот-вот остановит службу.
    beforeLaunch: async ({ version }) => {
      if (currentJobId !== null) {
        writeJob(currentJobId, 'backing-up', null);
      }
      await options.maintenance.beginUpdating({ target_version: version });
    },
  });

  /** Записать этап задания (или итог) в системную БД. */
  function writeJob(jobId: string, stage: UpdateJobStage, error: string | null): UpdateJob {
    const current = systemDb.getUpdateJob(jobId);
    if (current === null) {
      throw new Error(`задание обновления ${jobId} исчезло из системной БД`);
    }
    const timestamp = now().toISOString();
    systemDb.updateUpdateJob(jobId, {
      stage,
      updatedAt: timestamp,
      finishedAt: isTerminalUpdateJobStage(stage) ? timestamp : null,
      error,
      backupPath: current.backup_path,
    });
    return toUpdateJob(systemDb.getUpdateJob(jobId) as UpdateJobRow);
  }

  /** Текущий (ещё не перезаписанный в `failed`) этап задания. */
  function currentStage(jobId: string): UpdateJobStage {
    const row = systemDb.getUpdateJob(jobId);
    return row !== null && isUpdateJobStage(row.stage) ? row.stage : 'preparing';
  }

  /** Синхронная часть `apply`: проверки, вставка задания, цель runner'а. */
  function prepare(targetVersion: string): { jobId: string; target: InstallerTarget } {
    const version = targetVersion.trim();
    if (parseSemver(version) === null) {
      throw new UpdateApplyNoUpdateError(
        'invalid-target',
        `Целевая версия ${JSON.stringify(targetVersion)} не является версией SemVer.`,
      );
    }

    // Порядок проверок — из постановки задачи: активное задание, живость
    // установщика, Docker, версия. Проверка и вставка синхронны: два
    // одновременных apply не могут оба увидеть «заданий нет» (гонка двух
    // администраторов разрешается вставкой первого).
    const active = systemDb.getActiveUpdateJob();
    if (active !== null) {
      throw new UpdateApplyConflictError(
        'job-active',
        'Обновление сервера уже идёт — второе задание не создаётся.',
        toUpdateJob(active),
      );
    }
    if (installerAlive) {
      const latest = systemDb.getLatestUpdateJob();
      throw new UpdateApplyConflictError(
        'installer-alive',
        'Установщик предыдущей попытки ещё работает — дождитесь его завершения.',
        latest === null ? null : toUpdateJob(latest),
      );
    }
    if (options.deployment === 'docker') {
      throw new UpdateApplyConflictError(
        'docker',
        'Сервер развёрнут в Docker — автообновление недоступно.',
      );
    }

    const cache = options.getCache();
    const available = cache.available_version;
    if (available === null || parseSemver(available) === null) {
      throw new UpdateApplyNoUpdateError('no-update', 'Нет доступной версии обновления.');
    }
    const order = compareSemver(version, cache.current_version);
    if (order === null) {
      throw new UpdateApplyNoUpdateError(
        'invalid-target',
        `Целевая версия ${JSON.stringify(version)} не является версией SemVer.`,
      );
    }
    if (order <= 0) {
      throw new UpdateApplyConflictError(
        'downgrade',
        `Версия ${version} не новее текущей ${cache.current_version} — downgrade запрещён.`,
      );
    }
    if (version !== available) {
      throw new UpdateApplyConflictError(
        'version-mismatch',
        `Версия ${version} больше не предлагается: доступна ${available}. Повторите проверку обновлений.`,
      );
    }

    const jobId = randomUUID();
    systemDb.createUpdateJob({
      id: jobId,
      targetVersion: available,
      stage: 'preparing',
      startedAt: now().toISOString(),
    });
    preLaunchFailure = null;
    preLaunchStage = 'preparing';
    return {
      jobId,
      target: { version: available, downloadUrl: cache.download_url, sha256: cache.sha256 },
    };
  }

  /** Исполнить задание в фоне: runner → итог в БД. Никогда не отклоняется. */
  async function runJob(jobId: string, target: InstallerTarget): Promise<void> {
    try {
      const result = await runner.run(target);
      const outcome = classifyInstallerExitCode(result.code);
      if (outcome === 'success') {
        writeJob(jobId, 'done', null);
        logger?.info({ jobId, targetVersion: target.version }, 'update job: done');
      } else if (outcome === 'precondition') {
        writeJob(jobId, 'failed', describePreconditionExit(result));
        logger?.warn({ jobId, code: result.code }, 'update job: предусловие установщика');
      } else {
        writeJob(jobId, 'failed', describeFailureExit(result));
        logger?.warn({ jobId, code: result.code }, 'update job: установщик завершился сбоем');
      }
    } catch (err) {
      if (err instanceof InstallerTimeoutError) {
        // Процесс не убит: он может быть посреди замены файлов. Журнал — в тексте.
        writeJob(jobId, 'failed', `Обновление не завершено: ${err.message}`);
        logger?.error({ jobId, logPath: err.logPath }, 'update job: тайм-аут установщика');
      } else if (err instanceof InstallerTargetError) {
        preLaunchFailure = 'installer-target';
        preLaunchStage = currentStage(jobId);
        writeJob(jobId, 'failed', err.message);
      } else if (err instanceof InstallerDownloadError) {
        preLaunchFailure = 'installer-download';
        preLaunchStage = currentStage(jobId);
        writeJob(jobId, 'failed', err.message);
      } else if (err instanceof InstallerHashError) {
        preLaunchFailure = 'installer-hash';
        preLaunchStage = currentStage(jobId);
        writeJob(jobId, 'failed', err.message);
      } else if (err instanceof InstallerLaunchError) {
        preLaunchFailure = 'installer-launch';
        preLaunchStage = currentStage(jobId);
        writeJob(jobId, 'failed', err.message);
      } else if (err instanceof InstallerRunInProgressError) {
        preLaunchFailure = 'installer-launch';
        preLaunchStage = currentStage(jobId);
        writeJob(jobId, 'failed', err.message);
      } else {
        preLaunchFailure = 'installer-launch';
        preLaunchStage = currentStage(jobId);
        const message = err instanceof Error ? err.message : String(err);
        writeJob(jobId, 'failed', `Задание обновления не выполнено: ${message}`);
        logger?.error({ err, jobId }, 'update job: неожиданная ошибка');
      }
    } finally {
      currentJobId = null;
      // Если установщик так и не запустился, отпускаем ожидающий apply.
      releaseLaunchGate?.();
      releaseLaunchGate = null;
    }
  }

  /** Итог задания без запуска установщика (сервер не службой). */
  function failWithoutInstaller(jobId: string, message: string): UpdateJob {
    const job = writeJob(jobId, 'failed', message);
    logger?.warn({ jobId }, 'update job: обновление отклонено без запуска установщика');
    return job;
  }

  return {
    getProgress(): UpdateJob | null {
      // В Docker задания не бывает (операция GET /system/update/progress).
      if (options.deployment === 'docker') {
        return null;
      }
      const row = systemDb.getLatestUpdateJob();
      return row === null ? null : toUpdateJob(row);
    },

    isJobRunning(): boolean {
      return currentJobId !== null || systemDb.getActiveUpdateJob() !== null;
    },

    isInstallerAlive(): boolean {
      return installerAlive;
    },

    async apply(request: { targetVersion: string }): Promise<UpdateJob> {
      const prepared = prepare(request.targetVersion);

      // Не служба — задание фиксирует отказ и завершается, установщик не
      // запускается, обслуживание не включается (сценарий 6b7c09a9).
      if (options.deployment !== 'windows-service') {
        return failWithoutInstaller(prepared.jobId, NOT_A_SERVICE_MESSAGE);
      }

      currentJobId = prepared.jobId;
      launched = false;
      const launchGate = new Promise<void>((resolve) => {
        releaseLaunchGate = resolve;
      });

      // Задание исполняется в фоне: apply отвечает в момент запуска установщика
      // (или провала до него), а дальнейший прогресс читается /progress.
      void runJob(prepared.jobId, prepared.target).catch((err: unknown) => {
        // Страховка от падения записи итога (например, БД закрыта): фоновая
        // задача не должна давать unhandled rejection.
        logger?.error({ err, jobId: prepared.jobId }, 'update job: фоновая задача упала');
      });
      await launchGate;

      const current = systemDb.getUpdateJob(prepared.jobId);
      if (current === null) {
        throw new Error(`задание обновления ${prepared.jobId} исчезло из системной БД`);
      }
      const job = toUpdateJob(current);
      if (!launched) {
        const reason = preLaunchFailure ?? 'installer-launch';
        throw new UpdateInstallerFailureError(reason, job, preLaunchStage);
      }
      return job;
    },
  };
}
