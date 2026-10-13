/**
 * Отбор событий на общий AST (задача 2b230e8e; требования 1765e659 «операнды
 * профиля», 3c91f418 «REST/MCP компилируются в общий AST»).
 *
 * Покрытие:
 *   1. Сценарий 1e54706c «события — изменения за последний час»: тип действия
 *      в [создано, изменено] И время события между `$now-1h` и `$now`.
 *   2. Пограничный: под-выборка «Сущность» без совпадений и период без событий
 *      дают пусто, исполнение не падает.
 *   3. «Сущность» (`entity_id`): равно ИЛИ под-выборка по мыслям (`in`/`not_in`/
 *      `all_of`, обязательный пункт требования 1765e659).
 *   4. Компилятор: плоские параметры и эквивалентный AST дают один набор.
 *   5. XOR `ast` ↔ плоские фильтры; видимость операндов по профилю «события».
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError, FILTER_AST_VERSION, type FilterAst, type FilterAstNode } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  compileActivityToAst,
  listActivity,
  parseActivityListQuery,
  recordActivity,
} from '../src/domain/activity-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const NET = 'net-ast';
const USER = 'user-1';
const NOW_MS = Date.parse('2024-03-15T12:00:00.000Z');

function seedThought(ndb: NetworkDb, title: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             type_id, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 0, 0, NULL, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase());
  return id;
}

function seedEvent(
  ndb: NetworkDb,
  opts: { action: string; entityType: string; entityId: string; userId?: string; atMs: number },
): string {
  recordActivity(ndb, {
    networkId: NET,
    userId: opts.userId ?? USER,
    action: opts.action,
    entityType: opts.entityType,
    entityId: opts.entityId,
    entityTitle: 't',
    layerId: null,
    occurredAtMs: opts.atMs,
  });
  // `recordActivity` id не возвращает — читаем строку по (сеть, время); в тестах
  // `occurred_at_ms` уникален на событие.
  const row = ndb
    .prepare('SELECT id FROM activity_log WHERE network_id = ? AND occurred_at_ms = ?')
    .get(NET, opts.atMs) as { id: string };
  return row.id;
}

function runFilter(
  ndb: NetworkDb,
  filter: FilterAst['filter'],
): string[] {
  const params = parseActivityListQuery(
    { network_id: NET, ast: { version: FILTER_AST_VERSION, filter } },
    'test',
  );
  return listActivity(ndb, params, { userId: USER, nowMs: NOW_MS }).data.map((r) => r.id);
}

/**
 * Клиентский единый конструктор для in-process паритета (задача 16899243):
 * грузим рантайм-импортом по ВЫЧИСЛЯЕМОМУ спецификатору, чтобы tsc сервера
 * (`rootDir: "."`) не тянул клиентский проект; форму держит локальный
 * интерфейс — только методы, нужные тесту.
 */
interface ClientFilterBuilder {
  parseFilterAstState(raw: unknown): Record<string, unknown>;
  buildFilterAst(
    state: Record<string, unknown>,
    opts: { profile?: string; sort?: boolean },
  ): FilterAst;
}

async function loadClientFilterBuilder(): Promise<ClientFilterBuilder> {
  const href = new URL('../../client/src/renderer/lib/filter-builder.js', import.meta.url).href;
  return (await import(href)) as unknown as ClientFilterBuilder;
}

describe('события: отбор на общий AST (задача 2b230e8e)', { skip: !nativeAvailable() }, () => {
  it('сценарий 1e54706c: тип действия [created, updated] И время события между $now-1h и $now', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const t = seedThought(ndb, 'Мысль');
      const recentCreated = seedEvent(ndb, { action: 'created', entityType: 'thought', entityId: t, atMs: NOW_MS - 30 * 60_000 });
      const recentUpdated = seedEvent(ndb, { action: 'updated', entityType: 'thought', entityId: t, atMs: NOW_MS - 10 * 60_000 });
      // Старше часа — вне интервала.
      seedEvent(ndb, { action: 'created', entityType: 'thought', entityId: t, atMs: NOW_MS - 2 * 3600_000 });
      // Действие вне списка — отсеяно.
      seedEvent(ndb, { action: 'deleted', entityType: 'thought', entityId: t, atMs: NOW_MS - 5 * 60_000 });

      const filter: FilterAst['filter'] = {
        op: 'and',
        children: [
          { entity: { kind: 'action' }, operator: 'in', value: ['created', 'updated'] },
          {
            entity: { kind: 'occurred_at' },
            operator: 'between',
            value: [{ token: '$now-1h' }, { token: '$now' }],
          },
        ],
      };
      const ids = runFilter(ndb, filter);
      assert.deepEqual(ids, [recentUpdated, recentCreated], 'за час, по действию, свежие сверху');
    } finally {
      ndb.close();
    }
  });

  it('сценарий 1e54706c: AST, собранный КЛИЕНТСКИМ редактором, сервер исполняет тем же набором', async () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const t = seedThought(ndb, 'Мысль');
      const recentCreated = seedEvent(ndb, { action: 'created', entityType: 'thought', entityId: t, atMs: NOW_MS - 30 * 60_000 });
      const recentUpdated = seedEvent(ndb, { action: 'updated', entityType: 'thought', entityId: t, atMs: NOW_MS - 10 * 60_000 });
      seedEvent(ndb, { action: 'created', entityType: 'thought', entityId: t, atMs: NOW_MS - 2 * 3600_000 });
      seedEvent(ndb, { action: 'deleted', entityType: 'thought', entityId: t, atMs: NOW_MS - 5 * 60_000 });

      // Эталон сценария — тот же AST, что прогоняет предыдущий тест.
      const scenario: FilterAst = {
        version: FILTER_AST_VERSION,
        filter: {
          op: 'and',
          children: [
            { entity: { kind: 'action' }, operator: 'in', value: ['created', 'updated'] },
            {
              entity: { kind: 'occurred_at' },
              operator: 'between',
              value: [{ token: '$now-1h' }, { token: '$now' }],
            },
          ],
        },
      };
      // Единый редактор клиента читает определение и собирает тело заново перед
      // отправкой — токены времени и список действий обязаны выжить без потерь.
      const client = await loadClientFilterBuilder();
      const rebuilt = client.buildFilterAst(client.parseFilterAstState(scenario), {
        profile: 'events',
        sort: false,
      });
      assert.deepEqual(rebuilt, scenario, 'клиентский round-trip сохраняет токены времени и список действий');
      const ids = runFilter(ndb, rebuilt.filter);
      assert.deepEqual(ids, [recentUpdated, recentCreated], 'клиентский AST даёт тот же набор и порядок, что серверный эталон');
    } finally {
      ndb.close();
    }
  });

  it('пограничный: под-выборка «Сущность» без совпадений и пустой период не падают', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const t = seedThought(ndb, 'Мысль');
      seedEvent(ndb, { action: 'created', entityType: 'thought', entityId: t, atMs: NOW_MS - 1000 });

      // Под-выборка по несуществующему id — ноль кандидатов → пусто, без ошибки.
      const emptySub: FilterAst['filter'] = {
        entity: { kind: 'entity_id' },
        operator: 'in',
        value: {
          query: { entity: { kind: 'id' }, operator: 'in', value: [randomUUID()] },
          operator: 'in',
        },
      };
      assert.deepEqual(runFilter(ndb, emptySub), []);

      // Период в будущем — пусто.
      const future: FilterAst['filter'] = {
        entity: { kind: 'occurred_at' },
        operator: 'gte',
        value: NOW_MS + 60_000,
      };
      assert.deepEqual(runFilter(ndb, future), []);
    } finally {
      ndb.close();
    }
  });

  it('«Сущность»: равно ИЛИ под-выборка по мыслям (in/not_in/all_of)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const inside = seedThought(ndb, 'В выборке');
      const outside = seedThought(ndb, 'Вне выборки');
      const evIn = seedEvent(ndb, { action: 'created', entityType: 'thought', entityId: inside, atMs: NOW_MS - 1000 });
      const evOut = seedEvent(ndb, { action: 'created', entityType: 'thought', entityId: outside, atMs: NOW_MS - 2000 });

      const subqueryNode: FilterAstNode = { entity: { kind: 'id' }, operator: 'in', value: [inside] };

      // in — событие внутри под-выборки.
      assert.deepEqual(
        runFilter(ndb, { entity: { kind: 'entity_id' }, operator: 'in', value: { query: subqueryNode, operator: 'in' } }),
        [evIn],
      );
      // not_in — событие вне под-выборки.
      assert.deepEqual(
        runFilter(ndb, { entity: { kind: 'entity_id' }, operator: 'not_in', value: { query: subqueryNode, operator: 'not_in' } }),
        [evOut],
      );
      // all_of — для скалярного entity_id тождественно вхождению.
      assert.deepEqual(
        runFilter(ndb, { entity: { kind: 'entity_id' }, operator: 'all_of', value: { query: subqueryNode, operator: 'all_in' } }),
        [evIn],
      );
      // eq — по конкретному id.
      assert.deepEqual(
        runFilter(ndb, { entity: { kind: 'entity_id' }, operator: 'eq', value: outside }),
        [evOut],
      );
    } finally {
      ndb.close();
    }
  });

  it('компилятор: поля плоского набора переносятся в жёстко заданные AST-эталоны', () => {
    // Независимый эталон: ожидаемые деревья захардкожены (не выведены из самого
    // компилятора), поэтому отключение/подмена любого поля в `compileActivityToAst`
    // роняет тест в unit-наборе (без опоры на real-тест, который SKIP в CI).
    const cases: Array<{ raw: Record<string, unknown>; expected: FilterAst }> = [
      {
        raw: { network_id: NET, from_ms: 1000, to_ms: 2000 },
        expected: {
          version: FILTER_AST_VERSION,
          filter: {
            op: 'and',
            children: [
              { entity: { kind: 'occurred_at' }, operator: 'gte', value: 1000 },
              { entity: { kind: 'occurred_at' }, operator: 'lte', value: 2000 },
            ],
          },
        },
      },
      {
        raw: { network_id: NET, entity_type: 'thought', entity_id: 'E1' },
        expected: {
          version: FILTER_AST_VERSION,
          filter: {
            op: 'and',
            children: [
              { entity: { kind: 'entity_type' }, operator: 'in', value: ['thought'] },
              { entity: { kind: 'entity_id' }, operator: 'eq', value: 'E1' },
            ],
          },
        },
      },
      {
        raw: { network_id: NET, user_id: 'U1' },
        expected: {
          version: FILTER_AST_VERSION,
          filter: { entity: { kind: 'user' }, operator: 'eq', value: 'U1' },
        },
      },
      {
        raw: { network_id: NET },
        expected: { version: FILTER_AST_VERSION, filter: { op: 'and', children: [] } },
      },
    ];
    for (const { raw, expected } of cases) {
      const params = parseActivityListQuery(raw, 't');
      assert.deepEqual(
        compileActivityToAst(params),
        expected,
        `плоский набор ${JSON.stringify(raw)} → AST-эталон`,
      );
    }
  });

  it('компилятор: плоские параметры и эквивалентный AST дают один набор и порядок', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const a = seedThought(ndb, 'A');
      const b = seedThought(ndb, 'B');
      seedEvent(ndb, { action: 'created', entityType: 'thought', entityId: a, atMs: NOW_MS - 5000 });
      seedEvent(ndb, { action: 'updated', entityType: 'thought', entityId: b, atMs: NOW_MS - 4000 });
      seedEvent(ndb, { action: 'updated', entityType: 'thought', entityId: a, atMs: NOW_MS - 3000, userId: 'other' });

      const flat = { network_id: NET, user_id: USER, entity_type: 'thought', limit: 50, offset: 0 };
      const flatParams = parseActivityListQuery(flat, 't');
      const flatIds = listActivity(ndb, flatParams, { userId: USER, nowMs: NOW_MS }).data.map((r) => r.id);

      const ast = compileActivityToAst(flatParams);
      const astIds = listActivity(
        ndb,
        parseActivityListQuery({ network_id: NET, ast }, 't'),
        { userId: USER, nowMs: NOW_MS },
      ).data.map((r) => r.id);

      assert.deepEqual(astIds, flatIds, 'компиляция плоского тела в AST не меняет набор/порядок');
      assert.equal(flatIds.length, 2, 'только события админа');
    } finally {
      ndb.close();
    }
  });

  it('XOR: `ast` несовместим с плоскими фильтрами — VALIDATION_ERROR', () => {
    assert.throws(
      () =>
        parseActivityListQuery(
          { network_id: NET, ast: { version: FILTER_AST_VERSION, filter: { op: 'and', children: [] } }, from_ms: 1 },
          'r',
        ),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR' && /несовместимо/.test(e.message),
    );
    // Пагинация допустима с AST.
    assert.doesNotThrow(() =>
      parseActivityListQuery(
        { network_id: NET, ast: { version: FILTER_AST_VERSION, filter: { op: 'and', children: [] } }, limit: 10, offset: 5 },
        'r',
      ),
    );
  });

  it('видимость по профилю: чужой операнд и чужой оператор отвергаются', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      // Операнд мыслей (`active`) невидим в профиле «события».
      assert.throws(
        () => runFilter(ndb, { entity: { kind: 'active' }, operator: 'eq', value: true } as FilterAst['filter']),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
      // «Время события» — только сравнения/между.
      assert.throws(
        () => runFilter(ndb, { entity: { kind: 'occurred_at' }, operator: 'contains', value: 'x' } as FilterAst['filter']),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
      // Видимый операнд события — без ошибки.
      assert.doesNotThrow(() => runFilter(ndb, { entity: { kind: 'action' }, operator: 'eq', value: 'created' }));
    } finally {
      ndb.close();
    }
  });
});
