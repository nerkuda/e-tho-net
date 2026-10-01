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

import type { MentionHit, PublicationUsageItem, ThoughtRef } from '@etn/shared';

import { requireNetworkId, setFocus } from '../app.js';
// Облачка мыслей во вкладке «Связи» (эндпоинты и строки упоминаний) собирает
// общая фабрика: значок, цвета, начертание, бледность и единые жесты.
import { createThoughtCloud } from '../lib/thought-cloud.js';
import { t } from '../lib/i18n.js';
import { showThoughtContextMenu } from '../canvas/context-menu.js';
import { div, el, renderHtml, span } from '../lib/dom.js';
import { operationError } from '../lib/ui/messages.js';
import { etn } from '../lib/etn.js';
import { markCommentPreview, markThoughtCommentPreview } from '../lib/hover-preview.js';
import { toggleSelection } from '../selection/selection.js';
import { store } from '../state.js';
import { openPublicationInWorkspace } from '../screens/active-view.js';
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

  // Три плоские группы на верхнем уровне вкладки — больше нет родительской
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
  // Группа «Публикации» (0.11.1, задача 3275fd8d, элемент интерфейса 928fb3fc):
  // ленивая загрузка с прелоадером, роли с хлебными крошками разделов.
  const publications = groupSection(
    {
      id: 'links.publications',
      title: t('publications.mentions.title'),
      lazyCount: true,
      defaultCollapsed: true,
      buildBody: () => buildPublicationsBody(ctx),
    },
  );
  // Раскладка групп (приёмка 0.8.1): сплиттеры и фиксированные высоты
  // действуют, только когда ВСЕ группы развёрнуты; каждая свёрнутая группа
  // схлопывается до заголовка, а единственная/частично развёрнутые
  // растягиваются на всю вкладку, сплиттеры над свёрнутыми инертны.
  const bodyOf = (group: HTMLElement): HTMLElement | null =>
    group.querySelector(':scope > .group-body') as HTMLElement | null;
  const groups = [backlinks, textMentions, publications];
  const groupKeys = ['links.backlinks', 'links.text-mentions', 'links.publications'];
  const relayout = (): void => {
    const all = groups.every((group) => bodyOf(group) !== null);
    groups.forEach((group, i) => applyTabGroupClamp(group, groupKeys[i]!, all));
  };
  for (const group of groups) group.addEventListener('etn:toggled', () => relayout());
  relayout();
  // persistKey «links.mentions» сохраняем — это та же высота, что была
  // между группами «Упоминания» и «Локальный граф» раньше, чтобы пользователь
  // не потерял настройку при миграции вкладки.
  root.append(
    backlinks,
    rowSplitter(() => bodyOf(backlinks), { min: 50, persistKey: 'links.mentions' }),
    textMentions,
    rowSplitter(() => bodyOf(textMentions), { min: 50, persistKey: 'links.publications' }),
    publications,
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
      root.replaceChildren(operationError(err));
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
 * the canvas focus (deferred so a double click cancels it), double click
 * focuses, Ctrl/Cmd+click toggles the shared selection, Ctrl+hover previews
 * the permanent comment, right-click opens the thought context menu, Enter
 * acts as a click. No indicator icons (📝/📅/📎) — the comment opens with
 * Ctrl+hover, like a pinned-thought chip.
 */
function buildThoughtCloud(ref: ThoughtRef): HTMLElement {
  const cloud = createThoughtCloud(ref, {
    profile: 'tree',
    // Ширина — по колонке вкладки: имя обрезается многоточием по ней, а не
    // по холстовым 200px (`--cloud-width`); ширину объявляет вызов фабрики,
    // а не контекстный селектор в стилях.
    width: 'container',
    actions: {
      onClick: (id) => openThoughtInEditor(id),
      onDoubleClick: (id) => void setFocus(id),
      onCtrlClick: (id) => toggleSelection([id]),
      onContextMenu: (event, id) => {
        event.stopPropagation();
        showThoughtContextMenu(event, { id, title: ref.title, dir: 'siblings' });
      },
    },
  });
  markThoughtCommentPreview(cloud, ref.id, ref.title);
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
      box.replaceChildren(operationError(err));
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
      // Same chip pattern as `chronicle.ts`/`history-bar.ts`: the thought's
      // icon, colours and font come from the shared cloud factory. For a
      // deleted thought (ref missing) we still show the hit's title with the
      // default icon, so the row is never blank. Links have no per-link
      // visual — the «🔗» glyph.
      const lead =
        hit.owner_type === 'thought'
          ? createThoughtCloud(
              ref !== undefined
                ? { ...ref, id: hit.owner_id, title: hit.title }
                : { id: hit.owner_id, title: hit.title },
              {
                profile: 'chip',
                // Ширина — по строке списка упоминаний.
                width: 'container',
                actions: { onClick: () => void open(hit) },
              },
            )
          : span('🔗');
      const snippet = el('div', 'muted mention-snippet');
      // Сниппет несёт сырой `[[#<id>]]` — подставляем имена мыслей: синхронно
      // из кеша (id не мелькает на экране), затем дорезолвиваем батчем.
      renderHtml(snippet, paintWikiIdsInSnippet(hit.snippet, networkId));
      void resolveWikiIdsInSnippet(hit.snippet, networkId).then((resolved) => {
        if (snippet.isConnected) renderHtml(snippet, resolved);
      });
      item.append(lead, snippet);
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
      box.replaceChildren(operationError(err));
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
      // Same chip pattern as `chronicle.ts`/`history-bar.ts`: the thought's
      // icon, colours and font come from the shared cloud factory. For a
      // deleted thought (ref missing) we still show the hit's title with the
      // default icon, so the row is never blank. Links have no per-link
      // visual — the «🔗» glyph.
      const lead =
        hit.owner_type === 'thought'
          ? createThoughtCloud(
              ref !== undefined
                ? { ...ref, id: hit.owner_id, title: hit.title }
                : { id: hit.owner_id, title: hit.title },
              {
                profile: 'chip',
                // Ширина — по строке списка упоминаний.
                width: 'container',
                actions: { onClick: () => void open(hit) },
              },
            )
          : span('🔗');
      const snippet = el('div', 'muted mention-snippet');
      // The snippet carries server-side <mark> highlights around matches —
      // like the search panel, render it as (escaped, trusted) HTML.
      renderHtml(snippet, hit.snippet);
      item.append(lead, snippet);
      // Stage 3: no per-indicator icons on an endpoint row — Ctrl+hover shows
      // the owner's (thought or link) permanent comment.
      if (hit.owner_type === 'thought') markThoughtCommentPreview(item, hit.owner_id, hit.title);
      else markCommentPreview(item, 'link', hit.owner_id, hit.title);
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

/**
 * Подпись роли мысли в публикации (элемент интерфейса 928fb3fc): раздел —
 * хлебные крошки имён родительских разделов, текст — название своего раздела,
 * прямая ссылка — имя свойства типа «Публикация».
 */
function publicationRoleLabel(item: PublicationUsageItem): string {
  switch (item.role) {
    case 'section':
      return t('publications.mentions.roleSection', (item.breadcrumbs ?? []).join(' → '));
    case 'text':
      return item.section_title !== undefined && item.section_title !== ''
        ? t('publications.mentions.roleText', item.section_title)
        : t('publications.mentions.roleText', '—');
    case 'direct':
    default:
      return t('publications.mentions.roleDirect', item.property ?? '—');
  }
}

/**
 * Builds the «Публикации» group body (0.11.1, задача 3275fd8d): ленивая
 * загрузка `GET /thoughts/{id}/publications` — список публикаций, в которые
 * входит мысль, с ролью (раздел/текст/прямое свойство). Клик по строке
 * открывает публикацию на странице и якоре, которые посчитал сервер
 * (`usage.page`/`usage.anchor`); у прямой ссылки раздела нет — верх документа.
 */
function buildPublicationsBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('mentions-body');
  void reload();

  async function reload(): Promise<void> {
    box.replaceChildren(el('span', 'muted', t('publications.mentions.loading')));
    let items: PublicationUsageItem[];
    let total: number;
    let hasMore: boolean;
    try {
      const result = await etn.publications.usage(networkId, ctx.ownerId);
      items = result.items;
      total = result.total;
      hasMore = result.has_more;
    } catch (err) {
      box.replaceChildren(operationError(err));
      return;
    }
    box
      .closest('.group')
      ?.dispatchEvent(new CustomEvent('etn:set-count', { detail: `(${total})` }));
    box.replaceChildren();
    if (items.length === 0) {
      box.append(el('p', 'muted', t('publications.mentions.empty')));
      return;
    }
    for (const item of items) {
      const row = div('mention-item');
      // Клик обрабатывает САМА строка (не облачко): один путь открытия,
      // без повторной загрузки сборки (клик по облачку всплывает сюда же).
      const cloud = createThoughtCloud(
        { id: item.publication_id, title: item.title, icon: '📄', icon_kind: 'emoji' },
        {
          profile: 'chip',
          width: 'container',
        },
      );
      const role = el('div', 'muted mention-snippet', publicationRoleLabel(item));
      row.append(cloud, role);
      row.addEventListener('click', () => void open(item));
      box.append(row);
    }
    if (hasMore) {
      box.append(
        el('p', 'muted', t('publications.mentions.more', [items.length, total])),
      );
    }
  }

  /** Открыть публикацию на посчитанной сервером странице и якоре вхождения. */
  async function open(item: PublicationUsageItem): Promise<void> {
    await openPublicationInWorkspace(item.publication_id, {
      ...(item.page !== undefined ? { page: item.page } : {}),
      ...(item.anchor !== undefined ? { anchor: item.anchor } : {}),
    });
  }

  return box;
}
