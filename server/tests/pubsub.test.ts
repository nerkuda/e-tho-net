/**
 * Unit tests for the in-memory pub/sub broker (task B10). No native binding.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent, RealtimeEvent } from '@etn/shared';

import { PubSub } from '../src/realtime/pubsub.js';

/** Build a minimal valid event for tests. */
function makeEvent(
  networkId: string,
  seq: number,
  type: AnyRealtimeEvent['type'] = 'thought.created',
): AnyRealtimeEvent {
  return {
    type,
    seq,
    ts: new Date().toISOString(),
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: networkId,
    audience: 'network',
    data: { thought: { id: 't1', title: 'x' } } as never,
  } as AnyRealtimeEvent;
}

describe('PubSub', () => {
  it('delivers an event to subscribers of that network', () => {
    const bus = new PubSub();
    const received: AnyRealtimeEvent[] = [];
    bus.subscribe('net-1', (e: RealtimeEvent) => {
      received.push(e);
    });
    bus.publish('net-1', makeEvent('net-1', 1));
    assert.equal(received.length, 1);
    assert.equal(received[0]?.seq, 1);
  });

  it('does not deliver to subscribers of another network', () => {
    const bus = new PubSub();
    const received: string[] = [];
    bus.subscribe('net-A', () => received.push('A'));
    bus.subscribe('net-B', () => received.push('B'));
    bus.publish('net-A', makeEvent('net-A', 2));
    assert.deepEqual(received, ['A']);
  });

  it('unsubscribe stops further delivery', () => {
    const bus = new PubSub();
    const received: number[] = [];
    const unsub = bus.subscribe('net-2', (e: RealtimeEvent) => received.push(e.seq));
    bus.publish('net-2', makeEvent('net-2', 1));
    unsub();
    bus.publish('net-2', makeEvent('net-2', 2));
    assert.deepEqual(received, [1]);
    assert.equal(bus.listenerCount('net-2'), 0);
  });

  it('rejects a network_id mismatch between channel and event', () => {
    const bus = new PubSub();
    assert.throws(() => bus.publish('net-1', makeEvent('net-2', 1)), /network_id mismatch/);
  });

  it('filters by event type', () => {
    const bus = new PubSub();
    const got: string[] = [];
    bus.subscribe('net-3', (e: RealtimeEvent<'member.added'>) => got.push(e.type), {
      type: 'member.added',
    });
    bus.publish('net-3', makeEvent('net-3', 1, 'thought.created'));
    bus.publish('net-3', makeEvent('net-3', 2, 'member.added'));
    assert.deepEqual(got, ['member.added']);
  });

  it('a throwing listener does not break other listeners', () => {
    const bus = new PubSub();
    let secondCalled = false;
    bus.subscribe('net-4', () => {
      throw new Error('boom');
    });
    bus.subscribe('net-4', () => {
      secondCalled = true;
    });
    // Suppress the expected console.error from the faulty listener.
    const original = console.error;
    console.error = () => undefined;
    try {
      bus.publish('net-4', makeEvent('net-4', 1));
    } finally {
      console.error = original;
    }
    assert.equal(secondCalled, true);
  });
});
