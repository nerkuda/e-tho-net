/**
 * Мини-граф редактора (задача 8ab775d9, единая модель связей; переработан по
 * приёмке 0.8.1 на d3-force/d3-drag/d3-zoom — ADR «Локальный граф на d3»).
 *
 * В стиле Obsidian: центральный узел — редактируемая мысль, вокруг — все
 * мысли, до которых из центра доходит одно ребро любого типа (структурное
 * «Родители»/«Потомки» или типизированное свойство-связь, оба направления).
 *
 * Интерактив:
 *  - force-физика (притягивание по рёбрам, отталкивание, столкновения
 *    пилюль) — узлы можно перетаскивать, симуляция «дожимает» соседей;
 *  - колесо — зум, правая кнопка — панорамирование; ЛИНИИ И УЗЛЫ ЖИВУТ В
 *    ОДНОМ пространстве координат (единый трансформ world-группы), поэтому
 *    облачка всегда «приклеяны» к концам связей;
 *  - hover на связи — tooltip с названием типа связи, линия подсвечивается,
 *    связанные мысли получают оранжевую рамку и всплывают наверх (важно,
 *    когда облачка перекрывают друг друга);
 *  - стрелки на линиях показывают направление (исходящая/входящая от центра);
 *  - облачка мыс­лей — как везде: значок (эмодзи/картинка), цвета и шрифт
 *    мысли, неактуальная бледная, помеченная на удаление — с меткой корзины;
 *  - Ctrl+hover — предпросмотр постоянного комментария (как на карте);
 *  - клик — открыть в редакторе, двойной — в фокус (с активацией карты),
 *    правый/Shift+F10 — контекстное меню облачка.
 *
 * Массовые связи (>=10 одинакового типа к одной цели) скрываются за чипом
 * «+N». На больших графах (>40 соседей) часть соседей выводится за порог
 * через чип «+N ещё».
 */

import type { Link, Thought, ThoughtRef } from '@etn/shared';
import { drag } from 'd3-drag';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { select } from 'd3-selection';
import { zoom, type D3ZoomEvent } from 'd3-zoom';

import { div, span } from '../lib/dom.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';
import { deferSingleClick } from '../canvas/canvas.js';
import { toggleSelection } from '../selection/selection.js';

/** Mass-link threshold: ≥10 ребер одного типа к одной цели скрываются за чипом. */
const MASS_LINK_THRESHOLD = 10;

/** Скрываем периферийных соседей, если их больше этого числа. */
const PERIPHERY_CAP = 40;

/** Геометрия пилюли-облачка: высота и максимальная ширина, px (мир графа). */
const CLOUD_H = 24;
const CLOUD_MAX_W = 220;
/** Обрезка заголовка в пилюле; полный текст — в tooltip. */
const CLOUD_TITLE_CLIP = 28;
/** Размер стрелки направления на ребре, px. */
const ARROW_LEN = 9;
const ARROW_W = 7;

export interface MiniGraphOptions {
  /** Текущая редактируемая мысль (центр). */
  thought: Thought;
  /** Прямые соседи — полные карточки (значок/цвета/шрифт/пометки). */
  neighbours: ThoughtRef[];
  /** Связи текущей мысли (тип ребра и направление от центра). */
  links: Link[];
  /** Соседи с массовыми связями: id цели → { hidden: number, label: string }. */
  mass: Map<string, { hidden: number; label: string }>;
  /**
   * Занять всю доступную высоту родителя (вкладка «Граф»). По умолчанию
   * `false` — фиксированные 280 px, как в группе «Локальный граф».
   */
  fillHeight?: boolean;
}

/** Узел симуляции: пилюля-облачко. */
interface GNode extends SimulationNodeDatum {
  id: string;
  title: string;
  /** Полная карточка для отрисовки в цветах/шрифте мысли. */
  ref: ThoughtRef | Thought;
  /** Ширина пилюли (по тексту), px. */
  w: number;
  center: boolean;
  /** SVG-группа узла (проставляется при отрисовке). */
  g?: SVGGElement;
}

/** Ребро симуляции. */
interface GEdge {
  source: GNode;
  target: GNode;
  /** Имя типа связи в направлении источника→цели. */
  label: string;
}

/** SVG namespace helper. */
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

/** Стиль мысли → атрибуты пилюли (SVG-зеркало applyCloudStyle). */
interface CloudVisual {
  bg: string;
  fg: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  dim: boolean;
}

function cloudVisual(ref: ThoughtRef | Thought): CloudVisual {
  const bg = ref.bg_color ?? 'var(--surface-2)';
  const fg = ref.fg_color ?? (ref.bg_color !== null ? '#ffffff' : 'var(--text)');
  return {
    bg,
    fg,
    bold: ref.font_bold === true,
    italic: ref.font_italic === true,
    underline: ref.font_underline === true,
    strike: ref.font_strike === true,
    dim: ref.active === false || ref.marked_for_deletion === true,
  };
}

/**
 * Рисует мини-граф. Возвращает корневой DOM-узел. Все интерактивы навешиваются
 * внутри; внешний код не должен ими управлять.
 */
export function buildMiniGraph(opts: MiniGraphOptions): HTMLElement {
  const root = div('mini-graph');
  // В fill-режиме (вкладка «Граф») дублируем CSS-инлайном, чтобы высота
  // растягивалась даже если Vite не доставил обновление styles.css —
  // иначе цепочка `.links-local-graph--fill > .mini-graph` обрывается
  // и viewport получает долю высоты по содержимому, а не всё окно.
  if (opts.fillHeight === true) {
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.flex = '1 1 auto';
    root.style.minHeight = '0';
  }
  const center = opts.thought;

  const totalNeighbours = opts.neighbours.length;
  const visibleNeighbours = opts.neighbours.slice(0, PERIPHERY_CAP);
  const hiddenNeighbours = totalNeighbours - visibleNeighbours.length;

  // --- Модель симуляции -----------------------------------------------------
  const nodes: GNode[] = [];
  const widthOf = (title: string): number =>
    Math.min(CLOUD_MAX_W, 30 + Math.min(title.length, CLOUD_TITLE_CLIP) * 6.6);
  nodes.push({
    id: center.id,
    title: center.title,
    ref: center,
    w: widthOf(center.title),
    center: true,
    x: 0,
    y: 0,
  });
  // Стартовые позиции по кругу — физике легче расходиться.
  visibleNeighbours.forEach((nb, i) => {
    const angle = (2 * Math.PI * i) / Math.max(visibleNeighbours.length, 1);
    nodes.push({
      id: nb.id,
      title: nb.title,
      ref: nb,
      w: widthOf(nb.title),
      center: false,
      x: 120 * Math.cos(angle),
      y: 90 * Math.sin(angle),
    });
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Рёбра: для каждого видимого соседа возьмём все связи с ним; направление
  // — от центра (source) к соседу (target), имя — прямое/обратное по типу.
  const edges: GEdge[] = [];
  const linkTypes = store.state.linkTypes;
  for (const nb of visibleNeighbours) {
    const between = opts.links.filter((l) => l.target_id === nb.id || l.source_id === nb.id);
    if (between.length === 0) {
      const c = nodeById.get(center.id);
      const t = nodeById.get(nb.id);
      if (c !== undefined && t !== undefined) edges.push({ source: c, target: t, label: '' });
      continue;
    }
    for (const link of between) {
      const c = nodeById.get(center.id);
      const t = nodeById.get(nb.id);
      if (c === undefined || t === undefined) continue;
      const type = linkTypes.find((lt) => lt.id === link.type_id);
      const isCenterSource = link.source_id === center.id;
      edges.push({
        source: isCenterSource ? c : t,
        target: isCenterSource ? t : c,
        label: isCenterSource ? (type?.name_forward ?? '') : (type?.name_reverse ?? ''),
      });
    }
  }

  // --- SVG-холст: единое пространство координат -----------------------------
  const svg = svgEl('svg');
  svg.setAttribute('class', 'mini-graph-canvas');
  // Мировые координаты: центр (0,0); viewBox центрирует стартовый вид.
  svg.setAttribute('viewBox', '-240 -170 480 340');
  const world = svgEl('g');
  world.setAttribute('class', 'mini-graph-world');
  const edgesG = svgEl('g');
  edgesG.setAttribute('class', 'mini-graph-edges');
  const nodesG = svgEl('g');
  nodesG.setAttribute('class', 'mini-graph-nodes');
  world.append(edgesG, nodesG);
  svg.append(world);

  // pannedSinceDown: жест правой кнопкой был панорамированием (движение), а
  // не кликом — узел в contextmenu не открывает меню после пана. Объявлено
  // до отрисовки узлов: wireNodeInteractions замыкает wasPanned.
  let pannedSinceDown = false;
  const wasPanned = (): boolean => {
    const moved = pannedSinceDown;
    pannedSinceDown = false;
    return moved;
  };

  /** Точка на границе эллипса пилюли `n` в направлении к `other`. */
  const edgePoint = (n: GNode, other: GNode): { x: number; y: number } => {
    const dx = other.x! - n.x!;
    const dy = other.y! - n.y!;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const rx = n.w / 2 + 2;
    const ry = CLOUD_H / 2 + 2;
    const t = 1 / Math.sqrt((ux / rx) ** 2 + (uy / ry) ** 2);
    return { x: n.x! + ux * t, y: n.y! + uy * t };
  };

  // --- Рёбра: линия + стрелка + постоянная подпись типа + зона ховера ------
  interface EdgeDraw {
    edge: GEdge;
    line: SVGLineElement;
    arrow: SVGPolygonElement;
    label: SVGTextElement | null;
    hit: SVGLineElement;
  }
  const edgeDraws: EdgeDraw[] = [];
  for (const edge of edges) {
    const line = svgEl('line');
    line.setAttribute('class', 'mini-graph-edge');
    edgesG.append(line);
    // Стрелка направления: источник → цель.
    const arrow = svgEl('polygon');
    arrow.setAttribute('class', 'mini-graph-edge-arrow');
    edgesG.append(arrow);
    // Постоянная подпись типа связи на середине ребра (приёмка 0.8.1:
    // типы должны быть видны всегда, не только в hover-подсказке).
    let label: SVGTextElement | null = null;
    if (edge.label !== '') {
      label = svgEl('text');
      label.setAttribute('class', 'mini-graph-edge-label');
      label.setAttribute('text-anchor', 'middle');
      label.textContent = edge.label;
      edgesG.append(label);
    }
    // Прозрачная толстая линия — зона наведения (pointer-events: stroke).
    const hit = svgEl('line');
    hit.setAttribute('class', 'mini-graph-edge-hit');
    const tooltipText = edge.label === '' ? 'связь' : edge.label;
    const title = svgEl('title');
    title.textContent = `${tooltipText} · ${edge.source.title} → ${edge.target.title}`;
    hit.append(title);
    edgesG.append(hit);

    const raiseNodes = (): void => {
      // g проставлен при отрисовке узлов ниже; к моменту события он есть.
      nodesG.append(edge.source.g!, edge.target.g!);
    };
    hit.addEventListener('mouseenter', () => {
      line.classList.add('hovered');
      arrow.classList.add('hovered');
      edge.source.g!.classList.add('edge-hi');
      edge.target.g!.classList.add('edge-hi');
      edgesG.append(line, arrow);
      if (label !== null) edgesG.append(label);
      raiseNodes();
    });
    hit.addEventListener('mouseleave', () => {
      line.classList.remove('hovered');
      arrow.classList.remove('hovered');
      edge.source.g!.classList.remove('edge-hi');
      edge.target.g!.classList.remove('edge-hi');
    });
    edgeDraws.push({ edge, line, arrow, label, hit });
  }

  // --- Узлы: пилюли-облачка --------------------------------------------------
  const byId = new Map<string, { node: GNode; g: SVGGElement }>();
  for (const node of nodes) {
    const g = svgEl('g');
    g.setAttribute('class', node.center ? 'mini-node mini-node-center' : 'mini-node');
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    const v = cloudVisual(node.ref);
    if (v.dim) g.classList.add('dim');

    const title = svgEl('title');
    title.textContent = node.title;
    g.append(title);

    const rect = svgEl('rect');
    rect.setAttribute('class', 'mini-node-cloud');
    rect.setAttribute('height', String(CLOUD_H));
    rect.setAttribute('rx', String(CLOUD_H / 2));
    rect.setAttribute('width', String(node.w));
    // Пилюля центрирована на узле: rect по умолчанию рисуется от (0,0)
    // вправо-вниз — без x/y заголовок и иконка (координаты от центра)
    // оказываются «рядом» с облачком, а не внутри него.
    rect.setAttribute('x', String(-node.w / 2));
    rect.setAttribute('y', String(-CLOUD_H / 2));
    rect.setAttribute('fill', v.bg);
    g.append(rect);

    // Значок: эмодзи — текст, картинка — <image> (icon хранит data: URL).
    // SVG <text> без явного `fill` рисуется чёрным по умолчанию — на тёмном
    // фоне облачка (наследуемый bg_color мысли) эмодзи пропадает; тот же
    // fill, что у заголовка, держит иконку видимой на любом фоне.
    // `dominant-baseline` дублируем атрибутом — CSS-вариант не во всех
    // движках SVG применяется к <text> (links.ts использует тот же приём).
    const iconLabel =
      node.title.length > CLOUD_TITLE_CLIP
        ? `${node.title.slice(0, CLOUD_TITLE_CLIP)}…`
        : node.title;
    const iconX = -node.w / 2 + 4;
    if (node.ref.icon !== null && node.ref.icon !== '') {
      if (node.ref.icon_kind === 'image') {
        const img = svgEl('image');
        // `href` поддерживается современными браузерами; `xlink:href`
        // дублируем ради старых сборок Chromium/Electron, где один из
        // вариантов может игнорироваться.
        img.setAttribute('href', node.ref.icon);
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', node.ref.icon);
        img.setAttribute('width', '16');
        img.setAttribute('height', '16');
        img.setAttribute('x', String(iconX + 1));
        img.setAttribute('y', String(-CLOUD_H / 2 + 4));
        g.append(img);
      } else {
        const icon = svgEl('text');
        icon.setAttribute('class', 'mini-node-icon');
        icon.setAttribute('x', String(iconX + 9));
        icon.setAttribute('y', '0');
        icon.setAttribute('text-anchor', 'middle');
        icon.setAttribute('dominant-baseline', 'middle');
        if (v.fg !== '') icon.setAttribute('fill', v.fg);
        icon.textContent = node.ref.icon;
        g.append(icon);
      }
    }

    const text = svgEl('text');
    text.setAttribute('class', 'mini-node-title');
    text.setAttribute('x', String(iconX + 22));
    text.setAttribute('y', '0');
    if (v.fg !== '') text.setAttribute('fill', v.fg);
    if (v.bold) text.setAttribute('font-weight', '700');
    if (v.italic) text.setAttribute('font-style', 'italic');
    if (v.underline) text.setAttribute('text-decoration', 'underline');
    if (v.strike) text.setAttribute('text-decoration', 'line-through');
    text.textContent = iconLabel;
    g.append(text);

    // Помеченная на удаление — метка-корзина (S13).
    if (node.ref.marked_for_deletion === true) {
      const trash = svgEl('text');
      trash.setAttribute('class', 'mini-node-trash');
      trash.setAttribute('x', String(node.w / 2 - 8));
      trash.setAttribute('y', '-4');
      trash.textContent = '🗑';
      g.append(trash);
    }

    node.g = g;
    byId.set(node.id, { node, g });
    nodesG.append(g);
    wireNodeInteractions(g, node, wasPanned);
  }
  // Массовые чипы «+N» — рядом с узлом, позиция обновляется в tick.
  const massChips: Array<{ g: SVGGElement; node: GNode }> = [];
  for (const nb of visibleNeighbours) {
    const mass = opts.mass.get(nb.id);
    const entry = byId.get(nb.id);
    if (mass === undefined || entry === undefined) continue;
    const chip = svgEl('g');
    chip.setAttribute('class', 'mini-graph-mass-chip');
    const chipTitle = svgEl('title');
    chipTitle.textContent = `${mass.label}: ещё ${mass.hidden} связей`;
    chip.append(chipTitle);
    const chipText = svgEl('text');
    chipText.textContent = `+${mass.hidden}`;
    chip.append(chipText);
    edgesG.append(chip);
    massChips.push({ g: chip, node: entry.node });
  }

  // --- Раскладка каждого кадра симуляции ------------------------------------
  const paintEdge = (draw: EdgeDraw): void => {
    const { edge, line, arrow, label, hit } = draw;
    const a = edgePoint(edge.source, edge.target);
    const b = edgePoint(edge.target, edge.source);
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(b.x));
    line.setAttribute('y2', String(b.y));
    hit.setAttribute('x1', String(a.x));
    hit.setAttribute('y1', String(a.y));
    hit.setAttribute('x2', String(b.x));
    hit.setAttribute('y2', String(b.y));
    // Стрелка у конца (цель), ориентированная по вектору.
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const bx = b.x - Math.cos(ang) * 2;
    const by = b.y - Math.sin(ang) * 2;
    const pts: Array<[number, number]> = [
      [bx, by],
      [bx - ARROW_LEN * Math.cos(ang) - (ARROW_W / 2) * Math.sin(ang), by - ARROW_LEN * Math.sin(ang) + (ARROW_W / 2) * Math.cos(ang)],
      [bx - ARROW_LEN * Math.cos(ang) + (ARROW_W / 2) * Math.sin(ang), by - ARROW_LEN * Math.sin(ang) - (ARROW_W / 2) * Math.cos(ang)],
    ];
    arrow.setAttribute(
      'points',
      pts.map(([x, y]) => `${x},${y}`).join(' '),
    );
    // Подпись типа — над серединой линии (перпендикуляр вверх).
    if (label !== null) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      let px = -Math.sin(ang);
      let py = Math.cos(ang);
      if (py > 0) {
        px = -px;
        py = -py;
      }
      label.setAttribute('x', String(mx + px * 6));
      label.setAttribute('y', String(my + py * 6));
    }
  };

  const ticked = (): void => {
    for (const entry of byId.values()) {
      entry.g.setAttribute('transform', `translate(${entry.node.x ?? 0},${entry.node.y ?? 0})`);
    }
    for (const draw of edgeDraws) paintEdge(draw);
    for (const chip of massChips) {
      chip.g.setAttribute(
        'transform',
        `translate(${(chip.node.x ?? 0) + chip.node.w / 2 + 4},${(chip.node.y ?? 0) - CLOUD_H / 2 - 4})`,
      );
    }
  };

  // --- Симуляция -------------------------------------------------------------
  const simulation: Simulation<GNode, undefined> = forceSimulation<GNode>(nodes)
    .force(
      'link',
      forceLink<GNode, GEdge>(edges)
        .id((d) => d.id)
        .distance(95)
        .strength(0.25),
    )
    .force('charge', forceManyBody<GNode>().strength(-170))
    .force(
      'collide',
      forceCollide<GNode>()
        .radius((d) => d.w / 2 + 6)
        .iterations(2),
    )
    .force('x', forceX<GNode>(0).strength(0.045))
    .force('y', forceY<GNode>(0).strength(0.045))
    .on('tick', ticked);
  ticked();

  // --- Зум (колесо) и пан (правая кнопка) единым трансформом world ----------
  const zoomBehavior = zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.3, 3])
    .filter((event) => event.type === 'wheel' || (event.type === 'mousedown' && event.button === 2))
    .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
      world.setAttribute('transform', event.transform.toString());
      if (event.sourceEvent !== null && event.sourceEvent.type === 'mousemove') {
        pannedSinceDown = true;
      }
    });
  svg.addEventListener('contextmenu', (event) => event.preventDefault());
  select(svg).call(zoomBehavior).on('dblclick.zoom', null);

  // --- Drag узлов ------------------------------------------------------------
  for (const entry of byId.values()) {
    const { node, g } = entry;
    select(g)
      .datum(node)
      .call(
        drag<SVGGElement, GNode>()
          .on('start', () => {
            node.fx = node.x;
            node.fy = node.y;
            simulation.alphaTarget(0.3).restart();
          })
          .on('drag', (event) => {
            // d3-drag стартует уже на mousedown — помечаем «было
            // перетаскивание» только при реальном движении, иначе любой
            // клик с микросдвигом подавлялся бы как drag (приёмка 0.8.1).
            draggedByDrag.add(g);
            node.fx = event.x;
            node.fy = event.y;
          })
          .on('end', () => {
            // Узел остаётся там, куда его положили (fx/fy закреплены) —
            // как в Obsidian; остальной граф «дожимается» физикой.
            simulation.alphaTarget(0);
          }),
      );
  }

  // --- Контейнер ---------------------------------------------------------------
  const viewport = div('mini-graph-viewport');
  if (opts.fillHeight === true) {
    viewport.classList.add('mini-graph-viewport--fill');
    // Инлайн-страховка от устаревшего CSS-кеша Vite (см. .mini-graph выше).
    viewport.style.flex = '1 1 auto';
    viewport.style.minHeight = '0';
    viewport.style.height = 'auto';
  }
  viewport.append(svg);

  root.append(viewport);

  // Шапка со счётчиками: «соседей N» / «скрыто массовых M».
  const header = div('mini-graph-header');
  header.append(span(`соседей: ${totalNeighbours}`, 'mini-graph-header-stat'));
  if (opts.mass.size > 0) {
    const hiddenMass = [...opts.mass.values()].reduce((s, m) => s + m.hidden, 0);
    header.append(span(` · скрыто массовых: ${hiddenMass}`, 'mini-graph-header-stat'));
  }
  root.append(header);
  if (hiddenNeighbours > 0) {
    const more = div('mini-graph-more');
    more.textContent = `+${hiddenNeighbours} ещё (порог ${PERIPHERY_CAP}, массовых ≥${MASS_LINK_THRESHOLD})`;
    header.append(more);
  }
  // Подвал с подсказкой.
  const hint = div('mini-graph-hint muted');
  hint.textContent =
    'Колесо — зум, правая кнопка — панорама, узлы можно таскать. Наведите на связь — тип и подсветка. Ctrl+hover — предпросмотр.';
  root.append(hint);

  // Останавливаем физику, когда граф скрыт (группа свёрнута/вкладка сменилась),
  // и оживляем при показе — без холостых тиков в фоне.
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          if (simulation.alpha() > 0) simulation.restart();
        } else {
          simulation.stop();
        }
      }
    });
    io.observe(root);
  }

  return root;
}

/**
 * Узлы, чей последний жест был перетаскиванием: клик, который браузер
 * отправит сразу после drag, подавляется (не открывает редактор).
 */
const draggedByDrag = new WeakSet<Element>();

/** Интерактив узла: клики/меню/Ctrl-hover (SVG-версия wireCloudInteractions). */
function wireNodeInteractions(g: SVGGElement, node: GNode, wasPanned: () => boolean): void {
  // Клики как на канвасе (08-ui-spec.md): Ctrl/Cmd+клик — добавить/убрать из
  // панели выбранных; одиночный клик отложен на SINGLE_CLICK_DELAY_MS, чтобы
  // двойной клик (в фокус) успевал до открытия редактора.
  let pendingClick: { cancel: () => void } | null = null;
  g.addEventListener('click', (event) => {
    if (draggedByDrag.has(g)) {
      draggedByDrag.delete(g);
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      pendingClick?.cancel();
      pendingClick = null;
      toggleSelection([node.id]);
      return;
    }
    pendingClick?.cancel();
    pendingClick = deferSingleClick(() => {
      pendingClick = null;
      void openLinkRefInEditor(node.id);
    });
  });
  g.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    pendingClick?.cancel();
    pendingClick = null;
    void focusLinkRef(node.id);
  });
  g.addEventListener('contextmenu', (event) => {
    // После панорамирования правой кнопкой меню не открываем (движение было).
    if (wasPanned()) return;
    event.preventDefault();
    event.stopPropagation();
    void showCloudContextMenu(node.id, g);
  });
  g.addEventListener('keydown', (event) => {
    if (event.key === 'F10' && event.shiftKey) {
      event.preventDefault();
      void showCloudContextMenu(node.id, g);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void openLinkRefInEditor(node.id);
    } else if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      void focusLinkRef(node.id);
    }
  });
  // Ctrl+hover — предпросмотр постоянного комментария (общий механизм
  // hover-preview: читает data-атрибуты делегированно; SVG-элементы
  // совместимы — dataset у них есть).
  g.addEventListener('mouseover', async (event) => {
    if (!event.ctrlKey) return;
    const networkId = store.state.networkId;
    if (networkId === null) return;
    try {
      const { markThoughtCommentPreview } = await import('../lib/hover-preview.js');
      const { etn } = await import('../lib/etn.js');
      const t = await etn.thoughts.get(networkId, node.id);
      markThoughtCommentPreview(g as unknown as HTMLElement, t.id, t.title);
    } catch {
      // нет превью — игнор
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

async function showCloudContextMenu(id: string, anchor: Element): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const { isPinned, togglePinned } = await import('../pinned/pins.js');
  const { addToSelection, removeFromSelection } = await import('../selection/selection.js');
  const { showMenuAt } = await import('../lib/menu.js');
  const inSelection = store.state.selection.includes(id);
  const items = [
    { label: 'Открыть в редакторе', onClick: () => void openLinkRefInEditor(id) },
    { label: 'В фокус', onClick: () => void focusLinkRef(id) },
    {
      label: inSelection ? 'Убрать из выделенных' : 'Добавить к выделению',
      onClick: () => {
        if (inSelection) removeFromSelection([id]);
        else addToSelection([id]);
      },
    },
    {
      label: isPinned(id) ? 'Открепить мысль' : 'Закрепить мысль',
      onClick: () => togglePinned(id),
    },
  ];
  const rect = anchor.getBoundingClientRect();
  showMenuAt(rect.left, rect.bottom + 2, items);
  void networkId; // сеть уже в store; идентификатор не нужен меню
}
