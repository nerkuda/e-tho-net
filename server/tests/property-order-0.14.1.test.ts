/**
 * 0.14.1, тех.проект bd349082 / задача Z3 (3948af62): пер-мысленный порядок
 * внетиповых свойств — сервер и миграция.
 *
 * Покрывает DoD задачи и дополнения аудита (циклы 1–3):
 *   * запись полным набором и чтение эффективного порядка (явные позиции +
 *     хвост по времени появления);
 *   * дефолт без строк — порядок появления, обеспеченный `created_at`;
 *   * правка значения не меняет место строки;
 *   * нормализация позиций, дубль пары, `side` у скаляра, типовое свойство —
 *     `422`;
 *   * сторона свойства-связи: симметричный тип — обе стороны, `side`
 *     обязателен; типовая сторона — `422`, внетиповая обратная — можно;
 *   * событие `thought.properties.reordered` с вычисленными сторонами;
 *   * слои: перекрытие строки основы, две прослойки и слияние (LWW,
 *     `base_version` = 0);
 *   * удаление строк вместе с мыслью-владельцем;
 *   * миграция на существующей сети: backfill `created_at` и UNIQUE по
 *     выражению `COALESCE(side, '')`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { registerMigrationHelpers, createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { networkMigrationsDir } from '../src/paths.js';
import { loadThoughtPropertyOrder } from '../src/domain/property-order.js';
import { setThoughtPropertyOrder } from '../src/domain/property-order-service.js';
import {
  createNetworkProperty,
  createTypeProperty,
  getPropertyValuesResolved,
  getPropertyValuesWithLinks,
} from '../src/domain/property-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { deleteThought } from '../src/domain/thought-service.js';
import { mergeLayer, mergeLayerThought, discardLayerThought } from '../src/domain/merge-service.js';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

const USER = 'user-1';

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

async function createProperty(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/properties`,
    headers: authHeaders(ctx),
    payload,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().data as { id: string; name: string };
}

async function createThought(
  ctx: RestTestContext,
  title: string,
  typeId?: string,
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: {
      title,
      ...(typeId === undefined ? {} : { type_id: typeId }),
      create_link: { direction: 'parent', target_thought_id: ctx.homeId },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json().data as { id: string }).id;
}

async function putProperty(
  ctx: RestTestContext,
  thoughtId: string,
  key: string,
  value: unknown,
  side?: 'source' | 'target',
) {
  return ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/properties/${encodeURIComponent(key)}`,
    headers: authHeaders(ctx),
    payload: { value, ...(side === undefined ? {} : { side }) },
  });
}

async function listProperties(
  ctx: RestTestContext,
  thoughtId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/properties`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data as Array<Record<string, unknown>>;
}

async function reorder(
  ctx: RestTestContext,
  thoughtId: string,
  items: Array<{ property_id: string; side?: 'source' | 'target'; position: number }>,
) {
  return ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/properties/order`,
    headers: authHeaders(ctx),
    payload: { items },
  });
}

/** Id внетиповых записей в порядке ответа. */
function outsideIds(values: Array<Record<string, unknown>>): string[] {
  return values.filter((v) => v.outside_type === true).map((v) => v.property_id as string);
}

/** Стороны внетиповых свойств-связей в порядке ответа. */
function outsideLinkSides(values: Array<Record<string, unknown>>): Array<string | null> {
  return values
    .filter((v) => v.outside_type === true && v.value_type === 'link')
    .map((v) => (v.side as string | null) ?? null);
}

// ---------------------------------------------------------------------------
// In-memory layer helpers
// ---------------------------------------------------------------------------

/** Seed a typed/untyped thought directly in the current layer. */
function seedThought(ndb: NetworkDb, title: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, NULL, 1, 0, 0, 1, ?, 'u', ?, 'u')`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), now, now);
  return id;
}

/** Seed a scalar property value with a fixed appearance time. */
function seedValue(
  ndb: NetworkDb,
  thoughtId: string,
  propertyId: string,
  createdAt: string,
): void {
  ndb
    .prepare(
      `INSERT INTO property_values
         (id, layer_id, owner_type, owner_id, property_id, value_text, created_at, updated_at)
       VALUES (?, ?, 'thought', ?, ?, 'v', ?, ?)`,
    )
    .run(`pv-${randomUUID()}`, ndb.layerId, thoughtId, propertyId, createdAt, createdAt);
}

/** Insert a working layer; `parentId` lets tests build nested layers. */
function seedLayer(ndb: NetworkDb, parentId: string = BASE_LAYER_ID, depth = 1): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, 'Слой', 0, ?, 'u', ?, ?)`,
    )
    .run(id, parentId, depth, now, now);
  return id;
}

/** Physical row of the order table in a layer. */
function orderRow(
  ndb: NetworkDb,
  propertyId: string,
  layerId: string,
  side: string | null = null,
): { id: string; position: number; base_version: number } | undefined {
  return ndb
    .prepare(
      `SELECT id, position, base_version FROM thought_property_order
        WHERE property_id = ? AND layer_id = ? AND COALESCE(side, '') = COALESCE(?, '')`,
    )
    .get(propertyId, layerId, side) as
    | { id: string; position: number; base_version: number }
    | undefined;
}

describe(
  '0.14.1 — порядок внетиповых свойств (REST)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('полный набор, нормализация, эффективное чтение, событие и стабильный created_at', async () => {
      const ctx = await buildRestContext();
      try {
        const p1 = await createProperty(ctx, { name: 'первое', value_type: 'text' });
        const p2 = await createProperty(ctx, { name: 'второе', value_type: 'text' });
        const p3 = await createProperty(ctx, { name: 'третье', value_type: 'text' });
        const thoughtId = await createThought(ctx, 'Мысль-порядок');
        for (const [prop, value] of [
          [p1, '1'],
          [p2, '2'],
          [p3, '3'],
        ] as const) {
          assert.equal((await putProperty(ctx, thoughtId, prop.name, value)).statusCode, 200);
        }
        // Время появления задаём явно: миллисекунды реальных записей могут
        // совпасть, а тест проверяет именно дефолт «по появлению».
        for (const [prop, createdAt] of [
          [p1, '2026-01-03T00:00:00.000Z'],
          [p2, '2026-01-01T00:00:00.000Z'],
          [p3, '2026-01-02T00:00:00.000Z'],
        ] as const) {
          ctx.ndb
            .prepare(
              'UPDATE property_values SET created_at = ? WHERE owner_id = ? AND property_id = ?',
            )
            .run(createdAt, thoughtId, prop.id);
        }

        // Дефолт без строк — по времени появления.
        assert.deepEqual(outsideIds(await listProperties(ctx, thoughtId)), [
          p2.id,
          p3.id,
          p1.id,
        ]);

        // Полный набор: позиции нормализуются 0..n-1.
        const ordered = await reorder(ctx, thoughtId, [
          { property_id: p1.id, position: 100 },
          { property_id: p3.id, position: 0 },
          { property_id: p2.id, position: 50 },
        ]);
        assert.equal(ordered.statusCode, 200, ordered.body);
        assert.deepEqual((ordered.json().data as { items: unknown[] }).items, [
          { property_id: p3.id, side: null, position: 0 },
          { property_id: p2.id, side: null, position: 1 },
          { property_id: p1.id, side: null, position: 2 },
        ]);
        assert.deepEqual(outsideIds(await listProperties(ctx, thoughtId)), [
          p3.id,
          p2.id,
          p1.id,
        ]);

        // Одно событие с нормализованным набором.
        const events = ctx.sys.readEventsAfter(ctx.networkId, 0, 500);
        const reordered = events.filter((e) => e.type === 'thought.properties.reordered');
        assert.equal(reordered.length, 1);
        assert.deepEqual(reordered[0]!.data, {
          thought_id: thoughtId,
          items: [
            { property_id: p3.id, side: null, position: 0 },
            { property_id: p2.id, side: null, position: 1 },
            { property_id: p1.id, side: null, position: 2 },
          ],
        });

        // Правка значения не меняет место строки и не трогает created_at.
        const before = (
          ctx.ndb
            .prepare(
              'SELECT created_at FROM property_values WHERE owner_id = ? AND property_id = ?',
            )
            .get(thoughtId, p1.id) as { created_at: string }
        ).created_at;
        assert.equal((await putProperty(ctx, thoughtId, 'первое', 'изменено')).statusCode, 200);
        const after = (
          ctx.ndb
            .prepare(
              'SELECT created_at FROM property_values WHERE owner_id = ? AND property_id = ?',
            )
            .get(thoughtId, p1.id) as { created_at: string }
        ).created_at;
        assert.equal(after, before);
        assert.deepEqual(outsideIds(await listProperties(ctx, thoughtId)), [
          p3.id,
          p2.id,
          p1.id,
        ]);

        // Пустой набор очищает явные позиции — снова дефолт.
        assert.equal((await reorder(ctx, thoughtId, [])).statusCode, 200);
        assert.deepEqual(outsideIds(await listProperties(ctx, thoughtId)), [
          p2.id,
          p3.id,
          p1.id,
        ]);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('422: типовое скалярное свойство, side у скаляра, несуществующее свойство, дубль', async () => {
      const ctx = await buildRestContext();
      try {
        const typeId = createThoughtType(ctx.ndb, { name: 'Тип-порядок' }, USER).id;
        const typedProp = await createProperty(ctx, { name: 'типовое', value_type: 'text' });
        createTypeProperty(
          ctx.ndb,
          'thought_type',
          typeId,
          { key: typedProp.name, value_type: 'text' },
          USER,
        );
        const freeProp = await createProperty(ctx, { name: 'свободное', value_type: 'text' });
        const thoughtId = await createThought(ctx, 'Типовая мысль', typeId);
        assert.equal((await putProperty(ctx, thoughtId, typedProp.name, 't')).statusCode, 200);
        assert.equal((await putProperty(ctx, thoughtId, freeProp.name, 'f')).statusCode, 200);

        const typedItem = await reorder(ctx, thoughtId, [{ property_id: typedProp.id, position: 0 }]);
        assert.equal(typedItem.statusCode, 422, typedItem.body);
        assert.equal(
          (typedItem.json() as { error: { code: string } }).error.code,
          'VALIDATION_ERROR',
        );

        const sideOnScalar = await reorder(ctx, thoughtId, [
          { property_id: freeProp.id, side: 'source', position: 0 },
        ]);
        assert.equal(sideOnScalar.statusCode, 422, sideOnScalar.body);
        assert.equal(
          (sideOnScalar.json() as { error: { details?: { field?: string } } }).error.details
            ?.field,
          'items[0].side',
        );

        const unknown = await reorder(ctx, thoughtId, [
          { property_id: randomUUID(), position: 0 },
        ]);
        assert.equal(unknown.statusCode, 422, unknown.body);

        const duplicate = await reorder(ctx, thoughtId, [
          { property_id: freeProp.id, position: 0 },
          { property_id: freeProp.id, position: 1 },
        ]);
        assert.equal(duplicate.statusCode, 422, duplicate.body);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('симметричный тип связи: обе стороны упорядочиваются, side обязателен при обеих живых', async () => {
      const ctx = await buildRestContext();
      try {
        const prop = createNetworkProperty(
          ctx.ndb,
          {
            name: 'см. также',
            value_type: 'link',
            name_forward: 'см. также',
            name_reverse: 'см. также',
          },
          USER,
        );
        const owner = await createThought(ctx, 'Тема-владелец');
        const peer1 = await createThought(ctx, 'Сосед 1');
        const peer2 = await createThought(ctx, 'Сосед 2');
        // Исходящая и входящая стороны одного типа связи.
        assert.equal((await putProperty(ctx, owner, 'см. также', peer1)).statusCode, 200);
        assert.equal((await putProperty(ctx, owner, 'см. также', peer2, 'target')).statusCode, 200);

        // Обе стороны живы — без side пара неразличима.
        const ambiguous = await reorder(ctx, owner, [{ property_id: prop.id, position: 0 }]);
        assert.equal(ambiguous.statusCode, 422, ambiguous.body);
        assert.equal(
          (ambiguous.json() as { error: { details?: { field?: string } } }).error.details?.field,
          'side',
        );

        // Дубль вычисленной стороны.
        const duplicate = await reorder(ctx, owner, [
          { property_id: prop.id, side: 'source', position: 0 },
          { property_id: prop.id, side: 'source', position: 1 },
        ]);
        assert.equal(duplicate.statusCode, 422, duplicate.body);

        // Обе стороны — обычные разные строки порядка.
        const ordered = await reorder(ctx, owner, [
          { property_id: prop.id, side: 'target', position: 0 },
          { property_id: prop.id, side: 'source', position: 1 },
        ]);
        assert.equal(ordered.statusCode, 200, ordered.body);
        assert.deepEqual((ordered.json().data as { items: unknown[] }).items, [
          { property_id: prop.id, side: 'target', position: 0 },
          { property_id: prop.id, side: 'source', position: 1 },
        ]);
        assert.deepEqual(outsideLinkSides(await listProperties(ctx, owner)), ['target', 'source']);

        // В событии сторона всегда присутствует и вычислена сервером.
        const reordered = ctx.sys
          .readEventsAfter(ctx.networkId, 0, 500)
          .filter((e) => e.type === 'thought.properties.reordered')
          .pop();
        assert.ok(reordered !== undefined);
        assert.deepEqual(reordered.data, {
          thought_id: owner,
          items: [
            { property_id: prop.id, side: 'target', position: 0 },
            { property_id: prop.id, side: 'source', position: 1 },
          ],
        });
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('типовая сторона — 422, внетиповая обратная сторона того же свойства — можно', async () => {
      const ctx = await buildRestContext();
      try {
        const typeId = createThoughtType(ctx.ndb, { name: 'Тип-держатель' }, USER).id;
        const prop = createNetworkProperty(
          ctx.ndb,
          {
            name: 'держит',
            value_type: 'link',
            name_forward: 'держит',
            name_reverse: 'содержится в',
          },
          USER,
        );
        createTypeProperty(
          ctx.ndb,
          'thought_type',
          typeId,
          { key: 'держит', value_type: 'link', side: 'source' },
          USER,
        );
        const owner = await createThought(ctx, 'Владелец', typeId);
        const held = await createThought(ctx, 'Содержимое');
        const container = await createThought(ctx, 'Контейнер');
        assert.equal((await putProperty(ctx, owner, 'держит', held)).statusCode, 200);
        // Обратная сторона: ребро container → owner. Создаём его со стороны
        // контейнера (там свойство внетиповое), не через `side` у владельца:
        // для асимметричного имени `side` противоположной стороны — 422.
        assert.equal((await putProperty(ctx, container, 'держит', owner)).statusCode, 200);

        const typedSide = await reorder(ctx, owner, [
          { property_id: prop.id, side: 'source', position: 0 },
        ]);
        assert.equal(typedSide.statusCode, 422, typedSide.body);

        const outsideSide = await reorder(ctx, owner, [
          { property_id: prop.id, side: 'target', position: 0 },
        ]);
        assert.equal(outsideSide.statusCode, 200, outsideSide.body);

        // Карточка MCP-чтения (тот же путь, что etn.thoughts_get) отдаёт
        // внетиповую обратную сторону; явная позиция применена.
        const card = getPropertyValuesResolved(ctx.ndb, 'thought', owner);
        const outside = card.filter((v) => v.outside_type === true && v.value_type === 'link');
        assert.equal(outside.length, 1);
        assert.equal((outside[0] as { side?: string | null }).side, 'target');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);

describe(
  '0.14.1 — порядок внетиповых свойств: слои',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('перестановка в слое перекрывает строку основы (id наследуется) и сливается LWW', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createNetworkProperty(ndb, { name: 'a', value_type: 'text' }, USER);
        const b = createNetworkProperty(ndb, { name: 'b', value_type: 'text' }, USER);
        const thoughtId = seedThought(ndb, 'Мысль слоя');
        seedValue(ndb, thoughtId, a.id, '2026-01-01T00:00:00.000Z');
        seedValue(ndb, thoughtId, b.id, '2026-01-02T00:00:00.000Z');

        setThoughtPropertyOrder(ndb, thoughtId, [
          { property_id: b.id, position: 0 },
          { property_id: a.id, position: 1 },
        ]);
        const baseA = orderRow(ndb, a.id, BASE_LAYER_ID);
        assert.ok(baseA !== undefined);

        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        setThoughtPropertyOrder(ndb, thoughtId, [
          { property_id: a.id, position: 0 },
          { property_id: b.id, position: 1 },
        ]);
        assert.deepEqual(
          loadThoughtPropertyOrder(ndb, thoughtId).map((r) => [r.property_id, r.position]),
          [
            [a.id, 0],
            [b.id, 1],
          ],
        );
        // Тень в слое наследует id основы и имеет base_version = 0.
        const shadowA = orderRow(ndb, a.id, layerId);
        assert.ok(shadowA !== undefined);
        assert.equal(shadowA.id, baseA.id);
        assert.equal(shadowA.base_version, 0);

        // Полный набор в слое: пустой массив ставит надгробия, повторная
        // запись того же ключа оживляет те же строки слоя.
        setThoughtPropertyOrder(ndb, thoughtId, []);
        assert.equal(loadThoughtPropertyOrder(ndb, thoughtId).length, 0);
        setThoughtPropertyOrder(ndb, thoughtId, [
          { property_id: a.id, position: 0 },
          { property_id: b.id, position: 1 },
        ]);
        assert.equal(loadThoughtPropertyOrder(ndb, thoughtId).length, 2);

        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          loadThoughtPropertyOrder(ndb, thoughtId).map((r) => [r.property_id, r.position]),
          [
            [b.id, 0],
            [a.id, 1],
          ],
          'до слияния основа не видит перестановку слоя',
        );

        const report = mergeLayer(ndb, layerId, undefined, 'u');
        assert.equal(report.applied.thought_property_order, 2);
        assert.deepEqual(
          loadThoughtPropertyOrder(ndb, thoughtId).map((r) => [r.property_id, r.position]),
          [
            [a.id, 0],
            [b.id, 1],
          ],
        );
      } finally {
        ndb.close();
      }
    });

    it('слияние/отказ одной мысли переносит и отбрасывает строки порядка (a0e2b2df)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createNetworkProperty(ndb, { name: 'a', value_type: 'text' }, USER);
        const b = createNetworkProperty(ndb, { name: 'b', value_type: 'text' }, USER);
        const thoughtId = seedThought(ndb, 'Мысль с порядком');
        seedValue(ndb, thoughtId, a.id, '2026-01-01T00:00:00.000Z');
        seedValue(ndb, thoughtId, b.id, '2026-01-02T00:00:00.000Z');
        setThoughtPropertyOrder(ndb, thoughtId, [
          { property_id: b.id, position: 0 },
          { property_id: a.id, position: 1 },
        ]);

        // Слой: обратная перестановка. Слияние одной мысли обязано увезти
        // строки порядка — раньше таблица отсутствовала в наборе.
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        setThoughtPropertyOrder(ndb, thoughtId, [
          { property_id: a.id, position: 0 },
          { property_id: b.id, position: 1 },
        ]);
        const outcome = mergeLayerThought(ndb, layerId, thoughtId, 'overwrite', 'u');
        assert.equal(outcome.applied.thought_property_order, 2);
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          loadThoughtPropertyOrder(ndb, thoughtId).map((r) => [r.property_id, r.position]),
          [
            [a.id, 0],
            [b.id, 1],
          ],
        );

        // «Отказаться от изменений»: строки порядка слоя удаляются, мысль
        // возвращается к порядку основы.
        const layer2 = seedLayer(ndb);
        ndb.useLayer(layer2);
        setThoughtPropertyOrder(ndb, thoughtId, [
          { property_id: b.id, position: 0 },
          { property_id: a.id, position: 1 },
        ]);
        assert.equal(orderRow(ndb, a.id, layer2) !== undefined, true);
        const discarded = discardLayerThought(ndb, layer2, thoughtId);
        assert.equal(discarded.discarded.thought_property_order, 2);
        assert.equal(orderRow(ndb, a.id, layer2), undefined);
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          loadThoughtPropertyOrder(ndb, thoughtId).map((r) => [r.property_id, r.position]),
          [
            [a.id, 0],
            [b.id, 1],
          ],
          'основа не тронута отказом',
        );
      } finally {
        ndb.close();
      }
    });

    it('две вложенные прослойки: слияние построчно last-write-wins', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createNetworkProperty(ndb, { name: 'a', value_type: 'text' }, USER);
        const b = createNetworkProperty(ndb, { name: 'b', value_type: 'text' }, USER);
        const thoughtId = seedThought(ndb, 'Мысль вложенных слоёв');
        seedValue(ndb, thoughtId, a.id, '2026-01-01T00:00:00.000Z');
        seedValue(ndb, thoughtId, b.id, '2026-01-02T00:00:00.000Z');
        setThoughtPropertyOrder(ndb, thoughtId, [
          { property_id: b.id, position: 0 },
          { property_id: a.id, position: 1 },
        ]);

        const layer1 = seedLayer(ndb);
        ndb.useLayer(layer1);
        setThoughtPropertyOrder(ndb, thoughtId, [
          { property_id: a.id, position: 0 },
          { property_id: b.id, position: 1 },
        ]);

        const layer2 = seedLayer(ndb, layer1, 2);
        ndb.useLayer(layer2);
        setThoughtPropertyOrder(ndb, thoughtId, [
          { property_id: b.id, position: 0 },
          { property_id: a.id, position: 1 },
        ]);

        // Слияние идёт из контекста основы: layer2 → layer1.
        ndb.useLayer(BASE_LAYER_ID);
        mergeLayer(ndb, layer2, undefined, 'u');
        ndb.useLayer(layer1);
        assert.deepEqual(
          loadThoughtPropertyOrder(ndb, thoughtId).map((r) => [r.property_id, r.position]),
          [
            [b.id, 0],
            [a.id, 1],
          ],
          'побеждает строка ближней прослойки',
        );

        // layer1 → основа.
        ndb.useLayer(BASE_LAYER_ID);
        mergeLayer(ndb, layer1, undefined, 'u');
        assert.deepEqual(
          loadThoughtPropertyOrder(ndb, thoughtId).map((r) => [r.property_id, r.position]),
          [
            [b.id, 0],
            [a.id, 1],
          ],
        );
        // Безверсионная таблица: у основы base_version остаётся 0.
        assert.equal(orderRow(ndb, a.id, BASE_LAYER_ID)?.base_version, 0);
      } finally {
        ndb.close();
      }
    });

    it('удаление мысли убирает строки порядка в той же транзакции', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createNetworkProperty(ndb, { name: 'a', value_type: 'text' }, USER);
        const thoughtId = seedThought(ndb, 'Удаляемая мысль');
        seedValue(ndb, thoughtId, a.id, '2026-01-01T00:00:00.000Z');
        setThoughtPropertyOrder(ndb, thoughtId, [{ property_id: a.id, position: 0 }]);
        assert.equal(loadThoughtPropertyOrder(ndb, thoughtId).length, 1);

        deleteThought(ndb, thoughtId, undefined, 'u');
        assert.equal(loadThoughtPropertyOrder(ndb, thoughtId).length, 0);
        assert.equal(
          (
            ndb
              .prepare('SELECT COUNT(*) AS c FROM thought_property_order WHERE thought_id = ?')
              .get(thoughtId) as { c: number }
          ).c,
          0,
        );
      } finally {
        ndb.close();
      }
    });

    it('удаление мысли в слое прячет строки порядка только в слое', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createNetworkProperty(ndb, { name: 'a', value_type: 'text' }, USER);
        const thoughtId = seedThought(ndb, 'Мысль основы');
        seedValue(ndb, thoughtId, a.id, '2026-01-01T00:00:00.000Z');
        setThoughtPropertyOrder(ndb, thoughtId, [{ property_id: a.id, position: 0 }]);

        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        deleteThought(ndb, thoughtId, undefined, 'u');
        assert.equal(loadThoughtPropertyOrder(ndb, thoughtId).length, 0);
        assert.equal(
          (
            ndb
              .prepare('SELECT COUNT(*) AS c FROM thought_property_order_v WHERE thought_id = ?')
              .get(thoughtId) as { c: number }
          ).c,
          0,
        );

        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(loadThoughtPropertyOrder(ndb, thoughtId).length, 1, 'основа не тронута');
        assert.equal(
          (
            ndb
              .prepare(
                'SELECT COUNT(*) AS c FROM thought_property_order WHERE thought_id = ? AND layer_id = ?',
              )
              .get(thoughtId, BASE_LAYER_ID) as { c: number }
          ).c,
          1,
          'физическая строка основы жива',
        );
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  '0.14.1 — миграция 051 на существующей сети',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('backfill created_at = updated_at и UNIQUE по выражению COALESCE(side, "")', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'etn-mig-051-'));
      for (const file of readdirSync(networkMigrationsDir()).filter(
        (f) => f.endsWith('.sql') && f < '051_thought_property_order.sql',
      )) {
        cpSync(path.join(networkMigrationsDir(), file), path.join(dir, file));
      }
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      try {
        runMigrations(db, dir);
        db.prepare(
          `INSERT INTO property_values
             (id, owner_type, owner_id, property_id, value_text, updated_at)
           VALUES ('pv-legacy', 'thought', 't1', 'p1', 'v', '2026-02-03T04:05:06.000Z')`,
        ).run();

        // Применяем 051 (и всё, что окажется после, — каталог вычисляется).
        runMigrations(db, networkMigrationsDir());

        const row = db
          .prepare("SELECT created_at, updated_at FROM property_values WHERE id = 'pv-legacy'")
          .get() as { created_at: string; updated_at: string };
        assert.equal(row.created_at, row.updated_at);

        const table = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='thought_property_order'",
          )
          .get();
        assert.ok(table !== undefined, 'таблица порядка создана');

        const insert = db.prepare(
          `INSERT INTO thought_property_order
             (id, thought_id, property_id, side, position, updated_at)
           VALUES (?, 't1', 'p1', ?, 0, '2026-01-01T00:00:00.000Z')`,
        );
        insert.run('order-scalar-1', null);
        assert.throws(
          () => insert.run('order-scalar-2', null),
          /UNIQUE/,
          'NULL-сторона не разводит дубли скаляров',
        );
        // Разные стороны одного свойства — разные строки.
        insert.run('order-source', 'source');
        insert.run('order-target', 'target');
        assert.equal(
          (
            db
              .prepare(
                "SELECT COUNT(*) AS c FROM thought_property_order WHERE thought_id = 't1'",
              )
              .get() as { c: number }
          ).c,
          3,
        );
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

describe(
  '0.14.1 — чтение эффективного порядка в getPropertyValuesWithLinks',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('внетиповые скаляры идут по явной позиции, затем по created_at', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createNetworkProperty(ndb, { name: 'a', value_type: 'text' }, USER);
        const b = createNetworkProperty(ndb, { name: 'b', value_type: 'text' }, USER);
        const c = createNetworkProperty(ndb, { name: 'c', value_type: 'text' }, USER);
        const thoughtId = seedThought(ndb, 'Чтение порядка');
        seedValue(ndb, thoughtId, a.id, '2026-01-01T00:00:00.000Z');
        seedValue(ndb, thoughtId, b.id, '2026-01-02T00:00:00.000Z');
        seedValue(ndb, thoughtId, c.id, '2026-01-03T00:00:00.000Z');
        setThoughtPropertyOrder(ndb, thoughtId, [{ property_id: c.id, position: 0 }]);

        const values = getPropertyValuesWithLinks(ndb, 'thought', thoughtId);
        assert.deepEqual(
          values.filter((v) => v.outside_type === true).map((v) => v.property_id),
          [c.id, a.id, b.id],
        );
      } finally {
        ndb.close();
      }
    });
  },
);
