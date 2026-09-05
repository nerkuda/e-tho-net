/**
 * Editor group: properties (H11, 08-ui-spec.md §6.3; 09-scenarios.md D4).
 *
 * Thought-only. When the thought has a type with property definitions, a table
 * of value editors is rendered per `value_type`:
 *  - text/number/date → inputs, saved on blur (empty → remove); a text value
 *    with predefined options also gets a suggestion dropdown that filters as
 *    the user types (an input aid, never a restriction);
 *  - url → input plus an «Открыть» button that hands the value to the OS
 *    default handler (http/https, file://, local paths, registered protocols);
 *  - bool → checkbox;
 *  - thought_ref → the stored thought is shown as a mini cloud of itself
 *    (icon + title in the thought's own colours/font, `applyCloudStyle`, dimmed
 *    when inactive/marked, red trash glyph when marked — the same reading as
 *    the history bar and the selection panel): single form with no value is an
 *    editable field doubling as a live candidate search (plus the
 *    duplicate-search dialog picker) — a picked value turns into the cloud;
 *    with `config.multiple` the cell is a chip list of mini clouds (the same
 *    chip styling as the structures filter panel). The «×» on a cloud removes
 *    the thought from the value; clicking the cloud (not the «×») switches to
 *    the map view, focuses the thought and opens it in the editor (the editor
 *    follows the focus).
 *
 * Values are written with `properties.set`, cleared with `properties.remove`;
 * realtime `property-value.*` events reload the table when the open entity is
 * the owner (a single module-level listener keeps closures bounded).
 *
 * Single text and thought_ref values also keep a client-local history of the
 * 10 last saved values per property (localStorage, `recent-values.ts`):
 * focusing the empty field — or clearing it back to empty — offers the
 * history as a dropdown; typing closes it so the field's regular behaviour
 * takes over. Multiple-value properties (`config.multiple`) keep no history.
 */

import type { EffectiveTypeProperty, PropertyValue, ThoughtRef } from '@etn/shared';

import { onRealtimeEvent } from '../realtime.js';
import { button, div, el, errText, positionBodyDropdown, setTooltip, span } from '../lib/dom.js';
import { confirmDialog } from '../lib/dialog.js';
import { etn } from '../lib/etn.js';
import { svgIcon } from '../lib/icons.js';
import { notice } from '../lib/notice.js';
import { logUiEvent } from '../lib/ui-log.js';
import { expandTypeIdsToSubtree } from '../lib/type-tree.js';
import { requireNetworkId, setFocus } from '../app.js';
import { applyCloudStyle, applyThoughtIcon, resolveCloudStyle } from '../canvas/canvas.js';
import { setActiveView } from '../screens/active-view.js';
import { store } from '../state.js';
import { registerMainSection, type EditorContext } from './editor.js';
import {
  loadRecentRefEntries,
  loadRecentValues,
  recordRecentValue,
  wireRecentValues,
} from './recent-values.js';
import { wireThoughtRefSearch } from './thought-picker.js';
import {
  firstPickedThoughtId,
  pickThoughtsDialog,
  pickedThoughtIds,
} from '../canvas/add-dialog.js';

/** Reload callback of the currently mounted properties table (or null). */
let currentReload: (() => void) | null = null;
let wired = false;

/**
 * Registers the properties section of the «Основное» tab (thoughts and links):
 * the main type-driven table of values, and the read-only «Свойства вне типа»
 * group underneath for values whose property is no longer attached to the
 * owner's type (0.6.5; спека «Значения вне типа сохраняются»).
 */
export function registerPropertiesGroup(): void {
  registerMainSection((ctx) => {
    // Both owners share the same section: the underlying render path
    // (buildPropertiesBody) is ownerType-driven. An owner without a type
    // resolves the catalogue root, just like untyped thoughts already do
    // (L21).
    const typeId = resolveEditorTypeId(ctx);
    if (typeId === null) return null;
    return {
      id: 'properties',
      title: 'Свойства',
      loadCount: () => countProperties(ctx),
      buildBody: () => buildPropertiesBody(ctx),
    };
  });
  if (!wired) {
    wired = true;
    onRealtimeEvent((evt) => {
      if (evt.type === 'property-value.set' || evt.type === 'property-value.deleted') {
        currentReload?.();
      }
    });
  }
}

/** Counts the type's effective property definitions for the group badge. */
async function countProperties(ctx: EditorContext): Promise<string | undefined> {
  const networkId = requireNetworkId();
  // L21: an owner without an own type falls back to the root type of its
  // type catalogue. The badge shows only the in-type definition count — the
  // «Свойства вне типа» group carries its own badge separately.
  const typeId = resolveEditorTypeId(ctx);
  if (typeId === null) return undefined;
  try {
    const defs = await etn.types.listTypeProperties(networkId, ownerTypeOf(ctx), typeId);
    return `(${defs.length})`;
  } catch {
    return undefined;
  }
}

/**
 * The type whose properties the editor shows (L21): the thought/link's own
 * type, or the root type «основной тип» for an owner without one (its
 * settings apply to every element without a type). `null` when the catalogue
 * has no root (mid-migration edge).
 */
function resolveEditorTypeId(ctx: EditorContext): string | null {
  const own = ctx.ownerType === 'thought' ? ctx.thought?.type_id : ctx.link?.type_id;
  if (own != null) return own;
  return rootTypeIdFor(ctx.ownerType);
}

/** `TypeOwnerType` ('thought_type' | 'link_type') matching the editor owner. */
function ownerTypeOf(ctx: EditorContext): 'thought_type' | 'link_type' {
  return ctx.ownerType === 'thought' ? 'thought_type' : 'link_type';
}

/** The root type of the owner's type catalogue (thoughts or links). */
function rootTypeIdFor(ownerType: 'thought' | 'link'): string | null {
  if (ownerType === 'thought') {
    return store.state.thoughtTypes.find((t) => t.is_root)?.id ?? null;
  }
  return store.state.linkTypes.find((t) => t.is_root)?.id ?? null;
}

/**
 * Builds the properties group body for the current owner — thoughts and
 * links share the same render path. The main table shows in-type values;
 * the read-only «Свойства вне типа» group underneath lists values whose
 * property is no longer attached to the owner's type (0.6.5; спека
 * «Значения вне типа сохраняются»).
 */
function buildPropertiesBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const ownerId = ctx.ownerId;
  const ownerType = ctx.ownerType;
  const typeOwner = ownerTypeOf(ctx);
  const typeId = resolveEditorTypeId(ctx);

  const box = div('properties-body');
  if (typeId === null) {
    box.append(el('p', 'muted', 'Свойства недоступны.'));
    return box;
  }
  // Guarded above; the fallback is unreachable but keeps closure typing honest.
  const typedId: string = typeId;

  const tableWrap = div('admin-table-wrap prop-wrap');
  // No column headers and at most five visible rows — vertical scroll beyond
  // that (08-ui-spec.md §6.3.1).
  tableWrap.append(el('span', 'muted', 'Загрузка…'));
  box.append(tableWrap);

  // The read-only «Свойства вне типа» group: hidden until the reload pass
  // finds at least one such value. The render happens inside the same
  // `reload()` so a freshly-deleted value refreshes both views at once.
  const outsideWrap = div('prop-outside-wrap');

  // Full metadata of every referenced thought (single ids and multiple-ref
  // arrays alike) — titles, icon, colours and flags for the mini clouds.
  const refCache = new Map<string, ThoughtRef>();
  // Declared BEFORE the initial reload() call below: reload is a hoisted
  // function declaration, and reading this from inside it during the call at
  // the `void reload()` line would hit the temporal dead zone.
  let everMounted = false;
  currentReload = () => void reload();
  void reload();

  /** Loads definitions + values and renders the table. */
  async function reload(): Promise<void> {
    // The first reload starts before the group mounts this box — it must
    // proceed detached. Skip only bodies that were mounted and then replaced
    // by a newer editor render.
    if (everMounted && !box.isConnected) return;
    const startedAt = Date.now();
    tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
    outsideWrap.replaceChildren();
    let definitions: EffectiveTypeProperty[];
    let values: PropertyValue[];
    try {
      [definitions, values] = await Promise.all([
        etn.types.listTypeProperties(networkId, typeOwner, typedId),
        etn.properties.get(networkId, ownerType, ownerId),
      ]);
      // Full metadata of every referenced thought — single ids and
      // multiple-ref arrays alike (one resolve call, capped at 100 ids) —
      // cached for the mini-cloud rendering (title, icon, styles, flags).
      const refIds = [
        ...new Set(
          values.flatMap((v) =>
            typeof v.value === 'string'
              ? [v.value]
              : Array.isArray(v.value)
                ? v.value
                : [],
          ),
        ),
      ];
      if (refIds.length > 0) {
        const resolved = await etn.thoughts.resolve(networkId, refIds.slice(0, 100));
        for (const ref of resolved) refCache.set(ref.id, ref);
      }
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    if (box.isConnected) everMounted = true;
    if (definitions.length === 0) {
      tableWrap.replaceChildren(el('p', 'muted', 'У типа нет свойств.'));
      renderOutsideType(values);
      return;
    }

    const valueByProp = new Map(values.map((v) => [v.property_id, v]));
    const table = el('table', 'table-list prop-table');
    // Headerless table (08-ui-spec.md §6.3.1): rows only.
    const tbody = el('tbody');
    for (const definition of definitions) {
      const value = valueByProp.get(definition.id);
      const row = el('tr');
      const source = definition.inherited
        ? ` · из «${definition.defined_on_name}»`
        : '';
      const nameCell = el(
        'td',
        undefined,
        `${definition.key}${definition.required ? ' *' : ''} (${typeName(definition.value_type)})${source}`,
      );
      // Property description (task «Добавить описание (description) к
      // определениям свойств типов»): a hint next to the property name —
      // the ⓘ marker shows one is there, the tooltip carries the text
      // (override-aware: the effective description of the L21 chain).
      const hint = propertyHint(definition);
      if (hint !== null) {
        setTooltip(nameCell, hint);
        nameCell.append(span(' ⓘ', 'muted'));
      }
      row.append(nameCell);
      row.append(buildEditorCell(definition, value));
      tbody.append(row);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
    // The outside-type group lives BELOW the main table (08-ui-spec.md
    // §6.3.1, спека «Значения вне типа сохраняются»). The two are
    // re-rendered together so a delete in either place refreshes the other.
    renderOutsideType(values);
    // Milestone journal mark (task 92b89e6f): the properties table really
    // rendered — the closing bracket of the «stuck "Загрузка…"» symptom path.
    logUiEvent('ui.editor.props.loaded', {
      id: ownerId,
      ms: Date.now() - startedAt,
      definitions: definitions.length,
    });
  }

  /** Confirmed deletion of an outside-type value (custom confirmation dialog). */
  async function confirmOutsideRemove(name: string): Promise<boolean> {
    return confirmDialog(
      'Удалить значение свойства',
      `Свойство «${name}» больше не подключено к типу. Удалить сохранённое значение? Действие необратимо — таких значений система сама не очищает.`,
      true,
    );
  }

  /**
   * Renders the «Свойства вне типа» group under the main table. Hidden
   * entirely when no values carry `outside_type: true` — the group's mere
   * presence would otherwise hint at non-existent clutter (08-ui-spec.md
   * §6.3.1, спека «Значения вне типа сохраняются»).
   */
  function renderOutsideType(values: PropertyValue[]): void {
    const outside = values.filter((v) => v.outside_type === true);
    if (outside.length === 0) {
      outsideWrap.replaceChildren();
      return;
    }
    outsideWrap.replaceChildren(buildOutsideTypeTable(outside));
  }

  /**
   * The body of the «Свойства вне типа» group: a headerless read-only table
   * mirroring the main one, with one row per orphaned value. The row carries
   * the property name and value (mini-cloud for thought_ref, chips for
   * multiple, plain text otherwise) — visually identical to the main table,
   * but without any editor widget. The only action is «×» removing the value
   * with a confirmation prompt (the system itself never deletes such values).
   */
  function buildOutsideTypeTable(values: PropertyValue[]): HTMLElement {
    const root = div('prop-outside');
    const header = div('prop-outside-header');
    header.append(span('Свойства вне типа', 'prop-outside-title'));
    header.append(
      span(
        'Свойство отключено от типа — значение можно только удалить.',
        'muted prop-outside-hint',
      ),
    );
    root.append(header);
    const table = el('table', 'table-list prop-outside-table');
    const tbody = el('tbody');
    for (const value of values) {
      const row = el('tr');
      const nameCell = el(
        'td',
        undefined,
        `${value.property_name} (${typeName(value.value_type)})`,
      );
      setTooltip(
        nameCell,
        'Свойство больше не подключено к типу владельца — значение сохраняется только для истории.',
      );
      row.append(nameCell);
      row.append(buildOutsideValueCell(value));
      tbody.append(row);
    }
    table.append(tbody);
    root.append(table);
    return root;
  }

  /** Read-only value cell for an outside-type value: same visuals, no editor. */
  function buildOutsideValueCell(value: PropertyValue): HTMLElement {
    const cell = el('td', 'prop-outside-cell');
    const remove = (): void => {
      void (async () => {
        const ok = await confirmOutsideRemove(value.property_name);
        if (!ok) return;
        try {
          // The only allowed write against an outside-type value (02-data-
          // model.md §3.5a): removal. The server resolves the property by
          // `property_name` (a UUID would also work) so a stale name no
          // longer breaks the call.
          await etn.properties.remove(networkId, ownerType, ownerId, value.property_name);
          void reload();
        } catch (err) {
          notice(`Не удалось удалить значение: ${errText(err)}`, 'error');
        }
      })();
    };

    const stored = value.value;
    switch (value.value_type) {
      case 'thought_ref': {
        if (Array.isArray(stored)) {
          cell.append(
            buildMultiThoughtRefReadonly({
              ids: stored,
              refs: refCache,
              onOpen: openThoughtRefTarget,
            }),
          );
        } else if (typeof stored === 'string') {
          const row = div('form-row');
          row.style.marginBottom = '0';
          row.append(
            buildThoughtRefCloud(stored, {
              refs: refCache,
              onOpen: openThoughtRefTarget,
              // The cloud's «×» removes the value — the only write path
              // outside-type values support. The same confirmation covers it.
              onRemove: remove,
            }),
          );
          cell.append(row);
        } else {
          cell.append(span('—', 'muted'));
        }
        break;
      }
      case 'text':
      case 'url':
      case 'number':
      case 'date':
      case 'bool': {
        if (value.value_type === 'url' && Array.isArray(stored)) {
          cell.append(buildMultiUrlReadonly({ urls: stored, onOpen: openOneUrl }));
        } else if (value.value_type === 'url' && typeof stored === 'string') {
          const row = div('form-row');
          row.style.marginBottom = '0';
          row.append(span(stored, 'prop-outside-text'), buildUrlOpenBtn(stored));
          cell.append(row);
        } else if (typeof stored === 'string' || typeof stored === 'number') {
          cell.append(span(String(stored), 'prop-outside-text'));
        } else if (typeof stored === 'boolean') {
          cell.append(span(stored ? 'да' : 'нет', 'prop-outside-text'));
        } else {
          cell.append(span('—', 'muted'));
        }
        break;
      }
      default:
        cell.append(span('—', 'muted'));
    }

    // The «×» on every row — same convention as the main table's mini cloud
    // «×», so the action reads the same regardless of which group it's in.
    const clearBtn = el('button', 'st-f-clear-inline prop-outside-remove', '×');
    clearBtn.type = 'button';
    clearBtn.title = 'Удалить значение';
    clearBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      remove();
    });
    cell.append(clearBtn);
    return cell;
  }

  /** Hand a single URL to the OS default handler; failure → toast. */
  async function openOneUrl(value: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed === '') return;
    const err = await etn.system.openExternal(trimmed);
    if (err !== '') notice(`Не удалось открыть: ${err}`, 'error');
  }

  /** Read-only «Открыть» button for a single URL value. */
  function buildUrlOpenBtn(value: string): HTMLButtonElement {
    const btn = button(
      'Открыть',
      () => void openOneUrl(value),
      'btn small',
      'Открыть в системном обработчике',
    );
    btn.disabled = value.trim() === '';
    return btn;
  }

  // The outside-type group is appended AFTER the main table once, so the
  // layout (main on top, outside below) stays stable across reloads. The
  // group's content is replaced inside `renderOutsideType`.
  box.append(outsideWrap);

  /**
   * Opens a thought referenced by a property value (08-ui-spec.md §6.3.1):
   * switches to the map view, then focuses the thought — the editor follows
   * the focus and opens it (the same landing rule as deep links,
   * 12-wiki-id-refs.md §7.4). An inactive thought with «скрывать неактуальное»
   * on is refused with the same notice as wiki-links (§6.4).
   */
  function openThoughtRefTarget(id: string): void {
    const ref = refCache.get(id);
    if (ref !== undefined && !ref.active && !store.state.showInactive) {
      notice('Не могу открыть неактуальную мысль — неактуальные мысли не отображаются.', 'error');
      return;
    }
    setActiveView('map');
    void setFocus(id).catch((err: unknown) => {
      notice(`Не удалось открыть мысль: ${errText(err)}`, 'error');
    });
  }

  /** Builds the value editor cell for one property. */
  function buildEditorCell(
    definition: EffectiveTypeProperty,
    current: PropertyValue | undefined,
  ): HTMLElement {
    const cell = el('td');
    const stored = current?.value ?? null;

    const save = async (value: unknown | null): Promise<boolean> => {
      try {
        if (value === null) {
          await etn.properties.remove(networkId, ownerType, ownerId, definition.key);
        } else {
          await etn.properties.set(networkId, ownerType, ownerId, definition.key, value);
          // A successful save feeds the client-local recent-values history of
          // single text/thought_ref properties (recent-values.ts).
          if (typeof value === 'string' && tracksRecentValues(definition)) {
            recordRecentValue(networkId, definition.id, value);
          }
        }
        return true;
      } catch (err) {
        cell.append(span(` Ошибка: ${errText(err)}`, 'error-text'));
        return false;
      }
    };

    switch (definition.value_type) {
      case 'text':
      case 'url': {
        // Multiple form (task 0.6.2) for `url` — a list of URL fields, each
        // with its own «Открыть» button, plus an «+» adding a new row and a
        // «×» removing one (08-ui-spec.md §6.3.1). The stored shape is a JSON
        // array in `value_text` (02-data-model.md §3.5) — never comma-joined,
        // because URLs may contain commas.
        if (definition.value_type === 'url' && definition.config?.multiple === true) {
          const storedUrls = Array.isArray(stored)
            ? stored
            : typeof stored === 'string'
              ? [stored]
              : [];
          cell.append(
            buildMultiUrlEditor({
              urls: storedUrls,
              save: async (next) => {
                await save(next.length > 0 ? next : null);
              },
            }),
          );
          break;
        }
        const input = el('input', 'text-input prop-editor');
        input.type = 'text';
        input.value = typeof stored === 'string' ? stored : '';
        if (definition.value_type === 'url') {
          input.placeholder = 'https://… или путь к файлу';
          input.title = 'URL или путь к файлу';
        }
        // Baseline tracks the last saved value so picker commits and plain
        // blur commits never fire twice for the same value.
        let baseline: string | null = typeof stored === 'string' ? stored : null;
        const commitValue = (value: string): void => {
          const next = value === '' ? null : value;
          if (next === baseline) return;
          baseline = next;
          void save(next);
        };
        input.addEventListener('blur', () => commitValue(input.value));
        // Recent-values suggestions (recent-values.ts): focusing the empty
        // field — or clearing it back to empty — offers the 10 last saved
        // values of this property; typing closes the list so the regular
        // behaviour (the options dropdown, blur commit) takes over.
        const recent = tracksRecentValues(definition);
        if (recent) {
          wireRecentValues(input, {
            load: () =>
              loadRecentValues(networkId, definition.id).map((value) => ({
                value,
                label: value,
              })),
            onPick: (entry) => {
              input.value = entry.value;
              commitValue(entry.value);
            },
          });
        }
        // A text property with predefined options (02-data-model.md §3.4)
        // gets a picker — an input aid, never a restriction: the value stays
        // freely editable (08-ui-spec.md §6.3).
        const options =
          definition.value_type === 'text'
            ? (definition.config?.options ?? []).filter((o) => o !== '')
            : [];
        if (options.length > 0) {
          const revertValue = (): void => {
            input.value = baseline ?? '';
          };
          const row = div('form-row');
          row.style.marginBottom = '0';
          row.append(
            input,
            buildValueOptionsCaret(
              input,
              options,
              definition.config?.multiple === true,
              commitValue,
              revertValue,
              // With the recent wiring an emptied field shows the recent
              // list, not the full catalogue (the caret still shows all).
              recent,
            ),
          );
          cell.append(row);
        } else if (definition.value_type === 'url') {
          // A url property gets an «Открыть» button: it hands the value to the
          // OS default handler — http/https, `file://`, local paths and other
          // registered protocols (obsidian://, …); a failure to open surfaces
          // as a toast (08-ui-spec.md §6.3.1). Clicking blurs the input first,
          // so the pending edit is committed before it is opened.
          const openBtn = button('Открыть', () => void openUrlExternally(), 'btn small');
          const syncOpenBtn = (): void => {
            openBtn.disabled = input.value.trim() === '';
          };
          async function openUrlExternally(): Promise<void> {
            const value = input.value.trim();
            if (value === '') return;
            const err = await etn.system.openExternal(value);
            if (err !== '') notice(`Не удалось открыть: ${err}`, 'error');
          }
          input.addEventListener('input', syncOpenBtn);
          syncOpenBtn();
          const row = div('form-row');
          row.style.marginBottom = '0';
          row.append(input, openBtn);
          cell.append(row);
        } else {
          cell.append(input);
        }
        break;
      }
      case 'number': {
        const input = el('input', 'text-input prop-editor');
        input.type = 'number';
        input.value = typeof stored === 'number' ? String(stored) : '';
        input.addEventListener('blur', () => {
          const next = input.value === '' ? null : Number(input.value);
          if (next === null) void save(null);
          else if (next !== stored && Number.isFinite(next)) void save(next);
        });
        cell.append(input);
        break;
      }
      case 'date': {
        const input = el('input', 'text-input prop-editor');
        input.type = 'date';
        input.value = typeof stored === 'string' ? stored.slice(0, 10) : '';
        input.addEventListener('blur', () => {
          if (input.value === '') void save(null);
          else void save(input.value);
        });
        cell.append(input);
        break;
      }
      case 'bool': {
        const input = el('input');
        input.type = 'checkbox';
        input.checked = stored === true;
        input.addEventListener('change', () => void save(input.checked));
        cell.append(input);
        break;
      }
      case 'thought_ref': {
        // Type filter from the definition config (list form supersedes the
        // legacy single id); an input aid — stored values are untouched.
        // L21: the filter expands to whole subtrees — a parent type matches
        // its descendants (mirror of the server-side validation).
        const filterIds = expandTypeIdsToSubtree(
          store.state.thoughtTypes,
          (
            definition.config?.allowed_type_ids ??
            (definition.config?.allowed_type_id !== undefined
              ? [definition.config.allowed_type_id]
              : [])
          ).filter((id) => id !== ''),
        );
        /** Opens the duplicate-search dialog picker (single mode). */
        const openSinglePicker = (): void => {
          void pickThoughtsDialog({
            networkId,
            allowCreate: false,
            allowLinkType: false,
            searchTypeIds: filterIds,
          }).then(async (result) => {
            const id = firstPickedThoughtId(result);
            if (id !== null && (await save(id))) void reload();
          });
        };
        // Multiple form (02-data-model.md §3.4): a chip list of mini clouds
        // (the same chip styling as the structures filter panel); the dialog
        // picker runs in multi mode (prefilled), each chip is removable
        // (08-ui-spec.md §6.3.1).
        if (definition.config?.multiple === true) {
          const storedIds = Array.isArray(stored)
            ? stored
            : typeof stored === 'string'
              ? [stored]
              : [];
          cell.append(
            buildMultiThoughtRefEditor({
              networkId,
              filterIds,
              refs: refCache,
              ids: storedIds,
              onOpen: openThoughtRefTarget,
              save: async (ids) => {
                const ok = await save(ids.length > 0 ? ids : null);
                if (ok) void reload();
              },
            }),
          );
          break;
        }
        const storedId = typeof stored === 'string' ? stored : null;
        // A stored value renders as the thought's mini cloud (icon + title in
        // its own colours/font): the «×» on the cloud clears the value and
        // brings the live-search field back, a click opens the thought on the
        // map (08-ui-spec.md §6.3.1).
        if (storedId !== null) {
          const row = div('form-row');
          row.style.marginBottom = '0';
          row.append(
            buildThoughtRefCloud(storedId, {
              refs: refCache,
              onOpen: openThoughtRefTarget,
              onRemove: () => {
                void save(null).then((ok) => {
                  if (ok) void reload();
                });
              },
            }),
            button('выбрать', openSinglePicker, 'btn small'),
          );
          cell.append(row);
          break;
        }
        const input = el('input', 'text-input prop-editor');
        input.type = 'text';
        input.autocomplete = 'off';
        input.placeholder = 'введите название для поиска…';
        // The field doubles as a live search: typing lists candidates (with
        // the type filter applied); only a picked candidate writes the value.
        // The modal picker stays as an alternative way to choose.
        wireThoughtRefSearch(input, {
          networkId,
          typeIds: filterIds,
          // No realtime echo to the actor (04-realtime.md §5) — reload the
          // table after a successful save so the mini cloud appears at once.
          onPick: async (id) => {
            if (await save(id)) void reload();
          },
        });
        // Recent-values suggestions (recent-values.ts): focusing the empty
        // field — or clearing it back to empty — offers the 10 last saved
        // values as resolved titles; typing closes the list so the live
        // candidate search takes over.
        wireRecentValues(input, {
          load: () => loadRecentRefEntries(networkId, definition.id, refCache),
          onPick: (entry) => {
            void save(entry.value).then((ok) => {
              if (ok) void reload();
            });
          },
        });
        const row = div('form-row');
        row.style.marginBottom = '0';
        row.append(input, button('выбрать', openSinglePicker, 'btn small'));
        cell.append(row);
        break;
      }
    }
    return cell;
  }

  return box;
}

/** Human-readable property type name (used by both the main table and the
 * «Свойства вне типа» group, so it lives at module scope). */
function typeName(valueType: string): string {
  switch (valueType) {
    case 'text':
      return 'строка';
    case 'number':
      return 'число';
    case 'date':
      return 'дата';
    case 'bool':
      return 'да/нет';
    case 'thought_ref':
      return 'мысль';
    case 'url':
      return 'URL';
    default:
      return valueType;
  }
}

/** Test seam for unit tests. */
export const propertiesInternals = { buildPropertiesBody };

/**
 * The hint shown next to a property name in the thought editor (task
 * «Добавить описание (description) к определениям свойств типов»): the
 * property's effective description (override-aware, L21) — `null` when the
 * property has none, in which case no ⓘ marker / tooltip is rendered.
 * Trimmed so a whitespace-only description behaves like an absent one.
 */
export function propertyHint(definition: EffectiveTypeProperty): string | null {
  const text = definition.description?.trim();
  return text === undefined || text === '' ? null : text;
}

/**
 * Whether a property definition keeps the client-local recent-values history
 * (recent-values.ts): single `text` and `thought_ref` properties only —
 * multiple-value properties (`config.multiple`) and the other value types
 * (number/date/bool/url) are out of scope.
 */
function tracksRecentValues(definition: EffectiveTypeProperty): boolean {
  if (definition.config?.multiple === true) return false;
  return definition.value_type === 'text' || definition.value_type === 'thought_ref';
}

// ---------------------------------------------------------------------------
// thought_ref mini clouds (08-ui-spec.md §6.3.1)
// ---------------------------------------------------------------------------

/**
 * Builds the mini cloud of a stored single `thought_ref` value: icon + title
 * in the thought's own colours/font (`applyCloudStyle`), dimmed when the
 * thought is inactive/marked, the red trash glyph when marked — the same
 * reading as the history-bar chips (§11.1). Clicking the cloud calls
 * {@link opts.onOpen}; the «×» inside it calls {@link opts.onRemove} without
 * triggering the open.
 */
export function buildThoughtRefCloud(
  id: string,
  opts: {
    /** Shared id → resolved ref cache: label, icon, styles, flags. */
    refs: Map<string, ThoughtRef>;
    /** Click-to-open handler (map view + focus). */
    onOpen: (id: string) => void;
    /** «×» handler — removes the value. */
    onRemove: () => void;
  },
): HTMLElement {
  const ref = opts.refs.get(id);
  const cloud = div('prop-ref-cloud');
  cloud.dataset['id'] = id;
  if (ref !== undefined) applyCloudStyle(cloud, resolveCloudStyle(ref));
  if (ref?.active === false || ref?.marked_for_deletion === true) {
    cloud.classList.add('dim');
  }
  const icon = el('span', 'mini-icon');
  if (ref !== undefined) applyThoughtIcon(icon, ref);
  else icon.textContent = '💭';
  const title = ref?.title ?? id;
  cloud.append(icon, el('span', 'prc-title', title));
  setTooltip(cloud, title);
  // A thought in the trash (S13, §5a.2): the cloud dims and carries the red
  // trash glyph — the same marked reading as the history bar, chip-sized.
  if (ref?.marked_for_deletion === true) {
    const mark = span('', 'list-trash-mark');
    mark.append(svgIcon('trash', 10));
    cloud.append(mark);
  }
  cloud.addEventListener('click', () => opts.onOpen(id));
  const removeBtn = el('button', 'st-f-clear-inline', '✕');
  removeBtn.type = 'button';
  removeBtn.title = 'Очистить значение';
  // The cloud's own click opens the thought — stop it here.
  removeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    opts.onRemove();
  });
  cloud.append(removeBtn);
  return cloud;
}

// ---------------------------------------------------------------------------
// Multiple thought_ref picker (08-ui-spec.md §6.3.1)
// ---------------------------------------------------------------------------

/**
 * Builds the multi-value `thought_ref` editor (definitions with
 * `config.multiple`): a chip field listing the selected thoughts as mini
 * clouds (icon + title in the thought's own colours/font — the same chip
 * styling as the structures filter panel) plus a «выбрать» button. Clicking
 * the field or «выбрать» opens the universal thought picker in **multi mode**
 * (prefilled with the current ids, honouring the definition's type filter);
 * applying writes the full replacement list through `save`. Every chip has a
 * «×» removing that single value; removing the last one clears the property.
 * When {@link opts.onOpen} is given (the editor's properties table), clicking
 * a chip navigates to the thought instead of bubbling into the picker.
 *
 * Missing chip metadata is resolved in the background via `thoughts.resolve`
 * into the shared `refs` cache, then the chips re-render.
 *
 * Also reused by the selection panel's property-values dialog: there `save`
 * writes the list into the dialog state instead of saving it immediately and
 * `onOpen` is omitted, so chip clicks keep opening the picker.
 */
export function buildMultiThoughtRefEditor(opts: {
  networkId: string;
  /** Thought-type filter of the definition config (input aid). */
  filterIds: string[];
  /** Shared id → resolved ref cache: chip labels, icons and styles. */
  refs: Map<string, ThoughtRef>;
  /** Currently selected thought ids. */
  ids: string[];
  /** Writes the full replacement list; an empty list clears the value. */
  save: (ids: string[]) => Promise<unknown> | unknown;
  /** Click-to-open handler of a chip (map view + focus); omitted → picker. */
  onOpen?: (id: string) => void;
}): HTMLElement {
  const field = div('st-f-chipfield');
  field.tabIndex = 0;
  field.title = 'Выбрать мысли (несколько)';

  const renderChips = (): void => {
    field.replaceChildren();
    if (opts.ids.length === 0) {
      field.append(span('— не задано —', 'st-f-chip-empty'));
      return;
    }
    opts.ids.forEach((id, index) => {
      const ref = opts.refs.get(id);
      const chip = div('st-f-chip');
      const icon = div('st-f-chip-icon');
      applyThoughtIcon(icon, ref ?? { icon: null, icon_kind: 'emoji', type_id: null });
      chip.append(icon);
      const label = span(ref?.title ?? id, 'st-f-chip-label');
      label.title = ref?.title ?? id;
      if (ref !== undefined) applyCloudStyle(label, resolveCloudStyle(ref));
      chip.append(label);
      // A thought in the trash (S13, §5a.2): the chip dims and carries the
      // red trash glyph — the same marked reading as everywhere else.
      if (ref?.active === false || ref?.marked_for_deletion === true) {
        chip.classList.add('dim');
      }
      if (ref?.marked_for_deletion === true) {
        const mark = span('', 'list-trash-mark');
        mark.append(svgIcon('trash', 10));
        chip.append(mark);
      }
      const removeBtn = el('button', 'st-f-clear-inline', '×');
      removeBtn.type = 'button';
      removeBtn.title = 'Убрать значение';
      removeBtn.addEventListener('click', (event) => {
        // The field's own click opens the picker — stop it here.
        event.stopPropagation();
        void opts.save(opts.ids.filter((_, i) => i !== index));
      });
      chip.append(removeBtn);
      // With an open handler the chip navigates to the thought instead of
      // bubbling into the picker (08-ui-spec.md §6.3.1).
      chip.addEventListener('click', (event) => {
        if (opts.onOpen === undefined) return;
        event.stopPropagation();
        opts.onOpen(id);
      });
      field.append(chip);
    });
  };

  const openPicker = (): void => {
    void pickThoughtsDialog({
      networkId: opts.networkId,
      allowCreate: false,
      allowLinkType: false,
      searchTypeIds: opts.filterIds,
      // Prefill switches the dialog into multi mode automatically.
      selectedIds: opts.ids,
      title: 'Выбрать мысли',
      applyLabel: 'Выбрать',
    }).then((result) => {
      if (result === null) return;
      void opts.save(pickedThoughtIds(result));
    });
  };

  field.addEventListener('click', openPicker);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openPicker();
  });

  // Resolve chip metadata that is not in the cache yet (fresh picks), then
  // re-render; the raw id stays visible when resolve fails.
  const missing = opts.ids.filter((id) => !opts.refs.has(id));
  if (missing.length > 0) {
    void etn.thoughts
      .resolve(opts.networkId, missing)
      .then((refs) => {
        for (const ref of refs) opts.refs.set(ref.id, ref);
        renderChips();
      })
      .catch(() => undefined);
  }

  renderChips();
  const row = div('form-row');
  row.style.marginBottom = '0';
  row.append(
    field,
    button('выбрать', openPicker, 'btn small', 'Выбрать мысли (несколько)'),
  );
  return row;
}

// ---------------------------------------------------------------------------
// Multiple URL editor (08-ui-spec.md §6.3.1)
// ---------------------------------------------------------------------------

/**
 * Builds the multi-value `url` editor for definitions with
 * `config.multiple = true` (task 0.6.2): one row per URL string, each row a
 * text input + «Открыть» button + «×» removing that single value. The bottom
 * of the editor carries an «+» button that appends a new empty row and
 * immediately focuses it. Every edit is debounced and committed through
 * {@link opts.save}; an empty value list clears the property (the same
 * semantics as `thought_ref`'s multi editor). URL/file-path strings are
 * stored verbatim — no parsing, no comma-join (02-data-model.md §3.5).
 */
export function buildMultiUrlEditor(opts: {
  /** Currently stored URLs (already normalized server-side: `string[]`). */
  urls: string[];
  /** Writes the full replacement list; an empty list clears the value. */
  save: (urls: string[]) => Promise<unknown> | unknown;
}): HTMLElement {
  const root = div('multi-url-editor');
  // Local working copy: edits never touch the input arg directly so the
  // baseline diff stays meaningful (the host calls `save` with the latest
  // trimmed non-empty list and reloads once the write succeeds).
  let current: string[] = [...opts.urls];

  const renderRows = (): void => {
    root.replaceChildren();
    let lastInput: HTMLInputElement | null = null;
    current.forEach((url, index) => {
      const row = div('form-row multi-url-row');
      row.style.marginBottom = '0';
      const input = el('input', 'text-input prop-editor multi-url-input');
      input.type = 'text';
      input.value = url;
      input.placeholder = 'https://… или путь к файлу';
      input.title = 'URL или путь к файлу';
      const openBtn = button(
        'Открыть',
        () => void openOne(input.value),
        'btn small multi-url-open',
      );
      openBtn.disabled = input.value.trim() === '';
      input.addEventListener('input', () => {
        openBtn.disabled = input.value.trim() === '';
      });
      // Commit on blur: write the trimmed value at the same index, then
      // collapse trailing empty rows so a stray «+» row never lingers after
      // the user emptied it.
      input.addEventListener('blur', () => {
        const trimmed = input.value.trim();
        current[index] = trimmed;
        collapseTrailingEmpty();
        renderRows();
        void opts.save(current.filter((u) => u !== ''));
      });
      const removeBtn = el('button', 'st-f-clear-inline multi-url-remove', '×');
      removeBtn.type = 'button';
      removeBtn.title = 'Убрать значение';
      removeBtn.addEventListener('click', (event) => {
        event?.stopPropagation?.();
        current.splice(index, 1);
        collapseTrailingEmpty();
        renderRows();
        void opts.save(current.filter((u) => u !== ''));
      });
      row.append(input, openBtn, removeBtn);
      root.append(row);
      lastInput = input as unknown as HTMLInputElement;
    });
    const addBtn = el('button', 'btn small multi-url-add', '+');
    addBtn.type = 'button';
    addBtn.title = 'Добавить ещё одно значение';
    addBtn.addEventListener('click', (event) => {
      event?.stopPropagation?.();
      current.push('');
      renderRows();
      if (lastInput !== null && typeof lastInput.focus === 'function') {
        lastInput.focus();
      }
    });
    addBtn.title = 'Добавить ещё одно значение';
    addBtn.type = 'button';
    root.append(addBtn);
  };

  /** Drop trailing empty rows so a freshly-added «+» row collapses on blur. */
  function collapseTrailingEmpty(): void {
    while (current.length > 0 && current[current.length - 1] === '') {
      current.pop();
    }
  }

  /** Hand a single URL to the OS default handler; failure → toast. */
  async function openOne(value: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed === '') return;
    const err = await etn.system.openExternal(trimmed);
    if (err !== '') notice(`Не удалось открыть: ${err}`, 'error');
  }

  renderRows();
  return root;
}

// ---------------------------------------------------------------------------
// Outside-type read-only renderers (08-ui-spec.md §6.3.1, 0.6.5 «Значения вне
// типа сохраняются»)
// ---------------------------------------------------------------------------

/**
 * Read-only chip list for a multi-value `thought_ref` outside-type value:
 * same chip styling as the main editor (icon + title in the thought's own
 * colours/font, dimmed when inactive/marked, trash glyph when marked), but
 * without the «×» removing the value (the only removal action lives on the
 * row's clear button). Clicking a chip still navigates to the thought via
 * {@link opts.onOpen}.
 */
export function buildMultiThoughtRefReadonly(opts: {
  ids: string[];
  refs: Map<string, ThoughtRef>;
  onOpen: (id: string) => void;
}): HTMLElement {
  const field = div('st-f-chipfield prop-outside-chipfield');
  if (opts.ids.length === 0) {
    field.append(span('—', 'st-f-chip-empty'));
    return field;
  }
  for (const id of opts.ids) {
    const ref = opts.refs.get(id);
    const chip = div('st-f-chip');
    const icon = div('st-f-chip-icon');
    applyThoughtIcon(icon, ref ?? { icon: null, icon_kind: 'emoji', type_id: null });
    chip.append(icon);
    const label = span(ref?.title ?? id, 'st-f-chip-label');
    label.title = ref?.title ?? id;
    if (ref !== undefined) applyCloudStyle(label, resolveCloudStyle(ref));
    chip.append(label);
    if (ref?.active === false || ref?.marked_for_deletion === true) {
      chip.classList.add('dim');
    }
    if (ref?.marked_for_deletion === true) {
      const mark = span('', 'list-trash-mark');
      mark.append(svgIcon('trash', 10));
      chip.append(mark);
    }
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      opts.onOpen(id);
    });
    field.append(chip);
  }
  return field;
}

/**
 * Read-only list of URL strings for an outside-type multi-`url` value: one
 * line per URL with an «Открыть» button. The only removal action lives on
 * the row's clear button — the URL row itself is purely informational.
 */
export function buildMultiUrlReadonly(opts: {
  urls: string[];
  onOpen: (value: string) => void;
}): HTMLElement {
  const root = div('prop-outside-multi-url');
  if (opts.urls.length === 0) {
    root.append(span('—', 'muted'));
    return root;
  }
  for (const url of opts.urls) {
    const row = div('form-row');
    row.style.marginBottom = '0';
    const text = span(url, 'prop-outside-text');
    text.style.flex = '1 1 auto';
    row.append(text, buildUrlOpenBtnStatic(url, opts.onOpen));
    root.append(row);
  }
  return root;
}

/** Builds a disabled «Открыть» button bound to {@link onOpen}; used in readonly cells. */
function buildUrlOpenBtnStatic(value: string, onOpen: (value: string) => void): HTMLButtonElement {
  const btn = button(
    'Открыть',
    () => onOpen(value),
    'btn small',
    'Открыть в системном обработчике',
  );
  btn.disabled = value.trim() === '';
  return btn;
}

// ---------------------------------------------------------------------------
// Predefined text options picker (08-ui-spec.md §6.3)
// ---------------------------------------------------------------------------

/** Splits a stored multi-value string into trimmed non-empty parts. */
export function splitMultiValue(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * The fragment the user is currently typing: the whole input in single mode,
 * the part after the last comma in multiple mode. Lowercased for matching.
 */
export function autocompleteFragment(text: string, multiple: boolean): string {
  const fragment = multiple ? text.slice(Math.max(text.lastIndexOf(',') + 1, 0)) : text;
  return fragment.trim().toLowerCase();
}

/**
 * Options containing the typed fragment (case-insensitive); an empty fragment
 * shows the full catalogue.
 */
export function filterOptionsByFragment(options: string[], fragment: string): string[] {
  if (fragment === '') return options;
  return options.filter((option) => option.toLowerCase().includes(fragment));
}

/**
 * Wires the predefined-options dropdown of a text property to its input and
 * builds the ▾ button (body-mounted, fixed — the same approach and classes as
 * the type combobox).
 *
 * The list opens both on the caret and on typing: rows narrow to options
 * containing the typed fragment — an input aid, never a restriction. Single
 * mode: clicking a row fills the input with the option. Multiple mode: rows
 * are checkboxes; the input holds the comma-joined selection (options order)
 * and stays hand-editable. The result is committed once, when the dropdown
 * closes; Escape reverts to the last committed value instead. Keyboard-only
 * edits (list never opened) commit on the input's blur as usual.
 *
 * Also reused by the selection panel's property-values dialog: there `commit`
 * writes the value into the dialog state instead of saving it immediately.
 *
 * {@link suppressOnEmpty} (the editor's single text properties only, wired
 * together with the recent-values suggestions): when the input is cleared
 * back to empty, the dropdown hides itself instead of reopening with the full
 * catalogue — the recent-values list owns the emptied field there. The caret
 * click still shows the whole catalogue.
 */
export function buildValueOptionsCaret(
  input: HTMLInputElement,
  options: string[],
  multiple: boolean,
  commit: (value: string) => void,
  revert: () => void,
  suppressOnEmpty = false,
): HTMLElement {
  let list: HTMLDivElement | null = null;

  const detach = (): void => {
    if (list === null) return;
    list.remove();
    list = null;
    window.removeEventListener('mousedown', onOutside, true);
  };

  const close = (mode: 'commit' | 'revert'): void => {
    if (list === null) return;
    detach();
    if (mode === 'revert') revert();
    else commit(input.value);
  };

  const onOutside = (event: MouseEvent): void => {
    if (
      list !== null &&
      event.target instanceof Node &&
      !list.contains(event.target) &&
      event.target !== input
    ) {
      close('commit');
    }
  };

  function renderRows(showAll: boolean): void {
    if (list === null) return;
    const fragment = showAll ? '' : autocompleteFragment(input.value, multiple);
    const visible = filterOptionsByFragment(options, fragment);
    const selected = new Set(multiple ? splitMultiValue(input.value) : []);
    list.replaceChildren();
    for (const option of visible) {
      const row = div('type-combo-item');
      if (multiple) {
        const check = el('input');
        check.type = 'checkbox';
        check.checked = selected.has(option);
        row.append(check);
      }
      row.append(el('span', 'type-combo-label', option));
      // Keep the focus (and selection highlight) in the input — no blur-commit
      // while the user works inside the dropdown.
      row.addEventListener('mousedown', (event) => event.preventDefault());
      row.addEventListener('click', () => {
        if (!multiple) {
          input.value = option;
          close('commit');
          return;
        }
        if (selected.has(option)) selected.delete(option);
        else selected.add(option);
        const check = row.querySelector('input');
        if (check !== null) check.checked = selected.has(option);
        input.value = options.filter((o) => selected.has(o)).join(', ');
      });
      list.append(row);
    }
    if (visible.length === 0) {
      list.append(el('p', 'muted type-combo-empty', 'Совпадений нет.'));
    }
    if (multiple) {
      const done = button('Готово', () => close('commit'), 'btn small');
      done.style.margin = '4px';
      list.append(done);
    }
  }

  const openList = (showAll: boolean): void => {
    if (list !== null) {
      renderRows(showAll);
      return;
    }
    list = div('type-combo-list');
    renderRows(showAll);
    document.body.append(list);
    positionBodyDropdown(list, input);
    window.addEventListener('mousedown', onOutside, true);
  };

  // Typing (re)opens the list with rows narrowed to the typed fragment; the
  // caret shows the full catalogue regardless of the current input value.
  // Clearing the field with `suppressOnEmpty` just hides the list (the
  // recent-values dropdown owns the emptied field); the pending empty value
  // still commits on blur as usual.
  input.addEventListener('input', () => {
    if (suppressOnEmpty && input.value === '') {
      detach();
      return;
    }
    openList(false);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && list !== null) {
      event.stopPropagation();
      close('revert');
    }
  });

  return button(
    '▾',
    () => {
      if (list !== null) close('commit');
      else openList(true);
    },
    'btn small',
    multiple ? 'Выбрать несколько значений' : 'Выбрать значение из списка',
  );
}
