/**
 * Резервное копирование и восстановление баз данных ETN (задача 3acd9c3c).
 *
 * Модуль намеренно **самодостаточен**: в нём нет импортов других файлов
 * проекта, только встроенные модули Node. Это нужно, чтобы тот же
 * скомпилированный файл (`server/dist/db/db-backup.js`) можно было положить в
 * payload установщика под именем `etn-db-tool.mjs`, распаковать во временный
 * каталог и запустить `{app}\node.exe` с рабочим каталогом `{app}\server` —
 * до того, как новый payload установлен и старый CLI заменён. Внешние
 * библиотеки (`better-sqlite3`, `archiver`, `yauzl`) подгружаются через
 * `createRequire`, поэтому разрешаются из `server/node_modules` установленной
 * поставки; статические импорты проекта или пакетов сюда добавлять нельзя.
 *
 * Доступ к базам — только данный модуль: сырой `better-sqlite3` без
 * `SystemDb.open`/`openNetworkDb` и без миграций. Это гарантирует, что бэкап и
 * восстановление не меняют схему и не зависят от текущей версии сервера.
 *
 * Формат архива (спека, сущность 2975c553): ZIP с `_system.db` и
 * `networks/<uuid>/data.db`; вложения не входят. Имя —
 * `etn-backup-<версия>-<YYYYMMDD-HHMMSS>.zip`, при совпадении секунды —
 * суффикс `-2` перед `.zip`. Хранятся три новейших своих архива; чужие файлы
 * и каталоги не трогаются.
 *
 * Коды возврата CLI/инструмента:
 *   0 — успех (в том числе «бэкапить нечего», архив не создаётся);
 *   1 — ожидаемый отказ (битая БД/`integrity_check`, нет прав или места,
 *       неверный источник, занятая БД, ошибка аргументов);
 *   2 — внутренняя или нечитаемая ситуация.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Внешние библиотеки (разрешаются из поставки; статических импортов нет)
// ---------------------------------------------------------------------------

/** Минимальная поверхность `better-sqlite3`, нужная модулю. */
interface SqliteDatabase {
  pragma(sql: string): unknown;
  backup(destination: string): Promise<unknown>;
  exec(sql: string): unknown;
  close(): void;
}

type SqliteConstructor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => SqliteDatabase;

/** Минимальная поверхность `archiver`. */
interface ZipArchive {
  pipe(destination: NodeJS.WritableStream): void;
  file(filename: string, data: { name: string }): void;
  finalize(): Promise<void>;
  on(event: 'error' | 'warning', listener: (error: Error) => void): void;
}

type ArchiverFactory = (
  format: 'zip',
  options?: { zlib?: { level?: number } },
) => ZipArchive;

/** Минимальная поверхность `yauzl`. */
interface ZipEntry {
  fileName: string;
}

interface ZipFile {
  readEntry(): void;
  openReadStream(
    entry: ZipEntry,
    callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void,
  ): void;
  close(): void;
  on(event: 'entry', listener: (entry: ZipEntry) => void): void;
  on(event: 'end' | 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

interface YauzlLibrary {
  open(
    filePath: string,
    options: { lazyEntries?: boolean; autoClose?: boolean },
    callback: (error: Error | null, zip?: ZipFile) => void,
  ): void;
}

const loadedModules = new Map<string, unknown>();

/**
 * Загрузить внешнюю библиотеку. Приоритет — рабочий каталог, если это
 * каталог `@etn/server` (установщик запускает инструмент оттуда), иначе сам
 * модуль (обычный CLI/тесты: `server/dist/db` → `server/node_modules`).
 * Ошибка загрузки — внутренняя ситуация (код 2), а не отказ бэкапа.
 */
function loadExternal<T>(name: string): T {
  const cached = loadedModules.get(name);
  if (cached !== undefined) return cached as T;
  const anchors: string[] = [];
  try {
    const cwdPackage = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as { name?: unknown };
    if (cwdPackage.name === '@etn/server') {
      anchors.push(path.join(process.cwd(), 'etn-db-tool.cjs'));
    }
  } catch {
    // В рабочем каталоге нет package.json — обычный случай CLI.
  }
  anchors.push(fileURLToPath(import.meta.url));
  anchors.push(path.join(process.cwd(), 'etn-db-tool.cjs'));
  let lastError: unknown = null;
  for (const anchor of anchors) {
    try {
      const requireFrom = createRequire(anchor);
      const value = requireFrom(name) as unknown;
      loadedModules.set(name, value);
      return value as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw new DbToolError(
    `Required module "${name}" was not found. The tool must run with the server ` +
      `working directory (its node_modules), for example {app}\\server: ` +
      `${errorText(lastError)}`,
    2,
  );
}

// ---------------------------------------------------------------------------
// Контракт и ошибки
// ---------------------------------------------------------------------------

/** Код возврата контракта: 0 — успех, 1 — ожидаемый отказ, 2 — внутренняя ошибка. */
export type DbToolExitCode = 0 | 1 | 2;

/** Ошибка контракта с кодом возврата. */
export class DbToolError extends Error {
  readonly code: DbToolExitCode;

  constructor(message: string, code: DbToolExitCode) {
    super(message);
    this.name = 'DbToolError';
    this.code = code;
  }
}

/** Отчёт инструмента: простой `key=value` для разбора из Inno без JSON. */
export interface DbToolReport {
  code: DbToolExitCode;
  archive: string | null;
  databases: number;
  bytes: number;
  error: string | null;
  warnings: string[];
}

/** Сколько своих архивов хранится (спека 2975c553). */
export const DB_BACKUP_KEEP = 3;

/** Имя архива: etn-backup-<версия>-<YYYYMMDD-HHMMSS>[-N].zip. */
export const DB_BACKUP_NAME_PATTERN =
  /^etn-backup-(?<version>.+?)-(?<stamp>\d{8}-\d{6})(?:-(?<suffix>\d+))?\.zip$/;

const SYSTEM_DB_FILENAME = '_system.db';
const NETWORK_DB_FILENAME = 'data.db';
const NETWORKS_DIRNAME = 'networks';

/** База в наборе архива. */
export interface DatabaseSource {
  /** Путь внутри архива через `/`: `_system.db` или `networks/<uuid>/data.db`. */
  entryName: string;
  /** Абсолютный путь на диске. */
  filePath: string;
}

/** Параметры создания архива. */
export interface BackupOptions {
  /** Каталог данных ETN. */
  dataDir: string;
  /** Родительский каталог архивов (`--to`); имя формирует модуль. */
  toDir: string;
  /** Версия для имени архива; по умолчанию — версия сервера. */
  version?: string;
  /** Момент времени для имени (тесты); по умолчанию `new Date()`. */
  now?: Date;
}

/** Параметры восстановления. */
export interface RestoreOptions {
  /** Каталог данных ETN. */
  dataDir: string;
  /** Путь к ZIP-архиву (`--from`). */
  from: string;
  /**
   * Пропустить проверку занятости БД. Установщик передаёт `--force` после
   * остановки службы; ручное восстановление без флага на занятой БД refuses.
   */
  force?: boolean;
  /** Версия сервера для проверки «архив новее»; по умолчанию из package.json. */
  currentVersion?: string;
}

/** Результат операции (без исключения). */
export interface DbToolOutcome<T> {
  report: DbToolReport;
  result: T | null;
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Код системной ошибки Node (`ENOSPC`, `EACCES`, `SQLITE_BUSY`, …). */
function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

/**
 * Ожидаемый отказ: нет прав/места, занятая или битая БД, неверный источник.
 * Внутренние ошибки (неизвестный код, программная ошибка) — код 2.
 */
function isExpectedFailure(error: unknown): boolean {
  const code = errorCode(error);
  if (code === null) return false;
  return (
    code.startsWith('SQLITE_') ||
    code === 'ENOSPC' ||
    code === 'EDQUOT' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'EROFS' ||
    code === 'EBUSY' ||
    code === 'ENOTDIR' ||
    code === 'EISDIR' ||
    code === 'ENOENT' ||
    code === 'ENOTEMPTY' ||
    code === 'EEXIST'
  );
}

/** Код для исключения: ожидаемый отказ — 1, прочее — 2. */
function failureCode(error: unknown): DbToolExitCode {
  if (error instanceof DbToolError) return error.code;
  return isExpectedFailure(error) ? 1 : 2;
}

/** Ошибка-отказ с человекочитаемой причиной. */
function refuse(message: string): never {
  throw new DbToolError(message, 1);
}

/** Строка отчёта: переводы строк схлопываются (формат `key=value`). */
function reportValue(value: string | null | undefined): string {
  if (value === undefined || value === null) return '';
  return value.replace(/\r?\n/g, ' ').trim();
}

/** Сериализовать отчёт в текст `key=value` по строкам. */
export function formatDbToolReport(report: DbToolReport): string {
  return [
    `code=${report.code}`,
    `archive=${reportValue(report.archive)}`,
    `databases=${report.databases}`,
    `bytes=${report.bytes}`,
    `error=${reportValue(report.error)}`,
    `warnings=${reportValue(report.warnings.join(' | '))}`,
    '',
  ].join('\n');
}

/** Записать отчёт в файл (родительские каталоги создаются). */
export function writeDbToolReport(filePath: string, report: DbToolReport): void {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(path.resolve(filePath), formatDbToolReport(report), 'utf8');
}

/** Пустой отчёт с кодом и причиной. */
function failedReport(
  code: DbToolExitCode,
  error: string,
  warnings: string[] = [],
): DbToolReport {
  return { code, archive: null, databases: 0, bytes: 0, error, warnings };
}

/** Локальная метка YYYYMMDD-HHMMSS. */
export function backupTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Версия сервера: package.json рабочего каталога, затем рядом с модулем. */
export function readServerVersion(): string {
  const candidates = [
    path.join(process.cwd(), 'package.json'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version !== '') {
        return parsed.version;
      }
    } catch {
      // Пробуем следующий кандидат.
    }
  }
  return 'unknown';
}

/** Числовое сравнение semver-подобных версий (`X.Y.Z`); `null` — не разобрать. */
export function compareVersions(left: string, right: string): number | null {
  const parse = (value: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    if (match === null) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(left);
  const b = parse(right);
  if (a === null || b === null) return null;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** Найти набор баз данных для архива. */
export function listDatabaseSources(dataDir: string): DatabaseSource[] {
  const result: DatabaseSource[] = [];
  const systemDb = path.join(dataDir, SYSTEM_DB_FILENAME);
  if (fs.existsSync(systemDb) && fs.statSync(systemDb).isFile()) {
    result.push({ entryName: SYSTEM_DB_FILENAME, filePath: systemDb });
  }
  const networksDir = path.join(dataDir, NETWORKS_DIRNAME);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(networksDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const networkNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of networkNames) {
    const filePath = path.join(networksDir, name, NETWORK_DB_FILENAME);
    try {
      if (fs.statSync(filePath).isFile()) {
        result.push({ entryName: `${NETWORKS_DIRNAME}/${name}/${NETWORK_DB_FILENAME}`, filePath });
      }
    } catch {
      // Нет data.db — каталог сети не участвует.
    }
  }
  return result;
}

/** Первое имя архива, свободное от столкновения секунды: суффикс `-2`, `-3`… */
function nextArchivePath(toDir: string, version: string, stamp: string): string {
  const base = `etn-backup-${version}-${stamp}`;
  let candidate = path.join(toDir, `${base}.zip`);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(toDir, `${base}-${suffix}.zip`);
    suffix += 1;
  }
  return candidate;
}

/** Ключ сортировки архива по имени: метка времени + числовой суффикс. */
interface ArchiveName {
  fileName: string;
  stamp: string;
  suffix: number;
}

/** Разобрать имя своего архива; `null` — чужой файл. */
function parseArchiveName(fileName: string): ArchiveName | null {
  const match = DB_BACKUP_NAME_PATTERN.exec(fileName);
  if (match === null) return null;
  const stamp = match.groups?.['stamp'] ?? '';
  const suffixText = match.groups?.['suffix'] ?? '';
  return {
    fileName,
    stamp,
    suffix: suffixText === '' ? 1 : Number(suffixText),
  };
}

/** Свои архивы в каталоге (только обычные файлы). */
function listOwnArchives(toDir: string): ArchiveName[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(toDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const archives: ArchiveName[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseArchiveName(entry.name);
    if (parsed !== null) archives.push(parsed);
  }
  archives.sort((a, b) => {
    if (a.stamp !== b.stamp) return a.stamp < b.stamp ? -1 : 1;
    return a.suffix - b.suffix;
  });
  return archives;
}

/** Удалить старые свои архивы, сохранив текущий и три новейших. */
function rotateArchives(toDir: string, currentPath: string, warnings: string[]): void {
  const currentName = path.basename(currentPath);
  const own = listOwnArchives(toDir);
  const current = own.find((entry) => entry.fileName === currentName);
  const others = own.filter((entry) => entry.fileName !== currentName);
  // Текущий архив — самый новый по определению; храним его и два предыдущих.
  const keepOthers = DB_BACKUP_KEEP - (current === undefined ? 0 : 1);
  const toDelete = others.slice(0, Math.max(0, others.length - keepOthers));
  for (const archive of toDelete) {
    try {
      fs.rmSync(path.join(toDir, archive.fileName), { force: false });
    } catch (error) {
      warnings.push(`failed to delete old archive ${archive.fileName}: ${errorText(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Создание архива
// ---------------------------------------------------------------------------

/** Проверить целостность файла БД; причина отказа — текст. */
function integrityProblem(dbPath: string): string | null {
  const Database = loadExternal<SqliteConstructor>('better-sqlite3');
  let db: SqliteDatabase | null = null;
  try {
    db = new Database(dbPath, { fileMustExist: true });
    const rows = db.pragma('integrity_check');
    if (!Array.isArray(rows) || rows.length === 0) {
      return 'integrity_check returned no rows';
    }
    const problems: string[] = [];
    for (const row of rows) {
      const value =
        typeof row === 'object' && row !== null
          ? String((row as Record<string, unknown>)['integrity_check'] ?? '')
          : String(row);
      if (value !== 'ok') problems.push(value);
    }
    if (rows.length !== 1 || problems.length > 0) {
      return `integrity_check: ${problems.join('; ') || 'unexpected result'}`;
    }
    return null;
  } catch (error) {
    return errorText(error);
  } finally {
    try {
      db?.close();
    } catch {
      // Соединение уже закрыто.
    }
  }
}

/** Сделать самодостаточную копию БД через штатный backup API. */
async function copyDatabaseStandalone(source: string, destination: string): Promise<void> {
  const Database = loadExternal<SqliteConstructor>('better-sqlite3');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(destination, { force: true });
  let sourceDb: SqliteDatabase | null = null;
  let copyDb: SqliteDatabase | null = null;
  try {
    sourceDb = new Database(source, { readonly: true, fileMustExist: true });
    await sourceDb.backup(destination);
    sourceDb.close();
    sourceDb = null;
    // Копия могла унаследовать режим WAL из заголовка: переводим в DELETE,
    // чтобы архив был одним самодостаточным файлом без -wal/-shm.
    copyDb = new Database(destination, { fileMustExist: true });
    copyDb.pragma('journal_mode = DELETE');
    copyDb.close();
    copyDb = null;
    fs.rmSync(`${destination}-wal`, { force: true });
    fs.rmSync(`${destination}-shm`, { force: true });
  } finally {
    try {
      sourceDb?.close();
    } catch {
      // Соединение уже закрыто.
    }
    try {
      copyDb?.close();
    } catch {
      // Соединение уже закрыто.
    }
  }
}

/** Упаковать подготовленные копии в ZIP (временный `.partial`). */
async function writeArchive(
  partialPath: string,
  files: Array<{ filePath: string; entryName: string }>,
): Promise<void> {
  const archiver = loadExternal<ArchiverFactory>('archiver');
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(partialPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    output.on('close', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    output.on('error', fail);
    archive.on('error', fail);
    archive.on('warning', (warning) => fail(warning));
    archive.pipe(output);
    for (const file of files) {
      archive.file(file.filePath, { name: file.entryName });
    }
    void archive.finalize().catch(fail);
  });
}

/**
 * Создать архив резервной копии.
 *
 * @returns отчёт: `archive` — путь к ZIP или `null`, если баз нет.
 * @throws {DbToolError} код 1 — ожидаемый отказ, 2 — внутренняя ошибка.
 */
export async function createBackup(options: BackupOptions): Promise<DbToolReport> {
  const dataDir = path.resolve(options.dataDir);
  const toDir = path.resolve(options.toDir);
  const version = options.version ?? readServerVersion();
  const now = options.now ?? new Date();
  const warnings: string[] = [];

  let sources: DatabaseSource[];
  try {
    sources = listDatabaseSources(dataDir);
  } catch (error) {
    throw new DbToolError(`Failed to read the data directory ${dataDir}: ${errorText(error)}`, 1);
  }
  if (sources.length === 0) {
    return {
      code: 0,
      archive: null,
      databases: 0,
      bytes: 0,
      error: null,
      warnings: [`no databases found in ${dataDir}; nothing to back up`],
    };
  }

  try {
    fs.mkdirSync(toDir, { recursive: true });
    if (!fs.statSync(toDir).isDirectory()) {
      refuse(`the backup directory is not a directory: ${toDir}`);
    }
  } catch (error) {
    if (error instanceof DbToolError) throw error;
    refuse(`failed to create the backup directory ${toDir}: ${errorText(error)}`);
  }

  const archivePath = nextArchivePath(toDir, version, backupTimestamp(now));
  const partialPath = `${archivePath}.partial`;
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-backup-'));
  const files: Array<{ filePath: string; entryName: string }> = [];
  let bytes = 0;
  let completed = false;
  try {
    for (const source of sources) {
      const staged = path.join(stagingDir, source.entryName.replace(/\//g, path.sep));
      await copyDatabaseStandalone(source.filePath, staged);
      const problem = integrityProblem(staged);
      if (problem !== null) {
        refuse(`integrity check failed for ${source.entryName}: ${problem}`);
      }
      bytes += fs.statSync(staged).size;
      files.push({ filePath: staged, entryName: source.entryName });
    }
    fs.rmSync(partialPath, { force: true });
    await writeArchive(partialPath, files);
    fs.renameSync(partialPath, archivePath);
    completed = true;
  } catch (error) {
    if (error instanceof DbToolError) throw error;
    throw new DbToolError(errorText(error), failureCode(error));
  } finally {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      warnings.push(`failed to remove the temporary directory ${stagingDir}`);
    }
    if (!completed) {
      try {
        fs.rmSync(partialPath, { force: true });
      } catch {
        warnings.push(`failed to remove the incomplete archive ${partialPath}`);
      }
    }
  }

  rotateArchives(toDir, archivePath, warnings);

  return {
    code: 0,
    archive: archivePath,
    databases: files.length,
    bytes,
    error: null,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Восстановление из архива
// ---------------------------------------------------------------------------

/** Разобрать имя архива для проверки версии. */
function archiveVersion(from: string): string | null {
  const match = DB_BACKUP_NAME_PATTERN.exec(path.basename(from));
  return match?.groups?.['version'] ?? null;
}

/** Проверить, что архив не новее текущей версии. */
function assertArchiveVersion(from: string, currentVersion: string): void {
  const version = archiveVersion(from);
  if (version === null) return;
  if (version === 'unknown') return;
  const comparison = compareVersions(version, currentVersion);
  if (comparison !== null && comparison > 0) {
    refuse(
      `archive ${path.basename(from)} was created by a newer server version ` +
        `(${version} > ${currentVersion}); restore it with that version`,
    );
  }
}

/** Безопасное имя записи ZIP: только `_system.db` и `networks/<uuid>/data.db`. */
function zipEntryTarget(entryName: string): { relative: string } {
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    refuse(`unsafe path in the archive: ${entryName}`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    refuse(`unsafe path in the archive: ${entryName}`);
  }
  if (normalized === SYSTEM_DB_FILENAME) return { relative: SYSTEM_DB_FILENAME };
  if (
    parts.length === 3 &&
    parts[0] === NETWORKS_DIRNAME &&
    parts[2] === NETWORK_DB_FILENAME
  ) {
    return { relative: `${parts[0]}/${parts[1]}/${parts[2]}` };
  }
  refuse(`unexpected entry in the archive: ${entryName}`);
}

/** Открыть ZIP (yauzl). `autoClose: false`: поток записи открывается после
 *  чтения оглавления, поэтому файл архива должен оставаться открытым. */
function openZip(filePath: string): Promise<ZipFile> {
  const yauzl = loadExternal<YauzlLibrary>('yauzl');
  return new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error !== null) reject(error);
      else if (zip === undefined) reject(new Error('yauzl returned no archive'));
      else resolve(zip);
    });
  });
}

/** Прочитать список записей ZIP. */
function readZipEntries(zip: ZipFile): Promise<ZipEntry[]> {
  return new Promise<ZipEntry[]>((resolve, reject) => {
    const entries: ZipEntry[] = [];
    zip.on('entry', (entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', reject);
    zip.readEntry();
  });
}

/** Извлечь запись ZIP в файл. */
async function extractZipEntry(zip: ZipFile, entry: ZipEntry, destination: string): Promise<void> {
  const stream = await new Promise<Readable>((resolve, reject) => {
    zip.openReadStream(entry, (error, readStream) => {
      if (error !== null) reject(error);
      else if (readStream === undefined) reject(new Error(`empty stream for ${entry.fileName}`));
      else resolve(readStream as Readable);
    });
  });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await pipeline(stream, fs.createWriteStream(destination));
}

/** Проверить, что файл не занят другим процессом: rename-проба (Windows). */
function probeExclusiveAccess(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const probe = `${filePath}.etn-restore-probe`;
  fs.rmSync(probe, { force: true });
  try {
    fs.renameSync(filePath, probe);
  } catch (error) {
    refuse(`database is in use (cannot take exclusive access): ${errorText(error)}`);
  }
  try {
    fs.renameSync(probe, filePath);
  } catch (error) {
    throw new DbToolError(
      `failed to return ${filePath} after the access probe: ${errorText(error)}`,
      2,
    );
  }
}

/** Linux: найти другой процесс, открывший файл (`/proc/<pid>/fd`). */
function processHoldingFile(filePath: string): number | null {
  if (process.platform !== 'linux') return null;
  const wanted = path.resolve(filePath);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    if (Number(entry) === process.pid) continue;
    const fdDir = `/proc/${entry}/fd`;
    let fds: string[] = [];
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = fs.readlinkSync(path.join(fdDir, fd));
        if (target === wanted) return Number(entry);
      } catch {
        // Файловый дескриптор закрылся, пока читали каталог.
      }
    }
  }
  return null;
}

/** Проверить занятость цели до любых изменений. */
function assertTargetNotBusy(dest: string): void {
  const holder = processHoldingFile(dest);
  if (holder !== null) {
    refuse(`database ${dest} is opened by process ${holder}; stop the server first`);
  }
  probeExclusiveAccess(dest);
  for (const suffix of ['-wal', '-shm']) {
    probeExclusiveAccess(`${dest}${suffix}`);
  }
}

/** Удалить журналы SQLite с проверкой результата (до перезаписи). */
function removeSidecars(dest: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dest}${suffix}`;
    try {
      fs.rmSync(sidecar, { force: true });
    } catch (error) {
      refuse(`failed to remove ${sidecar} before restore: ${errorText(error)}`);
    }
    if (fs.existsSync(sidecar)) {
      refuse(`failed to remove ${sidecar} before restore`);
    }
  }
}

/** Сохранить владельца и права прежнего файла (POSIX). */
function preserveOwnership(dest: string, stat: fs.Stats): string[] {
  const warnings: string[] = [];
  try {
    fs.chmodSync(dest, stat.mode & 0o7777);
  } catch (error) {
    warnings.push(`failed to preserve permissions of ${dest}: ${errorText(error)}`);
  }
  if (process.platform !== 'win32') {
    try {
      fs.chownSync(dest, stat.uid, stat.gid);
    } catch (error) {
      warnings.push(`failed to preserve the owner of ${dest}: ${errorText(error)}`);
    }
  }
  return warnings;
}

/**
 * Восстановить базы из ZIP.
 *
 * Порядок: проверка ZIP и `integrity_check` каждой базы → проверка занятости
 * цели → staged-восстановление через `<dest>.restore-tmp` с подменой. До
 * первой перезаписи цель не меняется.
 *
 * @throws {DbToolError} код 1 — ожидаемый отказ, 2 — внутренняя ошибка.
 */
export async function restoreBackup(options: RestoreOptions): Promise<DbToolReport> {
  const dataDir = path.resolve(options.dataDir);
  const from = path.resolve(options.from);
  const currentVersion = options.currentVersion ?? readServerVersion();
  const warnings: string[] = [];

  let fromStat: fs.Stats;
  try {
    fromStat = fs.statSync(from);
  } catch (error) {
    refuse(`backup archive not found: ${from}: ${errorText(error)}`);
  }
  if (fromStat.isDirectory()) {
    refuse(`--from must be a ZIP archive, not a directory: ${from}`);
  }
  if (!fromStat.isFile()) {
    refuse(`--from is not a regular file: ${from}`);
  }
  if (from === dataDir) {
    refuse('--from points to the data directory itself');
  }
  assertArchiveVersion(from, currentVersion);

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-restore-'));
  const staged: Array<{ relative: string; filePath: string }> = [];
  let bytes = 0;
  let zip: ZipFile | null = null;
  try {
    try {
      zip = await openZip(from);
    } catch (error) {
      refuse(`cannot open the backup archive ${from}: ${errorText(error)}`);
    }
    const entries = await readZipEntries(zip);
    if (entries.length === 0) {
      refuse(`the backup archive is empty: ${from}`);
    }
    for (const entry of entries) {
      const target = zipEntryTarget(entry.fileName);
      const stagedPath = path.join(stagingDir, target.relative.replace(/\//g, path.sep));
      try {
        await extractZipEntry(zip, entry, stagedPath);
      } catch (error) {
        refuse(`failed to extract ${entry.fileName}: ${errorText(error)}`);
      }
      const problem = integrityProblem(stagedPath);
      if (problem !== null) {
        refuse(`integrity check failed for ${entry.fileName}: ${problem}`);
      }
      bytes += fs.statSync(stagedPath).size;
      staged.push({ relative: target.relative, filePath: stagedPath });
    }
    if (staged.length === 0) {
      refuse(`the backup archive contains no databases: ${from}`);
    }

    const targets = staged.map((item) => ({
      ...item,
      destination: path.join(dataDir, item.relative.replace(/\//g, path.sep)),
    }));

    if (options.force !== true) {
      for (const target of targets) assertTargetNotBusy(target.destination);
    }

    for (const target of targets) {
      fs.mkdirSync(path.dirname(target.destination), { recursive: true });
      const previousStat = fs.existsSync(target.destination)
        ? fs.statSync(target.destination)
        : null;
      removeSidecars(target.destination);
      const temporary = `${target.destination}.restore-tmp`;
      const previous = `${target.destination}.restore-old`;
      fs.rmSync(temporary, { force: true });
      fs.rmSync(previous, { recursive: true, force: true });
      fs.copyFileSync(target.filePath, temporary);
      if (previousStat !== null) {
        fs.renameSync(target.destination, previous);
        try {
          fs.renameSync(temporary, target.destination);
        } catch (error) {
          try {
            fs.renameSync(previous, target.destination);
          } catch {
            // Прежний файл остался под именем .restore-old — путь виден в тексте.
          }
          throw new DbToolError(
            `failed to replace ${target.destination}: ${errorText(error)}`,
            2,
          );
        }
        warnings.push(...preserveOwnership(target.destination, previousStat));
        try {
          fs.rmSync(previous, { recursive: true, force: true });
        } catch (error) {
          warnings.push(`failed to remove ${previous}: ${errorText(error)}`);
        }
      } else {
        fs.renameSync(temporary, target.destination);
      }
    }
  } catch (error) {
    if (error instanceof DbToolError) throw error;
    throw new DbToolError(errorText(error), failureCode(error));
  } finally {
    try {
      zip?.close();
    } catch {
      // Файл архива уже закрыт.
    }
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      warnings.push(`failed to remove the temporary directory ${stagingDir}`);
    }
  }

  return {
    code: 0,
    archive: from,
    databases: staged.length,
    bytes,
    error: null,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// CLI: разбор аргументов и команды
// ---------------------------------------------------------------------------

/** Ошибка аргументов CLI (код 1). */
export class DbCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbCliError';
  }
}

/** Аргументы `backup`. */
export interface BackupArgs {
  to: string;
  dataDir: string | null;
  reportOut: string | null;
}

/** Аргументы `restore`. */
export interface RestoreArgs {
  from: string;
  dataDir: string | null;
  reportOut: string | null;
  force: boolean;
}

export const HELP_BACKUP = `Usage: etn backup --to <dir> [options]

Creates a ZIP archive of the ETN databases in <dir>:
  _system.db and networks/<uuid>/data.db. Attachments are not included.
Archive name: etn-backup-<version>-<YYYYMMDD-HHMMSS>.zip. The three newest
archives are kept; foreign files are not touched.

Options:
  --to <dir>            Parent directory for the archive (required).
  --data-dir <dir>      ETN data directory (default: ETN_DATA_DIR).
  --report-out <file>   Write a key=value report (for the installer).
  --help                Show this help.

Exit codes: 0 — success (including "nothing to back up"), 1 — expected refusal
(corrupt database, no permission or space, bad arguments), 2 — internal error.`;

export const HELP_RESTORE = `Usage: etn restore --from <zip> [options]

Restores _system.db and networks/<uuid>/data.db from a backup archive.
The archive and every database are verified (integrity_check) before the
target is touched. A staged replacement is used (<dest>.restore-tmp).

Options:
  --from <zip>          Backup archive (required).
  --data-dir <dir>      ETN data directory (default: ETN_DATA_DIR).
  --force               Skip the busy-database check (the installer passes it
                        after stopping the service).
  --report-out <file>   Write a key=value report (for the installer).
  --help                Show this help.

Exit codes: 0 — success, 1 — expected refusal (bad archive, corrupt database,
busy database, no permission, bad arguments), 2 — internal error.`;

export const HELP_DB_TOOL = `Usage: etn-db-tool <command> [options]

Commands:
  backup    Create a ZIP archive of the ETN databases.
  restore   Restore the ETN databases from a ZIP archive.

Run: etn-db-tool <command> --help for command help.`;

/** Требовать значение флага. */
function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new DbCliError(`Argument ${flag} requires a value.`);
  }
  return value.trim();
}

/**
 * Разобрать общие аргументы `--data-dir` / `--report-out` / `--help`.
 *
 * @returns 0 — аргумент не общий, 1 — обработан без значения,
 *   2 — обработан вместе со значением (вызывающий пропускает следующий токен).
 */
function parseCommon(
  tokens: string[],
  state: { dataDir: string | null; reportOut: string | null; help: boolean },
  index: number,
): 0 | 1 | 2 {
  const token = tokens[index]!;
  if (token === '--data-dir') {
    state.dataDir = requireValue('--data-dir', tokens[index + 1]);
    return 2;
  }
  if (token.startsWith('--data-dir=')) {
    state.dataDir = requireValue('--data-dir', token.slice('--data-dir='.length));
    return 1;
  }
  if (token === '--report-out') {
    state.reportOut = requireValue('--report-out', tokens[index + 1]);
    return 2;
  }
  if (token.startsWith('--report-out=')) {
    state.reportOut = requireValue('--report-out', token.slice('--report-out='.length));
    return 1;
  }
  if (token === '--help' || token === '-h') {
    state.help = true;
    return 1;
  }
  return 0;
}

/** Разобрать `backup`. */
export function parseBackupArgs(tokens: string[]): BackupArgs | null {
  const state = { dataDir: null as string | null, reportOut: null as string | null, help: false };
  let to: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '--to') {
      to = requireValue('--to', tokens[++i]);
    } else if (token.startsWith('--to=')) {
      to = requireValue('--to', token.slice('--to='.length));
    } else {
      const consumed = parseCommon(tokens, state, i);
      if (consumed === 0) throw new DbCliError(`Unknown argument: ${token}`);
      if (consumed === 2) i += 1;
    }
  }
  if (state.help) return null;
  if (to === null) {
    throw new DbCliError(
      'The --to argument is required. Example: etn backup --to "%ProgramData%\\ETN\\backups"',
    );
  }
  return { to, dataDir: state.dataDir, reportOut: state.reportOut };
}

/** Разобрать `restore`. */
export function parseRestoreArgs(tokens: string[]): RestoreArgs | null {
  const state = { dataDir: null as string | null, reportOut: null as string | null, help: false };
  let from: string | null = null;
  let force = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '--from') {
      from = requireValue('--from', tokens[++i]);
    } else if (token.startsWith('--from=')) {
      from = requireValue('--from', token.slice('--from='.length));
    } else if (token === '--force') {
      force = true;
    } else {
      const consumed = parseCommon(tokens, state, i);
      if (consumed === 0) throw new DbCliError(`Unknown argument: ${token}`);
      if (consumed === 2) i += 1;
    }
  }
  if (state.help) return null;
  if (from === null) {
    throw new DbCliError('The --from argument is required. Example: etn restore --from backup.zip');
  }
  return { from, dataDir: state.dataDir, reportOut: state.reportOut, force };
}

/** Каталог данных: `--data-dir` или `ETN_DATA_DIR`. */
function resolveDataDir(dataDir: string | null, env: NodeJS.ProcessEnv): string {
  const raw = dataDir ?? env['ETN_DATA_DIR']?.trim() ?? '';
  if (raw === '') {
    throw new DbCliError(
      'The data directory is not set: pass --data-dir or set ETN_DATA_DIR.',
    );
  }
  return raw;
}

/** Написать отчёт, если он запрошен; ошибка записи — код 2. */
function emitReport(pathOrNull: string | null, report: DbToolReport): DbToolExitCode {
  if (pathOrNull === null) return report.code;
  try {
    writeDbToolReport(pathOrNull, report);
    return report.code;
  } catch (error) {
    console.error(`Failed to write the report ${pathOrNull}: ${errorText(error)}`);
    return 2;
  }
}

/** Печать предупреждений. */
function printWarnings(warnings: string[]): void {
  for (const warning of warnings) console.error(`warning: ${warning}`);
}

/**
 * Выполнить `backup` (CLI и инструмент).
 *
 * @returns код возврата контракта.
 */
export async function runBackupCli(
  tokens: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<DbToolExitCode> {
  let args: BackupArgs | null;
  try {
    args = parseBackupArgs(tokens);
  } catch (error) {
    console.error(errorText(error));
    return 1;
  }
  if (args === null) {
    console.log(HELP_BACKUP);
    return 0;
  }
  let dataDir: string;
  try {
    dataDir = resolveDataDir(args.dataDir, env);
  } catch (error) {
    console.error(errorText(error));
    return emitReport(args.reportOut, failedReport(1, errorText(error)));
  }
  try {
    const report = await createBackup({ dataDir, toDir: args.to });
    if (report.archive === null) {
      console.log('No databases to back up; no archive was created.');
    } else {
      console.log(
        `Backup created: ${report.archive} (databases: ${report.databases}, ` +
          `bytes: ${report.bytes})`,
      );
    }
    printWarnings(report.warnings);
    return emitReport(args.reportOut, report);
  } catch (error) {
    const code = failureCode(error);
    const message = errorText(error);
    console.error(`Backup failed: ${message}`);
    return emitReport(args.reportOut, failedReport(code, message));
  }
}

/**
 * Выполнить `restore` (CLI и инструмент).
 *
 * @returns код возврата контракта.
 */
export async function runRestoreCli(
  tokens: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<DbToolExitCode> {
  let args: RestoreArgs | null;
  try {
    args = parseRestoreArgs(tokens);
  } catch (error) {
    console.error(errorText(error));
    return 1;
  }
  if (args === null) {
    console.log(HELP_RESTORE);
    return 0;
  }
  let dataDir: string;
  try {
    dataDir = resolveDataDir(args.dataDir, env);
  } catch (error) {
    console.error(errorText(error));
    return emitReport(args.reportOut, failedReport(1, errorText(error)));
  }
  try {
    const report = await restoreBackup({
      dataDir,
      from: args.from,
      force: args.force,
    });
    console.log(
      `Restore completed: ${report.databases} database(s), ${report.bytes} byte(s) ` +
        `from ${report.archive}`,
    );
    printWarnings(report.warnings);
    return emitReport(args.reportOut, report);
  } catch (error) {
    const code = failureCode(error);
    const message = errorText(error);
    console.error(`Restore failed: ${message}`);
    return emitReport(args.reportOut, failedReport(code, message));
  }
}

// ---------------------------------------------------------------------------
// Точка входа самодостаточного инструмента
// ---------------------------------------------------------------------------

/**
 * Точка входа `etn-db-tool` (payload установщика). Тот же файл, что импортирует
 * `cli.ts`; при прямом запуске обрабатывает `backup`/`restore`.
 */
export async function dbToolMain(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DbToolExitCode> {
  const tokens = argv.slice(2);
  const command = tokens[0];
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    console.log(HELP_DB_TOOL);
    return command === undefined ? 1 : 0;
  }
  if (command === 'backup') return runBackupCli(tokens.slice(1), env);
  if (command === 'restore') return runRestoreCli(tokens.slice(1), env);
  console.error(`Unknown command: ${command}`);
  console.log(HELP_DB_TOOL);
  return 1;
}

/** Прямой запуск: инструмент из payload или `node dist/db/db-backup.js`. */
const invokedScript = process.argv[1];
if (invokedScript !== undefined) {
  const invoked = path.resolve(invokedScript);
  const self = path.resolve(fileURLToPath(import.meta.url));
  if (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) {
    dbToolMain()
      .then((code) => process.exit(code))
      .catch((error: unknown) => {
        console.error(errorText(error));
        process.exit(2);
      });
  }
}
