/**
 * Общий диалог удаления сущности: «Удалить совсем» (физическое удаление) либо
 * «В корзину» (пометка) и «Отмена» — единый фасад для мыслей, связей,
 * публикаций и полок (задача 00160da1; образец — диалог удаления мысли
 * `openThoughtDeleteDialog`). Параллельных «своих» окон удаления быть не
 * должно: поведение (доступность «Удалить совсем», причины блокировки,
 * переключение «В корзину»/«Вернуть из корзины») задано один раз здесь.
 *
 * Фасад отвечает только за разметку и кнопки; что именно вызывать в API,
 * решает потребитель через {@link EntityDeleteDialogOptions.onPurge} и
 * {@link EntityDeleteDialogOptions.onTrash}. Проверка блокировки тоже на
 * потребителе: он приносит готовый флаг `blocked` и человекочитаемые причины
 * (`lines`). Так диалог одинаково работает и для сущностей с серверным
 * `deletion-check` (мысль, связь, публикация, полка), и для локальных случаев.
 */

import { div, el } from './dom.js';
import { t } from './i18n.js';
import { showDialog, type DialogButton } from './dialog.js';

/** Параметры {@link openEntityDeleteDialog}. */
export interface EntityDeleteDialogOptions {
  /** Заголовок окна (локализован вызывающим). */
  title: string;
  /** Первая строка тела — что именно удаляем (например, подпись связи). */
  caption?: string;
  /** Дополнительные строки тела: причины блокировки, осиротевшие потомки. */
  lines?: readonly string[];
  /** Физическое удаление недоступно — «Удалить совсем» выключено. */
  blocked: boolean;
  /** Ссылка «Открыть использование…» (панель использования, f7623077). */
  usageLink?: () => void;
  /**
   * Перечитать блокировки после мутации панели использования: возвращает
   * новые строки и флаг «удалить совсем нельзя». Окно обновляет тело и
   * доступность кнопки, не пересоздаваясь (спека f7623077: панель обновляет
   * открытые диалоги удаления).
   */
  refresh?: () => Promise<DeleteDialogRefreshState | null>;
  /** Сущность уже в корзине — кнопка корзины становится «Вернуть». */
  alreadyMarked: boolean;
  /** Переопределить подпись кнопки корзины (по умолчанию toTrash/restore). */
  trashLabel?: string;
  /** Физическое удаление: потребитель сам закрывает окно при успехе. */
  onPurge: (close: () => void) => void | Promise<void>;
  /** Пометить/снять корзину: потребитель сам закрывает окно при успехе. */
  onTrash: (close: () => void) => void | Promise<void>;
  /** После отрисовки (фокус уже на «Удалить совсем»). */
  onMount?: () => void;
  /** При любом закрытии окна. */
  onClose?: () => void;
}

/** Новое состояние тела открытого диалога удаления после перечитывания. */
export interface DeleteDialogRefreshState {
  lines: readonly string[];
  blocked: boolean;
}

/** Живые диалоги удаления — панель использования обновляет их после мутаций. */
const openDeleteDialogs = new Set<() => void>();

/**
 * Перечитывает блокировки всех открытых диалогов удаления (панель
 * использования зовёт после очистки свойств/удаления слоя, f7623077).
 */
export function refreshOpenDeleteDialogs(): void {
  for (const refresh of [...openDeleteDialogs]) refresh();
}

/**
 * Открыть диалог удаления сущности. Кнопка «Удалить совсем» получает фокус и
 * выключается при `blocked`; вторая кнопка — «В корзину»/«Вернуть из корзины».
 *
 * При `blocked` под причинами показывается ссылка «Открыть использование…»
 * (переход в панель использования, спека f7623077); окно при переходе
 * закрывается, чтобы модальная подложка не перекрывала панель.
 */
export function openEntityDeleteDialog(opts: EntityDeleteDialogOptions): void {
  const body = div('form-stack');
  if (opts.caption !== undefined && opts.caption.trim() !== '') {
    body.append(el('p', 'dialog-text link-caption', opts.caption));
  }
  const linesBox = div('form-stack');
  const fillLines = (lines: readonly string[]): void => {
    linesBox.replaceChildren(
      ...lines.map((line) => el('p', 'dialog-text', line)),
    );
  };
  fillLines(opts.lines ?? []);
  body.append(linesBox);
  const usageLink = el('button', 'link-btn', 'Открыть использование…');
  usageLink.type = 'button';
  usageLink.classList.toggle('hidden', !opts.blocked);
  if (opts.usageLink !== undefined) body.append(usageLink);

  let deleteBtn: HTMLButtonElement | null = null;
  const buttons: DialogButton[] = [
    {
      label: t('actions.deleteForever'),
      danger: true,
      ref: (btn) => {
        deleteBtn = btn;
        btn.disabled = opts.blocked;
      },
      keepOpen: true,
      onClick: (close) => opts.onPurge(close),
    },
    {
      label: opts.trashLabel ?? (opts.alreadyMarked ? t('actions.restore') : t('actions.toTrash')),
      keepOpen: true,
      onClick: (close) => opts.onTrash(close),
    },
    { label: t('actions.cancel') },
  ];

  // Перечитывание блокировок по запросу панели использования (f7623077).
  const refresh = (): void => {
    if (opts.refresh === undefined) return;
    void opts.refresh().then((state) => {
      if (state === null) return;
      fillLines(state.lines);
      if (deleteBtn !== null) deleteBtn.disabled = state.blocked;
      usageLink.classList.toggle('hidden', !state.blocked);
    });
  };

  const close = showDialog({
    title: opts.title,
    size: 's',
    body,
    buttons,
    onMount: () => {
      deleteBtn?.focus();
      if (opts.refresh !== undefined) openDeleteDialogs.add(refresh);
      opts.onMount?.();
    },
    onClose: () => {
      openDeleteDialogs.delete(refresh);
      opts.onClose?.();
    },
  });

  // Переход в панель использования: сначала закрываем модальное окно, затем
  // открываем панель — иначе подложка диалога перекрыла бы её.
  usageLink.addEventListener('click', () => {
    close();
    opts.usageLink?.();
  });
}
