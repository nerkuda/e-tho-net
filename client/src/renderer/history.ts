/**
 * Unified visit history (0.5.5, task «Переделать историю посещения мыслей»,
 * 07-client-electron.md §3.5, 11-settings-and-state.md §2.3, 09-scenarios.md
 * B4).
 *
 * A SINGLE per-tab history of thoughts opened in the thought editor, shared
 * by every screen (map/structures/chronicle) — replacing the old per-view
 * histories (the map's focus history, the structures view's own history) and
 * the chronicle's separate thought+link history. It no longer matters which
 * screen opened a thought, or whether it ever became the canvas focus: any
 * thought shown in the editor counts as "visited".
 *
 * Algorithm (must be followed exactly — see the task text): the thought
 * being LEFT enters the front of the history at the moment the NEXT thought
 * opens; the thought being entered is never recorded for itself. Every
 * "open a thought in the editor" call site across the app (canvas click/
 * Enter, a canvas focus change, the structures/chronicle views, a pick from
 * the history panel itself) calls {@link noteThoughtWillOpen} right before
 * applying its own store update, so the "previous" id is always whatever was
 * effectively current a moment ago — regardless of which screen set it.
 *
 * Opening a LINK does not call {@link noteThoughtWillOpen}: a link is not a
 * "visited thought", and the last real thought must survive a link detour
 * (open thought A → open link L → open thought B still records A, not
 * nothing).
 */
import { store } from './state.js';
import { etn } from './lib/etn.js';

/** Notified after every history write so the status-bar panel can re-render
 *  (the history list itself is not part of the reactive store snapshot —
 *  see {@link setHistoryChangeListener}). */
let onChange: (() => void) | null = null;

/**
 * Registers the callback invoked after a history write completes. The
 * history-bar module calls this once on mount (same idiom as
 * `setLinkEditorOpener` in editor.ts) — kept as a setter instead of a direct
 * import to avoid a module cycle (this module must stay a leaf: editor.ts,
 * app.ts, structures.ts and chronicle.ts all import from it).
 */
export function setHistoryChangeListener(fn: (() => void) | null): void {
  onChange = fn;
}

/** The id of the thought presently "current" per the actual store snapshot:
 *  the editor target when it is a thought, else the canvas focus. A link open
 *  in the editor means NO current thought (the link takes the spotlight —
 *  every screen drops its halo). Used to SEED the tracker below the first
 *  time a tab is touched — after that, {@link trackedThoughtId} is
 *  authoritative so a link detour doesn't lose the last real thought. Also
 *  the single definition of "current thought" for the history bar and the
 *  structures halo (task «Переделать историю посещения мыслей»: the
 *  current-thought frame follows the thought open in the editor on every
 *  screen). */
export function currentThoughtId(): string | null {
  const target = store.state.editorTarget;
  if (target !== null) {
    return target.kind === 'thought' ? target.id : null;
  }
  return store.state.focus?.focused.id ?? null;
}

/** Per-tab tracker of the id last passed to {@link noteThoughtWillOpen} —
 *  the thought that will be pushed into history once a DIFFERENT thought
 *  opens next. */
let trackedTabId: string | null = null;
let trackedThoughtId: string | null = null;

/**
 * Call this right before switching the editor/focus to `newId` (from ANY
 * screen). Records the thought that was current a moment ago at the front of
 * the unified history — never `newId` itself. No-op when there is nothing to
 * record yet (fresh tab) or the thought did not actually change.
 *
 * Returns a promise so callers that update the store right after (e.g.
 * `setFocus`) can await it first — the history-bar panel re-renders off
 * store changes, and a fire-and-forget write here would race it (the bar
 * could paint a pre-rotation snapshot for a frame). Callers that cannot
 * await (synchronous call sites like a canvas click) may ignore the
 * returned promise — {@link setHistoryChangeListener} still fires once the
 * write lands.
 */
export function noteThoughtWillOpen(newId: string): Promise<void> {
  const tabId = store.state.activeTabId;
  if (tabId !== trackedTabId) {
    // First touch of this tab in the current renderer session — seed from
    // whatever the store actually shows right now (the tab's restored focus/
    // editor target), so leaving THAT thought is still recorded correctly.
    trackedTabId = tabId;
    trackedThoughtId = currentThoughtId();
  }
  const oldId = trackedThoughtId;
  trackedThoughtId = newId;
  if (oldId === null || oldId === newId) return Promise.resolve();

  const profileId = store.state.profileId;
  const networkId = store.state.networkId;
  if (profileId === null || networkId === null) return Promise.resolve();
  return etn.history
    .rotate(oldId, newId, tabId)
    .catch(() => undefined)
    .then(() => {
      onChange?.();
    });
}

/**
 * Drops a deleted thought from the tracker so it is never resurrected as the
 * "previous" thought on the next transition (the caller separately prunes it
 * from the persisted history via `etn.history.remove`).
 */
export function noteThoughtRemoved(id: string): void {
  if (trackedThoughtId === id) trackedThoughtId = null;
}

/** Test-only: resets module-level tracking between unit tests. */
export function resetHistoryTrackingForTests(): void {
  trackedTabId = null;
  trackedThoughtId = null;
  onChange = null;
}
