/**
 * Structural checks for the d3-based local graph (задача 8ab775d9 + приёмка
 * 0.8.1, ADR «Локальный граф на d3-force/zoom/drag»).
 *
 * Прежний тест гонял buildMiniGraph под DOM-шином; после перехода на
 * d3-selection/zoom/drag модуль требует живого DOM (selection-обвязка,
 * ownerDocument, событийная система d3) — как соседние структурные тесты
 * (editor-tabs-structure, editor-splitter-fixed-height), проверяем якоря
 * исходника: единое пространство координат (мысли приклеены к линиям),
 * физика, drag узлов, зум/пан, стрелки направления, hover-подсветка рёбер,
 * облачка с оформлением мысли, Ctrl-hover предпросмотр.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { assembledStylesFile } from './renderer-css.js';

const SRC = {
  graph: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'mini-graph.ts'),
  graphTab: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'graph-tab.ts'),
  model: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'mini-graph-model.ts'),
  css: assembledStylesFile(),
};

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('локальный граф на d3 (приёмка 0.8.1)', () => {
  it('d3-force/zoom/drag — зависимости используются, физика и drag настроены', () => {
    const src = readText(SRC.graph);
    assert.ok(src.includes("from 'd3-force'"), 'imports d3-force');
    assert.ok(src.includes("from 'd3-zoom'"), 'imports d3-zoom');
    assert.ok(src.includes("from 'd3-drag'"), 'imports d3-drag');
    for (const anchor of [
      'forceSimulation',
      'forceLink',
      'forceManyBody',
      'forceCollide',
    ]) {
      assert.ok(src.includes(anchor), `simulation uses ${anchor}`);
    }
    assert.ok(
      /drag<SVGGElement, GNode>\(\)/.test(src),
      'node drag behaviour is wired',
    );
    assert.ok(
      /alphaTarget\(0\.3\)\.restart\(\)/.test(src),
      'drag re-heats the simulation (притягивание/отталкивание живьём)',
    );
  });

  it('линии и узлы живут в ОДНОМ пространстве координат (zoom двигает их вместе)', () => {
    const src = readText(SRC.graph);
    assert.ok(
      src.includes("'mini-graph-world'"),
      'a single world group carries the zoom transform',
    );
    assert.ok(
      /world\.setAttribute\('transform', event\.transform\.toString\(\)\)/.test(src),
      'zoom applies one transform to the world group (not per-layer viewBox)',
    );
    assert.ok(
      src.indexOf("setAttribute('viewBox'") === src.lastIndexOf("setAttribute('viewBox'"),
      'viewBox is set exactly once (a static frame — panning/zooming never mutate it)',
    );
    // Узлы позиционируются transform'ом внутри того же world.
    assert.ok(
      /translate\(\$\{entry\.node\.x \?\? 0\},\$\{entry\.node\.y \?\? 0\}\)/.test(src),
      'nodes are positioned in world coordinates',
    );
  });

  it('зум — колесо, пан — ЛЕВАЯ кнопка (правая холст не двигает)', () => {
    const src = readText(SRC.graph);
    assert.ok(
      /event\.type === 'wheel' \|\| \(event\.type === 'mousedown' && event\.button === 0\)/.test(
        src,
      ),
      'zoom filter: wheel or left button only (задача 6811d5e7, п.2)',
    );
    assert.ok(
      !/event\.button === 2/.test(src),
      'the right button no longer pans the canvas',
    );
    assert.ok(
      src.includes('левая кнопка по пустому месту'),
      'the hint documents the left-button pan',
    );
    assert.ok(
      src.includes("addEventListener('contextmenu'"),
      'native context menu is suppressed on the canvas',
    );
  });

  it('рёбра: стрелка направления + hover с tooltip и оранжевой подсветкой мыс­лей', () => {
    const src = readText(SRC.graph);
    assert.ok(
      src.includes('mini-graph-edge-arrow'),
      'direction arrows are drawn on edges',
    );
    assert.ok(
      src.includes('mini-graph-edge-hit'),
      'a wide transparent hit-line is wired for hover',
    );
    assert.ok(
      /hit\.append\(title\)/.test(src),
      'the hit-line carries an SVG <title> tooltip with the link type name',
    );
    assert.ok(
      src.includes("'edge-hi'"),
      'hovering an edge highlights both endpoint clouds',
    );
    assert.ok(
      /nodesG\.append\(edge\.source\.g!/.test(src),
      'highlighted clouds are raised above the rest',
    );
    const css = readText(SRC.css);
    assert.ok(
      css.includes('.mini-node.edge-hi .mini-node-cloud'),
      'CSS paints the orange highlight frame',
    );
  });

  it('облачка мыс­лей — фабричные HTML-облачка в <foreignObject>: значок, цвета, шрифт, dim, корзина', () => {
    const src = readText(SRC.graph);
    for (const anchor of [
      'createThoughtCloud(', // пилюля собирается общей фабрикой
      "profile: 'graph'", // профиль узла мини-графа
      'foreignObject', // HTML-облачко положено в SVG поверх линий
      'measureCloudWidth', // ширина пилюли замеряется по раскладке, не по символам
    ]) {
      assert.ok(src.includes(anchor), `node rendering includes ${anchor}`);
    }
    assert.ok(
      src.includes('markThoughtCommentPreview'),
      'Ctrl+hover preview is wired on nodes',
    );
  });

  it('пилюлю собирает общая фабрика облачка, а не чтение визуальных полей ref', () => {
    // Регрессия: пилюля читала `ref.icon`/`ref.bg_color` напрямую, из-за чего
    // своя иконка показывалась всегда, типовая — не всегда, а дефолт 💭 —
    // никогда. Теперь облачко строит фабрика (веха 2) — она же резолвит
    // значок по цепочке типов и рисует состояние/начертание.
    const src = readText(SRC.graph);
    assert.ok(
      src.includes("import { createThoughtCloud } from '../lib/thought-cloud.js'"),
      'node clouds come from the shared factory',
    );
    assert.ok(
      !src.includes('node.ref.icon !== null') &&
        !src.includes('node.ref.icon_kind') &&
        !src.includes('ref.bg_color') &&
        !src.includes('ref.fg_color'),
      'the pill does not read the ref visual fields directly',
    );
    // graph-tab больше не достраивает наследование руками — иначе два разных
    // правила наследования снова разъедутся.
    assert.ok(
      !readText(SRC.graphTab).includes('inheritFromType'),
      'graph-tab does not hand-roll type inheritance',
    );
  });

  it('пилюля центрирована на узле (foreignObject x/y) — облачко внутри неё', () => {
    // Регрессия: контейнер без x/y рисуется от (0,0) вправо-вниз, а точка
    // узла — центр: облачко «отклеивалось» бы от позиции симуляции.
    const src = readText(SRC.graph);
    assert.ok(
      src.includes("fo.setAttribute('x', String(-node.w / 2))"),
      'cloud container is centered horizontally',
    );
    assert.ok(
      src.includes("fo.setAttribute('y', String(-(CLOUD_H + 6) / 2))"),
      'cloud container is centered vertically',
    );
  });

  it('клики как на канвасе: Ctrl+клик — выделение, одиночный отложен (dblclick успевает)', () => {
    const src = readText(SRC.graph);
    assert.ok(
      src.includes('actions: {'),
      'node gestures come from the factory actions',
    );
    assert.ok(
      src.includes('toggleSelection([id])'),
      'Ctrl+click toggles the selection panel membership',
    );
    assert.ok(
      src.includes('onCtrlClick'),
      'Ctrl/Cmd+click action is wired through the factory',
    );
    // d3-drag стартует на mousedown: подавление клика — только при реальном
    // движении, иначе каждый клик глох как drag (баг приёмки 0.8.1).
    assert.ok(
      !/on\('start', \(\) => \{\s*draggedByDrag\.add/.test(src),
      'the drag-suppression flag is NOT set on drag start (mousedown)',
    );
    assert.ok(
      /on\('drag', \(event\) => \{[\s\S]*?draggedByDrag\.add\(cloud\)/.test(src),
      'the drag-suppression flag is set on actual movement only',
    );
  });

  it('типы связей видны всегда: постоянная подпись на середине ребра', () => {
    const src = readText(SRC.graph);
    assert.ok(
      src.includes('mini-graph-edge-label'),
      'edges carry a persistent type label',
    );
    const css = readText(SRC.css);
    assert.ok(
      css.includes('.mini-graph-edge-label'),
      'CSS styles the persistent edge label',
    );
  });

  it('ровно одна стрелка на ребро; встречные связи разведены по полосам — ошибка 6452c840', () => {
    const src = readText(SRC.graph);
    // Стрелка ребра создаётся ровно один раз на ребро (у конца-цели) — «два
    // конца» давало наложение двух РАЗНЫХ связей одной пары, а не маркер.
    const arrowCreations = src.match(/svgEl\('polygon'\)/g) ?? [];
    assert.equal(arrowCreations.length, 1, 'one arrow polygon factory call per edge loop');
    assert.equal(
      (src.match(/'mini-graph-edge-arrow'/g) ?? []).length,
      1,
      'the arrow is drawn once per edge',
    );
    // Полоса встречного ребра — из чистой модели; смещение применяется к
    // линии, зоне наведения, стрелке и подписи одним `shiftEdgeByLane`.
    assert.ok(src.includes('assignEdgeLanes('), 'lanes are planned by the pure model');
    assert.ok(
      /shiftEdgeByLane\(a0, b0, edge\.source\.id, edge\.target\.id, edge\.laneOffset\)/.test(src),
      'the lane shift is applied from the model, for both directions of the pair',
    );
    assert.ok(
      src.includes('laneOffset'),
      'every edge carries its lane offset',
    );
    // Подпись — имя СТОРОНЫ центральной мысли, а не всегда forward.
    assert.ok(
      /edgeTypeName\(type, oriented\.fromCenter\)/.test(src),
      'the line label is the side name of the central thought',
    );
  });

  it('graph-tab резолвит соседей до полных карточек (значки/цвета) для графа', () => {
    const src = readText(SRC.graphTab);
    assert.ok(
      /etn\.thoughts\.resolve\(\s*networkId,\s*neighbours\.slice\(0,\s*(?:RESOLVE_BATCH|100)\b/.test(src),
      'neighbours are batch-resolved to ThoughtRef before building the graph',
    );
    assert.ok(
      /neighbours: ThoughtRef\[\]/.test(src) || /graphRefs: ThoughtRef\[\]/.test(src),
      'the graph receives full ThoughtRef cards',
    );
    assert.ok(
      src.includes('fillHeight: true'),
      'graph-tab requests the mini-graph to fill the tab pane',
    );
  });

  it('рёбра берут направление и тип у САМОЙ связи (обёртка grouped разворачивается) — п.1/3/4', () => {
    const src = readText(SRC.graphTab);
    // Регрессия 6811d5e7: `by_type.items`/`untyped_*` — не `Link`, а
    // `{ link, target_thought }`; приведение к `Link` теряло direction и тип,
    // из-за чего стрелки шли «от центра», а тултип и оформление пустели.
    assert.ok(
      src.includes('grouped.by_type.flatMap((g) => g.items.map((i) => i.link))'),
      'typed groups are unwrapped through .item.link',
    );
    assert.ok(
      src.includes('grouped.untyped_parents.map((u) => u.link)') &&
        src.includes('grouped.untyped_children.map((u) => u.link)'),
      'untyped groups are unwrapped through .link',
    );
    assert.ok(
      !src.includes('as unknown as Link[]'),
      'no blind cast of the grouped response to Link[] remains',
    );
    const graph = readText(SRC.graph);
    assert.ok(graph.includes('orientLink('), 'edge direction comes from the model');
    assert.ok(graph.includes('edgeTooltip('), 'the tooltip is built by the model');
    assert.ok(graph.includes('resolveEdgeVisual('), 'line styling comes from the type');
  });

  it('граф независим от отборов карты мыслей — п.5', () => {
    const src = readText(SRC.graphTab);
    // Источник — собственные запросы вкладки без link_filter/фильтра типов;
    // отбор карты (store.state.canvasLinkFilter) к графу не применяется.
    assert.ok(
      !src.includes('canvasLinkFilter'),
      'the canvas link-type filter is never applied to the graph',
    );
    assert.ok(
      !/link_filter\s*:/.test(src),
      'no link_filter object is passed to the graph queries',
    );
    assert.ok(
      /etn\.thoughts\.neighbors\(networkId, ctx\.ownerId, 'parents', 200\)/.test(src) &&
        /etn\.thoughts\.neighbors\(networkId, ctx\.ownerId, 'children', 200\)/.test(src),
      'structural neighbours come from unfiltered dedicated calls',
    );
    assert.ok(
      /etn\.links\.listByThought\(networkId, ctx\.ownerId, true\)/.test(src),
      'all links come from listByThought without a type filter',
    );
    assert.ok(
      src.includes('computeMassLinks('),
      'mass-link counting is delegated to the pure model',
    );
  });

  it('шапка — понятные показатели с подсказками, механика скрытия объяснена — п.6', () => {
    const graph = readText(SRC.graph);
    assert.ok(graph.includes('computeGraphStats('), 'header counters come from the model');
    assert.ok(graph.includes('graphStatEntries('), 'labels/tooltips come from the model');
    assert.ok(
      /setTooltip\(stat, entry\.tooltip\)/.test(graph),
      'every header stat carries an explanatory tooltip',
    );
    const model = readText(SRC.model);
    for (const label of ['Соседей:', 'Скрыто массовых:', 'Ещё не поместилось:']) {
      assert.ok(model.includes(label), `the model names the stat «${label}»`);
    }
    assert.ok(
      model.includes('вкладке «Связи»'),
      'the tooltip explains how to see the hidden links',
    );
  });

  it('линии оформляются кастомными свойствами (подсветка не перебивается) — п.4', () => {
    const src = readText(SRC.graph);
    assert.ok(src.includes("setProperty('--edge-color'"), 'edge colour is a CSS custom property');
    assert.ok(src.includes("setProperty('--edge-width'"), 'edge width follows the type');
    const css = readText(SRC.css);
    assert.ok(
      css.includes('stroke: var(--edge-color, var(--border-strong))'),
      'CSS falls back to the neutral colour when the type sets none',
    );
    assert.ok(
      /\.mini-graph-edge-arrow\s*\{[^}]*fill: var\(--edge-color/.test(css),
      'the arrow shares the line colour',
    );
  });

  it('помеченное на удаление ребро отличимо: приглушение, пунктир, тултип, метка корзины — 355319d4', () => {
    const src = readText(SRC.graph);
    assert.ok(src.includes('isTrashedEdge('), 'trash state comes from the pure model');
    assert.ok(
      src.includes("'mini-graph-edge trashed'") && src.includes("'mini-graph-edge-arrow trashed'"),
      'the dimming class is applied to the line and its arrow',
    );
    assert.ok(
      /edgeTooltip\(edge\.label, edge\.source\.title, edge\.target\.title, trashed\)/.test(src),
      'the edge tooltip carries the «(в корзине)» marker',
    );
    assert.ok(
      src.includes("svgEl('foreignObject')") && src.includes("'mini-graph-edge-trash'"),
      'the trash badge is an SVG foreignObject over the line',
    );
    assert.ok(
      /openTrashedLinkDialog\(linkId\)/.test(src) && src.includes("import('../trash.js')"),
      'the badge opens the link delete/restore dialog (lazy import, no cycle)',
    );
    assert.ok(
      /badge\.setAttribute\('x', String\(bx - TRASH_BADGE_SIZE \/ 2\)\)/.test(src),
      'the badge follows the edge geometry every frame',
    );
    const css = readText(SRC.css);
    assert.ok(css.includes('.mini-graph-edge.trashed'), 'CSS dims the trashed line');
    assert.ok(css.includes('.mini-graph-edge-trash'), 'CSS styles the badge container');
    // Правило пометки живёт в модели — оформление не может разойтись с тултипом.
    const model = readText(SRC.model);
    assert.ok(model.includes('TRASHED_EDGE_DASH'), 'the dash rule lives in the model');
    assert.ok(model.includes('isTrashedEdge(link)'), 'the model decides the trashed dash');
  });
});
