/**
 * Мини-граф редактора (задача 8ab775d9, единая модель связей).
 *
 * В стиле Obsidian: центральный узел — редактируемая мысль, вокруг — все
 * мысли, до которых из центра доходит одно ребро любого типа (структурное
 * «Родители»/«Потомки» или типизированное свойство-связь, оба направления).
 * Линии — тонкие, с подписью прямого имени типа связи от центра.
 *
 * Массовые связи (>=10 одинакового типа к одной цели) скрываются за чипом
 * «+N». Колесо мыши — зум, правая кнопка — панорамирование холста,
 * Ctrl+hover — предпросмотр (как на основной карте).
 *
 * Реализация намеренно упрощённая: позиции периферийных узлов — по кругу
 * вокруг центра; физики нет. На больших графах (>40 соседей) часть соседей
 * выводится за порог через чип «+N ещё».
 */

import type { Link, Thought } from '@etn/shared';

import { button, div, el, setTooltip, span } from '../lib/dom.js';
import { svgIcon } from '../lib/icons.js';
import { showMenuAt, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';

/** Mass-link threshold: ≥10 ребер одного типа к одной цели скрываются за чипом. */
const MASS_LINK_THRESHOLD = 10;

/** Скрываем периферийных соседей, если их больше этого числа. */
const PERIPHERY_CAP = 40;

export interface MiniGraphOptions {
  /** Текущая редактируемая мысль. */
  thought: Thought;
  /** Прямые соседи редактируемой мысли — минимально нужные id + title. */
  neighbours: Array<{ id: string; title: string }>;
  /** Связи текущей мысли (нужны для подписей рёбер и определения типа). */
  links: Link[];
  /** Соседи с массовыми связями: id цели → { hidden: number, label: string }. */
  mass: Map<string, { hidden: number; label: string }>;
}

/** Итоговая модель узла для отрисовки. */
interface NodePos {
  id: string;
  title: string;
  /** Угол на окружности (для периферийных), радианы. */
  angle: number;
  /** Расстояние от центра (для центра = 0). */
  radius: number;
  /** Для центра: true. */
  center: boolean;
}

/** Ребро для отрисовки. */
interface EdgeDraw {
  from: string;
  to: string;
  label: string;
}

/**
 * Рисует мини-граф. Возвращает корневой DOM-узел. Все интерактивы
 * (клик/двойной клик/правый клик/колесо/Ctrl+hover) навешиваются
 * внутри; внешний код не должен ими управлять.
 */
export function buildMiniGraph(opts: MiniGraphOptions): HTMLElement {
  const root = div('mini-graph');
  // Виджет «больше нет, скрыто» — для центрального облачка + периферии.
  const center = opts.thought;

  // Построим плоский список узлов: центр + до PERIPHERY_CAP соседей; остальное
  // показываем как «+N ещё».
  const totalNeighbours = opts.neighbours.length;
  const visibleNeighbours = opts.neighbours.slice(0, PERIPHERY_CAP);
  const hiddenNeighbours = totalNeighbours - visibleNeighbours.length;

  const nodes: NodePos[] = [];
  nodes.push({ id: center.id, title: center.title, angle: 0, radius: 0, center: true });
  const cx = 220;
  const cy = 160;
  const r = 110;
  visibleNeighbours.forEach((nb, i) => {
    const angle = (2 * Math.PI * i) / Math.max(visibleNeighbours.length, 1);
    nodes.push({
      id: nb.id,
      title: nb.title,
      angle,
      radius: r,
      center: false,
    });
  });

  // Сборка рёбер: для каждого видимого соседа возьмём все связи с ним.
  const edges: EdgeDraw[] = [];
  const linkTypeNames = store.state.linkTypes;
  for (const nb of visibleNeighbours) {
    const between = opts.links.filter((l) => l.target_id === nb.id || l.source_id === nb.id);
    if (between.length === 0) {
      // Сосед есть, а рёбер в `links` нет (например, родительские/дочерние
      // связи в `neighbours` без полной выборки ребра) — рисуем безымянное
      // ребро, чтобы пользователь видел связь.
      edges.push({ from: center.id, to: nb.id, label: '' });
      continue;
    }
    for (const link of between) {
      const type = linkTypeNames.find((t) => t.id === link.type_id);
      const nameForward = type?.name_forward ?? '';
      const nameReverse = type?.name_reverse ?? '';
      // Прямое имя от центра к периферии: link.source_id — это id центра
      // (или нет, тогда центр наоборот).
      const isCenterSource = link.source_id === center.id;
      const label = isCenterSource ? nameForward : nameReverse;
      edges.push({ from: center.id, to: nb.id, label });
    }
  }

  // SVG-холст с линиями + DOM-узлы поверх (для интерактива и стилей).
  const canvas = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
  canvas.setAttribute('class', 'mini-graph-canvas');
  canvas.setAttribute('viewBox', `0 0 440 320`);
  canvas.setAttribute('width', '100%');
  canvas.setAttribute('height', '100%');
  // Слои для линий и для предпросмотра.
  const edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  edgeLayer.setAttribute('class', 'mini-graph-edges');
  const previewLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  previewLayer.setAttribute('class', 'mini-graph-preview');
  canvas.append(edgeLayer, previewLayer);

  // Точки узлов (используются для расчёта координат).
  const nodePos = new Map<string, { x: number; y: number }>();
  nodePos.set(center.id, { x: cx, y: cy });
  for (const n of nodes) {
    if (n.center) continue;
    nodePos.set(n.id, { x: cx + r * Math.cos(n.angle), y: cy + r * Math.sin(n.angle) });
  }

  for (const edge of edges) {
    const a = nodePos.get(edge.from);
    const b = nodePos.get(edge.to);
    if (a === undefined || b === undefined) continue;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(b.x));
    line.setAttribute('y2', String(b.y));
    line.setAttribute('class', 'mini-graph-edge');
    edgeLayer.append(line);
    if (edge.label !== '') {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String(mx));
      text.setAttribute('y', String(my - 4));
      text.setAttribute('class', 'mini-graph-edge-label');
      text.setAttribute('text-anchor', 'middle');
      text.textContent = edge.label;
      edgeLayer.append(text);
    }
  }

  // DOM-узлы поверх SVG.
  const nodesLayer = div('mini-graph-nodes');
  for (const n of nodes) {
    const pos = nodePos.get(n.id);
    if (pos === undefined) continue;
    const cloud = n.center
      ? div('mini-graph-cloud mini-graph-cloud-center')
      : div('mini-graph-cloud');
    cloud.style.left = `${pos.x}px`;
    cloud.style.top = `${pos.y}px`;
    const labelEl = n.center
      ? el('span', 'mini-graph-cloud-title mini-graph-cloud-title-center', n.title)
      : el('span', 'mini-graph-cloud-title', n.title);
    cloud.append(labelEl);
    wireCloudInteractions(cloud, n.id, n.center);
    nodesLayer.append(cloud);
  }

  // Чип «+N ещё», если есть скрытые соседи.
  if (hiddenNeighbours > 0) {
    const more = div('mini-graph-more');
    more.append(span(`+${hiddenNeighbours} ещё`, 'mini-graph-more-label'));
    setTooltip(more, `Скрыто соседей: ${hiddenNeighbours}`);
    nodesLayer.append(more);
  }

  // Чипы «+N» для массовых связей — привязаны к соответствующему узлу.
  for (const nb of visibleNeighbours) {
    const mass = opts.mass.get(nb.id);
    if (mass === undefined) continue;
    const pos = nodePos.get(nb.id);
    if (pos === undefined) continue;
    const chip = div('mini-graph-mass-chip');
    chip.append(span(`+${mass.hidden}`, 'mini-graph-mass-label'));
    setTooltip(chip, `${mass.label}: ещё ${mass.hidden} связей`);
    chip.style.left = `${pos.x + 30}px`;
    chip.style.top = `${pos.y - 18}px`;
    nodesLayer.append(chip);
  }

  canvas.addEventListener('wheel', (event) => {
    // Колесо — зум. Упрощённо: меняем viewBox.
    event.preventDefault();
    const current = canvas.getAttribute('viewBox') ?? '0 0 440 320';
    const parts = current.split(/\s+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return;
    const scale = event.deltaY > 0 ? 1.1 : 0.9;
    const newW = parts[2]! * scale;
    const newH = parts[3]! * scale;
    const newX = parts[0]! + (parts[2]! - newW) / 2;
    const newY = parts[1]! + (parts[3]! - newH) / 2;
    canvas.setAttribute('viewBox', `${newX} ${newY} ${newW} ${newH}`);
  }, { passive: false });

  // Правая кнопка — панорамирование. Реализация упрощённая: тянем viewBox.
  let panning = false;
  let panStart = { x: 0, y: 0 };
  let viewBoxStart = { x: 0, y: 0, w: 440, h: 320 };
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('mousedown', (event) => {
    if (event.button !== 2) return;
    panning = true;
    panStart = { x: event.clientX, y: event.clientY };
    const parts = (canvas.getAttribute('viewBox') ?? '0 0 440 320').split(/\s+/).map(Number);
    if (parts.length === 4 && !parts.some((n) => Number.isNaN(n))) {
      viewBoxStart = { x: parts[0]!, y: parts[1]!, w: parts[2]!, h: parts[3]! };
    }
    event.preventDefault();
  });
  window.addEventListener('mousemove', (event) => {
    if (!panning) return;
    const dx = ((event.clientX - panStart.x) * viewBoxStart.w) / canvas.clientWidth;
    const dy = ((event.clientY - panStart.y) * viewBoxStart.h) / canvas.clientHeight;
    canvas.setAttribute(
      'viewBox',
      `${viewBoxStart.x - dx} ${viewBoxStart.y - dy} ${viewBoxStart.w} ${viewBoxStart.h}`,
    );
  });
  window.addEventListener('mouseup', () => {
    panning = false;
  });

  // Контейнер с прокруткой, чтобы узлы не выходили за края при панорамировании.
  const viewport = div('mini-graph-viewport');
  viewport.append(canvas, nodesLayer);

  // Ctrl+hover на узле — предпросмотр (как на основной карте).
  nodesLayer.addEventListener('mouseover', async (event) => {
    if (!event.ctrlKey) return;
    const target = event.target as HTMLElement | null;
    if (target === null) return;
    const cloud = target.closest('.mini-graph-cloud') as HTMLElement | null;
    if (cloud === null) return;
    const id = cloud.dataset.thoughtId;
    if (id === undefined) return;
    const networkId = store.state.networkId;
    if (networkId === null) return;
    try {
      const { markThoughtCommentPreview } = await import('../lib/hover-preview.js');
      const t = await (await import('../lib/etn.js')).etn.thoughts.get(networkId, id);
      markThoughtCommentPreview(cloud, t.id, t.title);
    } catch {
      // нет связного превью — игнор
    }
  });

  root.append(viewport);

  // Шапка со счётчиками: «соседей N» / «скрыто массовых M».
  const header = div('mini-graph-header');
  header.append(span(`соседей: ${totalNeighbours}`, 'mini-graph-header-stat'));
  if (opts.mass.size > 0) {
    const hiddenMass = [...opts.mass.values()].reduce((s, m) => s + m.hidden, 0);
    header.append(
      span(` · скрыто массовых: ${hiddenMass}`, 'mini-graph-header-stat'),
    );
  }
  root.append(header);
  // Подвал с подсказкой.
  const hint = div('mini-graph-hint muted');
  hint.textContent =
    'Колесо — зум, правая кнопка — панорама. Ctrl+hover — предпросмотр.';
  root.append(hint);

  return root;
}

/** Навешивает клик/dblclick/contextmenu/keyboard на узел мини-графа. */
function wireCloudInteractions(cloud: HTMLElement, id: string, center: boolean): void {
  cloud.dataset.thoughtId = id;
  cloud.tabIndex = 0;
  cloud.setAttribute('role', 'button');
  cloud.setAttribute(
    'aria-label',
    center ? `Редактируемая мысль: ${cloud.textContent ?? ''}` : `Сосед: ${cloud.textContent ?? ''}`,
  );
  cloud.addEventListener('click', (event) => {
    event.preventDefault();
    void openLinkRefInEditor(id);
  });
  cloud.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void focusLinkRef(id);
  });
  cloud.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    void showCloudContextMenu(id, cloud);
  });
  cloud.addEventListener('keydown', (event) => {
    if (event.key === 'F10' && event.shiftKey) {
      event.preventDefault();
      void showCloudContextMenu(id, cloud);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void openLinkRefInEditor(id);
    } else if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      void focusLinkRef(id);
    }
  });
}

async function openLinkRefInEditor(id: string): Promise<void> {
  const { openThoughtInEditor } = await import('./editor.js');
  openThoughtInEditor(id);
}

async function focusLinkRef(id: string): Promise<void> {
  // Фокус + активация экрана «Карта мыслей»: с другого экрана (структуры,
  // хроника) смена фокуса без переключения вида незаметна.
  const { setFocus } = await import('../app.js');
  const { setActiveView } = await import('../screens/active-view.js');
  setActiveView('map');
  await setFocus(id);
}

async function showCloudContextMenu(id: string, anchor: HTMLElement): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const { isPinned, togglePinned } = await import('../pinned/pins.js');
  const { addToSelection, removeFromSelection } = await import('../selection/selection.js');
  const inSelection = store.state.selection.includes(id);
  const items: MenuItem[] = [
    {
      label: 'Открыть в редакторе',
      onClick: () => void openLinkRefInEditor(id),
    },
    {
      label: 'В фокус',
      onClick: () => void focusLinkRef(id),
    },
    {
      label: inSelection ? 'Убрать из выделенных' : 'Добавить к выделению',
      onClick: () => {
        if (inSelection) removeFromSelection([id]);
        else addToSelection([id]);
      },
    },
    {
      label: isPinned(id) ? 'Открепить мысль' : 'Закрепить мысль',
      onClick: () => void togglePinned(id),
    },
    {
      label: 'Копировать ID',
      onClick: () => {
        void navigator.clipboard.writeText(id).then(
          () => notice('ID мысли скопирован.'),
          () => notice('Не удалось скопировать ID.', 'error'),
        );
      },
    },
  ];
  const rect = anchor.getBoundingClientRect();
  showMenuAt(rect.left, rect.bottom + 2, items);
}

/**
 * Считает прямых соседей мысли по обоим направлениям (`neighbors`-эндпоинт
 * возвращает массив `ThoughtRef`). Используется для оценки числа соседей до
 * подгрузки.
 */
export function isMassLinkCount(count: number): boolean {
  return count >= MASS_LINK_THRESHOLD;
}

export const miniGraphInternals = {
  MASS_LINK_THRESHOLD,
  PERIPHERY_CAP,
};

// Кнопка (не используется пока, но держим импорт, чтобы лишний раз не
// обращаться к IDE-предупреждениям о неиспользуемом импорте).
void button;
void svgIcon;
