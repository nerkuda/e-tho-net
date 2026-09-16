/**
 * Network property catalogue management (task d4e23670, fd4d4927, 09201bd4,
 * element «Менеджер свойств сети»).
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
 * The editor itself is the unified dialog `openPropertyManagerEditor`
 * (task 09201bd4, спека `465495a9`): ширина ≥1200 px, верх — выбор вида
 * значения (текст/число/дата/булево/URL/связь; `thought_ref` убран из списка
 * согласно требованию 5a82c709), описание, переключатели «рисовать связь на
 * карте»/«заполненная ссылка блокирует удаление», затем по виду значения —
 * скалярное (имя + таблица «Типы мыслей» + переключатель «Выбирать из
 * списка» + варианты + «Несколько значений») либо связь (две колонки «имя
 * в источнике»/«имя в назначении» + таблицы «Типы источников»/«Типы
 * назначений» + родительский тип связи + кнопка «Оформление»). Сохранение —
 * только «Применить и закрыть»; авто-лок строки реестра. Сворачиваемая
 * группа «Метаданные» свёрнута по умолчанию. Удаление свойства вида «связь»
 * — с подтверждением по правилу единого жизненного цикла
 * (`links_becoming_structural`).
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
  LinkType,
  LinkStyle,
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
import { showLinkStyleDialog } from '../editor/style-dialog.js';
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
  expandTypeIdsToSubtree,
} from '../lib/type-tree.js';
import { onRealtimeEvent } from '../realtime.js';
import { buildChipListField } from './thought-type/value-combo.js';
import { pickedThoughtIds, pickThoughtsDialog } from '../canvas/add-dialog.js';
import { openThoughtTypesPicker } from '../lib/type-picker.js';

/** Human-readable property value-type labels. Вид `thought_ref` упразднён в
 *  0.8.1 (требование 5a82c709) и недоступен в выборе — оставлен только в
 *  типах для компиляции тестов и импорта архивов. */
const VALUE_TYPE_LABELS: Record<Exclude<PropertyValueType, 'thought_ref'> | 'thought_ref', string> = {
  text: 'строка',
  number: 'число',
  date: 'дата',
  bool: 'да/нет',
  url: 'URL (сайт или файл)',
  link: 'связь',
  thought_ref: 'ссылка на мысль (legacy, недоступно)',
};

/** Виды значения, доступные пользователю в выборе — `thought_ref` скрыт. */
const SELECTABLE_VALUE_TYPES: PropertyValueType[] = [
  'text',
  'number',
  'date',
  'bool',
  'url',
  'link',
];

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
    /** Имя сторон ссылки (`forward / reverse`) в строке списка — заполняется
     *  при первом рендере из `store.state.linkTypes` или после догрузки
     *  `etn.types.getLinkType`. Хранится отдельно, чтобы догрузка могла
     *  обновить только эту ячейку без полного перерендера. */
    interface PendingLinkType {
      ltId: string;
      nameSpan: HTMLElement;
      tr: HTMLElement;
    }
    const pendingLinkTypes: PendingLinkType[] = [];

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
      } else if (isLink && ltId !== undefined && ltId !== '' && lt === null) {
        // link_type ещё не пришёл из realtime — рендерим заглушку и помечаем
        // строку как «pending»: после догрузки ниже заменим содержимое ячейки.
        nameCell.append(span(property.name, 'prop-name'));
        const pendingSpan = span('  (загрузка…)', 'muted');
        nameCell.append(pendingSpan);
        pendingLinkTypes.push({ ltId, nameSpan: pendingSpan, tr });
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
    // Догружаем имена сторон для свойств-ссылок, чей link_type ещё не
    // подтянулся realtime-ом. Без этого строка показывает только
    // `property.name`, а пользователь видит «Мишени» вместо
    // «Мишени (мишени / стрелки)».
    for (const pending of pendingLinkTypes) {
      void fetchLinkTypeForRow(networkId, pending);
    }
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

// ---------------------------------------------------------------------------
// Опции точки входа единого диалога
// ---------------------------------------------------------------------------

/** Сторона привязки для предзаполнения таблицы при открытии из вкладки
 *  «Свойства» редактора типа мысли (задача 935ec90e — следующая). Сейчас
 *  опция зарезервирована, реализация вкладки её подключит. */
export interface OpenEditorOptions {
  /** При открытии из редактора типа мысли — id типа, который должен быть
   *  предзаполнен в таблице «Типы мыслей» (для скаляра) или «Типы источников»/
   *  «Типы назначений» (для связи). */
  initialThoughtTypeId?: string;
  /** С какой стороны открыт редактор (`source` или `target`) — определяет,
   *  в какую из двух таблиц попадает `initialThoughtTypeId`. */
  initialSide?: 'source' | 'target';
}

// ---------------------------------------------------------------------------
// Состояние черновика диалога
// ---------------------------------------------------------------------------

/** Категория вида значения — обобщение, нужное для запрета смены категории
 *  при правке существующего свойства (требование 5a82c709): скаляры между
 *  собой конвертируются (text↔number↔date↔bool↔url), а скаляр ↔ «связь» —
 *  всегда 422 на сервере и невозможно в UI. */
type ValueCategory = 'scalar' | 'link';

function categoryOf(valueType: PropertyValueType): ValueCategory {
  return valueType === 'link' ? 'link' : 'scalar';
}

/** Строка таблицы «Типы мыслей» (и зеркальных «Типы источников» / «Типов
 *  назначений»). Для скаляров и связи единая форма — одинаковый набор
 *  колонок (тип · обязательное · значение по умолчанию). */
interface TypeRowDraft {
  /** Id привязки (`type_properties.id`). `null` для ещё не сохранённой
   *  строки — она появится только после `apply` и POST на сервер. */
  id: string | null;
  thoughtTypeId: string;
  required: boolean;
  defaultValue: unknown;
  /** Сторона привязки для свойства-связи (`source`/`target`) — для скаляра
   *  всегда `null`. Сохраняется в `type_properties.side`. */
  side: 'source' | 'target' | null;
  /** Снимок текущего состояния на сервере — для отслеживания изменений
   *  при `apply`. */
  dirty: boolean;
}

/** Единый черновик единого диалога (задача 09201bd4, спека 465495a9). */
interface PropertyDraft {
  name: string;
  description: string;
  valueType: PropertyValueType;
  /** Скалярное: имя свойства. Для связи — вычисляется из имён сторон и
   *  сервер при PATCH отдаёт его обратно; локально можно править, но смысла
   *  мало (см. замечание ниже в `renderScalarExtras`). */
  config: PropertyConfig | null;
  /** Виды значения, доступные в выборе. Для скаляра — все 5 скалярных видов.
   *  Для связи — `['link']` (фиксировано). Категория фиксируется после
   *  первой записи, поэтому существующее свойство не может выбрать из
   *  другой категории. */
  scalarKind: Exclude<PropertyValueType, 'link'> | null;
  choiceOn: boolean;
  optionsText: string;
  multipleOn: boolean;
  /** Для связи: имена сторон типа связи. */
  nameForward: string;
  nameReverse: string;
  parentLinkTypeId: string | null;
  linkColor: string | null;
  linkStyle: LinkStyle | null;
  linkWidth: number | null;
  showOnMap: boolean;
  blocksTargetDeletion: boolean;
  /** Значение по умолчанию для скаляра (`unknown`, см. типы `PropertyConfig.default_value`)
   *  и для свойства-связи (`string[] | null`). */
  defaultValue: unknown;
  /** Строки таблиц «Типы мыслей» / «Типы источников» / «Типы назначений». */
  typeRows: TypeRowDraft[];
}

/** Скопировать поля link_type в draft (вызывается и при восстановлении из
 *  store, и при догрузке через `etn.types.getLinkType`). */
function applyLinkTypeToDraft(lt: LinkType, draft: PropertyDraft): void {
  draft.nameForward = lt.name_forward;
  draft.nameReverse = lt.name_reverse;
  draft.parentLinkTypeId = lt.parent_id ?? null;
  draft.linkColor = lt.color ?? null;
  draft.linkStyle = (lt.style ?? null) as LinkStyle | null;
  draft.linkWidth = lt.width ?? null;
}

/** Кросс-фильтр типов для поля «Значение по умолчанию» свойства-связи:
 *  список `thoughtTypeId` из **противоположной** стороны таблицы привязок.
 *  Пустой массив означает «фильтр не задан» (противоположная таблица пуста —
 *  можно выбирать любые мысли). Раскрытие иерархии делает вызывающий код
 *  через `expandTypeIdsToSubtree(store.state.thoughtTypes, …)`. */
function collectOppositeSideTypeIds(
  rows: readonly TypeRowDraft[],
  side: 'source' | 'target' | null,
): string[] {
  const opposite: 'source' | 'target' | null =
    side === 'source' ? 'target' : side === 'target' ? 'source' : null;
  if (opposite === null) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    if (row.side !== opposite) continue;
    if (row.thoughtTypeId === '' || seen.has(row.thoughtTypeId)) continue;
    seen.add(row.thoughtTypeId);
    out.push(row.thoughtTypeId);
  }
  return out;
}

/**
 * Догрузить link_type по id и применить к draft. Вызывается, когда в
 * `store.state.linkTypes` нужной записи нет (realtime-канал отстаёт, либо
 * редактор открывают сразу после создания свойства-связи). При неудаче
 * оставляем пустые поля — это «голая» запись (миграция 042 оставляет такие),
 * пользователь увидит сигнал сам.
 */
async function loadLinkTypeIntoDraft(
  networkId: string,
  ltId: string,
  draft: PropertyDraft,
): Promise<void> {
  try {
    const lt = await etn.types.getLinkType(networkId, ltId);
    applyLinkTypeToDraft(lt, draft);
  } catch {
    /* догрузка не удалась — пустые поля остаются. */
  }
}

/** Поведение `etn.types.getLinkType` с локальным кешем в `store.linkTypes`.
 *  Используется из плоского списка, чтобы дотянуть имена сторон
 *  (`forward / reverse`) для свойств-ссылок, чей link_type ещё не пришёл
 *  realtime-ом. При успехе — дополняем каталог и обновляем заглушку в
 *  строке; при ошибке — оставляем «(загрузка…)». */
async function fetchLinkTypeForRow(
  networkId: string,
  pending: { ltId: string; nameSpan: HTMLElement; tr: HTMLElement },
): Promise<void> {
  try {
    const lt = await etn.types.getLinkType(networkId, pending.ltId);
    // Дополняем каталог — следующий перерендер уже возьмёт из store.
    const exists = store.state.linkTypes.some((t) => t.id === lt.id);
    if (!exists) store.state.linkTypes.push(lt);
    if (!pending.nameSpan.isConnected) return;
    pending.nameSpan.textContent = `  (${lt.name_forward} / ${lt.name_reverse})`;
  } catch {
    if (pending.nameSpan.isConnected) {
      pending.nameSpan.textContent = '  (нет данных)';
    }
  }
}

/** Идентификатор значения категории `value_type`. После первой записи
 *  категория зафиксирована (требование 5a82c709). */
function lockCategoryFor(existing: PropertyValueType | null): ValueCategory | null {
  return existing === null || existing === undefined ? null : categoryOf(existing);
}

// ---------------------------------------------------------------------------
// Утилиты компоновки
// ---------------------------------------------------------------------------

/** Сворачиваемая группа: `summary` кликабельный, `body` показывается по клику. */
function buildCollapsibleGroup(title: string, body: HTMLElement, defaultCollapsed: boolean): HTMLElement {
  const wrap = div('form-stack collapsible-group');
  const summary = el('summary', 'collapsible-summary');
  const arrow = span('▸', 'collapsible-arrow');
  summary.append(arrow, span(` ${title}`));
  wrap.append(summary, body);
  let collapsed = defaultCollapsed;
  function apply(): void {
    arrow.textContent = collapsed ? '▸' : '▾';
    body.style.display = collapsed ? 'none' : '';
  }
  apply();
  summary.addEventListener('click', () => {
    collapsed = !collapsed;
    apply();
  });
  summary.style.cursor = 'pointer';
  summary.style.userSelect = 'none';
  return wrap;
}

/** Разделитель секций в форме. */
function sectionLabel(text: string): HTMLElement {
  const h = el('h4', 'form-section-label', text);
  return h;
}

/** Горизонтальная пара колонок одинаковой ширины. */
function twoColumns(left: HTMLElement, right: HTMLElement): HTMLElement {
  const row = div('form-row two-col-row');
  const l = div('two-col-cell');
  const r = div('two-col-cell');
  l.append(left);
  r.append(right);
  row.append(l, r);
  row.style.display = 'grid';
  row.style.gridTemplateColumns = '1fr 1fr';
  row.style.gap = '16px';
  return row;
}

// ---------------------------------------------------------------------------
// Основной диалог
// ---------------------------------------------------------------------------

/**
 * Открывает единый диалог «Свойство / связь» (задача 09201bd4, спека
 * 465495a9). Ширина — 1240 px (≥1200). Сохранение — только по «Применить и
 * закрыть»; Esc / × / клик мимо — отмена. Авто-лок строки реестра
 * (`acquireOrShowBlocked('property', id)`).
 *
 * Для свойства-связи создание идёт через `POST /networks/{nid}/properties`
 * с `value_type='link'` + парой имён сторон + атрибутами оформления —
 * сервер (задача dd37a66) создаёт связанный link_type в той же транзакции.
 * Правка имён сторон правит тип связи (PATCH `/networks/{nid}/properties` с
 * `name_forward`/`name_reverse`).
 *
 * `options.initialThoughtTypeId` / `options.initialSide` — для предзаполнения
 * таблицы при открытии из вкладки «Свойства» редактора типа (задача
 * 935ec90e — следующая; текущий код резерв принимает, но фактический поток
 * подключится там).
 */
export function openPropertyManagerEditor(
  property: RegistryRow | null,
  onChanged: () => void,
  onCreated?: (row: NetworkProperty) => void,
  options: OpenEditorOptions = {},
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

  // Initial category — locked after the first write (требование 5a82c709).
  const lockedCategory: ValueCategory | null = lockCategoryFor(property?.value_type ?? null);

  // Staged fields (applied on «Применить и закрыть»).
  const draft: PropertyDraft = {
    name: property?.name ?? '',
    description: property?.description ?? '',
    valueType: (property?.value_type ?? 'text') as PropertyValueType,
    config: cloneConfig(property?.config ?? null),
    scalarKind: (property?.value_type ?? 'text') as Exclude<PropertyValueType, 'link'>,
    choiceOn: false,
    optionsText: '',
    multipleOn: false,
    nameForward: '',
    nameReverse: '',
    parentLinkTypeId: null,
    linkColor: null,
    linkStyle: null,
    linkWidth: null,
    showOnMap: false,
    blocksTargetDeletion: false,
    defaultValue: null,
    typeRows: [],
  };

  // Restore scalar / link extras from the stored config.
  if (draft.valueType === 'link') {
    const ltId = property?.config?.link_type_id;
    const ltInStore =
      ltId !== undefined && ltId !== null && ltId !== ''
        ? store.state.linkTypes.find((t) => t.id === ltId) ?? null
        : null;
    if (ltInStore !== null) {
      applyLinkTypeToDraft(ltInStore, draft);
    } else if (ltId !== undefined && ltId !== null && ltId !== '') {
      // Каталог типов связей ещё не подтянул эту запись (realtime-канал
      // отстаёт, либо свойство открывают сразу после создания). Догружаем
      // link_type по id и заполняем draft + форму; без этого «Имя в
      // источнике»/«Имя в назначении» остаются пустыми.
      void loadLinkTypeIntoDraft(networkId, ltId, draft);
    }
    draft.showOnMap = property?.config?.show_on_map === true;
    draft.blocksTargetDeletion = property?.config?.blocks_target_deletion === true;
    draft.defaultValue = Array.isArray(property?.config?.default_value)
      ? [...(property?.config?.default_value as string[])]
      : null;
  } else {
    draft.choiceOn = draft.valueType === 'text' && (draft.config?.options?.length ?? 0) > 0;
    draft.optionsText = draft.choiceOn ? (draft.config?.options ?? []).join('\n') : '';
    draft.multipleOn = draft.config?.multiple === true;
    draft.defaultValue = draft.config?.default_value ?? null;
  }

  // Заполнение typeRows из `usage()` + дефолты. Для нового свойства (id
  // ещё нет) — пусто; кнопка «Добавить тип» откроет унифицированный пикер.
  if (property !== null) {
    void loadTypeRowsFor(property.id);
  } else if (options.initialThoughtTypeId !== undefined && options.initialThoughtTypeId !== '') {
    draft.typeRows = [
      {
        id: null,
        thoughtTypeId: options.initialThoughtTypeId,
        required: false,
        defaultValue: null,
        side: options.initialSide ?? null,
        dirty: true,
      },
    ];
  }

  // ---- Вид значения (value_type) -----------------------------------------
  const typeSelect = el('select', 'select-input') as HTMLSelectElement;
  for (const vt of SELECTABLE_VALUE_TYPES) {
    const option = el('option', undefined, VALUE_TYPE_LABELS[vt]) as HTMLOptionElement;
    option.value = vt;
    typeSelect.append(option);
  }
  // Для нового свойства по умолчанию — «строка»; для существующего —
  // текущий `value_type`. Заблокировать выбор другой категории
  // (требование 5a82c709): для существующего свойства оставляем только
  // варианты той же категории.
  typeSelect.value = draft.valueType;
  const valueTypeField = field('Вид значения', typeSelect);
  body.append(valueTypeField);

  // Для уже существующего свойства — отключаем выбор другой категории.
  if (lockedCategory !== null) {
    const currentCategory = categoryOf(draft.valueType);
    for (const option of Array.from(typeSelect.options)) {
      const vt = option.value as PropertyValueType;
      if (categoryOf(vt) !== currentCategory) option.disabled = true;
    }
  }

  // ---- Описание ----------------------------------------------------------
  const descArea = el('textarea', 'textarea-input') as HTMLTextAreaElement;
  descArea.value = draft.description;
  descArea.rows = 3;
  descArea.placeholder =
    'Описание свойства: что оно значит и в каком формате значение (подсказка в редакторе мысли и для AI-агентов)';
  body.append(field('Описание', descArea));

  // ---- Хосты секций -----------------------------------------------------
  const linkFlagsHost = div('form-row');
  body.append(linkFlagsHost);
  const mainBodyHost = div('form-stack');
  body.append(mainBodyHost);
  const linkBodyHost = div('form-stack');
  body.append(linkBodyHost);
  const metadataHost = div('form-stack');
  // Метаданные + использование — в сворачиваемой группе, свёрнуты.
  const metaGroup = buildCollapsibleGroup('Метаданные', metadataHost, true);
  body.append(metaGroup);

  // ---- Эффект перерисовки формы при смене value_type --------------------
  function rerenderBody(): void {
    linkFlagsHost.replaceChildren();
    mainBodyHost.replaceChildren();
    linkBodyHost.replaceChildren();
    const vt = typeSelect.value as PropertyValueType;
    draft.valueType = vt;
    if (vt === 'link') {
      renderLinkFlags();
      renderLinkBody();
    } else {
      draft.scalarKind = vt as Exclude<PropertyValueType, 'link'>;
      renderScalarBody();
    }
  }

  function renderLinkFlags(): void {
    linkFlagsHost.append(sectionLabel('Связь'));
    const showOnMapRow = el('label', 'checkbox-row') as HTMLLabelElement;
    const showOnMapCheck = el('input') as HTMLInputElement;
    showOnMapCheck.type = 'checkbox';
    showOnMapCheck.checked = draft.showOnMap;
    showOnMapCheck.addEventListener('change', () => {
      draft.showOnMap = showOnMapCheck.checked;
    });
    showOnMapRow.append(showOnMapCheck, span('рисовать связь на карте по умолчанию'));
    linkFlagsHost.append(showOnMapRow);

    const blocksRow = el('label', 'checkbox-row') as HTMLLabelElement;
    const blocksCheck = el('input') as HTMLInputElement;
    blocksCheck.type = 'checkbox';
    blocksCheck.checked = draft.blocksTargetDeletion;
    blocksCheck.addEventListener('change', () => {
      draft.blocksTargetDeletion = blocksCheck.checked;
    });
    blocksRow.append(blocksCheck, span('заполненная ссылка блокирует удаление цели'));
    linkFlagsHost.append(blocksRow);
  }

  function renderScalarBody(): void {
    mainBodyHost.append(sectionLabel('Скалярное свойство'));
    // Имя свойства
    const nameInput = el('input', 'text-input') as HTMLInputElement;
    nameInput.type = 'text';
    nameInput.value = draft.name;
    nameInput.maxLength = 200;
    nameInput.placeholder = 'Заголовок свойства (обязательно)';
    nameInput.addEventListener('input', () => {
      draft.name = nameInput.value;
      revalidateName();
    });
    mainBodyHost.append(field('Имя свойства', nameInput));

    // Две колонки: таблица «Типы мыслей» слева, опции/множественность справа.
    const typesHost = div('form-stack');
    const optionsHost = div('form-stack');
    buildTypeRowsTable(typesHost, /* isLink */ false, /* side */ null);
    const optionsBlock = buildScalarOptionsBlock();
    optionsHost.append(optionsBlock);

    const defaultsHost = div('form-stack');
    defaultsHost.append(
      field('Значение по умолчанию', defaultInputFor(draft.scalarKind as PropertyValueType, draft.defaultValue, (v) => {
        draft.defaultValue = v;
      })),
    );

    const grid = twoColumns(typesHost, optionsHost);
    mainBodyHost.append(grid, defaultsHost);
  }

  function renderLinkBody(): void {
    linkBodyHost.append(sectionLabel('Свойство-связь'));
    // Имена сторон + таблицы + родительский тип + оформление.
    const nameForwardInput = el('input', 'text-input') as HTMLInputElement;
    nameForwardInput.type = 'text';
    nameForwardInput.value = draft.nameForward;
    nameForwardInput.maxLength = 200;
    nameForwardInput.placeholder = 'От источника к назначению';
    nameForwardInput.addEventListener('input', () => {
      draft.nameForward = nameForwardInput.value;
    });
    const nameReverseInput = el('input', 'text-input') as HTMLInputElement;
    nameReverseInput.type = 'text';
    nameReverseInput.value = draft.nameReverse;
    nameReverseInput.maxLength = 200;
    nameReverseInput.placeholder = 'От назначения к источнику';
    nameReverseInput.addEventListener('input', () => {
      draft.nameReverse = nameReverseInput.value;
    });
    // Свойство-связь: name в реестре — одно из имён (см. требование ниже).
    const leftCol = div('form-stack');
    leftCol.append(field('Имя в источнике', nameForwardInput));
    const leftTypesHost = div('form-stack');
    buildTypeRowsTable(leftTypesHost, /* isLink */ true, /* side */ 'source');
    leftCol.append(leftTypesHost);
    const rightCol = div('form-stack');
    rightCol.append(field('Имя в назначении', nameReverseInput));
    const rightTypesHost = div('form-stack');
    buildTypeRowsTable(rightTypesHost, /* isLink */ true, /* side */ 'target');
    rightCol.append(rightTypesHost);
    linkBodyHost.append(twoColumns(leftCol, rightCol));

    // Родительский тип связи + кнопка «Оформление»
    const parentRow = div('form-row type-editor-row');
    const parentCombo = createTypeCombobox({
      options: () => linkTypeOptions(store.state.linkTypes),
      value: draft.parentLinkTypeId,
      placeholder: 'Без родителя',
      onChange: (id) => {
        draft.parentLinkTypeId = id;
      },
    });
    const styleBtn = button('Оформление…', () => openLinkStyle(), 'btn small');
    parentRow.append(parentCombo.root, styleBtn);
    linkBodyHost.append(field('Родительский тип связи', parentRow));

    // Значение по умолчанию для свойства-связи задаётся не здесь, а в
    // таблицах «Типы источников»/«Типы назначений» (колонка «Значение по
    // умолчанию», `buildRow` ниже): у каждого типа свой набор целей,
    // отправляется через `etn.types.setPropertyDefaultOverride` на apply.
    // Так требует инструкция a47947c8 — унифицированное поле выбора
    // ссылок в колонке таблицы, а не отдельное поле над ней.

    // Имя в реестре для свойства-связи — копия `name_forward` (сервер
    // вычисляет `linkPropertyDisplayName`, см. заметку в shared).
    draft.name = draft.nameForward;
  }

  function buildScalarOptionsBlock(): HTMLElement {
    const host = div('form-stack');
    const choiceRow = el('label', 'checkbox-row') as HTMLLabelElement;
    const choiceCheck = el('input') as HTMLInputElement;
    choiceCheck.type = 'checkbox';
    choiceCheck.checked = draft.choiceOn;
    choiceCheck.addEventListener('change', () => {
      draft.choiceOn = choiceCheck.checked;
      renderScalarBody();
    });
    choiceRow.append(choiceCheck, span('выбирать из списка'));
    host.append(choiceRow);
    if (draft.choiceOn) {
      const area = el('textarea', 'textarea-input') as HTMLTextAreaElement;
      area.value = draft.optionsText;
      area.rows = 4;
      area.placeholder = 'Варианты значения — по одному в строке';
      area.addEventListener('input', () => {
        draft.optionsText = area.value;
      });
      host.append(area);
    }
    const multiRow = el('label', 'checkbox-row') as HTMLLabelElement;
    const multiCheck = el('input') as HTMLInputElement;
    multiCheck.type = 'checkbox';
    multiCheck.checked = draft.multipleOn;
    multiCheck.addEventListener('change', () => {
      draft.multipleOn = multiCheck.checked;
    });
    multiRow.append(multiCheck, span('несколько значений'));
    host.append(multiRow);
    return host;
  }

  // ---- Таблица «Типы мыслей» / «Источники» / «Назначения» --------------
  function buildTypeRowsTable(host: HTMLElement, isLink: boolean, side: 'source' | 'target' | null): void {
    host.append(sectionLabel(isLink ? (side === 'source' ? 'Типы источников' : 'Типы назначений') : 'Типы мыслей'));
    const tableWrap = div('admin-table-wrap');
    tableWrap.style.maxHeight = '160px';
    host.append(tableWrap);

    const rows = (): TypeRowDraft[] =>
      draft.typeRows.filter((r) => (isLink ? r.side === side : r.side === null));

    function renderTable(): void {
      tableWrap.replaceChildren();
      const table = el('table', 'table-list');
      const head = el('thead');
      const headRow = el('tr');
      headRow.append(
        el('th', undefined, 'Тип мысли'),
        el('th', undefined, 'Обязательное'),
        el('th', undefined, 'Значение по умолчанию'),
        el('th'),
      );
      head.append(headRow);
      table.append(head);
      const tbody = el('tbody');
      const rowsHere = rows();
      if (rowsHere.length === 0) {
        const empty = el('tr');
        const emptyCell = el('td', 'muted', 'Нет привязок. Нажмите «Добавить тип».');
        emptyCell.colSpan = 4;
        empty.append(emptyCell);
        tbody.append(empty);
      } else {
        for (const row of rowsHere) {
          tbody.append(buildRow(row));
        }
      }
      table.append(tbody);
      tableWrap.append(table);
    }

    function buildRow(row: TypeRowDraft): HTMLElement {
      const tr = el('tr');
      const tt = store.state.thoughtTypes.find((t) => t.id === row.thoughtTypeId);
      const ttName = tt?.name ?? row.thoughtTypeId.slice(0, 8);
      // Тип мысли — неизменяем после создания строки (требование к форме
      // «добавление/изменение/удаление строк»: удаление = отвязка;
      // смена типа — отдельной командой, чтобы не править миграцию).
      tr.append(el('td', undefined, ttName));

      // Обязательное
      const reqCell = el('td');
      const reqCheck = el('input') as HTMLInputElement;
      reqCheck.type = 'checkbox';
      reqCheck.checked = row.required;
      reqCheck.addEventListener('change', () => {
        row.required = reqCheck.checked;
        row.dirty = true;
      });
      reqCell.append(reqCheck);
      tr.append(reqCell);

      // Значение по умолчанию: для скаляра — текстовое поле; для свойства-связи
      // — унифицированный чип-пикер мыслей (инструкция a47947c8,
      // требование 3181389d). Хранится в `type_properties.default_value`,
      // применяется через `etn.types.setPropertyDefaultOverride` на apply.
      // Фильтр по типам целей — из **противоположной** таблицы (с раскрытием
      // иерархии): типы «источников» ограничивают поиск целей в строках
      // «назначений», и наоборот. Если противоположная таблица пуста — фильтра
      // нет (можно выбирать любые мысли).
      const dvCell = el('td');
      if (isLink) {
        const oppositeIds = collectOppositeSideTypeIds(draft.typeRows, side);
        const filterIds = oppositeIds.length > 0
          ? expandTypeIdsToSubtree(store.state.thoughtTypes, oppositeIds)
          : [];
        const linkDefaults = buildChipListField({
          getValues: () =>
            Array.isArray(row.defaultValue) ? (row.defaultValue as string[]) : [],
          onChange: (values) => {
            row.defaultValue = values.length > 0 ? values : null;
            row.dirty = true;
          },
          getOptions: async (query) => {
            const trimmed = query.trim();
            if (trimmed === '') return [];
            try {
              const hits = await etn.thoughts.findDuplicates(
                networkId,
                trimmed,
                undefined,
                filterIds.length > 0 ? filterIds : undefined,
              );
              return hits.map((h) => ({ value: h.id, label: h.title }));
            } catch {
              return [];
            }
          },
          renderLabel: async (id) => {
            try {
              const t = await etn.thoughts.get(networkId, id);
              return t.title;
            } catch {
              return `${id.slice(0, 8)}…`;
            }
          },
          placeholder: 'Заголовок мысли-цели…',
          picker: {
            label: 'выбрать…',
            open: async (managed) => {
              const result = await pickThoughtsDialog({
                networkId,
                allowCreate: false,
                allowLinkType: false,
                searchTypeIds: filterIds.length > 0 ? filterIds : undefined,
                defaultNewThoughtTypeId: filterIds[0] ?? null,
                selectedIds: managed,
                title: 'Выбрать мысли',
                applyLabel: 'Выбрать',
              });
              return result === null ? null : pickedThoughtIds(result);
            },
          },
        });
        dvCell.append(linkDefaults.root);
      } else {
        const dvInput = el('input', 'text-input') as HTMLInputElement;
        dvInput.type = 'text';
        dvInput.placeholder = '(пусто)';
        dvInput.value =
          row.defaultValue === null || row.defaultValue === undefined
            ? ''
            : String(row.defaultValue);
        dvInput.addEventListener('input', () => {
          const v = dvInput.value.trim();
          row.defaultValue = v === '' ? null : v;
          row.dirty = true;
        });
        dvCell.append(dvInput);
      }
      tr.append(dvCell);

      // Удалить строку
      const actionCell = el('td');
      const rm = button('✕', () => removeRow(row), 'btn small', 'Снять привязку');
      actionCell.append(rm);
      tr.append(actionCell);
      return tr;
    }

    function removeRow(row: TypeRowDraft): void {
      draft.typeRows = draft.typeRows.filter((r) => r !== row);
      renderTable();
    }

    async function addRow(): Promise<void> {
      const picked = await openThoughtTypesPicker(networkId, []);
      if (picked === null || picked.length === 0) return;
      const thoughtTypeId: string = picked[0] as string;
      // Дубль строки (та же сторона для связи) запрещён.
      if (draft.typeRows.some((r) => r.thoughtTypeId === thoughtTypeId && r.side === side)) return;
      draft.typeRows = [
        ...draft.typeRows,
        {
          id: null,
          thoughtTypeId,
          required: false,
          defaultValue: null,
          side,
          dirty: true,
        },
      ];
      renderTable();
    }

    host.append(
      button('Добавить тип', () => void addRow(), 'btn small', 'Добавить привязку свойства к типу мысли'),
    );

    renderTable();
  }

  /** Загрузка строк таблицы привязок для существующего свойства: список
   *  типов мыслей сети + для каждого типа запрос `listTypeProperties`
   *  фильтрует по нашему `property_id`. Для свойства-связи — две стороны
   *  (`source`/`target`) согласно `type_properties.side`. */
  async function loadTypeRowsFor(propertyId: string): Promise<void> {
    const types = store.state.thoughtTypes;
    if (types.length === 0) return;
    const collected: TypeRowDraft[] = [];
    await Promise.all(
      types.map(async (tt) => {
        try {
          const defs = await etn.types.listTypeProperties(networkId, 'thought_type', tt.id);
          for (const def of defs) {
            if (def.property_id !== propertyId) continue;
            collected.push({
              id: def.id,
              thoughtTypeId: tt.id,
              required: def.required === true,
              defaultValue: def.default_value ?? null,
              side: (def.side ?? null) as 'source' | 'target' | null,
              dirty: false,
            });
          }
        } catch {
          // пропускаем — частичный список всё равно полезен
        }
      }),
    );
    draft.typeRows = collected;
    rerenderBody();
  }

  // ---- Оформление (color/style/width) -----------------------------------
  function openLinkStyle(): void {
    const resolved = resolveLinkTypeVisual(
      store.state.linkTypes,
      draft.parentLinkTypeId ?? null,
    );
    showLinkStyleDialog({
      resolved: {
        color: draft.linkColor,
        style: (draft.linkStyle ?? resolved.style) as LinkStyle,
        width: draft.linkWidth ?? resolved.width,
      },
      mode: 'type',
      onApply: async (patch) => {
        if (patch.color !== undefined) draft.linkColor = patch.color;
        if (patch.style !== undefined) draft.linkStyle = patch.style;
        if (patch.width !== undefined) draft.linkWidth = patch.width;
      },
    });
  }

  // Первая отрисовка формы.
  rerenderBody();

  // ---- Метаданные -------------------------------------------------------
  if (property !== null) {
    metadataHost.append(buildMetadataRowsFromProperty(property));
    metadataHost.append(buildUsagePanel(networkId, property.id, onChanged));
  } else {
    metadataHost.append(el('p', 'muted', 'Метаданные появятся после сохранения.'));
  }

  // ---- Привязка событий -------------------------------------------------
  typeSelect.addEventListener('change', () => {
    const prev = draft.valueType;
    const next = typeSelect.value as PropertyValueType;
    if (lockedCategory !== null && categoryOf(next) !== lockedCategory) {
      // Защита: запрет смены категории (требование 5a82c709).
      typeSelect.value = prev;
      errorLine.textContent =
        'Сменить категорию (скаляр ↔ связь) нельзя: значения связи живут рёбрами, а не в таблице значений.';
      return;
    }
    errorLine.textContent = '';
    // При смене скалярного вида между собой — сбрасываем вид-специфичное.
    if (prev !== 'link' && next !== 'link') {
      if (prev === 'text' && next !== 'text') {
        draft.choiceOn = false;
        draft.optionsText = '';
      }
    }
    if (next === 'link') {
      draft.defaultValue = null;
    }
    draft.valueType = next;
    rerenderBody();
  });

  function revalidateName(): void {
    if (nameClash(draft.name) !== null) {
      errorLine.textContent = DUP_NAME_MSG;
      if (applyBtn !== null) applyBtn.disabled = true;
    } else {
      if (errorLine.textContent === DUP_NAME_MSG) errorLine.textContent = '';
      if (applyBtn !== null) applyBtn.disabled = false;
    }
  }
  function nameClash(name: string): RegistryRow | null {
    const key = name.trim().toLowerCase();
    if (key === '') return null;
    return (
      allProperties.find(
        (p) => p.id !== (current?.id ?? null) && p.name.trim().toLowerCase() === key,
      ) ?? null
    );
  }
  // Fresh registry snapshot — the server re-checks on apply anyway.
  void etn.propertyRegistry
    .list(networkId)
    .then((rows) => {
      allProperties = rows;
      revalidateName();
    })
    .catch(() => {});

  // ---- Применение -------------------------------------------------------
  async function apply(close: () => void): Promise<void> {
    // Базовые проверки.
    if (draft.valueType === 'link') {
      if (draft.nameForward.trim() === '' || draft.nameReverse.trim() === '') {
        errorLine.textContent = 'Укажите имена обеих сторон.';
        return;
      }
    } else if (draft.name.trim() === '') {
      errorLine.textContent = 'Название свойства обязательно.';
      return;
    }
    const name = draft.valueType === 'link' ? draft.nameForward.trim() : draft.name.trim();
    if (nameClash(name) !== null) {
      errorLine.textContent = DUP_NAME_MSG;
      return;
    }

    try {
      if (current === null) {
        const input: NetworkPropertyInput = {
          name,
          value_type: draft.valueType,
          ...(draft.description.trim() !== '' ? { description: draft.description.trim() } : {}),
          ...buildConfigForCreate(draft),
        };
        if (draft.valueType === 'link') {
          input.name_forward = draft.nameForward.trim();
          input.name_reverse = draft.nameReverse.trim();
          if (draft.parentLinkTypeId !== null) input.parent_link_type_id = draft.parentLinkTypeId;
          if (draft.linkColor !== null) input.link_color = draft.linkColor;
          if (draft.linkStyle !== null) input.link_style = draft.linkStyle;
          if (draft.linkWidth !== null) input.link_width = draft.linkWidth;
        }
        const created = await etn.propertyRegistry.create(networkId, input);
        current = {
          ...created,
          types_count: 0,
          values_count: 0,
        };
        // Создать привязки к типам мыслей.
        await applyTypeRows(created.id);
        onCreated?.(created);
      } else {
        const changes: NetworkPropertyUpdateInput = { name };
        if (draft.valueType !== current.value_type) changes.value_type = draft.valueType;
        const newDescription = draft.description.trim() === '' ? null : draft.description.trim();
        if (newDescription !== (current.description ?? null)) changes.description = newDescription;
        const newConfig = buildConfigForUpdate(draft, current.config);
        if (!sameConfig(newConfig, current.config)) changes.config = newConfig;
        if (draft.valueType === 'link') {
          if (draft.nameForward.trim() !== '') changes.name_forward = draft.nameForward.trim();
          if (draft.nameReverse.trim() !== '') changes.name_reverse = draft.nameReverse.trim();
          if (draft.linkColor !== null) changes.link_color = draft.linkColor;
          if (draft.linkStyle !== null) changes.link_style = draft.linkStyle;
          if (draft.linkWidth !== null) changes.link_width = draft.linkWidth;
        }
        if (Object.keys(changes).length === 0) {
          // Применим только привязки (если есть dirty), потом закроем.
          await applyTypeRows(current.id);
          close();
          return;
        }
        // Подтверждение конверсии value_type при смене внутри скалярной
        // категории (между скалярами идёт серверная конверсия).
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
        // Применим привязки к типам мыслей.
        await applyTypeRows(current.id);
      }
      onChanged();
      close();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  /** Сохранение строк таблицы привязок. На входе — черновик; на выходе —
   *  строки применены через `etn.types.createTypeProperty/updateTypeProperty/
   *  removeTypeProperty`. Для свойства-связи дополнительно — `default_value`
   *  через `etn.types.setPropertyDefaultOverride` (требование 3181389d,
   *  инструкция a47947c8): набор целей `string[]` хранится в
   *  `type_properties.default_value` и применяется созданием рёбер при
   *  создании мысли. */
  async function applyTypeRows(propertyId: string): Promise<void> {
    if (draft.typeRows.length === 0 && !hasRemovedRows()) return;
    const isLink = draft.valueType === 'link';
    const ops: Promise<unknown>[] = [];
    const created = new Map<string, TypeRowDraft>();
    for (const row of draft.typeRows) {
      if (row.id === null) {
        // Создание: сначала привязка, затем (для связи) — её default.
        ops.push(
          (async (): Promise<void> => {
            const def = await etn.types.createTypeProperty(
              networkId,
              'thought_type',
              row.thoughtTypeId,
              {
                mode: 'attach',
                property_id: propertyId,
                required: row.required,
                ...(row.side !== null ? { side: row.side } : {}),
              },
            );
            if (isLink) {
              await etn.types.setPropertyDefaultOverride(
                networkId,
                'thought_type',
                row.thoughtTypeId,
                def.id,
                linkDefaultPayload(row.defaultValue),
              );
            }
            created.set(def.id, row);
          })(),
        );
      } else if (row.dirty) {
        ops.push(
          (async (): Promise<void> => {
            await etn.types.updateTypeProperty(
              networkId,
              'thought_type',
              row.thoughtTypeId,
              row.id as string,
              { required: row.required },
            );
            if (isLink) {
              await etn.types.setPropertyDefaultOverride(
                networkId,
                'thought_type',
                row.thoughtTypeId,
                row.id as string,
                linkDefaultPayload(row.defaultValue),
              );
            }
          })(),
        );
      }
    }
    await Promise.all(ops).catch((err) => {
      throw err;
    });
  }

  /** Преобразует черновое значение колонки «Значение по умолчанию» в
   *  формат `etn.types.setPropertyDefaultOverride` для свойства-связи:
   *  `string[]` (набор id целей) или `null` (очистить). */
  function linkDefaultPayload(value: unknown): string[] | null {
    if (Array.isArray(value)) {
      const ids = value.filter((v): v is string => typeof v === 'string' && v !== '');
      return ids.length > 0 ? ids : null;
    }
    return null;
  }

  /** Возвращает `true`, если среди исходных строк есть удалённые (мы их
   *  сравниваем с draft). Используется для решения — синхронизировать ли. */
  function hasRemovedRows(): boolean {
    // Сложность: loadTypeRowsFor даёт начальный снимок; удалённые строки
    // просто отсутствуют в draft.typeRows. Чтобы отличить «никогда не было»
    // от «было и удалили», нужен снимок «было». Здесь упрощённо: если
    // среди текущих draft-строк есть хоть одна с id !== null — был снимок,
    // значит удаления отслеживаем. Для остальных случаев no-op.
    return draft.typeRows.some((r) => r.id !== null);
  }

  showDialog({
    title: property === null ? 'Новое свойство' : `Свойство — «${property.name}»`,
    body,
    width: 1240,
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
    onMount: () => {
      const firstInput = body.querySelector('input, textarea, select') as HTMLElement | null;
      firstInput?.focus();
    },
    onClose: () => void releaseHeld(editLock),
  });
}

// ---------------------------------------------------------------------------
// Сборка PropertyConfig из черновика
// ---------------------------------------------------------------------------

/** Для POST: конфиг (если есть что хранить) + `null` если пусто. */
function buildConfigForCreate(draft: PropertyDraft): { config?: PropertyConfig | null } {
  if (draft.valueType === 'link') {
    const cfg = linkConfigFromDraft(draft);
    return cfg === null ? {} : { config: cfg };
  }
  const cfg = scalarConfigFromDraft(draft);
  return cfg === null ? {} : { config: cfg };
}

/** Для PATCH: полный конфиг (даже если он null после очистки полей). */
function buildConfigForUpdate(draft: PropertyDraft, current: PropertyConfig | null): PropertyConfig | null {
  if (draft.valueType === 'link') {
    return linkConfigFromDraft(draft, current);
  }
  return scalarConfigFromDraft(draft);
}

/** Конфиг свойства-связи из черновика. Никогда не `null` — сервер требует
 *  `direction` для ссылки. */
function linkConfigFromDraft(draft: PropertyDraft, current?: PropertyConfig | null): PropertyConfig | null {
  if (draft.valueType !== 'link') return null;
  // Для уже существующего свойства — сохраняем `link_type_id`/`structural`
  // из текущего конфига (они задаются на create и не вычисляются из draft).
  // Без этого PATCH отклоняется сервером: VALIDATION_ERROR «свойство-связь
  // требует config.link_type_id» (баг cab38479-фикс2). Для нового — сервер
  // создаст link_type автоматически (задача dd37a66) по паре имён сторон,
  // и `config.link_type_id` придёт в ответе на create.
  const cfg: PropertyConfig = {};
  if (current?.link_type_id !== undefined && current.link_type_id !== '') {
    cfg.link_type_id = current.link_type_id;
  }
  if (current?.structural === true) {
    cfg.structural = true;
  }
  cfg.direction = 'out';
  if (draft.showOnMap) cfg.show_on_map = true;
  if (draft.blocksTargetDeletion) cfg.blocks_target_deletion = true;
  if (Array.isArray(draft.defaultValue) && draft.defaultValue.length > 0) {
    cfg.default_value = [...new Set(draft.defaultValue as string[])];
  }
  return cfg;
}

/** Конфиг скалярного свойства из черновика. `null` если нечего хранить. */
function scalarConfigFromDraft(draft: PropertyDraft): PropertyConfig | null {
  if (draft.valueType === 'link') return null;
  const cfg: PropertyConfig = {};
  if (draft.defaultValue !== null && draft.defaultValue !== undefined) {
    cfg.default_value = draft.defaultValue as string | number | boolean;
  }
  if (draft.valueType === 'text' && draft.choiceOn) {
    const list = draft.optionsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (list.length > 0) cfg.options = list;
  }
  if (draft.multipleOn) cfg.multiple = true;
  return Object.keys(cfg).length > 0 ? cfg : null;
}

// ---------------------------------------------------------------------------
// Старая конфигурация-утилита — сохранена для обратной совместимости тестов
// ---------------------------------------------------------------------------

/**
 * @deprecated Используйте новый единый диалог (`openPropertyManagerEditor`).
 * Эта функция оставлена только для существующих юнит-тестов
 * (`property-manager-build-config.test.ts`) и будет удалена вместе с ними.
 *
 * Конвертирует развёрнутый набор draft-полей в `PropertyConfig`. Подробнее
 * см. {@link linkConfigFromDraft} / {@link scalarConfigFromDraft}.
 */
export interface LinkConfigDraft {
  structural: boolean;
  linkTypeId: string | null;
  direction: 'out' | 'in';
  allowedTargetTypeIds: string[];
  showOnMap: boolean;
  blocksTargetDeletion: boolean;
  legacyMultiple: boolean;
}

/** @deprecated см. {@link LinkConfigDraft}. */
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

// ---------------------------------------------------------------------------
// Value-type-specific default-value input
// ---------------------------------------------------------------------------

/**
 * Builds a default-value input matching `valueType`; `read(value)` is called
 * once when the input commits (blur/change). Link defaults (the target-set
 * chip field, bb67e546) are wired directly inside the link block — the stub
 * below is a defensive fallback for the «link» case when the chip field has
 * not been mounted yet (e.g. while the dialog is mid-render).
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
      return span('управляется в блоке связи', 'muted');
    case 'thought_ref':
      return span('упразднено', 'muted');
  }
}

// ---------------------------------------------------------------------------
// Утилиты конфигов и форм
// ---------------------------------------------------------------------------

/** True when the new config and the stored one carry the same payload. */
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
function buildUsagePanel(
  networkId: string,
  propertyId: string,
  onChanged: () => void,
): HTMLElement {
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

  /** Открывает редактор нужного типа: для thought_type — редактор типа мысли;
   *  для link_type — единый диалог свойства-связи (требование 09f692ff:
   *  редактор типа связи упразднён, единственная точка редактирования —
   *  свойство-связь). */
  async function openTypeEditorByUsage(row: PropertyUsageRow): Promise<void> {
    if (row.owner_type === 'thought_type') {
      const t = store.state.thoughtTypes.find((tt) => tt.id === row.owner_id);
      if (t !== undefined) {
        const { showThoughtTypeEditor } = await import('./type-manager.js');
        showThoughtTypeEditor(t, () => void reload());
      }
    } else {
      // link_type: открываем свойство-связь.
      const regRows = await etn.propertyRegistry.list(networkId);
      const prop = regRows.find((p) => p.value_type === 'link' && p.config?.link_type_id === row.owner_id);
      if (prop !== undefined) {
        openPropertyManagerEditor(prop, onChanged);
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
