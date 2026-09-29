/**
 * Toolbar menus of the workspace (08-ui-spec.md §8, H3/H18, Q3-bugfix;
 * задача a0cdd731 — компоновка верхних меню).
 *
 * Две группы меню:
 *
 * - «Мыслесеть» (правый край строки меню мыслесети, прижата вправо): всё,
 *   что относится к ОТКРЫТОЙ мыслесети — счётчики и входы в каталоги типов
 *   мыслей/связей и свойства мыслей, корзина, «Настройка мыслесети»,
 *   участники и выход, показ/скрытие редактора мысли. Показ/скрытие редактора
 *   переехало сюда из упразднённого меню «бутерброд» (☰).
 * - Меню пользователя (верхняя строка, справа): «Открыть мыслесеть (список)»
 *   и «Создать мыслесеть» (перед «Настройки», за разделителем),
 *   «Администрирование» (только админу сервера), «Настройки» (объединённый
 *   диалог на вкладке «Пользователь»), «О программе» и «Отключиться».
 *   Открытие/создание мыслесети — команды уровня пользователя (решение
 *   пользователя 2026-09-29, задача a9cb53dd): они вернулись сюда из меню
 *   «Мыслесеть», где жили после компоновки a0cdd731. «О программе» доступно
 *   и здесь, и на экране списка мыслесетей (прежняя точка входа).
 *
 * Меню «бутерброд» (☰, «Все настройки») упразднено: его «Все настройки»
 * дублировало пункт «Настройки» меню пользователя, а показ/скрытие редактора
 * переехал в меню «Мыслесеть».
 *
 * Меню собираются лениво по клику из текущего состояния store.
 */

import { backToNetworks, disconnect, requireNetworkId } from '../app.js';
import { t } from '../lib/i18n.js';
import { openAdminPanel } from '../admin/admin.js';
import { confirmDialog, errorDialog, showDialog } from '../lib/dialog.js';
import { button, div, el, errText } from '../lib/dom.js';
import { footerErrorLine } from '../lib/ui/messages.js';
import { countVisibleProperties } from '../lib/pure.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { MENU_SEPARATOR, menuAction, showMenuAt, type MenuItem } from '../lib/menu.js';
import { store } from '../state.js';
import { toggleEditorVisibility } from '../editor/editor.js';
import type { WorkspaceHandles } from './workspace.js';
import { showCreateNetworkDialog } from './networks.js';
import { showNetworkStatisticsDialog } from './network-stats.js';
import { showSettingsDialog } from './settings.js';
// Каталог типов и свойств — один вкладочный диалог (задача 979761cd):
// команды меню открывают его на своей вкладке.
import { showTypeCatalogueDialog } from './type-catalogue.js';
import { showAboutDialog } from './about-dialog.js';
import { openTrashDialog } from '../trash.js';
import type { NetworkMember, User } from '@etn/shared';
import { uiButton } from '../lib/ui/button.js';
import { fieldInput } from '../lib/ui/field.js';

/**
 * Счётчики для меню «Мыслесеть», которых нет в store: корзина и число свойств
 * реестра. Числа типов мыслей и типов связей читаются из store прямо в
 * {@link buildNetMenuItems}.
 */
export interface NetMenuCounts {
  /** Число «Свойств мыслей» (реестр без системных «Родители»/«Потомки»). */
  properties: number;
  /** Число сущностей в корзине (мысли + связи). */
  trash: number;
}

/** Wires the toolbar network menu button (правый край строки меню мыслесети). */
export function wireNetMenu(handles: WorkspaceHandles): void {
  handles.netMenuButton.addEventListener('click', (event) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    // Счётчики «Корзина (N)» и «Свойства мыслей (N)» (08-ui-spec.md §8.1) —
    // не в store: тянем оба одним параллельным запросом на открытие меню.
    void (async () => {
      const networkId = store.state.networkId;
      let trashCount = 0;
      let propertyCount = 0;
      if (networkId !== null) {
        const [trash, registry] = await Promise.all([
          etn.trash.list(networkId).catch(() => null),
          etn.propertyRegistry.list(networkId).catch(() => null),
        ]);
        if (trash !== null) trashCount = trash.thoughts.length + trash.links.length;
        if (registry !== null) propertyCount = countVisibleProperties(registry);
      }
      showMenuAt(
        rect.right - 200,
        rect.bottom + 4,
        buildNetMenuItems({ properties: propertyCount, trash: trashCount }),
      );
    })();
  });
}

/**
 * Builds the «Мыслесеть» menu items from the current state (Q3-bugfix,
 * 08-ui-spec.md §8.1; задачи a0cdd731, a9cb53dd). Состав и порядок — по
 * карточкам задач: счётчики каталогов и корзины, затем настройка/статистика/
 * участники/выход, затем показ/скрытие редактора мысли. Команды
 * открытия/создания мыслесети вернулись в меню пользователя (a9cb53dd).
 * Числа типов мыслей и типов связей — из store (`thoughtTypes`/`linkTypes`).
 */
export function buildNetMenuItems(counts: NetMenuCounts): MenuItem[] {
  const net = store.state.network;
  const meId = store.state.me?.id ?? null;
  const isOwner = net !== null && net.owner_id === meId;
  const editorHidden = store.state.editorPosition === 'hidden';
  return [
    menuAction(t('netMenu.thoughtTypes', store.state.thoughtTypes.length), () =>
      showTypeCatalogueDialog('thought-types'),
    ),
    menuAction(t('netMenu.linkTypes', store.state.linkTypes.length), () =>
      showTypeCatalogueDialog('link-types'),
    ),
    menuAction(t('netMenu.properties', counts.properties), () =>
      showTypeCatalogueDialog('properties'),
    ),
    menuAction(t('netMenu.trash', counts.trash), () => {
      const networkId = store.state.networkId;
      if (networkId !== null) void openTrashDialog(networkId);
    }),
    MENU_SEPARATOR,
    menuAction(t('netMenu.settings'), () => showSettingsDialog('network')),
    menuAction(t('netMenu.statistics'), () => void showNetworkStatisticsDialog()),
    menuAction(t('netMenu.members'), () => void membersDialog(), { disabled: !isOwner }),
    menuAction(t('netMenu.leave'), () => void leaveNetwork(), { disabled: isOwner, danger: true }),
    MENU_SEPARATOR,
    menuAction(
      editorHidden ? t('netMenu.showEditor') : t('netMenu.hideEditor'),
      () => void toggleEditorVisibility(),
    ),
  ];
}

/** Members dialog: list, add, remove, transfer ownership (owner only). */
async function membersDialog(): Promise<void> {
  const networkId = requireNetworkId();

  const errorLine = footerErrorLine();
  const body = div('form-stack');
  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '260px';
  body.append(tableWrap);

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
      errorLine.show(errText(err));
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
      // равноправие rule. Always clickable (bug ba1a5e40): a disabled
      // `.link-btn` looked like a live link and silently ignored clicks,
      // so a user with no locks saw «nothing happen». The click always
      // reports the cleared count — including 0. The «(N)» badge shows
      // the currently known lock count of the participant.
      const lockCount = lockCounts.get(member.user_id) ?? 0;
      const clearBtn = button(
        lockCount > 0 ? `Снять блокировки (${lockCount})` : 'Снять блокировки',
        () =>
          void clearMemberLocks(networkId, member.user_id, name, {
            confirm: (title, message) => confirmDialog(title, message),
            clear: (nid, uid) => etn.locks.clear(nid, uid),
            onCleared: (message) => notice(message),
            onError: (message) => {
              errorLine.show(message);
            },
            refresh: async () => {
              await refreshLockCounts();
              await refresh();
            },
          }),
        'link-btn',
      );
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
      errorLine.show(errText(err));
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
      errorLine.show(errText(err));
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
    const input = fieldInput();
    input.type = 'text';
    input.placeholder = 'ID пользователя';
    addInput = input;
  }
  addRow.append(
    addInput,
    uiButton({
      label: 'Добавить',
      role: 'secondary',
      size: 's',
      onClick: () => {
        void (async () => {
          try {
            await etn.networks.addMember(networkId, addInput.value.trim());
            addInput.value = '';
            await refresh();
          } catch (err) {
            errorLine.show(errText(err));
          }
        })();
      },
    }),
  );
  body.append(addRow);

  showDialog({
    title: 'Участники сети',
    body,
    size: 'm',
    // Ошибки записи — в панели кнопок (требование 397c5a56).
    footerError: errorLine,
    buttons: [{ label: t('actions.close'), primary: true }],
  });
  await refresh();
}

/**
 * Dependencies of {@link clearMemberLocks} — injected so the handler is
 * testable without a DOM (bug ba1a5e40).
 */
export interface ClearMemberLocksDeps {
  /** Confirmation before the reset («Снять все блокировки»). */
  confirm: (title: string, message: string) => Promise<boolean>;
  /** Server-side reset of all locks of the participant (`POST /locks/clear`). */
  clear: (networkId: string, userId: string) => Promise<{ cleared: number }>;
  /** User-facing result message (the cleared count, including 0). */
  onCleared: (message: string) => void;
  /** User-facing error message when the call fails. */
  onError: (message: string) => void;
  /** Refreshes the dialog after a successful reset (counts + roster). */
  refresh: () => Promise<void>;
}

/**
 * «Снять все блокировки» (UI element ae74b044, bug ba1a5e40): asks for
 * confirmation, resets all locks of the participant on the server and always
 * reports the result to the user — «Снято блокировок: N», including N = 0.
 * A failed call is reported as a readable message, never silently.
 */
export async function clearMemberLocks(
  networkId: string,
  userId: string,
  displayName: string,
  deps: ClearMemberLocksDeps,
): Promise<void> {
  if (
    !(await deps.confirm(
      'Снять все блокировки',
      `Снять все блокировки участника «${displayName}»? Действие необратимо.`,
    ))
  ) {
    return;
  }
  try {
    const result = await deps.clear(networkId, userId);
    deps.onCleared(`Снято блокировок: ${result.cleared}.`);
    // The realtime bus will fan-out `edit.cleared` for every row, but the
    // local badge needs an immediate refresh — pull the fresh count once
    // and let the realtime subscriber pick up the rest.
    await deps.refresh();
  } catch (err) {
    deps.onError(`Не удалось снять блокировки: ${errText(err)}`);
  }
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
 * Builds the user menu items (H18, 08-ui-spec.md §8.2; задачи a0cdd731,
 * a9cb53dd; ошибка 0e623d4c). Menu houses: opening/creating a network (level
 * commands, before Settings behind a separator — решением пользователя
 * 2026-09-29, задача a9cb53dd, вернулись сюда из меню «Мыслесеть»),
 * administration (admin only), the unified Settings dialog on the
 * «Пользователь» section, «О программе» (restored) and disconnect.
 * «О программе» also stays on the network list screen
 * (screens/networks.ts) — its original entry point. Персональные настройки
 * (display_name, размер облачка, тема) живут в объединённом диалоге настроек.
 */
export function buildUserMenuItems(): MenuItem[] {
  const items: MenuItem[] = [];
  if (store.state.me?.is_admin === true) {
    items.push(menuAction(t('userMenu.admin'), () => openAdminPanel()), MENU_SEPARATOR);
  }
  items.push(
    // Открытие/создание мыслесети — команды уровня пользователя (a9cb53dd):
    // стоят перед «Настройки», отделены от неё разделителем.
    menuAction(t('userMenu.openNetwork'), () => backToNetworks()),
    menuAction(t('userMenu.createNetwork'), () => void showCreateNetworkDialog()),
    MENU_SEPARATOR,
    menuAction(t('userMenu.settings'), () => showSettingsDialog('user')),
    // «О программе» (ошибка 0e623d4c): пункт вернулся в меню пользователя —
    // его потеряли при перекомпоновке верхних меню (a0cdd731). Прежняя точка
    // входа на экране списка мыслесетей (`screens/networks.ts`) сохранена,
    // поэтому диалог доступен и без подключения к мыслесети.
    menuAction(t('userMenu.about'), () => showAboutDialog()),
    menuAction(t('userMenu.disconnect'), () => void disconnect(), { danger: true }),
  );
  return items;
}
