/**
 * Network property catalogue management (task d4e23670, fd4d4927, element
 * «Менеджер свойств сети»).
 *
 * Two entry points share the same underlying registry (`properties` +
 * `link_types`) and the same editor (`openPropertyManagerEditor`):
 *
 * - `showPropertyManagerDialog` («Свойства и связи», бывший «Свойства») — a
 *   FLAT list mixing scalar properties and link-properties in a single
 *   alphabetical table (registry rows are not hierarchical like the type
 *   catalogues). Scalar rows show «имя · вид значения · описание · сколько
 *   типов подключено». Link rows show «имя в источнике / имя в назначении ·
 *   описание» and the per-side type counters from the server
 *   (`types_source_count` / `types_target_count`); structural «Родители» /
 *   «Потомки» are listed with a lock glyph and no «✕».
 *
 * - `showLinkTypesTreeDialog` («Типы связей», 0.8.1) — the same property
 *   editor reached through a tree of `link_types`: each row renders the
 *   link-type names and the effective line visual (colour/style/width
 *   inherited along the parent chain, L21). Clicking a row opens the editor
 *   for the underlying link-property (`config.link_type_id`), not the old
 *   link-type editor — that one is gone from user flows
 *   (требование 09f692ff / `465495a9`). Adding a link-type is creating a new
 *   link-property; structural types are visible but not editable.
 *
 * The editor itself mirrors the type-editor property dialog
 * (`openPropertyDialog` inside `type-manager.ts`) — same fields, same UX —
 * but operates on the network-wide registry, not on a `type_properties`
 * binding, so:
 *   * no «обязательное» checkbox (the binding decides required-ness);
 *   * a banner explains that the patch «действует во всех типах сразу» and
 *     shows how many types are bound (a fresh `usage` fetch every open);
 *   * changing `value_type` raises a separate confirmation that points to
 *     the server-side value conversion, plus a notice while it runs;
 *   * for a link-property deletion the confirm dialog quotes the number of
 *     edges that lose `type_id` (from `links_becoming_structural` in the
 *     DELETE response, требование 09f692ff).
 *
 * Deletion paths:
 *   * scalar property — refused with 409 while bound or filled; the editor
 *     shows `types_count` / `values_count` and a hint about the cleanup
 *     order;
 *   * link-property — confirmed with the structural-edges count; on apply
 *     the property AND its link-type are removed together (0.8.1);
 *   * structural «Родители» / «Потомки» — never deletable from these
 *     dialogs (system-seeded, migration 039).
 *
 * Realtime: `property-registry.*` and `link-type.*` events refresh the
 * cached snapshot in place so two clients editing different rows stay in
 * sync without forcing a dialog re-open. The editor itself, if open, also
 * refreshes its cached `current` snapshot to keep the optimistic lock
 * intact.
 */

import type {
  AnyRealtimeEvent,
  EffectiveTypeProperty,
  LinkPropertyDirection,
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
  field,
  showDialog,
} from '../lib/dialog.js';
import { button, div, el, errText, setTooltip, span } from '../lib/dom.js';
import { buildMetadataRows, type MetadataFields } from '../lib/metadata.js';
import { etn } from '../lib/etn.js';
import { acquireOrShowBlocked, lockHandleFromOutcome, releaseHeld, type LockHandle } from '../lib/lock-guard.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';
import { createTypeCombobox } from '../lib/type-combobox.js';
import {
  linkTypeOptions,
  thoughtTypeOptions,
  buildTypeTree,
  flattenTypeTree,
  resolveLinkTypeVisual,
  typeSearchVisibleIds,
  type FlatTypeRow,
} from '../lib/type-tree.js';
import type { LinkType } from '@etn/shared';
import { onRealtimeEvent } from '../realtime.js';
import { buildChipListField } from './thought-type/value-combo.js';
import { buildLinkValueEditor } from '../editor/properties.js';
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
  url: 'URL (сайт или файл)',
  link: 'связь',
  // Legacy (миграция 040): в живой БД таких свойств не остаётся, но в
  // типах маркер оставлен для компиляции тестов и импорта архивов.
  thought_ref: 'ссылка на мысль (legacy)',
};

/**
 * A registry row as returned by `GET /networks/{nid}/properties` (with counters).
 *
 * For link-properties (0.8.1, требование d7177d1d) the server also returns
 * `types_source_count` and `types_target_count` so the flat list can render
 * the per-side usage next to the link-type names. For non-link properties
 * those fields are absent.
 */
export type RegistryRow = NetworkProperty & {
  types_count: number;
  values_count: number;
  types_source_count?: number;
  types_target_count?: number;
};

/** One row of the registry list after sorting + filtering. */
interface PropertyRow {
  property: RegistryRow;
  lowerName: string;
  lowerDescription: string;
  /** For link-properties only: `name_forward\nname_reverse` of the
   *  underlying link-type, lowercased. Empty string for scalars so the
   *  filter's `every` short-circuits the same way as before. */
  lowerLinkNames: string;
}

/**
 * Pure helpers (exported for tests). The list is always alphabetised; the
 * filter keeps the rows whose name OR description contains every whitespace-
 * separated fragment of `query`, ignoring case.
 *
 * For link-properties (0.8.1, fd4d4927) the haystack also includes the
 * type-side names (`config.link_type_id` → `name_forward` / `name_reverse`
 * from the link-type catalogue) so a user can search «родитель» and find
 * the underlying property too.
 */
export function sortRegistryRows(rows: RegistryRow[]): RegistryRow[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export function annotateRows(rows: RegistryRow[]): PropertyRow[] {
  return rows.map((property) => {
    // Для свойства-связи ищем имена типа связи в каталоге linkTypes
    // (`store.state.linkTypes` — синхронный снимок realtime-канала, отдельной
    // инжекции не нужно; тесты предзаполняют стор).
    const ltId = property.config?.link_type_id;
    const lt =
      ltId !== undefined && ltId !== null && ltId !== ''
        ? store.state.linkTypes.find((t) => t.id === ltId)
        : null;
    const lowerLinkNames =
      lt !== null && lt !== undefined
        ? `${lt.name_forward}\n${lt.name_reverse}`.toLowerCase()
        : '';
    return {
      property,
      lowerName: property.name.toLowerCase(),
      lowerDescription: (property.description ?? '').toLowerCase(),
      lowerLinkNames,
    };
  });
}

/**
 * Filter the registry list against the search box. Matches every whitespace-
 * separated fragment (case-insensitive) against the property name OR
 * description OR link-type names — same shape as `etn.thoughts.query`'s
 * keyword mini-syntax. Empty query keeps every row.
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
    const haystack = `${row.lowerName}\n${row.lowerDescription}\n${row.lowerLinkNames}`;
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
    // Хелпер аннотирования читает имена типа связи из `store.state.linkTypes` —
    // синхронный доступ к стейту не конфликтует с realtime (каталог типов связей
    // обновляется через `link-type.*` события, на которые у этого диалога
    // подписка ниже).
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
      const isStructuralLink = property.value_type === 'link' && property.config?.structural === true;
      const isLink = property.value_type === 'link';
      // Строка свойства-связи: имя свойства, далее имена обеих сторон через
      // косую черту (как в диалоге «Типы связей»). Структурные «Родители» /
      // «Потомки» идут без `link_type_id` — показываем системную подпись.
      const ltId = property.config?.link_type_id;
      const lt =
        ltId !== undefined && ltId !== null && ltId !== ''
          ? store.state.linkTypes.find((t) => t.id === ltId) ?? null
          : null;
      const nameCell = el('td');
      nameCell.style.whiteSpace = 'nowrap';
      if (isLink && lt !== null) {
        // Превью линии под именем — эффективный цвет/стиль/ширина (L21).
        const resolved = resolveLinkTypeVisual(store.state.linkTypes, lt.id);
        const swatch = span('', 'link-type-swatch');
        swatch.style.borderTop = `${Math.max(1, Math.min(6, resolved.width ?? 2))}px ${
          resolved.style ?? 'solid'
        } ${resolved.color ?? '#9aa3b2'}`;
        swatch.style.display = 'inline-block';
        swatch.style.width = '32px';
        swatch.style.marginRight = '8px';
        swatch.style.verticalAlign = 'middle';
        nameCell.append(swatch);
        nameCell.append(
          span(property.name, 'prop-name'),
          span(`  (${lt.name_forward} / ${lt.name_reverse})`, 'muted'),
        );
        setTooltip(nameCell, 'Свойство-связь — клик откроет редактор свойства.');
      } else if (isStructuralLink) {
        nameCell.append(span(property.name, 'prop-name'), span('  🔒 (структурное)', 'muted'));
        setTooltip(
          nameCell,
          'Системное свойство-связь для нетипизированных рёбер «Родители/Потомки». Не редактируется и не удаляется из этого диалога.',
        );
      } else {
        nameCell.append(span(property.name));
      }
      const typeCell = el('td', 'muted', VALUE_TYPE_LABELS[property.value_type]);
      const descCell = el('td', 'muted', (property.description ?? '').slice(0, 160));
      descCell.style.maxWidth = '280px';
      descCell.style.overflow = 'hidden';
      descCell.style.textOverflow = 'ellipsis';
      descCell.style.whiteSpace = 'nowrap';
      if (property.description !== null) setTooltip(descCell, property.description);
      // Свойство-связь: показываем счётчики сторон («источник»/«назначение»).
      // Скаляр: единое число типов (как было).
      const countCell = el('td', 'muted');
      countCell.style.textAlign = 'right';
      countCell.style.whiteSpace = 'nowrap';
      if (isLink && !isStructuralLink) {
        const src = property.types_source_count ?? 0;
        const tgt = property.types_target_count ?? 0;
        countCell.append(
          span(`ист. ${src}`, 'prop-count-side'),
          span(' / ', 'muted'),
          span(`назн. ${tgt}`, 'prop-count-side'),
        );
        setTooltip(countCell, `Источник: ${src} ${pluralType(src)}. Назначение: ${tgt} ${pluralType(tgt)}.`);
      } else {
        countCell.append(String(property.types_count));
      }
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      // Структурные свойства-связи удалять нельзя (миграция 039).
      if (!isStructuralLink) {
        actions.append(button('✕', () => void removeRow(property), 'btn small', 'Удалить свойство'));
      }
      tr.append(nameCell, typeCell, descCell, countCell, actions);
      // Clicks on the ✕ button must not open the editor; structural rows stay
      // visible but inert — no editor opens on click.
      tr.addEventListener('click', (event) => {
        if (event.target instanceof HTMLElement && event.target.closest('button') !== null) return;
        if (isStructuralLink) return;
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

  /**
   * Удаление свойства из плоского списка (fd4d4927). Скалярные свойства
   * отвергаются сервером с 409 при `types_count > 0` или `values_count > 0`
   * — диалог ошибки подсказывает порядок. Свойство-связь требует
   * подтверждения с числом рёбер, которые потеряют `type_id`
   * (`links_becoming_structural`); сервер возвращает это поле вместе с 200
   * (требование 09f692ff), но значение известно заранее — для
   * не-удаляемого случая поможет текущий счётчик рёбер `link-type-counts`,
   * а для разрешённого — сервер сам кинет окончательное число.
   *
   * Здесь `links_becoming_structural` запрашивается на лету через
   * `link-type-counts` для контекста диалога; фактический счёт возвращает
   * DELETE-ответ и тосты «Структурных рёбер: N» после применения.
   */
  async function removeRow(property: RegistryRow): Promise<void> {
    const isLink = property.value_type === 'link';
    const isStructuralLink = isLink && property.config?.structural === true;
    if (isStructuralLink) {
      // защита — структурных строк в таблице нет «✕», но на всякий случай:
      return;
    }
    if (!isLink && (property.types_count > 0 || property.values_count > 0)) {
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
    // Предварительный счётчик рёбер для свойства-связи — число рёбер
    // соответствующего типа связи в сети. Это оценка «сколько рёбер
    // потенциально потеряют type_id»; точное число приходит в
    // `links_becoming_structural` ответа DELETE и пере-озвучивается тостом.
    let linksBecoming = 0;
    let linkEstimateOk = false;
    if (isLink) {
      try {
        const counts = await etn.types.getLinkTypeCounts(networkId);
        const ltId = property.config?.link_type_id;
        if (ltId !== undefined && ltId !== null && ltId !== '') {
          linksBecoming = counts[ltId] ?? 0;
          linkEstimateOk = true;
        }
      } catch {
        // оценка недоступна — диалог подтверждения просто опустит деталь.
      }
    }
    let prompt: string;
    if (isLink) {
      const lt = (() => {
        const ltId = property.config?.link_type_id;
        return ltId !== undefined && ltId !== null && ltId !== ''
          ? store.state.linkTypes.find((t) => t.id === ltId) ?? null
          : null;
      })();
      const names = lt !== null ? `«${lt.name_forward} / ${lt.name_reverse}»` : `«${property.name}»`;
      prompt =
        `Удалить свойство-связь ${names}? ` +
        (linkEstimateOk && linksBecoming > 0
          ? `${linksBecoming} ${pluralEdge(linksBecoming)} станут структурными ` +
            `«Родители/Потомки» и появятся в иерархии мыслей. `
          : '') +
        'Это действие необратимо.';
    } else {
      prompt = `Удалить свойство «${property.name}»? Это действие необратимо.`;
    }
    const ok = await confirmDialog('Удалить свойство', prompt, true);
    if (!ok) return;
    try {
      const result = await etn.propertyRegistry.remove(networkId, property.id);
      cachedRows = null;
      // Сервер возвращает точный счётчик ставших структурными рёбер (или null
      // для скаляров) — тостом подтверждаем выполнение.
      if (typeof result.links_becoming_structural === 'number') {
        const n = result.links_becoming_structural;
        if (n > 0) {
          notice(
            `Удалено. ${n} ${pluralEdge(n)} ${n === 1 ? 'стало' : 'стали'} структурными ` +
              '«Родители/Потомки».',
          );
        } else {
          notice('Свойство удалено.');
        }
      }
      onChanged();
    } catch (err) {
      errorDialog('Удалить свойство', err);
    }
  }

  showDialog({
    title: 'Свойства и связи',
    body,
    width: 720,
    buttons: [{ label: 'Закрыть', primary: true }],
  });

  // Realtime: `property-registry.*` инвалидирует кеш; `link-type.*` тоже —
  // имена сторон (`name_forward` / `name_reverse`) в строке свойства-связи
  // и предварительная оценка числа рёбер зависят от каталога типов связей.
  const unsubscribe = etn.realtime.onEvent((raw: unknown) => {
    if (!isPropertyRegistryOrLinkTypeEvent(raw)) return;
    if (raw.networkId !== networkId) return;
    cachedRows = null;
    void reload();
  });
  // Диалог закрыт — дропаем realtime-подписку иначе закрытый диалог будет
  // пере-рендериться. `showDialog` не отдаёт onClose; ловим отсоединение
  // `body` от DOM (mutation observer на родителе).
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
 * True when `raw` is an event that invalidates the cached property list:
 * `property-registry.*` (a row changed) or `link-type.*` (a link-type row
 * appeared/disappeared/renamed — the link-rows of the flat list show both
 * side names). Other events pass through.
 */
function isPropertyRegistryOrLinkTypeEvent(
  raw: unknown,
): raw is AnyRealtimeEvent & { networkId: string } {
  if (typeof raw !== 'object' || raw === null) return false;
  const evt = raw as { type?: unknown; networkId?: unknown };
  return (
    typeof evt.networkId === 'string' &&
    (evt.type === 'property-registry.created' ||
      evt.type === 'property-registry.updated' ||
      evt.type === 'property-registry.deleted' ||
      evt.type === 'link-type.created' ||
      evt.type === 'link-type.updated' ||
      evt.type === 'link-type.deleted')
  );
}

/**
 * True when `raw` is a link-type create/update/delete event — the three
 * flavours that invalidate the link-types tree cached in
 * `showLinkTypesTreeDialog`. Other events pass through.
 */
function isLinkTypeEvent(raw: unknown): raw is AnyRealtimeEvent & { networkId: string } {
  if (typeof raw !== 'object' || raw === null) return false;
  const evt = raw as { type?: unknown; networkId?: unknown };
  return (
    typeof evt.networkId === 'string' &&
    (evt.type === 'link-type.created' ||
      evt.type === 'link-type.updated' ||
      evt.type === 'link-type.deleted')
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
  // Auto-acquire the registry-row lock (task 4f141756). For a new property
  // there is no id yet, so we skip acquire (the editor stays usable; the
  // server gates the apply on the duplicate-name check instead).
  let editLock: LockHandle | null = null;
  if (property !== null) {
    void acquireOrShowBlocked('property', property.id).then((outcome) => {
      editLock = lockHandleFromOutcome('property', property.id, outcome);
    });
  }

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

  // Multiple values flag — shared by text / url (02-data-model.md §3.4–3.5):
  // whichever of the two kinds the property has, the flag survives a
  // value-type switch and is rendered in every kind's block.
  let multipleOn = draft.config?.multiple === true;

  // The default value. For a link property it is the default target set —
  // `string[]` of thought ids (bb67e546), applied on thought creation by
  // creating edges.
  let defaultValue: unknown = draft.config?.default_value ?? null;

  // Link-only state (value_type === 'link'). Structural marks the two
  // system-seeded properties «Родители»/«Потомки» (migration 039): their link
  // type/direction are fixed and not offered for editing here — only the
  // flags below and the description stay editable through this dialog. A
  // brand-new property (`property === null`) is never structural — there is
  // no UI path to create one.
  const isStructuralLink = draft.config?.structural === true;
  let linkTypeId: string | null = draft.config?.link_type_id ?? null;
  let linkDirection: LinkPropertyDirection = draft.config?.direction === 'in' ? 'in' : 'out';
  let allowedTargetTypeIds: string[] = [...(draft.config?.allowed_target_type_ids ?? [])];
  let showOnMap = draft.config?.show_on_map === true;
  let blocksTargetDeletion = draft.config?.blocks_target_deletion === true;

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
  const urlExtrasHost = div('form-row');
  const linkExtrasHost = div('form-stack');

  /**
   * Re-renders the value-type-specific blocks (default value, text options,
   * url multiple, link config). Called on first mount and on every
   * `value_type` change (the in-progress default value does not carry over —
   * it lives only on the currently-rendered input).
   */
  function renderValueTypeExtras(): void {
    defaultHost.replaceChildren();
    textExtrasHost.replaceChildren();
    urlExtrasHost.replaceChildren();
    linkExtrasHost.replaceChildren();
    const vt = typeSelect.value as PropertyValueType;
    // A link property's name is computed from the link type + direction
    // (server-enforced, `linkPropertyDisplayName`) — read-only here so the
    // computed name is visible before save instead of being silently ignored.
    nameInput.readOnly = vt === 'link' && !isStructuralLink;
    nameInput.placeholder = nameInput.readOnly
      ? 'выберите тип связи ниже'
      : 'Заголовок свойства (обязательно)';
    if (vt === 'link') {
      renderLinkExtras();
      // Дефолт свойства-связи — набор целей (bb67e546): унифицированное
      // чип-поле (инструкция a47947c8) — живой поиск, мини-облачка, пикер.
      // Фильтр целей собирается из текущего состояния черновика диалога.
      const ids = Array.isArray(defaultValue) ? (defaultValue as string[]) : [];
      const linkDefinition: EffectiveTypeProperty = {
        id: '',
        property_id: '',
        owner_type: 'thought_type',
        owner_id: '',
        key: 'default',
        value_type: 'link',
        config: {
          direction: linkDirection,
          ...(isStructuralLink ? { structural: true } : {}),
          ...(isStructuralLink || linkTypeId === null ? {} : { link_type_id: linkTypeId }),
          ...(allowedTargetTypeIds.length > 0 ? { allowed_target_type_ids: allowedTargetTypeIds } : {}),
        },
        required: false,
        position: 0,
        description: null,
        inherited: false,
        defined_on: '',
        defined_on_name: '',
        default_value: null,
        overridden_here: false,
        description_overridden: false,
      };
      const editor = buildLinkValueEditor({
        networkId,
        definition: linkDefinition,
        values: ids.map((target_id) => ({
          link_id: '',
          target_id,
          target_title: null,
          target_type_id: null,
          comment: null,
        })),
        save: async (next) => {
          defaultValue = next;
          return true;
        },
      });
      defaultHost.append(field('Значение по умолчанию (набор целей)', editor));
    } else {
      defaultHost.append(defaultInputFor(vt, defaultValue, (v) => {
        defaultValue = v;
      }));
    }
    if (vt === 'text') renderTextExtras();
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

  /**
   * Recomputes the read-only name shown in `nameInput` for a non-structural
   * link property from the selected link type + direction (mirrors the
   * server's `linkPropertyDisplayName`). A structural property keeps its
   * stored, user-editable name untouched — this is a no-op for it.
   */
  function updateComputedName(): void {
    if (isStructuralLink || typeSelect.value !== 'link') return;
    const lt = linkTypeId === null ? null : store.state.linkTypes.find((t) => t.id === linkTypeId) ?? null;
    nameInput.value = lt === null ? '' : linkDirection === 'in' ? lt.name_reverse : lt.name_forward;
    revalidateName();
  }

  /**
   * Renders the `value_type = 'link'` extras: link type, direction, optional
   * target-type restriction and the two link-only flags — the fields
   * `PropertyConfig` already carries (`shared/src/types/thought-type.ts`) but
   * this dialog never exposed (bug found while auditing тех.проект
   * «Единая модель связей»). The two system-seeded structural properties
   * («Родители»/«Потомки», migration 039) only show the flags — their link
   * type/direction are fixed and not offered here.
   */
  function renderLinkExtras(): void {
    linkExtrasHost.replaceChildren();
    if (isStructuralLink) {
      linkExtrasHost.append(
        el(
          'p',
          'muted',
          'Структурное свойство: тип связи и направление заданы системой (не редактируются здесь).',
        ),
      );
    } else {
      const combo = createTypeCombobox({
        options: () => linkTypeOptions(store.state.linkTypes),
        value: linkTypeId,
        placeholder: 'Тип связи (обязательно)',
        onChange: (id) => {
          linkTypeId = id;
          updateComputedName();
        },
      });
      linkExtrasHost.append(field('Тип связи', combo.root));

      const dirSelect = el('select', 'select-input') as HTMLSelectElement;
      const directionOptions: Array<[LinkPropertyDirection, string]> = [
        ['out', 'исходящее (эта мысль — источник ребра)'],
        ['in', 'входящее (эта мысль — цель ребра)'],
      ];
      for (const [value, label] of directionOptions) {
        const option = el('option', undefined, label) as HTMLOptionElement;
        option.value = value;
        dirSelect.append(option);
      }
      dirSelect.value = linkDirection;
      dirSelect.addEventListener('change', () => {
        linkDirection = dirSelect.value === 'in' ? 'in' : 'out';
        updateComputedName();
      });
      linkExtrasHost.append(field('Направление', dirSelect));
    }

    // Унифицированный чип-пикер типов мыслей (инструкция a47947c8 —
    // «Использовать унифицированные поля выбора ссылок в диалогах»):
    // живой поиск + чипы-мини-облачка + крестик, как в редакторе мысли
    // (buildChipListField из value-combo.ts — тот же компонент, что в
    // отборе типов мыслей и в полях «Родительские мысли» / «Типы мыслей»
    // / «Типы связей» filter-dialog.ts). Раньше тут был голый чек-лист без
    // поиска — нарушение паттерна.
    const targetOptions = thoughtTypeOptions(store.state.thoughtTypes).filter(
      (opt) => opt.id !== null,
    ) as Array<{ id: string; label: string; depth?: number }>;
    const labelById = new Map(targetOptions.map((opt) => [opt.id, opt.label]));
    const labelFor = (id: string): string => {
      const cached = labelById.get(id);
      if (cached !== undefined) return cached;
      const fresh = store.state.thoughtTypes.find((t) => t.id === id);
      return fresh !== undefined ? fresh.name : id.slice(0, 8);
    };
    const allowedField = buildChipListField({
      getValues: () => allowedTargetTypeIds,
      onChange: (next) => {
        allowedTargetTypeIds = next;
      },
      getOptions: (query) => {
        const q = query.trim().toLowerCase();
        const visible = q === '' ? targetOptions : targetOptions.filter((opt) => opt.label.toLowerCase().includes(q));
        return visible.slice(0, 50).map((opt) => ({
          value: opt.id,
          label: opt.label,
        }));
      },
      renderLabel: labelFor,
      placeholder: '+ допустимый тип мысли…',
    });
    const allowedHost = div('form-stack');
    allowedHost.append(allowedField.root);
    if (targetOptions.length === 0) {
      allowedHost.append(span('Нет типов мыслей.', 'muted'));
    }
    linkExtrasHost.append(field('Допустимые типы цели (пусто — любой)', allowedHost));

    const showOnMapRow = el('label', 'checkbox-row') as HTMLLabelElement;
    const showOnMapCheck = el('input') as HTMLInputElement;
    showOnMapCheck.type = 'checkbox';
    showOnMapCheck.checked = showOnMap;
    showOnMapCheck.addEventListener('change', () => {
      showOnMap = showOnMapCheck.checked;
    });
    showOnMapRow.append(showOnMapCheck, span('рисовать связь на карте по умолчанию'));
    linkExtrasHost.append(showOnMapRow);

    const blocksRow = el('label', 'checkbox-row') as HTMLLabelElement;
    const blocksCheck = el('input') as HTMLInputElement;
    blocksCheck.type = 'checkbox';
    blocksCheck.checked = blocksTargetDeletion;
    blocksCheck.addEventListener('change', () => {
      blocksTargetDeletion = blocksCheck.checked;
    });
    blocksRow.append(blocksCheck, span('заполненная ссылка блокирует удаление цели'));
    linkExtrasHost.append(blocksRow);

    updateComputedName();
  }

  body.append(defaultHost, textExtrasHost, urlExtrasHost, linkExtrasHost);
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
      if (draft.value_type === 'link') defaultValue = null;
    }
    renderValueTypeExtras();
  });

  // ---- Apply -------------------------------------------------------------
  async function apply(close: () => void): Promise<void> {
    if (draft.value_type === 'link' && !isStructuralLink && linkTypeId === null) {
      errorLine.textContent = 'Выберите тип связи.';
      return;
    }
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
    const config = buildConfig(
      draft.value_type,
      defaultValue,
      { choiceOn, optionsText, multipleOn },
      {
        structural: isStructuralLink,
        linkTypeId,
        direction: linkDirection,
        allowedTargetTypeIds,
        showOnMap,
        blocksTargetDeletion,
        // Carries over `config.multiple` left by the thought_ref→link
        // migration (040) — meaningless for a link property (the target
        // count is never capped) but preserved verbatim since this form has
        // no control for it, so an unrelated edit never drops it.
        legacyMultiple: draft.config?.multiple === true,
      },
    );

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
    onClose: () => void releaseHeld(editLock),
  });
}

// ---------------------------------------------------------------------------
// Value-type-specific input helpers (mirror the type-manager property dialog)
// ---------------------------------------------------------------------------

/**
 * Builds a default-value input matching `valueType`; `read(value)` is called
 * once when the input commits (blur/change). Link defaults (the target-set
 * chip field, bb67e546) are wired directly in `renderValueTypeExtras` — the
 * stub below is a defensive fallback, not the editing path.
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
    case 'link':
      return span('не задаётся', 'muted');
    case 'thought_ref':
      // Legacy (миграция 040): создание свойств этого типа отвергается
      // рантайм-guard'ом; редактор default-значения недостижим.
      return span('упразднено', 'muted');
  }
}

/** Link-config inputs gathered by {@link renderLinkExtras}, passed to
 *  {@link buildConfig} as a group so a `value_type = 'link'` edit never drops
 *  a field the form has no control for (see `legacyMultiple`).
 *  Exported for `buildConfig`'s unit tests. */
export interface LinkConfigDraft {
  structural: boolean;
  linkTypeId: string | null;
  direction: LinkPropertyDirection;
  allowedTargetTypeIds: string[];
  showOnMap: boolean;
  blocksTargetDeletion: boolean;
  legacyMultiple: boolean;
}

/**
 * Builds the `PropertyConfig` JSON to send on create/update.
 *
 * For `value_type = 'link'` the config always carries `direction`, plus
 * `structural`/`link_type_id` (mutually exclusive — see
 * `shared/src/types/thought-type.ts` `PropertyConfig`) and whichever of the
 * optional link flags the user set; it is never `null` (the server requires
 * `config.link_type_id` for a non-structural link property).
 *
 * For every other kind, returns `null` when there is nothing meaningful to
 * store (no default, no options, no multiple flag) so the server stores the
 * column as JSON `null` rather than `{}`. Multiple values are valid for
 * text / url alike (02-data-model.md §3.4–3.5) — one flag covers both kinds.
 *
 * Exported for unit tests (the dialog itself is rendered against the live
 * DOM) — the regression this covers: the pre-fix `buildConfig` had no
 * `value_type = 'link'` branch at all, so saving an existing link property
 * through this dialog silently dropped `config.link_type_id` and the server
 * rejected the patch with `VALIDATION_ERROR`.
 */
export function buildConfig(
  valueType: PropertyValueType,
  defaultValue: unknown,
  options: {
    choiceOn: boolean;
    optionsText: string;
    multipleOn: boolean;
  },
  link: LinkConfigDraft,
): PropertyConfig | null {
  if (valueType === 'link') {
    const config: PropertyConfig = { direction: link.direction };
    if (link.structural) {
      config.structural = true;
    } else if (link.linkTypeId !== null) {
      config.link_type_id = link.linkTypeId;
    }
    if (link.allowedTargetTypeIds.length > 0) {
      config.allowed_target_type_ids = [...link.allowedTargetTypeIds];
    }
    if (link.showOnMap) config.show_on_map = true;
    if (link.blocksTargetDeletion) config.blocks_target_deletion = true;
    if (link.legacyMultiple) config.multiple = true;
    // Дефолт свойства-связи — набор целей (bb67e546). Массив идёт как есть
    // (сервер дедуплицирует и валидирует цели); всё остальное — сброс.
    if (Array.isArray(defaultValue) && defaultValue.length > 0) {
      config.default_value = [...new Set(defaultValue)];
    }
    return config;
  }
  const config: PropertyConfig = {};
  if (defaultValue !== null && defaultValue !== undefined) {
    config.default_value = defaultValue as string | number | boolean;
  }
  if (valueType === 'text' && options.choiceOn) {
    const list = options.optionsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (list.length > 0) config.options = list;
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

/** Склонение «связь/связи/связей» для подтверждения удаления свойства-связи. */
function pluralEdge(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'связь';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'связи';
  return 'связей';
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

// ---------------------------------------------------------------------------
// Дерево «Типы связей» — второй вход в единый редактор (fd4d4927).
// ---------------------------------------------------------------------------

/**
 * True for the two system-seeded link-types («Родители» / «Потомки»,
 * migration 039). They live as property rows with `config.structural = true`,
 * not as `link_types` rows, so the link-type catalogue never carries them.
 * Listed in the flat property manager as system rows; the tree dialog just
 * shows whatever `etn.types.listLinkTypes` returns.
 */

/**
 * Открывает диалог «Типы связей» — иерархическое дерево типов связей сети
 * (задача fd4d4927, требование 0f9a53f4). Повторяет механику плоского
 * списка из {@link showPropertyManagerDialog}, но обзор идёт через типы
 * связей — единый редактор открывается из строки типа связи и правит
 * связанное свойство-связь (`config.link_type_id`):
 *
 *   * клик по строке → `openPropertyManagerEditor(property, ...)` для
 *     свойства, у которого `config.link_type_id === type.id`;
 *   * «Добавить» → новый свойство-связь (`value_type = 'link'`,
 *     `name_forward`/`name_reverse` заполняет пользователь в том же
 *     диалоге — требование 09f692ff);
 *   * поиск — по `name_forward` / `name_reverse` (как в старом дереве);
 *   * realtime: `link-type.*` инвалидирует кеш и пере-рендерит таблицу;
 *   * удаление типа связи идёт через удаление его свойства-связи (требование
 *     09f692ff) — в этом диалоге «✕» убран: пользовательский путь лежит
 *     через плоский список «Свойства и связи», где видно
 *     `links_becoming_structural`.
 */
export function showLinkTypesTreeDialog(): void {
  const networkId = requireNetworkId();
  const errorLine = span('', 'error-text');
  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '340px';
  const body = div('form-stack');

  const toolbar = div('form-row type-list-toolbar');
  const searchInput = el('input', 'text-input') as HTMLInputElement;
  searchInput.type = 'text';
  searchInput.placeholder = 'Поиск по имени…';
  toolbar.append(
    // «Добавить» создаёт свойство-связь. `value_type` пользователь выбирает
    // в форме; пары `name_forward`/`name_reverse` заполняет там же.
    button('Добавить', () => openPropertyManagerEditor(null, onChanged), 'btn small', 'Создать свойство-связь'),
    searchInput,
  );
  body.append(toolbar, tableWrap, errorLine);

  let expanded = new Set<string>();
  let searchQuery = '';
  let cachedTypes: LinkType[] | null = null;
  let cachedRows: RegistryRow[] | null = null;
  let cachedCounts: Record<string, number> | null = null;

  const onChanged = (): void => {
    cachedRows = null;
    cachedCounts = null;
    void reload();
  };

  async function reload(useCache = false): Promise<void> {
    const scrollTop = tableWrap.scrollTop;
    let types: LinkType[];
    let counts: Record<string, number>;
    let rows: RegistryRow[];
    if (useCache && cachedTypes !== null && cachedCounts !== null && cachedRows !== null) {
      types = cachedTypes;
      counts = cachedCounts;
      rows = cachedRows;
    } else {
      tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
      try {
        [types, rows] = await Promise.all([
          etn.types.listLinkTypes(networkId),
          etn.propertyRegistry.list(networkId),
        ]);
        try {
          counts = await etn.types.getLinkTypeCounts(networkId);
        } catch {
          counts = {};
        }
      } catch (err) {
        tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
        return;
      }
      cachedTypes = types;
      cachedRows = rows;
      cachedCounts = counts;
    }
    if (expanded.size === 0) {
      expanded = new Set(types.filter((t) => t.is_root).map((t) => t.id));
    }
    // Map: link_type_id → реестровое свойство (для клика по строке).
    const propertyByLinkTypeId = new Map<string, RegistryRow>();
    for (const row of rows) {
      if (row.value_type !== 'link') continue;
      const ltId = row.config?.link_type_id;
      if (ltId !== undefined && ltId !== null && ltId !== '') {
        propertyByLinkTypeId.set(ltId, row);
      }
    }
    const searching = searchQuery.trim() !== '';
    const keepIds = typeSearchVisibleIds(types, searchQuery);
    const rowsOut = (
      searching
        ? flattenTypeTree(buildTypeTree(types), new Set(types.map((t) => t.id)))
        : flattenTypeTree(buildTypeTree(types), expanded)
    ).filter((row) => keepIds.has(row.type.id));

    const table = el('table', 'table-list');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th', undefined, 'Имя (от источника к назначению / обратно)'),
      el('th', undefined, 'Подключено к типам'),
      el('th'),
    );
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    if (rowsOut.length === 0) {
      const emptyRow = el('tr');
      const emptyCell = el('td', 'muted', searching ? 'Ничего не найдено.' : 'Нет типов связей.');
      emptyCell.colSpan = 3;
      emptyRow.append(emptyCell);
      tbody.append(emptyRow);
    }
    for (const row of rowsOut) {
      const type = row.type;
      const tr = el('tr');
      if (type.is_root) tr.classList.add('type-tree-root');
      const nameCell = el('td');
      nameCell.style.whiteSpace = 'nowrap';
      const nameWrap = span('', 'type-tree-name');
      nameWrap.style.paddingLeft = `${Math.max(0, row.depth - 1) * 18}px`;
      nameWrap.append(treeToggle(row, expanded, () => void toggle(type.id), searching));
      const resolved = resolveLinkTypeVisual(types, type.id);
      const swatch = span('', 'link-type-swatch');
      swatch.style.borderTop = `${Math.max(1, Math.min(6, resolved.width ?? 2))}px ${
        resolved.style ?? 'solid'
      } ${resolved.color ?? '#9aa3b2'}`;
      swatch.style.display = 'inline-block';
      swatch.style.width = '32px';
      swatch.style.marginRight = '8px';
      swatch.style.verticalAlign = 'middle';
      nameWrap.append(swatch, span(` ${type.name_forward} / ${type.name_reverse}`));
      nameCell.append(nameWrap);
      // Колонка «Подключено к типам» — сумма обоих сторон свойства-связи
      // (если оно зарегистрировано). Нет свойства — 0; это «голый» тип связи,
      // создать рёбра через который нельзя (`etn.links.create` снят в 0.8.1).
      const prop = propertyByLinkTypeId.get(type.id);
      const totalAttached =
        prop !== undefined
          ? (prop.types_source_count ?? 0) + (prop.types_target_count ?? 0)
          : 0;
      const countCell = el('td', 'muted', String(totalAttached));
      countCell.style.textAlign = 'right';
      if (prop === undefined) {
        setTooltip(
          countCell,
          'Для этого типа связи ещё нет свойства в реестре. Тип связи без свойства бесполезен — создайте свойство через «Добавить».',
        );
      }
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      // Удаления в этом диалоге нет — пользовательский путь лежит через
      // плоский список «Свойства и связи», где видно
      // `links_becoming_structural` и подтверждение по числу рёбер
      // (требование 09f692ff).
      if (prop === undefined) {
        actions.append(
          span('нет свойства', 'muted prop-count-side'),
        );
      }
      tr.append(nameCell, countCell, actions);
      tr.addEventListener('click', (event) => {
        if (event.target instanceof HTMLElement && event.target.closest('button') !== null) return;
        if (prop !== undefined) {
          openPropertyManagerEditor(prop, onChanged);
        }
      });
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
    tableWrap.scrollTop = scrollTop;
  }

  function toggle(typeId: string): void {
    if (expanded.has(typeId)) expanded.delete(typeId);
    else expanded.add(typeId);
    void reload(true);
  }

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    void reload(true);
  });

  showDialog({
    title: 'Типы связей',
    body,
    width: 640,
    buttons: [{ label: 'Закрыть', primary: true }],
  });

  // Realtime: `link-type.*` инвалидирует кеш; `property-registry.*` тоже —
  // клик открывает свойство, и его название/тип значения должны быть
  // актуальны в момент клика.
  const unsubscribe = onRealtimeEvent((raw: unknown) => {
    if (!isPropertyRegistryOrLinkTypeEvent(raw)) return;
    if (raw.networkId !== networkId) return;
    cachedTypes = null;
    cachedRows = null;
    cachedCounts = null;
    void reload();
  });
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

/** ▸/▾ expander (скопированная логика из type-manager.ts, локально — чтобы не тащить экспорт). */
function treeToggle(
  row: FlatTypeRow<LinkType>,
  expanded: ReadonlySet<string>,
  onToggle: () => void,
  forceOpen = false,
): HTMLElement {
  const btn = button('', onToggle, 'btn small type-tree-toggle', row.hasChildren ? 'Развернуть/свернуть' : '');
  btn.textContent = row.hasChildren ? (forceOpen || expanded.has(row.type.id) ? '▾' : '▸') : '';
  btn.disabled = !row.hasChildren || forceOpen;
  return btn;
}
