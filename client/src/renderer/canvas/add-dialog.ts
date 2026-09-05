/**
 * Universal thought picker/add dialog (H14, 08-ui-spec.md §4; 09-scenarios.md
 * C1, C2; universalized for every thought-picking site, L20).
 *
 * Live duplicate search over `thoughts.findDuplicates` (the synonym-pattern
 * principle of 02-data-model.md §3.2 with an implicit `*` around every typed
 * word: fragments must hit consecutive words of the title or one synonym in
 * the typed order, «дор» → «Доработать!»; `-word` excludes infix
 * occurrences); the
 * anchor thought is excluded from the candidates — a thought cannot link to
 * itself; a whole-query UUID resolves the thought directly via `thoughts.get`
 * (§4.1) into a single exact-match candidate («Мысль с указанным ID
 * отсутствует» when unknown); single and multi
 * modes; `|` synonym parsing per line; multi-line paste auto-switches to
 * multi mode; Enter adds the best match to the list (an exact title/synonym
 * hit reuses the existing thought, otherwise a new one is queued), Ctrl+Enter
 * applies the whole list (Ctrl+Shift+Enter also focuses the first inserted
 * thought, L19). Clicking a found thought in multi mode adds it to the list
 * (existing thoughts are picked as-is — never re-created).
 *
 * The dialog only ACCUMULATES the list and returns it — the caller decides
 * what to do (canvas: create thoughts/links; pickers: use the ids). Options
 * adapt it to a pure picker:
 *   - `allowCreate: false` forbids new thoughts and hides the type field;
 *   - `allowLinkType: false` hides the link-type field;
 *   - `selectedIds` prefills the list (multi mode switches on automatically);
 *   - `searchTypeIds` narrows the live search (thought_ref type configs).
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
import { applyCommentTemplateIfEmpty } from '../lib/comment-template.js';
import { notice } from '../lib/notice.js';
import { parseAddLines, parseTitleWithSynonyms, parseThoughtIdQuery, isNotFoundError } from '../lib/pure.js';
import { createTypeCombobox } from '../lib/type-combobox.js';
import { linkTypeOptions, thoughtTypeOptions } from '../lib/type-tree.js';
import type { DuplicateHit } from '../../main/ipc/contract.js';
import { UI_STATE_KEY, type Thought } from '@etn/shared';
import { store } from '../state.js';

/** One accumulated list entry: an existing thought or a queued new one. */
export type ThoughtPickItem =
  | { kind: 'existing'; id: string; raw: string }
  | { kind: 'new'; title: string; synonyms: string[]; raw: string };

/** Result of {@link pickThoughtsDialog} (null = cancelled). */
export interface ThoughtPickResult {
  items: ThoughtPickItem[];
  /** Type for NEW thoughts (null = none / the field was hidden). */
  thoughtTypeId: string | null;
  /** Link type chosen in the dialog (null = none / the field was hidden). */
  linkTypeId: string | null;
  /** Applied via Shift+Ctrl+Enter — focus the first inserted item (L19). */
  focusFirst: boolean;
}

/** Options of {@link pickThoughtsDialog}. */
export interface ThoughtPickerOptions {
  networkId: string;
  /** Canvas anchor: shows «вверх/вниз к …» and makes the link type meaningful. */
  anchor?: { id: string; direction: 'parent' | 'child' } | null;
  /** Allow queueing new thoughts (default true). `false` hides the type field. */
  allowCreate?: boolean;
  /** Show the link-type field (default true — the canvas add flows). */
  allowLinkType?: boolean;
  /** Restrict the live search to these thought types (thought_ref configs). */
  searchTypeIds?: string[];
  /** Prefill the list with these thoughts; multi mode switches on. */
  selectedIds?: string[];
  /**
   * Prefill the NAME INPUT as if the text were typed (the
   * create-from-legacy-link flow, карточка ETN 34ffbd75): `имя|алиас` parses
   * into title + synonym on add (08-ui-spec.md §4.3), the live duplicate
   * search runs right away, and the dialog STAYS in single mode — the user
   * may still switch to multi, edit the name or pick a type.
   */
  prefillText?: string;
  /**
   * Anchor display title override: by default the dialog shows the FOCUSED
   * thought's title for the «вверх/вниз к …» suffix, which is wrong whenever
   * the anchor is not the focus (e.g. a comment owner). Pass the real title.
   */
  anchorTitle?: string;
  /** Dialog title override (defaults by `allowCreate`/anchor). */
  title?: string;
  /** Primary button label override (defaults «Добавить»/«Выбрать»). */
  applyLabel?: string;
}

/** One list entry with its duplicate-check result (internal shape). */
interface AddLine {
  raw: string;
  title: string;
  synonyms: string[];
  /** Candidate id when an exact title/synonym match was found. */
  existingId: string | null;
  /** Strongest candidate match kind (informational). */
  matchKind: 'title' | 'synonym' | 'partial' | null;
}

/** The first existing-thought id of a picker result (single-pick helper). */
export function firstPickedThoughtId(result: ThoughtPickResult | null): string | null {
  if (result === null) return null;
  for (const item of result.items) {
    if (item.kind === 'existing') return item.id;
  }
  return null;
}

/** Every existing-thought id of a picker result (multi-pick helper). */
export function pickedThoughtIds(result: ThoughtPickResult | null): string[] {
  if (result === null) return [];
  return result.items.flatMap((item) => (item.kind === 'existing' ? [item.id] : []));
}

/**
 * Maps a thought fetched by id onto the duplicate-hit shape of the candidates
 * list: `matched_on: 'title'` makes it an exact match, so Enter/клик pick the
 * existing thought instead of queueing a new one.
 */
function thoughtToCandidate(thought: Thought): DuplicateHit {
  return {
    id: thought.id,
    title: thought.title,
    synonyms: thought.synonyms,
    matched_on: 'title',
    type_id: thought.type_id,
    icon: thought.icon,
    icon_kind: thought.icon_kind,
    fg_color: thought.fg_color,
    bg_color: thought.bg_color,
    font_bold: thought.font_bold,
    font_italic: thought.font_italic,
    font_underline: thought.font_underline,
    font_strike: thought.font_strike,
    parent_title: null,
  };
}

let mounted = false;

/** Mounts the dialog opener into the canvas drag gestures (called by the workspace). */
export function mountAddDialog(): void {
  if (mounted) return;
  mounted = true;
  setAddDialogOpener((ctx) => void openAddDialog(ctx));
}

/**
 * Opens the universal picker and inserts the picked list into the canvas:
 * existing thoughts get linked to the anchor, new ones are created (with the
 * chosen thought type) and linked; the link type applies to every link.
 */
export async function openAddDialog(ctx: {
  anchorId: string | null;
  direction: 'parent' | 'child';
}): Promise<void> {
  const networkId = requireNetworkId();
  const result = await pickThoughtsDialog({
    networkId,
    anchor: ctx.anchorId !== null ? { id: ctx.anchorId, direction: ctx.direction } : null,
    allowCreate: true,
    allowLinkType: true,
    applyLabel: 'Добавить',
  });
  if (result === null) return;
  await insertIntoCanvas(networkId, ctx, result);
}

/** Creates/links every picked item (the old insertAll flow, L19 focus). */
async function insertIntoCanvas(
  networkId: string,
  ctx: { anchorId: string | null; direction: 'parent' | 'child' },
  result: ThoughtPickResult,
): Promise<void> {
  if (result.items.length === 0) return;
  let created = 0;
  let failed = 0;
  let firstAddedId: string | null = null;
  for (const item of result.items) {
    try {
      if (item.kind === 'existing') {
        if (ctx.anchorId !== null) {
          const source = ctx.direction === 'child' ? ctx.anchorId : item.id;
          const target = ctx.direction === 'child' ? item.id : ctx.anchorId;
          await etn.links.create(networkId, {
            source_id: source,
            target_id: target,
            type_id: result.linkTypeId,
          });
        }
        if (firstAddedId === null) firstAddedId = item.id;
      } else {
        const newThought = await etn.thoughts.create(networkId, {
          title: item.title,
          synonyms: item.synonyms,
          type_id: result.thoughtTypeId,
          create_link:
            ctx.anchorId === null
              ? undefined
              : {
                  // ctx.direction names the role of the NEW item relative to
                  // the anchor ('parent' — new item becomes the anchor's
                  // parent); create_link.direction names the role of the
                  // TARGET (anchor) relative to the new thought — invert.
                  direction: ctx.direction === 'parent' ? 'child' : 'parent',
                  target_thought_id: ctx.anchorId,
                  type_id: result.linkTypeId,
                },
        });
        // Шаблон комментария типа (08-ui-spec.md §8.1): применяется к
        // пустому постоянному комментарию сразу после создания мысли.
        if (result.thoughtTypeId !== null) {
          await applyCommentTemplateIfEmpty(networkId, newThought.id, result.thoughtTypeId);
        }
        if (firstAddedId === null) firstAddedId = newThought.id;
      }
      created++;
    } catch {
      failed++;
    }
  }
  if (failed > 0) notice(`Создано/связано: ${created}, ошибок: ${failed}`, 'error');
  else notice(`Готово: ${created}.`);
  scheduleRefresh();
  if (result.focusFirst && firstAddedId !== null) void setFocus(firstAddedId);
}

/**
 * The universal dialog itself. Accumulates existing/new thoughts in a list
 * (Enter / candidate click adds; multi-line paste batches new lines) and
 * resolves with the whole list on «Добавить»/«Выбрать» or Ctrl+Enter.
 */
export function pickThoughtsDialog(opts: ThoughtPickerOptions): Promise<ThoughtPickResult | null> {
  const networkId = opts.networkId;
  const allowCreate = opts.allowCreate !== false;
  const allowLinkType = opts.allowLinkType !== false;
  const searchFilter = (opts.searchTypeIds ?? []).filter((id) => id !== '');

  return new Promise((resolve) => {
    let multi = (opts.selectedIds ?? []).length > 0;
    const lines: AddLine[] = [];

    const modeRow = div('add-mode-row');
    const singleRadio = el('input');
    singleRadio.type = 'radio';
    singleRadio.name = 'add-mode';
    singleRadio.checked = !multi;
    const multiRadio = el('input');
    multiRadio.type = 'radio';
    multiRadio.name = 'add-mode';
    multiRadio.checked = multi;
    const singleLabel = el('label', 'checkbox-row');
    singleLabel.append(singleRadio, span('одна'));
    const multiLabel = el('label', 'checkbox-row');
    multiLabel.append(multiRadio, span('несколько'));
    modeRow.append(singleLabel, multiLabel);
    singleRadio.addEventListener('change', () => {
      multi = false;
      // Switching «несколько» → «одна» drops the accumulated list (карточка ETN
      // 24ad9b0e): a later single-mode apply (the button/Ctrl+Enter path) must
      // never resurrect lines queued before the switch. `renderLines` repaints
      // the (now hidden) list empty, so switching back to «несколько» starts
      // from a clean slate instead of showing ghosts.
      lines.length = 0;
      renderLines();
      applyMode();
    });
    multiRadio.addEventListener('change', () => {
      multi = true;
      applyMode();
    });

    // Starts hidden unless the prefill switched multi mode on.
    const lineList = div(multi ? 'add-list' : 'add-list hidden');

    const input = el('textarea', 'textarea-input');
    input.rows = 2;
    input.placeholder =
      allowCreate ? 'Введите название или вставьте список…' : 'Введите название для поиска…';

    // Type of the created thought(s) — searchable picker over the catalogue
    // tree (L6/L21): rows carry the type's icon and style; the hierarchy root
    // is not offered (it only lives in «Типы мыслей»). Hidden when creation is
    // forbidden (the picker mode never changes existing thoughts).
    let newThoughtTypeId: string | null = null;
    const thoughtTypeCombo = createTypeCombobox({
      options: () => thoughtTypeOptions(store.state.thoughtTypes),
      value: null,
      placeholder: 'без типа',
      emptyLabel: 'без типа',
      onChange: (typeId) => {
        newThoughtTypeId = typeId;
      },
    });

    // Type of the created link(s), remembered as the last used one. Hidden
    // for pickers that never create links. The hierarchy root is not offered.
    let linkTypeId: string | null = store.state.lastUsedLinkTypeId;
    const linkTypeCombo = createTypeCombobox({
      options: () => linkTypeOptions(store.state.linkTypes),
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
    const typeRow = div('add-types-row');
    const thoughtTypeField = div('field add-types-field');
    thoughtTypeField.append(el('label', 'field-label', 'Тип мысли'), thoughtTypeCombo.root);
    const linkTypeField = div('field add-types-field');
    linkTypeField.append(el('label', 'field-label', 'Тип связи'), linkTypeCombo.root);
    if (allowCreate) typeRow.append(thoughtTypeField);
    if (allowLinkType) typeRow.append(linkTypeField);
    // Layout (08-ui-spec.md §4.2): mode switch, then the type pickers on one
    // row, then the name input with the found-thoughts list directly beneath
    // it and the accumulated list under both.
    if (typeRow.childElementCount > 0) body.append(typeRow);
    const hint =
      allowCreate
        ? 'Enter — добавить в список, Ctrl+Enter — применить. В режиме «несколько» клик по найденной мысли добавляет её в список.'
        : 'Выбор только из существующих мыслей: Enter или клик по найденной — в список, Ctrl+Enter — применить.';
    const hintLine = el('p', 'muted', hint);
    hintLine.style.margin = '0';
    body.append(modeRow, input, hintLine, candidates, lineList, errorLine);

    let timer: number | null = null;
    let lastCandidates: DuplicateHit[] = [];
    // The anchor thought cannot be linked to itself (the server rejects
    // self-links), so it never shows up among the found candidates.
    const anchorId = opts.anchor?.id ?? null;

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
          // A whole-query UUID is a direct id lookup (08-ui-spec.md §4.1): the
          // type filter is ignored, inactive thoughts are found too, and the
          // hit behaves as an exact-title match downstream (Enter picks it).
          const idQuery = parseThoughtIdQuery(raw);
          if (idQuery !== null) {
            try {
              const thought = await etn.thoughts.get(networkId, idQuery);
              if (thought.id === anchorId) {
                // Same protection as the duplicate search: the anchor never
                // shows up among the candidates (no self-links).
                lastCandidates = [];
                candidates.replaceChildren(
                  el('p', 'muted', 'Нельзя связать мысль с самой собой.'),
                );
                return;
              }
              lastCandidates = [thoughtToCandidate(thought)];
              renderCandidates(lastCandidates);
            } catch (err) {
              if (isNotFoundError(err)) {
                lastCandidates = [];
                candidates.replaceChildren(
                  el('p', 'muted', 'Мысль с указанным ID отсутствует.'),
                );
                return;
              }
              errorLine.textContent = errText(err);
            }
            return;
          }
          const parsed = parseTitleWithSynonyms(raw);
          try {
            const hits = await etn.thoughts.findDuplicates(
              networkId,
              parsed.title,
              parsed.synonyms,
              searchFilter,
            );
            lastCandidates = hits.filter((hit) => hit.id !== anchorId);
            renderCandidates(lastCandidates);
          } catch (err) {
            errorLine.textContent = errText(err);
          }
        })();
      }, 200);
    }
    input.addEventListener('input', scheduleSearch);

    /** Handles multi-line pastes: switches to multi mode and parses lines. */
    if (allowCreate) {
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
    }

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
      // Ctrl+Enter applies the whole list (Shift additionally focuses the
      // first inserted item, L19); the dialog-level Ctrl+Enter does the same
      // without Shift via the primary button.
      if (event.ctrlKey) {
        apply(event.shiftKey);
        return;
      }
      const raw = input.value.trim();
      if (raw === '') return;
      if (multi) {
        addLineFromInput(raw);
        input.value = '';
        scheduleSearch();
        return;
      }
      // Single mode: a new thought is queued when allowed — a listed
      // candidate is picked explicitly (click/Enter on its row, 08-ui-spec.md
      // §4.3); otherwise the strongest match is taken.
      finishSingle(lineFromInput(raw, allowCreate ? false : true));
    });

    /** Shows/hides the accumulated-list UI. */
    function applyMode(): void {
      lineList.classList.toggle('hidden', !multi);
    }

    /**
     * Builds the list entry for a typed query. With `preferExact` an exact
     * title/synonym match reuses the existing thought; otherwise (single-mode
     * Enter with creation allowed) a new one is queued — the typed text is
     * the proposed name, and a listed candidate is used only when the user
     * picks it explicitly. When creation is forbidden, the first candidate is
     * taken (pick from found).
     */
    function lineFromInput(raw: string, preferExact: boolean): AddLine | null {
      const parsed = parseTitleWithSynonyms(raw);
      const exact = lastCandidates.find(
        (c) => c.matched_on === 'title' || c.matched_on === 'synonym',
      );
      if (preferExact && exact !== undefined) {
        return {
          raw,
          title: parsed.title,
          synonyms: parsed.synonyms,
          existingId: exact.id,
          matchKind: exact.matched_on,
        };
      }
      if (allowCreate) {
        return { raw, title: parsed.title, synonyms: parsed.synonyms, existingId: null, matchKind: null };
      }
      const first = lastCandidates[0];
      if (first === undefined) {
        errorLine.textContent = 'Совпадений нет — создание новых мыслей отключено.';
        return null;
      }
      return {
        raw,
        title: parsed.title,
        synonyms: [],
        existingId: first.id,
        matchKind: 'partial',
      };
    }

    /** Enter in multi mode: appends the typed query to the list. */
    function addLineFromInput(raw: string): void {
      const line = lineFromInput(raw, true);
      if (line !== null) addLine(line.raw, line.title, line.synonyms, line.existingId, line.matchKind);
    }

    /** Adds a list entry with an immediate exact-duplicate check. */
    function addLine(
      raw: string,
      title: string,
      synonyms: string[],
      existingId: string | null = null,
      matchKind: AddLine['matchKind'] = null,
    ): void {
      // The server classifies candidates by match strength; exact title/synonym
      // matches reuse the existing thought, partial matches create a new one.
      const exact = lastCandidates.find(
        (c) => c.matched_on === 'title' || c.matched_on === 'synonym',
      );
      const resolvedId = existingId ?? exact?.id ?? null;
      if (resolvedId !== null && lines.some((l) => l.existingId === resolvedId)) {
        errorLine.textContent = 'Эта мысль уже в списке.';
        return;
      }
      lines.push({
        raw,
        title,
        synonyms,
        existingId: resolvedId,
        matchKind: matchKind ?? exact?.matched_on ?? null,
      });
      errorLine.textContent = '';
      renderLines();
    }

    /** Adds an existing thought picked from the candidate list. */
    function addExisting(candidate: DuplicateHit): void {
      if (lines.some((l) => l.existingId === candidate.id)) return;
      lines.push({
        raw: candidate.title,
        title: candidate.title,
        synonyms: [],
        existingId: candidate.id,
        matchKind: 'title',
      });
      errorLine.textContent = '';
      renderLines();
    }

    /** Renders the accumulated list (with the «Очистить» header button). */
    function renderLines(): void {
      lineList.replaceChildren();
      const head = div('add-list-head');
      head.append(span(`Выбрано: ${lines.length}`, 'muted'));
      head.append(
        button(
          'Очистить',
          () => {
            lines.length = 0;
            renderLines();
          },
          'btn small',
          'Очистить список',
        ),
      );
      lineList.append(head);
      lines.forEach((line, index) => {
        const row = div('add-list-item');
        const status = line.existingId !== null ? span('🟡', 'al-status') : span('🟢', 'al-status');
        status.title =
          line.existingId !== null
            ? 'Существующая мысль — тип мысли не меняется'
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
          pickCandidate(candidate);
        });
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && event.shiftKey) {
            // Shift+Enter composes a compound name: the candidate's full name
            // replaces the input text, a dot is appended and the caret lands
            // right after it (08-ui-spec.md §4.3).
            event.preventDefault();
            input.value = `${candidate.title}.`;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            scheduleSearch();
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            pickCandidate(candidate);
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

    /** A candidate was activated (click/Enter): multi adds it to the list,
     *  single resolves the dialog with it right away. */
    function pickCandidate(candidate: DuplicateHit): void {
      if (multi) {
        addExisting(candidate);
        input.value = '';
        scheduleSearch();
        return;
      }
      // Single mode resolves with exactly this one thought (any accumulated
      // prefill is replaced).
      lines.length = 0;
      lines.push({
        raw: candidate.title,
        title: candidate.title,
        synonyms: [],
        existingId: candidate.id,
        matchKind: 'title',
      });
      input.value = '';
      apply(false);
    }

    /** Single-mode Enter: a built line resolves the dialog immediately. */
    function finishSingle(line: AddLine | null): void {
      if (line === null) return;
      lines.length = 0;
      lines.push(line);
      input.value = '';
      apply(false);
    }

    /** Applies the whole list: a leftover query joins it first. */
    function apply(shift: boolean): void {
      const raw = input.value.trim();
      if (raw !== '') {
        const line = lineFromInput(raw, multi ? true : allowCreate ? false : true);
        if (line !== null) lines.push(line);
      }
      if (lines.length === 0) {
        notice('Список мыслей пуст.', 'info');
        return;
      }
      finish({
        items: lines.map((line) =>
          line.existingId !== null
            ? { kind: 'existing' as const, id: line.existingId, raw: line.raw }
            : { kind: 'new' as const, title: line.title, synonyms: line.synonyms, raw: line.raw },
        ),
        thoughtTypeId: allowCreate ? newThoughtTypeId : null,
        linkTypeId: allowLinkType ? linkTypeId : null,
        focusFirst: shift,
      });
    }

    const finish = (result: ThoughtPickResult | null): void => {
      resolve(result);
      closeSelf();
    };

    // Prefill the list from `selectedIds` (titles resolved async; raw ids are
    // shown while loading / offline) — multi mode is already on.
    const prefillIds = opts.selectedIds ?? [];
    if (prefillIds.length > 0) {
      void etn.thoughts
        .resolve(networkId, prefillIds)
        .then((refs) => {
          const byId = new Map(refs.map((r) => [r.id, r.title]));
          for (const id of prefillIds) {
            lines.push({
              raw: byId.get(id) ?? id,
              title: byId.get(id) ?? id,
              synonyms: [],
              existingId: id,
              matchKind: 'title',
            });
          }
          renderLines();
        })
        .catch(() => {
          for (const id of prefillIds) {
            lines.push({ raw: id, title: id, synonyms: [], existingId: id, matchKind: 'title' });
          }
          renderLines();
        });
    }

    const anchorTitle =
      opts.anchor !== undefined && opts.anchor !== null
        ? (opts.anchorTitle ?? store.state.focus?.focused.title ?? '…')
        : '';
    const directionText =
      opts.anchor === undefined || opts.anchor === null
        ? ''
        : opts.anchor.direction === 'parent'
          ? `вверх к «${anchorTitle}»`
          : `вниз к «${anchorTitle}»`;
    const title =
      opts.title ??
      (allowCreate
        ? directionText === ''
          ? 'Добавить мысли'
          : `Добавить мысль (${directionText})`
        : 'Выбор мыслей');
    const applyLabel = opts.applyLabel ?? (allowCreate ? 'Добавить' : 'Выбрать');

    const closeSelf = showDialog({
      title,
      body,
      width: 620,
      buttons: [
        { label: 'Отмена', onClick: () => finish(null) },
        {
          label: applyLabel,
          primary: true,
          keepOpen: true,
          onClick: () => apply(false),
        },
      ],
      // Ctrl+Shift+Enter applies the list and focuses the first inserted item
      // from any field except the found-thoughts list (the field-level handler
      // on `input` already does `preventDefault`, so the dialog handler is a
      // no-op there; the dup-item rows also call `preventDefault`, so the
      // shortcut does not fire while the caret sits in the candidate list).
      extraShortcuts: {
        ctrlShiftEnter: () => apply(true),
      },
      onMount: () => {
        renderLines();
        // Prefill lands in the input as if typed (карточка ETN 34ffbd75): the
        // duplicate search runs right away, the mode radios stay untouched.
        if (opts.prefillText !== undefined && opts.prefillText !== '') {
          input.value = opts.prefillText;
          scheduleSearch();
        }
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      },
    });
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
  // `direction` names the role of the DROPPED (new) thought relative to
  // focus ('parent' — dropped into the parents zone, becomes focus's
  // parent); create_link.direction names the role of the TARGET (focus)
  // relative to the new thought — invert.
  const createLinkDirection = direction === 'parent' ? 'child' : 'parent';

  const urls = (event.dataTransfer?.getData('text/uri-list') ?? '')
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const files = event.dataTransfer !== null ? Array.from(event.dataTransfer.files ?? []) : [];

  for (const url of urls) {
    try {
      const thought = await etn.thoughts.create(networkId, {
        title: url,
        create_link: { direction: createLinkDirection, target_thought_id: focusId },
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
        create_link: { direction: createLinkDirection, target_thought_id: focusId },
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
