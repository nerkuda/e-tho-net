/**
 * Панель отбора вида «Дневник» (L20, элемент интерфейса 9b424548) — на едином
 * редакторе отбора.
 *
 * Задача 608ecb79 «Пересборка панели „Дневника“ на дерево» (требование 0582f863
 * «Панель „Дневника“ пересобрана на единый редактор (профиль со временем)»,
 * ADR fc23f9c1 «судьба спец-секций», ADR a9336708). Образец — панель «Структур»
 * (задача 213bd2d2, коммит 34e29ab6).
 *
 * Условия держит дерево `FilterTreeNode` единой модели `FilterCriteriaState`,
 * вид строит общая фабрика `lib/filter-editor.ts` с профилем `chronicle`
 * («Дневниковые записи» — профиль СО ВРЕМЕНЕМ: доступны `$now`/`$hour*` и
 * единицы `h`/`mi`). Бывшие спец-поля — строки-условия:
 *
 *   • «Период» → строка «Период записи» с оператором «между» (в значении —
 *     даты или календарные токены; календарь месяца читает период из дерева
 *     через {@link chroniclePeriod});
 *   • «Цели» → строка «Цели записи» — список мыслей либо под-выборка мыслей
 *     (профиль `thoughts`), семантика «хотя бы одна цель удовлетворяет» (`in`);
 *   • «Ключевые слова» (двухпутевой поиск T7) → группа ИЛИ: текст записи
 *     («Текст записи»/«Заголовок записи» c «есть слова») ИЛИ мыслевый путь
 *     («Цели записи» → «Есть слова» с областями поиска). Решение
 *     оркестратора 2026-10-12;
 *   • автор/редактор записи — строки «Автор записи»/«Редактор записи».
 *
 * Живая строка поиска («Найденные записи» + переход к записи, debounce и
 * история ввода) остаётся ОТДЕЛЬНЫМ элементом панели над деревом (решение
 * оркестратора 2026-10-12): она пишет ту же группу ключевых слов в дерево и
 * потому по-прежнему фильтрует ленту.
 */

import {
  buildChronicleKeywordGroup,
  FILTER_AST_VERSION,
  type ChronicleFilterDefinition,
  type ChronicleRow,
  type FilterAstNode,
  type NetworkProperty,
  type StructureKeywordScope,
} from '@etn/shared';

import { requireNetworkId } from '../../app.js';
import { loadRecentValues, recordRecentValue } from '../../editor/recent-values.js';
import { confirmDialog, errorDialog, promptDialog } from '../../lib/dialog.js';
import { div, fmtDate } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { defineKeyContext, pushKeyContext } from '../../lib/keymap.js';
import {
  buildKeywordsSection,
  type FilterFormContext,
} from '../../lib/filter-form.js';
import {
  buildFilterAst,
  compileFlatCriteriaToAst,
  defaultFilterCriteriaState,
  defaultFilterTreeGroup,
  filterAstToTree,
  parseFilterAstState,
  parseFilterDefinition,
  withReverseLinkPropertySides,
  type FilterCriteriaState,
  type FilterTreeGroup,
  type FilterTreeLeaf,
  type FilterTreeNode,
  type FilterTreeValue,
} from '../../lib/filter-builder.js';
import {
  filterIssuesFromError,
  filterIssuesFromPayload,
  type FilterIssue,
} from '../../lib/filter-diagnostics.js';
import { canonicalFilterTree } from '../../lib/filter-canonical.js';
import { buildFilterEditor, type FilterEditorHandle } from '../../lib/filter-editor.js';
import type { FilterFooterButtonSpec } from '../../lib/filter-footer.js';
import { matchesKeyPrefix, onQueryInvalidated, queryKeys } from '../../lib/live/index.js';
import { notice } from '../../lib/notice.js';
import {
  predefinedFilterIds,
  predefinedFiltersToCreate,
  type PredefinedFilter,
} from '../../lib/predefined-filters.js';
import { duplicateFilterName } from '../../lib/pure.js';
import { openSavedFilterDialog } from '../../lib/saved-filter-bar.js';
import { segmentedControl } from '../../lib/ui/segmented.js';
import type { SuggestEntry, SuggestSource } from '../../lib/suggest-dropdown.js';
import { store } from '../../state.js';
import {
  SEARCH_DEBOUNCE_MS,
  resolvePeriodForQuery,
} from './diary.js';
import { isFeedRecordEditorTarget } from './feed-nav.js';

/** Профиль контекста места: «Дневниковые записи» (со временем). */
export const FILTER_PROFILE = 'chronicle' as const;

/** Модель отбора панели — та же единая модель конструктора (дерево + порядок). */
export type ChronicleFilterState = FilterCriteriaState;
/** Короткое имя модели внутри модуля. */
type FilterState = ChronicleFilterState;

export type { ChronicleCriteriaState as ChronicleFilterStateLegacy } from '../../lib/filter-builder.js';

/** Ключ истории ввода строки поиска «Дневника» (общий механизм recent-values). */
const KEYWORDS_HISTORY_KEY = 'diary.keywords';

/** Дополнения сборки панели. */
interface PanelOptions {
  /** Узлы над секциями (календарь месяца — первый элемент панели). */
  header?: readonly HTMLElement[];
}

/** Actions the panel delegates to the host module. */
interface PanelActions {
  /** «Применить» pressed (or Ctrl+Enter) — run the query. */
  apply: () => void;
  /** Переход к найденной записи (строка поиска выбрала запись). */
  jumpToRecord?: (row: ChronicleRow) => void;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let filter: FilterState = defaultState();
let panel: HTMLElement | null = null;
let actions: PanelActions = { apply: () => undefined };
let editor: FilterEditorHandle | null = null;
/** Ref of the selected saved filter (null — not saved yet / custom). */
let savedFilterId: string | null = null;
/** Имя отбора в поле футера — переживает перерисовку панели. */
let filterName = '';
let savedFilterName: string | null = null;
/** Снимок определения на момент сохранения (маркер ● футера). */
let savedDefinition: unknown = null;
/** Записи диагностики от сервера (ошибка выборки). */
let serverIssues: readonly FilterIssue[] = [];
/** Узлы-заголовки панели (календарь) — переносятся при каждой перерисовке. */
let headerNodes: readonly HTMLElement[] = [];
/** Реестр свойств сети (условия под-выборки целей), один REST-вызов на открытие. */
const propertyDefs = new Map<string, NetworkProperty>();
/** Список сохранённых отборов панели (кэш диалога выбора). */
let savedRows: SavedFilterRow[] = [];
/** Слой (G6) подписан на инвалидации списка отборов — один раз. */
let savedFiltersWired = false;
/** Признак: панель уже смонтирована (перерисовка допустима). */
let mounted = false;

interface SavedFilterRow {
  id: string;
  name: string;
  definition: unknown;
  /** Условия строки совпали с предопределённым набором (метка в списке). */
  predefined?: boolean;
}

function defaultState(): FilterState {
  return { ...defaultFilterCriteriaState(), tree: defaultFilterTreeGroup('and'), sortKeys: [] };
}

// Операнды профиля `chronicle` (реестр `shared/src/filter-profiles.ts`).
const OP_TIME = 'record_time';
const OP_TARGETS = 'targets';
const OP_TITLE = 'record_title';
const OP_BODY = 'record_body';
const OP_AUTHOR = 'record_author';
const OP_EDITOR = 'record_editor';

// ---------------------------------------------------------------------------
// Дерево: сборка листьев и обход
// ---------------------------------------------------------------------------

function leaf(
  kind: string,
  operator: FilterTreeLeaf['operator'],
  value: FilterTreeValue,
): FilterTreeLeaf {
  return { kind: 'leaf', entity: { kind } as FilterTreeLeaf['entity'], operator, value };
}

/** Все листья дерева (в порядке обхода). */
function allLeaves(node: FilterTreeNode | null | undefined, out: FilterTreeLeaf[] = []): FilterTreeLeaf[] {
  if (node === null || node === undefined) return out;
  if (node.kind === 'leaf') {
    out.push(node);
    return out;
  }
  for (const child of node.children) allLeaves(child, out);
  return out;
}

/** Текстовое представление элемента значения-списка (литерал или токен). */
function itemText(item: string | { token: string } | number | boolean): string {
  if (typeof item === 'object') return item.token;
  return String(item);
}

/** Корень дерева с гарантированной группой `И`. */
function rootGroup(state: FilterState = filter): FilterTreeGroup {
  const tree = state.tree ?? null;
  if (tree !== null && tree.kind === 'group') return tree;
  const fresh: FilterTreeGroup = { kind: 'group', op: 'and', children: tree === null ? [] : [tree] };
  state.tree = fresh;
  return fresh;
}

// ---------------------------------------------------------------------------
// Период: чтение/запись из строки «Период записи» (календарь и хост)
// ---------------------------------------------------------------------------

/**
 * Границы периода, как их видит панель: из строки «Период записи» дерева.
 * «Между» даёт обе границы; одиночные `gte`/`lte` — по одной. Токены отдаются
 * как есть (раскрытие — в {@link chronicleQueryDefinition}).
 */
export function chroniclePeriod(state: FilterState = filter): { from: string; to: string } {
  const leaves = allLeaves(state.tree ?? null);
  const between = leaves.find(
    (l) =>
      l.entity.kind === OP_TIME &&
      (l.operator === 'between' || l.operator === 'not_between') &&
      l.value.kind === 'list',
  );
  if (between !== undefined && between.value.kind === 'list') {
    const items = between.value.items;
    return {
      from: items[0] === undefined ? '' : itemText(items[0]),
      to: items[1] === undefined ? '' : itemText(items[1]),
    };
  }
  const lower = leaves.find(
    (l) => l.entity.kind === OP_TIME && (l.operator === 'gte' || l.operator === 'gt'),
  );
  const upper = leaves.find(
    (l) => l.entity.kind === OP_TIME && (l.operator === 'lte' || l.operator === 'lt'),
  );
  return {
    from: lower === undefined ? '' : valueText(lower.value),
    to: upper === undefined ? '' : valueText(upper.value),
  };
}

/** Текст скалярного/токенного значения листа (`''` — значение пустое). */
function valueText(value: FilterTreeValue): string {
  if (value.kind === 'scalar') return String(value.value);
  if (value.kind === 'token') return value.token;
  if (value.kind === 'list' && value.items[0] !== undefined) return itemText(value.items[0]);
  return '';
}

/**
 * Записать период в строку «Период записи» (календарь, диалог даты, сброс).
 * Существующие строки времени заменяются; пустые границы — условие снимается.
 */
export function setChroniclePeriod(from: string, to: string): void {
  filter = applyChroniclePeriod(filter, from, to);
  renderPanel();
}

/** Чистая правка модели: заменить условие времени на указанный период. */
export function applyChroniclePeriod(
  state: FilterState,
  from: string,
  to: string,
): FilterState {
  const root = rootGroup(state);
  const kept = root.children.filter(
    (child) => child.kind !== 'leaf' || child.entity.kind !== OP_TIME,
  );
  const next = [...kept];
  const f = from.trim();
  const t = to.trim();
  if (f !== '' && t !== '') next.push(leaf(OP_TIME, 'between', { kind: 'list', items: [f, t] }));
  else if (f !== '') next.push(leaf(OP_TIME, 'gte', { kind: 'scalar', value: f }));
  else if (t !== '') next.push(leaf(OP_TIME, 'lte', { kind: 'scalar', value: t }));
  return { ...state, tree: { kind: 'group', op: root.op, children: next } };
}

// ---------------------------------------------------------------------------
// Ключевые слова: двухпутевая группа (решение оркестратора 2026-10-12)
// ---------------------------------------------------------------------------

/** Область мыслевого пути (checkbox-и строки поиска). */
interface KeywordSlice {
  keywords: string;
  keywordInTitle: boolean;
  keywordInSynonyms: boolean;
  keywordInComment: boolean;
}

/** Срез состояния для общего поля ключевых слов (живая строка поиска). */
let keywordSlice: KeywordSlice = { keywords: '', keywordInTitle: true, keywordInSynonyms: true, keywordInComment: true };

/**
 * Группа ключевых слов дерева (маркер структуры: ИЛИ пути А и пути Б). Обход
 * РЕКУРСИВНЫЙ: путь Б — это пословные группы `ИЛИ(тело, заголовок)`, вложенные
 * в `И` вместе с `цели не пусты`.
 */
function isKeywordGroup(node: FilterTreeNode): boolean {
  if (node.kind !== 'group' || node.op !== 'or') return false;
  return allLeaves(node).some(isKeywordGroupLeaf);
}

/** Лист-признак группы ключевых слов (слово пути Б либо путь А / «цели не пусты»). */
function isKeywordGroupLeaf(leaf: FilterTreeLeaf): boolean {
  if (leaf.entity.kind === OP_BODY || leaf.entity.kind === OP_TITLE) return true;
  if (leaf.entity.kind !== OP_TARGETS) return false;
  if (leaf.operator === 'not_empty') return true;
  return (
    leaf.value.kind === 'subquery' &&
    allLeaves(leaf.value.node).some((inner) => inner.entity.kind === 'keywords')
  );
}

/** Области поиска мыслевого пути → плоский список (пусто — все три). */
function scopeIds(slice: KeywordSlice): Array<'title' | 'synonyms' | 'comment'> {
  const out: Array<'title' | 'synonyms' | 'comment'> = [];
  if (slice.keywordInTitle) out.push('title');
  if (slice.keywordInSynonyms) out.push('synonyms');
  if (slice.keywordInComment) out.push('comment');
  return out;
}

/**
 * Группа ключевых слов «оба пути ИЛИ». Критерий собирает ОБЩИЙ конструктор
 * `@etn/shared` (`buildChronicleKeywordGroup`) — ровно тот же, что проверяет
 * серверный тест паритета. Путь Б гейтится областью `comment` (пустой набор —
 * все области) и на каждое слово строит `ИЛИ(тело, заголовок)`; путь А —
 * под-выборка целей с «Есть слова» в отмеченных областях.
 */
function keywordGroup(text: string, scope: readonly string[]): FilterTreeGroup {
  const group = filterAstToTree(
    buildChronicleKeywordGroup(text, scope as readonly StructureKeywordScope[]),
  );
  return group !== null && group.kind === 'group'
    ? group
    : { kind: 'group', op: 'or', children: [] };
}

/** Записать срез ключевых слов в дерево (управляемая группа в корне). */
function syncKeywordsToTree(): void {
  const root = rootGroup();
  const kept = root.children.filter((child) => !isKeywordGroup(child));
  const text = keywordSlice.keywords.trim();
  const next = text === '' ? kept : [...kept, keywordGroup(text, scopeIds(keywordSlice))];
  filter = { ...filter, tree: { kind: 'group', op: root.op, children: next } };
}

/** Прочитать срез ключевых слов из дерева (открытие панели, смена отбора). */
function syncKeywordsFromTree(): void {
  const root = filter.tree;
  const group =
    root !== undefined && root !== null && root.kind === 'group'
      ? root.children.find(isKeywordGroup)
      : undefined;
  if (group === undefined) return;
  const parsed = readKeywordSlice(group);
  if (parsed === null) return;
  // Пустой набор областей — «все области» (поведение до 0.10.1): галочки все.
  const scope =
    parsed.scope.length > 0 ? parsed.scope : (['title', 'synonyms', 'comment'] as const);
  keywordSlice = {
    keywords: parsed.keywords,
    keywordInTitle: scope.includes('title'),
    keywordInSynonyms: scope.includes('synonyms'),
    keywordInComment: scope.includes('comment'),
  };
}

/**
 * Текст и области ключевых слов из группы дерева. Источник — лист «Есть слова»
 * пути А (несёт и текст мини-синтаксиса, и области); без пути А (одни
 * исключающие слова) слова восстанавливаются из пути Б. `null` — слов нет.
 */
function readKeywordSlice(
  group: FilterTreeNode,
): { keywords: string; scope: string[] } | null {
  let keywords: string | null = null;
  let scope: StructureKeywordScope[] | null = null;
  const include: string[] = [];
  const exclude: string[] = [];
  const walk = (node: FilterTreeNode, negated: boolean): void => {
    if (node.kind === 'group') {
      const nextNegated = node.op === 'not' ? !negated : negated;
      for (const child of node.children) walk(child, nextNegated);
      return;
    }
    if (node.operator !== 'matches') return;
    const text = valueText(node.value);
    if (text === '') return;
    if (node.entity.kind === 'keywords') {
      keywords = text;
      if (Array.isArray(node.entity.scope)) scope = [...node.entity.scope];
      return;
    }
    if (node.entity.kind === OP_BODY || node.entity.kind === OP_TITLE) {
      if (negated) exclude.push(text);
      else include.push(text);
    }
  };
  walk(group, false);
  if (keywords === null && include.length === 0 && exclude.length === 0) return null;
  return {
    keywords: keywords ?? [...include, ...exclude.map((word) => `-${word}`)].join(' '),
    scope: scope ?? [],
  };
}

// ---------------------------------------------------------------------------
// Чтение определения отбора (L4-снимок и сохранённые отборы v1)
// ---------------------------------------------------------------------------

/**
 * Прочитать определение отбора «Дневника» в модель панели. Формы:
 *   • AST (`{ version, filter }`) — единый читатель `parseFilterAstState`;
 *   • плоское `definition v1` (`ChronicleFilterDefinition`) — компилируется в
 *     строки дерева по структуре серверного компилятора: период → «Время
 *     записи», `targets` → список/под-выборка «Цели записи» (единый конвертер
 *     мыслей `compileFlatCriteriaToAst`), `created_by`/`updated_by` →
 *     «Автор/Редактор записи», `keywords` → двухпутевая группа.
 */
export function readFilterDefinition(def: unknown): FilterState {
  const next = defaultState();
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return next;
  const rec = def as Record<string, unknown>;
  // Форма СОБСТВЕННОЙ записи панели — `{ ast, order }` (см. {@link chronicleDefinition}):
  // AST-тело вложено в поле `ast`, а не лежит на верхнем уровне. Читаем ОБЕ
  // формы одним ридером AST; иначе сохранённый/восстановленный из L4 отбор
  // «Дневника» открывался пустым — условие терялось на чтении (дефект, найден
  // при задаче a6609741: метод диагностики панели не получал строк).
  const nestedAst = rec['ast'];
  const astBody =
    typeof rec['version'] === 'number'
      ? rec
      : typeof nestedAst === 'object' && nestedAst !== null && !Array.isArray(nestedAst)
        ? (nestedAst as Record<string, unknown>)
        : null;
  if (astBody !== null && typeof astBody['version'] === 'number') {
    const parsed = parseFilterAstState(astBody, {});
    const order = rec['order'] === 'desc' ? 'desc' : 'asc';
    return { ...next, ...parsed, tree: parsed.tree ?? defaultFilterTreeGroup('and'), order };
  }
  const children: FilterTreeNode[] = [];
  const from = str(rec['date_from']);
  const to = str(rec['date_to']);
  if (from !== '' && to !== '') children.push(leaf(OP_TIME, 'between', { kind: 'list', items: [from, to] }));
  else if (from !== '') children.push(leaf(OP_TIME, 'gte', { kind: 'scalar', value: from }));
  else if (to !== '') children.push(leaf(OP_TIME, 'lte', { kind: 'scalar', value: to }));

  const author = authorLeaf(OP_AUTHOR, rec, 'created_by');
  if (author !== null) children.push(author);
  const edit = authorLeaf(OP_EDITOR, rec, 'updated_by');
  if (edit !== null) children.push(edit);

  const targets = rec['targets'];
  if (targets !== undefined && targets !== null) {
    const ast = compileFlatCriteriaToAst(
      parseFilterDefinition(targets),
      registryWithSides(),
      { activeMode: 'structures' },
    );
    if (ast !== undefined) {
      children.push(
        leaf(OP_TARGETS, 'in', {
          kind: 'subquery',
          operator: 'in',
          node: astNodeToTree(ast.filter),
        }),
      );
    }
  }

  const keywords = str(rec['keywords']);
  if (keywords !== '') {
    const scope = Array.isArray(rec['keyword_scope'])
      ? (rec['keyword_scope'] as string[]).filter((s) => typeof s === 'string')
      : ['title', 'synonyms', 'comment'];
    children.push(keywordGroup(keywords, scope));
  }

  const order = rec['order'];
  return {
    ...next,
    tree: { kind: 'group', op: 'and', children },
    order: order === 'desc' ? 'desc' : 'asc',
  };
}

/** Лист авторства записи из плоских полей `created_by`/`updated_by`. */
function authorLeaf(
  kind: string,
  rec: Record<string, unknown>,
  field: 'created_by' | 'updated_by',
): FilterTreeLeaf | null {
  const op = rec[`${field}_op`];
  if (op === 'empty' || op === 'not_empty') {
    return leaf(kind, op === 'empty' ? 'is_empty' : 'not_empty', { kind: 'none' });
  }
  const value = rec[field];
  if (typeof value === 'string' && value !== '') return leaf(kind, 'eq', { kind: 'scalar', value });
  if (Array.isArray(value)) {
    const ids = value.filter((v): v is string => typeof v === 'string');
    if (ids.length > 0) {
      return leaf(kind, op === 'not_in' ? 'not_in' : 'in', { kind: 'list', items: ids });
    }
  }
  return null;
}

/** Узел AST → узел дерева (для под-выборки целей). */
function astNodeToTree(node: FilterAstNode): FilterTreeNode {
  if ('children' in node) {
    return {
      kind: 'group',
      op: node.op,
      children: node.children.map(astNodeToTree),
    };
  }
  const parsed = parseFilterAstState({ version: 1, filter: node }, {});
  return parsed.tree ?? defaultFilterTreeGroup('and');
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// ---------------------------------------------------------------------------
// Публичный API панели (хост экрана)
// ---------------------------------------------------------------------------

/** Returns the current filter state. */
export function getFilterState(): FilterState {
  return filter;
}

/** Replaces the filter state and repaints the panel (L4 restore / saved filter). */
export function setFilterState(next: FilterState): void {
  filter = { ...defaultState(), ...next, tree: next.tree ?? defaultFilterTreeGroup('and') };
  syncKeywordsFromTree();
  renderPanel();
}

/** Marks which saved filter is selected (null = custom, not saved). */
export function setSavedFilterId(id: string | null): void {
  savedFilterId = id;
}

/** The id of the currently selected saved filter. */
export function getSavedFilterId(): string | null {
  return savedFilterId;
}

/** Серверная диагностика последнего отбора — строки редактора. */
export function setFilterServerIssues(issues: readonly FilterIssue[]): void {
  serverIssues = issues;
  editor?.refresh();
}

/** Записи диагностики из ошибки запроса (красное ядро). */
export function filterIssuesFromQueryError(err: unknown): readonly FilterIssue[] {
  return filterIssuesFromError(err);
}

/**
 * Записи диагностики из УСПЕШНОЙ выборки: `warnings` конверта `meta`
 * (требование 325efc13). Единый путь со «Структурами» — редактор подсвечивает
 * адресованные строки, жёлтое применение не запрещает.
 */
export function filterIssuesFromQueryResult(payload: {
  warnings?: unknown;
}): readonly FilterIssue[] {
  return filterIssuesFromPayload(payload as Parameters<typeof filterIssuesFromPayload>[0]);
}

/** Adds a parent thought to the goals criteria (external drop / picker). */
export function addThoughtToFilter(id: string): void {
  const root = rootGroup();
  const goals = root.children.find(
    (child): child is FilterTreeLeaf =>
      child.kind === 'leaf' && child.entity.kind === OP_TARGETS && child.value.kind === 'subquery',
  );
  if (goals !== undefined && goals.value.kind === 'subquery') {
    const node = goals.value.node;
    if (node.kind === 'group') {
      if (node.children.some((c) => c.kind === 'leaf' && c.entity.kind === 'parents' && c.value.kind === 'list' && c.value.items.includes(id))) {
        return;
      }
      node.children = [
        ...node.children,
        { kind: 'leaf', entity: { kind: 'parents' } as FilterTreeLeaf['entity'], operator: 'in_hierarchy', mode: 'all_links', value: { kind: 'list', items: [id] } },
      ];
    }
  } else {
    root.children = [
      ...root.children,
      leaf(OP_TARGETS, 'in', {
        kind: 'subquery',
        operator: 'in',
        node: {
          kind: 'group',
          op: 'and',
          children: [
            { kind: 'leaf', entity: { kind: 'parents' } as FilterTreeLeaf['entity'], operator: 'in_hierarchy', mode: 'all_links', value: { kind: 'list', items: [id] } },
          ],
        },
      }),
    ];
  }
  filter = { ...filter, tree: root };
  renderPanel();
}

/** Reloads the saved-filter list (real-time `saved-filter.*`). */
export async function reloadSavedFilters(): Promise<void> {
  await reloadSavedRows();
}

/** Очищает критерии панели (порядок сохраняется). */
export function clearFilter(): void {
  const order = filter.order;
  // Период записи — НЕУДАЛЯЕМОЕ условие панели (ошибка 609deba0 п.2): «Очистить»
  // снимает остальные критерии, но границы периода, которыми управляет
  // календарь, сохраняет.
  const { from, to } = chroniclePeriod();
  filter = applyChroniclePeriod({ ...defaultState(), order }, from, to);
  keywordSlice = { keywords: '', keywordInTitle: true, keywordInSynonyms: true, keywordInComment: true };
  savedFilterId = null;
  filterName = '';
  savedFilterName = null;
  savedDefinition = null;
  serverIssues = [];
  renderPanel();
}

/**
 * Wire-определение текущего отбора (с реестром — условия под-выборки целей без
 * него потерялись бы). Единственная точка конвертации для персиста/сохранения:
 * AST-форма; прежние плоские определения читает тот же конвертер.
 */
export function chronicleDefinition(): ChronicleFilterDefinition {
  return {
    ast: buildFilterAst(filter, { profile: FILTER_PROFILE }),
    order: filter.order,
  } as ChronicleFilterDefinition;
}

/**
 * Определение отбора с ЗАМЕНЁННЫМ периодом — для запросов, которым нужны свои
 * границы времени (счётчики календаря по месяцу): границы подменяются В ДЕРЕВЕ,
 * а не плоскими полями (тело-дерево и плоские критерии вместе сервер отвергает).
 */
export function chronicleDefinitionForPeriod(
  from: string,
  to: string,
): ChronicleFilterDefinition {
  const ast = buildFilterAst(applyChroniclePeriod(filter, from, to), { profile: FILTER_PROFILE });
  return { ast, order: filter.order } as ChronicleFilterDefinition;
}

/**
 * Определение отбора для ЗАПРОСА ленты: как {@link chronicleDefinition}, но
 * границы периода-токены раскрыты в ЛОКАЛЬНЫЕ календарные даты наблюдателя
 * (`resolvePeriodForQuery`, требование 469d8d69) — результат выборки согласован
 * с локальным днём принадлежности записи и с подсветкой календаря. Полные
 * инстансы (переход к записи) проходят как есть.
 */
export function chronicleQueryDefinition(): ChronicleFilterDefinition {
  const { from, to } = chroniclePeriod();
  const resolved = resolvePeriodForQuery(from, to);
  return chronicleDefinitionForPeriod(resolved.from, resolved.to);
}

/** REST-хранилище отборов вида «Дневник» (`/saved-filters?view=chronicle`). */
async function reloadSavedRows(): Promise<void> {
  try {
    savedRows = (await etn.chronicleFilters.list(requireNetworkId())).map((f) => ({
      id: f.id,
      name: f.name,
      definition: f.definition,
    }));
  } catch {
    savedRows = [];
  }
}

// ---------------------------------------------------------------------------
// Предопределённые наборы (задача 347b307e, решения арбитража 2026-10-14)
// ---------------------------------------------------------------------------

/** Условия набора одним корнем-группой `И` в форме записи панели (`{ ast, order }`). */
function presetChronicle(children: FilterAstNode[]): ChronicleFilterDefinition {
  return {
    ast: { version: FILTER_AST_VERSION, filter: { op: 'and', children } },
    order: 'asc',
  } as ChronicleFilterDefinition;
}

/**
 * Предопределённые наборы отбора панели «Дневника» — формулировки заказчика
 * ДОСЛОВНО. Решения арбитража 2026-10-14: «Дата создания записи» в терминах
 * пользователя — «Период записи» (`record_time`); новый операнд `created_at` НЕ
 * заводится. «Автор записи = текущий пользователь» — значение-токен `$user`
 * (резолв — `chronicle-service`, иначе условие молча терялось).
 */
export const PREDEFINED_FILTERS: readonly PredefinedFilter[] = [
  {
    name: 'Мои записи за неделю',
    definition: presetChronicle([
      {
        entity: { kind: 'record_time' },
        operator: 'between',
        value: [{ token: '$weekStart' }, { token: '$weekEnd' }],
      },
      { entity: { kind: 'record_author' }, operator: 'eq', value: { token: '$user' } },
    ]),
  },
  {
    name: 'Записи за 30 дней',
    definition: presetChronicle([
      {
        entity: { kind: 'record_time' },
        operator: 'between',
        value: [{ token: '$today-30d' }, { token: '$today' }],
      },
    ]),
  },
];

/**
 * Каноничная форма условий определения отбора «Дневника» — сопоставление
 * предопределённых наборов «по условиям» (арбитраж 2026-10-14). Определение
 * приводит к дереву РИДЕР ПАНЕЛИ ({@link readFilterDefinition}), поэтому
 * легаси-плоский отбор сравнивается наравне с AST.
 */
export function canonicalDefinition(def: unknown): string {
  return canonicalFilterTree(readFilterDefinition(def).tree);
}

/**
 * Досоздать отсутствующие предопределённые наборы (при открытии списка отборов).
 * Сопоставление — по каноничным условиям, конфликт имени даёт свободное имя
 * (`duplicateFilterName`). Ошибка REST набор не теряет — досоздастся при
 * следующем открытии.
 */
async function seedPredefinedFilters(): Promise<void> {
  const toCreate = predefinedFiltersToCreate(PREDEFINED_FILTERS, savedRows, canonicalDefinition);
  if (toCreate.length === 0) {
    markPredefinedRows();
    return;
  }
  for (const item of toCreate) {
    try {
      await etn.chronicleFilters.create(requireNetworkId(), {
        name: item.name,
        definition: item.definition as ChronicleFilterDefinition,
      });
    } catch {
      // набор досоздастся при следующем открытии списка
    }
  }
  await reloadSavedRows();
  markPredefinedRows();
}

/** Пометить строки, условия которых совпали с предопределённым набором. */
function markPredefinedRows(): void {
  const ids = predefinedFilterIds(PREDEFINED_FILTERS, savedRows, canonicalDefinition);
  for (const row of savedRows) row.predefined = ids.has(row.id);
}

// ---------------------------------------------------------------------------
// Реестр свойств
// ---------------------------------------------------------------------------

function registryWithSides(): Map<string, NetworkProperty> {
  return withReverseLinkPropertySides(propertyDefs, store.state.linkTypes);
}

async function loadPropertyDefs(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    const rows = await etn.propertyRegistry.list(networkId);
    propertyDefs.clear();
    for (const row of rows) propertyDefs.set(row.id, row);
  } catch {
    // Сеть недоступна — панель работает с пустым реестром.
  }
}

/** Реестр нужен конвертеру определения — хост зовёт перед разбором снимка. */
export async function preloadFilterRegistry(): Promise<void> {
  await loadPropertyDefs();
}

// ---------------------------------------------------------------------------
// Живая строка поиска (T7) — элемент панели, пишет ключевые слова в дерево
// ---------------------------------------------------------------------------

/** Найденные записи строки поиска по id (для перехода при выборе строки). */
const recordHits = new Map<string, ChronicleRow>();
let searchTimer: number | null = null;

/** Пауза после ввода: не каждое нажатие запускает запрос (0.10.1, T7). */
function scheduleSearchApply(): void {
  if (searchTimer !== null) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    searchTimer = null;
    actions.apply();
  }, SEARCH_DEBOUNCE_MS);
}

/** Живой поиск записей по телам и заголовкам (период не применяется — иначе
 *  не найти запись вне текущего периода, а её и открывает переход). */
async function searchRecordOptions(query: string): Promise<SuggestEntry[]> {
  const needle = query.trim();
  if (needle === '') return [];
  try {
    const result = await etn.chronicle.query(requireNetworkId(), {
      keywords: needle,
      order: 'desc',
      limit: 10,
      offset: 0,
    });
    const out: SuggestEntry[] = [];
    for (const row of result.rows) {
      recordHits.set(row.id, row);
      out.push({
        value: row.id,
        label: `${fmtDate(row.valid_from)} — ${row.title ?? 'Запись'}`,
        recordId: row.id,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function recordSearchSource(): SuggestSource {
  return { when: 'typed', header: 'Найденные записи', load: (query) => searchRecordOptions(query) };
}

/** Контекст общего поля ключевых слов: пишет срез и держит debounce. */
function keywordsContext(): FilterFormContext {
  return {
    networkId: requireNetworkId(),
    getState: () => keywordSlice as unknown as FilterCriteriaState,
    registry: registryWithSides(),
    touch: () => {
      syncKeywordsToTree();
      renderPanel();
      scheduleSearchApply();
    },
  };
}

/** Живая строка поиска над деревом: поле слов + три области мыслевого пути. */
function buildSearchRow(): HTMLElement {
  const section = buildKeywordsSection(keywordsContext(), {
    title: 'Поиск по записям',
    placeholder: 'счет* -вод*',
    showScope: true,
    tooltip:
      'Слова через пробел, все обязательны; * — любые символы; -слово — исключение. ' +
      'Условие ищет запись двумя путями (ИЛИ): по телу и заголовку самой записи и по ' +
      'мыслям-целям в выбранных областях. Подсказка «Найденные записи» открывает ' +
      'запись переходом (период из записи, прокрутка и подсветка).',
    suggestSource: {
      when: 'always',
      load: () =>
        loadRecentValues(requireNetworkId(), KEYWORDS_HISTORY_KEY).map((value) => ({
          value,
          label: value,
        })),
    },
    extraSources: [recordSearchSource()],
    onPickEntry: (entry) => {
      if (entry.recordId === undefined) return false;
      const row = recordHits.get(entry.recordId);
      if (row !== undefined) actions.jumpToRecord?.(row);
      return true;
    },
    onBlur: (value) => {
      const trimmed = value.trim();
      if (trimmed === '') return;
      try {
        recordRecentValue(requireNetworkId(), KEYWORDS_HISTORY_KEY, trimmed);
      } catch {
        // нет сети — история не критична
      }
    },
  });
  section.refresh();
  return section.box;
}

// ---------------------------------------------------------------------------
// Сборка панели
// ---------------------------------------------------------------------------

/** Builds and mounts the filter panel into `host`; returns the root element. */
export function mountChronicleFilterPanel(
  host: HTMLElement,
  panelActions: PanelActions,
  opts: PanelOptions = {},
): HTMLElement {
  actions = panelActions;
  headerNodes = opts.header ?? [];
  mounted = true;
  host.replaceChildren();
  panel = host;
  renderPanel();
  wireSavedFiltersToLayer();
  void reloadSavedFilters();
  // Реестр свойств нужен конвертеру и под-выборке целей — перерисовка, когда он есть.
  void loadPropertyDefs().then(() => renderPanel());
  return panel;
}

/** Слой (G6): `saved-filter.*` гасит ключ — панель перечитывает список сама. */
function wireSavedFiltersToLayer(): void {
  if (savedFiltersWired) return;
  savedFiltersWired = true;
  onQueryInvalidated((prefix) => {
    if (matchesKeyPrefix(prefix, queryKeys.savedFiltersAll())) void reloadSavedRows();
  });
}

/** Элемент направления сортировки ленты (ключ один — направление одно). */
function orderControl(): HTMLElement {
  const seg = segmentedControl({
    items: [
      { id: 'asc', label: 'Сначала старые' },
      { id: 'desc', label: 'Сначала новые' },
    ],
    activeId: filter.order,
    ariaLabel: 'Направление сортировки',
    onChange: (id) => {
      filter = { ...filter, order: id === 'desc' ? 'desc' : 'asc' };
    },
  });
  seg.root.dataset['role'] = 'chronicle-order';
  return seg.root;
}

/** Собирает и перерисовывает панель из текущего состояния. */
function renderPanel(): void {
  if (!mounted || panel === null) return;
  panel.replaceChildren();
  panel.classList.add('chron-filter');

  for (const node of headerNodes) panel.append(node);
  panel.append(buildSearchRow());

  const orderWrap = div('chron-order-row');
  orderWrap.append(orderControl());

  editor = buildFilterEditor({
    profile: FILTER_PROFILE,
    networkId: requireNetworkId(),
    data: {
      registry: registryWithSides(),
      linkTypes: store.state.linkTypes,
      thoughtTypes: store.state.thoughtTypes,
      contextual: [OP_TIME, OP_TARGETS, OP_BODY, OP_TITLE, OP_AUTHOR, OP_EDITOR],
    },
    getState: () => filter,
    setSortKeys: () => {
      /* многоуровневой сортировки у ленты нет — порядок задаёт направление */
    },
    touch: () => {
      serverIssues = [];
      editor?.refresh();
    },
    sort: false,
    // Переключатель направления — НАД фразой-превью (ошибка 609deba0 п.3):
    // отдаём его фабрике слотом непрокручиваемого низа редактора.
    aboveFooter: orderWrap,
    // «Период записи» — неудаляемое условие (ошибка 609deba0 п.2): границами
    // управляет календарь, крестик строки не рисуется; «Очистить» его сохраняет.
    isLeafLocked: (leaf) => leaf.entity.kind === OP_TIME,
    host: {
      apply: () => actions.apply(),
      save: (request) => void saveFilter(request),
      reset: () => clearFilter(),
      getName: () => filterName,
      setName: (name) => {
        filterName = name;
      },
      savedName: () => savedFilterName,
      baseline: () => savedDefinition,
      current: () => chronicleDefinition(),
      issues: () => serverIssues,
    },
    buttons: { extra: footerExtraButtons() },
  });
  panel.append(editor.root);
}

/** Кнопки места: выбор сохранённого отбора. */
function footerExtraButtons(): FilterFooterButtonSpec[] {
  return [
    {
      // Нижний ряд футера — манипуляции с сохранёнными отборами (двухрядная
      // компоновка, ошибка 4258e694 п.2): кнопка рядом с полем имени, как в
      // «Структурах».
      id: 'saved',
      label: 'Отборы…',
      title: 'Выбрать сохранённый отбор',
      place: 'name',
      onClick: () => void openSavedPicker(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Сохранённые отборы (личные, `?view=chronicle`)
// ---------------------------------------------------------------------------

async function saveFilter(request: { name: string; asCopy: boolean }): Promise<void> {
  const name = request.name.trim();
  if (name === '') {
    notice('Введите имя отбора');
    return;
  }
  const definition = chronicleDefinition();
  try {
    await reloadSavedRows();
    const existing = savedRows.find((row) => row.name.toLowerCase() === name.toLowerCase());
    const target = request.asCopy ? undefined : existing;
    if (target !== undefined) {
      await etn.chronicleFilters.update(requireNetworkId(), target.id, {
        name,
        definition: definition as ChronicleFilterDefinition,
      });
      savedFilterId = target.id;
    } else {
      const created = await etn.chronicleFilters.create(requireNetworkId(), {
        name,
        definition: definition as ChronicleFilterDefinition,
      });
      savedFilterId = created.id;
    }
  } catch (err) {
    errorDialog('Сохранить отбор', err);
    return;
  }
  filterName = name;
  savedFilterName = name;
  savedDefinition = definition;
  editor?.refresh();
  notice(`Отбор «${name}» сохранён`);
}

async function openSavedPicker(): Promise<void> {
  await reloadSavedRows();
  await seedPredefinedFilters();
  // Перечитывание списка в ходе диалога: предопределённые наборы ВНУТРИ сессии
  // не досоздаются (посев — только при открытии); метка пересчитывается.
  const reload = async (): Promise<void> => {
    await reloadSavedRows();
    markPredefinedRows();
  };
  openSavedFilterDialog({
    entries: () => savedRows,
    selectedId: () => savedFilterId,
    onPick: (entry) => applySavedFilter(entry),
    onRename: async (entry) => {
      const name = (await promptDialog('Переименовать отбор', 'Имя', entry.name) ?? '').trim();
      if (name === '' || name === entry.name) return null;
      try {
        await etn.chronicleFilters.update(requireNetworkId(), entry.id, { name });
      } catch (err) {
        errorDialog('Переименовать отбор', err);
        return null;
      }
      await reload();
      if (savedFilterId === entry.id) {
        filterName = name;
        savedFilterName = name;
        editor?.refresh();
      }
      return name;
    },
    onCopy: async (entry) => {
      const copyName = duplicateFilterName(
        entry.name,
        savedRows.map((row) => row.name),
      );
      try {
        const created = await etn.chronicleFilters.create(requireNetworkId(), {
          name: copyName,
          definition: entry.definition as ChronicleFilterDefinition,
        });
        await reload();
        return created.id;
      } catch (err) {
        errorDialog('Скопировать отбор', err);
        return null;
      }
    },
    onDelete: async (entry) => {
      const confirmed = await confirmDialog(
        'Удалить отбор',
        `Удалить сохранённый отбор «${entry.name}»?`,
        true,
      );
      if (!confirmed) return;
      try {
        await etn.chronicleFilters.remove(requireNetworkId(), entry.id);
      } catch (err) {
        errorDialog('Удалить отбор', err);
        return;
      }
      if (savedFilterId === entry.id) {
        savedFilterId = null;
        savedFilterName = null;
      }
      await reload();
    },
    onRefresh: reload,
  });
}

/** Применить сохранённый отбор (в т.ч. прежний плоский v1) и выполнить запрос. */
function applySavedFilter(entry: SavedFilterRow): void {
  // Период записи — НЕУДАЛЯЕМАЯ строка панели (ошибка 609deba0 п.2). Определение
  // могло не нести лист `record_time` (легаси/импорт) — тогда строку периода
  // восстанавливаем из текущих границ, иначе она молча пропала бы вместе с
  // календарём (ошибка 68023851 п.3).
  const { from, to } = chroniclePeriod();
  filter = ensureChroniclePeriod(readFilterDefinition(entry.definition), from, to);
  syncKeywordsFromTree();
  savedFilterId = entry.id;
  filterName = entry.name;
  savedFilterName = entry.name;
  savedDefinition = entry.definition;
  serverIssues = [];
  renderPanel();
  actions.apply();
}

/**
 * Гарантировать НЕУДАЛЯЕМУЮ строку «Период записи» (инвариант B2 панели,
 * ошибка 609deba0 п.2): если прочитанное определение периода не несёт,
 * подставляем текущие границы — иначе строка-замок периода исчезла бы молча
 * (ошибка 68023851 п.3). Есть период в определении — оставляем его как есть.
 */
export function ensureChroniclePeriod(state: FilterState, from: string, to: string): FilterState {
  const read = chroniclePeriod(state);
  if (read.from !== '' || read.to !== '') return state;
  return applyChroniclePeriod(state, from, to);
}

// ---------------------------------------------------------------------------
// Шорткат применения отбора (Ctrl+Enter)
// ---------------------------------------------------------------------------

let chronicleApplySeq = 0;

/**
 * Global Ctrl+Enter shortcut for the diary view (hosted by the feed).
 * `onApply` вынесена параметром с дефолтом только ради наблюдаемости в тестах.
 */
export function wireChronicleApplyShortcut(
  container: HTMLElement,
  onApply: () => void = () => actions.apply(),
): void {
  const contextId = `chronicle-apply-${(chronicleApplySeq += 1)}`;
  defineKeyContext({
    id: contextId,
    bindings: [
      {
        command: 'chronicle.apply',
        chord: 'Ctrl+Enter',
        run: (event) => {
          if (event.defaultPrevented) return false;
          if (isFeedRecordEditorTarget(event.target as HTMLElement | null)) return false;
          onApply();
          return true;
        },
      },
    ],
  });
  let releaseContext: (() => void) | null = null;
  const onFocusIn = (): void => {
    releaseContext ??= pushKeyContext(contextId);
  };
  const onFocusOut = (): void => {
    releaseContext?.();
    releaseContext = null;
  };
  container.addEventListener('focusin', onFocusIn as EventListener);
  container.addEventListener('focusout', onFocusOut as EventListener);
}
