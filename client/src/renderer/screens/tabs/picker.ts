/**
 * Network picker overlay (Q-bugfix).
 *
 * The «+» tab opens this overlay inside the workspace body, so the tab strip
 * stays visible — clicking another tab, picking a network or creating a new
 * one closes it. Picking a network always creates a NEW tab (duplicates of
 * the same network are explicitly allowed by the original Q decision).
 *
 *  ┌──────────────────────────────────────────────────────┐
 *  │ [tab-strip with «+» highlighted]                       │ ← top-row
 *  ├──────────────────────────────────────────────────────┤
 *  │  Открыть сеть                                         │
 *  │  ┌──────────────────────────────────────────────┐    │
 *  │  │ • Сеть A    [владелец] 👥 3                   │    │
 *  │  │ • Сеть B    [участник] 👥 5                   │    │
 *  │  │ [+ Создать сеть]                             │    │
 *  │  └──────────────────────────────────────────────┘    │
 *  ├──────────────────────────────────────────────────────┤
 *  │  Status bar                                           │
 *  └──────────────────────────────────────────────────────┘
 */
import { openNetwork } from '../../app.js';
import { button, div, el, errText, span } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { store } from '../../state.js';
import type { NetworkListItem } from '@etn/shared';
import { upsertTab } from './tab-state.js';
import { refreshTabAccessibility } from './tab-accessibility.js';

/** Role badge text (owner/member). */
function roleBadge(role: string): HTMLElement {
  const badge = span(role === 'owner' ? 'владелец' : 'участник', 'role-badge');
  if (role === 'owner') badge.classList.add('owner');
  return badge;
}

/**
 * Mounts the picker overlay into `host`. Subscribes to `store.pickerOpen`
 * and toggles visibility on every change. Owns its own load lifecycle —
 * reloads the network list each time it opens so a freshly created or
 * revoked network is reflected immediately.
 */
export function mountPicker(host: HTMLElement): void {
  const errorLine = el('p', 'error-text');
  errorLine.hidden = true;

  const title = el('h1', 'picker-title', 'Открыть сеть');
  const subtitle = el('p', 'picker-sub muted', 'Выберите сеть или создайте новую. Закрыть — любой другой таб.');

  const createButton = button('+ Создать сеть', () => void showCreateDialog(), 'btn primary');
  const cancelButton = button('Отмена', () => closePicker(), 'btn');
  const actions = div('picker-actions');
  actions.append(createButton, cancelButton);

  const list = div('picker-list');

  const card = div('picker-card');
  card.append(title, subtitle, list, actions, errorLine);
  host.append(card);

  async function load(): Promise<void> {
    errorLine.hidden = true;
    try {
      const networks = await etn.networks.list();
      // The tab strip reads display_name from here; keep it fresh.
      store.update({ networkList: networks });
      renderList(networks);
    } catch (err) {
      errorLine.textContent = errText(err);
      errorLine.hidden = false;
    }
  }

  function renderList(networks: NetworkListItem[]): void {
    list.replaceChildren();
    if (networks.length === 0) {
      list.append(el('p', 'muted', 'У вас пока нет сетей. Создайте первую!'));
      return;
    }
    for (const net of networks) {
      const item = div('network-item');
      const info = div('network-info');
      info.append(span(net.display_name, 'network-name'));
      info.append(el('p', 'muted', `Владелец: ${net.owner.display_name ?? net.owner.id}`));
      item.append(info);
      const meta = div('network-meta');
      meta.append(roleBadge(net.role), span(`👥 ${net.members_count}`));
      item.append(meta);
      item.addEventListener('click', () => void pickNetwork(net.id));
      list.append(item);
    }
  }

  /**
   * Creates a new tab via `etn.tabs.open` (always a fresh tab per the Q
   * bugfix) and switches the workspace to it. The new tab becomes the
   * active one immediately. Refreshes the `networkList` cache afterwards so
   * the freshly created network's `display_name` shows up on the tab strip.
   */
  async function pickNetwork(networkId: string): Promise<void> {
    errorLine.hidden = true;
    try {
      const tab = await etn.tabs.open(networkId);
      upsertTab(tab);
      store.update({ activeTabId: tab.tab_id, pickerOpen: false });
      await openNetwork(networkId, tab.tab_id);
      void refreshNetworkList();
    } catch (err) {
      errorLine.textContent = errText(err);
      errorLine.hidden = false;
    }
  }

  async function showCreateDialog(): Promise<void> {
    const nameInput = el('input', 'text-input');
    nameInput.type = 'text';
    nameInput.maxLength = 200;
    nameInput.placeholder = 'Название';
    const descInput = el('input', 'text-input');
    descInput.type = 'text';
    descInput.maxLength = 2000;
    descInput.placeholder = 'Описание (необязательно)';
    const dialogError = span('', 'error-text');
    const body = div('form-stack');
    body.append(nameInput, descInput, dialogError);

    const { showDialog } = await import('../../lib/dialog.js');
    let busy = false;
    showDialog({
      title: 'Создать мыслесеть',
      body,
      width: 460,
      buttons: [
        { label: 'Отмена' },
        {
          label: 'Создать',
          primary: true,
          keepOpen: true,
          onClick: (close) => {
            void (async () => {
              if (busy) return;
              const name = nameInput.value.trim();
              if (name === '') {
                dialogError.textContent = 'Введите название сети.';
                return;
              }
              busy = true;
              try {
                const network = await etn.networks.create(name, descInput.value.trim() || undefined);
                close();
                // Refresh the cache BEFORE opening so the tab strip can show
                // the freshly-created network's display_name right away.
                await refreshNetworkList();
                await pickNetwork(network.id);
              } catch (err) {
                dialogError.textContent = errText(err);
              } finally {
                busy = false;
              }
            })();
          },
        },
      ],
      onMount: () => nameInput.focus(),
    });
  }

  /** Pulls the freshest `etn.networks.list()` into the store cache. */
  async function refreshNetworkList(): Promise<void> {
    try {
      const list = await etn.networks.list();
      store.update({ networkList: list });
    } catch {
      // best-effort; the next picker open will retry
    }
  }

  function closePicker(): void {
    store.update({ pickerOpen: false });
  }

  // Refresh the list when the picker becomes visible; reload tab-strip data
  // too so newly revoked memberships surface as «блеклые» tabs.
  let lastOpen = false;
  const update = (): void => {
    const open = store.state.pickerOpen;
    host.classList.toggle('hidden', !open);
    if (open && !lastOpen) {
      void load();
      void refreshTabAccessibility();
    }
    lastOpen = open;
  };

  store.subscribe(update);
  update();
}
