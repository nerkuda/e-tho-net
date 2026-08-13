/**
 * Tests for the real-time event store: `SystemDb` methods over
 * `network_seq`/`event_log` (task E2; docs/04-realtime.md §3, §5–6).
 *
 * Skipped entirely when the `better-sqlite3` native binding is unavailable.
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

/** Build a stored event payload the same way {@link emitDomainEvent} does. */
function appendStoredEvent(sys: SystemDb, networkId: string, seq: number, type: string): void {
  sys.appendEvent(
    networkId,
    seq,
    type,
    JSON.stringify({
      actor: { user_id: 'u1', client_id: 'c1' },
      audience: 'network',
      data: { id: 't1' },
    }),
  );
}

describe(
  'event_log / network_seq (E2)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('nextNetworkSeq seeds at 1 and increments monotonically', () => {
      const { sys, networkId } = openStore();
      try {
        assert.equal(sys.nextNetworkSeq(networkId), 1);
        assert.equal(sys.nextNetworkSeq(networkId), 2);
        assert.equal(sys.nextNetworkSeq(networkId), 3);
      } finally {
        sys.close();
      }
    });

    it('appendEvent + readEventsAfter replay in ascending order with limit', () => {
      const { sys, networkId } = openStore();
      try {
        appendStoredEvent(sys, networkId, 1, 'thought.created');
        appendStoredEvent(sys, networkId, 2, 'thought.updated');
        appendStoredEvent(sys, networkId, 3, 'thought.deleted');

        const all = sys.readEventsAfter(networkId, 0, 10);
        assert.deepEqual(
          all.map((e) => e.seq),
          [1, 2, 3],
        );

        const afterOne = sys.readEventsAfter(networkId, 1, 10);
        assert.deepEqual(
          afterOne.map((e) => e.seq),
          [2, 3],
        );

        const limited = sys.readEventsAfter(networkId, 0, 2);
        assert.deepEqual(
          limited.map((e) => e.seq),
          [1, 2],
        );
        // The envelope is rebuilt from columns + stored data.
        const first = limited[0] as AnyRealtimeEvent;
        assert.equal(first.type, 'thought.created');
        assert.equal(first.network_id, networkId);
        assert.equal(first.actor.user_id, 'u1');
        assert.equal(first.audience, 'network');
      } finally {
        sys.close();
      }
    });

    it('getMinEventSeq returns the oldest retained seq or null', () => {
      const { sys, networkId } = openStore();
      try {
        assert.equal(sys.getMinEventSeq(networkId), null);
        appendStoredEvent(sys, networkId, 7, 'link.created');
        appendStoredEvent(sys, networkId, 8, 'link.deleted');
        assert.equal(sys.getMinEventSeq(networkId), 7);
      } finally {
        sys.close();
      }
    });

    it('pruneOldEvents drops expired rows but keeps the newest keepRows', async () => {
      const { sys, networkId } = openStore();
      try {
        for (let seq = 1; seq <= 5; seq += 1) {
          appendStoredEvent(sys, networkId, seq, 'comment.created');
        }
        // Let the clock advance past the millisecond the rows were written —
        // the cutoff compares ISO strings strictly (`ts < cutoff`).
        await new Promise((resolve) => setTimeout(resolve, 20));
        // ttlHours = 0 → everything older than "now" is expired; keepRows
        // protects the 2 newest rows regardless of age.
        const removed = sys.pruneOldEvents(networkId, 2, 0);
        assert.equal(removed, 3);
        assert.deepEqual(
          sys.readEventsAfter(networkId, 0, 10).map((e) => e.seq),
          [4, 5],
        );
      } finally {
        sys.close();
      }
    });

    it('pruneOldEvents keeps fresh rows even beyond keepRows', () => {
      const { sys, networkId } = openStore();
      try {
        for (let seq = 1; seq <= 5; seq += 1) {
          appendStoredEvent(sys, networkId, seq, 'comment.created');
        }
        // Nothing is older than 24h → nothing removed, keepRows irrelevant.
        const removed = sys.pruneOldEvents(networkId, 2, 24);
        assert.equal(removed, 0);
        assert.equal(sys.readEventsAfter(networkId, 0, 10).length, 5);
      } finally {
        sys.close();
      }
    });

    it('listEventLogNetworkIds enumerates networks with retained events', () => {
      const { sys, networkId } = openStore();
      try {
        assert.deepEqual(sys.listEventLogNetworkIds(), []);
        appendStoredEvent(sys, networkId, 1, 'comment.created');
        assert.deepEqual(sys.listEventLogNetworkIds(), [networkId]);
      } finally {
        sys.close();
      }
    });
  },
);
