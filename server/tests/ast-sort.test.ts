/**
 * Исполнение `ast.sort` — многоуровневая сортировка отбора (задача 3a157e66;
 * требование 3e47f52a «многоуровневая, направление на каждый ключ», сущность
 * 489c394f «Сортировка — отдельное поле корня»).
 *
 * Проверяется единый движок и фасады:
 *   * многоуровневый `sort: [{ key, order }, …]` — порядок ключей = порядок
 *     объявления, направление на каждый ключ (REST `POST /thoughts/query`,
 *     MCP `etn.thoughts.query` — ограничение «один ключ» снято);
 *   * ключи-свойства (по `property_id`/имени), по булевым — ложь раньше истины,
 *     пустые значения свойства — в конце;
 *   * детерминистичный добор `id` при равных ключах (стабильная пагинация);
 *   * конфликт `ast.sort` и внешних `sort`/`order` — `VALIDATION_ERROR`
 *     (конвенция задачи cb78315b «оставьте один источник»);
 *   * неизвестный ключ / свойство-связь — `VALIDATION_ERROR`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { mcpRequestToQuery, queryThoughts } from '../src/domain/query-service.js';
import { createTypeProperty, getNetworkPropertyByName } from '../src/domain/property-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createThoughtTypeView, getThoughtTypeView, runViewForThought } from '../src/domain/thought-type-views-service.js';
import { FILTER_AST_VERSION, type FilterAst, type FilterAstSortKey } from '@etn/shared';
import { authHeaders, buildRestContext, closeRestContext } from './rest-helpers.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function seedThought(
  ndb: NetworkDb,
  title: string,
  opts: { type_id?: string | null; created_at?: string } = {},
): string {
  const id = randomUUID();
  const at = opts.created_at ?? '2024-01-01T00:00:00.000Z';
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 0, 1, ?, 'u', ?, 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase(), opts.type_id ?? null, at, at);
  return id;
}

function seedProperty(ndb: NetworkDb, thoughtId: string, propertyId: string, column: string, value: string | number): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, ${column}, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

/** Прогнать AST-отбор через движок, вернуть заголовки страницы. */
function runTitles(
  ndb: NetworkDb,
  sort: FilterAstSortKey[],
  opts: { limit?: number; offset?: number } = {},
): string[] {
  const ast: FilterAst = { version: FILTER_AST_VERSION, filter: { op: 'and', children: [] }, sort };
  const res = queryThoughts(
    ndb,
    'u',
    { sort: 'alpha', order: 'asc', limit: opts.limit ?? 100, offset: opts.offset ?? 0, count: true, ast },
    { emptyFilterMode: 'all', maxLimit: 2000 },
  );
  return res.items.map((i) => i.title);
}

describe(
  '3a157e66: ast.sort — многоуровневая сортировка отбора',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('многоуровневая: ключ-свойство ↑ затем created_at ↓; пустые значения — в конце', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'Задача' }, 'u').id;
        createTypeProperty(ndb, 'thought_type', type, { key: 'Срок', value_type: 'date' }, 'u');
        const srok = getNetworkPropertyByName(ndb, 'Срок')!.id;

        const a = seedThought(ndb, 'A', { type_id: type, created_at: '2024-03-01T00:00:00.000Z' });
        const b = seedThought(ndb, 'B', { type_id: type, created_at: '2024-01-10T00:00:00.000Z' });
        seedThought(ndb, 'X', { type_id: type, created_at: '2024-01-01T00:00:00.000Z' });
        seedThought(ndb, 'C', { type_id: type, created_at: '2024-02-01T00:00:00.000Z' });
        seedProperty(ndb, a, srok, 'value_date', '2024-03-01');
        seedProperty(ndb, b, srok, 'value_date', '2024-01-10');

        // Срок ↑ (B 01-10, A 03-01), затем created_at ↓ внутри пустой группы (C 02-01, X 01-01).
        assert.deepEqual(
          runTitles(ndb, [
            { key: 'Срок', order: 'asc' },
            { key: 'created_at', order: 'desc' },
          ]),
          ['B', 'A', 'C', 'X'],
        );
        // Смена направления ключа-свойства меняет порядок заполненной группы, пустые по-прежнему в конце.
        assert.deepEqual(
          runTitles(ndb, [
            { key: 'Срок', order: 'desc' },
            { key: 'created_at', order: 'asc' },
          ]),
          ['A', 'B', 'X', 'C'],
        );
      } finally {
        ndb.close();
      }
    });

    it('фиксированный ключ и адресация свойства по property_id; по булевым ложь раньше истины', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'Задача' }, 'u').id;
        createTypeProperty(ndb, 'thought_type', type, { key: 'Готово', value_type: 'bool' }, 'u');
        const done = getNetworkPropertyByName(ndb, 'Готово')!.id;

        const t1 = seedThought(ndb, 'Готово', { type_id: type });
        const t2 = seedThought(ndb, 'Не готово', { type_id: type });
        const t3 = seedThought(ndb, 'Без значения', { type_id: type });
        seedProperty(ndb, t1, done, 'value_bool', 1);
        seedProperty(ndb, t2, done, 'value_bool', 0);

        // Адресация по property_id; asc: ложь(0) → истина(1) → пусто.
        assert.deepEqual(runTitles(ndb, [{ key: done, order: 'asc' }]), ['Не готово', 'Готово', 'Без значения']);
        assert.deepEqual(runTitles(ndb, [{ key: done, order: 'desc' }]), ['Готово', 'Не готово', 'Без значения']);
        // created_at как фиксированный ключ.
        assert.deepEqual(runTitles(ndb, [{ key: 'created_at', order: 'desc' }]).length, 3);
        void t3;
      } finally {
        ndb.close();
      }
    });

    it('равные ключи детерминированы добором id; пагинация без пропусков и дублей', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        for (const t of ['A', 'B', 'C', 'D', 'E']) seedThought(ndb, t, { created_at: '2024-01-01T00:00:00.000Z' });
        const sort: FilterAstSortKey[] = [{ key: 'created_at', order: 'asc' }];
        const full1 = runTitles(ndb, sort);
        const full2 = runTitles(ndb, sort);
        assert.deepEqual(full1, full2, 'порядок при равных ключах детерминирован');
        assert.deepEqual([...full1].sort(), ['A', 'B', 'C', 'D', 'E'], 'набор — все мысли');
        // Пагинация: склейка страниц равна сплошной выдаче.
        const paged = [...runTitles(ndb, sort, { limit: 2, offset: 0 }), ...runTitles(ndb, sort, { limit: 2, offset: 2 }), ...runTitles(ndb, sort, { limit: 2, offset: 4 })];
        assert.deepEqual(paged, full1, 'страницы без пропусков и дублей');
      } finally {
        ndb.close();
      }
    });

    it('MCP: многоуровневый ast.sort принимается; конфликт с sort/order — VALIDATION_ERROR', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        createThoughtType(ndb, { name: 'Задача' }, 'u');
        const ast: FilterAst = {
          version: FILTER_AST_VERSION,
          filter: { op: 'and', children: [] },
          sort: [
            { key: 'created_at', order: 'desc' },
            { key: 'title', order: 'asc' },
          ],
        };
        // Ограничение «ровно один ключ» снято — адаптер принимает набор.
        const canon = mcpRequestToQuery({ ast }, { maxNodes: 100 });
        assert.deepEqual(canon.ast?.sort, ast.sort);
        // Два источника порядка — конфликт.
        assert.throws(
          () => mcpRequestToQuery({ ast, sort: 'created_at' }, { maxNodes: 100 }),
          /VALIDATION_ERROR|дважды/,
        );
      } finally {
        ndb.close();
      }
    });

    it('удалённый ключ-свойство → красная диагностика с именем; свойство-связь — VALIDATION_ERROR', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'Задача' }, 'u').id;
        createTypeProperty(ndb, 'thought_type', type, { key: 'Срок', value_type: 'date' }, 'u');
        // Ключ-свойство удалён из реестра: красная диагностика (requirement 3e47f52a),
        // а не generic VALIDATION_ERROR движка. Причина и имя — в details/message.
        const prop = getNetworkPropertyByName(ndb, 'Срок')!;
        ndb.prepare('DELETE FROM type_properties WHERE property_id = ?').run(prop.id);
        ndb.prepare('DELETE FROM properties WHERE id = ?').run(prop.id);
        let reason: string | undefined;
        let label: string | undefined;
        try {
          runTitles(ndb, [{ key: 'Срок', order: 'asc' }]);
        } catch (e) {
          const err = e as { details?: { reason?: string }; message?: string };
          reason = err.details?.reason;
          label = err.message;
        }
        assert.equal(reason, 'filter_entity_deleted', 'красная диагностика, не generic-ошибка');
        assert.match(String(label), /Срок/, 'имя удалённого правила — в сообщении');

        // Существующее свойство-связь сортировать нечем — честная ошибка движка.
        const lt = createLinkType(ndb, { name_forward: 'зависит от', name_reverse: 'нужен для' }, 'u').id;
        createTypeProperty(
          ndb,
          'thought_type',
          type,
          { key: 'Связь', value_type: 'link', config: { link_type_id: lt, direction: 'out' } },
          'u',
        );
        assert.throws(() => runTitles(ndb, [{ key: 'зависит от', order: 'asc' }]), /связ/);
      } finally {
        ndb.close();
      }
    });

    it('views run: отбор типа с AST-сортировкой исполняет ast.sort (REST views run)', async () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'Задача' }, 'u').id;
        const ctxThought = seedThought(ndb, 'Контекст', { type_id: type, created_at: '2023-01-01T00:00:00.000Z' });
        seedThought(ndb, 'A', { type_id: type, created_at: '2024-03-01T00:00:00.000Z' });
        seedThought(ndb, 'B', { type_id: type, created_at: '2024-01-10T00:00:00.000Z' });
        seedThought(ndb, 'C', { type_id: type, created_at: '2024-02-01T00:00:00.000Z' });

        const definition = JSON.stringify({
          version: FILTER_AST_VERSION,
          filter: { op: 'and', children: [{ entity: { kind: 'type' }, operator: 'in', value: [type] }] },
          sort: [{ key: 'created_at', order: 'desc' }],
        } satisfies FilterAst);
        const view = createThoughtTypeView(ndb, type, { name: 'Работы', definition, is_default: true }, 'u');
        const run = await runViewForThought(ndb, getThoughtTypeView(ndb, view.id)!, ctxThought, 'u');
        assert.deepEqual(run.items.map((i) => i.title), ['A', 'C', 'B'], 'ast.sort применён (created_at desc)');
      } finally {
        ndb.close();
      }
    });

    it('keyset-курсор сверяется с фактическим ast.sort: чужой порядок отвергнут, страница 2 без дублей', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        for (const [t, at] of [
          ['A', '2024-01-01T00:00:00.000Z'],
          ['B', '2024-02-01T00:00:00.000Z'],
          ['C', '2024-03-01T00:00:00.000Z'],
        ] as const) {
          seedThought(ndb, t, { created_at: at });
        }
        const ast = (sort: FilterAstSortKey[]): FilterAst => ({
          version: FILTER_AST_VERSION,
          filter: { op: 'and', children: [] },
          sort,
        });
        const q = (sort: FilterAstSortKey[], cursor?: string) =>
          queryThoughts(
            ndb,
            'u',
            {
              sort: 'alpha',
              order: 'asc',
              limit: 2,
              offset: 0,
              count: true,
              ast: ast(sort),
              ...(cursor !== undefined ? { cursor } : {}),
            },
            { emptyFilterMode: 'all', maxLimit: 100 },
          );

        const asc = [{ key: 'created_at', order: 'asc' }] as FilterAstSortKey[];
        const page1 = q(asc);
        assert.deepEqual(page1.items.map((i) => i.title), ['A', 'B']);
        assert.ok(page1.next_cursor, 'есть курсор продолжения');

        // Курсор от asc под desc-сортировкой → ошибка (чужой порядок).
        assert.throws(
          () => q([{ key: 'created_at', order: 'desc' }] as FilterAstSortKey[], page1.next_cursor!),
          /курсор/i,
        );

        // Тот же порядок → страница 2 продолжает без дублей/пропусков.
        const page2 = q(asc, page1.next_cursor!);
        assert.deepEqual(page2.items.map((i) => i.title), ['C']);
        const seen = [...page1.items, ...page2.items].map((i) => i.title);
        assert.deepEqual([...new Set(seen)], ['A', 'B', 'C']);

        // Ключи-свойства одного вида на одном индексе: подпись обязана различать
        // ИДЕНТИЧНОСТЬ свойства — курсор от «Срок» не принимается под «Дедлайн».
        const type = createThoughtType(ndb, { name: 'Задача' }, 'u').id;
        createTypeProperty(ndb, 'thought_type', type, { key: 'Срок', value_type: 'date' }, 'u');
        createTypeProperty(ndb, 'thought_type', type, { key: 'Дедлайн', value_type: 'date' }, 'u');
        const bySrok = q([{ key: 'Срок', order: 'asc' }] as FilterAstSortKey[]);
        assert.ok(bySrok.next_cursor, 'курсор по свойству-ключу есть');
        assert.throws(
          () => q([{ key: 'Дедлайн', order: 'asc' }] as FilterAstSortKey[], bySrok.next_cursor!),
          /курсор/i,
        );
      } finally {
        ndb.close();
      }
    });

    it('views run: явный body order переопределяет ast.sort определения (контракт 95273103)', async () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'Задача' }, 'u').id;
        const ctxThought = seedThought(ndb, 'Контекст', { type_id: type, created_at: '2023-01-01T00:00:00.000Z' });
        seedThought(ndb, 'A', { type_id: type, created_at: '2024-03-01T00:00:00.000Z' });
        seedThought(ndb, 'B', { type_id: type, created_at: '2024-01-10T00:00:00.000Z' });
        seedThought(ndb, 'C', { type_id: type, created_at: '2024-02-01T00:00:00.000Z' });

        const definition = JSON.stringify({
          version: FILTER_AST_VERSION,
          filter: { op: 'and', children: [{ entity: { kind: 'type' }, operator: 'in', value: [type] }] },
          sort: [{ key: 'created_at', order: 'desc' }],
        } satisfies FilterAst);
        const view = createThoughtTypeView(ndb, type, { name: 'Работы', definition, is_default: true }, 'u');
        const saved = getThoughtTypeView(ndb, view.id)!;

        // Без тела — определение (desc).
        const byDef = await runViewForThought(ndb, saved, ctxThought, 'u');
        assert.deepEqual(byDef.items.map((i) => i.title), ['A', 'C', 'B']);
        // Тело order=asc переопределяет направление сохранённого ключа.
        const byBody = await runViewForThought(ndb, saved, ctxThought, 'u', undefined, { order: 'asc' });
        assert.deepEqual(byBody.items.map((i) => i.title), ['B', 'C', 'A'], 'тело переопределяет определение');
      } finally {
        ndb.close();
      }
    });

    it('REST: многоуровневый ast.sort применён; конфликт с полем sort — 422', async (t) => {
      const ctx = await buildRestContext();
      t.after(async () => closeRestContext(ctx));
      const type = createThoughtType(ctx.ndb, { name: 'Задача' }, 'u').id;
      createTypeProperty(ctx.ndb, 'thought_type', type, { key: 'Срок', value_type: 'date' }, 'u');
      const srok = getNetworkPropertyByName(ctx.ndb, 'Срок')!.id;
      const a = seedThought(ctx.ndb, 'A', { type_id: type, created_at: '2024-03-01T00:00:00.000Z' });
      const b = seedThought(ctx.ndb, 'B', { type_id: type, created_at: '2024-01-10T00:00:00.000Z' });
      seedProperty(ctx.ndb, a, srok, 'value_date', '2024-03-01');
      seedProperty(ctx.ndb, b, srok, 'value_date', '2024-01-10');

      const post = async (payload: Record<string, unknown>) =>
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/query`,
          headers: authHeaders(ctx),
          payload,
        });

      const ok = await post({
        ast: {
          version: FILTER_AST_VERSION,
          filter: { op: 'and', children: [{ entity: { kind: 'type' }, operator: 'in', value: [type] }] },
          sort: [
            { key: 'Срок', order: 'desc' },
            { key: 'created_at', order: 'asc' },
          ],
        },
      });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.deepEqual((ok.json().data as Array<{ title: string }>).map((i) => i.title), ['A', 'B']);

      const conflict = await post({
        ast: { version: FILTER_AST_VERSION, filter: { op: 'and', children: [] }, sort: [{ key: 'title', order: 'asc' }] },
        sort: 'created',
      });
      assert.equal(conflict.statusCode, 422, conflict.body);
      assert.equal((conflict.json().error as { code: string }).code, 'VALIDATION_ERROR');
    });
  },
);
