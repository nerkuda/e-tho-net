/**
 * Проводка `onDataChange` пула realtime (ошибка da7bbb53, круг 2).
 *
 * Замечание верификатора круга 1: классификация `isDataChangingEvent`
 * (`realtime/applier.ts`) покрыта тестом, а ДОПУСК хука (только применённое
 * событие, только data-событие) и его порядок «хук ДО broadcast в рендерер»
 * держались только на коде и GUI-сценарии — сторожа против перестановки не
 * было. Здесь событие подаётся в тот же `client.onTyped('event')`, что и у
 * живого сокета (`TabRealtimePool.wireClient`), и проверяется:
 *  - data-событие двигает границу чтения ДО того, как рендерер увидит событие;
 *  - `presence.*`/`edit.*` эфемерны — границу не двигают (но доставляются);
 *  - опоздавшее (`applied: false`) событие не двигает ничего и не доставляется.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { AnyRealtimeEvent, Thought } from '@etn/shared';
import type { ServerProfileRow } from '../src/main/db/local-db.js';
import { RealtimeState } from '../src/main/realtime/applier.js';
import { TabRealtimePool } from '../src/main/realtime/tab-rt-pool.js';

const NET = '123e4567-e89b-12d3-a456-426614174000';

const teardowns: Array<() => void> = [];
afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()!();
});

function profile(): ServerProfileRow {
  return {
    id: 'p1',
    label: 'test',
    // Refused port: the socket fails fast, no real server is involved.
    base_url: 'http://127.0.0.1:1',
    api_key_encrypted: null,
    user_id: null,
    is_active: 1,
    created_at: new Date(0).toISOString(),
  };
}

function makeThought(overrides: Partial<Thought> = {}): Thought {
  return {
    id: 't1',
    title: 'T1',
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
    ...overrides,
  };
}

function event(type: string, data: unknown, seq = 1): AnyRealtimeEvent {
  return {
    type,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { user_id: 'u2', client_id: 'c2' },
    network_id: NET,
    audience: 'network',
    layer_id: '00000000-0000-4000-8000-000000000001',
    data,
  } as unknown as AnyRealtimeEvent;
}

/** Пул с трассировкой хука и broadcast в один журнал (порядок проверяем). */
function makePool(rtState = new RealtimeState()): {
  pool: TabRealtimePool;
  trace: string[];
  delivered: AnyRealtimeEvent[];
} {
  const trace: string[] = [];
  const delivered: AnyRealtimeEvent[] = [];
  const pool = new TabRealtimePool({
    profile: profile(),
    getClientId: () => '11111111-1111-1111-1111-111111111111',
    getApiKey: async () => 'etn_testkey',
    localDb: {} as never,
    rtState,
    getCurrentUserId: () => null,
    removeFromFocusHistoryEverywhere: () => undefined,
    getCurrentFocusId: () => null,
    broadcast: (channel, payload) => {
      if (channel === 'realtime:event') {
        delivered.push(payload as AnyRealtimeEvent);
        trace.push('broadcast');
      }
    },
    onDataChange: (evt) => {
      trace.push(`hook:${evt.type}`);
    },
  });
  teardowns.push(() => pool.shutdown());
  return { pool, trace, delivered };
}

describe('TabRealtimePool — onDataChange двигает границу чтения (da7bbb53, круг 2)', () => {
  it('data-событие: хук ДО broadcast; presence/edit — без хука; опоздавшее — ни хука, ни доставки', () => {
    const rtState = new RealtimeState();
    // Локально известная версия мысли: событие с версией ≤ неё — опоздавшее.
    rtState.setThought(makeThought({ id: 'tStale', version: 5 }));

    const { pool, trace, delivered } = makePool(rtState);
    const client = pool.acquire(NET);

    // 1. Data-событие: граница чтения двигается ДО того, как событие увидят
    //    рендерер/его чтения (иначе чтения, запущенные по событию, попали бы в
    //    прежнюю эпоху).
    client.emitTyped(
      'event',
      event('property-value.set', {
        owner_type: 'thought',
        owner_id: 't1',
        key: 'Теги',
        values: ['срочно'],
      }),
    );
    assert.deepEqual(
      trace,
      ['hook:property-value.set', 'broadcast'],
      'data-событие обязано двигать границу ДО broadcast',
    );
    assert.equal(delivered.length, 1, 'data-событие доставлено рендереру');

    // 2. Эфемерные семейства данные не меняют: хука нет, доставка есть.
    trace.length = 0;
    client.emitTyped('event', event('presence.joined', { user_id: 'u2' }, 2));
    client.emitTyped('event', event('edit.acquired', { entity_type: 'thought', entity_id: 't1' }, 3));
    assert.deepEqual(trace, ['broadcast', 'broadcast'], 'presence.*/edit.* не двигают границу');
    assert.equal(delivered.length, 3, 'эфемерные события доставляются рендереру');

    // 3. Опоздавшее событие (applied: false) не двигает границу и не уходит в
    //    рендерер — старый снимок версии данных не меняет.
    trace.length = 0;
    client.emitTyped(
      'event',
      event(
        'thought.updated',
        { id: 'tStale', changes: { title: 'старое' }, version: 3 },
        4,
      ),
    );
    assert.deepEqual(trace, [], 'опоздавшее событие не двигает границу и не доставляется');
    assert.equal(delivered.length, 3, 'опоздавшее событие не доставлено рендереру');
  });
});
