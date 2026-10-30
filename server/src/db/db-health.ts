/**
 * Проверка БД для `GET /api/v1/health` (задача 0178253c, требование 0a79d9de,
 * операция `ae4ae06f`).
 *
 * Health — публичный и опрашивается установщиком каждые 2 с (задача
 * `bb063ac3`), поэтому проверка БД обязана быть:
 *
 *   * **лёгкой** — одно чтение `PRAGMA schema_version` воркером reader-пула
 *     (`db.ping`), без миграций, счётчиков и обходов таблиц;
 *   * **неблокирующей** — чтение идёт в reader-воркере (better-sqlite3
 *     синхронный, ADR bec191e6), главный поток сервера не замирает;
 *   * **кешированной** — результат живёт {@link DB_HEALTH_CACHE_TTL_MS}
 *     (спека: 1–2 с), так что частый опрос не бьёт БД на каждый запрос;
 *   * **честной** — недоступный/закрытый пул или сбой чтения дают
 *     `db: "error"` и 503, а не «оптимистичное» `ok`.
 *
 * Проверяется системная БД (`_system.db`): она открывается при старте сервера
 * и без неё сервер не работает; файл сети проверять нельзя — health не знает,
 * какую сеть имел в виду опрашивающий.
 *
 * Отказ от проверки при закрытом пуле намеренный (в отличие от фолбэка
 * `domain/heavy-read.ts`): health — это и есть сигнал «сервер не может
 * читать БД», синхронный обход в главном потоке скрыл бы поломку пула от
 * установщика.
 */

import { EtnError, type HealthDbStatus } from '@etn/shared';

import type { ReaderTask } from '../contracts.js';
import { getReaderPool } from './reader-pool.js';

/** Верхняя граница кеша результата из спеки: не дольше 2 с. */
export const DB_HEALTH_CACHE_MAX_MS = 2_000;

/**
 * TTL кеша результата проверки. Спека: 1–2 с; берём середину, чтобы установщик
 * с повтором каждые 2 с получал свежий результат, а ручной опрос не бил БД.
 */
export const DB_HEALTH_CACHE_TTL_MS = 1_500;

/** Выполнить одно лёгкое чтение БД; отказ означает `db: "error"`. */
export type DbProbe = (dbPath: string) => Promise<void>;

/**
 * Проверить БД через процессный reader-пул (`db.ping`).
 *
 * Пул не настроен или уже закрыт — отказ {@link EtnError}: health обязан
 * сообщить о неработающем чтении, а не подменять его синхронным обходом.
 */
export async function probeDbThroughReaderPool(dbPath: string): Promise<void> {
  const pool = getReaderPool();
  if (pool === null) {
    throw new EtnError('INTERNAL', 'reader pool is not configured or already closed');
  }
  const task: ReaderTask = { context: { dbPath }, op: 'db.ping', payload: {} };
  await pool.run(task);
}

/** Настройки кешированной проверки БД. */
export interface DbHealthCheckOptions {
  /** Абсолютный путь к проверяемому файлу SQLite (системная БД). */
  dbPath: string;
  /** TTL кеша, мс. Дефолт — {@link DB_HEALTH_CACHE_TTL_MS}. */
  ttlMs?: number;
  /** Часы (подменяются в тестах кеша). */
  now?: () => number;
  /** Исполнитель чтения; дефолт — {@link probeDbThroughReaderPool}. */
  probe?: DbProbe;
}

/**
 * Создать кешированную проверку БД для `/health`.
 *
 * Возвращённая функция отдаёт `ok`/`error`, запоминая результат на `ttlMs`:
 * повторные вызовы внутри окна не читают БД вовсе. Параллельные вызовы на
 * «холодном» кеше сливаются в одно чтение — установщик и клиент, опрашивающие
 * health одновременно, не плодят задачи пула. Ошибки чтения кешируются так же,
 * как успех: упавшую БД не долбят на каждый запрос.
 */
export function createDbHealthCheck(
  options: DbHealthCheckOptions,
): () => Promise<HealthDbStatus> {
  const probe: DbProbe = options.probe ?? probeDbThroughReaderPool;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DB_HEALTH_CACHE_TTL_MS;

  let cached: { at: number; status: HealthDbStatus } | null = null;
  let inflight: Promise<HealthDbStatus> | null = null;

  return async (): Promise<HealthDbStatus> => {
    if (cached !== null && now() - cached.at < ttlMs) {
      return cached.status;
    }
    if (inflight !== null) {
      return inflight;
    }
    inflight = probe(options.dbPath).then(
      (): HealthDbStatus => {
        cached = { at: now(), status: 'ok' };
        inflight = null;
        return 'ok';
      },
      (): HealthDbStatus => {
        cached = { at: now(), status: 'error' };
        inflight = null;
        return 'error';
      },
    );
    return inflight;
  };
}
