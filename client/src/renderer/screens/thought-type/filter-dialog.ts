/**
 * Диалог создания и правки отбора типа мысли (задача e37f3f04, спека
 * e0257ca5 «Диалог отбора типа мысли», версия 0.7.3).
 *
 * Поля: имя (обязательно, ≤200, уникально в пределах типа), описание (≤1000,
 * опц.), флажок «Открывать по умолчанию». Дальше — конструктор условий,
 * повторяющий панель «Структур» (`filter-panel.ts`) БЕЗ блока сохранённых
 * отборов, кнопок применения и сплиттера. К значениям условий свойств
 * пристёгнут токен-пикер: выпадающий список токенов для контекста отбора
 * (поля мысли + свойства типа и его предков + `$today`/`$now`/`$user`),
 * выбранный токен встаёт в значение и остаётся редактируемым.
 *
 * Списочные токены (множественные свойства) предлагаются только в условиях
 * с операцией `in` / `not_in` — попытка сохранить скаляр с массивом даёт
 * серверную 422, которая показывается через `notice` и под полем формы.
 *
 * Сохранение: `etn.thoughtTypeViews.create` или `.update` через IPC. На
 * успехе — `onSaved(savedView)`. Отмена и Esc закрывают без изменений.
 */

import {
  THOUGHT_TYPE_VIEW_DESCRIPTION_MAX,
  THOUGHT_TYPE_VIEW_NAME_MAX,
  type EffectiveTypeProperty,
  type NetworkProperty,
  type PropertyValueType,
  type SortOrder,
  type StructureAuthorOp,
  type StructurePropertyOp,
  type StructureSort,
  type Thought,
  type ThoughtType,
  type ThoughtTypeView,
  type ThoughtTypeViewDefinition,
  type ThoughtTypeViewInput,
  type ThoughtTypeViewUpdateInput,
} from '@etn/shared';

import { firstPickedThoughtId, pickedThoughtIds, pickThoughtsDialog } from '../../canvas/add-dialog.js';
import { clear, div, el, errText, span, setTooltip } from '../../lib/dom.js';
import { showDialog } from '../../lib/dialog.js';
import { etn } from '../../lib/etn.js';
import { showMenuAt, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import { orderedTypeRows } from '../../lib/type-tree.js';
import { buildUserMultiSelectWidget, buildUserSelectWidget } from '../../lib/users.js';
import { store } from '../../state.js';

import {
  buildTokensForField,
  buildWireDefinition,
  defaultDialogCriteriaState,
  parseViewDefinition,
  type ChainProperties,
  type DialogCriteriaState,
  type DialogPropertyCondition,
  type ViewToken,
} from './filter-dialog-pure.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** What the dialog was opened for: a new view or an existing one. */
export interface OpenViewEditorOptions {
  networkId: string;
  /** Type the new view belongs to. */
  thoughtTypeId: string;
  /** Type display name (used in the dialog title). */
  typeName: string;
  /** `null` — create; otherwise the existing view to edit. */
  view: ThoughtTypeView | null;
  /**
   * Called after a successful save. Receives the saved view (newly created or
   * freshly updated). Errors are surfaced in-place; no callback on cancel.
   */
  onSaved?: (view: ThoughtTypeView) => void;
}

/**
 * Opens the «Создать отбор» / «Изменить отбор» dialog.
 *
 * The dialog is modal and self-contained — closing it requires no further
 * plumbing from the caller. The host should react to `onSaved` to refresh
 * its strip / list (the IPC event `thought-type-view.{created,updated}`
 * already drives the realtime repaint).
 */
export function openViewEditorDialog(opts: OpenViewEditorOptions): void {
  // The body is built lazily after the type chain is loaded (we need the
  // ancestor types' effective properties to feed the token-picker).
  void buildAndShow(opts).catch((err: unknown) => {
    notice(`Не удалось открыть диалог отбора: ${errText(err)}`, 'error');
  });
}

/** Module-scoped chain of properties for the currently open dialog.
 *  The token-picker reads it lazily — there is at most one dialog open at
 *  a time. Reset to `null` when the dialog closes. */
let activeChainProps: ChainProperties[] | null = null;

function buildAndShow(opts: OpenViewEditorOptions): Promise<void> {
  return buildAndShowImpl(opts).finally(() => {
    activeChainProps = null;
  });
}

async function buildAndShowImpl(opts: OpenViewEditorOptions): Promise<void> {
  const { networkId, thoughtTypeId, typeName } = opts;
  // 1. Resolve the type chain (own + ancestors). The token-picker needs
  //    every property available on this type so users can pin a condition
  //    value to, say, `$thought.[версия]`. Order: the focused type first,
  //    then each ancestor (closest last) — the picker lists them in this
  //    order with a section heading per level.
  const chain = await loadTypeChain(networkId, thoughtTypeId);
  const chainProps = await loadTypeChainProperties(networkId, chain);
  activeChainProps = chainProps;
  // Property registry (registry-level metadata, e.g. name and multiple flag
  // for each property binding on the chain).
  const registryById = new Map<string, NetworkProperty>();
  try {
    const list = await etn.propertyRegistry.list(networkId);
    for (const row of list) registryById.set(row.id, row);
  } catch {
    /* empty registry — picker just shows none of the property tokens */
  }

  // 2. Initialise the form state from the existing view (or defaults).
  const isEdit = opts.view !== null;
  const title = isEdit ? 'Изменить отбор' : 'Создать отбор';
  const initial = parseViewDefinition(opts.view);
  const initialName = opts.view?.name ?? '';
  const initialDescription = opts.view?.description ?? '';
  const initialIsDefault = opts.view?.is_default ?? false;
  const initialVersion = opts.view?.version ?? 0;

  // 3. Build the form DOM.
  const body = div('form-stack view-editor-body');
  const errorLine = span('', 'error-text');

  // Name — required, ≤200.
  const nameInput = el('input', 'text-input') as HTMLInputElement;
  nameInput.type = 'text';
  nameInput.value = initialName;
  nameInput.maxLength = THOUGHT_TYPE_VIEW_NAME_MAX;
  nameInput.placeholder = 'Название отбора (обязательно)';
  const nameField = div('field');
  nameField.append(el('label', 'field-label', `Имя отбора (тип «${typeName}»)`));
  nameField.append(nameInput);

  // Description — optional, ≤1000.
  const descInput = el('textarea', 'textarea-input') as HTMLTextAreaElement;
  descInput.rows = 3;
  descInput.maxLength = THOUGHT_TYPE_VIEW_DESCRIPTION_MAX;
  descInput.value = initialDescription;
  descInput.placeholder = 'Описание (его читают и человек, и агент)';
  const descField = div('field');
  descField.append(el('label', 'field-label', 'Описание'));
  descField.append(descInput);

  // «Open by default» checkbox.
  const defaultLabel = el('label', 'checkbox-row') as HTMLLabelElement;
  const defaultCheckbox = el('input') as HTMLInputElement;
  defaultCheckbox.type = 'checkbox';
  defaultCheckbox.checked = initialIsDefault;
  defaultLabel.append(defaultCheckbox, span('Открывать по умолчанию'));
  const defaultField = div('field');
  defaultField.append(defaultLabel);

  // Criteria builder. Self-contained: it owns the FilterState for the
  // dialog lifetime and rebuilds on every change.
  const criteria = buildCriteriaBuilder({
    networkId,
    initial,
    registryById,
  });

  // Section title for the criteria block.
  const criteriaLabel = el('p', 'muted', 'Критерии отбора');
  criteriaLabel.style.margin = '8px 0 4px';

  body.append(nameField, descField, defaultField, criteriaLabel, criteria.root, errorLine);

  // 4. Show the dialog. The Save button keeps itself open on validation
  //    failure; we close only when the IPC call resolves.
  let saveBtn: HTMLButtonElement | null = null;
  showDialog({
    title,
    body,
    width: 760,
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Сохранить',
        primary: true,
        keepOpen: true,
        ref: (b) => {
          saveBtn = b;
        },
        onClick: (close) => {
          void onSave({
            close,
            saveBtn,
            opts,
            name: nameInput.value,
            description: descInput.value,
            isDefault: defaultCheckbox.checked,
            version: initialVersion,
            criteria,
            errorLine,
          });
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Save flow
// ---------------------------------------------------------------------------

interface SaveCtx {
  close: () => void;
  saveBtn: HTMLButtonElement | null;
  opts: OpenViewEditorOptions;
  name: string;
  description: string;
  isDefault: boolean;
  version: number;
  criteria: CriteriaBuilder;
  errorLine: HTMLElement;
}

async function onSave(ctx: SaveCtx): Promise<void> {
  const trimmedName = ctx.name.trim();
  if (trimmedName === '') {
    showFieldError(ctx, 'Укажите имя отбора.');
    return;
  }
  if (trimmedName.length > THOUGHT_TYPE_VIEW_NAME_MAX) {
    showFieldError(
      ctx,
      `Имя не должно превышать ${THOUGHT_TYPE_VIEW_NAME_MAX} символов (сейчас ${trimmedName.length}).`,
    );
    return;
  }
  const trimmedDesc = ctx.description.trim();
  if (trimmedDesc.length > THOUGHT_TYPE_VIEW_DESCRIPTION_MAX) {
    showFieldError(
      ctx,
      `Описание не должно превышать ${THOUGHT_TYPE_VIEW_DESCRIPTION_MAX} символов (сейчас ${trimmedDesc.length}).`,
    );
    return;
  }

  const definition: ThoughtTypeViewDefinition = ctx.criteria.buildWire();
  const definitionJson = JSON.stringify(definition);

  if (ctx.saveBtn !== null) ctx.saveBtn.disabled = true;
  ctx.errorLine.textContent = '';

  const { networkId, thoughtTypeId, view } = ctx.opts;
  try {
    let saved: ThoughtTypeView;
    if (view === null) {
      const input: ThoughtTypeViewInput = {
        name: trimmedName,
        description: trimmedDesc === '' ? null : trimmedDesc,
        definition: definitionJson,
        is_default: ctx.isDefault,
      };
      saved = await etn.thoughtTypeViews.create(networkId, thoughtTypeId, input);
    } else {
      const patch: ThoughtTypeViewUpdateInput = {
        name: trimmedName,
        description: trimmedDesc === '' ? null : trimmedDesc,
        definition: definitionJson,
        is_default: ctx.isDefault,
      };
      saved = await etn.thoughtTypeViews.update(
        networkId,
        view.thought_type_id,
        view.id,
        patch,
        ctx.version,
      );
    }
    ctx.opts.onSaved?.(saved);
    ctx.close();
  } catch (err) {
    showFieldError(ctx, errText(err));
    if (ctx.saveBtn !== null) ctx.saveBtn.disabled = false;
  }
}

function showFieldError(ctx: SaveCtx, message: string): void {
  ctx.errorLine.textContent = message;
  notice(message, 'error');
}

// ---------------------------------------------------------------------------
// Type chain + effective properties
// ---------------------------------------------------------------------------

/** Walks the type chain from a type up to the root, inclusive. */
async function loadTypeChain(
  networkId: string,
  typeId: string,
): Promise<ThoughtType[]> {
  // Prefer the store's catalogue (kept in sync by realtime-ui); fall back to
  // a single fetch when the type is not in the catalogue (e.g. new types
  // created on another tab).
  let catalogue = store.state.thoughtTypes.slice();
  if (catalogue.length === 0) {
    try {
      catalogue = await etn.types.listThoughtTypes(networkId);
    } catch {
      catalogue = [];
    }
  }
  const byId = new Map<string, ThoughtType>();
  for (const t of catalogue) byId.set(t.id, t);

  const chain: ThoughtType[] = [];
  let current: string | null = typeId;
  const guard = new Set<string>();
  while (current !== null && !guard.has(current)) {
    guard.add(current);
    const t = byId.get(current);
    if (t === undefined) break;
    chain.push(t);
    current = t.parent_id;
  }
  return chain;
}

/**
 * Loads the effective properties for each level of the chain. The dialog
 * only needs the property id, name, value type and `multiple` flag — the
 * token-picker references properties by id and writes `$thought.[<key>]`.
 */
async function loadTypeChainProperties(
  networkId: string,
  chain: ThoughtType[],
): Promise<ChainProperties[]> {
  const out: ChainProperties[] = [];
  for (const type of chain) {
    let props: EffectiveTypeProperty[] = [];
    try {
      props = await etn.types.listTypeProperties(networkId, 'thought_type', type.id);
    } catch {
      props = [];
    }
    out.push({ type, props });
  }
  return out;
}


// ---------------------------------------------------------------------------
// Re-exports from the pure helper module (so existing callers and tests
// can keep importing from `filter-dialog.js`).
// ---------------------------------------------------------------------------

export type { ChainProperties, DialogCriteriaState, DialogPropertyCondition, ViewToken } from './filter-dialog-pure.js';
export {
  buildTokensForField,
  buildWireDefinition,
  defaultDialogCriteriaState,
  parseViewDefinition,
} from './filter-dialog-pure.js';

/** Length constants re-exported for tests so the assertions reference the
 *  same source of truth as the dialog's own input limits. */
export const VIEW_NAME_MAX = THOUGHT_TYPE_VIEW_NAME_MAX;
export const VIEW_DESCRIPTION_MAX = THOUGHT_TYPE_VIEW_DESCRIPTION_MAX;

interface CriteriaBuilderOpts {
  networkId: string;
  initial: DialogCriteriaState;
  registryById: Map<string, NetworkProperty>;
}

interface CriteriaBuilder {
  root: HTMLElement;
  buildWire: () => ThoughtTypeViewDefinition;
}

/**
 * Builds a self-contained criteria form (keywords, parent/types/link types,
 * property conditions with token-picker, extras, author/editor, dates and
 * sort/order). Returns the root element plus a builder that materialises
 * the wire `ThoughtTypeViewDefinition` from the live state.
 */
function buildCriteriaBuilder(opts: CriteriaBuilderOpts): CriteriaBuilder {
  const { networkId } = opts;
  const state: DialogCriteriaState = opts.initial;
  const root = div('st-f-layout view-editor-criteria');

  // Re-render the whole builder on any change. The panel is short — this
  // is simpler than patching individual subtrees, and mirrors how
  // filter-panel.ts handles its main render.
  const render = (): void => {
    clear(root);
    root.append(buildKeywordsBlock(state, render));
    root.append(buildParentBlock(networkId, state, render));
    root.append(buildThoughtTypeBlock(networkId, state, render));
    root.append(buildLinkTypeBlock(networkId, state, render));
    root.append(
      buildPropertyConditionsBlock({
        networkId,
        state,
        registryById: opts.registryById,
        render,
      }),
    );
    root.append(buildExtrasBlock(state, render));
    root.append(buildAuthorEditorBlock(networkId, state, render));
    root.append(buildDateBoundsBlock(state, render));
    root.append(buildSortOrderBlock(state, render));
  };
  render();

  return {
    root,
    buildWire: () => buildWireDefinition(state, opts.registryById),
  };
}

/**
 * Builds the wire value+op for one author filter (задача 59119797).
 * `empty`/`not_empty` carry no value; `in`/`not_in` use the list; the
 * single-id ops use the scalar string.
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

// ---------------------------------------------------------------------------
// Per-block builders
// ---------------------------------------------------------------------------

function buildKeywordsBlock(state: DialogCriteriaState, render: () => void): HTMLElement {
  const wrap = div('st-f-block');
  const head = el('div', 'st-f-title', 'Ключевые слова');
  const body = div('st-f-body');
  wrap.append(head, body);

  const kwWrap = div('st-f-kw-wrap');
  const input = el('input', 'st-f-input st-f-keywords') as HTMLInputElement;
  input.type = 'text';
  input.value = state.keywords;
  input.placeholder = 'счет* -вод*';
  setTooltip(
    input,
    'Слова через пробел, все обязательны; * — любые символы; -слово — исключение.',
  );
  input.addEventListener('input', () => {
    state.keywords = input.value;
    render();
  });
  const clearBtn = el('button', 'st-f-clear-inline', '×') as HTMLButtonElement;
  clearBtn.type = 'button';
  setTooltip(clearBtn, 'Очистить');
  clearBtn.addEventListener('click', () => {
    state.keywords = '';
    render();
  });
  kwWrap.append(input, clearBtn);
  body.append(kwWrap);

  // Scope row.
  const scopeRow = div('st-f-kw-scope');
  for (const opt of [
    { key: 'title', label: 'наименование', state: () => state.keywordInTitle, set: (v: boolean) => {
      state.keywordInTitle = v;
    } },
    { key: 'synonyms', label: 'синонимы', state: () => state.keywordInSynonyms, set: (v: boolean) => {
      state.keywordInSynonyms = v;
    } },
    { key: 'comment', label: 'комментарий', state: () => state.keywordInComment, set: (v: boolean) => {
      state.keywordInComment = v;
    } },
  ]) {
    const lbl = el('label', 'checkbox-row st-f-kw-scope-item') as HTMLLabelElement;
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = opt.state();
    cb.addEventListener('change', () => {
      opt.set(cb.checked);
      // Last checked guard (mirrors filter-panel): default back to
      // title+synonyms when the user clears every checkbox.
      if (!state.keywordInTitle && !state.keywordInSynonyms && !state.keywordInComment) {
        state.keywordInTitle = true;
        state.keywordInSynonyms = true;
      }
      render();
    });
    lbl.append(cb, span(opt.label));
    scopeRow.append(lbl);
  }
  body.append(scopeRow);
  return wrap;
}

function buildParentBlock(
  networkId: string,
  state: DialogCriteriaState,
  render: () => void,
): HTMLElement {
  const wrap = div('st-f-block');
  wrap.append(el('div', 'st-f-title', 'Родительские мысли'));
  const body = div('st-f-body');
  wrap.append(body);

  const row = div('st-f-fieldrow');
  const chips = div('st-f-chipfield');
  chips.tabIndex = 0;
  setTooltip(chips, 'Ограничить отбор мыслями, подчинёнными указанным (клик — выбрать)');
  const openPicker = (): void => {
    void openParentPicker(networkId, state.parentIds, (ids) => {
      state.parentIds = ids;
      render();
    });
  };
  chips.addEventListener('click', openPicker);
  chips.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openPicker();
  });
  row.append(chips);
  if (state.parentIds.length > 0) {
    const clr = el('button', 'st-f-clear-inline', '×') as HTMLButtonElement;
    clr.type = 'button';
    setTooltip(clr, 'Очистить');
    clr.addEventListener('click', (event) => {
      event.stopPropagation();
      state.parentIds = [];
      render();
    });
    row.append(clr);
  }
  body.append(row);

  // Render chips (titles resolved lazily).
  renderParentChips(networkId, state.parentIds, chips);
  return wrap;
}

function buildThoughtTypeBlock(
  networkId: string,
  state: DialogCriteriaState,
  render: () => void,
): HTMLElement {
  const wrap = div('st-f-block');
  wrap.append(el('div', 'st-f-title', 'Типы мыслей'));
  const body = div('st-f-body');
  wrap.append(body);

  const row = div('st-f-fieldrow');
  const chips = div('st-f-chipfield');
  chips.tabIndex = 0;
  chips.addEventListener('click', () => {
    void openThoughtTypesPicker(networkId, state.typeIds, (ids) => {
      state.typeIds = ids;
      render();
    });
  });
  chips.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void openThoughtTypesPicker(networkId, state.typeIds, (ids) => {
        state.typeIds = ids;
        render();
      });
    }
  });
  row.append(chips);
  if (state.typeIds.length > 0) {
    const clr = el('button', 'st-f-clear-inline', '×') as HTMLButtonElement;
    clr.type = 'button';
    setTooltip(clr, 'Очистить');
    clr.addEventListener('click', (event) => {
      event.stopPropagation();
      state.typeIds = [];
      render();
    });
    row.append(clr);
  }
  body.append(row);
  renderTypeChips(networkId, 'thought', state.typeIds, chips);
  return wrap;
}

function buildLinkTypeBlock(
  networkId: string,
  state: DialogCriteriaState,
  render: () => void,
): HTMLElement {
  const wrap = div('st-f-block');
  wrap.append(el('div', 'st-f-title', 'Типы связей'));
  const body = div('st-f-body');
  wrap.append(body);

  const row = div('st-f-fieldrow');
  const chips = div('st-f-chipfield');
  chips.tabIndex = 0;
  chips.addEventListener('click', () => {
    void openLinkTypesPicker(networkId, state.linkTypeIds, (ids) => {
      state.linkTypeIds = ids;
      render();
    });
  });
  chips.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void openLinkTypesPicker(networkId, state.linkTypeIds, (ids) => {
        state.linkTypeIds = ids;
        render();
      });
    }
  });
  row.append(chips);
  if (state.linkTypeIds.length > 0) {
    const clr = el('button', 'st-f-clear-inline', '×') as HTMLButtonElement;
    clr.type = 'button';
    setTooltip(clr, 'Очистить');
    clr.addEventListener('click', (event) => {
      event.stopPropagation();
      state.linkTypeIds = [];
      render();
    });
    row.append(clr);
  }
  body.append(row);
  renderTypeChips(networkId, 'link', state.linkTypeIds, chips);
  return wrap;
}

interface PropertyConditionsOpts {
  networkId: string;
  state: DialogCriteriaState;
  registryById: Map<string, NetworkProperty>;
  render: () => void;
}

function buildPropertyConditionsBlock(opts: PropertyConditionsOpts): HTMLElement {
  const { networkId, state, registryById, render } = opts;
  const wrap = div('st-f-block');
  wrap.append(el('div', 'st-f-title', 'Свойства'));
  const body = div('st-f-body');
  wrap.append(body);

  const condsBox = div('st-f-conds');
  body.append(condsBox);
  state.properties.forEach((cond, idx) => {
    condsBox.append(
      buildConditionRow({
        networkId,
        cond,
        index: idx,
        state,
        registryById,
        render,
      }),
    );
  });

  const addBtn = el('button', 'st-f-add', '+ условие по свойству') as HTMLButtonElement;
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => {
    const firstReg = registryById.values().next().value as NetworkProperty | undefined;
    if (firstReg === undefined) {
      notice('В реестре свойств сети пока нет ни одного свойства.', 'info');
      return;
    }
    state.properties = [
      ...state.properties,
      { propertyId: firstReg.id, op: 'contains', values: [''] },
    ];
    render();
  });
  body.append(addBtn);
  return wrap;
}

interface ConditionRowOpts {
  networkId: string;
  cond: DialogPropertyCondition;
  index: number;
  state: DialogCriteriaState;
  registryById: Map<string, NetworkProperty>;
  render: () => void;
}

function buildConditionRow(opts: ConditionRowOpts): HTMLElement {
  const { networkId, cond, index, state, registryById, render } = opts;
  const row = div('st-f-cond');
  const def = registryById.get(cond.propertyId);

  // Property picker.
  const propSelect = el('select', 'st-f-input st-f-prop') as HTMLSelectElement;
  if (!registryById.has(cond.propertyId)) {
    const placeholder = el('option', '', cond.propertyId === '' ? '— свойство —' : '?') as HTMLOptionElement;
    placeholder.value = cond.propertyId;
    propSelect.append(placeholder);
  }
  for (const [id, entry] of registryById) {
    const opt = el('option', '', entry.name) as HTMLOptionElement;
    opt.value = id;
    propSelect.append(opt);
  }
  propSelect.value = cond.propertyId;
  propSelect.addEventListener('change', () => {
    const nextId = propSelect.value;
    const nextDef = registryById.get(nextId);
    const nextType: PropertyValueType = nextDef?.value_type ?? 'text';
    const ops = OPS_BY_TYPE[nextType];
    const nextOp = ops.some((o) => o.op === cond.op) ? cond.op : ops[0]!.op;
    state.properties[index] = { propertyId: nextId, op: nextOp, values: [''] };
    render();
  });

  // Operator picker.
  const opSelect = el('select', 'st-f-input st-f-op') as HTMLSelectElement;
  const ops = OPS_BY_TYPE[def?.value_type ?? 'text'];
  for (const op of ops) {
    const option = el('option', '', op.label) as HTMLOptionElement;
    option.value = op.op;
    opSelect.append(option);
  }
  if (!ops.some((o) => o.op === cond.op)) {
    cond.op = ops[0]!.op;
  }
  opSelect.value = cond.op;
  opSelect.addEventListener('change', () => {
    const live = state.properties[index] ?? cond;
    state.properties[index] = { ...live, op: opSelect.value as StructurePropertyOp, values: [''] };
    render();
  });

  // Value editor.
  const valueBox = buildConditionValueEditor({
    networkId,
    cond,
    index,
    state,
    registryById,
    render,
  });

  const remove = el('button', 'st-f-remove', '×') as HTMLButtonElement;
  remove.type = 'button';
  remove.addEventListener('click', () => {
    state.properties = state.properties.filter((_, i) => i !== index);
    render();
  });

  row.append(propSelect, opSelect, valueBox, remove);
  return row;
}

interface ConditionValueOpts {
  networkId: string;
  cond: DialogPropertyCondition;
  index: number;
  state: DialogCriteriaState;
  registryById: Map<string, NetworkProperty>;
  render: () => void;
}

function buildConditionValueEditor(opts: ConditionValueOpts): HTMLElement {
  const { networkId, cond, index, state, registryById, render } = opts;
  const def = registryById.get(cond.propertyId);
  const valueType: PropertyValueType = def?.value_type ?? 'text';
  const box = div('st-f-values');
  const isList = cond.op === 'in' || cond.op === 'not_in';
  const isPresence = cond.op === 'is_empty' || cond.op === 'not_empty';
  if (isPresence) {
    box.append(el('span', 'st-f-value-hint', 'значение не требуется'));
    return box;
  }

  const live = (): DialogPropertyCondition => state.properties[index] ?? cond;
  const setValue = (i: number, v: string): void => {
    const current = live();
    const values = [...current.values];
    while (values.length <= i) values.push('');
    values[i] = v;
    state.properties[index] = { ...current, values };
  };

  const buildScalar = (i: number): HTMLElement => {
    if (valueType === 'number') {
      return buildScalarInput('number', live().values[i] ?? '', (v) => {
        setValue(i, v);
      });
    }
    if (valueType === 'date') {
      return buildScalarInput('date', live().values[i] ?? '', (v) => {
        setValue(i, v);
      });
    }
    if (valueType === 'bool') {
      return buildBoolSelect(live().values[i] ?? '', (v) => {
        setValue(i, v);
      });
    }
    if (valueType === 'thought_ref') {
      return buildThoughtRefInput(networkId, live().values[i] ?? '', cond.op, (v) => {
        setValue(i, v);
        render();
      });
    }
    // text/url: free input + token button.
    return buildTextValueRow(networkId, live().values[i] ?? '', valueType, cond.op, (v) => {
      setValue(i, v);
      render();
    });
  };

  if (!isList) {
    box.append(buildScalar(0));
    return box;
  }

  // List editor.
  const renderList = (): void => {
    clear(box);
    const values = live().values.length > 0 ? live().values : [''];
    values.forEach((_, i) => {
      const line = div('st-f-value-row');
      line.append(buildScalar(i));
      const rm = el('button', 'st-f-remove', '×') as HTMLButtonElement;
      rm.type = 'button';
      rm.addEventListener('click', () => {
        const current = live();
        const next = current.values.filter((_, j) => j !== i);
        state.properties[index] = { ...current, values: next.length > 0 ? next : [''] };
        renderList();
      });
      line.append(rm);
      box.append(line);
    });
    const add = el('button', 'st-f-add', '+ значение') as HTMLButtonElement;
    add.type = 'button';
    add.addEventListener('click', () => {
      const current = live();
      state.properties[index] = { ...current, values: [...current.values, ''] };
      renderList();
    });
    box.append(add);
  };
  renderList();
  return box;
}

function buildScalarInput(
  type: 'text' | 'number' | 'date',
  value: string,
  onChange: (v: string) => void,
): HTMLInputElement {
  const input = el('input', 'st-f-input') as HTMLInputElement;
  input.type = type;
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function buildBoolSelect(value: string, onChange: (v: string) => void): HTMLSelectElement {
  const select = el('select', 'st-f-input') as HTMLSelectElement;
  const yes = el('option', '', 'да') as HTMLOptionElement;
  yes.value = 'true';
  const no = el('option', '', 'нет') as HTMLOptionElement;
  no.value = 'false';
  select.append(yes, no);
  select.value = value === 'false' ? 'false' : 'true';
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function buildTextValueRow(
  networkId: string,
  value: string,
  valueType: PropertyValueType,
  op: StructurePropertyOp,
  onChange: (v: string) => void,
): HTMLElement {
  const row = div('st-f-value-row');
  const input = el('input', 'st-f-input') as HTMLInputElement;
  input.type = 'text';
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  const tokenBtn = el('button', 'st-f-token-btn', '{…}') as HTMLButtonElement;
  tokenBtn.type = 'button';
  setTooltip(tokenBtn, 'Вставить токен');
  tokenBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openTokenPicker(networkId, tokenBtn, valueType, op, (tokenText) => {
      // Insert at the caret if focused, otherwise replace the value.
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      const next = input.value.slice(0, start) + tokenText + input.value.slice(end);
      input.value = next;
      onChange(next);
      input.focus();
      const caret = start + tokenText.length;
      try {
        input.setSelectionRange(caret, caret);
      } catch {
        /* some input types don't support selection */
      }
    });
  });
  row.append(input, tokenBtn);
  return row;
}

/**
 * Value editor for `thought_ref` conditions (баг 2, 5467fb19). Unlike
 * `editor/properties.ts` / `selection/dialogs.ts`, this field must stay
 * freely editable — it stores either a thought id or a token (`$thought`,
 * `$thought.[<свойство>]`) — so it does NOT use `wireThoughtRefSearch`:
 * that helper's `blur` handler unconditionally reverts `input.value` to
 * the value it had when the field gained focus, which would erase a
 * hand-typed or token-picker-inserted token. Instead the field behaves
 * like `buildTextValueRow` (free text + `{…}` token button) plus a
 * separate «выбрать» button that opens the thought picker dialog and, on
 * selection, just substitutes the resolved title into the input while
 * `onChange` receives the id.
 */
function buildThoughtRefInput(
  networkId: string,
  value: string,
  op: StructurePropertyOp,
  onChange: (v: string) => void,
): HTMLElement {
  const row = div('st-f-ref-row');
  const input = el('input', 'st-f-input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = 'id мысли или токен ($thought)…';
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));

  const tokenBtn = el('button', 'st-f-token-btn', '{…}') as HTMLButtonElement;
  tokenBtn.type = 'button';
  setTooltip(tokenBtn, 'Вставить токен');
  tokenBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openTokenPicker(networkId, tokenBtn, 'thought_ref', op, (tokenText) => {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      const next = input.value.slice(0, start) + tokenText + input.value.slice(end);
      input.value = next;
      onChange(next);
      input.focus();
      const caret = start + tokenText.length;
      try {
        input.setSelectionRange(caret, caret);
      } catch {
        /* some input types don't support selection */
      }
    });
  });

  const pick = el('button', 'st-f-add st-f-ref-pick', 'выбрать') as HTMLButtonElement;
  pick.type = 'button';
  pick.addEventListener('click', () => {
    void pickThoughtsDialog({
      networkId,
      allowCreate: false,
      allowLinkType: false,
    }).then(async (result) => {
      const id = firstPickedThoughtId(result);
      if (id === null) return;
      try {
        const [ref] = await etn.thoughts.resolve(networkId, [id]);
        input.value = ref !== undefined ? ref.title : id;
      } catch {
        input.value = id;
      }
      onChange(id);
    });
  });
  row.append(input, tokenBtn, pick);
  return row;
}

// ---------------------------------------------------------------------------
// Extras / author / dates / sort
// ---------------------------------------------------------------------------

function buildExtrasBlock(state: DialogCriteriaState, render: () => void): HTMLElement {
  const wrap = div('st-f-block');
  wrap.append(el('div', 'st-f-title', 'Дополнительно'));
  const body = div('st-f-body');
  wrap.append(body);

  const rows: Array<{
    label: string;
    state: () => boolean | null;
    set: (v: boolean | null) => void;
  }> = [
    { label: 'Есть значение свойства', state: () => state.hasProperties, set: (v) => (state.hasProperties = v) },
    { label: 'Есть постоянный комментарий', state: () => state.hasComment, set: (v) => (state.hasComment = v) },
    { label: 'Есть вложения', state: () => state.hasAttachments, set: (v) => (state.hasAttachments = v) },
    { label: 'Есть хронология', state: () => state.hasChronology, set: (v) => (state.hasChronology = v) },
    { label: 'Только актуальные', state: () => state.active, set: (v) => (state.active = v) },
  ];
  for (const r of rows) {
    const row = div('st-f-tri-row');
    row.append(el('span', 'st-f-tri-label', r.label));
    const select = el('select', 'st-f-input') as HTMLSelectElement;
    for (const opt of [
      { v: '', label: 'не важно' },
      { v: 'true', label: 'да' },
      { v: 'false', label: 'нет' },
    ]) {
      const o = el('option', '', opt.label) as HTMLOptionElement;
      o.value = opt.v;
      select.append(o);
    }
    const cur = r.state();
    select.value = cur === null ? '' : cur ? 'true' : 'false';
    select.addEventListener('change', () => {
      const v = select.value;
      r.set(v === '' ? null : v === 'true');
      render();
    });
    row.append(select);
    body.append(row);
  }
  // Trashed checkbox.
  const trashedRow = div('st-f-tri-row');
  const trashedLbl = el('label', 'checkbox-row') as HTMLLabelElement;
  const trashedCb = el('input') as HTMLInputElement;
  trashedCb.type = 'checkbox';
  trashedCb.checked = state.trashed;
  trashedCb.addEventListener('change', () => {
    state.trashed = trashedCb.checked;
  });
  trashedLbl.append(trashedCb, span('Включая помеченные на удаление'));
  trashedRow.append(trashedLbl);
  body.append(trashedRow);
  return wrap;
}

function buildAuthorEditorBlock(
  networkId: string,
  state: DialogCriteriaState,
  render: () => void,
): HTMLElement {
  const wrap = div('st-f-block');
  wrap.append(el('div', 'st-f-title', 'Автор / Редактор'));
  const body = div('st-f-body');
  wrap.append(body);

  body.append(
    buildAuthorConditionRow(networkId, {
      label: 'Автор',
      op: state.authorOp,
      singleId: state.authorId,
      listIds: state.authorIds,
      onOpChange: (op) => {
        state.authorOp = op;
        if (op !== 'eq' && op !== 'ne') state.authorId = '';
        if (op !== 'in' && op !== 'not_in') state.authorIds = [];
        render();
      },
      onSingleChange: (id) => {
        state.authorId = id;
      },
      onListChange: (ids) => {
        state.authorIds = ids;
      },
    }),
    buildAuthorConditionRow(networkId, {
      label: 'Редактор',
      op: state.editorOp,
      singleId: state.editorId,
      listIds: state.editorIds,
      onOpChange: (op) => {
        state.editorOp = op;
        if (op !== 'eq' && op !== 'ne') state.editorId = '';
        if (op !== 'in' && op !== 'not_in') state.editorIds = [];
        render();
      },
      onSingleChange: (id) => {
        state.editorId = id;
      },
      onListChange: (ids) => {
        state.editorIds = ids;
      },
    }),
  );
  return wrap;
}

function buildDateBoundsBlock(state: DialogCriteriaState, render: () => void): HTMLElement {
  const wrap = div('st-f-block');
  wrap.append(el('div', 'st-f-title', 'Даты'));
  const body = div('st-f-body');
  wrap.append(body);
  body.append(
    buildDateRangeRow('Создано', state.createdAfter, state.createdBefore, (from, to) => {
      state.createdAfter = from;
      state.createdBefore = to;
    }),
  );
  body.append(
    buildDateRangeRow('Изменено', state.updatedAfter, state.updatedBefore, (from, to) => {
      state.updatedAfter = from;
      state.updatedBefore = to;
    }),
  );
  return wrap;
}

function buildSortOrderBlock(state: DialogCriteriaState, render: () => void): HTMLElement {
  const wrap = div('st-f-block');
  wrap.append(el('div', 'st-f-title', 'Сортировка'));
  const body = div('st-f-body');
  wrap.append(body);
  const row = div('st-f-fieldrow');
  const sortSelect = el('select', 'st-f-input') as HTMLSelectElement;
  for (const opt of [
    { v: 'created', label: 'по дате создания' },
    { v: 'updated', label: 'по дате изменения' },
    { v: 'alpha', label: 'по алфавиту' },
  ]) {
    const o = el('option', '', opt.label) as HTMLOptionElement;
    o.value = opt.v;
    sortSelect.append(o);
  }
  sortSelect.value = state.sort;
  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value as StructureSort;
    render();
  });
  const orderSelect = el('select', 'st-f-input') as HTMLSelectElement;
  for (const opt of [
    { v: 'asc', label: 'по возрастанию' },
    { v: 'desc', label: 'по убыванию' },
  ]) {
    const o = el('option', '', opt.label) as HTMLOptionElement;
    o.value = opt.v;
    orderSelect.append(o);
  }
  orderSelect.value = state.order;
  orderSelect.addEventListener('change', () => {
    state.order = orderSelect.value as SortOrder;
    render();
  });
  row.append(sortSelect, orderSelect);
  body.append(row);
  return wrap;
}

// ---------------------------------------------------------------------------
// Author condition row + date range row
// ---------------------------------------------------------------------------

interface AuthorRowOpts {
  label: string;
  op: StructureAuthorOp;
  singleId: string;
  listIds: string[];
  onOpChange: (op: StructureAuthorOp) => void;
  onSingleChange: (id: string) => void;
  onListChange: (ids: string[]) => void;
}

function buildAuthorConditionRow(networkId: string, opts: AuthorRowOpts): HTMLElement {
  const row = div('author-cond-row');
  row.append(el('span', 'author-cond-label', opts.label));
  const opSelect = el('select', 'select-input author-cond-op') as HTMLSelectElement;
  for (const op of ['eq', 'ne', 'in', 'not_in', 'empty', 'not_empty'] as StructureAuthorOp[]) {
    const o = el('option', '', AUTHOR_OP_LABELS[op]) as HTMLOptionElement;
    o.value = op;
    opSelect.append(o);
  }
  opSelect.value = opts.op;
  opSelect.addEventListener('change', () => opts.onOpChange(opSelect.value as StructureAuthorOp));
  row.append(opSelect);

  if (opts.op === 'empty' || opts.op === 'not_empty') {
    row.append(el('span', 'author-cond-hint', 'значение не требуется'));
    return row;
  }
  if (opts.op === 'in' || opts.op === 'not_in') {
    const multi = buildUserMultiSelectWidget({
      label: '',
      currentIds: opts.listIds,
      onChange: opts.onListChange,
    });
    row.append(multi);
    return row;
  }
  const single = buildUserSelectWidget({
    label: '',
    currentId: opts.singleId,
    onChange: opts.onSingleChange,
  });
  row.append(single);
  return row;
}

const AUTHOR_OP_LABELS: Record<StructureAuthorOp, string> = {
  eq: 'равен',
  ne: 'не равен',
  in: 'в списке',
  not_in: 'не в списке',
  empty: 'не заполнено',
  not_empty: 'заполнено',
};

function buildDateRangeRow(
  label: string,
  from: string,
  to: string,
  onChange: (from: string, to: string) => void,
): HTMLElement {
  const row = div('st-f-date-row');
  row.append(el('span', 'st-f-date-label', label));
  const fromInput = el('input', 'st-f-input st-f-date-field') as HTMLInputElement;
  fromInput.type = 'datetime-local';
  fromInput.value = from;
  fromInput.addEventListener('input', () => onChange(fromInput.value, to));
  const toInput = el('input', 'st-f-input st-f-date-field') as HTMLInputElement;
  toInput.type = 'datetime-local';
  toInput.value = to;
  toInput.addEventListener('input', () => onChange(from, toInput.value));
  row.append(span('от', 'st-f-date-tag'), fromInput, span('до', 'st-f-date-tag'), toInput);
  return row;
}

// ---------------------------------------------------------------------------
// Operator set per property value type (mirrors filter-panel.ts OPS_BY_TYPE)
// ---------------------------------------------------------------------------

const OPS_BY_TYPE: Record<PropertyValueType, Array<{ op: StructurePropertyOp; label: string }>> = {
  text: [
    { op: 'contains', label: 'содержит' },
    { op: 'eq', label: 'равно' },
    { op: 'in', label: 'в списке' },
    { op: 'not_in', label: 'не в списке' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  url: [
    { op: 'contains', label: 'содержит' },
    { op: 'eq', label: 'равно' },
    { op: 'in', label: 'в списке' },
    { op: 'not_in', label: 'не в списке' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  date: [
    { op: 'eq', label: 'равно' },
    { op: 'gt', label: 'больше' },
    { op: 'lt', label: 'меньше' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  number: [
    { op: 'eq', label: 'равно' },
    { op: 'gt', label: 'больше' },
    { op: 'lt', label: 'меньше' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  bool: [{ op: 'eq', label: 'равно' }],
  thought_ref: [
    { op: 'eq', label: 'равно' },
    { op: 'in', label: 'в списке' },
    { op: 'not_in', label: 'не в списке' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
};

// ---------------------------------------------------------------------------
// Pickers (parent / thought types / link types / tokens)
// ---------------------------------------------------------------------------

async function openParentPicker(
  networkId: string,
  currentIds: string[],
  onPick: (ids: string[]) => void,
): Promise<void> {
  const result = await pickThoughtsDialog({
    networkId,
    allowCreate: false,
    allowLinkType: false,
    selectedIds: currentIds,
  });
  const ids = pickedThoughtIds(result);
  if (ids.length > 0 || currentIds.length > 0) onPick(ids);
}

async function openThoughtTypesPicker(
  networkId: string,
  currentIds: string[],
  onPick: (ids: string[]) => void,
): Promise<void> {
  let types = store.state.thoughtTypes;
  if (types.length === 0) {
    try {
      types = await etn.types.listThoughtTypes(networkId);
    } catch {
      types = [];
    }
  }
  const rows = orderedTypeRows(types)
    .filter((row) => !row.type.is_root)
    .map((row) => ({ id: row.type.id, label: row.type.name, depth: row.depth - 1 }));
  openTypePickerDialog('Типы мыслей', rows, currentIds, onPick);
}

async function openLinkTypesPicker(
  networkId: string,
  currentIds: string[],
  onPick: (ids: string[]) => void,
): Promise<void> {
  let types = store.state.linkTypes;
  if (types.length === 0) {
    try {
      types = await etn.types.listLinkTypes(networkId);
    } catch {
      types = [];
    }
  }
  const rows = orderedTypeRows(types)
    .filter((row) => !row.type.is_root)
    .map((row) => ({ id: row.type.id, label: row.type.name_forward, depth: row.depth - 1 }));
  openTypePickerDialog('Типы связей', rows, currentIds, onPick);
}

/**
 * Modal type picker: a search box filtering as you type, a multi-column
 * checklist (checked first, then alphabetical) and «Отмена»/«Применить».
 * Resolves the picked id list, or `null` when cancelled.
 */
function openTypePickerDialog(
  title: string,
  rows: Array<{ id: string; label: string; depth: number }>,
  initial: string[],
  onPick: (ids: string[]) => void,
): void {
  const body = div('st-f-picker');
  const searchInput = el('input', 'st-f-input st-f-search') as HTMLInputElement;
  searchInput.type = 'text';
  searchInput.placeholder = 'Найти…';
  const list = div('st-f-checks st-f-picker-list');
  const checked = new Set(initial);
  let needle = '';

  const renderList = (): void => {
    clear(list);
    const filtered = rows.filter((row) => row.label.toLowerCase().includes(needle));
    const byAlpha = (a: (typeof rows)[number], b: (typeof rows)[number]): number =>
      a.label.localeCompare(b.label, 'ru');
    const sorted = [
      ...filtered.filter((row) => checked.has(row.id)).sort(byAlpha),
      ...filtered.filter((row) => !checked.has(row.id)).sort(byAlpha),
    ];
    if (sorted.length === 0) list.append(el('div', 'st-f-empty', 'Ничего не найдено'));
    for (const row of sorted) {
      const line = el('label', 'st-f-check');
      line.style.paddingLeft = `${Math.max(0, row.depth) * 14}px`;
      const input = el('input') as HTMLInputElement;
      input.type = 'checkbox';
      input.checked = checked.has(row.id);
      input.addEventListener('change', () => {
        if (input.checked) checked.add(row.id);
        else checked.delete(row.id);
        renderList();
      });
      line.append(input, el('span', '', row.label));
      list.append(line);
    }
  };
  searchInput.addEventListener('input', () => {
    needle = searchInput.value.trim().toLowerCase();
    renderList();
  });
  body.append(searchInput, list);
  renderList();
  showDialog({
    title,
    body,
    width: 480,
    buttons: [
      { label: 'Отмена' },
      { label: 'Применить', primary: true, onClick: () => onPick([...checked]) },
    ],
    onMount: () => {
      searchInput.focus();
    },
  });
}

function renderTypeChips(
  networkId: string,
  kind: 'thought' | 'link',
  ids: string[],
  host: HTMLElement,
): void {
  clear(host);
  if (ids.length === 0) {
    host.append(span('Любой', 'muted'));
    return;
  }
  // Resolve names from the local catalogue (kept in sync by realtime-ui).
  const catalogue = kind === 'thought' ? store.state.thoughtTypes : store.state.linkTypes;
  const byId = new Map(catalogue.map((t) => [t.id, t]));
  const chips = span('', 'st-f-chip-list');
  ids.forEach((id, index) => {
    const t = byId.get(id);
    const name = t === undefined ? id : 'name' in t ? t.name : t.name_forward;
    chips.append(span(name, 'st-f-chip'));
    if (index < ids.length - 1) chips.append(span(', ', 'st-f-chip-sep'));
  });
  host.append(chips);
}

function renderParentChips(networkId: string, ids: string[], host: HTMLElement): void {
  clear(host);
  if (ids.length === 0) {
    host.append(span('Любые', 'muted'));
    return;
  }
  void Promise.all(
    ids.map((id) => etn.thoughts.resolve(networkId, [id]).then((r) => r[0] as Thought | undefined).catch(() => undefined)),
  ).then((refs) => {
    clear(host);
    const chips = span('', 'st-f-chip-list');
    refs.forEach((r, index) => {
      chips.append(span(r?.title ?? '(не найдено)', 'st-f-chip'));
      if (index < refs.length - 1) chips.append(span(', ', 'st-f-chip-sep'));
    });
    host.append(chips);
  });
}

/**
 * Opens the token-picker dropdown next to `anchor`. The list is grouped by
 * section (`Глобальные`, `Поля мысли`, `Свойства «<тип>»`). For multiple
 * properties the label carries a `[…]` suffix and the entry is dimmed when
 * the current op is scalar.
 */
async function openTokenPicker(
  networkId: string,
  anchor: HTMLElement,
  valueType: PropertyValueType,
  op: StructurePropertyOp,
  onInsert: (token: string) => void,
): Promise<void> {
  const chainProps = activeChainProps ?? [];
  const tokens = buildTokensForField(chainProps, valueType, op);
  if (tokens.length === 0) {
    notice('Для этого типа и значения доступных токенов нет.', 'info');
    return;
  }
  // Group by section.
  const sections = new Map<string, ViewToken[]>();
  for (const t of tokens) {
    const sec = t.section ?? '';
    let list = sections.get(sec);
    if (list === undefined) {
      list = [];
      sections.set(sec, list);
    }
    list.push(t);
  }
  const items: MenuItem[] = [];
  let first = true;
  for (const [sec, list] of sections) {
    if (!first) items.push({ label: '—' });
    first = false;
    if (sec !== '') {
      items.push({ label: sec, disabled: true });
    }
    for (const t of list) {
      const disabled = (t.listOnly === true) && op !== 'in' && op !== 'not_in';
      items.push({
        label: t.label,
        disabled,
        onClick: () => onInsert(t.text),
      });
    }
  }
  const rect = anchor.getBoundingClientRect();
  showMenuAt(rect.left, rect.bottom, items);
}
