/**
 * Сообщения и строки ошибок `lib/ui` (задача e20761c2, требование 397c5a56
 * «Сообщения диалога: любая ошибка — строкой на панели кнопок, клик ведёт к
 * полю», ADR 03eb2c61, инвентаризация 3fc7c54d — раздел ErrorLine).
 *
 * Единственный источник разметки и вида строк ошибок клиента. Самодельные
 * `span('', 'error-text')` и литералы `Ошибка:` в рендерере запрещены —
 * сторож `guard-dialog-tab-error.test.ts`.
 *
 * Три места под ошибку:
 *   • {@link footerErrorLine} — панель кнопок диалога (ОБЯЗАТЕЛЬНОЕ место
 *     любой ошибки диалога: футер виден при активной любой вкладке). Строка
 *     умеет адрес {@link ErrorAddress}: клик по ней переключает вкладку и
 *     ставит фокус в проблемное поле (`lib/dialog.ts` подключает переход);
 *   • {@link fieldError} — дублирование ошибки у самого поля (опционально);
 *   • {@link errorLine} / {@link errorParagraph} — строки ошибок панелей,
 *     таблиц и экранов (не диалогов): вид единый, место — по месту панели.
 *
 * Тексты здесь — литералы: локализация (ревизия терминологии) отдельной
 * задачей; сюда же переехал префикс `Ошибка:` — единственная точка его
 * объявления.
 */

import { el, errText, span } from '../dom.js';

/** Класс строки ошибки — единственная точка определения (вид в `styles.css`). */
export const ERROR_LINE_CLASS = 'error-text';

/** Маркер строки-дублирования у поля (отступ от контрола, `./messages.css`). */
export const FIELD_ERROR_CLASS = 'field-error';

/** Маркер строки ошибки в панели кнопок диалога. */
export const FOOTER_ERROR_CLASS = 'dialog-footer-error';

/** Маркер кликабельной строки (у неё есть адрес для перехода). */
export const ERROR_LINE_LINK_CLASS = 'error-text--link';

/**
 * Строка ошибки панели/таблицы/экрана. Вид задан классом
 * {@link ERROR_LINE_CLASS}; текст пишет вызывающий (`textContent`) или
 * {@link setStatusText}.
 */
export function errorLine(text = ''): HTMLSpanElement {
  return span(text, ERROR_LINE_CLASS);
}

/** Строка ошибки абзацем — там, где место ошибки блочное (`<p>`). */
export function errorParagraph(text = ''): HTMLParagraphElement {
  return el('p', ERROR_LINE_CLASS, text);
}

/**
 * Дублирование ошибки у поля: та же строка, но помеченная
 * {@link FIELD_ERROR_CLASS} — компонент поля владеет отступом, вид не
 * расходится с футерной строкой.
 */
export function fieldError(text = ''): HTMLSpanElement {
  return span(text, `${ERROR_LINE_CLASS} ${FIELD_ERROR_CLASS}`);
}

/**
 * Текст ошибки операции из брошенного значения: `<prefix>: <сообщение>`.
 * Единственная точка префикса `Ошибка:` — вызывающий передаёт свой только
 * для уточнённых формулировок («Ошибка поиска», «Не удалось загрузить»).
 */
export function operationErrorText(err: unknown, prefix = 'Ошибка'): string {
  return `${prefix}: ${errText(err)}`;
}

/** Строка ошибки операции готовым элементом ({@link operationErrorText}). */
export function operationError(err: unknown, prefix = 'Ошибка'): HTMLSpanElement {
  return errorLine(operationErrorText(err, prefix));
}

/**
 * Показывает текст в узле, переключая вид «ошибка / обычное сообщение»
 * (блоки настроек, где одна и та же строка несёт и успех, и сбой).
 */
export function setStatusText(node: HTMLElement, text: string, isError = false): void {
  node.textContent = text;
  node.classList.toggle(ERROR_LINE_CLASS, isError);
  node.classList.toggle('muted', !isError);
}

/**
 * Адрес ошибки диалога — куда ведёт клик по строке панели кнопок.
 * Все поля необязательны: без адреса строка просто показывает сообщение.
 */
export interface ErrorAddress {
  /** id вкладки каркаса (`DialogOptions.tabs`) — каркас активирует её сам. */
  tab?: string;
  /**
   * Дополнительная навигация вызывающего — для диалогов со СВОИМИ вкладками
   * (переключатели внутри тела): перевести их в нужное состояние.
   */
  activate?: () => void;
  /**
   * Проблемное поле для фокуса. Геттер, а не элемент: панель вкладки ленива и
   * к моменту показа ошибки может быть ещё не построена.
   */
  field?: () => HTMLElement | null;
}

/** Строка ошибки панели кнопок диалога (с переходом по клику). */
export interface FooterErrorLine extends HTMLSpanElement {
  /** Показать сообщение; `address` включает переход по клику. */
  show(message: string, address?: ErrorAddress): void;
  /** Погасить строку (пустое сообщение, адрес сброшен). */
  clear(): void;
  /** Подключает переход — каркас диалога (`lib/dialog.ts`). */
  setNavigate(navigate: (address: ErrorAddress) => void): void;
}

/**
 * Строка ошибки панели кнопок. Передаётся в `DialogOptions.footerError`;
 * каркас диалога при монтаже подключает к ней переход к вкладке и полю
 * ({@link ErrorAddress}) — потребитель лишь вызывает {@link FooterErrorLine.show}
 * с адресом.
 */
export function footerErrorLine(extraClass?: string): FooterErrorLine {
  const node = span('', ERROR_LINE_CLASS) as FooterErrorLine;
  node.classList.add(FOOTER_ERROR_CLASS);
  if (extraClass !== undefined && extraClass.trim() !== '') {
    for (const name of extraClass.trim().split(/\s+/)) node.classList.add(name);
  }

  let navigate: ((address: ErrorAddress) => void) | null = null;
  let address: ErrorAddress | null = null;

  /** Кликабельность строки: нужен и адрес, и подключённый переход. */
  const refreshClickable = (): void => {
    node.classList.toggle(ERROR_LINE_LINK_CLASS, address !== null && navigate !== null);
  };

  node.setNavigate = (fn: (address: ErrorAddress) => void): void => {
    navigate = fn;
    refreshClickable();
  };
  node.show = (message: string, target?: ErrorAddress): void => {
    node.textContent = message;
    address = message === '' ? null : (target ?? null);
    refreshClickable();
  };
  node.clear = (): void => {
    node.textContent = '';
    address = null;
    refreshClickable();
  };
  node.addEventListener('click', () => {
    if (navigate !== null && address !== null) navigate(address);
  });
  return node;
}

/** Отличает строку панели кнопок от произвольного элемента (`footerError`). */
export function isFooterErrorLine(node: HTMLElement): node is FooterErrorLine {
  const candidate = node as Partial<FooterErrorLine>;
  return typeof candidate.show === 'function' && typeof candidate.setNavigate === 'function';
}
