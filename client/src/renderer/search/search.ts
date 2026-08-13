/**
 * Search (H13, 08-ui-spec.md §3; 09-scenarios.md B3).
 *
 * - toolbar input + options gear + drop panel with four collapsible result
 *   groups («Найдено по именам/текстам/связям/в хронологии»), snippets render
 *   server `<mark>` highlights via innerHTML;
 * - activation restores the previous `search_state` (text + options) from L4
 *   ui_state; searching runs on Enter and debounced 250 ms while typing;
 * - options: subtree (subroot via the thought picker, default = current
 *   focus), group checkboxes (мысли/связи/хронология), thought/link type
 *   multi-select, show_inactive (default = the network preference);
 * - clicking a thought hit focuses it; clicking a link hit focuses its source
 *   and opens the link in the editor (spec §3.1).
 */

import { setFocus } from '../app.js';
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
    optionsRow.classList.toggle('hidden');
  });

  input.addEventListener('focus', () => {
    if (!restored) {
      restored = true;
      void restoreState();
    }
  });
  input.addEventListener('input', () => {
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void run(), 250);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      void run();
    }
  });
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
  if (networkId === null || q === '') {
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

/** Renders the four result groups. */
function renderResults(response: SearchResponse | null): void {
  if (chrome === null) return;
  const resultsBox = chrome.host.querySelector('.search-results');
  if (resultsBox === null) return;
  resultsBox.replaceChildren();
  if (response === null) {
    resultsBox.append(el('p', 'muted', 'Введите запрос и нажмите Enter.'));
    return;
  }
  const groups: Array<{
    key: 'names' | 'texts' | 'links' | 'chronology';
    title: string;
    hits: Array<{ kind: string; title: string; snippet: string; open: () => void }>;
  }> = [
    {
      key: 'names',
      title: 'Найдено по именам',
      hits: response.by_names.map((hit) => ({
        kind: '💭',
        title: hit.title,
        snippet: hit.snippet,
        open: () => void setFocus(hit.thought_id),
      })),
    },
    {
      key: 'texts',
      title: 'Найдено по текстам',
      hits: response.by_texts.map((hit) => ({
        kind: '💭',
        title: hit.title,
        snippet: hit.snippet,
        open: () => void setFocus(hit.thought_id),
      })),
    },
    {
      key: 'links',
      title: 'Найдено связей',
      hits: response.by_links.map((hit) => ({
        kind: '🔗',
        title: hit.type_name,
        snippet: hit.snippet,
        open: () => void openLinkHit(hit.link_id),
      })),
    },
    {
      key: 'chronology',
      title: 'Найдено в хронологии',
      hits: response.by_chrono.map((hit) => ({
        kind: '📅',
        title: hit.valid_from.slice(0, 10),
        snippet: hit.snippet,
        open: () => void openChronoHit(hit.owner, hit.owner_id),
      })),
    },
  ];

  for (const group of groups) {
    const total = response.meta.total_in_group[group.key];
    const section = div('search-group');
    const header = div('search-group-header');
    const caret = span('▾', 'group-caret');
    const label = span(`${group.title} (${total})`, 'group-title');
    header.append(caret, label);
    const body = div('search-group-body');
    header.addEventListener('click', () => {
      const collapsed = body.classList.toggle('hidden');
      caret.textContent = collapsed ? '▸' : '▾';
    });
    section.append(header, body);
    if (total === 0 || group.hits.length === 0) {
      body.append(el('p', 'muted', 'Ничего не найдено.'));
    } else {
      for (const hit of group.hits) {
        const row = div('search-hit');
        const icon = span(hit.kind);
        const info = div('search-hit-info');
        info.style.flex = '1';
        info.style.minWidth = '0';
        const title = el('div', 'hit-title', hit.title);
        const snippet = el('div', 'hit-snippet');
        renderHtml(snippet, hit.snippet);
        info.append(title, snippet);
        row.append(icon, info);
        row.addEventListener('click', hit.open);
        body.append(row);
      }
    }
    resultsBox.append(section);
  }
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
export const searchInternals = { scopesFor, mergeResponses, DEFAULT_OPTIONS };
