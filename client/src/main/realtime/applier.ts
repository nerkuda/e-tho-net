/**
 * Realtime event applier (task G8, docs/04-realtime.md §7,
 * docs/11-settings-and-state.md §1.4).
 *
 * Rules implemented here:
 *   * echo suppression — events with `actor.client_id === myClientId` are
 *     dropped (the originating REST call already applied them);
 *   * `thought.created/updated/deleted` maintain a lightweight in-memory cache
 *     of thought/link records so already-visible entities update in place;
 *   * `thought.updated` is ignored when the event version is not newer than the
 *     locally known version (stale delivery);
 *   * `thought.deleted` prunes the entity from cache, removes it from the local
 *     focus history (every profile) and reports `focus-lost` when it was the
 *     current focus;
 *   * `network.deleted` / self `member.removed` report `network-lost`;
 *   * everything else is passed through unchanged for the renderer.
 *
 * The applier is pure state + callbacks: it never touches the network, and the
 * renderer remains the sole owner of what is displayed.
 */

import type { AnyRealtimeEvent, Link, Thought } from '@etn/shared';

/** Callbacks the applier needs from the main process (test-friendly). */
export interface ApplierHooks {
  /** Installation Client-Id used for echo suppression. */
  getClientId: () => string;
  /** Current user id (for self `member.removed` detection). */
  getCurrentUserId: () => string | null;
  /** Remove a thought from every profile's focus history (L4 cleanup). */
  removeFromFocusHistoryEverywhere: (thoughtId: string) => void;
  /** Current focus thought id (ui_state L4), or null. */
  getCurrentFocusId: (networkId: string) => string | null;
}

/** What the applier did with a single event. */
export interface ApplyResult {
  /** True when the event was accepted (not an echo, not stale). */
  applied: boolean;
  /** 'none' | 'focus-lost' | 'network-lost' — renderer-level side effects. */
  effect: 'none' | 'focus-lost' | 'network-lost';
}

/** In-memory cache of known thoughts/links (per network). */
export class RealtimeState {
  private readonly thoughts = new Map<string, Thought>();
  private readonly links = new Map<string, Link>();

  public getThought(id: string): Thought | null {
    return this.thoughts.get(id) ?? null;
  }

  public setThought(thought: Thought): void {
    this.thoughts.set(thought.id, thought);
  }

  public deleteThought(id: string): void {
    this.thoughts.delete(id);
  }

  public getLink(id: string): Link | null {
    return this.links.get(id) ?? null;
  }

  public setLink(link: Link): void {
    this.links.set(link.id, link);
  }

  public deleteLink(id: string): void {
    this.links.delete(id);
  }
}

/**
 * Apply a single realtime event to {@link RealtimeState}, invoking hooks for
 * side effects. Returns what happened so the caller can decide on forwarding.
 */
export function applyRealtimeEvent(
  state: RealtimeState,
  hooks: ApplierHooks,
  event: AnyRealtimeEvent,
): ApplyResult {
  // A deleted thought must leave the local focus history no matter who removed
  // it — including this client's own echoes (echo suppression below skips the
  // rest of the handling for own writes, but the history prune is a local
  // sync, not a cache mutation).
  if (event.type === 'thought.deleted') {
    hooks.removeFromFocusHistoryEverywhere(event.data.id);
  }

  // Echo suppression (11-settings-and-state.md §1.4): never re-apply own writes.
  if (event.actor.client_id && event.actor.client_id === hooks.getClientId()) {
    return { applied: false, effect: 'none' };
  }

  switch (event.type) {
    case 'thought.created': {
      state.setThought(event.data.thought);
      return { applied: true, effect: 'none' };
    }
    case 'thought.updated': {
      const current = state.getThought(event.data.id);
      if (current && event.data.version <= current.version) {
        return { applied: false, effect: 'none' }; // stale delivery
      }
      if (current) {
        state.setThought({ ...current, ...event.data.changes, version: event.data.version });
      }
      return { applied: true, effect: 'none' };
    }
    case 'thought.deleted': {
      // Focus-history prune already ran above (it must run for own echoes too).
      state.deleteThought(event.data.id);
      const effect =
        hooks.getCurrentFocusId(event.network_id) === event.data.id ? 'focus-lost' : 'none';
      return { applied: true, effect };
    }
    case 'link.created': {
      state.setLink(event.data.link);
      return { applied: true, effect: 'none' };
    }
    case 'link.updated': {
      const current = state.getLink(event.data.id);
      if (current) {
        state.setLink({ ...current, ...event.data.changes, version: event.data.version });
      }
      return { applied: true, effect: 'none' };
    }
    case 'link.deleted': {
      state.deleteLink(event.data.id);
      return { applied: true, effect: 'none' };
    }
    case 'network.deleted': {
      return { applied: true, effect: 'network-lost' };
    }
    case 'member.removed': {
      const effect = hooks.getCurrentUserId() === event.data.user_id ? 'network-lost' : 'none';
      return { applied: true, effect };
    }
    default: {
      // comments, attachments, types, user-* settings, presence — forwarded
      // as-is; the renderer owns their application to UI state.
      return { applied: true, effect: 'none' };
    }
  }
}
