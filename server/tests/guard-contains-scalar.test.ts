/**
 * Сторож: `contains` принимает ТОЛЬКО строку — одно правило на трёх слоях
 * (ошибка 9420a34c, требования 00eb824b / 9fe4bb44).
 *
 * Правило, которое защищает сторож: не-строка (`['alpha']`, `['al','pha']`,
 * число, `true`, объект, `null`, отсутствие `value`) — `VALIDATION_ERROR`
 * с ОДНИМИ текстом и `details` на MCP и REST; ни один слой не stringify-ит
 * массив молча (до исправления `String(['al','pha'])` → `"al,pha"` давал
 * пустой отбор, а `['alpha']` проходил случайно).
 *
 * Проверки:
 *   (а) все три слоя — MCP-контракт (`contracts.ts`), REST-разбор
 *       (`domain/structure-service.ts`) и движок (`domain/query-service.ts`) —
 *       ссылаются на единые `FLAT_PROPERTY_CONTAINS_VALUE_MESSAGE` /
 *       `FLAT_PROPERTY_CONTAINS_VALUE_DETAILS` из `@etn/shared` и не держат
 *       собственного текста ошибки;
 *   (б) отказ не-строки одинаков на MCP и REST (код, текст, `details`);
 *   (в) presence (`is_empty`/`not_empty`) не зависит от формы `value` —
 *       ни на границах входа, ни в движке;
 *   (г) движок — вторая линия: прямой вызов с массивом/пустым массивом
 *       падает, а штатный `contains` строкой продолжает работать
 *       (мутация «вернуть `String(cond.value)`» даёт красный).
 *
 * Канон текста и `details` задан здесь ЛИТЕРАЛОМ, а не импортом: если сверять
 * константы только между слоями, правка самого `shared/src/enums.ts` пройдёт
 * зелёной, хотя контракт ошибки изменился.
 *
 * **ВНИМАНИЕ: `@etn/shared` читается из собранного `dist`.** После правки
 * `shared/src/enums.ts` нужен `npm -w @etn/shared run build`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import DatabaseConstructor from 'better-sqlite3';

import {
  EtnError,
  FLAT_PROPERTY_CONTAINS_VALUE_DETAILS,
  FLAT_PROPERTY_CONTAINS_VALUE_MESSAGE,
} from '@etn/shared';

import { mcpValidationError, ThoughtsQuery } from '../src/contracts.js';
import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  queryThoughts,
  type ThoughtQueryRequest as CanonicalQueryRequest,
} from '../src/domain/query-service.js';
import { parseStructureFilter } from '../src/domain/structure-service.js';

const SERVER_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
);

/** Канон текста ошибки `contains` — литерал, независимый от кода. */
const CANON_MESSAGE = 'Для операции contains value должен быть строкой.';
/** Канон машинных деталей ошибки — литерал. */
const CANON_DETAILS = { field: 'value', operator: 'contains', expected: 'string' };

/** Три слоя правила: файл и человекочитаемое имя для сообщений. */
const LAYERS = [
  { rel: 'contracts.ts', label: 'MCP-контракт ThoughtsQuery' },
  { rel: 'domain/structure-service.ts', label: 'REST parsePropertyCondition' },
  { rel: 'domain/query-service.ts', label: 'движок propertyClauses' },
] as const;

/** Число вхождений подстроки — импорт + использование дают минимум два. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

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

/** `value` в form-объекте условия: отсутствие ключа — отдельный кейс. */
function withValue(target: Record<string, unknown>, value: unknown): Record<string, unknown> {
  if (value !== undefined) target['value'] = value;
  return target;
}

/** Ожидание отказа `contains`/`not_contains` с фактическим оператором. */
function expectContainsValidationError(
  fn: () => unknown,
  operator: 'contains' | 'not_contains',
  tag: string,
): void {
  assert.throws(
    fn,
    (e: unknown) => {
      if (!(e instanceof EtnError)) return false;
      const details = e.details as { operator?: string } | undefined;
      return (
        e.code === 'VALIDATION_ERROR' &&
        e.message === CANON_MESSAGE &&
        details?.operator === operator
      );
    },
    `${tag}: ожидалась VALIDATION_ERROR «${CANON_MESSAGE}» с details.operator=${operator}`,
  );
}

// ---------------------------------------------------------------------------
// Мини-фикстура движка: текст-свойство и три мысли (два значения, одно пустое).
// ---------------------------------------------------------------------------

function seedThought(ndb: NetworkDb, title: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, 1, 0, 0, 1, '2024-01-01T00:00:00.000Z', 'u',
               '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase());
  return id;
}

function seedPropertyDefinition(ndb: NetworkDb, key: string, valueType: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description,
                               created_at, updated_at)
       VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', ?, lower(?), ?, NULL, NULL, '2024', '2024')`,
    )
    .run(id, key, key, valueType);
  return id;
}

function seedPropertyValue(
  ndb: NetworkDb,
  thoughtId: string,
  propertyId: string,
  value: string,
): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_text, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

/** Прямой вызов движка (канонная форма запроса, один общий SQL-исполнитель). */
function runEngine(ndb: NetworkDb, properties: Array<Record<string, unknown>>): string[] {
  const req: CanonicalQueryRequest = {
    properties: properties as unknown as CanonicalQueryRequest['properties'],
    sort: 'alpha',
    order: 'asc',
    limit: 50,
    offset: 0,
    count: true,
  };
  return queryThoughts(ndb, 'u', req, { emptyFilterMode: 'all', maxLimit: 100 }).items.map(
    (t) => t.title,
  );
}

describe(
  'сторож: contains — только строка, одно правило на трёх слоях (9420a34c)',
  { skip: !nativeAvailable() },
  () => {
    it('канон текста и details ошибки contains', () => {
      assert.equal(
        FLAT_PROPERTY_CONTAINS_VALUE_MESSAGE,
        CANON_MESSAGE,
        'текст ошибки contains в shared/src/enums.ts разошёлся с каноном 00eb824b',
      );
      assert.deepEqual(
        { ...FLAT_PROPERTY_CONTAINS_VALUE_DETAILS },
        CANON_DETAILS,
        'details ошибки contains в shared/src/enums.ts разошлись с каноном 00eb824b',
      );
    });

    it('все три слоя ссылаются на общие константы и не держат своего текста', () => {
      for (const layer of LAYERS) {
        const src = fs.readFileSync(path.join(SERVER_SRC, layer.rel), 'utf8');
        // Импорт + использование: одно вхождение — значит слой импортирует
        // константу, но в решении её не использует (свой текст/свои details).
        assert.ok(
          countOccurrences(src, 'FLAT_PROPERTY_CONTAINS_VALUE_MESSAGE') >= 2,
          `${layer.rel} (${layer.label}): общая FLAT_PROPERTY_CONTAINS_VALUE_MESSAGE не используется — ` +
            'слой завёл свой текст ошибки contains',
        );
        assert.ok(
          countOccurrences(src, 'FLAT_PROPERTY_CONTAINS_VALUE_DETAILS') >= 2,
          `${layer.rel} (${layer.label}): общие FLAT_PROPERTY_CONTAINS_VALUE_DETAILS не используются — ` +
            'слой завёл свои details',
        );
        assert.ok(
          !src.includes(CANON_MESSAGE),
          `${layer.rel} (${layer.label}): текст ошибки contains захардкожен — ` +
            'используй FLAT_PROPERTY_CONTAINS_VALUE_MESSAGE из @etn/shared',
        );
        assert.match(
          src,
          /import\s*\{[^}]*FLAT_PROPERTY_CONTAINS_VALUE_MESSAGE[^}]*\}\s*from\s*'@etn\/shared'/s,
          `${layer.rel} (${layer.label}): общие константы обязаны приходить из @etn/shared`,
        );
      }
    });

    it('отказ не-строки одинаков на MCP и REST: код, текст, details', () => {
      const badValues: Array<{ label: string; value: unknown }> = [
        { label: '["alpha"]', value: ['alpha'] },
        { label: '["al","pha"]', value: ['al', 'pha'] },
        { label: '[]', value: [] },
        { label: 'число 5', value: 5 },
        { label: 'true', value: true },
        { label: 'объект', value: { junk: true } },
        { label: 'null', value: null },
        { label: 'value отсутствует', value: undefined },
      ];
      for (const bad of badValues) {
        const tag = `contains ${bad.label}`;
        const mcpError = mcpValidationError(ThoughtsQuery, {
          network_id: 'net',
          properties: [withValue({ property: 'Статус', operator: 'contains' }, bad.value)],
        });
        assert.ok(mcpError !== null, `${tag}: MCP-контракт обязан отвергнуть форму value`);

        let restError: EtnError | null = null;
        try {
          parseStructureFilter({
            properties: [withValue({ property_id: 'p', op: 'contains' }, bad.value)],
          });
        } catch (e) {
          assert.ok(e instanceof EtnError, `${tag}: REST бросил не EtnError`);
          restError = e;
        }
        assert.ok(restError !== null, `${tag}: REST-разбор обязан отвергнуть форму value`);

        assert.equal(mcpError!.code, 'VALIDATION_ERROR', `${tag}: MCP code`);
        assert.equal(restError!.code, 'VALIDATION_ERROR', `${tag}: REST code`);
        assert.equal(mcpError!.message, CANON_MESSAGE, `${tag}: MCP message`);
        assert.equal(restError!.message, CANON_MESSAGE, `${tag}: REST message`);
        assert.deepEqual(mcpError!.details, CANON_DETAILS, `${tag}: MCP details`);
        assert.deepEqual(restError!.details, CANON_DETAILS, `${tag}: REST details`);
        assert.deepEqual(
          mcpError!.details,
          restError!.details,
          `${tag}: MCP и REST обязаны давать ОДНИ details`,
        );
      }

      // Штатная строка проходит обе границы входа — правило не ломает
      // `contains`.
      assert.equal(
        mcpValidationError(ThoughtsQuery, {
          network_id: 'net',
          properties: [{ property: 'Статус', operator: 'contains', value: 'ALPH' }],
        }),
        null,
        'contains строкой обязан проходить MCP-контракт',
      );
      const restOk = parseStructureFilter({
        properties: [{ property_id: 'p', op: 'contains', value: 'ALPH' }],
      });
      assert.equal(restOk.properties?.[0]?.value, 'ALPH', 'REST: строка value доходит без изменений');
    });

    it('presence не зависит от формы value — границы входа MCP и REST', () => {
      for (const operator of ['is_empty', 'not_empty'] as const) {
        for (const value of [undefined, null, 5, true, ['a'], { junk: true }, '']) {
          const tag = `${operator} value=${JSON.stringify(value)}`;
          assert.equal(
            mcpValidationError(ThoughtsQuery, {
              network_id: 'net',
              properties: [withValue({ property: 'Статус', operator }, value)],
            }),
            null,
            `${tag}: MCP-контракт обязан игнорировать value любой формы`,
          );
          const parsed = parseStructureFilter({
            properties: [withValue({ property_id: 'p', op: operator }, value)],
          });
          // Форма value на presence не влияет: разбор не падает, условие
          // сохранено (скаляр остаётся placeholder'ом, не-скаляр — пустой
          // строкой); движок presence значение не читает — это проверено
          // ниже на наборе совпадений.
          assert.equal(
            parsed.properties?.[0]?.op,
            operator,
            `${tag}: REST обязан сохранить условие наличия`,
          );
        }
      }
    });

    it('движок — вторая линия: массив падает, строка работает, presence не зависит от value', () => {
      const ndb = createInMemoryNetworkDb();
      const status = seedPropertyDefinition(ndb, 'status', 'text');
      const alpha = seedThought(ndb, 'Альфа');
      const beta = seedThought(ndb, 'Бета');
      seedThought(ndb, 'Без значения');
      seedPropertyValue(ndb, alpha, status, 'alpha');
      seedPropertyValue(ndb, beta, status, 'beta');

      assert.deepEqual(
        runEngine(ndb, [{ property_id: status, operator: 'contains', value: 'ALPH' }]),
        ['Альфа'],
        'contains строкой обязан работать (регистронезависимо) — правило не ломает штатный путь',
      );

      for (const bad of [['alpha'], ['al', 'pha'], [], 5, true, {}, null] as const) {
        expectContainsValidationError(
          () => runEngine(ndb, [{ property_id: status, operator: 'contains', value: bad }]),
          'contains',
          `движок contains ${JSON.stringify(bad)}`,
        );
      }
      // Отсутствие value — та же ошибка (движок проверяет форму до LIKE).
      expectContainsValidationError(
        () => runEngine(ndb, [{ property_id: status, operator: 'contains' }]),
        'contains',
        'движок contains без value',
      );

      const expectations = new Map<string, string[]>([
        ['is_empty', ['Без значения']],
        ['not_empty', ['Альфа', 'Бета']],
      ]);
      for (const [operator, expected] of expectations) {
        for (const value of [undefined, null, 5, true, ['a'], { junk: true }] as const) {
          assert.deepEqual(
            runEngine(ndb, [{ property_id: status, operator, value }]),
            [...expected].sort(),
            `движок ${operator} value=${JSON.stringify(value)}: набор не зависит от формы value`,
          );
        }
      }
    });
  },
);
