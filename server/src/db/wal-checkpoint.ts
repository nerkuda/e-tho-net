/**
 * Фоновый чекпойнт WAL сетей и чекпойнт при остановке сервера (ошибка
 * dac92886 «WAL-файл сети не чекпойнтится и растёт», боевой сервер: 119 МБ).
 *
 * **Что измерено** (микро-эксперимент с профилем прагм сети, ADR ff2ee606):
 *   * `wal_autocheckpoint` не задан явно → дефолт SQLite `1000` страниц
 *     (≈4 МиБ) и он РАБОТАЕТ: без читателей `-wal` стабилизируется на ~3.98 МиБ,
 *     файл переиспользуется (PASSIVE-чекпойнт не усекает его — «высокая вода»
 *     остаётся на диске до `TRUNCATE` или до закрытия последнего соединения);
 *   * простаивающее второе соединение (как reader-воркер в пуле) росту не
 *     мешает;
 *   * а вот читатель, ДЕРЖАЩИЙ снапшот (открытая читательская транзакция),
 *     останавливает продвижение чекпойнта: журнал растёт линейно (≈2 МиБ на
 *     4000 записей), PASSIVE переносит только кадры до снапшота, а
 *     `wal_checkpoint(TRUNCATE)` отвечает `busy = 1`. После снятия снапшота
 *     `TRUNCATE` усекает `-wal` до нуля.
 *
 * Отсюда решение: периодический (по умолчанию раз в минуту) чекпойнт открытых
 * сетей в промежутках между запросами + чекпойнт всех открытых сетей и
 * системной БД при остановке сервера. Прежний код чекпойнтил WAL только при
 * удалении сети (`network-service`), а выход процесса шёл через `process.exit`,
 * поэтому чекпойнт «при закрытии последнего соединения» SQLite не успевал
 * выполнить.
 *
 * **Производительность и безопасность.** better-sqlite3 синхронный, обработчики
 * запросов — тоже: таймер физически не может сработать внутри запроса или
 * транзакции записи, чекпойнт идёт только между запросами. Ожидание блокировки
 * на время вызова выключается (`busy_timeout = 0`): при занятости фоновая задача
 * получает `busy = 1` сразу, а не висит до 5 с, блокируя цикл событий; следующий
 * тик повторит попытку. Соединения разных слоёв одной сети держат ОДИН файл
 * `data.db` — он чекпойнтится один раз.
 */

import { performance } from 'node:perf_hooks';

import type { Logger } from '../logger.js';
import { closeAll, listOpenNetworkDbs, type NetworkDb } from './network-db.js';

/** Режим `PRAGMA wal_checkpoint(...)`. */
export type WalCheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE';

/** Результат `PRAGMA wal_checkpoint(...)` для одного файла БД. */
export interface WalCheckpointStats {
  /** Вызов не выполнялся: соединение закрыто или БД не в режиме WAL. */
  skipped: boolean;
  /** `true` — чекпойнт не смог завершиться (кадры удерживает другой читатель). */
  busy: boolean;
  /** Кадров в журнале на момент вызова (`-1` — сведения недоступны). */
  log: number;
  /** Перенесено кадров в основной файл. */
  checkpointed: number;
}

/** Минимальный источник `pragma` — соединение сети ({@link NetworkDb}) или системной БД. */
export interface WalCheckpointSource {
  pragma(pragma: string): unknown;
}

const SKIPPED: WalCheckpointStats = { skipped: true, busy: false, log: 0, checkpointed: 0 };

/** Первое значение прагмы из ответа `better-sqlite3` (`[{ key: value }]`). */
function firstPragmaRow(result: unknown): Record<string, unknown> {
  if (Array.isArray(result)) {
    const row = result[0];
    return typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
  }
  return typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
}

/**
 * Выполнить `PRAGMA wal_checkpoint(mode)` на соединении и вернуть статистику.
 * Никогда не бросает: ошибка чекпойнта — не повод падать сервером (см. вызовы).
 */
export function walCheckpoint(
  db: WalCheckpointSource,
  mode: WalCheckpointMode = 'TRUNCATE',
): WalCheckpointStats {
  try {
    // Не-WAL базы (`:memory:` в тестах, `journal_mode=DELETE`) чекпойнтить нечего.
    const journal = String(firstPragmaRow(db.pragma('journal_mode'))['journal_mode'] ?? '');
    if (journal.toLowerCase() !== 'wal') return SKIPPED;
    const previous = firstPragmaRow(db.pragma('busy_timeout'))['timeout'];
    db.pragma('busy_timeout = 0');
    try {
      const row = firstPragmaRow(db.pragma(`wal_checkpoint(${mode})`));
      return {
        skipped: false,
        busy: row['busy'] === 1,
        log: typeof row['log'] === 'number' ? row['log'] : -1,
        checkpointed: typeof row['checkpointed'] === 'number' ? row['checkpointed'] : -1,
      };
    } finally {
      if (typeof previous === 'number') db.pragma(`busy_timeout = ${previous}`);
      else db.pragma('busy_timeout = 5000');
    }
  } catch {
    return SKIPPED;
  }
}

/** Итог одного прохода по открытым сетям. */
export interface WalCheckpointRun {
  /** Сколько ФАЙЛОВ `data.db` проверено (соединения разных слоёв схлопнуты). */
  files: number;
  /** Сколько файлов чекпойнтнуто (не `busy` и не пропущено). */
  checkpointed: number;
  /** Сколько чекпойнтов вернули `busy`. */
  busy: number;
  /** Сколько файлов пропущено (закрытое соединение / не WAL). */
  skipped: number;
  /** Длительность прохода, мс. */
  ms: number;
}

/** Открытые сети, по одному соединению на файл `data.db` (слои одного файла схлопнуты). */
function openDatabasesByFile(): NetworkDb[] {
  const byFile = new Map<string, NetworkDb>();
  for (const ndb of listOpenNetworkDbs()) {
    if (ndb.isClosed) continue;
    if (!byFile.has(ndb.dbPath)) byFile.set(ndb.dbPath, ndb);
  }
  return [...byFile.values()];
}

/**
 * Чекпойнт всех открытых сетей. Ошибки соединений проглатываются (чекпойнт —
 * обслуживающая операция), наружу выходит сводка; лог пишется, когда проход
 * реально что-то сделал (перенёс кадры или встретил занятость) — иначе `debug`.
 */
export function checkpointOpenNetworkDbs(
  opts: { logger?: Logger; mode?: WalCheckpointMode } = {},
): WalCheckpointRun {
  const started = performance.now();
  const mode = opts.mode ?? 'TRUNCATE';
  const databases = openDatabasesByFile();
  let checkpointed = 0;
  let busy = 0;
  let skipped = 0;
  for (const ndb of databases) {
    const stats = walCheckpoint(ndb, mode);
    if (stats.skipped) skipped += 1;
    else if (stats.busy) busy += 1;
    else checkpointed += 1;
  }
  const run: WalCheckpointRun = {
    files: databases.length,
    checkpointed,
    busy,
    skipped,
    ms: Math.round(performance.now() - started),
  };
  const shouldAdvance = busy > 0 || skipped < databases.length;
  const message = 'WAL checkpoint of network databases';
  if (shouldAdvance && databases.length > 0) opts.logger?.info({ mode, ...run }, message);
  else opts.logger?.debug({ mode, ...run }, message);
  return run;
}

/** Чекпойнт всех открытых сетей и их закрытие — шаг остановки сервера. */
export function checkpointAndCloseAllNetworkDbs(
  opts: { logger?: Logger; mode?: WalCheckpointMode } = {},
): WalCheckpointRun {
  const run = checkpointOpenNetworkDbs(opts);
  closeAll();
  return run;
}

/** Ручка запущенного фонового чекпойнта. */
export interface WalCheckpointScheduler {
  /** Остановить таймер (идемпотентно). */
  stop(): void;
  /** Выполнить проход немедленно (тот же путь, что у таймера). */
  runNow(): WalCheckpointRun;
}

/**
 * Запустить фоновый чекпойнт с интервалом {@link intervalMs}. Таймер `unref()`-нут
 * — он не удерживает процесс живым; ошибки не роняют сервер, а логируются.
 */
export function startWalCheckpointScheduler(opts: {
  intervalMs: number;
  logger?: Logger;
  mode?: WalCheckpointMode;
}): WalCheckpointScheduler {
  const run = (): WalCheckpointRun => {
    try {
      return checkpointOpenNetworkDbs({
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
        ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      });
    } catch (err) {
      opts.logger?.warn({ err }, 'WAL checkpoint failed');
      return { files: 0, checkpointed: 0, busy: 0, skipped: 0, ms: 0 };
    }
  };
  const timer = setInterval(run, opts.intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), runNow: run };
}
