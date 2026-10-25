/**
 * Живой справочник свойств сети (ошибка 6d25c224, версия 0.14.1).
 *
 * Единственный клиентский кэш реестра свойств (`GET /networks/:id/properties`)
 * для конструктора условий: панель «Структур», «Дневник», диалог отбора типа
 * мысли и рецепт заголовков публикации читают ОДНУ карту, поэтому изменение
 * справочника видно во всех местах сразу.
 *
 * **Почему отдельный модуль.** До ошибки 6d25c224 каждая панель держала свою
 * копию реестра и читала её один раз при монтировании (подпись каталога
 * включала сеть, типы, видимость и rt-статус, но не сами свойства). Создание,
 * удаление и переименование свойства в живом клиенте не меняли ничего: список
 * «Что» открытой панели оставался прежним до перезапуска. Здесь справочник
 * один, а его инвалидация — общая.
 *
 * **Что инвалидирует справочник.**
 *  - собственные realtime-события онтологии `property-registry.*`: роутер слоя
 *    (`lib/live/event-router.ts`) гасит ключ `types-catalog`, а этот модуль по
 *    той же причине перечитывает реестр; событие приходит и автору правки (B1 —
 *    эхо-подавление снято);
 *  - локальная правка реестра из менеджера свойств (`onPropertyRegistryChanged`,
 *    `lib/type-definitions.ts`) — не ждём асинхронного эха;
 *  - смена каталога типов связей: имена обратных сторон свойств-связей берутся
 *    из `link_types` (`withReverseLinkPropertySides`), поэтому карта «с
 *    обратными сторонами» пересобирается на каждый тик store со сменой
 *    `linkTypes`.
 *
 * **Идентичность карт.** Обе карты (`rows` и `withSides`) живут в одном
 * экземпляре на сеть и обновляются НА МЕСТЕ: конструктор условий держит ссылку
 * на карту из `FilterTreeData.registry`, а перерисовка (`refresh`) читает
 * актуальное содержимое. Поэтому местам монтажа не нужно пересобирать редактор
 * на каждое изменение справочника.
 *
 * **Отказ чтения.** `reloadPropertyCatalogue` возвращает `false` — вход НЕ
 * отработан: прежнее содержимое карты сохраняется (пустой реестр выдавал бы
 * построенные условия за «свойства больше нет в сети»), а вызывающий повторяет
 * чтение (механика ошибок 76282fbc/ad063c2f).
 */

import type { LinkType, NetworkProperty } from '@etn/shared';

import { store } from '../state.js';
import { etn } from './etn.js';
import { withReverseLinkPropertySides } from './filter-builder.js';
import { asRealtimeCause, onQueryInvalidated, queryKeys } from './live/index.js';
import { onPropertyRegistryChanged } from './type-definitions.js';
import { reloadTypeCatalogues } from './type-catalogues.js';

/** Состояние справочника одной сети. */
interface CatalogueEntry {
  /** Прямые строки реестра: id → строка (стабильная карта, меняется на месте). */
  readonly rows: Map<string, NetworkProperty>;
  /** Тот же набор плюс обратные стороны свойств-связей (стабильная карта). */
  readonly withSides: Map<string, NetworkProperty>;
  /** Версия содержимого: растёт на каждом успешном обновлении. */
  revision: number;
  /** Реестр хотя бы раз успешно прочитан. */
  loaded: boolean;
  /** Чтение в полёте: параллельные вызовы делят один запрос. */
  loading: Promise<boolean> | null;
  /**
   * Номер последнего ЗАПУЩЕННОГО чтения: ответ устаревшего запроса не затирает
   * более свежие данные (например, зависшее чтение разрешилось после повтора).
   */
  token: number;
}

/** Справочники по сетям. */
const entries = new Map<string, CatalogueEntry>();

/** Живые карты (обе формы) — для проверки «место передало живой справочник». */
const liveMaps = new WeakSet<ReadonlyMap<string, NetworkProperty>>();

/** Подписчики изменений по сети. */
const listeners = new Map<string, Set<(revision: number) => void>>();

/** Однократная проводка: realtime-события реестра и тики store о типах связей. */
let wired = false;

/** Отписки проводки — снимаются при сбросе модуля (тесты, переинициализация). */
const wiringCleanup: Array<() => void> = [];

/** Последний увиденный каталог типов связей (вход обратных сторон). */
let linkTypesSeen: readonly LinkType[] | null = null;

/** События онтологии, меняющие реестр свойств. */
function isRegistryEvent(type: string): boolean {
  return (
    type === 'property-registry.created' ||
    type === 'property-registry.updated' ||
    type === 'property-registry.deleted'
  );
}

/**
 * Нужно ли перечитывать каталог типов связей после события реестра.
 *
 * Пара имён обратной стороны живёт в типе связи, поэтому ЛЮБОЕ событие
 * свойства-СВЯЗИ требует свежего каталога: создание (появился тип связи),
 * правка (могла смениться пара имён стороны или допустимые типы), удаление
 * (удаление свойства-связи уносит связанный тип). Скалярное свойство тип связи
 * не трогает — лишний перезапрос `thought-types`/`link-types` и пересборку
 * открытых панелей не делаем.
 *
 * Вид значения берём из тела события (создание несёт `property`), из правки
 * (`changes.value_type`), иначе — из уже прочитанной строки справочника: на
 * момент события она ещё прежняя, а `value_type` свойства неизменяем. Строки
 * нет (справочник не читали) — вид неизвестен, перечитываем каталог.
 */
function registryEventNeedsTypes(
  networkId: string,
  type: string,
  data: Record<string, unknown>,
): boolean {
  if (type === 'property-registry.created') {
    const property = data['property'] as { value_type?: unknown } | undefined;
    return property?.value_type === 'link';
  }
  const changes = data['changes'] as { value_type?: unknown } | undefined;
  if (typeof changes?.value_type === 'string') return changes.value_type === 'link';
  const id = data['id'];
  if (typeof id !== 'string') return true;
  const row = entries.get(networkId)?.rows.get(id);
  return row === undefined ? true : row.value_type === 'link';
}

/** Создать/получить состояние справочника сети (пустое, пока не прочитано). */
function ensureEntry(networkId: string): CatalogueEntry {
  let entry = entries.get(networkId);
  if (entry === undefined) {
    const rows = new Map<string, NetworkProperty>();
    const withSides = new Map<string, NetworkProperty>();
    liveMaps.add(rows);
    liveMaps.add(withSides);
    entry = { rows, withSides, revision: 0, loaded: false, loading: null, token: 0 };
    entries.set(networkId, entry);
  }
  return entry;
}

/** Оповестить подписчиков сети о новой версии справочника. */
function notify(networkId: string, revision: number): void {
  const set = listeners.get(networkId);
  if (set === undefined) return;
  for (const listener of [...set]) listener(revision);
}

/**
 * Пересобрать карту «с обратными сторонами» из прямых строк и текущего каталога
 * типов связей. Обе карты живут в одном экземпляре — обновление на месте.
 */
function rebuildSides(networkId: string, entry: CatalogueEntry): void {
  entry.withSides.clear();
  for (const [key, value] of withReverseLinkPropertySides(entry.rows, store.state.linkTypes)) {
    entry.withSides.set(key, value);
  }
  entry.revision += 1;
  notify(networkId, entry.revision);
}

/** Проводка источников инвалидации (один раз на процесс рендерера). */
function ensureWired(): void {
  if (wired) return;
  wired = true;
  linkTypesSeen = store.state.linkTypes;
  // Смена каталога типов связей меняет имена обратных сторон свойств-связей:
  // карта справочника пересобирается без сетевого запроса.
  wiringCleanup.push(
    store.subscribe(() => {
      if (store.state.linkTypes === linkTypesSeen) return;
      linkTypesSeen = store.state.linkTypes;
      for (const [networkId, entry] of entries) rebuildSides(networkId, entry);
    }),
  );
  // Чужие правки реестра: роутер гасит `types-catalog` причиной-событием —
  // этого же сигнала достаточно, чтобы перечитать справочник свойств.
  wiringCleanup.push(
    onQueryInvalidated((prefix, _keys, cause) => {
      if (prefix !== queryKeys.typesCatalog()) return;
      const evt = asRealtimeCause(cause);
      if (evt === null || !isRegistryEvent(evt.type)) return;
      const networkId = evt.network_id;
      // Справочник этой сети никто не читал — читать незачем (граница сети).
      if (!entries.has(networkId)) return;
      void reloadPropertyCatalogue(networkId);
      // Свойство-связь живёт парой с типом связи: правка реестра могла сменить
      // пару имён стороны. Каталог типов перечитывается дедуплицированно
      // (`lib/type-catalogues.ts`), затем тик store пересоберёт обратные стороны.
      // Скалярное создание тип связи не трогает, а чужая вкладка — не наш каталог.
      if (networkId === store.state.networkId && registryEventNeedsTypes(networkId, evt.type, evt.data)) {
        void reloadTypeCatalogues();
      }
    }),
  );
  // Своя правка реестра (менеджер свойств): не ждём асинхронного эха.
  wiringCleanup.push(
    onPropertyRegistryChanged(() => {
      const networkId = store.state.networkId;
      if (networkId === null || !entries.has(networkId)) return;
      void reloadPropertyCatalogue(networkId);
    }),
  );
}

/** Прямые строки реестра сети (живая карта id → строка). */
export function propertyCatalogueRows(networkId: string): Map<string, NetworkProperty> {
  ensureWired();
  return ensureEntry(networkId).rows;
}

/**
 * Реестр сети с обратными сторонами свойств-связей (живая карта) — форма,
 * которую ждут конвертеры определений и конструктор условий.
 */
export function propertyCatalogueWithSides(networkId: string): Map<string, NetworkProperty> {
  ensureWired();
  return ensureEntry(networkId).withSides;
}

/** Переданная карта — живой справочник (место монтажа подключилось к нему). */
export function isLivePropertyCatalogue(map: ReadonlyMap<string, NetworkProperty>): boolean {
  return liveMaps.has(map);
}

/** Текущая версия содержимого справочника сети (0 — ещё не прочитан). */
export function propertyCatalogueRevision(networkId: string): number {
  return entries.get(networkId)?.revision ?? 0;
}

/**
 * Перечитать реестр сети.
 *
 * `fresh: true` — НАЧАТЬ новое чтение, не присоединяясь к висящему в полёте
 * (путь «отказ не отработан → следующий тик store повторяет чтение»: зависший
 * запрос не должен блокировать повтор). Ответ устаревшего запроса не затирает
 * более свежие данные — его отбрасывает номер запроса.
 *
 * Возвращает `false`, если чтение не удалось (или ответ устарел и свежих данных
 * нет): прежнее содержимое карты сохраняется, вызывающий обязан повторить
 * чтение, а не выдавать его за пустой реестр. Параллельные вызовы без `fresh`
 * делят один запрос.
 */
export function reloadPropertyCatalogue(
  networkId: string,
  options: { fresh?: boolean } = {},
): Promise<boolean> {
  ensureWired();
  const entry = ensureEntry(networkId);
  if (entry.loading !== null && options.fresh !== true) return entry.loading;
  entry.token += 1;
  const token = entry.token;
  // Чтение СТАРТУЕТ синхронно (место монтажа видит запрос сразу, как и до
  // общего справочника): тело `async`-функции выполняется до первого `await`,
  // поэтому `list` вызывается в этом же тике.
  const pending = (async (): Promise<boolean> => {
    try {
      const list = await etn.propertyRegistry.list(networkId);
      // Пока чтение летело, запустили более свежее (или приняли готовые строки) —
      // устаревший ответ не затирает актуальные данные.
      if (token !== entry.token) return entry.loaded;
      entry.rows.clear();
      for (const row of list) entry.rows.set(row.id, row);
      entry.loaded = true;
      rebuildSides(networkId, entry);
      return true;
    } catch {
      return token === entry.token ? false : entry.loaded;
    }
  })();
  entry.loading = pending;
  // Признак «в полёте» снимается ПОСЛЕ присвоения: синхронный бросок `list`
  // (шов без транспорта) завершает чтение раньше, чем `pending` попадёт в
  // `entry.loading`, — очистка в `finally` внутри тела оставила бы признак
  // занятым навсегда. Очистка только для последнего чтения: у более нового
  // запроса свой признак, и он снимется сам.
  void pending.then(() => {
    if (token === entry.token) entry.loading = null;
  });
  return pending;
}

/**
 * Принять уже прочитанные строки реестра (место читало их своим запросом, как
 * карточка публикации): справочник обновляется без второго сетевого вызова.
 *
 * `sinceRevision` — {@link propertyCatalogueRevision} на момент СТАРТА чтения
 * места. Если справочник с тех пор обновился (realtime-событие, повтор), строки
 * устарели и ОТБРАСЫВАЮТСЯ: поздний ответ карточки не затирает более свежие
 * данные. Без ревизии возраст строк неизвестен — принимаем их только в ещё ни
 * разу не обновлявшийся справочник (терять нечего), иначе отказ.
 *
 * Принятие подменяет токен: ответ чтения, летевшего в полёте, устарел и будет
 * отброшен. Признак «в полёте» снимается сразу — иначе последующие вызовы без
 * `fresh` присоединялись бы к отброшенному промису и в сеть не ходили: открытая
 * панель перестала бы реагировать на события реестра (блокер верификатора).
 *
 * Возвращает `true`, если строки приняты.
 */
export function putPropertyCatalogueRows(
  networkId: string,
  rows: readonly NetworkProperty[],
  sinceRevision?: number,
): boolean {
  ensureWired();
  const entry = ensureEntry(networkId);
  const accepted =
    sinceRevision === undefined ? entry.revision === 0 : sinceRevision === entry.revision;
  if (!accepted) return false;
  entry.token += 1;
  entry.loading = null;
  entry.rows.clear();
  for (const row of rows) entry.rows.set(row.id, row);
  entry.loaded = true;
  rebuildSides(networkId, entry);
  return true;
}

/**
 * Подписка на изменения справочника сети; возвращает отписку. Начального вызова
 * нет: подписчик уже держит живую карту и строит по ней текущий вид.
 */
export function subscribePropertyCatalogue(
  networkId: string,
  listener: (revision: number) => void,
): () => void {
  ensureWired();
  ensureEntry(networkId);
  let set = listeners.get(networkId);
  if (set === undefined) {
    set = new Set();
    listeners.set(networkId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Сброс модуля (тесты и полная переинициализация клиента). */
export function resetPropertyCatalogue(): void {
  for (const off of wiringCleanup.splice(0)) off();
  entries.clear();
  listeners.clear();
  wired = false;
  linkTypesSeen = null;
}
