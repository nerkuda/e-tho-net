/**
 * Unit tests for the attachment domain service (task C8).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb, NetworkDb } from '../src/db/network-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { networkMigrationsDir } from '../src/paths.js';
import {
  createAttachment,
  createAttachmentFile,
  deleteAttachment,
  listAttachments,
  updateAttachment,
} from '../src/domain/attachment-service.js';

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

/** Seed a thought directly so the polymorphic owner exists. */
function seedThought(ndb: NetworkDb, title = 'Seed'): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase());
  return id;
}

describe(
  'attachment-service',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('creates a url attachment and stores url (not file_path)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const a = createAttachment(
          ndb,
          'thought',
          t,
          { kind: 'url', url: 'https://e.com/page', title: 'Page' },
          USER,
        );
        assert.equal(a.kind, 'url');
        assert.equal(a.url, 'https://e.com/page');
        assert.equal(a.file_path, null);
        assert.equal(a.title, 'Page');
        assert.equal(a.position, 0);
      } finally {
        ndb.close();
      }
    });

    it('creates a file attachment storing only the path', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const a = createAttachment(
          ndb,
          'thought',
          t,
          {
            kind: 'file',
            file_path: 'C:\\docs\\x.pdf',
            mime_type: 'application/pdf',
            file_size: 123,
          },
          USER,
        );
        assert.equal(a.kind, 'file');
        assert.equal(a.file_path, 'C:\\docs\\x.pdf');
        assert.equal(a.url, null);
        assert.equal(a.mime_type, 'application/pdf');
        assert.equal(a.file_size, 123);
      } finally {
        ndb.close();
      }
    });

    it('createAttachmentFile stores the payload in attachments/ next to data.db', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-att-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'att-test', path.join(tmp, 'data.db'));
      try {
        const t = seedThought(ndb);
        const a = createAttachmentFile(
          ndb,
          'thought',
          t,
          { title: 'Фото 1', mime_type: 'image/png', data_base64: Buffer.from('fake-png').toString('base64') },
          USER,
        );
        assert.equal(a.kind, 'file');
        assert.ok(a.file_path !== null);
        assert.equal(path.dirname(a.file_path), path.join(tmp, 'attachments'));
        assert.ok(a.file_path.endsWith('.png'), a.file_path);
        assert.equal(a.file_size, 'fake-png'.length);
        assert.equal(a.title, 'Фото 1');
        assert.ok(existsSync(a.file_path));
        assert.equal(readFileSync(a.file_path).toString(), 'fake-png');
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('createAttachmentFile rejects a bad payload (422)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        assert.throws(
          () =>
            createAttachmentFile(
              ndb,
              'thought',
              t,
              { mime_type: 'image/png', data_base64: '!!not-base64!!' },
              USER,
            ),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('rejects url attachment without url (422)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        assert.throws(
          () => createAttachment(ndb, 'thought', t, { kind: 'url' }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('rejects file attachment without file_path (422)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        assert.throws(
          () => createAttachment(ndb, 'thought', t, { kind: 'file' }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('rejects creation for an unknown owner (404)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        assert.throws(
          () =>
            createAttachment(
              ndb,
              'thought',
              randomUUID(),
              { kind: 'url', url: 'https://e.com' },
              USER,
            ),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );
      } finally {
        ndb.close();
      }
    });

    it('lists attachments ordered by position', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        createAttachment(ndb, 'thought', t, { kind: 'url', url: 'https://a', position: 2 }, USER);
        createAttachment(ndb, 'thought', t, { kind: 'url', url: 'https://b', position: 1 }, USER);
        const list = listAttachments(ndb, 'thought', t);
        assert.deepEqual(
          list.map((a) => a.url),
          ['https://b', 'https://a'],
        );
      } finally {
        ndb.close();
      }
    });

    it('updates fields without a version guard', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const a = createAttachment(ndb, 'thought', t, { kind: 'url', url: 'https://x' }, USER);
        const updated = updateAttachment(ndb, a.id, { url: 'https://y', title: 'T' });
        assert.equal(updated.url, 'https://y');
        assert.equal(updated.title, 'T');
      } finally {
        ndb.close();
      }
    });

    it('refuses to clear the url of a url attachment (422)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const a = createAttachment(ndb, 'thought', t, { kind: 'url', url: 'https://x' }, USER);
        assert.throws(
          () => updateAttachment(ndb, a.id, { url: '  ' }),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('deletes an attachment', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const a = createAttachment(ndb, 'thought', t, { kind: 'url', url: 'https://x' }, USER);
        deleteAttachment(ndb, a.id);
        assert.equal(listAttachments(ndb, 'thought', t).length, 0);
      } finally {
        ndb.close();
      }
    });
  },
);
