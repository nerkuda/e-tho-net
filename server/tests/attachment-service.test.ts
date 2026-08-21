/**
 * Unit tests for the attachment domain service (task C8).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb, NetworkDb, registerMigrationHelpers } from '../src/db/network-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { networkMigrationsDir } from '../src/paths.js';
import {
  copyAttachment,
  createAttachment,
  createAttachmentFile,
  deleteAttachment,
  enrichUrlAttachment,
  extractFaviconUrl,
  extractHtmlTitle,
  getAttachment,
  getAttachmentContent,
  listAttachments,
  searchAttachments,
  updateAttachment,
  updateAttachmentContent,
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
      registerMigrationHelpers(db);
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

    it('clears a thought icon reference when the attachment is deleted (L16)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const a = createAttachment(
          ndb,
          'thought',
          t,
          { kind: 'file', file_path: 'pic.png', mime_type: 'image/png' },
          USER,
        );
        ndb
          .prepare('UPDATE thoughts SET icon_attachment_id = ? WHERE id = ?')
          .run(a.id, t);
        deleteAttachment(ndb, a.id);
        const row = ndb
          .prepare('SELECT icon_attachment_id FROM thoughts WHERE id = ?')
          .get(t) as { icon_attachment_id: string | null };
        assert.equal(row.icon_attachment_id, null);
      } finally {
        ndb.close();
      }
    });

    it('clears a thought icon reference when the attachment moves (L16)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t1 = seedThought(ndb, 'One');
        const t2 = seedThought(ndb, 'Two');
        const a = createAttachment(
          ndb,
          'thought',
          t1,
          { kind: 'file', file_path: 'pic.png', mime_type: 'image/png' },
          USER,
        );
        ndb
          .prepare('UPDATE thoughts SET icon_attachment_id = ? WHERE id = ?')
          .run(a.id, t1);
        updateAttachment(ndb, a.id, { owner_type: 'thought', owner_id: t2 });
        const row = ndb
          .prepare('SELECT icon_attachment_id FROM thoughts WHERE id = ?')
          .get(t1) as { icon_attachment_id: string | null };
        assert.equal(row.icon_attachment_id, null);
      } finally {
        ndb.close();
      }
    });

    it('deleteAttachment removes the server-stored file but not client-local paths', () => {
      const ndb = createInMemoryNetworkDb();
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-att-'));
      try {
        const t = seedThought(ndb);
        // A client-local path outside the network attachments dir.
        const local = path.join(tmp, 'local.txt');
        writeFileSync(local, 'keep me');
        const localAtt = createAttachment(
          ndb,
          'thought',
          t,
          { kind: 'file', file_path: local, title: 'local' },
          USER,
        );
        deleteAttachment(ndb, localAtt.id);
        assert.ok(existsSync(local), 'client-local file must survive attachment deletion');

        // A server-stored upload (inside the network attachments dir).
        const stored = createAttachmentFile(
          ndb,
          'thought',
          t,
          {
            title: 'pic',
            mime_type: 'image/png',
            data_base64: Buffer.from('fakepng').toString('base64'),
          },
          USER,
        );
        assert.ok(stored.file_path !== null && existsSync(stored.file_path));
        deleteAttachment(ndb, stored.id);
        assert.ok(stored.file_path !== null && !existsSync(stored.file_path));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        ndb.close();
      }
    });

    it('deleteAttachment keeps a stored file shared with another attachment', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-att-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'att-shared', path.join(tmp, 'data.db'));
      try {
        const t1 = seedThought(ndb, 'One');
        const t2 = seedThought(ndb, 'Two');
        const stored = createAttachmentFile(
          ndb,
          'thought',
          t1,
          { title: 'pic', mime_type: 'image/png', data_base64: Buffer.from('fakepng').toString('base64') },
          USER,
        );
        assert.ok(stored.file_path !== null && existsSync(stored.file_path));
        // A second row resolving to the same file (possible via PATCH file_path).
        const twin = createAttachment(
          ndb,
          'thought',
          t2,
          { kind: 'file', file_path: stored.file_path, mime_type: 'image/png' },
          USER,
        );
        deleteAttachment(ndb, stored.id);
        assert.ok(existsSync(stored.file_path), 'shared file must survive one row deletion');
        deleteAttachment(ndb, twin.id);
        assert.ok(!existsSync(stored.file_path!), 'file must go with the last reference');
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('deleteAttachment keeps the file while a thought icon is backed by it', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-att-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'att-icon', path.join(tmp, 'data.db'));
      try {
        const t = seedThought(ndb);
        const stored = createAttachmentFile(
          ndb,
          'thought',
          t,
          { title: 'pic', mime_type: 'image/png', data_base64: Buffer.from('fakepng').toString('base64') },
          USER,
        );
        assert.ok(stored.file_path !== null && existsSync(stored.file_path));
        ndb.prepare('UPDATE thoughts SET icon_attachment_id = ? WHERE id = ?').run(stored.id, t);
        deleteAttachment(ndb, stored.id);
        const row = ndb
          .prepare('SELECT icon_attachment_id FROM thoughts WHERE id = ?')
          .get(t) as { icon_attachment_id: string | null };
        assert.equal(row.icon_attachment_id, null, 'the dangling reference is still cleared');
        assert.ok(existsSync(stored.file_path), 'icon-backed file must stay on disk');
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('updateAttachment moves the attachment to another owner', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t1 = seedThought(ndb, 'One');
        const t2 = seedThought(ndb, 'Two');
        const a = createAttachment(ndb, 'thought', t1, { kind: 'url', url: 'https://x' }, USER);
        const moved = updateAttachment(ndb, a.id, { owner_type: 'thought', owner_id: t2 });
        assert.equal(moved.owner_id, t2);
        assert.equal(listAttachments(ndb, 'thought', t1).length, 0);
        assert.equal(listAttachments(ndb, 'thought', t2).length, 1);
        // Moving to a missing owner → NOT_FOUND, attachment stays put.
        assert.throws(
          () => updateAttachment(ndb, a.id, { owner_id: randomUUID() }),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );
        assert.equal(listAttachments(ndb, 'thought', t2).length, 1);
      } finally {
        ndb.close();
      }
    });

    it('updateAttachment validates the icon data: URL', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const a = createAttachment(ndb, 'thought', t, { kind: 'url', url: 'https://x' }, USER);
        assert.throws(
          () => updateAttachment(ndb, a.id, { icon: 'https://evil/x.png' }),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        const withIcon = updateAttachment(ndb, a.id, { icon: 'data:image/png;base64,AAA' });
        assert.equal(withIcon.icon, 'data:image/png;base64,AAA');
      } finally {
        ndb.close();
      }
    });

    it('extractHtmlTitle/extractFaviconUrl parse page metadata', () => {
      const html =
        '<html><head><link rel="shortcut icon" href="/f.ico">' +
        '<link rel="alternate" href="/feed"><title>  Привет &amp; мир </title></head></html>';
      assert.equal(extractHtmlTitle(html), 'Привет & мир');
      assert.equal(extractHtmlTitle('<html></html>'), null);
      assert.equal(extractFaviconUrl(html, 'https://site.ru/a/b.html'), 'https://site.ru/f.ico');
      assert.equal(
        extractFaviconUrl('<html></html>', 'https://site.ru/a/b.html'),
        'https://site.ru/favicon.ico',
      );
      // apple-touch-icon is accepted too.
      assert.equal(
        extractFaviconUrl(
          '<link rel="apple-touch-icon" href="https://cdn.x/i.png">',
          'https://site.ru/',
        ),
        'https://cdn.x/i.png',
      );
    });

    it('enrichUrlAttachment fills title and favicon (stubbed fetch)', async () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const a = createAttachment(
          ndb,
          'thought',
          t,
          { kind: 'url', url: 'https://site.ru/page' },
          USER,
        );
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const stub = (async (url: string | URL | Request): Promise<Response> => {
          const u = String(url);
          if (u === 'https://site.ru/page') {
            return new Response(
              '<html><head><link rel="icon" href="/i.png"><title>Страница</title></head></html>',
              { headers: { 'content-type': 'text/html; charset=utf-8' } },
            );
          }
          if (u === 'https://site.ru/i.png') {
            return new Response(png, { headers: { 'content-type': 'image/png' } });
          }
          return new Response('no', { status: 404 });
        }) as typeof fetch;
        const enriched = await enrichUrlAttachment(ndb, a, stub);
        assert.equal(enriched.title, 'Страница');
        assert.equal(enriched.icon, `data:image/png;base64,${png.toString('base64')}`);
        // Enrichment is skipped on network errors without breaking creation.
        const failing = (async () => {
          throw new Error('offline');
        }) as typeof fetch;
        const b = createAttachment(ndb, 'thought', t, { kind: 'url', url: 'https://y.ru' }, USER);
        const untouched = await enrichUrlAttachment(ndb, b, failing);
        assert.equal(untouched.title, null);
        assert.equal(untouched.icon, null);
      } finally {
        ndb.close();
      }
    });

    it('getAttachmentContent returns text, markdown html and truncation (L7)', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-att-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'att-content', path.join(tmp, 'data.db'));
      try {
        const t = seedThought(ndb);
        const md = createAttachmentFile(
          ndb,
          'thought',
          t,
          {
            title: 'Заметка',
            mime_type: 'text/markdown',
            data_base64: Buffer.from('# Заголовок\n\nтекст').toString('base64'),
          },
          USER,
        );
        const mdContent = getAttachmentContent(ndb, md.id);
        assert.equal(mdContent.text, '# Заголовок\n\nтекст');
        assert.ok(mdContent.html !== null && mdContent.html.includes('<h1'));
        assert.equal(mdContent.truncated, false);

        const txt = createAttachmentFile(
          ndb,
          'thought',
          t,
          { title: 'Лог', mime_type: 'text/plain', data_base64: Buffer.from('строка').toString('base64') },
          USER,
        );
        const txtContent = getAttachmentContent(ndb, txt.id);
        assert.equal(txtContent.text, 'строка');
        assert.equal(txtContent.html, null, 'plain text is not markdown-rendered');

        // Non-text attachments report no text.
        const png = createAttachmentFile(
          ndb,
          'thought',
          t,
          { mime_type: 'image/png', data_base64: Buffer.from('fakepng').toString('base64') },
          USER,
        );
        const pngContent = getAttachmentContent(ndb, png.id);
        assert.equal(pngContent.text, null);
        assert.equal(pngContent.html, null);

        // Long content is cut at the 200 000-character cap.
        writeFileSync(txt.file_path!, 'x'.repeat(200_001), 'utf8');
        const bigContent = getAttachmentContent(ndb, txt.id);
        assert.equal(bigContent.text?.length, 200_000);
        assert.equal(bigContent.truncated, true);
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('updateAttachmentContent rewrites the file and refreshes the row (L7)', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-att-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'att-content2', path.join(tmp, 'data.db'));
      try {
        const t = seedThought(ndb);
        const md = createAttachmentFile(
          ndb,
          'thought',
          t,
          {
            title: 'Черновик',
            mime_type: 'text/markdown',
            data_base64: Buffer.from('старый текст').toString('base64'),
          },
          USER,
        );

        const result = updateAttachmentContent(ndb, md.id, {
          data_base64: Buffer.from('# Новый\n\nтекст').toString('base64'),
        });
        assert.ok(result.html !== null && result.html.includes('<h1'));
        assert.equal(readFileSync(md.file_path!, 'utf8'), '# Новый\n\nтекст');
        const refreshed = getAttachment(ndb, md.id);
        assert.ok(refreshed !== null);
        assert.equal(refreshed.file_size, Buffer.byteLength('# Новый\n\nтекст', 'utf8'));

        // Non-text and url attachments cannot be rewritten.
        const png = createAttachmentFile(
          ndb,
          'thought',
          t,
          { mime_type: 'image/png', data_base64: Buffer.from('fakepng').toString('base64') },
          USER,
        );
        assert.throws(
          () =>
            updateAttachmentContent(ndb, png.id, {
              data_base64: Buffer.from('x').toString('base64'),
            }),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        const url = createAttachment(ndb, 'thought', t, { kind: 'url', url: 'https://x' }, USER);
        assert.throws(
          () =>
            updateAttachmentContent(ndb, url.id, {
              data_base64: Buffer.from('x').toString('base64'),
            }),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        // Bad base64 → 422.
        assert.throws(
          () => updateAttachmentContent(ndb, md.id, { data_base64: '!!not-base64!!' }),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    // --- L25: copy + search -------------------------------------------------

    it('copyAttachment creates one row per target, file not duplicated', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const source = seedThought(ndb, 'Source');
        const t1 = seedThought(ndb, 'Target 1');
        const t2 = seedThought(ndb, 'Target 2');
        const a = createAttachment(
          ndb,
          'thought',
          source,
          {
            kind: 'url',
            url: 'https://e.com/page',
            title: 'Page',
            description: 'desc',
            mime_type: 'text/html',
          },
          USER,
        );
        // Icon is normally filled by URL enrichment (enrichUrlAttachment);
        // PATCH it in to mimic that state — copyAttachment must preserve it.
        updateAttachment(ndb, a.id, { icon: 'data:image/png;base64,AAA' });
        const result = copyAttachment(
          ndb,
          a.id,
          { target_owner_type: 'thought', target_owner_ids: [t1, t2] },
          USER,
        );
        assert.equal(result.skipped.length, 0);
        assert.equal(result.created.length, 2);
        // New ids, same visible fields.
        const ids = new Set(result.created.map((c) => c.id));
        assert.equal(ids.size, 2);
        for (const created of result.created) {
          assert.notEqual(created.id, a.id);
          assert.equal(created.kind, 'url');
          assert.equal(created.url, 'https://e.com/page');
          assert.equal(created.title, 'Page');
          assert.equal(created.description, 'desc');
          assert.equal(created.mime_type, 'text/html');
          assert.equal(created.icon, 'data:image/png;base64,AAA');
          assert.equal(created.owner_type, 'thought');
          assert.ok([t1, t2].includes(created.owner_id));
        }
        // Each target now sees the attachment in its list.
        assert.equal(listAttachments(ndb, 'thought', t1).length, 1);
        assert.equal(listAttachments(ndb, 'thought', t2).length, 1);
      } finally {
        ndb.close();
      }
    });

    it('copyAttachment skips duplicate (same owner + same kind + same url) silently', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const source = seedThought(ndb);
        const target = seedThought(ndb);
        const a = createAttachment(
          ndb,
          'thought',
          source,
          { kind: 'url', url: 'https://e.com/dup' },
          USER,
        );
        // Pre-existing copy on the target.
        createAttachment(ndb, 'thought', target, { kind: 'url', url: 'https://e.com/dup' }, USER);
        const otherTarget = seedThought(ndb, 'Other');
        const result = copyAttachment(
          ndb,
          a.id,
          { target_owner_type: 'thought', target_owner_ids: [target, otherTarget] },
          USER,
        );
        assert.deepEqual(result.skipped, [target]);
        assert.equal(result.created.length, 1);
        assert.equal(result.created[0]!.owner_id, otherTarget);
      } finally {
        ndb.close();
      }
    });

    it('copyAttachment 404s on unknown source and 422s on unknown target', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const source = seedThought(ndb);
        const a = createAttachment(ndb, 'thought', source, { kind: 'url', url: 'https://e' }, USER);
        assert.throws(
          () =>
            copyAttachment(
              ndb,
              'does-not-exist',
              { target_owner_type: 'thought', target_owner_ids: [source] },
              USER,
            ),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );
        assert.throws(
          () =>
            copyAttachment(
              ndb,
              a.id,
              { target_owner_type: 'thought', target_owner_ids: ['no-such-thought'] },
              USER,
            ),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('copyAttachment preserves file_path on kind=file (no file copy)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const source = seedThought(ndb);
        const t = seedThought(ndb);
        const a = createAttachment(
          ndb,
          'thought',
          source,
          { kind: 'file', file_path: 'C:\\shared\\plan.md', mime_type: 'text/markdown' },
          USER,
        );
        const result = copyAttachment(
          ndb,
          a.id,
          { target_owner_type: 'thought', target_owner_ids: [t] },
          USER,
        );
        assert.equal(result.created.length, 1);
        assert.equal(result.created[0]!.file_path, 'C:\\shared\\plan.md');
        assert.equal(result.created[0]!.kind, 'file');
        assert.equal(result.created[0]!.mime_type, 'text/markdown');
      } finally {
        ndb.close();
      }
    });

    it('searchAttachments filters by keywords across title/description/url/file_path', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        createAttachment(
          ndb,
          'thought',
          t,
          { kind: 'url', url: 'https://e.com/roadmap', title: 'Roadmap Q4' },
          USER,
        );
        createAttachment(
          ndb,
          'thought',
          t,
          { kind: 'url', url: 'https://e.com/budget', title: 'Budget 2025', description: 'Annual plan' },
          USER,
        );
        createAttachment(
          ndb,
          'thought',
          t,
          { kind: 'file', file_path: 'C:\\docs\\notes.txt', title: 'Notes' },
          USER,
        );

        const byTitle = searchAttachments(ndb, { q: 'roadmap' });
        assert.equal(byTitle.total, 1);
        assert.equal(byTitle.items[0]!.title, 'Roadmap Q4');

        const byDescription = searchAttachments(ndb, { q: 'annual' });
        assert.equal(byDescription.total, 1);
        assert.equal(byDescription.items[0]!.title, 'Budget 2025');

        const byUrl = searchAttachments(ndb, { q: 'budget' });
        assert.equal(byUrl.total, 1);

        const byFilePath = searchAttachments(ndb, { q: 'notes' });
        assert.equal(byFilePath.total, 1);

        // Exclude: `-word` must not appear anywhere.
        const withExclude = searchAttachments(ndb, { q: 'plan -budget' });
        assert.equal(withExclude.total, 0);

        // Empty `q` returns nothing.
        const empty = searchAttachments(ndb, { q: '' });
        assert.equal(empty.total, 0);
        assert.equal(empty.items.length, 0);
      } finally {
        ndb.close();
      }
    });

    it('searchAttachments filters by kind and excludes attachments of one owner', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const owner = seedThought(ndb, 'Owner');
        const other = seedThought(ndb, 'Other');
        createAttachment(
          ndb,
          'thought',
          owner,
          { kind: 'url', url: 'https://e.com/x', title: 'Shared doc' },
          USER,
        );
        createAttachment(
          ndb,
          'thought',
          other,
          { kind: 'file', file_path: 'C:\\x.pdf', title: 'Shared doc' },
          USER,
        );

        const onlyUrl = searchAttachments(ndb, { q: 'shared', kind: 'url' });
        assert.equal(onlyUrl.total, 1);
        assert.equal(onlyUrl.items[0]!.kind, 'url');

        const excludeOwner = searchAttachments(ndb, {
          q: 'shared',
          exclude_owner_type: 'thought',
          exclude_owner_id: owner,
        });
        assert.equal(excludeOwner.total, 1);
        assert.equal(excludeOwner.items[0]!.owner_id, other);
      } finally {
        ndb.close();
      }
    });
  },
);
