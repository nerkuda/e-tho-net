/**
 * Валидация формы AST отбора (задача 9c156b8c; требование «Группы AST: И, ИЛИ,
 * НЕ — без ограничения глубины» ad6b3095 и сущность «Модель отбора (AST) и её
 * wire-формат» 489c394f).
 *
 * Валидатор строгий: на каждом уровне (корень, группа, лист, операнд, значение,
 * снапшоты подписей, ключ сортировки) неизвестные поля отклоняются явно —
 * `VALIDATION_ERROR` с перечнем лишних ключей. Принцип «не игнорировать молча»
 * (как у `parsePropertyCondition`, ошибка f4580fff): лишний ключ незаметно менял
 * бы намерение пользователя.
 *
 * Валидируется ТОЛЬКО форма дерева. Семантика оператора по типу операнда
 * (какие операторы допустимы для свойства/типа/предиката) проверяется доменным
 * исполнителем (`query-service.ts`) — там же, где данные о свойствах сети.
 */

import {
  EtnError,
  FILTER_AST_GROUP_OPS,
  FILTER_AST_HIERARCHY_MODES,
  FILTER_AST_OPERATORS,
  FILTER_AST_VERSION,
  STRUCTURE_KEYWORD_SCOPES,
  type FilterAst,
  type FilterAstEntity,
  type FilterAstGroup,
  type FilterAstGroupOp,
  type FilterAstHierarchyMode,
  type FilterAstLabels,
  type FilterAstLeaf,
  type FilterAstListItem,
  type FilterAstNode,
  type FilterAstOperator,
  type FilterAstScalar,
  type FilterAstSortKey,
  type FilterAstTokenValue,
  type FilterAstValue,
  type StructureKeywordScope,
} from '@etn/shared';

/** Допустимые ключи корня wire-формата отбора. */
const ROOT_KEYS = ['version', 'filter', 'sort'] as const;
/** Допустимые ключи группы. */
const GROUP_KEYS = ['op', 'children'] as const;
/** Допустимые ключи условия-листа. */
const LEAF_KEYS = ['entity', 'operator', 'value', 'labels', 'mode'] as const;
/** Допустимые ключи снапшотов подписей. */
const LABELS_KEYS = ['entity', 'value'] as const;
/** Допустимые ключи ключа сортировки. */
const SORT_KEY_KEYS = ['key', 'order'] as const;
/** Допустимые ключи токена. */
const TOKEN_KEYS = ['token'] as const;
/** Допустимые ключи под-выборки. */
const SUBQUERY_KEYS = ['query', 'operator'] as const;

/** Операторы под-выборки как значения. */
const SUBQUERY_OPERATORS = ['in', 'not_in', 'all_in'] as const;

/**
 * Согласованные операторы листа для квантификатора под-выборки (`value.operator`):
 * семантику задаёт только `value.operator`, поэтому внешний `leaf.operator`
 * обязан ему соответствовать (иначе молча игнорировался бы). `all_in` (наборный
 * квантификатор «каждое») соответствует листовому `all_of`.
 */
const SUBQUERY_LEAF_OPERATOR: Record<(typeof SUBQUERY_OPERATORS)[number], readonly FilterAstOperator[]> = {
  in: ['in'],
  not_in: ['not_in'],
  all_in: ['all_of'],
};

/** Виды операндов и допустимые ключи их объектов (дискриминант — `kind`). */
const ENTITY_KEYS: Record<FilterAstEntity['kind'], readonly string[]> = {
  type: ['kind'],
  property: ['kind', 'property_id', 'property', 'direction'],
  link_type: ['kind'],
  parents: ['kind'],
  children: ['kind'],
  attachments: ['kind'],
  chronology: ['kind'],
  comment: ['kind'],
  targets: ['kind'],
  active: ['kind'],
  trashed: ['kind'],
  keywords: ['kind', 'scope'],
  author: ['kind'],
  editor: ['kind'],
  created_at: ['kind'],
  updated_at: ['kind'],
  properties: ['kind'],
};

function fail(message: string, details: Record<string, unknown>, requestId?: string): never {
  throw new EtnError('VALIDATION_ERROR', message, details, requestId);
}

/** Проверить, что объект-запись несёт только перечисленные ключи. */
function assertExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  requestId?: string,
): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    fail(
      `${path}: неизвестные поля: ${unknown.join(', ')}. Допустимы: ${allowed.join(', ')}.`,
      { field: path, fields: unknown },
      requestId,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is FilterAstScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Разобрать и провалидировать форму дерева отбора из недоверенного значения
 * (тело REST/MCP или сохранённый JSON `definition`). Возвращает типизированный
 * {@link FilterAst}; на любой форме, отличной от ожидаемой, — `VALIDATION_ERROR`.
 */
export function parseFilterAst(input: unknown, requestId?: string): FilterAst {
  if (!isPlainObject(input)) {
    fail('Отбор должен быть объектом.', { field: 'filter' }, requestId);
  }
  assertExactKeys(input, ROOT_KEYS, 'Отбор', requestId);

  if (typeof input['version'] !== 'number' || input['version'] !== FILTER_AST_VERSION) {
    fail(
      `Неподдерживаемая версия формы отбора: ожидается ${FILTER_AST_VERSION}.`,
      { field: 'version', expected: FILTER_AST_VERSION },
      requestId,
    );
  }
  if (!('filter' in input)) {
    fail('Отбор обязан нести дерево условий в поле filter.', { field: 'filter' }, requestId);
  }
  const node = parseFilterAstNode(input['filter'], 'filter', requestId);

  const out: FilterAst = { version: FILTER_AST_VERSION, filter: node };
  if (input['sort'] !== undefined) {
    out.sort = parseFilterAstSort(input['sort'], requestId);
  }
  return out;
}

/** Разобрать один узел дерева (группу или условие-лист). */
export function parseFilterAstNode(
  input: unknown,
  path: string,
  requestId?: string,
): FilterAstNode {
  if (!isPlainObject(input)) {
    fail(`${path}: узел отбора должен быть объектом.`, { field: path }, requestId);
  }
  if ('op' in input) return parseGroup(input, path, requestId);
  if ('entity' in input) return parseLeaf(input, path, requestId);
  fail(
    `${path}: узел отбора должен быть группой (поле op) либо условием (поле entity).`,
    { field: path },
    requestId,
  );
}

function parseGroup(input: Record<string, unknown>, path: string, requestId?: string): FilterAstGroup {
  assertExactKeys(input, GROUP_KEYS, path, requestId);
  const op = input['op'];
  if (typeof op !== 'string' || !(FILTER_AST_GROUP_OPS as readonly string[]).includes(op)) {
    fail(`${path}.op: недопустимый оператор группы.`, {
      field: `${path}.op`,
      allowed: FILTER_AST_GROUP_OPS,
    }, requestId);
  }
  const rawChildren = input['children'];
  if (!Array.isArray(rawChildren)) {
    fail(`${path}.children: ожидается массив узлов.`, { field: `${path}.children` }, requestId);
  }
  // `not` — ровно один ребёнок; `and`/`or` — ноль и более (пустая группа
  // нейтральна, сценарий 82187004; группа из одного условия эквивалентна ему).
  if (op === 'not' && rawChildren.length !== 1) {
    fail(`${path}: группа «не» обязана содержать ровно один дочерний узел.`, {
      field: `${path}.children`,
      count: rawChildren.length,
    }, requestId);
  }
  const children = rawChildren.map((child, i) =>
    parseFilterAstNode(child, `${path}.children[${i}]`, requestId),
  );
  return { op: op as FilterAstGroupOp, children };
}

function parseLeaf(input: Record<string, unknown>, path: string, requestId?: string): FilterAstLeaf {
  assertExactKeys(input, LEAF_KEYS, path, requestId);
  const entity = parseEntity(input['entity'], `${path}.entity`, requestId);
  const operator = input['operator'];
  if (typeof operator !== 'string' || !(FILTER_AST_OPERATORS as readonly string[]).includes(operator)) {
    fail(`${path}.operator: недопустимый оператор условия.`, {
      field: `${path}.operator`,
      allowed: FILTER_AST_OPERATORS,
    }, requestId);
  }
  const leaf: FilterAstLeaf = { entity, operator: operator as FilterAstOperator };
  if (input['value'] !== undefined) {
    leaf.value = parseValue(input['value'], `${path}.value`, requestId);
    // Значение-под-выборка: внешний оператор листа обязан быть согласован с
    // квантификатором `value.operator` — семантику задаёт он, внешний молча
    // игнорироваться не должен (задача 8914ac36, замечание верификатора).
    const value = leaf.value;
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'query' in value) {
      const allowed = SUBQUERY_LEAF_OPERATOR[value.operator];
      if (!allowed.includes(leaf.operator)) {
        fail(
          `${path}: оператор условия «${leaf.operator}» не согласован с оператором под-выборки «${value.operator}»; допустимо: ${allowed.join(', ')}.`,
          { field: `${path}.operator`, operator: leaf.operator, subquery_operator: value.operator },
          requestId,
        );
      }
    }
    // «Между»/«не между»: список-значение — ровно две границы (каждая —
    // литерал или токен, требование 84b52caa). Одиночный скаляр/токен
    // допустим — трактуется как обе совпавшие границы (эквивалент равенства).
    if (
      (leaf.operator === 'between' || leaf.operator === 'not_between') &&
      Array.isArray(value) &&
      value.length !== 2
    ) {
      fail(`${path}.value: оператор «между» требует ровно две границы.`, {
        field: `${path}.value`,
        count: value.length,
      }, requestId);
    }
  }
  if (input['labels'] !== undefined) {
    leaf.labels = parseLabels(input['labels'], `${path}.labels`, requestId);
  }
  if (input['mode'] !== undefined) {
    const mode = input['mode'];
    if (typeof mode !== 'string' || !(FILTER_AST_HIERARCHY_MODES as readonly string[]).includes(mode)) {
      fail(`${path}.mode: недопустимый режим обхода «в иерархии».`, {
        field: `${path}.mode`,
        allowed: FILTER_AST_HIERARCHY_MODES,
      }, requestId);
    }
    leaf.mode = mode as FilterAstHierarchyMode;
  }
  return leaf;
}

function parseEntity(input: unknown, path: string, requestId?: string): FilterAstEntity {
  if (!isPlainObject(input)) {
    fail(`${path}: операнд должен быть объектом.`, { field: path }, requestId);
  }
  const kind = input['kind'];
  if (typeof kind !== 'string' || !(kind in ENTITY_KEYS)) {
    fail(`${path}.kind: неизвестный операнд.`, {
      field: `${path}.kind`,
      allowed: Object.keys(ENTITY_KEYS),
    }, requestId);
  }
  const allowed = ENTITY_KEYS[kind as FilterAstEntity['kind']]!;
  assertExactKeys(input, allowed, path, requestId);

  switch (kind) {
    case 'property': {
      const propertyId = input['property_id'];
      const property = input['property'];
      if (propertyId === undefined && property === undefined) {
        fail(`${path}: операнд «свойство» обязан задать property_id или property.`, {
          field: path,
        }, requestId);
      }
      if (propertyId !== undefined && (typeof propertyId !== 'string' || propertyId === '')) {
        fail(`${path}.property_id: ожидается непустая строка.`, { field: `${path}.property_id` }, requestId);
      }
      if (property !== undefined && (typeof property !== 'string' || property === '')) {
        fail(`${path}.property: ожидается непустая строка.`, { field: `${path}.property` }, requestId);
      }
      const direction = input['direction'];
      if (direction !== undefined && direction !== 'out' && direction !== 'in') {
        fail(`${path}.direction: ожидается "out" или "in".`, { field: `${path}.direction` }, requestId);
      }
      return {
        kind: 'property',
        property_id: propertyId as string | undefined,
        property: property as string | undefined,
        direction: direction as 'out' | 'in' | undefined,
      };
    }
    case 'keywords': {
      const scope = input['scope'];
      if (scope !== undefined) {
        if (
          !Array.isArray(scope) ||
          scope.some(
            (v) => typeof v !== 'string' || !(STRUCTURE_KEYWORD_SCOPES as readonly string[]).includes(v),
          )
        ) {
          fail(`${path}.scope: ожидается массив областей поиска.`, {
            field: `${path}.scope`,
            allowed: STRUCTURE_KEYWORD_SCOPES,
          }, requestId);
        }
        return { kind: 'keywords', scope: [...new Set(scope as StructureKeywordScope[])] };
      }
      return { kind: 'keywords' };
    }
    default:
      return { kind } as FilterAstEntity;
  }
}

/** Разобрать и провалидировать значение-токен `{ token: "…" }`. */
function parseTokenValue(input: Record<string, unknown>, path: string, requestId?: string): FilterAstTokenValue {
  assertExactKeys(input, TOKEN_KEYS, path, requestId);
  const token = input['token'];
  if (typeof token !== 'string' || token.trim() === '') {
    fail(`${path}.token: ожидается непустая строка токена.`, { field: `${path}.token` }, requestId);
  }
  return { token };
}

function parseValue(input: unknown, path: string, requestId?: string): FilterAstValue {
  if (Array.isArray(input)) {
    // Список значений: каждый элемент — литерал ИЛИ токен. Токены в списке
    // нужны оператору «между», где каждая граница может быть токеном
    // (требование 84b52caa: `[{token:"$weekStart-1d"},{token:"$today"}]`).
    const out: FilterAstListItem[] = [];
    for (let i = 0; i < input.length; i += 1) {
      const el = input[i];
      if (isScalar(el)) {
        out.push(el);
        continue;
      }
      if (isPlainObject(el) && 'token' in el) {
        out.push(parseTokenValue(el, `${path}[${i}]`, requestId));
        continue;
      }
      fail(`${path}[${i}]: элемент списка должен быть скаляром или токеном.`, {
        field: `${path}[${i}]`,
      }, requestId);
    }
    return out;
  }
  if (isScalar(input)) return input;
  if (isPlainObject(input)) {
    if ('token' in input) {
      return parseTokenValue(input, path, requestId);
    }
    if ('query' in input) {
      assertExactKeys(input, SUBQUERY_KEYS, path, requestId);
      const op = input['operator'];
      if (typeof op !== 'string' || !(SUBQUERY_OPERATORS as readonly string[]).includes(op)) {
        fail(`${path}.operator: недопустимый оператор под-выборки.`, {
          field: `${path}.operator`,
          allowed: SUBQUERY_OPERATORS,
        }, requestId);
      }
      return {
        query: parseFilterAstNode(input['query'], `${path}.query`, requestId),
        operator: op as 'in' | 'not_in' | 'all_in',
      };
    }
  }
  fail(`${path}: значение должно быть скаляром, списком, токеном или под-выборкой.`, {
    field: path,
  }, requestId);
}

function parseLabels(input: unknown, path: string, requestId?: string): FilterAstLabels {
  if (!isPlainObject(input)) {
    fail(`${path}: снапшоты подписей должны быть объектом.`, { field: path }, requestId);
  }
  assertExactKeys(input, LABELS_KEYS, path, requestId);
  const out: FilterAstLabels = {};
  for (const key of LABELS_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      fail(`${path}.${key}: подпись должна быть строкой.`, { field: `${path}.${key}` }, requestId);
    }
    out[key] = value;
  }
  return out;
}

function parseFilterAstSort(input: unknown, requestId?: string): FilterAstSortKey[] {
  if (!Array.isArray(input)) {
    fail('sort: ожидается массив ключей сортировки.', { field: 'sort' }, requestId);
  }
  return input.map((raw, i) => {
    const path = `sort[${i}]`;
    if (!isPlainObject(raw)) {
      fail(`${path}: ключ сортировки должен быть объектом.`, { field: path }, requestId);
    }
    assertExactKeys(raw, SORT_KEY_KEYS, path, requestId);
    const key = raw['key'];
    if (typeof key !== 'string' || key === '') {
      fail(`${path}.key: ожидается непустая строка.`, { field: `${path}.key` }, requestId);
    }
    const order = raw['order'];
    if (order !== 'asc' && order !== 'desc') {
      fail(`${path}.order: ожидается "asc" или "desc".`, { field: `${path}.order` }, requestId);
    }
    return { key, order };
  });
}
