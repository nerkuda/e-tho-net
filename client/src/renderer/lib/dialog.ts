/**
 * Modal dialog infrastructure (08-ui-spec.md §4, §6.6).
 *
 * Dialogs form a stack: opening one on top of another (a type editor over the
 * type list, a confirmation over an editor) keeps the lower dialog open, and
 * Escape / backdrop click / × close only the topmost one. `promptDialog` and
 * `confirmDialog` are convenience wrappers for the most common inputs.
 */

import { button, div, el, errText } from './dom.js';
import { svgIcon } from './icons.js';

/** A dialog footer button. */
export interface DialogButton {
  label: string;
  primary?: boolean;
  danger?: boolean;
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
}

/** Options of {@link showDialog}. */
export interface DialogOptions {
  title: string;
  body: HTMLElement;
  buttons?: DialogButton[];
  width?: number;
  /** Called after the dialog is mounted (focus management, etc.). */
  onMount?: (close: () => void) => void;
}

/** Open dialogs, bottom first. */
const stack: HTMLDivElement[] = [];

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
  if (opts.width !== undefined) box.style.width = `${opts.width}px`;

  const header = div('dialog-header');
  header.append(el('span', 'dialog-title', opts.title));
  const closeBtn = button('', () => close(), 'dialog-close', 'Закрыть (Esc)');
  closeBtn.append(svgIcon('x', 14));
  header.append(closeBtn);
  box.append(header);

  const body = div('dialog-body');
  body.append(opts.body);
  box.append(body);

  if (opts.buttons !== undefined && opts.buttons.length > 0) {
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
    if (event.key === 'Escape' && stack[stack.length - 1] === backdrop) close();
  };
  window.addEventListener('keydown', onKey, true);

  backdrop.append(box);
  document.body.append(backdrop);
  stack.push(backdrop);
  backdrop.addEventListener('remove', () => {
    window.removeEventListener('keydown', onKey, true);
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
        { label: 'Подтвердить', primary: !danger, danger, onClick: () => finish(true) },
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
