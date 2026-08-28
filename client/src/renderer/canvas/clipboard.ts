/**
 * In-memory clipboard of copied thoughts (workplan L26, task bb8277f6).
 *
 * The clipboard holds a full snapshot of the source thoughts: title, synonyms,
 * style, type tag (for resolution on the target network), icon, permanent
 * comment, property values, attachments — plus every link that lives entirely
 * inside the selection. The snapshot carries the source network id so the
 * paste path can rewrite id-based wiki-links when the paste lands on a
 * different network.
 *
 * Scope: the clipboard is **per-renderer-process** and is lost on reload.
 * Snapshot bodies are NOT mirrored to the system clipboard — comments can
 * carry private text — but every thought copy DOES mirror the copied
 * thoughts' **wiki-links** into the system clipboard (bug 290a50c0), so the
 * OS buffer always carries meaningful content. The exact mirrored string is
 * remembered ({@link systemClipboardMatchesText}) and the paste paths treat
 * the internal snapshot as stale as soon as the system clipboard no longer
 * holds it (another program copied something later).
 *
 * Subscribers (the context-menu, the selection panel, the canvas paste
 * handler) call {@link subscribe} to be notified when the snapshot changes.
 */

import type {
  ThoughtCopyItem,
  ThoughtCopyLink,
} from '@etn/shared';

/**
 * The clipboard snapshot. `source_id` on each item is the *original* thought
 * id in the source network — it is what the result-map keys on.
 */
export interface ThoughtClipboardSnapshot {
  sourceNetworkId: string;
  /** Optional human label for notices ("Скопировано: 3 мысли из «СНТ»"). */
  sourceNetworkName?: string;
  thoughts: ThoughtCopyItem[];
  links: ThoughtCopyLink[];
}

/** Mutable singleton state. */
let snapshot: ThoughtClipboardSnapshot | null = null;
/**
 * The wiki-link text the last thought copy wrote to the system clipboard
 * (bug 290a50c0). The paste paths compare the live system-clipboard text
 * against it to decide whether the internal snapshot is still fresh:
 * anything else in the buffer means a later copy (usually in another
 * program) has superseded the snapshot.
 */
let systemClipboardText: string | null = null;
const listeners = new Set<() => void>();

/** Replace the clipboard with a new snapshot; notifies subscribers. */
export function setClipboard(next: ThoughtClipboardSnapshot | null): void {
  if (next === null) {
    systemClipboardText = null;
    if (snapshot === null) return;
    snapshot = null;
    notify();
    return;
  }
  snapshot = next;
  notify();
}

/** Return the current snapshot, or `null` when the clipboard is empty. */
export function getClipboard(): ThoughtClipboardSnapshot | null {
  return snapshot;
}

/** True when there's something to paste. */
export function hasClipboard(): boolean {
  return snapshot !== null && snapshot.thoughts.length > 0;
}

/** Subscribe to clipboard changes; returns an unsubscribe handle. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Supersede the snapshot on native text copies (bug 731a9d16: «Скопированная
 * мысль не удаляется из "буфера обмена"»). The internal clipboard must behave
 * like the system one — every later copy displaces whatever was there before,
 * including a text copy displacing a copied thought.
 *
 * Native text copies (the CM6 comment editor, plain inputs, a visible text
 * selection outside editables, Ctrl+X) fire a `copy`/`cut` event on the
 * window. The thought-copy path never does: its Ctrl+C keydown is
 * `preventDefault()`-ed (app.ts `initKeyboard`) before the browser runs the
 * default copy action, and the context-menu commands call
 * {@link setClipboard} directly. So every `copy`/`cut` event seen here is a
 * *text* copy — clear the snapshot.
 *
 * Copies made in other applications change the system clipboard without our
 * window seeing an event; that case is not tracked (polling the OS clipboard
 * is out of scope).
 */
export function initNativeCopyTracking(target: EventTarget = window): void {
  const supersede = (): void => {
    setClipboard(null);
  };
  target.addEventListener('copy', supersede);
  target.addEventListener('cut', supersede);
}

/** Build a short notice string for "Скопировано: …". */
export function clipboardSummary(): string {
  if (snapshot === null) return '';
  const count = snapshot.thoughts.length;
  const noun = pluralise(count, 'мысль', 'мысли', 'мыслей');
  const where = snapshot.sourceNetworkName ? ` из «${snapshot.sourceNetworkName}»` : '';
  return `${count} ${noun}${where}`;
}

function pluralise(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Rewrite id-based wiki-links in a markdown body so a cross-network paste
 * keeps the references intact:
 *
 *  - `[[#<uuid>]]` → `[[n:<sourceNetworkId>#<uuid>]]`
 *  - `[[#<uuid>|<alias>]]` → `[[n:<sourceNetworkId>#<uuid>|<alias>]]`
 *
 * When `sourceNetworkId === targetNetworkId` the body is returned verbatim
 * (the references already point at the right network). Legacy name-based
 * links (`[[имя]]`) are left untouched — the spec says they survive
 * unchanged.
 *
 * The function is intentionally conservative: it only rewrites well-formed
 * UUIDs to avoid corrupting `[[имя с #]]` patterns or anything else that
 * looks link-shaped but isn't.
 */
export function rewriteCrossNetworkLinks(
  bodyMd: string,
  sourceNetworkId: string,
  targetNetworkId: string,
): string {
  if (sourceNetworkId === targetNetworkId) return bodyMd;
  // Match `[[#<uuid>(|<alias>)?]]` — the same shape the markdown parser
  // accepts for ID links (markdown/src/wiki-link.ts). The escaped `]`
  // inside the character class keeps Node happy across optional groups
  // (an unescaped `]` works for the first match but silently fails when
  // nested under an optional capture). The alias is captured separately
  // so it survives the rewrite unchanged.
  return bodyMd.replace(
    /\[\[#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\|[^\]]+)?\]\]/gi,
    (_match, id: string, alias: string | undefined) =>
      `[[n:${sourceNetworkId}#${id.toLowerCase()}${alias ?? ''}]]`,
  );
}

/**
 * Format one thought's id as an id-based wiki-link for the given network.
 * Used when pasting into a comment: the server stores the raw `[[…]]` and
 * the markdown renderer wires the link up.
 */
export function thoughtIdLink(thoughtId: string, sourceNetworkId: string, targetNetworkId: string): string {
  if (sourceNetworkId === targetNetworkId) return `[[#${thoughtId}]]`;
  return `[[n:${sourceNetworkId}#${thoughtId}]]`;
}

// ---------------------------------------------------------------------------
// Paste helpers — server-bound and text-bound
// ---------------------------------------------------------------------------

import { store } from '../state.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { errorDialog } from '../lib/dialog.js';
import { errText } from '../lib/dom.js';
import { parseAddLines, parseThoughtIdQuery } from '../lib/pure.js';

/**
 * Paste the clipboard snapshot under `targetId` (workplan L26). Rewrites
 * id-based wiki-links in permanent comments when the source and target
 * networks differ.
 */
export async function pasteThoughtsTo(targetId: string): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const snap = getClipboard();
  if (snap === null || snap.thoughts.length === 0) {
    notice('Буфер обмена пуст.', 'error');
    return;
  }
  const rewrittenThoughts = snap.thoughts.map((item) => {
    const itemCopy = { ...item };
    if (
      itemCopy.permanent_comment !== undefined &&
      itemCopy.permanent_comment !== null &&
      typeof itemCopy.permanent_comment.body_md === 'string'
    ) {
      itemCopy.permanent_comment = {
        ...itemCopy.permanent_comment,
        body_md: rewriteCrossNetworkLinks(
          itemCopy.permanent_comment.body_md,
          snap.sourceNetworkId,
          networkId,
        ),
      };
    }
    return itemCopy;
  });
  const rewrittenLinks = snap.links.map((link) => {
    if (link.permanent_comment === null || link.permanent_comment === undefined) {
      return link;
    }
    return {
      ...link,
      permanent_comment: {
        ...link.permanent_comment,
        body_md: rewriteCrossNetworkLinks(
          link.permanent_comment.body_md,
          snap.sourceNetworkId,
          networkId,
        ),
      },
    };
  });
  try {
    const result = await etn.thoughts.copyBatch(networkId, {
      source_network_id: snap.sourceNetworkId,
      parent_thought_id: targetId,
      thoughts: rewrittenThoughts,
      links: rewrittenLinks,
    });
    notice(
      `Вставлено: ${result.created_thoughts.length} ${pluraliseRu(result.created_thoughts.length)}`,
    );
  } catch (err) {
    errorDialog('Вставить', err);
  }
}

/**
 * Paste arbitrary text into a cloud (workplan L26): every non-empty line
 * is processed independently — a whole-UUID line resolves to an existing
 * thought and creates a link from the target, anything else becomes a new
 * child thought (`|` separates title from synonyms).
 */
export async function pasteTextToCloud(text: string, targetId: string): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const lines = parseAddLines(text);
  if (lines.length === 0) return;
  let created = 0;
  let linked = 0;
  let failed = 0;
  for (const line of lines) {
    const idGuess = parseThoughtIdQuery(line.raw);
    if (idGuess !== null) {
      // Try to find the thought by id (cross-network: skip silently if it
      // doesn't exist on this network).
      try {
        await etn.thoughts.get(networkId, idGuess);
        await etn.links.create(networkId, {
          source_id: targetId,
          target_id: idGuess,
          type_id: null,
        });
        linked += 1;
        continue;
      } catch {
        failed += 1;
        continue;
      }
    }
    // Not an id — create a new thought under `targetId`.
    try {
      await etn.thoughts.create(networkId, {
        title: line.title,
        ...(line.synonyms.length > 0 ? { synonyms: line.synonyms } : {}),
        create_link: { direction: 'child', target_thought_id: targetId, type_id: null },
      });
      created += 1;
    } catch (err) {
      notice(`Не удалось вставить «${line.title}»: ${errText(err)}`, 'error');
      failed += 1;
    }
  }
  if (created > 0 || linked > 0) {
    notice(
      `Вставлено: ${created} ${pluraliseRu(created)}, ${linked} ${pluraliseLinksRu(linked)}.`,
    );
  } else if (failed > 0) {
    notice('Не удалось вставить ни одной строки.', 'error');
  }
}

/** Compose a wiki-link per thought in the clipboard — used when pasting
 *  into a comment editor. */
export function buildCommentPasteLinks(targetNetworkId: string): string {
  const snap = getClipboard();
  if (snap === null || snap.thoughts.length === 0) return '';
  return snap.thoughts
    .map((item) => {
      const sourceId = (item as unknown as { source_id?: unknown }).source_id;
      if (typeof sourceId !== 'string' || sourceId === '') return null;
      return thoughtIdLink(sourceId, snap.sourceNetworkId, targetNetworkId);
    })
    .filter((s): s is string => s !== null)
    .join(', ');
}

// ---------------------------------------------------------------------------
// System-clipboard mirroring and staleness tracking (bug 290a50c0)
// ---------------------------------------------------------------------------

/**
 * Safe access to the system clipboard via `navigator.clipboard` — the only
 * path the renderer already uses (context-menu «Копировать ID», the canvas
 * text paste). Returns bound methods so they can be called standalone, and
 * empty stubs in non-browser test environments (Node ships a `navigator`
 * without `.clipboard`).
 */
function systemClipboardApi(): {
  writeText?: (text: string) => Promise<void>;
  readText?: () => Promise<string>;
} {
  const clip = (
    globalThis as {
      navigator?: {
        clipboard?: {
          writeText?: (text: string) => Promise<void>;
          readText?: () => Promise<string>;
        };
      };
    }
  ).navigator?.clipboard;
  if (clip === undefined) return {};
  return {
    ...(clip.writeText !== undefined ? { writeText: clip.writeText.bind(clip) } : {}),
    ...(clip.readText !== undefined ? { readText: clip.readText.bind(clip) } : {}),
  };
}

/**
 * Mirror the freshly captured snapshot to the SYSTEM clipboard as
 * wiki-links built for the source network (`[[#<id>]]`, comma-separated).
 * The exact string is remembered in {@link systemClipboardText}; the paste
 * paths compare the live buffer against it — anything else there means the
 * snapshot is stale and the system text must win (bug 290a50c0: a Ctrl+V in
 * a comment editor used to paste thought links copied long before, ignoring
 * the text the user had just copied in another program).
 *
 * A failed write is not fatal: the token is still remembered, and since the
 * buffer then does not hold it, paste paths correctly fall back to the
 * buffer's actual content.
 */
async function syncSystemClipboard(): Promise<void> {
  const snap = snapshot;
  if (snap === null || snap.thoughts.length === 0) {
    systemClipboardText = null;
    return;
  }
  const links = buildCommentPasteLinks(snap.sourceNetworkId);
  systemClipboardText = links === '' ? null : links;
  if (systemClipboardText === null) return;
  const { writeText } = systemClipboardApi();
  if (writeText === undefined) return;
  try {
    await writeText(systemClipboardText);
  } catch {
    // Window out of focus / clipboard locked — the token stays; pastes will
    // compare against whatever the buffer really holds.
  }
}

/** One ETN id-based wiki-link: `[[#<uuid>]]` or `[[n:<net>#<uuid>]]`. */
const ETN_WIKI_LINK_RE =
  /^\[\[(?:n:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]\]$/i;

/**
 * True when `text` looks like ETN wiki-links — a single `[[#<uuid>]]` /
 * `[[n:<net>#<uuid>]]` or a comma-separated list of them (the exact shape
 * {@link syncSystemClipboard} writes). Fallback heuristic used when the
 * mirrored token was lost; the UUID shape makes false positives from
 * ordinary copied text practically impossible.
 */
export function looksLikeEtnWikiLinks(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  return trimmed.split(',').every((part) => ETN_WIKI_LINK_RE.test(part.trim()));
}

/**
 * Does `systemText` (the current content of the system clipboard) confirm
 * that the internal snapshot is still the freshest copy? The snapshot must
 * be non-empty and the text must either equal the string ETN mirrored at
 * copy time or — when the token was never recorded — look like ETN
 * wiki-links on its own.
 */
export function systemClipboardMatchesText(systemText: string): boolean {
  if (snapshot === null || snapshot.thoughts.length === 0) return false;
  if (systemClipboardText !== null) return systemText === systemClipboardText;
  return looksLikeEtnWikiLinks(systemText);
}

/**
 * Async flavour of {@link systemClipboardMatchesText} for the canvas paste
 * path: reads the system clipboard and reports whether the internal
 * snapshot may still be pasted as thoughts. When the buffer cannot be read
 * there is no proof it was overwritten — don't block the paste.
 */
export async function systemClipboardHasThoughts(): Promise<boolean> {
  if (snapshot === null || snapshot.thoughts.length === 0) return false;
  const { readText } = systemClipboardApi();
  if (readText === undefined) return true;
  let text: string;
  try {
    text = await readText();
  } catch {
    return true;
  }
  return systemClipboardMatchesText(text);
}

function pluraliseRu(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'мысль';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'мысли';
  return 'мыслей';
}

function pluraliseLinksRu(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'связь';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'связи';
  return 'связей';
}

// ---------------------------------------------------------------------------
// Snapshot builders (single + multi)
// ---------------------------------------------------------------------------

/** Minimal subset of `Thought` the snapshot needs. */
interface ThoughtLike {
  id: string;
  title: string;
  synonyms: string[];
  type_id: string | null;
  icon: string | null;
  icon_kind: 'emoji' | 'image';
  icon_attachment_id: string | null;
  active: boolean;
  fg_color: string | null;
  bg_color: string | null;
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
}

/**
 * Lightweight dependencies the builder needs from the renderer. We accept
 * them as a plain object so the builder is easy to unit-test without
 * touching the network.
 */
export interface SnapshotDeps {
  /** Source network id (the clipboard records where the snapshot came from
   *  so the paste path can rewrite cross-network wiki-links). */
  sourceNetworkId: string;
  /** Display name of the source network (for the copy notice). */
  sourceNetworkName?: string;
  /** Fetches a thought by id; returns null when missing. */
  getThought: (id: string) => Promise<ThoughtLike | null>;
  /** Fetches the permanent comment for a thought (null when absent). */
  getPermanentComment: (
    thoughtId: string,
  ) => Promise<{ title: string | null; body_md: string } | null>;
  /** Fetches the stored property values keyed by property key. */
  getProperties: (thoughtId: string) => Promise<Record<string, unknown>>;
  /** Fetches the attachments (lightweight: kind/url/file_path/mime/title/desc). */
  getAttachments: (thoughtId: string) => Promise<
    Array<{
      kind: 'url' | 'file';
      url?: string | null;
      file_path?: string | null;
      file_size?: number | null;
      mime_type?: string | null;
      title?: string | null;
      description?: string | null;
    }>
  >;
  /** Lists links incident to one thought — used to gather inter-thought
   *  links. Only links whose both endpoints are inside the selection are
   *  kept (the rest are dropped per spec). */
  getLinksForThought: (thoughtId: string) => Promise<
    Array<{
      id: string;
      source_id: string;
      target_id: string;
      type_id: string | null;
      color: string | null;
      style: string | null;
      width: number | null;
      active: boolean;
    }>
  >;
  /** Resolves a thought-type id to its display name (for the type tag). */
  getThoughtTypeName: (typeId: string | null) => string | null;
  /** Resolves a link-type id to its (forward, reverse) labels. */
  getLinkTypeNames: (
    typeId: string | null,
  ) => { name_forward: string | null; name_reverse: string | null } | null;
}

/**
 * Build a snapshot for a single thought (the "Копировать" context-menu
 * command and the matching Ctrl+C). Only the thought itself lands in the
 * snapshot — there are no inter-thought links to capture.
 */
export async function buildSingleThoughtSnapshot(
  thought: ThoughtLike,
  deps: SnapshotDeps,
): Promise<void> {
  const item = await buildOneItem(thought, deps);
  setClipboard({
    sourceNetworkId: deps.sourceNetworkId,
    sourceNetworkName: deps.sourceNetworkName,
    thoughts: [item],
    links: [],
  });
  // Bug 290a50c0: mirror the copy to the system clipboard as wiki-links so
  // later pastes can tell "still ours" from "overwritten elsewhere".
  await syncSystemClipboard();
}

/**
 * Build a snapshot for a list of thoughts (the "Скопировать мысли" command
 * in the selection panel). Also gathers every link whose both endpoints
 * are inside the selection — those are the only links the spec carries over.
 */
export async function buildMultiThoughtSnapshot(
  thoughts: ThoughtLike[],
  deps: SnapshotDeps,
): Promise<void> {
  const items: ThoughtCopyItem[] = [];
  for (const thought of thoughts) {
    items.push(await buildOneItem(thought, deps));
  }
  const idSet = new Set(thoughts.map((t) => t.id));
  const seenLinks = new Set<string>();
  const links: ThoughtCopyLink[] = [];
  for (const thought of thoughts) {
    const incident = await deps.getLinksForThought(thought.id);
    for (const link of incident) {
      if (!idSet.has(link.source_id) || !idSet.has(link.target_id)) continue;
      const identity = `${link.source_id}:${link.target_id}:${link.type_id ?? ''}`;
      if (seenLinks.has(identity)) continue;
      seenLinks.add(identity);
      links.push(await buildOneLink(link, deps));
    }
  }
  setClipboard({
    sourceNetworkId: deps.sourceNetworkId,
    sourceNetworkName: deps.sourceNetworkName,
    thoughts: items,
    links,
  });
  // Bug 290a50c0: same system-clipboard mirroring as the single copy — the
  // selection-panel command's snapshot also stays valid only while the OS
  // buffer still carries these wiki-links.
  await syncSystemClipboard();
}

/** Internal: package one thought + its permanent comment + props + attachments. */
async function buildOneItem(
  thought: ThoughtLike,
  deps: SnapshotDeps,
): Promise<ThoughtCopyItem> {
  const [comment, properties, attachments] = await Promise.all([
    deps.getPermanentComment(thought.id),
    deps.getProperties(thought.id),
    deps.getAttachments(thought.id),
  ]);
  // Extension field the server uses to fill in `thought_id_map`. Kept off
  // the public `ThoughtCopyItem` type but read by the service layer.
  const item = {
    thought: {
      title: thought.title,
      synonyms: thought.synonyms,
      type: {
        id: thought.type_id,
        name: deps.getThoughtTypeName(thought.type_id),
      },
      icon: thought.icon,
      icon_kind: thought.icon_kind,
      active: thought.active,
      fg_color: thought.fg_color,
      bg_color: thought.bg_color,
      font_bold: thought.font_bold,
      font_italic: thought.font_italic,
      font_underline: thought.font_underline,
      font_strike: thought.font_strike,
    },
    permanent_comment: comment,
    properties: properties as Record<string, import('@etn/shared').PropertyValueValue>,
    attachments,
  } as ThoughtCopyItem & { source_id: string };
  // Stash the source id on the item — the server reads this off the wire
  // and turns it into `thought_id_map[source_id] = new_id`.
  (item as { source_id: string }).source_id = thought.id;
  return item;
}

/** Internal: package one link with its type tag (no permanent comment / attachments
 *  for links today — the editor's link-comment panel is still TODO). */
async function buildOneLink(
  link: {
    id: string;
    source_id: string;
    target_id: string;
    type_id: string | null;
    color: string | null;
    style: string | null;
    width: number | null;
    active: boolean;
  },
  _deps: SnapshotDeps,
): Promise<ThoughtCopyLink> {
  const typeNames = _deps.getLinkTypeNames(link.type_id);
  const out = {
    source_id: link.source_id,
    target_id: link.target_id,
    type: {
      id: link.type_id,
      name_forward: typeNames?.name_forward ?? null,
      name_reverse: typeNames?.name_reverse ?? null,
    },
    color: link.color,
    style: link.style as import('@etn/shared').LinkStyle | null,
    width: link.width,
    active: link.active,
  } satisfies ThoughtCopyLink;
  // Suppress unused warnings on the link id: kept on the wire for debug.
  void link.id;
  return out;
}
