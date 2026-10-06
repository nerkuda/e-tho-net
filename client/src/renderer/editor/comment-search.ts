/**
 * Панель поиска и замены в поле комментария (0.12.1, задача 045f98db, ТП1
 * «Команды редактирования комментария»).
 *
 * Элемент интерфейса «Панель поиска и замены в поле комментария» (`b8eabc22`),
 * требование «Поиск в поле комментария — в обоих режимах, замена — только в
 * редактировании» (`d72ea6eb`):
 *  - `Ctrl+F` — открыть поиск (и в просмотре, и в правке);
 *  - `Ctrl+H` — открыть замену (только правка);
 *  - `F3` / `Shift+F3` (и `Enter` / `Shift+Enter` в панели) — вперёд/назад,
 *    закольцовано;
 *  - вхождения подсвечиваются в обоих режимах; в просмотре подсветка не
 *    затрагивает виджеты wiki-ссылок (их текст исключается из поиска);
 *  - регулярные выражения не поддерживаются (граница ТП1).
 *
 * Поиск в правке идёт по тексту документа CM6 (подсветка — декорациями
 * редактора), в просмотре — по склеенному тексту HTML с отображением на узлы
 * и подсветкой через CSS Custom Highlight API (без изменения DOM — виджеты
 * не трогаются). Числовые преобразования — в чистом `./text-search.ts`.
 *
 * Сочетания панели — на общеклиентском диспетчере `lib/keymap.ts` (ADR
 * `b420b08c`), контекст `comment-search` кладётся поверх стека, пока фокус в
 * панели: иначе команды форматирования срабатывали бы прямо из поля поиска.
 */

import { div, span } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { defineKeyContext, pushKeyContext, type KeyBindingDef } from '../lib/keymap.js';
import { iconButton, uiButton } from '../lib/ui/button.js';
import { fieldInput } from '../lib/ui/field.js';
import { renderIcon } from '../lib/ui/icon.js';
import type { MdEditor } from './md-editor.js';
import {
  buildSearchTextMap,
  findMatches,
  mapMatches,
  type TextMatch,
} from './text-search.js';

/** Класс корня панели (вид — `styles/editor.css`). */
export const SEARCH_PANEL_CLASS = 'md-field-search';
/** Идентификатор контекста сочетаний панели поиска. */
export const COMMENT_SEARCH_CONTEXT_ID = 'comment-search';

/** Режим панели: только поиск или поиск с заменой. */
export type CommentSearchMode = 'find' | 'replace';

/** Полуинтервал узла просмотра, подсвечиваемый в панели. */
export interface SearchHighlightPort {
  /** Показать все вхождения и (при наличии) текущее. */
  set(ranges: Range[], current: Range | null): void;
  /** Снять подсветку. */
  clear(): void;
}

/* ------------------------------------------------------------------ *
 * Подсветка просмотра: CSS Custom Highlight API.
 * ------------------------------------------------------------------ */

const HIGHLIGHT_NAME = 'etn-md-search';
const CURRENT_HIGHLIGHT_NAME = 'etn-md-search-current';

interface HighlightCtor {
  new (...ranges: AbstractRange[]): unknown;
}

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

/**
 * Порты подсветки по умолчанию: CSS Custom Highlight API (Chromium/Electron).
 * API нет — подсветка просто не показывается (поиск и навигация работают).
 */
function defaultHighlightPort(): SearchHighlightPort {
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS?.highlights;
  const HighlightCtor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  if (registry === undefined || HighlightCtor === undefined) {
    return { set: () => undefined, clear: () => undefined };
  }
  return {
    set: (ranges, current) => {
      if (ranges.length === 0) {
        registry.delete(HIGHLIGHT_NAME);
      } else {
        registry.set(HIGHLIGHT_NAME, new HighlightCtor(...ranges));
      }
      if (current === null) registry.delete(CURRENT_HIGHLIGHT_NAME);
      else registry.set(CURRENT_HIGHLIGHT_NAME, new HighlightCtor(current));
    },
    clear: () => {
      registry.delete(HIGHLIGHT_NAME);
      registry.delete(CURRENT_HIGHLIGHT_NAME);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Исключения просмотра: виджеты wiki-ссылок (требование d72ea6eb).
 * ------------------------------------------------------------------ */

const EXCLUDED_SEARCH_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT']);
const WIKI_WIDGET_CLASSES = ['wiki-link', 'wiki-link-missing'];
const WIKI_WIDGET_ATTRS = ['data-wiki-id', 'data-wiki-target', 'data-wiki-network'];

/**
 * Элемент просмотра, чей текст не участвует в поиске: скрипты/стили и
 * виджеты wiki-ссылок (имена мыслей в ссылках не подсвечиваются).
 */
export function isExcludedSearchElement(el: Element): boolean {
  if (EXCLUDED_SEARCH_TAGS.has(el.tagName.toUpperCase())) return true;
  if (WIKI_WIDGET_CLASSES.some((cls) => el.classList.contains(cls))) return true;
  return WIKI_WIDGET_ATTRS.some((attr) => el.hasAttribute(attr));
}

/** Теги блочных контейнеров — граница склейки текста просмотра. */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY',
  'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

interface CollectedNode {
  id: number;
  node: Text;
  block: number;
}

/** Ближайший блочный предок — ключ склейки (создаётся лениво). */
function blockKeyOf(el: Element | null, ids: Map<Element, number>, root: Element): number {
  let current: Element | null = el;
  while (current !== null) {
    if (BLOCK_TAGS.has(current.tagName.toUpperCase())) {
      const existing = ids.get(current);
      if (existing !== undefined) return existing;
      const id = ids.size;
      ids.set(current, id);
      return id;
    }
    if (current === root) break;
    current = current.parentElement;
  }
  return -1;
}

/** Текстовые узлы просмотра без виджетов wiki-ссылок и служебных тегов. */
function collectSearchNodes(view: HTMLElement): CollectedNode[] {
  const doc = view.ownerDocument;
  const collected: CollectedNode[] = [];
  const blockIds = new Map<Element, number>();
  let nextId = 0;
  const walker = doc.createTreeWalker(view, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return isExcludedSearchElement(node as Element)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node !== null) {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      collected.push({
        id: nextId,
        node: textNode,
        block: blockKeyOf(textNode.parentElement, blockIds, view),
      });
      nextId += 1;
    }
    node = walker.nextNode();
  }
  return collected;
}

/** Диапазоны вхождений запроса в тексте просмотра. */
export function collectViewRanges(view: HTMLElement, query: string): Range[] {
  const collected = collectSearchNodes(view);
  const map = buildSearchTextMap(
    collected.map((entry) => ({ id: entry.id, text: entry.node.data, block: entry.block })),
  );
  const byId = new Map(collected.map((entry) => [entry.id, entry.node]));
  const ranges: Range[] = [];
  for (const match of mapMatches(map, query)) {
    const startNode = byId.get(match.start.id);
    const endNode = byId.get(match.end.id);
    if (startNode === undefined || endNode === undefined) continue;
    const range = view.ownerDocument.createRange();
    range.setStart(startNode, match.start.offset);
    range.setEnd(endNode, match.end.offset);
    ranges.push(range);
  }
  return ranges;
}

/** Прокручивает просмотр к диапазону совпадения. */
function scrollRange(range: Range): void {
  const container = range.startContainer;
  const element =
    container.nodeType === Node.ELEMENT_NODE
      ? (container as Element)
      : container.parentElement;
  element?.scrollIntoView({ block: 'center' });
}

/* ------------------------------------------------------------------ *
 * Опции и результат фабрики.
 * ------------------------------------------------------------------ */

/** Опции панели поиска поля комментария. */
export interface CommentSearchOptions {
  /** Корень поля — панель вставляется в него. */
  root: HTMLElement;
  /** Узел просмотра (HTML) — источник текста в режиме просмотра. */
  view: HTMLElement;
  /** Действующий редактор правки, либо `null` (поле в просмотре). */
  getEditor: () => MdEditor | null;
  /** Поле сейчас в режиме правки. */
  isEditing: () => boolean;
  /** Вернуть фокус полю после закрытия панели. */
  restoreFocus: () => void;
  /** Тестовый шов подсветки просмотра. */
  highlightPort?: SearchHighlightPort;
}

/** Управление панелью поиска поля комментария. */
export interface CommentSearch {
  /** Корень панели — вставляется в поле потребителем. */
  readonly element: HTMLElement;
  /** Открыть панель в режиме поиска или замены (замена деградирует к поиску в просмотре). */
  open(mode: CommentSearchMode): void;
  /** Закрыть панель и снять подсветку. */
  close(): void;
  isOpen(): boolean;
  /** Пересобрать совпадения после смены режима/содержимого. */
  refresh(): void;
  /** Следующее вхождение (закольцовано). */
  next(): boolean;
  /** Предыдущее вхождение (закольцовано). */
  previous(): boolean;
  /** Фокус на поле «Найти» (Ctrl+F внутри панели). */
  focusFind(): void;
  /** Переключить на строку замены (Ctrl+H внутри панели). */
  openReplace(): void;
  /** Фокус пришёл в панель — включить её контекст сочетаний. */
  enterKeys(): void;
  /** Фокус ушёл из панели — снять её контекст сочетаний. */
  leaveKeys(): void;
  destroy(): void;
}

/* ------------------------------------------------------------------ *
 * Контекст сочетаний панели.
 * ------------------------------------------------------------------ */

/** Минимум панели, нужный контексту сочетаний (и тестовому шву). */
export interface CommentSearchKeys {
  focusFind(): void;
  openReplace(): void;
  next(): boolean;
  previous(): boolean;
  close(): void;
}

let activeSearchKeys: CommentSearchKeys | null = null;
let searchKeysRelease: (() => void) | null = null;

/** Привязки контекста панели: маршрутизируются активной панели. */
function searchKeyBindings(): KeyBindingDef[] {
  const route = (run: (api: CommentSearchKeys) => void): (() => boolean) => () => {
    if (activeSearchKeys !== null) run(activeSearchKeys);
    return true;
  };
  return [
    { command: 'comment.find', chord: 'Ctrl+F', run: route((api) => api.focusFind()) },
    { command: 'comment.replace', chord: 'Ctrl+H', run: route((api) => api.openReplace()) },
    { command: 'comment.findNext', chord: 'F3', run: route((api) => api.next()) },
    { command: 'comment.findPrevious', chord: 'Shift+F3', run: route((api) => api.previous()) },
    { command: 'comment.searchNext', chord: 'Enter', run: route((api) => api.next()) },
    { command: 'comment.searchPrevious', chord: 'Shift+Enter', run: route((api) => api.previous()) },
    { command: 'comment.searchClose', chord: 'Escape', run: route((api) => api.close()) },
  ];
}

/**
 * Включает контекст панели: панель становится текущим элементом. Вызывается
 * при попадании фокуса в панель. Возвращаемая функция — снятие (leaveKeys).
 */
export function enterCommentSearchKeys(api: CommentSearchKeys): void {
  defineKeyContext({ id: COMMENT_SEARCH_CONTEXT_ID, bindings: searchKeyBindings() });
  activeSearchKeys = api;
  searchKeysRelease ??= pushKeyContext(COMMENT_SEARCH_CONTEXT_ID);
}

/** Снимает контекст панели (фокус покинул панель). */
export function leaveCommentSearchKeys(): void {
  searchKeysRelease?.();
  searchKeysRelease = null;
  activeSearchKeys = null;
}

/* ------------------------------------------------------------------ *
 * Фабрика панели.
 * ------------------------------------------------------------------ */

/** Собирает панель поиска/замены, привязанную к одному полю комментария. */
export function createCommentSearch(opts: CommentSearchOptions): CommentSearch {
  const highlight = opts.highlightPort ?? defaultHighlightPort();

  const panel = div(SEARCH_PANEL_CLASS);
  panel.hidden = true;
  panel.setAttribute('role', 'search');

  const findInput = fieldInput({
    type: 'search',
    placeholder: t('comment.search.findPlaceholder'),
    ariaLabel: t('comment.search.findLabel'),
    extraClass: 'md-field-search__input',
    onInput: () => runSearch(),
  });
  const countLabel = span('', 'md-field-search__count');
  const prevButton = iconButton({
    icon: renderIcon('arrow-up'),
    title: t('comment.search.previous'),
    role: 'ghost',
    size: 's',
    onClick: () => {
      previous();
    },
  });
  const nextButton = iconButton({
    icon: renderIcon('arrow-down'),
    title: t('comment.search.next'),
    role: 'ghost',
    size: 's',
    onClick: () => {
      next();
    },
  });
  const closeButton = iconButton({
    icon: renderIcon('x'),
    title: t('comment.search.close'),
    role: 'ghost',
    size: 's',
    onClick: () => {
      closePanel(false);
    },
  });
  const findRow = div('md-field-search__row');
  findRow.append(findInput, countLabel, prevButton, nextButton, closeButton);

  const replaceInput = fieldInput({
    placeholder: t('comment.search.replacePlaceholder'),
    ariaLabel: t('comment.search.replaceLabel'),
    extraClass: 'md-field-search__input',
    onInput: () => {
      /* замена применяется по кнопке — ввод ничего не пересчитывает */
    },
  });
  const replaceButton = uiButton({
    label: t('comment.search.replace'),
    size: 's',
    onClick: () => {
      replaceCurrent();
    },
  });
  const replaceAllButton = uiButton({
    label: t('comment.search.replaceAll'),
    size: 's',
    onClick: () => {
      replaceAll();
    },
  });
  const replaceRow = div('md-field-search__row');
  replaceRow.hidden = true;
  replaceRow.append(replaceInput, replaceButton, replaceAllButton);

  panel.append(findRow, replaceRow);

  let open = false;
  let current = -1;
  /** Совпадения в правке (смещения документа). */
  let editorMatches: TextMatch[] = [];
  /** Диапазоны совпадений в просмотре. */
  let viewRanges: Range[] = [];

  const isEditSource = (): boolean => opts.getEditor() !== null;

  const matchCount = (): number => (isEditSource() ? editorMatches.length : viewRanges.length);

  /** Применяет подсветку и прокрутку к текущему совпадению. */
  const revealCurrent = (): void => {
    const editor = opts.getEditor();
    const query = findInput.value;
    if (editor !== null) {
      const match = current >= 0 ? editorMatches[current] : undefined;
      editor.setSearchHighlight({ query, current: match ?? null });
      if (match !== undefined) editor.selectMatch(match.from, match.to);
      return;
    }
    highlight.set(viewRanges, current >= 0 ? (viewRanges[current] ?? null) : null);
    const range = current >= 0 ? viewRanges[current] : undefined;
    if (range !== undefined) scrollRange(range);
  };

  /** Пересобирает совпадения по текущему запросу и режиму. */
  const runSearch = (): void => {
    const query = findInput.value;
    editorMatches = [];
    viewRanges = [];
    current = -1;
    highlight.clear();
    const editor = opts.getEditor();
    if (query !== '') {
      if (editor !== null) {
        editorMatches = findMatches(editor.getValue(), query);
      } else {
        viewRanges = collectViewRanges(opts.view, query);
      }
      current = matchCount() > 0 ? 0 : -1;
    }
    revealCurrent();
    updateCount();
  };

  /** Перевод к следующему/предыдущему вхождению, закольцованный. */
  const advance = (delta: 1 | -1): boolean => {
    if (!open) return false;
    const count = matchCount();
    if (count === 0) {
      runSearch();
      return matchCount() > 0;
    }
    current = (current + delta + count) % count;
    revealCurrent();
    updateCount();
    return true;
  };

  const next = (): boolean => advance(1);
  const previous = (): boolean => advance(-1);

  const updateCount = (): void => {
    const count = matchCount();
    countLabel.textContent =
      count === 0
        ? t('comment.search.none')
        : t('comment.search.count', [current + 1, count]);
    const none = count === 0;
    prevButton.disabled = none;
    nextButton.disabled = none;
    const replaceAvailable = none || !opts.isEditing();
    replaceButton.disabled = replaceAvailable;
    replaceAllButton.disabled = replaceAvailable;
  };

  /** Текущее совпадение в правке (для замены). */
  const currentEditMatch = (): TextMatch | null => {
    if (current < 0) return null;
    return editorMatches[current] ?? null;
  };

  const replaceCurrent = (): void => {
    const editor = opts.getEditor();
    const match = currentEditMatch();
    if (editor === null || match === null) return;
    const replacement = replaceInput.value;
    editor.applyEdit({
      changes: { from: match.from, to: match.to, insert: replacement },
      selection: { anchor: match.from + replacement.length },
    });
    runSearch();
  };

  const replaceAll = (): void => {
    const editor = opts.getEditor();
    if (editor === null || findInput.value === '') return;
    const matches = findMatches(editor.getValue(), findInput.value);
    if (matches.length === 0) return;
    const replacement = replaceInput.value;
    editor.applyEdit({
      changes: matches.map((match) => ({ from: match.from, to: match.to, insert: replacement })),
    });
    runSearch();
  };

  const openPanel = (requested: CommentSearchMode): void => {
    const effective: CommentSearchMode =
      requested === 'replace' && !opts.isEditing() ? 'find' : requested;
    open = true;
    panel.hidden = false;
    replaceRow.hidden = effective !== 'replace';
    runSearch();
    findInput.focus();
    findInput.select();
  };

  const closePanel = (restore: boolean): void => {
    const wasOpen = open;
    open = false;
    panel.hidden = true;
    replaceRow.hidden = true;
    editorMatches = [];
    viewRanges = [];
    current = -1;
    highlight.clear();
    opts.getEditor()?.setSearchHighlight(null);
    if (wasOpen && restore) opts.restoreFocus();
  };

  const controller: CommentSearch = {
    element: panel,
    open: openPanel,
    close: () => closePanel(true),
    isOpen: () => open,
    refresh: () => {
      if (open) runSearch();
    },
    next,
    previous,
    focusFind: () => {
      findInput.focus();
      findInput.select();
    },
    openReplace: () => {
      if (!opts.isEditing()) return;
      replaceRow.hidden = false;
      replaceInput.focus();
    },
    enterKeys: () => enterCommentSearchKeys(controller),
    leaveKeys: () => leaveCommentSearchKeys(),
    destroy: () => {
      closePanel(false);
      panel.remove();
    },
  };

  return controller;
}
