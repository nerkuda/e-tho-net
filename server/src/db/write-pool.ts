/**
 * Пул записи на `worker_threads` со sticky-привязкой сети к воркеру
 * (ADR ca3a9218, тех.проект 0df7ccd6, задача 57068081).
 *
 * `better-sqlite3` синхронный: батч `etn.thoughts.write` из 10–50 элементов
 * держит цикл событий сервера 10–36 секунд (ошибка 646347ab) — «замерзают» все
 * клиенты всех сетей. Тяжёлые ЧТЕНИЯ увёл в reader-пул ADR bec191e6, но запись
 * оставил в главном потоке; этот пул уводит и её: главный поток только
 * диспетчеризует, публикует события и обслуживает админ-операции.
 *
 * **Маршрутизация.** Задачи одной сети исполняет один ЗАКРЕПЛЁННЫЙ воркер
 * (sticky по `networkId`), внутри сети — строго в порядке поступления: очередь
 * на воркер, следующая задача уходит воркеру только после ответа на предыдущую.
 * Сериализация записей сети обеспечивается очередью, а не SQLite-локами, —
 * `SQLITE_BUSY` между задачами одной сети исключён конструкцией. Записи РАЗНЫХ
 * сетей идут параллельно на разных воркерах пула.
 *
 * **Вытеснение.** Привязка занимает воркер до простоя: если пришла запись в
 * новую сеть, а все воркеры закреплены, диспетчер освобождает привязку,
 * простоявшую не меньше `idleEvictionMs` и не имеющую работы (LRU по времени
 * последней задачи). Привязка с непустой очередью не вытесняется никогда —
 * подтверждённые задачи не теряются. Если вытеснять нечего (все воркеры заняты
 * живыми сетями), задача ждёт в очереди допуска: исчерпание пула проявляется
 * ростом ожидания, а не блокировкой чужих потоков (сценарий c4835c68). Допуск
 * обслуживается на каждой постановке задачи и по таймеру на момент, когда
 * привязка станет вытесняемой; долгое ожидание в допуске не молчит — проход
 * пишется WARN (ошибка 79c64f3f: без этого задача новой сети при простаивающей
 * привязке не будилась ничем и висела вечно).
 *
 * **Отказ воркера и тайм-аут.** У задачи есть тайм-аут, отсчитываемый от начала
 * ИСПОЛНЕНИЯ (ожидание в очереди в него не входит — оно ограничено работой
 * впереди и видно в наблюдаемости). При тайм-ауте или падении воркера слот
 * завершается (`terminate`), незакоммиченная транзакция откатывается SQLite,
 * задача возвращается вызывающему ошибкой `INTERNAL`, а невыполненные задачи
 * этой сети возвращаются в очередь допуска с сохранением порядка; следующая
 * задача сети поднимает новый воркер (требование 5384f3ad).
 *
 * **Остановка сервера.** Сначала {@link drainWritePool} — дождаться слива
 * очередей (подтверждённые записи не теряем), затем {@link closeWritePool} —
 * закрыть воркеры и их writer-соединения. Только ПОСЛЕ этого чекпойнт WAL
 * (`db/wal-checkpoint.ts`): чекпойнт обязан оставаться последним шагом, иначе
 * соединения воркеров удержат журнал.
 *
 * **Деградация.** Пул не настроен, сеть в памяти (`:memory:` — её нельзя открыть
 * вторым соединением) или задача помечена `poolable: false` — исполнение
 * синхронное в главном потоке тем же кодом; результат обязан совпадать
 * (требование 3d9d017f).
 *
 * **Границы.** Это транспорт «задача → воркер → ответ»: пул не знает домена
 * (op назван строкой, данные — плоский DTO) и не публикует события — их
 * публикует главный поток после коммита (ADR 162d8e7a). Перенос путей записи на
 * пул — отдельная задача (c8920d04): сейчас записи идут прежним путём, а пул
 * покрыт тестами.
 *
 * Тесты с `worker_threads` обязаны детерминированно завершаться: {@link
 * WritePool.close} отклоняет очередь, `terminate()`-ит воркеры и дожидается их
 * `exit` — утечки потоков между тестами нет.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { EtnError } from '@etn/shared';

import type { WriteTask, WriteTaskContext, WriteTaskResponse } from '../contracts.js';
import type { Logger } from '../logger.js';
import type { NetworkDb } from './network-db.js';

/** Настройки пула. */
export interface WritePoolOptions {
  /** Число воркеров (≥1). Дефолт — {@link DEFAULT_WRITE_POOL_SIZE}; `0` — пул выключен. */
  size?: number;
  /** Тайм-аут одной задачи от начала исполнения, мс. Дефолт — {@link DEFAULT_WRITE_TASK_TIMEOUT_MS}. */
  taskTimeoutMs?: number;
  /** Простой привязки, после которого воркер можно освободить для новой сети, мс. */
  idleEvictionMs?: number;
  /** Порог глубины очереди, после которого проход пишется WARN. Дефолт — {@link DEFAULT_WRITE_QUEUE_WARN_DEPTH}. */
  queueWarnDepth?: number;
  /**
   * Порог ожидания задачи — в очереди воркера и в очереди допуска, — после
   * которого проход пишется WARN, мс.
   */
  queueWaitWarnMs?: number;
  /** Логгер для наблюдаемости очереди и падений воркеров (опционален). */
  logger?: Logger;
}

/** Дефолтный размер пула (ADR ca3a9218: «по умолчанию 2»). */
export const DEFAULT_WRITE_POOL_SIZE = 2;
/**
 * Дефолтный тайм-аут задачи записи.
 *
 * Больше читательского (30 с) осознанно: замер ошибки 646347ab — батч 10–50
 * элементов держал поток 10–36 с, то есть 30 с убили бы ровно тот сценарий,
 * ради которого пул и заводится. Двадцать минут сверху — потолок, за которым
 * задача считается зависшей.
 */
export const DEFAULT_WRITE_TASK_TIMEOUT_MS = 120_000;
/** Дефолтный порог простоя привязки до вытеснения (ADR ca3a9218, «не мгновенно»). */
export const DEFAULT_WRITE_IDLE_EVICTION_MS = 30_000;
/** Дефолтная глубина очереди, на которой проход пишется WARN (требование 28a47bcf). */
export const DEFAULT_WRITE_QUEUE_WARN_DEPTH = 8;
/** Дефолтное ожидание задачи в очереди, после которого проход пишется WARN, мс. */
export const DEFAULT_WRITE_QUEUE_WAIT_WARN_MS = 5_000;
/** Сколько ждать `exit` воркера при `terminate()` прежде чем отцепиться. */
const TERMINATE_AWAIT_MS = 2_000;
/** Шаг опроса при `drain`: очередь — не поток событий, точность в миллисекундах не нужна. */
const DRAIN_POLL_MS = 10;

/** Задача в очереди/на исполнении. */
interface Job {
  task: WriteTask;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Момент постановки в очередь — база для наблюдаемости ожидания. */
  enqueuedAtMs: number;
  /** Таймер тайм-аута; заводится при передаче задачи воркеру. */
  timer: NodeJS.Timeout | null;
  /** Момент передачи воркеру (null — задача ещё ждёт). */
  startedAtMs: number | null;
}

/** Закреплённый воркер сети: очередь задач, исполняемая строго по одной. */
interface Pin {
  networkId: string;
  worker: Worker;
  job: Job | null;
  queue: Job[];
  /** Время последней активности — база LRU-вытеснения. */
  lastUsedMs: number;
  dead: boolean;
}

/** Снимок состояния пула — наблюдаемость (требование 28a47bcf). */
export interface WritePoolStats {
  /** Размер пула (максимум живых воркеров). */
  size: number;
  /** Сколько воркеров живо сейчас. */
  workers: number;
  /** Сети, за которыми закреплены воркеры. */
  pinnedNetworks: string[];
  /** Сети, чей воркер завершается: новой привязки к их базам пока нет. */
  closingNetworks: string[];
  /** Сколько воркеров занято исполнением. */
  busyWorkers: number;
  /** Сколько задач ждёт в очередях закреплённых сетей. */
  queued: number;
  /** Сколько задач ждёт допуска (все воркеры заняты живыми сетями). */
  waitingAdmission: number;
  /** Исполнено успешно. */
  completed: number;
  /** Завершилось ошибкой домена. */
  failed: number;
  /** Завершилось тайм-аутом. */
  timedOut: number;
  /** Сколько привязок вытеснено по простою. */
  evicted: number;
  /** Сколько воркеров поднято за жизнь пула. */
  spawns: number;
  /** Максимальная наблюдавшаяся глубина очереди. */
  maxQueueDepth: number;
  /** Последнее наблюдавшееся ожидание задачи в очереди, мс. */
  lastWaitMs: number;
  /** Последнее наблюдавшееся время исполнения задачи, мс. */
  lastExecMs: number;
}

/** Итог слива очередей (шаг мягкой остановки). */
export interface WritePoolDrainResult {
  /** `true` — очереди и исполняемые задачи опустели в отведённое время. */
  drained: boolean;
  /** Сколько задач осталось ждать (0 при `drained`). */
  queued: number;
  /** Сколько задач осталось исполняться (0 при `drained`). */
  active: number;
}

/** Открыть `Worker` на файл воркера, подбирая загрузчик под расширение модуля. */
function spawnWorker(): Worker {
  const selfPath = fileURLToPath(import.meta.url);
  const ext = path.extname(selfPath);
  // Под `tsx` (dev/тесты) исходник — `.ts`, и воркер-поток тоже должен уметь
  // грузить TypeScript; в собранном `dist` — обычный `.js` без загрузчика.
  const workerExt = ext === '.ts' ? '.ts' : '.js';
  const workerPath = path.join(path.dirname(selfPath), `write-worker${workerExt}`);
  const execArgv = workerExt === '.ts' ? ['--import', 'tsx'] : [];
  return new Worker(workerPath, { execArgv });
}

/**
 * Пул записи. Задача уходит воркеру, закреплённому за её сетью; задачи одной
 * сети исполняются по одной в порядке поступления, задачи разных сетей — на
 * разных воркерах параллельно.
 */
export class WritePool {
  readonly size: number;
  readonly taskTimeoutMs: number;
  readonly idleEvictionMs: number;

  private readonly queueWarnDepth: number;
  private readonly queueWaitWarnMs: number;
  private readonly logger?: Logger;
  private readonly pins: Pin[] = [];
  /** Задачи сетей, которым не досталось воркера (все закреплены живыми сетями). */
  private readonly admission: Job[] = [];
  /**
   * Таймер повторной попытки допуска: привязка станет вытесняемой только по
   * простою, а задачи в допуске не должны ждать «события» — иначе новая сеть
   * повиснет до следующего завершения чужой задачи.
   */
  private admissionTimer: NodeJS.Timeout | null = null;
  /**
   * Таймер наблюдаемости очереди допуска: пока задача не получила воркер, её
   * ожидание обязано быть видно в логах (WARN), а не только в `stats()` — иначе
   * зависание в допуске (ошибка 79c64f3f) остаётся немым до самого ответа.
   */
  private admissionWarnTimer: NodeJS.Timeout | null = null;
  /**
   * Сети, чей воркер сейчас завершается (вытеснение, тайм-аут, падение): пока
   * запись не снята, новый воркер к той же базе не поднимается — у одного
   * `data.db` не должно быть двух соединений записи даже на мгновение.
   */
  private readonly closing = new Map<string, Promise<void>>();
  private closed = false;

  private completed = 0;
  private failed = 0;
  private timedOut = 0;
  private evictedCount = 0;
  private spawns = 0;
  private maxQueueDepth = 0;
  private lastWaitMs = 0;
  private lastExecMs = 0;

  constructor(options: WritePoolOptions = {}) {
    this.size = Math.max(1, Math.floor(options.size ?? DEFAULT_WRITE_POOL_SIZE));
    this.taskTimeoutMs = Math.max(
      1,
      Math.floor(options.taskTimeoutMs ?? DEFAULT_WRITE_TASK_TIMEOUT_MS),
    );
    this.idleEvictionMs = Math.max(
      0,
      Math.floor(options.idleEvictionMs ?? DEFAULT_WRITE_IDLE_EVICTION_MS),
    );
    this.queueWarnDepth = Math.max(
      1,
      Math.floor(options.queueWarnDepth ?? DEFAULT_WRITE_QUEUE_WARN_DEPTH),
    );
    this.queueWaitWarnMs = Math.max(
      0,
      Math.floor(options.queueWaitWarnMs ?? DEFAULT_WRITE_QUEUE_WAIT_WARN_MS),
    );
    if (options.logger !== undefined) this.logger = options.logger;
  }

  /** Число задач, ждущих в очередях и на допуске. */
  get pending(): number {
    return this.admission.length + this.queuedCount() + this.busyCount();
  }

  /** Закрыт ли пул (после {@link close}). */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Снимок состояния пула: очереди, занятость, счётчики (требование 28a47bcf). */
  stats(): WritePoolStats {
    return {
      size: this.size,
      workers: this.pins.length,
      pinnedNetworks: this.pins.map((p) => p.networkId),
      closingNetworks: [...this.closing.keys()],
      busyWorkers: this.busyCount(),
      queued: this.queuedCount(),
      waitingAdmission: this.admission.length,
      completed: this.completed,
      failed: this.failed,
      timedOut: this.timedOut,
      evicted: this.evictedCount,
      spawns: this.spawns,
      maxQueueDepth: this.maxQueueDepth,
      lastWaitMs: this.lastWaitMs,
      lastExecMs: this.lastExecMs,
    };
  }

  /**
   * Выполнить задачу записи: закреплённый воркер её сети возьмёт её в порядке
   * очереди; при нехватке воркеров задача ждёт допуска (LRU-вытеснение
   * простаивающих привязок — в {@link admit}).
   */
  run(task: WriteTask): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new EtnError('INTERNAL', 'write pool is closed'));
    }
    return new Promise<unknown>((resolve, reject) => {
      const job: Job = {
        task,
        resolve,
        reject,
        enqueuedAtMs: Date.now(),
        timer: null,
        startedAtMs: null,
      };
      try {
        this.route(job);
      } catch (err) {
        // Поток не поднялся (нет загрузчика/файла воркера): задача не должна
        // остаться в очереди — отклоняем и снимаем.
        this.remove(job);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Дождаться слива очередей: все задачи сетей исполнены, очередь допуска пуста.
   * Пул при этом остаётся рабочим — мягкая остановка не запрещает новые задачи,
   * вызывающий сам перестаёт их слать (HTTP-слой уже закрыт).
   */
  async drain(timeoutMs = this.taskTimeoutMs): Promise<WritePoolDrainResult> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const queued = this.queuedCount() + this.admission.length;
      const active = this.busyCount();
      if (queued === 0 && active === 0) return { drained: true, queued: 0, active: 0 };
      if (Date.now() >= deadline) return { drained: false, queued, active };
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  }

  /** Отклонить очередь и `terminate`-ить воркеры, дождавшись их завершения. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearAdmissionTimer();
    this.clearAdmissionWarn();
    const closedError = new EtnError('INTERNAL', 'write pool is closed');
    for (const job of this.admission.splice(0, this.admission.length)) {
      this.rejectJob(job, closedError);
    }
    const exits: Promise<void>[] = [];
    for (const pin of this.pins.splice(0, this.pins.length)) {
      pin.dead = true;
      if (pin.job !== null) {
        this.rejectJob(pin.job, closedError);
        pin.job = null;
      }
      for (const job of pin.queue.splice(0, pin.queue.length)) this.rejectJob(job, closedError);
      exits.push(this.terminate(pin.worker));
    }
    // Дожидаемся и тех воркеров, что уже завершались (вытеснение/тайм-аут): их
    // продолжения зовут `admit`, а он при закрытом пуле — no-op.
    await Promise.all([...exits, ...this.closing.values()]);
  }

  // -------------------------------------------------------------------------
  // Маршрутизация
  // -------------------------------------------------------------------------

  /**
   * Поставить задачу: закреплённой привязке сети — в её очередь, иначе — в
   * очередь допуска. Допуск обслуживается тут же ({@link admit}): он и поднимет
   * свободный воркер, и вытеснит простаивающую привязку, и взведёт таймер на
   * момент, когда привязка станет вытесняемой.
   *
   * Вызов `admit` отсюда обязателен: без него задача новой сети при исчерпанном
   * пуле ждала бы «события», а простаивающая закреплённая привязка событий не
   * даёт (тайм-аут взводится только при передаче задачи воркеру — {@link
   * dispatchPin}), и задача висела бы вечно (ошибка 79c64f3f).
   */
  private route(job: Job): void {
    if (this.closed) {
      throw new EtnError('INTERNAL', 'write pool is closed');
    }
    const networkId = job.task.context.networkId;
    const pin: Pin | undefined = this.pins.find((p) => !p.dead && p.networkId === networkId);
    if (pin !== undefined) {
      pin.queue.push(job);
      this.observeQueue();
      this.dispatchPin(pin);
      return;
    }
    // Воркера у сети нет: единственная точка выдачи слота — очередь допуска,
    // порядок сетей FIFO (новая сеть не обгоняет уже ждущие допуска).
    this.admission.push(job);
    this.observeQueue();
    this.admit();
  }

  /**
   * Воркер для сети: свободный слот пула, иначе — освобождение простаивающей
   * привязки по LRU. `null` — воркера нет и вытеснять нечего: задача ждёт допуска.
   *
   * Сеть, чей прежний воркер ещё завершается ({@link closing}), не получает
   * нового: две записи к одной базе недопустимы даже на мгновение. Задача такой
   * сети встаёт в очередь допуска, а `admit` будится по завершении выхода.
   */
  private pinFor(networkId: string): Pin | null {
    if (this.closing.has(networkId)) return null;
    if (this.pins.length < this.size) return this.createPin(networkId);
    const candidate = this.evictionCandidate();
    if (candidate === null) return null;
    this.evict(candidate);
    return this.createPin(networkId);
  }

  /** Простаивающая привязка, которую можно освободить: LRU среди простоявших порог. */
  private evictionCandidate(): Pin | null {
    const now = Date.now();
    let best: Pin | null = null;
    for (const pin of this.pins) {
      if (pin.dead || pin.job !== null || pin.queue.length > 0) continue;
      if (now - pin.lastUsedMs < this.idleEvictionMs) continue;
      if (best === null || pin.lastUsedMs < best.lastUsedMs) best = pin;
    }
    return best;
  }

  /**
   * Освободить привязку: воркер не нужен, его очередь пуста — соединение
   * закрываем. Сеть попадает в {@link closing} до фактического `exit` воркера:
   * если к ней тут же придёт новая запись, она подождёт допуска и получит
   * соединение только после того, как прежнее закрыто.
   */
  private evict(pin: Pin): void {
    this.evictedCount += 1;
    this.logger?.info(
      { networkId: pin.networkId, idleMs: Date.now() - pin.lastUsedMs },
      'write pool: привязка сети вытеснена по простою',
    );
    this.closePin(pin, 'вытеснение по простою');
  }

  /** Открыть воркер под сеть и повесить обработчики жизненного цикла. */
  private createPin(networkId: string): Pin {
    const worker = spawnWorker();
    this.spawns += 1;
    this.logger?.debug({ networkId, spawns: this.spawns }, 'write pool: воркер сети поднят');
    const pin: Pin = { networkId, worker, job: null, queue: [], lastUsedMs: Date.now(), dead: false };
    worker.on('message', (message: WriteTaskResponse) => this.onMessage(pin, message));
    worker.on('error', (err: Error) => this.onWorkerFailure(pin, err));
    worker.on('exit', (code: number) => {
      if (!pin.dead) this.onWorkerFailure(pin, new Error(`write worker exited with code ${code}`));
    });
    this.pins.push(pin);
    return pin;
  }

  /** Отдать привязке следующую задачу, если воркер свободен. */
  private dispatchPin(pin: Pin): void {
    if (this.closed || pin.dead || pin.job !== null) return;
    const job = pin.queue.shift();
    if (job === undefined) return;
    pin.job = job;
    pin.lastUsedMs = Date.now();
    job.startedAtMs = pin.lastUsedMs;
    this.lastWaitMs = Math.max(0, job.startedAtMs - job.enqueuedAtMs);
    if (this.lastWaitMs >= this.queueWaitWarnMs) {
      this.logger?.warn(
        {
          networkId: pin.networkId,
          waitMs: this.lastWaitMs,
          queued: this.queuedCount(),
          waitingAdmission: this.admission.length,
        },
        'write pool: задача долго ждала в очереди',
      );
    }
    // Тайм-аут считается от НАЧАЛА исполнения: ожидание в очереди ограничено
    // работой впереди и видно в наблюдаемости, а потолок нужен зависшей задаче.
    job.timer = setTimeout(() => this.onTimeout(pin, job), this.taskTimeoutMs);
    job.timer.unref?.();
    pin.worker.postMessage(job.task);
  }

  /** Раздать задачи из очереди допуска освободившимся или вытесняемым воркерам. */
  private admit(): void {
    if (this.closed) return;
    while (this.admission.length > 0) {
      const job = this.admission[0]!;
      const networkId = job.task.context.networkId;
      let pin: Pin | undefined = this.pins.find((p) => !p.dead && p.networkId === networkId);
      if (pin === undefined) {
        const created = this.pinFor(networkId);
        if (created === null) {
          // Вытеснять пока нечего: привязки заняты или ещё не простояли порог.
          // Ждать «события» нельзя — иначе новая сеть повиснет до следующего
          // завершения чужой задачи: будим себя, когда порог истечёт, и держим
          // ожидание видимым в логах.
          this.scheduleAdmissionRetry();
          this.armAdmissionWarn();
          return;
        }
        pin = created;
      }
      this.admission.shift();
      pin.queue.push(job);
      this.dispatchPin(pin);
      // Голова очереди допуска ушла (или очередь опустела) — оба таймера допуска
      // взводились от неё и без сброса становятся устаревшими: таймер повтора
      // сработает не по адресу, а таймер предупреждения выдаст WARN уже для НОВОЙ,
      // свежей задачи с `waitMs` ниже порога (ошибка c7a4d040). Очередь, оставшись
      // непустой, взведёт их заново от новой головы (ветка `created === null`).
      this.clearAdmissionTimer();
      this.clearAdmissionWarn();
    }
  }

  /**
   * Разбудить {@link admit} к моменту, когда какая-нибудь привязка станет
   * вытесняемой (её простой дойдёт до порога). Если все воркеры заняты работой,
   * таймер не нужен: завершение задачи само позовёт `admit`.
   */
  private scheduleAdmissionRetry(): void {
    if (this.closed || this.admissionTimer !== null) return;
    const head = this.admission[0];
    if (head === undefined) return;
    // Сеть, чей прежний воркер ещё завершается, слот раньше `exit` не получит
    // (двух соединений к одной базе не бывает), а этот путь сам позовёт `admit`.
    // Таймер по вытесняемой привязке здесь крутился бы каждую 1 мс: голова
    // очереди станет допускаемой только после `exit`.
    if (this.closing.has(head.task.context.networkId)) return;
    const now = Date.now();
    let delayMs: number | null = null;
    for (const pin of this.pins) {
      if (pin.dead || pin.job !== null || pin.queue.length > 0) continue;
      const eligibleAt = pin.lastUsedMs + this.idleEvictionMs;
      const waitMs = Math.max(1, eligibleAt - now);
      if (delayMs === null || waitMs < delayMs) delayMs = waitMs;
    }
    if (delayMs === null) return;
    const timer = setTimeout(() => {
      this.admissionTimer = null;
      this.admit();
    }, delayMs);
    timer.unref?.();
    this.admissionTimer = timer;
  }

  private clearAdmissionTimer(): void {
    if (this.admissionTimer !== null) {
      clearTimeout(this.admissionTimer);
      this.admissionTimer = null;
    }
  }

  /**
   * Держать ожидание очереди допуска видимым: первое WARN — через
   * `queueWaitWarnMs` от постановки СТАРОЙ задачи допуска, дальше — периодически,
   * пока допуск не опустеет. Так зависание задачи в допуске (ошибка 79c64f3f,
   * где WARN не было вовсе) видно в логах, а не только в `stats()`.
   *
   * Таймер привязан к ТЕКУЩЕЙ голове очереди: при выдаче слота ({@link admit})
   * он сбрасывается — иначе устаревший таймер выдал бы WARN с `waitMs` ниже
   * порога уже для следующей, свежей задачи (ошибка c7a4d040).
   */
  private armAdmissionWarn(rearmMs?: number): void {
    if (this.closed || this.admissionWarnTimer !== null) return;
    const head = this.admission[0];
    if (head === undefined) return;
    const period = Math.max(1, this.queueWaitWarnMs);
    const delayMs =
      rearmMs ?? Math.max(1, head.enqueuedAtMs + this.queueWaitWarnMs - Date.now());
    const timer = setTimeout(() => {
      this.admissionWarnTimer = null;
      const waiting = this.admission[0];
      if (this.closed || waiting === undefined) return;
      this.logger?.warn(
        {
          waitMs: Date.now() - waiting.enqueuedAtMs,
          waitingAdmission: this.admission.length,
          busyWorkers: this.busyCount(),
          pinnedNetworks: this.pins.map((p) => p.networkId),
          closingNetworks: [...this.closing.keys()],
        },
        'write pool: задача долго ждёт допуска',
      );
      // Допуск всё ещё не пуст — предупреждать и дальше (порог — период WARN).
      this.armAdmissionWarn(period);
    }, delayMs);
    timer.unref?.();
    this.admissionWarnTimer = timer;
  }

  private clearAdmissionWarn(): void {
    if (this.admissionWarnTimer !== null) {
      clearTimeout(this.admissionWarnTimer);
      this.admissionWarnTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Жизненный цикл задач
  // -------------------------------------------------------------------------

  /** Ответ воркера: разбудить задачу, обновить наблюдаемость, продолжить очередь. */
  private onMessage(pin: Pin, message: WriteTaskResponse): void {
    const job = pin.job;
    if (job === null) return;
    pin.job = null;
    this.clearTimer(job);
    const execMs = job.startedAtMs === null ? 0 : Date.now() - job.startedAtMs;
    this.lastExecMs = execMs;
    if (message.ok) {
      this.completed += 1;
      this.logger?.debug(
        {
          networkId: pin.networkId,
          op: job.task.op,
          waitMs: this.lastWaitMs,
          execMs,
          queued: this.queuedCount(),
        },
        'write pool: задача исполнена',
      );
      job.resolve(message.result);
    } else {
      this.failed += 1;
      job.reject(new EtnError(message.error.code, message.error.message, message.error.details));
    }
    pin.lastUsedMs = Date.now();
    this.dispatchPin(pin);
    this.admit();
  }

  /**
   * Тайм-аут задачи: воркер завис — слот заменяется, задача отклоняется.
   *
   * **Поздний коммит.** `terminate()` не прерывает нативный вызов
   * `better-sqlite3`: поток, застрявший в транзакции (ждал блокировку), после
   * снятия причины блокировки может ЗАКОММИТИТЬ батч уже после тайм-аута.
   * Поэтому ответ вызывающему отдаётся с признаком «результат неизвестен»
   * (`details.resultUnknown`), а не как «запись не сделана»: повтор безопасен
   * (find-or-match семантика батча), но гарантия at-most-once на этом пути не
   * абсолютна (ADR ca3a9218, раздел «Вопросы реализации» ТП 0df7ccd6).
   *
   * Отклоняем ПОСЛЕ попытки дождаться `exit`: пока поток жив, состояние БД не
   * финально, и клиент, получив ошибку, мог бы повторить запись на границе с
   * поздним коммитом.
   */
  private onTimeout(pin: Pin, job: Job): void {
    if (pin.dead || pin.job !== job) return;
    this.timedOut += 1;
    this.logger?.warn(
      { networkId: pin.networkId, op: job.task.op, timeoutMs: this.taskTimeoutMs },
      'write pool: задача записи не уложилась в тайм-аут — воркер заменяется',
    );
    pin.job = null;
    this.clearTimer(job);
    this.closePin(pin, 'тайм-аут задачи', {
      job,
      error: new EtnError('INTERNAL', `write task timed out after ${this.taskTimeoutMs} ms`, {
        timedOutMs: this.taskTimeoutMs,
        resultUnknown: true,
      }),
    });
  }

  /** Падение/выход воркера: отклонить его задачу и заменить слот. */
  private onWorkerFailure(pin: Pin, err: Error): void {
    if (pin.dead) return;
    this.logger?.warn({ err, networkId: pin.networkId }, 'write pool: воркер записи упал');
    const job = pin.job;
    pin.job = null;
    if (job !== null) {
      this.clearTimer(job);
      this.failed += 1;
      // Коммит мог состояться до падения, а ответ — потеряться: результат
      // считается неизвестным так же, как при тайм-ауте (см. комментарий выше).
      job.reject(
        err instanceof EtnError
          ? err
          : new EtnError('INTERNAL', `write worker failed: ${err.message}`, { resultUnknown: true }),
      );
    }
    this.closePin(pin, 'падение воркера');
  }

  /**
   * Снять привязку с сети, сохранив её невыполненные задачи: они возвращаются в
   * очередь допуска В НАЧАЛО (порядок внутри сети и старшинство перед новыми
   * задачами других сетей сохраняются). Незакоммиченная транзакция откатывается
   * SQLite вместе с завершением потока — полузаписи не остаётся.
   *
   * Пока старый воркер сети не вышел, сеть числится в {@link closing}: новый
   * воркер к ТОЙ ЖЕ базе не поднимается (см. {@link pinFor}) — иначе у одного
   * `data.db` на мгновение оказывалось бы два соединения записи.
   *
   * `pendingJob` — задача, которую нужно отклонить: ждём `exit` (чтобы состояние
   * БД стало финальным), потом отдаём ошибку (поздний коммит, см. {@link onTimeout}).
   */
  private closePin(
    pin: Pin,
    reason: string,
    pending?: { job: Job; error: EtnError },
  ): void {
    pin.dead = true;
    const index = this.pins.indexOf(pin);
    if (index >= 0) this.pins.splice(index, 1);
    const pendingQueue = pin.queue.splice(0, pin.queue.length);
    if (pendingQueue.length > 0) this.admission.unshift(...pendingQueue);
    this.logger?.debug(
      { networkId: pin.networkId, reason, requeued: pendingQueue.length },
      'write pool: привязка снята, невыполненные задачи сети возвращены в очередь допуска',
    );
    const networkId = pin.networkId;
    const exiting = this.terminate(pin.worker).then(() => {
      this.closing.delete(networkId);
      this.logger?.debug(
        { networkId, reason },
        'write pool: воркер сети остановлен, база освобождена',
      );
      if (pending !== undefined) pending.job.reject(pending.error);
      this.admit();
    });
    this.closing.set(networkId, exiting);
    // Не ждём `exit` на этом шаге: вызывающий (таймер/событие воркера) не должен
    // держать цикл событий — продолжение в `then` выше.
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

  // -------------------------------------------------------------------------
  // Наблюдаемость и мелкие помощники
  // -------------------------------------------------------------------------

  /** Записать глубину очереди и предупредить о её росте (требование 28a47bcf). */
  private observeQueue(): void {
    const depth = this.queuedCount() + this.admission.length;
    this.maxQueueDepth = Math.max(this.maxQueueDepth, depth);
    if (depth >= this.queueWarnDepth) {
      this.logger?.warn(
        {
          depth,
          queued: this.queuedCount(),
          waitingAdmission: this.admission.length,
          busyWorkers: this.busyCount(),
          pinnedNetworks: this.pins.map((p) => p.networkId),
        },
        'write pool: очередь записи растёт',
      );
    }
  }

  private busyCount(): number {
    return this.pins.filter((p) => p.job !== null).length;
  }

  private queuedCount(): number {
    let total = 0;
    for (const pin of this.pins) total += pin.queue.length;
    return total;
  }

  /** Найти задачу в очередях и снять её (задача не успела уйти воркеру). */
  private remove(job: Job): void {
    const index = this.admission.indexOf(job);
    if (index >= 0) {
      this.admission.splice(index, 1);
      return;
    }
    for (const pin of this.pins) {
      const qi = pin.queue.indexOf(job);
      if (qi >= 0) {
        pin.queue.splice(qi, 1);
        return;
      }
    }
  }

  private clearTimer(job: Job): void {
    if (job.timer !== null) {
      clearTimeout(job.timer);
      job.timer = null;
    }
  }

  private rejectJob(job: Job, error: Error): void {
    this.clearTimer(job);
    job.reject(error);
  }
}

// ---------------------------------------------------------------------------
// Процессный пул (единственный на процесс, как реестр соединений сети)
// ---------------------------------------------------------------------------

let processPool: WritePool | null = null;

/**
 * Настроить процессный пул записи (вызывается при старте сервера).
 *
 * `size: 0` — пул выключен полностью: задача записи исполняется синхронно в
 * главном потоке (деградация требования 3d9d017f). Идемпотентно: повторный
 * вызов с теми же настройками переиспользует пул.
 */
export function configureWritePool(options: WritePoolOptions): WritePool | null {
  const size = Math.floor(options.size ?? DEFAULT_WRITE_POOL_SIZE);
  if (size <= 0) {
    void closeWritePool();
    return null;
  }
  if (processPool !== null && !processPool.isClosed && processPool.size === size) {
    return processPool;
  }
  void closeWritePool();
  processPool = new WritePool({ ...options, size });
  return processPool;
}

/** Процессный пул, если он настроен и открыт; иначе `null`. */
export function getWritePool(): WritePool | null {
  return processPool !== null && !processPool.isClosed ? processPool : null;
}

/**
 * Контекст задачи write-пула из соединения главного потока, либо `null`, если
 * задачу нельзя унести в пул: сеть в памяти (`:memory:` нельзя открыть вторым
 * соединением) или соединение закрыто. Зеркало `contextFor` из
 * `domain/heavy-read.ts` для стороны записи.
 */
export function writeContextFor(ndb: NetworkDb): WriteTaskContext | null {
  if (ndb.isClosed || ndb.dbPath === ':memory:') return null;
  const rows = ndb.pragma('schema_version') as Array<{ schema_version: number }>;
  return {
    dbPath: ndb.dbPath,
    networkId: ndb.networkId,
    layerId: ndb.layerId,
    schemaVersion: rows[0]?.schema_version ?? 0,
  };
}

/** Опции отправки задачи записи через пул. */
export interface RunWriteTaskOptions {
  /**
   * Синхронный исполнитель той же задачи в главном потоке — путь деградации:
   * пул выключен, сеть в памяти или задача не допускает воркера. Результат
   * обязан совпадать с пуловым (требование 3d9d017f).
   */
  sync: () => unknown;
  /**
   * Можно ли задачу унести в пул. `false` — исполнение синхронное: так фасад
   * отсеивает то, что воркер пока не умеет (кросс-сетевой резолв, ADR ca3a9218
   * «Кросс-сетевой резолв»). Дефолт — `true`.
   */
  poolable?: boolean;
}

/**
 * Исполнить задачу записи: в пуле, если он настроен и задача допускает воркер;
 * иначе — синхронно через {@link RunWriteTaskOptions.sync}. Единственная точка
 * выбора «пул или главный поток» для вызывающих (будущий `runWrite`).
 */
export async function runWriteTask(
  task: WriteTask,
  options: RunWriteTaskOptions,
): Promise<unknown> {
  const pool = getWritePool();
  if (
    pool === null ||
    options.poolable === false ||
    task.context.dbPath === ':memory:' ||
    task.context.crossNetworkAccess !== undefined
  ) {
    return options.sync();
  }
  return pool.run(task);
}

/** Дождаться слива очередей пула (шаг мягкой остановки сервера). */
export async function drainWritePool(timeoutMs?: number): Promise<WritePoolDrainResult> {
  const pool = getWritePool();
  if (pool === null) return { drained: true, queued: 0, active: 0 };
  return timeoutMs === undefined ? pool.drain() : pool.drain(timeoutMs);
}

/** Закрыть процессный пул (остановка сервера или выключение пула конфигом). */
export async function closeWritePool(): Promise<void> {
  if (processPool === null) return;
  const pool = processPool;
  processPool = null;
  await pool.close();
}
