/**
 * Файлы пользователя серверного уровня (0.16.1, задача 8e007e63; сущность
 * 62fd29b5, операция API 31ef478a, ADR a5888535).
 *
 * Хранилище: `<ETN_DATA_DIR>/users/<user_id>/files/<name>` — файлы уровня
 * «пользователь × сервер», вне сетей, НЕ входят в автоматический бэкап БД
 * (исходник остаётся у пользователя, серверная копия восстанавливается повторной
 * загрузкой). Одна строка на пару (пользователь, вид файла); новая загрузка
 * перезаписывает строку и файл, прежний файл удаляется физически.
 *
 * Здесь же — валидация содержимого и метаданных: сервер НЕ обрабатывает
 * изображения (никаких image-зависимостей), он лишь проверяет магические байты
 * (JPEG/PNG/WebP), объявленный mime, лимит 5 МиБ и структуру `meta`, которую
 * посчитал клиент (ширина/высота/средняя светлота).
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  EtnError,
  USER_FILE_MAX_BYTES,
  USER_FILE_MIME_TYPES,
  type UserFileKind,
  type WallpaperInfo,
  type WallpaperMeta,
} from '@etn/shared';

import type { SystemDb, UserFileRow } from '../db/system-db.js';
import { userFilesDir, usersRoot } from '../paths.js';

/** Относительный путь байтов картинки в ответе `GET …/wallpaper` (поле `url`). */
export const WALLPAPER_RAW_PATH = '/api/v1/users/me/wallpaper/raw';

/** Расширение файла по mime — часть имени в каталоге пользователя. */
const MIME_EXTENSION: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Сигнатура PNG (`\x89PNG\r\n\x1a\n`). */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Разобранная загрузка файла (JSON `data_base64` или multipart-часть `file`). */
export interface UserFileUpload {
  /** Mime, объявленный клиентом (обязан совпасть с магическими байтами). */
  mime_type: string;
  buffer: Buffer;
  /** Метаданные от клиента — структура проверяется здесь. */
  meta: unknown;
}

/** Результат записи файла: метаданные ответа + признак «первая загрузка». */
export interface PutUserFileResult {
  info: WallpaperInfo;
  /** `true` — строки не было (201); `false` — перезапись (200). */
  created: boolean;
  row: UserFileRow;
}

/** Найденный на диске файл строки `user_files` (для отдачи байтов). */
export interface StoredUserFile {
  row: UserFileRow;
  filePath: string;
  size: number;
}

/** Проверка «объявленный mime входит в белый список форматов картинки». */
function assertAllowedMime(mimeType: string, requestId?: string): void {
  if (!(USER_FILE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `unsupported image type "${mimeType}". Allowed: ${USER_FILE_MIME_TYPES.join(', ')}.`,
      { field: 'mime_type', allowed: [...USER_FILE_MIME_TYPES] },
      requestId,
    );
  }
}

/**
 * Определить формат по магическим байтам. `null` — содержимое не является
 * картинкой одного из поддерживаемых форматов (ревизия итерации 1: одного
 * объявленного mime недостаточно).
 */
export function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Конечное число (JSON не приносит `NaN`, но `meta` — произвольный JSON). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Проверить структуру `meta` от клиента (операция 31ef478a, «повреждённый meta
 * → 422»): обязательны `width`/`height` (целые > 0) и `avg_luminance` (0..1);
 * необязательные `dominant_hue` (0..360) и `dominant_sat` (0..1) проверяются,
 * только если пришли. Неизвестные ключи не отвергаются — метаданные хранятся
 * как есть (клиент доверенный в рамках своей учётки, сущность 62fd29b5).
 */
export function validateWallpaperMeta(raw: unknown, requestId?: string): WallpaperMeta {
  function fail(reason: string, field = 'meta'): never {
    throw new EtnError(
      'VALIDATION_ERROR',
      `meta is malformed: ${reason}. Expected {width, height, avg_luminance} numbers.`,
      { field, reason },
      requestId,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('not an object');
  }
  const src = raw as Record<string, unknown>;
  const width = src['width'];
  const height = src['height'];
  const avgLuminance = src['avg_luminance'];
  if (!isFiniteNumber(width) || !Number.isInteger(width) || width <= 0) {
    fail('width must be a positive integer', 'meta.width');
  }
  if (!isFiniteNumber(height) || !Number.isInteger(height) || height <= 0) {
    fail('height must be a positive integer', 'meta.height');
  }
  if (!isFiniteNumber(avgLuminance) || avgLuminance < 0 || avgLuminance > 1) {
    fail('avg_luminance must be a number in 0..1', 'meta.avg_luminance');
  }
  const meta: WallpaperMeta = { width, height, avg_luminance: avgLuminance };
  const hue = src['dominant_hue'];
  if (hue !== undefined && hue !== null) {
    if (!isFiniteNumber(hue) || hue < 0 || hue > 360) {
      fail('dominant_hue must be a number in 0..360', 'meta.dominant_hue');
    }
    meta.dominant_hue = hue;
  }
  const sat = src['dominant_sat'];
  if (sat !== undefined && sat !== null) {
    if (!isFiniteNumber(sat) || sat < 0 || sat > 1) {
      fail('dominant_sat must be a number in 0..1', 'meta.dominant_sat');
    }
    meta.dominant_sat = sat;
  }
  return meta;
}

/** Разобрать JSON-метаданные строки; повреждённая запись не роняет ответ. */
function parseStoredMeta(raw: string): WallpaperMeta {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as WallpaperMeta;
    }
  } catch {
    // Повреждённая запись — метаданные пустые; байты при этом отдаются как есть.
  }
  return { width: 0, height: 0, avg_luminance: 0 };
}

/** DTO ответа `GET /users/me/wallpaper` из строки `user_files`. */
export function wallpaperInfo(row: UserFileRow): WallpaperInfo {
  return {
    kind: row.kind as UserFileKind,
    mime_type: row.mime_type,
    file_size: row.file_size,
    meta: parseStoredMeta(row.meta),
    url: WALLPAPER_RAW_PATH,
  };
}

/** Удалить файл строки, если он существует; ошибки ФС не пробрасываются. */
function removeStoredFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Файла уже нет — «строка есть, файла нет» штатна (GET …/raw → 404).
  }
}

/**
 * Записать/перезаписать файл пользователя (PUT операции 31ef478a).
 *
 * Порядок: проверки → файл на диск (атомарная подмена через временное имя) →
 * строка в БД → удаление прежнего файла. Сбой записи в БД убирает новый файл и
 * оставляет прежний рабочим.
 */
export function putUserFile(
  sys: SystemDb,
  dataDir: string,
  userId: string,
  kind: UserFileKind,
  upload: UserFileUpload,
  requestId?: string,
): PutUserFileResult {
  const declared = upload.mime_type.trim().toLowerCase();

  const size = upload.buffer.length;
  if (size === 0) {
    throw new EtnError('VALIDATION_ERROR', 'the file is empty.', { field: 'file' }, requestId);
  }
  if (size > USER_FILE_MAX_BYTES) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `file is too large: ${size} bytes, limit is ${USER_FILE_MAX_BYTES}.`,
      { field: 'file_size', limit: USER_FILE_MAX_BYTES, actual: size },
      requestId,
    );
  }

  // Порядок проверок: лимит → объявленный mime (белый список) → содержимое
  // (магические байты) → совпадение. Белый список проверяется первым, чтобы
  // «формат не поддерживается» диагностировался независимо от содержимого;
  // когда клиент mime не объявил, тип берётся из магических байтов.
  if (declared !== '') {
    assertAllowedMime(declared, requestId);
  }
  const detected = detectImageMime(upload.buffer);
  if (detected === null) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'the uploaded content is not a JPEG/PNG/WebP image (magic bytes do not match).',
      { field: 'file', reason: 'not_an_image' },
      requestId,
    );
  }
  const mimeType = declared === '' ? detected : declared;
  if (detected !== mimeType) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `the uploaded content is ${detected}, but mime_type says ${mimeType}.`,
      { field: 'mime_type', declared: mimeType, detected },
      requestId,
    );
  }

  const meta = validateWallpaperMeta(upload.meta, requestId);
  const contentHash = createHash('sha256').update(upload.buffer).digest('hex');
  const extension = MIME_EXTENSION[mimeType] ?? 'bin';
  const dir = userFilesDir(dataDir, userId);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${kind}-${contentHash.slice(0, 16)}.${extension}`);

  // Атомарная подмена: пишем во временный файл рядом и переименовываем поверх.
  const tempPath = path.join(dir, `.upload-${randomUUID()}.tmp`);
  writeFileSync(tempPath, upload.buffer);
  try {
    renameSync(tempPath, filePath);
  } catch (err) {
    removeStoredFile(tempPath);
    throw err;
  }

  const previous = sys.getUserFile(userId, kind);
  const row: UserFileRow = {
    user_id: userId,
    kind,
    file_path: filePath,
    content_hash: contentHash,
    file_size: size,
    mime_type: mimeType,
    meta: JSON.stringify(meta),
    updated_at: Date.now(),
  };
  try {
    sys.upsertUserFile(row);
  } catch (err) {
    // Строка не записалась — новый файл не должен остаться сиротой.
    if (previous === null || previous.file_path !== filePath) removeStoredFile(filePath);
    throw err;
  }
  if (previous !== null && previous.file_path !== filePath) {
    removeStoredFile(previous.file_path);
  }
  return { info: wallpaperInfo(row), created: previous === null, row };
}

/**
 * Файл строки, пригодный к отдаче, или `null`: нет строки ИЛИ нет файла на
 * диске — оба случая дают 404 на `GET …/raw` (ревизия итерации 1: клиент
 * деградирует к типовому фону, строка при этом не считается повреждённой).
 */
export function readUserFile(
  sys: SystemDb,
  userId: string,
  kind: UserFileKind,
): StoredUserFile | null {
  const row = sys.getUserFile(userId, kind);
  if (row === null) return null;
  try {
    const stats = statSync(row.file_path);
    if (!stats.isFile()) return null;
    return { row, filePath: row.file_path, size: stats.size };
  } catch {
    return null;
  }
}

/**
 * Удалить файл пользователя (DELETE операции 31ef478a): строка и файл.
 * Идемпотентно — отсутствие строки/файла не ошибка; возвращает `true`, если
 * строка была.
 */
export function deleteUserFile(sys: SystemDb, userId: string, kind: UserFileKind): boolean {
  const row = sys.getUserFile(userId, kind);
  if (row === null) return false;
  const removed = sys.deleteUserFile(userId, kind);
  removeStoredFile(row.file_path);
  return removed;
}

/**
 * Физическая очистка каталога пользователя при удалении пользователя
 * (ревизия итерации 1: `ON DELETE CASCADE` чистит строки, каталог — здесь).
 * Вызывается ПОСЛЕ удаления строки пользователя; каталог
 * `users/<user_id>/` удаляется целиком.
 */
export function removeUserFiles(dataDir: string, userId: string): void {
  const dir = path.resolve(path.join(usersRoot(dataDir), userId));
  const root = path.resolve(usersRoot(dataDir));
  // Защита от выхода за корень, даже если id когда-нибудь придёт не из БД.
  if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) {
    throw new EtnError('VALIDATION_ERROR', 'user id escapes the users directory.', {
      field: 'user_id',
    });
  }
  if (dir === root) return;
  rmSync(dir, { recursive: true, force: true });
}
