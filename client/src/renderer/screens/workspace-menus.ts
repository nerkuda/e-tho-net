/**
 * Toolbar menus of the workspace (08-ui-spec.md §8, H3/H18, Q3-bugfix).
 *
 * Three menus split by concern (Q3-bugfix):
 *
 * - «Мыслесеть» menu (in the toolbar, to the left of the view switcher):
 *   members (owner), leave network (non-owner), thought/link type catalogues
 *   (a network-level concern), and the network section of the unified
 *   Settings dialog. The network menu used to live in the top row; it
 *   moved here because the active tab already shows the network name.
 * - User menu (top row, right): open/create network (program-level actions
 *   on the workspace), administration (when admin), disconnect. Personal
 *   preferences (display_name, cloud sizing, theme) live in the Settings
 *   dialog.
 * - View menu (☰, top row, right): show/hide editor and the unified
 *   Settings entry («Все настройки», with a gear icon). The type catalogues
 *   moved to «Мыслесеть»; the network-scoped Settings entry («Настройки
 *   мыслесети») lives there too and opens the same dialog straight on the
 *   «Мыслесеть» section.
 *
 * Menus are built lazily on click from the current store state.
 */

import { backToNetworks, disconnect, requireNetworkId } from '../app.js';
import { openAdminPanel } from '../admin/admin.js';
import { showAboutDialog } from './about-dialog.js';
import { confirmDialog, errorDialog, showDialog } from '../lib/dialog.js';
import { button, div, el, errText, span } from '../lib/dom.js';
import { svgIcon } from '../lib/icons.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { MENU_SEPARATOR, showMenuAt, type MenuItem } from '../lib/menu.js';
import { store } from '../state.js';
import { toggleEditorVisibility } from '../editor/editor.js';
import type { WorkspaceHandles } from './workspace.js';
import { showCreateNetworkDialog } from './networks.js';
import { showSettingsDialog } from './settings.js';
import { showLinkTypesDialog, showThoughtTypesDialog } from './type-manager.js';
import { showPropertyManagerDialog } from './property-manager.js';
import { openTrashDialog } from '../trash.js';
import type { NetworkMember, User } from '@etn/shared';

/** Wires the toolbar network menu button. */
export function wireNetMenu(handles: WorkspaceHandles): void {
  handles.netMenuButton.addEventListener('click', (event) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    // «Корзина (N)» needs a fresh count (08-ui-spec.md §8.1) — fetched once
    // per menu open rather than kept live in the store.
    void (async () => {
      const networkId = store.state.networkId;
      let trashCount = 0;
      if (networkId !== null) {
        try {
          const trash = await etn.trash.list(networkId);
          trashCount = trash.thoughts.length + trash.links.length;
        } catch {
          trashCount = 0;
        }
      }
      showMenuAt(rect.left, rect.bottom + 4, buildNetMenuItems(trashCount));
    })();
  });
}

/**
 * Builds the «Мыслесеть» menu items from the current state (Q3-bugfix,
 * 08-ui-spec.md §8.1). The menu houses commands that act on the **open**
 * network: members, leaving, type catalogues (a network-level concern),
 * the trash (S13), and the network section of the unified Settings dialog.
 */
export function buildNetMenuItems(trashCount = 0): MenuItem[] {
  const net = store.state.network;
  const meId = store.state.me?.id ?? null;
  const isOwner = net !== null && net.owner_id === meId;
  return [
    { label: 'Участники сети', disabled: !isOwner, onClick: () => void membersDialog() },
    {
      label: 'Выйти из сети',
      disabled: isOwner,
      danger: true,
      onClick: () => void leaveNetwork(),
    },
    MENU_SEPARATOR,
    { label: 'Типы мыслей', onClick: () => showThoughtTypesDialog() },
    { label: 'Типы связей', onClick: () => showLinkTypesDialog() },
    { label: 'Свойства', onClick: () => showPropertyManagerDialog() },
    MENU_SEPARATOR,
    {
      label: `Корзина (${trashCount})`,
      onClick: () => {
        const networkId = store.state.networkId;
        if (networkId !== null) void openTrashDialog(networkId);
      },
    },
    MENU_SEPARATOR,
    {
      label: 'Настройки мыслесети',
      onClick: () => showSettingsDialog('network'),
    },
  ];
}

/** Members dialog: list, add, remove, transfer ownership (owner only). */
async function membersDialog(): Promise<void> {
  const networkId = requireNetworkId();

  const errorLine = span('', 'error-text');
  const body = div('form-stack');
  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '260px';
  body.append(tableWrap, errorLine);

  let users: User[] = [];
  if (store.state.me?.is_admin === true) {
    try {
      users = await etn.admin.listUsers();
    } catch {
      users = []; // fall back to raw ids
    }
  }

  const userById = new Map(users.map((u) => [u.id, u]));

  async function refresh(): Promise<void> {
    await refreshLockCounts();
    tableWrap.replaceChildren();
    let members: NetworkMember[];
    try {
      members = await etn.networks.listMembers(networkId);
    } catch (err) {
      errorLine.textContent = errText(err);
      return;
    }
    const table = el('table', 'table-list');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(el('th', undefined, 'Пользователь'), el('th', undefined, 'Роль'), el('th'));
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    for (const member of members) {
      const user = userById.get(member.user_id);
      const row = el('tr');
      const name = user
        ? `${user.display_name ?? user.username} (${user.username})`
        : member.user_id;
      row.append(
        el('td', undefined, name),
        el('td', undefined, member.role === 'owner' ? 'владелец' : 'участник'),
      );
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      // «Снять все блокировки» (task 4f141756, UI element ae74b044) is
      // available to ANY participant (not only owner) per the network
      // равноправие rule. Visible always; disabled when the participant
      // currently holds no locks (the «предохранитель от залипших
      // захватов» is the main use case, but it's also a clean reset for
      // the rare legit case of a participant with a lock count > 0).
      const lockCount = lockCounts.get(member.user_id) ?? 0;
      const clearBtn = button(
        lockCount > 0 ? `Снять блокировки (${lockCount})` : 'Снять блокировки',
        () => void clearMemberLocks(member.user_id, name),
        'link-btn',
      );
      clearBtn.disabled = lockCount === 0;
      actions.append(clearBtn);
      if (member.role !== 'owner') {
        actions.append(
          button('Сделать владельцем', () => void transfer(member.user_id), 'link-btn'),
          button('Исключить', () => void removeMemberRow(member.user_id), 'link-btn'),
        );
      }
      row.append(actions);
      tbody.append(row);
    }
    table.append(tbody);
    tableWrap.append(table);
  }

  /**
   * Counts active locks per user — fetched in parallel with `listMembers`
   * so each row can render «Снять блокировки (N)» without a second
   * round-trip per click. Best-effort: a failure to count locks does not
   * block the participant roster.
   */
  const lockCounts = new Map<string, number>();
  async function refreshLockCounts(): Promise<void> {
    try {
      const locks = await etn.locks.list(networkId);
      lockCounts.clear();
      for (const lock of locks) {
        lockCounts.set(lock.user_id, (lockCounts.get(lock.user_id) ?? 0) + 1);
      }
    } catch {
      // Non-fatal — the buttons stay enabled but the count badge is hidden.
    }
  }

  async function clearMemberLocks(userId: string, displayName: string): Promise<void> {
    if (
      !(await confirmDialog(
        'Снять все блокировки',
        `Снять все блокировки участника «${displayName}»? Действие необратимо.`,
      ))
    ) {
      return;
    }
    try {
      const result = await etn.locks.clear(networkId, userId);
      notice(`Снято блокировок: ${result.cleared}.`);
      // The realtime bus will fan-out `edit.cleared` for every row, but the
      // local badge needs an immediate refresh — pull the fresh count once
      // and let the realtime subscriber pick up the rest.
      await refreshLockCounts();
      await refresh();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  async function transfer(userId: string): Promise<void> {
    const user = userById.get(userId);
    const name = user?.display_name ?? user?.username ?? userId;
    if (
      !(await confirmDialog('Передача владения', `Передать владение сетью пользователю «${name}»?`))
    ) {
      return;
    }
    try {
      await etn.networks.transferOwnership(networkId, userId);
      await refresh();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  async function removeMemberRow(userId: string): Promise<void> {
    const user = userById.get(userId);
    const name = user?.display_name ?? user?.username ?? userId;
    if (!(await confirmDialog('Исключить участника', `Исключить «${name}» из сети?`))) return;
    try {
      await etn.networks.removeMember(networkId, userId);
      await refresh();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  // Add-member row.
  const addRow = div('form-row');
  addRow.style.marginTop = '10px';
  let addInput: HTMLInputElement | HTMLSelectElement;
  if (users.length > 0) {
    const select = el('select', 'select-input');
    const placeholder = el('option', undefined, '— выберите пользователя —');
    placeholder.value = '';
    select.append(placeholder);
    for (const user of users) {
      const option = el(
        'option',
        undefined,
        `${user.display_name ?? user.username} (${user.username})`,
      );
      option.value = user.id;
      select.append(option);
    }
    addInput = select;
  } else {
    const input = el('input', 'text-input');
    input.type = 'text';
    input.placeholder = 'ID пользователя';
    addInput = input;
  }
  addRow.append(
    addInput,
    button(
      'Добавить',
      () => {
        void (async () => {
          try {
            await etn.networks.addMember(networkId, addInput.value.trim());
            addInput.value = '';
            await refresh();
          } catch (err) {
            errorLine.textContent = errText(err);
          }
        })();
      },
      'btn small',
    ),
  );
  body.append(addRow);

  showDialog({
    title: 'Участники сети',
    body,
    width: 560,
    buttons: [{ label: 'Закрыть', primary: true }],
  });
  await refresh();
}

/** Leaves the network (non-owner): removes self from members. */
async function leaveNetwork(): Promise<void> {
  const networkId = requireNetworkId();
  const meId = store.state.me?.id;
  if (meId === undefined) return;
  if (!(await confirmDialog('Выйти из сети', 'Вы покинете сеть и потеряете к ней доступ.'))) {
    return;
  }
  try {
    await etn.networks.removeMember(networkId, meId);
    // The server emits member.removed; the realtime handler returns to the list.
  } catch (err) {
    errorDialog('Выйти из сети', err);
  }
}

/** Wires the toolbar user menu button (H18 content; button lives in H1). */
export function wireUserMenu(handles: WorkspaceHandles): void {
  handles.userMenuButton.addEventListener('click', (event) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    showMenuAt(rect.right - 200, rect.bottom + 4, buildUserMenuItems());
  });
}

/**
 * Builds the user menu items (H18, Q3-bugfix, 08-ui-spec.md §8.2). Houses
 * program-level commands: opening/creating networks (workspace-wide
 * actions), administration (when admin), the About dialog, disconnect.
 * Personal preferences (display_name, cloud sizing, theme) live in the
 * unified Settings dialog (`showSettingsDialog`, opened from the
 * «Мыслесеть» menu).
 */
export function buildUserMenuItems(): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Открыть сеть (список)', onClick: () => backToNetworks() },
    { label: 'Создать сеть', onClick: () => void showCreateNetworkDialog() },
  ];
  if (store.state.me?.is_admin === true) {
    items.push(MENU_SEPARATOR, {
      label: 'Администрирование',
      onClick: () => openAdminPanel(),
    });
  }
  items.push(
    MENU_SEPARATOR,
    { label: 'О программе', onClick: () => showAboutDialog() },
    {
      label: 'Отключиться',
      danger: true,
      onClick: () => void disconnect(),
    },
  );
  return items;
}

/** Wires the toolbar "View" menu button (08-ui-spec.md §8.3). */
export function wireViewMenu(handles: WorkspaceHandles): void {
  handles.viewMenuButton.addEventListener('click', (event) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    showMenuAt(rect.right - 200, rect.bottom + 4, buildViewMenuItems());
  });
}

/**
 * Builds the «Вид» menu items from the current state (Q3-bugfix,
 * 08-ui-spec.md §8.3). Houses the layout toggle (show/hide editor) and
 * the unified Settings dialog entry («Все настройки», opens with the
 * default section). The type catalogues moved to the «Мыслесеть» menu
 * (they are network-level concerns, not workspace-layout); the
 * network-scoped entry «Настройки мыслесети» lives in the same menu
 * and opens the same dialog straight on the «Мыслесеть» section.
 */
export function buildViewMenuItems(): MenuItem[] {
  const hidden = store.state.editorPosition === 'hidden';
  // `MenuItem.icon` accepts a text glyph or a DOM node; passing the SVG
  // node directly (instead of innerHTML) keeps `lib/menu.ts` safe —
  // textContent-escaping would otherwise turn the markup into literal text.
  const gear = svgIcon('settings', 14);
  return [
    {
      label: hidden ? 'Показать редактор' : 'Скрыть редактор',
      onClick: () => void toggleEditorVisibility(),
    },
    MENU_SEPARATOR,
    {
      label: 'Все настройки',
      icon: gear,
      onClick: () => showSettingsDialog(),
    },
  ];
}
