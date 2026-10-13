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
 *     ba987ab2); воркер возвращает плоский результат записи, из которого фасад
 *     соберёт события и журнал — разделение WriteFx (ADR ca3a9218) делается при
 *     переносе путей записи (задача c8920d04), в этой задаче — инфраструктура;
 *   * не читает тяжёлые выборки: пул записи не подменяет reader-пул.
 *
 * **Соединение и контекст.** Соединение кэшируется на воркер и переоткрывается
 * при смене `dbPath` или `schemaVersion` (в главном потоке прошла миграция —
 * следующая задача должна видеть новую схему, сценарий 75627b29). Контекст слоя
 * переустанавливается на каждой задаче (`useLayer`), поэтому запись видит
 * ровно ту видимость слоя, которая пришла с задачей (сценарий 83bf13f1).
 *
 * **Операции (этап 1).** Пока единственная операция — батч-запись мыслей
 * `write.thoughts`: она исполняет доменный {@link writeThoughts} целиком
 * (валидация конверта, три фазы, ОДНА транзакция) и возвращает
 * `ThoughtWriteResult`. Остальные пути `runWrite` переезжают сюда поэтапно
 * (ADR «Этапность»): непереведённые op исполняются синхронно в главном потоке.
 */

import { parentPort } from 'node:worker_threads';

import type Database from 'better-sqlite3';
import DatabaseConstructor from 'better-sqlite3';

import { EtnError, type EtnErrorCode } from '@etn/shared';

import type { WriteTask, WriteTaskContext, WriteTaskResponse } from '../contracts.js';
import { writeThoughts } from '../domain/thought-write-service.js';
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
 * Транзакцию открывает сам домен (`writeThoughts` → `ndb.transaction`): на
 * границе потока нет места замыканию `fn` из `runWrite`, а частичная запись
 * батча недопустима (Сценарий S3: рестарт посреди батча оставляет БД
 * консистентной — откат делает SQLite, включая случай падения воркера).
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
      return {
        ok: true,
        result: writeThoughts(ndb, task.payload.input, task.payload.actorUserId),
      };
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
