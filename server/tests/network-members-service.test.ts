/**
 * Unit tests for {@link NetworkMembersService} (task B9).
 *
 * Requires the `better-sqlite3` native binding; skipped otherwise. Inserts
 * network/membership rows directly to avoid depending on the not-yet-built
 * NetworkService (task C10), then exercises the cache and invalidation.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';

import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir } from '../src/paths.js';
import { NetworkMembersService } from '../src/domain/network-members-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Seed a network + an owner membership row directly in `_system.db`. */
function seedMembership(db: Database.Database): {
  networkId: string;
  ownerId: string;
  memberId: string;
} {
  const sys = new SystemDb(db);
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const networkId = randomUUID();
  sys.createUser({
    id: ownerId,
    username: 'owner',
    displayName: 'Owner',
    isAdmin: true,
    isFirstUser: true,
  });
  sys.createUser({ id: memberId, username: 'member', displayName: 'Member' });
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO networks (id, display_name, owner_id, description, created_at, updated_at) VALUES (?, 'Net', ?, NULL, ?, ?)",
  ).run(networkId, ownerId, now, now);
  const insertMember = db.prepare(
    'INSERT INTO network_members (network_id, user_id, role, added_at, added_by) VALUES (?, ?, ?, ?, ?)',
  );
  insertMember.run(networkId, ownerId, 'owner', now, ownerId);
  insertMember.run(networkId, memberId, 'member', now, ownerId);
  return { networkId, ownerId, memberId };
}

describe(
  'NetworkMembersService',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('resolves owner and member roles', () => {
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db, systemMigrationsDir());
      const { networkId, ownerId, memberId } = seedMembership(db);
      const sys = new SystemDb(db);
      const svc = new NetworkMembersService(sys);
      try {
        assert.equal(svc.getMemberRole(ownerId, networkId), 'owner');
        assert.equal(svc.getMemberRole(memberId, networkId), 'member');
        assert.equal(svc.isMember(ownerId, networkId), true);
      } finally {
        sys.close();
      }
    });

    it('returns null for a non-member and caches it', () => {
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db, systemMigrationsDir());
      const { networkId } = seedMembership(db);
      const sys = new SystemDb(db);
      const svc = new NetworkMembersService(sys);
      try {
        const soonToBeMember = randomUUID();
        // 1. Not a member yet -> null, and cached as null.
        assert.equal(svc.getMemberRole(soonToBeMember, networkId), null);
        assert.equal(svc.isMember(soonToBeMember, networkId), false);
        // 2. Add a membership row underneath the cache.
        sys.createUser({ id: soonToBeMember, username: 'late', displayName: null });
        db.prepare(
          "INSERT INTO network_members (network_id, user_id, role, added_at, added_by) VALUES (?, ?, 'member', ?, ?)",
        ).run(networkId, soonToBeMember, new Date().toISOString(), soonToBeMember);
        // 3. Cache must still report null until invalidated.
        assert.equal(
          svc.getMemberRole(soonToBeMember, networkId),
          null,
          'cache should mask the new row',
        );
        // 4. After invalidation the fresh DB value is visible.
        svc.invalidate(soonToBeMember, networkId);
        assert.equal(
          svc.getMemberRole(soonToBeMember, networkId),
          'member',
          'invalidation reveals the new row',
        );
      } finally {
        sys.close();
      }
    });

    it('invalidate(user) drops all of that user entries', () => {
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db, systemMigrationsDir());
      const { networkId, ownerId } = seedMembership(db);
      const sys = new SystemDb(db);
      const svc = new NetworkMembersService(sys);
      try {
        svc.getMemberRole(ownerId, networkId); // warm cache
        svc.invalidate(ownerId);
        // Re-read after invalidation still correct.
        assert.equal(svc.getMemberRole(ownerId, networkId), 'owner');
      } finally {
        sys.close();
      }
    });

    it('invalidate() with no args clears everything', () => {
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db, systemMigrationsDir());
      const { networkId, ownerId, memberId } = seedMembership(db);
      const sys = new SystemDb(db);
      const svc = new NetworkMembersService(sys);
      try {
        svc.getMemberRole(ownerId, networkId);
        svc.getMemberRole(memberId, networkId);
        svc.invalidate();
        assert.equal(svc.isMember(ownerId, networkId), true);
      } finally {
        sys.close();
      }
    });
  },
);
