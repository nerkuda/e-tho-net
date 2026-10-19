/**
 * Сторож паритета наборов операторов отбора (задача 19e7f439, ретро 0.13.1
 * п.5, кластер K2). Единый инвариант — «один набор операторов в реестре,
 * справке, конструкторе и исполнителе» — проверяется двумя частями по
 * пакетам: серверная (этот файл: справка ↔ реестр ↔ исполнитель ↔ ключи
 * сортировки) и клиентская (`client/tests/guard-filter-operators-parity.test.ts`:
 * конструктор ↔ реестр). Кросс-пакетный импорт запрещён `rootDir` тестовых
 * tsconfig, поэтому «программно читать все источники» одним файлом нельзя —
 * части ссылаются друг на друга и вместе закрывают K2.
 *
 * ## Справка ↔ реестр
 *
 * Списки операторов в темах `etn.guide` — зеркало реестра профилей
 * (`shared/src/filter-profiles.ts`). Исходные дефекты: 71f547c1 (тема
 * `activity.list` обещала `eq/ne/contains` для «Типа действия» — профиль
 * принимает только `in/not_in`), 6a224eba (таблица мыслей занижала наборы).
 * Каждый операнд профиля документирован и называет РОВНО набор реестра;
 * тема не объявляет операндов вне профиля.
 *
 * Охвачены четыре источника-списка: `thoughts.query` (профиль `thoughts`,
 * включая `property: <value_type>`), `activity.list` (профиль `events`),
 * секция «Профиль «хроника»» темы мыслей (профиль `chronicle`) и секция
 * «Эффекты» действия `attachments.search` (профиль `attachments`; отдельной
 * темы `etn.guide` у вложений нет). Списки обязаны быть буллет-формата
 * `` - `operand` — `a/b/c` … `` — иначе парсер их не увидит.
 *
 * **ВНИМАНИЕ: реестр читается из собранного `@etn/shared` (`dist`).**
 * Мутации `shared/src/filter-profiles.ts` проверяй только после
 * `npm -w @etn/shared run build`: без сборки сторож останется зелёным на
 * старом `dist`. Процесс тестов намеренно не собирает shared (pretest —
 * отдельное решение).
 *
 * ## Реестр ↔ исполнитель
 *
 * Для каждого профиля каждый оператор реестра собирается в лист AST,
 * проходит строгий разбор (`parseFilterAst`) и исполняется настоящим
 * движком точки. Отдельно для профиля мыслей сверяется и обратная сторона:
 * исполнитель клауз (`buildThoughtIdSelect`, без гейта профиля) принимает
 * ТОЛЬКО операторы реестра — иначе оператор, который движок умеет, остался
 * бы недоступен пользователю (класс ошибки 03db4cb0: у датовых операндов не
 * было `eq`/`ne`). Для хроники/событий/вложений публичный входной точки
 * сначала применяет гейт профиля, поэтому их клаузы программно неотличимы
 * от гейта; проверяется направление «реестр ⊆ исполнитель» (обещание без
 * поддержки), а обратное закрыто явной проверкой датовых `eq`/`ne`.
 *
 * Датовые наборы (`eq`/`ne` у `created_at`/`updated_at`/`record_time`/
 * `occurred_at` и `PROPERTY_OPERATOR_SETS.date`) проверяются отдельно —
 * ошибка 03db4cb0.
 *
 * ## Ключи сортировки
 *
 * Конструктор (`client/src/renderer/lib/filter-sort.ts`) строит словарь из
 * движковых ключей (`title`/`created_at`/`updated_at`), свойств реестра и
 * ОБЕИХ сторон свойств-связей. Исполнитель обязан принять каждый такой ключ
 * (прецедент 335b23cb: конструктор предлагал ключ, исполнитель отвечал
 * `VALIDATION_ERROR`). Здесь проверяется исполнительская сторона: движковые
 * коды, свойство по id, по имени и по имени обратной стороны; неизвестный
 * ключ отвергается и краснеет диагностикой. Клиентская часть сторожа
 * проверяет, что конструктор выдаёт ровно эти классы ключей.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import {
  FILTER_AST_OPERATORS,
  FILTER_AST_VERSION,
  FILTER_PROFILES,
  PROPERTY_OPERATOR_SETS,
  type FilterAst,
  type FilterAstEntityKind,
  type FilterAstNode,
  type FilterAstOperator,
  type FilterProfileId,
  type PropertyValueType,
} from '@etn/shared';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { listActivity } from '../src/domain/activity-service.js';
import { searchAttachmentsByAst } from '../src/domain/attachment-service.js';
import { parseChronicleQueryBody, queryChronicle } from '../src/domain/chronicle-service.js';
import { parseFilterAst } from '../src/domain/filter-ast.js';
import { diagnoseFilterAst } from '../src/domain/filter-diagnostics.js';
import { assertFilterAstInProfile } from '../src/domain/filter-profile-validation.js';
import { buildThoughtIdSelect } from '../src/domain/query-service.js';
import { GUIDE_TOPICS_BY_NAME, OPS_ACTIONS_BY_NAME } from '../src/mcp/tools/ops-catalog.js';

const REQUEST_ID = 'guard-filter-operators';

// ---------------------------------------------------------------------------
// Справка ↔ реестр
// ---------------------------------------------------------------------------

/** Буллет темы: `- \`operand\` — …`; полиморфный — `- \`operand: variant\` — …`. */
const OPERAND_BULLET = /^-\s+`([a-z_]+(?::\s+[a-z_]+)?)`\s+—\s+(.*)$/;

/** Спан-перечисление операторов `` `a/b/c` `` (минимум два через `/`). */
const OPERATOR_SPAN = /`([a-z][a-z_]*\/[a-z_/]*)`/g;

/** Одиночный оператор: первый бэктик-сегмент после тире (напр. `matches`). */
const LEADING_OPERATOR_LIST = /^`([a-z][a-z_]*)`/;

/**
 * Секция темы со списком операндов: от строки с маркером до ближайшего заголовка
 * (`# …`). Вне неё буллеты `` - `limit` — … `` описывают параметры пагинации, а не
 * операнды, и в сверку попадать не должны.
 */
function operandSection(bodyMd: string, marker: string): string {
  const lines = bodyMd.split('\n');
  const start = lines.findIndex((l) => l.includes(marker));
  assert.ok(start !== -1, `в теме не найдена секция операндов («${marker}»)`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]!.startsWith('#')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Операторы, объявленные в буллетах темы по операндам. Возврат — карта
 * `operand → Set<operator>`; операнд без буллета в карту не попадает. Сначала
 * собираются спаны-перечисления со слэшами; если таких нет — берётся одиночный
 * оператор из первого бэктик-сегмента после тире.
 */
function declaredOperators(section: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const line of section.split('\n')) {
    const bullet = OPERAND_BULLET.exec(line);
    if (bullet === null) continue;
    const [, operand, rest] = bullet;
    const ops = out.get(operand!) ?? new Set<string>();
    OPERATOR_SPAN.lastIndex = 0;
    let span: RegExpExecArray | null;
    while ((span = OPERATOR_SPAN.exec(rest!)) !== null) {
      for (const op of span[1]!.split('/')) if (op.length > 0) ops.add(op);
    }
    if (ops.size === 0) {
      const lead = LEADING_OPERATOR_LIST.exec(rest!);
      if (lead !== null) ops.add(lead[1]!);
    }
    out.set(operand!, ops);
  }
  return out;
}

/**
 * Сверка извлекаемого списка операндов с реестром профиля: полнота и точность
 * по каждому операнду (прямая проверка) плюс отсутствие операндов вне профиля
 * (обратная). `sourceLabel` — человекочитаемое имя источника для сообщения.
 */
function assertSectionMatchesRegistry(
  profileId: FilterProfileId,
  sourceLabel: string,
  section: string,
): void {
  const profile = FILTER_PROFILES[profileId];
  const registry = profile.operand_operators!;
  const byValueType = profile.operand_operators_by_value_type;
  const declared = declaredOperators(section);

  /** Ключи-поднаборы полиморфного операнда (`property: <value_type>`). */
  const variantKeys = new Set<string>();

  for (const [operand, expected] of Object.entries(registry)) {
    if (byValueType !== undefined && operand === 'property') {
      // Полиморфный операнд: буллет-указатель + по одному набору на `value_type`.
      assert.ok(declared.has('property'), `операнд «property» не документирован в ${sourceLabel}`);
      for (const [valueType, vtOps] of Object.entries(byValueType)) {
        const key = `property: ${valueType}`;
        variantKeys.add(key);
        const actual = declared.get(key);
        assert.ok(actual !== undefined, `«${key}» не документирован в ${sourceLabel}`);
        assert.deepEqual(
          [...actual].sort(),
          [...vtOps].sort(),
          `операторы «${key}» в ${sourceLabel} разошлись с реестром профиля ${profileId}`,
        );
      }
      continue;
    }
    const actual = declared.get(operand);
    assert.ok(actual !== undefined, `операнд «${operand}» не документирован в ${sourceLabel}`);
    assert.ok(actual.size > 0, `буллет «${operand}» в ${sourceLabel} не называет операторов`);
    assert.deepEqual(
      [...actual].sort(),
      [...expected].sort(),
      `операторы «${operand}» в ${sourceLabel} разошлись с реестром профиля ${profileId}`,
    );
  }

  // Обратная сторона: источник не объявляет операндов, которых нет в профиле.
  for (const operand of declared.keys()) {
    assert.ok(
      operand in registry || variantKeys.has(operand),
      `${sourceLabel} документирует операнд «${operand}», которого нет в профиле ${profileId}`,
    );
  }
}

/** Сверка буллет-секции темы `etn.guide` с реестром профиля. */
function assertTopicMatchesRegistry(
  profileId: FilterProfileId,
  topicName: string,
  marker: string,
): void {
  const topic = GUIDE_TOPICS_BY_NAME.get(topicName);
  assert.ok(topic !== undefined, `тема ${topicName} обязана быть в реестре гайда`);
  assertSectionMatchesRegistry(
    profileId,
    `теме ${topicName}`,
    operandSection(topic.body_md, marker),
  );
}

/**
 * Сверка секции «Эффекты» действия MCP (`etn.guide` отдаёт её в `effects`)
 * с реестром профиля. Профиль «вложения» документирован только здесь — темы
 * `etn.guide` для него нет.
 */
function assertEffectsMatchRegistry(profileId: FilterProfileId, action: string): void {
  const entry = OPS_ACTIONS_BY_NAME.get(action);
  assert.ok(entry !== undefined, `действие ${action} обязано быть в реестре гайда`);
  assert.ok(
    typeof entry.effects === 'string' && entry.effects !== '',
    `у действия ${action} обязана быть секция «Эффекты» со списком операндов`,
  );
  assertSectionMatchesRegistry(profileId, `эффектах ${action}`, entry.effects);
}

describe('guard: списки операторов темы гайда = реестр профилей (71f547c1, 6a224eba)', () => {
  it('thoughts.query: операнды профиля мыслей документированы ровно по реестру', () => {
    assertTopicMatchesRegistry('thoughts', 'thoughts.query', 'Операнды (`entity.kind`)');
  });

  it('activity.list: каждый операнд профиля «события» документирован ровно по реестру', () => {
    assertTopicMatchesRegistry('events', 'activity.list', 'Операнды записи события');
  });

  it('thoughts.query: операнды профиля «хроника» документированы ровно по реестру', () => {
    assertTopicMatchesRegistry('chronicle', 'thoughts.query', '### Профиль «хроника»');
  });

  it('attachments.search: операнды профиля «вложения» документированы ровно по реестру', () => {
    assertEffectsMatchRegistry('attachments', 'attachments.search');
  });
});

// ---------------------------------------------------------------------------
// Реестр ↔ исполнитель
// ---------------------------------------------------------------------------

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const BASE_LAYER = '00000000-0000-4000-8000-0000000000ba5e';
const USER = '00000000-0000-4000-8000-000000000001';

/** Значение-подвыборка: `id in [мысль]` (внутренний узел дерева мыслей). */
function subqueryValue(operator: 'in' | 'not_in' | 'all_in', thoughtId: string): unknown {
  return {
    query: { entity: { kind: 'id' }, operator: 'in', value: [thoughtId] },
    operator,
  };
}

/** Среда исполнения: сеть в памяти с сущностями, на которые ссылаются значения. */
interface ExecFixture {
  db: NetworkDb;
  thoughtId: string;
  typeId: string;
  linkTypeId: string;
  /** Свойство каждого вида значения (для оператора «Свойство»). */
  propIds: Record<PropertyValueType, string>;
  /** Свойство-связь: имя и имя обратной стороны (ключи сортировки). */
  linkPropId: string;
  linkPropForward: string;
  linkPropReverse: string;
}

function seedThought(db: NetworkDb, title: string): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root, version,
                           created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00.000Z', 'u', '2024-01-01T00:00:00.000Z', 'u')`,
  ).run(id, title, title.toLowerCase());
  return id;
}

function seedProperty(db: NetworkDb, name: string, valueType: string, config: string | null): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description,
                             created_at, updated_at)
     VALUES (?, ?, ?, lower(?), ?, ?, NULL, '2024', '2024')`,
  ).run(id, BASE_LAYER, name, name, valueType, config);
  return id;
}

function buildFixture(): ExecFixture {
  const db = createInMemoryNetworkDb();
  const thoughtId = seedThought(db, 'guard');
  seedThought(db, 'guard-2');

  const typeId = randomUUID();
  db.prepare(
    `INSERT INTO thought_types (id, layer_id, name, name_key, description,
                                created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, 'GuardType', 'guardtype', NULL, '2024', '2024', 'u', 'u')`,
  ).run(typeId, BASE_LAYER);

  const linkTypeId = randomUUID();
  db.prepare(
    `INSERT INTO link_types (id, layer_id, name_forward, name_reverse, name_forward_key,
                             name_reverse_key, description, created_at, updated_at,
                             created_by, updated_by)
     VALUES (?, ?, 'GuardLink', 'GuardBack', 'guardlink', 'guardback', NULL,
             '2024', '2024', 'u', 'u')`,
  ).run(linkTypeId, BASE_LAYER);

  const propIds = {} as Record<PropertyValueType, string>;
  const valueTypes: PropertyValueType[] = [
    'text',
    'url',
    'date',
    'number',
    'bool',
    'link',
    'thought_ref',
    'cross_network_ref',
    'publication',
  ];
  for (const valueType of valueTypes) {
    // Свойство-связь носит имя прямой стороны своего типа связи — как в
    // онтологии (`ontology.write` создаёт их парой). Только тогда конструктор
    // строит ключ обратной стороны (335b23cb).
    const name = valueType === 'link' ? 'GuardLink' : `guard-${valueType}`;
    propIds[valueType] = seedProperty(
      db,
      name,
      valueType,
      valueType === 'link' ? JSON.stringify({ link_type_id: linkTypeId }) : null,
    );
  }

  return {
    db,
    thoughtId,
    typeId,
    linkTypeId,
    propIds,
    linkPropId: propIds.link,
    linkPropForward: 'GuardLink',
    linkPropReverse: 'GuardBack',
  };
}

/** Датовый операнд (значение — дата/токен, `between` — две даты). */
function isDateOperand(kind: FilterAstEntityKind, valueType?: PropertyValueType): boolean {
  return (
    valueType === 'date' ||
    kind === 'created_at' ||
    kind === 'updated_at' ||
    kind === 'record_time' ||
    kind === 'occurred_at'
  );
}

/** Операнд «количество»: значения — числа (`gt`/`between` считают элементы). */
function isCountOperand(kind: FilterAstEntityKind, valueType?: PropertyValueType): boolean {
  return (
    valueType === 'number' ||
    valueType === 'link' ||
    kind === 'parents' ||
    kind === 'children' ||
    kind === 'attachments' ||
    kind === 'chronology' ||
    kind === 'size' ||
    kind === 'owner'
  );
}

/**
 * Значение листа под оператор — ровно та форма, которую строит конструктор UI
 * (списки для наборных операторов, две границы для «между», числа для
 * «количества», под-выборка только там, где форма обязательна).
 */
function conditionValue(
  f: ExecFixture,
  kind: FilterAstEntityKind,
  operator: FilterAstOperator,
  valueType?: PropertyValueType,
): unknown {
  if (operator === 'is_empty' || operator === 'not_empty') return undefined;
  if (operator === 'has' || operator === 'not_has') return [f.propIds.text];
  if (operator === 'matches') return 'x';

  if (operator === 'between' || operator === 'not_between') {
    if (isDateOperand(kind, valueType)) return ['2024-01-01', '2024-12-31'];
    if (isCountOperand(kind, valueType)) return [1, 2];
    return ['a', 'b'];
  }
  if (operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte') {
    if (isDateOperand(kind, valueType)) return '2024-01-01';
    if (isCountOperand(kind, valueType)) return 1;
    return 'a';
  }

  if (
    operator === 'in' ||
    operator === 'not_in' ||
    operator === 'any_of' ||
    operator === 'all_of' ||
    operator === 'none_of' ||
    operator === 'in_hierarchy' ||
    operator === 'not_in_hierarchy'
  ) {
    if (kind === 'type') return [f.typeId];
    if (kind === 'link_type') return [f.linkTypeId];
    if (kind === 'action' || kind === 'entity_type' || kind === 'kind') return ['thought'];
    if (kind === 'name' || kind === 'mime_type') return ['x'];
    if (
      kind === 'author' ||
      kind === 'editor' ||
      kind === 'record_author' ||
      kind === 'record_editor' ||
      kind === 'user'
    ) {
      return [USER];
    }
    if (kind === 'targets') {
      // «Все цели» — только под-выборка (плоский список даёт «хотя бы одна»).
      return operator === 'all_of' ? subqueryValue('all_in', f.thoughtId) : [f.thoughtId];
    }
    if (kind === 'entity_id') {
      return operator === 'all_of' ? subqueryValue('all_in', f.thoughtId) : [f.thoughtId];
    }
    if (kind === 'owner') {
      if (operator === 'in_hierarchy' || operator === 'not_in_hierarchy') {
        return [f.thoughtId];
      }
      if (operator === 'all_of') return subqueryValue('all_in', f.thoughtId);
      return subqueryValue(operator === 'in' ? 'in' : 'not_in', f.thoughtId);
    }
    return [f.thoughtId];
  }

  // eq/ne
  if (kind === 'comment' || kind === 'active' || kind === 'trashed' || valueType === 'bool') {
    return true;
  }
  if (kind === 'attachments' || kind === 'chronology' || isCountOperand(kind, valueType)) return 1;
  if (isDateOperand(kind, valueType)) return '2024-01-01';
  if (kind === 'action' || kind === 'entity_type' || kind === 'entity_title') return 'x';
  if (
    kind === 'record_title' ||
    kind === 'record_body' ||
    kind === 'name' ||
    kind === 'kind' ||
    kind === 'mime_type' ||
    kind === 'keywords'
  ) {
    return 'x';
  }
  if (
    kind === 'author' ||
    kind === 'editor' ||
    kind === 'record_author' ||
    kind === 'record_editor' ||
    kind === 'user'
  ) {
    return USER;
  }
  // Одиночные операнды «Тип»/«Тип связи»: значение — id соответствующей сущности.
  if (kind === 'type') return f.typeId;
  if (kind === 'link_type') return f.linkTypeId;
  if (valueType === 'text' || valueType === 'url') return 'x';
  if (valueType === 'cross_network_ref' || valueType === 'publication') return 'addr';
  // Ссылочные операнды и свойства: id существующей мысли.
  return f.thoughtId;
}

/** Лист AST для пары операнд × оператор. */
function buildLeaf(
  f: ExecFixture,
  kind: FilterAstEntityKind,
  operator: FilterAstOperator,
  valueType?: PropertyValueType,
): FilterAstNode {
  const entity =
    kind === 'property'
      ? { kind: 'property' as const, property_id: f.propIds[valueType!] }
      : { kind };
  const value = conditionValue(f, kind, operator, valueType);
  return (
    value === undefined ? { entity, operator } : { entity, operator, value }
  ) as unknown as FilterAstNode;
}

/** Разбор wire-формы листа (контракт REST/MCP) + AST. */
function parseLeaf(f: ExecFixture, node: FilterAstNode): FilterAst {
  return parseFilterAst({ version: FILTER_AST_VERSION, filter: node }, REQUEST_ID);
}

/** Исполнить лист профиля «мысли» на клаузах (без гейта профиля). */
function execThoughtLeaf(f: ExecFixture, node: FilterAstNode): void {
  const sel = buildThoughtIdSelect(f.db, USER, {
    sort: 'alpha',
    order: 'asc',
    limit: 1,
    offset: 0,
    ast: { version: FILTER_AST_VERSION, filter: node },
  });
  f.db.prepare(sel.sql).all(...sel.params);
}

/** Исполнить лист профиля точки — публичным входом (гейт профиля + клаузы). */
function execProfileLeaf(
  f: ExecFixture,
  profile: Exclude<FilterProfileId, 'thoughts' | 'map' | 'publications'>,
  node: FilterAstNode,
): void {
  const ast = parseLeaf(f, node);
  switch (profile) {
    case 'chronicle': {
      const request = parseChronicleQueryBody(
        { ast, order: 'asc', limit: 1, offset: 0 },
        REQUEST_ID,
      );
      queryChronicle(f.db, request, {
        userId: USER,
        now: () => new Date('2024-03-15T12:00:00.000Z'),
        withTime: true,
      });
      return;
    }
    case 'events':
      listActivity(f.db, { networkId: 'guard-network', ast }, { requestId: REQUEST_ID });
      return;
    case 'attachments':
      searchAttachmentsByAst(f.db, ast, { limit: 1, offset: 0 }, { requestId: REQUEST_ID });
      return;
  }
}

/** Пары «операнд × оператор» из реестра профиля (свойство — по природе). */
function registryPairs(profile: FilterProfileId): Array<{
  kind: FilterAstEntityKind;
  operator: FilterAstOperator;
  valueType?: PropertyValueType;
}> {
  const p = FILTER_PROFILES[profile];
  const out: Array<{ kind: FilterAstEntityKind; operator: FilterAstOperator; valueType?: PropertyValueType }> = [];
  for (const [kind, ops] of Object.entries(p.operand_operators!)) {
    if (kind === 'property') continue;
    for (const operator of ops) out.push({ kind: kind as FilterAstEntityKind, operator });
  }
  const byType = p.operand_operators_by_value_type;
  if (byType !== undefined) {
    for (const [valueType, ops] of Object.entries(byType)) {
      for (const operator of ops) {
        out.push({ kind: 'property', operator, valueType: valueType as PropertyValueType });
      }
    }
  }
  return out;
}

describe(
  'guard: исполнитель принимает каждый оператор реестра (19e7f439)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let f: ExecFixture;
    before(() => {
      f = buildFixture();
    });

    it('профиль «мысли»: реестр ⊆ клаузы исполнителя (все операнды и природы свойства)', () => {
      for (const pair of registryPairs('thoughts')) {
        const node = buildLeaf(f, pair.kind, pair.operator, pair.valueType);
        const ast = parseLeaf(f, node);
        // Гейт каждой точки, отбирающей мысли: профили делят наборы, но
        // видимость операндов проверяется отдельно профилем точки.
        for (const profile of ['thoughts', 'map', 'publications'] as const) {
          assertFilterAstInProfile(ast, profile);
        }
        assert.doesNotThrow(
          () => execThoughtLeaf(f, node),
          `исполнитель отверг ${pair.kind}${pair.valueType === undefined ? '' : `:${pair.valueType}`}.${pair.operator}`,
        );
      }
    });

    it('профиль «мысли»: исполнитель клауз не принимает операторов вне реестра операнда (03db4cb0)', () => {
      const sets = FILTER_PROFILES.thoughts.operand_operators!;
      const byType = FILTER_PROFILES.thoughts.operand_operators_by_value_type!;
      for (const [kind, ops] of Object.entries(sets)) {
        if (kind === 'property') continue;
        for (const operator of FILTER_AST_OPERATORS) {
          if ((ops as readonly string[]).includes(operator)) continue;
          const node = buildLeaf(f, kind as FilterAstEntityKind, operator);
          assert.throws(
            () => execThoughtLeaf(f, parseLeaf(f, node).filter),
            `${kind}.${operator} должен быть отвергнут: оператор не входит в набор реестра`,
          );
        }
      }
      for (const [valueType, ops] of Object.entries(byType)) {
        for (const operator of FILTER_AST_OPERATORS) {
          if ((ops as readonly string[]).includes(operator)) continue;
          const node = buildLeaf(f, 'property', operator, valueType as PropertyValueType);
          assert.throws(
            () => execThoughtLeaf(f, parseLeaf(f, node).filter),
            `property:${valueType}.${operator} должен быть отвергнут: оператор не входит в набор реестра`,
          );
        }
      }
    });

    it('профили «хроника», «события», «вложения»: реестр ⊆ публичный исполнитель', () => {
      for (const profile of ['chronicle', 'events', 'attachments'] as const) {
        for (const pair of registryPairs(profile)) {
          const node = buildLeaf(f, pair.kind, pair.operator, pair.valueType);
          assertFilterAstInProfile(parseLeaf(f, node), profile);
          assert.doesNotThrow(
            () => execProfileLeaf(f, profile, node),
            `${profile}: исполнитель отверг ${pair.kind}.${pair.operator}`,
          );
        }
      }
    });

    it('датовые операнды несут «равно»/«не равно» (ошибка 03db4cb0, аналог e219112e)', () => {
      const thoughts = FILTER_PROFILES.thoughts.operand_operators!;
      for (const kind of ['created_at', 'updated_at'] as const) {
        assert.ok(thoughts[kind]!.includes('eq'), `${kind}: eq`);
        assert.ok(thoughts[kind]!.includes('ne'), `${kind}: ne`);
      }
      const chronicle = FILTER_PROFILES.chronicle.operand_operators!;
      assert.ok(chronicle['record_time']!.includes('eq'), 'record_time: eq');
      assert.ok(chronicle['record_time']!.includes('ne'), 'record_time: ne');
      const events = FILTER_PROFILES.events.operand_operators!;
      assert.ok(events['occurred_at']!.includes('eq'), 'occurred_at: eq');
      assert.ok(events['occurred_at']!.includes('ne'), 'occurred_at: ne');
      assert.ok(PROPERTY_OPERATOR_SETS.date.includes('eq'), 'property:date: eq');
      assert.ok(PROPERTY_OPERATOR_SETS.date.includes('ne'), 'property:date: ne');
    });
  },
);

// ---------------------------------------------------------------------------
// Ключи сортировки: конструктор ↔ исполнитель
// ---------------------------------------------------------------------------

/** Движковые ключи AST, которые принимает исполнитель (title/created/updated). */
const ENGINE_SORT_KEYS: readonly string[] = [
  'title',
  'alpha',
  'created_at',
  'created',
  'updated_at',
  'updated',
];

describe(
  'guard: исполнитель принимает все ключи сортировки конструктора (335b23cb)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let f: ExecFixture;
    before(() => {
      f = buildFixture();
    });

    function thoughtSelect(sortKey: string): void {
      const sel = buildThoughtIdSelect(f.db, USER, {
        sort: 'alpha',
        order: 'asc',
        limit: 1,
        offset: 0,
        ast: {
          version: FILTER_AST_VERSION,
          filter: { op: 'and', children: [] },
          sort: [{ key: sortKey, order: 'asc' }],
        },
      });
      f.db.prepare(sel.sql).all(...sel.params);
    }

    it('движковые ключи AST исполняются и не краснеют в диагностике', () => {
      for (const key of ENGINE_SORT_KEYS) {
        assert.doesNotThrow(() => thoughtSelect(key), `движковый ключ ${key} отвергнут исполнителем`);
        const diag = diagnoseFilterAst(f.db, {
          version: FILTER_AST_VERSION,
          filter: { op: 'and', children: [] },
          sort: [{ key, order: 'asc' }],
        });
        assert.deepEqual(diag.errors, [], `движковый ключ ${key} краснеет в диагностике`);
      }
    });

    it('свойство по id, имени и имени обратной стороны — исполнимы (335b23cb)', () => {
      for (const key of [f.linkPropId, f.linkPropForward, f.linkPropReverse, f.propIds.text]) {
        assert.doesNotThrow(() => thoughtSelect(key), `ключ-свойство ${key} отвергнут исполнителем`);
      }
    });

    it('неизвестный ключ отвергается и краснеет диагностикой', () => {
      assert.throws(() => thoughtSelect('guard-unknown-sort'));
      const diag = diagnoseFilterAst(f.db, {
        version: FILTER_AST_VERSION,
        filter: { op: 'and', children: [] },
        sort: [{ key: 'guard-unknown-sort', order: 'asc' }],
      });
      assert.equal(diag.errors.length, 1);
    });
  },
);
