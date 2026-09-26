/**
 * Поле пути к файлу — единый фасад `lib/ui` (задача f351b894, требование
 * e64083b5, ADR 03eb2c61, инвентаризация 3fc7c54d — раздел «FilePathField
 * (путь+кнопка)»).
 *
 * Поле ввода пути и кнопка выбора файла на диске с единой подписью
 * `t('actions.browse')` («Обзор…»): раньше диалоги экспорта, импорта и
 * вложений повторяли пару «поле + Обзор…» каждый со своей подписью.
 *
 * Внутри — {@link fieldInput} (однострочное поле пути) и {@link uiButton};
 * раскладка «поле + кнопка» — `.input-with-btn`. Фасад владеет разметкой и
 * фактом записи выбранного пути в поле; сам выбор файла (OS-диалог) делает
 * `onPick`, отданный владельцем.
 */

import { div } from '../dom.js';
import { t } from '../i18n.js';
import { uiButton } from './button.js';
import { fieldInput, type FieldInputType } from './field.js';

/** Опции {@link filePathField}. */
export interface FilePathFieldOptions {
  /** Начальное значение пути. */
  value?: string;
  id?: string;
  placeholder?: string;
  /** Поле только для чтения (путь выбирается кнопкой). */
  readonly?: boolean;
  /** Тип поля; по умолчанию `text`. */
  type?: FieldInputType;
  /** Дополнительные классы поля. */
  extraClass?: string;
  /** Проверка орфографии (по умолчанию нативная). */
  spellcheck?: boolean;
  /** Подпись кнопки; по умолчанию `t('actions.browse')`. */
  buttonLabel?: string;
  /** Подсказка кнопки. */
  buttonTitle?: string;
  /**
   * Выбор файла владельцем: возвращает новый путь (запишется в поле) либо
   * `null`/`''` — отмена. Внутри можно делать побочные действия (например,
   * подставить имя файла в соседнее поле заголовка).
   */
  onPick: (current: string) => Promise<string | null> | string | null;
}

/** Дескриптор поля пути. */
export interface FilePathFieldHandle {
  /** Раскладка «поле + кнопка» (`.input-with-btn`). */
  root: HTMLDivElement;
  input: HTMLInputElement;
  /** Кнопка выбора — владелец может скрывать/менять её подпись. */
  button: HTMLButtonElement;
}

/** Строит поле пути с кнопкой выбора файла. */
export function filePathField(o: FilePathFieldOptions): FilePathFieldHandle {
  const input = fieldInput({
    id: o.id,
    value: o.value,
    placeholder: o.placeholder,
    readonly: o.readonly,
    type: o.type,
    extraClass: o.extraClass,
    spellcheck: o.spellcheck,
  });
  const button = uiButton({
    label: o.buttonLabel ?? t('actions.browse'),
    title: o.buttonTitle,
    role: 'secondary',
    size: 's',
    onClick: () => {
      void Promise.resolve(o.onPick(input.value)).then((picked) => {
        if (picked !== null && picked !== '') input.value = picked;
      });
    },
  });
  const root = div('input-with-btn');
  root.append(input, button);
  return { root, input, button };
}
