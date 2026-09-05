/**
 * Unit tests for the enriched thought read (task N2): counters of active
 * links (parents/children), attachments, chronological comments, and the
 * permanent-comment preview with the 2000-char truncation.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { COMMENT_PREVIEW_CHARS } from '@etn/shared';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { getThoughtMeta } from '../src/domain/thought-meta.js';

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

/** Insert a thought row directly. */
function seedThought(ndb: NetworkDb): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, 't', 't', 1, 0, 0, 1, '2024-01-01T00:00:00.000Z', 'u',
               '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id);
  return id;
}

/** Insert a directed link; `active` selects whether it is counted. */
function seedLink(ndb: NetworkDb, sourceId: string, targetId: string, active = 1): void {
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(randomUUID(), sourceId, targetId, active);
}

/** Insert a comment of a given kind. */
function seedComment(
  ndb: NetworkDb,
  thoughtId: string,
  kind: 'permanent' | 'chronological',
  body: string,
): void {
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, body_md, body_html, valid_from,
                             version, created_at, updated_at, created_by, updated_by)
       VALUES (?, 'thought', ?, ?, ?, ?, '2024-01-01', 1, '2024-01-01', '2024-01-01', 'u', 'u')`,
    )
    .run(randomUUID(), thoughtId, kind, body, body);
}

/** Insert an attachment on a thought. */
function seedAttachment(ndb: NetworkDb, thoughtId: string, kind: 'url' | 'file'): void {
  ndb
    .prepare(
      `INSERT INTO attachments (id, owner_type, owner_id, kind, created_at, created_by)
       VALUES (?, 'thought', ?, ?, '2024', 'u')`,
    )
    .run(randomUUID(), thoughtId, kind);
}

describe('thought meta (N2)', { skip: !nativeAvailable() }, () => {
  it('returns zero counters and null permanent for a bare thought', () => {
    const ndb = createInMemoryNetworkDb();
    const id = seedThought(ndb);
    const meta = getThoughtMeta(ndb, id);
    assert.deepEqual(meta, {
      parents_count: 0,
      children_count: 0,
      attachments_count: 0,
      chrono_count: 0,
      usage_count: 0,
      permanent: null,
    });
  });

  it('counts only active links for parents and children', () => {
    const ndb = createInMemoryNetworkDb();
    const t = seedThought(ndb);
    const p1 = seedThought(ndb);
    const p2 = seedThought(ndb);
    const p3 = seedThought(ndb);
    const c1 = seedThought(ndb);
    const c2 = seedThought(ndb);
    const c3 = seedThought(ndb);
    seedLink(ndb, p1, t);
    seedLink(ndb, p2, t);
    seedLink(ndb, p3, t, 0); // inactive — not counted
    seedLink(ndb, t, c1);
    seedLink(ndb, t, c2);
    seedLink(ndb, t, c3, 0); // inactive — not counted
    // A self-loop counts once in each direction (incoming and outgoing).
    seedLink(ndb, t, t);

    const meta = getThoughtMeta(ndb, t);
    assert.equal(meta.parents_count, 3);
    assert.equal(meta.children_count, 3);
  });

  it('counts attachments and chronological comments separately from permanent', () => {
    const ndb = createInMemoryNetworkDb();
    const t = seedThought(ndb);
    seedAttachment(ndb, t, 'url');
    seedAttachment(ndb, t, 'file');
    seedComment(ndb, t, 'chronological', 'запись 1');
    seedComment(ndb, t, 'chronological', 'запись 2');
    seedComment(ndb, t, 'permanent', 'описание');

    const meta = getThoughtMeta(ndb, t);
    assert.equal(meta.attachments_count, 2);
    assert.equal(meta.chrono_count, 2);
    assert.equal(meta.permanent?.body_md, 'описание');
    assert.equal(meta.permanent?.chars_total, 8);
    assert.equal(meta.permanent?.chars_returned, 8);
    assert.equal(meta.permanent?.truncated, false);
    assert.equal(meta.permanent?.valid_from, '2024-01-01');
  });

  it('truncates a long permanent comment to the preview limit', () => {
    const ndb = createInMemoryNetworkDb();
    const t = seedThought(ndb);
    const longBody = 'абвгд '.repeat(2000); // 12000 chars
    seedComment(ndb, t, 'permanent', longBody);

    const meta = getThoughtMeta(ndb, t);
    assert.ok(meta.permanent !== null);
    assert.equal(meta.permanent.body_md.length, COMMENT_PREVIEW_CHARS);
    assert.equal(meta.permanent.chars_returned, COMMENT_PREVIEW_CHARS);
    assert.equal(meta.permanent.chars_total, longBody.length);
    assert.equal(meta.permanent.truncated, true);
    // The preview is a prefix of the full text.
    assert.equal(meta.permanent.body_md, longBody.slice(0, COMMENT_PREVIEW_CHARS));
  });

  it('reports no permanent when only chronological comments exist', () => {
    const ndb = createInMemoryNetworkDb();
    const t = seedThought(ndb);
    seedComment(ndb, t, 'chronological', 'только хроника');
    const meta = getThoughtMeta(ndb, t);
    assert.equal(meta.permanent, null);
    assert.equal(meta.chrono_count, 1);
  });

  it('counts thought_ref usages by other thoughts', () => {
    const ndb = createInMemoryNetworkDb();
    const type = randomUUID();
    ndb
      .prepare(
        `INSERT INTO thought_types (id, name, version, created_at, updated_at, created_by)
         VALUES (?, 'ref', 1, '2024', '2024', 'u')`,
      )
      .run(type);
    const prop = randomUUID();
    ndb
      .prepare(
        `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
         VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', 'project', 'project', 'thought_ref', NULL, NULL, '2024', '2024')`,
      )
      .run(prop);
    const target = seedThought(ndb);
    const owner1 = seedThought(ndb);
    const owner2 = seedThought(ndb);
    for (const owner of [owner1, owner2]) {
      ndb
        .prepare(
          `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_thought_ref, updated_at)
           VALUES (?, 'thought', ?, ?, ?, '2024')`,
        )
        .run(randomUUID(), owner, prop, target);
    }

    const meta = getThoughtMeta(ndb, target);
    assert.equal(meta.usage_count, 2);
    // The referencing thoughts themselves have no usages.
    assert.equal(getThoughtMeta(ndb, owner1).usage_count, 0);
  });
});
