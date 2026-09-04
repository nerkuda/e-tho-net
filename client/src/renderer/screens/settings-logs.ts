/**
 * Settings dialog section «Логирование» (task 92b89e6f, 08-ui-spec.md §9.7;
 * 07-client-electron.md §7): on-screen control of the client and server
 * diagnostic journals.
 *
 * The section is deliberately NOT part of the draft/«Применить» model of the
 * rest of the dialog: journal switches are a diagnostic action, not a
 * configuration preference, so every control applies IMMEDIATELY —
 * a toggle fires the corresponding IPC call at once, and the buttons are
 * one-shot actions (with a confirmation on the destructive ones).
 *
 * - **Клиент** block: `system.getClientLogState` / `setClientLogging` /
 *   `openClientLog` / `deleteClientLogs` — works without a server connection.
 * - **Сервер** block: `system.getServerLogging` / `setServerLogging` /
 *   `downloadServerLog` / `openServerLog` / `deleteServerLogs`. The server
 *   endpoints are admin-only REST: when the status call fails (no admin
 *   rights, server unreachable) the whole block stays disabled with the
 *   human-readable reason — the section never blocks on or hides behind a
 *   thrown promise.
 *
 * All feedback is inline (a message line per block) — no alert dialogs.
 */

import type { SystemLoggingStatus } from '@etn/shared';

import type { ClientLogState, DeleteLogsResult } from '../../main/ipc/contract.js';
import { confirmDialog } from '../lib/dialog.js';
import { button, div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';

/**
 * Confirmation seam: unit tests substitute their own resolver, the dialog
 * stays the production default.
 */
export interface LogsSectionOptions {
  confirm?: (title: string, message: string) => Promise<boolean>;
}

/** Builds the whole «Логирование» section of the settings dialog. */
export function buildLogsSection(opts: LogsSectionOptions = {}): HTMLElement {
  const confirm = opts.confirm ?? confirmDialog;
  const root = div('settings-section');

  // -- client block -------------------------------------------------------
  let clientState: ClientLogState | null = null;
  const clientBox = div('settings-logs-block');
  const clientMsg = span('', 'muted');

  function setClientMsg(text: string, isError = false): void {
    clientMsg.textContent = text;
    clientMsg.className = isError ? 'error-text' : 'muted';
  }

  function renderClient(): void {
    clientBox.replaceChildren(
      el('h3', 'settings-section-title', 'Клиент'),
      el(
        'p',
        'muted',
        'Файловый журнал клиента для диагностики. Переключатель применяется немедленно; ERROR-записи пишутся всегда.',
      ),
    );

    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = clientState?.enabled ?? false;
    toggle.disabled = clientState === null;
    toggle.addEventListener('change', () => {
      const next = toggle.checked;
      toggle.disabled = true;
      void etn.system
        .setClientLogging(next)
        .then((state) => {
          clientState = state;
          setClientMsg(next ? 'Логирование клиента включено.' : 'Логирование клиента выключено.');
          renderClient();
        })
        .catch((err: unknown) => {
          // Immediate apply failed — revert the visual state and say why.
          toggle.checked = !next;
          setClientMsg(errText(err), true);
        })
        .finally(() => {
          toggle.disabled = false;
        });
    });
    const toggleLabel = el('label', 'checkbox-row');
    toggleLabel.append(toggle, span('Логирование клиента'));

    const filePath = clientState?.logFile ?? '—';
    const fileCode = el('code', 'settings-log-path', filePath);
    fileCode.title = filePath;

    const btnRow = div('form-row');
    const btnOpen = button('Открыть', () => void openClientJournal(), 'btn small', 'Открыть файл журнала');
    btnOpen.disabled = clientState === null;
    const btnDelete = button(
      'Удалить',
      () => void deleteClientJournals(),
      'btn small danger',
      'Удалить все файлы журнала клиента',
    );
    btnDelete.disabled = clientState === null;
    btnRow.append(btnOpen, btnDelete);

    clientBox.append(
      toggleLabel,
      el('p', 'muted', 'Текущий файл журнала:'),
      fileCode,
      btnRow,
      clientMsg,
    );
  }

  async function openClientJournal(): Promise<void> {
    try {
      const err = await etn.system.openClientLog();
      if (err !== '') setClientMsg(err, true);
    } catch (err) {
      setClientMsg(errText(err), true);
    }
  }

  async function deleteClientJournals(): Promise<void> {
    const ok = await confirm(
      'Удалить журналы клиента?',
      'Все файлы журнала клиента будут удалены, текущий суточный файл — очищен. Действие необратимо.',
    );
    if (!ok) return;
    try {
      const result: DeleteLogsResult = await etn.system.deleteClientLogs();
      setClientMsg(`Удалено файлов: ${result.deleted}; текущий файл усечён.`);
      clientState = await etn.system.getClientLogState();
      renderClient();
    } catch (err) {
      setClientMsg(errText(err), true);
    }
  }

  // -- server block -------------------------------------------------------
  let serverStatus: SystemLoggingStatus | null = null;
  /** Human-readable reason while the server block is unavailable (or null). */
  let serverError: string | null = null;
  /** Name of the file selected in the list (radio), or null. */
  let selectedServerFile: string | null = null;
  const serverBox = div('settings-logs-block settings-logs-block-spaced');
  const serverMsg = span('', 'muted');

  function setServerMsg(text: string, isError = false): void {
    serverMsg.textContent = text;
    serverMsg.className = isError ? 'error-text' : 'muted';
  }

  function renderServer(): void {
    serverBox.replaceChildren(
      el('h3', 'settings-section-title', 'Сервер'),
    );

    if (serverError !== null) {
      // Admin-only endpoints refused us or the server is unreachable — the
      // block shows the reason and stays inert (08-ui-spec.md §9.7).
      serverBox.append(
        el('p', 'error-text', serverError),
        el('p', 'muted', 'Управление журналом сервера доступно администратору при подключённом сервере.'),
      );
      return;
    }

    const status = serverStatus;
    serverBox.append(
      el(
        'p',
        'muted',
        'Файловый журнал сервера для диагностики. Флаг живёт в памяти сервера и сбрасывается при перезапуске; переключатель применяется немедленно.',
      ),
    );

    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = status?.enabled ?? false;
    toggle.disabled = status === null;
    toggle.addEventListener('change', () => {
      const next = toggle.checked;
      toggle.disabled = true;
      void etn.system
        .setServerLogging(next)
        .then((fresh) => {
          serverStatus = fresh;
          setServerMsg(next ? 'Логирование сервера включено.' : 'Логирование сервера выключено.');
          renderServer();
        })
        .catch((err: unknown) => {
          toggle.checked = !next;
          setServerMsg(errText(err), true);
        })
        .finally(() => {
          toggle.disabled = false;
        });
    });
    const toggleLabel = el('label', 'checkbox-row');
    toggleLabel.append(toggle, span('Логирование сервера'));

    const dir = status?.logDir ?? '—';
    const dirCode = el('code', 'settings-log-path', dir);
    dirCode.title = dir;

    const filesWrap = div('admin-table-wrap');
    if (status === null) {
      filesWrap.append(el('span', 'muted', 'Загрузка…'));
    } else if (status.files.length === 0) {
      filesWrap.append(el('p', 'muted', 'Файлов журнала сервера ещё нет.'));
    } else {
      const table = el('table', 'table-list settings-log-files');
      const tbody = el('tbody');
      for (const file of status.files) {
        const row = el('tr');
        const pick = el('input');
        pick.type = 'radio';
        pick.name = 'settings-server-log-file';
        pick.checked = file.name === selectedServerFile;
        pick.addEventListener('change', () => {
          selectedServerFile = pick.checked ? file.name : null;
        });
        const pickCell = el('td');
        pickCell.append(pick);
        row.append(
          pickCell,
          el('td', 'settings-log-file-name', file.name),
          el('td', undefined, formatBytes(file.sizeBytes)),
          el('td', undefined, file.date),
        );
        tbody.append(row);
      }
      table.append(tbody);
      filesWrap.append(table);
    }

    const btnRow = div('form-row');
    const btnDownload = button(
      'Скачать…',
      () => void downloadServerJournal(),
      'btn small',
      'Скачать файл журнала сервера',
    );
    btnDownload.disabled = status === null;
    const btnOpen = button(
      'Открыть',
      () => void openServerJournal(),
      'btn small',
      'Открыть текущий файл журнала сервера',
    );
    btnOpen.disabled = status === null;
    const btnDelete = button(
      'Удалить',
      () => void deleteServerJournals(),
      'btn small danger',
      'Удалить все файлы журнала сервера',
    );
    btnDelete.disabled = status === null;
    btnRow.append(btnDownload, btnOpen, btnDelete);

    serverBox.append(
      toggleLabel,
      el('p', 'muted', `Каталог журнала на сервере (хранение ${status?.retentionDays ?? '—'} дн.):`),
      dirCode,
      el('p', 'muted', 'Файлы журнала (выберите файл для скачивания):'),
      filesWrap,
      btnRow,
      serverMsg,
    );
  }

  async function downloadServerJournal(): Promise<void> {
    try {
      const result = await etn.system.downloadServerLog(selectedServerFile ?? undefined);
      if (result.error !== undefined && result.error !== '') {
        setServerMsg(result.error, true);
        return;
      }
      if (result.cancelled) return;
      setServerMsg(`Сохранено: ${result.saved_path ?? ''}`);
    } catch (err) {
      setServerMsg(errText(err), true);
    }
  }

  async function openServerJournal(): Promise<void> {
    try {
      const err = await etn.system.openServerLog();
      if (err !== '') setServerMsg(err, true);
    } catch (err) {
      setServerMsg(errText(err), true);
    }
  }

  async function deleteServerJournals(): Promise<void> {
    const ok = await confirm(
      'Удалить журналы сервера?',
      'Все файлы журнала сервера будут удалены, текущий суточный файл — очищен. Действие необратимо.',
    );
    if (!ok) return;
    try {
      await etn.system.deleteServerLogs();
      serverStatus = await etn.system.getServerLogging();
      setServerMsg('Файлы журнала сервера удалены.');
      selectedServerFile = null;
      renderServer();
    } catch (err) {
      setServerMsg(errText(err), true);
    }
  }

  // -- assembly -------------------------------------------------------------
  root.append(clientBox, serverBox);

  renderClient();
  renderServer();

  void etn.system
    .getClientLogState()
    .then((state) => {
      clientState = state;
      renderClient();
    })
    .catch((err: unknown) => {
      setClientMsg(errText(err), true);
    });

  void etn.system
    .getServerLogging()
    .then((status) => {
      serverStatus = status;
      renderServer();
    })
    .catch((err: unknown) => {
      serverError = serverUnavailableReason(err);
      renderServer();
    });

  return root;
}

/**
 * Classifies a failed `system.getServerLogging` into a user-facing reason:
 * admin rights refused vs server unreachable vs anything else (shown verbatim).
 */
export function serverUnavailableReason(err: unknown): string {
  const msg = errText(err);
  if (/права администратора|FORBIDDEN/i.test(msg)) {
    return 'Нет прав администратора: управление журналом сервера доступно только администратору.';
  }
  if (
    /not connected|fetch|network|econnrefused|enotfound|etimedout|timeout|unavailable|502|503|504/i.test(
      msg,
    )
  ) {
    return `Сервер недоступен (${msg}).`;
  }
  return `Не удалось получить состояние журнала сервера: ${msg}`;
}

/** Formats a byte size in Russian units (`Б` / `КБ` / `МБ`). */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Test seam: internals reused by unit tests. */
export const logsSectionInternals = { serverUnavailableReason, formatBytes };
