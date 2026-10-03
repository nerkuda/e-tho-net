/**
 * Рабочая область открытой публикации (0.11.1, задача 4f03b9d5; элемент
 * интерфейса 2ebacd12).
 *
 * Состояние экрана «Публикации» при открытой публикации: прилипающая шапка
 * (обложка/название/автор + Настройки/Пересобрать/Экспорт/Назад), сворачиваемое
 * оглавление (подсветка текущего раздела, пометки исключён/повтор/кольцо, тексты
 * подсписком, drag&drop порядка корневых разделов, контекстное меню) и документ
 * (титул, разделы, тексты, «доп. материалы») с пагинацией и прелоадером.
 *
 * **Рендер документа — серверный.** Текст блоков приходит готовым HTML из
 * `GET /publications/{id}/assembly` (единый серверный markdown-рендерер);
 * клиент НЕ рендерит markdown сам и лишь вставляет доверенный HTML через
 * `renderHtml` (тот же приём, что у серверных сниппетов). Исключение — РЕЗЮМЕ
 * титульного блока: при точечной правке оно рендерится тем же общим
 * `@etn/markdown` из свежего `summary_md` (замечание А2 приёмки b02ef1cf), иначе
 * сборка перечитывалась бы на каждую правку резюме. Правка контента — не
 * инлайн: выделение блока открывает мысль в карточке панели редактора
 * (`openThoughtInEditor`), а живое обновление документа идёт по realtime.
 *
 * Списки (оглавление, документ, состояния) обновляются инкрементально
 * (`reconcileKeyed` — стандарт «Списки рендерятся инкрементально»); разметка —
 * фасады `lib/ui` и `lib/dialog`, строки — из словаря `t()`.
 */

import type {
  LinkPropertyValues,
  Publication,
  PublicationAssembly,
  PublicationCandidatesResult,
  PublicationOrderItem,
} from '@etn/shared';
import { PUBLICATION_EMPTY_RECIPE_WARNING } from '@etn/shared';

import {
  el,
  div,
  span,
  renderHtml,
  setTooltip,
} from '../../lib/dom.js';
import { t } from '../../lib/i18n.js';
import { etn } from '../../lib/etn.js';
import { svgIcon, type IconName } from '../../lib/icons.js';
import { errorDialog, isInsideDialog, showDialog } from '../../lib/dialog.js';
import { notice } from '../../lib/notice.js';
import {
  MENU_SEPARATOR,
  menuAction,
  menuSubmenu,
  showMenuAt,
  type MenuItem,
} from '../../lib/menu.js';
import { buildThoughtMenuItems } from '../../canvas/context-menu.js';
import { uiButton, iconButton } from '../../lib/ui/button.js';
import { uiSlider } from '../../lib/ui/slider.js';
import { createTree, type TreeItem } from '../../lib/ui/tree.js';
import { emptyState, errorState, loadingState } from '../../lib/ui/empty-state.js';
import { reconcileKeyed } from '../../lib/ui/keyed-list.js';
import { preserveScroll } from '../../lib/ui/scroll-anchor.js';
import { createListNav, type ListNavAdapter } from '../../lib/ui/list.js';
import { isEditingTarget } from '../../lib/ui/nav-core.js';
import {
  createDragList,
  dragHandle,
  DRAG_HANDLE_CLASS,
  type DragListAdapter,
  type DragListItem,
} from '../../lib/ui/drag-list.js';
import { buildCover } from './cover.js';
import {
  applyPublicationOrder,
  assemblyDateLabel,
  blockSignature,
  collapsibleSectionIds,
  displayAuthorship,
  documentBlocks,
  flattenSections,
  linkEntryMatchesPick,
  positionsFor,
  subtreeIds,
  TEXT_WIDTH_MAX,
  TEXT_WIDTH_MIN,
  tocLines,
  tocSignature,
  type DocBlock,
  type TocLine,
} from './model.js';
import { loadPropertyRows } from './recipe.js';
import { buildPropertyListRows } from '../../lib/property-list.js';
import { ensureLink, setOnlyParents, throwOnFailures } from '../../lib/link-ops.js';
import { parseFilterDefinition } from '../../lib/filter-builder.js';
import {
  commitEntity,
  getEntity,
  invalidateAfterMutation,
  onQueryInvalidated,
  queryKeys,
  registerQuery,
  runOptimistic,
  signalPublicationOrderChanged,
  type LocalMutationSignal,
} from '../../lib/live/index.js';
import { routePublicationUpdate } from './update-routing.js';
import { renderMarkdown } from '@etn/markdown';
import * as users from '../../lib/users.js';
import { store } from '../../state.js';

/** Внешние точки входа рабочей области (связь с экраном «Публикации»). */
export interface PublicationWorkspaceOptions {
  /** Закрыть рабочую область и вернуться в библиотеку. */
  onClose: () => void;
  /** Открыть карточку публикации в панели редактора (клик/Enter по заголовку). */
  onOpenCard: (publicationId: string) => void;
  /** Экспортировать документ (меню формата → джоба) — механика библиотеки. */
  onExport: (publicationId: string, ev: MouseEvent) => void;
  /** Текущая ширина колонки текста документа (%, 50–100) — персональная настройка. */
  getTextWidth: () => number;
  /** Живое изменение ширины ползунком (без записи в настройки). */
  onTextWidthInput: (value: number) => void;
  /** Завершённое изменение ширины — сохранить в персональных настройках. */
  onTextWidthChange: (value: number) => void;
}

/** Публичный дескриптор рабочей области. */
export interface PublicationWorkspaceHandle {
  /**
   * Открыть публикацию (перечитывает карточку и сборку). `target.page` —
   * сразу на нужной странице корневых разделов, `target.anchor` — прокрутка
   * к блоку (`domId` первого вхождения; 0.11.1, задача 3275fd8d).
   */
  open(publicationId: string, target?: PublicationOpenTarget): Promise<void>;
  /** Скрыть рабочую область, не разбирая узел (возврат в библиотеку). */
  close(): void;
  /** Перечитать сборку и карточку (realtime/локальные правки). */
  reload(): void;
  /**
   * Realtime-изменение комментария мысли в документе (`comment.*`): если мысль
   * ЕСТЬ в текущей сборке — обновить её блок. Пока живой текст устарел
   * (`staleRebuild`), точечная правка берётся из `bodyMd` события, без чтения
   * сборки (иначе материализуется отложенный рецепт, замечание-блокер 1 приёмки
   * b02ef1cf). Патчим ТОЛЬКО постоянный комментарий (`kind === 'permanent'`):
   * хроно-запись блока не образует и текст блока подменить не должна (блокер
   * приёмки b02ef1cf). `bodyMd` не задан (удаление) или kind не `permanent` —
   * блок не трогаем. Мысль вне документа — ничего.
   */
  applyCommentRealtime(ownerId?: string, bodyMd?: unknown, kind?: string): void;
  /**
   * Realtime-изменение мысли (`thought.updated`): если мысль ЕСТЬ в текущей
   * сборке — точечно обновить её блок и пометить текст устаревшим (заголовок
   * влияет на отбор по ключевым словам). Пока текст уже устарел, заголовок
   * правится из `changes.title` без чтения сборки (замечание-блокер 1 приёмки
   * b02ef1cf). Мысль вне документа — ничего (новые кандидаты показывает плашка
   * «+N новых», замечание 2 приёмки b02ef1cf).
   */
  applyThoughtRealtime(thoughtId: string, changes?: { title?: unknown }): void;
  /**
   * Точечно применить внешнюю правку полей публикации (`publication.updated` с
   * контентными полями): заголовок/подзаголовок/обложка/резюме — без чтения
   * сборки (замечание 1 приёмки b02ef1cf). Поля рецепта здесь не применяются —
   * их обрабатывает `markRebuildStale`.
   */
  applyPublicationPatch(changes: Partial<Publication>): void;
  /**
   * Пометить живой текст устаревшим (изменение состава/рецепта): кнопка
   * «Пересобрать» подсвечивается до пересборки (замечание А2 приёмки b02ef1cf).
   */
  markRebuildStale(): void;
  /**
   * Внешняя пересборка (`publication.rebuilt`, в т.ч. от другого клиента):
   * живой текст снова актуален — подсветка «Пересобрать» гаснет, документ
   * перечитывается по новой сборке (ошибка 29fd0587).
   */
  applyRebuildRealtime(): void;
  /**
   * Применить свежий снимок публикации БЕЗ перечитывания сборки: обновляет
   * шапку и титульный блок (локальная правка титула/подзаголовка/обложки/резюме,
   * замечания А и А2 приёмки b02ef1cf). Смена рецепта помечает текст устаревшим.
   */
  applyPublication(publication: Publication): void;
  /** Открыта ли рабочая область (опционально — именно эта публикация). */
  isOpen(publicationId?: string): boolean;
  /** Разобрать узел и снять слушатели. */
  destroy(): void;
}

/** Куда открыть публикацию в рабочей области (0.11.1, задача 3275fd8d). */
export interface PublicationOpenTarget {
  /** Номер страницы корневых разделов (1-based). */
  page?: number;
  /** Якорь блока (`pub-<shortid>`): прокрутка к первому вхождению. */
  anchor?: string;
}

/** Сущность клавиатурной навигации тела документа (задача b51dbca4). */
interface DocNavEntry {
  /** Ключ блока (`data-block-key`) — стабилен между перерисовками. */
  key: string;
  /** Мысль блока: активация открывает её в панели редактора. */
  thoughtId: string;
  kind: 'section' | 'text';
  /** Раздел сворачиваем — ←/→ переключают его состояние. */
  collapsible: boolean;
}

/** Узел дерева разделов публикации (диалог «Переместить в раздел…»). */
interface SectionTreeItem extends TreeItem {
  /** Заголовок раздела — подпись строки дерева. */
  title: string;
}

/**
 * Модель выбора страницы при открытии (чистая — юнит-тест): ЛЮБОЙ явно
 * заданный `target.page` побеждает (в т.ч. `1` — переход к вхождению на
 * первой странице при открытой N-й); иначе та же публикация сохраняет текущую
 * страницу (переоткрытие не сбрасывает листание), другая — открывается с
 * первой.
 */
export function resolveOpenPage(
  currentPage: number,
  samePublication: boolean,
  target?: PublicationOpenTarget,
): number {
  if (target?.page !== undefined) return Math.max(1, Math.trunc(target.page));
  return samePublication ? currentPage : 1;
}

// ---------------------------------------------------------------------------
// Фабрика рабочей области
// ---------------------------------------------------------------------------

/**
 * Монтирует рабочую область в `host` и возвращает дескриптор. Состояние живёт
 * в замыкании — при размонтировании экрана уходит вместе с ним.
 */
export function mountPublicationWorkspace(
  host: HTMLElement,
  opts: PublicationWorkspaceOptions,
): PublicationWorkspaceHandle {
  let publicationId: string | null = null;
  let publication: Publication | null = null;
  let assembly: PublicationAssembly | null = null;
  let page = 1;
  let loading = false;
  let loadError: unknown = null;
  let candidates: PublicationCandidatesResult | null = null;
  let candidatesOpen = false;
  const collapsed = new Set<string>();
  const tocCollapsed = { value: false };
  let currentAnchor: string | null = null;
  let reloadTimer: number | null = null;
  /** Строки оглавления последнего рендера — вход ключевой навигации и drag. */
  let tocLineItems: TocLine[] = [];
  /**
   * Живой текст документа устарел: изменился состав/рецепт, но пересборки не
   * было (решение пользователя «Остаётся + подсветка», замечание А2 приёмки
   * b02ef1cf). Снимается пересборкой; ставится по фактам realtime-событий —
   * без запроса сборки.
   */
  let staleRebuild = false;
  /**
   * Следующий полный рендер документа — принудительный, без опоры на подписи
   * блоков. Ставится при выходе из stale (пересборка, в т.ч. внешняя): прямая
   * правка DOM под stale могла разойтись с моделью, и документ обязан прийти
   * ровно к серверной сборке (блокер приёмки b02ef1cf).
   */
  let forceDocumentRender = false;

  const root = div('pub-ws hidden');
  const header = div('pub-ws-header');
  const toc = div('pub-toc');
  const content = div('pub-ws-content');
  const candHost = div('pub-cand');
  // Класс `comment-view` — та же типографика markdown-просмотра, что у
  // комментария мысли (пункт 6 карточки ea1b5f14): отступы заголовков и блоков
  // едины. Документ даёт свои правила поверх (ширина колонки, отступы блоков).
  const docHost = div('pub-doc comment-view');
  const pagerHost = div('pub-ws-pager');
  const stateHost = div('pub-ws-state');
  content.append(candHost, docHost, pagerHost, stateHost);
  const body = div('pub-ws-body');
  body.append(toc, content);
  root.append(header, body);
  host.append(root);

  // --- Шапка ---------------------------------------------------------------

  const backButton = iconButton({
    icon: svgIcon('arrow-left'),
    title: t('publications.ws.back'),
    role: 'ghost',
    onClick: () => opts.onClose(),
  });
  const coverBox = div('pub-ws-cover');
  const titleBox = div('pub-ws-titlebox');
  // Заголовок — кнопка-фасад (задача b51dbca4): клик/Enter открывает карточку
  // публикации в панели редактора. Пункт 1 карточки ea1b5f14: кликабельна ВСЯ
  // карточка (обложка + заголовок + подзаголовок + автор/дата) — поэтому
  // кнопка не всплывает кликом второй раз (stopPropagation).
  const titleButton = uiButton({
    role: 'ghost',
    class: 'pub-ws-title',
    title: t('publications.ws.openCard'),
    onClick: (ev) => {
      ev.stopPropagation();
      if (publicationId !== null) opts.onOpenCard(publicationId);
    },
  });
  const subtitleText = div('pub-ws-subtitle');
  const metaText = div('pub-ws-meta');
  titleBox.append(titleButton, subtitleText, metaText);
  const card = div('pub-ws-card');
  card.append(coverBox, titleBox);
  card.addEventListener('click', () => {
    if (publicationId !== null) opts.onOpenCard(publicationId);
  });
  const actions = div('pub-ws-actions');
  // Ползунок ширины текста документа — прямо над рядом кнопок, прижато вправо
  // (дополнение пользователя 2026-10-02, пункт 5). Текущее значение — в
  // подсказке, подписи в тулбаре нет. Живое движение применяет ширину, а
  // завершение — сохраняет настройку.
  const widthSlider = uiSlider({
    min: TEXT_WIDTH_MIN,
    max: TEXT_WIDTH_MAX,
    value: opts.getTextWidth(),
    ariaLabel: t('publications.ws.textWidth'),
    formatValue: (value) => `${value}%`,
    onInput: (value) => {
      applyTextWidth(value);
      opts.onTextWidthInput(value);
    },
    onChange: (value) => {
      applyTextWidth(value);
      opts.onTextWidthChange(value);
    },
  });
  const collapseAllButton = iconButton({
    icon: svgIcon('chevrons-up'),
    title: t('publications.ws.collapseAll'),
    role: 'ghost',
    onClick: () => setAllCollapsed(true),
  });
  const expandAllButton = iconButton({
    icon: svgIcon('chevrons-down'),
    title: t('publications.ws.expandAll'),
    role: 'ghost',
    onClick: () => setAllCollapsed(false),
  });
  const rebuildButton = iconButton({
    icon: svgIcon('rotate-ccw'),
    title: t('publications.ws.rebuild'),
    role: 'ghost',
    onClick: () => void rebuild(),
  });
  // Точка-индикатор «живой текст устарел»: видна только при `staleRebuild`
  // (класс на кнопке), снимается пересборкой (замечание А2 приёмки b02ef1cf).
  rebuildButton.classList.add('pub-ws-rebuild');
  rebuildButton.append(span('', 'pub-ws-rebuild-dot'));
  const exportButton = iconButton({
    icon: svgIcon('download'),
    title: t('publications.ws.export'),
    role: 'ghost',
    onClick: (ev) => {
      if (publicationId !== null) opts.onExport(publicationId, ev);
    },
  });
  actions.append(collapseAllButton, expandAllButton, rebuildButton, exportButton);
  const headerRight = div('pub-ws-right');
  headerRight.append(widthSlider.root, actions);
  header.append(backButton, card, div('pub-spacer'), headerRight);

  // --- Оглавление ----------------------------------------------------------

  const tocHead = div('pub-toc-head');
  const tocToggle = iconButton({
    icon: svgIcon('panel-left-close'),
    title: t('publications.ws.tocCollapse'),
    role: 'ghost',
    class: 'pub-toc-toggle',
    onClick: () => {
      tocCollapsed.value = !tocCollapsed.value;
      root.classList.toggle('pub-toc-collapsed', tocCollapsed.value);
      setButtonIcon(tocToggle, tocCollapsed.value ? 'panel-left-open' : 'panel-left-close');
      const title = tocCollapsed.value
        ? t('publications.ws.tocExpand')
        : t('publications.ws.tocCollapse');
      tocToggle.title = title;
      tocToggle.setAttribute('aria-label', title);
    },
  });
  tocHead.append(tocToggle, span(t('publications.ws.toc'), 'pub-toc-title'));
  const tocList = div('pub-toc-list');
  toc.append(tocHead, tocList);

  // --- Навигация тела документа --------------------------------------------

  // Тело документа — плоская последовательность блоков (заголовок раздела /
  // строка текста) поверх общего компонента списка `lib/ui/list.ts` и ядра
  // `lib/ui/nav-core.ts` (задача b51dbca4; ADR fadf99e0). Собственный обработчик
  // стрелок здесь запрещён сторожем `guard-list-nav`.
  docHost.tabIndex = 0;
  let navBlocks: DocBlock[] = [];

  const docEntries = (): DocNavEntry[] => {
    const out: DocNavEntry[] = [];
    for (const block of navBlocks) {
      if (block.kind === 'section') {
        out.push({
          key: block.key,
          thoughtId: block.thoughtId,
          kind: 'section',
          collapsible: block.collapsible,
        });
      } else if (block.kind === 'text') {
        out.push({ key: block.key, thoughtId: block.thoughtId, kind: 'text', collapsible: false });
      }
    }
    return out;
  };

  const blockNode = (key: string): HTMLElement | null => {
    for (const child of Array.from(docHost.children)) {
      const node = child as HTMLElement;
      if (node.dataset?.['blockKey'] === key) return node;
    }
    return null;
  };

  const entryForTarget = (target: HTMLElement): DocNavEntry | null => {
    if ((target.closest?.('a') ?? null) !== null) return null;
    let cursor: HTMLElement | null = target;
    while (cursor !== null && cursor !== docHost) {
      const key = cursor.dataset?.['blockKey'];
      if (key !== undefined) return docEntries().find((entry) => entry.key === key) ?? null;
      cursor = cursor.parentElement;
    }
    return null;
  };

  const docNav = createListNav<DocNavEntry>(docHost, {
    entries: () => docEntries(),
    tokenOf: (entry) => entry.key,
    elementOf: (entry) => blockNode(entry.key),
    applyHighlight: (entry) => {
      for (const node of Array.from(docHost.querySelectorAll<HTMLElement>('.pub-doc-current'))) {
        node.classList.remove('pub-doc-current');
      }
      if (entry !== null) blockNode(entry.key)?.classList.add('pub-doc-current');
    },
    onCollapse: (entry, isCollapsed) => {
      if (entry.kind === 'section' && entry.collapsible) setSectionCollapsed(entry.thoughtId, isCollapsed);
    },
    onActivate: (entry) => openThought(entry.thoughtId),
    onClick: (target) => {
      const entry = entryForTarget(target);
      if (entry === null) return;
      docNav.setCurrent(entry);
      docHost.focus();
    },
  } satisfies ListNavAdapter<DocNavEntry>);

  // --- Оглавление: выделение и ручной порядок (задача d13fd645) ------------

  /** Группа соседей раздела: по id мысли-родителя (`''` — корни). */
  function sectionGroupKey(parentThoughtId: string | null): string {
    return `s:${parentThoughtId ?? ''}`;
  }

  /** Группа соседей текста: тексты одного раздела. */
  function textGroupKey(sectionThoughtId: string): string {
    return `t:${sectionThoughtId}`;
  }

  /** Строка оглавления по ключу вхождения (`data-key`). */
  function tocLineNode(key: string): HTMLElement | null {
    for (const child of Array.from(tocList.children)) {
      const node = child as HTMLElement;
      if (node.dataset?.['key'] === key) return node;
    }
    return null;
  }

  /** Грип-аффорданс с подсказкой; клик по нему не активирует строку/блок. */
  function makeGrip(label: string): HTMLElement {
    const grip = dragHandle(label);
    grip.addEventListener('click', (ev) => ev.stopPropagation());
    return grip;
  }

  const tocNav = createListNav<TocLine>(tocList, {
    entries: () => tocLineItems,
    tokenOf: (line) => line.key,
    elementOf: (line) => tocLineNode(line.key),
    applyHighlight: (line) => {
      for (const node of Array.from(tocList.querySelectorAll<HTMLElement>('.pub-toc-line'))) {
        node.classList.remove('pub-toc-selected');
      }
      if (line !== null) tocLineNode(line.key)?.classList.add('pub-toc-selected');
    },
    onActivate: (line) => {
      if (line.kind !== 'excluded') scrollToAnchor(line.anchor);
    },
    onClick: (target) => {
      let cursor: HTMLElement | null = target;
      while (cursor !== null && cursor !== tocList) {
        const key = cursor.dataset?.['key'];
        if (key !== undefined) {
          const line = tocLineItems.find((candidate) => candidate.key === key) ?? null;
          if (line !== null) tocNav.setCurrent(line);
          return;
        }
        cursor = cursor.parentElement;
      }
    },
  } satisfies ListNavAdapter<TocLine>);

  /** Сортируемые строки оглавления — только разделы (своя группа на родителя). */
  function tocDragItems(): DragListItem<TocLine>[] {
    const out: DragListItem<TocLine>[] = [];
    for (const line of tocLineItems) {
      if (line.kind !== 'section') continue;
      const node = tocLineNode(line.key);
      const handle = node?.querySelector<HTMLElement>(`.${DRAG_HANDLE_CLASS}`) ?? null;
      if (node === null || handle === null) continue;
      out.push({
        entry: line,
        key: line.key,
        orderKey: line.nodeKey,
        groupKey: sectionGroupKey(line.parentThoughtId),
        element: node,
        handle,
      });
    }
    return out;
  }

  const tocDrag = createDragList<TocLine>(tocList, tocNav, {
    items: () => tocDragItems(),
    onReorder: (_groupKey, orderedKeys) => void commitOrder(orderedKeys),
  } satisfies DragListAdapter<TocLine>);

  /** Сортируемые блоки документа: разделы (по родителю) и тексты (по разделу). */
  function docDragItems(): DragListItem<DocBlock>[] {
    const out: DragListItem<DocBlock>[] = [];
    for (const block of navBlocks) {
      if (block.kind !== 'section' && block.kind !== 'text') continue;
      const node = blockNode(block.key);
      const handle = node?.querySelector<HTMLElement>(`.${DRAG_HANDLE_CLASS}`) ?? null;
      if (node === null || handle === null) continue;
      out.push({
        entry: block,
        key: block.key,
        orderKey: block.nodeKey,
        groupKey:
          block.kind === 'section'
            ? sectionGroupKey(block.parentThoughtId)
            : textGroupKey(block.parentThoughtId),
        element: node,
        handle,
      });
    }
    return out;
  }

  const docDrag = createDragList<DocBlock>(
    docHost,
    docNav,
    {
      items: () => docDragItems(),
      onReorder: (_groupKey, orderedKeys) => void commitOrder(orderedKeys),
    } satisfies DragListAdapter<DocBlock>,
    { scrollHost: () => docHost },
  );

  /**
   * Сохранить новый порядок ОДНОЙ группы соседей (очередь `node_key` из
   * drag-list). Оптимистично: модель и разметка обновляются сразу; ответ
   * сервера ложится в слой локальным сигналом, без перечитывания сборки
   * (задача d13fd645). При ошибке — откат к снимку и общий диалог ошибки.
   */
  async function commitOrder(orderedKeys: readonly string[]): Promise<void> {
    const networkId = store.state.networkId;
    const pubId = publicationId;
    if (networkId === null || pubId === null || assembly === null) return;
    const items: PublicationOrderItem[] = positionsFor(orderedKeys);
    const snapshot = assembly;
    let saved: PublicationOrderItem[];
    try {
      saved = await runOptimistic<PublicationAssembly | null, PublicationOrderItem[]>({
        snapshot: () => snapshot,
        apply: () => {
          assembly = applyPublicationOrder(assembly, items);
          renderToc();
          renderDocument();
        },
        rollback: (previous) => {
          assembly = previous;
          renderToc();
          renderDocument();
        },
        execute: () => etn.publications.setOrder(networkId, pubId, items),
      });
    } catch (err) {
      errorDialog(t('publications.ws.toc'), err);
      return;
    }
    signalPublicationOrderChanged(pubId, saved.length > 0 ? saved : items);
  }

  /** Точечно применить порядок из payload (сигнал/событие), без чтения сборки. */
  function applyOrderItems(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const items: PublicationOrderItem[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as { node_key?: unknown; position?: unknown };
      if (typeof record.node_key === 'string' && typeof record.position === 'number') {
        items.push({ node_key: record.node_key, position: record.position });
      }
    }
    if (items.length === 0) return;
    assembly = applyPublicationOrder(assembly, items);
    renderToc();
    renderDocument();
  }

  // --- Слушатели -----------------------------------------------------------

  /**
   * Программная прокрутка к якорю (клик по оглавлению) идёт с блокировкой
   * scroll-sync: события прокрутки, прилетающие во время перевода scrollTop к
   * цели, не должны перебивать `currentAnchor` промежуточными разделами
   * (замечание 1 приёмки 5de0332d). Пока флаг взведён, первый scroll само
   * себя снимает и current не пересчитывается; страховочный таймер снимает
   * флаг, если события прокрутки не случилось вовсе.
   */
  let scrollSyncLocked = false;
  let scrollSyncTimer: number | null = null;
  const lockScrollSync = (): void => {
    scrollSyncLocked = true;
    if (scrollSyncTimer !== null) window.clearTimeout(scrollSyncTimer);
    scrollSyncTimer = window.setTimeout(() => {
      scrollSyncLocked = false;
      scrollSyncTimer = null;
    }, 200);
  };
  const onDocScroll = (): void => {
    if (scrollSyncLocked) {
      // Промежуточное/завершающее событие программной прокрутки — current уже
      // назначен целью перехода, scroll-sync его не трогает.
      scrollSyncLocked = false;
      if (scrollSyncTimer !== null) {
        window.clearTimeout(scrollSyncTimer);
        scrollSyncTimer = null;
      }
      return;
    }
    updateCurrentSection();
  };
  /**
   * Ctrl+Shift+↑/↓ — сдвиг текущего блока документа на слот вверх/вниз в
   * группе соседей (пункт 5 требования, по аналогии с упорядочиванием карты
   * мыслей). Слушатель — в фазе перехвата: ядро навигации списка трактует
   * `ArrowUp/Down` независимо от модификаторов и иначе увело бы курсор.
   */
  const onDocKeydown = (ev: KeyboardEvent): void => {
    if (!ev.ctrlKey || !ev.shiftKey) return;
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    const entry = docNav.current();
    if (entry === null || (entry.kind !== 'section' && entry.kind !== 'text')) return;
    const block = navBlocks.find((candidate) => candidate.key === entry.key);
    if (block === undefined) return;
    ev.preventDefault();
    ev.stopPropagation();
    void moveBlock(block, ev.key === 'ArrowUp' ? -1 : 1);
  };
  const onKeydown = (ev: KeyboardEvent): void => {
    // Esc просмотр НЕ закрывает (задача b51dbca4): возврат — «Назад» или
    // Ctrl+Backspace, когда никакие поля не редактируются.
    if (ev.key !== 'Backspace' || ev.ctrlKey !== true) return;
    if (publicationId === null) return;
    if (isInsideDialog(document.activeElement)) return;
    if (isEditingTarget(document.activeElement)) return;
    ev.preventDefault();
    opts.onClose();
  };
  docHost.addEventListener('scroll', onDocScroll);
  docHost.addEventListener('keydown', onDocKeydown, { capture: true });
  document.addEventListener('keydown', onKeydown);

  // --- Загрузка ------------------------------------------------------------

  async function load(): Promise<void> {
    const networkId = store.state.networkId;
    if (networkId === null || publicationId === null) return;
    loading = true;
    loadError = null;
    renderState();
    try {
      const [card, doc] = await Promise.all([
        etn.publications.get(networkId, publicationId),
        etn.publications.assembly(networkId, publicationId, page > 1 ? { page } : {}),
      ]);
      publication = card;
      assembly = doc;
      // Полный снимок публикации — в нормализованный кэш слоя: точечные патчи
      // роутера ложатся поверх полной записи, а не создают частичную.
      commitEntity('publication', card.id, card);
      loading = false;
      candidates = null;
      candidatesOpen = false;
      renderHeader();
      renderToc();
      // Выход из stale (пересборка, в т.ч. внешняя) рендерит документ
      // принудительно — прямой патч DOM под stale не должен пережить сборку.
      renderDocument(forceDocumentRender);
      forceDocumentRender = false;
      renderCandidates();
      renderPager();
      renderState();
      updateRebuildStale();
    } catch (err) {
      loading = false;
      loadError = err;
      renderState();
    }
  }

  function reload(): void {
    if (reloadTimer !== null) window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => {
      reloadTimer = null;
      void load();
    }, 200);
  }

  /** Узлы блоков документа по id мысли (раздел и/или тексты; повторы — все). */
  function blockNodesForThought(thoughtId: string): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const node of Array.from(docHost.querySelectorAll<HTMLElement>('.pub-doc-section'))) {
      if (node.dataset?.['thoughtId'] === thoughtId) out.push(node);
    }
    for (const node of Array.from(docHost.querySelectorAll<HTMLElement>('.pub-doc-text'))) {
      if (node.dataset?.['thoughtId'] === thoughtId) out.push(node);
    }
    return out;
  }

  /**
   * Подсветка мысли, ОТКРЫТОЙ в редакторе, сплошной рамкой цвета фокуса (задача
   * 77cce0ba, п.2; как `.cloud.halo` на карте мыслей). Идёт от текущей цели
   * редактора и реагирует на её смену в обе стороны (открыли/закрыли): подписка
   * на store ниже. Текущий блок навигации (`.pub-doc-current`) — пунктирный.
   */
  function paintEditorHighlight(): void {
    const target = store.state.editorTarget;
    const haloId = target !== null && target.kind === 'thought' ? target.id : null;
    for (const node of Array.from(
      docHost.querySelectorAll<HTMLElement>('.pub-doc-section, .pub-doc-text'),
    )) {
      node.classList.toggle(
        'pub-doc-editor',
        haloId !== null && node.dataset['thoughtId'] === haloId,
      );
    }
  }
  const editorHighlightUnsub = store.subscribe(paintEditorHighlight);

  /**
   * Точечно заменяет КОНТЕНТ блоков мысли по готовому HTML (без чтения сборки):
   * у раздела — предисловие, у текста — сам блок. Используется при активном
   * `staleRebuild`, когда тянуть полную сборку нельзя (иначе материализуется
   * отложенный рецепт и порядок разделов сдвигается, замечание-блокер 1 приёмки
   * b02ef1cf).
   *
   * Модель блока (`navBlocks`) обновляется СИНХРОННО с DOM: `blockSignature`
   * включает `preambleHtml`/`html`, и без синхронизации `reconcileKeyed` счёл бы
   * блок неизменным и не перерисовал его при следующем полном рендере — прямой
   * патч DOM «просачивался» бы в сборку (блокер приёмки b02ef1cf).
   *
   * Компромисс: HTML собирается общим клиентским `renderMarkdown`, а не
   * серверным `renderPublicationFragment` (сервер умеет сдвиг уровней заголовков,
   * якоря и подстановку wiki-ссылок). Для предисловия/текста это несущественно;
   * расхождение снимет ближайшая пересборка.
   */
  function patchBlockText(thoughtId: string, html: string): void {
    for (const node of blockNodesForThought(thoughtId)) {
      const target = node.classList.contains('pub-doc-section')
        ? node.querySelector<HTMLElement>('.pub-doc-preamble')
        : node;
      if (target === null) continue;
      renderHtml(target, html);
      // Синхронизируем модель (иначе сигнатура не отразит правку).
      const block = blockForKey(node.dataset?.['blockKey']);
      if (block === null) continue;
      if (block.kind === 'section') block.preambleHtml = html;
      else if (block.kind === 'text') block.html = html;
    }
  }

  /**
   * Точечно меняет ЗАГОЛОВОК разделов мысли по новому названию (без чтения
   * сборки) и синхронно правит модель блока (см. {@link patchBlockText}).
   * Компромисс: при включённой нумерации номер раздела в заголовке до ближайшей
   * пересборки теряется — заголовок с номером пересобирает сервер.
   */
  function patchBlockHeading(thoughtId: string, title: string): void {
    for (const node of blockNodesForThought(thoughtId)) {
      if (!node.classList.contains('pub-doc-section')) continue;
      const text = node.querySelector<HTMLElement>('.pub-doc-heading-text');
      if (text === null) continue;
      text.textContent = title;
      const block = blockForKey(node.dataset?.['blockKey']);
      if (block !== null && block.kind === 'section') block.heading = title;
    }
  }

  /** Блок текущей модели по ключу DOM-узла (`data-block-key`). */
  function blockForKey(key: string | undefined): DocBlock | null {
    if (key === undefined) return null;
    return navBlocks.find((block) => block.key === key) ?? null;
  }

  /**
   * Realtime-изменение мысли: в документе — точечное обновление блока +
   * пометка устаревания; вне документа — ничего (замечание 2 приёмки b02ef1cf).
   * Пока текст УЖЕ устарел (`staleRebuild`), сборку НЕ перечитываем — иначе
   * материализуется отложенный рецепт и порядок разделов меняется до
   * «Пересобрать» (замечание-блокер 1): правим заголовок из payload события.
   */
  function applyThoughtRealtime(thoughtId: string, changes?: { title?: unknown }): void {
    if (publicationId === null || assembly === null) return;
    if (!assemblyHasThought(assembly, thoughtId)) return;
    const wasStale = staleRebuild;
    markRebuildStale();
    if (wasStale) {
      if (typeof changes?.title === 'string') patchBlockHeading(thoughtId, changes.title);
      return;
    }
    reload();
  }

  /**
   * Realtime-изменение комментария мысли в документе (предисловие раздела/текст
   * блока = постоянный комментарий мысли): обновляет блок. Пока текст устарел
   * (`staleRebuild`) — только точечная правка из payload (`body_md`) и только для
   * ПОСТОЯННОГО комментария (`kind === 'permanent'`), без чтения сборки
   * (замечание-блокер 1 приёмки b02ef1cf). Хроно-запись блока не образует —
   * игнорируется (блокер приёмки b02ef1cf). Владелец вне документа — ничего.
   */
  function applyCommentRealtime(ownerId?: string, bodyMd?: unknown, kind?: string): void {
    if (publicationId === null) return;
    if (ownerId !== undefined && assembly !== null && !assemblyHasThought(assembly, ownerId)) {
      return;
    }
    if (staleRebuild) {
      if (kind === 'permanent' && ownerId !== undefined && typeof bodyMd === 'string') {
        patchBlockText(ownerId, renderMarkdown(bodyMd));
      }
      return;
    }
    reload();
  }

  /** Смена рецепта/источников/нумерации (состав) — по паре снимков. */
  function compositionFieldsChanged(a: Publication | null, b: Partial<Publication>): boolean {
    if (a === null) return false;
    if (b.title_recipe !== undefined) {
      if (JSON.stringify(a.title_recipe ?? null) !== JSON.stringify(b.title_recipe ?? null)) return true;
    }
    if (b.text_sources !== undefined && a.text_sources.join(',') !== b.text_sources.join(',')) return true;
    if (
      b.extra_properties !== undefined &&
      a.extra_properties.join(',') !== b.extra_properties.join(',')
    ) {
      return true;
    }
    if (b.numbering_from !== undefined && a.numbering_from !== b.numbering_from) return true;
    if (b.numbering_to !== undefined && a.numbering_to !== b.numbering_to) return true;
    return false;
  }

  /** Перерисовывает шапку и титульный блок из текущего снимка публикации. */
  function renderPublicationChrome(): void {
    renderHeader();
    const titleBlock = docHost.querySelector<HTMLElement>('.pub-doc-titleblock');
    if (titleBlock !== null) titleBlock.replaceWith(buildTitleBlock());
  }

  /**
   * Внешняя правка полей публикации: слияние в снимок, перерисовка шапки и
   * титульного блока БЕЗ чтения сборки. Поля рецепта помечают текст устаревшим
   * (замечание 1 приёмки b02ef1cf).
   */
  function applyPublicationPatch(changes: Partial<Publication>): void {
    if (publicationId === null || publication === null) return;
    if (compositionFieldsChanged(publication, changes)) markRebuildStale();
    const merged: Publication = { ...publication, ...changes, id: publicationId };
    // `cover_kind` — вычисляемое поле: при правке обложки его нет в `changes`.
    if (changes.cover_attachment_id !== undefined || changes.cover_url !== undefined) {
      merged.cover_kind =
        merged.cover_attachment_id !== null
          ? 'attachment'
          : (merged.cover_url ?? '') !== ''
            ? 'url'
            : 'none';
    }
    publication = merged;
    renderPublicationChrome();
  }

  /**
   * Точечно применяет свежий снимок публикации: шапка и титульный блок берут
   * титул/подзаголовок/обложку из него. Сборку (разделы) не трогаем —
   * `reload()` для этого остаётся. Нужно для локальной правки из карточки
   * редактора, чей путь — слой (замечание А приёмки b02ef1cf).
   */
  function applyPublication(next: Publication): void {
    if (publicationId === null || next.id !== publicationId) return;
    // Смена рецепта/источников/нумерации влияет на СОСТАВ: живой текст остаётся,
    // но помечается устаревшим до пересборки (замечание А2 приёмки b02ef1cf).
    if (compositionFieldsChanged(publication, next)) markRebuildStale();
    publication = next;
    renderPublicationChrome();
  }

  async function rebuild(): Promise<void> {
    const networkId = store.state.networkId;
    if (networkId === null || publicationId === null) return;
    // Видимый прелоадер НА ВРЕМЯ ЗАПРОСА (спека 2ebacd12): иконочная кнопка
    // блокируется, подсказка меняется на «Пересборка…». Прелоадер документа из
    // `reload()` приходит с дебаунсом 200 мс и на медленном сервере запаздывал.
    rebuildButton.disabled = true;
    setButtonTitle(rebuildButton, t('publication.rebuilding'));
    let updated: Publication;
    try {
      updated = await etn.publications.rebuild(networkId, publicationId);
    } catch (err) {
      errorDialog(t('publications.ws.rebuild'), err);
      return;
    } finally {
      setButtonTitle(rebuildButton, t('publications.ws.rebuild'));
      rebuildButton.disabled = false;
    }
    // Пересборка снимает устаревание: живой текст снова соответствует составу.
    staleRebuild = false;
    // Документ перерисовываем принудительно: точечные правки DOM под stale не
    // должны пережить сборку (блокер приёмки b02ef1cf).
    forceDocumentRender = true;
    // Своего realtime-эха у пересборки нет (ошибка c2dec45c): свежий снимок
    // публикации кладём в кэш слоя, карточку и библиотеку будим инвалидацией
    // их ключей. Рабочая область уже сняла устаревание и перечитает документ.
    commitEntity('publication', publicationId, updated);
    invalidateAfterMutation([
      queryKeys.publicationCard(publicationId),
      queryKeys.publicationsListAll(),
    ]);
    reload();
  }

  // --- Рендер шапки --------------------------------------------------------

  function renderHeader(): void {
    if (publication === null) return;
    titleButton.textContent = publication.title;
    subtitleText.textContent = publication.subtitle ?? '';
    const author = displayAuthorship(publication, users.resolveUserName(publication.created_by));
    metaText.textContent = [author, assemblyDateLabel(publication.assembly_date)]
      .filter((part) => part !== '')
      .join(' · ');
    emptyNode(coverBox);
    coverBox.append(buildCover(publication, 'thumb'));
  }

  /**
   * Состояние подсветки «Пересобрать»: живой текст устарел по фактам realtime
   * (`staleRebuild`). Новые кандидаты — отдельная плашка, в подсветку не
   * входят: пересборка включает их в документ, и подсветка обязана сняться
   * (замечание А2 приёмки b02ef1cf).
   */
  function updateRebuildStale(): void {
    rebuildButton.classList.toggle('pub-ws-rebuild-stale', staleRebuild);
    setButtonTitle(
      rebuildButton,
      staleRebuild ? t('publications.ws.rebuildStale') : t('publications.ws.rebuild'),
    );
  }

  function markRebuildStale(): void {
    if (publicationId === null || staleRebuild) return;
    staleRebuild = true;
    updateRebuildStale();
  }

  /**
   * Внешняя пересборка: снять устаревание и перечитать документ. Флаг снимается
   * синхронно (кнопка гаснет сразу), перечитывание — с обычным дебаунсом
   * `reload()` (ошибка 29fd0587: внешний `publication.rebuilt` перечитывал
   * документ, но подсветка оставалась). Документ перерисовывается принудительно
   * — прямой патч DOM под stale не должен пережить сборку (блокер b02ef1cf).
   */
  function applyRebuildRealtime(): void {
    if (publicationId === null) return;
    staleRebuild = false;
    updateRebuildStale();
    forceDocumentRender = true;
    reload();
  }

  // --- Привязка к слою данных (G4 тех.проекта 269016e2) ---------------------
  //
  // Снимки рабочей области живут под ключами слоя `pub-card:@id` и
  // `pub-assembly:@id`. Роутер гасит их на чужие события, мутации источников —
  // через `invalidateQueries`; решение «что делать» принимает этот подписчик:
  // контентная правка обновляет шапку/титул/блок точечно, состав помечает живой
  // текст устаревшим, пересборка снимает устаревание и перечитывает документ.
  // Локальные каналы (`lib/publication-events`) снесены — единственный путь.

  /** Зарегистрировать ключи открытой публикации в реестре слоя. */
  function retargetWorkspaceKeys(): void {
    if (publicationId === null) return;
    registerQuery(queryKeys.publicationCard(publicationId), null);
    registerQuery(queryKeys.publicationAssembly(publicationId), null);
  }

  /** Локальный сигнал мутации-источника (не realtime-событие). */
  function asLocalSignal(cause: unknown): LocalMutationSignal | null {
    if (typeof cause !== 'object' || cause === null) return null;
    const c = cause as { local?: unknown };
    return typeof c.local === 'string' ? (cause as LocalMutationSignal) : null;
  }

  /** Realtime-событие из причины инвалидации (или `null`, если причина локальная). */
  function asRealtimeEvent(
    cause: unknown,
  ): { type: string; data: Record<string, unknown> } | null {
    if (typeof cause !== 'object' || cause === null) return null;
    const c = cause as { type?: unknown; data?: unknown };
    if (typeof c.type !== 'string') return null;
    const data =
      typeof c.data === 'object' && c.data !== null
        ? (c.data as Record<string, unknown>)
        : {};
    return { type: c.type, data };
  }

  /**
   * Инвалидация снимка публикации (`pub-card`). Локальная правка контента
   * приходит без события — берём свежий полный снимок из нормализованного кэша
   * (его положила карточка через `commitEntity`). Realtime-путь обрабатывает
   * инвалидация сборки — здесь не дублируем.
   */
  function onCardInvalidated(cause: unknown): void {
    if (publicationId === null) return;
    if (asRealtimeEvent(cause) !== null || asLocalSignal(cause) !== null) return;
    const cached = getEntity<Publication>('publication', publicationId);
    if (cached !== undefined && cached !== null) applyPublication(cached);
    else reload();
  }

  /**
   * Инвалидация сборки (`pub-assembly`): маршрутизация по ПРИЧИНЕ. Состав
   * помечает живой текст устаревшим без перечитывания (замечание А2 приёмки
   * b02ef1cf), контент правит блок точечно из payload, пересборка снимает
   * устаревание и перечитывает документ. Причина — realtime-событие роутера
   * либо локальный сигнал СВОЕЙ правки (`signal*` из `lib/live/mutator`).
   */
  function onAssemblyInvalidated(cause: unknown): void {
    if (publicationId === null) return;
    const local = asLocalSignal(cause);
    if (local !== null) {
      switch (local.local) {
        case 'publication-rebuilt':
          applyRebuildRealtime();
          return;
        case 'comment-saved': {
          const body = local.data?.['body_md'];
          const kind = local.data?.['kind'];
          applyCommentRealtime(local.id, body, typeof kind === 'string' ? kind : undefined);
          return;
        }
        case 'thought-saved': {
          const changes = local.data?.['changes'];
          applyThoughtRealtime(
            local.id ?? '',
            typeof changes === 'object' && changes !== null
              ? (changes as { title?: unknown })
              : undefined,
          );
          return;
        }
        case 'publication-order':
          // Свой PUT order: порядок уже применён оптимистично; сигнал несёт
          // сохранённые позиции — точечное (идемпотентное) применение.
          applyOrderItems(local.data?.['items']);
          return;
        case 'publication-composition': {
          // Признак «правка может изменить состав, даже если сущности в сборке
          // нет» (передача G5→G6): значения свойств-критериев рецепта могут
          // ВВЕСТИ мысль в сборку — проверка принадлежности недостаточна.
          if (local.data?.['may_change_composition'] === true) {
            markRebuildStale();
            return;
          }
          // Ужесточение (передача из G4, задача 8a039ea3): правка постороннего
          // свойства/связи не должна зажигать ложный stale. Если изменённые
          // мысли известны и НИ ОДНОЙ нет в текущей сборке — состав не затронут.
          const ids = local.data?.['thought_ids'];
          const asm = assembly;
          if (
            asm !== null &&
            Array.isArray(ids) &&
            ids.length > 0 &&
            !ids.some((id) => typeof id === 'string' && assemblyHasThought(asm, id))
          ) {
            return;
          }
          markRebuildStale();
          return;
        }
        default:
          reload();
          return;
      }
    }
    const evt = asRealtimeEvent(cause);
    if (evt === null) {
      // Локальная/неизвестная инвалидация — безопасное перечитывание.
      reload();
      return;
    }
    const type = evt.type;
    if (type.startsWith('publication.')) {
      const id = evt.data['id'] ?? evt.data['publication_id'];
      if (typeof id === 'string' && id !== publicationId) return; // чужая публикация
      if (type === 'publication.rebuilt') {
        applyRebuildRealtime();
        return;
      }
      if (type === 'publication.updated') {
        const changes = evt.data['changes'];
        if (typeof changes !== 'object' || changes === null) {
          reload();
          return;
        }
        // Обе ветки независимы: смешанный PATCH `{title, title_recipe}` даёт и
        // подсветку состава, и новый заголовок (замечание-блокер 2 b02ef1cf).
        const routing = routePublicationUpdate(changes as Partial<Publication>);
        if (routing.markStale) markRebuildStale();
        if (routing.patch !== null) applyPublicationPatch(routing.patch);
        return;
      }
      if (type === 'publication.order.reordered') {
        // Порядок узлов — точечное применение позиции, без перечитывания
        // сборки: документ и оглавление обновляются живьём (задача d13fd645).
        applyOrderItems(evt.data['items']);
        return;
      }
      // Исключения/корзина — состав меняется, перечитываем.
      reload();
      return;
    }
    if (type === 'comment.created' || type === 'comment.updated') {
      const comment = evt.data['comment'] as Record<string, unknown> | undefined;
      const changes = evt.data['changes'] as Record<string, unknown> | undefined;
      const kind = comment?.['kind'] ?? evt.data['kind'];
      // Блок документа образует только постоянный комментарий.
      if (kind !== 'permanent') return;
      const ownerId = comment?.['owner_id'] ?? evt.data['owner_id'];
      const bodyMd = comment?.['body_md'] ?? changes?.['body_md'];
      applyCommentRealtime(typeof ownerId === 'string' ? ownerId : undefined, bodyMd, 'permanent');
      return;
    }
    if (type === 'comment.deleted') {
      const ownerId = evt.data['owner_id'];
      applyCommentRealtime(typeof ownerId === 'string' ? ownerId : undefined);
      return;
    }
    if (type === 'thought.updated') {
      const id = evt.data['id'];
      applyThoughtRealtime(
        typeof id === 'string' ? id : '',
        evt.data['changes'] as { title?: unknown } | undefined,
      );
      return;
    }
    // Состав: связи/свойства/типы, создание/удаление/порядок мыслей — состав
    // документа на лету не меняется, «Пересобрать» подсвечивается.
    if (
      type === 'thought.created' ||
      type === 'thought.deleted' ||
      type === 'thought.reordered' ||
      type.startsWith('link.') ||
      type.startsWith('property-value.') ||
      type.startsWith('thought-type.') ||
      type.startsWith('link-type.') ||
      type.startsWith('property-definition.') ||
      type.startsWith('property-registry.')
    ) {
      markRebuildStale();
      return;
    }
    reload();
  }

  const workspaceLayerUnsub = onQueryInvalidated((prefix, _keys, cause) => {
    if (publicationId === null) return;
    if (prefix === queryKeys.publicationCard(publicationId)) {
      onCardInvalidated(cause);
      return;
    }
    if (
      prefix === queryKeys.publicationAssemblyAll() ||
      prefix === queryKeys.publicationAssembly(publicationId)
    ) {
      onAssemblyInvalidated(cause);
    }
  });

  // --- Рендер состояний ----------------------------------------------------

  function renderState(): void {
    emptyNode(stateHost);
    // Пустой отбор заголовков (задача 7cfaba7c, п.2): сервер отдаёт пустую сборку
    // с предупреждением-маркером — показываем подсказку вместо пустой страницы.
    const emptyRecipe =
      !loading &&
      loadError === null &&
      assembly !== null &&
      assembly.warnings.includes(PUBLICATION_EMPTY_RECIPE_WARNING);
    stateHost.classList.toggle('hidden', !loading && loadError === null && !emptyRecipe);
    docHost.classList.toggle('hidden', loading || loadError !== null || emptyRecipe);
    if (loading) {
      stateHost.append(loadingState());
      return;
    }
    if (loadError !== null) {
      stateHost.append(
        errorState(t('publications.ws.loadError'), {
          label: t('publications.ws.retry'),
          onClick: () => void load(),
        }),
      );
      return;
    }
    if (emptyRecipe) {
      stateHost.append(emptyState({ title: t('publications.ws.emptyRecipe') }));
    }
  }

  // --- Оглавление ----------------------------------------------------------

  function renderToc(): void {
    const lines = tocLines(assembly, collapsed, (index) => t('publications.ws.text', index));
    tocLineItems = lines;
    reconcileKeyed<TocLine>(tocList, lines, {
      key: (line) => line.key,
      build: (line) => buildTocLine(line),
      update: (node, line) => updateTocLine(node, line),
      equals: (a, b) => tocSignature(a) === tocSignature(b),
    });
    tocNav.refresh();
    tocDrag.refresh();
  }

  function buildTocLine(line: TocLine): HTMLElement {
    const node = div('pub-toc-line');
    node.dataset['key'] = line.key;
    if (line.kind === 'section') {
      node.dataset['anchor'] = line.anchor;
      node.dataset['thoughtId'] = line.thoughtId;
      node.style.paddingLeft = `${line.depth}rem`;
      // Ручка-аффорданс ручного порядка (задача d13fd645): видна на hover и на
      // выбранной строке; порядок сохраняет общий drag-фасад `lib/ui`.
      setTooltip(node, t('publications.ws.dragKeyboardHint'));
      const caret = line.hasChildren ? iconButton({
        icon: svgIcon('chevron-down'),
        title: line.collapsed ? t('publications.ws.tocExpand') : t('publications.ws.tocCollapse'),
        role: 'ghost',
        class: 'pub-toc-caret',
        onClick: (ev) => {
          ev.stopPropagation();
          toggleCollapsed(line.thoughtId);
        },
      }) : span('', 'pub-toc-caret');
      node.append(makeGrip(t('publications.ws.dragHandle')), caret, span(line.label, 'pub-toc-label'));
      const marks = div('pub-toc-marks');
      if (line.repeat) {
        // Пометка повтора — переходу к первому вхождению раздела (2ebacd12).
        const repeatAnchor = line.repeatOf;
        marks.append(
          repeatAnchor !== null
            ? iconButton({
                icon: svgIcon('rotate-ccw'),
                title: t('publications.ws.repeat'),
                role: 'ghost',
                class: 'pub-toc-mark',
                onClick: (ev) => {
                  ev.stopPropagation();
                  scrollToAnchor(repeatAnchor);
                },
              })
            : tocMark('repeat', t('publications.ws.repeat')),
        );
      }
      if (line.cycle) marks.append(tocMark('cycle', t('publications.ws.cycle')));
      node.append(marks);
      node.classList.toggle('pub-toc-folded', line.collapsed);
      wireTocSection(node, line);
    } else if (line.kind === 'excluded') {
      node.dataset['thoughtId'] = line.thoughtId;
      node.classList.add('pub-toc-excluded');
      node.append(span(line.title, 'pub-toc-label'));
      node.addEventListener('click', () => openThought(line.thoughtId));
      node.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        showMenuAt(ev.clientX, ev.clientY, [
          menuAction(t('publications.ws.openThought'), () => openThought(line.thoughtId)),
          menuAction(t('publications.ws.restore'), () => void setExcluded(line.thoughtId, false)),
        ]);
      });
    }
    return node;
  }

  /**
   * Пересобирает содержимое строки (пометки/каретка тоже), сохраняя сам узел и
   * его слушатели (клик/меню/drag привязаны к узлу, а не к детям).
   */
  function updateTocLine(node: HTMLElement, line: TocLine): void {
    const fresh = buildTocLine(line);
    emptyNode(node);
    while (fresh.firstChild !== null) node.append(fresh.firstChild);
    if (line.kind === 'section') {
      node.style.paddingLeft = `${line.depth}rem`;
      node.classList.toggle('pub-toc-folded', line.collapsed);
    }
    node.classList.toggle('pub-toc-current', line.kind !== 'excluded' && line.anchor === currentAnchor);
  }

  /**
   * Свернуть/развернуть раздел (по id мысли). Состояние — набор `collapsed`,
   * общий для оглавления и тела документа (задача b51dbca4): перерисовываются
   * оба, чтобы свёрнутый раздел одинаково прятал свои тексты и подразделы.
   */
  function setSectionCollapsed(thoughtId: string, isCollapsed: boolean): void {
    if (isCollapsed) collapsed.add(thoughtId);
    else collapsed.delete(thoughtId);
    renderToc();
    renderDocument();
  }

  function toggleCollapsed(thoughtId: string): void {
    setSectionCollapsed(thoughtId, !collapsed.has(thoughtId));
  }

  /** Тулбар «Свернуть все»/«Развернуть все» — по разделам с содержимым. */
  function setAllCollapsed(isCollapsed: boolean): void {
    collapsed.clear();
    if (isCollapsed) {
      for (const thoughtId of collapsibleSectionIds(assembly)) collapsed.add(thoughtId);
    }
    renderToc();
    renderDocument();
  }

  function wireTocSection(node: HTMLElement, line: TocLine): void {
    if (line.kind === 'excluded') return;
    const anchor = line.anchor;
    const thoughtId = line.thoughtId;
    node.addEventListener('click', () => scrollToAnchor(anchor));
    node.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showMenuAt(ev.clientX, ev.clientY, rowMenu(thoughtId));
    });
  }

  function tocMark(kind: 'repeat' | 'cycle', title: string): HTMLElement {
    const node = span(kind === 'repeat' ? '↻' : '⌁', 'pub-toc-mark');
    node.dataset['mark'] = kind;
    setTooltip(node, title);
    return node;
  }

  function rowMenu(thoughtId: string): MenuItem[] {
    return [
      menuAction(t('publications.ws.openThought'), () => openThought(thoughtId)),
      menuAction(t('publications.ws.createSection'), () => void createChild(thoughtId, 'section')),
      menuAction(t('publications.ws.createText'), () => void createChild(thoughtId, 'text')),
      MENU_SEPARATOR,
      menuAction(t('publications.ws.exclude'), () => void setExcluded(thoughtId, true), {
        danger: true,
      }),
    ];
  }

  // --- Контекстное меню блока документа (карточка ea1b5f14, пункт 3) --------
  //
  // На разделах и текстах документа — то же меню, что у облачка мысли (общие
  // команды из `buildThoughtMenuItems`, без дублирования словаря), а ВВЕРХУ —
  // подменю «В публикации» с командами просмотра. Позицию/порядок правит тот же
  // `commitOrder` (задача d13fd645), исключения — `setExcluded`.

  /** Мысль-владелец текстов блока: у текста — его раздел, у раздела — он сам. */
  function textOwnerId(block: DocBlock): string {
    if (block.kind === 'text') return block.parentThoughtId;
    if (block.kind === 'section') return block.thoughtId;
    return '';
  }

  /** Мысль блока исключена из публикации (список `excluded` сборки). */
  function isExcluded(thoughtId: string): boolean {
    return assembly?.excluded.some((entry) => entry.thought_id === thoughtId) ?? false;
  }

  /** Ключи `node_key` соседей блока в его группе (разделы/тексты одного уровня). */
  function groupKeysForBlock(block: DocBlock): string[] {
    if (block.kind !== 'section' && block.kind !== 'text') return [];
    const target =
      block.kind === 'section'
        ? sectionGroupKey(block.parentThoughtId)
        : textGroupKey(block.parentThoughtId);
    const keys: string[] = [];
    for (const candidate of navBlocks) {
      if (candidate.kind !== 'section' && candidate.kind !== 'text') continue;
      const group =
        candidate.kind === 'section'
          ? sectionGroupKey(candidate.parentThoughtId)
          : textGroupKey(candidate.parentThoughtId);
      if (group === target) keys.push(candidate.nodeKey);
    }
    return keys;
  }

  /** Сдвинуть блок на один слот внутри группы соседей (общий `commitOrder`). */
  async function moveBlock(block: DocBlock, delta: number): Promise<void> {
    if (block.kind !== 'section' && block.kind !== 'text') return;
    const keys = groupKeysForBlock(block);
    const index = keys.indexOf(block.nodeKey);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= keys.length) return;
    const reordered = keys.slice();
    const [moved] = reordered.splice(index, 1);
    if (moved === undefined) return;
    reordered.splice(next, 0, moved);
    await commitOrder(reordered);
  }

  /** Команды подменю «В публикации» для блока (состав зависит от вида блока). */
  function publicationBlockCommands(block: DocBlock): MenuItem[] {
    if (block.kind !== 'section' && block.kind !== 'text') return [];
    const keys = groupKeysForBlock(block);
    const index = keys.indexOf(block.nodeKey);
    const items: MenuItem[] = [
      menuAction(t('publications.block.moveUp'), () => void moveBlock(block, -1), {
        disabled: index <= 0,
      }),
      menuAction(t('publications.block.moveDown'), () => void moveBlock(block, 1), {
        disabled: index < 0 || index >= keys.length - 1,
      }),
      menuAction(t('publications.block.moveToSection'), () => openMoveToSectionDialog(block)),
    ];
    // Разделы: отдельные команды «на этом уровне» (родитель — родитель блока)
    // и «подчинённый» (родитель — сам блок) с автозаполнением родителя (задача
    // 7cfaba7c, п.4). «Добавить текст раздела» — у обоих (владелец — раздел).
    if (block.kind === 'section') {
      items.push(
        menuAction(t('publications.block.addSectionSibling'), () =>
          void createChild(block.parentThoughtId, 'section'),
        ),
        menuAction(t('publications.block.addSectionChild'), () =>
          void createChild(block.thoughtId, 'section'),
        ),
      );
    }
    items.push(
      menuAction(t('publications.block.addText'), () => void createChild(textOwnerId(block), 'text')),
      MENU_SEPARATOR,
    );
    const excluded = isExcluded(block.thoughtId);
    items.push(
      menuAction(
        excluded ? t('publications.block.include') : t('publications.block.exclude'),
        () => void setExcluded(block.thoughtId, !excluded),
        { danger: !excluded },
      ),
      menuAction(t('publications.block.open'), () => openThought(block.thoughtId)),
    );
    return items;
  }

  /** Открывает меню блока: подменю «В публикации» + общие команды мысли. */
  function openBlockMenu(ev: MouseEvent, block: DocBlock): void {
    const networkId = store.state.networkId;
    if (networkId === null) return;
    if (block.kind !== 'section' && block.kind !== 'text') return;
    const title =
      block.kind === 'section'
        ? block.heading
        : (blockNode(block.key)?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const commands = publicationBlockCommands(block);
    showMenuAt(ev.clientX, ev.clientY, [
      ...(commands.length > 0
        ? [menuSubmenu(t('publications.block.menu'), commands), MENU_SEPARATOR]
        : []),
      ...buildThoughtMenuItems(
        networkId,
        { id: block.thoughtId, title, dir: 'children' },
        { hideOpenCommand: true, hideSelectionCommand: true, hideAddCommand: true },
      ),
    ]);
  }

  /** Плоский список разделов публикации для дерева выбора (дедуп по мысли). */
  function sectionTreeItems(): SectionTreeItem[] {
    if (assembly === null) return [];
    const out: SectionTreeItem[] = [];
    const seen = new Set<string>();
    for (const item of flattenSections(assembly.sections)) {
      const id = item.section.thought_id;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, parentId: item.parentThoughtId, title: item.section.heading });
    }
    return out;
  }

  /** Диалог «Переместить в раздел…»: дерево разделов публикации. */
  function openMoveToSectionDialog(block: DocBlock): void {
    if (block.kind !== 'section' && block.kind !== 'text') return;
    const all = sectionTreeItems();
    // Исключаем САМ блок и (для раздела) всё его поддерево: перенос в потомка
    // создаёт цикл родителей (блокер 1 верификации ea1b5f14).
    const excluded = subtreeIds(block.thoughtId, all);
    const items = all.filter((item) => !excluded.has(item.id));
    const body = div('pub-move-body');
    let close = (): void => undefined;
    const tree = createTree<SectionTreeItem>({
      items,
      renderContent: (item) => span(item.title, 'pub-move-label'),
      emptyText: t('publications.block.moveToSectionEmpty'),
      onActivate: (item) => {
        close();
        void moveBlockToSection(block, item.id);
      },
    });
    body.append(tree.root);
    close = showDialog({
      title: t('publications.block.moveToSectionTitle'),
      body,
      size: 'm',
      buttons: [{ label: t('actions.cancel') }],
    });
  }

  /** Переносит блок: текст — значением свойства-источника, раздел — родителем. */
  async function moveBlockToSection(block: DocBlock, targetSectionId: string): Promise<void> {
    if (block.kind === 'text') await moveTextToSection(block, targetSectionId);
    else if (block.kind === 'section') await moveSectionToSection(block, targetSectionId);
  }

  /**
   * Перенос раздела под другой раздел — смена единственного структурного
   * родителя (общая пакетная операция `set_only_parents`). Состав публикации
   * меняется только после пересборки — помечаем живой текст устаревшим.
   */
  async function moveSectionToSection(block: DocBlock, targetSectionId: string): Promise<void> {
    const networkId = store.state.networkId;
    if (networkId === null || block.kind !== 'section') return;
    if (block.parentThoughtId === targetSectionId) return;
    // Защита от цикла: даже если диалог обойдён, перенос в собственного потомка
    // (или в себя) отвергается — иначе REST neighbors возвращает A↔A1.
    if (subtreeIds(block.thoughtId, sectionTreeItems()).has(targetSectionId)) {
      notice(t('publications.block.moveCycle'), 'error');
      return;
    }
    try {
      throwOnFailures(await setOnlyParents(networkId, block.thoughtId, [targetSectionId], null));
    } catch (err) {
      errorDialog(t('publications.block.moveToSectionTitle'), err);
      return;
    }
    markRebuildStale();
    reload();
  }

  /**
   * Перенос текста в другой раздел: значение свойства-источника переносится с
   * прежнего владельца на целевой раздел. Сначала добавляем в целевой раздел,
   * затем убираем из прежнего — сбой второй операции значение не теряет.
   */
  async function moveTextToSection(block: DocBlock, targetSectionId: string): Promise<void> {
    const networkId = store.state.networkId;
    if (networkId === null || block.kind !== 'text') return;
    const oldOwner = block.parentThoughtId;
    if (oldOwner === targetSectionId) return;
    const sources = publication?.text_sources ?? [];
    if (sources.length === 0) {
      notice(t('publications.ws.noTextSources'), 'error');
      return;
    }
    try {
      const rows = await loadPropertyRows(networkId);
      const listRows = buildPropertyListRows(rows, store.state.linkTypes).filter(
        (row) => !row.structural && row.valueType === 'link' && sources.includes(row.propertyId),
      );
      const values = await etn.properties.get(networkId, 'thought', oldOwner);
      let row: (typeof listRows)[number] | null = null;
      let entry: (typeof values)[number] | null = null;
      for (const value of values) {
        if (!('values' in value)) continue;
        if (!value.values.some((item) => item.target_id === block.thoughtId)) continue;
        // Свойство-связь вне цепочки типа приходит с `property_id: ''` —
        // сверяем по имени стороны (`linkEntryMatchesPick`), иначе перенос
        // не находит свойство (блокер 3 верификации ea1b5f14).
        const candidate =
          listRows.find((item) =>
            linkEntryMatchesPick(value, { propertyId: item.propertyId, key: item.name }),
          ) ?? null;
        if (candidate === null) continue;
        row = candidate;
        entry = value;
        break;
      }
      if (row === null || entry === null || !('values' in entry)) {
        notice(t('publications.block.moveFailed'), 'error');
        return;
      }
      const propertyId = row.propertyId;
      // Ключ записи `properties.set` — display-имя выбранной стороны (см.
      // `LinkPropertyPick.key`); у строки списка это `name`.
      const propertyKey = row.name;
      await addPropertyValue(
        networkId,
        targetSectionId,
        { propertyId, key: propertyKey },
        block.thoughtId,
      );
      const remaining = entry.values
        .map((item) => item.target_id)
        .filter((id) => id !== block.thoughtId);
      await etn.properties.set(networkId, 'thought', oldOwner, propertyKey, remaining);
    } catch (err) {
      errorDialog(t('publications.block.moveToSectionTitle'), err);
      return;
    }
    markRebuildStale();
    reload();
  }

  /**
   * Двойной клик по тексту (пункт 4): мысль открывается в редакторе на вкладке
   * «Комментарий» в режиме правки, курсор — по началу кликнутого абзаца
   * (точный офсет рендера к markdown недостижим; нет вхождения — начало).
   */
  function openTextCommentEdit(ev: MouseEvent, block: DocBlock): void {
    if (block.kind !== 'text') return;
    const target = ev.target as HTMLElement | null;
    const paragraph = target?.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6') ?? null;
    const text = (paragraph?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    void import('../../editor/editor.js').then((mod) =>
      mod.openThoughtCommentEditor(block.thoughtId, text === '' ? undefined : text),
    );
  }

  // --- Документ ------------------------------------------------------------

  /**
   * Ширина колонки текста документа — доля доступного пространства (50–100%,
   * пункт 5 карточки ea1b5f14). Значение кладём CSS-переменной на холст
   * документа; раскладку (центровку и отступ от краёв) держит
   * `publications.css`.
   */
  function applyTextWidth(value: number): void {
    const clamped = Math.min(TEXT_WIDTH_MAX, Math.max(TEXT_WIDTH_MIN, Math.round(value)));
    docHost.style.setProperty('--pub-doc-width', `${clamped}%`);
    // Синхронизируем положение бегунка: настройка могла прийти из L4 ПОСЛЕ
    // постройки фасада (шапка монтируется раньше загрузки ui_state) — без этого
    // ширина применялась бы, а ползунок показывал прежнее значение (ea1b5f14).
    widthSlider.setValue(clamped);
  }

  /**
   * Рендер документа. `force` отключает сверку по подписям: при выходе из stale
   * прямая правка DOM могла разойтись с моделью, и все блоки обязаны
   * перестроиться из серверной сборки (блокер приёмки b02ef1cf).
   */
  function renderDocument(force = false): void {
    const blocks = documentBlocks(assembly, publication, collapsed);
    navBlocks = blocks;
    preserveScroll(docHost, () => {
      reconcileKeyed<DocBlock>(docHost, blocks, {
        key: (block) => block.key,
        build: (block) => buildBlock(block),
        update: (node, block) => updateBlock(node, block),
        equals: (a, b) => !force && blockSignature(a) === blockSignature(b),
      });
    });
    docNav.refresh();
    docDrag.refresh();
    updateCurrentSection();
    // Перерисовка снесла классы подсветки — восстанавливаем рамку открытой в
    // редакторе мысли (задача 77cce0ba, п.2).
    paintEditorHighlight();
  }

  function buildBlock(block: DocBlock): HTMLElement {
    if (block.kind === 'title') return buildTitleBlock();
    if (block.kind === 'section') {
      const node = div('pub-doc-section');
      node.id = block.domId;
      node.dataset['thoughtId'] = block.thoughtId;
      node.dataset['blockKey'] = block.key;
      node.tabIndex = -1;
      node.classList.toggle('pub-doc-collapsed', block.collapsed);
      const heading = el(headingTag(block.level), 'pub-doc-heading');
      heading.dataset['thoughtId'] = block.thoughtId;
      if (block.repeat) heading.classList.add('pub-doc-repeat');
      // Ручка ручного порядка раздела (задача d13fd645).
      setTooltip(node, t('publications.ws.dragKeyboardHint'));
      heading.append(makeGrip(t('publications.ws.dragHandle')));
      if (block.collapsible) {
        // Каретка-экспандер: сворачивает/разворачивает раздел, не открывая мысль
        // (задача b51dbca4) — поэтому клик по ней не всплывает к разделу.
        heading.append(
          iconButton({
            icon: svgIcon('chevron-down'),
            title: block.collapsed
              ? t('publications.ws.sectionExpand')
              : t('publications.ws.sectionCollapse'),
            role: 'ghost',
            class: 'pub-doc-caret',
            onClick: (ev) => {
              ev.stopPropagation();
              setSectionCollapsed(block.thoughtId, !block.collapsed);
            },
          }),
        );
      } else {
        // Раздел без содержимого каретки не имеет, но жёлоб выравнивания обязан
        // быть одинаковым у всех заголовков — иначе текст листовых разделов
        // «уезжал» влево относительно родительских (замечание 4 приёмки
        // 5de0332d). Плейсхолдер занимает ту же позицию, что каретка, и в
        // раскладке не участвует (каретка и грип — абсолютные, см. CSS).
        const caretPlaceholder = span('', 'pub-doc-caret pub-doc-caret-empty');
        caretPlaceholder.setAttribute('aria-hidden', 'true');
        heading.append(caretPlaceholder);
      }
      heading.append(span(block.heading, 'pub-doc-heading-text'));
      node.append(heading);
      if (!block.collapsed && block.preambleHtml !== '') {
        const preamble = div('pub-doc-preamble');
        preamble.dataset['thoughtId'] = block.thoughtId;
        renderHtml(preamble, block.preambleHtml);
        node.append(preamble);
      }
      node.addEventListener('click', (ev) => selectBlock(ev, block.thoughtId));
      node.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        openBlockMenu(ev, block);
      });
      return node;
    }
    if (block.kind === 'text') {
      const node = div('pub-doc-text');
      node.id = block.domId;
      node.dataset['thoughtId'] = block.thoughtId;
      node.dataset['blockKey'] = block.key;
      node.tabIndex = -1;
      renderHtml(node, block.html);
      // Ручка ручного порядка текста среди текстов своего раздела (d13fd645).
      setTooltip(node, t('publications.ws.dragKeyboardHint'));
      node.prepend(makeGrip(t('publications.ws.dragHandle')));
      node.addEventListener('click', (ev) => selectBlock(ev, block.thoughtId));
      node.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        openBlockMenu(ev, block);
      });
      node.addEventListener('dblclick', (ev) => openTextCommentEdit(ev, block));
      return node;
    }
    const node = div('pub-doc-extra');
    for (const group of block.groups) {
      node.append(span(t('publications.ws.extra'), 'pub-doc-extra-title'));
      const list = div('pub-doc-extra-list');
      for (const target of group.targets) {
        const link = uiButton({
          label: target.title,
          role: 'ghost',
          class: 'pub-doc-extra-link',
          onClick: () => openThought(target.id),
        });
        list.append(link);
      }
      node.append(list);
    }
    return node;
  }

  /**
   * Точечная сверка неполна для блоков с изменчивой структурой (появление/
   * исчезновение предисловия, титул, «доп. материалы»), поэтому содержимое
   * блока пересобирается целиком в его же узле — identity узла сохраняется,
   * слушатели на самом узле (выделение раздела) остаются. Класс свёрнутости
   * раздела живёт на самом узле (не в детях), поэтому синхронизируется здесь.
   */
  function updateBlock(node: HTMLElement, block: DocBlock): void {
    const fresh = buildBlock(block);
    emptyNode(node);
    while (fresh.firstChild !== null) node.append(fresh.firstChild);
    if (block.kind === 'section') {
      node.classList.toggle('pub-doc-collapsed', block.collapsed);
    }
  }

  /**
   * Титульный лист (пункт 7 карточки ea1b5f14): с обложкой — обложка с крупным
   * заголовком ПОВЕРХ (окантовка/тень, чтобы читался на любом фоне), скромный
   * подзаголовок; без обложки — название крупнее H1 и подзаголовок вторым
   * уровнем. Автор/дата — в ПРАВОМ НИЖНЕМ углу титульной части (задача 7cfaba7c,
   * п.5), резюме — ниже всей титульной части.
   */
  function buildTitleBlock(): HTMLElement {
    const node = div('pub-doc-titleblock');
    // Титульная часть — обложка/заголовок + автор-дата: угловая метка
    // позиционируется относительно неё, а не всего блока (резюме ниже).
    const titlePage = div('pub-doc-titlepage');
    const coverKind = publication?.cover_kind ?? 'none';
    if (publication !== null && coverKind !== 'none') {
      const hero = div('pub-doc-hero');
      hero.append(buildCover(publication, 'card'));
      const overlay = div('pub-doc-hero-overlay');
      overlay.append(el('h1', 'pub-doc-title', publication.title));
      if ((publication.subtitle ?? '') !== '') {
        overlay.append(el('div', 'pub-doc-subtitle', publication.subtitle ?? ''));
      }
      hero.append(overlay);
      titlePage.append(hero);
    } else {
      const box = div('pub-doc-titlebox');
      box.append(el('h1', 'pub-doc-title', publication?.title ?? ''));
      if ((publication?.subtitle ?? '') !== '') {
        box.append(el('div', 'pub-doc-subtitle', publication?.subtitle ?? ''));
      }
      titlePage.append(box);
    }
    if (publication !== null) {
      const author = displayAuthorship(publication, users.resolveUserName(publication.created_by));
      titlePage.append(
        el(
          'div',
          'pub-doc-meta',
          [author, assemblyDateLabel(publication.assembly_date)]
            .filter((x) => x !== '')
            .join(' · '),
        ),
      );
    }
    node.append(titlePage);
    // Резюме — из СВЕЖЕГО снимка публикации (а не из `assembly.publication`),
    // чтобы правка резюме в карточке редактора отражалась в титульном блоке без
    // перечитывания сборки (замечание А2 приёмки b02ef1cf). Рендер — тем же
    // общим markdown-рендерером, что и у карточки/сервера.
    const summaryHtml =
      publication !== null
        ? renderMarkdown(publication.summary_md ?? '')
        : (assembly?.publication.summary_html ?? '');
    if (summaryHtml !== '') {
      const block = div('pub-doc-summary');
      renderHtml(block, summaryHtml);
      node.append(block);
    }
    return node;
  }

  /** Выделение блока документа → мысль в карточке панели редактора (DoD). */
  function selectBlock(ev: Event, thoughtId: string): void {
    const target = ev.target as HTMLElement | null;
    if (target !== null && target.closest('a') !== null) return; // ссылка важнее
    openThought(thoughtId);
  }

  function openThought(thoughtId: string): void {
    void import('../../editor/editor.js').then((mod) => mod.openThoughtInEditor(thoughtId));
  }

  // --- Подсветка текущего раздела -----------------------------------------

  /**
   * Верх узла в системе координат прокрутки документа. `offsetTop` считается
   * от `offsetParent` (`.pub-ws-content`), а не от `docHost`, поэтому вычитаем
   * смещение самого документа — иначе видимая плашка кандидатов (сосед в
   * потоке) сдвигала бы и подсветку, и переход по якорю на свою высоту.
   */
  function topWithinDoc(node: HTMLElement): number {
    return node.offsetTop - docHost.offsetTop;
  }

  function updateCurrentSection(): void {
    const headings = docHost.querySelectorAll<HTMLElement>('.pub-doc-section');
    if (headings.length === 0) {
      currentAnchor = null;
      return;
    }
    const top = docHost.scrollTop + 24;
    let current: string | null = null;
    for (const heading of headings) {
      if (topWithinDoc(heading) <= top) current = heading.id;
      else break;
    }
    current ??= headings[0]?.id ?? null;
    // Дно документа: заголовок последнего раздела может не дойти до порога
    // (документ кончился) — подсвечиваем его явно, иначе последний раздел
    // никогда не становится текущим при прокрутке (пункт 2 ea1b5f14).
    if (docHost.scrollTop + docHost.clientHeight >= docHost.scrollHeight - 2) {
      current = headings[headings.length - 1]?.id ?? current;
    }
    if (current === currentAnchor) return;
    currentAnchor = current;
    for (const row of tocList.querySelectorAll<HTMLElement>('.pub-toc-line')) {
      row.classList.toggle('pub-toc-current', row.dataset['anchor'] === current);
    }
  }

  function scrollToAnchor(anchor: string): void {
    const node = docHost.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`);
    if (node === null) return;
    // Программная прокрутка: взводим блокировку ДО изменения scrollTop, чтобы
    // прилетевшее событие прокрутки не пересчитало current (замечание 1).
    lockScrollSync();
    docHost.scrollTop = Math.max(0, topWithinDoc(node) - 8);
    currentAnchor = anchor;
    for (const row of tocList.querySelectorAll<HTMLElement>('.pub-toc-line')) {
      row.classList.toggle('pub-toc-current', row.dataset['anchor'] === anchor);
    }
  }

  // --- Кандидаты -----------------------------------------------------------

  function renderCandidates(): void {
    emptyNode(candHost);
    const count = assembly?.publication.new_candidates ?? 0;
    candHost.classList.toggle('hidden', count <= 0);
    if (count <= 0) return;
    const plaque = uiButton({
      label: t('publications.ws.candidates', count),
      role: 'ghost',
      class: 'pub-cand-plaque',
      onClick: () => void toggleCandidates(),
    });
    candHost.append(plaque);
    if (!candidatesOpen) return;
    if (candidates === null) {
      candHost.append(loadingState());
      return;
    }
    if (candidates.items.length === 0) {
      candHost.append(emptyState({ title: t('publications.ws.candidatesEmpty') }));
      return;
    }
    const list = div('pub-cand-list');
    for (const item of candidates.items) {
      const row = div('pub-cand-row');
      const text = div('pub-cand-text');
      text.append(span(item.title, 'pub-cand-title'));
      // «Путь в дереве после вставки» (спека 43ec961f): заголовки разделов от корня.
      if (item.breadcrumbs.length > 0) {
        text.append(span(item.breadcrumbs.join(' / '), 'pub-cand-path'));
      }
      row.append(text);
      const place = uiButton({
        label: t('publications.ws.place'),
        role: 'ghost',
        onClick: () => void placeCandidate(item.thought_id),
      });
      const open = uiButton({
        label: t('publications.ws.openThought'),
        role: 'ghost',
        onClick: () => openThought(item.thought_id),
      });
      const hide = uiButton({
        label: t('publications.ws.hide'),
        role: 'ghost',
        onClick: () => void setExcluded(item.thought_id, true),
      });
      row.append(place, open, hide);
      list.append(row);
    }
    candHost.append(list);
  }

  /**
   * «Расставить (в конец)» кандидата (задача e754527d; элемент интерфейса
   * 43ec961f): сервер гасит его индивидуально и фиксирует позицию в конец;
   * клиент семантику не реплицирует — только перечитывает документ.
   */
  async function placeCandidate(thoughtId: string): Promise<void> {
    const networkId = store.state.networkId;
    if (networkId === null || publicationId === null) return;
    try {
      await etn.publications.acceptCandidate(networkId, publicationId, thoughtId);
    } catch (err) {
      errorDialog(t('publications.ws.place'), err);
      return;
    }
    reload();
  }

  async function toggleCandidates(): Promise<void> {
    const networkId = store.state.networkId;
    if (networkId === null || publicationId === null) return;
    candidatesOpen = !candidatesOpen;
    if (candidatesOpen && candidates === null) {
      renderCandidates();
      try {
        candidates = await etn.publications.candidates(networkId, publicationId, { limit: 50 });
      } catch {
        candidates = { items: [], total: 0, limit: 50, offset: 0, has_more: false };
      }
    }
    renderCandidates();
  }

  // --- Пагинация -----------------------------------------------------------

  function renderPager(): void {
    emptyNode(pagerHost);
    const meta = assembly?.meta;
    if (meta === undefined || (!meta.has_more && meta.page <= 1)) return;
    const from = (meta.page - 1) * meta.per_page + 1;
    const to = from + assembly!.sections.length - 1;
    const label = span(
      t('publications.ws.page', [from, Math.max(from, to), meta.total_roots]),
      'pub-ws-count',
    );
    const prev = uiButton({
      label: t('publications.ws.prev'),
      role: 'ghost',
      disabled: meta.page <= 1,
      onClick: () => {
        page = Math.max(1, meta.page - 1);
        void load();
      },
    });
    const next = uiButton({
      label: t('publications.ws.next'),
      role: 'ghost',
      disabled: !meta.has_more,
      onClick: () => {
        page = meta.page + 1;
        void load();
      },
    });
    pagerHost.append(prev, label, next);
  }

  // --- Исключения ----------------------------------------------------------

  async function setExcluded(thoughtId: string, excluded: boolean): Promise<void> {
    const networkId = store.state.networkId;
    if (networkId === null || publicationId === null) return;
    try {
      if (excluded) await etn.publications.addExclusion(networkId, publicationId, thoughtId);
      else await etn.publications.removeExclusion(networkId, publicationId, thoughtId);
    } catch (err) {
      errorDialog(t('publications.ws.exclude'), err);
      return;
    }
    reload();
  }

  // --- Создание раздела/текста --------------------------------------------

  /**
   * Создать раздел (структурный потомок якоря) или текст (значение свойства-
   * источника) у раздела. `anchorId` — мысль-родитель: для «подчинённого
   * раздела» — сам блок, для «раздела на этом уровне» — родитель блока
   * (может быть `null` у корневого раздела — тогда мысль создаётся без связи,
   * а промах по сборке закрывается привязкой к «Родительской мысли» отбора).
   * Тип новой мысли предзаполняется первым типом рецепта заголовков, связь — из
   * рецепта текстов; после записи проверяется вхождение мысли в сборку (промах —
   * предупреждение, не ошибка).
   */
  async function createChild(anchorId: string | null, kind: 'section' | 'text'): Promise<void> {
    const networkId = store.state.networkId;
    if (networkId === null || publicationId === null) return;
    const { pickThoughtsDialog } = await import('../../canvas/add-dialog.js');
    const recipeTypes = publicationTypeIds();
    let linkProperty: { rows: ReturnType<typeof buildPropertyListRows> } | undefined;
    // Первое свойство-источник текстов: выбранная/созданная мысль добавляется
    // в его значение, даже если в диалоге свойство не подтвердили (карточка
    // ea1b5f14, пункт 3). Пользователь может выбрать другое свойство явно.
    let textDefaultPick: { propertyId: string; key: string } | null = null;
    if (kind === 'text') {
      const sources = publication?.text_sources ?? [];
      if (sources.length === 0) {
        notice(t('publications.ws.noTextSources'), 'error');
        return;
      }
      const rows = await loadPropertyRows(networkId);
      const listRows = buildPropertyListRows(rows, store.state.linkTypes).filter(
        (row) => !row.structural && row.valueType === 'link' && sources.includes(row.propertyId),
      );
      if (listRows.length === 0) {
        notice(t('publications.ws.noTextSources'), 'error');
        return;
      }
      linkProperty = { rows: listRows };
      // Берём сторону-ИСТОЧНИК (раздел — владелец текста): у свойства-связи
      // две строки сторон, и только source-строка добавляет ребро от раздела.
      const first = listRows.find((row) => row.side === 'source') ?? listRows[0];
      if (first !== undefined) textDefaultPick = { propertyId: first.propertyId, key: first.name };
    }
    const result = await pickThoughtsDialog({
      networkId,
      ...(anchorId !== null
        ? { anchor: { id: anchorId, direction: 'child' as const } }
        : {}),
      allowCreate: true,
      allowLinkType: false,
      ...(linkProperty !== undefined ? { linkProperty } : {}),
      // Тип раздела предзаполняется из рецепта (мысль обязана удовлетворять
      // отбору разделов). Для ТЕКСТА тип не подставляем: иначе текст получил бы
      // тип раздела и сам попал в разделы публикации (ea1b5f14, пункт 3).
      defaultNewThoughtTypeId: kind === 'section' ? (recipeTypes[0] ?? null) : null,
      title: kind === 'section' ? t('publications.ws.createSection') : t('publications.ws.createText'),
      applyLabel:
        kind === 'section' ? t('publications.ws.createSection') : t('publications.ws.createText'),
    });
    if (result === null) return;
    // Для текста свойство-источник берём из выбора в диалоге, а если его не
    // подтвердили — первое свойство текстов публикации (карточка ea1b5f14).
    const effectivePick = kind === 'text' ? (result.linkProperty ?? textDefaultPick) : result.linkProperty;
    const createdIds: string[] = [];
    try {
      for (const item of result.items) {
        const thoughtId =
          item.kind === 'existing'
            ? item.id
            : (
                await etn.thoughts.create(networkId, {
                  title: item.title,
                  synonyms: item.synonyms,
                  type_id: result.thoughtTypeId,
                  ...(kind === 'section' && anchorId !== null && result.linkProperty === null
                    ? {
                        create_link: {
                          direction: 'parent' as const,
                          target_thought_id: anchorId,
                          type_id: result.linkTypeId,
                        },
                      }
                    : {}),
                })
              ).id;
        if (kind === 'section') {
          if (item.kind === 'existing' && anchorId !== null && result.linkProperty === null) {
            throwOnFailures(
              await ensureLink(networkId, anchorId, thoughtId, result.linkTypeId),
            );
          }
        } else if (effectivePick !== null && anchorId !== null) {
          await addPropertyValue(networkId, anchorId, effectivePick, thoughtId);
        }
        createdIds.push(thoughtId);
      }
    } catch (err) {
      errorDialog(t('publications.ws.createSection'), err);
      return;
    }
    await load();
    // Проверка вхождения: мысль под рецепт, не попавшая в сборку, помечается
    // предупреждением (не ошибкой) — как «промах» расстановки.
    const known = new Set<string>();
    if (assembly !== null) {
      for (const item of flattenSections(assembly.sections)) {
        known.add(item.section.thought_id);
        for (const text of item.section.texts) known.add(text.thought_id);
      }
    }
    const missed = createdIds.filter((id) => !known.has(id));
    if (missed.length === 0) return;
    // Соответствовать отбору своими свойствами не вышло — созданную мысль
    // привязываем под «Родительскую мысль» отбора, чтобы она вошла в разделы
    // (карточка ea1b5f14, пункт 3). Промах, который так не закрыть, —
    // предупреждение, не ошибка.
    const recipeParents = publicationParentIds();
    if (kind === 'section' && recipeParents.length > 0) {
      try {
        for (const id of missed) {
          throwOnFailures(await setOnlyParents(networkId, id, [recipeParents[0]!], null));
        }
        await load();
        return;
      } catch (err) {
        errorDialog(t('publications.ws.createSection'), err);
      }
    }
    notice(t('publications.ws.createMiss'), 'error');
  }

  /** Типы мыслей из рецепта заголовков публикации (для предзаполнения). */
  function publicationTypeIds(): string[] {
    if (publication?.title_recipe == null) return [];
    return parseFilterDefinition(publication.title_recipe).typeIds;
  }

  /** Корневые мысли отбора разделов (`parent_ids`) — «Родительская мысль». */
  function publicationParentIds(): string[] {
    if (publication?.title_recipe == null) return [];
    return parseFilterDefinition(publication.title_recipe).parentIds;
  }

  /** Добавляет мысль значением свойства-связи владельца (аддитивно). */
  async function addPropertyValue(
    networkId: string,
    ownerId: string,
    pick: { propertyId: string; key: string },
    targetId: string,
  ): Promise<void> {
    let existing: string[] = [];
    try {
      const values = await etn.properties.get(networkId, 'thought', ownerId);
      // Свойство-связь вне цепочки типа отдаётся с `property_id: ''` — сверяем
      // по id И по имени стороны, иначе существующие значения теряются при
      // добавлении (блокер 2 верификации ea1b5f14).
      const entry = values.find(
        (v): v is LinkPropertyValues => 'values' in v && linkEntryMatchesPick(v, pick),
      );
      if (entry !== undefined) {
        existing = entry.values.map((it) => it.target_id);
      }
    } catch {
      existing = [];
    }
    const targets = existing.includes(targetId) ? existing : [...existing, targetId];
    await etn.properties.set(networkId, 'thought', ownerId, pick.key, targets);
  }

  // --- Публичный дескриптор ------------------------------------------------

  async function open(id: string, target?: PublicationOpenTarget): Promise<void> {
    const samePublication = publicationId === id;
    if (!samePublication) {
      candidates = null;
      candidatesOpen = false;
      collapsed.clear();
    }
    // Открытие — свежая сборка: устаревание сбрасывается (пересборка/открытие).
    staleRebuild = false;
    page = resolveOpenPage(page, samePublication, target);
    publicationId = id;
    retargetWorkspaceKeys();
    root.classList.remove('hidden');
    // Ширина текста — из персональных настроек при каждом открытии (пункт 5).
    applyTextWidth(opts.getTextWidth());
    await load();
    if (target?.anchor !== undefined) scrollToAnchor(target.anchor);
  }

  function isOpen(id?: string): boolean {
    if (publicationId === null) return false;
    return id === undefined || id === publicationId;
  }

  function close(): void {
    publicationId = null;
    root.classList.add('hidden');
  }

  function destroy(): void {
    if (reloadTimer !== null) window.clearTimeout(reloadTimer);
    if (scrollSyncTimer !== null) window.clearTimeout(scrollSyncTimer);
    workspaceLayerUnsub();
    editorHighlightUnsub();
    docHost.removeEventListener('scroll', onDocScroll);
    docHost.removeEventListener('keydown', onDocKeydown, { capture: true });
    document.removeEventListener('keydown', onKeydown);
    docNav.destroy();
    docDrag.destroy();
    tocNav.destroy();
    tocDrag.destroy();
    publicationId = null;
    publication = null;
    assembly = null;
    root.remove();
  }

  // Начальное состояние: контейнеры пусты, документ скрыт до открытия.
  renderState();

  return {
    open,
    close,
    reload,
    applyCommentRealtime,
    applyThoughtRealtime,
    applyPublicationPatch,
    markRebuildStale,
    applyRebuildRealtime,
    applyPublication,
    isOpen,
    destroy,
  };
}

/** Есть ли мысль в текущей сборке (раздел-предисловие или текст раздела). */
function assemblyHasThought(assembly: PublicationAssembly, thoughtId: string): boolean {
  for (const item of flattenSections(assembly.sections)) {
    if (item.section.thought_id === thoughtId) return true;
    for (const text of item.section.texts) {
      if (text.thought_id === thoughtId) return true;
    }
  }
  return false;
}

/** Удаляет всех детей узла (полная пересборка не-списковых слотов разрешена). */
function emptyNode(node: HTMLElement): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

/** Заменяет иконку кнопки-фасада (переключатель панели оглавления). */
function setButtonIcon(button: HTMLButtonElement, name: IconName): void {
  const icon = button.querySelector('svg');
  if (icon !== null) icon.replaceWith(svgIcon(name));
}

/** Меняет подсказку и `aria-label` иконочной кнопки (прелоадер пересборки). */
function setButtonTitle(button: HTMLButtonElement, title: string): void {
  button.title = title;
  button.setAttribute('aria-label', title);
}

/** Тег заголовка раздела: уровень сборки 1 → `h2` (титул занимает `h1`). */
function headingTag(level: number): 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
  const n = Math.min(6, Math.max(1, level + 1));
  return `h${n}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
}
