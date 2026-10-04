/**
 * Shared workspace view switcher (L15/L20, 08-ui-spec.md §15.1, §17).
 *
 * `setActiveView` is the single entry point for switching between the map,
 * structures and chronicle views: it updates the store, persists the L4
 * `active_view` key and lazily initialises the target view (the structures and
 * chronicle modules keep their own per-network state).
 */

import { UI_STATE_KEY } from '@etn/shared';

import { etn } from '../lib/etn.js';
import { store, type WorkspaceView } from '../state.js';
import { ensureActivityInitialised } from './activity/activity.js';
import { ensureStructuresInitialised } from './structures/structures.js';
import { ensureChronicleInitialised } from './chronicle/chronicle.js';
import {
  ensurePublicationsInitialised,
  openPublicationWorkspace,
} from './publications/publications.js';
import type { PublicationOpenTarget } from './publications/workspace.js';

/** Switches the workspace view and persists the L4 `active_view` key per tab. */
export function setActiveView(view: WorkspaceView): void {
  if (store.state.activeView === view) return;
  store.update({ activeView: view });
  const networkId = store.state.networkId;
  const tabId = store.state.activeTabId;
  // Q4: prefer per-tab persistence (`etn.tabs.updateState`); fall back to the
  // legacy `ui_state` key only if there's no active tab (legacy migration).
  if (tabId !== null) {
    void etn.tabs.updateState(tabId, { view_mode: view }).catch(() => undefined);
  } else if (networkId !== null) {
    void etn.ui.setState(networkId, UI_STATE_KEY.ACTIVE_VIEW, view).catch(() => undefined);
  }
  if (view === 'structures') void ensureStructuresInitialised();
  if (view === 'chronicle') void ensureChronicleInitialised();
  if (view === 'activity') void ensureActivityInitialised();
  if (view === 'publications') void ensurePublicationsInitialised();
}

/**
 * Единый путь команды «В фокус»: показать экран «Карта мыслей» и поставить в
 * фокус эту мысль (спецификация «Контекстное меню мысли», 08-ui-spec.md §17).
 *
 * Смена фокуса без переключения вида незаметна, если пользователь находится на
 * другом экране («Структуры», «Хроника», «События»), — команда обязана всегда
 * приводить к результату (ошибка 562356a9). Вызывают её оба входа меню мысли:
 * подменю «Действия ▾» шапки редактора и контекстное меню облачка (мини-облачко
 * таблицы свойств, пилюля локального графа) — общий помощник, а не копии пары
 * «setActiveView + setFocus», иначе входы расходятся.
 *
 * На самой карте `setActiveView('map')` — no-op (`setActiveView` выходит сразу,
 * если вид уже этот), поэтому лишних переключений и перерисовок не возникает.
 */
export async function focusThoughtOnMap(id: string): Promise<void> {
  setActiveView('map');
  // Ленивый импорт: статический замкнул бы цикл app → … → active-view.
  const { setFocus } = await import('../app.js');
  await setFocus(id);
}

/**
 * Единый путь «открыть публикацию» из любого места клиента (0.11.1, задача
 * 3275fd8d): переключить экран на «Публикации» и открыть в рабочей области
 * чтения конкретную публикацию. `target` задаёт страницу сборки и якорь
 * блока (переход из группы «Упоминания»). Используют ссылки `[[#pub:]]` в
 * комментариях, значения свойства «Публикация» и deep-link `?publication=`.
 */
export async function openPublicationInWorkspace(
  id: string,
  target?: PublicationOpenTarget,
): Promise<void> {
  setActiveView('publications');
  await ensurePublicationsInitialised();
  await openPublicationWorkspace(id, target);
}
