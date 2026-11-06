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
      el('h3', 'settings-section-title', t('settingsLogs.client')),
      el(
        'p',
        'muted',
        t('settingsLogs.fileLogClientDiagnosticsToggleApply'),
      ),
    );

    const logToggle = checkboxRow({
      label: t('settingsLogs.label.loggingClient'),
      checked: clientState?.enabled ?? false,
      disabled: clientState === null,
      onChange: (next) => {
        const toggle = logToggle.input;
        toggle.disabled = true;
        void etn.system
          .setClientLogging(next)
          .then((state) => {
            clientState = state;
            setClientMsg(next ? t('settingsLogs.loggingClientEnabled') : t('settingsLogs.loggingClientDisabled'));
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
      label: t('properties.label.open'),
      role: 'secondary',
      size: 's',
      title: t('settingsLogs.title.openFileLog'),
      onClick: () => void openClientJournal(),
    });
    btnOpen.disabled = clientState === null;
    const btnDelete = uiButton({
      label: t('actions.delete'),
      role: 'danger',
      size: 's',
      title: t('settingsLogs.deleteAllFilesLogClient'),
      onClick: () => void deleteClientJournals(),
    });
    btnDelete.disabled = clientState === null;
    btnRow.append(btnOpen, btnDelete);

    clientBox.append(
      toggleLabel,
      el('p', 'muted', t('settingsLogs.currentFileLog')),
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
      t('settingsLogs.deleteLogsClient'),
      t('settingsLogs.allFilesLogClientWillDeleted'),
    );
    if (!ok) return;
    try {
      const result: DeleteLogsResult = await etn.system.deleteClientLogs();
      setClientMsg(t('settingsLogs.deletedFilesCurrentFileUsechen', result.deleted));
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
      el('h3', 'settings-section-title', t('settingsLogs.server')),
    );

    if (serverError !== null) {
      // Admin-only endpoints refused us or the server is unreachable — the
      // block shows the reason and stays inert (08-ui-spec.md §9.7).
      serverBox.append(
        errorParagraph(serverError),
        el('p', 'muted', t('settingsLogs.upravlenieLogServerDostupnoAdminPodklyuchennom')),
      );
      return;
    }

    const status = serverStatus;
    serverBox.append(
      el(
        'p',
        'muted',
        t('settingsLogs.fileLogServerDiagnosticsFlagZhivet'),
      ),
    );

    const logToggle = checkboxRow({
      label: t('settingsLogs.label.loggingServer'),
      checked: status?.enabled ?? false,
      disabled: status === null,
      onChange: (next) => {
        const toggle = logToggle.input;
        toggle.disabled = true;
        void etn.system
          .setServerLogging(next)
          .then((fresh) => {
            serverStatus = fresh;
            setServerMsg(next ? t('settingsLogs.loggingServerEnabled') : t('settingsLogs.loggingServerDisabled'));
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
      filesWrap.append(el('span', 'muted', t('common.loading')));
    } else if (status.files.length === 0) {
      filesWrap.append(el('p', 'muted', t('settingsLogs.filesLogServerMoreNo')));
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
      label: t('settingsLogs.label.download'),
      role: 'secondary',
      size: 's',
      title: t('settingsLogs.title.downloadFileLogServer'),
      onClick: () => void downloadServerJournal(),
    });
    btnDownload.disabled = status === null;
    const btnOpen = uiButton({
      label: t('properties.label.open'),
      role: 'secondary',
      size: 's',
      title: t('settingsLogs.openCurrentFileLogServer'),
      onClick: () => void openServerJournal(),
    });
    btnOpen.disabled = status === null;
    const btnDelete = uiButton({
      label: t('actions.delete'),
      role: 'danger',
      size: 's',
      title: t('settingsLogs.deleteAllFilesLogServer'),
      onClick: () => void deleteServerJournals(),
    });
    btnDelete.disabled = status === null;
    btnRow.append(btnDownload, btnOpen, btnDelete);

    serverBox.append(
      toggleLabel,
      el('p', 'muted', t('settingsLogs.katalogLogServerHranenieD', status?.retentionDays ?? '—')),
      dirCode,
      el('p', 'muted', t('settingsLogs.filesLogSelectFileSkachivaniya')),
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
      setServerMsg(t('settingsLogs.saved', result.saved_path ?? ''));
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
      t('settingsLogs.deleteLogsServer'),
      t('settingsLogs.allFilesLogServerWillDeleted'),
    );
    if (!ok) return;
    try {
      await etn.system.deleteServerLogs();
      serverStatus = await etn.system.getServerLogging();
      setServerMsg(t('settingsLogs.filesLogServerDeleted'));
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
    return t('settingsLogs.noPravAdminUpravlenieLogServer');
  }
  // `errText` already maps connection-lost/INTERNAL/raw transport failures to
  // friendly lowercase phrases (GUI review remark); recognise them here while
  // still classifying legacy raw messages.
  if (
    msg === t('errors.connectionLost') ||
    msg === t('errors.serverUnavailable') ||
    /not connected|fetch|network|econnrefused|enotfound|etimedout|timeout|unavailable|502|503|504/i.test(
      msg,
    )
  ) {
    return t('settingsLogs.serverUnavailablePoprobuytePozzhe');
  }
  return t('settingsLogs.notSucceededPoluchitStateLogServer', msg);
}

/** Formats a byte size in Russian units (`Б` / `КБ` / `МБ`). */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return t('settingsLogs.b', size);
  if (size < 1024 * 1024) return t('settingsLogs.kb', (size / 1024).toFixed(1));
  return t('settingsLogs.mb', (size / (1024 * 1024)).toFixed(1));
}

/** Test seam: internals reused by unit tests. */
export const logsSectionInternals = { serverUnavailableReason, formatBytes };
