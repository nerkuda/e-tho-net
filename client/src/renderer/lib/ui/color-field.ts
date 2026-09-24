/**
 * Поле цвета — единый фасад `lib/ui` (задача f351b894, требование e64083b5,
 * ADR 03eb2c61, инвентаризация 3fc7c54d — раздел «ColorField»).
 *
 * Нативный выбор цвета плюс (по желанию) поле HEX-значения, синхронизированное
 * с выбором. Два потребителя: палитры стиля мысли/связи (только picker) и
 * цвета слоя (picker + hex, «Свойства слоя» §2.2a).
 *
 * Самодельные `el('input', 'color-input')` и связка picker+hex запрещены —
 * сторож `guard-ui-fields.test.ts`.
 */

import { div } from '../dom.js';
import { fieldInput } from './field.js';

/** Класс цветового выбора. */
export const COLOR_PICKER_CLASS = 'ui-color-input';

/** Класс HEX-поля. */
export const COLOR_HEX_CLASS = 'ui-color-hex';

/** Опции {@link colorField}. */
export interface ColorFieldOptions {
  /** Начальное значение (`#rrggbb`). */
  value: string;
  id?: string;
  /** Добавить HEX-поле, синхронизированное с выбором. */
  withHex?: boolean;
  /** Дополнительные классы корня (раскладка владельца). */
  extraClass?: string;
  /** Уведомление о смене цвета (`input` у picker, `change` у hex). */
  onChange?: (hex: string) => void;
}

/** Дескриптор поля цвета. */
export interface ColorFieldHandle {
  /** Корень: picker (+ hex) в раскладке владельца. */
  root: HTMLDivElement;
  picker: HTMLInputElement;
  /** HEX-поле, если запрошено (`withHex`), иначе `null`. */
  hex: HTMLInputElement | null;
  /** Текущее значение в нижнем регистре. */
  value(): string;
}

/** Допустимое HEX-значение `#rrggbb`. */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Строит поле цвета (picker + опционально hex). */
export function colorField(o: ColorFieldOptions): ColorFieldHandle {
  const picker = fieldInput({
    type: 'text',
    value: o.value,
    extraClass: COLOR_PICKER_CLASS,
    bare: true,
  });
  picker.type = 'color';
  picker.addEventListener('input', () => {
    if (hex !== null) hex.value = picker.value;
    o.onChange?.(picker.value);
  });

  let hex: HTMLInputElement | null = null;
  if (o.withHex === true) {
    hex = fieldInput({
      value: o.value,
      extraClass: COLOR_HEX_CLASS,
      bare: true,
    });
    hex.addEventListener('change', () => {
      const trimmed = hex!.value.trim();
      if (HEX_RE.test(trimmed)) picker.value = trimmed.toLowerCase();
      else hex!.value = picker.value;
      o.onChange?.(picker.value);
    });
  }

  const root = div('ui-color-field');
  if (o.extraClass !== undefined && o.extraClass.trim() !== '') {
    root.classList.add(...o.extraClass.trim().split(/\s+/));
  }
  if (o.id !== undefined) picker.id = o.id;
  root.append(picker);
  if (hex !== null) root.append(hex);

  return {
    root,
    picker,
    hex,
    value: () => picker.value.toLowerCase(),
  };
}
