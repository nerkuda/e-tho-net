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

const SRC = {
  graph: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'mini-graph.ts'),
  graphTab: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'graph-tab.ts'),
  css: resolve(import.meta.dirname, '..', 'src', 'renderer', 'styles.css'),
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

  it('зум — колесо, пан — правая кнопка (единый фильтр d3-zoom)', () => {
    const src = readText(SRC.graph);
    assert.ok(
      /event\.type === 'wheel' \|\| \(event\.type === 'mousedown' && event\.button === 2\)/.test(
        src,
      ),
      'zoom filter: wheel or right button only',
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

  it('облачка мыс­лей — как везде: значок (эмодзи/картинка), цвета, шрифт, dim, корзина', () => {
    const src = readText(SRC.graph);
    for (const anchor of [
      'cloudVisual', // вид пилюли (fg/bg/font_*)
      "svgEl('image')", // иконка-картинка рисуется как SVG <image>
      'mini-node-icon',
      'mini-node-trash', // помеченная на удаление
      "classList.add('dim')", // неактуальная — бледная
    ]) {
      assert.ok(src.includes(anchor), `node rendering includes ${anchor}`);
    }
    assert.ok(
      src.includes('markThoughtCommentPreview'),
      'Ctrl+hover preview is wired on nodes',
    );
  });

  it('значок и цвет пилюли разрешает общий слой канваса, а не чтение полей ref', () => {
    // Регрессия: пилюля читала `ref.icon`/`ref.bg_color` напрямую, из-за чего
    // своя иконка показывалась всегда, типовая — не всегда (наследование
    // подтягивалось вручную и только с непосредственного типа, без цепочки
    // предков), а дефолт приложения 💭 — никогда.
    const src = readText(SRC.graph);
    assert.ok(
      /import \{[\s\S]*?resolveCloudStyle[\s\S]*?resolveThoughtIcon[\s\S]*?\} from '\.\.\/canvas\/canvas\.js'/.test(
        src,
      ),
      'pill visuals are resolved by the shared canvas helpers',
    );
    assert.ok(
      src.includes('resolveThoughtIcon(node.ref)'),
      'the node icon is resolved (own → type chain → app default)',
    );
    assert.ok(
      src.includes("resolvedIcon.icon ?? '💭'"),
      'the app default icon is drawn when neither the thought nor its type sets one',
    );
    assert.ok(
      /const style = resolveCloudStyle\(ref\);/.test(src),
      'cloud colours/fonts come from resolveCloudStyle',
    );
    assert.ok(
      !src.includes('node.ref.icon') && !src.includes('ref.bg_color ??'),
      'the pill does not read the ref visual fields directly',
    );
    // graph-tab больше не достраивает наследование руками — иначе два разных
    // правила наследования снова разъедутся.
    assert.ok(
      !readText(SRC.graphTab).includes('inheritFromType'),
      'graph-tab does not hand-roll type inheritance',
    );
  });

  it('пилюля центрирована на узле (rect x/y) — заголовок и иконка внутри неё', () => {
    // Регрессия: rect без x/y рисуется от (0,0) вправо-вниз, а текст/иконка
    // позиционированы от центра — облачко «отклеивалось» от содержимого.
    const src = readText(SRC.graph);
    assert.ok(
      src.includes("rect.setAttribute('x', String(-node.w / 2))"),
      'cloud rect is centered horizontally',
    );
    assert.ok(
      src.includes("rect.setAttribute('y', String(-CLOUD_H / 2))"),
      'cloud rect is centered vertically',
    );
  });

  it('клики как на канвасе: Ctrl+клик — выделение, одиночный отложен (dblclick успевает)', () => {
    const src = readText(SRC.graph);
    assert.ok(
      src.includes('deferSingleClick'),
      'single click is deferred so dblclick (focus) wins the race',
    );
    assert.ok(
      src.includes('toggleSelection([node.id])'),
      'Ctrl+click toggles the selection panel membership',
    );
    assert.ok(
      src.includes('event.ctrlKey || event.metaKey'),
      'Ctrl and Cmd are both honoured',
    );
    // d3-drag стартует на mousedown: подавление клика — только при реальном
    // движении, иначе каждый клик глох как drag (баг приёмки 0.8.1).
    assert.ok(
      !/on\('start', \(\) => \{\s*draggedByDrag\.add/.test(src),
      'the drag-suppression flag is NOT set on drag start (mousedown)',
    );
    assert.ok(
      /on\('drag', \(event\) => \{[\s\S]*?draggedByDrag\.add\(g\)/.test(src),
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
});
