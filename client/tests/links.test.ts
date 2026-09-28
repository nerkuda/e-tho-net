/**
 * Unit tests for the link-overlay helpers
 * (client/src/renderer/canvas/links.ts): directed-pair bundling that drives
 * the line-per-pair rendering, the canvas-window drawability geometry (a line
 * exists for ANY pair of clouds inside the canvas, whatever zone each cloud
 * lives in — ошибка 16a77453), and the two architectural invariants that keep
 * cross-zone lines continuous (one host-level overlay + an explicit SVG
 * viewport equal to the host box). The DOM/SVG
 * rendering itself is covered by manual/E2E checks and by the source-anchor
 * block at the end of this file.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { FocusEdge, FocusResponse, Thought } from '@etn/shared';

import { initLinksOverlay, linksInternals, setSupplementalEdges } from '../src/renderer/canvas/links.js';
import { assembledStylesFile } from './renderer-css.js';
import { ShimElement } from './dom-shim.js';

const LINKS_SRC = resolve(import.meta.dirname, '..', 'src', 'renderer', 'canvas', 'links.ts');
const CANVAS_SRC = resolve(import.meta.dirname, '..', 'src', 'renderer', 'canvas', 'canvas.ts');
const STYLES_SRC = assembledStylesFile();

const { groupBundles, bundleTrashed, rectsOverlap, edgeGeometry, edgePointAt, edgeSource } =
  linksInternals;

function edge(
  id: string,
  sourceId: string,
  targetId: string,
  typeId: string | null = null,
  trashed = false,
): FocusEdge {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    type_id: typeId,
    link_marked_for_deletion: trashed,
    color: null,
    style: null,
    width: null,
  };
}

/** Минимальная пачка для проверки правил пометки (Bundle не экспортируется). */
function bundleOf(edges: FocusEdge[]): Parameters<typeof bundleTrashed>[0] {
  return {
    key: edges.map((e) => `${e.source_id}>${e.target_id}`)[0] ?? '',
    sourceId: edges[0]?.source_id ?? '',
    targetId: edges[0]?.target_id ?? '',
    edges,
  };
}

describe('groupBundles (link overlay)', () => {
  it('groups edges of the same directed pair into one bundle', () => {
    const bundles = groupBundles([
      edge('l1', 'A', 'B', 't1'),
      edge('l2', 'A', 'B', 't2'),
    ]);
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0]?.key, 'A>B');
    assert.equal(bundles[0]?.sourceId, 'A');
    assert.equal(bundles[0]?.targetId, 'B');
    assert.equal(bundles[0]?.edges.length, 2);
  });

  it('keeps opposite directions as separate bundles', () => {
    const bundles = groupBundles([edge('l1', 'A', 'B'), edge('l2', 'B', 'A')]);
    assert.equal(bundles.length, 2);
    assert.deepEqual(
      bundles.map((b) => b.key).sort(),
      ['A>B', 'B>A'],
    );
  });

  it('one bundle per distinct pair across many edges', () => {
    const bundles = groupBundles([
      edge('l1', 'A', 'B'),
      edge('l2', 'A', 'C'),
      edge('l3', 'A', 'B'),
      edge('l4', 'B', 'A'),
      edge('l5', 'A', 'B'),
    ]);
    // A>B (3), A>C (1), B>A (1)
    const byKey = new Map(bundles.map((b) => [b.key, b.edges.length]));
    assert.equal(byKey.get('A>B'), 3);
    assert.equal(byKey.get('A>C'), 1);
    assert.equal(byKey.get('B>A'), 1);
  });

  it('returns an empty list for no edges', () => {
    assert.deepEqual(groupBundles([]), []);
  });
});

describe('bundleTrashed (рёбра в корзине, 355319d4)', () => {
  it('пачка помечена, когда КАЖДОЕ её ребро помечено на удаление', () => {
    assert.equal(bundleTrashed(bundleOf([edge('l1', 'A', 'B', null, true)])), true);
    assert.equal(
      bundleTrashed(bundleOf([edge('l1', 'A', 'B', null, true), edge('l2', 'A', 'B', null, true)])),
      true,
    );
  });

  it('живое ребро в пачке делает линию живой (смешанная пачка)', () => {
    assert.equal(bundleTrashed(bundleOf([edge('l1', 'A', 'B', null, true), edge('l2', 'A', 'B')])), false);
  });

  it('пустая пачка не считается помеченной', () => {
    assert.equal(bundleTrashed(bundleOf([])), false);
  });
});

/**
 * Разметку SVG-слоя шим не воспроизводит (см. шапку файла) — стережём якоря
 * исходника, как это делают структурные тесты мини-графа: пунктир/приглушение/
 * подпись, кликабельная метка корзины и её обработчик.
 */
describe('помеченное ребро на карте — якоря отрисовки (355319d4)', () => {
  it('приглушение + пунктир + подпись «(в корзине)» на видимой линии', () => {
    const src = readFileSync(LINKS_SRC, 'utf8');
    assert.ok(src.includes("const TRASHED_DASH = '4 4'"), 'штриховая линия корзины');
    assert.ok(src.includes('TRASHED_OPACITY'), 'приглушение линии корзины');
    assert.ok(src.includes("classList.add('link-trashed')"), 'класс помеченной линии');
    assert.ok(src.includes('TRASHED_LABEL_SUFFIX'), 'подпись «в корзине» у типа связи');
    assert.ok(src.includes("' · в корзине'"), 'попап называет корзину словами');
    assert.ok(src.includes("'Связь в корзине'"), 'подсказка линии называет корзину');
  });

  it('клик по метке корзины открывает диалог связи (восстановление)', () => {
    const src = readFileSync(LINKS_SRC, 'utf8');
    assert.ok(src.includes("el('button', 'link-trash-badge')"), 'метка — кнопка');
    assert.ok(src.includes("import('../trash.js')"), 'ленивый импорт без цикла');
    assert.ok(src.includes('openLinkDeleteDialog(networkId, linkId)'), 'диалог удаления/восстановления');
    assert.ok(/\bbundleTrashed\(bundle\)\) drawTrashBadge\(svgHit/.test(src), 'метка в интерактивном слое');
  });

  it('CSS метки корзины есть, а помеченная линия не исчезает', () => {
    const css = readFileSync(STYLES_SRC, 'utf8');
    assert.ok(css.includes('.link-line.link-trashed'), 'класс линии стилизован');
    assert.ok(css.includes('.link-trash-badge'), 'класс метки стилизован');
  });
});

describe('edgeGeometry (Bézier link curves, L14)', () => {
  it('keeps the curve midpoint on the vertical axis of a straight edge', () => {
    // Downward edge (0,0)→(0,100): bend = max(24, 45) = 45 → mid exactly (0,50).
    const geo = edgeGeometry({ x: 0, y: 0 }, { x: 0, y: 100 });
    assert.equal(geo.mid.x, 0);
    assert.equal(geo.mid.y, 50);
    assert.equal(geo.d, 'M 0 0 C 0 45, 0 55, 0 100');
  });

  it('clamps the bend: floor for short edges, ceiling for long ones', () => {
    // Short edge: bend floored at 24.
    assert.equal(edgeGeometry({ x: 0, y: 0 }, { x: 0, y: 10 }).d, 'M 0 0 C 0 24, 0 -14, 0 10');
    // Long edge: bend capped at 140.
    assert.equal(edgeGeometry({ x: 0, y: 0 }, { x: 0, y: 1000 }).d, 'M 0 0 C 0 140, 0 860, 0 1000');
  });

  it('horizontal edges get a gentle S-curve with the midpoint on the chord', () => {
    const geo = edgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 });
    assert.equal(geo.mid.x, 50);
    assert.equal(geo.mid.y, 0);
    // Control points symmetric around the chord.
    assert.equal(geo.d, 'M 0 0 C 0 24, 100 -24, 100 0');
  });
});

describe('edgePointAt (якорь метки корзины, 355319d4)', () => {
  it('t = 0 / 1 — концы кривой, t = 0.5 совпадает с серединой edgeGeometry', () => {
    const from = { x: 10, y: 20 };
    const to = { x: 120, y: 220 };
    assert.deepEqual(edgePointAt(from, to, 0), from);
    assert.deepEqual(edgePointAt(from, to, 1), to);
    assert.deepEqual(edgePointAt(from, to, 0.5), edgeGeometry(from, to).mid);
  });

  it('метка корзины стоит ВНЕ середины (там подпись типа и бейдж пачки)', () => {
    const mid = edgeGeometry({ x: 0, y: 0 }, { x: 0, y: 100 }).mid;
    const badge = edgePointAt({ x: 0, y: 0 }, { x: 0, y: 100 }, 0.3);
    assert.notEqual(badge.y, mid.y);
  });
});

describe('rectsOverlap (pure geometry, 16a77453)', () => {
  const zone = { left: 0, right: 300, top: 0, bottom: 200 };

  it('a cloud fully inside the window is on-screen', () => {
    assert.equal(rectsOverlap({ left: 12, right: 100, top: 10, bottom: 90 }, zone), true);
  });

  it('a cloud PARTLY clipped by a window edge is still on-screen', () => {
    // Облачко ушло за край окна наполовину — линия обязана остаться (раньше
    // её ронял полноохватный тест containment, а с ней пропадал и hover).
    assert.equal(rectsOverlap({ left: 12, right: 100, top: -40, bottom: 60 }, zone), true);
    // То же у нижнего края и у правого.
    assert.equal(rectsOverlap({ left: 12, right: 100, top: 150, bottom: 260 }, zone), true);
    assert.equal(rectsOverlap({ left: 250, right: 360, top: 10, bottom: 90 }, zone), true);
  });

  it('a cloud fully outside the window carries no line', () => {
    assert.equal(rectsOverlap({ left: 12, right: 100, top: -120, bottom: -20 }, zone), false);
    assert.equal(rectsOverlap({ left: 12, right: 100, top: 210, bottom: 300 }, zone), false);
    assert.equal(rectsOverlap({ left: -120, right: -20, top: 10, bottom: 90 }, zone), false);
  });

  it('ignores a sub-pixel graze of the clip edge, counts a real overlap', () => {
    // Облачко полностью за краем: пересечение по Y всего 0.4px — линии нет.
    assert.equal(
      rectsOverlap({ left: 0.4, right: 300.6, top: -40, bottom: 0.4 }, zone),
      false,
    );
    // Заметно видимая часть — линии быть.
    assert.equal(
      rectsOverlap({ left: 0.4, right: 300.6, top: -40, bottom: 40 }, zone),
      true,
    );
  });
});

/**
 * Межзонная связь: линия — ОДНА кривая в координатах холста, а не набор
 * отрезков по зонам. Стражи на правило существования линии (оба конца должны
 * быть видны хотя бы частью в своём окне прокрутки — условие отрисовки из
 * элемента «Линия связи на холсте») и на геометрию, которой это правило
 * пользуется.
 */
describe('межзонная линия: видимость концов и одна кривая на пару (16a77453)', () => {
  // Холст 1000×700; верх-лево — окно 0..480, верх-право — 488..1000.
  const parentZone = { left: 0, right: 480, top: 0, bottom: 420 };
  const siblingZone = { left: 488, right: 1000, top: 0, bottom: 420 };

  it('облачка в РАЗНЫХ зонах, каждое видно в своём окне — линия проводится', () => {
    const parent = { left: 100, right: 300, top: 40, bottom: 80 };
    const sibling = { left: 600, right: 800, top: 300, bottom: 340 };
    assert.equal(rectsOverlap(parent, parentZone), true);
    assert.equal(rectsOverlap(sibling, siblingZone), true);
    // Оба конца проходят условие отрисовки → пара рисуется ОДНОЙ кривой:
    // слои связей живут на холсте, а не внутри зон (см. блок инвариантов).
  });

  it('конец, целиком выехавший за окно своей зоны, линии не даёт', () => {
    const parent = { left: 100, right: 300, top: 40, bottom: 80 };
    const offZone = { left: 600, right: 800, top: 430, bottom: 470 };
    assert.equal(rectsOverlap(parent, parentZone), true);
    assert.equal(rectsOverlap(offZone, siblingZone), false);
  });

  it('правило отрисовки использует окно СВОЕЙ зоны облачка (элемент 646eafcf)', () => {
    const src = readFileSync(LINKS_SRC, 'utf8');
    const rule = src.slice(src.indexOf('function isCloudVisible'));
    const body = rule.slice(0, rule.indexOf('\n}'));
    assert.ok(body.includes("closest('.zone')"), 'окно прокрутки берётся у своей зоны');
    assert.ok(body.includes('rectsOverlap('), 'условие — пересечение, а не полное вхождение');
  });
});

/**
 * Архитектурные инварианты непрерывности линий (ошибка 16a77453): единый
 * слой связей над всеми зонами + явный вьюпорт SVG, равный коробке холста.
 * Если любой из них нарушить, межзонная линия снова начнёт обрываться — на
 * границе зоны (первый) или на произвольной высоте внутри контейнера
 * (второй).
 */
describe('слой связей: одна общая коробка над всеми зонами (16a77453)', () => {
  it('все четыре слоя вешаются на ХОЛСТ, а не на зону', () => {
    const src = readFileSync(LINKS_SRC, 'utf8');
    assert.match(src, /host\.prepend\(svg\);/, 'визуальный слой — первый ребёнок холста');
    assert.match(src, /host\.append\(svgHit, svgTop, svgDrag\);/, 'hit/top/drag — последние дети холста');
    assert.ok(
      !/\.zone[^\n]*\.(append|prepend|appendChild)\(/.test(src),
      'слои связей не должны попадать внутрь зоны: её overflow обрежет линии',
    );
  });

  it('линия и hit-кривая создаются вместе и по одной геометрии, все ветки — по одному правилу', () => {
    const src = readFileSync(LINKS_SRC, 'utf8');
    assert.equal(
      (src.match(/isCloudVisible\(/g) ?? []).length,
      7, // объявление + 6 вызовов (draw, подсветка эллипса, активная пачка — по 2 конца)
      'все ветки отрисовки используют одно правило видимости',
    );
    // Одна пара = одна геометрия на оба слоя: визуальная кривая и широкая
    // hit-кривая получают одни и те же `from`/`to`.
    assert.match(
      src,
      /drawVisualLine\(bundle, from, to\);\s*drawHitLine\(bundle, from, to\);/,
      'визуал и hit строятся из одной пары точек',
    );
    assert.match(src, /hit\.setAttribute\('d', edgeGeometry\(from, to\)\.d\)/, 'hit повторяет кривую');
  });

  it('hover-кривая живёт там же, где линия, и ловит события по всей длине', () => {
    const src = readFileSync(LINKS_SRC, 'utf8');
    assert.match(src, /hit\.addEventListener\('mouseenter'/, 'наведение');
    assert.match(src, /hit\.addEventListener\('mouseleave'/, 'уход курсора');
    assert.match(src, /hit\.addEventListener\('click'/, 'клик');
    assert.match(src, /hit\.addEventListener\('contextmenu'/, 'контекстное меню');
    const css = readFileSync(STYLES_SRC, 'utf8');
    assert.ok(css.includes('.links-overlay-hit .link-hit'), 'hit-слой стилизован');
    assert.match(css, /\.link-hit\s*\{[^}]*pointer-events:\s*stroke/s, 'hit-кривая ловит указатель по штриху');
  });

  it('вьюпорт SVG явно равен коробке холста (иначе SVG срежет путь на своей высоте)', () => {
    const src = readFileSync(LINKS_SRC, 'utf8');
    assert.match(src, /layer\.setAttribute\('viewBox', `0 0 \$\{w\} \$\{h\}`\)/, 'viewBox по коробке холста');
    assert.match(src, /layer\.setAttribute\('preserveAspectRatio', 'none'\)/, 'координаты 1:1 без letterbox');
    assert.match(src, /syncOverlayViewport\(\);/, 'вьюпорт синхронизируется (mount/resize/scroll/draw)');
  });
});

/**
 * DOM-шим: `initLinksOverlay` реально ставит вьюпорт SVG по коробке холста и
 * не кладёт слои в зону. Раскладки у шима нет — важна только арифметика
 * размеров и структура DOM.
 */
describe('initLinksOverlay: вьюпорт и структура слоёв (DOM-шим, 16a77453)', () => {
  function withShim<T>(fn: () => T): T {
    const globals = globalThis as any;
    const prevDoc = globals.document;
    const prevRO = globals.ResizeObserver;
    globals.document = {
      createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
      createElement: (tag: string) => new ShimElement(tag),
    };
    globals.ResizeObserver = class {
      observe(): void {
        /* раскладки нет */
      }
      disconnect(): void {
        /* раскладки нет */
      }
    };
    try {
      return fn();
    } finally {
      if (prevDoc === undefined) delete globals.document;
      else globals.document = prevDoc;
      if (prevRO === undefined) delete globals.ResizeObserver;
      else globals.ResizeObserver = prevRO;
    }
  }

  it('каждый слой получает width/height/viewBox коробки холста', () => {
    withShim(() => {
      const host = new ShimElement('div', 'canvas');
      host.rect = { left: 0, top: 0, right: 1234, bottom: 777, width: 1234, height: 777 };
      initLinksOverlay(host as unknown as HTMLElement);
      const layers = host.children.filter((c) => c.tagName === 'svg');
      assert.equal(layers.length, 4, 'четыре слоя связей');
      for (const layer of layers) {
        assert.equal(layer.getAttribute('width'), '1234', `width слоя ${layer.className}`);
        assert.equal(layer.getAttribute('height'), '777', `height слоя ${layer.className}`);
        assert.equal(layer.getAttribute('viewBox'), '0 0 1234 777', `viewBox слоя ${layer.className}`);
        assert.equal(layer.getAttribute('preserveAspectRatio'), 'none');
      }
    });
  });

  it('слои лежат в холсте, а не в зоне', () => {
    withShim(() => {
      const host = new ShimElement('div', 'canvas');
      host.rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
      const zone = new ShimElement('div', 'zone zone-parents');
      host.append(zone);
      initLinksOverlay(host as unknown as HTMLElement);
      const layers = host.children.filter((c) => c.tagName === 'svg');
      assert.equal(layers.length, 4);
      for (const layer of layers) {
        assert.equal(layer.parent, host, 'слой висит прямо на холсте');
        assert.equal(layer.closest('.zone'), null, 'слой не внутри зоны');
      }
      // Визуальный слой — до зоны, hit/top/drag — после: облачка выше линий.
      assert.equal(host.children[0], layers.find((l) => l.classList.contains('links-overlay')));
    });
  });
});

/**
 * Источник рёбер оверлея при активной догрузке порций (ошибка c02ff7dc).
 *
 * `POST /thoughts/edges` даёт снимок рёбер среди ВСЕХ видимых мыслей, но
 * обновляется лишь при догрузке. Если этот снимок заменял `focus.edges`,
 * локальное «Удалить совсем» убирало связь из `focus.edges`, но не из снимка —
 * линия висела на карте до смены фокуса. Общие рёбра обязаны браться из живого
 * `focus.edges`, снимок хранит только рёбра вне него.
 */
describe('edgeSource: живые рёбра фокуса + подгруженные (ошибка c02ff7dc)', () => {
  const thought = (id: string): Thought => ({
    id,
    title: id,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    is_protected: false,
    is_root: false,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });

  const focus = (edges: FocusEdge[]): FocusResponse => ({
    focused: thought('f'),
    parents: [],
    siblings: [],
    children: [],
    edges,
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  });

  const ids = (list: FocusEdge[]): string[] => list.map((e) => e.id).sort();

  it('без подгруженного набора рисует рёбра фокуса', () => {
    setSupplementalEdges(null);
    assert.deepEqual(ids(edgeSource(focus([edge('A', 'f', 'p')]))), ['A']);
  });

  it('подгруженные рёбра вне фокуса добавляются к живым', () => {
    // Снимок по видимым мыслям: общее ребро A и связь подгруженных соседей B.
    setSupplementalEdges([edge('A', 'f', 'p'), edge('B', 'p', 'c')], [edge('A', 'f', 'p')]);
    assert.deepEqual(ids(edgeSource(focus([edge('A', 'f', 'p')]))), ['A', 'B']);
    setSupplementalEdges(null);
  });

  it('удалённое общее ребро исчезает, хотя снимок его помнит (регресс)', () => {
    setSupplementalEdges([edge('A', 'f', 'p'), edge('B', 'p', 'c')], [edge('A', 'f', 'p')]);
    // Локальное «Удалить совсем» (patchFocusEdge) убрало A из живого ответа
    // фокуса; снимок ещё держит A, но рисоваться он не должен.
    assert.deepEqual(ids(edgeSource(focus([]))), ['B']);
    setSupplementalEdges(null);
  });

  it('не дублирует рёбра, попавшие и в фокус, и в снимок', () => {
    setSupplementalEdges([edge('A', 'f', 'p'), edge('B', 'p', 'q')], []);
    assert.deepEqual(ids(edgeSource(focus([edge('A', 'f', 'p')]))), ['A', 'B']);
    setSupplementalEdges(null);
  });

  it('canvas перечитывает снимок на свежем ответе того же фокуса (canvas.ts)', () => {
    // Поведенческая проверка недостижима: `syncZoneTotalsWithFreshFocus` и
    // `refreshZoneEdges` не экспортированы, а их прогон требует полностью
    // смонтированного холста, реестра ссылок и мок-API ETN — это не
    // пропорционально предмету. Контракт стережём структурно, но без привязки к
    // форматированию: ищем цепочку «сверка секторов → (при наличии снимка)
    // перечитать рёбра» регулярным выражением по вызовам, а не по подстрокам
    // с точным отступом и порядком пробелов.
    const src = readFileSync(CANVAS_SRC, 'utf8');
    assert.match(
      src,
      /reconcileZoneTotals\(focus\)\.then\(\(\) => \{[\s\S]*?if \(hasSupplementalEdges\(\)\) void refreshZoneEdges\(focus\)/,
      'снимок перечитывается ПОСЛЕ сверки секторов и только когда он есть',
    );
  });
});
