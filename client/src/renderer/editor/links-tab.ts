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

import type {
  BacklinkHit,
  MentionHit,
  PublicationUsageItem,
  RecordHit,
  ThoughtRef,
} from '@etn/shared';

import { focusFromUi, requireNetworkId } from '../app.js';
// Облачка мыслей во вкладке «Связи» (эндпоинты и строки упоминаний) собирает
// общая фабрика: значок, цвета, начертание, бледность и единые жесты.
import { createThoughtCloud, type ThoughtCloudActions } from '../lib/thought-cloud.js';
import { t } from '../lib/i18n.js';
import { showOutOfCanvasThoughtMenu } from '../canvas/context-menu.js';
import { div, el, isConnectionLostError, renderHtml, span } from '../lib/dom.js';
import { operationError } from '../lib/ui/messages.js';
import { etn } from '../lib/etn.js';
import { markCommentPreview, markThoughtCommentPreview } from '../lib/hover-preview.js';
import { cachedHomeId, getHomeId } from '../lib/home.js';
import { openRecordTarget, type RecordOpenActions } from '../lib/record-open.js';
import { mountRecordRowsBlock, type RecordRowsBlock } from '../lib/record-rows-block.js';
import { toggleSelection } from '../selection/selection.js';
import { isMapViewActive, onReconnected, store } from '../state.js';
import { openPublicationInWorkspace } from '../screens/active-view.js';
import {
  openLinkInEditor,
  openRecordInEditor,
  openThoughtInEditor,
  registerTabContent,
  type EditorContext,
  type TabPaneLifecycle,
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
function buildLinksTab(ctx: EditorContext, lifecycle: TabPaneLifecycle): HTMLElement {
  if (ctx.ownerType === 'link' && ctx.link !== null) {
    return buildLinkThoughtsTab(ctx, lifecycle);
  }

  const root = div('links-tab');

  // Три плоские группы на верхнем уровне вкладки — больше нет родительской
  // группы-обёртки и нет отдельной группы «Локальный граф» (мини-граф
  // переехал на собственную вкладку «Граф»).
  const backlinks = groupSection({
    id: 'links.backlinks',
    title: t('linksTab.title.linkRefThought'),
    lazyCount: true,
    defaultCollapsed: true,
    buildBody: () => buildBacklinksBody(ctx, lifecycle),
  });
  const textMentions = groupSection({
    id: 'links.text-mentions',
    title: t('linksTab.title.mentionsTekstah'),
    lazyCount: true,
    defaultCollapsed: true,
    buildBody: () => buildMentionsBody(ctx, lifecycle),
  });
  // Группа «Публикации» (0.11.1, задача 3275fd8d, элемент интерфейса 928fb3fc):
  // ленивая загрузка с прелоадером, роли с хлебными крошками разделов.
  const publications = groupSection({
    id: 'links.publications',
    title: t('publications.mentions.title'),
    lazyCount: true,
    defaultCollapsed: true,
    buildBody: () => buildPublicationsBody(ctx, lifecycle),
  });
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
function buildLinkThoughtsTab(ctx: EditorContext, lifecycle: TabPaneLifecycle): HTMLElement {
  const networkId = requireNetworkId();
  const root = div('link-thoughts-tab');
  if (ctx.link === null) return root;
  const link = ctx.link;
  /** Retry watch armed while a connection-lost error is on screen (de34b35b). */
  let retryStop: (() => void) | null = null;
  let disposed = false;
  lifecycle.onDispose(() => {
    disposed = true;
    retryStop?.();
    retryStop = null;
  });
  void reload();

  async function reload(): Promise<void> {
    root.replaceChildren(el('span', 'muted', t('common.loading')));
    let refs: ThoughtRef[];
    try {
      refs = await etn.thoughts.resolve(networkId, [link.source_id, link.target_id]);
    } catch (err) {
      if (disposed) return;
      root.replaceChildren(operationError(err));
      if (isConnectionLostError(err)) {
        retryStop?.();
        retryStop = onReconnected(networkId, () => void reload());
      }
      return;
    }
    retryStop?.();
    retryStop = null;
    if (disposed) return;
    const byId = new Map(refs.map((r) => [r.id, r]));
    const source = byId.get(link.source_id);
    const target = byId.get(link.target_id);
    if (source === undefined && target === undefined) {
      root.replaceChildren(el('p', 'muted', t('linksTab.koncyLinkNotFoundPossibleThought')));
      return;
    }
    root.replaceChildren();
    if (source !== undefined) root.append(endpointBlock(t('linksTab.istochnik'), source));
    if (target !== undefined) root.append(endpointBlock(t('linksTab.naznachenie'), target));
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
      onDoubleClick: (id) => focusFromUi(id),
      onCtrlClick: (id) => toggleSelection([id]),
      onContextMenu: (event, id) => {
        event.stopPropagation();
        void showOutOfCanvasThoughtMenu({ event }, { id, title: ref.title, dir: 'siblings' });
      },
    },
  });
  markThoughtCommentPreview(cloud, ref.id, ref.title);
  cloud.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openThoughtInEditor(ref.id);
  });
  return cloud;
}

/**
 * Действия чипа-мысли в списках упоминаний: клик — открыть упоминающую мысль,
 * правый клик — ОБЩЕЕ меню мысли (тот же фасад, что у эндпоинтов вкладки и
 * холста). Своего списка команд нет — правило «меню одинаково везде»
 * (ошибка f072db61); без обработчика фабрика оставляла ПКМ мёртвым
 * (ошибка ffc173c9).
 */
function mentionCloudActions(open: () => void, title: string): ThoughtCloudActions {
  return {
    onClick: open,
    onContextMenu: (event, id) => {
      event.stopPropagation();
      void showOutOfCanvasThoughtMenu({ event }, { id, title, dir: 'siblings' });
    },
  };
}

/** Запрос группы списка «Упоминаний»: union владельческих строк и строк-записей. */
type HitListLoader = (networkId: string) => Promise<BacklinkHit[]>;

/** Параметры тела группы-списка «Упоминаний». */
interface HitListBodyOptions {
  /** Запрос группы: backlinks либо text-mentions. */
  load: HitListLoader;
  /** Подпись «идёт запрос». */
  loading: string;
  /** Подпись пустой группы. */
  empty: string;
}

/**
 * Тело группы списка «Упоминаний» — ОДНА сборка для «Ссылок на мысль» и
 * «Упоминаний в текстах» (0.15.4, задача ae72e47e, требования 012b2dc6 и
 * ce121e09). Группу различает только запрос и подписи, поэтому правила вкладки
 * («что видно», счётчик, подблок записей, клик) не разъезжаются между копиями.
 *
 * Состав тела: владельческие строки постоянных комментариев (прежнее поведение)
 * и ПОДБЛОКОМ после них — строки-записи дневниковых (общая компонента
 * `lib/record-rows-block.ts` над `lib/record-row.ts`, элемент 554e3129).
 * Порядок строк-записей — серверный (`valid_from` по убыванию), без
 * пересортировки; владельческая строка порождается только постоянным
 * комментарием, дублирования владельца нет.
 *
 * Счётчик группы (`etn:set-count`) публикует ОБЕ группы: все найденные строки
 * обоих видов с учётом `show_inactive` — прежний дефект «у «Ссылок на мысль»
 * счётчика нет» (уточнение N8) закрыт здесь же.
 */
function buildHitListBody(
  ctx: EditorContext,
  lifecycle: TabPaneLifecycle,
  options: HitListBodyOptions,
): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('mentions-body');
  let retryStop: (() => void) | null = null;
  let disposed = false;
  /** Смонтированный подблок строк-записей: его обвязка живёт ровно с ним. */
  let recordRows: RecordRowsBlock | null = null;

  /** Снять подблок: перерисовка группы не оставляет наблюдателей на строках. */
  function dropRecordRows(): void {
    recordRows?.destroy();
    recordRows = null;
  }

  lifecycle.onDispose(() => {
    disposed = true;
    retryStop?.();
    retryStop = null;
    dropRecordRows();
  });
  void reload();

  async function reload(): Promise<void> {
    dropRecordRows();
    box.replaceChildren(el('span', 'muted', options.loading));
    let hits: BacklinkHit[];
    try {
      hits = await options.load(networkId);
    } catch (err) {
      if (disposed) return;
      box.replaceChildren(operationError(err));
      if (isConnectionLostError(err)) {
        retryStop?.();
        retryStop = onReconnected(networkId, () => void reload());
      }
      return;
    }
    retryStop?.();
    retryStop = null;
    if (disposed) return;
    // Union ответа (ADR db88d819): владельческие строки постоянных комментариев
    // и строки-записи дневниковых. Записи упорядочил сервер.
    const mentions = hits.filter((hit): hit is MentionHit => hit.kind !== 'record');
    const recordHits = hits.filter((hit): hit is RecordHit => hit.kind === 'record');
    // Inactive mentioning thoughts/links follow the `show_inactive` setting;
    // строки-записи — по актуальности ПЕРВИЧНОЙ привязки из `targets`
    // (fallback «привязка не найдена → строка видна», уточнение итерации 8).
    const visible = mentions.filter((hit) => hit.active || store.state.showInactive);
    const mounted =
      recordHits.length > 0
        ? mountRecordRowsBlock({
            networkId,
            hits: recordHits,
            homeId: await homeIdForRows(networkId),
            showInactive: store.state.showInactive,
            showTrash: store.state.showTrash,
            onOpen: (target, model) => {
              void openRecordTarget(target, model.commentId, recordOpenActions(networkId));
            },
          })
        : null;
    if (disposed) {
      mounted?.destroy();
      return;
    }
    recordRows = mounted;
    // `…` → the resolved count in the group header (08-ui-spec.md §6.7): all
    // found rows of BOTH kinds under `show_inactive` (DoD задачи ae72e47e).
    const found = visible.length + (mounted?.visibleCount ?? 0);
    box
      .closest('.group')
      ?.dispatchEvent(new CustomEvent('etn:set-count', { detail: `(${found})` }));
    box.replaceChildren();
    if (found === 0) {
      box.append(el('p', 'muted', options.empty));
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
                actions: mentionCloudActions(() => void open(hit), hit.title),
              },
            )
          : span('🔗');
      const snippet = el('div', 'muted mention-snippet');
      // Сниппет несёт сырой `[[#<id>]]` — подставляем имена мыслей: синхронно
      // из кеша (id не мелькает на экране), затем дорезолвиваем батчем — тем
      // же конвейером, что у прочих строк результатов (ошибка 2a8181f4).
      renderHtml(snippet, paintWikiIdsInSnippet(hit.snippet, networkId));
      void resolveWikiIdsInSnippet(hit.snippet, networkId).then((resolved) => {
        if (snippet.isConnected) renderHtml(snippet, resolved);
      });
      item.append(lead, snippet);
      // Stage 3: no per-indicator icons on an endpoint row — Ctrl+hover shows
      // the owner's (thought or link) permanent comment.
      if (hit.owner_type === 'thought') markThoughtCommentPreview(item, hit.owner_id, hit.title);
      else markCommentPreview(item, 'link', hit.owner_id, hit.title);
      box.append(item);
    }
    // Строки-записи — ПОДБЛОКОМ после владельческих строк (требование 012b2dc6).
    if (mounted !== null && mounted.visibleCount > 0) box.append(mounted.el);
  }

  /** Opens the mentioning entity (thought → focus, link → editor). */
  async function open(hit: MentionHit): Promise<void> {
    if (hit.owner_type === 'thought') {
      focusFromUi(hit.owner_id);
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
 * Действия открытия цели строки-записи для вкладки — тот же вход редактора, что
 * у поиска (`lib/record-open.ts`, требование ce121e09): запись открывается на
 * своей привязке, владелец-связь — редактор связи без записи. Фокус холста
 * переводится только с активного вида «Карта мыслей»: со вкладки редактора клик
 * по записи его не двигает (ревизия 2026-11-11, задача 7c380088).
 * Отказ открытия связи на вкладке тихий: прежние строки вкладки тоже молчали, а
 * stale-цель — не событие (сценарий 20d5a3cf).
 */
function recordOpenActions(networkId: string): RecordOpenActions {
  return {
    networkId,
    getLink: (netId, linkId) => etn.links.get(netId, linkId),
    openLinkInEditor,
    openRecordInEditor,
    // Фокус — только с активного вида «Карта мыслей» (ревизия 2026-11-11,
    // требование ce121e09 v5): со вкладки редактора клик по записи фокус не
    // двигает.
    isMapActive: isMapViewActive,
    focusFromUi,
  };
}

/**
 * HOME сети для чипов строк-записей (требование c81964c7): служебная привязка не
 * показывается. Сбой разрешения группу не рушит — берём уже разрешённый HOME,
 * иначе фильтр HOME отключается (строки и чипы остаются видны).
 */
async function homeIdForRows(networkId: string): Promise<string | null> {
  try {
    return await getHomeId(networkId);
  } catch {
    return cachedHomeId(networkId);
  }
}

/**
 * Builds the «Ссылки на мысль» body — explicit `[[#<id>]]` references плюс
 * строки-записи дневниковых, сославшихся на мысль явной ссылкой.
 */
function buildBacklinksBody(ctx: EditorContext, lifecycle: TabPaneLifecycle): HTMLElement {
  return buildHitListBody(ctx, lifecycle, {
    load: (networkId) => etn.thoughts.backlinks(networkId, ctx.ownerId),
    loading: t('linksTab.searchSsylokThought'),
    empty: t('linksTab.niktoNotSsylaetsyaEtuThoughtVia'),
  });
}

/**
 * Builds the «Упоминания в текстах» body — поиск по имени/синонимам плюс
 * строки-записи дневниковых, упомянувших мысль в теле (счётчик — группа).
 */
function buildMentionsBody(ctx: EditorContext, lifecycle: TabPaneLifecycle): HTMLElement {
  return buildHitListBody(ctx, lifecycle, {
    load: (networkId) => etn.thoughts.mentions(networkId, ctx.ownerId),
    loading: t('linksTab.searchUpominaniy'),
    empty: t('linksTab.titleNigdeNotUpominaetsya'),
  });
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
function buildPublicationsBody(ctx: EditorContext, lifecycle: TabPaneLifecycle): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('mentions-body');
  let retryStop: (() => void) | null = null;
  let disposed = false;
  lifecycle.onDispose(() => {
    disposed = true;
    retryStop?.();
    retryStop = null;
  });
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
      if (disposed) return;
      box.replaceChildren(operationError(err));
      if (isConnectionLostError(err)) {
        retryStop?.();
        retryStop = onReconnected(networkId, () => void reload());
      }
      return;
    }
    retryStop?.();
    retryStop = null;
    if (disposed) return;
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
      box.append(el('p', 'muted', t('publications.mentions.more', [items.length, total])));
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
