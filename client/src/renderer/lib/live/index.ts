/**
 * Слой данных клиента (этап G1 тех.проекта `269016e2` — реактивный слой).
 *
 * Публичный фасад инфраструктуры: нормализованный кэш сущностей, реестр
 * запросов, реактивные подписки, роутер realtime-событий и mutator-слой.
 * Экраны мигрируют на него поэтапно (G2–G6) — до тех пор слой живёт
 * параллельно старому пути `applyRealtimeToUi` и поведения UI не меняет.
 *
 * Типовые шаги потребителя (будущие экраны):
 *
 * ```ts
 * const store = queryStore(queryKeys.focus(thoughtId), () => etn.thoughts.focus(...));
 * const unsub = store.subscribe(({ data, status }) => render(data, status));
 * // мутация кладёт ответ в кэш — «своя правка» неотличима от «чужой»
 * commitEntity('thought', id, await etn.thoughts.update(...));
 * ```
 */

export {
  clearEntities,
  entitiesRevision,
  entitiesSize,
  entitiesSnapshot,
  entityKey,
  entityStore,
  getEntity,
  getRecord,
  patchEntity,
  putEntity,
  removeEntity,
  restoreRecord,
  type EntityKey,
  type EntityKind,
  type EntityRecord,
  type PutEntityOptions,
} from './entities.js';

export {
  asRealtimeCause,
  getQueryState,
  hasQuery,
  invalidateQueries,
  markQueryStale,
  onQueryInvalidated,
  queryKeysSnapshot,
  queryStore,
  querySubscriberCount,
  refetchQuery,
  registerQuery,
  resetQueryRegistry,
  setQueryData,
  subscribeQuery,
  type InvalidationCause,
  type LocalMutationSignal,
  type QueryFetcher,
  type QueryListener,
  type QueryState,
  type QueryStatus,
  type RealtimeCause,
} from './query-registry.js';

export {
  derived,
  pick,
  writable,
  type Readable,
  type StoreLike,
  type Subscriber,
  type Writable,
} from './reactive.js';

export { keyOf, matchesKeyPrefix, queryKeys, ref } from './query-keys.js';

export {
  commitEntity,
  commitEntityPatch,
  commitEntityRemoval,
  invalidateAfterMutation,
  optimisticEntityPatch,
  putMutationResult,
  runOptimistic,
  signalPermanentCommentSaved,
  signalPublicationCompositionChanged,
  signalThoughtSaved,
  type OptimisticOptions,
} from './mutator.js';

export {
  IGNORED_REALTIME_EVENT_TYPES,
  realtimeRoutes,
  resetEventRouter,
  routeRealtimeEvent,
  type RouteContext,
  type RouteResult,
  type RouteRule,
  type RouteTable,
} from './event-router.js';
