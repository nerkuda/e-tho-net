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

import { patchEntity, putEntity, removeEntity, type EntityKind } from './entities.js';
import { queryKeys } from './query-keys.js';
import { invalidateQueries, setQueryData } from './query-registry.js';

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
  /** Почему не обработано: опоздавшее, неизвестный тип, чужая сеть. */
  reason?: 'stale' | 'unknown' | 'foreign';
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

function put(kind: EntityKind, id: string, entity: unknown, evt: AnyRealtimeEvent): string[] {
  putEntity(kind, id, entity, { seq: evt.seq });
  return [`${kind}:${id}`];
}

function patch(
  kind: EntityKind,
  id: string,
  changes: unknown,
  evt: AnyRealtimeEvent,
  version?: number,
): string[] {
  patchEntity(kind, id, asPatch(changes), { seq: evt.seq, version });
  return [`${kind}:${id}`];
}

function drop(kind: EntityKind, id: string): string[] {
  removeEntity(kind, id);
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
        queryKeys.indicators(evt.data.thought.id),
      ],
    }),
  ],
  'thought.updated': [
    ruleFor<'thought.updated'>({
      patch: (evt) => patch('thought', evt.data.id, evt.data.changes, evt, evt.data.version),
      invalidate: (evt) => [
        queryKeys.focus(evt.data.id),
        queryKeys.structuresPageAll(),
        queryKeys.chronicleFeedAll(),
        queryKeys.pins(),
        queryKeys.publicationAssemblyAll(),
      ],
    }),
  ],
  'thought.deleted': [
    ruleFor<'thought.deleted'>({
      patch: (evt) => drop('thought', evt.data.id),
      invalidate: (evt) => [
        queryKeys.focus(evt.data.id),
        queryKeys.structuresPageAll(),
        queryKeys.chronicleFeedAll(),
        queryKeys.history(),
        queryKeys.pins(),
        queryKeys.indicators(evt.data.id),
        queryKeys.publicationsListAll(),
      ],
    }),
  ],
  'thought.reordered': [
    ruleFor<'thought.reordered'>({
      invalidate: (evt) => [queryKeys.focus(evt.data.owner_thought_id), ...NEIGHBOURHOOD_KEYS()],
    }),
  ],
  'link.created': [
    ruleFor<'link.created'>({
      patch: (evt) => put('link', evt.data.link.id, evt.data.link, evt),
      invalidate: (evt) => [
        queryKeys.focus(evt.data.link.source_id),
        queryKeys.focus(evt.data.link.target_id),
        ...NEIGHBOURHOOD_KEYS(),
      ],
    }),
  ],
  'link.updated': [
    ruleFor<'link.updated'>({
      patch: (evt) => patch('link', evt.data.id, evt.data.changes, evt, evt.data.version),
      invalidate: () => NEIGHBOURHOOD_KEYS(),
    }),
  ],
  'link.deleted': [
    ruleFor<'link.deleted'>({
      patch: (evt) => drop('link', evt.data.id),
      invalidate: () => NEIGHBOURHOOD_KEYS(),
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
      // Владелец в payload не гарантирован — сбрасываем все списки вложений.
      invalidate: () => [queryKeys.indicatorsAll(), queryKeys.attachmentsAll()],
    }),
  ],
  'attachment.deleted': [
    ruleFor<'attachment.deleted'>({
      patch: (evt) => drop('attachment', evt.data.id),
      invalidate: () => [queryKeys.indicatorsAll(), queryKeys.attachmentsAll()],
    }),
  ],
  'property-value.set': [
    ruleFor<'property-value.set'>({
      invalidate: (evt) => [
        evt.data.owner_type === 'thought' ? queryKeys.focus(evt.data.owner_id) : queryKeys.focusAll(),
        ...NEIGHBOURHOOD_KEYS(),
      ],
    }),
  ],
  'property-value.deleted': [
    ruleFor<'property-value.deleted'>({
      invalidate: (evt) => [
        evt.data.owner_type === 'thought' ? queryKeys.focus(evt.data.owner_id) : queryKeys.focusAll(),
        ...NEIGHBOURHOOD_KEYS(),
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
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS()],
    }),
  ],
  'thought-type.updated': [
    ruleFor<'thought-type.updated'>({
      patch: (evt) => patch('thought-type', evt.data.id, evt.data.changes, evt, evt.data.version),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS()],
    }),
  ],
  'thought-type.deleted': [
    ruleFor<'thought-type.deleted'>({
      patch: (evt) => drop('thought-type', evt.data.id),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS()],
    }),
  ],
  'link-type.created': [
    ruleFor<'link-type.created'>({
      patch: (evt) => put('link-type', evt.data.type.id, evt.data.type, evt),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS()],
    }),
  ],
  'link-type.updated': [
    ruleFor<'link-type.updated'>({
      patch: (evt) => patch('link-type', evt.data.id, evt.data.changes, evt, evt.data.version),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS()],
    }),
  ],
  'link-type.deleted': [
    ruleFor<'link-type.deleted'>({
      patch: (evt) => drop('link-type', evt.data.id),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS()],
    }),
  ],
  'property-definition.created': [
    ruleFor<'property-definition.created'>({
      patch: (evt) => put('property-definition', evt.data.definition.id, evt.data.definition, evt),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS()],
    }),
  ],
  'property-definition.updated': [
    ruleFor<'property-definition.updated'>({
      patch: (evt) => patch('property-definition', evt.data.id, evt.data.changes, evt),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS()],
    }),
  ],
  'property-definition.deleted': [
    ruleFor<'property-definition.deleted'>({
      patch: (evt) => drop('property-definition', evt.data.id),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS()],
    }),
  ],
  'property-registry.created': [
    ruleFor<'property-registry.created'>({
      patch: (evt) => put('property-registry', evt.data.property.id, evt.data.property, evt),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS()],
    }),
  ],
  'property-registry.updated': [
    ruleFor<'property-registry.updated'>({
      patch: (evt) => patch('property-registry', evt.data.id, evt.data.changes, evt),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS()],
    }),
  ],
  'property-registry.deleted': [
    ruleFor<'property-registry.deleted'>({
      patch: (evt) => drop('property-registry', evt.data.id),
      invalidate: () => [queryKeys.typesCatalog(), ...NEIGHBOURHOOD_KEYS()],
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

// ---------------------------------------------------------------------------
// Маршрутизация
// ---------------------------------------------------------------------------

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
    return { routed: false, reason: 'unknown', invalidated: [], patched: [] };
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
      for (const prefix of rule.invalidate(evt)) invalidated.push(...invalidateQueries(prefix));
    }
  }

  return {
    routed: true,
    invalidated: [...new Set(invalidated)].sort(),
    patched: [...new Set(patched)],
  };
}
