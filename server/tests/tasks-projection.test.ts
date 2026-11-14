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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, ETNX_VERSION, type EtnxManifest } from '@etn/shared';

import { closeNetworkDb, createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { SystemDb } from '../src/db/system-db.js';
import {
  createCommentWithTargets,
  deleteComment,
  removeCommentTarget,
  updateComment,
} from '../src/domain/comment-service.js';
import { applyManifest } from '../src/domain/import-service.js';
import {
  discardLayerThought,
  listPendingMergeConflicts,
  mergeLayer,
  resetLayerOverride,
} from '../src/domain/merge-service.js';
import { purgeOwnerDependants } from '../src/domain/owner-cleanup.js';
import {
  buildTaskRows,
  readTaskProjectionMarker,
  rebuildTaskProjection,
  sweepTaskProjection,
  TASK_PROJECTION_SETTING,
} from '../src/domain/task-projection.js';
import { listTasks } from '../src/domain/task-service.js';
import { getThought } from '../src/domain/thought-service.js';
import { runWriteCore } from '../src/domain/write-wrapper.js';
import { createLogger } from '../src/logger.js';
import { networkDbPath, networkDir, systemMigrationsDir } from '../src/paths.js';

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

    it('перепривязка комментария двигает parsed_revision через хук пере-парса', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль 1');
        seedThought(ndb, 't-2', 'Мысль 2');
        // Комментарий привязан к двум мыслям: первая — основная привязка.
        const commentId = write(
          ndb,
          () =>
            createCommentWithTargets(
              ndb,
              [
                { owner_type: 'thought', owner_id: 't-1' },
                { owner_type: 'thought', owner_id: 't-2' },
              ],
              { kind: 'chronological', body_md: '- [ ] Задача [[2026-11-20]]' },
              USER,
            ).id,
        );
        const revision = (): number =>
          (
            ndb.prepare('SELECT version FROM comments WHERE id = ?').get(commentId) as {
              version: number;
            }
          ).version;
        const parsedRevision = (): number =>
          (
            ndb
              .prepare('SELECT parsed_revision FROM task_rows WHERE comment_id = ? LIMIT 1')
              .get(commentId) as { parsed_revision: number }
          ).parsed_revision;

        assert.equal(revision(), 1);
        assert.equal(parsedRevision(), 1);

        // Не-основная привязка: bumpVersion + пере-парс (текст не менялся).
        write(ndb, () => removeCommentTarget(ndb, commentId, 'thought', 't-2', 1, USER));
        assert.equal(revision(), 2);
        assert.equal(parsedRevision(), 2, 'parsed_revision догнал ревизию');

        // Переезд основной привязки: тоже ревизия + пере-парс.
        const moved = write(
          ndb,
          () =>
            createCommentWithTargets(
              ndb,
              [
                { owner_type: 'thought', owner_id: 't-1' },
                { owner_type: 'thought', owner_id: 't-2' },
              ],
              { kind: 'chronological', body_md: '- [ ] Вторая задача [[2026-11-21]]' },
              USER,
            ).id,
        );
        write(ndb, () => removeCommentTarget(ndb, moved, 'thought', 't-1', 1, USER));
        assert.equal(
          (
            ndb.prepare('SELECT version FROM comments WHERE id = ?').get(moved) as {
              version: number;
            }
          ).version,
          2,
          'переезд основной привязки — новая ревизия',
        );
        assert.equal(
          (
            ndb
              .prepare('SELECT parsed_revision FROM task_rows WHERE comment_id = ? LIMIT 1')
              .get(moved) as { parsed_revision: number }
          ).parsed_revision,
          2,
          'переезд основной привязки пере-парсит строки',
        );
        assert.equal(
          (
            ndb.prepare('SELECT COUNT(*) AS c FROM task_rows WHERE comment_id = ?').get(moved) as {
              c: number;
            }
          ).c,
          1,
          'строка проекции осталась: текст не менялся',
        );
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

    it('слияние удаления комментария из слоя убирает осиротевшие строки основы', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль 1');
        const commentId = createTaskComment(ndb, 't-1', '- [ ] Основа [[2026-11-20]]');
        const layerId = seedLayer(ndb);

        ndb.useLayer(layerId);
        write(ndb, () => deleteComment(ndb, commentId, 1, USER));
        assert.deepEqual(
          rowsOf(ndb, commentId).map((row) => row.layer_id),
          [null],
          'в слое комментарий невидим — своих строк у слоя нет',
        );

        ndb.useLayer(BASE_LAYER_ID);
        write(ndb, () => mergeLayer(ndb, layerId, undefined, USER));

        assert.equal(
          rowsOf(ndb, commentId).length,
          0,
          'надгробие слито: строки исчезнувшего комментария удалены, осиротевших не остаётся',
        );
        for (const table of ['task_row_dates', 'task_row_subjects']) {
          const row = ndb
            .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE comment_id = ?`)
            .get(commentId) as { c: number };
          assert.equal(row.c, 0, `${table}: строки исчезнувшего комментария удалены`);
        }
        assert.equal(listTasks(ndb).items.length, 0, 'в выборке задач ничего не осталось');
      } finally {
        ndb.close();
      }
    });

    it('импорт .etnx с задачами в текстах наполняет проекцию', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-parent', 'Родитель импорта');
        seedThought(ndb, 't-import', 'Импортируемая мысль');
        const thought = getThought(ndb, 't-import');
        assert.ok(thought !== null);
        const commentId = randomUUID();
        const now = new Date().toISOString();
        const manifest: EtnxManifest = {
          format: 'etnx',
          version: ETNX_VERSION,
          exported_at: now,
          source: { network_id: 'src', network_name: 'src', user_id: USER },
          thought_types: [],
          link_types: [],
          properties: [],
          type_properties: [],
          thoughts: [thought],
          thought_synonyms: [],
          links: [],
          comments: [
            {
              id: commentId,
              owner_type: 'thought',
              owner_id: 't-import',
              targets: [{ owner_type: 'thought', owner_id: 't-import' }],
              kind: 'chronological',
              title: null,
              body_md: '- [ ] Импортированная [[2026-11-20]]',
              body_html: '',
              valid_from: now,
              valid_to: null,
              use_time: false,
              version: 1,
              created_at: now,
              updated_at: now,
              created_by: USER,
              updated_by: USER,
            },
          ],
          comment_targets: [],
          property_values: [],
          attachments: [],
          publications: [],
          publication_order: [],
          publication_exclusions: [],
          shelves: [],
          shelf_items: [],
        };

        write(ndb, () =>
          applyManifest(
            ndb,
            manifest,
            new Map(),
            { actorUserId: USER, parentThoughtId: 't-parent' },
            createLogger('silent'),
          ),
        );

        const rows = rowsOf(ndb, commentId);
        assert.equal(rows.length, 1, 'импорт наполнил проекцию строкой задачи');
        assert.equal(rows[0]!.is_task, 1);
        const dates = ndb
          .prepare('SELECT date FROM task_row_dates WHERE comment_id = ?')
          .all(commentId) as Array<{ date: string }>;
        assert.deepEqual(
          dates.map((row) => row.date),
          ['2026-11-20'],
        );
        assert.deepEqual(
          listTasks(ndb, { scope: 'open' }).items.map((task) => task.text),
          ['Импортированная [[2026-11-20]]'],
        );
      } finally {
        ndb.close();
      }
    });

    it('reset_override слоя пере-парсит строки слоя под поднятую ревизию', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 't-1', 'Мысль 1');
        const commentId = createTaskComment(ndb, 't-1', '- [ ] Основа [[2026-11-20]]');
        const layerId = seedLayer(ndb);

        ndb.useLayer(layerId);
        write(ndb, () =>
          updateComment(ndb, commentId, { body_md: '- [ ] Слой [[2026-11-21]]' }, 1, USER),
        );

        // Основа дважды правит ту же строку: у тени base_version 1, ревизия 2,
        // у основы — 3. Превью называет конфликт, reset поднимает ревизию тени.
        ndb.useLayer(BASE_LAYER_ID);
        write(ndb, () =>
          updateComment(ndb, commentId, { body_md: '- [ ] Фикс [[2026-11-22]]' }, 1, USER),
        );
        write(ndb, () =>
          updateComment(ndb, commentId, { body_md: '- [ ] Фикс 2 [[2026-11-23]]' }, 2, USER),
        );
        assert.equal(
          listPendingMergeConflicts(ndb, layerId, { comments: [commentId] }).conflicts.length,
          1,
        );

        const reset = write(ndb, () => resetLayerOverride(ndb, layerId, { comments: [commentId] }));
        assert.equal(reset.reset.length, 1);
        assert.equal(reset.reset[0]!.version_raised_to, 3);

        const layerRow = ndb
          .prepare(
            'SELECT text, parsed_revision FROM task_rows WHERE comment_id = ? AND layer_id = ?',
          )
          .get(commentId, layerId) as { text: string; parsed_revision: number } | undefined;
        assert.ok(layerRow !== undefined);
        assert.equal(layerRow!.text, 'Слой [[2026-11-21]]');
        assert.equal(
          layerRow!.parsed_revision,
          3,
          'parsed_revision строк слоя догнал поднятую ревизию (хук reset_override)',
        );

        ndb.useLayer(layerId);
        assert.deepEqual(
          listTasks(ndb, { scope: 'open' }).items.map((task) => task.text),
          ['Слой [[2026-11-21]]'],
          'в слое видна только его редакция',
        );
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          listTasks(ndb, { scope: 'open' }).items.map((task) => task.text),
          ['Фикс 2 [[2026-11-23]]'],
          'основа не смешивается со слоем',
        );

        write(ndb, () => mergeLayer(ndb, layerId, undefined, USER));
        assert.deepEqual(
          rowsOf(ndb, commentId).map((row) => [row.layer_id, row.text]),
          [[null, 'Слой [[2026-11-21]]']],
          'после reset слияние проходит: основа получает текст слоя',
        );
        assert.equal(listTasks(ndb, { scope: 'open' }).items[0]!.due, '2026-11-21');
      } finally {
        ndb.close();
      }
    });

    it('свип: версия проекции ставится только после успеха всех сетей', () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'etn-task-sweep-'));
      try {
        const systemDb = new DatabaseConstructor(':memory:');
        try {
          systemDb.pragma('foreign_keys = ON');
          runMigrations(systemDb, systemMigrationsDir());
          const sys = new SystemDb(systemDb);
          const owner = randomUUID();
          sys.createUser({ id: owner, username: 'sweep-owner', displayName: 'Sweep' });
          const brokenId = randomUUID();
          sys.createNetworkRow(brokenId, owner, 'Битая сеть', null);
          // Каталог на месте файла БД: открытие сети упадёт, не держа handle.
          mkdirSync(networkDir(dataDir, brokenId), { recursive: true });
          mkdirSync(networkDbPath(dataDir, brokenId), { recursive: true });

          sweepTaskProjection(dataDir, sys, createLogger('silent'));
          assert.equal(
            sys.getSetting(TASK_PROJECTION_SETTING),
            null,
            'при сбое сети версия не двигается — свип повторится на следующем старте',
          );
        } finally {
          systemDb.close();
        }

        // Чистая сеть: свип проходит целиком и только тогда ставит версию.
        const cleanDir = mkdtempSync(join(tmpdir(), 'etn-task-sweep-ok-'));
        const cleanDb = new DatabaseConstructor(':memory:');
        // Объявлен до try: тот же id нужен в finally для закрытия соединения.
        const cleanNetworkId = randomUUID();
        try {
          cleanDb.pragma('foreign_keys = ON');
          runMigrations(cleanDb, systemMigrationsDir());
          const sys = new SystemDb(cleanDb);
          const owner = randomUUID();
          sys.createUser({ id: owner, username: 'sweep-owner-ok', displayName: 'Sweep' });
          sys.createNetworkRow(cleanNetworkId, owner, 'Чистая сеть', null);

          sweepTaskProjection(cleanDir, sys, createLogger('silent'));
          assert.notEqual(
            sys.getSetting(TASK_PROJECTION_SETTING),
            null,
            'успешный свип фиксирует версию проекции',
          );
        } finally {
          cleanDb.close();
          // Соединение сети кешируется реестром: на Windows файл не удалить,
          // пока handle открыт.
          closeNetworkDb(cleanNetworkId);
          rmSync(cleanDir, { recursive: true, force: true });
        }
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  },
);
