/**
 * Unit tests for the backlinks service (task R3, docs/03-server-api.md §13a).
 * DB tests are skipped when the `better-sqlite3` native binding cannot load
 * (AGENTS.md §10), but assertions stay in place for CI / real-DB runs.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import type { BacklinkHit, MentionHit, RecordHit } from '@etn/shared';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { findBacklinks, findPublicationBacklinks } from '../src/domain/backlinks-service.js';
import { createPublication } from '../src/domain/publication-service.js';

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

/**
 * Комментарий мысли. Дефолт — `permanent`: владельческая строка порождается
 * только постоянным комментарием, дневниковая запись даёт строку-запись
 * (0.15.4, задача 6af1be50); дневниковые кейсы задают `kind` явно.
 */
function seedThoughtComment(
  ndb: NetworkDb,
  thoughtId: string,
  body: string,
  kind: 'permanent' | 'chronological' = 'permanent',
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

function seedLinkComment(
  ndb: NetworkDb,
  linkId: string,
  body: string,
  kind: 'permanent' | 'chronological' = 'permanent',
  validFrom = '2024-01-01',
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, body_md, body_html, valid_from,
                             version, created_at, updated_at, created_by, updated_by)
       VALUES (?, 'link', ?, ?, ?, ?, ?, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, linkId, kind, body, body, validFrom);
  return id;
}

/** Привязать комментарий к цели (m2m `comment_targets`). */
function seedCommentTarget(
  ndb: NetworkDb,
  commentId: string,
  ownerType: 'thought' | 'link',
  ownerId: string,
): void {
  ndb
    .prepare(
      `INSERT INTO comment_targets (id, comment_id, owner_type, owner_id) VALUES (?, ?, ?, ?)`,
    )
    .run(randomUUID(), commentId, ownerType, ownerId);
}

/** Владельческие строки union `BacklinkHit` (сужение по дискриминатору). */
function mentionRows(hits: readonly BacklinkHit[]): MentionHit[] {
  return hits.filter((hit): hit is MentionHit => hit.kind === 'mention');
}

/** Строки-записи union `BacklinkHit`. */
function recordRows(hits: readonly BacklinkHit[]): RecordHit[] {
  return hits.filter((hit): hit is RecordHit => hit.kind === 'record');
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

  it('владелец: постоянный комментарий + записи — одна владельческая строка и подблок записей', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const owner = seedThought(ndb, 'Заметка');
      seedThoughtComment(ndb, owner, `постоянная [[#${target}]] ссылка`);
      const earlier = seedThoughtComment(
        ndb,
        owner,
        `запись от января [[#${target}]]`,
        'chronological',
        '2024-01-01',
      );
      const later = seedThoughtComment(
        ndb,
        owner,
        `запись от марта [[#${target}]]`,
        'chronological',
        '2024-03-01',
      );

      const hits = findBacklinks(ndb, target);
      assert.equal(mentionRows(hits).length, 1, 'один хит на (owner_type, owner_id)');
      assert.equal(mentionRows(hits)[0]!.owner_id, owner);
      assert.equal(hits[0]!.kind, 'mention', 'владельческие строки — до подблока записей');
      assert.deepEqual(
        recordRows(hits).map((hit) => hit.comment_id),
        [later, earlier],
        'записи не схлопываются и идут свежие сверху (valid_from desc)',
      );
      assert.ok(recordRows(hits)[0]!.snippet.includes('<mark>'), 'сниппет с подсветкой ссылки');
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
      const hits = mentionRows(findBacklinks(ndb, target));
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.active, false);
    } finally {
      ndb.close();
    }
  });

  it('kind-split: владелец, совпавший только записью, владельческой строки не даёт', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const onlyRecord = seedThought(ndb, 'Только дневник');
      seedThoughtComment(ndb, onlyRecord, `запись [[#${target}]]`, 'chronological');

      const hits = findBacklinks(ndb, target);
      assert.equal(mentionRows(hits).length, 0, 'владельческих строк нет');
      assert.equal(recordRows(hits).length, 1);
      assert.equal(recordRows(hits)[0]!.owner_id, onlyRecord);
    } finally {
      ndb.close();
    }
  });

  it('строка-запись несёт период, use_time и привязки (первичная первой)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const owner = seedThought(ndb, 'Дневник');
      const second = seedThought(ndb, 'Вторая мысль');
      const record = seedThoughtComment(
        ndb,
        owner,
        `запись [[#${target}]]`,
        'chronological',
        '2024-02-02',
      );
      seedCommentTarget(ndb, record, 'thought', owner);
      seedCommentTarget(ndb, record, 'thought', second);
      ndb.prepare('UPDATE comments SET use_time = 1 WHERE id = ?').run(record);

      const records = recordRows(findBacklinks(ndb, target));
      assert.equal(records.length, 1);
      assert.equal(records[0]!.valid_from, '2024-02-02');
      assert.equal(records[0]!.valid_to, null, 'valid_to записи — строка или null');
      assert.equal(records[0]!.use_time, true);
      assert.equal(records[0]!.owner_type, 'thought');
      assert.equal(records[0]!.owner_id, owner);
      assert.deepEqual(
        records[0]!.targets.map((item) => (item.kind === 'thought' ? item.thought.id : 'link')),
        [owner, second],
        'привязки записи, первичная первой',
      );
    } finally {
      ndb.close();
    }
  });

  it('строка-запись с владельцем-СВЯЗЬЮ (owner_type = link)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const a = seedThought(ndb, 'A');
      const b = seedThought(ndb, 'B');
      const link = seedLink(ndb, a, b);
      const record = seedLinkComment(ndb, link, `связь пишет [[#${target}]]`, 'chronological');
      seedCommentTarget(ndb, record, 'link', link);

      const records = recordRows(findBacklinks(ndb, target));
      assert.equal(records.length, 1);
      assert.equal(records[0]!.owner_type, 'link');
      assert.equal(records[0]!.owner_id, link);
      assert.equal(records[0]!.targets.length, 1);
      const target0 = records[0]!.targets[0]!;
      assert.equal(target0.kind, 'link');
      if (target0.kind === 'link') {
        assert.equal(target0.link.source.id, a);
        assert.equal(target0.link.target.id, b);
      }
    } finally {
      ndb.close();
    }
  });

  it('анти-self распространяется на строки-записи', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Самоцель');
      seedThoughtComment(ndb, target, `запись [[#${target}]]`, 'chronological');
      const hits = findBacklinks(ndb, target);
      assert.equal(hits.length, 0, 'собственная запись цели строкой не приходит');
    } finally {
      ndb.close();
    }
  });

  it('публикационная ссылка [[#pub:…]] не считается backlinks мысли', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель');
      const owner = seedThought(ndb, 'Заметка');
      const pub = createPublication(ndb, { title: 'Публикация' }, 'u');
      // `pub:`-ссылка адресует публикацию, а не мысль с тем же uuid-видом.
      seedThoughtComment(ndb, owner, `см. [[#pub:${pub.id}]]`);
      assert.equal(findBacklinks(ndb, target).length, 0);
    } finally {
      ndb.close();
    }
  });
});

describe('findPublicationBacklinks (f37b468d)', { skip }, () => {
  it('находит [[#pub:…]] в комментарии мысли и отдаёт владельца', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const pub = createPublication(ndb, { title: 'Публикация' }, 'u');
      const owner = seedThought(ndb, 'Заметка');
      seedThoughtComment(ndb, owner, `см. [[#pub:${pub.id}|название]]`);

      const hits = findPublicationBacklinks(ndb, pub.id);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.owner_type, 'thought');
      assert.equal(hits[0]!.owner_id, owner);
      assert.ok(hits[0]!.snippet.includes('<mark>'), 'snippet выделяет совпавший id');
    } finally {
      ndb.close();
    }
  });

  it('находит [[#pub:…]] в комментарии связи', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const pub = createPublication(ndb, { title: 'Публикация' }, 'u');
      const a = seedThought(ndb, 'A');
      const b = seedThought(ndb, 'B');
      const link = seedLink(ndb, a, b);
      seedLinkComment(ndb, link, `связь упоминает [[#pub:${pub.id}]]`);

      const hits = findPublicationBacklinks(ndb, pub.id);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.owner_type, 'link');
      assert.equal(hits[0]!.owner_id, link);
    } finally {
      ndb.close();
    }
  });

  it('публикации: дневниковая запись по-прежнему схлопывается во владельческую строку', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const pub = createPublication(ndb, { title: 'Публикация' }, 'u');
      const owner = seedThought(ndb, 'Заметка');
      seedThoughtComment(ndb, owner, `запись [[#pub:${pub.id}]]`, 'chronological');
      seedThoughtComment(ndb, owner, `вторая запись [[#pub:${pub.id}]]`, 'chronological');

      const hits = findPublicationBacklinks(ndb, pub.id);
      assert.equal(hits.length, 1, 'контракт публикаций прежний: один хит на владельца');
      assert.equal(hits[0]!.owner_type, 'thought');
      assert.equal(hits[0]!.owner_id, owner);
    } finally {
      ndb.close();
    }
  });

  it('голая [[#<uuid>]] мыслью не считается ссылкой на публикацию', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const pub = createPublication(ndb, { title: 'Публикация' }, 'u');
      const owner = seedThought(ndb, 'Заметка');
      seedThoughtComment(ndb, owner, `см. [[#${pub.id}]]`);
      assert.equal(findPublicationBacklinks(ndb, pub.id).length, 0);
    } finally {
      ndb.close();
    }
  });

  it('NOT_FOUND если публикации не существует', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      assert.throws(
        () => findPublicationBacklinks(ndb, randomUUID()),
        (err: unknown) =>
          typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'NOT_FOUND',
      );
    } finally {
      ndb.close();
    }
  });
});
