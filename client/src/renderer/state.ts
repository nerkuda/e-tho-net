/**
 * Global renderer state (phase H).
 *
 * A minimal typed store: all UI modules read/write the shared snapshot and
 * subscribe to changes. Realtime events, IPC results and user actions funnel
 * through {@link store.update} so the canvas, editor and status bar stay in
 * sync without a framework.
 */

import {
  CLOUD_GAP_DEFAULT,
  CLOUD_WIDTH_DEFAULT,
  EDITOR_H_DEFAULT,
  EDITOR_W_DEFAULT,
  type CurrentUser,
  type FocusResponse,
  type Link,
  type LinkType,
  type Network,
  type SortKind,
  type ThoughtType,
} from '@etn/shared';

/** Top-level screens of the application. */
export type Screen = 'onboarding' | 'networks' | 'workspace';

/** Editor dock position (L4 `editor_position`, 08-ui-spec.md §6.1). */
export type EditorPosition = 'left' | 'right' | 'top' | 'bottom' | 'hidden';

/** What the editor currently shows: the focused thought or a picked link. */
export type EditorTarget =
  { kind: 'thought'; id: string } | { kind: 'link'; id: string; link: Link };

/** Realtime connection status as reported by the main process. */
export type RtStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

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
  /** L4 `editor_position`. */
  editorPosition: EditorPosition;
  /** Last visible editor dock (restored when the editor is un-hidden). */
  lastEditorPosition: Exclude<EditorPosition, 'hidden'>;
  /** L4 `window_layout` editor width (left/right dock), px. */
  editorW: number;
  /** L4 `window_layout` editor height (top/bottom dock), px. */
  editorH: number;
  /** L4 `editor_collapsed_groups`, keyed by entity id. */
  collapsedGroups: Record<string, Record<string, boolean>>;
  /** Selection panel contents (ordered ids). */
  selection: string[];
  /** Link type catalogue of the open network (H6 line labels). */
  linkTypes: LinkType[];
  /** Thought type catalogue of the open network (editor header). */
  thoughtTypes: ThoughtType[];
  /** Realtime status (🟢/🟡/🔴 indicator, H19 offline blocking). */
  rtStatus: RtStatus;
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
  editorPosition: 'right',
  lastEditorPosition: 'right',
  editorW: EDITOR_W_DEFAULT,
  editorH: EDITOR_H_DEFAULT,
  collapsedGroups: {},
  selection: [],
  linkTypes: [],
  thoughtTypes: [],
  rtStatus: 'idle',
  lastEvent: null,
  editorTarget: null,
  zoneSorts: { parents: 'created', children: 'created' },
  zoneOrder: { parents: [], children: [] },
  lastUsedLinkTypeId: null,
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
      editorTarget: null,
      linkTypes: [],
      thoughtTypes: [],
      lastEvent: null,
    });
  }
}

/** The single renderer store instance. */
export const store = new Store();

/** Helper: current network id, or throws for callers that require an open network. */
export function requireNetworkId(): string {
  const id = store.state.networkId;
  if (id === null) throw new Error('Сеть не открыта.');
  return id;
}
