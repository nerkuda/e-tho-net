/**
 * Visit history in the status bar (H7, 08-ui-spec.md §11.1, 11-settings-and-state.md
 * §2.3, 09-scenarios.md B4):
 *
 * `[облачко₁] [облачко₂] … [▾ N]`
 *
 * - ONE history shared by every screen (map/structures/chronicle, 0.5.5):
 *   the list of thoughts opened in the thought editor, wherever they were
 *   opened from — there is no per-view scoping anymore;
 * - the bar claims the full free width of the status bar between the left
 *   edge and the counts/zoom block; as many mini clouds are rendered as
 *   actually fit, the rest collapse into the `▾ N` dropdown;
 * - each mini cloud renders the thought's icon + title (clipped to
 *   {@link CHIP_TITLE_LIMIT} chars + ellipsis), real fg/bg/font styles via
 *   `applyCloudStyle`, dimmed when inactive;
 * - dropdown items are the same thought mini-clouds from the shared factory
 *   (profile `chip`): icon, colours, font, dim state and trash mark, ellipsis
 *   by the row width;
 * - empty history hides the area entirely;
 * - entries are resolved via `thoughts.resolve` (id → metadata); deleted
 *   thoughts were already pruned locally by the main-process applier, inactive
 *   thoughts are hidden while `show_inactive` is off, and marked-for-deletion
 *   ones while `show_trash` is off (задача 77923b49, симметрия настроек
 *   видимости);
 * - clicking an entry opens the thought in the editor: switches the focus
 *   (map view) or opens the thought without moving the canvas focus
 *   (structures/chronicle view) — the current-thought frame follows the pick
 *   on every screen;
 * - right-click on a chip (or a dropdown row) shows the shared thought
 *   context menu — the same command set as on the canvas and the pinned chips
 *   (спецификация «Контекстное меню мысли»); opening from the menu routes
 *   exactly like a click ({@link openEntry});
 * - entries drag onto the canvas like zone clouds (§11.1): link onto a cloud,
 *   Ctrl for reparent, drop into parents/children to link to focus; a canvas
 *   drag dropped onto the bar (or the dropdown) opens the dragged thought.
 */

import { setFocus } from '../app.js';
import { button, div, clear, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { markThoughtCommentPreview } from '../lib/hover-preview.js';
import { svgIcon } from '../lib/icons.js';
import { showMenuAt, type MenuItem } from '../lib/menu.js';
import { showThoughtContextMenu } from '../canvas/context-menu.js';
import { store } from '../state.js';
import { currentThoughtId, setHistoryChangeListener } from '../history.js';
// Мини-облачка истории и строки её дропдауна собирает общая фабрика:
// значок, цвета, начертание, бледность и метка корзины приходят из одного
// представления мысли (стандарт «представление мысли — только через фабрику»).
import { createThoughtCloud } from '../lib/thought-cloud.js';
import { registerDropActions, wireExternalDragSource } from '../canvas/drag-cloud.js';
import { openStructuresThought } from './structures/structures.js';
import { openChronicleThought } from './chronicle/chronicle.js';
import { HISTORY_BAR_MORE_RESERVE, planHistoryChips, type HistoryChipPlan } from '../lib/pure.js';

/** How many entries the dropdown source returns at once. */
const HISTORY_LIMIT = 50;

let host: HTMLElement | null = null;
/** Signature of the inputs the bar depends on — avoids redundant re-renders. */
let lastSignature = '';
/** Coalesces `ResizeObserver` ticks into one render per animation frame. */
let resizePending = false;
/** Cached `ResizeObserver` so we don't re-create it on every render. */
let resizeObserver: ResizeObserver | null = null;

/** Mounts the history bar into the status bar host. Returns a teardown handle
 *  that releases the store subscription and the ResizeObserver (ошибка 37b713de). */
export function mountHistoryBar(historyHost: HTMLElement): () => void {
  host = historyHost;
  // Canvas drags dropped onto the bar (or the history dropdown) open the
  // dragged thought like a click on a history entry (08-ui-spec.md §11.1).
  registerDropActions({ openEntry });
  const unsubscribe = store.subscribe(() => {
    if (host?.isConnected === true) void render();
  });
  // History writes land outside the store snapshot (history.js is not part of
  // the reactive state) — the module notifies via this listener so the bar
  // repaints even when no store field changed.
  setHistoryChangeListener(() => {
    invalidateHistoryBar();
  });
  // The number of visible chips depends on the strip width; recompute on
  // window/status-bar resize (08-ui-spec.md §11.1: «при изменении ширины окна
  // состав видимых облачков пересчитывается»).
  resizeObserver = new ResizeObserver(() => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      if (host?.isConnected === true) void render();
    });
  });
  resizeObserver.observe(historyHost);
  void render();

  return () => {
    unsubscribe();
    resizeObserver?.disconnect();
    resizeObserver = null;
    host = null;
    lastSignature = '';
  };
}

/**
 * Forces a re-render on the next store change even if the inputs did not
 * change — called on realtime `thought.deleted` (the main-process applier has
 * already pruned the local history by then).
 */
export function invalidateHistoryBar(): void {
  lastSignature = '';
  if (host?.isConnected === true) void render();
}

/** Opens a history entry in the way its view implies (§11.1). */
function openEntry(id: string): void {
  if (store.state.activeView === 'structures') {
    void openStructuresThought(id);
  } else if (store.state.activeView === 'chronicle') {
    void openChronicleThought(id);
  } else {
    void setFocus(id);
  }
}

/**
 * The id excluded from the list as "current": the thought open in the editor,
 * else the canvas focus. A link open in the editor means no current thought
 * (a link is never a history entry anyway).
 */
function currentId(): string | null {
  return currentThoughtId();
}

/** Re-renders the history bar from the local history + server metadata. */
async function render(): Promise<void> {
  if (host === null) return;
  const profileId = store.state.profileId;
  const networkId = store.state.networkId;
  const view = store.state.activeView;
  // The width is part of the signature: the visible chip set depends on it.
  // The view is part of it too: chips route the click per the active screen.
  const signature = `${profileId ?? ''}|${networkId ?? ''}|${view}|${currentId() ?? ''}|${String(store.state.showInactive)}|${String(store.state.showTrash)}|${host.clientWidth}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  if (profileId === null || networkId === null) {
    clear(host);
    return;
  }

  const entries = await etn.history.list(
    profileId,
    networkId,
    store.state.activeTabId,
    HISTORY_LIMIT,
  );
  if (host === null || !host.isConnected) return;
  const ids = entries.map((entry) => entry.thoughtId);

  const refs = ids.length > 0 ? await resolveRefs(networkId, ids) : new Map();
  const activeId = currentId();
  const visible = ids.filter((id) => {
    // The current thought is not a "recent" — it enters the list only after
    // the user moves away from it.
    if (id === activeId) return false;
    const ref = refs.get(id);
    // Неактуальные — по `show_inactive`, помеченные на удаление — по
    // `show_trash` (задача 77923b49): оба переключателя прячут облачко, но
    // ведут себя как одна настройка видимости (симметрия механизмов).
    if (ref === undefined) return true;
    return (store.state.showInactive || ref.active) &&
      (store.state.showTrash || ref.marked_for_deletion !== true);
  });

  clear(host);
  if (visible.length === 0) {
    const empty = div('history-empty');
    empty.textContent = 'нет предыдущих мыслей';
    host.append(empty);
    return;
  }

  const chips = visible.map((id) => ({
    id,
    ref: refs.get(id),
    el: buildChip(id, refs.get(id)),
  }));
  const plan = layoutChips(chips);

  if (plan.restCount === 0) {
    // Everything fits on the strip (§11.1: no `▾` button when N = 0).
    for (const chip of chips) host.append(chip.el);
  } else if (!plan.moreFits || plan.shownCount === 0) {
    // The strip cannot fit even one chip beside the button (an extremely
    // tight strip): show the chips and let them clip at the strip edge —
    // better than an orphan `▾ N` with nothing beside it (regression
    // a1c7c8dc-…).
    for (const chip of chips) host.append(chip.el);
  } else {
    const shown = chips.slice(0, plan.shownCount);
    const rest = chips.slice(plan.shownCount);
    for (const chip of shown) host.append(chip.el);
    const more = buildMoreButton(rest.length, () => openHistoryMenu(rest, more));
    host.append(more);
  }
}

/**
 * Plans how many chips fit on the strip (08-ui-spec.md §11.1). Every chip is
 * appended first — chips carry `flex: 0 0 auto` (styles.css), so each one
 * reports its NATURAL width instead of shrinking into the strip. The plan is
 * pure arithmetic over those real measured widths (plus the measured `▾ N`
 * button) via {@link planHistoryChips}; the host is left empty and the caller
 * re-adds exactly the planned chips.
 *
 * `host.scrollWidth` is deliberately NOT used: the host is a flex container
 * with `overflow: visible`, so its scrollWidth never grows past clientWidth
 * no matter how much content there is. The old peel loop therefore compared
 * `clientWidth - 44` against `clientWidth` itself, peeled EVERY chip off the
 * strip and left an orphan `▾ N` — the regressions 3ccacc1c-… («Мысли
 * истории не отображаются в нижней панели») and a1c7c8dc-….
 */
function layoutChips<T extends { el: HTMLElement }>(chips: T[]): HistoryChipPlan {
  if (host === null) return { shownCount: chips.length, restCount: 0, moreFits: true };
  for (const chip of chips) host.append(chip.el);
  const clientWidth = host.clientWidth;
  // Not laid out yet (host still detached) — keep every chip, the next
  // render tick (store subscribe / ResizeObserver) recomputes with a real
  // width.
  if (clientWidth <= 0) return { shownCount: chips.length, restCount: 0, moreFits: true };
  const chipWidths = chips.map((chip) => chip.el.getBoundingClientRect().width);
  // Measure the real button width with a probe so the reserve never
  // overestimates or underestimates the space the button will take.
  const probe = buildMoreButton(chips.length, () => undefined);
  host.append(probe);
  const moreWidth = probe.getBoundingClientRect().width;
  host.replaceChildren();
  return planHistoryChips(chipWidths, clientWidth, HISTORY_BAR_MORE_RESERVE, moreWidth);
}

/** Opens the dropdown for a list of history chips (thought refs). */
function openHistoryMenu(
  rest: Array<{ id: string; ref: import('@etn/shared').ThoughtRef | undefined; el: HTMLElement }>,
  anchor: HTMLElement,
): void {
  const items: MenuItem[] = rest.map(({ id, ref }) => ({
    // Строка-мысль — готовое облачко фабрики (профиль `chip`, ширина по
    // строке меню): значок, цвета, начертание, бледность неактуальной и метка
    // корзины. Прежняя ручная доклейка значка/стиля ушла вместе с ней.
    content: createThoughtCloud(ref ?? { id, title: id }, {
      profile: 'chip',
      width: 'container',
    }),
    label: ref?.title ?? id,
    dragId: id,
    onClick: () => openEntry(id),
  }));
  const rect = anchor.getBoundingClientRect();
  const root = showMenuAt(rect.left, rect.bottom + 2, items);
  // Dropdown rows mirror the strip chips: they drag onto the canvas (§11.1)
  // and Ctrl+hover previews the thought's permanent comment (preview stage 3,
  // same marking as `buildChip` — rows are built by `showMenuAt`, so they are
  // walked here in the same order as `rest`).
  const rows = root.querySelectorAll<HTMLElement>(':scope > .menu-item');
  rest.forEach(({ id, ref }, index) => {
    const row = rows[index];
    if (row === undefined) return;
    wireExternalDragSource(row, id, 'history', { fromMenu: true });
    markThoughtCommentPreview(row, id, ref?.title ?? id);
    // Строка дропдауна — та же мысль, что и чип полосы: правый клик даёт общее
    // меню мысли (`showMenuAt` внутри закроет сам дропдаун).
    wireHistoryContextMenu(row, id, ref?.title ?? id);
  });
}

/** Builds the `▾ N` button anchored to the right edge of the visible chips. */
function buildMoreButton(count: number, onClick: () => void): HTMLElement {
  const more = button('', onClick, 'history-more', 'Остальная история');
  more.append(svgIcon('chevron-down', 11), span(` ${count}`));
  return more;
}

/** Resolves metadata for history ids (single batched call). */
async function resolveRefs(
  networkId: string,
  ids: string[],
): Promise<Map<string, import('@etn/shared').ThoughtRef>> {
  try {
    const resolved = await etn.thoughts.resolve(networkId, ids.slice(0, 100));
    return new Map(resolved.map((ref) => [ref.id, ref]));
  } catch {
    return new Map();
  }
}

/** Builds a history mini-cloud chip (icon + title, thought styles, menus). */
function buildChip(id: string, ref: import('@etn/shared').ThoughtRef | undefined): HTMLElement {
  // Мини-облачко собирает общая фабрика (профиль `chip`): значок, цвета,
  // начертание, бледность неактуальной/помеченной, метка корзины и обрезка
  // названия раскладкой с подсказкой полного имени. Класс `history-cloud`
  // сохраняет раскладку полосы: модификатор `.prop-ref-cloud.history-cloud`
  // в styles.css держит чип несжимаемым (flex: 0 0 auto — чипы отчитываются
  // о своей естественной ширине для planHistoryChips) с пределом 170px.
  const chip = createThoughtCloud(
    ref ?? { id, title: id },
    {
      profile: 'chip',
      actions: {
        onClick: (targetId) => openEntry(targetId),
        // Контекстное меню — то же общее меню мысли, что у облачка на холсте и
        // чипа закреплённых (спецификация «Контекстное меню мысли»: меню
        // доступно во всех отображениях, включая чипы истории).
        onContextMenu: (event, targetId) => {
          event.stopPropagation();
          showThoughtContextMenu(
            event,
            { id: targetId, title: ref?.title ?? id, dir: 'siblings' },
            // Открытие из меню идёт тем же путём, что и клик по чипу: на карте —
            // в фокус, в структурах/дневнике — в редактор без смены фокуса.
            { openHandler: (openId) => openEntry(openId) },
          );
        },
      },
    },
  );
  chip.classList.add('history-cloud');
  // Stage 3 (same as the pinned bar's `buildChip`): no per-indicator icons on
  // a history mini-cloud — Ctrl+hover on the whole chip shows the thought's
  // permanent comment.
  markThoughtCommentPreview(chip, id, ref?.title ?? id);
  return chip;
}

/**
 * Вешает общее меню мысли на строку дропдауна истории (её строит `showMenuAt`,
 * а не фабрика облачка, поэтому жест подключается здесь). `preventDefault` +
 * `stopPropagation` — правый клик не должен «протечь» на панель/холст.
 */
function wireHistoryContextMenu(el: HTMLElement, id: string, title: string): void {
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showThoughtContextMenu(
      event,
      { id, title, dir: 'siblings' },
      { openHandler: (openId) => openEntry(openId) },
    );
  });
}
