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
  EffectiveTypeProperty,
  LinkPropertyValues,
  PropertyValue,
  ThoughtRef,
} from '@etn/shared';

import { onRealtimeEvent } from '../realtime.js';
import { inFocusNeighbourhood, scheduleNeighbourhoodRepaint } from '../realtime-ui.js';
import {
  button,
  div,
  el,
  errText,
  setTooltip,
  span,
} from '../lib/dom.js';
import { confirmDialog } from '../lib/dialog.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { logUiEvent } from '../lib/ui-log.js';
import { requireNetworkId } from '../app.js';
import { isTypeDeleted, rememberShownDefinitions } from '../lib/type-definitions.js';
import { store } from '../state.js';
import { registerTabContent, type EditorContext } from './editor.js';
import { groupSection } from './group.js';
import { applyTabGroupClamp } from './list-heights.js';
import { rowSplitter } from './splitter.js';
import {
  buildOutsideReadonlyEdgeChip,
  buildValueEditor,
  splitMultiValue,
  valueTypeName,
} from './value-editor.js';

/** Reload callback of the currently mounted properties table (or null). */
let currentReload: (() => void) | null = null;
let wired = false;

/**
 * Довести локальную запись значения свойства-СВЯЗИ до холста и панелей
 * (ошибка f0b959dd). Серверная запись создаёт/удаляет РЕБРО, а собственное
 * realtime-эхо собственного клиента до рендерера не доходит (G8 applier,
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
  if (inFocusNeighbourhood(ownerType, ownerId)) scheduleNeighbourhoodRepaint();
}

/**
 * Registers the «Свойства» tab (task 8ab775d9). Replaces the previous
 * «Свойства» section in the «Комментарий» tab — values now live in their own
 * tab with two collapsible groups, leaving «Комментарий» to the permanent
 * comment full-height editor.
 */
export function registerPropertiesGroup(): void {
  registerTabContent('properties', buildPropertiesTab);
  if (!wired) {
    wired = true;
    onRealtimeEvent((evt) => {
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
  // Group 1 — «Свойства типа» (expanded by default). Read-only outside-type
  // values are rendered inline as a second group further down.
  const typeGroup = groupSection({
    id: 'properties.type',
    title: 'Свойства типа',
    defaultCollapsed: false,
    buildBody: () => buildPropertiesBody(ctx),
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
      try {
        const networkId = requireNetworkId();
        const values = await etn.properties.get(
          networkId,
          ctx.ownerType,
          ctx.ownerId,
        );
        // Скаляры и свойства-связи: внетиповое свойство-связь — тоже значение
        // вне типа (dfaacb05), сервер отдаёт его формой LinkPropertyValues.
        const outside = values.filter((v) => v.outside_type === true);
        return outside.length === 0 ? '(0)' : `(${outside.length})`;
      } catch {
        return undefined;
      }
    },
    buildBody: () => buildOutsidePropertiesBody(ctx),
  });
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
 * Builds the «Свойства типа» body for the current owner — thoughts and links
 * share the same render path. The main table shows in-type values; outside-type
 * values are now in a separate group below.
 */
function buildPropertiesBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const ownerType = ctx.ownerType;
  const ownerId = ctx.ownerId;
  const typeOwner = ownerTypeOf(ctx);
  const typeId = resolveEditorTypeId(ctx);

  const box = div('properties-body');
  if (typeId === null) {
    box.append(el('p', 'muted', 'Свойства недоступны.'));
    return box;
  }
  // Delegate the actual rendering to the standalone builder; this wrapper
  // exists for the legacy `propertiesInternals.buildPropertiesBody` test seam
  // (still called by `renderer-properties.test.ts`).
  const typedId: string = typeId;
  const typeBody = buildTypePropertiesBody(networkId, ownerType, ownerId, typeOwner, typedId);
  box.append(typeBody);
  return box;
}

/**
 * Builds the «Свойства вне типа» body — read-only table for values whose
 * property is no longer attached to the owner's type (0.6.5; спека «Значения
 * вне типа сохраняются»). The group is hidden entirely when no such values
 * exist (`loadCount` returns `(0)` and the section is rendered empty).
 */
function buildOutsidePropertiesBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const ownerId = ctx.ownerId;
  const ownerType = ctx.ownerType;

  const box = div('properties-outside-body');
  const wrap = div('admin-table-wrap prop-wrap');
  wrap.append(el('span', 'muted', 'Загрузка…'));
  box.append(wrap);

  let everMounted = false;
  const reload = async (): Promise<void> => {
    if (everMounted && !box.isConnected) return;
    wrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let values: Array<PropertyValue | LinkPropertyValues>;
    try {
      values = await etn.properties.get(networkId, ownerType, ownerId);
    } catch (err) {
      wrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    if (box.isConnected) everMounted = true;
    // Вне типа — скаляры и свойства-связи вместе (dfaacb05): рёбра,
    // непокрытые свойствами типа, читаются внетиповыми свойствами-связями.
    const outside: Array<PropertyValue | LinkPropertyValues> = values.filter(
      (v) => v.outside_type === true,
    );
    if (outside.length === 0) {
      wrap.replaceChildren(el('p', 'muted', 'Нет значений вне типа.'));
      return;
    }
    wrap.replaceChildren(buildOutsideTypeTable(outside, networkId, ownerType, ownerId, () => void reload()));
  };
  void reload();
  // Keep the outside-type body in sync with the main properties reload (a
  // delete in either group should refresh the other). The realtime listener
  // already invokes `currentReload` for both groups; piggy-back on it by
  // re-rendering ourselves whenever it fires.
  onRealtimeEvent((evt) => {
    if (evt.type === 'property-value.set' || evt.type === 'property-value.deleted') {
      if (box.isConnected) void reload();
    }
  });
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
 * рёбра типа связи без свойства в реестре показываются read-only чипами —
 * ключа для записи нет.
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
    // свойства, вторая — редактор/чип/крестик. `prop-grid` — фиксированная
    // раскладка двух колонок (ошибка 2012f46b): чип не раздувает таблицу.
    const table = el('table', 'table-list prop-outside-table prop-grid');
    const tbody = el('tbody');
    for (const value of values) {
      const row = el('tr');
      if (isLinkPropertyValues(value)) {
        const nameCell = el('td', undefined, `${value.property_name} (связь)`);
        setTooltip(
          nameCell,
          value.property_id !== ''
            ? 'Свойство-связь не подключено к типу владельца — значения редактируются здесь; подключение свойства к типу вернёт их в основную таблицу.'
            : 'Тип связи не имеет свойства в реестре — связь видна как внетиповое свойство, но не редактируется через свойства.',
        );
        row.append(nameCell);
        row.append(
          buildOutsideLinkCell(value, networkId, ownerType, ownerId, onRemove),
        );
        tbody.append(row);
        continue;
      }
      const nameCell = el('td', undefined, `${value.property_name} (${valueTypeName(value.value_type)})`);
      setTooltip(
        nameCell,
        'Свойство больше не подключено к типу владельца — значение сохраняется только для истории.',
      );
      row.append(nameCell);
      row.append(buildOutsideValueCell(value, networkId, ownerType, ownerId, onRemove));
      tbody.append(row);
    }
    table.append(tbody);
    root.append(table);
    return root;
  }

/**
 * Ячейка внетипового свойства-связи. Свойство есть в реестре (не подключено
 * к типу владельца) — полноценный редактор значения через общий
 * `buildValueEditor`, тот же, что в основной таблице: запись значения
 * внетипового свойства-связи разрешена (dfaacb05). Рёбра типа связи без
 * реестрового свойства — read-only чипи: ключа записи нет, редактирование
 * ушло бы в рёбра напрямую.
 */
function buildOutsideLinkCell(
  value: LinkPropertyValues,
  networkId: string,
  ownerType: 'thought' | 'link',
  ownerId: string,
  onRemove: () => void,
): HTMLElement {
    const cell = el('td', 'prop-outside-cell');

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
      // рёбра и real-time события уберут их с карты (если связь видима).
      const clearBtn = el('button', 'st-f-clear-inline prop-outside-remove', '×');
      clearBtn.type = 'button';
      clearBtn.title = 'Удалить значение';
      clearBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void (async () => {
          const ok = await confirmOutsideRemove(value.property_name);
          if (!ok) return;
          try {
            await etn.properties.set(networkId, ownerType, ownerId, value.property_name, null);
            // Очистка внетипового свойства-связи отзывает рёбра — карта
            // перечитывает окрестность сразу (ошибка f0b959dd).
            repaintAfterLinkValueWrite(ownerType, ownerId);
            onRemove();
          } catch (err) {
            notice(`Не удалось удалить значение: ${errText(err)}`, 'error');
          }
        })();
      });
      cell.append(clearBtn);
      return cell;
    }

    // Read-only рёбра вне типа (тип связи без реестрового свойства): те же
    // оформление и обработчики, что у чипа основной таблицы — cab38479.
    const wrap = div('link-value-editor');
    if (value.values.length === 0) {
      wrap.append(span('—', 'muted'));
    }
    const refs = new Map<string, ThoughtRef>();
    for (const edge of value.values) {
      wrap.append(buildOutsideReadonlyEdgeChip(networkId, edge, refs));
    }
    cell.append(wrap);
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
            ...value.values.map((edge) => buildOutsideReadonlyEdgeChip(networkId, edge, refs)),
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

/** Builds the «Свойства типа» body — основная таблица редактирования. */
function buildTypePropertiesBody(networkId: string, ownerType: 'thought' | 'link', ownerId: string, typeOwner: 'thought_type' | 'link_type', typedId: string): HTMLElement {
  const box = div('properties-type-body');
  const tableWrap = div('admin-table-wrap prop-wrap');
  tableWrap.append(span('Загрузка…', 'muted'));
  box.append(tableWrap);

  let everMounted = false;
  currentReload = () => void reload();
  void reload();

  async function reload(): Promise<void> {
    if (everMounted && !box.isConnected) return;
    const startedAt = Date.now();
    tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let definitions: EffectiveTypeProperty[];
    try {
      definitions = await etn.types.listTypeProperties(networkId, typeOwner, typedId);
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    if (box.isConnected) everMounted = true;
    // Индекс показанных определений (ошибка 74b94c26): realtime-события
    // `property-definition.updated/deleted` несут только id привязки, поэтому
    // владельца для гейта берут из того, что реально отрисовано сейчас.
    rememberShownDefinitions(definitions);
    if (definitions.length === 0) {
      tableWrap.replaceChildren(el('p', 'muted', 'У типа нет свойств.'));
      return;
    }
    let values: Array<PropertyValue | LinkPropertyValues> = [];
    try {
      values = await etn.properties.get(networkId, ownerType, ownerId);
    } catch {
      // The main table still renders even if the values fetch fails.
    }
    const valueByProp = new Map(values.map((v) => [v.property_id, v]));
    // `prop-grid` — фиксированная раскладка двух колонок «имя → значение»
    // (ошибка 2012f46b): чип не диктует таблице min-content своего nowrap-имени.
    const table = el('table', 'table-list prop-table prop-grid');
    const tbody = el('tbody');
    for (const definition of definitions) {
      const value = valueByProp.get(definition.property_id);
      const row = el('tr');
      // Заголовок при заполнении: имя (+ « *» обязательности) и число значений
      // у множественных свойств; тип значения и место определения здесь не
      // нужны — это информация редактора типа (приёмка пользователя 0.8.1).
      // ⓘ несёт tooltip с описанием свойства.
      const count = valueCountOf(definition, value);
      const nameCell = el(
        'td',
        'prop-name-cell',
        `${definition.key}${definition.required ? ' *' : ''}${count === null ? '' : ` (${count})`}`,
      );
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
          ownerType,
          ownerId,
          definition,
          current: value,
        }),
      );
      tbody.append(row);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
    logUiEvent('ui.editor.props.loaded', {
      id: ownerId,
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
        // Свойство-связь создало/убрало РЕБРО серверной записью (ошибка
        // f0b959dd): своего realtime-эха у клиента нет — окрестность фокуса
        // перечитываем сразу после успешного сохранения.
        if (definition.value_type === 'link') {
          repaintAfterLinkValueWrite(ownerType, ownerId);
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
  const btn = button(
    'Открыть',
    () => onOpen(value),
    'btn small',
    'Открыть в системном обработчике',
  );
  btn.disabled = value.trim() === '';
  return btn;
}

/** Test seam for unit tests. */
export const propertiesInternals = { buildPropertiesBody, buildOutsideTypeTable };

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
