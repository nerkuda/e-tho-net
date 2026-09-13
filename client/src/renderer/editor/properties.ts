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
 *  - link (свойство-связь) — без редактора значения: ссылки создаются
 *    рёбрами на карте/вкладке «Связи», а не заполнением свойства
 *    (0.8.1, thought_ref упразднён миграцией 040).
 *
 * Values are written with `properties.set`, cleared with `properties.remove`;
 * realtime `property-value.*` events reload the table when the open entity is
 * the owner (a single module-level listener keeps closures bounded).
 *
 * Single text values also keep a client-local history of the 10 last saved
 * values per property (localStorage, `recent-values.ts`): focusing the empty
 * field — or clearing it back to empty — offers the history as a dropdown;
 * typing closes it so the field's regular behaviour takes over.
 * Multiple-value properties (`config.multiple`) keep no history.
 */

import type { EffectiveTypeProperty, PropertyValue } from '@etn/shared';

import { onRealtimeEvent } from '../realtime.js';
import { button, div, el, errText, positionBodyDropdown, setTooltip, span } from '../lib/dom.js';
import { confirmDialog } from '../lib/dialog.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { logUiEvent } from '../lib/ui-log.js';
import { requireNetworkId } from '../app.js';
import { store } from '../state.js';
import { registerMainSection, type EditorContext } from './editor.js';
import { loadRecentValues, recordRecentValue, wireRecentValues } from './recent-values.js';

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

    // Значение адресуется реестровым id свойства (`PropertyValue.property_id`
    // = `properties.id`), а НЕ id строки привязки (`type_properties.id`).
    // У легаси-привязок (созданных до реестра свойств 0.6.5) эти id разошлись,
    // поэтому сопоставление по `definition.id` теряло значения и поля на
    // клиенте выглядели пустыми, хотя на сервере хранились (баг 7d094c26).
    const valueByProp = new Map(values.map((v) => [v.property_id, v]));
    const table = el('table', 'table-list prop-table');
    // Headerless table (08-ui-spec.md §6.3.1): rows only.
    const tbody = el('tbody');
    for (const definition of definitions) {
      const value = valueByProp.get(definition.property_id);
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
   * the property name and value (chips for multiple url, plain text
   * otherwise) — visually identical to the main table,
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
          // single text properties (recent-values.ts).
          if (typeof value === 'string' && tracksRecentValues(definition)) {
            recordRecentValue(networkId, definition.property_id, value);
          }
        }
        return true;
      } catch (err) {
        // The cell is owned by a now-possibly-orphaned DOM: a slow save (the
        // rest client retries 5xx/network errors up to 3 times with backoff,
        // ~30s in the worst case) outlives the rebuild that opened the next
        // thought. Writing the error into `cell` makes it invisible. The
        // toast (`notice`) is anchored to the document and survives the
        // rebuild — it is the only reliable surface for a deferred failure.
        notice(
          `Не удалось сохранить «${definition.key}»: ${errText(err)}`,
          'error',
        );
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
        // Baseline tracks the last **successfully saved** value so picker
        // commits and plain blur commits never fire twice for the same value,
        // and a failed save rolls back instead of leaving the field in a
        // "looks saved but isn't" state (карточка 7d094c26: when the user
        // reopens the thought, `properties.get` returns the old value and
        // the unsaved edit silently disappears).
        let baseline: string | null = typeof stored === 'string' ? stored : null;
        const commitValue = async (value: string): Promise<void> => {
          const next = value === '' ? null : value;
          if (next === baseline) return;
          const prev = baseline;
          baseline = next;
          const ok = await save(next);
          if (!ok) {
            // Restore the baseline so the next blur retries the write
            // instead of treating the unsaved value as already committed.
            baseline = prev;
          }
        };
        input.addEventListener('blur', () => void commitValue(input.value));
        // Recent-values suggestions (recent-values.ts): focusing the empty
        // field — or clearing it back to empty — offers the 10 last saved
        // values of this property; typing closes the list so the regular
        // behaviour (the options dropdown, blur commit) takes over.
        const recent = tracksRecentValues(definition);
        if (recent) {
          wireRecentValues(input, {
            load: () =>
              loadRecentValues(networkId, definition.property_id).map((value) => ({
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
        // Baseline tracks the last **successfully saved** value (the text
        // field's approach, extended for the failure-rollback symmetry of
        // карточка 7d094c26): a plain blur — in particular on an ALREADY-EMPTY
        // field — must not fire a remove (error cefb4db0: an empty value is
        // a legitimate state, not a delete request, and the server's 404
        // must not flash in the cell).
        let baseline: number | null = typeof stored === 'number' ? stored : null;
        input.addEventListener('blur', () => {
          if (input.value === '') {
            if (baseline === null) return;
            const prev = baseline;
            baseline = null;
            void save(null).then((ok) => {
              if (!ok) baseline = prev;
            });
            return;
          }
          const next = Number(input.value);
          if (!Number.isFinite(next) || next === baseline) return;
          const prev = baseline;
          baseline = next;
          void save(next).then((ok) => {
            if (!ok) baseline = prev;
          });
        });
        cell.append(input);
        break;
      }
      case 'date': {
        const input = el('input', 'text-input prop-editor');
        input.type = 'date';
        input.value = typeof stored === 'string' ? stored.slice(0, 10) : '';
        // Baseline tracks the last **successfully saved** value (the text
        // field's approach, with the failure-rollback symmetry of карточка
        // 7d094c26): a plain blur — in particular on an ALREADY-EMPTY field —
        // must not fire a remove (error cefb4db0: an empty date is a
        // legitimate state, and blur on an unchanged value must not write it
        // again either).
        let baseline: string | null = typeof stored === 'string' ? stored.slice(0, 10) : null;
        input.addEventListener('blur', () => {
          const next = input.value === '' ? null : input.value;
          if (next === baseline) return;
          const prev = baseline;
          baseline = next;
          void save(next).then((ok) => {
            if (!ok) baseline = prev;
          });
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
    case 'url':
      return 'URL';
    case 'link':
      return 'связь';
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
 * (recent-values.ts): single `text` properties only — multiple-value
 * properties (`config.multiple`) and the other value types are out of scope.
 */
function tracksRecentValues(definition: EffectiveTypeProperty): boolean {
  if (definition.config?.multiple === true) return false;
  return definition.value_type === 'text';
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
 * {@link opts.save}; an empty value list clears the property. URL/file-path
 * strings are stored verbatim — no parsing, no comma-join (02-data-model.md §3.5).
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
      // the user emptied it. The save is awaited so a failure surfaces via
      // the toast (save's wrapper) before the user clicks away — карточка
      // 7d094c26: a fire-and-forget here let the save outlive the next
      // thought's rebuild and silently drop the edit on reopen.
      input.addEventListener('blur', async () => {
        const trimmed = input.value.trim();
        current[index] = trimmed;
        collapseTrailingEmpty();
        const payload = current.filter((u) => u !== '');
        renderRows();
        try {
          await opts.save(payload);
        } catch {
          // `opts.save` is the editor's save wrapper, which already toasts
          // on failure and returns false. The catch here is a defensive
          // guard for custom callers (selection-panel dialog) that might
          // re-throw — never let an unhandled rejection escape a blur.
        }
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
// типа сохраняются»; thought_ref-рендеры удалены вместе с видом значения)
// ---------------------------------------------------------------------------

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
