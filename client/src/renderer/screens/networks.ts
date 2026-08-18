/**
 * Network list screen (H3, 08-ui-spec.md §8, 09-scenarios.md A1):
 *
 *  - lists the networks available to the current user (name, owner, role,
 *    members count);
 *  - "Создать сеть" dialog → `networks.create`, then opens the new network
 *    (which starts on the HOME thought);
 *  - click on a network → `openNetwork` (app.ts): loads L2/L3/L4 state and the
 *    initial focus;
 *  - "Отключиться" → back to onboarding (H2).
 */

import { disconnect, openNetwork } from '../app.js';
import { confirmDialog, field, showDialog } from '../lib/dialog.js';
import { button, div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { store } from '../state.js';
import type { NetworkListItem } from '@etn/shared';

/** Role badge text (owner/member). */
function roleBadge(role: string): HTMLElement {
  const badge = span(role === 'owner' ? 'владелец' : 'участник', 'role-badge');
  if (role === 'owner') badge.classList.add('owner');
  return badge;
}

/** Builds the network list screen. The list loads asynchronously. */
export function buildNetworks(): HTMLElement {
  const root = div('screen screen-networks');
  const card = div('card networks-card');
  card.style.width = '560px';

  const header = div('form-row');
  header.style.marginBottom = '12px';
  const title = el('h1', 'networks-title', 'Мыслесети');
  title.style.flex = '1';
  const createButton = button('Создать сеть', () => void showCreateNetworkDialog(), 'btn primary');
  const logoutButton = button('Отключиться', () => void confirmDisconnect(), 'btn');
  header.append(title, createButton, logoutButton);
  card.append(header);

  const logo = el('img', 'networks-logo');
  logo.src = './logo.svg';
  logo.alt = 'ETN';
  logo.style.marginBottom = '8px';
  card.prepend(logo);

  const userLine = el(
    'p',
    'muted',
    `Подключены как ${store.state.me?.display_name ?? store.state.me?.username ?? '—'}`,
  );
  userLine.style.margin = '0 0 10px';
  card.append(userLine);

  const list = div('networks-list');
  const errorLine = el('p', 'error-text');
  errorLine.hidden = true;
  card.append(list, errorLine);

  root.append(card);

  /** Loads and renders the network list. */
  async function load(): Promise<void> {
    errorLine.hidden = true;
    try {
      const networks = await etn.networks.list();
      if (!root.isConnected) return;
      renderList(networks);
    } catch (err) {
      errorLine.textContent = errText(err);
      errorLine.hidden = false;
    }
  }

  /** Renders network rows (name / role / members / owner). */
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
      info.style.margin = '0';
      item.append(info);
      const meta = div('network-meta');
      meta.append(roleBadge(net.role), span(`👥 ${net.members_count}`));
      item.append(meta);
      item.addEventListener('click', () => void open(net.id));
      list.append(item);
    }
  }

  /** Opens a network; errors are shown inline. */
  async function open(networkId: string): Promise<void> {
    errorLine.hidden = true;
    try {
      await openNetwork(networkId);
    } catch (err) {
      errorLine.textContent = errText(err);
      errorLine.hidden = false;
    }
  }

  /** Confirm disconnect → onboarding. */
  async function confirmDisconnect(): Promise<void> {
    if (await confirmDialog('Отключиться', 'Вернуться к экрану подключения?')) {
      await disconnect();
    }
  }

  void load();
  return root;
}

/**
 * Shared create-network dialog (used from the network list and the toolbar
 * network menu, 08-ui-spec.md §8). Opens the created network immediately (A1).
 */
export async function showCreateNetworkDialog(): Promise<void> {
  const nameInput = el('input', 'text-input');
  nameInput.type = 'text';
  nameInput.maxLength = 200;
  const descInput = el('input', 'text-input');
  descInput.type = 'text';
  descInput.maxLength = 2000;
  const errorLine = span('', 'error-text');
  const body = div('form-stack');
  body.append(
    field('Название сети', nameInput),
    field('Описание (необязательно)', descInput),
    errorLine,
  );

  let creating = false;
  await new Promise<void>((resolve) => {
    showDialog({
      title: 'Создать мыслесеть',
      body,
      width: 460,
      buttons: [
        { label: 'Отмена', onClick: () => resolve() },
        {
          label: 'Создать',
          primary: true,
          keepOpen: true,
          onClick: (close) => {
            void (async () => {
              if (creating) return;
              const name = nameInput.value.trim();
              if (name === '') {
                errorLine.textContent = 'Введите название сети.';
                return;
              }
              creating = true;
              try {
                const description = descInput.value.trim() || undefined;
                const network = await etn.networks.create(name, description);
                close();
                await openNetwork(network.id);
              } catch (err) {
                errorLine.textContent = errText(err);
              } finally {
                creating = false;
                resolve();
              }
            })();
          },
        },
      ],
      onMount: () => nameInput.focus(),
    });
  });
}
