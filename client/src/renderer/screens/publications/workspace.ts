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
 * `renderHtml` (тот же приём, что у серверных сниппетов). Правка контента — не
 * инлайн: выделение блока открывает мысль в карточке панели редактора
 * (`openThoughtInEditor`), а живое обновление документа идёт по realtime.
 *
 * Списки (оглавление, документ, состояния) обновляются инкрементально
 * (`reconcileKeyed` — стандарт «Списки рендерятся инкрементально»); разметка —
 * фасады `lib/ui` и `lib/dialog`, строки — из словаря `t()`.
 */

import type {
  Publication,
  PublicationAssembly,
  PublicationCandidatesResult,
  PublicationOrderItem,
} from '@etn/shared';

import {
  el,
  div,
  span,
  renderHtml,
  setTooltip,
} from '../../lib/dom.js';
import { t } from '../../lib/i18n.js';
import { etn } from '../../lib/etn.js';
import { svgIcon } from '../../lib/icons.js';
import { errorDialog, isInsideDialog } from '../../lib/dialog.js';
import { notice } from '../../lib/notice.js';
import {
  MENU_SEPARATOR,
  menuAction,
  showMenuAt,
  type MenuItem,
} from '../../lib/menu.js';
import { uiButton, iconButton } from '../../lib/ui/button.js';
import { emptyState, errorState, loadingState } from '../../lib/ui/empty-state.js';
import { reconcileKeyed } from '../../lib/ui/keyed-list.js';
import { preserveScroll } from '../../lib/ui/scroll-anchor.js';
import { buildCover } from './cover.js';
import {
  assemblyDateLabel,
  blockSignature,
  displayAuthorship,
  documentBlocks,
  flattenSections,
  positionsFor,
  reorderIds,
  siblingNodeKeys,
  tocLines,
  tocSignature,
  type DocBlock,
  type TocLine,
} from './model.js';
import { loadPropertyRows } from './recipe.js';
import { buildPropertyListRows } from '../../lib/property-list.js';
import { ensureLink, throwOnFailures } from '../../lib/link-ops.js';
import { parseFilterDefinition } from '../../lib/filter-builder.js';
import * as users from '../../lib/users.js';
import { store } from '../../state.js';

/** Внешние точки входа рабочей области (связь с экраном «Публикации»). */
export interface PublicationWorkspaceOptions {
  /** Закрыть рабочую область и вернуться в библиотеку. */
  onClose: () => void;
  /** Открыть карточку публикации в панели редактора. */
  onSettings: (publicationId: string) => void;
  /** Экспортировать документ (меню формата → джоба) — механика библиотеки. */
  onExport: (publicationId: string, ev: MouseEvent) => void;
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

/**
 * Модель выбора страницы при открытии (чистая — юнит-тест): заданный
 * `target.page > 1` побеждает; иначе та же публикация сохраняет текущую
 * страницу (переоткрытие не сбрасывает листание), другая — открывается с
 * первой.
 */
export function resolveOpenPage(
  currentPage: number,
  samePublication: boolean,
  target?: PublicationOpenTarget,
): number {
  if (target?.page !== undefined && target.page > 1) return target.page;
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
  let draggingKey: string | null = null;
  let draggingParent: string | null = null;

  const root = div('pub-ws hidden');
  const header = div('pub-ws-header');
  const toc = div('pub-toc');
  const content = div('pub-ws-content');
  const candHost = div('pub-cand');
  const docHost = div('pub-doc');
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
  const titleText = el('h1', 'pub-ws-title');
  const subtitleText = div('pub-ws-subtitle');
  const metaText = div('pub-ws-meta');
  titleBox.append(titleText, subtitleText, metaText);
  const actions = div('pub-ws-actions');
  const settingsButton = uiButton({
    label: t('publications.ws.settings'),
    role: 'ghost',
    onClick: () => {
      if (publicationId !== null) opts.onSettings(publicationId);
    },
  });
  const rebuildButton = uiButton({
    label: t('publications.ws.rebuild'),
    role: 'ghost',
    onClick: () => void rebuild(),
  });
  const exportButton = uiButton({
    label: t('publications.ws.export'),
    role: 'ghost',
    onClick: (ev) => {
      if (publicationId !== null) opts.onExport(publicationId, ev);
    },
  });
  actions.append(settingsButton, rebuildButton, exportButton);
  header.append(backButton, coverBox, titleBox, div('pub-spacer'), actions);

  // --- Оглавление ----------------------------------------------------------

  const tocHead = div('pub-toc-head');
  const tocToggle = iconButton({
    icon: svgIcon('chevron-down'),
    title: t('publications.ws.toc'),
    role: 'ghost',
    onClick: () => {
      tocCollapsed.value = !tocCollapsed.value;
      root.classList.toggle('pub-toc-collapsed', tocCollapsed.value);
      tocToggle.title = tocCollapsed.value
        ? t('publications.ws.tocExpand')
        : t('publications.ws.tocCollapse');
    },
  });
  tocHead.append(tocToggle, span(t('publications.ws.toc'), 'pub-toc-title'));
  const tocList = div('pub-toc-list');
  toc.append(tocHead, tocList);

  // --- Слушатели -----------------------------------------------------------

  const onDocScroll = (): void => {
    updateCurrentSection();
  };
  const onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    if (publicationId === null) return;
    // Открытый диалог перехватывает Esc сам (каркас lib/dialog закрывается).
    if (isInsideDialog(document.activeElement)) return;
    opts.onClose();
  };
  docHost.addEventListener('scroll', onDocScroll);
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
      loading = false;
      candidates = null;
      candidatesOpen = false;
      renderHeader();
      renderToc();
      renderDocument();
      renderCandidates();
      renderPager();
      renderState();
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

  async function rebuild(): Promise<void> {
    const networkId = store.state.networkId;
    if (networkId === null || publicationId === null) return;
    try {
      await etn.publications.rebuild(networkId, publicationId);
    } catch (err) {
      errorDialog(t('publications.ws.rebuild'), err);
      return;
    }
    reload();
  }

  // --- Рендер шапки --------------------------------------------------------

  function renderHeader(): void {
    if (publication === null) return;
    titleText.textContent = publication.title;
    subtitleText.textContent = publication.subtitle ?? '';
    const author = displayAuthorship(publication, users.resolveUserName(publication.created_by));
    metaText.textContent = [author, assemblyDateLabel(publication.assembly_date)]
      .filter((part) => part !== '')
      .join(' · ');
    emptyNode(coverBox);
    coverBox.append(buildCover(publication, 'thumb'));
  }

  // --- Рендер состояний ----------------------------------------------------

  function renderState(): void {
    emptyNode(stateHost);
    stateHost.classList.toggle('hidden', !loading && loadError === null);
    docHost.classList.toggle('hidden', loading || loadError !== null);
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
    }
  }

  // --- Оглавление ----------------------------------------------------------

  function renderToc(): void {
    const lines = tocLines(assembly, collapsed, (index) => t('publications.ws.text', index));
    reconcileKeyed<TocLine>(tocList, lines, {
      key: (line) => line.key,
      build: (line) => buildTocLine(line),
      update: (node, line) => updateTocLine(node, line),
      equals: (a, b) => tocSignature(a) === tocSignature(b),
    });
  }

  function buildTocLine(line: TocLine): HTMLElement {
    const node = div('pub-toc-line');
    node.dataset['key'] = line.key;
    if (line.kind === 'section') {
      node.dataset['anchor'] = line.anchor;
      node.dataset['thoughtId'] = line.thoughtId;
      node.style.paddingLeft = `${line.depth}rem`;
      node.draggable = true;
      node.classList.add('pub-toc-draggable');
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
      node.append(caret, span(line.label, 'pub-toc-label'));
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
    } else if (line.kind === 'text') {
      node.dataset['anchor'] = line.anchor;
      node.dataset['thoughtId'] = line.thoughtId;
      node.style.paddingLeft = `${line.depth}rem`;
      node.classList.add('pub-toc-text');
      node.append(span(line.label, 'pub-toc-label'));
      wireTocSection(node, line);
    } else {
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

  function toggleCollapsed(thoughtId: string): void {
    if (collapsed.has(thoughtId)) collapsed.delete(thoughtId);
    else collapsed.add(thoughtId);
    renderToc();
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
    if (line.kind === 'section') {
      node.addEventListener('dragstart', (ev) => {
        draggingKey = line.nodeKey;
        draggingParent = line.parentThoughtId;
        ev.dataTransfer?.setData('text/plain', line.nodeKey);
      });
      node.addEventListener('dragend', () => {
        draggingKey = null;
        draggingParent = null;
      });
      node.addEventListener('dragover', (ev) => {
        // Переставляем только внутри одной группы соседей (разделы одного
        // родителя) — иначе изменился бы не порядок, а структура.
        if (draggingKey === null || draggingKey === line.nodeKey) return;
        if (draggingParent !== line.parentThoughtId) return;
        ev.preventDefault();
        node.classList.add('pub-toc-drop');
      });
      node.addEventListener('dragleave', () => node.classList.remove('pub-toc-drop'));
      node.addEventListener('drop', (ev) => {
        ev.preventDefault();
        node.classList.remove('pub-toc-drop');
        if (draggingKey === null || draggingParent !== line.parentThoughtId) return;
        void moveSibling(draggingKey, line.nodeKey, line.parentThoughtId);
      });
    }
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

  /** Перенос раздела перед соседом в пределах одной группы (PUT order, батч). */
  async function moveSibling(
    movedKey: string,
    beforeKey: string,
    parentThoughtId: string | null,
  ): Promise<void> {
    const networkId = store.state.networkId;
    if (networkId === null || publicationId === null || assembly === null) return;
    const flat = flattenSections(assembly.sections);
    const keys = siblingNodeKeys(flat, parentThoughtId);
    const next = reorderIds(keys, movedKey, beforeKey);
    if (next.join(',') === keys.join(',')) return;
    const items: PublicationOrderItem[] = positionsFor(next);
    try {
      await etn.publications.setOrder(networkId, publicationId, items);
    } catch (err) {
      errorDialog(t('publications.ws.toc'), err);
      return;
    }
    reload();
  }

  // --- Документ ------------------------------------------------------------

  function renderDocument(): void {
    const blocks = documentBlocks(assembly, publication);
    preserveScroll(docHost, () => {
      reconcileKeyed<DocBlock>(docHost, blocks, {
        key: (block) => block.key,
        build: (block) => buildBlock(block),
        update: (node, block) => updateBlock(node, block),
        equals: (a, b) => blockSignature(a) === blockSignature(b),
      });
    });
    updateCurrentSection();
  }

  function buildBlock(block: DocBlock): HTMLElement {
    if (block.kind === 'title') return buildTitleBlock();
    if (block.kind === 'section') {
      const node = div('pub-doc-section');
      node.id = block.domId;
      node.dataset['thoughtId'] = block.thoughtId;
      const heading = el(headingTag(block.level), 'pub-doc-heading');
      heading.textContent = block.heading;
      heading.dataset['thoughtId'] = block.thoughtId;
      if (block.repeat) heading.classList.add('pub-doc-repeat');
      node.append(heading);
      if (block.preambleHtml !== '') {
        const preamble = div('pub-doc-preamble');
        preamble.dataset['thoughtId'] = block.thoughtId;
        renderHtml(preamble, block.preambleHtml);
        node.append(preamble);
      }
      node.addEventListener('click', (ev) => selectBlock(ev, block.thoughtId));
      return node;
    }
    if (block.kind === 'text') {
      const node = div('pub-doc-text');
      node.id = block.domId;
      node.dataset['thoughtId'] = block.thoughtId;
      renderHtml(node, block.html);
      node.addEventListener('click', (ev) => selectBlock(ev, block.thoughtId));
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
   * слушатели на самом узле (выделение раздела) остаются.
   */
  function updateBlock(node: HTMLElement, block: DocBlock): void {
    const fresh = buildBlock(block);
    emptyNode(node);
    while (fresh.firstChild !== null) node.append(fresh.firstChild);
  }

  function buildTitleBlock(): HTMLElement {
    const node = div('pub-doc-titleblock');
    const head = div('pub-doc-titlehead');
    if (publication !== null) head.append(buildCover(publication, 'thumb'));
    const box = div('pub-doc-titlebox');
    box.append(el('h1', 'pub-doc-title', publication?.title ?? ''));
    if ((publication?.subtitle ?? '') !== '') {
      box.append(el('div', 'pub-doc-subtitle', publication?.subtitle ?? ''));
    }
    if (publication !== null) {
      const author = displayAuthorship(publication, users.resolveUserName(publication.created_by));
      box.append(
        el(
          'div',
          'pub-doc-meta',
          [author, assemblyDateLabel(publication.assembly_date)]
            .filter((x) => x !== '')
            .join(' · '),
        ),
      );
    }
    head.append(box);
    node.append(head);
    const summary = assembly?.publication.summary_html ?? '';
    if (summary !== '') {
      const block = div('pub-doc-summary');
      renderHtml(block, summary);
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
    if (current === currentAnchor) return;
    currentAnchor = current;
    for (const row of tocList.querySelectorAll<HTMLElement>('.pub-toc-line')) {
      row.classList.toggle('pub-toc-current', row.dataset['anchor'] === current);
    }
  }

  function scrollToAnchor(anchor: string): void {
    const node = docHost.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`);
    if (node === null) return;
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
      row.append(span(item.title, 'pub-cand-title'));
      const open = uiButton({
        label: t('publications.ws.openThought'),
        role: 'ghost',
        onClick: () => openThought(item.thought_id),
      });
      const hide = uiButton({
        label: t('publications.ws.exclude'),
        role: 'ghost',
        onClick: () => void setExcluded(item.thought_id, true),
      });
      row.append(open, hide);
      list.append(row);
    }
    candHost.append(list);
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
   * Создать раздел (структурный потомок) или текст (значение свойства-источника)
   * у раздела. Тип новой мысли предзаполняется первым типом рецепта заголовков,
   * связь — из рецепта текстов; после записи проверяется вхождение мысли в
   * сборку (промах — предупреждение, не ошибка).
   */
  async function createChild(sectionThoughtId: string, kind: 'section' | 'text'): Promise<void> {
    const networkId = store.state.networkId;
    if (networkId === null || publicationId === null) return;
    const { pickThoughtsDialog } = await import('../../canvas/add-dialog.js');
    const recipeTypes = publicationTypeIds();
    let linkProperty: { rows: ReturnType<typeof buildPropertyListRows> } | undefined;
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
    }
    const result = await pickThoughtsDialog({
      networkId,
      anchor: { id: sectionThoughtId, direction: 'child' },
      allowCreate: true,
      allowLinkType: false,
      ...(linkProperty !== undefined ? { linkProperty } : {}),
      defaultNewThoughtTypeId: recipeTypes[0] ?? null,
      title: kind === 'section' ? t('publications.ws.createSection') : t('publications.ws.createText'),
      applyLabel:
        kind === 'section' ? t('publications.ws.createSection') : t('publications.ws.createText'),
    });
    if (result === null) return;
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
                  ...(kind === 'section' && result.linkProperty === null
                    ? {
                        create_link: {
                          direction: 'parent' as const,
                          target_thought_id: sectionThoughtId,
                          type_id: result.linkTypeId,
                        },
                      }
                    : {}),
                })
              ).id;
        if (kind === 'section') {
          if (item.kind === 'existing' && result.linkProperty === null) {
            throwOnFailures(
              await ensureLink(networkId, sectionThoughtId, thoughtId, result.linkTypeId),
            );
          }
        } else if (result.linkProperty !== null) {
          await addPropertyValue(networkId, sectionThoughtId, result.linkProperty, thoughtId);
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
    if (createdIds.some((id) => !known.has(id))) notice(t('publications.ws.createMiss'), 'error');
  }

  /** Типы мыслей из рецепта заголовков публикации (для предзаполнения). */
  function publicationTypeIds(): string[] {
    if (publication?.title_recipe == null) return [];
    return parseFilterDefinition(publication.title_recipe).typeIds;
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
      const entry = values.find((v) => 'values' in v && v.property_id === pick.propertyId);
      if (entry !== undefined && 'values' in entry) {
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
    page = resolveOpenPage(page, samePublication, target);
    publicationId = id;
    root.classList.remove('hidden');
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
    docHost.removeEventListener('scroll', onDocScroll);
    document.removeEventListener('keydown', onKeydown);
    publicationId = null;
    publication = null;
    assembly = null;
    root.remove();
  }

  // Начальное состояние: контейнеры пусты, документ скрыт до открытия.
  renderState();

  return { open, close, reload, isOpen, destroy };
}

/** Удаляет всех детей узла (полная пересборка не-списковых слотов разрешена). */
function emptyNode(node: HTMLElement): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

/** Тег заголовка раздела: уровень сборки 1 → `h2` (титул занимает `h1`). */
function headingTag(level: number): 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
  const n = Math.min(6, Math.max(1, level + 1));
  return `h${n}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
}
