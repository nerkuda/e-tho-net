/**
 * Editor tab «Свойства» (задача 8ab775d9, тех.проект a94998c6 — единая модель
 * связей). Две сворачиваемые группы:
 *  - «Свойства типа» (развёрнута по умолчанию) — таблица редактирования
 *    значений всех типов из определений свойств типа владельца;
 *  - «Свойства вне типа» (свёрнута по умолчанию) — значения, чьё свойство
 *    не подключено к типу владельца (0.6.5): скаляры read-only, свойства-связи
 *    (0.8.1, dfaacb05) — редактор для реестровых свойств и read-only чипи для
 *    рёбер типов связей без свойства в реестре.
 *
 * Значения пишутся через `etn.properties.set` / `remove`; realtime
 * `property-value.*` события перезагружают таблицу (модульный слушатель).
 *
 * Поля ввода значений строит ТОЛЬКО общий редактор `editor/value-editor.ts`
 * (ADR «значение свойства вводит один компонент…», стандарт S2, задача
 * 77e7cafd вехи 4): этот модуль готовит значение/определение и обёртку
 * сохранения, а свитча по виду значения здесь нет. История последних
 * значений (recent-values.ts) подключается редактором по `historyPropertyId`
 * — для строк, URL и свойств-связей, включая множественные (требование
 * f6399882, ошибка 880c3add).
 */

import type {
  CrossNetworkRefValue,
  EffectiveTypeProperty,
  LinkPropertySide,
  LinkPropertyValues,
  PropertyConfig,
  PropertyValue,
  PropertyValueType,
  ThoughtPropertiesReorderedItem,
  ThoughtPropertyOrderInput,
  ThoughtRef,
} from '@etn/shared';

import { inFocusNeighbourhood } from '../lib/focus-neighbourhood.js';
import { queryKeys } from '../lib/live/query-keys.js';
import { invalidateAfterMutation } from '../lib/live/mutator.js';
import {
  asRealtimeCause,
  onQueryInvalidated,
  signalPublicationCompositionChanged,
  type RealtimeCause,
} from '../lib/live/index.js';
import {
  div,
  el,
  errText,
  isConnectionLostError,
  setTooltip,
  span,
} from '../lib/dom.js';
import { errorParagraph, footerErrorLine } from '../lib/ui/messages.js';
import { errorDialog, showDialog } from '../lib/dialog.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { notice } from '../lib/notice.js';
import { PROPERTY_VALUES_REFRESHED_EVENT } from '../lib/property-values-refresh.js';
import { showMenuAt } from '../lib/menu.js';
import { logUiEvent } from '../lib/ui-log.js';
import { requireNetworkId } from '../app.js';
import { isTypeDeleted, rememberShownDefinitions } from '../lib/type-definitions.js';
import { onReconnected, store } from '../state.js';
import {
  invalidateGraphTab,
  registerTabContent,
  registerTabRetarget,
  type EditorContext,
  type TabPaneLifecycle,
} from './editor.js';
import { groupSection } from './group.js';
import { removeLinkValueEdges, type LinkValueRemovalMode } from './link-value-removal.js';
import {
  propertyRowMenuItems,
  type PropertyRowMenuActions,
  type PropertyRowMenuState,
} from './property-row-menu.js';
import { applyTabGroupClamp } from './list-heights.js';
import { rowSplitter } from './splitter.js';
import { iconButton, uiButton } from '../lib/ui/button.js';
import { svgIcon } from '../lib/ui/icon.js';
import { reconcileKeyed, type KeyedRenderSpec } from '../lib/ui/keyed-list.js';
import { createListNav, type ListNavHandle } from '../lib/ui/list.js';
import { isEditingTarget } from '../lib/ui/nav-core.js';
import { createRowReorder, type RowReorderHandle } from '../lib/row-reorder.js';
import { deepEqual } from '../lib/ui/state.js';
import {
  buildPropertyList,
  buildPropertyListRows,
  buildPropertyValueMark,
  ensurePropertyLinkTypes,
  type PropertyListRow,
  type PropertyRegistryRow,
} from '../lib/property-list.js';
import { openPropertyManagerEditor } from '../screens/property-manager.js';
import { resolveLinkTypeVisual } from '../lib/type-tree.js';
import { registryAllowedOppositeTypeIds } from '../lib/link-binding-types.js';
import {
  buildOutsideReadonlyEdgeChip,
  buildValueEditor,
  splitMultiValue,
} from './value-editor.js';

/** Reload callback of the currently mounted properties table (or null). */
let currentReload: (() => void) | null = null;
/**
 * Фиксация недописанных значений (набранный без Enter текст) открытых
 * редакторов показанной таблицы «Свойства типа» (или null). Вызывается перед
 * пересборкой строк, сворачиванием группы и закрытием карточки: снятый с
 * документа сфокусированный узел `blur` не получает (ошибка bfe1bc24).
 */
let currentFlush: (() => void) | null = null;
/** То же для тела группы «Свойства вне типа» (или null, если не построено). */
let outsideFlush: (() => void) | null = null;

/**
 * Владелец, под которого построена показанная вкладка «Свойства» (задача
 * 90b2256e, круг 1). Мутируемый: при смене сущности того же типа редактор
 * переиспользует панель и перечитывает её содержимое под нового владельца —
 * главная таблица обновляет СТРОКИ через `reconcileKeyed`, не пересобирая
 * таблицу.
 */
interface PropertiesTarget {
  ownerType: 'thought' | 'link';
  ownerId: string;
  typeId: string | null;
  /**
   * Есть ли у владельца СОБСТВЕННЫЙ живой тип. `typeId` — эффективный тип
   * вкладки: для владельца без типа он подставляет корневой «основной тип»
   * (его настройки действуют на всех нетипизированных), поэтому проверка
   * `typeId !== null` не отличает нетипизированного владельца от типизированного.
   * Меню строки вне типа («Перенести в типовые свойства») спрашивает это поле.
   */
  hasOwnType: boolean;
}

/** Перепривязка показанной вкладки «Свойства» к другому владельцу (или null). */
let retargetCurrent: ((ctx: EditorContext) => void) | null = null;
/** Перечитывание тела группы «Свойства вне типа» (или null, если не построено). */
let outsideReload: (() => void) | null = null;
let wired = false;
/** Перечитывание счётчика группы «Свойства вне типа» (или null). */
let outsideRefreshCount: (() => void) | null = null;
/** Владелец, под которого построена текущая вкладка «Свойства» (или null). */
let currentTarget: PropertiesTarget | null = null;

/**
 * Выбранное в пикере, но ещё не записанное внетиповое свойство (0.14.1,
 * задача 626b29bd, сценарии 9aea535d/1c0d0192): строка появляется в группе
 * «Свойства вне типа» сразу после выбора, с пустым редактором значения, и
 * исчезает из локального набора, как только значение появилось на сервере.
 * Хранится по владельцу: карточка того же типа переиспользует панель, и
 * черновики не должны переезжать на другую сущность (задача 90b2256e).
 */
interface PendingOutsideProperty {
  propertyId: string;
  /** Снимок реестровой строки — из него собирается определение свойства. */
  property: PropertyRegistryRow;
  /** Отображаемое имя строки: у связи — имя выбранной стороны. */
  name: string;
  side: LinkPropertySide | null;
  linkTypeId: string | null;
  /** Поставить курсор в редактор значения при следующей отрисовке. */
  focus: boolean;
}

const pendingOutside = new Map<string, PendingOutsideProperty[]>();

/** Ключ владельца значения (`ownerType:ownerId`) — для черновиков и dirty-меток. */
function ownerKey(ownerType: 'thought' | 'link', ownerId: string): string {
  return `${ownerType}:${ownerId}`;
}

/**
 * Потребители значений владельца на вкладке «Свойства». У каждого СВОЁ чтение
 * и, значит, своя dirty-метка: успех одного (например, типовой таблицы) не
 * доказывает, что другой (внетиповая таблица, счётчик группы) прочитал данные —
 * его чтение могло отказать в том же показе (замечание верификатора к
 * 9667b75c, круг 4).
 */
type ValueConsumer = 'typed' | 'outside' | 'outsideCount';

const VALUE_CONSUMERS: readonly ValueConsumer[] = ['typed', 'outside', 'outsideCount'];

/**
 * Владельцы, чьи значения изменились, пока вкладка «Свойства» их не
 * показывала: панель скрыта (другая вкладка активна) или показывает другого
 * владельца. Событие `property-value.set/deleted` адресуется по
 * `evt.data.owner_id`, а не «показанному» владельцу, поэтому скрытая панель
 * помечает владельца и перечитывает его при следующем показе (ошибка
 * 9667b75c: возврат на вкладку показывал устаревшее значение).
 *
 * Метка хранится НА ПОТРЕБИТЕЛЯ и снимается успехом СВОЕГО чтения: типовая
 * таблица снимает `typed` после чтения значений, тело «Свойства вне типа» —
 * `outside`, счётчик группы — `outsideCount`. Общая метка позволяла успеху
 * одной таблицы скрыть отказ другой: при повторном показе внетиповая строка
 * оставалась с `operationError` до пересборки группы/смены мысли (там же).
 * Набор живёт не дольше вкладки: вытеснение панели его очищает, новая сборка
 * читает данные сама.
 */
const dirtyValueOwners = new Map<string, Set<ValueConsumer>>();

/** Пометить всех потребителей владельца: значение изменилось не на экране. */
function markValueOwnerDirty(ownerType: 'thought' | 'link', ownerId: string): void {
  const key = ownerKey(ownerType, ownerId);
  const consumers = dirtyValueOwners.get(key);
  if (consumers === undefined) {
    dirtyValueOwners.set(key, new Set(VALUE_CONSUMERS));
    return;
  }
  for (const consumer of VALUE_CONSUMERS) consumers.add(consumer);
}

/** Есть ли у потребителя непрочитанное изменение владельца. */
function isValueOwnerDirty(
  ownerType: 'thought' | 'link',
  ownerId: string,
  consumer: ValueConsumer,
): boolean {
  return dirtyValueOwners.get(ownerKey(ownerType, ownerId))?.has(consumer) ?? false;
}

/** Снять метку потребителя после УСПЕШНОГО чтения его данных. */
function clearValueOwnerDirty(
  ownerType: 'thought' | 'link',
  ownerId: string,
  consumer: ValueConsumer,
): void {
  const key = ownerKey(ownerType, ownerId);
  const consumers = dirtyValueOwners.get(key);
  if (consumers === undefined) return;
  consumers.delete(consumer);
  if (consumers.size === 0) dirtyValueOwners.delete(key);
}

/**
 * Поколение чтения значений владельца (ошибка da7bbb53, круг 2).
 *
 * Ответ `properties.get` — актуальный снимок, только если чтение ЗАПРОШЕНО в
 * текущем поколении владельца. Границу двигает всё, что клиент узнал как
 * изменение данных: применённое data-событие realtime (роутер не присылает
 * эфемерные `presence.*`/`edit.*` — они данные не меняют), своя мутация
 * значения и локальный канал правок с карты/из редактора. Ответ, начатый до
 * границы, — прежний снимок: панель его НЕ применяет и метку «владелец изменён
 * не на экране» не снимает (спека d9f1dd6f, ревизия 2026-10-27), а перечитывает
 * владельца заново. Иначе придержанный ответ устаревшего чтения, доехавший
 * последним, оставлял бы панель на снимке до правки навсегда.
 *
 * Поколение — на владельца: изменение чужой сущности не отбрасывает чтение
 * показанной. Ведётся только для владельцев, которые панель РЕАЛЬНО читает
 * (`watchValueReads`), — набор ограничен открытыми вкладками. Событие о
 * владельце без наблюдения и событие без адреса владельца (`layer.merged`,
 * локальный канал без owner) двигают общую границу — консервативно, как и
 * дедуп эпохи чтения в `RestClient` (main).
 */
const valueReadGenerations = new Map<string, number>();

/** Общая граница изменений данных: применяется ко всем владельцам. */
let valueReadsEpoch = 0;

/**
 * События, уже сдвинувшие поколение: слушатель инвалидаций зовётся на КАЖДЫЙ
 * погашенный ключ одного события, а граница у события одна.
 */
const bumpedDataEvents = new WeakSet<object>();

/** Взять владельца под наблюдение поколения (панель читает его значения). */
function watchValueReads(ownerType: 'thought' | 'link', ownerId: string): void {
  const key = ownerKey(ownerType, ownerId);
  if (!valueReadGenerations.has(key)) valueReadGenerations.set(key, valueReadsEpoch);
}

/** Снять владельца с наблюдения (вкладка вытеснена). */
function unwatchValueReads(ownerType: 'thought' | 'link', ownerId: string): void {
  valueReadGenerations.delete(ownerKey(ownerType, ownerId));
}

/** Текущее поколение чтения владельца (монотонно). */
function valueReadGeneration(ownerType: 'thought' | 'link', ownerId: string): number {
  return Math.max(valueReadsEpoch, valueReadGenerations.get(ownerKey(ownerType, ownerId)) ?? 0);
}

/** Новая граница изменения данных: чтения, начатые раньше, стали снимком. */
function bumpValueReads(owner?: { ownerType: 'thought' | 'link'; ownerId: string }): void {
  if (owner === undefined) {
    valueReadsEpoch += 1;
    return;
  }
  const key = ownerKey(owner.ownerType, owner.ownerId);
  // Наблюдаемый панелью владелец получает СВОЮ границу; прочие — общую:
  // изменение чужой сущности не должно отбрасывать чтение показанной.
  if (!valueReadGenerations.has(key)) {
    valueReadsEpoch += 1;
    return;
  }
  valueReadGenerations.set(key, valueReadGeneration(owner.ownerType, owner.ownerId) + 1);
}

/** Владелец, которого адресует data-событие значения свойства (или null). */
function valueOwnerOfEvent(
  evt: RealtimeCause,
): { ownerType: 'thought' | 'link'; ownerId: string } | null {
  if (evt.type !== 'property-value.set' && evt.type !== 'property-value.deleted') return null;
  const data = evt.data as { owner_type?: unknown; owner_id?: unknown };
  if (data.owner_type !== 'thought' && data.owner_type !== 'link') return null;
  if (typeof data.owner_id !== 'string' || data.owner_id === '') return null;
  return { ownerType: data.owner_type, ownerId: data.owner_id };
}

/** Ключ строки-черновика совпадает с ключом серверной строки (см. outsideRowKey). */
function pendingOutsideKey(item: PendingOutsideProperty): string {
  return item.side === null ? item.propertyId : `${item.propertyId}:${item.side}`;
}

function pendingOutsideFor(
  ownerType: 'thought' | 'link',
  ownerId: string,
): PendingOutsideProperty[] {
  return pendingOutside.get(ownerKey(ownerType, ownerId)) ?? [];
}

function setPendingOutside(
  ownerType: 'thought' | 'link',
  ownerId: string,
  items: PendingOutsideProperty[],
): void {
  const key = ownerKey(ownerType, ownerId);
  if (items.length === 0) pendingOutside.delete(key);
  else pendingOutside.set(key, items);
}

/**
 * Добавляет выбранное в пикере свойство в группу «Свойства вне типа» и
 * перечитывает тело/счётчик группы. Идемпотентно по ключу строки: повторный
 * выбор того же конца связи не плодит второй черновик.
 */
function addPendingOutside(target: PropertiesTarget, row: PropertyListRow): void {
  const existing = pendingOutsideFor(target.ownerType, target.ownerId).filter(
    (item) => pendingOutsideKey(item) !== row.id,
  );
  const linkTypeId = row.registry.config?.link_type_id;
  existing.push({
    propertyId: row.propertyId,
    property: row.registry,
    name: row.name,
    side: row.side,
    linkTypeId: typeof linkTypeId === 'string' && linkTypeId !== '' ? linkTypeId : null,
    focus: true,
  });
  setPendingOutside(target.ownerType, target.ownerId, existing);
  outsideReload?.();
  outsideRefreshCount?.();
}

/** Направление стороны связи для значка и определения (server: side → direction). */
function sideDirection(side: LinkPropertySide | null): 'out' | 'in' {
  return side === 'target' ? 'in' : 'out';
}

/** Сторона конца связи из определения/значения с fallback на `direction`. */
function linkSideOf(value: {
  side?: LinkPropertySide | null;
  direction?: 'out' | 'in';
  config?: { direction?: 'out' | 'in' } | null;
}): LinkPropertySide {
  if (value.side === 'source' || value.side === 'target') return value.side;
  const direction = value.direction ?? value.config?.direction;
  return direction === 'in' ? 'target' : 'source';
}

/**
 * Ячейка имени строки свойства — ОДИН компонент для типовых и внетиповых
 * строк (ошибка 9717157f, требование заказчика: «использовать отлаженный
 * компонент, списки сделать одинаковыми»): значок вида значения/стороны связи,
 * имя без подписи типа, необязательный ⓘ с описанием. Внетиповые строки
 * раньше собирали имя текстом «имя (тип)» — второй компонент в той же таблице.
 */
function buildPropertyNameCell(opts: {
  name: string;
  valueType: PropertyValueType;
  linkTypeId?: string | null;
  side?: LinkPropertySide | null;
  hint?: string | null;
}): { cell: HTMLTableCellElement; nameText: HTMLElement } {
  const cell = el('td', 'prop-name-cell');
  const linkTypeId = opts.linkTypeId ?? null;
  const visual =
    linkTypeId === null ? null : resolveLinkTypeVisual(store.state.linkTypes, linkTypeId);
  const mark = buildPropertyValueMark(opts.valueType, {
    side: opts.side ?? null,
    visual,
  });
  if (mark !== null) cell.append(mark);
  const nameText = span(opts.name);
  cell.append(nameText);
  const hint = opts.hint?.trim() ?? '';
  if (hint !== '') {
    const info = span('ⓘ', 'muted prop-hint');
    setTooltip(info, hint);
    cell.append(info);
  }
  return { cell, nameText };
}

/** Перечитывает обе группы вкладки «Свойства» (после действия меню строки). */
function refreshPropertiesPanels(): void {
  currentReload?.();
  outsideReload?.();
  outsideRefreshCount?.();
}

/**
 * Запускает фиксацию недописанных значений обеих таблиц вкладки «Свойства»
 * ДО того, как их строки/тела будут пересобраны или сняты с экрана (смена
 * мысли, сворачивание группы, закрытие карточки). Удалённый из документа
 * сфокусированный узел `blur` не получает, и набранный без Enter текст терялся
 * молча (ошибка bfe1bc24). Запись идёт своим замыканием строки (владелец
 * значения захвачен при её построении), поэтому смена владельца до завершения
 * записи безопасна.
 */
function flushPropertiesPending(): void {
  currentFlush?.();
  outsideFlush?.();
}

/** Открывает единый диалог редактирования свойства по реестровому id. */
async function openPropertyEditorById(propertyId: string): Promise<void> {
  try {
    const networkId = requireNetworkId();
    const registry = await etn.propertyRegistry.list(networkId);
    const row = registry.find((candidate) => candidate.id === propertyId);
    if (row === undefined) {
      notice('Свойство не найдено в справочнике сети.');
      return;
    }
    openPropertyManagerEditor(row, refreshPropertiesPanels);
  } catch (err) {
    errorDialog('Изменить свойство', err);
  }
}

/** Параметры действий меню строки: владелец, ключ и сторона значения. */
interface RowPropertyRef {
  ownerType: 'thought' | 'link';
  ownerId: string;
  key: string;
  isLink: boolean;
  side: LinkPropertySide | null;
  linkTypeId: string | null;
}

/**
 * «Очистить» (требование 53701739): скаляр — удаление значения; связь —
 * снятие пометки корзины с ПОМЕЧЕННЫХ рёбер этого свойства у владельца
 * (`PATCH /links/{id} { marked_for_deletion: false }`). Живые рёбра не
 * трогаются — их снимает «Удалить».
 */
async function clearRowValue(ref: RowPropertyRef): Promise<void> {
  try {
    const networkId = requireNetworkId();
    if (!ref.isLink) {
      await etn.properties.remove(networkId, ref.ownerType, ref.ownerId, ref.key);
      refreshPropertiesPanels();
      return;
    }
    const trash = await etn.trash.list(networkId);
    const marked = trash.links.filter((link) => {
      if (link.type_id !== ref.linkTypeId) return false;
      return ref.side === 'target'
        ? link.target_id === ref.ownerId
        : link.source_id === ref.ownerId;
    });
    for (const link of marked) {
      await etn.links.update(
        networkId,
        link.id,
        { marked_for_deletion: false },
        link.version,
      );
    }
    if (marked.length === 0) {
      notice('Помеченных связей этого свойства нет.', 'info');
    } else {
      notice(marked.length > 1 ? `Восстановлено связей: ${marked.length}.` : 'Связь восстановлена.');
    }
    refreshPropertiesPanels();
  } catch (err) {
    errorDialog('Очистить', err);
  }
}

/** «Удалить» внетипового значения: скаляр — DELETE значения; связь — умное
 *  удаление живых рёбер сервером (с ключом стороны для симметричных имён). */
async function removeOutsideRowValue(ref: RowPropertyRef): Promise<void> {
  try {
    const networkId = requireNetworkId();
    await etn.properties.remove(
      networkId,
      ref.ownerType,
      ref.ownerId,
      ref.key,
      ref.isLink ? ref.side : null,
    );
    refreshPropertiesPanels();
  } catch (err) {
    errorDialog('Удалить', err);
  }
}

/**
 * «Перенести в типовые свойства»: привязка к типу владельца. Скаляр — обычная;
 * связь — со стороной строки (она вычислена по живым рёбрам владельца).
 */
async function promoteRowProperty(opts: {
  ownerType: 'thought' | 'link';
  typeId: string;
  propertyId: string;
  isLink: boolean;
  side: LinkPropertySide | null;
}): Promise<boolean> {
  const typeOwner = opts.ownerType === 'thought' ? 'thought_type' : 'link_type';
  try {
    const networkId = requireNetworkId();
    await etn.types.createTypeProperty(networkId, typeOwner, opts.typeId, {
      mode: 'attach',
      property_id: opts.propertyId,
      required: false,
      ...(opts.isLink && opts.side !== null ? { side: opts.side } : {}),
    });
    notice('Свойство перенесено в типовые.');
    refreshPropertiesPanels();
    return true;
  } catch (err) {
    errorDialog('Перенести в типовые свойства', err);
    return false;
  }
}

/**
 * «Исключить из типовых свойств»: снимает привязки СТОРОНЫ строки по всей
 * цепочке типов владельца (включая унаследованные), без подтверждающих
 * диалогов. `defined_on` — тип, на котором живёт привязка, `id` — её id.
 */
async function excludeTypedProperty(opts: {
  ownerType: 'thought' | 'link';
  typeId: string;
  propertyId: string;
  side: LinkPropertySide | null;
}): Promise<void> {
  const typeOwner = opts.ownerType === 'thought' ? 'thought_type' : 'link_type';
  try {
    const networkId = requireNetworkId();
    const definitions = await etn.types.listTypeProperties(networkId, typeOwner, opts.typeId);
    const matches = definitions.filter(
      (definition) =>
        !definition.id.startsWith('mirror:') &&
        definition.property_id === opts.propertyId &&
        (definition.value_type === 'link' ? linkSideOf(definition) : null) === opts.side,
    );
    if (matches.length === 0) {
      // Зеркальная строка (`id: mirror:<property>`) — привязка живёт на другом
      // типе (стороне-источнике), в цепочке владельца снимать нечего. Обе ветки —
      // подсказка по списку `definitions`, полученному серверным чтением
      // (`etn.types.listTypeProperties` выше): изменяющего вызова ещё не было,
      // поэтому это не сбой и не error-тост.
      const mirrored = definitions.some(
        (definition) =>
          definition.id.startsWith('mirror:') &&
          definition.property_id === opts.propertyId &&
          (definition.value_type === 'link' ? linkSideOf(definition) : null) === opts.side,
      );
      notice(
        mirrored
          ? 'Строка зеркальная: привязка свойства живёт на другом типе — исключите её там.'
          : 'Привязка свойства не найдена.',
      );
      return;
    }
    for (const definition of matches) {
      await etn.types.removeTypeProperty(
        networkId,
        typeOwner,
        definition.defined_on,
        definition.id,
      );
    }
    notice(
      matches.length > 1
        ? `Свойство исключено из типов: ${matches.length}.`
        : 'Свойство исключено из типовых.',
    );
    refreshPropertiesPanels();
  } catch (err) {
    errorDialog('Исключить из типовых свойств', err);
  }
}

/**
 * Вешает меню строки на ячейку имени: ПКМ и Shift+F10. Состояние — значение
 * или функция: у внетиповой строки позиция порядка меняется без перерисовки
 * (DnD/Alt/меню), поэтому она вычисляется в момент ОТКРЫТИЯ меню.
 */
function wirePropertyRowMenu(
  cell: HTMLElement,
  state: PropertyRowMenuState | (() => PropertyRowMenuState),
  actions: PropertyRowMenuActions,
): void {
  const stateOf = (): PropertyRowMenuState =>
    typeof state === 'function' ? state() : state;
  if (stateOf().structural) return;
  const open = (x: number, y: number): void => {
    const current = stateOf();
    if (current.structural) return;
    const items = propertyRowMenuItems(current, actions);
    if (items.length > 0) showMenuAt(x, y, items);
  };
  cell.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    open(event.clientX, event.clientY);
  });
  cell.addEventListener('keydown', (event) => {
    if (event.key !== 'F10' || !event.shiftKey) return;
    event.preventDefault();
    const rect = cell.getBoundingClientRect();
    open(rect.left, rect.bottom);
  });
  cell.tabIndex = 0;
}

/** Убирает строку-черновик из локального набора (значения на сервере нет). */
function dropPendingOutside(target: PropertiesTarget, key: string): void {
  setPendingOutside(
    target.ownerType,
    target.ownerId,
    pendingOutsideFor(target.ownerType, target.ownerId).filter(
      (item) => pendingOutsideKey(item) !== key,
    ),
  );
  refreshPropertiesPanels();
}

/**
 * Позиция внетиповой строки в порядке группы — вход пунктов «Переместить
 * выше/ниже» (0.14.1, задача 2e87285b). `onMove` — та же операция, что DnD и
 * Alt+↑/↓ у `createRowReorder`.
 */
interface OutsideReorderSlot {
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
}

/**
 * Меню внетиповой строки. У черновика (`pendingKey`) «Очистить»/«Удалить»
 * убирают только локальную строку, «Перенести» после успешной привязки тоже
 * снимает черновик (значения на сервере ещё нет).
 */
function wireOutsideRowMenu(
  nameCell: HTMLElement,
  target: PropertiesTarget,
  ref: RowPropertyRef & { propertyId: string; pendingKey?: string },
  reorder?: (() => OutsideReorderSlot | null) | null,
): void {
  const dropDraft = (): void => {
    if (ref.pendingKey !== undefined) dropPendingOutside(target, ref.pendingKey);
  };
  wirePropertyRowMenu(
    nameCell,
    () => {
      const slot = reorder?.() ?? null;
      return {
        structural: false,
        typed: false,
        hasType: target.hasOwnType,
        hasRegistryProperty: ref.propertyId !== '',
        ...(slot === null ? {} : { reorder: { index: slot.index, count: slot.count } }),
      };
    },
    {
      edit: () => void openPropertyEditorById(ref.propertyId),
      clear: () => {
        if (ref.pendingKey !== undefined) dropDraft();
        else void clearRowValue(ref);
      },
      promote: () => {
        // Своими типовыми свойствами владеет только владелец со своим живым
        // типом: у нетипизированного `typeId` — подставленный корневой тип,
        // и перенос «в типовые» менял бы определения корневого типа.
        if (!target.hasOwnType || target.typeId === null) return;
        void promoteRowProperty({
          ownerType: target.ownerType,
          typeId: target.typeId,
          propertyId: ref.propertyId,
          isLink: ref.isLink,
          side: ref.side,
        }).then((ok) => {
          if (ok) dropDraft();
        });
      },
      exclude: () => undefined,
      remove: () => {
        if (ref.pendingKey !== undefined) dropDraft();
        else void removeOutsideRowValue(ref);
      },
      move: (from, to) => reorder?.()?.onMove(from, to),
    },
  );
}

/** Определение свойства для строки-черновика (валидация — по реестру).
 *  Ограничение типов значения — из привязок реестра по стороне строки
 *  (`binding_*_type_ids`), той же семантикой, что у типовой строки
 *  (ошибка f8f8fa49). */
function pendingOutsideDefinition(
  item: PendingOutsideProperty,
  ownerType: 'thought' | 'link',
): EffectiveTypeProperty {
  const isLink = item.property.value_type === 'link';
  return {
    id: item.propertyId,
    property_id: item.propertyId,
    owner_type: ownerType === 'thought' ? 'thought_type' : 'link_type',
    owner_id: '',
    key: item.name,
    value_type: item.property.value_type,
    config: isLink
      ? {
          ...(item.linkTypeId !== null ? { link_type_id: item.linkTypeId } : {}),
          direction: sideDirection(item.side),
        }
      : item.property.config,
    required: false,
    position: 0,
    description: item.property.description,
    inherited: false,
    defined_on: '',
    defined_on_name: '',
    default_value: null,
    overridden_here: false,
    description_overridden: false,
    ...(isLink
      ? {
          allowed_opposite_type_ids: registryAllowedOppositeTypeIds(
            item.property,
            item.side,
          ),
        }
      : {}),
  };
}

/**
 * Довести локальную запись значения свойства-СВЯЗИ до холста и панелей
 * (ошибка f0b959dd). Серверная запись создаёт/удаляет РЕБРО, а собственное
 * realtime-эхо собственного клиента приходит асинхронно (B1) (G8 applier,
 * 04-realtime.md §5) — без этого холст не перечитывал окрестность, и новая
 * мысль не появлялась в секторе родителей/родственников. Realtime-путь для
 * ЧУЖИХ правок уже работал: `realtime-ui.ts` на `property-value.set/deleted`
 * пересчитывает тот же набор.
 *
 * Скаляры окрестность фокуса не меняют — для них пересчёт не нужен. Если
 * владелец не виден в текущей окрестности (редактор открыт на мысли вне
 * карты), пересчёт тоже пропускается: карта от такой правки не меняется.
 * Само поле значения свой чип перерисовывает локально, так что перечитывание
 * всей окрестности на каждый чип не делается — только по факту записи.
 */
function repaintAfterLinkValueWrite(ownerType: 'thought' | 'link', ownerId: string): void {
  // Значение свойства-связи создаёт/удаляет РЕБРО: открытая вкладка «Граф»
  // обязана пересобрать план, иначе линия/чип «+N» останутся прежними
  // (ошибка 42a7c0a1, круг 3). Граф редактора не зависит от фокуса карты,
  // поэтому инвалидация идёт ДО проверки окрестности.
  invalidateGraphTab();
  if (!inFocusNeighbourhood(ownerType, ownerId)) return;
  // Слой данных (G2/G3): гасим focus-, structures- и chronicle-ключи —
  // активная окрестность, «Структуры» и лента «Дневника» перечитаются слоем
  // (роутер/инвалидация), без ручных `scheduleNeighbourhoodRepaint`.
  invalidateAfterMutation([
    queryKeys.focusAll(),
    queryKeys.structuresPageAll(),
    queryKeys.chronicleFeedAll(),
  ]);
}

/**
 * Сигнал «состав публикации мог измениться» для владельца значения.
 *
 * Значение свойства — критерий рецепта (`extra_properties`): его запись может
 * ВВЕСТИ мысль в сборку, которой там ещё нет. Поэтому кроме id владельца
 * передаём признак `mayChangeComposition` (передача G5→G6, симметрично «входу»
 * в отбор G3): рабочая область зажигает stale безусловно. У владельца-СВЯЗИ
 * концы (мысли) неизвестны — консервативный stale без списка.
 */
function signalCompositionForOwner(ownerType: 'thought' | 'link', ownerId: string): void {
  signalPublicationCompositionChanged(ownerType === 'thought' ? [ownerId] : undefined, {
    mayChangeComposition: true,
  });
  // Своя мутация значения — тоже граница чтения (ошибка da7bbb53, круг 2):
  // чтение, начатое до записи, не должно применить прежний снимок поверх
  // нового. Панель после успешной записи перечитывает владельца сама
  // (`onSaved`), уже в новом поколении.
  bumpValueReads({ ownerType, ownerId });
}

/**
 * Значение свойства изменилось (чужой клиент или локальное эхо): помечаем
 * ВЛАДЕЛЬЦА события, а не «показанного». Панель, показывающая другого
 * владельца, не перечитывается зря; скрытая — перечитает при следующем показе
 * через `lifecycle.onShow` (ошибка 9667b75c). Показанная панель обновляется на
 * месте; отцепленная отсекается гардом самого `reload`, а метка остаётся.
 * Тело «Свойства вне типа» подписано на тот же поток само (см.
 * `buildOutsidePropertiesBody`), поэтому здесь его не трогаем — иначе одно
 * событие давало бы двойное чтение.
 */
function noteValueOwnerChanged(ownerType: 'thought' | 'link', ownerId: string): void {
  const target = currentTarget;
  // Вкладка ещё не построена — метка не нужна: первая сборка прочитает данные
  // сама, а набор не растёт на события до открытия «Свойств».
  if (target === null) return;
  markValueOwnerDirty(ownerType, ownerId);
  if (target.ownerType !== ownerType || target.ownerId !== ownerId) return;
  currentReload?.();
}

/**
 * Отказ чтения свойств владельца: значений (`properties.get`) или определений
 * типа (ошибка f803afb6) — пользователь обязан увидеть, что строки показывают
 * прежние значения (или помечены «не удалось прочитать»), а не стёртые, и не
 * получить техническую строку. Текст один на всех потребителей (типовая
 * таблица, внетиповая): тост дедуплицирует одинаковый текст, поэтому серия
 * отказов и ретраи не плодят сообщения (ошибки d720265c, f803afb6 —
 * требование «без спама»).
 */
function notifyPropertiesReadFailed(): void {
  notice(t('properties.valuesReadFailed'), 'error');
}

/**
 * Registers the «Свойства» tab (task 8ab775d9). Replaces the previous
 * «Свойства» section in the «Комментарий» tab — values now live in their own
 * tab with two collapsible groups, leaving «Комментарий» to the permanent
 * comment full-height editor.
 */
export function registerPropertiesGroup(): void {
  registerTabContent('properties', buildPropertiesTab);
  // Entity switch of the same type reuses the pane: retarget it in place instead
  // of dropping the cache, so `reconcileKeyed` reconciles the rows (task
  // 90b2256e, круг 1).
  registerTabRetarget('properties', (_pane, ctx) => retargetPropertiesTab(ctx));
  if (!wired) {
    wired = true;
    // Чужое значение свойства гасит `focus:@owner` (роутер на
    // `property-value.set/deleted`) — помечаем владельца события и
    // перечитываем открытую вкладку, только если она показывает именно его.
    // Свой `onRealtimeEvent` снесён (G5): используется причина слоя.
    onQueryInvalidated((prefix, _keys, cause) => {
      // Граница чтения значений (ошибка da7bbb53, круг 2) двигается ДО
      // перечитывания, которое запускают слушатели этого же события (ниже и в
      // телах групп): иначе их свежие чтения попадали бы в прежнее поколение и
      // отбрасывались. Роутер игнорирует `presence.*`/`edit.*` — они сюда не
      // доходят, данные они не меняют.
      const evt = asRealtimeCause(cause);
      if (evt !== null && !bumpedDataEvents.has(evt)) {
        bumpedDataEvents.add(evt);
        bumpValueReads(valueOwnerOfEvent(evt) ?? undefined);
      }
      if (prefix !== queryKeys.focusAll() && !prefix.startsWith('focus:@')) return;
      if (evt === null) return;
      if (evt.type === 'property-value.set' || evt.type === 'property-value.deleted') {
        const data = evt.data as { owner_type?: unknown; owner_id?: unknown };
        if (data.owner_type !== 'thought' && data.owner_type !== 'link') return;
        if (typeof data.owner_id !== 'string') return;
        noteValueOwnerChanged(data.owner_type, data.owner_id);
      }
    });
    // Локальный канал правок значений (карта, редактор значения): владелец в
    // событии не передаётся — двигаем общую границу. Слушатели тел групп
    // (ниже по регистрации) перечитают показанного владельца уже в новом
    // поколении.
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener(PROPERTY_VALUES_REFRESHED_EVENT, () => bumpValueReads());
    }
  }
}

/** Builds the «Свойства» tab content (two collapsible groups). */
function buildPropertiesTab(ctx: EditorContext, lifecycle: TabPaneLifecycle): HTMLElement {
  const box = div('properties-tab');
  // No type → no properties at all (an owner with no type resolves the root,
  // but a network mid-migration might have no root either — show empty state).
  const typeId = resolveEditorTypeId(ctx);
  if (typeId === null) {
    box.append(el('p', 'muted', 'Свойства недоступны — нет подходящего типа.'));
    return box;
  }
  // The mutable target this pane renders: a same-type entity switch retargets it
  // WITHOUT rebuilding the pane, and the built tables reload under the new owner
  // (task 90b2256e, круг 1).
  const target: PropertiesTarget = {
    ownerType: ctx.ownerType,
    ownerId: ctx.ownerId,
    typeId,
    hasOwnType: hasOwnLiveType(ctx),
  };
  // A fresh pane resets the stale reload callbacks of the previous one.
  currentReload = null;
  outsideReload = null;
  outsideRefreshCount = null;
  currentFlush = null;
  outsideFlush = null;
  currentTarget = target;
  // Поколение чтения значений этого владельца (ошибка da7bbb53, круг 2):
  // изменение его данных инвалидирует чтения панели, чужих — общая граница.
  watchValueReads(target.ownerType, target.ownerId);
  // Вытеснение панели: её метки «владелец изменён не на экране» больше не
  // нужны — следующая сборка читает значения сама (ошибка 9667b75c).
  lifecycle.onDispose(() => {
    if (currentTarget === target) currentTarget = null;
    dirtyValueOwners.clear();
    unwatchValueReads(target.ownerType, target.ownerId);
  });
  // Возврат на скрытую вкладку: пока её не было на экране, значение могло
  // измениться у показанного владельца. `reload` сам фиксирует набранное и
  // делает инкрементальную сверку (без пересборки таблицы); гард «скрыто не
  // читаем» уже не действует — панель прикреплена до вызова хука.
  // Каждый потребитель возвращает свой долг сам: успех типовой таблицы не
  // означает, что внетиповая/счётчик прочитали данные (замечание
  // верификатора к 9667b75c, круг 4).
  lifecycle.onShow(() => {
    if (isValueOwnerDirty(target.ownerType, target.ownerId, 'typed')) currentReload?.();
    if (isValueOwnerDirty(target.ownerType, target.ownerId, 'outside')) outsideReload?.();
    if (isValueOwnerDirty(target.ownerType, target.ownerId, 'outsideCount')) {
      outsideRefreshCount?.();
    }
  });
  // Group 1 — «Свойства типа» (expanded by default). Read-only outside-type
  // values are rendered inline as a second group further down.
  const typeGroup = groupSection({
    id: 'properties.type',
    title: 'Свойства типа',
    defaultCollapsed: false,
    buildBody: () => buildPropertiesBodyFor(target, lifecycle),
    // Тело уходит с экрана при сворачивании: набранное без Enter в чип-полях
    // и скалярах фиксируем до снятия узлов (ошибка bfe1bc24).
    onBeforeHide: flushPropertiesPending,
  });
  // Group 2 — «Свойства вне типа» (0.14.1: expanded by default, требование
  // 87039bc8). Заголовок несёт «(+) Добавить свойство» — ранний визуальный
  // срез задачи 626b29bd; пикер и «Создать новое…» живут в диалоге.
  const addPropertyBtn = iconButton({
    icon: svgIcon('plus', 14),
    title: 'Добавить свойство',
    role: 'ghost',
    size: 's',
    class: 'prop-outside-add',
    onClick: (event) => {
      event.stopPropagation();
      void openOutsidePropertyPicker(target);
    },
  });
  const outsideGroup = groupSection({
    id: 'properties.outside',
    title: 'Свойства вне типа',
    defaultCollapsed: false,
    lazyCount: true,
    actions: [addPropertyBtn],
    // Сворачивание снимает тело: недописанные значения фиксируем до этого.
    onBeforeHide: flushPropertiesPending,
    loadCount: async () => {
      // Owner token: a slow badge count of the previous owner must not land on
      // the new one (task 90b2256e, круг 3).
      const requestOwnerId = target.ownerId;
      // Поколение чтения (ошибка da7bbb53, круг 2): ответ, запрошенный до
      // изменения данных владельца, — прежний снимок. Счётчик — третий
      // потребитель значений, у него своя метка `outsideCount`.
      const readGeneration = valueReadGeneration(target.ownerType, requestOwnerId);
      try {
        const networkId = requireNetworkId();
        const values = await etn.properties.get(
          networkId,
          target.ownerType,
          requestOwnerId,
        );
        if (requestOwnerId !== target.ownerId) return undefined;
        if (readGeneration !== valueReadGeneration(target.ownerType, requestOwnerId)) {
          // Устаревший ответ не применяем и метку не снимаем: показанному
          // счётчику нужен ответ, запрошенный после изменения. Повтор — в
          // микрозадаче (группа уже создана к этому моменту); вытесненная
          // панель не перечитывается.
          queueMicrotask(() => {
            if (currentTarget === target) outsideRefreshCount?.();
          });
          return undefined;
        }
        // Скаляры и свойства-связи: внетиповое свойство-связь — тоже значение
        // вне типа (dfaacb05), сервер отдаёт его формой LinkPropertyValues.
        const outside = values.filter((v) => v.outside_type === true);
        // Выбранные, но ещё не записанные строки тоже видны в группе — считаем
        // их, пока серверного значения нет (задача 626b29bd).
        const present = new Set(outside.map((v) => outsideRowKey(v)));
        const pending = pendingOutsideFor(target.ownerType, requestOwnerId).filter(
          (item) => !present.has(pendingOutsideKey(item)),
        );
        const total = outside.length + pending.length;
        // Счётчик прочитал значения успешно — снимает СВОЮ метку потребителя
        // (`outsideCount`). Успех типовой/внетиповой таблицы её не снимает и
        // наоборот (замечание верификатора к 9667b75c, круг 4).
        if (box.isConnected) {
          clearValueOwnerDirty(target.ownerType, requestOwnerId, 'outsideCount');
        }
        return total === 0 ? '(0)' : `(${total})`;
      } catch {
        return undefined;
      }
    },
    buildBody: () => buildOutsidePropertiesBody(target, lifecycle),
  });
  outsideRefreshCount = () =>
    outsideGroup.dispatchEvent(new CustomEvent('etn:refresh-count'));
  // Retarget of the SHOWN pane to another owner of the same type: the pane is
  // reused (editor's `registerTabRetarget`), its bodies reload under the new
  // owner and the outside-type badge is re-resolved (its owner lives on the
  // group, not in the body, so it needs an explicit refresh).
  retargetCurrent = (next) => {
    // Смена мысли пересоберёт изменившиеся строки: набранное без Enter
    // фиксируем ДО смены владельца — запись идёт замыканием старой строки
    // (ошибка bfe1bc24). Не ждём: чтение нового владельца не должно стоять
    // за сетевой записью старого.
    flushPropertiesPending();
    unwatchValueReads(target.ownerType, target.ownerId);
    target.ownerType = next.ownerType;
    target.ownerId = next.ownerId;
    target.typeId = resolveEditorTypeId(next);
    target.hasOwnType = hasOwnLiveType(next);
    // Поколение нового владельца: его изменения после этого чтения гасят
    // ответы, начатые раньше (ошибка da7bbb53, круг 2).
    watchValueReads(target.ownerType, target.ownerId);
    currentReload?.();
    outsideReload?.();
    outsideRefreshCount?.();
  };
  // Раскладка пары (приёмка 0.8.1): сплиттер и фиксированные высоты действуют
  // только когда ОБЕ группы развёрнуты; свёрнутая группа схлопывается до
  // заголовка, единственная развёрнутая растягивается на всю вкладку,
  // сплиттер над свёрнутой группой инертен (тела нет — bodyOf → null).
  const bodyOf = (group: HTMLElement): HTMLElement | null =>
    group.querySelector(':scope > .group-body') as HTMLElement | null;
  const relayout = (): void => {
    const both = bodyOf(typeGroup) !== null && bodyOf(outsideGroup) !== null;
    applyTabGroupClamp(typeGroup, 'properties.type', both);
    applyTabGroupClamp(outsideGroup, 'properties.outside', both);
  };
  typeGroup.addEventListener('etn:toggled', () => relayout());
  outsideGroup.addEventListener('etn:toggled', () => relayout());
  relayout();
  box.append(
    typeGroup,
    rowSplitter(() => bodyOf(typeGroup), { min: 50, persistKey: 'properties.type' }),
    outsideGroup,
  );
  return box;
}

/**
 * The type whose properties the editor shows (L21): the thought/link's own
 * type, or the root type «основной тип» for an owner without one (its
 * settings apply to every element without a type). `null` when the catalogue
 * has no root (mid-migration edge).
 *
 * Тип, удалённый realtime-событием (ошибка 94b28014), за своего не считается:
 * каталог store перезагружается асинхронно, и запрос набора по уже
 * несуществующему типу вернул бы ошибку вместо набора корневого типа.
 */
function resolveEditorTypeId(ctx: EditorContext): string | null {
  return ownLiveTypeId(ctx) ?? rootTypeIdFor(ctx.ownerType);
}

/** Собственный живой тип владельца (тип, удалённый realtime, не в счёт). */
function ownLiveTypeId(ctx: EditorContext): string | null {
  const own = ctx.ownerType === 'thought' ? ctx.thought?.type_id : ctx.link?.type_id;
  if (own == null || isTypeDeleted({ ownerType: ownerTypeOf(ctx), ownerId: own })) return null;
  return own;
}

/**
 * Есть ли у владельца собственный живой тип. Корневой тип, подставленный
 * `resolveEditorTypeId`, собственным не считается: нетипизированный владелец
 * не должен получать действия, которые меняют определения типа.
 */
function hasOwnLiveType(ctx: EditorContext): boolean {
  return ownLiveTypeId(ctx) !== null;
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
 * Перепривязывает показанную вкладку «Свойства» к другой сущности того же типа
 * (задача 90b2256e, круг 1). Редактор зовёт её вместо сброса кэша вкладок:
 * главная таблица перечитывает значения нового владельца и сверяет строки по
 * ключам привязок (`reconcileKeyed`) без пересборки таблицы, тело группы
 * «Свойства вне типа» (если построено) — перечитывает свой список.
 */
export function retargetPropertiesTab(ctx: EditorContext): void {
  retargetCurrent?.(ctx);
}

/**
 * Builds the «Свойства типа» body for the current owner — thoughts and links
 * share the same render path. The main table shows in-type values; outside-type
 * values are now in a separate group below.
 */
function buildPropertiesBody(ctx: EditorContext): HTMLElement {
  return buildPropertiesBodyFor({
    ownerType: ctx.ownerType,
    ownerId: ctx.ownerId,
    typeId: resolveEditorTypeId(ctx),
    hasOwnType: hasOwnLiveType(ctx),
  });
}

/**
 * Builds the «Свойства типа» body against a MUTABLE target: on an entity switch
 * of the same type the pane is reused and the table reloads under the new owner
 * (task 90b2256e). The owner-id is read at reload time, never captured per row,
 * so a retarget never writes to the previous entity.
 */
function buildPropertiesBodyFor(
  target: PropertiesTarget,
  lifecycle?: TabPaneLifecycle,
): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('properties-body');
  if (target.typeId === null) {
    box.append(el('p', 'muted', 'Свойства недоступны.'));
    return box;
  }
  const typeOwner = target.ownerType === 'thought' ? 'thought_type' : 'link_type';
  const typeBody = buildTypePropertiesBody(
    networkId,
    target,
    typeOwner,
    target.typeId,
    lifecycle,
  );
  box.append(typeBody);
  return box;
}

/**
 * Ключи строк, уже присутствующих у владельца: обе группы «Свойства»
 * (типовая и внетиповая), по стороне связи. Типовая группа — эффективные
 * определения типа (скаляр без значения тоже присутствует), внетиповая —
 * прочитанные значения плюс локальные черновики, ещё не записанные на сервер.
 * Совпадает с идентификаторами строк общего списка (`property_id` /
 * `property_id:side`). Используется пикером: такие строки из него исключаются
 * целиком (требование 87039bc8).
 */
function presentPropertyRowIds(
  values: readonly (PropertyValue | LinkPropertyValues)[],
  definitions: readonly EffectiveTypeProperty[],
  pending: readonly PendingOutsideProperty[],
): Set<string> {
  const ids = new Set<string>();
  for (const def of definitions) {
    if (def.property_id === '') continue;
    if (def.value_type === 'link') {
      if (def.config?.structural === true) continue;
      ids.add(`${def.property_id}:${linkSideOf(def)}`);
    } else {
      ids.add(def.property_id);
    }
  }
  for (const value of values) {
    if (value.outside_type !== true) continue;
    if (isLinkPropertyValues(value)) {
      if (value.property_id === '') continue;
      ids.add(`${value.property_id}:${linkSideOf(value)}`);
    } else if (value.property_id !== '') {
      ids.add(value.property_id);
    }
  }
  for (const item of pending) ids.add(pendingOutsideKey(item));
  return ids;
}

/**
 * Пикер «(+) Добавить свойство» вкладки «Свойства» (0.14.1, задача 626b29bd,
 * требование 87039bc8). Общий `property-list` в режиме picker по всему
 * справочнику сети: живой поиск, свойство-связь — двумя строками, выбор — со
 * стороной. Строки, уже присутствующие у мысли (обе группы, по стороне),
 * ИСКЛЮЧЕНЫ из выдачи (`excludeRow`), системные «Родители»/«Потомки» — тоже.
 *
 * Внизу — «Создать новое…»: единый диалог «Свойство/связь» (спека 465495a9);
 * созданное свойство сразу выбирается в карточку. Выбранная строка становится
 * черновиком группы «Свойства вне типа» (пустой редактор значения) и с этого
 * момента из пикера исчезает — повторного выбора того же конца связи нет.
 */
async function openOutsidePropertyPicker(target: PropertiesTarget): Promise<void> {
  const networkId = requireNetworkId();
  const errorLine = footerErrorLine();
  const typeOwner = target.ownerType === 'thought' ? 'thought_type' : 'link_type';

  let registryRows: PropertyRegistryRow[];
  let values: Array<PropertyValue | LinkPropertyValues>;
  let definitions: EffectiveTypeProperty[];
  try {
    [registryRows, values] = await Promise.all([
      etn.propertyRegistry.list(networkId),
      etn.properties.get(networkId, target.ownerType, target.ownerId),
    ]);
    definitions =
      target.typeId === null
        ? []
        : await etn.types.listTypeProperties(networkId, typeOwner, target.typeId);
  } catch (err) {
    errorDialog('Добавить свойство', err);
    return;
  }
  await ensurePropertyLinkTypes(networkId, registryRows);

  let builtRows = buildPropertyListRows(registryRows, store.state.linkTypes);
  let excludedIds = presentPropertyRowIds(
    values,
    definitions,
    pendingOutsideFor(target.ownerType, target.ownerId),
  );

  return new Promise<void>((resolve) => {
    /** Перечитывает реестр/значения и перерисовывает список (после создания/
     *  правки свойства и после своей записи значения-черновика). */
    async function reloadData(): Promise<void> {
      try {
        const [nextRegistry, nextValues] = await Promise.all([
          etn.propertyRegistry.list(networkId),
          etn.properties.get(networkId, target.ownerType, target.ownerId),
        ]);
        registryRows = nextRegistry;
        values = nextValues;
        definitions =
          target.typeId === null
            ? []
            : await etn.types.listTypeProperties(networkId, typeOwner, target.typeId);
      } catch {
        /* оставляем прежний снимок — редактор уже отчитался об ошибке */
      }
      await ensurePropertyLinkTypes(networkId, registryRows);
      builtRows = buildPropertyListRows(registryRows, store.state.linkTypes);
      excludedIds = presentPropertyRowIds(
        values,
        definitions,
        pendingOutsideFor(target.ownerType, target.ownerId),
      );
      list.setRows(builtRows);
    }

    /** Выбор строки: свойство немедленно появляется в группе «Свойства вне
     *  типа» (строка-черновик с курсором в редакторе значения). */
    function choose(row: PropertyListRow): void {
      if (row.structural) return;
      addPendingOutside(target, row);
      close();
      resolve();
    }

    /** Созданное в едином диалоге свойство сразу выбирается в карточку
     *  (скаляр — своей строкой, связь — строкой источника). */
    function chooseCreated(createdId: string, isLink: boolean): void {
      const rowId = isLink ? `${createdId}:source` : createdId;
      const row = builtRows.find((candidate) => candidate.id === rowId) ?? null;
      if (row === null) return;
      choose(row);
    }

    const list = buildPropertyList({
      mode: 'picker',
      searchPlaceholder: t('actions.search'),
      excludeRow: (row) => row.structural || excludedIds.has(row.id),
      callbacks: {
        onActivate: (row) => choose(row),
        // Контекстное меню «Изменить» — тот же единый редактор свойства.
        onEdit: (row) =>
          openPropertyManagerEditor(
            row.registry,
            () => void reloadData(),
            (created) => chooseCreated(created.id, created.value_type === 'link'),
          ),
      },
    });
    list.setRows(builtRows);

    const body = div('form-stack list-dialog-body');
    body.append(list.root);

    const close = showDialog({
      title: 'Добавить свойство',
      body,
      size: 'l',
      // Высота стабильна: задана ролью, не содержимым списка (правило 9
      // требования 11ddd910, ошибка f68bb43c).
      fixedHeight: true,
      footerError: errorLine,
      buttons: [
        { label: t('actions.cancel') },
        {
          label: 'Создать новое…',
          keepOpen: true,
          onClick: () => {
            openPropertyManagerEditor(
              null,
              () => void reloadData(),
              (created) => {
                // Единый диалог закроется сам; карточка получает строку сразу,
                // а список реестра — свежий снимок для следующего открытия.
                void reloadData().then(() => {
                  chooseCreated(created.id, created.value_type === 'link');
                });
              },
            );
          },
        },
        {
          label: 'Выбрать',
          primary: true,
          keepOpen: true,
          onClick: () => {
            const row = list.selected();
            if (row !== null) choose(row);
          },
        },
      ],
      onMount: () => list.focus(),
    });
  });
}

/**
 * Builds the «Свойства вне типа» body — редактируемая таблица значений, чьё
 * свойство не подключено к типу владельца (0.6.5; спека «Значения вне типа
 * сохраняются»). Строка — та же, что в таблице «Свойства типа»: общий редактор
 * значения и валидация по определению свойства (0.14.1, задача 626b29bd).
 * Строки-черновики (выбранные в пикере, но ещё не записанные) рисуются здесь
 * же и заменяются серверной строкой после первой записи значения.
 */
function buildOutsidePropertiesBody(
  target: PropertiesTarget,
  lifecycle?: TabPaneLifecycle,
): HTMLElement {
  const networkId = requireNetworkId();

  const box = div('properties-outside-body');
  const wrap = div('admin-table-wrap prop-wrap');
  wrap.append(el('span', 'muted', 'Загрузка…'));
  box.append(wrap);

  // Инкрементальная таблица (стандарт «Списки рендерятся инкрементально»):
  // узел таблицы держим, а строки сверяем по ключу через `reconcileKeyed`
  // вместо пересборки коллекции на каждом перечитывании (realtime
  // `property-value.*`, перепривязка). Так живы фокус, прокрутка и открытые
  // редакторы неизменившихся строк.
  const { table, tbody } = makeOutsideTypeTable();
  /** Прикреплена ли таблица к обёртке; пока нет — в ней плейсхолдер/ошибка. */
  let tableAttached = false;
  let everMounted = false;
  /**
   * Недописанные значения открытых редакторов этой таблицы: фиксируются до
   * пересборки строк (`reconcileKeyed`), снятия тела группы и закрытия
   * карточки — снятый узел blur не получает (ошибка bfe1bc24).
   */
  const pendingCommits = createPendingValueCommits();
  outsideFlush = () => void pendingCommits.flush();
  /** Owner currently rendered in this body (see the in-type table's guard). */
  let shownOwnerId: string | null = null;
  /** Retry watch armed while a connection-lost error is on screen (de34b35b). */
  let retryStop: (() => void) | null = null;
  let disposed = false;
  lifecycle?.onDispose(() => {
    disposed = true;
    retryStop?.();
    retryStop = null;
    // Карточка закрывается/панель пересобирается: набранное в чип-полях и
    // скалярных полях без Enter фиксируем до исчезновения узлов (bfe1bc24).
    void pendingCommits.flush();
  });

  /**
   * Реестр свойств сети для внетиповых СКАЛЯРОВ: из него берётся `config`
   * (список вариантов, множественность) — редактор валидирует значение по
   * определению свойства (0.14.1, задача 626b29bd). Недоступен — деградация до
   * формы значения, список всё равно читается.
   */
  let registryById = new Map<string, PropertyRegistryRow>();
  async function loadRegistryRows(): Promise<PropertyRegistryRow[]> {
    try {
      return await etn.propertyRegistry.list(networkId);
    } catch {
      return [];
    }
  }

  /**
   * Видимые строки группы в порядке отображения (серверные значения +
   * локальные черновики). Единый источник навигации ↑/↓ и переупорядочивания
   * (0.14.1, задача 2e87285b).
   */
  let shownRows: OutsideRow[] = [];
  /** Узлы строк после keyed-сверки: ключ строки → `tr` и ячейка имени. */
  const rowNodes = new Map<string, { tr: HTMLElement; nameCell: HTMLElement }>();
  let nav: ListNavHandle<OutsideRow> | null = null;
  let reorder: RowReorderHandle | null = null;

  const rowKeyOf = (row: OutsideRow): string =>
    row.pending !== null ? pendingOutsideKey(row.pending) : outsideRowKey(row.value!);

  /** Строки, которые адресует операция порядка: есть реестровое свойство. */
  const reorderableRows = (): OutsideRow[] =>
    reorderableOutsideSlots(shownRows).map((index) => shownRows[index]!);

  /** Перечитать карту узлов после `reconcileKeyed` (ключ — `data-key` строки). */
  const collectRowNodes = (): void => {
    rowNodes.clear();
    for (const child of Array.from(tbody.children) as HTMLElement[]) {
      const key = child.getAttribute('data-key');
      if (key === null) continue;
      const nameCell = child.querySelector('.prop-name-cell') as HTMLElement | null;
      if (nameCell !== null) rowNodes.set(key, { tr: child, nameCell });
    }
  };

  const nodeOf = (row: OutsideRow): { tr: HTMLElement; nameCell: HTMLElement } | null =>
    rowNodes.get(rowKeyOf(row)) ?? null;

  /** Строка, содержащая узел (клик/фокус): поднимаемся до `tr` с `data-key`. */
  const rowOfNode = (start: HTMLElement | null): OutsideRow | null => {
    let node: HTMLElement | null = start;
    while (node !== null && node !== box) {
      if ((node.tagName ?? '').toLowerCase() === 'tr') {
        const key = node.getAttribute('data-key');
        if (key !== null) return shownRows.find((row) => rowKeyOf(row) === key) ?? null;
      }
      node = parentNodeOf(node);
    }
    return null;
  };

  /** Переприменить выделение и привязку порядка после изменения строк. */
  const afterRowsChanged = (): void => {
    collectRowNodes();
    nav?.refresh();
    reorder?.refresh();
  };

  /**
   * Разложить переупорядочиваемые строки по их слотам, сохранив позиции
   * черновиков и легаси-рёбер (у них нет реестрового id — их порядок не
   * адресуется операцией). Строки НЕ пересобираются: `reconcileKeyed` только
   * перемещает узлы, редакторы значений и ввод пользователя остаются живыми.
   */
  const applyReorderableOrder = (ordered: OutsideRow[]): void => {
    if (ordered.length === 0) return;
    const slots = reorderableOutsideSlots(shownRows);
    const next = [...shownRows];
    slots.forEach((slot, index) => {
      const row = ordered[index];
      if (row !== undefined) next[slot] = row;
    });
    shownRows = next;
    reconcileKeyed(tbody, shownRows, rowSpec);
    afterRowsChanged();
  };

  /** Единый колбэк перестановки: DnD, Alt+↑/↓ и пункты контекстного меню. */
  const moveOutsideRow = (from: number, to: number): void => {
    const rows = reorderableRows();
    if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return;
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    applyReorderableOrder(next);
    // Полный набор текущих вне-типовых строк; у связи сторона — из строки
    // (`linkSideOf`), у скаляра не передаётся (контракт 27ed2b39).
    const requestOwnerId = target.ownerId;
    const items = next.map((row, index) => toOrderItem(row.value!, index));
    void (async () => {
      try {
        await etn.properties.reorder(networkId, requestOwnerId, items);
      } catch (err) {
        if (requestOwnerId !== target.ownerId) return;
        notice(`Не удалось сохранить порядок свойств: ${errText(err)}`, 'error');
        await reload(true);
      }
    })();
  };

  /** Позиция строки для пунктов «Переместить выше/ниже» (null — не двигается). */
  const reorderSlotOf = (key: string): OutsideReorderSlot | null => {
    const rows = reorderableRows();
    const index = rows.findIndex((row) => rowKeyOf(row) === key);
    if (index < 0) return null;
    return { index, count: rows.length, onMove: moveOutsideRow };
  };

  /**
   * Порядок пришёл событием от другого участника (0.14.1, задача 2e87285b):
   * ранги по `property_id` + стороне применяются к показанным строкам БЕЗ
   * перечитывания вкладки. Строку, в которой сейчас идёт ввод, не трогаем —
   * порядок применит следующее чтение.
   */
  const applyRemoteOrder = (
    thoughtId: string,
    items: readonly ThoughtPropertiesReorderedItem[],
  ): void => {
    if (thoughtId !== target.ownerId) return;
    const active = (globalThis as { document?: Document }).document?.activeElement ?? null;
    if (active !== null && box.contains(active as never) && isEditingTarget(active)) return;
    const ranks = new Map<string, number>();
    for (const item of items) ranks.set(orderItemKey(item.property_id, item.side), item.position);
    const ordered = [...reorderableRows()].sort((a, b) => {
      const ra = ranks.get(outsideRowKey(a.value!)) ?? Number.MAX_SAFE_INTEGER;
      const rb = ranks.get(outsideRowKey(b.value!)) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
    applyReorderableOrder(ordered);
  };

  const rowSpec = outsideRowSpec(
    networkId,
    target,
    () => void reload(),
    (propertyId) => registryById.get(propertyId),
    reorderSlotOf,
    pendingCommits.register,
  );

  // Навигация ↑/↓ и Enter — общий компонент списка над ядром nav-core.
  nav = createListNav<OutsideRow>(box, {
    entries: () => shownRows,
    tokenOf: rowKeyOf,
    elementOf: (row) => nodeOf(row)?.tr ?? null,
    applyHighlight: (row) => {
      const key = row === null ? null : rowKeyOf(row);
      for (const [candidate, node] of rowNodes) {
        node.tr.classList.toggle(PROPERTY_ROW_CURRENT_CLASS, candidate === key);
      }
    },
    // Строка-`tr` не таб-стоп: фокус наводим на ячейку имени (она уже
    // фокусируема — Shift+F10 меню строки), это и держит контекст клавиш.
    focus: (row) => nodeOf(row)?.nameCell.focus?.(),
    reveal: (row) => nodeOf(row)?.tr.scrollIntoView?.({ block: 'nearest' }),
    onClick: (target) => {
      const row = rowOfNode(target);
      if (row !== null) nav?.setCurrent(row);
      // Мышиное выделение обязано взводить навигационный контекст: он
      // поднимается на `focusin` списка, и без фокуса Alt+↑/↓ молчит (ошибка
      // 21f4465f). Клик по редактору/кнопке фокус не отбирает — как в
      // редакторе типа (задача 1425457f).
      const interactive = target.closest(
        'input, textarea, select, button, a, [contenteditable="true"]',
      );
      if (row !== null && interactive === null) nodeOf(row)?.nameCell.focus?.();
    },
    onActivate: (row) => {
      const node = nodeOf(row);
      if (node !== null && !focusRowValue(node.tr)) node.nameCell.focus?.();
    },
  });

  // Переупорядочивание — общая компонента (задача 223f7d50): захват за имя
  // свойства, Alt+↑/↓ через nav-core, Esc и авто-прокрутка — в drag-фасаде.
  reorder = createRowReorder<OutsideRow>(
    tbody,
    {
      rows: () =>
        reorderableRows().flatMap((row) => {
          const node = nodeOf(row);
          return node === null ? [] : [{ entry: row, key: rowKeyOf(row), element: node.tr }];
        }),
      onMove: moveOutsideRow,
    },
    {
      captureOf: (row) => nodeOf(row.entry)?.nameCell ?? null,
      currentKey: () => nav?.token() ?? null,
      scrollHost: () => wrap,
    },
  );
  lifecycle?.onDispose(() => {
    reorder?.destroy();
    reorder = null;
    nav?.destroy();
    nav = null;
  });

  async function reload(force = false): Promise<void> {
    // Owner token of this reload (same guard as the in-type table): a slow
    // response of the previous owner must not be rendered after a retarget
    // (task 90b2256e, круг 2); an owner CHANGE proceeds even while detached
    // (круг 3).
    const requestOwnerId = target.ownerId;
    // A reconnect retry forces the read even while the pane is detached (the
    // editor keeps only the active tab in the DOM; a cached pane is alive).
    if (!force && everMounted && !box.isConnected && requestOwnerId === shownOwnerId) return;
    // Недописанное значение строки фиксируем ДО чтения и сверки: сверка ниже
    // пересобирает изменившиеся строки, а снятый сфокусированный узел blur не
    // получает (ошибка bfe1bc24).
    void pendingCommits.flush();
    // Плейсхолдер — только пока таблица не прикреплена; иначе инкрементальное
    // обновление не мигает «Загрузкой…» на каждой правке значения.
    if (!tableAttached) wrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let values: Array<PropertyValue | LinkPropertyValues>;
    // Поколение чтения (ошибка da7bbb53, круг 2) фиксируем ДО запроса: ответ
    // актуален, только если данных владельца не изменили, пока он был в пути.
    const readGeneration = valueReadGeneration(target.ownerType, requestOwnerId);
    try {
      const [nextValues, registryRows] = await Promise.all([
        etn.properties.get(networkId, target.ownerType, requestOwnerId),
        loadRegistryRows(),
      ]);
      values = nextValues;
      registryById = new Map(registryRows.map((row) => [row.id, row]));
    } catch (err) {
      if (requestOwnerId !== target.ownerId) return;
      if (disposed) return;
      // Отказ чтения значений (ошибка d720265c): пользователь видит сообщение,
      // а показанные строки НЕ подменяются пустотой/технической ошибкой. Прежние
      // строки этого владельца сохраняем: отказ не доказывает, что значения
      // исчезли. Метка dirty не снимается — следующий показ/канал повторит
      // чтение, и сообщение об отказе не потеряется.
      notifyPropertiesReadFailed();
      if (isConnectionLostError(err)) {
        retryStop?.();
        retryStop = onReconnected(networkId, () => void reload(true));
      }
      if (shownOwnerId === requestOwnerId && shownRows.length > 0) return;
      // Прежних строк ещё нет (первый показ): вместо технической строки
      // показываем понятное сообщение из словаря. The table is NOT bound to
      // this owner: drop the shown-owner mark so a retarget back to the
      // previous owner is re-read (задача 90b2256e, круг 3).
      shownOwnerId = null;
      tableAttached = false;
      wrap.replaceChildren(errorParagraph(t('properties.valuesReadFailed')));
      return;
    }
    if (requestOwnerId !== target.ownerId) return;
    retryStop?.();
    retryStop = null;
    if (disposed) return;
    // Поздний ответ чтения, начатого ДО изменения данных владельца, — прежний
    // снимок (ошибка da7bbb53, круг 2). Его не применяем и метку `outside` не
    // снимаем: перечитываем владельца заново — свежий ответ перекроет снимок,
    // панель не останется на значении до правки.
    if (readGeneration !== valueReadGeneration(target.ownerType, requestOwnerId)) {
      if (box.isConnected) void reload();
      return;
    }
    if (box.isConnected) everMounted = true;
    shownOwnerId = requestOwnerId;
    // Владелец прочитан, пока таблица была на экране, — метка «изменён не на
    // экране» снята у ЭТОГО потребителя (`outside`), а не у остальных: успех
    // типовой таблицы или счётчика не доказывает, что внетиповая прочитала
    // данные. Скрытая панель метку сохраняет: показ перечитает (ошибка
    // 9667b75c, круг 4).
    if (box.isConnected) {
      clearValueOwnerDirty(target.ownerType, requestOwnerId, 'outside');
    }
    // Вне типа — скаляры и свойства-связи вместе (dfaacb05): рёбра,
    // непокрытые свойствами типа, читаются внетиповыми свойствами-связями.
    const outside: Array<PropertyValue | LinkPropertyValues> = values.filter(
      (v) => v.outside_type === true,
    );
    // Локальные черновики (выбранные в пикере, но ещё не записанные): как
    // только сервер отдал строку с тем же ключом, черновик больше не нужен.
    const present = new Set(outside.map((value) => outsideRowKey(value)));
    const pending = pendingOutsideFor(target.ownerType, requestOwnerId).filter(
      (item) => !present.has(pendingOutsideKey(item)),
    );
    setPendingOutside(target.ownerType, requestOwnerId, pending);
    if (outside.length === 0 && pending.length === 0) {
      tableAttached = false;
      shownRows = [];
      rowNodes.clear();
      nav?.refresh();
      reorder?.refresh();
      wrap.replaceChildren(el('p', 'muted', 'Нет значений вне типа.'));
      return;
    }
    if (!tableAttached) {
      wrap.replaceChildren(table);
      tableAttached = true;
    }
    shownRows = outsideRows(outside, requestOwnerId, pending);
    // Повторный flush ПЕРЕД сверкой строк: чтение асинхронное, и набранное
    // могло появиться, пока оно шло. Без этого `reconcileKeyed` пересобрал бы
    // изменившуюся строку и снял поле с введённым текстом (bfe1bc24, круг 3).
    await pendingCommits.flush();
    reconcileKeyed(tbody, shownRows, rowSpec);
    afterRowsChanged();
    // Курсор в редактор значения свежевыбранной строки (сценарии 9aea535d,
    // e77c6e52): фокус ставится после того, как таблица уже в документе.
    const focusItem = pending.find((item) => item.focus);
    if (focusItem !== undefined) {
      focusItem.focus = false;
      focusOutsideValueEditor(tbody, pendingOutsideKey(focusItem));
    }
  }
  outsideReload = () => void reload();
  void reload();
  // Свой owner-гейт на realtime: событие адресуется ВЛАДЕЛЬЦУ
  // (`evt.data.owner_id`), а не «показанному». Чужой владелец показанную
  // таблицу не перечитывает (ошибка 9667b75c); скрытая панель метится
  // модульным слушателем (`noteValueOwnerChanged`) и перечитает себя на
  // `lifecycle.onShow`.
  onQueryInvalidated((prefix, _keys, cause) => {
    if (prefix !== queryKeys.focusAll() && !prefix.startsWith('focus:@')) return;
    const evt = asRealtimeCause(cause);
    if (evt === null) return;
    // Порядок, назначенный другим участником: применяем к показанным строкам
    // без перечитывания вкладки (строка с активным вводом не трогается).
    if (evt.type === 'thought.properties.reordered') {
      const data = evt.data as {
        thought_id?: unknown;
        items?: unknown;
      };
      if (
        box.isConnected &&
        typeof data.thought_id === 'string' &&
        Array.isArray(data.items)
      ) {
        applyRemoteOrder(
          data.thought_id,
          data.items as ThoughtPropertiesReorderedItem[],
        );
      }
      return;
    }
    if (evt.type === 'property-value.set' || evt.type === 'property-value.deleted') {
      // Событие о владельце, которого эта таблица не показывает, не повод
      // перечитывать и перерисовывать показанные строки.
      const data = evt.data;
      if (
        box.isConnected &&
        data.owner_type === target.ownerType &&
        data.owner_id === target.ownerId
      ) {
        void reload();
      }
    }
  });
  // Тот же локальный канал правок, что у основной таблицы (ошибка ec5ba58c):
  // новое ребро могло лечь внетиповым свойством-связью (реестрового свойства
  // типа связи нет), и без этого списка его бы не увидели.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener(PROPERTY_VALUES_REFRESHED_EVENT, () => {
      if (box.isConnected) void reload();
    });
  }
  return box;
}

/**
 * The body of the «Свойства вне типа» group: a headerless table mirroring the
 * main one, with one row per outside-type value. Скаляры — read-only: The only
 * action is «×» removing the value with a confirmation prompt (the system
 * itself never deletes such values). Свойства-связи вне типа (dfaacb05):
 * реестровое свойство (не подключённое к типу владельца) редактируется как в
 * основной таблице — запись значений внетипового свойства-связи разрешена;
 * рёбра типа связи без свойства в реестре показываются read-only чипами, но
 * удаляются по display-имени стороны (748b80fd) — команды «Удалить связь с
 * мыслью» / «Поместить связь в корзину» в меню чипа и крестик очистки набора у
 * ячейки (задача 0d4f793a, без диалога).
 *
 * Used by the standalone «Свойства вне типа» group in the «Свойства» tab
 * (task 8ab775d9); no longer rendered below the main table in the
 * «Комментарий» tab.
 */
function buildOutsideTypeTable(
  values: Array<PropertyValue | LinkPropertyValues>,
  networkId: string,
  ownerType: 'thought' | 'link',
  ownerId: string,
  onRemove: () => void,
): HTMLElement {
  const root = div('prop-outside');
  // Шапку группы рисует `groupSection` выше; внутренний `prop-outside-header`
  // дублировал её и читался как «заголовок колонок таблицы». Таблица
  // без `<thead>` — только строки значений; первая колонка содержит имя
  // свойства, вторая — редактор/чип/крестик.
  const { table, tbody } = makeOutsideTypeTable();
  root.append(table);
  const target: PropertiesTarget = {
    ownerType,
    ownerId,
    typeId: null,
    // Тест-сим одноразовой группы: владелец без типа и без подстановки.
    hasOwnType: false,
  };
  reconcileKeyed(tbody, outsideRows(values, ownerId), outsideRowSpec(networkId, target, onRemove));
  return root;
}

/**
 * Оболочка таблицы «Свойства вне типа»: `prop-grid` — фиксированная раскладка
 * двух колонок (ошибка 2012f46b): чип не раздувает таблицу своим nowrap-именем.
 * Единая точка для постоянной таблицы группы и одноразового тест-сима.
 */
function makeOutsideTypeTable(): { table: HTMLElement; tbody: HTMLElement } {
  const table = el('table', 'table-list prop-outside-table prop-grid');
  const tbody = el('tbody');
  table.append(tbody);
  return { table, tbody };
}

/** Строка таблицы «Свойства вне типа»: серверное значение либо черновик
 *  выбранного в пикере свойства (значения ещё нет — рисуется пустой редактор). */
interface OutsideRow {
  /** Владелец, под которого прочитано значение (меняется при перепривязке). */
  ownerId: string;
  value: PropertyValue | LinkPropertyValues | null;
  pending: PendingOutsideProperty | null;
}

/** Оборачивает внетиповые значения и черновики в строки keyed-сверки. */
function outsideRows(
  values: Array<PropertyValue | LinkPropertyValues>,
  ownerId: string,
  pending: readonly PendingOutsideProperty[] = [],
): OutsideRow[] {
  return [
    ...values.map((value) => ({ ownerId, value, pending: null })),
    ...pending.map((item) => ({ ownerId, value: null, pending: item })),
  ];
}

/**
 * Ключ строки «Свойства вне типа»: внетиповое значение привязано к свойству
 * реестра — `property_id` плюс СТОРОНА связи (0.14.1, аудит цикл 2 требования
 * 87039bc8: у симметричного типа связи «см. также» обе стороны несут одно имя
 * и один property_id — без стороны строки схлопнулись бы в одну). У рёбер типа
 * связи без свойства в реестре `property_id` пуст — ключом становится
 * уникальная серверная пара «тип связи + направление»; display-имя стороны для
 * этого не годится — уникальность имён типа связи только по паре
 * forward/reverse (регрессия круга 1).
 */
function outsideRowKey(value: PropertyValue | LinkPropertyValues): string {
  if (isLinkPropertyValues(value)) {
    return value.property_id !== ''
      ? `${value.property_id}:${linkSideOf(value)}`
      : `link:${value.link_type_id ?? ''}|${value.direction}`;
  }
  return value.property_id;
}

/**
 * Ключ значения для сопоставления с определением типовой строки. Та же схема,
 * что у `outsideRowKey`: у связи — `property_id` ПЛЮС сторона, у скаляра —
 * `property_id` (ошибка 45248206). После неё обе стороны симметричного
 * свойства и внетиповое значение несут один непустой `property_id`: без
 * стороны типовая строка получала последнюю запись из `values` — обычно
 * внетиповую строку ЧУЖОЙ стороны, и «×» на видимом чипе трогал значение,
 * которого пользователь не видел.
 */
function definitionValueKey(definition: EffectiveTypeProperty): string {
  return definition.value_type === 'link'
    ? `${definition.property_id}:${linkSideOf(definition)}`
    : definition.property_id;
}

/** CSS-класс выделенной (текущей) строки таблицы свойств (навигация ↑/↓). */
const PROPERTY_ROW_CURRENT_CLASS = 'prop-row-current';

/** Внетиповая строка участвует в порядке: у неё есть реестровое свойство. */
function isReorderableOutsideValue(value: PropertyValue | LinkPropertyValues): boolean {
  return value.property_id !== '';
}

/**
 * Слоты набора порядка во внетиповой группе (0.14.1, задача 2e87285b):
 * индексы видимых строк, которые адресует `PUT .../properties/order`.
 * Черновик (`pending`) и легаси-ребро (`property_id: ''`) в набор не входят
 * и слотов переупорядочиваемых строк не сдвигают — порядок черновиков и
 * легаси сохраняется оптимистичным применением.
 */
export function reorderableOutsideSlots(
  rows: readonly { pending: unknown; value: PropertyValue | LinkPropertyValues | null }[],
): number[] {
  const slots: number[] = [];
  rows.forEach((row, index) => {
    if (row.pending === null && row.value !== null && isReorderableOutsideValue(row.value)) {
      slots.push(index);
    }
  });
  return slots;
}

/** Ключ строки порядка из события: `property_id` + сторона (у скаляра — null). */
function orderItemKey(propertyId: string, side: LinkPropertySide | null): string {
  return side === null ? propertyId : `${propertyId}:${side}`;
}

/** Элемент набора порядка для внетиповой строки (сторона — только у связи). */
function toOrderItem(
  value: PropertyValue | LinkPropertyValues,
  position: number,
): ThoughtPropertyOrderInput {
  return isLinkPropertyValues(value)
    ? { property_id: value.property_id, side: linkSideOf(value), position }
    : { property_id: value.property_id, position };
}

/**
 * Первый редактор значения строки: поле ввода, контент-редактируемое поле,
 * затем первый чип. Enter активирует строку — ставит курсор в него.
 */
function focusRowValue(root: HTMLElement | null): boolean {
  if (root === null) return false;
  for (const selector of [
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '.cloud-profile-chip',
  ]) {
    const found = root.querySelector(selector) as HTMLElement | null;
    if (found !== null) {
      found.focus?.();
      return true;
    }
  }
  return false;
}

/**
 * Ближайший предок-узел (включая сам узел): у браузерного DOM — `parentElement`,
 * у DOM-шима — `parent`. Навигация/меню ищут по нему строку.
 */
function parentNodeOf(node: HTMLElement): HTMLElement | null {
  const withParent = node as unknown as {
    parentElement?: HTMLElement | null;
    parent?: HTMLElement | null;
  };
  return withParent.parentElement ?? withParent.parent ?? null;
}

/** Ставит курсор в редактор значения строки-черновика (после отрисовки). */
function focusOutsideValueEditor(tbody: HTMLElement, key: string): void {
  const focus = (): boolean => {
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const row = rows.find(
      (candidate) => candidate.getAttribute('data-outside-key') === key,
    );
    const field = row?.querySelector<HTMLElement>(
      'input, textarea, select, [contenteditable="true"]',
    );
    if (field === undefined || field === null) return false;
    field.focus();
    return true;
  };
  if (!focus()) window.setTimeout(focus, 0);
}

/**
 * Спецификация keyed-сверки строк «Свойства вне типа» — по образцу основной
 * таблицы: неизменившиеся строки не трогаются (живы фокус, прокрутка,
 * открытые редакторы), изменившуюся пересобирает `update`. `equals` включает
 * владельца: ячейки держат его замыканием, поэтому при перепривязке значение
 * перерисовывается даже внешне равным (задача 90b2256e, круг 1).
 */
function outsideRowSpec(
  networkId: string,
  target: PropertiesTarget,
  onRemove: () => void,
  registryLookup?: (propertyId: string) => PropertyRegistryRow | undefined,
  reorderOf?: (key: string) => OutsideReorderSlot | null,
  registerPendingCommit?: (commit: () => Promise<void>, key: string) => void,
): KeyedRenderSpec<OutsideRow> {
  const fill = (
    row: HTMLElement,
    value: PropertyValue | LinkPropertyValues | null,
    pending: PendingOutsideProperty | null,
  ): void => {
    row.replaceChildren();
    row.removeAttribute('data-outside-key');
    if (pending !== null) {
      fillPendingOutsideRow(
        row,
        pending,
        networkId,
        target,
        onRemove,
        pending.property.description ?? null,
        registerPendingCommit,
      );
      return;
    }
    const current = value!;
    if (isLinkPropertyValues(current)) {
      const { cell: nameCell } = buildPropertyNameCell({
        name: current.property_name,
        valueType: 'link',
        linkTypeId: current.link_type_id ?? null,
        side: linkSideOf(current),
        // ⓘ — описание свойства из справочника, как у типовой строки
        // (ревизия d9f1dd6f, верификация 9717157f).
        hint: registryLookup?.(current.property_id)?.description ?? current.description ?? null,
      });
      setTooltip(
        nameCell,
        current.property_id !== ''
          ? 'Свойство-связь не подключено к типу владельца — значения редактируются здесь; подключение свойства к типу вернёт их в основную таблицу.'
          : 'Тип связи не имеет свойства в реестре — связь видна как внетиповое свойство; удалить её можно по display-имени стороны.',
      );
      wireOutsideRowMenu(
        nameCell,
        target,
        {
          ownerType: target.ownerType,
          ownerId: target.ownerId,
          key: current.property_name,
          isLink: true,
          side: linkSideOf(current),
          linkTypeId: current.link_type_id ?? null,
          propertyId: current.property_id,
        },
        () => reorderOf?.(outsideRowKey(current)) ?? null,
      );
      row.append(nameCell);
      row.append(
        buildOutsideLinkCell(
          current,
          networkId,
          target.ownerType,
          target.ownerId,
          onRemove,
          registryLookup?.(current.property_id),
          registerPendingCommit,
        ),
      );
      return;
    }
    const { cell: nameCell } = buildPropertyNameCell({
      name: current.property_name,
      valueType: current.value_type,
      hint: registryLookup?.(current.property_id)?.description ?? null,
    });
    setTooltip(
      nameCell,
      'Свойство больше не подключено к типу владельца — значение сохраняется только для истории.',
    );
    wireOutsideRowMenu(
      nameCell,
      target,
      {
        ownerType: target.ownerType,
        ownerId: target.ownerId,
        key: current.property_name,
        isLink: false,
        side: null,
        linkTypeId: null,
        propertyId: current.property_id,
      },
      () => reorderOf?.(outsideRowKey(current)) ?? null,
    );
    row.append(nameCell);
    row.append(
      buildEditorCell({
        networkId,
        ownerType: target.ownerType,
        ownerId: target.ownerId,
        definition: outsideDefinitionFromValue(
          current,
          target.ownerType,
          registryLookup?.(current.property_id),
        ),
        current,
        onSaved: onRemove,
        ...(registerPendingCommit !== undefined ? { registerPendingCommit } : {}),
      }),
    );
  };
  return {
    key: (row) => (row.pending !== null ? pendingOutsideKey(row.pending) : outsideRowKey(row.value!)),
    build: (row) => {
      const tr = el('tr');
      fill(tr, row.value, row.pending);
      return tr;
    },
    update: (tr, row) => fill(tr, row.value, row.pending),
    equals: (a, b) => {
      if (a.ownerId !== b.ownerId) return false;
      if (a.pending !== null || b.pending !== null) {
        return (
          a.pending !== null &&
          b.pending !== null &&
          a.pending.propertyId === b.pending.propertyId &&
          a.pending.side === b.pending.side
        );
      }
      return deepEqual(a.value, b.value);
    },
  };
}

/**
 * Определение внетипового СКАЛЯРНОГО значения — по реестровой записи, если она
 * ещё известна клиенту (валидация редактора: список вариантов, множественность),
 * иначе только по форме значения. Свойство-связь собирает определение у себя.
 */
function outsideDefinitionFromValue(
  value: PropertyValue,
  ownerType: 'thought' | 'link',
  registry?: PropertyRegistryRow,
): EffectiveTypeProperty {
  return {
    id: value.property_id,
    property_id: value.property_id,
    owner_type: ownerType === 'thought' ? 'thought_type' : 'link_type',
    owner_id: '',
    key: value.property_name,
    value_type: value.value_type,
    config: registry?.config ?? null,
    required: false,
    position: 0,
    description: registry?.description ?? null,
    inherited: false,
    defined_on: '',
    defined_on_name: '',
    default_value: null,
    overridden_here: false,
    description_overridden: false,
  };
}

/**
 * Ячейка строки-черновика: имя выбранного свойства (у связи — сторона, значок
 * направления) и тот же общий редактор значения, что у серверной строки.
 * Значение пишется ключом display-имени стороны + `side` — это различает
 * симметричные имена типа связи (аудит цикл 2 требования 87039bc8).
 */
function fillPendingOutsideRow(
  row: HTMLElement,
  pending: PendingOutsideProperty,
  networkId: string,
  target: PropertiesTarget,
  onChanged: () => void,
  hint: string | null = null,
  registerPendingCommit?: (commit: () => Promise<void>, key: string) => void,
): void {
  const definition = pendingOutsideDefinition(pending, target.ownerType);
  const isLink = definition.value_type === 'link';
  row.setAttribute('data-outside-key', pendingOutsideKey(pending));
  const { cell: nameCell } = buildPropertyNameCell({
    name: pending.name,
    valueType: definition.value_type,
    linkTypeId: pending.linkTypeId,
    side: pending.side,
    hint,
  });
  if (isLink) {
    setTooltip(
      nameCell,
      'Свойство-связь не подключено к типу владельца — введите значения здесь; подключение свойства к типу вернёт их в основную таблицу.',
    );
  } else {
    setTooltip(
      nameCell,
      'Свойство не подключено к типу владельца — введите значение здесь; подключение свойства к типу вернёт его в основную таблицу.',
    );
  }
  wireOutsideRowMenu(nameCell, target, {
    ownerType: target.ownerType,
    ownerId: target.ownerId,
    key: pending.name,
    isLink,
    side: pending.side,
    linkTypeId: pending.linkTypeId,
    propertyId: pending.propertyId,
    pendingKey: pendingOutsideKey(pending),
  });
  row.append(nameCell);
  row.append(
    buildEditorCell({
      networkId,
      ownerType: target.ownerType,
      ownerId: target.ownerId,
      definition,
      current: undefined,
      side: pending.side,
      onSaved: onChanged,
      ...(registerPendingCommit !== undefined ? { registerPendingCommit } : {}),
    }),
  );
}

/**
 * Определение внетипового свойства-связи из серверной проекции значения.
 * Сторона переносится из самой строки: у двухстороннего свойства обе стороны
 * несут один `property_id` (ошибка 45248206), и без `side` снятие рёбер
 * совпадает с обеими сторонами. Ограничение типов значения — из привязок
 * реестра по стороне строки (`binding_*_type_ids`): та же семантика
 * противоположного конца, что у типовой строки (ошибка f8f8fa49). Legacy-ключи
 * `config.allowed_*_type_ids` редактор значения не читает.
 */
function outsideLinkDefinition(
  value: LinkPropertyValues,
  ownerType: 'thought' | 'link',
  registry?: PropertyRegistryRow,
): EffectiveTypeProperty {
  const side = linkSideOf(value);
  const config: PropertyConfig = {};
  if (value.link_type_id !== null) {
    config['link_type_id'] = value.link_type_id;
  } else {
    config['structural'] = true;
  }
  config['direction'] = sideDirection(side);
  return {
    id: value.property_id,
    property_id: value.property_id,
    owner_type: ownerType === 'thought' ? 'thought_type' : 'link_type',
    owner_id: '',
    key: value.property_name,
    value_type: 'link',
    config,
    required: false,
    position: 0,
    description: value.description ?? null,
    inherited: false,
    defined_on: '',
    defined_on_name: '',
    default_value: null,
    overridden_here: false,
    description_overridden: false,
    side,
    allowed_opposite_type_ids: registryAllowedOppositeTypeIds(registry, side),
  };
}

/**
 * Ячейка внетипового свойства-связи. Свойство есть в реестре (не подключено
 * к типу владельца) — полноценный редактор значения через общий
 * `buildValueEditor`, тот же, что в основной таблице: запись значения
 * внетипового свойства-связи разрешена (dfaacb05). Рёбра типа связи без
 * реестрового свойства — read-only чипи с удалением по display-имени стороны
 * (748b80fd): команды «Удалить связь с мыслью» / «Поместить связь в корзину» в
 * меню чипа и «×» очистки набора у ячейки (задача 0d4f793a, без диалога).
 */
function buildOutsideLinkCell(
  value: LinkPropertyValues,
  networkId: string,
  ownerType: 'thought' | 'link',
  ownerId: string,
  onRemove: () => void,
  /** Реестровая строка свойства — носитель производных типов привязок по
   *  сторонам (`binding_*_type_ids`, ошибка f8f8fa49); недоступна —
   *  определение без ограничения. */
  registry?: PropertyRegistryRow,
  registerPendingCommit?: (commit: () => Promise<void>, key: string) => void,
): HTMLElement {
  if (value.property_id !== '') {
    // Сторона входит в определение и уходит в редактор значения: и запись,
    // и снятие рёбер адресуют сторону строки (аудит цикл 2 требования
    // 87039bc8, ошибка 45248206).
    const side = linkSideOf(value);
    const definition = outsideLinkDefinition(value, ownerType, registry);
    const cell = buildEditorCell({
      networkId,
      ownerType,
      ownerId,
      definition,
      current: value,
      side,
      onSaved: onRemove,
      ...(registerPendingCommit !== undefined ? { registerPendingCommit } : {}),
    });
    cell.classList.add('prop-outside-cell');
    return cell;
  }

  const cell = el('td', 'prop-outside-cell');
  // Сторона выведенного из имени ребра: у симметричного типа связи имя одно
  // для обеих сторон, и адрес записи/удаления без `side` неоднозначен.
  const side = linkSideOf(value);

  /**
   * Обычная запись значения-связи ключом `key` (сервер помечает отозванные
   * рёбра в корзину). Общий `commit` для диалога снятия значения (задача
   * 96d27fc0) — карта перечитывает окрестность сразу (ошибка f0b959dd).
   */
  const writeOutsideEdgeSet = async (key: string, remaining: string[]): Promise<boolean> => {
    try {
      await etn.properties.set(
        networkId,
        ownerType,
        ownerId,
        key,
        remaining.length > 0 ? remaining : null,
        side,
      );
      repaintAfterLinkValueWrite(ownerType, ownerId);
      // Своё значение свойства-связи меняет состав публикации: сигнал слоя
      // (до B1; гейт `repaintAfterLinkValueWrite` по фокусу здесь не годится —
      // публикация может быть открыта и без фокуса на владельце).
      signalCompositionForOwner(ownerType, ownerId);
      onRemove();
      return true;
    } catch (err) {
      notice(`Не удалось удалить значение: ${errText(err)}`, 'error');
      return false;
    }
  };

  // Read-only рёбра вне типа (тип связи без реестрового свойства): те же
  // оформление и обработчики, что у чипа основной таблицы — cab38479.
  //
  // 0.8.2, ошибка 748b80fd: ключом записи служит display-имя стороны связи
  // (`value.property_name`), которое сервер понимает (`resolveDefinition`
  // шаг 3). Поэтому у чипов появляются команды «Удалить связь с мыслью» /
  // «Поместить связь в корзину» (задача 0d4f793a), а у ячейки — крестик «×»
  // очистки набора целиком без диалога (как у реестровых внетиповых,
  // cab38479). Направление сервер берёт из имени стороны (или из `side`, когда
  // имена симметричны), так что удаляется именно это ребро, а не типовое
  // входящее.
  const propertyKey = value.property_name;
  const currentIds = value.values.map((edge) => edge.target_id);
  // Команды меню чипа снимают одно ребро тем же авто-выбором (задача
  // 0d4f793a). Запись значения сервер понимает по display-имени стороны.
  const removeTarget = (targetId: string, mode: LinkValueRemovalMode): void => {
    void removeLinkValueEdges({
      networkId,
      ownerType,
      ownerId,
      propertyKey,
      propertyId: value.property_id,
      side: value.side ?? null,
      removedTargetIds: [targetId],
      mode,
      commit: () => writeOutsideEdgeSet(propertyKey, currentIds.filter((id) => id !== targetId)),
    });
  };
  const wrap = div('link-value-editor');
  if (value.values.length === 0) {
    wrap.append(span('—', 'muted'));
  }
  const refs = new Map<string, ThoughtRef>();
  for (const edge of value.values) {
    wrap.append(buildOutsideReadonlyEdgeChip(networkId, edge, refs, { removeTarget }));
  }
  cell.append(wrap);
  // Крестик очищает внетиповой набор целиком: запись без целей отзывает все
  // рёбра выведенной из имени стороны; способ выбирается автоматически без
  // диалога (задача 0d4f793a).
  const clearBtn = el('button', 'st-f-clear-inline prop-outside-remove', '×');
  clearBtn.type = 'button';
  clearBtn.title = 'Удалить значение';
  clearBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (currentIds.length === 0) return;
    void removeLinkValueEdges({
      networkId,
      ownerType,
      ownerId,
      propertyKey,
      propertyId: value.property_id,
      side: value.side ?? null,
      removedTargetIds: currentIds,
      mode: 'auto',
      commit: () => writeOutsideEdgeSet(propertyKey, []),
      });
    });
    cell.append(clearBtn);
    // Подтянем стили/иконки батчем (cb73f8d6, как в buildLinkValueEditor);
    // без этого чипы рендерятся с дефолтной иконкой и без цвета мысли.
    if (value.values.length > 0) {
      void etn.thoughts
        .resolve(
          networkId,
          value.values.map((edge) => edge.target_id).slice(0, RESOLVE_BATCH),
        )
        .then((resolved) => {
          if (!wrap.isConnected) return;
          for (const ref of resolved) refs.set(ref.id, ref);
          wrap.replaceChildren(
            ...value.values.map((edge) =>
              buildOutsideReadonlyEdgeChip(networkId, edge, refs, { removeTarget }),
            ),
          );
        })
        .catch(() => undefined);
    }
    return cell;
  }

/** Cap on the batched resolve call — server-side limit of `thoughts.resolve`. */
const RESOLVE_BATCH = 100;

/** Builds the «Свойства типа» body — основная таблица редактирования. */
function buildTypePropertiesBody(
  networkId: string,
  target: PropertiesTarget,
  typeOwner: 'thought_type' | 'link_type',
  typedId: string,
  lifecycle?: TabPaneLifecycle,
): HTMLElement {
  const box = div('properties-type-body');
  const tableWrap = div('admin-table-wrap prop-wrap');
  tableWrap.append(span('Загрузка…', 'muted'));
  box.append(tableWrap);

  let everMounted = false;
  /**
   * Недописанные значения открытых редакторов этой таблицы: фиксируются до
   * пересборки строк (`reconcileKeyed`), снятия тела группы и закрытия
   * карточки — снятый узел blur не получает (ошибка bfe1bc24).
   */
  const pendingCommits = createPendingValueCommits();
  currentFlush = () => void pendingCommits.flush();
  /**
   * Прикреплена ли таблица к обёртке. Пока нет — в обёртке стоит плейсхолдер
   * («Загрузка…» / ошибка / пустой набор); прикрепив таблицу один раз, держим
   * её и обновляем СТРОКИ инкрементально (`reconcileKeyed`), не пересобирая
   * коллекцию (задача 90b2256e, стандарт «Списки рендерятся инкрементально»).
   */
  let tableAttached = false;
  /**
   * Владелец, чьи значения сейчас нарисованы в таблице. Гард ниже пропускает
   * перечитывание ОТСОЕДИНЁННОЙ панели, только если владелец не сменился: смена
   * сущности того же типа обязана обновить скрытую панель (задача 90b2256e,
   * круг 3), иначе при возврате на вкладку видны значения прежней сущности, а
   * ячейки держат замыкание со старым ownerId.
   */
  let shownOwnerId: string | null = null;
  // `prop-grid` — фиксированная раскладка двух колонок «имя → значение»
  // (ошибка 2012f46b): чип не диктует таблице min-content своего nowrap-имени.
  const table = el('table', 'table-list prop-table prop-grid');
  const tbody = el('tbody');
  table.append(tbody);

  /** Строка таблицы: определение свойства + его текущее значение. */
  interface PropertyRow {
    /** Владелец, под которого читалось значение (меняется при перепривязке). */
    ownerId: string;
    definition: EffectiveTypeProperty;
    value: PropertyValue | LinkPropertyValues | undefined;
    /**
     * Значение не прочитано (`properties.get` отказал), прежнего значения у
     * строки ещё нет: вместо пустого редактора показываем явную пометку —
     * пустая строка читалась бы как «значение стёрто» (ошибка d720265c).
     */
    unreadable: boolean;
  }

  /** Собирает строку строки таблицы: имя (+ ⓘ) и ячейку значения. */
  const fillRow = (
    row: HTMLElement,
    definition: EffectiveTypeProperty,
    value: PropertyValue | LinkPropertyValues | undefined,
    unreadable: boolean,
  ): void => {
    row.replaceChildren();
    // Заголовок при заполнении: имя (+ « *» обязательности) и число значений
    // у множественных свойств; тип значения и место определения здесь не
    // нужны — это информация редактора типа (приёмка пользователя 0.8.1).
    // ⓘ несёт tooltip с описанием свойства. Текст заголовка — отдельный узел:
    // счётчик обновляется локально после своей записи значения-связи (ошибка
    // 9ee8e608) без пересборки строки, а ⓘ остаётся на месте.
    const count = valueCountOf(definition, value);
    const isLink = definition.value_type === 'link';
    const side = isLink ? linkSideOf(definition) : null;
    const linkTypeIdRaw = definition.config?.link_type_id;
    const linkTypeId =
      typeof linkTypeIdRaw === 'string' && linkTypeIdRaw !== '' ? linkTypeIdRaw : null;
    // Один компонент ячейки имени с внетиповыми строками (9717157f): значок
    // вида значения/стороны связи, имя, ⓘ описания — без второй разметки.
    const { cell: nameCell, nameText } = buildPropertyNameCell({
      name: propertyNameLabel(definition, count),
      valueType: definition.value_type,
      linkTypeId,
      side,
      hint: propertyHint(definition),
    });
    // Контекстное меню имени строки (0.14.1, задача 92172035, требование
    // 53701739): состав по состоянию строки, действия — серверные операции.
    wirePropertyRowMenu(
      nameCell,
      {
        structural: definition.config?.structural === true,
        typed: true,
        hasType: true,
        hasRegistryProperty: definition.property_id !== '',
      },
      {
        edit: () => void openPropertyEditorById(definition.property_id),
        clear: () =>
          void clearRowValue({
            ownerType: target.ownerType,
            ownerId: target.ownerId,
            key: definition.key,
            isLink,
            side,
            linkTypeId,
          }),
        promote: () => undefined,
        exclude: () =>
          void excludeTypedProperty({
            ownerType: target.ownerType,
            typeId: typedId,
            propertyId: definition.property_id,
            side,
          }),
        remove: () => undefined,
      },
    );
    row.append(nameCell);
    if (unreadable) {
      // Значение не прочитано и прежнего нет: пустой редактор выглядел бы как
      // «значение стёрто» — показываем явную пометку (ошибка d720265c).
      row.append(el('td', 'prop-unreadable muted', t('properties.valueUnreadable')));
      return;
    }
    row.append(
      buildEditorCell({
        networkId,
        ownerType: target.ownerType,
        ownerId: target.ownerId,
        definition,
        current: value,
        // Сторона адресует запись связи при симметричных именах (аудит цикл 2
        // требования 87039bc8).
        side: definition.value_type === 'link' ? linkSideOf(definition) : null,
        // Своя запись значения-связи не поднимает версию мысли (гейт полной
        // пересборки `mountEditor` не срабатывает), а realtime-эхо своего
        // клиента приходит асинхронно (B1) (G8) — счётчик строки, нарисованный
        // при `reload()`, перерисовываем здесь же (ошибка 9ee8e608).
        onLinkCountChange: (next) => {
          nameText.textContent = propertyNameLabel(definition, next);
        },
        registerPendingCommit: pendingCommits.register,
      }),
    );
  };

  /**
   * Спецификация keyed-сверки строк: ключ — id привязки (уникален в
   * эффективном наборе; `property_id` может повторяться при разных привязках).
   * Неизменившиеся строки (ни определение, ни значение) не трогаются — живы их
   * открытые редакторы значений, фокус и прокрутка. Изменившуюся строку
   * пересобираем целиком: значение вводит общий `buildValueEditor`, точечного
   * апдейта у него нет.
   */
  const rowSpec: KeyedRenderSpec<PropertyRow> = {
    key: (row) => (row.definition.id !== '' ? row.definition.id : row.definition.property_id),
    build: (row) => {
      const tr = el('tr');
      fillRow(tr, row.definition, row.value, row.unreadable);
      return tr;
    },
    update: (tr, row) => fillRow(tr, row.definition, row.value, row.unreadable),
    // A row is reused only within the SAME owner: on a retarget to another
    // entity the value cell must be rebuilt even when the displayed value looks
    // equal (an empty value still writes through the OLD owner closure
    // otherwise — задача 90b2256e, круг 1). Пометка «не удалось прочитать»
    // тоже часть состояния строки (ошибка d720265c).
    equals: (a, b) =>
      a.ownerId === b.ownerId &&
      a.unreadable === b.unreadable &&
      deepEqual(a.definition, b.definition) &&
      deepEqual(a.value, b.value),
  };

  /**
   * Видимые строки «Свойства типа» — источник клавиатурной навигации (0.14.1,
   * задача 2e87285b). Порядок типовых строк задан привязками и не меняется.
   */
  let shownRows: PropertyRow[] = [];
  const rowNodes = new Map<string, { tr: HTMLElement; nameCell: HTMLElement }>();
  const rowKeyOf = (row: PropertyRow): string =>
    row.definition.id !== '' ? row.definition.id : row.definition.property_id;
  const collectRowNodes = (): void => {
    rowNodes.clear();
    for (const child of Array.from(tbody.children) as HTMLElement[]) {
      const key = child.getAttribute('data-key');
      if (key === null) continue;
      const nameCell = child.querySelector('.prop-name-cell') as HTMLElement | null;
      if (nameCell !== null) rowNodes.set(key, { tr: child, nameCell });
    }
  };
  const rowOfNode = (start: HTMLElement | null): PropertyRow | null => {
    let node: HTMLElement | null = start;
    while (node !== null && node !== box) {
      if ((node.tagName ?? '').toLowerCase() === 'tr') {
        const key = node.getAttribute('data-key');
        if (key !== null) return shownRows.find((row) => rowKeyOf(row) === key) ?? null;
      }
      node = parentNodeOf(node);
    }
    return null;
  };
  /** Навигация ↑/↓/Enter — общий компонент списка над ядром nav-core. */
  let nav: ListNavHandle<PropertyRow> | null = null;
  nav = createListNav<PropertyRow>(box, {
    entries: () => shownRows,
    tokenOf: rowKeyOf,
    elementOf: (row) => rowNodes.get(rowKeyOf(row))?.tr ?? null,
    applyHighlight: (row) => {
      const key = row === null ? null : rowKeyOf(row);
      for (const [candidate, node] of rowNodes) {
        node.tr.classList.toggle(PROPERTY_ROW_CURRENT_CLASS, candidate === key);
      }
    },
    focus: (row) => rowNodes.get(rowKeyOf(row))?.nameCell.focus?.(),
    reveal: (row) => rowNodes.get(rowKeyOf(row))?.tr.scrollIntoView?.({ block: 'nearest' }),
    onClick: (target) => {
      const row = rowOfNode(target);
      if (row !== null) nav?.setCurrent(row);
    },
    onActivate: (row) => {
      const node = rowNodes.get(rowKeyOf(row));
      if (node === undefined) return;
      if (!focusRowValue(node.tr)) node.nameCell.focus?.();
    },
  });
  lifecycle?.onDispose(() => {
    nav?.destroy();
    nav = null;
  });

  /** Retry watch armed while a connection-lost error is on screen (de34b35b). */
  let retryStop: (() => void) | null = null;
  let disposed = false;
  lifecycle?.onDispose(() => {
    disposed = true;
    retryStop?.();
    retryStop = null;
    // Карточка закрывается/панель пересобирается: набранное в чип-полях и
    // скалярных полях без Enter фиксируем до исчезновения узлов (bfe1bc24).
    void pendingCommits.flush();
  });
  currentReload = () => void reload();
  // Слушаем локальное уведомление о правке значений (общий канал
  // `PROPERTY_VALUES_REFRESHED_EVENT`, задача 7849008a / ошибка ec5ba58c):
  // снапшот имени после `crossResolve`, а также правка ребра с КАРТЫ (диалог
  // добавления, перетаскивание облачка, связь эллипсом) и значения-связи из
  // другого места холста меняют значения фокусной мысли, а карточка в памяти
  // держит старый снимок. `document.addEventListener` доступен только в
  // DOM-окружении: в юнит-тестах DOM-шим пропускает `document` — гард через
  // typeof.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener(PROPERTY_VALUES_REFRESHED_EVENT, () => {
      if (box.isConnected) void reload();
    });
  }
  void reload();

  async function reload(force = false): Promise<void> {
    // Token of THIS reload: the owner it reads for. The pane survives an entity
    // switch (registerTabRetarget → retargetCurrent), so a slow response of the
    // PREVIOUS owner must not be applied to the NEW one — otherwise its values
    // would be written with the new ownerId and could save onto the wrong
    // entity (task 90b2256e, круг 2).
    const requestOwnerId = target.ownerId;
    // A detached pane skips only a REDUNDANT reload of the owner it already
    // shows; an owner change must proceed even while hidden (круг 3), and a
    // reconnect retry must always read (force).
    if (!force && everMounted && !box.isConnected && requestOwnerId === shownOwnerId) return;
    // Недописанное значение строки фиксируем ДО чтения и сверки: сверка ниже
    // пересобирает изменившиеся строки (`fillRow` → `replaceChildren`), а
    // снятый сфокусированный узел blur не получает (ошибка bfe1bc24). Запись
    // идёт замыканием строки — её владелец захвачен при построении.
    void pendingCommits.flush();
    const startedAt = Date.now();
    // Плейсхолдер — только пока таблица не прикреплена; иначе инкрементальное
    // обновление не мигает «Загрузкой…» на каждой правке значения.
    if (!tableAttached) tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let definitions: EffectiveTypeProperty[];
    try {
      definitions = await etn.types.listTypeProperties(networkId, typeOwner, typedId);
    } catch (err) {
      if (requestOwnerId !== target.ownerId) return;
      if (disposed) return;
      // Отказ чтения определений типа (ошибка f803afb6): это ПЕРВОЕ чтение
      // панели, и раньше catch заменял таблицу `operationError(err)` — строки
      // исчезали, а технический английский текст отказа main («Not connected:
      // …») попадал в интерфейс. Теперь отказ сообщается словарным текстом
      // (тот же, что у отказа значений: одна серия отказов даёт одно
      // сообщение), а строки этого владельца сохраняются как есть — их
      // значения и редакторы остаются последним успешным снимком (ошибка
      // d720265c).
      notifyPropertiesReadFailed();
      // Повтор чтения после восстановления связи — как у отказа значений.
      // `isConnectionLostError` распознаёт и канонический «Not connected…» без
      // details.kind (ошибка f803afb6).
      if (isConnectionLostError(err)) {
        retryStop?.();
        retryStop = onReconnected(networkId, () => void reload(true));
      }
      const hasPreviousRows =
        tableAttached && shownRows.some((row) => row.ownerId === requestOwnerId);
      if (hasPreviousRows) return;
      // Прежних строк нет (первый показ владельца): строить таблицу не из
      // чего, определений тоже нет. Вместо технической строки — сообщение из
      // словаря; метку владельца снимаем, чтобы возврат/переключение
      // перечитали его заново (90b2256e, круг 3).
      shownOwnerId = null;
      tableAttached = false;
      tableWrap.replaceChildren(errorParagraph(t('properties.valuesReadFailed')));
      return;
    }
    // The owner changed while the definitions were in flight — the retarget's
    // own reload (fired by `retargetCurrent`) is authoritative; drop this one.
    if (requestOwnerId !== target.ownerId) return;
    retryStop?.();
    retryStop = null;
    if (disposed) return;
    if (box.isConnected) everMounted = true;
    // From here the table is considered bound to this owner (even the empty-set
    // branch below) — the detached-pane guard keys off it.
    shownOwnerId = requestOwnerId;
    // Индекс показанных определений (ошибка 74b94c26): realtime-события
    // `property-definition.updated/deleted` несут только id привязки, поэтому
    // владельца для гейта берут из того, что реально отрисовано сейчас.
    rememberShownDefinitions(definitions);
    if (definitions.length === 0) {
      shownRows = [];
      rowNodes.clear();
      nav?.refresh();
      tableWrap.replaceChildren(el('p', 'muted', 'У типа нет свойств.'));
      tableAttached = false;
      return;
    }
    let values: Array<PropertyValue | LinkPropertyValues> = [];
    let valuesRead = false;
    let valuesError: unknown = null;
    // Поколение чтения (ошибка da7bbb53, круг 2) фиксируем ДО запроса: ответ
    // актуален, только если значения владельца не изменили, пока он был в пути.
    const readGeneration = valueReadGeneration(target.ownerType, requestOwnerId);
    try {
      values = await etn.properties.get(networkId, target.ownerType, requestOwnerId);
      valuesRead = true;
    } catch (err) {
      // Отказ чтения значений (ошибка d720265c): таблица по определениям
      // остаётся на экране, строки сохраняют прежние значения (или явную
      // пометку «не удалось прочитать»), а отказ сообщается пользователю.
      valuesError = err;
    }
    // Same guard after the values fetch — the slowest leg of the pair.
    if (requestOwnerId !== target.ownerId) return;
    // Поздний ответ чтения, начатого ДО изменения данных владельца, — прежний
    // снимок (ошибка da7bbb53, круг 2): не применяем его и метку `typed` не
    // снимаем, а перечитываем владельца. Свежий ответ перекроет снимок, и
    // панель не останется на значении до правки.
    if (valuesRead && readGeneration !== valueReadGeneration(target.ownerType, requestOwnerId)) {
      if (box.isConnected) void reload();
      return;
    }
    if (!valuesRead) {
      notifyPropertiesReadFailed();
      // Обрыв связи: повторяем чтение после переподключения. Тост дедуплицирует
      // одинаковый текст, поэтому серия отказов не даёт спама.
      if (isConnectionLostError(valuesError)) {
        // Здесь `retryStop` уже снят успешным чтением определений (выше) —
        // ставим новый сторож переподключения без повторной остановки.
        retryStop = onReconnected(networkId, () => void reload(true));
      }
    }
    // Метка «изменён не на экране» снимается только после УСПЕШНОГО чтения
    // значений (замечание верификатора к 9667b75c, круг 3): при транзиентном
    // отказе значения не прочитаны, и метка должна остаться, чтобы следующий
    // показ повторил чтение. И только у СВОЕГО потребителя (`typed`): успех
    // типовой таблицы не снимает нужду перечитать внетиповую/счётчик, чьё
    // чтение в этом показе могло отказать (круг 4); скрытая панель сохраняет
    // все метки до показа.
    if (valuesRead && box.isConnected) {
      clearValueOwnerDirty(target.ownerType, requestOwnerId, 'typed');
    }
    // Ключ — свойство + сторона связи (ошибка 45248206): один `property_id`
    // на обе стороны; сопоставление только по id отдавало типовой строке
    // значение чужой стороны.
    const valueByKey = new Map(values.map((v) => [outsideRowKey(v), v]));
    // Прежние строки ЭТОГО владельца — единственный достоверный снимок
    // значений, когда чтение отказало (ошибка d720265c). Строки другого
    // владельца не переезжают: `rowSpec.equals` всё равно требует совпадения
    // ownerId, а значения чужой сущности сохранять нельзя (90b2256e).
    const previousByKey = new Map(
      shownRows
        .filter((row) => row.ownerId === requestOwnerId)
        .map((row) => [definitionValueKey(row.definition), row]),
    );
    if (!tableAttached) {
      tableWrap.replaceChildren(table);
      tableAttached = true;
    }
    const rows: PropertyRow[] = definitions.map((definition) => {
      const key = definitionValueKey(definition);
      if (valuesRead) {
        return {
          ownerId: requestOwnerId,
          definition,
          value: valueByKey.get(key),
          unreadable: false,
        };
      }
      const previous = previousByKey.get(key);
      if (previous !== undefined) {
        // Прежнее значение (в том числе честно пустое) сохраняется как есть:
        // отказ чтения не означает, что значение стёрто.
        return {
          ownerId: requestOwnerId,
          definition,
          value: previous.value,
          unreadable: previous.unreadable,
        };
      }
      // Прежнего значения ещё нет — явная пометка вместо пустого редактора.
      return {
        ownerId: requestOwnerId,
        definition,
        value: undefined,
        unreadable: true,
      };
    });
    shownRows = rows;
    // Повторный flush ПЕРЕД сверкой строк: definitions/values читаются
    // асинхронно, и набранное могло появиться, пока чтение шло. Без этого
    // `reconcileKeyed` пересобрал бы изменившуюся строку и снял поле с
    // введённым текстом (bfe1bc24, круг 3).
    await pendingCommits.flush();
    reconcileKeyed(tbody, rows, rowSpec);
    collectRowNodes();
    nav?.refresh();
    logUiEvent('ui.editor.props.loaded', {
      id: requestOwnerId,
      ms: Date.now() - startedAt,
      definitions: definitions.length,
    });
  }

  return box;
}

/**
 * Реестр «зафиксировать набранное без Enter» у открытых редакторов одной
 * таблицы значений. Строка пересобирается через `replaceChildren`/`fillRow`,
 * тело группы снимается с экрана — в этих случаях сфокусированный узел не
 * получает `blur`, а его замыкание держит единственную копию набранного.
 * Регистрация хранится по ключу строки: пересборка строки заменяет коммит,
 * а перечитывание без изменения строки (`reconcileKeyed` обновляет только
 * изменившиеся) сохраняет его — иначе следующий flush был бы пуст
 * (bfe1bc24, круг 2).
 */
interface PendingValueCommits {
  register(commit: () => Promise<void>, key: string): void;
  flush(): Promise<void>;
}

function createPendingValueCommits(): PendingValueCommits {
  const commits = new Map<string, () => Promise<void>>();
  return {
    register(commit, key) {
      commits.set(key, commit);
    },
    flush() {
      if (commits.size === 0) return Promise.resolve();
      // Набор НЕ очищается: иначе редактор неизменённой строки терял
      // регистрацию навсегда. Повторный вызов идемпотентен — скаляры
      // сравнивают значение с baseline, чип-поле видит уже пустой ввод.
      return Promise.all([...commits.values()].map((commit) => commit())).then(
        () => undefined,
      );
    },
  };
}

/** Builds the value editor cell for one property — поле строит общий
 *  `buildValueEditor` (стандарт S2); здесь только сохранение и форма значения. */
function buildEditorCell(opts: {
  networkId: string;
  ownerType: 'thought' | 'link';
  ownerId: string;
  definition: EffectiveTypeProperty;
  current: PropertyValue | LinkPropertyValues | undefined;
  /**
   * Сторона записи свойства-связи (0.14.1, требование 87039bc8): у
   * симметричного типа связи display-имя одинаково у обеих сторон, и без
   * `side` сервер не может различить адрес. `null`/не задано — обычная
   * запись по имени.
   */
  side?: LinkPropertySide | null;
  /** Обновление счётчика значений в заголовке строки после своей записи
   *  свойства-связи (ошибка 9ee8e608). Скаляры его не зовут. */
  onLinkCountChange?: (count: number) => void;
  /** Своя запись прошла успешно — перечитать таблицу (внетиповые строки,
   *  черновики: после записи строка становится серверной). */
  onSaved?: () => void;
  /** Реестр таблицы: сюда редактор отдаёт «зафиксировать набранное без Enter»
   *  (ошибка bfe1bc24) — фиксация до пересборки строки/снятия тела. Ключ —
   *  строка таблицы: повторная сборка заменяет коммит, неизменённая строка
   *  сохраняет регистрацию между перечитываниями (круг 2). */
  registerPendingCommit?: (commit: () => Promise<void>, key: string) => void;
}): HTMLElement {
  const { networkId, ownerType, ownerId, definition, current } = opts;
  // Ключ строки: свойство + сторона у связи + владелец. Пересборка строки
  // (`fillRow`) регистрирует новый коммит под тем же ключом.
  const commitKey = `${ownerType}:${ownerId}:${definition.id}:${opts.side ?? ''}`;
  const registerPending = opts.registerPendingCommit;
  const cell = el('td');
  const stored = current !== undefined && current.value_type !== 'link' ? current.value : null;

  const save = async (value: unknown | null): Promise<boolean> => {
    try {
      if (value === null && definition.value_type !== 'link') {
        await etn.properties.remove(networkId, ownerType, ownerId, definition.key);
      } else {
        // Свойство-связь очищается тоже через set: `set(null)` убирает все
        // рёбра свойства (normalizeLinkTargets → []), а DELETE /properties
        // для связей — no-op (в property_values ничего не хранится).
        await etn.properties.set(
          networkId,
          ownerType,
          ownerId,
          definition.key,
          value,
          definition.value_type === 'link' ? opts.side ?? null : null,
        );
      }
      // Своя запись значения свойства меняет состав публикации: сигнал слоя
      // (до B1). Скаляр — как в realtime `property-value.set` — тоже помечает
      // живой текст устаревшим.
      signalCompositionForOwner(ownerType, ownerId);
      // Свойство-связь создало/убрало РЕБРО серверной записью (ошибка
      // f0b959dd): своё событие приходит асинхронно (B1) — окрестность фокуса
      // перечитываем сразу после успешного сохранения (идемпотентный ускоритель).
      if (definition.value_type === 'link') {
        repaintAfterLinkValueWrite(ownerType, ownerId);
        // Число целей в заголовке строки рисуется при `reload()` и после
        // своей записи не перечитывалось (ошибка 9ee8e608): своё событие
        // приходит асинхронно (B1), версию мысли
        // запись значения не поднимает — гейт полной пересборки редактора не
        // срабатывает. Новое число целей известно из записанного набора
        // (`save` получает массив target_id, `null` — очистка).
        opts.onLinkCountChange?.(linkTargetCount(value));
      }
      opts.onSaved?.();
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

    // Свойство-связь — форма LinkPropertyValues: значения это живые рёбра
    // (`values[].target_id`), поля `.value` у формы нет. Редактор всегда
    // чип-режим (число целей не ограничено, модель 0.8.1).
    const edges =
      current !== undefined && isLinkPropertyValues(current) ? current.values : [];
    cell.append(
      buildValueEditor({
        networkId,
        ownerType,
        ownerId,
        definition,
        value: definition.value_type === 'link' ? edges : stored,
        save,
        // История последних значений (требование f6399882): у value-editor
        // она подключается по ключу network+property для text/url/link —
        // включая свойства-связи (ошибка 880c3add).
        historyPropertyId: definition.property_id,
        // «Зафиксировать набранное без Enter» — в реестр таблицы (bfe1bc24):
        // ключ строки добавляется здесь, контракт общего редактора не меняется.
        ...(registerPending !== undefined
          ? {
              registerPendingCommit: (commit: () => Promise<void>): void =>
                registerPending(commit, commitKey),
            }
          : {}),
      }),
    );
  return cell;
}

/**
 * Заголовок строки свойства в таблице «Свойства типа»: имя, маркер
 * обязательности и счётчик значений у множественных/связевых свойств (приёмка
 * 0.8.1). Один источник и для первичной отрисовки при `reload()`, и для
 * локального обновления счётчика после своей записи (ошибка 9ee8e608).
 */
function propertyNameLabel(definition: EffectiveTypeProperty, count: number | null): string {
  return `${definition.key}${definition.required ? ' *' : ''}${count === null ? '' : ` (${count})`}`;
}

/**
 * Число целей в записанном значении свойства-связи. `save` редактора связи
 * получает массив `target_id` (или `null` при очистке) — ровно то, что
 * `normalizeLinkTargets` положит рёбрами свойства; счётчик строки обновляется
 * этим числом без обращения к серверу (ошибка 9ee8e608).
 */
function linkTargetCount(written: unknown | null): number {
  return Array.isArray(written) ? written.length : 0;
}

/**
 * Число текущих значений для заголовка множественного свойства (приёмка
 * пользователя 0.8.1: «Работы версии (4)»): свойства-связи множественны по
 * природе (число целей не ограничено) — счётчик берётся из формы
 * `LinkPropertyValues`; `url`/`text` с `config.multiple` считают элементы
 * массива / фрагменты запятой. `null` — свойство одиночное, счётчик не нужен.
 */
function valueCountOf(
  definition: EffectiveTypeProperty,
  value: PropertyValue | LinkPropertyValues | undefined,
): number | null {
  if (definition.value_type === 'link') {
    return value !== undefined && isLinkPropertyValues(value) ? value.count : 0;
  }
  if (definition.config?.multiple === true) {
    const stored = value !== undefined && !isLinkPropertyValues(value) ? value.value : null;
    if (Array.isArray(stored)) return stored.length;
    if (definition.value_type === 'text' && typeof stored === 'string') {
      return splitMultiValue(stored).length;
    }
    return stored === null || stored === undefined ? 0 : 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read-only renderer для внетипового множественного url (08-ui-spec.md §6.3.1)
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
  const btn = uiButton({
    label: 'Открыть',
    role: 'secondary',
    size: 's',
    title: 'Открыть в системном обработчике',
    onClick: () => onOpen(value),
  });
  btn.disabled = value.trim() === '';
  return btn;
}

/** Test seam for unit tests. */
export const propertiesInternals = {
  buildPropertiesTab,
  buildPropertiesBody,
  buildOutsideTypeTable,
  buildOutsidePropertiesBody,
  outsideLinkDefinition,
  pendingOutsideDefinition,
  outsideRowKey,
  definitionValueKey,
  toOrderItem,
  reorderableOutsideSlots,
  presentPropertyRowIds,
};

/**
 * Type guard: скалярное значение (`PropertyValue`) против формы
 * свойства-связи (`LinkPropertyValues`, без поля `.value`, зато со счётчиком
 * и рёбрами `values[]`). Сужение по `value_type` ненадёжно — `"link"`
 * встречается в обоих union-членах, поэтому различаем по форме.
 */
export function isLinkPropertyValues(
  v: PropertyValue | LinkPropertyValues,
): v is LinkPropertyValues {
  return 'values' in v && 'count' in v;
}

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

// ---------------------------------------------------------------------------
// Read-only рендер значения `cross_network_ref` (задача 7849008a)
// ---------------------------------------------------------------------------

/**
 * Короткая пометка сети по `network_id`: либо имя из каталога сетей (если
 * загружен), либо сокращённый id. Каталог сетей общий (`etn.networks.list`),
 * здесь хелпер — переиспользуется и в основной таблице, и во внетиповой.
 */
function shortNetworkLabel(networkId: string): string {
  const fromCatalog = store.state.networkList.find((n) => n.id === networkId);
  if (fromCatalog !== undefined && fromCatalog.display_name !== '') {
    return fromCatalog.display_name;
  }
  return networkId.length >= 8 ? networkId.slice(0, 8) : networkId;
}

/**
 * Read-only отображение значения `cross_network_ref` для внетипового блока:
 * каждая запись снапшота — отдельная строка «название (сеть)» с пометкой
 * `нерезолвлено`. Полное взаимодействие (переход/обновление) — через основную
 * таблицу и `value-editor`; здесь — только информация для истории значения.
 */
export function buildCrossNetworkRefReadonly(values: CrossNetworkRefValue[]): HTMLElement {
  const root = div('prop-outside-cross-network-ref');
  if (values.length === 0) {
    root.append(span('—', 'muted'));
    return root;
  }
  for (const v of values) {
    const row = div('prop-outside-cross-network-ref-row');
    const net = v.network_id === '' ? '(нет сети)' : shortNetworkLabel(v.network_id);
    row.append(
      span(v.title_snapshot, 'prop-outside-text'),
      span(` — ${net}`, 'muted prop-outside-text'),
    );
    if (v.unresolved) {
      const flag = span(' (нерезолвлено)', 'muted prop-outside-text');
      setTooltip(flag, 'Последний живой резолв отказал — сеть или цель удалены. Нажмите «Обновить имя» в основной таблице.');
      row.append(flag);
    }
    root.append(row);
  }
  return root;
}
