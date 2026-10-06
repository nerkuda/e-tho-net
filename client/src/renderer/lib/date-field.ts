/**
 * Компонентное поле даты «дата + календарь + очистка» (0.10.1, итерация
 * приёмки №8, п.4; элемент интерфейса «Поле периода» 2f14de06).
 *
 * Одно переиспользуемое поле: редактируемый ввод «голой даты» `YYYY-MM-DD`
 * (без времени) и две иконочные кнопки справа —
 *  • «календарь» ({@link svgIcon} `calendar-month`) — открывает внешний выбор
 *    даты/периода (диалог `lib/date-period-dialog.ts` передаётся колбэком
 *    {@link DateFieldOptions.onPick}, компонент не знает о модальности);
 *  • «крестик» (`x`) — очищает поле.
 *
 * Валидация та же, что у полей диалога `lib/date-period-dialog.ts`:
 * неразобранная строка откатывается к последнему корректному значению
 * (пустая строка — допустимое «не задано»). Валидатор даты общий —
 * `isValidLocalDay` из `lib/dates.ts`. Поле строится фасадом `lib/ui/field.ts`
 * (своих `<input>` не заводим, стандарт библиотечности a2488f05).
 *
 * Кросс-граничная проверка «С» ≤ «По» — обязанность потребителя (панель
 * периода `lib/period-editor.ts` использует `setPeriodFrom`/`setPeriodTo` из
 * диалога): поле отвечает только за одну дату.
 */

import { div } from './dom.js';
import { isValidLocalDay } from './dates.js';
import { svgIcon } from './ui/icon.js';
import { iconButton } from './ui/button.js';
import { fieldInput } from './ui/field.js';

/** Класс корня поля. */
export const DATE_FIELD_CLASS = 'date-field';
/** Класс ввода даты. */
export const DATE_FIELD_INPUT_CLASS = 'date-field-input';
/** Класс кнопки-календаря. */
export const DATE_FIELD_PICK_CLASS = 'date-field-pick';
/** Класс кнопки очистки. */
export const DATE_FIELD_CLEAR_CLASS = 'date-field-clear';

/** Опции {@link dateField}. */
export interface DateFieldOptions {
  /** Начальное значение `YYYY-MM-DD` (`''` — пусто). */
  value?: string;
  /** Доступное имя ввода (когда рядом нет видимой подписи). */
  ariaLabel?: string;
  disabled?: boolean;
  /**
   * Открыть внешний выбор даты/периода и вернуть дату для ЭТОГО поля
   * (`null` — отказ). Побочные эффекты на другие границы — на стороне
   * потребителя. Не задан — кнопка-календарь не показывается.
   */
  onPick?: () => Promise<string | null>;
  /** Новое значение поля: валидная дата `YYYY-MM-DD` либо `''` (очистка). */
  onChange?: (value: string) => void;
}

/** Рукоятка поля даты. */
export interface DateFieldHandle {
  root: HTMLElement;
  input: HTMLInputElement;
  /** Текущее значение (`YYYY-MM-DD` или `''`). */
  value(): string;
  /** Задать значение без вызова `onChange`. */
  setValue(value: string): void;
}

/** Допустимое «голое» значение поля. */
function normalize(value: string | undefined): string {
  const text = (value ?? '').trim();
  return isValidLocalDay(text) ? text : '';
}

/**
 * Собирает поле даты. `onChange` зовётся только на реальное изменение
 * (валидный ввод или очистка), не на откат невалидного ввода.
 */
export function dateField(opts: DateFieldOptions = {}): DateFieldHandle {
  let current = normalize(opts.value);

  const root = div(DATE_FIELD_CLASS);
  const input = fieldInput({
    type: 'text',
    extraClass: DATE_FIELD_INPUT_CLASS,
    value: current,
    placeholder: 'ГГГГ-ММ-ДД',
    maxLength: 10,
    title: 'Дата в формате ГГГГ-ММ-ДД',
    ariaLabel: opts.ariaLabel,
    disabled: opts.disabled === true,
  });
  input.inputMode = 'numeric';
  input.setAttribute('pattern', '\\d{4}-\\d{2}-\\d{2}');

  /** Показать/скрыть крестик: чистить нечего у пустого поля. */
  const syncClear = (): void => {
    clearBtn.hidden = current === '';
  };

  /** Зафиксировать ввод: валидная дата — принять, пустая — очистить, иначе откат. */
  const commit = (): void => {
    const raw = input.value.trim();
    if (raw === '') {
      if (current === '') return;
      current = '';
      syncClear();
      opts.onChange?.('');
      return;
    }
    if (!isValidLocalDay(raw)) {
      input.value = current;
      return;
    }
    if (raw === current) return;
    current = raw;
    input.value = raw;
    syncClear();
    opts.onChange?.(raw);
  };
  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);

  let picking = false;
  const pickBtn = iconButton({
    icon: svgIcon('calendar-month', 16),
    title: 'Выбрать дату в календаре',
    role: 'ghost',
    size: 's',
    class: DATE_FIELD_PICK_CLASS,
    disabled: opts.disabled === true,
    onClick: () => {
      if (opts.onPick === undefined || picking) return;
      picking = true;
      void opts
        .onPick()
        .then((value) => {
          if (value === null) return;
          const next = normalize(value);
          input.value = next;
          if (next === current) return;
          current = next;
          syncClear();
          opts.onChange?.(next);
        })
        .finally(() => {
          picking = false;
        });
    },
  });

  const clearBtn = iconButton({
    icon: svgIcon('x', 16),
    title: 'Очистить дату',
    role: 'ghost',
    size: 's',
    class: DATE_FIELD_CLEAR_CLASS,
    disabled: opts.disabled === true,
    onClick: () => {
      input.value = '';
      if (current === '') return;
      current = '';
      syncClear();
      opts.onChange?.('');
    },
  });

  root.append(input);
  if (opts.onPick !== undefined) root.append(pickBtn);
  root.append(clearBtn);
  syncClear();

  return {
    root,
    input,
    value: () => current,
    setValue: (value: string) => {
      current = normalize(value);
      input.value = current;
      syncClear();
    },
  };
}
