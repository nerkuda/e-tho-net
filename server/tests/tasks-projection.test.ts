/**
 * Проекция задач (0.16.1, задача 632eca85; ADR d0c07f33, сущность 46e00dde).
 *
 * Проверяется разбор строк `body_md` (дедуп по line_no, цепочка чек-листа,
 * строка содержимого с маркером, субъекты) и хук записи: создание/правка/
 * удаление комментария, слои (видимость строк и отсутствие смешивания),
 * слияние и отказ от изменений слоя, физическая вычистка корзины, маркер
 * актуальности.
 *
 * Требует нативного better-sqlite3; иначе пропускается.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import {
  createCommentWithTargets,
  deleteComment,
  updateComment,
} from '../src/domain/comment-service.js';
import { discardLayerThought, mergeLayer } from '../src/domain/merge-service.js';
import { purgeOwnerDependants } from '../src/domain/owner-cleanup.js';
import {
  buildTaskRows,
  readTaskProjectionMarker,
  rebuildTaskProjection,
} from '../src/domain/task-projection.js';
import { listTasks } from '../src/domain/task-service.js';
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

/** Завести мысль-владельца комментариев. */
function seedThought(ndb: NetworkDb, id: string, title: string, layerId = BASE_LAYER_ID): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts
         (id, layer_id, title, title_norm, type_id, active, is_root, marked_for_deletion,
          version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, NULL, 1, 0, 0, 1, ?, ?, ?, ?, 0, 0)`,
    )
    .run(id, layerId, title, title.toLowerCase(), now, USER, now, USER);
}

/** Завести дочерний слой основы. */
function seedLayer(ndb: NetworkDb): string {
  const layerId = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, comment, git_branch, is_service, is_base,
                           depth, created_by, created_at, last_activity_at, version)
       VALUES (?, ?, 'Задачи в слое', NULL, NULL, 0, 0, 1, ?, ?, ?, 1)`,
    )
    .run(layerId, BASE_LAYER_ID, USER, now, now);
  return layerId;
}

/** Создать комментарий-источник задач (через обёртку записи). */
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

/** Строки проекции комментария (все слои, по порядку). */
function rowsOf(
  ndb: NetworkDb,
  commentId: string,
): Array<{ layer_id: string | null; line_no: number; text: string; is_task: number }> {
  return ndb
    .prepare(
      `SELECT layer_id, line_no, text, is_task FROM task_rows
        WHERE comment_id = ? ORDER BY layer_id, line_no`,
    )
    .all(commentId) as Array<{
    layer_id: string | null;
    line_no: number;
    text: string;
    is_task: number;
  }>;
}

describe(
  'проекция задач: разбор и хук записи (632eca85)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('разбирает строки: дедуп по line_no, период/срок, субъекты, строка содержимого', () => {
      const one = buildTaskRows('- [ ] Задача [[2026-11-20]] [[2026-11-22]]');
      assert.equal(one.length, 1);
      assert.equal(one[0]!.lineNo, 0);
      assert.equal(one[0]!.isTask, true);
      assert.deepEqual(
        [one[0]!.periodFrom, one[0]!.periodTo, one[0]!.due],
        ['2026-11-20', '2026-11-22', '2026-11-22'],
      );
      assert.equal(one[0]!.dates.length, 2, 'все date-ссылки строки попадают в проекцию');

      // Таблица: парсер отдаёт несколько строк с одним line_no — ключ строки
      // (comment_id, layer_id, line_no) схлопывает их в одну.
      const table = buildTaskRows('| [[2026-11-20]] | [[2026-11-21]] |\n| --- | --- |');
      assert.equal(table.length, 1);
      assert.equal(table[0]!.lineNo, 0);
      assert.equal(table[0]!.isTask, false, 'таблица с датами — не задача');
      assert.equal(table[0]!.dates.length, 2);

      // Маркер на отдельной строке: line_no — строка содержимого пункта.
      const wrapped = buildTaskRows('-\n  [ ] Текст [[2026-11-20]]');
      assert.equal(wrapped.length, 1);
      assert.equal(wrapped[0]!.lineNo, 1);
      assert.equal(wrapped[0]!.isTask, true);

      const linked = buildTaskRows(
        '- [ ] Связано с [[#11111111-1111-4111-8111-111111111111]] [[2026-11-20]]',
      );
      assert.deepEqual(linked[0]!.subjects, ['11111111-1111-4111-8111-111111111111']);
    });

    it('parent_task — ближайшая ЗАДАЧА цепочки, пункт чек-листа родителем не считается', () => {
      const rows = buildTaskRows(
        '- [ ] Родитель [[2026-11-01]]\n  - [ ] пункт\n    - [ ] подзадача [[2026-11-02]]',
      );
      const byLine = new Map(rows.map((row) => [row.lineNo, row]));
      assert.equal(byLine.get(0)!.isTask, true);
      assert.equal(byLine.get(1)!.isTask, false, 'пункт чек-листа без даты — не задача');
      assert.equal(byLine.get(1)!.subtask, true);
      assert.equal(byLine.get(1)!.parentLineNo, 0);
      assert.equal(byLine.get(2)!.isTask, true, 'пункт с датой — задача');
      assert.equal(
        byLine.get(2)!.parentLineNo,
        0,
        'родитель подзадачи — ближайшая задача, а не промежуточный пункт',
      );
    });

    it('запись комментария наполняет три таблицы и маркер актуальности', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль 1');
        const subjectId = '22222222-2222-4222-8222-222222222222';
        const commentId = createTaskComment(
          ndb,
          't-1',
          `- [ ] Задача [[2026-11-20]] [[#${subjectId}]]\n- [x] Готово [[2026-11-21]]`,
        );

        const rows = rowsOf(ndb, commentId);
        assert.equal(rows.length, 2);
        assert.ok(
          rows.every((row) => row.layer_id === null),
          'основа — layer_id NULL',
        );
        assert.deepEqual(
          rows.map((row) => [row.line_no, row.is_task]),
          [
            [0, 1],
            [1, 1],
          ],
        );
        const dates = ndb
          .prepare('SELECT COUNT(*) AS c FROM task_row_dates WHERE comment_id = ?')
          .get(commentId) as { c: number };
        assert.equal(dates.c, 2);
        const subjects = ndb
          .prepare('SELECT thought_id FROM task_row_subjects WHERE comment_id = ?')
          .all(commentId) as { thought_id: string }[];
        assert.deepEqual(
          subjects.map((row) => row.thought_id),
          [subjectId],
        );
        assert.equal(readTaskProjectionMarker(ndb), 1, 'маркер = ревизия комментария');
        const parsed = ndb
          .prepare('SELECT parsed_revision FROM task_rows WHERE comment_id = ? LIMIT 1')
          .get(commentId) as { parsed_revision: number };
        assert.equal(parsed.parsed_revision, 1);
      } finally {
        ndb.close();
      }
    });

    it('правка пере-парсит только затронутый комментарий и двигает маркер', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль 1');
        const first = createTaskComment(ndb, 't-1', '- [ ] Первая [[2026-11-20]]');
        const second = createTaskComment(ndb, 't-1', '- [ ] Вторая [[2026-11-21]]');

        write(ndb, () =>
          updateComment(ndb, first, { body_md: '- [x] Первая [[2026-11-20]]' }, 1, USER),
        );

        const firstRow = ndb
          .prepare('SELECT done, parsed_revision FROM task_rows WHERE comment_id = ?')
          .get(first) as { done: number; parsed_revision: number };
        assert.equal(firstRow.done, 1);
        assert.equal(firstRow.parsed_revision, 2);
        const secondRow = ndb
          .prepare('SELECT parsed_revision FROM task_rows WHERE comment_id = ?')
          .get(second) as { parsed_revision: number };
        assert.equal(secondRow.parsed_revision, 1, 'чужая строка не пере-парсилась');
        assert.equal(readTaskProjectionMarker(ndb), 2, 'маркер — максимум ревизий');
      } finally {
        ndb.close();
      }
    });

    it('слои: строки слоя отдельные, чтение без смешивания, удаление убирает строки слоя', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль 1');
        const commentId = createTaskComment(ndb, 't-1', '- [ ] Основа [[2026-11-20]]');
        const layerId = seedLayer(ndb);

        ndb.useLayer(layerId);
        write(ndb, () =>
          updateComment(ndb, commentId, { body_md: '- [ ] Слой [[2026-11-21]]' }, 1, USER),
        );
        const layers = rowsOf(ndb, commentId);
        assert.deepEqual(
          layers.map((row) => [row.layer_id, row.text]),
          [
            [null, 'Основа [[2026-11-20]]'],
            [layerId, 'Слой [[2026-11-21]]'],
          ],
        );
        const inLayer = listTasks(ndb, { scope: 'open' });
        assert.deepEqual(
          inLayer.items.map((task) => task.text),
          ['Слой [[2026-11-21]]'],
          'в слое видна только редакция слоя',
        );

        // Удаление в слое (надгробие) убирает строки слоя, основа не тронута.
        write(ndb, () => deleteComment(ndb, commentId, 2, USER));
        assert.deepEqual(
          rowsOf(ndb, commentId).map((row) => row.layer_id),
          [null],
          'после удаления в слое остались только строки основы',
        );

        ndb.useLayer(BASE_LAYER_ID);
        const inBase = listTasks(ndb, { scope: 'open' });
        assert.deepEqual(
          inBase.items.map((task) => task.text),
          ['Основа [[2026-11-20]]'],
        );
      } finally {
        ndb.close();
      }
    });

    it('слияние слоя: строки слоя удаляются, основа пере-парсится по финальному тексту', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль 1');
        const commentId = createTaskComment(ndb, 't-1', '- [ ] Основа [[2026-11-20]]');
        const layerId = seedLayer(ndb);

        ndb.useLayer(layerId);
        write(ndb, () =>
          updateComment(ndb, commentId, { body_md: '- [ ] Изменено [[2026-11-21]]' }, 1, USER),
        );
        // Слияние идёт в контексте основы (как REST-маршрут слоёв).
        ndb.useLayer(BASE_LAYER_ID);
        write(ndb, () => mergeLayer(ndb, layerId, undefined, USER));

        assert.deepEqual(
          rowsOf(ndb, commentId).map((row) => [row.layer_id, row.text]),
          [[null, 'Изменено [[2026-11-21]]']],
          'таблицы проекции не мержатся: строки слоя удалены, основа пере-парсена',
        );
        const visible = listTasks(ndb, { scope: 'open' });
        assert.deepEqual(
          visible.items.map((task) => task.due),
          ['2026-11-21'],
        );
      } finally {
        ndb.close();
      }
    });

    it('отказ от изменений слоя: строки слоя убираются, основа видна снова', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль 1');
        const commentId = createTaskComment(ndb, 't-1', '- [ ] Основа [[2026-11-20]]');
        const layerId = seedLayer(ndb);

        ndb.useLayer(layerId);
        write(ndb, () =>
          updateComment(ndb, commentId, { body_md: '- [ ] Слой [[2026-11-21]]' }, 1, USER),
        );
        ndb.useLayer(BASE_LAYER_ID);
        write(ndb, () => discardLayerThought(ndb, layerId, 't-1'));

        assert.deepEqual(
          rowsOf(ndb, commentId).map((row) => row.layer_id),
          [null],
          'строк слоя после отказа нет',
        );
        assert.deepEqual(
          listTasks(ndb, { scope: 'open' }).items.map((task) => task.text),
          ['Основа [[2026-11-20]]'],
        );
      } finally {
        ndb.close();
      }
    });

    it('физическая вычистка корзины удаляет строки проекции исчезнувших комментариев', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль 1');
        const commentId = createTaskComment(ndb, 't-1', '- [ ] Задача [[2026-11-20]]');
        assert.equal(rowsOf(ndb, commentId).length, 1);

        ndb.transaction(() => purgeOwnerDependants(ndb, 'thought', ['t-1']));
        assert.equal(rowsOf(ndb, commentId).length, 0, 'осиротевших строк не остаётся');
        assert.equal(
          (
            ndb
              .prepare('SELECT COUNT(*) AS c FROM task_row_dates WHERE comment_id = ?')
              .get(commentId) as { c: number }
          ).c,
          0,
        );
      } finally {
        ndb.close();
      }
    });

    it('полный пере-парс сети собирает строки всех слоёв и маркер', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль 1');
        const commentId = createTaskComment(ndb, 't-1', '- [ ] Задача [[2026-11-20]]');
        assert.ok(rebuildTaskProjection(ndb) >= 1);
        assert.equal(rowsOf(ndb, commentId).length, 1);
        assert.equal(readTaskProjectionMarker(ndb), 1);
      } finally {
        ndb.close();
      }
    });
  },
);
