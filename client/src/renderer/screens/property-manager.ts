/**
 * Network property catalogue management (task d4e23670, fd4d4927, 09201bd4,
 * element «Менеджер свойств сети»).
 *
 * Two entry points share the same underlying registry (`properties` +
 * `link_types`) and the same editor (`openPropertyManagerEditor`):
 *
 * - `showPropertyManagerDialog` («Свойства», до 0.8.2 — «Свойства и связи») —
 *   the shared property list (`lib/property-list.ts`, задача 6ebde54e) in
 *   manager mode: a single alphabetical stream where a scalar is one row and a
 *   link-property is always TWO rows (source name `→`, target name `←`), with
 *   columns «Имя» (value-type icon / coloured link arrow), «Тип значения»
 *   (`связь (имя - имя)`, names cut at 30 chars, ⓘ with the description) and
 *   «Кол-во типов» (per-side `types_source_count` / `types_target_count`).
 *   Structural «Родители» / «Потомки» are listed with a lock glyph; deletion
 *   lives in the row context menu («Изменить» / «Удалить»), not a «✕» button.
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
 * Колонка «Значение по умолчанию» каждой строки таблиц — редактор значения
 * (0.8.2, ADR «дефолт свойства живёт на привязке», тех.проект 43870285):
 * заполнено — дефолт этой привязки (`type_property_overrides.default_value`,
 * `setPropertyDefaultOverride`), пусто — при создании мысли действует общее
 * значение стороны (подсказка — в тултипе пустой ячейки). Режимов
 * «(общее)»/«частное» больше нет. Общие значения — под своими таблицами: у
 * скаляра одно поле «Значение по умолчанию» (`config.default_value`), у
 * свойства-связи два поля «Значение по умолчанию для всех типов» — под
 * «Типами источников» (`config.default_value`) и под «Типами назначений»
 * (`config.default_value_target`), каждое с отбором целей по типам
 * противоположной таблицы (задача 99312ffa).
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
  LinkPropertyValueItem,
  LinkType,
  LinkStyle,
  NetworkProperty,
  NetworkPropertyInput,
  NetworkPropertyUpdateInput,
  PropertyConfig,
  PropertyValueType,
} from '@etn/shared';
import { t } from '../lib/i18n.js';

import { requireNetworkId } from '../app.js';
import {
  confirmDialog,
  errorDialog,
  raiseOpenDialog,
  showDialog,
} from '../lib/dialog.js';
import { div, el, errText, setTooltip, span } from '../lib/dom.js';
import { footerErrorLine, operationError, operationErrorText } from '../lib/ui/messages.js';
import { loadingState } from '../lib/ui/empty-state.js';
import { collapsibleSection } from '../lib/ui/collapsible.js';
import { showLinkStyleDialog } from '../editor/style-dialog.js';
import { buildMetadataRows, type MetadataFields } from '../lib/metadata.js';
import { etn } from '../lib/etn.js';
import { acquireOrShowBlocked, lockHandleFromOutcome, releaseHeld, type LockHandle } from '../lib/lock-guard.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';
import { orderedTypeRows, resolveLinkTypeVisual } from '../lib/type-tree.js';
import { createTree, type TreeItem } from '../lib/ui/tree.js';
import { onRealtimeEvent } from '../realtime.js';
import { reloadTypeCatalogues, scheduleTypeRepaint } from '../realtime-ui.js';
// Локальные уведомления открытого редактора (своё realtime-эхо до рендерера не
// доходит, G8 applier): изменение набора свойств типа (ошибка 74b94c26),
// правка/удаление самого реестрового свойства (98aa0889) и правка/удаление
// СВЯЗАННОГО ТИПА СВЯЗИ единым жизненным циклом свойства-связи (7dfad7d4).
import {
  linkTypeFieldsFromPropertyChanges,
  notifyPropertyRegistryChanged,
  notifyTypeChanged,
  notifyTypeDefinitionsChanged,
  typeDeletedFacts,
  typeUpdateFacts,
} from '../lib/type-definitions.js';
import { buildEntityCombo, normalizeParentTypeId, pickEntitiesModal } from '../lib/entity-picker.js';
import { buildLinkValueEditor, buildValueEditor, linkAllowedTypeIds } from '../editor/value-editor.js';
import { uiButton } from '../lib/ui/button.js';
import { fieldInput, fieldTextarea, fieldRow } from '../lib/ui/field.js';
import { checkboxRow, choiceControl } from '../lib/ui/choice-row.js';
import {
  buildPropertyList,
  buildPropertyListRows,
  ensurePropertyLinkTypes,
  type PropertyRegistryRow,
} from '../lib/property-list.js';

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
  // Кросс-сетевая ссылка (задача 7849008a): значение адресует мысль ДРУГОЙ
  // сети по `n:<network_id>#<thought_id>`; снапшот имени — служебные данные.
  cross_network_ref: 'кросс-сетевая ссылка',
};

/** Виды значения, доступные пользователю в выборе — `thought_ref` скрыт. */
const SELECTABLE_VALUE_TYPES: PropertyValueType[] = [
  'text',
  'number',
  'date',
  'bool',
  'url',
  'link',
  // Кросс-сетевая ссылка (задача 7849008a) — доступна в выборе.
  'cross_network_ref',
];

/**
 * Реестровая строка свойства (`GET /networks/{nid}/properties` со счётчиками).
 * Определение живёт в общем модуле списка свойств
 * (`lib/property-list.ts`, задача 6ebde54e) — здесь только привычное имя для
 * потребителей этого файла (редактор, дерево типов связей).
 */
export type RegistryRow = PropertyRegistryRow;

/**
 * Открывает диалог «Свойства» (меню «Мыслесеть»; до 0.8.2 — «Свойства и
 * связи»). Список — общий компонент `buildPropertyList` в режиме менеджера
 * (задача 6ebde54e): скаляры и оба конца связей отдельными строками, иконки
 * видов значения / линии со стрелками, колонки «Имя» / «Тип значения» /
 * «Кол-во типов», поиск по имени и описанию, текущая строка, клавиатура и
 * сортировка от табличного фасада `lib/ui/table.ts`, активация Enter/двойной
 * клик, контекстное меню «Изменить»/«Удалить». Ширина — 900 px (≈ на 25 %
 * шире прежних 720 px).
 */
export function showPropertyManagerDialog(): void {
  const networkId = requireNetworkId();
  const errorLine = footerErrorLine();
  let cachedRows: RegistryRow[] | null = null;

  const list = buildPropertyList({
    mode: 'manager',
    searchPlaceholder: t('actions.search'),
    callbacks: {
      onAdd: () => openPropertyManagerEditor(null, onChanged),
      onActivate: (row) => openPropertyManagerEditor(row.registry, onChanged),
      onEdit: (row) => openPropertyManagerEditor(row.registry, onChanged),
      onDelete: (row) => void removeRow(row.registry),
    },
  });

  const body = div('form-stack');
  body.append(list.root);

  function onChanged(): void {
    cachedRows = null;
    void reload();
  }

  async function reload(): Promise<void> {
    let rows: RegistryRow[];
    if (cachedRows !== null) {
      rows = cachedRows;
    } else {
      try {
        rows = await etn.propertyRegistry.list(networkId);
      } catch (err) {
        errorLine.show(operationErrorText(err));
        return;
      }
      cachedRows = rows;
    }
    // Имена сторон и эффективное оформление линий берутся из каталога типов
    // связей — догружаем недостающие до сборки строк.
    await ensurePropertyLinkTypes(networkId, rows);
    list.setRows(buildPropertyListRows(rows, store.state.linkTypes));
  }

  /**
   * Удаление свойства из контекстного меню строки. Скалярные свойства
   * отвергаются сервером с 409 при `types_count > 0` или `values_count > 0`
   * — диалог ошибки подсказывает порядок. Свойство-связь требует
   * подтверждения с числом рёбер, которые потеряют `type_id`
   * (`links_becoming_structural`); сервер возвращает это поле вместе с 200
   * (требование 09f692ff). Структурные строки меню не получают.
   */
  async function removeRow(property: RegistryRow): Promise<void> {
    const isLink = property.value_type === 'link';
    const isStructuralLink = isLink && property.config?.structural === true;
    if (isStructuralLink) return;
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
    // Тип связи, который уйдёт вместе со свойством (единый жизненный цикл
    // 0.8.1): он нужен и для оценки числа рёбер, и для локального уведомления
    // открытого редактора после удаления (ошибка 7dfad7d4).
    const linkTypeId = isLink ? property.config?.link_type_id : undefined;
    if (isLink) {
      try {
        const counts = await etn.types.getLinkTypeCounts(networkId);
        if (linkTypeId !== undefined && linkTypeId !== null && linkTypeId !== '') {
          linksBecoming = counts[linkTypeId] ?? 0;
          linkEstimateOk = true;
        }
      } catch {
        // оценка недоступна — диалог подтверждения просто опустит деталь.
      }
    }
    let prompt: string;
    if (isLink) {
      const lt = (() => {
        return linkTypeId !== undefined && linkTypeId !== null && linkTypeId !== ''
          ? store.state.linkTypes.find((t) => t.id === linkTypeId) ?? null
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
      // Свойство реестра исчезло (ошибка 98aa0889): открытый редактор мысли
      // обязан перечитать набор — свойство могло быть привязано к типу или
      // покрывать его зеркалом. Своё realtime-эхо до рендерера не доходит
      // (G8 applier), поэтому уведомляем локально.
      notifyPropertyRegistryChanged(property.id);
      // Свойство-связь уносит и связанный тип связи (единый жизненный цикл
      // 0.8.1, серверный `deleteProperty` → `deleteLinkType` с force). Открытый
      // редактор показанной СВЯЗИ этого типа обязан пометить тип исчезнувшим и
      // перечитать саму связь (её `type_id` сервер обнулил, отдельного события
      // о связи не шлёт) — ошибка 7dfad7d4. Каталог типов перечитываем ДО
      // уведомления: шапка редактора резолвит подпись и линию из него, а своё
      // realtime-эхо (которое перечитало бы каталог) отброшено. Признак
      // реального удаления типа — числовой `links_becoming_structural` в ответе
      // (сервер считает его только для удалённого link_type).
      if (
        typeof result.links_becoming_structural === 'number' &&
        typeof linkTypeId === 'string' &&
        linkTypeId !== ''
      ) {
        await reloadTypeCatalogues();
        notifyTypeChanged(typeDeletedFacts({ ownerType: 'link_type', ownerId: linkTypeId }));
        // Исчезнувший тип связи: отвязанные рёбра на холсте перерисовываются
        // только по свежему фокусу (сервер обнулил их `type_id`, отдельного
        // события о связи не шлёт), а «Структуры»/«Хроника» держат собственные
        // снимки — тот же набор пересчёта, что и realtime-эхо (270b8454).
        scheduleTypeRepaint();
      }
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
    title: 'Свойства',
    body,
    size: 'l',
    // Ошибки реестра — в панели кнопок диалога (требование 397c5a56).
    footerError: errorLine,
    buttons: [{ label: t('actions.close'), primary: true }],
    // Фокус на таблице: клавиатура (↑/↓, Home/End, Enter) сразу работает по
    // списку — её ведёт фасад `lib/ui/table.ts`.
    onMount: () => list.focus(),
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
export interface TypeRowDraft {
  /** Id привязки (`type_properties.id`). `null` для ещё не сохранённой
   *  строки — она появится только после `apply` и POST на сервер. */
  id: string | null;
  thoughtTypeId: string;
  required: boolean;
  /** Дефолт ЭТОЙ привязки (`type_property_overrides.default_value`; 0.8.2):
   *  для свойства-связи — набор id целей, для скаляра — значение по виду
   *  свойства. `null` — собственного дефолта нет, при создании мысли
   *  действует общее значение стороны привязки. */
  defaultValue: unknown;
  /** Сторона привязки для свойства-связи (`source`/`target`) — для скаляра
   *  всегда `null`. Сохраняется в `type_properties.side`. */
  side: 'source' | 'target' | null;
  /** Снимок текущего состояния на сервере — для отслеживания изменений
   *  при `apply`. */
  dirty: boolean;
  /**
   * Снимок дефолта привязки на момент загрузки строки: override шлётся только
   * когда дефолт реально менялся. Не задан у строк, добавленных вручную
   * (они только создаются — override для них ещё не существует).
   */
  initialDefaultValue?: unknown;
}

/** Единый черновик единого диалога (задача 09201bd4, спека 465495a9). */
export interface PropertyDraft {
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
  /** Общее значение стороны **источников** (для скаляра — единственное):
   *  `config.default_value` справочника (0.8.2). */
  defaultValue: unknown;
  /** Общее значение стороны **назначений** свойства-связи —
   *  `config.default_value_target` (0.8.2); у скаляра не используется. */
  defaultValueTarget: unknown;
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

/**
 * Изменился ли дефолт строки относительно серверного снимка: override шлётся
 * только при реальном изменении — правка одного «обязательного» не должна
 * создавать лишний override. Без снимка (строка добавлена вручную) —
 * изменений по определению нет: у неё нет серверного состояния.
 */
export function defaultValueChanged(row: TypeRowDraft): boolean {
  if (row.initialDefaultValue === undefined) return false;
  return (
    stableJson(row.defaultValue ?? null) !==
    stableJson(row.initialDefaultValue ?? null)
  );
}

/**
 * Операция записи дефолта привязки (`etn.types.setPropertyDefaultOverride`,
 * 0.8.2). Строка несёт id типа и (для сохранённых привязок) id привязки: у
 * новой строки (`row.id === null`) override пишется после `attach`.
 */
export interface DefaultOverrideOp {
  row: TypeRowDraft;
  /** Тело `setPropertyDefaultOverride`: `string[]` целей для связи, скаляр
   *  по виду значения, либо `null` — сброс override. */
  value: string | number | boolean | string[] | null;
}

/**
 * Операции записи дефолтов привязок из черновика (0.8.2, ADR «дефолт свойства
 * живёт на привязке»): пишется только то, что реально меняется — у загруженных
 * строк по снимку {@link defaultValueChanged}, у новых (id ещё нет) лишь
 * заполненный дефолт — сразу после создания привязки. Строка «обязательное»
 * без правки дефолта операции не порождает. Чистая — юнит-тест
 * (`property-manager-apply.test.ts`, приёмочный пример тех.проекта 43870285).
 */
export function collectDefaultOverrideOps(
  rows: readonly TypeRowDraft[],
  isLink: boolean,
): DefaultOverrideOp[] {
  const payloadOf = (row: TypeRowDraft): string | number | boolean | string[] | null =>
    isLink ? linkDefaultPayload(row.defaultValue) : scalarDefaultPayload(row.defaultValue);
  const ops: DefaultOverrideOp[] = [];
  for (const row of rows) {
    if (row.id === null) {
      const value = payloadOf(row);
      if (value !== null) ops.push({ row, value });
      continue;
    }
    if (!defaultValueChanged(row)) continue;
    ops.push({ row, value: payloadOf(row) });
  }
  return ops;
}

/**
 * Id типов, уже стоящих в таблице привязок этой стороны, — предзаполнение
 * пикера «Добавить тип» (ошибка 4e9ad1a0): при открытии диалога уже выбранные
 * типы отмечены чек-боксами. Сторона — та же, что у таблицы (у скаляра
 * `null`), поэтому набор совпадает со строками, показанными в ней. Чистая —
 * юнит-тест.
 */
export function currentTypeRowIds(
  rows: readonly TypeRowDraft[],
  side: 'source' | 'target' | null,
): string[] {
  return rows.filter((r) => r.side === side).map((r) => r.thoughtTypeId);
}

/**
 * Приводит строки таблицы привязок к выбору пикера «Добавить тип»:
 * ПЕРЕЗАПИСЫВАЕТ набор строк своей стороны `picked`-типами (ошибка a3828b28) —
 * типы, с которых сняли флажок, из черновика уходят (на записи их снимет
 * `removeTypeProperty`), отмеченные добавляются строками с дефолтами, а
 * нетронутые сохраняют свои настройки (id привязки, «обязательное», дефолт,
 * снимок `initialDefaultValue`) как есть. Строки ЧУЖОЙ стороны не трогаются:
 * таблицы «Типы источников»/«Типы назначений» независимы. Порядок: сперва
 * сохраняемые строки в исходном порядке, затем новые (в порядке выбора).
 * Чистая — юнит-тест.
 */
export function applyPickedTypeRows(
  existing: readonly TypeRowDraft[],
  picked: readonly string[],
  side: 'source' | 'target' | null,
): TypeRowDraft[] {
  const wanted = new Set(picked.filter((id) => id !== ''));
  const settled = new Set<string>();
  const next: TypeRowDraft[] = [];
  for (const row of existing) {
    if (row.side !== side) {
      next.push(row);
      continue;
    }
    // Снятый флажок или дубль той же стороны — строку не переносим.
    if (!wanted.has(row.thoughtTypeId) || settled.has(row.thoughtTypeId)) continue;
    settled.add(row.thoughtTypeId);
    next.push(row);
  }
  for (const thoughtTypeId of picked) {
    if (thoughtTypeId === '' || settled.has(thoughtTypeId)) continue;
    settled.add(thoughtTypeId);
    next.push({
      id: null,
      thoughtTypeId,
      required: false,
      defaultValue: null,
      side,
      dirty: true,
    });
  }
  return next;
}

/**
 * Преобразует черновое значение колонки «Значение по умолчанию» в формат
 * `etn.types.setPropertyDefaultOverride` для свойства-связи: `string[]`
 * (набор id целей) или `null` (пусто/сброс override).
 */
export function linkDefaultPayload(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const ids = value.filter((v): v is string => typeof v === 'string' && v !== '');
    return ids.length > 0 ? ids : null;
  }
  return null;
}

/**
 * Значение скалярного дефолта для `setPropertyDefaultOverride`:
 * string/number/boolean или null (пусто/сброс); пустая строка — тоже пусто
 * (осмысленного дефолта она не несёт, а override с `''` подавил бы общее
 * значение стороны); прочее — null.
 */
export function scalarDefaultPayload(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

/**
 * Сохраняет «Родительский тип связи» при правке существующего свойства
 * (ошибка d56c1ae4): `PATCH /properties` принимает имена сторон и оформление,
 * но не `parent_id` — иерархия типов связей правится отдельным служебным
 * `PATCH /link-types/{id}` (0.8.1, задача d7177d1d). При создании свойства
 * родитель уходит в `POST /properties` (`parent_link_type_id`).
 *
 * Родителя и его версию берём у сервера непосредственно перед PATCH
 * (`GET /link-types/{id}`): сохранение свойства-связи идёт одним «Применить»
 * как `PATCH /properties/{id}` → `syncLinkTypeParent`, и первый вызов уже
 * поднял версию связанного link_type (имена сторон/оформление синхронизируются
 * сервером). Снимок `store.state.linkTypes` к этому моменту ещё не получил
 * realtime-эхо, поэтому PATCH со старой версией падал
 * `VERSION_CONFLICT: link type version mismatch` — один «Применить»
 * конфликтовал сам с собой (ошибка e7c077e4). Снимок остаётся запасным
 * источником, если GET не удался.
 *
 * Возвращает `true`, когда `PATCH /link-types/{id}` действительно отправлен:
 * вызывающий код строит по этому факту локальное уведомление открытого
 * редактора об изменении типа связи (ошибка 7dfad7d4).
 */
export async function syncLinkTypeParent(
  networkId: string,
  property: RegistryRow,
  draft: PropertyDraft,
): Promise<boolean> {
  if (draft.valueType !== 'link') return false;
  const ltId = property.config?.link_type_id;
  if (ltId === undefined || ltId === null || ltId === '') return false;
  let lt: LinkType | null = null;
  try {
    lt = await etn.types.getLinkType(networkId, ltId);
  } catch {
    lt = null;
  }
  if (lt === null) lt = store.state.linkTypes.find((t) => t.id === ltId) ?? null;
  if (lt === null) return false;
  const nextParent = draft.parentLinkTypeId;
  if ((lt.parent_id ?? null) === (nextParent ?? null)) return false;
  await etn.types.updateLinkType(networkId, ltId, { parent_id: nextParent }, lt.version);
  return true;
}

/** Кросс-фильтр типов для колонки «Значение по умолчанию» свойства-связи:
 *  список `thoughtTypeId` из **противоположной** стороны таблицы привязок.
 *  Пустой массив означает «фильтр не задан» (противоположная таблица пуста —
 *  можно выбирать любые мысли). Иерархию раскрывает сам чип-редактор
 *  (`buildLinkValueEditor` → `expandTypeIdsToSubtree`), поэтому здесь
 *  возвращаются «сырые» id типов. */
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

/** Подпись поля общего дефолта стороны свойства-связи (задача 99312ffa):
 *  у обеих сторон одна и та же — «Значение по умолчанию для всех типов».
 *  Поле стоит в колонке своей таблицы, поэтому «для источников»/«для
 *  назначений» читается из контекста (тултип уточняет сторону). */
export const COMMON_SIDE_DEFAULT_LABEL = 'Значение по умолчанию для всех типов';

/** Ограничения и подсказка общего дефолта стороны свойства-связи (задача
 *  99312ffa): подпись, дословный тултип и набор допустимых типов-кандидатов.
 *  Ограничение берётся из **противоположной** таблицы живого черновика — та
 *  же модель (a6513df0), что у колонки «Значение по умолчанию» строк таблиц
 *  (у источника допустимые цели = типы стороны `target`, и наоборот). Пусто —
 *  без ограничений. Чистая — юнит-тест. */
export function commonSideDefaultSpec(
  rows: readonly TypeRowDraft[],
  side: 'source' | 'target',
): { label: string; tooltip: string; allowedTypeIds: string[] } {
  const tooltip =
    side === 'source'
      ? 'Значение по умолчанию для источников любых типов. Может быть переопределено значениями в строках таблицы выше'
      : 'Значение по умолчанию для назначений любых типов. Может быть переопределено значениями в строках таблицы выше';
  return {
    label: COMMON_SIDE_DEFAULT_LABEL,
    tooltip,
    allowedTypeIds: linkAllowedTypeIds(collectOppositeSideTypeIds(rows, side)),
  };
}

/** Порядок частей колонки стороны свойства-связи (задача 99312ffa): имя
 *  стороны, таблица типов, общий дефолт — **сразу под своей таблицей**.
 *  Вынесен ради юнит-теста компоновки (рендер использует его же). */
export function linkSideColumnParts(parts: {
  nameField: HTMLElement;
  tableHost: HTMLElement;
  commonDefaultHost: HTMLElement;
}): HTMLElement[] {
  return [parts.nameField, parts.tableHost, parts.commonDefaultHost];
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

/** Идентификатор значения категории `value_type`. После первой записи
 *  категория зафиксирована (требование 5a82c709). */
function lockCategoryFor(existing: PropertyValueType | null): ValueCategory | null {
  return existing === null || existing === undefined ? null : categoryOf(existing);
}

// ---------------------------------------------------------------------------
// Утилиты компоновки
// ---------------------------------------------------------------------------

/** Сворачиваемая группа: `summary` кликабельный, `body` показывается по клику. */
/** Сворачиваемая группа формы — общий компонент lib/ui/collapsible.ts
 *  (задача a57e7998): тело готовит вызывающий, компонент показывает его и
 *  вращает каретку-треугольник. */
function buildCollapsibleGroup(title: string, body: HTMLElement, defaultCollapsed: boolean): HTMLElement {
  return collapsibleSection({
    title,
    collapsed: defaultCollapsed,
    caretKind: 'triangle',
    body,
    classes: {
      root: 'form-stack collapsible-group',
      header: 'collapsible-summary',
      caret: 'collapsible-arrow',
    },
  }).root;
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

/** Поле с тултипом на подписи (задача 99312ffa): `field()` несёт только
 *  текст подписи, а подсказке нужен `title` на элементе подписи. */
function fieldWithTooltip(label: string, tooltip: string, control: HTMLElement): HTMLElement {
  const row = fieldRow({ label: label, control: control });
  const labelEl = row.querySelector('.ui-field-label');
  if (labelEl !== null) setTooltip(labelEl as HTMLElement, tooltip);
  return row;
}

/** Поле «Описание» редактора свойства: textarea, зеркалящая ввод в
 *  `draft.description` на каждый `input` (ошибка 9f579e69: без слушателя
 *  черновик хранил прежний текст, и «Применить и закрыть» уходил с пустым
 *  PATCH). Вынесено в функцию ради юнит-теста слушателя. */
export function buildDescriptionField(draft: PropertyDraft): HTMLElement {
  const descArea = fieldTextarea() as HTMLTextAreaElement;
  descArea.value = draft.description;
  descArea.rows = 3;
  descArea.placeholder =
    'Описание свойства: что оно значит и в каком формате значение (подсказка в редакторе мысли и для AI-агентов)';
  descArea.addEventListener('input', () => {
    draft.description = descArea.value;
  });
  return descArea;
}

// ---------------------------------------------------------------------------
// Основной диалог
// ---------------------------------------------------------------------------

/**
 * Ключ редактора ещё не созданного свойства (ошибка 74d9b4ed).
 *
 * Сеансовый ключ «новая сущность этого вида»: у свойства, которое ещё не
 * записано, id нет, но дедупликация нужна и ему — иначе повторный клик по
 * «Добавить» («Создать новый», «Создать свойство» в пикере) открывает второй
 * редактор создания с независимым черновиком. Один ключ на ВСЕ точки создания
 * нового свойства, даже из разных мест — второй вход поднимает уже открытый
 * редактор.
 */
const NEW_PROPERTY_DIALOG_KEY = 'property:new';

/**
 * Ключ дедупликации диалога редактора свойства (ошибки c2d243bb, 74d9b4ed).
 *
 * Идентичность сущности для {@link raiseOpenDialog}: повторное открытие
 * редактора ЭТОГО свойства (клик по строке списка «Свойства», по строке дерева
 * типов связей в «Типах связей», по строке журнала активности) поднимает уже
 * открытый диалог, а не создаёт второй черновик. Свойство другого id — другой
 * ключ, открывается поверх свободно.
 *
 * `id === null` (новое свойство) даёт сеансовый ключ
 * {@link NEW_PROPERTY_DIALOG_KEY}: пока редактор создания открыт, второго не
 * будет; после закрытия ключ снимается и следующее «Добавить» открывает свежий
 * редактор. Ключ остаётся на весь срок жизни диалога, в т.ч. после записи
 * (диалог закрывается только «Применить и закрыть»).
 */
export function propertyDialogKey(id: string | null): string {
  return id === null ? NEW_PROPERTY_DIALOG_KEY : `property:${id}`;
}

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
 *
 * Повторное открытие редактора того же свойства (двойной клик по строке списка
 * или дерева) второй диалог не создаёт: уже открытый поднимается наверх и
 * получает фокус ({@link raiseOpenDialog}, ошибка c2d243bb). Свойство другого
 * id открывается поверх свободно. То же — для ещё не созданного свойства: ключ
 * `property:new` один на все точки создания («Добавить» в менеджере, «Добавить»
 * в списке, «Создать свойство» в пикере, «Создать новый» в комбобоксе типа
 * связи), поэтому повторный вход поднимает уже открытый редактор создания
 * (ошибка 74d9b4ed).
 */
export function openPropertyManagerEditor(
  property: RegistryRow | null,
  onChanged: () => void,
  onCreated?: (row: NetworkProperty) => void,
  options: OpenEditorOptions = {},
): void {
  const networkId = requireNetworkId();
  // Повторное открытие редактора ТОГО ЖЕ свойства не создаёт второй диалог:
  // уже открытый поднимается наверх и получает фокус (ошибка c2d243bb). Клик по
  // строке списка/дерева — источник повторного события (двойной клик, клик по
  // уже открытому из журнала активности). Для НОВОГО свойства (id ещё нет) ключ
  // тоже есть — `property:new`, поэтому повторный клик по «Добавить»/«Создать
  // свойство» поднимает уже открытый редактор создания, а не плодит второй
  // черновик (ошибка 74d9b4ed). Проверка — ДО захвата блокировки и сборки тела
  // диалога.
  if (raiseOpenDialog(propertyDialogKey(property?.id ?? null))) return;
  // Server snapshot: starts at the row passed in, refreshed after a successful
  // apply, kept on a failed apply so a retry re-diffs against the same state.
  let current: RegistryRow | null = property;
  const errorLine = footerErrorLine();
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
  /**
   * Собственные привязки свойства на момент загрузки (id привязки + тип).
   * По нему на «Применить и закрыть» вычисляются снятые строки таблиц: ✕
   * убирает строку из черновика, а сервер узнаёт об этом `DELETE` при apply
   * (ошибка c83f0215 — снятие привязки молча не сохранялось).
   */
  let typeRowsSnapshot: Array<{ id: string; thoughtTypeId: string }> = [];

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
    defaultValueTarget: null,
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
    draft.defaultValueTarget = Array.isArray(property?.config?.default_value_target)
      ? [...(property?.config?.default_value_target as string[])]
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
  const valueTypeField = fieldRow({ label: 'Вид значения', control: typeSelect });
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
  // Поле вынесено в {@link buildDescriptionField}: textarea обязана зеркалить
  // ввод в draft.description — иначе PATCH уходит со старым описанием
  // (ошибка 9f579e69: «не сохраняется комментарий свойства»).
  body.append(fieldRow({ label: 'Описание', control: buildDescriptionField(draft) }));

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
    linkFlagsHost.append(
      checkboxRow({
        label: 'рисовать связь на карте по умолчанию',
        checked: draft.showOnMap,
        onChange: (checked) => {
          draft.showOnMap = checked;
        },
      }).row,
    );
    linkFlagsHost.append(
      checkboxRow({
        label: 'заполненная ссылка блокирует удаление цели',
        checked: draft.blocksTargetDeletion,
        onChange: (checked) => {
          draft.blocksTargetDeletion = checked;
        },
      }).row,
    );
  }

  function renderScalarBody(): void {
    mainBodyHost.append(sectionLabel('Скалярное свойство'));
    // Имя свойства
    const nameInput = fieldInput() as HTMLInputElement;
    nameInput.type = 'text';
    nameInput.value = draft.name;
    nameInput.maxLength = 200;
    nameInput.placeholder = 'Заголовок свойства (обязательно)';
    nameInput.addEventListener('input', () => {
      draft.name = nameInput.value;
      revalidateName();
    });
    mainBodyHost.append(fieldRow({ label: 'Имя свойства', control: nameInput }));

    // Две колонки: таблица «Типы мыслей» слева, опции/множественность справа.
    const typesHost = div('form-stack');
    const optionsHost = div('form-stack');
    buildTypeRowsTable(typesHost, /* isLink */ false, /* side */ null);
    const optionsBlock = buildScalarOptionsBlockImpl(draft);
    optionsHost.append(optionsBlock);

    const defaultsHost = div('form-stack');
    defaultsHost.append(
      fieldRow({ label: 'Значение по умолчанию', control: buildValueEditor({
        networkId,
        definition: scalarDefaultDefinition(draft),
        value: draft.defaultValue,
        save: async (next) => {
          draft.defaultValue = next;
          return true;
        },
        commitOn: 'change',
      }) }),
    );

    const grid = twoColumns(typesHost, optionsHost);
    mainBodyHost.append(grid, defaultsHost);
  }

  function renderLinkBody(): void {
    linkBodyHost.append(sectionLabel('Свойство-связь'));
    // Имена сторон + таблицы + родительский тип + оформление.
    const nameForwardInput = fieldInput() as HTMLInputElement;
    nameForwardInput.type = 'text';
    nameForwardInput.value = draft.nameForward;
    nameForwardInput.maxLength = 200;
    nameForwardInput.placeholder = 'От источника к назначению';
    nameForwardInput.addEventListener('input', () => {
      draft.nameForward = nameForwardInput.value;
    });
    const nameReverseInput = fieldInput() as HTMLInputElement;
    nameReverseInput.type = 'text';
    nameReverseInput.value = draft.nameReverse;
    nameReverseInput.maxLength = 200;
    nameReverseInput.placeholder = 'От назначения к источнику';
    nameReverseInput.addEventListener('input', () => {
      draft.nameReverse = nameReverseInput.value;
    });
    // Свойство-связь: name в реестре — одно из имён (см. требование ниже).
    // Колонка стороны — имя стороны, таблица типов, общий дефолт стороны
    // **сразу под своей таблицей** (задача 99312ffa; порядок частей —
    // linkSideColumnParts). Общий дефолт пересобирается при правке строк
    // таблиц: его отбор берётся из живого черновика противоположной таблицы.
    const leftTypesHost = div('form-stack');
    const rightTypesHost = div('form-stack');
    const sourceDefaultsHost = div('form-stack');
    const targetDefaultsHost = div('form-stack');
    const refreshCommonDefaults = (): void => {
      sourceDefaultsHost.replaceChildren(buildCommonSideDefaultField('source'));
      targetDefaultsHost.replaceChildren(buildCommonSideDefaultField('target'));
    };
    refreshCommonDefaults();
    buildTypeRowsTable(leftTypesHost, /* isLink */ true, /* side */ 'source', refreshCommonDefaults);
    buildTypeRowsTable(rightTypesHost, /* isLink */ true, /* side */ 'target', refreshCommonDefaults);
    const leftCol = div('form-stack');
    for (const part of linkSideColumnParts({
      nameField: fieldRow({ label: 'Имя в источнике', control: nameForwardInput }),
      tableHost: leftTypesHost,
      commonDefaultHost: sourceDefaultsHost,
    })) {
      leftCol.append(part);
    }
    const rightCol = div('form-stack');
    for (const part of linkSideColumnParts({
      nameField: fieldRow({ label: 'Имя в назначении', control: nameReverseInput }),
      tableHost: rightTypesHost,
      commonDefaultHost: targetDefaultsHost,
    })) {
      rightCol.append(part);
    }
    linkBodyHost.append(twoColumns(leftCol, rightCol));

    // Родительский тип связи + кнопка «Оформление»
    const parentRow = div('form-row type-editor-row');
    // Служебный корень иерархии — «Без родителя», не вариант: он не попадает
    // в каталог комбо, и без нормализации чип показал бы его сырой id.
    const linkTypeRootId = store.state.linkTypes.find((t) => t.is_root)?.id;
    const parentCombo = buildEntityCombo({
      networkId,
      kind: 'link-types',
      value: normalizeParentTypeId(draft.parentLinkTypeId, linkTypeRootId),
      placeholder: 'Без родителя',
      emptyLabel: 'Без родителя',
      onChange: (id) => {
        draft.parentLinkTypeId = id;
      },
    });
    const styleBtn = uiButton({
      label: 'Оформление…',
      role: 'secondary',
      size: 's',
      onClick: () => openLinkStyle(),
    });
    parentRow.append(parentCombo.root, styleBtn);
    linkBodyHost.append(fieldRow({ label: 'Родительский тип связи', control: parentRow }));

    // Имя в реестре для свойства-связи — копия `name_forward` (сервер
    // вычисляет `linkPropertyDisplayName`, см. заметку в shared).
    draft.name = draft.nameForward;
  }

  /**
   * Поле общего дефолта стороны свойства-связи (задача 99312ffa): единое
   * чип-поле целей «Значение по умолчанию для всех типов» сразу под своей
   * таблицей типов. `config.default_value` — общий дефолт источников,
   * `config.default_value_target` — назначений (0.8.2, ADR «дефолт свойства
   * живёт на привязке»). Отбор кандидатов — по типам противоположной таблицы
   * живого черновика (`commonSideDefaultSpec`, та же модель a6513df0, что у
   * строк таблиц); пусто — без ограничений. Пересобирается при правке строк
   * (`refreshCommonDefaults`), поэтому фильтр не отстаёт от черновика.
   */
  function buildCommonSideDefaultField(side: 'source' | 'target'): HTMLElement {
    const spec = commonSideDefaultSpec(draft.typeRows, side);
    const isSource = side === 'source';
    const picker = buildLinkValueEditor({
      networkId,
      definition: {
        config: {},
        required: false,
        allowed_opposite_type_ids: spec.allowedTypeIds,
      },
      values: defaultLinkValues(isSource ? draft.defaultValue : draft.defaultValueTarget),
      save: async (next) => {
        const payload = linkDefaultPayload(next);
        if (isSource) draft.defaultValue = payload;
        else draft.defaultValueTarget = payload;
        return true;
      },
    });
    return fieldWithTooltip(spec.label, spec.tooltip, picker);
  }

  // ---- Таблица «Типы мыслей» / «Источники» / «Назначения» --------------
  function buildTypeRowsTable(
    host: HTMLElement,
    isLink: boolean,
    side: 'source' | 'target' | null,
    onRowsChanged?: () => void,
  ): void {
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
      const reqCheck = choiceControl('checkbox', {
        checked: row.required,
        onChange: (checked) => {
          row.required = checked;
          row.dirty = true;
        },
      });
      reqCell.append(reqCheck);
      tr.append(reqCell);

      // Колонка «Значение по умолчанию» — редактор значения без режимов
      // (0.8.2, ADR «дефолт свойства живёт на привязке»): заполнено — дефолт
      // ЭТОЙ привязки (`setPropertyDefaultOverride` на apply), пусто — при
      // создании мысли действует общее значение соответствующей стороны
      // (подсказка в тултипе пустой ячейки). Свойство-связь — унифицированный
      // чип-пикер целей (инструкция a47947c8): отбор целей по типам
      // **противоположной** таблицы с раскрытием иерархии (раскрывает сам
      // редактор; пустая противоположная таблица — цели любые). Скаляр —
      // общий редактор значения.
      const dvCell = el('td');
      const defaultHost = div('prop-default-cell');
      if (isLink) {
        const oppositeIds = collectOppositeSideTypeIds(draft.typeRows, side);
        defaultHost.append(
          buildLinkValueEditor({
            networkId,
            definition: {
              config: {},
              required: false,
              // Источник ограничения — привязки противоположной стороны
              // (тот же контракт, что у `listTypeProperties` в редакторе
              // мысли): у ещё не сохранённого черновика таблицы —
              // единственный доступный снимок; после apply сервер отдаёт то
              // же через `allowed_opposite_type_ids`.
              allowed_opposite_type_ids: linkAllowedTypeIds(oppositeIds),
            },
            values: defaultLinkValues(row.defaultValue),
            save: async (next) => {
              row.defaultValue = linkDefaultPayload(next);
              row.dirty = true;
              return true;
            },
          }),
        );
      } else {
        defaultHost.append(
          buildValueEditor({
            networkId,
            definition: scalarDefaultDefinition(draft),
            value: row.defaultValue,
            save: async (next) => {
              row.defaultValue = next;
              row.dirty = true;
              return true;
            },
            commitOn: 'change',
          }),
        );
      }
      if (isEmptyDefault(row.defaultValue)) defaultHost.append(emptyDefaultHint());
      dvCell.append(defaultHost);
      tr.append(dvCell);

      // Удалить строку
      const actionCell = el('td');
      const rm = uiButton({
        label: '✕',
        role: 'secondary',
        size: 's',
        title: 'Снять привязку',
        onClick: () => removeRow(row),
      });
      actionCell.append(rm);
      tr.append(actionCell);
      return tr;
    }

    function removeRow(row: TypeRowDraft): void {
      draft.typeRows = draft.typeRows.filter((r) => r !== row);
      renderTable();
      // Противоположная таблица изменилась — общий дефолт пересобирает отбор
      // по её живому черновику (задача 99312ffa).
      onRowsChanged?.();
    }

    async function addRow(): Promise<void> {
      // Мультивыбор (ошибка e6d92dbf): общий пикер в режиме чек-листа —
      // отметки чек-боксами, применение кнопкой «Применить и закрыть»,
      // рядом «Отмена». Команды — иконками в одной строке с поиском
      // (ошибка bd8b78a0): «Отметить все»; «Очистить» (ластик) пикер
      // добавляет сам. Пустой поиск показывает полный список каталога.
      const title = isLink
        ? side === 'source'
          ? 'Типы источников'
          : 'Типы назначений'
        : 'Типы мыслей';
      const picked = await pickEntitiesModal({
        networkId,
        kind: 'thought-types',
        title,
        // Уже выбранные типы этой таблицы отмечены чек-боксами при открытии
        // диалога (ошибка 4e9ad1a0); применение ПЕРЕЗАПИСЫВАЕТ набор строк
        // стороны: снятые флажки убирают строки, отмеченные — добавляют,
        // нетронутые сохраняют настройки (ошибка a3828b28).
        currentIds: currentTypeRowIds(draft.typeRows, side),
        allowEmpty: false,
        applyLabel: t('actions.applyClose'),
        commands: (ctx) => [
          {
            icon: 'check-check',
            title: 'Отметить все',
            onClick: () => {
              for (const t of store.state.thoughtTypes) {
                if (!t.is_root) ctx.checked.add(t.id);
              }
              ctx.rerender();
            },
          },
        ],
      });
      if (picked === null) return;
      const next = applyPickedTypeRows(draft.typeRows, picked, side);
      draft.typeRows = next;
      renderTable();
      // Обе стороны общего дефолта зависят от строк обеих таблиц — отбор
      // пересобирается по живому черновику (задача 99312ffa).
      onRowsChanged?.();
    }

    host.append(
      uiButton({
        label: 'Добавить тип',
        role: 'secondary',
        size: 's',
        title: 'Добавить привязку свойства к типу мысли',
        onClick: () => void addRow(),
      }),
    );

    renderTable();
  }

  /** Загрузка строк таблицы привязок для существующего свойства: список
   *  типов мыслей сети + для каждого типа запрос `listTypeProperties`
   *  фильтрует по нашему `property_id`. Для свойства-связи — две стороны
   *  (`source`/`target`) согласно `type_properties.side`.
   *
   *  `listTypeProperties` отдаёт ЭФФЕКТИВНЫЙ (наследование-зависимый) список,
   *  поэтому строкой «своей» привязки считается только `inherited !== true`
   *  (ошибка c59bbd64). Без этого унаследованная привязка попадала в черновик
   *  по разу на КАЖДЫЙ тип-потомок с ОДНИМ И ТЕМ ЖЕ id привязки-предка: снимок
   *  получал дубли, а `applyTypeRows` слал повторный `DELETE` того же id —
   *  сервер отвечал `property <id> not found`, и запись переноса падала.
   *  Заодно «✕» такой фантомной строки отвязывал привязку ПРЕДКА, а не
   *  потомка. Наследование правится в редакторе ТИПА (вкладка «Свойства»),
   *  а не в таблицах сторон свойства.
   *
   *  Зеркальные записи (`mirrored`) пропускаются: у них нет физической
   *  привязки, к которой писался бы override. */
  async function loadTypeRowsFor(propertyId: string): Promise<void> {
    const types = store.state.thoughtTypes;
    if (types.length === 0) return;
    const collected: TypeRowDraft[] = [];
    const seenBindingIds = new Set<string>();
    await Promise.all(
      types.map(async (tt) => {
        try {
          const defs = await etn.types.listTypeProperties(networkId, 'thought_type', tt.id);
          for (const def of defs) {
            if (def.property_id !== propertyId) continue;
            // Эффективный список: наследованная привязка принадлежит предку.
            if (def.inherited === true) continue;
            if (def.mirrored === true) continue;
            // Одна физическая привязка — одна строка (защита от дубля id).
            if (seenBindingIds.has(def.id)) continue;
            seenBindingIds.add(def.id);
            // Колонка показывает СОБСТВЕННЫЙ дефолт привязки: пусто — при
            // создании мысли действует общее значение стороны (тултип
            // пустой ячейки), поэтому эффективный дефолт без override сюда
            // не подставляется.
            const ownDefault = def.overridden_here === true ? def.default_value ?? null : null;
            collected.push({
              id: def.id,
              thoughtTypeId: tt.id,
              required: def.required === true,
              defaultValue: ownDefault,
              side: (def.side ?? null) as 'source' | 'target' | null,
              dirty: false,
              initialDefaultValue: ownDefault,
            });
          }
        } catch {
          // пропускаем — частичный список всё равно полезен
        }
      }),
    );
    draft.typeRows = collected;
    // Снимок СОБСТВЕННЫХ привязок на момент загрузки — по нему на
    // «Применить и закрыть» вычисляются снятые строки (✕), которые надо
    // удалить на сервере (ошибка c83f0215).
    typeRowsSnapshot = collected.flatMap((row) =>
      row.id === null ? [] : [{ id: row.id, thoughtTypeId: row.thoughtTypeId }],
    );
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
      errorLine.show(
        'Сменить категорию (скаляр ↔ связь) нельзя: значения связи живут рёбрами, а не в таблице значений.',
      );
      return;
    }
    errorLine.clear();
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
      errorLine.show(DUP_NAME_MSG);
      if (applyBtn !== null) applyBtn.disabled = true;
    } else {
      if (errorLine.textContent === DUP_NAME_MSG) errorLine.clear();
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
        errorLine.show('Укажите имена обеих сторон.');
        return;
      }
    } else if (draft.name.trim() === '') {
      errorLine.show('Название свойства обязательно.');
      return;
    }
    const name = draft.valueType === 'link' ? draft.nameForward.trim() : draft.name.trim();
    if (nameClash(name) !== null) {
      errorLine.show(DUP_NAME_MSG);
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
        // Сбор PATCH-тела вынесен в чистую функцию {@link buildUpdateChanges}
        // (регрессионный тест property-manager-apply.test.ts).
        const changes = buildUpdateChanges(draft, current);
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
        // Ответ сервера — САМО свойство, дополненное счётчиками конверсии
        // (`{ ...property, converted, dropped }`), а не обёртка
        // `{ property, converted, dropped }`: раньше здесь читалось
        // `result.property`, из-за чего `current` терял `id`, а следующая
        // запись привязок уходила с `property_id: undefined` и падала 422
        // (ошибка c83f0215). Счётчики читаются с того же плоского объекта.
        current = {
          ...result,
          types_count: current.types_count,
          values_count: current.values_count,
        };
        // Правка самого свойства реестра — имя, вид значения, `config`
        // (в т.ч. списки допустимых типов свойства-связи) — меняет таблицу
        // «Свойства» у ВСЕХ типов, где оно показано, а не только у привязок
        // этого диалога (ошибка 98aa0889). Редактор находит владельца по id
        // свойства в индексе показанных определений.
        notifyPropertyRegistryChanged(current.id, changes);
        if (changes.value_type !== undefined) {
          notice(
            result.dropped > 0 || result.converted > 0
              ? `Обработка выполнена: преобразовано ${result.converted}, удалено ${result.dropped}.`
              : 'Обработка выполнена.',
          );
        }
        // Родительский тип связи (ошибка d56c1ae4): PATCH /properties его не
        // принимает — иерархия правится отдельным PATCH /link-types/{id}.
        const parentChanged = await syncLinkTypeParent(networkId, current, draft);
        // Тип связи свойства-связи — часть единого жизненного цикла (0.8.1):
        // PATCH /properties применил пару имён и оформление линии к связанному
        // `link_type`, а родителя — `syncLinkTypeParent` строкой выше. Открытый
        // редактор показанной СВЯЗИ этого типа обязан перерисовать шапку —
        // ошибка 7dfad7d4 (симметрично правке самого типа, 5d41589). Своё
        // realtime-эхо до рендерера не доходит (G8 applier), поэтому уведомляем
        // локально, а каталог типов перечитываем ДО уведомления: шапка
        // резолвит подпись и вид линии из него.
        const linkTypeFields = linkTypeFieldsFromPropertyChanges(changes);
        if (parentChanged) linkTypeFields.parent_id = draft.parentLinkTypeId;
        const linkTypeId = current.config?.link_type_id;
        if (
          Object.keys(linkTypeFields).length > 0 &&
          typeof linkTypeId === 'string' &&
          linkTypeId !== ''
        ) {
          await reloadTypeCatalogues();
          notifyTypeChanged(
            typeUpdateFacts({ ownerType: 'link_type', ownerId: linkTypeId }, linkTypeFields),
          );
          // Холст и панели («Структуры», «Хроника») рисуют подпись и вид линии
          // ребра из каталога типов, а свои страницы держат в собственных
          // снимках — локальная правка типа связи доводится до них ТЕМ ЖЕ
          // набором пересчёта, что и realtime-эхо (ошибка 270b8454). Каталог уже
          // перечитан строкой выше, поэтому пересчёт не перезапрашивает его
          // повторно.
          scheduleTypeRepaint();
        }
        // Применим привязки к типам мыслей.
        await applyTypeRows(current.id);
      }
      onChanged();
      close();
    } catch (err) {
      errorLine.show(errText(err));
    }
  }

  /** Сохранение строк таблицы привязок. На входе — черновик; на выходе —
   *  строки применены через `etn.types.createTypeProperty/updateTypeProperty`.
   *  Дефолты привязок пишутся отдельными `etn.types.setPropertyDefaultOverride`
   *  (0.8.2, ADR «дефолт свойства живёт на привязке»): чистой функцией
   *  {@link collectDefaultOverrideOps} отбираются только реально изменившиеся
   *  значения, а для добавленных строк — заполненный дефолт сразу после
   *  создания привязки. Общие значения сторон уезжают в `PATCH /properties`
   *  (тело собирает {@link buildUpdateChanges}). */
  async function applyTypeRows(propertyId: string): Promise<void> {
    // Снятые строки: есть в снимке загрузки, нет в черновике (✕ в таблице).
    // Перенос типа между сторонами — это снятие привязки одной стороны плюс
    // создание другой; без этих `DELETE` снятие терялось (ошибка c83f0215).
    // Один id привязки удаляется РОВНО один раз: повторный `DELETE` уже
    // снятого id сервер отвечает `property <id> not found` (ошибка c59bbd64).
    const survivingIds = new Set(
      draft.typeRows.flatMap((row) => (row.id === null ? [] : [row.id])),
    );
    const removedIds = new Set<string>();
    const removed: Array<{ id: string; thoughtTypeId: string }> = [];
    for (const snap of typeRowsSnapshot) {
      if (survivingIds.has(snap.id) || removedIds.has(snap.id)) continue;
      removedIds.add(snap.id);
      removed.push(snap);
    }
    if (draft.typeRows.length === 0 && removed.length === 0) return;
    // Типы, чей набор свойств правится этим проходом (снятые и черновые
    // строки) — после записи они обязаны уведомить открытый редактор
    // (ошибка 74b94c26): свой realtime-эхо до рендерера не доходит.
    const touchedTypeIds = new Set<string>();
    for (const snap of removed) touchedTypeIds.add(snap.thoughtTypeId);
    for (const row of draft.typeRows) touchedTypeIds.add(row.thoughtTypeId);
    // Снятия — первыми: освобождённая пара (тип, сторона) не должна
    // столкнуться с созданием новой привязки в этом же проходе.
    for (const snap of removed) {
      await etn.types.removeTypeProperty(
        networkId,
        'thought_type',
        snap.thoughtTypeId,
        snap.id,
      );
      typeRowsSnapshot = typeRowsSnapshot.filter((s) => s.id !== snap.id);
    }
    const isLink = draft.valueType === 'link';
    const overrideByRow = new Map(
      collectDefaultOverrideOps(draft.typeRows, isLink).map((op) => [op.row, op.value] as const),
    );
    const ops: Promise<unknown>[] = [];
    for (const row of draft.typeRows) {
      if (row.id === null) {
        // Создание собственной привязки; её дефолт (если задан) пишется
        // вторым вызовом — id привязки известен только после создания.
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
            const value = overrideByRow.get(row);
            if (value !== undefined) {
              await etn.types.setPropertyDefaultOverride(
                networkId,
                'thought_type',
                row.thoughtTypeId,
                def.id,
                value,
              );
            }
          })(),
        );
      } else if (row.dirty || overrideByRow.has(row)) {
        ops.push(
          (async (): Promise<void> => {
            await etn.types.updateTypeProperty(
              networkId,
              'thought_type',
              row.thoughtTypeId,
              row.id as string,
              { required: row.required },
            );
            const value = overrideByRow.get(row);
            if (value !== undefined) {
              await etn.types.setPropertyDefaultOverride(
                networkId,
                'thought_type',
                row.thoughtTypeId,
                row.id as string,
                value,
              );
            }
          })(),
        );
      }
    }
    await Promise.all(ops);
    for (const thoughtTypeId of touchedTypeIds) {
      notifyTypeDefinitionsChanged({ ownerType: 'thought_type', ownerId: thoughtTypeId });
    }
  }

  showDialog({
    title: property === null ? 'Новое свойство' : `Свойство — «${property.name}»`,
    body,
    size: 'xl',
    // Идентичность сущности для повторного открытия (ошибки c2d243bb,
    // 74d9b4ed): клик по этому же свойству — или по «Добавить» при ещё не
    // созданном свойстве (`property:new`) — поднимает уже открытый диалог, а
    // не плодит второй. Ключ живёт до закрытия диалога.
    dedupeKey: propertyDialogKey(property?.id ?? null),
    // Строка ошибки записи — в панели кнопок диалога: она обязана быть видна
    // всегда (ошибка c83f0215 — осиротевшая строка в теле молча глотала
    // ошибки записи; приём и требование — ошибка add8d09d).
    footerError: errorLine,
    buttons: [
      { label: t('actions.cancel') },
      {
        label: t('actions.applyClose'),
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

/**
 * Собирает тело `PATCH /networks/{nid}/properties/{id}` из черновика
 * (ошибка 9f579e69: тело собиралось инлайн в `apply`, что не давало
 * регрессионного теста; вынос ничего не меняет, кроме читаемости).
 *
 * Для свойства-связи включает имена сторон и оформление — их принимает
 * серверный PATCH (единый жизненный цикл, 0.8.1) и применяет к связанному
 * типу связи. `name` для связи вычисляется из `name_forward` (сервер
 * пересчитывает отображаемое имя из link_type).
 */
export function buildUpdateChanges(
  draft: PropertyDraft,
  current: RegistryRow,
): NetworkPropertyUpdateInput {
  const name = draft.valueType === 'link' ? draft.nameForward.trim() : draft.name.trim();
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
  return changes;
}

/**
 * Ключи `config` свойства-связи, которые собираются из полей единого диалога
 * «Свойство / связь». Всё остальное (`allowed_target_type_ids`,
 * `allowed_source_type_ids`, legacy-маркер `multiple` и любые произвольные
 * ключи, заданные через MCP/онтологию) диалог не редактирует и обязан
 * переносить без изменений: серверный `PATCH /properties/{id}` заменяет
 * `config` целиком (`updateNetworkProperty`: `finalConfig = changes.config`),
 * поэтому иначе любое сохранение стирало бы их (ошибка a13b3845).
 */
const LINK_CONFIG_MANAGED_KEYS: ReadonlySet<string> = new Set([
  'link_type_id',
  'structural',
  'direction',
  'show_on_map',
  'blocks_target_deletion',
  'default_value',
  'default_value_target',
]);

/** Конфиг свойства-связи из черновика. Никогда не `null` — сервер требует
 *  `direction` для ссылки. */
function linkConfigFromDraft(draft: PropertyDraft, current?: PropertyConfig | null): PropertyConfig | null {
  if (draft.valueType !== 'link') return null;
  // Сначала переносим из текущего конфига всё, чем диалог не управляет
  // (round-trip: ограничения типов, legacy-флаги, произвольные доп. ключи).
  // Порядок важен: управляемые ключи перезаписывают одноимённые ниже —
  // иначе, например, снятый флаг `show_on_map` не удалился бы.
  const cfg: PropertyConfig = {};
  if (current != null) {
    for (const [key, value] of Object.entries(current)) {
      if (value === undefined || LINK_CONFIG_MANAGED_KEYS.has(key)) continue;
      cfg[key] = value;
    }
  }
  // Для уже существующего свойства — сохраняем `link_type_id`/`structural`
  // из текущего конфига (они задаются на create и не вычисляются из draft).
  // Без этого PATCH отклоняется сервером: VALIDATION_ERROR «свойство-связь
  // требует config.link_type_id» (баг cab38479-фикс2). Для нового — сервер
  // создаст link_type автоматически (задача dd37a66) по паре имён сторон,
  // и `config.link_type_id` придёт в ответе на create.
  if (current?.link_type_id !== undefined && current.link_type_id !== '') {
    cfg.link_type_id = current.link_type_id;
  }
  if (current?.structural === true) {
    cfg.structural = true;
  }
  cfg.direction = 'out';
  if (draft.showOnMap) cfg.show_on_map = true;
  if (draft.blocksTargetDeletion) cfg.blocks_target_deletion = true;
  // Общие значения сторон (0.8.2, ADR «дефолт свойства живёт на привязке»):
  // «Значение по умолчанию для всех типов» под «Типами источников» —
  // `config.default_value`, под «Типами назначений» — `config.default_value_target`.
  // Пусто — ключ не пишется (PATCH config заменяет конфиг целиком, поэтому
  // очистка поля снимает общее значение).
  const sources = linkDefaultPayload(draft.defaultValue);
  if (sources !== null) cfg.default_value = [...new Set(sources)];
  const targets = linkDefaultPayload(draft.defaultValueTarget);
  if (targets !== null) cfg.default_value_target = [...new Set(targets)];
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
  // Сравнения вида значения — данные конфигурации, не построение поля ввода
  // (диспетчер по виду значения живёт только в общем редакторе, S2).
  const isLink = valueType === 'link';
  const isText = valueType === 'text';
  if (isLink) {
    const config: PropertyConfig = { direction: link.direction };
    if (link.structural) {
      config.structural = true;
    } else if (link.linkTypeId !== null) {
      config.link_type_id = link.linkTypeId;
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
  if (isText && options.choiceOn) {
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

/** Пусто ли значение колонки «Значение по умолчанию» (0.8.2): `null`,
 *  `undefined`, пустая строка или пустой набор целей. Пустое значение —
 *  «действует общее значение стороны привязки». Чистая — юнит-тест. */
export function isEmptyDefault(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Подпись пустой ячейки «Значение по умолчанию» (0.8.2): при создании мысли
 *  берётся общее значение соответствующей стороны привязки. Общая для обоих
 *  редакторов (диалог свойства и вкладка «Свойства» редактора типа). */
export function emptyDefaultHint(): HTMLElement {
  const hint = span('—', 'muted prop-default-hint');
  setTooltip(hint, 'Пусто — при создании мысли используется общее значение стороны привязки.');
  return hint;
}

/**
 * Значение по умолчанию свойства-связи как рёбра редактора: черновик хранит
 * набор id целей (`string[] | null`), общий редактор значения-связи работает
 * с формой `LinkPropertyValueItem[]` (подписи догружаются резолвом).
 */
export function defaultLinkValues(value: unknown): LinkPropertyValueItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .map((id) => ({
      link_id: '',
      target_id: id,
      target_title: null,
      target_type_id: null,
      comment: null,
    }));
}

/**
 * Заглушка определения свойства для поля «Значение по умолчанию» черновика
 * (свойство ещё не существует — определения нет): редактору значения нужны
 * только вид, `config.options` (текстовые варианты из текста черновика) и
 * `config.multiple` (чип-ввод нескольких значений, веха 4).
 */
function scalarDefaultDefinition(draft: PropertyDraft): EffectiveTypeProperty {
  const options =
    draft.valueType === 'text' && draft.choiceOn
      ? draft.optionsText
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
  const config: PropertyConfig = {};
  if (options.length > 0) config.options = options;
  if (draft.multipleOn) config.multiple = true;
  return {
    id: '',
    property_id: '',
    owner_type: 'thought_type',
    owner_id: '',
    key: 'default',
    value_type: draft.scalarKind ?? 'text',
    config: Object.keys(config).length > 0 ? config : null,
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
}

/**
 * Блок «Выбирать из списка» + «Несколько значений» для скалярной ветки
 * редактора свойства (ошибка 322a2694: прежний обработчик флажка вызывал
 * `renderScalarBody`, и каждый клик дописывал в `mainBodyHost` ещё одну
 * копию секции «Скалярное свойство»).
 *
 * Поле вариантов живёт в DOM всё время; видимость — производная от
 * флажка «выбирать из списка». Тоггл `display` решает задачу без перерисовки:
 * черновик (`draft.optionsText`) не теряется, фокус в соседних полях (имя,
 * флажок «несколько значений») не сбрасывается. Работает по `draft`
 * (поля `choiceOn`/`optionsText`/`multipleOn`) и общим `el/div/span/button`
 * из `dom.js` — экспортируется для юнит-теста сценария пользователя
 * (включение/выключение флажка, многократные переключения, сохранение
 * черновика).
 */
export function buildScalarOptionsBlockImpl(draft: PropertyDraft): HTMLElement {
  const host = div('form-stack');
  const area = fieldTextarea({ extraClass: 'prop-options-area' }) as HTMLTextAreaElement;
  area.value = draft.optionsText;
  area.rows = 4;
  area.placeholder = 'Варианты значения — по одному в строке';
  area.style.display = draft.choiceOn ? '' : 'none';
  area.addEventListener('input', () => {
    draft.optionsText = area.value;
  });
  host.append(
    checkboxRow({
      label: 'выбирать из списка',
      checked: draft.choiceOn,
      onChange: (checked) => {
        draft.choiceOn = checked;
        area.style.display = checked ? '' : 'none';
      },
    }).row,
    area,
  );
  host.append(
    checkboxRow({
      label: 'несколько значений',
      checked: draft.multipleOn,
      onChange: (checked) => {
        draft.multipleOn = checked;
      },
    }).row,
  );
  return host;
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
  tableWrap.append(loadingState());
  host.append(tableWrap);

  const counts = span('', 'muted');
  counts.style.margin = '4px 0 0';
  host.append(counts);

  async function reload(): Promise<void> {
    try {
      const usage: PropertyUsage = await etn.propertyRegistry.usage(networkId, propertyId);
      renderUsage(usage);
    } catch (err) {
      tableWrap.replaceChildren(operationError(err));
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
      const link = uiButton({
        label: b.owner_name,
        size: 's',
        class: 'link-btn',
        title: 'Открыть тип',
        onClick: () => openTypeEditorByUsage(b),
      });
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

/** Узел дерева типов связей для общего компонента `lib/ui/tree`. */
interface LinkTypeTreeItem extends TreeItem {
  type: LinkType;
  /** Свойство-связь типа (`config.link_type_id`) или `undefined`, если его нет. */
  prop: RegistryRow | undefined;
}

/** Строки дерева типов связей из каталога (данные `orderedTypeRows`). */
function linkTypeTreeItems(
  types: readonly LinkType[],
  propertyByLinkTypeId: ReadonlyMap<string, RegistryRow>,
): LinkTypeTreeItem[] {
  return orderedTypeRows(types).map((row) => ({
    id: row.type.id,
    parentId: row.type.parent_id,
    hasChildren: row.hasChildren,
    filterText: `${row.type.name_forward} ${row.type.name_reverse}`,
    type: row.type,
    prop: propertyByLinkTypeId.get(row.type.id),
  }));
}

export function showLinkTypesTreeDialog(): void {
  const networkId = requireNetworkId();
  const errorLine = footerErrorLine();
  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '340px';
  const body = div('form-stack');

  const toolbar = div('form-row type-list-toolbar');
  const searchInput = fieldInput() as HTMLInputElement;
  searchInput.type = 'text';
  searchInput.placeholder = t('actions.search');
  toolbar.append(
    // «Добавить» создаёт свойство-связь. `value_type` пользователь выбирает
    // в форме; пары `name_forward`/`name_reverse` заполняет там же.
    uiButton({
      label: 'Добавить',
      role: 'secondary',
      size: 's',
      title: 'Создать свойство-связь',
      onClick: () => openPropertyManagerEditor(null, onChanged),
    }),
    searchInput,
  );

  // Состояние загрузки/ошибки живёт рядом с деревом: сам список рисует общий
  // компонент `lib/ui/tree.ts`, статус скрывает его на время запроса.
  const status = div('muted hidden');
  let searchQuery = '';
  let cachedTypes: LinkType[] | null = null;
  let cachedRows: RegistryRow[] | null = null;
  let cachedCounts: Record<string, number> | null = null;
  // Текущий каталог типов связей — читается рендером строк.
  let currentTypes: readonly LinkType[] = [];
  let expansionInitialized = false;

  const onChanged = (): void => {
    cachedRows = null;
    cachedCounts = null;
    void reload();
  };

  // Единое дерево списков (задача d1c15a2d, требование 0086037c): каретка,
  // отступ, колонки и клавиатура — его; экран задаёт данные, свотч линии и
  // действие строки.
  let currentItems: LinkTypeTreeItem[] = [];
  const tree = createTree<LinkTypeTreeItem>({
    items: () => currentItems,
    ariaLabel: t('linkTypes.title'),
    treeColumnHeader: t('linkTypes.col.name'),
    emptyText: t('linkTypes.empty'),
    emptyHint: t('linkTypes.emptyHint'),
    rowClass: (item) => (item.type.is_root ? 'type-tree-root' : undefined),
    onActivate: (item) => {
      if (item.prop !== undefined) openPropertyManagerEditor(item.prop, onChanged);
    },
    columns: [
      {
        key: 'connected',
        header: t('linkTypes.col.connected'),
        width: '9rem',
        align: 'end',
        render: (item) => {
          // Колонка «Подключено к типам» — сумма обоих сторон свойства-связи
          // (если оно зарегистрировано). Нет свойства — 0; это «голый» тип
          // связи, создать рёбра через который нельзя (`etn.links.create` снят
          // в 0.8.1).
          const total =
            item.prop !== undefined
              ? (item.prop.types_source_count ?? 0) + (item.prop.types_target_count ?? 0)
              : 0;
          const cell = span(String(total), item.prop === undefined ? 'muted prop-count-side' : '');
          if (item.prop === undefined) {
            setTooltip(
              cell,
              'Для этого типа связи ещё нет свойства в реестре. Тип связи без свойства бесполезен — создайте свойство через «Добавить».',
            );
          }
          return cell;
        },
      },
      {
        key: 'actions',
        render: (item) =>
          // Удаления в этом диалоге нет — пользовательский путь лежит через
          // плоский список «Свойства и связи», где видно
          // `links_becoming_structural` и подтверждение по числу рёбер
          // (требование 09f692ff).
          item.prop === undefined
            ? span(t('linkTypes.noProperty'), 'muted prop-count-side')
            : span(''),
      },
    ],
    renderContent: (item) => {
      const type = item.type;
      const resolved = resolveLinkTypeVisual(currentTypes, type.id);
      const swatch = span('', 'link-type-swatch');
      swatch.style.borderTop = `${Math.max(1, Math.min(6, resolved.width ?? 2))}px ${
        resolved.style ?? 'solid'
      } ${resolved.color ?? '#9aa3b2'}`;
      swatch.style.display = 'inline-block';
      swatch.style.width = '32px';
      swatch.style.marginRight = '8px';
      swatch.style.verticalAlign = 'middle';
      return [swatch, span(` ${type.name_forward} / ${type.name_reverse}`)];
    },
  });
  tableWrap.append(status, tree.root);
  body.append(toolbar, tableWrap);

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
      status.replaceChildren(el('span', 'muted', t('common.loading')));
      status.classList.remove('hidden');
      tree.root.classList.add('hidden');
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
        status.replaceChildren(operationError(err));
        return;
      }
      cachedTypes = types;
      cachedRows = rows;
      cachedCounts = counts;
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
    currentTypes = types;
    // L21: корневой тип связи раскрыт, остальные свёрнуты.
    if (!expansionInitialized) {
      tree.collapseAll(types.filter((t) => t.is_root).map((t) => t.id));
      expansionInitialized = true;
    }
    currentItems = linkTypeTreeItems(types, propertyByLinkTypeId);
    status.classList.add('hidden');
    tree.root.classList.remove('hidden');
    tree.setFilter(searchQuery);
    tree.setItems(currentItems);
    tableWrap.scrollTop = scrollTop;
  }

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    // Фильтр и автораскрытие ветвей — состояние общего компонента.
    tree.setFilter(searchQuery);
  });

  showDialog({
    title: t('linkTypes.title'),
    body,
    size: 'm',
    // Ошибки списка — в панели кнопок (требование 397c5a56).
    footerError: errorLine,
    buttons: [{ label: t('actions.close'), primary: true }],
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
