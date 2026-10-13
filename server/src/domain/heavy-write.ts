/**
 * Фасад записи сети: «через write-пул или синхронно» (задача c8920d04,
 * ADR ca3a9218, тех.проект 0df7ccd6). Зеркало `domain/heavy-read.ts` для
 * стороны записи.
 *
 * Здесь проходит ГРАНИЦА «пул / главный поток» для записи. В пул уходят операции,
 * переведённые на плоские задачи ({@link WriteTask}) и не требующие того, что
 * воркеру запрещено (миграции, кросс-сетевой резолв). В главном потоке остаётся:
 *
 *   * всё, что воркер пока не умеет: непереведённые op идут как раньше —
 *     синхронным `runWrite` в своих фасадах (этапность ADR);
 *   * сеть в памяти (`:memory:` нельзя открыть вторым соединением) и
 *     выключенный пул (`size: 0`) — та же задача исполняется синхронно тем же
 *     кодом, результат обязан совпадать (требование 3d9d017f);
 *   * ПУБЛИКАЦИЯ событий и АУДИТ — всегда: событие уходит строго после коммита
 *     и только из главного потока (ADR 162d8e7a, ADR ca3a9218), чем бы ни была
 *     исполнена транзакция.
 *
 * Порядок «коммит → событие» держится не дисциплиной вызывающего, а тем, что
 * список событий собирается внутри транзакции ({@link composeThoughtsWrite}) и
 * появляется у фасада только вместе с успешным исходом. Порядок событий НА СЕТЬ —
 * sticky-очередью пула: задачи одной сети исполняет один воркер по FIFO, а ответы
 * приходят в порядке задач, поэтому фан-аут идёт в порядке коммитов сети.
 */

import type { McpThoughtWriteParams, RealtimeEventMap, RealtimeEventType } from '@etn/shared';

import type { WriteTask, WriteTaskContext, WriteThoughtsPayload } from '../contracts.js';
import type { NetworkDb } from '../db/network-db.js';
import { runWriteTask, writeContextFor } from '../db/write-pool.js';
import type { CrossNetworkAccessContext } from './cross-network-ref-service.js';
import type { ThoughtWriteResult } from './thought-write-service.js';
import { composeThoughtsWrite, thoughtsBatchNeedsMainThread } from './write-ops.js';
import type { ThoughtsWriteOutcome } from './write-ops.js';
import {
  runWriteCore,
  type WriteFx,
  type WriteJournalContext,
} from './write-wrapper.js';

/**
 * Контекст задачи из соединения главного потока. Для пула его строит
 * `writeContextFor` (с версией схемы); сеть в памяти в пул не уходит, но задача
 * всё равно описана контекстом — по нему `runWriteTask` узнаёт `:memory:` и
 * выбирает синхронный путь.
 */
function taskContext(ndb: NetworkDb): WriteTaskContext {
  return (
    writeContextFor(ndb) ?? {
      dbPath: ndb.dbPath,
      networkId: ndb.networkId,
      layerId: ndb.layerId,
      schemaVersion: 0,
    }
  );
}

/** Опции фасада батч-записи. */
export interface ThoughtsWriteOptions {
  /**
   * Кросс-сетевой контекст (задача 7849008a): нужен только синхронному пути —
   * в воркер он не передаётся (не сериализуем и запрещён там).
   */
  crossNetworkAccess?: CrossNetworkAccessContext;
  /**
   * Можно ли задачу унести в пул. Дефолт — `true`; фасад сам отсеивает батчи с
   * кросс-сетевыми адресами ({@link thoughtsBatchNeedsMainThread}).
   */
  poolable?: boolean;
}

/**
 * Батч-запись мыслей: в write-пуле, если он настроен и задача допускает воркер;
 * иначе — тем же кодом синхронно в главном потоке. События публикуются здесь, по
 * факту коммита; строка аудита пишется фасадом транспорта по возвращённому
 * результату.
 */
export async function runThoughtsWrite(
  ndb: NetworkDb,
  fx: WriteFx,
  input: McpThoughtWriteParams,
  options: ThoughtsWriteOptions = {},
): Promise<ThoughtWriteResult> {
  const payload: WriteThoughtsPayload = { input, actorUserId: fx.userId };
  const ctx: WriteJournalContext = {
    networkId: fx.networkId,
    userId: fx.userId,
    layerId: fx.layerId,
  };
  const poolable = options.poolable ?? !thoughtsBatchNeedsMainThread(input);
  const task: WriteTask = { context: taskContext(ndb), op: 'write.thoughts', payload };
  const outcome = (await runWriteTask(task, {
    poolable,
    // Деградация: пул выключен, сеть в памяти или задача непереводима — та же
    // запись исполняется синхронно, аудита в исходе нет (его пишет фасад).
    sync: () =>
      runWriteCore(ndb, ctx, () => composeThoughtsWrite(ndb, payload, options.crossNetworkAccess)),
  })) as ThoughtsWriteOutcome;

  for (const ev of outcome.events ?? []) {
    // `ev` — объединение пар (type, data); в цикле корреляция пары теряется.
    // Приведение безопасно: транспорт получает ровно ту пару, которую вернула
    // запись (та же логика, что в `runWrite`).
    fx.emit(ev.type, ev.data as RealtimeEventMap[RealtimeEventType], ev.options);
  }
  return outcome.result;
}
