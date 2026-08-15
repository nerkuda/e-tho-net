/**
 * Editor tab «Связи» (H11/H12 → L7, 08-ui-spec.md §6.7).
 *
 * For a thought — three collapsible groups separated by splitters:
 *  - «Прямые связи (N)» (expanded): links grouped by type; the type sections
 *    are themselves collapsible compact sub-groups (a long employee list no
 *    longer buries the other types). The list shows at most 15 rows, then
 *    scrolls. Rows keep the L5 context menu (open / change link type /
 *    delete link / delete thought).
 *  - «Упоминания …» (collapsed): the search runs on the first expansion; the
 *    `…` badge becomes `(N)`. Rows open the mentioning thought (focus) or link
 *    (link editor); the active tab never changes.
 *  - «Использование …» (collapsed): thoughts referencing this one through
 *    `thought_ref` property values (03-server-api.md §9.1), grouped by
 *    property name into collapsible sub-groups. Rows focus the referencing
 *    thought. Realtime `property-value.*` events reload an expanded body.
 *
 * For a link — a single group with its two endpoint thoughts.
 */

import type {
  Link,
  MentionHit,
  ThoughtLinksByTypeGroup,
  ThoughtLinksGrouped,
  ThoughtRef,
  ThoughtUsage,
} from '@etn/shared';

import { requireNetworkId, setFocus } from '../app.js';
import { applyThoughtIcon } from '../canvas/canvas.js';
import { deleteLink, deleteThought } from '../canvas/context-menu.js';
import { onRealtimeEvent } from '../realtime.js';
import { errorDialog, field, showDialog } from '../lib/dialog.js';
import { div, el, errText, renderHtml, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { MENU_SEPARATOR, showMenuAt, type MenuItem } from '../lib/menu.js';
import { createTypeCombobox } from '../lib/type-combobox.js';
import { patchFocusEdge, store } from '../state.js';
import { openLinkInEditor, registerTabContent, type EditorContext } from './editor.js';
import { groupSection, type GroupSpec } from './group.js';
import { rowSplitter } from './splitter.js';

/** Registers the links tab content (thoughts and links). */
export function registerLinksTab(): void {
  registerTabContent('links', buildLinksTab);
  wireUsageRealtime();
}

/** Builds the whole «Связи» tab pane content for the entity. */
function buildLinksTab(ctx: EditorContext): HTMLElement {
  if (ctx.ownerType === 'link' && ctx.link !== null) {
    const root = div('links-tab');
    root.append(
      groupSection(
        {
          id: 'links',
          title: 'Связи',
          count: '(2)',
          buildBody: () => buildLinkEndpointsBody(ctx),
        },
        ctx.ownerId,
      ),
    );
    return root;
  }

  const root = div('links-tab');
  const direct = groupSection(
    {
      id: 'links',
      title: 'Прямые связи',
      loadCount: () => countLinks(ctx),
      buildBody: () => buildDirectLinksBody(ctx),
    },
    ctx.ownerId,
  );
  const mentions = groupSection(
    {
      id: 'mentions',
      title: 'Упоминания',
      lazyCount: true,
      defaultCollapsed: true,
      buildBody: () => buildMentionsBody(ctx),
    },
    ctx.ownerId,
  );
  const usage = groupSection(
    {
      id: 'usage',
      title: 'Использование',
      lazyCount: true,
      defaultCollapsed: true,
      buildBody: () => buildUsageBody(ctx),
    },
    ctx.ownerId,
  );
  // Splitters clamp the whole group above them (header + body) — expanded
  // groups flex-fill the tab, so a clamp must stop the group itself, not just
  // its body. A collapsed group (no body) is not resizable: its splitter is
  // inert and never leaves a stale clamp behind (08-ui-spec.md §6.3).
  const resizable = (group: HTMLElement): HTMLElement | null =>
    group.querySelector(':scope > .group-body') !== null ? group : null;
  root.append(
    direct,
    rowSplitter(() => resizable(direct), { min: 50 }),
    mentions,
    rowSplitter(() => resizable(mentions), { min: 50 }),
    usage,
  );
  return root;
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

/**
 * The type-group heading read from the edited thought's point of view (L6):
 * all links outgoing → `name_forward`, all incoming → `name_reverse`, mixed →
 * both names.
 */
function groupName(ownerId: string, group: ThoughtLinksByTypeGroup): string {
  const type = store.state.linkTypes.find((t) => t.id === group.type_id);
  if (type === undefined) return group.type_name;
  const outgoing = group.items.filter((i) => i.link.source_id === ownerId).length;
  if (outgoing === group.items.length) return type.name_forward;
  if (outgoing === 0) return type.name_reverse;
  return `${type.name_forward} / ${type.name_reverse}`;
}

/** Builds the direct-links group body: collapsible per-type sections (L7). */
function buildDirectLinksBody(ctx: EditorContext): HTMLElement {
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
    // The group body itself is the scroll area (CSS caps it at 15 rows,
    // 08-ui-spec.md §6.7); sub-groups are rebuilt on every reload, their
    // collapsed state persisting per entity through groupSection ids.
    const appendSection = (spec: GroupSpec): void => {
      box.append(groupSection(spec, ctx.ownerId));
    };

    let count = 0;

    for (const group of grouped.by_type) {
      count += group.items.length;
      if (group.items.length === 0) continue;
      const items = group.items;
      appendSection({
        id: `links:type:${group.type_id}`,
        title: groupName(ctx.ownerId, group),
        count: `(${items.length})`,
        compact: true,
        buildBody: () => {
          const body = div('link-group-rows');
          for (const item of items) {
            const outgoing = item.link.source_id === ctx.ownerId;
            body.append(linkRow(item.link, item.target_thought, outgoing, refresh));
          }
          return body;
        },
      });
    }
    if (grouped.untyped_parents.length > 0) {
      count += grouped.untyped_parents.length;
      const items = grouped.untyped_parents;
      appendSection({
        id: 'links:type:__parents',
        title: 'Источники',
        count: `(${items.length})`,
        compact: true,
        buildBody: () => {
          const body = div('link-group-rows');
          for (const item of items) {
            const other = item.source_thought ?? item.target_thought;
            if (other !== undefined) body.append(linkRow(item.link, other, false, refresh));
          }
          return body;
        },
      });
    }
    if (grouped.untyped_children.length > 0) {
      count += grouped.untyped_children.length;
      const items = grouped.untyped_children;
      appendSection({
        id: 'links:type:__children',
        title: 'Назначения',
        count: `(${items.length})`,
        compact: true,
        buildBody: () => {
          const body = div('link-group-rows');
          for (const item of items) {
            const other = item.target_thought ?? item.source_thought;
            if (other !== undefined) body.append(linkRow(item.link, other, true, refresh));
          }
          return body;
        },
      });
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

/** Builds the mentions body (search on expansion; badge via etn:set-count). */
function buildMentionsBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('mentions-body');
  void reload();

  async function reload(): Promise<void> {
    box.replaceChildren(el('span', 'muted', 'Поиск упоминаний…'));
    let hits: MentionHit[];
    try {
      hits = await etn.thoughts.mentions(networkId, ctx.ownerId);
    } catch (err) {
      box.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    // `…` → the resolved count in the group header (08-ui-spec.md §6.7). The
    // fetch cannot resolve before the group machinery mounts this box (the
    // mount runs on a microtask queued before the response arrives), so
    // `closest` finds the header; after a collapse it is a harmless no-op.
    box.closest('.group')?.dispatchEvent(new CustomEvent('etn:set-count', { detail: `(${hits.length})` }));
    box.replaceChildren();
    if (hits.length === 0) {
      box.append(el('p', 'muted', 'Название нигде не упоминается.'));
      return;
    }
    // The group body (this box) is the scroll area — items flow directly.
    for (const hit of hits) {
      const item = div('mention-item');
      const kind = span(hit.owner_type === 'thought' ? '💭' : '🔗', 'muted');
      const title = el('span', undefined, hit.title);
      title.style.fontWeight = '600';
      const snippet = el('div', 'muted mention-snippet');
      // The snippet carries server-side <mark> highlights around matches —
      // like the search panel, render it as (escaped, trusted) HTML.
      renderHtml(snippet, hit.snippet);
      item.append(kind, title, snippet);
      item.addEventListener('click', () => void open(hit));
      box.append(item);
    }
  }
  /** Opens the mentioning entity (thought → focus, link → editor). */
  async function open(hit: MentionHit): Promise<void> {
    if (hit.owner_type === 'thought') {
      void setFocus(hit.owner_id);
      return;
    }
    try {
      const link = await etn.links.get(networkId, hit.owner_id);
      openLinkInEditor(link);
    } catch {
      // stale link
    }
  }

  return box;
}

/** Reload callback of the currently mounted usage body (realtime hook). */
let usageReload: (() => void) | null = null;
let usageWired = false;

/** Reloads the usage body on foreign `property-value.*` events. */
function wireUsageRealtime(): void {
  if (usageWired) return;
  usageWired = true;
  onRealtimeEvent((evt) => {
    if (evt.type === 'property-value.set' || evt.type === 'property-value.deleted') {
      usageReload?.();
    }
  });
}

/** Builds the usage body: referencing thoughts grouped by property (L7). */
function buildUsageBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('usage-body');
  // Declared BEFORE the initial reload() call: reload is a hoisted function
  // declaration, and reading this from inside it during the call would hit
  // the temporal dead zone (same pattern as properties.ts).
  let everMounted = false;
  usageReload = () => void reload();
  void reload();

  async function reload(): Promise<void> {
    // The first reload starts before the group mounts this box — proceed
    // detached; skip only bodies that were mounted and then replaced (a
    // newer editor render rebuilt the group and installed its own hook).
    if (everMounted && !box.isConnected) return;
    box.replaceChildren(el('span', 'muted', 'Поиск использования…'));
    let usage: ThoughtUsage;
    try {
      usage = await etn.thoughts.usage(networkId, ctx.ownerId);
    } catch (err) {
      box.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    if (box.isConnected) everMounted = true;
    box.closest('.group')?.dispatchEvent(new CustomEvent('etn:set-count', { detail: `(${usage.total})` }));
    box.replaceChildren();
    if (usage.groups.length === 0) {
      box.append(el('p', 'muted', 'Мысль не используется в свойствах.'));
      return;
    }
    for (const group of usage.groups) {
      const thoughts = group.thoughts;
      box.append(
        groupSection(
          {
            id: `usage:${group.property_id}`,
            title: group.key,
            count: `(${thoughts.length})`,
            compact: true,
            defaultCollapsed: true,
            buildBody: () => {
              const body = div('link-group-rows');
              for (const thought of thoughts) {
                const row = div('link-group-item usage-row');
                const icon = span('', 'mini-icon');
                applyThoughtIcon(icon, thought);
                const title = el('span', 'link-item-title', thought.title);
                if (!thought.active) title.classList.add('muted');
                row.append(icon, title);
                row.addEventListener('click', () => setFocus(thought.id));
                body.append(row);
              }
              return body;
            },
          },
          ctx.ownerId,
        ),
      );
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
  // `undefined` — cancelled; `null` — "no type".
  if (value === undefined || value === link.type_id) return;
  try {
    const updated = await etn.links.update(networkId, link.id, { type_id: value }, link.version);
    // Repaint the line at once — the actor gets no realtime echo
    // (04-realtime.md §5); the group body reloads via the callback.
    patchFocusEdge(updated);
    onChanged();
  } catch (err) {
    errorDialog('Изменить тип связи', err);
  }
}

/**
 * Link-type picker dialog (searchable, L6): resolves the type id, `null` for
 * "no type", or `undefined` when cancelled.
 */
function pickLinkType(current: string | null): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    let picked: string | null | undefined = undefined;
    const combo = createTypeCombobox({
      options: () =>
        store.state.linkTypes.map((t) => ({
          id: t.id,
          label: `${t.name_forward} / ${t.name_reverse}`,
          line: { color: t.color, style: t.style, width: t.width },
        })),
      value: current,
      placeholder: 'без типа',
      emptyLabel: 'без типа',
      onChange: (typeId) => {
        picked = typeId;
      },
    });

    const body = div('form-stack');
    body.append(field('Тип связи', combo.root));
    showDialog({
      title: 'Изменить тип связи',
      body,
      buttons: [
        { label: 'Отмена', onClick: () => resolve(undefined) },
        {
          label: 'OK',
          primary: true,
          onClick: () => resolve(picked ?? current),
        },
      ],
      onMount: () => combo.root.querySelector('input')?.focus(),
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
