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
 * text/url/link, включая множественные значения и свойства-связи (ошибка
 * 880c3add — история пропала из полей свойств-связей). Пишется при успешном
 * сохранении в `blur`-режиме.
 */

import type {
  CrossNetworkRefValue,
  EffectiveTypeProperty,
  LinkPropertyValueItem,
  SearchNameHit,
  ThoughtRef,
} from '@etn/shared';

import { store } from '../state.js';
import { button, div, el, errText, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { markThoughtCommentPreview } from '../lib/hover-preview.js';
import { createThoughtCloud } from '../lib/thought-cloud.js';
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
import { removeLinkValueEdges } from './link-value-removal.js';
import { pickThoughtsDialog } from '../canvas/add-dialog.js';
import { toggleSelection } from '../selection/selection.js';
import { openWikiIdTarget } from './wiki-link.js';
import { showMenuAt, type MenuItem } from '../lib/menu.js';

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
  }
}

/**
 * Редактор кросс-сетевой ссылки (задача 7849008a, требования 6d4ad9ac и
 * 95511443). Сервер при чтении обогащает значение снапшотом
 * (`CrossNetworkRefValue[]`); редактор показывает имя цели и сеть рядом с
 * полем адреса. Сохранение идёт по адресу (`n:<network>#<thought>`) — поле
 * ввода остаётся адресным. Кнопка «обновить» дёргает IPC
 * `properties.crossResolve` и обновляет снапшот имени (служебная запись, без
 * write-бюджета и audit-строки — требование c104a0fc).
 *
 * Резолв по действию:
 *   * клик по чипу снапшота → переход в целевую сеть (`openWikiIdTarget`)
 *     + отдельный `crossResolve` в сеть-источник (требование 95511443).
 *   * контекстное меню чипа «Обновить имя» → `crossResolve` без перехода.
 */
function buildCrossNetworkRefEditor(opts: ValueEditorOptions): HTMLElement {
  const isMultiple = opts.definition.config?.multiple === true;
  // Сервер при чтении обогащает значение снапшотом (CrossNetworkRefValue[]);
  // редактор поля значения (конструктор условий, change-режим) может
  // передать сырую строку или массив строк. Нормализуем обе формы.
  const snapshots = readSnapshotFromValue(opts.value);
  const addresses = readAddressesFromValue(opts.value);
  const stored = addresses.join(', ');
  const wrapper = div('value-editor value-editor--cross-network-ref');
  const input = el('input') as HTMLInputElement;
  input.type = 'text';
  input.className = 'cross-network-ref-input';
  input.placeholder = 'n:<network_uuid>#<thought_uuid>';
  input.value = stored;
  input.spellcheck = false;
  const hint = div('cross-network-ref-hint muted');
  hint.textContent = isMultiple
    ? 'Несколько адресов — через запятую. Снапшот имени обновляется кнопкой «Обновить».'
    : 'Снапшот имени обновляется кнопкой «Обновить».';
  const refreshBtn = el('button', 'Обновить') as HTMLButtonElement;
  refreshBtn.type = 'button';
  refreshBtn.className = 'cross-network-ref-resolve';
  refreshBtn.addEventListener('click', () => {
    void refreshSnapshot(opts, refreshBtn, hint);
  });
  input.addEventListener('blur', () => {
    const next = input.value.trim();
    void opts.save(
      isMultiple
        ? next
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== '')
        : next === ''
          ? null
          : next,
    );
  });
  wrapper.append(input, refreshBtn, hint);
  // Чипы снапшота (требование 6d4ad9ac): показываем имя цели и сеть; клик
  // переходит в цель и обновляет снапшот в сети-источнике; контекстное
  // меню «Обновить имя» — точечный crossResolve.
  if (snapshots.length > 0) {
    const chips = div('cross-network-ref-chips');
    for (const snap of snapshots) {
      chips.append(buildCrossNetworkRefChip(opts, snap));
    }
    wrapper.append(chips);
  }
  return wrapper;
}

/** Достать массив снапшотов из `value` (CrossNetworkRefValue[]); пусто — нет. */
function readSnapshotFromValue(value: unknown): CrossNetworkRefValue[] {
  if (!Array.isArray(value)) return [];
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
 * Чип снапшота кросс-сетевой ссылки: имя цели + короткое имя сети; клик
 * открывает цель, контекстное меню даёт «Обновить имя» без перехода. Клик
 * по нерезолвленному — переход всё равно работает (цель могла быть
 * восстановлена).
 */
function buildCrossNetworkRefChip(
  opts: ValueEditorOptions,
  snap: CrossNetworkRefValue,
): HTMLElement {
  const chip = el(
    'button',
    `cross-network-ref-chip${snap.unresolved ? ' cross-network-ref-chip--unresolved' : ''}`,
    '🔗',
  ) as HTMLButtonElement;
  chip.type = 'button';
  const net = snap.network_id === '' ? '—' : shortCrossNetworkLabel(snap.network_id);
  chip.append(
    span(snap.title_snapshot, 'cross-network-ref-chip-title'),
    span(` · ${net}`, 'muted cross-network-ref-chip-net'),
  );
  if (snap.unresolved) {
    chip.append(span(' (нерезолвлено)', 'muted cross-network-ref-chip-flag'));
    setTooltip(
      chip,
      'Последний живой резолв отказал — сеть или цель удалены. Кликните «Обновить имя» в контекстном меню.',
    );
  } else {
    setTooltip(chip, `${snap.title_snapshot} — ${snap.network_id}#${snap.thought_id}`);
  }
  chip.addEventListener('click', () => {
    if (snap.network_id === '' || snap.thought_id === '') return;
    void navigateCrossNetworkRef(opts, snap);
  });
  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    void openCrossNetworkRefChipMenu(chip, opts, snap);
  });
  return chip;
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

/**
 * Переход по чипу: открыть цель через {@link openWikiIdTarget}, после
 * успешного открытия — отдельный `crossResolve` в сеть-источник
 * (требование 95511443).
 */
async function navigateCrossNetworkRef(
  opts: ValueEditorOptions,
  snap: CrossNetworkRefValue,
): Promise<void> {
  try {
    await openWikiIdTarget(snap.network_id, snap.thought_id);
  } catch {
    // openWikiIdTarget сам показывает тост при ошибке сети/мысли.
    return;
  }
  // После успешного открытия — снапшот в сети-источнике мог протухнуть
  // (цель переименовали). Точечный crossResolve обновит запись; ошибка не
  // критична — откроется окно с устаревшим именем, пользователь увидит
  // реальное.
  if (opts.ownerType !== 'thought' || opts.ownerId === undefined) return;
  const key = opts.definition.key ?? '';
  if (key === '') return;
  try {
    await etn.properties.crossResolve(opts.networkId, opts.ownerId, key);
  } catch {
    // Тихо: пользователь всё равно попадёт в цель, обновление снапшота —
    // дополнительное удобство.
  }
}

/**
 * Контекстное меню чипа снапшота (требование 95511443): «Обновить имя» —
 * точечный `crossResolve` без перехода. Ошибка уходит в общий тост.
 */
async function openCrossNetworkRefChipMenu(
  anchor: HTMLElement,
  opts: ValueEditorOptions,
  snap: CrossNetworkRefValue,
): Promise<void> {
  if (opts.ownerType !== 'thought' || opts.ownerId === undefined) {
    notice('Обновление имени доступно только для свойств мыслей.', 'error');
    return;
  }
  const key = opts.definition.key ?? '';
  if (key === '') return;
  const items: MenuItem[] = [
    {
      label: 'Обновить имя',
      onClick: () => {
        void (async () => {
          try {
            const result = await etn.properties.crossResolve(
              opts.networkId,
              opts.ownerId!,
              key,
            );
            const unresolved = result.values.filter((v) => v.unresolved).length;
            notice(
              unresolved === 0
                ? 'Снапшоты обновлены.'
                : `Обновлено ${result.values.length - unresolved} из ${result.values.length}; ${unresolved} нерезолвлено.`,
              'info',
            );
            document.dispatchEvent(
              new CustomEvent('etn:property-values-refreshed', { detail: { key } }),
            );
          } catch (err) {
            notice(`Не удалось обновить имя: ${errText(err)}`, 'error');
          }
        })();
      },
    },
    ...(snap.network_id !== '' && snap.thought_id !== ''
      ? [
          {
            label: 'Открыть цель',
            onClick: () => {
              void navigateCrossNetworkRef(opts, snap);
            },
          },
        ]
      : []),
  ];
  const rect = anchor.getBoundingClientRect();
  showMenuAt(rect.left, rect.bottom, items);
}

async function refreshSnapshot(
  opts: ValueEditorOptions,
  btn: HTMLButtonElement,
  hint: HTMLElement,
): Promise<void> {
  if (opts.ownerType !== 'thought' || opts.ownerId === undefined) {
    hint.textContent = 'Обновление снапшота поддерживается только для мыслей.';
    return;
  }
  const key = opts.definition.key ?? '';
  if (key === '') return;
  btn.disabled = true;
  hint.textContent = 'Обновление…';
  try {
    const result = await etn.properties.crossResolve(
      opts.networkId,
      opts.ownerId,
      key,
    );
    const unresolved = result.values.filter((v) => v.unresolved).length;
    hint.textContent =
      unresolved === 0
        ? `Снапшоты обновлены (${result.values.length} шт.).`
        : `Обновлено ${result.values.length - unresolved} из ${result.values.length}; ${unresolved} нерезолвлено.`;
    // Уведомляем вызывающий код через custom-event, чтобы таблица свойств
    // обновила отображение значений без полного рефреша карточки.
    opts.ownerId;
    document.dispatchEvent(
      new CustomEvent('etn:property-values-refreshed', { detail: { key } }),
    );
  } catch (err) {
    hint.textContent = `Ошибка обновления: ${String(err)}`;
  } finally {
    btn.disabled = false;
  }
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

/**
 * Оборачивает поле ввода с кнопкой «✕» очистки значения в правом верхнем
 * углу (приёмка пользователя 0.8.1): у любого поля ввода должен быть
 * однозначный способ убрать значение целиком. У пустого поля кнопка скрыта —
 * очищать нечего (ошибка a8e9eef1); видимость следит за событиями
 * `input`/`change` и за самой очисткой.
 *
 * Экспортирована: поля дат «Создано/Изменено» панели фильтра «Структур»
 * (`datetime-local`, не значение свойства) используют тот же крестик.
 */
export function wrapClearable(input: HTMLElement, onClear: () => void): HTMLElement {
  const wrap = div('clearable-field');
  wrap.append(input);
  const btn = el('button', 'clearable-clear', '✕');
  btn.type = 'button';
  btn.title = 'Очистить';
  const sync = (): void => {
    const node = input as HTMLInputElement;
    btn.hidden = typeof node.value === 'string' && node.value === '';
  };
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    onClear();
    sync();
  });
  input.addEventListener('input', sync);
  input.addEventListener('change', sync);
  sync();
  wrap.append(btn);
  return wrap;
}

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
 * выпадашкой (история + закрытый список `config.options` для text);
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

  const commit = (next: string[]): void => {
    items = next;
    render();
    const payload = kind === 'text' ? next.join(', ') : next;
    void Promise.resolve()
      .then(() => opts.save(next.length > 0 ? payload : null))
      .then((ok) => {
        if (ok === true && opts.historyPropertyId !== undefined) {
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
    const input = el('input', 'text-input prop-editor value-chips-input') as HTMLInputElement;
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = kind === 'url' ? 'https://… или путь к файлу' : '+ ещё одно значение';
    if (kind === 'url') input.title = 'URL или путь к файлу';

    const sources: SuggestSource[] = [];
    if (opts.historyPropertyId !== undefined) {
      sources.push(textHistorySource(opts.networkId, opts.historyPropertyId));
    }
    if (kind === 'text') {
      const options = (definition.config?.options ?? []).filter((o) => o !== '');
      if (options.length > 0) {
        sources.push(optionsSuggestSource(options, { header: 'Варианты' }));
      }
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
        const caret = button('▾', () => handle?.open(), 'btn small', 'Выбрать значение из списка');
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
 * открывает полный список вариантов).
 */
function buildScalarTextEditor(opts: ValueEditorOptions, kind: 'text' | 'url'): HTMLElement {
  const { definition } = opts;
  const stored = asSingleString(opts.value as StoredTextValue);
  const input = el('input', 'text-input prop-editor') as HTMLInputElement;
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
          if (opts.historyPropertyId !== undefined && typeof next === 'string') {
            recordTextHistory(opts.networkId, opts.historyPropertyId, next);
          }
        });
    };
    input.addEventListener('blur', () => commitValue(input.value));
  }

  const sources: SuggestSource[] = [];
  if (opts.historyPropertyId !== undefined) {
    sources.push(textHistorySource(opts.networkId, opts.historyPropertyId));
  }
  let options: string[] = [];
  if (kind === 'text') {
    options = (definition.config?.options ?? []).filter((o) => o !== '');
    if (options.length > 0) {
      sources.push(optionsSuggestSource(options, { header: 'Варианты' }));
    }
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
      button('▾', () => handle?.open(), 'btn small', 'Выбрать значение из списка'),
    );
    return row;
  }
  if (kind === 'url') {
    const openBtn = button('Открыть', () => void openUrlExternally(input.value), 'btn small');
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
  const input = el('input', 'text-input prop-editor') as HTMLInputElement;
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
  const input = el('input', 'text-input prop-editor') as HTMLInputElement;
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
  const input = el('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = stored;
  input.addEventListener('change', () => {
    const next = input.checked;
    void Promise.resolve()
      .then(() => opts.save(next))
      .then((ok) => {
        if (ok !== true && commitOn === 'blur') input.checked = !next;
      });
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
  /** Команды контекста редактора (748b80fd) — например «Убрать из значения». */
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
 * с холстом; отличие значения — «Убрать из значения».
 */
async function showLinkChipMenu(
  networkId: string,
  id: string,
  title: string,
  trashed: boolean,
  onRemove: () => void,
  anchor: Element,
): Promise<void> {
  await openThoughtCloudMenu({
    networkId,
    id,
    title,
    trashed,
    anchor,
    extraItems: [
      {
        label: 'Убрать из значения',
        onClick: onRemove,
      },
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
 * команду «Убрать из значения» — как у чипов основной таблицы
 * (`showLinkChipMenu`). Крестик «×» очистки набора целиком рисует вызывающий
 * (ячейка «Свойства вне типа»).
 */
export function buildOutsideReadonlyEdgeChip(
  networkId: string,
  edge: LinkPropertyValueItem,
  refs: Map<string, ThoughtRef>,
  removal?: {
    /** Снять это ребро из набора («Убрать из значения»). */
    removeTarget: (targetId: string) => void;
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
  // Меню чипа: обычное меню облачка + «Убрать из значения», когда известен
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
                label: 'Убрать из значения',
                onClick: () => removal.removeTarget(edge.target_id),
              },
            ],
          }
        : {}),
    });
  };
  setTooltip(
    chip,
    removal !== undefined
      ? `${fullTitle} — ребро внетиповой связи; свойство «убрать из значения» доступно в контекстном меню.`
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
   * Снять цели из значения с выбором способа (задача 96d27fc0): диалог
   * «В корзину» / «Удалить совсем». Живые рёбра есть только у владельца
   * (`ownerType`/`ownerId`) — без него (дефолт свойства в редакторе типа)
   * набор живёт лишь в `save`, корзины нет: снимаем как раньше, без диалога.
   */
  const removeEdges = (removedIds: string[]): void => {
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
        commit: () => persist(next),
      });
      if (!applied) return;
      // UI обновляем только после решения (отмена диалога ничего не меняет):
      // `commit` уже записал значение и записал историю.
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

  /** Мини-облачко цели: значок + подпись в цветах/шрифте мысли (§6.3.1). */
  const buildCloud = (id: string, onRemove: () => void): HTMLElement => {
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
        () => removeEdges([id]),
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
          onRemove,
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
        buildCloud(id, () => removeEdges([id])),
      );
    }
    const addInput = el('input', 'value-combo-add link-value-add') as HTMLInputElement;
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
    const handle = wireSuggest(addInput, {
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
          if (current.length > 0) removeEdges([...current]);
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
