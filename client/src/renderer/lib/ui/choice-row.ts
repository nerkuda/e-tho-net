/**
 * Строка-переключатель (флажок / радиокнопка) — единый фасад `lib/ui`
 * (задача f351b894, требование e64083b5 «Поля и переключатели — фасады lib/ui
 * над Web Awesome», ADR 03eb2c61, инвентаризация 3fc7c54d — раздел
 * «CheckboxRow / RadioRow»).
 *
 * Один фасад на оба вида: `kind` выбирает флажок (`checkbox`) или радиокнопку
 * (`radio`). Подпись входит в `<label>`, поэтому клик по тексту переключает
 * контрол; контрол возвращается наружу, чтобы потребитель читал `.checked` и
 * вешал `change`.
 *
 * Почему своя разметка, а не `wa-checkbox`/`wa-radio`: та же причина, что у
 * `./field.ts` и `./tabs.ts` — тестируемость на общем DOM-шиме (custom elements
 * вендора в нём не исполняются) и совместимость с массовым кодом, читающим
 * `.checked`. Вид задают токены (`./choice-row.css`).
 *
 * Самодельные `el('label', 'checkbox-row')` / `el('label', 'radio-row')`
 * запрещены — сторож `guard-ui-fields.test.ts`.
 */

import { div, el, span } from '../dom.js';

/** Класс строки-переключателя (заменяет `checkbox-row` и `radio-row`). */
export const CHOICE_ROW_CLASS = 'ui-choice-row';

/** Класс контейнера группы строк (заменяет `radio-group`). */
export const CHOICE_GROUP_CLASS = 'ui-choice-group';

/** Класс метки-текста строки. */
export const CHOICE_ROW_LABEL_CLASS = 'ui-choice-row-label';

/** Вид переключателя. */
export type ChoiceKind = 'checkbox' | 'radio';

/** Опции строки-переключателя. */
export interface ChoiceRowOptions {
  /** Вид: `checkbox` или `radio`. */
  kind: ChoiceKind;
  /** Видимая подпись (кликабельна вместе с контролом). */
  label: string;
  checked?: boolean;
  /** Имя группы (обязательно для `radio`, чтобы они были взаимоисключающими). */
  name?: string;
  value?: string;
  disabled?: boolean;
  id?: string;
  /** Дополнительные классы-модификаторы строки. */
  extraClass?: string;
  onChange?: (checked: boolean, event: Event) => void;
}

/** Построенная строка: `<label>` + вложенный `<input>`. */
export interface ChoiceRowHandle {
  /** Обёртка-`<label>` (уходит в разметку). */
  row: HTMLLabelElement;
  /** Контрол: чтение `.checked`, подписка на `change`. */
  input: HTMLInputElement;
}

/** Опции голого контрола-переключателя. */
export interface ChoiceControlOptions {
  checked?: boolean;
  name?: string;
  value?: string;
  disabled?: boolean;
  id?: string;
  onChange?: (checked: boolean, event: Event) => void;
}

/**
 * Голый контрол-переключатель без подписи — для случаев, когда подпись или
 * строку строит владелец (булев редактор значения, флажок в ячейке таблицы).
 * Строку с подписью строит {@link choiceRow}.
 */
export function choiceControl(kind: ChoiceKind, o: ChoiceControlOptions = {}): HTMLInputElement {
  const input = el('input') as HTMLInputElement;
  input.type = kind;
  if (o.id !== undefined) input.id = o.id;
  if (o.name !== undefined) input.name = o.name;
  if (o.value !== undefined) input.value = o.value;
  input.checked = o.checked === true;
  if (o.disabled === true) input.disabled = true;
  if (o.onChange !== undefined) {
    input.addEventListener('change', (event) => o.onChange!(input.checked, event));
  }
  return input;
}

/**
 * Строит строку-переключатель. `row` — обёртка-`<label>`, `input` — контрол;
 * обе части нужны потребителю (первую монтируют, второй читают).
 */
export function choiceRow(o: ChoiceRowOptions): ChoiceRowHandle {
  const row = el('label', CHOICE_ROW_CLASS);
  if (o.extraClass !== undefined && o.extraClass.trim() !== '') {
    row.classList.add(...o.extraClass.trim().split(/\s+/));
  }
  const input = choiceControl(o.kind, {
    id: o.id,
    name: o.name,
    value: o.value,
    checked: o.checked,
    disabled: o.disabled,
    onChange: o.onChange,
  });
  row.append(input, span(o.label, CHOICE_ROW_LABEL_CLASS));
  return { row, input };
}

/** Флажок-строка ({@link choiceRow} с `kind: 'checkbox'`). */
export function checkboxRow(o: Omit<ChoiceRowOptions, 'kind'>): ChoiceRowHandle {
  return choiceRow({ ...o, kind: 'checkbox' });
}

/** Радиокнопка-строка ({@link choiceRow} с `kind: 'radio'`). */
export function radioRow(o: Omit<ChoiceRowOptions, 'kind'>): ChoiceRowHandle {
  return choiceRow({ ...o, kind: 'radio' });
}

/**
 * Контейнер группы строк (флажков или радиокнопок) — `.ui-choice-group`.
 * Строки кладутся через `append` самим потребителем.
 */
export function choiceGroup(extraClass?: string): HTMLDivElement {
  const box = div(CHOICE_GROUP_CLASS);
  if (extraClass !== undefined && extraClass.trim() !== '') {
    box.classList.add(...extraClass.trim().split(/\s+/));
  }
  return box;
}
