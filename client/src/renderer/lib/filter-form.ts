/**
 * Общий каркас формы отбора (задача 3742dd59, версия 0.8.2).
 *
 * Рядом с единым конструктором условий (`lib/filter-builder.ts`) живёт его
 * «каркас» — те элементы формы, которые до этой задачи были написаны заново
 * в каждом месте: блок со сворачиванием и маркером изменённого, строка
 * условия по свойству, строка автора/редактора, диапазоны дат, ключевые
 * слова с областью поиска, выбор сортировки и направления, футер
 * «Применить/Очистить».
 *
 * Роль модуля (ADR «условия отбора строит один конструктор с одной моделью
 * состояния», стандарт S4 «Клиент: условия отбора — только через общий
 * конструктор»):
 *
 *   - **вид и поведение каждого элемента** — общие и живут только здесь;
 *   - **состав и расположение элементов** — параметры сборки: какие секции
 *     строит вызывающий, в каком порядке их ставит, какие подписи задаёт.
 *
 * Все секции работают с ЕДИНОЙ моделью состояния `FilterCriteriaState`
 * (`lib/filter-builder.ts`); собственных моделей у мест применения нет.
 *
 * Экраны, применяющие конструктор: панель «Структур»
 * (`screens/structures/filter-panel.ts`), диалог отбора типа мысли
 * (`screens/thought-type/filter-dialog.ts`), панель «Хроники»
 * (`screens/chronicle/filter-panel.ts`), «События»
 * (`screens/activity/activity.ts`) и настройки строки поиска карты
 * (`search/search.ts`).
 */

import type {
  NetworkProperty,
  PropertyValueType,
  SortOrder,
  StructureAuthorOp,
  StructurePropertyOp,
  StructureSort,
} from '@etn/shared';
import { t } from './i18n.js';

import { buildValueEditor } from '../editor/value-editor.js';
import { emptyState } from './ui/empty-state.js';
import { clear, div, el, setTooltip, span } from './dom.js';
import { buildEntityChipField, thoughtEntityOption, type EntityOption } from './entity-picker.js';
import { etn } from './etn.js';
import { defineKeyContext, pushKeyContext } from './keymap.js';
import { collapsibleSection } from './ui/collapsible.js';
import { DPD_DEFAULT_TIME, openDatePeriodDialog } from './date-period-dialog.js';
import {
  buildPeriodEditor,
  composeLocalBound,
  hasExplicitTime,
  parseLocalBound,
} from './period-editor.js';
import { todayLocal } from './dates.js';
import type { ThoughtCloudInput } from './thought-cloud.js';
import { registerThoughtDropField } from './thought-drop.js';
import {
  FILTER_ORDERS,
  FILTER_SORTS,
  OPS_BY_TYPE,
  authorFilterActive,
  buildAuthorConditionRow,
  datesActive,
  type AuthorRowEditors,
  type FilterCriteriaState,
  type PropertyConditionState,
  type TriState,
} from './filter-builder.js';
import type { SuggestEntry, SuggestSource } from './suggest-dropdown.js';
import { wireSuggest } from './suggest-dropdown.js';

/** Контекст, в котором строится форма: общий для всех секций. */
export interface FilterFormContext {
  networkId: string;
  /** Живая модель состояния — секции читают её при построении и в обработчиках. */
  getState: () => FilterCriteriaState;
  /** Реестр свойств сети: id → строка реестра. */
  registry: ReadonlyMap<string, NetworkProperty>;
  /** Сообщить хосту об изменении: персист состояния + обновление маркеров. */
  touch: () => void;
}

/**
 * Одна секция формы. `refresh()` перечитывает состояние (маркер изменённого,
 * свёрнутость); `isNonEmpty()` — заполнена ли группа.
 */
export interface FilterSection {
  id: string;
  box: HTMLElement;
  body: HTMLElement;
  head: HTMLElement;
  star: HTMLElement;
  isNonEmpty: () => boolean;
  refresh: () => void;
}

/** Параметры блока с заголовком и маркером изменённого. */
export interface FilterBlockOptions {
  /** Сворачиваемый блок (стрелка и клик по заголовку). */
  collapsible?: boolean;
  getCollapsed?: () => boolean;
  setCollapsed?: (value: boolean) => void;
  /** Заполнена ли группа — маркер `*`, подсветка заголовка. */
  isNonEmpty?: () => boolean;
  /**
   * Вид каретки сворачиваемой группы: текстовый треугольник (по умолчанию,
   * как у панелей отбора) либо шеврон `lib/ui` (публикация, где вложенные
   * уточнения должны отличаться от крупных групп рецепта).
   */
  caretKind?: 'chevron' | 'triangle';
}

/**
 * Блок формы: заголовок с маркером `*` и тело. Единственная реализация
 * блока на весь клиент — «Структуры», «Хроника», «События», диалог отбора
 * типа мысли и строка поиска строят свои группы этим конструктором.
 * Сворачивание блока — общий компонент `lib/ui/collapsible.ts` (задача
 * a57e7998): тело `st-f-body` готовится здесь, компонент показывает его и
 * вращает каретку-треугольник.
 */
export function buildFilterBlock(title: string, opts: FilterBlockOptions = {}): FilterSection {
  const body = div('st-f-body');
  const star = el('span', 'st-f-star', '');
  const isNonEmpty = opts.isNonEmpty ?? ((): boolean => false);
  const collapsible =
    opts.collapsible === true && opts.getCollapsed !== undefined && opts.setCollapsed !== undefined;

  const section = collapsibleSection({
    title,
    collapsible,
    caretKind: opts.caretKind ?? 'triangle',
    headerExtra: [star],
    body,
    getCollapsed: collapsible ? opts.getCollapsed : undefined,
    onToggle: collapsible ? (value) => opts.setCollapsed!(value) : undefined,
    classes: {
      root: 'st-f-block',
      header: collapsible ? 'st-f-title st-f-collapsible-title' : 'st-f-title',
      caret: 'st-f-caret',
      body: 'st-f-body',
    },
  });
  const head = section.header;

  const refresh = (): void => {
    const active = isNonEmpty();
    head.classList.toggle('st-f-title-active', active);
    star.textContent = active ? ' *' : '';
    if (collapsible) section.setCollapsed(opts.getCollapsed!());
  };
  refresh();
  return { id: title, box: section.root, body, head, star, isNonEmpty, refresh };
}

// ---------------------------------------------------------------------------
// Ключевые слова с областью поиска
// ---------------------------------------------------------------------------

export interface KeywordsSectionOptions {
  /** Заголовок группы (по умолчанию «Ключевые слова»). */
  title?: string;
  placeholder?: string;
  tooltip?: string;
  /** Показывать чекбоксы области поиска (наименование/синонимы/комментарий). */
  showScope?: boolean;
  /** Источник подсказок поля (история значений, токены отбора). */
  suggestSource?: SuggestSource;
  /**
   * Дополнительные источники подсказок рядом с основным (0.10.1, T7: строка
   * поиска «Дневника» показывает ещё и найденные записи для перехода).
   */
  extraSources?: readonly SuggestSource[];
  /**
   * Выбор строки дополнительного источника: `true` — вызывающий обработал
   * строку сам (переход к записи), и подстановка текста не делается.
   */
  onPickEntry?: (entry: SuggestEntry) => boolean;
  /**
   * Составное поле: подсказка фильтруется по слову у каретки, а выбор токена
   * заменяет только это слово (поле «Ключевые слова» диалога отбора типа).
   */
  composite?: boolean;
  /** Enter в поле (в «Структурах» — применить отбор). */
  onEnter?: () => void;
  /**
   * Каждое изменение текста поля (0.10.1, T7: строка поиска «Дневника» шлёт
   * отсюда debounce-применение отбора).
   */
  onInput?: (value: string) => void;
  /** Уход фокуса (в «Хронике» — запись значения в историю). */
  onBlur?: (value: string) => void;
}

/** Счётчик полей ключевых слов: у каждого свой контекст сочетаний (Enter). */
let keywordsContextSeq = 0;

/**
 * Группа «Ключевые слова»: поле ввода, крестик очистки и (опционально)
 * строка области поиска. Вид и поведение поля — общие; источник подсказок,
 * составное поведение и реакция на Enter — параметры сборки.
 */
export function buildKeywordsSection(ctx: FilterFormContext, opts: KeywordsSectionOptions = {}): FilterSection {
  const section = buildFilterBlock(opts.title ?? 'Ключевые слова', {
    isNonEmpty: () => ctx.getState().keywords.trim() !== '',
  });
  const wrap = div('st-f-kw-wrap');
  const input = el('input', 'st-f-input st-f-keywords') as HTMLInputElement;
  input.type = 'text';
  input.value = ctx.getState().keywords;
  input.placeholder = opts.placeholder ?? 'счет* -вод*';
  if (opts.tooltip !== undefined) setTooltip(input, opts.tooltip);
  input.addEventListener('input', () => {
    ctx.getState().keywords = input.value;
    ctx.touch();
    opts.onInput?.(input.value);
  });
  if (opts.suggestSource !== undefined || (opts.extraSources ?? []).length > 0) {
    const sources: SuggestSource[] = [];
    if (opts.suggestSource !== undefined) {
      // Составное поле: подсказка фильтруется по слову у каретки, а не по всему
      // значению; выбор токена затем заменяет только это слово.
      sources.push(
        opts.composite === true
          ? { ...opts.suggestSource, load: () => opts.suggestSource!.load(compositeQueryOf(input)) }
          : opts.suggestSource,
      );
    }
    for (const extra of opts.extraSources ?? []) sources.push(extra);
    wireSuggest(input, {
      sources,
      pickFirstOnEnter: false,
      onPick: (entry) => {
        // Строку-запись обрабатывает вызывающий (переход), текст не подставляем.
        if (opts.onPickEntry?.(entry) === true) return;
        if (opts.composite === true) {
          replaceTrailingWord(input, entry.value, (v) => {
            ctx.getState().keywords = v;
            ctx.touch();
          });
          return;
        }
        input.value = entry.value;
        ctx.getState().keywords = entry.value;
        ctx.touch();
      },
    });
  }
  if (opts.onEnter !== undefined) {
    // Клавиатура поля — через общеклиентский диспетчер: пока фокус в поле, его
    // контекст на вершине стека (ADR b420b08c, задача fd3d84f4). Сочетание —
    // чистый Enter: модификаторные варианты (Ctrl+Enter и т.п.) оставлены
    // каркасу диалога, как и у остальных полей фильтра.
    const contextId = `filter-keywords-${(keywordsContextSeq += 1)}`;
    defineKeyContext({
      id: contextId,
      bindings: [{ command: 'filterKeywords.enter', chord: 'Enter', run: () => opts.onEnter!() }],
    });
    let releaseContext: (() => void) | null = null;
    const onFocusIn = (): void => {
      releaseContext ??= pushKeyContext(contextId);
    };
    const onFocusOut = (): void => {
      releaseContext?.();
      releaseContext = null;
    };
    input.addEventListener('focusin', onFocusIn as EventListener);
    input.addEventListener('focusout', onFocusOut as EventListener);
  }
  if (opts.onBlur !== undefined) {
    input.addEventListener('blur', () => opts.onBlur!(input.value));
  }
  const clearBtn = el('button', 'st-f-clear-inline', '×') as HTMLButtonElement;
  clearBtn.type = 'button';
  setTooltip(clearBtn, t('actions.reset'));
  const syncClear = (): void => {
    clearBtn.hidden = input.value.trim() === '';
  };
  clearBtn.addEventListener('click', () => {
    ctx.getState().keywords = '';
    input.value = '';
    ctx.touch();
    syncClear();
  });
  input.addEventListener('input', syncClear);
  syncClear();
  wrap.append(input, clearBtn);
  section.body.append(wrap);
  if (opts.showScope === true) section.body.append(buildKeywordScopeRow(ctx));
  return section;
}

/**
 * Строка области поиска: «наименование/синонимы/комментарий». Снятие
 * последнего флажка возвращает пару по умолчанию (наименование+синонимы) —
 * область поиска не может остаться пустой.
 */
export function buildKeywordScopeRow(ctx: FilterFormContext): HTMLElement {
  const row = div('st-f-kw-scope');
  const items: Array<{
    label: string;
    get: () => boolean;
    set: (v: boolean) => void;
    input: HTMLInputElement | null;
  }> = [
    { label: 'наименование', get: () => ctx.getState().keywordInTitle, set: (v) => (ctx.getState().keywordInTitle = v), input: null },
    { label: 'синонимы', get: () => ctx.getState().keywordInSynonyms, set: (v) => (ctx.getState().keywordInSynonyms = v), input: null },
    { label: 'комментарий', get: () => ctx.getState().keywordInComment, set: (v) => (ctx.getState().keywordInComment = v), input: null },
  ];
  for (const item of items) {
    const lbl = el('label', 'checkbox-row st-f-kw-scope-item') as HTMLLabelElement;
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = item.get();
    item.input = cb;
    cb.addEventListener('change', () => {
      item.set(cb.checked);
      const state = ctx.getState();
      // Снят последний флажок — возвращаем пару по умолчанию.
      if (!state.keywordInTitle && !state.keywordInSynonyms && !state.keywordInComment) {
        state.keywordInTitle = true;
        state.keywordInSynonyms = true;
      }
      for (const other of items) other.input!.checked = other.get();
      ctx.touch();
    });
    lbl.append(cb, span(item.label));
    row.append(lbl);
  }
  return row;
}

/** Слово у каретки — запрос составного поля. */
function trailingWordQuery(input: HTMLInputElement): string {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  return /(\S*)$/.exec(before)?.[1] ?? '';
}

/** Заменяет слово у каретки токеном, оставляя остальной текст. */
function replaceTrailingWord(input: HTMLInputElement, token: string, onChange: (v: string) => void): void {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const after = input.value.slice(caret);
  const wordLen = /(\S*)$/.exec(before)?.[1]?.length ?? 0;
  const wordStart = caret - wordLen;
  const next = input.value.slice(0, wordStart) + token + after;
  input.value = next;
  onChange(next);
  input.focus();
  const newCaret = wordStart + token.length;
  try {
    input.setSelectionRange(newCaret, newCaret);
  } catch {
    /* ignore */
  }
}

/** Запрос составного поля по слову у каретки (для источников подсказок). */
export function compositeQueryOf(input: HTMLInputElement): string {
  return trailingWordQuery(input);
}

// ---------------------------------------------------------------------------
// Поля выбора сущностей (мысли / типы мыслей / типы связей)
// ---------------------------------------------------------------------------

/**
 * Поле выбора списка сущностей: общий чип-лист (`lib/entity-picker.ts`) в
 * блоке формы. Значения — чипы-мини-облачка; живой поиск смешивает каталог
 * с источниками вызывающего (токены отбора); кнопка «выбрать…» ДОБАВЛЯЕТ
 * результат к чипам, а не подменяет список.
 */
export interface EntityChipSectionOptions {
  title: string;
  getValues: () => readonly string[];
  setValues: (values: string[]) => void;
  loadOptions: (query: string) => EntityOption[] | Promise<EntityOption[]>;
  optionsHeader?: string;
  extraSources?: SuggestSource[];
  cloudOf?: (value: string) => ThoughtCloudInput | null;
  placeholder?: string;
  /** Приглашение непустого поля («+ ещё один тип/мысль»), 0.10.1 приёмка №2. */
  addPlaceholder?: string;
  tooltip?: string;
  /** Кнопка «выбрать…»: управляемое подмножество → новый список (null — отмена). */
  picker?: { label: string; open: (managed: readonly string[]) => Promise<string[] | null> };
}

/** Секция выбора сущностей по общему чип-листу. */
export interface EntityChipSection extends FilterSection {
  /** Перерисовать чипы (например, после догрузки облачков выбранных значений). */
  fieldRefresh: () => void;
  /** Корень чип-поля — точка регистрации приёмника дропа мысли (d144ef71). */
  fieldRoot: HTMLElement;
}

/** Секция выбора сущностей по общему чип-листу. */
export function buildEntityChipSection(ctx: FilterFormContext, opts: EntityChipSectionOptions): EntityChipSection {
  const section = buildFilterBlock(opts.title, {
    isNonEmpty: () => opts.getValues().length > 0,
  });
  const field = buildEntityChipField({
    getValues: () => [...opts.getValues()],
    onChange: (values) => {
      opts.setValues(values);
      ctx.touch();
    },
    loadOptions: opts.loadOptions,
    ...(opts.optionsHeader !== undefined ? { optionsHeader: opts.optionsHeader } : {}),
    ...(opts.extraSources !== undefined ? { extraSources: opts.extraSources } : {}),
    ...(opts.cloudOf !== undefined ? { cloudOf: opts.cloudOf } : {}),
    ...(opts.placeholder !== undefined ? { placeholder: opts.placeholder } : {}),
    ...(opts.addPlaceholder !== undefined ? { addPlaceholder: opts.addPlaceholder } : {}),
    ...(opts.picker !== undefined ? { picker: opts.picker } : {}),
  });
  if (opts.tooltip !== undefined) setTooltip(field.root, opts.tooltip);
  section.body.append(field.root);
  return { ...section, fieldRefresh: field.refresh, fieldRoot: field.root };
}

/**
 * Группа «Родительские мысли» — выбранные корни поддеревьев (`parent_ids`).
 * ЕДИНСТВЕННАЯ реализация роли: панель «Структур мыслей», панель «Хроники»,
 * диалог отбора типа мысли и рецепт публикации собирают поле этим фасадом —
 * своего чип-листа корней, своей догрузки «облачков» и своего живого поиска
 * у экранов нет (единый конструктор, стандарт S4).
 *
 * Внутри — общий чип-лист сущностей (`buildEntityChipSection`), живая
 * подсказка по мыслям (`findDuplicates`) и ленивая догрузка «облачков» уже
 * выбранных корней (`etn.thoughts.resolve`); живой поиск кладёт найденные
 * облачка в ту же карту. Своего контрола здесь нет — только сборка фасада
 * под роль «выбор корней поддерева».
 */
export interface ParentThoughtsSectionOptions {
  /** Заголовок группы (по умолчанию «Родительские мысли»). */
  title?: string;
  /** Подсказка поля. */
  tooltip?: string;
  /** Приглашение пустого поля (по умолчанию «Название мысли…»). */
  placeholder?: string;
  /** Приглашение непустого поля (по умолчанию «+ ещё одну мысль»). */
  addPlaceholder?: string;
  /** Дополнительные источники подсказок поля (токены отбора вызывающего). */
  extraSources?: SuggestSource[];
  /**
   * Кнопка «выбрать…» (пикер корней поддерева). Обязательна для составных
   * панелей: без неё у пустого поля нет явного триггера выбора — только ввод.
   */
  picker?: EntityChipSectionOptions['picker'];
}

/** Секция «Родительские мысли»: секция формы + перечитывание облачков. */
export interface ParentThoughtsSection extends EntityChipSection {
  /**
   * Перечитывает «облачка» уже выбранных корней. Нужен вызывающим, которые
   * меняют `parent_ids` ВНЕ поля (перетаскивание мысли на панель), — иначе
   * чип остался бы сырым id до следующей перерисовки.
   */
  resolveClouds: () => void;
}

export function buildParentThoughtsSection(
  ctx: FilterFormContext,
  opts: ParentThoughtsSectionOptions = {},
): ParentThoughtsSection {
  const clouds = new Map<string, ThoughtCloudInput>();
  let sectionRef: EntityChipSection | null = null;
  const resolveClouds = (): void => {
    const missing = ctx.getState().parentIds.filter((id) => !clouds.has(id) && !id.startsWith('$'));
    if (ctx.networkId === '' || missing.length === 0) return;
    void etn.thoughts
      .resolve(ctx.networkId, missing)
      .then((refs) => {
        for (const ref of refs) clouds.set(ref.id, { ...ref });
        sectionRef?.fieldRefresh();
      })
      .catch(() => undefined);
  };
  const section = buildEntityChipSection(ctx, {
    title: opts.title ?? 'Родительские мысли',
    getValues: () => ctx.getState().parentIds,
    setValues: (values) => {
      ctx.getState().parentIds = values;
      resolveClouds();
    },
    loadOptions: async (query) => {
      const needle = query.trim();
      if (needle === '') return [];
      try {
        const hits = await etn.thoughts.findDuplicates(ctx.networkId, needle, [], []);
        return hits.map((hit): EntityOption => {
          clouds.set(hit.id, { ...hit });
          return thoughtEntityOption(hit);
        });
      } catch {
        return [];
      }
    },
    optionsHeader: 'Мысли',
    cloudOf: (id) => (id.startsWith('$') ? null : (clouds.get(id) ?? null)),
    placeholder: opts.placeholder ?? 'Название мысли…',
    addPlaceholder: opts.addPlaceholder ?? '+ ещё одну мысль',
    ...(opts.extraSources !== undefined ? { extraSources: opts.extraSources } : {}),
    ...(opts.tooltip !== undefined ? { tooltip: opts.tooltip } : {}),
    ...(opts.picker !== undefined ? { picker: opts.picker } : {}),
  });
  sectionRef = section;
  // Приёмник pointer-дропа мысли (d144ef71): мысль, брошенная из карты/панели/
  // поля редактора на чип-лист корней, добавляется в «Родительские мысли» —
  // ровно так же, как drop на панель «Хроники» (`chronicleFilterAdd`). Единая
  // трактовка для всех панелей отбора: Структуры, Хроника, отбор типа мысли,
  // рецепт публикации (все собирают эту секцию общим фасадом).
  registerThoughtDropField(section.fieldRoot, {
    kind: 'filter',
    accept: (id: string): boolean => {
      const values = ctx.getState().parentIds;
      if (values.includes(id)) return false;
      ctx.getState().parentIds = [...values, id];
      resolveClouds();
      ctx.touch();
      section.fieldRefresh();
      return true;
    },
  });
  resolveClouds();
  return { ...section, resolveClouds };
}

// ---------------------------------------------------------------------------
// Условия по свойствам
// ---------------------------------------------------------------------------
export interface ConditionsSectionOptions {
  title?: string;
  /** Источники подсказок значения условия (токены отбора типа мысли и т.п.). */
  extraSuggestFor?: (cond: PropertyConditionState) => readonly SuggestSource[];
  /** Вид каретки сворачиваемой группы (по умолчанию — треугольник). */
  caretKind?: 'chevron' | 'triangle';
}

/**
 * Сворачиваемая группа «Свойства»: строки `[свойство][оператор][значение][×]`
 * и кнопка «+ условие». Значение строки редактирует ОБЩИЙ редактор значения
 * (`editor/value-editor.ts`, стандарт S2); источник подсказок — параметр
 * вызывающего.
 */
export function buildConditionsSection(
  ctx: FilterFormContext,
  collapse: { get: () => boolean; set: (v: boolean) => void },
  opts: ConditionsSectionOptions = {},
): FilterSection {
  const section = buildFilterBlock(opts.title ?? 'Свойства', {
    collapsible: true,
    getCollapsed: collapse.get,
    setCollapsed: collapse.set,
    isNonEmpty: () => ctx.getState().properties.length > 0,
    ...(opts.caretKind !== undefined ? { caretKind: opts.caretKind } : {}),
  });
  const box = div('st-f-conds');
  const render = (): void => {
    clear(box);
    const state = ctx.getState();
    if (state.properties.length === 0) {
      // Условий пока нет — общее пустое состояние с подсказкой, что сделать
      // (задача d7b7c367): «Добавьте условие отбора».
      box.append(emptyState({ title: t('filterForm.empty'), hint: t('filterForm.emptyHint') }));
      return;
    }
    state.properties.forEach((cond, index) => {
      box.append(buildConditionRow(ctx, cond, index, render, opts.extraSuggestFor));
    });
  };
  render();
  const add = el('button', 'st-f-add', '+ условие по свойству') as HTMLButtonElement;
  add.type = 'button';
  add.addEventListener('click', () => {
    const first = ctx.registry.values().next().value as NetworkProperty | undefined;
    if (first === undefined) {
      // Реестр пуст — строка с пустым свойством (панель «Структур»),
      // если вызывающий передал allowEmptyClear; иначе просто ничего.
      const state = ctx.getState();
      state.properties = [...state.properties, { propertyId: '', op: 'eq', values: [''] }];
      render();
      ctx.touch();
      return;
    }
    const op = OPS_BY_TYPE[first.value_type][0]!.op;
    const state = ctx.getState();
    state.properties = [...state.properties, { propertyId: first.id, op, values: [''] }];
    render();
    ctx.touch();
  });
  section.body.append(box, add);
  return section;
}

/** Одна строка условия: свойство / оператор / значение / удаление. */
function buildConditionRow(
  ctx: FilterFormContext,
  cond: PropertyConditionState,
  index: number,
  render: () => void,
  extraSuggestFor?: (cond: PropertyConditionState) => readonly SuggestSource[],
): HTMLElement {
  const row = div('st-f-cond');
  const def = ctx.registry.get(cond.propertyId);

  const propSelect = el('select', 'st-f-input st-f-prop') as HTMLSelectElement;
  if (!ctx.registry.has(cond.propertyId)) {
    const placeholder = el('option', '', cond.propertyId === '' ? '— свойство —' : '?') as HTMLOptionElement;
    placeholder.value = cond.propertyId;
    propSelect.append(placeholder);
  }
  for (const [id, entry] of ctx.registry) {
    const option = el('option', '', entry.name) as HTMLOptionElement;
    option.value = id;
    propSelect.append(option);
  }
  propSelect.value = cond.propertyId;
  propSelect.addEventListener('change', () => {
    const nextId = propSelect.value;
    const nextType: PropertyValueType = ctx.registry.get(nextId)?.value_type ?? 'text';
    const ops = OPS_BY_TYPE[nextType];
    const state = ctx.getState();
    state.properties[index] = {
      propertyId: nextId,
      op: ops.some((o) => o.op === cond.op) ? cond.op : ops[0]!.op,
      values: [''],
    };
    render();
    ctx.touch();
  });

  const opSelect = el('select', 'st-f-input st-f-op') as HTMLSelectElement;
  const ops = OPS_BY_TYPE[def?.value_type ?? 'text'];
  for (const op of ops) {
    const option = el('option', '', op.label) as HTMLOptionElement;
    option.value = op.op;
    opSelect.append(option);
  }
  if (!ops.some((o) => o.op === cond.op)) cond.op = ops[0]!.op;
  opSelect.value = cond.op;
  opSelect.addEventListener('change', () => {
    const state = ctx.getState();
    const live = state.properties[index] ?? cond;
    state.properties[index] = { ...live, op: opSelect.value as StructurePropertyOp, values: [''] };
    render();
    ctx.touch();
  });

  const valueBox = buildConditionValueEditor(ctx, cond, index, extraSuggestFor);

  const remove = el('button', 'st-f-remove', '×') as HTMLButtonElement;
  remove.type = 'button';
  remove.addEventListener('click', () => {
    const state = ctx.getState();
    state.properties = state.properties.filter((_, i) => i !== index);
    render();
    ctx.touch();
  });

  row.append(propSelect, opSelect, valueBox, remove);
  return row;
}

/** Значение условия — общий редактор значения (стандарт S2). */
function buildConditionValueEditor(
  ctx: FilterFormContext,
  cond: PropertyConditionState,
  index: number,
  extraSuggestFor?: (cond: PropertyConditionState) => readonly SuggestSource[],
): HTMLElement {
  const def = ctx.registry.get(cond.propertyId);
  const valueType: PropertyValueType = def?.value_type ?? 'text';
  const box = div('st-f-values');
  const isList = cond.op === 'in' || cond.op === 'not_in';
  if (cond.op === 'is_empty' || cond.op === 'not_empty') {
    box.append(el('span', 'st-f-value-hint', 'значение не требуется'));
    return box;
  }

  const live = (): PropertyConditionState => ctx.getState().properties[index] ?? cond;
  const setValues = (values: string[]): void => {
    ctx.getState().properties[index] = { ...live(), values: values.length > 0 ? values : [''] };
    ctx.touch();
  };

  const current = live();
  // `thought_ref` — legacy-вид с тем же значением (id мысли): ведётся редактором связи.
  const editorType: PropertyValueType = valueType === 'thought_ref' ? 'link' : valueType;
  const stored = current.values.filter((v) => v !== '');
  const raw = current.values[0] ?? '';
  const scalar: unknown =
    valueType === 'bool'
      ? (raw === '' ? null : raw === 'true')
      : valueType === 'number'
        ? (raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : '')
        : raw;
  const value: unknown = editorType === 'link' || isList ? stored : scalar;
  const extraSuggest = extraSuggestFor?.(cond) ?? [];

  box.append(
    buildValueEditor({
      networkId: ctx.networkId,
      definition: {
        value_type: editorType,
        config: isList ? { ...(def?.config ?? {}), multiple: true } : (def?.config ?? null),
        required: false,
        default_value: null,
      },
      value,
      commitOn: 'change',
      boolTriState: valueType === 'bool',
      extraSuggest,
      ...(valueType === 'date' ? { placeholder: 'YYYY-MM-DD или токен ($today+7d)…' } : {}),
      save: (next) => {
        if (Array.isArray(next)) setValues(next.map((v) => String(v)));
        else if (next === null || next === undefined || next === '') setValues(['']);
        else setValues([String(next)]);
        return true;
      },
    }),
  );
  return box;
}

// ---------------------------------------------------------------------------
// «Дополнительно»: признаки и корзина
// ---------------------------------------------------------------------------

export interface TriRowOptions {
  yes?: string;
  no?: string;
  disabled?: boolean;
  tooltip?: string;
}

/** Строка трёхзначного признака «не важно / да / нет». */
export function buildTriRow(
  ctx: FilterFormContext,
  label: string,
  get: () => TriState,
  set: (v: TriState) => void,
  options?: TriRowOptions,
): HTMLElement {
  const row = div('st-f-tri-row');
  row.append(el('span', 'st-f-tri-label', label));
  const select = el('select', 'st-f-input') as HTMLSelectElement;
  for (const opt of [
    { v: '', label: 'не важно' },
    { v: 'true', label: options?.yes ?? 'да' },
    { v: 'false', label: options?.no ?? 'нет' },
  ]) {
    const o = el('option', '', opt.label) as HTMLOptionElement;
    o.value = opt.v;
    select.append(o);
  }
  const cur = get();
  select.value = cur === null ? '' : cur ? 'true' : 'false';
  if (options?.disabled === true) {
    select.disabled = true;
    if (options.tooltip !== undefined) setTooltip(select, options.tooltip);
  }
  select.addEventListener('change', () => {
    set(select.value === '' ? null : select.value === 'true');
    ctx.touch();
  });
  row.append(select);
  return row;
}

/** Строка флажка «Включая помеченные на удаление» (корзина).
 *  `disabled` гасит флажок, когда содержимое корзины не показывают (задача
 *  77923b49) — та же дисциплина, что у «Только актуальные» при выключенном
 *  «Показывать неактуальное». */
export function buildTrashedRow(
  ctx: FilterFormContext,
  label = 'Включая помеченные на удаление',
  opts: { disabled?: boolean; tooltip?: string } = {},
): HTMLElement {
  const row = div('st-f-tri-row');
  const lbl = el('label', 'checkbox-row') as HTMLLabelElement;
  const cb = el('input') as HTMLInputElement;
  cb.type = 'checkbox';
  cb.checked = ctx.getState().trashed;
  if (opts.disabled === true) {
    cb.disabled = true;
    if (opts.tooltip !== undefined) setTooltip(lbl, opts.tooltip);
  }
  cb.addEventListener('change', () => {
    ctx.getState().trashed = cb.checked;
    ctx.touch();
  });
  lbl.append(cb, span(label));
  row.append(el('span', 'st-f-tri-label', 'Корзина'), lbl);
  return row;
}

export interface ExtrasSectionOptions {
  title?: string;
  /** Подписи строк и вид признака «Актуальность» (в «Структурах» — отключён). */
  activeDisabled?: boolean;
  activeTooltip?: string;
  /** Флажок «Корзина» гаснет, когда корзину не показывают (задача 77923b49). */
  trashedDisabled?: boolean;
  trashedTooltip?: string;
  /** Вид каретки сворачиваемой группы (по умолчанию — треугольник). */
  caretKind?: 'chevron' | 'triangle';
}

/** Признаки отбора заполнены. */
export function extrasActive(state: FilterCriteriaState): boolean {
  return (
    state.hasProperties !== null ||
    state.hasComment !== null ||
    state.hasAttachments !== null ||
    state.hasChronology !== null ||
    state.active !== null ||
    state.trashed
  );
}

/**
 * Сворачиваемая группа «Дополнительно»: признаки (значение свойства,
 * комментарий, вложения, хронология), «Только актуальные» и корзина.
 */
export function buildExtrasSection(
  ctx: FilterFormContext,
  collapse: { get: () => boolean; set: (v: boolean) => void },
  opts: ExtrasSectionOptions = {},
): FilterSection {
  const section = buildFilterBlock(opts.title ?? 'Дополнительно', {
    collapsible: true,
    getCollapsed: collapse.get,
    setCollapsed: collapse.set,
    isNonEmpty: () => extrasActive(ctx.getState()),
    ...(opts.caretKind !== undefined ? { caretKind: opts.caretKind } : {}),
  });
  section.body.append(
    buildTriRow(ctx, 'Есть значение свойства', () => ctx.getState().hasProperties, (v) => (ctx.getState().hasProperties = v)),
    buildTriRow(ctx, 'Есть постоянный комментарий', () => ctx.getState().hasComment, (v) => (ctx.getState().hasComment = v)),
    buildTriRow(ctx, 'Есть вложения', () => ctx.getState().hasAttachments, (v) => (ctx.getState().hasAttachments = v)),
    buildTriRow(ctx, 'Есть хронология', () => ctx.getState().hasChronology, (v) => (ctx.getState().hasChronology = v)),
    buildTriRow(ctx, 'Только актуальные', () => ctx.getState().active, (v) => (ctx.getState().active = v), {
      yes: 'актуальные',
      no: 'не актуальные',
      ...(opts.activeDisabled === true ? { disabled: true } : {}),
      ...(opts.activeTooltip !== undefined ? { tooltip: opts.activeTooltip } : {}),
    }),
    buildTrashedRow(ctx, 'Включая помеченные на удаление', {
      ...(opts.trashedDisabled === true ? { disabled: true } : {}),
      ...(opts.trashedTooltip !== undefined ? { tooltip: opts.trashedTooltip } : {}),
    }),
  );
  return section;
}

// ---------------------------------------------------------------------------
// Автор / Редактор
// ---------------------------------------------------------------------------

export interface AuthorshipSectionOptions {
  title?: string;
  /** Редакторы значения строк авторства (по умолчанию — виджеты пользователей). */
  editors?: AuthorRowEditors;
  /** Подписи строк (по умолчанию «Автор» и «Редактор»). */
  authorLabel?: string;
  editorLabel?: string;
}

/**
 * Сворачиваемая группа «Автор / Редактор»: две строки «подпись / оператор /
 * значение» по единому скелету `buildAuthorConditionRow`. Различаются только
 * редакторы значения (у диалога отбора типа — с токенами и живым поиском).
 */
export function buildAuthorshipSection(
  ctx: FilterFormContext,
  collapse: { get: () => boolean; set: (v: boolean) => void },
  opts: AuthorshipSectionOptions = {},
): FilterSection {
  const section = buildFilterBlock(opts.title ?? 'Автор / Редактор', {
    collapsible: true,
    getCollapsed: collapse.get,
    setCollapsed: collapse.set,
    isNonEmpty: () => {
      const s = ctx.getState();
      return (
        authorFilterActive(s.authorOp, s.authorId, s.authorIds) ||
        authorFilterActive(s.editorOp, s.editorId, s.editorIds)
      );
    },
  });
  const rows = div('st-f-author-rows');
  const render = (): void => {
    clear(rows);
    const state = ctx.getState();
    rows.append(
      buildAuthorConditionRow({
        label: opts.authorLabel ?? 'Автор',
        op: state.authorOp,
        singleId: state.authorId,
        listIds: state.authorIds,
        ...(opts.editors !== undefined ? { editors: opts.editors } : {}),
        onOpChange: (op) => {
          const s = ctx.getState();
          s.authorOp = op;
          if (op !== 'eq' && op !== 'ne') s.authorId = '';
          if (op !== 'in' && op !== 'not_in') s.authorIds = [];
          render();
          ctx.touch();
        },
        onSingleChange: (id) => {
          ctx.getState().authorId = id;
          ctx.touch();
        },
        onListChange: (ids) => {
          ctx.getState().authorIds = ids;
          ctx.touch();
        },
      }),
      buildAuthorConditionRow({
        label: opts.editorLabel ?? 'Редактор',
        op: state.editorOp,
        singleId: state.editorId,
        listIds: state.editorIds,
        ...(opts.editors !== undefined ? { editors: opts.editors } : {}),
        onOpChange: (op) => {
          const s = ctx.getState();
          s.editorOp = op;
          if (op !== 'eq' && op !== 'ne') s.editorId = '';
          if (op !== 'in' && op !== 'not_in') s.editorIds = [];
          render();
          ctx.touch();
        },
        onSingleChange: (id) => {
          ctx.getState().editorId = id;
          ctx.touch();
        },
        onListChange: (ids) => {
          ctx.getState().editorIds = ids;
          ctx.touch();
        },
      }),
    );
  };
  render();
  section.body.append(rows);
  return section;
}

/**
 * Сворачиваемая группа с ОДНОЙ строкой авторства (экран «События»: одно
 * условие «Пользователь»). Строка — тот же общий скелет
 * `buildAuthorConditionRow`; поле состояния выбирается параметром.
 */
export function buildAuthorConditionSection(
  ctx: FilterFormContext,
  opts: {
    title: string;
    label: string;
    field: 'author' | 'editor';
    editors?: AuthorRowEditors;
    collapse?: { get: () => boolean; set: (v: boolean) => void };
  },
): FilterSection {
  const section = buildFilterBlock(opts.title, {
    ...(opts.collapse !== undefined
      ? { collapsible: true, getCollapsed: opts.collapse.get, setCollapsed: opts.collapse.set }
      : {}),
    isNonEmpty: () => {
      const s = ctx.getState();
      return opts.field === 'author'
        ? authorFilterActive(s.authorOp, s.authorId, s.authorIds)
        : authorFilterActive(s.editorOp, s.editorId, s.editorIds);
    },
  });
  const rows = div('st-f-author-rows');
  const render = (): void => {
    clear(rows);
    const state = ctx.getState();
    const op = opts.field === 'author' ? state.authorOp : state.editorOp;
    rows.append(
      buildAuthorConditionRow({
        label: opts.label,
        op,
        singleId: opts.field === 'author' ? state.authorId : state.editorId,
        listIds: opts.field === 'author' ? state.authorIds : state.editorIds,
        ...(opts.editors !== undefined ? { editors: opts.editors } : {}),
        onOpChange: (next) => {
          const s = ctx.getState();
          if (opts.field === 'author') s.authorOp = next;
          else s.editorOp = next;
          if (next !== 'eq' && next !== 'ne') {
            if (opts.field === 'author') s.authorId = '';
            else s.editorId = '';
          }
          if (next !== 'in' && next !== 'not_in') {
            if (opts.field === 'author') s.authorIds = [];
            else s.editorIds = [];
          }
          render();
          ctx.touch();
        },
        onSingleChange: (id) => {
          const s = ctx.getState();
          if (opts.field === 'author') s.authorId = id;
          else s.editorId = id;
          ctx.touch();
        },
        onListChange: (ids) => {
          const s = ctx.getState();
          if (opts.field === 'author') s.authorIds = ids;
          else s.editorIds = ids;
          ctx.touch();
        },
      }),
    );
  };
  render();
  section.body.append(rows);
  return section;
}

// ---------------------------------------------------------------------------
// Даты
// ---------------------------------------------------------------------------

export interface DateRangeOptions {
  /**
   * Вид поля: `editor` — общий редактор значения (дата + токены отбора);
   * `period` — общее поле периода `lib/period-editor.ts` (вариант `dialog`,
   * задача 12a5e719): строка периода с «крестиком» очистки, авто-индикатором
   * «Учитывать время» и правкой диалогом «Дата/период».
   */
  mode?: 'editor' | 'period';
  label: string;
  after: string;
  before: string;
  onAfterChange: (v: string) => void;
  onBeforeChange: (v: string) => void;
  /** Источник подсказок для режима `editor`. */
  suggestSource?: SuggestSource;
}

/**
 * Поле периода режима `period`: общий контрол `lib/period-editor.ts`
 * (вариант `dialog`). Диалог «Дата/период» строит каркас (сам контрол его не
 * импортирует); возвращённые локальные даты/время конвертируются в границы
 * значения — пустое время даёт «голую дату», иначе UTC-инстанс.
 */
function buildPeriodField(opts: DateRangeOptions): HTMLElement {
  const editor = buildPeriodEditor({
    variant: 'dialog',
    label: opts.label,
    value: { from: opts.after, to: opts.before },
    onChange: (value) => {
      opts.onAfterChange(value.from ?? '');
      opts.onBeforeChange(value.to ?? '');
    },
    openPeriodDialog: async (current) => {
      const from = parseLocalBound(current.from);
      const to = parseLocalBound(current.to);
      const withTime = hasExplicitTime(from.time) || hasExplicitTime(to.time);
      const period = from.date !== '' && to.date !== '' && from.date !== to.date;
      const fallback = from.date === '' ? todayLocal() : from.date;
      const result = await openDatePeriodDialog({
        allowPeriod: true,
        allowTime: true,
        title: opts.label,
        initial: {
          mode: period ? 'period' : 'date',
          from: fallback,
          to: to.date === '' ? fallback : to.date,
          hasTime: withTime,
          fromTime: from.time === '' ? DPD_DEFAULT_TIME : from.time,
          toTime: to.time === '' ? (from.time === '' ? DPD_DEFAULT_TIME : from.time) : to.time,
        },
      });
      if (result === null) return null;
      return {
        from: composeLocalBound(result.from, result.hasTime ? result.fromTime : ''),
        to: composeLocalBound(
          result.mode === 'date' ? result.from : result.to,
          result.hasTime ? result.toTime : '',
        ),
      };
    },
  });
  const field = div('st-f-date-period');
  field.append(editor.root);
  return field;
}

/** Строка «от / до» одной временной группы. */
export function buildDateRangeRow(ctx: FilterFormContext, opts: DateRangeOptions): HTMLElement {
  const row = div('st-f-date-row');
  row.append(el('span', 'st-f-date-label', opts.label));

  if ((opts.mode ?? 'editor') === 'period') {
    row.append(buildPeriodField(opts));
    return row;
  }

  const buildField = (value: string, tag: string, set: (v: string) => void): HTMLElement => {
    const wrap = div('st-f-date-field');
    wrap.append(el('span', 'st-f-date-tag', tag));
    wrap.append(
      buildValueEditor({
        networkId: ctx.networkId,
        definition: { value_type: 'date', config: null, required: false, default_value: null },
        value,
        commitOn: 'change',
        placeholder: 'YYYY-MM-DD или токен…',
        ...(opts.suggestSource !== undefined ? { extraSuggest: [opts.suggestSource] } : {}),
        save: (next) => {
          set(next === null || next === undefined ? '' : String(next));
          return true;
        },
      }),
    );
    return wrap;
  };

  row.append(
    buildField(opts.after, 'от', (v) => opts.onAfterChange(v)),
    buildField(opts.before, 'до', (v) => opts.onBeforeChange(v)),
  );
  return row;
}

export interface DatesSectionOptions {
  mode?: 'editor' | 'period';
  title?: string;
  /**
   * Пары «от/до» группы. По умолчанию — «Создано»/«Изменено» по общим полям
   * состояния (`createdAfter`/`createdBefore`, `updatedAfter`/`updatedBefore`).
   * Экран со своим периодом («Хроника») передаёт свои геттеры/сеттеры —
   * состав и расположение элементов остаются параметром сборки.
   */
  ranges?: DateRangeSpec[];
  suggestSource?: SuggestSource;
  /** Заполнена ли группа (по умолчанию — любая из общих границ). */
  isNonEmpty?: () => boolean;
}

/** Одна пара «от/до» секции дат. */
export interface DateRangeSpec {
  label: string;
  getFrom: () => string;
  getTo: () => string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
}

/** Пары по умолчанию: «Создано» и «Изменено» — общие поля модели. */
export function defaultDateRanges(ctx: FilterFormContext): DateRangeSpec[] {
  return [
    {
      label: 'Создано',
      getFrom: () => ctx.getState().createdAfter,
      getTo: () => ctx.getState().createdBefore,
      setFrom: (v) => {
        ctx.getState().createdAfter = v;
      },
      setTo: (v) => {
        ctx.getState().createdBefore = v;
      },
    },
    {
      label: 'Изменено',
      getFrom: () => ctx.getState().updatedAfter,
      getTo: () => ctx.getState().updatedBefore,
      setFrom: (v) => {
        ctx.getState().updatedAfter = v;
      },
      setTo: (v) => {
        ctx.getState().updatedBefore = v;
      },
    },
  ];
}

/**
 * Сворачиваемая группа «Даты»: пары «от/до» по переданной сборке (по
 * умолчанию — «Создано»/«Изменено»).
 */
export function buildDatesSection(
  ctx: FilterFormContext,
  collapse: { get: () => boolean; set: (v: boolean) => void },
  opts: DatesSectionOptions = {},
): FilterSection {
  const section = buildFilterBlock(opts.title ?? 'Даты', {
    collapsible: true,
    getCollapsed: collapse.get,
    setCollapsed: collapse.set,
    isNonEmpty: opts.isNonEmpty ?? (() => datesActive(ctx.getState())),
  });
  const mode = opts.mode ?? 'editor';
  const ranges = opts.ranges ?? defaultDateRanges(ctx);
  for (const range of ranges) {
    section.body.append(
      buildDateRangeRow(ctx, {
        mode,
        label: range.label,
        after: range.getFrom(),
        before: range.getTo(),
        onAfterChange: (v) => {
          range.setFrom(v);
          ctx.touch();
        },
        onBeforeChange: (v) => {
          range.setTo(v);
          ctx.touch();
        },
        ...(opts.suggestSource !== undefined ? { suggestSource: opts.suggestSource } : {}),
      }),
    );
  }
  return section;
}

// ---------------------------------------------------------------------------
// Словарь флажков-пилюль
// ---------------------------------------------------------------------------

/** Один пункт словаря флажков-пилюль. */
export interface PillOption<Value extends string> {
  value: Value;
  label: string;
}

/** Параметры секции-словаря: закрытый список значений и его место в модели. */
export interface PillGroupOptions<Value extends string> {
  /** Заголовок группы. */
  title: string;
  /** Словарь значений — его порядок и состав задают вид панели. */
  items: ReadonlyArray<PillOption<Value>>;
  /** Текущий выбор в модели состояния (пустой список — «любое значение»). */
  get: () => readonly Value[];
  /** Запись выбора в модель состояния. */
  set: (next: Value[]) => void;
  /**
   * Сворачиваемость группы (задача 2ebe4206): эталон «Структур» сворачивает
   * группы, «События» повторяют этот принцип. Без параметра группа не
   * сворачивается.
   */
  collapse?: { get: () => boolean; set: (value: boolean) => void };
}

/**
 * Группа «словарь флажков-пилюль»: одно значение словаря — один флажок
 * (`мысль`, `связь`, `создал(а)`, …). Единственная реализация такого
 * элемента на весь клиент — экраны строят свои словари этим конструктором
 * (`buildFilterBlock` + флажки), а не своей сборкой.
 *
 * Флажок строится **из модели** и показывает применённый отбор: снятые
 * флажки при непустом выборе означали для пользователя «отбор пуст, а лента
 * пуста» — непустая лента выглядела как «события не сохранились» (ошибка
 * 83f6028e, регрессия задачи 3742dd59: своя сборка флажков не
 * восстанавливала состояние). Изменение флажка живёт в модели и помечается
 * `touch()` — запрос запускает вызывающий (кнопка «Применить»).
 */
export function buildPillGroupSection<Value extends string>(
  ctx: FilterFormContext,
  opts: PillGroupOptions<Value>,
): FilterSection {
  const section = buildFilterBlock(opts.title, {
    ...(opts.collapse !== undefined
      ? {
          collapsible: true,
          getCollapsed: opts.collapse.get,
          setCollapsed: opts.collapse.set,
        }
      : {}),
    isNonEmpty: () => opts.get().length > 0,
  });
  const box = div('st-f-pills');
  for (const item of opts.items) {
    const label = el('label', 'st-f-pill') as HTMLLabelElement;
    const input = el('input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = opts.get().includes(item.value);
    input.addEventListener('change', () => {
      const next = opts.get().filter((v) => v !== item.value);
      if (input.checked) next.push(item.value);
      opts.set(next);
      // Маркеры групп обновляет хост — общий `touch()` (запрос запускает
      // кнопка «Применить», а не сам флажок).
      ctx.touch();
    });
    label.append(input, span(item.label));
    box.append(label);
  }
  section.body.append(box);
  return section;
}

// ---------------------------------------------------------------------------
// Сортировка
// ---------------------------------------------------------------------------

export interface SortSectionOptions {
  title?: string;
  /** Показывать выбор ПОЛЯ сортировки (иначе только направление). */
  showSort?: boolean;
}

/**
 * Группа «Сортировка»: поле (из единого набора {@link FILTER_SORTS}) и
 * направление (из {@link FILTER_ORDERS}). Наборы — единые экземпляры
 * конструктора; списки собираются только отсюда.
 */
export function buildSortSection(ctx: FilterFormContext, opts: SortSectionOptions = {}): FilterSection {
  const section = buildFilterBlock(opts.title ?? 'Сортировка');
  const row = div('st-f-sort');
  if ((opts.showSort ?? true) === true) {
    const sortSelect = el('select', 'st-f-input') as HTMLSelectElement;
    for (const opt of FILTER_SORTS) {
      const o = el('option', '', opt.label) as HTMLOptionElement;
      o.value = opt.v;
      sortSelect.append(o);
    }
    sortSelect.value = ctx.getState().sort;
    sortSelect.addEventListener('change', () => {
      ctx.getState().sort = sortSelect.value as StructureSort;
      ctx.touch();
    });
    row.append(sortSelect);
  }
  const orderSelect = el('select', 'st-f-input') as HTMLSelectElement;
  for (const opt of FILTER_ORDERS) {
    const o = el('option', '', opt.label) as HTMLOptionElement;
    o.value = opt.v;
    orderSelect.append(o);
  }
  orderSelect.value = ctx.getState().order;
  orderSelect.addEventListener('change', () => {
    ctx.getState().order = orderSelect.value as SortOrder;
    ctx.touch();
  });
  row.append(orderSelect);
  section.body.append(row);
  return section;
}

// ---------------------------------------------------------------------------
// Футер формы и сборка
// ---------------------------------------------------------------------------

/** Кнопки футера «Применить / Очистить» (+ необязательные дополнительные). */
export function buildFilterFooterButtons(opts: {
  onApply: () => void;
  onClear: () => void;
  applyLabel?: string;
  clearLabel?: string;
  extra?: HTMLElement[];
}): HTMLElement {
  const row = div('st-f-btnrow');
  const apply = el('button', 'st-f-apply', opts.applyLabel ?? t('actions.apply'));
  apply.type = 'button';
  apply.addEventListener('click', () => opts.onApply());
  const clearBtn = el('button', 'st-f-clear', opts.clearLabel ?? t('actions.reset'));
  clearBtn.type = 'button';
  clearBtn.addEventListener('click', () => opts.onClear());
  row.append(apply, clearBtn, ...(opts.extra ?? []));
  return row;
}

/** Секция формы: заголовок-маркер уже внутри `section.box`. */
export interface FilterFormLayout {
  root: HTMLElement;
  /** Прокручиваемая область (для экранных дополнений вне секций). */
  scroll: HTMLElement;
  /** Футер формы. */
  footer: HTMLElement;
  refresh: () => void;
}

/**
 * Собирает форму отбора из готовых секций: вертикальный список с
 * прокруткой + футер. Единый каркас всех пяти мест применения конструктора.
 * `mount` — готовый хост (панель со своими размерами/flex); иначе создаётся
 * обёртка `st-f-layout`.
 */
export function buildFilterForm(opts: {
  sections: FilterSection[];
  /** Прокручиваемая область содержит эти узлы ПЕРЕД секциями (экранные дополнения). */
  header?: HTMLElement[];
  /** Узлы футера (кнопки, сохранённые отборы). */
  footer?: HTMLElement[];
  className?: string;
  /** Готовый хост: прокрутка и футер кладутся прямо в него. */
  mount?: HTMLElement;
}): FilterFormLayout {
  const scroll = div('st-f-scroll');
  if (opts.header !== undefined) scroll.append(...opts.header);
  for (const section of opts.sections) scroll.append(section.box);
  const footer = div('st-f-footer');
  if (opts.footer !== undefined) footer.append(...opts.footer);
  const root = opts.mount ?? div(opts.className ?? 'st-f-layout');
  root.append(scroll, footer);
  return {
    root,
    scroll,
    footer,
    refresh: () => {
      for (const section of opts.sections) section.refresh();
    },
  };
}

export type { StructureAuthorOp, SortOrder, StructureSort, StructurePropertyOp };
