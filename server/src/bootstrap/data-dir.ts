/**
 * Bootstrap каталога данных пакета `etn-mcp` (ADR aa9507e6, задача 760402ba).
 *
 * Единственная точка вызова — обработчик подкоманды `etn mcp` (и обёртка
 * `dist/bin/etn-mcp.js`, которая лишь подставляет подкоманду и личный каталог).
 * Модуль делает всё, что нужно до открытия MCP-сессии:
 *
 * 1. **Классификация по первому администратору**, а не по наличию `_system.db`:
 *    критерий — `SystemDb.checkFirstUser()` (`no-db` / `no-users-table` /
 *    `no-first-user` = «не инициализирован», база от прерванной попытки
 *    инициализируется заново).
 * 2. **Владение** — маркер `mcp/ownership.json` (`kind: etn-mcp`). Маркер
 *    повреждён/неполон = «маркера нет», файл не перезаписывается до решения.
 *    Маркера нет и администратор есть → присоединение только по доверенному
 *    ключу (`ETN_API_KEY` / `--api-key`), иначе понятный отказ.
 * 3. **Инициализация** — маркер пишется **до** БД (атомарно, временный файл
 *    вне `mcp/`), затем БД + первый администратор (`etn-mcp` /
 *    `ETN MCP (local)`), затем `mcp/key` (0600). Прерывание переживается:
 *    маркер без БД → повторная инициализация; БД + маркер без ключа → ключ
 *    перевыпускается.
 * 4. **Отказы** — непустой чужой каталог (посторонние файлы в корне или в
 *    `mcp/`), недоступный на запись каталог, неинициализированный каталог при
 *    явном ключе. Сообщения английские (ADR daab6ac4) и уходят в stderr.
 *
 * stdout не используется вообще: в stdio-режиме там MCP-кадры.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { generateApiKey, isValidApiKeyFormat } from '../auth/api-key.js';
import { SystemDb, type FirstUserCheck } from '../db/system-db.js';
import { createStderrLogger, type Logger } from '../logger.js';
import { MCP_REGISTRY_NAME } from '../mcp/server.js';
import { SYSTEM_DB_FILENAME } from '../paths.js';
import { SERVER_VERSION } from '../version.js';
import { initializeFirstUser } from './first-user.js';

/** Подкаталог зоны пакета в каталоге данных. */
export const MCP_DIRNAME = 'mcp';
/** Маркер владения. */
export const MCP_OWNERSHIP_FILENAME = 'ownership.json';
/** Ключ пакета (0600). */
export const MCP_KEY_FILENAME = 'key';
/** Значение `kind` нашего маркера. */
export const MCP_OWNERSHIP_KIND = 'etn-mcp';
/** Префикс временных файлов атомарной записи (лежат в корне каталога данных). */
export const MCP_TEMP_PREFIX = '.etn-mcp.';
/** Суффикс временных файлов атомарной записи. */
export const MCP_TEMP_SUFFIX = '.tmp';

/** Логин первого администратора, создаваемого пакетом. */
export const MCP_FIRST_ADMIN_USERNAME = 'etn-mcp';
/** Отображаемое имя первого администратора. */
export const MCP_FIRST_ADMIN_DISPLAY_NAME = 'ETN MCP (local)';

/** Права файла ключа (на POSIX; на Windows — ACL каталога пользователя). */
const KEY_FILE_MODE = 0o600;

/** Побочные файлы SQLite рядом с `_system.db`. */
const SYSTEM_DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

/** Ошибка bootstrap (сообщение готово для stderr, английское). */
export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/** Маркер владения (`mcp/ownership.json`). */
export interface OwnershipMarker {
  kind: string;
  server_name: string;
  version: string;
  created_at: string;
}

/** Результат чтения маркера. */
export type OwnershipState =
  | { state: 'absent' }
  | { state: 'own'; marker: OwnershipMarker }
  /** Наш `kind`, но маркер принадлежит другому серверу (ADR d17c3a29 п. 6). */
  | { state: 'mismatch'; serverName: string }
  | { state: 'invalid'; reason: string };

/** Откуда взят ключ MCP-сессии. */
export type BootstrapKeySource = 'argument' | 'environment' | 'file' | 'created' | 'reissued';

/** Параметры {@link bootstrapDataDir}. */
export interface BootstrapOptions {
  /** Каталог данных (уже разрешённый абсолютный путь). */
  dataDir: string;
  /** Окружение (`ETN_API_KEY`); по умолчанию `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Ключ из `--api-key`: доверенное присоединение, инициализации нет. */
  explicitApiKey?: string | null;
  /** Версия ETN для маркера; по умолчанию версия сервера. */
  serverVersion?: string;
  /** Логгер миграций (в stdio — stderr). */
  logger?: Logger;
}

/** Результат bootstrap. */
export interface BootstrapResult {
  dataDir: string;
  apiKey: string;
  source: BootstrapKeySource;
}

/** Непустое значение после trim, иначе `null`. */
function normalize(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Короткое сообщение об ошибке ФС. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Синхронная пауза (повтор read-only пробы при гонке). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Имя нашего временного файла. */
function ownTempName(label: string): string {
  return `${MCP_TEMP_PREFIX}${label}.${process.pid}.${randomUUID().slice(0, 8)}${MCP_TEMP_SUFFIX}`;
}

/** Является ли имя остатком нашей атомарной записи. */
export function isOwnTempName(name: string): boolean {
  return name.startsWith(MCP_TEMP_PREFIX) && name.endsWith(MCP_TEMP_SUFFIX);
}

/** Стереть остатки собственных временных файлов (после прерванного запуска). */
function removeOwnTempFiles(dataDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!isOwnTempName(name)) continue;
    try {
      unlinkSync(path.join(dataDir, name));
    } catch {
      // Не критично: классификация такие файлы и так пропускает.
    }
  }
}

/**
 * Прочитать маркер владения.
 *
 * Невалидный JSON, чужой `kind` или отсутствие обязательных полей — состояние
 * `invalid`: вызывающая сторона трактует его как «маркера нет» (ADR aa9507e6
 * п. 6) и не перезаписывает файл до решения.
 *
 * Валидный маркер с чужим `server_name` — отдельное состояние `mismatch`:
 * это отказ (ADR d17c3a29 п. 6), а не «маркера нет»; чужое имя не затирается.
 */
export function readOwnership(dataDir: string): OwnershipState {
  const file = path.join(dataDir, MCP_DIRNAME, MCP_OWNERSHIP_FILENAME);
  if (!existsSync(file)) return { state: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { state: 'invalid', reason: 'not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { state: 'invalid', reason: 'not a JSON object' };
  }
  const marker = parsed as Partial<OwnershipMarker>;
  if (marker.kind !== MCP_OWNERSHIP_KIND) {
    return { state: 'invalid', reason: `kind is not ${JSON.stringify(MCP_OWNERSHIP_KIND)}` };
  }
  if (typeof marker.server_name !== 'string' || marker.server_name.trim() === '') {
    return { state: 'invalid', reason: 'server_name is missing' };
  }
  if (marker.server_name.trim() !== MCP_REGISTRY_NAME) {
    return { state: 'mismatch', serverName: marker.server_name };
  }
  if (typeof marker.version !== 'string' || marker.version.trim() === '') {
    return { state: 'invalid', reason: 'version is missing' };
  }
  return {
    state: 'own',
    marker: {
      kind: marker.kind,
      server_name: marker.server_name,
      version: marker.version,
      created_at: typeof marker.created_at === 'string' ? marker.created_at : '',
    },
  };
}

/**
 * Отказ на маркер чужого сервера (ADR d17c3a29 п. 6): маркер объявляет, чей
 * это каталог, поэтому его нельзя перезаписать ни на одном пути — включая
 * присоединение по доверенному ключу.
 */
function refuseForeignMarker(dataDir: string, ownership: OwnershipState): void {
  if (ownership.state !== 'mismatch') return;
  throw new BootstrapError(
    `The ETN data directory ${dataDir} is owned by another server: the ownership marker ` +
      `declares ${JSON.stringify(ownership.serverName)}, while this package is ` +
      `${JSON.stringify(MCP_REGISTRY_NAME)}. etn-mcp does not modify a directory it does not own.`,
  );
}

/**
 * Чужое содержимое подкаталога `mcp/`.
 *
 * `own` — маркер наш: тогда `mcp/key` тоже допустим (немаркерный ключ — след
 * прерванной инициализации, его перезапишет инициализация). Без нашего маркера
 * любой файл, кроме `ownership.json`, чужой (ADR aa9507e6 п. 6).
 */
function foreignMcpEntries(mcpDir: string, own: boolean): string[] {
  let entries: string[];
  try {
    entries = readdirSync(mcpDir);
  } catch {
    return [];
  }
  const foreign: string[] = [];
  for (const name of entries) {
    if (name === MCP_OWNERSHIP_FILENAME) continue;
    if (own && name === MCP_KEY_FILENAME) continue;
    foreign.push(`mcp/${name}`);
  }
  return foreign;
}

/**
 * Чужое содержимое каталога данных в состоянии «не инициализирован».
 *
 * Допустимы только `_system.db` со служебными файлами, `mcp/` (с нашим
 * маркером — вместе с `mcp/key`) и наши остаточные temp-файлы. `own` —
 * маркер наш: это прерванная инициализация, свой ключ чужаком не считается.
 */
function foreignRootEntries(dataDir: string, own: boolean): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return [];
  }
  const foreign: string[] = [];
  for (const name of entries) {
    if (name === MCP_DIRNAME) {
      foreign.push(...foreignMcpEntries(path.join(dataDir, name), own));
      continue;
    }
    if (name === SYSTEM_DB_FILENAME) continue;
    if (SYSTEM_DB_SIDECAR_SUFFIXES.some((suffix) => name === `${SYSTEM_DB_FILENAME}${suffix}`)) {
      continue;
    }
    if (isOwnTempName(name)) continue;
    foreign.push(name);
  }
  return foreign;
}

/** Проверить, что каталог существует и доступен на запись. */
function assertWritable(dataDir: string): void {
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    throw new BootstrapError(
      `The ETN data directory ${dataDir} is not available: ${errorText(err)}.`,
    );
  }
  const probe = path.join(dataDir, ownTempName('probe'));
  try {
    writeFileSync(probe, '', { flag: 'wx' });
  } catch (err) {
    throw new BootstrapError(
      `The ETN data directory ${dataDir} is not writable: ${errorText(err)}.`,
    );
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // probe уже удалён или не создан — не мешает.
    }
  }
}

/**
 * Атомарная запись: временный файл создаётся **в корне каталога данных**
 * (не в `mcp/`), затем переименовывается в цель. При сбое temp удаляется, а
 * если не удалось — при следующем запуске распознаётся как наш и стирается.
 */
function writeFileAtomic(dataDir: string, target: string, contents: string, mode?: number): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(dataDir, ownTempName(path.basename(target)));
  try {
    writeFileSync(tmp, contents, mode === undefined ? undefined : { mode });
    renameSync(tmp, target);
    if (mode !== undefined && process.platform !== 'win32') {
      chmodSync(target, mode);
    }
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // см. контракт функции
    }
    throw err;
  }
}

/** Записать маркер владения (первым, до БД). */
function writeOwnership(dataDir: string, version: string): void {
  const marker: OwnershipMarker = {
    kind: MCP_OWNERSHIP_KIND,
    server_name: MCP_REGISTRY_NAME,
    version,
    created_at: new Date().toISOString(),
  };
  writeFileAtomic(
    dataDir,
    path.join(dataDir, MCP_DIRNAME, MCP_OWNERSHIP_FILENAME),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
}

/** Прочитать `mcp/key`, если это валидный ключ. */
export function readMcpKey(dataDir: string): string | null {
  const file = path.join(dataDir, MCP_DIRNAME, MCP_KEY_FILENAME);
  if (!existsSync(file)) return null;
  try {
    const key = readFileSync(file, 'utf8').trim();
    return isValidApiKeyFormat(key) ? key : null;
  } catch {
    return null;
  }
}

/** Записать `mcp/key` (0600, атомарно). */
function writeMcpKey(dataDir: string, key: string): void {
  writeFileAtomic(
    dataDir,
    path.join(dataDir, MCP_DIRNAME, MCP_KEY_FILENAME),
    `${key}\n`,
    KEY_FILE_MODE,
  );
}

/**
 * Выпустить новый ключ первому администратору (восстановление после
 * прерванного запуска). Старые ключи не отзываются.
 */
function issueKeyForFirstUser(sys: SystemDb): string {
  const firstUser = sys.listUsers().find((user) => user.is_first_user);
  if (firstUser === undefined) {
    throw new BootstrapError(
      'The ETN data directory has no first administrator; initialization is required.',
    );
  }
  const generated = generateApiKey();
  const keyId = randomUUID();
  sys.createApiKey({
    id: keyId,
    userId: firstUser.id,
    label: 'etn-mcp',
    keyHash: generated.keyHash,
    keyPrefix: generated.keyPrefix,
  });
  sys.insertAuditLog({
    category: 'auth',
    action: 'api_key.create',
    actorUserId: firstUser.id,
    targetType: 'api_key',
    targetId: keyId,
    details: { by: MCP_OWNERSHIP_KIND },
  });
  return generated.key;
}

/** Read-only проба первого администратора с короткими повторами при гонке. */
function probeFirstUser(dataDir: string): FirstUserCheck {
  let result = SystemDb.checkFirstUser(dataDir);
  for (let attempt = 0; attempt < 5 && result.state === 'unreadable'; attempt += 1) {
    sleepSync(100);
    result = SystemDb.checkFirstUser(dataDir);
  }
  return result;
}

/** Перевыпустить ключ в уже инициализированном своём каталоге. */
function reissueKey(dataDir: string, logger?: Logger): string {
  const sys = SystemDb.open(dataDir, logger ?? createStderrLogger());
  try {
    const key = sys.transaction(() => issueKeyForFirstUser(sys));
    writeMcpKey(dataDir, key);
    return key;
  } finally {
    sys.close();
  }
}

/**
 * Гонка двух одновременных запусков на одном каталоге: SQLite отдаёт
 * `SQLITE_BUSY` («database is locked»), а проигравший вставку первого
 * администратора — `UNIQUE constraint failed: users.username` (оба пишут логин
 * `etn-mcp`). Оба исхода преходящи: повтор видит готовую базу.
 */
const TRANSIENT_RACE = /database is locked|SQLITE_BUSY|UNIQUE constraint failed: users\.username/i;

/** Сколько раз повторять инициализацию при гонке (по 200 мс = 10 с). */
const RACE_RETRIES = 50;

/** Признак преходящей гонки (включая обёрнутые `MigrationError.cause`). */
function isTransientRace(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'string') {
      if (TRANSIENT_RACE.test(current)) return true;
      return false;
    }
    if (typeof current !== 'object') return false;
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && candidate.code.startsWith('SQLITE_BUSY')) return true;
    if (typeof candidate.message === 'string' && TRANSIENT_RACE.test(candidate.message)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Классифицировать неинициализированный каталог: маркер и чужое содержимое.
 *
 * Маркер читается на момент листинга, а не берётся из снимка, прочитанного до
 * пробы первого администратора: параллельный первый запуск пишет маркер **до**
 * БД, поэтому к моменту, когда виден его `mcp/key`, маркер уже на диске. Если
 * листинг со снимком «маркера нет» всё-таки нашёл файлы, маркер перечитывается
 * один раз — иначе собственный ключ победителя выглядел бы чужим
 * (`not empty … found: mcp/key`, замечание реверификации 21f4bac7). Повторное
 * чтение стоит только на пути отказа: у своего маркера `mcp/key` не чужак
 * (прерванная инициализация, ADR aa9507e6 п. 6).
 */
function classifyNotInitialized(dataDir: string): {
  ownership: OwnershipState;
  foreign: string[];
} {
  const ownership = readOwnership(dataDir);
  refuseForeignMarker(dataDir, ownership);
  const foreign = foreignRootEntries(dataDir, ownership.state === 'own');
  if (foreign.length === 0 || ownership.state === 'own') return { ownership, foreign };
  const reread = readOwnership(dataDir);
  refuseForeignMarker(dataDir, reread);
  return { ownership: reread, foreign: foreignRootEntries(dataDir, reread.state === 'own') };
}

/**
 * Инициализировать неинициализированный каталог: маркер, администратор, ключ.
 *
 * Один проход; при гонке параллельного запуска выбрасывает ошибку SQLite, а
 * {@link bootstrapDataDir} повторяет проход (см. {@link isTransientRace}).
 */
function initializeDataDir(dataDir: string, version: string, log: Logger): BootstrapResult {
  assertWritable(dataDir);
  removeOwnTempFiles(dataDir);
  // Классификация — по маркеру на момент листинга, а не по снимку до пробы:
  // победитель гонки пишет маркер до БД, поэтому его `mcp/key` уже виден, когда
  // снимок ещё говорит «маркера нет» (замечание реверификации 21f4bac7).
  const { ownership, foreign } = classifyNotInitialized(dataDir);
  if (foreign.length > 0) {
    throw new BootstrapError(
      `The ETN data directory ${dataDir} is not empty and does not belong to etn-mcp; ` +
        `found: ${foreign.join(', ')}. Choose another directory or initialize it manually ` +
        'with "etn init".',
    );
  }
  if (ownership.state !== 'own') {
    writeOwnership(dataDir, version);
  }

  const sys = SystemDb.open(dataDir, log);
  try {
    const generated = generateApiKey();
    const created = sys.transaction(() =>
      initializeFirstUser(
        sys,
        {
          username: MCP_FIRST_ADMIN_USERNAME,
          displayName: MCP_FIRST_ADMIN_DISPLAY_NAME,
          by: MCP_OWNERSHIP_KIND,
        },
        generated,
      ),
    );
    if (created) {
      writeMcpKey(dataDir, generated.key);
      return { dataDir, apiKey: generated.key, source: 'created' };
    }
    // Гонку выиграл другой запуск: его ключ мог быть записан, мог — нет.
    const fromFile = readMcpKey(dataDir);
    if (fromFile !== null) {
      return { dataDir, apiKey: fromFile, source: 'file' };
    }
    const key = sys.transaction(() => issueKeyForFirstUser(sys));
    writeMcpKey(dataDir, key);
    return { dataDir, apiKey: key, source: 'reissued' };
  } finally {
    sys.close();
  }
}

/**
 * Подготовить каталог данных к MCP-сессии и вернуть ключ.
 *
 * @throws {BootstrapError} с английским сообщением для stderr.
 */
export function bootstrapDataDir(options: BootstrapOptions): BootstrapResult {
  const dataDir = path.resolve(options.dataDir);
  const env = options.env ?? process.env;
  const version = options.serverVersion ?? SERVER_VERSION;
  // stdout занят MCP-кадрами: миграции и служебные сообщения — только stderr.
  const log = options.logger ?? createStderrLogger();

  for (let attempt = 0; ; attempt += 1) {
    try {
      return bootstrapOnce(dataDir, env, version, log, options.explicitApiKey);
    } catch (err) {
      // Повторяем весь проход: он заново классифицирует каталог, поэтому после
      // победы параллельного запуска второй берёт его `mcp/key`.
      if (attempt + 1 < RACE_RETRIES && isTransientRace(err)) {
        sleepSync(200);
        continue;
      }
      throw err;
    }
  }
}

/** Один проход {@link bootstrapDataDir} (см. описание выше). */
function bootstrapOnce(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  version: string,
  log: Logger,
  explicitApiKey: string | null | undefined,
): BootstrapResult {
  const explicit = normalize(explicitApiKey);
  const envKey = normalize(env.ETN_API_KEY);
  const trusted = explicit ?? envKey;

  // Чужой маркер — отказ на любом пути, включая присоединение по ключу
  // (ADR d17c3a29 п. 6): маркер объявляет, чей это каталог.
  refuseForeignMarker(dataDir, readOwnership(dataDir));

  const firstUser = probeFirstUser(dataDir);
  if (firstUser.state === 'unreadable') {
    throw new BootstrapError(
      `Failed to inspect the ETN data directory ${dataDir}: ${firstUser.error}.`,
    );
  }

  if (trusted !== null) {
    if (firstUser.state !== 'initialized') {
      throw new BootstrapError(
        `The ETN data directory ${dataDir} is not initialized: an API key can only attach to an ` +
          'existing ETN server (the first administrator must exist). Run "etn init" first, or ' +
          'start etn-mcp without ETN_API_KEY to initialize a new directory.',
      );
    }
    return {
      dataDir,
      apiKey: trusted,
      source: explicit !== null ? 'argument' : 'environment',
    };
  }

  if (firstUser.state === 'initialized') {
    // Классификация — по маркеру, прочитанному ПОСЛЕ пробы: параллельный первый
    // запуск мог создать администратора и записать маркер между первым чтением
    // и пробой, и тогда снимок «маркера нет» дал бы ложный отказ «not owned»
    // (замечание реверификации 21f4bac7).
    const ownership = readOwnership(dataDir);
    refuseForeignMarker(dataDir, ownership);
    if (ownership.state !== 'own') {
      const reason =
        ownership.state === 'invalid'
          ? `the ownership marker is invalid: ${ownership.reason}`
          : 'the ownership marker is missing';
      throw new BootstrapError(
        `The ETN data directory ${dataDir} is initialized, but it is not owned by etn-mcp ` +
          `(${reason}). Set ETN_API_KEY to attach to this server; etn-mcp does not modify a ` +
          'directory it does not own.',
      );
    }
    const existing = readMcpKey(dataDir);
    if (existing !== null) {
      return { dataDir, apiKey: existing, source: 'file' };
    }
    return { dataDir, apiKey: reissueKey(dataDir, log), source: 'reissued' };
  }

  // Каталог не инициализирован: маркер — до БД, затем администратор и ключ.
  return initializeDataDir(dataDir, version, log);
}
