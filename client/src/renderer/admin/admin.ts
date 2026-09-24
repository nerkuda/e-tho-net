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
import { notice } from '../lib/notice.js';
import { uiButton } from '../lib/ui/button.js';
import { checkboxRow } from '../lib/ui/choice-row.js';
import { fieldInput, fieldRow } from '../lib/ui/field.js';
import { operationError } from '../lib/ui/messages.js';

/** Opens the admin panel modal. */
export function openAdminPanel(): void {
  // Вкладки — общий механизм каркаса диалога (задача a57e7998): панели
  // строятся лениво при первом показе, переключение не пересобирает узел.
  const pane = (render: (host: HTMLElement) => void): (() => HTMLElement) => () => {
    const host = div('admin-content');
    render(host);
    return host;
  };

  showDialog({
    title: 'Администрирование',
    size: 'l',
    tabs: [
      { id: 'users', label: 'Пользователи', content: pane((h) => void renderUsers(h)) },
      { id: 'networks', label: 'Сети', content: pane((h) => void renderNetworks(h)) },
      { id: 'audit', label: 'Аудит', content: pane((h) => void renderAudit(h)) },
    ],
  });
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
    content.replaceChildren(operationError(err));
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
      span(' · '),
      button(user.disabled ? 'включить' : 'отключить', () => void toggleDisabled(user), 'link-btn'),
      span(' · '),
      button('удалить', () => void removeUserRow(user, content), 'link-btn'),
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
  content.replaceChildren(el('span', 'muted', 'Загрузка…'));
  let networks: Network[];
  try {
    networks = await etn.admin.listNetworks();
  } catch (err) {
    content.replaceChildren(operationError(err));
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
      tableWrap.replaceChildren(operationError(err));
    }
  }

  void loadAudit();
}
