/**
 * Заглушки вкладок «Свойства» и «Отборы» редактора типа мысли для
 * несохранённого типа (задача e7352642): общий хелпер, чтобы обе вкладки
 * выглядели и вели себя одинаково. Пока у типа нет id, добавление свойств
 * и отборов недоступно — «Типы источников»/«Типы назначений» для нового
 * свойства не настроить, потому что создаваемого типа ещё нет в списках.
 *
 * Заметная кнопка «Сохранить» (роль `primary` словаря `lib/ui`, задачи
 * 56f1dcb2 / e7352642) вызывает переданный колбэк — ту же команду, что у
 * кнопки «Записать» в футере диалога (`apply('stay', …)`): пишет накопленный
 * черновик на сервер без закрытия диалога, после чего обе вкладки
 * оживают (`getTypeId()` начинает возвращать id, перерисовка через
 * `render()` / `refresh()`).
 *
 * Без колбэка кнопка не рисуется — для редакторов типов связи концепция
 * «отборов» неприменима, и в свойствах у нового типа связи отдельной
 * кнопки быть не должно.
 */

import { div, el } from './dom.js';
import { uiButton } from './ui/button.js';

export interface NewTypeHintOpts {
  /** Подсказка под кнопкой: разная на «Свойствах» и «Отборах». */
  message: string;
  /** Команда «Сохранить». Без неё кнопка не рисуется. */
  onSave?: () => void;
}

/** Builds the standard «save the type first» hint used by both tabs. */
export function renderNewTypeHint(opts: NewTypeHintOpts): HTMLElement {
  const wrap = div('new-type-hint');
  wrap.append(el('p', 'muted new-type-hint-text', opts.message));
  if (opts.onSave !== undefined) {
    wrap.append(
      uiButton({
        label: 'Сохранить',
        role: 'primary',
        size: 'm',
        title: 'Записать тип и не закрывать диалог',
        onClick: () => opts.onSave?.(),
      }),
    );
  }
  return wrap;
}
