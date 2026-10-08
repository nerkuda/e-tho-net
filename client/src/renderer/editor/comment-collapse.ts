/**
 * Сворачивание разделов комментария (0.12.1, задачи 634f1412 и 1b405a92;
 * элемент интерфейса 826c4423, требования b482b36b и e04d84f7).
 *
 * **Что сворачивается.**
 * - Заголовки H1–H6 — своё содержимое до следующего заголовка того же или
 *   более высокого уровня.
 * - Вложенные блоки — под-списки (`ul`/`ol` внутри элемента списка или
 *   цитаты) и вложенные цитаты. Индикатор — у РОДИТЕЛЬСКОГО пункта (элемента
 *   списка/цитаты, под которым лежат сдвинутые вправо блоки); сворачивание
 *   скрывает сам вложенный блок целиком.
 *
 * **Где работает.** И в просмотре (HTML из `@etn/markdown`), и в
 * редактировании (live preview CodeMirror 6) — `decorateCommentView` и
 * `commentCollapseExtension` соответственно.
 *
 * **Индикатор и поле-гаттер (ошибка `ce8e9f67`).** Индикатор — кнопка-шеврон
 * из `lib/ui`, но размещается он НЕ в потоке строки, а в зарезервированной
 * пустой полосе слева от текста (гаттер, как поле под закладки в IDE). Текст
 * вправо не сдвигается: место зарезервировано ВСЕГДА, независимо от наличия
 * символа, а символ лишь появляется/исчезает в своей полосе.
 * - Правка: CM6-гаттер `gutter()` с зарезервированной шириной (маркеры —
 *   `CollapseGutterMarker` на строке-якоре раздела).
 * - Просмотр: полоса-гаттер `md-collapse-rail` внутри хоста
 *   (`md-collapse-host`): маркеры позиционируются в ней абсолютно, колонкой,
 *   на высоте своей строки. Полосы правки и просмотра совпадают по ширине и
 *   положению столбца (`--hit-area`).
 *
 * **Состояние** хранится ЛОКАЛЬНО на клиенте (localStorage, ключ
 * «сеть + владелец поля + раздел») и переживает переоткрытие поля; на сервер
 * не едет (требование b482b36b).
 *
 * Владелец поля — сущность-владелец комментария (мысль/связь/публикация), а
 * для записи хроно-комментария — сам комментарий (иначе все записи одной
 * мысли делили бы одно состояние свёрнутости). Осознанное уточнение ключа
 * требования b482b36b («мысль-владелец поля»): комментарий-владелец остаётся
 * частью идентичности поля.
 *
 * **Трансклюзии в разрезе контейнера (ТП2, задача `1b405a92`, требование
 * `e04d84f7`).** Блоки трансклюзий размечаются СОБСТВЕННЫМ состоянием на
 * каждый путь вставки: владелец состояния — «владелец поля (мысль-контейнер)
 * + путь вставки» (`#<источник>…#<источник>`, {@link
 * transclusionCollapseOwnerKey}). Поэтому сворачивание раздела в комментарии
 * Б, вставленном в А, не влияет на просмотр Б вне А. Внутри блока счётчики
 * разделов/вложенных блоков начинаются заново (свой namespace), а сами блоки
 * для внешней области — границы: их заголовки не участвуют в нумерации
 * контейнера. Блоки трансклюзий декорируются {@link decorateCommentView} с
 * фабрикой `factory` — в просмотре (обход `.md-transclusion`) и в правке
 * (виджет блока читает фабрику из {@link collapseScopeFacet}).
 *
 * **Текст блока трансклюзии (задача `73ae1d4b`).** В активном блоке текст живёт
 * во ВЛОЖЕННОМ редакторе (свой стек расширений, `editor/transclusion-nested.ts`)
 * — его свёрнутость это состояние самого инстанса, поля-контейнера она не
 * трогает. Прежний фасет диапазона правки блока удалён вместе с «растворением»
 * текста источника в контейнер.
 *
 * «Раздел» идентифицируется позиционно: `h{уровень}#{n}` — n-й по счёту
 * заголовок этого уровня в документе, `n#{m}` — m-й по счёту вложенный блок.
 * Нумеруются ВСЕ заголовки/вложенные блоки, даже те, чьё тело в просмотре
 * невидимо (тело из одного HTML-комментария): иначе нумерация разошлась бы с
 * редактором. Позиционные ключи одинаковы для обоих режимов одного и того же
 * текста и переживают переоткрытие; при правке текста выше раздела ключ может
 * сместиться (осознанный компромисс — семантический ключ по тексту разошёлся
 * бы между просмотром и правкой на inline-разметке).
 */

import { syntaxTree } from '@codemirror/language';
import {
  Facet,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  type DecorationSet,
} from '@codemirror/view';
import { TRANSCLUSION_BLOCK_CLASS, TRANSCLUSION_SOURCE_ATTR } from '@etn/markdown';

import { t } from '../lib/i18n.js';
import { iconButton } from '../lib/ui/button.js';
import { svgIcon } from '../lib/ui/icon.js';

/** Базовый класс кнопки-индикатора (общий для просмотра и правки). */
export const COLLAPSE_TOGGLE_CLASS = 'md-collapse-toggle';

/** Класс скрытого элемента в режиме просмотра. */
export const COLLAPSE_HIDDEN_CLASS = 'md-collapse-hidden';

/**
 * Класс хоста поля-гаттера в просмотре: резервирует полосу слева
 * (`padding-inline-start`) и служит системой координат для маркеров.
 */
export const COLLAPSE_HOST_CLASS = 'md-collapse-host';

/** Класс полосы-гаттера в просмотре: в ней колонкой лежат маркеры. */
export const COLLAPSE_RAIL_CLASS = 'md-collapse-rail';

/** Класс CM6-гаттера правки (маркеры разделов на строках-якорях). */
export const COLLAPSE_GUTTER_CLASS = 'cm-md-collapse-gutter';

// ---------------------------------------------------------------------------
// Локальное хранилище состояния (localStorage, на сервер не едет)
// ---------------------------------------------------------------------------

/** Ключ localStorage одного поля: сеть + владелец поля. */
export function commentCollapseStorageKey(networkId: string, ownerKey: string): string {
  return `comment.collapse.${networkId}.${ownerKey}`;
}

/** Разбирает сохранённый список свёрнутых разделов (только непустые строки). */
export function parseCollapsedIds(raw: string | null): string[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === 'string' && v !== '');
}

/** Сериализует набор свёрнутых разделов (в стабильном порядке). */
export function serializeCollapsedIds(ids: Iterable<string>): string {
  return JSON.stringify([...ids].sort());
}

/** localStorage за охраной: недоступен (Node-тесты, жёсткие контексты) → null. */
function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Состояние свёрнутости одного поля: память + локальный персист. Владелец
 * неизвестен (`ownerKey === undefined`) — состояние живёт только в памяти
 * поля (переоткрытие его не сохранит, на сервер не едет в любом случае).
 */
export interface CommentCollapseState {
  /** Свёрнут ли раздел. */
  isCollapsed(id: string): boolean;
  /** Переключает раздел (с записью в localStorage, когда владелец известен). */
  setCollapsed(id: string, collapsed: boolean): void;
  /** Снимок всех свёрнутых разделов (для инициализации поля редактора). */
  all(): string[];
}

/**
 * Ключ владельца состояния для блока трансклюзии: «владелец поля
 * (мысль-контейнер) + путь вставки» (требование `e04d84f7`). Путь — цепочка
 * мыслей-источников от контейнера до блока через `#` (`#B`, `#B#C`); пустой
 * путь — собственные разделы поля (владелец без расширения).
 */
export function transclusionCollapseOwnerKey(
  ownerKey: string,
  path: readonly string[],
): string {
  return path.length === 0 ? ownerKey : `${ownerKey}|${path.map((id) => `#${id}`).join('')}`;
}

/** Создаёт состояние свёрнутости поля. */
export function createCommentCollapseState(
  networkId: string,
  ownerKey: string | undefined,
): CommentCollapseState {
  const read = (): Set<string> => {
    if (ownerKey === undefined) return new Set();
    const ls = storage();
    if (ls === null) return new Set();
    try {
      return new Set(parseCollapsedIds(ls.getItem(commentCollapseStorageKey(networkId, ownerKey))));
    } catch {
      return new Set();
    }
  };
  const collapsed = read();
  const persist = (): void => {
    if (ownerKey === undefined) return;
    const ls = storage();
    if (ls === null) return;
    try {
      ls.setItem(
        commentCollapseStorageKey(networkId, ownerKey),
        serializeCollapsedIds(collapsed),
      );
    } catch {
      // Полное/недоступное хранилище — сворачивание не критичные данные.
    }
  };
  return {
    isCollapsed: (id) => collapsed.has(id),
    setCollapsed: (id, value) => {
      if (value) collapsed.add(id);
      else collapsed.delete(id);
      persist();
    },
    all: () => [...collapsed],
  };
}

/**
 * Фабрика производного состояния для блока трансклюзии: по пути вставки
 * (цепочке мыслей-источников) отдаёт состояние свёрнутости этого блока.
 */
export type CollapseScopeFactory = (path: readonly string[]) => CommentCollapseState;

/**
 * Фасет фабрики производных состояний: виджет блока трансклюзии в режиме
 * правки читает её из состояния редактора и декорирует своё содержимое с
 * состоянием своего пути вставки. Последнее значение — при нескольких.
 */
export const collapseScopeFacet = Facet.define<CollapseScopeFactory, CollapseScopeFactory | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

/** Расширение-носитель фабрики производных состояний (для `md-editor.ts`). */
export function collapseScopeExtension(factory: CollapseScopeFactory): Extension {
  return collapseScopeFacet.of(factory);
}

// ---------------------------------------------------------------------------
// Индикатор
// ---------------------------------------------------------------------------

/** Кнопка-индикатор свёрнутого узла (шеврон из lib/ui; поворот — CSS). */
function createToggleButton(collapsed: boolean, onToggle: () => void): HTMLButtonElement {
  const btn = iconButton({
    icon: svgIcon('chevron-down', 12),
    role: 'ghost',
    size: 's',
    title: collapsed ? t('comment.collapse.expand') : t('comment.collapse.collapse'),
    class: COLLAPSE_TOGGLE_CLASS,
    onClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      onToggle();
    },
  });
  btn.classList.toggle('is-collapsed', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  // Нажатие не должно уводить фокус/каретку: в правке кнопка живёт в гаттере
  // вне содержимого, в просмотре — поверх полосы-гаттера.
  btn.addEventListener('mousedown', (event) => event.preventDefault());
  return btn;
}

// ---------------------------------------------------------------------------
// Режим просмотра (HTML)
// ---------------------------------------------------------------------------

/** Тег заголовка H1–H6? */
function headingLevel(node: Element): number {
  const m = /^H([1-6])$/.exec(node.tagName.toUpperCase());
  return m === null ? 0 : Number(m[1]);
}

/** Обход элементов в порядке документа: узел, родитель, соседи и индекс. */
function walkElements(
  root: HTMLElement,
  visit: (node: HTMLElement, parent: HTMLElement, siblings: HTMLElement[], index: number) => void,
): void {
  const step = (parent: HTMLElement): void => {
    const siblings = Array.from(parent.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    siblings.forEach((child, index) => {
      visit(child, parent, siblings, index);
      step(child);
    });
  };
  step(root);
}

/** id мысли-источника блока трансклюзии (`data-transclusion-source`), либо `null`. */
function transclusionSourceId(node: HTMLElement): string | null {
  // Реальный DOM отдаёт camelCase-ключ `transclusionSource`; DOM-шим тестов
  // кладёт ещё и полное имя атрибута — читаем оба варианта.
  const ds = node.dataset as Record<string, string | undefined>;
  const id = ds['transclusionSource'] ?? ds[TRANSCLUSION_SOURCE_ATTR];
  return id === undefined || id === '' ? null : id;
}

/** Блок трансклюзии разметки `@etn/markdown` (граница области сворачивания). */
function isTransclusionBlock(node: HTMLElement): boolean {
  return node.classList.contains(TRANSCLUSION_BLOCK_CLASS) && transclusionSourceId(node) !== null;
}

/**
 * Обход элементов области сворачивания: как {@link walkElements}, но блоки
 * трансклюзий не раскрываются — они отдаются `onChild` (рекурсия с отдельным
 * состоянием) и НЕ участвуют в нумерации разделов текущей области.
 */
function walkScope(
  root: HTMLElement,
  visit: (node: HTMLElement, parent: HTMLElement, siblings: HTMLElement[], index: number) => void,
  onChild: (node: HTMLElement) => void,
): void {
  const step = (parent: HTMLElement): void => {
    const siblings = Array.from(parent.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    siblings.forEach((child, index) => {
      if (isTransclusionBlock(child)) {
        onChild(child);
        return;
      }
      visit(child, parent, siblings, index);
      step(child);
    });
  };
  step(root);
}

/** Родитель элемента (реальный DOM `parentElement`, шим тестов — `parent`). */
function parentOf(element: HTMLElement): HTMLElement | null {
  const node = element as unknown as {
    parentElement?: HTMLElement | null;
    parent?: HTMLElement | null;
  };
  return node.parentElement ?? node.parent ?? null;
}

/** Один сворачиваемый раздел просмотра: якорь индикатора и скрываемые элементы. */
interface ViewSection {
  id: string;
  /** Элемент, напротив первой строки которого встаёт маркер (заголовок или родительский пункт). */
  anchor: HTMLElement;
  hide: HTMLElement[];
}

/** Раздел просмотра вместе со своим состоянием, маркером и якорем. */
interface ViewRecord {
  id: string;
  state: CommentCollapseState;
  anchor: HTMLElement;
  button: HTMLButtonElement;
}

/** Отписка от наблюдения за переразметкой хоста (async-контент). */
const hostWatchers = new WeakMap<HTMLElement, () => void>();

/** Снимает прежнюю полосу-гаттер хоста и её наблюдение (идемпотентность). */
function removeRail(host: HTMLElement): void {
  hostWatchers.get(host)?.();
  hostWatchers.delete(host);
  for (const child of Array.from(host.children)) {
    if (child.classList.contains(COLLAPSE_RAIL_CLASS)) child.remove();
  }
}

/**
 * Навешивает сворачивание на отрендеренный HTML комментария. Идемпотентна:
 * прежние индикаторы и классы скрытия снимаются — функция вызывается на
 * каждом рендере просмотра.
 *
 * Индикаторы живут в полосе-гаттере (`md-collapse-rail`) абсолютными
 * элементами, колонкой, на высоте своей строки-якоря; хост резервирует под неё
 * `padding-inline-start` (`md-collapse-host`), поэтому текст вправо не сдвигается
 * (ошибка `ce8e9f67`). Маркеры не участвуют в потоке текста.
 *
 * `factory` (ТП2, требование `e04d84f7`) расширяет сворачивание на блоки
 * трансклюзий: каждый блок `.md-transclusion` получает собственное состояние
 * своего пути вставки (рекурсивно, счётчики разделов внутри начинаются заново),
 * а его заголовки не участвуют в нумерации объемлющей области. Без `factory`
 * блоки трансклюзий обрабатываются как обычное содержимое (поведение ТП1).
 * `basePath` — путь вставки текущей области от мысли-контейнера (для рекурсии).
 */
export function decorateCommentView(
  view: HTMLElement,
  state: CommentCollapseState,
  factory?: CollapseScopeFactory,
  basePath: readonly string[] = [],
): void {
  // Хост — корень поля: держит резервную полосу и служит системой координат
  // для маркеров всех областей (включая блоки трансклюзий) — одна колонка.
  const host = view;
  removeRail(host);

  // Идемпотентность: снять прежнюю разметку сворачивания во всём поддереве
  // (включая блоки трансклюзий — их разметку перестроит рекурсия ниже).
  const existing: HTMLElement[] = [];
  walkElements(host, (node) => existing.push(node));
  for (const node of existing) {
    if (node.classList.contains(COLLAPSE_TOGGLE_CLASS)) node.remove();
    else node.classList.remove(COLLAPSE_HIDDEN_CLASS);
  }

  host.classList.add(COLLAPSE_HOST_CLASS);
  const rail = document.createElement('div');
  rail.className = COLLAPSE_RAIL_CLASS;
  host.prepend(rail);

  /** Кто кого скрывает: элемент виден, пока не свёрнут ни один из его разделов. */
  const owners = new Map<HTMLElement, ViewRecord[]>();
  const records: ViewRecord[] = [];

  /** Якорь скрыт или лежит внутри скрытого элемента (маркер тоже прячем). */
  function isInsideHidden(element: HTMLElement): boolean {
    let current: HTMLElement | null = element;
    while (current !== null && current !== host) {
      if (current.classList.contains(COLLAPSE_HIDDEN_CLASS)) return true;
      current = parentOf(current);
    }
    return false;
  }

  /** Расставляет маркеры в полосе по высоте их якорей (координаты содержимого). */
  function relayout(): void {
    const hostRect = host.getBoundingClientRect();
    const scroll = host.scrollTop;
    for (const record of records) {
      const rect = record.anchor.getBoundingClientRect();
      const top = rect.top - hostRect.top + scroll;
      record.button.style.top = `${Math.round(top)}px`;
    }
  }

  /** Прячет тела свёрнутых разделов и обновляет вид/позицию маркеров. */
  function apply(): void {
    for (const [element, list] of owners) {
      element.classList.toggle(
        COLLAPSE_HIDDEN_CLASS,
        list.some((record) => record.state.isCollapsed(record.id)),
      );
    }
    for (const record of records) {
      const isCollapsed = record.state.isCollapsed(record.id);
      record.button.classList.toggle('is-collapsed', isCollapsed);
      record.button.setAttribute('aria-expanded', String(!isCollapsed));
      record.button.title = isCollapsed
        ? t('comment.collapse.expand')
        : t('comment.collapse.collapse');
      record.button.classList.toggle(COLLAPSE_HIDDEN_CLASS, isInsideHidden(record.anchor));
    }
    relayout();
  }

  const addSection = (
    section: ViewSection,
    sectionState: CommentCollapseState,
    scopeKey: string,
  ): void => {
    const btn = createToggleButton(sectionState.isCollapsed(section.id), () => {
      sectionState.setCollapsed(section.id, !sectionState.isCollapsed(section.id));
      apply();
    });
    btn.dataset.collapseId = section.id;
    // Ключ области сворачивания (путь вставки; пусто — своё поле): id разделов
    // позиционные и повторяются между блоками трансклюзий — различает их область.
    btn.dataset.collapseScope = scopeKey;
    // Двойной клик по индикатору не должен переводить поле в правку.
    btn.addEventListener('dblclick', (event) => event.stopPropagation());
    rail.append(btn);
    const record: ViewRecord = { id: section.id, state: sectionState, anchor: section.anchor, button: btn };
    records.push(record);
    for (const element of section.hide) {
      const list = owners.get(element);
      if (list === undefined) owners.set(element, [record]);
      else list.push(record);
    }
  };

  // Разделы одной области сворачивания (поле-контейнер или блок трансклюзии).
  const decorateScope = (
    scope: HTMLElement,
    scopeState: CommentCollapseState,
    path: readonly string[],
  ): void => {
    const headings: Array<{ node: HTMLElement; siblings: HTMLElement[]; index: number }> = [];
    const nestedBlocks: Array<{ block: HTMLElement; anchor: HTMLElement }> = [];
    const childBlocks: HTMLElement[] = [];
    const visit = (
      node: HTMLElement,
      parent: HTMLElement,
      siblings: HTMLElement[],
      index: number,
    ): void => {
      const level = headingLevel(node);
      if (level > 0) headings.push({ node, siblings, index });
      const tag = node.tagName.toUpperCase();
      const parentTag = parent.tagName.toUpperCase();
      if (
        (tag === 'UL' || tag === 'OL' || tag === 'BLOCKQUOTE') &&
        (parentTag === 'LI' || parentTag === 'BLOCKQUOTE')
      ) {
        // Индикатор — у РОДИТЕЛЬСКОГО пункта, под которым лежит вложенный блок
        // (ошибка 6007a6ec); сворачивание скрывает сам вложенный блок.
        nestedBlocks.push({ block: node, anchor: parent });
      }
    };
    if (factory === undefined) walkElements(scope, visit);
    else walkScope(scope, visit, (child) => childBlocks.push(child));

    // Заголовки: тело — сиблинги до следующего заголовка того же/высшего уровня.
    // Идентификатор присваивается КАЖДОМУ заголовку (счётчик уровня растёт всегда),
    // даже когда видимого тела нет (например, тело — только HTML-комментарий,
    // невидимый в просмотре): иначе нумерация разошлась бы с редактором, который
    // считает телом строку комментария, и id указывал бы на разные разделы.
    const levelCounters = new Map<number, number>();
    for (const { node, siblings, index } of headings) {
      const level = headingLevel(node);
      const n = (levelCounters.get(level) ?? 0) + 1;
      levelCounters.set(level, n);
      const hide: HTMLElement[] = [];
      for (const sib of siblings.slice(index + 1)) {
        const sibLevel = headingLevel(sib);
        if (sibLevel !== 0 && sibLevel <= level) break;
        hide.push(sib);
      }
      if (hide.length === 0) continue; // сворачивать нечего (id всё равно присвоен)
      addSection({ id: `h${level}#${n}`, anchor: node, hide }, scopeState, path.join('#'));
    }

    // Вложенные блоки: один РОДИТЕЛЬСКИЙ пункт может держать несколько
    // вложенных блоков — на него ставится РОВНО ОДИН индикатор (дедуп по
    // якорю, как в правке), который скрывает ВСЕ эти блоки. Иначе маркеры
    // перекрылись бы в одной точке (коллизия якоря).
    const nestedByAnchor = new Map<HTMLElement, HTMLElement[]>();
    for (const { block, anchor } of nestedBlocks) {
      const list = nestedByAnchor.get(anchor);
      if (list === undefined) nestedByAnchor.set(anchor, [block]);
      else list.push(block);
    }
    let nested = 0;
    for (const [anchor, blocks] of nestedByAnchor) {
      nested += 1;
      addSection({ id: `n#${nested}`, anchor, hide: blocks }, scopeState, path.join('#'));
    }

    // Блоки трансклюзий — своё состояние на каждый путь вставки (требование
    // e04d84f7): рекурсия декорирует блок отдельной областью, счётчики разделов
    // внутри начинаются заново, а их заголовки не считались внешней областью.
    if (factory !== undefined) {
      for (const block of childBlocks) {
        const sourceId = transclusionSourceId(block);
        if (sourceId === null) continue;
        const childPath = [...path, sourceId];
        decorateScope(block, factory(childPath), childPath);
      }
    }
  };

  decorateScope(view, state, basePath);
  apply();

  // Переразметка при асинхронном изменении содержимого (mermaid, картинки):
  // высоты якорей меняются — маркеры пересчитываются в следующем кадре и по
  // мутациям поддерева (childList; правки стилей маркеров наблюдателя не будят).
  const offs: Array<() => void> = [];
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
    .requestAnimationFrame;
  if (typeof raf === 'function') {
    const frame = raf(() => relayout());
    const cancel = (globalThis as { cancelAnimationFrame?: (id: number) => void })
      .cancelAnimationFrame;
    if (typeof cancel === 'function') offs.push(() => cancel(frame));
  }
  const MutationObserverCtor = (globalThis as { MutationObserver?: typeof MutationObserver })
    .MutationObserver;
  if (typeof MutationObserverCtor === 'function') {
    const observer = new MutationObserverCtor(() => relayout());
    observer.observe(host, { childList: true, subtree: true });
    offs.push(() => observer.disconnect());
  }
  hostWatchers.set(host, () => {
    for (const off of offs) off();
  });
}

// ---------------------------------------------------------------------------
// Режим редактирования (CodeMirror 6, live preview)
// ---------------------------------------------------------------------------

/** Эффект переключения свёрнутости раздела. */
export const setCollapseEffect = StateEffect.define<{ id: string; collapsed: boolean }>();

/**
 * Эффект перерисовки декораций без изменения набора контейнера: переключение
 * раздела области трансклюзии пишет в её собственное состояние (фабрика), а
 * editor-field о таком изменении не знает — этот эффект заставляет пересобрать
 * декорации и перечитать производное состояние.
 */
export const refreshCollapseEffect = StateEffect.define<null>();

/** Набор свёрнутых разделов (единственный источник для декораций). */
const collapseSetField = StateField.define<Set<string>>({
  create: () => new Set(),
  update: (value, tr) => {
    let next = value;
    for (const effect of tr.effects) {
      if (!effect.is(setCollapseEffect)) continue;
      next = new Set(next);
      if (effect.value.collapsed) next.add(effect.value.id);
      else next.delete(effect.value.id);
    }
    return next;
  },
});

/** Скрытый диапазон тела свёрнутого раздела. */
export interface CollapsedRange {
  from: number;
  to: number;
}

interface CollapseDecoState {
  setRef: Set<string> | null;
  ranges: CollapsedRange[];
  deco: DecorationSet;
  /** Маркеры гаттера: точка-индикатор на строке-якоре каждого раздела. */
  markers: RangeSet<GutterMarker>;
}

/** Раздел редактора: позиция индикатора и диапазон скрываемого тела. */
interface EditorSection {
  id: string;
  anchorFrom: number;
  bodyFrom: number;
  bodyTo: number;
  /**
   * Путь вставки области, которой принадлежит раздел: `null` — собственные
   * разделы поля-контейнера, массив — блок трансклюзии (правка блока).
   * Определяет, в какое состояние пишется свёртка.
   */
  path: readonly string[] | null;
}

/** Заголовок раздела дерева синтаксиса (сырые координаты). */
interface RawHeading {
  level: number;
  from: number;
  to: number;
}

/** Вложенный блок дерева синтаксиса (сырые координаты). */
interface RawBlock {
  from: number;
  to: number;
  /** Позиция родительского пункта (ListItem/Blockquote) — строка-якорь индикатора. */
  anchorFrom: number;
}

/** Минимум узла дерева, нужный поиску родителя (SyntaxNode подходит). */
interface TreeNodeLike {
  name: string;
  from: number;
  parent: TreeNodeLike | null;
}

/**
 * Ближайший родительский пункт блочного узла — `ListItem` или `Blockquote`
 * (ошибка `6007a6ec`): индикатор сворачивания вложенного блока встаёт у НЕГО,
 * а не у первой строки самого вложенного списка/цитаты. `null` — узел не
 * вложен (до `Document` не встретилось ни списка, ни цитаты).
 */
function enclosingItem(node: { parent: TreeNodeLike | null }): TreeNodeLike | null {
  let current: TreeNodeLike | null = node.parent;
  while (current !== null) {
    if (current.name === 'Document') return null;
    if (current.name === 'ListItem' || current.name === 'Blockquote') return current;
    current = current.parent;
  }
  return null;
}

/**
 * Собирает разделы одного namespace (набор заголовков + вложенных блоков) с
 * общими позиционными счётчиками; `boundTo` ограничивает документ справа,
 * `obstacles` — позиции, за которые тело раздела не заходит (границы области
 * трансклюзии для собственных разделов контейнера). `path` — чей namespace:
 * `null` — поле-контейнер.
 */
function buildSections(
  doc: Text,
  headings: readonly RawHeading[],
  blocks: readonly RawBlock[],
  boundTo: number,
  path: readonly string[] | null,
  obstacles: readonly { from: number }[],
): EditorSection[] {
  const sections: EditorSection[] = [];

  // Заголовки: тело — строки до начала строки следующего заголовка не выше
  // уровнем (в этом же namespace). Счётчик уровня растёт для КАЖДОГО заголовка
  // — в паре с просмотром, который тоже нумерует все заголовки
  // (см. decorateCommentView): иначе id разошлись бы на заголовке с невидимым
  // в просмотре телом (HTML-комментарий).
  const levelCounters = new Map<number, number>();
  headings.forEach((heading, index) => {
    const n = (levelCounters.get(heading.level) ?? 0) + 1;
    levelCounters.set(heading.level, n);
    let end = boundTo;
    for (let j = index + 1; j < headings.length; j += 1) {
      if ((headings[j]?.level ?? 0) <= heading.level) {
        end = doc.lineAt(headings[j]!.from).from;
        break;
      }
    }
    // Тело не заходит за границы области (текст блока — граница разделов поля).
    for (const obstacle of obstacles) {
      if (obstacle.from > heading.to && obstacle.from < end) end = obstacle.from;
    }
    const bodyFrom = doc.lineAt(heading.to).to + 1;
    if (bodyFrom >= end) return; // тело пустое — сворачивать нечего (id присвоен)
    const lastLine = doc.lineAt(end - 1);
    const bodyTo = lastLine.to;
    if (bodyTo <= bodyFrom) return;
    sections.push({
      id: `h${heading.level}#${n}`,
      anchorFrom: doc.lineAt(heading.from).from,
      bodyFrom,
      bodyTo,
      path,
    });
  });

  // Вложенные блоки: индикатор — у строки РОДИТЕЛЬСКОГО пункта, под которым
  // лежат блоки (ошибка 6007a6ec). У одного пункта может быть НЕСКОЛЬКО
  // вложенных блоков (под-список и цитата и т.п.) — на пункт ставится РОВНО
  // ОДИН индикатор (дедуп по строке-якорю), который скрывает объединение тел
  // всех этих блоков. Иначе несколько маркеров встали бы в одну точку и
  // перекрылись бы / залезли на текст (коллизия якоря).
  const nestedByAnchor = new Map<number, { bodyFrom: number; bodyTo: number }>();
  for (const block of blocks) {
    const anchorFrom = doc.lineAt(block.anchorFrom).from;
    const bodyFrom = doc.lineAt(block.from).from;
    const bodyTo = doc.lineAt(block.to).to;
    if (bodyTo <= bodyFrom) continue;
    const existing = nestedByAnchor.get(anchorFrom);
    if (existing === undefined) {
      nestedByAnchor.set(anchorFrom, { bodyFrom, bodyTo });
    } else {
      existing.bodyFrom = Math.min(existing.bodyFrom, bodyFrom);
      existing.bodyTo = Math.max(existing.bodyTo, bodyTo);
    }
  }
  let nested = 0;
  for (const [anchorFrom, body] of nestedByAnchor) {
    nested += 1;
    sections.push({ id: `n#${nested}`, anchorFrom, bodyFrom: body.bodyFrom, bodyTo: body.bodyTo, path });
  }

  return sections;
}

/** Собирает сворачиваемые разделы документа по дереву синтаксиса. */
function collectSections(state: EditorState): EditorSection[] {
  const doc = state.doc;
  const containerHeadings: RawHeading[] = [];
  const containerBlocks: RawBlock[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      const name = node.name;
      if (/^ATXHeading[1-6]$/.test(name) || /^SetextHeading[12]$/.test(name)) {
        containerHeadings.push({ level: Number(name.slice(-1)), from: node.from, to: node.to });
        return;
      }
      if (name === 'BulletList' || name === 'OrderedList' || name === 'Blockquote') {
        const parent = enclosingItem(node.node);
        if (parent === null) return;
        containerBlocks.push({ from: node.from, to: node.to, anchorFrom: parent.from });
      }
    },
  });

  return buildSections(doc, containerHeadings, containerBlocks, doc.length, null, []).sort(
    (a, b) => a.bodyFrom - b.bodyFrom,
  );
}

/**
 * Маркер гаттера правки: кнопка-индикатор раздела на строке-якоре. Живёт в
 * CM6-гаттере (вне потока текста), поэтому текст вправо не сдвигается
 * (ошибка `ce8e9f67`).
 */
class CollapseGutterMarker extends GutterMarker {
  constructor(
    readonly id: string,
    readonly collapsed: boolean,
    /** Путь вставки области: `null` — своё поле, массив — блок трансклюзии. */
    readonly path: readonly string[] | null = null,
  ) {
    super();
  }

  override eq(other: CollapseGutterMarker): boolean {
    return (
      other.id === this.id &&
      other.collapsed === this.collapsed &&
      samePath(other.path, this.path)
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const factory = view.state.facet(collapseScopeFacet);
    const btn = createToggleButton(this.collapsed, () => {
      // Раздел области трансклюзии пишет в своё производное состояние (состояние
      // поля-контейнера не трогаем); декорации пересобирает refresh-эффект.
      if (this.path !== null) {
        if (factory === null) return;
        const state = factory(this.path);
        state.setCollapsed(this.id, !state.isCollapsed(this.id));
        view.dispatch({ effects: refreshCollapseEffect.of(null) });
        return;
      }
      view.dispatch({
        effects: setCollapseEffect.of({ id: this.id, collapsed: !this.collapsed }),
      });
    });
    btn.dataset.collapseId = this.id;
    return btn;
  }
}

/** Совпадают ли пути вставки двух разделов. */
function samePath(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Строит декорации (скрытые тела) и маркеры гаттера для текущего состояния. */
function buildDecorations(state: EditorState): CollapseDecoState {
  const collapsed = state.field(collapseSetField);
  const factory = state.facet(collapseScopeFacet);
  const ranges: CollapsedRange[] = [];
  const parts: Array<Range<Decoration>> = [];
  const markerParts: Array<Range<GutterMarker>> = [];

  // Производные состояния областей трансклюзий — по одной на путь вставки.
  const scopedStates = new Map<string, CommentCollapseState>();
  const scopedState = (path: readonly string[]): CommentCollapseState | null => {
    if (factory === null) return null;
    const key = path.join('#');
    let scoped = scopedStates.get(key);
    if (scoped === undefined) {
      scoped = factory(path);
      scopedStates.set(key, scoped);
    }
    return scoped;
  };
  const isCollapsed = (section: EditorSection): boolean =>
    section.path === null
      ? collapsed.has(section.id)
      : (scopedState(section.path)?.isCollapsed(section.id) ?? false);

  for (const section of collectSections(state)) {
    // Раздел внутри тела уже свёрнутого раздела скрыт родителем — не строим.
    if (ranges.some((r) => section.anchorFrom >= r.from && section.anchorFrom < r.to)) continue;
    const sectionCollapsed = isCollapsed(section);
    // Индикатор — маркер гаттера на строке-якоре (вне потока текста).
    markerParts.push(
      new CollapseGutterMarker(section.id, sectionCollapsed, section.path).range(
        section.anchorFrom,
      ),
    );
    if (sectionCollapsed) {
      ranges.push({ from: section.bodyFrom, to: section.bodyTo });
      parts.push(Decoration.replace({ block: true }).range(section.bodyFrom, section.bodyTo));
    }
  }

  return {
    setRef: collapsed,
    ranges,
    deco: Decoration.set(parts, true),
    markers: RangeSet.of(markerParts, true),
  };
}

/** Поле декораций сворачивания (также отдаёт диапазоны скрытых тел). */
const collapseDecoField = StateField.define<CollapseDecoState>({
  create: (state) => buildDecorations(state),
  update: (value, tr) => {
    const current = tr.state.field(collapseSetField);
    // Пересборка: правка документа (в т.ч. вход/выход из правки блока), смена
    // набора контейнера либо refresh-эффект производной области трансклюзии.
    const refreshed = tr.effects.some((effect) => effect.is(refreshCollapseEffect));
    if (!tr.docChanged && current === value.setRef && !refreshed) return value;
    return buildDecorations(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field, (state) => state.deco),
});

/**
 * Точка в скрытом диапазоне? Нужна live preview (`md-live.ts`): внутри
 * заменённого тела декорации ставить нельзя — они пересекут замену.
 */
export function isCollapsedHiddenAt(state: EditorState, pos: number): boolean {
  const value = state.field(collapseDecoField, false);
  if (value === undefined) return false;
  return value.ranges.some((r) => pos >= r.from && pos < r.to);
}

/**
 * Гаттер правки: зарезервированная слева полоса, в которой колонкой стоят
 * маркеры-индикаторы разделов (ошибка `ce8e9f67`). Маркеры берутся из поля
 * декораций — при смене набора свёрнутых (или refresh-эффекте) поле
 * пересобирается, и гаттер перерисовывает элементы.
 */
function commentCollapseGutter(): Extension {
  return gutter({
    class: COLLAPSE_GUTTER_CLASS,
    markers: (view) => view.state.field(collapseDecoField).markers,
  });
}

/**
 * Расширение редактора: набор свёрнутых разделов поля (инициализируется из
 * локального состояния) плюс запись переключений в то же состояние.
 */
export function commentCollapseExtension(state: CommentCollapseState): Extension {
  return [
    collapseSetField.init(() => new Set(state.all())),
    collapseDecoField,
    commentCollapseGutter(),
    EditorView.updateListener.of((update) => {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (!effect.is(setCollapseEffect)) continue;
          state.setCollapsed(effect.value.id, effect.value.collapsed);
        }
      }
    }),
  ];
}

/** Тестовый шов: разбор разделов и поле декораций редактора. */
export const commentCollapseInternals = { collectSections, collapseDecoField };

/* ---------------------------------------------------------------------------
 * Сворачивание раздела под кареткой (задача 558cac34).
 * ------------------------------------------------------------------------- */

/** Режим команды сворачивания/разворачивания раздела под кареткой. */
export type CollapseToggleMode = 'fold' | 'unfold' | 'toggle';

/**
 * Раздел под кареткой: среди разделов, содержащих позицию (строка-якорь или
 * тело), — самый вложенный (наибольший `anchorFrom`). `null` — сворачиваемого
 * раздела под кареткой нет.
 */
function sectionAtCaret(state: EditorState, pos: number): EditorSection | null {
  let found: EditorSection | null = null;
  for (const section of collectSections(state)) {
    if (pos < section.anchorFrom || pos > section.bodyTo) continue;
    if (found === null || section.anchorFrom > found.anchorFrom) found = section;
  }
  return found;
}

/** Свёрнут ли раздел: поле-контейнер — по своему полю, блок — по своему пути. */
function isSectionCollapsed(state: EditorState, section: EditorSection): boolean {
  if (section.path === null) return state.field(collapseSetField).has(section.id);
  const factory = state.facet(collapseScopeFacet);
  return factory?.(section.path)?.isCollapsed(section.id) ?? false;
}

/** Целевое состояние раздела по режиму команды. */
function targetCollapsed(mode: CollapseToggleMode, current: boolean): boolean {
  if (mode === 'fold') return true;
  if (mode === 'unfold') return false;
  return !current;
}

/**
 * Сворачивает/разворачивает раздел (заголовок H1–H6 или родительский пункт
 * вложенного блока) под кареткой. `fold` — свернуть, `unfold` — развернуть,
 * `toggle` — переключить. Возвращает `false` как no-op, если под кареткой нет
 * сворачиваемого раздела либо расширение сворачивания к редактору не подключено
 * (поле другого вида) — падения/порчи состояния не допускается.
 */
export function toggleCollapseAtCaret(view: EditorView, mode: CollapseToggleMode): boolean {
  const state = view.state;
  if (state.field(collapseSetField, false) === undefined) return false;
  const section = sectionAtCaret(state, state.selection.main.head);
  if (section === null) return false;
  const next = targetCollapsed(mode, isSectionCollapsed(state, section));
  if (section.path === null) {
    view.dispatch({ effects: setCollapseEffect.of({ id: section.id, collapsed: next }) });
    return true;
  }
  // Раздел блока трансклюзии пишет в своё производное состояние (состояние
  // поля-контейнера не трогаем); декорации пересобирает refresh-эффект — как
  // у кнопки-маркера гаттера (ошибка 4204e34c).
  const factory = state.facet(collapseScopeFacet);
  if (factory === null) return false;
  factory(section.path).setCollapsed(section.id, next);
  view.dispatch({ effects: refreshCollapseEffect.of(null) });
  return true;
}
