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
  LinkPropertyValues,
  PropertyValue,
  ThoughtRef,
} from '@etn/shared';

import { inFocusNeighbourhood } from '../lib/focus-neighbourhood.js';
import { queryKeys } from '../lib/live/query-keys.js';
import { invalidateAfterMutation } from '../lib/live/mutator.js';
import {
  asRealtimeCause,
  onQueryInvalidated,
  signalPublicationCompositionChanged,
} from '../lib/live/index.js';
import {
  div,
  el,
  errText,
  setTooltip,
  span,
} from '../lib/dom.js';
import { operationError } from '../lib/ui/messages.js';
import { confirmDialog } from '../lib/dialog.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { PROPERTY_VALUES_REFRESHED_EVENT } from '../lib/property-values-refresh.js';
import { logUiEvent } from '../lib/ui-log.js';
import { requireNetworkId } from '../app.js';
import { isTypeDeleted, rememberShownDefinitions } from '../lib/type-definitions.js';
import { store } from '../state.js';
import { registerTabContent, registerTabRetarget, type EditorContext } from './editor.js';
import { groupSection } from './group.js';
import { removeLinkValueEdges, type LinkValueRemovalMode } from './link-value-removal.js';
import { applyTabGroupClamp } from './list-heights.js';
import { rowSplitter } from './splitter.js';
import { uiButton } from '../lib/ui/button.js';
import { reconcileKeyed, type KeyedRenderSpec } from '../lib/ui/keyed-list.js';
import { deepEqual } from '../lib/ui/state.js';
import {
  buildOutsideReadonlyEdgeChip,
  buildValueEditor,
  splitMultiValue,
  valueTypeName,
} from './value-editor.js';

/** Reload callback of the currently mounted properties table (or null). */
let currentReload: (() => void) | null = null;

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
}

/** Перепривязка показанной вкладки «Свойства» к другому владельцу (или null). */
let retargetCurrent: ((ctx: EditorContext) => void) | null = null;
/** Перечитывание тела группы «Свойства вне типа» (или null, если не построено). */
let outsideReload: (() => void) | null = null;
let wired = false;

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
    // `property-value.set/deleted`) — перечитываем открытую вкладку «Свойства».
    // Свой `onRealtimeEvent` снесён (G5): используется причина слоя.
    onQueryInvalidated((prefix, _keys, cause) => {
      if (prefix !== queryKeys.focusAll() && !prefix.startsWith('focus:@')) return;
      const evt = asRealtimeCause(cause);
      if (evt === null) return;
      if (evt.type === 'property-value.set' || evt.type === 'property-value.deleted') {
        currentReload?.();
      }
    });
  }
}

/** Builds the «Свойства» tab content (two collapsible groups). */
function buildPropertiesTab(ctx: EditorContext): HTMLElement {
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
  const target: PropertiesTarget = { ownerType: ctx.ownerType, ownerId: ctx.ownerId, typeId };
  // A fresh pane resets the stale reload callbacks of the previous one.
  currentReload = null;
  outsideReload = null;
  // Group 1 — «Свойства типа» (expanded by default). Read-only outside-type
  // values are rendered inline as a second group further down.
  const typeGroup = groupSection({
    id: 'properties.type',
    title: 'Свойства типа',
    defaultCollapsed: false,
    buildBody: () => buildPropertiesBodyFor(target),
  });
  // Group 2 — «Свойства вне типа» (collapsed by default). Hidden entirely
  // when there are no such values (rendered inside the main body once the
  // reload pass resolves).
  const outsideGroup = groupSection({
    id: 'properties.outside',
    title: 'Свойства вне типа',
    defaultCollapsed: true,
    lazyCount: true,
    loadCount: async () => {
      // Owner token: a slow badge count of the previous owner must not land on
      // the new one (task 90b2256e, круг 3).
      const requestOwnerId = target.ownerId;
      try {
        const networkId = requireNetworkId();
        const values = await etn.properties.get(
          networkId,
          target.ownerType,
          requestOwnerId,
        );
        if (requestOwnerId !== target.ownerId) return undefined;
        // Скаляры и свойства-связи: внетиповое свойство-связь — тоже значение
        // вне типа (dfaacb05), сервер отдаёт его формой LinkPropertyValues.
        const outside = values.filter((v) => v.outside_type === true);
        return outside.length === 0 ? '(0)' : `(${outside.length})`;
      } catch {
        return undefined;
      }
    },
    buildBody: () => buildOutsidePropertiesBody(target),
  });
  // Retarget of the SHOWN pane to another owner of the same type: the pane is
  // reused (editor's `registerTabRetarget`), its bodies reload under the new
  // owner and the outside-type badge is re-resolved (its owner lives on the
  // group, not in the body, so it needs an explicit refresh).
  retargetCurrent = (next) => {
    target.ownerType = next.ownerType;
    target.ownerId = next.ownerId;
    target.typeId = resolveEditorTypeId(next);
    currentReload?.();
    outsideReload?.();
    outsideGroup.dispatchEvent(new CustomEvent('etn:refresh-count'));
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
  const own = ctx.ownerType === 'thought' ? ctx.thought?.type_id : ctx.link?.type_id;
  if (own != null && !isTypeDeleted({ ownerType: ownerTypeOf(ctx), ownerId: own })) return own;
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
  });
}

/**
 * Builds the «Свойства типа» body against a MUTABLE target: on an entity switch
 * of the same type the pane is reused and the table reloads under the new owner
 * (task 90b2256e). The owner-id is read at reload time, never captured per row,
 * so a retarget never writes to the previous entity.
 */
function buildPropertiesBodyFor(target: PropertiesTarget): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('properties-body');
  if (target.typeId === null) {
    box.append(el('p', 'muted', 'Свойства недоступны.'));
    return box;
  }
  const typeOwner = target.ownerType === 'thought' ? 'thought_type' : 'link_type';
  const typeBody = buildTypePropertiesBody(networkId, target, typeOwner, target.typeId);
  box.append(typeBody);
  return box;
}

/**
 * Builds the «Свойства вне типа» body — read-only table for values whose
 * property is no longer attached to the owner's type (0.6.5; спека «Значения
 * вне типа сохраняются»). The group is hidden entirely when no such values
 * exist (`loadCount` returns `(0)` and the section is rendered empty).
 */
function buildOutsidePropertiesBody(target: PropertiesTarget): HTMLElement {
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
  /** Owner currently rendered in this body (see the in-type table's guard). */
  let shownOwnerId: string | null = null;

  const rowSpec = outsideRowSpec(networkId, target, () => void reload());

  async function reload(): Promise<void> {
    // Owner token of this reload (same guard as the in-type table): a slow
    // response of the previous owner must not be rendered after a retarget
    // (task 90b2256e, круг 2); an owner CHANGE proceeds even while detached
    // (круг 3).
    const requestOwnerId = target.ownerId;
    if (everMounted && !box.isConnected && requestOwnerId === shownOwnerId) return;
    // Плейсхолдер — только пока таблица не прикреплена; иначе инкрементальное
    // обновление не мигает «Загрузкой…» на каждой правке значения.
    if (!tableAttached) wrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let values: Array<PropertyValue | LinkPropertyValues>;
    try {
      values = await etn.properties.get(networkId, target.ownerType, requestOwnerId);
    } catch (err) {
      if (requestOwnerId !== target.ownerId) return;
      // The table is NOT bound to this owner: drop the shown-owner mark so a
      // retarget back to the previous owner is not mistaken for "already shown"
      // and gets re-read instead of leaving the error text on screen
      // (задача 90b2256e, круг 3).
      shownOwnerId = null;
      tableAttached = false;
      wrap.replaceChildren(operationError(err));
      return;
    }
    if (requestOwnerId !== target.ownerId) return;
    if (box.isConnected) everMounted = true;
    shownOwnerId = requestOwnerId;
    // Вне типа — скаляры и свойства-связи вместе (dfaacb05): рёбра,
    // непокрытые свойствами типа, читаются внетиповыми свойствами-связями.
    const outside: Array<PropertyValue | LinkPropertyValues> = values.filter(
      (v) => v.outside_type === true,
    );
    if (outside.length === 0) {
      tableAttached = false;
      wrap.replaceChildren(el('p', 'muted', 'Нет значений вне типа.'));
      return;
    }
    if (!tableAttached) {
      wrap.replaceChildren(table);
      tableAttached = true;
    }
    reconcileKeyed(tbody, outsideRows(outside, requestOwnerId), rowSpec);
  }
  outsideReload = () => void reload();
  void reload();
  // Keep the outside-type body in sync with the main properties reload (a
  // delete in either group should refresh the other). The realtime listener
  // already invokes `currentReload` for both groups; piggy-back on it by
  // re-rendering ourselves whenever it fires.
  onQueryInvalidated((prefix, _keys, cause) => {
    if (prefix !== queryKeys.focusAll() && !prefix.startsWith('focus:@')) return;
    const evt = asRealtimeCause(cause);
    if (evt === null) return;
    if (evt.type === 'property-value.set' || evt.type === 'property-value.deleted') {
      if (box.isConnected) void reload();
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
 * Confirmed deletion of an outside-type value (custom confirmation dialog).
 */
async function confirmOutsideRemove(name: string): Promise<boolean> {
  return confirmDialog(
    'Удалить значение свойства',
    `Свойство «${name}» больше не подключено к типу. Удалить сохранённое значение? Действие необратимо — таких значений система сама не очищает.`,
    true,
  );
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
  const target: PropertiesTarget = { ownerType, ownerId, typeId: null };
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

/** Строка таблицы «Свойства вне типа»: владелец + само внетиповое значение. */
interface OutsideRow {
  /** Владелец, под которого прочитано значение (меняется при перепривязке). */
  ownerId: string;
  value: PropertyValue | LinkPropertyValues;
}

/** Оборачивает внетиповые значения в строки keyed-сверки. */
function outsideRows(
  values: Array<PropertyValue | LinkPropertyValues>,
  ownerId: string,
): OutsideRow[] {
  return values.map((value) => ({ ownerId, value }));
}

/**
 * Ключ строки «Свойства вне типа»: внетиповое значение привязано к свойству
 * реестра — его `property_id` и служит ключом (аналог id привязки основной
 * таблицы). У рёбер типа связи без свойства в реестре `property_id` пуст —
 * ключом становится уникальная серверная пара «тип связи + направление»
 * (`link_type_id`/`direction`): display-имя стороны для этого не годится —
 * уникальность имён типа связи только по паре forward/reverse, и два типа с
 * одинаковым `name_forward` дали бы один и тот же ключ (регрессия круга 1).
 */
function outsideRowKey(value: PropertyValue | LinkPropertyValues): string {
  if (isLinkPropertyValues(value)) {
    return value.property_id !== ''
      ? value.property_id
      : `link:${value.link_type_id ?? ''}|${value.direction}`;
  }
  return value.property_id;
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
): KeyedRenderSpec<OutsideRow> {
  const fill = (row: HTMLElement, value: PropertyValue | LinkPropertyValues): void => {
    row.replaceChildren();
    if (isLinkPropertyValues(value)) {
      const nameCell = el('td', undefined, `${value.property_name} (связь)`);
      setTooltip(
        nameCell,
        value.property_id !== ''
          ? 'Свойство-связь не подключено к типу владельца — значения редактируются здесь; подключение свойства к типу вернёт их в основную таблицу.'
          : 'Тип связи не имеет свойства в реестре — связь видна как внетиповое свойство; удалить её можно по display-имени стороны.',
      );
      row.append(nameCell);
      row.append(buildOutsideLinkCell(value, networkId, target.ownerType, target.ownerId, onRemove));
      return;
    }
    const nameCell = el(
      'td',
      undefined,
      `${value.property_name} (${valueTypeName(value.value_type)})`,
    );
    setTooltip(
      nameCell,
      'Свойство больше не подключено к типу владельца — значение сохраняется только для истории.',
    );
    row.append(nameCell);
    row.append(buildOutsideValueCell(value, networkId, target.ownerType, target.ownerId, onRemove));
  };
  return {
    key: (row) => outsideRowKey(row.value),
    build: (row) => {
      const tr = el('tr');
      fill(tr, row.value);
      return tr;
    },
    update: (tr, row) => fill(tr, row.value),
    equals: (a, b) => a.ownerId === b.ownerId && deepEqual(a.value, b.value),
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
): HTMLElement {
    const cell = el('td', 'prop-outside-cell');

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
    const clearOutsideLinkValue = (key: string): Promise<boolean> => writeOutsideEdgeSet(key, []);

    if (value.property_id !== '') {
      // Внетиповое свойство-связь: определение собирается на лету по ребру,
      // ограничения типов у него нет (`allowed_opposite_type_ids` не задан) —
      // внетиповое значение возникает как раз тогда, когда привязок к типу
      // владельца нет, значит фильтровать кандидатов нечем (модель dde92461).
      const definition: EffectiveTypeProperty = {
        id: value.property_id,
        property_id: value.property_id,
        owner_type: ownerType === 'thought' ? 'thought_type' : 'link_type',
        owner_id: '',
        key: value.property_name,
        value_type: 'link',
        config: value.link_type_id !== null
          ? { link_type_id: value.link_type_id, direction: value.direction }
          : { direction: value.direction, structural: true },
        required: false,
        position: 0,
        description: value.description ?? null,
        inherited: false,
        defined_on: '',
        defined_on_name: '',
        default_value: null,
        overridden_here: false,
        description_overridden: false,
      };
      const save = async (next: unknown): Promise<boolean> => {
        try {
          await etn.properties.set(networkId, ownerType, ownerId, definition.key, next);
          // Внетиповое свойство-связь меняет рёбра так же, как типовое, —
          // окрестность фокуса перечитываем сразу (ошибка f0b959dd).
          repaintAfterLinkValueWrite(ownerType, ownerId);
          signalCompositionForOwner(ownerType, ownerId);
          onRemove();
          return true;
        } catch (err) {
          notice(`Не удалось сохранить «${definition.key}»: ${errText(err)}`, 'error');
          return false;
        }
      };
      cell.append(
        buildValueEditor({
          networkId,
          ownerType,
          ownerId,
          definition,
          value: value.values,
          save,
          historyPropertyId: value.property_id,
        }),
      );
      // Крестик «×» очищает значение внетипового свойства-связи целиком
      // (cab38479): без него у пользователя нет способа снять значение из
      // группы «Свойства вне типа»; сервер при `set(key, null)` отзовёт
      // рёбра. Способ снятия выбирается автоматически без диалога
      // (задача 0d4f793a): возможно удалить — удаляем, иначе в корзину.
      const clearBtn = el('button', 'st-f-clear-inline prop-outside-remove', '×');
      clearBtn.type = 'button';
      clearBtn.title = 'Удалить значение';
      clearBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (value.values.length === 0) return;
        void removeLinkValueEdges({
          networkId,
          ownerType,
          ownerId,
          propertyKey: value.property_name,
          propertyId: value.property_id,
          removedTargetIds: value.values.map((edge) => edge.target_id),
          mode: 'auto',
          commit: () => clearOutsideLinkValue(value.property_name),
        });
      });
      cell.append(clearBtn);
      return cell;
    }

    // Read-only рёбра вне типа (тип связи без реестрового свойства): те же
    // оформление и обработчики, что у чипа основной таблицы — cab38479.
    //
    // 0.8.2, ошибка 748b80fd: ключом записи служит display-имя стороны связи
    // (`value.property_name`), которое сервер понимает (`resolveDefinition`
    // шаг 3). Поэтому у чипов появляются команды «Удалить связь с мыслью» /
    // «Поместить связь в корзину» (задача 0d4f793a), а у ячейки — крестик «×»
    // очистки набора целиком без диалога (как у реестровых внетиповых,
    // cab38479). Направление сервер берёт из имени стороны, так что удаляется
    // именно это ребро, а не типовое входящее.
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

  /** Read-only value cell for an outside-type value: same visuals, no editor. */
function buildOutsideValueCell(
  value: PropertyValue,
  networkId: string,
  ownerType: 'thought' | 'link',
  ownerId: string,
  onRemove: () => void,
): HTMLElement {
    const cell = el('td', 'prop-outside-cell');
    const remove = (): void => {
      void (async () => {
        const ok = await confirmOutsideRemove(value.property_name);
        if (!ok) return;
        try {
          await etn.properties.remove(networkId, ownerType, ownerId, value.property_name);
          signalCompositionForOwner(ownerType, ownerId);
          onRemove();
        } catch (err) {
          notice(`Не удалось удалить значение: ${errText(err)}`, 'error');
        }
      })();
    };

    // Read-only отображение скаляра: ветвление по форме значения (вид здесь
    // не строит ПОЛЕ ВВОДА — это подпись, строит её value-editor-ветка
    // только для редактируемых значений).
    const stored = value.value;
    if (value.value_type === 'url' && Array.isArray(stored) && typeof stored[0] === 'string') {
      cell.append(buildMultiUrlReadonly({ urls: stored as string[], onOpen: openOneUrl }));
    } else if (value.value_type === 'url' && typeof stored === 'string') {
      const row = div('form-row');
      row.style.marginBottom = '0';
      row.append(span(stored, 'prop-outside-text'), buildUrlOpenBtn(stored));
      cell.append(row);
    } else if (value.value_type === 'cross_network_ref' && Array.isArray(stored)) {
      // cross_network_ref внетипового значения (задача 7849008a) — снапшот
      // адреса отдельным узлом. Здесь только подпись; переход/обновление —
      // через основную таблицу и value-editor.
      cell.append(buildCrossNetworkRefReadonly(stored as CrossNetworkRefValue[]));
    } else if (typeof stored === 'string' || typeof stored === 'number') {
      cell.append(span(String(stored), 'prop-outside-text'));
    } else if (typeof stored === 'boolean') {
      cell.append(span(stored ? 'да' : 'нет', 'prop-outside-text'));
    } else {
      cell.append(span('—', 'muted'));
    }

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
    const btn = uiButton({
      label: 'Открыть',
      role: 'secondary',
      size: 's',
      title: 'Открыть в системном обработчике',
      onClick: () => void openOneUrl(value),
    });
    btn.disabled = value.trim() === '';
    return btn;
  }

/** Builds the «Свойства типа» body — основная таблица редактирования. */
function buildTypePropertiesBody(networkId: string, target: PropertiesTarget, typeOwner: 'thought_type' | 'link_type', typedId: string): HTMLElement {
  const box = div('properties-type-body');
  const tableWrap = div('admin-table-wrap prop-wrap');
  tableWrap.append(span('Загрузка…', 'muted'));
  box.append(tableWrap);

  let everMounted = false;
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
  }

  /** Собирает строку строки таблицы: имя (+ ⓘ) и ячейку значения. */
  const fillRow = (
    row: HTMLElement,
    definition: EffectiveTypeProperty,
    value: PropertyValue | LinkPropertyValues | undefined,
  ): void => {
    row.replaceChildren();
    // Заголовок при заполнении: имя (+ « *» обязательности) и число значений
    // у множественных свойств; тип значения и место определения здесь не
    // нужны — это информация редактора типа (приёмка пользователя 0.8.1).
    // ⓘ несёт tooltip с описанием свойства. Текст заголовка — отдельный узел:
    // счётчик обновляется локально после своей записи значения-связи (ошибка
    // 9ee8e608) без пересборки строки, а ⓘ остаётся на месте.
    const count = valueCountOf(definition, value);
    const nameCell = el('td', 'prop-name-cell');
    const nameText = span(propertyNameLabel(definition, count));
    nameCell.append(nameText);
    const hint = propertyHint(definition);
    if (hint !== null) {
      const info = span('ⓘ', 'muted prop-hint');
      setTooltip(info, hint);
      nameCell.append(info);
    }
    row.append(nameCell);
    row.append(
      buildEditorCell({
        networkId,
        ownerType: target.ownerType,
        ownerId: target.ownerId,
        definition,
        current: value,
        // Своя запись значения-связи не поднимает версию мысли (гейт полной
        // пересборки `mountEditor` не срабатывает), а realtime-эхо своего
        // клиента приходит асинхронно (B1) (G8) — счётчик строки, нарисованный
        // при `reload()`, перерисовываем здесь же (ошибка 9ee8e608).
        onLinkCountChange: (next) => {
          nameText.textContent = propertyNameLabel(definition, next);
        },
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
      fillRow(tr, row.definition, row.value);
      return tr;
    },
    update: (tr, row) => fillRow(tr, row.definition, row.value),
    // A row is reused only within the SAME owner: on a retarget to another
    // entity the value cell must be rebuilt even when the displayed value looks
    // equal (an empty value still writes through the OLD owner closure
    // otherwise — задача 90b2256e, круг 1).
    equals: (a, b) =>
      a.ownerId === b.ownerId &&
      deepEqual(a.definition, b.definition) &&
      deepEqual(a.value, b.value),
  };

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

  async function reload(): Promise<void> {
    // Token of THIS reload: the owner it reads for. The pane survives an entity
    // switch (registerTabRetarget → retargetCurrent), so a slow response of the
    // PREVIOUS owner must not be applied to the NEW one — otherwise its values
    // would be written with the new ownerId and could save onto the wrong
    // entity (task 90b2256e, круг 2).
    const requestOwnerId = target.ownerId;
    // A detached pane skips only a REDUNDANT reload of the owner it already
    // shows; an owner change must proceed even while hidden (круг 3).
    if (everMounted && !box.isConnected && requestOwnerId === shownOwnerId) return;
    const startedAt = Date.now();
    // Плейсхолдер — только пока таблица не прикреплена; иначе инкрементальное
    // обновление не мигает «Загрузкой…» на каждой правке значения.
    if (!tableAttached) tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let definitions: EffectiveTypeProperty[];
    try {
      definitions = await etn.types.listTypeProperties(networkId, typeOwner, typedId);
    } catch (err) {
      if (requestOwnerId !== target.ownerId) return;
      // Same as the outside-type body: forgotten owner mark so returning to the
      // previous entity re-reads instead of keeping the error (90b2256e, круг 3).
      shownOwnerId = null;
      tableWrap.replaceChildren(operationError(err));
      tableAttached = false;
      return;
    }
    // The owner changed while the definitions were in flight — the retarget's
    // own reload (fired by `retargetCurrent`) is authoritative; drop this one.
    if (requestOwnerId !== target.ownerId) return;
    if (box.isConnected) everMounted = true;
    // From here the table is considered bound to this owner (even the empty-set
    // branch below) — the detached-pane guard keys off it.
    shownOwnerId = requestOwnerId;
    // Индекс показанных определений (ошибка 74b94c26): realtime-события
    // `property-definition.updated/deleted` несут только id привязки, поэтому
    // владельца для гейта берут из того, что реально отрисовано сейчас.
    rememberShownDefinitions(definitions);
    if (definitions.length === 0) {
      tableWrap.replaceChildren(el('p', 'muted', 'У типа нет свойств.'));
      tableAttached = false;
      return;
    }
    let values: Array<PropertyValue | LinkPropertyValues> = [];
    try {
      values = await etn.properties.get(networkId, target.ownerType, requestOwnerId);
    } catch {
      // The main table still renders even if the values fetch fails.
    }
    // Same guard after the values fetch — the slowest leg of the pair.
    if (requestOwnerId !== target.ownerId) return;
    const valueByProp = new Map(values.map((v) => [v.property_id, v]));
    if (!tableAttached) {
      tableWrap.replaceChildren(table);
      tableAttached = true;
    }
    const rows: PropertyRow[] = definitions.map((definition) => ({
      ownerId: requestOwnerId,
      definition,
      value: valueByProp.get(definition.property_id),
    }));
    reconcileKeyed(tbody, rows, rowSpec);
    logUiEvent('ui.editor.props.loaded', {
      id: requestOwnerId,
      ms: Date.now() - startedAt,
      definitions: definitions.length,
    });
  }

  return box;
}

/** Builds the value editor cell for one property — поле строит общий
 *  `buildValueEditor` (стандарт S2); здесь только сохранение и форма значения. */
function buildEditorCell(opts: {
    networkId: string;
    ownerType: 'thought' | 'link';
    ownerId: string;
    definition: EffectiveTypeProperty,
    current: PropertyValue | LinkPropertyValues | undefined,
    /** Обновление счётчика значений в заголовке строки после своей записи
     *  свойства-связи (ошибка 9ee8e608). Скаляры его не зовут. */
    onLinkCountChange?: (count: number) => void,
  }): HTMLElement {
    const { networkId, ownerType, ownerId, definition, current } = opts;
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
          await etn.properties.set(networkId, ownerType, ownerId, definition.key, value);
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
  buildPropertiesBody,
  buildOutsideTypeTable,
  buildOutsidePropertiesBody,
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
