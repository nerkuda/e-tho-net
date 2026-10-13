/**
 * Паритет конструктора ключевых слов панели «Дневника» и плоского тела хроники
 * (задача 608ecb79; требование 9e9d14dc; ADR 3301223f «keyword_scope»).
 *
 * Доказательство in-process: тело ОБЩЕГО конструктора панели
 * (`buildChronicleKeywordGroup` из `@etn/shared` — та же функция, что строит
 * дерево панели в `screens/chronicle/filter-panel.ts`) исполняется серверным
 * движком AST и обязано дать ТОТ ЖЕ набор записей, что ПРЕЖНЕЕ ПЛОСКОЕ тело
 * (`keywords` + `keyword_scope`) через `compileChronicleToAst`.
 *
 * Проверяются дефекты паритета, найденные при приёмке 3aa23268:
 *   * БЛОКЕР 1 — гейт текстового пути (тело/заголовок записи) областью
 *     `comment`: набор без `comment` путь Б выключает, пустой — включает;
 *   * БЛОКЕР 2 — пословная группировка: на КАЖДОЕ слово `ИЛИ(тело, заголовок)`,
 *     исключающие слова — `НЕ(ИЛИ(...))`, слова соединены по И (допустим
 *     «слово1 в теле, слово2 в заголовке»);
 *   * области `[]` в AST — явный список (пустой `scope` в AST ОТКЛЮЧАЕТ условие).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  buildChronicleKeywordGroup,
  FILTER_AST_VERSION,
  type FilterAstNode,
  type StructureKeywordScope,
} from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createComment, createCommentWithTargets } from '../src/domain/comment-service.js';
import { createLink } from '../src/domain/link-service.js';
import { parseChronicleQueryBody, queryChronicle } from '../src/domain/chronicle-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const USER = 'user-1';

function seedThought(ndb: NetworkDb, title: string, body = ''): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             type_id, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 0, 0, NULL, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase());
  if (body !== '') {
    createComment(ndb, 'thought', id, { kind: 'permanent', body_md: body }, USER);
  }
  return id;
}

/** Прямая вставка записи без целей (обход домена): `attach: false`. */
function rawComment(
  ndb: NetworkDb,
  opts: { title: string; body: string; valid_from: string; ownerId: string; attach: boolean },
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO comments (id, layer_id, owner_type, owner_id, kind, title, body_md, body_html,
                             valid_from, valid_to, use_time, version,
                             created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'thought', ?, 'chronological', ?, ?, ?, ?, ?, 0, 1, '2024', '2024', 'u', 'u', 0, 0)`,
    )
    .run(
      id,
      ndb.layerId,
      opts.ownerId,
      opts.title,
      opts.body,
      `<p>${opts.body}</p>`,
      opts.valid_from,
      opts.valid_from,
    );
  if (opts.attach) {
    ndb
      .prepare(
        `INSERT INTO comment_targets (id, comment_id, owner_type, owner_id) VALUES (?, ?, 'thought', ?)`,
      )
      .run(randomUUID(), id, opts.ownerId);
  }
  return id;
}

/** Запись с явным набором целей и своим телом/заголовком. */
function record(
  ndb: NetworkDb,
  targets: string[],
  opts: { title?: string; body: string; valid_from: string },
): string {
  return createCommentWithTargets(
    ndb,
    targets.map((owner_id) => ({ owner_type: 'thought' as const, owner_id })),
    {
      kind: 'chronological',
      title: opts.title ?? null,
      body_md: opts.body,
      valid_from: opts.valid_from,
    },
    USER,
  ).id;
}

/** Плоское тело (прежний путь) через компилятор. */
function runFlat(ndb: NetworkDb, keywords: string, scope: StructureKeywordScope[]): string[] {
  const request = parseChronicleQueryBody(
    { keywords, keyword_scope: scope, order: 'asc', limit: 100, offset: 0 },
    'test',
  );
  return queryChronicle(ndb, request, { userId: USER, withTime: true }).rows.map((r) => r.id);
}

/** Тело конструктора панели — прямо в серверный движок AST. */
function runGroup(ndb: NetworkDb, keywords: string, scope: StructureKeywordScope[]): string[] {
  const filter = buildChronicleKeywordGroup(keywords, scope) as FilterAstNode;
  const request = parseChronicleQueryBody(
    { ast: { version: FILTER_AST_VERSION, filter }, order: 'asc', limit: 100, offset: 0 },
    'test',
  );
  return queryChronicle(ndb, request, { userId: USER, withTime: true }).rows.map((r) => r.id);
}

describe(
  'хроника: паритет конструктора панели «Дневника» и плоского тела (608ecb79)',
  { skip: !nativeAvailable() },
  () => {
    /**
     * Общая фикстура. Ключи в словах разнесены по «носителям», чтобы различать
     * пути А/Б и области:
     *   * `alpha` — мысль-цель с постоянным комментарием «секрет» (путь А, область
     *     comment);
     *   * `bodyRec` — слово «берёзу» только в теле записи (путь Б);
     *   * `titleRec` — слово «Отпуск» только в заголовке записи (путь Б);
     *   * `crossRec` — «отпуск» в заголовке, «кофе» в теле (пословная группировка);
     *   * `orphan` — «берёзу» в теле, но БЕЗ целей (путь Б требует «цели не пусты»).
     */
    function buildFixture(ndb: NetworkDb): {
      alpha: string;
      beta: string;
      bodyRec: string;
      titleRec: string;
      crossRec: string;
      orphan: string;
    } {
      const alpha = seedThought(ndb, 'Alpha', 'секрет');
      const beta = seedThought(ndb, 'Beta');
      const bodyRec = record(ndb, [alpha], {
        body: 'заметка про берёзу',
        valid_from: '2024-01-01',
      });
      const titleRec = record(ndb, [alpha], {
        title: 'Отпуск',
        body: 'без слова',
        valid_from: '2024-01-02',
      });
      const crossRec = record(ndb, [beta], {
        title: 'Отпуск у моря',
        body: 'взяли кофе',
        valid_from: '2024-01-03',
      });
      const orphan = rawComment(ndb, {
        title: '',
        body: 'берёзу без цели',
        valid_from: '2024-01-04',
        ownerId: alpha,
        attach: false,
      });
      return { alpha, beta, bodyRec, titleRec, crossRec, orphan };
    }

    /** Наборы областей из DoD. */
    const SCOPES: StructureKeywordScope[][] = [[], ['comment'], ['title', 'synonyms']];

    it('однословный запрос: конструктор панели и плоское тело дают один набор для всех областей', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = buildFixture(ndb);

        // «берёзу» — только тело записи (путь Б).
        for (const scope of SCOPES) {
          assert.deepEqual(
            runGroup(ndb, 'берёзу', scope),
            runFlat(ndb, 'берёзу', scope),
            `слово в теле записи, области ${JSON.stringify(scope)}`,
          );
        }
        // Область без comment путь Б выключает — записи по своему телу не находятся.
        assert.deepEqual(
          runGroup(ndb, 'берёзу', ['title', 'synonyms']),
          [],
          'без comment тело записи не ищется',
        );
        // Пустой набор и comment — путь Б включён.
        assert.deepEqual(runGroup(ndb, 'берёзу', []), [f.bodyRec], 'пустой набор: путь Б включён');
        assert.deepEqual(
          runGroup(ndb, 'берёзу', ['comment']),
          [f.bodyRec],
          'comment: путь Б включён',
        );

        // «Отпуск» — только заголовок записи (путь Б).
        assert.deepEqual(
          runGroup(ndb, 'Отпуск', ['title', 'synonyms']),
          [],
          'без comment заголовок не ищется',
        );
        assert.deepEqual(
          runGroup(ndb, 'Отпуск', ['comment']),
          [f.titleRec, f.crossRec],
          'comment: заголовок записи находит обе записи',
        );

        // «секрет» — постоянный комментарий цели (путь А), тело/заголовок записей без слова.
        for (const scope of SCOPES) {
          assert.deepEqual(
            runGroup(ndb, 'секрет', scope),
            runFlat(ndb, 'секрет', scope),
            `слово в комментарии цели, области ${JSON.stringify(scope)}`,
          );
        }
        assert.deepEqual(
          runGroup(ndb, 'секрет', ['title', 'synonyms']),
          [],
          'путь А по title/synonyms не видит комментарий цели',
        );
        assert.deepEqual(
          runGroup(ndb, 'секрет', ['comment']),
          [f.bodyRec, f.titleRec],
          'путь А по comment находит цели с комментарием',
        );

        // Запись без целей путь Б не проходит («цели не пусты»).
        assert.ok(!runGroup(ndb, 'берёзу', []).includes(f.orphan), 'запись без целей отсеяна');
        assert.deepEqual(
          runFlat(ndb, 'берёзу', []),
          [f.bodyRec],
          'плоское тело тоже отсекает запись без целей',
        );
      } finally {
        ndb.close();
      }
    });

    it('БЛОКЕР 2: пословная группировка — «слово1 в заголовке, слово2 в теле» проходит', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = buildFixture(ndb);
        // Оба слова обязательны, но лежать в РАЗНЫХ местах одной записи:
        // «отпуск» — заголовок, «кофе» — тело. Старое `И(тело, заголовок)` по
        // одному значению такую запись теряло.
        const group = runGroup(ndb, 'отпуск кофе', []);
        assert.deepEqual(group, [f.crossRec], 'оба слова в разных местах записи');
        assert.deepEqual(group, runFlat(ndb, 'отпуск кофе', []), 'совпадает с плоским телом');
      } finally {
        ndb.close();
      }
    });

    it('мини-синтаксис `*` и исключающие слова: паритет с плоским телом', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = buildFixture(ndb);
        for (const scope of SCOPES) {
          assert.deepEqual(
            runGroup(ndb, 'бер*', scope),
            runFlat(ndb, 'бер*', scope),
            `звёздочка, области ${JSON.stringify(scope)}`,
          );
        }
        assert.deepEqual(runGroup(ndb, 'бер*', []), [f.bodyRec], 'звёздочка в теле записи');

        // Исключение: «отпуск» без «кофе» — crossRec отсеивается.
        for (const scope of SCOPES) {
          assert.deepEqual(
            runGroup(ndb, 'отпуск -кофе', scope),
            runFlat(ndb, 'отпуск -кофе', scope),
            `исключение, области ${JSON.stringify(scope)}`,
          );
        }
        assert.deepEqual(
          runGroup(ndb, 'отпуск -кофе', ['comment']),
          [f.titleRec],
          'исключающее слово вычитает запись',
        );
      } finally {
        ndb.close();
      }
    });

    it('БЛОКЕР 1: пустой набор областей в AST — это «все области», а не отключённое условие', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = buildFixture(ndb);
        // Мутация «опустить scope при полном наборе» (старый дефект) отключила бы
        // лист «Есть слова» пути А и вернула бы ЛИШНИЕ записи.
        const group = buildChronicleKeywordGroup('секрет', []) as FilterAstNode;
        const json = JSON.stringify(group);
        assert.match(
          json,
          /"scope":\["title","synonyms","comment"\]/,
          'области выписаны явно, а не опущены',
        );
        assert.deepEqual(
          runGroup(ndb, 'секрет', []),
          [f.bodyRec, f.titleRec],
          'пустой набор ищет в комментарии цели',
        );
      } finally {
        ndb.close();
      }
    });

    /**
     * Фикстура КОММЕНТАРИЕВ СВЯЗЕЙ (ошибка fc97548d, требование ce111b0d):
     *   * `Гамма`/`Дельта` — концы одной активной связи;
     *   * `linkPerm` — ПОСТОЯННЫЙ комментарий связи со словом `связьпост`
     *     (ни одно тело/заголовок записи его не содержит — путь Б бессилен);
     *   * `linkChrono` — хроно-запись связи со словом `связьхроно` в теле;
     *   * `linkRec` — вторая запись той же связи, ключевых слов не содержит:
     *     попадает в выдачу ТОЛЬКО через фазу 1 (обе стороны связи отобраны).
     */
    function buildLinkFixture(ndb: NetworkDb): {
      gamma: string;
      delta: string;
      link: string;
      linkRec: string;
      linkChrono: string;
    } {
      const gamma = seedThought(ndb, 'Гамма');
      const delta = seedThought(ndb, 'Дельта');
      const link = createLink(ndb, { source_id: gamma, target_id: delta }, USER).id;
      createComment(ndb, 'link', link, { kind: 'permanent', body_md: 'связьпост' }, USER);
      const onLink = (body: string, valid_from: string): string =>
        createCommentWithTargets(
          ndb,
          [{ owner_type: 'link', owner_id: link }],
          { kind: 'chronological', title: null, body_md: body, valid_from },
          USER,
        ).id;
      return {
        gamma,
        delta,
        link,
        linkChrono: onLink('связьхроно', '2024-02-01'),
        linkRec: onLink('нейтральная запись связи', '2024-02-02'),
      };
    }

    it('ошибка fc97548d: слово только в постоянном комментарии СВЯЗИ — паритет плоского и AST-путей', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = buildLinkFixture(ndb);
        // Плоский путь видит комментарии связей с обеих сторон (ce111b0d): обе
        // стороны связи отобраны, а значит отобраны и записи, привязанные к связи.
        assert.deepEqual(
          runFlat(ndb, 'связьпост', ['comment']),
          [f.linkChrono, f.linkRec],
          'плоский путь: фаза 1 по комментарию связи',
        );
        // AST-тело конструктора панели обязано дать ТОТ ЖЕ набор записей —
        // без правки оно теряло комментарий связи и возвращало пусто.
        assert.deepEqual(
          runGroup(ndb, 'связьпост', ['comment']),
          [f.linkChrono, f.linkRec],
          'AST-путь панели: паритет с плоским телом',
        );
        // Прочие области комментарии связей не ищут (паритет и там).
        for (const scope of [['title', 'synonyms'], ['diary']] as StructureKeywordScope[][]) {
          assert.deepEqual(
            runGroup(ndb, 'связьпост', scope),
            runFlat(ndb, 'связьпост', scope),
            `области ${JSON.stringify(scope)} — паритет`,
          );
          assert.deepEqual(runGroup(ndb, 'связьпост', scope), [], `области ${JSON.stringify(scope)} — пусто`);
        }
      } finally {
        ndb.close();
      }
    });

    it('ошибка fc97548d: хроно-запись связи — паритет плоского и AST-путей', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const f = buildLinkFixture(ndb);
        // Путь Б находит саму запись связи (её тело содержит слово); вторая
        // запись связи приходит только из фазы 1 — по концам связи.
        assert.deepEqual(runFlat(ndb, 'связьхроно', ['comment']), [f.linkChrono, f.linkRec]);
        assert.deepEqual(runGroup(ndb, 'связьхроно', ['comment']), [f.linkChrono, f.linkRec]);
      } finally {
        ndb.close();
      }
    });

    it('ошибка 2bc251de: область diary находит мысль по её дневниковой записи (паритет путей)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const gamma = seedThought(ndb, 'Гамма');
        const recMatch = record(ndb, [gamma], { body: 'дневникслово в записи', valid_from: '2024-03-01' });
        const recPlain = record(ndb, [gamma], { body: 'без ключевого слова', valid_from: '2024-03-02' });

        // Фаза 1 отбирает мысль по её хроно-записи, фаза 2 приводит обе записи
        // мысли; путь Б (текст записи) областью diary НЕ включается.
        assert.deepEqual(runFlat(ndb, 'дневникслово', ['diary']), [recMatch, recPlain]);
        assert.deepEqual(runGroup(ndb, 'дневникслово', ['diary']), [recMatch, recPlain]);

        // Полный набор областей и пустой тоже дают паритет (diary входит в «все»).
        for (const scope of [[], ['title', 'synonyms', 'comment', 'diary']] as StructureKeywordScope[][]) {
          assert.deepEqual(
            runGroup(ndb, 'дневникслово', scope),
            runFlat(ndb, 'дневникслово', scope),
            `области ${JSON.stringify(scope)} — паритет`,
          );
        }

        // Область diary НЕ подменяет собой области имён: слово названия по ней не
        // отбирает мысль (запись такой цели не приводится).
        assert.deepEqual(runFlat(ndb, 'гамма', ['diary']), []);
        assert.deepEqual(runGroup(ndb, 'гамма', ['diary']), []);
        assert.deepEqual(runFlat(ndb, 'дневникслово', ['title']), []);
        assert.deepEqual(runGroup(ndb, 'дневникслово', ['title']), []);
      } finally {
        ndb.close();
      }
    });
  },
);
