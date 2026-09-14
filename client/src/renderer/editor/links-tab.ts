/**
 * Editor tab «Связи» (задача 8ab775d9, единая модель связей; 08-ui-spec.md
 * §6.7). Для мысли — две сворачиваемые группы, разделённые сплиттером высоты:
 *  - «Упоминания» (свёрнута по умолчанию): «Ссылки на мысль» (явные
 *    `[[#<id>]]` в body_md) и «Упоминания в тексте» (FTS5 по
 *    title/synonyms). Строки открывают упоминающую мысль (focus) или связь
 *    (link editor); активная вкладка не меняется. Realtime
 *    `property-value.*` события перезагружают развёрнутое тело.
 *  - «Локальный граф» (свёрнута по умолчанию): мини-граф — центральная
 *    мысль и все её прямые соседи (любой тип связи, оба направления).
 *
 * Прямые типизированные связи и структурные «Родители»/«Потомки» живут
 * теперь на вкладке «Свойства» как свойства-связи (счётчики + чипы) —
 * прежние группы «Прямые связи» и «Использование» удалены как дублирование.
 *
 * For a link — a single group with its two endpoint thoughts.
 */

import type {
  Link,
  MentionHit,
  ThoughtRef,
} from '@etn/shared';

import { requireNetworkId, setFocus } from '../app.js';
import { applyCloudStyle, applyThoughtIcon, resolveCloudStyle } from '../canvas/canvas.js';
import { div, el, errText, renderHtml, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { markCommentPreview, markThoughtCommentPreview } from '../lib/hover-preview.js';
import { store } from '../state.js';
import { openLinkInEditor, registerTabContent, type EditorContext } from './editor.js';
import { groupSection } from './group.js';
import { applyGroupClamp } from './list-heights.js';
import { buildMiniGraph } from './mini-graph.js';
import { paintWikiIdsInSnippet, resolveWikiIdsInSnippet } from './wiki-link-resolver.js';
import { rowSplitter } from './splitter.js';

/** Cap on the batched resolve call — server-side limit of `thoughts.resolve`. */
const RESOLVE_BATCH = 100;

/** Registers the links tab content (thoughts and links). */
export function registerLinksTab(): void {
  registerTabContent('links', buildLinksTab);
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
      ),
    );
    return root;
  }

  const root = div('links-tab');

  // «Упоминания» (task R9): содержит две подсекции — «Ссылки на мысль»
  // (явные [[#<id>]] в body_md) и «Упоминания в тексте» (FTS5 по
  // title/synonyms). Свёрнута по умолчанию — пользователь явно решает, что
  // готов подождать выполнения запроса.
  const mentions = groupSection(
    {
      id: 'mentions',
      title: 'Упоминания',
      lazyCount: true,
      defaultCollapsed: true,
      buildBody: () => buildMentionsParentBody(ctx),
    },
  );
  // «Локальный граф» (задача 8ab775d9): мини-граф в стиле Obsidian —
  // центр = редактируемая мысль, вокруг — все прямые соседи. Свёрнут по
  // умолчанию, чтобы не рендерить SVG до явного запроса пользователя.
  // Строится лениво при первом разворачивании.
  const localGraph = groupSection(
    {
      id: 'links.local-graph',
      title: 'Локальный граф',
      lazyCount: true,
      defaultCollapsed: true,
      buildBody: () => buildLocalGraphBody(ctx),
    },
  );
  // Splitters clamp the whole group above them (header + body) — expanded
  // groups flex-fill the tab, so a clamp must stop the group itself, not just
  // its body. A collapsed group (no body) is not resizable: its splitter is
  // inert and never leaves a stale clamp behind (08-ui-spec.md §6.3).
  // The drag is remembered as the group's max height: a clamped group shrinks
  // to its content (flex-grow 0) instead of filling the tab, and the cap
  // survives entity changes and restarts (ee745368, list-heights.ts).
  const resizable = (group: HTMLElement): HTMLElement | null =>
    group.querySelector(':scope > .group-body') !== null ? group : null;
  applyGroupClamp(mentions, 'links.mentions');
  applyGroupClamp(localGraph, 'links.local-graph');
  root.append(
    mentions,
    rowSplitter(() => resizable(mentions), { min: 50, persistKey: 'links.mentions' }),
    localGraph,
  );
  return root;
}

/**
 * Тело группы «Локальный граф»: стягивает всех прямых соседей мысли
 * (структурные «Родители»/«Потомки» + типизированные связи в обе стороны)
 * и рисует мини-канвас. Массовые связи (≥10 одинакового типа к одной цели)
 * скрываются за чипом «+N».
 */
async function buildLocalGraphBody(ctx: EditorContext): Promise<HTMLElement> {
  const networkId = requireNetworkId();
  const root = div('links-local-graph');
  if (ctx.thought === null) {
    root.append(el('p', 'muted', 'Граф недоступен — мысль ещё загружается.'));
    return root;
  }
  // Параллельно: соседи (оба направления одним вызовом), полный список связей
  // мысли (для подписей рёбер), сама мысль (уже есть в `ctx.thought`).
  let neighbours: Array<{ id: string; title: string }> = [];
  let links: Link[] = [];
  try {
    const [parents, children, grouped] = await Promise.all([
      etn.thoughts.neighbors(networkId, ctx.ownerId, 'parents', 200),
      etn.thoughts.neighbors(networkId, ctx.ownerId, 'children', 200),
      etn.links.listByThought(networkId, ctx.ownerId, true),
    ]);
    const seen = new Set<string>();
    const all = [...parents, ...children];
    for (const item of all) {
      if (item.id !== ctx.ownerId && !seen.has(item.id)) {
        seen.add(item.id);
        neighbours.push({ id: item.id, title: item.title });
      }
    }
    links = [
      ...grouped.by_type.flatMap((g) => g.items) as unknown as Link[],
      ...grouped.untyped_parents as unknown as Link[],
      ...grouped.untyped_children as unknown as Link[],
    ];
  } catch (err) {
    root.append(el('p', 'muted', `Не удалось загрузить граф: ${errText(err)}`));
    return root;
  }

  // Считаем массовые связи: для каждой связи с типом группируем по типу,
  // и если у одной и той же цели несколько связей одного типа — прячем
  // избыточные рёбра.
  const massMap = new Map<string, { hidden: number; label: string }>();
  // Простая эвристика: считаем повторяющиеся пары (type_id, target_id) и
  // если их >= MASS_LINK_THRESHOLD — считаем массовыми.
  const pairCounts = new Map<string, { typeName: string; count: number }>();
  for (const link of links) {
    const otherId = link.source_id === ctx.ownerId ? link.target_id : link.source_id;
    if (otherId === ctx.ownerId) continue;
    const key = `${link.type_id ?? ''}|${otherId}`;
    const existing = pairCounts.get(key);
    if (existing === undefined) {
      const typeName =
        store.state.linkTypes.find((t) => t.id === link.type_id)?.name_forward ?? 'связь';
      pairCounts.set(key, { typeName, count: 1 });
    } else {
      existing.count += 1;
    }
  }
  for (const [key, info] of pairCounts) {
    if (info.count >= 10) {
      const [, otherId] = key.split('|') as [string, string];
      const target = massMap.get(otherId) ?? { hidden: 0, label: info.typeName };
      target.hidden += info.count - 1; // одно ребро рисуем, остальные прячем
      target.label = info.typeName;
      massMap.set(otherId, target);
    }
  }

  if (neighbours.length === 0) {
    root.append(el('p', 'muted', 'У мысли нет прямых связей.'));
    return root;
  }

  root.append(
    buildMiniGraph({
      thought: ctx.thought,
      neighbours,
      links,
      mass: massMap,
    }),
  );
  return root;
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

/** Builds the parent «Упоминания» body: container with two child groups. */
function buildMentionsParentBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('mentions-parent-body');

  const childReload: { current: (() => void) | null } = { current: null };

  /** Loads both endpoints in parallel and reports the aggregate count. */
  async function refreshCounts(): Promise<void> {
    const [backlinks, mentions] = await Promise.all([
      etn.thoughts.backlinks(networkId, ctx.ownerId).catch(() => []),
      etn.thoughts.mentions(networkId, ctx.ownerId).catch(() => []),
    ]);
    const visibleBacklinks = backlinks.filter((h) => h.active || store.state.showInactive);
    const visibleMentions = mentions.filter((h) => h.active || store.state.showInactive);
    const total = visibleBacklinks.length + visibleMentions.length;
    box.closest('.group')?.dispatchEvent(
      new CustomEvent('etn:set-count', { detail: `(${total})` }),
    );
  }
  void refreshCounts();

  // Две дочерние группы — те же groupSection, что и везде.
  const backlinksSection = groupSection(
    {
      id: 'mentions:backlinks',
      title: 'Ссылки на мысль',
      lazyCount: true,
      defaultCollapsed: true,
      buildBody: () => buildBacklinksBody(ctx),
    },
  );
  const textMentionsSection = groupSection(
    {
      id: 'mentions:text',
      title: 'Упоминания в тексте',
      lazyCount: true,
      defaultCollapsed: true,
      buildBody: () => buildMentionsBody(ctx),
    },
  );
  childReload.current = () => {
    backlinksSection.replaceWith(
      groupSection(
        {
          id: 'mentions:backlinks',
          title: 'Ссылки на мысль',
          lazyCount: true,
          defaultCollapsed: false,
          buildBody: () => buildBacklinksBody(ctx),
        },
      ),
    );
  };
  box.append(backlinksSection, textMentionsSection);
  return box;
}

/** Builds the «Ссылки на мысль» body — explicit `[[#<id>]]` references. */
function buildBacklinksBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('mentions-body');
  void reload();

  async function reload(): Promise<void> {
    box.replaceChildren(el('span', 'muted', 'Поиск ссылок на мысль…'));
    let hits: MentionHit[];
    try {
      hits = await etn.thoughts.backlinks(networkId, ctx.ownerId);
    } catch (err) {
      box.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    const visible = hits.filter((hit) => hit.active || store.state.showInactive);
    box.replaceChildren();
    if (visible.length === 0) {
      box.append(el('p', 'muted', 'Никто не ссылается на эту мысль через [[#<id>]]. '));
      return;
    }
    // Тот же chip-паттерн, что и в buildMentionsBody — иконка/styling
    // подтягиваются батчем через thoughts.resolve.
    const thoughtIds = visible
      .filter((hit) => hit.owner_type === 'thought')
      .map((hit) => hit.owner_id);
    let refs: ThoughtRef[] = [];
    if (thoughtIds.length > 0) {
      try {
        refs = await etn.thoughts.resolve(networkId, thoughtIds.slice(0, RESOLVE_BATCH));
      } catch {
        refs = [];
      }
    }
    const refById = new Map(refs.map((r) => [r.id, r]));
    for (const hit of visible) {
      const item = div('mention-item');
      if (!hit.active) item.classList.add('dim');
      const ref = hit.owner_type === 'thought' ? refById.get(hit.owner_id) : undefined;
      const icon = el('span', 'mini-icon');
      if (ref !== undefined) {
        applyCloudStyle(item, resolveCloudStyle(ref));
        applyThoughtIcon(icon, { ...ref, id: hit.owner_id });
      } else {
        icon.textContent = hit.owner_type === 'thought' ? '💭' : '🔗';
      }
      const title = el('span', 'link-item-title', hit.title);
      const snippet = el('div', 'muted mention-snippet');
      // Сниппет несёт сырой `[[#<id>]]` — подставляем имена мыслей: синхронно
      // из кеша (id не мелькает на экране), затем дорезолвиваем батчем.
      renderHtml(snippet, paintWikiIdsInSnippet(hit.snippet, networkId));
      void resolveWikiIdsInSnippet(hit.snippet, networkId).then((resolved) => {
        if (snippet.isConnected) renderHtml(snippet, resolved);
      });
      item.append(icon, title, snippet);
      // Stage 3: the row has no per-indicator icons — Ctrl+hover shows the
      // owner's (thought or link) permanent comment.
      if (hit.owner_type === 'thought') markThoughtCommentPreview(item, hit.owner_id, hit.title);
      else markCommentPreview(item, 'link', hit.owner_id, hit.title);
      item.addEventListener('click', () => void open(hit));
      box.append(item);
    }
  }

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
    // Inactive mentioning thoughts/links follow the `show_inactive` setting.
    const visible = hits.filter((hit) => hit.active || store.state.showInactive);
    // `…` → the resolved count in the group header (08-ui-spec.md §6.7). The
    // fetch cannot resolve before the group machinery mounts this box (the
    // mount runs on a microtask queued before the response arrives), so
    // `closest` finds the header; after a collapse it is a harmless no-op.
    box.closest('.group')?.dispatchEvent(new CustomEvent('etn:set-count', { detail: `(${visible.length})` }));
    box.replaceChildren();
    if (visible.length === 0) {
      box.append(el('p', 'muted', 'Название нигде не упоминается.'));
      return;
    }
    // The mentions DTO (§13) carries only the owner/title/snippet/active; the
    // thought's icon and visual style (fg/bg/font_* + icon) come from a batched
    // `thoughts.resolve` so the row matches what the user sees elsewhere
    // (history-bar.ts / chronicle.ts «thoughtChip» — the canonical pattern).
    // Links have no per-link visual, so they fall back to the «🔗» glyph.
    const thoughtIds = visible
      .filter((hit) => hit.owner_type === 'thought')
      .map((hit) => hit.owner_id);
    let refs: ThoughtRef[] = [];
    if (thoughtIds.length > 0) {
      try {
        refs = await etn.thoughts.resolve(networkId, thoughtIds.slice(0, RESOLVE_BATCH));
      } catch {
        // Stale rows in the search index — fall back to the default icon.
        refs = [];
      }
    }
    const refById = new Map(refs.map((r) => [r.id, r]));
    // The group body (this box) is the scroll area — items flow directly.
    for (const hit of visible) {
      const item = div('mention-item');
      if (!hit.active) item.classList.add('dim');
      const ref = hit.owner_type === 'thought' ? refById.get(hit.owner_id) : undefined;
      // Same chip pattern as `chronicle.ts`/`history-bar.ts`: icon first, then
      // the styled title. For a deleted thought (ref missing) we still show
      // the hit's title with the default icon, so the row is never blank.
      const icon = el('span', 'mini-icon');
      if (ref !== undefined) {
        applyCloudStyle(item, resolveCloudStyle(ref));
        applyThoughtIcon(icon, { ...ref, id: hit.owner_id });
      } else {
        icon.textContent = hit.owner_type === 'thought' ? '💭' : '🔗';
      }
      const title = el('span', 'link-item-title', hit.title);
      const snippet = el('div', 'muted mention-snippet');
      // The snippet carries server-side <mark> highlights around matches —
      // like the search panel, render it as (escaped, trusted) HTML.
      renderHtml(snippet, hit.snippet);
      item.append(icon, title, snippet);
      // Stage 3: the row has no per-indicator icons — Ctrl+hover shows the
      // owner's (thought or link) permanent comment.
      if (hit.owner_type === 'thought') markThoughtCommentPreview(item, hit.owner_id, hit.title);
      else markCommentPreview(item, 'link', hit.owner_id, hit.title);
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

/** A labelled endpoint row (used in the link editor: source / target). */
function endpointRow(label: string, other: ThoughtRef, onOpen: () => void): HTMLElement {
  const row = div('link-group-item');
  row.append(span(label, 'muted link-item-label'));
  const icon = span('', 'mini-icon');
  applyThoughtIcon(icon, other);
  const title = el('span', 'link-item-title', other.title);
  if (!other.active) row.classList.add('dim');
  row.append(icon, title);
  // Stage 3: no per-indicator icons on an endpoint row — Ctrl+hover shows the
  // endpoint thought's permanent comment.
  markThoughtCommentPreview(row, other.id, other.title);
  row.addEventListener('click', () => onOpen());
  return row;
}
