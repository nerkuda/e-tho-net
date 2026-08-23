/**
 * Overflow computation for the tab strip (08-ui-spec.md §1.1, workplan Q3).
 *
 * The tab strip is a flex row of fixed-width tab buttons (default 180 px,
 * shrinks to 120 px on narrow windows). When the row doesn't fit, trailing
 * tabs collapse into a `[▾N]` dropdown button positioned to the right of the
 * "+" — "+" and the overflow button are always visible.
 *
 * The DnD layer (`tab-dnd.ts`) operates only on the **visible** set; hidden
 * tabs can be activated or closed via the dropdown but not reordered in v1.
 */
import { el } from '../../lib/dom.js';
import type { TabDto } from '../../../main/ipc/contract.js';
import { store } from '../../state.js';

/** Live DOM state of the tab strip, kept by {@link mountTabStrip}. */
export interface StripElements {
  /** Root `<div class="tab-strip">` container. */
  root: HTMLDivElement;
  /** Visible tab buttons (DOM order, latest). */
  visible: HTMLButtonElement[];
  /** Hidden tabs (sub-array of `store.tabs` that don't fit in the row). */
  hidden: TabDto[];
  /** Always-visible "+" button. */
  plusButton: HTMLButtonElement;
  /** `[▾N]` overflow button (null when nothing is hidden). */
  overflowButton: HTMLButtonElement | null;
}

/**
 * Lays out the strip so visible tabs plus "+" plus the overflow button fit in
 * `root.clientWidth`. Toggles each tab's `hidden` attribute; rebuilds
 * `elements.hidden` and shows/hides the overflow button.
 */
export function recomputeOverflow(
  elements: StripElements,
  defaultTabWidth: number,
  minTabWidth: number,
): void {
  const root = elements.root;
  if (root.clientWidth === 0) return;

  const reserveForPlus = elements.plusButton.getBoundingClientRect().width || 32;
  const overflowBtn = elements.overflowButton;
  const reserveForOverflow = overflowBtn !== null && !overflowBtn.hidden ? 32 : 0;

  // Pick the largest tab width that lets all tabs fit alongside the
  // reserved controls.
  const allTabs = elements.visible;
  const total = allTabs.length;
  const available = root.clientWidth - reserveForPlus - reserveForOverflow;
  let tabWidth = defaultTabWidth;
  if (total * tabWidth > available) {
    tabWidth = Math.max(minTabWidth, Math.floor(available / Math.max(total, 1)));
  }

  // Reserve width for the overflow button if any tab would otherwise overflow.
  let visibleCount = total;
  let needsOverflow = false;
  const visibleWidth = (n: number): number => n * tabWidth + reserveForPlus;
  while (visibleCount > 0 && visibleWidth(visibleCount) + (needsOverflow ? 32 : 0) > root.clientWidth) {
    visibleCount -= 1;
    needsOverflow = true;
  }

  // Apply visibility.
  for (let i = 0; i < allTabs.length; i += 1) {
    const tab = allTabs[i]!;
    tab.style.width = `${tabWidth}px`;
    tab.hidden = i >= visibleCount;
  }

  // Hidden = the trailing tabs.
  const tabDtos = store.state.tabs;
  elements.hidden = tabDtos.slice(visibleCount);

  if (overflowBtn !== null) {
    overflowBtn.hidden = !needsOverflow;
    if (needsOverflow) {
      overflowBtn.textContent = `▾${elements.hidden.length}`;
      overflowBtn.title = `Ещё ${elements.hidden.length} таб(ов)`;
    }
  }
}

/**
 * Wires the overflow button: clicking opens a dropdown listing every hidden
 * tab with "Активировать" / "Закрыть" actions. Subsequent clicks toggle the
 * dropdown.
 */
export function buildOverflowButton(
  overflowBtn: HTMLButtonElement,
  hidden: TabDto[],
  onActivate: (tabId: string) => Promise<void> | void,
  onClose: (tabId: string) => Promise<void> | void,
): void {
  if (overflowBtn.hidden) return;

  // Tear down any previously wired handler so we don't stack listeners.
  const clone = overflowBtn.cloneNode(true) as HTMLButtonElement;
  overflowBtn.replaceWith(clone);
  // The caller passes the original overflowBtn reference — keep that in sync
  // so re-renders see the latest DOM node. We don't expose the new node back
  // to the caller; recomputeOverflow uses `elements.overflowButton` only for
  // sizing.
  let open = false;
  let dropdown: HTMLDivElement | null = null;

  const close = (): void => {
    if (dropdown !== null) {
      dropdown.remove();
      dropdown = null;
    }
    open = false;
    document.removeEventListener('click', onDocClick, true);
  };

  const onDocClick = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (target === null) return;
    if (dropdown !== null && dropdown.contains(target)) return;
    if (clone.contains(target)) return;
    close();
  };

  clone.addEventListener('click', (event) => {
    event.stopPropagation();
    if (open) {
      close();
      return;
    }
    open = true;
    dropdown = el('div', 'tab-overflow-dropdown');
    for (const tab of hidden) {
      const row = el('div', 'tab-overflow-row');
      const label = el('span', 'tab-overflow-label', networkShort(tab.network_id));
      const activateBtn = el('button', 'link-btn', 'Активировать') as HTMLButtonElement;
      activateBtn.type = 'button';
      activateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void onActivate(tab.tab_id);
        close();
      });
      const closeBtn = el('button', 'link-btn', 'Закрыть') as HTMLButtonElement;
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void onClose(tab.tab_id);
        close();
      });
      row.append(label, activateBtn, closeBtn);
      dropdown.append(row);
    }
    const rect = clone.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom + 4}px`;
    document.body.append(dropdown);
    document.addEventListener('click', onDocClick, true);
  });
}

function networkShort(networkId: string): string {
  return networkId.length <= 8 ? networkId : `${networkId.slice(0, 8)}…`;
}
