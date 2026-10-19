/**
 * Deep-link receiver (task R11, docs/12-wiki-id-refs.md §7.4).
 *
 * The renderer side of the `etn://open?…` protocol. The main process sends an
 * `etn:deep-link` IPC event with `{ networkId, thoughtId }` whenever the user
 * opens such a URL — either at cold start, via `second-instance`, or via
 * `open-url` (macOS). This handler:
 *
 *  1. Switches the active network to `networkId` via {@link openNetwork}.
 *  2. Tries to focus the thought (canvas / structures / chronicle — same
 *     rules as the in-app `openThoughtByRef` path).
 *  3. Surfaces failures as a toast: «Сеть недоступна», «Мысль удалена» or
 *     a generic load error.
 *
 * Wired once from `client/src/renderer/main.ts`.
 */

import type { DeepLinkPayload } from '../../main/ipc/contract.js';

import { openNetwork, requireNetworkId, setFocus } from '../app.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';
import { openPublicationInWorkspace } from '../screens/active-view.js';

let wired = false;

/**
 * Прикладные операции, нужные обработчику deep-link. Выделены в интерфейс,
 * чтобы холодный старт проверялся интеграционно: `applyDeepLink` прогоняется
 * на подставных операциях, в том числе с целью, отличной от HOME.
 */
export interface DeepLinkDeps {
  currentNetworkId: () => string | null;
  openNetwork: (networkId: string) => Promise<void>;
  getThought: (
    networkId: string,
    thoughtId: string,
  ) => Promise<{ id: string; active: boolean }>;
  setFocus: (id: string) => Promise<void>;
  showInactive: () => boolean;
  notice: (text: string, kind: 'error') => void;
  getPublication: (networkId: string, publicationId: string) => Promise<unknown>;
  openPublicationInWorkspace: (publicationId: string) => Promise<void>;
}

/** Installs the `etn:deep-link` listener (call once from `main.ts`). */
export function initDeepLinkHandler(): void {
  if (wired) return;
  wired = true;
  etn.deepLink.onDeepLink((link) => {
    void handleDeepLink(link);
  });
}

/**
 * Сообщает главному процессу, что приложение готово принимать холодные
 * deep-link'и (ошибка d8b81425). Вызывать ТОЛЬКО после `await boot()`:
 * `boot → restoreSession → openNetwork` восстанавливает сохранённый фокус и
 * перекрыл бы `setFocus` цели, если буфер слить раньше.
 */
export function signalDeepLinkReady(): void {
  etn.deepLink.signalReady();
}

/**
 * Запуск приёма deep-link с жёстким порядком: подписка → `await boot()` → ack.
 * Вынесено ради интеграционного теста холодного старта (ошибка d8b81425):
 * если ack уйдёт раньше восстановления сессии, `openNetwork` перекроет
 * `setFocus` цели сохранённым фокусом.
 */
export async function startDeepLinks(
  bootApp: () => Promise<void>,
  subscribe: () => void = initDeepLinkHandler,
  ready: () => void | Promise<void> = signalDeepLinkReady,
): Promise<void> {
  subscribe();
  await bootApp();
  await ready();
}

async function handleDeepLink(link: DeepLinkPayload): Promise<void> {
  await applyDeepLink(link, {
    currentNetworkId: safeCurrentNetworkId,
    openNetwork,
    getThought: (networkId, thoughtId) => etn.thoughts.get(networkId, thoughtId),
    setFocus,
    showInactive: () => store.state.showInactive,
    notice,
    getPublication: (networkId, publicationId) =>
      etn.publications.get(networkId, publicationId),
    openPublicationInWorkspace,
  });
}

/**
 * Применяет deep-link к уже загруженному приложению. Чистая оркестрация над
 * {@link DeepLinkDeps} — вызывается после boot, поэтому восстановление сессии
 * не может перекрыть фокус цели.
 */
export async function applyDeepLink(
  link: DeepLinkPayload,
  deps: DeepLinkDeps,
): Promise<void> {
  // 1. Switch to the target network if needed.
  if (deps.currentNetworkId() !== link.networkId) {
    try {
      await deps.openNetwork(link.networkId);
    } catch (err) {
      deps.notice(`Сеть недоступна: ${errToText(err)}`, 'error');
      return;
    }
  }

  // 2. Публикация (0.11.1, задача 3275fd8d, требование 7f583ef9): открыть её
  //    в рабочей области экрана «Публикации».
  if ('publicationId' in link) {
    try {
      await deps.getPublication(link.networkId, link.publicationId);
    } catch (err) {
      deps.notice(`Публикация удалена или недоступна: ${errToText(err)}`, 'error');
      return;
    }
    await deps.openPublicationInWorkspace(link.publicationId);
    return;
  }

  // 3. Try to fetch + open the thought.
  let thought;
  try {
    thought = await deps.getThought(link.networkId, link.thoughtId);
  } catch (err) {
    deps.notice(`Мысль удалена или недоступна: ${errToText(err)}`, 'error');
    return;
  }

  if (!thought.active && !deps.showInactive()) {
    deps.notice(
      'Не могу открыть неактуальную мысль — неактуальные мысли не отображаются.',
      'error',
    );
    return;
  }

  // 3. Place the focus — `setFocus` is the canvas view's idempotent operation
  //    that updates the store and refreshes the screen. We don't route through
  //    `openThoughtByRef` because the latter is opinionated about the active
  //    view; a deep-link should always go to the canvas (the user's natural
  //    landing surface).
  await deps.setFocus(thought.id);
}

function safeCurrentNetworkId(): string | null {
  try {
    return requireNetworkId();
  } catch {
    return null;
  }
}

function errToText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'unknown error';
}
