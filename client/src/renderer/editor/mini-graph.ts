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
 *  - колесо — зум, ПАН — левой кнопкой по пустому месту; ЛИНИИ И УЗЛЫ ЖИВУТ В
 *    ОДНОМ пространстве координат (единый трансформ world-группы), поэтому
 *    облачка всегда «приклеяны» к концам связей;
 *  - hover на связи — tooltip «тип: источник -> назначение», линия
 *    подсвечивается, связанные мысли получают оранжевую рамку и всплывают
 *    наверх (важно, когда облачка перекрывают друг друга);
 *  - стрелки на линиях показывают ФАКТИЧЕСКОЕ направление связи (источник →
 *    цель), а не «от центра»: для входящей связи стрелка смотрит в центр;
 *  - линии окрашены/штрихованы/утолщены по эффективному оформлению типа связи
 *    (наследование по цепочке предков, как на карте), для связи без типа —
 *    нейтральное оформление приложения;
 *  - облачка мыс­лей — как везде: значок (свой, иначе унаследованный от типа по
 *    цепочке предков, иначе 💭) и цвета/шрифт мысли, неактуальная бледная,
 *    помеченная на удаление — с меткой корзины;
 *  - Ctrl+hover — предпросмотр постоянного комментария (как на карте), а на
 *    иконке-картинке — «лупа» с полной картинкой (как везде, `lib/image-zoom`);
 *  - клик — открыть в редакторе, двойной — в фокус (с активацией карты),
 *    правый/Shift+F10 — контекстное меню облачка.
 *
 * Правила рёбер и счётчиков шапки живут в чистой модели
 * `mini-graph-model.ts` (направление/имя типа/тултип, оформление линии,
 * массовые связи, показатели) — здесь только отрисовка. Массовые связи
 * (≥10 одинакового типа к одному соседу) скрываются за чипом «+N»; лишние
 * соседи сверх порога — счётчиком «Ещё не поместилось».
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

import { div, setTooltip, span } from '../lib/dom.js';
// Пилюли-узлы мини-графа собирает общая фабрика облачка (профиль `graph`):
// значок, цвета, начертание, бледность, метка корзины и обрезка названия
// раскладкой с подсказкой — те же, что во всех списках клиента. HTML-облачко
// кладётся в SVG через <foreignObject> («поверх SVG»).
import { createThoughtCloud } from '../lib/thought-cloud.js';
import { store } from '../state.js';
import { toggleSelection } from '../selection/selection.js';
import {
  PERIPHERY_CAP,
  computeGraphStats,
  edgeTooltip,
  edgeTypeName,
  graphStatEntries,
  neutralEdgeVisual,
  orientLink,
  resolveEdgeVisual,
  type EdgeVisual,
} from './mini-graph-model.js';

/** Геометрия пилюли-облачка: высота и границы ширины, px (мир графа). */
const CLOUD_H = 24;
const CLOUD_MAX_W = 220;
/** Минимальная ширина пилюли — узкие названия не схлопываются в точку. */
const CLOUD_MIN_W = 48;
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
  /** Имя типа связи в направлении источника→цели ('' — связи без типа). */
  label: string;
  /** Исходная связь — для эффективного оформления линии (`null` — без записи). */
  link: Link | null;
}

/** SVG namespace helper. */
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

/**
 * Ширина пилюли узла: ограничена раскладкой фабричного облачка (текст
 * обрезается многоточием внутри), а не подсчётом символов (ADR «Обрезка
 * текста — раскладкой, а не подсчётом символов»). Облачко собирается заранее
 * и замеряется в скрытом пробнике — симуляция получает реальную ширину.
 */
function measureCloudWidth(probeHost: HTMLElement, input: Parameters<typeof createThoughtCloud>[0]): number {
  const probe = createThoughtCloud(input, { profile: 'graph' });
  probeHost.append(probe);
  const w = probe.offsetWidth;
  probe.remove();
  return Math.min(CLOUD_MAX_W, Math.max(CLOUD_MIN_W, w));
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

  // --- Модель симуляции -----------------------------------------------------
  // Скрытый пробник для замера реальной ширины фабричных облачков (раскладка
  // ограничивает видимую длину названия, а не подсчёт символов).
  const probeHost = div('mini-graph-probe');
  probeHost.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;';
  document.body.append(probeHost);

  const nodes: GNode[] = [];
  nodes.push({
    id: center.id,
    title: center.title,
    ref: center,
    w: measureCloudWidth(probeHost, center),
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
      w: measureCloudWidth(probeHost, nb),
      center: false,
      x: 120 * Math.cos(angle),
      y: 90 * Math.sin(angle),
    });
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Рёбра: для каждого видимого соседа возьмём все связи с ним. Направление и
  // имя типа берём у САМОЙ связи (фактический источник → цель), а не «от
  // центра»: входящая связь рисуется стрелкой в центр (задача 6811d5e7, п.1).
  const edges: GEdge[] = [];
  const linkTypes = store.state.linkTypes;
  for (const nb of visibleNeighbours) {
    const between = opts.links.filter((l) => l.target_id === nb.id || l.source_id === nb.id);
    if (between.length === 0) {
      // Сосед без записи связи (структурное ребро вне списка) — нейтральная
      // линия от центра, без типа.
      const c = nodeById.get(center.id);
      const t = nodeById.get(nb.id);
      if (c !== undefined && t !== undefined) {
        edges.push({ source: c, target: t, label: '', link: null });
      }
      continue;
    }
    for (const link of between) {
      const c = nodeById.get(center.id);
      const t = nodeById.get(nb.id);
      if (c === undefined || t === undefined) continue;
      const oriented = orientLink(link, center.id);
      const type =
        link.type_id === null ? undefined : linkTypes.find((lt) => lt.id === link.type_id);
      edges.push({
        source: oriented.sourceId === center.id ? c : t,
        target: oriented.targetId === center.id ? c : t,
        label: edgeTypeName(type, oriented.fromCenter),
        link,
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
    /** Эффективное оформление (цвет/штрих/толщина) — из типа связи. */
    visual: EdgeVisual;
    line: SVGLineElement;
    arrow: SVGPolygonElement;
    label: SVGTextElement | null;
    hit: SVGLineElement;
  }
  const edgeDraws: EdgeDraw[] = [];
  for (const edge of edges) {
    // Оформление линии: собственные переопределения связи → настройки типа по
    // цепочке предков; связь без типа — нейтрально (задача 6811d5e7, п.4).
    const visual = edge.link === null ? neutralEdgeVisual() : resolveEdgeVisual(linkTypes, edge.link);
    const line = svgEl('line');
    line.setAttribute('class', 'mini-graph-edge');
    // Цвет — кастомным свойством, а не inline `stroke`: иначе inline-стиль
    // перебил бы CSS подсветки `.mini-graph-edge.hovered` (акцент при наведении).
    if (visual.color !== null) line.style.setProperty('--edge-color', visual.color);
    line.style.setProperty('--edge-width', `${visual.width}px`);
    line.style.setProperty('--edge-hover-width', `${Math.max(2, visual.width + 1)}px`);
    if (visual.dash !== 'none') line.style.strokeDasharray = visual.dash;
    edgesG.append(line);
    // Стрелка направления: источник → цель (фактическое направление связи).
    const arrow = svgEl('polygon');
    arrow.setAttribute('class', 'mini-graph-edge-arrow');
    if (visual.color !== null) arrow.style.setProperty('--edge-color', visual.color);
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
    // Тултип: «<имя типа связи>: <источник> -> <назначение>»; без типа —
    // слово «связь». Направление — фактическое (задача 6811d5e7, п.3).
    const title = svgEl('title');
    title.textContent = edgeTooltip(edge.label, edge.source.title, edge.target.title);
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
    edgeDraws.push({ edge, visual, line, arrow, label, hit });
  }

  // --- Узлы: пилюли-облачка --------------------------------------------------
  const byId = new Map<string, { node: GNode; g: SVGGElement; cloud: HTMLElement }>();
  for (const node of nodes) {
    const g = svgEl('g');
    g.setAttribute('class', node.center ? 'mini-node mini-node-center' : 'mini-node');

    // Пилюля — HTML-облачко общей фабрики (профиль `graph`), положенное в SVG
    // через <foreignObject>: значок, цвета, начертание, бледность, метка
    // корзины и обрезка названия раскладкой с подсказкой — как во всех
    // списках клиента. Класс `mini-node-cloud` переносит на контейнер рамки
    // hover/focus/центра/edge-hi из styles.css (SVG stroke).
    const cloud = createThoughtCloud(node.ref, {
      profile: 'graph',
      actions: {
        // Клики как на канвасе (08-ui-spec.md): Ctrl/Cmd+клик — панель
        // выбранных; одиночный клик отложен фабрикой, чтобы двойной клик
        // (в фокус) успевал; после реального перетаскивания клик подавляется.
        onClick: (id) => {
          if (draggedByDrag.has(cloud)) {
            draggedByDrag.delete(cloud);
            return;
          }
          void openLinkRefInEditor(id);
        },
        onDoubleClick: (id) => void focusLinkRef(id),
        onCtrlClick: (id) => toggleSelection([id]),
        onContextMenu: (event) => {
          // Правая кнопка больше не панорамирует — меню открывается всегда.
          event.stopPropagation();
          void showCloudContextMenu(node, cloud);
        },
      },
    });
    cloud.classList.add('mini-node-cloud');
    // Клавиатура — доменная часть узла (Enter — открыть, пробел — в фокус,
    // Shift+F10 — общее меню мысли).
    cloud.addEventListener('keydown', (event) => {
      if (event.key === 'F10' && event.shiftKey) {
        event.preventDefault();
        void showCloudContextMenu(node, cloud);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        void openLinkRefInEditor(node.id);
      } else if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        void focusLinkRef(node.id);
      }
    });
    // Ctrl+hover — предпросмотр постоянного комментария (общий механизм
    // hover-preview: читает data-атрибуты делегированно).
    g.addEventListener('mouseover', async (event) => {
      if (!event.ctrlKey) return;
      const networkId = store.state.networkId;
      if (networkId === null) return;
      try {
        const { markThoughtCommentPreview } = await import('../lib/hover-preview.js');
        const { etn } = await import('../lib/etn.js');
        const t = await etn.thoughts.get(networkId, node.id);
        markThoughtCommentPreview(cloud, t.id, t.title);
      } catch {
        // нет превью — игнор
      }
    });

    const fo = svgEl('foreignObject');
    fo.setAttribute('width', String(node.w));
    fo.setAttribute('height', String(CLOUD_H + 6));
    // Пилюля центрирована на узле (как прежний rect): без x/y контейнер
    // рисовался бы от точки узла вправо-вниз, а облачко отклеивалось бы.
    fo.setAttribute('x', String(-node.w / 2));
    fo.setAttribute('y', String(-(CLOUD_H + 6) / 2));
    fo.append(cloud);
    g.append(fo);

    node.g = g;
    byId.set(node.id, { node, g, cloud });
    nodesG.append(g);
  }
  probeHost.remove();
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

  // --- Зум (колесо) и пан (ЛЕВАЯ кнопка) единым трансформом world ----------
  // Левая кнопка по пустому месту — панорама; на узле d3-drag перехватывает
  // mousedown и гасит распространение, поэтому узел тащится, а не панорамирует
  // холст. Правая кнопка холст не двигает: контекстные меню работают как есть.
  const zoomBehavior = zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.3, 3])
    .filter((event) => event.type === 'wheel' || (event.type === 'mousedown' && event.button === 0))
    .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
      world.setAttribute('transform', event.transform.toString());
    });
  svg.addEventListener('contextmenu', (event) => event.preventDefault());
  select(svg).call(zoomBehavior).on('dblclick.zoom', null);

  // --- Drag узлов ------------------------------------------------------------
  for (const entry of byId.values()) {
    const { node, g, cloud } = entry;
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
            // Метка на облачке: клик, который браузер отправит сразу после
            // drag, подавляется в onClick фабричных действий.
            draggedByDrag.add(cloud);
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

  // Шапка: понятные показатели, каждый со своей подсказкой (задача 6811d5e7,
  // п.6). «Соседей» — все прямые соседи; «скрыто массовых» — избыточные рёбра
  // однотипных пар, свёрнутые в чипы «+N»; «ещё не поместилось» — соседи сверх
  // порога PERIPHERY_CAP. Механика и тексты — в mini-graph-model.
  const hiddenMass = [...opts.mass.values()].reduce((s, m) => s + m.hidden, 0);
  const stats = computeGraphStats(totalNeighbours, hiddenMass);
  const header = div('mini-graph-header');
  for (const entry of graphStatEntries(stats)) {
    const stat = span(entry.text, 'mini-graph-header-stat');
    setTooltip(stat, entry.tooltip);
    header.append(stat);
  }
  root.append(header);
  // Подвал с подсказкой.
  const hint = div('mini-graph-hint muted');
  hint.textContent =
    'Колесо — зум, левая кнопка по пустому месту — панорама, узлы можно таскать. Наведите на связь — тип и подсветка. Ctrl+hover — предпросмотр.';
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

async function openLinkRefInEditor(id: string): Promise<void> {
  const { openThoughtInEditor } = await import('./editor.js');
  openThoughtInEditor(id);
}

async function focusLinkRef(id: string): Promise<void> {
  // Фокус + активация экрана «Карта мыслей» — общий помощник (ошибка 562356a9):
  // с другого экрана (структуры, хроника, события) смена фокуса без
  // переключения вида незаметна.
  const { focusThoughtOnMap } = await import('../screens/active-view.js');
  await focusThoughtOnMap(id);
}

/**
 * Контекстное меню пилюли локального графа. Набор команд — общий с холстом
 * (спецификация «Контекстное меню мысли»): меню строит тот же конструктор, что
 * у облачка на карте и у чипов свойств; здесь заданы только отличия контекста
 * редактора — «Открыть в редакторе» без смены фокуса холста и «В фокус».
 */
async function showCloudContextMenu(node: GNode, anchor: Element): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  // Ленивый импорт: статический замкнул бы цикл
  // canvas/context-menu → editor/editor → editor/mini-graph.
  const { showThoughtMenuUnder, resolveSiblingParentId } =
    await import('../canvas/context-menu.js');
  showThoughtMenuUnder(
    anchor,
    {
      id: node.id,
      title: node.title,
      dir: 'siblings',
      // Пилюля не в зоне холста — родителя для «налево (родственник)»
      // резолвим запросом (на холсте он приходит с ответом фокуса).
      siblingParentId: await resolveSiblingParentId(networkId, node.id),
      trashed: node.ref.marked_for_deletion === true,
    },
    {
      openLabel: 'Открыть в редакторе',
      openHandler: (id) => void openLinkRefInEditor(id),
      focusHandler: () => void focusLinkRef(node.id),
    },
  );
}
