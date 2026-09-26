/**
 * Пустые состояния, загрузка и ошибка списков/панелей — единый компонент
 * `lib/ui` (задача d7b7c367, требование e514768f «Пустые состояния списков,
 * таблиц и панелей объясняют, что делать», инвентаризация 3fc7c54d — раздел
 * «EmptyState / LoadingState»).
 *
 * **Зачем.** Раньше каждая панель показывала голое «Пусто»/«Нет данных» либо
 * `muted`-строку «Загрузка…» — пользователь не понимал, что здесь появится и
 * что сделать, чтобы данные появились. Теперь у списков, таблиц и панелей одно
 * осмысленное пустое состояние: заголовок (что здесь), подсказка (что сделать)
 * и, где действие действительно есть, кнопка-точка входа.
 *
 * **Три состояния — разные и различимые.** {@link emptyState} — данных нет;
 * {@link loadingState} — данные грузятся; {@link errorState} — данные не
 * удалось получить. Вид задан токенами (`./empty-state.css`), тексты — из
 * словаря (`lib/i18n.ts`, требование 0e5ff1c6): в модуле кириллических
 * литералов нет (сторож `guard-ui-i18n`).
 *
 * **Кнопка действия — из словаря кнопок** (`./button.js`, задача 56f1dcb2):
 * собственных кнопок компонент не собирает. Действие необязательно: если
 * показать его нельзя, остаётся подсказка (не выдумываем функциональность).
 *
 * **Контракт потребителя.** Заголовок и подсказку передаёт владелец уже
 * локализованными (`t('…')`); списочные фасады (`./table.js`, `./tree.js`,
 * `./chip-list.js`) принимают их опциями `emptyText`/`emptyHint` и рисуют это
 * состояние сами. Собственная сборка пустых заглушек вне компонента запрещена
 * сторожем `tests/guard-ui-empty-state.test.ts`.
 */

import { div } from '../dom.js';
import { t } from '../i18n.js';
import { errorParagraph } from './messages.js';
import { uiButton, type ButtonRole } from './button.js';

/** Корневой класс пустого состояния. */
export const EMPTY_STATE_CLASS = 'ui-empty';

/** Класс заголовка пустого состояния (что здесь появится). */
export const EMPTY_STATE_TITLE_CLASS = 'ui-empty__title';

/** Класс подсказки (что сделать, чтобы данные появились). */
export const EMPTY_STATE_HINT_CLASS = 'ui-empty__hint';

/** Класс кнопки-точки входа пустого состояния. */
export const EMPTY_STATE_ACTION_CLASS = 'ui-empty__action';

/** Класс состояния загрузки. */
export const LOADING_STATE_CLASS = 'ui-state-loading';

/** Класс состояния ошибки загрузки данных. */
export const ERROR_STATE_CLASS = 'ui-state-error';

/**
 * Точка входа к действию из пустого состояния: подпись и обработчик. Кнопка
 * собирается словарём кнопок (`./button.js`).
 */
export interface StateAction {
  /** Надпись кнопки (локализована вызывающим). */
  label: string;
  /** Обработчик клика. */
  onClick: () => void;
  /** Подсказка (нативный `title`). */
  title?: string;
  /** Роль кнопки; по умолчанию `secondary`. */
  role?: ButtonRole;
}

/** Опции пустого состояния. */
export interface EmptyStateOptions {
  /**
   * Заголовок — что здесь появится. Не задан — словарная строка по умолчанию
   * (`state.emptyTitle`).
   */
  title?: string;
  /** Подсказка — что сделать, чтобы данные появились. */
  hint?: string;
  /** Точка входа к действию (необязательна). */
  action?: StateAction;
}

/** Собирает кнопку действия пустого состояния словарём кнопок. */
function actionButton(action: StateAction): HTMLButtonElement {
  return uiButton({
    label: action.label,
    role: action.role ?? 'secondary',
    size: 's',
    class: EMPTY_STATE_ACTION_CLASS,
    ...(action.title !== undefined ? { title: action.title } : {}),
    onClick: () => action.onClick(),
  });
}

/**
 * Пустое состояние: заголовок и (при наличии) подсказка «что сделать» и
 * кнопка действия. Роль `status` — вспомогательные технологии озвучивают
 * смену состояния списка.
 */
export function emptyState(options: EmptyStateOptions = {}): HTMLDivElement {
  const box = div(EMPTY_STATE_CLASS);
  box.setAttribute('role', 'status');
  const title = div(EMPTY_STATE_TITLE_CLASS);
  title.textContent = options.title ?? t('state.emptyTitle');
  box.append(title);
  if (options.hint !== undefined && options.hint.trim() !== '') {
    const hint = div(EMPTY_STATE_HINT_CLASS);
    hint.textContent = options.hint;
    box.append(hint);
  }
  if (options.action !== undefined) box.append(actionButton(options.action));
  return box;
}

/**
 * Состояние загрузки — единая `muted`-строка. `text` по умолчанию —
 * словарное «Загрузка…» (`common.loading`).
 */
export function loadingState(text: string = t('common.loading')): HTMLDivElement {
  const box = div(`${LOADING_STATE_CLASS} muted`);
  box.setAttribute('role', 'status');
  box.textContent = text;
  return box;
}

/**
 * Состояние ошибки загрузки данных: строка ошибки единого вида
 * (`./messages.js`) и необязательное действие («Повторить»).
 */
export function errorState(message: string, action?: StateAction): HTMLDivElement {
  const box = div(ERROR_STATE_CLASS);
  box.append(errorParagraph(message));
  if (action !== undefined) box.append(actionButton(action));
  return box;
}
