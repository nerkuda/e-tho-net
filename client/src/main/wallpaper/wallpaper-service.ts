/**
 * Состояние фоновой картинки карты для рендерера (0.16.1, задача 80324150;
 * операция API 31ef478a, сценарии 88a8879d и 0ec86f0b, ADR a5888535).
 *
 * Главный процесс — единственный владелец сети и файлов: он решает, откуда
 * взять картинку (сервер или локальный кэш), обновляет кэш после успешного
 * чтения/записи и отдаёт рендереру готовый `data:`-URL. Рендерер не ходит в
 * сеть и не читает диск.
 *
 * Деградация (спека 62fd29b5, ревизия и2; ADR a5888535):
 *   * `404` на метаданные или на байты — картинки нет: кэш очищается, UI
 *     получает `none` и показывает цветовой фон с сеткой; ошибка пользователю
 *     НЕ показывается (это штатное состояние, а не сбой);
 *   * сеть/сервер недоступны на чтении — отдаётся кэш (`source: 'cache'`),
 *     без кэша — `none`;
 *   * ошибки загрузки/удаления пробрасываются вызывающему: UI показывает их в
 *     футере диалога настроек (повтор позже).
 */

import { createHash } from 'node:crypto';

import { EtnError, type WallpaperInfo, type WallpaperMeta } from '@etn/shared';

import {
  clearWallpaperCache,
  readWallpaperCache,
  writeWallpaperCache,
  type WallpaperCacheEntry,
} from './wallpaper-cache.js';

/** Откуда взята картинка: сервер (свежая) или локальный кэш (офлайн). */
export type WallpaperSource = 'server' | 'cache';

/** Состояние картинки в форме IPC: `none` — показывать цветовой фон и сетку. */
export type WallpaperView =
  | { status: 'none' }
  | {
      status: 'ok';
      /** Сеть, к которой относится картинка (ревизия 2026-11-13). */
      network_id: string;
      /** Готовый `data:`-URL для превью и подложки холста. */
      data_url: string;
      mime_type: string;
      file_size: number;
      content_hash: string;
      meta: WallpaperMeta;
      source: WallpaperSource;
    };

/** Вход загрузки: то, что клиент подготовил до отправки (даунскейл + meta). */
export interface WallpaperUploadInput {
  data_base64: string;
  mime_type: string;
  meta: WallpaperMeta;
}

/**
 * Сетевые операции, нужные сервису. Структурно их реализует `RestClient`;
 * отдельный интерфейс оставляет сервис тестируемым без сети.
 */
export interface WallpaperRemote {
  getWallpaper(networkId: string): Promise<WallpaperInfo>;
  getWallpaperRaw(
    networkId: string,
  ): Promise<{ contentType: string; body: Buffer; etag: string | null }>;
  uploadWallpaper(
    networkId: string,
    input: {
      data_base64: string;
      mime_type: string;
      meta: WallpaperMeta;
    },
  ): Promise<WallpaperInfo>;
  deleteWallpaper(networkId: string): Promise<void>;
}

/** Зависимости сервиса. */
export interface WallpaperServiceDeps {
  /** Активное подключение, `null` — клиент офлайн. */
  remote: WallpaperRemote | null;
  /** Сеть, в контексте которой работает картинка (задача 5db41abf). */
  networkId: string;
  /** Каталог локального кэша этой тройки профиль/пользователь/сеть. */
  cacheDir: string;
  /** Часы (для тестов); по умолчанию `Date.now`. */
  now?: () => number;
}

/** `EtnError` с кодом `NOT_FOUND` — «картинки нет», а не сбой. */
function isNotFound(err: unknown): boolean {
  return err instanceof EtnError && err.code === 'NOT_FOUND';
}

/** SHA-256 байтов — тот же хеш, что сервер кладёт в ETag и `content_hash`. */
function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Вариант состояния «картинка есть» — серверная копия или кэш. */
type WallpaperOk = Extract<WallpaperView, { status: 'ok' }>;

/** Запись кэша → состояние для рендерера. */
function cacheView(entry: WallpaperCacheEntry, networkId: string): WallpaperOk {
  return {
    status: 'ok',
    network_id: networkId,
    data_url: `data:${entry.mime_type};base64,${entry.bytes.toString('base64')}`,
    mime_type: entry.mime_type,
    file_size: entry.file_size,
    content_hash: entry.content_hash,
    meta: entry.meta,
    source: 'cache',
  };
}

/**
 * Прочитать картинку: свежая с сервера (и обновить кэш) либо из кэша, когда
 * сервер недоступен. `404` — картинки нет: кэш чистится, ошибка не всплывает.
 */
export async function loadWallpaper(deps: WallpaperServiceDeps): Promise<WallpaperView> {
  const now = deps.now ?? Date.now;
  if (deps.remote === null) {
    const cached = readWallpaperCache(deps.cacheDir);
    return cached === null ? { status: 'none' } : cacheView(cached, deps.networkId);
  }

  try {
    const info = await deps.remote.getWallpaper(deps.networkId);
    const raw = await deps.remote.getWallpaperRaw(deps.networkId);
    const bytes = raw.body;
    const entry: WallpaperCacheEntry = {
      bytes,
      mime_type: raw.contentType || info.mime_type,
      file_size: bytes.length,
      content_hash: raw.etag?.replace(/^"|"$/g, '') ?? sha256Hex(bytes),
      meta: info.meta,
      updated_at: now(),
    };
    try {
      writeWallpaperCache(deps.cacheDir, entry);
    } catch {
      // Кэш — оптимизация для офлайна; сбой диска не должен ломать показ.
    }
    return { ...cacheView(entry, deps.networkId), source: 'server' };
  } catch (err) {
    if (isNotFound(err)) {
      clearWallpaperCache(deps.cacheDir);
      return { status: 'none' };
    }
    // Сеть/сервер недоступны или ответ неожиданный — последняя известная
    // картинка лучше, чем цветовой фон (сценарий 0ec86f0b).
    const cached = readWallpaperCache(deps.cacheDir);
    return cached === null ? { status: 'none' } : cacheView(cached, deps.networkId);
  }
}

/**
 * Загрузить/перезаписать картинку: `PUT /users/me/wallpaper`, затем кэш
 * обновляется отправленными байтами (они же ушли на сервер — превью и холст
 * сразу показывают новое состояние). Офлайн — ошибка наверх: сохранение
 * повторится, когда сервер станет доступен.
 */
export async function uploadWallpaper(
  deps: WallpaperServiceDeps,
  input: WallpaperUploadInput,
): Promise<WallpaperView> {
  if (deps.remote === null) {
    throw new Error('the server is not connected: connect and try again later.');
  }
  const info = await deps.remote.uploadWallpaper(deps.networkId, {
    data_base64: input.data_base64,
    mime_type: input.mime_type,
    meta: input.meta,
  });
  const bytes = Buffer.from(input.data_base64, 'base64');
  const entry: WallpaperCacheEntry = {
    bytes,
    mime_type: info.mime_type,
    file_size: bytes.length,
    content_hash: sha256Hex(bytes),
    meta: info.meta,
    updated_at: (deps.now ?? Date.now)(),
  };
  try {
    writeWallpaperCache(deps.cacheDir, entry);
  } catch {
    // Сбой кэша не отменяет успешную загрузку: сервер уже хранит картинку.
  }
  return { ...cacheView(entry, deps.networkId), source: 'server' };
}

/**
 * Убрать картинку этой сети: `DELETE /users/me/wallpaper?network_id=…`
 * (идемпотентен, сервер всегда 204), затем очистить кэш сети. Ошибка сети
 * пробрасывается — картинка на сервере не удалена, и UI честно сообщает
 * «повторите позже».
 */
export async function removeWallpaper(deps: WallpaperServiceDeps): Promise<void> {
  if (deps.remote !== null) {
    await deps.remote.deleteWallpaper(deps.networkId);
  }
  clearWallpaperCache(deps.cacheDir);
}
