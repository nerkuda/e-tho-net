/**
 * Editor tab «Хроника (N)» — chronological comments (H9 → L7,
 * 08-ui-spec.md §6.6).
 *
 * Two areas separated by a splitter:
 *  - the table (title / С / По / short text, at most five visible rows,
 *    vertical scroll beyond that). Click selects a comment for viewing,
 *    double-click selects and enters edit mode; «Добавить» starts a new one.
 *  - the inline editor: compact metadata row (title, valid_from, valid_to) and
 *    a markdown field that behaves exactly like the permanent comment — HTML
 *    view, double-click edits, blur autosaves and returns to the view, Esc
 *    reverts. The first non-empty blur of a new comment creates it; metadata
 *    edits save on blur. «Удалить» removes the selected comment.
 *
 * The tab content is built only when the tab is active; the `(N)` badge in the
 * tab title is refreshed after every change.
 */

import type { Comment } from '@etn/shared';

import { requireNetworkId } from '../app.js';
import { invalidateIndicators } from '../canvas/canvas.js';
import { confirmDialog } from '../lib/dialog.js';
import { button, div, el, errText, fmtDate, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { formatDateTime, renderAuthorPair } from '../lib/metadata.js';
import { notice } from '../lib/notice.js';
import { refreshTabCount, registerTabContent, registerTabCount, type EditorContext } from './editor.js';
import { createMarkdownField, editMarkdownField } from './markdown-field.js';
import { rowSplitter } from './splitter.js';

/** Registers the «Хроника» tab content and its badge counter (L7). */
export function registerChronoTab(): void {
  registerTabContent('chrono', buildChronoTab);
  registerTabCount('chrono', async (ctx) => {
    try {
      const comments = await etn.comments.list(
        requireNetworkId(),
        ctx.ownerType,
        ctx.ownerId,
      );
      return comments.filter((c) => c.kind === 'chronological').length;
    } catch {
      return undefined;
    }
  });
}

/** Local today in YYYY-MM-DD (input[type=date] format). */
function todayIso(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Builds the whole «Хроника» tab pane content for the entity. */
function buildChronoTab(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const root = div('chrono-tab');

  const top = div('chrono-top');
  const toolbar = div('chrono-toolbar');
  toolbar.append(button('Добавить', () => startNew(), 'btn small'));
  const tableWrap = div('admin-table-wrap chrono-table');
  top.append(toolbar, tableWrap);

  const bottom = div('chrono-editor');
  root.append(
    top,
    // The drag is remembered as the table's max height (ee745368).
    rowSplitter(() => tableWrap, {
      min: 34,
      max: () => tableWrap.scrollHeight,
      persistKey: 'chrono',
    }),
    bottom,
  );

  let selectedId: string | null = null;
  /** Row elements of the current table, by comment id (highlight updates). */
  const rowById = new Map<string, HTMLTableRowElement>();
  /** Active sort column and direction (задача 04cd9794 «колонки автора в Хронике»). */
  type SortKey = 'created_at_ms' | 'updated_at_ms';
  type SortDir = 'asc' | 'desc';
  let sortKey: SortKey = 'created_at_ms';
  let sortDir: SortDir = 'desc';

  void reload();
  // The tab opens with an empty editor area — a comment is picked by a click
  // on a table row, a new one starts via «Добавить» (08-ui-spec.md §6.6).
  showEmptyEditor();

  /** Loads and renders the chronological table. */
  async function reload(keepSelection = true): Promise<void> {
    tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let comments: Comment[];
    try {
      comments = await etn.comments.list(networkId, ctx.ownerType, ctx.ownerId);
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    const chrono = comments.filter((c) => c.kind === 'chronological');
    if (!keepSelection || !chrono.some((c) => c.id === selectedId)) {
      selectedId = null;
    }
    refreshTabCount('chrono');

    // Сортировка по миллисекундным меткам (задача 04cd9794). Дефолт — DESC
    // по `created_at_ms` (новые сверху); фолбэк на ISO-парсинг, когда сервер
    // ещё не успел проставить `*_ms` для старых строк (миграция 033 их
    // бэкфилит, но на всякий случай — дешёвый парс).
    const sortValue = (c: Comment): number => {
      if (sortKey === 'updated_at_ms') {
        if (typeof c.updated_at_ms === 'number') return c.updated_at_ms;
        const t = Date.parse(c.updated_at);
        return Number.isNaN(t) ? 0 : t;
      }
      if (typeof c.created_at_ms === 'number') return c.created_at_ms;
      const t = Date.parse(c.created_at);
      return Number.isNaN(t) ? 0 : t;
    };
    const sorted = chrono.slice().sort((a, b) => {
      const diff = sortValue(a) - sortValue(b);
      return sortDir === 'desc' ? -diff : diff;
    });

    const table = el('table', 'table-list');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th', undefined, 'Заголовок'),
      el('th', undefined, 'С'),
      el('th', undefined, 'По'),
      sortableHeader('Автор', undefined, undefined),
      el('th', undefined, 'Создан'),
      sortableHeader('Изменён', 'updated_at_ms', 'updated'),
      el('th', undefined, 'Кратко'),
    );
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    rowById.clear();
    if (sorted.length === 0) {
      const row = el('tr');
      const cell = el('td', 'muted', 'Комментариев нет.');
      cell.colSpan = 7;
      row.append(cell);
      tbody.append(row);
    } else {
      for (const comment of sorted) {
        const row = el('tr');
        if (comment.id === selectedId) row.classList.add('selected');
        rowById.set(comment.id, row);
        const authorCell = el('td', 'author-cell');
        authorCell.append(
          renderAuthorPair(
            comment.created_by,
            comment.updated_by,
            comment.updated_at_ms ?? comment.updated_at,
            comment.created_at_ms ?? comment.created_at,
          ),
        );
        row.append(
          el('td', undefined, comment.title ?? '—'),
          el('td', undefined, fmtDate(comment.valid_from)),
          el('td', undefined, comment.valid_to === null ? '…' : fmtDate(comment.valid_to)),
          authorCell,
          el('td', 'date-cell', formatDateTime(comment.created_at_ms ?? comment.created_at)),
          el('td', 'date-cell', formatDateTime(comment.updated_at_ms ?? comment.updated_at)),
          el('td', undefined, shortText(comment.body_md)),
        );
        row.addEventListener('click', () => select(comment));
        row.addEventListener('dblclick', () => {
          select(comment, true);
        });
        tbody.append(row);
      }
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);

    /** A clickable header that toggles the chrono sort. */
    function sortableHeader(label: string, key: SortKey | undefined, hint: 'created' | 'updated' | undefined): HTMLTableCellElement {
      const th = el('th', 'sortable') as HTMLTableCellElement;
      const isActive = hint === 'updated' ? sortKey === 'updated_at_ms' : hint === undefined && sortKey === 'created_at_ms';
      th.append(el('span', undefined, label));
      if (isActive) th.append(el('span', 'sort-marker', sortDir === 'desc' ? ' ▼' : ' ▲'));
      th.addEventListener('click', () => {
        if (key === undefined) return; // не сортируемая колонка
        if (sortKey === key) {
          sortDir = sortDir === 'desc' ? 'asc' : 'desc';
        } else {
          sortKey = key;
          sortDir = key === 'updated_at_ms' ? 'desc' : 'desc';
        }
        void reload();
      });
      return th;
    }
  }

  /** Selects a comment for viewing (or viewing + editing on double-click). */
  function select(comment: Comment, edit = false): void {
    selectedId = comment.id;
    // A click does not change the data — only move the row highlight instead
    // of refetching the whole list (bug 2528f51b).
    setHighlight(comment.id);
    buildEditor(comment, edit);
  }

  /** Moves the `selected` highlight to the row, leaving the table intact. */
  function setHighlight(commentId: string | null): void {
    for (const row of rowById.values()) row.classList.remove('selected');
    if (commentId !== null) rowById.get(commentId)?.classList.add('selected');
  }

  /** Resets the editor area for a brand-new comment (edit mode at once). */
  function startNew(): void {
    selectedId = null;
    setHighlight(null);
    buildEditor(null, true);
  }

  /** Shows an empty editor area — nothing is selected yet (§6.6). */
  function showEmptyEditor(): void {
    selectedId = null;
    const hint = el('p', 'muted', 'Выберите комментарий из списка или нажмите «Добавить».');
    hint.style.margin = '0';
    const body = div('chrono-editor-body');
    body.append(hint);
    bottom.replaceChildren(body);
  }

  /**
   * Builds the inline editor area: metadata row + markdown field. `existing`
   * is null for a new comment; the first non-empty text blur creates it.
   */
  function buildEditor(existing: Comment | null, startEdit: boolean): void {
    const titleInput = el('input', 'text-input chrono-meta-input');
    titleInput.type = 'text';
    titleInput.value = existing?.title ?? '';
    titleInput.maxLength = 200;
    titleInput.placeholder = 'Заголовок';
    const fromInput = el('input', 'text-input chrono-meta-input');
    fromInput.type = 'date';
    fromInput.value = existing?.valid_from.slice(0, 10) ?? todayIso();
    const toInput = el('input', 'text-input chrono-meta-input');
    toInput.type = 'date';
    toInput.value = existing?.valid_to?.slice(0, 10) ?? '';

    let commentId: string | null = existing?.id ?? null;
    let version = existing?.version ?? 0;

    const metaRow = div('chrono-meta-row');
    metaRow.append(titleInput, fromInput, toInput);
    if (existing !== null) {
      metaRow.append(
        button(
          'Удалить',
          () => void removeComment(),
          'btn small danger',
          'Удалить хронологический комментарий',
        ),
      );
    }

    /** Saves the metadata fields of an existing comment. */
    const commitMeta = (): void => {
      if (commentId === null) return;
      void (async () => {
        try {
          const updated = await etn.comments.update(networkId, commentId!, {
            title: titleInput.value.trim() || null,
            valid_from: fromInput.value,
            valid_to: toInput.value === '' ? null : toInput.value,
          }, version);
          version = updated.version;
          invalidateIndicators(ctx.ownerId);
          await reload();
        } catch (err) {
          notice(`Не удалось сохранить: ${errText(err)}`, 'error');
        }
      })();
    };
    titleInput.addEventListener('blur', commitMeta);
    fromInput.addEventListener('blur', commitMeta);
    toInput.addEventListener('blur', commitMeta);

    const widget = createMarkdownField({
      md: existing?.body_md ?? '',
      html: existing?.body_html ?? '',
      attachmentsOwner: { ownerType: ctx.ownerType, ownerId: ctx.ownerId },
      // Контекст комментария для флоу «создать мысль по legacy-ссылке»
      // (карточка ETN 34ffbd75): после замены ссылок поле перерисовывается,
      // а таблица хроно — обновляет колонку «Кратко».
      commentContext: {
        ownerType: ctx.ownerType,
        ownerId: ctx.ownerId,
        commentKind: 'chronological',
        getCommentId: () => commentId,
        onLinksReplaced: () => void reload(),
      },
      onSave: async (md) => {
        if (md.trim() === '' && commentId === null) return '';
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
          selectedId = created.id;
          html = created.body_html;
        } else {
          const updated = await etn.comments.update(networkId, commentId, { body_md: md }, version);
          version = updated.version;
          html = updated.body_html;
        }
        invalidateIndicators(ctx.ownerId);
        await reload();
        return html;
      },
    });

    const body = div('chrono-editor-body');
    body.append(metaRow, widget);
    bottom.replaceChildren(body);
    if (startEdit) editMarkdownField(widget);
  }

  /** Deletes the selected comment (confirmation) and starts a new one. */
  async function removeComment(): Promise<void> {
    if (selectedId === null) return;
    const ok = await confirmDialog(
      'Удалить комментарий',
      'Удалить хронологический комментарий?',
      true,
    );
    if (!ok) return;
    try {
      // Remove by id: the version is re-read to survive intermediate autosaves.
      const comments = await etn.comments.list(networkId, ctx.ownerType, ctx.ownerId);
      const current = comments.find((c) => c.id === selectedId);
      if (current === undefined) return;
      await etn.comments.remove(networkId, current.id, current.version);
      invalidateIndicators(ctx.ownerId);
      startNew();
      await reload();
    } catch (err) {
      notice(`Не удалось удалить: ${errText(err)}`, 'error');
    }
  }

  return root;
}

/** One-line preview of a comment body. */
function shortText(markdown: string): string {
  const plain = markdown
    .replace(/[#*_>`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
}
