/**
 * Общий пикер сущностей — единственная точка выбора типа мысли, типа связи
 * и мысли (ADR «выбор сущности — один пикер на типы мыслей, типы связей и
 * мысли», стандарт S3, задача a1f5141b, веха 3 версии 0.8.2; элемент
 * интерфейса «Пикер сущностей: типы мыслей, типы связей, мысли»).
 *
 * Три источника — параметр пикера, а не повод писать три компонента:
 *
 * | Источник        | Данные                                            |
 * |-----------------|---------------------------------------------------|
 * | `thought-types` | каталог типов мыслей (иерархия через type-tree)   |
 * | `link-types`    | каталог типов связей (иерархия, свотч линии)      |
 * | `thoughts`      | мысли — живой поиск по серверу (`findDuplicates`) |
 *
 * Варианты рисуются облачками общей фабрики (`lib/thought-cloud.ts`): тип
 * мысли передаётся облачку как `type_id` — фабрика сама резолвит значок,
 * цвета и начертание по цепочке типов (L21); тип связи — облачко с глифом
 * ссылки и свотчем линии; мысль — её собственный визуал. Живой поиск —
 * общей выпадашкой `wireSuggest` (источник кандидатов — её параметр, ADR
 * «одна выпадашка-подсказчик»). Иерархия типов строится функциями
 * `lib/type-tree.ts` (`orderedTypeRows`), а не в экране.
 *
 * Два режима показа одного пикера:
 *   - {@link pickEntitiesModal} — модальный чек-лист: одиночный или
 *     множественный выбор, раскрытие иерархии типов, поиск и команды-иконки
 *     («Очистить» + команды вызывающего) в ОДНОЙ строке с поиском;
 *   - {@link buildEntityCombo} — встроенное поле ОДИНОЧНОГО выбора: пусто —
 *     строка живого поиска с кареткой; заполнено — облачко значения прямо в
 *     поле, ввод недоступен, крестик очищает, кнопка «…» открывает диалог
 *     выбора единственного значения (ошибка ba2f57d3). Дерево типов с
 *     отступами и раскрытием (`expandAll`), свотч линии, быстрое создание
 *     типа (`onCreateNew`) — всё, ради чего существовал прежний
 *     `lib/type-combobox.ts` (поглощён и удалён, веха 3 версии 0.8.2).
 *
 * Зависимости — только `lib/*`, `state.ts` и типы `@etn/shared` /
 * `main/ipc/contract.js` (грабли «Цикл импортов canvas.ts ↔ editor-модулей»:
 * модуль может подключаться из canvas.ts, поэтому `editor/*` импортировать
 * нельзя).
 */

import type { DuplicateHit } from '../../main/ipc/contract.js';
import type { LinkStyle, LinkType, ThoughtType } from '@etn/shared';

import { store } from '../state.js';
import { showDialog, type DialogButton } from './dialog.js';
import { button, div, el, span } from './dom.js';
import { etn } from './etn.js';
import { svgIcon, type IconName } from './icons.js';
import {
  wireSuggest,
  type SuggestEntry,
  type SuggestHandle,
  type SuggestSource,
} from './suggest-dropdown.js';
import { createThoughtCloud, type ThoughtCloudInput } from './thought-cloud.js';
import { orderedTypeRows, resolveLinkTypeVisual } from './type-tree.js';

// ---------------------------------------------------------------------------
// Опции пикера
// ---------------------------------------------------------------------------

/** Какую сущность выбирает пикер. */
export type EntityKind = 'thought-types' | 'link-types' | 'thoughts';

/** Одна выбираемая сущность. */
export interface EntityOption {
  /** Идентификатор сущности. */
  id: string;
  /** Имя — подпись облачка и строки. */
  title: string;
  /** Дополнительный текст живого поиска (обратное имя типа связи). */
  searchText?: string;
  /** Иерархия типов: родитель; `null`/нет — верхний уровень списка. */
  parentId?: string | null;
  /** Глубина в дереве типов (верхний уровень = 0). */
  depth?: number;
  /** У варианта есть потомки — показывается тоггл раскрытия. */
  hasChildren?: boolean;
  /** `false` — вариант показывается, но не выбирается (корень иерархии). */
  selectable?: boolean;
  /** Данные облачка фабрики (значок, цвета, начертание). */
  cloud: ThoughtCloudInput;
  /** Свотч линии для типа связи. */
  line?: { color: string | null; style: LinkStyle | null; width: number | null } | null;
}

/** Глиф облачка типа связи (тип связи не имеет иконки в модели данных). */
const LINK_TYPE_CLOUD_ICON = '🔗';

/**
 * Варианты каталога типов мыслей: дерево без корня иерархии («основной тип»
 * не выбирается), глубины сдвинуты к левому краю. Облачко — с `type_id`
 * самого типа: фабрика резолвит значок/цвета/начертание по цепочке типов.
 */
export function thoughtTypeEntityOptions(types: readonly ThoughtType[]): EntityOption[] {
  return orderedTypeRows(types)
    .filter((row) => !row.type.is_root)
    .map((row) => ({
      id: row.type.id,
      title: row.type.name,
      parentId: row.type.parent_id,
      depth: row.depth - 1,
      hasChildren: row.hasChildren,
      selectable: true,
      cloud: { id: row.type.id, title: row.type.name, type_id: row.type.id },
    }));
}

/** Варианты каталога типов связей: как {@link thoughtTypeEntityOptions}, плюс
 *  свотч линии и обратное имя в подписи («прямое / обратное»). */
export function linkTypeEntityOptions(types: readonly LinkType[]): EntityOption[] {
  return orderedTypeRows(types)
    .filter((row) => !row.type.is_root)
    .map((row) => {
      const line = resolveLinkTypeVisual(types, row.type.id);
      const title = `${row.type.name_forward} / ${row.type.name_reverse}`;
      return {
        id: row.type.id,
        title,
        searchText: row.type.name_reverse,
        parentId: row.type.parent_id,
        depth: row.depth - 1,
        hasChildren: row.hasChildren,
        selectable: true,
        cloud: { id: row.type.id, title, icon: LINK_TYPE_CLOUD_ICON, icon_kind: 'emoji' },
        line,
      };
    });
}

/** Вариант мысли из кандидата дубль-поиска (`findDuplicates`).
 *  Облачко — сам DTO (структурно совместим с `ThoughtCloudInput`): визуал
 *  резолвит фабрика, поля здесь не читаются (S1). */
export function thoughtEntityOption(hit: DuplicateHit): EntityOption {
  return {
    id: hit.id,
    title: hit.title,
    selectable: true,
    cloud: { ...hit },
  };
}

// ---------------------------------------------------------------------------
// Чистые помощники списка (проверяются юнит-тестами)
// ---------------------------------------------------------------------------

/** Служебный id строки «Создать новый» — не совпадает ни с одним id (UUID). */
export const CREATE_ROW_ID = '\u0000create';

/**
 * Имя для строки «Создать новый „<имя>“», или `null`, когда строки быть не
 * должно: только для непустого запроса без совпадений (пустой запрос
 * показывает весь каталог, любое совпадение делает создание ненужным) и
 * только если вызывающий передал `onCreateNew`. Чистая — под юнит-тестами.
 */
export function createRowName(query: string, matchCount: number, enabled: boolean): string | null {
  if (!enabled || matchCount > 0) return null;
  const name = query.trim();
  return name === '' ? null : name;
}

/**
 * Шагов отступа строки каталога типов по её глубине. `depth` вариантов
 * начинается с 1 у верхнего уровня списка (корень иерархии из `options`
 * исключён, поэтому первыми идут его дети). Единая формула для модального
 * чек-листа и встроенного комбо — строки каталога выглядят одинаково.
 */
export function typeRowIndentSteps(depth: number | undefined): number {
  return Math.max(0, (depth ?? 1) - 1);
}

/**
 * Id вариантов, видимых при поиске. Пустой запрос — весь каталог с учётом
 * раскрытия: вариант виден, если у него нет родителя, родителя нет среди
 * вариантов (корень иерархии исключён из списка — сервер проставляет его
 * `parent_id` типов верхнего уровня, но сам корень в `options` не попадает)
 * или родитель раскрыт. Непустой — совпадения вместе с цепочкой предков.
 * Чистая — единственный источник правила «пустой поиск показывает всё»
 * и для модального чек-листа, и для встроенного комбо.
 */
export function visibleEntityIds(
  options: readonly EntityOption[],
  needle: string,
  expanded: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(options.map((o) => [o.id, o]));
  const ids = new Set<string>();
  if (needle === '') {
    for (const opt of options) {
      const parent = opt.parentId ?? null;
      if (parent === null || !byId.has(parent) || expanded.has(parent)) ids.add(opt.id);
    }
    return ids;
  }
  const matches = (opt: EntityOption): boolean =>
    opt.title.toLowerCase().includes(needle) ||
    (opt.searchText ?? '').toLowerCase().includes(needle);
  for (const opt of options) {
    if (!matches(opt)) continue;
    let cur: EntityOption | undefined = opt;
    while (cur !== undefined) {
      ids.add(cur.id);
      cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Каталоги типов (с догрузкой, если realtime ещё не принёс их)
// ---------------------------------------------------------------------------

async function thoughtTypesOf(networkId: string): Promise<ThoughtType[]> {
  if (store.state.thoughtTypes.length > 0) return store.state.thoughtTypes;
  try {
    return await etn.types.listThoughtTypes(networkId);
  } catch {
    return [];
  }
}

async function linkTypesOf(networkId: string): Promise<LinkType[]> {
  if (store.state.linkTypes.length > 0) return store.state.linkTypes;
  try {
    return await etn.types.listLinkTypes(networkId);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Модальный чек-лист
// ---------------------------------------------------------------------------

/** Контекст, передаваемый командам модального чек-листа. */
export interface EntityPickerDialogCtx {
  /** Текущий набор выбранных id (мутабельный — команды меняют его). */
  checked: Set<string>;
  /** Перерисовывает список (для «Пометить все» и подобных команд). */
  rerender: () => void;
}

/**
 * Команда-иконка верхней строки модального чек-листа (ошибка bd8b78a0):
 * текстовых надписей нет — единая иконка проекта плюс полное название
 * команды в тултипе (`title`) и в `aria-label` (доступность с клавиатуры).
 */
export interface EntityPickerCommand {
  /** Имя иконки из единого набора проекта (`lib/icons.ts`). */
  icon: IconName;
  /** Полное название команды — тултип и доступная подпись кнопки. */
  title: string;
  /** Действие; набор `ctx.checked` обычно мутирует, затем `ctx.rerender()`. */
  onClick: () => void;
}

/** Параметры модального чек-листа {@link pickEntitiesModal}. */
export interface EntityPickerModalOptions {
  networkId: string;
  kind: EntityKind;
  /** Заголовок диалога. */
  title: string;
  /** Начальный набор выбранных id (множественный режим). */
  currentIds?: readonly string[];
  /**
   * Одиночный выбор: клик по варианту сразу закрывает диалог и возвращает
   * `[id]` (мысли — выбор из выпадашки живого поиска). Футер — только
   * «Отмена».
   */
  single?: boolean;
  /**
   * Каталог вариантов, ЗАМЕНЯЮЩИЙ чтение из store (родительский пикер типа
   * отдаёт отфильтрованный список: без себя и потомков, с учётом предела
   * глубины). Не задан — каталог строится по `kind` из store.
   */
  catalogue?: readonly EntityOption[];
  /**
   * Синтетические варианты помимо каталога (например, строка «Структура»
   * фильтра типов связей на карте) — рисуются после каталога.
   */
  extraOptions?: readonly EntityOption[];
  /** Типы мыслей, сужающие живой поиск (только для `thoughts`). */
  searchTypeIds?: readonly string[];
  /** Разрешить пустой набор; иначе «Применить» неактивен при пустом. */
  allowEmpty?: boolean;
  /**
   * Команды-иконки верхней строки (режим типов), справа от строки поиска.
   * Общую «Очистить» (ластик) пикер добавляет сам — вызывающему остаются
   * «Пометить все» / «Вернуть умолчания» и подобные. Диалог не закрывают.
   * Длинный ряд текстовых команд в футере вылезал за границы диалога
   * (ошибка bd8b78a0), поэтому все команды живут в верхней строке.
   */
  commands?: (ctx: EntityPickerDialogCtx) => EntityPickerCommand[];
  /** Ширина диалога, px (по умолчанию 480). */
  width?: number;
  /** Подпись кнопки применения (по умолчанию «Применить»). */
  applyLabel?: string;
}

/**
 * Кнопка-иконка команды верхней строки пикера: единый набор иконок проекта,
 * тултип и `aria-label` (клавиатурная доступность — нативный `<button>`).
 * Класс `.icon-btn` сужен до строки поиска правилом `.st-f-searchbar .icon-btn`.
 */
function commandButton(icon: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const btn = el('button', 'icon-btn') as HTMLButtonElement;
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.append(svgIcon(icon, 14));
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Открывает модальный чек-лист пикера. Возвращает новый набор id или `null`
 * при отмене. Для типов список — дерево с тогглами раскрытия, поиск сужает
 * его (совпадения показываются вместе с цепочкой предков); для мыслей —
 * чипы выбранного и выпадашка живого поиска.
 */
export async function pickEntitiesModal(
  opts: EntityPickerModalOptions,
): Promise<string[] | null> {
  const single = opts.single === true;
  const allowEmpty = opts.allowEmpty !== false;
  const catalogue: EntityOption[] =
    opts.catalogue !== undefined
      ? [...opts.catalogue]
      : opts.kind === 'thought-types'
        ? thoughtTypeEntityOptions(await thoughtTypesOf(opts.networkId))
        : opts.kind === 'link-types'
          ? linkTypeEntityOptions(await linkTypesOf(opts.networkId))
          : [];
  const options = [...catalogue, ...(opts.extraOptions ?? [])];

  return new Promise((resolve) => {
    const checked = new Set<string>(opts.currentIds ?? []);
    /** Собранные данные облачков выбранных мыслей (для kind === 'thoughts'). */
    const pickedThoughts = new Map<string, ThoughtCloudInput>();
    let needle = '';
    let settled = false;
    const finish = (value: string[] | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const isSelected = (id: string): boolean => checked.has(id);

    // Раскрытие иерархии: по умолчанию всё раскрыто (прежний чек-лист
    // показывал всё дерево), тоггл сворачивает ветку.
    const expanded = new Set<string>(options.filter((o) => o.hasChildren === true).map((o) => o.id));

    const body = div('st-f-picker');

    // --- Режим «мысли»: поиск с выпадашкой + чипы выбранного --------------
    if (opts.kind === 'thoughts') {
      const searchInput = el('input', 'st-f-input st-f-search') as HTMLInputElement;
      searchInput.type = 'text';
      searchInput.autocomplete = 'off';
      searchInput.placeholder = 'Найти мысль…';
      const chipsBox = div('entity-pick-chips');
      body.append(searchInput, chipsBox);

      const searchSource: SuggestSource = {
        when: 'typed',
        load: (query) =>
          etn.thoughts
            .findDuplicates(opts.networkId, query.trim(), [], (opts.searchTypeIds ?? []).filter((id) => id !== ''))
            .catch(() => [] as DuplicateHit[])
            .then((hits) =>
              // Строка-мысль — облачком: DTO кандидата структурно совместим с
              // `ThoughtCloudInput`, визуал резолвит фабрика (S1).
              hits.map((hit) => ({ value: hit.id, label: hit.title, thought: { ...hit } })),
            ),
      };
      const handle = wireSuggest(searchInput, {
        sources: [searchSource],
        onPick: (entry) => {
          if (single) {
            finish([entry.value]);
            return;
          }
          checked.add(entry.value);
          // Облачко выбранной мысли: данные из строки выпадашки, догрузка
          // полного DTO по id — если строка пришла без него.
          const title = entry.thought?.title ?? entry.label;
          pickedThoughts.set(entry.value, entry.thought ?? { id: entry.value, title });
          void etn.thoughts
            .resolve(opts.networkId, [entry.value])
            .then((refs) => {
              const ref = refs[0];
              if (ref !== undefined) {
                // DTO целиком в облачко фабрики (S1: поля не читаются точечно).
                pickedThoughts.set(entry.value, { ...ref });
              }
            })
            .catch(() => undefined)
            .finally(() => renderChips());
          searchInput.value = '';
          renderChips();
        },
      });

      const renderChips = (): void => {
        chipsBox.replaceChildren();
        if (checked.size === 0) {
          chipsBox.append(el('p', 'muted', 'Ничего не выбрано.'));
          return;
        }
        for (const id of checked) {
          const cloud = pickedThoughts.get(id) ?? { id, title: id };
          chipsBox.append(
            createThoughtCloud(cloud, {
              profile: 'chip',
              // Ширина — по чип-полю выбора: имя обрезается многоточием по
              // нему, а не раздувает диалог (принцип ширины облачка).
              width: 'container',
              actions: {
                onRemove: () => {
                  checked.delete(id);
                  renderChips();
                  updateButtons();
                },
              },
            }),
          );
        }
      };
      const renderSelected = (): void => {
        void etn.thoughts
          .resolve(opts.networkId, [...checked])
          .then((refs) => {
            for (const ref of refs) {
              pickedThoughts.set(ref.id, { ...ref });
            }
          })
          .catch(() => undefined)
          .finally(() => renderChips());
      };
      // Подгрузить облачка начального набора.
      renderSelected();

      let clearBtn: HTMLButtonElement | null = null;
      let applyBtn: HTMLButtonElement | null = null;
      const updateButtons = (): void => {
        if (clearBtn !== null) clearBtn.disabled = checked.size === 0;
        if (applyBtn !== null) applyBtn.disabled = !allowEmpty && checked.size === 0;
      };
      const buttons: DialogButton[] = [];
      if (!single) {
        buttons.push({
          label: 'Очистить',
          keepOpen: true,
          ref: (btn) => {
            clearBtn = btn;
            updateButtons();
          },
          onClick: () => {
            checked.clear();
            pickedThoughts.clear();
            renderChips();
            updateButtons();
          },
        });
      }
      buttons.push(
        { label: 'Отмена' },
        ...(single
          ? []
          : [
              {
                label: opts.applyLabel ?? 'Применить',
                primary: true,
                ref: (btn: HTMLButtonElement) => {
                  applyBtn = btn;
                  updateButtons();
                },
                onClick: () => finish([...checked]),
              },
            ]),
      );
      showDialog({
        title: opts.title,
        body,
        width: opts.width ?? 480,
        buttons,
        onMount: () => searchInput.focus(),
        onClose: () => handle.dispose(),
      });
      updateButtons();
      return;
    }

    // --- Режим типов: поиск + дерево-чек-лист ------------------------------
    const searchInput = el('input', 'st-f-input st-f-search') as HTMLInputElement;
    searchInput.type = 'text';
    searchInput.autocomplete = 'off';
    searchInput.placeholder = 'Найти…';
    const list = div('st-f-checks st-f-picker-list');

    /** Id, видимые при поиске (пустой запрос — весь каталог). */
    const visibleIds = (): Set<string> => visibleEntityIds(options, needle, expanded);

    const renderList = (): void => {
      list.replaceChildren();
      const ids = visibleIds();
      const shown = options.filter((opt) => ids.has(opt.id));
      if (shown.length === 0) {
        list.append(el('div', 'st-f-empty', 'Ничего не найдено'));
        return;
      }
      for (const opt of shown) {
        const line = el('label', 'st-f-check entity-pick-row');
        line.style.paddingLeft = `${8 + typeRowIndentSteps(opt.depth) * 16}px`;
        if (opt.hasChildren === true) {
          const toggle = span(expanded.has(opt.id) ? '▾' : '▸', 'type-combo-toggle');
          toggle.addEventListener('mousedown', (event) => event.preventDefault());
          toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            if (expanded.has(opt.id)) expanded.delete(opt.id);
            else expanded.add(opt.id);
            renderList();
          });
          line.append(toggle);
        } else {
          line.append(span('', 'type-combo-toggle type-combo-toggle-leaf'));
        }
        if (!single) {
          const check = el('input') as HTMLInputElement;
          check.type = 'checkbox';
          check.checked = checked.has(opt.id);
          check.addEventListener('change', () => {
            if (check.checked) checked.add(opt.id);
            else checked.delete(opt.id);
            updateButtons();
          });
          line.append(check);
        }
        if (opt.line != null) {
          const swatch = span('', 'type-combo-swatch');
          const dash = opt.line.style === 'dashed' ? 'dashed' : opt.line.style === 'dotted' ? 'dotted' : 'solid';
          swatch.style.borderTop = `${Math.max(1, Math.min(6, opt.line.width ?? 1))}px ${dash} ${opt.line.color ?? '#9aa3b2'}`;
          line.append(swatch);
        }
        line.append(
          createThoughtCloud(opt.cloud, {
            profile: 'chip',
            // Ширина — по строке списка выбора.
            width: 'container',
          }),
        );
        if (single) {
          line.addEventListener('click', () => finish([opt.id]));
        }
        list.append(line);
      }
    };

    searchInput.addEventListener('input', () => {
      needle = searchInput.value.trim().toLowerCase();
      renderList();
    });

    let clearBtn: HTMLButtonElement | null = null;
    let applyBtn: HTMLButtonElement | null = null;
    const updateButtons = (): void => {
      if (clearBtn !== null) clearBtn.disabled = checked.size === 0;
      if (applyBtn !== null) applyBtn.disabled = !allowEmpty && checked.size === 0;
    };
    const ctx: EntityPickerDialogCtx = {
      checked,
      rerender: () => {
        renderList();
        updateButtons();
      },
    };
    // Верхняя строка: поиск + команды-иконки — общая «Очистить» (ластик) и
    // команды вызывающего. В футере команд нет: их длинный ряд текстовых
    // кнопок вылезал за границы диалога (ошибка bd8b78a0).
    const searchBar = div('st-f-searchbar');
    searchBar.append(searchInput);
    if (!single) {
      clearBtn = commandButton('eraser', 'Очистить', () => {
        checked.clear();
        renderList();
        updateButtons();
      });
      searchBar.append(clearBtn);
      if (opts.commands !== undefined) {
        for (const cmd of opts.commands(ctx)) {
          searchBar.append(commandButton(cmd.icon, cmd.title, cmd.onClick));
        }
      }
    }
    body.append(searchBar, list);
    const buttons: DialogButton[] = [
      { label: 'Отмена' },
      ...(single
        ? []
        : [
            {
              label: opts.applyLabel ?? 'Применить',
              primary: true,
              ref: (btn: HTMLButtonElement) => {
                applyBtn = btn;
                updateButtons();
              },
              onClick: () => finish([...checked]),
            },
          ]),
    ];

    showDialog({
      title: opts.title,
      body,
      width: opts.width ?? 480,
      buttons,
      onMount: () => {
        renderList();
        updateButtons();
        searchInput.focus();
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Множественный выбор сущностей чипами (общий чип-лист критериев)
// ---------------------------------------------------------------------------

/** Параметры {@link buildEntityChipField}. */
export interface EntityChipFieldOptions {
  /** Текущие значения (id сущностей или `$`-токены) — читаются при отрисовке. */
  getValues: () => string[];
  /** Запись нового набора значений. */
  onChange: (values: string[]) => void;
  /**
   * Кандидаты для живого поиска (и для облачков уже выбранных значений).
   * Пустой запрос — весь каталог (типы) либо пусто (мысли).
   */
  loadOptions: (query: string) => EntityOption[] | Promise<EntityOption[]>;
  /** Когда источник кандидатов участвует в списке (по умолчанию `always`). */
  optionsWhen?: 'always' | 'typed';
  /** Заголовок группы кандидатов. */
  optionsHeader?: string;
  /** Источники подсказок вызывающего (токены) — общий список выпадашки. */
  extraSources?: readonly SuggestSource[];
  /** Данные облачка значения; `null` — сырой текст (нет данных). */
  cloudOf?: (value: string) => ThoughtCloudInput | null;
  placeholder?: string;
  /**
   * Модальный пикер поверх нетокенных значений: получает управляемое
   * подмножество, возвращает его замену (`null` — отмена); чипы-токены
   * сохраняются.
   */
  picker?: { label: string; open(managed: readonly string[]): Promise<string[] | null> };
  /** Начальное состояние «поле недоступно» (поле ввода и кнопка пикера). */
  disabled?: boolean;
}

/** Собранный чип-лист сущностей. */
export interface EntityChipField {
  root: HTMLElement;
  /** Перерисовывает чипы (вызывающий догрузил облачка). */
  refresh(): void;
  /** Включает/выключает поле: поле ввода, кнопка пикера, снятие чипов. */
  setDisabled(value: boolean): void;
}

/** Строка выпадашки по варианту сущности: облачко, отступ дерева, свотч линии. */
function entityEntry(opt: EntityOption): SuggestEntry {
  const entry: SuggestEntry = { value: opt.id, label: opt.title, thought: opt.cloud };
  if (opt.depth !== undefined) entry.indent = typeRowIndentSteps(opt.depth);
  if (opt.line != null) entry.swatch = opt.line;
  return entry;
}

/**
 * Чип-лист множественного выбора сущностей: выбранные значения — мини-облачка
 * общей фабрики (значок, цвета, бледность неактуальной, метка корзины;
 * инструкция «Использовать унифицированные поля выбора ссылок в диалогах»),
 * поле ввода — живой поиск общей выпадашкой, необязательная кнопка модального
 * пикера. Свободный текст и токены (строки `$…`) добавляются как значения —
 * так поля критериев («Родительские мысли», «Типы мыслей», «Типы связей»,
 * автор/редактор) сохраняют смешение литералов и токенов. Отдельная сборка
 * чипов вне общих модулей запрещена сторожем `guard-value-editor`.
 */
export function buildEntityChipField(opts: EntityChipFieldOptions): EntityChipField {
  const root = div('entity-chip-field st-f-fieldrow');
  const field = div('st-f-chipfield entity-chip-field-inner');
  const input = el('input', 'text-input entity-chip-input') as HTMLInputElement;
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = opts.placeholder ?? 'Добавить значение…';

  /** Каталог, накопленный источником: по нему рисуются облачка значений. */
  const byId = new Map<string, EntityOption>();

  /** Заблокировано ли поле (выключатель зоны настроек поиска, задача a3247f84). */
  let disabled = opts.disabled === true;
  /** Кнопка модального пикера — создаётся ниже, если пикер задан. */
  let pickBtn: HTMLButtonElement | null = null;

  const commit = (raw: string): void => {
    const value = raw.trim();
    if (value === '' || disabled) return;
    input.value = '';
    if (opts.getValues().includes(value)) return;
    opts.onChange([...opts.getValues(), value]);
    renderChips();
  };

  const source: SuggestSource = {
    when: opts.optionsWhen ?? 'always',
    ...(opts.optionsHeader !== undefined ? { header: opts.optionsHeader } : {}),
    load: (query) =>
      Promise.resolve(opts.loadOptions(query)).then((options) => {
        for (const opt of options) byId.set(opt.id, opt);
        return options.map(entityEntry);
      }),
  };
  const sources: SuggestSource[] = [source, ...(opts.extraSources ?? [])];
  wireSuggest(input, {
    sources,
    // Свободный текст фиксирует обработчик `keydown` ниже; Enter над
    // выделенной строкой выбирает её (общая выпадашка гасит событие).
    pickFirstOnEnter: false,
    onPick: (entry) => commit(entry.value),
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.defaultPrevented) {
      event.preventDefault();
      commit(input.value);
    }
  });
  field.addEventListener('click', (event) => {
    if (event.target === field) input.focus();
  });

  function renderChips(): void {
    const chips: HTMLElement[] = [];
    for (const value of opts.getValues()) {
      const cloud = opts.cloudOf?.(value) ?? byId.get(value)?.cloud ?? { id: value, title: value };
      chips.push(
        createThoughtCloud(cloud, {
          profile: 'chip',
          width: 'container',
          actions: disabled
            ? {}
            : {
                onRemove: () => {
                  opts.onChange(opts.getValues().filter((v) => v !== value));
                  renderChips();
                },
              },
        }),
      );
    }
    // Поле ввода сохраняется (слушатели выпадашки) — набор чипов заменяем.
    field.replaceChildren(...chips, input);
  }

  /** Приводит поле ввода, кнопку пикера и рамку к состоянию `disabled`. */
  function applyDisabled(): void {
    input.disabled = disabled;
    if (pickBtn !== null) pickBtn.disabled = disabled;
    root.classList.toggle('disabled', disabled);
  }

  field.append(input);
  renderChips();
  root.append(field);

  // Первичная загрузка каталога — облачка уже выбранных значений (типы,
  // пользователи) видны до первого фокуса в поле.
  if ((opts.optionsWhen ?? 'always') === 'always') {
    void Promise.resolve(source.load('')).then(() => renderChips());
  }

  if (opts.picker !== undefined) {
    const { picker } = opts;
    const managed = (): string[] => opts.getValues().filter((v) => !v.startsWith('$'));
    pickBtn = el('button', 'btn small entity-chip-pick', picker.label) as HTMLButtonElement;
    pickBtn.type = 'button';
    pickBtn.addEventListener('click', () => {
      if (disabled) return;
      void picker.open(managed()).then((next) => {
        if (next === null) return;
        const kept = opts.getValues().filter((v) => v.startsWith('$'));
        opts.onChange([...kept, ...next]);
        renderChips();
      });
    });
    root.append(pickBtn);
  }

  applyDisabled();

  return {
    root,
    refresh: renderChips,
    setDisabled: (value: boolean): void => {
      if (value === disabled) return;
      disabled = value;
      applyDisabled();
      // Снятие чипа возможно только у активного поля — перерисовываем.
      renderChips();
    },
  };
}

// ---------------------------------------------------------------------------
// Встроенное комбо
// ---------------------------------------------------------------------------

/** Параметры встроенного комбо {@link buildEntityCombo}. */
export interface EntityComboOptions {
  networkId: string;
  kind: EntityKind;
  /** Текущее значение (id сущности; `null` — пусто). */
  value: string | null;
  /**
   * Подпись пустой строки в выпадашке живого поиска: её выбор очищает
   * значение. В самом поле пустое значение показывает `placeholder`, а не
   * эту подпись (поле ввода пусто, пока значение не выбрано).
   */
  emptyLabel?: string;
  placeholder?: string;
  /** Заблокированное поле (без поиска, «…» и очистки). */
  disabled?: boolean;
  /** Типы мыслей, сужающие живой поиск (только для `thoughts`). */
  searchTypeIds?: readonly string[];
  /**
   * Заголовок диалога «…» (выбор единственного значения). По умолчанию —
   * «Выбрать тип мысли / тип связи / мысль».
   */
  pickerTitle?: string;
  /**
   * Режим `expandAll`: дерево типов раскрыто целиком (родительский пикер
   * редактора типа). По умолчанию раскрыт только верхний уровень.
   */
  expandAll?: boolean;
  /**
   * Свой каталог вариантов вместо чтения типа из store (родительский пикер
   * фильтрует кандидатов: без себя, потомков и с учётом предела глубины).
   * Тот же каталог отдаётся и диалогу «…», чтобы выбор в нём не предлагал
   * запрещённые варианты.
   */
  options?: () => EntityOption[];
  /**
   * Быстрое создание типа: непустой запрос без совпадений даёт строку
   * «Создать новый „<запрос>“»; выбор строки вызывает хук — вызывающий
   * открывает диалог создания и резолвит id нового типа (или `null`, если
   * пользователь отказался: поле и список возвращаются к вводу).
   */
  onCreateNew?: (query: string) => Promise<string | null>;
  onChange: (id: string | null) => void;
}

/** Встроенное поле одиночного выбора сущности. */
export interface EntityCombo {
  root: HTMLElement;
  /** Текущее значение (`null` — пусто). */
  value(): string | null;
  /** Закрывает выпадашку и снимает слушатели. */
  dispose(): void;
}

/**
 * Родительский тип для поля выбора: служебный корень иерархии типов — это
 * «без родителя», а не вариант. Корень в каталог вариантов не попадает, и
 * комбо показал бы его сырой id чипом, поэтому значение корня нормализуется
 * в `null` (до плейсхолдера «без родителя»). Сброс в `null` сервер трактует
 * так же — как подвешивание прямо под корень.
 */
export function normalizeParentTypeId(
  parentId: string | null,
  rootId: string | null | undefined,
): string | null {
  if (parentId === null || rootId === null || rootId === undefined) return parentId;
  return parentId === rootId ? null : parentId;
}

/** Заголовок диалога «…» по виду выбираемой сущности (см. {@link buildEntityCombo}). */
const PICKER_TITLES: Record<EntityKind, string> = {
  'thought-types': 'Выбрать тип мысли',
  'link-types': 'Выбрать тип связи',
  thoughts: 'Выбрать мысль',
};

/**
 * Собирает встроенное комбо-поле пикера — единый компонент поля ОДИНОЧНОГО
 * выбора сущности (тип мысли, тип связи, мысль).
 *
 * Два состояния поля (ошибка ba2f57d3):
 *   - значение пусто — обычное поле ввода с живым поиском (общая выпадашка) и
 *     кареткой ▾ для полного списка;
 *   - значение заполнено — облачко выбранного лежит прямо в поле, строка
 *     ввода и каретка скрыты (ввод недоступен до очистки), крестик на облачке
 *     очищает значение и возвращает ввод.
 * В поле всегда есть компактная кнопка «…» — диалог выбора единственного
 * значения (`pickEntitiesModal` в одиночном режиме), как кнопка «выбрать» у
 * поля значения свойства-связи.
 *
 * Режим типов — дерево с отступами и раскрытием (`expandAll` раскрывает всё);
 * строки — те же облачка, что в модальном чек-листе (значок, цвета и
 * начертание из цепочки типов), у типа связи — свотч линии и подпись
 * «прямое / обратное». Каталог отдаёт ЕДИНСТВЕННЫЙ источник общей выпадашки
 * (пустой запрос — весь каталог с учётом раскрытия, непустой — совпадения с
 * цепочкой предков), поэтому ручное открытие кареткой не рисует список
 * дважды.
 */
export function buildEntityCombo(opts: EntityComboOptions): EntityCombo {
  let current = opts.value;
  /** Данные облачка текущего значения (для мыслей — из кандидата). */
  let currentCloud: ThoughtCloudInput | null = null;
  /** Полный список вариантов (для типов — каталог из store, перечитывается). */
  let allOptions: EntityOption[] = [];
  let byId = new Map<string, EntityOption>();
  /** Раскрытие узлов дерева: явный выбор пользователя (иначе — дефолт). */
  const expanded = new Map<string, boolean>();

  /** Перечитывает каталог типов на каждое открытие списка (realtime может
   *  принести каталог позже создания поля). */
  const reloadOptions = (): void => {
    if (opts.options !== undefined) {
      allOptions = opts.options();
    } else if (opts.kind === 'thought-types') {
      allOptions = thoughtTypeEntityOptions(store.state.thoughtTypes);
    } else if (opts.kind === 'link-types') {
      allOptions = linkTypeEntityOptions(store.state.linkTypes);
    } else {
      allOptions = [];
    }
    byId = new Map(allOptions.map((o) => [o.id, o]));
  };
  reloadOptions();

  /** Эффективное раскрытие узла: явный выбор, иначе режим `expandAll`. */
  const isExpanded = (opt: EntityOption): boolean =>
    expanded.get(opt.id) ?? (opts.expandAll === true && opt.hasChildren === true);

  const root = div('entity-combo');
  // Поле — единая рамка (как у поля значения свойства-связи): облачко
  // выбранного лежит ВНУТРИ поля, а строка живого поиска показывается, только
  // пока значение пусто. Заполненное поле ввод не принимает — смена значения
  // идёт кнопкой «…» (диалог выбора единственного значения), очистка — «✕» на
  // облачке (ошибка ba2f57d3 «Неправильное поле ввода типа в редакторе мысли»).
  const field = div('st-f-chipfield entity-combo-field');
  const valueHost = div('entity-combo-value');
  const input = el('input', 'text-input entity-combo-input') as HTMLInputElement;
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = opts.placeholder ?? '';
  input.disabled = opts.disabled === true;
  const caret = span('', 'type-combo-caret entity-combo-caret');
  caret.append(svgIcon('chevron-down', 12));
  const pickBtn = button(
    '…',
    () => openPicker(),
    'entity-combo-pick',
    opts.pickerTitle ?? PICKER_TITLES[opts.kind],
  );
  pickBtn.type = 'button';
  field.append(valueHost, input, caret, pickBtn);
  root.append(field);

  /** Облачко выбранного значения (пусто — поле ввода без подписи). */
  const renderValue = (): void => {
    valueHost.replaceChildren();
    if (current === null) return;
    let opt = byId.get(current);
    // Каталог типов мог прийти позже создания поля (realtime). Заполненное
    // поле выпадашку не открывает, поэтому обновляем каталог здесь — иначе
    // значение рисовалось бы сырым id. Для мыслей каталог набирается живым
    // поиском, перечитывать нечего.
    if (opt === undefined && opts.kind !== 'thoughts') {
      reloadOptions();
      opt = byId.get(current);
    }
    // Мысль ищется на сервере по запросу и в каталог не попадает: облачко
    // начального значения догружаем резолвом (иначе чип показывал бы сырой id).
    if (currentCloud === null && opt === undefined && opts.kind === 'thoughts') {
      void etn.thoughts
        .resolve(opts.networkId, [current])
        .then((refs) => {
          const ref = refs[0];
          if (ref !== undefined && current === ref.id && currentCloud === null) {
            currentCloud = { ...ref };
            if (root.isConnected) renderValue();
          }
        })
        .catch(() => undefined);
    }
    const cloud = currentCloud ?? opt?.cloud ?? { id: current, title: current };
    valueHost.append(
      createThoughtCloud(cloud, {
        profile: 'chip',
        // Ширина — по полю значения диалога.
        width: 'container',
        actions:
          opts.disabled === true
            ? undefined
            : {
                onRemove: () => {
                  setValue(null);
                },
              },
      }),
    );
  };

  const setValue = (id: string | null): void => {
    if (opts.disabled === true) return;
    current = id;
    const opt = id !== null ? byId.get(id) : undefined;
    currentCloud = opt?.cloud ?? null;
    input.value = '';
    renderValue();
    renderMode();
    opts.onChange(id);
  };

  /**
   * Показ поля по состоянию значения: пусто — строка живого поиска с
   * кареткой; заполнено — только облачко значения и кнопка «…», ввод
   * недоступен до очистки (требование ошибки ba2f57d3).
   */
  const renderMode = (): void => {
    const filled = current !== null;
    root.classList.toggle('entity-combo-filled', filled);
    valueHost.classList.toggle('hidden', !filled);
    input.classList.toggle('hidden', filled);
    caret.classList.toggle('hidden', filled);
    pickBtn.disabled = opts.disabled === true;
  };

  /**
   * Кнопка «…»: диалог выбора ЕДИНСТВЕННОГО значения. Каталог диалога — тот
   * же, что у живого поиска (свой `options()` у родительского пикера), поэтому
   * запрещённые варианты в диалоге не предлагаются.
   */
  function openPicker(): void {
    if (opts.disabled === true) return;
    void pickEntitiesModal({
      networkId: opts.networkId,
      kind: opts.kind,
      title: opts.pickerTitle ?? PICKER_TITLES[opts.kind],
      single: true,
      ...(opts.searchTypeIds !== undefined ? { searchTypeIds: opts.searchTypeIds } : {}),
      ...(opts.options !== undefined ? { catalogue: opts.options() } : {}),
    }).then((ids) => {
      if (ids === null) return;
      setValue(ids[0] ?? null);
    });
  }

  /** Строка выпадашки по варианту каталога типов: облачко типа (значок,
   *  цвета, начертание), отступ дерева, свотч линии, тоггл раскрытия. */
  const typeEntry = (opt: EntityOption): SuggestEntry => {
    const entry: SuggestEntry = {
      value: opt.id,
      label: opt.title,
      thought: opt.cloud,
      indent: typeRowIndentSteps(opt.depth),
      swatch: opt.line ?? null,
    };
    if (opt.hasChildren === true) {
      entry.toggle = {
        expanded: isExpanded(opt),
        onToggle: () => expanded.set(opt.id, !isExpanded(opt)),
      };
    }
    return entry;
  };

  /** Последний запрос, пришедший в источник (для строки «Создать новый»). */
  let lastQuery = '';

  const sources: SuggestSource[] = [];
  if (opts.kind !== 'thoughts') {
    // Единственный источник на весь каталог: пустой запрос — весь список
    // (с учётом раскрытия), непустой — совпадения вместе с цепочкой предков.
    // Один источник — ручное открытие кареткой (force игнорирует `when`) не
    // рисует каталог дважды.
    sources.push({
      when: 'always',
      load: (query) => {
        if (opts.disabled === true) return [];
        reloadOptions();
        const q = query.trim().toLowerCase();
        const expandedIds = new Set(allOptions.filter(isExpanded).map((o) => o.id));
        const visible = visibleEntityIds(allOptions, q, expandedIds);
        const entries = allOptions
          .filter((o) => o.selectable !== false && visible.has(o.id))
          .map(typeEntry);
        const matchedCount =
          q === ''
            ? 0
            : allOptions.filter(
                (o) =>
                  o.title.toLowerCase().includes(q) ||
                  (o.searchText ?? '').toLowerCase().includes(q),
              ).length;
        if (
          opts.emptyLabel !== undefined &&
          (q === '' || opts.emptyLabel.toLowerCase().includes(q))
        ) {
          entries.unshift({ value: '', label: opts.emptyLabel, indent: 0 });
        }
        const createName = createRowName(query, matchedCount, opts.onCreateNew !== undefined);
        if (createName !== null) {
          entries.push({
            value: CREATE_ROW_ID,
            label: `Создать новый „${createName}“`,
            create: true,
            indent: 0,
          });
        }
        lastQuery = query;
        return entries;
      },
    });
  } else {
    // Мысли: живой поиск по серверу; полный список без запроса невозможен.
    // Строка-мысль — облачком фабрики: DTO кандидата идёт в `thought`, визуал
    // (значок, цвета, начертание, бледность, корзина) резолвит фабрика (S1).
    sources.push({
      when: 'typed',
      load: (query) => {
        if (opts.disabled === true) return [];
        return etn.thoughts
          .findDuplicates(opts.networkId, query.trim(), [], (opts.searchTypeIds ?? []).filter((id) => id !== ''))
          .catch(() => [] as DuplicateHit[])
          .then((hits) =>
            hits.map((hit) => {
              const opt = thoughtEntityOption(hit);
              byId.set(hit.id, opt);
              return { value: hit.id, label: hit.title, thought: opt.cloud };
            }),
          );
      },
    });
  }

  // Набранный текст сам по себе значение не меняет — только явный выбор из
  // выпадашки; по потере фокуса строка поиска очищается. Поле принимает ввод
  // лишь пока значение пусто (иначе строка ввода скрыта).
  input.addEventListener('blur', () => {
    input.value = '';
  });
  field.addEventListener('click', (event) => {
    if (event.target === field && current === null && opts.disabled !== true) input.focus();
  });

  let handle: SuggestHandle | null = null;

  /** Запускает «Создать новый тип» по строке выпадашки. */
  const runCreate = async (query: string): Promise<void> => {
    if (opts.onCreateNew === undefined) return;
    let id: string | null = null;
    try {
      id = await opts.onCreateNew(query.trim());
    } catch {
      id = null; // неудачное создание ведёт себя как отказ
    }
    if (id !== null) {
      setValue(id);
      return;
    }
    // Отказ: вернуть каретку в поле и снова открыть список с той же строкой.
    if (root.isConnected) {
      input.focus();
      handle?.open();
    }
  };

  handle = wireSuggest(input, {
    sources,
    onPick: (entry) => {
      if (entry.value === CREATE_ROW_ID) {
        void runCreate(lastQuery);
        return;
      }
      if (entry.value === '') {
        setValue(null);
        return;
      }
      setValue(entry.value);
    },
  });

  // Каретка: открыть полный список, не забирая фокус из поля. Подпись
  // выбранного (или набранный текст) очищается, чтобы источник отдал весь
  // каталог, а не срез по случайному запросу.
  caret.addEventListener('mousedown', (event) => event.preventDefault());
  caret.addEventListener('click', () => {
    if (opts.disabled === true) return;
    input.value = '';
    handle?.open();
  });

  renderValue();
  renderMode();
  return {
    root,
    value: () => current,
    dispose: () => handle?.dispose(),
  };
}
