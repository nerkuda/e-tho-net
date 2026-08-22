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

import { confirmDialog, errorDialog, field, showDialog } from '../lib/dialog.js';
import { button, div, el, errText, fmtDateTime, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';

/** Opens the admin panel modal. */
export function openAdminPanel(): void {
  const tabs = ['users', 'networks', 'audit'] as const;
  let active: (typeof tabs)[number] = 'users';

  const tabRow = div('admin-tabs');
  const content = div('admin-content');

  const tabButton = (key: (typeof tabs)[number], label: string): HTMLButtonElement => {
    const btn = button(
      label,
      () => {
        active = key;
        refresh();
      },
      `admin-tab${active === key ? ' active' : ''}`,
    );
    return btn;
  };
  tabRow.append(
    tabButton('users', 'Пользователи'),
    tabButton('networks', 'Сети'),
    tabButton('audit', 'Аудит'),
  );

  const body = div('admin-panel');
  body.append(tabRow, content);

  function refresh(): void {
    for (const btn of Array.from(tabRow.querySelectorAll<HTMLElement>('.admin-tab'))) {
      btn.classList.remove('active');
    }
    const index = tabs.indexOf(active);
    const activeBtn = tabRow.children[index];
    if (activeBtn !== undefined) activeBtn.classList.add('active');
    content.replaceChildren();
    switch (active) {
      case 'users':
        void renderUsers(content);
        break;
      case 'networks':
        void renderNetworks(content);
        break;
      case 'audit':
        void renderAudit(content);
        break;
    }
  }

  showDialog({ title: 'Администрирование', body, width: 760 });
  refresh();
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Renders the users tab. */
async function renderUsers(content: HTMLElement): Promise<void> {
  content.replaceChildren(el('span', 'muted', 'Загрузка…'));
  let users: User[];
  try {
    users = await etn.admin.listUsers();
  } catch (err) {
    content.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
    return;
  }

  const wrap = div('admin-table-wrap');
  const table = el('table', 'admin-table');
  const head = el('thead');
  const headRow = el('tr');
  headRow.append(
    el('th', undefined, 'Пользователь'),
    el('th', undefined, 'Роль'),
    el('th', undefined, 'Статус'),
    el('th', undefined, 'Создан'),
    el('th', undefined, 'Действия'),
  );
  head.append(headRow);
  table.append(head);
  const tbody = el('tbody');
  for (const user of users) {
    const row = el('tr');
    const name = el('td');
    name.append(span(`${user.display_name ?? user.username}`, undefined));
    name.append(el('div', 'faint', user.username));
    row.append(
      name,
      el('td', undefined, user.is_admin ? 'админ' : 'пользователь'),
      el('td', undefined, user.disabled ? 'отключен' : 'активен'),
      el('td', undefined, fmtDateTime(user.created_at)),
    );
    const actions = el('td');
    actions.style.whiteSpace = 'nowrap';
    actions.append(
      button('ключ', () => void generateKey(user), 'link-btn', 'Сгенерировать API-key'),
      button(user.disabled ? 'включить' : 'отключить', () => void toggleDisabled(user), 'link-btn'),
      button('удалить', () => void removeUserRow(user), 'link-btn'),
    );
    row.append(actions);
    tbody.append(row);
  }
  table.append(tbody);
  wrap.append(table);
  content.replaceChildren(wrap, addUserRow());
}

/** The add-user form under the table. */
function addUserRow(): HTMLElement {
  const box = div('form-row');
  box.style.marginTop = '10px';
  const usernameInput = el('input', 'text-input');
  usernameInput.type = 'text';
  usernameInput.placeholder = 'username';
  usernameInput.style.width = '160px';
  const displayInput = el('input', 'text-input');
  displayInput.type = 'text';
  displayInput.placeholder = 'Отображаемое имя';
  displayInput.style.width = '180px';
  const adminLabel = el('label', 'checkbox-row');
  const adminCheck = el('input');
  adminCheck.type = 'checkbox';
  adminLabel.append(adminCheck, span('админ'));
  box.append(
    usernameInput,
    displayInput,
    adminLabel,
    button(
      'Добавить пользователя',
      () => {
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
      'btn small primary',
    ),
  );
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
  const limitInput = el('input', 'text-input');
  limitInput.type = 'number';
  limitInput.min = '1';
  limitInput.step = '1';
  limitInput.placeholder = 'серверный лимит';
  limitInput.style.width = '120px';
  const body = div('form-stack');
  const limitRow = div('hint-field');
  limitRow.append(limitInput, span('пусто — серверный лимит', 'muted'));
  body.append(field('Лимит записи MCP (в мин.)', limitRow));
  showDialog({
    title: 'Сгенерировать API-key',
    body,
    buttons: [
      { label: 'Отмена' },
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
    button(
      'Копировать',
      () => {
        void navigator.clipboard.writeText(apiKey).then(
          () => notice('Ключ скопирован.'),
          () => notice('Не удалось скопировать ключ.', 'error'),
        );
      },
      'btn small',
    ),
  );
  box.append(keyBox);
  showDialog({
    title: 'API-key (показан один раз)',
    body: box,
    buttons: [{ label: 'Закрыть', primary: true }],
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
  } catch (err) {
    errorDialog('Изменить пользователя', err);
  }
}

/** Deletes a user after confirmation. */
async function removeUserRow(user: User): Promise<void> {
  if (!(await confirmDialog('Удалить пользователя', `Удалить «${user.username}»?`, true))) return;
  try {
    await etn.admin.removeUser(user.id, 1);
    notice('Пользователь удалён.');
  } catch (err) {
    errorDialog('Удалить пользователя', err);
  }
}

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

/** Renders the networks tab. */
async function renderNetworks(content: HTMLElement): Promise<void> {
  content.replaceChildren(el('span', 'muted', 'Загрузка…'));
  let networks: Network[];
  try {
    networks = await etn.admin.listNetworks();
  } catch (err) {
    content.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
    return;
  }
  const wrap = div('admin-table-wrap');
  const table = el('table', 'admin-table');
  const head = el('thead');
  const headRow = el('tr');
  headRow.append(
    el('th', undefined, 'Сеть'),
    el('th', undefined, 'Владелец'),
    el('th', undefined, 'Создана'),
    el('th', undefined, 'Действия'),
  );
  head.append(headRow);
  table.append(head);
  const tbody = el('tbody');
  for (const network of networks) {
    const row = el('tr');
    row.append(
      el('td', undefined, network.display_name),
      el('td', undefined, network.owner_id),
      el('td', undefined, fmtDateTime(network.created_at)),
    );
    const actions = el('td');
    actions.append(
      button(
        'удалить сеть',
        () => {
          void (async () => {
            if (
              !(await confirmDialog(
                'Удалить сеть',
                `Удалить сеть «${network.display_name}»?`,
                true,
              ))
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
          })();
        },
        'link-btn',
      ),
    );
    row.append(actions);
    tbody.append(row);
  }
  table.append(tbody);
  wrap.append(table);
  content.replaceChildren(wrap);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Renders the audit tab with filters. */
function renderAudit(content: HTMLElement): void {
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
  const fromInput = el('input', 'text-input');
  fromInput.type = 'date';
  fromInput.style.width = '140px';
  const toInput = el('input', 'text-input');
  toInput.type = 'date';
  toInput.style.width = '140px';
  filterRow.append(
    span('Категория:'),
    categorySelect,
    span('с', undefined),
    fromInput,
    span('по', undefined),
    toInput,
    button('Показать', () => void loadAudit(), 'btn small'),
  );
  const tableWrap = div('admin-table-wrap');
  content.append(filterRow, tableWrap);

  async function loadAudit(): Promise<void> {
    tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
    try {
      const result = (await etn.admin.listAudit({
        category: categorySelect.value === '' ? undefined : categorySelect.value,
        from: fromInput.value === '' ? undefined : fromInput.value,
        to: toInput.value === '' ? undefined : toInput.value,
        limit: 100,
      })) as { entries: AuditLogEntry[]; total: number };
      const table = el('table', 'admin-table');
      const head = el('thead');
      const headRow = el('tr');
      headRow.append(
        el('th', undefined, 'Время'),
        el('th', undefined, 'Кто'),
        el('th', undefined, 'Сеть'),
        el('th', undefined, 'Категория'),
        el('th', undefined, 'Действие'),
        el('th', undefined, 'Цель'),
      );
      head.append(headRow);
      table.append(head);
      const tbody = el('tbody');
      for (const entry of result.entries) {
        const row = el('tr');
        row.append(
          el('td', undefined, fmtDateTime(entry.ts)),
          el('td', undefined, entry.actor_user_id ?? '—'),
          el('td', undefined, entry.network_id ?? '—'),
          el('td', undefined, entry.category),
          el('td', undefined, entry.action),
          el('td', undefined, `${entry.target_type ?? ''} ${entry.target_id ?? ''}`.trim() || '—'),
        );
        tbody.append(row);
      }
      table.append(tbody);
      tableWrap.replaceChildren(table, el('p', 'faint', `Всего записей: ${result.total}`));
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
    }
  }

  void loadAudit();
}
