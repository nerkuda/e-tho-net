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

/** Insert a directed link; `active`/`marked` select whether it is counted. */
function seedLink(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  active = 1,
  marked = 0,
  typeId: string | null = null,
): void {
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(randomUUID(), sourceId, targetId, typeId, active, marked);
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
      // 0.7.2 (задача 327be956) — профиль влияния мысли. Для свежей мысли
      // без связей: пустой `stats`. 0.8.3: имена типов связи — внутри каждой
      // записи `stats`, отдельного справочника `link_types` больше нет.
      link_stats: { stats: [] },
      // 0.7.3 (задача c1fa71d4) — эффективный набор отборов. У мысли без
      // типа (или без отборов у её типа) — пустой массив.
      views: [],
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

  it('does not count edges marked for deletion (ошибка 1a7e8fde)', () => {
    const ndb = createInMemoryNetworkDb();
    const t = seedThought(ndb);
    const p1 = seedThought(ndb);
    const p2 = seedThought(ndb);
    const c1 = seedThought(ndb);
    const c2 = seedThought(ndb);
    seedLink(ndb, p1, t); // живое входящее
    seedLink(ndb, p2, t, 1, 1); // в корзине — не считается
    seedLink(ndb, t, c1); // живое исходящее
    seedLink(ndb, t, c2, 1, 1); // в корзине — не считается

    const meta = getThoughtMeta(ndb, t);
    assert.equal(meta.parents_count, 1);
    assert.equal(meta.children_count, 1);
    // Согласованность с профилем влияния: его суммы по направлениям равны
    // счётчикам родителей/потомков.
    const inCount = meta.link_stats.stats
      .filter((s) => s.direction === 'in')
      .reduce((acc, s) => acc + s.count, 0);
    const outCount = meta.link_stats.stats
      .filter((s) => s.direction === 'out')
      .reduce((acc, s) => acc + s.count, 0);
    assert.equal(meta.parents_count, inCount);
    assert.equal(meta.children_count, outCount);
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

  it('usage_count блокирующего свойства-связи берёт направление из стороны привязки (083dcde5)', () => {
    const ndb = createInMemoryNetworkDb();
    const linkType = randomUUID();
    ndb
      .prepare(
        `INSERT INTO link_types (id, name_forward, name_reverse, version, created_at, updated_at, created_by)
         VALUES (?, 'ссылается на', 'упоминается в', 1, '2024', '2024', 'u')`,
      )
      .run(linkType);
    const prop = randomUUID();
    ndb
      .prepare(
        `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
         VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', 'упоминается в', 'упоминается в', 'link', ?, NULL, '2024', '2024')`,
      )
      .run(prop, JSON.stringify({ link_type_id: linkType, blocks_target_deletion: true }));
    const holderType = randomUUID();
    ndb
      .prepare(
        `INSERT INTO thought_types (id, name, version, created_at, updated_at, created_by)
         VALUES (?, 'ВладелецЦель', 1, '2024', '2024', 'u')`,
      )
      .run(holderType);
    // Привязка со стороны назначения: владелец — цель ребра.
    ndb
      .prepare(
        `INSERT INTO type_properties (id, owner_type, owner_id, property_id, required, position, side)
         VALUES (?, 'thought_type', ?, ?, 0, 0, 'target')`,
      )
      .run(randomUUID(), holderType, prop);
    const owner = seedThought(ndb);
    const value = seedThought(ndb);
    seedLink(ndb, value, owner, 1, 0, linkType);

    // Блокируется источник (значение), не владелец-цель.
    assert.equal(getThoughtMeta(ndb, value).usage_count, 1);
    assert.equal(getThoughtMeta(ndb, owner).usage_count, 0);

    // Свойство без привязок — прежний fallback на config.direction (`out`):
    // блокируется цель ребра.
    ndb.prepare('DELETE FROM type_properties WHERE property_id = ?').run(prop);
    assert.equal(getThoughtMeta(ndb, value).usage_count, 0);
    assert.equal(getThoughtMeta(ndb, owner).usage_count, 1);
  });
});
