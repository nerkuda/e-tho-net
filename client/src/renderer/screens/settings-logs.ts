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
import { t } from '../lib/i18n.js';

import type { ClientLogState, DeleteLogsResult } from '../../main/ipc/contract.js';
import { confirmDialog } from '../lib/dialog.js';
import { div, el, errText, span } from '../lib/dom.js';
import { errorParagraph, setStatusText } from '../lib/ui/messages.js';
import { etn } from '../lib/etn.js';
import { uiButton } from '../lib/ui/button.js';
import { checkboxRow, choiceControl } from '../lib/ui/choice-row.js';

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
    setStatusText(clientMsg, text, isError);
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

    const logToggle = checkboxRow({
      label: 'Логирование клиента',
      checked: clientState?.enabled ?? false,
      disabled: clientState === null,
      onChange: (next) => {
        const toggle = logToggle.input;
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
      },
    });
    const toggleLabel = logToggle.row;

    const filePath = clientState?.logFile ?? '—';
    const fileCode = el('code', 'settings-log-path', filePath);
    fileCode.title = filePath;

    const btnRow = div('form-row');
    const btnOpen = uiButton({
      label: 'Открыть',
      role: 'secondary',
      size: 's',
      title: 'Открыть файл журнала',
      onClick: () => void openClientJournal(),
    });
    btnOpen.disabled = clientState === null;
    const btnDelete = uiButton({
      label: t('actions.delete'),
      role: 'danger',
      size: 's',
      title: 'Удалить все файлы журнала клиента',
      onClick: () => void deleteClientJournals(),
    });
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
    setStatusText(serverMsg, text, isError);
  }

  function renderServer(): void {
    serverBox.replaceChildren(
      el('h3', 'settings-section-title', 'Сервер'),
    );

    if (serverError !== null) {
      // Admin-only endpoints refused us or the server is unreachable — the
      // block shows the reason and stays inert (08-ui-spec.md §9.7).
      serverBox.append(
        errorParagraph(serverError),
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

    const logToggle = checkboxRow({
      label: 'Логирование сервера',
      checked: status?.enabled ?? false,
      disabled: status === null,
      onChange: (next) => {
        const toggle = logToggle.input;
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
      },
    });
    const toggleLabel = logToggle.row;

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
        const pick = choiceControl('radio', {
          name: 'settings-server-log-file',
          checked: file.name === selectedServerFile,
          onChange: (checked) => {
            selectedServerFile = checked ? file.name : null;
          },
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
    const btnDownload = uiButton({
      label: 'Скачать…',
      role: 'secondary',
      size: 's',
      title: 'Скачать файл журнала сервера',
      onClick: () => void downloadServerJournal(),
    });
    btnDownload.disabled = status === null;
    const btnOpen = uiButton({
      label: 'Открыть',
      role: 'secondary',
      size: 's',
      title: 'Открыть текущий файл журнала сервера',
      onClick: () => void openServerJournal(),
    });
    btnOpen.disabled = status === null;
    const btnDelete = uiButton({
      label: t('actions.delete'),
      role: 'danger',
      size: 's',
      title: 'Удалить все файлы журнала сервера',
      onClick: () => void deleteServerJournals(),
    });
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
