/**
 * Пул reader-соединений на `worker_threads` (ADR bec191e6, тех.проект e29c0f00
 * этап 2, требование 8e2fda79).
 *
 * `better-sqlite3` синхронный: тяжёлая выборка, исполненная в главном потоке,
 * замораживает сервер целиком (ошибка 6d78ccab). Пул уводит тяжёлые ЧТЕНИЯ в
 * воркеры со своими read-only соединениями — цикл событий главного потока
 * остаётся свободным. Запись остаётся строго в главном потоке (единственный
 * писатель, ADR 162d8e7a).
 *
 * Это библиотечный модуль (стандарт a2488f05): у него нет знаний о домене —
 * только транспорт «задача → воркер → ответ», контракт DTO лежит в
 * `contracts.ts` ({@link ReaderTask}/{@link ReaderTaskResponse}). Пул
 * параметризован размером и тайм-аутом, пригоден к встраиванию и юнит-тестам.
 *
 * Границы (что уходит в пул) задаёт вызывающий слой — `domain/heavy-read.ts`:
 * пул не решает, «тяжёлая» ли операция. Здесь — только надёжность: очередь,
 * тайм-аут, замена умершего воркера, orderly shutdown.
 *
 * Тесты с `worker_threads` обязаны детерминированно завершаться: {@link
 * ReaderPool.close} снимает очередь, `terminate()`-ит воркеры и дожидается их
 * `exit` — утечки потоков между тестами нет.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { EtnError } from '@etn/shared';

import type { ReaderTask, ReaderTaskResponse } from '../contracts.js';
import type { Logger } from '../logger.js';

/** Настройки пула. */
export interface ReaderPoolOptions {
  /** Число воркеров (≥1). Дефолт — {@link DEFAULT_READER_POOL_SIZE}. */
  size?: number;
  /** Тайм-аут одной задачи, мс (≥1). Дефолт — {@link DEFAULT_READER_TASK_TIMEOUT_MS}. */
  taskTimeoutMs?: number;
  /** Логгер для диагностики падений воркеров (опционален). */
  logger?: Logger;
}

/** Дефолтный размер пула, если не задан конфигом. */
export const DEFAULT_READER_POOL_SIZE = 2;
/** Дефолтный тайм-аут задачи, если не задан конфигом. */
export const DEFAULT_READER_TASK_TIMEOUT_MS = 30_000;

/** Сколько ждать `exit` воркера при `terminate()` прежде чем отцепиться. */
const TERMINATE_AWAIT_MS = 2_000;

/** Задача в очереди/на исполнении. */
interface Job {
  task: ReaderTask;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Слот воркера: сам поток и задача, которая на нём исполняется. */
interface Slot {
  worker: Worker;
  job: Job | null;
  dead: boolean;
}

/** Прорежённый тип сообщения воркера. */
type WorkerMessage = ReaderTaskResponse;

/** Открыть `Worker` на файл воркера, подбирая загрузчик под расширение модуля. */
function spawnWorker(): Worker {
  const selfPath = fileURLToPath(import.meta.url);
  const ext = path.extname(selfPath);
  // Под `tsx` (dev/тесты) исходник — `.ts`, и воркер-поток тоже должен уметь
  // грузить TypeScript; в собранном `dist` — обычный `.js` без загрузчика.
  const workerExt = ext === '.ts' ? '.ts' : '.js';
  const workerPath = path.join(path.dirname(selfPath), `reader-worker${workerExt}`);
  const execArgv = workerExt === '.ts' ? ['--import', 'tsx'] : [];
  return new Worker(workerPath, { execArgv });
}

/**
 * Пул reader-воркеров. Одна задача — один воркер за раз; превышение размера
 * пула ждёт в очереди. Пул самовосстанавливается: упавший/зависший воркер
 * отклоняет свою задачу и заменяется при следующей диспетчеризации.
 */
export class ReaderPool {
  readonly size: number;
  readonly taskTimeoutMs: number;

  private readonly logger?: Logger;
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private closed = false;

  constructor(options: ReaderPoolOptions = {}) {
    this.size = Math.max(1, Math.floor(options.size ?? DEFAULT_READER_POOL_SIZE));
    this.taskTimeoutMs = Math.max(1, Math.floor(options.taskTimeoutMs ?? DEFAULT_READER_TASK_TIMEOUT_MS));
    if (options.logger !== undefined) this.logger = options.logger;
  }

  /** Число задач, ждущих в очереди или исполняющихся сейчас. */
  get pending(): number {
    return this.queue.length + this.slots.filter((s) => s.job !== null).length;
  }

  /** Закрыт ли пул (после {@link close}). */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Выполнить задачу: свободный воркер берёт её сразу, иначе она встаёт в
   * очередь. Промис отклоняется по тайм-ауту, ошибке или падению воркера.
   */
  run(task: ReaderTask): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new EtnError('INTERNAL', 'reader pool is closed'));
    }
    return new Promise<unknown>((resolve, reject) => {
      const job: Job = {
        task,
        resolve,
        reject,
        timer: setTimeout(() => this.onTimeout(job), this.taskTimeoutMs),
      };
      job.timer.unref?.();
      this.queue.push(job);
      try {
        this.dispatch();
      } catch (err) {
        // Поток не поднялся (нет загрузчика/файла воркера): задача не должна
        // остаться в очереди — отклоняем и снимаем.
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        clearTimeout(job.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Снять очередь, `terminate`-ить воркеры и дождаться их завершения. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const drained = this.queue.splice(0, this.queue.length);
    for (const job of drained) {
      clearTimeout(job.timer);
      job.reject(new EtnError('INTERNAL', 'reader pool is closed'));
    }
    const exits: Promise<void>[] = [];
    for (const slot of this.slots.splice(0, this.slots.length)) {
      slot.dead = true;
      if (slot.job !== null) {
        clearTimeout(slot.job.timer);
        slot.job.reject(new EtnError('INTERNAL', 'reader pool is closed'));
        slot.job = null;
      }
      exits.push(this.terminate(slot.worker));
    }
    await Promise.all(exits);
  }

  /** Завершить воркер и дождаться `exit` (с потолком ожидания). */
  private terminate(worker: Worker): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => resolve();
      worker.once('exit', done);
      const guard = setTimeout(done, TERMINATE_AWAIT_MS);
      guard.unref?.();
      void worker.terminate().catch(() => {
        /* уже мёртв — `exit` придёт или потолок сработает */
      });
    });
  }

  /** Отдать задачу свободному воркеру; при нехватке — открыть новый до `size`. */
  private dispatch(): void {
    if (this.closed) return;
    while (this.queue.length > 0) {
      let slot = this.slots.find((s) => !s.dead && s.job === null);
      if (slot === undefined) {
        if (this.slots.filter((s) => !s.dead).length >= this.size) return;
        slot = this.createSlot();
      }
      const job = this.queue.shift();
      if (job === undefined) return;
      slot.job = job;
      slot.worker.postMessage(job.task);
    }
  }

  /** Открыть слот и повесить обработчики жизненного цикла воркера. */
  private createSlot(): Slot {
    const worker = spawnWorker();
    const slot: Slot = { worker, job: null, dead: false };
    worker.on('message', (message: WorkerMessage) => this.onMessage(slot, message));
    worker.on('error', (err: Error) => this.onWorkerFailure(slot, err));
    worker.on('exit', (code: number) => {
      if (!slot.dead) this.onWorkerFailure(slot, new Error(`reader worker exited with code ${code}`));
    });
    this.slots.push(slot);
    return slot;
  }

  /** Обработать ответ воркера. */
  private onMessage(slot: Slot, message: WorkerMessage): void {
    const job = slot.job;
    if (job === undefined || job === null) return;
    slot.job = null;
    clearTimeout(job.timer);
    if (message.ok) {
      job.resolve(message.result);
    } else {
      job.reject(new EtnError(message.error.code, message.error.message, message.error.details));
    }
    this.dispatch();
  }

  /** Отклонить задачу слота и убрать слот при падении/выходе воркера. */
  private onWorkerFailure(slot: Slot, err: Error): void {
    if (slot.dead) return;
    slot.dead = true;
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    const job = slot.job;
    slot.job = null;
    if (job !== null) {
      clearTimeout(job.timer);
      job.reject(err instanceof EtnError ? err : new EtnError('INTERNAL', `reader worker failed: ${err.message}`));
    }
    this.logger?.warn({ err }, 'reader worker failed');
    void this.terminate(slot.worker);
    this.dispatch();
  }

  /** Тайм-аут задачи: воркер завис — убить его, задачу отклонить. */
  private onTimeout(job: Job): void {
    const slot = this.slots.find((s) => s.job === job);
    job.reject(new EtnError('INTERNAL', `reader task timed out after ${this.taskTimeoutMs} ms`));
    if (slot !== undefined) {
      slot.job = null;
      slot.dead = true;
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      void this.terminate(slot.worker);
    } else {
      const qi = this.queue.indexOf(job);
      if (qi >= 0) this.queue.splice(qi, 1);
    }
    this.dispatch();
  }
}

// ---------------------------------------------------------------------------
// Процессный пул (единственный на процесс, как реестр соединений сети)
// ---------------------------------------------------------------------------

let processPool: ReaderPool | null = null;

/**
 * Настроить процессный пул reader-воркеров (вызывается при старте сервера).
 * Идемпотентно: повторный вызов с теми же настройками переиспользует пул.
 */
export function configureReaderPool(options: ReaderPoolOptions): ReaderPool {
  if (processPool !== null && !processPool.isClosed) {
    if (processPool.size === (options.size ?? DEFAULT_READER_POOL_SIZE)) {
      return processPool;
    }
    void processPool.close();
  }
  processPool = new ReaderPool(options);
  return processPool;
}

/** Процессный пул, если он настроен и открыт; иначе `null`. */
export function getReaderPool(): ReaderPool | null {
  return processPool !== null && !processPool.isClosed ? processPool : null;
}

/** Закрыть процессный пул (при остановке сервера). */
export async function closeReaderPool(): Promise<void> {
  if (processPool === null) return;
  const pool = processPool;
  processPool = null;
  await pool.close();
}
