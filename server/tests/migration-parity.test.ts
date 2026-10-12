/**
 * Миграция `definition v1` → AST и конверсия выборок по типу в «Тип в иерархии»
 * (задача 4be62d42, релиз 0.13.1).
 *
 * Конвертация v1 → AST при чтении уже реализована единым входом движка
 * (сдача c13762b1 / T7): плоские критерии компилируются в AST, `saved_filters`
 * остаются в v1 на хранении. Этот файл закрывает замыкающую задачу проверками
 * поведения, которые миграция обязана сохранить:
 *
 *   1. Плоская выборка по `type_ids` (тип-родитель) даёт то же МНОЖЕСТВО, что
 *      тип + его подтипы: компилятор превращает плоский `type_ids` в лист
 *      «Тип в иерархии» (`entity.type` + `in_hierarchy`, требование f7f93c32,
 *      ADR 9a356460), а подтипы раскрывает исполнитель на момент запроса. Тест
 *      отдельно фиксирует ФОРМУ компиляции (`in_hierarchy`, значение — только
 *      переданные корни) и доказывает, что новый подтип, появившийся ПОСЛЕ
 *      сохранения/компиляции отбора, попадает в результат.
 *   2. Сохранённое тело v1 `saved_filters` вида «Структуры» читается обратно и
 *      исполняется `POST /thoughts/query` с прежним набором id.
 *   3. Сохранённое тело v1 `saved_filters` вида «Хроника» исполняется
 *      `POST /chronicle/query` прежним набором записей (быстрая форма
 *      `thought_ids` + поддерево и структурная форма `targets`).
 *
 * Проверка на РЕАЛЬНЫХ данных сетей (A/B до/после и раскрытие подтипов) —
 * `migration-parity.real.test.ts`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createComment } from '../src/domain/comment-service.js';
import { compileThoughtQueryToAst, queryThoughts, structureRequestToQuery } from '../src/domain/query-service.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  type RestTestContext,
} from './rest-helpers.js';
import type { FilterAstLeaf, FilterAstNode, SavedFilter } from '@etn/shared';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Вставить мысль прямым SQL (фикстуре важны только тип/актуальность). */
function insertThought(
  ndb: NetworkDb,
  title: string,
  opts: { type_id?: string | null; active?: number } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 0, 0, 1, '2024-01-01T00:00:00.000Z', 'u', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase(), opts.type_id ?? null, opts.active ?? 1);
  return id;
}

/** Вставить тип мысли прямым SQL (подтипу задаём parent_id). */
function insertThoughtType(ndb: NetworkDb, name: string, parentId: string | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, parent_id, name, name_key, version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, lower(?), 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, parentId, name, name);
  return id;
}

function insertLink(ndb: NetworkDb, sourceId: string, targetId: string): void {
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, NULL, 1, 0, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(randomUUID(), sourceId, targetId);
}

/** Плоская выборка «Структур» через единый движок (как REST → канон). */
function flatQueryIds(ndb: NetworkDb, filter: Record<string, unknown>): string[] {
  const req = structureRequestToQuery({
    sort: 'alpha',
    order: 'asc',
    limit: 200,
    offset: 0,
    count: true,
    ...(filter as Record<string, never>),
  });
  return queryThoughts(ndb, 'u', req, { emptyFilterMode: 'all', maxLimit: 200 }).items.map((i) => i.id);
}

/** Собрать все листья дерева отбора (для проверки формы компиляции). */
function collectLeaves(node: FilterAstNode): FilterAstLeaf[] {
  if ('op' in node) return node.children.flatMap(collectLeaves);
  return [node];
}

describe(
  '4be62d42: миграция definition v1 → AST — поведение конвертации сохранено',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('плоский type_ids по типу-родителю включает подтипы (конверсия в «Тип в иерархии»)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const parent = insertThoughtType(ndb, 'категория');
        const child = insertThoughtType(ndb, 'подкатегория', parent);
        const grandchild = insertThoughtType(ndb, 'под-подкатегория', child);
        const other = insertThoughtType(ndb, 'софт');

        const tParent = insertThought(ndb, 'Тип родителя', { type_id: parent });
        const tChild = insertThought(ndb, 'Тип ребёнка', { type_id: child });
        const tGrand = insertThought(ndb, 'Тип внука', { type_id: grandchild });
        const tOther = insertThought(ndb, 'Чужой тип', { type_id: other });

        const byParent = new Set(flatQueryIds(ndb, { type_ids: [parent] }));
        assert.deepEqual(
          [...byParent].sort(),
          [tParent, tChild, tGrand].sort(),
          'плоский type_ids:[родитель] = родитель + все потомки',
        );
        assert.ok(!byParent.has(tOther), 'чужой тип не попадает');

        // Выборка по подтипу — только его поддерево, без старших.
        assert.deepEqual(
          [...new Set(flatQueryIds(ndb, { type_ids: [child] }))].sort(),
          [tChild, tGrand].sort(),
          'плоский type_ids:[подтип] = подтип + его потомки',
        );

        // ФОРМА компиляции (ADR 9a356460): плоский type_ids → лист «Тип в
        // иерархии» (`in_hierarchy`), значение — только переданные корни, без
        // замороженного списка подтипов (его раскрывает исполнитель).
        const compiled = compileThoughtQueryToAst(ndb, structureRequestToQuery({
          type_ids: [parent], sort: 'alpha', order: 'asc', limit: 100, offset: 0, count: true,
        }));
        assert.ok(compiled, 'компилятор обязан вернуть дерево');
        const typeLeaf = collectLeaves(compiled!.filter).find((l) => l.entity.kind === 'type');
        assert.ok(typeLeaf, 'в дереве обязан быть лист операнда «Тип»');
        assert.equal(typeLeaf!.operator, 'in_hierarchy', 'плоский type_ids компилируется в «Тип в иерархии»');
        assert.deepEqual(typeLeaf!.value, [parent], 'значение — только переданные корни (подтипы не заморожены)');
      } finally {
        ndb.close();
      }
    });

    it('новый подтип, появившийся после компиляции отбора, попадает в результат (иерархия считается при исполнении)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const parent = insertThoughtType(ndb, 'водитель');
        const existingSub = insertThoughtType(ndb, 'штатный водитель', parent);
        const tParent = insertThought(ndb, 'Водитель', { type_id: parent });
        const tExisting = insertThought(ndb, 'Штатный', { type_id: existingSub });

        // Компилируем отбор при уже существующем подтипе: в значении листа —
        // ТОЛЬКО корень, ни одного подтипа (иначе список заморожен).
        const flat = structureRequestToQuery({
          type_ids: [parent], sort: 'alpha', order: 'asc', limit: 100, offset: 0, count: true,
        });
        const compiled = compileThoughtQueryToAst(ndb, flat);
        assert.ok(compiled);
        const typeLeaf = collectLeaves(compiled!.filter).find((l) => l.entity.kind === 'type');
        assert.deepEqual(typeLeaf!.value, [parent], 'в скомпилированном листе только корень');

        // Новый подтип появляется ПОСЛЕ компиляции отбора.
        const newSub = insertThoughtType(ndb, 'наёмный водитель', parent);
        const tNew = insertThought(ndb, 'Наёмный', { type_id: newSub });

        // Исполняем ранее скомпилированное дерево — иерархия вычисляется на
        // момент запроса, новый подтип обязан попасть (замороженный список его
        // бы потерял).
        const res = queryThoughts(ndb, 'u', { ...flat, ast: compiled! }, { emptyFilterMode: 'all', maxLimit: 100 });
        const ids = new Set(res.items.map((i) => i.id));
        assert.ok(ids.has(tParent), 'мысль корневого типа в результате');
        assert.ok(ids.has(tExisting), 'мысль подтипа, существовавшего при компиляции, в результате');
        assert.ok(ids.has(tNew), 'мысль НОВОГО подтипа, появившегося после компиляции, в результате');
      } finally {
        ndb.close();
      }
    });

    it('сохранённый v1-отбор «Структур» читается и исполняется POST /thoughts/query прежним набором', async (t) => {
      const ctx: RestTestContext = await buildRestContext();
      t.after(async () => closeRestContext(ctx));
      try {
        const typeRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types`,
          headers: authHeaders(ctx),
          payload: { name: 'персона' },
        });
        assert.equal(typeRes.statusCode, 201, typeRes.body);
        const typeId = (typeRes.json().data as { id: string }).id;
        const subtypeId = insertThoughtType(ctx.ndb, 'сотрудник', typeId);

        const person = insertThought(ctx.ndb, 'Иванов', { type_id: typeId });
        const employee = insertThought(ctx.ndb, 'Петров', { type_id: subtypeId });
        const other = insertThought(ctx.ndb, 'Смета');

        // Тело v1 сохраняем как saved_filter «Структур» и читаем обратно.
        const create = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/saved-filters`,
          headers: authHeaders(ctx),
          payload: {
            name: 'Все персоны',
            definition: { type_ids: [typeId], sort: 'alpha', order: 'asc' },
          },
        });
        assert.equal(create.statusCode, 201, create.body);

        const list = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/saved-filters?view=structures`,
          headers: authHeaders(ctx),
        });
        assert.equal(list.statusCode, 200);
        const stored = (list.json().data as SavedFilter[]).find((f) => f.name === 'Все персоны');
        assert.ok(stored, 'сохранённый отбор читается обратно');

        // Клиент исполняет сохранённое тело через POST /thoughts/query.
        const run = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/query`,
          headers: authHeaders(ctx),
          payload: { count: true, ...(stored!.definition as unknown as Record<string, unknown>) },
        });
        assert.equal(run.statusCode, 200, run.body);
        const ids = (run.json().data as Array<{ id: string }>).map((x) => x.id);
        assert.deepEqual(
          [...new Set(ids)].sort(),
          [person, employee].sort(),
          'v1-тело исполняется прежним набором (родитель + подтип), чужой тип не попадает',
        );
        assert.ok(!ids.includes(other));
      } finally {
        // контекст закрывается в t.after
      }
    });

    it('сохранённый v1-отбор «Хроники» исполняется POST /chronicle/query прежним набором (быстрая форма + targets)', async (t) => {
      const ctx: RestTestContext = await buildRestContext();
      t.after(async () => closeRestContext(ctx));
      const ndb = ctx.ndb;

      const root = insertThought(ndb, 'Раздел');
      const child = insertThought(ndb, 'Подраздел');
      const outsider = insertThought(ndb, 'Мимо');
      insertLink(ndb, root, child);

      createComment(ndb, 'thought', root, { kind: 'chronological', body_md: 'запись корня', valid_from: '2024-01-01' }, 'u');
      createComment(ndb, 'thought', child, { kind: 'chronological', body_md: 'запись потомка', valid_from: '2024-01-02' }, 'u');
      createComment(ndb, 'thought', outsider, { kind: 'chronological', body_md: 'чужая', valid_from: '2024-01-03' }, 'u');

      const runChronicle = async (body: Record<string, unknown>) => {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/chronicle/query`,
          headers: authHeaders(ctx),
          payload: body,
        });
        assert.equal(res.statusCode, 200, res.body);
        return res.json() as { data: Array<{ id: string }>; meta: { total: number } };
      };

      // Быстрая форма v1: thought_ids + include_subtree + link_scope.
      const quick = await runChronicle({ thought_ids: [root], include_subtree: true, link_scope: 'both', order: 'asc' });
      assert.equal(quick.meta.total, 2, 'свои две записи (корень + потомок), не чужая');

      // Структурная форма v1: targets (структурный отбор, компилируемый в AST).
      const type = insertThoughtType(ndb, 'тип');
      const tagged = insertThought(ndb, 'Помеченная', { type_id: type });
      createComment(ndb, 'thought', tagged, { kind: 'chronological', body_md: 'по типу', valid_from: '2024-02-01' }, 'u');
      const byType = await runChronicle({ targets: { type_ids: [type] }, order: 'asc' });
      assert.equal(byType.meta.total, 1, 'targets-форма выбирает запись по структурному критерию цели');
    });
  },
);
