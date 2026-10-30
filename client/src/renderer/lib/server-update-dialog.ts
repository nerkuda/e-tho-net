/**
 * Диалог обновления сервера (элемент интерфейса c9c96e5c, задача ca26c59d,
 * тех.проект 2d9f5cc7).
 *
 * **Кому.** Только администратору сервера: вход из меню пользователя
 * («Обновление сервера») и из блокирующего диалога совместимости (кнопка
 * «Обновить сервер»). Функция сама проверяет роль и молча выходит без неё —
 * второй рубеж после серверного `requireAdmin` (эндпоинты 0a27a63b).
 *
 * **Что показывает.** Текущую и доступную версии, канал, дату проверки, ошибку
 * проверки, режим развёртывания (`deployment`) и инструкцию (`instruction`);
 * кнопки «Проверить» и «Обновить сервер» (в Docker кнопки обновления нет —
 * только пояснение; инструкция появится с задачей c79afe43).
 *
 * **Запуск.** Подтверждение честно описывает последствия (сервер
 * останавливается, БД копируется в архив, клиенты получают 503/1012 и
 * переподключаются). Вызов идёт через `system.applyServerUpdate` — это
 * `systemUpdateApply` rest-клиента с `retry: false` и поднятым до 11 минут
 * тайм-аутом ответа: сервер отвечает только после скачивания установщика и
 * проверки SHA-256 (до 10 минут). Обрыв/тайм-аут/`409`/`503` разбирает
 * {@link classifyApplyFailure} как «обновление идёт» — диалог переходит к
 * прогрессу, а не показывает ошибку.
 *
 * **Прогресс.** Опрос `GET /system/update/progress` раз в
 * {@link DEFAULT_POLL_INTERVAL_MS}. Показываются только подтверждённые сервером
 * этапы (`preparing`, `backing-up`) и итог `done`/`failed`; `installing`,
 * `health-check` и `rolling-back` сервер записать не может — для них одна
 * общая строка без выдуманных имён и процентов. Обрыв связи во время
 * обновления — ожидаемое состояние («сервер останавливается»), а не ошибка.
 * После перезапуска сервер отдаёт незавершённое задание как `failed`: диалог
 * показывает причину и путь к журналу установщика. Путь к архиву БД
 * (`backup_path`) сейчас всегда `null` — выдуманный путь не показывается;
 * появится поле — покажется.
 *
 * **Ошибки.** Любая ошибка действия — строкой в футере диалога (требование
 * 397c5a56), не в теле. Все тексты — из словаря `lib/i18n.ts`. Контролы —
 * фасады `lib/ui` (кнопки — `uiButton`, строка ошибки — `footerErrorLine`),
 * каркас — `lib/dialog.ts`; своего CSS нет.
 */

import type { UpdateJob } from '@etn/shared';

import type {
  ServerUpdateProgressDto,
  ServerUpdateStatusDto,
} from '../../main/ipc/contract.js';
import { confirmDialog, showDialog } from './dialog.js';
import { div, el } from './dom.js';
import { t } from './i18n.js';
import {
  classifyApplyFailure,
  isTerminalJobStage,
  serverUpdateViewModel,
  type ServerUpdateState,
} from './server-update.js';
import { uiButton } from './ui/button.js';
import { footerErrorLine } from './ui/messages.js';
import { etn } from './etn.js';
import { store } from '../state.js';

/** Интервал опроса прогресса по умолчанию, мс (без спама). */
export const DEFAULT_POLL_INTERVAL_MS = 3_000;

/** Зависимости диалога — подменяются в тестах. */
export interface ServerUpdateDialogDeps {
  /** Текущий пользователь — администратор? Диалог только для него. */
  isAdmin(): boolean;
  /** Снимок кеша проверки (`GET /system/update`). */
  getStatus(): Promise<ServerUpdateStatusDto>;
  /** Принудительная проверка канала (`POST /system/update/check`). */
  check(): Promise<ServerUpdateStatusDto>;
  /** Запуск задания (`POST /system/update/apply`). */
  apply(targetVersion: string): Promise<UpdateJob>;
  /** Последнее задание (`GET /system/update/progress`). */
  getProgress(): Promise<ServerUpdateProgressDto>;
  /** Подтверждение с честным текстом последствий. */
  confirm(title: string, message: string): Promise<boolean>;
  /** Запись пути в буфер обмена. */
  copyText(text: string): Promise<void>;
  /** Интервал опроса прогресса, мс (тесты — короткий). */
  pollIntervalMs?: number;
}

/** Зависимости по умолчанию: IPC главного процесса и штатный диалог. */
export function defaultServerUpdateDeps(): ServerUpdateDialogDeps {
  return {
    isAdmin: () => store.state.me?.is_admin === true,
    getStatus: () => etn.system.getServerUpdate(),
    check: () => etn.system.checkServerUpdate(),
    apply: (targetVersion) => etn.system.applyServerUpdate(targetVersion),
    getProgress: () => etn.system.getServerUpdateProgress(),
    confirm: (title, message) =>
      confirmDialog(title, message, false, t('serverUpdate.confirm.action')),
    copyText: async (text) => {
      await navigator.clipboard.writeText(text);
    },
  };
}

/** Открытый диалог: второй клик по входу не плодит окна. */
let openDialog: (() => void) | null = null;

/** Ошибка — `429 RATE_LIMITED` (проверка уже идёт)? */
function isRateLimited(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'RATE_LIMITED';
}

/** Человеческая причина ошибки для строки футера. */
function errorText(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return t('serverUpdate.reasonUnknown');
}

/**
 * Открыть диалог обновления сервера. Только администратор: без роли функция
 * ничего не делает (вход в меню и диалог совместимости тоже скрыт, но
 * полагаться на это нельзя).
 */
export function openServerUpdateDialog(
  overrides: Partial<ServerUpdateDialogDeps> = {},
): void {
  const deps: ServerUpdateDialogDeps = { ...defaultServerUpdateDeps(), ...overrides };
  if (!deps.isAdmin()) return;
  // Уже открыт — поднимать нечего, повторный вход просто игнорируется.
  if (openDialog !== null) return;

  const state: ServerUpdateState & { failureOverride: string | null } = {
    status: null,
    job: null,
    phase: 'idle',
    checking: false,
    checkNote: null,
    disconnected: false,
    installerFailed: false,
    failureOverride: null,
  };

  let closed = false;
  let applyPending = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollBusy = false;
  /** Подпись футера: пересобираем кнопки только при смене набора действий. */
  let footerSignature = '';
  /** Кнопка «Обновить сервер» последней сборки (для блокировки на время apply). */
  let applyButton: HTMLButtonElement | null = null;
  let checkButton: HTMLButtonElement | null = null;

  // -- разметка ------------------------------------------------------------
  const body = div('form-stack');
  const versionsBox = div('form-stack');
  const currentLine = el('p', 'dialog-text');
  const availableLine = el('p', 'dialog-text');
  const channelLine = el('p', 'dialog-text muted');
  const deploymentLine = el('p', 'dialog-text muted');
  const checkErrorLine = el('p', 'dialog-text');
  const instructionLine = el('p', 'dialog-text');
  const unavailableLine = el('p', 'dialog-text muted');
  const noteLine = el('p', 'dialog-text muted');
  versionsBox.append(
    currentLine,
    availableLine,
    channelLine,
    deploymentLine,
    checkErrorLine,
    instructionLine,
    unavailableLine,
    noteLine,
  );

  const progressBox = div('form-stack');
  const stageLine = el('p', 'dialog-text');
  const progressNote = el('p', 'dialog-text muted');
  const failureLine = el('p', 'dialog-text');
  const journalLine = el('p', 'dialog-text');
  const journalCopy = uiButton({
    label: t('serverUpdate.copyPath'),
    role: 'ghost',
    size: 's',
    onClick: () => void copyJournalPath(),
  });
  /** Подтверждение копирования — рядом с кнопкой, не в строке ошибки. */
  const copyFeedback = el('span', 'muted');
  copyFeedback.hidden = true;
  const journalRow = div('form-row');
  journalRow.append(journalLine, journalCopy, copyFeedback);
  const backupLine = el('p', 'dialog-text');
  progressBox.append(stageLine, progressNote, failureLine, journalRow, backupLine);
  progressBox.hidden = true;

  body.append(versionsBox, progressBox);

  // -- футер ---------------------------------------------------------------
  // Ошибка действия — только в панели кнопок (требование 397c5a56): футер
  // виден независимо от содержимого тела. Класс `dialog-footer-with-error`
  // даёт строке ошибки свободное место слева от кнопок.
  const errorLine = footerErrorLine();
  const footer = div('dialog-footer dialog-footer-with-error');
  const buttons = div('form-row');
  footer.append(errorLine, buttons);

  /** Скопировать путь к журналу установщика (если он есть). */
  async function copyJournalPath(): Promise<void> {
    const path = serverUpdateViewModel(state).journalPath;
    if (path === null) return;
    try {
      await deps.copyText(path);
      copyFeedback.textContent = t('serverUpdate.pathCopied');
    } catch {
      copyFeedback.textContent = t('serverUpdate.pathCopyFailed');
    }
    copyFeedback.hidden = false;
  }

  /** Пересобрать кнопки футера под текущее состояние. */
  function renderButtons(): void {
    const view = serverUpdateViewModel(state);
    const signature = JSON.stringify([
      view.canCheck,
      view.canApply,
      view.running,
      state.phase,
    ]);
    if (signature === footerSignature) {
      if (applyButton !== null) applyButton.disabled = applyPending;
      if (checkButton !== null) checkButton.disabled = state.checking;
      return;
    }
    footerSignature = signature;
    buttons.replaceChildren();
    applyButton = null;
    checkButton = null;

    if (!view.running) {
      checkButton = uiButton({
        label: t('serverUpdate.check'),
        role: 'secondary',
        size: 'm',
        disabled: state.checking,
        onClick: () => void runCheck(),
      });
      buttons.append(checkButton);
    }
    // Главное действие — крайним справа (требование edc5faea).
    const closeButton = uiButton({
      label: t('actions.close'),
      role: view.canApply || view.running ? 'secondary' : 'primary',
      size: 'm',
      onClick: () => close(),
    });
    buttons.append(closeButton);
    if (view.canApply) {
      applyButton = uiButton({
        label: t('serverUpdate.apply'),
        role: 'primary',
        size: 'm',
        disabled: applyPending,
        onClick: () => void runApply(),
      });
      buttons.append(applyButton);
    }
  }

  /** Текст-состояние над списком версий («проверка идёт», «проверка уже идёт»). */
  function renderStatus(): void {
    const status = state.status;
    currentLine.textContent =
      status === null
        ? t('serverUpdate.loading')
        : t('serverUpdate.current', status.current_version);
    const view = serverUpdateViewModel(state);
    availableLine.textContent =
      view.availableVersion === null
        ? t('serverUpdate.noUpdate')
        : t('serverUpdate.available', view.availableVersion);
    channelLine.textContent = [
      view.channelText === null ? '' : t('serverUpdate.channel', view.channelText),
      view.checkedAtText === null
        ? status === null
          ? ''
          : t('serverUpdate.neverChecked')
        : t('serverUpdate.checkedAt', view.checkedAtText),
    ]
      .filter((part) => part !== '')
      .join(' · ');
    deploymentLine.textContent =
      view.deploymentText === null
        ? ''
        : t('serverUpdate.deployment', view.deploymentText);
    checkErrorLine.textContent =
      view.checkError === null ? '' : t('serverUpdate.checkError', view.checkError);
    checkErrorLine.hidden = view.checkError === null;
    instructionLine.textContent =
      view.instruction === null ? '' : t('serverUpdate.instruction', view.instruction);
    instructionLine.hidden = view.instruction === null;
    // Пояснение недоступности обновления (Docker — до задачи c79afe43).
    unavailableLine.textContent = view.unavailableNote ?? '';
    unavailableLine.hidden = view.unavailableNote === null;
    // Состояние проверки — не ошибка (в т.ч. 429 «проверка уже идёт»).
    const note = state.checking
      ? t('serverUpdate.checking')
      : (state.checkNote ?? '');
    noteLine.textContent = note;
    noteLine.hidden = note === '';
  }

  /** Текст-состояние прогресса: только подтверждённые сервером этапы. */
  function renderProgress(): void {
    const view = serverUpdateViewModel(state);
    progressBox.hidden = !(view.running || view.done || view.failed);
    stageLine.hidden = view.stageText === null;
    stageLine.textContent = view.stageText ?? '';

    // Пояснения: обрыв (ожидаемое состояние), отказ установщика, итог,
    // ожидание задания и идущий apply.
    let note = '';
    if (view.disconnected) note = t('serverUpdate.progress.disconnected');
    else if (view.installerFailed) note = t('serverUpdate.installerFailedNote');
    else if (view.done) note = t('serverUpdate.progress.reconnect');
    else if (view.applying) note = t('serverUpdate.progress.downloading');
    else if (view.running && state.job === null) note = t('serverUpdate.progress.waiting');
    progressNote.textContent = note;
    progressNote.hidden = note === '';

    const failure = view.failureText ?? state.failureOverride;
    failureLine.hidden = !view.failed || failure === null;
    failureLine.textContent =
      view.failed && failure !== null ? t('serverUpdate.failure.reason', failure) : '';

    copyFeedback.hidden = true;
    journalRow.hidden = view.journalPath === null;
    journalLine.textContent =
      view.journalPath === null ? '' : t('serverUpdate.failure.journal', view.journalPath);

    // `backup_path` сервер пока всегда `null` — выдуманный путь не рисуем.
    backupLine.hidden = view.backupPath === null;
    backupLine.textContent =
      view.backupPath === null ? '' : t('serverUpdate.backupPath', view.backupPath);
  }

  /** Полная перерисовка содержимого (кнопки — по подписи). */
  function render(): void {
    renderStatus();
    renderProgress();
    renderButtons();
  }

  // -- прогресс ------------------------------------------------------------
  /** Остановить опрос (закрытие, терминальный этап). */
  function stopPolling(): void {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  /** Запланировать следующий опрос. */
  function schedulePoll(): void {
    if (closed) return;
    stopPolling();
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void pollOnce();
    }, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  /** Один опрос `GET /system/update/progress`. */
  async function pollOnce(): Promise<void> {
    if (closed || pollBusy) return;
    pollBusy = true;
    try {
      const { job } = await deps.getProgress();
      if (closed) return;
      state.disconnected = false;
      if (job !== null) applyJob(job);
      render();
      if (state.job === null || !isTerminalJobStage(state.job.stage)) schedulePoll();
    } catch {
      if (closed) return;
      // Обрыв при обновлении — ожидаемое состояние: установщик останавливает
      // службу. Это НЕ сетевая ошибка пользовательского действия.
      state.disconnected = true;
      render();
      if (state.phase === 'applying') schedulePoll();
    } finally {
      pollBusy = false;
    }
  }

  /** Применить задание с сервера: фаза и итог. */
  function applyJob(job: UpdateJob): void {
    state.job = job;
    if (job.stage === 'done') {
      state.phase = 'done';
      state.disconnected = false;
      stopPolling();
      // Сервер поднялся на новой версии: обновляем снимок кеша (без ошибки,
      // если сервер ещё не отвечает — старый снимок остаётся на экране).
      void refreshStatusSilently();
      return;
    }
    if (job.stage === 'failed') {
      state.phase = 'failed';
      state.disconnected = false;
      stopPolling();
      return;
    }
    state.phase = 'applying';
  }

  /** Тихо перечитать снимок кеша после успешного обновления. */
  async function refreshStatusSilently(): Promise<void> {
    try {
      const status = await deps.getStatus();
      if (closed) return;
      state.status = status;
      render();
    } catch {
      // Сервер может ещё перезапускаться — показываем прежний снимок.
    }
  }

  // -- действия ------------------------------------------------------------
  /** «Проверить»: `429` — «проверка идёт», а не ошибка. */
  async function runCheck(): Promise<void> {
    if (state.checking || state.phase === 'applying') return;
    state.checking = true;
    state.checkNote = null;
    errorLine.clear();
    render();
    try {
      state.status = await deps.check();
    } catch (err) {
      if (isRateLimited(err)) {
        // Состояние, не ошибка: проверка уже идёт (DoD задачи).
        state.checkNote = t('serverUpdate.checkAlreadyRunning');
      } else {
        errorLine.show(t('serverUpdate.checkFailed', errorText(err)));
      }
    } finally {
      state.checking = false;
      render();
    }
  }

  /** «Обновить сервер»: подтверждение → apply → прогресс. */
  async function runApply(): Promise<void> {
    const view = serverUpdateViewModel(state);
    if (!view.canApply || view.availableVersion === null) return;
    const confirmed = await deps.confirm(
      t('serverUpdate.confirm.title', view.availableVersion),
      t('serverUpdate.confirm.message'),
    );
    if (!confirmed || closed) return;

    state.phase = 'applying';
    state.checkNote = null;
    state.disconnected = false;
    state.installerFailed = false;
    state.failureOverride = null;
    applyPending = true;
    errorLine.clear();
    render();
    // Задание создаётся до скачивания: опрос с первого же мгновения.
    schedulePoll();
    try {
      const job = await deps.apply(view.availableVersion);
      if (closed) return;
      applyPending = false;
      applyJob(job);
      render();
    } catch (err) {
      if (closed) return;
      applyPending = false;
      const failure = classifyApplyFailure(err);
      if (failure.kind === 'in-progress') {
        // «Обновление идёт»: ошибку не показываем, состояние читает /progress.
        if (failure.job !== null) applyJob(failure.job);
        else state.phase = 'applying';
        schedulePoll();
        render();
        return;
      }
      stopPolling();
      if (failure.kind === 'installer-failed') {
        // Сервер жив, задание помечено failed; повтор не предлагается
        // (`retryable: false`) — только причина и журнал.
        state.installerFailed = true;
        if (failure.job !== null) applyJob(failure.job);
        else state.phase = 'failed';
        state.failureOverride = failure.message === null ? null : failure.message;
        render();
        return;
      }
      // Настоящий отказ — строка ошибки в футере, диалог остаётся в ожидании.
      state.phase = state.job !== null && state.job.stage === 'done' ? 'done' : 'idle';
      errorLine.show(
        t('serverUpdate.applyFailed', failure.message ?? t('serverUpdate.reasonUnknown')),
      );
      render();
    }
  }

  // -- загрузка и закрытие -------------------------------------------------
  /** Первичная загрузка: кеш проверки + последнее задание (DoD: после
   *  переподключения прогресс восстанавливается из /progress). */
  async function load(): Promise<void> {
    try {
      state.status = await deps.getStatus();
      if (closed) return;
      render();
    } catch (err) {
      if (closed) return;
      errorLine.show(t('serverUpdate.loadFailed', errorText(err)));
      render();
    }
    try {
      const { job } = await deps.getProgress();
      if (closed) return;
      if (job !== null) {
        applyJob(job);
        render();
        if (!isTerminalJobStage(job.stage)) schedulePoll();
      }
    } catch {
      // Прогресс не прочитался — не заявляем о сбое: состояние обновлений
      // уже показано, задание прочитается при следующем открытии.
    }
  }

  function close(): void {
    closeOwn();
  }

  const closeFn: () => void = showDialog({
    title: t('serverUpdate.title'),
    size: 'm',
    body,
    customFooter: footer,
    onClose: () => {
      closed = true;
      stopPolling();
      if (openDialog === closeFn) openDialog = null;
    },
  });

  /** Снять диалог со стека (идемпотентно). */
  function closeOwn(): void {
    const fn = openDialog;
    openDialog = null;
    fn?.();
  }

  openDialog = closeFn;
  render();
  void load();
}
