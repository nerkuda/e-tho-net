/**
 * Строгая семантика дедупликации `findDuplicates` (ошибка 11f14a81).
 *
 * Живое воспроизведение — сеть VZ, 2026-09-03: partial-матч трактовал каждое
 * слово ввода как фрагмент с неявными `*` и находил подстроки слов
 * («Владимир» ⊂ «Владимирович»), отдельные слова чужих названий и составных
 * синонимов, а wildcard-основа одного слова совпадала с дефисным составным
 * названием («Газпромбанк*» против «Газпромбанк-Автолизинг»).
 *
 * Здесь закреплены:
 *   * кейсы карточки на фикстуре сети VZ (типы «место», «персона», «отель»,
 *     «банк» + те же названия и синонимы);
 *   * новая семантика режима `dedupe` (по умолчанию): точное совпадение →
 *     wildcard-синоним как основа словоформы (короткое окончание, без перехода
 *     через дефис/пробел) → слабый partial (последовательность слов ввода
 *     начинает название/литеральный синоним, а не слово из середины);
 *   * правило типа: partial чужого типа отбрасывается, когда тип уже задан
 *     сильным кандидатом (или явным `typeId` из гейта записи);
 *   * `on_duplicate: reuse/update` не подхватывает ложного кандидата
 *     (грабли fe29e2f5);
 *   * режим `search` сохраняет прежнее поведение живого поиска (0.4.5).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { findDuplicates } from '../src/domain/search-service.js';
import { upsertThoughtBundle } from '../src/domain/thought-bundle-service.js';
import { listComments } from '../src/domain/comment-service.js';
import { getThoughtOrThrow } from '../src/domain/thought-service.js';

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

function seedType(ndb: NetworkDb, id: string, name: string): void {
  ndb
    .prepare(
      `INSERT INTO thought_types (id, name, name_key, version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, 1, '2024', '2024', 'u')`,
    )
    .run(id, name, name.toLowerCase());
}

/** Insert a thought row directly. */
function seedThought(
  ndb: NetworkDb,
  title: string,
  typeId: string | null = null,
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase(), typeId);
  return id;
}

/** Insert a synonym for a thought. */
function seedSynonym(ndb: NetworkDb, thoughtId: string, synonym: string): void {
  ndb
    .prepare(
      'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)',
    )
    .run(thoughtId, synonym, synonym.normalize('NFC').trim().toLowerCase());
}

/** Фикстура сети VZ: те же типы, названия и синонимы, что в карточке ошибки. */
interface VzFixture {
  city: string;
  personBeberashvili: string;
  personAlehin: string;
  personDmitrienko: string;
  hotel: string;
  bank: string;
  bankLeasing: string;
}

function seedVz(ndb: NetworkDb): VzFixture {
  seedType(ndb, 'type-place', 'место');
  seedType(ndb, 'type-person', 'персона');
  seedType(ndb, 'type-hotel', 'отель');
  seedType(ndb, 'type-bank', 'банк');

  const city = seedThought(ndb, 'Владимир (город)', 'type-place');
  for (const synonym of ['Владимир*', 'во Владимире', 'город Владимир']) {
    seedSynonym(ndb, city, synonym);
  }
  const personBeberashvili = seedThought(ndb, 'Беберашвили Владимир', 'type-person');
  seedSynonym(ndb, personBeberashvili, 'Беберашвили*');
  seedSynonym(ndb, personBeberashvili, 'Владимир* Беберашвили*');
  const personAlehin = seedThought(ndb, 'Алехин Юрий Владимирович', 'type-person');
  seedSynonym(ndb, personAlehin, 'Алехин* участковый*');
  const personDmitrienko = seedThought(ndb, 'Дмитриенко Александр Владимирович', 'type-person');
  const hotel = seedThought(ndb, 'Отель У Золотых Ворот', 'type-hotel');
  seedSynonym(ndb, hotel, 'Золотые Ворота отель Владимир*');
  seedSynonym(ndb, hotel, 'У Золотых Ворот');
  const bank = seedThought(ndb, 'Газпромбанк', 'type-bank');
  for (const synonym of ['ГПБ', 'Газпромбанк*', 'банк ГПБ']) seedSynonym(ndb, bank, synonym);
  const bankLeasing = seedThought(ndb, 'Газпромбанк-Автолизинг', 'type-bank');
  seedSynonym(ndb, bankLeasing, 'ГПБ Автолизинг');
  seedSynonym(ndb, bankLeasing, 'Газпромбанк Автолизинг');

  return {
    city,
    personBeberashvili,
    personAlehin,
    personDmitrienko,
    hotel,
    bank,
    bankLeasing,
  };
}

/** Id-набор результата + kind каждого хита. */
function kindsOf(hits: Array<{ id: string; matched_on: string }>): Record<string, string> {
  return Object.fromEntries(hits.map((hit) => [hit.id, hit.matched_on]));
}

describe(
  'findDuplicates: строгий режим dedupe (ошибка 11f14a81)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('«Владимир» находит только город по wildcard-синониму, без отчеств и отеля', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = seedVz(ndb);
        const hits = findDuplicates(ndb, 'Владимир');
        assert.deepEqual(
          hits.map((hit) => hit.id),
          [f.city],
          `ложные кандидаты: ${JSON.stringify(hits.map((h) => h.title))}`,
        );
        assert.equal(hits[0]!.matched_on, 'synonym');
        assert.equal(hits[0]!.matched_synonym, 'Владимир*');
      } finally {
        ndb.close();
      }
    });

    it('wildcard-синоним — основа словоформы: «Владимире» да, «Владимирович» нет', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = seedVz(ndb);
        assert.deepEqual(
          findDuplicates(ndb, 'Владимире').map((hit) => hit.id),
          [f.city],
          'падежная форма — та же словоформа',
        );
        assert.equal(
          findDuplicates(ndb, 'Владимирович').some((hit) => hit.id === f.city),
          false,
          'отчество — другое слово, `*` не произвольная подстрока',
        );
      } finally {
        ndb.close();
      }
    });

    it('«Газпромбанк-Автолизинг» не даёт кандидата «Газпромбанк»', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = seedVz(ndb);
        const hits = findDuplicates(ndb, 'Газпромбанк-Автолизинг');
        assert.deepEqual(
          hits.map((hit) => hit.id),
          [f.bankLeasing],
          `ложные кандидаты: ${JSON.stringify(hits.map((h) => h.title))}`,
        );
        assert.equal(hits[0]!.matched_on, 'title');
      } finally {
        ndb.close();
      }
    });

    it('дефис/пробел — граница слова: «Газпромбанк Автолизинг» — точный синоним, partial — тоже', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = seedVz(ndb);
        const hits = findDuplicates(ndb, 'Газпромбанк Автолизинг');
        const kinds = kindsOf(hits);
        assert.equal(kinds[f.bankLeasing], 'synonym', 'литеральный синоним совпал целиком');
        assert.equal(kinds[f.bank], undefined, '«Газпромбанк» не покрывает два слова ввода');
        // Пунктуация — разделитель слов: без литерального синонима то же
        // название матчится как partial последовательностью слов.
        const northwest = seedThought(ndb, 'Северо-Запад');
        assert.equal(kindsOf(findDuplicates(ndb, 'Северо Запад'))[northwest], 'partial');
      } finally {
        ndb.close();
      }
    });

    it('partial — последовательность слов с начала, а не слово из середины', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = seedVz(ndb);
        const hits = findDuplicates(ndb, 'Владимир город');
        assert.deepEqual(
          hits.map((hit) => hit.id),
          [f.city],
          'слова ввода покрывают название города целиком (скобки — пунктуация)',
        );
        assert.equal(hits[0]!.matched_on, 'partial');
        // Одно слово из середины/конца чужого названия — не кандидат.
        assert.deepEqual(findDuplicates(ndb, 'Золотых'), []);
      } finally {
        ndb.close();
      }
    });

    it('wildcard не переходит через дефис и не съедает производное слово', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const carrier = seedThought(ndb, 'Носитель');
        seedSynonym(ndb, carrier, 'Игорян*');
        seedSynonym(ndb, carrier, 'Софт*');
        assert.deepEqual(
          findDuplicates(ndb, 'Игорянский').some((hit) => hit.id === carrier),
          false,
          '«Игорянский» — производное слово, а не словоформа основы «Игорян»',
        );
        assert.equal(
          findDuplicates(ndb, 'Игоряна').some((hit) => hit.id === carrier),
          true,
          'падежная форма основы совпадает',
        );
        assert.equal(
          findDuplicates(ndb, 'Софт-сервис').some((hit) => hit.id === carrier),
          false,
          '`*` не переходит через дефис',
        );
      } finally {
        ndb.close();
      }
    });

    it('тип мысли: partial чужого типа отбрасывается, когда тип задан сильным кандидатом', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedType(ndb, 'type-task', 'задача');
        seedType(ndb, 'type-note', 'заметка');
        const exact = seedThought(ndb, 'Отчёт', 'type-task');
        const sameTypePartial = seedThought(ndb, 'Отчёт квартальный', 'type-task');
        seedThought(ndb, 'Отчёт по продажам', 'type-note');
        const kinds = kindsOf(findDuplicates(ndb, 'Отчёт'));
        assert.equal(kinds[exact], 'title');
        assert.equal(kinds[sameTypePartial], 'partial', 'partial того же типа остаётся');
        assert.deepEqual(
          findDuplicates(ndb, 'Отчёт').map((hit) => hit.title).sort(),
          [getThoughtOrThrow(ndb, exact).title, getThoughtOrThrow(ndb, sameTypePartial).title].sort(),
          'кандидат другого типа — шум, когда тип уже известен',
        );
      } finally {
        ndb.close();
      }
    });

    it('явный typeId гейта записи отсекает partial чужого типа без сильного кандидата', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedType(ndb, 'type-task', 'задача');
        seedType(ndb, 'type-note', 'заметка');
        const sameType = seedThought(ndb, 'Платежи за март', 'type-task');
        const otherType = seedThought(ndb, 'Платежи за апрель', 'type-note');
        const kinds = kindsOf(findDuplicates(ndb, 'Платежи', [], [], { typeId: 'type-task' }));
        assert.equal(kinds[sameType], 'partial');
        assert.equal(kinds[otherType], undefined);
        // Без явного типа оба partial остаются.
        assert.equal(findDuplicates(ndb, 'Платежи').length, 2);
      } finally {
        ndb.close();
      }
    });

    it('on_duplicate reuse не подхватывает ложного кандидата и не портит чужую мысль', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = seedVz(ndb);
        const bankBefore = getThoughtOrThrow(ndb, f.bank);
        // Создаём «Газпромбанк-Лизинг» заново: старая wildcard-основа
        // «Газпромбанк*» (с `\S*`) матчила дефисное составное название и
        // показывала «Газпромбанк» кандидатом. Гейт записи и раньше не
        // блокировал такой матч, но `duplicate_candidates` вводил в
        // заблуждение (грабли fe29e2f5).
        const result = upsertThoughtBundle(
          ndb,
          {
            thought: {
              title: 'Газпромбанк-Лизинг',
              type_id: 'type-bank',
            },
            on_duplicate: 'reuse',
            comment: { body_md: 'лизинговая компания группы' },
          },
          'user-1',
        );
        assert.equal(result.thought_action, 'created');
        assert.notEqual(result.thought.id, f.bank);
        // Чужая мысль не тронута: ни комментария, ни свойств.
        assert.deepEqual(getThoughtOrThrow(ndb, f.bank), bankBefore);
        assert.deepEqual(listComments(ndb, 'thought', f.bank), []);
        // Ложный кандидат не попал даже в duplicate_candidates.
        assert.deepEqual(
          (result.duplicate_candidates ?? []).map((candidate) => candidate.id),
          [],
          'дефисное название не дубль «Газпромбанк»',
        );
      } finally {
        ndb.close();
      }
    });

    it('on_duplicate update не переименовывает чужую мысль по подстрочному совпадению', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = seedVz(ndb);
        const before = getThoughtOrThrow(ndb, f.city);
        const result = upsertThoughtBundle(
          ndb,
          {
            thought: { title: 'Владимировка', type_id: 'type-place' },
            on_duplicate: 'update',
          },
          'user-1',
        );
        assert.equal(result.thought_action, 'created');
        assert.deepEqual(getThoughtOrThrow(ndb, f.city), before, 'город не переименован');
      } finally {
        ndb.close();
      }
    });

    it('режим search сохраняет прежний живой поиск (0.4.5, подстрочный кандидат)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = seedVz(ndb);
        const work = seedThought(ndb, 'Доработать отчёт');
        const searchKinds = kindsOf(findDuplicates(ndb, 'дор', [], [], { mode: 'search' }));
        assert.equal(searchKinds[work], 'partial', '«дор» → «Доработать отчёт»');
        // Подстрочное совпадение внутри чужого названия/синонима — прежний
        // кандидат живого поиска.
        const searchVladimir = kindsOf(findDuplicates(ndb, 'Владимир', [], [], { mode: 'search' }));
        assert.equal(searchVladimir[f.hotel], 'partial');
        assert.equal(searchVladimir[f.personBeberashvili], 'partial');
        assert.deepEqual(findDuplicates(ndb, 'дор'), [], 'в dedupe подстрочного кандидата нет');
      } finally {
        ndb.close();
      }
    });

    it('ответ обратно совместим: matched_on/matched_synonym той же формы', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = seedVz(ndb);
        for (const hit of findDuplicates(ndb, 'Владимир')) {
          assert.ok(['title', 'synonym', 'partial'].includes(hit.matched_on), hit.matched_on);
          assert.equal(typeof hit.id, 'string');
          assert.equal(typeof hit.title, 'string');
          assert.ok(Array.isArray(hit.synonyms));
          assert.equal(hit.type_id, f.city === hit.id ? 'type-place' : hit.type_id);
        }
      } finally {
        ndb.close();
      }
    });
  },
);
