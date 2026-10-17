/**
 * Точечные тяжёлые чтения в reader-пуле (задача 514dc30f, ошибка 49e05ea0,
 * ADR bec191e6).
 *
 * DoD задачи: `resolve`, `neighbors`, `find_duplicates`, чтения комментариев
 * исполняются в reader-пуле и дают ТОТ ЖЕ результат, что синхронный путь в
 * главном потоке при том же контексте слоя. Проверяется на файловой БД и
 * настоящих worker_threads:
 *
 *   * паритет sync/pool для каждой операции (reject-пути — тоже);
 *   * граница батча `THOUGHT_RESOLVE_MAX_IDS` — 100/101;
 *   * пустой ввод и несуществующий id;
 *   * контекст не-основного слоя (тень перекрывает основу);
 *   * `find_duplicates` и веерный режим (fan-out) идут через пул.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, EtnError, THOUGHT_RESOLVE_MAX_IDS } from '@etn/shared';

import { closeAll, openNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import {
  closeReaderPool,
  configureReaderPool,
  getReaderPool,
} from '../src/db/reader-pool.js';
import {
  commentsPreviewBatchAsync,
  findDuplicatesAsync,
  getPermanentPresentedAsync,
  getPresentedCommentAsync,
  getVisibleCommentAsync,
  listCommentsAsync,
  neighborsWithTotalAsync,
  resolveThoughtCardsAsync,
  resolveThoughtRefsAsync,
  traverseAsync,
} from '../src/domain/heavy-read.js';
import {
  countNeighbors,
  getNeighbors,
  getThoughtsByIdsResolved,
  resolveThoughts,
} from '../src/domain/thought-service.js';
import {
  getCommentsPreview,
  getPermanentComment,
  getVisibleComment,
  listComments,
} from '../src/domain/comment-service.js';
import { findDuplicates } from '../src/domain/search-service.js';
import { traverse } from '../src/domain/graph-traversal.js';
import { createBodyExpander, createBodyPresenter } from '../src/domain/transclusion-service.js';

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

const NETWORK_ID = 'targeted-read-pool';
const USER = 'targeted-read-user';
const CHILD_LAYER_ID = '00000000-0000-4000-8000-0000000000c2';

/** Наполнить сеть графом и комментариями. */
function seed(ndb: NetworkDb): { ids: string[]; parentId: string } {
  const now = '2026-01-01T00:00:00Z';
  const ids = Array.from({ length: 130 }, () => randomUUID());
  const parentId = ids[100]!;
  const insertThought = ndb.prepare(
    `INSERT INTO thoughts
       (id, layer_id, title, title_norm, type_id, active, is_root, marked_for_deletion,
        version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, NULL, 1, 0, 0, 1, ?, ?, ?, ?, 0, 0)`,
  );
  const insertSynonym = ndb.prepare(
    'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm, layer_id) VALUES (?, ?, ?, ?)',
  );
  const insertLink = ndb.prepare(
    `INSERT INTO links
       (id, layer_id, source_id, target_id, type_id, position, active, marked_for_deletion,
        version, created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, 1, ?, ?, ?, ?, 0, 0)`,
  );
  const insertComment = ndb.prepare(
    `INSERT INTO comments
       (id, layer_id, deleted, base_version, owner_type, owner_id, kind, title,
        body_md, body_html, valid_from, valid_to, version, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, 0, 0, 'thought', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  );
  ndb.transaction(() => {
    for (const [i, id] of ids.entries()) {
      const title = `Мысль ${i}`;
      insertThought.run(id, BASE_LAYER_ID, title, title.toLowerCase(), now, USER, now, USER);
      // Синонимы нужны find_duplicates (exact/wildcard/partial).
      for (let s = 0; s < 10; s += 1) {
        const synonym = `терм-${i}-${s}`;
        insertSynonym.run(id, synonym, synonym.toLowerCase(), BASE_LAYER_ID);
      }
    }
    let seq = 0;
    const link = (source: string, target: string): void => {
      insertLink.run(randomUUID(), BASE_LAYER_ID, source, target, null, seq++, now, now, USER, USER);
    };
    // focus = ids[0]: родитель P, 5 сиблингов, 20 детей, 11 родителей.
    for (let i = 0; i <= 5; i += 1) link(parentId, ids[i]!);
    for (let i = 10; i < 30; i += 1) link(ids[0]!, ids[i]!);
    for (let i = 30; i < 41; i += 1) link(ids[i]!, ids[0]!);
    // Постоянный комментарий у каждой целевой мысли + хронология у focus.
    for (let i = 0; i < 110; i += 1) {
      const body = `Постоянный комментарий ${i}`;
      insertComment.run(
        `perm-${i}`,
        BASE_LAYER_ID,
        ids[i]!,
        'permanent',
        null,
        body,
        `<p>${body}</p>`,
        now,
        null,
        now,
        now,
        USER,
        USER,
      );
      if (i !== 0) continue;
      for (let c = 0; c < 5; c += 1) {
        const cbody = `Хроно ${c}`;
        insertComment.run(
          `chrono-${c}`,
          BASE_LAYER_ID,
          ids[0]!,
          'chronological',
          `Запись ${c}`,
          cbody,
          `<p>${cbody}</p>`,
          `2026-01-0${c + 1}T00:00:00Z`,
          null,
          now,
          now,
          USER,
          USER,
        );
      }
    }
  });
  return { ids, parentId };
}

/** Добавить дочерний слой с тенями мысли, комментария и ребра. */
function seedChildLayer(ndb: NetworkDb): void {
  const now = '2026-01-01T00:00:00Z';
  ndb.exec(`INSERT INTO layers (id, parent_id, title, is_service, is_base, depth, created_by, created_at, last_activity_at, version)
            VALUES ('${CHILD_LAYER_ID}', '${BASE_LAYER_ID}', 'Дочерний', 0, 0, 1, '${USER}', '${now}', '${now}', 1)`);
  const insertThought = ndb.prepare(
    `INSERT INTO thoughts
       (id, layer_id, title, title_norm, type_id, active, is_root, marked_for_deletion,
        version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, NULL, 1, 0, 0, 1, ?, ?, ?, ?, 0, 0)`,
  );
  insertThought.run('layer-focus', BASE_LAYER_ID, 'Фокус основы', 'фокус основы', now, USER, now, USER);
  insertThought.run('layer-shadow', BASE_LAYER_ID, 'Основа A', 'основа a', now, USER, now, USER);
  insertThought.run('layer-shadow', CHILD_LAYER_ID, 'Тень B', 'тень b', now, USER, now, USER);
  ndb
    .prepare(
      `INSERT INTO links
         (id, layer_id, source_id, target_id, type_id, position, active, marked_for_deletion,
          version, created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES ('child-only-link', ?, 'layer-focus', 'layer-shadow', NULL, 0, 1, 0, 1, ?, ?, ?, ?, 0, 0)`,
    )
    .run(CHILD_LAYER_ID, now, now, USER, USER);
  const insertComment = ndb.prepare(
    `INSERT INTO comments
       (id, layer_id, deleted, base_version, owner_type, owner_id, kind, title,
        body_md, body_html, valid_from, valid_to, version, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, 0, 0, 'thought', 'layer-shadow', 'permanent', NULL, ?, ?, ?, NULL, 1, ?, ?, ?, ?)`,
  );
  insertComment.run('base-comment', BASE_LAYER_ID, 'Основа A', '<p>Основа A</p>', now, now, now, USER, USER);
  insertComment.run('child-comment', CHILD_LAYER_ID, 'Тень B', '<p>Тень B</p>', now, now, now, USER, USER);
}

describe(
  'read-pool: точечные тяжёлые чтения (514dc30f)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let dataDir: string;
    let ndb: NetworkDb;
    let ids: string[] = [];

    before(() => {
      dataDir = mkdtempSync(path.join(tmpdir(), 'etn-targeted-read-pool-'));
      configureReaderPool({ size: 2, taskTimeoutMs: 60_000 });
      ndb = openNetworkDb(dataDir, NETWORK_ID);
      ids = seed(ndb).ids;
      seedChildLayer(ndb);
    });

    after(async () => {
      await closeReaderPool();
      ndb.close();
      closeAll();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('resolve (лёгкие ссылки) совпадает с синхронным, включая короткий id', async () => {
      const requested = [ids[0]!, ids[1]!, ids[0]!, 'нет-такой-мысли', ids[2]!];
      const sync = resolveThoughts(ndb, requested);
      const viaPool = await resolveThoughtRefsAsync(ndb, requested);
      assert.deepEqual(viaPool, sync);
      assert.ok(viaPool.length > 0, 'синхронный resolve нашёл мысли');

      const prefix = ids[3]!.slice(0, 8);
      assert.deepEqual(await resolveThoughtRefsAsync(ndb, [prefix]), resolveThoughts(ndb, [prefix]));
    });

    it('resolve (карточки MCP) совпадает с синхронным', async () => {
      const requested = [ids[0]!, ids[5]!, ids[5]!, 'missing-id'];
      const sync = getThoughtsByIdsResolved(ndb, requested);
      const viaPool = await resolveThoughtCardsAsync(ndb, requested);
      assert.deepEqual(viaPool, sync);
      assert.equal(viaPool.items.length, 2);
      assert.deepEqual(viaPool.missing, ['missing-id']);
    });

    it('граница батча: 100 и 101 id (лимит THOUGHT_RESOLVE_MAX_IDS)', async () => {
      const hundred = ids.slice(0, THOUGHT_RESOLVE_MAX_IDS);
      const hundredOne = [...hundred, ids[THOUGHT_RESOLVE_MAX_IDS]!];

      assert.deepEqual(await resolveThoughtRefsAsync(ndb, hundred), resolveThoughts(ndb, hundred));
      assert.equal((await resolveThoughtRefsAsync(ndb, hundred)).length, THOUGHT_RESOLVE_MAX_IDS);

      const refs101 = await resolveThoughtRefsAsync(ndb, hundredOne);
      assert.equal(refs101.length, THOUGHT_RESOLVE_MAX_IDS, '101-й id отсечён лимитом');
      assert.deepEqual(refs101, resolveThoughts(ndb, hundredOne));

      const cards100 = await resolveThoughtCardsAsync(ndb, hundred);
      const cards101 = await resolveThoughtCardsAsync(ndb, hundredOne);
      assert.equal(cards100.items.length, THOUGHT_RESOLVE_MAX_IDS);
      assert.equal(cards101.items.length, THOUGHT_RESOLVE_MAX_IDS, '101-й id отсечён лимитом');
      assert.deepEqual(cards101, getThoughtsByIdsResolved(ndb, hundredOne));
    });

    it('пустой ввод: resolve и комментарии', async () => {
      assert.deepEqual(await resolveThoughtRefsAsync(ndb, []), []);
      assert.deepEqual(await resolveThoughtCardsAsync(ndb, []), { items: [], missing: [] });
      assert.deepEqual(await listCommentsAsync(ndb, 'thought', 'нет-владельца'), []);
      assert.deepEqual(await findDuplicatesAsync(ndb, ''), []);
      assert.deepEqual(await commentsPreviewBatchAsync(ndb, 'thought', []), []);
    });

    it('неоднозначный короткий id: ошибка пула совпадает с синхронной', async () => {
      const first = 'abab0000-0000-4000-8000-000000000001';
      const second = 'abab0000-0000-4000-8000-000000000002';
      const insert = ndb.prepare(
        `INSERT INTO thoughts
           (id, layer_id, title, title_norm, type_id, active, is_root, marked_for_deletion,
            version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, NULL, 1, 0, 0, 1, '2026-01-01T00:00:00Z', ?, '2026-01-01T00:00:00Z', ?, 0, 0)`,
      );
      insert.run(first, BASE_LAYER_ID, 'Неоднозначная 1', 'неоднозначная 1', USER, USER);
      insert.run(second, BASE_LAYER_ID, 'Неоднозначная 2', 'неоднозначная 2', USER, USER);

      let syncError: unknown;
      try {
        resolveThoughts(ndb, ['abab']);
      } catch (err) {
        syncError = err;
      }
      assert.ok(syncError instanceof EtnError, 'синхронный путь падает на неоднозначном префиксе');
      assert.equal(syncError.code, 'VALIDATION_ERROR');

      await assert.rejects(resolveThoughtRefsAsync(ndb, ['abab']), (err: unknown) => {
        assert.ok(err instanceof EtnError);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.deepEqual(err.details, (syncError as EtnError).details);
        return true;
      });

      // Карточный батч неоднозначность не роняет, а кладёт id в missing —
      // то же поведение у пула и синхронного пути.
      assert.deepEqual(
        await resolveThoughtCardsAsync(ndb, ['abab']),
        getThoughtsByIdsResolved(ndb, ['abab']),
      );
    });

    it('neighbors + total совпадают с синхронными (все направления и страницы)', async () => {
      const cases: Array<{ dir: 'parents' | 'children' | 'siblings'; page: { limit?: number; offset?: number } }> = [
        { dir: 'parents', page: {} },
        { dir: 'children', page: {} },
        { dir: 'siblings', page: {} },
        { dir: 'children', page: { limit: 5, offset: 3 } },
      ];
      for (const { dir, page } of cases) {
        const opts = { userId: USER, showInactive: false, showTrash: true };
        const sync = {
          neighbors: getNeighbors(ndb, ids[0]!, dir, { ...opts, ...page }),
          total: countNeighbors(ndb, ids[0]!, dir, opts),
        };
        const viaPool = await neighborsWithTotalAsync(ndb, ids[0]!, dir, opts, page);
        assert.deepEqual(viaPool, sync, `neighbors ${dir} (${JSON.stringify(page)})`);
      }
      // Несуществующий фокус — пустая страница и ноль, без исключения.
      assert.deepEqual(
        await neighborsWithTotalAsync(ndb, 'нет-фокуса', 'parents', { userId: USER }),
        { neighbors: [], total: 0 },
      );
    });

    it('neighbors: ошибка недопустимого направления совпадает', async () => {
      await assert.rejects(
        neighborsWithTotalAsync(ndb, ids[0]!, 'bad-dir' as never, { userId: USER }),
        (err: unknown) => {
          assert.ok(err instanceof EtnError);
          assert.equal(err.code, 'VALIDATION_ERROR');
          return true;
        },
      );
    });

    it('traverse (BFS) совпадает с синхронным', async () => {
      const sync = traverse(ndb, [ids[0]!], 'both', { maxDepth: 2, maxNodes: 100 });
      const viaPool = await traverseAsync(ndb, [ids[0]!], 'both', { maxDepth: 2, maxNodes: 100 });
      assert.deepEqual(viaPool, sync);
      assert.ok(viaPool.ids.length > 1);
    });

    it('find_duplicates совпадает с синхронным', async () => {
      const sync = findDuplicates(ndb, 'Мысль 7', ['терм-8-1']);
      const viaPool = await findDuplicatesAsync(ndb, 'Мысль 7', ['терм-8-1']);
      assert.deepEqual(viaPool, sync);
      assert.ok(viaPool.length > 0, 'кандидаты найдены');
    });

    it('чтения комментариев совпадают с синхронными', async () => {
      const syncList = listComments(ndb, 'thought', ids[0]!);
      assert.deepEqual(await listCommentsAsync(ndb, 'thought', ids[0]!), syncList);
      assert.ok(syncList.length >= 6, 'постоянный + хронология');

      const commentId = syncList[0]!.id;
      assert.deepEqual(await getVisibleCommentAsync(ndb, commentId), getVisibleComment(ndb, commentId));
      assert.equal(await getVisibleCommentAsync(ndb, 'нет-комментария'), null);
      assert.deepEqual(
        await getVisibleCommentAsync(ndb, 'нет-комментария'),
        getVisibleComment(ndb, 'нет-комментария'),
      );

      // presented-форма (MCP `etn.comments.get`): тот же body_md/body_html.
      const total = syncList.length;
      const pres = await getPresentedCommentAsync(ndb, commentId);
      assert.ok(pres !== null);
      assert.equal(total, syncList.length);
      const syncPres = getVisibleComment(ndb, commentId)!;
      assert.deepEqual(pres, {
        ...syncPres,
        ...createBodyPresenter(ndb)(syncPres.body_md),
      });

      const permanent = await getPermanentPresentedAsync(ndb, 'thought', ids[0]!);
      const syncPermanent = getPermanentComment(ndb, 'thought', ids[0]!)!;
      assert.deepEqual(permanent, {
        ...syncPermanent,
        ...createBodyPresenter(ndb)(syncPermanent.body_md),
      });
      assert.equal(await getPermanentPresentedAsync(ndb, 'thought', 'нет-владельца'), null);
    });

    it('батч превью комментариев (subgraph) совпадает с синхронным', async () => {
      const owners = ids.slice(0, 12);
      const expand = createBodyExpander(ndb);
      const sync = owners.map((ownerId) =>
        getCommentsPreview(ndb, 'thought', ownerId, { permanent: 600 }, expand),
      );
      const viaPool = await commentsPreviewBatchAsync(
        ndb,
        'thought',
        owners,
        { permanent: 600 },
        true,
      );
      assert.deepEqual(viaPool, sync);
    });

    it('контекст дочернего слоя доезжает до воркера (resolve/neighbors/comments)', async () => {
      const childNdb = openNetworkDb(dataDir, NETWORK_ID, undefined, CHILD_LAYER_ID);

      // resolve: в основе «Основа A», в ребёнке видна тень «Тень B».
      const baseTitle = (await resolveThoughtRefsAsync(ndb, ['layer-shadow']))[0]?.title;
      const childTitle = (await resolveThoughtRefsAsync(childNdb, ['layer-shadow']))[0]?.title;
      assert.equal(baseTitle, 'Основа A');
      assert.equal(childTitle, 'Тень B');

      // neighbors: ребро существует только в дочернем слое.
      assert.equal((await neighborsWithTotalAsync(ndb, 'layer-focus', 'children')).total, 0);
      const childNeighbors = await neighborsWithTotalAsync(childNdb, 'layer-focus', 'children');
      assert.equal(childNeighbors.total, 1, 'воркер читает ребро слоя задачи');
      assert.equal(childNeighbors.neighbors[0]?.id, 'layer-shadow');

      // comments: у каждого слоя своя редакция постоянного комментария.
      const baseComments = await listCommentsAsync(ndb, 'thought', 'layer-shadow');
      const childComments = await listCommentsAsync(childNdb, 'thought', 'layer-shadow');
      assert.equal(baseComments[0]?.body_md, 'Основа A');
      assert.equal(childComments[0]?.body_md, 'Тень B');
    });

    it('очередь пула реально используется новыми операциями', async () => {
      const pool = getReaderPool();
      assert.ok(pool !== null);
      const before = pool.pending;
      await Promise.all([
        resolveThoughtCardsAsync(ndb, ids.slice(0, 40)),
        neighborsWithTotalAsync(ndb, ids[0]!, 'children'),
        findDuplicatesAsync(ndb, 'Мысль 7'),
        listCommentsAsync(ndb, 'thought', ids[0]!),
      ]);
      assert.equal(before, 0, 'перед вызовом очередь пуста');
      assert.equal(pool.pending, 0, 'после паритетных прогонов очередь пуста');
    });
  },
);
