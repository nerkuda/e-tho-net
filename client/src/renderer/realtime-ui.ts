/**
 * Realtime event application to the UI (G8 client side, H-phase):
 *
 * - thought/link changes near the current focus → debounced re-focus (the
 *   canvas/editor re-render from server truth);
 * - comment/attachment changes → indicator cache invalidation;
 * - `thought.deleted` → local history re-render (the main-process applier has
 *   already pruned the focus history);
 * - L3 user-scoped events (`show_inactive`, focus preferences/order) → store
 *   update + refresh;
 * - `network.updated` → patch the network meta in the store.
 *
 * Registered as a realtime listener in `app.boot`.
 */

import { PREF_KEY, parseStoredCanvasLinkFilter, type AnyRealtimeEvent } from '@etn/shared';

import { resyncAfterLayerSwitch, scheduleRefresh } from './app.js';
import { invalidateIndicators, invalidateRef } from './canvas/canvas.js';
import { onThoughtTypeViewRealtime } from './canvas/focus-filter-strip.js';
import { etn } from './lib/etn.js';
import { invalidateHistoryBar } from './screens/history-bar.js';
import { invalidatePinnedBar, invalidatePinnedRef } from './screens/pinned-bar.js';
import { invalidateSavedFilters } from './screens/structures/filter-panel.js';
import {
  applyChronicleRealtime,
  invalidateChronicleThought,
  scheduleChronicleRefresh,
} from './screens/chronicle/chronicle.js';
import { reloadSavedFilters as reloadChronicleSavedFilters } from './screens/chronicle/filter-panel.js';
import { store } from './state.js';
import { syncLayersForTab } from './screens/layers.js';
import { invalidateWikiLinkCache } from './editor/wiki-link-resolver.js';
import { applyPublicationsRealtime, applyPublicationDocumentRealtime, applyPublicationThoughtRealtime, applyPublicationCompositionRealtime } from './screens/publications/publications.js';

/**
 * Tiny wrapper so the inline call sites above stay readable. Drops the cached
 * entry for a thought across all networks — the resolver repaints on the
 * next view render.
 */
function invalidateWikiLinkCacheById(thoughtId: string): void {
  invalidateWikiLinkCache(thoughtId);
}

/**
 * Reloads both type catalogues into the store (L21 — the hierarchy changed).
 *
 * Параллельные перезапросы (одно realtime-событие о типе уведомляет несколько
 * слушателей, и редактору нужен именно ОБНОВЛЁННЫЙ каталог) делят один запрос:
 * пока перезапрос в полёте, повторный вызов возвращает тот же промис. Так
 * потребитель может дождаться свежего каталога, не порождая второй запрос.
 */
export function reloadTypeCatalogues(): Promise<void> {
  if (typeCataloguesReload !== null) return typeCataloguesReload;
  const pending = (async () => {
    const networkId = store.state.networkId;
    if (networkId === null) return;
    try {
      const [thoughtTypes, linkTypes] = await Promise.all([
        etn.types.listThoughtTypes(networkId),
        etn.types.listLinkTypes(networkId),
      ]);
      store.update({ thoughtTypes, linkTypes });
    } catch {
      // The network may have just been closed — ignore.
    }
  })().finally(() => {
    typeCataloguesReload = null;
  });
  typeCataloguesReload = pending;
  return pending;
}

/** In-flight перезапрос каталогов (см. {@link reloadTypeCatalogues}). */
let typeCataloguesReload: Promise<void> | null = null;

/** True when the thought id participates in the current focus neighbourhood. */
export function inNeighbourhood(id: string): boolean {
  const focus = store.state.focus;
  if (focus === null) return false;
  return (
    focus.focused.id === id ||
    focus.parents.some((n) => n.id === id) ||
    focus.children.some((n) => n.id === id) ||
    focus.siblings.some((n) => n.id === id)
  );
}

/**
 * Виден ли владелец значения в текущей окрестности фокуса: мысль — сам фокус
 * или его сосед, связь — ребро этой окрестности (`focus.edges`). Локальные
 * производители (сохранение значения свойства-связи) по этому признаку решают,
 * нужен ли пересчёт холста: правка невидимой сущности карту не меняет, и
 * перечитывать окрестность из-за неё не нужно (ошибка f0b959dd).
 */
export function inFocusNeighbourhood(
  ownerType: 'thought' | 'link',
  ownerId: string,
): boolean {
  const focus = store.state.focus;
  if (focus === null) return false;
  return ownerType === 'thought'
    ? inNeighbourhood(ownerId)
    : focus.edges.some((edge) => edge.id === ownerId);
}

/** Applies one accepted realtime event to the UI state. */
export function applyRealtimeToUi(evt: AnyRealtimeEvent): void {
  // Шину событий слушают все открытые вкладки-сети разом, а этот обработчик
  // правит ОБЩИЙ store (активную вкладку): событие чужой сети не должно
  // пересчитывать её окрестность/панели (ошибка f0b959dd — realtime-путь
  // изменения значений свойств-связей обязан уважать границу сети).
  if (evt.network_id !== store.state.networkId) return;
  switch (evt.type) {
    case 'thought.deleted':
      // Открытый документ публикации: состав не меняем на лету — помечаем
      // «Пересобрать» устаревшим (замечание А2 приёмки b02ef1cf).
      applyPublicationCompositionRealtime();
      invalidateIndicators(evt.data.id);
      invalidateRef(evt.data.id);
      invalidateHistoryBar();
      // «Структуры» гасят свой ключ `structures-page` роутером (G2) и убирают
      // строку полным перезапросом; «Дневник» перезапрашивает ленту, если
      // мысль была чипсом загруженной записи.
      invalidateChronicleThought(evt.data.id);
      // R7: drop cached wiki-link titles for the deleted thought so any
      // visible ID-based link switches to the «deleted» muted style.
      invalidateWikiLinkCacheById(evt.data.id);
      // The pin row cascades on the server (FK ON DELETE CASCADE) without a
      // `pinned-thoughts.updated` event — drop the chip locally (L18).
      if (store.state.pins.includes(evt.data.id)) {
        store.update({ pins: store.state.pins.filter((id) => id !== evt.data.id) });
      }
      if (inNeighbourhood(evt.data.id)) scheduleRefresh();
      // Удалённая мысль могла быть строкой отбора, а не соседом фокуса — нижнюю
      // зону перерисовывает подписчик холста на инвалидациях слоя (ошибка
      // 4fca95c9, G2).
      break;

    case 'thought.created':
      // Новая мысль может войти в отбор — состав не трогаем, помечаем пересборку.
      applyPublicationCompositionRealtime();
      // Слой данных (G2): окрестность фокуса перечитывается по инвалидации
      // роутера (`focusAll`), нижняя зона — подписчиком холста на инвалидации
      // (`onQueryInvalidated`), «Структуры» — подпиской на `structures-page`.
      // Ручных вызовов пересчёта здесь больше нет — всё решает слой.
      scheduleChronicleRefresh();
      break;

    case 'thought.updated':
      // Мысль В текущей сборке — точечное обновление её блока + пометка
      // устаревания (заголовок влияет на отбор); вне — ничего (замечание 2
      // приёмки b02ef1cf).
      applyPublicationThoughtRealtime(evt.data.id, evt.data.changes);
      invalidateRef(evt.data.id);
      // A pinned chip mirrors the thought's title/icon/styles — refresh it.
      if (store.state.pins.includes(evt.data.id)) {
        invalidatePinnedRef(evt.data.id);
        invalidatePinnedBar();
      }
      // R7: refresh wiki-link view-resolver cache for the renamed thought so
      // existing ID-based links in view-mode re-render with the new title.
      invalidateWikiLinkCacheById(evt.data.id);
      if (inNeighbourhood(evt.data.id)) scheduleRefresh();
      // «Структуры» обновляют снимок полным перезапросом по инвалидации
      // роутера (G2), «Дневник» перезапрашивает ленту — чипсы показывают
      // заголовки мыслей.
      scheduleChronicleRefresh();
      // Правка мысли, видимой только строкой отбора (заголовок/тип/актуальность)
      // — нижнюю зону перерисовывает подписчик холста на инвалидациях слоя
      // (ошибка 4fca95c9, G2).
      break;

    // Свойство-СВЯЗЬ меняет рёбра на сервере (структурные «Родители»/
    // «Потомки», типизированные, «Свойства вне типа»), скаляр — нет; набор
    // пересчёта для обоих событий один и тот же — окрестность фокуса
    // (прецедент 270b8454: тот же набор, что у правок типов связи).
    case 'thought.reordered':
    case 'link.created':
    case 'property-value.set':
    case 'property-value.deleted':
      // Состав публикации: пометка пересборки (замечание А2 приёмки b02ef1cf).
      applyPublicationCompositionRealtime();
      // Слой данных (G2): окрестность фокуса гасит роутер (`focusAll`), нижняя
      // зона — подписчик холста на инвалидации, «Структуры» — подписка на
      // `structures-page`. Здесь остаётся обновление «Хроники».
      scheduleChronicleRefresh();
      break;

    // Ребро уже нарисовано на «Структурах» — правка оформления применяется
    // точечно к `edges` и линиям; смена концов/активности ребра уходит в полный
    // путь (см. таблицу в structures.ts). Холст перечитывает окрестность;
    // «Дневник» перезапрашивает ленту (чипсы связей показывают их подписи).
    case 'link.updated':
    case 'link.deleted':
      // Ребро может быть строкообразующим для состава публикации — пометка.
      applyPublicationCompositionRealtime();
      // Слой данных (G2): окрестность фокуса перечитывает роутер (`focusAll`),
      // «Структуры» — подписка на `structures-page`; «Дневник» перезапрашивает
      // ленту.
      scheduleChronicleRefresh();
      break;

    case 'comment.created':
      // Comments are sub-objects of a thought/link and do NOT change the
      // focus response (parents/children/siblings/edges). Schedule a focus
      // refresh here and the editor would re-render on every comment write
      // anywhere in the neighbourhood — bug 206e33a1 «Бессмысленное
      // обновление редактора при получении внешних событий»: typing in the
      // comment field of an open thought would lose its in-progress edit to a
      // focus-refresh round-trip on every remote comment event. The editor
      // subscribes to `comment.*` itself and updates the open entity's
      // comment view in place; the canvas indicator below the cloud was
      // already invalidated by `invalidateIndicators`.
      invalidateIndicators(evt.data.comment.owner_id);
      applyChronicleRealtime(evt);
      // Блок документа публикации образует ТОЛЬКО постоянный комментарий мысли;
      // хроно-записи документ не меняют — игнорируем их (блокер приёмки
      // b02ef1cf: правка хроно-комментария подменяла текст блока).
      if (evt.data.comment.kind === 'permanent') {
        applyPublicationDocumentRealtime(evt.data.comment.owner_id, evt.data.comment.body_md, 'permanent');
      }
      break;

    case 'comment.deleted':
      // Same reasoning as `comment.created`: never refresh focus for
      // comment events. The canvas indicator cache is invalidated above; the
      // editor's comment view is patched by its own listener.
      invalidateIndicators(evt.data.owner_id);
      applyChronicleRealtime(evt);
      applyPublicationDocumentRealtime(evt.data.owner_id);
      break;

    case 'comment.updated':
      // Same reasoning as `comment.created`/`comment.deleted`: never refresh
      // focus. The comment body lives on the entity, not in the focus
      // neighbourhood. The editor owns the comment view for its open entity
      // and updates it in place via its own `onRealtimeEvent` hook.
      invalidateIndicators(null);
      applyChronicleRealtime(evt);
      // Только постоянный комментарий образует блок документа; `kind` пришёл в
      // payload (блокер приёмки b02ef1cf) — правку хроно-записи игнорируем,
      // чтобы не подменить текст блока.
      if (evt.data.kind === 'permanent') {
        applyPublicationDocumentRealtime(evt.data.owner_id, evt.data.changes.body_md, 'permanent');
      }
      break;

    case 'attachment.created':
      // Вложения — подобъекты сущности и фокус-ответ не меняют (см. rationale
      // ниже). Сам факт создания в окрестности фокуса освежает холст; вкладку
      // «Вложения» открытого редактора обновляет его собственный realtime-хук
      // (editor.ts, гейт по показанной сущности — ошибка abd25adb).
      invalidateIndicators(evt.data.attachment.owner_id);
      if (inNeighbourhood(evt.data.attachment.owner_id)) scheduleRefresh();
      break;

    case 'attachment.updated':
    case 'attachment.deleted':
      // Same reasoning as `comment.*` (see above): attachments are
      // sub-objects of a thought/link and never change the focus response.
      // Calling `scheduleRefresh` here forced an unrelated store update on
      // every remote attachment write, which in turn fired the editor's
      // `store.subscribe` callback — bug 206e33a1. The canvas indicator
      // cache is invalidated; the open editor's «Вложения» tab updates itself
      // through its own realtime hook in editor.ts (ошибка abd25adb), which
      // resolves the owner of these ownerless events from the list index.
      invalidateIndicators(null);
      break;

    case 'user-preference.updated':
      if (evt.data.key === 'show_inactive') {
        store.update({ showInactive: evt.data.value === true });
        // Фокус и «Структуры» гасит роутер (`focusAll` / `structures-page`).
      } else if (evt.data.key === PREF_KEY.SHOW_TRASH) {
        // «Показывать содержимое корзины» (77923b49) — правка другого клиента:
        // карта и «Структуры» перечитываются по инвалидации роутера.
        store.update({ showTrash: evt.data.value !== false });
      } else if (evt.data.key === PREF_KEY.CANVAS_LINK_FILTER) {
        // Another client (or the filter dialog itself) changed the canvas
        // link-type filter (0.8.1) — pick up the new value; окрестность
        // перечитает роутер (`focusAll`) против уже обновлённой настройки.
        store.update({ canvasLinkFilter: parseStoredCanvasLinkFilter(evt.data.value) });
      }
      break;

    case 'user-focus-preferences.updated':
    case 'user-focus-order.updated':
      // Роутер гасит `focus:@<focus_thought_id>` — активная окрестность
      // перезапросится слоем (G2); ручной вызов не нужен.
      break;

    case 'saved-filter.created':
    case 'saved-filter.updated':
    case 'saved-filter.deleted':
      // The user's other client changed a saved filter (audience=user) — the
      // local lists re-sync from the server (§15.3, §17).
      invalidateSavedFilters();
      void reloadChronicleSavedFilters();
      break;

    case 'pinned-thoughts.updated':
      // The user's other client changed the pinned list (audience=user) — the
      // event carries the full new order (L18, 08-ui-spec.md §16).
      store.update({ pins: evt.data.ordered_ids });
      break;

    // Публикации и полки (0.11.1, задача a3cfc018): библиотека перечитывает
    // список с дебаунсом; карточку публикации в панели редактора обновляет её
    // собственный подписчик (`editor/publication-card.ts`).
    case 'publication.updated':
    case 'publication.order.reordered':
    case 'publication.exclusions.changed':
    case 'publication.rebuilt':
    case 'publication.trashed':
    case 'publication.restored':
    case 'publication.purged':
    case 'shelf.updated':
    case 'shelf.deleted':
      applyPublicationsRealtime(evt.type, evt.data);
      break;

    case 'thought-type.created':
    case 'thought-type.updated':
    case 'thought-type.deleted':
    case 'link-type.created':
    case 'link-type.updated':
    case 'link-type.deleted':
    case 'property-definition.created':
    case 'property-definition.updated':
    case 'property-definition.deleted':
      // Another client changed the type catalogues (L21): reload both lists
      // and repaint everything that renders type styles/names. Типы и
      // определения свойств входят в условия отбора — та же пометка пересборки.
      // Слой данных (G2): окрестность фокуса и «Структуры» гасит роутер
      // (`focusAll` / `structures-page`), «Хроника» — рядом.
      applyPublicationCompositionRealtime();
      void reloadTypeCatalogues();
      scheduleChronicleRefresh();
      break;

    case 'thought-type-view.created':
    case 'thought-type-view.updated':
    case 'thought-type-view.deleted':
      // The type-view strip (task 02ba2ae7, spec 9984aa98) is the primary
      // consumer. `thought-type-view.run` is a non-branchable audit event
      // and intentionally ignored here — the UI re-runs views itself when
      // the mode changes.
      onThoughtTypeViewRealtime({
        type: evt.type,
        thought_type_id: evt.data.thought_type_id,
        // `created` carries the new view under `data.view.id`; `updated` and
        // `deleted` carry `data.view_id` directly.
        view_id:
          'view_id' in evt.data
            ? evt.data.view_id
            : (evt.data.view?.id ?? ''),
      });
      break;

    case 'network.updated': {
      const network = store.state.network;
      if (network !== null) store.update({ network: { ...network, ...evt.data } });
      break;
    }

    case 'layer.merged': {
      // S11 (04-realtime.md §11.4): a merge emits exactly one event and the
      // recipients resync fully — the visible state changed wholesale, so
      // re-read layers/overrides and drop the cached editor/structures
      // snapshots (13-layers.md §12: a layer change invalidates the whole
      // client cache, not just the canvas).
      const networkId = store.state.networkId;
      if (networkId !== null) {
        void syncLayersForTab(networkId, store.state.currentLayer?.id ?? null).then(() => {
          void resyncAfterLayerSwitch();
          scheduleChronicleRefresh();
        });
      }
      break;
    }

    default:
      break;
  }
}
