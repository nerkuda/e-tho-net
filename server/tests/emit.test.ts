/**
 * Tests for the {@link emitDomainEvent} helper (task E3;
 * docs/04-realtime.md §4–5).
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
import { emitDomainEvent } from '../src/realtime/emit.js';
import { PubSub } from '../src/realtime/pubsub.js';

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
  'emitDomainEvent (E3)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('assigns a seq, persists the envelope and publishes to the broker', () => {
      const { sys, networkId } = openStore();
      const pubsub = new PubSub();
      const received: AnyRealtimeEvent[] = [];
      const unsubscribe = pubsub.subscribe(networkId, (event) => received.push(event));
      try {
        const event = emitDomainEvent(
          { systemDb: sys, pubsub },
          networkId,
          'member.added',
          { user_id: 'u2', role: 'member', added_by: 'u1' },
          { user_id: 'u1', client_id: null },
          { meta: { request_id: 'req-1' } },
        );
        assert.equal(event.seq, 1);
        assert.equal(event.audience, 'network');
        // Actor client_id normalised to '' when absent.
        assert.equal(event.actor.client_id, '');
        assert.equal(event.meta?.request_id, 'req-1');

        // Live delivery through the broker.
        assert.equal(received.length, 1);
        assert.equal(received[0]?.seq, 1);

        // Persisted for replay.
        const replay = sys.readEventsAfter(networkId, 0, 10);
        assert.equal(replay.length, 1);
        assert.equal(replay[0]?.type, 'member.added');
        assert.equal(replay[0]?.meta?.request_id, 'req-1');
      } finally {
        unsubscribe();
        pubsub.clear();
        sys.close();
      }
    });

    it('derives audience=user from the catalogue for private settings', () => {
      const { sys, networkId } = openStore();
      const pubsub = new PubSub();
      const received: AnyRealtimeEvent[] = [];
      const unsubscribe = pubsub.subscribe(networkId, (event) => received.push(event));
      try {
        emitDomainEvent(
          { systemDb: sys, pubsub },
          networkId,
          'user-preference.updated',
          { key: 'show_inactive', value: true },
          { user_id: 'u1', client_id: 'c1' },
        );
        assert.equal(received[0]?.audience, 'user');
        assert.equal(sys.readEventsAfter(networkId, 0, 10)[0]?.audience, 'user');
      } finally {
        unsubscribe();
        pubsub.clear();
        sys.close();
      }
    });

    it('honours an explicit audience override', () => {
      const { sys, networkId } = openStore();
      const pubsub = new PubSub();
      const received: AnyRealtimeEvent[] = [];
      const unsubscribe = pubsub.subscribe(networkId, (event) => received.push(event));
      try {
        emitDomainEvent(
          { systemDb: sys, pubsub },
          networkId,
          'thought.deleted',
          { id: 't1' },
          { user_id: 'u1', client_id: 'c1' },
          { audience: 'user' },
        );
        assert.equal(received[0]?.audience, 'user');
      } finally {
        unsubscribe();
        pubsub.clear();
        sys.close();
      }
    });

    it('assigns strictly increasing seq across emits', () => {
      const { sys, networkId } = openStore();
      const pubsub = new PubSub();
      try {
        const first = emitDomainEvent(
          { systemDb: sys, pubsub },
          networkId,
          'link.deleted',
          { id: 'l1' },
          { user_id: 'u1', client_id: null },
        );
        const second = emitDomainEvent(
          { systemDb: sys, pubsub },
          networkId,
          'link.deleted',
          { id: 'l2' },
          { user_id: 'u1', client_id: null },
        );
        assert.equal(first.seq + 1, second.seq);
      } finally {
        pubsub.clear();
        sys.close();
      }
    });
  },
);
