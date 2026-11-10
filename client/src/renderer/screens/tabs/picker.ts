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
import { t } from '../../lib/i18n.js';
import { div, el, errText, span } from '../../lib/dom.js';
import { errorParagraph, footerErrorLine } from '../../lib/ui/messages.js';
import { etn } from '../../lib/etn.js';
import { store } from '../../state.js';
import type { NetworkListItem } from '@etn/shared';
import { upsertTab } from './tab-state.js';
import { refreshTabAccessibility } from './tab-accessibility.js';
import { beginWorkspaceTransition, endWorkspaceTransition } from '../workspace-transition.js';
import { uiButton } from '../../lib/ui/button.js';
import { fieldInput } from '../../lib/ui/field.js';
import { badge } from '../../lib/ui/badge.js';

/** Role badge text (owner/member). */
function roleBadge(role: string): HTMLElement {
  return badge(role === 'owner' ? t('networks.owner') : t('networks.member'), {
    tone: role === 'owner' ? 'warn' : 'accent',
  });
}

/**
 * Mounts the picker overlay into `host`. Subscribes to `store.pickerOpen`
 * and toggles visibility on every change. Owns its own load lifecycle —
 * reloads the network list each time it opens so a freshly created or
 * revoked network is reflected immediately.
 */
export function mountPicker(host: HTMLElement): () => void {
  const errorLine = errorParagraph();
  errorLine.hidden = true;

  const title = el('h1', 'picker-title', t('tabs.openNetwork'));
  const subtitle = el('p', 'picker-sub muted', t('tabs.selectNetworkSozdayteNovuyuCloseLyuboy'));

  const createButton = uiButton({
    label: t('tabs.label.createNetwork'),
    role: 'primary',
    size: 'm',
    onClick: () => void showCreateDialog(),
  });
  const cancelButton = uiButton({
    label: t('actions.cancel'),
    role: 'secondary',
    size: 'm',
    onClick: () => closePicker(),
  });
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
      list.append(el('p', 'muted', t('networks.uVasPokaNoNetworksSozdayte')));
      return;
    }
    for (const net of networks) {
      const item = div('network-item');
      const info = div('network-info');
      info.append(span(net.display_name, 'network-name'));
      info.append(el('p', 'muted', t('networks.owner2', net.owner.display_name ?? net.owner.id)));
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
    // Окно смены поколения workspace (ошибка f1febdfc): `etn.tabs.open` уже
    // вернул вкладку, но рабочее пространство ещё прежнее — клик по закладке
    // вида в нём не должен потеряться. Окно закрывается после `openNetwork`;
    // вложенное окно самого `openNetwork` учитывается счётчиком.
    const transition = beginWorkspaceTransition();
    try {
      const tab = await etn.tabs.open(networkId);
      upsertTab(tab);
      store.update({ activeTabId: tab.tab_id, pickerOpen: false });
      await openNetwork(networkId, tab.tab_id);
      void refreshNetworkList();
    } catch (err) {
      errorLine.textContent = errText(err);
      errorLine.hidden = false;
    } finally {
      endWorkspaceTransition(transition);
    }
  }

  async function showCreateDialog(): Promise<void> {
    const nameInput = fieldInput();
    nameInput.type = 'text';
    nameInput.maxLength = 200;
    nameInput.placeholder = t('activity.name.title');
    const descInput = fieldInput();
    descInput.type = 'text';
    descInput.maxLength = 2000;
    descInput.placeholder = t('networks.label.descriptionOptional');
    const dialogError = footerErrorLine();
    const body = div('form-stack');
    body.append(nameInput, descInput);

    const { showDialog } = await import('../../lib/dialog.js');
    let busy = false;
    // Кнопки футера disabled, пока запрос создания ждёт сервер (ошибка ef89c5c8):
    // второй клик давал ВТОРУЮ мыслесеть.
    let createBtn: HTMLButtonElement | null = null;
    let cancelBtn: HTMLButtonElement | null = null;
    const setBusy = (value: boolean): void => {
      busy = value;
      if (createBtn !== null) createBtn.disabled = value;
      if (cancelBtn !== null) cancelBtn.disabled = value;
    };
    /** Создание сети и закрытие — общий путь кнопки и подтверждения (b58f6aad). */
    async function create(close: () => void): Promise<void> {
      if (busy) return;
      const name = nameInput.value.trim();
      if (name === '') {
        dialogError.show(t('networks.enterTitleNetwork'), { field: () => nameInput });
        return;
      }
      setBusy(true);
      try {
        const network = await etn.networks.create(name, descInput.value.trim() || undefined);
        close();
        // Refresh the cache BEFORE opening so the tab strip can show
        // the freshly-created network's display_name right away.
        await refreshNetworkList();
        await pickNetwork(network.id);
      } catch (err) {
        dialogError.show(errText(err));
      } finally {
        setBusy(false);
      }
    }
    showDialog({
      title: t('networks.title.createMysleset'),
      body,
      size: 's',
      // Ошибка создания — в панели кнопок (требование 397c5a56).
      footerError: dialogError,
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

  const unsubscribe = store.subscribe(update);
  update();

  // Release the store subscription on workspace teardown (ошибка 37b713de).
  return () => {
    unsubscribe();
  };
}
