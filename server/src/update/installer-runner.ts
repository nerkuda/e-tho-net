/**
 * Скачивание установщика обновления и запуск silent server-only режима
 * (компонент `server/src/update/installer-runner.ts`, задача 48312755;
 * тех.проект 2d9f5cc7, инструкция a1211915).
 *
 * Модуль выполняет ровно три действия:
 *   1. скачивает `ETN-Setup-<version>.exe` по `download_url` из кеша проверки
 *      обновлений (сущность 6f79610d, заполняет задача 8264988a);
 *   2. сверяет SHA-256 скачанного файла с `sha256` того же кеша (`SHA256SUMS`
 *      релиза — единственный источник хеша); нет хеша или он не совпал —
 *      ошибка, установщик не запускается, файлы программы не тронуты;
 *   3. запускает установщик с контрактными флагами
 *      `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY /ALLUSERS`, ждёт
 *      завершения с тайм-аутом 15 минут и возвращает
 *      `{ code, logPath, installerPath }`. `/ALLUSERS` обязателен: служба
 *      LocalSystem запускает установщик уже элевированным, но административный
 *      режим установки сам по себе не включается — без флага Inno считает
 *      режим неадминистративным, и тихая установка ушла бы в профиль
 *      LocalSystem вместо Program Files (ошибка 2dd215f7).
 *
 * Границы:
 *   * службу не останавливает и обслуживание не включает — это делает задание
 *     обновления (0a27a63b) до вызова runner'а;
 *   * бэкап БД, замену файлов, health-check и откат выполняет сам установщик
 *     (bb063ac3); откат к моменту возврата кода 10 или иного уже выполнен;
 *   * по тайм-ауту установщик НЕ убивается: он может быть посреди замены
 *     файлов, и убийство оставило бы установку в неопределённом состоянии.
 *     Ошибка тайм-аута несёт путь к журналу установщика;
 *   * каталог загрузки временный (`%TEMP%\ETN\update\<version>`) и до
 *     завершения процесса не удаляется; файл установщика остаётся на месте
 *     после запуска (Windows держит exe открытым, а журнал ссылается на путь);
 *   * ошибки не содержат ни ссылки на ассет целиком, ни переменных окружения —
 *     ключ `etn init` в сообщения не попадает.
 *
 * Контракт кодов установщика (a1211915): 0 — успех, включая «уже актуально»;
 * 20 — предусловие не выполнено (нужен ручной режим); 10 и любое иное
 * ненулевое значение — сбой выполнения, откат уже выполнен установщиком.
 * Классификацию кода даёт {@link classifyInstallerExitCode}.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat as statFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

import { parseSemver } from '@etn/shared';

import type { Logger } from '../logger.js';
import { SERVER_VERSION } from '../version.js';
import { installerAssetName } from './checker.js';

/** Контрактные флаги silent server-only режима (a1211915) — ровно эти и только они. */
export const INSTALLER_SILENT_ARGS = [
  '/VERYSILENT',
  '/SUPPRESSMSGBOXES',
  '/NORESTART',
  '/SERVERONLY',
  '/ALLUSERS',
] as const;

/** Код возврата установщика: успех, включая «уже актуально». */
export const INSTALLER_EXIT_SUCCESS = 0;

/** Код возврата установщика: сбой выполнения, откат уже выполнен. */
export const INSTALLER_EXIT_FAILURE = 10;

/** Код возврата установщика: предусловие не выполнено, нужен ручной режим. */
export const INSTALLER_EXIT_PRECONDITION = 20;

/** Тайм-аут ожидания установщика — 15 минут (DoD задачи 48312755). */
export const INSTALLER_RUN_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Тайм-аут скачивания ассета. Ассет в разы больше ответа фида, поэтому
 * тайм-аут проверки (15 с) здесь неприменим; 10 минут покрывают медленный
 * канал и не оставляют задание висеть бесконечно.
 */
export const INSTALLER_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Предел размера установщика (512 МиБ). Защита от зеркала, отдающего
 * бесконечный/гигантский поток; реальный установщик на порядок меньше.
 */
export const INSTALLER_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Имя журнала установщика по контракту a1211915:
 * `install-YYYYMMDD-HHmmss.log` в `%ProgramData%\ETN\logs`, fallback `%TEMP%`.
 */
export const INSTALLER_LOG_PATTERN = /^install-\d{8}-\d{6}\.log$/;

/**
 * Допуск при отборе журнала по времени изменения: файловая система может
 * округлить метку создания вниз, а старт установщика занимает доли секунды.
 */
export const INSTALLER_LOG_MTIME_SLACK_MS = 2_000;

/** Каталог данных установки в 0.15.1 фиксирован (ADR 144bcdb0). */
const INSTALLER_DATA_DIR_NAME = 'ETN';

/** Итог запуска установщика — то, что получает задание обновления. */
export interface InstallerRunResult {
  /**
   * Код возврата процесса установщика ровно как он есть; `null` — процесс
   * завершён сигналом (контрактом не предусмотрено, задание считает сбоем).
   */
  code: number | null;
  /**
   * Путь к журналу установщика (`install-*.log`) или `null`, если журнал не
   * найден: каталоги недоступны либо установщик не успел его создать.
   */
  logPath: string | null;
  /** Абсолютный путь к скачанному установщику. */
  installerPath: string;
}

/**
 * Контекст хука {@link InstallerRunnerOptions.beforeLaunch}: установщик уже
 * скачан и проверен, но ещё не запущен.
 */
export interface InstallerLaunchContext {
  /** Версия устанавливаемого сервера. */
  version: string;
  /** Абсолютный путь к проверенному установщику. */
  installerPath: string;
}

/** Цель обновления — срез кеша проверки обновлений (сущность 6f79610d). */
export interface InstallerTarget {
  /** Версия устанавливаемого сервера (semver из `available_version`). */
  version: string;
  /** Ссылка на установщик (`download_url` кеша); `null` — обновление недоступно. */
  downloadUrl: string | null;
  /** SHA-256 установщика (`sha256` кеша из `SHA256SUMS`); `null` — хеша нет. */
  sha256: string | null;
}

/** Ответ загрузки ассета в форме, достаточной для потоковой записи. */
export interface InstallerFetchResponse {
  ok: boolean;
  status: number;
  body: AsyncIterable<Uint8Array> | null;
}

/** HTTP-клиент скачивания; по умолчанию — глобальный `fetch` (undici). */
export type InstallerFetch = (
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<InstallerFetchResponse>;

/** Процесс установщика: только события, нужные runner'у (убийства нет намеренно). */
export interface InstallerProcessHandle {
  on(event: 'close', handler: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
}

/** Запуск процесса установщика (тесты подменяют его, не создавая реальный exe). */
export type SpawnInstaller = (
  installerPath: string,
  args: readonly string[],
) => InstallerProcessHandle;

/** Параметры runner'а. */
export interface InstallerRunnerOptions {
  /** HTTP-клиент скачивания (тесты); по умолчанию глобальный `fetch`. */
  fetchImpl?: InstallerFetch;
  /** Запуск процесса (тесты); по умолчанию `node:child_process.spawn`. */
  spawnImpl?: SpawnInstaller;
  /** Корень временного каталога загрузки; по умолчанию `%TEMP%\ETN\update`. */
  downloadRoot?: string;
  /** Тайм-аут скачивания, мс; по умолчанию {@link INSTALLER_DOWNLOAD_TIMEOUT_MS}. */
  downloadTimeoutMs?: number;
  /** Тайм-аут ожидания установщика, мс; по умолчанию {@link INSTALLER_RUN_TIMEOUT_MS}. */
  runTimeoutMs?: number;
  /** Каталоги поиска журнала; по умолчанию `%ProgramData%\ETN\logs` и `%TEMP%`. */
  logDirs?: readonly string[];
  /** Часы (тесты); по умолчанию системное время. */
  now?: () => number;
  /**
   * Хук между проверкой хеша и запуском установщика. Задание обновления
   * (`0a27a63b`) переводит в нём сервер в обслуживание и дожидается доставки
   * кадра: установщик останавливает службу, поэтому клиенты обязаны узнать об
   * этом раньше процесса. Ошибка хука отменяет запуск — установщик не
   * стартует, файлы программы не тронуты.
   */
  beforeLaunch?: (context: InstallerLaunchContext) => Promise<void>;
  /** Диагностический журнал; ошибки наружу пробрасываются. */
  logger?: Pick<Logger, 'debug' | 'info' | 'warn'>;
}

/** Сервис скачивания и запуска установщика одной процессной копии сервера. */
export interface InstallerRunner {
  /** Идёт ли скачивание или запуск прямо сейчас. */
  isRunning(): boolean;
  /**
   * Скачать установщик, проверить SHA-256, вызвать {@link
   * InstallerRunnerOptions.beforeLaunch}, запустить и дождаться завершения.
   *
   * @throws {InstallerRunInProgressError} когда предыдущий вызов ещё не завершён.
   * @throws {InstallerTargetError} цель неполна или недопустима (нет версии,
   *   ссылки или хеша, битый semver, не http(s)-ссылка).
   * @throws {InstallerDownloadError} скачивание не выполнено (сеть, HTTP-код,
   *   размер, запись файла, тайм-аут скачивания).
   * @throws {InstallerHashError} SHA-256 не совпал с кешем — файлы не тронуты.
   * @throws {InstallerLaunchError} процесс установщика не запустился.
   * @throws {InstallerTimeoutError} установщик не завершился за тайм-аут;
   *   процесс оставлен работать, путь к журналу — в ошибке.
   * @throws ошибка хука `beforeLaunch`, если он отказал: установщик не запущен.
   */
  run(target: InstallerTarget): Promise<InstallerRunResult>;
}

/** Классификация кода возврата установщика по контракту a1211915. */
export type InstallerOutcome = 'success' | 'precondition' | 'failure';

/**
 * Сопоставить код возврата установщика исходу: 0 — успех, 20 — предусловие,
 * всё остальное (включая `null` и коды Inno 1–8) — сбой. Задание обновления
 * обязано пользоваться этой функцией, а не сравнивать коды самостоятельно.
 */
export function classifyInstallerExitCode(code: number | null): InstallerOutcome {
  if (code === INSTALLER_EXIT_SUCCESS) return 'success';
  if (code === INSTALLER_EXIT_PRECONDITION) return 'precondition';
  return 'failure';
}

/** Базовая ошибка runner'а: остальные классы уточняют причину. */
export class InstallerRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallerRunnerError';
  }
}

/** Цель обновления неполна или недопустима — скачивание не начиналось. */
export class InstallerTargetError extends InstallerRunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'InstallerTargetError';
  }
}

/** Скачивание установщика не выполнено (сеть, HTTP, размер, запись, тайм-аут). */
export class InstallerDownloadError extends InstallerRunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'InstallerDownloadError';
  }
}

/** SHA-256 скачанного установщика не совпал с кешем — запуск запрещён. */
export class InstallerHashError extends InstallerRunnerError {
  readonly expected: string;
  readonly actual: string;

  constructor(version: string, expected: string, actual: string) {
    super(`The SHA-256 of installer ${version} does not match SHA256SUMS — launch cancelled`);
    this.name = 'InstallerHashError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** Процесс установщика не запустился (нет файла, нет прав). */
export class InstallerLaunchError extends InstallerRunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'InstallerLaunchError';
  }
}

/** Предыдущий вызов runner'а ещё не завершён: второй процесс не создаётся. */
export class InstallerRunInProgressError extends InstallerRunnerError {
  constructor(message = "The update installer is already running") {
    super(message);
    this.name = 'InstallerRunInProgressError';
  }
}

/**
 * Установщик не завершился за тайм-аут. Процесс намеренно не убит, поэтому
 * ошибка несёт всё, что нужно заданию и администратору: путь к установщику и
 * путь к журналу (если журнал уже создан).
 */
export class InstallerTimeoutError extends InstallerRunnerError {
  readonly timeoutMs: number;
  readonly installerPath: string;
  readonly logPath: string | null;

  constructor(timeoutMs: number, installerPath: string, logPath: string | null) {
    const minutes = Math.round(timeoutMs / 60_000);
    const journal = logPath === null ? "installer log not found" : `log: ${logPath}`;
    super(`the installer did not finish within ${minutes} min — it was left running, ${journal}`);
    this.name = 'InstallerTimeoutError';
    this.timeoutMs = timeoutMs;
    this.installerPath = installerPath;
    this.logPath = logPath;
  }
}

/** Скачанный и проверенный установщик. */
interface DownloadedInstaller {
  version: string;
  installerPath: string;
  sha256: string;
}

/** Проверенная цель обновления. */
interface NormalizedTarget {
  version: string;
  downloadUrl: string;
  sha256: string;
}

/** Строка SHA-256: 64 hex-символа (регистр не важен). */
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Разбор ссылки на ассет: только абсолютный https-адрес с непустым хостом.
 * Применение обновления — «только по HTTPS» (ключевое решение тех.проекта
 * 2d9f5cc7): по http установщик не скачивается даже при настроенном
 * http-фиде закрытой сети — фид несёт только метаданные.
 */
function parseDownloadUrl(value: string | null): URL {
  if (value === null || value.trim() === '') {
    throw new InstallerTargetError(
      "no installer link: update is unavailable (Docker or an unsuitable version)",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InstallerTargetError("the installer link is not an absolute URL");
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '') {
    throw new InstallerTargetError(
      "the installer link must be an absolute https address: updates apply over HTTPS only",
    );
  }
  return parsed;
}

/**
 * Проверить цель до скачивания: версия — semver (она же имя каталога и
 * файла, поэтому недоверенную строку в путь пропускать нельзя), ссылка —
 * абсолютный http(s)-адрес, хеш — 64 hex. Любое нарушение — до сети и диска.
 */
function normalizeTarget(target: InstallerTarget): NormalizedTarget {
  if (parseSemver(target.version) === null) {
    throw new InstallerTargetError(
      `version ${JSON.stringify(target.version)} is not semver — the installer is not downloaded`,
    );
  }
  const url = parseDownloadUrl(target.downloadUrl);
  if (target.sha256 === null || target.sha256.trim() === '') {
    throw new InstallerTargetError(
      `the cache has no SHA-256 for installer ${target.version} — the update does not start`,
    );
  }
  if (!SHA256_PATTERN.test(target.sha256)) {
    throw new InstallerTargetError(`the SHA-256 of installer ${target.version} has an invalid format`);
  }
  return { version: target.version, downloadUrl: url.toString(), sha256: target.sha256.toLowerCase() };
}

/** Заголовки запроса ассета: обязательный для GitHub User-Agent. */
function downloadHeaders(): Record<string, string> {
  return {
    accept: 'application/octet-stream',
    'user-agent': `etn-server/${SERVER_VERSION}`,
  };
}

/** HTTP-клиент по умолчанию — глобальный `fetch` (undici). */
const DEFAULT_INSTALLER_FETCH: InstallerFetch = async (url, init) => {
  const response = await globalThis.fetch(url, init);
  return { ok: response.ok, status: response.status, body: response.body };
};

/**
 * Запуск процесса по умолчанию: без консольного окна, без наследования
 * стандартных потоков (установщик ничего не печатает, весь вывод — в журнале).
 */
export function spawnInstallerProcess(
  installerPath: string,
  args: readonly string[],
): InstallerProcessHandle {
  return spawn(installerPath, [...args], { stdio: 'ignore', windowsHide: true });
}

/**
 * Каталоги поиска журнала установщика по контракту a1211915: основной —
 * `%ProgramData%\ETN\logs`, fallback — `%TEMP%`. На не-Windows `%ProgramData%`
 * отсутствует, остаётся только временный каталог.
 */
export function defaultInstallerLogDirs(): string[] {
  const dirs: string[] = [];
  const programData = process.env.ProgramData?.trim();
  if (programData !== undefined && programData !== '') {
    dirs.push(path.join(programData, INSTALLER_DATA_DIR_NAME, 'logs'));
  }
  dirs.push(os.tmpdir());
  return dirs;
}

/**
 * Найти журнал только что запущенного установщика: имя по контракту
 * `install-YYYYMMDD-HHmmss.log`, время изменения не раньше старта процесса
 * (с допуском {@link INSTALLER_LOG_MTIME_SLACK_MS}). Из нескольких подходящих
 * файлов побеждает самый свежий; ошибки чтения каталога — «журнала нет».
 *
 * Эвристика по времени нужна потому, что установщик сам выбирает имя журнала
 * по часам и не сообщает путь (кроме `last_log` в `install.json`, который при
 * сбое не обновляется). Параллельные запуски исключает
 * {@link InstallerRunInProgressError}, поэтому найденный файл — наш.
 */
export async function findInstallerLogPath(
  logDirs: readonly string[],
  startedAtMs: number,
  mtimeSlackMs: number = INSTALLER_LOG_MTIME_SLACK_MS,
): Promise<string | null> {
  let bestPath: string | null = null;
  let bestMtime = Number.NEGATIVE_INFINITY;
  for (const dir of logDirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !INSTALLER_LOG_PATTERN.test(entry.name)) continue;
      const candidate = path.join(dir, entry.name);
      let info;
      try {
        info = await statFile(candidate);
      } catch {
        continue;
      }
      if (info.mtimeMs < startedAtMs - mtimeSlackMs) continue;
      if (info.mtimeMs > bestMtime || (info.mtimeMs === bestMtime && bestPath !== null && candidate > bestPath)) {
        bestMtime = info.mtimeMs;
        bestPath = candidate;
      }
    }
  }
  return bestPath;
}

/** Ошибка чтения тела — истёк тайм-аут скачивания (AbortSignal.timeout). */
function isDownloadTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** Текст причины без ссылки на ассет (URL может содержать учётные данные). */
function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Скачать установщик во временный каталог и проверить SHA-256.
 *
 * Запись идёт потоком в `<installer>.part`; при любой ошибке, включая
 * несовпадение хеша, `.part` удаляется, а итоговый файл установщика не
 * появляется — «файлы не тронуты, установщик не запускается» (DoD).
 */
async function downloadInstaller(
  target: NormalizedTarget,
  options: {
    fetchImpl: InstallerFetch;
    downloadRoot: string;
    downloadTimeoutMs: number;
  },
): Promise<DownloadedInstaller> {
  const dir = path.join(options.downloadRoot, target.version);
  const installerPath = path.join(dir, installerAssetName(target.version));
  const partPath = `${installerPath}.part`;
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new InstallerDownloadError(`the download directory is unavailable: ${errorReason(err)}`);
  }

  let response: InstallerFetchResponse;
  try {
    response = await options.fetchImpl(target.downloadUrl, {
      headers: downloadHeaders(),
      signal: AbortSignal.timeout(options.downloadTimeoutMs),
    });
  } catch (err) {
    if (isDownloadTimeout(err)) {
      throw new InstallerDownloadError(
        `downloading installer ${target.version}: timed out`,
      );
    }
    throw new InstallerDownloadError(`downloading installer ${target.version}: ${errorReason(err)}`);
  }
  if (!response.ok) {
    throw new InstallerDownloadError(
      `downloading installer ${target.version}: the server returned HTTP ${response.status}`,
    );
  }
  if (response.body === null) {
    throw new InstallerDownloadError(`downloading installer ${target.version}: response without a body`);
  }

  const hash = createHash('sha256');
  let received = 0;
  const limited = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      received += chunk.length;
      if (received > INSTALLER_MAX_BYTES) {
        callback(
          new InstallerDownloadError(
            `installer ${target.version} is larger than ${INSTALLER_MAX_BYTES} bytes — the download was aborted`,
          ),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.from(response.body), limited, createWriteStream(partPath));
  } catch (err) {
    await rm(partPath, { force: true }).catch(() => undefined);
    if (err instanceof InstallerDownloadError) throw err;
    if (isDownloadTimeout(err)) {
      throw new InstallerDownloadError(
        `downloading installer ${target.version}: timed out`,
      );
    }
    throw new InstallerDownloadError(
      `downloading installer ${target.version} failed: ${errorReason(err)}`,
    );
  }

  const actual = hash.digest('hex');
  if (actual !== target.sha256) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new InstallerHashError(target.version, target.sha256, actual);
  }
  try {
    await rename(partPath, installerPath);
  } catch (err) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new InstallerDownloadError(
      `downloading installer ${target.version}: the file was not prepared (${errorReason(err)})`,
    );
  }
  return { version: target.version, installerPath, sha256: actual };
}

/**
 * Запустить установщик и дождаться его завершения.
 *
 * По тайм-ауту промис отклоняется {@link InstallerTimeoutError}, но процесс
 * остаётся жив: установщик может быть посреди замены файлов, и его убийство
 * оставило бы установку в неопределённом состоянии. Поздние события процесса
 * после завершения промиса игнорируются.
 */
function launchInstaller(
  installerPath: string,
  options: {
    spawnImpl: SpawnInstaller;
    logDirs: readonly string[];
    runTimeoutMs: number;
    now: () => number;
    logger?: Pick<Logger, 'debug' | 'info' | 'warn'>;
  },
): Promise<InstallerRunResult> {
  const startedAtMs = options.now();

  return new Promise<InstallerRunResult>((resolve, reject) => {
    let settled = false;

    let child: InstallerProcessHandle;
    try {
      child = options.spawnImpl(installerPath, INSTALLER_SILENT_ARGS);
    } catch (err) {
      reject(new InstallerLaunchError(`the installer was not started: ${errorReason(err)}`));
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void findInstallerLogPath(options.logDirs, startedAtMs).then((logPath) => {
        const error = new InstallerTimeoutError(options.runTimeoutMs, installerPath, logPath);
        options.logger?.warn(
          { installerPath, logPath, timeoutMs: options.runTimeoutMs },
          "update installer: timeout, the installer was left running",
        );
        reject(error);
      });
    }, options.runTimeoutMs);

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void findInstallerLogPath(options.logDirs, startedAtMs).then((logPath) => {
        options.logger?.info(
          { code, logPath, installerPath },
          "update installer: the process completed",
        );
        resolve({ code, logPath, installerPath });
      });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new InstallerLaunchError(`the installer was not started: ${errorReason(err)}`));
    });
  });
}

/**
 * Создать сервис скачивания и запуска установщика. Один экземпляр на процесс
 * (задание обновления 0a27a63b создаёт его и вызывает `run`); тесты собирают
 * изолированный экземпляр с подменёнными HTTP-клиентом, процессом и часами.
 */
export function createInstallerRunner(options: InstallerRunnerOptions = {}): InstallerRunner {
  const fetchImpl = options.fetchImpl ?? DEFAULT_INSTALLER_FETCH;
  const spawnImpl = options.spawnImpl ?? spawnInstallerProcess;
  const downloadRoot = options.downloadRoot ?? path.join(os.tmpdir(), 'ETN', 'update');
  const downloadTimeoutMs = options.downloadTimeoutMs ?? INSTALLER_DOWNLOAD_TIMEOUT_MS;
  const runTimeoutMs = options.runTimeoutMs ?? INSTALLER_RUN_TIMEOUT_MS;
  const logDirs = options.logDirs ?? defaultInstallerLogDirs();
  const now = options.now ?? Date.now;
  const logger = options.logger;
  const beforeLaunch = options.beforeLaunch;
  let running = false;

  return {
    isRunning(): boolean {
      return running;
    },

    async run(target: InstallerTarget): Promise<InstallerRunResult> {
      if (running) throw new InstallerRunInProgressError();
      running = true;
      try {
        const normalized = normalizeTarget(target);
        logger?.info(
          { version: normalized.version, downloadRoot },
          "update installer: downloading the installer",
        );
        const downloaded = await downloadInstaller(normalized, {
          fetchImpl,
          downloadRoot,
          downloadTimeoutMs,
        });
        logger?.info(
          { version: downloaded.version, installerPath: downloaded.installerPath },
          "update installer: hash matched, launching the installer",
        );
        // Хук ровно между проверкой хеша и запуском: до него сервер полностью
        // работоспособен, после — клиенты уведомлены об обслуживании. Ошибка
        // хука отменяет запуск, установщик не стартует.
        if (beforeLaunch !== undefined) {
          await beforeLaunch({
            version: downloaded.version,
            installerPath: downloaded.installerPath,
          });
        }
        return await launchInstaller(downloaded.installerPath, {
          spawnImpl,
          logDirs,
          runTimeoutMs,
          now,
          logger,
        });
      } finally {
        running = false;
      }
    },
  };
}
