/**
 * Collapsible editor group (08-ui-spec.md §6.3).
 *
 * Each group has a stable id, a header (caret, title, count badge, actions)
 * and a body. The collapsed state is kept globally per group id in
 * `store.state.collapsedGroups` (L4 `editor_collapsed_groups`, bug ee745368:
 * it is NOT per entity — switching to another thought must not restore the
 * default expansion of a group the user collapsed); the editor module
 * persists it to the local DB through the debounced
 * {@link setCollapseChangeHandler} hook.
 *
 * Inside tabbed layouts the groups double as sub-groups (`compact`), and lazy
 * sections («Упоминания …», «Использование …») defer both their body and their
 * count badge to the first expansion (`lazyCount`).
 */

import { div, el, span } from '../lib/dom.js';
import { svgIcon } from '../lib/icons.js';
import { store } from '../state.js';

/** Callback fired when a group is collapsed/expanded (persistence hook). */
export type CollapseChange = (groupId: string, collapsed: boolean) => void;

let collapseChange: CollapseChange | null = null;

/** Registers the collapse-persistence hook (editor module does this once). */
export function setCollapseChangeHandler(next: CollapseChange | null): void {
  collapseChange = next;
}

/** A collapsible group specification. */
export interface GroupSpec {
  /** Stable group id, e.g. `permanent`, `chrono`, `attachments`. */
  id: string;
  title: string;
  /** Optional count badge text (static). */
  count?: string;
  /** Resolves the count badge text asynchronously (shown when no static count). */
  loadCount?: () => Promise<string | undefined>;
  /**
   * Defer the count badge to the first expansion: the badge starts as `…` and
   * `loadCount` is not called until the group is expanded (08-ui-spec.md §6.7 —
   * the search itself runs only on demand). The body may also publish the
   * resolved count directly via the `etn:set-count` event.
   */
  lazyCount?: boolean;
  /** Collapsed when there is no saved per-entity preference (default: expanded). */
  defaultCollapsed?: boolean;
  /** Compact look for sub-groups (link-type sections, usage property groups). */
  compact?: boolean;
  /** Extra header buttons (right side). */
  actions?: HTMLElement[];
  /** Builds the body content; may be async (loading placeholders inside). */
  buildBody(): HTMLElement | Promise<HTMLElement>;
}

/** Placeholder badge text for `lazyCount` groups until the search runs. */
const LAZY_COUNT_PLACEHOLDER = '…';

/**
 * Builds a collapsible group section. The body is built lazily on first
 * expansion; async builders render a placeholder until resolved. A `loadCount`
 * promise updates the count badge once resolved — immediately, or (with
 * `lazyCount`) after the first expansion. The body can publish a count itself
 * by dispatching `etn:set-count` (detail: badge text) on any child element.
 */
export function groupSection(spec: GroupSpec): HTMLElement {
  const saved = store.state.collapsedGroups[spec.id];
  let collapsed = saved === undefined ? spec.defaultCollapsed === true : saved;
  let built = !collapsed;

  const root = div('group');
  if (spec.compact === true) root.classList.add('compact');
  const header = div('group-header');
  // Chevron caret (L13): collapsed rotates it to point right.
  const caret = span('', 'group-caret');
  caret.append(svgIcon('chevron-down', 11));
  caret.classList.toggle('collapsed', collapsed);
  const title = span(spec.title, 'group-title');
  header.append(caret, title);
  const lazy = spec.lazyCount === true && spec.count === undefined;
  const countBadge = span(spec.count ?? (lazy ? LAZY_COUNT_PLACEHOLDER : ''), 'group-count');
  if (spec.count === undefined && !lazy) countBadge.classList.add('hidden');
  header.append(countBadge);
  const actionsBox = div('group-actions');
  if (spec.actions !== undefined) {
    for (const action of spec.actions) actionsBox.append(action);
  }
  header.append(actionsBox);
  root.append(header);

  // Async count badge: resolved independently of expansion, and re-resolved
  // when the group body reports a change (e.g. an item was added/removed).
  let countLoaded = false;
  const updateCount = (): void => {
    if (spec.count !== undefined || spec.loadCount === undefined) return;
    countLoaded = true;
    void Promise.resolve(spec.loadCount()).then((c) => {
      if (c !== undefined && c !== null) {
        countBadge.textContent = c;
        countBadge.classList.remove('hidden');
      }
    });
  };
  if (!lazy) updateCount();
  root.addEventListener('etn:refresh-count', updateCount);
  // The body already knows the count (e.g. the mentions search result) —
  // publish it without a second request.
  root.addEventListener('etn:set-count', (event) => {
    const detail = (event as CustomEvent<string>).detail;
    if (typeof detail === 'string' && detail !== '') {
      countBadge.textContent = detail;
      countBadge.classList.remove('hidden');
      countLoaded = true;
    }
  });

  let body: HTMLElement | null = null;

  const apply = (): void => {
    caret.classList.toggle('collapsed', collapsed);
    if (body !== null) body.remove();
    body = null;
    if (collapsed || !built) return;
    // The `.group-body` wrapper persists across the async load (content is
    // mounted into it), so styling and splitters can address it reliably.
    const bodyBox = div('group-body');
    bodyBox.append(el('span', 'muted', 'Загрузка…'));
    root.append(bodyBox);
    body = bodyBox;
    void Promise.resolve(spec.buildBody()).then((content) => {
      if (body !== bodyBox) return; // collapsed/rebuilt meanwhile
      bodyBox.replaceChildren(content);
    });
  };

  header.addEventListener('click', (event) => {
    if (event.target instanceof HTMLElement && event.target.closest('.group-actions') !== null) {
      return;
    }
    collapsed = !collapsed;
    built = true;
    collapseChange?.(spec.id, collapsed);
    if (!collapsed && lazy && !countLoaded) updateCount();
    apply();
  });

  apply();
  return root;
}
