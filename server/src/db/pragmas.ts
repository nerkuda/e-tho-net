/**
 * Единый профиль PRAGMA соединения сети (тех.проект e29c0f00, этап 1;
 * ADR ff2ee606 «Профиль прагм соединения SQLite задан явно», требование
 * bc312576 «Соединение выборок открывается с единым профилем прагм SQLite»).
 *
 * `better-sqlite3` синхронный, соединение сети живёт долго; дефолтные прагмы
 * оставляют temp-объекты на диске и дают маленький кэш, из-за чего BFS и
 * анти-джойны слоёв упираются в I/O (исследование 603a8bcb). Профиль задаётся
 * в ОДНОМ месте — здесь — и применяется ко всем соединениям сети: и к
 * главному потоку, и (после этапа 2) к reader-воркерам. Настраивать прагмы
 * ad hoc в отдельных запросах ADR запрещает.
 *
 * Значения зафиксированы ADR:
 *   * `cache_size = -65536` — ~64 МиБ страничного кэша;
 *   * `mmap_size = 268435456` — 256 МиБ mmap (на `:memory:` — no-op);
 *   * `temp_store = MEMORY` — temp-объекты (`layer_chain`, `*_v`) в памяти;
 *   * `synchronous = NORMAL` — допустимо при WAL (запись остаётся в главном
 *     потоке);
 *   * `busy_timeout` — конечный, чтобы не «залипать» на блокировке.
 *
 * Режим `journal_mode = WAL` и `foreign_keys = ON` задаются отдельно при
 * открытии (см. `openNetworkDb`): WAL нельзя включать внутри транзакции, и он
 * не является частью «профиля производительности».
 */

import type Database from 'better-sqlite3';

/** Значения профиля соединения сети (ADR ff2ee606). */
export const CONNECTION_PRAGMAS = {
  /** ~64 МиБ страничного кэша (отрицательное значение — килобайты). */
  cache_size: -65536,
  /** 256 МиБ отображаемой памяти. */
  mmap_size: 268435456,
  /** temp-таблицы и temp-индексы держатся в памяти. */
  temp_store: 'MEMORY',
  /** Безопасно при WAL. */
  synchronous: 'NORMAL',
  /** Конечный таймаут ожидания блокировки, мс. */
  busy_timeout: 5000,
} as const;

/**
 * Применить единый профиль прагм к соединению сети. Вызывается сразу после
 * открытия (и включения WAL/foreign_keys) — в единственной точке жизненного
 * цикла соединения, чтобы профиль был одинаков у всех потребителей.
 */
export function applyConnectionPragmas(db: Database.Database): void {
  db.pragma(`cache_size = ${CONNECTION_PRAGMAS.cache_size}`);
  db.pragma(`mmap_size = ${CONNECTION_PRAGMAS.mmap_size}`);
  db.pragma(`temp_store = ${CONNECTION_PRAGMAS.temp_store}`);
  db.pragma(`synchronous = ${CONNECTION_PRAGMAS.synchronous}`);
  db.pragma(`busy_timeout = ${CONNECTION_PRAGMAS.busy_timeout}`);
}
