/**
 * Unit tests for the owner-deletion cascade cleanup (owner-cleanup.ts).
 *
 * Covers the bug «не удаляются вложения и значения свойств при удалении
 * мыслей»: `comments`/`attachments`/`property_values` are polymorphic (no SQL
 * FK), so `deleteLink` must purge the link's dependants and `deleteThought`
 * must purge both its own dependants and those of the links the FK cascade
 * removes silently. Server-stored attachment files are removed from disk too.
 * Skipped entirely when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { runMigrations } from '../src/db/migrator.js';
import { createInMemoryNetworkDb, NetworkDb, registerMigrationHelpers } from '../src/db/network-db.js';
import { networkMigrationsDir } from '../src/paths.js';
import { createAttachment, createAttachmentFile } from '../src/domain/attachment-service.js';
import { createComment, createCommentWithTargets } from '../src/domain/comment-service.js';
import { createLink, deleteLink } from '../src/domain/link-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createTypeProperty, setPropertyValue } from '../src/domain/property-service.js';
import { deleteThought } from '../src/domain/thought-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Insert a thought row directly (bypasses the service; no HOME seeding). */
function seedThought(ndb: NetworkDb, typeId: string | null = null, title = 'T'): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 1, '2024-01-01', 'u', '2024-01-01', 'u')`,
    )
    .run(id, title, title.toLowerCase(), typeId);
  return id;
}

/** Count polymorphic rows still pointing at the given owner. */
function dependantCount(ndb: NetworkDb, ownerType: 'thought' | 'link', ownerId: string): number {
  const count = (table: string): number =>
    ndb.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_type = ? AND owner_id = ?`).get(ownerType, ownerId)
      ?.n as number;
  return count('comments') + count('comment_targets') + count('attachments') + count('property_values');
}

describe(
  'owner-cleanup (deletion cascade)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('deleteLink purges the link comments, attachments and property values', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, null, 'A');
        const b = seedThought(ndb, null, 'B');
        const lt = createLinkType(ndb, { name_forward: 'parent', name_reverse: 'child' }, USER);
        createTypeProperty(ndb, 'link_type', lt.id, { key: 'weight', value_type: 'number' });
        const link = createLink(ndb, { source_id: a, target_id: b, type_id: lt.id }, USER);
        createComment(ndb, 'link', link.id, { kind: 'permanent', body_md: 'link note' }, USER);
        createAttachment(
          ndb,
          'link',
          link.id,
          { kind: 'url', url: 'https://example.com' },
          USER,
        );
        setPropertyValue(ndb, 'link', link.id, 'weight', 5);
        assert.ok(dependantCount(ndb, 'link', link.id) > 0);

        deleteLink(ndb, link.id, undefined);

        assert.equal(dependantCount(ndb, 'link', link.id), 0);
        assert.equal(ndb.prepare('SELECT COUNT(*) AS n FROM links WHERE id = ?').get(link.id)?.n, 0);
      } finally {
        ndb.close();
      }
    });

    it('deleteLink deletes primary-owned comments entirely and only detaches secondary targets', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, null, 'A');
        const b = seedThought(ndb, null, 'B');
        const link = createLink(ndb, { source_id: a, target_id: b }, USER);
        // Primary owner = link, secondary target = thought A → deleted entirely.
        const ownedByLink = createCommentWithTargets(
          ndb,
          [
            { owner_type: 'link', owner_id: link.id },
            { owner_type: 'thought', owner_id: a },
          ],
          { kind: 'chronological', body_md: 'dies with the link' },
          USER,
        );
        // Primary owner = thought A, secondary target = link → only detached.
        const ownedByThought = createCommentWithTargets(
          ndb,
          [
            { owner_type: 'thought', owner_id: a },
            { owner_type: 'link', owner_id: link.id },
          ],
          { kind: 'chronological', body_md: 'survives' },
          USER,
        );

        deleteLink(ndb, link.id, undefined);

        const gone = ndb.prepare('SELECT COUNT(*) AS n FROM comments WHERE id = ?').get(ownedByLink.id)?.n;
        assert.equal(gone, 0);
        assert.equal(
          ndb.prepare('SELECT COUNT(*) AS n FROM comment_targets WHERE comment_id = ?').get(ownedByLink.id)?.n,
          0,
        );
        const kept = ndb
          .prepare('SELECT COUNT(*) AS n FROM comments WHERE id = ?')
          .get(ownedByThought.id)?.n;
        assert.equal(kept, 1);
        const keptTargets = ndb
          .prepare('SELECT owner_type, owner_id FROM comment_targets WHERE comment_id = ?')
          .all(ownedByThought.id) as { owner_type: string; owner_id: string }[];
        assert.deepEqual(keptTargets, [{ owner_type: 'thought', owner_id: a }]);
      } finally {
        ndb.close();
      }
    });

    it('deleteThought purges its own dependants and those of the FK-cascaded links', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Note' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'note', value_type: 'text' });
        const lt = createLinkType(ndb, { name_forward: 'parent', name_reverse: 'child' }, USER);
        createTypeProperty(ndb, 'link_type', lt.id, { key: 'weight', value_type: 'number' });

        const a = seedThought(ndb, tt.id, 'A');
        const b = seedThought(ndb, null, 'B');
        const c = seedThought(ndb, null, 'C');
        const linkIn = createLink(ndb, { source_id: b, target_id: a, type_id: lt.id }, USER);
        const linkOut = createLink(ndb, { source_id: a, target_id: c }, USER);

        // Thought's own dependants.
        createComment(ndb, 'thought', a, { kind: 'permanent', body_md: 'a note' }, USER);
        createAttachment(ndb, 'thought', a, { kind: 'url', url: 'https://example.com/a' }, USER);
        setPropertyValue(ndb, 'thought', a, 'note', 'x');
        // Dependants of the links that the FK cascade removes silently.
        createComment(ndb, 'link', linkIn.id, { kind: 'permanent', body_md: 'in' }, USER);
        createAttachment(ndb, 'link', linkOut.id, { kind: 'url', url: 'https://example.com/l' }, USER);
        setPropertyValue(ndb, 'link', linkIn.id, 'weight', 3);
        assert.ok(dependantCount(ndb, 'thought', a) > 0);
        assert.ok(dependantCount(ndb, 'link', linkIn.id) > 0);
        assert.ok(dependantCount(ndb, 'link', linkOut.id) > 0);

        deleteThought(ndb, a, undefined);

        assert.equal(dependantCount(ndb, 'thought', a), 0);
        assert.equal(dependantCount(ndb, 'link', linkIn.id), 0);
        assert.equal(dependantCount(ndb, 'link', linkOut.id), 0);
        // The link rows themselves are gone (FK cascade), the other thoughts stay.
        assert.equal(ndb.prepare('SELECT COUNT(*) AS n FROM links').get()?.n, 0);
        for (const survivor of [b, c]) {
          assert.equal(ndb.prepare('SELECT COUNT(*) AS n FROM thoughts WHERE id = ?').get(survivor)?.n, 1);
        }
      } finally {
        ndb.close();
      }
    });

    it('deleteThought removes server-stored files of its own and its links attachments', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-cleanup-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'cleanup-test', path.join(tmp, 'data.db'));
      try {
        const a = seedThought(ndb, null, 'A');
        const b = seedThought(ndb, null, 'B');
        const link = createLink(ndb, { source_id: a, target_id: b }, USER);
        const ownFile = createAttachmentFile(
          ndb,
          'thought',
          a,
          { title: 'a.txt', mime_type: 'text/plain', data_base64: Buffer.from('own').toString('base64') },
          USER,
        );
        const linkFile = createAttachmentFile(
          ndb,
          'link',
          link.id,
          { title: 'l.txt', mime_type: 'text/plain', data_base64: Buffer.from('link').toString('base64') },
          USER,
        );
        assert.ok(ownFile.file_path !== null && existsSync(ownFile.file_path));
        assert.ok(linkFile.file_path !== null && existsSync(linkFile.file_path));

        deleteThought(ndb, a, undefined);

        assert.ok(ownFile.file_path !== null && !existsSync(ownFile.file_path));
        assert.ok(linkFile.file_path !== null && !existsSync(linkFile.file_path));
        assert.equal(dependantCount(ndb, 'thought', a), 0);
        assert.equal(dependantCount(ndb, 'link', link.id), 0);
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('deleteThought purges dependants of every incident link, across chunk boundaries', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const hub = seedThought(ndb, null, 'hub');
        const spokeIds: string[] = [];
        for (let i = 0; i < 505; i++) {
          const spoke = seedThought(ndb, null, `spoke-${i}`);
          spokeIds.push(spoke);
          const link = createLink(ndb, { source_id: hub, target_id: spoke }, USER);
          createAttachment(
            ndb,
            'link',
            link.id,
            { kind: 'url', url: `https://example.com/${i}` },
            USER,
          );
        }

        deleteThought(ndb, hub, undefined);

        assert.equal(
          ndb.prepare('SELECT COUNT(*) AS n FROM attachments WHERE owner_type = ?').get('link')?.n,
          0,
        );
        assert.equal(ndb.prepare('SELECT COUNT(*) AS n FROM links').get()?.n, 0);
        assert.equal(
          ndb.prepare('SELECT COUNT(*) AS n FROM thoughts').get()?.n,
          spokeIds.length,
        );
      } finally {
        ndb.close();
      }
    });
  },
);
