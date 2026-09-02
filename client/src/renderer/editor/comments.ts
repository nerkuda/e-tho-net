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
import { requireNetworkId } from '../app.js';
import { store } from '../state.js';
import { registerMainSection, type EditorContext } from './editor.js';
import { createMarkdownField } from './markdown-field.js';
import { registerChronoTab } from './chrono-tab.js';

/** Registers the permanent-comment section and the «Хроника» tab (L7). */
export function registerCommentSections(): void {
  registerMainSection((ctx) => ({
    id: 'permanent',
    title: 'Комментарий',
    buildBody: () => buildPermanentBody(ctx),
  }));
  registerChronoTab();
}

/** Builds the permanent-comment group body (HTML view ↔ markdown edit). */
function buildPermanentBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('comment-permanent');
  box.append(el('span', 'muted', 'Загрузка…'));

  let permanent: Comment | null = null;
  let field: HTMLElement | null = null;

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
