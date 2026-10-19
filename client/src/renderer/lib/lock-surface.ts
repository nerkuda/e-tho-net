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

/** Что было у элемента до перевода формы в чтение. */
type BlockedElementState =
  | { kind: 'disabled'; value: boolean }
  | { kind: 'contenteditable'; value: string | null };

/**
 * Исходное состояние элементов, выключенных именно нами: корень формы →
 * (элемент → состояние). Нужно для обратного перехода
 * ({@link unblockEditingSurface}) — не все поля были активны до блокировки
 * (например, «Применить» мог быть выключен проверкой имени).
 */
const blockedSurfaces = new WeakMap<HTMLElement, Map<HTMLElement, BlockedElementState>>();

/** Запомнить исходное состояние элемента ровно один раз (повторные блокировки). */
function rememberState(root: HTMLElement, node: HTMLElement, state: BlockedElementState): void {
  let records = blockedSurfaces.get(root);
  if (records === undefined) {
    records = new Map();
    blockedSurfaces.set(root, records);
  }
  if (!records.has(node)) records.set(node, state);
}

/**
 * Переводит форму в режим чтения: поля ввода и `contenteditable` выключаются,
 * кнопки записи становятся недоступны, в начало `root` добавляется строка
 * предупреждения. Вкладки, прокрутка и закрытие диалога не затрагиваются —
 * значения остаются видимыми.
 *
 * Повторный вызов обновляет текст и не плодит строки; исходное состояние
 * запоминается при ПЕРВОЙ блокировке, поэтому {@link unblockEditingSurface}
 * вернёт именно его.
 */
export function blockEditingSurface(opts: BlockEditingSurfaceOptions): void {
  const { root, message } = opts;
  for (const selector of ['input', 'textarea', 'select', '[contenteditable="true"]']) {
    for (const node of root.querySelectorAll<HTMLElement>(selector)) {
      if (selector === '[contenteditable="true"]') {
        rememberState(root, node, { kind: 'contenteditable', value: node.getAttribute('contenteditable') });
        node.setAttribute('contenteditable', 'false');
      } else {
        const control = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        rememberState(root, control, { kind: 'disabled', value: control.disabled });
        control.disabled = true;
      }
    }
  }
  for (const button of opts.commitButtons ?? []) {
    if (button !== null && button !== undefined) {
      rememberState(root, button, { kind: 'disabled', value: (button as HTMLButtonElement).disabled });
      (button as HTMLButtonElement).disabled = true;
    }
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

/**
 * Обратный переход: форма снова редактируется (ошибка 2301d73d — снятие
 * чужого захвата другим клиентом). Восстанавливает РОВНО то состояние, что
 * было до блокировки (включая изначально выключенные кнопки), и убирает
 * строку предупреждения. Повторный вызов безопасен.
 */
export function unblockEditingSurface(root: HTMLElement): void {
  const records = blockedSurfaces.get(root);
  if (records !== undefined) {
    for (const [node, state] of records) {
      if (state.kind === 'contenteditable') {
        if (state.value === null) node.removeAttribute('contenteditable');
        else node.setAttribute('contenteditable', state.value);
      } else {
        (node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement).disabled =
          state.value;
      }
    }
    blockedSurfaces.delete(root);
  }
  root.querySelector<HTMLElement>(`[${LOCK_BLOCKED_ATTR}]`)?.remove();
}
