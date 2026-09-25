/**
 * Reader-воркер пула тяжёлых чтений (ADR bec191e6, тех.проект e29c0f00 этап 2,
 * требование 8e2fda79).
 *
 * Точка входа `worker_threads`: у каждого воркера — СВОЁ read-only соединение с
 * `data.db`, открытое с единым профилем прагм ({@link applyConnectionPragmas})
 * и своим контекстом слоя ({@link NetworkDb}). Воркер ничего не знает о
 * состоянии сессии: контекст (файл БД, сеть, слой, версия схемы) приходит в
 * каждой задаче {@link ReaderTask}.
 *
 * **Только чтение.** Воркер не применяет миграции, не чистит `object_locks` и
 * вообще не пишет в `main`: соединение открывается `readonly: true`, а состав
 * операций ограничен выборками (движок отбора, поиск, обход подграфа).
 * Единственный писатель сети — главный поток (ADR 162d8e7a); второй писатель
 * запрещён ADR bec191e6. Сторож `guard-reader-pool.test.ts` не даёт появиться
 * здесь записывающему SQL.
 *
 * Инвалидация состояния между задачами (запрет ADR «изменяемое состояние без
 * явной инвалидации»): контекст слоя переустанавливается на соединении каждой
 * задачей (`NetworkDb.useLayer` → `setupLayerContext`), а смена `schemaVersion`
 * переоткрывает соединение.
 */

import { parentPort } from 'node:worker_threads';

import type Database from 'better-sqlite3';
import DatabaseConstructor from 'better-sqlite3';

import { EtnError, type EtnErrorCode } from '@etn/shared';

import type {
  ReaderTask,
  ReaderTaskContext,
  ReaderTaskResponse,
  ReaderThoughtsQueryResult,
  ReaderThoughtsQueryIdsResult,
} from '../contracts.js';
import { queryThoughts, queryThoughtIds } from '../domain/query-service.js';
import { search } from '../domain/search-service.js';
import { subgraph } from '../domain/graph-traversal.js';
import { NetworkDb } from './network-db.js';
import { applyConnectionPragmas } from './pragmas.js';

/** Кэшированное соединение воркера вместе с контекстом, под который оно открыто. */
interface CachedConnection {
  ndb: NetworkDb;
  dbPath: string;
  schemaVersion: number;
}

let cached: CachedConnection | null = null;

/**
 * Открыть read-only соединение с профилем прагм и контекстом слоя.
 *
 * `openNetworkDb` здесь НЕ используется намеренно: он применяет миграции и
 * чистит `object_locks` — а это запись, запрещённая воркеру. Точка соединения
 * и профиль прагм при этом переиспользуются: `NetworkDb` (тот же конструктор с
 * `setupLayerContext`) и {@link applyConnectionPragmas}.
 */
function openConnection(context: ReaderTaskContext): NetworkDb {
  const db: Database.Database = new DatabaseConstructor(context.dbPath, { readonly: true });
  db.pragma('foreign_keys = ON');
  applyConnectionPragmas(db);
  return new NetworkDb(db, context.networkId, context.dbPath, context.layerId);
}

/** Получить соединение под контекст задачи, переоткрывая его при смене схемы. */
function connectionFor(context: ReaderTaskContext): NetworkDb {
  if (
    cached === null ||
    cached.dbPath !== context.dbPath ||
    cached.schemaVersion !== context.schemaVersion
  ) {
    cached?.ndb.close();
    cached = {
      ndb: openConnection(context),
      dbPath: context.dbPath,
      schemaVersion: context.schemaVersion,
    };
  }
  // Явная инвалидация контекста слоя: цепочка предков перечитывается на каждой
  // задаче, поэтому смена/перестройка слоёв видна чтениям воркера сразу.
  cached.ndb.useLayer(context.layerId);
  return cached.ndb;
}

/** Провести ошибку в плоский вид, переживающий границу потока. */
function toFailure(err: unknown): ReaderTaskResponse {
  if (err instanceof EtnError) {
    return {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
  }
  const code: EtnErrorCode = 'INTERNAL';
  return { ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } };
}

/** Исполнить задачу на соединении воркера. Только чтение. */
function execute(task: ReaderTask): ReaderTaskResponse {
  const ndb = connectionFor(task.context);
  switch (task.op) {
    case 'thoughts.query': {
      const result = queryThoughts(ndb, task.payload.userId, task.payload.request, task.payload.options);
      const flat: ReaderThoughtsQueryResult = {
        items: result.items,
        total: result.total,
        directions: result.directions,
        depths: result.depths === null ? null : [...result.depths].map(([id, depth]) => ({ id, depth })),
        truncated: result.truncated,
        reason: result.reason,
      };
      return { ok: true, result: flat };
    }
    case 'thoughts.queryIds': {
      const result = queryThoughtIds(ndb, task.payload.userId, task.payload.request, task.payload.options);
      const flat: ReaderThoughtsQueryIdsResult = { ids: result.ids, total: result.total };
      return { ok: true, result: flat };
    }
    case 'search.query':
      return {
        ok: true,
        result: search(ndb, task.payload.request, task.payload.showInactiveDefault),
      };
    case 'graph.subgraph':
      return {
        ok: true,
        result: subgraph(ndb, task.payload.seedIds, task.payload.radius, task.payload.bounds),
      };
    default: {
      // Исчерпывающий разбор: новый op обязан появиться выше и в контракте.
      const never: never = task;
      return { ok: false, error: { code: 'INTERNAL', message: `unknown reader op: ${String(never)}` } };
    }
  }
}

if (parentPort === null) {
  throw new Error('reader-worker must be started as a worker_threads Worker');
}

parentPort.on('message', (task: ReaderTask) => {
  let response: ReaderTaskResponse;
  try {
    response = execute(task);
  } catch (err) {
    response = toFailure(err);
  }
  parentPort?.postMessage(response);
});
