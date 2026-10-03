/**
 * Роутер реального времени слоя данных (этап G1 тех.проекта `269016e2`).
 *
 * Заменяет гигантский `switch` в `realtime-ui.ts` ДЕКЛАРАТИВНОЙ таблицей
 * «тип события → массив правил». Правило делает одно из двух (или оба):
 *
 *  - `invalidate(evt) → string[]` — ключи/префиксы запросов, которые надо
 *    погасить (`query-registry.ts`); перезапрос уйдёт только активным
 *    наблюдателям;
 *  - `patch(evt) → string[]` — точечный патч нормализованного кэша из payload
 *    (например, `thought.updated` кладёт новые поля в запись мысли).
 *
 * **Дедуп по seq.** У сети помним последний обработанный seq: событие с
 * `seq <= последнего` — опоздавшее, игнорируется. Второй рубеж — версия самой
 * сущности внутри `patchEntity` (`events.ts`): патч со старым `seq` не
 * откатывает более свежее значение.
 *
 * Путь вводится ПАРАЛЛЕЛЬНО старому `applyRealtimeToUi` (миграция экранов —
 * этапы G2–G6 техпроекта): роутер пишет в новые кэши, которым пока никто не
 * подписан, поэтому поведение UI не меняется.
 */

import type { AnyRealtimeEvent, RealtimeEvent, RealtimeEventType } from '@etn/shared';

import { getEntity, patchEntity, putEntity, removeEntity, type EntityKind } from './entities.js';
import { queryKeys } from './query-keys.js';
import { hasQuery, invalidateQueries, setQueryData } from './query-registry.js';

/** Правило маршрутизации одного события. */
export interface RouteRule {
  /** Ключи/префиксы запросов к инвалидации. */
  invalidate?: (evt: AnyRealtimeEvent) => string[];
  /** Точечный патч кэша; возвращает ключи затронутых записей. */
  patch?: (evt: AnyRealtimeEvent) => string[];
}

/** Таблица маршрутов: тип события → правила. */
export type RouteTable = Partial<Record<RealtimeEventType, readonly RouteRule[]>>;

/** Контекст маршрутизации (активная сеть клиента). */
export interface RouteContext {
  /** Открытая сеть; событие чужой сети не маршрутизируется (граница сети). */
  networkId?: string | null;
}

/** Итог маршрутизации одного события (в т.ч. для тестов паритета). */
export interface RouteResult {
  /** Событие обработано таблицей и прошло дедуп. */
  routed: boolean;
  /** Почему не обработано: опоздавшее, намеренно игнорируемое, неизвестный тип, чужая сеть. */
  reason?: 'stale' | 'ignored' | 'unknown' | 'foreign';
  /** Инвалидированные ключи (отсортированы, без дублей). */
  invalidated: string[];
  /** Затронутые записи нормализованного кэша. */
  patched: string[];
}

// ---------------------------------------------------------------------------
// Типизированная обёртка правила
// ---------------------------------------------------------------------------

interface TypedRule<T extends RealtimeEventType> {
  invalidate?: (evt: RealtimeEvent<T>) => string[];
  patch?: (evt: RealtimeEvent<T>) => string[];
}

function ruleFor<T extends RealtimeEventType>(rule: TypedRule<T>): RouteRule {
  return {
    invalidate: rule.invalidate as unknown as ((evt: AnyRealtimeEvent) => string[]) | undefined,
    patch: rule.patch as unknown as ((evt: AnyRealtimeEvent) => string[]) | undefined,
  };
}

// ---------------------------------------------------------------------------
// Хелперы патча кэша
// ---------------------------------------------------------------------------

function asPatch(value: unknown): Record<string, unknown> {
  return (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
}

/**
 * Синхронизировать запись-проекцию `entity:@kind:@id` с нормализованным кэшем
 * (замечание 3 верификатора): mutator пишет в эту запись, роутер обязан делать
 * то же — иначе подписчик проекции остаётся со старым снимком. Обновляем только
 * уже существующую запись (подписант), чтобы не плодить пустых ключей.
 */
function syncProjection(kind: EntityKind, id: string, entity: unknown): void {
  const key = queryKeys.entity(kind, id);
  if (hasQuery(key)) setQueryData(key, entity);
}

function put(kind: EntityKind, id: string, entity: unknown, evt: AnyRealtimeEvent): string[] {
  const record = putEntity(kind, id, entity, { seq: evt.seq });
  syncProjection(kind, id, record.entity);
  return [`${kind}:${id}`];
}

function patch(
  kind: EntityKind,
  id: string,
  changes: unknown,
  evt: AnyRealtimeEvent,
  version?: number,
): string[] {
  const record = patchEntity(kind, id, asPatch(changes), { seq: evt.seq, version });
  syncProjection(kind, id, record?.entity);
  return [`${kind}:${id}`];
}

function drop(kind: EntityKind, id: string): string[] {
  removeEntity(kind, id);
  syncProjection(kind, id, undefined);
  return [`${kind}:${id}`];
}

// ---------------------------------------------------------------------------
// Таблица маршрутов
// ---------------------------------------------------------------------------

const NEIGHBOURHOOD_KEYS = (): string[] => [
  queryKeys.focusAll(),
  queryKeys.structuresPageAll(),
  queryKeys.chronicleFeedAll(),
  queryKeys.publicationsListAll(),
];

/**
 * Ключи состава публикации: изменение, способное ввести/вывести мысль из отбора
 * (связи, тип, свойства-значения, определения типов/свойств, создание/удаление/
 * порядок мыслей). Открытый документ такой ключ гасит и помечает живой текст
 * устаревшим («Остаётся + подсветка», замечание А2 приёмки b02ef1cf) — сборку
 * при этом НЕ перечитывает.
 */
const PUBLICATION_COMPOSITION_KEYS = (): string[] => [queryKeys.publicationAssemblyAll()];

/** Владелец вложения из нормализованного кэша (для точной инвалидации). */
function attachmentOwnerKeyFromCache(attachmentId: string): string | null {
  const entity = getEntity<{ owner_type?: unknown; owner_id?: unknown }>(
    'attachment',
    attachmentId,
  );
  const ownerType = entity?.owner_type;
  const ownerId = entity?.owner_id;
  if (typeof ownerType === 'string' && typeof ownerId === 'string' && ownerId !== '') {
    return queryKeys.attachments(ownerType, ownerId);
  }
  return null;
}

/** Инвалидация списков вложений после изменения: точный ключ владельца или все. */
function attachmentListKeys(attachmentId: string): string[] {
  return [attachmentOwnerKeyFromCache(attachmentId) ?? queryKeys.attachmentsAll()];
}

/** Декларативная таблица «событие → правила». */
export const realtimeRoutes: RouteTable = {
  'thought.created': [
    ruleFor<'thought.created'>({
      patch: (evt) => [
        ...put('thought', evt.data.thought.id, evt.data.thought, evt),
        ...(evt.data.link !== undefined ? put('link', evt.data.link.id, evt.data.link, evt) : []),
      ],
      invalidate: (evt) => [
        queryKeys.focus(evt.data.thought.id),
        ...NEIGHBOURHOOD_KEYS(),
        ...PUBLICATION_COMPOSITION_KEYS(),
        queryKeys.indicators(evt.data.thought.id),
      ],
    }),
  ],
  'thought.updated': [
    ruleFor<'thought.updated'>({
      patch: (evt) => patch('thought', evt.data.id, evt.data.changes, evt, evt.data.version),
      invalidate: (evt) => {
        const changes = evt.data.changes as Record<string, unknown>;
        const keys = [
          queryKeys.focus(evt.data.id),
          queryKeys.structuresPageAll(),
          // Лента «Дневника» зависит от правки мысли ТОЛЬКО если мысль видна её
          // чипсом — гасим адресный ключ мысли (замечание G3): невидимая правка
          // ленте не адресуется (экран сверяет id со своими чипсами).
          queryKeys.chronicleThought(evt.data.id),
          queryKeys.pins(),
          queryKeys.publicationAssemblyAll(),
        ];
        // Состав активного отбора холста (блокер G3): смена типа/актуальности/
        // пометки на удаление может ВВЕСТИ мысль в отбор — холст переисполняет
        // `views.run` независимо от видимости старого результата.
        if (
          changes['type_id'] !== undefined ||
          changes['active'] !== undefined ||
          changes['marked_for_deletion'] !== undefined
        ) {
          keys.push(queryKeys.viewComposition());
        }
        // Поля, по которым отбор может искать ключевыми словами: холст реагирует
        // только если определение его активного отбора использует `keywords`.
        if (changes['title'] !== undefined || changes['synonyms'] !== undefined) {
          keys.push(queryKeys.viewCompositionKeywords());
        }
        return keys;
      },
    }),
  ],
  'thought.deleted': [
    ruleFor<'thought.deleted'>({
      patch: (evt) => drop('thought', evt.data.id),
      invalidate: (evt) => [
        queryKeys.focus(evt.data.id),
        queryKeys.structuresPageAll(),
        queryKeys.chronicleThought(evt.data.id),
        queryKeys.history(),
        queryKeys.pins(),
        queryKeys.indicators(evt.data.id),
        queryKeys.publicationsListAll(),
        ...PUBLICATION_COMPOSITION_KEYS(),
      ],
    }),
  ],
  'thought.reordered': [
    ruleFor<'thought.reordered'>({
      invalidate: (evt) => [
        queryKeys.focus(evt.data.owner_thought_id),
        ...NEIGHBOURHOOD_KEYS(),
        ...PUBLICATION_COMPOSITION_KEYS(),
      ],
    }),
  ],
  'link.created': [
    ruleFor<'link.created'>({
      patch: (evt) => put('link', evt.data.link.id, evt.data.link, evt),
      invalidate: (evt) => [
        queryKeys.focus(evt.data.link.source_id),
        queryKeys.focus(evt.data.link.target_id),
        ...NEIGHBOURHOOD_KEYS(),
        ...PUBLICATION_COMPOSITION_KEYS(),
      ],
    }),
  ],
  'link.updated': [
    ruleFor<'link.updated'>({
      patch: (evt) => patch('link', evt.data.id, evt.data.changes, evt, evt.data.version),
      invalidate: () => [...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'link.deleted': [
    ruleFor<'link.deleted'>({
      patch: (evt) => drop('link', evt.data.id),
      invalidate: () => [...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'comment.created': [
    ruleFor<'comment.created'>({
      patch: (evt) => put('comment', evt.data.comment.id, evt.data.comment, evt),
      invalidate: (evt) => [
        queryKeys.indicators(evt.data.comment.owner_id),
        queryKeys.chronicleFeedAll(),
        queryKeys.publicationAssemblyAll(),
      ],
    }),
  ],
  'comment.updated': [
    ruleFor<'comment.updated'>({
      patch: (evt) => patch('comment', evt.data.id, evt.data.changes, evt, evt.data.version),
      invalidate: (evt) => [
        queryKeys.indicatorsAll(),
        queryKeys.chronicleFeedAll(),
        // Блок документа образует только постоянный комментарий.
        ...(evt.data.kind === 'permanent' ? [queryKeys.publicationAssemblyAll()] : []),
      ],
    }),
  ],
  'comment.deleted': [
    ruleFor<'comment.deleted'>({
      patch: (evt) => drop('comment', evt.data.id),
      invalidate: (evt) => [
        queryKeys.indicators(evt.data.owner_id),
        queryKeys.chronicleFeedAll(),
        queryKeys.publicationAssemblyAll(),
      ],
    }),
  ],
  'attachment.created': [
    ruleFor<'attachment.created'>({
      patch: (evt) => put('attachment', evt.data.attachment.id, evt.data.attachment, evt),
      invalidate: (evt) => [
        queryKeys.indicators(evt.data.attachment.owner_id),
        queryKeys.attachments(evt.data.attachment.owner_type, evt.data.attachment.owner_id),
        queryKeys.focus(evt.data.attachment.owner_id),
      ],
    }),
  ],
  'attachment.updated': [
    ruleFor<'attachment.updated'>({
      patch: (evt) => patch('attachment', evt.data.id, evt.data.changes, evt),
      // Владелец события не гарантирован: после патча он берётся из
      // нормализованного кэша (списки вложений кладут туда записи), иначе —
      // широковещательно по всем спискам вложений.
      invalidate: (evt) => [queryKeys.indicatorsAll(), ...attachmentListKeys(evt.data.id)],
    }),
  ],
  'attachment.deleted': [
    // Порядок правил важен: сперва инвалидация по владельцу ИЗ КЭША (запись
    // ещё жива), затем удаление записи. Иначе владельца взять негде.
    ruleFor<'attachment.deleted'>({
      invalidate: (evt) => [queryKeys.indicatorsAll(), ...attachmentListKeys(evt.data.id)],
    }),
    ruleFor<'attachment.deleted'>({
      patch: (evt) => drop('attachment', evt.data.id),
    }),
  ],
  'property-value.set': [
    ruleFor<'property-value.set'>({
      invalidate: (evt) => [
        evt.data.owner_type === 'thought' ? queryKeys.focus(evt.data.owner_id) : queryKeys.focusAll(),
        ...NEIGHBOURHOOD_KEYS(),
        ...PUBLICATION_COMPOSITION_KEYS(),
      ],
    }),
  ],
  'property-value.deleted': [
    ruleFor<'property-value.deleted'>({
      invalidate: (evt) => [
        evt.data.owner_type === 'thought' ? queryKeys.focus(evt.data.owner_id) : queryKeys.focusAll(),
        ...NEIGHBOURHOOD_KEYS(),
        ...PUBLICATION_COMPOSITION_KEYS(),
      ],
    }),
  ],
  'user-preference.updated': [
    ruleFor<'user-preference.updated'>({
      invalidate: (evt) => {
        if (
          evt.data.key === 'show_inactive' ||
          evt.data.key === 'show_trash' ||
          evt.data.key === 'canvas_link_filter'
        ) {
          return [queryKeys.focusAll(), queryKeys.structuresPageAll()];
        }
        return [];
      },
    }),
  ],
  'user-focus-preferences.updated': [
    ruleFor<'user-focus-preferences.updated'>({
      invalidate: (evt) => [queryKeys.focus(evt.data.focus_thought_id)],
    }),
  ],
  'user-focus-order.updated': [
    ruleFor<'user-focus-order.updated'>({
      invalidate: (evt) => [queryKeys.focus(evt.data.focus_thought_id)],
    }),
  ],
  'saved-filter.created': [
    ruleFor<'saved-filter.created'>({ invalidate: () => [queryKeys.savedFiltersAll()] }),
  ],
  'saved-filter.updated': [
    ruleFor<'saved-filter.updated'>({ invalidate: () => [queryKeys.savedFiltersAll()] }),
  ],
  'saved-filter.deleted': [
    ruleFor<'saved-filter.deleted'>({ invalidate: () => [queryKeys.savedFiltersAll()] }),
  ],
  'pinned-thoughts.updated': [
    ruleFor<'pinned-thoughts.updated'>({
      patch: (evt) => {
        setQueryData(queryKeys.pins(), evt.data.ordered_ids);
        return [queryKeys.pins()];
      },
    }),
  ],
  'network.updated': [
    ruleFor<'network.updated'>({
      patch: (evt) => patch('network', evt.network_id, evt.data, evt),
    }),
  ],
  'layer.merged': [
    ruleFor<'layer.merged'>({
      invalidate: () => [
        queryKeys.layerOverrides(),
        queryKeys.focusAll(),
        queryKeys.structuresPageAll(),
        queryKeys.chronicleFeedAll(),
      ],
    }),
  ],
  'thought-type.created': [
    ruleFor<'thought-type.created'>({
      patch: (evt) => put('thought-type', evt.data.type.id, evt.data.type, evt),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'thought-type.updated': [
    ruleFor<'thought-type.updated'>({
      patch: (evt) => patch('thought-type', evt.data.id, evt.data.changes, evt, evt.data.version),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'thought-type.deleted': [
    ruleFor<'thought-type.deleted'>({
      patch: (evt) => drop('thought-type', evt.data.id),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'link-type.created': [
    ruleFor<'link-type.created'>({
      patch: (evt) => put('link-type', evt.data.type.id, evt.data.type, evt),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'link-type.updated': [
    ruleFor<'link-type.updated'>({
      patch: (evt) => patch('link-type', evt.data.id, evt.data.changes, evt, evt.data.version),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'link-type.deleted': [
    ruleFor<'link-type.deleted'>({
      patch: (evt) => drop('link-type', evt.data.id),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'property-definition.created': [
    ruleFor<'property-definition.created'>({
      patch: (evt) => put('property-definition', evt.data.definition.id, evt.data.definition, evt),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'property-definition.updated': [
    ruleFor<'property-definition.updated'>({
      patch: (evt) => patch('property-definition', evt.data.id, evt.data.changes, evt),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'property-definition.deleted': [
    ruleFor<'property-definition.deleted'>({
      patch: (evt) => drop('property-definition', evt.data.id),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'property-registry.created': [
    ruleFor<'property-registry.created'>({
      patch: (evt) => put('property-registry', evt.data.property.id, evt.data.property, evt),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'property-registry.updated': [
    ruleFor<'property-registry.updated'>({
      patch: (evt) => patch('property-registry', evt.data.id, evt.data.changes, evt),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'property-registry.deleted': [
    ruleFor<'property-registry.deleted'>({
      patch: (evt) => drop('property-registry', evt.data.id),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS(), ...PUBLICATION_COMPOSITION_KEYS()],
    }),
  ],
  'thought-type-view.created': [
    ruleFor<'thought-type-view.created'>({
      invalidate: (evt) => [queryKeys.views(evt.data.thought_type_id)],
    }),
  ],
  'thought-type-view.updated': [
    ruleFor<'thought-type-view.updated'>({
      invalidate: (evt) => [queryKeys.views(evt.data.thought_type_id)],
    }),
  ],
  'thought-type-view.deleted': [
    ruleFor<'thought-type-view.deleted'>({
      invalidate: (evt) => [queryKeys.views(evt.data.thought_type_id)],
    }),
  ],
  'publication.updated': [
    ruleFor<'publication.updated'>({
      patch: (evt) => patch('publication', evt.data.id, evt.data.changes, evt, evt.data.version),
      invalidate: (evt) => [
        queryKeys.publicationsListAll(),
        queryKeys.publicationCard(evt.data.id),
        queryKeys.publicationAssembly(evt.data.id),
      ],
    }),
  ],
  'publication.order.reordered': [
    ruleFor<'publication.order.reordered'>({
      invalidate: (evt) => [
        queryKeys.publicationAssembly(evt.data.publication_id),
        queryKeys.publicationsListAll(),
      ],
    }),
  ],
  'publication.exclusions.changed': [
    ruleFor<'publication.exclusions.changed'>({
      invalidate: (evt) => [queryKeys.publicationAssembly(evt.data.publication_id)],
    }),
  ],
  'publication.rebuilt': [
    ruleFor<'publication.rebuilt'>({
      patch: (evt) =>
        patch('publication', evt.data.publication_id, { assembly_date: evt.data.assembly_date }, evt),
      invalidate: (evt) => [
        queryKeys.publicationCard(evt.data.publication_id),
        queryKeys.publicationAssembly(evt.data.publication_id),
        queryKeys.publicationsListAll(),
      ],
    }),
  ],
  'publication.trashed': [
    ruleFor<'publication.trashed'>({
      patch: (evt) => drop('publication', evt.data.id),
      invalidate: (evt) => [
        queryKeys.publicationsListAll(),
        queryKeys.publicationCard(evt.data.id),
        queryKeys.publicationAssembly(evt.data.id),
      ],
    }),
  ],
  'publication.restored': [
    ruleFor<'publication.restored'>({
      invalidate: (evt) => [
        queryKeys.publicationsListAll(),
        queryKeys.publicationCard(evt.data.id),
        queryKeys.publicationAssembly(evt.data.id),
      ],
    }),
  ],
  'publication.purged': [
    ruleFor<'publication.purged'>({
      patch: (evt) => drop('publication', evt.data.id),
      invalidate: (evt) => [
        queryKeys.publicationsListAll(),
        queryKeys.publicationCard(evt.data.id),
        queryKeys.publicationAssembly(evt.data.id),
      ],
    }),
  ],
  'shelf.updated': [
    ruleFor<'shelf.updated'>({
      patch: (evt) => put('shelf', evt.data.shelf.id, evt.data.shelf, evt),
      invalidate: () => [queryKeys.shelves(), queryKeys.publicationsListAll()],
    }),
  ],
  'shelf.deleted': [
    ruleFor<'shelf.deleted'>({
      patch: (evt) => drop('shelf', evt.data.id),
      invalidate: () => [queryKeys.shelves(), queryKeys.publicationsListAll()],
    }),
  ],
};

/**
 * Типы событий, НАМЕРЕННО не влияющие на кэш слоя (замечание 4 верификатора).
 * Полнота таблицы относительно `REALTIME_EVENT_TYPES` проверяется сторожем
 * `guard-reactive-layer.test.ts`: каждый тип обязан быть либо в
 * {@link realtimeRoutes}, либо здесь.
 *
 * Почему игнорируются:
 *  - `network.deleted`, `member.*` — смена доступа/членства ведёт сессией вне
 *    слоя данных (закрытие вкладки/сети в `realtime.ts` и app-контроллере);
 *  - `presence.*` — присутствие не хранится в нормализованном кэше (сервер эти
 *    события вообще не эмитит: тип каталога зарезервирован под будущее);
 *  - `thought-view.updated` — журнал «просмотрено», не данные экранов;
 *  - `edit.*` — мягкие захваты объекта, живут в `lib/lock-cache.ts`;
 *  - `thought-type-view.run` — аудит исполнения отбора, клиент переисполняет
 *    отборы сам при смене режима.
 */
export const IGNORED_REALTIME_EVENT_TYPES: readonly RealtimeEventType[] = [
  'network.deleted',
  'member.added',
  'member.removed',
  'member.role_changed',
  'presence.joined',
  'presence.left',
  'presence.focus_changed',
  'thought-view.updated',
  'edit.acquired',
  'edit.released',
  'edit.cleared',
  'thought-type-view.run',
];

/** Быстрый поиск по {@link IGNORED_REALTIME_EVENT_TYPES}. */
const IGNORED_EVENT_TYPES: ReadonlySet<string> = new Set(IGNORED_REALTIME_EVENT_TYPES);

// ---------------------------------------------------------------------------
// Маршрутизация
// ---------------------------------------------------------------------------

/**
 * Слушатели просмотренных событий слоя (G6 техпроекта 269016e2).
 *
 * Единственный санкционированный канал для потребителей, которым нужен
 * ПОБОЧНЫЙ эффект события, не выражаемый ключом запроса: переопределения
 * объектов текущим слоем (`screens/layers.ts`) и эфемерный кэш мягких
 * захватов `edit.*` (`lib/lock-cache.ts`). Живут ЗА роутером: прямые подписки
 * `onRealtimeEvent` экранам запрещены сторожем (`guard-reactive-layer.test.ts`).
 *
 * Уведомляются только принятые события: прошедшие дедуп по seq либо намеренно
 * игнорируемые таблицей (`IGNORED_REALTIME_EVENT_TYPES`); чужие сети и
 * опоздавшие — нет.
 */
const routedListeners = new Set<(evt: AnyRealtimeEvent) => void>();

/** Подписаться на просмотренные роутером события; возвращает отписку. */
export function onRoutedRealtimeEvent(listener: (evt: AnyRealtimeEvent) => void): () => void {
  routedListeners.add(listener);
  return () => {
    routedListeners.delete(listener);
  };
}

/** Оповестить слушателей о принятом событии. */
function notifyRouted(evt: AnyRealtimeEvent): void {
  for (const listener of [...routedListeners]) listener(evt);
}

/** Последний обработанный seq по сети (дедуп опоздавших событий). */
const lastSeqByNetwork = new Map<string, number>();

/** Сбросить состояние дедупа (смена сети, тесты). */
export function resetEventRouter(): void {
  lastSeqByNetwork.clear();
}

/**
 * Пропустить одно realtime-событие через таблицу: дедуп по seq, патч кэша,
 * инвалидация ключей. Возвращает {@link RouteResult} — в том числе для тестов
 * паритета, доказывающих, что маршрут гасит ровно ожидаемые ключи.
 */
export function routeRealtimeEvent(evt: AnyRealtimeEvent, ctx: RouteContext = {}): RouteResult {
  if (ctx.networkId !== undefined && ctx.networkId !== null && evt.network_id !== ctx.networkId) {
    return { routed: false, reason: 'foreign', invalidated: [], patched: [] };
  }
  const rules = realtimeRoutes[evt.type];
  if (rules === undefined) {
    const reason = IGNORED_EVENT_TYPES.has(evt.type) ? 'ignored' : 'unknown';
    // Намеренно игнорируемые типы (например, `edit.*` замков) всё равно
    // доходят до слушателей слоя: у них есть побочные эффекты без ключей.
    if (reason === 'ignored') notifyRouted(evt);
    return { routed: false, reason, invalidated: [], patched: [] };
  }
  const last = lastSeqByNetwork.get(evt.network_id);
  if (last !== undefined && evt.seq <= last) {
    return { routed: false, reason: 'stale', invalidated: [], patched: [] };
  }
  lastSeqByNetwork.set(evt.network_id, evt.seq);

  const patched: string[] = [];
  const invalidated: string[] = [];
  for (const rule of rules) {
    if (rule.patch !== undefined) patched.push(...rule.patch(evt));
    if (rule.invalidate !== undefined) {
      // Причина инвалидации — само событие: наблюдатели (открытый документ
      // публикации) по ней решают, точечная это правка блока или смена состава.
      for (const prefix of rule.invalidate(evt)) invalidated.push(...invalidateQueries(prefix, evt));
    }
  }

  notifyRouted(evt);
  return {
    routed: true,
    invalidated: [...new Set(invalidated)].sort(),
    patched: [...new Set(patched)],
  };
}
