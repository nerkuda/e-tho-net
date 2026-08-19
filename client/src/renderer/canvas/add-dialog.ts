/**
 * Add-thought dialog (H14, 08-ui-spec.md §4; 09-scenarios.md C1, C2).
 *
 * Live duplicate search over `thoughts.findDuplicates`; single and batch
 * modes; `|` synonym parsing per line; multi-line paste auto-switches to batch
 * mode; Ctrl+Enter inserts everything; Ctrl+Shift+Enter also focuses the first
 * added thought (L19). Creation uses `thoughts.create` with `create_link`
 * (direction from the invoking gesture); picking an existing candidate creates
 * a plain link instead.
 *
 * Also handles the drop of files/URLs onto the canvas (08-ui-spec.md §7):
 * the zone drop handlers create thoughts with an attachment.
 */

import { scheduleRefresh, requireNetworkId, setFocus } from '../app.js';
import {
  applyThoughtIcon,
  invalidateRef,
  resolveCloudStyle,
  setAddDialogOpener,
} from '../canvas/canvas.js';
import { showDialog } from '../lib/dialog.js';
import { applyFontFlags, button, div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { parseAddLines, parseTitleWithSynonyms } from '../lib/pure.js';
import { createTypeCombobox } from '../lib/type-combobox.js';
import type { DuplicateHit } from '../../main/ipc/contract.js';
import { UI_STATE_KEY } from '@etn/shared';
import { store } from '../state.js';

/** One batch-mode line with its duplicate-check result. */
interface AddLine {
  raw: string;
  title: string;
  synonyms: string[];
  /** Candidate id when an exact title/synonym match was found. */
  existingId: string | null;
  /** Strongest candidate match kind (informational). */
  matchKind: 'title' | 'synonym' | 'partial' | null;
}

let mounted = false;

/** Mounts the dialog opener into the canvas drag gestures (called by the workspace). */
export function mountAddDialog(): void {
  if (mounted) return;
  mounted = true;
  setAddDialogOpener((ctx) => openAddDialog(ctx));
}

/**
 * Opens the add-thought dialog. `anchorId = null` disables link creation
 * (batch insert from the selection panel, H16).
 */
export function openAddDialog(ctx: {
  anchorId: string | null;
  direction: 'parent' | 'child';
}): void {
  const networkId = requireNetworkId();
  const anchorTitle = ctx.anchorId !== null ? (store.state.focus?.focused.title ?? '…') : '';

  let multi = false;
  const lines: AddLine[] = [];

  const modeRow = div('add-mode-row');
  const singleRadio = el('input');
  singleRadio.type = 'radio';
  singleRadio.name = 'add-mode';
  singleRadio.checked = true;
  const multiRadio = el('input');
  multiRadio.type = 'radio';
  multiRadio.name = 'add-mode';
  const singleLabel = el('label', 'checkbox-row');
  singleLabel.append(singleRadio, span('одна'));
  const multiLabel = el('label', 'checkbox-row');
  multiLabel.append(multiRadio, span('несколько'));
  modeRow.append(singleLabel, multiLabel);
  singleRadio.addEventListener('change', () => {
    multi = false;
    applyMode();
  });
  multiRadio.addEventListener('change', () => {
    multi = true;
    applyMode();
  });

  const lineList = div('add-list hidden');

  const input = el('textarea', 'textarea-input');
  input.rows = 2;
  input.placeholder = 'Введите название или вставьте список…';

  // Type of the created thought(s) — searchable picker over the catalogue
  // (L6): rows carry the type's icon and style.
  let newThoughtTypeId: string | null = null;
  const thoughtTypeCombo = createTypeCombobox({
    options: () =>
      store.state.thoughtTypes.map((t) => ({
        id: t.id,
        label: t.name,
        icon: { icon: t.icon, kind: t.icon_kind },
        style: {
          fg: t.fg_color,
          bg: t.bg_color,
          bold: t.font_bold,
          italic: t.font_italic,
          underline: t.font_underline,
          strike: t.font_strike,
        },
      })),
    value: null,
    placeholder: 'без типа',
    emptyLabel: 'без типа',
    onChange: (typeId) => {
      newThoughtTypeId = typeId;
    },
  });

  // Type of the created link(s), remembered as the last used one.
  let linkTypeId: string | null = store.state.lastUsedLinkTypeId;
  const linkTypeCombo = createTypeCombobox({
    options: () =>
      store.state.linkTypes.map((t) => ({
        id: t.id,
        label: `${t.name_forward} / ${t.name_reverse}`,
        line: { color: t.color, style: t.style, width: t.width },
      })),
    value: linkTypeId,
    placeholder: 'без типа',
    emptyLabel: 'без типа',
    onChange: (typeId) => {
      linkTypeId = typeId;
      store.update({ lastUsedLinkTypeId: typeId });
      void etn.ui
        .setState(networkId, UI_STATE_KEY.LAST_USED_LINK_TYPE_ID, typeId ?? '')
        .catch(() => undefined);
    },
  });

  const candidates = div('dup-list');
  const errorLine = span('', 'error-text');

  const body = div('form-stack');
  // Both type pickers share one row (08-ui-spec.md §4.2).
  const typeRow = div('add-types-row');
  const thoughtTypeField = div('field add-types-field');
  thoughtTypeField.append(el('label', 'field-label', 'Тип мысли'), thoughtTypeCombo.root);
  const linkTypeField = div('field add-types-field');
  linkTypeField.append(el('label', 'field-label', 'Тип связи'), linkTypeCombo.root);
  typeRow.append(thoughtTypeField, linkTypeField);
  // Layout (08-ui-spec.md §4.2): mode switch, then the type pickers on one
  // row, then the name input with the found-thoughts list directly beneath it.
  body.append(modeRow, typeRow, input, candidates, lineList, errorLine);

  const directionText =
    ctx.anchorId === null
      ? ''
      : ctx.direction === 'parent'
        ? `вверх к «${anchorTitle}»`
        : `вниз к «${anchorTitle}»`;

  let timer: number | null = null;
  let lastCandidates: DuplicateHit[] = [];

  /** Debounced duplicate search for the current input. */
  function scheduleSearch(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void (async () => {
        const raw = input.value.trim();
        if (raw === '') {
          renderCandidates([]);
          return;
        }
        const parsed = parseTitleWithSynonyms(raw);
        try {
          lastCandidates = await etn.thoughts.findDuplicates(
            networkId,
            parsed.title,
            parsed.synonyms,
          );
          renderCandidates(lastCandidates);
        } catch (err) {
          errorLine.textContent = errText(err);
        }
      })();
    }, 200);
  }
  input.addEventListener('input', scheduleSearch);

  /** Handles multi-line pastes: switches to batch mode and parses lines. */
  input.addEventListener('paste', () => {
    window.setTimeout(() => {
      const text = input.value;
      if (!text.includes('\n')) return;
      const parsed = parseAddLines(text);
      if (parsed.length <= 1) return;
      multi = true;
      multiRadio.checked = true;
      applyMode();
      for (const line of parsed) addLine(line.raw, line.title, line.synonyms);
      input.value = '';
    }, 0);
  });

  input.addEventListener('keydown', (event) => {
    // ↓ moves into the found-thoughts list (keyboard path of picking a
    // candidate); Tab reaches it as the next tab stop.
    if (event.key === 'ArrowDown') {
      const first = candidates.querySelector<HTMLElement>('.dup-item');
      if (first !== null) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (multi || event.ctrlKey) {
      const raw = input.value.trim();
      if (raw !== '') {
        const parsed = parseTitleWithSynonyms(raw);
        addLine(raw, parsed.title, parsed.synonyms);
        input.value = '';
        scheduleSearch();
      }
      // Ctrl+Shift+Enter inserts everything AND focuses the first added
      // thought (L19); a plain Ctrl+Enter just inserts.
      if (event.ctrlKey) void insertAll(event.shiftKey);
      return;
    }
    void insertSingle();
  });

  /** Shows/hides batch-mode UI. */
  function applyMode(): void {
    lineList.classList.toggle('hidden', !multi);
  }

  /** Adds a batch line with an immediate exact-duplicate check. */
  function addLine(raw: string, title: string, synonyms: string[]): void {
    // The server classifies candidates by match strength; exact title/synonym
    // matches reuse the existing thought, partial matches create a new one.
    const exact = lastCandidates.find(
      (c) => c.matched_on === 'title' || c.matched_on === 'synonym',
    );
    lines.push({
      raw,
      title,
      synonyms,
      existingId: exact?.id ?? null,
      matchKind: exact?.matched_on ?? null,
    });
    renderLines();
  }

  /** Renders the batch line list. */
  function renderLines(): void {
    lineList.replaceChildren();
    lines.forEach((line, index) => {
      const row = div('add-list-item');
      const status = line.existingId !== null ? span('🟡', 'al-status') : span('🟢', 'al-status');
      status.title =
        line.existingId !== null
          ? 'Будет использована существующая мысль'
          : 'Будет создана новая мысль';
      const title = el('span', 'al-title', line.title === '' ? line.raw : line.title);
      title.title = line.raw;
      row.append(status, title);
      row.append(
        button(
          '×',
          () => {
            lines.splice(index, 1);
            renderLines();
          },
          'btn small',
          'Удалить строку',
        ),
      );
      lineList.append(row);
    });
  }

  /** Renders the duplicate candidates for the current input. */
  function renderCandidates(list: DuplicateHit[]): void {
    candidates.replaceChildren();
    if (list.length === 0) return;
    candidates.append(el('p', 'muted', 'Найденные мысли:'));
    for (const candidate of list) {
      const row = div('dup-item');
      row.tabIndex = 0;
      // The candidate's own icon/style, else its type's defaults — the row
      // looks like the thought's cloud, so equal titles are easy to tell apart.
      const iconBox = span('', 'dup-icon');
      applyThoughtIcon(iconBox, candidate);
      const title = el('span', 'dup-title', candidate.title);
      const style = resolveCloudStyle(candidate);
      applyFontFlags(title, {
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        strike: style.strike,
      });
      if (style.fg !== null) title.style.color = style.fg;
      if (style.bg !== null) row.style.background = style.bg;
      row.append(iconBox, title);
      // The parent's title (first 60 chars) instead of the «использовать»
      // button — the whole row is the pick target (08-ui-spec.md §4.2).
      if (candidate.parent_title !== null) {
        const parent = span(candidate.parent_title.slice(0, 60), 'dup-parent');
        parent.title = candidate.parent_title;
        row.append(parent);
      }
      const matchLabel =
        candidate.matched_on === 'title'
          ? 'точное имя'
          : candidate.matched_on === 'synonym'
            ? `синоним «${candidate.matched_synonym ?? ''}»`
            : 'частичное совпадение';
      row.title =
        candidate.synonyms.length > 0
          ? `${candidate.title} (${candidate.synonyms.join(', ')}) — ${matchLabel}`
          : `${candidate.title} — ${matchLabel}`;
      row.addEventListener('click', () => {
        void useExisting(candidate.id);
      });
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && event.shiftKey) {
          // Shift+Enter composes a compound name: the candidate's full name
          // replaces the input text, a comma is appended and the caret lands
          // right after it (08-ui-spec.md §4.3).
          event.preventDefault();
          input.value = `${candidate.title},`;
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
          scheduleSearch();
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          void useExisting(candidate.id);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const next =
            event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
          if (next instanceof HTMLElement && next.classList.contains('dup-item')) {
            next.focus();
            next.scrollIntoView({ block: 'nearest' });
          } else if (event.key === 'ArrowUp') {
            // Above the first row the caret returns to the name input.
            input.focus();
          }
        } else if (event.key === 'Escape') {
          event.preventDefault();
          input.focus();
        }
      });
      candidates.append(row);
    }
  }

  /** Links the anchor to an existing thought. */
  async function useExisting(candidateId: string): Promise<void> {
    try {
      if (ctx.anchorId === null) return;
      const source = ctx.direction === 'child' ? ctx.anchorId : candidateId;
      const target = ctx.direction === 'child' ? candidateId : ctx.anchorId;
      await etn.links.create(networkId, {
        source_id: source,
        target_id: target,
        type_id: linkTypeId,
      });
      notice('Связь создана.');
      scheduleRefresh();
      closeDialog();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  /** Creates a new thought linked to the anchor (or unlinked); returns its id. */
  async function createNew(title: string, synonyms: string[]): Promise<string> {
    const thought = await etn.thoughts.create(networkId, {
      title,
      synonyms,
      type_id: newThoughtTypeId,
      create_link:
        ctx.anchorId === null
          ? undefined
          : {
              direction: ctx.direction,
              target_thought_id: ctx.anchorId,
              type_id: linkTypeId,
            },
    });
    return thought.id;
  }

  /** Single mode: exact match → link; otherwise create new. */
  async function insertSingle(): Promise<void> {
    const raw = input.value.trim();
    if (raw === '') return;
    const parsed = parseTitleWithSynonyms(raw);
    try {
      const exact = lastCandidates.find(
        (c) => c.matched_on === 'title' && c.title.toLowerCase() === parsed.title.toLowerCase(),
      );
      if (exact !== undefined && ctx.anchorId !== null) {
        await useExisting(exact.id);
        return;
      }
      await createNew(parsed.title, parsed.synonyms);
      notice('Мысль создана.');
      scheduleRefresh();
      closeDialog();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  /**
   * Batch mode: creates/links every accumulated line. With `focusFirst` the
   * first successfully added thought (created or reused) becomes the canvas
   * focus right after the insert (Ctrl+Shift+Enter, L19).
   */
  async function insertAll(focusFirst = false): Promise<void> {
    if (lines.length === 0 && input.value.trim() !== '') {
      const parsed = parseTitleWithSynonyms(input.value.trim());
      lines.push({
        raw: input.value.trim(),
        title: parsed.title,
        synonyms: parsed.synonyms,
        existingId: null,
        matchKind: null,
      });
      renderLines();
    }
    if (lines.length === 0) return;
    let created = 0;
    let failed = 0;
    let firstAddedId: string | null = null;
    for (const line of lines) {
      try {
        if (line.existingId !== null && ctx.anchorId !== null) {
          const source = ctx.direction === 'child' ? ctx.anchorId : line.existingId;
          const target = ctx.direction === 'child' ? line.existingId : ctx.anchorId;
          await etn.links.create(networkId, {
            source_id: source,
            target_id: target,
            type_id: linkTypeId,
          });
          if (firstAddedId === null) firstAddedId = line.existingId;
        } else {
          const newId = await createNew(line.title, line.synonyms);
          if (firstAddedId === null) firstAddedId = newId;
        }
        created++;
      } catch {
        failed++;
      }
    }
    if (failed > 0) notice(`Создано/связано: ${created}, ошибок: ${failed}`, 'error');
    else notice(`Готово: ${created}.`);
    scheduleRefresh();
    closeDialog();
    if (focusFirst && firstAddedId !== null) void setFocus(firstAddedId);
  }

  const closeDialog = showDialog({
    title: ctx.anchorId === null ? 'Добавить мысли' : `Добавить мысль (${directionText})`,
    body,
    width: 620,
    buttons: [
      { label: 'Отмена' },
      {
        // In batch mode this inserts everything; the label keeps it simple.
        label: 'Добавить',
        primary: true,
        keepOpen: true,
        onClick: () => {
          if (multi) void insertAll();
          else void insertSingle();
        },
      },
    ],
    onMount: () => input.focus(),
  });
}

/**
 * Handles drops of external files/URLs onto canvas zones (08-ui-spec.md §7):
 * a new thought is created per item with an attachment; drops onto the parents
 * zone create parents, onto the children zone — children.
 */
export function wireZoneExternalDrops(zones: Record<'parents' | 'children', HTMLElement>): void {
  for (const dir of ['parents', 'children'] as const) {
    const zone = zones[dir];
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('drag-over');
      void handleExternalDrop(dir === 'parents' ? 'parent' : 'child', event);
    });
  }
}

/** Creates thoughts for dropped files/URLs, each with an attachment. */
async function handleExternalDrop(direction: 'parent' | 'child', event: DragEvent): Promise<void> {
  const networkId = store.state.networkId;
  const focusId = store.state.focus?.focused.id;
  if (networkId === null || focusId === undefined) return;

  const urls = (event.dataTransfer?.getData('text/uri-list') ?? '')
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const files = event.dataTransfer !== null ? Array.from(event.dataTransfer.files ?? []) : [];

  for (const url of urls) {
    try {
      const thought = await etn.thoughts.create(networkId, {
        title: url,
        create_link: { direction, target_thought_id: focusId },
      });
      // A null title lets the server's URL enrichment (L1) fill the site title;
      // the response then carries the title and the favicon (data: URL).
      const attachment = await etn.attachments.add(networkId, 'thought', thought.id, {
        kind: 'url',
        url,
        title: null,
      });
      // Mirror the enriched site title/icon onto the thought so the cloud shows
      // them right away (the enrichment touches the attachment, not the thought).
      const patch: import('@etn/shared').ThoughtUpdateInput = {};
      if (attachment.title !== null && attachment.title !== url) patch.title = attachment.title;
      if (attachment.icon !== null) {
        patch.icon = attachment.icon;
        patch.icon_kind = 'image';
      }
      if (Object.keys(patch).length > 0) {
        await etn.thoughts.update(networkId, thought.id, patch, thought.version);
        invalidateRef(thought.id);
      }
      scheduleRefresh();
    } catch (err) {
      notice(`Не удалось создать мысль: ${errText(err)}`, 'error');
    }
  }
  for (const file of files) {
    try {
      const path = (file as File & { path?: string }).path ?? file.name;
      const thought = await etn.thoughts.create(networkId, {
        title: file.name,
        create_link: { direction, target_thought_id: focusId },
      });
      await etn.attachments.add(networkId, 'thought', thought.id, {
        kind: 'file',
        file_path: path,
        file_size: file.size,
        mime_type: file.type || null,
        title: file.name,
      });
      scheduleRefresh();
    } catch (err) {
      notice(`Не удалось создать мысль: ${errText(err)}`, 'error');
    }
  }
}
