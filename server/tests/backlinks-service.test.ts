/**
 * Unit tests for the backlinks service (task R3, docs/03-server-api.md §13a).
 * DB tests are skipped when the `better-sqlite3` native binding cannot load
 * (AGENTS.md §10), but assertions stay in place for CI / real-DB runs.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { findBacklinks } from '../src/domain/backlinks-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function seedThought(ndb: NetworkDb, title: string, opts: { active?: number } = {}): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, ?, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase(), opts.active ?? 1);
  return id;
}

function seedThoughtComment(
  ndb: NetworkDb,
  thoughtId: string,
  body: string,
  kind: 'permanent' | 'chronological' = 'chronological',
  validFrom = '2024-01-01',
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, body_md, body_html, valid_from,
                             version, created_at, updated_at, created_by, updated_by)
       VALUES (?, 'thought', ?, ?, ?, ?, ?, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, thoughtId, kind, body, body, validFrom);
  return id;
}

function seedLink(ndb: NetworkDb, sourceId: string, targetId: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, NULL, 1, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, sourceId, targetId);
  return id;
}

function seedLinkComment(ndb: NetworkDb, linkId: string, body: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, body_md, body_html, valid_from,
                             version, created_at, updated_at, created_by, updated_by)
       VALUES (?, 'link', ?, 'chronological', ?, ?, '2024-01-01', 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, linkId, body, body);
  return id;
}

const skip = !nativeAvailable();

describe('findBacklinks (R3)', { skip }, () => {
  it('находит комментарий с [[#<id>]] в текущей сети', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const owner = seedThought(ndb, 'Заметка');
      seedThoughtComment(ndb, owner, `см. [[#${target}]]`);

      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.owner_type, 'thought');
      assert.equal(hits[0]!.owner_id, owner);
      assert.ok(hits[0]!.snippet.includes('<mark>'), 'snippet выделяет совпавший id');
    } finally {
      ndb.close();
    }
  });

  it('находит [[#<id>]] с алиасом', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const owner = seedThought(ndb, 'Заметка');
      seedThoughtComment(ndb, owner, `см. [[#${target}|мой алиас]]`);

      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 1);
    } finally {
      ndb.close();
    }
  });

  it('находит [[n:<net>#<id>]] — кросс-сеть (по target id)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const owner = seedThought(ndb, 'Заметка');
      // network id — любой UUID, валидность не проверяется для резолюции
      const netId = randomUUID();
      seedThoughtComment(ndb, owner, `см. [[n:${netId}#${target}|кросс]]`);

      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 1);
    } finally {
      ndb.close();
    }
  });

  it('legacy [[Имя|alias]] не считается backlinks', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const owner = seedThought(ndb, 'Заметка');
      // по имени, не по ID
      seedThoughtComment(ndb, owner, `см. [[Цель|алиас]]`);
      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 0);
    } finally {
      ndb.close();
    }
  });

  it('anti-self: комментарии самой мысли исключаются', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Самоцель');
      seedThoughtComment(ndb, target, `это [[#${target}]] ссылается на саму себя`);
      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 0);
    } finally {
      ndb.close();
    }
  });

  it('коллапс: несколько комментариев одного владельца → один хит', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const owner = seedThought(ndb, 'Заметка');
      seedThoughtComment(ndb, owner, `первая [[#${target}]] ссылка`);
      seedThoughtComment(ndb, owner, `вторая [[#${target}]] ссылка`);
      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 1, 'один хит на (owner_type, owner_id)');
      assert.equal(hits[0]!.owner_id, owner);
    } finally {
      ndb.close();
    }
  });

  it('невалидный UUID в [[#…]] не считается', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const owner = seedThought(ndb, 'Заметка');
      seedThoughtComment(ndb, owner, 'см. [[#not-a-uuid]]');
      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 0);
    } finally {
      ndb.close();
    }
  });

  it('несколько владельцев → несколько хитов', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const a = seedThought(ndb, 'A');
      const b = seedThought(ndb, 'B');
      seedThoughtComment(ndb, a, `[[#${target}]]`);
      seedThoughtComment(ndb, b, `[[#${target}|link]]`);
      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 2);
    } finally {
      ndb.close();
    }
  });

  it('несколько ID-ссылок в одном комментарии → один хит (коллапс)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const other = seedThought(ndb, 'Другая');
      const owner = seedThought(ndb, 'Заметка');
      seedThoughtComment(
        ndb,
        owner,
        `сначала [[#${target}]], потом [[#${other}]], опять [[#${target}]]`,
      );
      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 1);
      const hitsOther = findBacklinks(ndb, other);
      assert.equal(hitsOther.length, 1);
    } finally {
      ndb.close();
    }
  });

  it('находит ID-ссылку в комментарии связи', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const a = seedThought(ndb, 'A');
      const b = seedThought(ndb, 'B');
      const link = seedLink(ndb, a, b);
      seedLinkComment(ndb, link, `связь упоминает [[#${target}]]`);
      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.owner_type, 'link');
      assert.equal(hits[0]!.owner_id, link);
    } finally {
      ndb.close();
    }
  });

  it('case-insensitive: UUID в верхнем регистре тоже считается', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const owner = seedThought(ndb, 'Заметка');
      const upper = target.toUpperCase();
      seedThoughtComment(ndb, owner, `[[#${upper}]]`);
      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 1);
    } finally {
      ndb.close();
    }
  });

  it('snippet центрирован на совпавшем id (≈ ±40 символов + выделение)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const owner = seedThought(ndb, 'Заметка');
      const padding = 'абвгдежзийклмнопрстуфхцчшщъыьэюя'.repeat(5);
      seedThoughtComment(ndb, owner, `${padding} [[#${target}]] ${padding}`);
      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 1);
      assert.ok(hits[0]!.snippet.includes('<mark>'));
      assert.ok(hits[0]!.snippet.includes(target));
    } finally {
      ndb.close();
    }
  });

  it('NOT_FOUND если мысль не существует', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      assert.throws(
        () => findBacklinks(ndb, randomUUID()),
        (err: unknown) =>
          typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'NOT_FOUND',
      );
    } finally {
      ndb.close();
    }
  });

  it('активность владельца проставляется из thoughts/links', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const inactive = seedThought(ndb, 'Архив', { active: 0 });
      seedThoughtComment(ndb, inactive, `[[#${target}]]`);
      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.active, false);
    } finally {
      ndb.close();
    }
  });
});
