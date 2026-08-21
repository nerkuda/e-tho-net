/**
 * Tests for the {@link EventLogRelay} (docs/04-realtime.md §5).
 *
 * The unit suite drives the relay with a fake event log (no SQLite) and runs
 * everywhere; the integration suite uses a real in-memory db and is skipped
 * when the `better-sqlite3` native binding is unavailable (same convention as
 * emit.test.ts).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';

import type { AnyRealtimeEvent } from '@etn/shared';

import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir } from '../src/paths.js';
import { EventLogRelay, type EventLogReader } from '../src/realtime/event-log-relay.js';
import { PubSub } from '../src/realtime/pubsub.js';

/** Build a minimal network-audience event envelope for a log entry. */
function makeEvent(networkId: string, seq: number): AnyRealtimeEvent {
  return {
    type: 'thought.updated',
    seq,
    ts: '2026-08-18T00:00:00.000Z',
    network_id: networkId,
    audience: 'network',
    actor: { user_id: 'u1', client_id: '' },
    data: { id: `t${seq}`, changes: { title: `T${seq}` }, version: 1 },
  } as unknown as AnyRealtimeEvent;
}

/** In-memory event log standing in for SystemDb (unit suite). */
class FakeLog implements EventLogReader {
  readonly ids: string[] = [];
  private readonly log = new Map<string, AnyRealtimeEvent[]>();

  addNetwork(networkId: string): void {
    if (!this.ids.includes(networkId)) this.ids.push(networkId);
  }

  /** Append an event as a *foreign* writer would (no broker involved). */
  write(event: AnyRealtimeEvent): void {
    const list = this.log.get(event.network_id) ?? [];
    list.push(event);
    this.log.set(event.network_id, list);
  }

  listAllNetworkIds(): string[] {
    return [...this.ids];
  }

  getMaxEventSeq(networkId: string): number | null {
    const list = this.log.get(networkId);
    return list === undefined || list.length === 0 ? null : list[list.length - 1]!.seq;
  }

  readEventsAfter(networkId: string, afterSeq: number, limit: number): AnyRealtimeEvent[] {
    return (this.log.get(networkId) ?? [])
      .filter((e) => e.seq > afterSeq)
      .slice(0, limit);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('EventLogRelay (unit, fake log)', () => {
  it('never broadcasts pre-start history', async () => {
    const log = new FakeLog();
    log.addNetwork('n1');
    log.write(makeEvent('n1', 1));
    log.write(makeEvent('n1', 2));
    const pubsub = new PubSub();
    const received: AnyRealtimeEvent[] = [];
    const unsubscribe = pubsub.subscribe('n1', (e) => received.push(e));
    const relay = new EventLogRelay({ systemDb: log, pubsub, options: { pollIntervalMs: 10 } });
    try {
      relay.start();
      await wait(40);
      relay.stop();
      assert.equal(received.length, 0, 'pre-start history must not be broadcast');
      assert.ok(relay.pollCount() >= 2, 'the relay actually scanned');
    } finally {
      unsubscribe();
      pubsub.clear();
    }
  });

  it('publishes a foreign write after start (bounded by the poll interval)', async () => {
    const log = new FakeLog();
    log.addNetwork('n1');
    const pubsub = new PubSub();
    const received: AnyRealtimeEvent[] = [];
    const unsubscribe = pubsub.subscribe('n1', (e) => received.push(e));
    const relay = new EventLogRelay({ systemDb: log, pubsub, options: { pollIntervalMs: 10 } });
    try {
      relay.start();
      log.write(makeEvent('n1', 1));
      await wait(50);
      relay.stop();
      assert.equal(received.length, 1);
      assert.equal(received[0]?.seq, 1);
    } finally {
      unsubscribe();
      pubsub.clear();
    }
  });

  it('never re-broadcasts in-process writes', async () => {
    const log = new FakeLog();
    log.addNetwork('n1');
    const pubsub = new PubSub();
    const received: AnyRealtimeEvent[] = [];
    const unsubscribe = pubsub.subscribe('n1', (e) => received.push(e));
    const relay = new EventLogRelay({ systemDb: log, pubsub, options: { pollIntervalMs: 10 } });
    try {
      relay.start();
      // The event reaches the broker the way emitDomainEvent delivers it.
      pubsub.publish('n1', makeEvent('n1', 1));
      await wait(50);
      relay.stop();
      assert.equal(received.length, 1, 'own write must arrive exactly once');
    } finally {
      unsubscribe();
      pubsub.clear();
    }
  });

  it('catches a foreign event sitting behind an in-process one (hole)', async () => {
    const log = new FakeLog();
    log.addNetwork('n1');
    const pubsub = new PubSub();
    const received: AnyRealtimeEvent[] = [];
    const unsubscribe = pubsub.subscribe('n1', (e) => received.push(e));
    const relay = new EventLogRelay({ systemDb: log, pubsub, options: { pollIntervalMs: 10 } });
    try {
      relay.start();
      log.write(makeEvent('n1', 1)); // foreign: never reached the broker
      pubsub.publish('n1', makeEvent('n1', 2)); // own: seq head jumps to 2
      await wait(50);
      relay.stop();
      const seqs = received.map((e) => e.seq).sort((a, b) => a - b);
      assert.deepEqual(seqs, [1, 2], 'the hole must be filled, no duplicate of own write');
    } finally {
      unsubscribe();
      pubsub.clear();
    }
  });

  it('picks up networks created after start', async () => {
    const log = new FakeLog();
    log.addNetwork('n1');
    const pubsub = new PubSub();
    const received: AnyRealtimeEvent[] = [];
    const unsubscribe = pubsub.subscribe('n1', (e) => received.push(e));
    const relay = new EventLogRelay({ systemDb: log, pubsub, options: { pollIntervalMs: 10 } });
    try {
      relay.start();
      log.addNetwork('n2');
      const unsubscribeN2 = pubsub.subscribe('n2', (e) => received.push(e));
      log.write(makeEvent('n2', 1));
      await wait(50);
      relay.stop();
      const n2Events = received.filter((e) => e.network_id === 'n2');
      assert.equal(n2Events.length, 1, 'events of a new network are relayed');
      assert.equal(n2Events[0]?.seq, 1);
      unsubscribeN2();
    } finally {
      unsubscribe();
      pubsub.clear();
    }
  });
});

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Open a migrated in-memory db and seed a network registry row. */
function openStore(): { db: Database.Database; sys: SystemDb; networkId: string } {
  const db = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, systemMigrationsDir());
  const sys = new SystemDb(db);
  const ownerId = randomUUID();
  sys.createUser({ id: ownerId, username: 'owner', displayName: 'Owner' });
  const networkId = randomUUID();
  sys.createNetworkRow(networkId, ownerId, 'Net', null);
  return { db, sys, networkId };
}

describe(
  'EventLogRelay (integration, real db)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('broadcasts events appended by a foreign process, exactly once', async () => {
      const { sys, networkId } = openStore();
      const pubsub = new PubSub();
      const received: AnyRealtimeEvent[] = [];
      const unsubscribe = pubsub.subscribe(networkId, (e) => received.push(e));
      const relay = new EventLogRelay({ systemDb: sys, pubsub, options: { pollIntervalMs: 10 } });
      try {
        relay.start();
        // The foreign write lands after the relay is alive — exactly the case
        // the relay exists for (a write before start() is pre-start history
        // and must not be broadcast).
        const seq = sys.transaction(() => {
          const s = sys.nextNetworkSeq(networkId);
          sys.appendEvent(
            networkId,
            s,
            'thought.updated',
            JSON.stringify({
              actor: { user_id: 'u1', client_id: '' },
              audience: 'network',
              data: { id: 't1', changes: { title: 'T' }, version: 1 },
            }),
          );
          return s;
        });
        await wait(50);
        relay.stop();
        assert.equal(received.length, 1);
        assert.equal(received[0]?.seq, seq);
        assert.equal(received[0]?.type, 'thought.updated');
      } finally {
        unsubscribe();
        pubsub.clear();
        sys.close();
      }
    });
  },
);
