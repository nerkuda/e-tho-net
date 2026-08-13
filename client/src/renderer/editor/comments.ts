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
import { confirmDialog, errorDialog, field, showDialog } from '../lib/dialog.js';
import { button, clear, div, el, errText, fmtDate, renderHtml, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { requireNetworkId } from '../app.js';
import { registerGroupBuilder, type EditorContext } from './editor.js';

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
    title: 'Постоянный комментарий',
    buildBody: () => buildPermanentBody(ctx),
  }));
  registerGroupBuilder((ctx) => ({
    id: 'chrono',
    title: 'Хронологические комментарии',
    buildBody: () => buildChronoBody(ctx),
  }));
}

// ---------------------------------------------------------------------------
// Permanent comment
// ---------------------------------------------------------------------------

/** Builds the permanent-comment group body (view/edit toggle). */
function buildPermanentBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('comment-permanent');

  const view = div('comment-view');
  const editBox = div('comment-edit hidden');
  const textarea = el('textarea', 'textarea-input');
  textarea.rows = 10;
  editBox.append(textarea);

  const saveBtn = button('Сохранить', () => void save(), 'btn small primary');
  const cancelBtn = button('Отмена', () => showView(), 'btn small');
  editBox.append(saveBtn, cancelBtn);

  box.append(view, editBox);
  void reload();

  /** Loads the permanent comment into the view. */
  async function reload(): Promise<void> {
    view.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let permanent: Comment | null = null;
    try {
      const comments = await etn.comments.list(networkId, ctx.ownerType, ctx.ownerId);
      permanent = comments.find((c) => c.kind === 'permanent') ?? null;
    } catch (err) {
      view.replaceChildren(span(`Не удалось загрузить: ${errText(err)}`, 'error-text'));
      return;
    }
    view.replaceChildren();
    if (permanent === null) {
      view.append(span('Постоянного комментария нет.', 'muted'));
      const editButton = button('Добавить', () => showEdit(''), 'link-btn');
      view.append(editButton);
      return;
    }
    if (permanent.body_html === '') {
      view.append(span('Комментарий пуст.', 'muted'));
    } else {
      renderHtml(view, permanent.body_html);
    }
    const editButton = button('Редактировать', () => showEdit(permanent?.body_md ?? ''), 'link-btn');
    view.append(editButton);
  }

  function showView(): void {
    editBox.classList.add('hidden');
    view.classList.remove('hidden');
    void reload();
  }

  function showEdit(bodyMd: string): void {
    view.classList.add('hidden');
    editBox.classList.remove('hidden');
    textarea.value = bodyMd;
    textarea.focus();
  }

  /** Saves the edited markdown (create or update). */
  async function save(): Promise<void> {
    try {
      const comments = await etn.comments.list(networkId, ctx.ownerType, ctx.ownerId);
      const permanent = comments.find((c) => c.kind === 'permanent');
      if (permanent === undefined) {
        if (textarea.value.trim() === '') {
          showView();
          return;
        }
        await etn.comments.create(networkId, ctx.ownerType, ctx.ownerId, {
          kind: 'permanent',
          body_md: textarea.value,
        });
      } else {
        await etn.comments.update(networkId, permanent.id, { body_md: textarea.value }, permanent.version);
      }
      invalidateIndicators(ctx.ownerId);
      showView();
    } catch (err) {
      errorDialog('Постоянный комментарий', err);
    }
  }

  return box;
}

// ---------------------------------------------------------------------------
// Chronological comments
// ---------------------------------------------------------------------------

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
  }

  /** Opens the add/edit dialog for a chronological comment. */
  function openDialog(existing: Comment | null): void {
    const titleInput = el('input', 'text-input');
    titleInput.type = 'text';
    titleInput.value = existing?.title ?? '';
    titleInput.maxLength = 200;
    const text = el('textarea', 'textarea-input');
    text.rows = 6;
    text.value = existing?.body_md ?? '';
    const fromInput = el('input', 'text-input');
    fromInput.type = 'date';
    fromInput.value = existing?.valid_from.slice(0, 10) ?? todayIso();
    const toInput = el('input', 'text-input');
    toInput.type = 'date';
    toInput.value = existing?.valid_to?.slice(0, 10) ?? todayIso();
    const errorLine = span('', 'error-text');
    const body = div('form-stack');
    body.append(
      field('Заголовок', titleInput),
      field('Текст (markdown)', text),
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
                        await etn.comments.remove(networkId, existing.id, existing.version);
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
          onClick: (close) => {
            void (async () => {
              const validTo = toInput.value === '' ? null : toInput.value;
              try {
                if (existing === null) {
                  await etn.comments.create(networkId, ctx.ownerType, ctx.ownerId, {
                    kind: 'chronological',
                    title: titleInput.value.trim() || null,
                    body_md: text.value,
                    valid_from: fromInput.value,
                    valid_to: validTo,
                  });
                } else {
                  await etn.comments.update(
                    networkId,
                    existing.id,
                    {
                      title: titleInput.value.trim() || null,
                      body_md: text.value,
                      valid_from: fromInput.value,
                      valid_to: validTo,
                    },
                    existing.version,
                  );
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
  const plain = markdown.replace(/[#*_>`[\]]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
}
