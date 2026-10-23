/**
 * Раскрытие `*`-синонимов в поиске мыслей (задача f0b06700, требование
 * 35218826 — третий сценарий «поиск»).
 *
 * Что проверяется (директивы D1–D12 предполёта):
 *
 *   * `keywords` отбора мыслей (плоский и AST-путь) и группа `by_names`
 *     полнотекстового поиска матчат слово запроса со СЛОВОМ `*`-синонима по
 *     границам слова (`^(?:…)$`, чанки склеены `\S*`), слова запроса
 *     независимы (AND в любом порядке) — D1;
 *   * аддитивность: прежде находившееся находится по-прежнему, включая сети
 *     без `*`-синонимов — D2;
 *   * `-слово` симметрично включению (литеральная подстрока ИЛИ слово-паттерн)
 *     — D3; слово запроса с `*` — только литеральная ветка — D4; расширение
 *     только в источнике `synonyms` — D5;
 *   * нормализация NFC+lowercase и NFD-ввод — D6; корректность
 *     `total`/`has_more`/`next_cursor`/`total_in_group` — D7; короткие слова —
 *     D8; AST-путь (он же `etn.views.run`) — D9;
 *   * инвариант «SQL-кандидаты ⊇ точный фильтр» сверяется с независимой
 *     эталонной реализацией D1–D3 на корпусе, а не точечными кейсами — D11.
 *
 * Фикстура — ровно DoD задачи: мысль «спроектировать новую функциональность»
 * с синонимами «проектиров* функциональност*» и «дизайн* нов* фич*».
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import {
  FILTER_AST_VERSION,
  buildLikePattern,
  type FilterAst,
  type StructureKeywordScope,
} from '@etn/shared';

import { closeAll, createInMemoryNetworkDb, openNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { closeReaderPool, configureReaderPool } from '../src/db/reader-pool.js';
import { queryThoughtsAsync, searchAsync } from '../src/domain/heavy-read.js';
import { queryThoughts, type ThoughtQueryRequest } from '../src/domain/query-service.js';
import { search } from '../src/domain/search-service.js';

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

const USER = 'wildcard-user';
const NETWORK_ID = 'wildcard-network';

/** Insert a thought row directly (title_norm — как в production: NFC+lowercase). */
function seedThought(ndb: NetworkDb, title: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase());
  return id;
}

/** Insert a synonym (normalisation mirrors `normalizeTitle`). */
function seedSynonym(ndb: NetworkDb, thoughtId: string, synonym: string): void {
  ndb
    .prepare('INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)')
    .run(thoughtId, synonym, synonym.normalize('NFC').trim().toLowerCase());
}

/** Фикстура DoD: одна мысль, находящаяся по словоформам только через `*`-синонимы. */
function seedDoDFixture(ndb: NetworkDb): string {
  const id = seedThought(ndb, 'спроектировать новую функциональность');
  seedSynonym(ndb, id, 'проектиров* функциональност*');
  seedSynonym(ndb, id, 'дизайн* нов* фич*');
  return id;
}

/** Канонический keywords-запрос движка. */
function kw(query: string, over: Partial<ThoughtQueryRequest> = {}): ThoughtQueryRequest {
  return { sort: 'alpha', order: 'asc', limit: 50, offset: 0, keywords: query, ...over };
}

/** id найденных мыслей keywords-отбором. */
function ids(ndb: NetworkDb, request: ThoughtQueryRequest): string[] {
  return queryThoughts(ndb, USER, request, { emptyFilterMode: 'all' }).items.map((i) => i.id);
}

/**
 * Эталонная реализация слова-паттерна синонима (D1): паттерн-слово разворачивается
 * в `\S*` по `*` и анкерится на ОДНО слово. Написана независимо от продакшн-
 * матчера — иначе инвариантный тест замкнётся сам на себя.
 */
function refWordPatternMatch(word: string, synonymNorm: string): boolean {
  for (const patternWord of synonymNorm.trim().split(/\s+/)) {
    if (!patternWord.includes('*')) continue;
    const body = patternWord
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\S*');
    if (new RegExp(`^(?:${body})$`, 'u').test(word)) return true;
  }
  return false;
}

/** LIKE-паттерн §6.10 (`%…%`, `*` → `%`) как регулярное выражение. */
function likeRegExp(word: string): RegExp {
  const pattern = buildLikePattern(word.normalize('NFC').toLowerCase());
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      i += 1;
      source += (pattern[i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '%') source += '.*';
    else if (ch === '_') source += '.';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'su');
}

/** Эталон D1–D3: слово запроса ↔ мысль (заголовок литерально, синонимы литерально ИЛИ слово-паттерн). */
function refWordMatches(word: string, titleNorm: string, synonymNorms: string[]): boolean {
  const norm = word.normalize('NFC').toLowerCase();
  const like = likeRegExp(word);
  if (like.test(titleNorm)) return true;
  for (const synonym of synonymNorms) {
    if (like.test(synonym)) return true;
    // D4: слово запроса с `*` участвует только в литеральной ветке.
    if (!norm.includes('*') && refWordPatternMatch(norm, synonym)) return true;
  }
  return false;
}

/** Эталонный предикат keywords (D1–D3) по всей сети. */
function referenceKeywordIds(
  ndb: NetworkDb,
  include: string[],
  exclude: string[],
  scope: StructureKeywordScope[] = ['title', 'synonyms'],
): string[] {
  const rows = ndb.prepare('SELECT id, title_norm FROM thoughts_v').all() as Array<{
    id: string;
    title_norm: string;
  }>;
  const synonyms = new Map<string, string[]>();
  for (const row of ndb.prepare('SELECT thought_id, synonym_norm FROM thought_synonyms_v').all() as Array<{
    thought_id: string;
    synonym_norm: string;
  }>) {
    const list = synonyms.get(row.thought_id) ?? [];
    list.push(row.synonym_norm);
    synonyms.set(row.thought_id, list);
  }
  const inScope = (word: string, titleNorm: string, syn: string[]): boolean => {
    const norm = word.normalize('NFC').toLowerCase();
    const like = likeRegExp(word);
    if (scope.includes('title') && like.test(titleNorm)) return true;
    if (!scope.includes('synonyms')) return false;
    for (const synonym of syn) {
      if (like.test(synonym)) return true;
      if (!norm.includes('*') && refWordPatternMatch(norm, synonym)) return true;
    }
    return false;
  };
  return rows
    .filter((row) => {
      const syn = synonyms.get(row.id) ?? [];
      return (
        include.every((word) => inScope(word, row.title_norm, syn)) &&
        exclude.every((word) => !inScope(word, row.title_norm, syn))
      );
    })
    .map((row) => row.id)
    .sort();
}

/** AST-лист «Найти слова» (тот же путь исполняют `etn.views.run` и REST `ast`). */
function keywordsAst(value: string, scope: StructureKeywordScope[]): FilterAst {
  return {
    version: FILTER_AST_VERSION,
    filter: { entity: { kind: 'keywords', scope }, operator: 'matches', value },
  };
}

describe(
  'wildcard-синонимы: keywords и by_names раскрывают `*` (задача f0b06700)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('DoD: «проектирование», «новая функциональность», «проектирование функциональности» находят мысль', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const target = seedDoDFixture(ndb);
        // Мысль без подстановок: литеральная аддитивность (D2).
        const plain = seedThought(ndb, 'Новая функциональность отчёта');

        for (const query of ['проектирование', 'проектирование функциональности']) {
          assert.deepEqual(ids(ndb, kw(query)), [target], `keywords «${query}» находит DoD-мысль`);
        }
        const both = ids(ndb, kw('новая функциональность'));
        assert.ok(both.includes(target), 'слово «новая» матчится словом-паттерном «нов*»');
        assert.ok(both.includes(plain), 'литеральная мысль находится по-прежнему (D2)');
        // Слова запроса могут совпадать разными источниками одной мысли (D1).
        assert.deepEqual(ids(ndb, kw('спроектировать функциональности')), [target]);
      } finally {
        ndb.close();
      }
    });

    it('граница слова: «ектирование» не матчится словом-паттерном «проектиров*»', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedDoDFixture(ndb);
        // Негатив на уровне мысли: слово не является ни литеральной подстрокой
        // любого источника, ни совпадением с анкеренным словом-паттерном.
        // (Матчер-уровень «ектир» проверяется отдельным юнит-тестом в shared.)
        assert.deepEqual(ids(ndb, kw('ектирование')), [], 'паттерн анкерен на слово, не на фрагмент');
      } finally {
        ndb.close();
      }
    });

    it('`-слово` симметрично включению (D3): исключение матчится слово-паттерном', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const target = seedDoDFixture(ndb);
        const plain = seedThought(ndb, 'Функциональность отчёта');
        // «проектирование» литерально в тексте синонима отсутствует — исключение
        // срабатывает только через слово-паттерн «проектиров*».
        assert.deepEqual(ids(ndb, kw('функциональность -проектирование')), [plain]);
        // Литеральное исключение продолжает работать.
        assert.deepEqual(ids(ndb, kw('функциональность -отчёта')), [target]);
      } finally {
        ndb.close();
      }
    });

    it('слово запроса с `*` — только литеральная ветка (D4) и поведение прежнее', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const target = seedDoDFixture(ndb);
        // Литерально «проектиров*» есть в хранимом синониме — находится как раньше.
        assert.deepEqual(ids(ndb, kw('проектиров*')), [target]);
        assert.deepEqual(ids(ndb, kw('дизайн*')), [target]);
        // Слово с `*` не разворачивается в паттерн-ветку: «проектир*ние» — не
        // литеральная подстрока и не слово-паттерн запроса.
        assert.deepEqual(ids(ndb, kw('проектир*ние')), []);
      } finally {
        ndb.close();
      }
    });

    it('расширение только в источнике synonyms (D5): title — литеральный', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedDoDFixture(ndb);
        assert.deepEqual(
          ids(ndb, kw('проектирование', { keyword_scope: ['title'] })),
          [],
          'по заголовку слово-паттерны синонимов не работают',
        );
        assert.equal(
          ids(ndb, kw('проектирование', { keyword_scope: ['synonyms'] })).length,
          1,
          'источник synonyms расширен',
        );
      } finally {
        ndb.close();
      }
    });

    it('короткие слова (D8) и NFD-ввод (D6)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const target = seedDoDFixture(ndb);
        const hedgehog = seedThought(ndb, 'Лесной зверь');
        seedSynonym(ndb, hedgehog, 'ёж*');
        // Двухсимвольное слово запроса не имеет триграммного представления.
        assert.deepEqual(ids(ndb, kw('ёж')), [hedgehog]);
        // Двухсимвольное слово-паттерн: «ёж*» раскрывается в «ёжик» (D8).
        assert.deepEqual(ids(ndb, kw('ёжик')), [hedgehog]);
        // NFD-ввод нормализуется до NFC и матчится словом-паттерном.
        assert.deepEqual(ids(ndb, kw('проектирование'.normalize('NFD'))), [target]);
      } finally {
        ndb.close();
      }
    });

    it('AST-путь «Найти слова» (D9) раскрывает `*`-синонимы так же', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const target = seedDoDFixture(ndb);
        const result = queryThoughts(
          ndb,
          USER,
          {
            sort: 'alpha',
            order: 'asc',
            limit: 50,
            offset: 0,
            count: true,
            ast: keywordsAst('проектирование', ['title', 'synonyms']),
          },
          { emptyFilterMode: 'all' },
        );
        assert.deepEqual(result.items.map((i) => i.id), [target]);
        assert.equal(result.total, 1);
      } finally {
        ndb.close();
      }
    });

    it('D7: точный предикат до COUNT/LIMIT — total, has_more и keyset-курсор', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const created: string[] = [];
        for (const title of ['Альфа', 'Бета', 'Гамма']) {
          const id = seedThought(ndb, title);
          seedSynonym(ndb, id, 'проектиров*');
          created.push(id);
        }
        const first = queryThoughts(
          ndb,
          USER,
          kw('проектирование', { limit: 2, count: true }),
          { emptyFilterMode: 'all' },
        );
        assert.equal(first.total, 3, 'total учитывает wildcard-совпадения');
        assert.equal(first.has_more, true);
        assert.equal(typeof first.next_cursor, 'string');

        const second = queryThoughts(
          ndb,
          USER,
          kw('проектирование', { limit: 2, count: true, cursor: first.next_cursor as string }),
          { emptyFilterMode: 'all' },
        );
        const all = [...first.items, ...second.items].map((i) => i.id);
        assert.deepEqual([...all].sort(), [...created].sort(), 'обход курсором не теряет и не дублирует');
        assert.equal(second.has_more, false);
      } finally {
        ndb.close();
      }
    });

    it('by_names: DoD-запросы, исключения и порядок (pattern-only после FTS)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const target = seedDoDFixture(ndb);
        const plain = seedThought(ndb, 'Новая функциональность отчёта');

        assert.deepEqual(
          search(ndb, { q: 'проектирование', scope: 'names' }).by_names.map((h) => h.thought_id),
          [target],
          'by_names находит мысль словом-паттерном синонима',
        );
        assert.deepEqual(
          search(ndb, { q: 'новая функциональность', scope: 'names' })
            .by_names.map((h) => h.thought_id)
            .sort(),
          [target, plain].sort(),
        );
        // D3: исключение матчится слово-паттерном.
        assert.deepEqual(
          search(ndb, { q: 'функциональность -проектирование', scope: 'names' }).by_names.map(
            (h) => h.thought_id,
          ),
          [plain],
        );
        // Порядок: FTS-ранжированный хит (литеральный) выше pattern-only.
        // Словоформа «функциональности» в заголовке DoD-мысли отсутствует —
        // она находится только словом-паттерном «функциональност*».
        const literal = seedThought(ndb, 'Обзор функциональности системы');
        const ordered = search(ndb, { q: 'функциональности', scope: 'names' }).by_names.map(
          (h) => h.thought_id,
        );
        assert.deepEqual(ordered, [literal, target], 'pattern-only хит идёт после FTS-хита');
        // Сниппет pattern-only хита: литерального вхождения нет — без `<mark>`.
        const patternHit = search(ndb, { q: 'функциональности', scope: 'names' }).by_names.find(
          (h) => h.thought_id === target,
        );
        assert.ok(patternHit, 'pattern-only хит присутствует');
        assert.ok(!patternHit!.snippet.includes('<mark>'), 'подсветки нет — литерального вхождения нет');
      } finally {
        ndb.close();
      }
    });

    it('D7: by_names — total_in_group и страницы не теряют wildcard-хиты', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        for (const title of ['Альфа', 'Бета', 'Гамма']) {
          const id = seedThought(ndb, title);
          seedSynonym(ndb, id, 'проектиров*');
        }
        const first = search(ndb, { q: 'проектирование', scope: 'names', limit: 2, offset: 0 });
        assert.equal(first.meta.total_in_group.names, 3);
        assert.equal(first.by_names.length, 2);
        const second = search(ndb, { q: 'проектирование', scope: 'names', limit: 2, offset: 2 });
        assert.equal(second.by_names.length, 1);
        const all = [...first.by_names, ...second.by_names].map((h) => h.thought_id);
        assert.equal(new Set(all).size, 3, 'страницы не дублируют строки');
      } finally {
        ndb.close();
      }
    });

    it('D2: сеть без `*`-синонимов — прежнее поведение (регресс)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const dog = seedThought(ndb, 'Alpha dog');
        const cat = seedThought(ndb, 'Alpha cat');
        const roadmap = seedThought(ndb, 'Планы проекта');
        seedSynonym(ndb, roadmap, 'roadmap');

        assert.deepEqual(ids(ndb, kw('alpha')).sort(), [dog, cat].sort());
        assert.deepEqual(ids(ndb, kw('roadmap')), [roadmap]);
        assert.deepEqual(ids(ndb, kw('alpha -dog')), [cat]);
        assert.deepEqual(ids(ndb, kw('план*')), [roadmap]);
        assert.deepEqual(ids(ndb, kw('al*ha')).sort(), [dog, cat].sort());

        assert.deepEqual(
          search(ndb, { q: 'alpha -dog', scope: 'names' }).by_names.map((h) => h.thought_id),
          [cat],
        );
        assert.deepEqual(
          search(ndb, { q: 'roadmap', scope: 'names' }).by_names.map((h) => h.thought_id),
          [roadmap],
        );
      } finally {
        ndb.close();
      }
    });

    it('инвариант D11: SQL-выборка keywords совпадает с эталоном D1–D3 на корпусе', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const corpus: Array<{ title: string; synonyms: string[] }> = [
          { title: 'спроектировать новую функциональность', synonyms: ['проектиров* функциональност*', 'дизайн* нов* фич*'] },
          { title: 'Новая функциональность отчёта', synonyms: [] },
          { title: 'Планы проекта', synonyms: ['roadmap', 'план* работ*'] },
          { title: 'Лесной зверь', synonyms: ['ёж*'] },
          { title: 'Дизайн интерфейса', synonyms: ['вёрстка* экран*'] },
          { title: 'Проектирование баз данных', synonyms: ['схем* бд*'] },
          { title: 'Отчёт по проектированию', synonyms: ['документ* проект*'] },
        ];
        for (const entry of corpus) {
          const id = seedThought(ndb, entry.title);
          for (const synonym of entry.synonyms) seedSynonym(ndb, id, synonym);
        }
        const queries = [
          { q: 'проектирование', include: ['проектирование'], exclude: [] },
          { q: 'новая функциональность', include: ['новая', 'функциональность'], exclude: [] },
          { q: 'дизайн', include: ['дизайн'], exclude: [] },
          { q: 'ёжик', include: ['ёжик'], exclude: [] },
          { q: 'проект*', include: ['проект*'], exclude: [] },
          { q: 'функциональность -проектирование', include: ['функциональность'], exclude: ['проектирование'] },
          { q: 'проектирование -функциональност*', include: ['проектирование'], exclude: ['функциональност*'] },
        ];
        for (const { q, include, exclude } of queries) {
          const expected = referenceKeywordIds(ndb, include, exclude);
          const actual = ids(ndb, kw(q, { limit: 200 })).sort();
          assert.deepEqual(actual, expected, `выборка «${q}» совпадает с эталоном`);
        }
      } finally {
        ndb.close();
      }
    });

    it('инвариант D11: постраничная выдача by_names совпадает с эталоном D1–D3', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const corpus: Array<{ title: string; synonyms: string[] }> = [
          { title: 'спроектировать новую функциональность', synonyms: ['проектиров* функциональност*', 'дизайн* нов* фич*'] },
          { title: 'Функциональность отчёта', synonyms: [] },
          { title: 'Планы проекта', synonyms: ['roadmap', 'план* работ*'] },
          { title: 'Лесной зверь', synonyms: ['ёж*'] },
          { title: 'Дизайн интерфейса', synonyms: ['вёрстка* экран*'] },
        ];
        const rows: Array<{ id: string; title_norm: string; synonyms: string[] }> = [];
        for (const entry of corpus) {
          const id = seedThought(ndb, entry.title);
          for (const synonym of entry.synonyms) seedSynonym(ndb, id, synonym);
          rows.push({
            id,
            title_norm: entry.title.normalize('NFC').toLowerCase(),
            synonyms: entry.synonyms.map((s) => s.normalize('NFC').trim().toLowerCase()),
          });
        }
        // by_names литеральная ветка — FTS-подстрока; для слов без `*` она
        // эквивалентна эталонному `includes` (см. комментарий к buildTrigramQuery).
        const queries: Array<{ q: string; include: string[]; exclude: string[] }> = [
          { q: 'функциональность', include: ['функциональность'], exclude: [] },
          { q: 'проектирование', include: ['проектирование'], exclude: [] },
          { q: 'дизайн', include: ['дизайн'], exclude: [] },
          { q: 'ёжик', include: ['ёжик'], exclude: [] },
          { q: 'роадмап roadmap', include: ['роадмап', 'roadmap'], exclude: [] },
          { q: 'функциональность -проектирование', include: ['функциональность'], exclude: ['проектирование'] },
        ];
        for (const { q, include, exclude } of queries) {
          const expected = rows
            .filter(
              (row) =>
                include.every((word) => refWordMatches(word, row.title_norm, row.synonyms)) &&
                exclude.every((word) => !refWordMatches(word, row.title_norm, row.synonyms)),
            )
            .map((row) => row.id)
            .sort();
          const collected: string[] = [];
          for (let offset = 0; ; offset += 2) {
            const page = search(ndb, { q, scope: 'names', limit: 2, offset });
            collected.push(...page.by_names.map((h) => h.thought_id));
            assert.equal(page.meta.total_in_group.names, expected.length, `total «${q}»`);
            if (offset + 2 >= page.meta.total_in_group.names) break;
          }
          assert.deepEqual(collected.sort(), expected, `страницы by_names «${q}» совпадают с эталоном`);
        }
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'wildcard-синонимы через пул reader-воркеров (SQL-функция зарегистрирована в воркере)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'etn-wildcard-pool-'));

    after(async () => {
      await closeReaderPool();
      closeAll();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('keywords и by_names через пул совпадают с синхронными (грабли 883267ea)', async () => {
      configureReaderPool({ size: 1, taskTimeoutMs: 60_000 });
      const ndb = openNetworkDb(dataDir, NETWORK_ID);
      const target = seedDoDFixture(ndb);

      const request = kw('проектирование', { count: true });
      const sync = queryThoughts(ndb, USER, request, { emptyFilterMode: 'all' });
      const viaPool = await queryThoughtsAsync(ndb, USER, request, { emptyFilterMode: 'all' });
      assert.deepEqual(viaPool.items.map((i) => i.id), [target]);
      assert.deepEqual(viaPool.items, sync.items, 'keywords через пул совпадает');
      assert.equal(viaPool.total, sync.total);

      const syncSearch = search(ndb, { q: 'проектирование', scope: 'names' });
      const viaPoolSearch = await searchAsync(ndb, { q: 'проектирование', scope: 'names' });
      assert.deepEqual(viaPoolSearch.by_names.map((h) => h.thought_id), [target]);
      assert.deepEqual(viaPoolSearch, syncSearch, 'by_names через пул совпадает');
    });
  },
);
