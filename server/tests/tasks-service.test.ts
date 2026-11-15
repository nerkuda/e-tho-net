/**
 * Выборка и правка задач (0.16.1, задача 632eca85; операции e6d65f51 /
 * de4cee18) на уровне домена.
 *
 * Проверяются scope-секции (overdue/undated — сквозные), keyset-курсор без
 * дублей, COUNT только по флагу, фильтры thought_id/comment_id, состояния
 * субъектов и исключение постоянных комментариев помеченных на удаление;
 * правка: toggle/move/cancel/set_due/undate, expected_revision → 409, единый
 * сдвиг всех date-ссылок строки и нормализация 31-го, массовые команды
 * (включая «Сделать бессрочными», ошибка 3cef7466).
 *
 * Требует нативного better-sqlite3; иначе пропускается.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, EtnError } from '@etn/shared';
import { removeTaskLineDates } from '@etn/markdown';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createCommentWithTargets } from '../src/domain/comment-service.js';
import {
  applyTaskMassCommand,
  applyTaskOps,
  listTasks,
  setTaskLineDue,
  shiftIsoDate,
  shiftTaskLineDates,
} from '../src/domain/task-service.js';
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

const USER = 'task-test-user';
const TODAY = '2026-11-14';

/** Запись через обёртку домена: хук пере-парса срабатывает после коммита. */
function write<T>(ndb: NetworkDb, fn: () => T): T {
  return runWriteCore(
    ndb,
    { networkId: ndb.networkId, userId: USER, layerId: ndb.layerId },
    () => ({
      result: fn(),
    }),
  ).result;
}

/** Завести мысль-владельца (`active`/`marked` — состояние для subject_state). */
function seedThought(
  ndb: NetworkDb,
  id: string,
  title: string,
  opts: { active?: boolean; marked?: boolean } = {},
): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts
         (id, layer_id, title, title_norm, type_id, active, is_root, marked_for_deletion,
          version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, NULL, ?, 0, ?, 1, ?, ?, ?, ?, 0, 0)`,
    )
    .run(
      id,
      BASE_LAYER_ID,
      title,
      title.toLowerCase(),
      opts.active === false ? 0 : 1,
      opts.marked === true ? 1 : 0,
      now,
      USER,
      now,
      USER,
    );
}

/** Создать комментарий-источник задач. */
function createTaskComment(
  ndb: NetworkDb,
  thoughtId: string,
  bodyMd: string,
  kind: 'chronological' | 'permanent' = 'chronological',
): string {
  return write(
    ndb,
    () =>
      createCommentWithTargets(
        ndb,
        [{ owner_type: 'thought', owner_id: thoughtId }],
        { kind, body_md: bodyMd },
        USER,
      ).id,
  );
}

describe(
  'задачи: выборка и правка (632eca85)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('scope open/done и count только по флагу', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const openId = createTaskComment(ndb, 't-1', '- [ ] Открытая [[2026-11-20]]');
        const doneId = createTaskComment(ndb, 't-1', '- [x] Готовая [[2026-11-21]]');

        const all = listTasks(ndb);
        assert.equal(all.items.length, 2);
        assert.equal(all.total, undefined, 'COUNT без флага не считается');
        assert.equal(all.items[0]!.done, false);

        const open = listTasks(ndb, { scope: 'open' });
        assert.deepEqual(
          open.items.map((task) => task.comment_id),
          [openId],
        );
        const done = listTasks(ndb, { scope: 'done' });
        assert.deepEqual(
          done.items.map((task) => task.comment_id),
          [doneId],
        );

        const counted = listTasks(ndb, { scope: 'open', count: true });
        assert.equal(counted.total, 1);
      } finally {
        ndb.close();
      }
    });

    it('overdue и undated — сквозные секции: from/to игнорируются', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const overdueId = createTaskComment(ndb, 't-1', '- [ ] Просрочено [[2026-11-13]]');
        const undatedId = createTaskComment(ndb, 't-1', '- [ ] Без даты');
        createTaskComment(ndb, 't-1', '- [ ] Будущее [[2026-12-01]]');

        const overdue = listTasks(ndb, {
          scope: 'overdue',
          today: TODAY,
          from: '2030-01-01',
          to: '2030-01-02',
        });
        assert.deepEqual(
          overdue.items.map((task) => task.comment_id),
          [overdueId],
        );
        const undated = listTasks(ndb, {
          scope: 'undated',
          from: '2030-01-01',
          to: '2030-01-02',
        });
        assert.deepEqual(
          undated.items.map((task) => task.comment_id),
          [undatedId],
        );
        // «Сегодня» даёт клиент (требование fcdcd75f): без границы просрочка не
        // вычисляется вовсе — сервер не подставляет свои UTC-сутки.
        assert.throws(
          () => listTasks(ndb, { scope: 'overdue' }),
          (err: unknown) => err instanceof EtnError && err.code === 'BAD_REQUEST',
          'scope=overdue без today — ошибка входа',
        );
        assert.throws(
          () =>
            applyTaskMassCommand(
              ndb,
              { action: 'move-all', filter: { scope: 'overdue' }, days: 1 },
              USER,
            ),
          (err: unknown) => err instanceof EtnError && err.code === 'BAD_REQUEST',
          'массовая команда по просрочке без today — ошибка входа',
        );
      } finally {
        ndb.close();
      }
    });

    it('keyset-обход отдаёт все строки по порядку due→period_from→id без дублей', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        createTaskComment(ndb, 't-1', '- [ ] C [[2026-11-22]]');
        createTaskComment(ndb, 't-1', '- [ ] A [[2026-11-20]]');
        createTaskComment(ndb, 't-1', '- [ ] B [[2026-11-21]]');
        createTaskComment(ndb, 't-1', '- [ ] Без срока');

        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const page: ReturnType<typeof listTasks> = listTasks(ndb, {
            scope: 'open',
            limit: 2,
            ...(cursor === null ? {} : { cursor }),
          });
          assert.ok(page.items.length <= 2);
          seen.push(...page.items.map((task) => task.text));
          cursor = page.cursor;
        } while (cursor !== null);

        assert.deepEqual(seen, [
          'A [[2026-11-20]]',
          'B [[2026-11-21]]',
          'C [[2026-11-22]]',
          'Без срока',
        ]);
        assert.equal(new Set(seen).size, seen.length, 'дублей между страницами нет');
      } finally {
        ndb.close();
      }
    });

    it('фильтры comment_id и thought_id (ID-ссылки строки)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const subjectId = '33333333-3333-4333-8333-333333333333';
        seedThought(ndb, subjectId, 'Субъект');
        const linked = createTaskComment(
          ndb,
          't-1',
          `- [ ] Связано [[#${subjectId}]] [[2026-11-20]]`,
        );
        createTaskComment(ndb, 't-1', '- [ ] Без ссылки [[2026-11-21]]');

        assert.deepEqual(
          listTasks(ndb, { commentId: linked }).items.map((task) => task.comment_id),
          [linked],
        );
        const bySubject = listTasks(ndb, { thoughtId: subjectId });
        assert.deepEqual(
          bySubject.items.map((task) => task.comment_id),
          [linked],
        );
        assert.deepEqual(bySubject.items[0]!.subject_thoughts, [subjectId]);
        assert.equal(bySubject.items[0]!.subject_state, 'active');
      } finally {
        ndb.close();
      }
    });

    it('subject_state = inactive, если субъект неактуален; корзинный владелец исключает постоянный комментарий', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const inactiveId = '44444444-4444-4444-8444-444444444444';
        seedThought(ndb, inactiveId, 'Неактуальный', { active: false });
        createTaskComment(ndb, 't-1', `- [ ] С неактивным [[#${inactiveId}]] [[2026-11-20]]`);

        const page = listTasks(ndb, { scope: 'open' });
        assert.equal(page.items[0]!.subject_state, 'inactive');

        seedThought(ndb, 't-2', 'В корзине', { marked: true });
        createTaskComment(ndb, 't-2', '- [ ] Из постоянного [[2026-11-21]]', 'permanent');
        const afterTrash = listTasks(ndb, { scope: 'open' });
        assert.deepEqual(
          afterTrash.items.map((task) => task.text),
          ['С неактивным [[#44444444-4444-4444-8444-444444444444]] [[2026-11-20]]'],
          'задача постоянного комментария помеченной на удаление мысли не выдаётся',
        );
      } finally {
        ndb.close();
      }
    });

    it('toggle в постоянном комментарии пишет новую ревизию и пере-парсит строку', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const commentId = createTaskComment(
          ndb,
          't-1',
          '- [ ] Постоянная задача [[2026-11-20]]',
          'permanent',
        );

        const result = write(ndb, () =>
          applyTaskOps(
            ndb,
            [{ comment_id: commentId, line_no: 0, action: 'toggle', expected_revision: 1 }],
            USER,
          ),
        );
        assert.deepEqual(result.results, [{ comment_id: commentId, line_no: 0, ok: true }]);
        assert.equal(result.revisions[0]!.version, 2);
        assert.equal(result.revisions[0]!.body_md, '- [x] Постоянная задача [[2026-11-20]]');
        const page = listTasks(ndb, { scope: 'done' });
        assert.equal(page.items.length, 1);
        assert.equal(page.items[0]!.done, true);
      } finally {
        ndb.close();
      }
    });

    it('несовпадение expected_revision — VERSION_CONFLICT (409)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const commentId = createTaskComment(ndb, 't-1', '- [ ] Задача [[2026-11-20]]');
        assert.throws(
          () =>
            write(ndb, () =>
              applyTaskOps(
                ndb,
                [{ comment_id: commentId, line_no: 0, action: 'toggle', expected_revision: 7 }],
                USER,
              ),
            ),
          (err: unknown) => err instanceof EtnError && err.code === 'VERSION_CONFLICT',
        );
      } finally {
        ndb.close();
      }
    });

    it('строка содержимого с маркером на отдельной строке правится по line_no', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const commentId = createTaskComment(ndb, 't-1', '-\n  [ ] Текст [[2026-11-20]]');
        write(ndb, () =>
          applyTaskOps(
            ndb,
            [{ comment_id: commentId, line_no: 1, action: 'toggle', expected_revision: 1 }],
            USER,
          ),
        );
        const page = listTasks(ndb, { scope: 'done' });
        assert.deepEqual(
          page.items.map((task) => [task.line_no, task.done]),
          [[1, true]],
        );
      } finally {
        ndb.close();
      }
    });

    it('move: единый сдвиг всех date-ссылок строки и нормализация 31-го', () => {
      assert.equal(shiftIsoDate('2026-01-31', { months: 1 }), '2026-02-28');
      assert.equal(shiftIsoDate('2024-01-31', { months: 1 }), '2024-02-29');
      assert.equal(shiftIsoDate('2026-01-30', { months: 1 }), '2026-02-28');
      assert.equal(shiftIsoDate('2026-11-14', { days: 3 }), '2026-11-17');
      assert.equal(
        shiftTaskLineDates('- [ ] Задача [[2026-01-30]] — [[2026-01-31 10:00]]', { months: 1 }),
        '- [ ] Задача [[2026-02-28]] — [[2026-02-28 10:00]]',
      );
      // Грамматика — только @etn/markdown: `T` в цели date-ссылкой не является
      // (legacy-ссылка по имени), inline-code датой не считается, у ссылки с
      // алиасом меняется только дата.
      assert.equal(
        shiftTaskLineDates('- [ ] [[2026-11-20]] и [[2026-01-05T10:00]] и `[[2026-12-01]]`', {
          days: 1,
        }),
        '- [ ] [[2026-11-21]] и [[2026-01-05T10:00]] и `[[2026-12-01]]`',
      );
      assert.equal(
        shiftTaskLineDates('- [ ] [[2026-11-20|созвон]]', { days: 1 }),
        '- [ ] [[2026-11-21|созвон]]',
      );
      assert.equal(
        shiftTaskLineDates('- [ ] `[[2026-12-01]]`', { days: 1 }),
        null,
        'date-ссылка внутри inline-code не сдвигается',
      );

      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const commentId = createTaskComment(
          ndb,
          't-1',
          '- [ ] Период [[2026-01-30]] [[2026-01-31]]',
        );
        write(ndb, () =>
          applyTaskOps(
            ndb,
            [
              {
                comment_id: commentId,
                line_no: 0,
                action: 'move',
                months: 1,
                expected_revision: 1,
              },
            ],
            USER,
          ),
        );
        const page = listTasks(ndb, { scope: 'open' });
        assert.equal(page.items[0]!.period_from, '2026-02-28');
        assert.equal(
          page.items[0]!.due,
          '2026-02-28',
          '31-е нормализуется к последнему дню месяца',
        );
      } finally {
        ndb.close();
      }
    });

    it('move без даты — ok:false undated; cancel снимает маркер', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const undatedId = createTaskComment(ndb, 't-1', '- [ ] Без даты');
        const datedId = createTaskComment(ndb, 't-1', '- [ ] С датой [[2026-11-20]]');

        const moved = write(ndb, () =>
          applyTaskOps(
            ndb,
            [{ comment_id: undatedId, line_no: 0, action: 'move', days: 1, expected_revision: 1 }],
            USER,
          ),
        );
        assert.deepEqual(moved.results, [
          { comment_id: undatedId, line_no: 0, ok: false, error: 'undated' },
        ]);

        const cancelled = write(ndb, () =>
          applyTaskOps(
            ndb,
            [{ comment_id: datedId, line_no: 0, action: 'cancel', expected_revision: 1 }],
            USER,
          ),
        );
        assert.equal(cancelled.revisions[0]!.body_md, '- С датой [[2026-11-20]]');
        assert.equal(listTasks(ndb, { scope: 'open' }).items.length, 1);
      } finally {
        ndb.close();
      }
    });

    it('set_due: бессрочная строка получает date-ссылку, срок строки встаёт на выбранную дату', () => {
      // Ошибка 3f9ea2ee: «Перенести на дату» для задачи без срока задаёт срок.
      assert.equal(
        setTaskLineDue('- [ ] Задача', '2026-11-20'),
        '- [ ] Задача [[2026-11-20]]',
        'дат нет — ссылка добавляется в конец текста строки',
      );
      assert.equal(
        setTaskLineDue('- [ ] Период [[2026-11-10]] [[2026-11-12]]', '2026-11-20'),
        '- [ ] Период [[2026-11-18]] [[2026-11-20]]',
        'срок — последняя ссылка, период сохраняется (единый сдвиг)',
      );
      assert.equal(
        setTaskLineDue('- [ ] Срок [[2026-11-20 09:00]]', '2026-11-22'),
        '- [ ] Срок [[2026-11-22 09:00]]',
        'время ссылки сохраняется',
      );
      assert.equal(
        setTaskLineDue('- [ ] Срок [[2026-11-20]]', '2026-11-20'),
        null,
        'выбранная дата равна сроку — двигать нечего',
      );
      assert.equal(setTaskLineDue('- Пункт без маркера', '2026-11-20'), null, 'строка не задача');

      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const undatedId = createTaskComment(ndb, 't-1', '- [ ] Без срока');
        const result = write(ndb, () =>
          applyTaskOps(
            ndb,
            [
              {
                comment_id: undatedId,
                line_no: 0,
                action: 'set_due',
                date: '2026-11-20',
                expected_revision: 1,
              },
            ],
            USER,
          ),
        );
        assert.deepEqual(result.results, [{ comment_id: undatedId, line_no: 0, ok: true }]);
        assert.equal(result.revisions[0]!.body_md, '- [ ] Без срока [[2026-11-20]]');
        const page = listTasks(ndb, { scope: 'open', from: '2026-11-20', to: '2026-11-20' });
        assert.deepEqual(
          page.items.map((task) => [task.comment_id, task.due]),
          [[undatedId, '2026-11-20']],
          'задача появилась в отборе по выбранной дате',
        );
        assert.equal(
          listTasks(ndb, { scope: 'undated' }).items.length,
          0,
          'из «Без срока» строка ушла',
        );
      } finally {
        ndb.close();
      }
    });

    it('undate: все date-ссылки строки удаляются, задача уходит в «Без срока»', () => {
      // Ошибка 3cef7466: команда «Сделать бессрочной».
      assert.equal(
        removeTaskLineDates('- [ ] Период [[2026-11-10]] — [[2026-11-12]]'),
        '- [ ] Период —',
        'удаляются все ссылки, разделитель-пробел уходит вместе с ними',
      );
      assert.equal(
        removeTaskLineDates('- [ ] `[[2026-11-10]]`'),
        null,
        'inline-code date-ссылкой не является',
      );
      assert.equal(
        removeTaskLineDates('- [ ] [[2026-01-05T10:00]]'),
        null,
        'legacy-ссылка по имени — не date-ссылка',
      );

      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const commentId = createTaskComment(
          ndb,
          't-1',
          ['- [ ] Задача [[2026-11-10]] [[2026-11-12]]', '- [ ] Вторая [[2026-11-13]]'].join('\n'),
        );
        const result = write(ndb, () =>
          applyTaskOps(
            ndb,
            [{ comment_id: commentId, line_no: 0, action: 'undate', expected_revision: 1 }],
            USER,
          ),
        );
        assert.deepEqual(result.results, [{ comment_id: commentId, line_no: 0, ok: true }]);
        assert.equal(
          result.revisions[0]!.body_md,
          '- [ ] Задача\n- [ ] Вторая [[2026-11-13]]',
          'даты удалены только у адресованной строки',
        );
        const undated = listTasks(ndb, { scope: 'undated' });
        assert.deepEqual(
          undated.items.map((task) => [task.line_no, task.period_from, task.due]),
          [[0, null, null]],
          'период и срок очищены — строка в «Без срока»',
        );

        const again = write(ndb, () =>
          applyTaskOps(
            ndb,
            [
              {
                comment_id: commentId,
                line_no: 0,
                action: 'undate',
                expected_revision: result.revisions[0]!.version,
              },
            ],
            USER,
          ),
        );
        assert.deepEqual(
          again.results,
          [{ comment_id: commentId, line_no: 0, ok: true }],
          'уже бессрочная строка — успешный no-op',
        );
        assert.equal(again.changed.length, 0, 'новая ревизия не пишется');
      } finally {
        ndb.close();
      }
    });

    it('массовая undate-all снимает даты у всех выбранных невыполненных строк', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        createTaskComment(
          ndb,
          't-1',
          ['- [ ] Первая [[2026-11-14]]', '- [ ] Вторая [[2026-11-15]]', '- [ ] Третья'].join('\n'),
        );
        const outsideId = createTaskComment(ndb, 't-1', '- [ ] Вне периода [[2026-12-01]]');

        const result = write(ndb, () =>
          applyTaskMassCommand(
            ndb,
            {
              action: 'undate-all',
              filter: { scope: 'open', from: '2026-11-14', to: '2026-11-20' },
            },
            USER,
          ),
        );
        assert.ok(
          result.results.every((entry) => entry.ok),
          'строки без дат — успешный no-op, ошибок нет',
        );
        const undated = listTasks(ndb, { scope: 'undated' });
        assert.deepEqual(
          undated.items.map((task) => task.text).sort(),
          ['Вторая', 'Первая', 'Третья'],
          'все строки периода стали бессрочными',
        );
        const openOutside = listTasks(ndb, { scope: 'open' }).items.find(
          (task) => task.comment_id === outsideId,
        );
        assert.equal(openOutside?.due, '2026-12-01', 'строка вне периода не тронута');
      } finally {
        ndb.close();
      }
    });

    it('массовые cancel-all и move-all: подзадачи снимаются, бездатные пропускаются', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const commentId = createTaskComment(
          ndb,
          't-1',
          [
            '- [ ] Родитель [[2026-11-20]]',
            '  - [ ] подпункт',
            '    - [ ] ребёнок [[2026-11-21]]',
            '- [ ] Без даты',
          ].join('\n'),
        );

        const moved = write(ndb, () =>
          applyTaskMassCommand(
            ndb,
            { action: 'move-all', filter: { scope: 'open' }, days: 1 },
            USER,
          ),
        );
        const failed = moved.results.filter((result) => !result.ok);
        assert.deepEqual(
          failed.map((result) => [result.line_no, result.error]),
          [[3, 'undated']],
          'строка без даты пропускается',
        );

        const cancelled = write(ndb, () =>
          applyTaskMassCommand(
            ndb,
            { action: 'cancel-all', filter: { comment_id: commentId } },
            USER,
          ),
        );
        assert.ok(
          cancelled.results.every((result) => result.ok),
          'отмена снимает маркеры задач и подпунктов',
        );
        assert.equal(listTasks(ndb, { scope: 'open' }).items.length, 0);
        const body = cancelled.revisions[0]!.body_md;
        assert.ok(!body.includes('[ ]'), 'маркеров задач в тексте не осталось');
      } finally {
        ndb.close();
      }
    });

    it('массовая команда в периоде не трогает задачи вне периода', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const insideId = createTaskComment(ndb, 't-1', '- [ ] В периоде [[2026-11-15]]');
        const outsideId = createTaskComment(ndb, 't-1', '- [ ] Вне периода [[2026-12-01]]');

        const cancelled = write(ndb, () =>
          applyTaskMassCommand(
            ndb,
            {
              action: 'cancel-all',
              filter: { scope: 'open', from: '2026-11-14', to: '2026-11-20' },
            },
            USER,
          ),
        );

        assert.equal(cancelled.revisions.length, 1, 'изменена одна запись — только в периоде');
        assert.equal(cancelled.changed[0]!.id, insideId);
        const remaining = listTasks(ndb, { scope: 'open' });
        assert.deepEqual(
          remaining.items.map((task) => task.comment_id),
          [outsideId],
          'задача вне периода осталась открытой',
        );
      } finally {
        ndb.close();
      }
    });
  },
);
