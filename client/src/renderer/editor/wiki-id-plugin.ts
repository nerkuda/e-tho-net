/**
 * CM6 plugin for ID-based wiki-links (task R6, docs/12-wiki-id-refs.md §3).
 *
 * Behaviour:
 * - Scans the document for `[[#<uuid>]]` / `[[#<uuid>|<alias>]]` and
 *   `[[n:<net>#<uuid>]]` / `[[n:<net>#<uuid>|<alias>]]` patterns.
 * - Resolves id → { title, exists, networkId } via batched
 *   `etn.thoughts.resolve`. Per-session LRU cache; realtime `thought.*`
 *   events refresh known entries.
 * - Renders the link in two modes depending on cursor position:
 *   - Normal-mode (selection doesn't intersect the range): Decoration.replace
 *     on the WHOLE `[[…]]` span, hiding `[[`, `]]`, `#id`, `|` behind a
 *     single widget that shows the resolved title (or alias).
 *   - Edit-mode (selection intersects the range): Decoration.replace only on
 *     the `#id` (or `n:<net>#id`) token, plus an atomic mark — user sees
 *     `[[<title>]]` / `[[<title>|<alias>]]` with the id hidden. Backspace
 *     and Delete remove the atomic token whole; arrow keys skip over it.
 *
 * The user never sees the raw `#<uuid>` — only the resolved title (or alias).
 */

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';

import { WIKI_LINK_CLASS, WIKI_LINK_ID_ATTR, WIKI_LINK_NETWORK_ATTR } from '@etn/markdown';
import type { ThoughtRef } from '@etn/shared';

import { requireNetworkId } from '../app.js';
import { etn } from '../lib/etn.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CSS classes used for the link visuals. */
export const CSS_WIKI_LINK_ID = 'cm-wiki-id';
export const CSS_WIKI_LINK_ID_EDIT = 'cm-wiki-id-edit';
export const CSS_WIKI_LINK_DELETED = 'wiki-link-deleted';

/** A wiki-link parsed out of the document source. */
interface ParsedWikiLink {
  /** Inclusive start offset of the full `[[…]]` span. */
  from: number;
  /** Exclusive end offset (after `]]`). */
  to: number;
  /** Offset of the id token (`#<uuid>` or `n:<net>#<uuid>`) start. */
  idFrom: number;
  /** Offset of the id token end. */
  idTo: number;
  kind: 'id' | 'cross';
  thoughtId: string;
  networkId: string | null;
  /** `[[…|alias]]` — alias (without leading `|`). `null` if absent. */
  alias: string | null;
}

/** A resolved id → meta entry. */
interface ResolvedMeta {
  title: string;
  exists: boolean;
  networkId: string;
}

/** Per-plugin state: cache of resolved ids (per network) + the current decoration set. */
interface WikiIdState {
  /**
   * The active network id (or null when the network list is showing). Stored
   * on the field so `buildDecorations` can use it as the cache-key prefix
   * for `[[#<id>]]` links — otherwise `[[#<id>]]` (same-network) and
   * `[[n:<net>#<id>]]` (cross-network) would route through different code
   * paths with different key prefixes and the same-network branch would
   * never find its entries. Kept in sync with `requireNetworkId()` by
   * `wikiIdPlugin.update` via the {@link setNetworkId} effect.
   */
  networkId: string | null;
  /** Resolved metadata keyed by `<networkId>:<thoughtId>`. */
  cache: Map<string, ResolvedMeta>;
  decorations: DecorationSet;
}

const RESOLVE_BATCH = 100;
const CACHE_LIMIT = 1024;

function cacheKey(networkId: string, thoughtId: string): string {
  return `${networkId}:${thoughtId}`;
}

function makeEmptyState(): WikiIdState {
  return { networkId: null, cache: new Map(), decorations: Decoration.none };
}

/** Scan the document source for ID-form wiki-links. */
function parseIdLinks(source: string): ParsedWikiLink[] {
  const out: ParsedWikiLink[] = [];
  let i = 0;
  while (i < source.length - 3) {
    if (source.charCodeAt(i) !== 0x5b || source.charCodeAt(i + 1) !== 0x5b) {
      i += 1;
      continue;
    }
    const close = source.indexOf(']]', i + 2);
    if (close === -1) break;
    const content = source.slice(i + 2, close);
    if (content === '' || content.includes('\n') || content.includes('\r')) {
      i += 1;
      continue;
    }
    const pipe = content.indexOf('|');
    const target = (pipe === -1 ? content : content.slice(0, pipe)).trim();
    const aliasRaw = pipe === -1 ? null : content.slice(pipe + 1).trim();
    const alias = aliasRaw !== null && aliasRaw !== '' ? aliasRaw : null;

    let kind: 'id' | 'cross' | null = null;
    let thoughtId: string | null = null;
    let networkId: string | null = null;
    let idFrom = -1;
    let idTo = -1;

    if (target.startsWith('#')) {
      const id = target.slice(1).trim();
      if (UUID_RE.test(id)) {
        kind = 'id';
        thoughtId = id.toLowerCase();
        // `#` lives at i + 2; the id text starts at i + 3.
        idFrom = i + 3;
        idTo = idFrom + id.length;
      }
    } else if (target.startsWith('n:')) {
      const hashAt = target.indexOf('#', 2);
      if (hashAt !== -1) {
        const net = target.slice(2, hashAt).trim();
        const id = target.slice(hashAt + 1).trim();
        if (UUID_RE.test(net) && UUID_RE.test(id)) {
          kind = 'cross';
          networkId = net.toLowerCase();
          thoughtId = id.toLowerCase();
          // `n:<net>` occupies 2 + net.length characters; the id text starts
          // at i + 2 + 2 + net.length + 1 (after `n:<net>#`).
          idFrom = i + 2 + 2 + net.length;
          idTo = idFrom + id.length;
        }
      }
    }

    if (kind !== null && thoughtId !== null) {
      out.push({
        from: i,
        to: close + 2,
        idFrom,
        idTo,
        kind,
        thoughtId,
        networkId,
        alias,
      });
    }
    i = close + 2;
  }
  return out;
}

/**
 * Widget for the `[[<title>]]` label that replaces the whole span in
 * normal-mode. Hidden from the user — textContent carries the resolved
 * title; CSS handles the underline/styling.
 */
class WikiLinkLabelWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly deleted: boolean,
  ) {
    super();
  }

  override eq(other: WikiLinkLabelWidget): boolean {
    return other.label === this.label && other.deleted === this.deleted;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = this.deleted ? `${WIKI_LINK_CLASS} ${CSS_WIKI_LINK_DELETED}` : WIKI_LINK_CLASS;
    span.textContent = this.label;
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Widget that replaces the `#<id>` (or `n:<net>#<id>`) token in edit-mode.
 * Shows the resolved title on top of the (invisible) id. Color cue marks it
 * as an atomic object (atomic decoration is applied separately).
 */
class WikiLinkIdTokenWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly deleted: boolean,
  ) {
    super();
  }

  override eq(other: WikiLinkIdTokenWidget): boolean {
    return other.label === this.label && other.deleted === this.deleted;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = this.deleted
      ? `${CSS_WIKI_LINK_ID} ${CSS_WIKI_LINK_ID_EDIT} ${CSS_WIKI_LINK_DELETED}`
      : `${CSS_WIKI_LINK_ID} ${CSS_WIKI_LINK_ID_EDIT}`;
    span.contentEditable = 'false';
    span.textContent = this.label;
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Effect to seed the cache (used by tests and after batch resolve). */
const setCacheEntries = StateEffect.define<{ key: string; meta: ResolvedMeta }[]>();

/**
 * Effect to update the active network id (kept on the state field so
 * `buildDecorations` can resolve same-network `[[#<id>]]` cache keys).
 */
const setNetworkId = StateEffect.define<string | null>();

/**
 * StateField holding the resolved metadata cache and the current decoration
 * set. Decorations are recomputed whenever the document, selection or the
 * cache change.
 */
export const wikiIdState = StateField.define<WikiIdState>({
  create: () => makeEmptyState(),
  update(state, tr) {
    let networkId = state.networkId;
    let cache = state.cache;
    for (const e of tr.effects) {
      if (e.is(setNetworkId)) {
        // When the active network changes, drop the cache — entries from the
        // previous network are not relevant (and stale ids in the new network
        // would briefly show wrong titles if reused).
        if (e.value !== state.networkId) {
          networkId = e.value;
          if (cache.size > 0) cache = new Map();
        }
      } else if (e.is(setCacheEntries)) {
        if (cache === state.cache) cache = new Map(cache);
        for (const { key, meta } of e.value) {
          cache.set(key, meta);
        }
        // Cap the cache to avoid unbounded growth on very large documents.
        if (cache.size > CACHE_LIMIT) {
          const overflow = cache.size - CACHE_LIMIT;
          const it = cache.keys();
          for (let k = 0; k < overflow; k++) {
            const next = it.next();
            if (next.done) break;
            cache.delete(next.value);
          }
        }
      }
    }

    if (!tr.docChanged && cache === state.cache && networkId === state.networkId) {
      return state;
    }

    const decorations = buildDecorations(
      tr.state.doc.toString(),
      tr.state.selection.main,
      cache,
      networkId,
    );
    return { networkId, cache, decorations };
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.decorations),
});

/** Build decorations for the given source + selection + cache + networkId. */
function buildDecorations(
  source: string,
  selection: { from: number; to: number },
  cache: Map<string, ResolvedMeta>,
  networkId: string | null,
): DecorationSet {
  // Собираем декорации в массив и передаём в Decoration.set(): этот API
  // держит несколько декораций на одном диапазоне (mark + replace) — нужно
  // для atomic range в edit-mode. RangeSetBuilder.add() этого не позволяет
  // (два range на одной позиции → сортировка ломается).
  const parts: Array<{ from: number; to: number; value: Decoration }> = [];
  const links = parseIdLinks(source);
  const selFrom = Math.min(selection.from, selection.to);
  const selTo = Math.max(selection.from, selection.to);
  const intersects = (from: number, to: number): boolean => from < selTo && to > selFrom;

  for (const link of links) {
    // For [[#<id>]] the cache key uses the *active* network (link.networkId
    // is null). For [[n:<net>#<id>]] the key uses the explicit cross-network
    // id. If we don't have an active network yet, fall back to the link's own
    // network (which may be null for same-network links — entries will only
    // be found once the user activates a network).
    const keyNetworkId = link.networkId ?? networkId;
    if (keyNetworkId === null) continue;
    const meta = cache.get(cacheKey(keyNetworkId, link.thoughtId));
    const title = meta?.title ?? '';
    const deleted = meta !== undefined && !meta.exists;
    const label = link.alias ?? (title !== '' ? title : link.thoughtId);

    if (intersects(link.from, link.to)) {
      // edit-mode: replace the whole `#<id>` (or `n:<net>#<id>`) token with
      // a single widget showing the resolved title (or `…` until the resolve
      // returns). Two decorations on the same range:
      // - `Decoration.mark({ atomic: true })` — CM6 API для atomic range:
      //   стрелки влево/вправо перепрыгивают весь блок, курсор не входит.
      //   `contenteditable="false"` в виджете — страховка для браузера, но
      //   без `mark.atomic` CM6 не считает range атомарным и стрелка заходит
      //   внутрь виджета, застревая там.
      // - `Decoration.replace({ widget })` — рисует имя поверх исходника;
      //   `inclusive: true` нужен чтобы граничные позиции (`from`/`to`)
      //   тоже считались «внутри» декорации, иначе двойной клик ставит
      //   курсор точно на `#` или сразу за UUID — и пользователь видит
      //   `#<uuid>` вместо виджета.
      const idStart = link.idFrom - 1; // включая `#`
      const idEnd = link.idTo;
      parts.push({
        from: idStart,
        to: idEnd,
        value: Decoration.mark({ atomic: true, inclusive: true }),
      });
      parts.push({
        from: idStart,
        to: idEnd,
        value: Decoration.replace({
          widget: new WikiLinkIdTokenWidget(
            title !== '' ? title : '…', // пока резолв не пришёл — многоточие
            deleted,
          ),
          inclusive: true,
        }),
      });
    } else {
      // normal-mode: replace the WHOLE span with one label widget.
      parts.push({
        from: link.from,
        to: link.to,
        value: Decoration.replace({
          widget: new WikiLinkLabelWidget(label !== '' ? label : link.thoughtId, deleted),
          inclusive: false,
        }),
      });
    }
  }
  return Decoration.set(parts, true);
}

/** Extract unique id-tokens grouped by network from a source string. */
function collectUnresolvedTokens(
  source: string,
  cache: Map<string, ResolvedMeta>,
  networkId: string | null,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const link of parseIdLinks(source)) {
    // Same routing as in `buildDecorations`: `[[#<id>]]` uses the active
    // network; `[[n:<net>#<id>]]` uses the explicit one. We can only
    // collect tokens for which we know the network — same-network links
    // resolve once a network becomes active.
    const targetNet = link.networkId ?? networkId;
    if (targetNet === null) continue;
    const key = cacheKey(targetNet, link.thoughtId);
    if (cache.has(key)) continue;
    let bucket = out.get(targetNet);
    if (bucket === undefined) {
      bucket = new Set();
      out.set(targetNet, bucket);
    }
    bucket.add(link.thoughtId);
  }
  return out;
}

/**
 * Resolve one batch of ids for a network via `etn.thoughts.resolve` and
 * dispatch the result as a `setCacheEntries` effect.
 */
async function resolveAndApply(
  view: EditorView,
  networkId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const refs: ThoughtRef[] = await etn.thoughts.resolve(networkId, ids.slice(0, RESOLVE_BATCH));
    const entries: { key: string; meta: ResolvedMeta }[] = [];
    for (const id of ids.slice(0, RESOLVE_BATCH)) {
      const ref = refs.find((r) => r.id === id);
      entries.push({
        key: cacheKey(networkId, id),
        meta: {
          title: ref?.title ?? '',
          exists: ref !== undefined && ref !== null,
          networkId,
        },
      });
    }
    view.dispatch({ effects: setCacheEntries.of(entries) });
  } catch {
    // Silent failure: cache stays empty, widget renders the id as a fallback.
  }
}

/**
 * The CM6 view plugin. Watches document changes and selection updates; on
 * every meaningful change, computes unresolved id-tokens and dispatches
 * batched `etn.thoughts.resolve` calls.
 */
export const wikiIdPlugin = ViewPlugin.fromClass(
  class {
    inflight = false;
    lastNetwork: string | null = null;

    constructor(readonly view: EditorView) {
      this.schedule();
    }

    update(update: ViewUpdate): void {
      // Keep the active network id in sync on the state field so
      // `buildDecorations` can resolve same-network cache keys.
      const current = safeCurrentNetwork();
      if (current !== this.lastNetwork) {
        this.lastNetwork = current;
        this.view.dispatch({ effects: setNetworkId.of(current) });
      }
      if (update.docChanged || update.selectionSet) {
        this.schedule();
      }
    }

    schedule(): void {
      if (this.inflight) {
        // Coalesce: the next scan after the current resolve finishes will
        // pick up any new unresolved tokens.
        return;
      }
      const state = this.view.state.field(wikiIdState, false);
      if (state === undefined) return;
      const source = this.view.state.doc.toString();
      const unresolved = collectUnresolvedTokens(source, state.cache, state.networkId);
      // Early exit: nothing to resolve. Without this guard, the `finally` block
      // below would re-enter schedule() in a tight microtask loop (every
      // dispatch of `setCacheEntries` triggers an update, which would schedule
      // again), freezing the UI on every comment-field focus.
      if (unresolved.size === 0) return;
      this.inflight = true;
      // Convert every unresolved bucket into a `resolveAndApply` call.
      const tasks: Promise<void>[] = [];
      for (const [netId, ids] of unresolved) {
        // netId is always a real network id at this point — collectUnresolvedTokens
        // filters out unresolved same-network links when no network is active.
        tasks.push(resolveAndApply(this.view, netId, [...ids]));
      }
      void Promise.all(tasks).finally(() => {
        this.inflight = false;
        // Intentionally NOT calling this.schedule() here — `setCacheEntries`
        // dispatches below trigger `ViewPlugin.update`, which re-schedules if
        // the document or selection changed. Spinning without that signal
        // would burn the event loop on an empty token set.
      });
    }
  },
);

function safeCurrentNetwork(): string | null {
  try {
    return requireNetworkId();
  } catch {
    return null;
  }
}

/**
 * Refresh cached entries for ids that exist in the document. Called by
 * realtime handlers (`thought.updated` / `thought.deleted`) when the
 * editor is mounted.
 */
export function refreshWikiIdCache(view: EditorView, networkId?: string): void {
  const netId = networkId ?? safeCurrentNetwork();
  if (netId === null) return;
  const state = view.state.field(wikiIdState, false);
  if (state === undefined) return;
  const ids: string[] = [];
  for (const [key, meta] of state.cache) {
    if (meta.networkId !== netId) continue;
    const id = key.slice(netId.length + 1);
    ids.push(id);
  }
  if (ids.length > 0) void resolveAndApply(view, netId, ids);
}

/** Exposed for tests / debugging. */
export const __testing = { parseIdLinks, buildDecorations, cacheKey, collectUnresolvedTokens };
