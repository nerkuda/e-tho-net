/**
 * Read-only «Метаданные» block (задача 04cd9794 «Вкладка Метаданные и
 * колонки автора в Хронике», 08-ui-spec.md §6.4 / §8.4).
 *
 * Used in three places:
 *  1. editor's «Метаданные» tab (thought + link);
 *  2. inline block at the bottom of thought-type / link-type / network-property
 *     dialogs (no tab UI there — a flat section is enough).
 *
 * Layout: a single bordered group with four rows (автор создания / дата
 * создания / редактор / дата изменения) and an `id` row at the top with a
 * copy-to-clipboard button. `id === null` — a brand-new entity — shows the
 * placeholder «id будет присвоен при сохранении» instead of an empty box.
 *
 * Author names come from the user cache (best-effort — non-admins see the
 * raw id with a faint hint when the cache misses).
 */

import { button, div, el, setTooltip, span } from './dom.js';
import { notice } from './notice.js';
import { ensureLoaded, resolve, subscribe } from './users.js';

/** Plain record of authorship fields used by the block. */
export interface MetadataFields {
  /** `null` for a not-yet-persisted entity (the block then renders a hint). */
  id: string | null;
  /** Unix-миллисекунды `created_at`; falls back to ISO when missing. */
  createdAtMs: number | string | null;
  createdBy: string | null;
  /** Same as above for the latest edit. */
  updatedAtMs: number | string | null;
  updatedBy: string | null;
}

/** Builds the standalone «Метаданные» block; returns the root element. */
export function buildMetadataBlock(fields: MetadataFields): HTMLElement {
  ensureLoaded();
  const root = div('metadata-block');
  // Re-render the names when the user cache resolves a previously unknown id —
  // cheap because the same two cells are rewritten; the date/id rows are
  // untouched.
  const unsubscribe = subscribe(repaintNames);
  root.addEventListener('etn:metadata-dispose', unsubscribe);
  repaintNames();
  return root;

  function repaintNames(): void {
    root.replaceChildren();
    root.append(buildIdRow(fields.id));
    const grid = div('metadata-grid');
    grid.append(
      buildAuthorRow('Автор создания', fields.createdBy),
      buildDateRow('Дата создания', fields.createdAtMs),
      buildAuthorRow('Последний редактор', fields.updatedBy),
      buildDateRow('Дата изменения', fields.updatedAtMs),
    );
    root.append(grid);
  }
}

/** The id row: a monospace id + a copy button (or the «will be assigned» hint). */
function buildIdRow(id: string | null): HTMLElement {
  const row = div('metadata-id-row');
  const label = el('span', 'metadata-id-label', 'id');
  if (id === null) {
    const hint = el('span', 'muted metadata-id-hint', 'будет присвоен при сохранении');
    row.append(label, hint);
    return row;
  }
  const value = el('code', 'metadata-id-value', id);
  setTooltip(value, 'Нажмите, чтобы выделить');
  // Selectable by click — easier than picking the small text with the caret
  // when the user wants to copy manually. The button covers the explicit-copy
  // path.
  value.addEventListener('click', () => {
    const range = document.createRange();
    range.selectNodeContents(value);
    const sel = window.getSelection();
    if (sel !== null) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  const copyBtn = button(
    'Копировать',
    () => {
      void navigator.clipboard.writeText(id).then(
        () => notice('ID скопирован.'),
        () => notice('Не удалось скопировать ID.', 'error'),
      );
    },
    'btn small',
    'Скопировать ID в буфер обмена',
  );
  row.append(label, value, copyBtn);
  return row;
}

/** Builds one labelled metadata cell («label» / «value»). */
function buildFieldRow(label: string, value: string | number | null): HTMLElement {
  const row = div('metadata-field');
  row.append(el('span', 'metadata-field-label', label));
  const text = value === null || value === '' ? '—' : String(value);
  row.append(el('span', 'metadata-field-value', text));
  return row;
}

/** «Автор создания» / «Последний редактор» — резолвит id через кэш пользователей. */
function buildAuthorRow(label: string, userId: string | null): HTMLElement {
  const row = div('metadata-field');
  row.append(el('span', 'metadata-field-label', label));
  const text =
    userId === null || userId === '' ? '—' : resolve(userId) ?? `(${userId})`;
  row.append(el('span', 'metadata-field-value', text));
  return row;
}

/** «Дата создания» / «Дата изменения» — формат `yyyy-MM-dd hh:mm:ss`. */
function buildDateRow(label: string, value: number | string | null): HTMLElement {
  const row = div('metadata-field');
  row.append(el('span', 'metadata-field-label', label));
  row.append(el('span', 'metadata-field-value', formatDateTime(value)));
  return row;
}

/** Pads a 1- or 2-digit value to 2 digits (manual ISO-style formatting). */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Formats an ISO timestamp / unix-ms as `yyyy-MM-dd hh:mm:ss` (local time,
 * second precision). The fixed shape keeps the metadata block visually
 * consistent with chronological columns and avoids locale-specific quirks
 * like Russian dots in dates.
 */
export function formatDateTime(value: string | number | null): string {
  if (value === null || value === '') return '—';
  const date =
    typeof value === 'number'
      ? new Date(value)
      : new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/**
 * Same shape as {@link buildMetadataBlock} but pre-formatted for embedding
 * inside a dialog (no surrounding `.metadata-block` wrapper — the dialog
 * already groups fields). Used by the type / property editors.
 */
export function buildMetadataRows(fields: MetadataFields): HTMLElement {
  ensureLoaded();
  const root = div('metadata-rows');
  const unsubscribe = subscribe(repaint);
  root.addEventListener('etn:metadata-dispose', unsubscribe);
  repaint();
  return root;

  function repaint(): void {
    root.replaceChildren();
    root.append(buildIdRow(fields.id));
    root.append(
      buildAuthorRow('Автор создания', fields.createdBy),
      buildDateRow('Дата создания', fields.createdAtMs),
      buildAuthorRow('Последний редактор', fields.updatedBy),
      buildDateRow('Дата изменения', fields.updatedAtMs),
    );
  }
}

/**
 * Compact «author / last editor» pair used in the chrono column headers and
 * rows. When the author and editor are the same id (and known), only the
 * author is shown — saving horizontal space in dense tables.
 */
export function renderAuthorPair(
  createdBy: string | null,
  updatedBy: string | null,
  updatedAtMs: number | string | null,
  createdAtMs: number | string | null,
): HTMLElement {
  const wrap = div('author-pair');
  const sameUser =
    createdBy !== null && updatedBy !== null && createdBy === updatedBy &&
    updatedAtMs !== null && updatedAtMs !== '' &&
    createdAtMs !== null && createdAtMs !== '' &&
    (typeof updatedAtMs === 'number' ? updatedAtMs : Number(updatedAtMs)) !==
      (typeof createdAtMs === 'number' ? createdAtMs : Number(createdAtMs));
  const created = createdBy === null ? '—' : resolve(createdBy) ?? `(${createdBy})`;
  const editorName = updatedBy === null ? null : resolve(updatedBy) ?? `(${updatedBy})`;
  wrap.append(el('span', 'author-primary', created));
  if (editorName !== null && sameUser) {
    const badge = el('span', 'author-edited faint', `(правка: ${editorName})`);
    wrap.append(badge);
  } else if (editorName !== null) {
    const badge = el('span', 'author-edited faint', `(правка: ${editorName})`);
    wrap.append(badge);
  }
  return wrap;
}
