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
  isFilterAstWire,
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
 * «Помечено на удаление = нет» впекается в определение ЯВНО при сохранении (иначе отбор
 * типа начал бы показывать помеченные на удаление). См. {@link stripViewDefaults}
 * и {@link withViewDefaults}.
 */
function trashedDefaultLeaf(): FilterTreeLeaf {
  return { kind: 'leaf', entity: { kind: 'trashed' }, operator: 'eq', value: { kind: 'scalar', value: false } };
}

/** Лист ровно служебного дефолта «Помечено на удаление = нет» ({@link trashedDefaultLeaf}). */
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

/** Есть ли в дереве ЛЮБОЙ лист «Помечено на удаление» (пользователь сам решил про удалённые). */
function treeHasTrashedLeaf(node: FilterTreeNode): boolean {
  if (node.kind === 'group') return node.children.some(treeHasTrashedLeaf);
  return node.entity.kind === 'trashed';
}

/**
 * Снять с КОРНЕВОГО уровня служебный дефолт «Помечено на удаление = нет»: в редакторе он
 * не показывается строкой-условием (это дефолт МЕСТА, а не условие пользователя).
 * Лист, вложенный в группу, не трогаем — он осмысленно собран пользователем.
 */
export function stripViewDefaults(tree: FilterTreeNode): FilterTreeNode {
  if (tree.kind !== 'group') return tree;
  return { ...tree, children: tree.children.filter((child) => !isTrashedDefaultLeaf(child)) };
}

/**
 * Обеспечить служебный дефолт места в дереве перед материализацией AST: если
 * листа «Корзина» в дереве нет вовсе — добавить «Помечено на удаление = нет» на корневой
 * уровень. Пользовательский лист «Помечено на удаление» (любой) дефолт отменяет.
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
 * дефолт места («Помечено на удаление = нет») снимается только с ПЛОСКОГО
 * определения: в AST он записан явно и является условием пользователя —
 * скрывать его при переоткрытии нельзя (ошибка 9ddc488e).
 * Returns the default state when the JSON is malformed.
 */
export function parseViewDefinition(
  view: Pick<ThoughtTypeView, 'definition'> | null,
  registry?: ReadonlyMap<string, NetworkProperty>,
): FilterCriteriaState {
  if (view === null) {
    const fresh = defaultFilterCriteriaState();
    fresh.tree = stripViewDefaults(fresh.tree ?? defaultFilterTreeGroup('and'));
    return fresh;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(view.definition) as unknown;
  } catch {
    return defaultFilterCriteriaState();
  }
  const state = parseFilterDefinitionTree(parsed, {
    activeMode: 'view',
    ...(registry !== undefined ? { registry } : {}),
  });
  // Неявных дефолтов в AST нет: лист «Помечено на удаление», записанный в
  // определении, — условие ПОЛЬЗОВАТЕЛЯ (его видно строкой и он обязан
  // пережить переоткрытие — ошибка 9ddc488e). Снимаем служебный дефолт
  // только с плоского определения v1: там его дописал компилятор, и он
  // остаётся неявным до сохранения в AST (`readFilterDefinitionDetailed`).
  if (!isFilterAstWire(parsed)) {
    state.tree = stripViewDefaults(state.tree ?? defaultFilterTreeGroup('and'));
  }
  return state;
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

// ---------------------------------------------------------------------------
// Токены контекста — единый каталог `lib/filter-tokens.ts` (ошибка 50d9bf4e,
// пункты A3–A6). Здесь только реэкспорт публичного контракта диалога: сам набор
// (по природе операнда, со свойствами реестра сети, без дублей) живёт в общем
// модуле, потому что тот же набор нужен ячейке значения редактора.
// ---------------------------------------------------------------------------

export type { ViewToken } from '../../lib/filter-tokens.js';
export { buildTokensForField, filterTokenOptions } from '../../lib/filter-tokens.js';

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