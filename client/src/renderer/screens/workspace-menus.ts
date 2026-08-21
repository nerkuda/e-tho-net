/**
 * Toolbar menus of the workspace (08-ui-spec.md §8, H3/H18).
 *
 * - Network menu: open network list, create network, members (owner), leave
 *   network (non-owner). Network settings (display_name / description) and
 *   the L3 visibility toggle moved to the unified Settings dialog
 *   (`screens/settings.ts`), opened from the View menu.
 * - User menu (H18): administration (when admin), disconnect. All personal
 *   preferences (display_name, visibility, cloud sizing, theme) live in
 *   Settings.
 * - View menu (☰): show/hide editor, type catalogues, the unified Settings
 *   entry (with a gear icon).
 *
 * Menus are built lazily on click from the current store state.
 */

import { backToNetworks, disconnect, requireNetworkId } from '../app.js';
import { openAdminPanel } from '../admin/admin.js';
import { confirmDialog, errorDialog, showDialog } from '../lib/dialog.js';
import { button, div, el, errText, span } from '../lib/dom.js';
import { svgIcon } from '../lib/icons.js';
import { etn } from '../lib/etn.js';
import { MENU_SEPARATOR, showMenuAt, type MenuItem } from '../lib/menu.js';
import { store } from '../state.js';
import { toggleEditorVisibility } from '../editor/editor.js';
import type { WorkspaceHandles } from './workspace.js';
import { showCreateNetworkDialog } from './networks.js';
import { showSettingsDialog } from './settings.js';
import { showLinkTypesDialog, showThoughtTypesDialog } from './type-manager.js';
import type { NetworkMember, User } from '@etn/shared';

/** Wires the toolbar network menu button. */
export function wireNetMenu(handles: WorkspaceHandles): void {
  handles.netMenuButton.addEventListener('click', (event) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    showMenuAt(rect.left, rect.bottom + 4, buildNetMenuItems());
  });
}

/** Builds the network menu items from the current state. */
export function buildNetMenuItems(): MenuItem[] {
  const net = store.state.network;
  const meId = store.state.me?.id ?? null;
  const isOwner = net !== null && net.owner_id === meId;
  return [
    { label: 'Открыть сеть (список)', onClick: () => backToNetworks() },
    { label: 'Создать сеть', onClick: () => void showCreateNetworkDialog() },
    { label: 'Участники сети', disabled: !isOwner, onClick: () => void membersDialog() },
    MENU_SEPARATOR,
    {
      label: 'Выйти из сети',
      disabled: isOwner,
      danger: true,
      onClick: () => void leaveNetwork(),
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
 * Builds the user menu items (H18). Personal preferences (display_name,
 * visibility, cloud sizing, theme) live in the unified Settings dialog
 * (`showSettingsDialog`, opened from the View menu). This menu keeps the
 * admin entry and the disconnect action.
 */
export function buildUserMenuItems(): MenuItem[] {
  const items: MenuItem[] = [];
  if (store.state.me?.is_admin === true) {
    items.push({
      label: 'Администрирование',
      onClick: () => openAdminPanel(),
    });
    items.push(MENU_SEPARATOR);
  }
  items.push({
    label: 'Отключиться',
    danger: true,
    onClick: () => void disconnect(),
  });
  return items;
}

/** Wires the toolbar "View" menu button (08-ui-spec.md §8). */
export function wireViewMenu(handles: WorkspaceHandles): void {
  handles.viewMenuButton.addEventListener('click', (event) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    showMenuAt(rect.right - 200, rect.bottom + 4, buildViewMenuItems());
  });
}

/**
 * Builds the "View" menu items from the current state. Houses workspace-layout
 * commands (the first one toggles the editor panel — the only way back once
 * the editor and its own header dropdown are hidden), the type catalogues
 * (L6) and the unified Settings entry, opened with a gear icon.
 *
 * The UI theme moved to the Settings dialog (it's an L5 client setting, not
 * a layout toggle). The `Settings` row is a leaf that opens
 * `showSettingsDialog` from `screens/settings.ts`.
 */
export function buildViewMenuItems(): MenuItem[] {
  const hidden = store.state.editorPosition === 'hidden';
  const items: MenuItem[] = [
    {
      label: hidden ? 'Показать редактор' : 'Скрыть редактор',
      onClick: () => void toggleEditorVisibility(),
    },
    { label: 'Типы мыслей', onClick: () => showThoughtTypesDialog() },
    { label: 'Типы связей', onClick: () => showLinkTypesDialog() },
  ];
  // The settings entry carries a lucide-style gear SVG. `MenuItem.icon`
  // accepts either a text glyph or a DOM node; passing the SVG node directly
  // (instead of innerHTML) keeps `lib/menu.ts` safe — textContent-escaping
  // would otherwise turn the markup into literal text.
  const gear = svgIcon('settings', 14);
  items.push(MENU_SEPARATOR, {
    label: 'Настройки',
    icon: gear,
    onClick: () => showSettingsDialog(),
  });
  return items;
}
