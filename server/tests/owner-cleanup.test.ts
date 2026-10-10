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

import { BASE_LAYER_ID } from '@etn/shared';

import { runMigrations } from '../src/db/migrator.js';
import { createInMemoryNetworkDb, NetworkDb, registerMigrationHelpers } from '../src/db/network-db.js';
import { networkMigrationsDir } from '../src/paths.js';
import {
  addOwners,
  createAttachment,
  createAttachmentFile,
  getAttachment,
  hasOwnership,
  listAttachments,
  removeOwner,
} from '../src/domain/attachment-service.js';
import { createComment, createCommentWithTargets } from '../src/domain/comment-service.js';
import { createLink, deleteLink } from '../src/domain/link-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createPublication, purgePublication } from '../src/domain/publication-service.js';
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

/** Insert a working layer directly under the base layer. */
function seedLayerId(ndb: NetworkDb): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, 'Layer', 0, 1, 'u', ?, ?)`,
    )
    .run(id, BASE_LAYER_ID, now, now);
  return id;
}

/** Count polymorphic rows still pointing at the given owner. */
function dependantCount(ndb: NetworkDb, ownerType: 'thought' | 'link', ownerId: string): number {
  const count = (table: string): number =>
    (
      ndb
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_type = ? AND owner_id = ?`)
        .get(ownerType, ownerId) as { n: number } | undefined
    )?.n as number;
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
        createTypeProperty(ndb, 'link_type', lt.id, { key: 'weight', value_type: 'number' }, USER);
        const link = createLink(ndb, { source_id: a, target_id: b, type_id: lt.id }, USER);
        createComment(ndb, 'link', link.id, { kind: 'permanent', body_md: 'link note' }, USER);
        createAttachment(
          ndb,
          'link',
          link.id,
          { kind: 'url', url: 'https://example.com' },
          USER,
        );
        setPropertyValue(ndb, 'link', link.id, 'weight', 5, USER);
        assert.ok(dependantCount(ndb, 'link', link.id) > 0);

        deleteLink(ndb, link.id, undefined);

        assert.equal(dependantCount(ndb, 'link', link.id), 0);
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS n FROM links WHERE id = ?').get(link.id) as
            | { n: number }
            | undefined)?.n,
          0,
        );
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

        const gone = (ndb.prepare('SELECT COUNT(*) AS n FROM comments WHERE id = ?').get(
          ownedByLink.id,
        ) as { n: number } | undefined)?.n;
        assert.equal(gone, 0);
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS n FROM comment_targets WHERE comment_id = ?').get(
            ownedByLink.id,
          ) as { n: number } | undefined)?.n,
          0,
        );
        const kept = (ndb
          .prepare('SELECT COUNT(*) AS n FROM comments WHERE id = ?')
          .get(ownedByThought.id) as { n: number } | undefined)?.n;
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
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'note', value_type: 'text' }, USER);
        const lt = createLinkType(ndb, { name_forward: 'parent', name_reverse: 'child' }, USER);
        createTypeProperty(ndb, 'link_type', lt.id, { key: 'weight', value_type: 'number' }, USER);

        const a = seedThought(ndb, tt.id, 'A');
        const b = seedThought(ndb, null, 'B');
        const c = seedThought(ndb, null, 'C');
        const linkIn = createLink(ndb, { source_id: b, target_id: a, type_id: lt.id }, USER);
        const linkOut = createLink(ndb, { source_id: a, target_id: c }, USER);

        // Thought's own dependants.
        createComment(ndb, 'thought', a, { kind: 'permanent', body_md: 'a note' }, USER);
        createAttachment(ndb, 'thought', a, { kind: 'url', url: 'https://example.com/a' }, USER);
        setPropertyValue(ndb, 'thought', a, 'note', 'x', USER);
        // Dependants of the links that the FK cascade removes silently.
        createComment(ndb, 'link', linkIn.id, { kind: 'permanent', body_md: 'in' }, USER);
        createAttachment(ndb, 'link', linkOut.id, { kind: 'url', url: 'https://example.com/l' }, USER);
        setPropertyValue(ndb, 'link', linkIn.id, 'weight', 3, USER);
        assert.ok(dependantCount(ndb, 'thought', a) > 0);
        assert.ok(dependantCount(ndb, 'link', linkIn.id) > 0);
        assert.ok(dependantCount(ndb, 'link', linkOut.id) > 0);

        deleteThought(ndb, a, undefined, USER);

        assert.equal(dependantCount(ndb, 'thought', a), 0);
        assert.equal(dependantCount(ndb, 'link', linkIn.id), 0);
        assert.equal(dependantCount(ndb, 'link', linkOut.id), 0);
        // The link rows themselves are gone (FK cascade), the other thoughts stay.
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number } | undefined)?.n,
          0,
        );
        for (const survivor of [b, c]) {
          assert.equal(
            (ndb.prepare('SELECT COUNT(*) AS n FROM thoughts WHERE id = ?').get(survivor) as
              | { n: number }
              | undefined)?.n,
            1,
          );
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

        deleteThought(ndb, a, undefined, USER);

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

        deleteThought(ndb, hub, undefined, USER);

        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS n FROM attachments WHERE owner_type = ?').get('link') as
            | { n: number }
            | undefined)?.n,
          0,
        );
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number } | undefined)?.n,
          0,
        );
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS n FROM thoughts').get() as { n: number } | undefined)?.n,
          spokeIds.length,
        );
      } finally {
        ndb.close();
      }
    });

    // -----------------------------------------------------------------------
    // Multi-owned attachments (0.12.1, ADR 9f90b010, задача da59a4cf):
    // удаление владельца снимает ТОЛЬКО его владения; вложение и файл живут,
    // пока есть живой владелец в любом рабочем слое.
    // -----------------------------------------------------------------------

    it('deleteThought keeps a shared attachment, its file and the other owner alive', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-cleanup-shared-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'cleanup-shared', path.join(tmp, 'data.db'));
      try {
        const a = seedThought(ndb, null, 'A');
        const b = seedThought(ndb, null, 'B');
        const file = createAttachmentFile(
          ndb,
          'thought',
          a,
          { title: 'shared.txt', mime_type: 'text/plain', data_base64: Buffer.from('shared').toString('base64') },
          USER,
        );
        addOwners(ndb, file.id, 'thought', [b], USER);
        assert.equal(listAttachments(ndb, 'thought', b).length, 1);
        assert.ok(file.file_path !== null && existsSync(file.file_path));

        deleteThought(ndb, a, undefined, USER);

        // Вложение и файл живы — у вложения остался живой владелец B.
        assert.notEqual(getAttachment(ndb, file.id), null);
        assert.ok(file.file_path !== null && existsSync(file.file_path));
        assert.equal(hasOwnership(ndb, file.id, 'thought', a), false);
        assert.deepEqual(
          listAttachments(ndb, 'thought', b).map((x) => x.id),
          [file.id],
        );
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('deleteThought removes the attachment and its file once the last owner is gone', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-cleanup-last-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'cleanup-last', path.join(tmp, 'data.db'));
      try {
        const a = seedThought(ndb, null, 'A');
        const b = seedThought(ndb, null, 'B');
        const file = createAttachmentFile(
          ndb,
          'thought',
          a,
          { title: 'last.txt', mime_type: 'text/plain', data_base64: Buffer.from('last').toString('base64') },
          USER,
        );
        addOwners(ndb, file.id, 'thought', [b], USER);
        removeOwner(ndb, file.id, 'thought', b); // B отвязался, остался A
        assert.notEqual(getAttachment(ndb, file.id), null);

        deleteThought(ndb, a, undefined, USER);

        // Последний живой владелец ушёл — вложение, его владения и файл удалены.
        assert.equal(getAttachment(ndb, file.id), null);
        assert.ok(file.file_path !== null && !existsSync(file.file_path));
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS n FROM attachments WHERE id = ?').get(file.id) as { n: number }).n,
          0,
        );
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS n FROM attachment_owners WHERE attachment_id = ?').get(file.id) as
            | { n: number }).n,
          0,
        );
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('deleteThought in base keeps the file when another owner lives in a working layer', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-cleanup-crosslayer-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'cleanup-crosslayer', path.join(tmp, 'data.db'));
      try {
        const a = seedThought(ndb, null, 'A');
        const b = seedThought(ndb, null, 'B');
        const file = createAttachmentFile(
          ndb,
          'thought',
          a,
          { title: 'x.txt', mime_type: 'text/plain', data_base64: Buffer.from('x').toString('base64') },
          USER,
        );
        const layerId = seedLayerId(ndb);
        ndb.useLayer(layerId);
        addOwners(ndb, file.id, 'thought', [b], USER); // владение в рабочем слое
        ndb.useLayer(BASE_LAYER_ID);

        deleteThought(ndb, a, undefined, USER);

        // Живое владение в другом рабочем слое удерживает вложение и файл.
        assert.notEqual(getAttachment(ndb, file.id), null);
        assert.ok(file.file_path !== null && existsSync(file.file_path));
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('deleteThought in a layer hides the attachment there but keeps the base row and file', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-cleanup-layer-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'cleanup-layer', path.join(tmp, 'data.db'));
      try {
        const a = seedThought(ndb, null, 'A');
        const file = createAttachmentFile(
          ndb,
          'thought',
          a,
          { title: 'layer.txt', mime_type: 'text/plain', data_base64: Buffer.from('layer').toString('base64') },
          USER,
        );
        const layerId = seedLayerId(ndb);
        ndb.useLayer(layerId);
        deleteThought(ndb, a, undefined, USER);

        // В слое вложение скрыто (надгробие владения + строки), файл на диске цел.
        assert.equal(getAttachment(ndb, file.id), null);
        assert.ok(file.file_path !== null && existsSync(file.file_path));

        // Основа не тронута: строка вложения и владение живы.
        ndb.useLayer(BASE_LAYER_ID);
        assert.notEqual(getAttachment(ndb, file.id), null);
        assert.equal(hasOwnership(ndb, file.id, 'thought', a), true);
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('deleteThought clears dangling icon and cover references to the removed attachment', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, null, 'A');
        const u = seedThought(ndb, null, 'U');
        const att = createAttachment(ndb, 'thought', a, { kind: 'url', url: 'https://example.com/i' }, USER);
        // Висячие ссылки на чужое вложение (сырые данные — валидация владения
        // иконкой/обложкой 0.12.1 ещё в работе, задача 08869cfc).
        ndb.prepare('UPDATE thoughts SET icon_attachment_id = ? WHERE id = ?').run(att.id, u);
        const pub = createPublication(ndb, { title: 'P' }, USER);
        ndb
          .prepare('UPDATE publications SET cover_attachment_id = ? WHERE id = ?')
          .run(att.id, pub.id);

        deleteThought(ndb, a, undefined, USER);

        assert.equal(getAttachment(ndb, att.id), null);
        assert.equal(
          (ndb.prepare('SELECT icon_attachment_id FROM thoughts WHERE id = ?').get(u) as {
            icon_attachment_id: string | null;
          }).icon_attachment_id,
          null,
        );
        assert.equal(
          (ndb.prepare('SELECT cover_attachment_id FROM publications WHERE id = ?').get(pub.id) as {
            cover_attachment_id: string | null;
          }).cover_attachment_id,
          null,
        );
      } finally {
        ndb.close();
      }
    });

    it('purgePublication keeps a cover attachment shared with another owner', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-cleanup-pub-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'cleanup-pub', path.join(tmp, 'data.db'));
      try {
        const t = seedThought(ndb, null, 'T');
        const pub = createPublication(ndb, { title: 'P' }, USER);
        const file = createAttachmentFile(
          ndb,
          'publication',
          pub.id,
          { title: 'cover.png', mime_type: 'image/png', data_base64: Buffer.from('png').toString('base64') },
          USER,
        );
        addOwners(ndb, file.id, 'thought', [t], USER);
        ndb
          .prepare('UPDATE publications SET cover_attachment_id = ? WHERE id = ? AND layer_id = ?')
          .run(file.id, pub.id, BASE_LAYER_ID);

        purgePublication(ndb, pub.id);

        // Владение публикации снято, но общее вложение и файл живы у владельца T.
        assert.equal(hasOwnership(ndb, file.id, 'publication', pub.id), false);
        assert.notEqual(getAttachment(ndb, file.id), null);
        assert.ok(file.file_path !== null && existsSync(file.file_path));
        assert.deepEqual(
          listAttachments(ndb, 'thought', t).map((x) => x.id),
          [file.id],
        );
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  },
);
