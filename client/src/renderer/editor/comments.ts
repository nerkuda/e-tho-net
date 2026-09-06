/**
 * Editor: the permanent comment (H9, 08-ui-spec.md §6.3.1, §6.4;
 * 09-scenarios.md D1).
 *
 * A collapsible group of the «Основное» tab. View mode renders the
 * server-produced `body_html`; edit mode uses a textarea over `body_md`; save
 * creates or updates the permanent comment (`If-Match` on update). Applies to
 * thoughts and links; the canvas 📝 indicator cache is invalidated after every
 * change. The field always opens in view mode — a saved draft never forces
 * editing (stale drafts whose text matches the saved value are dropped);
 * editing starts on double-click only (08-ui-spec.md §6.4). Chronological
 * comments live in the «Хроника» tab (chrono-tab.ts).
 */

import type { Comment } from '@etn/shared';

import { invalidateIndicators } from '../canvas/canvas.js';
import {
  clearDraft,
  clearDraftsFor,
  findDraft,
  saveDraft,
  type DraftKind,
} from '../drafts.js';
import { div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { acquireOrShowBlocked, lockHandleFromOutcome, releaseHeld, type LockHandle } from '../lib/lock-guard.js';
import { logUiEvent } from '../lib/ui-log.js';
import { requireNetworkId } from '../app.js';
import { onRealtimeEvent } from '../realtime.js';
import { store } from '../state.js';
import { registerMainSection, type EditorContext } from './editor.js';
import { createMarkdownField, setMarkdownField } from './markdown-field.js';
import { registerChronoTab } from './chrono-tab.js';

/** Reference to the currently mounted permanent-comment field, if any. */
let mountedPermanent:
  | { field: HTMLElement; ctx: EditorContext; isEdit: () => boolean; getPermanent: () => Comment | null; setPermanent: (c: Comment | null) => void }
  | null = null;

let realtimeWired = false;

/**
 * Updates the mounted permanent-comment field when a foreign `comment.*` event
 * arrives for its owner entity. Skips the update while the user is actively
 * editing (the in-flight text wins until the next save per 04-realtime.md §8,
 * last-write-wins on a field). Registered once on the first mount of the
 * section — bug 206e33a1 «Бессмысленное обновление редактора при получении
 * внешних событий»: comment events must NOT bubble up to a focus refresh
 * (realtime-ui.ts drops `scheduleRefresh` for them) and must NOT trigger a
 * full editor rebuild while the user is typing.
 */
function wireCommentRealtime(): void {
  if (realtimeWired) return;
  realtimeWired = true;
  onRealtimeEvent((evt) => {
    if (evt.type === 'comment.created') {
      const ref = mountedPermanent;
      if (ref === null) return;
      // The field handle may have been replaced by a newer editor mount
      // between the event arrival and the synchronous handler — check that
      // it's still in the DOM before touching it.
      if (!ref.field.isConnected) return;
      const c = evt.data.comment;
      if (c.kind !== 'permanent') return;
      if (c.owner_type !== ref.ctx.ownerType) return;
      if (c.owner_id !== ref.ctx.ownerId) return;
      if (ref.isEdit()) return;
      ref.setPermanent(c);
      return;
    }
    if (evt.type === 'comment.updated') {
      const ref = mountedPermanent;
      if (ref === null) return;
      if (!ref.field.isConnected) return;
      const networkId = store.state.networkId;
      if (networkId === null) return;
      // Resolve the updated comment owner — the event carries no owner field
      // (04-realtime.md §4.4, L20 multi-target comments); a quick fetch by id
      // matches the local permanent comment by id.
      void (async () => {
        try {
          const comments = await etn.comments.list(networkId, ref.ctx.ownerType, ref.ctx.ownerId);
          const updated = comments.find((c) => c.kind === 'permanent' && c.id === evt.data.id);
          if (updated === undefined) return;
          if (!ref.field.isConnected) return;
          if (ref.isEdit()) return;
          // Don't clobber a freshly typed value: only sync if the current
          // draft-free view text matches the previous known body.
          const current = ref.getPermanent();
          if (current !== null && updated.id === current.id && updated.version <= current.version) {
            return;
          }
          ref.setPermanent(updated);
        } catch {
          // The network was probably closed mid-flight — ignore.
        }
      })();
      return;
    }
    if (evt.type === 'comment.deleted') {
      const ref = mountedPermanent;
      if (ref === null) return;
      if (!ref.field.isConnected) return;
      const d = evt.data;
      if (d.owner_type !== ref.ctx.ownerType) return;
      if (d.owner_id !== ref.ctx.ownerId) return;
      if (ref.isEdit()) return;
      const current = ref.getPermanent();
      if (current === null || current.id !== d.id) return;
      ref.setPermanent(null);
      return;
    }
  });
}

/** Registers the permanent-comment section and the «Хроника» tab (L7). */
export function registerCommentSections(): void {
  registerMainSection((ctx) => ({
    id: 'permanent',
    title: 'Комментарий',
    buildBody: () => buildPermanentBody(ctx),
  }));
  registerChronoTab();
  wireCommentRealtime();
}

/** Builds the permanent-comment group body (HTML view ↔ markdown edit). */
function buildPermanentBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const startedAt = Date.now();
  const box = div('comment-permanent');
  box.append(el('span', 'muted', 'Загрузка…'));

  let permanent: Comment | null = null;
  let field: HTMLElement | null = null;
  let isEditing = false;
  // Object lock acquired on entering edit mode (task 4f141756 — auto-acquire
  // for the permanent-comment editor). The owner can carry the lock across
  // save → edit-again because release only fires when leaving edit mode.
  let editLock: LockHandle | null = null;
  const setEditing = (next: boolean): void => {
    if (next === isEditing) return;
    isEditing = next;
    if (next) {
      // Fire-and-forget: the helper surfaces its own notice on LOCKED, and
      // the editor stays editable so the user can still read the comment
      // (writes would 409 server-side, which is handled in `onSave`).
      void acquireOrShowBlocked(ctx.ownerType, ctx.ownerId).then((outcome) => {
        editLock = lockHandleFromOutcome(ctx.ownerType, ctx.ownerId, outcome);
      });
    } else {
      void releaseHeld(editLock);
      editLock = null;
    }
  };
  // Publish a handle for the realtime listener: the same identity is replaced
  // on every editor rebuild so the listener always addresses the live field.
  const ref = {
    field: null as HTMLElement | null,
    ctx,
    isEdit: () => isEditing,
    getPermanent: (): Comment | null => permanent,
    setPermanent: (c: Comment | null): void => {
      if (field === null) return;
      setMarkdownField(field, c?.body_md ?? '', c?.body_html ?? '');
      permanent = c;
    },
  };

  // Draft mirroring (H19): the in-progress markdown is saved locally and
  // cleared after a successful send; an existing draft re-opens the editor.
  let draftId: string | null = null;
  let draftTimer: number | null = null;
  let draftKind: DraftKind = 'comment-new';

  const scheduleDraft = (md: string): void => {
    if (draftTimer !== null) window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => {
      void (async () => {
        const value =
          draftKind === 'comment-new'
            ? JSON.stringify({ ownerType: ctx.ownerType, ownerId: ctx.ownerId, bodyMd: md })
            : md;
        draftId = await saveDraft({
          networkId,
          entityType: draftKind,
          entityId: draftKind === 'comment-new' ? ctx.ownerId : (permanent?.id ?? ctx.ownerId),
          field: 'body_md',
          value,
          baseVersion: permanent?.version ?? null,
        });
      })();
    }, 800);
  };

  /**
   * Drops stale drafts whose text already matches the saved value — they are
   * left behind when the debounced draft save fires after the blur save (the
   * field is rebuilt by then, so the draft is never cleared). Real drafts are
   * left alone: they are re-sent by the retry loop on reconnect (H19).
   * The editor never forces edit mode for a newly opened entity — the comment
   * always opens in view mode (08-ui-spec.md §6.4), editing starts on a
   * double-click only.
   */
  async function cleanupStaleDrafts(): Promise<void> {
    if (field === null) return;
    const update = await findDraft(networkId, 'comment', permanent?.id ?? ctx.ownerId);
    const created = await findDraft(networkId, 'comment-new', ctx.ownerId);
    if (update !== null && permanent !== null && update.value === permanent.body_md) {
      await clearDraft(update.id);
    }
    if (created !== null && permanent !== null && safeParseBody(created.value) === permanent.body_md) {
      await clearDraft(created.id);
    }
  }

  /** Cancels the pending draft mirror (save/cancel paths must not fire it). */
  const cancelDraftTimer = (): void => {
    if (draftTimer !== null) window.clearTimeout(draftTimer);
    draftTimer = null;
  };

  void (async () => {
    let comments: Comment[];
    try {
      comments = await etn.comments.list(networkId, ctx.ownerType, ctx.ownerId);
    } catch (err) {
      box.replaceChildren(span(`Не удалось загрузить: ${errText(err)}`, 'error-text'));
      return;
    }
    permanent = comments.find((c) => c.kind === 'permanent') ?? null;
    draftKind = permanent === null ? 'comment-new' : 'comment';

    field = createMarkdownField({
      md: permanent?.body_md ?? '',
      html: permanent?.body_html ?? '',
      attachmentsOwner: { ownerType: ctx.ownerType, ownerId: ctx.ownerId },
      // Контекст комментария для флоу «создать мысль по legacy-ссылке»
      // (карточка ETN 34ffbd75): владелец — родитель создаваемой мысли.
      commentContext: {
        ownerType: ctx.ownerType,
        ownerId: ctx.ownerId,
        commentKind: 'permanent',
        getCommentId: () => permanent?.id ?? null,
      },
      // Шаблон комментария типа мысли (08-ui-spec.md §6.4): когда у
      // редактируемой мысли есть тип с непустым `comment_template_md`,
      // контекстное меню редактора предлагает «Вставить текст шаблона из
      // типа мысли». Для связи команда не показывается (комментарий
      // связи не наследует тип).
      onInsertTemplate: (): string | null => {
        if (ctx.ownerType !== 'thought' || ctx.thought === null) return null;
        const typeId = ctx.thought.type_id;
        if (typeId === null) return null;
        const t = store.state.thoughtTypes.find((x) => x.id === typeId);
        return t?.comment_template_md ?? null;
      },
      // Track edit state so the realtime hook (see `wireCommentRealtime`) can
      // tell when a `comment.*` event should NOT clobber the in-progress
      // text (bug 206e33a1). Initial state is view mode, so the first
      // transition fires `onEditChange(true)`; subsequent saves/cancels
      // toggle back to `false`.
      onEditChange: (editing) => setEditing(editing),
      onInput: (md) => scheduleDraft(md),
      onSave: async (md) => {
        // The blur save settles the edit — the pending debounce must not
        // mirror it into a stale draft afterwards.
        cancelDraftTimer();
        let html: string;
        if (permanent === null) {
          if (md.trim() === '') {
            html = '';
          } else {
            const created = await etn.comments.create(networkId, ctx.ownerType, ctx.ownerId, {
              kind: 'permanent',
              body_md: md,
            });
            permanent = created;
            draftKind = 'comment';
            html = created.body_html;
          }
        } else {
          const updated = await etn.comments.update(
            networkId,
            permanent.id,
            { body_md: md },
            permanent.version,
          );
          permanent = updated;
          html = updated.body_html;
        }
        await clearDraft(draftId);
        draftId = null;
        // Sweep by key: a debounce that resolved after the blur would
        // otherwise leave a row behind (its id never reached `draftId`).
        await clearDraftsFor(networkId, 'comment', permanent?.id ?? ctx.ownerId);
        await clearDraftsFor(networkId, 'comment-new', ctx.ownerId);
        invalidateIndicators(ctx.ownerId);
        return html;
      },
      onCancel: () => {
        // Esc: the edit is dropped — neither the pending timer nor the saved
        // draft mirror of the cancelled text is wanted.
        cancelDraftTimer();
        if (draftId !== null) {
          void clearDraft(draftId);
          draftId = null;
        }
      },
    });
    box.replaceChildren(field);
    // Publish the field handle for the realtime hook (bug 206e33a1). Done
    // AFTER the field is in the DOM so the real one is what the hook sees;
    // any earlier call would have updated a field that is no longer mounted.
    mountedPermanent = { ...ref, field };
    // Milestone journal mark (task 92b89e6f): the comment really rendered —
    // the closing bracket of the «stuck "Загрузка…"» symptom path.
    logUiEvent('ui.editor.comment.loaded', {
      id: ctx.ownerId,
      kind: ctx.ownerType,
      ms: Date.now() - startedAt,
      hasComment: permanent !== null,
    });
    await cleanupStaleDrafts();
  })();

  return box;
}

/** Extracts `bodyMd` from a `comment-new` draft JSON value. */
function safeParseBody(value: string): string {
  try {
    const parsed = JSON.parse(value) as { bodyMd?: unknown };
    return typeof parsed.bodyMd === 'string' ? parsed.bodyMd : '';
  } catch {
    return '';
  }
}
