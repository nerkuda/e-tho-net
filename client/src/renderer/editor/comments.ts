/**
 * Editor groups: permanent and chronological comments (H9, 08-ui-spec.md §6.3,
 * §6.4, §6.6; 09-scenarios.md D1, D2).
 *
 * - Permanent comment: view mode renders the server-produced `body_html`;
 *   edit mode uses a textarea over `body_md`; save creates or updates the
 *   permanent comment (`If-Match` on update).
 * - Chronological comments: table (title, С/По dates, short text) with an
 *   add/edit dialog; default dates = today.
 *
 * Both groups apply to thoughts and links. Indicator caches are invalidated
 * after every change so the canvas 📝/📅 counts stay fresh.
 */

import type { Comment } from '@etn/shared';

import { invalidateIndicators } from '../canvas/canvas.js';
import {
  canSave,
  clearDraft,
  findDraft,
  offlineNotice,
  saveDraft,
  type DraftKind,
} from '../drafts.js';
import { confirmDialog, errorDialog, field, showDialog } from '../lib/dialog.js';
import { button, clear, div, el, errText, fmtDate, renderHtml, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { requireNetworkId } from '../app.js';
import { registerGroupBuilder, type EditorContext } from './editor.js';
import { createMarkdownField, editMarkdownField } from './markdown-field.js';

/** Local today in YYYY-MM-DD (input[type=date] format). */
function todayIso(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Registers both comment groups for the editor. */
export function registerCommentGroups(): void {
  registerGroupBuilder((ctx) => ({
    id: 'permanent',
    title: 'Комментарий',
    buildBody: () => buildPermanentBody(ctx),
  }));
  registerGroupBuilder((ctx) => ({
    id: 'chrono',
    title: 'Хронологические комментарии',
    defaultCollapsed: true,
    loadCount: () => countChronological(ctx),
    buildBody: () => buildChronoBody(ctx),
  }));
}

// ---------------------------------------------------------------------------
// Permanent comment
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Chronological comments
// ---------------------------------------------------------------------------

/** Counts chronological comments for the group badge. */
async function countChronological(ctx: EditorContext): Promise<string | undefined> {
  const networkId = requireNetworkId();
  try {
    const comments = await etn.comments.list(networkId, ctx.ownerType, ctx.ownerId);
    return `(${comments.filter((c) => c.kind === 'chronological').length})`;
  } catch {
    return undefined;
  }
}

/** Builds the chronological-comments group body (table + dialog). */
function buildChronoBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('comment-chrono');
  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '300px';
  box.append(tableWrap);

  void reload();

  /** Loads and renders the chronological table. */
  async function reload(): Promise<void> {
    tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let comments: Comment[];
    try {
      comments = await etn.comments.list(networkId, ctx.ownerType, ctx.ownerId);
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    const chrono = comments.filter((c) => c.kind === 'chronological');
    const table = el('table', 'table-list');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th', undefined, 'Заголовок'),
      el('th', undefined, 'С'),
      el('th', undefined, 'По'),
      el('th', undefined, 'Кратко'),
    );
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    if (chrono.length === 0) {
      const row = el('tr');
      const cell = el('td', 'muted', 'Комментариев нет.');
      cell.colSpan = 4;
      row.append(cell);
      tbody.append(row);
    } else {
      for (const comment of chrono) {
        const row = el('tr');
        row.append(
          el('td', undefined, comment.title ?? '—'),
          el('td', undefined, fmtDate(comment.valid_from)),
          el('td', undefined, comment.valid_to === null ? '…' : fmtDate(comment.valid_to)),
          el('td', undefined, shortText(comment.body_md)),
        );
        row.addEventListener('dblclick', () => void openDialog(comment));
        tbody.append(row);
      }
    }
    table.append(tbody);
    clear(tableWrap);
    tableWrap.append(table);
    // Tell the group header to refresh its count badge (08-ui-spec.md §6.3).
    box.closest('.group')?.dispatchEvent(new CustomEvent('etn:refresh-count'));
  }

  /** Opens the add/edit dialog for a chronological comment. */
  function openDialog(existing: Comment | null): void {
    const titleInput = el('input', 'text-input');
    titleInput.type = 'text';
    titleInput.value = existing?.title ?? '';
    titleInput.maxLength = 200;
    const fromInput = el('input', 'text-input');
    fromInput.type = 'date';
    fromInput.value = existing?.valid_from.slice(0, 10) ?? todayIso();
    const toInput = el('input', 'text-input');
    toInput.type = 'date';
    toInput.value = existing?.valid_to?.slice(0, 10) ?? todayIso();
    const errorLine = span('', 'error-text');
    // The text is a markdown-field in both modes: double-click edits, leaving
    // the field autosaves body_md and returns to the HTML view. For a NEW
    // comment the first non-empty blur creates it (with the current dates), so
    // «Сохранить» afterwards just updates the metadata. `commentId`/`version`
    // are shared with the dialog buttons so autosaves never desync the version.
    let currentMd = existing?.body_md ?? '';
    let commentId: string | null = existing?.id ?? null;
    let version = existing?.version ?? 0;
    let textWidget: HTMLElement;
    if (existing !== null) {
      textWidget = createMarkdownField({
        md: existing.body_md,
        html: existing.body_html,
        attachmentsOwner: { ownerType: ctx.ownerType, ownerId: ctx.ownerId },
        onInput: (md) => {
          currentMd = md;
        },
        onSave: async (md) => {
          const cid = commentId;
          if (cid === null) return '';
          const updated = await etn.comments.update(networkId, cid, { body_md: md }, version);
          version = updated.version;
          currentMd = md;
          invalidateIndicators(ctx.ownerId);
          return updated.body_html;
        },
      });
    } else {
      textWidget = createMarkdownField({
        md: '',
        html: '',
        attachmentsOwner: { ownerType: ctx.ownerType, ownerId: ctx.ownerId },
        onInput: (md) => {
          currentMd = md;
        },
        onSave: async (md) => {
          if (md.trim() === '') return '';
          let html: string;
          if (commentId === null) {
            const created = await etn.comments.create(networkId, ctx.ownerType, ctx.ownerId, {
              kind: 'chronological',
              title: titleInput.value.trim() || null,
              body_md: md,
              valid_from: fromInput.value,
              valid_to: toInput.value === '' ? null : toInput.value,
            });
            commentId = created.id;
            version = created.version;
            html = created.body_html;
          } else {
            const updated = await etn.comments.update(networkId, commentId, { body_md: md }, version);
            version = updated.version;
            html = updated.body_html;
          }
          invalidateIndicators(ctx.ownerId);
          return html;
        },
      });
      // A new comment starts in edit mode.
      editMarkdownField(textWidget);
    }
    const body = div('form-stack');
    body.append(
      field('Заголовок', titleInput),
      field('Текст', textWidget),
      field('Дата начала', fromInput),
      field('Дата окончания (пусто = бессрочно)', toInput),
      errorLine,
    );

    showDialog({
      title: existing === null ? 'Добавить хронологический комментарий' : 'Изменить комментарий',
      body,
      width: 520,
      buttons: [
        ...(existing !== null
          ? [
              {
                label: 'Удалить',
                danger: true,
                keepOpen: true,
                onClick: (close: () => void) => {
                  void (async () => {
                    if (
                      await confirmDialog(
                        'Удалить комментарий',
                        'Удалить хронологический комментарий?',
                        true,
                      )
                    ) {
                      try {
                        // `version` (not `existing.version`): an autosave of the
                        // text may have bumped it while the dialog was open.
                        if (commentId !== null) {
                          await etn.comments.remove(networkId, commentId, version);
                        }
                        invalidateIndicators(ctx.ownerId);
                        close();
                        await reload();
                      } catch (err) {
                        errorLine.textContent = errText(err);
                      }
                    }
                  })();
                },
              },
            ]
          : []),
        { label: 'Отмена' },
        {
          label: 'Сохранить',
          primary: true,
          keepOpen: true,
          onClick: (close) => {
            void (async () => {
              const validTo = toInput.value === '' ? null : toInput.value;
              try {
                // The text may already be autosaved (and the comment created)
                // by the markdown field; then only the metadata is updated.
                if (commentId !== null) {
                  await etn.comments.update(
                    networkId,
                    commentId,
                    {
                      title: titleInput.value.trim() || null,
                      body_md: currentMd,
                      valid_from: fromInput.value,
                      valid_to: validTo,
                    },
                    version,
                  );
                } else {
                  await etn.comments.create(networkId, ctx.ownerType, ctx.ownerId, {
                    kind: 'chronological',
                    title: titleInput.value.trim() || null,
                    body_md: currentMd,
                    valid_from: fromInput.value,
                    valid_to: validTo,
                  });
                }
                invalidateIndicators(ctx.ownerId);
                close();
                await reload();
              } catch (err) {
                errorLine.textContent = errText(err);
              }
            })();
          },
        },
      ],
    });
  }

  const addRow = div('form-row');
  addRow.style.marginTop = '8px';
  addRow.append(button('Добавить', () => openDialog(null), 'btn small'));
  box.append(addRow);
  return box;
}

/** One-line preview of a comment body. */
function shortText(markdown: string): string {
  const plain = markdown
    .replace(/[#*_>`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
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
