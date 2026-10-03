/**
 * Производные эффекты realtime-событий (G6 техпроекта 269016e2).
 *
 * Заменяет снесённый гигантский `switch` из `realtime-ui.ts`. ДАННЫЕ экранов
 * живут в слое (`lib/live`): роутер (`event-router.ts`) гасит ключи запросов и
 * патчит нормализованный кэш, реестр перезапрашивает активных подписчиков.
 * Здесь остаётся только то, что НЕ выражается ключом запроса:
 *
 *  - **производные срезы store** — `showInactive`/`showTrash`/`canvasLinkFilter`
 *    (`user-preference.updated`), зеркало списка закреплённых (`pinned-thoughts.updated`),
 *    мета сети (`network.updated`);
 *  - **бесхитростные кэши UI** — ref-кэш холста (`invalidateRef`), панель истории
 *    (`invalidateHistoryBar`);
 *  - **перечитывания окрестности** через debounced `scheduleRefresh()` для
 *    событий, затронувших мысль/вложение ТЕКУЩЕЙ окрестности (как и до G6);
 *  - **каталоги типов** — роутер гасит `types-catalog`, подписчики ключа
 *    перечитывают сами; здесь дублируем вызов для экранов без редактора
 *    (перезапрос дедуплицируется в полёте, `lib/type-catalogues.ts`);
 *  - **полный ре-синк после слияния слоёв** (`layer.merged`).
 *
 * Регистрируется как realtime-слушатель в `app.boot` (единственный мост).
 */

import { PREF_KEY, parseStoredCanvasLinkFilter, type AnyRealtimeEvent } from '@etn/shared';

import { resyncAfterLayerSwitch, scheduleRefresh } from './app.js';
import { invalidateRef } from './canvas/canvas.js';
import { inNeighbourhood } from './lib/focus-neighbourhood.js';
import { reloadTypeCatalogues } from './lib/type-catalogues.js';
import { invalidateHistoryBar } from './screens/history-bar.js';
import { syncLayersForTab } from './screens/layers.js';
import { store } from './state.js';

/**
 * Применяет производные эффекты одного принятого realtime-события.
 *
 * Вызывается ПОСЛЕ `routeRealtimeEvent` (шина `realtime.ts`): роутер уже
 * погасил ключи и синхронно уведомил подписчиков инвалидаций, поэтому
 * дублирующие перечитывания дедуплицируются в полёте.
 */
export function applyDerivedRealtime(evt: AnyRealtimeEvent): void {
  // Шину событий слушают все открытые вкладки-сети разом, а этот обработчик
  // правит ОБЩИЙ store (активную вкладку): событие чужой сети не должно
  // пересчитывать её окрестность/панели (ошибка f0b959dd — realtime-путь
  // изменения значений свойств-связей обязан уважать границу сети).
  if (evt.network_id !== store.state.networkId) return;
  switch (evt.type) {
    case 'thought.deleted':
      // Ref-кэш холста и панель истории — бесхитростные кэши вне слоя.
      invalidateRef(evt.data.id);
      invalidateHistoryBar();
      // The pin row cascades on the server (FK ON DELETE CASCADE) without a
      // `pinned-thoughts.updated` event — drop the chip locally (L18). Срез
      // слоя `pins` панель перечитает сама (роутер гасит ключ `pins`).
      if (store.state.pins.includes(evt.data.id)) {
        store.update({ pins: store.state.pins.filter((id) => id !== evt.data.id) });
      }
      if (inNeighbourhood(evt.data.id)) scheduleRefresh();
      break;

    case 'thought.updated':
      invalidateRef(evt.data.id);
      if (inNeighbourhood(evt.data.id)) scheduleRefresh();
      break;

    case 'attachment.created':
      // Вложения — подобъекты сущности и фокус-ответ не меняют, но появление
      // вложения в окрестности фокуса освежает холст (индикатор — слой).
      if (inNeighbourhood(evt.data.attachment.owner_id)) scheduleRefresh();
      break;

    case 'user-preference.updated':
      if (evt.data.key === 'show_inactive') {
        store.update({ showInactive: evt.data.value === true });
      } else if (evt.data.key === PREF_KEY.SHOW_TRASH) {
        store.update({ showTrash: evt.data.value !== false });
      } else if (evt.data.key === PREF_KEY.CANVAS_LINK_FILTER) {
        store.update({ canvasLinkFilter: parseStoredCanvasLinkFilter(evt.data.value) });
      }
      break;

    case 'pinned-thoughts.updated':
      // Список ведёт сервер (L18): зеркало store — для легаси-потребителей
      // (кнопка пина в редакторе, обрезка при удалении); срез слоя `pins`
      // патчит роутер.
      store.update({ pins: evt.data.ordered_ids });
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
      // Другой клиент изменил каталоги типов (L21): перечитать списки, чтобы
      // экраны без открытого редактора (холст, «Структуры», панель пинов)
      // увидели новые имена/оформление. Перезапрос дедуплицируется в полёте.
      void reloadTypeCatalogues();
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
        });
      }
      break;
    }

    default:
      break;
  }
}
