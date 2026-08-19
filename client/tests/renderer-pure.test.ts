/**
 * Unit tests for renderer pure helpers (client/src/renderer/lib/pure.ts).
 *
 * These run in Node (no DOM): title/synonym parsing, cloud geometry clipping,
 * collapsed-groups parsing and realtime event narrowing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLOUD_GAP_DEFAULT,
  CLOUD_GAP_MAX,
  CLOUD_GAP_MIN,
  CLOUD_WIDTH_DEFAULT,
  CLOUD_WIDTH_MAX,
  CLOUD_WIDTH_MIN,
  EDITOR_H_DEFAULT,
  EDITOR_H_MAX,
  EDITOR_H_MIN,
  EDITOR_W_DEFAULT,
  EDITOR_W_MAX,
  EDITOR_W_MIN,
  SELECTION_W_DEFAULT,
  SELECTION_W_MAX,
  SELECTION_W_MIN,
} from '@etn/shared';

import {
  clip,
  cloudFontSize,
  cloudGeom,
  cloudHeight,
  describeEvent,
  isRealtimeEvent,
  parseAddLines,
  parseCanvasLayout,
  parseCanvasZoom,
  contrastText,
  parseTheme,
  parseCloudGap,
  parseCloudWidth,
  parseCollapsedGroups,
  parseLinkTypeId,
  parseTitleWithSynonyms,
  parseWindowLayout,
  shortenCompoundName,
  splitCompoundName,
  zoomStep,
} from '../src/renderer/lib/pure.js';

import type { AnyRealtimeEvent, FocusEdge, FocusResponse, Link, Thought } from '@etn/shared';

import { searchInternals } from '../src/renderer/search/search.js';
import { flipTransform } from '../src/renderer/canvas/transition.js';
import { zoomable } from '../src/renderer/lib/image-zoom.js';
import { focusEdgesSignature, patchFocusEdge, store } from '../src/renderer/state.js';

const { scopesFor, mergeResponses, DEFAULT_OPTIONS, isSearchableQuery, nextNavIndex } =
  searchInternals;

describe('clip', () => {
  it('clamps into the range', () => {
    assert.equal(clip(5, 0, 10), 5);
    assert.equal(clip(-1, 0, 10), 0);
    assert.equal(clip(99, 0, 10), 10);
  });
});

describe('cloud geometry', () => {
  it('font size grows monotonically with width', () => {
    const min = cloudFontSize(CLOUD_WIDTH_MIN);
    const max = cloudFontSize(CLOUD_WIDTH_MAX);
    assert.ok(max > min);
    assert.equal(min, 12);
    assert.equal(max, 16);
  });

  it('cloud height is fixed for a fixed width and stays positive', () => {
    const h = cloudHeight(200);
    assert.ok(h > 0);
    assert.equal(cloudHeight(200), h);
  });

  it('parses ui_state width/gap with clipping to system constants', () => {
    assert.equal(parseCloudWidth(null), CLOUD_WIDTH_DEFAULT);
    assert.equal(parseCloudWidth('abc'), CLOUD_WIDTH_DEFAULT);
    assert.equal(parseCloudWidth('1'), CLOUD_WIDTH_MIN);
    assert.equal(parseCloudWidth('9999'), CLOUD_WIDTH_MAX);
    assert.equal(parseCloudWidth('250'), 250);
    assert.equal(parseCloudGap(null), CLOUD_GAP_DEFAULT);
    assert.equal(parseCloudGap('0'), CLOUD_GAP_MIN);
    assert.equal(parseCloudGap('1000'), CLOUD_GAP_MAX);
    assert.equal(parseCloudGap('20'), 20);
  });
});

describe('parseWindowLayout', () => {
  it('falls back to defaults for missing/invalid input', () => {
    assert.deepEqual(parseWindowLayout(null), {
      w: EDITOR_W_DEFAULT,
      h: EDITOR_H_DEFAULT,
      s: SELECTION_W_DEFAULT,
    });
    assert.deepEqual(parseWindowLayout(''), {
      w: EDITOR_W_DEFAULT,
      h: EDITOR_H_DEFAULT,
      s: SELECTION_W_DEFAULT,
    });
    assert.deepEqual(parseWindowLayout('not json'), {
      w: EDITOR_W_DEFAULT,
      h: EDITOR_H_DEFAULT,
      s: SELECTION_W_DEFAULT,
    });
  });

  it('parses a {w,h,s} JSON object and clamps to editor/selection constants', () => {
    assert.deepEqual(parseWindowLayout('{"w":500,"h":400,"s":250}'), { w: 500, h: 400, s: 250 });
    assert.deepEqual(parseWindowLayout('{"w":10,"h":10,"s":10}'), {
      w: EDITOR_W_MIN,
      h: EDITOR_H_MIN,
      s: SELECTION_W_MIN,
    });
    assert.deepEqual(parseWindowLayout('{"w":99999,"h":99999,"s":99999}'), {
      w: EDITOR_W_MAX,
      h: EDITOR_H_MAX,
      s: SELECTION_W_MAX,
    });
  });

  it('keeps a valid dimension when the other is missing/invalid', () => {
    assert.deepEqual(parseWindowLayout('{"w":450}'), {
      w: 450,
      h: EDITOR_H_DEFAULT,
      s: SELECTION_W_DEFAULT,
    });
    assert.deepEqual(parseWindowLayout('{"h":250}'), {
      w: EDITOR_W_DEFAULT,
      h: 250,
      s: SELECTION_W_DEFAULT,
    });
    assert.deepEqual(parseWindowLayout('{"w":"abc","h":300,"s":200}'), {
      w: EDITOR_W_DEFAULT,
      h: 300,
      s: 200,
    });
  });
});

describe('parseCanvasLayout', () => {
  it('falls back to defaults for missing/invalid input', () => {
    assert.deepEqual(parseCanvasLayout(null), { topSplit: 0.5, childrenShare: 0.34 });
    assert.deepEqual(parseCanvasLayout(''), { topSplit: 0.5, childrenShare: 0.34 });
    assert.deepEqual(parseCanvasLayout('not json'), { topSplit: 0.5, childrenShare: 0.34 });
    assert.deepEqual(parseCanvasLayout('42'), { topSplit: 0.5, childrenShare: 0.34 });
  });

  it('parses shares and clamps them into the stored range', () => {
    assert.deepEqual(parseCanvasLayout('{"topSplit":0.7,"childrenShare":0.2}'), {
      topSplit: 0.7,
      childrenShare: 0.2,
    });
    assert.deepEqual(parseCanvasLayout('{"topSplit":0.01,"childrenShare":0.99}'), {
      topSplit: 0.1,
      childrenShare: 0.9,
    });
    // Rounded to 3 decimals.
    assert.deepEqual(parseCanvasLayout('{"topSplit":0.66666,"childrenShare":0.34}'), {
      topSplit: 0.667,
      childrenShare: 0.34,
    });
  });

  it('keeps a valid share when the other is missing/invalid', () => {
    assert.deepEqual(parseCanvasLayout('{"topSplit":0.6}'), { topSplit: 0.6, childrenShare: 0.34 });
    assert.deepEqual(parseCanvasLayout('{"childrenShare":0.5}'), {
      topSplit: 0.5,
      childrenShare: 0.5,
    });
    assert.deepEqual(parseCanvasLayout('{"topSplit":"x","childrenShare":0.5}'), {
      topSplit: 0.5,
      childrenShare: 0.5,
    });
  });
});

describe('canvas zoom', () => {
  it('parses ui_state zoom with clipping to system constants', () => {
    assert.equal(parseCanvasZoom(null), 1);
    assert.equal(parseCanvasZoom('abc'), 1);
    assert.equal(parseCanvasZoom('0.3'), 0.5);
    assert.equal(parseCanvasZoom('9'), 2);
    assert.equal(parseCanvasZoom('1.25'), 1.25);
  });

  it('steps along the 5% grid, additive, not multiplicative', () => {
    assert.equal(zoomStep(1, 1), 1.05);
    assert.equal(zoomStep(1.05, 1), 1.1);
    assert.equal(zoomStep(1.1, -1), 1.05);
    // No floating drift: values land exactly on the grid.
    assert.equal(zoomStep(zoomStep(zoomStep(1, 1), 1), -1), 1.05);
  });

  it('clamps steps to the zoom range', () => {
    assert.equal(zoomStep(2, 1), 2);
    assert.equal(zoomStep(0.5, -1), 0.5);
    // An out-of-range seed is treated as clipped first.
    assert.equal(zoomStep(9, -1), 1.95);
  });

  it('scales font and height proportionally with the zoom', () => {
    const font1 = cloudFontSize(200);
    const height1 = cloudHeight(200);
    assert.equal(cloudFontSize(200, 1.5), Math.round(font1 * 1.5 * 10) / 10);
    // Borders stay constant (2px total), everything else scales. The font is
    // rounded to 0.1 px before the line math, so the scaled height may drift
    // by 1 px at most.
    const scaled = (height1 - 2) * 2 + 2;
    assert.ok(
      Math.abs(cloudHeight(200, 2) - scaled) <= 1,
      `cloudHeight(200, 2) = ${cloudHeight(200, 2)}, expected ~${scaled}`,
    );
  });

  it('cloudGeom rounds effective px sizes and keeps grid-consistent numbers', () => {
    const geom = cloudGeom(200, 12, 1.05);
    assert.equal(geom.width, 210);
    assert.equal(geom.gap, 13);
    assert.equal(geom.font, cloudFontSize(200, 1.05));
    assert.equal(geom.height, cloudHeight(200, 1.05));
    // Zoom 1 keeps the legacy values.
    assert.deepEqual(cloudGeom(200, 12), {
      width: 200,
      gap: 12,
      font: cloudFontSize(200),
      height: cloudHeight(200),
    });
  });
});

describe('ui theme (L10)', () => {
  it("parses client_meta theme; anything but 'dark' falls back to light", () => {
    assert.equal(parseTheme(null), 'light');
    assert.equal(parseTheme(''), 'light');
    assert.equal(parseTheme('light'), 'light');
    assert.equal(parseTheme('DARK'), 'light');
    assert.equal(parseTheme('dark'), 'dark');
  });
});

describe('contrastText (L12: readable text on a custom cloud background)', () => {
  it('picks white on dark backgrounds and dark on light ones', () => {
    assert.equal(contrastText('#1E62BE'), '#ffffff');
    assert.equal(contrastText('#20242d'), '#ffffff');
    assert.equal(contrastText('#ffffff'), '#1f242d');
    assert.equal(contrastText('#ffeb00'), '#1f242d');
    assert.equal(contrastText('#87ceeb'), '#1f242d');
  });

  it('supports 3-digit hex and falls back to white on garbage', () => {
    assert.equal(contrastText('#fff'), '#1f242d');
    assert.equal(contrastText('#03c'), '#ffffff');
    assert.equal(contrastText('not-a-color'), '#ffffff');
  });
});

describe('parseTitleWithSynonyms', () => {
  it('splits title and synonyms on the first pipe', () => {
    assert.deepEqual(parseTitleWithSynonyms('Иванов Иван | Ваня, Иваныч'), {
      title: 'Иванов Иван',
      synonyms: ['Ваня', 'Иваныч'],
    });
  });

  it('works without a pipe', () => {
    assert.deepEqual(parseTitleWithSynonyms('Петров'), { title: 'Петров', synonyms: [] });
  });

  it('trims and drops empty synonyms', () => {
    assert.deepEqual(parseTitleWithSynonyms('  Тест  |  , , А,  '), {
      title: 'Тест',
      synonyms: ['А'],
    });
  });
});

describe('parseAddLines', () => {
  it('parses multi-line buffers, dropping empty lines', () => {
    const lines = parseAddLines('Иванов | Ваня\n\nПетров\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.title, 'Иванов');
    assert.deepEqual(lines[0]?.synonyms, ['Ваня']);
    assert.equal(lines[1]?.title, 'Петров');
  });
});

describe('parseCollapsedGroups', () => {
  it('parses valid JSON', () => {
    assert.deepEqual(parseCollapsedGroups('{"t1":{"permanent":true}}'), {
      t1: { permanent: true },
    });
  });

  it('tolerates garbage and non-object shapes', () => {
    assert.deepEqual(parseCollapsedGroups(null), {});
    assert.deepEqual(parseCollapsedGroups('{oops'), {});
    assert.deepEqual(parseCollapsedGroups('[1,2]'), {});
    assert.deepEqual(parseCollapsedGroups('{"t1":"x"}'), {});
  });

  it('keeps only boolean flags', () => {
    assert.deepEqual(parseCollapsedGroups('{"t1":{"a":true,"b":"no"}}'), { t1: { a: true } });
  });
});

describe('parseLinkTypeId', () => {
  it('returns null for empty values and the raw value otherwise', () => {
    assert.equal(parseLinkTypeId(null), null);
    assert.equal(parseLinkTypeId('  '), null);
    assert.equal(parseLinkTypeId('abc-123'), 'abc-123');
  });
});

describe('isRealtimeEvent', () => {
  const base = {
    type: 'thought.created',
    seq: 1,
    ts: '2026-08-13T00:00:00.000Z',
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: 'n1',
    audience: 'network',
    data: {},
  };

  it('accepts a well-formed event', () => {
    assert.equal(isRealtimeEvent(base), true);
  });

  it('rejects unknown types and malformed payloads', () => {
    assert.equal(isRealtimeEvent({ ...base, type: 'nope' }), false);
    assert.equal(isRealtimeEvent(null), false);
    assert.equal(isRealtimeEvent('x'), false);
    assert.equal(isRealtimeEvent({ type: 'thought.created', seq: '1', network_id: 'n1' }), false);
  });
});

describe('describeEvent', () => {
  const evt = (type: string): AnyRealtimeEvent =>
    ({
      type,
      seq: 1,
      ts: '2026-08-13T00:00:00.000Z',
      actor: { user_id: 'u1', client_id: 'c1' },
      network_id: 'n1',
      audience: 'network',
      data: {},
    }) as AnyRealtimeEvent;

  it('produces a Russian label for known events', () => {
    assert.ok(describeEvent(evt('thought.updated'), 'Мысль').includes('изменена мысль'));
    assert.ok(describeEvent(evt('link.created')).includes('создана связь'));
  });
});

describe('search scope resolution (H13)', () => {
  it('maps no restrictions to all', () => {
    assert.deepEqual(scopesFor({ ...DEFAULT_OPTIONS }), ['all']);
  });

  it('maps group filters to granular scopes', () => {
    assert.deepEqual(scopesFor({ ...DEFAULT_OPTIONS, onlyThoughts: true }), ['names', 'texts']);
    assert.deepEqual(scopesFor({ ...DEFAULT_OPTIONS, onlyLinks: true }), ['links']);
    assert.deepEqual(scopesFor({ ...DEFAULT_OPTIONS, onlyChrono: true }), ['chronology']);
    assert.deepEqual(scopesFor({ ...DEFAULT_OPTIONS, onlyThoughts: true, onlyLinks: true }), [
      'names',
      'texts',
      'links',
    ]);
  });

  it('starts the server search only from 3 characters', () => {
    assert.equal(isSearchableQuery(''), false);
    assert.equal(isSearchableQuery('аб'), false);
    assert.equal(isSearchableQuery('   '.trim()), false);
    assert.equal(isSearchableQuery('три'), true);
    assert.equal(isSearchableQuery('query'), true);
  });

  it('navigates rows from either end and clamps at the edges', () => {
    assert.equal(nextNavIndex(null, 3, 1), 0);
    assert.equal(nextNavIndex(null, 3, -1), 2);
    assert.equal(nextNavIndex(1, 3, 1), 2);
    assert.equal(nextNavIndex(2, 3, 1), 2);
    assert.equal(nextNavIndex(1, 3, -1), 0);
    assert.equal(nextNavIndex(0, 3, -1), 0);
    assert.equal(nextNavIndex(9, 3, 1), 0);
    assert.equal(nextNavIndex(null, 0, 1), null);
  });

  it('merges partial responses', () => {
    const merged = mergeResponses([
      {
        by_names: [
          { thought_id: 'a', title: 'A', icon: null, icon_kind: 'emoji', snippet: 'A', highlights: [] },
        ],
        by_texts: [],
        by_links: [],
        by_chrono: [],
        meta: { total_in_group: { names: 1, texts: 0, links: 0, chronology: 0 } },
      },
      {
        by_names: [],
        by_texts: [],
        by_links: [{ link_id: 'l1', type_name: 'T', snippet: 'S', highlights: [] }],
        by_chrono: [],
        meta: { total_in_group: { names: 0, texts: 0, links: 1, chronology: 0 } },
      },
    ]);
    assert.equal(merged.by_names.length, 1);
    assert.equal(merged.by_links.length, 1);
    assert.equal(merged.meta.total_in_group.links, 1);
  });
});

describe('patchFocusEdge (instant link repaint; no realtime echo to actor)', () => {
  const mkThought = (id: string): Thought => ({
    id,
    title: id,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    active: true,
    is_protected: false,
    is_root: false,
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

  const mkLink = (over: Partial<Link>): Link => ({
    id: 'l1',
    source_id: 'f',
    target_id: 'c',
    type_id: null,
    color: null,
    style: null,
    width: null,
    active: true,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  const edge = (over: Partial<FocusEdge>): FocusEdge => ({
    id: 'l1',
    source_id: 'f',
    target_id: 'c',
    type_id: null,
    color: null,
    style: null,
    width: null,
    ...over,
  });

  /** Seeds a focus: FOCUS f with child c and the given edges. */
  const seedFocus = (edges: FocusEdge[]): void => {
    store.update({
      focus: {
        focused: mkThought('f'),
        parents: [],
        children: [
          {
            id: 'c',
            title: 'c',
            type_id: null,
            icon: null,
            active: true,
            link_id: 'l1',
            link_type_id: null,
            link_active: true,
            has_incoming: true,
            has_outgoing: false,
          },
        ],
        siblings: [],
        edges,
        sorts: { parents: 'created', children: 'created' },
      } satisfies FocusResponse,
    });
  };

  it('recolors the edge in place from the update response', () => {
    seedFocus([edge({}), edge({ id: 'l2', source_id: 'c', target_id: 'f' })]);
    patchFocusEdge(mkLink({ color: '#ff0000', width: 3 }));
    const edges = store.state.focus?.edges ?? [];
    assert.equal(edges.length, 2);
    assert.deepEqual(edges[0], edge({ color: '#ff0000', width: 3 }));
    assert.equal(edges[1]?.id, 'l2', 'sibling edge untouched, order preserved');
    store.update({ focus: null });
  });

  it('removes the edge when the link is deactivated', () => {
    seedFocus([edge({})]);
    patchFocusEdge(mkLink({ active: false }));
    assert.deepEqual(store.state.focus?.edges ?? [], []);
    store.update({ focus: null });
  });

  it('re-adds a reactivated edge when both endpoints are visible', () => {
    seedFocus([]);
    patchFocusEdge(mkLink({ active: true }));
    assert.deepEqual(store.state.focus?.edges ?? [], [edge({})]);
    store.update({ focus: null });
  });

  it('ignores a link whose endpoints are not on the canvas', () => {
    seedFocus([]);
    patchFocusEdge(mkLink({ id: 'l9', source_id: 'x', target_id: 'y' }));
    assert.deepEqual(store.state.focus?.edges ?? [], []);
    store.update({ focus: null });
  });
});

describe('focusEdgesSignature (editor «Связи» re-render guard)', () => {
  const thought = (id: string): Thought => ({
    id,
    title: id,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    active: true,
    is_protected: false,
    is_root: false,
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

  const edge = (over: Partial<FocusEdge>): FocusEdge => ({
    id: 'l1',
    source_id: 'f',
    target_id: 'c',
    type_id: null,
    color: null,
    style: null,
    width: null,
    ...over,
  });

  const emptyFocus: FocusResponse = {
    focused: thought('f'),
    parents: [],
    children: [],
    siblings: [],
    edges: [],
    sorts: { parents: 'created', children: 'created' },
  };

  it('is empty for a null focus and a focus without edges', () => {
    assert.equal(focusEdgesSignature(null), '');
    assert.equal(focusEdgesSignature({ ...emptyFocus, edges: [] }), '');
  });

  it('changes when an edge is added, removed or retyped', () => {
    const base = { ...emptyFocus, edges: [edge({})] };
    const withSecond = {
      ...emptyFocus,
      edges: [edge({}), edge({ id: 'l2', source_id: 'f', target_id: 's' })],
    };
    const retyped = { ...emptyFocus, edges: [edge({ type_id: 't1' })] };
    const sig = focusEdgesSignature(base);
    assert.notEqual(focusEdgesSignature(withSecond), sig);
    assert.notEqual(focusEdgesSignature(retyped), sig);
    assert.notEqual(focusEdgesSignature(emptyFocus), sig);
  });

  it('is order-insensitive so a no-op refresh does not re-render the editor', () => {
    const a = focusEdgesSignature({
      ...emptyFocus,
      edges: [edge({}), edge({ id: 'l2', source_id: 'f', target_id: 's' })],
    });
    const b = focusEdgesSignature({
      ...emptyFocus,
      edges: [edge({ id: 'l2', source_id: 'f', target_id: 's' }), edge({})],
    });
    assert.equal(a, b);
  });
});

describe('zoomable (Ctrl-hover magnifier predicate)', () => {
  it('zooms only loaded images displayed smaller than natural', () => {
    assert.equal(zoomable({ w: 512, h: 512 }, { w: 44, h: 44 }), true);
    assert.equal(zoomable({ w: 512, h: 512 }, { w: 512, h: 256 }), true);
    // Already at natural size — nothing to magnify.
    assert.equal(zoomable({ w: 32, h: 32 }, { w: 44, h: 44 }), false);
    assert.equal(zoomable({ w: 512, h: 512 }, { w: 512, h: 512 }), false);
    // Not loaded yet (natural 0).
    assert.equal(zoomable({ w: 0, h: 0 }, { w: 44, h: 44 }), false);
  });
});

describe('flipTransform (focus transition, 08-ui-spec §2.8)', () => {
  it('computes the start transform from the old rect to the new one', () => {
    assert.deepEqual(
      flipTransform(
        { left: 0, top: 0, width: 200, height: 100 },
        { left: 100, top: 50, width: 100, height: 50 },
      ),
      { dx: -100, dy: -50, sx: 2, sy: 2 },
    );
    // A zero-size target must not divide by zero.
    assert.deepEqual(
      flipTransform({ left: 10, top: 10, width: 44, height: 44 }, { left: 0, top: 0, width: 0, height: 0 }),
      { dx: 10, dy: 10, sx: 44, sy: 44 },
    );
  });
});

describe('splitCompoundName (08-ui-spec §2.2.3)', () => {
  it('a name without commas is a single part', () => {
    assert.deepEqual(splitCompoundName('Проект А'), ['Проект А']);
  });

  it('splits at commas and trims the parts', () => {
    assert.deepEqual(splitCompoundName('Проект А, Задачи разработки'), [
      'Проект А',
      'Задачи разработки',
    ]);
  });

  it('everything after the 3rd comma is one part', () => {
    assert.deepEqual(splitCompoundName('a, b, c, d'), ['a', 'b', 'c', 'd']);
    assert.deepEqual(splitCompoundName('a, b, c, d, e'), ['a', 'b', 'c', 'd, e']);
  });
});

describe('shortenCompoundName (08-ui-spec §2.2.3)', () => {
  it('returns the full name when there are no related titles', () => {
    assert.equal(
      shortenCompoundName('Проект А, Задачи разработки', []),
      'Проект А, Задачи разработки',
    );
  });

  it('hides the part matching a visible related thought', () => {
    assert.equal(
      shortenCompoundName('Проект А, Задачи разработки', ['Проект А']),
      'Задачи разработки',
    );
  });

  it('hides several parts — visible parent and child', () => {
    assert.equal(
      shortenCompoundName('Проект А, Обсудить с Петровым проблемы тестирования, Задачи для офиса', [
        'Проект А',
        'Задачи для офиса',
      ]),
      'Обсудить с Петровым проблемы тестирования',
    );
  });

  it('hides the parts of a compound related thought', () => {
    // The visible parent is itself compound: `ETN, Ошибки` — both matching
    // parts of the child name hide, the new part stays.
    assert.equal(
      shortenCompoundName('ETN, Ошибки, Отложено на будущее', ['ETN, Ошибки']),
      'Отложено на будущее',
    );
    assert.equal(
      shortenCompoundName('ETN, Ошибки, Отложено на будущее', ['Ошибки']),
      'ETN, Отложено на будущее',
    );
  });

  it('matching ignores case and surrounding spaces', () => {
    assert.equal(
      shortenCompoundName('Проект А, Задачи разработки', ['  проект а ']),
      'Задачи разработки',
    );
  });

  it('unmatched related titles change nothing', () => {
    assert.equal(
      shortenCompoundName('Проект А, Задачи разработки', ['Другой проект']),
      'Проект А, Задачи разработки',
    );
  });

  it('falls back to the full name when every part is hidden', () => {
    assert.equal(
      shortenCompoundName('Проект А, Задачи разработки', ['Проект А', 'Задачи разработки']),
      'Проект А, Задачи разработки',
    );
  });

  it('a plain (non-compound) name is never shortened', () => {
    assert.equal(shortenCompoundName('Задачи разработки', ['Задачи разработки']), 'Задачи разработки');
  });
});
