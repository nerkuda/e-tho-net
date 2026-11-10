/**
 * Удаление реестрового свойства в рабочем слое (ошибка 81184542, версия 0.15.4).
 *
 * Ветка `case 'property'` в `deleteOntologyEntity` шла сырым SQL без ветки
 * «основа / рабочий слой»: в слое физически выметала **базовые** строки
 * `type_properties` и `property_values`, а строку реестра искала по `layer_id`
 * и не находила — тихий no-op при `deleted: true`. Через представления `*_v`
 * дефект не виден (в основе строки исчезли, в слое и так невидимы), поэтому
 * проверки идут ФИЗИЧЕСКИМ счётом строк основы (docs/13-layers.md §5.2):
 *
 * 1. пара «свойство-связь + link_type» создана в основе, удаление в слое:
 *    базовых привязок 1 → 1, свойство и тип живы в основе, в слое невидимы;
 * 2. скалярное свойство со значением в основе: значение основы цело
 *    физически, свойство скрыто в слое и видимо в основе;
 * 3. пара создана в слое: удаление даёт надгробия, основа не меняется;
 * 4. основа без слоя: физическое удаление и `affected_counts` как у REST-пути;
 * 5. инвариант слоевого контекста: ни одного физического `DELETE`/`UPDATE`
 *    ветвимых таблиц (содержимое базовых строк до/после совпадает).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { BRANCHABLE_TABLES } from '../src/db/layer-chain.js';
import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { deleteOntologyEntity } from '../src/domain/ontology-delete-service.js';
import { createLink, getLink } from '../src/domain/link-service.js';
import { createLinkType, getLinkType } from '../src/domain/link-type-service.js';
import {
  createNetworkProperty,
  createTypeProperty,
  deleteNetworkProperty,
  deleteTypeProperty,
  ensureLinkPropertyForLinkType,
  getNetworkProperty,
  getPropertyValues,
  setPropertyValue,
} from '../src/domain/property-service.js';
import { createThought } from '../src/domain/thought-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';

const USER = 'user-1';

/** Имя ветвимой таблицы (закрытый список, docs/13-layers.md §3). */
type BranchableTable = (typeof BRANCHABLE_TABLES)[number];

/** Сеть домена не нужна: идентификатор попадает только в параметры вызова. */
const NETWORK_ID = 'net-81184542';

/** Слой A — над основой; второй слой не нужен, но S показывает независимость. */
const LAYER_A = '11111111-1111-4111-8111-111111111111';

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

/** Seed `layers` with A (child of base) — слой должен существовать до `useLayer`. */
function insertLayer(ndb: NetworkDb): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, 'Слой A', 0, 1, 'u', ?, ?)`,
    )
    .run(LAYER_A, BASE_LAYER_ID, now, now);
}

/** Таблицы, физически существующие в схеме соединения. */
function existingBranchableTables(ndb: NetworkDb): BranchableTable[] {
  const names = new Set(
    (
      ndb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  return BRANCHABLE_TABLES.filter((table) => names.has(table));
}

/**
 * Содержимое ФИЗИЧЕСКИХ строк основы, таблица → JSON всех строк (по `pk`).
 * Счёт строк ловит `DELETE`, дамп строк — ещё и `UPDATE` (DoD 5).
 */
function basePhysicalContent(ndb: NetworkDb): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of existingBranchableTables(ndb)) {
    const rows = ndb
      // layers:physical-read — вопрос о собственных строках основы, не о цепочке.
      .prepare(`SELECT * FROM ${table} WHERE layer_id = ? ORDER BY pk`) // layers:physical-read
      .all(BASE_LAYER_ID);
    out[table] = JSON.stringify(rows);
  }
  return out;
}

/** Физическое число строк таблицы в основе (без `*_v`). */
function baseRowCount(ndb: NetworkDb, table: BranchableTable, where: string, arg: string): number {
  return (
    (
      ndb
        // layers:physical-read — проверка дефекта: счёт именно базовых строк.
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE layer_id = ? AND ${where}`) // layers:physical-read
        .get(BASE_LAYER_ID, arg) as { c: number }
    ).c
  );
}

/** Пара «свойство-связь + link_type», привязанная к самому типу связи (как в пробе 1ef72182). */
function seedLinkPropertyPair(
  ndb: NetworkDb,
  tag: string,
): { linkTypeId: string; propertyId: string; bindingId: string } {
  const linkType = createLinkType(
    ndb,
    { name_forward: `связь-${tag}`, name_reverse: `связь-${tag}-обр` },
    USER,
  );
  const pair = ensureLinkPropertyForLinkType(ndb, linkType.id, USER);
  const binding = createTypeProperty(
    ndb,
    'link_type',
    linkType.id,
    {
      key: pair.property.name,
      value_type: 'link',
      config: { link_type_id: linkType.id, direction: 'out' },
    },
    USER,
  );
  return { linkTypeId: linkType.id, propertyId: pair.property.id, bindingId: binding.id };
}

describe(
  'ontology.delete { kind: property } в рабочем слое (81184542)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('DoD 1: пара в основе — удаление в слое не трогает базовые привязки', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayer(ndb);
        const fixture = seedLinkPropertyPair(ndb, 'слоеная');
        const anchor = createThought(ndb, { title: 'Якорь' }, USER);
        const target = createThought(ndb, { title: 'Цель' }, USER);
        const edge = createLink(
          ndb,
          { source_id: anchor.id, target_id: target.id, type_id: fixture.linkTypeId },
          USER,
        );

        // Физический счёт основы ДО удаления в слое.
        assert.equal(
          baseRowCount(ndb, 'type_properties', 'property_id = ?', fixture.propertyId),
          1,
          'в основе ровно одна привязка удаляемого свойства',
        );
        const before = basePhysicalContent(ndb);

        ndb.useLayer(LAYER_A);
        const result = deleteOntologyEntity(
          ndb,
          { network_id: NETWORK_ID, kind: 'property', id: fixture.propertyId, force: true },
          USER,
        );

        assert.equal(result.deleted, true);
        assert.equal(
          result.affected_counts.links_becoming_structural,
          1,
          `число живых рёбер в слое: ${JSON.stringify(result.affected_counts)}`,
        );
        // В слое и свойство, и парный тип связи невидимы.
        assert.equal(getNetworkProperty(ndb, fixture.propertyId), null, 'свойство скрыто в слое');
        assert.equal(getLinkType(ndb, fixture.linkTypeId), null, 'тип связи скрыт в слое');
        // Ни одна физическая строка основы не изменилась (DELETE и UPDATE).
        assert.deepEqual(basePhysicalContent(ndb), before, 'основа не должна меняться в слое');
        assert.equal(
          baseRowCount(ndb, 'type_properties', 'property_id = ?', fixture.propertyId),
          1,
          'базовых привязок 1 → 1',
        );

        // Основа по-прежнему видит живые свойство, тип и ребро с типом.
        ndb.useLayer(BASE_LAYER_ID);
        assert.notEqual(
          getNetworkProperty(ndb, fixture.propertyId),
          null,
          'свойство живо в основе',
        );
        assert.notEqual(getLinkType(ndb, fixture.linkTypeId), null, 'тип связи жив в основе');
        const baseEdge = ndb
          .prepare('SELECT type_id FROM links WHERE id = ? AND layer_id = ?') // layers:physical-read
          .get(edge.id, BASE_LAYER_ID) as { type_id: string | null } | undefined;
        assert.equal(baseEdge?.type_id, fixture.linkTypeId, 'ребро основы сохранило тип');
      } finally {
        ndb.close();
      }
    });

    it('DoD 2: скаляр со значениями в основе — значения основы целы, свойство скрыто в слое', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayer(ndb);
        const type = createThoughtType(ndb, { name: 'Проект' }, USER);
        const property = createNetworkProperty(ndb, { name: 'вес', value_type: 'number' }, USER);
        createTypeProperty(
          ndb,
          'thought_type',
          type.id,
          { key: 'вес', value_type: 'number' },
          USER,
        );
        const thought = createThought(ndb, { title: 'Проект 1', type_id: type.id }, USER);
        setPropertyValue(ndb, 'thought', thought.id, 'вес', 5, USER);

        assert.equal(
          baseRowCount(ndb, 'property_values', 'property_id = ?', property.id),
          1,
          'в основе одно значение',
        );
        const before = basePhysicalContent(ndb);

        ndb.useLayer(LAYER_A);
        const result = deleteOntologyEntity(
          ndb,
          { network_id: NETWORK_ID, kind: 'property', id: property.id, force: true },
          USER,
        );

        assert.equal(result.deleted, true);
        assert.equal(
          result.affected_counts.property_values_count,
          1,
          `счётчики использования собраны до удаления: ${JSON.stringify(result.affected_counts)}`,
        );
        assert.equal(result.affected_counts.type_properties_count, 1);
        assert.equal(getNetworkProperty(ndb, property.id), null, 'свойство скрыто в слое');
        assert.deepEqual(basePhysicalContent(ndb), before, 'значения и привязки основы целы');
        assert.equal(
          baseRowCount(ndb, 'property_values', 'property_id = ?', property.id),
          1,
          'базовое значение не вычищено',
        );

        ndb.useLayer(BASE_LAYER_ID);
        assert.notEqual(getNetworkProperty(ndb, property.id), null, 'свойство видимо в основе');
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', thought.id).map((value) => value.property_id),
          [property.id],
          'значение основы читается',
        );
      } finally {
        ndb.close();
      }
    });

    it('DoD 3: пара создана в слое — надгробия в слое, основа не меняется', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayer(ndb);
        const before = basePhysicalContent(ndb);

        ndb.useLayer(LAYER_A);
        const fixture = seedLinkPropertyPair(ndb, 'слойная');
        const result = deleteOntologyEntity(
          ndb,
          { network_id: NETWORK_ID, kind: 'property', id: fixture.propertyId, force: true },
          USER,
        );

        assert.equal(result.deleted, true);
        assert.equal(getNetworkProperty(ndb, fixture.propertyId), null, 'свойство скрыто в слое');
        assert.equal(getLinkType(ndb, fixture.linkTypeId), null, 'тип связи скрыт в слое');
        assert.deepEqual(basePhysicalContent(ndb), before, 'основа не изменилась');

        // Удаление обязано оставить в слое ФАКТ удаления (надгробие), а не
        // стереть строку: иначе слой не отличим от «здесь ничего не было» и
        // слияние/откат теряют решение.
        const layerRow = (table: BranchableTable, id: string): { deleted: number } | undefined =>
          ndb
            .prepare(`SELECT deleted FROM ${table} WHERE id = ? AND layer_id = ?`) // layers:physical-read
            .get(id, LAYER_A) as { deleted: number } | undefined;
        assert.deepEqual(layerRow('properties', fixture.propertyId), { deleted: 1 });
        assert.deepEqual(layerRow('link_types', fixture.linkTypeId), { deleted: 1 });
        assert.deepEqual(layerRow('type_properties', fixture.bindingId), { deleted: 1 });

        // В основе этих строк нет вовсе — создавались только в слое.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getNetworkProperty(ndb, fixture.propertyId), null);
        assert.equal(getLinkType(ndb, fixture.linkTypeId), null);
        assert.equal(
          baseRowCount(ndb, 'properties', 'id = ?', fixture.propertyId),
          0,
          'строка реестра физически живёт в слое',
        );
      } finally {
        ndb.close();
      }
    });

    it('DoD 4: основа без слоя — физическое удаление, `affected_counts` как у REST-пути', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayer(ndb);
        // Фикстура A — удаляется MCP-путём (force-каскад).
        const mcp = seedLinkPropertyPair(ndb, 'mcp');
        const anchor = createThought(ndb, { title: 'Якорь' }, USER);
        const target = createThought(ndb, { title: 'Цель' }, USER);
        const mcpEdge = createLink(
          ndb,
          { source_id: anchor.id, target_id: target.id, type_id: mcp.linkTypeId },
          USER,
        );
        // Фикстура B — тот же итог REST-путём: снять привязку, затем
        // `deleteNetworkProperty` (его зовёт `DELETE /properties/:id`).
        const rest = seedLinkPropertyPair(ndb, 'rest');
        const restAnchor = createThought(ndb, { title: 'Якорь REST' }, USER);
        const restTarget = createThought(ndb, { title: 'Цель REST' }, USER);
        const restEdge = createLink(
          ndb,
          { source_id: restAnchor.id, target_id: restTarget.id, type_id: rest.linkTypeId },
          USER,
        );
        deleteTypeProperty(ndb, rest.bindingId, USER);
        const restRemoved = deleteNetworkProperty(ndb, rest.propertyId);

        const result = deleteOntologyEntity(
          ndb,
          { network_id: NETWORK_ID, kind: 'property', id: mcp.propertyId, force: true },
          USER,
        );
        assert.equal(result.deleted, true);
        assert.equal(
          result.affected_counts.links_becoming_structural,
          restRemoved.links_becoming_structural,
          'MCP- и REST-путь дают одно число на одинаковой фикстуре',
        );
        assert.equal(result.affected_counts.links_becoming_structural, 1);
        // Физическое удаление: привязки, строка реестра и парный тип связи.
        assert.equal(
          baseRowCount(ndb, 'type_properties', 'property_id = ?', mcp.propertyId),
          0,
          'привязки удалены физически',
        );
        assert.equal(baseRowCount(ndb, 'properties', 'id = ?', mcp.propertyId), 0);
        assert.equal(baseRowCount(ndb, 'link_types', 'id = ?', mcp.linkTypeId), 0);
        // Рёбра обеих фикстур живы и стали структурными.
        assert.equal(
          (ndb.prepare('SELECT type_id FROM links WHERE id = ?').get(mcpEdge.id) as
            | { type_id: string | null }
            | undefined)?.type_id,
          null,
        );
        assert.equal(
          (ndb.prepare('SELECT type_id FROM links WHERE id = ?').get(restEdge.id) as
            | { type_id: string | null }
            | undefined)?.type_id,
          null,
        );
        assert.notEqual(getLink(ndb, mcpEdge.id), null, 'ребро не удалено, только потеряло тип');
      } finally {
        ndb.close();
      }
    });

    it('DoD 5: при удалении в слое физические строки основы не трогаются (DELETE и UPDATE)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayer(ndb);
        // Обе формы сразу: пара-связь с ребром и скаляр со значением.
        const pair = seedLinkPropertyPair(ndb, 'инвариант');
        const anchor = createThought(ndb, { title: 'Якорь' }, USER);
        const target = createThought(ndb, { title: 'Цель' }, USER);
        createLink(
          ndb,
          { source_id: anchor.id, target_id: target.id, type_id: pair.linkTypeId },
          USER,
        );
        const type = createThoughtType(ndb, { name: 'Инвариант' }, USER);
        const scalar = createNetworkProperty(
          ndb,
          { name: 'инвариант-число', value_type: 'number' },
          USER,
        );
        createTypeProperty(
          ndb,
          'thought_type',
          type.id,
          { key: 'инвариант-число', value_type: 'number' },
          USER,
        );
        const thought = createThought(ndb, { title: 'Мысль', type_id: type.id }, USER);
        setPropertyValue(ndb, 'thought', thought.id, 'инвариант-число', 7, USER);

        const before = basePhysicalContent(ndb);
        ndb.useLayer(LAYER_A);
        deleteOntologyEntity(ndb, { network_id: NETWORK_ID, kind: 'property', id: pair.propertyId, force: true }, USER);
        deleteOntologyEntity(ndb, { network_id: NETWORK_ID, kind: 'property', id: scalar.id, force: true }, USER);
        assert.deepEqual(
          basePhysicalContent(ndb),
          before,
          'в слое не должно быть физических DELETE/UPDATE ветвимых таблиц',
        );
      } finally {
        ndb.close();
      }
    });
  },
);
