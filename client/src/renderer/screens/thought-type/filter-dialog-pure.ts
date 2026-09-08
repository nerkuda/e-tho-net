/**
 * Pure helpers for the thought-type view editor dialog (задача e37f3f04).
 *
 * The dialog itself (`filter-dialog.ts`) imports from the broader renderer
 * (DOM helpers, dialog, the thought picker, etc.), which transitively pulls
 * in CodeMirror and the focus-filter-strip — too heavy for the unit tests
 * that exercise only the pure logic (token builder, wire shape, default
 * state, JSON round-trip).
 *
 * Everything here is dependency-free at runtime: only `@etn/shared` for the
 * shape of `NetworkProperty`/`PropertyValueType`/`StructurePropertyOp`. The
 * DOM and IPC layers stay in `filter-dialog.ts`.
 */

import type {
  EffectiveTypeProperty,
  NetworkProperty,
  PropertyValueType,
  SortOrder,
  StructureAuthorOp,
  StructureKeywordScope,
  StructurePropertyCondition,
  StructurePropertyOp,
  StructureSort,
  ThoughtType,
  ThoughtTypeView,
  ThoughtTypeViewDefinition,
} from '@etn/shared';

import {
  THOUGHT_TYPE_VIEW_DESCRIPTION_MAX,
  THOUGHT_TYPE_VIEW_NAME_MAX,
} from '@etn/shared';

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
    out.push(
      { text: '$thought.title', label: '$thought.title', section: 'Поля мысли' },
      { text: '$thought.type', label: '$thought.type' },
      { text: '$thought.author', label: '$thought.author' },
      { text: '$thought.editor', label: '$thought.editor' },
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
  if (propertyValueType === 'thought_ref') {
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
      if (
        (def.value_type === 'thought_ref' || def.value_type === 'url') &&
        multiple
      ) {
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
 * токен-пикер (баг 2): ключевые слова, тип мысли, автор, редактор.
 */
export type SpecialTokenField = 'keywords' | 'thought_type' | 'author' | 'editor';

/**
 * Токены для полей, не привязанных к типу значения свойства
 * (баг 2, таблица токенов из решения №7 тех.проекта 918833e3):
 *
 *   * `keywords` — `$thought.title`, `$thought.synonyms` + свойства типа/предков
 *     с типом значения text/url (поиск по тексту);
 *   * `thought_type` — только `$thought.type` (id типа мысли-контекста);
 *   * `author`/`editor` — `$thought.author`/`$thought.editor` + `$user`.
 */
export function buildTokensForSpecialField(
  chainProps: ChainProperties[],
  field: SpecialTokenField,
): ViewToken[] {
  if (field === 'thought_type') {
    return [
      { text: '$thought.type', label: '$thought.type — тип мысли в фокусе', section: 'Поля мысли' },
    ];
  }
  if (field === 'author') {
    return [
      { text: '$thought.author', label: '$thought.author', section: 'Поля мысли' },
      { text: '$user', label: '$user — текущий пользователь', section: 'Глобальные' },
    ];
  }
  if (field === 'editor') {
    return [
      { text: '$thought.editor', label: '$thought.editor', section: 'Поля мысли' },
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
// Criteria state — the in-memory shape the criteria builder mutates.
// ---------------------------------------------------------------------------

export interface DialogPropertyCondition {
  propertyId: string;
  op: StructurePropertyOp;
  values: string[];
}

export interface DialogCriteriaState {
  keywords: string;
  keywordInTitle: boolean;
  keywordInSynonyms: boolean;
  keywordInComment: boolean;
  parentIds: string[];
  typeIds: string[];
  linkTypeIds: string[];
  properties: DialogPropertyCondition[];
  hasProperties: boolean | null;
  hasComment: boolean | null;
  hasAttachments: boolean | null;
  hasChronology: boolean | null;
  active: boolean | null;
  trashed: boolean;
  authorOp: StructureAuthorOp;
  authorId: string;
  authorIds: string[];
  editorOp: StructureAuthorOp;
  editorId: string;
  editorIds: string[];
  createdAfter: string;
  createdBefore: string;
  updatedAfter: string;
  updatedBefore: string;
  sort: StructureSort;
  order: SortOrder;
}

/** Length constants the dialog enforces on the name/description inputs.
 *  Re-exported here so the pure module can be tested in isolation (the
 *  dialog imports them and binds them to the inputs; tests assert the
 *  same numbers).
 */
export const VIEW_NAME_MAX = THOUGHT_TYPE_VIEW_NAME_MAX;
export const VIEW_DESCRIPTION_MAX = THOUGHT_TYPE_VIEW_DESCRIPTION_MAX;

export function defaultDialogCriteriaState(): DialogCriteriaState {
  return {
    keywords: '',
    keywordInTitle: true,
    keywordInSynonyms: true,
    keywordInComment: false,
    parentIds: [],
    typeIds: [],
    linkTypeIds: [],
    properties: [],
    hasProperties: null,
    hasComment: null,
    hasAttachments: null,
    hasChronology: null,
    active: null,
    trashed: false,
    authorOp: 'eq',
    authorId: '',
    authorIds: [],
    editorOp: 'eq',
    editorId: '',
    editorIds: [],
    createdAfter: '',
    createdBefore: '',
    updatedAfter: '',
    updatedBefore: '',
    sort: 'created',
    order: 'asc',
  };
}

/**
 * Parses an existing view's JSON `definition` into the dialog state.
 * Returns the default state when the JSON is malformed.
 */
export function parseViewDefinition(view: ThoughtTypeView | null): DialogCriteriaState {
  const base = defaultDialogCriteriaState();
  if (view === null) return base;
  let parsed: ThoughtTypeViewDefinition;
  try {
    parsed = JSON.parse(view.definition) as ThoughtTypeViewDefinition;
  } catch {
    return base;
  }
  return mergeFilterState(base, parsed);
}

function mergeFilterState(
  base: DialogCriteriaState,
  parsed: ThoughtTypeViewDefinition,
): DialogCriteriaState {
  const next: DialogCriteriaState = { ...base };
  if (typeof parsed.keywords === 'string') next.keywords = parsed.keywords;
  if (Array.isArray(parsed.keyword_scope)) {
    const scope = new Set<StructureKeywordScope>(parsed.keyword_scope);
    next.keywordInTitle = scope.has('title');
    next.keywordInSynonyms = scope.has('synonyms');
    next.keywordInComment = scope.has('comment');
    if (scope.size === 0) {
      next.keywordInTitle = true;
      next.keywordInSynonyms = true;
    }
  }
  if (Array.isArray(parsed.parent_ids)) next.parentIds = parsed.parent_ids.slice();
  if (Array.isArray(parsed.type_ids)) next.typeIds = parsed.type_ids.slice();
  if (Array.isArray(parsed.link_type_ids)) next.linkTypeIds = parsed.link_type_ids.slice();
  if (Array.isArray(parsed.properties)) {
    next.properties = parsed.properties
      .filter(
        (c): c is StructurePropertyCondition =>
          c !== null &&
          typeof c === 'object' &&
          typeof (c as StructurePropertyCondition).property_id === 'string' &&
          typeof (c as StructurePropertyCondition).op === 'string',
      )
      .map((c) => ({
        propertyId: c.property_id,
        op: c.op,
        values: Array.isArray(c.value) ? c.value.map((v) => String(v)) : [String(c.value)],
      }));
  }
  if (typeof parsed.has_properties === 'boolean') next.hasProperties = parsed.has_properties;
  if (typeof parsed.has_comment === 'boolean') next.hasComment = parsed.has_comment;
  if (typeof parsed.has_attachments === 'boolean') next.hasAttachments = parsed.has_attachments;
  if (typeof parsed.has_chronology === 'boolean') next.hasChronology = parsed.has_chronology;
  if (typeof parsed.active === 'boolean') next.active = parsed.active;
  if (parsed.trashed === true) next.trashed = true;
  if (typeof parsed.created_by === 'string') {
    next.authorId = parsed.created_by;
    next.authorOp = parsed.created_by_op ?? 'eq';
  } else if (Array.isArray(parsed.created_by)) {
    next.authorIds = parsed.created_by.slice();
    next.authorOp = parsed.created_by_op ?? 'in';
  }
  if (typeof parsed.updated_by === 'string') {
    next.editorId = parsed.updated_by;
    next.editorOp = parsed.updated_by_op ?? 'eq';
  } else if (Array.isArray(parsed.updated_by)) {
    next.editorIds = parsed.updated_by.slice();
    next.editorOp = parsed.updated_by_op ?? 'in';
  }
  if (typeof parsed.created_after === 'string') next.createdAfter = parsed.created_after;
  if (typeof parsed.created_before === 'string') next.createdBefore = parsed.created_before;
  if (typeof parsed.updated_after === 'string') next.updatedAfter = parsed.updated_after;
  if (typeof parsed.updated_before === 'string') next.updatedBefore = parsed.updated_before;
  if (typeof parsed.sort === 'string') next.sort = parsed.sort;
  if (typeof parsed.order === 'string') next.order = parsed.order;
  return next;
}

// ---------------------------------------------------------------------------
// Wire builder
// ---------------------------------------------------------------------------

/**
 * Materialises the wire `ThoughtTypeViewDefinition`. Drops empty criteria
 * (matching the conventions of filter-panel.ts), normalises the keyword
 * scope and emits the sort/order pair (required by `SavedFilterDefinition`).
 */
export function buildWireDefinition(
  state: DialogCriteriaState,
  registryById: Map<string, NetworkProperty>,
): ThoughtTypeViewDefinition {
  // `sort`/`order` are required by `SavedFilterDefinition`; we always emit
  // them, so seed the object with the defaults.
  const out: ThoughtTypeViewDefinition = {
    sort: state.sort,
    order: state.order,
  };
  if (state.keywords.trim() !== '') out.keywords = state.keywords.trim();
  // Default scope = title+synonyms — omit the array to keep the wire lean.
  const scope: StructureKeywordScope[] = [];
  if (state.keywordInTitle) scope.push('title');
  if (state.keywordInSynonyms) scope.push('synonyms');
  if (state.keywordInComment) scope.push('comment');
  if (!(scope.length === 2 && scope.includes('title') && scope.includes('synonyms'))) {
    out.keyword_scope = scope;
  }
  if (state.parentIds.length > 0) out.parent_ids = state.parentIds.slice();
  if (state.typeIds.length > 0) out.type_ids = state.typeIds.slice();
  if (state.linkTypeIds.length > 0) out.link_type_ids = state.linkTypeIds.slice();

  // Property conditions (typed conversion).
  const wireProps: StructurePropertyCondition[] = [];
  for (const cond of state.properties) {
    const def = registryById.get(cond.propertyId);
    if (def === undefined) continue;
    if (cond.op === 'is_empty' || cond.op === 'not_empty') {
      wireProps.push({ property_id: cond.propertyId, op: cond.op, value: '' });
      continue;
    }
    const list = cond.op === 'in' || cond.op === 'not_in';
    const rawValues = list ? cond.values : cond.values.slice(0, 1);
    const typed: Array<string | number | boolean> = [];
    for (const raw of rawValues) {
      if (raw === '') continue;
      if (def.value_type === 'number') {
        const num = Number(raw);
        if (!Number.isFinite(num)) continue;
        typed.push(num);
      } else if (def.value_type === 'bool') {
        typed.push(raw === 'true');
      } else {
        typed.push(raw);
      }
    }
    if (typed.length === 0) continue;
    wireProps.push({
      property_id: cond.propertyId,
      op: cond.op,
      value: list ? typed : typed[0]!,
    });
  }
  if (wireProps.length > 0) out.properties = wireProps;

  if (state.hasProperties !== null) out.has_properties = state.hasProperties;
  if (state.hasComment !== null) out.has_comment = state.hasComment;
  if (state.hasAttachments !== null) out.has_attachments = state.hasAttachments;
  if (state.hasChronology !== null) out.has_chronology = state.hasChronology;
  if (state.active !== null) out.active = state.active;
  if (state.trashed) out.trashed = true;

  const authorWire = buildAuthorWireValue(state.authorOp, state.authorId, state.authorIds);
  if (authorWire !== undefined) {
    out.created_by = authorWire;
    if (state.authorOp !== 'eq') out.created_by_op = state.authorOp;
  }
  const editorWire = buildAuthorWireValue(state.editorOp, state.editorId, state.editorIds);
  if (editorWire !== undefined) {
    out.updated_by = editorWire;
    if (state.editorOp !== 'eq') out.updated_by_op = state.editorOp;
  }

  if (state.createdAfter.trim() !== '') out.created_after = state.createdAfter.trim();
  if (state.createdBefore.trim() !== '') out.created_before = state.createdBefore.trim();
  if (state.updatedAfter.trim() !== '') out.updated_after = state.updatedAfter.trim();
  if (state.updatedBefore.trim() !== '') out.updated_before = state.updatedBefore.trim();

  return out;
}

/**
 * Builds the wire value+op for one author filter. `empty`/`not_empty` carry
 * no value; `in`/`not_in` use the list; the single-id ops use the scalar
 * string.
 */
function buildAuthorWireValue(
  op: StructureAuthorOp,
  single: string,
  list: string[],
): string | string[] | undefined {
  if (op === 'empty' || op === 'not_empty') return undefined;
  if (op === 'in' || op === 'not_in') {
    if (list.length === 0) return undefined;
    return list;
  }
  if (single === '') return undefined;
  return single;
}
