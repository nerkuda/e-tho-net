/**
 * Collapsible editor group (08-ui-spec.md §6.3).
 *
 * Each group has a stable id, a header (caret, title, count badge, actions)
 * and a body. The collapsed state is kept per entity in
 * `store.state.collapsedGroups` (L4 `editor_collapsed_groups`); the editor
 * module persists it to the local DB through the debounced
 * {@link setCollapseChangeHandler} hook.
 */

import { div, el, span } from '../lib/dom.js';
import { store } from '../state.js';

/** Callback fired when a group is collapsed/expanded (persistence hook). */
export type CollapseChange = (entityId: string, groupId: string, collapsed: boolean) => void;

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
  /** Optional count badge text. */
  count?: string;
  /** Extra header buttons (right side). */
  actions?: HTMLElement[];
  /** Builds the body content; may be async (loading placeholders inside). */
  buildBody(): HTMLElement | Promise<HTMLElement>;
}

/**
 * Builds a collapsible group section. The body is built lazily on first
 * expansion; async builders render a placeholder until resolved.
 */
export function groupSection(spec: GroupSpec, entityId: string): HTMLElement {
  let collapsed = store.state.collapsedGroups[entityId]?.[spec.id] === true;

  const root = div('group');
  const header = div('group-header');
  const caret = span(collapsed ? '▸' : '▾', 'group-caret');
  const title = span(spec.title, 'group-title');
  header.append(caret, title);
  if (spec.count !== undefined) header.append(span(spec.count, 'group-count'));
  const actionsBox = div('group-actions');
  if (spec.actions !== undefined) {
    for (const action of spec.actions) actionsBox.append(action);
  }
  header.append(actionsBox);
  root.append(header);

  let body: HTMLElement | null = null;
  let built = false;

  const apply = (): void => {
    caret.textContent = collapsed ? '▸' : '▾';
    if (body !== null) body.remove();
    body = null;
    if (collapsed || !built) return;
    const placeholder = div('group-body');
    placeholder.append(el('span', 'muted', 'Загрузка…'));
    root.append(placeholder);
    body = placeholder;
    void Promise.resolve(spec.buildBody()).then((content) => {
      if (body !== placeholder) return; // collapsed/rebuilt meanwhile
      placeholder.replaceWith(content);
      body = content;
    });
  };

  header.addEventListener('click', (event) => {
    if (event.target instanceof HTMLElement && event.target.closest('.group-actions') !== null) {
      return;
    }
    collapsed = !collapsed;
    built = true;
    collapseChange?.(entityId, spec.id, collapsed);
    apply();
  });

  if (!collapsed) {
    built = true;
    apply();
  }
  return root;
}
