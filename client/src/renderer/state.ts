/**
 * Global renderer state (phase H).
 *
 * A minimal typed store: all UI modules read/write the shared snapshot and
 * subscribe to changes. Realtime events, IPC results and user actions funnel
 * through {@link store.update} so the canvas, editor and status bar stay in
 * sync without a framework.
 */

import {
  CANVAS_CHILDREN_SHARE_DEFAULT,
  CANVAS_TOP_SPLIT_DEFAULT,
  CANVAS_ZOOM_DEFAULT,
  CLOUD_GAP_DEFAULT,
  CLOUD_WIDTH_DEFAULT,
  EDITOR_H_DEFAULT,
  EDITOR_W_DEFAULT,
  SELECTION_W_DEFAULT,
  type CurrentUser,
  type FocusEdge,
  type FocusResponse,
  type Link,
  type LinkType,
  type Network,
  type SortKind,
  type Thought,
  type ThoughtType,
} from '@etn/shared';

/** Top-level screens of the application. */
export type Screen = 'onboarding' | 'networks' | 'workspace';

/** Workspace views (L15, 08-ui-spec.md §15.1): the map canvas / the structures. */
export type WorkspaceView = 'map' | 'structures';

/** Editor dock position (L4 `editor_position`, 08-ui-spec.md §6.1). */
export type EditorPosition = 'left' | 'right' | 'top' | 'bottom' | 'hidden';

/** What the editor currently shows: a picked thought/link or the focused thought. */
export type EditorTarget =
  { kind: 'thought'; id: string } | { kind: 'link'; id: string; link: Link };

/** Realtime connection status as reported by the main process. */
export type RtStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

/** UI theme (L5 `client_meta.theme`, L10). */
export type Theme = 'light' | 'dark';

/** Shared renderer state snapshot. */
export interface AppState {
  screen: Screen;
  /** Active server profile id (L5), null before onboarding finishes. */
  profileId: string | null;
  /** Current user (`GET /me`). */
  me: CurrentUser | null;
  /** Opened network meta (L2). */
  network: Network | null;
  /** Opened network id (L4 `current_network_id`). */
  networkId: string | null;
  /** Last focus response — the canvas/editor/statusbar render from it. */
  focus: FocusResponse | null;
  /** L3 `show_inactive` preference of the open network. */
  showInactive: boolean;
  /** L4 `cloud_width`, px. */
  cloudWidth: number;
  /** L4 `cloud_gap`, px. */
  cloudGap: number;
  /** L4 `canvas_zoom` multiplier applied to clouds and link labels (L9). */
  canvasZoom: number;
  /** L4 `editor_position`. */
  editorPosition: EditorPosition;
  /** Last visible editor dock (restored when the editor is un-hidden). */
  lastEditorPosition: Exclude<EditorPosition, 'hidden'>;
  /** L4 `window_layout` editor width (left/right dock), px. */
  editorW: number;
  /** L4 `window_layout` editor height (top/bottom dock), px. */
  editorH: number;
  /** L4 `window_layout` selection panel width (left of the canvas), px. */
  selectionW: number;
  /** L4 `canvas_layout` share of the top strip width for the parents zone. */
  zoneTopSplit: number;
  /** L4 `canvas_layout` share of the canvas height for the children zone. */
  zoneChildrenShare: number;
  /** L4 `editor_collapsed_groups`, keyed by entity id. */
  collapsedGroups: Record<string, Record<string, boolean>>;
  /** Selection panel contents (ordered ids). */
  selection: string[];
  /** Link id highlighted on the canvas (sticky until a click elsewhere). */
  selectedLinkId: string | null;
  /** Link type catalogue of the open network (H6 line labels). */
  linkTypes: LinkType[];
  /** Thought type catalogue of the open network (editor header). */
  thoughtTypes: ThoughtType[];
  /** Realtime status (🟢/🟡/🔴 indicator, H19 offline blocking). */
  rtStatus: RtStatus;
  /** UI theme applied to the document root (L5 `client_meta.theme`, L10). */
  theme: Theme;
  /** Last realtime event description for the status bar (auto-hides). */
  lastEvent: string | null;
  /** Editor target; `null` means "follow the focused thought". */
  editorTarget: EditorTarget | null;
  /** Per-zone sort of the open focus (drag-reorder is only allowed on `manual`). */
  zoneSorts: { parents: SortKind; children: SortKind };
  /** Display order of orderable zones (deduped neighbour ids of the open focus). */
  zoneOrder: { parents: string[]; children: string[] };
  /** L4 `last_used_link_type_id` (add dialog default). */
  lastUsedLinkTypeId: string | null;
  /** Active workspace view (L4 `active_view`, 08-ui-spec.md §15.1). */
  activeView: WorkspaceView;
  /** The thought opened in the editor from the structures view (its band), L15. */
  structuresActiveThoughtId: string | null;
  /** Full entity of {@link AppState.structuresActiveThoughtId} (editor header). */
  structuresActiveThought: Thought | null;
  /** Pinned thoughts of the open network (L18): ordered thought ids (L3). */
  pins: string[];
}

/** Initial snapshot. */
const initial: AppState = {
  screen: 'onboarding',
  profileId: null,
  me: null,
  network: null,
  networkId: null,
  focus: null,
  showInactive: false,
  cloudWidth: CLOUD_WIDTH_DEFAULT,
  cloudGap: CLOUD_GAP_DEFAULT,
  canvasZoom: CANVAS_ZOOM_DEFAULT,
  editorPosition: 'right',
  lastEditorPosition: 'right',
  editorW: EDITOR_W_DEFAULT,
  editorH: EDITOR_H_DEFAULT,
  selectionW: SELECTION_W_DEFAULT,
  zoneTopSplit: CANVAS_TOP_SPLIT_DEFAULT,
  zoneChildrenShare: CANVAS_CHILDREN_SHARE_DEFAULT,
  collapsedGroups: {},
  selection: [],
  selectedLinkId: null,
  linkTypes: [],
  thoughtTypes: [],
  rtStatus: 'idle',
  theme: 'light',
  lastEvent: null,
  editorTarget: null,
  zoneSorts: { parents: 'created', children: 'created' },
  zoneOrder: { parents: [], children: [] },
  lastUsedLinkTypeId: null,
  activeView: 'map',
  structuresActiveThoughtId: null,
  structuresActiveThought: null,
  pins: [],
};

/**
 * Renderer store. Synchronous `update` + listener fan-out; there is exactly one
 * instance (`store`), imported by every UI module.
 */
class Store {
  private readonly listeners = new Set<() => void>();

  /** Current state snapshot (read-only by convention). */
  public readonly state: AppState = { ...initial };

  /** Patches the snapshot and notifies subscribers. */
  public update(patch: Partial<AppState>): void {
    Object.assign(this.state, patch);
    for (const listener of this.listeners) listener();
  }

  /** Subscribes to changes; returns the unsubscribe function. */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resets connection-related state (disconnect / network switch). */
  public resetNetwork(): void {
    this.update({
      network: null,
      networkId: null,
      focus: null,
      selection: [],
      selectedLinkId: null,
      editorTarget: null,
      linkTypes: [],
      thoughtTypes: [],
      lastEvent: null,
      structuresActiveThoughtId: null,
      structuresActiveThought: null,
      pins: [],
    });
  }
}

/** The single renderer store instance. */
export const store = new Store();

/**
 * Applies an updated link to the focus edges so the canvas repaints the line
 * instantly. The server never echoes realtime events to the acting client
 * (04-realtime.md §5) — the REST response is the only immediate feedback, so
 * without this the old colour/width would stay until the next focus fetch.
 *
 * The canvas shows the active-only neighbourhood (focus is requested without
 * `show_inactive`): a deactivated link loses its edge, a reactivated one gains
 * it back when both endpoints are visible.
 */
export function patchFocusEdge(link: Link): void {
  const focus = store.state.focus;
  if (focus === null) return;
  const has = focus.edges.some((e) => e.id === link.id);
  if (!link.active) {
    if (!has) return;
    store.update({
      focus: { ...focus, edges: focus.edges.filter((e) => e.id !== link.id) },
    });
    return;
  }
  const edge: FocusEdge = {
    id: link.id,
    source_id: link.source_id,
    target_id: link.target_id,
    type_id: link.type_id,
    color: link.color,
    style: link.style,
    width: link.width,
  };
  if (has) {
    store.update({
      focus: { ...focus, edges: focus.edges.map((e) => (e.id === link.id ? edge : e)) },
    });
    return;
  }
  const visible = new Set([
    focus.focused.id,
    ...focus.parents.map((n) => n.id),
    ...focus.children.map((n) => n.id),
    ...focus.siblings.map((n) => n.id),
  ]);
  if (visible.has(link.source_id) && visible.has(link.target_id)) {
    store.update({ focus: { ...focus, edges: [...focus.edges, edge] } });
  }
}

/** Helper: current network id, or throws for callers that require an open network. */
export function requireNetworkId(): string {
  const id = store.state.networkId;
  if (id === null) throw new Error('Сеть не открыта.');
  return id;
}

/**
 * Content signature of the visible link set around the focus. Creating,
 * deleting or retyping a link changes it even though the focused thought's
 * own version does not — the editor includes it in its render-signature
 * guard so the «Связи» group rebuilds after link drops and realtime link
 * events (the group body re-fetches links from the server per re-render).
 */
export function focusEdgesSignature(focus: FocusResponse | null): string {
  if (focus === null) return '';
  return focus.edges
    .map((e) => `${e.id}:${e.source_id}>${e.target_id}:${e.type_id ?? '-'}`)
    .sort()
    .join(',');
}
