/**
 * Баннер рекомендованной версии клиента (элемент интерфейса ed068706, компонент
 * 06d88619, задача b57910b5, сущность 89aad200).
 *
 * **Назначение.** Единственная точка показа напоминания о рекомендованной
 * сервером версии клиента. Баннер не блокирует работу, не заменяет блокирующий
 * диалог (8623b9ff) и не показывается до аутентификации.
 *
 * **Состояния** (проекция `CompatibilityResult.banner`):
 *  - `hidden` (в т.ч. `compatible` и блокирующие статусы) — баннера нет;
 *    блокировку показывает диалог 8623b9ff;
 *  - `recommended-update` — «Доступна версия X» с текущей версией клиента,
 *    кнопками «Обновить клиент» (открывает `download_url` — страницу релиза,
 *    без автозагрузки) и «Позже»;
 *  - `unknown` (`check-failed`) — нейтральный текст без кнопок: проверка не
 *    удалась, это НЕ «обновлений нет» (DoD задачи b57910b5).
 *
 * **«Позже»** живёт в памяти рендерера (в `client_meta` не пишется), переживает
 * пересборку рабочего пространства и сбрасывается на каждом новом вердикте:
 * новое подключение, переподключение или смена рекомендации показывают баннер
 * снова (сценарий dde6d22d).
 *
 * **Границы.** Клиент в 0.15.1 только открывает страницу релиза: состояний
 * скачивания и прогресса загрузки нет; кнопки «Проверить», периодических
 * опросов и кеша версии сервера также нет — они переехали в ТП обновления
 * сервера 2d9f5cc7 (ТП 52b33158 п. К6, сценарий d2c80aa4). Ошибки соединения
 * и maintenance баннер не показывает; тост (`lib/notice.ts`) не используется —
 * он автозакрывается и не содержит действий.
 *
 * **Сборка.** Модуль — библиотечная компонента из фасадов `lib/ui` (кнопки —
 * `uiButton`, строка ошибки — `errorLine`); все тексты — из словаря
 * `lib/i18n.ts`. Своих контролов нет; вид — классы `.update-banner*` в
 * `styles/layout.css`. Сторож `guard-update-banner.test.ts` запрещает
 * самодельные баннеры обновления вне модуля.
 */

import type { CompatibilityResult } from '../../main/ipc/contract.js';
import { div, span } from './dom.js';
import { t } from './i18n.js';
import { uiButton } from './ui/button.js';
import { errorLine } from './ui/messages.js';

/**
 * Состояние показа баннера. `recommended-update` — доступна рекомендованная
 * версия, `unknown` — проверка не удалась (нейтральный текст без кнопок).
 */
export type UpdateBannerState = 'recommended-update' | 'unknown';

/** Готовая к отрисовке модель баннера (тексты — уже из словаря). */
export interface UpdateBannerModel {
  state: UpdateBannerState;
  /** Основная строка: «Доступна версия X» либо нейтральный текст `unknown`. */
  title: string;
  /** Вторая строка (текущая версия клиента); пустая — второй строки нет. */
  subtitle: string;
  /**
   * Пояснение, когда действие недоступно (сервер не сообщил страницу релиза);
   * `null` — пояснения нет.
   */
  note: string | null;
  /** Есть `download_url` — показывается кнопка «Обновить клиент». */
  canUpdate: boolean;
  /** Показывается кнопка «Позже» (только `recommended-update`). */
  canDismiss: boolean;
}

/** Опции чистой модели: пользователь уже отложил ИМЕННО этот вердикт. */
export interface UpdateBannerModelOptions {
  /** «Позже» по текущему вердикту — баннер скрыт до следующего вердикта. */
  dismissed?: boolean;
}

/**
 * Модель баннера по вердикту проверки совместимости; `null` — баннера нет.
 *
 * Правила (элемент ed068706):
 *  - `null`, блокирующий статус и `banner: 'hidden'` — баннера нет: при
 *    блокировке работает диалог, при `compatible` рекомендаций нет;
 *  - `banner: 'unknown'` — нейтральный текст без кнопок; он не должен читаться
 *    как «обновлений нет» (DoD);
 *  - `banner: 'recommended-update'` без рекомендованной версии — баннера нет:
 *    показывать пустое «Доступна версия» недопустимо (защита от битого
 *    вердикта);
 *  - `download_url` не пришёл — кнопки «Обновить клиент» нет, но остаётся
 *    пояснение, что страницу релиза нужно взять с сайта проекта.
 */
export function updateBannerModel(
  result: CompatibilityResult | null,
  options: UpdateBannerModelOptions = {},
): UpdateBannerModel | null {
  if (result === null) return null;
  // Блокировка — диалог 8623b9ff; баннер рядом с ним не показывается.
  if (result.blocking) return null;
  // «Позже» действует до следующего вердикта (нового подключения/рекомендации).
  if (options.dismissed === true) return null;

  if (result.banner === 'unknown') {
    return {
      state: 'unknown',
      title: t('updateBanner.unknown'),
      subtitle: '',
      note: null,
      canUpdate: false,
      canDismiss: false,
    };
  }
  if (result.banner !== 'recommended-update') return null;

  const version = (result.recommendedClientVersion ?? '').trim();
  if (version === '') return null;
  const url = (result.downloadUrl ?? '').trim();

  return {
    state: 'recommended-update',
    title: t('updateBanner.available', version),
    subtitle: t('updateBanner.current', result.clientVersion),
    note: url === '' ? t('compatibility.downloadUnavailable') : null,
    canUpdate: url !== '',
    canDismiss: true,
  };
}

/** Опции отрисовки баннера. */
export interface UpdateBannerRenderOptions {
  /** Модель; `null` — баннер скрыт (хост очищается). */
  model: UpdateBannerModel | null;
  /** Строка ошибки (страница релиза не открылась); `null`/'' — нет ошибки. */
  error: string | null;
  /** «Обновить клиент» — открыть страницу релиза. */
  onUpdate(): void;
  /** «Позже» — скрыть до следующего вердикта. */
  onDismiss(): void;
}

/** Класс полосы баннера — единственная точка определения (вид — `styles/layout.css`). */
export const UPDATE_BANNER_CLASS = 'update-banner';

/**
 * Хост баннера для рабочего пространства: пустой скрытый элемент раскладки.
 * Класс `.update-banner` появляется только вместе с содержимым, поэтому
 * селектор `.update-banner` в DOM означает «баннер виден» (а не «есть пустая
 * скрытая полоса»).
 */
export function createUpdateBannerHost(): HTMLDivElement {
  const host = div();
  host.hidden = true;
  return host;
}

/**
 * Рисует баннер в предоставленном хосте. `model: null` скрывает хост.
 *
 * Вызывающий (`initUpdateBanner`) зовёт функцию только при смене модели или
 * текста ошибки, поэтому содержимое пересобирается целиком: у баннера нет
 * полей ввода, фокус терять не на чем.
 */
export function renderUpdateBanner(
  host: HTMLElement,
  options: UpdateBannerRenderOptions,
): void {
  const { model, error } = options;
  host.replaceChildren();
  if (model === null) {
    host.classList.remove(UPDATE_BANNER_CLASS);
    host.hidden = true;
    return;
  }
  host.classList.add(UPDATE_BANNER_CLASS);
  // `role="status"` + `aria-live="polite"`: напоминание озвучивается, но не
  // перебивает работу пользователя.
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.hidden = false;

  const text = div('update-banner-text');
  text.append(span(model.title, 'update-banner-title'));
  if (model.subtitle !== '') text.append(span(model.subtitle, 'update-banner-subtitle'));
  if (model.note !== null) text.append(span(model.note, 'muted'));
  if (error !== null && error !== '') text.append(errorLine(error));
  host.append(text);

  const actions = div('update-banner-actions');
  // Главное действие — крайним справа (словарь кнопок, требование edc5faea).
  if (model.canDismiss) {
    actions.append(
      uiButton({
        label: t('updateBanner.dismiss'),
        role: 'secondary',
        size: 's',
        onClick: options.onDismiss,
      }),
    );
  }
  if (model.canUpdate) {
    actions.append(
      uiButton({
        label: t('compatibility.action.updateClient'),
        role: 'primary',
        size: 's',
        onClick: options.onUpdate,
      }),
    );
  }
  if (actions.childElementCount > 0) host.append(actions);
}

/** Снимок состояния рендерера, из которого рисуется баннер. */
export interface UpdateBannerStoreState {
  /** Текущий вердикт проверки совместимости. */
  compatibility: CompatibilityResult | null;
  /** Пользователь аутентифицирован (в store уже есть `me`). */
  authenticated: boolean;
}

/** Зависимости контроллера баннера — их передаёт `app.ts`/рабочее пространство. */
export interface UpdateBannerDeps {
  /** Текущий снимок состояния. */
  getState(): UpdateBannerStoreState;
  /** Подписка на изменения состояния; возвращает функцию отписки. */
  subscribe(listener: () => void): () => void;
  /** Открыть страницу релиза в системном браузере. Пустая строка — успех. */
  openExternal(url: string): Promise<string>;
}

/** Подпись модели и ошибки — по ней контроллер пропускает пустые перерисовки. */
function signatureOf(model: UpdateBannerModel | null, error: string | null): string {
  return JSON.stringify([model, error]);
}

/**
 * Вердикт, отложенный пользователем на эту сессию рендерера. Живёт на уровне
 * модуля, а не контроллера: рабочее пространство пересобирается при открытии
 * сети, и «Позже» не должно сбрасываться от пересборки — только от нового
 * вердикта (подключение/переподключение/смена рекомендации, сценарий dde6d22d).
 * В `client_meta` не пишется: перезапуск клиента сбрасывает напоминание.
 */
let dismissedVerdict: CompatibilityResult | null = null;

/**
 * Подключает баннер к состоянию: подписка на store, показ после
 * аутентификации, «Позже», открытие страницы релиза и честная ошибка клика.
 * Возвращает функцию отписки (тесты и повторная инициализация).
 */
export function initUpdateBanner(host: HTMLElement, deps: UpdateBannerDeps): () => void {
  /** Вердикт, по которому построен текущий показ. */
  let verdict: CompatibilityResult | null = null;
  /** Ошибка открытия страницы релиза для текущего вердикта. */
  let error: string | null = null;
  /** Подпись последнего рендера — защита от лишних пересборок DOM. */
  let signature = '';

  /** Синхронизирует баннер со стором. */
  function sync(): void {
    const state = deps.getState();
    const result = state.compatibility;
    if (result !== verdict) {
      // Новый вердикт = новое подключение, переподключение или смена
      // рекомендации: «Позже» сбрасывается (сценарий dde6d22d), старая ошибка
      // открытия относится к прошлому вердикту.
      verdict = result;
      error = null;
    }
    // До аутентификации вердикт есть, но напоминание не показывается
    // (элемент ed068706): на экране подключения баннера нет.
    const model = state.authenticated
      ? updateBannerModel(result, { dismissed: result !== null && result === dismissedVerdict })
      : null;
    const next = signatureOf(model, error);
    if (next === signature) return;
    signature = next;
    renderUpdateBanner(host, {
      model,
      error,
      onUpdate: () => void openRelease(),
      onDismiss: () => dismiss(),
    });
  }

  /** «Позже»: скрыть до следующего вердикта. */
  function dismiss(): void {
    dismissedVerdict = deps.getState().compatibility;
    sync();
  }

  /** Показать ошибку открытия страницы, только если вердикт не сменился. */
  function showOpenFailure(message: string, forVerdict: CompatibilityResult | null): void {
    if (deps.getState().compatibility !== forVerdict) return;
    error = message;
    sync();
  }

  /**
   * Снять строку ошибки после успешного открытия (замечание приёмки b57910b5):
   * сообщение относится к прошлому клику и не должно висеть над уже
   * открывшейся страницей. Смена вердикта и так сбрасывает ошибку.
   */
  function clearOpenFailure(forVerdict: CompatibilityResult | null): void {
    if (deps.getState().compatibility !== forVerdict) return;
    if (error === null) return;
    error = null;
    sync();
  }

  /** Открыть страницу релиза (`download_url`) — без скачивания файла. */
  async function openRelease(): Promise<void> {
    const result = deps.getState().compatibility;
    const url = (result?.downloadUrl ?? '').trim();
    if (result === null || url === '') return;
    try {
      const failure = await deps.openExternal(url);
      if (failure === '') clearOpenFailure(result);
      else showOpenFailure(t('compatibility.openFailed', failure), result);
    } catch {
      showOpenFailure(t('compatibility.openFailed', t('connect.reason.other')), result);
    }
  }

  const unsubscribe = deps.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    host.replaceChildren();
    host.classList.remove(UPDATE_BANNER_CLASS);
    host.hidden = true;
  };
}
