/**
 * Admin panel (H17, 08-ui-spec.md §10; 09-scenarios.md A6, I).
 *
 * Modal with three tabs, available to admins from the user menu:
 *  - Пользователи: table (username, display name, admin, disabled, created),
 *    add-user form, (re)generate API-key (shown exactly once with a «Копировать»
 *    button and a save reminder), enable/disable, delete;
 *  - Сети: all networks with forced deletion;
 *  - Аудит: journal with category/period filters.
 */

import type { AuditLogEntry, Network, User } from '@etn/shared';
import { t } from '../lib/i18n.js';

import { confirmDialog, errorDialog, showDialog } from '../lib/dialog.js';
import { button, div, el, fmtDateTime, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { menuAction, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { uiButton } from '../lib/ui/button.js';
import { checkboxRow } from '../lib/ui/choice-row.js';
import { fieldInput, fieldRow } from '../lib/ui/field.js';
import { operationError } from '../lib/ui/messages.js';
import { loadingState } from '../lib/ui/empty-state.js';
import { createTable } from '../lib/ui/table.js';

/** Opens the admin panel modal. */
export function openAdminPanel(): void {
  // Вкладки — общий механизм каркаса диалога (задача a57e7998): панели
  // строятся лениво при первом показе, переключение не пересобирает узел.
  const pane = (render: (host: HTMLElement) => void): (() => HTMLElement) => () => {
    const host = div('admin-content list-dialog-body');
    render(host);
    return host;
  };

  showDialog({
    title: t('userMenu.admin'),
    size: 'l',
    tabs: [
      { id: 'users', label: t('admin.tab.users'), content: pane((h) => void renderUsers(h)) },
      { id: 'networks', label: t('admin.tab.networks'), content: pane((h) => void renderNetworks(h)) },
      { id: 'audit', label: t('admin.tab.audit'), content: pane((h) => void renderAudit(h)) },
    ],
    // Правило 3 требования 11ddd910: под списком — кнопка решения. Панель
    // информационная, решение одно — «Закрыть».
    buttons: [{ label: t('actions.close'), primary: true }],
  });
}

/**
 * Строка горячего поиска над таблицей вкладки (правило 1 требования 11ddd910):
 * первая строка над списком, плейсхолдер — из словаря.
 */
function adminSearchRow(): { row: HTMLElement; input: HTMLInputElement } {
  const row = div('form-row type-list-search');
  const input = fieldInput({ extraClass: 'admin-search' }) as HTMLInputElement;
  input.type = 'text';
  input.placeholder = t('actions.search');
  row.append(input);
  return { row, input };
}

/** Строка управления над таблицей вкладки (правило 2 требования 11ddd910). */
function adminToolbar(): HTMLElement {
  return div('form-row type-list-toolbar admin-toolbar');
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Renders the users tab. */
async function renderUsers(content: HTMLElement): Promise<void> {
  content.replaceChildren(loadingState());
  let users: User[];
  try {
    users = await etn.admin.listUsers();
  } catch (err) {
    content.replaceChildren(operationError(err));
    return;
  }

  // Правило 1 требования 11ddd910: поиск — первая строка над списком.
  const { row: searchRow, input: searchInput } = adminSearchRow();

  const wrap = div('admin-table-wrap');
  // Список участников — единая таблица фасада `lib/ui/table.ts` (задача
  // ae76b75e, требование 93115633): колонки с сортировкой, текущая строка,
  // клавиатура, копирование Ctrl+C, якорь возврата фокуса. Строки — из словаря.
  // Высота области списка — по раскладке диалога-списка (`.list-dialog-body`):
  // список тянется на свободное место роли и не схлопывается по содержимому
  // (правило 9 требования 11ddd910). Инлайновая высота 400px задавала размер
  // вне роли и «дёргала» раскладку (исправлено в ревизии 0.9.1).
  const table = createTable<User>({
    ariaLabel: t('admin.users.aria'),
    columns: [
      {
        key: 'user',
        header: t('admin.col.user'),
        sortable: true,
        sortValue: (user) => user.display_name ?? user.username,
        text: (user) => `${user.display_name ?? user.username} (${user.username})`,
        render: (user) => {
          const cell = div();
          cell.append(span(user.display_name ?? user.username, undefined));
          cell.append(el('div', 'faint', user.username));
          return cell;
        },
      },
      {
        key: 'role',
        header: t('admin.col.role'),
        sortable: true,
        sortValue: (user) => (user.is_admin ? t('admin.role.admin') : t('admin.role.user')),
        text: (user) => (user.is_admin ? t('admin.role.admin') : t('admin.role.user')),
        render: (user) => span(user.is_admin ? t('admin.role.admin') : t('admin.role.user')),
      },
      {
        key: 'status',
        header: t('admin.col.status'),
        sortable: true,
        sortValue: (user) => (user.disabled ? t('admin.status.disabled') : t('admin.status.active')),
        text: (user) => (user.disabled ? t('admin.status.disabled') : t('admin.status.active')),
        render: (user) => span(user.disabled ? t('admin.status.disabled') : t('admin.status.active')),
      },
      {
        key: 'created',
        header: t('admin.col.created'),
        sortable: true,
        sortValue: (user) => user.created_at,
        text: (user) => fmtDateTime(user.created_at),
        render: (user) => span(fmtDateTime(user.created_at)),
      },
      {
        key: 'actions',
        header: t('admin.col.actions'),
        width: '220px',
        render: (user) => {
          const actions = div('admin-user-actions');
          actions.style.whiteSpace = 'nowrap';
          actions.append(
            button('ключ', () => void generateKey(user), 'link-btn', 'Сгенерировать API-key'),
            span(' · '),
            button(
              user.disabled ? 'включить' : 'отключить',
              () => void toggleDisabled(user),
              'link-btn',
            ),
            span(' · '),
            button('удалить', () => void removeUserRow(user, content), 'link-btn'),
          );
          return actions;
        },
      },
    ],
    rows: [],
    rowKey: (user) => user.id,
    emptyText: t('admin.users.empty'),
    emptyHint: t('admin.users.emptyHint'),
    // Правило 5: строка управления действует на текущую строку.
    onCurrentChange: () => updateButtons(),
    // Правило 8 требования 11ddd910: команды над строкой доступны и из
    // контекстного меню самой строки (те же, что у кнопок над списком).
    rowMenu: (user): MenuItem[] => [
      menuAction(t('admin.user.key'), () => void generateKey(user)),
      menuAction(user.disabled ? t('admin.user.enable') : t('admin.user.disable'), () =>
        void toggleDisabled(user),
      ),
      menuAction(t('actions.delete'), () => void removeUserRow(user, content), { danger: true }),
    ],
  });
  wrap.append(table.element);

  // Правило 2 требования 11ddd910: строка управления НАД списком — действия
  // над ТЕКУЩЕЙ строкой (те же, что и ссылки в ячейке «Действия»; ячейки
  // оставлены, чтобы привычные действия были под рукой).
  const toolbar = adminToolbar();
  const keyBtn = uiButton({
    label: t('admin.user.key'),
    role: 'secondary',
    size: 's',
    title: 'Сгенерировать API-key текущему пользователю',
    disabled: true,
    onClick: () => {
      const user = currentUser();
      if (user !== null) void generateKey(user);
    },
  });
  const toggleBtn = uiButton({
    label: t('admin.user.disable'),
    role: 'secondary',
    size: 's',
    title: 'Включить/отключить текущую учётную запись',
    disabled: true,
    onClick: () => {
      const user = currentUser();
      if (user !== null) void toggleDisabled(user);
    },
  });
  const deleteBtn = uiButton({
    label: t('actions.delete'),
    role: 'secondary',
    size: 's',
    title: 'Удалить текущего пользователя',
    disabled: true,
    onClick: () => {
      const user = currentUser();
      if (user !== null) void removeUserRow(user, content);
    },
  });
  toolbar.append(keyBtn, toggleBtn, deleteBtn);

  /** Текущая строка списка (правило 5). */
  function currentUser(): User | null {
    return table.getCurrent()?.row ?? null;
  }

  /** Гасит кнопки без текущей строки; надпись переключателя — по её статусу. */
  function updateButtons(): void {
    const user = currentUser();
    keyBtn.disabled = user === null;
    toggleBtn.disabled = user === null;
    deleteBtn.disabled = user === null;
    toggleBtn.textContent = user !== null && user.disabled
      ? t('admin.user.enable')
      : t('admin.user.disable');
  }

  /** Клиентский фильтр по имени пользователя (правило 1). */
  function applyFilter(): void {
    const query = searchInput.value.trim().toLowerCase();
    const visible =
      query === ''
        ? users
        : users.filter((user) =>
            `${user.display_name ?? ''} ${user.username}`.toLowerCase().includes(query),
          );
    table.setEmpty(
      users.length === 0
        ? { title: t('admin.users.empty'), hint: t('admin.users.emptyHint') }
        : { title: t('list.emptySearch'), hint: t('list.emptySearchHint') },
    );
    table.setRows(visible);
    updateButtons();
  }
  searchInput.addEventListener('input', () => applyFilter());

  content.replaceChildren(searchRow, toolbar, wrap, addUserRow());
  applyFilter();
}

/** The add-user form under the table. */
function addUserRow(): HTMLElement {
  const box = div('form-row');
  box.style.marginTop = '10px';
  const usernameInput = fieldInput({ placeholder: 'username' });
  usernameInput.style.width = '160px';
  const displayInput = fieldInput({ placeholder: 'Отображаемое имя' });
  displayInput.style.width = '180px';
  const admin = checkboxRow({ label: 'админ' });
  const adminCheck = admin.input;
  const adminLabel = admin.row;
  // «Добавить пользователя» is enabled only when `username` is non-empty
  // (08-ui-spec.md §10.1; the server rejects empty usernames with
  // VALIDATION_ERROR, so the button is useless until the field has a value).
  const submit = uiButton({
    label: 'Добавить пользователя',
    role: 'primary',
    size: 's',
    onClick: () => {
      void (async () => {
        try {
          const result = await etn.admin.createUser({
            username: usernameInput.value.trim(),
            displayName: displayInput.value.trim() || undefined,
            isAdmin: adminCheck.checked,
          });
          showApiKey(result.apiKey);
          void renderUsers(contentOf(box));
        } catch (err) {
          errorDialog('Добавить пользователя', err);
        }
      })();
    },
  });
  const syncSubmit = (): void => {
    submit.disabled = usernameInput.value.trim() === '';
  };
  usernameInput.addEventListener('input', syncSubmit);
  syncSubmit();
  box.append(usernameInput, displayInput, adminLabel, submit);
  return box;
}

/** Finds the admin content container (parent of a child node). */
function contentOf(node: HTMLElement): HTMLElement {
  return node.closest<HTMLElement>('.admin-content') ?? node;
}

/** Generates a transferable API-key and shows it exactly once (A6). */
async function generateKey(user: User): Promise<void> {
  // O8: the key can carry a per-key MCP write rate limit override (empty — the
  // server-wide `mcp.max_writes_per_minute`).
  const limitInput = fieldInput({
    type: 'number',
    min: 1,
    step: 1,
    placeholder: 'серверный лимит',
  });
  limitInput.style.width = '120px';
  const body = div('form-stack');
  const limitRow = div('hint-field');
  limitRow.append(limitInput, span('пусто — серверный лимит', 'muted'));
  body.append(fieldRow({ label: 'Лимит записи MCP (в мин.)', control: limitRow }));
  showDialog({
    title: 'Сгенерировать API-key',
    size: 's',
    body,
    buttons: [
      { label: t('actions.cancel') },
      {
        label: 'Создать',
        primary: true,
        keepOpen: true,
        onClick: (close) => {
          const raw = limitInput.value.trim();
          let maxWritesPerMinute: number | null = null;
          if (raw !== '') {
            const n = Number(raw);
            if (!Number.isInteger(n) || n <= 0) {
              errorDialog('Генерация ключа', new Error('Лимит должен быть положительным целым числом.'));
              return;
            }
            maxWritesPerMinute = n;
          }
          void (async () => {
            try {
              const result = await etn.admin.createUserKey(user.id, 'handoff', maxWritesPerMinute);
              close();
              showApiKey(result.apiKey);
            } catch (err) {
              errorDialog('Генерация ключа', err);
            }
          })();
        },
      },
    ],
  });
}

/** Shows the one-time API-key modal with a copy button. */
function showApiKey(apiKey: string): void {
  const box = div('form-stack');
  box.append(
    el(
      'p',
      'dialog-text',
      'Ключ показан один раз. Сохраните и передайте его пользователю — после закрытия он больше недоступен.',
    ),
  );
  const keyBox = div('api-key-box');
  const code = el('code', undefined, apiKey);
  keyBox.append(code);
  keyBox.append(
    uiButton({
      label: 'Копировать',
      role: 'secondary',
      size: 's',
      onClick: () => {
        void navigator.clipboard.writeText(apiKey).then(
          () => notice('Ключ скопирован.'),
          () => notice('Не удалось скопировать ключ.', 'error'),
        );
      },
    }),
  );
  box.append(keyBox);
  showDialog({
    title: 'API-key (показан один раз)',
    size: 'm',
    body: box,
    buttons: [{ label: t('actions.close'), primary: true }],
  });
}

/** Enables/disables a user account. */
async function toggleDisabled(user: User): Promise<void> {
  try {
    // Users have no numeric version on MVP; the server does not enforce
    // If-Match on /admin/users — the constant keeps the contract honest.
    await etn.admin.updateUser(
      user.id,
      { display_name: user.display_name, is_admin: user.is_admin, disabled: !user.disabled },
      1,
    );
    notice('Учётная запись обновлена.');
    // Re-render the list so the «включить»/«отключить» link and the
    // «Статус» cell reflect the new state (08-ui-spec.md §10.1).
    const content = document.querySelector<HTMLElement>('.admin-content');
    if (content !== null) void renderUsers(content);
  } catch (err) {
    errorDialog('Изменить пользователя', err);
  }
}

/** Deletes a user after confirmation. */
async function removeUserRow(user: User, content: HTMLElement): Promise<void> {
  if (!(await confirmDialog('Удалить пользователя', `Удалить «${user.username}»?`, true))) return;
  try {
    await etn.admin.removeUser(user.id, 1);
    notice('Пользователь удалён.');
    void renderUsers(content);
  } catch (err) {
    errorDialog('Удалить пользователя', err);
  }
}

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

/** Renders the networks tab. */
async function renderNetworks(content: HTMLElement): Promise<void> {
  content.replaceChildren(loadingState());
  let networks: Network[];
  try {
    networks = await etn.admin.listNetworks();
  } catch (err) {
    content.replaceChildren(operationError(err));
    return;
  }
  // Правило 1 требования 11ddd910: поиск — первая строка над списком.
  const { row: searchRow, input: searchInput } = adminSearchRow();

  const wrap = div('admin-table-wrap');
  const table = createTable<Network>({
    ariaLabel: t('admin.networks.aria'),
    columns: [
      {
        key: 'network',
        header: t('admin.col.network'),
        sortable: true,
        sortValue: (network) => network.display_name,
        text: (network) => network.display_name,
        render: (network) => span(network.display_name),
      },
      {
        key: 'owner',
        header: t('admin.col.owner'),
        sortable: true,
        sortValue: (network) => network.owner_id,
        text: (network) => network.owner_id,
        render: (network) => span(network.owner_id),
      },
      {
        key: 'created',
        header: t('admin.col.createdF'),
        sortable: true,
        sortValue: (network) => network.created_at,
        text: (network) => fmtDateTime(network.created_at),
        render: (network) => span(fmtDateTime(network.created_at)),
      },
      {
        key: 'actions',
        header: t('admin.col.actions'),
        width: '140px',
        render: (network) =>
          button('удалить сеть', () => void removeNetworkRow(network, content), 'link-btn'),
      },
    ],
    rows: [],
    rowKey: (network) => network.id,
    emptyText: t('admin.networks.empty'),
    emptyHint: t('admin.networks.emptyHint'),
    onCurrentChange: () => updateButtons(),
    // Правило 8 требования 11ddd910: команда над строкой — в меню самой строки.
    rowMenu: (network): MenuItem[] => [
      menuAction(t('admin.network.delete'), () => void removeNetworkRow(network, content), {
        danger: true,
      }),
    ],
  });
  wrap.append(table.element);

  // Правило 2 требования 11ddd910: управление НАД списком — «Удалить сеть»
  // действует на текущую строку (ссылка в ячейке «Действия» тоже остаётся).
  const toolbar = adminToolbar();
  const deleteBtn = uiButton({
    label: t('admin.network.delete'),
    role: 'secondary',
    size: 's',
    title: 'Удалить текущую сеть',
    disabled: true,
    onClick: () => {
      const network = table.getCurrent()?.row ?? null;
      if (network !== null) void removeNetworkRow(network, content);
    },
  });
  toolbar.append(deleteBtn);

  /** Гасит «Удалить сеть» без текущей строки (правило 2). */
  function updateButtons(): void {
    deleteBtn.disabled = table.getCurrent() === null;
  }

  /** Клиентский фильтр по имени сети и владельцу (правило 1). */
  function applyFilter(): void {
    const query = searchInput.value.trim().toLowerCase();
    const visible =
      query === ''
        ? networks
        : networks.filter((network) =>
            `${network.display_name} ${network.owner_id}`.toLowerCase().includes(query),
          );
    table.setEmpty(
      networks.length === 0
        ? { title: t('admin.networks.empty'), hint: t('admin.networks.emptyHint') }
        : { title: t('list.emptySearch'), hint: t('list.emptySearchHint') },
    );
    table.setRows(visible);
    updateButtons();
  }
  searchInput.addEventListener('input', () => applyFilter());

  content.replaceChildren(searchRow, toolbar, wrap);
  applyFilter();
}

/** Удаляет сеть после подтверждения и перерисовывает список. */
async function removeNetworkRow(network: Network, content: HTMLElement): Promise<void> {
  if (
    !(await confirmDialog('Удалить сеть', `Удалить сеть «${network.display_name}»?`, true))
  ) {
    return;
  }
  try {
    await etn.admin.removeNetwork(network.id);
    notice('Сеть удалена.');
    void renderNetworks(content);
  } catch (err) {
    errorDialog('Удалить сеть', err);
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Renders the audit tab with filters. */
function renderAudit(content: HTMLElement): void {
  // Правило 1 требования 11ddd910: поиск — первая строка над списком.
  const { row: searchRow, input: searchInput } = adminSearchRow();

  const filterRow = div('form-row');
  filterRow.style.marginBottom = '8px';
  const categorySelect = el('select', 'select-input');
  categorySelect.style.width = '150px';
  const categoryPlaceholder = el('option', undefined, 'Все категории');
  categoryPlaceholder.value = '';
  categorySelect.append(categoryPlaceholder);
  for (const category of ['auth', 'user', 'network', 'membership', 'data', 'system']) {
    const option = el('option', undefined, category);
    option.value = category;
    categorySelect.append(option);
  }
  const fromInput = fieldInput({ type: 'date' });
  fromInput.style.width = '140px';
  const toInput = fieldInput({ type: 'date' });
  toInput.style.width = '140px';
  filterRow.append(
    span('Категория:'),
    categorySelect,
    span('с', undefined),
    fromInput,
    span('по', undefined),
    toInput,
    uiButton({
      label: 'Показать',
      role: 'secondary',
      size: 's',
      onClick: () => void loadAudit(),
    }),
  );
  const tableWrap = div('admin-table-wrap');
  // Строки управления над списком у журнала нет: он только для чтения —
  // над текущей строкой нечего производить (правила 2 и 5 к нему не применимы).
  // Высота области списка — по раскладке `.list-dialog-body`, а не инлайном
  // (правило 9 требования 11ddd910).
  content.append(searchRow, filterRow, tableWrap);

  /** Загруженные записи журнала — источник клиентского фильтра поиска. */
  let loaded: AuditLogEntry[] = [];

  /** Строка-кандидат поиска: все текстовые поля записи. */
  const auditHaystack = (entry: AuditLogEntry): string =>
    [
      fmtDateTime(entry.ts),
      entry.actor_user_id ?? '',
      entry.network_id ?? '',
      entry.category,
      entry.action,
      entry.target_type ?? '',
      entry.target_id ?? '',
    ]
      .join(' ')
      .toLowerCase();

  /** Показывает записи с учётом клиентского поиска (правило 1). */
  function paint(): void {
    const query = searchInput.value.trim().toLowerCase();
    const rows =
      query === '' ? loaded : loaded.filter((entry) => auditHaystack(entry).includes(query));
    const table = createTable<AuditLogEntry>({
      ariaLabel: t('admin.audit.aria'),
      columns: [
        {
          key: 'ts',
          header: t('admin.col.time'),
          sortable: true,
          sortValue: (entry) => entry.ts,
          text: (entry) => fmtDateTime(entry.ts),
          render: (entry) => span(fmtDateTime(entry.ts)),
        },
        {
          key: 'actor',
          header: t('admin.col.who'),
          sortable: true,
          sortValue: (entry) => entry.actor_user_id ?? '',
          text: (entry) => entry.actor_user_id ?? '—',
          render: (entry) => span(entry.actor_user_id ?? '—'),
        },
        {
          key: 'network',
          header: t('admin.col.network'),
          sortable: true,
          sortValue: (entry) => entry.network_id ?? '',
          text: (entry) => entry.network_id ?? '—',
          render: (entry) => span(entry.network_id ?? '—'),
        },
        {
          key: 'category',
          header: t('admin.col.category'),
          sortable: true,
          sortValue: (entry) => entry.category,
          text: (entry) => entry.category,
          render: (entry) => span(entry.category),
        },
        {
          key: 'action',
          header: t('admin.col.action'),
          sortable: true,
          sortValue: (entry) => entry.action,
          text: (entry) => entry.action,
          render: (entry) => span(entry.action),
        },
        {
          key: 'target',
          header: t('admin.col.target'),
          text: (entry) =>
            `${entry.target_type ?? ''} ${entry.target_id ?? ''}`.trim() || '—',
          render: (entry) =>
            span(`${entry.target_type ?? ''} ${entry.target_id ?? ''}`.trim() || '—'),
        },
      ],
      rows,
      rowKey: (entry) => String(entry.id),
      emptyText: t('admin.audit.empty'),
      emptyHint: t('admin.audit.emptyHint'),
    });
    tableWrap.replaceChildren(
      table.element,
      el('p', 'faint', `Всего записей: ${loaded.length}`),
    );
  }
  searchInput.addEventListener('input', () => paint());

  async function loadAudit(): Promise<void> {
    tableWrap.replaceChildren(loadingState());
    try {
      const result = (await etn.admin.listAudit({
        category: categorySelect.value === '' ? undefined : categorySelect.value,
        from: fromInput.value === '' ? undefined : fromInput.value,
        to: toInput.value === '' ? undefined : toInput.value,
        limit: 100,
      })) as { entries: AuditLogEntry[]; total: number };
      loaded = result.entries;
      paint();
    } catch (err) {
      tableWrap.replaceChildren(operationError(err));
    }
  }

  void loadAudit();
}
