/**
 * Сторож стандарта «запись каждого view одного REST-контракта покрыта тестом»
 * (задача c85e53ec, версия 0.8.2).
 *
 * Прецедент — ошибка 0a8b9da3 (коммит 3939a06): у отбора «Структур» тест
 * записи отсутствовал, тогда как у «Хроники» был; `POST /saved-filters`
 * вдобавок требовал `view` вопреки спецификации — пропуск жил незамеченным,
 * потому что тесты записи покрывали только часть значений вида. Класс дефекта
 * повторяем у любого контракта, где перечислимый параметр-вид (view/enum-режим)
 * выбирает ветку поведения.
 *
 * Правило (стандарт в мыслесети ETN): каждый REST-контракт операции записи,
 * принимающий параметр-вид, обязан иметь тест записи на КАЖДОЕ значение вида;
 * появление нового значения без теста — дефект. Операции только чтения под
 * правило не попадают (записи, которую нужно покрывать, у них нет) и явно
 * перечислены в {@link READ_ONLY_VIEWS}.
 *
 * Как проверяется:
 *   1. охват — обход `server/src/routes/*.ts`: берутся контракты, реально
 *      используемые REST-роутами (`parseRest(<Contract>, ...)`), метод роута
 *      делит их на записи (post/patch/put/delete) и чтение; в их схемах
 *      (`zod`-схема и REST-карта `t`) ищутся поля с именами
 *      {@link VIEW_FIELDS}. Каждое найденное поле обязано быть в реестре —
 *      иначе сторож красный (новый вид без решения).
 *   2. значения — из самой `zod`-схемы контракта (`z.enum`), поэтому
 *      расширение константы вида (`SAVED_FILTER_VIEWS` и т.п.) даёт
 *      непокрытое значение. Контракты импортируют `@etn/shared` из `dist`,
 *      как и сам сервер, — правка `shared/src` становится видна сторожу
 *      после сборки shared (та же сборка нужна и серверу). Для полей,
 *      объявленных `z.string()` с валидацией в домене, значения задаёт
 *      реестр (`values`).
 *   3. покрытие — каждое значение обязано иметь тест записи (`tests`) либо
 *      явное исключение с обоснованием (`excluded`); указанный тест
 *      проверяется по тексту файла (`it('<точное название>')`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FOCUS_DIRS } from '@etn/shared';

import * as contracts from '../src/contracts.js';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(TESTS_DIR, '..', 'src', 'routes');
const CONTRACTS_MODULE = contracts as unknown as Record<string, unknown>;

/**
 * Имена полей, которые стандарт трактует как параметр-вид/режим: значение
 * выбирает вариант выборки, представления или поведения операции. Отличие от
 * атрибута сущности (`owner_type`, `value_type`, `style`, `icon_kind`) и от
 * операции-действия (`op`, `action`) — вид переключает режим, а не описывает
 * данные и не называет действие.
 */
const VIEW_FIELDS = new Set([
  'view',
  'scope',
  'kind',
  'format',
  'dir',
  'group_by',
  'link_scope',
  'duplicate_policy',
  'collision_policy',
  'link_direction',
]);

/** Запись реестра: вид операции записи и покрытие каждого его значения. */
interface WriteViewEntry {
  /** Имя экспортируемого REST-контракта в `server/src/contracts.ts`. */
  contract: string;
  /** Поле-вид в схеме контракта. */
  field: string;
  /** REST-операция записи — для читаемого сообщения сторожа. */
  operation: string;
  /**
   * Значения вида — только для полей, объявленных `z.string()` с валидацией
   * в домене (по схеме значения не извлечь). Для `z.enum` берутся из контракта.
   */
  values?: readonly string[];
  /** значение → `<файл в tests/>::<точное название теста записи>`. */
  tests: Record<string, string>;
  /** значение → причина, почему тест записи осознанно не заводится. */
  excluded?: Record<string, string>;
}

/** Реестр видов операций записи REST-слоя. */
const WRITE_VIEW_COVERAGE: readonly WriteViewEntry[] = [
  {
    contract: 'RestSavedFilterCreateBody',
    field: 'view',
    operation: 'POST /networks/:networkId/saved-filters',
    tests: {
      structures:
        'routes-saved-filters.test.ts::с view=chronicle создаёт отбор «Хроники», с view=structures — «Структур»',
      chronicle:
        'routes-saved-filters.test.ts::с view=chronicle создаёт отбор «Хроники», с view=structures — «Структур»',
    },
  },
  {
    contract: 'RestSavedFilterPatchBody',
    field: 'view',
    operation: 'PATCH /networks/:networkId/saved-filters/:fid',
    tests: {
      structures: 'routes-saved-filters.test.ts::PATCH с явным view сохраняет отбор своего вида',
      chronicle: 'routes-saved-filters.test.ts::PATCH с явным view сохраняет отбор своего вида',
    },
  },
  {
    contract: 'RestCommentCreateOwner',
    field: 'kind',
    operation: 'POST /networks/:networkId/thoughts|links/:id/comments',
    tests: {
      permanent:
        'routes-comments-attachments.test.ts::comments: permanent + chronological CRUD, second permanent → 409',
      chronological:
        'routes-comments-attachments.test.ts::comments: permanent + chronological CRUD, second permanent → 409',
    },
  },
  {
    contract: 'RestCommentCreateTargets',
    field: 'kind',
    operation: 'POST /networks/:networkId/comments/:cid/targets',
    tests: {
      permanent:
        'routes-comments-attachments.test.ts::comments: permanent + chronological CRUD, second permanent → 409',
      chronological:
        'routes-comments-attachments.test.ts::comments: permanent + chronological CRUD, second permanent → 409',
    },
  },
  {
    contract: 'RestAttachmentCreate',
    field: 'kind',
    operation: 'POST /networks/:networkId/thoughts|links/:id/attachments',
    tests: {
      url: 'routes-comments-attachments.test.ts::attachments: url/file validation, list, patch (no If-Match), delete',
      file: 'routes-comments-attachments.test.ts::attachments: url/file validation, list, patch (no If-Match), delete',
    },
  },
  {
    contract: 'RestExport',
    field: 'format',
    operation: 'POST /networks/:networkId/export',
    tests: {
      markdown:
        'routes-search-export.test.ts::export: markdown job goes 202 → done → downloadable; pdf rejected (422)',
      html: 'routes-search-export.test.ts::export: markdown job goes 202 → done → downloadable; pdf rejected (422)',
      pdf: 'routes-search-export.test.ts::export: markdown job goes 202 → done → downloadable; pdf rejected (422)',
      etnx: 'routes-search-export.test.ts::export: .etnx job produces a valid zip with manifest.json (phase P, P2)',
    },
  },
  {
    contract: 'RestPublicationExport',
    field: 'format',
    operation: 'POST /networks/:networkId/publications/:id/export',
    tests: {
      md: 'publication-export.test.ts::markdown: титул, якоря, ссылки, ассеты и предупреждения о недоступных вложениях',
      html: 'publication-export.test.ts::html: внутренний якорь кликабелен, оглавление и обложка-URL',
    },
  },
  {
    contract: 'RestPublicationExportBatch',
    field: 'format',
    operation: 'POST /networks/:networkId/publications/export-batch',
    tests: {
      md: 'publication-export.test.ts::пакетный экспорт: подкаталоги публикаций и суффикс при коллизии slug',
      html: 'publication-export.test.ts::пакетный экспорт: подкаталоги публикаций и суффикс при коллизии slug',
    },
  },
  {
    contract: 'RestFocusPrefsBody',
    field: 'dir',
    operation: 'PUT /networks/:networkId/thoughts/:fid/focus-preferences',
    values: FOCUS_DIRS,
    tests: {
      parents: 'routes-thoughts.test.ts::focus preferences/order: every dir value of the view is accepted',
      children: 'routes-thoughts.test.ts::focus preferences/order: every dir value of the view is accepted',
      siblings: 'routes-thoughts.test.ts::focus preferences/order: every dir value of the view is accepted',
      both: 'routes-thoughts.test.ts::focus preferences/order: every dir value of the view is accepted',
    },
  },
  {
    contract: 'RestFocusOrderBody',
    field: 'dir',
    operation: 'POST /networks/:networkId/thoughts/:fid/focus-order',
    // Домен разрешает ручной порядок только для зон parents/children
    // (MANUAL_DIRS в focus-service): остальные значения вида сюда не доходят.
    values: ['children', 'parents'],
    tests: {
      children: 'routes-thoughts.test.ts::focus preferences/order: every dir value of the view is accepted',
      parents: 'routes-thoughts.test.ts::focus preferences/order: every dir value of the view is accepted',
    },
  },
];

/**
 * Виды операций только чтения: тест записи для них не существует, потому
 * правило к ним не применяется. Запись здесь обязательна — иначе сторож не
 * отличит осознанное исключение от забытого вида.
 */
const READ_ONLY_VIEWS: readonly { contract: string; field: string; note: string }[] = [
  {
    contract: 'RestSearchQuery',
    field: 'scope',
    note: 'GET /search — только чтение',
  },
  {
    contract: 'RestInstructions',
    field: 'scope',
    note: 'GET /networks/:id/instructions — только чтение',
  },
  {
    contract: 'RestNeighborsQuery',
    field: 'dir',
    note: 'GET /thoughts/:id/neighbors — только чтение',
  },
  {
    contract: 'RestHierarchyQuery',
    field: 'dir',
    note: 'GET /thoughts/:id/hierarchy — только чтение',
  },
  {
    contract: 'RestSavedFilterViewQuery',
    field: 'view',
    note: 'GET /saved-filters — только чтение',
  },
  {
    contract: 'RestAttachmentSearch',
    field: 'kind',
    note: 'GET /attachments — только чтение',
  },
];

/** Минимальная длина обоснования исключения — «не тестируемо» без причины не принимается. */
const MIN_EXCLUSION_NOTE = 20;

interface ZodLike {
  _zod?: {
    def?: {
      type?: string;
      innerType?: unknown;
      out?: unknown;
      entries?: Record<string, string>;
    };
  };
}

/** Разворачивает обёртки zod (`optional`/`nullable`/`default`/`pipe`) до базового типа. */
function unwrapZod(type: unknown): ZodLike | undefined {
  let cur = type as ZodLike | undefined;
  for (let i = 0; i < 10 && cur?._zod?.def; i++) {
    const kind = cur._zod.def.type;
    if (
      kind === 'optional' ||
      kind === 'nullable' ||
      kind === 'default' ||
      kind === 'prefault' ||
      kind === 'readonly'
    ) {
      cur = cur._zod.def.innerType as ZodLike;
      continue;
    }
    if (kind === 'pipe') {
      cur = cur._zod.def.out as ZodLike;
      continue;
    }
    break;
  }
  return cur;
}

/** Значения `z.enum` (или `undefined`, если поле не enum). */
function enumValues(type: unknown): string[] | undefined {
  const unwrapped = unwrapZod(type);
  if (unwrapped?._zod?.def?.type !== 'enum') return undefined;
  return Object.keys(unwrapped._zod.def.entries ?? {});
}

interface FoundView {
  contract: string;
  field: string;
  values?: string[];
  isWrite: boolean;
}

/** Контракты, используемые REST-роутами, и методы этих роутов. */
function routeUsages(): Map<string, Set<string>> {
  const usages = new Map<string, Set<string>>();
  const methodRe = /app\.(get|post|patch|put|delete)\s*\(/;
  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
    const lines = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8').split('\n');
    let method = '';
    for (const line of lines) {
      const route = line.match(methodRe);
      if (route !== null) method = route[1]!;
      for (const ref of line.matchAll(/parseRest\((\w+)\s*,/g)) {
        const methods = usages.get(ref[1]!) ?? new Set<string>();
        if (method !== '') methods.add(method);
        usages.set(ref[1]!, methods);
      }
    }
  }
  return usages;
}

/** Все поля-виды REST-контрактов, найденные по факту использования в роутах. */
function findRouteViewFields(): FoundView[] {
  const found: FoundView[] = [];
  for (const [name, methods] of routeUsages()) {
    const contract = CONTRACTS_MODULE[name] as
      | { schema?: { shape?: Record<string, unknown> }; rest?: Record<string, { t?: unknown }> }
      | undefined;
    const shape = contract?.schema?.shape;
    if (shape === undefined) continue;
    const fields = new Set<string>([...Object.keys(shape), ...Object.keys(contract?.rest ?? {})]);
    for (const field of [...fields].sort()) {
      if (!VIEW_FIELDS.has(field)) continue;
      const values = enumValues(shape[field]) ?? enumValues(contract?.rest?.[field]?.t);
      const isWrite = ['post', 'patch', 'put', 'delete'].some((m) => methods.has(m));
      found.push({
        contract: name,
        field,
        ...(values !== undefined ? { values } : {}),
        isWrite,
      });
    }
  }
  return found;
}

const viewKey = (contract: string, field: string): string => `${contract}.${field}`;

describe('guard: каждое значение вида операции записи покрыто тестом записи', () => {
  it('охват: каждое поле-вид REST-контракта заявлено в реестре', () => {
    const found = findRouteViewFields();
    const foundKeys = new Map(found.map((f) => [viewKey(f.contract, f.field), f]));

    const declaredWrite = WRITE_VIEW_COVERAGE.map((e) => viewKey(e.contract, e.field));
    const declaredRead = READ_ONLY_VIEWS.map((e) => viewKey(e.contract, e.field));
    const declared = new Set([...declaredWrite, ...declaredRead]);

    const undeclared = [...foundKeys.keys()].filter((key) => !declared.has(key));
    assert.deepEqual(
      undeclared,
      [],
      `поля-виды не рассмотрены стандартом (добавь их в WRITE_VIEW_COVERAGE или READ_ONLY_VIEWS): ${undeclared.join(', ')}`,
    );

    const stale = [...declared].filter((key) => !foundKeys.has(key));
    assert.deepEqual(
      stale,
      [],
      `реестр ссылается на несуществующие поля-виды (контракт переименован/поле убрано): ${stale.join(', ')}`,
    );

    // Классификация запись/чтение должна совпадать с реальными роутами.
    for (const key of declaredWrite) {
      assert.equal(foundKeys.get(key)?.isWrite, true, `${key}: заявлен как вид записи, но роут только читает`);
    }
    for (const key of declaredRead) {
      assert.equal(foundKeys.get(key)?.isWrite, false, `${key}: заявлен read-only, но роут пишет`);
    }
    for (const entry of READ_ONLY_VIEWS) {
      assert.ok(
        entry.note.trim().length >= MIN_EXCLUSION_NOTE,
        `${viewKey(entry.contract, entry.field)}: read-only без внятного обоснования`,
      );
    }
  });

  it('каждое значение вида операции записи покрыто тестом или исключением', () => {
    const found = new Map(findRouteViewFields().map((f) => [viewKey(f.contract, f.field), f]));

    for (const entry of WRITE_VIEW_COVERAGE) {
      const key = viewKey(entry.contract, entry.field);
      const view = found.get(key);
      assert.ok(view !== undefined, `${key}: поле-вид не найдено в REST-контрактах`);

      const values = view.values ?? entry.values;
      assert.ok(
        values !== undefined && values.length > 0,
        `${key}: не удалось определить значения вида — задай их в поле values реестра`,
      );

      const tested = Object.keys(entry.tests);
      const excluded = Object.keys(entry.excluded ?? {});
      const uncovered = values.filter((v) => !tested.includes(v) && !excluded.includes(v));
      assert.deepEqual(
        uncovered,
        [],
        `${key} (${entry.operation}): значения вида без теста записи или исключения: ${uncovered.join(', ')}`,
      );

      const extra = [...tested, ...excluded].filter((v) => !values.includes(v));
      assert.deepEqual(extra, [], `${key}: в реестре лишние значения (нет в контракте): ${extra.join(', ')}`);

      const both = tested.filter((v) => excluded.includes(v));
      assert.deepEqual(both, [], `${key}: значение не может быть и покрыто, и исключено: ${both.join(', ')}`);

      for (const [value, reason] of Object.entries(entry.excluded ?? {})) {
        assert.ok(
          reason.trim().length >= MIN_EXCLUSION_NOTE,
          `${key} value=${value}: исключение без обоснования`,
        );
      }
    }
  });

  it('заявленные тесты записи существуют и названы точно', () => {
    for (const entry of WRITE_VIEW_COVERAGE) {
      for (const [value, ref] of Object.entries(entry.tests)) {
        const separator = ref.indexOf('::');
        assert.ok(separator > 0, `${viewKey(entry.contract, entry.field)}: ссылка «${ref}» без «::»`);
        const file = ref.slice(0, separator);
        const title = ref.slice(separator + 2);
        const abs = path.join(TESTS_DIR, file);
        assert.ok(fs.existsSync(abs), `${viewKey(entry.contract, entry.field)}: файл тестов «${file}» не найден`);
        const content = fs.readFileSync(abs, 'utf8');
        const present = content.includes(`it('${title}'`) || content.includes(`it("${title}"`);
        assert.ok(
          present,
          `${viewKey(entry.contract, entry.field)} value=${value}: в ${file} нет теста «${title}»`,
        );
      }
    }
  });
});
