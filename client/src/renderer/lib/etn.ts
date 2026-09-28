/**
 * Typed access to the preload bridge. `window.etn` is declared in
 * `src/env.d.ts`; this module re-exports it under a short name for the
 * renderer — the renderer never touches the network directly.
 *
 * IMPORTANT: the export is a **live Proxy** that reads `window.etn` on every
 * property access, not a snapshot taken at module-import time. In Vite dev
 * (ESM, lazy module evaluation) a static `export const etn = window.etn` can
 * capture `undefined` if this module is evaluated a tick before the
 * `contextBridge` exposes the API; the Proxy sidesteps that race entirely.
 *
 * The public surface is the renderer-facing {@link EtnApi}. The raw bridge is
 * {@link EtnBridgeApi} — it differs in the cancellable `structures.query` /
 * `queryIds` (ошибка b7cbd0e0): `AbortSignal` is a host object and does NOT
 * survive `contextBridge` argument serialization (it arrives in preload as an
 * empty `{}`). So the `abort` listener lives HERE, in the renderer context
 * where the signal is real, and only a primitive `requestId` crosses the
 * bridge; `cancelRequest(requestId)` is a fire-and-forget message to main.
 * This module is where the two shapes are adapted, so every call site keeps
 * the stable `structures.query(networkId, request, { signal })` signature.
 *
 * The `typeof window` guard keeps the module importable from Node unit tests.
 */

import { EtnError } from '@etn/shared';

import {
  isIpcErrorEnvelope,
  type IpcErrorEnvelope,
} from '../../main/ipc/contract.js';
import type { EtnApi, EtnBridgeApi } from '../../main/ipc/contract.js';

/**
 * Восстановить ошибку из {@link IpcErrorEnvelope} в КОНТЕКСТЕ RENDERER
 * (ошибка f14962ca). `contextBridge` теряет кастомные свойства ошибок, поэтому
 * `EtnError` c `code`/`details` собирается здесь: только в этом контексте
 * `instanceof EtnError` и `err.details` снова работают для UI-веток (диалог
 * подтверждения смены родителя, `LOCKED`, `VERSION_CONFLICT`).
 */
function reviveIpcError(error: IpcErrorEnvelope['error']): Error {
  if (error.code !== undefined) {
    return new EtnError(error.code, error.message, error.details, error.request_id);
  }
  const revived = new Error(error.message);
  if (error.name !== '') revived.name = error.name;
  return revived;
}

/** Конверт ошибки превратить в брошенную ошибку; обычный результат — как есть. */
function unwrapIpcResult<T>(value: T): T {
  if (isIpcErrorEnvelope(value)) throw reviveIpcError(value.error);
  return value;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Обернуть неймспейс моста так, чтобы его методы возвращали результат,
 * очищенный от конвертов ошибок: main отдаёт отказ плоским объектом
 * ({@link IpcErrorEnvelope}), а renderer бросает восстановленный `EtnError`.
 */
function withIpcErrorRevival<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        const result = (value as (...a: unknown[]) => unknown).apply(obj, args);
        return isThenable(result) ? result.then(unwrapIpcResult) : result;
      };
    },
  }) as T;
}

/**
 * Resolves the current `window.etn` lazily. `lib/etn.ts` is imported by the
 * renderer modules as well as Node unit tests; the renderer always has
 * `window` defined (preload runs first), but the test harness may not.
 * Looking up `window` on every property access keeps the Proxy correct in
 * both worlds without imposing a load-order constraint on the test
 * bootstrap.
 */
function readWindow(): { etn?: EtnBridgeApi } | null {
  if (typeof window === 'undefined') {
    return (globalThis as { etn?: EtnBridgeApi }).etn !== undefined
      ? (globalThis as unknown as { etn?: EtnBridgeApi })
      : null;
  }
  return window as unknown as { etn?: EtnBridgeApi };
}

/**
 * Renderer-side adapter for the cancellable bridge calls (требование
 * ebed4980, ошибка b7cbd0e0). Registers the `abort` listener on the REAL
 * signal here and hands the bridge a primitive `requestId`; on abort it calls
 * `cancel(requestId)`. Without a signal the call stays uncancellable and no
 * `requestId` is sent. After the promise settles the listener is removed, so a
 * late abort does not fire a stale cancellation.
 */
function callCancellable<T>(
  call: (requestId: string | undefined) => Promise<T>,
  cancel: (requestId: string) => void,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return call(undefined);
  if (signal.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  const requestId = crypto.randomUUID();
  const onAbort = (): void => cancel(requestId);
  signal.addEventListener('abort', onAbort, { once: true });
  return call(requestId).finally(() => signal.removeEventListener('abort', onAbort));
}

/**
 * Builds the renderer-facing `structures` facade from the raw bridge: the
 * cancellable methods get the signal→requestId adapter, the rest pass through
 * unchanged.
 */
function structuresFacade(bridge: EtnBridgeApi): EtnApi['structures'] {
  return {
    query: (networkId, request, options) =>
      callCancellable(
        (requestId) => bridge.structures.query(networkId, request, requestId),
        (requestId) => bridge.cancelRequest(requestId),
        options?.signal,
      ),
    queryIds: (networkId, request, options) =>
      callCancellable(
        (requestId) => bridge.structures.queryIds(networkId, request, requestId),
        (requestId) => bridge.cancelRequest(requestId),
        options?.signal,
      ),
    hierarchy: (networkId, thoughtId, query) =>
      bridge.structures.hierarchy(networkId, thoughtId, query),
    edges: (networkId, ids, showInactive) =>
      bridge.structures.edges(networkId, ids, showInactive),
  };
}

export const etn: EtnApi = new Proxy(
  // The target is never actually read — every access forwards to `window.etn`.
  {} as EtnApi,
  {
    get(_target, prop: string) {
      const w = readWindow();
      const api = w?.etn;
      if (!api) {
        throw new Error(
          `window.etn is not available yet (accessed .${prop} too early). ` +
            'Ensure the preload script has loaded.',
        );
      }
      if (prop === 'structures') return withIpcErrorRevival(structuresFacade(api));
      const value = (api as unknown as Record<string, unknown>)[prop];
      // Неймспейсы оборачиваем, чтобы их методы восстанавливали `EtnError`
      // из конверта ошибки (f14962ca); скаляры/промисы без обёртки отдаём как есть.
      return typeof value === 'object' && value !== null
        ? withIpcErrorRevival(value as object)
        : value;
    },
  },
) as EtnApi;
