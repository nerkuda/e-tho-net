/**
 * Editor: the permanent comment (H9, 08-ui-spec.md §6.3.1, §6.4;
 * 09-scenarios.md D1).
 *
 * A collapsible group of the «Основное» tab. View mode renders the
 * server-produced `body_html`; edit mode uses a textarea over `body_md`; save
 * creates or updates the permanent comment (`If-Match` on update). Applies to
 * thoughts and links; the canvas 📝 indicator cache is invalidated after every
 * change. Chronological comments live in the «Хроника» tab (chrono-tab.ts).
 */

import type { Comment } from '@etn/shared';

import { invalidateIndicators } from '../canvas/canvas.js';
import {
  clearDraft,
  findDraft,
  saveDraft,
  type DraftKind,
} from '../drafts.js';
import { div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { requireNetworkId } from '../app.js';
import { registerMainSection, type EditorContext } from './editor.js';
import { createMarkdownField, editMarkdownField } from './markdown-field.js';
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

  /** Re-opens the editor with a saved draft if one exists. */
  async function restoreDraftIfAny(): Promise<void> {
    if (field === null) return;
    const update = await findDraft(networkId, 'comment', permanent?.id ?? ctx.ownerId);
    const created = await findDraft(networkId, 'comment-new', ctx.ownerId);
    const hit = update ?? created;
    if (hit === null) return;
    draftId = hit.id;
    draftKind = created !== null ? 'comment-new' : 'comment';
    const body = created !== null ? safeParseBody(created.value) : hit.value;
    editMarkdownField(field, body);
    notice('Восстановлен несохранённый черновик комментария.');
  }

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
      onInput: (md) => scheduleDraft(md),
      onSave: async (md) => {
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
        invalidateIndicators(ctx.ownerId);
        return html;
      },
    });
    box.replaceChildren(field);
    await restoreDraftIfAny();
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
