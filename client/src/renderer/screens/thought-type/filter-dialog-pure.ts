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
  FilterAst,
  NetworkProperty,
  PropertyValueType,
  StructurePropertyOp,
  ThoughtType,
  ThoughtTypeView,
} from '@etn/shared';

import {
  THOUGHT_TYPE_VIEW_DESCRIPTION_MAX,
  THOUGHT_TYPE_VIEW_NAME_MAX,
} from '@etn/shared';

import {
  buildFilterAst,
  defaultFilterCriteriaState,
  defaultFilterTreeGroup,
  hasAnyFilterCriteria,
  parseFilterDefinitionTree,
  type FilterCriteriaState,
  type FilterTreeLeaf,
  type FilterTreeNode,
  type PropertyConditionState,
} from '../../lib/filter-builder.js';

// ---------------------------------------------------------------------------
// Состояние отбора и определение — единый конструктор `lib/filter-builder.ts`
// ---------------------------------------------------------------------------

/** Псевдонимы единой модели (публичный интерфейс модуля для тестов). */
export type DialogCriteriaState = FilterCriteriaState;
export type DialogPropertyCondition = PropertyConditionState;

export const defaultDialogCriteriaState = defaultFilterCriteriaState;

/**
 * Служебный дефолт места «отбор типа мысли», унаследованный от плоской формы:
 * помеченные на удаление скрыты, пока пользователь не включил их сам. В плоском
 * `definition v1` он выражался ОТСУТСТВИЕМ поля `trashed` и разворачивался
 * сервером при чтении; в AST-определении неявных дефолтов нет — поэтому лист
 * `Корзина равно нет` впекается в определение ЯВНО при сохранении (иначе отбор
 * типа начал бы показывать помеченные на удаление). См. {@link stripViewDefaults}
 * и {@link withViewDefaults}.
 */
function trashedDefaultLeaf(): FilterTreeLeaf {
  return { kind: 'leaf', entity: { kind: 'trashed' }, operator: 'eq', value: { kind: 'scalar', value: false } };
}

/** Лист ровно служебного дефолта «Корзина равно нет» ({@link trashedDefaultLeaf}). */
function isTrashedDefaultLeaf(node: FilterTreeNode): boolean {
  return (
    node.kind === 'leaf' &&
    node.entity.kind === 'trashed' &&
    node.operator === 'eq' &&
    node.value.kind === 'scalar' &&
    node.value.value === false &&
    node.mode === undefined
  );
}

/** Есть ли в дереве ЛЮБОЙ лист «Корзина» (пользователь сам решил про удалённые). */
function treeHasTrashedLeaf(node: FilterTreeNode): boolean {
  if (node.kind === 'group') return node.children.some(treeHasTrashedLeaf);
  return node.entity.kind === 'trashed';
}

/**
 * Снять с КОРНЕВОГО уровня служебный дефолт «Корзина равно нет»: в редакторе он
 * не показывается строкой-условием (это дефолт МЕСТА, а не условие пользователя).
 * Лист, вложенный в группу, не трогаем — он осмысленно собран пользователем.
 */
export function stripViewDefaults(tree: FilterTreeNode): FilterTreeNode {
  if (tree.kind !== 'group') return tree;
  return { ...tree, children: tree.children.filter((child) => !isTrashedDefaultLeaf(child)) };
}

/**
 * Обеспечить служебный дефолт места в дереве перед материализацией AST: если
 * листа «Корзина» в дереве нет вовсе — добавить `Корзина равно нет` на корневой
 * уровень. Пользовательский лист «Корзина» (любой) дефолт отменяет.
 */
export function withViewDefaults(tree: FilterTreeNode): FilterTreeNode {
  if (treeHasTrashedLeaf(tree)) return tree;
  const leaf = trashedDefaultLeaf();
  if (tree.kind === 'group') return { ...tree, children: [...tree.children, leaf] };
  return { kind: 'group', op: 'and', children: [tree, leaf] };
}

/**
 * Parses an existing view's JSON `definition` into the dialog state and
 * GUARANTEES a filled `tree`: AST-определение уже несёт дерево, старую плоскую
 * `definition v1` единый конструктор компилирует в дерево на входе
 * (`parseFilterDefinitionTree` → `compileFlatCriteriaToAst`, задача cfbe8c74;
 * ADR fc23f9c1 запрещает вторую точку чтения сохранённого отбора). Служебный
 * дефолт места («Корзина равно нет») с корневого уровня снимается
 * ({@link stripViewDefaults}) — он не показывается условием пользователя.
 * Returns the default state when the JSON is malformed.
 */
export function parseViewDefinition(
  view: ThoughtTypeView | null,
  registry?: ReadonlyMap<string, NetworkProperty>,
): FilterCriteriaState {
  const state =
    view === null
      ? defaultFilterCriteriaState()
      : parseViewDefinitionJson(view.definition, registry);
  state.tree = stripViewDefaults(state.tree ?? defaultFilterTreeGroup('and'));
  return state;
}

function parseViewDefinitionJson(
  definition: string,
  registry?: ReadonlyMap<string, NetworkProperty>,
): FilterCriteriaState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition) as unknown;
  } catch {
    return defaultFilterCriteriaState();
  }
  return parseFilterDefinitionTree(parsed, {
    activeMode: 'view',
    ...(registry !== undefined ? { registry } : {}),
  });
}

/**
 * AST отбора типа мысли из единой модели (форма 0.13.1, сущность 489c394f):
 * дерево + многоуровневая сортировка, плюс служебный дефолт места
 * ({@link withViewDefaults}). `strict` — отбор обязан быть принят исполнителем
 * профиля «мысли» (бросает `Error`); конвертер ОДИН — `buildFilterAst` единого
 * конструктора, второго нет (ADR 30ff83bb).
 */
export function buildViewAst(
  state: FilterCriteriaState,
  opts: { strict?: boolean } = {},
): FilterAst {
  const tree = withViewDefaults(state.tree ?? defaultFilterTreeGroup('and'));
  const model: FilterCriteriaState = { ...state, tree };
  return buildFilterAst(model, opts.strict === true ? { profile: 'thoughts', strict: true } : {});
}

/** AST для ЗАПИСИ отбора (проверенный профилем) — то, что уходит на сервер. */
export function buildViewAstDefinition(state: FilterCriteriaState): FilterAst {
  return buildViewAst(state, { strict: true });
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
 * Live-search filter: case-insensitive substring match against the label OR
 * the stored value (so typing part of `$today` or part of «сегодня» both
 * work). An empty/whitespace query returns every option unfiltered.
 */
export function filterTokenOptions<T extends { label: string; text: string }>(
  options: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return options;
  return options.filter(
    (o) => o.label.toLowerCase().includes(needle) || o.text.toLowerCase().includes(needle),
  );
}

/** Оператор со списком значений («в списке»/«не в списке»). */
function isListOp(op: StructurePropertyOp | null): boolean {
  return op === 'in' || op === 'not_in';
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