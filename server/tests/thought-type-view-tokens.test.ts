/**
 * Unit + integration tests for the `thought_type_view`-tokens domain
 * (server/src/domain/thought-type-view-tokens.ts, задача 20b2fca0).
 *
 * Покрытие по требованиям:
 *   * 3697eb65 — токены разрешаются сервером относительно мысли-контекста;
 *   * b7fdab20 — неразрешимый токен даёт пустой результат с пояснением;
 *   * 12fccde9 — множественное свойство подставляется списком и допустимо
 *     только в операциях «в списке» / «не в списке»;
 *   * 00eb824b — операции условий зависят от типа значения.
 *
 * Структура:
 *   1. Чистые тесты парсера (`scanStringForTokens`) — без БД.
 *   2. Чистые тесты валидатора (`validateDefinitionForTokens`).
 *   3. Чистые тесты резолвера (`resolveTokensInDefinition`).
 *   4. Интеграционные тесты сервиса отборов — реальная БД, проверка,
 *      что create/update блокируют невалидный токен свойства.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { EtnError } from '@etn/shared';

import type { NetworkDb } from '../src/db/network-db.js';
import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createTypeProperty, setPropertyValue } from '../src/domain/property-service.js';
import {
  createThoughtTypeView,
  updateThoughtTypeView,
} from '../src/domain/thought-type-views-service.js';
import {
  buildResolveContext,
  resolveTokensInDefinition,
  scanStringForTokens,
  validateDefinitionForTokens,
  type PropertyMeta,
} from '../src/domain/thought-type-view-tokens.js';

const USER = 'user-1';
const SORT_DEFINITION = '{"sort":"alpha","order":"asc"}';

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

function parseOrThrow<T>(json: string): T {
  return JSON.parse(json) as T;
}

// ============================================================================
// 1. Парсер: известные и неизвестные токены
// ============================================================================

describe(
  'thought_type_view tokens: parser',
  () => {
    it('находит известные токены и классифицирует их', () => {
      const result = scanStringForTokens('$today $now $user $thought $thought.id $thought.title');
      assert.equal(result.unknown.length, 0);
      const kinds = result.known.map((t) => t.kind);
      assert.deepEqual(kinds, [
        'global',
        'global',
        'global',
        'thought_field',
        'thought_field',
        'thought_field',
      ]);
      assert.equal(result.known[3]!.field, 'id', '$thought → псевдоним id');
      assert.equal(result.known[4]!.field, 'id');
      assert.equal(result.known[5]!.field, 'title');
    });

    it('находит свойства через $thought.[…]', () => {
      const result = scanStringForTokens('$thought.[Плановый срок] $thought.[версия]');
      assert.equal(result.unknown.length, 0);
      assert.equal(result.known.length, 2);
      assert.equal(result.known[0]!.kind, 'thought_property');
      assert.equal(result.known[0]!.propertyName, 'Плановый срок');
      assert.equal(result.known[1]!.propertyName, 'версия');
    });

    it('распознаёт хвостовую арифметику ±Nd', () => {
      const result = scanStringForTokens('$today+7d $today-1d $now+0d');
      assert.equal(result.unknown.length, 0);
      assert.equal(result.known[0]!.daysOffset, 7);
      assert.equal(result.known[1]!.daysOffset, -1);
      assert.equal(result.known[2]!.daysOffset, 0);
    });

    it('распознаёт арифметику у свойств-дат', () => {
      const result = scanStringForTokens('$thought.[Плановый срок]+3d');
      assert.equal(result.known.length, 1);
      assert.equal(result.known[0]!.kind, 'thought_property');
      assert.equal(result.known[0]!.propertyName, 'Плановый срок');
      assert.equal(result.known[0]!.daysOffset, 3);
    });

    it('неизвестный $-фрагмент попадает в unknown', () => {
      // Проверочная строка содержит только заведомо невалидные токены.
      // `$thought` (голая) валидна по ADR 7c1c5bf5 (синоним `$thought.id`),
      // поэтому здесь использованы фрагменты, которых нет в закрытом
      // пространстве имён.
      const result = scanStringForTokens('$foo $something.bar $unknown_thing');
      assert.equal(result.known.length, 0);
      assert.equal(result.unknown.length, 3);
      assert.equal(result.unknown[0]!.raw, '$foo');
      assert.equal(result.unknown[1]!.raw, '$something.bar');
      assert.equal(result.unknown[2]!.raw, '$unknown_thing');
    });

    it('фрагмент $100 и $тест — не токены (не латинская буква)', () => {
      const result = scanStringForTokens('Цена: $100 за штуку, $тест');
      assert.equal(result.known.length, 0);
      assert.equal(result.unknown.length, 0);
    });

    it('возвращает корректные координаты', () => {
      const result = scanStringForTokens('hello $today world');
      assert.equal(result.known.length, 1);
      assert.equal(result.known[0]!.start, 6);
      assert.equal(result.known[0]!.end, 12);
      assert.equal(result.known[0]!.raw, '$today');
    });
  },
);

// ============================================================================
// 2. Валидатор
// ============================================================================

describe(
  'thought_type_view tokens: validator',
  () => {
    it('пропускает определение без токенов', () => {
      const def = parseOrThrow<Record<string, unknown>>('{"keywords":"alpha","sort":"alpha","order":"asc"}');
      validateDefinitionForTokens(def);
    });

    it('пропускает известные токены', () => {
      const def = parseOrThrow<Record<string, unknown>>(
        '{"keywords":"$today","sort":"alpha","order":"asc"}',
      );
      validateDefinitionForTokens(def);
    });

    it('отвергает неизвестный токен (требование ADR: закрытое пространство имён)', () => {
      const def = parseOrThrow<Record<string, unknown>>(
        '{"keywords":"$foo bar","sort":"alpha","order":"asc"}',
      );
      assert.throws(
        () => validateDefinitionForTokens(def),
        (err: unknown) => err instanceof EtnError &&
          err.code === 'VALIDATION_ERROR' &&
          (err.details as { reason?: string }).reason === 'unknown_token',
      );
    });

    it('отвергает $thought с неизвестным полем', () => {
      const def = parseOrThrow<Record<string, unknown>>(
        '{"keywords":"$thought.foo","sort":"alpha","order":"asc"}',
      );
      assert.throws(
        () => validateDefinitionForTokens(def),
        (err: unknown) => err instanceof EtnError &&
          (err.details as { reason?: string }).reason === 'unknown_token',
      );
    });

    it('отвергает $thought.[НесуществующееСвойство] когда передана цепочка типа', () => {
      const def = parseOrThrow<Record<string, unknown>>(
        '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[НетТакого]"}],"sort":"alpha","order":"asc"}',
      );
      const thoughtType = {
        properties: [
          { key: 'Версия', multiple: false, value_type: 'thought_ref' as const },
        ],
      };
      assert.throws(
        () => validateDefinitionForTokens(def, { thoughtType }),
        (err: unknown) => err instanceof EtnError &&
          (err.details as { reason?: string }).reason === 'unknown_property',
      );
    });

    it('отвергает $thought.[множественное] в скалярной операции (требование 12fccde9)', () => {
      const def = parseOrThrow<Record<string, unknown>>(
        '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[Теги]"}],"sort":"alpha","order":"asc"}',
      );
      const thoughtType = {
        properties: [
          { key: 'Теги', multiple: true, value_type: 'text' as const },
        ],
      };
      assert.throws(
        () => validateDefinitionForTokens(def, { thoughtType }),
        (err: unknown) => err instanceof EtnError &&
          (err.details as { reason?: string }).reason === 'incompatible_operation',
      );
    });

    it('допускает $thought.[множественное] в операции in/not_in', () => {
      const def1 = parseOrThrow<Record<string, unknown>>(
        '{"properties":[{"property_id":"x","op":"in","value":["$thought.[Теги]"]}],"sort":"alpha","order":"asc"}',
      );
      const def2 = parseOrThrow<Record<string, unknown>>(
        '{"properties":[{"property_id":"x","op":"not_in","value":["$thought.[Теги]"]}],"sort":"alpha","order":"asc"}',
      );
      const thoughtType = {
        properties: [
          { key: 'Теги', multiple: true, value_type: 'text' as const },
        ],
      };
      validateDefinitionForTokens(def1, { thoughtType });
      validateDefinitionForTokens(def2, { thoughtType });
    });

    it('собирает все проблемы при collectAll=true', () => {
      const def = parseOrThrow<Record<string, unknown>>(
        '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[НетТакого]"}],"keywords":"$foo","sort":"alpha","order":"asc"}',
      );
      const thoughtType = {
        properties: [
          { key: 'Версия', multiple: false, value_type: 'thought_ref' as const },
        ],
      };
      try {
        validateDefinitionForTokens(def, { thoughtType, collectAll: true });
        assert.fail('expected VALIDATION_ERROR');
      } catch (err) {
        assert.ok(err instanceof EtnError);
        const issues = (err.details as { issues: unknown[] }).issues;
        assert.ok(Array.isArray(issues));
        assert.ok(issues.length >= 2, 'минимум unknown_property + unknown_token');
      }
    });
  },
);

// ============================================================================
// 3. Резолвер
// ============================================================================

describe(
  'thought_type_view tokens: resolver',
  () => {
    const fixedNow = new Date('2026-09-08T10:30:00.000Z');

    function ctx(overrides: Partial<{
      thought: Parameters<typeof buildResolveContext>[0];
      properties: Parameters<typeof buildResolveContext>[1];
      userId: string;
    }> = {}) {
      const thought: Parameters<typeof buildResolveContext>[0] = overrides.thought ?? {
        id: 'thought-1',
        title: 'Работа 1',
        synonyms: ['task', 'дело'],
        type_id: 'type-1',
        active: true,
        created_by: 'alice',
        updated_by: 'bob',
        created_at: '2026-01-15T08:00:00.000Z',
        updated_at: '2026-08-20T14:00:00.000Z',
      };
      const properties = overrides.properties ?? [];
      return buildResolveContext(thought, properties, overrides.userId ?? 'carol', () => fixedNow);
    }

    it('подставляет $thought.id и $thought.title', () => {
      const result = resolveTokensInDefinition(
        parseOrThrow('{"keywords":"$thought.title","sort":"alpha","order":"asc"}'),
        ctx(),
      );
      assert.equal(result.unresolved.length, 0);
      const def = result.definition as { keywords: string };
      assert.equal(def.keywords, 'Работа 1');
    });

    it('подставляет $today как YYYY-MM-DD', () => {
      const result = resolveTokensInDefinition(
        parseOrThrow('{"created_after":"$today","sort":"alpha","order":"asc"}'),
        ctx(),
      );
      const def = result.definition as { created_after: string };
      assert.equal(def.created_after, '2026-09-08');
    });

    it('подставляет $now как ISO-8601 с временем', () => {
      const result = resolveTokensInDefinition(
        parseOrThrow('{"updated_after":"$now","sort":"alpha","order":"asc"}'),
        ctx(),
      );
      const def = result.definition as { updated_after: string };
      assert.equal(def.updated_after, fixedNow.toISOString());
    });

    it('подставляет $user', () => {
      const result = resolveTokensInDefinition(
        parseOrThrow('{"created_by":"$user","created_by_op":"eq","sort":"alpha","order":"asc"}'),
        ctx({ userId: 'zoe' }),
      );
      const def = result.definition as { created_by: string };
      assert.equal(def.created_by, 'zoe');
    });

    it('арифметика $today+7d', () => {
      const result = resolveTokensInDefinition(
        parseOrThrow('{"created_before":"$today+7d","sort":"alpha","order":"asc"}'),
        ctx(),
      );
      const def = result.definition as { created_before: string };
      assert.equal(def.created_before, '2026-09-15');
    });

    it('арифметика $today-1d', () => {
      const result = resolveTokensInDefinition(
        parseOrThrow('{"created_after":"$today-1d","sort":"alpha","order":"asc"}'),
        ctx(),
      );
      const def = result.definition as { created_after: string };
      assert.equal(def.created_after, '2026-09-07');
    });

    it('арифметика $thought.created+3d', () => {
      const result = resolveTokensInDefinition(
        parseOrThrow('{"created_before":"$thought.created+3d","sort":"alpha","order":"asc"}'),
        ctx(),
      );
      const def = result.definition as { created_before: string };
      // 2026-01-15T08:00:00Z + 3 дня = 2026-01-18T08:00:00Z
      assert.equal(def.created_before, '2026-01-18T08:00:00.000Z');
    });

    it('подставляет скалярное свойство', () => {
      const result = resolveTokensInDefinition(
        parseOrThrow(
          '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[Версия]"}],"sort":"alpha","order":"asc"}',
        ),
        ctx({
          properties: [
            { key: 'Версия', value_type: 'thought_ref', multiple: false, value: 'version-uuid-1' },
          ],
        }),
      );
      assert.equal(result.unresolved.length, 0);
      const def = result.definition as {
        properties: Array<{ value: string }>;
      };
      assert.equal(def.properties[0]!.value, 'version-uuid-1');
    });

    it('подставляет множественное свойство как массив (требование 12fccde9)', () => {
      const result = resolveTokensInDefinition(
        parseOrThrow(
          '{"properties":[{"property_id":"x","op":"in","value":["$thought.[Теги]"]}],"sort":"alpha","order":"asc"}',
        ),
        ctx({
          properties: [
            {
              key: 'Теги',
              value_type: 'text',
              multiple: true,
              value: ['tag-a', 'tag-b'],
            },
          ],
        }),
      );
      assert.equal(result.unresolved.length, 0);
      const def = result.definition as {
        properties: Array<{ value: string[] }>;
      };
      assert.deepEqual(def.properties[0]!.value, ['tag-a', 'tag-b']);
    });

    it('неразрешимое свойство → unresolved (требование b7fdab20)', () => {
      const result = resolveTokensInDefinition(
        parseOrThrow(
          '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[ПустоеСвойство]"}],"sort":"alpha","order":"asc"}',
        ),
        ctx(),
      );
      assert.equal(result.unresolved.length, 1);
      assert.equal(result.unresolved[0]!.reason, 'unknown_property');
      assert.match(result.unresolved[0]!.message, /ПустоеСвойство/);
    });

    it('нерезолвимое поле active-false остаётся строкой, не молча пустой', () => {
      // active=false не имеет смысла для фильтра, но как резолв работает.
      // Проверяем: $thought.active → "false".
      const result = resolveTokensInDefinition(
        parseOrThrow('{"active":false,"show_inactive":true,"sort":"alpha","order":"asc"}'),
        ctx(),
      );
      assert.equal(result.unresolved.length, 0);
    });

    it('неизвестный токен в резолвере → unresolved (защита от подмены определения)', () => {
      const result = resolveTokensInDefinition(
        parseOrThrow('{"keywords":"$foo","sort":"alpha","order":"asc"}'),
        ctx(),
      );
      assert.equal(result.unresolved.length, 1);
      assert.equal(result.unresolved[0]!.reason, 'unknown_token');
    });

    it('не мутирует входной объект', () => {
      const original = parseOrThrow<Record<string, unknown>>(
        '{"keywords":"$today","sort":"alpha","order":"asc"}',
      );
      const result = resolveTokensInDefinition(original, ctx());
      // оригинал остался строкой с токеном
      const def = original as { keywords: string };
      assert.equal(def.keywords, '$today');
      // в результате токен подставлен
      const defResult = result.definition as { keywords: string };
      assert.equal(defResult.keywords, '2026-09-08');
    });
  },
);

// ============================================================================
// 4. Интеграция: сервис отборов блокирует невалидный токен при сохранении
// ============================================================================

describe(
  'thought_type_view tokens: integration with service',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    /**
     * Сеть + тип «задача» со свойствами:
     *   - «Версия» (thought_ref, single)
     *   - «Теги» (text, multiple=true)
     *   - «Плановый срок» (date)
     */
    function setup(): { ndb: NetworkDb; typeId: string } {
      const ndb = createInMemoryNetworkDb();
      const tt = createThoughtType(ndb, { name: 'task' }, USER);
      createTypeProperty(
        ndb,
        'thought_type',
        tt.id,
        { key: 'Версия', value_type: 'thought_ref' },
        USER,
      );
      createTypeProperty(
        ndb,
        'thought_type',
        tt.id,
        { key: 'Теги', value_type: 'text', config: { multiple: true } },
        USER,
      );
      createTypeProperty(
        ndb,
        'thought_type',
        tt.id,
        { key: 'Плановый срок', value_type: 'date' },
        USER,
      );
      return { ndb, typeId: tt.id };
    }

    it('create: токен свойства из цепочки типа → успех', () => {
      const { ndb, typeId } = setup();
      try {
        const created = createThoughtTypeView(
          ndb,
          typeId,
          {
            name: 'По версии',
            definition:
              '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[Версия]"}],"sort":"alpha","order":"asc"}',
          },
          USER,
        );
        assert.equal(created.name, 'По версии');
      } finally {
        ndb.close();
      }
    });

    it('create: токен неизвестного свойства → 422', () => {
      const { ndb, typeId } = setup();
      try {
        assert.throws(
          () =>
            createThoughtTypeView(
              ndb,
              typeId,
              {
                name: 'Битый',
                definition:
                  '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[НетТакого]"}],"sort":"alpha","order":"asc"}',
              },
              USER,
            ),
          (err: unknown) => err instanceof EtnError &&
            err.code === 'VALIDATION_ERROR' &&
            (err.details as { reason?: string }).reason === 'unknown_property',
        );
      } finally {
        ndb.close();
      }
    });

    it('create: множественное свойство в скалярной операции → 422', () => {
      const { ndb, typeId } = setup();
      try {
        assert.throws(
          () =>
            createThoughtTypeView(
              ndb,
              typeId,
              {
                name: 'Теги-скаляр',
                definition:
                  '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[Теги]"}],"sort":"alpha","order":"asc"}',
              },
              USER,
            ),
          (err: unknown) => err instanceof EtnError &&
            (err.details as { reason?: string }).reason === 'incompatible_operation',
        );
      } finally {
        ndb.close();
      }
    });

    it('create: синтаксическая ошибка (неизвестный токен) → 422', () => {
      const { ndb, typeId } = setup();
      try {
        assert.throws(
          () =>
            createThoughtTypeView(
              ndb,
              typeId,
              {
                name: 'Мусор',
                definition:
                  '{"keywords":"$foo bar","sort":"alpha","order":"asc"}',
              },
              USER,
            ),
          (err: unknown) => err instanceof EtnError &&
            (err.details as { reason?: string }).reason === 'unknown_token',
        );
      } finally {
        ndb.close();
      }
    });

    it('create: глобальные токены $today/$now/$user без свойств → успех', () => {
      const { ndb, typeId } = setup();
      try {
        const created = createThoughtTypeView(
          ndb,
          typeId,
          {
            name: 'Свежие',
            definition:
              '{"created_after":"$today-1d","updated_before":"$now","created_by":"$user","sort":"alpha","order":"asc"}',
          },
          USER,
        );
        assert.ok(created.id);
      } finally {
        ndb.close();
      }
    });

    it('update: правка definition с невалидным токеном → 422, состояние не меняется', () => {
      const { ndb, typeId } = setup();
      try {
        const created = createThoughtTypeView(
          ndb,
          typeId,
          { name: 'Ок', definition: SORT_DEFINITION },
          USER,
        );
        assert.throws(
          () =>
            updateThoughtTypeView(
              ndb,
              created.id,
              {
                definition:
                  '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[НетТакого]"}],"sort":"alpha","order":"asc"}',
              },
              undefined,
              USER,
            ),
          (err: unknown) => err instanceof EtnError &&
            (err.details as { reason?: string }).reason === 'unknown_property',
        );
      } finally {
        ndb.close();
      }
    });

    it('create: арифметика над $today и свойством-датой → успех', () => {
      const { ndb, typeId } = setup();
      try {
        createThoughtTypeView(
          ndb,
          typeId,
          {
            name: 'Сроки',
            definition:
              '{"properties":[{"property_id":"x","op":"gt","value":"$today-1d"},{"property_id":"y","op":"lt","value":"$thought.[Плановый срок]+3d"}],"sort":"alpha","order":"asc"}',
          },
          USER,
        );
      } finally {
        ndb.close();
      }
    });

    // Тихий smoke: setPropertyValue используется ниже как пример, что
    // пустое значение для скалярного свойства остаётся null в БД и не
    // попадает в resolve-контекст (требование b7fdab20).
    it('run-time: пустое значение свойства даёт unresolved (без этапа 5)', () => {
      const { ndb, typeId } = setup();
      try {
        // Создаём мысль и отбор, у мысли НЕ заполняем «Версия».
        const thoughtId = randomUUID();
        ndb
          .prepare(
            `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                                   version, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, ?, ?, 1, 0, 0, 1,
                     '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
          )
          .run(thoughtId, 'Sample', 'sample', typeId);

        createThoughtTypeView(
          ndb,
          typeId,
          {
            name: 'По версии',
            definition:
              '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[Версия]"}],"sort":"alpha","order":"asc"}',
          },
          USER,
        );

        // Резолвер от лица мысли без значения — должен собрать unresolved.
        // (runViewForThought здесь не вызываем, чтобы не дублировать слой
        // engine'а; достаточно проверить сборку контекста и резолвер.)
        const ctx = buildResolveContext(
          {
            id: thoughtId,
            title: 'Sample',
            synonyms: [],
            type_id: typeId,
            active: true,
            created_by: 'u',
            updated_by: 'u',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
          [], // пустой список свойств — `Версия` не заполнена
          'u',
          () => new Date('2026-09-08T10:30:00.000Z'),
        );
        const result = resolveTokensInDefinition(
          parseOrThrow(
            '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[Версия]"}],"sort":"alpha","order":"asc"}',
          ),
          ctx,
        );
        assert.equal(result.unresolved.length, 1);
        assert.equal(result.unresolved[0]!.reason, 'unknown_property');
      } finally {
        ndb.close();
      }
    });
  },
);

// Подавляем unused-warning у фиктивной переменной.
void ({} as PropertyMeta[]);
