/**
 * Perf-стенд горячих запросов выборки мыслей (задача ddc614f9, этап 1
 * тех.проекта e29c0f00; требование 9e8a8fad «Perf-стенд горячих запросов входит
 * в npm test сервера»).
 *
 * На стенде 1500 мыслей и ~5,5 тыс. связей (дерево структурных рёбер +
 * типизированные) проверяются три «горячих» сценария, из-за которых отборы на
 * живой базе уходили в секунды (исследование 603a8bcb, ошибка 6d78ccab):
 *
 *   1. пустой фильтр (режим «HOME + сироты», дефолт витрины «Структуры»);
 *   2. EXISTS-условие по структурному свойству «Родители» (id мысли);
 *   3. отбор по родителю: BFS-обход поддерева + COUNT + страница.
 *
 * Цели приёмки тех.проекта: ≤10 мс / ≤1 мс / ≤50 мс. Измеряется МЕДИАНА
 * нескольких итераций после прогрева, а сравнение идёт с потолком
 * `цель × PERF_CI_TOLERANCE`: производительность зависит от загрузки и железа
 * CI, жёсткие миллисекунды флапают. Множитель подобран так, чтобы стенд уверенно
 * ловил регресс катастрофического класса (план O(мысли × рёбра): до фикса
 * пустой фильтр ~340 мс, EXISTS ~630 мс — оба выходят за потолок на порядок), но
 * не краснел от разовой задержки планировщика ОС.
 *
 * Дополнительно (требование 7da6de92, DoD «план BFS не хуже базового замера»)
 * проверяется, что BFS-запрос обхода идёт индексом, а не полным сканом связей.
 *
 * Статистика планировщика (`ANALYZE`) собирается жизненным циклом открытия
 * базы (требование 239be851) — стенд на этом и строится, отдельного ANALYZE
 * не делает; наличие `sqlite_stat1` подтверждается явно.
 */

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { queryThoughts, type ThoughtQueryRequest } from '../src/domain/query-service.js';

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

/** Размер стенда: мыслей и (примерно) связей. */
const STAND_THOUGHTS = 1500;
/** Целевые миллисекунды тех.проекта (медианы). */
const PERF_TARGET_MS = { empty: 10, exists: 1, parent: 50 } as const;
/** Запас на разброс железа/загрузки CI (см. шапку файла). */
const PERF_CI_TOLERANCE = 5;
/** Число итераций замера (берётся медиана). */
const PERF_ITERATIONS = 9;

/**
 * Id структурного свойства «Родители» (направление `in`), созданного миграцией
 * 039 на корневом типе мысли. Условие «Родитель = X» адресует именно его.
 */
const STRUCTURAL_PARENTS_PROPERTY_ID = '00000000-0000-4000-8000-0000000000c1';
/** Тестовый пользователь (сортировка/виды мыслей на стенде не заводятся). */
const STAND_USER = 'perf-user';

/** Медиана массива чисел. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Замер: прогрев, затем `PERF_ITERATIONS` прогонов, возвращается медиана (мс). */
function measure(run: () => void): number {
  run();
  const samples: number[] = [];
  for (let i = 0; i < PERF_ITERATIONS; i += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

/** Детали `EXPLAIN QUERY PLAN` запроса как строки. */
function planDetails(ndb: NetworkDb, sql: string, params: unknown[]): string[] {
  return (ndb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(
    (row) => row.detail,
  );
}

/** Наполнить базу стенда: дерево структурных рёбер + типизированные рёбра. */
function seedStand(ndb: NetworkDb): { homeId: string; parentId: string } {
  const now = new Date().toISOString();
  const ids: string[] = [];
  for (let i = 0; i < STAND_THOUGHTS; i += 1) {
    ids.push(`stand-${i.toString().padStart(5, '0')}`);
  }
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
      insertThought.run(
        ids[i]!,
        BASE_LAYER_ID,
        `Мысль ${i}`,
        `мысль ${i}`,
        null,
        1,
        i === 0 ? 1 : 0,
        0,
        1,
        now,
        STAND_USER,
        now,
        STAND_USER,
        0,
        0,
      );
    }
    let linkSeq = 0;
    const seen = new Set<string>();
    const addLink = (source: string, target: string, typeId: string | null): void => {
      const key = `${source}\u0000${target}\u0000${typeId ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      insertLink.run(
        `stand-link-${linkSeq++}`,
        BASE_LAYER_ID,
        source,
        target,
        typeId,
        linkSeq,
        1,
        0,
        1,
        now,
        now,
        STAND_USER,
        STAND_USER,
        0,
        0,
      );
    };
    // Дерево структурных (нетипизированных) рёбер: parent = (i-1) >> 1.
    for (let i = 1; i < STAND_THOUGHTS; i += 1) {
      addLink(ids[(i - 1) >> 1]!, ids[i]!, null);
    }
    // Типизированные рёбра по кольцу — добираем объём до ~5,5 тыс.
    const TYPED = 'stand-type-1';
    for (let i = 0; i < 1350; i += 1) {
      addLink(ids[i % STAND_THOUGHTS]!, ids[(i + 1) % STAND_THOUGHTS]!, TYPED);
      addLink(ids[i % STAND_THOUGHTS]!, ids[(i + 7) % STAND_THOUGHTS]!, TYPED);
      addLink(ids[i % STAND_THOUGHTS]!, ids[(i + 53) % STAND_THOUGHTS]!, TYPED);
    }
  });

  return { homeId: ids[0]!, parentId: ids[1]! };
}

describe(
  'perf: горячие выборки мыслей на стенде 1500/5500',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('целевые сценарии укладываются в потолки, BFS идёт индексом', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { homeId, parentId } = seedStand(ndb);

        // Статистика планировщика собрана жизненным циклом открытия базы.
        const statTable = ndb
          .prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'")
          .get() as { name: string } | undefined;
        assert.ok(statTable, 'ANALYZE в конце миграций обязан собрать sqlite_stat1');

        const linkCount = (ndb.prepare('SELECT COUNT(*) AS c FROM links').get() as { c: number }).c;
        assert.ok(linkCount >= 5000, `на стенде ожидалось ~5,5 тыс. связей, получено ${linkCount}`);

        const emptyRequest: ThoughtQueryRequest = { sort: 'alpha', order: 'asc', limit: 100, offset: 0 };
        const existsRequest: ThoughtQueryRequest = {
          ...emptyRequest,
          properties: [
            { property_id: STRUCTURAL_PARENTS_PROPERTY_ID, operator: 'eq', value: parentId },
          ],
        };
        const parentRequest: ThoughtQueryRequest = {
          ...emptyRequest,
          subtree: { roots: [homeId], include_roots: false, max_depth: 20, include_inactive_links: false },
        };

        const emptyMs = measure(() => {
          queryThoughts(ndb, STAND_USER, emptyRequest, { emptyFilterMode: 'home_orphans' });
        });
        const existsMs = measure(() => {
          queryThoughts(ndb, STAND_USER, existsRequest, { emptyFilterMode: 'all' });
        });
        const parentMs = measure(() => {
          queryThoughts(ndb, STAND_USER, parentRequest, { emptyFilterMode: 'all' });
        });

        // Диагностика в вывод теста: сырые медианы против целей тех.проекта.
        console.log(
          `[perf-stand] медианы мс: пустой=${emptyMs.toFixed(1)} (цель ${PERF_TARGET_MS.empty}), ` +
            `EXISTS=${existsMs.toFixed(2)} (цель ${PERF_TARGET_MS.exists}), ` +
            `родитель=${parentMs.toFixed(1)} (цель ${PERF_TARGET_MS.parent}); ` +
            `потолок = цель × ${PERF_CI_TOLERANCE}`,
        );

        const ceiling = (target: number): number => target * PERF_CI_TOLERANCE;
        assert.ok(
          emptyMs <= ceiling(PERF_TARGET_MS.empty),
          `пустой фильтр ${emptyMs.toFixed(1)} мс > потолка ${ceiling(PERF_TARGET_MS.empty)} мс`,
        );
        assert.ok(
          existsMs <= ceiling(PERF_TARGET_MS.exists),
          `EXISTS-условие ${existsMs.toFixed(2)} мс > потолка ${ceiling(PERF_TARGET_MS.exists)} мс`,
        );
        assert.ok(
          parentMs <= ceiling(PERF_TARGET_MS.parent),
          `отбор по родителю ${parentMs.toFixed(1)} мс > потолка ${ceiling(PERF_TARGET_MS.parent)} мс`,
        );

        // DoD: план BFS-обхода поддерева не деградировал до полного скана связей.
        const bfsPlan = planDetails(
          ndb,
          'SELECT l.target_id AS nid FROM links_v l WHERE l.source_id = ? AND (l.active = 1 OR ?)',
          [homeId, 0],
        );
        assert.ok(
          bfsPlan.some((detail) => /SEARCH .* USING (COVERING )?INDEX/i.test(detail)),
          `BFS-обход обязан идти индексом, план: ${bfsPlan.join(' | ')}`,
        );
        assert.ok(
          !bfsPlan.some((detail) => /SCAN (l|links)\b/i.test(detail)),
          `BFS-обход не должен сканировать таблицу связей целиком, план: ${bfsPlan.join(' | ')}`,
        );
      } finally {
        ndb.close();
      }
    });
  },
);
