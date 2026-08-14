/**
 * Editor group: links of a thought, and the two endpoints of a link
 * (08-ui-spec.md §6.7).
 *
 * - For a thought: links grouped by type, untyped split into sources/targets.
 *   The opposite thought's title is clickable → it becomes the focus (the
 *   separate "Открыть" command that opened the link in the editor is gone).
 * - For a link: exactly two rows — source and target thoughts — without
 *   grouping; clicking either puts it in focus.
 */

import type { ThoughtLinksGrouped, ThoughtRef } from '@etn/shared';

import { requireNetworkId, setFocus } from '../app.js';
import { applyThoughtIcon } from '../canvas/canvas.js';
import { div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { registerGroupBuilder, type EditorContext } from './editor.js';

/** Registers the links group (thoughts and links). */
export function registerLinksGroup(): void {
  registerGroupBuilder((ctx) => {
    if (ctx.ownerType === 'thought') {
      return { id: 'links', title: 'Связи', buildBody: () => buildLinksBody(ctx) };
    }
    if (ctx.ownerType === 'link' && ctx.link !== null) {
      return { id: 'links', title: 'Связи', buildBody: () => buildLinkEndpointsBody(ctx) };
    }
    return null;
  });
}

/** Builds the links group body for a thought (grouped by type, untyped by direction). */
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
        const outgoing = item.link.source_id === ctx.ownerId;
        box.append(linkRow(item.target_thought, outgoing, () => setFocus(item.target_thought.id)));
      }
    }
    if (grouped.untyped_parents.length > 0) {
      count += grouped.untyped_parents.length;
      const header = el('p', 'muted', `Источники (${grouped.untyped_parents.length})`);
      header.style.margin = '8px 0 2px';
      box.append(header);
      for (const item of grouped.untyped_parents) {
        const other = item.source_thought ?? item.target_thought;
        if (other !== undefined) box.append(linkRow(other, false, () => setFocus(other.id)));
      }
    }
    if (grouped.untyped_children.length > 0) {
      count += grouped.untyped_children.length;
      const header = el('p', 'muted', `Назначения (${grouped.untyped_children.length})`);
      header.style.margin = '8px 0 2px';
      box.append(header);
      for (const item of grouped.untyped_children) {
        const other = item.target_thought ?? item.source_thought;
        if (other !== undefined) box.append(linkRow(other, true, () => setFocus(other.id)));
      }
    }
    if (count === 0) box.append(el('p', 'muted', 'Связей нет.'));
  }

  return box;
}

/** Builds the links group body for a link: its source and target thoughts. */
function buildLinkEndpointsBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('links-body');
  if (ctx.link === null) return box;
  const link = ctx.link;
  void reload();

  async function reload(): Promise<void> {
    box.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let refs: ThoughtRef[];
    try {
      refs = await etn.thoughts.resolve(networkId, [link.source_id, link.target_id]);
    } catch (err) {
      box.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    box.replaceChildren();
    const byId = new Map(refs.map((r) => [r.id, r]));
    const source = byId.get(link.source_id);
    const target = byId.get(link.target_id);
    if (source !== undefined) {
      box.append(endpointRow('источник', source, () => setFocus(source.id)));
    }
    if (target !== undefined) {
      box.append(endpointRow('назначение', target, () => setFocus(target.id)));
    }
  }

  return box;
}

/** A clickable opposite-thought row: click → focus that thought. */
function linkRow(other: ThoughtRef, outgoing: boolean, onOpen: () => void): HTMLElement {
  const row = div('link-group-item');
  const arrow = span(outgoing ? '→' : '←', 'muted');
  const icon = span('');
  applyThoughtIcon(icon, other);
  const title = el('span', 'link-item-title', other.title);
  if (!other.active) title.classList.add('muted');
  row.append(arrow, icon, title);
  row.addEventListener('click', () => onOpen());
  return row;
}

/** A labelled endpoint row (used in the link editor: source / target). */
function endpointRow(label: string, other: ThoughtRef, onOpen: () => void): HTMLElement {
  const row = div('link-group-item');
  row.append(span(label, 'muted link-item-label'));
  const icon = span('');
  applyThoughtIcon(icon, other);
  const title = el('span', 'link-item-title', other.title);
  if (!other.active) title.classList.add('muted');
  row.append(icon, title);
  row.addEventListener('click', () => onOpen());
  return row;
}
