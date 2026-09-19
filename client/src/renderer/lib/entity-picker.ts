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
 *     множественный выбор, раскрытие иерархии типов, поиск, «Очистить» и
 *     дополнительные кнопки вызывающего;
 *   - {@link buildEntityCombo} — встроенное комбо-поле: одиночный выбор,
 *     облачко выбранного (чип с крестиком), выпадашка живого поиска.
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
import { button, clear, div, el, span } from './dom.js';
import { etn } from './etn.js';
import { svgIcon } from './icons.js';
import { wireSuggest, type SuggestSource } from './suggest-dropdown.js';
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
 *  свотч линии и обратное имя для поиска. */
export function linkTypeEntityOptions(types: readonly LinkType[]): EntityOption[] {
  return orderedTypeRows(types)
    .filter((row) => !row.type.is_root)
    .map((row) => {
      const line = resolveLinkTypeVisual(types, row.type.id);
      return {
        id: row.type.id,
        title: row.type.name_forward,
        searchText: row.type.name_reverse,
        parentId: row.type.parent_id,
        depth: row.depth - 1,
        hasChildren: row.hasChildren,
        selectable: true,
        cloud: { id: row.type.id, title: row.type.name_forward, icon: LINK_TYPE_CLOUD_ICON, icon_kind: 'emoji' },
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

/** Контекст, передаваемый дополнительным кнопкам модального чек-листа. */
export interface EntityPickerDialogCtx {
  /** Текущий набор выбранных id (мутабельный — кнопки меняют его). */
  checked: Set<string>;
  /** Перерисовывает список (для «Пометить все» и подобных кнопок). */
  rerender: () => void;
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
   * Синтетические варианты помимо каталога (например, строка «Структура»
   * фильтра типов связей на карте) — рисуются после каталога.
   */
  extraOptions?: readonly EntityOption[];
  /** Типы мыслей, сужающие живой поиск (только для `thoughts`). */
  searchTypeIds?: readonly string[];
  /** Разрешить пустой набор; иначе «Применить» неактивен при пустом. */
  allowEmpty?: boolean;
  /** Дополнительные кнопки футера (keep-open, например «Пометить все»). */
  extraButtons?: (ctx: EntityPickerDialogCtx) => DialogButton[];
  /**
   * Дополнительные маленькие кнопки, рисуемые строкой ПОД полем поиска
   * (режим типов; например, «Отметить все» / «Снять все»). Не закрывают
   * диалог — это обычные кнопки тела.
   */
  searchButtons?: (ctx: EntityPickerDialogCtx) => {
    label: string;
    title?: string;
    onClick: () => void;
  }[];
  /** Ширина диалога, px (по умолчанию 480). */
  width?: number;
  /** Подпись кнопки применения (по умолчанию «Применить»). */
  applyLabel?: string;
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
    opts.kind === 'thought-types'
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
              hits.map((hit) => ({ value: hit.id, label: `${hit.title} — ${hit.matched_on}` })),
            ),
      };
      const handle = wireSuggest(searchInput, {
        sources: [searchSource],
        onPick: (entry) => {
          const opt = { id: entry.value, title: entry.label };
          if (single) {
            finish([entry.value]);
            return;
          }
          checked.add(entry.value);
          // Облачко выбранной мысли: догружаем минимум данных по id.
          pickedThoughts.set(entry.value, { id: entry.value, title: entry.label.split(' — ')[0] ?? entry.value });
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
        clear(chipsBox);
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

    const byId = new Map(options.map((o) => [o.id, o]));

    /** Совпадение варианта с поиском (имя + обратное имя типа связи). */
    const matches = (opt: EntityOption): boolean => {
      if (opt.title.toLowerCase().includes(needle)) return true;
      return (opt.searchText ?? '').toLowerCase().includes(needle);
    };

    /** Id, видимые при поиске: совпадения вместе с цепочкой предков. */
    const visibleIds = (): Set<string> => {
      const ids = new Set<string>();
      if (needle === '') {
        for (const opt of options) {
          const parent = opt.parentId ?? null;
          if (parent === null || expanded.has(parent)) ids.add(opt.id);
        }
        return ids;
      }
      for (const opt of options) {
        if (!matches(opt)) continue;
        let cur: EntityOption | undefined = opt;
        while (cur !== undefined) {
          ids.add(cur.id);
          cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
        }
      }
      return ids;
    };

    const renderList = (): void => {
      clear(list);
      const ids = visibleIds();
      const shown = options.filter((opt) => ids.has(opt.id));
      if (shown.length === 0) {
        list.append(el('div', 'st-f-empty', 'Ничего не найдено'));
        return;
      }
      for (const opt of shown) {
        const line = el('label', 'st-f-check entity-pick-row');
        line.style.paddingLeft = `${Math.max(0, opt.depth ?? 0) * 14}px`;
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
    // Строка поиска + необязательные маленькие кнопки под ней (режим типов).
    const searchBar = div('st-f-searchbar');
    searchBar.append(searchInput);
    if (opts.searchButtons !== undefined && !single) {
      for (const item of opts.searchButtons(ctx)) {
        searchBar.append(button(item.label, item.onClick, 'btn small', item.title));
      }
    }
    body.append(searchBar, list);
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
          renderList();
          updateButtons();
        },
      });
    }
    if (opts.extraButtons !== undefined && !single) {
      for (const extra of opts.extraButtons(ctx)) buttons.push(extra);
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
      onMount: () => {
        renderList();
        updateButtons();
        searchInput.focus();
      },
    });
  });
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
  /** Подпись пустого значения (строка «пусто» в выпадашке). */
  emptyLabel?: string;
  placeholder?: string;
  /** Заблокированное поле (без поиска и очистки). */
  disabled?: boolean;
  /** Типы мыслей, сужающие живой поиск (только для `thoughts`). */
  searchTypeIds?: readonly string[];
  onChange: (id: string | null) => void;
}

/** Встроенное комбо пикера. */
export interface EntityCombo {
  root: HTMLElement;
  /** Текущее значение (`null` — пусто). */
  value(): string | null;
  /** Закрывает выпадашку и снимает слушатели. */
  dispose(): void;
}

/**
 * Собирает встроенное комбо-поле пикера: облачко выбранного (чип с
 * крестиком), строка живого поиска с общей выпадашкой и каретка ▾ для
 * полного списка. Одиночный выбор: выбранная строка (или «пусто»)
 * становится значением через `onChange`.
 */
export function buildEntityCombo(opts: EntityComboOptions): EntityCombo {
  let current = opts.value;
  /** Данные облачка текущего значения (для мыслей — из кандидата). */
  let currentCloud: ThoughtCloudInput | null = null;
  /** Полный список вариантов (для типов — каталог из store, перечитывается). */
  let allOptions: EntityOption[] = [];
  let byId = new Map<string, EntityOption>();

  /** Перечитывает каталог типов на каждое открытие списка (realtime может
   *  принести каталог позже создания поля). */
  const reloadOptions = (): void => {
    if (opts.kind === 'thought-types') {
      allOptions = thoughtTypeEntityOptions(store.state.thoughtTypes);
    } else if (opts.kind === 'link-types') {
      allOptions = linkTypeEntityOptions(store.state.linkTypes);
    } else {
      allOptions = [];
    }
    byId = new Map(allOptions.map((o) => [o.id, o]));
  };
  reloadOptions();

  const root = div('entity-combo');
  const valueHost = div('entity-combo-value');
  const input = el('input', 'text-input entity-combo-input') as HTMLInputElement;
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = opts.placeholder ?? '';
  input.disabled = opts.disabled === true;
  const caret = span('', 'type-combo-caret entity-combo-caret');
  caret.append(svgIcon('chevron-down', 12));
  root.append(valueHost, input, caret);

  /** Облачко выбранного значения или подпись пустого. */
  const renderValue = (): void => {
    clear(valueHost);
    if (current === null) {
      if (opts.emptyLabel !== undefined) valueHost.append(span(opts.emptyLabel, 'muted'));
      return;
    }
    const opt = byId.get(current);
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
    input.value = opt?.title ?? '';
    opts.onChange(id);
    renderValue();
  };

  /** Подпись строки варианта с индентом дерева типов. */
  const rowLabel = (opt: EntityOption): string =>
    `${'· '.repeat(Math.max(0, opt.depth ?? 0))}${opt.title}`;

  const sources: SuggestSource[] = [];
  if (opts.kind !== 'thoughts') {
    // Полный список каталога: на фокусе пустого поля и по кнопке ▾ (force
    // игнорирует `when`, так что ▾ открывает весь список при любом тексте).
    sources.push({
      when: 'empty',
      load: () => {
        if (opts.disabled === true) return [];
        reloadOptions();
        const rows = allOptions.filter((o) => o.selectable !== false).map((o) => ({ value: o.id, label: rowLabel(o) }));
        if (opts.emptyLabel !== undefined) rows.unshift({ value: '', label: opts.emptyLabel });
        return rows;
      },
    });
    // Живой поиск по имени (для типа связи — и по обратному имени).
    sources.push({
      when: 'typed',
      load: (query) => {
        if (opts.disabled === true) return [];
        reloadOptions();
        const q = query.trim().toLowerCase();
        return allOptions
          .filter((o) => o.selectable !== false)
          .filter((o) => o.title.toLowerCase().includes(q) || (o.searchText ?? '').toLowerCase().includes(q))
          .map((o) => ({ value: o.id, label: rowLabel(o) }));
      },
    });
  } else {
    // Мысли: живой поиск по серверу; полный список без запроса невозможен.
    sources.push({
      when: 'typed',
      load: (query) => {
        if (opts.disabled === true) return [];
        return etn.thoughts
          .findDuplicates(opts.networkId, query.trim(), [], (opts.searchTypeIds ?? []).filter((id) => id !== ''))
          .catch(() => [] as DuplicateHit[])
          .then((hits) => {
            allOptions = hits.map((hit) => {
              const opt = thoughtEntityOption(hit);
              byId.set(hit.id, opt);
              return opt;
            });
            return hits.map((hit) => ({ value: hit.id, label: hit.title }));
          });
      },
    });
  }

  // Фокус на поле с выбранным значением показывает весь каталог: подпись
  // выбранного очищается из строки поиска, по blur — возвращается обратно.
  // Регистрируется ДО `wireSuggest`: его focus-обработчик обновляет список по
  // тексту поля и должен увидеть уже очищенную строку.
  input.addEventListener('focus', () => {
    if (current !== null && opts.disabled !== true) input.value = '';
  });
  input.addEventListener('blur', () => {
    input.value = current !== null ? (byId.get(current)?.title ?? current) : '';
  });

  const handle = wireSuggest(input, {
    sources,
    onPick: (entry) => {
      if (entry.value === '') {
        setValue(null);
        return;
      }
      setValue(entry.value);
    },
  });

  // Каретка: открыть полный список, не забирая фокус из поля.
  caret.addEventListener('mousedown', (event) => event.preventDefault());
  caret.addEventListener('click', () => {
    if (opts.disabled !== true) handle.open();
  });

  renderValue();
  return {
    root,
    value: () => current,
    dispose: () => handle.dispose(),
  };
}
