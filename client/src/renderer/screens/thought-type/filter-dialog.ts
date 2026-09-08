/**
 * Диалог создания и правки отбора типа мысли (задача e37f3f04, спека
 * e0257ca5 «Диалог отбора типа мысли», версия 0.7.3).
 *
 * Конструктор условий повторяет панель «Структур» (`filter-panel.ts`) БЕЗ
 * блока сохранённых отборов, кнопок применения и сплиттера: ключевые слова,
 * родительские мысли, типы мыслей и связей, свойства, автор/редактор, даты,
 * «Дополнительно» и сортировка. Тяжёлые группы («Свойства», «Дополнительно»,
 * «Автор / Редактор», «Даты») — сворачиваемые, по умолчанию свёрнуты; заголовок
 * любой группы, чьи условия не пусты, подсвечивается и помечается `*`.
 *
 * К значениям условий пристёгнут токен-пикер: выпадающий список, собранный по
 * типу, которому принадлежит отбор (поля мысли + свойства типа и его предков +
 * `$today`/`$now`/`$user`). Выбранный токен подставляется текстом и остаётся
 * редактируемым; списочные токены — только в «в списке»/«не в списке».
 *
 * Сохранение: `etn.thoughtTypeViews.create`/`.update` через IPC. Пустой отбор
 * (ни одного условия) сохранить нельзя — ошибка показывается под формой.
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
import { buildUserSelectWidget, listUsers, resolveUserName } from '../../lib/users.js';
import { store } from '../../state.js';

import {
  buildTokensForField,
  buildTokensForSpecialField,
  buildWireDefinition,
  defaultDialogCriteriaState,
  hasAnyCriteria,
  parseViewDefinition,
  type ChainProperties,
  type DialogCriteriaState,
  type DialogPropertyCondition,
  type SpecialTokenField,
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
  // 1. Resolve the type chain (own + ancestors). The token-picker needs every
  //    property available on this type so users can pin a condition value to,
  //    say, `$thought.[версия]`.
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

  // Criteria builder. Self-contained: it owns the criteria state for the
  // dialog lifetime.
  const criteria = buildCriteriaBuilder({ networkId, initial, registryById });

  // Section title — жирный, чтобы «Критерии отбора» читались как заголовок.
  const criteriaLabel = el('div', 'view-editor-section-title', 'Критерии отбора');

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
  // Запрет пустого отбора (ошибка e8365d29): без условий отбор бессмыслен.
  if (!ctx.criteria.hasAnyCriteria()) {
    showFieldError(ctx, 'Укажите хотя бы одно условие отбора.');
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
async function loadTypeChain(networkId: string, typeId: string): Promise<ThoughtType[]> {
  // Prefer the store's catalogue (kept in sync by realtime-ui); fall back to
  // a single fetch when the type is not in the catalogue.
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

/** Loads the effective properties for each level of the chain. */
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

export type { ChainProperties, DialogCriteriaState, DialogPropertyCondition, SpecialTokenField, ViewToken } from './filter-dialog-pure.js';
export {
  buildTokensForField,
  buildTokensForSpecialField,
  buildWireDefinition,
  defaultDialogCriteriaState,
  hasAnyCriteria,
  parseViewDefinition,
} from './filter-dialog-pure.js';

/** Length constants re-exported for tests. */
export const VIEW_NAME_MAX = THOUGHT_TYPE_VIEW_NAME_MAX;
export const VIEW_DESCRIPTION_MAX = THOUGHT_TYPE_VIEW_DESCRIPTION_MAX;

// ---------------------------------------------------------------------------
// Criteria builder
// ---------------------------------------------------------------------------

interface CriteriaBuilderOpts {
  networkId: string;
  initial: DialogCriteriaState;
  registryById: Map<string, NetworkProperty>;
}

interface CriteriaBuilder {
  root: HTMLElement;
  buildWire: () => ThoughtTypeViewDefinition;
  hasAnyCriteria: () => boolean;
}

/** A group title whose conditions may be non-empty: the head is highlighted
 *  and its `*` marker toggled by {@link refreshGroupTitles}. */
interface GroupMarker {
  head: HTMLElement;
  star: HTMLElement;
  isNonEmpty: () => boolean;
}

/** Plain section with a title and a group-marker star. */
function block(title: string): { box: HTMLElement; body: HTMLElement; head: HTMLElement; star: HTMLElement } {
  const box = div('st-f-block');
  const head = el('div', 'st-f-title');
  head.append(el('span', '', title));
  const star = el('span', 'st-f-star', '');
  head.append(star);
  const body = div('st-f-body');
  box.append(head, body);
  return { box, body, head, star };
}

/** Collapsible section; `refresh()` toggles the caret and the body. */
function collapsibleBlock(
  title: string,
  getCollapsed: () => boolean,
  setCollapsed: (v: boolean) => void,
): { box: HTMLElement; body: HTMLElement; head: HTMLElement; star: HTMLElement; refresh: () => void } {
  const box = div('st-f-block');
  const head = el('div', 'st-f-title st-f-collapsible-title');
  const caret = el('span', 'st-f-caret', getCollapsed() ? '▸' : '▾');
  head.append(caret, el('span', '', title));
  const star = el('span', 'st-f-star', '');
  head.append(star);
  const body = div('st-f-body');
  box.append(head, body);
  const refresh = (): void => {
    const collapsed = getCollapsed();
    body.classList.toggle('hidden', collapsed);
    caret.textContent = collapsed ? '▸' : '▾';
  };
  head.addEventListener('click', () => {
    setCollapsed(!getCollapsed());
    refresh();
  });
  refresh();
  return { box, body, head, star, refresh };
}

/** Условие «Автор» или «Редактор» активно (для маркера группы). */
function authorFieldActive(op: StructureAuthorOp, single: string, list: string[]): boolean {
  if (op === 'empty' || op === 'not_empty') return true;
  if (op === 'in' || op === 'not_in') return list.length > 0;
  return single !== '';
}

/** Условие «Даты» активно (задана хотя бы одна граница). */
function datesActive(state: DialogCriteriaState): boolean {
  return (
    state.createdAfter !== '' ||
    state.createdBefore !== '' ||
    state.updatedAfter !== '' ||
    state.updatedBefore !== ''
  );
}

/** Условие «Дополнительно» активно. */
function extrasActive(state: DialogCriteriaState): boolean {
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
 * Builds a self-contained criteria form. Unlike the previous implementation,
 * the form is built once and mutated in place: input handlers update `state`
 * and refresh group markers WITHOUT rebuilding the DOM (which used to drop
 * focus on every keystroke). Only structural changes (add/remove condition,
 * switch operator, reorder the author list) rebuild the affected subtree.
 */
function buildCriteriaBuilder(opts: CriteriaBuilderOpts): CriteriaBuilder {
  const { networkId, registryById } = opts;
  const state = opts.initial;
  const root = div('st-f-layout view-editor-criteria');

  // Transient collapse state (default collapsed, §e0257ca5).
  let propsCollapsed = true;
  let extraCollapsed = true;
  let authorCollapsed = true;
  let datesCollapsed = true;

  // Uniform «group carries values» marking.
  const markers: GroupMarker[] = [];
  const refreshGroupTitles = (): void => {
    for (const m of markers) {
      const active = m.isNonEmpty();
      m.head.classList.toggle('st-f-title-active', active);
      m.star.textContent = active ? ' *' : '';
    }
  };
  /** Persist-less touch: refresh markers only (no DOM rebuild). */
  const touch = (): void => refreshGroupTitles();

  // --- Ключевые слова -------------------------------------------------------
  const kw = block('Ключевые слова');
  markers.push({ head: kw.head, star: kw.star, isNonEmpty: () => state.keywords.trim() !== '' });

  const kwWrap = div('st-f-kw-wrap');
  const kwInput = el('input', 'st-f-input st-f-keywords') as HTMLInputElement;
  kwInput.type = 'text';
  kwInput.value = state.keywords;
  kwInput.placeholder = 'счет* -вод*';
  setTooltip(kwInput, 'Слова через пробел, все обязательны; * — любые символы; -слово — исключение.');
  kwInput.addEventListener('input', () => {
    state.keywords = kwInput.value;
    touch();
  });
  const kwToken = makeTokenBtn(networkId, { kind: 'keywords' }, (token) => {
    const start = kwInput.selectionStart ?? kwInput.value.length;
    const end = kwInput.selectionEnd ?? kwInput.value.length;
    const next = kwInput.value.slice(0, start) + token + kwInput.value.slice(end);
    kwInput.value = next;
    state.keywords = next;
    kwInput.focus();
    const caret = start + token.length;
    try {
      kwInput.setSelectionRange(caret, caret);
    } catch {
      /* ignore */
    }
  });
  const kwClear = el('button', 'st-f-clear-inline', '×') as HTMLButtonElement;
  kwClear.type = 'button';
  setTooltip(kwClear, 'Очистить');
  kwClear.addEventListener('click', () => {
    state.keywords = '';
    kwInput.value = '';
    touch();
  });
  kwWrap.append(kwInput, kwToken, kwClear);
  kw.body.append(kwWrap);
  kw.body.append(buildKeywordScopeRow(state, touch));

  // --- Родительские мысли ---------------------------------------------------
  const pt = block('Родительские мысли');
  markers.push({ head: pt.head, star: pt.star, isNonEmpty: () => state.parentIds.length > 0 });
  const ptChips = div('st-f-chipfield');
  ptChips.tabIndex = 0;
  setTooltip(ptChips, 'Ограничить отбор мыслями, подчинёнными указанным (клик — выбрать)');
  ptChips.addEventListener('click', () => {
    void openParentPicker(networkId, state.parentIds, (ids) => {
      state.parentIds = ids;
      renderParentChips(networkId, state.parentIds, ptChips);
      touch();
    });
  });
  ptChips.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void openParentPicker(networkId, state.parentIds, (ids) => {
      state.parentIds = ids;
      renderParentChips(networkId, state.parentIds, ptChips);
      touch();
    });
  });
  const ptToken = makeTokenBtn(networkId, { kind: 'parent' }, (token) => {
    state.parentIds = [token];
    renderParentChips(networkId, state.parentIds, ptChips);
    touch();
  });
  const ptClear = el('button', 'st-f-clear-inline', '×') as HTMLButtonElement;
  ptClear.type = 'button';
  setTooltip(ptClear, 'Очистить');
  ptClear.addEventListener('click', (event) => {
    event.stopPropagation();
    state.parentIds = [];
    renderParentChips(networkId, state.parentIds, ptChips);
    touch();
  });
  const ptRow = div('st-f-fieldrow');
  ptRow.append(ptChips, ptToken, ptClear);
  pt.body.append(ptRow);
  renderParentChips(networkId, state.parentIds, ptChips);

  // --- Типы мыслей ----------------------------------------------------------
  const tt = block('Типы мыслей');
  markers.push({ head: tt.head, star: tt.star, isNonEmpty: () => state.typeIds.length > 0 });
  const ttChips = div('st-f-chipfield');
  ttChips.tabIndex = 0;
  const openTtPicker = (): void => {
    void openThoughtTypesPicker(networkId, state.typeIds, (ids) => {
      state.typeIds = ids;
      renderTypeChips(networkId, 'thought', state.typeIds, ttChips);
      touch();
    });
  };
  ttChips.addEventListener('click', openTtPicker);
  ttChips.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openTtPicker();
  });
  const ttToken = makeTokenBtn(networkId, { kind: 'thought_type' }, (token) => {
    state.typeIds = [token];
    renderTypeChips(networkId, 'thought', state.typeIds, ttChips);
    touch();
  });
  const ttClear = el('button', 'st-f-clear-inline', '×') as HTMLButtonElement;
  ttClear.type = 'button';
  setTooltip(ttClear, 'Очистить');
  ttClear.addEventListener('click', (event) => {
    event.stopPropagation();
    state.typeIds = [];
    renderTypeChips(networkId, 'thought', state.typeIds, ttChips);
    touch();
  });
  const ttRow = div('st-f-fieldrow');
  ttRow.append(ttChips, ttToken, ttClear);
  tt.body.append(ttRow);
  renderTypeChips(networkId, 'thought', state.typeIds, ttChips);

  // --- Типы связей ----------------------------------------------------------
  const lt = block('Типы связей');
  markers.push({ head: lt.head, star: lt.star, isNonEmpty: () => state.linkTypeIds.length > 0 });
  const ltChips = div('st-f-chipfield');
  ltChips.tabIndex = 0;
  const openLtPicker = (): void => {
    void openLinkTypesPicker(networkId, state.linkTypeIds, (ids) => {
      state.linkTypeIds = ids;
      renderTypeChips(networkId, 'link', state.linkTypeIds, ltChips);
      touch();
    });
  };
  ltChips.addEventListener('click', openLtPicker);
  ltChips.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openLtPicker();
  });
  const ltClear = el('button', 'st-f-clear-inline', '×') as HTMLButtonElement;
  ltClear.type = 'button';
  setTooltip(ltClear, 'Очистить');
  ltClear.addEventListener('click', (event) => {
    event.stopPropagation();
    state.linkTypeIds = [];
    renderTypeChips(networkId, 'link', state.linkTypeIds, ltChips);
    touch();
  });
  const ltRow = div('st-f-fieldrow');
  ltRow.append(ltChips, ltClear);
  lt.body.append(ltRow);
  renderTypeChips(networkId, 'link', state.linkTypeIds, ltChips);

  // --- Свойства (сворачиваемая группа) -------------------------------------
  const props = collapsibleBlock('Свойства', () => propsCollapsed, (v) => (propsCollapsed = v));
  markers.push({ head: props.head, star: props.star, isNonEmpty: () => state.properties.length > 0 });
  const condsBox = div('st-f-conds');
  const renderConditions = (): void => {
    clear(condsBox);
    if (state.properties.length === 0) {
      condsBox.append(el('div', 'st-f-empty', 'Условий нет'));
      return;
    }
    state.properties.forEach((cond, idx) => {
      condsBox.append(buildConditionRow({ networkId, cond, index: idx, state, registryById, touch, renderConditions }));
    });
  };
  renderConditions();
  const addCond = el('button', 'st-f-add', '+ условие по свойству') as HTMLButtonElement;
  addCond.type = 'button';
  addCond.addEventListener('click', () => {
    const firstReg = registryById.values().next().value as NetworkProperty | undefined;
    if (firstReg === undefined) {
      notice('В реестре свойств сети пока нет ни одного свойства.', 'info');
      return;
    }
    const firstOp = OPS_BY_TYPE[firstReg.value_type][0]!.op;
    state.properties = [...state.properties, { propertyId: firstReg.id, op: firstOp, values: [''] }];
    renderConditions();
    touch();
  });
  props.body.append(condsBox, addCond);

  // --- Дополнительно (сворачиваемая группа) ---------------------------------
  const extra = collapsibleBlock('Дополнительно', () => extraCollapsed, (v) => (extraCollapsed = v));
  markers.push({ head: extra.head, star: extra.star, isNonEmpty: () => extrasActive(state) });
  const triRow = (
    label: string,
    get: () => boolean | null,
    set: (v: boolean | null) => void,
    options?: { yes: string; no: string },
  ): HTMLElement => {
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
    select.addEventListener('change', () => {
      set(select.value === '' ? null : select.value === 'true');
      touch();
    });
    row.append(select);
    return row;
  };
  extra.body.append(
    triRow('Есть значение свойства', () => state.hasProperties, (v) => (state.hasProperties = v)),
    triRow('Есть постоянный комментарий', () => state.hasComment, (v) => (state.hasComment = v)),
    triRow('Есть вложения', () => state.hasAttachments, (v) => (state.hasAttachments = v)),
    triRow('Есть хронология', () => state.hasChronology, (v) => (state.hasChronology = v)),
    triRow('Только актуальные', () => state.active, (v) => (state.active = v), { yes: 'актуальные', no: 'не актуальные' }),
  );
  const trashedRow = div('st-f-tri-row');
  const trashedLbl = el('label', 'checkbox-row') as HTMLLabelElement;
  const trashedCb = el('input') as HTMLInputElement;
  trashedCb.type = 'checkbox';
  trashedCb.checked = state.trashed;
  trashedCb.addEventListener('change', () => {
    state.trashed = trashedCb.checked;
    touch();
  });
  trashedLbl.append(trashedCb, span('Включая помеченные на удаление'));
  trashedRow.append(el('span', 'st-f-tri-label', 'Корзина'), trashedLbl);
  extra.body.append(trashedRow);

  // --- Автор / Редактор (сворачиваемая группа) ------------------------------
  const authorship = collapsibleBlock('Автор / Редактор', () => authorCollapsed, (v) => (authorCollapsed = v));
  markers.push({
    head: authorship.head,
    star: authorship.star,
    isNonEmpty: () =>
      authorFieldActive(state.authorOp, state.authorId, state.authorIds) ||
      authorFieldActive(state.editorOp, state.editorId, state.editorIds),
  });
  const authorRows = div('st-f-author-rows');
  const renderAuthor = (): void => {
    clear(authorRows);
    authorRows.append(
      buildAuthorRow(networkId, {
        label: 'Автор',
        field: 'author',
        op: state.authorOp,
        singleId: state.authorId,
        listIds: state.authorIds,
        onOpChange: (op) => {
          state.authorOp = op;
          if (op !== 'eq' && op !== 'ne') state.authorId = '';
          if (op !== 'in' && op !== 'not_in') state.authorIds = [];
          renderAuthor();
          touch();
        },
        onSingleChange: (id) => {
          state.authorId = id;
          touch();
        },
        onListChange: (ids) => {
          state.authorIds = ids;
          touch();
        },
      }),
      buildAuthorRow(networkId, {
        label: 'Редактор',
        field: 'editor',
        op: state.editorOp,
        singleId: state.editorId,
        listIds: state.editorIds,
        onOpChange: (op) => {
          state.editorOp = op;
          if (op !== 'eq' && op !== 'ne') state.editorId = '';
          if (op !== 'in' && op !== 'not_in') state.editorIds = [];
          renderAuthor();
          touch();
        },
        onSingleChange: (id) => {
          state.editorId = id;
          touch();
        },
        onListChange: (ids) => {
          state.editorIds = ids;
          touch();
        },
      }),
    );
  };
  renderAuthor();
  authorship.body.append(authorRows);

  // --- Даты (сворачиваемая группа) ------------------------------------------
  const dates = collapsibleBlock('Даты', () => datesCollapsed, (v) => (datesCollapsed = v));
  markers.push({ head: dates.head, star: dates.star, isNonEmpty: () => datesActive(state) });
  dates.body.append(
    buildDateRangeRow(networkId, 'Создано', state.createdAfter, state.createdBefore, (from, to) => {
      state.createdAfter = from;
      state.createdBefore = to;
      touch();
    }),
    buildDateRangeRow(networkId, 'Изменено', state.updatedAfter, state.updatedBefore, (from, to) => {
      state.updatedAfter = from;
      state.updatedBefore = to;
      touch();
    }),
  );

  // --- Сортировка -----------------------------------------------------------
  const sort = block('Сортировка');
  const sortRow = div('st-f-sort');
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
  });
  sortRow.append(sortSelect, orderSelect);
  sort.body.append(sortRow);

  root.append(
    kw.box,
    pt.box,
    tt.box,
    lt.box,
    props.box,
    extra.box,
    authorship.box,
    dates.box,
    sort.box,
  );

  refreshGroupTitles();

  return {
    root,
    buildWire: () => buildWireDefinition(state, registryById),
    hasAnyCriteria: () => hasAnyCriteria(state),
  };
}

// ---------------------------------------------------------------------------
// Keyword scope row
// ---------------------------------------------------------------------------

function buildKeywordScopeRow(state: DialogCriteriaState, touch: () => void): HTMLElement {
  const row = div('st-f-kw-scope');
  const items: Array<{ label: string; get: () => boolean; set: (v: boolean) => void; input: HTMLInputElement | null }> = [
    { label: 'наименование', get: () => state.keywordInTitle, set: (v) => (state.keywordInTitle = v), input: null },
    { label: 'синонимы', get: () => state.keywordInSynonyms, set: (v) => (state.keywordInSynonyms = v), input: null },
    { label: 'комментарий', get: () => state.keywordInComment, set: (v) => (state.keywordInComment = v), input: null },
  ];
  for (const item of items) {
    const lbl = el('label', 'checkbox-row st-f-kw-scope-item') as HTMLLabelElement;
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = item.get();
    item.input = cb;
    cb.addEventListener('change', () => {
      item.set(cb.checked);
      // Last checked guard: default back to title+synonyms when all cleared.
      if (!state.keywordInTitle && !state.keywordInSynonyms && !state.keywordInComment) {
        state.keywordInTitle = true;
        state.keywordInSynonyms = true;
      }
      for (const other of items) other.input!.checked = other.get();
      touch();
    });
    lbl.append(cb, span(item.label));
    row.append(lbl);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Property condition row + value editor
// ---------------------------------------------------------------------------

interface ConditionRowOpts {
  networkId: string;
  cond: DialogPropertyCondition;
  index: number;
  state: DialogCriteriaState;
  registryById: Map<string, NetworkProperty>;
  touch: () => void;
  renderConditions: () => void;
}

function buildConditionRow(opts: ConditionRowOpts): HTMLElement {
  const { networkId, cond, index, state, registryById, touch, renderConditions } = opts;
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
    renderConditions();
    touch();
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
    renderConditions();
    touch();
  });

  // Value editor.
  const valueBox = buildConditionValueEditor({
    networkId,
    cond,
    index,
    state,
    registryById,
    touch,
  });

  const remove = el('button', 'st-f-remove', '×') as HTMLButtonElement;
  remove.type = 'button';
  remove.addEventListener('click', () => {
    state.properties = state.properties.filter((_, i) => i !== index);
    renderConditions();
    touch();
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
  touch: () => void;
}

function buildConditionValueEditor(opts: ConditionValueOpts): HTMLElement {
  const { networkId, cond, index, state, registryById, touch } = opts;
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
    touch();
  };

  const buildScalar = (i: number): HTMLElement => {
    if (valueType === 'number') {
      return buildScalarInput('number', live().values[i] ?? '', (v) => setValue(i, v));
    }
    if (valueType === 'date') {
      return buildDateValueRow(networkId, live().values[i] ?? '', cond.op, (v) => setValue(i, v));
    }
    if (valueType === 'bool') {
      return buildBoolSelect(live().values[i] ?? '', (v) => setValue(i, v));
    }
    if (valueType === 'thought_ref') {
      return buildThoughtRefInput(networkId, def, live().values[i] ?? '', cond.op, (v) => setValue(i, v));
    }
    // text/url: free input + token button.
    return buildTextValueRow(networkId, live().values[i] ?? '', valueType, cond.op, (v) => setValue(i, v));
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
        touch();
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
  const tokenBtn = makeTokenBtn(networkId, { kind: 'property', valueType, op }, (token) => {
    insertTokenAtCaret(input, token, onChange);
  });
  row.append(input, tokenBtn);
  return row;
}

/** Value editor for `thought_ref` conditions: freely editable (id or token) +
 *  `{…}` token button + «выбрать» (thought picker respecting `allowed_type_ids`). */
function buildThoughtRefInput(
  networkId: string,
  def: NetworkProperty | undefined,
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

  const tokenBtn = makeTokenBtn(networkId, { kind: 'property', valueType: 'thought_ref', op }, (token) => {
    insertTokenAtCaret(input, token, onChange);
  });

  const pick = el('button', 'st-f-add st-f-ref-pick', 'выбрать') as HTMLButtonElement;
  pick.type = 'button';
  pick.addEventListener('click', () => {
    const allowedIds = allowedTypeIdsOf(def);
    void pickThoughtsDialog({
      networkId,
      allowCreate: false,
      allowLinkType: false,
      searchTypeIds: allowedIds,
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

/** `allowed_type_ids` / `allowed_type_id` свойства, без пустых. */
function allowedTypeIdsOf(def: NetworkProperty | undefined): string[] {
  const config = def?.config as { allowed_type_ids?: string[]; allowed_type_id?: string } | undefined;
  const ids = config?.allowed_type_ids ?? (config?.allowed_type_id !== undefined ? [config.allowed_type_id] : []);
  return ids.filter((id) => id !== '');
}

/** Value editor for `date` conditions: literal ISO date or token with ±Nd. */
function buildDateValueRow(
  networkId: string,
  value: string,
  op: StructurePropertyOp,
  onChange: (v: string) => void,
): HTMLElement {
  const row = div('st-f-value-row');
  const input = el('input', 'st-f-input') as HTMLInputElement;
  input.type = 'text';
  input.value = value;
  input.placeholder = 'YYYY-MM-DD или токен ($today+7d)…';
  input.addEventListener('input', () => onChange(input.value));
  const tokenBtn = makeTokenBtn(networkId, { kind: 'property', valueType: 'date', op }, (token) => {
    insertTokenAtCaret(input, token, onChange);
  });
  row.append(input, tokenBtn);
  return row;
}

/** Inserts a token at the caret (or replaces the value) and refocuses. */
function insertTokenAtCaret(input: HTMLInputElement, token: string, onChange: (v: string) => void): void {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const next = input.value.slice(0, start) + token + input.value.slice(end);
  input.value = next;
  onChange(next);
  input.focus();
  const caret = start + token.length;
  try {
    input.setSelectionRange(caret, caret);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Author condition row
// ---------------------------------------------------------------------------

interface AuthorRowOpts {
  label: string;
  field: 'author' | 'editor';
  op: StructureAuthorOp;
  singleId: string;
  listIds: string[];
  onOpChange: (op: StructureAuthorOp) => void;
  onSingleChange: (id: string) => void;
  onListChange: (ids: string[]) => void;
}

const AUTHOR_OP_LABELS: Record<StructureAuthorOp, string> = {
  eq: 'равен',
  ne: 'не равен',
  in: 'в списке',
  not_in: 'не в списке',
  empty: 'не заполнено',
  not_empty: 'заполнено',
};

function buildAuthorRow(networkId: string, opts: AuthorRowOpts): HTMLElement {
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

  const isList = opts.op === 'in' || opts.op === 'not_in';
  if (isList) {
    row.append(buildAuthorListEditor(networkId, opts));
    return row;
  }

  // Одиночное значение: свободный ввод (id или токен) + `{…}` + выбор
  // пользователя из каталога.
  const single = div('author-single-wrap');
  const input = el('input', 'st-f-input') as HTMLInputElement;
  input.type = 'text';
  input.value = opts.singleId;
  input.placeholder = 'id или токен…';
  input.addEventListener('input', () => opts.onSingleChange(input.value));
  const tokenBtn = makeTokenBtn(networkId, { kind: opts.field }, (token) => {
    input.value = token;
    opts.onSingleChange(token);
    input.focus();
  });
  single.append(input, tokenBtn);
  single.append(
    buildUserSelectWidget({
      label: '',
      currentId: opts.singleId,
      onChange: (id) => {
        input.value = id;
        opts.onSingleChange(id);
      },
    }),
  );
  row.append(single);
  return row;
}

/**
 * Редактор списка автора/редактора: чипы выбранных значений (имена
 * пользователей или тексты токенов), кнопка токен-пикера и выпадающий список
 * добавления пользователя. Держит локальную копию списка и сам перерисовывает
 * чипы после изменения — `opts.listIds` (внешний массив) обновляется колбэком
 * `onListChange`, но локальная копия не протухает.
 */
function buildAuthorListEditor(networkId: string, opts: AuthorRowOpts): HTMLElement {
  const wrap = div('author-list-editor');
  let ids = opts.listIds.slice();

  const chips = div('author-value-chips');
  const renderChips = (): void => {
    clear(chips);
    if (ids.length === 0) {
      chips.append(el('span', 'muted', 'не выбрано'));
      return;
    }
    for (const id of ids) {
      const chip = div('st-f-chip');
      chip.append(el('span', 'st-f-chip-label', resolveUserName(id) ?? id));
      const x = el('button', 'st-f-remove', '×') as HTMLButtonElement;
      x.type = 'button';
      x.title = 'Убрать';
      x.addEventListener('click', () => {
        ids = ids.filter((v) => v !== id);
        opts.onListChange(ids.slice());
        renderChips();
        renderAdd();
      });
      chip.append(x);
      chips.append(chip);
    }
  };

  const tokenBtn = makeTokenBtn(networkId, { kind: opts.field }, (token) => {
    ids = [...ids, token];
    opts.onListChange(ids.slice());
    renderChips();
  });

  const addSelect = el('select', 'select-input author-list-add') as HTMLSelectElement;
  const renderAdd = (): void => {
    addSelect.replaceChildren();
    const placeholder = el('option', '', '+ пользователь…') as HTMLOptionElement;
    placeholder.value = '';
    addSelect.append(placeholder);
    for (const u of listUsers()) {
      if (ids.includes(u.id)) continue;
      const opt = el('option', '', `${u.display_name ?? u.username} (${u.username})`) as HTMLOptionElement;
      opt.value = u.id;
      addSelect.append(opt);
    }
  };
  addSelect.addEventListener('change', () => {
    const id = addSelect.value;
    if (id === '') return;
    ids = [...ids, id];
    opts.onListChange(ids.slice());
    renderChips();
    renderAdd();
    addSelect.value = '';
  });

  renderChips();
  renderAdd();
  wrap.append(chips, tokenBtn, addSelect);
  return wrap;
}

// ---------------------------------------------------------------------------
// Date range row
// ---------------------------------------------------------------------------

function buildDateRangeRow(
  networkId: string,
  label: string,
  from: string,
  to: string,
  onChange: (from: string, to: string) => void,
): HTMLElement {
  const row = div('st-f-date-row');
  row.append(el('span', 'st-f-date-label', label));

  const buildField = (value: string, set: (v: string) => void): HTMLElement => {
    const wrap = div('st-f-date-field');
    const input = el('input', 'st-f-input st-f-date-input') as HTMLInputElement;
    input.type = 'text';
    input.value = value;
    input.placeholder = 'YYYY-MM-DD или токен…';
    input.addEventListener('input', () => set(input.value));
    const tokenBtn = makeTokenBtn(networkId, { kind: 'property', valueType: 'date', op: null }, (token) => {
      input.value = token;
      set(token);
      input.focus();
    });
    wrap.append(input, tokenBtn);
    return wrap;
  };

  row.append(
    span('от', 'st-f-date-tag'),
    buildField(from, (v) => onChange(v, to)),
    span('до', 'st-f-date-tag'),
    buildField(to, (v) => onChange(from, v)),
  );
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
// Pickers (parent / thought types / link types)
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
  const catalogue = kind === 'thought' ? store.state.thoughtTypes : store.state.linkTypes;
  const byId = new Map(catalogue.map((t) => [t.id, t]));
  ids.forEach((id, index) => {
    const t = byId.get(id);
    const name = t === undefined ? id : 'name' in t ? t.name : t.name_forward;
    host.append(span(name, 'st-f-chip'));
    if (index < ids.length - 1) host.append(span(', ', 'st-f-chip-sep'));
  });
}

function renderParentChips(networkId: string, ids: string[], host: HTMLElement): void {
  clear(host);
  if (ids.length === 0) {
    host.append(span('Любые', 'muted'));
    return;
  }
  // Токены (`$thought`) не резолвятся как id — показываем их текстом.
  const plain = ids.filter((id) => !id.startsWith('$'));
  void Promise.all(
    plain.map((id) => etn.thoughts.resolve(networkId, [id]).then((r) => r[0] as Thought | undefined).catch(() => undefined)),
  ).then((refs) => {
    clear(host);
    const byId = new Map(refs.map((r, i) => [plain[i]!, r?.title ?? '(не найдено)']));
    ids.forEach((id, index) => {
      const label = id.startsWith('$') ? id : (byId.get(id) ?? '(не найдено)');
      host.append(span(label, 'st-f-chip'));
      if (index < ids.length - 1) host.append(span(', ', 'st-f-chip-sep'));
    });
  });
}

// ---------------------------------------------------------------------------
// Token picker
// ---------------------------------------------------------------------------

/** Поле, к которому пристёгнут токен-пикер. */
type TokenPickerField =
  | { kind: 'property'; valueType: PropertyValueType; op: StructurePropertyOp | null }
  | { kind: 'keywords' }
  | { kind: 'thought_type' }
  | { kind: 'parent' }
  | { kind: 'author' }
  | { kind: 'editor' };

/** Собирает кнопку токен-пикера `{…}` для переданного поля. */
function makeTokenBtn(
  networkId: string,
  field: TokenPickerField,
  onInsert: (token: string) => void,
): HTMLButtonElement {
  const tokenBtn = el('button', 'st-f-token-btn', '{…}') as HTMLButtonElement;
  tokenBtn.type = 'button';
  setTooltip(tokenBtn, 'Вставить токен');
  tokenBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openTokenPicker(networkId, tokenBtn, field, onInsert);
  });
  return tokenBtn;
}

/**
 * Opens the token-picker dropdown next to `anchor`. The list is grouped by
 * section (`Глобальные`, `Поля мысли`, `Свойства «<тип>»`).
 */
async function openTokenPicker(
  networkId: string,
  anchor: HTMLElement,
  field: TokenPickerField,
  onInsert: (token: string) => void,
): Promise<void> {
  const chainProps = activeChainProps ?? [];
  let tokens: ViewToken[];
  let op: StructurePropertyOp | null = null;
  if (field.kind === 'property') {
    tokens = buildTokensForField(chainProps, field.valueType, field.op);
    op = field.op;
  } else if (field.kind === 'parent') {
    tokens = [{ text: '$thought', label: '$thought — id мысли в фокусе', section: 'Поля мысли' }];
  } else {
    tokens = buildTokensForSpecialField(chainProps, field.kind);
  }
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
