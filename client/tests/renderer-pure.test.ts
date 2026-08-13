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
} from '../src/renderer/lib/pure.js';

import type { AnyRealtimeEvent } from '@etn/shared';

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
