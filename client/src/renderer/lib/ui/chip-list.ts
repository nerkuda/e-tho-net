/**
 * Чип-лист — единый фасад `lib/ui` (требование d1cd2095 «Единый выбор
 * сущности», инвентаризация 3fc7c54d — разделы «Chip/Badge» и «показательные
 * случаи самодеятельности», п. 3 «чип-лист пользователей»).
 *
 * Это generic-чип: набор выбранных ЗНАЧЕНИЙ (строк) пилюлями-чипами с
 * крестиком снятия и полем добавления значения из списка кандидатов.
 * Значение и подпись даёт владелец — компонент про облачка мысли ничего не
 * знает.
 *
 * Разделение с соседними общими механизмами:
 *   • чипы-ОБЛАЧКА сущностей (типы мыслей/связей, мысли, свойства-связи) —
 *     общий чип-лист пикера `lib/entity-picker.ts` (`buildEntityChipField`);
 *   • чипы ЗНАЧЕНИЙ свойств — редактор значения `editor/value-editor.ts`;
 *   • generic-чип (пользователи и прочие «простые» наборы строк) — здесь.
 * Собственная сборка чипов вне этих модулей запрещена сторожем
 * (`guard-ui-fields`, `guard-value-editor`).
 *
 * Строки-литералы в `lib/ui/*` запрещены (сторож `guard-ui-i18n`): все тексты
 * приходят параметрами от владельца.
 */

import { div, el, span } from '../dom.js';

/** Базовый класс корня чип-листа. */
export const CHIP_LIST_CLASS = 'ui-chip-list';
/** Класс одного чипа. */
export const CHIP_CLASS = 'ui-chip';
/** Класс кнопки снятия чипа. */
export const CHIP_REMOVE_CLASS = 'ui-chip-remove';
/** Класс поля добавления значения. */
export const CHIP_LIST_ADD_CLASS = 'ui-chip-list-add';
/** Класс подписи пустого состояния. */
export const CHIP_LIST_EMPTY_CLASS = 'ui-chip-list-empty';

/** Кандидат на добавление в чип-лист. */
export interface ChipListOption {
  value: string;
  label: string;
}

/** Параметры {@link chipList}. */
export interface ChipListOptions {
  /** Текущие значения (читаются при каждой отрисовке — владелец их хранит). */
  getValues: () => readonly string[];
  /** Подпись чипа по значению. */
  labelOf: (value: string) => string;
  /** Снятие чипа (крестик). После вызова список перерисовывается сам. */
  onRemove: (value: string) => void;
  /** Кандидаты поля добавления (уже выбранные владелец может не отсеивать). */
  getOptions: () => readonly ChipListOption[];
  /** Добавление значения из поля. После вызова список перерисовывается сам. */
  onAdd: (value: string) => void;
  /** Первый (пустой) пункт поля добавления; нет — пункт не рисуется. */
  addPlaceholder?: string;
  /** Текст пустого состояния (нет ни одного значения). */
  emptyText?: string;
  /** Подсказка кнопки снятия чипа. */
  removeTitle?: string;
}

/** Собранный чип-лист. */
export interface ChipListHandle {
  root: HTMLElement;
  /** Перерисовывает чипы и пункты поля добавления (владелец обновил данные). */
  refresh(): void;
}

/**
 * Строит чип-лист: чипы выбранных значений с крестиком снятия и поле
 * добавления (`<select>`) из ещё не выбранных кандидатов. Владелец даёт данные
 * и получает изменения; компонент владеет только разметкой и перерисовкой.
 */
export function chipList(opts: ChipListOptions): ChipListHandle {
  const root = div(CHIP_LIST_CLASS);
  const chipsBox = div(`${CHIP_LIST_CLASS}-chips`);
  const addSelect = el('select', `select-input ${CHIP_LIST_ADD_CLASS}`) as HTMLSelectElement;

  const render = (): void => {
    chipsBox.replaceChildren();
    const values = opts.getValues();
    if (values.length === 0) {
      if (opts.emptyText !== undefined) {
        chipsBox.append(span(opts.emptyText, CHIP_LIST_EMPTY_CLASS));
      }
    } else {
      for (const value of values) {
        const chip = span('', CHIP_CLASS);
        chip.append(span(opts.labelOf(value), `${CHIP_CLASS}-label`));
        const remove = el('button', CHIP_REMOVE_CLASS, '×') as HTMLButtonElement;
        remove.type = 'button';
        if (opts.removeTitle !== undefined) remove.title = opts.removeTitle;
        remove.addEventListener('click', () => {
          opts.onRemove(value);
          render();
        });
        chip.append(remove);
        chipsBox.append(chip);
      }
    }

    addSelect.replaceChildren();
    if (opts.addPlaceholder !== undefined) {
      const placeholder = el('option', undefined, opts.addPlaceholder);
      placeholder.value = '';
      addSelect.append(placeholder);
    }
    const selected = new Set(values);
    for (const option of opts.getOptions()) {
      if (selected.has(option.value)) continue;
      const node = el('option', undefined, option.label);
      node.value = option.value;
      addSelect.append(node);
    }
    addSelect.value = '';
  };

  addSelect.addEventListener('change', () => {
    const value = addSelect.value;
    if (value === '') return;
    if (opts.getValues().includes(value)) return;
    opts.onAdd(value);
    render();
  });

  render();
  root.append(chipsBox, addSelect);
  return { root, refresh: render };
}
