/**
 * Unit tests for the comment domain service and the markdown renderer
 * (task C7).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  createComment,
  deleteComment,
  listComments,
  updateComment,
} from '../src/domain/comment-service.js';
import { renderMarkdown } from '../src/domain/markdown.js';

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

/** Seed a link directly so the polymorphic owner exists. */
function seedLink(ndb: NetworkDb): string {
  const a = seedThought(ndb, 'A');
  const b = seedThought(ndb, 'B');
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, NULL, 1, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, a, b);
  return id;
}

describe('markdown renderer', () => {
  it('escapes raw HTML so injected tags are inert', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('renders headings, bold, italic, code and lists', () => {
    const html = renderMarkdown('# Title\n\n**bold** *italic* `code`\n\n- a\n- b');
    assert.ok(html.includes('<h1>Title</h1>'));
    assert.ok(html.includes('<strong>bold</strong>'));
    assert.ok(html.includes('<em>italic</em>'));
    assert.ok(html.includes('<code>code</code>'));
    assert.ok(html.includes('<ul><li>a</li><li>b</li></ul>'));
  });

  it('renders a fenced code block with a language class', () => {
    const html = renderMarkdown('```ts\nconst x = 1;\n```');
    assert.ok(html.includes('<pre><code class="language-ts">'));
    assert.ok(html.includes('const x = 1;'));
  });

  it('renders images and links with allow-listed URLs', () => {
    const html = renderMarkdown('![alt](https://e.com/i.png "t") [x](http://e.com)');
    assert.ok(html.includes('<img src="https://e.com/i.png" alt="alt" title="t" />'));
    assert.ok(html.includes('<a href="http://e.com">x</a>'));
  });

  it('rejects javascript: URLs, rendering them as plain text', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    assert.ok(!html.includes('href="javascript'));
    assert.ok(html.includes('click'));
  });

  it('allows file:// and etnimg:// URLs for images but not for links', () => {
    // Images pasted from the clipboard reference local attachment files —
    // file:// directly, or via the client's etnimg:// protocol (which also
    // loads from the dev http origin).
    const img = renderMarkdown('![alt](file:///C:/pics/img%201.png)');
    assert.ok(img.includes('<img src="file:///C:/pics/img%201.png" alt="alt"'));
    const etnimg = renderMarkdown('![alt](etnimg://c/pics/img%201.png)');
    assert.ok(etnimg.includes('<img src="etnimg://c/pics/img%201.png" alt="alt"'));
    // Such URLs stay plain text in link position (allow-list is strict there).
    const link = renderMarkdown('[x](file:///C:/secrets.txt) [y](etnimg://c/s.txt)');
    assert.ok(!link.includes('href="file'));
    assert.ok(!link.includes('href="etnimg'));
    assert.ok(link.includes('x'));
  });

  it('renders a GFM table', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
    assert.ok(html.includes('<table>'));
    assert.ok(html.includes('<th>a</th>'));
    assert.ok(html.includes('<td>1</td>'));
  });

  it('renders a blockquote', () => {
    const html = renderMarkdown('> wisdom');
    assert.ok(html.includes('<blockquote>'));
    assert.ok(html.includes('wisdom'));
  });
});

describe(
  'comment-service',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('creates a permanent comment and renders body_html', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const c = createComment(ndb, 'thought', t, { kind: 'permanent', body_md: '# Hi' }, USER);
        assert.equal(c.kind, 'permanent');
        assert.equal(c.title, null);
        assert.equal(c.valid_to, null, 'permanent valid_to is always null');
        assert.equal(c.valid_from, c.created_at, 'permanent valid_from = created_at');
        assert.equal(c.version, 1);
        assert.ok(c.body_html.includes('<h1>Hi</h1>'));
      } finally {
        ndb.close();
      }
    });

    it('rejects a second permanent comment for the same owner (409 DUPLICATE)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        createComment(ndb, 'thought', t, { kind: 'permanent', body_md: 'first' }, USER);
        assert.throws(
          () => createComment(ndb, 'thought', t, { kind: 'permanent', body_md: 'second' }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
        );
      } finally {
        ndb.close();
      }
    });

    it('allows many chronological comments and respects validity defaults', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const c1 = createComment(
          ndb,
          'thought',
          t,
          { kind: 'chronological', body_md: 'one', valid_from: '2024-01-01' },
          USER,
        );
        const c2 = createComment(
          ndb,
          'thought',
          t,
          { kind: 'chronological', body_md: 'two', valid_from: '2024-02-01', valid_to: '' },
          USER,
        );
        assert.equal(c1.valid_from, '2024-01-01');
        assert.equal(c2.valid_to, null, 'empty valid_to normalised to null');
        const list = listComments(ndb, 'thought', t);
        assert.equal(list.length, 2);
        assert.deepEqual(
          list.map((c) => c.body_md),
          ['one', 'two'],
          'chronological ordered by valid_from',
        );
      } finally {
        ndb.close();
      }
    });

    it('listComments puts the permanent comment first', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        createComment(
          ndb,
          'thought',
          t,
          { kind: 'chronological', body_md: 'chrono', valid_from: '2024-01-01' },
          USER,
        );
        createComment(ndb, 'thought', t, { kind: 'permanent', body_md: 'perm' }, USER);
        const list = listComments(ndb, 'thought', t);
        assert.equal(list[0]!.kind, 'permanent');
        assert.equal(list[1]!.kind, 'chronological');
      } finally {
        ndb.close();
      }
    });

    it('rejects creation for an unknown owner (404)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        assert.throws(
          () =>
            createComment(ndb, 'thought', randomUUID(), { kind: 'permanent', body_md: 'x' }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );
      } finally {
        ndb.close();
      }
    });

    it('creates and lists link-owned comments', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const linkId = seedLink(ndb);
        const c = createComment(
          ndb,
          'link',
          linkId,
          { kind: 'chronological', body_md: 'note' },
          USER,
        );
        assert.equal(c.owner_type, 'link');
        // FTS sync: the link text index should now contain the body.
        const hit = ndb
          .prepare("SELECT 1 FROM fts_link_texts WHERE fts_link_texts MATCH 'note' LIMIT 1")
          .get();
        assert.ok(hit, 'comment body indexed into fts_link_texts');
      } finally {
        ndb.close();
      }
    });

    it('updates body_md, re-renders html and bumps version', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const c = createComment(ndb, 'thought', t, { kind: 'permanent', body_md: 'old' }, USER);
        const updated = updateComment(ndb, c.id, { body_md: '**new**' }, c.version, USER);
        assert.equal(updated.version, c.version + 1);
        assert.ok(updated.body_html.includes('<strong>new</strong>'));
      } finally {
        ndb.close();
      }
    });

    it('returns VERSION_CONFLICT when expectedVersion does not match', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const c = createComment(ndb, 'thought', t, { kind: 'permanent', body_md: 'x' }, USER);
        assert.throws(
          () => updateComment(ndb, c.id, { body_md: 'y' }, c.version + 9, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VERSION_CONFLICT',
        );
      } finally {
        ndb.close();
      }
    });

    it('deletes a comment', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const c = createComment(ndb, 'thought', t, { kind: 'permanent', body_md: 'x' }, USER);
        deleteComment(ndb, c.id, c.version);
        assert.equal(listComments(ndb, 'thought', t).length, 0);
      } finally {
        ndb.close();
      }
    });
  },
);
