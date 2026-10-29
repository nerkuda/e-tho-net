/**
 * Эквивалентность partial-ветки `findDuplicates`: FTS5-сужатель против прежнего
 * LIKE-скана (задача e4f26158, ошибка 49e05ea0).
 *
 * В 0.13.2 кандидаты partial-тира для include-слов ≥3 символов берутся из
 * `fts_thought_names` (`MATCH`), а не полным LIKE-сканом. Точная семантика
 * мини-языка §6.10 (фрагменты внутри ПОСЛЕДОВАТЕЛЬНЫХ слов в порядке набора,
 * `-word`, `*`) по-прежнему проверяется JS-постфильтром
 * `synonymPatternToRegex`, поэтому сужатель обязан быть НАДМНОЖЕСТВОМ прежнего
 * результата, а итоговый набор — совпадать.
 *
 * Эталон — прежняя реализация, вынесенная в `legacyPartialIds` (тот же SQL и
 * тот же постфильтр). Корпус построен так, чтобы для каждого запроса не было
 * точных совпадений title/synonym и `*`-синонимов в данных: тогда результат
 * `findDuplicates` — ровно partial-тир, и наборы сравниваются напрямую.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import {
  buildLikePattern,
  parseFilterKeywords,
  synonymPatternToRegex,
} from '@etn/shared';

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

/** Normalise the way `findDuplicates` does. */
const norm = (value: string): string => value.normalize('NFC').trim().toLowerCase();

/**
 * Прежняя (до e4f26158) partial-ветка `findDuplicates`: LIKE-префильтр по
 * каждому include/exclude-слову + JS-постфильтр последовательных слов.
 * Возвращает только partial-id — эталон для сравнения.
 */
function legacyPartialIds(ndb: NetworkDb, term: string): string[] {
  const n = norm(term);
  const keywords = parseFilterKeywords(n);
  if (keywords.include.length === 0) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];
  const push = (word: string, negate: boolean): void => {
    const pattern = buildLikePattern(word.toLowerCase());
    const clause =
      "(title_norm LIKE ? ESCAPE '\\' OR thoughts.id IN (SELECT ts.thought_id" +
      " FROM thought_synonyms_v ts WHERE ts.synonym_norm LIKE ? ESCAPE '\\'))";
    conditions.push(negate ? `NOT ${clause}` : clause);
    params.push(pattern, pattern);
  };
  for (const word of keywords.include) push(word, false);
  for (const word of keywords.exclude) push(word, true);

  let rows = ndb
    .prepare(
      `SELECT id, title FROM thoughts_v thoughts WHERE ${conditions.join(' AND ')}
         AND thoughts.marked_for_deletion = 0`,
    )
    .all(...params) as Array<{ id: string; title: string }>;

  const includeRe = synonymPatternToRegex(
    keywords.include.map((w) => `*${w}*`).join(' '),
  );
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const synRows = ndb
      .prepare(
        `SELECT thought_id, synonym_norm FROM thought_synonyms_v
         WHERE thought_id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as Array<{ thought_id: string; synonym_norm: string }>;
    const synsByThought = new Map<string, string[]>();
    for (const s of synRows) {
      const list = synsByThought.get(s.thought_id);
      if (list) list.push(s.synonym_norm);
      else synsByThought.set(s.thought_id, [s.synonym_norm]);
    }
    rows = rows.filter((r) => {
      const hay = [norm(r.title), ...(synsByThought.get(r.id) ?? [])];
      return hay.some((h) => includeRe.test(h));
    });
  }
  return rows.map((r) => r.id).sort();
}

/** Ids of the partial tier in the current implementation. */
function partialIds(ndb: NetworkDb, term: string): string[] {
  // Сравниваем partial-тир live-поиска (0.4.5) с legacy LIKE-эталоном;
  // строгий dedupe (0.14.1, ошибка 11f14a81) живёт в find-duplicates-dedupe.
  return findDuplicates(ndb, term, [], [], { mode: 'search' })
    .filter((h) => h.matched_on === 'partial')
    .map((h) => h.id)
    .sort();
}

/**
 * Корпус: кириллица и латиница, несколько слов, спецсимволы `%`, `_`, `"`,
 * инфиксы в title и в синонимах. Ни один заголовок/синоним не должен быть
 * точным совпадением тестового запроса — иначе `findDuplicates` поднимет
 * `matched_on` до `title`/`synonym` и сравнение partial-тира потеряет смысл.
 */
const CORPUS: Array<{ title: string; synonyms: string[] }> = [
  { title: 'Доработать отчёт', synonyms: ['дорога в лето', 'Подорожание 2026 года'] },
  { title: 'Исправленные ошибки', synonyms: ['исправление багов'] },
  { title: 'Исправить старую ошибку', synonyms: [] },
  { title: 'Ошибки исправления', synonyms: ['регресс'] },
  { title: 'Cats and dogs', synonyms: ['domestic cats', 'felines'] },
  { title: 'Dogs and cats', synonyms: ['canines'] },
  { title: 'Alpha dog', synonyms: ['lpha lpha'] },
  { title: 'Проценты 100% годовых', synonyms: ['ставка 50%'] },
  { title: 'Имена a_b и c_d', synonyms: ['подчёркивание a_b'] },
  { title: 'Цитата quo"te внутри', synonyms: ['кавычка quo"te'] },
  { title: 'Диана и обсидиан', synonyms: ['миграция из обсидиана'] },
  // Несколько исключений: проверяет, что FTS5 разбирает цепочку
  // `include NOT a NOT b` как «ни a, ни b» (левоассоциативный NOT), а не как
  // вложенный `b NOT (a NOT b)` — второй вариант пропустил бы одну из строк.
  { title: 'alpha beta gamma', synonyms: [] },
  { title: 'alpha beta delta', synonyms: [] },
  { title: 'alpha beta', synonyms: [] },
  // Обратный порядок фрагментов для `*`-исключения: LIKE `%beta%gamma%`
  // такую строку НЕ отсекает, а FTS `NOT (beta AND gamma)` отсекла бы —
  // поэтому `*`-исключения обязаны оставаться на LIKE.
  { title: 'alpha gamma beta', synonyms: [] },
  { title: 'Foo bar baz', synonyms: ['bar foo'] },
  // NFD-корпус (данные, записанные, например, macOS): raw-форма
  // декомпозирована, `*_norm` — NFC. Индекс `fts_thought_names` строится из
  // raw, поэтому фраза сужателя обязана покрывать ОБЕ канонические формы
  // (грабли 6898ef75). Без этого NFC-запрос давал 0 кандидатов там, где
  // прежний LIKE по `_norm` находил совпадение.
  {
    title: 'Йогуртовая история'.normalize('NFD'),
    synonyms: ['йогурт натуральный'.normalize('NFD')],
  },
  { title: 'Тёмный лес'.normalize('NFD'), synonyms: ['ёлка пушистая'.normalize('NFD')] },
  // Контрольные пары «е/ё» и «и/й»: NFC-соседи не должны ложно совпадать.
  { title: 'Иод и еж', synonyms: [] },
  { title: 'Ёжик в тумане'.normalize('NFD'), synonyms: [] },
  { title: 'Ежевика', synonyms: [] },
  { title: 'Елки в парке', synonyms: [] },
  { title: 'Ёлки-палки'.normalize('NFD'), synonyms: [] },
  { title: 'Напиток кефир'.normalize('NFD'), synonyms: [] },
  { title: 'Напиток йогурт'.normalize('NFD'), synonyms: [] },
];

/** Queries that must produce identical results in both implementations. */
const QUERIES: Array<{ label: string; query: string }> = [
  { label: 'кириллица, 3 символа', query: 'дор' },
  { label: 'регистр', query: 'Дор' },
  { label: 'кириллица, инфикс', query: 'сидиан' },
  { label: 'два слова в порядке набора', query: 'исправ ошиб' },
  { label: 'два слова в обратном порядке', query: 'ошиб исправ' },
  { label: 'латиница, 3 символа', query: 'cat' },
  { label: 'латиница, слово целиком', query: 'cats' },
  { label: 'слово <3 символов (LIKE-фолбэк)', query: 'ca' },
  { label: 'слово 2 символа (LIKE-фолбэк)', query: 'до' },
  { label: 'слово 1 символ (LIKE-фолбэк)', query: 'о' },
  { label: 'смесь длинного и короткого', query: 'cat do' },
  { label: 'длинное include + длинное исключение', query: 'cats -dog' },
  { label: 'несколько исключений', query: 'alpha beta -gamma -delta' },
  { label: 'исключение со звёздочкой и обратным порядком', query: 'alpha -beta*gamma' },
  { label: 'исключение <3 символов', query: 'cats -do' },
  { label: 'исключение со звёздочкой', query: 'cats -dog*' },
  { label: 'звёздочка в include', query: 'исправ*' },
  { label: 'звёздочка в латинском include', query: 'cat*' },
  { label: 'звёздочка разрывает слово', query: 'дор*ога' },
  { label: 'спецсимвол %', query: '100%' },
  { label: 'спецсимвол _', query: 'a_b' },
  { label: 'спецсимвол "', query: 'quo"te' },
  { label: 'пустая строка', query: '' },
  { label: 'только исключение', query: '-dog' },
  // NFD-корпус ↔ NFC-запрос: обе канонические формы покрывает одна FTS-фраза.
  { label: 'NFD-данные, NFC-запрос (й)', query: 'йогурт' },
  { label: 'NFD-данные, NFC-инфикс (ё)', query: 'тёмн' },
  { label: 'NFD-данные, NFC-инфикс по синониму (ёлк)', query: 'ёлк' },
  { label: 'NFD-данные, исключение (NFC-запрос)', query: 'напит -йогурт' },
  // Фактический путь findDuplicates: `norm()` приводит запрос к NFC, поэтому
  // NFD-ввод проверяет нормализацию входа, а не FTS-фразу.
  { label: 'NFD-запрос нормализуется в NFC', query: 'йогурт'.normalize('NFD') },
  // «е/ё» и «и/й» — разные буквы: ложных срабатываний быть не должно.
  // Слова <3 символов идут LIKE-фолбэком, 4+ — через FTS.
  { label: 'еж ≠ ёж (LIKE-фолбэк)', query: 'еж' },
  { label: 'ёж ≠ еж (LIKE-фолбэк)', query: 'ёж' },
  { label: 'ёлки ≠ елки (FTS)', query: 'ёлки' },
  { label: 'елки ≠ ёлки (FTS)', query: 'елки' },
  { label: 'й нет в «Иод» (FTS)', query: 'йод' },
];

describe(
  'findDuplicates partial: FTS5-сужатель эквивалентен прежнему LIKE-скану',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('одинаковые наборы на корпусе запросов (эталон — старая реализация)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        for (const entry of CORPUS) {
          const id = seedThought(ndb, entry.title);
          for (const synonym of entry.synonyms) seedSynonym(ndb, id, synonym);
        }
        for (const { label, query } of QUERIES) {
          assert.deepEqual(
            partialIds(ndb, query),
            legacyPartialIds(ndb, query),
            `${label}: «${query}»`,
          );
        }
      } finally {
        ndb.close();
      }
    });

    it('исключение по длинному слову отсекает и title, и синоним (как LIKE)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const viaTitle = seedThought(ndb, 'Дорога домой');
        const viaSynonym = seedThought(ndb, 'Маршрут');
        seedSynonym(ndb, viaSynonym, 'дорога на работу');
        const clean = seedThought(ndb, 'Дорога в лес');
        seedSynonym(ndb, clean, 'тропа');

        assert.deepEqual(partialIds(ndb, 'дорога -работ'), legacyPartialIds(ndb, 'дорога -работ'));
        assert.ok(!partialIds(ndb, 'дорога -работ').includes(viaSynonym));
        assert.ok(partialIds(ndb, 'дорога -работ').includes(viaTitle));
        assert.ok(partialIds(ndb, 'дорога -работ').includes(clean));
      } finally {
        ndb.close();
      }
    });

    it('помеченные на удаление мысли не проходят FTS-сужатель', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const trashed = seedThought(ndb, 'Доработать отчёт');
        ndb.prepare('UPDATE thoughts SET marked_for_deletion = 1 WHERE id = ?').run(trashed);
        assert.deepEqual(partialIds(ndb, 'дор'), []);
        assert.deepEqual(legacyPartialIds(ndb, 'дор'), []);
      } finally {
        ndb.close();
      }
    });

    it('NFD-данные: NFC-запрос находит partial и по title, и по синониму', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const viaTitle = seedThought(ndb, 'Йогуртовая история'.normalize('NFD'));
        const viaSynonym = seedThought(ndb, 'Напиток'.normalize('NFD'));
        seedSynonym(ndb, viaSynonym, 'йогурт натуральный'.normalize('NFD'));

        const ids = partialIds(ndb, 'йогурт');
        assert.deepEqual(ids, [viaTitle, viaSynonym].sort());
        // Эталон прежней реализации (LIKE по NFC-колонкам) находил оба —
        // значит, разрыв был именно в FTS-сужателе, а не в постфильтре.
        assert.deepEqual(ids, legacyPartialIds(ndb, 'йогурт'));
      } finally {
        ndb.close();
      }
    });

    it('NFC-данные: NFD-запрос находит (фактический путь — norm() в NFC)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const id = seedThought(ndb, 'Йогуртовая история');
        const nfdQuery = 'йогурт'.normalize('NFD');
        assert.notEqual(nfdQuery, 'йогурт', 'NFD-форма должна отличаться от NFC');
        // findDuplicates нормализует термин `norm()` (NFC) ДО разбора, поэтому
        // до FTS доходит уже NFC-форма; тест фиксирует этот фактический путь.
        assert.deepEqual(partialIds(ndb, nfdQuery), [id]);
      } finally {
        ndb.close();
      }
    });

    it('исключение в NFD-данных отсекает NFD-мысль, как прежний LIKE', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const excluded = seedThought(ndb, 'Напиток йогурт'.normalize('NFD'));
        const kept = seedThought(ndb, 'Напиток кефир'.normalize('NFD'));

        const ids = partialIds(ndb, 'напит -йогурт');
        assert.ok(!ids.includes(excluded), 'NFD-форма исключения должна отсечь мысль');
        assert.deepEqual(ids, [kept]);
        assert.deepEqual(ids, legacyPartialIds(ndb, 'напит -йогурт'));
      } finally {
        ndb.close();
      }
    });

    it('кириллица й/ё: обе формы находятся, соседние буквы не дают ложных совпадений', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const yozhik = seedThought(ndb, 'Ёжик в тумане'.normalize('NFD'));
        const ezhevika = seedThought(ndb, 'Ежевика');
        const yolki = seedThought(ndb, 'Ёлки-палки'.normalize('NFD'));
        const elki = seedThought(ndb, 'Елки в парке');
        const iogurt = seedThought(ndb, 'Иогурт без й'.normalize('NFD'));

        // ё/е, 4 символа → FTS-фраза `("nfc" OR "nfd")`.
        assert.deepEqual(partialIds(ndb, 'ёлки'), [yolki]);
        assert.deepEqual(partialIds(ndb, 'елки'), [elki]);
        // ё/е, 2 символа → документированный LIKE-фолбэк по NFC-колонке.
        assert.deepEqual(partialIds(ndb, 'ёж'), [yozhik]);
        assert.deepEqual(partialIds(ndb, 'еж'), [ezhevika]);
        // й/и — разные буквы: «Иогурт» не должен находиться по «йогурт».
        assert.deepEqual(partialIds(ndb, 'йогурт'), []);
        assert.deepEqual(partialIds(ndb, 'йогурт'), legacyPartialIds(ndb, 'йогурт'));
        assert.deepEqual(partialIds(ndb, 'иогурт'), [iogurt]);
      } finally {
        ndb.close();
      }
    });
  },
);
