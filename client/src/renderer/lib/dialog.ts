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
 */

import { div, el, errText } from './dom.js';
import { t } from './i18n.js';
import { svgIcon } from './icons.js';
import { iconButton, uiButton } from './ui/button.js';
import { isFooterErrorLine, type ErrorAddress } from './ui/messages.js';
import { uiTabs, type TabsHandle } from './ui/tabs.js';

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


/** A dialog footer button. */
export interface DialogButton {
  label: string;
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
  /** Уведомление о переключении вкладки. */
  onTabChange?: (id: string) => void;
  /**
   * Роль размера — ширина и фиксированная высота (требование 13464c39).
   * По умолчанию `m`.
   */
  size?: DialogSize;
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
   * footer button, or `closeDialog()` popping the stack: it fires from the
   * backdrop's `remove` event, so removing the backdrop from the DOM by any
   * means triggers it exactly once.
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

/** Closes the topmost open dialog (no-op when none). */
export function closeDialog(): void {
  const top = stack.pop();
  top?.remove();
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
  focusFirstField(backdrop);
}

/** Best-effort focus into the raised dialog's first text field (the box itself as a fallback). */
function focusFirstField(backdrop: HTMLDivElement): void {
  const body = backdrop.querySelector<HTMLElement>('.dialog-body');
  if (body === null) return;
  for (const tag of ['input', 'textarea', 'select'] as const) {
    const control = body.querySelector<HTMLElement>(tag);
    if (control !== null) {
      control.focus();
      return;
    }
  }
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

/**
 * Shows a modal dialog. Returns its close function. Opening while another
 * dialog is open stacks the new one on top; the lower dialog stays mounted.
 */
export function showDialog(opts: DialogOptions): () => void {
  const backdrop = div('dialog-backdrop');
  const box = div('dialog-box');
  // Роль размера (требование 13464c39): класс несёт ширину и ФИКСИРОВАННУЮ
  // высоту, поэтому переключение вкладок и смена содержимого высоту не меняют.
  box.dataset['dialogSize'] = opts.size ?? 'm';

  /** Confirm button of this dialog — Ctrl+Enter clicks it. */
  let primaryBtn: HTMLButtonElement | null = null;

  const header = div('dialog-header');
  header.append(el('span', 'dialog-title', opts.title));
  const closeBtn = iconButton({
    icon: svgIcon('x', 14),
    title: t('actions.closeShortcut', 'Esc'),
    role: 'ghost',
    size: 's',
    onClick: () => close(),
  });
  header.append(closeBtn);
  box.append(header);

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

  const close = (): void => {
    const index = stack.indexOf(backdrop);
    if (index >= 0) stack.splice(index, 1);
    backdrop.remove();
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
      close();
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
  backdrop.addEventListener('remove', () => {
    dialogKeys.delete(backdrop);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keydown', onConfirm);
    window.removeEventListener('keydown', onShiftEnter);
    window.removeEventListener('keydown', onCtrlShiftEnter);
    backdrop.removeEventListener('click', onBackdropClick);
    opts.onClose?.();
  });
  opts.onMount?.(close, box);
  return close;
}

/**
 * Simple text prompt dialog. Resolves the entered text, or `null` when the
 * dialog is dismissed (any close path — «Отмена», Esc, ×).
 */
export function promptDialog(title: string, label: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const input = el('input', 'text-input');
    input.type = 'text';
    input.value = initial;
    const row = div('field');
    if (label !== '') row.append(el('label', 'field-label', label));
    row.append(input);
    const body = div('form-stack');
    body.append(row);

    /** Закрывающая функция каркаса — нужна обработчику Enter. */
    let closeSelf: (() => void) | null = null;
    let settled = false;
    /**
     * Единственная точка завершения промиса. Промис обязан резолвиться на
     * ЛЮБОМ пути закрытия диалога (ошибка e0360076): кнопки завершают его
     * явно, а Esc и × — через `onClose`. Флаг `settled` не даёт позднему
     * событию `remove` переиграть уже принятое решение.
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
 */
export function confirmDialog(title: string, message: string, danger = false): Promise<boolean> {
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
          label: t('actions.confirm'),
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

/** Standard field builder: label + control wrapper. */
export function field(label: string, control: HTMLElement): HTMLDivElement {
  const row = div('field');
  row.append(el('label', 'field-label', label));
  row.append(control);
  return row;
}
