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
import { t } from '../lib/i18n.js';
import { showAboutDialog } from './about-dialog.js';
import { confirmDialog, showDialog } from '../lib/dialog.js';
import { div, el, errText, span } from '../lib/dom.js';
import { badge } from '../lib/ui/badge.js';
import { fieldInput, fieldRow } from '../lib/ui/field.js';
import { errorParagraph, footerErrorLine } from '../lib/ui/messages.js';
import { etn } from '../lib/etn.js';
import { store } from '../state.js';
import type { NetworkListItem } from '@etn/shared';
import { uiButton } from '../lib/ui/button.js';

/** Role badge text (owner/member). */
function roleBadge(role: string): HTMLElement {
  return badge(role === 'owner' ? t('networks.owner') : t('networks.member'), {
    tone: role === 'owner' ? 'warn' : 'accent',
  });
}

/** Builds the network list screen. The list loads asynchronously. */
export function buildNetworks(): HTMLElement {
  const root = div('screen screen-networks');
  const card = div('card networks-card');
  card.style.width = '560px';

  const header = div('form-row');
  header.style.marginBottom = '12px';
  const title = el('h1', 'networks-title', t('networks.mysleseti'));
  title.style.flex = '1';
  const createButton = uiButton({
    label: t('networks.label.createNetwork'),
    role: 'primary',
    size: 'm',
    onClick: () => void showCreateNetworkDialog(),
  });
  const aboutButton = uiButton({
    label: t('about.title.oProgramme'),
    role: 'secondary',
    size: 'm',
    onClick: () => showAboutDialog(),
  });
  const logoutButton = uiButton({
    label: t('networks.label.otklyuchitsya'),
    role: 'secondary',
    size: 'm',
    onClick: () => void confirmDisconnect(),
  });
  header.append(title, createButton, aboutButton, logoutButton);
  card.append(header);

  const logo = el('img', 'networks-logo');
  logo.src = './logo.svg';
  logo.alt = 'ETN';
  logo.style.marginBottom = '8px';
  card.prepend(logo);

  const userLine = el(
    'p',
    'muted',
    t('networks.podklyucheny', store.state.me?.display_name ?? store.state.me?.username ?? '—'),
  );
  userLine.style.margin = '0 0 10px';
  card.append(userLine);

  const list = div('networks-list');
  const errorLine = errorParagraph();
  errorLine.hidden = true;
  card.append(list, errorLine);

  root.append(card);

  /** Loads and renders the network list. */
  async function load(): Promise<void> {
    errorLine.hidden = true;
    try {
      const networks = await etn.networks.list();
      if (!root.isConnected) return;
      // Tab strip reads `display_name` from here; keep the cache fresh.
      store.update({ networkList: networks });
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
      list.append(el('p', 'muted', t('networks.uVasPokaNoNetworksSozdayte')));
      return;
    }
    for (const net of networks) {
      const item = div('network-item');
      const info = div('network-info');
      info.append(span(net.display_name, 'network-name'));
      info.append(el('p', 'muted', t('networks.owner2', net.owner.display_name ?? net.owner.id)));
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
    if (await confirmDialog(t('networks.label.otklyuchitsya'), t('networks.vernutsyaEkranuPodklyucheniya'))) {
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
  const nameInput = fieldInput({ maxLength: 200 });
  const descInput = fieldInput({ maxLength: 2000 });
  const errorLine = footerErrorLine();
  const body = div('form-stack');
  body.append(
    fieldRow({ label: t('networks.label.titleNetwork'), control: nameInput }),
    fieldRow({ label: t('networks.label.descriptionOptional'), control: descInput }),
  );

  let creating = false;
  // Пока запрос создания ждёт сервер, кнопки футера disabled (ошибка ef89c5c8):
  // второй клик давал ВТОРУЮ мыслесеть.
  let createBtn: HTMLButtonElement | null = null;
  let cancelBtn: HTMLButtonElement | null = null;
  const setBusy = (value: boolean): void => {
    creating = value;
    if (createBtn !== null) createBtn.disabled = value;
    if (cancelBtn !== null) cancelBtn.disabled = value;
  };
  await new Promise<void>((resolve) => {
    /** Создание сети и закрытие — общий путь кнопки и подтверждения (b58f6aad). */
    async function create(close: () => void): Promise<void> {
      if (creating) return;
      const name = nameInput.value.trim();
      if (name === '') {
        errorLine.show(t('networks.enterTitleNetwork'), { field: () => nameInput });
        return;
      }
      setBusy(true);
      try {
        const description = descInput.value.trim() || undefined;
        const network = await etn.networks.create(name, description);
        close();
        await openNetwork(network.id);
      } catch (err) {
        errorLine.show(errText(err));
      } finally {
        setBusy(false);
        resolve();
      }
    }
    showDialog({
      title: t('networks.title.createMysleset'),
      body,
      size: 's',
      // Ошибка создания — в панели кнопок, единственное обязательное место
      // ошибки диалога (требование 397c5a56).
      footerError: errorLine,
      // Грязная форма (требование b58f6aad): Esc/крестик при заполненных полях
      // требуют подтверждения; «Сохранить» идёт тем же путём, что «Создать».
      dirty: {
        isDirty: () => nameInput.value.trim() !== '' || descInput.value.trim() !== '',
        save: (close) => void create(close),
      },
      buttons: [
        {
          label: t('actions.cancel'),
          ref: (btn) => {
            cancelBtn = btn;
          },
          onClick: () => resolve(),
        },
        {
          label: t('admin.label.create'),
          primary: true,
          keepOpen: true,
          ref: (btn) => {
            createBtn = btn;
          },
          onClick: (close) => void create(close),
        },
      ],
      onMount: () => nameInput.focus(),
    });
  });
}
