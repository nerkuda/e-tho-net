/**
 * Блокирующий диалог несовместимости версий (элемент интерфейса 8623b9ff,
 * задача 0afec967, требование 4d3be6ca, сущность 89aad200).
 *
 * **Когда показывается.** Только после аутентификации (`store.state.me` уже
 * получен) и только для блокирующих статусов `client-outdated` /
 * `server-outdated`. На экране подключения и в онбординге диалога нет: ввод
 * ключа не блокируется, а причину отказа там называет `lib/connect-failure.ts`.
 *
 * **Не закрывается пользователем.** Каркас вызывается с `dismissible: false`
 * (крестика нет, `Esc` гасится): пока вердикт блокирующий, единственные выходы
 * — закрыть приложение, дождаться смены вердикта или нажать «Повторить».
 * Переподключение по кнопке публикует новый вердикт; совместимый — закрывает
 * диалог.
 *
 * **Кнопки по роли и статусу** (8623b9ff):
 *  - `client-outdated` — «Обновить клиент» (открывает `download_url` — страницу
 *    релиза в браузере, без автозагрузки) и «Повторить»;
 *  - `server-outdated` — неадминистратору нейтральный текст «Обратитесь к
 *    администратору сервера»; администратору (`is_admin` из `/me`) — «Обновить
 *    сервер» и честный текст, что автоматического обновления сервера из
 *    клиента в этой версии ещё нет (диалог обновления — задача ca26c59d).
 *
 * Все строки — из словаря (`lib/i18n.ts`); причина выбирается по словарю
 * `details.reason` в `lib/compatibility-reason.ts` (одна точка с текстом отказа
 * подключения). Своего CSS нет: раскладка — существующие классы `.form-stack`,
 * `.form-row`, `.dialog-text`, `.muted`, `.dialog-footer`.
 */

import type { CompatibilityResult } from '../../main/ipc/contract.js';

import { compatibilityFactsText, compatibilityReasonKey } from './compatibility-reason.js';
import { describeConnectFailure } from './connect-failure.js';
import { showDialog } from './dialog.js';
import { div, el } from './dom.js';
import { t, type MessageKey } from './i18n.js';
import { uiButton } from './ui/button.js';
import { errorLine } from './ui/messages.js';

/** Действие блокирующего диалога (`update-client` — открыть страницу релиза). */
export type CompatibilityDialogAction = 'update-client' | 'update-server' | 'retry';

/** Описание состояния диалога для одного вердикта; `null` — не блокирует. */
export interface CompatibilityDialogModel {
  /** Заголовок диалога. */
  title: MessageKey;
  /** Ключ причины несовместимости (по статусу и `details.reason`). */
  reasonKey: MessageKey;
  /** Кнопки в порядке футера (слева направо; последняя — главная). */
  actions: CompatibilityDialogAction[];
  /** Нейтральный текст «Обратитесь к администратору сервера». */
  contactAdmin: boolean;
  /** Честный текст о недоступном обновлении сервера (администратору). */
  serverUpdateUnavailable: boolean;
  /** Кнопки «Обновить клиент» нет — сервер не сообщил страницу релиза. */
  downloadUnavailable: boolean;
}

/**
 * Модель диалога по вердикту. `null` — вердикт не блокирующий
 * (`compatible`/`recommended-update`/`check-failed`): диалог не показывается.
 *
 * Порядок кнопок — как принято в футерах ETN: второстепенное действие
 * («Повторить») слева, главное («Обновить клиент»/«Обновить сервер») справа.
 * «Обновить сервер» — строго при подтверждённом `is_admin`; до этого роль
 * неизвестна, и диалог показывает нейтральный текст (требование 8623b9ff).
 */
export function compatibilityDialogModel(
  result: CompatibilityResult,
): CompatibilityDialogModel | null {
  if (!result.blocking) return null;
  if (result.status !== 'client-outdated' && result.status !== 'server-outdated') return null;

  const actions: CompatibilityDialogAction[] = ['retry'];
  let downloadUnavailable = false;
  if (result.status === 'client-outdated') {
    const url = typeof result.downloadUrl === 'string' ? result.downloadUrl.trim() : '';
    if (url !== '') {
      actions.push('update-client');
    } else {
      downloadUnavailable = true;
    }
  } else if (result.is_admin === true) {
    actions.push('update-server');
  }

  return {
    title: 'compatibility.dialog.title',
    reasonKey: compatibilityReasonKey(result),
    actions,
    contactAdmin: result.status === 'server-outdated' && result.is_admin !== true,
    serverUpdateUnavailable: result.status === 'server-outdated' && result.is_admin === true,
    downloadUnavailable,
  };
}

/** Снимок состояния рендерера, из которого рисуется диалог. */
export interface CompatibilityDialogState {
  /** Текущий вердикт проверки совместимости. */
  compatibility: CompatibilityResult | null;
  /** Пользователь аутентифицирован (в store уже есть `me`). */
  authenticated: boolean;
  /** Активный профиль — по нему выполняется повторная проверка. */
  profileId: string | null;
}

/** Зависимости контроллера диалога — их передаёт `app.ts`. */
export interface CompatibilityDialogDeps {
  /** Текущий снимок состояния. */
  getState(): CompatibilityDialogState;
  /** Подписка на изменения состояния; возвращает функцию отписки. */
  subscribe(listener: () => void): () => void;
  /** Открыть страницу релиза в системном браузере. Пустая строка — успех. */
  openExternal(url: string): Promise<string>;
  /** Повторная проверка: переподключение к профилю (может бросить отказ). */
  retry(profileId: string): Promise<void>;
  /** Записать текст в буфер обмена. */
  copyText(text: string): Promise<void>;
  /** Профили локальной БД — адрес сервера для честного текста отказа повтора. */
  loadProfiles(): Promise<Array<{ id: string; label: string; baseUrl: string }>>;
}

/** `true` — отказ подключения с машиночитаемой причиной несовместимости. */
function isCompatibilityRefusal(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const details = (err as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return false;
  return (details as { kind?: unknown }).kind === 'client-compatibility';
}

/**
 * Инициализирует блокирующий диалог: подписка на store, показ после
 * аутентификации, живое обновление содержимого и закрытие по смене вердикта.
 * Возвращает функцию отписки (тесты и повторная инициализация).
 */
export function initCompatibilityDialog(deps: CompatibilityDialogDeps): () => void {
  /** Открытый диалог; `null` — закрыт. */
  let open: (() => void) | null = null;
  /**
   * Вердикт, по которому построено содержимое. `sync` зовётся на КАЖДОЕ
   * изменение store (фокус, события реального времени) — перерисовываем
   * только настоящую смену вердикта, иначе фокус на кнопке терялся бы.
   */
  let rendered: CompatibilityResult | null = null;
  /** Идёт переподключение по кнопке «Повторить» (защита от двойного клика). */
  let retryBusy = false;
  /** Адрес активного профиля для честного текста отказа повтора. */
  let connectTarget: { label: string; baseUrl: string } | null = null;
  /** Загрузка адреса профиля (одна на диалог; тексту отказа важно дождаться). */
  let connectTargetLoading: Promise<void> | null = null;

  const view = {
    body: div('form-stack'),
    reason: el('p', 'dialog-text'),
    facts: el('p', 'dialog-text muted'),
    contact: el('p', 'dialog-text'),
    unavailable: el('p', 'dialog-text muted'),
    copyRow: div('form-row'),
    copyFeedback: el('span', 'muted'),
    retryError: errorLine(),
    footer: div('dialog-footer'),
  };
  view.contact.hidden = true;
  view.unavailable.hidden = true;
  view.copyFeedback.hidden = true;
  view.retryError.hidden = true;

  /** Кнопка «Повторить» последнего рендера — блокируется на время повтора. */
  let retryButton: HTMLButtonElement | null = null;

  const copyButton = uiButton({
    label: t('compatibility.copyVersions'),
    role: 'ghost',
    size: 's',
    onClick: () => void copyVersions(),
  });
  view.copyRow.append(copyButton, view.copyFeedback);
  view.body.append(
    view.reason,
    view.facts,
    view.contact,
    view.unavailable,
    view.copyRow,
    view.retryError,
  );

  /** Закрыть диалог, если он открыт (без обращения к store). */
  function closeOwn(): void {
    const close = open;
    open = null;
    rendered = null;
    close?.();
  }

  /** Текст причины отказа повтора: адрес + фактическая причина (390e9746). */
  async function retryFailureText(err: unknown): Promise<string> {
    // Адрес мог ещё не прийти — дождёмся единственной загрузки, иначе причина
    // останется нейтральной без адреса сервера.
    await connectTargetLoading;
    if (connectTarget === null) return t('connect.reason.other');
    return describeConnectFailure(err, connectTarget);
  }

  /** Повторная проверка: переподключение к активному профилю. */
  async function runRetry(): Promise<void> {
    if (retryBusy) return;
    const profileId = deps.getState().profileId;
    if (profileId === null) return;
    retryBusy = true;
    if (retryButton !== null) retryButton.disabled = true;
    view.retryError.hidden = true;
    try {
      await deps.retry(profileId);
    } catch (err) {
      // Отказ несовместимости уже опубликован новым вердиктом — диалог
      // перерисован и говорит причину сам; всё остальное (сеть, ключ) честно
      // называем строкой ошибки, чтобы клик не был молчаливым.
      if (!isCompatibilityRefusal(err)) {
        view.retryError.textContent = t('compatibility.retryFailed', await retryFailureText(err));
        view.retryError.hidden = false;
      }
    } finally {
      retryBusy = false;
      if (retryButton !== null) retryButton.disabled = false;
    }
  }

  /** Открыть страницу релиза (`download_url`) — без скачивания файла. */
  async function openDownload(result: CompatibilityResult): Promise<void> {
    const url = result.downloadUrl;
    if (url === null || url.trim() === '') return;
    try {
      const failure = await deps.openExternal(url);
      if (failure !== '') {
        view.retryError.textContent = t('compatibility.openFailed', failure);
        view.retryError.hidden = false;
      }
    } catch {
      view.retryError.textContent = t('compatibility.openFailed', t('connect.reason.other'));
      view.retryError.hidden = false;
    }
  }

  /** Скопировать строку версий для передачи администратору. */
  async function copyVersions(): Promise<void> {
    const result = deps.getState().compatibility;
    if (result === null) return;
    try {
      await deps.copyText(compatibilityFactsText(result));
      view.copyFeedback.textContent = t('compatibility.copied');
      view.copyFeedback.hidden = false;
    } catch {
      view.copyFeedback.textContent = t('compatibility.copyFailed');
      view.copyFeedback.hidden = false;
    }
  }

  /**
   * Честное пояснение администратору: автоматического обновления сервера из
   * клиента в этой версии нет (диалог и задание — ca26c59d). Отдельный диалог
   * поверх блокирующего: сам блокирующий закрывать нельзя.
   */
  function showServerUpdateInfo(): void {
    showDialog({
      title: t('compatibility.serverUpdate.title'),
      size: 's',
      body: el('p', 'dialog-text', t('compatibility.serverUpdate.unavailable')),
      buttons: [{ label: t('actions.close'), primary: true }],
    });
  }

  /** Кнопка действия с учётом главного (последнего) действия. */
  function actionButton(
    action: CompatibilityDialogAction,
    result: CompatibilityResult,
    primary: boolean,
  ): HTMLButtonElement {
    const role = primary ? 'primary' : 'secondary';
    if (action === 'update-client') {
      return uiButton({
        label: t('compatibility.action.updateClient'),
        role,
        onClick: () => void openDownload(result),
      });
    }
    if (action === 'update-server') {
      return uiButton({
        label: t('compatibility.action.updateServer'),
        role,
        onClick: () => showServerUpdateInfo(),
      });
    }
    const button = uiButton({
      label: t('compatibility.action.retry'),
      role,
      onClick: () => void runRetry(),
    });
    retryButton = button;
    if (retryBusy) button.disabled = true;
    return button;
  }

  /** Перерисовать содержимое по текущему вердикту (диалог не пересоздаётся). */
  function render(result: CompatibilityResult, model: CompatibilityDialogModel): void {
    view.reason.textContent = t(model.reasonKey);
    view.facts.textContent = compatibilityFactsText(result);
    view.contact.hidden = !model.contactAdmin;
    view.contact.textContent = model.contactAdmin ? t('compatibility.contactAdmin') : '';
    view.unavailable.hidden = !model.serverUpdateUnavailable;
    view.unavailable.textContent = model.serverUpdateUnavailable
      ? t('compatibility.serverUpdateUnavailable')
      : '';
    view.copyFeedback.hidden = true;
    if (!retryBusy) {
      view.retryError.hidden = true;
      view.retryError.textContent = '';
    }
    retryButton = null;
    view.footer.replaceChildren();
    model.actions.forEach((action, index) => {
      view.footer.append(actionButton(action, result, index === model.actions.length - 1));
    });
  }

  /** Загрузить адрес активного профиля (для текста отказа повтора). */
  function requestConnectTarget(profileId: string | null): void {
    if (connectTargetLoading !== null || profileId === null) return;
    connectTargetLoading = deps
      .loadProfiles()
      .then((profiles) => {
        const profile = profiles.find((p) => p.id === profileId) ?? null;
        if (profile !== null) connectTarget = { label: profile.label, baseUrl: profile.baseUrl };
      })
      .catch(() => {
        // Адрес не узнали — в тексте отказа останется нейтральная причина.
      });
  }

  /** Синхронизирует диалог со стором: показать/перерисовать/закрыть. */
  function sync(): void {
    const state = deps.getState();
    const result = state.compatibility;
    // Диалог — только после аутентификации (8623b9ff): на экране подключения
    // ввод ключа не блокируется, причину отказа там называет connect-failure.
    const model =
      result !== null && state.authenticated ? compatibilityDialogModel(result) : null;
    if (result === null || model === null) {
      closeOwn();
      return;
    }
    requestConnectTarget(state.profileId);
    if (open === null) {
      rendered = result;
      render(result, model);
      const close: () => void = showDialog({
        title: t(model.title),
        size: 'm',
        body: view.body,
        customFooter: view.footer,
        // Блокирующий диалог: крестика нет, Esc гасится (8623b9ff).
        dismissible: false,
        onClose: () => {
          // Внешнее программное закрытие: снимаем ссылку, следующий sync снова
          // покажет диалог, пока вердикт блокирующий.
          if (open === close) open = null;
        },
      });
      open = close;
      return;
    }
    // Тот же вердикт — содержимое не трогаем (фокус и нажатия сохраняются).
    if (rendered !== result) {
      rendered = result;
      render(result, model);
    }
  }

  const unsubscribe = deps.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    closeOwn();
  };
}
