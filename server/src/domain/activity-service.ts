/**
 * Activity-log domain service (задача f2eca5a4 «Журнал activity_log: запись,
 * миграция, REST /activity», требование b0c7a57c «activity_log — состав записи»,
 * операция 70dfe81d «/activity — лента, свёртка и обрезка»,
 * docs/03-server-api.md §13d).
 *
 * Долговременная история операций изменения сущностей сети. Таблица
 * `activity_log` (миграция 035) не ветвится — пишется в одну глобальную
 * «здесь и сейчас» запись на сеть, как и `object_locks` (миграция 034);
 * фиксация в слое остаётся только как снимок `layer_id`.
 *
 * Два публичных примитива:
 *   * {@link recordActivity} — добавить строку в журнал. Вызывается роутами
 *     и MCP-инструментами сразу после успешной мутации, параллельно с
 *     `emitDomainEvent`. Сбой записи **не отменяет** бизнес-операцию
 *     (требование b0c7a57c): ошибки логируются и поглощаются;
 *   * {@link listActivity} — прочитать ленту с фильтрами и пагинацией
 *     (стандартный envelope `{ data, meta: { total, offset, limit } }`).
 *
 * Захваты (`edit.*`), per-user real-time (`audience=user`) и операции чтения
 * в журнал не пишутся — требование b0c7a57c и граница b0c7a57c.
 */

import { randomUUID } from 'node:crypto';

import {
  EtnError,
  FILTER_AST_VERSION,
  buildLikePattern,
  type ActivityAction,
  type ActivityEntityType,
  type ActivityListParams,
  type ActivityRow,
  type Comment,
  type FilterAst,
  type FilterAstLeaf,
  type FilterAstListItem,
  type FilterAstNode,
  type Layer,
  type Link,
  type LinkType,
  type NetworkProperty,
  type Publication,
  type Shelf,
  type Thought,
  type ThoughtType,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { logger } from '../logger.js';
import { normaliseInstant } from './dates.js';
import { buildThoughtIdSelect } from './query-service.js';
import { parseFilterAst } from './filter-ast.js';
import { assertFilterAstInProfile } from './filter-profile-validation.js';
import { diagnoseFilterAst, filterDiagnosticsError } from './filter-diagnostics.js';
import { resolveGlobalDateTokens, scanStringForTokens } from './thought-type-view-tokens.js';
import {
  snapshotAttachment,
  snapshotComment,
  snapshotLayer,
  snapshotLink,
  snapshotLinkType,
  snapshotProperty,
  snapshotPublication,
  snapshotShelf,
  snapshotThought,
  snapshotThoughtType,
  truncateTitle,
} from './activity-snapshot.js';

/** Жёсткий потолок `limit` — общий с другими list-эндпоинтами (03-server-api.md §2). */
export const ACTIVITY_LIMIT_MAX = 200;
export const ACTIVITY_LIMIT_DEFAULT = 50;

/**
 * Параметры одной записи журнала. Все поля обязательны; пустой `layerId`
 * маркирует операции вне слоя (например, создание самой сети до S10).
 */
export interface RecordActivityInput {
  networkId: string;
  userId: string;
  action: ActivityAction | string;
  entityType: ActivityEntityType | string;
  entityId: string;
  /** Уже сформированный и обрезанный до {@link ACTIVITY_TITLE_MAX} снимок. */
  entityTitle: string;
  /** Снимок слоя на момент операции; `null` для базовой записи. */
  layerId: string | null;
  /**
   * Явная метка времени строки (ms). Обёртка записи проставляет монотонно
   * возрастающие значения, чтобы порядок строк одного исхода в ленте был
   * детерминированным (внутри одной миллисекунды `ORDER BY occurred_at_ms,
   * id` упирался в случайный UUID). По умолчанию — `Date.now()`.
   */
  occurredAtMs?: number;
}

/** Физическая строка `activity_log`. */
interface ActivityDbRow {
  id: string;
  network_id: string;
  user_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_title: string;
  layer_id: string | null;
  occurred_at_ms: number;
}

/** Преобразование физической строки в wire DTO. */
function toActivityRow(row: ActivityDbRow): ActivityRow {
  return {
    id: row.id,
    user_id: row.user_id,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    entity_title: row.entity_title,
    layer_id: row.layer_id,
    occurred_at_ms: row.occurred_at_ms,
  };
}

/**
 * Записать строку в `activity_log`. Не бросает: сбой записи в журнал
 * не должен отменять бизнес-операцию (требование b0c7a57c). Ошибка
 * пишется в общий лог и проглатывается.
 *
 * Запись идёт отдельной транзакцией от мутации — намеренно: журнал
 * вспомогательный, консистентность с `data.db` не требуется.
 */
export function recordActivity(ndb: NetworkDb, input: RecordActivityInput): void {
  const id = randomUUID();
  const occurredAtMs = input.occurredAtMs ?? Date.now();
  try {
    ndb
      .prepare(
        `INSERT INTO activity_log
         (id, network_id, user_id, action, entity_type, entity_id,
          entity_title, layer_id, occurred_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.networkId,
        input.userId,
        input.action,
        input.entityType,
        input.entityId,
        truncateTitle(input.entityTitle),
        input.layerId,
        occurredAtMs,
      );
  } catch (err) {
    logger.error(
      {
        err,
        network_id: input.networkId,
        action: input.action,
        entity_type: input.entityType,
        entity_id: input.entityId,
      },
      'activity_log insert failed; бизнес-операция продолжается',
    );
  }
}

/** Нормализовать `limit`/`offset` для list-эндпоинта ленты. */
export function normalizeActivityPagination(params: { limit?: number; offset?: number }): {
  limit: number;
  offset: number;
} {
  const limit = Math.min(ACTIVITY_LIMIT_MAX, Math.max(1, params.limit ?? ACTIVITY_LIMIT_DEFAULT));
  const offset = Math.max(0, params.offset ?? 0);
  return { limit, offset };
}

/** Результат list-эндпоинта ленты: данные + общее число подходящих строк. */
export interface ActivityListResult {
  data: ActivityRow[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Отбор событий на общий AST (задача 2b230e8e; требования 1765e659 «операнды
// профиля», 3c91f418 «REST/MCP компилируются в общий AST»; ADR 06a15c16).
//
// Единый AST-путь: плоские параметры (from_ms/to_ms/user_id/entity_type/
// entity_id) компилируются в AST профиля «события», он же исполняется над
// `activity_log`. Второго исполнения фильтров нет. Свёртка/обрезка (`etn.ops`)
// и пагинация остаются отдельными операциями.
// ---------------------------------------------------------------------------

/** Условие над `activity_log` + параметры. */
interface ActivityClause {
  sql: string;
  args: unknown[];
}

/** Контекст раскрытия токенов и под-выборки «Сущность» (`entity_id`). */
export interface ActivityListOptions {
  /** Пользователь-контекст под-выборки мыслей (видимость `$user`/свойств). */
  userId?: string;
  /** Часы раскрытия токенов `$now`/`$hour*` (тесты). */
  nowMs?: number;
  /** Первый день недели сети (`$weekStart`/`$weekEnd`). */
  firstDayOfWeek?: number;
  /** Идентификатор запроса для диагностики. */
  requestId?: string;
}

/** Плоские фильтры событий — несовместимы с AST-телом (XOR). */
const ACTIVITY_FLAT_FIELDS = ['from_ms', 'to_ms', 'user_id', 'entity_type', 'entity_id'] as const;

const activityUnsupported = (message: string, requestId?: string): never => {
  throw new EtnError('VALIDATION_ERROR', message, { field: 'ast' }, requestId);
};

/** «Голая дата» `YYYY-MM-DD` — единственная форма, у которой граница = сутки. */
const OCCURRED_BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Раскрытая граница в миллисекунды; у верхней границы (`edge: 'end'`) «голая
 * дата» разворачивается в КОНЕЦ суток UTC — иначе сравнение «`<=` 2026-10-15»
 * не покрывает день. Полный инстанс и число не зависят от `edge`
 * (ошибка 03db4cb0, паритет с датами создания/изменения e219112e).
 */
function occurredEdgeMs(text: string, edge: 'start' | 'end'): number | null {
  if (edge === 'end' && OCCURRED_BARE_DATE_RE.test(text)) {
    const iso = normaliseInstant(text, 'occurred_at', 'end');
    return iso === null ? null : Date.parse(iso);
  }
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/** Раскрыть границу `occurred_at` (ms, ISO-строка или токен) в миллисекунды. */
function resolveOccurredBound(
  raw: unknown,
  opts: ActivityListOptions,
  edge: 'start' | 'end' = 'start',
): number {
  const rawValue =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'token' in raw
      ? (raw as { token?: unknown }).token
      : raw;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      '«Время события»: ожидается миллисекунды, дата или токен.',
      { field: 'occurred_at' },
      opts.requestId,
    );
  }
  const text = rawValue.trim();
  const { known, unknown } = scanStringForTokens(text);
  if (unknown.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `«Время события»: неизвестный токен «${unknown[0]!.raw}».`,
      { field: 'occurred_at', token: unknown[0]!.raw },
      opts.requestId,
    );
  }
  if (known.length === 0) {
    const ms = occurredEdgeMs(text, edge);
    if (ms !== null) return ms;
  }
  const { value, unresolved } = resolveGlobalDateTokens(text, {
    ...(opts.nowMs !== undefined ? { now: () => new Date(opts.nowMs!) } : {}),
    ...(opts.firstDayOfWeek !== undefined ? { firstDayOfWeek: opts.firstDayOfWeek } : {}),
    // Профиль «события» несёт время (требование 0095daad, ADR 0c02ab4f).
    withTime: true,
  });
  if (unresolved.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `«Время события»: ${unresolved[0]!.message}`,
      { field: 'occurred_at', token: unresolved[0]!.token },
      opts.requestId,
    );
  }
  const ms = occurredEdgeMs(value, edge);
  if (ms === null) {
    throw new EtnError(
      'VALIDATION_ERROR',
      '«Время события»: не удалось раскрыть значение времени.',
      { field: 'occurred_at' },
      opts.requestId,
    );
  }
  return ms;
}

/** Список строк значения листа (`eq/ne` — одна, `in/not_in` — массив). */
function activityStringList(value: unknown, operator: string, field: string, requestId?: string): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  throw new EtnError(
    'VALIDATION_ERROR',
    `Операнд «${field}»: оператор «${operator}» требует строку или список строк.`,
    { field },
    requestId,
  );
}

/** Условие «в списке / не в списке» по колонке. */
function activityInClause(column: string, ids: string[], positive: boolean): ActivityClause {
  if (ids.length === 0) return { sql: positive ? '0' : '1=1', args: [] };
  return {
    sql: `${column} ${positive ? 'IN' : 'NOT IN'} (${ids.map(() => '?').join(',')})`,
    args: [...ids],
  };
}

/** Идентификаторы мыслей из под-выборки «Сущность» (`entity_id`). */
function activitySubqueryIds(ndb: NetworkDb, query: FilterAstNode, opts: ActivityListOptions): string[] {
  const sel = buildThoughtIdSelect(ndb, opts.userId ?? '', {
    sort: 'alpha',
    order: 'asc',
    limit: 1,
    offset: 0,
    ast: { version: FILTER_AST_VERSION, filter: query },
  });
  return (ndb.prepare(sel.sql).all(...sel.params) as Array<{ id: string }>).map((r) => r.id);
}

/** «Время события» (`occurred_at_ms`): равно/не равно, сравнения и «между» с токенами времени. */
function activityOccurredLeaf(node: FilterAstLeaf, opts: ActivityListOptions): ActivityClause {
  const lower = (raw: unknown, strict: boolean, edge: 'start' | 'end' = 'start'): ActivityClause => ({
    sql: `occurred_at_ms ${strict ? '>' : '>='} ?`,
    args: [resolveOccurredBound(raw, opts, edge)],
  });
  const upper = (raw: unknown, strict: boolean, edge: 'start' | 'end' = 'start'): ActivityClause => ({
    sql: `occurred_at_ms ${strict ? '<' : '<='} ?`,
    args: [resolveOccurredBound(raw, opts, edge)],
  });
  const between = (value: unknown): ActivityClause => {
    if (!Array.isArray(value) || value.length !== 2) {
      activityUnsupported('«Время события»: оператор «между» требует две границы.', opts.requestId);
    }
    const bounds = value as FilterAstListItem[];
    const a = lower(bounds[0], false);
    const b = upper(bounds[1], false);
    return { sql: `(${a.sql} AND ${b.sql})`, args: [...a.args, ...b.args] };
  };
  /**
   * Равенство времени события: попадание в СУТКИ «голой даты» (нижняя граница —
   * начало, верхняя — конец) либо точное совпадение полного инстанса
   * (ошибка 03db4cb0, паритет с датами создания/изменения e219112e).
   */
  const equal = (value: unknown): ActivityClause => {
    const a = lower(value, false, 'start');
    const b = upper(value, false, 'end');
    return { sql: `(${a.sql} AND ${b.sql})`, args: [...a.args, ...b.args] };
  };
  switch (node.operator) {
    case 'gte':
      return lower(node.value, false);
    case 'gt':
      return lower(node.value, true);
    case 'lte':
      return upper(node.value, false);
    case 'lt':
      return upper(node.value, true);
    case 'eq':
      return equal(node.value);
    case 'ne': {
      const inner = equal(node.value);
      return { sql: `NOT ${inner.sql}`, args: inner.args };
    }
    case 'between':
      return between(node.value);
    case 'not_between': {
      const inner = between(node.value);
      return { sql: `NOT ${inner.sql}`, args: inner.args };
    }
    default:
      return activityUnsupported(`Оператор «${node.operator}» недопустим для «Времени события».`, opts.requestId);
  }
}

/** Строковый лист (`action`/`entity_type`/`user`): равно/содержит/в списке. */
function activityTextLeaf(node: FilterAstLeaf, column: string, opts: ActivityListOptions): ActivityClause {
  const op = node.operator;
  if (op === 'in' || op === 'not_in') {
    const list = activityStringList(node.value, op, column, opts.requestId);
    return activityInClause(column, list, op === 'in');
  }
  const raw = typeof node.value === 'string' ? node.value : undefined;
  if (raw === undefined) {
    return activityUnsupported(`Операнд «${column}»: оператор «${op}» требует строковое значение.`, opts.requestId);
  }
  switch (op) {
    case 'eq':
      return { sql: `${column} = ?`, args: [raw] };
    case 'ne':
      return { sql: `(${column} IS NULL OR ${column} <> ?)`, args: [raw] };
    case 'contains':
      return { sql: `unicode_lower(${column}) LIKE ? ESCAPE '\\'`, args: [buildLikePattern(raw.toLowerCase())] };
    case 'not_contains':
      return {
        sql: `NOT (unicode_lower(${column}) LIKE ? ESCAPE '\\')`,
        args: [buildLikePattern(raw.toLowerCase())],
      };
    default:
      return activityUnsupported(`Операнд «${column}»: оператор «${op}» недопустим.`, opts.requestId);
  }
}

/**
 * «Сущность» (`entity_id`): `eq`/`ne` — литеральный id; `in`/`not_in` — список
 * id или под-выборка мыслей; `all_of` — под-выборка мыслей («все цели», для
 * скалярного `entity_id` тождественно вхождению). Требование 1765e659:
 * «по конкретной сущности — равно ИЛИ под-выборка по мыслям».
 */
function activityEntityIdLeaf(ndb: NetworkDb, node: FilterAstLeaf, opts: ActivityListOptions): ActivityClause {
  const value = node.value;
  const isSubquery = typeof value === 'object' && value !== null && !Array.isArray(value) && 'query' in value;
  switch (node.operator) {
    case 'eq':
    case 'ne': {
      const list = activityStringList(value, node.operator, 'entity_id', opts.requestId);
      const id = list[0];
      if (id === undefined) return { sql: node.operator === 'eq' ? '0' : '1=1', args: [] };
      return {
        sql: node.operator === 'eq' ? 'entity_id = ?' : '(entity_id IS NULL OR entity_id <> ?)',
        args: [id],
      };
    }
    case 'in':
    case 'not_in': {
      const ids = isSubquery
        ? activitySubqueryIds(ndb, (value as { query: FilterAstNode }).query, opts)
        : activityStringList(value, node.operator, 'entity_id', opts.requestId);
      return activityInClause('entity_id', ids, node.operator === 'in');
    }
    case 'all_of': {
      if (!isSubquery) {
        return activityUnsupported('«Сущность»: оператор all_of требует под-выборку мыслей.', opts.requestId);
      }
      const ids = activitySubqueryIds(ndb, (value as { query: FilterAstNode }).query, opts);
      return activityInClause('entity_id', ids, true);
    }
    default:
      return activityUnsupported(`Оператор «${node.operator}» недопустим для «Сущности».`, opts.requestId);
  }
}

/** Условие узла AST событий над `activity_log`. */
function activityAstNodeClause(ndb: NetworkDb, node: FilterAstNode, opts: ActivityListOptions): ActivityClause {
  if ('op' in node) {
    if (node.op === 'not') {
      const child = activityAstNodeClause(ndb, node.children[0]!, opts);
      return { sql: `NOT (${child.sql})`, args: child.args };
    }
    const parts = node.children.map((c) => activityAstNodeClause(ndb, c, opts));
    if (node.op === 'and') {
      return parts.length === 0
        ? { sql: '1=1', args: [] }
        : { sql: `(${parts.map((p) => p.sql).join(' AND ')})`, args: parts.flatMap((p) => p.args) };
    }
    return parts.length === 0
      ? { sql: '0', args: [] }
      : { sql: `(${parts.map((p) => p.sql).join(' OR ')})`, args: parts.flatMap((p) => p.args) };
  }
  switch (node.entity.kind) {
    case 'occurred_at':
      return activityOccurredLeaf(node, opts);
    case 'action':
      return activityTextLeaf(node, 'action', opts);
    case 'entity_type':
      return activityTextLeaf(node, 'entity_type', opts);
    // «Заголовок сущности» (задача b2aa2444): LIKE по СНИМКУ заголовка в
    // `activity_log.entity_title` — возврат поиска по слову в ленте «События».
    case 'entity_title':
      return activityTextLeaf(node, 'entity_title', opts);
    case 'user':
      return activityTextLeaf(node, 'user_id', opts);
    case 'entity_id':
      return activityEntityIdLeaf(ndb, node, opts);
    default:
      return activityUnsupported(`Операнд «${node.entity.kind}» не виден в профиле «события».`, opts.requestId);
  }
}

/**
 * Скомпилировать плоские параметры ленты в общий AST (требование 3c91f418).
 * Воспроизводит прежнюю WHERE-семантику один-в-один: `from_ms`→`gte`, `to_ms`→
 * `lte`, `user_id`→`eq`, `entity_type`→`in`, `entity_id`→`eq`.
 */
export function compileActivityToAst(params: ActivityListParams): FilterAst {
  const parts: FilterAstNode[] = [];
  if (params.from_ms !== undefined) {
    parts.push({ entity: { kind: 'occurred_at' }, operator: 'gte', value: params.from_ms });
  }
  if (params.to_ms !== undefined) {
    parts.push({ entity: { kind: 'occurred_at' }, operator: 'lte', value: params.to_ms });
  }
  if (params.user_id !== undefined && params.user_id !== null && params.user_id !== '') {
    parts.push({ entity: { kind: 'user' }, operator: 'eq', value: params.user_id });
  }
  if (params.entity_type !== undefined && params.entity_type !== null && params.entity_type !== '') {
    parts.push({ entity: { kind: 'entity_type' }, operator: 'in', value: [params.entity_type] });
  }
  if (params.entity_id !== undefined && params.entity_id !== null && params.entity_id !== '') {
    parts.push({ entity: { kind: 'entity_id' }, operator: 'eq', value: params.entity_id });
  }
  const filter: FilterAstNode =
    parts.length === 0 ? { op: 'and', children: [] } : parts.length === 1 ? parts[0]! : { op: 'and', children: parts };
  return { version: FILTER_AST_VERSION, filter };
}

/**
 * Разобрать запрос ленты (`GET /activity` / `etn.activity.list`) в параметры
 * `listActivity`. `ast` XOR плоские фильтры (требование 3c91f418); строгая
 * форма AST — доменный `parseFilterAst`, видимость операндов — по профилю
 * «события» (проверяется в {@link listActivity}).
 */
export function parseActivityListQuery(
  raw: Record<string, unknown>,
  requestId: string,
): ActivityListParams {
  const out: ActivityListParams = { networkId: String(raw['network_id'] ?? '') };
  const astRaw = raw['ast'];
  if (astRaw !== undefined && astRaw !== null) {
    const conflicts = ACTIVITY_FLAT_FIELDS.filter((f) => raw[f] !== undefined);
    if (conflicts.length > 0) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'AST-тело (`ast`) несовместимо с плоскими фильтрами.',
        { field: 'ast', conflicts },
        requestId,
      );
    }
    out.ast = parseFilterAst(astRaw, requestId);
  } else {
    if (raw['from_ms'] !== undefined) out.from_ms = raw['from_ms'] as number;
    if (raw['to_ms'] !== undefined) out.to_ms = raw['to_ms'] as number;
    if (raw['user_id'] !== undefined) out.user_id = raw['user_id'] as string;
    if (raw['entity_type'] !== undefined) out.entity_type = raw['entity_type'] as string;
    if (raw['entity_id'] !== undefined) out.entity_id = raw['entity_id'] as string;
  }
  if (raw['limit'] !== undefined) out.limit = raw['limit'] as number;
  if (raw['offset'] !== undefined) out.offset = raw['offset'] as number;
  return out;
}

/**
 * Прочитать ленту журнала активности с фильтрами и пагинацией
 * (REST `GET /activity`, MCP `etn.activity.list`).
 *
 * Единый AST-путь (требование 3c91f418): явное `ast`-тело — как передано (с
 * проверкой профиля «события» и красной диагностикой); плоские параметры —
 * компилируются в AST. Фильтры комбинируются по AND; сортировка —
 * `occurred_at_ms DESC` (как и обещает операция 70dfe81d).
 */
export function listActivity(
  ndb: NetworkDb,
  params: ActivityListParams,
  opts: ActivityListOptions = {},
): ActivityListResult {
  const { limit, offset } = normalizeActivityPagination(params);
  let ast: FilterAst;
  if (params.ast !== undefined) {
    assertFilterAstInProfile(params.ast, 'events', opts.requestId);
    const diag = diagnoseFilterAst(ndb, params.ast);
    if (diag.errors.length > 0) throw filterDiagnosticsError(diag.errors);
    ast = params.ast;
  } else {
    ast = compileActivityToAst(params);
  }
  const clause = activityAstNodeClause(ndb, ast.filter, opts);
  const whereClause = `network_id = ? AND (${clause.sql})`;
  const args: unknown[] = [params.networkId, ...clause.args];

  const total = (
    ndb.prepare(`SELECT COUNT(*) AS c FROM activity_log WHERE ${whereClause}`).get(...args) as {
      c: number;
    }
  ).c;

  const page = ndb
    .prepare(
      `SELECT id, network_id, user_id, action, entity_type, entity_id,
              entity_title, layer_id, occurred_at_ms
       FROM activity_log
       WHERE ${whereClause}
       ORDER BY occurred_at_ms DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as ActivityDbRow[];

  return {
    data: page.map(toActivityRow),
    total,
    limit,
    offset,
  };
}

// ---------------------------------------------------------------------------
// Удобные обёртки «записал + сразу собрал снимок» для типичных сценариев.
// Они не пытаются быть универсальными — все нужные поля уже есть в DTO,
// которое вернул мутирующий сервис (роут получает его до `recordActivity`).
// ---------------------------------------------------------------------------

/** Записать событие по мысли: роут передаёт результат `createThought`/`getThought`. */
export function recordThoughtActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    thought: Pick<Thought, 'id' | 'title' | 'type_id'>;
    layerId: string | null;
    occurredAtMs?: number;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'thought',
    entityId: params.thought.id,
    entityTitle: snapshotThought(params.thought),
    layerId: params.layerId,
    occurredAtMs: params.occurredAtMs,
  });
}

/** Записать событие по связи. */
export function recordLinkActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    link: Pick<Link, 'id' | 'source_id' | 'target_id' | 'type_id'>;
    layerId: string | null;
    occurredAtMs?: number;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'link',
    entityId: params.link.id,
    entityTitle: snapshotLink(params.link),
    layerId: params.layerId,
    occurredAtMs: params.occurredAtMs,
  });
}

/** Записать событие по типу мысли. */
export function recordThoughtTypeActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    type: Pick<ThoughtType, 'id' | 'name'>;
    layerId: string | null;
    occurredAtMs?: number;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'thought_type',
    entityId: params.type.id,
    entityTitle: snapshotThoughtType(params.type),
    layerId: params.layerId,
    occurredAtMs: params.occurredAtMs,
  });
}

/** Записать событие по типу связи. */
export function recordLinkTypeActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    type: Pick<LinkType, 'id' | 'name_forward'>;
    layerId: string | null;
    occurredAtMs?: number;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'link_type',
    entityId: params.type.id,
    entityTitle: snapshotLinkType(params.type),
    layerId: params.layerId,
    occurredAtMs: params.occurredAtMs,
  });
}

/** Записать событие по свойству реестра сети. */
export function recordPropertyActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    property: Pick<NetworkProperty, 'id' | 'name'>;
    layerId: string | null;
    occurredAtMs?: number;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'property',
    entityId: params.property.id,
    entityTitle: snapshotProperty(params.property),
    layerId: params.layerId,
    occurredAtMs: params.occurredAtMs,
  });
}

/**
 * Записать событие по типу, когда меняется привязка свойства к типу
 * (создание/правка/удаление `type_property`). Сама привязка не выделена в
 * отдельный `entity_type` — пишем как обновление самого типа (требование
 * b0c7a57c). Имя берётся из переданной строки, чтобы не тянуть сюда типы
 * `ThoughtType`/`LinkType` с разным набором полей.
 */
export function recordTypePropertyActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    typeId: string;
    typeName: string;
    layerId: string | null;
    occurredAtMs?: number;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'thought_type',
    entityId: params.typeId,
    entityTitle: `тип мысли «${params.typeName}»`,
    layerId: params.layerId,
    occurredAtMs: params.occurredAtMs,
  });
}

/** Записать событие по комментарию. */
export function recordCommentActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    comment: Pick<Comment, 'id' | 'owner_type' | 'body_md'>;
    layerId: string | null;
    occurredAtMs?: number;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'comment',
    entityId: params.comment.id,
    entityTitle: snapshotComment(params.comment),
    layerId: params.layerId,
    occurredAtMs: params.occurredAtMs,
  });
}

/** Записать событие по вложению. */
export function recordAttachmentActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    attachment: {
      id: string;
      title?: string | null;
      url?: string | null;
      file_path?: string | null;
    };
    layerId: string | null;
    occurredAtMs?: number;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'attachment',
    entityId: params.attachment.id,
    entityTitle: snapshotAttachment(params.attachment),
    layerId: params.layerId,
    occurredAtMs: params.occurredAtMs,
  });
}

/** Записать событие по слою. */
export function recordLayerActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    layer: Pick<Layer, 'id' | 'title'>;
    layerId: string | null;
    occurredAtMs?: number;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'layer',
    entityId: params.layer.id,
    entityTitle: snapshotLayer(params.layer),
    layerId: params.layerId,
    occurredAtMs: params.occurredAtMs,
  });
}

/**
 * Записать событие по публикации (0.11.1, задача c59ce742; требование
 * d4452908): создание, правка настроек, порядок (одна строка на батч),
 * исключение, пересборка, корзина/восстановление/удаление.
 */
export function recordPublicationActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    publication: Pick<Publication, 'id' | 'title'>;
    layerId: string | null;
    occurredAtMs?: number;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'publication',
    entityId: params.publication.id,
    entityTitle: snapshotPublication(params.publication),
    layerId: params.layerId,
    occurredAtMs: params.occurredAtMs,
  });
}

/** Записать событие по полке библиотеки публикаций (0.11.1, d4452908). */
export function recordShelfActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    shelf: Pick<Shelf, 'id' | 'title'>;
    layerId: string | null;
    occurredAtMs?: number;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'shelf',
    entityId: params.shelf.id,
    entityTitle: snapshotShelf(params.shelf),
    layerId: params.layerId,
    occurredAtMs: params.occurredAtMs,
  });
}

// ---------------------------------------------------------------------------
// Обслуживание журнала: свёртка (rollup), обрезка (truncate),
// авто-свёртка при слиянии/удалении слоя — задача 6bcccd2b,
// docs/13-layers.md §8 «свёртка при merge».
//
// Эти операции необратимы: уменьшение числа строк в `activity_log` без
// возможности отката. Клиентское подтверждение — ответственность UI/клиента
// (03-server-api.md §13d); сервер сам по себе ничего не блокирует.
// ---------------------------------------------------------------------------

/** Сводный итог свёртки: сколько строк удалено и сколько оставлено
 * (с разбивкой по сущностям — каждая «живая» группа оставляет 1 или 2 строки,
 * удалённая — ровно 1). */
export interface RollupActivityResult {
  removed: number;
  kept: number;
}

/** Итог обрезки — только счётчик удалённых строк (записи удаляются все). */
export interface TruncateActivityResult {
  removed: number;
}

/** Действия, которые считаются «итогом удаления» сущности для свёртки
 * (требование операции 70dfe81d, 6bcccd2b). `restored` сюда не входит —
 * восстановление не финальное состояние, после него могут быть правки. */
const DELETING_ACTIONS: ReadonlySet<string> = new Set(['deleted', 'trashed']);

/**
 * Свёрнуть журнал активности сети до указанной границы по времени
 * (задача 6bcccd2b, требование 76443b7e «свёртка»).
 *
 * Семантика по каждой **живой** ключевой сущности
 * `(network_id, entity_type, entity_id)`:
 *
 *   - есть `deleted`/`trashed` до `until_ms` — оставляем **только** эту
 *     запись удаления (что, кто, когда), все промежуточные правки удаляются;
 *   - иначе — оставляем самую раннюю запись (`created`/`updated`) и, если
 *     отличается, самую позднюю `updated`.
 *
 * Записи с `occurred_at_ms > until_ms` не трогаются — это «свежее», что
 * пользователь ещё видит.
 *
 * Транзакция одна: `db.transaction(...)` откатывает весь rollup при любом
 * сбое в середине (требование 6bcccd2b).
 */
export function rollupActivity(
  ndb: NetworkDb,
  networkId: string,
  untilMs: number,
): RollupActivityResult {
  if (!Number.isInteger(untilMs) || untilMs < 0) {
    throw new TypeError('untilMs must be a non-negative integer');
  }
  return ndb.transaction(() => {
    // 1. Загружаем все строки до границы — компактно (только нужные поля).
    const rows = ndb
      .prepare(
        `SELECT id, action, entity_type, entity_id, occurred_at_ms
         FROM activity_log
         WHERE network_id = ? AND occurred_at_ms <= ?
         ORDER BY entity_type, entity_id, occurred_at_ms ASC, id ASC`,
      )
      .all(networkId, untilMs) as Array<{
      id: string;
      action: string;
      entity_type: string;
      entity_id: string;
      occurred_at_ms: number;
    }>;

    if (rows.length === 0) {
      return { removed: 0, kept: 0 };
    }

    // 2. Группируем по ключу сущности и вычисляем, какие id оставить.
    const groups = new Map<string, { ids: string[]; keep: Set<string> }>();
    // Сразу строим мапу id -> { occurred_at_ms, action } — она нужна и для
    // группировки, и для сортировки внутри группы. SQL уже вернул строки
    // упорядоченными по (entity_type, entity_id, occurred_at_ms ASC, id ASC),
    // но id всё равно пересортируем явно для стабильности.
    const byId = new Map<string, { occurred_at_ms: number; action: string }>();
    for (const r of rows) {
      byId.set(r.id, { occurred_at_ms: r.occurred_at_ms, action: r.action });
      const key = `${r.entity_type}\u0000${r.entity_id}`;
      let g = groups.get(key);
      if (g === undefined) {
        g = { ids: [], keep: new Set() };
        groups.set(key, g);
      }
      g.ids.push(r.id);
    }

    for (const g of groups.values()) {
      g.ids.sort((a, b) => {
        const ra = byId.get(a) as { occurred_at_ms: number; action: string };
        const rb = byId.get(b) as { occurred_at_ms: number; action: string };
        if (ra.occurred_at_ms !== rb.occurred_at_ms) return ra.occurred_at_ms - rb.occurred_at_ms;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      const lastId = g.ids[g.ids.length - 1] as string;
      const firstId = g.ids[0] as string;
      const lastMeta = byId.get(lastId) as { occurred_at_ms: number; action: string };
      if (DELETING_ACTIONS.has(lastMeta.action)) {
        // Последнее событие — удаление/пометка: оставляем ровно его.
        g.keep.add(lastId);
      } else {
        // Живая сущность: самая ранняя + самая поздняя (если отличается).
        g.keep.add(firstId);
        if (g.ids.length > 1) g.keep.add(lastId);
      }
    }

    // 3. Собираем список id на удаление и удаляем одним батчем.
    const toRemove: string[] = [];
    for (const g of groups.values()) {
      for (const id of g.ids) if (!g.keep.has(id)) toRemove.push(id);
    }
    let removed = 0;
    const del = ndb.prepare(`DELETE FROM activity_log WHERE id = ?`);
    // Бьём на порции, чтобы не упираться в лимит параметров SQLite (999).
    for (let i = 0; i < toRemove.length; i += 500) {
      const chunk = toRemove.slice(i, i + 500);
      removed += chunk.reduce((acc, id) => acc + del.run(id).changes, 0);
    }
    const kept = rows.length - removed;
    return { removed, kept };
  });
}

/**
 * Обрезать журнал активности сети до указанной границы по времени
 * (задача 6bcccd2b, требование 9921a32b «обрезка»). Все записи с
 * `occurred_at_ms <= until_ms` удаляются — и создания, и удаления.
 *
 * Транзакция одна: при сбое состояние журнала не меняется.
 */
export function truncateActivity(
  ndb: NetworkDb,
  networkId: string,
  untilMs: number,
): TruncateActivityResult {
  if (!Number.isInteger(untilMs) || untilMs < 0) {
    throw new TypeError('untilMs must be a non-negative integer');
  }
  return ndb.transaction(() => {
    const result = ndb
      .prepare(
        `DELETE FROM activity_log
         WHERE network_id = ? AND occurred_at_ms <= ?`,
      )
      .run(networkId, untilMs);
    return { removed: result.changes };
  });
}

/** Итог авто-свёртки событий слоя: сколько групп слилось в одну запись
 * и сколько детальных строк удалено из журнала. */
export interface LayerActivityRollupResult {
  /** Сколько ключевых сущностей `(entity_type, entity_id)` получили
   * итоговую запись в журнале (создание/правка/удаление). */
  groups: number;
  /** Сколько строк журнала удалено как детальные. */
  removed: number;
}

/**
 * Авто-свёртка событий одного слоя при его слиянии в родителя
 * (задача 6bcccd2b, требование 1f7f789b «авто-свёртка при слиянии слоя»).
 *
 * По каждой ключевой сущности `(entity_type, entity_id)`, у которой есть
 * хотя бы одна запись в `activity_log` со `snapshot.layer_id = layerId`,
 * в журнал добавляется **ровно одна итоговая запись** в основе
 * (`layer_id = null`):
 *
 *   - `created` — если в слое было событие создания;
 *   - иначе — действие самого позднего события слоя (`updated`/`deleted`/
 *     `trashed`/`restored`).
 *
 * Автор и `occurred_at_ms` берутся из **самого позднего** события слоя
 * (исходного итогового события слоя). `entity_title` — тоже снимок этого
 * события, чтобы итоговая строка оставалась читаемой после удаления самой
 * сущности (требование b0c7a57c).
 *
 * Все детальные строки слоя (`activity_log.layer_id = layerId`) удаляются.
 *
 * Транзакция одна: либо весь набор итоговых записей встаёт + детальные
 * удаляются, либо ничего не меняется.
 */
export function autoRollupLayerActivity(
  ndb: NetworkDb,
  networkId: string,
  layerId: string,
): LayerActivityRollupResult {
  return ndb.transaction(() => {
    const rows = ndb
      .prepare(
        `SELECT id, user_id, action, entity_type, entity_id, entity_title, occurred_at_ms
         FROM activity_log
         WHERE network_id = ? AND layer_id = ?
         ORDER BY entity_type, entity_id, occurred_at_ms ASC, id ASC`,
      )
      .all(networkId, layerId) as Array<{
      id: string;
      user_id: string;
      action: string;
      entity_type: string;
      entity_id: string;
      entity_title: string;
      occurred_at_ms: number;
    }>;

    if (rows.length === 0) {
      return { groups: 0, removed: 0 };
    }

    // Группируем по ключу сущности, сохраняя порядок (occurred_at_ms ASC).
    const groups = new Map<
      string,
      { ids: string[]; latest: (typeof rows)[number]; created: boolean }
    >();
    for (const row of rows) {
      const key = `${row.entity_type}\u0000${row.entity_id}`;
      let g = groups.get(key);
      if (g === undefined) {
        g = { ids: [], latest: row, created: false };
        groups.set(key, g);
      }
      g.ids.push(row.id);
      g.latest = row;
      if (row.action === 'created') g.created = true;
    }

    const insert = ndb.prepare(
      `INSERT INTO activity_log
         (id, network_id, user_id, action, entity_type, entity_id,
          entity_title, layer_id, occurred_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    let groupsWritten = 0;
    for (const g of groups.values()) {
      const finalAction = g.created ? 'created' : g.latest.action;
      insert.run(
        randomUUID(),
        networkId,
        g.latest.user_id,
        finalAction,
        g.latest.entity_type,
        g.latest.entity_id,
        g.latest.entity_title,
        g.latest.occurred_at_ms,
      );
      groupsWritten += 1;
    }

    const del = ndb.prepare(`DELETE FROM activity_log WHERE id = ?`);
    let removed = 0;
    const allIds = [...groups.values()].flatMap((g) => g.ids);
    for (let i = 0; i < allIds.length; i += 500) {
      const chunk = allIds.slice(i, i + 500);
      removed += chunk.reduce((acc, id) => acc + del.run(id).changes, 0);
    }
    return { groups: groupsWritten, removed };
  });
}

/**
 * Удалить все события журнала, привязанные к слою (задача 6bcccd2b).
 * Используется при удалении слоя без слияния (`etn.layers.delete`) —
 * в этом случае детальные события должны исчезнуть без следа.
 *
 * Транзакция одна.
 */
export function deleteLayerActivity(
  ndb: NetworkDb,
  networkId: string,
  layerId: string,
): { removed: number } {
  return ndb.transaction(() => {
    const result = ndb
      .prepare(`DELETE FROM activity_log WHERE network_id = ? AND layer_id = ?`)
      .run(networkId, layerId);
    return { removed: result.changes };
  });
}

/**
 * Записать обновление сущности-владельца, у которой поменялось значение
 * свойства. Используется в `setPropertyValue`/`setPropertyValues`/
 * `deletePropertyValue` — пишем одну строку про владельца, без отдельной
 * записи про само значение (требование b0c7a57c).
 */
export function recordOwnerActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    entityType: ActivityEntityType;
    entity:
      | Pick<Thought, 'id' | 'title' | 'type_id'>
      | Pick<Link, 'id' | 'source_id' | 'target_id' | 'type_id'>
      | { id: string };
    layerId: string | null;
    occurredAtMs?: number;
  },
): void {
  let title: string;
  if ('title' in params.entity) {
    title = snapshotThought(params.entity as Pick<Thought, 'title' | 'type_id'>);
  } else if ('source_id' in params.entity) {
    title = snapshotLink(params.entity as Pick<Link, 'source_id' | 'target_id' | 'type_id'>);
  } else {
    title = params.entity.id;
  }
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: 'updated',
    entityType: params.entityType,
    entityId: params.entity.id,
    entityTitle: title,
    layerId: params.layerId,
    occurredAtMs: params.occurredAtMs,
  });
}
