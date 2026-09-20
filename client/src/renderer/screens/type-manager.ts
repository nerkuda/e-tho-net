/**
 * Type catalogue management (L6 + L21 hierarchy, 08-ui-spec.md §8.4).
 *
 * Opened from the toolbar «Вид» menu:
 *  - «Типы мыслей» / «Типы связей» — a **tree** of types (root «основной тип»
 *    always expanded, other nodes collapsed; the root has no delete mark and
 *    is not assignable to thoughts/links): icon, name rendered with the
 *    type's own colours/font, short description. Both lists carry a
 *    «Количество» column (own record count; a group type shows the sum over
 *    its subtree, task «Улучшить диалог редактирования типов мыслей и
 *    связей»), a name-search row (matches + their ancestor chains stay
 *    visible, branches auto-expand) and — thought types only, being the deep
 *    hierarchy — «Свернуть все»/«Развернуть все». «Добавить» opens the
 *    editor, each row has a delete button (the server rejects deleting the
 *    root or a type that still has subordinate types). Deleting a used type
 *    is forced: thoughts/links keep existing with `type_id = null`, and the
 *    type's property bindings are dropped server-side (stored values become
 *    values-outside-type).
 *
 * Type editors (task «Улучшить диалог редактирования типов мыслей и связей»)
 * are one and the same staged form for a NEW and an EXISTING type: icon,
 * colours/font (or line style), parent, description, comment template and
 * the own property bindings are editable right away, nothing is inert, and
 * nothing touches the server until «Применить и закрыть» is pressed.
 * «Отмена» (also Esc/×/backdrop) closes the dialog discarding the whole
 * draft. Reparenting is validated as before: the parent picker filters
 * cycles/depth client-side and the server rejects a type in use, cycles and
 * nesting past 4 levels.
 *
 * Property sections (since 0.6.5):
 *  - «Свойства типа» — the type's own BINDINGS to the network property
 *    registry, staged in a local draft (`type-property-draft.ts`): the
 *    editor attaches existing registry properties or creates new ones, and
 *    on existing bindings it toggles `required` and reorders ▲/▼. All edits
 *    are local until the editor's «Применить и закрыть» reconciles them
 *    with the server (unbinds first, then attaches/creates, then `set-role`
 *    patches, one trailing reorder). The property's NATURE (name, value
 *    type, config, description) is NOT editable here — it is shared by every
 *    type that binds it and lives in the registry; the table's «✎» button
 *    jumps to the property manager dialog with a banner warning about the
 *    network-wide impact.
 *  - «Унаследованные свойства» — bindings inherited from the ancestors. The
 *    default value of a binding is editable right in the table (0.8.2, ADR
 *    «дефолт свойства живёт на привязке»): filled = the default of THIS
 *    binding, empty = the common value of the binding's side (tooltip in the
 *    empty cell); clearing the field resets the override. No
 *    «(общее)»/«частное»/«сбросить» modes. Черновик дефолтов пишется одним
 *    набором `setPropertyDefaultOverride` на «Применить и закрыть», как и
 *    остальные правки вкладки. The description override keeps its own small
 *    dialog with an explicit «Применить» and writes immediately.
 *    `required` is NOT editable on inherited bindings — it belongs to the
 *    type that attached the binding, the inherited view is a preview of the
 *    effective value. For a type that is still being created the section
 *    previews what the picked parent will pass down.
 *
 * Link-type editor: forward/reverse names, ⚙ (line-style dialog, type mode —
 * a reset inherits the parent's style since L21), description and the same
 * property sections (link types gained a property table in L21).
 */

import type {
  EffectiveTypeProperty,
  IconKind,
  LinkPropertySide,
  LinkType,
  PropertyConfig,
  PropertyDefinition,
  PropertyValueType,
  ThoughtType,
  ThoughtTypeInput,
  ThoughtTypeUpdateInput,
  LinkTypeUpdateInput,
  TypeOwnerType,
} from '@etn/shared';
import { buildLinkValueEditor, buildValueEditor, linkAllowedTypeIds } from '../editor/value-editor.js';
import { typeNameKey } from '@etn/shared';

import { requireNetworkId, scheduleRefresh } from '../app.js';
// Иконки превью типов — каноном общей фабрики облачка (пилюля типа — не
// мысль, но использует тот же единый канон).
import { applyThoughtIcon } from '../lib/thought-cloud.js';
import { confirmDialog, errorDialog, raiseOpenDialog, showDialog, type DialogButton } from '../lib/dialog.js';
import { button, div, el, errText, setTooltip, span, applyFontFlags } from '../lib/dom.js';
import { svgIcon } from '../lib/icons.js';
import { etn } from '../lib/etn.js';
import { acquireOrShowBlocked, lockHandleFromOutcome, releaseHeld, type LockHandle } from '../lib/lock-guard.js';
import {
  MAX_TYPE_DEPTH,
  aggregateTypeCounts,
  flattenTypeTree,
  buildTypeTree,
  findRootType,
  orderedTypeRows,
  resolveLinkTypeVisual,
  resolveThoughtTypeVisual,
  subtreeTypeIds,
  typeChainOf,
  typeDepth,
  subtreeHeight,
  typeSearchVisibleIds,
  type FlatTypeRow,
} from '../lib/type-tree.js';
import { buildEntityCombo, normalizeParentTypeId, type EntityOption } from '../lib/entity-picker.js';
// Локальные уведомления открытого редактора об изменении набора свойств типа
// (ошибка 74b94c26), самого типа (8dd5dfed) и его удаления (7dfad7d4): своё
// realtime-эхо до рендерера не доходит (G8 applier).
import {
  notifyTypeChanged,
  notifyTypeDefinitionsChanged,
  typeDeletedFacts,
  typeUpdateFacts,
} from '../lib/type-definitions.js';
import {
  cacheAttachedRegistryRow,
  canReorderBinding,
  draftPropertiesFrom,
  moveDraftRow,
  nextDraftPropertyId,
  opToAttachInput,
  planPropertyDiff,
  type DraftProperty,
} from '../lib/type-property-draft.js';
import {
  defaultLinkValues,
  emptyDefaultHint,
  isEmptyDefault,
  linkDefaultPayload,
  openPropertyManagerEditor,
  scalarDefaultPayload,
  type RegistryRow,
} from './property-manager.js';
import {
  buildPropertyList,
  buildPropertyListRows,
  ensurePropertyLinkTypes,
  rowBlockReason,
  type PropertyListRow,
} from '../lib/property-list.js';
import { buildViewsTab } from './thought-type/views-tab.js';
import { store } from '../state.js';
import { showIconDialog } from '../editor/icon-dialog.js';
import { createMarkdownField } from '../editor/markdown-field.js';
import { showLinkStyleDialog, showThoughtStyleDialog } from '../editor/style-dialog.js';
import { renderMarkdown } from '@etn/markdown';
import { buildMetadataRows, type MetadataFields } from '../lib/metadata.js';

/** Human-readable property value-type labels. */
const VALUE_TYPE_LABELS: Record<PropertyValueType, string> = {
  text: 'строка',
  number: 'число',
  date: 'дата',
  bool: 'булево',
  url: 'URL (сайт или файл)',
  link: 'связь',
  // Legacy (миграция 040): в живой БД таких свойств не остаётся, но в
  // типах маркер оставлен для компиляции тестов и импорта архивов.
  thought_ref: 'ссылка на мысль (legacy)',
};

/** Reloads the thought-type catalogue (selects and cloud styles read it). */
async function refreshThoughtTypes(): Promise<void> {
  const networkId = requireNetworkId();
  store.update({ thoughtTypes: await etn.types.listThoughtTypes(networkId) });
}

/** Reloads the link-type catalogue (line labels/colours read it). */
async function refreshLinkTypes(): Promise<void> {
  const networkId = requireNetworkId();
  store.update({ linkTypes: await etn.types.listLinkTypes(networkId) });
}

/** Applies a type's own colours/font flags to an element (list name cells). */
function applyTypeStyle(
  target: HTMLElement,
  t: Pick<ThoughtType, 'fg_color' | 'bg_color' | 'font_bold' | 'font_italic' | 'font_underline' | 'font_strike'>,
): void {
  if (t.fg_color !== null) target.style.color = t.fg_color;
  if (t.bg_color !== null) target.style.background = t.bg_color;
  applyFontFlags(target, {
    bold: t.font_bold ?? false,
    italic: t.font_italic ?? false,
    underline: t.font_underline ?? false,
    strike: t.font_strike ?? false,
  });
}

/** Shape of the staged thought-type draft — the editable fields the new-type
 *  dialog applies on «Применить и закрыть». */
export interface ThoughtTypeDraft {
  name: string;
  parent_id: string | null;
  description: string;
  icon: string | null;
  icon_kind: IconKind;
  fg_color: string | null;
  bg_color: string | null;
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
}

/**
 * Builds the minimal `POST /thought-types` payload from the staged draft
 * (regression for 0ab4749b — `font_bold должен быть логическим значением`).
 *
 * The server treats `font_*` / `fg_color` / `bg_color` / `icon` as
 * `null`-or-value (`null` — inherit from parent), and `font_*` are
 * `boolean | null` on the wire. Sending `null` for an untouched field IS
 * legal, but the minimal payload keeps the create free of obvious
 * `null on first sight` noise and avoids the historical regression of
 * accidentally pushing the dialog's initial `null` defaults through the
 * route layer. Each field is included only when it differs from the
 * create-time default.
 */
export function buildCreateTypeInput(
  draft: ThoughtTypeDraft,
  descriptionRaw: string,
  nextTemplate: string | null,
): ThoughtTypeInput {
  const input: ThoughtTypeInput = { name: draft.name };
  if (draft.parent_id !== null) input.parent_id = draft.parent_id;
  const descriptionValue = descriptionRaw.trim() === '' ? null : descriptionRaw.trim();
  if (descriptionValue !== null) input.description = descriptionValue;
  if (draft.icon !== null) {
    input.icon = draft.icon;
    input.icon_kind = draft.icon_kind;
  }
  if (draft.fg_color !== null) input.fg_color = draft.fg_color;
  if (draft.bg_color !== null) input.bg_color = draft.bg_color;
  if (draft.font_bold !== null) input.font_bold = draft.font_bold;
  if (draft.font_italic !== null) input.font_italic = draft.font_italic;
  if (draft.font_underline !== null) input.font_underline = draft.font_underline;
  if (draft.font_strike !== null) input.font_strike = draft.font_strike;
  if (nextTemplate !== null) input.comment_template_md = nextTemplate;
  return input;
}

/**
 * Builds the minimal `PATCH /thought-types/{id}` payload from the staged draft:
 * only the fields that actually differ from the last server-side state go out
 * (If-Match uses that state's version). Consistent with
 * {@link buildCreateTypeInput}: the trimmed description and the template are
 * normalised to `null` when empty, so an emptied field clears the value.
 *
 * Used by BOTH save paths of the editor — «Записать» (save, stay open) and
 * «Применить и закрыть»: the two differ only in whether the dialog closes,
 * the payload is identical.
 */
export function buildTypePatchInput(
  current: ThoughtType,
  draft: ThoughtTypeDraft,
  descriptionRaw: string,
  nextTemplate: string | null,
): ThoughtTypeUpdateInput {
  const input: ThoughtTypeUpdateInput = {};
  const name = draft.name.trim();
  if (name !== current.name) input.name = name;
  if (draft.parent_id !== (current.parent_id ?? null)) input.parent_id = draft.parent_id;
  if (draft.icon !== current.icon) {
    input.icon = draft.icon;
    input.icon_kind = draft.icon_kind;
  }
  if (draft.fg_color !== current.fg_color) input.fg_color = draft.fg_color;
  if (draft.bg_color !== current.bg_color) input.bg_color = draft.bg_color;
  if (draft.font_bold !== current.font_bold) input.font_bold = draft.font_bold;
  if (draft.font_italic !== current.font_italic) input.font_italic = draft.font_italic;
  if (draft.font_underline !== current.font_underline) input.font_underline = draft.font_underline;
  if (draft.font_strike !== current.font_strike) input.font_strike = draft.font_strike;
  const description = descriptionRaw.trim() === '' ? null : descriptionRaw.trim();
  if (description !== (current.description ?? null)) input.description = description;
  if (nextTemplate !== (current.comment_template_md ?? null)) {
    input.comment_template_md = nextTemplate;
  }
  return input;
}

/**
 * Ids of the ancestors that must be expanded for the row of `typeId` to be
 * visible in a type tree. The edited type itself is excluded (its own row is
 * shown once its ancestors are open). Used by the type list to reveal the
 * «current row» right after a save (ошибка 51732f9b): a freshly created type
 * under a collapsed parent was otherwise invisible and had to be searched for.
 */
export function typeRowRevealIds(
  types: readonly ThoughtType[],
  typeId: string | null,
): string[] {
  return typeChainOf(types, typeId)
    .slice(1)
    .map((t) => t.id);
}

// ---------------------------------------------------------------------------
// Tree rows for the catalogue dialogs (L21): expand/collapse per dialog.
// ---------------------------------------------------------------------------

/** Rows of a type tree restricted to the expanded nodes. */
function visibleRows<T extends { id: string; parent_id: string | null; is_root: boolean }>(
  types: readonly T[],
  expanded: ReadonlySet<string>,
): FlatTypeRow<T>[] {
  return flattenTypeTree(buildTypeTree(types), expanded);
}

/** The ▸/▾ expander button of a tree row (hidden for leaves). */
function treeToggle(
  row: FlatTypeRow<{ id: string; parent_id: string | null; is_root: boolean }>,
  expanded: ReadonlySet<string>,
  onToggle: () => void,
  /** While a name search is filtering the list, branches are shown by the
   *  search itself (matches + ancestor chain) — the toggle renders expanded
   *  and inert so it does not fight the search's own expansion. */
  forceOpen = false,
): HTMLElement {
  const btn = button('', onToggle, 'btn small type-tree-toggle', row.hasChildren ? 'Развернуть/свернуть' : '');
  btn.textContent = row.hasChildren ? (forceOpen || expanded.has(row.type.id) ? '▾' : '▸') : '';
  btn.disabled = !row.hasChildren || forceOpen;
  return btn;
}

// ---------------------------------------------------------------------------
// Thought types: tree list + editor
// ---------------------------------------------------------------------------

/** Opens the thought-types tree dialog (L6/L21). */
export function showThoughtTypesDialog(): void {
  const networkId = requireNetworkId();
  const errorLine = span('', 'error-text');
  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '340px';
  const body = div('form-stack');

  // Toolbar (top of the list, task «Улучшить диалог…»): «Добавить»,
  // «Свернуть все»/«Развернуть все» and the name-search box.
  const toolbar = div('form-row type-list-toolbar');
  const searchInput = el('input', 'text-input') as HTMLInputElement;
  searchInput.type = 'text';
  searchInput.placeholder = 'Поиск по названию…';
  toolbar.append(
    button('Добавить', () => showThoughtTypeEditor(null, onChanged), 'btn small', 'Создать тип'),
    button('Свернуть все', () => collapseAll(), 'btn small', 'Свернуть всю иерархию'),
    button('Развернуть все', () => expandAll(), 'btn small', 'Развернуть всю иерархию'),
    searchInput,
  );
  body.append(toolbar, tableWrap, errorLine);

  // L21: the root type is always expanded; everything else starts collapsed.
  let expanded = new Set<string>();
  let searchQuery = '';
  // Last loaded catalogue — tree toggles/search re-render from this cache,
  // without a network round-trip and without the «Загрузка…» placeholder, so
  // expanding/collapsing/typing does not flicker or jump the scroll position.
  let cachedTypes: ThoughtType[] | null = null;
  let cachedCounts: Record<string, number> | null = null;
  // «Текущая строка» списка: тип, который пользователь только что
  // отредактировал (или создал) в открытом отсюда редакторе. Строка
  // подсвечивается, её цепочка родителей разворачивается, и список
  // прокручивается к ней — иначе новый тип приходилось искать вручную
  // (ошибка 51732f9b).
  let currentRowId: string | null = null;

  // Редактор сообщает id записанного типа («Применить и закрыть» и «Записать»)
  // вторым аргументом — он и становится текущей строкой.
  const onChanged = (appliedTypeId?: string): void => {
    if (appliedTypeId !== undefined) currentRowId = appliedTypeId;
    void reload();
  };

  async function reload(useCache = false): Promise<void> {
    const scrollTop = tableWrap.scrollTop;
    let types: ThoughtType[];
    let counts: Record<string, number>;
    if (useCache && cachedTypes !== null && cachedCounts !== null) {
      types = cachedTypes;
      counts = cachedCounts;
    } else {
      tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
      try {
        [types, counts] = await Promise.all([
          etn.types.listThoughtTypes(networkId),
          etn.types.getThoughtTypeCounts(networkId),
        ]);
      } catch (err) {
        tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
        return;
      }
      cachedTypes = types;
      cachedCounts = counts;
    }
    if (expanded.size === 0) {
      expanded = new Set(types.filter((t) => t.is_root).map((t) => t.id));
    }
    const aggregated = aggregateTypeCounts(types, counts);
    const searching = searchQuery.trim() !== '';
    const keepIds = typeSearchVisibleIds(types, searchQuery);
    // Searching shows every matched branch fully expanded (task's «ветви до
    // совпадений разворачиваются автоматически»); otherwise the manual
    // expand/collapse state applies as before.
    let rows = (
      searching ? flattenTypeTree(buildTypeTree(types), new Set(types.map((t) => t.id))) : visibleRows(types, expanded)
    ).filter((row) => keepIds.has(row.type.id));
    // Текущая строка обязана быть видна: если её цепочка родителей свёрнута,
    // разворачиваем её (при поиске ветви и так раскрыты). Иначе после создания
    // типа с нестандартным родителем строку пришлось бы искать вручную.
    if (currentRowId !== null && !searching && !rows.some((row) => row.type.id === currentRowId)) {
      const reveal = typeRowRevealIds(types, currentRowId);
      if (reveal.some((id) => !expanded.has(id))) {
        expanded = new Set([...expanded, ...reveal]);
        rows = visibleRows(types, expanded).filter((row) => keepIds.has(row.type.id));
      }
    }
    const table = el('table', 'table-list');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th', undefined, 'Тип'),
      el('th', undefined, 'Комментарий'),
      el('th', undefined, 'Количество'),
      el('th'),
    );
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    if (rows.length === 0) {
      const emptyRow = el('tr');
      const emptyCell = el('td', 'muted', searching ? 'Ничего не найдено.' : 'Нет типов.');
      emptyCell.colSpan = 4;
      emptyRow.append(emptyCell);
      tbody.append(emptyRow);
    }
    let currentTr: HTMLElement | null = null;
    for (const row of rows) {
      const type = row.type;
      const tr = el('tr');
      if (type.is_root) tr.classList.add('type-tree-root');
      if (type.id === currentRowId) {
        tr.classList.add('selected');
        currentTr = tr;
      }
      const nameCell = el('td');
      nameCell.style.whiteSpace = 'nowrap';
      const nameWrap = span('', 'type-tree-name');
      nameWrap.style.paddingLeft = `${Math.max(0, row.depth - 1) * 18}px`;
      nameWrap.append(treeToggle(row, expanded, () => void toggle(type.id), searching));
      // L21: the row shows the EFFECTIVE look — a subordinate type renders
      // with the icon/colours/font inherited from its ancestors.
      const visual = resolveThoughtTypeVisual(types, type.id);
      const icon = span('', 'mini-icon');
      applyThoughtIcon(icon, { icon: visual.icon, icon_kind: visual.icon_kind, type_id: null });
      const name = span(type.name, 'type-list-name');
      applyTypeStyle(name, {
        fg_color: visual.fg_color,
        bg_color: visual.bg_color,
        font_bold: visual.font_bold ?? false,
        font_italic: visual.font_italic ?? false,
        font_underline: visual.font_underline ?? false,
        font_strike: visual.font_strike ?? false,
      });
      nameWrap.append(icon, name);
      nameCell.append(nameWrap);
      const descCell = el('td', 'muted', (type.description ?? '').slice(0, 120));
      descCell.style.maxWidth = '280px';
      descCell.style.overflow = 'hidden';
      descCell.style.textOverflow = 'ellipsis';
      descCell.style.whiteSpace = 'nowrap';
      const countCell = el('td', 'muted', String(aggregated[type.id] ?? 0));
      countCell.style.textAlign = 'right';
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      if (!type.is_root) {
        actions.append(button('✕', () => void removeRow(type), 'btn small', 'Удалить тип'));
      }
      tr.append(nameCell, descCell, countCell, actions);
      // Clicks on the ▸/▾ toggle or the ✕ button must not open the editor.
      tr.addEventListener('click', (event) => {
        if (event.target instanceof HTMLElement && event.target.closest('button') !== null) return;
        showThoughtTypeEditor(type, onChanged);
      });
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
    tableWrap.scrollTop = scrollTop;
    // Список прокручивается к текущей строке — она может быть ниже видимой
    // части (высота обёртки ограничена).
    currentTr?.scrollIntoView({ block: 'nearest' });
  }

  /** Expands/collapses a node and re-renders from the cache (no round-trip). */
  function toggle(typeId: string): void {
    if (expanded.has(typeId)) expanded.delete(typeId);
    else expanded.add(typeId);
    void reload(true);
  }

  /** «Развернуть все»: opens every branch of the hierarchy. */
  function expandAll(): void {
    if (cachedTypes !== null) expanded = new Set(cachedTypes.map((t) => t.id));
    void reload(true);
  }

  /** «Свернуть все»: back to just the root expanded (the initial state). */
  function collapseAll(): void {
    if (cachedTypes !== null) expanded = new Set(cachedTypes.filter((t) => t.is_root).map((t) => t.id));
    void reload(true);
  }

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    void reload(true);
  });

  /** Deletes a thought type (forced: thoughts detached, values dropped). */
  async function removeRow(type: ThoughtType): Promise<void> {
    const ok = await confirmDialog(
      'Удалить тип',
      `Удалить тип «${type.name}»? Мысли этого типа останутся и станут без типа; ` +
        'значения свойств этого типа будут удалены.',
      true,
    );
    if (!ok) return;
    try {
      await etn.types.removeThoughtType(networkId, type.id, type.version, true);
      await refreshThoughtTypes();
      scheduleRefresh();
      // Удалённый тип уходит из цепочки типов показанной сущности (ошибка
      // 7dfad7d4): открытый редактор обязан пометить тип исчезнувшим,
      // перечитать «Свойства» и отвязать показанную сущность. Своё
      // realtime-эхо до рендерера не доходит (G8 applier), поэтому уведомляем
      // локально — каталог перечитан строкой выше, значит шапку можно
      // перерисовать сразу и по свежим данным.
      notifyTypeChanged(typeDeletedFacts({ ownerType: 'thought_type', ownerId: type.id }));
      // Удалённый тип не может остаться текущей строкой.
      if (currentRowId === type.id) currentRowId = null;
      onChanged();
    } catch (err) {
      errorDialog('Удалить тип', err);
    }
  }

  showDialog({
    title: 'Типы мыслей',
    body,
    width: 640,
    buttons: [{ label: 'Закрыть', primary: true }],
  });
  void reload();
}

// ---------------------------------------------------------------------------
// Parent picker (L21) — shared by both type editors
// ---------------------------------------------------------------------------

/**
 * The parent-picker combobox of a type editor. Options exclude the root type
 * (it is represented by the single «без родителя» entry — attaching under
 * the root is the same thing, 08-ui-spec.md §8.1), the edited type itself,
 * its descendants and any parent that would push the tree past
 * {@link MAX_TYPE_DEPTH} levels. The full tree is expanded on open; typing
 * filters it to matching rows. Rows carry the same icon/style (thoughts) or
 * line swatch (links) as the other type lists.
 */
function buildParentPicker(opts: {
  kinds: 'thought' | 'link';
  /** The edited type (null while it is being created). */
  currentId: () => string | null;
  /** Current parent id; the root id is normalized to `null` («без родителя»). */
  value: string | null;
  onChange: (parentId: string | null) => void;
}): { root: HTMLElement } {
  const { kinds, currentId, value, onChange } = opts;
  const types = (): typeof store.state.thoughtTypes | typeof store.state.linkTypes =>
    kinds === 'thought' ? store.state.thoughtTypes : store.state.linkTypes;
  const rootId = types().find((t) => t.is_root)?.id ?? null;
  const optionRows = (): EntityOption[] => {
    // Candidate parents: every type except the root, the edited one and its
    // descendants; the depth cap must hold for the resulting subtree.
    const allowed = (id: string): boolean => {
      if (id === rootId) return false;
      const selfId = currentId();
      if (selfId !== null) {
        if (id === selfId) return false;
        if (subtreeTypeIds(types(), selfId).has(id)) return false;
      }
      const subtree = selfId !== null ? subtreeHeight(types(), selfId) : 1;
      return typeDepth(types(), id) + subtree <= MAX_TYPE_DEPTH;
    };
    if (kinds === 'thought') {
      return orderedTypeRows(store.state.thoughtTypes)
        .filter((row) => allowed(row.type.id))
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
    return orderedTypeRows(store.state.linkTypes)
      .filter((row) => allowed(row.type.id))
      .map((row) => {
        const line = resolveLinkTypeVisual(store.state.linkTypes, row.type.id);
        const title = `${row.type.name_forward} / ${row.type.name_reverse}`;
        return {
          id: row.type.id,
          title,
          parentId: row.type.parent_id,
          depth: row.depth - 1,
          hasChildren: row.hasChildren,
          selectable: true,
          cloud: { id: row.type.id, title, icon: '🔗', icon_kind: 'emoji' as const },
          line: { color: line.color, style: line.style, width: line.width },
        };
      });
  };
  const combo = buildEntityCombo({
    networkId: store.state.networkId ?? '',
    kind: kinds === 'thought' ? 'thought-types' : 'link-types',
    options: optionRows,
    // Служебный корень иерархии — «без родителя», не вариант выбора.
    value: normalizeParentTypeId(value, rootId),
    placeholder: 'без родителя',
    emptyLabel: 'без родителя',
    expandAll: true,
    onChange,
  });
  return { root: combo.root };
}

/**
 * Extra options of the type editors ({@link showThoughtTypeEditor}) for the
 * quick type creation flow: the type combobox passes the typed query so the
 * new type's name starts prefilled. Редактор типа связи упразднён в 0.8.1
 * (требование 09f692ff, задача 09201bd4): пользователь создаёт тип связи
 * через единый диалог свойства (`openPropertyManagerEditor` со значением
 * `value_type='link'`).
 */
export interface TypeEditorExtras {
  /** Prefills the name of a NEW type (its forward name for link types). */
  initialName?: string;
}

/**
 * Ширина диалога редактора типа мысли (ошибка 3c7213ec).
 *
 * Самое широкое содержимое диалога — таблица «Свойства типа» на вкладке
 * «Свойства»: шесть колонок, где «По умолчанию» держит редактор значения
 * (у свойства-связи — `.link-value-wrap` с полом 220px), а последняя —
 * кнопки ▲/▼/✎/✕ с `nowrap`. Таблица остаётся на auto-раскладке, поэтому её
 * ширина упирается в min-content строки: замер зондом на Chromium (реальный
 * `styles.css`, самый длинный набор свойств сети ETN) даёт 688px. Прежние
 * 600px отдавали таблице ≈560px — и `.admin-table-wrap` получал
 * горизонтальную прокрутку. 760px — наименьшая из стандартных «широких»
 * ширин проекта (столько же у «Настроек», «Администрирования» и диалога
 * отборов) и даёт таблице ≈720px, то есть запас над замеренным min-content.
 */
const TYPE_EDITOR_DIALOG_WIDTH = 760;

/**
 * Ключ редактора ещё не созданного типа мысли (ошибка 74d9b4ed).
 *
 * Сеансовый ключ «новая сущность этого вида»: у типа, который ещё не записан,
 * id нет, но дедупликация нужна и ему — иначе повторный клик по «Добавить»
 * («Создать новый» в комбобоксе) открывает второй редактор создания с
 * независимым черновиком (тот же путь к DUPLICATE-рассинхрону 0bfd7180).
 * Один ключ на ВСЕ точки создания нового типа мысли: второй вход поднимает уже
 * открытый редактор, а не плодит свой.
 */
const NEW_THOUGHT_TYPE_DIALOG_KEY = 'thought-type:new';

/**
 * Ключ дедупликации диалога редактора типа мысли (ошибки c2d243bb, 74d9b4ed).
 *
 * Идентичность сущности для {@link raiseOpenDialog}: повторное открытие
 * редактора ЭТОГО типа поднимает уже открытый диалог, а не плодит второй
 * черновик. Тип другого id — другой ключ, открывается поверх свободно.
 *
 * `id === null` (новый тип) даёт сеансовый ключ
 * {@link NEW_THOUGHT_TYPE_DIALOG_KEY}: пока редактор создания открыт, второго
 * не будет; после закрытия ключ снимается (каркас диалогов) и следующее
 * «Добавить» открывает свежий редактор. Ключ остаётся и после «Записать» —
 * диалог не закрывается, id в черновике не меняет идентичность ключа.
 */
export function thoughtTypeDialogKey(id: string | null): string {
  return id === null ? NEW_THOUGHT_TYPE_DIALOG_KEY : `thought-type:${id}`;
}

/**
 * Opens the thought-type editor; `type === null` edits a NEW type (L6/L21).
 *
 * One and the same form for a new and an existing type (task «Улучшить диалог
 * редактирования типов мыслей и связей»): the icon, colours/font style,
 * comment template, parent and the own property definitions are editable
 * right away — nothing is inert — and nothing touches the server until a save
 * button is pressed. Two save buttons (ошибка 51732f9b): «Записать» commits
 * the draft and KEEPS the dialog open, refreshing everything that depended on
 * the write (the «Отборы» tab of a just-created type becomes live, «Метаданные»
 * shows the real id/dates, the title stops saying «Новый»), and «Применить и
 * закрыть» commits and closes. «Отмена» (also Esc/×/backdrop) closes the
 * dialog discarding the whole draft; no type is created on that path. Дефолт
 * привязки (0.8.2) правится прямо в колонке «По умолчанию» и тоже уезжает на
 * запись; override описания сохраняет свой маленький диалог.
 * Reparenting validation is unchanged: the parent picker filters
 * cycles/depth client-side and the server re-checks on apply.
 *
 * `onChanged` is called after every successful save with the id of the type
 * written in this session — the type list uses it to make that row «current».
 *
 * `extras.initialName` prefills the name of a new type (the entity combo's
 * «Создать новый» row). The returned promise resolves when the dialog closes:
 * with the id of the type created in this session, or `null` when the dialog
 * closed without creating one (also for an existing type).
 *
 * Повторное открытие редактора того же типа (двойной клик по строке списка)
 * второй диалог не создаёт: уже открытый поднимается наверх и получает фокус
 * ({@link raiseOpenDialog}, ошибка c2d243bb) — и тогда promise сразу резолвится
 * в `null`. Тип другого id открывается поверх свободно. То же — для ещё не
 * созданного типа: ключ `thought-type:new` один на все точки создания, поэтому
 * повторный клик по «Добавить»/«Создать новый» поднимает уже открытый редактор
 * создания (ошибка 74d9b4ed).
 */
export function showThoughtTypeEditor(
  type: ThoughtType | null,
  onChanged: (appliedTypeId?: string) => void,
  extras?: TypeEditorExtras,
): Promise<string | null> {
  const networkId = requireNetworkId();
  // Повторное открытие редактора ТОГО ЖЕ типа не создаёт второй диалог: уже
  // открытый поднимается наверх и получает фокус (ошибка c2d243bb). Двойной
  // клик по строке списка даёт два события click — без этой проверки
  // открывались два редактора одного типа с независимыми черновиками (один из
  // путей к DUPLICATE-рассинхрону 0bfd7180). Для НОВОГО типа (id ещё нет) ключ
  // тоже есть — `thought-type:new`, поэтому повторный клик по «Добавить»
  // поднимает уже открытый редактор создания, а не плодит второй черновик
  // (ошибка 74d9b4ed). Проверка стоит ДО захвата блокировки и сборки тела
  // диалога: второй вызов не должен ни брать замок, ни строить черновик, ни
  // создавать неразрешимый Promise. Тип другого id не дедуплицируется.
  if (raiseOpenDialog(thoughtTypeDialogKey(type?.id ?? null))) {
    return Promise.resolve(null);
  }
  // Auto-acquire the type lock for the lifetime of the dialog (task
  // 4f141756): the editor commits on «Применить и закрыть», so the lock
  // must outlive the entire edit session. For a NEW type (id is null) we
  // pass the empty string as a placeholder entity_id — the server stores
  // the type-id once create returns, and the helper no-ops on the empty
  // pair (it just returns a soft «failed» outcome which the editor ignores).
  let editLock: LockHandle | null = null;
  if (type !== null) {
    void acquireOrShowBlocked('thought_type', type.id).then((outcome) => {
      editLock = lockHandleFromOutcome('thought_type', type.id, outcome);
    });
  }
  // The type as last seen by the SERVER: the initial one, the freshly created
  // one, or the patched one after a successful apply (a failed apply keeps it
  // at the last consistent state so a retry re-diffs correctly).
  let current: ThoughtType | null = type;
  // The id of the type created in this session — handed to the caller when
  // the dialog closes.
  let createdId: string | null = null;
  const errorLine = span('', 'error-text');
  const body = div('form-stack type-editor');

  // ---- Tabs (задача b8301c16, требование 344b8798) -----------------------
  // Состояние черновика живёт в замыкании выше (draft, templateMd, props…)
  // — при переключении вкладок ничего не теряется и ничего не пишется.
  // Единственная точка записи — «Применить и закрыть» в футере диалога.
  const TAB_KEYS = ['description', 'template', 'properties', 'views', 'metadata'] as const;
  type TabKey = (typeof TAB_KEYS)[number];
  const tabRow = div('type-editor-tabs');
  const tabPanes = new Map<TabKey, HTMLElement>();
  const tabButtons = new Map<TabKey, HTMLButtonElement>();
  let activeTab: TabKey = 'description';

  const activateTab = (key: TabKey): void => {
    activeTab = key;
    for (const [tabKey, pane] of tabPanes) {
      pane.classList.toggle('active', tabKey === key);
    }
    for (const [tabKey, btn] of tabButtons) {
      btn.classList.toggle('active', tabKey === key);
    }
  };

  const tabButton = (key: TabKey, label: string): HTMLButtonElement => {
    const btn = button(label, () => activateTab(key), 'type-editor-tab');
    btn.type = 'button';
    btn.dataset['tabKey'] = key;
    tabButtons.set(key, btn);
    return btn;
  };

  const tabPane = (key: TabKey): HTMLElement => {
    const pane = div('type-editor-tab-pane');
    tabPanes.set(key, pane);
    return pane;
  };

  tabRow.append(
    tabButton('description', 'Описание'),
    tabButton('template', 'Шаблон'),
    tabButton('properties', 'Свойства'),
    tabButton('views', 'Отборы'),
    tabButton('metadata', 'Метаданные'),
  );
  body.append(tabRow);

  const descriptionPane = tabPane('description');
  const templatePane = tabPane('template');
  const propertiesPane = tabPane('properties');
  const viewsPane = tabPane('views');
  const metadataPane = tabPane('metadata');

  // Duplicate-name guard: type names are unique ignoring case (08-ui-spec.md
  // §8.4). The catalogue is loaded once on open; the server re-checks on apply.
  const DUP_NAME_MSG = 'Тип с таким именем уже существует.';
  let allTypes: ThoughtType[] = [];
  let applyBtn: HTMLButtonElement | null = null;
  let saveBtn: HTMLButtonElement | null = null;
  /** Заголовок диалога — после первой записи «Новый тип мысли» становится
   *  «Тип мысли»: содержимое диалога обновилось, шапка не должна врать. */
  let dialogTitleEl: HTMLElement | null = null;

  // ---- The staged draft: every editable field, applied only on demand ----
  const draft = {
    name: type?.name ?? extras?.initialName ?? '',
    icon: type?.icon ?? null,
    icon_kind: type?.icon_kind ?? 'emoji',
    fg_color: type?.fg_color ?? null,
    bg_color: type?.bg_color ?? null,
    font_bold: type?.font_bold ?? null,
    font_italic: type?.font_italic ?? null,
    font_underline: type?.font_underline ?? null,
    font_strike: type?.font_strike ?? null,
    parent_id: type !== null && type.parent_id !== null ? type.parent_id : null,
    description: type?.description ?? '',
  };
  /** Draft of the comment template (staged like everything else). */
  let templateMd = type?.comment_template_md ?? '';

  // Top row: icon · name · settings (⚙) — all active from the very start.
  const topRow = div('editor-top-row');
  const iconBox = el('button', 'editor-icon-box') as HTMLButtonElement;
  iconBox.type = 'button';
  setTooltip(iconBox, 'Иконка типа');
  const renderIcon = (): void => {
    applyThoughtIcon(iconBox, { icon: draft.icon, icon_kind: draft.icon_kind, type_id: null });
  };
  renderIcon();
  iconBox.addEventListener('click', () => {
    showIconDialog({
      current: { icon: draft.icon, kind: draft.icon_kind },
      onPick: (result) => {
        draft.icon = result.icon;
        draft.icon_kind = result.kind;
        renderIcon();
        return Promise.resolve(true);
      },
    });
  });
  const nameInput = el('input', 'text-input');
  nameInput.type = 'text';
  nameInput.value = draft.name;
  nameInput.maxLength = 200;
  nameInput.placeholder = 'Название типа (обязательно)';
  const settingsBtn = button('', openStyle, 'icon-btn', 'Настройки типа');
  settingsBtn.append(svgIcon('settings', 14));
  topRow.append(iconBox, nameInput, settingsBtn);
  descriptionPane.append(topRow);

  // Parent picker (L21). The root type has no parent; the picked value is
  // staged and re-checked by the server on apply (a type in use cannot be
  // reparented, no cycles, max 4 levels).
  const parentField = div('field');
  const parentLabel = el('p', 'muted', 'Родитель (наследование свойств и стиля)');
  parentLabel.style.margin = '8px 0 2px';
  if (type?.is_root === true) {
    const rootNote = el('p', 'muted', 'Корневой тип — родителя не имеет.');
    rootNote.style.margin = '0';
    parentField.append(rootNote);
  } else {
    // Ссылка `props` объявлена ниже; функция обновит превью унаследованных
    // свойств при смене родителя у НОВОГО типа.
    const picker = buildParentPicker({
      kinds: 'thought',
      currentId: () => current?.id ?? null,
      value: draft.parent_id,
      onChange: (parentId) => {
        draft.parent_id = parentId;
        if (current === null) props.refreshPreview();
      },
    });
    parentField.append(picker.root);
  }
  descriptionPane.append(parentField);

  // Comment (type description / usage rules) — placeholder only, no label.
  const descArea = el('textarea', 'textarea-input');
  descArea.value = draft.description;
  descArea.rows = 3;
  descArea.placeholder = 'Комментарий: описание типа, правила применения…';
  descriptionPane.append(descArea);

  // Строка ошибки диалога живёт в панели кнопок (футер), а не в теле вкладки:
  // сообщение о неудачной записи обязано быть видно на ЛЮБОЙ вкладке
  // (ошибка add8d09d). В футер её кладёт `footerError` в `showDialog` ниже.
  // Сюда же пишут ошибки записи стадийных свойств (`buildStagedPropertySection`)
  // и подсветка дубликата имени.

  // Шаблон постоянного комментария мысли (08-ui-spec.md §8.4, 02-data-model.md
  // §3.3). Поле — как у всех markdown-полей приложения: HTML-просмотр по
  // умолчанию, двойной клик переключает в CodeMirror-редактор, blur или
  // Ctrl+Enter сохраняет, Esc — отмена. С задачи «Улучшить диалог…» шаблон
  // тоже черновой: поле коммитит текст локально (onSave без сети), а на сервер
  // markdown уходит одним пакетом по «Применить и закрыть».
  const templateLabel = el(
    'p',
    'muted',
    'Шаблон комментария (применяется к пустому комментарию мысли при создании/назначении типа)',
  );
  templateLabel.style.margin = '0 0 2px';
  templatePane.append(templateLabel);
  /** Last markdown committed inside the field (Esc reverts the mirror to it). */
  let committedTemplateMd = templateMd;
  templatePane.append(
    createMarkdownField({
      md: templateMd,
      html: renderTemplateHtml(templateMd),
      onInput: (md) => {
        templateMd = md;
      },
      onSave: async (md) => {
        templateMd = md;
        committedTemplateMd = md;
        return renderTemplateHtml(md);
      },
      onCancel: () => {
        templateMd = committedTemplateMd;
      },
      minRows: 5,
    }),
  );

  // Property sections (own staged + inherited). For a new type the inherited
  // preview follows the picked parent; for an existing type the inherited
  // defaults keep their explicit per-dialog «Применить» (as before).
  const props = buildStagedPropertySection({
    networkId,
    ownerType: 'thought_type',
    typeId: type?.id ?? null,
    previewParentId: () =>
      draft.parent_id ?? findRootType(store.state.thoughtTypes)?.id ?? null,
    onOverrideApplied: onChanged,
    // Ошибки записи привязок идут в общую строку панели кнопок: пользователь
    // может находиться на любой вкладке (ошибка add8d09d).
    errorLine,
  });
  propertiesPane.append(props.root);

  // Вкладка «Метаданные» — автор, даты, id сущности (задача 04cd9794). Для
  // нового типа до первой записи показываем подсказку «id будет присвоен при
  // сохранении»; после «Записать» вкладка перерисовывается настоящими
  // метаданными (ошибка 51732f9b: раньше подсказка оставалась до переоткрытия).
  function renderMetadataPane(): void {
    metadataPane.replaceChildren(
      current !== null
        ? buildMetadataRowsFromType(current)
        : el('p', 'muted', 'id появится после первой записи типа.'),
    );
  }
  renderMetadataPane();

  // Вкладка «Отборы» — собственная подписка на realtime-события
  // (thought-type-view.{created,updated,deleted}); диалог вызывает dispose()
  // на onClose.
  const viewsTab = buildViewsTab({
    networkId,
    getTypeId: () => current?.id ?? null,
    typeName: () => draft.name,
    onChanged,
  });
  viewsPane.append(viewsTab.root);

  // Подвесить все панели к body и активировать первую.
  body.append(descriptionPane, templatePane, propertiesPane, viewsPane, metadataPane);
  activateTab(activeTab);

  /** Existing type with the same normalized name as `name` (self excluded). */
  function nameClash(name: string): ThoughtType | null {
    const key = typeNameKey(name);
    return (
      allTypes.find((t) => t.id !== (current?.id ?? null) && typeNameKey(t.name) === key) ?? null
    );
  }

  /** Live duplicate check on the name field: warn + disable both save buttons. */
  function revalidateName(): void {
    const clash = nameClash(nameInput.value) !== null;
    if (clash) {
      errorLine.textContent = DUP_NAME_MSG;
    } else if (errorLine.textContent === DUP_NAME_MSG) {
      errorLine.textContent = '';
    }
    if (applyBtn !== null) applyBtn.disabled = clash;
    if (saveBtn !== null) saveBtn.disabled = clash;
  }

  // Fresh catalogue for the live duplicate check (the server re-checks anyway).
  void etn.types
    .listThoughtTypes(networkId)
    .then((list) => {
      allTypes = list;
      revalidateName();
    })
    .catch(() => {});
  // Keep the staged draft in sync with the inputs on every keystroke.
  // Without these listeners `draft.name` and `draft.description` are
  // initialised once and never updated, so any payload builder that reads
  // `draft.*` (e.g. `buildCreateTypeInput` for the create path) would push a
  // stale value to the server — the regression tracked in card
  // `aa32ab49-…` («Создание типа мысли: 422 «name обязателен»…»): after
  // `f178f8f` + `e59c258` the create payload took `name` from `draft.name`
  // (= `''`) instead of the live `nameInput.value`.
  // The PATCH path of `apply()` reads `nameInput.value.trim()` directly, so
  // it does not strictly need the listener — adding it anyway keeps the
  // staged-form pattern uniform and prevents the same class of bug if a
  // future field is wired through `draft.*` only.
  nameInput.addEventListener('input', () => {
    draft.name = nameInput.value;
    revalidateName();
  });
  descArea.addEventListener('input', () => {
    draft.description = descArea.value;
  });

  /**
   * Saves the whole draft to the server.
   *
   * The payload is identical for both save buttons — `mode` only decides what
   * happens after a successful write: `'close'` («Применить и закрыть»)
   * dismisses the dialog, `'stay'` («Записать») keeps it open and refreshes
   * everything that depended on the write — the title, «Метаданные», the
   * «Отборы» tab (`getTypeId()` starts returning the id of a freshly created
   * type) and the type list's current row. A failed save keeps the dialog open
   * on both paths, showing the error.
   */
  async function apply(mode: 'close' | 'stay', close: () => void): Promise<void> {
    // Строка ошибки в панели кнопок общая для диалога: перед новой попыткой
    // гасим прошлое сообщение (иначе оно «залипает» и видно на всех вкладках).
    errorLine.textContent = '';
    const name = nameInput.value.trim();
    if (name === '') {
      errorLine.textContent = 'Название типа обязательно.';
      return;
    }
    if (nameClash(name) !== null) {
      errorLine.textContent = DUP_NAME_MSG;
      return;
    }
    const description = descArea.value.trim();
    const nextTemplate = templateMd.trim() === '' ? null : templateMd;
    // Поля САМОГО типа, ушедшие на сервер этой записью (ошибка 8dd5dfed): из
    // них строятся факты локального уведомления открытого редактора. При
    // создании типа уведомлять нечего — его ещё никто не показывает.
    let savedTypeFields: object | null = null;
    try {
      if (current === null) {
        // New type: one create carries every staged field at once. The
        // server treats `font_*` / `fg_color` / `bg_color` / `icon` as
        // `null`-or-value (inherit from parent when null), and `font_*` are
        // strictly `boolean | null` — sending `null` is legal, but the
        // minimal payload (only the fields the user actually set) keeps the
        // create free of obvious "null on first sight" noise. Each field is
        // added only when it differs from the create-time default (null for
        // strings/colours/font flags, empty description, no template).
        const input = buildCreateTypeInput(draft, description, nextTemplate);
        current = await etn.types.createThoughtType(networkId, input);
        createdId = current.id;
      } else {
        // Existing type: patch only the changed fields (If-Match version).
        const input = buildTypePatchInput(current, draft, description, nextTemplate);
        if (Object.keys(input).length > 0) {
          current = await etn.types.updateThoughtType(networkId, current.id, input, current.version);
          savedTypeFields = input;
        }
      }
      // Staged property definitions go after the type itself exists.
      if (!(await props.applyChanges(current.id))) return; // error shown, dialog stays
      // Набор свойств типа изменился (ошибка 74b94c26): открытый редактор
      // мысли этого типа (или его потомка) обязан перечитать таблицу
      // «Свойства». Своё realtime-эхо до рендерера не доходит, поэтому
      // редактор уведомляется локально.
      notifyTypeDefinitionsChanged({ ownerType: 'thought_type', ownerId: current.id });
      await refreshThoughtTypes();
      scheduleRefresh();
      // Оформление и подпись САМОГО типа (ошибка 8dd5dfed): шапка открытого
      // редактора мысли этого типа резолвит их из цепочки типов, а каталог
      // перечитан строкой выше — значит, шапку можно перерисовать сразу и по
      // свежим данным. Своё realtime-эхо до рендерера не доходит (G8 applier).
      if (savedTypeFields !== null) {
        notifyTypeChanged(
          typeUpdateFacts({ ownerType: 'thought_type', ownerId: current.id }, savedTypeFields),
        );
      }
      // Содержимое диалога, зависевшее от записи, обновляется: шапка,
      // «Метаданные» (у нового типа появились id/даты) и вкладка «Отборы»
      // (её getTypeId() теперь отдаёт id). Список типов получает id
      // записанного типа — строка становится текущей.
      syncDialogTitle();
      renderMetadataPane();
      void viewsTab.refresh();
      onChanged(current.id);
      if (mode === 'close') close();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  /** Шапка диалога: «Новый тип мысли» пока тип не записан, дальше — «Тип мысли». */
  function syncDialogTitle(): void {
    if (dialogTitleEl === null) return;
    dialogTitleEl.textContent = current === null ? 'Новый тип мысли' : 'Тип мысли';
  }

  function openStyle(): void {
    showThoughtStyleDialog({
      resolved: {
        fg: draft.fg_color,
        bg: draft.bg_color,
        bold: draft.font_bold ?? false,
        italic: draft.font_italic ?? false,
        underline: draft.font_underline ?? false,
        strike: draft.font_strike ?? false,
      },
      mode: 'type',
      // Patches the local draft only; the server sees it on «Применить и
      // закрыть». `null` still means «inherit from the parent type» (L21).
      onApply: (patch) => {
        if (patch.icon !== undefined) draft.icon = patch.icon;
        if (patch.fg_color !== undefined) draft.fg_color = patch.fg_color;
        if (patch.bg_color !== undefined) draft.bg_color = patch.bg_color;
        if (patch.font_bold !== undefined) draft.font_bold = patch.font_bold;
        if (patch.font_italic !== undefined) draft.font_italic = patch.font_italic;
        if (patch.font_underline !== undefined) draft.font_underline = patch.font_underline;
        if (patch.font_strike !== undefined) draft.font_strike = patch.font_strike;
        return Promise.resolve(true);
      },
    });
  }

  /** Markdown → HTML для просмотра шаблона. Пустой ввод — пусто. */
  function renderTemplateHtml(md: string): string {
    if (md.trim() === '') return '';
    return renderMarkdown(md);
  }

  // The promise resolves on dialog close (`onClose` fires from the backdrop's
  // remove event — Esc, × and every footer button all land there).
  return new Promise<string | null>((resolve) => {
    showDialog({
      title: type === null ? 'Новый тип мысли' : 'Тип мысли',
      body,
      width: TYPE_EDITOR_DIALOG_WIDTH,
      // Идентичность сущности для повторного открытия (ошибки c2d243bb,
      // 74d9b4ed): второй клик по строке этого типа — или по «Добавить» при
      // ещё не созданном типе (`thought-type:new`) — поднимает этот диалог,
      // а не плодит второй. Ключ остаётся и после «Записать»: диалог живёт до
      // закрытия.
      dedupeKey: thoughtTypeDialogKey(type?.id ?? null),
      // Ошибка записи живёт в панели кнопок, а не в теле вкладки: она должна
      // быть видна на любой вкладке диалога (ошибка add8d09d).
      footerError: errorLine,
      buttons: [
        { label: 'Отмена' },
        // «Записать» — запись без закрытия: диалог остаётся открытым, а его
        // содержимое обновляется (отборы нового типа становятся доступны,
        // «Метаданные» показывают id/даты) — ошибка 51732f9b.
        {
          label: 'Записать',
          keepOpen: true,
          onClick: (close) => void apply('stay', close),
          ref: (btn) => {
            saveBtn = btn;
          },
        },
        {
          label: 'Применить и закрыть',
          primary: true,
          keepOpen: true,
          onClick: (close) => void apply('close', close),
          ref: (btn) => {
            applyBtn = btn;
          },
        },
      ],
      onMount: () => {
        // Шапку диалога можно переписать после первой записи: находим её от
        // тела диалога (оба уже в DOM к моменту onMount).
        dialogTitleEl =
          body.closest('.dialog-box')?.querySelector<HTMLElement>('.dialog-title') ?? null;
        syncDialogTitle();
        nameInput.focus();
      },
      onClose: () => {
        viewsTab.dispose();
        void releaseHeld(editLock);
        editLock = null;
        resolve(createdId);
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Property-definition tables + property dialog (both type kinds)
// ---------------------------------------------------------------------------

/**
 * Handle of a staged property section — the type editor applies it on demand.
 */
interface StagedPropertySection {
  root: HTMLElement;
  /** Re-reads the inherited preview of a NEW type after its picked parent
   *  changed (existing types keep their own inherited list). */
  refreshPreview(): void;
  /**
   * Sends the staged own-binding changes of the draft to `typeId`; resolves
   * `false` — with the error already rendered — when the server rejected
   * something. The snapshot is updated after every applied op, so a retry
   * re-diffs only what is still missing.
   */
  applyChanges(typeId: string): Promise<boolean>;
}

/**
 * Builds the staged property sections of a type editor (0.6.5, task
 * «Клиент: редактор типа подключает свойство из справочника»).
 *
 * The own-bindings table is a list of {@link DraftProperty} rows. The user
 * adds bindings via «Добавить свойство» — a dialog over the network
 * property registry (search, pick an existing one OR create a brand-new one
 * and attach in the same server-side transaction). The role of an existing
 * binding is edited locally: `required` toggle and ▲/▼ reorder. The
 * property's NATURE (name, value type, config, description) is not editable
 * here — the table's «✎» button opens the property manager dialog with a
 * banner that flags the network-wide impact. «✕» unbinds with a
 * confirmation that values stay as values-outside-type.
 *
 * Reconciliation with the server happens in
 * {@link StagedPropertySection.applyChanges} on the editor's
 * «Применить и закрыть»:
 *   1. unbind removed bindings,
 *   2. attach new ones (registry rows are created through the shared
 *      property editor first),
 *   3. set-role patches for `required` toggles,
 *   4. one trailing reorder.
 *
 * The inherited section is read-only with its explicit per-dialog
 * default-override buttons applied immediately (unchanged behaviour — the
 * small dialog owns its own «Применить»). For a NEW type
 * (`typeId = null`) the own draft starts empty and the inherited section
 * is a live preview of whatever the picked parent will pass down
 * ({@link opts.previewParentId}, re-read on reparent).
 */
function buildStagedPropertySection(opts: {
  networkId: string;
  ownerType: TypeOwnerType;
  /** An existing type's id, or null while a NEW type is being edited. */
  typeId: string | null;
  /** For a new type: the type whose effective properties it will inherit. */
  previewParentId: () => string | null;
  /** Fired after an inherited default override was applied on the server. */
  onOverrideApplied?: () => void;
  /**
   * Общая строка ошибки диалога (в панели кнопок): ошибки записи привязок
   * выводятся сюда, чтобы быть видимыми на любой вкладке (ошибка add8d09d).
   */
  errorLine: HTMLElement;
}): StagedPropertySection {
  const { networkId, ownerType, typeId, previewParentId, onOverrideApplied, errorLine } = opts;
  const box = div('form-stack');
  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '220px';
  // The first load often starts before the dialog mounts this box — show the
  // placeholder up front instead of a blank gap.
  tableWrap.append(el('span', 'muted', 'Загрузка…'));
  // Заголовка «Свойства» над таблицей нет (ошибка 3c7213ec): вкладка уже
  // называется «Свойства», подпись только дублировала её. Подзаголовок
  // «Свойства типа» остаётся — он отличает собственную таблицу от
  // унаследованной. Строки ошибки здесь нет: ошибки записи уходят в футер
  // диалога (ошибка add8d09d).
  box.append(tableWrap);
  // Кнопка добавления свойства (задача 298fe6f3): в списке диалога «Добавить
  // свойство» свойство-связь показано парой КОНКРЕТНЫХ имён — прямое
  // (`name_forward`, сторона `source`) и обратное (`name_reverse`, сторона
  // `target`); выбор имени сразу задаёт сторону привязки, отдельного диалога
  // «Сторона привязки» нет. «Создать свойство» — кнопка самого диалога выбора,
  // отдельной кнопки вкладки нет.
  const actions = div('form-row');
  actions.style.gap = '8px';
  actions.style.flexWrap = 'wrap';
  actions.append(
    button(
      'Добавить свойство…',
      () => void openAttachPropertyDialog(),
      'btn small',
      'Подключить свойство из справочника сети (новое создаётся кнопкой «Создать свойство» в диалоге выбора)',
    ),
  );
  box.append(actions);

  /** Server-side snapshot of the type's OWN bindings (kept in sync after
   *  every applied op — the base the next diff is computed against). */
  let originalOwn: PropertyDefinition[] = [];
  /** The staged draft rows, in the drafted order. */
  let ownDraft: DraftProperty[] = [];
  /** Own bindings removed from the draft during this session. */
  let deletedIds: string[] = [];
  /** Inherited bindings shown below the own table (an existing type: its
   *  own inherited set; a new type: the picked parent's whole set). */
  let inherited: EffectiveTypeProperty[] = [];
  /** Whether the user has staged any own-row change — after that, reloads
   *  must not re-seed the draft from the server snapshot. */
  let draftTouched = false;
  /** Snapshot of the registry rows (id → RegistryRow) used by the attach
   *  dialog so the «Создать и подключить» path can prefill from a typed
   *  query without a second registry round-trip. */
  let registryCache: Map<string, RegistryRow> = new Map();

  /**
   * «Добавить свойство» dialog: pick an existing registry property (или
   * создать новое в общем редакторе свойства и затем выбрать его). Returns
   * the staged row the caller appends to {@link ownDraft} (or `null` when
   * the user cancelled). Строка списка — конкретное имя свойства (задача
   * 298fe6f3): у свойства-связи их две, по имени на сторону, и выбор имени
   * сразу задаёт `side` — отдельного шага «Сторона привязки» нет.
   */
  async function openAttachPropertyDialog(): Promise<void> {
    // The warning's «descendants» check needs the edited type's id and name;
    // both exist only for an already-created type.
    const editedType =
      typeId === null
        ? null
        : ownerType === 'thought_type'
          ? store.state.thoughtTypes.find((t) => t.id === typeId) ?? null
          : store.state.linkTypes.find((t) => t.id === typeId) ?? null;
    // Занятые стороны подключённых свойств-связей (проверка дубля ИМЕНИ в
    // списке — имя однозначно определяет сторону; скаляр — пустой набор).
    const existingSides = new Map<string, Set<LinkPropertySide>>();
    for (const d of ownDraft) {
      let set = existingSides.get(d.property_id);
      if (set === undefined) {
        set = new Set<LinkPropertySide>();
        existingSides.set(d.property_id, set);
      }
      if (d.side === 'source' || d.side === 'target') set.add(d.side);
    }
    const picked = await openAttachDialog({
      networkId,
      ownerType,
      types: pickTypeList(),
      typeId,
      editedTypeName:
        editedType === null
          ? null
          : 'name' in editedType
            ? editedType.name
            : editedType.name_forward,
      existingSides,
      inheritedPropertyIds: new Set(inherited.map((d) => d.property_id)),
    });
    if (picked === null) return;
    // Merge the picked property into the section's own registry snapshot
    // right away — the row may be brand-new (just created via «Добавить…»
    // inside the attach dialog) or simply absent from the snapshot taken at
    // the last `reload()`; either way `registryCache` must know it NOW so
    // the table's «✎» button can look it up without waiting for a full
    // reload (bug `da2d16c4-…`).
    cacheAttachedRegistryRow(registryCache, picked.registry);
    ownDraft = [...ownDraft, picked.draft];
    draftTouched = true;
    render();
  }

  /** The list of types that the «already bound to a descendant» warning
   *  walks through when the user picks a property the server will dedupe
   *  from the subtree. `null` while the type is being created — the editor
   *  has no id yet, so the warning would be empty anyway. */
  function pickTypeList(): ThoughtType[] | LinkType[] | null {
    if (typeId === null) return null;
    return ownerType === 'thought_type' ? store.state.thoughtTypes : store.state.linkTypes;
  }

  /** Черновики дефолтов привязок (0.8.2): ключ — registry `property_id`;
   *  значения уезжают на «Применить и закрыть» одним набором
   *  `setPropertyDefaultOverride`. Живут рядом с `ownDraft` и переживают
   *  перерисовку вкладки. */
  const bindingDefaults = new Map<string, BindingDefaultDraft>();

  /** Ленивый черновик дефолта привязки: `initial` фиксируется при первом
   *  рендере поля и дальше не меняется — по нему считается diff при apply. */
  function bindingDefaultDraft(
    propertyId: string,
    valueType: PropertyValueType,
    initial: unknown,
  ): BindingDefaultDraft {
    let draftEntry = bindingDefaults.get(propertyId);
    if (draftEntry === undefined) {
      draftEntry = { propertyId, valueType, initial, value: initial };
      bindingDefaults.set(propertyId, draftEntry);
    }
    return draftEntry;
  }

  /**
   * Ячейка «По умолчанию» привязки (0.8.2, ADR «дефолт свойства живёт на
   * привязке»): редактор значения без режимов — заполнено = дефолт этой
   * привязки, пусто = общее значение стороны (подсказка в тултипе пустой
   * ячейки). Значение копится в черновике и пишется на «Применить и закрыть»
   * (`setPropertyDefaultOverride(значение | null)`); очистка поля снимает
   * override. Общая для собственной и унаследованной таблиц.
   */
  function buildBindingDefaultCell(opts: {
    propertyId: string;
    valueType: PropertyValueType;
    config: PropertyConfig | null;
    /** Типы противоположной стороны привязок свойства-связи
     *  (`allowed_opposite_type_ids` определения): допустимые цели
     *  дефолт-пикера. Пусто — целей не ограничиваем. */
    allowedOppositeTypeIds: readonly string[];
    /** Дефолт привязки на сервере; `null` — его нет (общее стороны). */
    initial: unknown;
  }): HTMLElement {
    const cell = div('prop-default-cell');
    const draftEntry = bindingDefaultDraft(opts.propertyId, opts.valueType, opts.initial);
    const write = async (next: unknown): Promise<boolean> => {
      draftEntry.value = next;
      render();
      return true;
    };
    if (opts.valueType === 'link') {
      const filterIds = linkAllowedTypeIds(opts.allowedOppositeTypeIds);
      cell.append(
        buildLinkValueEditor({
          networkId,
          // Отбор целей — по типам противоположной стороны привязки, тот же
          // хелпер, что у поля значения в редакторе мысли (иерархию
          // раскрывает сам редактор); пусто — цели любые.
          definition: {
            config: {},
            required: false,
            allowed_opposite_type_ids: filterIds,
          },
          values: defaultLinkValues(draftEntry.value),
          save: (next) => write(next),
        }),
      );
    } else {
      cell.append(
        buildValueEditor({
          networkId,
          definition: {
            value_type: opts.valueType,
            config: opts.config,
            required: false,
            default_value: null,
          },
          value: draftEntry.value ?? null,
          save: (next) => write(next),
        }),
      );
    }
    if (isEmptyDefault(draftEntry.value)) cell.append(emptyDefaultHint());
    return cell;
  }

  /** Opens the description-override dialog of an inherited property. */
  function showDescriptionOverrideDialog(def: EffectiveTypeProperty): void {
    openDescriptionOverrideDialog({
      networkId,
      ownerType,
      typeId: typeId as string,
      def,
      onDone: () => {
        onOverrideApplied?.();
        void reload();
      },
    });
  }

  /** Drops the type's description override (back to the ancestor's own). */
  async function clearDescriptionOverride(def: EffectiveTypeProperty): Promise<void> {
    try {
      await etn.types.setPropertyDescriptionOverride(networkId, ownerType, typeId as string, def.id, null);
      onOverrideApplied?.();
      await reload();
    } catch (err) {
      errorDialog('Сбросить переопределение описания', err);
    }
  }

  /** Moves a draft row one slot up/down (the order is applied on save).
   *  Порядок общий для всего типа — двигаются строки обеих сторон привязки
   *  (задача b044237d). */
  function move(rowId: string, delta: -1 | 1): void {
    const next = moveDraftRow(ownDraft, rowId, delta);
    if (next === ownDraft) return;
    ownDraft = [...next];
    draftTouched = true;
    render();
  }

  /** Toggles the `required` flag of a draft row (applied on «Применить и
   *  закрыть» — the table does not write the server mid-edit). */
  function setRequired(rowId: string, required: boolean): void {
    const row = ownDraft.find((d) => d.id === rowId);
    if (row === undefined || row.required === required) return;
    row.required = required;
    draftTouched = true;
    render();
  }

  /**
   * Opens the property manager dialog on the registry row that backs this
   * binding. The dialog itself warns about the network-wide impact.
   *
   * `registryCache` is normally warm (attaching a property — existing or
   * freshly created — merges it in right away, see
   * {@link openAttachPropertyDialog}), but it is still just a snapshot: a
   * miss can legitimately happen (e.g. another client created/renamed the
   * property between this dialog's last reload and the click). Rather than
   * a silent no-op (bug `da2d16c4-…` — «Править природу свойства…» did
   * nothing), fetch the row once and cache it; a genuine failure (the
   * property was deleted meanwhile) surfaces as an error dialog instead of
   * pretending the click never happened.
   */
  function editNature(row: DraftProperty): void {
    const cached = registryCache.get(row.property_id);
    if (cached !== undefined) {
      openPropertyManagerEditor(cached, () => void reload());
      return;
    }
    void etn.propertyRegistry
      .get(networkId, row.property_id)
      .then((reg) => {
        cacheAttachedRegistryRow(registryCache, reg);
        openPropertyManagerEditor(reg, () => void reload());
      })
      .catch((err) => {
        errorDialog('Править природу свойства', err);
      });
  }

  /** Stages the unbinding of one own row (persisted by «Применить и
   *  закрыть»). Values are NOT deleted — they become values-outside-type. */
  async function unbind(row: DraftProperty): Promise<void> {
    const ok = await confirmDialog(
      'Отключить свойство',
      `Отключить свойство «${row.key}» от типа? Значения останутся у мыслей и связей ` +
        'и будут показаны в группе «Свойства вне типа».',
      true,
    );
    if (!ok) return;
    if (!row.isNew) deletedIds = [...deletedIds, row.id];
    ownDraft = ownDraft.filter((d) => d.id !== row.id);
    draftTouched = true;
    render();
  }

  /** Renders the staged own table + the inherited table. */
  function render(): void {
    tableWrap.replaceChildren();

    if (inherited.length > 0) {
      const inhLabel = el(
        'p',
        'muted',
        typeId === null
          ? 'Унаследованные свойства (передадутся от выбранного родителя)'
          : 'Унаследованные свойства (тип значения не меняется; переопределяются значение по умолчанию и описание; обязательность задаётся на типе, который подключил свойство)',
      );
      inhLabel.style.margin = '0 0 2px';
      tableWrap.append(inhLabel);
      const inhTable = el('table', 'table-list prop-table');
      const inhHead = el('thead');
      const inhHeadRow = el('tr');
      inhHeadRow.append(
        el('th', undefined, 'Имя'),
        el('th', undefined, 'Тип'),
        el('th', undefined, 'Источник'),
        el('th', undefined, 'По умолчанию'),
        el('th'),
      );
      inhHead.append(inhHeadRow);
      inhTable.append(inhHead);
      const inhBody = el('tbody');
      for (const def of inherited) {
        const row = el('tr');
        const nameCell = el('td', undefined, def.key);
        const hint = def.mirrored === true
          ? `Зеркальное свойство-связь: порождено свойством «${def.key}» другого типа через ограничение типов цели. Тип связи и направление не редактируются здесь.`
          : def.description;
        if (hint !== null) {
          setTooltip(nameCell, hint);
          nameCell.append(span(' ⓘ', 'muted'));
        }
        row.append(nameCell);
        row.append(el('td', 'muted', VALUE_TYPE_LABELS[def.value_type]));
        const sourceLabel = def.mirrored === true
          ? `зеркало · ${def.defined_on_name}`
          : def.defined_on_name;
        row.append(el('td', 'muted', sourceLabel));
        // Колонка «По умолчанию» — редактор дефолта привязки (0.8.2): без
        // режимов, заполнено/пусто; пусто = общее значение стороны. У
        // зеркальной записи (mirrored) физической привязки нет — только
        // показ эффективного значения.
        const overridable = def.mirrored !== true;
        const dvCell = el('td');
        if (overridable) {
          dvCell.append(
            buildBindingDefaultCell({
              propertyId: def.property_id,
              valueType: def.value_type,
              config: def.config,
              allowedOppositeTypeIds: def.allowed_opposite_type_ids ?? [],
              initial: def.overridden_here === true ? def.default_value ?? null : null,
            }),
          );
        } else {
          dvCell.append(el('span', 'muted', formatDefault(def.default_value)));
        }
        row.append(dvCell);
        const actions = el('td');
        actions.style.whiteSpace = 'nowrap';
        // Кнопка дефолта/«сбросить» убрана (0.8.2): значение правится прямо в
        // колонке «По умолчанию», очистка поля снимает override — режимов нет.
        // Override описания сохраняет свой маленький диалог (транзитивность
        // описаний не менялась). Зеркальная запись (dde92461) не имеет
        // физической привязки — переопределять нечего.
        if (typeId !== null && def.mirrored !== true) {
          actions.append(
            button('описание…', () => showDescriptionOverrideDialog(def), 'btn small', 'Переопределить описание свойства'),
          );
        }
        if (typeId !== null && def.description_overridden) {
          actions.append(
            button('сбросить ◆', () => void clearDescriptionOverride(def), 'btn small', 'Сбросить переопределение описания'),
          );
        }
        row.append(actions);
        inhBody.append(row);
      }
      inhTable.append(inhBody);
      tableWrap.append(inhTable);
      const ownLabel = el('p', 'muted', 'Свойства типа');
      ownLabel.style.margin = '8px 0 2px';
      tableWrap.append(ownLabel);
    }

    const table = el('table', 'table-list prop-table');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th', undefined, 'Имя'),
      el('th', undefined, 'Тип'),
      el('th', undefined, 'Сторона'),
      el('th', undefined, 'Обязательное'),
      el('th', undefined, 'По умолчанию'),
      el('th'),
    );
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    for (const row of ownDraft) {
      const tr = el('tr');
      // Имя: для свойств-связей выводится имя соответствующей стороны
      // (`name_forward` для источника, `name_reverse` для назначения);
      // унаследованные привязки и бывшие зеркальные — также под обратным
      // именем (задача 935ec90e, требование 15b88319).
      const displayName = displayNameForSide(row);
      const nameCell = el('td', undefined, displayName);
      if (row.description !== null) {
        setTooltip(nameCell, row.description);
        nameCell.append(span(' ⓘ', 'muted'));
      }
      tr.append(nameCell);
      tr.append(el('td', 'muted', VALUE_TYPE_LABELS[row.value_type]));
      tr.append(el('td', 'muted', sideLabel(row.side)));
      const requiredCell = el('td');
      const requiredCheck = el('input') as HTMLInputElement;
      requiredCheck.type = 'checkbox';
      requiredCheck.checked = row.required;
      requiredCheck.addEventListener('change', () => {
        setRequired(row.id, requiredCheck.checked);
      });
      requiredCell.append(requiredCheck);
      tr.append(requiredCell);
      // Колонка «По умолчанию» — тот же редактор без режимов (0.8.2):
      // значение копится в черновике и уезжает на «Применить и закрыть» (для
      // только что добавляемой привязки — после её создания).
      const dvCell = el('td');
      dvCell.append(
        buildBindingDefaultCell({
          propertyId: row.property_id,
          valueType: row.value_type,
          config: row.config,
          allowedOppositeTypeIds: row.allowedOppositeTypeIds ?? [],
          initial: row.defaultValue ?? null,
        }),
      );
      tr.append(dvCell);
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      // Порядок (▲/▼) — у всех строк таблицы, включая привязки стороны
      // «назначение» (задача b044237d): порядок принадлежит типу, а не
      // стороне свойства-связи.
      if (canReorderBinding(row)) {
        actions.append(
          button('▲', () => move(row.id, -1), 'btn small', 'Выше'),
          button('▼', () => move(row.id, 1), 'btn small', 'Ниже'),
        );
      }
      actions.append(
        button(
          '✎',
          () => editNature(row),
          'btn small',
          'Править природу свойства (имя, тип значения, описание) — действует во всех типах сразу',
        ),
        button('✕', () => void unbind(row), 'btn small', 'Снять привязку свойства — значения не удаляются'),
      );
      tr.append(actions);
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.append(table);
    if (ownDraft.length === 0 && inherited.length === 0) {
      tableWrap.append(el('p', 'muted', 'У типа нет свойств.'));
    }
  }

  /** Имя свойства в строке таблицы: для свойств-связей — имя стороны
   *  (`name_forward` для `source`, `name_reverse` для `target`); для
   *  скаляров и структурных — `key`. Использует кеш реестра и каталог
   *  типов связей. */
  function displayNameForSide(row: DraftProperty): string {
    if (row.value_type !== 'link' || row.side === null) return row.key;
    const linkTypeId = row.config?.link_type_id;
    if (typeof linkTypeId !== 'string' || linkTypeId === '') return row.key;
    const lt = store.state.linkTypes.find((t) => t.id === linkTypeId);
    if (lt === undefined) return row.key;
    return row.side === 'source' ? lt.name_forward : lt.name_reverse;
  }

  /** Loads (or reloads) the bindings from the server, plus the registry
   *  snapshot the «✎» button uses to jump into the property manager. */
  let everMounted = false;
  async function reload(): Promise<void> {
    // The table is built BEFORE its dialog mounts it, so the first reload runs
    // while still detached and must proceed. Skip only bodies that were
    // mounted and then discarded (the dialog closed or a newer body took over).
    if (everMounted && !box.isConnected) return;
    const sourceId = typeId ?? previewParentId();
    if (sourceId === null) {
      // No catalogue at all (mid-migration) — show the empty state rather
      // than a forever-«Загрузка…» placeholder.
      render();
      return;
    }
    try {
      const [defs, registryRows] = await Promise.all([
        etn.types.listTypeProperties(networkId, ownerType, sourceId),
        // The registry powers the «✎» button (jump into the property manager);
        // it is also the source of truth for the attach dialog's «Создать и
        // подключить» suggestion when the user types a name the registry
        // already has. Cheap call (flat list).
        etn.propertyRegistry.list(networkId),
      ]);
      registryCache = new Map(registryRows.map((row) => [row.id, row]));
      if (typeId !== null) {
        // An existing type: own rows seed the draft (once), inherited shown.
        // Mirrored link properties (dde92461) are synthesized by the server —
        // they have no `type_properties` binding, so they must never seed the
        // own draft (the diff planner would try to attach them); they render
        // in the inherited table with a «зеркало» source label instead.
        originalOwn = defs.filter((d) => !d.inherited && d.mirrored !== true);
        inherited = defs.filter((d) => d.inherited || d.mirrored === true);
        if (ownDraft.length === 0 && deletedIds.length === 0 && !draftTouched) {
          ownDraft = draftPropertiesFrom(originalOwn);
        }
      } else {
        // A new type: EVERYTHING the parent carries will be inherited.
        inherited = defs;
      }
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    if (box.isConnected) everMounted = true;
    render();
  }

  /**
   * Applies the staged own-binding changes to `targetId` (the created or
   * existing type). See {@link StagedPropertySection.applyChanges}. The
   * order matches the planner: unbinds first (so a freed binding never
   * collides with an attach of the same property), then
   * attaches/creates, then `set-role` patches, one trailing reorder.
   */
  async function applyChanges(targetId: string): Promise<boolean> {
    const plan = planPropertyDiff(originalOwn, ownDraft, deletedIds);
    for (const op of plan.ops) {
      try {
        if (op.kind === 'unbind') {
          await etn.types.removeTypeProperty(networkId, ownerType, targetId, op.id);
          originalOwn = originalOwn.filter((d) => d.id !== op.id);
          ownDraft = ownDraft.filter((d) => d.id !== op.id);
        } else if (op.kind === 'attach') {
          const created = await etn.types.createTypeProperty(
            networkId,
            ownerType,
            targetId,
            opToAttachInput(op),
          );
          // Bind the placeholder id to the real server id, so a retry after a
          // later failure does not try to create the same row twice.
          const row = ownDraft.find((d) => d.id === op.draftId);
          if (row !== undefined) {
            row.id = created.id;
            row.isNew = false;
            // The server returns the resolved nature in the binding payload —
            // refresh the immutable snapshot so the table keeps showing what
            // the registry now holds.
            row.property_id = created.property_id;
            row.key = created.key;
            row.value_type = created.value_type;
            row.config = created.config;
            row.description = created.description;
          }
          originalOwn = [...originalOwn, created];
        } else {
          await etn.types.updateTypeProperty(networkId, ownerType, targetId, op.id, {
            required: op.required,
          });
          originalOwn = originalOwn.map((d) =>
            d.id === op.id ? ({ ...d, required: op.required } as PropertyDefinition) : d,
          );
        }
      } catch (err) {
        errorLine.textContent = errText(err);
        render();
        return false;
      }
    }
    if (plan.needsReorder) {
      try {
        await etn.types.reorderTypeProperties(
          networkId,
          ownerType,
          targetId,
          ownDraft.map((d) => d.id),
        );
      } catch (err) {
        errorLine.textContent = errText(err);
        return false;
      }
    }
    // Дефолты привязок (0.8.2): пишутся после attach/reorder — сервер требует,
    // чтобы свойство было привязано к типу (для только что добавленных строк
    // это верно лишь сейчас). Пустое значение — сброс override.
    const attachedPropertyIds = new Set<string>([
      ...ownDraft.map((d) => d.property_id),
      ...inherited.map((d) => d.property_id),
    ]);
    for (const write of collectBindingDefaultWrites([...bindingDefaults.values()], attachedPropertyIds)) {
      try {
        await etn.types.setPropertyDefaultOverride(
          networkId,
          ownerType,
          targetId,
          write.propertyId,
          write.value,
        );
      } catch (err) {
        errorLine.textContent = errText(err);
        render();
        return false;
      }
      const draftEntry = bindingDefaults.get(write.propertyId);
      if (draftEntry !== undefined) draftEntry.initial = draftEntry.value;
    }
    deletedIds = [];
    errorLine.textContent = '';
    render();
    // Refresh the inherited view too: reparenting on the same apply may have
    // changed what this type receives from its ancestors.
    if (typeId !== null) void reload();
    return true;
  }

  void reload();
  return {
    root: box,
    refreshPreview: (): void => {
      if (typeId === null) void reload();
    },
    applyChanges,
  };
}

/** Подпись стороны привязки — колонка «Сторона» таблицы свойств типа и
 *  списка «Добавить свойство»: «источник» / «назначение» / «—» (скаляры и
 *  структурные строки). */
export function sideLabel(side: LinkPropertySide | null): string {
  if (side === 'source') return 'источник';
  if (side === 'target') return 'назначение';
  return '—';
}

/**
 * Result of the «Добавить свойство» dialog: a new draft row the caller
 * appends to its own-bindings list (or `null` when the user cancelled).
 * The row is fully resolved — the registry id (`property_id`) and the
 * immutable nature snapshot are both known — so the table can render it
 * without a second registry round-trip. `registry` is the source row the
 * pick came from — the caller merges it into its own `registryCache` right
 * away (bug `da2d16c4-…`: a property attached — existing or freshly created
 * via «Добавить…» — was invisible to the type editor's own `registryCache`
 * snapshot until the next full `reload()`, so the table's «✎ Править
 * природу свойства» button silently no-op'd on it).
 */
interface AttachDialogResult {
  draft: DraftProperty;
  registry: RegistryRow;
}

/**
 * «Добавить свойство» dialog (0.6.5; задача 298fe6f3; 0.8.2 — перевод на общий
 * список `lib/property-list.ts`, задача 6ebde54e).
 *
 * Список — общий компонент в режиме ПИКЕРА: строки скаляров и обеих сторон
 * свойства-связи, колонки «Имя» / «Тип значения» / «Кол-во типов», поиск по
 * имени и описанию, ↑/↓ и единая активация Enter/клик — выбор строки (у конца
 * связи выбор несёт сторону) и закрытие пикера. Уже подключённые имена этой
 * стороны заблокированы и помечены, второе имя той же связи остаётся доступным
 * (правила 0.8.2, коммиты c896aee / 6e17543). Кнопки низа: **Отмена**,
 * **Создать свойство** (общий редактор свойства — то же диалог, что у
 * менеджера) и **Выбрать** (активирует выделенную строку).
 *
 * Привязка свойства, которое кто-то из ПОТОМКОВ типа уже несёт, спрашивает
 * подтверждение заранее — с именами конкретных типов и тем, что именно
 * произойдёт (их привязки перенимаются наследованием, значения не меняются).
 */
async function openAttachDialog(opts: {
  networkId: string;
  /** The edited type's kind — scopes the usage lookup of the warning. */
  ownerType: TypeOwnerType;
  /** Catalogues used by the «already bound to a descendant» warning. `null`
   *  suppresses the check (the editor is creating a new type that has no
   *  descendants yet). */
  types: readonly ThoughtType[] | readonly LinkType[] | null;
  /** The edited type's id — roots the «descendants already carry it» check.
   *  `null` while a NEW type is being created (no descendants yet). */
  typeId: string | null;
  /** The edited type's display name for warning texts (null for a new type). */
  editedTypeName: string | null;
  /** Занятые стороны собственных привязок типа: property_id → стороны
   *  (пустой набор — скалярное свойство). Блокирует повторный выбор того же
   *  ИМЕНИ свойства-связи (имя однозначно определяет сторону). */
  existingSides: ReadonlyMap<string, ReadonlySet<LinkPropertySide>>;
  /** Property ids inherited from the type's ancestors (or the picked parent's
   *  whole set for a new type) — shown as «унаследовано», not pickable. */
  inheritedPropertyIds: ReadonlySet<string>;
}): Promise<AttachDialogResult | null> {
  const { networkId, ownerType, types, typeId, editedTypeName, existingSides, inheritedPropertyIds } = opts;
  let registryRows: RegistryRow[];
  try {
    registryRows = await etn.propertyRegistry.list(networkId);
  } catch (err) {
    errorDialog('Добавить свойство', err);
    return null;
  }
  // Имена сторон берутся из каталога типов связей — догружаем недостающие,
  // пока диалог ещё не открыт (общий загрузчик списка свойств).
  await ensurePropertyLinkTypes(networkId, registryRows);

  return new Promise((resolve) => {
    const errorLine = span('', 'error-text');

    /** Строки каталога по текущему снимку каталога типов связей. */
    const list = buildPropertyList({
      mode: 'picker',
      searchPlaceholder: 'Поиск по имени или описанию…',
      callbacks: {
        rowBlocked: (row) => rowBlockReason(row, existingSides, inheritedPropertyIds),
        onActivate: (row) => void choose(row),
        onEdit: (row) =>
          openPropertyManagerEditor(
            row.registry,
            () => void refreshRegistry(null),
            (created) => void refreshRegistry(created.id),
          ),
      },
    });
    list.setRows(buildPropertyListRows(registryRows, store.state.linkTypes));

    /** Активация строки: подтверждение перенимаемых привязок потомков, затем
     *  возврат черновика привязки — выбранное имя задаёт сторону. */
    async function choose(row: PropertyListRow): Promise<void> {
      errorLine.textContent = '';
      const warning = await warnDescendantBindings(networkId, row.registry, {
        ownerType,
        types,
        typeId,
        editedTypeName,
      });
      if (warning !== null) {
        const ok = await confirmDialog('Подключить свойство', warning, true);
        if (!ok) return;
      }
      close();
      resolve({
        draft: attachDraftFromExisting(row.registry, row.side, row.name),
        registry: row.registry,
      });
    }

    /** Перечитывает реестр (после того как общий редактор создал свойство) и
     *  перерисовывает список, выделяя строку созданного свойства. */
    async function refreshRegistry(highlightPropertyId: string | null): Promise<void> {
      try {
        registryRows = await etn.propertyRegistry.list(networkId);
      } catch {
        /* оставляем старый список — редактор уже отчитался об ошибке */
      }
      await ensurePropertyLinkTypes(networkId, registryRows);
      list.setRows(buildPropertyListRows(registryRows, store.state.linkTypes));
      if (highlightPropertyId !== null) {
        // Новое свойство-связь даёт строку источника (`:source`); скаляр —
        // строку с самим id. Оба вызова безвредны: отсутствующей строки нет.
        list.selectRow(`${highlightPropertyId}:source`);
        list.selectRow(highlightPropertyId);
      }
    }

    const body = div('form-stack');
    body.append(list.root, errorLine);

    const close = showDialog({
      title: 'Добавить свойство',
      body,
      width: 760,
      buttons: [
        { label: 'Отмена' },
        {
          label: 'Создать свойство',
          keepOpen: true,
          onClick: () => {
            openPropertyManagerEditor(
              null,
              () => void refreshRegistry(null),
              // Выделяем свежую строку, чтобы ещё одно Enter/«Выбрать» её подключило.
              (created) => void refreshRegistry(created.id),
            );
          },
        },
        {
          label: 'Выбрать',
          primary: true,
          keepOpen: true,
          onClick: () => {
            const row = list.selected();
            if (row !== null) void choose(row);
          },
        },
      ],
      onMount: () => list.focusSearch(),
    });
  });
}

/** Builds the draft row for «attach existing» — `property_id` set, nature
 *  snapshot copied from the registry row. `side` — сторона привязки
 *  (`source`/`target`), заданная выбранным ИМЕНЕМ строки списка (задача
 *  298fe6f3); `null` для скаляров. `name` — имя выбранной строки (у
 *  свойства-связи — имя стороны): попадает в снимок `key`, чтобы строка
 *  таблицы верно называлась, даже если каталог типов связей ещё не догружен.
 *  Экспортирована для юнит-теста. */
export function attachDraftFromExisting(
  row: RegistryRow,
  side: LinkPropertySide | null,
  name?: string,
): DraftProperty {
  return {
    id: nextDraftPropertyId(),
    isNew: true,
    property_id: row.id,
    side,
    required: false,
    key: name ?? row.name,
    value_type: row.value_type,
    config: row.config,
    description: row.description,
  };
}

/**
 * Returns a human-readable warning when attaching `row` will take over the
 * bindings of the edited type's DESCENDANTS, or `null` when nothing like
 * that happens (the common case — most picks are warning-free).
 *
 * The server's subtree dedupe is automatic (0.6.5, 03-server-api.md §8):
 * attaching a property a descendant already carries is allowed, the
 * descendant's own binding is dropped in the same transaction, and the
 * stored values never change — from that point the descendant inherits the
 * property from the edited type. The warning names the concrete types and
 * spells out both what disappears (their own «Свойства типа» row) and what
 * never changes (the values), so the user can decide knowingly.
 *
 * Exact check (0.6.5 приёмка): the property's usage is fetched and crossed
 * with the edited type's subtree — the previous types_count-based heuristic
 * warned on EVERY property bound anywhere, even when no descendant carried
 * it.
 */
async function warnDescendantBindings(
  networkId: string,
  row: RegistryRow,
  ctx: {
    ownerType: TypeOwnerType;
    types: readonly ThoughtType[] | readonly LinkType[] | null;
    /** The edited type's id — `null` while a NEW type is being created. */
    typeId: string | null;
    /** The edited type's display name (null for a new type). */
    editedTypeName: string | null;
  },
): Promise<string | null> {
  const { ownerType, types, typeId, editedTypeName } = ctx;
  // A brand-new type has no descendants to take over.
  if (types === null || typeId === null || editedTypeName === null) return null;
  // Fast pre-filter: nobody bound the property at all — no request needed.
  if (row.types_count === 0) return null;
  const descendants = subtreeTypeIds(types, typeId);
  descendants.delete(typeId);
  if (descendants.size === 0) return null;
  let usage: Awaited<ReturnType<typeof etn.propertyRegistry.usage>>;
  try {
    usage = await etn.propertyRegistry.usage(networkId, row.id);
  } catch {
    // No usage data — do not scare the user; the server re-checks on attach.
    return null;
  }
  const names = usage.bindings
    .filter((b) => b.owner_type === ownerType && descendants.has(b.owner_id))
    .map((b) => b.owner_name);
  if (names.length === 0) return null;
  const nameList = names.map((n) => `«${n}»`).join(', ');
  return (
    `Свойство «${row.name}» подключено к типам-потомкам ${nameList}. ` +
    `Если подключить его к типу «${editedTypeName}», у потомков снимутся их собственные ` +
    'подключения этого свойства (они станут наследовать его от вашего типа). ' +
    'Значения свойств в мыслях и связях при этом не изменятся.'
  );
}

/** Human-readable default value for a table cell. */
function formatDefault(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (Array.isArray(value)) {
    // Дефолт свойства-связи — набор целей (bb67e546): счётчик, подписи в
    // диалоге.
    const n = value.length;
    const form = n % 10 === 1 && n % 100 !== 11 ? 'цель' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'цели' : 'целей';
    return `${n} ${form}`;
  }
  return String(value);
}

/**
 * Тело `setPropertyDefaultOverride` для колонки «По умолчанию» привязки
 * (0.8.2, ADR «дефолт свойства живёт на привязке»): свойство-связь — набор id
 * целей (`string[]`), скаляр — значение по виду свойства; пусто — `null`
 * (override снимается, действует общее значение стороны). Чистая — юнит-тест
 * (`type-manager-default.test.ts`).
 */
export function bindingDefaultPayload(
  valueType: PropertyValueType,
  value: unknown,
): string | number | boolean | string[] | null {
  return valueType === 'link' ? linkDefaultPayload(value) : scalarDefaultPayload(value);
}

/**
 * Черновик дефолта одной привязки в редакторе типа (0.8.2): вкладка
 * «Свойства» ничего не пишет на сервер до «Применить и закрыть», поэтому
 * значение колонки «По умолчанию» копится здесь и уезжает одной пачкой
 * `setPropertyDefaultOverride`.
 */
export interface BindingDefaultDraft {
  /** Registry `property_id` привязки — сервер принимает его наравне с id
   *  самой привязки (`type_properties.id`). */
  propertyId: string;
  valueType: PropertyValueType;
  /** Снимок дефолта привязки на момент открытия редактора (для diff). */
  initial: unknown;
  /** Текущее значение поля «По умолчанию»; `null` — пусто (общее стороны). */
  value: unknown;
}

/** Запись дефолта привязки, уезжающая на «Применить и закрыть». */
export interface BindingDefaultWrite {
  propertyId: string;
  /** Тело `setPropertyDefaultOverride`: значение или `null` (сброс override). */
  value: string | number | boolean | string[] | null;
}

/**
 * Отбирает дефолты привязок, которые надо записать на «Применить и закрыть»
 * (0.8.2): только реально изменившиеся, и только для привязок, которые сейчас
 * есть в таблицах вкладки (`attached` — registry `property_id` собственных и
 * унаследованных строк). Пустое значение (`null`) — сброс override, при
 * создании мысли тогда действует общее значение стороны. Чистая — юнит-тест
 * (`type-manager-default.test.ts`).
 */
export function collectBindingDefaultWrites(
  drafts: readonly BindingDefaultDraft[],
  attached: ReadonlySet<string>,
): BindingDefaultWrite[] {
  const writes: BindingDefaultWrite[] = [];
  for (const draftEntry of drafts) {
    if (!attached.has(draftEntry.propertyId)) continue;
    const next = bindingDefaultPayload(draftEntry.valueType, draftEntry.value);
    const before = bindingDefaultPayload(draftEntry.valueType, draftEntry.initial);
    if (sameDefaultPayload(next, before)) continue;
    writes.push({ propertyId: draftEntry.propertyId, value: next });
  }
  return writes;
}

/** Одинаковы ли два тела `setPropertyDefaultOverride` (порядок набора целей
 *  значим — как его отдаёт редактор чипов). */
function sameDefaultPayload(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The description-override dialog (task «Добавить описание (description) к
 * определениям свойств типов»): sets the effective description of an inherited
 * property for this type, or resets the override. Empty field = no override.
 * Дефолт значения такой диалог больше не имеет (0.8.2): он правится прямо в
 * колонке «По умолчанию» вкладки «Свойства».
 */
function openDescriptionOverrideDialog(opts: {
  networkId: string;
  ownerType: TypeOwnerType;
  typeId: string;
  def: EffectiveTypeProperty;
  onDone: () => void;
}): void {
  const { networkId, ownerType, typeId, def, onDone } = opts;
  const errorLine = span('', 'error-text');

  const area = el('textarea', 'textarea-input');
  area.value = def.description ?? '';
  area.rows = 5;
  area.placeholder = 'Описание свойства для этого типа (пусто — наследуется от родителя)';

  const body = div('form-stack');
  const hint = el(
    'p',
    'muted',
    `Свойство «${def.key}» наследуется от типа «${def.defined_on_name}». ` +
      'Здесь задаётся описание свойства только для этого типа (и его подчинённых, пока те не переопределят сами).',
  );
  hint.style.margin = '0';
  body.append(hint, area, errorLine);

  /** Applies the override (or clears it when the field is empty). */
  async function apply(close: () => void): Promise<void> {
    const description = area.value.trim();
    try {
      await etn.types.setPropertyDescriptionOverride(
        networkId,
        ownerType,
        typeId,
        def.id,
        description === '' ? null : description,
      );
      onDone();
      close();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  showDialog({
    title: `Описание свойства — «${def.key}»`,
    body,
    width: 460,
    buttons: [
      { label: 'Отменить' },
      ...(def.description_overridden
        ? [
            {
              label: 'Сбросить переопределение',
              keepOpen: true,
              onClick: (close: () => void): void => {
                void (async () => {
                  try {
                    await etn.types.setPropertyDescriptionOverride(
                      networkId,
                      ownerType,
                      typeId,
                      def.id,
                      null,
                    );
                    onDone();
                    close();
                  } catch (err) {
                    errorLine.textContent = errText(err);
                  }
                })();
              },
            } satisfies DialogButton,
          ]
        : []),
      { label: 'Применить', primary: true, keepOpen: true, onClick: (close) => void apply(close) },
    ],
  });
}

// ---------------------------------------------------------------------------
// Метаданные (задача 04cd9794)
// ---------------------------------------------------------------------------

/** Преобразует ThoughtType DTO в плоский набор полей для блока «Метаданные». */
function buildMetadataRowsFromType(type: ThoughtType): HTMLElement {
  const fields: MetadataFields = {
    id: type.id,
    createdAtMs: type.created_at_ms ?? type.created_at,
    createdBy: type.created_by ?? null,
    updatedAtMs: type.updated_at_ms ?? type.updated_at,
    updatedBy: type.updated_by ?? null,
  };
  return buildMetadataRows(fields);
}

/** Преобразует LinkType DTO в плоский набор полей для блока «Метаданные». */
function buildMetadataRowsFromLinkType(type: LinkType): HTMLElement {
  const fields: MetadataFields = {
    id: type.id,
    createdAtMs: type.created_at_ms ?? type.created_at,
    createdBy: type.created_by ?? null,
    updatedAtMs: type.updated_at_ms ?? type.updated_at,
    updatedBy: type.updated_by ?? null,
  };
  return buildMetadataRows(fields);
}
