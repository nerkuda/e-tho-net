/**
 * Unit tests for the link-overlay helpers
 * (client/src/renderer/canvas/links.ts): directed-pair bundling that drives
 * the line-per-pair rendering, and the endpoint-visibility geometry that
 * hides lines to clouds clipped outside a zone's scroll window. The DOM/SVG
 * rendering itself is covered by manual/E2E checks.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { FocusEdge } from '@etn/shared';

import { linksInternals } from '../src/renderer/canvas/links.js';
import { assembledStylesFile } from './renderer-css.js';

const LINKS_SRC = resolve(import.meta.dirname, '..', 'src', 'renderer', 'canvas', 'links.ts');
const STYLES_SRC = assembledStylesFile();

const { groupBundles, bundleTrashed, rectFitsInside, edgeGeometry, edgePointAt } =
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

describe('rectFitsInside (visibility of link endpoints)', () => {
  const zone = { left: 0, right: 300, top: 0, bottom: 200 };

  it('a cloud fully inside the zone scroll window is visible', () => {
    assert.equal(rectFitsInside({ left: 12, right: 100, top: 10, bottom: 90 }, zone), true);
  });

  it('a cloud clipped by the zone edge (overscan row) is not visible', () => {
    assert.equal(rectFitsInside({ left: 12, right: 100, top: 150, bottom: 260 }, zone), false);
    assert.equal(rectFitsInside({ left: 12, right: 100, top: -40, bottom: 60 }, zone), false);
    assert.equal(rectFitsInside({ left: 250, right: 360, top: 10, bottom: 90 }, zone), false);
  });

  it('tolerates sub-pixel layout rounding but not real overflow', () => {
    assert.equal(
      rectFitsInside({ left: 0.4, right: 300.6, top: -0.4, bottom: 200.4 }, zone),
      true,
    );
    assert.equal(
      rectFitsInside({ left: 0.4, right: 300.6, top: -0.4, bottom: 205 }, zone),
      false,
    );
  });
});
