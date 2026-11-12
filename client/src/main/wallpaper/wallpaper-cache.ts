/**
 * Локальный кэш фоновой картинки карты (0.16.1, задача 80324150; сценарий
 * офлайн-старта 0ec86f0b, ADR a5888535).
 *
 * Кэш живёт в каталоге `userData` клиента и переживает перезапуск: офлайн-старт
 * показывает последнюю известную картинку, а при её отсутствии — цветовой фон
 * и сетку. Ключ каталога — профиль сервера + пользователь профиля: картинка
 * серверного уровня, у каждого пользователя своя, и чужой кэш показывать нельзя.
 *
 * Раскладка:
 *
 * ```
 * <userData>/wallpaper/<profile>[-<user>]/
 *   ├── wallpaper.bin    — байты последней картинки (≤5 МиБ по контракту)
 *   └── wallpaper.json   — {mime_type, file_size, content_hash, meta, updated_at}
 * ```
 *
 * `wallpaper.json` — коммит-запись: пишется последней, поэтому недописанная
 * картинка не становится «валидным кэшем» (несовпадение `file_size` с длиной
 * файла тоже отбрасывает запись).
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { WallpaperMeta } from '@etn/shared';

/** Имя файла байтов в каталоге кэша. */
const CACHE_BYTES_FILENAME = 'wallpaper.bin';

/** Имя файла-коммита кэша. */
const CACHE_INDEX_FILENAME = 'wallpaper.json';

/** Запись кэша: байты картинки + метаданные последнего известного файла. */
export interface WallpaperCacheEntry {
  bytes: Buffer;
  mime_type: string;
  file_size: number;
  content_hash: string;
  meta: WallpaperMeta;
  updated_at: number;
}

/** Индекс кэша на диске (без байтов). */
interface WallpaperCacheIndex {
  mime_type: string;
  file_size: number;
  content_hash: string;
  meta: WallpaperMeta;
  updated_at: number;
}

/**
 * Каталог кэша для пары (профиль сервера, пользователь). Оба компонента —
 * uuid-подобные строки из локальной БД; дополнительно они хэшируются, чтобы
 * имя каталога не зависело от допустимых символов и не выходило за границы.
 */
export function wallpaperCacheDir(
  userDataDir: string,
  profileId: string,
  userId: string | null,
): string {
  const key = `${profileId}|${userId ?? 'unknown'}`;
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(userDataDir, 'wallpaper', digest);
}

/** Путь файла байтов кэша (для тестов и диагностики). */
export function wallpaperCacheBytesPath(dir: string): string {
  return path.join(dir, CACHE_BYTES_FILENAME);
}

/** Прочитать кэш; `null` — кэша нет или он повреждён (штатная деградация). */
export function readWallpaperCache(dir: string): WallpaperCacheEntry | null {
  const indexPath = path.join(dir, CACHE_INDEX_FILENAME);
  const bytesPath = wallpaperCacheBytesPath(dir);
  try {
    if (!existsSync(indexPath) || !existsSync(bytesPath)) return null;
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Partial<WallpaperCacheIndex>;
    if (
      typeof index.mime_type !== 'string' ||
      typeof index.file_size !== 'number' ||
      typeof index.content_hash !== 'string' ||
      typeof index.meta !== 'object' ||
      index.meta === null ||
      typeof index.updated_at !== 'number'
    ) {
      return null;
    }
    const bytes = readFileSync(bytesPath);
    // Индекс — коммит: несовпадение размера означает недописанный/битый кэш.
    if (bytes.length !== index.file_size) return null;
    if (statSync(bytesPath).size !== index.file_size) return null;
    return {
      bytes,
      mime_type: index.mime_type,
      file_size: index.file_size,
      content_hash: index.content_hash,
      meta: index.meta as WallpaperMeta,
      updated_at: index.updated_at,
    };
  } catch {
    return null;
  }
}

/**
 * Записать кэш атомарно: байты во временный файл рядом, `rename` поверх, затем
 * индекс. Сбой записи не оставляет «полувалидного» кэша (индекс пишется
 * последним и проверяется по размеру при чтении).
 */
export function writeWallpaperCache(dir: string, entry: WallpaperCacheEntry): void {
  mkdirSync(dir, { recursive: true });
  const bytesPath = wallpaperCacheBytesPath(dir);
  const indexPath = path.join(dir, CACHE_INDEX_FILENAME);
  const tempPath = `${bytesPath}.tmp`;
  writeFileSync(tempPath, entry.bytes);
  renameSync(tempPath, bytesPath);
  const index: WallpaperCacheIndex = {
    mime_type: entry.mime_type,
    file_size: entry.file_size,
    content_hash: entry.content_hash,
    meta: entry.meta,
    updated_at: entry.updated_at,
  };
  writeFileSync(indexPath, JSON.stringify(index));
}

/** Удалить кэш (картинки нет / файл на сервере пропал / DELETE). */
export function clearWallpaperCache(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
