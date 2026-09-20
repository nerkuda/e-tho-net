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
  AUDIT_CATEGORIES,
  COMMENT_KINDS,
  COMMENT_OWNER_TYPES,
  EXPORT_FORMATS,
  EtnError,
  ETNX_SUBTREE_DEPTH_MAX,
  SORT_KINDS,
  STRUCTURE_SORTS,
  STRUCTURES_QUERY_MAX_LIMIT,
  SORT_ORDERS,
  FOCUS_DIRS,
  ICON_KINDS,
  LINK_STYLES,
  MCP_MAX_THOUGHTS_PER_WRITE,
  MCP_VIEW_MODES,
  PROPERTY_OWNER_TYPES,
  PROPERTY_VALUE_TYPES,
  REALTIME_DEFAULTS,
  SAVED_FILTER_VIEWS,
  SEARCH_SCOPES,
  TRAVERSAL_DEFAULTS,
  TYPES_LIST_SCOPES,
  TYPE_OWNER_TYPES,
} from '@etn/shared';
import { ACTIVITY_LIMIT_MAX } from './domain/activity-service.js';
import { validateLayerColors } from './domain/layer-service.js';

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

/** `direction` inline-ссылки (task O4, docs/03-server-api.md §6.3). */
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

/** Реестр контрактов по имени инструмента (для канонических ошибок MCP). */
const contractsByName = new Map<string, OperationContract>();

/** Объявить контракт операции и зарегистрировать его по имени. */
export function defineContract<S extends z.ZodObject>(
  name: string,
  schema: S,
  rest: OperationContract<S>['rest'],
): OperationContract<S> {
  const contract: OperationContract<S> = { name, schema, rest };
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
 * значений по умолчанию и деталей).
 */
export function messageForIssue(
  specKey: string,
  pathKey: string,
  spec: RestFieldSpec | undefined,
  field: ZodType | undefined,
  issue: ZodIssueLike,
): string {
  const specVars: Record<string, string | number | bigint> = { key: specKey };
  const vars: Record<string, string | number | bigint> = { key: pathKey };
  if (issue.code === 'custom') {
    return issue.message;
  }
  if (issue.code === 'invalid_type') {
    if (issue.received === 'undefined') {
      return template(spec?.msg ?? '{key} обязателен.', specVars);
    }
    const nulls = field !== undefined && field.safeParse(null).success;
    const suffix = nulls ? ' или null' : '';
    switch (issue.expected) {
      case 'string':
        return template(spec?.msg ?? `{key} должен быть строкой${suffix}.`, specVars);
      case 'int':
      case 'number':
        return template(spec?.msg ?? `{key} должен быть целым числом${suffix}.`, specVars);
      case 'boolean':
        return template(spec?.msg ?? `{key} должен быть логическим значением${suffix}.`, specVars);
      case 'array':
        return template(spec?.msg ?? '{key} должен быть массивом строк.', specVars);
      case 'object':
        return template(spec?.msg ?? '{key} должен быть объектом.', specVars);
      default:
        return template(spec?.msg ?? 'Недопустимый {key}.', specVars);
    }
  }
  if (issue.code === 'too_small') {
    if (issue.origin === 'string') {
      return template(spec?.msg ?? '{key} обязателен.', specVars);
    }
    if (issue.origin === 'array') {
      return template(spec?.msg ?? '{key} должен быть непустым массивом.', specVars);
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
    return template(spec?.msg ?? 'Недопустимый {key}.', specVars);
  }
  if (issue.code === 'unrecognized_keys') {
    const keys = Array.isArray(issue.keys) ? issue.keys.map(String).join(', ') : '';
    return template(spec?.msg ?? 'Неизвестные поля: {keys}.', { ...specVars, keys });
  }
  return template(spec?.msg ?? 'Недопустимый {key}.', specVars);
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
        const fieldKey = issueKey(key, issue);
        throw fieldError(requestId, fieldKey, messageForIssue(key, fieldKey, spec, field, issue), issueDetails(fieldKey, issue));
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
  // и к REST: то же сообщение, что в MCP. Строгие схемы (.strict()) проверяют
  // лишние ключи ПО СЫРОМУ телу: сливаем его с распарсенными полями (out
  // перезаписывает валидированные значения).
  const merged = body === undefined ? out : { ...body, ...out };
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
    throw fieldError(requestId, fieldKey, messageForIssue(fieldKey, fieldKey, spec, undefined, issue), issueDetails(fieldKey, issue, allowedKeys));
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
    messageForIssue(fieldKey, fieldKey, spec, shape[fieldKey], issue),
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
export const LayersDiff = defineContract(
  'etn.layers.diff',
  LayersDiffFields,
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    layer_id: { from: { kind: 'param', name: 'layerId' } },
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
  z.object({
    network_id: NetworkId,
    layer_id: LayerId,
    tables: z.record(z.string(), z.array(z.string().min(1))).optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    layer_id: { from: { kind: 'param', name: 'layerId' } },
    tables: { from: { kind: 'body' }, msg: 'tables должен быть объектом { таблица: [id, …] }.' },
  },
);

// ===========================================================================
// Область: мысли — чтение (tools/thoughts-read.ts; REST-аналоги ниже по файлу)
// ===========================================================================

const SearchFields = z
  .object({
    network_id: NetworkId,
    query: z.string().min(1),
    scope: z.enum(SEARCH_SCOPES).optional(),
    in_subtree_of: ThoughtId.optional(),
    type_id: ThoughtId.nullable().optional(),
    type: z.string().min(1).optional(),
    author_id: z.string().optional(),
    editor_id: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .refine((v) => v.type_id === undefined || v.type === undefined, { message: TYPE_ID_TYPE_CONFLICT });
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
  });
const QueryFields = z
  .object({
    network_id: NetworkId,
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
  })
  .refine((v) => v.type_id === undefined || v.type === undefined, { message: TYPE_ID_TYPE_CONFLICT });
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
  z.object({
    network_id: NetworkId,
    title: z.string().min(1),
    synonyms: z.array(z.string().min(1)).optional(),
  }),
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
  .refine((v) => v.type === undefined || v.type_id === undefined, { message: TYPE_ID_TYPE_CONFLICT })
  .refine((v) => v.link_type === undefined || v.link_type_id === undefined, {
    message: 'provide at most one of link_type_id or link_type',
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'args must not be empty when provided' })
  .optional();
export const BULK_UPDATE_OP_VALUES = BULK_UPDATE_OPS;
export const ThoughtsBulkUpdate = defineContract(
  'etn.thoughts.bulk_update',
  z.object({
    network_id: NetworkId,
    ids: z.array(ThoughtId).min(1),
    op: z.enum(BULK_UPDATE_OPS),
    args: BulkUpdateArgs,
  }),
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
  .refine((a) => (a.comment_id === undefined) !== (a.thought_id === undefined), {
    message: 'provide exactly one of comment_id or thought_id',
  });
export const CommentsGet = defineContract('etn.comments.get', GetCommentFields, {});

const CommentChangesFields = z
  .object({
    title: z.string().nullable().optional(),
    body_md: z.string().min(1).optional(),
    valid_from: z.string().min(1).optional(),
    valid_to: z.string().nullable().optional(),
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
    owner_type: z.enum(['thought', 'link']),
    owner_id: z.string().min(1),
    kind: z.enum(ATTACHMENT_KINDS),
    url: z.string().min(1).nullable().optional(),
    file_path: z.string().min(1).nullable().optional(),
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
    target_owner_type: z.enum(['thought', 'link']),
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
    exclude_owner_type: z.enum(['thought', 'link']).optional(),
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

export const AttachmentsDelete = defineContract(
  'etn.attachments.delete',
  z.object({ network_id: NetworkId, attachment_id: z.string().min(1) }),
  {},
);

// ===========================================================================
// Область: сети (tools/networks.ts)
// ===========================================================================

export const NetworksStructure = defineContract(
  'etn.networks.structure',
  z.object({ network_id: NetworkId, include_examples: z.boolean().optional() }),
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
    parent: z.string().min(1).nullable().optional(),
    parent_ref: z.string().min(1).nullable().optional(),
    description: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    icon_kind: z.enum(ICON_KINDS).optional(),
    fg_color: z.string().nullable().optional(),
    bg_color: z.string().nullable().optional(),
    font_bold: z.boolean().nullable().optional(),
    font_italic: z.boolean().nullable().optional(),
    font_underline: z.boolean().nullable().optional(),
    font_strike: z.boolean().nullable().optional(),
    comment_template_md: z.string().nullable().optional(),
  })
  .strict();
const OntologyWriteLinkTypeFields = z
  .object({
    ref: z.string().min(1).optional(),
    id: z.string().min(1).nullable().optional(),
    name_forward: z.string().min(1).optional(),
    name_reverse: z.string().min(1).optional(),
    parent: z.string().min(1).nullable().optional(),
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
  z.object({
    network_id: NetworkId,
    thought_types: z.array(OntologyWriteThoughtTypeFields).optional(),
    link_types: z.array(OntologyWriteLinkTypeFields).optional(),
    properties: z.array(OntologyWritePropertyFields).optional(),
    type_properties: z.array(OntologyWriteTypePropertyFields).optional(),
    type_views: z.array(OntologyWriteTypeViewFields).optional(),
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

export const Instructions = defineContract(
  'etn.instructions',
  z
    .object({
      network_id: NetworkId,
      instruction_id: z.string().min(1).optional(),
      keywords: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .strict()
    .refine((v) => v.instruction_id === undefined || v.keywords === undefined, {
      message: 'instruction_id и keywords взаимоисключимы',
    })
    .refine((v) => v.instruction_id === undefined || (v.limit === undefined && v.offset === undefined), {
      message: 'limit/offset применимы только к режимам перечня, не к instruction_id',
    }),
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
    thought_ids: z.array(ThoughtId).optional(),
    include_subtree: z.boolean().optional(),
    type: z.string().min(1).optional(),
    type_id: z.array(ThoughtId).optional(),
    link_type: z.string().min(1).optional(),
    link_type_id: z.array(ThoughtId).optional(),
    link_scope: z.enum(['sources', 'targets', 'both']).optional(),
    date_from: z.string().min(1).optional(),
    date_to: z.string().min(1).optional(),
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

/** POST /networks/:id/trash/purge — очистка (опционально targeted `ids`). */
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
      keywords: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .refine((v) => v.instruction_id === undefined || v.keywords === undefined, {
      message: 'instruction_id и keywords взаимоисключимы',
    })
    .refine((v) => v.instruction_id === undefined || (v.limit === undefined && v.offset === undefined), {
      message: 'limit/offset применимы только к режиму перечня, не к instruction_id',
    }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    instruction_id: { from: { kind: 'query' }, parse: (raw) => (typeof raw === 'string' && raw !== '' ? raw : undefined) },
    keywords: { from: { kind: 'query' }, parse: (raw) => (typeof raw === 'string' && raw !== '' ? raw : undefined) },
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
  body_md: {
    from: { kind: 'body' },
    msg: 'body_md обязателен и не может быть пустым.',
    check: (v: unknown) => (typeof v === 'string' && v.trim() === '' ? 'body_md обязателен и не может быть пустым.' : null),
  },
  title: { from: { kind: 'body' } },
  valid_from: { from: { kind: 'body' } },
  valid_to: { from: { kind: 'body' } },
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
    body_md: z.string().min(1),
    title: z.string().nullable().optional(),
    valid_from: z.string().optional(),
    valid_to: z.string().nullable().optional(),
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
    body_md: z.string().min(1),
    title: z.string().nullable().optional(),
    valid_from: z.string().optional(),
    valid_to: z.string().nullable().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    ...commentFieldsRest,
    targets: {
      from: { kind: 'body' },
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
      t: z.enum(['thought', 'link']).optional(),
      msg: 'exclude_owner_type должен быть thought|link.',
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
      t: z.enum(['thought', 'link']),
      req: true,
      msg: 'target_owner_type должен быть thought|link.',
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
      t: z.enum(['thought', 'link']).optional(),
      msg: 'owner_type должен быть thought|link.',
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
  z.object({
    network_id: NetworkId,
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
    active: z.boolean().optional(),
    fg_color: z.string().nullable().optional(),
    bg_color: z.string().nullable().optional(),
    font_bold: z.boolean().optional(),
    font_italic: z.boolean().optional(),
    font_underline: z.boolean().optional(),
    font_strike: z.boolean().optional(),
  }),
  {
    title: { from: { kind: 'body' }, msg: 'title обязателен и не может быть пустым.' },
    synonyms: { from: { kind: 'body' } },
    type_id: { from: { kind: 'body' } },
    icon: { from: { kind: 'body' } },
    icon_kind: { from: { kind: 'body' } },
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
    icon_attachment_id: z.string().nullable().optional(),
    active: z.boolean().optional(),
    marked_for_deletion: z.boolean().optional(),
    fg_color: z.string().nullable().optional(),
    bg_color: z.string().nullable().optional(),
    font_bold: z.boolean().nullable().optional(),
    font_italic: z.boolean().nullable().optional(),
    font_underline: z.boolean().nullable().optional(),
    font_strike: z.boolean().nullable().optional(),
  }),
  {
    title: { from: { kind: 'body' } },
    synonyms: { from: { kind: 'body' } },
    type_id: { from: { kind: 'body' } },
    icon: { from: { kind: 'body' } },
    icon_kind: { from: { kind: 'body' } },
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

/** Тело focus-переопределения (show_inactive). */
export const RestFocusBody = defineContract(
  'rest:thoughts.focus-body',
  z.object({ show_inactive: z.boolean().optional() }),
  { show_inactive: { from: { kind: 'body' } } },
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
    fg_color: z.string().nullable().optional(),
    bg_color: z.string().nullable().optional(),
    font_bold: z.boolean().nullable().optional(),
    font_italic: z.boolean().nullable().optional(),
    font_underline: z.boolean().nullable().optional(),
    font_strike: z.boolean().nullable().optional(),
    description: z.string().nullable().optional(),
    comment_template_md: z.string().nullable().optional(),
  }),
  {
    name: { from: { kind: 'body' }, msg: 'name обязателен и не может быть пустым.' },
    parent_id: {
      from: { kind: 'body' },
      parse: (raw: unknown) => (raw === '' ? null : raw),
    },
    icon: { from: { kind: 'body' } },
    icon_kind: { from: { kind: 'body' } },
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
    fg_color: z.string().nullable().optional(),
    bg_color: z.string().nullable().optional(),
    font_bold: z.boolean().nullable().optional(),
    font_italic: z.boolean().nullable().optional(),
    font_underline: z.boolean().nullable().optional(),
    font_strike: z.boolean().nullable().optional(),
    description: z.string().nullable().optional(),
    comment_template_md: z.string().nullable().optional(),
  }),
  {
    name: { from: { kind: 'body' } },
    parent_id: { from: { kind: 'body' }, parse: (raw: unknown) => (raw === '' ? null : raw) },
    icon: { from: { kind: 'body' } },
    icon_kind: { from: { kind: 'body' } },
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

/** GET /networks/:id/thoughts/:id/hierarchy — dir/show_inactive/offset. */
export const RestHierarchyQuery = defineContract(
  'rest:structures.hierarchy-query',
  z.object({
    network_id: NetworkId,
    thought_id: z.string().min(1),
    dir: z.enum(['parents', 'children']),
    show_inactive: z.boolean().optional(),
    offset: z.number().int().min(0).optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    thought_id: { from: { kind: 'param', name: 'id' } },
    dir: { from: { kind: 'query' }, msg: 'dir должен быть parents или children.' },
    show_inactive: { from: { kind: 'query', coerce: 'bool' } },
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
  },
);

/** Тело POST /thoughts/edges — { ids, show_inactive } (+ network_id из params). */
export const RestEdgesBody = defineContract(
  'rest:structures.edges-body',
  z.object({
    network_id: NetworkId,
    ids: z.array(z.string()).min(1),
    show_inactive: z.boolean().optional(),
  }),
  {
    network_id: { from: { kind: 'param', name: 'networkId' } },
    ids: { from: { kind: 'body' }, msg: 'ids должен быть массивом строк.' },
    show_inactive: { from: { kind: 'body' } },
  },
);

/** Тело POST /saved-filters — { view, name, definition }. */
export const RestSavedFilterCreateBody = defineContract(
  'rest:structures.saved-filter-create-body',
  z.object({
    view: z.enum(SAVED_FILTER_VIEWS),
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
    })
    .strict(),
  {
    sort: { from: { kind: 'body' }, msg: 'Недопустимый sort.' },
    order: { from: { kind: 'body' }, msg: 'Недопустимый order.' },
    ids_only: { from: { kind: 'body' } },
    limit: { from: { kind: 'body' } },
    offset: { from: { kind: 'body' } },
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
