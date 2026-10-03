/**
 * Реактивный примитив слоя данных (этап G1 тех.проекта `269016e2`).
 *
 * Своя микрореализация по контракту Svelte stores (открытый вопрос техпроекта,
 * решение «своя»): `subscribe` немедленно отдаёт текущее значение, возвращает
 * функцию отписки. `derived` строит срез из одного или нескольких хранилищ.
 *
 * Единственное сознательное отличие от Svelte: уведомления подписчиков
 * БАТЧИРУЮТСЯ в микротаске. Пачка синхронных изменений (несколько событий
 * роутера, мутация из REST-ответа) даёт одну перерисовку, а не серию — грабли
 * «каждое уведомление = перерисовка» уже ловили проект (см. guard-тест
 * коалессирования холста `guard-canvas-render-coalescing`). Начальный вызов
 * `run(value)` при подписке — синхронный, как требует контракт.
 *
 * Зависимостей нет, DOM не трогается — примитив пригоден для юнит-теста под
 * DOM-шимом.
 */

/** Функция подписчика: получает актуальное значение хранилища. */
export type Subscriber<T> = (value: T) => void;

/** Контракт Svelte-store: только подписка. */
export interface Readable<T> {
  subscribe(run: Subscriber<T>): () => void;
}

/** Хранилище с записью значения. */
export interface Writable<T> extends Readable<T> {
  set(value: T): void;
  update(fn: (value: T) => T): void;
}

/** Внутренний вид хранилища: к `subscribe` добавлен синхронный `get()`. */
export interface StoreLike<T> extends Readable<T> {
  get(): T;
}

/** Подписчик внутри хранилища: помнит последнее доставленное значение. */
interface Sub<T> {
  run: Subscriber<T>;
  last: T;
  dirty: boolean;
}

/**
 * Глобальная очередь батча: хранилища, у которых с прошлого тика изменилось
 * значение. Один микротаск — одна доставка на подписчика.
 */
const pendingStores = new Set<{ flush(): void }>();
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    const batch = [...pendingStores];
    pendingStores.clear();
    for (const store of batch) store.flush();
  });
}

/** Хранилище-значение. Реализует {@link Writable}. */
class Store<T> implements Writable<T>, StoreLike<T> {
  private readonly subs = new Set<Sub<T>>();
  private current: T;

  constructor(initial: T) {
    this.current = initial;
  }

  public get(): T {
    return this.current;
  }

  public subscribe(run: Subscriber<T>): () => void {
    const sub: Sub<T> = { run, last: this.current, dirty: false };
    this.subs.add(sub);
    // Контракт Svelte-store: немедленная синхронная доставка текущего значения.
    run(this.current);
    return () => {
      this.subs.delete(sub);
    };
  }

  public set(value: T): void {
    if (Object.is(this.current, value)) return;
    this.current = value;
    for (const sub of this.subs) sub.dirty = true;
    if (this.subs.size > 0) {
      pendingStores.add(this);
      scheduleFlush();
    }
  }

  public update(fn: (value: T) => T): void {
    this.set(fn(this.current));
  }

  /** Доставка накопленных изменений (зовёт микротаск-планировщик). */
  public flush(): void {
    for (const sub of this.subs) {
      if (!sub.dirty) continue;
      sub.dirty = false;
      // Значение вернулось к прежнему — подписчик ничего не заметит.
      if (Object.is(sub.last, this.current)) continue;
      sub.last = this.current;
      sub.run(this.current);
    }
  }
}

/** Создать хранилище с начальным значением. */
export function writable<T>(initial: T): Writable<T> & StoreLike<T> {
  return new Store(initial);
}

/**
 * Производное хранилище. Источники — РЕАКТИВНЫЕ хранилища (не геттеры):
 * `derived` сам управляет подпиской на них (ref-count: подписка на источники
 * живёт, пока есть хотя бы один подписчик среза).
 *
 * `fn` получает массив текущих значений источников (для одного источника —
 * массив из одного элемента).
 */
export function derived<S, T>(
  sources: StoreLike<S> | readonly StoreLike<S>[],
  fn: (values: S[]) => T,
): Readable<T> & { get(): T } {
  const list: readonly StoreLike<S>[] = Array.isArray(sources) ? sources : [sources as StoreLike<S>];
  return new Derived(list, fn);
}

class Derived<S, T> implements Readable<T> {
  private readonly subs = new Set<Subscriber<T>>();
  private unsubs: Array<() => void> = [];
  private readonly lastVals: Array<S | undefined>;
  private started = false;
  private hasValue = false;
  private value: T | undefined;

  constructor(
    private readonly sources: readonly StoreLike<S>[],
    private readonly fn: (values: S[]) => T,
  ) {
    this.lastVals = new Array<S | undefined>(sources.length).fill(undefined);
  }

  public get(): T {
    if (!this.hasValue) {
      this.value = this.fn(this.sources.map((s) => s.get()));
      this.hasValue = true;
    }
    return this.value as T;
  }

  public subscribe(run: Subscriber<T>): () => void {
    this.start();
    const value = this.get();
    this.subs.add(run);
    run(value);
    return () => {
      this.subs.delete(run);
      if (this.subs.size === 0) this.stop();
    };
  }

  private start(): void {
    if (this.started) return;
    this.unsubs = this.sources.map((source, index) =>
      source.subscribe((value) => this.onSource(index, value)),
    );
    this.started = true;
    // Источники при подписке отдали текущие значения синхронно — пересчёт
    // нужен один раз, после того как заполнены все lastVals.
    this.recompute();
  }

  private stop(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.started = false;
  }

  private onSource(index: number, value: S): void {
    this.lastVals[index] = value;
    if (this.started) this.recompute();
  }

  private recompute(): void {
    const next = this.fn(this.lastVals as S[]);
    if (this.hasValue && Object.is(this.value, next)) return;
    this.value = next;
    this.hasValue = true;
    for (const run of [...this.subs]) run(next);
  }
}

/**
 * Собрать значение из нескольких хранилищ по ключам — удобный срез без
 * ручного `derived`. Возвращает массив значений в порядке ключей.
 */
export function pick<T, K extends keyof T>(
  store: StoreLike<T>,
  ...keys: K[]
): Readable<Pick<T, K>> {
  return derived(store, (values) => {
    const value = values[0] as T;
    const out = {} as Pick<T, K>;
    for (const key of keys) out[key] = value[key];
    return out;
  });
}
