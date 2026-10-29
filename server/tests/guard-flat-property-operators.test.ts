/**
 * Сторож: каждый оператор плоского условия по свойству объявлен в спеке
 * (канон требования 00eb824b) и ОДИНАКОВО присутствует в MCP-схеме, REST-enum,
 * гейте движка, справке `etn.guide` и описании инструмента `tools/list`
 * (ошибка 40c76144).
 *
 * Дефект, который закрывает сторож: набор операторов жил в пяти местах, и
 * расхождения были незаметны — MCP отвергал `in`/`not_in`/`is_empty`/
 * `not_empty`, REST отвергал `gte`/`lte`, хотя справка и спека обещали их.
 * Агент планировал вызов по справке и получал `VALIDATION_ERROR`.
 *
 * Канон здесь задан ЛИТЕРАЛОМ (`CANON`), а не импортом `FLAT_PROPERTY_OPS`:
 * если сверять источники только между собой, удаление оператора из самого
 * источника (или из мест, которые из него генерируются) пройдёт зелёным.
 * Литерал делает сторож независимым от кода, который он стережёт.
 *
 * **ВНИМАНИЕ: `@etn/shared` читается из собранного `dist`.** После правки
 * `shared/src/enums.ts` нужен `npm -w @etn/shared run build`, иначе сторож
 * увидит старый набор (процесс тестов намеренно не собирает shared).
 *
 * Проверка описания идёт по реально рекламируемому каталогу (`tools/list`),
 * как у `guard-mcp-description-contracts.test.ts`: агент видит именно его,
 * а не исходник.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FLAT_PROPERTY_OPS, STRUCTURE_PROPERTY_OPS } from '@etn/shared';

import { ThoughtsQuery } from '../src/contracts.js';
import { OPS_BY_VALUE_TYPE } from '../src/domain/query-service.js';
import { GUIDE_TOPICS_BY_NAME } from '../src/mcp/tools/ops-catalog.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
} from './mcp-helpers.js';

/** Канон плоской формы (требование 00eb824b, задача 40c76144). */
const CANON = [
  'eq',
  'ne',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'is_empty',
  'not_empty',
  'any_of',
  'all_of',
  'none_of',
] as const;

/** Сортированный набор без дублей — источники сверяются как множества. */
function opsOf(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Типы JSON Schema узла (anyOf/oneOf раскрываются рекурсивно). */
function schemaTypes(node: unknown, acc = new Set<string>()): Set<string> {
  if (node === null || typeof node !== 'object') return acc;
  const obj = node as Record<string, unknown>;
  if (typeof obj['type'] === 'string') acc.add(obj['type']);
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = obj[key];
    if (Array.isArray(branches)) for (const branch of branches) schemaTypes(branch, acc);
  }
  return acc;
}

const CANON_SORTED = opsOf(CANON);

/**
 * Канон применимости по природе свойства — таблица требования 00eb824b,
 * тоже ЛИТЕРАЛОМ. Сверка объединения (как было в первой версии сторожа) не
 * ловит снятие оператора из ОДНОГО типа: `gte` остаётся в `date` и
 * объединение не меняется (замечание верификатора круга 2). Поэтому каждый
 * `value_type` сверяется отдельно.
 */
const CANON_BY_VALUE_TYPE: Record<string, readonly string[]> = {
  text: [
    'contains', 'eq', 'ne', 'in', 'not_in', 'is_empty', 'not_empty',
    'any_of', 'all_of', 'none_of',
  ],
  url: [
    'contains', 'eq', 'ne', 'in', 'not_in', 'is_empty', 'not_empty',
    'any_of', 'all_of', 'none_of',
  ],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'not_empty'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'not_empty'],
  bool: ['eq', 'ne'],
  link: [
    'eq', 'ne', 'in', 'not_in', 'is_empty', 'not_empty', 'any_of', 'all_of',
    'none_of',
  ],
  thought_ref: [
    'eq', 'ne', 'in', 'not_in', 'is_empty', 'not_empty', 'any_of', 'all_of',
    'none_of',
  ],
  cross_network_ref: ['eq', 'ne', 'any_of', 'all_of', 'none_of', 'is_empty', 'not_empty'],
  publication: ['eq', 'ne', 'any_of', 'all_of', 'none_of', 'is_empty', 'not_empty'],
};

/** Разбор slash-перечисления операторов из строки источника. */
function splitOps(span: string): string[] {
  const parts = span.split('/').map((v) => v.trim()).filter((v) => v !== '');
  assert.ok(parts.length > 0, 'перечисление операторов пустое');
  return parts;
}

describe(
  'сторож: набор плоских операторов один во всех источниках (40c76144)',
  { skip: !nativeAvailable() },
  () => {
    it('единственный источник FLAT_PROPERTY_OPS = канон', () => {
      assert.deepEqual(
        opsOf(FLAT_PROPERTY_OPS),
        CANON_SORTED,
        'FLAT_PROPERTY_OPS (shared/src/enums.ts) разошёлся с каноном 00eb824b',
      );
    });

    it('MCP-схема etn.thoughts.query { properties[].operator } = канон', () => {
      // Схема — ZodObject с refine (zod 4 сохраняет объект): `properties`
      // объявлено `z.array(...).optional()` — разворачиваем optional.
      const properties = ThoughtsQuery.schema.shape.properties.unwrap();
      const operator = properties.element.shape.operator;
      assert.deepEqual(
        opsOf(operator.options as readonly string[]),
        CANON_SORTED,
        'enum операторов плоской формы MCP разошёлся с каноном 00eb824b',
      );
    });

    it('REST-enum STRUCTURE_PROPERTY_OPS = канон', () => {
      assert.deepEqual(
        opsOf(STRUCTURE_PROPERTY_OPS),
        CANON_SORTED,
        'wire-enum REST properties[].op разошёлся с каноном 00eb824b',
      );
    });

    it('гейт движка OPS_BY_VALUE_TYPE = канон по КАЖДОМУ value_type', () => {
      const engine = OPS_BY_VALUE_TYPE as unknown as Record<string, readonly string[]>;
      assert.deepEqual(
        Object.keys(engine).sort(),
        Object.keys(CANON_BY_VALUE_TYPE).sort(),
        'набор value_type в гейте движка разошёлся с таблицей 00eb824b',
      );
      for (const [valueType, canon] of Object.entries(CANON_BY_VALUE_TYPE)) {
        assert.deepEqual(
          opsOf(engine[valueType] ?? []),
          opsOf(canon),
          `OPS_BY_VALUE_TYPE.${valueType} (исполнитель) разошёлся с таблицей 00eb824b`,
        );
      }
    });

    it('справка описывает наличие свойства-связи по живым рёбрам links_v', () => {
      const topic = GUIDE_TOPICS_BY_NAME.get('thoughts.query');
      assert.ok(topic !== undefined, 'тема thoughts.query обязана быть в реестре гайда');
      // Presence свойства-связи считается по `links_v`, а не по строке
      // `property_values` (query-service.ts, linkPropertyClause). Ошибочная
      // формулировка «нет строки/колонка пуста» для link — замечание
      // верификатора круга 2.
      assert.match(
        topic!.body_md,
        /нет живого ребра `links_v`/,
        'справка обязана говорить: для свойства-связи наличие — по живым рёбрам `links_v`',
      );
    });

    it('справка etn.guide { topic: "thoughts.query" } = канон', () => {
      const topic = GUIDE_TOPICS_BY_NAME.get('thoughts.query');
      assert.ok(topic !== undefined, 'тема thoughts.query обязана быть в реестре гайда');
      const match = /Плоская форма — канон из 14 операторов `([a-z_/]+)`/.exec(topic.body_md);
      assert.ok(
        match !== null,
        'в справке не найден маркер «Плоская форма — канон из 14 операторов `…`»',
      );
      assert.deepEqual(
        opsOf(splitOps(match![1]!)),
        CANON_SORTED,
        'справка thoughts.query перечисляет набор, отличный от канона 00eb824b',
      );
    });

    it('описание etn.thoughts.query в tools/list = канон', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const { tools } = await handle.client.listTools();
          const tool = tools.find((t) => t.name === 'etn.thoughts.query');
          assert.ok(tool !== undefined, 'инструмент etn.thoughts.query обязан быть в tools/list');
          const match = /канон ([a-z_/]+);/.exec(tool!.description ?? '');
          assert.ok(
            match !== null,
            'в описании etn.thoughts.query не найден маркер «канон <операторы>;»',
          );
          assert.deepEqual(
            opsOf(splitOps(match![1]!)),
            CANON_SORTED,
            'описание инструмента рекламирует набор, отличный от канона 00eb824b',
          );
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
    it('inputSchema etn.thoughts.query: value — читаемый union, presence-формы допустимы', async () => {
      // Стандарт 75f38020 §2: `inputSchema` — контракт вызова, ради бюджета
      // не урезается. `value: z.unknown()` давал в схеме пустой `{}` —
      // замечание верификатора круга 3 по ошибке 40c76144.
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const { tools } = await handle.client.listTools();
          const tool = tools.find((t) => t.name === 'etn.thoughts.query');
          assert.ok(tool !== undefined, 'инструмент etn.thoughts.query обязан быть в tools/list');
          const schema = tool!.inputSchema as {
            properties?: {
              properties?: { items?: { properties?: Record<string, unknown> } };
            };
          };
          const value = schema.properties?.properties?.items?.properties?.['value'];
          assert.ok(value !== undefined, 'в inputSchema нет поля properties[].value');
          assert.ok(
            typeof value === 'object' && value !== null && Object.keys(value).length > 0,
            'inputSchema properties[].value — пустая схема {}: контракт вызова не читается',
          );
          assert.deepEqual(
            [...schemaTypes(value)].sort(),
            ['array', 'boolean', 'null', 'number', 'object', 'string'],
            'inputSchema properties[].value должен читаемо перечислять типы ' +
              '(строка/число/логическое/массив/объект/null — presence-формы)',
          );
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }

      // Presence-формы проходят контракт до refine: `is_empty`/`not_empty`
      // значение игнорируют в любой форме (паритет с REST).
      for (const value of [null, { junk: true }, [1, 2]]) {
        const parsed = ThoughtsQuery.schema.safeParse({
          network_id: 'net',
          properties: [{ property: 'X', operator: 'is_empty', value }],
        });
        assert.equal(
          parsed.success,
          true,
          `presence с value=${JSON.stringify(value)} обязан проходить контракт: ` +
            (parsed.success ? '' : JSON.stringify(parsed.error.issues)),
        );
      }
    });
  },
);
