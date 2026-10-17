/**
 * Write-воркер пула записи (ADR ca3a9218, тех.проект 0df7ccd6, задача 57068081).
 *
 * Точка входа `worker_threads`: у воркера — СВОЁ writer-соединение с `data.db`
 * сети, открытое тем же профилем прагм ({@link applyConnectionPragmas}) и тем же
 * набором SQL-функций ({@link registerQueryFunctions}), что и главное соединение,
 * и своим контекстом слоя ({@link NetworkDb}). Воркер не знает о состоянии
 * сессии: контекст (файл БД, сеть, слой, версия схемы) приходит в каждой задаче
 * {@link WriteTask}.
 *
 * **Что воркер НЕ делает.**
 *
 *   * не применяет миграции и не открывает сеть через `openNetworkDb` — это
 *     запись служебных данных и зона главного потока (требование cfba5ddf,
 *     сторож `guard-write-pool.test.ts`);
 *   * не публикует real-time события и не пишет аудит: событие уходит строго
 *     ПОСЛЕ коммита и только на главном потоке (ADR 162d8e7a, требование
 *     ba987ab2); воркер собирает события внутри транзакции и отдаёт их плоским
 *     списком вместе с результатом — фан-аут и `audit_log` делает фасад главного
 *     потока (ADR ca3a9218, `domain/heavy-write.ts`). Журнал активности
 *     (`data.db` сети) воркер пишет сам, после коммита: это запись в ту же сеть,
 *     ради которой он и поднят;
 *   * не читает тяжёлые выборки: пул записи не подменяет reader-пул.
 *
 * **Соединение и контекст.** Соединение кэшируется на воркер и переоткрывается
 * при смене `dbPath` или `schemaVersion` (в главном потоке прошла миграция —
 * следующая задача должна видеть новую схему, сценарий 75627b29). Контекст слоя
 * переустанавливается на каждой задаче (`useLayer`), поэтому запись видит
 * ровно ту видимость слоя, которая пришла с задачей (сценарий 83bf13f1).
 *
 * **Операции.** Переведены две: батч-запись мыслей `write.thoughts`
 * (`composeThoughtsWrite` — валидация конверта, три фазы, ОДНА транзакция;
 * возвращает `{ result: ThoughtWriteResult, events }`) и единичное создание
 * мысли REST-путём `POST /thoughts` — `write.thought` (`composeThoughtCreate`,
 * задача c744e05c). Остальные пути `runWrite`
 * переезжают сюда поэтапно (ADR «Этапность»): непереведённые op исполняются
 * синхронно в главном потоке.
 */

import { parentPort } from 'node:worker_threads';

import type Database from 'better-sqlite3';
import DatabaseConstructor from 'better-sqlite3';

import { EtnError, type EtnErrorCode } from '@etn/shared';

import type { WriteTask, WriteTaskContext, WriteTaskResponse } from '../contracts.js';
import {
  composeThoughtCreate,
  composeThoughtsWrite,
  type ThoughtCreateOutcome,
  type ThoughtsWriteOutcome,
} from '../domain/write-ops.js';
import { runWriteCore } from '../domain/write-wrapper.js';
import { NetworkDb, registerQueryFunctions } from './network-db.js';
import { applyConnectionPragmas } from './pragmas.js';

/** Кэшированное writer-соединение воркера вместе с контекстом, под который оно открыто. */
interface CachedConnection {
  ndb: NetworkDb;
  dbPath: string;
  schemaVersion: number;
}

let cached: CachedConnection | null = null;

/**
 * Открыть ПИШУЩЕЕ соединение с профилем прагм и контекстом слоя.
 *
 * `openNetworkDb` здесь НЕ используется намеренно: он применяет миграции и
 * чистит `object_locks` — это зона главного потока, а мутации схемы из воркера
 * запрещены ADR ca3a9218. Точка соединения, профиль прагм и общие SQL-функции
 * при этом переиспользуются: `NetworkDb` (тот же конструктор с
 * `setupLayerContext`), {@link applyConnectionPragmas} и
 * {@link registerQueryFunctions} (последние нужны записи так же, как чтениям:
 * `unicode_lower` в comment-скопе keyword-поиска гейта дубликатов,
 * `type_name_key` при разрешении типа по имени, `gen_uuid` — на нём держатся
 * `DEFAULT (gen_uuid())` схемы для id строк `thought_synonyms`/`comment_targets`,
 * без него воркер падал «unknown function: gen_uuid()»).
 *
 * `journal_mode` воркер не переключает: режим WAL задан главным потоком при
 * открытии сети — WAL нельзя включать внутри транзакции, и он не является
 * частью профиля прагм (см. `db/pragmas.ts`).
 */
function openConnection(context: WriteTaskContext): NetworkDb {
  const db: Database.Database = new DatabaseConstructor(context.dbPath);
  db.pragma('foreign_keys = ON');
  applyConnectionPragmas(db);
  registerQueryFunctions(db);
  return new NetworkDb(db, context.networkId, context.dbPath, context.layerId);
}

/** Получить соединение под контекст задачи, переоткрывая его при смене схемы. */
function connectionFor(context: WriteTaskContext): NetworkDb {
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
  // задаче, поэтому запись идёт с видимостью своего слоя.
  cached.ndb.useLayer(context.layerId);
  return cached.ndb;
}

/** Провести ошибку в плоский вид, переживающий границу потока. */
function toFailure(err: unknown): WriteTaskResponse {
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

/**
 * Исполнить задачу на соединении воркера.
 *
 * Транзакцию и журнал даёт ядро обёртки домена (`runWriteCore`): на границе
 * потока нет места замыканию `fn` из `runWrite`, поэтому op назван строкой и
 * собирается в `domain/write-ops.ts`, а частичная запись батча недопустима
 * (Сценарий S3: рестарт посреди батча оставляет БД консистентной — откат делает
 * SQLite, включая случай падения воркера).
 *
 * События воркер НЕ публикует и аудит НЕ пишет: он возвращает плоский список
 * событий, собранный внутри транзакции, а фан-аут и `audit_log` делает главный
 * поток по факту ответа (ADR 162d8e7a, ADR ca3a9218, требование ba987ab2).
 */
function execute(task: WriteTask): WriteTaskResponse {
  const ndb = connectionFor(task.context);
  switch (task.op) {
    case 'write.thoughts': {
      // Кросс-сетевой резолв в воркере не поддержан (ADR ca3a9218): такие задачи
      // обязан отсеять вызывающий фасад (`runWriteTask({ poolable: false })`) —
      // здесь это защита от тихой поломки, а не штатный путь.
      if (task.context.crossNetworkAccess !== undefined) {
        throw new EtnError(
          'INTERNAL',
          'write.thoughts с кросс-сетевым контекстом исполняется в главном потоке',
        );
      }
      // Ядро обёртки исполняет транзакцию и пишет журнал активности в этом же
      // соединении; события оно возвращает в исходе — отдаём их плоским списком,
      // их публикует главный поток после коммита.
      const outcome = runWriteCore(
        ndb,
        {
          networkId: task.context.networkId,
          userId: task.payload.actorUserId,
          layerId: task.context.layerId,
        },
        () => composeThoughtsWrite(ndb, task.payload),
      );
      const result: ThoughtsWriteOutcome = { result: outcome.result, events: outcome.events ?? [] };
      return { ok: true, result };
    }
    case 'write.thought': {
      // Единичное создание мысли REST-путём `POST /thoughts` (задача c744e05c):
      // та же обёртка «транзакция → журнал», композиция — композиция роута.
      const outcome = runWriteCore(
        ndb,
        {
          networkId: task.context.networkId,
          userId: task.payload.actorUserId,
          layerId: task.context.layerId,
        },
        () => composeThoughtCreate(ndb, task.payload),
      );
      const response: ThoughtCreateOutcome = {
        result: outcome.result,
        events: outcome.events ?? [],
      };
      return { ok: true, result: response };
    }
  }
  // Новый op обязан появиться и в ветке выше, и в контракте: сюда попадаем
  // только при рассогласовании (воркер старой сборки на новом контракте).
  const unsupported: { op?: string } = task;
  return {
    ok: false,
    error: { code: 'INTERNAL', message: `unknown write op: ${String(unsupported.op)}` },
  };
}

if (parentPort === null) {
  throw new Error('write-worker must be started as a worker_threads Worker');
}

parentPort.on('message', (task: WriteTask) => {
  let response: WriteTaskResponse;
  try {
    response = execute(task);
  } catch (err) {
    response = toFailure(err);
  }
  parentPort?.postMessage(response);
});
