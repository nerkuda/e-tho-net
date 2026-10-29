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
 * Цели приёмки тех.проекта: ≤10 мс / ≤1 мс / ≤50 мс. После прогрева снимается
 * `PERF_ITERATIONS` замеров и берётся ЛУЧШИЙ (минимум): `node --test` гоняет
 * сотни файлов параллельно, и планировщик ОС только ДОБАВЛЯЕТ время к замеру.
 * Минимум — оценка собственной стоимости запроса; медиана же сдвигается вместе
 * с загрузкой машины (наблюдалось ×4–5 к чистому замеру) и флейкует у потолка
 * (ошибка 5124f97f). Сравнение идёт с потолком `цель × PERF_CI_TOLERANCE`:
 * производительность зависит от железа CI, жёсткие миллисекунды флапают.
 * Множитель подобран так, чтобы стенд уверенно ловил регресс катастрофического
 * класса (план O(мысли × рёбра): до фикса пустой фильтр ~340 мс, EXISTS ~630 мс —
 * оба выходят за потолок на порядок), но не краснел от разовой задержки
 * планировщика ОС.
 *
 * Замер «EXISTS со COUNT» (этап 4, требование 5adebf61) — не цель спеки, а
 * сопоставимость с замерами этапа 1: тот же фильтр исполняется второй раз для
 * COUNT. Его потолок ОТНОСИТЕЛЬНЫЙ — к EXISTS, замеренному в тех же раундах:
 * оба числа делят загрузку машины, а структурная разница — один дополнительный
 * SQL по тому же фильтру (на незагруженной машине ×1,5). Абсолютный потолок
 * EXISTS-цели для этой пары был ошибкой: COUNT-вариант уходил за 5 мс, хотя
 * EXISTS в том же прогоне оставался заметно ниже (ошибка 5124f97f). Приём
 * «потолок относительно ориентира из того же прогона» — тот же, что в
 * `ping-lag.ts` (абсолютное время под конкуренцией за CPU меряет загрузку
 * планировщика, а не код).
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

import { BASE_LAYER_ID, FILTER_AST_VERSION } from '@etn/shared';

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
/** Целевые миллисекунды тех.проекта (медианы на незагруженной машине). */
const PERF_TARGET_MS = {
  empty: 10,
  exists: 1,
  parent: 50,
  /** AST-листья «Родитель = X»/«Потомок = X» на стенде 1500 (DoD 6d78ccab). */
  astLeaf: 50,
} as const;
/**
 * Крупный стенд ошибки 6d78ccab: 10 тыс. мыслей и ~20 тыс. связей. Отбор по
 * родителю на таком объёме обязан укладываться в ~200 мс — до фикса
 * BFS/EXISTS-план уходил в секунды (исследование 603a8bcb).
 */
const LARGE_STAND_THOUGHTS = 10_000;
const PERF_TARGET_LARGE_MS = { astLeaf: 200 } as const;
/** Запас на разброс железа/загрузки CI (см. шапку файла). */
const PERF_CI_TOLERANCE = 5;
/** Число итераций замера (берётся лучший — минимум). */
const PERF_ITERATIONS = 9;
/**
 * Потолок дополнительного COUNT-прогона относительно EXISTS из тех же раундов:
 * COUNT — второй SQL по тому же фильтру; на чистой машине он стоит ×1,5, под
 * нагрузкой отношение держится (обе величины делят загрузку), поэтому запас
 * ×5 ловит регресс именно COUNT-пути, но не флейкует от планировщика.
 */
const PERF_COUNT_MAX_RATIO = 5;

/**
 * Id структурного свойства «Родители» (направление `in`), созданного миграцией
 * 039 на корневом типе мысли. Условие «Родитель = X» адресует именно его.
 */
const STRUCTURAL_PARENTS_PROPERTY_ID = '00000000-0000-4000-8000-0000000000c1';
/** Тестовый пользователь (сортировка/виды мыслей на стенде не заводятся). */
const STAND_USER = 'perf-user';

/**
 * Лучший из замеров: планировщик ОС и разовые задержки только добавляют время,
 * поэтому минимум — наименее искажённая оценка стоимости самого запроса.
 */
function bestOf(values: number[]): number {
  return values.length === 0 ? 0 : Math.min(...values);
}

/** Замер: прогрев, затем `PERF_ITERATIONS` прогонов, возвращается лучший (мс). */
function measure(run: () => void): number {
  run();
  const samples: number[] = [];
  for (let i = 0; i < PERF_ITERATIONS; i += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return bestOf(samples);
}

/**
 * Парный замер двух вариантов в одних раундах: оба лучших замера сняты в одних
 * и тех же условиях загрузки. Нужен там, где сравнение идёт ОТНОШЕНИЕМ:
 * задержки планировщика ложатся в соседние замеры одного раунда и в отношении
 * сокращаются.
 */
function measurePair(
  first: () => void,
  second: () => void,
): { firstMs: number; secondMs: number } {
  first();
  second();
  const firstSamples: number[] = [];
  const secondSamples: number[] = [];
  for (let i = 0; i < PERF_ITERATIONS; i += 1) {
    let started = performance.now();
    first();
    firstSamples.push(performance.now() - started);
    started = performance.now();
    second();
    secondSamples.push(performance.now() - started);
  }
  return { firstMs: bestOf(firstSamples), secondMs: bestOf(secondSamples) };
}

/** Детали `EXPLAIN QUERY PLAN` запроса как строки. */
function planDetails(ndb: NetworkDb, sql: string, params: unknown[]): string[] {
  return (ndb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(
    (row) => row.detail,
  );
}

/**
 * Запрос с AST-листом по структурному «Родители»/«Потомки» — ровно та форма,
 * которую сохраняет отбор «Родитель = $thought» (DoD ошибки 6d78ccab). Плоские
 * критерии при наличии `ast` игнорируются движком.
 */
function astLeafRequest(
  base: ThoughtQueryRequest,
  kind: 'parents' | 'children',
  value: string,
): ThoughtQueryRequest {
  return {
    ...base,
    ast: {
      version: FILTER_AST_VERSION,
      filter: {
        op: 'and',
        children: [{ entity: { kind }, operator: 'eq', value }],
      },
    },
  };
}

/**
 * Перевести соединение в режим слоя-снапшота: добавить дочерний слой к основе
 * и выбрать его. В этом режиме чтения идут через temp-снапшот видимости
 * (`layer-chain.ts`), а не напрямую по основе — план запросов и его стоимость
 * обязаны остаться прежними (ADR 6582c287).
 */
function seedChildLayer(ndb: NetworkDb): string {
  const layerId = '00000000-0000-4000-8000-0000000000bb';
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, comment, git_branch, is_service, is_base,
                           depth, created_by, created_at, last_activity_at, version)
       VALUES (?, ?, 'Перф-слой', NULL, NULL, 0, 0, 1, ?, ?, ?, 1)`,
    )
    .run(layerId, BASE_LAYER_ID, STAND_USER, now, now);
  ndb.useLayer(layerId);
  return layerId;
}

/** Наполнить базу стенда: дерево структурных рёбер + типизированные рёбра. */
function seedStand(
  ndb: NetworkDb,
  thoughtCount: number = STAND_THOUGHTS,
): { homeId: string; parentId: string } {
  const now = new Date().toISOString();
  const ids: string[] = [];
  for (let i = 0; i < thoughtCount; i += 1) {
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
    for (let i = 0; i < thoughtCount; i += 1) {
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
    for (let i = 1; i < thoughtCount; i += 1) {
      addLink(ids[(i - 1) >> 1]!, ids[i]!, null);
    }
    // Типизированные рёбра по кольцу — добираем объём (на 1500 — до ~5,5 тыс.).
    // На крупном стенде хватает одного кольца на мысль: объём ~2×мыслей.
    const TYPED = 'stand-type-1';
    const typedCount = thoughtCount === STAND_THOUGHTS ? 1350 : thoughtCount;
    for (let i = 0; i < typedCount; i += 1) {
      addLink(ids[i % thoughtCount]!, ids[(i + 1) % thoughtCount]!, TYPED);
      if (thoughtCount === STAND_THOUGHTS) {
        addLink(ids[i % thoughtCount]!, ids[(i + 7) % thoughtCount]!, TYPED);
        addLink(ids[i % thoughtCount]!, ids[(i + 53) % thoughtCount]!, TYPED);
      }
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
        // Этап 4 (требование 5adebf61): тот же EXISTS-отбор с явным COUNT —
        // ровно то, что стенд мерил до перехода на «COUNT по флагу». Оба числа
        // снимаются в одних раундах: COUNT сравнивается с EXISTS отношением,
        // поэтому разброс загрузки машины в нём сокращается (ошибка 5124f97f).
        const { firstMs: existsMs, secondMs: existsCountedMs } = measurePair(
          () => {
            queryThoughts(ndb, STAND_USER, existsRequest, { emptyFilterMode: 'all' });
          },
          () => {
            queryThoughts(ndb, STAND_USER, { ...existsRequest, count: true }, { emptyFilterMode: 'all' });
          },
        );
        const parentMs = measure(() => {
          queryThoughts(ndb, STAND_USER, parentRequest, { emptyFilterMode: 'all' });
        });

        // Диагностика в вывод теста: сырые лучшие замеры против целей тех.проекта.
        const countRatio = existsCountedMs / Math.max(existsMs, 0.01);
        const ceiling = (target: number): number => target * PERF_CI_TOLERANCE;
        console.log(
          `[perf-stand] лучшие мс: пустой=${emptyMs.toFixed(1)} (цель ${PERF_TARGET_MS.empty}, ` +
            `потолок ${ceiling(PERF_TARGET_MS.empty)}), ` +
            `EXISTS=${existsMs.toFixed(2)} (цель ${PERF_TARGET_MS.exists}, потолок ${ceiling(PERF_TARGET_MS.exists)}), ` +
            `родитель=${parentMs.toFixed(1)} (цель ${PERF_TARGET_MS.parent}, потолок ${ceiling(PERF_TARGET_MS.parent)}); ` +
            `EXISTS со COUNT=${existsCountedMs.toFixed(2)} (×${countRatio.toFixed(1)} к EXISTS, ` +
            `потолок ×${PERF_COUNT_MAX_RATIO})`,
        );

        assert.ok(
          emptyMs <= ceiling(PERF_TARGET_MS.empty),
          `пустой фильтр ${emptyMs.toFixed(1)} мс > потолка ${ceiling(PERF_TARGET_MS.empty)} мс`,
        );
        assert.ok(
          existsMs <= ceiling(PERF_TARGET_MS.exists),
          `EXISTS-условие ${existsMs.toFixed(2)} мс > потолка ${ceiling(PERF_TARGET_MS.exists)} мс`,
        );
        // Потолок COUNT-прогона — относительный, с абсолютным полом EXISTS-цели:
        // на незагруженной машине он не слабее прежнего (1 мс × 5), а под
        // нагрузкой растёт вместе с EXISTS, сохраняя смысл проверки.
        const countedCeiling = Math.max(existsMs, PERF_TARGET_MS.exists) * PERF_COUNT_MAX_RATIO;
        assert.ok(
          existsCountedMs <= countedCeiling,
          `EXISTS-условие со COUNT ${existsCountedMs.toFixed(2)} мс > потолка ${countedCeiling.toFixed(2)} мс ` +
            `(EXISTS ${existsMs.toFixed(2)} мс × ${PERF_COUNT_MAX_RATIO})`,
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

    // --- AST-листья «Родитель = X» / «Потомок = X» (DoD ошибки 6d78ccab) ---
    it('AST-листья «Родитель = X» и «Потомок = X» укладываются в потолок 50 мс', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { parentId } = seedStand(ndb);
        const base: ThoughtQueryRequest = { sort: 'alpha', order: 'asc', limit: 100, offset: 0, count: true };
        const parentsEq = astLeafRequest(base, 'parents', parentId);
        // «Потомок = X» адресует мысли, у которых X — ПОТОМОК. `homeId` —
        // корень дерева (потомков у него вверх нет), поэтому значение обязано
        // быть мыслью с родителем: иначе кейс мерил пустой отбор (замечание
        // верификатора круга 2 к 6d78ccab).
        const childrenEq = astLeafRequest(base, 'children', parentId);
        // Непустота обоих отборов — условие вакуумности гейта: время пустого
        // результата не характеризует стоимость AST-листа.
        const parentsProbe = queryThoughts(ndb, STAND_USER, parentsEq, { emptyFilterMode: 'all' });
        const childrenProbe = queryThoughts(ndb, STAND_USER, childrenEq, { emptyFilterMode: 'all' });
        assert.ok(
          (parentsProbe.total ?? 0) > 0,
          `AST «Родитель = X» вернул 0 строк — гейт вакуумный`,
        );
        assert.ok(
          (childrenProbe.total ?? 0) > 0,
          `AST «Потомок = X» вернул 0 строк — гейт вакуумный`,
        );
        const parentsMs = measure(() => {
          queryThoughts(ndb, STAND_USER, parentsEq, { emptyFilterMode: 'all' });
        });
        const childrenMs = measure(() => {
          queryThoughts(ndb, STAND_USER, childrenEq, { emptyFilterMode: 'all' });
        });
        const ceiling = PERF_TARGET_MS.astLeaf * PERF_CI_TOLERANCE;
        console.log(
          `[perf-stand] AST-листья 1500: «Родитель = X»=${parentsMs.toFixed(2)} мс, ` +
            `«Потомок = X»=${childrenMs.toFixed(2)} мс (цель ${PERF_TARGET_MS.astLeaf}, потолок ${ceiling})`,
        );
        assert.ok(
          parentsMs <= ceiling,
          `AST «Родитель = X» ${parentsMs.toFixed(2)} мс > потолка ${ceiling} мс`,
        );
        assert.ok(
          childrenMs <= ceiling,
          `AST «Потомок = X» ${childrenMs.toFixed(2)} мс > потолка ${ceiling} мс`,
        );
      } finally {
        ndb.close();
      }
    });

    // --- Крупный стенд 10k (DoD ошибки 6d78ccab) ---------------------------
    it('на 10 тыс. мыслей AST-листья укладываются в потолок ~200 мс', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { parentId } = seedStand(ndb, LARGE_STAND_THOUGHTS);
        const linkCount = (ndb.prepare('SELECT COUNT(*) AS c FROM links').get() as { c: number }).c;
        assert.ok(
          linkCount >= LARGE_STAND_THOUGHTS * 2 - 10,
          `на крупном стенде ожидалось ~2×10 тыс. связей, получено ${linkCount}`,
        );
        const base: ThoughtQueryRequest = { sort: 'alpha', order: 'asc', limit: 100, offset: 0, count: true };
        const parentsEq = astLeafRequest(base, 'parents', parentId);
        // Непустое значение и ассерт непустоты — как в кейсе 1500: пустой
        // отбор не мерит стоимость AST-листа (замечание круга 2 к 6d78ccab).
        const childrenEq = astLeafRequest(base, 'children', parentId);
        const parentsProbe = queryThoughts(ndb, STAND_USER, parentsEq, { emptyFilterMode: 'all' });
        const childrenProbe = queryThoughts(ndb, STAND_USER, childrenEq, { emptyFilterMode: 'all' });
        assert.ok((parentsProbe.total ?? 0) > 0, 'AST «Родитель = X» на 10k вернул 0 строк');
        assert.ok((childrenProbe.total ?? 0) > 0, 'AST «Потомок = X» на 10k вернул 0 строк');
        const parentsMs = measure(() => {
          queryThoughts(ndb, STAND_USER, parentsEq, { emptyFilterMode: 'all' });
        });
        const childrenMs = measure(() => {
          queryThoughts(ndb, STAND_USER, childrenEq, { emptyFilterMode: 'all' });
        });
        const ceiling = PERF_TARGET_LARGE_MS.astLeaf * PERF_CI_TOLERANCE;
        console.log(
          `[perf-stand] AST-листья 10k/20k: «Родитель = X»=${parentsMs.toFixed(1)} мс, ` +
            `«Потомок = X»=${childrenMs.toFixed(1)} мс (цель ${PERF_TARGET_LARGE_MS.astLeaf}, потолок ${ceiling})`,
        );
        assert.ok(
          parentsMs <= ceiling,
          `AST «Родитель = X» на 10k ${parentsMs.toFixed(1)} мс > потолка ${ceiling} мс`,
        );
        assert.ok(
          childrenMs <= ceiling,
          `AST «Потомок = X» на 10k ${childrenMs.toFixed(1)} мс > потолка ${ceiling} мс`,
        );
      } finally {
        ndb.close();
      }
    });

    // --- Режим слоя-снапшота (DoD ошибки 6d78ccab) -------------------------
    it('режим слоя-снапшота не деградирует: отбор по родителю и AST-листья в потолках', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { homeId, parentId } = seedStand(ndb);
        seedChildLayer(ndb);
        const base: ThoughtQueryRequest = { sort: 'alpha', order: 'asc', limit: 100, offset: 0, count: true };
        const parentRequest: ThoughtQueryRequest = {
          ...base,
          subtree: { roots: [homeId], include_roots: false, max_depth: 20, include_inactive_links: false },
        };
        const parentsEq = astLeafRequest(base, 'parents', parentId);
        // «Потомок = X» — значение с родителем (см. кейс 1500), не пустой отбор.
        const childrenEq = astLeafRequest(base, 'children', parentId);
        const parentsProbe = queryThoughts(ndb, STAND_USER, parentsEq, { emptyFilterMode: 'all' });
        const childrenProbe = queryThoughts(ndb, STAND_USER, childrenEq, { emptyFilterMode: 'all' });
        assert.ok((parentsProbe.total ?? 0) > 0, 'слой-снапшот: «Родитель = X» вернул 0 строк');
        assert.ok((childrenProbe.total ?? 0) > 0, 'слой-снапшот: «Потомок = X» вернул 0 строк');

        const parentMs = measure(() => {
          queryThoughts(ndb, STAND_USER, parentRequest, { emptyFilterMode: 'all' });
        });
        const parentsMs = measure(() => {
          queryThoughts(ndb, STAND_USER, parentsEq, { emptyFilterMode: 'all' });
        });
        const childrenMs = measure(() => {
          queryThoughts(ndb, STAND_USER, childrenEq, { emptyFilterMode: 'all' });
        });
        console.log(
          `[perf-stand] слой-снапшот: родитель=${parentMs.toFixed(1)} мс (потолок ` +
            `${PERF_TARGET_MS.parent * PERF_CI_TOLERANCE}), ` +
            `AST «Родитель = X»=${parentsMs.toFixed(2)}, «Потомок = X»=${childrenMs.toFixed(2)} мс ` +
            `(потолок ${PERF_TARGET_MS.astLeaf * PERF_CI_TOLERANCE})`,
        );
        assert.ok(
          parentMs <= PERF_TARGET_MS.parent * PERF_CI_TOLERANCE,
          `слой-снапшот: отбор по родителю ${parentMs.toFixed(1)} мс > потолка`,
        );
        assert.ok(
          parentsMs <= PERF_TARGET_MS.astLeaf * PERF_CI_TOLERANCE,
          `слой-снапшот: AST «Родитель = X» ${parentsMs.toFixed(2)} мс > потолка`,
        );
        assert.ok(
          childrenMs <= PERF_TARGET_MS.astLeaf * PERF_CI_TOLERANCE,
          `слой-снапшот: AST «Потомок = X» ${childrenMs.toFixed(2)} мс > потолка`,
        );
      } finally {
        ndb.close();
      }
    });
  },
);
