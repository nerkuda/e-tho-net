/**
 * Modal dialog infrastructure (08-ui-spec.md §4, §6.6).
 *
 * Dialogs form a stack: opening one on top of another (a type editor over the
 * type list, a confirmation over an editor) keeps the lower dialog open, and
 * Escape / backdrop click / × close only the topmost one. Ctrl/Cmd+Enter
 * confirms the topmost dialog — it clicks its primary button, so «OK»,
 * «Применить», «Сохранить» etc. are reachable from any field without tabbing
 * to the footer. `promptDialog` and `confirmDialog` are convenience wrappers
 * for the most common inputs.
 */

import { button, div, el, errText } from './dom.js';
import { svgIcon } from './icons.js';

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
  body: HTMLElement;
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
  width?: number;
  /**
   * Extra class on the dialog box — for CSS-driven sizing that a fixed px
   * {@link width} cannot express (e.g. the group-delete table dialog,
   * §5a.2: `clamp(400px, …, 1000px)` "as much as fits the screen").
   */
  boxClass?: string;
  /** Called after the dialog is mounted (focus management, etc.). */
  onMount?: (close: () => void) => void;
}

/** Open dialogs, bottom first. */
const stack: HTMLDivElement[] = [];

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
 * Shows a modal dialog. Returns its close function. Opening while another
 * dialog is open stacks the new one on top; the lower dialog stays mounted.
 */
export function showDialog(opts: DialogOptions): () => void {
  const backdrop = div('dialog-backdrop');
  const box = div('dialog-box');
  if (opts.boxClass !== undefined) box.classList.add(...opts.boxClass.split(/\s+/));
  if (opts.width !== undefined) box.style.width = `${opts.width}px`;
  // Custom footers (e.g. the unified settings dialog) want a scrollable body
  // and a sticky bottom bar; opt in via the `dialog-box-tall` class so the
  // default one-button footer stays as small as before.
  if (opts.customFooter !== undefined) box.classList.add('dialog-box-tall');

  /** Confirm button of this dialog — Ctrl+Enter clicks it. */
  let primaryBtn: HTMLButtonElement | null = null;

  const header = div('dialog-header');
  header.append(el('span', 'dialog-title', opts.title));
  const closeBtn = button('', () => close(), 'dialog-close', 'Закрыть (Esc)');
  closeBtn.append(svgIcon('x', 14));
  header.append(closeBtn);
  box.append(header);

  const body = div('dialog-body');
  body.append(opts.body);
  box.append(body);

  if (opts.customFooter !== undefined) {
    box.append(opts.customFooter);
  } else if (opts.buttons !== undefined && opts.buttons.length > 0) {
    const footer = div('dialog-footer');
    for (const item of opts.buttons) {
      const btn = button(
        item.label,
        () => {
          item.onClick?.(close);
          // Default: a click dismisses the dialog. Buttons that need to stay
          // open (validation/async) set `keepOpen: true` and close themselves.
          if (item.keepOpen !== true) close();
        },
        ['dialog-btn', item.primary === true ? 'primary' : '', item.danger === true ? 'danger' : '']
          .filter((c) => c !== '')
          .join(' '),
      );
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
    // thought_ref candidate lists) consume Ctrl+Enter first via
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

  backdrop.append(box);
  document.body.append(backdrop);
  stack.push(backdrop);
  backdrop.addEventListener('remove', () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keydown', onConfirm);
    window.removeEventListener('keydown', onShiftEnter);
    window.removeEventListener('keydown', onCtrlShiftEnter);
  });
  opts.onMount?.(close);
  return close;
}

/**
 * Simple text prompt dialog. Resolves the entered text or `null` on cancel.
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

    const finish = (value: string | null): void => {
      resolve(value);
    };
    showDialog({
      title,
      body,
      buttons: [
        { label: 'Отмена', onClick: () => finish(null) },
        {
          label: 'OK',
          primary: true,
          onClick: () => finish(input.value),
        },
      ],
      onMount: () => {
        input.focus();
        input.select();
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(input.value);
            closeDialog();
          }
        });
      },
    });
  });
}

/**
 * Confirmation dialog with a message. Resolves `true` on confirm.
 */
export function confirmDialog(title: string, message: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      resolve(value);
    };
    showDialog({
      title,
      body: el('p', 'dialog-text', message),
      buttons: [
        { label: 'Отмена', onClick: () => finish(false) },
        {
          label: 'Подтвердить',
          primary: !danger,
          danger,
          confirm: true,
          onClick: () => finish(true),
        },
      ],
    });
  });
}

/** Shows an error dialog with the thrown value's message. */
export function errorDialog(title: string, err: unknown): void {
  showDialog({
    title,
    body: el('p', 'dialog-text dialog-text-error', errText(err)),
    buttons: [{ label: 'Закрыть', primary: true }],
  });
}

/** Standard field builder: label + control wrapper. */
export function field(label: string, control: HTMLElement): HTMLDivElement {
  const row = div('field');
  row.append(el('label', 'field-label', label));
  row.append(control);
  return row;
}
