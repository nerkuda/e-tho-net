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
 * список событий собирается внутри транзакции ({@link composeThoughtsWrite},
 * {@link composeThoughtCreate}) и появляется у фасада только вместе с успешным
 * исходом. Порядок событий НА СЕТЬ — sticky-очередью пула: задачи одной сети
 * исполняет один воркер по FIFO, а ответы приходят в порядке задач, поэтому
 * фан-аут идёт в порядке коммитов сети.
 *
 * **Точки входа фасада** (по операциям, переведённым на плоские задачи):
 * {@link runThoughtsWrite} — батч `etn.thoughts.write` (MCP),
 * {@link runThoughtCreate} — единичное создание мысли REST-путём `POST /thoughts`
 * (клиентский путь GUI, задача c744e05c),
 * {@link runThoughtsBatch} — батчевая операция `POST /thoughts/batch` и MCP
 * `etn.thoughts.bulk_update` (задача dba7fabc),
 * {@link runThoughtsCopy} — пакетное копирование `POST /thoughts/copy-batch`
 * (задача b9c70dd8). У копирования файлы вложений — эффект ПОСЛЕ коммита на
 * главном потоке: исполнитель транзакции планирует имена копий, фасад их пишет.
 */

import type {
  McpThoughtWriteParams,
  RealtimeEventMap,
  RealtimeEventType,
  Thought,
  ThoughtBatchOp,
  ThoughtBatchResult,
  ThoughtCopyInput,
  ThoughtCopyResult,
  ThoughtCreateInput,
} from '@etn/shared';

import type {
  WriteTask,
  WriteTaskContext,
  WriteThoughtBatchBulkArgs,
  WriteThoughtBatchFocusArgs,
  WriteThoughtBatchPayload,
  WriteThoughtCopyPayload,
  WriteThoughtPayload,
  WriteThoughtsPayload,
} from '../contracts.js';
import type { NetworkDb } from '../db/network-db.js';
import { runWriteTask, writeContextFor } from '../db/write-pool.js';
import { copyAttachmentFiles } from './attachment-service.js';
import type { CrossNetworkAccessContext } from './cross-network-ref-service.js';
import type { ThoughtWriteResult } from './thought-write-service.js';
import {
  composeThoughtBatch,
  composeThoughtCopyOutcome,
  composeThoughtCreate,
  composeThoughtsWrite,
  thoughtsBatchNeedsMainThread,
  type ThoughtBatchOutcome,
  type ThoughtCopyOutcome,
  type ThoughtCreateOutcome,
} from './write-ops.js';
import type { ThoughtsWriteOutcome } from './write-ops.js';
import {
  runWriteCore,
  type WriteFx,
  type WriteJournalContext,
} from './write-wrapper.js';
import { bumpNetworkDataVersion } from './view-result-cache.js';

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

  // Запись исполнена воркером (или синхронно) — данные сети сдвинулись.
  // В воркере `runWriteCore` двигает счётчик СВОЕГО потока, поэтому главный
  // поток обязан отметить изменение сам (задача 3f2b0958). На синхронном пути
  // `runWriteCore` уже отметил — повторный инкремент безвреден.
  bumpNetworkDataVersion(ndb.networkId);

  for (const ev of outcome.events ?? []) {
    // `ev` — объединение пар (type, data); в цикле корреляция пары теряется.
    // Приведение безопасно: транспорт получает ровно ту пару, которую вернула
    // запись (та же логика, что в `runWrite`).
    fx.emit(ev.type, ev.data as RealtimeEventMap[RealtimeEventType], ev.options);
  }
  return outcome.result;
}

/**
 * Единичное создание мысли REST-путём `POST /thoughts` (задача c744e05c): в
 * write-пуле, если он настроен; иначе — тем же кодом синхронно в главном
 * потоке. Композиция записи — {@link composeThoughtCreate}, дословно повторяющая
 * прежний роут (мысль + постоянный комментарий + рёбра link-дефолтов и
 * `create_link`, событие на каждую фактически затронутую сущность). События
 * публикуются здесь, по факту коммита; аудита у data-записей REST нет.
 *
 * Тело запроса (`ThoughtCreateInput`) сериализуемо, а кросс-сетевых адресов
 * значений свойств у этой операции не бывает — задача всегда допускает воркер
 * (`poolable` по умолчанию `true`); исключения — сеть в памяти и выключенный
 * пул, где срабатывает синхронная деградация {@link runWriteTask}.
 */
export async function runThoughtCreate(
  ndb: NetworkDb,
  fx: WriteFx,
  input: ThoughtCreateInput,
  options: { poolable?: boolean } = {},
): Promise<Thought> {
  const payload: WriteThoughtPayload = { input, actorUserId: fx.userId };
  const ctx: WriteJournalContext = {
    networkId: fx.networkId,
    userId: fx.userId,
    layerId: fx.layerId,
  };
  const task: WriteTask = { context: taskContext(ndb), op: 'write.thought', payload };
  const outcome = (await runWriteTask(task, {
    poolable: options.poolable ?? true,
    sync: () => runWriteCore(ndb, ctx, () => composeThoughtCreate(ndb, payload)),
  })) as ThoughtCreateOutcome;

  // См. `runThoughtsWrite`: коммит мог произойти в writer-воркере.
  bumpNetworkDataVersion(ndb.networkId);

  for (const ev of outcome.events ?? []) {
    fx.emit(ev.type, ev.data as RealtimeEventMap[RealtimeEventType], ev.options);
  }
  return outcome.result;
}

/** Нормализованный вход фасада батчевой операции {@link runThoughtsBatch}. */
export interface ThoughtsBatchInput {
  ids: string[];
  op: ThoughtBatchOp;
  /** Аргументы общей групповой операции (`op` ∈ `BULK_THOUGHT_OPS`). */
  bulk?: WriteThoughtBatchBulkArgs;
  /** Аргументы локальной операции связи с фокусом. */
  focus?: WriteThoughtBatchFocusArgs;
}

/**
 * Батчевая операция `POST /thoughts/batch` (задача b9c70dd8) и MCP
 * `etn.thoughts.bulk_update` (задача dba7fabc): в write-пуле, если
 * он настроен; иначе — тем же кодом синхронно в главном потоке (деградация
 * {@link runWriteTask}). Композиция записи — {@link composeThoughtBatch},
 * дословно повторяющая прежний роут (общие групповые операции + локальные
 * `delete`/`purge`/`link_to_focus`/`unlink_from_focus`). События публикуются
 * здесь, по факту коммита; строку аудита пишет фасад транспорта (у MCP —
 * `etn.thoughts.bulk_update`, у data-записей REST аудита нет).
 *
 * Кросс-сетевого резолва операция не делает, потому задача всегда допускает
 * воркер (`poolable` по умолчанию `true`); сеть в памяти и выключенный пул дают
 * синхронную деградацию.
 */
export async function runThoughtsBatch(
  ndb: NetworkDb,
  fx: WriteFx,
  input: ThoughtsBatchInput,
  options: { poolable?: boolean } = {},
): Promise<ThoughtBatchResult> {
  const payload: WriteThoughtBatchPayload = {
    actorUserId: fx.userId,
    ids: input.ids,
    op: input.op,
    ...(input.bulk !== undefined ? { bulk: input.bulk } : {}),
    ...(input.focus !== undefined ? { focus: input.focus } : {}),
  };
  const ctx: WriteJournalContext = {
    networkId: fx.networkId,
    userId: fx.userId,
    layerId: fx.layerId,
  };
  const task: WriteTask = { context: taskContext(ndb), op: 'write.thought.batch', payload };
  const outcome = (await runWriteTask(task, {
    poolable: options.poolable ?? true,
    sync: () => {
      const out = runWriteCore(ndb, ctx, () => composeThoughtBatch(ndb, payload));
      return { result: out.result, events: out.events ?? [] } satisfies ThoughtBatchOutcome;
    },
  })) as ThoughtBatchOutcome;

  // См. `runThoughtsWrite`: коммит мог произойти в writer-воркере.
  bumpNetworkDataVersion(ndb.networkId);

  for (const ev of outcome.events ?? []) {
    fx.emit(ev.type, ev.data as RealtimeEventMap[RealtimeEventType], ev.options);
  }
  return outcome.result;
}

/** Опции фасада пакетного копирования {@link runThoughtsCopy}. */
export interface ThoughtsCopyOptions {
  /**
   * Абсолютный каталог вложений СЕТИ-ИСТОЧНИКА. Задан — при копировании в другую
   * сеть файлы `kind='file'` получают уникальные физические копии в сети-получателе
   * (ошибка b83a7d89). `undefined` — внутрисетевое копирование (файл шарится).
   */
  sourceAttachmentsDir?: string;
  /** Приёмник нефатальных замечаний (исходный файл не найден, сбой копирования). */
  warn?: (message: string, details?: Record<string, unknown>) => void;
  /** Можно ли задачу унести в пул (по умолчанию `true`). */
  poolable?: boolean;
}

/**
 * Пакетное создание мыслей `POST /thoughts/copy-batch` (задача b9c70dd8): в
 * write-пуле, если он настроен; иначе — тем же кодом синхронно в главном потоке.
 * Композиция записи — {@link composeThoughtCopyOutcome}: доменный
 * {@link import('./thought-copy-service.js').copyThoughtsBatch} + события.
 *
 * Файлы вложений при межсетевом копировании физически переносятся ПОСЛЕ коммита
 * на главном потоке (как события и аудит): имена копий планирует исполнитель
 * транзакции, а запись файлов делает фасад — при откате транзакции осиротевших
 * файлов не остаётся (ошибка b83a7d89).
 *
 * Кросс-сетевой источник здесь — только КАТАЛОГ ВЛОЖЕНИЙ (чужая БД не
 * открывается), поэтому задача всегда допускает воркер; сеть в памяти и
 * выключенный пул дают синхронную деградацию.
 */
export async function runThoughtsCopy(
  ndb: NetworkDb,
  fx: WriteFx,
  input: ThoughtCopyInput,
  options: ThoughtsCopyOptions = {},
): Promise<ThoughtCopyResult> {
  const payload: WriteThoughtCopyPayload = {
    input,
    actorUserId: fx.userId,
    sourceAttachmentsDir: options.sourceAttachmentsDir ?? null,
  };
  const task: WriteTask = { context: taskContext(ndb), op: 'write.thought.copy', payload };
  const outcome = (await runWriteTask(task, {
    poolable: options.poolable ?? true,
    sync: () => composeThoughtCopyOutcome(ndb, payload),
  })) as ThoughtCopyOutcome;

  // См. `runThoughtsWrite`: коммит мог произойти в writer-воркере.
  bumpNetworkDataVersion(ndb.networkId);

  for (const ev of outcome.events ?? []) {
    fx.emit(ev.type, ev.data as RealtimeEventMap[RealtimeEventType], ev.options);
  }
  // Замечания исполнителя (пропавший исходный файл) и физическое копирование —
  // на главном потоке: наблюдаемость и файловый эффект остаются у фасада.
  for (const warning of outcome.warnings ?? []) {
    options.warn?.(warning.message, warning.details);
  }
  copyAttachmentFiles(outcome.files ?? [], options.warn);
  return outcome.result;
}
