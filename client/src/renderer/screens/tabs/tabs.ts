/**
 * Tab strip host (08-ui-spec.md §1.1, workplan Q3).
 *
 * Renders the tab strip into the workspace top row. Reads tabs from the store
 * and re-renders on changes. Wires:
 *  - tab click → `etn.tabs.activate(tabId)` (Q4 turns this into a full
 *    snapshot hydration);
 *  - "✕" click → `etn.tabs.close(tabId)`;
 *  - "+" click → opens the in-workspace network picker overlay (so the tab
 *    strip stays visible — clicking another tab or picking a network closes
 *    it);
 *  - pointer-gesture drag-reorder among the **visible** tabs (overflow tabs
 *    are not draggable in v1, see Q3 DoD).
 */
import { div, el, setTooltip, span } from '../../lib/dom.js';
import { svgIcon } from '../../lib/icons.js';
import { etn } from '../../lib/etn.js';
import { store } from '../../state.js';
import type { TabDto } from '../../../main/ipc/contract.js';
import { clearTabDirty, removeTab, upsertTab } from './tab-state.js';
import {
  buildOverflowButton,
  recomputeOverflow,
  type StripElements,
} from './tab-overflow.js';
import { wireTabDrag } from './tab-dnd.js';

const TAB_W_DEFAULT_PX = 180;
const TAB_W_MIN_PX = 120;

/**
 * Mounts the tab strip into `host`. Returns the root element so the caller
 * (workspace.ts) can wire global listeners.
 */
export function mountTabStrip(host: HTMLElement): HTMLDivElement {
  const root = div('tab-strip');
  host.append(root);

  const elements: StripElements = {
    root,
    visible: [],
    hidden: [],
    plusButton: el('button', 'tab tab-plus') as HTMLButtonElement,
    overflowButton: null,
  };

  elements.plusButton.type = 'button';
  elements.plusButton.title = 'Открыть сеть';
  elements.plusButton.append(svgIcon('plus', 14));
  elements.plusButton.addEventListener('click', () => {
    // In-workspace picker overlay (Q-bugfix): the tab strip stays visible
    // above the overlay, so clicking another tab or «+» again cancels.
    store.update({ pickerOpen: true });
  });
  root.append(elements.plusButton);

  const overflowBtn = el('button', 'tab-overflow hidden') as HTMLButtonElement;
  overflowBtn.type = 'button';
  overflowBtn.hidden = true;
  root.append(overflowBtn);
  elements.overflowButton = overflowBtn;

  const observer = new ResizeObserver(() => {
    recomputeOverflow(elements, TAB_W_DEFAULT_PX, TAB_W_MIN_PX);
  });
  observer.observe(root);

  store.subscribe(() => render(elements));

  render(elements);
  wireTabDrag(root, (orderedIds) => {
    void onReorder(orderedIds);
  });
  void refreshTabs();

  return root;
}

/** Pulls the latest tab list from main and merges into the store. */
export async function refreshTabs(): Promise<void> {
  try {
    const tabs = await etn.tabs.list();
    store.update({ tabs });
  } catch {
    // Disconnected — store keeps its current tabs.
  }
}

/** Re-renders the strip based on the current `store.tabs`. */
function render(elements: StripElements): void {
  const tabs = store.state.tabs;
  const activeId = store.state.activeTabId;
  const dirty = store.state.dirtyTabIds;
  const inaccessible = store.state.inaccessibleTabIds;
  const pickerOpen = store.state.pickerOpen;

  // Clear existing tab buttons (keep + and overflow).
  for (const button of elements.visible) {
    button.remove();
  }
  elements.visible = [];

  for (const tab of tabs) {
    const button = buildTabButton(tab, {
      // Hide the active-tab highlight while the picker is open — the «+»
      // button carries the focus instead.
      active: !pickerOpen && tab.tab_id === activeId,
      dirty: dirty.has(tab.tab_id),
      inaccessible: inaccessible.has(tab.tab_id),
    });
    elements.visible.push(button);
    elements.root.insertBefore(button, elements.plusButton);
  }

  // The «+» mirrors the picker's open state with a pressed look.
  elements.plusButton.classList.toggle('tab-active', pickerOpen);

  recomputeOverflow(elements, TAB_W_DEFAULT_PX, TAB_W_MIN_PX);
  if (elements.overflowButton !== null) {
    buildOverflowButton(
      elements.overflowButton,
      elements.hidden,
      async (tabId: string) => {
        await activateTab(tabId);
      },
      async (tabId: string) => {
        await closeTab(tabId);
      },
    );
  }
}

/** Builds the button element for one tab. */
function buildTabButton(
  tab: TabDto,
  flags: { active: boolean; dirty: boolean; inaccessible: boolean },
): HTMLButtonElement {
  const button = el('button', 'tab') as HTMLButtonElement;
  button.type = 'button';
  button.dataset['tabId'] = tab.tab_id;
  if (flags.active) button.classList.add('tab-active');
  if (flags.inaccessible) button.classList.add('tab-inaccessible');
  if (flags.dirty) button.classList.add('tab-dirty');

  const label = networkLabel(tab.network_id);
  const title = el('span', 'tab-title', label);
  if (flags.dirty) title.prepend(span('* ', 'tab-marker'));

  const closeBtn = el('button', 'tab-close') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.title = 'Закрыть таб';
  closeBtn.append(svgIcon('x', 12));
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    void closeTab(tab.tab_id);
  });

  button.append(title, closeBtn);
  button.addEventListener('click', () => {
    void activateTab(tab.tab_id);
  });
  setTooltip(button, flags.inaccessible ? 'Сеть недоступна' : label);
  return button;
}

/**
 * Human label for a tab — the network's `display_name` if known, else a
 * truncated network id (during the brief window before `networkList` is
 * populated, e.g. right after boot).
 */
function networkLabel(networkId: string): string {
  const found = store.state.networkList.find((n) => n.id === networkId);
  if (found !== undefined) return found.display_name;
  return networkId.length <= 8 ? networkId : `${networkId.slice(0, 8)}…`;
}

/** Activates a tab; delegates to IPC and lets Q4 wire snapshot hydration. */
async function activateTab(tabId: string): Promise<void> {
  // Picking any tab closes the picker — the user opened it via «+», clicking
  // elsewhere (including the «+» again) is their way to dismiss.
  store.update({ pickerOpen: false });
  try {
    const tab = await etn.tabs.activate(tabId);
    if (tab === null) return;
    upsertTab(tab);
    store.update({ activeTabId: tab.tab_id });
    // Q4: activation clears the dirty marker (08-ui-spec.md §1.1).
    clearTabDirty(tabId);
  } catch {
    // ignore — status bar / log
  }
}

/** Closes a tab via IPC and removes it from the store. */
async function closeTab(tabId: string): Promise<void> {
  try {
    await etn.tabs.close(tabId);
  } finally {
    removeTab(tabId);
  }
}

/**
 * Reorder handler invoked by the DnD module on commit. The drag layer has
 * already updated DOM order — we send the new id order to main and re-fetch.
 */
async function onReorder(orderedIds: string[]): Promise<void> {
  try {
    await etn.tabs.reorder(orderedIds);
    await refreshTabs();
  } catch {
    // best effort — UI keeps current order
  }
}
