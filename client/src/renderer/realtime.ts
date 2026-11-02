/**
 * Realtime wiring for the renderer (G8/H-phase).
 *
 * Subscribes to `etn.realtime.*` and funnels events into the store:
 *  - status → `rtStatus` (🟢/🟡/🔴 indicator, H19 offline blocking);
 *  - events → narrowed via {@link isRealtimeEvent}, described for the status
 *    bar, then routed through the data layer (`routeRealtimeEvent`) and the
 *    single derived-effects bridge (`effects.onEventApplied`);
 *  - `resume.stale` → full re-focus request;
 *  - derived effects: `focus-lost` (focused thought deleted) and
 *    `network-lost` (network deleted or self removed from members).
 *
 * B1 техпроекта 269016e2: сервер шлёт событие и автору (broadcast-to-all),
 * main-forward'ит все принятые события — сюда доходят и СОБСТВЕННЫЕ правки.
 * Идемпотентность держит слой (`lib/live`): дедуп по seq/версии сущности и
 * буферизация событий сущности с optimistic-мутацией в полёте.
 */

import type { AnyRealtimeEvent } from '@etn/shared';
import type { ServerMaintenanceDto } from '../main/ipc/contract.js';

import { etn } from './lib/etn.js';
import { routeRealtimeEvent } from './lib/live/event-router.js';
import { toast } from './lib/notice.js';
import { describeEvent, isRealtimeEvent } from './lib/pure.js';
import { activeServerMaintenanceText } from './lib/server-maintenance-text.js';
import {
  getRtStatus,
  store,
  type RtStatus,
  type RtStatusDetail,
} from './state.js';
import { markTabDirty } from './screens/tabs/tab-state.js';
import { onNetworkLost } from './screens/tabs/tab-accessibility.js';

/** Application-level effect callbacks (registered by the app controller). */
export interface RealtimeEffects {
  /** `resume.stale` — the local event stream is behind; full re-focus needed. */
  onStale: () => void;
  /** The currently focused thought was deleted server-side. */
  onFocusLost: () => void;
  /** The open network is gone or the user lost membership. */
  onNetworkLost: () => void;
  /** The session's layer changed server-side (S11): switched by another tab of
   * this client or deleted — the whole visible state must be re-synced. */
  onLayerControl: (payload: { kind: 'switched' | 'deleted'; networkId: string; layer: { id: string; title: string } }) => void;
  /**
   * Принятое событие прошло роутер слоя (G6 техпроекта 269016e2). Единственная
   * точка производных эффектов, не выражаемых ключом запроса (store-срезы,
   * ref-кэш холста, панель истории, перечитывание каталогов типов). Регистрирует
   * `app.ts` (`applyDerivedRealtime`) — прямые подписки на шину вне этого моста
   * запрещены сторожем `guard-reactive-layer.test.ts`.
   */
  onEventApplied: (evt: AnyRealtimeEvent) => void;
}

const effects: RealtimeEffects = {
  onStale: () => undefined,
  onFocusLost: () => undefined,
  onNetworkLost: () => undefined,
  onLayerControl: () => undefined,
  onEventApplied: () => undefined,
};

let initialized = false;
let hideTimer: number | null = null;
/** Networks whose `resume.stale` arrived while they were not active. */
const staleNetworks = new Set<string>();

/** How long the "last event" text stays in the status bar, ms (08-ui-spec.md §11). */
const EVENT_TEXT_TTL_MS = 5_000;

/**
 * Registers/overrides the derived-effect callbacks (stale/focus-lost/
 * network-lost). Call at any time; subscriptions are created once.
 */
export function setRealtimeEffects(next: Partial<RealtimeEffects>): void {
  Object.assign(effects, next);
}

/**
 * Known visual qualifiers of a realtime status. Unknown values from IPC are
 * dropped rather than rendered as someone else's detail.
 * `server-maintenance` — сервер на обслуживании (close 1012, 12fd5b0e); текст
 * для него добавляет задача 479e37ed, до тех пор показывается текст статуса.
 */
const STATUS_DETAILS: readonly RtStatusDetail[] = ['server-restart', 'server-maintenance'];

/** Narrows an IPC `detail` value to a known {@link RtStatusDetail}. */
export function toRtStatusDetail(value: unknown): RtStatusDetail | null {
  return typeof value === 'string' && (STATUS_DETAILS as readonly string[]).includes(value)
    ? (value as RtStatusDetail)
    : null;
}

/**
 * Pulls the per-network status snapshot and merges it into the store
 * (defect de34b35b). Called at init, again after the profile is connected
 * (the pool appears only then, so the cold-start snapshot is empty) and after
 * a network is opened. Missing `getStatuses` (partial test bridges) is a no-op.
 */
export async function refreshRealtimeStatuses(): Promise<void> {
  const getStatuses = etn.realtime.getStatuses;
  if (typeof getStatuses !== 'function') return;
  try {
    const snapshot = await getStatuses.call(etn.realtime);
    const valid: RtStatus[] = [
      'idle',
      'connecting',
      'connected',
      'reconnecting',
      'offline',
      'suspect',
    ];
    const map = { ...store.state.rtStatusByNetwork };
    const details = { ...store.state.rtStatusDetailByNetwork };
    for (const entry of snapshot) {
      if (!valid.includes(entry.status as RtStatus)) continue;
      map[entry.networkId] = entry.status as RtStatus;
      const detail = toRtStatusDetail(entry.detail);
      if (detail !== null) details[entry.networkId] = detail;
      else delete details[entry.networkId];
    }
    store.update({
      rtStatusByNetwork: map,
      rtStatusDetailByNetwork: details,
      rtStatus: getRtStatus({ ...store.state, rtStatusByNetwork: map }),
    });
  } catch {
    // Snapshot is best-effort: broadcast statuses still fill the map.
  }
}

/**
 * Приводит состояние обслуживания сервера (задача 479e37ed) к состоянию из
 * main и один раз объявляет ПЕРЕХОД в обслуживание тостом: это важное
 * событие доступности сервера (решение 28d22b8a — тост, не статусбар).
 * Повторные кадры/статусы того же обслуживания тост не дублируют.
 */
function applyServerMaintenance(dto: ServerMaintenanceDto): void {
  if (dto.active !== true) {
    if (store.state.serverMaintenance !== null) store.update({ serverMaintenance: null });
    return;
  }
  const retry =
    typeof dto.retry_after === 'number' && Number.isFinite(dto.retry_after) && dto.retry_after > 0
      ? Math.ceil(dto.retry_after)
      : undefined;
  const next: ServerMaintenanceDto = {
    active: true,
    ...(retry === undefined ? {} : { retry_after: retry }),
    target_version: dto.target_version ?? null,
  };
  const wasActive = store.state.serverMaintenance !== null;
  store.update({ serverMaintenance: next });
  if (!wasActive) toast(activeServerMaintenanceText(next), 'warning');
}

/**
 * Забирает текущее состояние обслуживания сервера (задача 479e37ed) — при
 * старте и после подключения профиля, не дожидаясь первого кадра/статуса.
 * Ошибка IPC здесь не критична: канал `realtime:maintenance` догонит состояние.
 */
export async function refreshServerMaintenance(): Promise<void> {
  try {
    applyServerMaintenance(await etn.realtime.getMaintenance());
  } catch {
    // Состояние — украшение статуса, а не источник данных: молча оставляем
    // прежнее значение, следующий кадр/статус его обновит.
  }
}

/** Connects the realtime bridge. Called once at boot. */
export function initRealtime(): void {
  if (initialized) return;
  initialized = true;

  // Network is back after an outage (defect 7f4cef31): tell main so it can
  // force-reconnect the realtime sockets immediately — a socket that survived
  // the outage half-open would otherwise sit deaf until the idle watchdog
  // fires (~100 s) or forever, if no close frame ever arrives.
  window.addEventListener('online', () => etn.realtime.notifyOnline());

  // Status is per network (defect de34b35b): keep the full map + the visual
  // detail, and recompute the ACTIVE network's status on every change and on
  // every tab switch (subscription below).
  etn.realtime.onStatusChange((payload) => {
    const valid: RtStatus[] = [
      'idle',
      'connecting',
      'connected',
      'reconnecting',
      'offline',
      'suspect',
    ];
    const obj = payload as { networkId?: unknown; status?: unknown; detail?: unknown };
    const networkId = typeof obj.networkId === 'string' ? obj.networkId : null;
    const statusStr = typeof obj.status === 'string' ? obj.status : null;
    if (networkId === null || statusStr === null) return;
    // Unknown status is ignored (the previous value stays) — never silently
    // converted into a red «Нет связи» (de34b35b).
    if (!valid.includes(statusStr as RtStatus)) return;
    const next = statusStr as RtStatus;
    const map = { ...store.state.rtStatusByNetwork, [networkId]: next };
    const details = { ...store.state.rtStatusDetailByNetwork };
    const detail = toRtStatusDetail(obj.detail);
    if (detail !== null) details[networkId] = detail;
    else delete details[networkId];
    store.update({
      rtStatusByNetwork: map,
      rtStatusDetailByNetwork: details,
      rtStatus: getRtStatus({ ...store.state, rtStatusByNetwork: map }),
    });
  });

  // Обслуживание сервера (задача 479e37ed): единое состояние на подключение.
  // Кадр `maintenance` и `503 SERVER_UPDATING` приходят из main одним каналом;
  // `active: false` — восстановление подтверждено (`GET /me` / открытие сокета).
  etn.realtime.onMaintenance((payload) => {
    const obj = payload as { active?: unknown; retry_after?: unknown; target_version?: unknown };
    applyServerMaintenance({
      active: obj.active === true,
      ...(typeof obj.retry_after === 'number' ? { retry_after: obj.retry_after } : {}),
      target_version: typeof obj.target_version === 'string' ? obj.target_version : null,
    });
  });

  // Initial pull (the snapshot is empty at cold start because the pool is
  // created later, after `etn.server.connect`; `refreshRealtimeStatuses()` is
  // called again right after connecting / opening a network).
  void refreshRealtimeStatuses();
  void refreshServerMaintenance();

  // Tab switch → recompute the active status from the per-network map. The
  // guard against rewriting the same network makes the subscription
  // non-recursive.
  let lastNetworkId = store.state.networkId;
  store.subscribe(() => {
    const networkId = store.state.networkId;
    if (networkId !== lastNetworkId) {
      lastNetworkId = networkId;
      const next = getRtStatus(store.state);
      if (next !== store.state.rtStatus) store.update({ rtStatus: next });
      // A stale event for this network arrived while it was inactive — the
      // event is not lost, the visible state is re-read on activation.
      if (networkId !== null && staleNetworks.delete(networkId)) effects.onStale();
      return;
    }
    // Even without a switch, another network's event may have moved the
    // effective status (fallback path uses `rtStatus`).
    const derived = getRtStatus(store.state);
    if (derived !== store.state.rtStatus) store.update({ rtStatus: derived });
  });

  etn.realtime.onStale((payload) => {
    // Q2: payload is `{networkId, lastSeq}` from TabRealtimePool.
    const obj = payload as { networkId?: unknown; lastSeq?: unknown };
    const networkId = typeof obj.networkId === 'string' ? obj.networkId : null;
    if (networkId === null) return;
    if (networkId === store.state.networkId) {
      // Active network: full visible resync (defect de34b35b).
      effects.onStale();
      return;
    }
    // Inactive network: do not lose the event. Mark its tabs as needing a
    // refresh and re-read on activation.
    staleNetworks.add(networkId);
    for (const tab of store.state.tabs) {
      if (tab.network_id === networkId) markTabDirty(tab.tab_id);
    }
  });

  // Q5: realtime WS closed with 4401 (unauthorized) or 4404 (not-found) for a
  // specific network. Mark every tab of that network as inaccessible and drop
  // back to the networks list when the active network is affected.
  etn.realtime.onNetworkLost((payload) => {
    const obj = payload as { networkId?: unknown; reason?: unknown };
    const networkId = typeof obj.networkId === 'string' ? obj.networkId : null;
    if (networkId === null) return;
    onNetworkLost(networkId);
    if (networkId === store.state.networkId) {
      effects.onNetworkLost();
    }
  });

  // S11 (13-layers.md §12, §2.4): the server switched this session's layer
  // (another tab of this client did it, or the layer was deleted) — the
  // cached visible state no longer matches, so delegate the resync to the app
  // controller.
  etn.realtime.onLayerControl((payload) => {
    const obj = payload as { kind?: unknown; networkId?: unknown; layer?: unknown };
    const networkId = typeof obj.networkId === 'string' ? obj.networkId : null;
    if (networkId === null) return;
    if (obj.kind !== 'switched' && obj.kind !== 'deleted') return;
    const layerObj = obj.layer as { id?: unknown; title?: unknown } | undefined;
    if (layerObj === undefined || typeof layerObj.id !== 'string') return;
    effects.onLayerControl({
      kind: obj.kind,
      networkId,
      layer: { id: layerObj.id, title: String(layerObj.title ?? '') },
    });
  });

  etn.realtime.onEvent((raw: unknown) => {
    if (!isRealtimeEvent(raw)) return;
    const evt = raw;
    store.update({ lastEvent: describeEvent(evt) });
    scheduleEventHide();

    // Q4: mark every tab whose network received this event with a dirty
    // marker «*». The active tab also gets the marker (cleared on activation).
    const networkId = evt.network_id;
    for (const tab of store.state.tabs) {
      if (tab.network_id === networkId) markTabDirty(tab.tab_id);
    }

    // Derived effects (04-realtime.md §7, G8 applier contracts).
    if (evt.type === 'thought.deleted' && store.state.focus?.focused.id === evt.data.id) {
      effects.onFocusLost();
    }
    if (evt.type === 'network.deleted') {
      effects.onNetworkLost();
    }
    if (evt.type === 'member.removed' && store.state.me?.id === evt.data.user_id) {
      effects.onNetworkLost();
    }
    // Реактивный слой данных (269016e2): событие идёт декларативным роутером —
    // он патчит нормализованный кэш и гасит ключи запросов (границу сети
    // уважает переданный networkId). Производные эффекты, не выражаемые ключом,
    // применяет мост `effects.onEventApplied` (G6; прежний switch снесён).
    routeRealtimeEvent(evt, { networkId: store.state.networkId });
    effects.onEventApplied(evt);
  });
}

/** Hides the status-bar event text after the TTL. */
function scheduleEventHide(): void {
  if (hideTimer !== null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    store.update({ lastEvent: null });
    hideTimer = null;
  }, EVENT_TEXT_TTL_MS);
}

/** True when the ACTIVE network's realtime connection is up (H19: saves allowed). */
export function isConnected(): boolean {
  return getRtStatus(store.state) === 'connected';
}
