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
import { emptyState } from './empty-state.js';
import { choiceRow } from './choice-row.js';
import { iconButton, uiButton } from './button.js';
import { svgIcon } from './icon.js';
import { openPopover } from './popover.js';

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
/** Класс режима-чеклиста: тело выпадающего списка (сетка чекбоксов). */
export const CHIP_LIST_CHECKLIST_CLASS = 'ui-chip-checklist';
/** Класс сетки чекбоксов режима-чеклиста (2 колонки по умолчанию). */
export const CHIP_LIST_CHECKLIST_GRID_CLASS = 'ui-chip-checklist-grid';
/** Класс нижней строки режима-чеклиста (кнопка «Выбрать все»). */
export const CHIP_LIST_CHECKLIST_FOOTER_CLASS = 'ui-chip-checklist-footer';
/** Класс кнопки-крестика очистки всего поля. */
export const CHIP_LIST_CLEAR_CLASS = 'ui-chip-list-clear';

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
  /** Подсказка пустого состояния — что сделать, чтобы добавить значение. */
  emptyHint?: string;
  /** Подсказка кнопки снятия чипа. */
  removeTitle?: string;
  /**
   * Режим поля добавления (по умолчанию `select` — выпадающий `<select>`):
   * `checklist` — кнопка, открывающая выпадающий список ЧЕКБОКСОВ в сетке
   * (ошибка 50d9bf4e п. C3). Выбор отмечает/снимает значение, список остаётся
   * открытым; «Выбрать все» отмечает все варианты и закрывает список.
   */
  addMode?: 'select' | 'checklist';
  /** Число колонок сетки чекбоксов в режиме `checklist` (по умолчанию 2). */
  checklistColumns?: number;
  /** Подпись кнопки-поля и заголовка списка в режиме `checklist`. */
  addLabel?: string;
  /** Подпись кнопки «Выбрать все» внизу списка (режим `checklist`). */
  selectAllLabel?: string;
  /** Подсказка кнопки-крестика очистки ВСЕГО поля; нет — кнопка не рисуется. */
  clearTitle?: string;
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
  const checklist = opts.addMode === 'checklist';
  const addSelect = el('select', `select-input ${CHIP_LIST_ADD_CLASS}`) as HTMLSelectElement;

  const render = (): void => {
    chipsBox.replaceChildren();
    const values = opts.getValues();
    if (values.length === 0) {
      if (opts.emptyText !== undefined) {
        const empty = emptyState({
          title: opts.emptyText,
          ...(opts.emptyHint !== undefined ? { hint: opts.emptyHint } : {}),
        });
        empty.classList.add(CHIP_LIST_EMPTY_CLASS);
        chipsBox.append(empty);
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

    if (checklist) return;
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

  if (checklist) {
    // Кнопка-поле открывает список чекбоксов; «Выбрать все» внизу списка.
    const addBtn = uiButton({
      label: opts.addLabel ?? opts.addPlaceholder ?? '',
      role: 'secondary',
      size: 's',
      class: `${CHIP_LIST_ADD_CLASS} ${CHIP_LIST_ADD_CLASS}--checklist`,
      onClick: () => openChecklist(),
    });
    const openChecklist = (): void => {
      const grid = div(CHIP_LIST_CHECKLIST_GRID_CLASS);
      grid.style.setProperty('grid-template-columns', `repeat(${opts.checklistColumns ?? 2}, minmax(0, 1fr))`);
      let popover: { close: () => void } | null = null;
      const rebuild = (): void => {
        grid.replaceChildren();
        const selected = new Set(opts.getValues());
        for (const option of opts.getOptions()) {
          const row = choiceRow({
            kind: 'checkbox',
            label: option.label,
            checked: selected.has(option.value),
            value: option.value,
            onChange: (checked) => {
              if (checked) opts.onAdd(option.value);
              else opts.onRemove(option.value);
              render();
              rebuild();
            },
          });
          grid.append(row.row);
        }
      };
      rebuild();
      const footer = div(CHIP_LIST_CHECKLIST_FOOTER_CLASS);
      if (opts.selectAllLabel !== undefined) {
        footer.append(
          uiButton({
            label: opts.selectAllLabel,
            role: 'secondary',
            size: 's',
            class: `${CHIP_LIST_CHECKLIST_CLASS}-all`,
            onClick: () => {
              const selected = new Set(opts.getValues());
              for (const option of opts.getOptions()) {
                if (!selected.has(option.value)) opts.onAdd(option.value);
              }
              render();
              popover?.close();
            },
          }),
        );
      }
      const panel = div(CHIP_LIST_CHECKLIST_CLASS);
      panel.append(grid, footer);
      popover = openPopover({
        anchor: { element: addBtn },
        content: { title: opts.addLabel ?? opts.addPlaceholder ?? '', body: panel, maxHeightPx: 320 },
        extraClass: 'ui-chip-checklist-popover',
      });
    };
    // Кнопка-поле и (необязательный) крестик очистки — в одной строке.
    const addRow = div(`${CHIP_LIST_CLASS}-add-row`);
    addRow.append(addBtn);
    if (opts.clearTitle !== undefined) {
      addRow.append(
        iconButton({
          icon: svgIcon('x'),
          title: opts.clearTitle,
          role: 'ghost',
          size: 's',
          class: CHIP_LIST_CLEAR_CLASS,
          onClick: () => {
            for (const value of [...opts.getValues()]) opts.onRemove(value);
            render();
          },
        }),
      );
    }
    root.append(chipsBox, addRow);
    return { root, refresh: render };
  }

  root.append(chipsBox, addSelect);
  return { root, refresh: render };
}
