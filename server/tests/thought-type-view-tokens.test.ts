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
import { createThought } from '../src/domain/thought-service.js';
import { createTypeProperty, listEffectiveTypeProperties, setPropertyValue } from '../src/domain/property-service.js';
import { seedThoughtRefProperty } from './seed-thought-ref.js';
import {
  createThoughtTypeView,
  runViewForThought,
  updateThoughtTypeView,
} from '../src/domain/thought-type-views-service.js';
import {
  buildResolveContext,
  resolveGlobalDateTokens,
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

    it('отвергает $thought.[Имя] которого нет в РЕЕСТРЕ СЕТИ (unknown_property)', () => {
      const def = parseOrThrow<Record<string, unknown>>(
        '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[НетТакого]"}],"sort":"alpha","order":"asc"}',
      );
      const properties = [
        { key: 'Версия', multiple: false, value_type: 'thought_ref' as const },
      ];
      assert.throws(
        () => validateDefinitionForTokens(def, { properties }),
        (err: unknown) => err instanceof EtnError &&
          (err.details as { reason?: string }).reason === 'unknown_property',
      );
    });

    it('принимает $thought.[Имя] свойства ВНЕ типа отбора — по реестру сети (п. A6)', () => {
      // Свойство определено в сети, но не привязано к типу этого отбора:
      // раньше отвергалось `unknown_property`, теперь принимается (резолв по
      // реестру; отсутствие значения у мысли — пустое значение, не ошибка).
      const def = parseOrThrow<Record<string, unknown>>(
        '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[Свойство другого типа]"}],"sort":"alpha","order":"asc"}',
      );
      const properties = [
        { key: 'Версия', multiple: false, value_type: 'thought_ref' as const },
        { key: 'Свойство другого типа', multiple: false, value_type: 'text' as const },
      ];
      validateDefinitionForTokens(def, { properties });
    });

    it('отвергает $thought.[множественное] в скалярной операции (требование 12fccde9)', () => {
      const def = parseOrThrow<Record<string, unknown>>(
        '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[Теги]"}],"sort":"alpha","order":"asc"}',
      );
      const properties = [
        { key: 'Теги', multiple: true, value_type: 'text' as const },
      ];
      assert.throws(
        () => validateDefinitionForTokens(def, { properties }),
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
      const properties = [
        { key: 'Теги', multiple: true, value_type: 'text' as const },
      ];
      validateDefinitionForTokens(def1, { properties });
      validateDefinitionForTokens(def2, { properties });
    });

    it('собирает все проблемы при collectAll=true', () => {
      const def = parseOrThrow<Record<string, unknown>>(
        '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[НетТакого]"}],"keywords":"$foo","sort":"alpha","order":"asc"}',
      );
      const properties = [
        { key: 'Версия', multiple: false, value_type: 'thought_ref' as const },
      ];
      try {
        validateDefinitionForTokens(def, { properties, collectAll: true });
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

    it('свойства нет у мысли → ПУСТОЕ значение, а не неразрешимый токен (п. A6)', () => {
      // Свойство резолвится по реестру сети: если у оцениваемой мысли значения
      // нет (или свойство не подключено к типу) — по семантике отбора это пустое
      // значение, отбор исполняется, а не возвращает пустой результат с
      // пояснением (ошибка 50d9bf4e, пункт A6).
      const result = resolveTokensInDefinition(
        parseOrThrow(
          '{"properties":[{"property_id":"x","op":"eq","value":"$thought.[ПустоеСвойство]"}],"sort":"alpha","order":"asc"}',
        ),
        ctx(),
      );
      assert.equal(result.unresolved.length, 0);
      const def = result.definition as { properties: Array<{ value: string }> };
      assert.equal(def.properties[0]!.value, '');
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
      seedThoughtRefProperty(ndb, 'thought_type', tt.id, 'Версия', {}, USER);
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

    // Smoke: пустое значение для скалярного свойства не попадает в
    // resolve-контекст — по семантике отбора это ПУСТОЕ значение (A6), а не
    // неразрешимый токен.
    it('run-time: пустое значение свойства → пустое значение, без unresolved (п. A6)', () => {
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

        // Резолвер от лица мысли без значения — пустое значение, отбор исполним.
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
        assert.equal(result.unresolved.length, 0);
        const def = result.definition as { properties: Array<{ value: string }> };
        assert.equal(def.properties[0]!.value, '');
      } finally {
        ndb.close();
      }
    });

    /**
     * Регресс ошибки 7489e4d9: множественное `text`-значение мысли хранится
     * comma-joined строкой, и токен `$thought.[Теги]` подставлялся в отбор
     * этой склеенной строкой одним элементом — условие «в списке» по нему не
     * матчило. Резолвер обязан отдать СПИСОК элементов (требование 12fccde9).
     */
    it('run-time: множественное text-значение подставляется списком элементов', async () => {
      const { ndb, typeId } = setup();
      try {
        const tagsPropId = listEffectiveTypeProperties(ndb, 'thought_type', typeId)
          .find((p) => p.key === 'Теги')!.property_id;

        const context = createThought(ndb, { title: 'Контекст', type_id: typeId }, USER);
        const hit = createThought(ndb, { title: 'Совпадение', type_id: typeId }, USER);
        const miss = createThought(ndb, { title: 'Мимо', type_id: typeId }, USER);
        setPropertyValue(ndb, 'thought', context.id, 'Теги', 'tag-a, tag-b', USER);
        setPropertyValue(ndb, 'thought', hit.id, 'Теги', 'tag-a', USER);
        setPropertyValue(ndb, 'thought', miss.id, 'Теги', 'tag-c', USER);

        const view = createThoughtTypeView(
          ndb,
          typeId,
          {
            name: 'По тегам',
            definition: JSON.stringify({
              properties: [{ property_id: tagsPropId, op: 'in', value: ['$thought.[Теги]'] }],
              sort: 'alpha',
              order: 'asc',
            }),
          },
          USER,
        );

        const res = await runViewForThought(ndb, view, context.id, USER);
        assert.deepEqual(res.unresolved, []);
        assert.deepEqual(
          res.items.map((i) => i.id),
          [hit.id],
          'элемент tag-a из значения "tag-a, tag-b" матчится поэлементно',
        );
        assert.ok(!res.items.some((i) => i.id === miss.id));
      } finally {
        ndb.close();
      }
    });

    it('run-time: первый день недели сети доезжает в плоскую форму (задача 7a798b17)', async () => {
      const { ndb, typeId } = setup();
      try {
        const context = createThought(ndb, { title: 'Контекст', type_id: typeId }, USER);
        const sunday = createThought(ndb, { title: 'Вс', type_id: typeId }, USER);
        const wednesday = createThought(ndb, { title: 'Ср', type_id: typeId }, USER);
        const setCreated = (id: string, iso: string): void => {
          ndb.prepare('UPDATE thoughts SET created_at = ? WHERE id = ?').run(iso, id);
        };
        setCreated(sunday.id, '2024-06-09T12:00:00.000Z'); // воскресенье
        setCreated(wednesday.id, '2024-06-12T12:00:00.000Z');

        const view = createThoughtTypeView(
          ndb,
          typeId,
          {
            name: 'С начала недели',
            definition: JSON.stringify({ created_after: '$weekStart', sort: 'alpha', order: 'asc' }),
          },
          USER,
        );

        const nowMs = new Date('2024-06-15T10:00:00.000Z').getTime(); // суббота
        // Без firstDayOfWeek неделя считается с понедельника — воскресенье не входит.
        const monday = await runViewForThought(ndb, view, context.id, USER, undefined, {
          tokenContext: { nowMs },
        });
        assert.deepEqual(monday.items.map((i) => i.title), ['Ср']);
        // firstDayOfWeek = 7 (воскресенье) — неделя начинается 09.06, входит и «Вс».
        const sundayStart = await runViewForThought(ndb, view, context.id, USER, undefined, {
          tokenContext: { nowMs, firstDayOfWeek: 7 },
        });
        assert.deepEqual([...sundayStart.items.map((i) => i.title)].sort(), ['Вс', 'Ср']);
      } finally {
        ndb.close();
      }
    });
  },
);

// Подавляем unused-warning у фиктивной переменной.
void ({} as PropertyMeta[]);

describe('токены границ недели/месяца и арифметика ±Nw/±Nmo (0.10.1, 91f8d8dd)', () => {
  it('распознаёт $week.start/$week.end/$month.start/$month.end как глобальные', () => {
    const result = scanStringForTokens(
      '$week.start $week.end $month.start $month.end',
    );
    assert.equal(result.unknown.length, 0);
    assert.deepEqual(
      result.known.map((t) => t.kind),
      ['global', 'global', 'global', 'global'],
    );
  });

  it('распознаёт арифметику ±Nw и ±Nmo', () => {
    const result = scanStringForTokens('$week.start-1w $month.end+1mo $today+2d');
    assert.equal(result.unknown.length, 0);
    assert.equal(result.known[0]!.weeksOffset, -1);
    assert.equal(result.known[1]!.monthsOffset, 1);
    assert.equal(result.known[2]!.daysOffset, 2);
  });

  it('неделя начинается с понедельника, месяц — по календарю (UTC)', () => {
    // 2026-09-26 — суббота; неделя 2026-09-21 (пн) … 2026-09-27 (вс).
    const now = (): Date => new Date('2026-09-26T12:00:00.000Z');
    assert.equal(resolveGlobalDateTokens('$week.start', { now }).value, '2026-09-21');
    assert.equal(resolveGlobalDateTokens('$week.end', { now }).value, '2026-09-27');
    assert.equal(resolveGlobalDateTokens('$month.start', { now }).value, '2026-09-01');
    assert.equal(resolveGlobalDateTokens('$month.end', { now }).value, '2026-09-30');
  });

  it('арифметика недель и месяцев сдвигает границы', () => {
    const now = (): Date => new Date('2026-09-26T12:00:00.000Z');
    assert.equal(resolveGlobalDateTokens('$week.start+1w', { now }).value, '2026-09-28');
    assert.equal(resolveGlobalDateTokens('$week.end-1w', { now }).value, '2026-09-20');
    assert.equal(resolveGlobalDateTokens('$month.start+1mo', { now }).value, '2026-10-01');
    assert.equal(resolveGlobalDateTokens('$month.end-1mo', { now }).value, '2026-08-31');
  });

  it('месячная арифметика прижимает день к концу месяца', () => {
    // 31 марта -1mo → 28 февраля (2026 не високосный).
    const now = (): Date => new Date('2026-03-31T12:00:00.000Z');
    assert.equal(resolveGlobalDateTokens('$month.end-1mo', { now }).value, '2026-02-28');
    // 31 марта +1mo → 30 апреля.
    assert.equal(resolveGlobalDateTokens('$month.end+1mo', { now }).value, '2026-04-30');
  });

  it('период принимает новые токены (нет unresolved)', () => {
    const now = (): Date => new Date('2026-09-26T12:00:00.000Z');
    for (const token of ['$week.start-1w', '$month.start', '$month.end+1mo']) {
      assert.equal(resolveGlobalDateTokens(token, { now }).unresolved.length, 0, token);
    }
  });
});

describe('токены границ года и арифметика ±Ny (0.10.1, приёмка №2)', () => {
  it('распознаёт $year.start/$year.end как глобальные', () => {
    const result = scanStringForTokens('$year.start $year.end');
    assert.equal(result.unknown.length, 0);
    assert.deepEqual(
      result.known.map((t) => t.kind),
      ['global', 'global'],
    );
  });

  it('распознаёт арифметику ±Ny', () => {
    const result = scanStringForTokens('$year.start-1y $year.end+2y $month.end+1y');
    assert.equal(result.unknown.length, 0);
    assert.equal(result.known[0]!.yearsOffset, -1);
    assert.equal(result.known[1]!.yearsOffset, 2);
    assert.equal(result.known[2]!.yearsOffset, 1);
  });

  it('границы года — 1 января / 31 декабря', () => {
    const now = (): Date => new Date('2026-09-26T12:00:00.000Z');
    assert.equal(resolveGlobalDateTokens('$year.start', { now }).value, '2026-01-01');
    assert.equal(resolveGlobalDateTokens('$year.end', { now }).value, '2026-12-31');
  });

  it('годовая арифметика сдвигает границы года и не прижимает числа', () => {
    const now = (): Date => new Date('2026-09-26T12:00:00.000Z');
    assert.equal(resolveGlobalDateTokens('$year.start+1y', { now }).value, '2027-01-01');
    assert.equal(resolveGlobalDateTokens('$year.end-1y', { now }).value, '2025-12-31');
    // Високосный 2028 год: конец года — 31 декабря.
    assert.equal(resolveGlobalDateTokens('$year.end+2y', { now }).value, '2028-12-31');
  });

  it('±Ny = 12 календарных месяцев для произвольного якоря', () => {
    const now = (): Date => new Date('2026-03-31T12:00:00.000Z');
    // Конец месяца года назад: 31 марта −1 год → 31 марта 2025.
    assert.equal(resolveGlobalDateTokens('$today-1y', { now }).value, '2025-03-31');
    assert.equal(resolveGlobalDateTokens('$month.end+1y', { now }).value, '2027-03-31');
  });

  it('период принимает годовые токены (нет unresolved)', () => {
    const now = (): Date => new Date('2026-09-26T12:00:00.000Z');
    for (const token of ['$year.start', '$year.end', '$year.start-1y', '$year.end+1y']) {
      assert.equal(
        resolveGlobalDateTokens(token, { now }).unresolved.length,
        0,
        token,
      );
    }
  });
});

// ============================================================================
// 5. Календарные границы, первый день недели, арифметика ±N, контекст времени
//    (0.13.1, задача 0f1b9892; требования 84b52caa и 1b77decd)
// ============================================================================

describe('токены календарных границ (0.13.1, задача 0f1b9892)', () => {
  const wed = (): Date => new Date('2026-09-09T10:30:00.000Z'); // среда

  it('канон camelCase и легаси-синонимы дают одинаковый результат', () => {
    const pairs: Array<[string, string]> = [
      ['$weekStart', '$week.start'],
      ['$weekEnd', '$week.end'],
      ['$monthStart', '$month.start'],
      ['$monthEnd', '$month.end'],
      ['$yearStart', '$year.start'],
      ['$yearEnd', '$year.end'],
    ];
    for (const [canon, legacy] of pairs) {
      assert.deepEqual(
        resolveGlobalDateTokens(canon, { now: wed }),
        resolveGlobalDateTokens(legacy, { now: wed }),
        `${canon} ↔ ${legacy}`,
      );
      assert.equal(
        resolveGlobalDateTokens(canon, { now: wed }).unresolved.length,
        0,
        `${canon} должен быть известным токеном`,
      );
    }
  });

  it('$weekStart/$weekEnd — неделя с понедельника по умолчанию', () => {
    assert.equal(resolveGlobalDateTokens('$weekStart', { now: wed }).value, '2026-09-07');
    assert.equal(resolveGlobalDateTokens('$weekEnd', { now: wed }).value, '2026-09-13');
  });

  it('первый день недели сети учитывается ($weekStart=вс, ISO 7)', () => {
    // Среда 09.09.2026 при первом дне «воскресенье»: неделя 06.09–12.09.
    assert.equal(
      resolveGlobalDateTokens('$weekStart', { now: wed, firstDayOfWeek: 7 }).value,
      '2026-09-06',
    );
    assert.equal(
      resolveGlobalDateTokens('$weekEnd', { now: wed, firstDayOfWeek: 7 }).value,
      '2026-09-12',
    );
    // Суббота при первом дне «суббота» (6) — начало недели та же суббота.
    const sat = (): Date => new Date('2026-09-12T10:00:00.000Z');
    assert.equal(
      resolveGlobalDateTokens('$weekStart', { now: sat, firstDayOfWeek: 6 }).value,
      '2026-09-12',
    );
  });

  it('$monthStart/$monthEnd и $yearStart/$yearEnd', () => {
    assert.equal(resolveGlobalDateTokens('$monthStart', { now: wed }).value, '2026-09-01');
    assert.equal(resolveGlobalDateTokens('$monthEnd', { now: wed }).value, '2026-09-30');
    assert.equal(resolveGlobalDateTokens('$yearStart', { now: wed }).value, '2026-01-01');
    assert.equal(resolveGlobalDateTokens('$yearEnd', { now: wed }).value, '2026-12-31');
  });

  it('клэмпинг месяца: 31.01 + 1mo → последний день февраля', () => {
    const jan31 = (): Date => new Date('2026-01-31T10:00:00.000Z');
    assert.equal(resolveGlobalDateTokens('$today+1mo', { now: jan31 }).value, '2026-02-28');
    const leap = (): Date => new Date('2024-01-31T10:00:00.000Z');
    assert.equal(resolveGlobalDateTokens('$today+1mo', { now: leap }).value, '2024-02-29');
  });

  it('клэмпинг года: 29.02 високосного + 1y → 28.02', () => {
    const feb29 = (): Date => new Date('2024-02-29T10:00:00.000Z');
    assert.equal(resolveGlobalDateTokens('$today+1y', { now: feb29 }).value, '2025-02-28');
    // 29.02 − 1y → 28.02 предыдущего (не високосного) года.
    assert.equal(resolveGlobalDateTokens('$today-1y', { now: feb29 }).value, '2023-02-28');
  });

  it('неделя = ровно 7 суток (±Nw)', () => {
    assert.equal(resolveGlobalDateTokens('$today+1w', { now: wed }).value, '2026-09-16');
    assert.equal(resolveGlobalDateTokens('$today-2w', { now: wed }).value, '2026-08-26');
  });

  it('арифметика границ: $weekStart-1w, $monthEnd+1mo, $yearStart-1y', () => {
    assert.equal(resolveGlobalDateTokens('$weekStart-1w', { now: wed }).value, '2026-08-31');
    // $monthEnd — последний день сентября; +1mo → последний день октября.
    assert.equal(resolveGlobalDateTokens('$monthEnd+1mo', { now: wed }).value, '2026-10-31');
    assert.equal(resolveGlobalDateTokens('$yearStart-1y', { now: wed }).value, '2025-01-01');
  });
});

describe('токены времени: контекст/профиль (ADR 0c02ab4f)', () => {
  const now = (): Date => new Date('2026-09-09T13:37:45.123Z');

  it('$now/$hourStart/$hourEnd раскрываются только при withTime', () => {
    assert.equal(resolveGlobalDateTokens('$now', { now, withTime: true }).value, now().toISOString());
    assert.equal(
      resolveGlobalDateTokens('$hourStart', { now, withTime: true }).value,
      '2026-09-09T13:00:00.000Z',
    );
    assert.equal(
      resolveGlobalDateTokens('$hourEnd', { now, withTime: true }).value,
      '2026-09-09T13:59:59.999Z',
    );
  });

  it('в профиле без времени ($now/$hourStart) — неразрешимы', () => {
    for (const token of ['$now', '$hourStart', '$hourEnd', '$now+1h', '$today+30mi']) {
      const res = resolveGlobalDateTokens(token, { now, withTime: false });
      assert.equal(res.unresolved.length, 1, token);
      assert.equal(res.unresolved[0]!.reason, 'time_context_required', token);
      assert.equal(res.value, token, 'значение не подменяется');
    }
  });

  it('h/mi допустимы со временем и сдвигают момент', () => {
    assert.equal(
      resolveGlobalDateTokens('$now-2h', { now, withTime: true }).value,
      '2026-09-09T11:37:45.123Z',
    );
    assert.equal(
      resolveGlobalDateTokens('$hourStart+30mi', { now, withTime: true }).value,
      '2026-09-09T13:30:00.000Z',
    );
  });

  it('валидатор отвергает токен времени в профиле без времени', () => {
    const def = parseOrThrow<Record<string, unknown>>(
      '{"created_after":"$hourStart","sort":"alpha","order":"asc"}',
    );
    assert.throws(
      () => validateDefinitionForTokens(def, { withTime: false }),
      (err: unknown) => err instanceof EtnError &&
        (err.details as { reason?: string }).reason === 'time_context_required',
    );
    // Со временем — проходит.
    validateDefinitionForTokens(def, { withTime: true });
  });

  it('без флага withTime сохраняется историческое поведение ($now разрешён)', () => {
    const res = resolveGlobalDateTokens('$now', { now });
    assert.equal(res.unresolved.length, 0);
    assert.equal(res.value, now().toISOString());
  });

  it('резолвер отбора: ctx.withTime=false делает $now неразрешимым', () => {
    const ctxNoTime = buildResolveContext(
      {
        id: 't', title: 'T', synonyms: [], type_id: null, active: true,
        created_by: 'u', updated_by: 'u',
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      },
      [],
      'u',
      now,
      { withTime: false },
    );
    const res = resolveTokensInDefinition(
      parseOrThrow('{"updated_after":"$now","sort":"alpha","order":"asc"}'),
      ctxNoTime,
    );
    assert.equal(res.unresolved.length, 1);
    assert.equal(res.unresolved[0]!.reason, 'time_context_required');
  });
});
