/**
 * Modal dialog infrastructure (08-ui-spec.md §4, §6.6).
 *
 * Dialogs form a stack: opening one on top of another (a type editor over the
 * type list, a confirmation over an editor) keeps the lower dialog open, and
 * Escape / × close only the topmost one. Ctrl/Cmd+Enter
 * confirms the topmost dialog — it clicks its primary button, so «OK»,
 * «Применить», «Сохранить» etc. are reachable from any field without tabbing
 * to the footer. `promptDialog` and `confirmDialog` are convenience wrappers
 * for the most common inputs.
 *
 * Entity editors add a duplicate-open guard on top of the stack: a dialog may
 * declare `dedupeKey` (the entity it edits), and the caller first asks
 * {@link raiseOpenDialog} — a repeated click on the same row raises and focuses
 * the already-open editor instead of stacking a second one (ошибка c2d243bb).
 *
 * Entity editors also declare a dirty guard ({@link DialogDirtyGuard},
 * требование b58f6aad): when the form has unsaved changes, closing by Esc or ×
 * is intercepted by a confirmation («Данные изменены. Сохранить изменения?»)
 * offering «Сохранить» / «Не сохранять» / «Отменить закрытие». An explicit
 * footer button (including «Отмена») still closes silently.
 */

import { div, el, errText } from './dom.js';
import { t } from './i18n.js';
import { svgIcon } from './icons.js';
import { iconButton, uiButton } from './ui/button.js';
import { fieldInput, fieldRow } from './ui/field.js';
import { isFooterErrorLine, type ErrorAddress } from './ui/messages.js';
import { uiTabs, type TabsHandle } from './ui/tabs.js';
import { FOCUS_ANCHOR_ATTR, FOCUS_ANCHOR_SELECTOR } from './ui/focus-anchor.js';

/**
 * Роль размера диалога (требование 13464c39 «Стабильные размеры диалога:
 * роли S/M/L/XL, высота не зависит от вкладки»). Роль задаёт ширину и высоту:
 * высота фиксирована, поэтому переключение вкладок и раскрытие групп не
 * «дёргают» окно — длинное содержимое прокручивается внутри тела. Авто-высота
 * по содержимому запрещена.
 */
export type DialogSize = 's' | 'm' | 'l' | 'xl';

/** Вкладка диалога: подпись и ленивое содержимое панели (`lib/ui/tabs.ts`). */
export interface DialogTab {
  id: string;
  label: string;
  content: HTMLElement | (() => HTMLElement);
}


/**
 * Признак «есть несохранённые изменения» и команда записи диалога-редактора
 * (требование b58f6aad «Закрытие диалога-редактора с изменениями требует
 * подтверждения»). Форма объявляет грязность сама: каркас не знает её полей.
 * Если {@link isDirty} вернула `true`, закрытие диалога по Esc или крестику
 * перехватывается — вместо закрытия показывается подтверждение
 * «Данные изменены. Сохранить изменения?» с кнопками «Сохранить» /
 * «Не сохранять» / «Отменить закрытие». Явные кнопки футера (в т.ч. «Отмена»)
 * закрывают диалог молча, как и раньше.
 */
export interface DialogDirtyGuard {
  /** Есть ли расхождение текущих значений формы с загруженными. */
  isDirty: () => boolean;
  /**
   * Записать изменения и закрыть — ТОТ ЖЕ путь, что у кнопки сохранения
   * редактора: получает `close` каркаса и зовёт его сам при успехе; при ошибке
   * показывает её и оставляет редактор открытым (кнопка «Сохранить»
   * подтверждения закрывается в любом случае).
   */
  save: (close: () => void) => void;
}

/** A dialog footer button. */
export interface DialogButton {  label: string;
  primary?: boolean;
  danger?: boolean;
  /**
   * The confirm button for Ctrl/Cmd+Enter. Defaults to the `primary` button;
   * set explicitly when the visually primary button is not the confirm one
   * (a danger confirmation keeps «Отмена» primary-looking).
   */
  confirm?: boolean;
  /**
   * Called on click; receives the close function. By default a click also
   * closes the dialog right after this returns (so "Отмена"/"Закрыть"/simple
   * OK buttons need no extra handling). Set {@link keepOpen} when the button
   * must stay open — e.g. validation or async work that decides whether to
   * close — and call the passed `close` yourself on success.
   */
  onClick?: (close: () => void) => void;
  /** Keep the dialog open after {@link onClick} (validation/async flows). */
  keepOpen?: boolean;
  /** Receives the rendered button element (e.g. to toggle `disabled`). */
  ref?: (el: HTMLButtonElement) => void;
}

/** Options of {@link showDialog}. */
export interface DialogOptions {
  title: string;
  /**
   * Тело диалога. Не задаётся, когда содержимое разложено по вкладкам
   * ({@link tabs}); в остальных случаях обязательно.
   */
  body?: HTMLElement;
  /**
   * Вкладки диалога — единый механизм (`lib/ui/tabs.ts`). Панели ленивые,
   * высота диалога фиксирована ролью {@link size}, поэтому переключение
   * вкладок её не меняет. При заданных вкладках {@link body} не используется.
   */
  tabs?: DialogTab[];
  /** Активная вкладка при открытии (по умолчанию — первая). */
  activeTab?: string;
  /**
   * Блок между заголовком диалога и вкладками/телом — постоянная «шапка»
   * содержимого, общая для всех вкладок (не переключается вместе с ними).
   * Нужен редакторам сущностей, у которых идентичность (иконка, имя,
   * родитель, шестерёнка настроек) не принадлежит ни одной вкладке: она
   * остаётся видимой на любой из них. Прокрутки не имеет, высота — по
   * содержимому; полосы вкладок и тело забирают остаток.
   */
  headerExtra?: HTMLElement;
  /** Уведомление о переключении вкладки. */
  onTabChange?: (id: string) => void;
  /**
   * Роль размера — ширина и фиксированная высота (требование 13464c39).
   * По умолчанию `m`.
   */
  size?: DialogSize;
  /**
   * Фиксирует высоту диалога ролью {@link size}: тело прокручивается внутри,
   * а высота окна не меняется при смене содержимого внутри роли (требование
   * 13464c39 «Стабильные размеры диалога»). Нужен диалогам с переменным
   * содержимым, у которых нет вкладок: вкладочный диалог фиксирует высоту
   * автоматически, а без этого флага окно подстраивается под содержимое в
   * пределах роли и «дёргается» (ошибка 0ab63eac — настройки).
   */
  fixedHeight?: boolean;
  /**
   * Диалог «по содержимому»: окно растёт под своё содержимое, тело НЕ
   * прокручивается внутри — все контролы видны одновременно. Роль {@link size}
   * задаёт нижнюю границу ширины (чтобы сетка/поля не сжимались), высота не
   * ограничивается; при переполнении экрана прокручивается подложка, а не тело
   * диалога (ошибка 214ab5da — календарь даты/периода обрезался прокруткой).
   * Несовместим по смыслу с {@link fixedHeight} и {@link tabs}.
   */
  fitContent?: boolean;
  buttons?: DialogButton[];
  /**
   * Sticky custom footer element. When provided, {@link buttons} is ignored:
   * the caller owns the footer (its layout, sticky behaviour and buttons),
   * and is responsible for wiring `close` into a Cancel button if needed.
   * Esc and the primary/confirm button still close the dialog as usual;
   * pair with {@link extraShortcuts} for additional keys such as Shift+Enter.
   */
  customFooter?: HTMLElement;
  /**
   * Строка ошибки в панели кнопок (футере) — ОБЯЗАТЕЛЬНОЕ место любой ошибки
   * диалога: футер лежит вне тела и не переключается вместе с вкладками,
   * поэтому сообщение видно при активной любой вкладке (требование 397c5a56
   * «Сообщения диалога: любая ошибка — строкой на панели кнопок, клик ведёт к
   * полю»; ранее — ошибка add8d09d).
   *
   * Строку создаёт {@link footerErrorLine} из `lib/ui/messages.ts`; у неё есть
   * адрес ошибки (вкладка + поле) и клик по строке переключает на нужную
   * вкладку и ставит фокус в проблемное поле — переход подключает этот каркас
   * ({@link ErrorAddress}). Произвольный элемент (например, простой `span`)
   * каркас принимает и ставит в футер как прежде — без перехода.
   *
   * Относится только к дефолтному футеру ({@link buttons}); при
   * {@link customFooter} вызывающий кладёт строку в свой футер сам.
   */
  footerError?: HTMLElement;
  /**
   * Extra keyboard shortcuts handled while this dialog is on top. Esc closes
   * the dialog (built-in); Ctrl/Cmd+Enter clicks the primary button
   * (built-in via {@link DialogButton.confirm}).
   */
  extraShortcuts?: {
    /** Fired when the user presses Shift+Enter on the topmost dialog. */
    shiftEnter?: () => void;
    /**
     * Fired when the user presses Ctrl/Cmd+Shift+Enter on the topmost dialog.
     * The built-in Ctrl/Cmd+Enter only fires when Shift is NOT held, so this
     * is the way to express a separate «apply-with-focus» shortcut (L19).
     */
    ctrlShiftEnter?: () => void;
  };
  /** Called after the dialog is mounted (focus management, etc.). */
  onMount?: (close: () => void, box: HTMLElement) => void;
  /**
   * Called once when the dialog closes by ANY path — Esc, the × button, a
   * footer button, or `closeDialog()`: all of them funnel into the dialog's
   * single teardown, so it fires exactly once (not via a DOM `remove` event —
   * Chromium/Electron never fires one on `Element.remove()`).
   */
  onClose?: () => void;
  /**
   * Identity of the ENTITY this dialog edits (`thought-type:<id>`,
   * `property:<id>`; for an entity not created yet — the session key
   * `thought-type:new` / `property:new`, ошибка 74d9b4ed). Registered on the
   * stack so {@link raiseOpenDialog} can find the already-open dialog of the
   * same entity; the duplicate-open guard itself lives in the callers (they
   * call `raiseOpenDialog(key)` BEFORE building the body, taking a lock or
   * creating a promise — see `showThoughtTypeEditor` /
   * `openPropertyManagerEditor`, ошибки c2d243bb / 74d9b4ed). Dialogs without
   * an entity identity leave it unset and always stack.
   */
  dedupeKey?: string;
  /**
   * Признак несохранённых изменений формы (требование b58f6aad). Задан —
   * закрытие по Esc или крестику при {@link DialogDirtyGuard.isDirty} проверяется
   * подтверждением; не задан (списки, подтверждения, пикеры, панели) — закрытие
   * как всегда. Явные кнопки футера закрывают молча в любом случае.
   */
  dirty?: DialogDirtyGuard;
}

/** Open dialogs, bottom first. */
const stack: HTMLDivElement[] = [];

/** Entity identity of every open dialog that declared one ({@link DialogOptions.dedupeKey}). */
const dialogKeys = new WeakMap<HTMLDivElement, string>();

/** The subset of KeyboardEvent fields the dialog shortcuts inspect. */
export interface ShortcutEventLike {
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Whether a keydown is the plain Ctrl/Cmd+Enter confirm shortcut. Shift and
 * Alt variants are separate shortcuts (Shift+Enter, Ctrl+Shift+Enter) and
 * must NOT confirm: the confirm listener is registered first on `window`, so
 * a Ctrl+Shift+Enter it accepted would `preventDefault` and swallow the press
 * before the apply-with-focus handler ever sees it.
 */
export function isConfirmShortcut(event: ShortcutEventLike): boolean {
  if (event.repeat) return false;
  if (event.key !== 'Enter') return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  if (event.shiftKey || event.altKey) return false;
  return true;
}

/** Whether a keydown is the Ctrl/Cmd+Shift+Enter «apply + focus» shortcut (L19). */
export function isCtrlShiftEnterShortcut(event: ShortcutEventLike): boolean {
  if (event.repeat) return false;
  if (event.key !== 'Enter') return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  if (!event.shiftKey) return false;
  return true;
}

/** Per-dialog teardown: focus restore, `onClose`, listener cleanup, DOM removal. */
const teardowns = new WeakMap<HTMLDivElement, () => void>();

/** Closes the topmost open dialog (no-op when none). */
export function closeDialog(): void {
  const top = stack[stack.length - 1];
  if (top === undefined) return;
  teardowns.get(top)?.();
}

/**
 * Принадлежит ли узел открытому модальному диалогу. Нужно панелям, которые
 * закрываются кликом вне себя (строка поиска карты): клик внутри диалога,
 * открытого ИЗ этой панели, — не клик «вне панели» (ошибка 72a06e01).
 */
export function isInsideDialog(node: Node | null): boolean {
  if (node === null) return false;
  for (const backdrop of stack) {
    if (backdrop.contains(node)) return true;
  }
  return false;
}

/**
 * Поднимает уже открытый диалог сущности наверх и отдаёт ему фокус. Хук
 * повторного открытия (ошибка c2d243bb): двойной клик по строке списка даёт
 * ДВА события `click`, и без этой проверки редактор одной и той же сущности
 * открывался дважды — двумя независимыми черновиками друг поверх друга (один
 * из путей к DUPLICATE-рассинхрону 0bfd7180).
 *
 * Ищет диалог, зарегистрированный под `key` ({@link DialogOptions.dedupeKey}):
 * нет такого — возвращает `false`, и вызывающий открывает новый диалог обычным
 * порядком. Есть — переносит его в конец стопки (Esc/Ctrl+Enter снова
 * действуют на него), в конец DOM (перекрывает прочие диалоги), подсвечивает
 * и ставит фокус в первое поле; возвращает `true`, и вызывающий НЕ создаёт
 * второй диалог.
 *
 * Правило — «повторное открытие редактора той же сущности не создаёт второй
 * диалог, уже открытый поднимается»: намерение пользователя «открой мне это»
 * сохраняется, а не игнорируется. Редактор ДРУГОЙ сущности (другой ключ)
 * открывается поверх свободно — стопка диалогов не ломается.
 */
export function raiseOpenDialog(key: string): boolean {
  for (const backdrop of stack) {
    if (dialogKeys.get(backdrop) !== key) continue;
    raiseDialog(backdrop);
    return true;
  }
  return false;
}

/** Moves an open dialog to the top of the stack and the DOM, focuses and flashes it. */
function raiseDialog(backdrop: HTMLDivElement): void {
  const index = stack.indexOf(backdrop);
  if (index >= 0) {
    stack.splice(index, 1);
    stack.push(backdrop);
  }
  // `append` MOVES a node that is already in the document — this re-inserts the
  // backdrop after every other one, so it paints above the rest of the stack.
  document.body.append(backdrop);
  // Flash so the user sees which dialog the repeated click landed on. The class
  // is removed and re-added to restart the animation on a repeated raise.
  backdrop.classList.remove('dialog-raised');
  void backdrop.offsetWidth;
  backdrop.classList.add('dialog-raised');
  const box = backdrop.querySelector<HTMLElement>('.dialog-box');
  if (box !== null) focusOpenedDialog(backdrop, box);
}

/** Теги, которые браузер табилит по умолчанию (шаг «Tab»). */
const FOCUSABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);

/** Клавиши-стрелки: ими можно ходить по кнопкам панели кнопок. */
const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/**
 * Виден ли элемент для фокуса. В реальном DOM `display:none` даёт
 * `offsetParent === null`; в тестовом DOM-шиме свойство не определено, поэтому
 * проверку пропускаем — иначе фокус не находил бы управляющие элементы в тестах.
 */
function isVisibleForFocus(node: Element): boolean {
  const carrier = node as Element & { hidden?: boolean; offsetParent?: unknown };
  if (carrier.hidden === true) return false;
  if (carrier.offsetParent === null) return false;
  return true;
}

/** Фокусируемый элемент диалога: поле, кнопка, ссылка или contenteditable; не заблокирован и виден. */
function isFocusableNode(node: Element): boolean {
  const carrier = node as Element & {
    tagName?: string;
    disabled?: boolean;
    type?: string;
    isContentEditable?: boolean;
  };
  const tag = (carrier.tagName ?? '').toUpperCase();
  if (tag === 'A') return node.hasAttribute('href') && isVisibleForFocus(node);
  if (tag === 'INPUT' && carrier.type === 'hidden') return false;
  if (!FOCUSABLE_TAGS.has(tag) && carrier.isContentEditable !== true) return false;
  if (carrier.disabled === true) return false;
  return isVisibleForFocus(node);
}

/** Число из атрибута `tabindex`; `null` — атрибута нет (нативная фокусируемость). */
function tabIndexAttr(node: Element): number | null {
  const raw = node.getAttribute('tabindex');
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Ранг элемента в последовательной навигации Tab, либо `null` — не в порядке.
 *
 * `tabindex="-1"` исключает элемент из порядка даже когда он кликабелен — так
 * браузер пропускает кнопки неактивных вкладок (`lib/ui/tabs.ts`); раньше они
 * попадали в ловушку Tab, и порядок расходился с нативным. Явный неотрицательный
 * `tabindex` делает элемент шагом табуляции и тогда, когда его тег не входит в
 * нативный набор, — обёртка таблицы/дерева (`tabIndex = 0`) браузером табилится.
 * Без атрибута элемент участвует, только если фокусируем нативно; ранг `0` —
 * браузерный шаг по порядку DOM (ошибка ed26b7a3).
 */
function tabStopRank(node: Element): number | null {
  const attr = tabIndexAttr(node);
  // Свойство `tabIndex` — тот же источник, что атрибут: в реальном DOM оно его
  // отражает, а в тестовом DOM-шиме продукт ставит его напрямую (`tabs.ts` —
  // недоступные вкладки `tabIndex = -1`). Явный отрицательный признак берём из
  // любого источника — он исключает элемент из порядка табуляции.
  const prop = (node as { tabIndex?: number }).tabIndex;
  const explicit = attr ?? (typeof prop === 'number' && prop < 0 ? prop : null);
  if (explicit !== null) {
    if (explicit < 0) return null;
    const carrier = node as Element & { disabled?: boolean };
    if (carrier.disabled === true || !isVisibleForFocus(node)) return null;
    return explicit;
  }
  return isFocusableNode(node) ? 0 : null;
}

/**
 * Все фокусируемые потомки диалога в НАТИВНОМ порядке табуляции — для ловушки
 * Tab. Положительный `tabindex` идёт впереди нулевого и сортируется по
 * возрастанию; элементы с нулевым рангом — в порядке DOM (`Array.sort` в Node
 * стабильна). Порядок совпадает с браузерной последовательностью фокуса, иначе
 * Tab «перепрыгивал» бы элементы (ошибка ed26b7a3).
 */
export function collectFocusables(root: Element): HTMLElement[] {
  const out: Array<{ el: HTMLElement; rank: number }> = [];
  const walk = (node: Element): void => {
    for (const child of Array.from(node.children) as Element[]) {
      const rank = tabStopRank(child);
      if (rank !== null) out.push({ el: child as HTMLElement, rank });
      walk(child);
    }
  };
  walk(root);
  // Нулевой ранг — «после всех положительных», поэтому его ключ — +∞: так
  // стабильная сортировка сохраняет порядок DOM среди нулевых.
  const key = (rank: number): number => (rank > 0 ? rank : Number.POSITIVE_INFINITY);
  return out.sort((a, b) => key(a.rank) - key(b.rank)).map((entry) => entry.el);
}

/** Первое текстовое поле диалога — курсор при открытии ставится в него (08-ui-spec.md §4.2). */
function firstTextField(root: Element): HTMLElement | null {
  for (const node of collectFocusables(root)) {
    const tag = (node.tagName ?? '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return node;
  }
  return null;
}

/** Кнопки панели кнопок (футера): по ним ходят стрелки в диалогах подтверждения. */
function footerButtons(box: Element): HTMLButtonElement[] {
  const footer = box.querySelector('.dialog-footer');
  if (footer === null) return [];
  return (Array.from(footer.querySelectorAll('button')) as HTMLButtonElement[]).filter((button) =>
    isFocusableNode(button),
  );
}

/**
 * Ставит фокус в только что открытый (верхний) диалог. Без этого фокус
 * остаётся в нижележащем диалоге, и Tab/стрелки продолжают ходить по нему —
 * именно так диалог подтверждения закрытия «не получал» фокус (ошибка
 * 0c45bce8). Приоритет: первое текстовое поле → первая кнопка панели кнопок →
 * любой фокусируемый элемент → сам бокс (`tabindex="-1"`). Диалог-редактор
 * может переопределить выбор своим `onMount` — он вызывается после.
 */
function focusOpenedDialog(backdrop: HTMLElement, box: HTMLElement): void {
  const text = firstTextField(backdrop);
  if (text !== null) {
    text.focus();
    return;
  }
  const buttons = footerButtons(box);
  const firstButton = buttons[0];
  if (firstButton !== undefined) {
    firstButton.focus();
    return;
  }
  const focusables = collectFocusables(box);
  const firstFocusable = focusables[0];
  if (firstFocusable !== undefined) {
    firstFocusable.focus();
    return;
  }
  box.focus();
}

/**
 * Переход по клику на строку ошибки панели кнопок
 * ({@link DialogOptions.footerError}, требование 397c5a56): активирует вкладку
 * (или собственное состояние вкладок вызывающего — {@link ErrorAddress.activate})
 * и ставит фокус в проблемное поле. Поле берётся геттером уже ПОСЛЕ активации:
 * панель вкладки ленива и к моменту показа ошибки могла быть ещё не построена.
 */
function navigateToError(address: ErrorAddress, tabs: TabsHandle | null): void {
  address.activate?.();
  if (address.tab !== undefined && tabs !== null) tabs.setActive(address.tab);
  const field = address.field?.() ?? null;
  if (field === null) return;
  field.focus();
  if (typeof field.scrollIntoView === 'function') field.scrollIntoView({ block: 'nearest' });
}

/** Element that owned focus before a dialog opened (checks `isConnected` + `focus`). */
type FocusableElement = Element & { focus?: () => void };

/** Селектор якоря фокуса — контейнер клавиатурной навигации списка/дерева/таблицы. */
const FOCUS_ANCHOR_QUERY = FOCUS_ANCHOR_SELECTOR;

/** Теги полей ввода: возврат фокуса в них якорь списка не перебивает. */
const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Пользователь печатал в это поле (ввод/select/contenteditable). */
function isTextEntry(element: FocusableElement | null | undefined): boolean {
  if (element === null || element === undefined) return false;
  const tagName = (element as { tagName?: string }).tagName?.toUpperCase() ?? '';
  if (TEXT_ENTRY_TAGS.has(tagName)) return true;
  return (element as { isContentEditable?: boolean }).isContentEditable === true;
}

/** Родитель-элемент: `parentElement` в DOM, `parent` — в тестовом DOM-шиме. */
function parentElementOf(node: Element): Element | null {
  const carrier = node as Element & { parentElement?: Element | null; parent?: Element | null };
  return carrier.parentElement ?? carrier.parent ?? null;
}

/**
 * Якорь возврата фокуса — устойчивый контейнер клавиатурной навигации
 * ({@link FOCUS_ANCHOR_ATTR}): сам владелец фокуса или его предок; а если
 * диалог открыли кнопкой тулбара или пунктом контекстного меню — якорь диалога,
 * НАД которым открывается новый. Диалог-редактор открывают над диалогом-списком,
 * поэтому якорь живого списка лежит в верхнем открытом диалоге. `null` — якоря
 * нет, фокус вернём прежнему владельцу (ошибка 28d69bc6, правило 10 требования
 * 11ddd910).
 */
function resolveFocusAnchor(from: FocusableElement | null | undefined): HTMLElement | null {
  let node: Element | null = from ?? null;
  while (node !== null) {
    if (node.hasAttribute(FOCUS_ANCHOR_ATTR)) return node as HTMLElement;
    node = parentElementOf(node);
  }
  const below = stack[stack.length - 1];
  if (below !== undefined) {
    const host = below.querySelector<HTMLElement>(FOCUS_ANCHOR_QUERY);
    if (host !== null) return host;
  }
  return null;
}

/**
 * Возврат фокуса после закрытия диалога. Устойчивый якорь списка/дерева
 * предпочтительнее прежнего владельца фокуса: редактор открывают кнопкой
 * тулбара или пунктом меню, и `document.activeElement` в этот момент — кнопка
 * (а после закрытия контекстного меню — вообще `body`); возврат фокуса туда не
 * оживляет стрелочную навигацию списка (ошибка 28d69bc6). Исключение — поле
 * ввода: если пользователь печатал в нём, фокус возвращаем полю.
 */
function restoreFocus(
  previouslyFocused: FocusableElement | null | undefined,
  focusAnchor: HTMLElement | null,
): void {
  const order: Array<FocusableElement | HTMLElement | null | undefined> = isTextEntry(previouslyFocused)
    ? [previouslyFocused, focusAnchor]
    : [focusAnchor, previouslyFocused];
  for (const candidate of order) {
    if (candidate === null || candidate === undefined) continue;
    if (candidate.isConnected === false) continue;
    if (typeof candidate.focus !== 'function') continue;
    candidate.focus();
    return;
  }
}

/**
 * Shows a modal dialog. Returns its close function. Opening while another
 * dialog is open stacks the new one on top; the lower dialog stays mounted.
 */
export function showDialog(opts: DialogOptions): () => void {
  // Элемент, владевший фокусом до открытия диалога (обычно обёртка списка,
  // из которого диалог открыли). Фокуса возвращаем ЯКОРЮ навигации — устойчивому
  // контейнеру списка/дерева, переживающему перерисовку строк; прежний владелец —
  // запасной вариант. Иначе стрелки списка не работают без повторного клика
  // (ошибка 28d69bc6, правило 10 требования 11ddd910).
  const previouslyFocused = document.activeElement as FocusableElement | null | undefined;
  const focusAnchor = resolveFocusAnchor(previouslyFocused);
  const backdrop = div('dialog-backdrop');
  const box = div('dialog-box');
  // Бокс принимает программный фокус (fallback, когда в диалоге нет ни поля, ни
  // кнопки): `tabindex="-1"` не встаёт в порядок табуляции, но позволяет
  // `focus()` — так верхний диалог удерживает фокус (ошибка 0c45bce8).
  box.setAttribute('tabindex', '-1');
  // Роль размера (требование 13464c39): класс несёт ширину и ФИКСИРОВАННУЮ
  // высоту, поэтому переключение вкладок и смена содержимого высоту не меняют.
  box.dataset['dialogSize'] = opts.size ?? 'm';
  // Диалог с переменным содержимым без вкладок (настройки) фиксирует высоту
  // ролью явно — тело тогда прокручивается, а окно не «дёргается» (ошибка
  // 0ab63eac, требование 13464c39).
  if (opts.fixedHeight === true) box.dataset['dialogFixedHeight'] = 'true';
  // Диалог «по содержимому»: окно растёт под содержимое, тело не прокручивается,
  // переполнение уходит в подложку (ошибка 214ab5da). Разметку задаёт CSS по
  // атрибуту, прокрутку подложки подключает класс на ней же.
  if (opts.fitContent === true) {
    box.dataset['dialogFit'] = 'true';
    backdrop.classList.add('dialog-backdrop-scroll');
  }

  /** Confirm button of this dialog — Ctrl+Enter clicks it. */
  let primaryBtn: HTMLButtonElement | null = null;

  const header = div('dialog-header');
  header.append(el('span', 'dialog-title', opts.title));
  const closeBtn = iconButton({
    icon: svgIcon('x', 14),
    title: t('actions.closeShortcut', 'Esc'),
    role: 'ghost',
    size: 's',
    onClick: () => requestClose(),
  });
  header.append(closeBtn);
  box.append(header);

  // Постоянная шапка содержимого (идентичность сущности) — над вкладками,
  // общая для всех: не переключается и не прокручивается вместе с ними.
  if (opts.headerExtra !== undefined) {
    const extra = div('dialog-header-extra');
    extra.append(opts.headerExtra);
    box.append(extra);
  }

  // Тело: либо вкладки (единый механизм lib/ui/tabs.ts), либо единый блок
  // тела. Оба варианта занимают оставшуюся высоту и прокручиваются внутри —
  // высота задана ролью, а не содержимым.
  /** Дескриптор вкладок диалога — нужен переходу по клику на строку ошибки. */
  let tabsHandle: TabsHandle | null = null;
  if (opts.tabs !== undefined && opts.tabs.length > 0) {
    // Признак вкладочного диалога: CSS фиксирует его высоту ролью, поэтому
    // переключение вкладок высоту не меняет (требование 13464c39).
    box.dataset['dialogTabs'] = 'true';
    const host = div('dialog-tabs-host');
    const tabs = uiTabs({
      tabs: opts.tabs,
      activeId: opts.activeTab,
      onChange: opts.onTabChange,
    });
    tabsHandle = tabs;
    host.append(tabs.root);
    box.append(host);
  } else {
    const body = div('dialog-body');
    if (opts.body !== undefined) body.append(opts.body);
    box.append(body);
  }

  if (opts.customFooter !== undefined) {
    box.append(opts.customFooter);
  } else if (opts.buttons !== undefined && opts.buttons.length > 0) {
    const footer = div('dialog-footer');
    // Строка ошибки в панели кнопок — видна на любой вкладке (требование
    // 397c5a56): ошибка занимает свободное место слева, кнопки — справа.
    if (opts.footerError !== undefined) {
      footer.classList.add('dialog-footer-with-error');
      // Строке словаря подключаем переход к вкладке и полю; произвольный
      // элемент (старые вызовы) просто кладётся в футер.
      if (isFooterErrorLine(opts.footerError)) {
        opts.footerError.setNavigate((address) => navigateToError(address, tabsHandle));
      }
      footer.append(opts.footerError);
    }
    for (const item of opts.buttons) {
      const btn = uiButton({
        label: item.label,
        role: item.danger === true ? 'danger' : item.primary === true ? 'primary' : 'secondary',
        onClick: () => {
          item.onClick?.(close);
          // Default: a click dismisses the dialog. Buttons that need to stay
          // open (validation/async) set `keepOpen: true` and close themselves.
          if (item.keepOpen !== true) close();
        },
      });
      if (item.confirm === true || (item.confirm === undefined && item.primary === true)) {
        if (primaryBtn === null) primaryBtn = btn;
      }
      item.ref?.(btn);
      footer.append(btn);
    }
    box.append(footer);
  }

  /**
   * Единственная точка закрытия диалога: снимает его со стопки, отписывает
   * слушатели, возвращает фокус и зовёт `onClose`, затем убирает подложку из
   * DOM. Вызывается НАПРЯМУЮ из всех путей закрытия (Esc, ×, кнопки футера,
   * `closeDialog`) — на DOM-событие `remove` полагаться нельзя: в
   * Chromium/Electron `Element.remove()`/`removeChild()` его НЕ шлют, поэтому
   * блок очистки по событию в живом клиенте не выполнялся вовсе (фокус не
   * возвращался, промисы `promptDialog`/`confirmDialog` на Esc/× не
   * резолвились, листенеры и `dialogKeys` не снимались; давнее происхождение —
   * `f0e2fba4`). Идемпотентна: повторный вызов ничего не переигрывает.
   */
  const close = (): void => {
    if (teardowns.get(backdrop) === undefined) return;
    teardowns.delete(backdrop);
    const index = stack.indexOf(backdrop);
    if (index >= 0) stack.splice(index, 1);
    dialogKeys.delete(backdrop);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keydown', onConfirm);
    window.removeEventListener('keydown', onShiftEnter);
    window.removeEventListener('keydown', onCtrlShiftEnter);
    window.removeEventListener('keydown', onTab);
    window.removeEventListener('keydown', onArrows);
    backdrop.removeEventListener('click', onBackdropClick);
    // Возврат фокуса владельцу списка (ошибка 28d69bc6): стрелочная навигация
    // продолжается без повторного клика. Фокус ставим до `onClose` — обработчик
    // может открыть следующий диалог, который снимет фокус себе сам.
    restoreFocus(previouslyFocused, focusAnchor);
    opts.onClose?.();
    backdrop.remove();
  };
  teardowns.set(backdrop, close);
  /**
   * Показать подтверждение закрытия «грязного» редактора (требование
   * b58f6aad): три решения — «Сохранить» (записать и закрыть), «Не сохранять»
   * (закрыть без записи), «Отменить закрытие» (ничего не делать). Отдельный
   * диалог поверх редактора; его собственное закрытие (Esc/крестик) означает
   * «Отменить закрытие» — редактор остаётся открытым.
   */
  const confirmDirtyClose = (): void => {
    showDialog({
      title: t('dialog.unsaved.title'),
      size: 's',
      body: el('p', 'dialog-text', t('dialog.unsaved.message')),
      // Порядок: «отказ от закрытия» → «закрыть без записи» → «записать и
      // закрыть» (главное действие справа, как в остальных футерах).
      buttons: [
        { label: t('dialog.unsaved.stay') },
        { label: t('dialog.unsaved.discard'), onClick: () => close() },
        {
          label: t('dialog.unsaved.save'),
          primary: true,
          confirm: true,
          onClick: () => opts.dirty?.save(close),
        },
      ],
    });
  };
  /**
   * Закрытие диалога для путей Esc и крестика. При объявленном
   * {@link DialogOptions.dirty} и наличии изменений закрытие перехватывается
   * подтверждением; иначе — как раньше. Явные кнопки футера зовут `close`
   * напрямую (в т.ч. «Отмена» — молча, требование b58f6aad, п. 3).
   */
  const requestClose = (): void => {
    if (opts.dirty !== undefined && opts.dirty.isDirty()) {
      confirmDirtyClose();
      return;
    }
    close();
  };
  const onKey = (event: KeyboardEvent): void => {
    // Lower dialogs ignore Escape even though they see the event too —
    // same-target capture listeners run in registration order.
    if (event.key === 'Escape' && !event.repeat && stack[stack.length - 1] === backdrop) {
      // preventDefault marks the press as consumed: the global Escape handler
      // (app.initKeyboard, bubble phase) must not close the dialog *below*
      // the one just closed here (L21 fix — Escape over a stacked dialog
      // closed the whole stack). Key auto-repeat is ignored for the same
      // reason: a held Escape would otherwise walk the stack down.
      event.preventDefault();
      requestClose();
    }
  };
  window.addEventListener('keydown', onKey, true);
  const onConfirm = (event: KeyboardEvent): void => {
    // Bubble phase: field-level handlers (batch add, the thought picker,
    // candidate lists) consume Ctrl+Enter first via
    // preventDefault; the dialog confirms only a still-unhandled press.
    if (!isConfirmShortcut(event)) return;
    if (event.defaultPrevented) return;
    if (stack[stack.length - 1] !== backdrop) return;
    if (primaryBtn === null) return;
    event.preventDefault();
    primaryBtn.click();
  };
  window.addEventListener('keydown', onConfirm);

  const onShiftEnter = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (event.key !== 'Enter' || !event.shiftKey) return;
    // Shift+Enter is the «Apply without closing» shortcut used by the unified
    // settings dialog. Esc closes via onKey (capture); Ctrl+Enter above wins
    // when both modifiers are held.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.defaultPrevented) return;
    if (stack[stack.length - 1] !== backdrop) return;
    if (opts.extraShortcuts?.shiftEnter === undefined) return;
    event.preventDefault();
    opts.extraShortcuts.shiftEnter();
  };
  window.addEventListener('keydown', onShiftEnter);

  const onCtrlShiftEnter = (event: KeyboardEvent): void => {
    if (!isCtrlShiftEnterShortcut(event)) return;
    if (event.defaultPrevented) return;
    if (stack[stack.length - 1] !== backdrop) return;
    if (opts.extraShortcuts?.ctrlShiftEnter === undefined) return;
    event.preventDefault();
    opts.extraShortcuts.ctrlShiftEnter();
  };
  window.addEventListener('keydown', onCtrlShiftEnter);

  /**
   * Ловушка фокуса верхнего диалога (ошибка 0c45bce8). Tab не покидает
   * верхний диалог: на краях порядок заворачивается внутрь. Виджет, который сам
   * обработал Tab (таблица — переход по ячейкам), помечает событие
   * `preventDefault`, и каркас его не трогает.
   */
  const onTab = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.defaultPrevented) return;
    if (stack[stack.length - 1] !== backdrop) return;
    const focusables = collectFocusables(box);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      box.focus();
      return;
    }
    const active = (document.activeElement ?? null) as FocusableElement | null;
    if (active === null || active === box || !box.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    const index = focusables.indexOf(active as HTMLElement);
    if (index < 0) return;
    if (!event.shiftKey && index === focusables.length - 1) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && index === 0) {
      event.preventDefault();
      last.focus();
    }
  };
  window.addEventListener('keydown', onTab);

  /**
   * Стрелки по кнопкам панели кнопок (ошибка 0c45bce8): в диалогах
   * подтверждения Tab и ←/→/↑/↓ одинаково ходят по кнопкам. Перехватываем
   * только когда фокус уже на кнопке футера или на самом боксе диалога —
   * в поле стрелки двигают курсор, и там их трогать нельзя.
   */
  const onArrows = (event: KeyboardEvent): void => {
    if (!ARROW_KEYS.has(event.key) || event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.defaultPrevented) return;
    if (stack[stack.length - 1] !== backdrop) return;
    const buttons = footerButtons(box);
    if (buttons.length === 0) return;
    const active = (document.activeElement ?? null) as FocusableElement | null;
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const index = active === null ? -1 : buttons.indexOf(active as HTMLButtonElement);
    if (index < 0) {
      if (active !== box) return;
      event.preventDefault();
      (forward ? buttons[0] : buttons[buttons.length - 1])?.focus();
      return;
    }
    event.preventDefault();
    buttons[(index + (forward ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };
  window.addEventListener('keydown', onArrows);

  // Клик по подложке мимо тела диалога НЕ ЗАКРЫВАЕТ диалог (правило задачи
  // c9353ce1, отменяющее cc28ee10): модальный диалог закрывают только кнопки,
  // выбор из списка и Esc. Правило «клик мимо закрывает» отменено — при
  // выделении текста мышью с отпусканием кнопки за пределами окна диалог
  // закрывался без сохранения и терял правки пользователя. Клик по самому
  // боксу и его содержимому приходит как `target`, отличный от подложки.
  //
  // Событие всё равно гасится (`preventDefault` + `stopPropagation`): клик
  // мимо не должен проваливаться на холст и всплывающие панели, закрывающиеся
  // кликом вне себя (панель поиска карты — `isInsideDialog`). Это поведение
  // сохраняется с cc28ee10, снято только закрытие.
  const onBackdropClick = (event: MouseEvent): void => {
    if (event.target !== backdrop) return;
    event.preventDefault();
    event.stopPropagation();
  };
  backdrop.addEventListener('click', onBackdropClick);

  backdrop.append(box);
  document.body.append(backdrop);
  stack.push(backdrop);
  if (opts.dedupeKey !== undefined) dialogKeys.set(backdrop, opts.dedupeKey);
  // Фокус — в ТОЛЬКО ЧТО открытый (верхний) диалог. Диалог, объявивший
  // `onMount`, управляет фокусом сам (редакторы, списки с полем поиска) — не
  // вмешиваемся, чтобы не перевести фокус дважды. Каркас ставит фокус диалогам
  // БЕЗ `onMount` (подтверждения, сообщения): иначе при открытии подтверждения
  // над редактором фокус остаётся в редакторе, и Tab ходит по нему — ошибка
  // 0c45bce8.
  if (opts.onMount === undefined) focusOpenedDialog(backdrop, box);
  opts.onMount?.(close, box);
  return close;
}

/**
 * Simple text prompt dialog. Resolves the entered text, or `null` when the
 * dialog is dismissed (any close path — «Отмена», Esc, ×).
 */
export function promptDialog(title: string, label: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const input = fieldInput({ value: initial });
    const row = fieldRow({ label, control: input });
    const body = div('form-stack');
    body.append(row);

    /** Закрывающая функция каркаса — нужна обработчику Enter. */
    let closeSelf: (() => void) | null = null;
    let settled = false;
    /**
     * Единственная точка завершения промиса. Промис обязан резолвиться на
     * ЛЮБОМ пути закрытия диалога (ошибка e0360076): кнопки завершают его
     * явно, а Esc и × — через `onClose`. Флаг `settled` не даёт повторному
     * пути (кнопка плюс `onClose`) переиграть уже принятое решение.
     */
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    closeSelf = showDialog({
      title,
      size: 's',
      body,
      buttons: [
        { label: t('actions.cancel'), onClick: () => finish(null) },
        {
          label: t('actions.apply'),
          primary: true,
          onClick: () => finish(input.value),
        },
      ],
      // Esc и × — отмена: контракт «`null` on cancel», ровно как по кнопке
      // «Отмена» (ошибка e0360076).
      onClose: () => finish(null),
      onMount: () => {
        input.focus();
        input.select();
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(input.value);
            closeSelf?.();
          }
        });
      },
    });
  });
}

/**
 * Confirmation dialog with a message. Resolves `true` on confirm and `false`
 * when the dialog is dismissed (any close path — «Отмена», Esc, ×).
 *
 * `confirmLabel` переопределяет подпись подтверждающей кнопки (напр. «Удалить»
 * для удаления последнего владельца вложения, замечание Б2 приёмки b02ef1cf);
 * по умолчанию — общая `actions.confirm`.
 */
export function confirmDialog(
  title: string,
  message: string,
  danger = false,
  confirmLabel?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    /** Единственная точка завершения промиса — см. {@link promptDialog}. */
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    showDialog({
      title,
      size: 's',
      body: el('p', 'dialog-text', message),
      buttons: [
        { label: t('actions.cancel'), onClick: () => finish(false) },
        {
          label: confirmLabel ?? t('actions.confirm'),
          primary: !danger,
          danger,
          confirm: true,
          onClick: () => finish(true),
        },
      ],
      // Esc и × — отказ: контракт «`false` on cancel», ровно как по кнопке
      // «Отмена» (ошибка e0360076).
      onClose: () => finish(false),
    });
  });
}

/** Shows an error dialog with the thrown value's message. */
export function errorDialog(title: string, err: unknown): void {
  showDialog({
    title,
    size: 's',
    body: el('p', 'dialog-text dialog-text-error', errText(err)),
    buttons: [{ label: t('actions.close'), primary: true }],
  });
}
