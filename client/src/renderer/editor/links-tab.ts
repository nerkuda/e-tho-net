/**
 * Editor tab «Упоминания» (задача 8ab775d9, единая модель связей;
 * 08-ui-spec.md §6.7). Для мысли — две плоские сворачиваемые группы,
 * разделённые сплиттером высоты:
 *  - «Ссылки на мысль» (явные `[[#<id>]]` в body_md);
 *  - «Упоминания в тексте» (FTS5 по title/synonyms).
 * Строки открывают упоминающую мысль (focus) или связь (link editor);
 * активная вкладка не меняется. Сплиттер и фиксированные высоты действуют
 * только когда ОБЕ группы развёрнуты — свёрнутая схлопывается до заголовка,
 * единственная развёрнутая растягивается на всю вкладку.
 *
 * Прямые типизированные связи и структурные «Родители»/«Потомки» живут
 * на вкладке «Свойства» как свойства-связи (счётчики + чипы). Мини-граф
 * переехал на отдельную вкладку «Граф».
 *
 * For a link the tab is «Мысли» (задача 95775cfd): два блока — «Источник»
 * (`link.source_id`) и «Назначение» (`link.target_id`), в каждом подпись-роль
 * и под ней облачко мысли, ведущее себя как облачко мысли в любом другом
 * месте клиента (клик/двойной клик/Ctrl+клик/Ctrl+наведение/правая кнопка/
 * Enter). Счётчиков-иконок 📝/📅/📎 у этих облачков нет.
 */

import type { MentionHit, ThoughtRef } from '@etn/shared';

import { requireNetworkId, setFocus } from '../app.js';
import { applyCloudStyle, applyThoughtIcon, deferSingleClick, resolveCloudStyle } from '../canvas/canvas.js';
import { showThoughtContextMenu } from '../canvas/context-menu.js';
import { div, el, errText, renderHtml, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { markCommentPreview, markThoughtCommentPreview } from '../lib/hover-preview.js';
import { toggleSelection } from '../selection/selection.js';
import { store } from '../state.js';
import {
  openLinkInEditor,
  openThoughtInEditor,
  registerTabContent,
  type EditorContext,
} from './editor.js';
import { groupSection } from './group.js';
import { applyTabGroupClamp } from './list-heights.js';
import { paintWikiIdsInSnippet, resolveWikiIdsInSnippet } from './wiki-link-resolver.js';
import { rowSplitter } from './splitter.js';

/** Cap on the batched resolve call — server-side limit of `thoughts.resolve`. */
const RESOLVE_BATCH = 100;

/** Registers the «Упоминания» tab content (thoughts and links). */
export function registerLinksTab(): void {
  registerTabContent('links', buildLinksTab);
}

/** Builds the whole tab pane content for the entity. */
function buildLinksTab(ctx: EditorContext): HTMLElement {
  if (ctx.ownerType === 'link' && ctx.link !== null) {
    return buildLinkThoughtsTab(ctx);
  }

  const root = div('links-tab');

  // Две плоские группы на верхнем уровне вкладки — больше нет родительской
  // группы-обёртки и нет отдельной группы «Локальный граф» (мини-граф
  // переехал на собственную вкладку «Граф»).
  const backlinks = groupSection(
    {
      id: 'links.backlinks',
      title: 'Ссылки на мысль',
      lazyCount: true,
      defaultCollapsed: true,
      buildBody: () => buildBacklinksBody(ctx),
    },
  );
  const textMentions = groupSection(
    {
      id: 'links.text-mentions',
      title: 'Упоминания в текстах',
      lazyCount: true,
      defaultCollapsed: true,
      buildBody: () => buildMentionsBody(ctx),
    },
  );
  // Раскладка пары (приёмка 0.8.1): сплиттер и фиксированные высоты действуют
  // только когда ОБЕ группы развёрнуты; свёрнутая группа схлопывается до
  // заголовка, единственная развёрнутая растягивается на всю вкладку,
  // сплиттер над свёрнутой группой инертен (тела нет — resizable → null).
  const bodyOf = (group: HTMLElement): HTMLElement | null =>
    group.querySelector(':scope > .group-body') as HTMLElement | null;
  const relayout = (): void => {
    const both = bodyOf(backlinks) !== null && bodyOf(textMentions) !== null;
    applyTabGroupClamp(backlinks, 'links.backlinks', both);
    applyTabGroupClamp(textMentions, 'links.text-mentions', both);
  };
  backlinks.addEventListener('etn:toggled', () => relayout());
  textMentions.addEventListener('etn:toggled', () => relayout());
  relayout();
  // persistKey «links.mentions» сохраняем — это та же высота, что была
  // между группами «Упоминания» и «Локальный граф» раньше, чтобы пользователь
  // не потерял настройку при миграции вкладки.
  root.append(
    backlinks,
    rowSplitter(() => bodyOf(backlinks), { min: 50, persistKey: 'links.mentions' }),
    textMentions,
  );
  return root;
}

/**
 * Builds the «Мысли» tab of a link (задача 95775cfd): the two thoughts the
 * edited link connects, as full thought clouds — «Источник» (`source_id`) and
 * «Назначение» (`target_id`). Both cards come from one `thoughts.resolve`
 * batch; an endpoint that fails to resolve gets no block at all.
 */
function buildLinkThoughtsTab(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const root = div('link-thoughts-tab');
  if (ctx.link === null) return root;
  const link = ctx.link;
  void reload();

  async function reload(): Promise<void> {
    root.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let refs: ThoughtRef[];
    try {
      refs = await etn.thoughts.resolve(networkId, [link.source_id, link.target_id]);
    } catch (err) {
      root.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    const byId = new Map(refs.map((r) => [r.id, r]));
    const source = byId.get(link.source_id);
    const target = byId.get(link.target_id);
    if (source === undefined && target === undefined) {
      root.replaceChildren(
        el('p', 'muted', 'Концы связи не найдены — возможно, мысли удалены.'),
      );
      return;
    }
    root.replaceChildren();
    if (source !== undefined) root.append(endpointBlock('Источник', source));
    if (target !== undefined) root.append(endpointBlock('Назначение', target));
  }

  return root;
}

/** One endpoint block of the link «Мысли» tab: role caption + thought cloud. */
function endpointBlock(label: string, ref: ThoughtRef): HTMLElement {
  const block = div('link-endpoint');
  block.append(el('div', 'link-endpoint-label', label), buildThoughtCloud(ref));
  return block;
}

/**
 * A thought cloud in the link «Мысли» tab — the same representation and
 * behaviour as a thought cloud anywhere else in the client (canvas,
 * structures): single click opens the thought in the editor without moving
 * the canvas focus (deferred via {@link deferSingleClick} so a double click
 * cancels it), double click focuses, Ctrl/Cmd+click toggles the shared
 * selection, Ctrl+hover previews the permanent comment, right-click opens the
 * thought context menu, Enter acts as a click. No indicator icons (📝/📅/📎) —
 * the comment opens with Ctrl+hover, like a pinned-thought chip.
 */
function buildThoughtCloud(ref: ThoughtRef): HTMLElement {
  const cloud = div('cloud');
  cloud.dataset['id'] = ref.id;
  cloud.tabIndex = 0;
  applyCloudStyle(cloud, resolveCloudStyle(ref));
  if (!ref.active) cloud.classList.add('dim');

  const iconBox = div('cloud-icon');
  applyThoughtIcon(iconBox, ref);
  const title = div('cloud-title');
  title.textContent = ref.title;
  setTooltip(title, ref.title);
  const main = div('cloud-main');
  main.append(title);

  cloud.append(iconBox, main);
  markThoughtCommentPreview(cloud, ref.id, ref.title);

  let pendingClick: { cancel: () => void } | null = null;
  cloud.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey) {
      pendingClick?.cancel();
      pendingClick = null;
      toggleSelection([ref.id]);
      return;
    }
    pendingClick?.cancel();
    pendingClick = deferSingleClick(() => {
      pendingClick = null;
      openThoughtInEditor(ref.id);
    });
  });
  cloud.addEventListener('dblclick', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    pendingClick?.cancel();
    pendingClick = null;
    void setFocus(ref.id);
  });
  cloud.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showThoughtContextMenu(event, { id: ref.id, title: ref.title, dir: 'siblings' });
  });
  cloud.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openThoughtInEditor(ref.id);
  });
  return cloud;
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
      // Stage 3: no per-indicator icons on an endpoint row — Ctrl+hover shows
      // the owner's (thought or link) permanent comment.
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
