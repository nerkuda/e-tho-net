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
import { applyThoughtIcon } from '../canvas/canvas.js';
import { openLinkInEditor } from '../editor/editor.js';
import { pickThoughtRef } from '../editor/thought-picker.js';
import { button, div, el, errText, renderHtml, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { UI_STATE_KEY, type SearchResponse, type SearchScope } from '@etn/shared';
import { store } from '../state.js';
import { requireNetworkId } from '../app.js';

/** Search options persisted in `search_state` (08-ui-spec.md §3.2). */
export interface SearchOptions {
  subtree: boolean;
  subrootId: string | null;
  onlyThoughts: boolean;
  onlyLinks: boolean;
  onlyChrono: boolean;
  typeIds: string[];
  linkTypeIds: string[];
  showInactive: boolean;
}

/** Minimum trimmed query length for a server search (08-ui-spec.md §3.1). */
export const MIN_QUERY_LENGTH = 3;

/** Whether the query is long enough to hit the server. */
export function isSearchableQuery(q: string): boolean {
  return q.length >= MIN_QUERY_LENGTH;
}

const DEFAULT_OPTIONS: SearchOptions = {
  subtree: false,
  subrootId: null,
  onlyThoughts: false,
  onlyLinks: false,
  onlyChrono: false,
  typeIds: [],
  linkTypeIds: [],
  showInactive: false,
};

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
      options = { ...DEFAULT_OPTIONS, ...(parsed.options as Partial<SearchOptions>) };
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
        JSON.stringify({ q: chrome.input.value, options }),
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
  const scopes = scopesFor(options);
  try {
    const responses = await Promise.all(
      scopes.map((scope) =>
        etn.thoughts.search(networkId, {
          q,
          scope,
          in: options.subtree ? 'subtree' : undefined,
          from_thought_id: options.subtree
            ? (options.subrootId ?? store.state.focus?.focused.id)
            : undefined,
          type_id: options.typeIds.length > 0 ? options.typeIds : undefined,
          link_type_id: options.linkTypeIds.length > 0 ? options.linkTypeIds : undefined,
          show_inactive: options.showInactive,
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

/** Builds a hit icon element from the thought's own icon (💭 fallback). */
function thoughtIconEl(hit: {
  thought_id: string;
  icon: string | null;
  icon_kind: import('@etn/shared').IconKind;
  icon_attachment_id: string | null;
}): HTMLElement {
  const icon = span('', 'mini-icon');
  applyThoughtIcon(icon, {
    id: hit.thought_id,
    icon: hit.icon,
    icon_kind: hit.icon_kind,
    type_id: null,
    icon_attachment_id: hit.icon_attachment_id,
  });
  return icon;
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
  const groups: Array<{
    key: 'names' | 'texts' | 'links' | 'chronology';
    title: string;
    hits: Array<{
      iconEl: HTMLElement;
      title: string;
      snippet: string;
      /** Stable row key for selection restore + keyboard navigation. */
      key: string;
      open: () => void;
    }>;
  }> = [
    {
      key: 'names',
      title: 'Найдено по именам',
      hits: response.by_names.map((hit) => ({
        iconEl: thoughtIconEl(hit),
        title: hit.title,
        snippet: hit.snippet,
        key: `thought:${hit.thought_id}`,
        open: () => void setFocus(hit.thought_id),
      })),
    },
    {
      key: 'texts',
      title: 'Найдено по текстам',
      hits: response.by_texts.map((hit) => ({
        iconEl: thoughtIconEl(hit),
        title: hit.title,
        snippet: hit.snippet,
        key: `thought:${hit.thought_id}`,
        open: () => void setFocus(hit.thought_id),
      })),
    },
    {
      key: 'links',
      title: 'Найдено связей',
      hits: response.by_links.map((hit) => ({
        iconEl: span('🔗'),
        title: hit.type_name,
        snippet: hit.snippet,
        key: `link:${hit.link_id}`,
        open: () => void openLinkHit(hit.link_id),
      })),
    },
    {
      key: 'chronology',
      title: 'Найдено в хронологии',
      hits: response.by_chrono.map((hit) => ({
        iconEl: span('📅'),
        title: hit.valid_from.slice(0, 10),
        snippet: hit.snippet,
        key: `chrono:${hit.owner}:${hit.owner_id}`,
        open: () => void openChronoHit(hit.owner, hit.owner_id),
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
        const info = div('search-hit-info');
        info.style.flex = '1';
        info.style.minWidth = '0';
        const title = el('div', 'hit-title', hit.title);
        const snippet = el('div', 'hit-snippet');
        renderHtml(snippet, hit.snippet);
        info.append(title, snippet);
        row.append(hit.iconEl, info);
        row.addEventListener('click', () => {
          lastSelectedKey = hit.key;
          applySelection(hit.key, true);
          hidePanel();
          // A synthetic Enter click keeps focus in the input; leave it so the
          // canvas/editor receives the following keystrokes.
          if (chrome !== null) chrome.input.blur();
          hit.open();
        });
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
  });
  subtreeLabel.append(subtreeCheck, span('только в подчинённых мыслях'));

  const subrootButton = button(
    'подкорень: —',
    () => {
      void pickThoughtRef(requireNetworkId()).then((id) => {
        if (id !== null) {
          options = { ...options, subrootId: id };
          rebuildOptionsRow();
          persistState();
        }
      });
    },
    'btn small',
  );
  const subrootTitle = store.state.focus?.focused.title ?? 'текущий фокус';
  subrootButton.textContent = `подкорень: ${options.subrootId !== null ? options.subrootId.slice(0, 8) : subrootTitle.slice(0, 14)}`;

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
    });
    wrap.append(check, span(label));
    return wrap;
  };

  const typeSelect = el('select', 'select-input');
  typeSelect.style.width = '170px';
  const typePlaceholder = el('option', undefined, 'Типы мыслей: все');
  typePlaceholder.value = '';
  typeSelect.append(typePlaceholder);
  for (const type of store.state.thoughtTypes) {
    const option = el('option', undefined, type.name);
    option.value = type.id;
    typeSelect.append(option);
  }
  typeSelect.value = options.typeIds[0] ?? '';
  typeSelect.addEventListener('change', () => {
    options = { ...options, typeIds: typeSelect.value === '' ? [] : [typeSelect.value] };
    persistState();
  });

  const linkTypeSelect = el('select', 'select-input');
  linkTypeSelect.style.width = '170px';
  const linkPlaceholder = el('option', undefined, 'Типы связей: все');
  linkPlaceholder.value = '';
  linkTypeSelect.append(linkPlaceholder);
  for (const type of store.state.linkTypes) {
    const option = el('option', undefined, type.name_forward);
    option.value = type.id;
    linkTypeSelect.append(option);
  }
  linkTypeSelect.value = options.linkTypeIds[0] ?? '';
  linkTypeSelect.addEventListener('change', () => {
    options = {
      ...options,
      linkTypeIds: linkTypeSelect.value === '' ? [] : [linkTypeSelect.value],
    };
    persistState();
  });

  const inactiveLabel = el('label', 'checkbox-row');
  const inactiveCheck = el('input');
  inactiveCheck.type = 'checkbox';
  inactiveCheck.checked = options.showInactive;
  inactiveCheck.addEventListener('change', () => {
    options = { ...options, showInactive: inactiveCheck.checked };
    persistState();
  });
  inactiveLabel.append(inactiveCheck, span('показывать неактуальные'));

  row.append(
    subtreeLabel,
    subrootButton,
    mkGroupCheck('мысли', 'onlyThoughts'),
    mkGroupCheck('связи', 'onlyLinks'),
    mkGroupCheck('хронологию', 'onlyChrono'),
    typeSelect,
    linkTypeSelect,
    inactiveLabel,
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
  MIN_QUERY_LENGTH,
  nextNavIndex,
};
