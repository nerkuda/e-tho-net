/**
 * Unit tests for the chronicle domain service (L20, docs/03-server-api.md §20):
 * the two-phase thought → chronological-comments query.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createComment, createCommentWithTargets } from '../src/domain/comment-service.js';
import {
  parseChronicleFilterDefinition,
  parseChronicleQueryBody,
  queryChronicle,
} from '../src/domain/chronicle-service.js';

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

/** Seed a thought (optionally with a type) and return its id. */
function seedThought(
  ndb: NetworkDb,
  title: string,
  opts: { typeId?: string; home?: boolean } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             type_id, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, ?, ?, ?, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(
      id,
      title,
      title.toLowerCase(),
      opts.home === true ? 1 : 0,
      opts.home === true ? 1 : 0,
      opts.typeId ?? null,
    );
  return id;
}

/** Seed a typed link source → target. */
function seedLink(ndb: NetworkDb, source: string, target: string, typeId: string | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, source, target, typeId);
  return id;
}

/** Insert a property definition into the registry; return its id. */
function seedPropertyDefinition(ndb: NetworkDb, key: string, valueType: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', ?, lower(?), ?, NULL, NULL, '2024', '2024')`,
    )
    .run(id, key, key, valueType);
  return id;
}

/** Insert a text property value on a thought. */
function seedPropertyValue(
  ndb: NetworkDb,
  thoughtId: string,
  propertyId: string,
  value: string,
): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_text, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

/** Query wrapper with default paging. */
function query(
  ndb: NetworkDb,
  filter: Record<string, unknown>,
  extra: { order?: 'asc' | 'desc'; limit?: number; offset?: number } = {},
) {
  const request = parseChronicleQueryBody(
    { ...filter, order: extra.order ?? 'asc', limit: extra.limit ?? 50, offset: extra.offset ?? 0 },
    'test-request',
  );
  return queryChronicle(ndb, request);
}

describe(
  'chronicle-service',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('empty filter lists chronological comments of all thoughts', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        const b = seedThought(ndb, 'B');
        seedThought(ndb, 'HOME', { home: true });
        createComment(ndb, 'thought', a, { kind: 'chronological', body_md: 'one', valid_from: '2024-01-01' }, USER);
        createComment(ndb, 'thought', b, { kind: 'chronological', body_md: 'two', valid_from: '2024-02-01' }, USER);
        createComment(ndb, 'thought', a, { kind: 'permanent', body_md: 'perm' }, USER);
        const result = query(ndb, {});
        assert.equal(result.total, 2, 'only chronological comments');
        // 0.10.1: «голая дата» на записи нормализуется в полный UTC-инстанс.
        assert.deepEqual(result.rows.map((r) => r.valid_from), [
          '2024-01-01T00:00:00.000Z',
          '2024-02-01T00:00:00.000Z',
        ]);
      } finally {
        ndb.close();
      }
    });

    it('filters by roots + subtree (deduped) and by thought types', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const root = seedThought(ndb, 'Root');
        const child = seedThought(ndb, 'Child');
        const grandchild = seedThought(ndb, 'Grand');
        const other = seedThought(ndb, 'Other');
        seedLink(ndb, root, child);
        seedLink(ndb, child, grandchild);
        seedLink(ndb, grandchild, root); // cycle — must not hang and stays deduped
        createComment(ndb, 'thought', child, { kind: 'chronological', body_md: 'c', valid_from: '2024-01-01' }, USER);
        createComment(ndb, 'thought', grandchild, { kind: 'chronological', body_md: 'g', valid_from: '2024-01-02' }, USER);
        createComment(ndb, 'thought', other, { kind: 'chronological', body_md: 'o', valid_from: '2024-01-03' }, USER);

        const result = query(ndb, { thought_ids: [root], include_subtree: true });
        assert.equal(result.total, 2, 'child + grandchild, but not other');
      } finally {
        ndb.close();
      }
    });

    it('matches keywords in a link comment from both sides of the link', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const src = seedThought(ndb, 'Источник');
        const dst = seedThought(ndb, 'Назначение');
        const other = seedThought(ndb, 'Сторонняя');
        const link = seedLink(ndb, src, dst);
        createComment(ndb, 'link', link, { kind: 'chronological', body_md: 'событие альфа', valid_from: '2024-01-01' }, USER);
        createComment(ndb, 'thought', other, { kind: 'chronological', body_md: 'мимо', valid_from: '2024-01-02' }, USER);

        // The word only lives in the link's comment: the comment is selected and
        // the row carries the link with BOTH endpoint thoughts resolved.
        const result = query(ndb, { keywords: 'альфа' });
        assert.equal(result.rows.length, 1);
        const linkTargets = result.rows[0]!.targets.filter((t) => t.kind === 'link');
        assert.equal(linkTargets.length, 1);
        const linkTarget = linkTargets[0]!;
        assert.ok(linkTarget.kind === 'link');
        assert.equal(linkTarget.link.source.title, 'Источник');
        assert.equal(linkTarget.link.target.title, 'Назначение');
        // The unrelated thought's comment did not make it into the table.
        assert.ok(!result.rows.some((r) => r.targets.some((t) => t.kind === 'thought' && t.thought.id === other)));
      } finally {
        ndb.close();
      }
    });

    it('matches Cyrillic keywords case-insensitively in names and comment texts', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'Смоук B');
        const b = seedThought(ndb, 'Иная');
        createComment(
          ndb,
          'thought',
          a,
          { kind: 'chronological', body_md: 'хроно B: создана', valid_from: '2024-01-01' },
          USER,
        );
        createComment(
          ndb,
          'thought',
          b,
          { kind: 'chronological', body_md: 'ХРОНО прочее', valid_from: '2024-01-02' },
          USER,
        );
        ndb
          .prepare('INSERT INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)')
          .run(b, 'Псевдоним', 'псевдоним');

        // Название: кириллица в другом регистре должна матчиться (ошибка 2f27f244).
        assert.equal(query(ndb, { keywords: 'Смоук' }).total, 1, 'title, capitalised');
        assert.equal(query(ndb, { keywords: 'СМОУК' }).total, 1, 'title, all caps');
        // Синоним — тоже нормализованно.
        assert.equal(query(ndb, { keywords: 'ПСЕВДОНИМ' }).total, 1, 'synonym, all caps');
        // Текст комментария — через unicode_lower, оба регистра.
        assert.equal(query(ndb, { keywords: 'хроно' }).total, 2, 'comment body, lower case');
        assert.equal(query(ndb, { keywords: 'ХРОНО' }).total, 2, 'comment body, upper case');
      } finally {
        ndb.close();
      }
    });

    it('filters records by their own body/title, not only by their target thought (T7)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const home = seedThought(ndb, 'HOME', { home: true });
        const a = seedThought(ndb, 'A');
        const hit = createComment(
          ndb,
          'thought',
          home,
          { kind: 'chronological', body_md: 'привет мир', valid_from: '2024-01-01' },
          USER,
        );
        createComment(
          ndb,
          'thought',
          home,
          { kind: 'chronological', body_md: 'пока мир', valid_from: '2024-01-02' },
          USER,
        );
        createComment(
          ndb,
          'thought',
          a,
          { kind: 'chronological', title: 'Отпуск', body_md: 'без слов', valid_from: '2024-01-03' },
          USER,
        );

        // Слово в теле записи дня (единственная цель — HOME) сужает ленту:
        // раньше выбирался HOME и возвращались ВСЕ его записи.
        const byHit = query(ndb, { keywords: 'привет' });
        assert.equal(byHit.total, 1, 'совпадение в теле записи дня');
        assert.equal(byHit.rows[0]!.id, hit.id);

        // Заголовок записи тоже ищется.
        assert.equal(query(ndb, { keywords: 'отпуск' }).total, 1, 'совпадение в заголовке записи');

        // Исключающее слово вычитает запись по её собственному тексту.
        assert.equal(query(ndb, { keywords: '-пока' }).total, 2, 'исключение по телу записи');
        assert.equal(query(ndb, { keywords: 'мир -пока' }).total, 1, 'include + exclude по телу записи');

        // Структурный отбор (thought_ids/type_ids) сужает и путь «по тексту записи».
        assert.equal(
          query(ndb, { thought_ids: [home], keywords: 'отпуск' }).total,
          0,
          'запись вне области отбора не просачивается',
        );
      } finally {
        ndb.close();
      }
    });

    it('excludes thoughts via minus-words and intersects the period', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'Счетчик электричества');
        const b = seedThought(ndb, 'Счета за воду');
        createComment(ndb, 'thought', a, { kind: 'chronological', body_md: 'x', valid_from: '2024-01-01' }, USER);
        createComment(ndb, 'thought', b, { kind: 'chronological', body_md: 'y', valid_from: '2024-01-01' }, USER);
        const result = query(ndb, { keywords: 'счет* -вод*' });
        assert.equal(result.total, 1);
        assert.equal(result.rows[0]!.targets[0]!.kind, 'thought');
      } finally {
        ndb.close();
      }
    });

    it('intersects the date period: grey-zone records still returned', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        createComment(
          ndb,
          'thought',
          a,
          { kind: 'chronological', body_md: 'inside', valid_from: '2024-02-10', valid_to: '2024-02-20' },
          USER,
        );
        createComment(
          ndb,
          'thought',
          a,
          { kind: 'chronological', body_md: 'starts-before', valid_from: '2024-01-15', valid_to: '2024-02-15' },
          USER,
        );
        createComment(
          ndb,
          'thought',
          a,
          { kind: 'chronological', body_md: 'ends-after', valid_from: '2024-02-15', valid_to: '2024-03-10' },
          USER,
        );
        createComment(
          ndb,
          'thought',
          a,
          { kind: 'chronological', body_md: 'open', valid_from: '2024-02-01', valid_to: null },
          USER,
        );
        createComment(
          ndb,
          'thought',
          a,
          { kind: 'chronological', body_md: 'outside', valid_from: '2024-01-01', valid_to: '2024-01-31' },
          USER,
        );
        const result = query(ndb, { date_from: '2024-02-01', date_to: '2024-02-28' });
        assert.equal(result.total, 4, 'overlapping and open-ended records included');
      } finally {
        ndb.close();
      }
    });

    it('applies the link scope (sources / targets / both)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const src = seedThought(ndb, 'Src');
        const dst = seedThought(ndb, 'Dst');
        const link = seedLink(ndb, src, dst);
        createComment(ndb, 'link', link, { kind: 'chronological', body_md: 'note', valid_from: '2024-01-01' }, USER);

        const both = query(ndb, { link_scope: 'both' });
        assert.equal(both.total, 1);

        const sources = query(ndb, { thought_ids: [dst], link_scope: 'sources' });
        assert.equal(sources.total, 0, 'dst is not the source of the link');

        const targets = query(ndb, { thought_ids: [dst], link_scope: 'targets' });
        assert.equal(targets.total, 1, 'dst is the target of the link');

        const sourcesSrc = query(ndb, { thought_ids: [src], link_scope: 'sources' });
        assert.equal(sourcesSrc.total, 1);
      } finally {
        ndb.close();
      }
    });

    it('paginates and sorts by valid_from/valid_to/title with total', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        for (let i = 1; i <= 5; i++) {
          createComment(
            ndb,
            'thought',
            a,
            { kind: 'chronological', body_md: `e${i}`, valid_from: `2024-01-0${i}` },
            USER,
          );
        }
        const page = query(ndb, {}, { limit: 2, offset: 1 });
        assert.equal(page.total, 5);
        assert.equal(page.rows.length, 2);
        assert.equal(page.rows[0]!.valid_from, '2024-01-02T00:00:00.000Z');

        const desc = query(ndb, {}, { order: 'desc', limit: 50 });
        assert.equal(desc.rows[0]!.valid_from, '2024-01-05T00:00:00.000Z');
      } finally {
        ndb.close();
      }
    });

    it('resolves thought and link targets with display metadata', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const src = seedThought(ndb, 'Src');
        const dst = seedThought(ndb, 'Dst');
        const link = seedLink(ndb, src, dst);
        const c = createCommentWithTargets(
          ndb,
          [
            { owner_type: 'thought', owner_id: src },
            { owner_type: 'link', owner_id: link },
          ],
          { kind: 'chronological', body_md: 'both', valid_from: '2024-01-01' },
          USER,
        );
        const result = query(ndb, {});
        assert.equal(result.total, 1);
        const row = result.rows.find((r) => r.id === c.id);
        assert.ok(row, 'comment row present');
        const kinds = (row!.targets as Array<{ kind: string }>).map((t) => t.kind).sort();
        assert.deepEqual(kinds, ['link', 'thought']);
        const linkTarget = row!.targets.find((t) => t.kind === 'link');
        assert.ok(linkTarget && linkTarget.kind === 'link');
        assert.equal(linkTarget.link.source.title, 'Src');
        assert.equal(linkTarget.link.target.title, 'Dst');
        // Snippet contains the highlighted body.
        assert.ok(row!.snippet.includes('both'));
      } finally {
        ndb.close();
      }
    });

    it('sorts by record class (HOME-only first), then valid_from/valid_to, in both orders', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const home = seedThought(ndb, 'HOME', { home: true });
        const a = seedThought(ndb, 'A');
        // Класс 0 — привязка только к HOME.
        const h2 = createComment(ndb, 'thought', home, { kind: 'chronological', body_md: 'h2', valid_from: '2024-01-01' }, USER);
        const h1 = createComment(ndb, 'thought', home, { kind: 'chronological', body_md: 'h1', valid_from: '2024-01-02' }, USER);
        // Класс 1 — чужая мысль или смешанные привязки.
        const p1 = createComment(ndb, 'thought', a, { kind: 'chronological', body_md: 'p1', valid_from: '2024-01-03' }, USER);
        const p2 = createCommentWithTargets(
          ndb,
          [{ owner_type: 'thought', owner_id: home }, { owner_type: 'thought', owner_id: a }],
          { kind: 'chronological', body_md: 'p2', valid_from: '2024-01-04' },
          USER,
        );

        const asc = query(ndb, {});
        assert.deepEqual(
          asc.rows.map((r) => r.id),
          [h2.id, h1.id, p1.id, p2.id],
          'класс 0 блоком вверху, внутри — по valid_from',
        );
        const desc = query(ndb, {}, { order: 'desc' });
        assert.deepEqual(
          desc.rows.map((r) => r.id),
          [p2.id, p1.id, h1.id, h2.id],
          'обратный порядок переворачивает все ключи, включая класс',
        );
        // Снятие последнего чипса (HOME остаётся единственной целью) поднимает
        // запись в класс 0 — «p2» становится классом 0 при возврате к HOME.
        const homeOnly = createComment(ndb, 'thought', home, { kind: 'chronological', body_md: 'p2', valid_from: '2024-01-04' }, USER);
        const after = query(ndb, {});
        assert.equal(after.rows[0]!.id, h2.id);
        assert.ok(
          after.rows.findIndex((r) => r.id === homeOnly.id) <
            after.rows.findIndex((r) => r.id === p2.id),
          'запись с единственной целью HOME идёт в блоке класса 0',
        );
      } finally {
        ndb.close();
      }
    });

    it('target criteria: at least one attached thought (incl. secondary) must match', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const home = seedThought(ndb, 'HOME', { home: true });
        const alpha = seedThought(ndb, 'Alpha');
        const beta = seedThought(ndb, 'Beta');
        const cAlpha = createComment(ndb, 'thought', alpha, { kind: 'chronological', body_md: 'к альфе', valid_from: '2024-01-01' }, USER);
        const cBeta = createComment(ndb, 'thought', beta, { kind: 'chronological', body_md: 'к бетe', valid_from: '2024-01-02' }, USER);
        // Вторичная привязка: первичный владелец — HOME, чипс — Alpha.
        const cBoth = createCommentWithTargets(
          ndb,
          [{ owner_type: 'thought', owner_id: home }, { owner_type: 'thought', owner_id: alpha }],
          { kind: 'chronological', body_md: 'день+альфа', valid_from: '2024-01-03' },
          USER,
        );

        const byKeyword = query(ndb, { targets: { keywords: 'Alpha' } });
        assert.deepEqual(
          byKeyword.rows.map((r) => r.id).sort(),
          [cAlpha.id, cBoth.id].sort(),
          'запись проходит, если привязанная мысль (в т.ч. вторичная) подходит',
        );
        assert.ok(!byKeyword.rows.some((r) => r.id === cBeta.id));

        // Критерий по значению свойства цели («набор Структур»).
        const prop = seedPropertyDefinition(ndb, 'Тема', 'text');
        seedPropertyValue(ndb, alpha, prop, 'дедлайн');
        const byProperty = query(ndb, {
          targets: { properties: [{ property_id: prop, op: 'contains', value: 'дедлайн' }] },
        });
        assert.deepEqual(byProperty.rows.map((r) => r.id).sort(), [cAlpha.id, cBoth.id].sort());

        // Группы критериев — по AND: запись подходит по цели, но не проходит
        // критерий записи (даты).
        const both = query(ndb, {
          targets: { keywords: 'Alpha' },
          date_from: '2024-01-04',
          date_to: '2024-01-05',
        });
        assert.equal(both.total, 0, 'критерии цели и записи комбинируются по AND');

        // Пустой набор критериев целей не сужает выборку.
        assert.equal(query(ndb, { targets: {} }).total, 3);
      } finally {
        ndb.close();
      }
    });

    it('period tokens ($today/$now, arithmetic) expand at query time', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb, 'T');
        createComment(ndb, 'thought', t, { kind: 'chronological', body_md: '15-е', valid_from: '2024-06-15T12:00:00.000Z' }, USER);
        createComment(ndb, 'thought', t, { kind: 'chronological', body_md: '16-е', valid_from: '2024-06-16T12:00:00.000Z' }, USER);
        const now = (): Date => new Date('2024-06-15T10:00:00.000Z');

        const today = queryChronicle(
          ndb,
          parseChronicleQueryBody({ date_from: '$today', date_to: '$today' }, ''),
          { now },
        );
        assert.equal(today.total, 1, '$today = сутки UTC текущего дня');
        assert.equal(today.rows[0]!.valid_from, '2024-06-15T12:00:00.000Z');

        const tomorrow = queryChronicle(
          ndb,
          parseChronicleQueryBody({ date_from: '$today+1d', date_to: '$today+1d' }, ''),
          { now },
        );
        assert.equal(tomorrow.total, 1);
        assert.equal(tomorrow.rows[0]!.valid_from, '2024-06-16T12:00:00.000Z');

        // $now берёт момент времени (полный ISO-инстанс).
        const fromNow = queryChronicle(
          ndb,
          parseChronicleQueryBody({ date_from: '$now+1d' }, ''),
          { now },
        );
        assert.equal(fromNow.total, 1, 'записи после $now+1d: только 16-е');

        // Токен требует контекста мысли в периоде недопустим.
        assert.throws(
          () => parseChronicleQueryBody({ date_from: '$thought.[Плановый срок]' }, 'r'),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        assert.throws(
          () => parseChronicleQueryBody({ date_from: '$bogus' }, 'r'),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );

        // Сохранённый отбор хранит токен без изменений.
        const saved = parseChronicleFilterDefinition({ date_from: '$today', order: 'asc' }, 'r');
        assert.equal(saved.date_from, '$today');
      } finally {
        ndb.close();
      }
    });

    it('period intersection boundaries are inclusive', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb, 'T');
        createComment(ndb, 'thought', t, { kind: 'chronological', body_md: 'a', valid_from: '2024-01-10', valid_to: '2024-01-10' }, USER);
        // valid_from ровно на нижней границе периода.
        createComment(ndb, 'thought', t, { kind: 'chronological', body_md: 'b', valid_from: '2024-01-10', valid_to: '2024-01-20' }, USER);
        // valid_to ровно на верхней границе периода (конец суток включается).
        createComment(ndb, 'thought', t, { kind: 'chronological', body_md: 'c', valid_from: '2024-01-01', valid_to: '2024-01-10' }, USER);
        const result = query(ndb, { date_from: '2024-01-10', date_to: '2024-01-10' });
        assert.equal(result.total, 3, 'границы периода включительные для всех трёх');
      } finally {
        ndb.close();
      }
    });

    it('returns use_time flag of each record', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb, 'T');
        createComment(ndb, 'thought', t, { kind: 'chronological', body_md: 'без времени', valid_from: '2024-01-01' }, USER);
        createComment(ndb, 'thought', t, { kind: 'chronological', body_md: 'со временем', valid_from: '2024-01-02T09:30:00.000Z', use_time: true }, USER);
        const result = query(ndb, {});
        assert.deepEqual(
          result.rows.map((r) => r.use_time).sort(),
          [false, true],
          'флаг «учитывать время» присутствует в строках ответа',
        );
        const withTime = result.rows.find((r) => r.use_time === true)!;
        assert.equal(withTime.valid_from, '2024-01-02T09:30:00.000Z');
      } finally {
        ndb.close();
      }
    });

    it('rejects invalid input (bad link_scope, bad order, bad targets)', () => {
      assert.throws(
        () => parseChronicleQueryBody({ link_scope: 'sideways' }, 'r'),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
      // order is lenient: an invalid value falls back to 'asc' instead.
      const parsed = parseChronicleQueryBody({ order: 'sideways' }, 'r');
      assert.equal(parsed.order, 'asc');
      // targets обязан быть объектом критериев.
      assert.throws(
        () => parseChronicleQueryBody({ targets: [] }, 'r'),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
      // keyword_scope — закрытый словарь областей.
      assert.throws(
        () => parseChronicleQueryBody({ keywords: 'x', keyword_scope: ['body'] }, 'r'),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
    });

    it('keyword_scope сужает МЫСЛЕВОЙ путь ключевых слов (0.10.1, 91f8d8dd)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'HOME', { home: true });
        const target = seedThought(ndb, 'Alpha');
        // Слово есть только в постоянном комментарии мысли-цели.
        createComment(ndb, 'thought', target, { kind: 'permanent', body_md: 'секрет' }, USER);
        const rec = createCommentWithTargets(
          ndb,
          [{ owner_type: 'thought', owner_id: target }],
          { kind: 'chronological', body_md: 'обычное тело', valid_from: '2024-01-01' },
          USER,
        );
        // По умолчанию область — все: запись находится мыслевым путём.
        assert.deepEqual(query(ndb, { keywords: 'секрет' }).rows.map((r) => r.id), [rec.id]);
        // Область «наименование» отсекает комментарий — путь А пуст, тело записи
        // слова не содержит.
        assert.deepEqual(
          query(ndb, { keywords: 'секрет', keyword_scope: ['title'] }).rows.map((r) => r.id),
          [],
        );
      } finally {
        ndb.close();
      }
    });
  },
);
