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
} from '@etn/shared';

import {
  clip,
  cloudFontSize,
  cloudHeight,
  describeEvent,
  isRealtimeEvent,
  parseAddLines,
  parseCloudGap,
  parseCloudWidth,
  parseCollapsedGroups,
  parseLinkTypeId,
  parseTitleWithSynonyms,
  parseWindowLayout,
} from '../src/renderer/lib/pure.js';

import type { AnyRealtimeEvent } from '@etn/shared';

import { searchInternals } from '../src/renderer/search/search.js';

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
    assert.deepEqual(parseWindowLayout(null), { w: EDITOR_W_DEFAULT, h: EDITOR_H_DEFAULT });
    assert.deepEqual(parseWindowLayout(''), { w: EDITOR_W_DEFAULT, h: EDITOR_H_DEFAULT });
    assert.deepEqual(parseWindowLayout('not json'), { w: EDITOR_W_DEFAULT, h: EDITOR_H_DEFAULT });
  });

  it('parses a {w,h} JSON object and clamps to editor constants', () => {
    assert.deepEqual(parseWindowLayout('{"w":500,"h":400}'), { w: 500, h: 400 });
    assert.deepEqual(parseWindowLayout('{"w":10,"h":10}'), { w: EDITOR_W_MIN, h: EDITOR_H_MIN });
    assert.deepEqual(parseWindowLayout('{"w":99999,"h":99999}'), {
      w: EDITOR_W_MAX,
      h: EDITOR_H_MAX,
    });
  });

  it('keeps a valid dimension when the other is missing/invalid', () => {
    assert.deepEqual(parseWindowLayout('{"w":450}'), { w: 450, h: EDITOR_H_DEFAULT });
    assert.deepEqual(parseWindowLayout('{"h":250}'), { w: EDITOR_W_DEFAULT, h: 250 });
    assert.deepEqual(parseWindowLayout('{"w":"abc","h":300}'), {
      w: EDITOR_W_DEFAULT,
      h: 300,
    });
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
        by_names: [{ thought_id: 'a', title: 'A', snippet: 'A', highlights: [] }],
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
