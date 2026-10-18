/**
 * Перевод уже открытой формы в режим чтения при чужом захвате (ошибка
 * 4f18d9f5).
 *
 * Захват объекта мягкий: сервер отклоняет запись 409, но чтение не блокирует
 * (ADR 705fb6d3). Поэтому диалог не закрывается — он остаётся доступным для
 * просмотра, но поля ввода и кнопки записи выключаются, а сверху появляется
 * объяснение. Без этого тост «поля заблокированы» расходился с поведением:
 * поля выглядели редактируемыми.
 *
 * Модуль намеренно не знает ни о сети, ни о состоянии приложения: только DOM.
 * Текст предупреждения готовит вызывающий (`lock-guard`).
 */

/** Параметры {@link blockEditingSurface}. */
export interface BlockEditingSurfaceOptions {
  /** Корень диалога или формы: внутри выключаются поля ввода. */
  root: HTMLElement;
  /** Готовая строка предупреждения. */
  message: string;
  /** Кнопки записи («Применить», «Записать») — тоже выключаются. */
  commitButtons?: ReadonlyArray<HTMLElement | null>;
}

/** Маркер строки-предупреждения: по нему вызов остаётся идемпотентным. */
export const LOCK_BLOCKED_ATTR = 'data-lock-blocked';

/**
 * Переводит форму в режим чтения: поля ввода и `contenteditable` выключаются,
 * кнопки записи становятся недоступны, в начало `root` добавляется строка
 * предупреждения. Вкладки, прокрутка и закрытие диалога не затрагиваются —
 * значения остаются видимыми.
 *
 * Повторный вызов обновляет текст и не плодит строки.
 */
export function blockEditingSurface(opts: BlockEditingSurfaceOptions): void {
  const { root, message } = opts;
  for (const selector of ['input', 'textarea', 'select', '[contenteditable="true"]']) {
    for (const node of root.querySelectorAll<HTMLElement>(selector)) {
      if (selector === '[contenteditable="true"]') {
        node.setAttribute('contenteditable', 'false');
      } else {
        (node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).disabled = true;
      }
    }
  }
  for (const button of opts.commitButtons ?? []) {
    if (button !== null && button !== undefined) (button as HTMLButtonElement).disabled = true;
  }
  let note = root.querySelector<HTMLElement>(`[${LOCK_BLOCKED_ATTR}]`);
  if (note === null) {
    note = document.createElement('p');
    note.className = 'dialog-text dialog-text-error';
    note.setAttribute(LOCK_BLOCKED_ATTR, 'true');
    root.prepend(note);
  }
  note.textContent = message;
}
