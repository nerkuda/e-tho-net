/**
 * Pure helpers for the thought-type view editor dialog (задача e37f3f04).
 *
 * The dialog itself (`filter-dialog.ts`) imports from the broader renderer
 * (DOM helpers, dialog, the thought picker, etc.), which transitively pulls
 * in CodeMirror and the focus-filter-strip — too heavy for the unit tests
 * that exercise only the pure logic (token builder, wire shape, default
 * state, JSON round-trip).
 *
 * Модель состояния отбора, конвертер в wire и словари — единый конструктор
 * `lib/filter-builder.ts` (задача 48b59d00, веха 5); здесь остались только
 * токен-пикер и тонкие обёртки над конструктором, сохраняющие прежний
 * публичный интерфейс этого модуля для тестов.
 */

import type {
  EffectiveTypeProperty,
  NetworkProperty,
  PropertyValueType,
  StructurePropertyOp,
  ThoughtType,
  ThoughtTypeView,
  ThoughtTypeViewDefinition,
} from '@etn/shared';

import {
  THOUGHT_TYPE_VIEW_DESCRIPTION_MAX,
  THOUGHT_TYPE_VIEW_NAME_MAX,
} from '@etn/shared';

import {
  buildWireFilter,
  defaultFilterCriteriaState,
  hasAnyFilterCriteria,
  parseFilterDefinition,
  type FilterCriteriaState,
  type PropertyConditionState,
} from '../../lib/filter-builder.js';

// ---------------------------------------------------------------------------
// Состояние отбора и wire — единый конструктор `lib/filter-builder.ts`
// ---------------------------------------------------------------------------

/** Псевдонимы единой модели (публичный интерфейс модуля для тестов). */
export type DialogCriteriaState = FilterCriteriaState;
export type DialogPropertyCondition = PropertyConditionState;

export const defaultDialogCriteriaState = defaultFilterCriteriaState;

/**
 * Parses an existing view's JSON `definition` into the dialog state.
 * Returns the default state when the JSON is malformed.
 */
export function parseViewDefinition(view: ThoughtTypeView | null): FilterCriteriaState {
  if (view === null) return defaultFilterCriteriaState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(view.definition) as unknown;
  } catch {
    return defaultFilterCriteriaState();
  }
  return parseFilterDefinition(parsed);
}

/**
 * Materialises the wire `ThoughtTypeViewDefinition` единым конвертером
 * конструктора в режиме отбора типа мысли («не важно» → `show_inactive`).
 */
export function buildWireDefinition(
  state: FilterCriteriaState,
  registryById: Map<string, NetworkProperty>,
): ThoughtTypeViewDefinition {
  return buildWireFilter(state, registryById, { activeMode: 'view' });
}

/** Единый признак «задан хотя бы один критерий» (запрет пустого отбора). */
export const hasAnyCriteria = hasAnyFilterCriteria;

/** One row of the type chain loaded for the dialog (own + ancestors). */
export interface ChainProperties {
  type: ThoughtType;
  props: EffectiveTypeProperty[];
}

/** A token the picker can insert into a value field. */
export interface ViewToken {
  /** The text inserted into the value (e.g. `$today`, `$thought.[версия]`). */
  text: string;
  /** Human-readable label for the dropdown row. */
  label: string;
  /** Optional section header shown above the token in the dropdown. */
  section?: string;
  /**
   * `true` — this token resolves to a list of values (multiple property,
   * `$thought.[<multi>]`). Only available in conditions with op `in`/`not_in`.
   */
  listOnly?: boolean;
}

/**
 * Build the token list for a value field. `propertyValueType` constrains
 * which tokens are valid for the field; `op` widens the list for
 * list-operations (`in`/`not_in`).
 */
export function buildTokensForField(
  chainProps: ChainProperties[],
  propertyValueType: PropertyValueType | null,
  op: StructurePropertyOp | null,
): ViewToken[] {
  const out: ViewToken[] = [];

  // Global tokens.
  if (propertyValueType === null || propertyValueType === 'date') {
    out.push({ text: '$today', label: '$today — сегодня', section: 'Глобальные' });
    out.push({ text: '$now', label: '$now — текущий момент' });
  }
  if (propertyValueType === null || propertyValueType === 'text' || propertyValueType === 'url') {
    out.push({ text: '$user', label: '$user — текущий пользователь' });
  }

  // Thought-field tokens.
  if (propertyValueType === null) {
    out.push(
      { text: '$thought', label: '$thought — id мысли в фокусе', section: 'Поля мысли' },
      { text: '$thought.title', label: '$thought.title' },
      { text: '$thought.synonyms', label: '$thought.synonyms' },
      { text: '$thought.type', label: '$thought.type' },
      { text: '$thought.active', label: '$thought.active' },
      { text: '$thought.author', label: '$thought.author' },
      { text: '$thought.editor', label: '$thought.editor' },
      { text: '$thought.created', label: '$thought.created' },
      { text: '$thought.updated', label: '$thought.updated' },
    );
  }
  if (propertyValueType === 'text' || propertyValueType === 'url') {
    // Для строковых свойств токен-пикер предлагает строковые поля мысли,
    // а не id типа/пользователя — они не совпадут по типу со значением
    // строкового свойства (ошибка e8365d29).
    out.push(
      { text: '$thought.title', label: '$thought.title', section: 'Поля мысли' },
      { text: '$thought.synonyms', label: '$thought.synonyms' },
    );
  }
  if (propertyValueType === 'date') {
    out.push(
      { text: '$thought.created', label: '$thought.created', section: 'Поля мысли' },
      { text: '$thought.updated', label: '$thought.updated' },
    );
  }
  if (propertyValueType === 'bool') {
    out.push({ text: '$thought.active', label: '$thought.active', section: 'Поля мысли' });
  }
  // Свойство-связь (0.8.1) и legacy `thought_ref`: значение — id мысли,
  // поэтому естественный токен для сравнения — `$thought` (= id мысли в
  // фокусе). Сервер (`thought-type-view-tokens.ts`) его принимает, а UI
  // раньше в пикере значения не предлагал — отбор с целью-токеном можно
  // было сохранить только прямым POST (ошибка fad9f28c-…).
  if (propertyValueType === 'link' || propertyValueType === 'thought_ref') {
    out.push({ text: '$thought', label: '$thought — id мысли в фокусе', section: 'Поля мысли' });
  }

  // Property tokens (one section per ancestor level).
  for (const level of chainProps) {
    if (level.props.length === 0) continue;
    const sectionName = `Свойства «${level.type.name}»`;
    for (const def of level.props) {
      const tokenText = `$thought.[${def.key}]`;
      const labelSuffix = isListOp(op) ? ' […]' : '';
      const multiple = def.config?.multiple === true;
      const token: ViewToken = {
        text: tokenText,
        label: `${tokenText}${labelSuffix} — ${def.value_type}`,
        section: sectionName,
      };
      if ((def.value_type === 'url' || def.value_type === 'text') && multiple) {
        token.listOnly = true;
      }
      if (
        propertyValueType !== null &&
        !propertyMatches(def.value_type, propertyValueType, multiple) &&
        !token.listOnly
      ) {
        continue;
      }
      out.push(token);
    }
  }

  return out;
}

/**
 * Поля отбора, у которых нет «типа значения» свойства, но которым нужен
 * токен-пикер (баг 2): ключевые слова, тип мысли/связи, автор, редактор.
 */
export type SpecialTokenField =
  | 'keywords'
  | 'thought_type'
  | 'link_type'
  | 'author'
  | 'editor';

/**
 * Токены для полей, не привязанных к типу значения свойства
 * (баг 2, таблица токенов из решения №7 тех.проекта 918833e3, расширено в
 * задаче 68ec0b5b для текстовых свойств с id онтологии):
 *
 *   * `keywords` — `$thought.title`, `$thought.synonyms` + свойства типа/предков
 *     с типом значения text/url (поиск по тексту);
 *   * `thought_type` — `$thought.type` (id типа мысли-контекста) плюс
 *     текстовые/url-свойства цепочки типов: текстовое свойство может
 *     хранить id нужного типа, резолвер подставит его «как есть» без
 *     проверки соответствия типов;
 *   * `link_type` — то же, что `thought_type`, только без `$thought.type`
 *     (у мысли нет поля «id типа связи»): только текстовые/url-свойства
 *     цепочки типов;
 *   * `author`/`editor` — `$thought.author`/`$thought.editor` + `$user`.
 *
 * Скалярные операции (`eq`) несовместимы с множественными свойствами
 * (валидируется сервером по `validateDefinitionForTokens`) — такие
 * токены из кандидатов исключаются.
 */
export function buildTokensForSpecialField(
  chainProps: ChainProperties[],
  field: SpecialTokenField,
): ViewToken[] {
  if (field === 'thought_type' || field === 'link_type') {
    const out: ViewToken[] = [];
    if (field === 'thought_type') {
      out.push({
        text: '$thought.type',
        label: '$thought.type — тип мысли в фокусе',
        section: 'Поля мысли',
      });
    }
    for (const level of chainProps) {
      if (level.props.length === 0) continue;
      const sectionName = `Свойства «${level.type.name}»`;
      for (const def of level.props) {
        if (def.value_type !== 'text' && def.value_type !== 'url') continue;
        // Скалярные операции `eq` несовместимы с множественными свойствами
        // (валидация сервера: `validateDefinitionForTokens`).
        if (def.config?.multiple === true) continue;
        out.push({
          text: `$thought.[${def.key}]`,
          label: `$thought.[${def.key}] — ${def.value_type}`,
          section: sectionName,
        });
      }
    }
    return out;
  }
  if (field === 'author' || field === 'editor') {
    // Для ОБОИХ полей (автор и редактор) доступны и `$thought.author`, и
    // `$thought.editor`, и `$user` — отбор наследуется, поэтому «автор» и
    // «редактор» должны адресоваться независимо от поля (ошибка e8365d29).
    return [
      { text: '$thought.author', label: '$thought.author', section: 'Поля мысли' },
      { text: '$thought.editor', label: '$thought.editor' },
      { text: '$user', label: '$user — текущий пользователь', section: 'Глобальные' },
    ];
  }
  // keywords
  const out: ViewToken[] = [
    { text: '$thought.title', label: '$thought.title', section: 'Поля мысли' },
    { text: '$thought.synonyms', label: '$thought.synonyms' },
  ];
  for (const level of chainProps) {
    if (level.props.length === 0) continue;
    const sectionName = `Свойства «${level.type.name}»`;
    for (const def of level.props) {
      if (def.value_type !== 'text' && def.value_type !== 'url') continue;
      out.push({
        text: `$thought.[${def.key}]`,
        label: `$thought.[${def.key}] — ${def.value_type}`,
        section: sectionName,
      });
    }
  }
  return out;
}

function isListOp(op: StructurePropertyOp | null): boolean {
  return op === 'in' || op === 'not_in';
}

// ---------------------------------------------------------------------------
// Value combo — live-search candidate list (задача 27472616)
// ---------------------------------------------------------------------------

/** One candidate row of a token/value combo (общий редактор значения и
 *  общий чип-лист сущностей; см. `filter-dialog.ts`). */
export interface ComboOption {
  /** Text stored in the field when the row is picked (token or literal id). */
  value: string;
  /** Human-readable label shown in the dropdown. */
  label: string;
  /** Optional section header shown above the row (grouping, mirrors {@link ViewToken.section}). */
  section?: string;
  /** `true` — the row cannot be picked in the current operator (e.g. a
   *  list-only token offered for a scalar `eq` condition). */
  disabled?: boolean;
}

/** Converts a token list into combo options, baking in the existing
 *  `listOnly` vs `op` disable rule (mirrors the old `openTokenPicker` menu). */
export function tokensToComboOptions(
  tokens: ViewToken[],
  op: StructurePropertyOp | null,
): ComboOption[] {
  return tokens.map((t) => ({
    value: t.text,
    label: t.label,
    section: t.section,
    disabled: t.listOnly === true && !isListOp(op),
  }));
}

/**
 * Live-search filter: case-insensitive substring match against the label OR
 * the stored value (so typing part of `$today` or part of «сегодня» both
 * work). An empty/whitespace query returns every option unfiltered — the
 * dropdown then shows the full candidate list, grouped by section, exactly
 * like the old static menu did on open.
 */
export function filterComboOptions(options: ComboOption[], query: string): ComboOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return options;
  return options.filter(
    (o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle),
  );
}

function propertyMatches(
  defType: PropertyValueType,
  condType: PropertyValueType,
  defMultiple: boolean,
): boolean {
  if (defMultiple) return true;
  if (defType === condType) return true;
  if ((defType === 'text' || defType === 'url') && (condType === 'text' || condType === 'url')) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Длины имени/описания отбора
// ---------------------------------------------------------------------------

/** Length constants the dialog enforces on the name/description inputs.
 *  Re-exported here so the pure module can be tested in isolation (the
 *  dialog imports them and binds them to the inputs; tests assert the
 *  same numbers).
 */
export const VIEW_NAME_MAX = THOUGHT_TYPE_VIEW_NAME_MAX;
export const VIEW_DESCRIPTION_MAX = THOUGHT_TYPE_VIEW_DESCRIPTION_MAX;