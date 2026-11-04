/**
 * Проверка канала обновлений сервера и кеш версий (компонент
 * `server/src/update/checker.ts`, задача 8264988a; тех.проект 2d9f5cc7).
 *
 * Источник истины о версиях — только сервер (требование d3ed341b): клиент не
 * обращается к GitHub и не знает адресов фидов. Модуль проверяет метаданные
 * фида (GitHub Releases по умолчанию или настраиваемый фид `ETN_UPDATE_FEED`
 * того же формата, ADR 23a931f9), сравнивает версии через
 * `shared/src/semver.ts` (единственный разбор semver в проекте, 4c8a87ec) и
 * держит результат в памяти — форма кеша — сущность 6f79610d:
 *
 *   current_version / available_version / channel / checked_at / check_error /
 *   download_url / sha256 / deployment.
 *
 * Границы и инварианты:
 *   * установщик на этапе проверки НЕ скачивается: `download_url` — ссылка на
 *     `ETN-Setup-<version>.exe`, `sha256` — строка этого же ассета из
 *     `SHA256SUMS` того же релиза. Нет `SHA256SUMS` или строки для ассета —
 *     версия непригодна: `check_error`, обновление не предлагается;
 *   * prerelease не предлагается на канале `stable`; на канале `prerelease`
 *     допустимы и prerelease, и обычные релизы;
 *   * downgrade отфильтрован: предлагается только версия строго новее текущей;
 *   * ошибка фида не обнуляет последний успешный результат: `available_version`,
 *     `download_url` и `sha256` остаются, ошибка пишется в `check_error`;
 *   * для Docker `download_url`/`sha256` — `null` (инструкция обновления —
 *     задача c79afe43);
 *   * проверка выполняется при старте, каждые `check_interval_hours` (12 по
 *     умолчанию) и по команде администратора; фоновая проверка не блокирует
 *     старт сервера и не бросает наружу (планировщик — {@link
 *     startUpdateCheckScheduler});
 *   * ручной вызов во время идущей проверки отклоняется
 *     {@link UpdateCheckInProgressError} (операция `POST /system/update/check`
 *     отдаёт `429`, реализация эндпоинта — задача 0a27a63b).
 *
 * Модуль не скачивает ассеты, не запускает установщик, не переводит сервер в
 * обслуживание и не реализует admin-эндпоинты: это задача 0a27a63b.
 */

import { compareSemver, parseSemver } from '@etn/shared';

import type { Logger } from '../logger.js';
import { ETN_REPOSITORY, SERVER_VERSION } from '../version.js';
import type { Deployment } from './deployment.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Проверка канала обновлений и кеш версий (задача 8264988a).
     * Admin-эндпоинты обновления (задача 0a27a63b) читают `getCache()` и
     * запускают `checkNow()`.
     */
    updateChecker: UpdateChecker;
  }
}

/** Каналы обновлений (`ETN_UPDATE_CHANNEL`). */
export const UPDATE_CHANNELS = ['stable', 'prerelease'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/** Канал по умолчанию: prerelease включается только явной настройкой. */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable';

/** Фид по умолчанию — список релизов GitHub Releases (ADR 23a931f9). */
export const DEFAULT_UPDATE_FEED_URL = `https://api.github.com/repos/${ETN_REPOSITORY}/releases`;

/** Интервал фоновых проверок по умолчанию — 12 часов (сущность fc0a99ba). */
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Минимальный интервал фоновых проверок — 1 час. */
export const MIN_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Верхняя граница интервала — 24 дня. Ограничение платформы: `setInterval`
 * в Node заменяет задержку больше `2^31-1` мс (≈24,85 суток) на 1 мс, и
 * «месячная» проверка превратилась бы в шторм запросов к фиду.
 */
export const MAX_UPDATE_CHECK_INTERVAL_MS = 24 * 24 * 60 * 60 * 1000;

/** Имя ассета с эталонными хешами релиза (сущность ed329f3b). */
export const SHA256SUMS_ASSET_NAME = 'SHA256SUMS';

/** Тайм-аут одного HTTP-запроса при проверке (фид и `SHA256SUMS`), мс. */
export const UPDATE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Пределы размера ответа: фид — 5 МиБ, `SHA256SUMS` — 1 МиБ. Защита от
 * зеркала, отдающего бесконечный/гигантский ответ; реальные файлы на два
 * порядка меньше.
 */
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_SUMS_BYTES = 1024 * 1024;

/** Строка `SHA256SUMS`: 64 hex-символа, пробелы, имя ассета (допустим `*`). */
const SUMS_LINE_PATTERN = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/;

/**
 * Кеш проверки обновлений — форма сущности 6f79610d. Все поля присутствуют
 * всегда; `checked_at` — `null` до первой завершённой проверки, остальные
 * nullable-поля — `null`, когда значения нет.
 */
export interface UpdateCache {
  /** Версия работающего сервера. */
  current_version: string;
  /** Доступная версия строго новее текущей; `null` — обновлений нет. */
  available_version: string | null;
  /** Канал проверки. */
  channel: UpdateChannel;
  /** ISO-8601 момента последней завершённой проверки (успешной или нет). */
  checked_at: string | null;
  /** Текст последней ошибки проверки; `null` — последняя проверка успешна. */
  check_error: string | null;
  /** Ссылка на `ETN-Setup-<version>.exe`; `null` — нет обновления или Docker. */
  download_url: string | null;
  /** SHA-256 установщика из `SHA256SUMS`; `null` — нет обновления или Docker. */
  sha256: string | null;
  /** Режим развёртывания; определяет доступность кнопки обновления. */
  deployment: Deployment;
}

/** Ассет релиза в метаданных фида (формат GitHub Releases API). */
export interface UpdateFeedAsset {
  name: string;
  browser_download_url: string;
}

/** Релиз в метаданных фида (нужные поля GitHub Releases API). */
export interface UpdateFeedRelease {
  tag_name: string;
  /** GitHub-флаг prerelease; дополняет prerelease-суффикс тега. */
  prerelease: boolean;
  /** Черновик релиза не предлагается никогда. */
  draft: boolean;
  assets: UpdateFeedAsset[];
}

/** Найденный кандидат на обновление. */
export interface UpdateCandidate {
  /** Версия из тега без ведущего `v` — ровно как в именах ассетов. */
  version: string;
  release: UpdateFeedRelease;
}

/** Ответ фида или `SHA256SUMS` в форме, достаточной для проверки. */
export interface UpdateFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** HTTP-клиент проверки; по умолчанию — глобальный `fetch` (undici). */
export type UpdateFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<UpdateFetchResponse>;

/** Параметры сервиса проверки. */
export interface UpdateCheckerOptions {
  /** Адрес фида (`ETN_UPDATE_FEED` или GitHub Releases по умолчанию). */
  feedUrl: string;
  /** Канал проверки. */
  channel: UpdateChannel;
  /** Версия работающего сервера. */
  currentVersion: string;
  /** Режим развёртывания (для Docker ссылка и хеш не отдаются). */
  deployment: Deployment;
  /** HTTP-клиент (тесты); по умолчанию глобальный `fetch`. */
  fetchImpl?: UpdateFetch;
  /** Тайм-аут одного запроса, мс; по умолчанию {@link UPDATE_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Часы (тесты); по умолчанию системное время. */
  now?: () => Date;
  /** Диагностический журнал; ошибки проверки не пробрасываются наружу. */
  logger?: Pick<Logger, 'debug' | 'info' | 'warn'>;
}

/** Сервис проверки канала обновлений одной процессной копии сервера. */
export interface UpdateChecker {
  /** Текущий кеш (копия; менять снаружи нельзя). */
  getCache(): UpdateCache;
  /** Идёт ли проверка прямо сейчас. */
  isCheckInProgress(): boolean;
  /**
   * Выполнить проверку немедленно и вернуть обновлённый кеш.
   *
   * @throws {UpdateCheckInProgressError} когда проверка уже идёт — эндпоинт
   *   `POST /system/update/check` отдаёт на это `429`.
   */
  checkNow(): Promise<UpdateCache>;
}

/** Проверка уже выполняется: повторный запуск отклоняется. */
export class UpdateCheckInProgressError extends Error {
  constructor(message = "An update check is already running") {
    super(message);
    this.name = 'UpdateCheckInProgressError';
  }
}

/** Ответ фида не соответствует формату метаданных релизов. */
export class UpdateFeedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateFeedFormatError';
  }
}

/**
 * Разобрать `SHA256SUMS` релиза в карту «имя ассета → хеш».
 *
 * Формат (сущность ed329f3b): `<64 hex>  <имя ассета>`, разделитель — два
 * пробела, кодировка UTF-8. Разбор терпим к любому числу пробелов/табов и к
 * `*` перед именем (бинарный режим `sha256sum`), но хеш обязан быть 64 hex;
 * строки с мусором в хеше игнорируются — для ассета это значит «строки нет».
 * Имена сравниваются точно (регистрозависимо), хеши нормализуются в нижний
 * регистр. При повторе имени побеждает первая строка.
 */
export function parseSha256Sums(text: string): ReadonlyMap<string, string> {
  const sums = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const match = SUMS_LINE_PATTERN.exec(line);
    if (match === null) continue;
    const hash = match[1];
    const name = match[2];
    if (hash === undefined || name === undefined) continue;
    const trimmedName = name.trim();
    if (trimmedName === '' || sums.has(trimmedName)) continue;
    sums.set(trimmedName, hash.toLowerCase());
  }
  return sums;
}

/** Версия из тега релиза: без ведущего `v`; пустой результат — `null`. */
export function versionFromTag(tag: string): string | null {
  const trimmed = tag.trim();
  const version = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
  return version === '' ? null : version;
}

/** Имя установщика конкретной версии в ассетах релиза. */
export function installerAssetName(version: string): string {
  return `ETN-Setup-${version}.exe`;
}

/**
 * Разобрать ответ фида в список релизов.
 *
 * Ожидается JSON-массив объектов GitHub Releases API (`tag_name`, `assets[]`
 * с `name`/`browser_download_url`, флаги `draft`/`prerelease`); настраиваемый
 * фид обязан отдавать тот же формат (ADR 23a931f9). Пустой массив — валидный
 * ответ «релизов нет»; не-массив, элемент не-объект, отсутствие `tag_name`
 * или битый `assets` — {@link UpdateFeedFormatError}.
 */
export function parseUpdateFeed(payload: unknown): UpdateFeedRelease[] {
  if (!Array.isArray(payload)) {
    throw new UpdateFeedFormatError("the feed response is not a list of releases");
  }
  const releases: UpdateFeedRelease[] = [];
  for (let index = 0; index < payload.length; index++) {
    const entry: unknown = payload[index];
    if (typeof entry !== 'object' || entry === null) {
      throw new UpdateFeedFormatError(`feed item ${index} is not a release object`);
    }
    const record = entry as Record<string, unknown>;
    const tagName = record.tag_name;
    if (typeof tagName !== 'string' || tagName.trim() === '') {
      throw new UpdateFeedFormatError(`feed item ${index} has no tag_name`);
    }
    const assetsRaw = record.assets;
    const assets: UpdateFeedAsset[] = [];
    if (assetsRaw !== undefined && assetsRaw !== null) {
      if (!Array.isArray(assetsRaw)) {
        throw new UpdateFeedFormatError(`assets of release ${tagName} are not a list`);
      }
      for (const assetRaw of assetsRaw) {
        if (typeof assetRaw !== 'object' || assetRaw === null) {
          throw new UpdateFeedFormatError(`an asset of release ${tagName} is not an object`);
        }
        const assetRecord = assetRaw as Record<string, unknown>;
        const name = assetRecord.name;
        const url = assetRecord.browser_download_url;
        if (typeof name !== 'string' || name === '' || typeof url !== 'string' || url === '') {
          throw new UpdateFeedFormatError(
            `an asset of release ${tagName} has no name or browser_download_url`,
          );
        }
        assets.push({ name, browser_download_url: url });
      }
    }
    releases.push({
      tag_name: tagName,
      prerelease: record.prerelease === true,
      draft: record.draft === true,
      assets,
    });
  }
  return releases;
}

/**
 * Выбрать кандидата на обновление: самая новая версия строго выше текущей,
 * удовлетворяющая каналу.
 *
 * Правила: черновики и теги не-semver пропускаются; на канале `stable`
 * пропускаются prerelease (и по флагу релиза, и по суффиксу версии); версия
 * не выше текущей — downgrade — отфильтрована. `currentVersion` обязан быть
 * валидным semver (это гарантирует сервис проверки).
 */
export function selectUpdateCandidate(
  releases: readonly UpdateFeedRelease[],
  options: { currentVersion: string; channel: UpdateChannel },
): UpdateCandidate | null {
  if (parseSemver(options.currentVersion) === null) return null;
  let best: UpdateCandidate | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    const version = versionFromTag(release.tag_name);
    if (version === null) continue;
    const parsed = parseSemver(version);
    if (parsed === null) continue;
    const isPrerelease = release.prerelease || parsed.prerelease.length > 0;
    if (options.channel === 'stable' && isPrerelease) continue;
    const order = compareSemver(version, options.currentVersion);
    if (order === null || order <= 0) continue;
    if (best === null) {
      best = { version, release };
      continue;
    }
    const bestOrder = compareSemver(version, best.version);
    if (bestOrder !== null && bestOrder > 0) {
      best = { version, release };
    }
  }
  return best;
}

/** Заголовки запросов проверки: JSON и обязательный для GitHub User-Agent. */
function requestHeaders(): Record<string, string> {
  return {
    accept: 'application/vnd.github+json, application/json',
    'user-agent': `etn-server/${SERVER_VERSION}`,
  };
}

/**
 * Создать сервис проверки канала обновлений. Один экземпляр на процесс
 * (`createServer` декорирует его `app.updateChecker`); тесты вправе собрать
 * изолированный экземпляр со своим фидом, часами и HTTP-клиентом.
 */
export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const now = options.now ?? (() => new Date());
  const fetchImpl: UpdateFetch = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const timeoutMs = options.timeoutMs ?? UPDATE_REQUEST_TIMEOUT_MS;
  const logger = options.logger;

  let cache: UpdateCache = {
    current_version: options.currentVersion,
    available_version: null,
    channel: options.channel,
    checked_at: null,
    check_error: null,
    download_url: null,
    sha256: null,
    deployment: options.deployment,
  };
  let inProgress = false;

  /** GET с тайм-аутом и ограничением размера; ошибки — с контекстом источника. */
  async function requestText(url: string, label: string, maxBytes: number): Promise<string> {
    let response: UpdateFetchResponse;
    try {
      response = await fetchImpl(url, {
        headers: requestHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${label}: the request failed (${reason})`);
    }
    if (!response.ok) {
      throw new Error(`${label}: HTTP ${response.status}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${label}: the response was not read (${reason})`);
    }
    if (text.length > maxBytes) {
      throw new Error(`${label}: the response is larger than ${maxBytes} bytes`);
    }
    return text;
  }

  /** Одна проверка: успех обновляет кеш целиком, ошибка — только `check_error`. */
  async function performCheck(): Promise<UpdateCache> {
    try {
      if (parseSemver(options.currentVersion) === null) {
        throw new Error(
          `The current server version ${JSON.stringify(options.currentVersion)} is not semver`,
        );
      }

      const feedText = await requestText(options.feedUrl, "Update feed", MAX_FEED_BYTES);
      let payload: unknown;
      try {
        payload = JSON.parse(feedText);
      } catch {
        throw new UpdateFeedFormatError("the feed response is not JSON");
      }
      const releases = parseUpdateFeed(payload);
      const candidate = selectUpdateCandidate(releases, {
        currentVersion: options.currentVersion,
        channel: options.channel,
      });

      if (candidate === null) {
        cache = {
          ...cache,
          checked_at: now().toISOString(),
          available_version: null,
          download_url: null,
          sha256: null,
          check_error: null,
        };
        logger?.info({ channel: options.channel }, "update check: no updates available");
        return { ...cache };
      }

      const installerName = installerAssetName(candidate.version);
      const installer = candidate.release.assets.find((asset) => asset.name === installerName);
      if (installer === undefined) {
        throw new Error(`Release ${candidate.version} has no installer ${installerName}`);
      }
      const sumsAsset = candidate.release.assets.find(
        (asset) => asset.name === SHA256SUMS_ASSET_NAME,
      );
      if (sumsAsset === undefined) {
        throw new Error(`Release ${candidate.version} has no ${SHA256SUMS_ASSET_NAME}`);
      }
      const sumsText = await requestText(
        sumsAsset.browser_download_url,
        `${SHA256SUMS_ASSET_NAME} of release ${candidate.version}`,
        MAX_SUMS_BYTES,
      );
      const sha256 = parseSha256Sums(sumsText).get(installerName);
      if (sha256 === undefined) {
        throw new Error(
          `${SHA256SUMS_ASSET_NAME} of release ${candidate.version} has no hash for ${installerName}`,
        );
      }

      // Docker-сервер не обновляет себя из клиента (требование 41731348):
      // версия видна, но ссылки и хеша для запуска установщика нет.
      const isDocker = options.deployment === 'docker';
      cache = {
        ...cache,
        checked_at: now().toISOString(),
        available_version: candidate.version,
        download_url: isDocker ? null : installer.browser_download_url,
        sha256: isDocker ? null : sha256,
        check_error: null,
      };
      logger?.info(
        {
          channel: options.channel,
          available_version: candidate.version,
          current_version: options.currentVersion,
        },
        "update check: a new version is available",
      );
      return { ...cache };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cache = { ...cache, checked_at: now().toISOString(), check_error: message };
      logger?.warn(
        { err, feed: options.feedUrl, channel: options.channel },
        "update check: the check was not performed",
      );
      return { ...cache };
    } finally {
      inProgress = false;
    }
  }

  return {
    getCache(): UpdateCache {
      return { ...cache };
    },

    isCheckInProgress(): boolean {
      return inProgress;
    },

    async checkNow(): Promise<UpdateCache> {
      if (inProgress) {
        throw new UpdateCheckInProgressError();
      }
      inProgress = true;
      return performCheck();
    },
  };
}

/** Таймеры планировщика (тесты подменяют их «фейковыми часами»). */
export interface UpdateSchedulerTimers {
  setInterval(handler: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Параметры фоновой проверки. */
export interface UpdateSchedulerOptions {
  checker: UpdateChecker;
  /** Интервал между проверками, мс (из `ETN_UPDATE_CHECK_INTERVAL_HOURS`). */
  intervalMs: number;
  logger?: Pick<Logger, 'warn'>;
  /** Таймеры (тесты); по умолчанию глобальные, с `unref()`. */
  timers?: UpdateSchedulerTimers;
}

/** Ручка фоновой проверки: остановка и готовность стартовой проверки. */
export interface UpdateCheckScheduler {
  /** Остановить таймер (идёт ли проверка сейчас — не прерывается). */
  stop(): void;
  /**
   * Промис стартовой проверки. Никогда не отклоняется: ошибка проверки уже
   * записана в кеш. Нужен тестам; сервер его не ждёт — старт не блокируется.
   */
  started: Promise<void>;
}

/** Глобальные таймеры: интервал не удерживает процесс от завершения. */
const DEFAULT_SCHEDULER_TIMERS: UpdateSchedulerTimers = {
  setInterval(handler, intervalMs) {
    const handle = setInterval(handler, intervalMs);
    handle.unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * Запустить фоновую проверку: сразу при старте и затем каждые `intervalMs`.
 *
 * Стартовая проверка запускается, но не ожидается — сервер начинает слушать
 * независимо от доступности фида (DoD задачи). Ошибки проверки не выходят
 * наружу: они уже в кеше, планировщик пишет предупреждение и продолжает.
 * Ручная проверка, идущая в момент тика, не дублируется.
 */
export function startUpdateCheckScheduler(options: UpdateSchedulerOptions): UpdateCheckScheduler {
  const timers = options.timers ?? DEFAULT_SCHEDULER_TIMERS;
  const logger = options.logger;
  let stopped = false;

  const run = async (): Promise<void> => {
    if (stopped) return;
    try {
      await options.checker.checkNow();
    } catch (err) {
      if (err instanceof UpdateCheckInProgressError) {
        // Ручная проверка уже идёт — её результат и будет свежим кешем.
        return;
      }
      logger?.warn({ err }, "update check scheduler: the check was not performed");
    }
  };

  const started = run();
  const handle = timers.setInterval(() => {
    void run();
  }, options.intervalMs);

  return {
    started,
    stop(): void {
      stopped = true;
      timers.clearInterval(handle);
    },
  };
}
