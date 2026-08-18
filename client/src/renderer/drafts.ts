/**
 * Drafts and offline handling (H19, 07-client-electron.md §5;
 * 09-scenarios.md J).
 *
 * - edits to the permanent comment body and the thought title are mirrored
 *   into the local `drafts` table while typing (debounced);
 * - on successful send the draft is deleted;
 * - while the realtime connection is down the UI blocks saves (the edit stays
 *   a draft, the status bar shows 🔴);
 * - on reconnect, pending drafts are re-sent automatically (idempotent
 *   `Client-Request-Id` machinery on the server prevents double-applies);
 *   version conflicts keep the draft and notify the user.
 */

import { errText } from './lib/dom.js';
import { etn } from './lib/etn.js';
import { notice } from './lib/notice.js';
import { isConnected } from './realtime.js';
import { store } from './state.js';

/** Draft entity types supported by the retry loop. */
export type DraftKind = 'comment' | 'comment-new' | 'thought';

/** A pending draft as returned by `ui.draftList`. */
export interface DraftRecord {
  id: string;
  networkId: string;
  entityType: string;
  entityId: string;
  field: string;
  value: string | null;
  baseVersion: number | null;
  status: string;
  createdAt: string;
}

let lastConnected = false;
let initialized = false;

/** Initializes the offline detection + retry loop. Called once at boot. */
export function initDrafts(): void {
  if (initialized) return;
  initialized = true;
  lastConnected = isConnected();
  store.subscribe(() => {
    const connected = isConnected();
    if (connected && !lastConnected) {
      notice('Соединение восстановлено.');
      void retryPendingDrafts();
    } else if (!connected && lastConnected && store.state.rtStatus === 'offline') {
      notice('Соединение потеряно — правки сохраняются как черновики.', 'error');
    }
    lastConnected = connected;
  });
}

/**
 * Saves (upserts) a draft for an edit in progress. Returns the draft id.
 */
export async function saveDraft(input: {
  networkId: string;
  entityType: DraftKind;
  entityId: string;
  field: string;
  value: string;
  baseVersion: number | null;
}): Promise<string> {
  return etn.ui.draftSave({
    networkId: input.networkId,
    entityType: input.entityType,
    entityId: input.entityId,
    field: input.field,
    value: input.value,
    baseVersion: input.baseVersion,
  });
}

/** Removes a draft (called after a successful send). */
export async function clearDraft(draftId: string | null): Promise<void> {
  if (draftId === null) return;
  try {
    await etn.ui.draftDelete(draftId);
  } catch {
    // best-effort cleanup
  }
}

/**
 * Finds the draft for a specific edit target, or null. Returns the newest
 * matching row together with the version it was based on, so callers can tell
 * a pending edit (base version still current) from a stale one.
 */
export async function findDraft(
  networkId: string,
  entityType: DraftKind,
  entityId: string,
): Promise<{ id: string; value: string; baseVersion: number | null } | null> {
  let drafts: DraftRecord[];
  try {
    drafts = (await etn.ui.draftList(networkId)) as DraftRecord[];
  } catch {
    return null;
  }
  const hits = drafts.filter(
    (d) => d.entityType === entityType && d.entityId === entityId && d.value !== null,
  );
  const hit = hits.at(-1);
  if (hit === undefined || hit.value === null) return null;
  return { id: hit.id, value: hit.value, baseVersion: hit.baseVersion };
}

/** True when saves are allowed right now (H19 blocking). */
export function canSave(): boolean {
  return isConnected();
}

/** Blocks a save while offline: notifies and keeps the draft. */
export function offlineNotice(): void {
  notice('Нет соединения — правка сохранена как черновик и отправится после восстановления связи.');
}

/** Re-sends every pending draft of the open network. */
export async function retryPendingDrafts(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  let drafts: DraftRecord[];
  try {
    drafts = (await etn.ui.draftList(networkId)) as DraftRecord[];
  } catch {
    return;
  }
  if (drafts.length === 0) return;
  for (const draft of drafts) {
    try {
      await sendDraft(draft);
    } catch (err) {
      notice(`Черновик не отправлен: ${errText(err)}`, 'error');
    }
  }
}

/** Sends one draft according to its entity type; deletes it on success. */
async function sendDraft(draft: DraftRecord): Promise<void> {
  const networkId = draft.networkId;
  const value = draft.value;
  if (value === null) {
    await etn.ui.draftDelete(draft.id);
    return;
  }
  switch (draft.entityType) {
    case 'comment': {
      if (draft.baseVersion === null) return; // cannot If-Match without a version
      await etn.comments.update(networkId, draft.entityId, { body_md: value }, draft.baseVersion);
      await etn.ui.draftDelete(draft.id);
      break;
    }
    case 'comment-new': {
      const parsed = JSON.parse(value) as {
        ownerType: 'thought' | 'link';
        ownerId: string;
        bodyMd: string;
      };
      await etn.comments.create(networkId, parsed.ownerType, parsed.ownerId, {
        kind: 'permanent',
        body_md: parsed.bodyMd,
      });
      await etn.ui.draftDelete(draft.id);
      break;
    }
    case 'thought': {
      if (draft.field !== 'title' || draft.baseVersion === null) return;
      await etn.thoughts.update(networkId, draft.entityId, { title: value }, draft.baseVersion);
      await etn.ui.draftDelete(draft.id);
      break;
    }
    default:
      break;
  }
}

/** Convenience import for tests without DOM usage. */
export function draftsEnabled(): boolean {
  return initialized;
}
