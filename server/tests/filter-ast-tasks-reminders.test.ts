/**
 * Листья отбора по задачам и напоминаниям (0.16.1, задача 4cfc6257; требование
 * daf152d8 «Условия отбора по задачам и напоминаниям», сущность 489c394f —
 * приписка 0.16.1).
 *
 * Проверяется резолв ТРЁХ листьев единым движком (`queryThoughts`):
 *
 *   * `tasks` — «Есть задачи»/«Нет задач»: незакрытые (`done = 0`) субъектные
 *     задачи мысли из проекции `task_rows`/`task_row_subjects`; строка видна
 *     только при видимом комментарии-источнике (та же видимость, что в панели
 *     «Задачи» — `task-service.ts`), а постоянные комментарии помеченных на
 *     удаление владельцев задач не дают (уточнение приёмки, ТП f326e6c0);
 *   * `reminders` — «Есть напоминание»/«Нет напоминания»: АКТИВНЫЕ напоминания
 *     ЗАПРОСИВШЕГО (per-user область), удалённые владельцем не считаются;
 *     субъект в корзине не даёт напоминания — как `listReminders`;
 *   * `reminder_at` — «Дата напоминания»: ЛЕНИВО вычисленное ближайшее
 *     `next_at` напоминаний запросившего (то же, что панель/индикатор;
 *     устаревшая колонка БД не используется), сравнения/период, токены дат,
 *     равенство «голой даты» = её сутки.
 *
 * Мутационные пробы (снятие ветки листа в `query-service.ts` / подмены
 * видимости строки проекции или владельца напоминаний) краснят соответствующие
 * проверки — см. хроно-запись задачи.
 *
 * Требует нативного better-sqlite3; иначе пропускается.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, FILTER_AST_VERSION, type FilterAst, type FilterAstNode } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createCommentWithTargets } from '../src/domain/comment-service.js';
import { queryThoughts, type ThoughtQueryOptions } from '../src/domain/query-service.js';
import { createReminder, removeReminder } from '../src/domain/reminder-service.js';
import { runWriteCore } from '../src/domain/write-wrapper.js';

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

const USER = 'filter-user';
const STRANGER = 'filter-stranger';

/** Часы сценария: напоминания создаются «на 2026-11-14». */
const NOW_MS = Date.parse('2026-11-14T10:00:00.000Z');

/** Завести мысль в основе. */
function seedThought(ndb: NetworkDb, title: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts
         (id, layer_id, title, title_norm, type_id, active, is_root, marked_for_deletion,
          version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, NULL, 1, 0, 0, 1, '2026-01-01T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z', ?, 0, 0)`,
    )
    .run(id, BASE_LAYER_ID, title, title.toLowerCase(), USER, USER);
  return id;
}

/**
 * Записать комментарий-источник задач через обёртку записи: хук пере-парса
 * наполняет проекцию `task_rows`/`task_row_subjects` (задача 632eca85).
 */
function writeComment(ndb: NetworkDb, ownerId: string, bodyMd: string): string {
  return runWriteCore(
    ndb,
    { networkId: ndb.networkId, userId: USER, layerId: ndb.layerId },
    () => ({
      result: createCommentWithTargets(
        ndb,
        [{ owner_type: 'thought', owner_id: ownerId }],
        { kind: 'chronological', body_md: bodyMd },
        USER,
      ).id,
    }),
  ).result;
}

/** Напоминание «каждый день» с известным первым вхождением. */
function seedReminder(
  ndb: NetworkDb,
  userId: string,
  subjectId: string,
  anchorAt = '2026-11-20T09:00:00.000Z',
  nowMs = NOW_MS,
): string {
  return createReminder(
    ndb,
    userId,
    {
      subject_type: 'thought',
      subject_id: subjectId,
      kind: 'period',
      schedule: { type: 'every_days', every: 1 },
      anchor_at: anchorAt,
    },
    nowMs,
  ).id;
}

/** Лист AST заданного операнда/оператора. */
function leaf(kind: string, operator: string, value?: unknown): FilterAst {
  const node: Record<string, unknown> = { entity: { kind }, operator };
  if (value !== undefined) node['value'] = value;
  return { version: FILTER_AST_VERSION, filter: node as unknown as FilterAstNode };
}

/** Исполнить отбор и вернуть id совпавших мыслей (отсортировано). */
function ids(
  ndb: NetworkDb,
  ast: FilterAst,
  opts: { userId?: string; tokenContext?: ThoughtQueryOptions['tokenContext'] } = {},
): string[] {
  // Часы сценария по умолчанию: next_at напоминаний считается ЛЕНИВО (доработка
  // по приёмке), поэтому без явных часов тест зависел бы от реальной даты.
  const tokenContext = opts.tokenContext ?? tokensAt(NOW_MS, opts.userId ?? USER);
  const result = queryThoughts(
    ndb,
    opts.userId ?? USER,
    { sort: 'alpha', order: 'asc', limit: 100, offset: 0, ast },
    { emptyFilterMode: 'all', maxLimit: 200, tokenContext },
  );
  return result.items.map((item) => item.id).sort();
}

/** Контекст токенов: часы сценария, владелец ключа, профиль без времени. */
function tokensAt(nowMs: number, userId = USER): ThoughtQueryOptions['tokenContext'] {
  return { nowMs, userId, firstDayOfWeek: 1, withTime: false };
}

describe(
  'листья отбора по задачам и напоминаниям (4cfc6257, daf152d8)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('«Есть задачи»: незакрытая субъектная задача; «Нет задач» — дополнение', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const subject = seedThought(ndb, 'Субъект с задачей');
        const owner = seedThought(ndb, 'Владелец комментария');
        const empty = seedThought(ndb, 'Без задач');
        // Задача лежит в комментарии ВЛАДЕЛЬЦА, но субъект — `subject`.
        writeComment(ndb, owner, `- [ ] Задача [[#${subject}]] [[2026-11-20]]`);

        assert.deepEqual(ids(ndb, leaf('tasks', 'not_empty')), [subject].sort());
        assert.deepEqual(ids(ndb, leaf('tasks', 'is_empty')), [empty, owner].sort());
        // `eq`/`ne` с boolean — та же семантика (триада «да/нет» реестра).
        assert.deepEqual(ids(ndb, leaf('tasks', 'eq', true)), [subject].sort());
        assert.deepEqual(ids(ndb, leaf('tasks', 'eq', false)), [empty, owner].sort());
      } finally {
        ndb.close();
      }
    });

    it('«Есть задачи»: закрытая задача не считается, постоянный комментарий — считается', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const done = seedThought(ndb, 'Только выполненная');
        const permanent = seedThought(ndb, 'Задача в постоянном комментарии');
        const carrierOne = seedThought(ndb, 'Носитель 1');
        const carrierTwo = seedThought(ndb, 'Носитель 2');
        // Выполненная задача (чекбокс `[x]`) задачей НЕ считается.
        writeComment(ndb, carrierOne, `- [x] Готово [[#${done}]]`);
        // Постоянный комментарий тоже источник задач (kind в проекции не фильтруется).
        runWriteCore(ndb, { networkId: ndb.networkId, userId: USER, layerId: ndb.layerId }, () => ({
          result: createCommentWithTargets(
            ndb,
            [{ owner_type: 'thought', owner_id: carrierTwo }],
            { kind: 'permanent', body_md: `- [ ] Открытая [[#${permanent}]]` },
            USER,
          ).id,
        }));
        assert.deepEqual(ids(ndb, leaf('tasks', 'not_empty')), [permanent].sort());
      } finally {
        ndb.close();
      }
    });

    it('«Есть задачи»: строка проекции невидимого комментария не считается', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const subject = seedThought(ndb, 'Субъект');
        // Проекция ссылается на несуществующий комментарий — строки не видно
        // (видимость строки задачи = видимость её комментария).
        const ghost = randomUUID();
        ndb
          .prepare(
            `INSERT INTO task_rows
               (comment_id, layer_id, line_no, is_task, text, done, depth, subtask, parsed_revision)
             VALUES (?, NULL, 0, 1, 'призрак', 0, 0, 0, 1)`,
          )
          .run(ghost);
        ndb
          .prepare(
            'INSERT INTO task_row_subjects (comment_id, layer_id, line_no, thought_id) VALUES (?, NULL, 0, ?)',
          )
          .run(ghost, subject);

        assert.deepEqual(ids(ndb, leaf('tasks', 'not_empty')), []);
        assert.deepEqual(ids(ndb, leaf('tasks', 'is_empty')), [subject].sort());
      } finally {
        ndb.close();
      }
    });

    it('«Есть напоминание»: per-user область и удалённые не считаются', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const mine = seedThought(ndb, 'Моё напоминание');
        const foreign = seedThought(ndb, 'Чужое напоминание');
        const removed = seedThought(ndb, 'Удалённое напоминание');
        seedReminder(ndb, USER, mine);
        seedReminder(ndb, STRANGER, foreign);
        const removedId = seedReminder(ndb, USER, removed);
        removeReminder(ndb, USER, removedId);

        // Запросивший видит только СВОИ активные напоминания.
        assert.deepEqual(ids(ndb, leaf('reminders', 'not_empty')), [mine].sort());
        assert.deepEqual(ids(ndb, leaf('reminders', 'is_empty')), [foreign, removed].sort());

        // Другой участник сети — своя проекция: чужое напоминание не видно.
        assert.deepEqual(
          ids(ndb, leaf('reminders', 'not_empty'), { userId: STRANGER }),
          [foreign].sort(),
        );
      } finally {
        ndb.close();
      }
    });

    it('«Дата напоминания»: сравнения и период по ближайшему next_at', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const onDay = seedThought(ndb, 'На двадцатое');
        const later = seedThought(ndb, 'На двадцать первое');
        const none = seedThought(ndb, 'Без напоминания');
        seedReminder(ndb, USER, onDay, '2026-11-20T09:00:00.000Z');
        seedReminder(ndb, USER, later, '2026-11-21T09:00:00.000Z');

        // «Равно» голой дате = её СУТКИ (паритет с датами создания/изменения).
        assert.deepEqual(ids(ndb, leaf('reminder_at', 'eq', '2026-11-20')), [onDay].sort());
        assert.deepEqual(ids(ndb, leaf('reminder_at', 'ne', '2026-11-20')), [later].sort());
        assert.deepEqual(ids(ndb, leaf('reminder_at', 'gte', '2026-11-21')), [later].sort());
        assert.deepEqual(ids(ndb, leaf('reminder_at', 'lt', '2026-11-21')), [onDay].sort());
        assert.deepEqual(
          ids(ndb, leaf('reminder_at', 'between', ['2026-11-20', '2026-11-20'])),
          [onDay].sort(),
        );
        assert.deepEqual(
          ids(ndb, leaf('reminder_at', 'between', ['2026-11-20', '2026-11-21'])),
          [onDay, later].sort(),
        );
        assert.deepEqual(
          ids(ndb, leaf('reminder_at', 'not_between', ['2026-11-20', '2026-11-21'])),
          [],
        );
        // Без напоминания даты нет — ни одно сравнение не проходит.
        assert.ok(!ids(ndb, leaf('reminder_at', 'gte', '2000-01-01')).includes(none));
      } finally {
        ndb.close();
      }
    });

    it('«Дата напоминания»: календарные токены и per-user область', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const today = seedThought(ndb, 'Сегодня');
        const tomorrow = seedThought(ndb, 'Завтра');
        const strangerOnly = seedThought(ndb, 'Напоминание чужого');
        seedReminder(ndb, USER, today, '2026-11-20T09:00:00.000Z');
        seedReminder(ndb, USER, tomorrow, '2026-11-21T09:00:00.000Z');
        seedReminder(ndb, STRANGER, strangerOnly, '2026-11-20T12:00:00.000Z');

        const ctx = tokensAt(Date.parse('2026-11-20T08:00:00.000Z'));
        assert.deepEqual(
          ids(ndb, leaf('reminder_at', 'eq', { token: '$today' }), { tokenContext: ctx }),
          [today].sort(),
        );
        assert.deepEqual(
          ids(ndb, leaf('reminder_at', 'lte', { token: '$today' }), { tokenContext: ctx }),
          [today].sort(),
          'включительная верхняя граница-«голая дата» — до конца суток UTC',
        );
        // Строгая нижняя граница-«голая дата» — лексикографическое сравнение:
        // значение со временем того же дня БОЛЬШЕ начала суток (паритет с датами
        // создания/изменения), поэтому «после дня» задаётся полным инстансом.
        assert.deepEqual(
          ids(ndb, leaf('reminder_at', 'gt', '2026-11-20T10:00:00.000Z'), { tokenContext: ctx }),
          [tomorrow].sort(),
        );
        // Чужое напоминание в выдачу запросившего не попадает.
        assert.ok(
          !ids(ndb, leaf('reminder_at', 'gte', '2000-01-01')).includes(strangerOnly),
          'напоминания другого участника не учитываются',
        );
      } finally {
        ndb.close();
      }
    });

    it('«Есть задачи»: постоянный комментарий помеченного на удаление владельца не считается', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const subject = seedThought(ndb, 'Субъект');
        const trashedOwner = seedThought(ndb, 'Владелец в корзине');
        runWriteCore(
          ndb,
          { networkId: ndb.networkId, userId: USER, layerId: ndb.layerId },
          () => ({
            result: createCommentWithTargets(
              ndb,
              [{ owner_type: 'thought', owner_id: trashedOwner }],
              { kind: 'permanent', body_md: `- [ ] Задача [[#${subject}]]` },
              USER,
            ).id,
          }),
        );
        ndb.prepare('UPDATE thoughts SET marked_for_deletion = 1 WHERE id = ?').run(trashedOwner);

        assert.deepEqual(ids(ndb, leaf('tasks', 'not_empty')), []);
        assert.deepEqual(ids(ndb, leaf('tasks', 'is_empty')), [subject, trashedOwner].sort());
      } finally {
        ndb.close();
      }
    });

    it('«Дата напоминания»: next_at считается лениво, устаревшая колонка БД не используется', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const subject = seedThought(ndb, 'Давнее ежедневное');
        // Создано 2026-11-01: в БД зафиксировано первое вхождение 2026-11-02.
        const reminderId = seedReminder(
          ndb,
          USER,
          subject,
          '2026-11-01T09:00:00.000Z',
          Date.parse('2026-11-01T10:00:00.000Z'),
        );
        const stored = ndb
          .prepare('SELECT next_at FROM reminders WHERE id = ?')
          .get(reminderId) as { next_at: string };
        assert.equal(stored.next_at, '2026-11-02T09:00:00.000Z', 'колонка БД устарела');

        // Панель на 2026-11-14 отдаёт следующее вхождение 15-го — условие видит его же.
        assert.deepEqual(ids(ndb, leaf('reminder_at', 'eq', '2026-11-15')), [subject].sort());
        // Устаревшее значение из колонки не матчится.
        assert.deepEqual(ids(ndb, leaf('reminder_at', 'eq', '2026-11-02')), []);
      } finally {
        ndb.close();
      }
    });

    it('напоминания субъекта в корзине не учитываются (reminders и reminder_at)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const live = seedThought(ndb, 'Живая');
        const trashed = seedThought(ndb, 'В корзине');
        seedReminder(ndb, USER, live, '2026-11-20T09:00:00.000Z');
        seedReminder(ndb, USER, trashed, '2026-11-20T09:00:00.000Z');
        ndb.prepare('UPDATE thoughts SET marked_for_deletion = 1 WHERE id = ?').run(trashed);

        assert.deepEqual(ids(ndb, leaf('reminders', 'not_empty')), [live].sort());
        assert.deepEqual(ids(ndb, leaf('reminders', 'is_empty')), [trashed].sort());
        assert.deepEqual(
          ids(ndb, leaf('reminder_at', 'gte', '2000-01-01')),
          [live].sort(),
          'дата напоминания субъекта в корзине не участвует',
        );
      } finally {
        ndb.close();
      }
    });

    it('лист отвергает оператор вне набора реестра (молчаливого игнора нет)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Мысль');
        assert.throws(() => ids(ndb, leaf('tasks', 'contains', 'x')));
        assert.throws(() => ids(ndb, leaf('reminders', 'in', [randomUUID()])));
        assert.throws(() => ids(ndb, leaf('reminder_at', 'contains', '2026-11-20')));
      } finally {
        ndb.close();
      }
    });
  },
);
