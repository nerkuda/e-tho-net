/**
 * Единые контракты входа операций сервера (задача c9d5f21e, веха 8 версии 0.8.2).
 *
 * До вехи 8 вход описывался дважды: ручные парсеры в `routes/*` (~31 функция
 * над `req.params`/`query`/`body`/`headers`) и zod-схемы в `mcp/tools/*`
 * (~70 схем). Ошибки валидации у фасадов различались: REST кидал
 * `EtnError('VALIDATION_ERROR', …)`, MCP получал английский текст SDK.
 *
 * Теперь каждая операция описывает контракт входа **один раз** — единой
 * zod-схемой (логический вход: все поля плоским объектом, имена snake_case,
 * как в MCP) плюс REST-картой `rest`, отвечающей только на вопрос «откуда
 * взять поле в HTTP-запросе». Из контракта генерируются:
 *
 *   - `inputSchema` MCP-инструмента (та же zod-схема, что рекламируется в
 *     `tools/list` и проверяется SDK);
 *   - REST-парсер `parseRest(contract, req)` — достаёт поля из
 *     params/query/body/headers, коэрсит и валидирует той же схемой;
 *   - каноническое сообщение ошибки — ОДНО на поле для обоих фасадов, так
 *     что одинаковый невалидный вход даёт одинаковый код `VALIDATION_ERROR`
 *     и одинаковый текст сообщения в REST и в MCP (MCP оборачивает его в
 *     стандартный префикс `ETN error [CODE]: …`).
 *
 * Канонические сообщения наследуют русский wire-стиль REST-слоя
 * (docs/03-server-api.md §2): `«{key} обязателен.»`, `«{key} должен быть
 * строкой.»` и т.п. — REST-поведение не меняется, MCP приводится к нему.
 *
 * **Место.** Общий модуль вне фасадов: контракт не принадлежит ни `routes/`,
 * ни `mcp/` (фасады не зависят друг от друга — сторож `guard-server-layers`),
 * а домен контрактов входа не знает (он доверяет вызывающим, ADR 8c93f03a).
 */

import type { FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';

import {
  ATTACHMENT_KINDS,
  ATTACHMENT_OWNER_TYPES,
  AUDIT_CATEGORIES,
  COMMENT_KINDS,
  COMMENT_OWNER_TYPES,
  EXPORT_FORMATS,
  EtnError,
  ETNX_SUBTREE_DEPTH_MAX,
  SORT_KINDS,
  STRUCTURE_KEYWORD_SCOPES,
  STRUCTURE_SORTS,
  STRUCTURES_QUERY_MAX_LIMIT,
  SORT_ORDERS,
  FOCUS_DIRS,
  ICON_KINDS,
  LAYER_DIFF_MAX_LIMIT,
  LAYER_DIFF_SECTIONS,
  LAYER_THOUGHT_MERGE_MODES,
  LINK_STYLES,
  MCP_MAX_THOUGHTS_PER_WRITE,
  MCP_VIEW_MODES,
  parseLinkTypeFilterValue,
  PROPERTY_OWNER_TYPES,
  PROPERTY_VALUE_TYPES,
  PUBLICATION_ACTIVE_FILTERS,
  PUBLICATION_EXPORT_FORMATS,
  PUBLICATION_SORTS,
  REALTIME_DEFAULTS,
  SAVED_FILTER_VIEWS,
  SEARCH_SCOPES,
  TRAVERSAL_DEFAULTS,
  TYPES_LIST_SCOPES,
  TYPE_OWNER_TYPES,
  type EtnErrorCode,
  type LinkTypeFilterInput,
  type SearchRequest,
  type StructureDirectionFlags,
  type SubgraphEdge,
  type ThoughtRef,
} from '@etn/shared';
import { ACTIVITY_LIMIT_MAX } from './domain/activity-service.js';
import {
  ICON_COLOR_MESSAGE,
  LIBRARY_ICON_MESSAGE,
  iconColorValid,
  libraryIconValid,
} from './domain/icon-view.js';
import {
  numberingRangeInvalid,
  recipeOverlap,
  summaryHasMarkdownHeadings,
} from './domain/publication-validation.js';
import { validateLayerColors } from './domain/layer-service.js';
import type { TraversalBounds } from './domain/graph-traversal.js';
import type {
  ThoughtQueryOptions,
  ThoughtQueryRequest,
} from './domain/query-service.js';

// ---------------------------------------------------------------------------
// Общие zod-куски (до вехи 8 — `mcp/tools/shared.ts`)
// ---------------------------------------------------------------------------

export const NetworkId = z.string().min(1);
export const ThoughtId = z.string().min(1);
export const LinkId = z.string().min(1);
export const LayerId = z.string().min(1);
export const ExpectedVersion = z.number().int().min(1).optional();

/** Проекция ответа read-инструментов (задача O12, docs/05-mcp-server.md §4.1). */
export const View = z
  .enum(MCP_VIEW_MODES)
  .optional()
  .describe(
    "Response projection: 'compact' (default, drops visual/service fields) or 'full' (legacy shape).",
  );

/** Фильтр обхода по типам связей (задача c965ad03, требование bed23c25). */
export const LinkFilter = z
  .object({
    type_ids: z.array(z.string().min(1)).optional(),
    include_structural: z.boolean().optional(),
  })
  .optional();

/** Error text shared by every `type_id`/`type` pair (task O4). */
export const TYPE_ID_TYPE_CONFLICT = 'provide at most one of type_id or type';

/** Error text shared by every `property_id`/`property` pair (задача d5ab1630). */
export const PROPERTY_ID_PROPERTY_CONFLICT = 'provide at most one of property_id or property';

/**
 * `direction` inline-ссылки (task O4, docs/03-server-api.md §6.3). */
export const LinkDirection = z
  .enum(['parent', 'child'])
  .describe(
    'Role of target_thought_id for the NEW thought: "parent" — attach the new thought ' +
      'UNDER target_thought_id (target becomes its parent); "child" — the NEW thought ' +
      'becomes the parent of target_thought_id.',
  );

// ---------------------------------------------------------------------------
// REST-источники и спецификация поля
// ---------------------------------------------------------------------------

/** Откуда REST берёт значение поля и как его коэрсит. */
export type RestSource =
  | { kind: 'param'; name?: string }
  | { kind: 'query'; name?: string; coerce?: 'int' | 'bool'; min?: number; repeatable?: boolean }
  | { kind: 'body'; name?: string }
  | { kind: 'header'; name?: string; int?: true };

/**
 * REST-спецификация одного поля. Ключи карты `rest` могут и не входить в
 * zod-схему (у REST бывают свои поля) — тогда тип задаётся `t` здесь.
 */
export interface RestFieldSpec {
  /** Источник; по умолчанию — тело запроса. */
  from?: RestSource;
  /** zod-тип поля, если его нет в общей схеме (REST-only поле). */
  t?: ZodType;
  /** Обязательно в REST (для полей вне общей схемы). */
  req?: boolean;
  /** Каноническое сообщение; шаблоны: {key}, {min}, {max}. */
  msg?: string;
  /** Кастомный разбор сырого значения (до zod-проверки); бросает EtnError сам. */
  parse?: (raw: unknown, requestId: string) => unknown;
  /** Дополнительная проверка после zod: вернуть текст ошибки или null. */
  check?: (value: unknown, all: Record<string, unknown>) => string | null;
}

/** Контракт входа операции: одна zod-схема + REST-карта источников. */
export interface OperationContract<S extends z.ZodObject = z.ZodObject> {
  /** Имя операции (имя MCP-инструмента или условное имя REST-операции). */
  name: string;
  /** Единая zod-схема входа (для MCP — inputSchema; для REST — типы полей). */
  schema: S;
  /** Только REST: откуда брать каждое поле HTTP-запроса. */
  rest: Partial<Record<string, RestFieldSpec>>;
}

/** Реестр контрактов по имени инструмента (для канонических ошибок MCP и
 *  для сторожа `guard-mcp-contracts-strict.test.ts`). */
export const contractsByName = new Map<string, OperationContract>();

/** Объявить контракт операции и зарегистрировать его по имени.
 *
 * Схема MCP-контракта (имя с префиксом `etn.`) автоматически делается
 * `.strict()` (задача c245e7de, после ea4581c5): неизвестный ключ
 * верхнего уровня обязан отвергаться `VALIDATION_ERROR` с `details.fields`,
 * а не молча отбрасываться. Раньше каждую точку регистрации MCP-инструмента
 * приходилось оборачивать вручную (`z.object({...}).strict()`), что легко
 * забыть — теперь гарантия идёт из контракта.
 *
 * REST-контракты (имя с префиксом `rest:`) НЕ делаются strict: они исторически
 * опираются на rest-карту как на единственный источник объявленных полей и
 * могут содержать поля вне общей схемы (например, `create_link` у мыслей или
 * `colors` у слоёв) — strict там дал бы ложные 422 на легитимные REST-вызовы.
 * Для REST строгость — отдельный заход, выходит за рамки этой задачи.
 *
 * ZodEffects (схема с `.refine()`) не имеет метода `.strict()`, поэтому для
 * неё нужно заранее ставить `.strict()` ДО `.refine()` (см. `*Fields` ниже —
 * все они так и устроены). Идемпотентность `.strict()` для повторных
 * применений — поведение zod 4. */
export function defineContract<S extends z.ZodObject>(
  name: string,
  schema: S,
  rest: OperationContract<S>['rest'],
): OperationContract<S> {
  const isMcp = name.startsWith('etn.');
  const strictSchema =
    isMcp && schema instanceof z.ZodObject
      ? (schema.strict() as unknown as S)
      : schema;
  const contract: OperationContract<S> = { name, schema: strictSchema, rest };
  contractsByName.set(name, contract);
  return contract;
}

/** Контракт MCP-инструмента по имени (или undefined). */
export function contractFor(name: string): OperationContract | undefined {
  return contractsByName.get(name);
}

// ---------------------------------------------------------------------------
// Канонические сообщения
// ---------------------------------------------------------------------------

/** Подстановка шаблонов `{key}`, `{min}`, `{max}`. */
export function template(text: string, vars: Record<string, string | number | bigint>): string {
  return text.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m,
  );
}

/** Минимальный срез zod-issue (zod v4 `$ZodIssue` — размеченное объединение). */
export interface ZodIssueLike {
  code: string;
  path?: Array<string | number | symbol>;
  origin?: string;
  expected?: unknown;
  received?: unknown;
  type?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  values?: unknown[];
  keys?: unknown[];
  errors?: Array<Array<ZodIssueLike>>;
  message: string;
}

/** Первый «полезный» issue zod-ошибки (для union — первый issue первой ветви). */
function firstIssue(error: z.ZodError): ZodIssueLike {
  let issue = error.issues[0] as unknown as ZodIssueLike | undefined;
  while (issue !== undefined && issue.code === 'invalid_union') {
    issue = (issue.errors?.[0]?.[0] as ZodIssueLike | undefined) ?? issue;
  }
  return issue ?? (error.issues[0] as unknown as ZodIssueLike);
}

/**
 * Отсутствует ли значение по пути issue во входе. zod 4 больше не кладёт в
 * issue признак `received` (в zod 3 отсутствие поля давало
 * `received === 'undefined'`), поэтому «обязательное поле не передано»
 * отличаем от «передан неверный тип» по сырому входу: `undefined` на любом
 * шаге пути означает, что поля нет. `input === undefined` (вызывающий не
 * передал вход) — не считаем отсутствием, поведение прежнее.
 */
function isAbsentIn(input: unknown, path: unknown): boolean {
  if (input === undefined) return false;
  const parts = Array.isArray(path)
    ? path.filter((p): p is string | number => typeof p === 'string' || typeof p === 'number')
    : [];
  if (parts.length === 0) return false;
  let cur: unknown = input;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return true;
    if (Array.isArray(cur)) {
      if (typeof part !== 'number' || part < 0 || part >= cur.length) return true;
      cur = cur[part];
    } else {
      const obj = cur as Record<string, unknown>;
      if (obj[String(part)] === undefined) return true;
      cur = obj[String(part)];
    }
  }
  return false;
}

/** Поле, к которому относится issue: путь ошибки (для вложенных — `a.b.0`),
 *  для пустого пути (union/enum) — ключ карты rest. */
function issueKey(fallback: string, issue: ZodIssueLike): string {
  const parts = issue.path?.filter(
    (p): p is string | number => typeof p === 'string' || typeof p === 'number',
  );
  if (parts !== undefined && parts.length > 0) {
    return parts.map(String).join('.');
  }
  return fallback;
}

/**
 * Ключ поля для пошаговой валидации REST-парсера. Путь zod-ошибки относителен
 * значения поля, поэтому при вложенной ошибке к нему добавляется имя верхнего
 * REST-ключа (`items` + `0.node_key` → `items.0.node_key`) — тот же полный
 * путь, что zod даёт MCP при разборе всего входа. Для скалярного поля путь
 * пуст, и ключ остаётся верхним.
 */
function restFieldIssueKey(key: string, issue: ZodIssueLike): string {
  const parts = issue.path?.filter(
    (p): p is string | number => typeof p === 'string' || typeof p === 'number',
  );
  return parts !== undefined && parts.length > 0 ? `${key}.${parts.map(String).join('.')}` : key;
}

/** Детали ошибки REST: `{ field }`, для enum — с `allowed`, для
 *  unrecognized_keys — `fields` + `allowed` (допустимые ключи). */
function issueDetails(key: string, issue: ZodIssueLike, allowedKeys?: string[]): Record<string, unknown> {
  const details: Record<string, unknown> = { field: key };
  if (issue.code === 'invalid_value' && issue.values !== undefined) {
    details.allowed = issue.values;
  }
  if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
    details.fields = issue.keys;
    if (allowedKeys !== undefined) details.allowed = allowedKeys;
    delete details.field;
  }
  return details;
}

/**
 * Каноническое сообщение ошибки поля. Совпадает у обоих фасадов; по умолчанию
 * — русский wire-стиль REST-слоя, переопределяется `spec.msg` (шаблон
 * подставляется с ключом объявленного поля `specKey`, путь ошибки — для
 * значений по умолчанию и деталей). `input` — исходное значение/объект,
 * проверенный zod-схемой: по нему отличаем «обязательное поле отсутствует»
 * («{key} обязателен.», как в REST) от «передан неверный тип».
 */
export function messageForIssue(
  specKey: string,
  pathKey: string,
  spec: RestFieldSpec | undefined,
  field: ZodType | undefined,
  issue: ZodIssueLike,
  input?: unknown,
): string {
  const vars: Record<string, string | number | bigint> = { key: pathKey };
  // Ключ подстановки в сообщение обязан совпадать у REST и MCP. Путь zod-ошибки
  // REST относителен значению поля, поэтому непустой путь (даже длиной 1, как у
  // record-поля: `tables` + `t1`) — это вложенная ошибка, и берём полный путь
  // `pathKey` (`tables.t1`), как его видит MCP при разборе всего входа; только
  // пустой путь (ошибка на самом поле) остаётся верхним REST-ключом `specKey`.
  const keyVars: Record<string, string | number | bigint> =
    Array.isArray(issue.path) && issue.path.length > 0 ? vars : { key: specKey };
  if (issue.code === 'custom') {
    return issue.message;
  }
  if (issue.code === 'invalid_type') {
    if (isAbsentIn(input, issue.path)) {
      return template(spec?.msg ?? '{key} обязателен.', keyVars);
    }
    const nulls = field !== undefined && field.safeParse(null).success;
    const suffix = nulls ? ' или null' : '';
    switch (issue.expected) {
      case 'string':
        return template(spec?.msg ?? `{key} должен быть строкой${suffix}.`, keyVars);
      case 'int':
      case 'number':
        return template(spec?.msg ?? `{key} должен быть целым числом${suffix}.`, keyVars);
      case 'boolean':
        return template(spec?.msg ?? `{key} должен быть логическим значением${suffix}.`, keyVars);
      case 'array':
        return template(spec?.msg ?? '{key} должен быть массивом строк.', keyVars);
      case 'object':
        return template(spec?.msg ?? '{key} должен быть объектом.', keyVars);
      default:
        return template(spec?.msg ?? 'Недопустимый {key}.', keyVars);
    }
  }
  if (issue.code === 'too_small') {
    if (issue.origin === 'string') {
      return template(spec?.msg ?? '{key} обязателен.', keyVars);
    }
    if (issue.origin === 'array') {
      return template(spec?.msg ?? '{key} должен быть непустым массивом.', keyVars);
    }
    return template(
      spec?.msg ?? '{key} должен быть целым числом не меньше {min}.',
      { ...vars, min: issue.minimum ?? 0 },
    );
  }
  if (issue.code === 'too_big') {
    if (issue.origin === 'array') {
      return template(
        spec?.msg ?? '{key} должен содержать не более {max} элементов.',
        { ...vars, max: issue.maximum ?? 0 },
      );
    }
    return template(
      spec?.msg ?? '{key} должен быть целым числом не больше {max}.',
      { ...vars, max: issue.maximum ?? 0 },
    );
  }
  if (issue.code === 'invalid_value') {
    return template(spec?.msg ?? 'Недопустимый {key}.', keyVars);
  }
  if (issue.code === 'unrecognized_keys') {
    const keys = Array.isArray(issue.keys) ? issue.keys.map(String).join(', ') : '';
    return template(spec?.msg ?? 'Неизвестные поля: {keys}.', { ...keyVars, keys });
  }
  return template(spec?.msg ?? 'Недопустимый {key}.', keyVars);
}

/** `EtnError` канонической ошибки поля с деталями и requestId. */
function fieldError(
  requestId: string,
  key: string,
  message: string,
  details: Record<string, unknown>,
): EtnError {
  return new EtnError('VALIDATION_ERROR', message, details, requestId);
}

// ---------------------------------------------------------------------------
// REST-парсер
// ---------------------------------------------------------------------------

/** Проверка, что тело запроса — JSON-объект (BAD_REQUEST, как раньше). */
function bodyObject(body: unknown, requestId: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new EtnError('BAD_REQUEST', 'Тело запроса должно быть JSON-объектом.', undefined, requestId);
  }
  return body as Record<string, unknown>;
}

/**
 * Разобрать REST-запрос по контракту: достаёт каждое поле из объявленного
 * источника, коэрсит, валидирует zod-типом из общей схемы (или `t` из карты)
 * и бросает каноническую `VALIDATION_ERROR`. Возвращает проверенный плоский
 * вход с именами полей схемы.
 */
export function parseRest<S extends z.ZodObject>(
  contract: OperationContract<S>,
  req: FastifyRequest,
): z.infer<S> & Record<string, unknown> {
  const requestId = req.id;
  const out: Record<string, unknown> = {};
  let body: Record<string, unknown> | undefined;

  for (const [key, spec] of Object.entries(contract.rest) as [string, RestFieldSpec][]) {
    const from = spec.from ?? { kind: 'body' };
    let raw: unknown;
    if (from.kind === 'body') {
      if (body === undefined) body = bodyObject(req.body ?? {}, requestId);
      raw = body[from.name ?? key];
    } else if (from.kind === 'param') {
      raw = (req.params as Record<string, unknown>)[from.name ?? key];
    } else if (from.kind === 'query') {
      raw = (req.query as Record<string, unknown>)[from.name ?? key];
    } else {
      raw = req.headers[(from.name ?? key).toLowerCase()];
    }

    const shape = contract.schema.shape as Record<string, ZodType>;
    const field: ZodType | undefined = shape[key] ?? spec.t;
    // Обязательность: явный `req` или поле ОБЩЕЙ схемы без optional().
    // Поля, заданные только в REST-карте (`t`), по умолчанию необязательны.
    const schemaRequired =
      field !== undefined && shape[key] !== undefined && !field.isOptional();

    if (raw === undefined) {
      if (from.kind === 'query' && from.repeatable === true) {
        out[key] = [];
        continue;
      }
      const required = spec.req ?? schemaRequired;
      if (required) {
        throw fieldError(
          requestId,
          key,
          template(spec.msg ?? '{key} обязателен.', { key }),
          { field: from.kind === 'header' ? (from.name ?? key) : key },
        );
      }
      continue;
    }

    let value: unknown = raw;
    if (spec.parse !== undefined) {
      value = spec.parse(raw, requestId);
    } else if (from.kind === 'query') {
      const first = Array.isArray(raw) ? raw[0] : raw;
      if (from.coerce === 'int') {
        const parsed = typeof first === 'string' && first !== '' ? Number.parseInt(first, 10) : Number.NaN;
        const min = from.min ?? 0;
        if (!Number.isFinite(parsed) || parsed < min) {
          throw fieldError(
            requestId,
            key,
            template(spec.msg ?? '{key} должен быть целым числом не меньше {min}.', { key, min }),
            { field: key },
          );
        }
        value = parsed;
      } else if (from.coerce === 'bool') {
        if (first === 'true' || first === '1') value = true;
        else if (first === 'false' || first === '0') value = false;
        else {
          throw fieldError(
            requestId,
            key,
            template(spec.msg ?? 'Параметр {key} должен быть логическим значением (true/false).', { key }),
            { field: key },
          );
        }
      } else if (from.repeatable === true) {
        value =
          typeof raw === 'string'
            ? raw.length > 0
              ? [raw]
              : []
            : Array.isArray(raw)
              ? raw.filter((item): item is string => typeof item === 'string' && item.length > 0)
              : [];
      }
    } else if (from.kind === 'header' && from.int === true) {
      const first = Array.isArray(raw) ? raw[0] : raw;
      const trimmed = typeof first === 'string' ? first.trim() : '';
      if (!/^\d+$/.test(trimmed)) {
        throw fieldError(
          requestId,
          key,
          template(spec.msg ?? 'Заголовок If-Match должен содержать целую версию.', { key }),
          { field: from.name ?? key },
        );
      }
      value = Number.parseInt(trimmed, 10);
    }

    if (field !== undefined) {
      const res = field.safeParse(value);
      if (!res.success) {
        const issue = firstIssue(res.error);
        const fieldKey = restFieldIssueKey(key, issue);
        // Путь zod-ошибки REST относителен значению поля: при вложенной ошибке
        // (`fieldKey !== key`) заблуждение не о самом поле, а о его элементе —
        // сообщение и тип строятся по полному пути и объявленной спецификации
        // ЭТОГО пути, а не верхнего ключа (`contract.rest` объявляет только
        // верхние ключи, так что для вложенного пути spec/field не находятся —
        // ровно как у MCP). Иначе (ошибка на самом поле) — его spec и тип.
        const nested = fieldKey !== key;
        const issueSpec = nested ? contract.rest[fieldKey] : spec;
        const issueField = nested ? undefined : field;
        throw fieldError(requestId, fieldKey, messageForIssue(key, fieldKey, issueSpec, issueField, issue, value), issueDetails(fieldKey, issue));
      }
      value = res.data;
    }

    if (spec.check !== undefined) {
      const message = spec.check(value, out);
      if (message !== null) {
        throw fieldError(requestId, key, template(message, { key }), { field: key });
      }
    }
    out[key] = value;
  }

  // Кросс-полевые refine общей схемы (XOR type_id/type и т.п.) — применяются
  // и к REST: то же сообщение, что в MCP. MCP-контракты теперь `.strict()`
  // (задача c245e7de), но REST-карта может объявлять поля вне общей схемы
  // (`colors` у слоёв, `create_link` у мыслей, `ordered_ids` у pins). Чтобы
  // strict не ругался на легитимные REST-only поля и одновременно отвергал
  // лишние ключи в body (тест 0.4.3 «REST thoughts/query rejects unknown body
  // keys with 422»), парсим схемой объединение body+out, но исключаем из
  // него поля, объявленные ТОЛЬКО в rest-карте: они легитимны для REST,
  // уже провалидированы поштучно в цикле выше и попадут в `out`.
  const restOnlyFields = new Set<string>(
    Object.keys(contract.rest).filter((k) => !(k in contract.schema.shape)),
  );
  const rawMerged = body === undefined ? out : { ...body, ...out };
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawMerged)) {
    if (restOnlyFields.has(k)) continue;
    merged[k] = v;
  }
  const res = contract.schema.safeParse(merged);
  if (!res.success) {
    const issue = firstIssue(res.error);
    if (issue.code === 'custom') {
      throw new EtnError('VALIDATION_ERROR', issue.message, undefined, requestId);
    }
    const fieldKey = issueKey('', issue);
    const spec = contract.rest[fieldKey];
    const allowedKeys = [
      ...Object.keys(contract.schema.shape),
      ...Object.keys(contract.rest),
    ].filter((k, i, arr) => arr.indexOf(k) === i);
    throw fieldError(requestId, fieldKey, messageForIssue(fieldKey, fieldKey, spec, undefined, issue, merged), issueDetails(fieldKey, issue, allowedKeys));
  }
  // Возвращается `out`, а не `res.data`: схема отбрасывает неизвестные поля,
  // а в REST-карте бывают поля вне схемы (например, `colors` у слоёв).
  return out as z.infer<S> & Record<string, unknown>;
}

/**
 * Каноническая ошибка валидации для MCP: та же схема, то же сообщение, что
 * дал бы REST на том же входе. Используется перехватчиком `tools/call`
 * (mcp/server.ts) — SDK-текст ошибки схемы заменяется единым.
 */
export function mcpValidationError(contract: OperationContract, args: unknown): EtnError | null {
  const res = contract.schema.safeParse(args);
  if (res.success) {
    return null;
  }
  const issue = firstIssue(res.error);
  if (issue.code === 'custom') {
    return new EtnError('VALIDATION_ERROR', issue.message);
  }
  const fieldKey = issueKey('', issue);
  const spec = contract.rest[fieldKey];
  const shape = contract.schema.shape as Record<string, ZodType>;
  return new EtnError(
    'VALIDATION_ERROR',
    messageForIssue(fieldKey, fieldKey, spec, shape[fieldKey], issue, args),
    issueDetails(fieldKey, issue),
  );
}

// ===========================================================================
// Область: слои (13-layers.md §2–10; REST — routes/layers.ts, MCP — tools/layers.ts)
// ===========================================================================

/** REST `GET /networks/:networkId/layers` = MCP `etn.layers.list`. */
export const LayersList = defineContract(
  'etn.layers.list',
  z.object({
    network_id: NetworkId,
    include_service: z.boolean().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    include_service: { from: { kind: 'query', coerce: 'bool' } },
  },
);

/** Общие поля чтения диффа (REST `/layers/:layerId/diff[/doc]` = MCP `etn.layers.diff[_doc]`). */
const LayersDiffFields = z.object({
  network_id: NetworkId,
  layer_id: LayerId,
});
/**
 * Структурный дифф слоя (задача ddb67ddc): к общим полям добавлены выбор
 * секций и keyset-пагинация. В MCP вызов без параметров отдаёт первую страницу
 * (дефолтный лимит) + counts по всем секциям. В REST отсутствие ВСЕХ трёх
 * полей сохраняет прежний полный отчёт — текущий клиент не ломается.
 */
export const LayersDiff = defineContract(
  'etn.layers.diff',
  LayersDiffFields.extend({
    sections: z.array(z.enum(LAYER_DIFF_SECTIONS)).optional(),
    limit: z.number().int().min(1).max(LAYER_DIFF_MAX_LIMIT).optional(),
    cursor: z.string().min(1).optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    layer_id: { from: { kind: 'param', name: 'layerId' } },
    // `repeatable` — `?sections=links.removed&sections=links.added`; без
    // параметра парсер кладёт `[]` («все секции»).
    sections: { from: { kind: 'query', repeatable: true } },
    limit: { from: { kind: 'query', coerce: 'int', min: 1 } },
    cursor: {
      from: { kind: 'query' },
      parse: (raw) => (typeof raw === 'string' && raw !== '' ? raw : undefined),
    },
  },
);
export const LayersDiffDoc = defineContract(
  'etn.layers.diff_doc',
  LayersDiffFields,
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    layer_id: { from: { kind: 'param', name: 'layerId' } },
  },
);

/**
 * По-мысленный текстовый дифф слоя против родителя (задача 52c776f1):
 * `GET /networks/:networkId/layers/:layerId/diff/thought/:thoughtId`.
 * Сервер читает одну мысль в обоих контекстах и отдаёт пары «основа/слой»
 * в готовом для построчного диффа виде (REST-only; MCP-паритет не нужен —
 * сценарий обслуживает GUI-диалог).
 */
export const LayersDiffThought = defineContract(
  'etn.layers.diff_thought',
  LayersDiffFields.extend({ thought_id: ThoughtId }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    layer_id: { from: { kind: 'param', name: 'layerId' } },
    thought_id: { from: { kind: 'param', name: 'thoughtId' } },
  },
);

/** REST `POST /networks/:networkId/layers` = MCP `etn.layers.create`. */
export const LayersCreate = defineContract(
  'etn.layers.create',
  z.object({
    network_id: NetworkId,
    title: z.string().min(1),
    parent_id: LayerId.optional(),
    comment: z.string().nullable().optional(),
    git_branch: z.string().nullable().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    title: { from: { kind: 'body' }, msg: 'title обязателен.' },
    parent_id: { from: { kind: 'body' } },
    comment: { from: { kind: 'body' } },
    git_branch: { from: { kind: 'body' } },
    // REST-only: цвета нового слоя (0.6.4, §2.2a) — проверяет домен.
    colors: { from: { kind: 'body' }, parse: (raw) => validateLayerColors(raw ?? null) },
  },
);

/** REST `PATCH /networks/:networkId/layers/:layerId` = MCP `etn.layers.update`. */
export const LayersUpdate = defineContract(
  'etn.layers.update',
  z.object({
    network_id: NetworkId,
    layer_id: LayerId,
    title: z.string().min(1).optional(),
    comment: z.string().nullable().optional(),
    expected_version: ExpectedVersion,
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    layer_id: { from: { kind: 'param', name: 'layerId' } },
    title: { from: { kind: 'body' } },
    comment: { from: { kind: 'body' } },
    expected_version: {
      from: { kind: 'header', name: 'If-Match', int: true },
      msg: 'Заголовок If-Match должен содержать целую версию.',
    },
    // REST-only: полная замена набора цветов (null → дефолт темы).
    colors: { from: { kind: 'body' }, parse: (raw) => validateLayerColors(raw) },
  },
);

/** REST `DELETE /networks/:networkId/layers/:layerId` = MCP `etn.layers.delete`. */
export const LayersDelete = defineContract(
  'etn.layers.delete',
  z.object({
    network_id: NetworkId,
    layer_id: LayerId,
    cascade: z.number().int().min(0).optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    layer_id: { from: { kind: 'param', name: 'layerId' } },
    cascade: { from: { kind: 'query', coerce: 'int', min: 0 } },
  },
);

/** REST `POST /networks/:networkId/layers/:layerId/select` = MCP `etn.layers.select`. */
export const LayersSelect = defineContract(
  'etn.layers.select',
  z.object({
    network_id: NetworkId,
    layer_id: LayerId,
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    layer_id: { from: { kind: 'param', name: 'layerId' } },
  },
);

/** REST `POST /networks/:networkId/layers/:layerId/merge` = MCP `etn.layers.merge`. */
export const LayersMerge = defineContract(
  'etn.layers.merge',
  z
    .object({
      network_id: NetworkId,
      layer_id: LayerId,
      tables: z.record(z.string(), z.array(z.string().min(1))).optional(),
      // Задача f5c363a3: слияние ОДНОЙ мысли — сервер сам собирает замкнутое
      // подмножество её строк; `mode` выбирает, что делать с конфликтом.
      thought_id: ThoughtId.optional(),
      mode: z.enum(LAYER_THOUGHT_MERGE_MODES).optional(),
    })
    .refine((v) => v.mode === undefined || v.thought_id !== undefined, {
      message: 'режим слияния (mode) задаётся только вместе с thought_id.',
      path: ['mode'],
    })
    .refine((v) => v.thought_id === undefined || v.tables === undefined, {
      message: 'thought_id и tables взаимоисключающи: либо мысль, либо набор строк.',
      path: ['thought_id'],
    }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    layer_id: { from: { kind: 'param', name: 'layerId' } },
    tables: { from: { kind: 'body' }, msg: 'tables должен быть объектом { таблица: [id, …] }.' },
    thought_id: { from: { kind: 'body' } },
    mode: { from: { kind: 'body' } },
  },
);

/**
 * REST `POST /networks/:networkId/layers/:layerId/discard` = MCP
 * `etn.layers.discard` (задача f5c363a3, вариант «Отказаться от изменений»).
 *
 * Физически удаляет из слоя ВСЕ строки одной мысли (мысль, синонимы, значения
 * свойств, комментарии с целями, вложения и её рёбра). Основа не затрагивается;
 * мысль возвращается к состоянию основы, созданная только в слое — исчезает.
 * Деструктивно, поэтому в GUI требует подтверждения.
 */
export const LayersDiscard = defineContract(
  'etn.layers.discard',
  z.object({
    network_id: NetworkId,
    layer_id: LayerId,
    thought_id: ThoughtId,
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    layer_id: { from: { kind: 'param', name: 'layerId' } },
    thought_id: { from: { kind: 'body' } },
  },
);

/**
 * MCP `etn.layers.conflicts` (задача 7cc34cf4, 13-layers.md §8.5).
 *
 * Read-only предпросмотр будущего отказа слияния: строки слоя, чей
 * `base_version` отстал от текущей версии той же строки в предке. Пробное
 * слияние для этой проверки не годится — слой без конфликтов слился бы рано.
 * MCP-only: REST-маршрута нет.
 */
export const LayersConflicts = defineContract(
  'etn.layers.conflicts',
  z.object({
    network_id: NetworkId,
    layer_id: LayerId,
  }),
  {},
);

/**
 * MCP `etn.layers.reset_override` (задача 7cc34cf4, 13-layers.md §8.5).
 *
 * Сброс перекрытия выбранных строк слоя: `base_version` теневой строки
 * переставляется на текущую версию строки в предке; содержимое слоя
 * сохраняется, основа не меняется. Деструктивно по смыслу (теряется сигнал
 * «основа менялась»), поэтому требует `confirm: true` на верхнем уровне
 * `etn.ops`. Адресует конкретные строки, не слой целиком. MCP-only.
 */
export const LayersResetOverride = defineContract(
  'etn.layers.reset_override',
  z.object({
    network_id: NetworkId,
    layer_id: LayerId,
    tables: z.record(z.string(), z.array(z.string().min(1)).min(1)),
  }),
  {
    tables: { from: { kind: 'body' }, msg: 'tables должен быть объектом { таблица: [id, …] }.' },
  },
);

// ===========================================================================
// Область: мысли — чтение (tools/thoughts-read.ts; REST-аналоги ниже по файлу)
// ===========================================================================

const SearchFields = z
  .object({
    // Сеть обязательна, но в форме XOR: либо одна (`network_id`), либо веер
    // (`network_ids`). JSON Schema не умеет «хотя бы одно из двух required» —
    // обязательность выражена описанием каждого поля (ошибка 99f27451:
    // раньше она была видна только в рантайме).
    network_id: NetworkId.optional().describe(
      'Single network. Provide either `network_id` or `network_ids` — one is required.',
    ),
    network_ids: z.array(NetworkId).optional().describe(
      'Fan-out over networks. Provide either `network_ids` or `network_id` — one is required.',
    ),
    query: z.string().min(1),
    scope: z.enum(SEARCH_SCOPES).optional(),
    in_subtree_of: ThoughtId.optional(),
    type_id: ThoughtId.nullable().optional(),
    type: z.string().min(1).optional(),
    author_id: z.string().optional(),
    editor_id: z.string().optional(),
    show_inactive: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  // `.strict()` (ошибка c245e7de, после ea4581c5): неизвестный ключ верхнего
  // уровня → VALIDATION_ERROR. До `.refine()` — порядок обязателен в zod 4.
  .strict()
  .refine((v) => v.type_id === undefined || v.type === undefined, { message: TYPE_ID_TYPE_CONFLICT })
  // Задача eb1a3f43, требование c98d5d19: веерный режим — `network_ids`
  // рядом с `network_id`, но XOR: либо одна сеть, либо список. Парсер
  // repeatable создаёт `network_ids: []` при отсутствии параметра в query —
  // пустой массив трактуется как «не указан».
  .refine(
    (v) => v.network_id === undefined || (v.network_ids?.length ?? 0) === 0,
    {
      message: 'Укажите либо network_id, либо network_ids, но не оба одновременно.',
    },
  )
  .refine(
    (v) => v.network_id !== undefined || (v.network_ids?.length ?? 0) > 0,
    {
      message: 'Нужно указать network_id или network_ids.',
    },
  );
export const ThoughtsSearch = defineContract('etn.thoughts.search', SearchFields, {});

const QueryPropertyFields = z
  .object({
    property_id: z.string().min(1).optional(),
    property: z.string().min(1).optional(),
    operator: z.enum([
      'eq',
      'ne',
      'contains',
      'gt',
      'gte',
      'lt',
      'lte',
      'any_of',
      'all_of',
      'none_of',
    ]),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string().min(1)).min(1)]),
  })
  .refine((v) => v.property_id === undefined || v.property === undefined, {
    message: PROPERTY_ID_PROPERTY_CONFLICT,
  })
  // Условие обязано адресовать свойство: `property_id` или имя `property`
  // (ошибки 090d0242/4f17cb73, 0.12.1). Неизвестное поле условия (напр. `key`)
  // zod по умолчанию ВЫРЕЗАЕТ — без этой проверки условие теряло адрес и
  // молча выпадало из отбора, расширяя его до всей сети. Теперь такой ввод —
  // `VALIDATION_ERROR` (`.strict()` не ставим: он раздувает `inputSchema`
  // сторожевого бюджета `tools/list`, а проверка адреса ловит тот же дефект).
  .refine((v) => v.property_id !== undefined || v.property !== undefined, {
    message: 'Укажите property_id или property в условии свойства.',
  });
const QueryFields = z
  .object({
    // XOR сети — как в `SearchFields`: обязательность несёт описание полей
    // (JSON Schema не выражает «хотя бы одно из двух required», ошибка 99f27451).
    network_id: NetworkId.optional().describe(
      'Single network. Provide either `network_id` or `network_ids` — one is required.',
    ),
    network_ids: z.array(NetworkId).optional().describe(
      'Fan-out over networks. Provide either `network_ids` or `network_id` — one is required.',
    ),
    in_subtree_of: ThoughtId.optional(),
    max_depth: z.number().int().min(1).max(TRAVERSAL_DEFAULTS.MAX_DEPTH).optional(),
    type_id: z.array(z.string().min(1)).optional(),
    type: z.array(z.string().min(1)).optional(),
    active: z.enum(['true', 'false', 'any']).optional(),
    trashed: z.enum(['true', 'false', 'any']).optional(),
    keywords: z.string().min(1).optional(),
    properties: z.array(QueryPropertyFields).optional(),
    created_after: z.string().min(1).optional(),
    created_before: z.string().min(1).optional(),
    updated_after: z.string().min(1).optional(),
    updated_before: z.string().min(1).optional(),
    author_id: z.string().optional(),
    editor_id: z.string().optional(),
    link_filter: LinkFilter,
    sort: z.enum(['title', 'created_at', 'updated_at']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    // Требование 5adebf61: COUNT только по явному флагу (по умолчанию total=null).
    count: z.boolean().optional(),
    // Требование 3f2fdc41: keyset-курсор продолжения страницы.
    cursor: z.string().min(1).optional(),
  })
  // `.strict()` (ошибка c245e7de, после ea4581c5): до `.refine()`.
  .strict()
  .refine((v) => v.type_id === undefined || v.type === undefined, { message: TYPE_ID_TYPE_CONFLICT })
  // Задача eb1a3f43, требование c98d5d19: XOR для network_id/network_ids.
  // Парсер repeatable создаёт `network_ids: []` при отсутствии параметра в
  // query — пустой массив трактуется как «не указан».
  .refine(
    (v) => v.network_id === undefined || (v.network_ids?.length ?? 0) === 0,
    {
      message: 'Укажите либо network_id, либо network_ids, но не оба одновременно.',
    },
  )
  .refine(
    (v) => v.network_id !== undefined || (v.network_ids?.length ?? 0) > 0,
    {
      message: 'Нужно указать network_id или network_ids.',
    },
  );
export const ThoughtsQuery = defineContract('etn.thoughts.query', QueryFields, {});

export const ThoughtsGet = defineContract(
  'etn.thoughts.get',
  z.object({ network_id: NetworkId, thought_id: ThoughtId, view: View }),
  {},
);

export const ThoughtsResolve = defineContract(
  'etn.thoughts.resolve',
  z.object({
    network_id: NetworkId,
    thought_ids: z.array(ThoughtId).min(1).max(MCP_MAX_THOUGHTS_PER_WRITE),
    view: View,
  }),
  {},
);

const NeighborsFields = z.object({
  network_id: NetworkId,
  thought_id: ThoughtId,
  dir: z.enum(FOCUS_DIRS),
  depth: z.number().int().min(1).max(TRAVERSAL_DEFAULTS.MAX_DEPTH).optional(),
  link_filter: LinkFilter,
  show_inactive: z.boolean().optional(),
  view: View,
});
export const ThoughtsNeighbors = defineContract('etn.thoughts.neighbors', NeighborsFields, {});

export const ThoughtsSubgraph = defineContract(
  'etn.thoughts.subgraph',
  z.object({
    network_id: NetworkId,
    seed_ids: z.array(ThoughtId).min(1).max(50),
    radius: z.number().int().min(0).max(TRAVERSAL_DEFAULTS.MAX_DEPTH),
    max_nodes: z.number().int().min(1).optional(),
    max_chars: z.number().int().min(1).optional(),
    include_comments: z.boolean().optional(),
    link_filter: LinkFilter,
    view: View,
  }),
  {},
);

export const ThoughtsPath = defineContract(
  'etn.thoughts.path',
  z.object({
    network_id: NetworkId,
    from_id: ThoughtId,
    to_id: ThoughtId,
    max_depth: z.number().int().min(1).max(100).optional(),
    link_filter: LinkFilter,
  }),
  {},
);

export const ThoughtsMentions = defineContract(
  'etn.thoughts.mentions',
  z.object({ network_id: NetworkId, thought_id: ThoughtId }),
  {},
);

export const ThoughtsBacklinks = defineContract(
  'etn.thoughts.backlinks',
  z.object({ network_id: NetworkId, thought_id: ThoughtId }),
  {},
);

export const ThoughtsUsage = defineContract(
  'etn.thoughts.usage',
  z.object({ network_id: NetworkId, thought_id: ThoughtId, view: View }),
  {},
);

export const ThoughtsDeletionCheck = defineContract(
  'etn.thoughts.deletion_check',
  z.object({ network_id: NetworkId, thought_ids: z.array(ThoughtId).min(1).max(200) }),
  {},
);

export const ThoughtsFindDuplicates = defineContract(
  'etn.thoughts.find_duplicates',
  z
    .object({
      // XOR сети — как в `SearchFields`/`QueryFields`: обязательность несёт
      // описание полей (ошибка 99f27451).
      network_id: NetworkId.optional().describe(
        'Single network. Provide either `network_id` or `network_ids` — one is required.',
      ),
      network_ids: z.array(NetworkId).optional().describe(
        'Fan-out over networks. Provide either `network_ids` or `network_id` — one is required.',
      ),
      title: z.string().min(1),
      synonyms: z.array(z.string().min(1)).optional(),
    })
    .strict()
    // Задача eb1a3f43, требование c98d5d19: XOR для network_id/network_ids.
    // Парсер repeatable создаёт `network_ids: []` при отсутствии параметра в
    // query — пустой массив трактуется как «не указан».
    .refine(
      (v) => v.network_id === undefined || (v.network_ids?.length ?? 0) === 0,
      {
        message: 'Укажите либо network_id, либо network_ids, но не оба одновременно.',
      },
    )
    .refine(
      (v) => v.network_id !== undefined || (v.network_ids?.length ?? 0) > 0,
      {
        message: 'Нужно указать network_id или network_ids.',
      },
    ),
  {},
);

// ===========================================================================
// Область: мысли — запись (tools/thoughts-write.ts)
// ===========================================================================

const BULK_UPDATE_OPS = [
  'set_type',
  'clear_type',
  'set_active',
  'set_inactive',
  'trash',
  'link_parents',
  'link_children',
  'set_only_parents',
  'unlink_parents',
  'unlink_children',
] as const;

const BulkUpdateArgs = z
  .object({
    type: z.string().min(1).optional(),
    type_id: z.string().min(1).nullable().optional(),
    parent_ids: z.array(ThoughtId).min(1).optional(),
    child_ids: z.array(ThoughtId).min(1).optional(),
    link_type: z.string().min(1).optional(),
    link_type_id: z.string().min(1).nullable().optional(),
  })
  // `.strict()` (ошибка ea4581c5): ключ, положенный не в тот уровень
  // (`parent_ids` в корне вызова вместо `args`), отвергается, а не молча теряется.
  .strict()
  .refine((v) => v.type === undefined || v.type_id === undefined, { message: TYPE_ID_TYPE_CONFLICT })
  .refine((v) => v.link_type === undefined || v.link_type_id === undefined, {
    message: 'provide at most one of link_type_id or link_type',
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'args must not be empty when provided' })
  .optional();
export const BULK_UPDATE_OP_VALUES = BULK_UPDATE_OPS;
export const ThoughtsBulkUpdate = defineContract(
  'etn.thoughts.bulk_update',
  z
    .object({
      network_id: NetworkId,
      ids: z.array(ThoughtId).min(1),
      op: z.enum(BULK_UPDATE_OPS),
      args: BulkUpdateArgs,
    })
    .strict(),
  {},
);

export const ThoughtsDelete = defineContract(
  'etn.thoughts.delete',
  z.object({ network_id: NetworkId, thought_id: ThoughtId, expected_version: ExpectedVersion }),
  {},
);

export const ThoughtsTrash = defineContract(
  'etn.thoughts.trash',
  z.object({ network_id: NetworkId, thought_id: ThoughtId, trashed: z.boolean() }),
  {},
);

export const LinksRestore = defineContract(
  'etn.links.restore',
  z.object({ network_id: NetworkId, link_id: LinkId }),
  {},
);

// ===========================================================================
// Область: свойства (tools/properties.ts)
// ================================================================
export const PropertyValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string().min(1)),
  z.null(),
]);

export const PropertiesAdd = defineContract(
  'etn.properties.add',
  z.object({
    network_id: NetworkId,
    owner_type: z.enum(PROPERTY_OWNER_TYPES),
    owner_id: z.string().min(1),
    key: z.string().min(1),
    value: z.string().min(1),
    comment: z.string().min(1).optional(),
  }),
  {},
);

export const PropertiesRemove = defineContract(
  'etn.properties.remove',
  z.object({
    network_id: NetworkId,
    owner_type: z.enum(PROPERTY_OWNER_TYPES),
    owner_id: z.string().min(1),
    key: z.string().min(1),
    value: z.string().min(1),
  }),
  {},
);

/**
 * Явный резолв значений свойства вида `cross_network_ref` (задача 7849008a,
 * спека 46df7a8d). Для каждого видимого значения открывает целевую сеть и
 * обновляет снапшот имени. Возвращает массив DTO
 * {@link CrossNetworkRefValue} со статусами. Служебная операция — без
 * write-бюджета и audit-записи как содержательной правки (требование
 * c104a0fc). Применим ТОЛЬКО к свойствам вида `cross_network_ref`; иначе
 * `VALIDATION_ERROR`.
 */
export const PropertiesResolve = defineContract(
  'etn.properties.resolve',
  z.object({
    network_id: NetworkId,
    owner_type: z.enum(PROPERTY_OWNER_TYPES),
    owner_id: z.string().min(1),
    key: z.string().min(1),
  }),
  {},
);

export const ThoughtsUsageClear = defineContract(
  'etn.thoughts.usage_clear',
  z.object({ network_id: NetworkId, thought_id: ThoughtId }),
  {},
);

// ===========================================================================
// Область: комментарии (tools/comments.ts)
// ===========================================================================

const GetCommentFields = z
  .object({
    network_id: NetworkId,
    comment_id: z.string().min(1).optional(),
    thought_id: ThoughtId.optional(),
  })
  // `.strict()` (ошибка c245e7de, после ea4581c5): до `.refine()`.
  .strict()
  .refine((a) => (a.comment_id === undefined) !== (a.thought_id === undefined), {
    message: 'provide exactly one of comment_id or thought_id',
  });
export const CommentsGet = defineContract('etn.comments.get', GetCommentFields, {});

const CommentChangesFields = z
  .object({
    title: z.string().nullable().optional(),
    // Непустоту `body_md` проверяет домен по виду комментария (ошибка 00115e7b):
    // у хронологической пустое тело допустимо, пока есть заголовок/привязка.
    body_md: z.string().optional(),
    valid_from: z.string().min(1).optional(),
    valid_to: z.string().nullable().optional(),
    use_time: z.boolean().optional(),
  })
  .refine((c) => Object.keys(c).length > 0, { message: 'changes must not be empty' });
export const CommentsUpdate = defineContract(
  'etn.comments.update',
  z.object({
    network_id: NetworkId,
    comment_id: z.string().min(1),
    changes: CommentChangesFields,
    expected_version: ExpectedVersion,
  }),
  {},
);

const EditOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('append'), text: z.string().min(1) }),
  z.object({ op: z.literal('prepend'), text: z.string().min(1) }),
  z.object({ op: z.literal('replace_section'), section: z.string().min(1), text: z.string().min(1) }),
  z.object({ op: z.literal('delete_section'), section: z.string().min(1) }),
]);
const EditCommentFields = z
  .object({
    network_id: NetworkId,
    comment_id: z.string().min(1).optional(),
    thought_id: ThoughtId.optional(),
    expected_version: ExpectedVersion,
    ops: z.array(EditOpSchema).min(1),
  })
  // `.strict()` (ошибка c245e7de, после ea4581c5): до `.refine()`.
  .strict()
  .refine((a) => (a.comment_id === undefined) !== (a.thought_id === undefined), {
    message: 'provide exactly one of comment_id or thought_id',
  });
export const CommentsEdit = defineContract('etn.comments.edit', EditCommentFields, {});

export const CommentsDelete = defineContract(
  'etn.comments.delete',
  z.object({ network_id: NetworkId, comment_id: z.string().min(1), expected_version: ExpectedVersion }),
  {},
);

// ===========================================================================
// Область: вложения (tools/attachments.ts)
// ===========================================================================

export const AttachmentsAdd = defineContract(
  'etn.attachments.add',
  z.object({
    network_id: NetworkId,
    owner_type: z.enum(ATTACHMENT_OWNER_TYPES),
    owner_id: z.string().min(1),
    kind: z.enum(ATTACHMENT_KINDS),
    url: z.string().min(1).nullable().optional(),
    file_path: z.string().min(1).nullable().optional(),
    // Загрузка данных файла (задача 75c75a2f, паритет с REST
    // `POST …/attachments/file`): с `data_base64` сервер сохраняет копию под
    // каталогом вложений сети, `file_path` строки указывает на неё. Требует
    // `kind='file'`; сочетание с `url`/`file_path`/`description` отвергает
    // домен (`createAttachmentFromInput`).
    mime_type: z.string().min(1).nullable().optional(),
    data_base64: z.string().min(1).nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  }),
  {},
);

export const AttachmentsCopy = defineContract(
  'etn.attachments.copy',
  z.object({
    network_id: NetworkId,
    attachment_id: z.string().min(1),
    target_owner_type: z.enum(ATTACHMENT_OWNER_TYPES),
    target_owner_ids: z.array(z.string().min(1)).min(1),
  }),
  {},
);

export const AttachmentsSearch = defineContract(
  'etn.attachments.search',
  z.object({
    network_id: NetworkId,
    q: z.string().min(1),
    kind: z.enum(ATTACHMENT_KINDS).optional(),
    exclude_owner_type: z.enum(ATTACHMENT_OWNER_TYPES).optional(),
    exclude_owner_id: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  {},
);

export const AttachmentsUpdate = defineContract(
  'etn.attachments.update',
  z.object({
    network_id: NetworkId,
    attachment_id: z.string().min(1),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    file_path: z.string().nullable().optional(),
  }),
  {},
);

/**
 * `etn.attachments.usage` — использование вложения (0.11.1, задача 46cf4bcb;
 * паритет REST `GET /attachments/{id}/usage`). Владельцы (мысли, связи,
 * публикации), которые держат тот же физический носитель.
 */
export const AttachmentsUsage = defineContract(
  'etn.attachments.usage',
  z.object({ network_id: NetworkId, attachment_id: z.string().min(1) }),
  {},
);

export const AttachmentsDelete = defineContract(
  'etn.attachments.delete',
  z.object({ network_id: NetworkId, attachment_id: z.string().min(1) }),
  {},
);

// ===========================================================================
// Область: сети (tools/networks.ts)
// ===========================================================================

/**
 * REST `GET /networks/:networkId/statistics` — сводка по мыслесети
 * (задача c69b078d, 0.9.1). Только чтение, MCP-пары нет.
 */
export const NetworksStatistics = defineContract(
  'etn.networks.statistics',
  z.object({ network_id: NetworkId }),
  { network_id: { from: { kind: 'param', name: 'networkId' } } },
);

export const NetworksStructure = defineContract(
  'etn.networks.structure',
  z.object({
    network_id: NetworkId,
    include_examples: z.boolean().optional(),
    include_conventions: z.boolean().optional(),
  }),
  {},
);

export const NetworksWrite = defineContract(
  'etn.networks.write',
  z
    .object({
      network_id: NetworkId.optional(),
      display_name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      when_to_use: z.string().nullable().optional(),
      conventions: z.string().nullable().optional(),
      examples: z.string().nullable().optional(),
      type_roles: z.record(z.string(), z.string().nullable()).optional(),
    })
    .strict(),
  {},
);

export const NetworksDelete = defineContract(
  'etn.networks.delete',
  z.object({ network_id: NetworkId, confirm: z.literal(true) }).strict(),
  {},
);

// ===========================================================================
// Область: онтология (tools/ontology.ts)
// ===========================================================================

const OntologyWriteThoughtTypeFields = z
  .object({
    ref: z.string().min(1).optional(),
    id: z.string().min(1).nullable().optional(),
    name: z.string().min(1).optional(),
    // Пустая строка трактуется как `null` — прикрепить под корневой тип
    // (паритет с REST `PATCH /thought-types`, где `parse: '' → null`),
    // ошибка 1eb2a430.
    parent: z.string().nullable().optional(),
    parent_ref: z.string().min(1).nullable().optional(),
    description: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    icon_kind: z.enum(ICON_KINDS).optional(),
    icon_color: z.string().nullable().optional(),
    fg_color: z.string().nullable().optional(),
    bg_color: z.string().nullable().optional(),
    font_bold: z.boolean().nullable().optional(),
    font_italic: z.boolean().nullable().optional(),
    font_underline: z.boolean().nullable().optional(),
    font_strike: z.boolean().nullable().optional(),
    comment_template_md: z.string().nullable().optional(),
  })
  .strict()
  // Вид иконки `icon`: имя обязано быть в каталоге Lucide (задача 610a440e).
  .refine(libraryIconValid, { message: LIBRARY_ICON_MESSAGE, path: ['icon'] })
  // Цвет символа иконки: пусто или HEX `#rrggbb` (задача 4105bd6a).
  .refine(iconColorValid, { message: ICON_COLOR_MESSAGE, path: ['icon_color'] });
const OntologyWriteLinkTypeFields = z
  .object({
    ref: z.string().min(1).optional(),
    id: z.string().min(1).nullable().optional(),
    name_forward: z.string().min(1).optional(),
    name_reverse: z.string().min(1).optional(),
    // Пустая строка трактуется как `null` — под корневой тип связи
    // (паритет с REST `PATCH /link-types`, ошибка 1eb2a430).
    parent: z.string().nullable().optional(),
    parent_ref: z.string().min(1).nullable().optional(),
    color: z.string().nullable().optional(),
    style: z.enum(['solid', 'dashed', 'dotted']).nullable().optional(),
    width: z.number().int().min(1).max(20).nullable().optional(),
    description: z.string().nullable().optional(),
  })
  .strict();
const OntologyWritePropertyFields = z
  .object({
    ref: z.string().min(1).optional(),
    id: z.string().min(1).nullable().optional(),
    name: z.string().min(1).optional(),
    value_type: z.enum(PROPERTY_VALUE_TYPES).optional(),
    config: z.record(z.string(), z.unknown()).nullable().optional(),
    description: z.string().nullable().optional(),
    name_forward: z.string().min(1).optional(),
    name_reverse: z.string().min(1).optional(),
    parent_link_type_id: z.string().min(1).nullable().optional(),
    link_color: z.string().nullable().optional(),
    link_style: z.enum(['solid', 'dashed', 'dotted']).nullable().optional(),
    link_width: z.number().int().min(1).max(20).nullable().optional(),
  })
  .strict();
const OntologyWriteTypePropertyFields = z
  .object({
    owner: z.enum(TYPE_OWNER_TYPES),
    type: z.string().min(1).optional(),
    type_ref: z.string().min(1).optional(),
    property: z.string().min(1).optional(),
    property_ref: z.string().min(1).optional(),
    required: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
    // Дефолт привязки (0.8.2, ADR «дефолт свойства живёт на привязке»):
    // скаляр (строка/число/булево), null (сброс) либо массив id мыслей у
    // свойства-связи — нормализация по стороне привязки в домене.
    default_value: z.unknown().optional(),
    side: z.enum(['source', 'target']).nullable().optional(),
  })
  .strict();
const OntologyWriteTypeViewFields = z
  .object({
    ref: z.string().min(1).optional(),
    action: z.enum(['create', 'update', 'delete']),
    id: z.string().min(1).optional(),
    ref_for_update: z.string().min(1).optional(),
    thought_type: z.string().min(1).optional(),
    thought_type_ref: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    definition: z.string().min(1).optional(),
    position: z.number().int().min(0).optional(),
    is_default: z.boolean().optional(),
  })
  .strict();
export const OntologyWrite = defineContract(
  'etn.ontology.write',
  z
    .object({
      network_id: NetworkId,
      thought_types: z.array(OntologyWriteThoughtTypeFields).optional(),
      link_types: z.array(OntologyWriteLinkTypeFields).optional(),
      properties: z.array(OntologyWritePropertyFields).optional(),
      type_properties: z.array(OntologyWriteTypePropertyFields).optional(),
      type_views: z.array(OntologyWriteTypeViewFields).optional(),
    })
    // `.strict()` (ошибка ea4581c5): лишний ключ верхнего уровня — `VALIDATION_ERROR`
    // с полем, а не тихий успех с потерянной секцией батча.
    .strict(),
  {},
);

/**
 * `etn.ontology.delete` — удаление одной сущности онтологии (задача cc9ca65e,
 * 0.7.2). В 0.8.3 инструмент снят из постоянного набора (задача d379e091) и
 * исполняется действием `ontology.delete` через `etn.ops` с обязательным
 * ВЕРХНЕУРОВНЕВЫМ `confirm: true`; здесь `params`-схема без `confirm`.
 * Схема перенесена сюда из `tools/ontology.ts`, чтобы реестр `ops-catalog`
 * валидировал `params` той же схемой (семантика ошибок не меняется).
 */
export const OntologyDelete = defineContract(
  'etn.ontology.delete',
  z.object({
    network_id: NetworkId,
    // `type_view` (задача c1fa71d4, 0.7.3) — отбор типа мысли.
    kind: z.enum(['thought_type', 'link_type', 'property', 'type_property', 'type_view']),
    id: z.string().min(1),
    force: z.boolean().optional(),
  }),
  {},
);

// ===========================================================================
// Область: перенос и импорт (tools/transfer.ts)
// ===========================================================================

export const ThoughtsCopySubtree = defineContract(
  'etn.thoughts.copy_subtree',
  z.object({
    source_network_id: NetworkId,
    target_network_id: NetworkId,
    root_thought_ids: z.array(ThoughtId).min(1).max(MCP_MAX_THOUGHTS_PER_WRITE),
    max_depth: z.number().int().min(0).max(20).optional(),
    include: z.array(z.enum(['thought', 'links', 'properties', 'comments', 'attachments'])).optional(),
    duplicate_policy: z.enum(['fail', 'reuse', 'skip', 'create_always']).optional(),
    id_remap: z.boolean().optional(),
    target_parent_thought_id: ThoughtId.optional(),
  }),
  {},
);

const MentionsScanFields = z
  .object({
    network_id: NetworkId,
    text: z.string().min(1).optional(),
    source: z
      .object({ comment_id: z.string().min(1).optional(), thought_id: z.string().min(1).optional() })
      .optional(),
    case_sensitive: z.boolean().optional(),
    use_synonyms: z.boolean().optional(),
    use_wildcards: z.boolean().optional(),
    min_confidence: z.number().min(0).max(1).optional(),
    create_links: z.boolean().optional(),
    link_type: z.string().min(1).optional(),
    link_direction: z.enum(['out', 'in']).optional(),
    source_thought_id: ThoughtId.optional(),
  })
  // `.strict()` (ошибка c245e7de, после ea4581c5): до `.refine()`.
  .strict()
  .refine((v) => (v.text !== undefined) !== (v.source !== undefined), {
    message: 'provide exactly one of `text` or `source`',
  });
export const ThoughtsMentionsScan = defineContract('etn.thoughts.mentions_scan', MentionsScanFields, {});

const ImportSourceSchema = z.union([
  z.object({ kind: z.literal('etnx_file'), path: z.string().min(1) }),
  z.object({ kind: z.literal('etnx_base64'), content_base64: z.string().min(1) }),
]);
export const ImportDryRun = defineContract(
  'etn.import.dry_run',
  z.object({
    network_id: NetworkId,
    source: ImportSourceSchema,
    collision_policy: z.enum(['fail', 'rename', 'skip', 'overwrite']).optional(),
  }),
  {},
);

export const ImportSubgraph = defineContract(
  'etn.import.subgraph',
  z.object({
    network_id: NetworkId,
    source: ImportSourceSchema,
    collision_policy: z.enum(['fail', 'rename', 'skip', 'overwrite']).optional(),
    confirm: z.literal(true),
    parent_thought_id: ThoughtId.optional(),
  }),
  {},
);

// ===========================================================================
// Область: типы, отборы, активность, метрики, инструкции, экспорт,
// события, хроника, захваты, корзина, участники
// ===========================================================================

export const TypesList = defineContract(
  'etn.types.list',
  z.object({
    network_id: NetworkId,
    in_subtree_of: ThoughtId.optional(),
    max_depth: z.number().int().min(1).max(TRAVERSAL_DEFAULTS.MAX_DEPTH).optional(),
    scope: z.enum(TYPES_LIST_SCOPES).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
    max_chars: z.number().int().min(1000).optional(),
  }),
  {},
);

export const ViewsRun = defineContract(
  'etn.views.run',
  z.object({
    network_id: NetworkId,
    thought_id: ThoughtId,
    view_name: z.string().min(1),
    limit: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  }),
  {},
);

export const ActivityList = defineContract(
  'etn.activity.list',
  z.object({
    network_id: NetworkId,
    from_ms: z.number().int().nonnegative().optional(),
    to_ms: z.number().int().nonnegative().optional(),
    user_id: z.string().min(1).optional(),
    entity_type: z.string().min(1).optional(),
    entity_id: z.string().min(1).optional(),
    limit: z.number().int().positive().max(ACTIVITY_LIMIT_MAX).optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
  {},
);

export const ActivityRollup = defineContract(
  'etn.activity.rollup',
  z.object({ network_id: NetworkId, until_ms: z.number().int().nonnegative() }),
  {},
);

export const ActivityTruncate = defineContract(
  'etn.activity.truncate',
  z.object({ network_id: NetworkId, until_ms: z.number().int().nonnegative() }),
  {},
);

export const MetricsReads = defineContract(
  'etn.metrics.reads',
  z.object({
    network_id: NetworkId,
    kind: z.enum(['top', 'cold']).optional(),
    since: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    include_inactive: z.boolean().optional(),
  }),
  {},
);

export const MetricsTools = defineContract(
  'etn.metrics.tools',
  z.object({
    network_id: NetworkId.optional(),
    from_ms: z.number().int().nonnegative().optional(),
    to_ms: z.number().int().nonnegative().optional(),
    group_by: z.enum(['tool', 'tool+network', 'tool+key']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  {},
);

/**
 * `instruction_ids` фактически передан и непуст. REST-парсер repeatable-массива
 * кладёт `[]` при отсутствии параметра — пустой список считается отсутствующим
 * (задача 649c55e2). Общий предикат взаимоисключений MCP и REST.
 */
function instructionIdsPresent(v: { instruction_ids?: string[] | undefined }): boolean {
  return Array.isArray(v.instruction_ids) && v.instruction_ids.length > 0;
}

export const Instructions = defineContract(
  'etn.instructions',
  z
    .object({
      network_id: NetworkId,
      instruction_id: z.string().min(1).optional(),
      instruction_ids: z.array(ThoughtId).min(1).max(50).optional(),
      keywords: z.string().min(1).optional(),
      scope: z.enum(['roots', 'all']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .strict()
    .refine((v) => v.instruction_id === undefined || v.keywords === undefined, {
      message: 'instruction_id и keywords взаимоисключимы',
    })
    .refine((v) => v.instruction_id === undefined || !instructionIdsPresent(v), {
      message: 'instruction_id и instruction_ids взаимоисключимы',
    })
    .refine((v) => !instructionIdsPresent(v) || v.keywords === undefined, {
      message: 'instruction_ids и keywords взаимоисключимы',
    })
    .refine(
      (v) =>
        v.scope === undefined ||
        (v.keywords === undefined && v.instruction_id === undefined && !instructionIdsPresent(v)),
      {
        message:
          'scope применим только к режиму перечня без keywords, instruction_id и instruction_ids',
      },
    )
    .refine(
      (v) =>
        (v.instruction_id === undefined && !instructionIdsPresent(v)) ||
        (v.limit === undefined && v.offset === undefined),
      {
        message: 'limit/offset применимы только к режимам перечня, не к instruction_id/instruction_ids',
      },
    ),
  {},
);

export const ExportSubgraph = defineContract(
  'etn.export.subgraph',
  z.object({
    network_id: NetworkId,
    seed_ids: z.array(ThoughtId).min(1).max(50),
    radius: z.number().int().min(0).max(TRAVERSAL_DEFAULTS.MAX_DEPTH),
    format: z.enum(EXPORT_FORMATS).optional(),
    etnx_options: z
      .object({
        include_types: z.boolean().optional(),
        include_attachments: z.boolean().optional(),
        include_chronology: z.boolean().optional(),
        include_subtree: z.boolean().optional(),
        subtree_depth: z.number().int().min(1).max(20).optional(),
      })
      .optional(),
  }),
  {},
);

export const ChangesList = defineContract(
  'etn.changes.list',
  z.object({
    network_id: NetworkId,
    since_seq: z.number().int().min(0),
    limit: z.number().int().min(1).max(REALTIME_DEFAULTS.EVENT_LOG_MAX_ROWS).optional(),
  }),
  {},
);

export const ChronicleQuery = defineContract(
  'etn.chronicle.query',
  z.object({
    network_id: NetworkId,
    keywords: z.string().optional(),
    // Область поиска ключевых слов (0.10.1, задача 46057359): `comment`
    // покрывает постоянные комментарии мыслей И текст/заголовок самих записей;
    // выключенная область `comment` (в т.ч. `['title','synonyms']`) отключает
    // путь по тексту записи. Паритет с REST-телом (`parseChronicleQueryBody`).
    keyword_scope: z.array(z.enum(STRUCTURE_KEYWORD_SCOPES)).optional(),
    thought_ids: z.array(ThoughtId).optional(),
    include_subtree: z.boolean().optional(),
    type: z.string().min(1).optional(),
    type_id: z.array(ThoughtId).optional(),
    link_type: z.string().min(1).optional(),
    link_type_id: z.array(ThoughtId).optional(),
    link_scope: z.enum(['sources', 'targets', 'both']).optional(),
    date_from: z.string().min(1).optional(),
    date_to: z.string().min(1).optional(),
    // Критерии целей записи (0.10.1): набор полей «Структур»
    // (05-mcp-server.md §4.1), разбирается доменным `parseStructureFilter`.
    // Компактная форма — свободный объект: tools/list держит бюджет размера
    // (сторож mcp-telemetry), а состав полей валидируется в домене.
    targets: z.record(z.string(), z.unknown()).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  {},
);

export const LocksAcquire = defineContract(
  'etn.locks.acquire',
  z.object({
    network_id: NetworkId,
    entity_type: z.string().min(1),
    entity_id: z.string().min(1),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    entity_type: { from: { kind: 'body' }, msg: '{key} обязателен и должен быть непустой строкой.' },
    entity_id: { from: { kind: 'body' }, msg: '{key} обязателен и должен быть непустой строкой.' },
  },
);

export const LocksRelease = defineContract(
  'etn.locks.release',
  z.object({ network_id: NetworkId, lock_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    lock_id: { from: { kind: 'param', name: 'lockId' } },
  },
);

export const LocksClear = defineContract(
  'etn.locks.clear',
  z.object({ network_id: NetworkId, user_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    user_id: { from: { kind: 'body' }, msg: '{key} обязателен и должен быть непустой строкой.' },
  },
);

export const LocksList = defineContract(
  'etn.locks.list',
  z.object({
    network_id: NetworkId,
    user_id: z.string().min(1).nullable().optional(),
    client_id: z.string().min(1).nullable().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    user_id: {
      from: { kind: 'query' },
      parse: (raw: unknown, requestId: string) => {
        if (Array.isArray(raw) && raw.length > 1) {
          throw new EtnError('VALIDATION_ERROR', 'user_id и client_id принимают ровно одно значение.', { field: 'user_id|client_id' }, requestId);
        }
        return Array.isArray(raw) ? raw[0] : raw;
      },
    },
    client_id: {
      from: { kind: 'query' },
      parse: (raw: unknown, requestId: string) => {
        if (Array.isArray(raw) && raw.length > 1) {
          throw new EtnError('VALIDATION_ERROR', 'user_id и client_id принимают ровно одно значение.', { field: 'user_id|client_id' }, requestId);
        }
        return Array.isArray(raw) ? raw[0] : raw;
      },
    },
  },
);
export const TrashList = defineContract('etn.trash.list', z.object({ network_id: NetworkId }), {});
export const TrashPurge = defineContract('etn.trash.purge', z.object({ network_id: NetworkId }), {});
export const MembersList = defineContract('etn.members.list', z.object({ network_id: NetworkId }), {});

// ===========================================================================
// Область: прогрессивное раскрытие — etn.guide + etn.ops (задача 86ef2ff4,
// версия 0.8.3). Редкие операции, снятые из постоянного набора инструментов
// (ADR «Погрессивное раскрытие MCP…» b2eebf8b; ADR «Поглощённые инструменты
// снимаются одним мажором…» 8358eea9). Контракты плоские объекты без union —
// грабля 5498e16c (MCP-SDK публикует пустую схему для union inputSchema).
//
// Поглощённые операции сохраняют СВОИ контракты выше в этом реестре: они
// служат схемами `params` для диспетчера `etn.ops` и схемами REST-парсинга
// (у слоёв/захватов REST-маршруты живы). Прежняя инварианта «все `etn.*`
// контракты = ровно витрина `tools/list`» больше не действует: часть из них
// исполняется только через `etn.ops` (см. `mcp/tools/ops-catalog.ts`).
// ===========================================================================

/** `etn.guide` — read-only витрина редких операций: без params — реестр
 *  «действие → когда нужно», с `topic` — полная инструкция вызова. */
export const Guide = defineContract(
  'etn.guide',
  z.object({ topic: z.string().min(1).optional() }),
  {},
);

/** `etn.ops` — исполнитель редких операций: `action` + плоский `params` +
 *  `confirm: true` для деструктивных. Валидация `params` — внутри, по
 *  схеме действия из реестра `etn.guide` (та же, что у поглощённого
 *  инструмента). */
export const Ops = defineContract(
  'etn.ops',
  z.object({
    action: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
    confirm: z.boolean().optional(),
  }),
  {},
);

// ===========================================================================
// REST-контракты (маршруты без общей с MCP формы входа; имя «rest:…» —
// в реестр MCP они не попадают, используются только parseRest)
// ===========================================================================

const singleQueryValue = (raw: unknown, requestId: string): unknown => {
  if (Array.isArray(raw) && raw.length > 1) {
    throw new EtnError('VALIDATION_ERROR', 'user_id, entity_type и entity_id принимают ровно одно значение.', { field: 'user_id|entity_type|entity_id' }, requestId);
  }
  return Array.isArray(raw) ? raw[0] : raw;
};

/** GET /networks/:id/activity — лента журнала. */
export const RestActivityList = defineContract(
  'rest:activity.list',
  z.object({
    network_id: NetworkId,
    from_ms: z.number().int().min(0).optional(),
    to_ms: z.number().int().min(0).optional(),
    user_id: z.string().min(1).optional(),
    entity_type: z.string().min(1).optional(),
    entity_id: z.string().min(1).optional(),
    limit: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    from_ms: { from: { kind: 'query', coerce: 'int', min: 0 } },
    to_ms: { from: { kind: 'query', coerce: 'int', min: 0 } },
    user_id: { from: { kind: 'query' }, parse: singleQueryValue },
    entity_type: { from: { kind: 'query' }, parse: singleQueryValue },
    entity_id: { from: { kind: 'query' }, parse: singleQueryValue },
    limit: { from: { kind: 'query', coerce: 'int', min: 1 } },
    offset: { from: { kind: 'query', coerce: 'int', min: 0 } },
  },
);

/** POST /networks/:id/activity/rollup|truncate — { until_ms }. */
const activityUntil = {
  network_id: { from: { kind: 'param', name: 'networkId' } },
  until_ms: {
    from: { kind: 'body' },
    msg: 'until_ms обязателен и должен быть неотрицательным целым.',
    check: (v: unknown) => (typeof v === 'number' && v < 0 ? 'until_ms должен быть неотрицательным целым.' : null),
  },
} as const;
export const RestActivityRollup = defineContract(
  'rest:activity.rollup',
  z.object({ network_id: NetworkId, until_ms: z.number().int() }),
  activityUntil,
);
export const RestActivityTruncate = defineContract(
  'rest:activity.truncate',
  z.object({ network_id: NetworkId, until_ms: z.number().int() }),
  activityUntil,
);

/** GET /networks/:id/trash — список корзины. */
export const RestTrashList = defineContract(
  'rest:trash.list',
  z.object({ network_id: NetworkId }),
  { network_id: { from: { kind: 'param', name: 'networkId' } } },
);

/**
 * POST /networks/:id/trash/purge — очистка (опционально targeted `ids`).
 * С 0.11.1 (задача c59ce742) корзина охватывает и публикации/полки, поэтому
 * `ids` принимает id строк любого вида — см. `listTrash`.
 */
export const RestTrashPurge = defineContract(
  'rest:trash.purge',
  z.object({ network_id: NetworkId }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    ids: { from: { kind: 'body' }, t: z.array(z.string().min(1)) },
  },
);

/** GET /networks/:id/instructions — витрина инструкций (паритет с
 *  etn.instructions; сообщения — канонические, как у MCP-инструмента). */
export const RestInstructions = defineContract(
  'rest:instructions',
  z
    .object({
      network_id: NetworkId,
      instruction_id: z.string().min(1).optional(),
      instruction_ids: z.array(z.string().min(1)).max(50).optional(),
      keywords: z.string().min(1).optional(),
      scope: z.enum(['roots', 'all']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .refine((v) => v.instruction_id === undefined || v.keywords === undefined, {
      message: 'instruction_id и keywords взаимоисключимы',
    })
    .refine((v) => v.instruction_id === undefined || !instructionIdsPresent(v), {
      message: 'instruction_id и instruction_ids взаимоисключимы',
    })
    .refine((v) => !instructionIdsPresent(v) || v.keywords === undefined, {
      message: 'instruction_ids и keywords взаимоисключимы',
    })
    .refine(
      (v) =>
        v.scope === undefined ||
        (v.keywords === undefined && v.instruction_id === undefined && !instructionIdsPresent(v)),
      {
        message:
          'scope применим только к режиму перечня без keywords, instruction_id и instruction_ids',
      },
    )
    .refine(
      (v) =>
        (v.instruction_id === undefined && !instructionIdsPresent(v)) ||
        (v.limit === undefined && v.offset === undefined),
      {
        message: 'limit/offset применимы только к режимам перечня, не к instruction_id/instruction_ids',
      },
    ),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    instruction_id: { from: { kind: 'query' }, parse: (raw) => (typeof raw === 'string' && raw !== '' ? raw : undefined) },
    // `repeatable: true` — `?instruction_ids=a&instruction_ids=b`; при отсутствии
    // параметра парсер кладёт `[]`, который предикаты считают «не передан».
    instruction_ids: { from: { kind: 'query', repeatable: true }, t: z.array(z.string().min(1)).optional() },
    keywords: { from: { kind: 'query' }, parse: (raw) => (typeof raw === 'string' && raw !== '' ? raw : undefined) },
    scope: { from: { kind: 'query' }, parse: (raw) => (typeof raw === 'string' && raw !== '' ? raw : undefined) },
    limit: { from: { kind: 'query', coerce: 'int', min: 1 } },
    offset: { from: { kind: 'query', coerce: 'int', min: 0 } },
  },
);

/** GET …/properties — список значений (REST). */
export const RestPropertyList = defineContract(
  'rest:properties.list',
  z.object({ network_id: NetworkId, owner_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    owner_id: { from: { kind: 'param', name: 'id' } },
  },
);

/** PUT …/properties/:key — upsert значения (REST-сообщения прежние). */
export const RestPropertyPut = defineContract(
  'rest:properties.put',
  z.object({ network_id: NetworkId, owner_id: z.string().min(1), key: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    owner_id: { from: { kind: 'param', name: 'id' } },
    key: {
      from: { kind: 'param' },
      check: (v: unknown) => (typeof v === 'string' && v.trim() === '' ? 'Ключ свойства не может быть пустым.' : null),
    },
    value: {
      from: { kind: 'body' },
      t: PropertyValueSchema,
      req: true,
      msg: 'Поле value обязательно.',
    },
  },
);

/** DELETE …/properties/:key — удаление значения. */
export const RestPropertyDelete = defineContract(
  'rest:properties.delete',
  z.object({ network_id: NetworkId, owner_id: z.string().min(1), key: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    owner_id: { from: { kind: 'param', name: 'id' } },
    key: { from: { kind: 'param' } },
  },
);

/**
 * POST …/properties/:key/cross-resolve — явный резолв значений вида
 * «кросс-сетевая ссылка» (задача 7849008a, требование 95511443,
 * спека операции 737ed900). Тело пустое; ответ — массив обновлённых
 * снапшотов с признаком `resolved`/`unresolved`. Служебная запись,
 * без write-бюджета и audit-записи как содержательной правки
 * (требование c104a0fc).
 */
export const RestPropertyCrossResolve = defineContract(
  'rest:properties.cross-resolve',
  z.object({ network_id: NetworkId, owner_id: z.string().min(1), key: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    owner_id: { from: { kind: 'param', name: 'id' } },
    key: { from: { kind: 'param' } },
  },
);

/** GET /networks/:id/pins — список закрепов. */
export const RestPinsGet = defineContract(
  'rest:pins.get',
  z.object({ network_id: NetworkId }),
  { network_id: { from: { kind: 'param', name: 'networkId' } } },
);

/** PUT /networks/:id/pins — замена списка (≤20 — домен). */
export const RestPinsPut = defineContract(
  'rest:pins.put',
  z.object({ network_id: NetworkId }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    ordered_ids: {
      from: { kind: 'body' },
      t: z.array(z.string().min(1)),
      req: true,
      msg: 'ordered_ids обязателен.',
    },
  },
);

/** GET /admin/audit — журнал аудита (админ). */
export const RestAuditQuery = defineContract(
  'rest:audit.query',
  z.object({
    actor: z.string().min(1).optional(),
    network: z.string().min(1).optional(),
    category: z.enum(AUDIT_CATEGORIES).optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    limit: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  {
    actor: { from: { kind: 'query' }, parse: (raw) => (typeof raw === 'string' && raw.length > 0 ? raw : undefined) },
    network: { from: { kind: 'query' }, parse: (raw) => (typeof raw === 'string' && raw.length > 0 ? raw : undefined) },
    category: {
      from: { kind: 'query' },
      parse: (raw) => (typeof raw === 'string' && raw.length > 0 ? raw : undefined),
      msg: 'Недопустимая категория.',
    },
    from: { from: { kind: 'query' }, parse: (raw) => (typeof raw === 'string' && raw.length > 0 ? raw : undefined) },
    to: { from: { kind: 'query' }, parse: (raw) => (typeof raw === 'string' && raw.length > 0 ? raw : undefined) },
    limit: { from: { kind: 'query', coerce: 'int', min: 1 }, msg: 'limit должен быть положительным целым.' },
    offset: { from: { kind: 'query', coerce: 'int', min: 0 }, msg: 'offset должен быть неотрицательным целым.' },
  },
);

// ---------------------------------------------------------------------------
// Комментарии (REST — routes/comments.ts; формы входа шире MCP-инструментов)
// ---------------------------------------------------------------------------

const commentFieldsRest = {
  kind: {
    from: { kind: 'body' },
    msg: 'kind обязателен (permanent|chronological).',
  },
  // `body_md` больше не «обязателен и непуст» на уровне контракта (ошибка
  // 00115e7b): у хронологической записи содержание может держаться на
  // заголовке или привязке вне HOME (требование 26f0aa52). Полную проверку
  // содержания по виду комментария делает домен `comment-service`.
  body_md: { from: { kind: 'body' } },
  title: { from: { kind: 'body' } },
  valid_from: { from: { kind: 'body' } },
  valid_to: { from: { kind: 'body' } },
  use_time: { from: { kind: 'body' } },
} as const;

/** GET …/comments — список комментариев владельца. */
export const RestCommentListOwner = defineContract(
  'rest:comments.list-owner',
  z.object({ network_id: NetworkId, owner_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    owner_id: { from: { kind: 'param', name: 'id' } },
  },
);

/** POST …/comments — создание на владельце. */
export const RestCommentCreateOwner = defineContract(
  'rest:comments.create-owner',
  z.object({
    network_id: NetworkId,
    owner_id: z.string().min(1),
    kind: z.enum(COMMENT_KINDS),
    body_md: z.string().optional(),
    title: z.string().nullable().optional(),
    valid_from: z.string().optional(),
    valid_to: z.string().nullable().optional(),
    use_time: z.boolean().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    owner_id: { from: { kind: 'param', name: 'id' } },
    ...commentFieldsRest,
  },
);

/** POST /networks/:id/comments — создание с несколькими владельцами (L20). */
export const RestCommentCreateTargets = defineContract(
  'rest:comments.create-targets',
  z.object({
    network_id: NetworkId,
    kind: z.enum(COMMENT_KINDS),
    body_md: z.string().optional(),
    title: z.string().nullable().optional(),
    valid_from: z.string().optional(),
    valid_to: z.string().nullable().optional(),
    use_time: z.boolean().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    ...commentFieldsRest,
    targets: {
      from: { kind: 'body' },
      // Поле REST-only (нет в общей схеме), поэтому без явного `req` его
      // отсутствие в теле молча пропускается `parseRest` и `parse` не
      // вызывается — `undefined` уходил в домен и давал 500 (ошибка 13a2706f).
      // Явная обязательность даёт тот же 422 с `details.field=targets`, что и
      // `targets: []`; сообщение совпадает с веткой `parse`.
      req: true,
      msg: 'targets обязателен: массив { owner_type, owner_id } (1 и более).',
      parse: (raw: unknown, requestId: string) => {
        if (!Array.isArray(raw) || raw.length === 0) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'targets обязателен: массив { owner_type, owner_id } (1 и более).',
            { field: 'targets' },
            requestId,
          );
        }
        const targets: Array<{ owner_type: string; owner_id: string }> = [];
        for (const item of raw) {
          if (typeof item !== 'object' || item === null) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'каждый элемент targets — объект { owner_type, owner_id }.',
              { field: 'targets' },
              requestId,
            );
          }
          const rec = item as Record<string, unknown>;
          const ownerType = rec['owner_type'];
          const ownerId = rec['owner_id'];
          if (
            typeof ownerType !== 'string' ||
            !(COMMENT_OWNER_TYPES as readonly string[]).includes(ownerType) ||
            typeof ownerId !== 'string' ||
            ownerId === ''
          ) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'каждый элемент targets — { owner_type: thought|link, owner_id: непустая строка }.',
              { field: 'targets' },
              requestId,
            );
          }
          targets.push({ owner_type: ownerType, owner_id: ownerId });
        }
        return targets;
      },
    },
  },
);

/** GET/DELETE /networks/:id/comments/:id — чтение/удаление. */
export const RestCommentById = defineContract(
  'rest:comments.by-id',
  z.object({ network_id: NetworkId, comment_id: z.string().min(1), expected_version: z.number().int().min(1).optional() }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    comment_id: { from: { kind: 'param', name: 'id' } },
    expected_version: {
      from: { kind: 'header', name: 'If-Match', int: true },
      msg: 'Заголовок If-Match должен содержать целую версию.',
    },
  },
);

/** PATCH /networks/:id/comments/:id — правка. */
export const RestCommentUpdate = defineContract(
  'rest:comments.update',
  z.object({
    network_id: NetworkId,
    comment_id: z.string().min(1),
    expected_version: z.number().int().min(1).optional(),
    title: z.string().nullable().optional(),
    body_md: z.string().optional(),
    valid_from: z.string().optional(),
    valid_to: z.string().nullable().optional(),
    use_time: z.boolean().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    comment_id: { from: { kind: 'param', name: 'id' } },
    expected_version: {
      from: { kind: 'header', name: 'If-Match', int: true },
      msg: 'Заголовок If-Match должен содержать целую версию.',
    },
    title: { from: { kind: 'body' } },
    body_md: { from: { kind: 'body' } },
    valid_from: { from: { kind: 'body' } },
    valid_to: { from: { kind: 'body' } },
    // Флаг «учитывать время» обязан читаться из тела: без записи в REST-карте
    // `parseRest` его не вернёт, и PATCH молча терял бы флаг (ошибка f45fac74,
    // итерация приёмки №11 0.10.1). Создание (`commentFieldsRest`) флаг уже чтит.
    use_time: { from: { kind: 'body' } },
  },
);

/** POST /networks/:id/comments/:id/targets — ещё один владелец. */
export const RestCommentAddTarget = defineContract(
  'rest:comments.add-target',
  z.object({
    network_id: NetworkId,
    comment_id: z.string().min(1),
    expected_version: z.number().int().min(1).optional(),
    owner_type: z.enum(COMMENT_OWNER_TYPES),
    owner_id: z.string().min(1),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    comment_id: { from: { kind: 'param', name: 'id' } },
    expected_version: {
      from: { kind: 'header', name: 'If-Match', int: true },
      msg: 'Заголовок If-Match должен содержать целую версию.',
    },
    owner_type: { from: { kind: 'body' }, msg: 'owner_type (thought|link) и owner_id обязательны.' },
    owner_id: { from: { kind: 'body' }, msg: 'owner_type (thought|link) и owner_id обязательны.' },
  },
);

/** DELETE /networks/:id/comments/:id/targets/:ownerType/:ownerId — отвязка. */
export const RestCommentDetachTarget = defineContract(
  'rest:comments.detach-target',
  z.object({
    network_id: NetworkId,
    comment_id: z.string().min(1),
    expected_version: z.number().int().min(1).optional(),
    owner_type: z.enum(COMMENT_OWNER_TYPES),
    owner_id: z.string().min(1),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    comment_id: { from: { kind: 'param', name: 'id' } },
    expected_version: {
      from: { kind: 'header', name: 'If-Match', int: true },
      msg: 'Заголовок If-Match должен содержать целую версию.',
    },
    owner_type: { from: { kind: 'param', name: 'ownerType' } },
    owner_id: { from: { kind: 'param', name: 'ownerId' } },
  },
);

// ---------------------------------------------------------------------------
// Вложения (REST — routes/attachments.ts)
// ---------------------------------------------------------------------------

/** Конечное число → Math.trunc (как optionalIntField прежнего роута). */
const truncInt = (v: unknown): unknown => {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new EtnError('VALIDATION_ERROR', 'значение должно быть числом.', { field: 'file_size' });
  }
  return Math.trunc(v);
};

export const RestAttachmentListOwner = defineContract(
  'rest:attachments.list-owner',
  z.object({ network_id: NetworkId, owner_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    owner_id: { from: { kind: 'param', name: 'id' } },
  },
);

export const RestAttachmentCreate = defineContract(
  'rest:attachments.create',
  z.object({ network_id: NetworkId, owner_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    owner_id: { from: { kind: 'param', name: 'id' } },
    kind: {
      from: { kind: 'body' },
      t: z.enum(ATTACHMENT_KINDS),
      req: true,
      msg: 'kind обязателен (url|file).',
    },
    url: { from: { kind: 'body' }, t: z.string().nullable() },
    file_path: { from: { kind: 'body' }, t: z.string().nullable() },
    file_size: { from: { kind: 'body' }, t: z.number().int(), parse: truncInt, msg: 'file_size должен быть числом.' },
    mime_type: { from: { kind: 'body' }, t: z.string().nullable() },
    title: { from: { kind: 'body' }, t: z.string().nullable() },
    description: { from: { kind: 'body' }, t: z.string().nullable() },
    position: { from: { kind: 'body' }, t: z.number().int(), parse: truncInt, msg: 'position должен быть числом.' },
  },
);

export const RestAttachmentFileCreate = defineContract(
  'rest:attachments.create-file',
  z.object({ network_id: NetworkId, owner_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    owner_id: { from: { kind: 'param', name: 'id' } },
    mime_type: { from: { kind: 'body' }, t: z.string().min(1), req: true, msg: 'mime_type обязателен.' },
    data_base64: { from: { kind: 'body' }, t: z.string().min(1), req: true, msg: 'data_base64 обязателен.' },
    title: { from: { kind: 'body' }, t: z.string().nullable() },
  },
);

export const RestAttachmentSearch = defineContract(
  'rest:attachments.search',
  z.object({ network_id: NetworkId }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    q: { from: { kind: 'query' }, t: z.string().optional() },
    exclude_owner_type: {
      from: { kind: 'query' },
      t: z.enum(ATTACHMENT_OWNER_TYPES).optional(),
      msg: 'exclude_owner_type должен быть thought|link|publication.',
    },
    exclude_owner_id: { from: { kind: 'query' }, t: z.string().optional(), msg: 'exclude_owner_id должен быть строкой.' },
    kind: { from: { kind: 'query' }, t: z.enum(ATTACHMENT_KINDS).optional(), msg: 'kind должен быть url|file.' },
    limit: { from: { kind: 'query' }, t: z.number().int().optional(), parse: truncInt, msg: 'limit должен быть числом.' },
    offset: { from: { kind: 'query' }, t: z.number().int().optional(), parse: truncInt, msg: 'offset должен быть числом.' },
  },
);

export const RestAttachmentRaw = defineContract(
  'rest:attachments.raw',
  z.object({ network_id: NetworkId }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    path: { from: { kind: 'query' }, t: z.string().min(1), req: true, msg: 'path обязателен.' },
  },
);

export const RestAttachmentCopy = defineContract(
  'rest:attachments.copy',
  z.object({ network_id: NetworkId, attachment_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    attachment_id: { from: { kind: 'param', name: 'id' } },
    target_owner_type: {
      from: { kind: 'body' },
      t: z.enum(ATTACHMENT_OWNER_TYPES),
      req: true,
      msg: 'target_owner_type должен быть thought|link|publication.',
    },
    target_owner_ids: {
      from: { kind: 'body' },
      parse: (raw: unknown, requestId: string) => {
        if (!Array.isArray(raw)) {
          throw new EtnError('VALIDATION_ERROR', 'target_owner_ids должен быть массивом строк.', { field: 'target_owner_ids' }, requestId);
        }
        return raw.map((v) => {
          if (typeof v !== 'string' || v === '') {
            throw new EtnError(
              'VALIDATION_ERROR',
              'target_owner_ids содержит не строку или пустую строку.',
              { field: 'target_owner_ids' },
              requestId,
            );
          }
          return v;
        });
      },
      req: true,
    },
  },
);

export const RestAttachmentById = defineContract(
  'rest:attachments.by-id',
  z.object({ network_id: NetworkId, attachment_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    attachment_id: { from: { kind: 'param', name: 'id' } },
  },
);

/**
 * `GET /attachments/{id}/usage` — использование вложения (0.11.1, задача
 * 46cf4bcb): владельцы (мысли, связи, публикации), которые держат этот
 * носитель. Нужно «облачкам» в диалоге выбора обложки публикации.
 */
export const RestAttachmentUsage = defineContract(
  'rest:attachments.usage',
  z.object({ network_id: NetworkId, attachment_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    attachment_id: { from: { kind: 'param', name: 'id' } },
  },
);

export const RestAttachmentUpdate = defineContract(
  'rest:attachments.update',
  z.object({ network_id: NetworkId, attachment_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    attachment_id: { from: { kind: 'param', name: 'id' } },
    url: { from: { kind: 'body' }, t: z.string().nullable() },
    file_path: { from: { kind: 'body' }, t: z.string().nullable() },
    file_size: { from: { kind: 'body' }, t: z.number().int(), parse: truncInt, msg: 'file_size должен быть числом.' },
    mime_type: { from: { kind: 'body' }, t: z.string().nullable() },
    title: { from: { kind: 'body' }, t: z.string().nullable() },
    description: { from: { kind: 'body' }, t: z.string().nullable() },
    icon: { from: { kind: 'body' }, t: z.string().nullable() },
    position: { from: { kind: 'body' }, t: z.number().int(), parse: truncInt, msg: 'position должен быть числом.' },
    owner_type: {
      from: { kind: 'body' },
      t: z.enum(ATTACHMENT_OWNER_TYPES).optional(),
      msg: 'owner_type должен быть thought|link|publication.',
    },
    owner_id: { from: { kind: 'body' }, t: z.string().optional() },
  },
);

export const RestAttachmentContentPut = defineContract(
  'rest:attachments.content-put',
  z.object({ network_id: NetworkId, attachment_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    attachment_id: { from: { kind: 'param', name: 'id' } },
    data_base64: { from: { kind: 'body' }, t: z.string().min(1), req: true, msg: 'data_base64 обязателен.' },
    mime_type: { from: { kind: 'body' }, t: z.string().optional() },
  },
);

// ---------------------------------------------------------------------------
// Сети и участники (REST — routes/networks.ts)
// ---------------------------------------------------------------------------

/** POST /networks — создание сети. */
export const RestNetworkCreate = defineContract(
  'rest:networks.create',
  z.object({
    display_name: z.string().min(1),
    description: z.string().nullable().optional(),
  }),
  {
    display_name: {
      from: { kind: 'body' },
      msg: 'display_name обязательно и не может быть пустым.',
      check: (v: unknown) => (typeof v === 'string' && v.trim() === '' ? 'display_name обязательно и не может быть пустым.' : null),
    },
    description: {
      from: { kind: 'body' },
      parse: (raw: unknown) => (typeof raw === 'string' ? raw || null : null),
    },
    type_roles: { from: { kind: 'body' }, t: z.record(z.string(), z.string()).optional() },
  },
);

/** GET/PATCH /networks/:id — параметры пути. */
export const RestNetworkById = defineContract(
  'rest:networks.by-id',
  z.object({ network_id: NetworkId }),
  { network_id: { from: { kind: 'param', name: 'networkId' } } },
);

/** POST /networks/:id/members — добавление участника. */
export const RestNetworkMemberAdd = defineContract(
  'rest:networks.member-add',
  z.object({ network_id: NetworkId, user_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    user_id: { from: { kind: 'body' }, msg: 'user_id обязательно.' },
  },
);

/** DELETE/PATCH /networks/:id/members/:uid — параметры пути. */
export const RestNetworkMemberById = defineContract(
  'rest:networks.member-by-id',
  z.object({ network_id: NetworkId, uid: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    uid: { from: { kind: 'param' } },
  },
);

/** PATCH /networks/:id/members/:uid — передача владения. */
export const RestNetworkMemberPatch = defineContract(
  'rest:networks.member-patch',
  z.object({ network_id: NetworkId, uid: z.string().min(1), role: z.enum(['owner']) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    uid: { from: { kind: 'param' } },
    role: { from: { kind: 'body' }, msg: 'Поддерживается только передача владения (role: "owner").' },
  },
);

/** PUT /networks/:id/preferences/:key — параметры пути (key проверяет роут). */
export const RestNetworkPreferenceKey = defineContract(
  'rest:networks.preference-key',
  z.object({ network_id: NetworkId, key: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    key: { from: { kind: 'param' } },
  },
);

// ---------------------------------------------------------------------------
// Серверные настройки пользователя вне сети (REST — routes/me.ts)
// ---------------------------------------------------------------------------

/** PUT /users/me/settings/:key — имя настройки из пути (ADR 3a829d25). */
export const RestUserSettingKey = defineContract(
  'rest:users.me.setting-key',
  z.object({ key: z.string().min(1) }),
  {
    key: { from: { kind: 'param' } },
  },
);

// ---------------------------------------------------------------------------
// Связи (REST — routes/links.ts) и импорт (routes/import.ts)
// ---------------------------------------------------------------------------

export const RestLinkGet = defineContract(
  'rest:links.get',
  z.object({ network_id: NetworkId, link_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    link_id: { from: { kind: 'param', name: 'id' } },
    at_layer_id: { from: { kind: 'query' }, t: z.string().min(1).optional() },
  },
);

export const RestLinkPatch = defineContract(
  'rest:links.patch',
  z.object({ network_id: NetworkId, link_id: z.string().min(1), expected_version: z.number().int().min(1).optional() }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    link_id: { from: { kind: 'param', name: 'id' } },
    expected_version: {
      from: { kind: 'header', name: 'If-Match', int: true },
      msg: 'Заголовок If-Match должен содержать целую версию.',
    },
    source_id: { from: { kind: 'body' }, t: z.string().optional(), msg: 'source_id и target_id меняются вместе.' },
    target_id: { from: { kind: 'body' }, t: z.string().optional(), msg: 'source_id и target_id меняются вместе.' },
    type_id: { from: { kind: 'body' }, t: z.string().nullable().optional() },
    color: { from: { kind: 'body' }, t: z.string().nullable().optional() },
    style: { from: { kind: 'body' }, t: z.enum(LINK_STYLES).nullable().optional(), msg: 'Недопустимый style связи.' },
    width: { from: { kind: 'body' }, t: z.number().int().nullable().optional() },
    active: { from: { kind: 'body' }, t: z.boolean().optional() },
    marked_for_deletion: { from: { kind: 'body' }, t: z.boolean().optional() },
  },
);

export const RestLinkDeletionCheck = defineContract(
  'rest:links.deletion-check',
  z.object({ network_id: NetworkId, link_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    link_id: { from: { kind: 'param', name: 'id' } },
  },
);

export const RestLinkDeletionCheckBatch = defineContract(
  'rest:links.deletion-check-batch',
  z.object({ network_id: NetworkId }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    ids: {
      from: { kind: 'body' },
      t: z.array(z.string().min(1)).min(1),
      req: true,
      msg: 'ids обязателен (непустой массив строк).',
    },
  },
);

export const RestLinksByThought = defineContract(
  'rest:links.by-thought',
  z.object({ network_id: NetworkId, thought_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    thought_id: { from: { kind: 'param', name: 'id' } },
    group: {
      from: { kind: 'query' },
      t: z.string().optional(),
      check: (v: unknown) => (typeof v === 'string' && v !== 'type' ? 'Поддерживается только group=type.' : null),
    },
    show_inactive: { from: { kind: 'query', coerce: 'bool' }, t: z.boolean().optional() },
    show_trash: { from: { kind: 'query', coerce: 'bool' }, t: z.boolean().optional() },
  },
);

/** POST /networks/:id/import/preview — { archive_b64 }. */
export const RestImportPreview = defineContract(
  'rest:import.preview',
  z.object({ network_id: NetworkId }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    archive_b64: {
      from: { kind: 'body' },
      t: z.string().min(1),
      req: true,
      msg: 'Поле archive_b64 обязательно и должно быть непустой строкой.',
    },
  },
);

/** POST /networks/:id/import/commit — { archive_b64, parent_thought_id, etnx }. */
export const RestImportCommit = defineContract(
  'rest:import.commit',
  z.object({ network_id: NetworkId }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    archive_b64: {
      from: { kind: 'body' },
      t: z.string().min(1),
      req: true,
      msg: 'Поле archive_b64 обязательно и должно быть непустой строкой.',
    },
    parent_thought_id: {
      from: { kind: 'body' },
      t: z.string().min(1),
      req: true,
      msg: 'Поле parent_thought_id обязательно и должно быть UUID.',
    },
    etnx: {
      from: { kind: 'body' },
      parse: (raw: unknown) => {
        if (raw === undefined) return undefined;
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new EtnError('VALIDATION_ERROR', 'Поле etnx должно быть объектом.', { field: 'etnx' });
        }
        const obj = raw as Record<string, unknown>;
        const slices: Record<string, boolean> = {};
        for (const key of ['include_types', 'include_attachments', 'include_chronology'] as const) {
          if (obj[key] !== undefined) {
            if (typeof obj[key] !== 'boolean') {
              throw new EtnError('VALIDATION_ERROR', `etnx.${key} должен быть boolean.`, { field: `etnx.${key}` });
            }
            slices[key] = obj[key] as boolean;
          }
        }
        return slices;
      },
    },
  },
);

// ---------------------------------------------------------------------------
// Поиск, экспорт, упоминания (REST — routes/search.ts)
// ---------------------------------------------------------------------------

export const RestSearchQuery = defineContract(
  'rest:search.query',
  z
    .object({
      // Задача eb1a3f43, требование c98d5d19: `network_id` из URL-path
      // (`/networks/:networkId/search`) не валидируется zod-схемой, чтобы
      // XOR-refine не отвергал кросс-сетевой запрос с `network_ids`. Роут
      // берёт сеть из `req.params.networkId` и при наличии `network_ids`
      // дополняет ею веер.
      // Задача eb1a3f43: веерный режим — `network_ids` опционален.
      network_ids: z.array(NetworkId).optional(),
      q: z.string().min(1),
      scope: z.string().optional(),
      in: z.string().optional(),
      from_thought_id: z.string().min(1).optional(),
      type_id: z.array(z.string().min(1)).optional(),
      link_type_id: z.array(z.string().min(1)).optional(),
      show_inactive: z.boolean().optional(),
      trashed: z.boolean().optional(),
      author_id: z.string().optional(),
      editor_id: z.string().optional(),
      limit: z.number().int().min(1).optional(),
      offset: z.number().int().min(0).optional(),
    }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    // `repeatable: true` парсера: при отсутствии параметра в строке запроса
    // парсер кладёт `[]`; `.min(1)` здесь ломает одиночную сеть. Длину
    // проверяет роут (`input.network_ids.length > 0`).
    network_ids: { from: { kind: 'query', repeatable: true }, t: z.array(NetworkId).optional() },
    q: {
      from: { kind: 'query' },
      parse: (raw: unknown) => {
        const first = Array.isArray(raw) ? raw[0] : raw;
        return typeof first === 'string' && first.trim() !== '' ? first : undefined;
      },
      msg: 'Параметр q обязателен и не может быть пустым.',
    },
    scope: {
      from: { kind: 'query' },
      t: z.string().optional(),
      check: (v: unknown) =>
        typeof v === 'string' && !['names', 'texts', 'links', 'chronology', 'all', 'thoughts'].includes(v)
          ? 'Недопустимый scope.'
          : null,
    },
    in: {
      from: { kind: 'query' },
      t: z.string().optional(),
      check: (v: unknown) => (typeof v === 'string' && v !== 'subtree' ? 'in должен быть равен "subtree".' : null),
    },
    from_thought_id: {
      from: { kind: 'query' },
      t: z.string().optional(),
      check: (v: unknown, all: Record<string, unknown>) =>
        v === undefined && all['in'] === 'subtree' ? 'При in=subtree нужен from_thought_id.' : null,
    },
    type_id: { from: { kind: 'query', repeatable: true }, t: z.array(z.string().min(1)).optional() },
    link_type_id: { from: { kind: 'query', repeatable: true }, t: z.array(z.string().min(1)).optional() },
    show_inactive: { from: { kind: 'query', coerce: 'bool' }, t: z.boolean().optional() },
    trashed: { from: { kind: 'query', coerce: 'bool' }, t: z.boolean().optional() },
    author_id: { from: { kind: 'query' }, t: z.string().optional() },
    editor_id: { from: { kind: 'query' }, t: z.string().optional() },
    limit: { from: { kind: 'query', coerce: 'int', min: 1 } },
    offset: { from: { kind: 'query', coerce: 'int', min: 0 } },
  },
);

export const RestMentionsScan = defineContract(
  'rest:mentions.scan',
  z.object({ network_id: NetworkId }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    texts: {
      from: { kind: 'body' },
      t: z.array(z.string()).min(1),
      req: true,
      msg: 'texts обязателен (массив строк).',
      check: (v: unknown) => {
        const arr = v as string[];
        if (arr.length > 50) return 'texts не может содержать больше 50 элементов.';
        const total = arr.reduce((sum, t) => sum + t.length, 0);
        if (total > 20000) return 'Суммарная длина texts не может превышать 20000 символов.';
        return null;
      },
    },
    show_inactive: { from: { kind: 'body' }, t: z.boolean().optional() },
    exclude_thought_id: { from: { kind: 'body' }, t: z.string().optional() },
  },
);

/**
 * `GET /networks/:networkId/thoughts/duplicates` — контракт для веерного режима
 * (задача eb1a3f43, требование c98d5d19). `network_ids` задаёт дополнительные
 * сети для fan-out; `:networkId` интерпретируется как одна из сетей веера.
 * XOR проверяется в роуте (см. `routes/thoughts.ts`).
 */
export const RestThoughtDuplicates = defineContract(
  'rest:thoughts.duplicates',
  z
    .object({
      // `network_id` из URL-path (`/networks/:networkId/thoughts/duplicates`)
      // не валидируется zod-схемой: кросс-сетевой запрос всегда несёт и path,
      // и `network_ids`. Роут читает networkId из path и дополняет веер.
      network_ids: z.array(NetworkId).optional(),
      title: z.string().min(1),
      // Repeatable: ?synonyms=a&synonyms=b или ?synonyms=a,b — оба варианта
      // принимаются (роут склеивает).
      synonyms: z.array(z.string().min(1)).optional(),
      type_ids: z.array(z.string().min(1)).optional(),
    }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    // `repeatable: true` парсера: при отсутствии параметра в строке запроса
    // парсер кладёт `[]`; `.min(1)` здесь ломает одиночную сеть. Длину
    // проверяет роут (`input.network_ids.length > 0`).
    network_ids: { from: { kind: 'query', repeatable: true }, t: z.array(NetworkId).optional() },
    title: { from: { kind: 'query' }, req: true, msg: 'title обязателен.' },
    synonyms: { from: { kind: 'query', repeatable: true }, t: z.array(z.string().min(1)).optional() },
    type_ids: { from: { kind: 'query', repeatable: true }, t: z.array(z.string().min(1)).optional() },
  },
);

export const RestExport = defineContract(
  'rest:export.start',
  z.object({ network_id: NetworkId }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    thought_ids: {
      from: { kind: 'body' },
      t: z.array(z.string().min(1)).min(1),
      req: true,
      msg: 'thought_ids обязателен (непустой массив строк).',
    },
    format: {
      from: { kind: 'body' },
      t: z.enum(EXPORT_FORMATS),
      req: true,
      msg: 'Недопустимый format.',
    },
    etnx: {
      from: { kind: 'body' },
      parse: (raw: unknown, requestId: string) => {
        if (raw === undefined) return undefined;
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new EtnError('VALIDATION_ERROR', 'Поле etnx должно быть объектом.', { field: 'etnx' }, requestId);
        }
        const obj = raw as Record<string, unknown>;
        const opts: Record<string, unknown> = {};
        for (const key of ['include_types', 'include_attachments', 'include_chronology', 'include_subtree'] as const) {
          if (obj[key] !== undefined) {
            if (typeof obj[key] !== 'boolean') {
              throw new EtnError('VALIDATION_ERROR', `etnx.${key} должен быть boolean.`, { field: `etnx.${key}` }, requestId);
            }
            opts[key] = obj[key] as boolean;
          }
        }
        if (obj['subtree_depth'] !== undefined) {
          if (typeof obj['subtree_depth'] !== 'number' || !Number.isInteger(obj['subtree_depth'])) {
            throw new EtnError('VALIDATION_ERROR', 'etnx.subtree_depth должен быть целым числом.', { field: 'etnx.subtree_depth' }, requestId);
          }
          const depth = obj['subtree_depth'] as number;
          if (depth < 1 || depth > ETNX_SUBTREE_DEPTH_MAX) {
            throw new EtnError(
              'VALIDATION_ERROR',
              `etnx.subtree_depth должен быть в диапазоне 1..${ETNX_SUBTREE_DEPTH_MAX}.`,
              { field: 'etnx.subtree_depth', min: 1, max: ETNX_SUBTREE_DEPTH_MAX },
              requestId,
            );
          }
          opts.subtree_depth = depth;
        }
        return opts;
      },
    },
  },
);

export const RestJobById = defineContract(
  'rest:jobs.by-id',
  z.object({ job_id: z.string().min(1) }),
  { job_id: { from: { kind: 'param', name: 'jobId' } } },
);

// ---------------------------------------------------------------------------
// REST-тела (делегаты ручных парсеров роутов; общая форма — как у MCP)
// ---------------------------------------------------------------------------

/** Разобрать ТОЛЬКО тело запроса по контракту (делегат старых parseXBody). */
export function parseBody<S extends z.ZodObject>(
  contract: OperationContract<S>,
  body: unknown,
  requestId: string,
): z.infer<S> & Record<string, unknown> {
  return parseRest(contract, {
    id: requestId,
    params: {},
    query: {},
    headers: {},
    body,
  } as unknown as FastifyRequest);
}

/** Непустой массив непустых строк (parseAnchorIds прежних роутов). */
export const AnchorIdsSchema = z.array(z.string().min(1)).min(1);

/** Максимальный размер inline-иконки (256 КиБ, 08-ui-spec.md §6.8). */
export const ICON_MAX_BYTES = 256 * 1024;

/** Проверка image-иконки (data:image URL в лимите) — канонические сообщения. */
export function assertImageIcon(icon: string | null | undefined, requestId?: string): void {
  if (icon === undefined || icon === null || icon === '') return;
  if (/^https?:\/\//i.test(icon)) return;
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i.exec(icon);
  if (match === null) {
    throw new EtnError('VALIDATION_ERROR', 'icon должен быть data:image URL или http(s) URL.', { field: 'icon' }, requestId);
  }
  const b64 = match[1] ?? '';
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((b64.length * 3) / 4) - padding;
  if (bytes > ICON_MAX_BYTES) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Файл иконки слишком большой (${bytes} байт; лимит ${ICON_MAX_BYTES}).`,
      { field: 'icon', limit: ICON_MAX_BYTES },
      requestId,
    );
  }
}

/** Тело POST /thoughts. */
export const RestThoughtCreateBody = defineContract(
  'rest:thoughts.create-body',
  z.object({
    title: z.string().min(1),
    synonyms: z.union([z.string(), z.array(z.string())]).optional(),
    type_id: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    icon_kind: z.enum(ICON_KINDS).optional(),
    icon_color: z.string().nullable().optional(),
    active: z.boolean().optional(),
    fg_color: z.string().nullable().optional(),
    bg_color: z.string().nullable().optional(),
    font_bold: z.boolean().optional(),
    font_italic: z.boolean().optional(),
    font_underline: z.boolean().optional(),
    font_strike: z.boolean().optional(),
  })
    // Вид иконки `icon`: имя обязано быть в каталоге Lucide (задача 610a440e).
    .refine(libraryIconValid, { message: LIBRARY_ICON_MESSAGE, path: ['icon'] })
    .refine(iconColorValid, { message: ICON_COLOR_MESSAGE, path: ['icon_color'] }),
  {
    title: { from: { kind: 'body' }, msg: 'title обязателен и не может быть пустым.' },
    synonyms: { from: { kind: 'body' } },
    type_id: { from: { kind: 'body' } },
    icon: { from: { kind: 'body' } },
    icon_kind: { from: { kind: 'body' } },
    icon_color: { from: { kind: 'body' } },
    active: { from: { kind: 'body' } },
    fg_color: { from: { kind: 'body' } },
    bg_color: { from: { kind: 'body' } },
    font_bold: { from: { kind: 'body' } },
    font_italic: { from: { kind: 'body' } },
    font_underline: { from: { kind: 'body' } },
    font_strike: { from: { kind: 'body' } },
    create_link: {
      from: { kind: 'body' },
      parse: (raw: unknown, requestId: string) => {
        if (raw === undefined) return undefined;
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new EtnError('VALIDATION_ERROR', 'create_link должен быть объектом.', { field: 'create_link' }, requestId);
        }
        const cl = raw as Record<string, unknown>;
        const direction = cl['direction'];
        if (direction !== 'parent' && direction !== 'child') {
          throw new EtnError(
            'VALIDATION_ERROR',
            'create_link.direction должен быть "parent" или "child".',
            { field: 'create_link.direction' },
            requestId,
          );
        }
        const targetThoughtId = cl['target_thought_id'];
        if (typeof targetThoughtId !== 'string' || targetThoughtId === '') {
          throw new EtnError(
            'VALIDATION_ERROR',
            'create_link.target_thought_id обязателен.',
            { field: 'create_link.target_thought_id' },
            requestId,
          );
        }
        return {
          direction,
          target_thought_id: targetThoughtId,
          type_id: typeof cl['type_id'] === 'string' ? cl['type_id'] : null,
        };
      },
    },
    // Постоянный комментарий, создаваемый вместе с мыслью (0.12.1, задача
    // aa79c82d): `comment { body_md }`. Один запрос — одна транзакция,
    // разбирается наравне с `create_link` (поле вне общей zod-схемы).
    comment: {
      from: { kind: 'body' },
      parse: (raw: unknown, requestId: string) => {
        if (raw === undefined) return undefined;
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new EtnError('VALIDATION_ERROR', 'comment должен быть объектом.', { field: 'comment' }, requestId);
        }
        const c = raw as Record<string, unknown>;
        const bodyMd = c['body_md'];
        if (typeof bodyMd !== 'string' || bodyMd.trim() === '') {
          throw new EtnError(
            'VALIDATION_ERROR',
            'comment.body_md обязателен и не может быть пустым.',
            { field: 'comment.body_md' },
            requestId,
          );
        }
        return { body_md: bodyMd };
      },
    },
  },
);

/** Тело PATCH /thoughts/:id. */
export const RestThoughtUpdateBody = defineContract(
  'rest:thoughts.update-body',
  z.object({
    title: z.string().min(1).optional(),
    synonyms: z.union([z.string(), z.array(z.string())]).optional(),
    type_id: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    icon_kind: z.enum(ICON_KINDS).optional(),
    icon_color: z.string().nullable().optional(),
    icon_attachment_id: z.string().nullable().optional(),
    active: z.boolean().optional(),
    marked_for_deletion: z.boolean().optional(),
    fg_color: z.string().nullable().optional(),
    bg_color: z.string().nullable().optional(),
    font_bold: z.boolean().nullable().optional(),
    font_italic: z.boolean().nullable().optional(),
    font_underline: z.boolean().nullable().optional(),
    font_strike: z.boolean().nullable().optional(),
  })
    // Вид иконки `icon`: имя обязано быть в каталоге Lucide (задача 610a440e).
    .refine(libraryIconValid, { message: LIBRARY_ICON_MESSAGE, path: ['icon'] })
    .refine(iconColorValid, { message: ICON_COLOR_MESSAGE, path: ['icon_color'] }),
  {
    title: { from: { kind: 'body' } },
    synonyms: { from: { kind: 'body' } },
    type_id: { from: { kind: 'body' } },
    icon: { from: { kind: 'body' } },
    icon_kind: { from: { kind: 'body' } },
    icon_color: { from: { kind: 'body' } },
    icon_attachment_id: { from: { kind: 'body' } },
    active: { from: { kind: 'body' } },
    marked_for_deletion: { from: { kind: 'body' } },
    fg_color: { from: { kind: 'body' } },
    bg_color: { from: { kind: 'body' } },
    font_bold: { from: { kind: 'body' } },
    font_italic: { from: { kind: 'body' } },
    font_underline: { from: { kind: 'body' } },
    font_strike: { from: { kind: 'body' } },
  },
);

/** Тело POST /thoughts/copy-batch. */
export const RestThoughtCopyBody = defineContract(
  'rest:thoughts.copy-body',
  z.object({
    source_network_id: z.string().min(1),
    parent_thought_id: z.string().min(1),
  }),
  {
    source_network_id: {
      from: { kind: 'body' },
      msg: 'source_network_id обязателен и не может быть пустым.',
    },
    parent_thought_id: {
      from: { kind: 'body' },
      msg: 'parent_thought_id обязателен и не может быть пустым.',
    },
    thoughts: {
      from: { kind: 'body' },
      parse: (raw: unknown, requestId: string) => {
        if (!Array.isArray(raw) || raw.length === 0) {
          throw new EtnError('VALIDATION_ERROR', 'thoughts должен быть непустым массивом снимков мыслей.', { field: 'thoughts' }, requestId);
        }
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return raw.map((it, idx) => {
          if (typeof it !== 'object' || it === null || Array.isArray(it)) {
            throw new EtnError('VALIDATION_ERROR', `thoughts[${idx}] должен быть объектом.`, { field: `thoughts[${idx}]` }, requestId);
          }
          const item = it as Record<string, unknown>;
          if (
            item['source_id'] !== undefined &&
            item['source_id'] !== null &&
            item['source_id'] !== '' &&
            (typeof item['source_id'] !== 'string' || !UUID_RE.test(item['source_id'] as string))
          ) {
            throw new EtnError('VALIDATION_ERROR', `thoughts[${idx}].source_id должен быть UUID-строкой.`, { field: `thoughts[${idx}].source_id` }, requestId);
          }
          return item;
        });
      },
      req: true,
    },
    links: {
      from: { kind: 'body' },
      parse: (raw: unknown, requestId: string) => {
        if (raw === undefined) return undefined;
        if (!Array.isArray(raw)) {
          throw new EtnError('VALIDATION_ERROR', 'links должен быть массивом.', { field: 'links' }, requestId);
        }
        return raw.map((it, idx) => {
          if (typeof it !== 'object' || it === null || Array.isArray(it)) {
          
            throw new EtnError('VALIDATION_ERROR', `links[${idx}] должен быть объектом.`, { field: `links[${idx}]` }, requestId);
          }
          return it;
        });
      },
    },
  },
);

/** Общий контракт заголовка If-Match (expected_version). */
export const RestIfMatch = defineContract(
  'rest:if-match',
  z.object({ expected_version: z.number().int().min(1).optional() }),
  {
    expected_version: {
      from: { kind: 'header', name: 'If-Match', int: true },
      msg: 'Заголовок If-Match должен содержать целую версию.',
    },
  },
);

/** Тело focus-переопределения (show_inactive / show_trash). */
export const RestFocusBody = defineContract(
  'rest:thoughts.focus-body',
  z.object({ show_inactive: z.boolean().optional(), show_trash: z.boolean().optional() }),
  {
    show_inactive: { from: { kind: 'body' } },
    show_trash: { from: { kind: 'body' } },
  },
);

/** Тело { ids: string[] } для пакетных операций. */
export const RestIdsBody = defineContract(
  'rest:ids-body',
  z.object({}),
  {
    ids: {
      from: { kind: 'body' },
      t: z.array(z.string().min(1)).min(1),
      req: true,
      msg: 'ids обязателен (непустой массив строк).',
    },
  },
);

/** Query GET /networks/:id/thoughts/:id/neighbors (сообщения — прежние). */
export const RestNeighborsQuery = defineContract(
  'rest:thoughts.neighbors-query',
  z.object({
    network_id: NetworkId,
    dir: z.string().min(1),
    sort: z.string().optional(),
    order: z.string().optional(),
    type_id: z.string().optional(),
    show_inactive: z.boolean().optional(),
    show_trash: z.boolean().optional(),
    limit: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    dir: {
      from: { kind: 'query' },
      msg: 'dir обязателен (parents|children|siblings).',
    },
    sort: {
      from: { kind: 'query' },
      t: z.string().optional(),
      check: (v: unknown) =>
        typeof v === 'string' && !(SORT_KINDS as readonly string[]).includes(v) ? 'Недопустимый sort.' : null,
    },
    order: {
      from: { kind: 'query' },
      t: z.string().optional(),
      check: (v: unknown) =>
        typeof v === 'string' && !(SORT_ORDERS as readonly string[]).includes(v) ? 'Недопустимый order.' : null,
    },
    type_id: { from: { kind: 'query' }, t: z.string().optional() },
    show_inactive: { from: { kind: 'query', coerce: 'bool' }, t: z.boolean().optional() },
    show_trash: { from: { kind: 'query', coerce: 'bool' }, t: z.boolean().optional() },
    limit: { from: { kind: 'query', coerce: 'int', min: 1 } },
    offset: { from: { kind: 'query', coerce: 'int', min: 0 } },
  },
);

/** Тело resolve (ids может быть пустым) и focus-операций. */
export const RestResolveIdsBody = defineContract(
  'rest:thoughts.resolve-body',
  z.object({}),
  {
    ids: {
      from: { kind: 'body' },
      t: z.array(z.string()),
      req: true,
      msg: 'ids обязателен (массив строк).',
    },
  },
);

export const RestFocusPrefsBody = defineContract(
  'rest:thoughts.focus-prefs-body',
  z.object({ dir: z.string().min(1), sort: z.string().min(1), order: z.string().min(1) }),
  {
    dir: { from: { kind: 'body' }, msg: 'dir, sort и order обязательны.' },
    sort: { from: { kind: 'body' }, msg: 'dir, sort и order обязательны.' },
    order: { from: { kind: 'body' }, msg: 'dir, sort и order обязательны.' },
  },
);

export const RestFocusOrderBody = defineContract(
  'rest:thoughts.focus-order-body',
  z.object({ dir: z.string().min(1) }),
  {
    dir: { from: { kind: 'body' }, msg: 'dir и ordered_ids обязательны.' },
    ordered_ids: {
      from: { kind: 'body' },
      t: z.array(z.string().min(1)).min(1),
      req: true,
      msg: 'dir и ordered_ids обязательны.',
    },
  },
);

// ---------------------------------------------------------------------------
// Хвост вехи 8 (приёмка c9d5f21e): типы, отборы, свойства, структуры, админ
// ---------------------------------------------------------------------------

/** CSV-список query-параметра → массив id (parseExcludeIds прежнего роута). */
export function csvToList(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** PATCH /admin/networks/:id/members/:uid — принудительная роль. */
export const RestAdminMemberRole = defineContract(
  'rest:admin.member-role',
  z.object({
    id: z.string().min(1),
    uid: z.string().min(1),
    role: z.enum(['owner', 'member']),
  }),
  {
    id: { from: { kind: 'param' } },
    uid: { from: { kind: 'param' } },
    role: { from: { kind: 'body' }, msg: 'role должен быть owner или member.' },
  },
);

/** DELETE /networks/:id/thought-types/:tid — ?force. */
export const RestForceQuery = defineContract(
  'rest:types.force-query',
  z.object({ force: z.boolean().optional() }),
  { force: { from: { kind: 'query', coerce: 'bool' } } },
);

/** { ordered_ids: string[] } — переупорядочивание привязок. */
export const RestOrderedIdsBody = defineContract(
  'rest:ordered-ids-body',
  z.object({}),
  {
    ordered_ids: {
      from: { kind: 'body' },
      t: z.array(z.string()),
      req: true,
      msg: 'ordered_ids обязателен (массив строк).',
    },
  },
);

/** { description: string|null } — override описания привязки. */
export const RestDescriptionOverrideBody = defineContract(
  'rest:description-override-body',
  z.object({ description: z.string().nullable() }),
  {
    description: {
      from: { kind: 'body' },
      msg: 'description обязателен (текст или null).',
    },
  },
);

/** Тело POST /thought-types (сообщения — канон схемы, как у MCP ontology). */
export const RestThoughtTypeCreateBody = defineContract(
  'rest:thought-types.create-body',
  z.object({
    name: z.string().min(1),
    parent_id: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    icon_kind: z.enum(ICON_KINDS).optional(),
    icon_color: z.string().nullable().optional(),
    fg_color: z.string().nullable().optional(),
    bg_color: z.string().nullable().optional(),
    font_bold: z.boolean().nullable().optional(),
    font_italic: z.boolean().nullable().optional(),
    font_underline: z.boolean().nullable().optional(),
    font_strike: z.boolean().nullable().optional(),
    description: z.string().nullable().optional(),
    comment_template_md: z.string().nullable().optional(),
  })
    // Вид иконки `icon`: имя обязано быть в каталоге Lucide (задача 610a440e).
    .refine(libraryIconValid, { message: LIBRARY_ICON_MESSAGE, path: ['icon'] })
    .refine(iconColorValid, { message: ICON_COLOR_MESSAGE, path: ['icon_color'] }),
  {
    name: { from: { kind: 'body' }, msg: 'name обязателен и не может быть пустым.' },
    parent_id: {
      from: { kind: 'body' },
      parse: (raw: unknown) => (raw === '' ? null : raw),
    },
    icon: { from: { kind: 'body' } },
    icon_kind: { from: { kind: 'body' } },
    icon_color: { from: { kind: 'body' } },
    fg_color: { from: { kind: 'body' } },
    bg_color: { from: { kind: 'body' } },
    font_bold: { from: { kind: 'body' } },
    font_italic: { from: { kind: 'body' } },
    font_underline: { from: { kind: 'body' } },
    font_strike: { from: { kind: 'body' } },
    description: { from: { kind: 'body' } },
    comment_template_md: { from: { kind: 'body' } },
  },
);

/** Тело PATCH /thought-types/:id. */
export const RestThoughtTypeUpdateBody = defineContract(
  'rest:thought-types.update-body',
  z.object({
    name: z.string().min(1).optional(),
    parent_id: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    icon_kind: z.enum(ICON_KINDS).optional(),
    icon_color: z.string().nullable().optional(),
    fg_color: z.string().nullable().optional(),
    bg_color: z.string().nullable().optional(),
    font_bold: z.boolean().nullable().optional(),
    font_italic: z.boolean().nullable().optional(),
    font_underline: z.boolean().nullable().optional(),
    font_strike: z.boolean().nullable().optional(),
    description: z.string().nullable().optional(),
    comment_template_md: z.string().nullable().optional(),
    // 0.8.2, задача 8ea1ab6a: флаг подтверждения смены parent_id. Первый
    // PATCH с реальной сменой у используемого типа возвращает 422 с details
    // { kind: 'reparent_impact', thoughts_count, requires_confirmation: true };
    // повторный PATCH с `confirmed: true` выполняет правку. Без `parent_id`
    // флаг игнорируется.
    confirmed: z.boolean().optional(),
  })
    // Вид иконки `icon`: имя обязано быть в каталоге Lucide (задача 610a440e).
    .refine(libraryIconValid, { message: LIBRARY_ICON_MESSAGE, path: ['icon'] })
    .refine(iconColorValid, { message: ICON_COLOR_MESSAGE, path: ['icon_color'] }),
  {
    name: { from: { kind: 'body' } },
    parent_id: { from: { kind: 'body' }, parse: (raw: unknown) => (raw === '' ? null : raw) },
    icon: { from: { kind: 'body' } },
    icon_kind: { from: { kind: 'body' } },
    icon_color: { from: { kind: 'body' } },
    fg_color: { from: { kind: 'body' } },
    bg_color: { from: { kind: 'body' } },
    font_bold: { from: { kind: 'body' } },
    font_italic: { from: { kind: 'body' } },
    font_underline: { from: { kind: 'body' } },
    font_strike: { from: { kind: 'body' } },
    description: { from: { kind: 'body' } },
    comment_template_md: { from: { kind: 'body' } },
    confirmed: { from: { kind: 'body' } },
  },
);

/** Тело PATCH /link-types/:id (имена не меняются — только свойство-связь). */
export const RestLinkTypeUpdateBody = defineContract(
  'rest:link-types.update-body',
  z.object({
    parent_id: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    style: z.enum(LINK_STYLES).nullable().optional(),
    width: z.number().nullable().optional(),
  }),
  {
    parent_id: { from: { kind: 'body' }, parse: (raw: unknown) => (raw === '' ? null : raw) },
    color: { from: { kind: 'body' } },
    style: { from: { kind: 'body' } },
    width: { from: { kind: 'body' } },
    name_forward: {
      from: { kind: 'body' },
      t: z.string().optional(),
      check: () =>
        'PATCH /link-types/{id} не меняет имена — редактируйте свойство-связь (PATCH /networks/{nid}/properties/{id}).',
    },
    name_reverse: {
      from: { kind: 'body' },
      t: z.string().optional(),
      check: () =>
        'PATCH /link-types/{id} не меняет имена — редактируйте свойство-связь (PATCH /networks/{nid}/properties/{id}).',
    },
  },
);

/** Тело POST …/types/:id/properties — двухформенная привязка (attach/create). */
export const RestAttachBody = defineContract(
  'rest:types.attach-body',
  z.object({}),
  {
    required: { from: { kind: 'body' }, t: z.boolean().optional() },
    position: {
      from: { kind: 'body' },
      t: z.number().int().optional(),
      parse: (raw: unknown) => (typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : undefined),
    },
    side: {
      from: { kind: 'body' },
      t: z.enum(['source', 'target']).nullable().optional(),
      msg: 'side должен быть одним из: source, target или null.',
    },
    property_id: {
      from: { kind: 'body' },
      t: z.string().optional(),
      check: (v: unknown) =>
        v !== undefined && (typeof v !== 'string' || v.trim() === '')
          ? 'property_id должен быть непустой строкой.'
          : null,
    },
    key: { from: { kind: 'body' }, t: z.string().optional() },
    value_type: { from: { kind: 'body' }, t: z.enum(PROPERTY_VALUE_TYPES).optional() },
    config: { from: { kind: 'body' }, t: z.unknown().optional() },
    description: { from: { kind: 'body' }, t: z.string().nullable().optional() },
  },
);

/** Тело PATCH …/types/{id}/properties/{propertyId} — роль привязки в типе. */
export const RestTypePropertyUpdateBody = defineContract(
  'rest:types.type-property-update-body',
  z.object({}),
  {
    required: { from: { kind: 'body' }, t: z.boolean().optional() },
    position: {
      from: { kind: 'body' },
      t: z.number().int().optional(),
      parse: (raw: unknown) => (typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : undefined),
    },
    side: {
      from: { kind: 'body' },
      t: z.enum(['source', 'target']).nullable().optional(),
      msg: 'side должен быть одним из: source, target или null.',
    },
    allowed_target_type_ids: {
      from: { kind: 'body' },
      t: z.array(z.string().min(1)).nullable().optional(),
      msg: 'allowed_target_type_ids должен быть массивом id или null.',
    },
    allowed_source_type_ids: {
      from: { kind: 'body' },
      t: z.array(z.string().min(1)).nullable().optional(),
      msg: 'allowed_source_type_ids должен быть массивом id или null.',
    },
  },
);

/** Тело POST /thought-types/{id}/views (лишние ключи — strict-схема). */
export const RestViewCreateBody = defineContract(
  'rest:views.create-body',
  z
    .object({
      name: z.string().min(1),
      description: z.string().nullable().optional(),
      definition: z.string().min(1),
      position: z.number().int().min(0).optional(),
      is_default: z.boolean().optional(),
    })
    .strict(),
  {
    name: { from: { kind: 'body' }, msg: 'name обязателен и не может быть пустым.' },
    description: { from: { kind: 'body' } },
    definition: { from: { kind: 'body' }, msg: 'definition обязателен.' },
    position: { from: { kind: 'body' } },
    is_default: { from: { kind: 'body' } },
  },
);

/** Тело PATCH /thought-types/{id}/views/{viewId}. */
export const RestViewUpdateBody = defineContract(
  'rest:views.update-body',
  z
    .object({
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      definition: z.string().min(1).optional(),
      position: z.number().int().min(0).optional(),
      is_default: z.boolean().optional(),
    })
    .strict(),
  {
    name: { from: { kind: 'body' }, msg: 'name не может быть пустым.' },
    description: { from: { kind: 'body' } },
    definition: { from: { kind: 'body' }, msg: 'definition не может быть пустым.' },
    position: { from: { kind: 'body' } },
    is_default: { from: { kind: 'body' } },
  },
);

/** Тело POST /thoughts/{id}/views/{view}/run — переопределения сортировки. */
export const RestViewRunBody = defineContract(
  'rest:views.run-body',
  z.object({
    sort: z.enum(STRUCTURE_SORTS).optional(),
    order: z.enum(SORT_ORDERS).optional(),
    limit: z.number().int().min(1).max(STRUCTURES_QUERY_MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  {
    sort: { from: { kind: 'body' }, msg: 'Недопустимый sort.' },
    order: { from: { kind: 'body' }, msg: 'Недопустимый order.' },
    limit: { from: { kind: 'body' } },
    offset: { from: { kind: 'body' } },
  },
);

/**
 * Разбор query-параметра `link_filter` у `GET /thoughts/:id/hierarchy`
 * (ошибка db504c1a): значение — JSON-объект `{ type_ids?, include_structural? }`,
 * та же форма, что у одноимённого поля тела `POST /thoughts/query`, и та же
 * валидация (`parseLinkTypeFilterValue`). Так фильтр обхода доезжает до
 * раскрытия ветви дерева и раскрытая ветвь не расходится с отбором.
 */
function parseRestLinkFilter(raw: unknown, requestId: string): LinkTypeFilterInput | undefined {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string' || first === '') return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(first);
  } catch {
    throw new EtnError(
      'VALIDATION_ERROR',
      'link_filter должен быть JSON-объектом { type_ids?: string[], include_structural?: boolean }.',
      { field: 'link_filter' },
      requestId,
    );
  }
  return parseLinkTypeFilterValue(decoded, requestId);
}

/** GET /networks/:id/thoughts/:id/hierarchy — dir/show_inactive/show_trash/offset/link_filter. */
export const RestHierarchyQuery = defineContract(
  'rest:structures.hierarchy-query',
  z.object({
    network_id: NetworkId,
    thought_id: z.string().min(1),
    dir: z.enum(['parents', 'children']),
    show_inactive: z.boolean().optional(),
    show_trash: z.boolean().optional(),
    offset: z.number().int().min(0).optional(),
    link_filter: LinkFilter,
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    thought_id: { from: { kind: 'param', name: 'id' } },
    dir: { from: { kind: 'query' }, msg: 'dir должен быть parents или children.' },
    show_inactive: { from: { kind: 'query', coerce: 'bool' } },
    show_trash: { from: { kind: 'query', coerce: 'bool' } },
    offset: {
      from: { kind: 'query' },
      parse: (raw: unknown) => {
        const first = Array.isArray(raw) ? raw[0] : raw;
        if (typeof first === 'string' && first !== '' && Number.isInteger(Number(first))) {
          return Math.max(0, Number(first));
        }
        return undefined;
      },
    },
    link_filter: {
      from: { kind: 'query' },
      parse: parseRestLinkFilter,
      msg: 'link_filter должен быть JSON-объектом { type_ids?: string[], include_structural?: boolean }.',
    },
  },
);

/** Тело POST /thoughts/edges — { ids, show_inactive, show_trash, link_filter } (+ network_id из params). */
export const RestEdgesBody = defineContract(
  'rest:structures.edges-body',
  z.object({
    network_id: NetworkId,
    ids: z.array(z.string()).min(1),
    show_inactive: z.boolean().optional(),
    show_trash: z.boolean().optional(),
    link_filter: LinkFilter,
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    ids: { from: { kind: 'body' }, msg: 'ids должен быть массивом строк.' },
    show_inactive: { from: { kind: 'body' } },
    show_trash: { from: { kind: 'body' } },
    link_filter: { from: { kind: 'body' } },
  },
);

/** Тело POST /saved-filters — { view?, name, definition }. */
export const RestSavedFilterCreateBody = defineContract(
  'rest:structures.saved-filter-create-body',
  z.object({
    // `view` необязателен: по спецификации (операция API `/saved-filters`)
    // значение по умолчанию — `structures`. Обязательность расходилась с
    // чтением (GET `view?`) и отбивала запись клиенту без явного вида.
    view: z.enum(SAVED_FILTER_VIEWS).optional(),
    name: z.string().min(1),
  }),
  {
    view: { from: { kind: 'body' }, msg: 'Недопустимый view.' },
    name: { from: { kind: 'body' }, msg: 'name обязателен.' },
    definition: {
      from: { kind: 'body' },
      t: z.object({}).catchall(z.unknown()),
      req: true,
      msg: 'definition обязателен.',
    },
  },
);

/** Тело PATCH /saved-filters/:fid. */
export const RestSavedFilterPatchBody = defineContract(
  'rest:structures.saved-filter-patch-body',
  z.object({
    view: z.enum(SAVED_FILTER_VIEWS).optional(),
    name: z.string().min(1).optional(),
  }),
  {
    view: { from: { kind: 'body' }, msg: 'Недопустимый view.' },
    name: { from: { kind: 'body' }, msg: 'name обязателен.' },
    definition: { from: { kind: 'body' }, t: z.object({}).catchall(z.unknown()), msg: 'definition должен быть объектом.' },
  },
);

/** GET /saved-filters — ?view. */
export const RestSavedFilterViewQuery = defineContract(
  'rest:structures.saved-filter-view-query',
  z.object({ view: z.enum(SAVED_FILTER_VIEWS).optional() }),
  {
    view: {
      from: { kind: 'query' },
      msg: 'Недопустимый view.',
      parse: (raw: unknown) => (raw === undefined || raw === null || raw === '' ? undefined : raw),
    },
  },
);

/** Обёртка тела POST /thoughts/query (фильтр парсит parseStructureFilter из
 *  shared — делегат в роуте). */
export const RestStructureQueryBody = defineContract(
  'rest:structures.query-body',
  z
    .object({
      keywords: z.unknown().optional(),
      keyword_scope: z.unknown().optional(),
      parent_ids: z.unknown().optional(),
      type_ids: z.unknown().optional(),
      link_type_ids: z.unknown().optional(),
      link_filter: z.unknown().optional(),
      show_inactive: z.unknown().optional(),
      has_properties: z.unknown().optional(),
      has_comment: z.unknown().optional(),
      has_attachments: z.unknown().optional(),
      has_chronology: z.unknown().optional(),
      active: z.unknown().optional(),
      trashed: z.unknown().optional(),
      properties: z.unknown().optional(),
      created_by: z.unknown().optional(),
      updated_by: z.unknown().optional(),
      created_after: z.unknown().optional(),
      created_before: z.unknown().optional(),
      updated_after: z.unknown().optional(),
      updated_before: z.unknown().optional(),
      sort: z.enum(STRUCTURE_SORTS).optional(),
      order: z.enum(SORT_ORDERS).optional(),
      ids_only: z.boolean().optional(),
      limit: z.number().int().optional(),
      offset: z.number().int().optional(),
      // Требование 5adebf61: COUNT только по явному флагу; требование
      // 3f2fdc41: keyset-курсор продолжения страницы.
      count: z.boolean().optional(),
      cursor: z.string().min(1).optional(),
      // Задача eb1a3f43, требование c98d5d19: веерный режим — массив
      // дополнительных сетей для fan-out. Опциональный — если передан,
      // `:networkId` в пути интерпретируется как одна из сетей, а не как
      // единственная. Взаимоисключающе с `:networkId` (валидируется в роуте).
      network_ids: z.array(NetworkId).optional(),
    })
    .strict(),
  {
    sort: { from: { kind: 'body' }, msg: 'Недопустимый sort.' },
    order: { from: { kind: 'body' }, msg: 'Недопустимый order.' },
    // REST-only поле (в общей схеме отсутствует): переопределение видимости
    // помеченных на удаление для `meta.directions` (ошибка 331ffb94) — тем же
    // путём, что `show_trash` у фокуса/иерархии/рёбер (задача 77923b49).
    show_trash: { from: { kind: 'body' }, t: z.boolean().optional(), msg: 'show_trash должен быть boolean.' },
    ids_only: { from: { kind: 'body' } },
    limit: { from: { kind: 'body' } },
    offset: { from: { kind: 'body' } },
    count: { from: { kind: 'body' } },
    cursor: { from: { kind: 'body' } },
    network_ids: { from: { kind: 'body' }, t: z.array(NetworkId).min(1).optional() },
  },
);

/** Тело POST /properties (справочник) — full-форма с link-полями (0.8.1). */
export const RestPropertyCreateBody = defineContract(
  'rest:properties-registry.create-body',
  z.strictObject({
    name: z.string().min(1),
    value_type: z.enum(PROPERTY_VALUE_TYPES),
    config: z.unknown().optional(),
    description: z.string().nullable().optional(),
    name_forward: z.string().optional(),
    name_reverse: z.string().optional(),
    parent_link_type_id: z.string().nullable().optional(),
    link_color: z.string().nullable().optional(),
    link_style: z.enum(LINK_STYLES).nullable().optional(),
    link_width: z.number().nullable().optional(),
  }),
  {
    name: { from: { kind: 'body' }, msg: 'name обязателен и не может быть пустым.' },
    value_type: {
      from: { kind: 'body' },
      msg: 'value_type обязателен и должен быть одним из поддерживаемых.',
      check: (v: unknown, all: Record<string, unknown>) => {
        const linkFields = [
          'name_forward',
          'name_reverse',
          'parent_link_type_id',
          'link_color',
          'link_style',
          'link_width',
        ].some((k) => all[k] !== undefined);
        return linkFields && v !== 'link'
          ? 'name_forward/name_reverse/parent_link_type_id/link_color/link_style/link_width применимы только к value_type="link".'
          : null;
      },
    },
    config: { from: { kind: 'body' } },
    description: { from: { kind: 'body' } },
    name_forward: {
      from: { kind: 'body' },
      msg: 'name_forward должен быть непустой строкой.',
      check: (v: unknown) => (typeof v === 'string' && v.trim() === '' ? 'name_forward должен быть непустой строкой.' : null),
    },
    name_reverse: {
      from: { kind: 'body' },
      msg: 'name_reverse должен быть непустой строкой.',
      check: (v: unknown) => (typeof v === 'string' && v.trim() === '' ? 'name_reverse должен быть непустой строкой.' : null),
    },
    parent_link_type_id: { from: { kind: 'body' } },
    link_color: { from: { kind: 'body' } },
    link_style: { from: { kind: 'body' }, msg: 'Недопустимый link_style.' },
    link_width: { from: { kind: 'body' }, msg: 'link_width должен быть числом или null.' },
  },
);

/** Тело PATCH /properties/{id} (справочник). */
export const RestPropertyUpdateBody = defineContract(
  'rest:properties-registry.update-body',
  z.strictObject({
    name: z.string().min(1).optional(),
    value_type: z.enum(PROPERTY_VALUE_TYPES).optional(),
    config: z.unknown().optional(),
    description: z.string().nullable().optional(),
    name_forward: z.string().min(1).optional(),
    name_reverse: z.string().min(1).optional(),
    link_color: z.string().nullable().optional(),
    link_style: z.enum(LINK_STYLES).nullable().optional(),
    link_width: z.number().nullable().optional(),
  }),
  {
    name: { from: { kind: 'body' }, msg: 'name должен быть непустой строкой.' },
    value_type: {
      from: { kind: 'body' },
      msg: 'value_type должен быть одним из поддерживаемых.',
    },
    config: { from: { kind: 'body' } },
    description: { from: { kind: 'body' } },
    name_forward: { from: { kind: 'body' }, msg: 'name_forward должен быть непустой строкой.' },
    name_reverse: { from: { kind: 'body' }, msg: 'name_reverse должен быть непустой строкой.' },
    link_color: { from: { kind: 'body' }, msg: 'link_color должен быть строкой или null.' },
    link_style: { from: { kind: 'body' }, msg: 'Недопустимый link_style.' },
    link_width: { from: { kind: 'body' }, msg: 'link_width должен быть числом или null.' },
  },
);

// ---------------------------------------------------------------------------
// Контракт reader-пула (ADR bec191e6, тех.проект e29c0f00 этап 2)
// ---------------------------------------------------------------------------

/**
 * DTO запроса/ответа reader-воркера (ADR bec191e6 «Тяжёлые чтения выполняются
 * в пуле reader-соединений worker_threads»).
 *
 * Воркер не знает о состоянии сессии: всё, что ему нужно для чтения, приходит
 * {@link ReaderTaskContext} — файл БД, сеть, слой и версия схемы. «Версия
 * схемы» (`PRAGMA schema_version` соединения главного потока) — маркер
 * инвалидации: сменилась — воркер переоткрывает своё соединение. Смена слоя
 * едет в {@link ReaderTaskContext.layerId} и перестраивает temp-цепочку слоя
 * на соединении воркера.
 *
 * Ответ — плоский structured-clone DTO: `Map`/функции/классы не пересекают
 * границу потока, поэтому `depths` передаётся массивом пар.
 */
export interface ReaderTaskContext {
  /** Абсолютный путь к `data.db` сети (воркер открывает своё read-only соединение). */
  dbPath: string;
  /** Логический id сети — диагностика/лог. */
  networkId: string;
  /** Контекст слоя: `*_v` резолвятся по цепочке предков этого слоя. */
  layerId: string;
  /** `PRAGMA schema_version` — инвалидация соединений воркера при смене схемы. */
  schemaVersion: number;
}

/** Имена операций, исполняемых reader-воркером. Только чтение. */
export type ReaderOp = 'thoughts.query' | 'thoughts.queryIds' | 'search.query' | 'graph.subgraph';

/** Payload `thoughts.query` / `thoughts.queryIds`. */
export interface ReaderThoughtsQueryPayload {
  userId: string;
  request: ThoughtQueryRequest;
  options: ThoughtQueryOptions;
}

/** Payload `search.query`. */
export interface ReaderSearchPayload {
  request: SearchRequest;
  showInactiveDefault: boolean;
}

/** Payload `graph.subgraph` — радиус-ограниченный подграф вокруг семян. */
export interface ReaderSubgraphPayload {
  seedIds: string[];
  radius: number;
  bounds: TraversalBounds;
}

/** Результат `graph.subgraph`. */
export interface ReaderSubgraphResult {
  nodes: string[];
  edges: SubgraphEdge[];
  truncated: boolean;
}

/** Одна задача reader-пула (op + payload, общий контекст). */
export type ReaderTask = { context: ReaderTaskContext } & (
  | { op: 'thoughts.query'; payload: ReaderThoughtsQueryPayload }
  | { op: 'thoughts.queryIds'; payload: ReaderThoughtsQueryPayload }
  | { op: 'search.query'; payload: ReaderSearchPayload }
  | { op: 'graph.subgraph'; payload: ReaderSubgraphPayload }
);

/** `depths` в плоском виде (Map не переживает structured clone). */
export interface ReaderDepthsEntry {
  id: string;
  depth: number;
}

/** Сериализованный результат `thoughts.query` (плоский `ThoughtQueryResult`). */
export interface ReaderThoughtsQueryResult {
  items: ThoughtRef[];
  /** `null` — COUNT не запрашивался явным флагом (требование 5adebf61). */
  total: number | null;
  has_more: boolean;
  next_cursor: string | null;
  directions: StructureDirectionFlags;
  depths: ReaderDepthsEntry[] | null;
  truncated: boolean;
  reason: 'max_nodes' | null;
}

/** Результат `thoughts.queryIds`. */
export interface ReaderThoughtsQueryIdsResult {
  ids: string[];
  total: number | null;
  has_more: boolean;
  next_cursor: string | null;
}

/** Успешный ответ воркера. `result` конкретизируется по `op` на стороне пула. */
export interface ReaderTaskOk {
  ok: true;
  result: unknown;
}

/** Ответ воркера с ошибкой: доменная ошибка сериализуется в плоский вид. */
export interface ReaderTaskFail {
  ok: false;
  error: { code: EtnErrorCode; message: string; details?: unknown };
}

/** Ответ reader-воркера. */
export type ReaderTaskResponse = ReaderTaskOk | ReaderTaskFail;

// ---------------------------------------------------------------------------
// Публикации (0.11.1, задача 8178e007; карточка CRUD 5af247e4)
// ---------------------------------------------------------------------------

/**
 * Объект рецепта заголовков — тот же формат, что `saved_filters.definition`
 * (отбор «Структур мыслей»). Домен и сборка разбирают его своими парсерами,
 * контракт проверяет только «объект или null».
 */
const PublicationTitleRecipe = z.record(z.string(), z.unknown()).nullable().optional();

/** Резюме публикации (markdown без заголовков — проверяется refine). */
const PublicationSummary = z.string().nullable().optional();

/** Общие поля тела публикации (создание и патч). */
const PublicationBodyShape = {
  title: z.string().min(1),
  subtitle: z.string().nullable().optional(),
  summary_md: PublicationSummary,
  authorship: z.string().nullable().optional(),
  cover_attachment_id: z.string().min(1).nullable().optional(),
  cover_url: z.string().min(1).nullable().optional(),
  title_recipe: PublicationTitleRecipe,
  text_sources: z.array(z.string().min(1)).optional(),
  extra_properties: z.array(z.string().min(1)).optional(),
  numbering_from: z.number().int().nullable().optional(),
  numbering_to: z.number().int().nullable().optional(),
};

/**
 * Межполевые правила публикации (единый источник — domain/publication-validation).
 * Вызывается из `.superRefine` обеих схем.
 */
function refinePublicationFields(
  value: {
    summary_md?: string | null;
    cover_attachment_id?: string | null;
    cover_url?: string | null;
    text_sources?: string[];
    extra_properties?: string[];
    numbering_from?: number | null;
    numbering_to?: number | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.summary_md != null && summaryHasMarkdownHeadings(value.summary_md)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['summary_md'],
      message: 'резюме не может содержать заголовки (markdown без заголовков)',
      params: { code: 'summary_headings_forbidden' },
    });
  }
  if (value.cover_attachment_id != null && value.cover_url != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cover_attachment_id'],
      message: 'только один источник обложки: вложение или URL',
      params: { code: 'cover_conflict' },
    });
  }
  const overlap = recipeOverlap(value.text_sources ?? [], value.extra_properties ?? []);
  if (overlap.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['text_sources'],
      message: 'свойства текстов и «дополнительных материалов» пересекаются',
      params: { code: 'recipe_overlap' },
    });
  }
  if (numberingRangeInvalid(value.numbering_from ?? null, value.numbering_to ?? null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['numbering_from'],
      message: 'numbering_from не может быть больше numbering_to',
      params: { code: 'numbering_range' },
    });
  }
}

/** Вход создания публикации (POST /publications). */
export const PublicationCreateFields = z
  .object(PublicationBodyShape)
  .strict()
  .superRefine(refinePublicationFields);
export type PublicationCreateFields = z.infer<typeof PublicationCreateFields>;

/** Вход патча публикации (PATCH /publications/{id}): все поля необязательны. */
export const PublicationUpdateFields = z
  .object({
    ...PublicationBodyShape,
    title: z.string().min(1).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .superRefine(refinePublicationFields);
export type PublicationUpdateFields = z.infer<typeof PublicationUpdateFields>;

/** Параметры списка публикаций (GET /publications). */
export const PublicationListFields = z
  .object({
    q: z.string().optional(),
    shelf: z.string().min(1).optional(),
    active: z.enum(PUBLICATION_ACTIVE_FILTERS).optional(),
    sort: z.enum(PUBLICATION_SORTS).optional(),
    include_trashed: z.boolean().optional(),
    limit: z.number().int().min(0).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();
export type PublicationListFields = z.infer<typeof PublicationListFields>;

/** Батч перестановок порядка (PUT /publications/{id}/order). */
export const PublicationOrderFields = z
  .object({
    items: z
      .array(
        z
          .object({ node_key: z.string().min(1), position: z.number() })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type PublicationOrderFields = z.infer<typeof PublicationOrderFields>;

/** Исключения мысли (POST/DELETE /publications/{id}/exclusions). */
export const PublicationExclusionFields = z.object({ thought_id: z.string().min(1) }).strict();
export type PublicationExclusionFields = z.infer<typeof PublicationExclusionFields>;

/** Вход создания/правки полки. */
export const ShelfFields = z
  .object({
    title: z.string().min(1).optional(),
    position: z.number().optional(),
  })
  .strict();
export type ShelfFields = z.infer<typeof ShelfFields>;

/** Элемент состава полки (POST/DELETE /shelves/{id}/items). */
export const ShelfItemFields = z
  .object({
    publication_id: z.string().min(1),
    position: z.number().optional(),
  })
  .strict();
export type ShelfItemFields = z.infer<typeof ShelfItemFields>;

// ---------------------------------------------------------------------------
// REST-контракты публикаций и полок (0.11.1, задача c59ce742; операции
// 5af247e4 CRUD, 200b87be жизненный цикл, 19d80dd2 сборка, f6b242fe порядок,
// 109061e0 исключения, f9a20c3f пересборка/кандидаты, f49c6420 использование,
// c80951ea полки)
//
// Поля схем объявлены ЛИТЕРАЛЬНО (не спредом *Fields): сторож
// guard-rest-contracts сверяет объявленность по тексту блока контракта, а
// `parseRest` читает только поля REST-карты. Межполевые правила публикации
// (резюме без заголовков, единственный источник обложки, непересечение
// рецептов, диапазон нумерации) проверяет домен (`publication-service`)
// штатными `VALIDATION_ERROR` с теми же кодами — дублировать refine здесь
// не нужно.
// ---------------------------------------------------------------------------

/** Общие REST-источники полей тела публикации. */
const publicationRestMap = {
  title: { from: { kind: 'body' } },
  subtitle: { from: { kind: 'body' } },
  summary_md: { from: { kind: 'body' } },
  authorship: { from: { kind: 'body' } },
  cover_attachment_id: { from: { kind: 'body' } },
  cover_url: { from: { kind: 'body' } },
  title_recipe: { from: { kind: 'body' } },
  text_sources: { from: { kind: 'body' } },
  extra_properties: { from: { kind: 'body' } },
  numbering_from: { from: { kind: 'body' } },
  numbering_to: { from: { kind: 'body' } },
} as const;

/** POST /networks/:id/publications — создание. */
export const RestPublicationCreate = defineContract(
  'rest:publications.create',
  z.object({
    network_id: NetworkId,
    title: z.string().min(1),
    subtitle: z.string().nullable().optional(),
    summary_md: z.string().nullable().optional(),
    authorship: z.string().nullable().optional(),
    cover_attachment_id: z.string().min(1).nullable().optional(),
    cover_url: z.string().min(1).nullable().optional(),
    title_recipe: z.record(z.string(), z.unknown()).nullable().optional(),
    text_sources: z.array(z.string().min(1)).optional(),
    extra_properties: z.array(z.string().min(1)).optional(),
    numbering_from: z.number().int().nullable().optional(),
    numbering_to: z.number().int().nullable().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    ...publicationRestMap,
  },
);

/** GET /networks/:id/publications — список. */
export const RestPublicationList = defineContract(
  'rest:publications.list',
  z.object({
    network_id: NetworkId,
    q: z.string().optional(),
    shelf: z.string().min(1).optional(),
    active: z.enum(PUBLICATION_ACTIVE_FILTERS).optional(),
    sort: z.enum(PUBLICATION_SORTS).optional(),
    include_trashed: z.boolean().optional(),
    limit: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    q: { from: { kind: 'query' }, parse: singleQueryValue },
    shelf: { from: { kind: 'query' }, parse: singleQueryValue },
    active: { from: { kind: 'query' }, parse: singleQueryValue },
    sort: { from: { kind: 'query' }, parse: singleQueryValue },
    include_trashed: { from: { kind: 'query', coerce: 'bool' } },
    limit: { from: { kind: 'query', coerce: 'int', min: 1 } },
    offset: { from: { kind: 'query', coerce: 'int', min: 0 } },
  },
);

/** GET /networks/:id/publications/{id} — карточка. */
export const RestPublicationById = defineContract(
  'rest:publications.by-id',
  z.object({ network_id: NetworkId, publication_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    publication_id: { from: { kind: 'param', name: 'id' } },
  },
);

/**
 * GET /networks/:id/publications/{id}/deletion-check — блокировки физического
 * удаления публикации (аналог `deletion-check` мысли, 03-server-api.md §6.5a).
 * Диалог удаления публикации решает по нему, доступно ли «Удалить совсем»
 * (задача 00160da1).
 */
export const RestPublicationDeletionCheck = defineContract(
  'rest:publications.deletion-check',
  z.object({ network_id: NetworkId, publication_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    publication_id: { from: { kind: 'param', name: 'id' } },
  },
);

/** PATCH /networks/:id/publications/{id} — правка настроек. */
export const RestPublicationUpdate = defineContract(
  'rest:publications.update',
  z.object({
    network_id: NetworkId,
    publication_id: z.string().min(1),
    title: z.string().min(1).optional(),
    subtitle: z.string().nullable().optional(),
    summary_md: z.string().nullable().optional(),
    authorship: z.string().nullable().optional(),
    cover_attachment_id: z.string().min(1).nullable().optional(),
    cover_url: z.string().min(1).nullable().optional(),
    title_recipe: z.record(z.string(), z.unknown()).nullable().optional(),
    text_sources: z.array(z.string().min(1)).optional(),
    extra_properties: z.array(z.string().min(1)).optional(),
    numbering_from: z.number().int().nullable().optional(),
    numbering_to: z.number().int().nullable().optional(),
    active: z.boolean().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    publication_id: { from: { kind: 'param', name: 'id' } },
    ...publicationRestMap,
    active: { from: { kind: 'body' } },
  },
);

/**
 * PUT /networks/:id/publications/{id}/order — батч локального порядка.
 * Метод PUT (карточка f6b242fe): повторная отправка того же батча
 * идемпотентна, тело `{ items: [{ node_key, position }] }`.
 */
export const RestPublicationOrder = defineContract(
  'rest:publications.order',
  z.object({
    network_id: NetworkId,
    publication_id: z.string().min(1),
    items: z
      .array(z.object({ node_key: z.string().min(1), position: z.number() }).strict())
      .min(1),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    publication_id: { from: { kind: 'param', name: 'id' } },
    items: { from: { kind: 'body' } },
  },
);

/** POST /networks/:id/publications/{id}/exclusions — исключить мысль. */
export const RestPublicationExclusionAdd = defineContract(
  'rest:publications.exclusion-add',
  z.object({
    network_id: NetworkId,
    publication_id: z.string().min(1),
    thought_id: z.string().min(1),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    publication_id: { from: { kind: 'param', name: 'id' } },
    thought_id: { from: { kind: 'body' }, msg: 'thought_id обязателен.' },
  },
);

/** DELETE /networks/:id/publications/{id}/exclusions?thought_id= — снять. */
export const RestPublicationExclusionRemove = defineContract(
  'rest:publications.exclusion-remove',
  z.object({
    network_id: NetworkId,
    publication_id: z.string().min(1),
    thought_id: z.string().min(1),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    publication_id: { from: { kind: 'param', name: 'id' } },
    thought_id: { from: { kind: 'query' }, parse: singleQueryValue, msg: 'thought_id обязателен.' },
  },
);

/** POST /networks/:id/publications/{id}/rebuild — пересборка. */
export const RestPublicationRebuild = defineContract(
  'rest:publications.rebuild',
  z.object({ network_id: NetworkId, publication_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    publication_id: { from: { kind: 'param', name: 'id' } },
  },
);

/** GET /networks/:id/publications/{id}/assembly — сборка документа. */
export const RestPublicationAssembly = defineContract(
  'rest:publications.assembly',
  z.object({
    network_id: NetworkId,
    publication_id: z.string().min(1),
    page: z.number().int().min(1).optional(),
    include_excluded: z.boolean().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    publication_id: { from: { kind: 'param', name: 'id' } },
    page: { from: { kind: 'query', coerce: 'int', min: 1 } },
    include_excluded: { from: { kind: 'query', coerce: 'bool' } },
  },
);

/** POST /networks/:id/publications/{id}/export — экспорт документа (операция 1f161c74). */
export const RestPublicationExport = defineContract(
  'rest:publications.export',
  z.object({
    network_id: NetworkId,
    publication_id: z.string().min(1),
    format: z.enum(PUBLICATION_EXPORT_FORMATS),
    with_assets: z.boolean().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    publication_id: { from: { kind: 'param', name: 'id' } },
    format: { from: { kind: 'body' }, msg: 'Недопустимый format (ожидается md|html).' },
    with_assets: { from: { kind: 'body' } },
  },
);

/** POST /networks/:id/publications/export-batch — пакетный экспорт (операция 074d7a97). */
export const RestPublicationExportBatch = defineContract(
  'rest:publications.export-batch',
  z.object({
    network_id: NetworkId,
    ids: z.array(z.string().min(1)).optional(),
    active_only: z.boolean().optional(),
    format: z.enum(PUBLICATION_EXPORT_FORMATS),
    with_assets: z.boolean().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    ids: { from: { kind: 'body' } },
    active_only: { from: { kind: 'body' } },
    format: { from: { kind: 'body' }, msg: 'Недопустимый format (ожидается md|html).' },
    with_assets: { from: { kind: 'body' } },
  },
);

/** GET /networks/:id/publications/{id}/candidates — новые кандидаты. */
export const RestPublicationCandidates = defineContract(
  'rest:publications.candidates',
  z.object({
    network_id: NetworkId,
    publication_id: z.string().min(1),
    limit: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).optional(),
    include_excluded: z.boolean().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    publication_id: { from: { kind: 'param', name: 'id' } },
    limit: { from: { kind: 'query', coerce: 'int', min: 1 } },
    offset: { from: { kind: 'query', coerce: 'int', min: 0 } },
    include_excluded: { from: { kind: 'query', coerce: 'bool' } },
  },
);

/**
 * POST /networks/:id/publications/{id}/candidates/accept — «расставить»
 * кандидата из плашки (задача e754527d; элемент интерфейса 43ec961f): гасит
 * его индивидуально и фиксирует позицию в конец порядка.
 */
export const RestPublicationCandidateAccept = defineContract(
  'rest:publications.candidate-accept',
  z.object({
    network_id: NetworkId,
    publication_id: z.string().min(1),
    thought_id: z.string().min(1),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    publication_id: { from: { kind: 'param', name: 'id' } },
    thought_id: { from: { kind: 'body' }, msg: 'thought_id обязателен.' },
  },
);

/** GET /networks/:id/thoughts/{id}/publications — использование мысли. */
export const RestPublicationUsage = defineContract(
  'rest:publications.usage',
  z.object({
    network_id: NetworkId,
    thought_id: z.string().min(1),
    limit: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).optional(),
    publication_limit: z.number().int().min(0).optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    thought_id: { from: { kind: 'param', name: 'id' } },
    limit: { from: { kind: 'query', coerce: 'int', min: 1 } },
    offset: { from: { kind: 'query', coerce: 'int', min: 0 } },
    publication_limit: { from: { kind: 'query', coerce: 'int', min: 0 } },
  },
);

// --- Полки библиотеки публикаций (операция c80951ea) -----------------------

/** POST /networks/:id/shelves — создать полку. */
export const RestShelfCreate = defineContract(
  'rest:shelves.create',
  z.object({ network_id: NetworkId, title: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    title: { from: { kind: 'body' }, msg: 'title полки обязателен.' },
  },
);

/** GET /networks/:id/shelves — список полок с составом. */
export const RestShelfList = defineContract(
  'rest:shelves.list',
  z.object({ network_id: NetworkId }),
  { network_id: { from: { kind: 'param', name: 'networkId' } } },
);

/** PATCH /networks/:id/shelves/{id} — переименование/порядок. */
export const RestShelfUpdate = defineContract(
  'rest:shelves.update',
  z.object({
    network_id: NetworkId,
    shelf_id: z.string().min(1),
    title: z.string().min(1).optional(),
    position: z.number().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    shelf_id: { from: { kind: 'param', name: 'id' } },
    title: { from: { kind: 'body' } },
    position: { from: { kind: 'body' } },
  },
);

/** DELETE /networks/:id/shelves/{id} — удалить полку (purge). */
export const RestShelfDelete = defineContract(
  'rest:shelves.delete',
  z.object({ network_id: NetworkId, shelf_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    shelf_id: { from: { kind: 'param', name: 'id' } },
  },
);

/**
 * GET /networks/:id/shelves/{id}/deletion-check — блокировки физического удаления
 * полки (только контекст слоя; состав сносится каскадом). Диалог удаления полки
 * решает по нему, доступно ли «Удалить совсем» (задача 00160da1).
 */
export const RestShelfDeletionCheck = defineContract(
  'rest:shelves.deletion-check',
  z.object({ network_id: NetworkId, shelf_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    shelf_id: { from: { kind: 'param', name: 'id' } },
  },
);

/** POST /networks/:id/shelves/{id}/trash — пометить полку на удаление. */
export const RestShelfTrash = defineContract(
  'rest:shelves.trash',
  z.object({ network_id: NetworkId, shelf_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    shelf_id: { from: { kind: 'param', name: 'id' } },
  },
);

/** POST /networks/:id/shelves/{id}/restore — снять пометку. */
export const RestShelfRestore = defineContract(
  'rest:shelves.restore',
  z.object({ network_id: NetworkId, shelf_id: z.string().min(1) }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    shelf_id: { from: { kind: 'param', name: 'id' } },
  },
);

/** POST /networks/:id/shelves/{id}/items — положить публикацию. */
export const RestShelfItemAdd = defineContract(
  'rest:shelves.item-add',
  z.object({
    network_id: NetworkId,
    shelf_id: z.string().min(1),
    publication_id: z.string().min(1),
    position: z.number().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    shelf_id: { from: { kind: 'param', name: 'id' } },
    publication_id: { from: { kind: 'body' }, msg: 'publication_id обязателен.' },
    position: { from: { kind: 'body' } },
  },
);

/** DELETE /networks/:id/shelves/{id}/items?publication_id= — убрать. */
export const RestShelfItemRemove = defineContract(
  'rest:shelves.item-remove',
  z.object({
    network_id: NetworkId,
    shelf_id: z.string().min(1),
    publication_id: z.string().min(1),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    shelf_id: { from: { kind: 'param', name: 'id' } },
    publication_id: {
      from: { kind: 'query' },
      parse: singleQueryValue,
      msg: 'publication_id обязателен.',
    },
  },
);

// ---------------------------------------------------------------------------
// MCP-контракты публикаций и полок (0.11.1, задача 8f6857f8; карточки
// cab597a8 управление, f236bb22 чтение, a610c091 экспорт)
//
// Один контракт на инструмент; вход — та же zod-схема и REST-карта, что у
// соответствующей REST-операции, поэтому валидация и канонические сообщения
// ошибок совпадают с REST (требование «валидация и ошибки идентичны REST»).
// `defineContract` делает MCP-схему `.strict()` (задача c245e7de) — агент
// получает `VALIDATION_ERROR` на опечатку в ключе.
// ---------------------------------------------------------------------------

/** MCP `etn.publications.create` = REST `POST /publications`. */
export const McpPublicationCreate = defineContract(
  'etn.publications.create',
  RestPublicationCreate.schema,
  RestPublicationCreate.rest,
);

/** MCP `etn.publications.list` = REST `GET /publications`. */
export const McpPublicationList = defineContract(
  'etn.publications.list',
  RestPublicationList.schema,
  RestPublicationList.rest,
);

/** MCP `etn.publications.get` = REST `GET /publications/{id}`. */
export const McpPublicationGet = defineContract(
  'etn.publications.get',
  RestPublicationById.schema,
  RestPublicationById.rest,
);

/** MCP `etn.publications.update` = REST `PATCH /publications/{id}`. */
export const McpPublicationUpdate = defineContract(
  'etn.publications.update',
  RestPublicationUpdate.schema,
  RestPublicationUpdate.rest,
);

/** MCP `etn.publications.order` = REST `PUT /publications/{id}/order`. */
export const McpPublicationOrder = defineContract(
  'etn.publications.order',
  RestPublicationOrder.schema,
  RestPublicationOrder.rest,
);

/**
 * MCP `etn.publications.exclusions` — один инструмент на добавление и снятие
 * исключения (карточка cab597a8 «добавить/снять исключение»). `excluded`
 * (по умолчанию `true`) выбирает ветку; REST-пары exclusion-add/remove
 * остаются двумя операциями.
 */
export const McpPublicationExclusions = defineContract(
  'etn.publications.exclusions',
  z.object({
    network_id: NetworkId,
    publication_id: z.string().min(1),
    thought_id: z.string().min(1),
    excluded: z.boolean().optional(),
  }),
  {},
);

/** MCP `etn.publications.rebuild` = REST `POST /publications/{id}/rebuild`. */
export const McpPublicationRebuild = defineContract(
  'etn.publications.rebuild',
  RestPublicationRebuild.schema,
  RestPublicationRebuild.rest,
);

/** MCP `etn.publications.trash` = REST `POST /publications/{id}/trash`. */
export const McpPublicationTrash = defineContract(
  'etn.publications.trash',
  RestPublicationById.schema,
  RestPublicationById.rest,
);

/** MCP `etn.publications.restore` = REST `POST /publications/{id}/restore`. */
export const McpPublicationRestore = defineContract(
  'etn.publications.restore',
  RestPublicationById.schema,
  RestPublicationById.rest,
);

/** MCP `etn.publications.delete` = REST `DELETE /publications/{id}` (purge). */
export const McpPublicationDelete = defineContract(
  'etn.publications.delete',
  RestPublicationById.schema,
  RestPublicationById.rest,
);

/** MCP `etn.publications.assembly` = REST `GET /publications/{id}/assembly`. */
export const McpPublicationAssembly = defineContract(
  'etn.publications.assembly',
  RestPublicationAssembly.schema,
  RestPublicationAssembly.rest,
);

/** MCP `etn.publications.candidates` = REST `GET /publications/{id}/candidates`. */
export const McpPublicationCandidates = defineContract(
  'etn.publications.candidates',
  RestPublicationCandidates.schema,
  RestPublicationCandidates.rest,
);

/** MCP `etn.publications.accept` = REST `POST /publications/{id}/candidates/accept`. */
export const McpPublicationAccept = defineContract(
  'etn.publications.accept',
  RestPublicationCandidateAccept.schema,
  RestPublicationCandidateAccept.rest,
);

/** MCP `etn.publications.usage` = REST `GET /thoughts/{id}/publications`. */
export const McpPublicationUsage = defineContract(
  'etn.publications.usage',
  RestPublicationUsage.schema,
  RestPublicationUsage.rest,
);

/**
 * MCP `etn.publications.deletionCheck` = REST
 * `GET /publications/{id}/deletion-check` (0.11.1, задача 00160da1) — блокировки
 * физического удаления публикации для диалога удаления (паритет REST/MCP).
 */
export const McpPublicationDeletionCheck = defineContract(
  'etn.publications.deletionCheck',
  RestPublicationDeletionCheck.schema,
  RestPublicationDeletionCheck.rest,
);

/** MCP `etn.publications.export` = REST `POST /publications/{id}/export`. */
export const McpPublicationExport = defineContract(
  'etn.publications.export',
  RestPublicationExport.schema,
  RestPublicationExport.rest,
);

/** MCP `etn.publications.export_batch` = REST `POST /publications/export-batch`. */
export const McpPublicationExportBatch = defineContract(
  'etn.publications.export_batch',
  RestPublicationExportBatch.schema,
  RestPublicationExportBatch.rest,
);

/** MCP `etn.shelves.list` = REST `GET /shelves`. */
export const McpShelfList = defineContract(
  'etn.shelves.list',
  RestShelfList.schema,
  RestShelfList.rest,
);

/**
 * MCP `etn.shelves.deletionCheck` = REST `GET /shelves/{id}/deletion-check`
 * (0.11.1, задача 00160da1) — блокировки физического удаления полки (только
 * контекст слоя) для диалога удаления (паритет REST/MCP).
 */
export const McpShelfDeletionCheck = defineContract(
  'etn.shelves.deletionCheck',
  RestShelfDeletionCheck.schema,
  RestShelfDeletionCheck.rest,
);

/** MCP `etn.shelves.create` = REST `POST /shelves`. */
export const McpShelfCreate = defineContract(
  'etn.shelves.create',
  RestShelfCreate.schema,
  RestShelfCreate.rest,
);

/** MCP `etn.shelves.update` = REST `PATCH /shelves/{id}`. */
export const McpShelfUpdate = defineContract(
  'etn.shelves.update',
  RestShelfUpdate.schema,
  RestShelfUpdate.rest,
);

/** MCP `etn.shelves.delete` = REST `DELETE /shelves/{id}` (purge, состав каскадом). */
export const McpShelfDelete = defineContract(
  'etn.shelves.delete',
  RestShelfDelete.schema,
  RestShelfDelete.rest,
);

/** MCP `etn.shelves.trash` = REST `POST /shelves/{id}/trash`. */
export const McpShelfTrash = defineContract(
  'etn.shelves.trash',
  RestShelfTrash.schema,
  RestShelfTrash.rest,
);

/** MCP `etn.shelves.restore` = REST `POST /shelves/{id}/restore`. */
export const McpShelfRestore = defineContract(
  'etn.shelves.restore',
  RestShelfRestore.schema,
  RestShelfRestore.rest,
);

/**
 * MCP `etn.shelves.assign` — доложить/убрать публикацию в составе полки
 * (карточка cab597a8 «полки и состав»). `assigned` (по умолчанию `true`)
 * выбирает ветку; REST-пара item-add/item-remove остаётся двумя операциями.
 */
export const McpShelfAssign = defineContract(
  'etn.shelves.assign',
  z.object({
    network_id: NetworkId,
    shelf_id: z.string().min(1),
    publication_id: z.string().min(1),
    position: z.number().optional(),
    assigned: z.boolean().optional(),
  }),
  {},
);
