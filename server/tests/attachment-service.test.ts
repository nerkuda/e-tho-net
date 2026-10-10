/**
 * Unit tests for the attachment domain service (task C8).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, EtnError } from '@etn/shared';

import { DEFAULT_MAX_LENGTH } from '@etn/markdown';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb, NetworkDb, registerMigrationHelpers } from '../src/db/network-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { networkMigrationsDir } from '../src/paths.js';
import {
  addOwners,
  copyAttachment,
  createAttachment,
  createAttachmentFile,
  createAttachmentFileResult,
  deleteAttachment,
  enrichUrlAttachment,
  extractFaviconUrl,
  extractHtmlTitle,
  getAttachment,
  getAttachmentContent,
  getAttachmentRawByPath,
  hasLiveOwnershipAnywhere,
  hasOwnership,
  listAttachments,
  removeOwner,
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
        const updated = updateAttachment(ndb, a.id, { url: 'https://y', title: 'T' }, USER);
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
          () => updateAttachment(ndb, a.id, { url: '  ' }, USER),
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
        updateAttachment(ndb, a.id, { owner_type: 'thought', owner_id: t2 }, USER);
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
        // Вторая строка, разрешающаяся в тот же файл (возможно через PATCH
        // file_path): делаем её отдельным вложением с другим относительным
        // адресом и переносим file_path на общий файл (дедуп по хэшу при
        // создании такой строки не даёт — содержимое то же, но создаём через
        // клиентский путь, который сервер не читает).
        const twin = createAttachment(
          ndb,
          'thought',
          t2,
          { kind: 'file', file_path: 'C:\\client\\other.bin', mime_type: 'image/png' },
          USER,
        );
        updateAttachment(ndb, twin.id, { file_path: stored.file_path }, USER);
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
        const moved = updateAttachment(ndb, a.id, { owner_type: 'thought', owner_id: t2 }, USER);
        assert.equal(moved.owner_id, t2);
        assert.equal(listAttachments(ndb, 'thought', t1).length, 0);
        assert.equal(listAttachments(ndb, 'thought', t2).length, 1);
        // Moving to a missing owner → NOT_FOUND, attachment stays put.
        assert.throws(
          () => updateAttachment(ndb, a.id, { owner_id: randomUUID() }, USER),
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
          () => updateAttachment(ndb, a.id, { icon: 'https://evil/x.png' }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        const withIcon = updateAttachment(ndb, a.id, { icon: 'data:image/png;base64,AAA' }, USER);
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

    it('updateAttachmentContent rejects markdown over the render limit without touching file or row (9f2e94b0)', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-att-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'att-content-over', path.join(tmp, 'data.db'));
      try {
        const t = seedThought(ndb);
        const md = createAttachmentFile(
          ndb,
          'thought',
          t,
          {
            title: 'Большой',
            mime_type: 'text/markdown',
            data_base64: Buffer.from('# старый').toString('base64'),
          },
          USER,
        );
        const before = getAttachment(ndb, md.id);
        assert.ok(before !== null);

        // Over-limit body: 422 VALIDATION_ERROR with the payload field, and
        // neither the file on disk nor the row may change (error 9f2e94b0).
        const over = 'a'.repeat(DEFAULT_MAX_LENGTH + 1);
        assert.throws(
          () =>
            updateAttachmentContent(ndb, md.id, {
              data_base64: Buffer.from(over).toString('base64'),
            }),
          (e: unknown) =>
            e instanceof EtnError &&
            e.code === 'VALIDATION_ERROR' &&
            (e.details as { field?: string }).field === 'data_base64' &&
            (e.details as { limit?: number }).limit === DEFAULT_MAX_LENGTH,
        );
        assert.equal(readFileSync(md.file_path!, 'utf8'), '# старый');
        const after = getAttachment(ndb, md.id);
        assert.ok(after !== null);
        assert.equal(after.file_size, before.file_size);
        assert.equal(after.updated_at_ms, before.updated_at_ms);

        // The boundary is inclusive: exactly DEFAULT_MAX_LENGTH is accepted.
        const exact = 'a'.repeat(DEFAULT_MAX_LENGTH);
        const result = updateAttachmentContent(ndb, md.id, {
          data_base64: Buffer.from(exact).toString('base64'),
        });
        assert.ok(result.html !== null);
        assert.equal(readFileSync(md.file_path!, 'utf8'), exact);
        const refreshed = getAttachment(ndb, md.id);
        assert.ok(refreshed !== null);
        assert.equal(refreshed.file_size, DEFAULT_MAX_LENGTH);
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('getAttachmentRawByPath serves stored files and rejects everything else', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-att-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'att-raw', path.join(tmp, 'data.db'));
      try {
        const t = seedThought(ndb);
        const stored = createAttachmentFile(
          ndb,
          'thought',
          t,
          {
            title: 'Фото',
            mime_type: 'image/jpeg',
            data_base64: Buffer.from('fakejpg').toString('base64'),
          },
          USER,
        );
        const raw = getAttachmentRawByPath(ndb, stored.file_path!);
        assert.equal(raw.body.toString(), 'fakejpg');
        assert.equal(raw.mime_type, 'image/jpeg');
        assert.equal(raw.filename, path.basename(stored.file_path!));

        // A client-local path (outside the network attachments dir) is never
        // served even when a row references it.
        const local = path.join(tmp, 'local.txt');
        writeFileSync(local, 'secret');
        createAttachment(ndb, 'thought', t, { kind: 'file', file_path: local }, USER);
        assert.throws(
          () => getAttachmentRawByPath(ndb, local),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );

        // Inside the stored dir but referenced by no attachment row.
        const orphan = path.join(path.dirname(stored.file_path!), 'no-such.bin');
        assert.throws(
          () => getAttachmentRawByPath(ndb, orphan),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );

        // The row exists but the backing file is gone.
        rmSync(stored.file_path!);
        assert.throws(
          () => getAttachmentRawByPath(ndb, stored.file_path!),
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
        updateAttachment(ndb, a.id, { icon: 'data:image/png;base64,AAA' }, USER);
        const result = copyAttachment(
          ndb,
          a.id,
          { target_owner_type: 'thought', target_owner_ids: [t1, t2] },
          USER,
        );
        assert.equal(result.skipped.length, 0);
        assert.equal(result.added.length, 2);
        assert.deepEqual(
          result.added.map((r) => r.owner_id).sort(),
          [t1, t2].sort(),
        );
        // С муль-владением копия = владение ТОЙ ЖЕ строкой: новых строк нет,
        // видимые поля сохранены, id общий.
        for (const ref of result.added) {
          const list = listAttachments(ndb, 'thought', ref.owner_id);
          assert.equal(list.length, 1);
          const shared = list[0]!;
          assert.equal(shared.id, a.id);
          assert.equal(shared.kind, 'url');
          assert.equal(shared.url, 'https://e.com/page');
          assert.equal(shared.title, 'Page');
          assert.equal(shared.description, 'desc');
          assert.equal(shared.mime_type, 'text/html');
          assert.equal(shared.icon, 'data:image/png;base64,AAA');
        }
      } finally {
        ndb.close();
      }
    });

    it('copyAttachment skips a target that already owns the attachment (idempotent)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const source = seedThought(ndb);
        const target = seedThought(ndb);
        const otherTarget = seedThought(ndb, 'Other');
        const a = createAttachment(
          ndb,
          'thought',
          source,
          { kind: 'url', url: 'https://e.com/dup' },
          USER,
        );
        // target уже владеет этим вложением.
        copyAttachment(ndb, a.id, { target_owner_type: 'thought', target_owner_ids: [target] }, USER);
        const result = copyAttachment(
          ndb,
          a.id,
          { target_owner_type: 'thought', target_owner_ids: [target, otherTarget] },
          USER,
        );
        assert.deepEqual(result.skipped.map((r) => r.owner_id), [target]);
        assert.deepEqual(result.added.map((r) => r.owner_id), [otherTarget]);
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

    it('copyAttachment shares one row on kind=file (no file copy)', () => {
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
        assert.equal(result.added.length, 1);
        const shared = listAttachments(ndb, 'thought', t)[0]!;
        assert.equal(shared.id, a.id);
        assert.equal(shared.file_path, 'C:\\shared\\plan.md');
        assert.equal(shared.kind, 'file');
        assert.equal(shared.mime_type, 'text/markdown');
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

    // --- ownership (0.12.1, ADR 9f90b010, задача 7678876a) -------------------

    it('listAttachments orders by ownership position', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const late = createAttachment(
          ndb,
          'thought',
          t,
          { kind: 'url', url: 'https://e/late', position: 5 },
          USER,
        );
        const early = createAttachment(
          ndb,
          'thought',
          t,
          { kind: 'url', url: 'https://e/early', position: 1 },
          USER,
        );
        const list = listAttachments(ndb, 'thought', t);
        assert.deepEqual(
          list.map((a) => a.id),
          [early.id, late.id],
        );
        assert.deepEqual(
          list.map((a) => a.position),
          [1, 5],
        );
      } finally {
        ndb.close();
      }
    });

    it('addOwners is idempotent (sticky ownership)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t1 = seedThought(ndb, 'A');
        const t2 = seedThought(ndb, 'B');
        const a = createAttachment(ndb, 'thought', t1, { kind: 'url', url: 'https://e/x' }, USER);
        const r1 = addOwners(ndb, a.id, 'thought', [t2, t2], USER);
        assert.deepEqual(
          r1.added.map((x) => x.owner_id),
          [t2],
        );
        const r2 = addOwners(ndb, a.id, 'thought', [t2], USER);
        assert.deepEqual(r2.added, []);
        assert.deepEqual(
          r2.skipped.map((x) => x.owner_id),
          [t2],
        );
        assert.equal(listAttachments(ndb, 'thought', t2).length, 1);
        assert.ok(hasOwnership(ndb, a.id, 'thought', t2));
      } finally {
        ndb.close();
      }
    });

    it('removeOwner forbids removing an ownership that backs the object icon', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const a = createAttachment(ndb, 'thought', t, { kind: 'url', url: 'https://e/icon' }, USER);
        ndb.prepare('UPDATE thoughts SET icon_attachment_id = ? WHERE id = ?').run(a.id, t);
        assert.throws(
          () => removeOwner(ndb, a.id, 'thought', t),
          (e: unknown) =>
            e instanceof EtnError &&
            (e.details as { code?: string }).code === 'ATTACHMENT_OWNER_IS_ICON',
        );
        assert.ok(hasOwnership(ndb, a.id, 'thought', t), 'владение не снято');
        // Нет живого владения — 404.
        const other = seedThought(ndb, 'Other');
        assert.throws(
          () => removeOwner(ndb, a.id, 'thought', other),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );
      } finally {
        ndb.close();
      }
    });

    it('removeOwner deletes the attachment and file with the last live owner', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-att-own-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'att-own', path.join(tmp, 'data.db'));
      try {
        const t1 = seedThought(ndb, 'A');
        const t2 = seedThought(ndb, 'B');
        const stored = createAttachmentFile(
          ndb,
          'thought',
          t1,
          {
            title: 'pic',
            mime_type: 'image/png',
            data_base64: Buffer.from('own-bytes').toString('base64'),
          },
          USER,
        );
        const fp = stored.file_path!;
        assert.ok(existsSync(fp));
        copyAttachment(ndb, stored.id, { target_owner_type: 'thought', target_owner_ids: [t2] }, USER);
        const r1 = removeOwner(ndb, stored.id, 'thought', t1);
        assert.deepEqual(r1, { removed: true, attachment_deleted: false });
        assert.notEqual(getAttachment(ndb, stored.id), null);
        assert.ok(existsSync(fp), 'файл удержан владением t2');
        const r2 = removeOwner(ndb, stored.id, 'thought', t2);
        assert.deepEqual(r2, { removed: true, attachment_deleted: true });
        assert.equal(getAttachment(ndb, stored.id), null);
        assert.equal(existsSync(fp), false);
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('uploading the same bytes reuses the attachment (dedup by content_hash)', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-att-dedup-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'att-dedup', path.join(tmp, 'data.db'));
      try {
        const t1 = seedThought(ndb, 'A');
        const t2 = seedThought(ndb, 'B');
        const b64 = Buffer.from('same-image-bytes').toString('base64');
        const first = createAttachmentFileResult(
          ndb,
          'thought',
          t1,
          { title: 'a', mime_type: 'image/png', data_base64: b64 },
          USER,
        );
        assert.equal(first.reused, false);
        const second = createAttachmentFileResult(
          ndb,
          'thought',
          t2,
          { title: 'b', mime_type: 'image/png', data_base64: b64 },
          USER,
        );
        assert.equal(second.reused, true);
        assert.equal(second.attachment.id, first.attachment.id);
        // Одна строка — два владельца.
        const l1 = listAttachments(ndb, 'thought', t1);
        const l2 = listAttachments(ndb, 'thought', t2);
        assert.equal(l1.length, 1);
        assert.equal(l2.length, 1);
        assert.equal(l1[0]!.id, l2[0]!.id);
        assert.ok(hasOwnership(ndb, first.attachment.id, 'thought', t2));
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('rename changes the shared title only; ownership stays', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const a = createAttachment(ndb, 'thought', t, { kind: 'url', url: 'https://e/doc' }, USER);
        const updated = updateAttachment(ndb, a.id, { title: 'Новое имя' }, USER);
        assert.equal(updated.title, 'Новое имя');
        assert.equal(updated.url, 'https://e/doc');
        assert.ok(hasOwnership(ndb, a.id, 'thought', t));
        assert.equal(listAttachments(ndb, 'thought', t)[0]!.title, 'Новое имя');
      } finally {
        ndb.close();
      }
    });

    // --- дедуп и судьба файла МЕЖДУ слоями (0.12.1, ADR e3a35864) ------------

    const LAYER_A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
    const LAYER_B = '22222222-2222-4222-8222-bbbbbbbbbbbb';
    const LAYER_SERVICE = '33333333-3333-4333-8333-cccccccccccc';

    /** Вставить строку слоя (is_service по умолчанию 0). */
    function seedLayerRow(
      ndb: NetworkDb,
      id: string,
      parentId: string,
      service = false,
    ): void {
      const now = new Date().toISOString();
      ndb
        .prepare(
          `INSERT INTO layers (id, parent_id, title, is_service, is_base, depth, created_by, created_at, last_activity_at)
           VALUES (?, ?, 'Слой', ?, 0, ?, 'u', ?, ?)`,
        )
        .run(id, parentId, service ? 1 : 0, parentId === BASE_LAYER_ID ? 1 : 2, now, now);
    }

    it('dedup reuses a row found in another layer (raw search across all layers)', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-att-xl-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'att-xl', path.join(tmp, 'data.db'));
      try {
        seedLayerRow(ndb, LAYER_A, BASE_LAYER_ID);
        seedLayerRow(ndb, LAYER_B, LAYER_A);
        const ownerA = seedThought(ndb, 'Владелец A');
        const ownerBase = seedThought(ndb, 'Владелец основы');
        const ownerB = seedThought(ndb, 'Владелец B');
        const b64 = Buffer.from('cross-layer-bytes').toString('base64');

        // 1) Строка рождается в слое A.
        ndb.useLayer(LAYER_A);
        const first = createAttachmentFileResult(
          ndb,
          'thought',
          ownerA,
          { title: 'x', mime_type: 'image/png', data_base64: b64 },
          USER,
        );
        assert.equal(first.reused, false);
        const filePath = first.attachment.file_path!;
        assert.ok(existsSync(filePath));

        // 2) Та же картинка в ОСНОВЕ — строка из слоя A не видна, но дедуп
        //    обязан найти её по СЫРОЙ таблице и переиспользовать.
        ndb.useLayer(BASE_LAYER_ID);
        const inBase = createAttachmentFileResult(
          ndb,
          'thought',
          ownerBase,
          { title: 'x', mime_type: 'image/png', data_base64: b64 },
          USER,
        );
        assert.equal(inBase.reused, true);
        assert.equal(inBase.attachment.id, first.attachment.id);
        assert.equal(inBase.attachment.file_path, filePath);

        // 3) Та же картинка в СЛОЕ B — тоже переиспользование.
        ndb.useLayer(LAYER_B);
        const inB = createAttachmentFileResult(
          ndb,
          'thought',
          ownerB,
          { title: 'x', mime_type: 'image/png', data_base64: b64 },
          USER,
        );
        assert.equal(inB.reused, true);
        assert.equal(inB.attachment.id, first.attachment.id);

        // Физически строка одна, файл один; владения — по слоям.
        const rawCount = ndb
          .prepare('SELECT COUNT(*) AS n FROM attachments WHERE content_hash IS NOT NULL')
          .get() as { n: number };
        assert.equal(rawCount.n, 1, 'физические байты не дублируются');
        const ownedIn = (ownerId: string, layerId: string): boolean =>
          ndb
            .prepare(
              'SELECT 1 FROM attachment_owners WHERE attachment_id = ? AND owner_id = ? AND layer_id = ?',
            )
            .get(first.attachment.id, ownerId, layerId) !== undefined;
        assert.ok(ownedIn(ownerA, LAYER_A));
        assert.ok(ownedIn(ownerBase, BASE_LAYER_ID));
        assert.ok(ownedIn(ownerB, LAYER_B), 'владение записано в ТЕКУЩЕМ слое');
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('removeOwner ignores SERVICE layers when deciding the file fate (1d0620a8)', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'etn-att-svc-'));
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new NetworkDb(db, 'att-svc', path.join(tmp, 'data.db'));
      try {
        seedLayerRow(ndb, LAYER_SERVICE, BASE_LAYER_ID, true);
        const owner = seedThought(ndb, 'Владелец');
        const other = seedThought(ndb, 'Другой');
        const up = createAttachmentFileResult(
          ndb,
          'thought',
          owner,
          { title: 'p', mime_type: 'image/png', data_base64: Buffer.from('svc-bytes').toString('base64') },
          USER,
        ).attachment;
        const fp = up.file_path!;
        // Копия строки владения в служебном (резервном) слое — как её кладёт
        // merge-резерв. Она НЕ должна удерживать файл.
        ndb
          .prepare(
            `INSERT INTO attachment_owners
               (id, layer_id, deleted, base_version, attachment_id, owner_type, owner_id, position, created_at, created_by)
             VALUES (?, ?, 0, 0, ?, 'thought', ?, 0, ?, 'u')`,
          )
          .run(randomUUID(), LAYER_SERVICE, up.id, other, new Date().toISOString());

        const r = removeOwner(ndb, up.id, 'thought', owner);
        assert.deepEqual(r, { removed: true, attachment_deleted: true });
        assert.equal(getAttachment(ndb, up.id), null);
        assert.equal(hasLiveOwnershipAnywhere(ndb, up.id), false);
        assert.equal(existsSync(fp), false, 'служебный слой не удерживает файл');
      } finally {
        ndb.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  },
);
