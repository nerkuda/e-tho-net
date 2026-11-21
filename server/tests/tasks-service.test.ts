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
import { createLink, updateLink } from '../src/domain/link-service.js';
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

/**
 * Комментарий-источник задач с явной датой записи: автопериод (уточнение
 * 2026-11-16) делает период записи периодом задачи без дат, поэтому тестам о
 * «Без срока» и просрочке нужен постоянный комментарий, а тестам о записях —
 * управляемая дата записи.
 */
function createDatedComment(
  ndb: NetworkDb,
  thoughtId: string,
  bodyMd: string,
  validFrom: string,
  validTo?: string,
): string {
  return write(
    ndb,
    () =>
      createCommentWithTargets(
        ndb,
        [{ owner_type: 'thought', owner_id: thoughtId }],
        {
          kind: 'chronological',
          body_md: bodyMd,
          valid_from: validFrom,
          ...(validTo === undefined ? {} : { valid_to: validTo }),
        },
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
        seedThought(ndb, 't-undated', 'Мысль без срока');
        const overdueId = createTaskComment(ndb, 't-1', '- [ ] Просрочено [[2026-11-13]]');
        // «Без срока» — только у постоянного комментария: строка хроно-записи
        // получает период записи (автопериод, уточнение 2026-11-16).
        const undatedId = createTaskComment(ndb, 't-undated', '- [ ] Без даты', 'permanent');
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

    it('некалендарные from/to/today — VALIDATION_ERROR (ошибка 47600057)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        createTaskComment(ndb, 't-1', '- [ ] Задача [[2026-11-20]]');
        // Форма `YYYY-MM-DD` верна, но дат 13-го месяца и 45-го дня не
        // существует: раньше значение уходило в SQL-сравнение и молча давало
        // пустую или произвольную выборку.
        const cases: Array<[string, Parameters<typeof listTasks>[1]]> = [
          ['from', { from: '2026-13-45' }],
          ['to', { to: '2026-13-45' }],
          ['today', { scope: 'overdue', today: '2026-13-45' }],
        ];
        for (const [field, options] of cases) {
          assert.throws(
            () => listTasks(ndb, options),
            (err: unknown) =>
              err instanceof EtnError &&
              err.code === 'VALIDATION_ERROR' &&
              (err.details as { field?: string } | undefined)?.field === field,
            `${field} некалендарной датой — VALIDATION_ERROR с details.field`,
          );
        }
        // Несуществующий день короткого месяца — тоже отказ (високосность
        // проверяет тот же общий календарный разбор @etn/markdown).
        assert.throws(
          () => listTasks(ndb, { from: '2026-02-29' }),
          (err: unknown) => err instanceof EtnError && err.code === 'VALIDATION_ERROR',
          '29.02 невисокосного года — не календарная дата',
        );
        // Календарная дата проходит как раньше.
        assert.equal(listTasks(ndb, { from: '2026-02-28' }).items.length, 1);
      } finally {
        ndb.close();
      }
    });

    it('keyset-обход отдаёт все строки по порядку due→period_from→id без дублей', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        seedThought(ndb, 't-undated', 'Мысль без срока');
        createTaskComment(ndb, 't-1', '- [ ] C [[2026-11-22]]');
        createTaskComment(ndb, 't-1', '- [ ] A [[2026-11-20]]');
        createTaskComment(ndb, 't-1', '- [ ] B [[2026-11-21]]');
        // Строка «Без срока» — из постоянного комментария (у записи период есть).
        createTaskComment(ndb, 't-undated', '- [ ] Без срока', 'permanent');

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

    it('show_trash = false скрывает корзину: записи помеченного владельца и строки на помеченную мысль', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-live', 'Живая мысль');
        const trashedSubject = '55555555-5555-4555-8555-555555555555';
        seedThought(ndb, trashedSubject, 'Субъект в корзине', { marked: true });
        seedThought(ndb, 't-trashed-owner', 'Владелец в корзине', { marked: true });
        // Живая запись: задача адресована живой мысли и помеченной мысли.
        createTaskComment(ndb, 't-live', '- [ ] Живая [[2026-11-20]]');
        createTaskComment(ndb, 't-live', `- [ ] На корзину [[#${trashedSubject}]] [[2026-11-21]]`);
        // Запись владельца в корзине (хроно-запись — не постоянный комментарий).
        createTaskComment(ndb, 't-trashed-owner', '- [ ] Из корзины [[2026-11-22]]');

        const withTrash = listTasks(ndb, { scope: 'open' }).items.map((task) => task.text);
        assert.equal(withTrash.length, 3, 'по умолчанию корзина показывается');

        const hidden = listTasks(ndb, { scope: 'open', showTrash: false }).items.map(
          (task) => task.text,
        );
        assert.deepEqual(
          hidden,
          ['Живая [[2026-11-20]]'],
          'show_trash = false скрывает записи помеченного владельца и строки на помеченную мысль',
        );

        // Возврат из корзины возвращает строки: фильтр читается на лету, проекция
        // не переписывается.
        ndb
          .prepare('UPDATE thoughts SET marked_for_deletion = 0 WHERE id IN (?, ?)')
          .run(trashedSubject, 't-trashed-owner');
        assert.equal(listTasks(ndb, { scope: 'open', showTrash: false }).items.length, 3);
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

    it('move без даты — ok:false undated (постоянный комментарий); cancel снимает маркер', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        seedThought(ndb, 't-undated', 'Мысль без срока');
        const undatedId = createTaskComment(ndb, 't-undated', '- [ ] Без даты', 'permanent');
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
        // «Сделать бессрочной» есть только у строк постоянного комментария:
        // у строки хроно-записи период вернётся из записи (уточнение 2026-11-16).
        const commentId = createTaskComment(
          ndb,
          't-1',
          ['- [ ] Задача [[2026-11-10]] [[2026-11-12]]', '- [ ] Вторая [[2026-11-13]]'].join('\n'),
          'permanent',
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

    it('массовая undate-all снимает даты у выбранных строк постоянного комментария', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        // Массовая «Сделать бессрочными» работает по строкам постоянных
        // комментариев; строки хроно-записей пропускаются (см. следующий тест).
        createTaskComment(
          ndb,
          't-1',
          ['- [ ] Первая [[2026-11-14]]', '- [ ] Вторая [[2026-11-15]]', '- [ ] Третья'].join('\n'),
          'permanent',
        );
        const outsideId = createDatedComment(
          ndb,
          't-1',
          '- [ ] Вне периода [[2026-12-01]]',
          '2026-12-01',
        );

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
        // Постоянный комментарий: у строки без даты из записи перенос не
        // «пропускается», а закрепляет явную дату (уточнение 2026-11-16) —
        // сценарий undated проверяется на постоянном источнике.
        const commentId = createTaskComment(
          ndb,
          't-1',
          [
            '- [ ] Родитель [[2026-11-20]]',
            '  - [ ] подпункт',
            '    - [ ] ребёнок [[2026-11-21]]',
            '- [ ] Без даты',
          ].join('\n'),
          'permanent',
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

    it('автопериод: запись без дат даёт период дня, период записи — весь, дата строки приоритетнее', () => {
      // ТЗ 2026-11-16: задача строки бросает period_from/period_to записи
      // (valid_from..valid_to), если в строке нет date-ссылок.
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const dayId = createDatedComment(ndb, 't-1', '- [ ] Задача дня', '2026-11-15');
        const periodId = createDatedComment(
          ndb,
          't-1',
          '- [ ] Задача периода\n- [ ] Дата строки [[2026-11-02]]',
          '2026-11-10',
          '2026-11-20',
        );

        const page = listTasks(ndb, { scope: 'open' });
        const byComment = new Map(page.items.map((task) => [task.comment_id, task]));
        const day = byComment.get(dayId)!;
        assert.deepEqual(
          [day.period_from, day.period_to, day.due, day.auto_period],
          ['2026-11-15', '2026-11-15', '2026-11-15', true],
          'дневная запись — период дня, срок — конец периода',
        );
        const periodRows = page.items.filter((task) => task.comment_id === periodId);
        const record = periodRows.find((task) => task.line_no === 0)!;
        const dated = periodRows.find((task) => task.line_no === 1)!;
        assert.deepEqual(
          [record.period_from, record.period_to, record.due, record.auto_period],
          ['2026-11-10', '2026-11-20', '2026-11-20', true],
          'запись с периодом — весь период записи',
        );
        assert.deepEqual(
          [dated.period_from, dated.period_to, dated.due, dated.auto_period],
          ['2026-11-02', '2026-11-02', '2026-11-02', false],
          'дата в строке приоритетнее периода записи',
        );

        // Автопериод попадает в отборы: просрочка пополняется задачами прошлых
        // записей (следствие, принятое пользователем).
        const overdue = listTasks(ndb, { scope: 'overdue', today: '2026-11-16' });
        assert.deepEqual(
          overdue.items.map((task) => task.comment_id).sort(),
          [dayId, periodId].sort(),
        );
      } finally {
        ndb.close();
      }
    });

    it('автопериод: подзадача без даты остаётся пунктом чек-листа, с датой — самостоятельна', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const commentId = createDatedComment(
          ndb,
          't-1',
          ['- [ ] Родитель', '  - [ ] пункт', '  - [ ] подзадача [[2026-11-12]]'].join('\n'),
          '2026-11-10',
        );
        const rows = listTasks(ndb, { commentId }).items;
        assert.deepEqual(
          rows.map((task) => [task.line_no, task.subtask, task.auto_period]),
          [
            [0, false, true],
            [2, false, false],
          ],
          'пункт чек-листа без даты задачей не стал, подзадача с датой самостоятельна',
        );
      } finally {
        ndb.close();
      }
    });

    it('автосубъекты: постоянный комментарий мысли — владелец и ссылки, связи — оба конца', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const linkedId = '55555555-5555-4555-8555-555555555555';
        seedThought(ndb, linkedId, 'Ссылка строки');
        const thoughtComment = createTaskComment(
          ndb,
          't-1',
          `- [ ] Задача [[#${linkedId}]]`,
          'permanent',
        );
        const fromThought = listTasks(ndb, { commentId: thoughtComment }).items[0]!;
        assert.deepEqual(fromThought.subject_thoughts, ['t-1', linkedId]);

        // Панель «Задачи» мысли-владельца видит задачи её постоянного комментария.
        assert.deepEqual(
          listTasks(ndb, { thoughtId: 't-1' }).items.map((task) => task.comment_id),
          [thoughtComment],
        );

        seedThought(ndb, 't-2', 'Второй конец');
        const link = write(ndb, () =>
          createLink(ndb, { source_id: 't-1', target_id: 't-2' }, USER),
        );
        const linkComment = write(
          ndb,
          () =>
            createCommentWithTargets(
              ndb,
              [{ owner_type: 'link', owner_id: link.id }],
              { kind: 'permanent', body_md: `- [ ] Общая задача [[2026-11-20]]` },
              USER,
            ).id,
        );
        const fromLink = listTasks(ndb, { commentId: linkComment }).items[0]!;
        assert.deepEqual(
          fromLink.subject_thoughts,
          ['t-1', 't-2'],
          'комментарий связи адресует задачу обоим концам',
        );
        assert.deepEqual(
          listTasks(ndb, { thoughtId: 't-2' }).items.map((task) => task.comment_id),
          [linkComment],
          'задача связи видна в панели каждого конца',
        );
      } finally {
        ndb.close();
      }
    });

    it('автосубъекты: смена концов связи пере-парсит задачу её комментария (da805de1)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Первый конец');
        seedThought(ndb, 't-2', 'Второй конец');
        seedThought(ndb, 't-3', 'Новый конец');
        const link = write(ndb, () =>
          createLink(ndb, { source_id: 't-1', target_id: 't-2' }, USER),
        );
        const linkComment = write(
          ndb,
          () =>
            createCommentWithTargets(
              ndb,
              [{ owner_type: 'link', owner_id: link.id }],
              { kind: 'permanent', body_md: `- [ ] Общая задача [[2026-11-20]]` },
              USER,
            ).id,
        );
        assert.deepEqual(
          listTasks(ndb, { commentId: linkComment }).items[0]!.subject_thoughts,
          ['t-1', 't-2'],
          'до перепривязки задача адресована обоим концам',
        );

        // Перепривязка T1–T2 → T2–T3: строка проекции обязана пере-парситься
        // (ошибка da805de1), иначе панель «Задачи» держит прежнюю пару концов.
        write(ndb, () =>
          updateLink(ndb, link.id, { source_id: 't-2', target_id: 't-3' }, undefined, USER),
        );
        assert.deepEqual(
          listTasks(ndb, { commentId: linkComment }).items[0]!.subject_thoughts,
          ['t-2', 't-3'],
          'субъекты задачи следуют новой паре концов',
        );
        assert.deepEqual(
          listTasks(ndb, { thoughtId: 't-3' }).items.map((task) => task.comment_id),
          [linkComment],
          'новый конец видит задачу сразу после перепривязки',
        );
        assert.deepEqual(
          listTasks(ndb, { thoughtId: 't-1' }).items.map((task) => task.comment_id),
          [],
          'старый конец задачу больше не видит',
        );
      } finally {
        ndb.close();
      }
    });

    it('undate строки хроно-записи — 400; set_due и перенос закрепляют явную дату', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const commentId = createDatedComment(ndb, 't-1', '- [ ] Задача дня', '2026-11-15');

        assert.throws(
          () =>
            write(ndb, () =>
              applyTaskOps(
                ndb,
                [{ comment_id: commentId, line_no: 0, action: 'undate', expected_revision: 1 }],
                USER,
              ),
            ),
          (err: unknown) => err instanceof EtnError && err.code === 'BAD_REQUEST',
          'автопериод вернул бы дату при пере-парсинге — команда недоступна',
        );

        // set_due: дат в строке нет — ссылка дописывается, задача закрепляется.
        const pinned = write(ndb, () =>
          applyTaskOps(
            ndb,
            [
              {
                comment_id: commentId,
                line_no: 0,
                action: 'set_due',
                date: '2026-11-20',
                expected_revision: 1,
              },
            ],
            USER,
          ),
        );
        assert.equal(pinned.revisions[0]!.body_md, '- [ ] Задача дня [[2026-11-20]]');
        const row = listTasks(ndb, { commentId }).items[0]!;
        assert.deepEqual(
          [row.period_from, row.due, row.auto_period],
          ['2026-11-20', '2026-11-20', false],
          'строка закреплена явной датой — период больше не из записи',
        );

        // «На завтра» (move) авто-строки: отсчёт от конца периода записи.
        const movedId = createDatedComment(ndb, 't-1', '- [ ] Отложить', '2026-11-15');
        const moved = write(ndb, () =>
          applyTaskOps(
            ndb,
            [{ comment_id: movedId, line_no: 0, action: 'move', days: 1, expected_revision: 1 }],
            USER,
          ),
        );
        assert.equal(moved.revisions[0]!.body_md, '- [ ] Отложить [[2026-11-16]]');
      } finally {
        ndb.close();
      }
    });

    it('массовая undate-all пропускает строки хроно-записей, не отменяя команду', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const recordId = createDatedComment(ndb, 't-1', '- [ ] Из записи', '2026-11-15');
        const permanentId = createTaskComment(
          ndb,
          't-1',
          '- [ ] Из постоянного [[2026-11-16]]',
          'permanent',
        );

        const result = write(ndb, () =>
          applyTaskMassCommand(
            ndb,
            {
              action: 'undate-all',
              filter: { scope: 'open', from: '2026-11-15', to: '2026-11-20' },
            },
            USER,
          ),
        );
        const failed = result.results.filter((entry) => !entry.ok);
        assert.deepEqual(
          failed.map((entry) => [entry.comment_id, entry.error]),
          [[recordId, 'undate_not_allowed']],
          'строка хроно-записи пропущена с объяснением',
        );
        const permanent = listTasks(ndb, { commentId: permanentId }).items[0]!;
        assert.equal(
          permanent.period_from,
          null,
          'строка постоянного комментария стала бессрочной',
        );
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
    /**
     * Вложенные не-задачные строки (уточнение ТЗ 2026-11-17, пункт F): панель
     * показывает под задачей пункты чек-листа и обычные вложенные строки.
     */
    it('include_nested отдаёт пункты чек-листа и вложенный текст под задачей', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль');
        const commentId = createTaskComment(
          ndb,
          't-1',
          [
            '- [ ] Родитель [[2026-11-20]]',
            '  - [x] Пункт чек-листа',
            '  - обычная вложенная строка',
            '    - глубже: вложенный текст',
            '- [ ] Второй родитель [[2026-11-21]]',
          ].join('\n'),
        );

        const plain = listTasks(ndb, { scope: 'open' });
        assert.equal(plain.nested, undefined, 'без флага вложенных строк нет');
        assert.deepEqual(
          plain.items.map((task) => task.text),
          ['Родитель [[2026-11-20]]', 'Второй родитель [[2026-11-21]]'],
          'в выборке только задачи',
        );

        const page = listTasks(ndb, { scope: 'open', includeNested: true });
        const parent = page.items.find((task) => task.text.startsWith('Родитель'))!;
        const nested = (page.nested ?? []).filter((line) => line.parent.line_no === parent.line_no);
        assert.deepEqual(
          nested.map((line) => [line.text, line.depth, line.checkbox]),
          [
            ['Пункт чек-листа', 1, true],
            ['обычная вложенная строка', 1, false],
            ['глубже: вложенный текст', 2, false],
          ],
          'вложенные строки идут по порядку и несут уровень',
        );
        // Отметка пункта чек-листа — из проекции: панель рисует пункт настоящим
        // чекбоксом и не парсит источник ради галочки (0.16.1, задача 7446eb25).
        assert.deepEqual(
          nested.map((line) => [line.checkbox, line.done]),
          [
            [true, true],
            [false, false],
            [false, false],
          ],
          'пункт `- [x]` приходит с отметкой `done`; обычные строки отметки не несут',
        );
        for (const line of nested) {
          assert.equal(line.comment_id, commentId);
          assert.equal(line.parent.comment_id, commentId);
        }

        // Задача страницы не попала в выборку — её вложенные строки не отдаются.
        const onlySecond = listTasks(ndb, { scope: 'open', commentId });
        const filtered = listTasks(ndb, {
          scope: 'open',
          from: '2026-11-21',
          to: '2026-11-21',
          includeNested: true,
        });
        assert.deepEqual(
          filtered.items.map((task) => task.text),
          ['Второй родитель [[2026-11-21]]'],
        );
        assert.deepEqual(
          (filtered.nested ?? []).map((line) => line.text),
          [],
          'вложенные строки других задач страницы не отдаются',
        );
        assert.equal(onlySecond.items.length, 2, 'выборка по comment_id видит обе задачи');
      } finally {
        ndb.close();
      }
    });
  },
);
