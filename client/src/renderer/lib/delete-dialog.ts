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

/**
 * Открыть диалог удаления сущности. Кнопка «Удалить совсем» получает фокус и
 * выключается при `blocked`; вторая кнопка — «В корзину»/«Вернуть из корзины».
 */
export function openEntityDeleteDialog(opts: EntityDeleteDialogOptions): void {
  const body = div('form-stack');
  if (opts.caption !== undefined && opts.caption.trim() !== '') {
    body.append(el('p', 'dialog-text link-caption', opts.caption));
  }
  for (const line of opts.lines ?? []) {
    body.append(el('p', 'dialog-text', line));
  }

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

  showDialog({
    title: opts.title,
    size: 's',
    body,
    buttons,
    onMount: () => {
      deleteBtn?.focus();
      opts.onMount?.();
    },
    ...(opts.onClose !== undefined ? { onClose: opts.onClose } : {}),
  });
}
