/**
 * Editor group: links of a thought, and the two endpoints of a link
 * (08-ui-spec.md §6.7).
 *
 * - For a thought: links grouped by type, untyped split into sources/targets.
 *   The opposite thought's title is clickable → it becomes the focus (the
 *   separate "Открыть" command that opened the link in the editor is gone).
 *   Each row also carries a context menu (L5): open / change the link type /
 *   delete the link / delete the opposite thought.
 * - For a link: exactly two rows — source and target thoughts — without
 *   grouping; clicking either puts it in focus.
 */

import type { Link, ThoughtLinksGrouped, ThoughtRef } from '@etn/shared';

import { requireNetworkId, setFocus } from '../app.js';
import { applyThoughtIcon } from '../canvas/canvas.js';
import { deleteLink, deleteThought } from '../canvas/context-menu.js';
import { errorDialog, field, showDialog } from '../lib/dialog.js';
import { div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { MENU_SEPARATOR, showMenuAt, type MenuItem } from '../lib/menu.js';
import { patchFocusEdge, store } from '../state.js';
import { registerGroupBuilder, type EditorContext } from './editor.js';

/** Registers the links group (thoughts and links). */
export function registerLinksGroup(): void {
  registerGroupBuilder((ctx) => {
    if (ctx.ownerType === 'thought') {
      return {
        id: 'links',
        title: 'Связи',
        loadCount: () => countLinks(ctx),
        buildBody: () => buildLinksBody(ctx),
      };
    }
    if (ctx.ownerType === 'link' && ctx.link !== null) {
      return { id: 'links', title: 'Связи', count: '(2)', buildBody: () => buildLinkEndpointsBody(ctx) };
    }
    return null;
  });
}

/** Counts a thought's links for the group badge. */
async function countLinks(ctx: EditorContext): Promise<string | undefined> {
  const networkId = requireNetworkId();
  try {
    const grouped = await etn.links.listByThought(networkId, ctx.ownerId);
    const n =
      grouped.by_type.reduce((sum, g) => sum + g.items.length, 0) +
      grouped.untyped_parents.length +
      grouped.untyped_children.length;
    return `(${n})`;
  } catch {
    return undefined;
  }
}

/** Builds the links group body for a thought (grouped by type, untyped by direction). */
function buildLinksBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('links-body');
  void reload();

  /** Re-reads the grouped links; called after row-menu changes too (L5). */
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

    // A row-menu change (delete link/thought, link type) re-groups the list.
    const refresh = (): void => {
      void reload();
    };

    let count = 0;
    for (const group of grouped.by_type) {
      count += group.items.length;
      if (group.items.length === 0) continue;
      const header = el('p', 'muted', `${group.type_name} (${group.items.length})`);
      header.style.margin = '8px 0 2px';
      box.append(header);
      for (const item of group.items) {
        const outgoing = item.link.source_id === ctx.ownerId;
        box.append(linkRow(item.link, item.target_thought, outgoing, refresh));
      }
    }
    if (grouped.untyped_parents.length > 0) {
      count += grouped.untyped_parents.length;
      const header = el('p', 'muted', `Источники (${grouped.untyped_parents.length})`);
      header.style.margin = '8px 0 2px';
      box.append(header);
      for (const item of grouped.untyped_parents) {
        const other = item.source_thought ?? item.target_thought;
        if (other !== undefined) box.append(linkRow(item.link, other, false, refresh));
      }
    }
    if (grouped.untyped_children.length > 0) {
      count += grouped.untyped_children.length;
      const header = el('p', 'muted', `Назначения (${grouped.untyped_children.length})`);
      header.style.margin = '8px 0 2px';
      box.append(header);
      for (const item of grouped.untyped_children) {
        const other = item.target_thought ?? item.source_thought;
        if (other !== undefined) box.append(linkRow(item.link, other, true, refresh));
      }
    }
    if (count === 0) box.append(el('p', 'muted', 'Связей нет.'));
    // Tell the group header to refresh its count badge.
    box.closest('.group')?.dispatchEvent(new CustomEvent('etn:refresh-count'));
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

/** A clickable opposite-thought row: click → focus, right-click → menu (L5). */
function linkRow(
  link: Link,
  other: ThoughtRef,
  outgoing: boolean,
  onChanged: () => void,
): HTMLElement {
  const row = div('link-group-item');
  const arrow = span(outgoing ? '→' : '←', 'muted');
  const icon = span('', 'mini-icon');
  applyThoughtIcon(icon, other);
  const title = el('span', 'link-item-title', other.title);
  if (!other.active) title.classList.add('muted');
  row.append(arrow, icon, title);
  row.addEventListener('click', () => setFocus(other.id));
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showMenuAt(event.clientX, event.clientY, buildRowMenuItems(link, other, onChanged));
  });
  return row;
}

// ---------------------------------------------------------------------------
// Row context menu (L5)
// ---------------------------------------------------------------------------

/** Builds the row menu items: open / change link type / delete link or thought. */
function buildRowMenuItems(link: Link, other: ThoughtRef, onChanged: () => void): MenuItem[] {
  return [
    { label: 'Открыть', onClick: () => setFocus(other.id) },
    MENU_SEPARATOR,
    { label: 'Изменить тип связи…', onClick: () => void changeLinkType(link, onChanged) },
    MENU_SEPARATOR,
    { label: 'Удалить связь', danger: true, onClick: () => void removeLink(link, onChanged) },
    { label: 'Удалить мысль', danger: true, onClick: () => void removeThought(other, onChanged) },
  ];
}

/** Deletes the link (confirmation inside `deleteLink`), then reloads the body. */
async function removeLink(link: Link, onChanged: () => void): Promise<void> {
  const networkId = requireNetworkId();
  if (await deleteLink(networkId, link.id)) onChanged();
}

/** Deletes the thought (confirmation inside `deleteThought`), then reloads. */
async function removeThought(other: ThoughtRef, onChanged: () => void): Promise<void> {
  const networkId = requireNetworkId();
  if (await deleteThought(networkId, { id: other.id, title: other.title })) onChanged();
}

/** Opens the link-type dialog and saves the picked type (L5). */
async function changeLinkType(link: Link, onChanged: () => void): Promise<void> {
  const networkId = requireNetworkId();
  const value = await pickLinkType(link.type_id);
  if (value === null || value === (link.type_id ?? '')) return;
  try {
    const updated = await etn.links.update(
      networkId,
      link.id,
      { type_id: value === '' ? null : value },
      link.version,
    );
    // Repaint the line at once — the actor gets no realtime echo
    // (04-realtime.md §5); the group body reloads via the callback.
    patchFocusEdge(updated);
    onChanged();
  } catch (err) {
    errorDialog('Изменить тип связи', err);
  }
}

/**
 * Link-type picker dialog: a select over `store.state.linkTypes` plus a
 * "без типа" entry. Resolves the type id, `''` for "no type", or `null` when
 * cancelled — mirroring the link editor header select.
 */
function pickLinkType(current: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    const select = el('select', 'select-input');
    const none = el('option', undefined, 'без типа');
    none.value = '';
    select.append(none);
    for (const type of store.state.linkTypes) {
      const option = el('option', undefined, `${type.name_forward} / ${type.name_reverse}`);
      option.value = type.id;
      select.append(option);
    }
    select.value = current ?? '';

    const body = div('form-stack');
    body.append(field('Тип связи', select));
    showDialog({
      title: 'Изменить тип связи',
      body,
      buttons: [
        { label: 'Отмена', onClick: () => resolve(null) },
        { label: 'OK', primary: true, onClick: () => resolve(select.value) },
      ],
      onMount: () => select.focus(),
    });
  });
}

/** A labelled endpoint row (used in the link editor: source / target). */
function endpointRow(label: string, other: ThoughtRef, onOpen: () => void): HTMLElement {
  const row = div('link-group-item');
  row.append(span(label, 'muted link-item-label'));
  const icon = span('', 'mini-icon');
  applyThoughtIcon(icon, other);
  const title = el('span', 'link-item-title', other.title);
  if (!other.active) title.classList.add('muted');
  row.append(icon, title);
  row.addEventListener('click', () => onOpen());
  return row;
}
