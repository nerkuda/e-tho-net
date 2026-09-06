/**
 * Network property catalogue management (task d4e23670, element
 * «Менеджер свойств сети»).
 *
 * Opened from the toolbar «Мыслесеть» menu as «Свойства» — a FLAT list
 * (registry rows are not hierarchical like the type catalogues): every row
 * is one network property, rendered as «name · value type · description ·
 * types count»; alphabetical order; a name/description search box filters
 * the visible rows. «Добавить» opens the editor for a new property, click
 * on a row opens the editor for the existing one, «✕» removes the row.
 *
 * The editor mirrors the type-editor property dialog (`openPropertyDialog`
 * inside `type-manager.ts`) — same fields, same UX — but operates on the
 * network-wide registry, not on a `type_properties` binding, so:
 *   * no «обязательное» checkbox (the binding decides required-ness);
 *   * a banner explains that the patch «действует во всех типах сразу» and
 *     shows how many types are bound (a fresh `usage` fetch every open);
 *   * changing `value_type` raises a separate confirmation that points to
 *     the server-side value conversion, plus a notice while it runs.
 *
 * Deletion is the trickiest path: the registry row stays put while any type
 * attaches it or any value references it (server returns 409 DUPLICATE with
 * `types_count` / `values_count` counters in `details`). The editor shows
 * those numbers and a hint about the cleanup order; the delete button stays
 * enabled only when both counters are zero.
 *
 * Realtime: `property-registry.created`/`updated`/`deleted` reload the list
 * in place (no dialog re-open); the editor itself, if open, refreshes its
 * cached `current` snapshot to keep the version optimistic-lock intact.
 */

import type {
  AnyRealtimeEvent,
  NetworkProperty,
  NetworkPropertyInput,
  NetworkPropertyUpdateInput,
  PropertyConfig,
  PropertyValueType,
} from '@etn/shared';

import { requireNetworkId } from '../app.js';
import {
  confirmDialog,
  errorDialog,
  showDialog,
} from '../lib/dialog.js';
import { button, div, el, errText, setTooltip, span } from '../lib/dom.js';
import { buildMetadataRows, type MetadataFields } from '../lib/metadata.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { createTypeCheckPicker } from '../lib/type-check-picker.js';
import { thoughtTypeOptions } from '../lib/type-tree.js';
import { store } from '../state.js';
import {
  showLinkTypeEditor,
  showThoughtTypeEditor,
} from './type-manager.js';

/** Human-readable property value-type labels. */
const VALUE_TYPE_LABELS: Record<PropertyValueType, string> = {
  text: 'строка',
  number: 'число',
  date: 'дата',
  bool: 'булево',
  thought_ref: 'ссылка на мысль',
  url: 'URL (сайт или файл)',
};

/** A registry row as returned by `GET /networks/{nid}/properties` (with counters). */
export type RegistryRow = NetworkProperty & { types_count: number; values_count: number };

/** One row of the registry list after sorting + filtering. */
interface PropertyRow {
  property: RegistryRow;
  lowerName: string;
  lowerDescription: string;
}

/**
 * Pure helpers (exported for tests). The list is always alphabetised; the
 * filter keeps the rows whose name OR description contains every whitespace-
 * separated fragment of `query`, ignoring case.
 */
export function sortRegistryRows(rows: RegistryRow[]): RegistryRow[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export function annotateRows(rows: RegistryRow[]): PropertyRow[] {
  return rows.map((property) => ({
    property,
    lowerName: property.name.toLowerCase(),
    lowerDescription: (property.description ?? '').toLowerCase(),
  }));
}

/**
 * Filter the registry list against the search box. Matches every whitespace-
 * separated fragment (case-insensitive) against the property name OR
 * description — same shape as `etn.thoughts.query`'s keyword mini-syntax.
 * Empty query keeps every row.
 */
export function filterRegistryRows(
  annotated: PropertyRow[],
  query: string,
): PropertyRow[] {
  const fragments = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((s) => s.length > 0);
  if (fragments.length === 0) return annotated;
  return annotated.filter((row) => {
    const haystack = `${row.lowerName}\n${row.lowerDescription}`;
    return fragments.every((f) => haystack.includes(f));
  });
}

/** Opens the property-manager dialog. Wired from the «Мыслесеть» menu. */
export function showPropertyManagerDialog(): void {
  const networkId = requireNetworkId();
  const errorLine = span('', 'error-text');
  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '340px';
  const body = div('form-stack');

  const toolbar = div('form-row type-list-toolbar');
  const searchInput = el('input', 'text-input') as HTMLInputElement;
  searchInput.type = 'text';
  searchInput.placeholder = 'Поиск по имени или описанию…';
  toolbar.append(
    button('Добавить', () => openPropertyManagerEditor(null, onChanged), 'btn small', 'Создать свойство'),
    searchInput,
  );
  body.append(toolbar, tableWrap, errorLine);

  let searchQuery = '';
  // Last loaded registry snapshot — search/edit/delete re-render from this
  // cache, so a keystroke does not flicker or jump the scroll position.
  let cachedRows: RegistryRow[] | null = null;

  const onChanged = (): void => void reload();

  async function reload(useCache = false): Promise<void> {
    const scrollTop = tableWrap.scrollTop;
    let rows: RegistryRow[];
    if (useCache && cachedRows !== null) {
      rows = cachedRows;
    } else {
      tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
      try {
        rows = await etn.propertyRegistry.list(networkId);
      } catch (err) {
        tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
        return;
      }
      cachedRows = rows;
    }
    const annotated = annotateRows(sortRegistryRows(rows));
    const visible = filterRegistryRows(annotated, searchQuery);
    const searching = searchQuery.trim() !== '';
    const table = el('table', 'table-list');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th', undefined, 'Имя'),
      el('th', undefined, 'Тип значения'),
      el('th', undefined, 'Описание'),
      el('th', undefined, 'Подключено к типам'),
      el('th'),
    );
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    if (visible.length === 0) {
      const emptyRow = el('tr');
      const emptyCell = el('td', 'muted', searching ? 'Ничего не найдено.' : 'Нет свойств.');
      emptyCell.colSpan = 5;
      emptyRow.append(emptyCell);
      tbody.append(emptyRow);
    }
    for (const row of visible) {
      const property = row.property;
      const tr = el('tr');
      const nameCell = el('td', undefined, property.name);
      nameCell.style.whiteSpace = 'nowrap';
      const typeCell = el('td', 'muted', VALUE_TYPE_LABELS[property.value_type]);
      const descCell = el('td', 'muted', (property.description ?? '').slice(0, 160));
      descCell.style.maxWidth = '280px';
      descCell.style.overflow = 'hidden';
      descCell.style.textOverflow = 'ellipsis';
      descCell.style.whiteSpace = 'nowrap';
      if (property.description !== null) setTooltip(descCell, property.description);
      const countCell = el('td', 'muted', String(property.types_count));
      countCell.style.textAlign = 'right';
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      actions.append(button('✕', () => void removeRow(property), 'btn small', 'Удалить свойство'));
      tr.append(nameCell, typeCell, descCell, countCell, actions);
      // Clicks on the ✕ button must not open the editor.
      tr.addEventListener('click', (event) => {
        if (event.target instanceof HTMLElement && event.target.closest('button') !== null) return;
        openPropertyManagerEditor(property, onChanged);
      });
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
    tableWrap.scrollTop = scrollTop;
  }

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    void reload(true);
  });

  /** Deletes a property (refused with 409 while bound or filled). */
  async function removeRow(property: RegistryRow): Promise<void> {
    if (property.types_count > 0 || property.values_count > 0) {
      const parts: string[] = [];
      if (property.types_count > 0) {
        parts.push(`подключено к ${property.types_count} ${pluralType(property.types_count)}`);
      }
      if (property.values_count > 0) {
        parts.push(`заполнено ${property.values_count} ${pluralValue(property.values_count)}`);
      }
      errorDialog(
        'Удалить свойство',
        `Свойство «${property.name}» нельзя удалить: ${parts.join(', ')}. ` +
          'Сначала отключите его от всех типов и разберите значения в группе «Свойства вне типа».',
      );
      return;
    }
    const ok = await confirmDialog(
      'Удалить свойство',
      `Удалить свойство «${property.name}»? Это действие необратимо.`,
      true,
    );
    if (!ok) return;
    try {
      await etn.propertyRegistry.remove(networkId, property.id);
      cachedRows = null;
      onChanged();
    } catch (err) {
      errorDialog('Удалить свойство', err);
    }
  }

  showDialog({
    title: 'Свойства',
    body,
    width: 720,
    buttons: [{ label: 'Закрыть', primary: true }],
  });

  // Realtime: another client may create / update / delete a registry row
  // while this dialog is open. We re-fetch the snapshot and re-render in
  // place — never force the user to close the dialog to see fresh data. The
  // editor (when open on top) handles its own state via `onChanged`, which
  // drops the editor's local snapshot if the row disappeared.
  const unsubscribe = etn.realtime.onEvent((raw: unknown) => {
    if (!isPropertyRegistryEvent(raw)) return;
    if (raw.networkId !== networkId) return;
    cachedRows = null;
    void reload();
  });
  // The dialog stack fires `onClose` for every close path (Esc, ×, footer
  // button, backdrop) — drop the realtime listener there so a closed dialog
  // does not keep re-rendering itself.
  // showDialog does not expose onClose today, so hook into the dialog's
  // backdrop removal via the body element: when the body detaches from the
  // DOM (the dialog closed), the listener goes too.
  const observer = new MutationObserver(() => {
    if (!body.isConnected) {
      unsubscribe();
      observer.disconnect();
    }
  });
  if (body.parentElement !== null) {
    observer.observe(body.parentElement, { childList: true });
  }

  void reload();
}

/**
 * True when `raw` is a property-registry create/update/delete event (the
 * three flavours that invalidate the cached list). Other events pass through.
 */
function isPropertyRegistryEvent(raw: unknown): raw is AnyRealtimeEvent & { networkId: string } {
  if (typeof raw !== 'object' || raw === null) return false;
  const evt = raw as { type?: unknown; networkId?: unknown };
  return (
    typeof evt.networkId === 'string' &&
    (evt.type === 'property-registry.created' ||
      evt.type === 'property-registry.updated' ||
      evt.type === 'property-registry.deleted')
  );
}

/**
 * Opens the property editor for the manager dialog — the same form as the
 * per-type property dialog in `type-manager.ts`, minus the «обязательное»
 * checkbox (the binding decides required-ness) and plus a banner that calls
 * out the network-wide impact of the patch.
 *
 * `property === null` creates a new registry row; otherwise it edits an
 * existing one. The dialog stays inert until «Применить и закрыть»; «Отмена»
 * / Esc / × / backdrop click discard the whole draft (reverts to the cached
 * server snapshot). The registry has no optimistic-lock today — the server
 * serialises the conversion transaction internally.
 *
 * Exported so the type-editor's «✎» button (task
 * «Клиент: редактор типа подключает свойство из справочника») can reuse
 * this dialog instead of duplicating the form — the registry is the single
 * source of a property's nature, and a single dialog keeps it that way.
 *
 * `onCreated` (optional) fires after a NEW row was applied, with the created
 * registry row — the attach dialog of the type editor uses it to highlight
 * the fresh property in its pick list.
 */
export function openPropertyManagerEditor(
  property: RegistryRow | null,
  onChanged: () => void,
  onCreated?: (row: NetworkProperty) => void,
): void {
  const networkId = requireNetworkId();
  // Server snapshot: starts at the row passed in, refreshed after a successful
  // apply, kept on a failed apply so a retry re-diffs against the same state.
  let current: RegistryRow | null = property;
  const errorLine = span('', 'error-text');
  const body = div('form-stack');

  // Live duplicate-name check (case-insensitive, by `name_key`).
  const DUP_NAME_MSG = 'Свойство с таким именем уже есть.';
  let allProperties: RegistryRow[] = [];
  let applyBtn: HTMLButtonElement | null = null;

  // Staged fields (applied on «Применить и закрыть»).
  const draft = {
    name: property?.name ?? '',
    description: property?.description ?? '',
    value_type: (property?.value_type ?? 'text') as PropertyValueType,
    config: cloneConfig(property?.config ?? null),
  };

  // Text-only options list (a value hint, not a constraint).
  let choiceOn = draft.value_type === 'text' && (draft.config?.options?.length ?? 0) > 0;
  let optionsText = choiceOn ? (draft.config?.options ?? []).join('\n') : '';

  // Multiple values flag — shared by text / url / thought_ref (02-data-model
  // md §3.4–3.5): whichever of the three kinds the property has, the flag
  // survives a value-type switch and is rendered in every kind's block.
  let multipleOn = draft.config?.multiple === true;

  // thought_ref type filter (multi-select picker over the thought-types tree).
  let allowedTypeIds = new Set<string>(
    draft.value_type === 'thought_ref' ? (draft.config?.allowed_type_ids ?? []) : [],
  );

  // The default value (thought_ref has no default — types must bind it
  // themselves).
  let defaultValue: unknown = draft.value_type === 'thought_ref' ? null : (draft.config?.default_value ?? null);

  // ---- Header ------------------------------------------------------------
  const nameInput = el('input', 'text-input') as HTMLInputElement;
  nameInput.type = 'text';
  nameInput.value = draft.name;
  nameInput.maxLength = 200;
  nameInput.placeholder = 'Заголовок свойства (обязательно)';
  body.append(nameInput);

  // Value-type select — changing it asks for confirmation when it triggers a
  // stored-value conversion. The banner below also reflects the bound types.
  const typeSelect = el('select', 'select-input') as HTMLSelectElement;
  for (const [value, label] of Object.entries(VALUE_TYPE_LABELS)) {
    const option = el('option', undefined, label) as HTMLOptionElement;
    option.value = value;
    typeSelect.append(option);
  }
  typeSelect.value = draft.value_type;
  body.append(typeSelect);

  // Impact banner — explicit per spec: the patch «действует во всех типах
  // сразу». `current` may be null while creating; in that case the banner is
  // hidden (zero types bound is implicit).
  const impact = el('p', 'muted', '');
  impact.style.margin = '6px 0 0';
  body.append(impact);

  // Description textarea (same as in `type-manager.ts`).
  const descArea = el('textarea', 'textarea-input') as HTMLTextAreaElement;
  descArea.value = draft.description;
  descArea.rows = 3;
  descArea.placeholder = 'Описание свойства: что оно значит и в каком формате значение (подсказка в редакторе мысли и для AI-агентов)';
  body.append(descArea);

  // ---- Value-type-specific extras ---------------------------------------
  const defaultHost = div('form-row');
  const textExtrasHost = div('form-stack');
  const refFilterHost = div('form-stack');
  const urlExtrasHost = div('form-row');

  /**
   * Re-renders the value-type-specific blocks (default value, text options,
   * thought_ref filter, url multiple). Called on first mount and on every
   * `value_type` change (the in-progress default value does not carry over —
   * it lives only on the currently-rendered input).
   */
  function renderValueTypeExtras(): void {
    defaultHost.replaceChildren();
    textExtrasHost.replaceChildren();
    refFilterHost.replaceChildren();
    urlExtrasHost.replaceChildren();
    const vt = typeSelect.value as PropertyValueType;
    if (vt === 'thought_ref') {
      defaultHost.append(span('не задаётся', 'muted'));
    } else {
      defaultHost.append(defaultInputFor(vt, defaultValue, (v) => {
        defaultValue = v;
      }));
    }
    if (vt === 'text') renderTextExtras();
    if (vt === 'thought_ref') renderRefFilter();
    if (vt === 'url') renderUrlExtras();
  }

  function renderTextExtras(): void {
    textExtrasHost.replaceChildren();
    const choiceRow = el('label', 'checkbox-row') as HTMLLabelElement;
    const choiceCheck = el('input') as HTMLInputElement;
    choiceCheck.type = 'checkbox';
    choiceCheck.checked = choiceOn;
    choiceCheck.addEventListener('change', () => {
      choiceOn = choiceCheck.checked;
      renderTextExtras();
    });
    choiceRow.append(choiceCheck, span('выбирать из списка'));
    textExtrasHost.append(choiceRow);
    if (choiceOn) {
      const area = el('textarea', 'textarea-input') as HTMLTextAreaElement;
      area.value = optionsText;
      area.rows = 4;
      area.placeholder = 'Варианты значения — по одному в строке';
      area.addEventListener('input', () => {
        optionsText = area.value;
      });
      textExtrasHost.append(area);
    }
    const multiRow = el('label', 'checkbox-row') as HTMLLabelElement;
    const multiCheck = el('input') as HTMLInputElement;
    multiCheck.type = 'checkbox';
    multiCheck.checked = multipleOn;
    multiCheck.addEventListener('change', () => {
      multipleOn = multiCheck.checked;
    });
    multiRow.append(multiCheck, span('несколько значений (через запятую)'));
    textExtrasHost.append(multiRow);
  }

  function renderRefFilter(): void {
    refFilterHost.replaceChildren();
    const multiRow = el('label', 'checkbox-row') as HTMLLabelElement;
    const multiCheck = el('input') as HTMLInputElement;
    multiCheck.type = 'checkbox';
    multiCheck.checked = multipleOn;
    multiCheck.addEventListener('change', () => {
      multipleOn = multiCheck.checked;
    });
    multiRow.append(multiCheck, span('несколько значений'));
    refFilterHost.append(multiRow);
    const label = el('p', 'muted', 'Отбор по типам (пусто — любой тип)');
    label.style.margin = '6px 0 2px';
    refFilterHost.append(label);
    refFilterHost.append(
      createTypeCheckPicker({
        // The same visual shape as every other type list: tree order, icons,
        // colours and font styles (0.6.5 приёмка — «без иконок и иерархии»).
        options: () => thoughtTypeOptions(store.state.thoughtTypes),
        selected: allowedTypeIds,
        onChange: (next) => {
          allowedTypeIds = new Set(next);
        },
        placeholder: 'Поиск типа…',
        maxHeightPx: 200,
      }).root,
    );
  }

  function renderUrlExtras(): void {
    urlExtrasHost.replaceChildren();
    const multiRow = el('label', 'checkbox-row') as HTMLLabelElement;
    const multiCheck = el('input') as HTMLInputElement;
    multiCheck.type = 'checkbox';
    multiCheck.checked = multipleOn;
    multiCheck.addEventListener('change', () => {
      multipleOn = multiCheck.checked;
    });
    multiRow.append(multiCheck, span('несколько значений'));
    urlExtrasHost.append(multiRow);
  }

  body.append(defaultHost, textExtrasHost, refFilterHost, urlExtrasHost);
  renderValueTypeExtras();

  // Блок «Метаданные» — автор, даты, id сущности (задача 04cd9794). Только
  // при редактировании существующего свойства; для нового id ещё не присвоен
  // и блок был бы пустым.
  if (property !== null) {
    body.append(buildMetadataRowsFromProperty(property));
  }

  // Usage panel — only meaningful when editing an existing row (a brand-new
  // property has no bindings yet). The panel reloads after the type editor
  // closes so the counts stay honest if the user detaches the property.
  if (property !== null) {
    body.append(buildUsagePanel(networkId, property.id));
  }

  // ---- Impact banner refresh --------------------------------------------
  /** Refreshes the «N типов используют это свойство» banner. */
  async function refreshImpact(): Promise<void> {
    if (current === null) {
      impact.textContent = '';
      return;
    }
    try {
      const usage = await etn.propertyRegistry.usage(networkId, current.id);
      const n = usage.bindings.length;
      impact.textContent =
        `Это свойство подключено к ${n} ${pluralType(n)}. Правка действует во всех ` +
        'типах сразу; смена типа значения запускает серверную обработку значений.';
    } catch {
      impact.textContent = '';
    }
  }
  void refreshImpact();

  // Duplicate-name revalidation — live as the user types.
  function nameClash(name: string): RegistryRow | null {
    const key = name.trim().toLowerCase();
    if (key === '') return null;
    return (
      allProperties.find(
        (p) => p.id !== (current?.id ?? null) && p.name.trim().toLowerCase() === key,
      ) ?? null
    );
  }
  function revalidateName(): void {
    if (nameClash(nameInput.value) !== null) {
      errorLine.textContent = DUP_NAME_MSG;
      if (applyBtn !== null) applyBtn.disabled = true;
    } else {
      if (errorLine.textContent === DUP_NAME_MSG) errorLine.textContent = '';
      if (applyBtn !== null) applyBtn.disabled = false;
    }
  }
  // Fresh registry snapshot — the server re-checks on apply anyway.
  void etn.propertyRegistry
    .list(networkId)
    .then((rows) => {
      allProperties = rows;
      revalidateName();
    })
    .catch(() => {});
  nameInput.addEventListener('input', () => {
    draft.name = nameInput.value;
    revalidateName();
  });

  // Value-type change → if a stored row is being edited and the type moves,
  // surface the conversion warning and stash the change for the apply.
  // Kind-specific extras do NOT carry over: they belong to the old kind.
  typeSelect.addEventListener('change', () => {
    const prev = draft.value_type;
    draft.value_type = typeSelect.value as PropertyValueType;
    if (draft.value_type !== prev) {
      if (prev === 'text') {
        choiceOn = false;
        optionsText = '';
      }
      if (prev === 'thought_ref') allowedTypeIds = new Set();
      if (draft.value_type === 'thought_ref') defaultValue = null;
    }
    renderValueTypeExtras();
  });

  // ---- Apply -------------------------------------------------------------
  async function apply(close: () => void): Promise<void> {
    const name = nameInput.value.trim();
    if (name === '') {
      errorLine.textContent = 'Название свойства обязательно.';
      return;
    }
    if (nameClash(name) !== null) {
      errorLine.textContent = DUP_NAME_MSG;
      return;
    }
    const description = descArea.value.trim();
    const config = buildConfig(draft.value_type, defaultValue, {
      choiceOn,
      optionsText,
      multipleOn,
      allowedTypeIds,
    });

    try {
      if (current === null) {
        const input: NetworkPropertyInput = {
          name,
          value_type: draft.value_type,
          ...(description !== '' ? { description } : {}),
          ...(config !== null ? { config } : {}),
        };
        const created = await etn.propertyRegistry.create(networkId, input);
        // Bind the optimistic snapshot so a re-open sees the fresh row.
        current = {
          ...created,
          types_count: 0,
          values_count: 0,
        };
        onCreated?.(created);
      } else {
        const changes: NetworkPropertyUpdateInput = {};
        if (name !== current.name) changes.name = name;
        if (draft.value_type !== current.value_type) changes.value_type = draft.value_type;
        const newDescription = description === '' ? null : description;
        if (newDescription !== (current.description ?? null)) changes.description = newDescription;
        if (!sameConfig(config, current.config)) changes.config = config;
        if (Object.keys(changes).length === 0) {
          // Nothing to do — close silently.
          close();
          return;
        }
        // Value-type conversion confirmation (asks BEFORE the patch lands,
        // so a decline leaves the whole apply a no-op).
        if (changes.value_type !== undefined && changes.value_type !== current.value_type) {
          const ok = await confirmDialog(
            'Сменить тип значения',
            `Сменить тип значения свойства «${current.name}»? ` +
              'Значения во всех элементах будут преобразованы к новому типу; несовместимые — очищены.',
            true,
          );
          if (!ok) return;
          notice('Ждите: выполняется обработка значений…');
        }
        const result = await etn.propertyRegistry.update(
          networkId,
          current.id,
          changes,
        );
        current = {
          ...result.property,
          types_count: current.types_count,
          values_count: current.values_count,
        };
        if (changes.value_type !== undefined) {
          notice(
            result.dropped > 0 || result.converted > 0
              ? `Обработка выполнена: преобразовано ${result.converted}, удалено ${result.dropped}.`
              : 'Обработка выполнена.',
          );
        }
      }
      onChanged();
      close();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  showDialog({
    title: property === null ? 'Новое свойство' : `Свойство — «${property.name}»`,
    body,
    width: 520,
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Применить и закрыть',
        primary: true,
        keepOpen: true,
        onClick: (close) => void apply(close),
        ref: (btn) => {
          applyBtn = btn;
        },
      },
    ],
    onMount: () => nameInput.focus(),
  });
}

// ---------------------------------------------------------------------------
// Value-type-specific input helpers (mirror the type-manager property dialog)
// ---------------------------------------------------------------------------

/**
 * Builds a default-value input matching `valueType`; `read(value)` is called
 * once when the input commits (blur/change). `thought_ref` has no default —
 * the type binding decides the target.
 */
function defaultInputFor(
  valueType: PropertyValueType,
  current: unknown,
  read: (value: unknown) => void,
): HTMLElement {
  switch (valueType) {
    case 'text':
    case 'url': {
      const input = el('input', 'text-input') as HTMLInputElement;
      input.type = 'text';
      input.value = typeof current === 'string' ? current : '';
      input.placeholder = valueType === 'url' ? 'https://… или путь к файлу' : 'текст по умолчанию';
      input.addEventListener('change', () => read(input.value.trim() === '' ? null : input.value.trim()));
      return input;
    }
    case 'number': {
      const input = el('input', 'text-input') as HTMLInputElement;
      input.type = 'number';
      input.value = typeof current === 'number' ? String(current) : '';
      input.addEventListener('change', () => {
        read(input.value === '' ? null : Number(input.value));
      });
      return input;
    }
    case 'date': {
      const input = el('input', 'text-input') as HTMLInputElement;
      input.type = 'date';
      input.value = typeof current === 'string' ? current : '';
      input.addEventListener('change', () => read(input.value === '' ? null : input.value));
      return input;
    }
    case 'bool': {
      const input = el('input') as HTMLInputElement;
      input.type = 'checkbox';
      input.checked = current === true;
      input.addEventListener('change', () => read(input.checked));
      return input;
    }
    case 'thought_ref':
      return span('не задаётся', 'muted');
  }
}

/**
 * Builds the `PropertyConfig` JSON to send on create/update. Returns `null`
 * when there is nothing meaningful to store (no default, no options, no
 * multiple flag, no allowed types) so the server stores the column as JSON
 * `null` rather than `{}`.
 *
 * Multiple values are valid for text / url / thought_ref alike (02-data-model
 * md §3.4–3.5) — one flag covers all three kinds.
 */
function buildConfig(
  valueType: PropertyValueType,
  defaultValue: unknown,
  options: {
    choiceOn: boolean;
    optionsText: string;
    multipleOn: boolean;
    allowedTypeIds: Set<string>;
  },
): PropertyConfig | null {
  const config: PropertyConfig = {};
  if (valueType !== 'thought_ref' && defaultValue !== null && defaultValue !== undefined) {
    config.default_value = defaultValue as string | number | boolean;
  }
  if (valueType === 'text' && options.choiceOn) {
    const list = options.optionsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (list.length > 0) config.options = list;
  }
  if (valueType === 'thought_ref' && options.allowedTypeIds.size > 0) {
    config.allowed_type_ids = Array.from(options.allowedTypeIds);
  }
  if (options.multipleOn) {
    config.multiple = true;
  }
  return Object.keys(config).length > 0 ? config : null;
}

/**
 * True when the new config and the stored one carry the same payload. Key
 * ORDER is irrelevant (the migration and the server write JSON with different
 * key orders than the local builder) — object keys are sorted recursively.
 */
function sameConfig(a: PropertyConfig | null, b: PropertyConfig | null): boolean {
  return stableJson(a ?? null) === stableJson(b ?? null);
}

/** JSON.stringify with recursively sorted object keys (arrays keep order). */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Deep-clone a stored config (the server returns plain JSON). */
function cloneConfig(c: PropertyConfig | null): PropertyConfig | null {
  if (c === null) return null;
  return JSON.parse(JSON.stringify(c)) as PropertyConfig;
}

// ---------------------------------------------------------------------------
// Russian plural forms (registry rows + value counters in messages)
// ---------------------------------------------------------------------------

function pluralType(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'типу';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'типам';
  return 'типов';
}

function pluralValue(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'значение';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'значения';
  return 'значений';
}

// ---------------------------------------------------------------------------
// Usage panel — bindings + value counters (in-type vs out-of-type).
// Wires type rows back to the type editor (`showThoughtTypeEditor` /
// `showLinkTypeEditor`); closing those editors reloads the network state so
// the usage panel stays honest.
// ---------------------------------------------------------------------------

interface PropertyUsageRow {
  owner_type: 'thought_type' | 'link_type';
  owner_id: string;
  owner_name: string;
  required: boolean;
  values_in_type_count: number;
}

interface PropertyUsage {
  property_id: string;
  name: string;
  value_type: PropertyValueType;
  bindings: PropertyUsageRow[];
  values_in_type_count: number;
  values_outside_type_count: number;
}

/**
 * Builds a small usage panel under the editor — the bindings list with click
 * handlers that open the matching type editor, plus the two value counters
 * («в типе» / «вне типа»). Fetches fresh on mount; reloads on demand.
 */
function buildUsagePanel(networkId: string, propertyId: string): HTMLElement {
  const host = div('form-stack');
  const label = el('p', 'muted', 'Использование');
  label.style.margin = '12px 0 2px';
  host.append(label);

  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '180px';
  tableWrap.append(el('span', 'muted', 'Загрузка…'));
  host.append(tableWrap);

  const counts = span('', 'muted');
  counts.style.margin = '4px 0 0';
  host.append(counts);

  async function reload(): Promise<void> {
    try {
      const usage: PropertyUsage = await etn.propertyRegistry.usage(networkId, propertyId);
      renderUsage(usage);
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
    }
  }

  function renderUsage(usage: PropertyUsage): void {
    const table = el('table', 'table-list');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th', undefined, 'Тип'),
      el('th', undefined, 'Значений в типе'),
    );
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    if (usage.bindings.length === 0) {
      const emptyRow = el('tr');
      const emptyCell = el('td', 'muted', 'Свойство ни к чему не подключено.');
      emptyCell.colSpan = 2;
      emptyRow.append(emptyCell);
      tbody.append(emptyRow);
    }
    for (const b of usage.bindings) {
      const tr = el('tr');
      const nameCell = el('td');
      nameCell.style.whiteSpace = 'nowrap';
      const link = button(b.owner_name, () => openTypeEditorByUsage(b), 'btn small link-btn', 'Открыть тип');
      nameCell.append(link);
      const countCell = el('td', 'muted', String(b.values_in_type_count));
      countCell.style.textAlign = 'right';
      tr.append(nameCell, countCell);
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
    counts.textContent =
      `Всего значений в типе: ${usage.values_in_type_count}. ` +
      `Вне типа: ${usage.values_outside_type_count}.`;
  }

  function openTypeEditorByUsage(row: PropertyUsageRow): void {
    if (row.owner_type === 'thought_type') {
      const t = store.state.thoughtTypes.find((tt) => tt.id === row.owner_id);
      if (t !== undefined) {
        showThoughtTypeEditor(t, () => void reload());
      }
    } else {
      const t = store.state.linkTypes.find((lt) => lt.id === row.owner_id);
      if (t !== undefined) {
        showLinkTypeEditor(t, () => void reload());
      }
    }
  }

  void reload();
  return host;
}

// ---------------------------------------------------------------------------
// Метаданные (задача 04cd9794)
// ---------------------------------------------------------------------------

/** Преобразует NetworkProperty DTO в плоский набор полей для блока «Метаданные». */
function buildMetadataRowsFromProperty(property: RegistryRow): HTMLElement {
  const fields: MetadataFields = {
    id: property.id,
    createdAtMs: property.created_at_ms ?? property.created_at,
    createdBy: property.created_by ?? null,
    updatedAtMs: property.updated_at_ms ?? property.updated_at,
    updatedBy: property.updated_by ?? null,
  };
  return buildMetadataRows(fields);
}
