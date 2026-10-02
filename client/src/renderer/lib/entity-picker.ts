/**
 * Общий пикер сущностей — единственная точка выбора типа мысли, типа связи
 * и мысли (ADR «выбор сущности — один пикер на типы мыслей, типы связей и
 * мысли», стандарт S3, задача a1f5141b, веха 3 версии 0.8.2; элемент
 * интерфейса «Пикер сущностей: типы мыслей, типы связей, мысли»).
 *
 * Источники — параметр пикера, а не повод писать несколько компонентов:
 *
 * | Источник          | Данные                                            |
 * |-------------------|---------------------------------------------------|
 * | `thought-types`   | каталог типов мыслей (иерархия через type-tree)   |
 * | `link-types`      | каталог типов связей (иерархия, свотч линии)      |
 * | `thoughts`        | мысли — живой поиск по серверу (`findDuplicates`) |
 * | `link-properties` | свойства-связи сети — по строке на имя стороны    |
 * | `publications`    | публикации слоя — живой поиск (`GET /publications`)|
 *
 * Пятый источник — «публикации» (0.11.1, задача 3275fd8d, элемент интерфейса
 * 9626efb6): поиск по названию/подзаголовку/автору, вариант — название с
 * мини-обложкой, значение свойства вида `publication`.
 *
 * Четвёртый источник — «свойство связи» (требование cdb6b52f): строки общего
 * списка свойств (`lib/property-list.ts`) дают по варианту на КАЖДОЕ имя
 * стороны свойства-связи (прямое/обратное), с парной подписью
 * «(прямое -> обратное)», значком конца связи и живым поиском по имени,
 * обратному имени и описанию. Им поглощено прежнее отдельное поле
 * `lib/link-property-field.ts` (ошибка a7abe50e) — второго поля рядом с полем
 * «Тип мысли» нет.
 *
 * Варианты рисуются облачками общей фабрики (`lib/thought-cloud.ts`): тип
 * мысли передаётся облачку как `type_id` — фабрика сама резолвит значок,
 * цвета и начертание по цепочке типов (L21); тип связи — облачко с глифом
 * ссылки и свотчем линии; мысль — её собственный визуал. Живой поиск —
 * общей выпадашкой `wireSuggest` (источник кандидатов — её параметр, ADR
 * «одна выпадашка-подсказчик»). Иерархия типов строится функциями
 * `lib/type-tree.ts` (`orderedTypeRows`), а не в экране; строки модального
 * чек-листа типов рисует единое дерево `lib/ui/tree.ts` (требование 0086037c).
 *
 * Два режима показа одного пикера:
 *   - {@link pickEntitiesModal} — модальный чек-лист: одиночный или
 *     множественный выбор, раскрытие иерархии типов, поиск и команды-иконки
 *     («Очистить» + команды вызывающего) в ОДНОЙ строке с поиском;
 *   - {@link buildEntityCombo} — встроенное поле ОДИНОЧНОГО выбора: пусто —
 *     строка живого поиска с кареткой; заполнено — облачко значения прямо в
 *     поле, ввод недоступен, крестик очищает, кнопка «…» открывает диалог
 *     выбора единственного значения (ошибка ba2f57d3). Дерево типов с
 *     отступами и раскрытием (`expandAll`), свотч линии, быстрое создание
 *     типа (`onCreateNew`) — всё, ради чего существовал прежний
 *     `lib/type-combobox.ts` (поглощён и удалён, веха 3 версии 0.8.2).
 *
 * Зависимости — только `lib/*`, `state.ts` и типы `@etn/shared` /
 * `main/ipc/contract.js` (грабли «Цикл импортов canvas.ts ↔ editor-модулей»:
 * модуль может подключаться из canvas.ts, поэтому `editor/*` импортировать
 * нельзя).
 */

import type { DuplicateHit } from '../../main/ipc/contract.js';
import { t } from './i18n.js';
import type {
  LinkPropertySide,
  LinkStyle,
  LinkType,
  Publication,
  Thought,
  ThoughtType,
} from '@etn/shared';

import { store } from '../state.js';
import { showDialog, type DialogButton } from './dialog.js';
import { div, el, span } from './dom.js';
import { etn } from './etn.js';
import { svgIcon, type IconName } from './icons.js';
import {
  buildLinkEndIcon,
  linkEndIconSpec,
  sortPropertyListRows,
  type LinkEndIconSpec,
  type PropertyListRow,
} from './property-list.js';
import { parseThoughtIdLookupQuery } from './pure.js';
import {
  wireSuggest,
  type SuggestEntry,
  type SuggestHandle,
  type SuggestSource,
} from './suggest-dropdown.js';
import { createThoughtCloud, type ThoughtCloudInput } from './thought-cloud.js';
import { orderedTypeRows, resolveLinkTypeVisual } from './type-tree.js';
import { iconButton, uiButton } from './ui/button.js';
import { fieldInput } from './ui/field.js';
import { createTree } from './ui/tree.js';

// ---------------------------------------------------------------------------
// Опции пикера
// ---------------------------------------------------------------------------

/** Какую сущность выбирает пикер. */
export type EntityKind =
  | 'thought-types'
  | 'link-types'
  | 'thoughts'
  | 'link-properties'
  | 'publications';

/**
 * Выбранное СВОЙСТВО-связь (ошибка 1dd08949): пользователь выбирает не тип
 * связи, а имя стороны свойства-связи — `key` (display-имя стороны) адресует
 * серверу и свойство, и направление ребра. Свойство заполняется у ДОБАВЛЯЕМОЙ
 * мысли значением якоря (мысли, от которой строится связь), так что ребро
 * попадает в типизированное свойство, а не в «Свойства вне типа».
 */
export interface LinkPropertyPick {
  /** Id реестровой записи свойства — для карточки/диагностики. */
  propertyId: string;
  /** Сторона свойства (`source` — имя прямого, `target` — обратного). */
  side: LinkPropertySide;
  /** Display-имя выбранной стороны: ключ записи (`properties.set`). Имя
   *  однозначно задаёт направление ребра (name_forward → исходящее,
   *  name_reverse → входящее). */
  key: string;
}

/** Одна выбираемая сущность. */
export interface EntityOption {
  /** Идентификатор сущности. */
  id: string;
  /** Имя — подпись облачка и строки. */
  title: string;
  /** Дополнительный текст живого поиска (обратное имя типа связи). */
  searchText?: string;
  /** Иерархия типов: родитель; `null`/нет — верхний уровень списка. */
  parentId?: string | null;
  /** Глубина в дереве типов (верхний уровень = 0). */
  depth?: number;
  /** У варианта есть потомки — показывается тоггл раскрытия. */
  hasChildren?: boolean;
  /** `false` — вариант показывается, но не выбирается (корень иерархии). */
  selectable?: boolean;
  /** Данные облачка фабрики (значок, цвета, начертание). Нет у варианта
   *  свойства-связи: его знак — значок конца связи (`linkEnd`). */
  cloud?: ThoughtCloudInput;
  /** Свотч линии для типа связи. */
  line?: { color: string | null; style: LinkStyle | null; width: number | null } | null;
  /** Значок конца связи (вариант-свойство-связь): направление и оформление
   *  линии, рисуется общим списком свойств (`buildLinkEndIcon`). */
  linkEnd?: LinkEndIconSpec | null;
  /** Уточнение строки серым (пара имён типа связи «(прямое -> обратное)»). */
  note?: string;
  /** Значение варианта для свойства-связи (`kind: 'link-properties'`). */
  linkProperty?: LinkPropertyPick;
}

/** Глиф облачка типа связи (тип связи не имеет иконки в модели данных). */
const LINK_TYPE_CLOUD_ICON = '🔗';

/**
 * Варианты каталога типов мыслей: дерево без корня иерархии («основной тип»
 * не выбирается), глубины сдвинуты к левому краю. Облачко — с `type_id`
 * самого типа: фабрика резолвит значок/цвета/начертание по цепочке типов.
 */
export function thoughtTypeEntityOptions(types: readonly ThoughtType[]): EntityOption[] {
  return orderedTypeRows(types)
    .filter((row) => !row.type.is_root)
    .map((row) => ({
      id: row.type.id,
      title: row.type.name,
      parentId: row.type.parent_id,
      depth: row.depth - 1,
      hasChildren: row.hasChildren,
      selectable: true,
      cloud: { id: row.type.id, title: row.type.name, type_id: row.type.id },
    }));
}

/** Варианты каталога типов связей: как {@link thoughtTypeEntityOptions}, плюс
 *  свотч линии и обратное имя в подписи («прямое / обратное»). */
export function linkTypeEntityOptions(types: readonly LinkType[]): EntityOption[] {
  return orderedTypeRows(types)
    .filter((row) => !row.type.is_root)
    .map((row) => {
      const line = resolveLinkTypeVisual(types, row.type.id);
      const title = `${row.type.name_forward} / ${row.type.name_reverse}`;
      return {
        id: row.type.id,
        title,
        searchText: row.type.name_reverse,
        parentId: row.type.parent_id,
        depth: row.depth - 1,
        hasChildren: row.hasChildren,
        selectable: true,
        cloud: { id: row.type.id, title, icon: LINK_TYPE_CLOUD_ICON, icon_kind: 'emoji' },
        line,
      };
    });
}

/** Вариант мысли из кандидата дубль-поиска (`findDuplicates`).
 *  Облачко — сам DTO (структурно совместим с `ThoughtCloudInput`): визуал
 *  резолвит фабрика, поля здесь не читаются (S1). */
export function thoughtEntityOption(hit: DuplicateHit): EntityOption {
  return {
    id: hit.id,
    title: hit.title,
    selectable: true,
    cloud: { ...hit },
  };
}

/**
 * URL мини-обложки публикации для облачка варианта (0.11.1, задача 3275fd8d,
 * элемент интерфейса 9626efb6): вложение — через протокол `etnimg` (байты
 * отдаёт main-процесс), внешняя обложка — сам URL, иначе `null` (заглушка —
 * глиф). Повторяет правило `screens/publications/cover.ts`, но живёт в `lib/`
 * — пикер не имеет права зависеть от экранов (его подключает `canvas.ts`).
 */
export function publicationCoverUrl(pub: Publication): string | null {
  if (pub.cover_kind === 'attachment' && pub.cover_attachment_id !== null) {
    return `etnimg://attachment/${encodeURIComponent(pub.cover_attachment_id)}`;
  }
  if (pub.cover_kind === 'url' && pub.cover_url !== null) {
    return pub.cover_url;
  }
  return null;
}

/**
 * Вариант публикации (5-й источник пикера, 0.11.1, задача 3275fd8d): подпись
 * — название, живой поиск ищет и по подзаголовку/автору; облачко — название с
 * мини-обложкой (обложка-картинка — `icon_kind: 'image'`, иначе глиф книги).
 */
export function publicationEntityOption(pub: Publication): EntityOption {
  const cover = publicationCoverUrl(pub);
  const searchText = [pub.subtitle, pub.authorship]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(' ');
  return {
    id: pub.id,
    title: pub.title,
    ...(searchText !== '' ? { searchText } : {}),
    selectable: true,
    cloud:
      cover !== null
        ? { id: pub.id, title: pub.title, icon: cover, icon_kind: 'image' }
        : { id: pub.id, title: pub.title, icon: '📄', icon_kind: 'emoji' },
  };
}

/** Варианты публикаций сети — тот же вид, что у источника `thoughts`. */
export function publicationEntityOptions(pubs: readonly Publication[]): EntityOption[] {
  return pubs.map(publicationEntityOption);
}

/** Размер порции живого поиска публикаций (догрузка при скролле выпадашки). */
export const PUBLICATIONS_PAGE_SIZE = 50;

/**
 * Кандидаты-публикации текущего слоя для живого поиска/каталога пикера
 * (`GET /publications`, поиск по названию/подзаголовку/автору). Пустой запрос
 * возвращает первую страницу каталога. Порционный источник (0.11.1, задача
 * 3275fd8d): выпадашка догружает следующую страницу при скролле вниз
 * (`SuggestSource.loadMore`), поэтому ответ короче {@link PUBLICATIONS_PAGE_SIZE}
 * — последний. Ошибка сети — пустой список (best-effort, как у прочих
 * источников пикера).
 */
export async function loadPublicationOptions(
  networkId: string,
  query: string,
  offset = 0,
  limit = PUBLICATIONS_PAGE_SIZE,
): Promise<EntityOption[]> {
  const trimmed = query.trim();
  try {
    const res = await etn.publications.list(networkId, {
      ...(trimmed !== '' ? { q: trimmed } : {}),
      limit,
      offset,
    });
    return publicationEntityOptions(res.items);
  } catch {
    return [];
  }
}

/**
 * Догрузить публикации по id (для отображения уже выбранных значений, которых
 * нет в текущей странице каталога). Ошибка/отсутствие — `null` (значение
 * рисуется сырым id, как у прочих ссылок).
 */
export async function resolvePublicationOptions(
  networkId: string,
  ids: readonly string[],
): Promise<EntityOption[]> {
  const out: EntityOption[] = [];
  await Promise.all(
    ids.map(async (id) => {
      try {
        out.push(publicationEntityOption(await etn.publications.get(networkId, id)));
      } catch {
        // Публикация недоступна — облачка нет.
      }
    }),
  );
  return out;
}

/**
 * Варианты каталога свойств-связей сети — четвёртый источник пикера
 * (требование cdb6b52f, ошибка a7abe50e): одна строка на КАЖДОЕ имя стороны
 * свойства-связи (прямое — источник, обратное — назначение), в едином
 * алфавитном порядке имён общего списка свойств. Скаляры и структурные
 * «Родители»/«Потомки» не предлагаются. Подпись пары — серым
 * «(прямое -> обратное)», знак — значок конца связи; `searchText` несёт оба
 * имени пары и описание, поэтому живой поиск находит свойство и по обратному
 * имени, и по описанию (как `filterPropertyListRows` общего списка). Чистая —
 * юнит-тест.
 */
export function linkPropertyEntityOptions(rows: readonly PropertyListRow[]): EntityOption[] {
  const out: EntityOption[] = [];
  for (const row of sortPropertyListRows(rows)) {
    if (row.valueType !== 'link' || row.structural || row.side === null) continue;
    const names = row.linkNames;
    out.push({
      id: row.id,
      title: row.name,
      searchText:
        names === null
          ? row.description ?? ''
          : `${names.forward} ${names.reverse} ${row.description ?? ''}`.trim(),
      selectable: true,
      linkEnd: linkEndIconSpec(row.side, row.visual),
      ...(names !== null ? { note: `(${names.forward} -> ${names.reverse})` } : {}),
      linkProperty: { propertyId: row.propertyId, side: row.side, key: row.name },
    });
  }
  return out;
}

/** Полная мысль → кандидат дубль-поиска (для id-lookup, ошибка d8893a1f). */
function thoughtToDuplicateHit(thought: Thought): DuplicateHit {
  return {
    ...thought,
    synonyms: thought.synonyms,
    matched_on: 'title',
    parent_title: null,
  };
}

/**
 * Кандидаты-мысли для строки живого поиска (ошибка d8893a1f): если запрос
 * целиком — полный UUID или его короткий hex-префикс, идёт прямой lookup по
 * id (`thoughts.get`), а не поиск по названию; иначе — штатный `findDuplicates`.
 * Так 8-символьный id находит ту же мысль, что и полный, и в пикере, и в
 * строке поиска. Неудачный/неоднозначный id-lookup даёт пусто (как и в строке
 * поиска, диагностику показывает сервер).
 */
async function loadThoughtHits(
  networkId: string,
  query: string,
  typeIds: string[],
): Promise<DuplicateHit[]> {
  const trimmed = query.trim();
  const id = parseThoughtIdLookupQuery(trimmed);
  if (id !== null) {
    try {
      return [thoughtToDuplicateHit(await etn.thoughts.get(networkId, id))];
    } catch {
      return [];
    }
  }
  return etn.thoughts.findDuplicates(networkId, trimmed, [], typeIds).catch(() => []);
}

// ---------------------------------------------------------------------------
// Чистые помощники списка (проверяются юнит-тестами)
// ---------------------------------------------------------------------------

/** Служебный id строки «Создать новый» — не совпадает ни с одним id (UUID). */
export const CREATE_ROW_ID = '\u0000create';

/**
 * Имя для строки «Создать новый „<имя>“», или `null`, когда строки быть не
 * должно: только для непустого запроса без совпадений (пустой запрос
 * показывает весь каталог, любое совпадение делает создание ненужным) и
 * только если вызывающий передал `onCreateNew`. Чистая — под юнит-тестами.
 */
export function createRowName(query: string, matchCount: number, enabled: boolean): string | null {
  if (!enabled || matchCount > 0) return null;
  const name = query.trim();
  return name === '' ? null : name;
}

/**
 * Шагов отступа строки каталога типов по её глубине. `depth` вариантов
 * начинается с 1 у верхнего уровня списка (корень иерархии из `options`
 * исключён, поэтому первыми идут его дети). Формула встроенного комбо (строки
 * выпадашки `wireSuggest`); строки модального чек-листа отступ считает сам
 * `lib/ui/tree.ts` по `parentId`.
 */
export function typeRowIndentSteps(depth: number | undefined): number {
  return Math.max(0, (depth ?? 1) - 1);
}

/**
 * Id вариантов, видимых при поиске. Пустой запрос — весь каталог с учётом
 * раскрытия: вариант виден, если у него нет родителя, родителя нет среди
 * вариантов (корень иерархии исключён из списка — сервер проставляет его
 * `parent_id` типов верхнего уровня, но сам корень в `options` не попадает)
 * или родитель раскрыт. Непустой — совпадения вместе с цепочкой предков.
 * Чистая — правило «пустой поиск показывает всё» встроенного комбо (строки
 * выпадашки `wireSuggest`); видимость строк модального чек-листа считает
 * `lib/ui/tree.ts` (`treeVisibleIds`).
 */
export function visibleEntityIds(
  options: readonly EntityOption[],
  needle: string,
  expanded: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(options.map((o) => [o.id, o]));
  const ids = new Set<string>();
  if (needle === '') {
    for (const opt of options) {
      const parent = opt.parentId ?? null;
      if (parent === null || !byId.has(parent) || expanded.has(parent)) ids.add(opt.id);
    }
    return ids;
  }
  const matches = (opt: EntityOption): boolean =>
    opt.title.toLowerCase().includes(needle) ||
    (opt.searchText ?? '').toLowerCase().includes(needle);
  for (const opt of options) {
    if (!matches(opt)) continue;
    let cur: EntityOption | undefined = opt;
    while (cur !== undefined) {
      ids.add(cur.id);
      cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
    }
  }
  return ids;
}

/**
 * Варианты каталога, отфильтрованные по подстроке запроса (совпадение в
 * `title` или `searchText`, регистр не важен); пустой/пробельный запрос —
 * весь каталог. Единый источник живого поиска чип-полей каталогов (типы
 * мыслей, типы связей, пользователи): контракт `SuggestSource.load(query)`
 * требует, чтобы источник сам сужал список по вводу (ошибка 698800be), а
 * `loadOptions: () => <полный каталог>` показывал каталог целиком при любом
 * вводе. Поля живого серверного поиска (мысли, `findDuplicates`) этим
 * фильтром не оборачивать: сервер уже отфильтровал по запросу, включая
 * совпадения по синонимам. Чистая — под юнит-тестами.
 */
export function filterEntityOptions(
  options: readonly EntityOption[],
  query: string,
): EntityOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...options];
  return options.filter(
    (o) =>
      o.title.toLowerCase().includes(needle) ||
      (o.searchText ?? '').toLowerCase().includes(needle),
  );
}

// ---------------------------------------------------------------------------
// Кросс-сетевой поиск кандидатов (задача ea04a185): используется ТОЛЬКО
// диалогом в принудительном кросс-режиме (`pickThoughtsDialog { crossNetwork }`,
// редактор значения `cross_network_ref`). Обычные диалоги выбора мысли охват
// не переключают — они ищут строго по текущей сети (требование 79755f76,
// ошибка 81be082f): выбор цели внутрисетевой связи чужой мыслью невалиден.
// ---------------------------------------------------------------------------

/**
 * Загрузить кандидатов-дублей веером по всем доступным сетям пользователя.
 * `networkId` — текущая открытая сеть (роут автоматически добавит её в веер,
 * если её нет в списке). Источник кандидатов принудительного кросс-режима
 * диалога выбора мысли (редактор `cross_network_ref`).
 *
 * Попутно освежает `store.state.networkList` (`display_name` сети нужен для
 * подписи чужой мысли в облачке кандидата — ошибка defcd811): каталог сетей
 * уже получен для веерного запроса, грех не закэшировать.
 */
export async function loadCrossNetworkCandidates(
  networkId: string,
  query: string,
  typeIds: readonly string[],
): Promise<DuplicateHit[]> {
  try {
    const networks = await etn.networks.list();
    if (networks.length > 0) {
      const incomingIds = new Set(networks.map((n) => n.id));
      const sameAsCache =
        store.state.networkList.length === networks.length &&
        store.state.networkList.every((n) => incomingIds.has(n.id));
      if (!sameAsCache) {
        store.update({ networkList: networks });
      }
    }
    const ids = networks.map((n) => n.id);
    if (ids.length === 0) return [];
    const response = await etn.thoughts.findDuplicatesAcrossNetworks(
      networkId,
      ids,
      query,
      [],
      [...typeIds],
    );
    return response.hits;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Каталоги типов (с догрузкой, если realtime ещё не принёс их)
// ---------------------------------------------------------------------------

async function thoughtTypesOf(networkId: string): Promise<ThoughtType[]> {
  if (store.state.thoughtTypes.length > 0) return store.state.thoughtTypes;
  try {
    return await etn.types.listThoughtTypes(networkId);
  } catch {
    return [];
  }
}

async function linkTypesOf(networkId: string): Promise<LinkType[]> {
  if (store.state.linkTypes.length > 0) return store.state.linkTypes;
  try {
    return await etn.types.listLinkTypes(networkId);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Модальный чек-лист
// ---------------------------------------------------------------------------

/** Контекст, передаваемый командам модального чек-листа. */
export interface EntityPickerDialogCtx {
  /** Текущий набор выбранных id (мутабельный — команды меняют его). */
  checked: Set<string>;
  /** Перерисовывает список (для «Пометить все» и подобных команд). */
  rerender: () => void;
}

/**
 * Команда-иконка верхней строки модального чек-листа (ошибка bd8b78a0):
 * текстовых надписей нет — единая иконка проекта плюс полное название
 * команды в тултипе (`title`) и в `aria-label` (доступность с клавиатуры).
 */
export interface EntityPickerCommand {
  /** Имя иконки из единого набора проекта (`lib/icons.ts`). */
  icon: IconName;
  /** Полное название команды — тултип и доступная подпись кнопки. */
  title: string;
  /** Действие; набор `ctx.checked` обычно мутирует, затем `ctx.rerender()`. */
  onClick: () => void;
}

/** Параметры модального чек-листа {@link pickEntitiesModal}. */
export interface EntityPickerModalOptions {
  networkId: string;
  kind: EntityKind;
  /** Заголовок диалога. */
  title: string;
  /** Начальный набор выбранных id (множественный режим). */
  currentIds?: readonly string[];
  /**
   * Одиночный выбор: клик по варианту сразу закрывает диалог и возвращает
   * `[id]` (мысли — выбор из выпадашки живого поиска). Футер — только
   * «Отмена».
   */
  single?: boolean;
  /**
   * Каталог вариантов, ЗАМЕНЯЮЩИЙ чтение из store (родительский пикер типа
   * отдаёт отфильтрованный список: без себя и потомков, с учётом предела
   * глубины). Не задан — каталог строится по `kind` из store.
   */
  catalogue?: readonly EntityOption[];
  /**
   * Синтетические варианты помимо каталога (например, строка «Структура»
   * фильтра типов связей на карте) — рисуются после каталога.
   */
  extraOptions?: readonly EntityOption[];
  /** Типы мыслей, сужающие живой поиск (только для `thoughts`). */
  searchTypeIds?: readonly string[];
  /** Разрешить пустой набор; иначе «Применить» неактивен при пустом. */
  allowEmpty?: boolean;
  /**
   * Команды-иконки верхней строки (режим типов), справа от строки поиска.
   * Общую «Очистить» (ластик) пикер добавляет сам — вызывающему остаются
   * «Пометить все» / «Вернуть умолчания» и подобные. Диалог не закрывают.
   * Длинный ряд текстовых команд в футере вылезал за границы диалога
   * (ошибка bd8b78a0), поэтому все команды живут в верхней строке.
   */
  commands?: (ctx: EntityPickerDialogCtx) => EntityPickerCommand[];
  /** Подпись кнопки применения (по умолчанию «Применить»). */
  applyLabel?: string;
  /**
   * Двойной клик по строке каталога — редактор варианта (правило 6 требования
   * 11ddd910, режим множественного выбора; в одиночном диалог закрывается
   * первым кликом). Пикер сам редакторов не открывает — механику задаёт
   * вызывающий; клик по строке при этом по-прежнему переключает флажок.
   */
  onEdit?: (opt: EntityOption) => void;
}

/**
 * Кнопка-иконка команды верхней строки пикера: единый набор иконок проекта,
 * тултип и `aria-label` (клавиатурная доступность — нативный `<button>`).
 * Кнопка-иконка словаря `lib/ui` (задача 56f1dcb2): тултип становится
 * `aria-label`. Размер в строке поиска сужает правило `.st-f-searchbar .ui-btn--icon`.
 */
function commandButton(icon: IconName, title: string, onClick: () => void): HTMLButtonElement {
  return iconButton({ icon: svgIcon(icon, 14), title, onClick });
}

/**
 * Открывает модальный чек-лист пикера. Возвращает новый набор id или `null`
 * при отмене. Отмена — ЛЮБОЙ путь закрытия каркаса `showDialog` («Отмена»,
 * Esc, ×, программный `closeDialog()`): завершение пикера повешено на его
 * `onClose`, срабатывающий на снятии подложки из DOM, а не на кнопку футера
 * (ошибка 12dfb87e — промис резолвится ВСЕГДА). Для типов список — дерево с
 * тогглами раскрытия, поиск сужает его (совпадения показываются вместе с
 * цепочкой предков); для мыслей — чипы выбранного и выпадашка живого поиска.
 */
export async function pickEntitiesModal(
  opts: EntityPickerModalOptions,
): Promise<string[] | null> {
  const single = opts.single === true;
  const allowEmpty = opts.allowEmpty !== false;
  const catalogue: EntityOption[] =
    opts.catalogue !== undefined
      ? [...opts.catalogue]
      : opts.kind === 'thought-types'
        ? thoughtTypeEntityOptions(await thoughtTypesOf(opts.networkId))
        : opts.kind === 'link-types'
          ? linkTypeEntityOptions(await linkTypesOf(opts.networkId))
          : [];
  const options = [...catalogue, ...(opts.extraOptions ?? [])];

  return new Promise((resolve) => {
    const checked = new Set<string>(opts.currentIds ?? []);
    /** Собранные данные облачков выбранных мыслей (для kind === 'thoughts'). */
    const pickedThoughts = new Map<string, ThoughtCloudInput>();
    let settled = false;
    /**
     * Закрывает сам диалог. Футер закрывает его неявно (клик по кнопке), а
     * выбор строки/варианта живого поиска — нет, поэтому завершение пикера
     * обязано снять диалог само (ошибка c9bd04ed: одиночный пикер оставался
     * поверх всего после выбора).
     */
    let closeSelf: (() => void) | null = null;
    const finish = (value: string[] | null): void => {
      if (settled) return;
      settled = true;
      closeSelf?.();
      resolve(value);
    };

    // Раскрытие иерархии: по умолчанию всё раскрыто (прежний чек-лист
    // показывал всё дерево), тоггл сворачивает ветку.
    const expanded = new Set<string>(options.filter((o) => o.hasChildren === true).map((o) => o.id));

    const body = div('st-f-picker list-dialog-body');

    // --- Режим «мысли»/«публикации»: поиск с выпадашкой + чипы выбранного ---
    if (opts.kind === 'thoughts' || opts.kind === 'publications') {
      const isPublications = opts.kind === 'publications';
      const searchInput = el('input', 'st-f-input st-f-search') as HTMLInputElement;
      searchInput.type = 'text';
      searchInput.autocomplete = 'off';
      searchInput.placeholder = t('actions.search');
      // Охват поиска задан назначением выбора (требование 79755f76, ошибка
      // 81be082f): цели внутрисетевых связей ищутся только по текущей сети,
      // переключателя охвата здесь нет.
      const searchBar = div('st-f-searchbar');
      searchBar.append(searchInput);
      const chipsBox = div('entity-pick-chips');
      body.append(searchBar, chipsBox);

      /** Догрузить облачко одной сущности по id (мысль/публикация). */
      const loadCloud = async (id: string): Promise<ThoughtCloudInput | null> => {
        if (isPublications) {
          const [opt] = await resolvePublicationOptions(opts.networkId, [id]);
          return opt?.cloud ?? null;
        }
        try {
          const ref = (await etn.thoughts.resolve(opts.networkId, [id]))[0];
          return ref !== undefined ? { ...ref } : null;
        } catch {
          return null;
        }
      };

      /** Строка выпадашки по варианту публикации (облачко с мини-обложкой). */
      const publicationEntries = (options: EntityOption[]): SuggestEntry[] =>
        options.map((opt) => ({ value: opt.id, label: opt.title, thought: opt.cloud }));

      const searchSource: SuggestSource = {
        when: 'typed',
        load: (query) => {
          if (isPublications) {
            return loadPublicationOptions(opts.networkId, query).then(publicationEntries);
          }
          const typeIds = (opts.searchTypeIds ?? []).filter((id) => id !== '');
          return loadThoughtHits(opts.networkId, query, typeIds).then((hits) =>
            // Строка-мысль — облачком: DTO кандидата структурно совместим с
            // `ThoughtCloudInput`, визуал резолвит фабрика (S1).
            hits.map((hit) => ({ value: hit.id, label: hit.title, thought: { ...hit } })),
          );
        },
        // Публикации — порционный серверный источник: скролл выпадашки вниз
        // догружает следующую страницу (0.11.1, задача 3275fd8d).
        ...(isPublications
          ? {
              loadMore: (query: string, offset: number) =>
                loadPublicationOptions(opts.networkId, query, offset).then(publicationEntries),
              pageSize: PUBLICATIONS_PAGE_SIZE,
            }
          : {}),
      };
      const handle = wireSuggest(searchInput, {
        sources: [searchSource],
        onPick: (entry) => {
          if (single) {
            finish([entry.value]);
            return;
          }
          checked.add(entry.value);
          // Облачко выбранного: данные из строки выпадашки, догрузка полного
          // DTO по id — если строка пришла без него.
          const title = entry.thought?.title ?? entry.label;
          pickedThoughts.set(entry.value, entry.thought ?? { id: entry.value, title });
          void loadCloud(entry.value)
            .then((cloud) => {
              if (cloud !== null) pickedThoughts.set(entry.value, cloud);
            })
            .catch(() => undefined)
            .finally(() => renderChips());
          searchInput.value = '';
          renderChips();
        },
      });

      const renderChips = (): void => {
        chipsBox.replaceChildren();
        if (checked.size === 0) {
          chipsBox.append(el('p', 'muted', 'Ничего не выбрано.'));
          return;
        }
        for (const id of checked) {
          const cloud = pickedThoughts.get(id) ?? { id, title: id };
          chipsBox.append(
            createThoughtCloud(cloud, {
              profile: 'chip',
              // Ширина — по чип-полю выбора: имя обрезается многоточием по
              // нему, а не раздувает диалог (принцип ширины облачка).
              width: 'container',
              actions: {
                onRemove: () => {
                  checked.delete(id);
                  renderChips();
                  updateButtons();
                },
              },
            }),
          );
        }
      };
      const renderSelected = (): void => {
        void Promise.all([...checked].map((id) => loadCloud(id).then((cloud) => [id, cloud] as const)))
          .then((entries) => {
            for (const [id, cloud] of entries) {
              if (cloud !== null) pickedThoughts.set(id, cloud);
            }
          })
          .catch(() => undefined)
          .finally(() => renderChips());
      };
      // Подгрузить облачка начального набора.
      renderSelected();

      let clearBtn: HTMLButtonElement | null = null;
      let applyBtn: HTMLButtonElement | null = null;
      const updateButtons = (): void => {
        if (clearBtn !== null) clearBtn.disabled = checked.size === 0;
        if (applyBtn !== null) applyBtn.disabled = !allowEmpty && checked.size === 0;
      };
      const buttons: DialogButton[] = [];
      if (!single) {
        buttons.push({
          label: t('actions.reset'),
          keepOpen: true,
          ref: (btn) => {
            clearBtn = btn;
            updateButtons();
          },
          onClick: () => {
            checked.clear();
            pickedThoughts.clear();
            renderChips();
            updateButtons();
          },
        });
      }
      buttons.push(
        // «Отмена» без `onClick`: каркас снимает диалог сам, а отмену
        // фиксирует `onClose` ниже (ошибка 12dfb87e).
        { label: t('actions.cancel') },
        ...(single
          ? []
          : [
              {
                label: opts.applyLabel ?? t('actions.apply'),
                primary: true,
                ref: (btn: HTMLButtonElement) => {
                  applyBtn = btn;
                  updateButtons();
                },
                onClick: () => finish([...checked]),
              },
            ]),
      );
      closeSelf = showDialog({
        title: opts.title,
        body,
        size: 's',
        // Правило 9 требования 11ddd910: размер диалога-списка задан ролью и
        // стабилен — список занимает свободное место роли (`.list-dialog-body`),
        // а не схлопывается по содержимому при наборе поиска.
        fixedHeight: true,
        buttons,
        onMount: () => searchInput.focus(),
        // Любое закрытие каркаса — «Отмена», Esc, ×, программный
        // `closeDialog()` — это отмена: промис резолвится `null`, иначе
        // `await`/`.then` вызывающего висит вечно (ошибка 12dfb87e). При
        // завершении выбором/применением `finish` уже выставил `settled`,
        // поэтому позднее событие `remove` ничего не переигрывает.
        onClose: () => {
          handle.dispose();
          finish(null);
        },
      });
      updateButtons();
      return;
    }

    // --- Режим типов: поиск + единое дерево-чек-лист ----------------------
    const searchInput = el('input', 'st-f-input st-f-search') as HTMLInputElement;
    searchInput.type = 'text';
    searchInput.autocomplete = 'off';
    searchInput.placeholder = t('actions.search');
    const list = div('st-f-checks st-f-picker-list');

    // Дерево рисует общий компонент `lib/ui/tree.ts` (требование 0086037c,
    // ошибка 6925ffa0): каретка/флажок/облачко-подпись выровнены по токенам,
    // клавиатура и ARIA — его. Пикер задаёт только источник данных, раскрытие
    // по умолчанию и содержимое строки.
    const tree = createTree<EntityOption>({
      items: () => options,
      ariaLabel: opts.title,
      checkbox: !single,
      // Раскрытие иерархии: по умолчанию всё раскрыто (прежний чек-лист
      // показывал всё дерево), тоггл сворачивает ветку.
      expandedIds: expanded,
      emptyText: t('tree.empty'),
      emptyHint: t('tree.emptyHint'),
      showChildCount: true,
      filterText: (opt) => `${opt.title} ${opt.searchText ?? ''}`,
      isChecked: (opt) => checked.has(opt.id),
      onCheck: (opt, on) => {
        if (on) checked.add(opt.id);
        else checked.delete(opt.id);
        updateButtons();
      },
      // Правило 6 требования 11ddd910: одиночный пикер подтверждает выбор
      // двойным кликом или Enter (`onActivate`; клик только делает строку
      // текущей, кнопка «Выбрать» — ниже), множественный — двойной клик
      // открывает редактор строки, если вызывающий его задал, а клик
      // переключает флажок (ошибка d1a009fa).
      onActivate: single ? (opt) => finish([opt.id]) : undefined,
      onDblActivate: !single ? opts.onEdit : undefined,
      renderContent: (opt) => {
        const nodes: Node[] = [];
        if (opt.line != null) {
          const swatch = span('', 'type-combo-swatch');
          const dash = opt.line.style === 'dashed' ? 'dashed' : opt.line.style === 'dotted' ? 'dotted' : 'solid';
          swatch.style.borderTop = `${Math.max(1, Math.min(6, opt.line.width ?? 1))}px ${dash} ${opt.line.color ?? '#9aa3b2'}`;
          nodes.push(swatch);
        }
        // Вариант-свойство-связь: знак — значок конца связи, вместо облачка
        // подпись именем стороны (у варианта нет данных мысли).
        if (opt.linkEnd != null) nodes.push(buildLinkEndIcon(opt.linkEnd));
        if (opt.cloud !== undefined) {
          nodes.push(
            createThoughtCloud(opt.cloud, {
              profile: 'chip',
              // Ширина — по строке списка выбора.
              width: 'container',
            }),
          );
        } else {
          const label = span(opt.title, 'entity-pick-label');
          label.title = opt.title;
          nodes.push(label);
        }
        if (opt.note !== undefined) nodes.push(span(opt.note, 'entity-pick-note'));
        return nodes;
      },
    });
    list.append(tree.root);

    /** Перерисовать список (команды «Очистить»/«Пометить все» и смена набора). */
    const renderList = (): void => {
      tree.render();
    };

    searchInput.addEventListener('input', () => {
      tree.setFilter(searchInput.value.trim().toLowerCase());
    });

    let clearBtn: HTMLButtonElement | null = null;
    let applyBtn: HTMLButtonElement | null = null;
    const updateButtons = (): void => {
      if (clearBtn !== null) clearBtn.disabled = checked.size === 0;
      if (applyBtn !== null) applyBtn.disabled = !allowEmpty && checked.size === 0;
    };
    const ctx: EntityPickerDialogCtx = {
      checked,
      rerender: () => {
        renderList();
        updateButtons();
      },
    };
    // Верхняя строка: поиск + команды-иконки — общая «Очистить» (ластик) и
    // команды вызывающего. В футере команд нет: их длинный ряд текстовых
    // кнопок вылезал за границы диалога (ошибка bd8b78a0).
    const searchBar = div('st-f-searchbar');
    searchBar.append(searchInput);
    if (!single) {
      clearBtn = commandButton('eraser', t('actions.reset'), () => {
        checked.clear();
        renderList();
        updateButtons();
      });
      searchBar.append(clearBtn);
      if (opts.commands !== undefined) {
        for (const cmd of opts.commands(ctx)) {
          searchBar.append(commandButton(cmd.icon, cmd.title, cmd.onClick));
        }
      }
    }
    body.append(searchBar, list);
    const buttons: DialogButton[] = [
      // «Отмена» без `onClick`: отмену фиксирует `onClose` диалога ниже
      // (ошибка 12dfb87e), поэтому она работает и для Esc, и для ×.
      { label: t('actions.cancel') },
      ...(single
        ? [
            // Одиночный пикер (правило 6 требования 11ddd910, ошибка
            // d1a009fa): клик по строке только делает её текущей; выбор
            // подтверждают кнопка «Выбрать», двойной клик или Enter.
            {
              label: t('actions.select'),
              primary: true,
              keepOpen: true,
              onClick: () => {
                const id = tree.getCurrentId();
                if (id === null) return;
                finish([id]);
                closeSelf?.();
              },
            },
          ]
        : [
            {
              label: opts.applyLabel ?? t('actions.apply'),
              primary: true,
              ref: (btn: HTMLButtonElement) => {
                applyBtn = btn;
                updateButtons();
              },
              onClick: () => finish([...checked]),
            },
          ]),
    ];

    closeSelf = showDialog({
      title: opts.title,
      body,
      size: 's',
      // Правило 9 требования 11ddd910: роль задаёт фиксированную высоту, тело
      // прокручивается внутри, а область списка (`.list-dialog-body`) тянется на
      // свободное место — размер не «дёргается» от поиска и числа строк.
      fixedHeight: true,
      buttons,
      onMount: () => {
        renderList();
        updateButtons();
        searchInput.focus();
      },
      // Закрытие каркаса (Esc, ×, «Отмена», программный `closeDialog()`) —
      // отмена: промис обязан резолвиться `null` (ошибка 12dfb87e).
      // Завершение выбором/применением выставляет `settled` раньше, чем
      // придёт событие `remove`, поэтому переигрывания не происходит.
      onClose: () => finish(null),
    });
  });
}

// ---------------------------------------------------------------------------
// Множественный выбор сущностей чипами (общий чип-лист критериев)
// ---------------------------------------------------------------------------

/** Параметры {@link buildEntityChipField}. */
/**
 * Перемещение значения `moved` ПЕРЕД значением `before` в списке выбранных
 * (0.11.1, задача a3cfc018): чистая логика drag-переупорядочения чип-поля
 * ({@link EntityChipFieldOptions.reorderable}). `moved` отсутствует во входе
 * или совпадает с `before` — порядок не меняется; `before` не найден (брошено
 * на пустое место/за пределы) — `moved` уходит в конец. Возвращается НОВЫЙ
 * массив.
 */
export function reorderValues(
  values: readonly string[],
  moved: string,
  before: string | null,
): string[] {
  if (!values.includes(moved) || before === moved) return [...values];
  const without = values.filter((value) => value !== moved);
  if (before === null) return [...without, moved];
  const index = without.indexOf(before);
  if (index === -1) return [...without, moved];
  const out = [...without];
  out.splice(index, 0, moved);
  return out;
}

/** Опции чип-поля множественного выбора сущностей. */
export interface EntityChipFieldOptions {
  /** Текущие значения (id сущностей или `$`-токены) — читаются при отрисовке. */
  getValues: () => string[];
  /** Запись нового набора значений. */
  onChange: (values: string[]) => void;
  /**
   * Кандидаты для живого поиска (и для облачков уже выбранных значений).
   * Пустой запрос — весь каталог (типы) либо пусто (мысли). Второй аргумент —
   * смещение для порционной догрузки (только при заданном {@link pageSize}).
   */
  loadOptions: (query: string, offset?: number) => EntityOption[] | Promise<EntityOption[]>;
  /**
   * Каталог, уже известный вызывающему: заполняет облачка значений ДО первого
   * поиска и открытия пикера. Без него чипы предзаданных значений (например,
   * свойств текстов «Рецептов») рисовались бы по одному id: `byId` наполняется
   * только при загрузке источника (ошибка fb4173d9). Порядок вариантов
   * задаёт вызывающий; повторный ввод значения перекрывает.
   */
  initialOptions?: readonly EntityOption[];
  /** Когда источник кандидатов участвует в списке (по умолчанию `always`). */
  optionsWhen?: 'always' | 'typed';
  /**
   * Размер порции живого поиска: задан — источник догружает следующую
   * страницу при скролле выпадашки (`loadOptions(query, offset)`), по образцу
   * порционного поиска целей связи (0.11.1, задача 3275fd8d). Ответ короче
   * порции считается последним.
   */
  pageSize?: number;
  /** Заголовок группы кандидатов. */
  optionsHeader?: string;
  /** Источники подсказок вызывающего (токены) — общий список выпадашки. */
  extraSources?: readonly SuggestSource[];
  /** Данные облачка значения; `null` — сырой текст (нет данных). */
  cloudOf?: (value: string) => ThoughtCloudInput | null;
  placeholder?: string;
  /**
   * Модальный пикер поверх нетокенных значений: получает управляемое
   * подмножество, возвращает его замену (`null` — отмена); чипы-токены
   * сохраняются.
   */
  picker?: { label: string; open(managed: readonly string[]): Promise<string[] | null> };
  /**
   * Приглашение непустого поля. Поле выбора сущностей едино с полем значения
   * свойства-связи в редакторе мысли (0.10.1, приёмка №2): пусто — `placeholder`
   * («Название мысли…»), есть значения — `addPlaceholder` («+ ещё одну мысль»).
   */
  addPlaceholder?: string;
  /**
   * Перетаскивание чипов меняет ПОРЯДОК значений (0.11.1, задача a3cfc018:
   * «порядок перетаскиванием» в рецептах публикации). При `true` каждый чип —
   * источник DnD: брошенный на другой чип, перемещается перед ним; `onChange`
   * получает переупорядоченный массив. По умолчанию порядок не меняется.
   */
  reorderable?: boolean;
  /**
   * Клик по чипу значения открывает сущность (0.11.1, задача 3275fd8d):
   * значение свойства «Публикация» ведёт на экран публикаций (элемент
   * интерфейса 9626efb6). Не задано — чип без обработчика клика.
   */
  onOpen?: (value: string) => void;
  /** Начальное состояние «поле недоступно» (поле ввода и кнопка пикера). */
  disabled?: boolean;
}

/** Собранный чип-лист сущностей. */
export interface EntityChipField {
  root: HTMLElement;
  /** Перерисовывает чипы (вызывающий догрузил облачка). */
  refresh(): void;
  /** Включает/выключает поле: поле ввода, кнопка пикера, снятие чипов. */
  setDisabled(value: boolean): void;
}

/** Строка выпадашки по варианту сущности: облачко, отступ дерева, свотч линии. */
function entityEntry(opt: EntityOption): SuggestEntry {
  const entry: SuggestEntry = { value: opt.id, label: opt.title };
  if (opt.cloud !== undefined) entry.thought = opt.cloud;
  if (opt.depth !== undefined) entry.indent = typeRowIndentSteps(opt.depth);
  if (opt.line != null) entry.swatch = opt.line;
  return entry;
}

/** Стоит ли клавиатурный фокус внутри узла — снимок ДО перерисовки виджета. */
function hasKeyboardFocus(container: HTMLElement): boolean {
  const active: Element | null | undefined = document.activeElement;
  return active != null && container.contains(active);
}

/**
 * Возвращает клавиатурный фокус в виджет после перерисовки, снёсшей или
 * скрывшей сфокусированный узел (ошибка 797d0485).
 *
 * Браузер переводит фокус на `<body>`, когда узел с фокусом исчезает из DOM
 * (снятие чипа сносит кнопку «✕») или становится `display:none` (выбор строки
 * прячет строку ввода заполненного комбо, `renderMode`). Фокус на `<body>` —
 * это «молчащий» диалог: `Tab`/`Shift+Tab` перестают ходить по его полям.
 * Поэтому после перерисовки отдаём фокус живому узлу поля (`target`).
 *
 * `hadFocus` — был ли фокус внутри виджета ДО перерисовки: тогда он потерян
 * именно нашей правкой. `adoptLostFocus` — забирать ли фокус, уже потерянный
 * на `<body>` не нами: нужно виджету, действие которого закрыло поверх него
 * модальный пикер (комбо «…»); не нужно при внешней перерисовке (`refresh`
 * чип-поля), чтобы не перехватывать чужой фокус. Фокус на живом постороннем
 * узле не перехватывается никогда.
 */
function restoreKeyboardFocus(
  target: HTMLElement | null,
  hadFocus: boolean,
  adoptLostFocus = true,
): void {
  if (target === null) return;
  const active: Element | null | undefined = document.activeElement;
  const lost = active == null || active === document.body;
  if (!hadFocus && !(adoptLostFocus && lost)) return;
  target.focus();
}

/**
 * Чип-лист множественного выбора сущностей: выбранные значения — мини-облачка
 * общей фабрики (значок, цвета, бледность неактуальной, метка корзины;
 * инструкция «Использовать унифицированные поля выбора ссылок в диалогах»),
 * поле ввода — живой поиск общей выпадашкой, необязательная кнопка модального
 * пикера. Свободный текст и токены (строки `$…`) добавляются как значения —
 * так поля критериев («Родительские мысли», «Типы мыслей», «Типы связей»,
 * автор/редактор) сохраняют смешение литералов и токенов. Отдельная сборка
 * чипов вне общих модулей запрещена сторожем `guard-value-editor`.
 */
export function buildEntityChipField(opts: EntityChipFieldOptions): EntityChipField {
  const root = div('entity-chip-field st-f-fieldrow');
  // Разметку чип-поля даёт общая `.link-value-wrap/field/corner` — та же, что
  // у поля значения свойства-связи в редакторе мысли (0.10.1, приёмка №2):
  // облачка значений, поле живого поиска, угловые «…» (список) и «✕» (очистка).
  const wrap = div('link-value-wrap');
  const field = div('st-f-chipfield entity-chip-field-inner link-value-field');
  const input = fieldInput({ extraClass: 'entity-chip-input' }) as HTMLInputElement;
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = opts.placeholder ?? 'Добавить значение…';

  /** Каталог, накопленный источником: по нему рисуются облачка значений. */
  const byId = new Map<string, EntityOption>();

  /** Заблокировано ли поле (выключатель зоны настроек поиска, задача a3247f84). */
  let disabled = opts.disabled === true;
  /** Значение чипа, который сейчас тащат (drag-переупорядочение). */
  let dragValue: string | null = null;
  /** Угловая кнопка «…» — создаётся ниже, если пикер задан. */
  let pickBtn: HTMLButtonElement | null = null;
  /** Угловая кнопка «✕» — очистка всего значения. */
  const clearBtn = uiButton({
    label: '✕',
    role: 'ghost',
    class: 'link-value-corner-btn',
    title: 'Очистить значение',
    onClick: () => {
      if (disabled || opts.getValues().length === 0) return;
      opts.onChange([]);
      renderChips();
    },
  });

  const commit = (raw: string): void => {
    const value = raw.trim();
    if (value === '' || disabled) return;
    input.value = '';
    if (opts.getValues().includes(value)) return;
    opts.onChange([...opts.getValues(), value]);
    renderChips();
  };

  const mapOptions = (options: EntityOption[]): SuggestEntry[] => {
    for (const opt of options) byId.set(opt.id, opt);
    return options.map(entityEntry);
  };
  const source: SuggestSource = {
    when: opts.optionsWhen ?? 'always',
    ...(opts.optionsHeader !== undefined ? { header: opts.optionsHeader } : {}),
    load: (query) => Promise.resolve(opts.loadOptions(query, 0)).then(mapOptions),
    // Порционная догрузка (публикации): скролл выпадашки вниз зовёт
    // `loadOptions(query, offset)`.
    ...(opts.pageSize !== undefined
      ? {
          loadMore: (query: string, offset: number) =>
            Promise.resolve(opts.loadOptions(query, offset)).then(mapOptions),
          pageSize: opts.pageSize,
        }
      : {}),
  };
  const sources: SuggestSource[] = [source, ...(opts.extraSources ?? [])];
  wireSuggest(input, {
    sources,
    // Свободный текст фиксирует обработчик `keydown` ниже; Enter над
    // выделенной строкой выбирает её (общая выпадашка гасит событие).
    pickFirstOnEnter: false,
    onPick: (entry) => commit(entry.value),
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.defaultPrevented) {
      event.preventDefault();
      commit(input.value);
    }
  });
  field.addEventListener('click', (event) => {
    if (event.target === field) input.focus();
  });

  function renderChips(): void {
    // Перерисовка сносит чипы и переставляет узел ввода: если фокус был внутри
    // поля, браузер уводит его на <body> — вернём его в строку ввода (797d0485).
    const hadFocus = hasKeyboardFocus(field);
    const chips: HTMLElement[] = [];
    for (const value of opts.getValues()) {
      const known = byId.get(value);
      const explicitCloud = opts.cloudOf?.(value) ?? null;
      // Вариант без облачка мысли (свойство-связь, структурная строка): у него
      // есть лишь `title`, поэтому облачко собирается из имени варианта, а не из
      // сырого id — иначе чип показывал UUID вместо имени (ошибка fb4173d9).
      const cloud: ThoughtCloudInput =
        explicitCloud ?? known?.cloud ?? { id: value, title: known?.title ?? value };
      const chip = createThoughtCloud(cloud, {
        profile: 'chip',
        width: 'container',
        actions: {
          ...(opts.onOpen !== undefined ? { onClick: (id: string) => opts.onOpen?.(id) } : {}),
          ...(disabled
            ? {}
            : {
                onRemove: () => {
                  opts.onChange(opts.getValues().filter((v) => v !== value));
                  renderChips();
                },
              }),
        },
      });
      // Знак варианта-свойства-связи — значок конца связи, как в строках
      // выпадашки (у облачка-мысли значок рисует фабрика). Без этого в слоте
      // значка светился глиф мысли по умолчанию.
      if (explicitCloud === null && known?.cloud === undefined && known?.linkEnd != null) {
        const iconBox = chip.querySelector('.mini-icon');
        if (iconBox !== null) iconBox.replaceChildren(buildLinkEndIcon(known.linkEnd));
      }
      if (opts.reorderable === true && !disabled) {
        wireChipReorder(chip, value);
      }
      chips.push(chip);
    }
    // Поле ввода сохраняется (слушатели выпадашки) — набор чипов заменяем.
    field.replaceChildren(...chips, input);
    // Приглашение: пусто — «Название…», есть значения — «+ ещё один …»
    // (единый вид с полем значения свойства-связи, приёмка №2).
    const empty = opts.getValues().length === 0;
    input.placeholder = empty
      ? (opts.placeholder ?? 'Добавить значение…')
      : (opts.addPlaceholder ?? opts.placeholder ?? 'Добавить значение…');
    // Крестик очистки — только у ЗАПОЛНЕННОГО поля: у пустого значения
    // очищать нечего, а лишняя «×» рядом с приглашением читается как ошибка.
    clearBtn.hidden = empty;
    // Перерисовку может затеять и вызывающий (асинхронная догрузка каталога) —
    // его фокус не перехватываем, возвращаем только потерянный здесь.
    restoreKeyboardFocus(input, hadFocus, false);
  }

  /**
   * DnD одного чипа (при `reorderable`): брошенный на другой чип, перемещается
   * перед ним; переупорядоченный набор уходит в `onChange`. Порядок значений —
   * порядок чипов; перерисовка сохраняет его.
   */
  function wireChipReorder(chip: HTMLElement, value: string): void {
    chip.draggable = true;
    chip.dataset['chipValue'] = value;
    chip.addEventListener('dragstart', (ev) => {
      dragValue = value;
      chip.classList.add('entity-chip-drag');
      if (ev.dataTransfer !== null) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', value);
      }
    });
    chip.addEventListener('dragend', () => {
      chip.classList.remove('entity-chip-drag');
      dragValue = null;
    });
    chip.addEventListener('dragover', (ev) => {
      if (dragValue === null || dragValue === value) return;
      ev.preventDefault();
      chip.classList.add('entity-chip-drop');
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('entity-chip-drop'));
    chip.addEventListener('drop', (ev) => {
      ev.preventDefault();
      chip.classList.remove('entity-chip-drop');
      const moved = dragValue ?? ev.dataTransfer?.getData('text/plain') ?? '';
      dragValue = null;
      if (moved === '' || moved === value) return;
      opts.onChange(reorderValues(opts.getValues(), moved, value));
      renderChips();
    });
  }

  /** Приводит поле ввода, кнопку пикера и рамку к состоянию `disabled`. */
  function applyDisabled(): void {
    input.disabled = disabled;
    if (pickBtn !== null) pickBtn.disabled = disabled;
    root.classList.toggle('disabled', disabled);
  }

  // Предзаданный каталог — до первой отрисовки чипов, чтобы предзаполненные
  // значения получали имя сразу (ошибка fb4173d9).
  if (opts.initialOptions !== undefined) {
    for (const option of opts.initialOptions) byId.set(option.id, option);
  }
  field.append(input);
  renderChips();
  // Угловые кнопки поля: «…» (список) — когда задан пикер, «✕» — очистка всего.
  const corner = div('link-value-corner');
  if (opts.picker !== undefined) {
    const { picker } = opts;
    const managed = (): string[] => opts.getValues().filter((v) => !v.startsWith('$'));
    pickBtn = uiButton({
      label: '…',
      role: 'ghost',
      class: 'link-value-corner-btn',
      title: picker.label,
      onClick: () => {
        if (disabled) return;
        void picker.open(managed()).then((next) => {
          if (next === null) return;
          const kept = opts.getValues().filter((v) => v.startsWith('$'));
          opts.onChange([...kept, ...next]);
          renderChips();
        });
      },
    });
    corner.append(pickBtn);
  }
  corner.append(clearBtn);
  wrap.append(field, corner);
  root.append(wrap);

  // Первичная загрузка каталога — облачка уже выбранных значений (типы,
  // пользователи) видны до первого фокуса в поле.
  if ((opts.optionsWhen ?? 'always') === 'always') {
    void Promise.resolve(source.load('')).then(() => renderChips());
  }

  applyDisabled();

  return {
    root,
    refresh: renderChips,
    setDisabled: (value: boolean): void => {
      if (value === disabled) return;
      disabled = value;
      applyDisabled();
      // Снятие чипа возможно только у активного поля — перерисовываем.
      renderChips();
    },
  };
}

// ---------------------------------------------------------------------------
// Встроенное комбо
// ---------------------------------------------------------------------------

/** Параметры встроенного комбо {@link buildEntityCombo}. */
export interface EntityComboOptions {
  networkId: string;
  kind: EntityKind;
  /** Текущее значение (id сущности; `null` — пусто). */
  value: string | null;
  /**
   * Подпись пустой строки в выпадашке живого поиска: её выбор очищает
   * значение. В самом поле пустое значение показывает `placeholder`, а не
   * эту подпись (поле ввода пусто, пока значение не выбрано).
   */
  emptyLabel?: string;
  placeholder?: string;
  /** Заблокированное поле (без поиска, «…» и очистки). */
  disabled?: boolean;
  /** Типы мыслей, сужающие живой поиск (только для `thoughts`). */
  searchTypeIds?: readonly string[];
  /**
   * Строки общего списка свойств (`lib/property-list.ts`) — источник вариантов
   * четвёртого источника (`kind: 'link-properties'`): по варианту на КАЖДОЕ имя
   * стороны свойства-связи. Скаляры и структурные строки отсеиваются.
   */
  linkPropertyRows?: () => readonly PropertyListRow[];
  /**
   * Выбран вариант целиком (в дополнение к `onChange(id)`): свойству-связи
   * нужен не id, а `linkProperty` варианта. `null` — значение очищено.
   */
  onChangeEntity?: (option: EntityOption | null) => void;
  /**
   * Минимальная (она же — потолок) ширина выпадашки живого поиска, px.
   * Передаётся вызывающим, когда список не помещается под узким полем и должен
   * быть шире него, — диалог добавления просит 560px однообразно у полей типа
   * и свойства связи (ошибка 5c7f8376). Без значения — прежние 320px.
   */
  dropdownMinWidth?: number;
  /**
   * Заголовок диалога «…» (выбор единственного значения). По умолчанию —
   * «Выбрать тип мысли / тип связи / мысль».
   */
  pickerTitle?: string;
  /**
   * Режим `expandAll`: дерево типов раскрыто целиком (родительский пикер
   * редактора типа). По умолчанию раскрыт только верхний уровень.
   */
  expandAll?: boolean;
  /**
   * Свой каталог вариантов вместо чтения типа из store (родительский пикер
   * фильтрует кандидатов: без себя, потомков и с учётом предела глубины).
   * Тот же каталог отдаётся и диалогу «…», чтобы выбор в нём не предлагал
   * запрещённые варианты.
   */
  options?: () => EntityOption[];
  /**
   * Быстрое создание типа: непустой запрос без совпадений даёт строку
   * «Создать новый „<запрос>“»; выбор строки вызывает хук — вызывающий
   * открывает диалог создания и резолвит id нового типа (или `null`, если
   * пользователь отказался: поле и список возвращаются к вводу).
   */
  onCreateNew?: (query: string) => Promise<string | null>;
  onChange: (id: string | null) => void;
}

/** Встроенное поле одиночного выбора сущности. */
export interface EntityCombo {
  root: HTMLElement;
  /** Текущее значение (`null` — пусто). */
  value(): string | null;
  /**
   * Программно устанавливает значение БЕЗ вызова `onChange` (внешняя
   * перепривязка поля к другой сущности того же вида, задача 90b2256e: шапка
   * редактора при смене мысли обновляет значения на месте, а не пересобирает
   * поле). Перерисовывает облачко/режим поля, значение владельцу не сохраняет.
   */
  setValue(id: string | null): void;
  /** Закрывает выпадашку и снимает слушатели. */
  dispose(): void;
}

/**
 * Родительский тип для поля выбора: служебный корень иерархии типов — это
 * «без родителя», а не вариант. Корень в каталог вариантов не попадает, и
 * комбо показал бы его сырой id чипом, поэтому значение корня нормализуется
 * в `null` (до плейсхолдера «без родителя»). Сброс в `null` сервер трактует
 * так же — как подвешивание прямо под корень.
 */
export function normalizeParentTypeId(
  parentId: string | null,
  rootId: string | null | undefined,
): string | null {
  if (parentId === null || rootId === null || rootId === undefined) return parentId;
  return parentId === rootId ? null : parentId;
}

/** Заголовок диалога «…» по виду выбираемой сущности (см. {@link buildEntityCombo}). */
const PICKER_TITLES: Record<Exclude<EntityKind, 'link-properties'>, string> = {
  'thought-types': 'Выбрать тип мысли',
  'link-types': 'Выбрать тип связи',
  thoughts: 'Выбрать мысль',
  publications: t('publications.field.pickerTitle'),
};

/** Заголовок диалога «…»: `override` вызывающего либо словарная подпись вида
 *  (свойство-связь — из словаря, требование fc00129d). */
function pickerTitleOf(kind: EntityKind, override?: string): string {
  if (override !== undefined) return override;
  return kind === 'link-properties' ? t('linkProperty.pickerTitle') : PICKER_TITLES[kind];
}

/**
 * Собирает встроенное комбо-поле пикера — единый компонент поля ОДИНОЧНОГО
 * выбора сущности (тип мысли, тип связи, мысль, свойство связи).
 *
 * Два состояния поля (ошибка ba2f57d3):
 *   - значение пусто — обычное поле ввода с живым поиском (общая выпадашка) и
 *     кареткой ▾ для полного списка;
 *   - значение заполнено — облачко выбранного лежит прямо в поле, строка
 *     ввода и каретка скрыты (ввод недоступен до очистки), крестик на облачке
 *     очищает значение и возвращает ввод.
 * В поле всегда есть компактная кнопка «…» — диалог выбора единственного
 * значения (`pickEntitiesModal` в одиночном режиме), как кнопка «выбрать» у
 * поля значения свойства-связи.
 *
 * Режим типов — дерево с отступами и раскрытием (`expandAll` раскрывает всё);
 * строки — те же облачка, что в модальном чек-листе (значок, цвета и
 * начертание из цепочки типов), у типа связи — свотч линии и подпись
 * «прямое / обратное». Режим свойств-связей — плоский список имён сторон с
 * парной подписью и значком конца связи (четвёртый источник, требование
 * cdb6b52f); пустое значение подписано словарём «без свойства». Каталог
 * отдаёт ЕДИНСТВЕННЫЙ источник общей выпадашки (пустой запрос — весь каталог
 * с учётом раскрытия, непустой — совпадения с цепочкой предков), поэтому
 * ручное открытие кареткой не рисует список дважды.
 */
export function buildEntityCombo(opts: EntityComboOptions): EntityCombo {
  let current = opts.value;
  /** Данные облачка текущего значения (для мыслей — из кандидата). */
  let currentCloud: ThoughtCloudInput | null = null;
  /** Полный список вариантов (для типов — каталог из store, перечитывается). */
  let allOptions: EntityOption[] = [];
  let byId = new Map<string, EntityOption>();
  /** Раскрытие узлов дерева: явный выбор пользователя (иначе — дефолт). */
  const expanded = new Map<string, boolean>();

  /** Перечитывает каталог на каждое открытие списка (realtime может принести
   *  каталог типов позже создания поля; строки свойств-связей — от вызывающего). */
  const reloadOptions = (): void => {
    if (opts.options !== undefined) {
      allOptions = opts.options();
    } else if (opts.kind === 'thought-types') {
      allOptions = thoughtTypeEntityOptions(store.state.thoughtTypes);
    } else if (opts.kind === 'link-types') {
      allOptions = linkTypeEntityOptions(store.state.linkTypes);
    } else if (opts.kind === 'link-properties') {
      allOptions = linkPropertyEntityOptions(opts.linkPropertyRows?.() ?? []);
    } else {
      // Мысли и публикации набираются живым поиском по серверу — каталога нет.
      allOptions = [];
    }
    byId = new Map(allOptions.map((o) => [o.id, o]));
  };
  reloadOptions();

  /** Эффективное раскрытие узла: явный выбор, иначе режим `expandAll`. */
  const isExpanded = (opt: EntityOption): boolean =>
    expanded.get(opt.id) ?? (opts.expandAll === true && opt.hasChildren === true);

  const root = div('entity-combo');
  // Поле — единая рамка (как у поля значения свойства-связи): облачко
  // выбранного лежит ВНУТРИ поля, а строка живого поиска показывается, только
  // пока значение пусто. Заполненное поле ввод не принимает — смена значения
  // идёт кнопкой «…» (диалог выбора единственного значения), очистка — «✕» на
  // облачке (ошибка ba2f57d3 «Неправильное поле ввода типа в редакторе мысли»).
  const field = div('st-f-chipfield entity-combo-field');
  const valueHost = div('entity-combo-value');
  const input = fieldInput({ extraClass: 'entity-combo-input' }) as HTMLInputElement;
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = opts.placeholder ?? '';
  input.disabled = opts.disabled === true;
  const caret = span('', 'type-combo-caret entity-combo-caret');
  caret.append(svgIcon('chevron-down', 12));
  const pickBtn = uiButton({
    label: '…',
    class: 'entity-combo-pick',
    title: pickerTitleOf(opts.kind, opts.pickerTitle),
    onClick: () => openPicker(),
  });
  field.append(valueHost, input, caret, pickBtn);
  root.append(field);

  /** Облачко выбранного значения (пусто — поле ввода без подписи). */
  const renderValue = (): void => {
    valueHost.replaceChildren();
    if (current === null) return;
    let opt = byId.get(current);
    // Каталог типов мог прийти позже создания поля (realtime). Заполненное
    // поле выпадашку не открывает, поэтому обновляем каталог здесь — иначе
    // значение рисовалось бы сырым id. Для мыслей и публикаций каталог
    // набирается живым поиском, перечитывать нечего.
    if (opt === undefined && opts.kind !== 'thoughts' && opts.kind !== 'publications') {
      reloadOptions();
      opt = byId.get(current);
    }
    // Мысль ищется на сервере по запросу и в каталог не попадает: облачко
    // начального значения догружаем резолвом (иначе чип показывал бы сырой id).
    if (currentCloud === null && opt === undefined && opts.kind === 'thoughts') {
      void etn.thoughts
        .resolve(opts.networkId, [current])
        .then((refs) => {
          const ref = refs[0];
          if (ref !== undefined && current === ref.id && currentCloud === null) {
            currentCloud = { ...ref };
            if (root.isConnected) renderValue();
          }
        })
        .catch(() => undefined);
    }
    // Публикация — тоже серверный поиск: облачко значения догружаем по id.
    if (currentCloud === null && opt === undefined && opts.kind === 'publications') {
      void resolvePublicationOptions(opts.networkId, [current])
        .then((options) => {
          const cloud = options[0]?.cloud;
          if (cloud !== undefined && current === cloud.id && currentCloud === null) {
            currentCloud = cloud;
            if (root.isConnected) renderValue();
          }
        })
        .catch(() => undefined);
    }
    const cloud = currentCloud ?? opt?.cloud ?? { id: current, title: opt?.title ?? current };
    valueHost.append(
      createThoughtCloud(cloud, {
        profile: 'chip',
        // Ширина — по полю значения диалога.
        width: 'container',
        actions:
          opts.disabled === true
            ? undefined
            : {
                onRemove: () => {
                  commitValue(null);
                },
              },
      }),
    );
  };

  const commitValue = (id: string | null): void => {
    if (opts.disabled === true) return;
    // Узел с фокусом сейчас исчезнет (крестик облачка) или скроется (строка
    // ввода заполненного поля) — запоминаем фокус, чтобы вернуть его живому
    // узлу поля, а не отдать браузеру на <body> (ошибка 797d0485).
    const hadFocus = hasKeyboardFocus(root);
    current = id;
    const opt = id !== null ? byId.get(id) : undefined;
    currentCloud = opt?.cloud ?? null;
    input.value = '';
    renderValue();
    renderMode();
    opts.onChange(id);
    opts.onChangeEntity?.(id === null ? null : opt ?? null);
    restoreKeyboardFocus(current !== null ? pickBtn : input, hadFocus);
  };

  /**
   * Показ поля по состоянию значения: пусто — строка живого поиска с
   * кареткой; заполнено — только облачко значения и кнопка «…», ввод
   * недоступен до очистки (требование ошибки ba2f57d3).
   */
  const renderMode = (): void => {
    const filled = current !== null;
    root.classList.toggle('entity-combo-filled', filled);
    valueHost.classList.toggle('hidden', !filled);
    input.classList.toggle('hidden', filled);
    caret.classList.toggle('hidden', filled);
    pickBtn.disabled = opts.disabled === true;
  };

  /**
   * Кнопка «…»: диалог выбора ЕДИНСТВЕННОГО значения. Каталог диалога — тот
   * же, что у живого поиска (свой `options()` у родительского пикера либо
   * строки свойств-связей), поэтому запрещённые варианты в диалоге не
   * предлагаются.
   */
  function openPicker(): void {
    if (opts.disabled === true) return;
    const catalogue =
      opts.options !== undefined
        ? opts.options()
        : opts.kind === 'link-properties'
          ? linkPropertyEntityOptions(opts.linkPropertyRows?.() ?? [])
          : undefined;
    void pickEntitiesModal({
      networkId: opts.networkId,
      kind: opts.kind,
      title: pickerTitleOf(opts.kind, opts.pickerTitle),
      single: true,
      ...(opts.searchTypeIds !== undefined ? { searchTypeIds: opts.searchTypeIds } : {}),
      ...(catalogue !== undefined ? { catalogue } : {}),
    }).then((ids) => {
      if (ids === null) return;
      commitValue(ids[0] ?? null);
    });
  }

  /**
   * Внешняя установка значения (см. {@link EntityCombo.setValue}): меняет
   * показанное значение, НЕ уведомляя владельца (`onChange` не зовётся) и не
   * трогая фокус — поле переиспользуется при смене сущности того же вида.
   */
  const setValue = (id: string | null): void => {
    current = id;
    const opt = id !== null ? byId.get(id) : undefined;
    currentCloud = opt?.cloud ?? null;
    input.value = '';
    renderValue();
    renderMode();
  };

  /** Строка выпадашки по варианту каталога: облачко типа (значок, цвета,
   *  начертание) либо, у свойства-связи, значок конца связи с парной подписью;
   *  отступ и тоггл — только у дерева типов. */
  const catalogueEntry = (opt: EntityOption): SuggestEntry => {
    const entry: SuggestEntry = {
      value: opt.id,
      label: opt.title,
      swatch: opt.line ?? null,
    };
    if (opt.cloud !== undefined) entry.thought = opt.cloud;
    if (opt.linkEnd != null) entry.linkEnd = opt.linkEnd;
    if (opt.note !== undefined) entry.note = opt.note;
    if (opt.depth !== undefined) entry.indent = typeRowIndentSteps(opt.depth);
    if (opt.hasChildren === true) {
      entry.toggle = {
        expanded: isExpanded(opt),
        onToggle: () => expanded.set(opt.id, !isExpanded(opt)),
      };
    }
    return entry;
  };

  /** Последний запрос, пришедший в источник (для строки «Создать новый»). */
  let lastQuery = '';

  const sources: SuggestSource[] = [];
  if (opts.kind !== 'thoughts' && opts.kind !== 'publications') {
    // Единственный источник на весь каталог: пустой запрос — весь список
    // (с учётом раскрытия), непустой — совпадения вместе с цепочкой предков.
    // Один источник — ручное открытие кареткой (force игнорирует `when`) не
    // рисует каталог дважды.
    sources.push({
      when: 'always',
      load: (query) => {
        if (opts.disabled === true) return [];
        reloadOptions();
        const q = query.trim().toLowerCase();
        const expandedIds = new Set(allOptions.filter(isExpanded).map((o) => o.id));
        const visible = visibleEntityIds(allOptions, q, expandedIds);
        const entries = allOptions
          .filter((o) => o.selectable !== false && visible.has(o.id))
          .map(catalogueEntry);
        const matchedCount =
          q === ''
            ? 0
            : allOptions.filter(
                (o) =>
                  o.title.toLowerCase().includes(q) ||
                  (o.searchText ?? '').toLowerCase().includes(q),
              ).length;
        if (
          opts.emptyLabel !== undefined &&
          (q === '' || opts.emptyLabel.toLowerCase().includes(q))
        ) {
          entries.unshift({ value: '', label: opts.emptyLabel, indent: 0 });
        }
        const createName = createRowName(query, matchedCount, opts.onCreateNew !== undefined);
        if (createName !== null) {
          entries.push({
            value: CREATE_ROW_ID,
            label: `Создать новый „${createName}“`,
            create: true,
            indent: 0,
          });
        }
        lastQuery = query;
        return entries;
      },
    });
  } else if (opts.kind === 'publications') {
    // Публикации: живой поиск по серверу (`GET /publications`), как у мыслей;
    // вариант — название с мини-обложкой (элемент интерфейса 9626efb6).
    // Порционный источник: скролл выпадашки вниз догружает страницу.
    const publicationEntries = (options: EntityOption[]): SuggestEntry[] =>
      options.map((opt) => {
        byId.set(opt.id, opt);
        const entry: SuggestEntry = { value: opt.id, label: opt.title };
        if (opt.cloud !== undefined) entry.thought = opt.cloud;
        return entry;
      });
    sources.push({
      when: 'typed',
      load: (query) => {
        if (opts.disabled === true) return [];
        return loadPublicationOptions(opts.networkId, query).then(publicationEntries);
      },
      loadMore: (query, offset) => {
        if (opts.disabled === true) return Promise.resolve([]);
        return loadPublicationOptions(opts.networkId, query, offset).then(publicationEntries);
      },
      pageSize: PUBLICATIONS_PAGE_SIZE,
    });
  } else {
    // Мысли: живой поиск по серверу; полный список без запроса невозможен.
    // Строка-мысль — облачком фабрики: DTO кандидата идёт в `thought`, визуал
    // (значок, цвета, начертание, бледность, корзина) резолвит фабрика (S1).
    sources.push({
      when: 'typed',
      load: (query) => {
        if (opts.disabled === true) return [];
        const typeIds = (opts.searchTypeIds ?? []).filter((id) => id !== '');
        const apply = (hits: DuplicateHit[]): SuggestEntry[] =>
          hits.map((hit) => {
            const opt = thoughtEntityOption(hit);
            byId.set(hit.id, opt);
            const entry: SuggestEntry = { value: hit.id, label: hit.title };
            if (opt.cloud !== undefined) entry.thought = opt.cloud;
            return entry;
          });
        // Охват — только текущая сеть (требование 79755f76, ошибка 81be082f):
        // цели внутрисетевых связей ищутся штатным findDuplicates, переключателя
        // охвата нет. Кросс-выбор живёт исключительно в редакторе
        // `cross_network_ref` (принудительный режим pickThoughtsDialog).
        // Id-запрос (полный/короткий) идёт прямым lookup — ошибка d8893a1f.
        return loadThoughtHits(opts.networkId, query, typeIds).then(apply);
      },
    });
  }

  // Набранный текст сам по себе значение не меняет — только явный выбор из
  // выпадашки; по потере фокуса строка поиска очищается. Поле принимает ввод
  // лишь пока значение пусто (иначе строка ввода скрыта).
  input.addEventListener('blur', () => {
    input.value = '';
  });
  field.addEventListener('click', (event) => {
    if (event.target === field && current === null && opts.disabled !== true) input.focus();
  });

  let handle: SuggestHandle | null = null;

  /** Запускает «Создать новый тип» по строке выпадашки. */
  const runCreate = async (query: string): Promise<void> => {
    if (opts.onCreateNew === undefined) return;
    let id: string | null = null;
    try {
      id = await opts.onCreateNew(query.trim());
    } catch {
      id = null; // неудачное создание ведёт себя как отказ
    }
    if (id !== null) {
      commitValue(id);
      return;
    }
    // Отказ: вернуть каретку в поле и снова открыть список с той же строкой.
    if (root.isConnected) {
      input.focus();
      handle?.open();
    }
  };

  handle = wireSuggest(input, {
    sources,
    minWidth: opts.dropdownMinWidth ?? 0,
    onPick: (entry) => {
      if (entry.value === CREATE_ROW_ID) {
        void runCreate(lastQuery);
        return;
      }
      if (entry.value === '') {
        commitValue(null);
        return;
      }
      commitValue(entry.value);
    },
  });

  // Каретка: открыть полный список, не забирая фокус из поля. Подпись
  // выбранного (или набранный текст) очищается, чтобы источник отдал весь
  // каталог, а не срез по случайному запросу.
  caret.addEventListener('mousedown', (event) => event.preventDefault());
  caret.addEventListener('click', () => {
    if (opts.disabled === true) return;
    input.value = '';
    handle?.open();
  });

  renderValue();
  renderMode();
  return {
    root,
    value: () => current,
    setValue,
    dispose: () => handle?.dispose(),
  };
}
