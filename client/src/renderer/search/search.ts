/**
 * Search (H13, 08-ui-spec.md §3; 09-scenarios.md B3).
 *
 * - toolbar input + options gear + drop panel with four collapsible result
 *   groups («Найдено по именам/текстам/связям/в хронологии»), snippets render
 *   server `<mark>` highlights via innerHTML;
 * - activation (Ctrl+F / focus / gear) reveals the drop panel and restores the
 *   previous `search_state` (text + options) from L4 ui_state; Escape hides the
 *   panel again;
 * - the server search runs for queries of 3+ characters: debounced 250 ms while
 *   typing or on Enter; shorter queries only show a hint;
 * - a whole-query UUID is a thought id lookup (§3.1): it bypasses the options
 *   and resolves the thought via `thoughts.get` into a single
 *   «Мысль по ID» section (absent thought → explicit notice);
 * - empty result groups render collapsed; ↑/↓ walk group headers and hits,
 *   Ctrl+↑/↓ jump to the first/last row, Enter (or Ctrl+Enter) toggles a group
 *   header or activates a hit (hiding the panel); the next activation
 *   re-highlights the last chosen hit;
 * - the panel is a bordered dropdown: left edge aligned with the search input
 *   (JS-anchored), right margin 10% and max height 50% of the window;
 * - options: subtree (subroot via the thought picker, default = current
 *   focus), group checkboxes (мысли/связи/хронология), thought/link type
 *   multi-select, show_inactive (default = the network preference);
 * - clicking a thought hit focuses it; clicking a link hit focuses its source
 *   and opens the link in the editor (spec §3.1).
 */

import { setFocus } from '../app.js';
// Хиты-мысли в результатах поиска рисует общая фабрика облачка (профиль
// `tree`): значок, цвета, начертание и бледность — как на холсте (§2.2, §6.7).
import { createThoughtCloud } from '../lib/thought-cloud.js';
import { openLinkInEditor } from '../editor/editor.js';
import { div, el, errText, renderHtml, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { markCommentPreview, markThoughtCommentPreview } from '../lib/hover-preview.js';
import { isNotFoundError, parseThoughtIdQuery } from '../lib/pure.js';
import {
  buildEntityChipField,
  buildEntityCombo,
  linkTypeEntityOptions,
  thoughtTypeEntityOptions,
} from '../lib/entity-picker.js';
import {
  buildSearchCriteriaWire,
  defaultSearchCriteriaState,
  parseSearchCriteria,
  searchCriteriaToStored,
  type SearchCriteriaState,
} from '../lib/filter-builder.js';
import { buildUserSelectWidget } from '../lib/users.js';
import {
  UI_STATE_KEY,
  type SearchResponse,
  type SearchScope,
  type Thought,
} from '@etn/shared';
import { store } from '../state.js';
import { requireNetworkId } from '../app.js';

/**
 * Настройки строки поиска карты (§3.2): критерии — общая модель конструктора
 * отбора (`lib/filter-builder.ts`); собственной модели (`SearchOptions`) и
 * собственного парсера сохранённого больше нет. Своё у поиска — группы
 * результатов и поддерево, они лежат в расширении общей модели.
 */
export type SearchOptions = SearchCriteriaState;

/** Minimum trimmed query length for a server search (08-ui-spec.md §3.1). */
export const MIN_QUERY_LENGTH = 3;

/** Whether the query is long enough to hit the server. */
export function isSearchableQuery(q: string): boolean {
  return q.length >= MIN_QUERY_LENGTH;
}

const DEFAULT_OPTIONS: SearchOptions = defaultSearchCriteriaState();

/** Search panel chrome (input + gear + results panel). */
export interface SearchChrome {
  input: HTMLInputElement;
  optionsButton: HTMLButtonElement;
  host: HTMLElement;
}

let chrome: SearchChrome | null = null;
let options: SearchOptions = { ...DEFAULT_OPTIONS };
let lastResults: SearchResponse | null = null;
let searchTimer: number | null = null;
let restored = false;
/** `data-key` of the hit activated last — re-highlighted on the next activation. */
let lastSelectedKey: string | null = null;
/** Flat navigation index over group headers + hits of expanded groups. */
let cursor: number | null = null;

/** Mounts the search panel (called from the workspace builder). */
export function mountSearch(next: SearchChrome): void {
  chrome = next;

  const { host, input, optionsButton } = next;
  host.replaceChildren();

  const optionsRow = div('search-options-row hidden');
  buildOptionsRow(optionsRow);
  const results = div('search-results');
  host.append(optionsRow, results);

  optionsButton.addEventListener('click', () => {
    positionPanel();
    host.classList.remove('hidden');
    optionsRow.classList.toggle('hidden');
  });

  input.addEventListener('focus', () => {
    positionPanel();
    host.classList.remove('hidden');
    if (!restored) {
      restored = true;
      void restoreState();
    }
    refreshOnActivation();
  });
  input.addEventListener('input', () => {
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void run(), 250);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      const rows = collectNavRows();
      const row = cursor === null ? undefined : rows[cursor];
      if (row !== undefined) {
        row.el.click();
      } else {
        void run();
      }
    } else if (event.ctrlKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      // Ctrl+↑/↓ jump to the first/last row (Enter — with or without Ctrl —
      // activates the selected row above).
      const rows = collectNavRows();
      if (rows.length === 0) return;
      event.preventDefault();
      cursor = event.key === 'ArrowUp' ? 0 : rows.length - 1;
      rows.forEach((row, i) => row.el.classList.toggle('selected', i === cursor));
      rows[cursor]!.el.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const rows = collectNavRows();
      if (rows.length === 0) return;
      event.preventDefault();
      moveCursor(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Escape') {
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      hidePanel();
      input.blur();
    }
  });

  // Keep the dropdown anchored to the input while the search row/window resizes.
  window.addEventListener('resize', positionPanel);
  new ResizeObserver(positionPanel).observe(input);

  // Close the panel on any click outside it (the input and the gear keep it
  // open) and on Escape while it is visible, even if the input lost focus.
  document.addEventListener('pointerdown', (event) => {
    if (host.classList.contains('hidden')) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (host.contains(target) || input.contains(target) || optionsButton.contains(target)) {
      return;
    }
    hidePanel();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !host.classList.contains('hidden')) {
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      hidePanel();
    }
  });
}

/** Anchors the drop panel: left edge under the search input, below its row. */
function positionPanel(): void {
  if (chrome === null) return;
  const root = chrome.host.parentElement;
  if (root === null) return;
  const rootRect = root.getBoundingClientRect();
  const inputRect = chrome.input.getBoundingClientRect();
  // The input lives in the map-view search row (L18), not in the toolbar.
  const row = chrome.input.parentElement;
  if (row === null) return;
  chrome.host.style.left = `${Math.max(0, inputRect.left - rootRect.left)}px`;
  chrome.host.style.top = `${row.getBoundingClientRect().bottom - rootRect.top + 6}px`;
}

/** Hides the drop panel (query, results and the selected row are kept). */
export function hidePanel(): void {
  if (chrome !== null) chrome.host.classList.add('hidden');
  cursor = null;
}

/**
 * Re-runs the search on every panel activation so the list never serves stale
 * data — a thought deleted while the panel was hidden must not linger in the
 * results. The last chosen hit is re-highlighted after the fresh render.
 */
function refreshOnActivation(): void {
  if (chrome === null) return;
  if (isSearchableQuery(chrome.input.value.trim())) {
    void run().then(() => applySelection(lastSelectedKey, true));
  } else {
    applySelection(lastSelectedKey, true);
  }
}

/**
 * Re-runs the search when the panel is already visible and the query is live —
 * called after a deletion so the deleted thought leaves the visible list at
 * once (the actor gets no realtime echo, 04-realtime.md §5).
 */
export function refreshSearchIfVisible(): void {
  if (chrome === null || chrome.host.classList.contains('hidden')) return;
  if (isSearchableQuery(chrome.input.value.trim())) void run();
}

/** One keyboard-navigable row: a group header or a hit of an expanded group. */
interface NavRow {
  el: HTMLElement;
  kind: 'header' | 'hit';
}

/** Collects navigable rows from the results DOM (headers + visible hits). */
function collectNavRows(): NavRow[] {
  if (chrome === null) return [];
  const resultsBox = chrome.host.querySelector<HTMLElement>('.search-results');
  if (resultsBox === null) return [];
  const rows: NavRow[] = [];
  for (const group of Array.from(resultsBox.children)) {
    if (!(group instanceof HTMLElement)) continue;
    const header = group.querySelector<HTMLElement>(':scope > .search-group-header');
    const body = group.querySelector<HTMLElement>(':scope > .search-group-body');
    if (header !== null) rows.push({ el: header, kind: 'header' });
    if (body !== null && !body.classList.contains('hidden')) {
      for (const hit of Array.from(body.querySelectorAll(':scope > .search-hit'))) {
        if (hit instanceof HTMLElement) rows.push({ el: hit, kind: 'hit' });
      }
    }
  }
  return rows;
}

/** Pure index math for ↑/↓ navigation (null cursor enters from either end). */
export function nextNavIndex(cursor: number | null, count: number, delta: 1 | -1): number | null {
  if (count === 0) return null;
  const base = cursor === null || cursor >= count ? (delta === 1 ? -1 : count) : cursor;
  return Math.min(count - 1, Math.max(0, base + delta));
}

/** Moves the keyboard cursor by one row and repaints the selection. */
function moveCursor(delta: 1 | -1): void {
  const rows = collectNavRows();
  const next = nextNavIndex(cursor, rows.length, delta);
  if (next === null) return;
  cursor = next;
  rows.forEach((row, i) => row.el.classList.toggle('selected', i === cursor));
  rows[next]?.el.scrollIntoView({ block: 'nearest' });
}

/** Highlights the hit row with the given key (and syncs the cursor index). */
function applySelection(key: string | null, scroll: boolean): void {
  if (chrome === null) return;
  const resultsBox = chrome.host.querySelector<HTMLElement>('.search-results');
  if (resultsBox === null) return;
  for (const node of Array.from(resultsBox.querySelectorAll('.selected'))) {
    node.classList.remove('selected');
  }
  if (key === null) {
    cursor = null;
    return;
  }
  const row = resultsBox.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  if (row === null) {
    cursor = null;
    return;
  }
  row.classList.add('selected');
  const rows = collectNavRows();
  cursor = rows.findIndex((r) => r.el === row);
  if (scroll) row.scrollIntoView({ block: 'nearest' });
}

/**
 * After a group toggle, keeps the cursor valid: if the selected row became
 * hidden with the collapsed group, the selection moves to that group header.
 */
function syncCursorAfterToggle(header: HTMLElement): void {
  const rows = collectNavRows();
  const selected = rows.find((r) => r.el.classList.contains('selected'));
  if (selected !== undefined) {
    cursor = rows.indexOf(selected);
    return;
  }
  const idx = rows.findIndex((r) => r.el === header);
  cursor = idx >= 0 ? idx : null;
  rows.forEach((row, i) => row.el.classList.toggle('selected', i === cursor));
}

/** Restores the previous query and options from L4 `search_state`. */
async function restoreState(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const raw = await etn.ui.getState(networkId, UI_STATE_KEY.SEARCH_STATE);
  if (raw === null) return;
  try {
    const parsed = JSON.parse(raw) as { q?: unknown; options?: unknown };
    if (typeof parsed.q === 'string' && chrome !== null) {
      chrome.input.value = parsed.q;
    }
    if (typeof parsed.options === 'object' && parsed.options !== null) {
      options = parseSearchCriteria(parsed.options);
      if (chrome !== null) {
        rebuildOptionsRow();
      }
    }
    if (chrome !== null && chrome.input.value !== '') void run();
  } catch {
    // Corrupted state — start fresh.
  }
}

/** Persists the current query + options (debounced). */
let persistTimer: number | null = null;
function persistState(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    const networkId = store.state.networkId;
    if (networkId === null || chrome === null) return;
    void etn.ui
      .setState(
        networkId,
        UI_STATE_KEY.SEARCH_STATE,
        // Набор сохраняемых ключей — конвертер конструктора (совместим с
        // записанным до 0.8.2: те же имена полей).
        JSON.stringify({ q: chrome.input.value, options: searchCriteriaToStored(options) }),
      )
      .catch(() => undefined);
  }, 300);
}

/** Resolves the effective scopes for the current option set. */
function scopesFor(o: SearchOptions): SearchScope[] {
  const none = !o.onlyThoughts && !o.onlyLinks && !o.onlyChrono;
  const parts: SearchScope[] = [];
  if (o.onlyThoughts || none) parts.push('names', 'texts');
  if (o.onlyLinks || none) parts.push('links');
  if (o.onlyChrono || none) parts.push('chronology');
  return parts.length >= 4 ? ['all'] : parts;
}

/** Merges several partial search responses into one. */
function mergeResponses(responses: SearchResponse[]): SearchResponse {
  const empty: SearchResponse = {
    by_names: [],
    by_texts: [],
    by_links: [],
    by_chrono: [],
    meta: { total_in_group: { names: 0, texts: 0, links: 0, chronology: 0 } },
  };
  for (const response of responses) {
    empty.by_names.push(...response.by_names);
    empty.by_texts.push(...response.by_texts);
    empty.by_links.push(...response.by_links);
    empty.by_chrono.push(...response.by_chrono);
    empty.meta.total_in_group.names += response.meta.total_in_group.names;
    empty.meta.total_in_group.texts += response.meta.total_in_group.texts;
    empty.meta.total_in_group.links += response.meta.total_in_group.links;
    empty.meta.total_in_group.chronology += response.meta.total_in_group.chronology;
  }
  return empty;
}

/** Runs the search for the current input and options. */
async function run(): Promise<void> {
  if (chrome === null) return;
  const networkId = store.state.networkId;
  const q = chrome.input.value.trim();
  if (networkId === null || !isSearchableQuery(q)) {
    renderResults(null);
    return;
  }
  persistState();
  const resultsBox = chrome.host.querySelector('.search-results');
  if (resultsBox !== null) {
    resultsBox.replaceChildren(el('span', 'muted', 'Поиск…'));
  }
  const idQuery = parseThoughtIdQuery(q);
  if (idQuery !== null) {
    await runById(networkId, idQuery);
    return;
  }
  const scopes = scopesFor(options);
  try {
    // Критерии отбора — единый конвертер конструктора; `q`/`scope`/подкорень
    // остаются параметрами самого поиска.
    const criteriaWire = buildSearchCriteriaWire(options);
    const responses = await Promise.all(
      scopes.map((scope) =>
        etn.thoughts.search(networkId, {
          q,
          scope,
          in: options.subtree ? 'subtree' : undefined,
          from_thought_id: options.subtree
            ? (options.subrootId ?? store.state.focus?.focused.id)
            : undefined,
          ...criteriaWire,
        }),
      ),
    );
    lastResults = mergeResponses(responses);
    renderResults(lastResults);
  } catch (err) {
    if (resultsBox !== null) {
      resultsBox.replaceChildren(span(`Ошибка поиска: ${errText(err)}`, 'error-text'));
    }
  }
}

/**
 * Direct lookup when the whole query is a thought id (08-ui-spec.md §3.1): the
 * thought is fetched via `thoughts.get` and shown as the only result section,
 * ignoring all search options (subtree, types, «показывать неактуальные») —
 * inactive thoughts are found as well.
 */
async function runById(networkId: string, id: string): Promise<void> {
  try {
    const thought = await etn.thoughts.get(networkId, id);
    renderIdResult(thought);
  } catch (err) {
    if (isNotFoundError(err)) {
      renderIdResult(null);
      return;
    }
    if (chrome !== null) {
      const resultsBox = chrome.host.querySelector('.search-results');
      if (resultsBox !== null) {
        resultsBox.replaceChildren(span(`Ошибка поиска: ${errText(err)}`, 'error-text'));
      }
    }
  }
}

/**
 * Renders the single «Мысль по ID» section: the found thought (click → focus,
 * snippet shows the id itself) or the explicit "absent" notice, which must stay
 * visible, so the empty section is rendered expanded.
 */
function renderIdResult(thought: Thought | null): void {
  if (chrome === null) return;
  const resultsBox = chrome.host.querySelector('.search-results');
  if (resultsBox === null) return;
  resultsBox.replaceChildren();
  const section = div('search-group');
  const header = div('search-group-header');
  const caret = span('▾', 'group-caret');
  const label = span(`Мысль по ID (${thought === null ? 0 : 1})`, 'group-title');
  header.append(caret, label);
  const body = div('search-group-body');
  header.addEventListener('click', () => {
    const collapsed = body.classList.toggle('hidden');
    caret.textContent = collapsed ? '▸' : '▾';
    syncCursorAfterToggle(header);
  });
  if (thought !== null) {
    const row = div('search-hit search-hit-cloud');
    const key = `thought:${thought.id}`;
    row.dataset['key'] = key;
    // The «Мысль по ID» row is the only thought fetched via `thoughts.get`,
    // so its full DTO carries every cloud-style field. The row shows the same
    // factory-built cloud as the canvas (08-ui-spec.md §2.2) with the id as
    // the snippet.
    row.append(
      createThoughtCloud(thought, {
        profile: 'tree',
        // Ширина — по строке выпадашки (ошибка 265cdb5f): имя обрезается
        // многоточием по списку, а не по холстовым 200px.
        width: 'container',
        actions: {
          onClick: activateHit(key, () => void setFocus(thought.id)),
          onCtrlClick: () => activateHit(key, () => void setFocus(thought.id))(),
        },
      }),
    );
    const info = div('search-hit-info');
    info.style.flex = '1';
    info.style.minWidth = '0';
    info.append(el('div', 'hit-snippet', thought.id));
    row.append(info);
    // Stage 3: no per-indicator comment/chrono/attachment icons on this row —
    // Ctrl+hover over the row itself shows the thought's permanent comment.
    markThoughtCommentPreview(row, thought.id, thought.title);
    body.append(row);
  } else {
    body.append(el('p', 'muted', 'Мысль с указанным ID отсутствует.'));
  }
  section.append(header, body);
  resultsBox.append(section);
  applySelection(lastSelectedKey, false);
}

/**
 * Активация хитов поиска (единая для всех групп): запоминает выбранный хит,
 * подсвечивает его, прячет панель и возвращает фокус инпуту поиска — затем
 * выполняет действие хита.
 */
function activateHit(key: string, open: () => void): () => void {
  return () => {
    lastSelectedKey = key;
    applySelection(key, true);
    hidePanel();
    // A synthetic Enter click keeps focus in the input; leave it so the
    // canvas/editor receives the following keystrokes.
    if (chrome !== null) chrome.input.blur();
    open();
  };
}

/** Renders the four result groups. */
function renderResults(response: SearchResponse | null): void {
  if (chrome === null) return;
  const resultsBox = chrome.host.querySelector('.search-results');
  if (resultsBox === null) return;
  resultsBox.replaceChildren();
  if (response === null) {
    resultsBox.append(el('p', 'muted', 'Введите запрос (минимум 3 символа).'));
    return;
  }
  // Группы результатов. Для мыслей иконка, название, цвета и начертание
  // приходят из общей фабрики облачка (мысли выглядят как на холсте); строки
  // связей и хронологии не несут мысли и остаются простыми строками.
  const groups: Array<{
    key: 'names' | 'texts' | 'links' | 'chronology';
    title: string;
    hits: Array<{
      /** Фабричное облачко мысли либо глиф-иконка для не-мысленных хитов. */
      lead: HTMLElement;
      /** Заголовок простой строки (связи/хронология); у мыслей — в облачке. */
      title?: string;
      /**
       * Хит-мысль: облачко занимает всю ширину списка (название обрезается
       * по ней, а не по ширине холстового облачка `--cloud-width`), snippet
       * с `<mark>` уходит под облачко (ошибка 265cdb5f).
       */
      isThought: boolean;
      snippet: string;
      /** Stable row key for selection restore + keyboard navigation. */
      key: string;
      open: () => void;
      /** Stage 3: Ctrl+hover on the row shows the owner's permanent comment
       *  (no per-indicator icons in this list). */
      markPreview: (row: HTMLElement) => void;
    }>;
  }> = [
    {
      key: 'names',
      title: 'Найдено по именам',
      hits: response.by_names.map((hit) => ({
        lead: createThoughtCloud(
          { ...hit, id: hit.thought_id },
          {
            profile: 'tree',
            // Ширина — по строке выпадашки (ошибка 265cdb5f): имя обрезается
            // многоточием по списку, а не по холстовым 200px.
            width: 'container',
            actions: {
              onClick: activateHit(`thought:${hit.thought_id}`, () => void setFocus(hit.thought_id)),
              onCtrlClick: activateHit(`thought:${hit.thought_id}`, () => void setFocus(hit.thought_id)),
            },
          },
        ),
        isThought: true,
        snippet: hit.snippet,
        key: `thought:${hit.thought_id}`,
        open: () => void setFocus(hit.thought_id),
        markPreview: (row) => markThoughtCommentPreview(row, hit.thought_id, hit.title),
      })),
    },
    {
      key: 'texts',
      title: 'Найдено по текстам',
      hits: response.by_texts.map((hit) => ({
        lead: createThoughtCloud(
          { ...hit, id: hit.thought_id },
          {
            profile: 'tree',
            // Ширина — по строке выпадашки (ошибка 265cdb5f): имя обрезается
            // многоточием по списку, а не по холстовым 200px.
            width: 'container',
            actions: {
              onClick: activateHit(`thought:${hit.thought_id}`, () => void setFocus(hit.thought_id)),
              onCtrlClick: activateHit(`thought:${hit.thought_id}`, () => void setFocus(hit.thought_id)),
            },
          },
        ),
        isThought: true,
        snippet: hit.snippet,
        key: `thought:${hit.thought_id}`,
        open: () => void setFocus(hit.thought_id),
        markPreview: (row) => markThoughtCommentPreview(row, hit.thought_id, hit.title),
      })),
    },
    {
      key: 'links',
      title: 'Найдено связей',
      hits: response.by_links.map((hit) => ({
        lead: span('🔗'),
        title: hit.type_name,
        isThought: false,
        snippet: hit.snippet,
        key: `link:${hit.link_id}`,
        open: () => void openLinkHit(hit.link_id),
        markPreview: (row) => markCommentPreview(row, 'link', hit.link_id, hit.type_name),
      })),
    },
    {
      key: 'chronology',
      title: 'Найдено в хронологии',
      hits: response.by_chrono.map((hit) => ({
        lead: span('📅'),
        title: hit.valid_from.slice(0, 10),
        isThought: false,
        snippet: hit.snippet,
        key: `chrono:${hit.owner}:${hit.owner_id}`,
        open: () => void openChronoHit(hit.owner, hit.owner_id),
        markPreview: (row) => markCommentPreview(row, hit.owner, hit.owner_id, hit.valid_from.slice(0, 10)),
      })),
    },
  ];

  for (const group of groups) {
    const total = response.meta.total_in_group[group.key];
    const empty = total === 0 || group.hits.length === 0;
    const section = div('search-group');
    const header = div('search-group-header');
    const caret = span(empty ? '▸' : '▾', 'group-caret');
    const label = span(`${group.title} (${total})`, 'group-title');
    header.append(caret, label);
    const body = div('search-group-body');
    if (empty) body.classList.add('hidden');
    header.addEventListener('click', () => {
      const collapsed = body.classList.toggle('hidden');
      caret.textContent = collapsed ? '▸' : '▾';
      syncCursorAfterToggle(header);
    });
    section.append(header, body);
    if (empty) {
      body.append(el('p', 'muted', 'Ничего не найдено.'));
    } else {
      for (const hit of group.hits) {
        const row = div('search-hit');
        row.dataset['key'] = hit.key;
        // Хит-мысль — облачко на всю ширину списка и snippet под ним
        // (ошибка 265cdb5f); строки связи/хронологии остаются в одну строку
        // с глифом-иконкой.
        if (hit.isThought) row.classList.add('search-hit-cloud');
        row.append(hit.lead);
        const info = div('search-hit-info');
        info.style.flex = '1';
        info.style.minWidth = '0';
        if (hit.title !== undefined) {
          info.append(el('div', 'hit-title', hit.title));
        }
        const snippet = el('div', 'hit-snippet');
        renderHtml(snippet, hit.snippet);
        info.append(snippet);
        row.append(info);
        hit.markPreview(row);
        // Мысль активируется облачком (у него свои действия), а строки связи
        // и хронологии — кликом по строке: тот же обработчик обслуживает и
        // Enter в списке (`row.el.click()`). Ошибка 65382113: после перевода
        // на фабрику облачка обработчик клика перестал доставаться этим
        // строкам — связь и хронология не открывались ни мышью, ни Enter.
        if (!hit.isThought) row.addEventListener('click', activateHit(hit.key, hit.open));
        body.append(row);
      }
    }
    resultsBox.append(section);
  }
  applySelection(lastSelectedKey, false);
}

/** Opens a link hit: focuses the source thought, opens the link editor. */
async function openLinkHit(linkId: string): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const link = await etn.links.get(networkId, linkId);
    await setFocus(link.source_id);
    openLinkInEditor(link);
  } catch {
    // stale hit
  }
}

/** Opens a chronology hit on its owner (thought → focus, link → editor). */
async function openChronoHit(owner: 'thought' | 'link', ownerId: string): Promise<void> {
  const networkId = requireNetworkId();
  if (owner === 'thought') {
    void setFocus(ownerId);
    return;
  }
  try {
    const link = await etn.links.get(networkId, ownerId);
    openLinkInEditor(link);
  } catch {
    // stale hit
  }
}

/** Builds the options row controls. */
function buildOptionsRow(row: HTMLElement): void {
  row.replaceChildren();

  const subtreeLabel = el('label', 'checkbox-row');
  const subtreeCheck = el('input');
  subtreeCheck.type = 'checkbox';
  subtreeCheck.checked = options.subtree;
  subtreeCheck.addEventListener('change', () => {
    options = { ...options, subtree: subtreeCheck.checked };
    persistState();
    refreshSearchIfVisible();
  });
  subtreeLabel.append(subtreeCheck, span('только в подчинённых мыслях'));

  // «Только в подчинённых мыслях»: поле выбора мысли общим комбо пикера —
  // облачко выбранной мысли, живой поиск, сброс крестиком в «текущий фокус»
  // (`null` — без подкорня, берётся фокус).
  const subrootCombo = buildEntityCombo({
    networkId: requireNetworkId(),
    kind: 'thoughts',
    value: options.subrootId,
    emptyLabel: 'текущий фокус',
    placeholder: 'Мысль…',
    onChange: (id) => {
      options = { ...options, subrootId: id };
      persistState();
      refreshSearchIfVisible();
    },
  });

  const mkGroupCheck = (
    label: string,
    key: 'onlyThoughts' | 'onlyLinks' | 'onlyChrono',
  ): HTMLElement => {
    const wrap = el('label', 'checkbox-row');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = options[key];
    check.addEventListener('change', () => {
      options = { ...options, [key]: check.checked };
      persistState();
      refreshSearchIfVisible();
    });
    wrap.append(check, span(label));
    return wrap;
  };

  // L21: the type tree rendered by the common entity chip field (ADR «выбор
  // сущности — один пикер»). Список типов — МАССИВ (как в состоянии и в
  // `type_id` запроса): прежнее комбо хранило один id и молча теряло
  // остальные (задача 3742dd59). Корень иерархии не выбирается.
  const typeField = buildEntityChipField({
    getValues: () => options.typeIds,
    onChange: (values) => {
      options.typeIds = values;
      persistState();
      refreshSearchIfVisible();
    },
    loadOptions: () => thoughtTypeEntityOptions(store.state.thoughtTypes),
    optionsHeader: 'Типы мыслей',
    placeholder: 'Тип мысли…',
  });

  const linkTypeField = buildEntityChipField({
    getValues: () => options.linkTypeIds,
    onChange: (values) => {
      options.linkTypeIds = values;
      persistState();
      refreshSearchIfVisible();
    },
    loadOptions: () => linkTypeEntityOptions(store.state.linkTypes),
    optionsHeader: 'Типы связей',
    placeholder: 'Тип связи…',
  });

  const inactiveLabel = el('label', 'checkbox-row');
  const inactiveCheck = el('input');
  inactiveCheck.type = 'checkbox';
  inactiveCheck.checked = options.showInactive;
  inactiveCheck.addEventListener('change', () => {
    options = { ...options, showInactive: inactiveCheck.checked };
    persistState();
    refreshSearchIfVisible();
  });
  inactiveLabel.append(inactiveCheck, span('показывать неактуальные'));

  const trashedLabel = el('label', 'checkbox-row');
  const trashedCheck = el('input');
  trashedCheck.type = 'checkbox';
  trashedCheck.checked = options.trashed;
  trashedCheck.addEventListener('change', () => {
    options = { ...options, trashed: trashedCheck.checked };
    persistState();
    refreshSearchIfVisible();
  });
  trashedLabel.append(trashedCheck, span('показывать помеченные на удаление'));

  // Задача 59119797 «Фильтры Автор/Редактор»: два селекта пользователей
  // сети. Пустая строка в состоянии — «не применять» (REST/MCP это и так
  // понимают).
  const authorSelect = buildUserSelectWidget({
    label: 'Автор',
    currentId: options.authorId,
    onChange: (id) => {
      options = { ...options, authorId: id };
      persistState();
      refreshSearchIfVisible();
    },
  });
  const editorSelect = buildUserSelectWidget({
    label: 'Редактор',
    currentId: options.editorId,
    onChange: (id) => {
      options = { ...options, editorId: id };
      persistState();
      refreshSearchIfVisible();
    },
  });

  row.append(
    subtreeLabel,
    subrootCombo.root,
    mkGroupCheck('мысли', 'onlyThoughts'),
    mkGroupCheck('связи', 'onlyLinks'),
    mkGroupCheck('хронологию', 'onlyChrono'),
    typeField.root,
    linkTypeField.root,
    authorSelect,
    editorSelect,
    inactiveLabel,
    trashedLabel,
  );
}

/** Rebuilds the options row after options change (checkbox state refresh). */
function rebuildOptionsRow(): void {
  if (chrome === null) return;
  const row = chrome.host.querySelector<HTMLElement>('.search-options-row');
  if (row !== null) buildOptionsRow(row);
}

/** Test seam. */
export const searchInternals = {
  scopesFor,
  mergeResponses,
  DEFAULT_OPTIONS,
  isSearchableQuery,
  parseThoughtIdQuery,
  MIN_QUERY_LENGTH,
  nextNavIndex,
};
