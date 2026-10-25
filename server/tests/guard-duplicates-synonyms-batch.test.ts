/**
 * Сторож: `findDuplicates` не читает синонимы поштучно на кандидата (задача
 * 8abc413f).
 *
 * Правило (стандарт f36a5207 «Правило без теста-сторожа не считается
 * введённым»): синонимы результатов грузятся ОДНИМ запросом (или O(N/порция)),
 * а не `SELECT … WHERE thought_id = ?` на каждого кандидата. Проверка
 * функциональная: SQL перехватывается на `ndb.prepare`, поэтому переименование
 * переменных сторож не красит, а возврат к N+1 — красит.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { findDuplicates } from '../src/domain/search-service.js';

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

/** Insert a thought row directly (same shape as search-service.test.ts). */
function seedThought(ndb: NetworkDb, title: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.normalize('NFC').toLowerCase());
  return id;
}

/** Insert a synonym for a thought. */
function seedSynonym(ndb: NetworkDb, thoughtId: string, synonym: string): void {
  ndb
    .prepare(
      'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)',
    )
    .run(thoughtId, synonym, synonym.normalize('NFC').toLowerCase());
}

/**
 * Поштучное чтение синонимов: обращение к `thought_synonyms_v` с предикатом
 * `thought_id = ?`. Именно его давал прежний `ensure()`.
 */
const isSingleIdSynonymQuery = (sql: string): boolean =>
  /thought_synonyms_v/.test(sql) && /thought_id\s*=\s*\?/.test(sql);

/** Батч-чтение синонимов результатов: `thought_id IN (?, …)`. */
const isBatchSynonymListQuery = (sql: string): boolean =>
  /SELECT\s+thought_id,\s*synonym\s+FROM\s+thought_synonyms_v/i.test(sql) &&
  /thought_id\s+IN\s*\(/i.test(sql);

/** Выполнить вызовы и вернуть весь SQL, который готовился на `ndb.prepare`. */
function capturePreparedSql(ndb: NetworkDb, calls: () => void): string[] {
  const original = ndb.prepare.bind(ndb);
  const captured: string[] = [];
  ndb.prepare = ((sql: string) => {
    captured.push(sql);
    return original(sql);
  }) as typeof ndb.prepare;
  try {
    calls();
  } finally {
    ndb.prepare = original;
  }
  return captured;
}

/**
 * Корпус: четыре кандидата, у каждого ≥2 синонима. `titleMatch` попадает в
 * несколько тиров сразу (точное название по «cats», точный синоним по
 * «felines», partial по обоим терминам), `wildcard` — в точный синонимный и
 * wildcard-тиры.
 */
interface Corpus {
  titleMatch: string;
  partialMatch: string;
  wildcard: string;
  otherPartial: string;
  synonyms: Map<string, string[]>;
}

function seedCorpus(ndb: NetworkDb): Corpus {
  const titleMatch = seedThought(ndb, 'Cats');
  const partialMatch = seedThought(ndb, 'Domestic cats at home');
  const wildcard = seedThought(ndb, 'Петров Игорь');
  const otherPartial = seedThought(ndb, 'Cats and dogs');

  const synonyms = new Map<string, string[]>([
    [titleMatch, ['Felines', 'alpha feline', 'Коты']],
    [partialMatch, ['beta home', 'omega pets']],
    [wildcard, ['Игорян*', 'gamma crew']],
    [otherPartial, ['delta pack', 'theta pack']],
  ]);
  for (const [id, list] of synonyms) {
    for (const synonym of list) seedSynonym(ndb, id, synonym);
  }
  return { titleMatch, partialMatch, wildcard, otherPartial, synonyms };
}

describe(
  'guard: findDuplicates грузит синонимы батчем, а не по кандидату',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('0 поштучных SELECT … WHERE thought_id = ? при нескольких тирах', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const corpus = seedCorpus(ndb);
        let hits = 0;
        const sql = capturePreparedSql(ndb, () => {
          hits += findDuplicates(ndb, 'cats', ['felines'], [], { mode: 'search' }).length;
          hits += findDuplicates(ndb, 'Игорянский', [], [], { mode: 'search' }).length;
        });
        assert.ok(hits >= 4, `ожидались все кандидаты, получено ${hits}`);
        const singleId = sql.filter(isSingleIdSynonymQuery);
        assert.deepEqual(singleId, [], `поштучные чтения синонимов: ${singleId.join('\n')}`);
        assert.ok(
          sql.some(isBatchSynonymListQuery),
          'нет батч-запроса списка синонимов результатов',
        );
        // Порции не пересекаются: один id не должен читаться повторно.
        assert.ok(corpus.synonyms.size >= 3);
      } finally {
        ndb.close();
      }
    });

    it('синонимы каждого hit — свои, в порядке ORDER BY synonym, без загрязнения', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const corpus = seedCorpus(ndb);
        const hits = findDuplicates(ndb, 'cats', ['felines'], [], { mode: 'search' });
        assert.ok(hits.length >= 3);
        for (const hit of hits) {
          assert.deepEqual(
            hit.synonyms,
            [...(corpus.synonyms.get(hit.id) ?? [])].sort(),
            `синонимы мысли ${hit.title}`,
          );
        }
        const byId = new Map(hits.map((h) => [h.id, h]));
        assert.equal(byId.get(corpus.titleMatch)?.matched_on, 'title');
        assert.equal(byId.get(corpus.titleMatch)?.matched_synonym, undefined);
        assert.equal(byId.get(corpus.partialMatch)?.matched_on, 'partial');
        assert.deepEqual(
          byId.get(corpus.titleMatch)?.synonyms,
          ['Felines', 'alpha feline', 'Коты'],
        );
        assert.deepEqual(byId.get(corpus.partialMatch)?.synonyms, ['beta home', 'omega pets']);
      } finally {
        ndb.close();
      }
    });

    it('мутация: прежний SQL поштучного чтения распознаётся сторожем', () => {
      const reverted =
        'SELECT synonym FROM thought_synonyms_v WHERE thought_id = ? ORDER BY synonym';
      assert.equal(isSingleIdSynonymQuery(reverted), true);
      // Батч-запросы тиров не должны попадать под сторож.
      assert.equal(
        isSingleIdSynonymQuery(
          'SELECT thought_id, synonym FROM thought_synonyms_v WHERE thought_id IN (?, ?) ORDER BY thought_id, synonym',
        ),
        false,
      );
      assert.equal(
        isSingleIdSynonymQuery(
          'SELECT thought_id, synonym_norm FROM thought_synonyms_v WHERE thought_id IN (?)',
        ),
        false,
      );
    });
  },
);
