/**
 * Editor group: links of a thought (H11, 08-ui-spec.md §6.7).
 *
 * Thought-only. `links.listByThought` returns typed groups plus untyped
 * parents/children; each row shows the opposite thought (with direction
 * arrow), the link type and the link activity. Clicking a row opens the link
 * in the editor (focus stays on the thought).
 */

import type { ThoughtLinksGrouped } from '@etn/shared';

import { button, div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { requireNetworkId } from '../app.js';
import { openLinkInEditor, registerGroupBuilder, type EditorContext } from './editor.js';

/** Registers the links group (thoughts only). */
export function registerLinksGroup(): void {
  registerGroupBuilder((ctx) => {
    if (ctx.ownerType !== 'thought') return null;
    return { id: 'links', title: 'Связи', buildBody: () => buildLinksBody(ctx) };
  });
}

/** Builds the links group body (grouped by type, untyped by direction). */
function buildLinksBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('links-body');
  void reload();

  async function reload(): Promise<void> {
    box.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let grouped: ThoughtLinksGrouped;
    try {
      grouped = await etn.links.listByThought(networkId, ctx.ownerId);
    } catch (err) {
      box.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    box.replaceChildren();

    let count = 0;
    for (const group of grouped.by_type) {
      count += group.items.length;
      if (group.items.length === 0) continue;
      const header = el('p', 'muted', `${group.type_name} (${group.items.length})`);
      header.style.margin = '8px 0 2px';
      box.append(header);
      for (const item of group.items) {
        box.append(linkRow(item.link, item.target_thought, item.link.source_id === ctx.ownerId));
      }
    }
    if (grouped.untyped_parents.length > 0) {
      count += grouped.untyped_parents.length;
      const header = el('p', 'muted', `Источники (${grouped.untyped_parents.length})`);
      header.style.margin = '8px 0 2px';
      box.append(header);
      for (const item of grouped.untyped_parents) {
        const other = item.source_thought ?? item.target_thought;
        if (other !== undefined) box.append(linkRow(item.link, other, false));
      }
    }
    if (grouped.untyped_children.length > 0) {
      count += grouped.untyped_children.length;
      const header = el('p', 'muted', `Назначения (${grouped.untyped_children.length})`);
      header.style.margin = '8px 0 2px';
      box.append(header);
      for (const item of grouped.untyped_children) {
        const other = item.target_thought ?? item.source_thought;
        if (other !== undefined) box.append(linkRow(item.link, other, true));
      }
    }
    if (count === 0) box.append(el('p', 'muted', 'Связей нет.'));
  }

  /** Builds one clickable link row (opens the link in the editor). */
  function linkRow(
    link: { id: string; type_id: string | null; active: boolean },
    other: { title: string; active: boolean; icon: string | null },
    outgoing: boolean,
  ): HTMLElement {
    const row = div('link-group-item');
    const arrow = span(outgoing ? '→' : '←', 'muted');
    const icon = span(other.icon ?? '💭');
    const title = el('span', undefined, other.title);
    title.style.flex = '1';
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    title.style.whiteSpace = 'nowrap';
    if (!other.active) title.classList.add('muted');
    if (!link.active) title.classList.add('faint');
    row.append(arrow, icon, title);
    row.append(button('открыть', () => void open(link.id), 'link-btn'));
    return row;
  }

  /** Opens a link in the editor (fetches the current record first). */
  async function open(linkId: string): Promise<void> {
    try {
      const link = await etn.links.get(networkId, linkId);
      openLinkInEditor(link);
    } catch {
      // stale link — realtime refresh will update the group
    }
  }

  return box;
}
