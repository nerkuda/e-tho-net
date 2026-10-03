/**
 * Реестр запросов слоя данных (этап G1 тех.проекта `269016e2`).
 *
 * Экран (или срез UI) описывает запрос парой (ключ, fetcher) и подписывается.
 * Реестр держит по ключу:
 *
 *  - **данные** (`data`) — последнее успешное значение;
 *  - **статус** `fresh` / `stale` / `loading`;
 *  - **ошибку** последнего перезапроса;
 *  - **подписчиков** — только пока они есть, запрос «живой».
 *
 * Ключевое правило: **рефетч — только при активных наблюдателях**. Инвалидация
 * помечает запись `stale`, но в сеть уходит лишь тогда, когда на неё кто-то
 * подписан (экран открыт). Нет наблюдателя — данные лежат stale и обновятся при
 * следующей подписке (stale-while-revalidate).
 *
 * Инвалидация — по префиксу ключа (`query-keys.ts`): `focus` гасит все
 * `focus:@…`. Это то, что роутер событий (`event-router.ts`) дёргает по таблице
 * «событие → ключи».
 */

import { matchesKeyPrefix } from './query-keys.js';
import { writable, type Readable } from './reactive.js';

/** Статус записи реестра. */
export type QueryStatus = 'fresh' | 'stale' | 'loading';

/** То, что видит подписчик запроса. */
export interface QueryState<T = unknown> {
  status: QueryStatus;
  data: T | undefined;
  error: unknown;
}

/** Загрузчик данных запроса. */
export type QueryFetcher<T> = () => Promise<T>;

/** Слушатель изменений состояния одной записи. */
export type QueryListener<T> = (state: QueryState<T>) => void;

interface QueryEntry<T = unknown> {
  key: string;
  fetcher: QueryFetcher<T> | null;
  state: QueryState<T>;
  /** Растёт на каждый set/invalidate — дешёвый признак новизны. */
  version: number;
  /** Перезапрос в полёте (null — нет). */
  promise: Promise<void> | null;
  subscribers: Set<QueryListener<T>>;
}

const entries = new Map<string, QueryEntry<unknown>>();

/**
 * Наблюдатели инвалидаций (этап G2). Позволяют экрану узнать, что ключ его
 * запроса погашен, не подписываясь на realtime-шину напрямую. Так холст
 * перерисовывает нижнюю зону-отбор, когда окрестность фокуса перечитана, но её
 * содержимое не изменилось (`canvasRenderKey` не ломается — ошибка 4fca95c9).
 */
/**
 * Причина инвалидации (этап G4 тех.проекта `269016e2`). Роутер передаёт
 * realtime-событие, локальная мутация — свой сигнал (см. `LocalMutationSignal`).
 * Наблюдателю причина нужна там, где реакция на ключ зависит от того, ЧТО
 * именно изменилось: открытый документ публикации под stale правит блок из
 * payload события, а не перечитывает сборку.
 */
export type InvalidationCause = unknown;

/**
 * Локальный сигнал мутации-источника (не realtime-событие). Позволяет экрану
 * отличить свою пересборку от прочих инвалидаций того же ключа.
 */
export interface LocalMutationSignal {
  /** `publication-rebuilt` — публикацию пересобрали; живой текст снова свеж. */
  local: string;
  /** id затронутой сущности (если сигнал адресный). */
  id?: string;
}

type InvalidationListener = (
  prefix: string,
  keys: readonly string[],
  cause?: InvalidationCause,
) => void;
const invalidationListeners = new Set<InvalidationListener>();

/** Подписаться на инвалидации ключей реестра; возвращает отписку. */
export function onQueryInvalidated(listener: InvalidationListener): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

function notifyInvalidated(
  prefix: string,
  keys: readonly string[],
  cause?: InvalidationCause,
): void {
  for (const listener of [...invalidationListeners]) listener(prefix, keys, cause);
}

/**
 * Коалессия инвалидаций (замечание G2 65286909): перезапрос записи запускается
 * НЕ в момент инвалидации, а в микротаске. Несколько инвалидаций одного ключа
 * за одну пачку событий (например, пара `thought.created` + `link.created`
 * роутера или несколько префиксов одного события, попавших в тот же ключ) дают
 * ОДИН перезапрос вместо одного на каждое событие. Состояние `stale` и
 * уведомление подписчиков при этом выставляются синхронно — наблюдатель
 * инвалидаций (`onQueryInvalidated`) и тесты паритета видят ключи сразу.
 */
const scheduledRefetches = new Set<string>();
let refetchFlushScheduled = false;

function scheduleRefetch(key: string): void {
  scheduledRefetches.add(key);
  if (refetchFlushScheduled) return;
  refetchFlushScheduled = true;
  queueMicrotask(flushScheduledRefetches);
}

function flushScheduledRefetches(): void {
  refetchFlushScheduled = false;
  const keys = [...scheduledRefetches];
  scheduledRefetches.clear();
  for (const key of keys) {
    const entry = getEntry(key);
    if (entry === undefined) continue;
    // Рефетч — только активным наблюдателям и пока не идёт другой запрос.
    if (entry.subscribers.size > 0 && entry.promise === null) void startFetch(asEntry(entry));
  }
}

function asEntry<T>(entry: QueryEntry<unknown>): QueryEntry<T> {
  return entry as unknown as QueryEntry<T>;
}

function getEntry(key: string): QueryEntry<unknown> | undefined {
  return entries.get(key);
}

function createEntry<T>(key: string, fetcher: QueryFetcher<T> | null): QueryEntry<T> {
  const entry: QueryEntry<T> = {
    key,
    fetcher,
    state: { status: 'stale', data: undefined, error: null },
    version: 0,
    promise: null,
    subscribers: new Set(),
  };
  entries.set(key, entry as unknown as QueryEntry<unknown>);
  return entry;
}

/**
 * Найти запись или создать. При наличии записи fetcher обновляется ТОЛЬКО
 * непустым значением (блокер 1 верификатора: `setQueryData`/`refetchQuery` без
 * явного fetcher не должны обнулять загрузчик живой записи — иначе её ключ
 * больше никогда не перезапросится).
 */
function ensureEntry<T>(key: string, fetcher: QueryFetcher<T> | null): QueryEntry<T> {
  const existing = getEntry(key);
  if (existing === undefined) return createEntry<T>(key, fetcher);
  if (fetcher !== null) existing.fetcher = fetcher as unknown as QueryFetcher<unknown>;
  return asEntry<T>(existing);
}

/**
 * Зарегистрировать запрос (создать запись или обновить её fetcher).
 * Возвращает ключ — реестр адресуется строками.
 */
export function registerQuery<T>(key: string, fetcher: QueryFetcher<T> | null): string {
  const existing = getEntry(key);
  if (existing === undefined) {
    createEntry(key, fetcher);
  } else {
    existing.fetcher = fetcher as unknown as QueryFetcher<unknown> | null;
  }
  return key;
}

/** Текущее состояние записи (без подписки). */
export function getQueryState<T = unknown>(key: string): QueryState<T> {
  const entry = getEntry(key);
  if (entry === undefined) return { status: 'stale', data: undefined, error: null };
  return asEntry<T>(entry).state;
}

/** Есть ли запись в реестре. */
export function hasQuery(key: string): boolean {
  return entries.has(key);
}

/** Все ключи реестра (снимок для тестов и диагностики). */
export function queryKeysSnapshot(): string[] {
  return [...entries.keys()].sort();
}

/** Число активных наблюдателей у записи. */
export function querySubscriberCount(key: string): number {
  return getEntry(key)?.subscribers.size ?? 0;
}

function notify<T>(entry: QueryEntry<T>): void {
  for (const listener of [...entry.subscribers]) listener(entry.state);
}

/**
 * Положить готовые данные в кэш запроса (мутация/REST-ответ): статус `fresh`,
 * версия растёт. Подписчики уведомляются.
 */
export function setQueryData<T>(key: string, data: T): void {
  const entry = ensureEntry<T>(key, null);
  entry.state = { status: 'fresh', data, error: null };
  entry.version += 1;
  notify(entry);
}

/**
 * Пометить запись устаревшей, не трогая данные (stale-while-revalidate).
 *
 * Замечание (G2 65286909): вызов во время `loading` поднимает `version` и тем
 * самым отбрасывает результат фетча в полёте — запись останется `stale` до
 * следующей инвалидации. На мигрированных путях G2 функция не используется
 * (гашение идёт через `invalidateQueries`), поэтому путь теоретический.
 */
export function markQueryStale(key: string): void {
  const entry = getEntry(key);
  if (entry === undefined) return;
  if (entry.state.status === 'stale') return;
  entry.state = { ...entry.state, status: 'stale' };
  entry.version += 1;
  notify(entry);
}

function startFetch<T>(entry: QueryEntry<T>): Promise<void> {
  const fetcher = entry.fetcher;
  if (fetcher === null || entry.promise !== null) return entry.promise ?? Promise.resolve();
  entry.state = { ...entry.state, status: 'loading' };
  entry.version += 1;
  // Токен запуска (блокер 2 верификатора): если за время полёта запись
  // получила свежие данные (мутация через setQueryData или другое событие),
  // version изменится, и устаревший ответ не затрёт свежее состояние.
  const startVersion = entry.version;
  notify(entry);
  const promise = fetcher()
    .then((data) => {
      // За время полёта запись могли снять/заменить — пишем в актуальную по ключу.
      const live = getEntry(entry.key);
      if (live === undefined) return;
      const liveEntry = asEntry<T>(live);
      if (liveEntry.version !== startVersion) return; // устаревший ответ — отбросить
      liveEntry.state = { status: 'fresh', data, error: null };
      liveEntry.version += 1;
      notify(liveEntry);
    })
    .catch((error: unknown) => {
      const live = getEntry(entry.key);
      if (live === undefined) return;
      const liveEntry = asEntry<T>(live);
      if (liveEntry.version !== startVersion) return; // устаревшая ошибка — отбросить
      // Данные не теряем: статус снова stale, ошибка — рядом.
      liveEntry.state = { ...liveEntry.state, status: 'stale', error };
      liveEntry.version += 1;
      notify(liveEntry);
    })
    .finally(() => {
      const live = getEntry(entry.key);
      if (live !== undefined && asEntry<T>(live).promise === promise) {
        asEntry<T>(live).promise = null;
      }
    });
  entry.promise = promise;
  return promise;
}

/**
 * Гарантировать загрузку: запускает перезапрос, если запись не `fresh`, нет
 * запроса в полёте и есть активные наблюдатели.
 */
export function ensureQuery<T>(key: string, fetcher: QueryFetcher<T>): Promise<void> {
  const entry = ensureEntry<T>(key, fetcher);
  if (entry.subscribers.size === 0) return Promise.resolve();
  if (entry.state.status === 'fresh' || entry.promise !== null) return entry.promise ?? Promise.resolve();
  return startFetch(entry);
}

/** Принудительный перезапрос (даже fresh); требует наблюдателя либо явного зова. */
export function refetchQuery<T>(key: string, fetcher?: QueryFetcher<T>): Promise<void> {
  const entry = ensureEntry<T>(key, fetcher ?? null);
  if (entry.fetcher === null) return Promise.resolve();
  // Инвалидация перед повторным запросом: статус loading выставит startFetch.
  return startFetch(entry);
}

/**
 * Подписаться на запрос: немедленно отдаёт текущее состояние, при необходимости
 * запускает загрузку. Отписка последнего наблюдателя «усыпляет» запрос.
 */
export function subscribeQuery<T>(
  key: string,
  fetcher: QueryFetcher<T>,
  listener: QueryListener<T>,
): () => void {
  const entry = ensureEntry<T>(key, fetcher);
  entry.subscribers.add(listener);
  listener(entry.state);
  // Загрузка — только пока есть наблюдатель (он уже добавлен).
  void ensureQuery(key, fetcher);
  return () => {
    const live = getEntry(key);
    if (live === undefined) return;
    asEntry<T>(live).subscribers.delete(listener);
  };
}

/**
 * Реактивное хранилище состояния запроса (контракт Svelte): срез для
 * компонентов. Подписка «зажигает» запрос, отписка последнего — «усыпляет».
 */
export function queryStore<T>(key: string, fetcher: QueryFetcher<T>): Readable<QueryState<T>> {
  const store = writable<QueryState<T>>(getQueryState<T>(key));
  let entryUnsub: (() => void) | null = null;
  let count = 0;
  return {
    subscribe(run) {
      const unsubStore = store.subscribe(run);
      count += 1;
      if (count === 1) {
        entryUnsub = subscribeQuery<T>(key, fetcher, (state) => store.set(state));
      }
      return () => {
        unsubStore();
        count -= 1;
        if (count === 0 && entryUnsub !== null) {
          entryUnsub();
          entryUnsub = null;
        }
      };
    },
  };
}

/**
 * Инвалидировать все записи под префиксом. Возвращает список затронутых ключей
 * (для тестов паритета роутера). Рефетч — только у записей с наблюдателями.
 * `cause` — событие шины или локальный сигнал мутации: наблюдатель узнаёт,
 * ПОЧЕМУ ключ погашен (нужно документу публикации для stale-механики).
 */
export function invalidateQueries(prefix: string, cause?: InvalidationCause): string[] {
  const touched: string[] = [];
  for (const entry of entries.values()) {
    if (!matchesKeyPrefix(entry.key, prefix)) continue;
    touched.push(entry.key);
    if (entry.state.status !== 'loading') {
      entry.state = { ...entry.state, status: 'stale' };
      entry.version += 1;
      notify(entry);
    }
    // Рефетч — только активным наблюдателям; запуск отложен на микротаск и
    // схлопывает повторные инвалидации ключа в один запрос (замечание G2).
    if (entry.subscribers.size > 0 && entry.promise === null) scheduleRefetch(entry.key);
  }
  touched.sort();
  // Уведомляем наблюдателей ДАЖЕ при пустом `touched`: экран мог ещё не
  // зарегистрировать свой ключ (переходный период G2–G6), но обязан узнать,
  // что событие его класса пришло (нижняя зона холста — ошибка 4fca95c9).
  notifyInvalidated(prefix, touched, cause);
  return touched;
}

/** Полный сброс реестра (смена сети, тесты). */
export function resetQueryRegistry(): void {
  entries.clear();
  scheduledRefetches.clear();
}
