/**
 * Плоская форма условий по свойству: полный паритет операторов MCP ↔ REST
 * (ошибка 40c76144, требование 00eb824b, спека `etn.thoughts.query` 9fe4bb44).
 *
 * До исправления два расхождения:
 *   * MCP `etn.thoughts.query { properties[] }` отвергал
 *     `in`/`not_in`/`is_empty`/`not_empty` zod-контрактом, хотя движок их
 *     исполняет и REST-плоская форма (`properties[].op`) их принимает;
 *   * REST отвергал `gte`/`lte` (`STRUCTURE_PROPERTY_OPS`), хотя спека
 *     00eb824b разрешает их для number/date — сравнение работало только в MCP.
 *
 * Тест закрывает обе формы входа одного и того же отбора (общий движок
 * `queryThoughts`, ADR 8c93f03a):
 *   * пара наличия (`is_empty`/`not_empty`) — скаляр, отсутствующее свойство,
 *     свойство-связь, `bool` → `VALIDATION_ERROR`, переданный `value` игнорируется;
 *   * `in`/`not_in` — массив, пустой массив → понятная `VALIDATION_ERROR`;
 *   * `gte`/`lte` — number и date включительно; text в плоской форме
 *     недопустим (`VALIDATION_ERROR`), а AST-лист по text работает;
 *   * отсутствие `value` у сравнения — `VALIDATION_ERROR` на обоих фасадах;
 *   * AST-лист и плоское условие дают ОДИН набор id (presence);
 *   * `contains` принимает только строку (ошибка 9420a34c): массив строк,
 *     число, объект и `null` отвергаются одинаковыми кодом/текстом/`details`
 *     на MCP и REST — без молчаливого stringify в `"al,pha"`.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { FILTER_AST_VERSION, type FilterAst, type FilterAstNode } from '@etn/shared';

import type { NetworkDb } from '../src/db/network-db.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  toolText,
  type McpClientHandle,
  type McpTestContext,
} from './mcp-helpers.js';

/** Мысль с прямыми полями — фикстуре нужны точные заголовки. */
function insertThought(ndb: NetworkDb, title: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, icon, icon_kind,
                             icon_attachment_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, updated_at,
                             created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, NULL, NULL, 'emoji', NULL, 1, 0, 0,
               0, 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z',
               'u', 'u', 0, 0)`,
    )
    .run(id, ndb.layerId, title, title.normalize('NFC').trim().toLowerCase());
  return id;
}

/** Структурное или типизированное ребро источника → цели. */
function insertLink(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  typeId: string | null = null,
): void {
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'u', 'u')`,
    )
    .run(randomUUID(), sourceId, targetId, typeId);
}

/** Строка `property_values` с явной колонкой значения. */
function insertValue(
  ndb: NetworkDb,
  thoughtId: string,
  propertyId: string,
  column: 'value_text' | 'value_number' | 'value_date' | 'value_bool',
  value: string | number,
): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, ${column}, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

interface CreatedProperty {
  id: string;
  config: { link_type_id?: string } | null;
}

/** Определение свойства через REST — тот же реестр, что видит MCP. */
async function createProperty(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<CreatedProperty> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/properties`,
    headers: authHeaders(ctx),
    payload,
  });
  assert.equal(res.statusCode, 201, `создание свойства: ${res.statusCode} ${res.body}`);
  return res.json().data as CreatedProperty;
}

interface RestQueryResult {
  statusCode: number;
  ids: string[];
  body: unknown;
}

/** REST `POST /thoughts/query` без assert на успех — ошибки проверяются отдельно. */
async function restQuery(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<RestQueryResult> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/query`,
    headers: authHeaders(ctx),
    payload: { count: true, ...payload },
  });
  const body = res.json();
  const data =
    res.statusCode === 200
      ? ((body as { data: Array<{ id: string }> }).data.map((t) => t.id))
      : [];
  return { statusCode: res.statusCode, ids: data, body };
}

interface McpQueryResult {
  isError: boolean;
  ids: string[];
  text: string;
}

/** MCP `etn.thoughts.query` без assert на успех — ошибки проверяются отдельно. */
async function mcpQuery(
  handle: McpClientHandle,
  networkId: string,
  args: Record<string, unknown>,
): Promise<McpQueryResult> {
  const result = await handle.client.callTool({
    name: 'etn.thoughts.query',
    arguments: { network_id: networkId, count: true, ...args },
  });
  const text = toolText(result);
  if (result.isError === true) return { isError: true, ids: [], text };
  const data = JSON.parse(text) as { hits: Array<{ id: string }> };
  return { isError: false, ids: data.hits.map((h) => h.id), text };
}

/** Сортированные id — проверки не зависят от порядка страницы. */
function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

/**
 * `details` из текста ошибки MCP (`ETN error [CODE]: message\nDetails: {...}`)
 * — чтобы сверять их с REST-конвертом `error.details` буквально.
 */
function mcpErrorDetails(text: string): unknown {
  const match = /\nDetails: ([\s\S]+)$/.exec(text);
  return match === null ? undefined : JSON.parse(match[1]!);
}

interface World {
  rest: RestTestContext;
  mcp: McpTestContext;
  handle: McpClientHandle;
  ndb: NetworkDb;
}

/** Пара REST+MCP над одним data.db — ровно как в бою (два фасада, один движок). */
async function buildWorld(): Promise<World> {
  const rest = await buildRestContext();
  const mcp = await buildMcpContext({
    dataDir: rest.dataDir,
    systemDb: rest.sys,
    networkId: rest.networkId,
  });
  const handle = await connectMcpClient(mcp, rest.adminKey);
  return { rest, mcp, handle, ndb: rest.ndb };
}

async function closeWorld(world: World): Promise<void> {
  await world.handle.close();
  await closeMcpContext(world.mcp);
  await closeRestContext(world.rest);
}

/** AST-лист условия по свойству; `value` при наличии. */
function propertyLeaf(propertyId: string, operator: string, value?: unknown): FilterAstNode {
  const entity = { kind: 'property', property_id: propertyId };
  return (value === undefined ? { entity, operator } : { entity, operator, value }) as FilterAstNode;
}

/** AST-отбор «поддерево root AND условие по свойству». */
function subtreeAndLeaf(root: string, leaf: FilterAstNode): FilterAst {
  return {
    version: FILTER_AST_VERSION,
    filter: {
      op: 'and',
      children: [
        { entity: { kind: 'id' }, operator: 'in_hierarchy', value: [root] } as FilterAstNode,
        leaf,
      ],
    },
  };
}

describe(
  'плоская форма условий по свойству: паритет операторов MCP ↔ REST (40c76144)',
  { skip: !nativeAvailable() },
  () => {
    it('presence: text/number/date/link — одинаковый набор MCP, REST и AST; value не нужен; bool → VALIDATION_ERROR', async () => {
      const world = await buildWorld();
      try {
        const text = await createProperty(world.rest, { name: 'Текст', value_type: 'text' });
        const number = await createProperty(world.rest, { name: 'Число', value_type: 'number' });
        const date = await createProperty(world.rest, { name: 'Дата', value_type: 'date' });
        const bool = await createProperty(world.rest, { name: 'Флаг', value_type: 'bool' });
        const link = await createProperty(world.rest, {
          name: 'Связь',
          value_type: 'link',
          name_forward: 'Ссылается',
          name_reverse: 'Упоминается',
        });
        const linkTypeId = link.config?.link_type_id;
        assert.ok(typeof linkTypeId === 'string', 'свойство-связь обязано получить link_type_id');

        const root = insertThought(world.ndb, 'Корень');
        const filled = insertThought(world.ndb, 'Заполненная');
        const partial = insertThought(world.ndb, 'Частичная');
        const empty = insertThought(world.ndb, 'Пустая');
        for (const child of [filled, partial, empty]) insertLink(world.ndb, root, child);

        // filled — значения всех четырёх свойств; partial — только текст;
        // empty и root — значений нет.
        insertValue(world.ndb, filled, text.id, 'value_text', 'alpha');
        insertValue(world.ndb, filled, number.id, 'value_number', 7);
        insertValue(world.ndb, filled, date.id, 'value_date', '2024-05-01');
        insertValue(world.ndb, filled, bool.id, 'value_bool', 1);
        insertLink(world.ndb, filled, root, linkTypeId);
        insertValue(world.ndb, partial, text.id, 'value_text', 'beta');

        const expectations: Array<{
          label: string;
          property: CreatedProperty;
          name: string;
          notEmpty: string[];
          isEmpty: string[];
        }> = [
          {
            label: 'text',
            property: text,
            name: 'Текст',
            notEmpty: [filled, partial],
            isEmpty: [root, empty],
          },
          {
            label: 'number',
            property: number,
            name: 'Число',
            notEmpty: [filled],
            isEmpty: [root, partial, empty],
          },
          {
            label: 'date',
            property: date,
            name: 'Дата',
            notEmpty: [filled],
            isEmpty: [root, partial, empty],
          },
          {
            label: 'link',
            property: link,
            // Имя свойства-связи не хранится: оно вычисляется из типа связи
            // по направлению (`Ссылается` — прямое имя, задача 38eaa15c).
            name: 'Ссылается',
            notEmpty: [filled],
            isEmpty: [root, partial, empty],
          },
        ];

        for (const e of expectations) {
          for (const operator of ['is_empty', 'not_empty'] as const) {
            const expected = sorted(operator === 'not_empty' ? e.notEmpty : e.isEmpty);
            const tag = `${e.label} ${operator}`;

            // REST-плоская форма: `value` не передаётся вовсе.
            const rest = await restQuery(world.rest, {
              parent_ids: [root],
              properties: [{ property_id: e.property.id, op: operator }],
              sort: 'alpha',
              order: 'asc',
            });
            assert.equal(rest.statusCode, 200, `${tag}: REST ${rest.statusCode} ${JSON.stringify(rest.body)}`);
            assert.deepEqual(sorted(rest.ids), expected, `${tag}: REST — ожидаемый набор`);

            // MCP-плоская форма: условие без `value` (задача 40c76144).
            const mcp = await mcpQuery(world.handle, world.rest.networkId, {
              in_subtree_of: root,
              properties: [{ property: e.name, operator }],
              sort: 'title',
              order: 'asc',
            });
            assert.equal(mcp.isError, false, `${tag}: MCP не должен падать — ${mcp.text}`);
            assert.deepEqual(sorted(mcp.ids), expected, `${tag}: MCP — тот же набор, что REST`);

            // Переданное значение пара наличия игнорирует.
            const mcpIgnored = await mcpQuery(world.handle, world.rest.networkId, {
              in_subtree_of: root,
              properties: [{ property: e.name, operator, value: 'ignored' }],
              sort: 'title',
              order: 'asc',
            });
            assert.equal(mcpIgnored.isError, false, `${tag}: MCP value ignored — ${mcpIgnored.text}`);
            assert.deepEqual(
              sorted(mcpIgnored.ids),
              expected,
              `${tag}: значение пары наличия не влияет на клаузу`,
            );

            // AST-лист — тот же набор (presence уже исполнялся движком).
            const ast = await mcpQuery(world.handle, world.rest.networkId, {
              ast: subtreeAndLeaf(root, propertyLeaf(e.property.id, operator)),
              sort: 'title',
              order: 'asc',
            });
            assert.equal(ast.isError, false, `${tag}: AST не должен падать — ${ast.text}`);
            assert.deepEqual(sorted(ast.ids), expected, `${tag}: AST — тот же набор`);

            // REST и MCP дают одинаковое число совпадений (COUNT одного движка).
            const restTotal = (rest.body as { meta: { total: number } }).meta.total;
            assert.equal(restTotal, expected.length, `${tag}: REST total`);
          }
        }

        // `bool` + presence запрещено (требование 9bdddad6): оба фасада дают
        // понятную VALIDATION_ERROR, а не тихий пустой результат.
        const boolRest = await restQuery(world.rest, {
          parent_ids: [root],
          properties: [{ property_id: bool.id, op: 'is_empty' }],
        });
        assert.equal(boolRest.statusCode, 422, `bool is_empty REST: ${boolRest.statusCode}`);
        const boolRestError = (boolRest.body as { error: { code: string; message: string } }).error;
        assert.equal(boolRestError.code, 'VALIDATION_ERROR');
        assert.match(boolRestError.message, /is_empty/);
        assert.match(boolRestError.message, /bool/);

        const boolMcp = await mcpQuery(world.handle, world.rest.networkId, {
          in_subtree_of: root,
          properties: [{ property: 'Флаг', operator: 'is_empty' }],
        });
        assert.equal(boolMcp.isError, true, 'bool is_empty MCP обязан падать');
        assert.match(boolMcp.text, /VALIDATION_ERROR/);
        assert.match(boolMcp.text, /is_empty/);
        assert.match(boolMcp.text, /bool/);

        // Отсутствие `value` у сравнения — VALIDATION_ERROR на обоих фасадах
        // (молчаливое «сравнение с undefined» запрещено).
        const missingRest = await restQuery(world.rest, {
          parent_ids: [root],
          properties: [{ property_id: text.id, op: 'eq' }],
        });
        assert.equal(missingRest.statusCode, 422, 'REST eq без value — 422');
        assert.equal(
          (missingRest.body as { error: { code: string } }).error.code,
          'VALIDATION_ERROR',
        );

        const missingMcp = await mcpQuery(world.handle, world.rest.networkId, {
          in_subtree_of: root,
          properties: [{ property: 'Текст', operator: 'eq' }],
        });
        assert.equal(missingMcp.isError, true, 'MCP eq без value обязан падать');
        assert.match(missingMcp.text, /VALIDATION_ERROR/);
        assert.match(missingMcp.text, /value/);
      } finally {
        await closeWorld(world);
      }
    });

    it('presence игнорирует value ЛЮБОЙ формы (null/объект/массив) на обоих фасадах; форма сравнения строгая', async () => {
      const world = await buildWorld();
      try {
        const text = await createProperty(world.rest, { name: 'Метка', value_type: 'text' });
        const root = insertThought(world.ndb, 'Корень');
        const filled = insertThought(world.ndb, 'Заполненная');
        const empty = insertThought(world.ndb, 'Пустая');
        for (const child of [filled, empty]) insertLink(world.ndb, root, child);
        insertValue(world.ndb, filled, text.id, 'value_text', 'alpha');
        const expected = sorted([root, empty]);

        // Замечание верификатора круга 2: MCP отвергал `null`/объект zod-схемой,
        // а REST молча подставлял `''`. Теперь обе формы входа принимают любую
        // шумовую форму значения у пары наличия и игнорируют её.
        const ignored: unknown[] = [null, { junk: true }, [1, 2], 'ignored'];
        for (const value of ignored) {
          const tag = `value=${JSON.stringify(value)}`;
          const rest = await restQuery(world.rest, {
            parent_ids: [root],
            properties: [{ property_id: text.id, op: 'is_empty', value }],
            sort: 'alpha',
            order: 'asc',
          });
          assert.equal(
            rest.statusCode,
            200,
            `${tag}: REST ${rest.statusCode} ${JSON.stringify(rest.body)}`,
          );
          assert.deepEqual(sorted(rest.ids), expected, `${tag}: REST — presence не зависит от value`);

          const mcp = await mcpQuery(world.handle, world.rest.networkId, {
            in_subtree_of: root,
            properties: [{ property: 'Метка', operator: 'is_empty', value }],
            sort: 'title',
            order: 'asc',
          });
          assert.equal(mcp.isError, false, `${tag}: MCP не должен падать — ${mcp.text}`);
          assert.deepEqual(sorted(mcp.ids), expected, `${tag}: MCP = REST`);
        }

        // Для сравнений форма значения осталась строгой на обоих фасадах:
        // объект — VALIDATION_ERROR, а не молчаливое сравнение.
        const restObject = await restQuery(world.rest, {
          parent_ids: [root],
          properties: [{ property_id: text.id, op: 'eq', value: { junk: true } }],
        });
        assert.equal(restObject.statusCode, 422, 'REST eq с объектом — 422');
        assert.equal(
          (restObject.body as { error: { code: string } }).error.code,
          'VALIDATION_ERROR',
        );

        const mcpObject = await mcpQuery(world.handle, world.rest.networkId, {
          in_subtree_of: root,
          properties: [{ property: 'Метка', operator: 'eq', value: { junk: true } }],
        });
        assert.equal(mcpObject.isError, true, 'MCP eq с объектом обязан падать');
        assert.match(mcpObject.text, /VALIDATION_ERROR/);
        assert.match(mcpObject.text, /value/);
      } finally {
        await closeWorld(world);
      }
    });

    it('in/not_in: массивы совпадают у MCP и REST, пустой массив → понятная VALIDATION_ERROR', async () => {
      const world = await buildWorld();
      try {
        const status = await createProperty(world.rest, { name: 'Статус', value_type: 'text' });
        const root = insertThought(world.ndb, 'Корень');
        const alpha = insertThought(world.ndb, 'Альфа');
        const beta = insertThought(world.ndb, 'Бета');
        for (const child of [alpha, beta]) insertLink(world.ndb, root, child);
        insertValue(world.ndb, alpha, status.id, 'value_text', 'alpha');
        insertValue(world.ndb, beta, status.id, 'value_text', 'beta');

        const steps: Array<{ operator: 'in' | 'not_in'; value: string[]; expected: string[] }> = [
          { operator: 'in', value: ['alpha', 'beta'], expected: [alpha, beta] },
          // Отрицание — «не совпал ни один»; мысль без значения строки не имеет,
          // поэтому проходит (NOT EXISTS), как в прежнем REST-движке.
          { operator: 'not_in', value: ['alpha'], expected: [root, beta] },
        ];
        for (const step of steps) {
          const tag = `${step.operator} ${JSON.stringify(step.value)}`;
          const rest = await restQuery(world.rest, {
            parent_ids: [root],
            properties: [{ property_id: status.id, op: step.operator, value: step.value }],
            sort: 'alpha',
            order: 'asc',
          });
          assert.equal(rest.statusCode, 200, `${tag}: REST ${rest.statusCode} ${JSON.stringify(rest.body)}`);
          assert.deepEqual(sorted(rest.ids), sorted(step.expected), `${tag}: REST`);

          const mcp = await mcpQuery(world.handle, world.rest.networkId, {
            in_subtree_of: root,
            properties: [{ property: 'Статус', operator: step.operator, value: step.value }],
            sort: 'title',
            order: 'asc',
          });
          assert.equal(mcp.isError, false, `${tag}: MCP — ${mcp.text}`);
          assert.deepEqual(sorted(mcp.ids), sorted(step.expected), `${tag}: MCP = REST`);
        }

        // Пустой список: «нечего исключать» молча не допускается — контракт
        // MCP (`min(1)`) и движок REST дают VALIDATION_ERROR с понятным текстом.
        for (const operator of ['in', 'not_in'] as const) {
          const rest = await restQuery(world.rest, {
            parent_ids: [root],
            properties: [{ property_id: status.id, op: operator, value: [] }],
          });
          assert.equal(rest.statusCode, 422, `${operator} [] REST — 422`);
          const err = (rest.body as { error: { code: string; message: string } }).error;
          assert.equal(err.code, 'VALIDATION_ERROR');
          assert.match(err.message, /непуст/i, `${operator} []: понятный текст — ${err.message}`);

          const mcp = await mcpQuery(world.handle, world.rest.networkId, {
            in_subtree_of: root,
            properties: [{ property: 'Статус', operator, value: [] }],
          });
          assert.equal(mcp.isError, true, `${operator} [] MCP обязан падать`);
          assert.match(mcp.text, /VALIDATION_ERROR/);
          assert.match(mcp.text, /массив/i, `${operator} [] MCP: понятный текст — ${mcp.text}`);
        }
      } finally {
        await closeWorld(world);
      }
    });

    it('gte/lte: number и date включительно — REST-дефект исправлен; text в плоской форме отвергается, AST-лист работает', async () => {
      const world = await buildWorld();
      try {
        const number = await createProperty(world.rest, { name: 'Приоритет', value_type: 'number' });
        const date = await createProperty(world.rest, { name: 'Срок', value_type: 'date' });
        const text = await createProperty(world.rest, { name: 'Метка', value_type: 'text' });

        const root = insertThought(world.ndb, 'Корень');
        const low = insertThought(world.ndb, 'Низкий');
        const middle = insertThought(world.ndb, 'Средний');
        const high = insertThought(world.ndb, 'Высокий');
        for (const child of [low, middle, high]) insertLink(world.ndb, root, child);
        insertValue(world.ndb, low, number.id, 'value_number', 1);
        insertValue(world.ndb, middle, number.id, 'value_number', 5);
        insertValue(world.ndb, high, number.id, 'value_number', 10);
        insertValue(world.ndb, low, date.id, 'value_date', '2024-01-10');
        insertValue(world.ndb, middle, date.id, 'value_date', '2024-03-15');
        insertValue(world.ndb, high, date.id, 'value_date', '2024-12-31');
        insertValue(world.ndb, middle, text.id, 'value_text', 'Бета');

        const steps: Array<{
          label: string;
          property: CreatedProperty;
          name: string;
          operator: 'gte' | 'lte';
          value: string | number;
          expected: string[];
        }> = [
          { label: 'number gte 5', property: number, name: 'Приоритет', operator: 'gte', value: 5, expected: [middle, high] },
          { label: 'number lte 5', property: number, name: 'Приоритет', operator: 'lte', value: 5, expected: [low, middle] },
          { label: 'date gte 2024-03-15', property: date, name: 'Срок', operator: 'gte', value: '2024-03-15', expected: [middle, high] },
          { label: 'date lte 2024-03-15', property: date, name: 'Срок', operator: 'lte', value: '2024-03-15', expected: [low, middle] },
        ];
        for (const step of steps) {
          const rest = await restQuery(world.rest, {
            parent_ids: [root],
            properties: [{ property_id: step.property.id, op: step.operator, value: step.value }],
            sort: 'alpha',
            order: 'asc',
          });
          assert.equal(rest.statusCode, 200, `${step.label}: REST ${rest.statusCode} ${JSON.stringify(rest.body)}`);
          assert.deepEqual(sorted(rest.ids), sorted(step.expected), `${step.label}: REST (дефект gte/lte)`);

          const mcp = await mcpQuery(world.handle, world.rest.networkId, {
            in_subtree_of: root,
            properties: [{ property: step.name, operator: step.operator, value: step.value }],
            sort: 'title',
            order: 'asc',
          });
          assert.equal(mcp.isError, false, `${step.label}: MCP — ${mcp.text}`);
          assert.deepEqual(sorted(mcp.ids), sorted(step.expected), `${step.label}: MCP = REST`);
        }

        // Плоская форма по text НЕ допускает сравнений (гейт
        // `OPS_BY_VALUE_TYPE`; таблица 00eb824b) — оба фасада дают ошибку.
        const textRest = await restQuery(world.rest, {
          parent_ids: [root],
          properties: [{ property_id: text.id, op: 'gte', value: 'А' }],
        });
        assert.equal(textRest.statusCode, 422, 'REST text gte — 422');
        const textErr = (textRest.body as { error: { code: string; message: string } }).error;
        assert.equal(textErr.code, 'VALIDATION_ERROR');
        assert.match(textErr.message, /gte/);
        assert.match(textErr.message, /text/);

        const textMcp = await mcpQuery(world.handle, world.rest.networkId, {
          in_subtree_of: root,
          properties: [{ property: 'Метка', operator: 'gte', value: 'А' }],
        });
        assert.equal(textMcp.isError, true, 'MCP text gte обязан падать');
        assert.match(textMcp.text, /VALIDATION_ERROR/);

        // Строковое сравнение живёт в AST (`PROPERTY_OPERATOR_SETS.text`):
        // «Метка» β ≥ «Б» — регистронезависимо (ADR 9779dd21).
        const textAst = await mcpQuery(world.handle, world.rest.networkId, {
          ast: subtreeAndLeaf(root, propertyLeaf(text.id, 'gte', 'Б')),
          sort: 'title',
          order: 'asc',
        });
        assert.equal(textAst.isError, false, `AST text gte — ${textAst.text}`);
        assert.deepEqual(sorted(textAst.ids), [middle], 'AST text gte: строковое сравнение работает');
      } finally {
        await closeWorld(world);
      }
    });

    it('contains: только строка; массив/число/объект/null — одинаковая VALIDATION_ERROR в MCP и REST (9420a34c)', async () => {
      const world = await buildWorld();
      try {
        const status = await createProperty(world.rest, { name: 'Статус', value_type: 'text' });
        const root = insertThought(world.ndb, 'Корень');
        const alpha = insertThought(world.ndb, 'Альфа');
        const beta = insertThought(world.ndb, 'Бета');
        for (const child of [alpha, beta]) insertLink(world.ndb, root, child);
        insertValue(world.ndb, alpha, status.id, 'value_text', 'alpha');
        insertValue(world.ndb, beta, status.id, 'value_text', 'beta');

        // Штатный `contains` строкой работает на обоих фасадах: подстрока
        // регистронезависима (требование f14e48ab) — «ALPH» находит «alpha».
        const restOk = await restQuery(world.rest, {
          parent_ids: [root],
          properties: [{ property_id: status.id, op: 'contains', value: 'ALPH' }],
          sort: 'alpha',
          order: 'asc',
        });
        assert.equal(restOk.statusCode, 200, `REST contains строка: ${JSON.stringify(restOk.body)}`);
        assert.deepEqual(sorted(restOk.ids), [alpha], 'REST contains строка — 1 совпадение');

        const mcpOk = await mcpQuery(world.handle, world.rest.networkId, {
          in_subtree_of: root,
          properties: [{ property: 'Статус', operator: 'contains', value: 'ALPH' }],
          sort: 'title',
          order: 'asc',
        });
        assert.equal(mcpOk.isError, false, `MCP contains строка — ${mcpOk.text}`);
        assert.deepEqual(sorted(mcpOk.ids), [alpha], 'MCP contains строка — тот же набор');

        // Не-строка — явная ошибка с ОДИНАКОВЫМИ кодом, текстом и details.
        // До исправления `['alpha']` проходил случайно (String → "alpha"), а
        // `['al','pha']` молча превращался в "al,pha" и давал пустой отбор.
        const badValues: Array<{ label: string; value: unknown }> = [
          { label: '["alpha"]', value: ['alpha'] },
          { label: '["al","pha"]', value: ['al', 'pha'] },
          { label: 'число 5', value: 5 },
          { label: 'объект', value: { junk: true } },
          { label: 'null', value: null },
          { label: 'value отсутствует', value: undefined },
        ];
        const expectedDetails = { field: 'value', operator: 'contains', expected: 'string' };
        for (const bad of badValues) {
          const tag = `contains ${bad.label}`;
          const payloadProperty: Record<string, unknown> = { property_id: status.id, op: 'contains' };
          if (bad.value !== undefined) payloadProperty['value'] = bad.value;
          const rest = await restQuery(world.rest, {
            parent_ids: [root],
            properties: [payloadProperty],
          });
          assert.equal(rest.statusCode, 422, `${tag}: REST ${rest.statusCode} ${JSON.stringify(rest.body)}`);
          const restError = (rest.body as {
            error: { code: string; message: string; details?: unknown };
          }).error;
          assert.equal(restError.code, 'VALIDATION_ERROR', `${tag}: REST code`);
          assert.equal(
            restError.message,
            'Для операции contains value должен быть строкой.',
            `${tag}: REST message`,
          );
          assert.deepEqual(restError.details, expectedDetails, `${tag}: REST details`);

          const mcpProperty: Record<string, unknown> = { property: 'Статус', operator: 'contains' };
          if (bad.value !== undefined) mcpProperty['value'] = bad.value;
          const mcp = await mcpQuery(world.handle, world.rest.networkId, {
            in_subtree_of: root,
            properties: [mcpProperty],
          });
          assert.equal(mcp.isError, true, `${tag}: MCP обязан падать`);
          assert.match(mcp.text, /ETN error \[VALIDATION_ERROR\]/, `${tag}: MCP code`);
          assert.ok(
            mcp.text.includes(restError.message),
            `${tag}: MCP и REST дают одинаковый текст — MCP: ${mcp.text}`,
          );
          assert.deepEqual(mcpErrorDetails(mcp.text), restError.details, `${tag}: MCP details = REST`);
        }

        // Соседние строковые операторы (`eq`/`ne`) массив тоже не принимают —
        // обе формы входа падают одинаково (движок, `sqlScalar`), без stringify.
        for (const operator of ['eq', 'ne'] as const) {
          const rest = await restQuery(world.rest, {
            parent_ids: [root],
            properties: [{ property_id: status.id, op: operator, value: ['alpha'] }],
          });
          assert.equal(rest.statusCode, 422, `${operator} [alpha] REST — 422`);
          const restError = (rest.body as { error: { code: string; message: string; details?: unknown } }).error;
          assert.equal(restError.code, 'VALIDATION_ERROR');
          assert.deepEqual(restError.details, { field: 'value' }, `${operator}: REST details`);

          const mcp = await mcpQuery(world.handle, world.rest.networkId, {
            in_subtree_of: root,
            properties: [{ property: 'Статус', operator, value: ['alpha'] }],
          });
          assert.equal(mcp.isError, true, `${operator} [alpha] MCP обязан падать`);
          assert.ok(mcp.text.includes(restError.message), `${operator}: MCP текст = REST`);
        }
      } finally {
        await closeWorld(world);
      }
    });
  },
);
