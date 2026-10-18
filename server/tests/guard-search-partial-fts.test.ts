/**
 * Сторож: partial-поиск дублей не делает полный LIKE-скан, когда в запросе есть
 * хотя бы одно include-слово ≥3 символов (задача e4f26158, ошибка 49e05ea0).
 *
 * Правило (стандарт f36a5207 «Правило без теста-сторожа не считается
 * введённым»): `findDuplicates` для слов, которые способен отразить trigram-
 * индекс, обязан сужать кандидатов через `fts_thought_names MATCH`, а не
 * сканировать `thoughts`/`thought_synonyms_v` предикатом `LIKE '%…%'`.
 * LIKE остаётся законным только для слов <3 символов и `*`-исключений
 * (физическое ограничение токенизатора и порядковая семантика), поэтому:
 *
 *   * только длинные include-слова → в SQL есть MATCH и НЕТ LIKE;
 *   * смесь длинных и коротких  → MATCH есть (LIKE по короткому — можно);
 *   * только короткие слова     → MATCH нет, работает документированный
 *                                  LIKE-фолбэк.
 *
 * Проверка функциональная: SQL partial-запроса перехватывается на
 * `ndb.prepare`, а не ищется по тексту исходника — переименование переменных
 * сторож не красит, а возврат к полному LIKE-скану — красит. Мутационная
 * проверка (последний тест) подаёт предикату синтетический «откатанный» SQL и
 * требует нарушения.
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

/** Insert a thought row directly. */
function seedThought(ndb: NetworkDb, title: string): void {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase());
}

/**
 * The partial-tier candidate query is the only one aliasing `thoughts_v` as
 * `thoughts`. The alias may appear after a `CROSS JOIN` with the FTS index
 * (when the trigram narrower is active), so match on the alias, not on
 * `FROM thoughts_v thoughts`.
 */
const isPartialQuery = (sql: string): boolean => sql.includes('thoughts_v thoughts');

/** One captured partial statement with its bound parameters. */
interface CapturedPartial {
  sql: string;
  params: unknown[];
}

/**
 * Перехватить SQL и параметры, которые `findDuplicates` готовит на один
 * запрос. Возвращает только partial-запросы (их число = число входных
 * терминов).
 */
function capturePartialStatements(ndb: NetworkDb, query: string): CapturedPartial[] {
  const original = ndb.prepare.bind(ndb);
  const captured: CapturedPartial[] = [];
  ndb.prepare = ((sql: string) => {
    const stmt = original(sql);
    if (isPartialQuery(sql)) {
      const entry: CapturedPartial = { sql, params: [] };
      captured.push(entry);
      const originalAll = stmt.all.bind(stmt);
      stmt.all = ((...args: unknown[]) => {
        entry.params = args;
        return originalAll(...args);
      }) as typeof stmt.all;
    }
    return stmt;
  }) as typeof ndb.prepare;
  try {
    findDuplicates(ndb, query);
  } finally {
    ndb.prepare = original;
  }
  return captured;
}

/** Backwards-compatible SQL-only view of {@link capturePartialStatements}. */
function capturePartialSql(ndb: NetworkDb, query: string): string[] {
  return capturePartialStatements(ndb, query).map((entry) => entry.sql);
}

/**
 * Нарушения правила для одного partial-запроса. `longInclude` — в запросе есть
 * include-слово ≥3 символов (значит, индекс обязан участвовать).
 */
function violations(sql: string, longInclude: boolean): string[] {
  if (!isPartialQuery(sql) || !longInclude) return [];
  const hasMatch = /fts_thought_names\s+MATCH\s+\?/.test(sql);
  const hasLike = /\bLIKE\b/.test(sql);
  const found: string[] = [];
  if (!hasMatch) found.push('нет fts_thought_names MATCH при длинном include-слове');
  if (hasLike) found.push('полный LIKE-скан остался при длинном include-слове');
  return found;
}

describe(
  'guard: partial-дубли сужаются FTS5 при длинных include-словах',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('только длинное слово → MATCH без LIKE', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Cats and dogs');
        seedThought(ndb, 'Dogs and cats');
        for (const sql of capturePartialSql(ndb, 'cats')) {
          assert.deepEqual(violations(sql, true), [], sql);
        }
      } finally {
        ndb.close();
      }
    });

    it('смесь длинного и короткого → MATCH есть, LIKE допустим только для короткого', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Cats and dogs');
        for (const sql of capturePartialSql(ndb, 'cats до')) {
          assert.ok(/fts_thought_names\s+MATCH\s+\?/.test(sql), sql);
        }
      } finally {
        ndb.close();
      }
    });

    it('только короткое слово → документированный LIKE-фолбэк без MATCH', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Cats and dogs');
        for (const sql of capturePartialSql(ndb, 'до')) {
          assert.equal(/fts_thought_names\s+MATCH\s+\?/.test(sql), false, sql);
          assert.ok(/\bLIKE\b/.test(sql), sql);
        }
      } finally {
        ndb.close();
      }
    });

    it('план: FTS-индекс ведёт выборку, а не thoughts_v (регрессия стоимости)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Cats and dogs');
        const [partial] = capturePartialStatements(ndb, 'cats');
        assert.ok(partial, 'partial-запрос не найден');
        // С `CROSS JOIN` FTS-таблица обязана идти внешним циклом: иначе
        // планировщик оставляет thoughts_v снаружи и вычисляет MATCH на
        // каждую мысль (замер: 26 мс без совпадений и 557 мс на термине,
        // покрывающем всю сеть, вместо 0,01/4,6 мс).
        const plan = ndb
          .prepare(`EXPLAIN QUERY PLAN ${partial.sql}`)
          .all(...partial.params) as Array<{ detail: string }>;
        assert.match(
          plan[0]?.detail ?? '',
          /fnames/,
          `FTS должен быть внешним циклом: ${JSON.stringify(plan)}`,
        );
      } finally {
        ndb.close();
      }
    });

    it('NFC/NFD: include-фраза покрывает обе канонические формы (грабли 6898ef75)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Йогуртовая история'.normalize('NFD'));
        const [partial] = capturePartialStatements(ndb, 'йогурт');
        assert.ok(partial, 'partial-запрос не найден');
        const match = partial.params[0];
        assert.equal(typeof match, 'string');
        const nfc = 'йогурт';
        const nfd = nfc.normalize('NFD');
        assert.notEqual(nfd, nfc, 'для этого слова формы обязаны различаться');
        // Мутация «оставить только NFC-фразу» (как в 7c7ddbc5) проходит первую
        // проверку и краснит вторую; снятие группировки краснит третью.
        assert.ok((match as string).includes(`"${nfc}"`), String(match));
        assert.ok((match as string).includes(`"${nfd}"`), String(match));
        assert.match(match as string, /\(.*OR.*\)/, 'обе формы должны быть в OR-группе');
      } finally {
        ndb.close();
      }
    });

    it('NFC/NFD: исключение покрывает обе формы группой NOT', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Напиток йогурт'.normalize('NFD'));
        const [partial] = capturePartialStatements(ndb, 'напит -йогурт');
        assert.ok(partial, 'partial-запрос не найден');
        const match = partial.params[0] as string;
        const nfc = 'йогурт';
        const nfd = nfc.normalize('NFD');
        // `NOT ("nfc" OR "nfd")` = «фрагмент отсутствует в обеих формах» —
        // ровно то, что делал прежний `NOT (… LIKE …)` по NFC-колонке.
        assert.ok(match.includes(`NOT ("${nfc}" OR "${nfd}")`), match);
      } finally {
        ndb.close();
      }
    });

    it('мутация: откатанный на полный LIKE-скан SQL нарушает правило', () => {
      const reverted =
        "SELECT id FROM thoughts_v thoughts WHERE (title_norm LIKE ? ESCAPE '\\'" +
        " OR thoughts.id IN (SELECT ts.thought_id FROM thought_synonyms_v ts" +
        " WHERE ts.synonym_norm LIKE ? ESCAPE '\\')) AND thoughts.marked_for_deletion = 0";
      assert.deepEqual(violations(reverted, true), [
        'нет fts_thought_names MATCH при длинном include-слове',
        'полный LIKE-скан остался при длинном include-слове',
      ]);
    });
  },
);
