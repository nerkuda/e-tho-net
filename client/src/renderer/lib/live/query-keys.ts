/**
 * Фабрики ключей запросов слоя данных (этап G1 тех.проекта `269016e2`).
 *
 * Ключ — строка из сегментов через `:`. Первый сегмент — «префикс запроса»
 * (`focus`, `structures-page`, `chronicle-feed`, `pub-card`, `attachments`, …),
 * дальше параметры: id сущности (`@<id>`), ключ фильтра/владельца.
 *
 * Инвалидация — по префиксу: `invalidateQuery('focus')` гасит все ключи
 * `focus:@…`, `invalidateQuery('focus:@abc')` — ровно один
 * (`query-registry.ts`, `matchesKeyPrefix`).
 *
 * Именование повторяет техпроект: `focus:@id`, `pub-card:@id`,
 * `attachments:@ownerType:@id` и т.д.
 */

/** Склеить сегменты ключа, отбросив пустые. */
export function keyOf(...parts: Array<string | number | null | undefined>): string {
  return parts
    .filter((p): p is string | number => p !== null && p !== undefined && p !== '')
    .join(':');
}

/** Сегмент-идентификатор сущности: `@<id>`. */
export function ref(id: string): string {
  return `@${id}`;
}

/** Фабрики ключей запросов экранов и срезов кэша. */
export const queryKeys = {
  /** Окрестность фокуса (холст/редактор): `focus:@id`. */
  focus: (thoughtId: string) => keyOf('focus', ref(thoughtId)),
  /** Все окрестности — для инвалидации по префиксу. */
  focusAll: () => 'focus',

  /** Страница/дерево «Структур» под отбор: `structures-page:@<filterKey>`. */
  structuresPage: (filterKey = 'all') => keyOf('structures-page', ref(filterKey)),
  structuresPageAll: () => 'structures-page',

  /** Лента «Хроники» под отбор: `chronicle-feed:@<filterKey>`. */
  chronicleFeed: (filterKey = 'all') => keyOf('chronicle-feed', ref(filterKey)),
  chronicleFeedAll: () => 'chronicle-feed',

  /** Список библиотеки публикаций: `publications-list:@<filterKey>`. */
  publicationsList: (filterKey = 'all') => keyOf('publications-list', ref(filterKey)),
  publicationsListAll: () => 'publications-list',

  /**
   * Инвалидация ленты «Дневника» по КОНКРЕТНОЙ мысли-чипсу
   * (`chronicle-thought:@<id>`). Роутер гасит её на правку/удаление мысли, а
   * экран ленты перечитывает её, только если эта мысль видна чипсом загруженной
   * записи (замечание G3: правка невидимой мысли ленту не трогает).
   */
  chronicleThought: (id: string) => keyOf('chronicle-thought', ref(id)),
  chronicleThoughtAll: () => 'chronicle-thought',

  /** Инвалидация ленты по конкретной связи-чипсу (`chronicle-link:@<id>`). */
  chronicleLink: (id: string) => keyOf('chronicle-link', ref(id)),
  chronicleLinkAll: () => 'chronicle-link',

  /**
   * Сигнал «состав активного отбора холста мог измениться» — правка мысли,
   * меняющая её соответствие отбору (тип/актуальность/корзина). Отдельный ключ
   * без зарегистрированных записей: роутер только уведомляет подписчиков
   * (`onQueryInvalidated`), а холст в режиме отбора переисполняет `views.run`
   * НЕЗАВИСИМО от того, видна ли мысль в старом результате (направление
   * «вход» в отбор; блокер G3).
   */
  viewComposition: () => 'view-composition',

  /**
   * Сигнал «изменены поля, по которым отбор может искать ключевыми словами»
   * (заголовок/синонимы). Холст реагирует только если определение активного
   * отбора реально использует `keywords` — иначе лишний `views.run`.
   */
  viewCompositionKeywords: () => 'view-composition-keywords',

  /** Полки библиотеки. */
  shelves: () => 'shelves',

  /** Карточка публикации: `pub-card:@id`. */
  publicationCard: (id: string) => keyOf('pub-card', ref(id)),
  publicationCardAll: () => 'pub-card',

  /** Собранный документ публикации: `pub-assembly:@id`. */
  publicationAssembly: (id: string) => keyOf('pub-assembly', ref(id)),
  publicationAssemblyAll: () => 'pub-assembly',

  /** Вложения владельца: `attachments:@<ownerType>:@<ownerId>`. */
  attachments: (ownerType: string, ownerId: string) =>
    keyOf('attachments', ref(ownerType), ref(ownerId)),
  attachmentsAll: () => 'attachments',

  /** Каталоги типов мыслей/связей и определений свойств. */
  typesCatalog: () => 'types-catalog',

  /** Счётчики-индикаторы сущности (комментарии/вложения/связи): `indicators:@id`. */
  indicators: (id: string) => keyOf('indicators', ref(id)),
  indicatorsAll: () => 'indicators',

  /** Закреплённые мысли сети. */
  pins: () => 'pins',

  /** История переходов (history bar). */
  history: () => 'history',

  /** Отборы типа мысли: `views:@<typeId>`. */
  views: (typeId: string) => keyOf('views', ref(typeId)),
  viewsAll: () => 'views',

  /** Сохранённые фильтры пользователя: `saved-filters:@<scope>`. */
  savedFilters: (scope = 'user') => keyOf('saved-filters', ref(scope)),
  savedFiltersAll: () => 'saved-filters',

  /** Переопределения объектов текущим слоем. */
  layerOverrides: () => 'layer-overrides',

  /** Значение одной сущности в нормализованном кэше. */
  entity: (kind: string, id: string) => keyOf('entity', ref(kind), ref(id)),
} as const;

/**
 * Подходит ли ключ под префикс: точное совпадение или продолжение сегмента.
 * `matchesKeyPrefix('focus:@a', 'focus')` → true,
 * `matchesKeyPrefix('focus:@a', 'focus:@a')` → true,
 * `matchesKeyPrefix('structuresso:x', 'structures')` → false.
 */
export function matchesKeyPrefix(candidate: string, prefix: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}:`);
}
