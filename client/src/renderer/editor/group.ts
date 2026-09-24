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
 * Механика группы — общий компонент `lib/ui/collapsible.ts` (задача
 * a57e7998): здесь остаётся только редакторская привязка состояния к
 * `store.state.collapsedGroups` и классы `group-*`. Компактные подгруппы
 * внутри вкладок и ленивые секции («Упоминания …», «Использование …»)
 * делегируют тело и счётчик тому же компоненту.
 */

import { collapsibleSection } from '../lib/ui/collapsible.js';
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

/**
 * Builds a collapsible group section on top of the shared `collapsibleSection`:
 * the body is built lazily on first expansion, async builders render a
 * placeholder until resolved, and a `loadCount` promise updates the badge once
 * resolved (immediately, or with `lazyCount` after the first expansion). The
 * collapsed state is read from and written back to the editor store.
 */
export function groupSection(spec: GroupSpec): HTMLElement {
  return collapsibleSection({
    title: spec.title,
    count: spec.count,
    loadCount: spec.loadCount,
    lazyCount: spec.lazyCount,
    compact: spec.compact,
    actions: spec.actions,
    getCollapsed: () => {
      const saved = store.state.collapsedGroups[spec.id];
      return saved === undefined ? spec.defaultCollapsed === true : saved;
    },
    onToggle: (collapsed) => collapseChange?.(spec.id, collapsed),
    classes: {
      root: 'group',
      header: 'group-header',
      title: 'group-title',
      count: 'ui-badge ui-badge--quiet',
      caret: 'group-caret',
      body: 'group-body',
      actions: 'group-actions',
    },
    buildBody: () => spec.buildBody(),
  }).root;
}
