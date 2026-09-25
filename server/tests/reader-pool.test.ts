/**
 * Пул reader-воркеров тяжёлых чтений (задача d20edd33, этап 2 тех.проекта
 * e29c0f00; ADR bec191e6, требование 8e2fda79).
 *
 * Проверяются DoD этапа и критерий приёмки тех.проекта:
 *
 *   1. **Эквивалентность.** Чтение через пул даёт ТОТ ЖЕ результат, что
 *      синхронное чтение в главном потоке при том же контексте слоя — для
 *      `queryThoughts` (включая `depths` поддерева), `queryThoughtIds` и
 *      `search`.
 *   2. **Неблокируемость.** Пока пул исполняет тяжёлые выборки, главный поток
 *      продолжает отвечать: `setImmediate`-пинг срабатывает раньше, чем очередь
 *      пула опустеет. Если бы те же запросы исполнялись синхронно в главном
 *      потоке, пинг не мог бы обогнать ни один из них.
 *   3. **Контекст слоя.** Задача, отправленная с соединения дочернего слоя,
 *      читает видимость ИМЕННО этого слоя (тень перекрывает основу).
 *
 * База стенда — файловая (`:memory:` нельзя открыть вторым соединением),
 * воркер открывает её read-only. Пул здесь процессный (`configureReaderPool`),
 * как в бою; тесты закрывают его в `after`, чтобы не утекали потоки.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { closeAll, openNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import {
  closeReaderPool,
  configureReaderPool,
  getReaderPool,
} from '../src/db/reader-pool.js';
import { queryThoughts, type ThoughtQueryRequest } from '../src/domain/query-service.js';
import { search } from '../src/domain/search-service.js';
import { subgraph } from '../src/domain/graph-traversal.js';
import { queryThoughtIdsAsync, queryThoughtsAsync, searchAsync, subgraphAsync } from '../src/domain/heavy-read.js';

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

const NETWORK_ID = 'reader-pool-stand';
const USER = 'reader-pool-user';
const STAND_THOUGHTS = 1500;
const STRUCTURAL_PARENTS_PROPERTY_ID = '00000000-0000-4000-8000-0000000000c1';

/** Наполнить сеть стендом: дерево структурных рёбер + типизированные рёбра. */
function seedStand(ndb: NetworkDb): { homeId: string; parentId: string } {
  const now = new Date().toISOString();
  const ids: string[] = [];
  for (let i = 0; i < STAND_THOUGHTS; i += 1) ids.push(`stand-${i.toString().padStart(5, '0')}`);
  const insertThought = ndb.prepare(
    `INSERT INTO thoughts
       (id, layer_id, title, title_norm, type_id, active, is_root, marked_for_deletion,
        version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLink = ndb.prepare(
    `INSERT INTO links
       (id, layer_id, source_id, target_id, type_id, position, active, marked_for_deletion,
        version, created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ndb.transaction(() => {
    for (let i = 0; i < STAND_THOUGHTS; i += 1) {
      insertThought.run(ids[i]!, BASE_LAYER_ID, `Мысль ${i}`, `мысль ${i}`, null, 1, i === 0 ? 1 : 0, 0, 1, now, USER, now, USER, 0, 0);
    }
    let seq = 0;
    const seen = new Set<string>();
    const addLink = (source: string, target: string, typeId: string | null): void => {
      const key = `${source}\u0000${target}\u0000${typeId ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      insertLink.run(`stand-link-${seq++}`, BASE_LAYER_ID, source, target, typeId, seq, 1, 0, 1, now, now, USER, USER, 0, 0);
    };
    for (let i = 1; i < STAND_THOUGHTS; i += 1) addLink(ids[(i - 1) >> 1]!, ids[i]!, null);
    for (let i = 0; i < 1350; i += 1) {
      addLink(ids[i % STAND_THOUGHTS]!, ids[(i + 1) % STAND_THOUGHTS]!, 'stand-type-1');
      addLink(ids[i % STAND_THOUGHTS]!, ids[(i + 53) % STAND_THOUGHTS]!, 'stand-type-1');
    }
  });
  return { homeId: ids[0]!, parentId: ids[1]! };
}

describe(
  'reader-pool: тяжёлые чтения в воркерах',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let dataDir: string;
    let ndb: NetworkDb;
    let emptyRequest: ThoughtQueryRequest;
    let parentRequest: ThoughtQueryRequest;
    let existsRequest: ThoughtQueryRequest;
    let parentId!: string;

    before(() => {
      dataDir = mkdtempSync(path.join(tmpdir(), 'etn-reader-pool-'));
      configureReaderPool({ size: 1, taskTimeoutMs: 60_000 });
      ndb = openNetworkDb(dataDir, NETWORK_ID);
      const { homeId, parentId: pid } = seedStand(ndb);
      parentId = pid;
      emptyRequest = { sort: 'alpha', order: 'asc', limit: 50, offset: 0 };
      parentRequest = {
        ...emptyRequest,
        subtree: { roots: [homeId], include_roots: false, max_depth: 20, include_inactive_links: false },
      };
      existsRequest = {
        ...emptyRequest,
        properties: [{ property_id: STRUCTURAL_PARENTS_PROPERTY_ID, operator: 'eq', value: parentId }],
      };
    });

    after(async () => {
      await closeReaderPool();
      ndb.close();
      closeAll();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('выборка через пул совпадает с синхронной (items/total/depths/directions)', async () => {
      for (const request of [emptyRequest, existsRequest, parentRequest]) {
        const sync = queryThoughts(ndb, USER, request, { emptyFilterMode: 'home_orphans', includeDirections: true });
        const viaPool = await queryThoughtsAsync(ndb, USER, request, {
          emptyFilterMode: 'home_orphans',
          includeDirections: true,
        });
        assert.deepEqual(viaPool.items, sync.items, 'items выборки совпадают');
        assert.equal(viaPool.total, sync.total, 'total совпадает');
        assert.deepEqual(viaPool.directions, sync.directions, 'directions совпадают');
        assert.deepEqual(
          viaPool.depths === null ? null : [...viaPool.depths].sort(),
          sync.depths === null ? null : [...sync.depths].sort(),
          'depths поддерева совпадают (после round-trip через поток)',
        );
        assert.equal(viaPool.truncated, sync.truncated);
        assert.equal(viaPool.reason, sync.reason);
      }
      // Поддерево реально вернуло глубины — иначе проверка depths вырождена.
      const viaPool = await queryThoughtsAsync(ndb, USER, parentRequest, { emptyFilterMode: 'all' });
      assert.notEqual(viaPool.depths, null);
    });

    it('id-only выборка и поиск совпадают с синхронными', async () => {
      const syncIds = queryThoughts(ndb, USER, emptyRequest, { emptyFilterMode: 'all' }).items.map((i) => i.id);
      const viaPoolIds = await queryThoughtIdsAsync(ndb, USER, emptyRequest, { emptyFilterMode: 'all' });
      assert.deepEqual(viaPoolIds.ids, syncIds);

      const syncSearch = search(ndb, { q: 'Мысль 42' });
      const viaPoolSearch = await searchAsync(ndb, { q: 'Мысль 42' });
      assert.deepEqual(viaPoolSearch, syncSearch);
    });

    it('подграф через пул совпадает с синхронным обходом', async () => {
      const sync = subgraph(ndb, [parentId], 2, { maxNodes: 50 });
      const viaPool = await subgraphAsync(ndb, [parentId], 2, { maxNodes: 50 });
      assert.ok(viaPool.nodes.length > 0, 'обход подграфа вернул узлы');
      assert.deepEqual(viaPool, sync);
    });

    it('тяжёлый запрос не блокирует главный поток (параллельный ping успевает)', async () => {
      const pool = getReaderPool();
      assert.ok(pool !== null, 'процессный пул настроен');

      // Синхронный ориентир: сколько занимает одна тяжёлая выборка в главном
      // потоке. Если бы пул работал в этом же потоке, пинг ждал бы все 15.
      const syncStarted = performance.now();
      queryThoughts(ndb, USER, parentRequest, { emptyFilterMode: 'all' });
      const syncMs = performance.now() - syncStarted;

      const started = performance.now();
      const jobs: Array<Promise<unknown>> = [];
      for (let i = 0; i < 15; i += 1) {
        jobs.push(queryThoughtsAsync(ndb, USER, parentRequest, { emptyFilterMode: 'all' }));
      }
      // Пинг главного потока: ставится в очередь сразу после отправки задач.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const pingLag = performance.now() - started;
      const pendingDuringPing = pool.pending;
      const results = await Promise.all(jobs);
      const totalMs = performance.now() - started;

      console.log(
        `[reader-pool] синхронная выборка=${syncMs.toFixed(1)} мс; ` +
          `15 задач в пуле=${totalMs.toFixed(1)} мс; ping=${pingLag.toFixed(1)} мс; ` +
          `в очереди/на исполнении в момент ping=${pendingDuringPing}`,
      );

      assert.equal(results.length, 15);
      // Пинг обогнал ещё не опустевшую очередь: поток был свободен, пока
      // воркер считал выборку.
      assert.ok(pendingDuringPing > 0, `на момент ping пул обязан ещё работать, pending=${pendingDuringPing}`);
      // И сам пинг быстрый: он не ждал ни одной тяжёлой выборки.
      assert.ok(pingLag < 100, `ping задержался на ${pingLag.toFixed(1)} мс — главный поток блокировался`);
    });

    it('контекст слоя доезжает до воркера: тень дочернего слоя перекрывает основу', async () => {
      const childLayerId = '00000000-0000-4000-8000-0000000000c2';
      const thoughtId = 'layer-shadow-1';
      // Дочерний слой поверх основы + строки одного логического id в обоих
      // слоях: в контексте ребёнка побеждает его тень, в основе — основа.
      ndb.exec(`INSERT INTO layers (id, parent_id, title, is_service, is_base, depth, created_by, created_at, last_activity_at, version)
                VALUES ('${childLayerId}', '${BASE_LAYER_ID}', 'Дочерний', 0, 0, 1, '${USER}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1)`);
      const insertShadow = ndb.prepare(
        `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, active, is_root, marked_for_deletion, version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, NULL, 1, 0, 0, 1, ?, ?, ?, ?, 0, 0)`,
      );
      insertShadow.run(thoughtId, BASE_LAYER_ID, 'Основа A', 'основа a', '2026-01-01T00:00:00Z', USER, '2026-01-01T00:00:00Z', USER);
      insertShadow.run(thoughtId, childLayerId, 'Тень B', 'тень b', '2026-01-01T00:00:00Z', USER, '2026-01-01T00:00:00Z', USER);

      // Строка тени — самая старая в стенде; сортировка по дате создания
      // выводит её в первую страницу в обоих контекстах слоя.
      const readAll: ThoughtQueryRequest = { ...emptyRequest, sort: 'created', order: 'asc', limit: 10 };

      const baseRead = await queryThoughtsAsync(ndb, USER, readAll, { emptyFilterMode: 'all' });
      const childNdb = openNetworkDb(dataDir, NETWORK_ID, undefined, childLayerId);
      const childRead = await queryThoughtsAsync(childNdb, USER, readAll, { emptyFilterMode: 'all' });

      const baseTitle = baseRead.items.find((i) => i.id === thoughtId)?.title;
      const childTitle = childRead.items.find((i) => i.id === thoughtId)?.title;
      assert.equal(baseTitle, 'Основа A', 'соединение основы видит строку основы');
      assert.equal(childTitle, 'Тень B', 'задача дочернего слоя читает тень своего слоя');
    });
  },
);
