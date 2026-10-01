/**
 * Общий редактор значения свойства (ADR «значение свойства вводит один
 * компонент, свитч по виду значения — в одном экземпляре», стандарт S2
 * «Клиент: ввод значения свойства — только через общий редактор значения»,
 * элемент интерфейса «Поле ввода значения свойства (единое)», требование
 * «История ввода значений — во всех полях значения»; задача 77e7cafd,
 * веха 4 версии 0.8.2).
 *
 * {@link buildValueEditor} — ЕДИНСТВЕННОЕ место клиента, где поле ввода
 * значения строится свитчем по `value_type`. Строится по определению
 * свойства (`EffectiveTypeProperty`): вид значения, `config.multiple`,
 * `config.options`; для вида «связь» — допустимые типы противоположной стороны
 * привязки (`allowed_opposite_type_ids`, посчитанные сервером по реестру
 * привязок; иерархию раскрывает L21), обязательность и значение по умолчанию
 * (`default_value` используется как начальное значение, только когда
 * вызывающий передал `value: undefined`, а не `null`).
 *
 * Собирается из общих модулей, а не из примитивов (ADR):
 *  - чипы — фабрика облачка `lib/thought-cloud.ts`, профиль `chip`;
 *  - подсказки (история последних значений, закрытый список
 *    `config.options`, живой поиск целей связи) — общая выпадашка
 *    `lib/suggest-dropdown.ts` (`historySuggestSource` / `optionsSuggestSource`
 *    / `searchSuggestSource`);
 *  - выбор мыслей — общий диалог `pickThoughtsDialog` («выбрать или создать»)
 *    и живой поиск той же выпадашкой.
 *
 * Два режима коммита — параметр места, а не второй компонент:
 *  - `commitOn: 'blur'` (по умолчанию, таблица свойств редактора): редактор
 *    держит baseline последнего УСПЕШНО сохранённого значения и пишет через
 *    `save` по blur (карточка 7d094c26 — rollback при неудаче, «пусто» на уже
 *    пустом поле не шлёт запрос — ошибка cefb4db0);
 *  - `commitOn: 'change'` (черновики диалогов и конструктор условий отборов):
 *    каждое изменение читается в состояние вызывающего через `save` без сети.
 *
 * У каждого скалярного поля справа — «✕» очистки значения одним кликом
 * (`wrapClearable`); у пустого поля кнопка скрыта (ошибка a8e9eef1).
 *
 * История последних значений подключается опцией `historyPropertyId`
 * (networkId + property id — ключ `recent-values.ts`): источник `empty` у
 * text/url, включая множественные значения и свойства-связи (ошибка
 * 880c3add — история пропала из полей свойств-связей). Пишется при успешном
 * сохранении в `blur`-режиме. У свойства со списком вариантов
 * (`config.options`) история не подключается — выпадашку занимает сам список,
 * который открывается сразу при входе в поле (карточка ошибки 4a96d07a).
 */

import type {
  CrossNetworkRefValue,
  EffectiveTypeProperty,
  LinkPropertyValueItem,
  SearchNameHit,
  ThoughtRef,
} from '@etn/shared';
import { formatCrossNetworkAddress, parseCrossNetworkAddress } from '@etn/shared';

import { store } from '../state.js';
import { button, div, el, errText, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { notifyPropertyValuesRefreshed } from '../lib/property-values-refresh.js';
import { markCrossNetworkThoughtPreview, markThoughtCommentPreview } from '../lib/hover-preview.js';
import { loadCrossNetworkCandidates } from '../lib/entity-picker.js';
import {
  buildEntityChipField,
  loadPublicationOptions,
  pickEntitiesModal,
  PUBLICATIONS_PAGE_SIZE,
  resolvePublicationOptions,
} from '../lib/entity-picker.js';
import { createThoughtCloud, type ThoughtCloudInput } from '../lib/thought-cloud.js';
import { expandTypeIdsToSubtree } from '../lib/type-tree.js';
import {
  historySuggestSource,
  optionsSuggestSource,
  wireSuggest,
  type SuggestEntry,
  type SuggestHandle,
  type SuggestSource,
} from '../lib/suggest-dropdown.js';
import { loadRecentValues, recordRecentValue } from './recent-values.js';
import {
  removeLinkValueEdges,
  removalModeForClick,
  type LinkValueRemovalMode,
} from './link-value-removal.js';
import { pickThoughtsDialog } from '../canvas/add-dialog.js';
import { toggleSelection } from '../selection/selection.js';
import { openWikiIdTarget } from './wiki-link.js';
import { openPublicationInWorkspace } from '../screens/active-view.js';
import { t } from '../lib/i18n.js';
import { showMenuAt, type MenuItem } from '../lib/menu.js';
import { uiButton } from '../lib/ui/button.js';
import { choiceControl } from '../lib/ui/choice-row.js';
import { fieldInput, wrapClearable } from '../lib/ui/field.js';

// ---------------------------------------------------------------------------
// Публичный API
// ---------------------------------------------------------------------------

/** Параметры {@link buildValueEditor}. */
export interface ValueEditorOptions {
  networkId: string;
  /** Владелец значения (мысль/связь) — контекстное меню чипов свойства-связи.
   *  Без владельца (дефолт в редакторе свойства/типа) меню не выводится. */
  ownerType?: 'thought' | 'link';
  ownerId?: string;
  /**
   * Определение свойства: вид значения, `config`, `required`, `default_value`,
   * `allowed_opposite_type_ids`. Намеренно сужено до используемых полей —
   * конструктор условий отборов («Структуры», отбор типа) собирает
   * определение на лету по реестру,
   * без фейковых `id`/`owner_*` привязки.
   */
  definition: Pick<
    EffectiveTypeProperty,
    'value_type' | 'config' | 'required' | 'default_value' | 'side' | 'allowed_opposite_type_ids'
  > &
    // `key`/`property_id` нужны только ветке свойства-связи — по ним диалог
    // снятия значения находит рёбра для «Удалить совсем» (задача 96d27fc0).
    // Необязательны: конструкторы синтетических определений их не задают.
    Partial<Pick<EffectiveTypeProperty, 'key' | 'property_id'>>;
  /**
   * Текущее значение: скаляр (`string`/`number`/`boolean`, `string[]` для
   * множественного `url`) либо рёбра `LinkPropertyValueItem[]` для вида
   * «связь». `undefined` — вызывающий значение не знает: редактор стартует с
   * `definition.default_value`; `null` — значение намеренно пустое, дефолт
   * НЕ подставляется.
   */
  value?: unknown;
  /** Запись значения; `null` — очистка. Автокоммит (`blur`) или буфер (`change`). */
  save: (next: unknown | null) => Promise<boolean> | boolean;
  /** Режим коммита: `'blur'` (по умолчанию) или `'change'` (черновик). */
  commitOn?: 'blur' | 'change';
  /** Подключает историю последних значений (text/url/link). */
  historyPropertyId?: string;
  /** Трёхзначное поле «да/нет»: `null` — «не задано» (панель выбранных). */
  boolTriState?: boolean;
  /**
   * Дополнительные источники подсказок, заданные вызывающим, — прежде всего
   * токены отбора (`$today+7d`, `$focus`, `$thought.<ключ>`). Источник (или
   * несколько) приходит снаружи, как в общей выпадашке: сам редактор о
   * существовании отборов и о смысле токенов не знает — он лишь добавляет
   * переданные строки в список подсказок и подставляет их значение.
   * Участвуют у текстовых видов (text/url), даты и свойства-связи; выбор
   * строки-токена заменяет значение целиком (как `config.options`).
   * Виды number/bool источников не принимают — у них токенов нет.
   */
  extraSuggest?: readonly SuggestSource[];
  /**
   * Подсказка-заполнитель поля ввода. У text/url/даты переопределяет
   * умолчание редактора (у даты с `extraSuggest` поле становится текстовым —
   * токен не влезает в `<input type="date">`).
   */
  placeholder?: string;
}

/**
 * Собирает готовое поле ввода значения свойства. Единственный свитч по виду
 * значения в клиенте — правки нового вида значения делаются здесь и
 * появляются во всех местах сразу (ADR).
 */
export function buildValueEditor(opts: ValueEditorOptions): HTMLElement {
  switch (opts.definition.value_type) {
    case 'text':
      return buildTextEditor(opts);
    case 'url':
      return buildUrlEditor(opts);
    case 'number':
      return buildNumberEditor(opts);
    case 'date':
      return buildDateEditor(opts);
    case 'bool':
      return buildBoolEditor(opts);
    case 'link':
      return buildLinkValueEditor({
        networkId: opts.networkId,
        ownerType: opts.ownerType,
        ownerId: opts.ownerId,
        definition: opts.definition,
        // Для `link` ветки значения — массив `LinkPropertyValueItem[]` или
        // строк-id (multiple — массив строк-id). Расширение типа
        // `PropertyValueValue` вариантом `CrossNetworkRefValue[]` (задача
        // 7849008a) делает сигнатуру шире, но эта ветка срабатывает только
        // для `value_type: 'link'` — снапшот тут не появляется; строки и
        // объекты с `link_id` валидны.
        values: Array.isArray(opts.value)
          ? ((opts.value as unknown[]).flatMap((item): LinkPropertyValueItem[] => {
              if (typeof item === 'string' && item !== '') {
                return [
                  {
                    link_id: '',
                    target_id: item,
                    target_title: null,
                    target_type_id: null,
                    comment: null,
                  },
                ];
              }
              if (
                typeof item === 'object' &&
                item !== null &&
                'link_id' in item &&
                'target_id' in item
              ) {
                return [item as LinkPropertyValueItem];
              }
              return [];
            }) as LinkPropertyValueItem[])
          : (opts.value === undefined && Array.isArray(opts.definition.default_value)
              ? (opts.definition.default_value as string[]).map((id) => ({
                  link_id: '',
                  target_id: id,
                  target_title: null,
                  target_type_id: null,
                  comment: null,
                }))
              : []),
        save: (next) =>
          Promise.resolve(opts.save(next)).then((ok) => ok === true),
        historyPropertyId: opts.historyPropertyId,
        extraSuggest: opts.extraSuggest,
      });
    case 'thought_ref':
    default:
      // Legacy (миграция 040): значений этого вида в живых базах нет.
      return span('упразднено', 'muted');
    case 'cross_network_ref':
      // Кросс-сетевая ссылка (задача 7849008a): адрес `n:<network>#<thought>`
      // в текстовом поле + кнопка «обновить снапшот» через IPC
      // `properties.crossResolve` (REST POST …/properties/{key}/cross-resolve).
      return buildCrossNetworkRefEditor(opts);
    case 'publication':
      // Ссылка на публикацию текущего слоя (0.11.1, задача 3275fd8d, элемент
      // интерфейса 9626efb6): значение — id публикации (single) или массив id
      // (multiple); поле — общий чип-лист сущностей с профилем «публикации».
      return buildPublicationRefEditor(opts);
  }
}

/**
 * Редактор значения свойства вида `publication` (0.11.1, задача 3275fd8d):
 * ссылка на публикацию текущего слоя. Значение — id (single) или массив id
 * (multiple), как хранит сервер (f37b468d). Поле — общий чип-лист сущностей
 * `buildEntityChipField` (стандарт S3): живой поиск по названию/подзаголовку/
 * автору, кнопка «…» — модальный пикер публикаций, чипы — название с
 * мини-обложкой, клик по чипу открывает публикацию на её экране.
 */
function buildPublicationRefEditor(opts: ValueEditorOptions): HTMLElement {
  const networkId = opts.networkId;
  const isMultiple = opts.definition.config?.multiple === true;
  const key = opts.definition.key ?? '';
  let ids = readPublicationIds(opts.value);
  /** Облачка значений по id: обложка и название приходят серверным резолвом. */
  const clouds = new Map<string, ThoughtCloudInput>();

  const remember = (options: readonly { id: string; cloud?: ThoughtCloudInput }[]): void => {
    for (const option of options) {
      if (option.cloud !== undefined) clouds.set(option.id, option.cloud);
    }
  };

  /** Записать набор (пусто — `null`; single — одна строка, multiple — массив). */
  const publish = (): void => {
    const payload =
      ids.length === 0 ? null : isMultiple ? [...ids] : ids[0]!;
    void Promise.resolve()
      .then(() => opts.save(payload))
      .then((ok) => {
        // Успешная запись — просим таблицу свойств перечитать значение
        // (подписи могли прийти из пикера, где облачко ещё не догружено).
        if (ok === true && key !== '') notifyPropertyValuesRefreshed(key);
      });
  };

  const root = div('value-editor value-editor--publication');
  const field = buildEntityChipField({
    getValues: () => ids,
    onChange: (next) => {
      ids = isMultiple ? [...next] : next.slice(-1);
      publish();
    },
    loadOptions: (query, offset = 0) =>
      loadPublicationOptions(networkId, query, offset).then((options) => {
        remember(options);
        return options;
      }),
    optionsWhen: 'typed',
    pageSize: PUBLICATIONS_PAGE_SIZE,
    picker: {
      label: t('publications.field.pickerTitle'),
      open: (managed) =>
        pickEntitiesModal({
          networkId,
          kind: 'publications',
          title: t('publications.field.pickerTitle'),
          single: !isMultiple,
          currentIds: managed,
        }),
    },
    cloudOf: (value) => clouds.get(value) ?? null,
    onOpen: (id) => void openPublicationInWorkspace(id),
    placeholder: t('publications.field.placeholder'),
    addPlaceholder: t('publications.field.addPlaceholder'),
  });
  root.append(field.root);

  // Облачка уже выбранных значений: серверный резолв по id (в каталоге
  // текущей страницы их может не быть).
  if (ids.length > 0) {
    void resolvePublicationOptions(networkId, ids)
      .then((options) => {
        remember(options);
        field.refresh();
      })
      .catch(() => undefined);
  }
  return root;
}

/** Достать id публикаций из значения (строка single либо массив id). */
function readPublicationIds(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

/**
 * Одна цель кросс-сетевой ссылки в редакторе: адрес (ключ значения),
 * разобранные id и подпись-снапшот имени.
 */
interface CrossNetworkRefEntry {
  /** Адрес `n:<network>#<thought>` — то, что уходит в `save`. */
  address: string;
  networkId: string;
  thoughtId: string;
  /** Снапшот имени цели (или сам адрес, пока снапшота нет). */
  title: string;
  /** Последний живой резолв отказал (сеть/цель удалены). */
  unresolved: boolean;
}

/**
 * Редактор кросс-сетевой ссылки (задача 7849008a; поле ввода переделано под
 * чипы — ошибка 9be98ae1). Работает как поле свойства-связи: цели — облачка
 * фабрики (профиль `chip`) с меткой «чужой сети» ({@link networkBadge}),
 * добавление — живой веерный поиск по вводу (`loadCrossNetworkCandidates`) или
 * диалог «Выбрать…» (`pickThoughtsDialog { crossNetwork }`, задача ea04a185).
 * Значение — адреса `n:<network>#<thought>` (single — строка, multiple —
 * массив; пусто — `null`), формат тот же, что у межсетевых wiki-ссылок.
 *
 * Чип кросс-сети: клик — открыть цель (`openWikiIdTarget` с контролем вкладок
 * и последующим точечным резолвом, требование 95511443), Ctrl+наведение —
 * предпросмотр комментария чужой мысли с именем сети-источника в заголовке,
 * контекстное меню — «Открыть» / «Обновить имя» (`crossResolve`) / «Удалить из
 * значения», кнопка «✕» — то же удаление. Резолв снапшота идёт ТОЛЬКО по
 * действию (требование 95511443): чтение карточки чужие сети не открывает.
 */
function buildCrossNetworkRefEditor(opts: ValueEditorOptions): HTMLElement {
  const isMultiple = opts.definition.config?.multiple === true;
  // Набор целей: `ordered` — порядок адресов (то, что уходит в save), `entries`
  // — данные чипа. Снапшоты значения (CrossNetworkRefValue[]) и сырые адреса
  // (конструкторы условий) нормализуются в одну карту.
  const entries = new Map<string, CrossNetworkRefEntry>();
  const ordered: string[] = [];
  const addEntry = (entry: CrossNetworkRefEntry): void => {
    if (!entries.has(entry.address)) ordered.push(entry.address);
    entries.set(entry.address, entry);
  };
  for (const snap of readSnapshotFromValue(opts.value)) {
    if (snap.network_id === '' || snap.thought_id === '') continue;
    let address: string;
    try {
      address = formatCrossNetworkAddress(snap.network_id, snap.thought_id);
    } catch {
      continue;
    }
    addEntry({
      address,
      networkId: snap.network_id,
      thoughtId: snap.thought_id,
      title: snap.title_snapshot,
      unresolved: snap.unresolved,
    });
  }
  for (const address of readAddressesFromValue(opts.value)) {
    const parsed = parseCrossNetworkAddress(address);
    if (parsed === null) continue;
    addEntry({
      address,
      networkId: parsed.networkId,
      thoughtId: parsed.thoughtId,
      title: address,
      unresolved: false,
    });
  }

  const root = div('value-editor value-editor--cross-network-ref');
  const wrap = div('link-value-wrap');
  const field = div('st-f-chipfield link-value-field cross-network-ref-field');

  /** Собрать адреса набора и записать их (пусто — `null`). */
  const commit = (): void => {
    const addresses = [...ordered];
    const payload = addresses.length === 0 ? null : isMultiple ? addresses : addresses[0]!;
    const key = opts.definition.key ?? '';
    void Promise.resolve()
      .then(() => opts.save(payload))
      .then((ok) => {
        // Успешная запись — сервер уже сделал живой резолв и обновил снапшоты:
        // просим таблицу свойств перечитать значение (иначе подписи из диалога,
        // где имя цели неизвестно, остались бы адресами).
        if (ok === true) notifyPropertyValuesRefreshed(key);
      });
  };

  /** Снять цель из набора и сохранить остаток. */
  const removeEntry = (address: string): void => {
    const index = ordered.indexOf(address);
    if (index >= 0) ordered.splice(index, 1);
    entries.delete(address);
    render();
    commit();
  };

  /**
   * Открыть цель в её сети (требование 95511443): переход через
   * {@link openWikiIdTarget} (контроль уже открытых вкладок), после успеха —
   * точечный резолв снапшота в сети-источнике значения.
   */
  const openEntry = async (entry: CrossNetworkRefEntry): Promise<void> => {
    try {
      await openWikiIdTarget(entry.networkId, entry.thoughtId);
    } catch {
      // openWikiIdTarget сам показывает тост при ошибке сети/мысли.
      return;
    }
    if (opts.ownerType !== 'thought' || opts.ownerId === undefined) return;
    const key = opts.definition.key ?? '';
    if (key === '') return;
    try {
      await etn.properties.crossResolve(opts.networkId, opts.ownerId, key);
    } catch {
      // Тихо: цель всё равно открыта, обновление снапшота — удобство.
    }
  };

  /**
   * «Обновить имя» — точечный `crossResolve` сети-источника (требование
   * 95511443): снапшоты и пометки нерезолвленности приходят из ответа, чипы
   * перерисовываются; ошибка — тост.
   */
  const refreshNames = async (): Promise<void> => {
    if (opts.ownerType !== 'thought' || opts.ownerId === undefined) {
      notice('Обновление имени доступно только для свойств мыслей.', 'error');
      return;
    }
    const key = opts.definition.key ?? '';
    if (key === '') return;
    try {
      const result = await etn.properties.crossResolve(opts.networkId, opts.ownerId, key);
      for (const value of result.values) {
        if (value.network_id === '' || value.thought_id === '') continue;
        let address: string;
        try {
          address = formatCrossNetworkAddress(value.network_id, value.thought_id);
        } catch {
          continue;
        }
        addEntry({
          address,
          networkId: value.network_id,
          thoughtId: value.thought_id,
          title: value.title_snapshot,
          unresolved: value.unresolved,
        });
      }
      render();
      const unresolved = result.values.filter((v) => v.unresolved).length;
      notice(
        unresolved === 0
          ? 'Снапшоты обновлены.'
          : `Обновлено ${result.values.length - unresolved} из ${result.values.length}; ${unresolved} нерезолвлено.`,
        'info',
      );
      notifyPropertyValuesRefreshed(key);
    } catch (err) {
      notice(`Не удалось обновить имя: ${errText(err)}`, 'error');
    }
  };

  /** Контекстное меню чипа: три команды значения (ошибка 9be98ae1). */
  const openChipMenu = (entry: CrossNetworkRefEntry, anchor: HTMLElement): void => {
    const items: MenuItem[] = [
      { label: 'Открыть', onClick: () => void openEntry(entry) },
      { label: 'Обновить имя', onClick: () => void refreshNames() },
      { label: 'Удалить из значения', onClick: () => removeEntry(entry.address) },
    ];
    const rect = anchor.getBoundingClientRect();
    showMenuAt(rect.left, rect.bottom, items);
  };

  /** Мини-облачко цели: значок, метка «чужой сети», подпись-снапшот, «✕». */
  const buildChip = (entry: CrossNetworkRefEntry): HTMLElement => {
    const netLabel = shortCrossNetworkLabel(entry.networkId);
    const chip = createThoughtCloud(
      { id: entry.thoughtId, title: entry.title, type_id: null },
      {
        profile: 'chip',
        width: 'container',
        networkBadge: { label: netLabel },
        actions: {
          onClick: () => void openEntry(entry),
          onContextMenu: (event) => {
            event?.stopPropagation?.();
            openChipMenu(entry, chip);
          },
          onRemove: () => removeEntry(entry.address),
        },
      },
    );
    chip.classList.add('cross-network-ref-chip');
    if (entry.unresolved) chip.classList.add('cross-network-ref-chip--unresolved');
    // Ctrl+наведение — предпросмотр комментария чужой мысли; имя сети-источника
    // попадает в заголовок попапа (ошибка 9be98ae1).
    markCrossNetworkThoughtPreview(chip, entry.networkId, entry.thoughtId, entry.title);
    setTooltip(
      chip,
      entry.unresolved
        ? `${entry.title} — ${netLabel} (нерезолвлено)`
        : `${entry.title} — ${netLabel} (${entry.address})`,
    );
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', entry.title);
    // Клавиатура — доменная часть чипа: Enter открывает цель, Shift+F10/F10 —
    // меню; пробел отдаём общим жестам фабрики (фокус).
    chip.addEventListener('keydown', (event) => {
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault();
        openChipMenu(entry, chip);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void openEntry(entry);
      }
    });
    return chip;
  };

  // Поле живого веерного поиска по чужим сетям (кнопка выбрасывается при
  // перерисовке — слушатели окна снимаются по `!isConnected`, как в выпадашке).
  const addInput = fieldInput({
    extraClass: 'value-combo-add cross-network-ref-add',
    bare: true,
  }) as HTMLInputElement;
  addInput.type = 'text';
  addInput.autocomplete = 'off';
  addInput.placeholder = 'Название мысли в другой сети…';

  const searchSource: SuggestSource = {
    when: 'typed',
    header: 'Мысли других сетей',
    load: async (query): Promise<SuggestEntry[]> => {
      const trimmed = query.trim();
      if (trimmed === '') return [];
      const hits = await loadCrossNetworkCandidates(opts.networkId, trimmed, []);
      const out: SuggestEntry[] = [];
      for (const hit of hits) {
        const netId = hit.network_id;
        // Своя сеть в значении кросс-сетевой ссылки запрещена (требование
        // 884d14e1) — кандидатов текущей сети отсекаем.
        if (netId === undefined || netId === '' || netId === opts.networkId) continue;
        let address: string;
        try {
          address = formatCrossNetworkAddress(netId, hit.id);
        } catch {
          continue;
        }
        out.push({ value: address, label: hit.title, thought: { ...hit } });
      }
      return out;
    },
  };
  wireSuggest(addInput, {
    sources: [searchSource],
    onPick: (entry) => {
      const address = entry.value;
      addInput.value = '';
      const parsed = parseCrossNetworkAddress(address);
      if (parsed === null) return;
      if (!isMultiple) {
        entries.clear();
        ordered.length = 0;
      }
      addEntry({
        address,
        networkId: parsed.networkId,
        thoughtId: parsed.thoughtId,
        title: entry.label,
        unresolved: false,
      });
      render();
      commit();
    },
  });

  /**
   * Диалог «Выбрать…»: принудительный кросс-сетевой охват (своё имя цели
   * диалог не несёт — подписи подтянет перечитывание значения после записи).
   */
  const openCrossPicker = (): void => {
    void pickThoughtsDialog({
      networkId: opts.networkId,
      allowCreate: false,
      allowLinkType: false,
      title: 'Выбор мысли из другой сети',
      applyLabel: isMultiple ? 'Добавить' : 'Выбрать',
      crossNetwork: { excludeNetworkId: opts.networkId },
    }).then((result) => {
      if (result === null) return;
      const picked: string[] = [];
      for (const item of result.items) {
        if (item.kind !== 'existing') continue;
        const netId = item.networkId;
        if (netId === undefined || netId === '' || netId === opts.networkId) continue;
        try {
          picked.push(formatCrossNetworkAddress(netId, item.id));
        } catch {
          continue;
        }
      }
      if (picked.length === 0) {
        notice('Мысль другой сети не выбрана — кросс-сетевая ссылка на свою сеть запрещена.', 'info');
        return;
      }
      if (!isMultiple) {
        entries.clear();
        ordered.length = 0;
      }
      for (const address of picked) {
        const parsed = parseCrossNetworkAddress(address);
        if (parsed === null) continue;
        addEntry({
          address,
          networkId: parsed.networkId,
          thoughtId: parsed.thoughtId,
          title: address,
          unresolved: false,
        });
      }
      render();
      commit();
    });
  };

  // Угловые кнопки — как у поля свойства-связи: «…» открывает диалог выбора,
  // «✕» очищает значение целиком.
  const corner = div('link-value-corner');
  const pickBtn = button('…', openCrossPicker, 'link-value-corner-btn cross-network-ref-pick', 'Выбрать мысль другой сети…');
  const clearBtn = button(
    '✕',
    () => {
      if (ordered.length === 0) return;
      entries.clear();
      ordered.length = 0;
      render();
      commit();
    },
    'link-value-corner-btn',
    'Очистить значение',
  );
  corner.append(pickBtn, clearBtn);

  const render = (): void => {
    field.replaceChildren();
    for (const address of ordered) {
      const entry = entries.get(address);
      if (entry === undefined) continue;
      field.append(buildChip(entry));
    }
    addInput.placeholder = ordered.length === 0 ? 'Название мысли в другой сети…' : '+ ещё одну мысль';
    field.append(addInput);
    clearBtn.hidden = ordered.length === 0;
  };
  // Клик по свободному месту поля — фокус в живой поиск.
  field.addEventListener('click', (event) => {
    if (event.target === field) addInput.focus();
  });
  wrap.append(field, corner);
  const row = div('form-row');
  row.style.marginBottom = '0';
  row.append(wrap);
  root.append(row);
  render();
  return root;
}

/** Достать массив снапшотов из `value` (CrossNetworkRefValue[]); пусто — нет. */
function readSnapshotFromValue(value: unknown): CrossNetworkRefValue[] {  if (!Array.isArray(value)) return [];
  const out: CrossNetworkRefValue[] = [];
  for (const item of value) {
    if (
      item !== null &&
      typeof item === 'object' &&
      'network_id' in item &&
      'thought_id' in item &&
      'title_snapshot' in item &&
      'unresolved' in item
    ) {
      out.push(item as CrossNetworkRefValue);
    }
  }
  return out;
}

/** Достать сырые адреса (строки) из `value` — для отображения в поле ввода. */
function readAddressesFromValue(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item !== '') out.push(item);
  }
  return out;
}

/**
 * Короткое имя сети: из каталога сетей, иначе — префикс id. Локальный
 * клон хелпера из editor/properties.ts — здесь нужен только в основной
 * таблице, чтобы избежать циклического импорта.
 */
function shortCrossNetworkLabel(networkId: string): string {
  const fromCatalog = store.state.networkList.find((n) => n.id === networkId);
  if (fromCatalog !== undefined && fromCatalog.display_name !== '') {
    return fromCatalog.display_name;
  }
  return networkId.length >= 8 ? networkId.slice(0, 8) : networkId;
}

/** Человекочитаемая метка вида значения (заголовки таблиц свойств). */
export function valueTypeName(valueType: string): string {
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

// ---------------------------------------------------------------------------
// Общие механики
// ---------------------------------------------------------------------------

// Обёртка поля с кнопкой очистки («✕») перенесена в фасад поля
// `lib/ui/field.ts` — `wrapClearable` (требование e64083b5: clearable
// поглощается Field). Импортируется выше и переиспользуется редактором.

/**
 * Очистка крестиком «✕»: change-режим пишет `null` напрямую (blur-обработчика
 * в нём нет), blur-режим переиспользует существующий blur-коммит с baseline
 * (пустое → `null` → удаление значения на сервере, с rollback при неудаче).
 */
function makeClearNow(
  input: HTMLInputElement,
  commitOn: 'blur' | 'change',
  save: (next: unknown | null) => Promise<boolean> | boolean,
): () => void {
  return () => {
    input.value = '';
    if (commitOn === 'change') {
      void save(null);
    } else {
      input.dispatchEvent(new Event('blur'));
    }
  };
}

/**
 * Источник «история последних значений» для text/url: строки как есть.
 * Подпись строки — она сама; пустая история — пустой ответ (список не
 * открывается).
 */
function textHistorySource(networkId: string, propertyId: string): SuggestSource {
  return historySuggestSource({
    load: () => {
      const values = loadRecentValues(networkId, propertyId);
      return values.map((value) => ({ value, label: value }));
    },
  });
}

/** Кеш id → DTO цели для истории свойства-связи (по network+property). */
const linkHistoryRefs = new Map<string, Map<string, ThoughtRef>>();

/**
 * Источник «история последних целей» для свойства-связи: значения — id
 * мыслей, DTO догружаются батч-резолвом (неудача — сырой id голой строкой).
 * Строка-мысль идёт облачком фабрики: значок, цвета, начертание, бледность
 * неактуальной, метка корзины (S1).
 */
function linkHistorySource(networkId: string, propertyId: string): SuggestSource {
  return historySuggestSource({
    load: async () => {
      const ids = loadRecentValues(networkId, propertyId);
      if (ids.length === 0) return [];
      const key = `${networkId}:${propertyId}`;
      let refs = linkHistoryRefs.get(key);
      if (refs === undefined) {
        refs = new Map();
        linkHistoryRefs.set(key, refs);
      }
      const missing = ids.filter((id) => !refs!.has(id));
      if (missing.length > 0) {
        try {
          const resolved = await etn.thoughts.resolve(networkId, missing);
          for (const ref of resolved) refs!.set(ref.id, ref);
        } catch {
          // Оффлайн: оставшиеся id покажутся голой строкой.
        }
      }
      return ids.map((id) => {
        const ref = refs!.get(id);
        return ref === undefined
          ? { value: id, label: id }
          : { value: id, label: ref.title, thought: { ...ref } };
      });
    },
  });
}

/**
 * Источник живого поиска целей свойства-связи (отбор по типам — input aid).
 * Строка-мысль — облачком. Поиск порционный (задача c8fa74ba): при большом
 * числе кандидатов список целей догружается по мере скролла выпадашки, а не
 * обрезается одной серверной порцией. `scope: 'names'` — кандидаты ищутся по
 * названию/синониму (совпадает с прежним поведением `findDuplicates`).
 */
const LINK_TARGETS_PAGE_SIZE = 50;

/** Хит поиска по именам (`by_names`) → строка-облачко выпадашки. Поля
 *  визуала переносятся как есть (спред DTO) — представление мысли строит
 *  общая фабрика облачка, а не этот маппер (стандарт S1, сторож
 *  `guard-thought-cloud`). */
function nameHitToSuggestEntry(hit: SearchNameHit): SuggestEntry {
  return {
    value: hit.thought_id,
    label: hit.title,
    thought: { ...hit, id: hit.thought_id },
  };
}

function linkSearchSource(networkId: string, typeIds: string[]): SuggestSource {
  const filter = typeIds.filter((id) => id !== '');
  const loadPage = async (query: string, offset: number): Promise<SuggestEntry[]> => {
    const trimmed = query.trim();
    if (trimmed === '') return [];
    try {
      const response = await etn.thoughts.search(networkId, {
        q: trimmed,
        scope: 'names',
        ...(filter.length > 0 ? { type_id: filter } : {}),
        limit: LINK_TARGETS_PAGE_SIZE,
        offset,
      });
      return response.by_names.map(nameHitToSuggestEntry);
    } catch {
      return [];
    }
  };
  return {
    when: 'typed',
    load: (query) => loadPage(query, 0),
    loadMore: (query, offset) => loadPage(query, offset),
    pageSize: LINK_TARGETS_PAGE_SIZE,
  };
}

// ---------------------------------------------------------------------------
// Строковые виды (text / url)
// ---------------------------------------------------------------------------

/**
 * Сохранённое значение строкового поля: строка (одиночное), `string[]`
 * (множественный `url`) или null.
 */
type StoredTextValue = string | string[] | null | undefined;

/** Читает сохранённое значение одиночного text/url как строку. */
function asSingleString(value: StoredTextValue): string {
  return typeof value === 'string' ? value : '';
}

/** Читает сохранённое значение множественного text (comma-joined) как список. */
function asTextItems(value: StoredTextValue): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return splitMultiValue(value);
  return [];
}

/** Читает сохранённое значение множественного url как список. */
function asUrlItems(value: StoredTextValue): string[] {
  if (Array.isArray(value)) return value.filter((v) => v !== '');
  if (typeof value === 'string' && value !== '') return [value];
  return [];
}

/** Пишет успешное строковое значение в историю (best effort). */
function recordTextHistory(networkId: string, propertyId: string, value: string): void {
  recordRecentValue(networkId, propertyId, value);
}

/** Пишет успешный набор в историю — каждый элемент отдельной записью. */
function recordTextItemsHistory(networkId: string, propertyId: string, items: readonly string[]): void {
  for (const item of items) recordRecentValue(networkId, propertyId, item);
}

/** Строковый текстовый чип множественного значения (без значка мысли). */
function buildTextChip(value: string, opts: {
  icon: string;
  onRemove: () => void;
  onClick?: () => void;
}): HTMLElement {
  return createThoughtCloud(
    { id: value, title: value, icon: opts.icon, icon_kind: 'emoji' },
    {
      profile: 'chip',
      // Ширина — по чип-полю множественного значения (ошибка 10ad23d1):
      // длинное значение обрезается многоточием, а не раздувает таблицу.
      width: 'container',
      actions: {
        onClick: opts.onClick === undefined ? undefined : () => opts.onClick?.(),
        onRemove: () => opts.onRemove(),
      },
    },
  );
}

/**
 * Чип-редактор нескольких значений (задача вехи 4: `config.multiple` — чипы,
 * а не списки строк). Один чип на значение; поле добавления с общей
 * выпадашкой (история + закрытый список `config.options` для text; у свойства
 * со списком история не подключается, а список открывается сразу — карточка
 * ошибки 4a96d07a);
 * Enter на свободном тексте добавляет чип, клик/Enter по строке выпадашки —
 * её выбор; «✕» у чипа убирает значение. Сохранение — набором на каждое
 * изменение (`save([])` при пустом наборе).
 */
function buildMultiTextChipsEditor(opts: {
  kind: 'text' | 'url';
  networkId: string;
  items: string[];
  definition: Pick<EffectiveTypeProperty, 'config'>;
  save: (next: unknown | null) => Promise<boolean> | boolean;
  historyPropertyId?: string;
  extraSuggest?: readonly SuggestSource[];
}): HTMLElement {
  const { kind, definition } = opts;
  let items = [...opts.items];
  const root = div('st-f-chipfield value-chips-field');

  // Свойство со списком вариантов: история не ведётся — выпадашку занимает
  // сам список, который открывается сразу при входе в поле добавления и до
  // первой правки показывается целиком (карточка ошибки 4a96d07a). Значение
  // в `store` тоже не пишем: история без выпадашки-истории бессмысленна.
  const options = kind === 'text' ? (definition.config?.options ?? []).filter((o) => o !== '') : [];

  const commit = (next: string[]): void => {
    items = next;
    render();
    const payload = kind === 'text' ? next.join(', ') : next;
    void Promise.resolve()
      .then(() => opts.save(next.length > 0 ? payload : null))
      .then((ok) => {
        if (ok === true && opts.historyPropertyId !== undefined && options.length === 0) {
          recordTextItemsHistory(opts.networkId, opts.historyPropertyId, next);
        }
      });
  };

  const render = (): void => {
    root.replaceChildren();
    for (const item of items) {
      root.append(
        buildTextChip(item, {
          icon: kind === 'url' ? '🔗' : '',
          onRemove: () => commit(items.filter((v) => v !== item)),
          ...(kind === 'url'
            ? {
                onClick: () => {
                  void openUrlExternally(item);
                },
              }
            : {}),
        }),
      );
    }
    const input = fieldInput({ extraClass: 'prop-editor value-chips-input' }) as HTMLInputElement;
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = kind === 'url' ? 'https://… или путь к файлу' : '+ ещё одно значение';
    if (kind === 'url') input.title = 'URL или путь к файлу';

    // Свойство со списком вариантов: история не ведётся — выпадашку занимает
    // сам список, который открывается сразу при входе в поле добавления и до
    // первой правки показывается целиком (карточка ошибки 4a96d07a).
    let edited = false;
    input.addEventListener('focus', () => {
      edited = false;
    });
    input.addEventListener('input', () => {
      edited = true;
    });
    const sources: SuggestSource[] = [];
    if (opts.historyPropertyId !== undefined && options.length === 0) {
      sources.push(textHistorySource(opts.networkId, opts.historyPropertyId));
    }
    if (options.length > 0) {
      sources.push(
        optionsSuggestSource(options, {
          header: 'Варианты',
          showAllUntilEdited: () => !edited,
        }),
      );
    }
    // Источники вызывающего (токены отбора) — общий список подсказок.
    if (opts.extraSuggest !== undefined) sources.push(...opts.extraSuggest);
    let handle: SuggestHandle | null = null;
    if (sources.length > 0) {
      handle = wireSuggest(input, {
        sources,
        onPick: (entry) => {
          const value = entry.value;
          input.value = '';
          if (!items.includes(value)) commit([...items, value]);
        },
      });
      // Угловая каретка — полный список вариантов (handle.open игнорирует when).
      if (kind === 'text') {
        const caret = uiButton({
          label: '▾',
          role: 'secondary',
          size: 's',
          title: 'Выбрать значение из списка',
          onClick: () => handle?.open(),
        });
        caret.style.marginLeft = '4px';
        root.append(caret);
      }
    }
    // Enter на свободном тексте добавляет чип; Enter строки выпадашки уже
    // обработан `wireSuggest` (event.defaultPrevented — выбор строки).
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.defaultPrevented) return;
      const value = input.value.trim();
      if (value === '') return;
      event.preventDefault();
      input.value = '';
      if (!items.includes(value)) commit([...items, value]);
    });
    root.append(input);
  };

  render();
  return root;
}

/** Hand a single URL to the OS default handler; failure → toast. */
async function openUrlExternally(value: string): Promise<void> {
  const trimmed = value.trim();
  if (trimmed === '') return;
  const err = await etn.system.openExternal(trimmed);
  if (err !== '') notice(`Не удалось открыть: ${err}`, 'error');
}

/**
 * Одиночное строковое поле (text / url): blur-коммит с baseline и rollback,
 * «✕» очистки, для url — «Открыть»; подсказки — общая выпадашка (история на
 * пустом поле + закрытый список `config.options` для text; каретка ▾
 * открывает полный список вариантов). У свойства со списком вариантов история
 * не подключается, а список открывается сразу при входе в поле и до первой
 * правки показывается целиком (карточка ошибки 4a96d07a).
 */
function buildScalarTextEditor(opts: ValueEditorOptions, kind: 'text' | 'url'): HTMLElement {
  const { definition } = opts;
  const stored = asSingleString(opts.value as StoredTextValue);
  const input = fieldInput({ extraClass: 'prop-editor' }) as HTMLInputElement;
  input.type = 'text';
  input.autocomplete = 'off';
  input.value = stored;
  if (kind === 'url') {
    input.placeholder = opts.placeholder ?? 'https://… или путь к файлу';
    input.title = 'URL или путь к файлу';
  } else if (opts.placeholder !== undefined) {
    input.placeholder = opts.placeholder;
  }

  const commitOn = opts.commitOn ?? 'blur';
  const clearNow = makeClearNow(input, commitOn, opts.save);
  // Свойство со списком вариантов (`config.options`): история последних
  // значений не ведётся — выпадашку занимает сам список вариантов, который
  // открывается сразу при входе в поле и до первой правки показывается
  // целиком (карточка ошибки 4a96d07a). В `localStorage` запись тоже не идёт.
  const options: string[] =
    kind === 'text' ? (definition.config?.options ?? []).filter((o) => o !== '') : [];
  if (commitOn === 'change') {
    input.addEventListener('input', () => {
      const next = input.value.trim() === '' ? null : input.value;
      void opts.save(next);
    });
    if (kind === 'url') {
      input.addEventListener('change', () => {
        void opts.save(input.value.trim() === '' ? null : input.value);
      });
    }
  } else {
    // Baseline tracks the last **successfully saved** value so picker
    // commits and plain blur commits never fire twice for the same value,
    // and a failed save rolls back instead of leaving the field in a
    // "looks saved but isn't" state (карточка 7d094c26).
    let baseline: string | null = stored === '' ? null : stored;
    const commitValue = (value: string): void => {
      const next = value === '' ? null : value;
      if (next === baseline) return;
      const prev = baseline;
      baseline = next;
      void Promise.resolve()
        .then(() => opts.save(next))
        .then((ok) => {
          if (ok !== true) {
            // Restore the baseline so the next blur retries the write.
            baseline = prev;
            return;
          }
          if (opts.historyPropertyId !== undefined && typeof next === 'string' && options.length === 0) {
            recordTextHistory(opts.networkId, opts.historyPropertyId, next);
          }
        });
    };
    input.addEventListener('blur', () => commitValue(input.value));
  }

  const sources: SuggestSource[] = [];
  // Правка поля пользователем: до неё содержимое (текущее значение) не
  // считается введённым запросом — см. `showAllUntilEdited` ниже.
  let edited = false;
  input.addEventListener('focus', () => {
    edited = false;
  });
  input.addEventListener('input', () => {
    edited = true;
  });
  if (opts.historyPropertyId !== undefined && options.length === 0) {
    sources.push(textHistorySource(opts.networkId, opts.historyPropertyId));
  }
  if (options.length > 0) {
    sources.push(
      optionsSuggestSource(options, {
        header: 'Варианты',
        showAllUntilEdited: () => !edited,
      }),
    );
  }
  // Источники вызывающего (токены отбора) — в том же списке подсказок
  // (инструкция «Пикер … источник вариантов — её параметр»).
  if (opts.extraSuggest !== undefined) sources.push(...opts.extraSuggest);
  let handle: SuggestHandle | null = null;
  if (sources.length > 0) {
    handle = wireSuggest(input, {
      sources,
      onPick: (entry) => {
        input.value = entry.value;
        if (commitOn === 'blur') {
          // Выбор из выпадашки — тот же коммит, что blur.
          input.dispatchEvent(new Event('blur'));
        } else {
          input.dispatchEvent(new Event('input'));
        }
      },
    });
  }

  if (options.length > 0 && handle !== null) {
    const row = div('form-row');
    row.style.marginBottom = '0';
    row.append(
      wrapClearable(input, clearNow),
      uiButton({
        label: '▾',
        role: 'secondary',
        size: 's',
        title: 'Выбрать значение из списка',
        onClick: () => handle?.open(),
      }),
    );
    return row;
  }
  if (kind === 'url') {
    const openBtn = uiButton({
      label: 'Открыть',
      role: 'secondary',
      size: 's',
      onClick: () => void openUrlExternally(input.value),
    });
    const syncOpenBtn = (): void => {
      openBtn.disabled = input.value.trim() === '';
    };
    input.addEventListener('input', syncOpenBtn);
    syncOpenBtn();
    const clearUrl = (): void => {
      input.value = '';
      syncOpenBtn();
      if (commitOn === 'change') {
        void opts.save(null);
      } else {
        input.dispatchEvent(new Event('blur'));
      }
    };
    const row = div('form-row');
    row.style.marginBottom = '0';
    row.append(wrapClearable(input, clearUrl), openBtn);
    return row;
  }
  return wrapClearable(input, clearNow);
}

/** Поле текстового свойства: multiple — чипы, иначе одиночное поле. */
function buildTextEditor(opts: ValueEditorOptions): HTMLElement {
  if (opts.definition.config?.multiple === true) {
    return buildMultiTextChipsEditor({
      kind: 'text',
      items: asTextItems(opts.value as StoredTextValue),
      definition: opts.definition,
      save: opts.save,
      historyPropertyId: opts.historyPropertyId,
      networkId: opts.networkId,
      extraSuggest: opts.extraSuggest,
    });
  }
  return buildScalarTextEditor(opts, 'text');
}

/** Поле url-свойства: multiple — чипы (клик чипа открывает URL), иначе одиночное. */
function buildUrlEditor(opts: ValueEditorOptions): HTMLElement {
  if (opts.definition.config?.multiple === true) {
    return buildMultiTextChipsEditor({
      kind: 'url',
      items: asUrlItems(opts.value as StoredTextValue),
      definition: opts.definition,
      save: opts.save,
      historyPropertyId: opts.historyPropertyId,
      networkId: opts.networkId,
      extraSuggest: opts.extraSuggest,
    });
  }
  return buildScalarTextEditor(opts, 'url');
}

// ---------------------------------------------------------------------------
// number / date / bool
// ---------------------------------------------------------------------------

/** Одиночное число: blur-коммит с baseline (ошибки cefb4db0, 7d094c26). */
function buildNumberEditor(opts: ValueEditorOptions): HTMLElement {
  const stored = typeof opts.value === 'number' ? opts.value : null;
  const input = fieldInput({ extraClass: 'prop-editor' }) as HTMLInputElement;
  input.type = 'number';
  input.value = stored === null ? '' : String(stored);

  const commitOn = opts.commitOn ?? 'blur';
  const clearNow = makeClearNow(input, commitOn, opts.save);
  if (commitOn === 'change') {
    input.addEventListener('input', () => {
      const next = input.value === '' ? null : Number(input.value);
      void opts.save(next !== null && !Number.isFinite(next) ? null : next);
    });
  } else {
    let baseline: number | null = stored;
    input.addEventListener('blur', () => {
      if (input.value === '') {
        if (baseline === null) return;
        const prev = baseline;
        baseline = null;
        void Promise.resolve()
          .then(() => opts.save(null))
          .then((ok) => {
            if (ok !== true) baseline = prev;
          });
        return;
      }
      const next = Number(input.value);
      if (!Number.isFinite(next) || next === baseline) return;
      const prev = baseline;
      baseline = next;
      void Promise.resolve()
        .then(() => opts.save(next))
        .then((ok) => {
          if (ok !== true) baseline = prev;
        });
    });
  }
  return wrapClearable(input, clearNow);
}

/** Одиночная дата: blur-коммит с baseline (ошибки cefb4db0, 7d094c26). При
 *  источниках подсказок вызывающего (токены отбора) — текстовое поле: токен
 *  `$today+7d` в `<input type="date">` не помещается. */
function buildDateEditor(opts: ValueEditorOptions): HTMLElement {
  if (opts.extraSuggest !== undefined && opts.extraSuggest.length > 0) {
    return buildScalarTextEditor(opts, 'text');
  }
  const stored = typeof opts.value === 'string' ? opts.value.slice(0, 10) : null;
  const input = fieldInput({ extraClass: 'prop-editor' }) as HTMLInputElement;
  input.type = 'date';
  input.value = stored ?? '';

  const commitOn = opts.commitOn ?? 'blur';
  const clearNow = makeClearNow(input, commitOn, opts.save);
  if (commitOn === 'change') {
    input.addEventListener('change', () => {
      void opts.save(input.value === '' ? null : input.value);
    });
  } else {
    let baseline: string | null = stored;
    input.addEventListener('blur', () => {
      const next = input.value === '' ? null : input.value;
      if (next === baseline) return;
      const prev = baseline;
      baseline = next;
      void Promise.resolve()
        .then(() => opts.save(next))
        .then((ok) => {
          if (ok !== true) baseline = prev;
        });
    });
  }
  return wrapClearable(input, clearNow);
}

/** Да/нет: checkbox (change-коммит); опционально трёхзначный select. */
function buildBoolEditor(opts: ValueEditorOptions): HTMLElement {
  const stored = opts.value === true;
  const commitOn = opts.commitOn ?? 'blur';
  if (opts.boolTriState === true) {
    const select = el('select', 'select-input') as HTMLSelectElement;
    select.append(
      el('option', undefined, '—'),
      el('option', undefined, 'да'),
      el('option', undefined, 'нет'),
    );
    select.value = opts.value === null || opts.value === undefined ? '' : opts.value === true ? 'да' : 'нет';
    select.addEventListener('change', () => {
      const next = select.value === '' ? null : select.value === 'да';
      void opts.save(next);
    });
    return select;
  }
  const input = choiceControl('checkbox', {
    checked: stored,
    onChange: (checked) => {
      void Promise.resolve()
        .then(() => opts.save(checked))
        .then((ok) => {
          if (ok !== true && commitOn === 'blur') input.checked = !checked;
        });
    },
  });
  return input;
}

// ---------------------------------------------------------------------------
// Свойство-связь (buildLinkValueEditor)
// ---------------------------------------------------------------------------

/** Cap on the batched resolve call — server-side limit of `thoughts.resolve`. */
const RESOLVE_BATCH = 100;

/**
 * Дозаполняет кеш метаданных целей (значок, цвета, active, пометка) батч-резолвом
 * `etn.thoughts.resolve`. Подписи уже есть в рёбрах (`target_title`); этот
 * запрос нужен только для отрисовки мини-облачков. Неудача не фатальна —
 * облачко показывает сырой id.
 */
async function resolveLinkRefs(
  networkId: string,
  ids: string[],
  refs: Map<string, ThoughtRef>,
): Promise<void> {
  const missing = ids.filter((id) => !refs.has(id));
  if (missing.length === 0) return;
  try {
    const resolved = await etn.thoughts.resolve(networkId, missing.slice(0, RESOLVE_BATCH));
    for (const ref of resolved) refs.set(ref.id, ref);
  } catch {
    // Оффлайн-мигание — чипы останутся с подписями из рёбер.
  }
}

/**
 * Открывает мысль в редакторе без смены фокуса (как облачко на холсте). На
 * ошибке показывает тост.
 */
function openLinkRefInEditor(networkId: string, id: string): void {
  void Promise.resolve()
    .then(async () => {
      const { openThoughtInEditor } = await import('./editor.js');
      openThoughtInEditor(id);
    })
    .catch((err: unknown) => notice(errText(err), 'error'));
}

/**
 * Ставит мысль в фокус и активирует экран «Карта мыслей» — общий помощник
 * `focusThoughtOnMap` (ошибка 562356a9): фокус без переключения на карту
 * незаметен, если пользователь находится на другом экране (структуры,
 * хроника, события).
 */
function focusLinkRef(networkId: string, id: string): void {
  void Promise.resolve()
    .then(async () => {
      const { focusThoughtOnMap } = await import('../screens/active-view.js');
      await focusThoughtOnMap(id);
    })
    .catch((err: unknown) => notice(errText(err), 'error'));
}

/**
 * Контекстное меню мысли для мини-облачка в редакторе: та же композиция, что
 * у облачка на холсте (`canvas/context-menu.ts`), плюс команды контекста
 * редактора. Холст тянем лениво: статический импорт замкнул бы цикл
 * `canvas/context-menu → editor/editor → editor/value-editor`.
 */
async function openThoughtCloudMenu(opts: {
  networkId: string;
  id: string;
  title: string;
  trashed: boolean;
  extraItems?: MenuItem[];
  anchor: Element;
}): Promise<void> {
  const { showThoughtMenuUnder, resolveSiblingParentId } =
    await import('../canvas/context-menu.js');
  showThoughtMenuUnder(
    opts.anchor,
    {
      id: opts.id,
      title: opts.title,
      dir: 'siblings',
      // Чип не живёт в зоне холста — родителя для «налево (родственник)»
      // резолвим запросом (на холсте он приходит с ответом фокуса).
      siblingParentId: await resolveSiblingParentId(opts.networkId, opts.id),
      trashed: opts.trashed,
    },
    {
      openLabel: 'Открыть в редакторе',
      openHandler: (id) => openLinkRefInEditor(opts.networkId, id),
      focusHandler: () => focusLinkRef(opts.networkId, opts.id),
      ...(opts.extraItems !== undefined ? { extraItems: opts.extraItems } : {}),
    },
  );
}

/** Клик по метке корзины чипа — двухфазный диалог «Удалить/Восстановить». */
async function openTrashBadgeDialog(
  networkId: string,
  id: string,
  title: string,
): Promise<void> {
  const { openThoughtDeleteDialog } = await import('../trash.js');
  await openThoughtDeleteDialog(networkId, { id, title });
}

/** Контекстное меню read-only чипа внетипового ребра (cab38479). */
async function openReadonlyChipMenu(opts: {
  networkId: string;
  id: string;
  fullTitle: string;
  ref: ThoughtRef | undefined;
  chip: Element;
  /** Команды контекста редактора (748b80fd) — операции над ребром. */
  extraItems?: MenuItem[];
}): Promise<void> {
  await openThoughtCloudMenu({
    networkId: opts.networkId,
    id: opts.id,
    title: opts.fullTitle,
    trashed: opts.ref?.marked_for_deletion === true,
    anchor: opts.chip,
    ...(opts.extraItems !== undefined ? { extraItems: opts.extraItems } : {}),
  });
}

/**
 * Контекстное меню мини-облачка значения свойства-связи. Набор команд — общий
 * с холстом; отличие значения — операции над ребром (задача 0d4f793a):
 * «Удалить связь с мыслью» (как крестик без Shift: авто-выбор удаление/корзина)
 * и «Поместить связь в корзину» (как Shift+крестик). Прежней единственной
 * команды «Убрать из значения» больше нет.
 */
async function showLinkChipMenu(
  networkId: string,
  id: string,
  title: string,
  trashed: boolean,
  onDelete: () => void,
  onTrash: () => void,
  anchor: Element,
): Promise<void> {
  await openThoughtCloudMenu({
    networkId,
    id,
    title,
    trashed,
    anchor,
    extraItems: [
      { label: 'Удалить связь с мыслью', onClick: onDelete },
      { label: 'Поместить связь в корзину', onClick: onTrash },
    ],
  });
}

/**
 * Read-only мини-облачко для ребра внетипового свойства (cab38479): те же
 * визуал и обработчики (клик, двойной клик, Ctrl+Click → панель выбранных,
 * ПКМ/Shift+F10 → контекстное меню), что у редактируемого чипа.
 *
 * `removal` (0.8.2, ошибка 748b80fd): у ребра типа связи без реестрового
 * свойства (property_id пуст) ключа записи в наборе не было — из GUI связь не
 * удалялась. Теперь ключом служит display-имя стороны (`propertyName`), которое
 * сервер понимает (`resolveDefinition` шаг 3), и контекстное меню получает
 * команды «Удалить связь с мыслью» / «Поместить связь в корзину» — как у чипов
 * основной таблицы (`showLinkChipMenu`), с тем же выбором способа по режиму
 * (задача 0d4f793a). Крестик «×» очистки набора целиком рисует вызывающий
 * (ячейка «Свойства вне типа»).
 */
export function buildOutsideReadonlyEdgeChip(
  networkId: string,
  edge: LinkPropertyValueItem,
  refs: Map<string, ThoughtRef>,
  removal?: {
    /** Снять это ребро из набора: `auto` — как крестик, `trash` — в корзину. */
    removeTarget: (targetId: string, mode: LinkValueRemovalMode) => void;
  },
): HTMLElement {
  const ref = refs.get(edge.target_id);
  // Полное имя цели: свежая подпись ребра, иначе заголовок из кеша, иначе
  // сырой id — видимую длину ограничивает раскладка фабричного чипа, а не
  // подсчёт символов (ADR «Обрезка текста — раскладкой»).
  const fullTitle = edge.target_title ?? ref?.title ?? edge.target_id;
  const chip = createThoughtCloud(
    ref ?? { id: edge.target_id, title: fullTitle },
    {
      profile: 'chip',
      // Ширина — по колонке значения (ошибка 10ad23d1): имя обрезается
      // многоточием, а не раздувает таблицу «Свойства вне типа».
      width: 'container',
      actions: {
        onClick: (id) => openLinkRefInEditor(networkId, id),
        onDoubleClick: (id) => focusLinkRef(networkId, id),
        onCtrlClick: (id) => toggleSelection([id]),
        onContextMenu: (event) => {
          event?.stopPropagation?.();
          openMenu();
        },
        onTrashBadgeClick: (id) => {
          void openTrashBadgeDialog(networkId, id, fullTitle);
        },
      },
    },
  );
  // Меню чипа: обычное меню облачка + операции над ребром, когда известен
  // ключ внетиповой записи (748b80fd) — им служит display-имя стороны связи.
  const openMenu = (): void => {
    void openReadonlyChipMenu({
      networkId,
      id: edge.target_id,
      fullTitle,
      ref,
      chip,
      ...(removal !== undefined
        ? {
            extraItems: [
              {
                label: 'Удалить связь с мыслью',
                onClick: () => removal.removeTarget(edge.target_id, 'auto'),
              },
              {
                label: 'Поместить связь в корзину',
                onClick: () => removal.removeTarget(edge.target_id, 'trash'),
              },
            ],
          }
        : {}),
    });
  };
  setTooltip(
    chip,
    removal !== undefined
      ? `${fullTitle} — ребро внетиповой связи; удаление связи доступно в контекстном меню.`
      : `${fullTitle} — рёбра этого типа связи не редактируются через свойства (у типа связи нет свойства в реестре).`,
  );
  markThoughtCommentPreview(chip, edge.target_id, fullTitle);
  chip.setAttribute('role', 'button');
  chip.setAttribute('aria-label', fullTitle);
  // Клавиатура — доменная часть чипа (фабрика даёт только мышь): Enter —
  // открыть в редакторе, пробел — в фокус, Shift+F10/ContextMenu — меню.
  chip.addEventListener('keydown', (event) => {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      openMenu();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      openLinkRefInEditor(networkId, edge.target_id);
    } else if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      focusLinkRef(networkId, edge.target_id);
    }
  });
  return chip;
}

/**
 * Допустимые типы значения свойства-связи (0.8.2, ошибка a6513df0). Источник —
 * типы привязок ПРОТИВОПОЛОЖНОЙ стороны этого свойства в реестре
 * `type_properties`: заполняешь прямое имя (мысль — источник) → допустимые цели
 * = типы привязок со стороны назначения; обратное имя → допустимые источники =
 * типы привязок со стороны источника. Сервер уже выбрал нужную сторону и
 * отдал её в `EffectiveTypeProperty.allowed_opposite_type_ids`; здесь только
 * нормализация (пустой список/`''`-id отбрасываются). Пусто — ограничений нет
 * (кандидаты — любые мысли). Иерархию типов раскрывает вызывающий
 * (`expandTypeIdsToSubtree`, L21). Чистая — юнит-тест.
 *
 * ЕДИНСТВЕННОЕ правило отбора для всех пикеров клиента: поле значения в
 * редакторе мысли, диалог «выбрать» и дефолт-пикеры редакторов типа и свойства
 * (`screens/type-manager.ts`, `screens/property-manager.ts`) зовут этот хелпер.
 */
export function linkAllowedTypeIds(
  allowedOppositeTypeIds: readonly string[] | null | undefined,
): string[] {
  return Array.isArray(allowedOppositeTypeIds)
    ? allowedOppositeTypeIds.filter((id) => id !== '')
    : [];
}

/**
 * Чип-поле набора целей свойства-связи (задача 8ab775d9, паттерн a47947c8;
 * правки — инструкция «Использовать унифицированные поля выбора ссылок»).
 *
 * Всегда чип-режим: число целей свойства-связи не ограничено (спека
 * «properties», модель 0.8.1), `config.multiple` для `link` не существует.
 * Чипы — мини-облачка фабрики (профиль `chip`) с «✕»; добавление — поле
 * живого поиска на ОБЩЕЙ выпадашке (история последних целей на пустом поле —
 * ошибка 880c3add, живой поиск при вводе) + кнопка «выбрать»
 * (`pickThoughtsDialog` в режиме «несколько», предзаполнен; можно создавать
 * мысли). Отбор кандидатов по типам противоположной стороны привязки —
 * {@link linkAllowedTypeIds} + поддеревья (L21), применяется и к живому
 * поиску поля, и к диалогу «выбрать» (ошибка cfbf3855).
 *
 * `ownerType`/`ownerId` заданы — чип получает контекстное меню операций над
 * ребром владельца; без владельца (дефолт свойства в редакторе типа/реестре,
 * bb67e546) меню не выводится, набор живёт целиком в `save`.
 */
export function buildLinkValueEditor(opts: {
  networkId: string;
  ownerType?: 'thought' | 'link';
  ownerId?: string;
  definition: Pick<
    EffectiveTypeProperty,
    'config' | 'required' | 'side' | 'allowed_opposite_type_ids'
  > &
    // `key`/`property_id` — для диалога снятия значения связи (96d27fc0).
    Partial<Pick<EffectiveTypeProperty, 'key' | 'property_id'>>;
  values: LinkPropertyValueItem[];
  save: (next: unknown) => Promise<boolean>;
  /** Подключает историю последних целей (требование f6399882). */
  historyPropertyId?: string;
  /** Источники подсказок вызывающего (токены отбора) — см.
   *  {@link ValueEditorOptions.extraSuggest}. */
  extraSuggest?: readonly SuggestSource[];
}): HTMLElement {
  const { networkId, ownerType, ownerId, definition } = opts;
  let current: string[] = opts.values.map((edge) => edge.target_id);

  // Отбор по типам — input aid из реестра привязок свойства-связи:
  // допустимые типы противоположной стороны посчитал сервер
  // (`allowed_opposite_type_ids`), здесь список расширяется до поддеревьев
  // типов (L21); сохранённые значения фильтром не трогаются.
  const filterIds = expandTypeIdsToSubtree(
    store.state.thoughtTypes,
    linkAllowedTypeIds(definition.allowed_opposite_type_ids),
  );

  // Кеш метаданных целей: подписи есть в рёбрах, значок/цвета/флаги —
  // резолвом; чипы перерисовываются по готовности.
  const refs = new Map<string, ThoughtRef>();
  const labels = new Map<string, string>();
  for (const edge of opts.values) {
    if (edge.target_title !== null) labels.set(edge.target_id, edge.target_title);
  }

  const root = div('link-value-editor');

  const persist = async (next: string[]): Promise<boolean> => {
    const ok = await opts.save(next.length > 0 ? next : null);
    if (ok && opts.historyPropertyId !== undefined) {
      recordTextItemsHistory(networkId, opts.historyPropertyId, next);
    }
    // Своя запись ребра не поднимает версию мысли, а собственному клиенту не
    // приходит realtime-эхо (G8) — сверка окрестности на карте закрывает лишь
    // случай, когда новое ребро меняет её подпись. Второе ребро ДРУГОГО типа к
    // уже видимому соседу за границей первой порции сектора подпись не меняет,
    // и таблица значений свойств фокуса осталась бы со старым снимком (ошибка
    // da032ee3, остаточная дыра ec5ba58c). Уведомляем у самой записи —
    // независимо от карты; перечитывание идемпотентно.
    if (ok) notifyPropertyValuesRefreshed(definition.key ?? '');
    return ok;
  };

  const setAndPersist = (next: string[]): void => {
    current = next;
    render();
    // Новая цель пришла из живого поиска/пикера одним id — подписи и стиля
    // облачка в кеше ещё нет, чип рисуется с сырым id. Дозаполняем кеш и
    // перерисовываем по готовности (при неудаче чип остаётся с id).
    void resolveLinkRefs(networkId, current, refs).then(() => {
      if (root.isConnected) render();
    });
    void persist(current);
  };

  /**
   * Снять цели из значения (задача 0d4f793a): без диалога. `auto` — авто-выбор
   * удаление/корзина с проверкой возможности удаления; `trash` — всегда корзина
   * (Shift+крестик, команда меню). Живые рёбра есть только у владельца
   * (`ownerType`/`ownerId`) — без него (дефолт свойства в редакторе типа)
   * набор живёт лишь в `save`, корзины нет: снимаем как раньше.
   */
  const removeEdges = (removedIds: string[], mode: LinkValueRemovalMode): void => {
    const next = current.filter((id) => !removedIds.includes(id));
    if (ownerType === undefined || ownerId === undefined) {
      setAndPersist(next);
      return;
    }
    void (async () => {
      const applied = await removeLinkValueEdges({
        networkId,
        ownerType,
        ownerId,
        propertyKey: definition.key ?? '',
        propertyId: definition.property_id,
        removedTargetIds: removedIds,
        mode,
        commit: () => persist(next),
      });
      if (!applied) return;
      // UI обновляем только после успешной записи: `commit` уже записал
      // значение и записал историю.
      current = next;
      render();
      void resolveLinkRefs(networkId, current, refs).then(() => {
        if (root.isConnected) render();
      });
    })();
  };

  /**
   * Кнопка «выбрать» — диалог поиска/добавления мыслей (приёмка 0.8.1):
   * создание новых разрешено — тип связи и направление известны из
   * определения свойства, а при отборе по типам цели тип новой мысли
   * предустановлен первым типом из списка (в диалоге его можно сменить).
   */
  const openPicker = (): void => {
    void pickThoughtsDialog({
      networkId,
      allowCreate: true,
      allowLinkType: false,
      searchTypeIds: filterIds,
      defaultNewThoughtTypeId: filterIds[0] ?? null,
      selectedIds: current,
      title: 'Выбрать или создать мысли',
      applyLabel: 'Выбрать',
    }).then(async (result) => {
      if (result === null) return;
      const ids: string[] = [];
      for (const item of result.items) {
        if (item.kind === 'existing') {
          ids.push(item.id);
          continue;
        }
        try {
          const created = await etn.thoughts.create(networkId, {
            title: item.title,
            synonyms: item.synonyms,
            type_id: result.thoughtTypeId ?? filterIds[0] ?? null,
          });
          ids.push(created.id);
        } catch (err) {
          notice(`Не удалось создать «${item.title}»: ${errText(err)}`, 'error');
        }
      }
      setAndPersist(ids);
    });
  };

  /** Мини-облачко цели: значок + подпись в цветах/шрифте мысли (§6.3.1).
   *  `onRemove` получает режим снятия: Shift — корзина, иначе авто-выбор. */
  const buildCloud = (id: string, onRemove: (mode: LinkValueRemovalMode) => void): HTMLElement => {
    const ref = refs.get(id);
    // Полное имя цели: заголовок из кеша, иначе подпись ребра, иначе сырой
    // id. Видимую длину ограничивает раскладка чипа; полный текст — в
    // обязательной подсказке чипа.
    const fullTitle = ref?.title ?? labels.get(id) ?? id;
    // Без владельца (дефолт свойства в редакторе типа/реестра) операций над
    // ребром нет — набор живёт только в save (bb67e546).
    const openMenu = (): void => {
      if (ownerType === undefined || ownerId === undefined) return;
      void showLinkChipMenu(
        networkId,
        id,
        fullTitle,
        ref?.marked_for_deletion === true,
        () => onRemove('auto'),
        () => onRemove('trash'),
        cloud,
      );
    };
    // Мини-облачко собирает общая фабрика: разметка, значок, цвета,
    // начертание, бледность неактуальной, метка корзины, кнопка «✕» и единые
    // жесты (одиночный клик отложен, чтобы двойной клик успевал отменить
    // его, Ctrl/Cmd+клик — панель выбранных, контекстное меню — общее).
    const cloud = createThoughtCloud(
      ref ?? { id, title: fullTitle },
      {
        profile: 'chip',
        // Ширина — по полю значения: длинное имя обрезается многоточием по
        // нему, а не раздувает таблицу свойств горизонтальной прокруткой
        // (ошибка 10ad23d1).
        width: 'container',
        actions: {
          onClick: (targetId) => openLinkRefInEditor(networkId, targetId),
          onDoubleClick: (targetId) => focusLinkRef(networkId, targetId),
          onCtrlClick: (targetId) => toggleSelection([targetId]),
          onContextMenu: (event) => {
            event?.stopPropagation?.();
            openMenu();
          },
          onTrashBadgeClick: () => {
            void openTrashBadgeDialog(networkId, id, fullTitle);
          },
          // Shift+крестик — всегда корзина; без Shift — авто-выбор (задача 0d4f793a).
          onRemove: (_targetId, event) => onRemove(removalModeForClick(event?.shiftKey === true)),
        },
      },
    );
    // Стандартное поведение чипов мыслей: Ctrl+hover — предпросмотр
    // постоянного комментария цели, если он есть. Полное имя — подсказкой
    // на всём облачке (S-требование «обрезка по ширине + подсказка»).
    markThoughtCommentPreview(cloud, id, fullTitle);
    setTooltip(cloud, fullTitle);
    cloud.setAttribute('role', 'button');
    cloud.setAttribute('aria-label', fullTitle);
    // Клавиатура — доменная часть чипа: Enter открывает мысль в редакторе,
    // пробел ставит в фокус, Shift+F10/ContextMenu — общее меню мысли.
    cloud.addEventListener('keydown', (event) => {
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault();
        openMenu();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        openLinkRefInEditor(networkId, id);
      } else if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        focusLinkRef(networkId, id);
      }
    });
    return cloud;
  };

  const render = (): void => {
    root.replaceChildren();
    const field = div('st-f-chipfield link-value-field');
    // Чипы всегда в алфавитном порядке подписи (приёмка 0.8.1) — легче
    // искать глазами. Сортируется только ОТОБРАЖЕНИЕ: порядок данных
    // (`current`) не трогаем — он несёт смысл (структурный порядок детей
    // «Потомков» задаёт позиции), persist всегда шлёт исходный порядок.
    const displayTitle = (id: string): string =>
      refs.get(id)?.title ?? labels.get(id) ?? id;
    const ordered = [...current].sort((a, b) =>
      displayTitle(a).localeCompare(displayTitle(b), 'ru'),
    );
    for (const id of ordered) {
      field.append(
        buildCloud(id, (mode) => removeEdges([id], mode)),
      );
    }
    const addInput = fieldInput({
      extraClass: 'value-combo-add link-value-add',
      bare: true,
    }) as HTMLInputElement;
    addInput.type = 'text';
    addInput.autocomplete = 'off';
    addInput.placeholder = current.length === 0
      ? (definition.required === true ? 'Название мысли… (обязательно)' : 'Название мысли…')
      : '+ ещё одну мысль';
    const sources: SuggestSource[] = [];
    if (opts.historyPropertyId !== undefined) {
      sources.push(linkHistorySource(networkId, opts.historyPropertyId));
    }
    // Токены отбора — источник вызывающего: выбор строки кладёт токен в
    // значение как обычную цель строкой (резолвер токенов — на сервере).
    if (opts.extraSuggest !== undefined) sources.push(...opts.extraSuggest);
    sources.push(linkSearchSource(networkId, filterIds));
    wireSuggest(addInput, {
      sources,
      onPick: (entry: { value: string }) => {
        const id = entry.value;
        addInput.value = '';
        if (!current.includes(id)) setAndPersist([...current, id]);
      },
    });
    // Набранный текст сам по себе значение не меняет — только явный выбор
    // из выпадашки (живого поиска/истории); на blur поле очищается.
    addInput.addEventListener('blur', () => {
      addInput.value = '';
    });
    field.append(addInput);
    // Клик по свободному месту поля — фокус в живой поиск.
    field.addEventListener('click', (event) => {
      if (event.target === field) addInput.focus();
    });
    // Обёртка с угловыми кнопками (приёмка 0.8.1): «…» — диалог
    // поиска/добавления (compact, не отъедает ширину поля), «✕» — очистка
    // всего значения. Поле ограничено десятью строками чипов, дальше
    // внутренняя прокрутка (CSS max-height) — таблица свойств больше не
    // растягивается на высоту списка.
    const corner = div('link-value-corner');
    corner.append(
      button('…', openPicker, 'link-value-corner-btn', 'Выбрать или создать мысли'),
      button(
        '✕',
        () => {
          if (current.length > 0) removeEdges([...current], 'auto');
        },
        'link-value-corner-btn',
        'Очистить значение',
      ),
    );
    const wrap = div('link-value-wrap');
    wrap.append(field, corner);
    const row = div('form-row');
    row.style.marginBottom = '0';
    row.append(wrap);
    root.append(row);
  };

  // Метаданные облачков: батч-резолв недостающих, затем перерисовка (при
  // неудаче облачко остаётся с подписью из ребра/сырым id).
  void resolveLinkRefs(networkId, current, refs).then(() => {
    if (root.isConnected) render();
  });

  render();
  return root;
}

// ---------------------------------------------------------------------------
// Множественный текст: чистые хелперы (перенесены из editor/properties.ts)
// ---------------------------------------------------------------------------

/** Splits a stored multi-value string into trimmed non-empty parts. */
export function splitMultiValue(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}
