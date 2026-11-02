/**
 * Screen manager: owns the `#app` root and swaps onboarding / networks /
 * workspace screens (H1 layout, H2 onboarding, H3 network list).
 *
 * **Живая смена языка** (задача e6374cd1): экран — это функция от языка, поэтому
 * смена языка пересобирает ТЕКУЩИЙ экран через `showScreen(store.state.screen)`.
 * Подписка ровно ОДНА: каждая пересборка снимает прежнюю и ставит новую, а
 * teardown экрана не оставляет висящих обработчиков — иначе после смены сети
 * перерисовки дублировались бы (ошибка 37b713de — тот же класс).
 */

import { clear } from '../lib/dom.js';
import { onLangChange } from '../lib/i18n.js';
import { store, type Screen } from '../state.js';
import { buildOnboarding } from './onboarding.js';
import { buildNetworks } from './networks.js';
import { buildWorkspace, teardownWorkspace } from './workspace.js';

let root: HTMLElement | null = null;

/** Снятие текущей подписки на смену языка; `null` — подписки нет. */
let langTeardown: (() => void) | null = null;

/** Mounts the screen root. Called once at boot. */
export function initScreens(rootEl: HTMLElement): void {
  root = rootEl;
}

/**
 * Ставит единственную подписку на смену языка. Прежняя снимается ПЕРЕД новой:
 * `showScreen` вызывается и из слушателя, поэтому без снятия подписки
 * накапливались бы и экран пересобирался N раз.
 */
function resubscribeLang(): void {
  langTeardown?.();
  langTeardown = onLangChange(() => {
    if (root === null) return;
    // Текущий экран пересобирается целиком: его тексты (включая подписи панелей
    // и диалогов, созданных модулями экрана) снова берутся из словаря. Открытые
    // диалоги живут вне корня экрана — их обновляет `lib/dialog.ts`.
    showScreen(store.state.screen);
  });
}

/** Switches the visible screen, tearing down the previous one. */
export function showScreen(screen: Screen): void {
  if (root === null) throw new Error('initScreens was not called');
  // The workspace modules (canvas, editor, bars, views) register global
  // store subscriptions/observers; release them BEFORE wiping the DOM so they
  // do not accumulate across network opens / tab switches (ошибка 37b713de).
  teardownWorkspace();
  clear(root);
  switch (screen) {
    case 'onboarding':
      root.append(buildOnboarding());
      break;
    case 'networks':
      root.append(buildNetworks());
      break;
    case 'workspace':
      root.append(buildWorkspace());
      break;
  }
  store.update({ screen });
  resubscribeLang();
}
