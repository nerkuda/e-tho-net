/**
 * Поле ввода — единый фасад `lib/ui` (задача f351b894, требование e64083b5
 * «Поля и переключатели — фасады lib/ui над Web Awesome», ADR 03eb2c61,
 * инвентаризация 3fc7c54d — раздел «Field»).
 *
 * **Состав фасада.** Единый набор поля: подпись, подсказка, строка ошибки,
 * кнопка очистки и состояния (hover / focus / disabled / readonly). Режимы
 * контрола: однострочный ({@link fieldInput}), многострочный
 * ({@link fieldTextarea}) и числовой (`fieldInput({ type: 'number', min, max,
 * step })`). Строка поля собирается {@link fieldRow}; очистка —
 * {@link wrapClearable} (перенесена из `editor/value-editor.ts`).
 *
 * **Реализация — нативная, а не `wa-input`.** Web Awesome Core подключён и
 * красится токенами (задача 95dd50b9), но фасад намеренно строит НАТИВНЫЙ
 * `<input>`/`<textarea>`:
 *  1. **Тестируемость.** Юнит-тесты клиента идут на общем DOM-шиме
 *     (`tests/dom-shim.ts`), custom elements вендора в нём не исполняются —
 *     у `wa-input` не было бы ни `.value`, ни событий, и почти все тесты
 *     полей стали бы непроверяемыми. Тот же довод, что у `./tabs.ts` (свои
 *     вкладки) и `./button.ts` (нативный `<button>`), прецедент этапа 1.
 *  2. **Совместимость потребителей.** Экраны читают `.value`, `valueAsNumber`
 *     и события `input`/`change` — нативный контрол сохраняет их без правок.
 *  3. **Плотность ETN важнее.** Вид задаётся токенами (`./field.css`), обе темы
 *     работают через `[data-theme]`.
 * API фасада стабилен: подмена реализации на `wa-input` позже не тронет
 * потребителей (ADR 03eb2c61, следствие «API фасадов стабилен»).
 *
 * Самодельные поля (`el('input', 'text-input')` и подобные) в рендерере
 * запрещены — сторож `guard-ui-fields.test.ts`. Базовые классы объявлены
 * только здесь: `ui-input`, `ui-textarea`, `ui-field`, `ui-field-label`,
 * `ui-field-hint`, `ui-clearable`.
 */

import { div, el, span } from '../dom.js';
import { t } from '../i18n.js';
import { fieldError } from './messages.js';

/** Класс строки поля (подпись + контрол + подсказка + ошибка). */
export const FIELD_CLASS = 'ui-field';

/** Класс подписи поля. */
export const FIELD_LABEL_CLASS = 'ui-field-label';

/** Класс подсказки поля (серый текст под контролом). */
export const FIELD_HINT_CLASS = 'ui-field-hint';

/** Базовый класс однострочного/числового контрола. */
export const FIELD_CONTROL_CLASS = 'ui-input';

/** Класс многострочного контрола (в дополнение к {@link FIELD_CONTROL_CLASS}). */
export const FIELD_MULTILINE_CLASS = 'ui-textarea';

/** Класс состояния «только чтение» и «выключено» помечаются атрибутом. */
export const FIELD_DISABLED_CLASS = 'ui-field--disabled';

/** Обёртка поля с кнопкой очистки. */
export const FIELD_CLEARABLE_CLASS = 'ui-clearable';

/** Кнопка очистки внутри обёртки. */
export const FIELD_CLEAR_BTN_CLASS = 'ui-clearable-btn';

/** Типы контрола однострочного поля (закрытый словарь фасада). */
export type FieldInputType =
  | 'text'
  | 'url'
  | 'search'
  | 'password'
  | 'number'
  | 'date'
  | 'datetime-local'
  | 'time';

/** Общие опции контрола поля (однострочного и многострочного). */
export interface FieldControlOptions {
  /** id контрола (для `htmlFor` подписи). */
  id?: string;
  /** Начальное значение. */
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  /** Доступное имя, когда рядом нет видимой подписи. */
  ariaLabel?: string;
  /** Нативная подсказка (`title`). */
  title?: string;
  spellcheck?: boolean;
  /**
   * Дополнительные классы-МОДИФИКАТОРЫ прикладного слоя (например,
   * `chrono-meta-input`). Роли и состояния задавать здесь нельзя.
   */
  extraClass?: string;
  /**
   * Не добавлять базовый класс {@link FIELD_CONTROL_CLASS}: специализированные
   * виджеты (`st-f-input`, `entity-chip-input`, `search-input`) носят своё
   * оформление и не должны получать базовое.
   */
  bare?: boolean;
  onInput?: (value: string, event: Event) => void;
  onChange?: (value: string, event: Event) => void;
  onKeydown?: (event: KeyboardEvent) => void;
}

/** Опции однострочного/числового контрола. */
export interface FieldInputOptions extends FieldControlOptions {
  /** Тип; по умолчанию `text`. */
  type?: FieldInputType;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  maxLength?: number;
}

/** Опции многострочного контрола. */
export interface FieldTextareaOptions extends FieldControlOptions {
  rows?: number;
}

/** Собирает строку классов контрола: базовый (если не `bare`) + модификаторы. */
function controlClass(o: FieldControlOptions, base: string): string {
  const parts: string[] = [];
  if (o.bare !== true) parts.push(base);
  if (o.extraClass !== undefined && o.extraClass.trim() !== '') parts.push(o.extraClass.trim());
  return parts.join(' ');
}

/** Навешивает общие для всех контролов атрибуты и обработчики. */
function applyCommon(
  node: HTMLInputElement | HTMLTextAreaElement,
  o: FieldControlOptions,
): void {
  if (o.id !== undefined) node.id = o.id;
  if (o.value !== undefined) node.value = o.value;
  if (o.placeholder !== undefined) node.placeholder = o.placeholder;
  if (o.disabled === true) node.disabled = true;
  if (o.readonly === true) node.readOnly = true;
  if (o.required === true) node.required = true;
  if (o.title !== undefined) node.title = o.title;
  if (o.ariaLabel !== undefined) node.setAttribute('aria-label', o.ariaLabel);
  if (o.spellcheck !== undefined) node.spellcheck = o.spellcheck;
  if (o.onInput !== undefined) node.addEventListener('input', (e) => o.onInput!(node.value, e));
  if (o.onChange !== undefined) node.addEventListener('change', (e) => o.onChange!(node.value, e));
  if (o.onKeydown !== undefined) {
    node.addEventListener('keydown', o.onKeydown as EventListener);
  }
}

/**
 * Однострочное/числовое поле. Возвращает сам контрол: потребители читают
 * `.value`/`.valueAsNumber` и вешают события как раньше.
 */
export function fieldInput(o: FieldInputOptions = {}): HTMLInputElement {
  const node = el('input', controlClass(o, FIELD_CONTROL_CLASS));
  node.type = o.type ?? 'text';
  if (o.min !== undefined) node.min = String(o.min);
  if (o.max !== undefined) node.max = String(o.max);
  if (o.step !== undefined) node.step = String(o.step);
  if (o.maxLength !== undefined) node.maxLength = o.maxLength;
  applyCommon(node, o);
  return node;
}

/** Многострочное поле. */
export function fieldTextarea(o: FieldTextareaOptions = {}): HTMLTextAreaElement {
  const node = el('textarea', controlClass(o, FIELD_CONTROL_CLASS));
  if (o.bare !== true) node.classList.add(FIELD_MULTILINE_CLASS);
  if (o.rows !== undefined) node.rows = o.rows;
  applyCommon(node, o);
  return node;
}

/** Опции строки поля. */
export interface FieldRowOptions {
  /** Подпись; пусто — строки подписи нет. */
  label?: string;
  /** Контрол (обычно {@link fieldInput} / {@link fieldTextarea}). */
  control: HTMLElement;
  /** id контрола для связи подписи (`<label for>`). */
  id?: string;
  /** Подсказка под контролом. */
  hint?: string;
  /** Строка ошибки: текст или готовый узел (`fieldError`). */
  error?: string | HTMLElement;
  /**
   * Кнопка очистки: контрол оборачивается {@link wrapClearable} с этим
   * обработчиком (значение → пусто).
   */
  clear?: () => void;
  /** Дополнительные классы строки. */
  class?: string;
}

/**
 * Строка поля: подпись + контрол (+ кнопка очистки) + подсказка + строка
 * ошибки. Заменяет `field()` из `lib/dialog.ts` и самодельные `div('field')`.
 */
export function fieldRow(o: FieldRowOptions): HTMLDivElement {
  const row = div(FIELD_CLASS);
  if (o.class !== undefined && o.class.trim() !== '') row.classList.add(...o.class.trim().split(/\s+/));
  if (o.label !== undefined && o.label !== '') {
    const label = el('label', FIELD_LABEL_CLASS, o.label);
    if (o.id !== undefined) label.htmlFor = o.id;
    row.append(label);
  }
  row.append(o.clear !== undefined ? wrapClearable(o.control, o.clear) : o.control);
  if (o.hint !== undefined && o.hint !== '') {
    row.append(span(o.hint, FIELD_HINT_CLASS));
  }
  if (o.error !== undefined) {
    row.append(typeof o.error === 'string' ? fieldError(o.error) : o.error);
  }
  return row;
}

/**
 * Оборачивает поле ввода кнопкой «✕» очистки значения (приёмка 0.8.1):
 * у любого поля ввода должен быть однозначный способ убрать значение
 * целиком. У пустого поля кнопка скрыта — очищать нечего (ошибка a8e9eef1);
 * видимость следит за событиями `input`/`change` и за самой очисткой.
 *
 * Перенесена из `editor/value-editor.ts` в фасад поля (требование e64083b5:
 * «clearable поглощается Field»); поля дат панели фильтра «Структур»
 * используют её напрямую.
 */
export function wrapClearable(input: HTMLElement, onClear: () => void): HTMLElement {
  const wrap = div(FIELD_CLEARABLE_CLASS);
  wrap.append(input);
  const btn = el('button', FIELD_CLEAR_BTN_CLASS, '✕');
  btn.type = 'button';
  btn.title = t('actions.reset');
  const sync = (): void => {
    const node = input as HTMLInputElement;
    btn.hidden = typeof node.value === 'string' && node.value === '';
  };
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    onClear();
    sync();
  });
  input.addEventListener('input', sync);
  input.addEventListener('change', sync);
  sync();
  wrap.append(btn);
  return wrap;
}

/**
 * Переключает вид «выключено» на строке поля (`.ui-field--disabled`): нужен
 * там, где контрол не получает атрибут `disabled` (например, поле зависит от
 * чужого чекбокса), а приглушить строку надо.
 */
export function setFieldDisabled(row: HTMLElement, disabled: boolean): void {
  row.classList.toggle(FIELD_DISABLED_CLASS, disabled);
}
