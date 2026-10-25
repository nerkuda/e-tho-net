/**
 * 0.14.1, задача a28d444b «Внетиповые отборы — сервер: таблица, CRUD,
 * эффективный набор, события» (сущность 52d34fed, ADR 6021918b, операция
 * 5e55b7bb, требования 045f539a/009f1136, события 5d447380).
 *
 * Покрывает DoD задачи:
 *   * CRUD: мысль с типом и без; чужой viewId — 404; идемпотентность;
 *     If-Match; дубль имени — DUPLICATE; delete → recreate того же имени;
 *     rename на имя с надгробием; materializeShadow-коллизия — 409;
 *   * эффективный набор: перекрытие типового внетиповым, порядок, дефолт,
 *     `scope`/`defined_on`/`inherited`, межслойное схлопывание по `name_key`,
 *     семантика дефолта (внетиповой с пометкой перекрывает типовой;
 *     не-одноимённый не-дефолтный типовой не трогает; одноимённый
 *     не-дефолтный убирает дефолт — «Потомки»), type-only путь без
 *     `scope` (инвариант редактора типа);
 *   * REST-run по имени и id (+run-событие, `meta.scope`/`defined_on`,
 *     отсутствие `type_id` у внетипового); типовой run не изменился;
 *   * события created/updated/deleted с полной карточкой и слоевой
 *     видимостью;
 *   * слои: невидимость в основе, мягкое замыкание пары переноса,
 *     слияние/отказ одной мысли уносит отборы, коллизия имён при слиянии —
 *     422, два дефолта после слияния — первый по `position, name`,
 *     корзина не трогает основу, purge удаляет физически;
 *   * каскад удаления мысли (owner-cleanup).
 *
 * Skip на отсутствии нативной сборки `better-sqlite3` — как у остальных
 * серверных тестов.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  BASE_LAYER_ID,
  EtnError,
  FILTER_AST_VERSION,
  type AnyRealtimeEvent,
} from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import {
  createThoughtType,
  getRootThoughtType,
} from '../src/domain/thought-type-service.js';
import { createThoughtTypeView, getEffectiveViewsForThought } from '../src/domain/thought-type-views-service.js';
import {
  createThoughtCustomView,
  deleteThoughtCustomView,
  getThoughtCustomView,
  listThoughtCustomViews,
  updateThoughtCustomView,
} from '../src/domain/thought-custom-views-service.js';
import {
  collectThoughtLayerRows,
  discardLayerThought,
  mergeLayer,
  mergeLayerThought,
} from '../src/domain/merge-service.js';
import { deleteThought, updateThought } from '../src/domain/thought-service.js';
import { isEventVisibleInLayer } from '../src/realtime/layer-visibility.js';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

const USER = 'user-1';
const DEFINITION = '{"keywords":"alpha","sort":"title","order":"asc"}';
const EMPTY_DEFINITION = '{}';

// ---------------------------------------------------------------------------
// In-memory helpers
// ---------------------------------------------------------------------------

/** Seed a thought directly in the current layer. */
function seedThought(
  ndb: NetworkDb,
  title: string,
  typeId: string | null = null,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, active,
                             is_protected, is_root, version, created_at, created_by,
                             updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, 1, ?, 'u', ?, 'u')`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), typeId, now, now);
  return id;
}

/** Insert a working layer over `parentId`. */
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

/** Raw custom-view row — для сценариев, где сервис намеренно обходится. */
function seedCustomView(
  ndb: NetworkDb,
  args: {
    id?: string;
    thoughtId: string;
    name: string;
    position?: number;
    isDefault?: boolean;
    deleted?: boolean;
  },
): string {
  const id = args.id ?? randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thought_custom_views
         (id, layer_id, deleted, thought_id, name, name_key, description, definition,
          position, is_default, version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, 'u')`,
    )
    .run(
      id,
      ndb.layerId,
      args.deleted === true ? 1 : 0,
      args.thoughtId,
      args.name,
      args.name.trim().toLowerCase(),
      EMPTY_DEFINITION,
      args.position ?? 0,
      args.isDefault === true ? 1 : 0,
      now,
      now,
    );
  return id;
}

/** Physical row count in a branchable table for a logical id. */
function rowCount(ndb: NetworkDb, table: string, where: string, ...args: unknown[]): number {
  return (
    ndb.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...args) as {
      c: number;
    }
  ).c;
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

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
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

async function createType(ctx: RestTestContext, name: string, parentId?: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types`,
    headers: authHeaders(ctx),
    payload: { name, ...(parentId === undefined ? {} : { parent_id: parentId }) },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

async function createTypeView(
  ctx: RestTestContext,
  typeId: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = authHeaders(ctx),
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
    headers,
    payload: { definition: EMPTY_DEFINITION, ...payload },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

function customViewsUrl(ctx: RestTestContext, thoughtId: string, viewId?: string): string {
  const base = `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/views`;
  return viewId === undefined ? base : `${base}/${viewId}`;
}

interface CustomViewResponse {
  statusCode: number;
  id?: string;
  body: string;
  json: () => {
    data?: unknown;
    error?: { code?: string; details?: { existing_id?: string } };
  };
}

async function createCustomView(
  ctx: RestTestContext,
  thoughtId: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = authHeaders(ctx),
): Promise<CustomViewResponse> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: customViewsUrl(ctx, thoughtId),
    headers,
    payload: { definition: EMPTY_DEFINITION, ...payload },
  });
  return {
    statusCode: res.statusCode,
    id: res.statusCode < 300 ? (res.json().data as { id: string }).id : undefined,
    body: res.body,
    json: () => res.json() as ReturnType<CustomViewResponse['json']>,
  };
}

/** Переключить сессию (`client-id`) на слой. */
async function selectLayer(
  ctx: RestTestContext,
  layerId: string,
  clientId: string,
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/select`,
    headers: { ...authHeaders(ctx), 'client-id': clientId },
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

async function createLayerViaRest(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Domain: CRUD
// ---------------------------------------------------------------------------

describe(
  'thought_custom_views — домен (0.14.1, a28d444b)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    function setup(): { ndb: NetworkDb; typeId: string; thoughtId: string } {
      const ndb = createInMemoryNetworkDb();
      const type = createThoughtType(ndb, { name: 'task' }, USER);
      const thoughtId = seedThought(ndb, 'Мысль с отборами', type.id);
      return { ndb, typeId: type.id, thoughtId };
    }

    it('create/list/get/update/delete: поля, порядок MAX+1, пересоздание имени', () => {
      const { ndb, thoughtId } = setup();
      try {
        const first = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: '  Активные  ', description: 'd', definition: DEFINITION, position: 3 },
          USER,
        );
        assert.equal(first.name, 'Активные');
        assert.equal(first.name_key, 'активные');
        assert.equal(first.description, 'd');
        assert.equal(first.position, 3);
        assert.equal(first.is_default, false);
        assert.equal(first.version, 1);

        const second = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'Работы', definition: DEFINITION },
          USER,
        );
        assert.equal(second.position, 4, 'MAX+1 среди видимых отборов мысли');

        const list = listThoughtCustomViews(ndb, thoughtId);
        assert.deepEqual(list.map((v) => v.name), ['Активные', 'Работы']);
        assert.deepEqual(getThoughtCustomView(ndb, first.id), first);

        const updated = updateThoughtCustomView(
          ndb,
          second.id,
          { name: 'Работы версии', position: 0 },
          1,
        );
        assert.equal(updated.name, 'Работы версии');
        assert.equal(updated.position, 0);
        assert.equal(updated.version, 2);

        deleteThoughtCustomView(ndb, first.id);
        assert.equal(getThoughtCustomView(ndb, first.id), null);
        // Надгробия в основе нет — имя свободно; новый id.
        const recreated = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'Активные', definition: DEFINITION },
          USER,
        );
        assert.notEqual(recreated.id, first.id);
        assert.equal(listThoughtCustomViews(ndb, thoughtId).length, 2);
      } finally {
        ndb.close();
      }
    });

    it('дубль имени в пределах мысли — DUPLICATE, у другой мысли — можно', () => {
      const { ndb, thoughtId } = setup();
      try {
        const first = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'Активные', definition: DEFINITION },
          USER,
        );
        assert.throws(
          () =>
            createThoughtCustomView(
              ndb,
              thoughtId,
              { name: '  активные ', definition: DEFINITION },
              USER,
            ),
          (err: unknown) => {
            assert.ok(err instanceof EtnError);
            assert.equal(err.code, 'DUPLICATE');
            assert.equal((err.details as { existing_id: string }).existing_id, first.id);
            return true;
          },
        );

        const other = seedThought(ndb, 'Другая мысль');
        const onOther = createThoughtCustomView(
          ndb,
          other,
          { name: 'Активные', definition: DEFINITION },
          USER,
        );
        assert.notEqual(onOther.id, first.id);
      } finally {
        ndb.close();
      }
    });

    it('дефолт: новый снимает прежний; внетиповой снимает типовой в наборе', () => {
      const { ndb, typeId, thoughtId } = setup();
      try {
        createThoughtTypeView(
          ndb,
          typeId,
          { name: 'Типовой дефолт', definition: DEFINITION, is_default: true },
          USER,
        );
        const a = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'A', definition: DEFINITION, is_default: true },
          USER,
        );
        const b = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'B', definition: DEFINITION, is_default: true },
          USER,
        );
        assert.equal(getThoughtCustomView(ndb, a.id)?.is_default, false);
        assert.equal(getThoughtCustomView(ndb, b.id)?.is_default, true);

        const effective = listThoughtCustomViews(ndb, thoughtId);
        assert.equal(effective.filter((v) => v.is_default).length, 1);
      } finally {
        ndb.close();
      }
    });

    it('update: VERSION_CONFLICT и NOT_FOUND', () => {
      const { ndb, thoughtId } = setup();
      try {
        const view = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'A', definition: DEFINITION },
          USER,
        );
        assert.throws(
          () => updateThoughtCustomView(ndb, view.id, { name: 'B' }, 99),
          (err: unknown) => err instanceof EtnError && err.code === 'VERSION_CONFLICT',
        );
        assert.throws(
          () => updateThoughtCustomView(ndb, randomUUID(), { name: 'B' }, undefined),
          (err: unknown) => err instanceof EtnError && err.code === 'NOT_FOUND',
        );
        assert.throws(
          () => createThoughtCustomView(ndb, randomUUID(), { name: 'C', definition: DEFINITION }, USER),
          (err: unknown) => err instanceof EtnError && err.code === 'NOT_FOUND',
        );
      } finally {
        ndb.close();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Domain: эффективный набор
// ---------------------------------------------------------------------------

describe(
  'thought_custom_views — эффективный набор (045f539a)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('перекрытие/порядок/scope/defined_on/inherited; type-only путь без scope', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const root = getRootThoughtType(ndb);
        assert.ok(root);
        const parent = createThoughtType(
          ndb,
          { name: 'parent-type', parent_id: root!.id },
          USER,
        );
        const child = createThoughtType(
          ndb,
          { name: 'child-type', parent_id: parent.id },
          USER,
        );
        createThoughtTypeView(
          ndb,
          parent.id,
          { name: 'Общий', definition: DEFINITION, position: 0, is_default: true },
          USER,
        );
        createThoughtTypeView(
          ndb,
          child.id,
          { name: 'Свой', definition: DEFINITION, position: 0 },
          USER,
        );
        const thoughtId = seedThought(ndb, 'Мысль', child.id);

        const custom = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'общий', definition: DEFINITION, position: 0 },
          USER,
        );

        const effective = getEffectiveViewsForThought(ndb, {
          id: thoughtId,
          type_id: child.id,
        });

        // Перекрытие: типовой «Общий» исчез, внетиповой «общий» остался.
        const mixed = listThoughtCustomViews(ndb, thoughtId);
        assert.equal(mixed.length, 1);
        assert.equal(mixed[0]!.id, custom.id);

        const set = effective;
        assert.deepEqual(
          set.map((v) => ({ name: v.name, scope: v.scope, defined_on: v.defined_on })),
          [
            { name: 'Свой', scope: 'type', defined_on: child.id },
            { name: 'общий', scope: 'thought', defined_on: thoughtId },
          ],
        );
        const customEntry = set.find((v) => v.scope === 'thought')!;
        assert.equal(customEntry.inherited, false);
        assert.equal('thought_type_id' in customEntry, false);

        // Type-only путь: форма без scope и без внетиповых.
        const typeOnly = getEffectiveViewsForThought(ndb, { type_id: child.id });
        assert.deepEqual(typeOnly.map((v) => v.name), ['Общий', 'Свой']);
        assert.equal(typeOnly.some((v) => 'scope' in v), false);
      } finally {
        ndb.close();
      }
    });

    it('порядок: сначала типовые (корень→тип), затем внетиповые по position,name', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'task' }, USER);
        createThoughtTypeView(
          ndb,
          type.id,
          { name: 'Типовой', definition: DEFINITION, position: 0, is_default: true },
          USER,
        );
        const thoughtId = seedThought(ndb, 'Мысль', type.id);
        createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'Поздний', definition: DEFINITION, position: 10 },
          USER,
        );
        createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'Ранний', definition: DEFINITION, position: 1 },
          USER,
        );
        const set = getEffectiveViewsForThought(ndb, { id: thoughtId, type_id: type.id });
        assert.deepEqual(
          set.map((v) => [v.name, v.scope]),
          [
            ['Типовой', 'type'],
            ['Ранний', 'thought'],
            ['Поздний', 'thought'],
          ],
        );
      } finally {
        ndb.close();
      }
    });

    it('семантика дефолта: внетиповой с пометкой перекрывает типовой дефолт', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'task' }, USER);
        createThoughtTypeView(
          ndb,
          type.id,
          { name: 'Типовой', definition: DEFINITION, position: 0, is_default: true },
          USER,
        );
        const thoughtId = seedThought(ndb, 'Мысль', type.id);
        createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'Мой', definition: DEFINITION, position: 5, is_default: true },
          USER,
        );
        const set = getEffectiveViewsForThought(ndb, { id: thoughtId, type_id: type.id });
        assert.deepEqual(
          set.map((v) => [v.name, v.is_default]),
          [
            ['Типовой', false],
            ['Мой', true],
          ],
        );
      } finally {
        ndb.close();
      }
    });

    it('семантика дефолта: не-одноимённый не-дефолтный внетиповой типовой дефолт не трогает', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'task' }, USER);
        createThoughtTypeView(
          ndb,
          type.id,
          { name: 'Типовой', definition: DEFINITION, position: 0, is_default: true },
          USER,
        );
        const thoughtId = seedThought(ndb, 'Мысль', type.id);
        createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'Свой', definition: DEFINITION, position: 0 },
          USER,
        );
        const set = getEffectiveViewsForThought(ndb, { id: thoughtId, type_id: type.id });
        assert.deepEqual(
          set.map((v) => [v.name, v.is_default]),
          [
            ['Типовой', true],
            ['Свой', false],
          ],
        );
        assert.equal(set.filter((v) => v.is_default).length, 1, 'дефолт ровно один — типовой');
      } finally {
        ndb.close();
      }
    });

    it('семантика дефолта: одноимённый не-дефолтный внетиповой убирает типовой дефолт — «Потомки»', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'task' }, USER);
        createThoughtTypeView(
          ndb,
          type.id,
          { name: 'Типовой', definition: DEFINITION, position: 0, is_default: true },
          USER,
        );
        createThoughtTypeView(
          ndb,
          type.id,
          { name: 'Второй', definition: DEFINITION, position: 1 },
          USER,
        );
        const thoughtId = seedThought(ndb, 'Мысль', type.id);
        createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'типовой', definition: DEFINITION, position: 0 },
          USER,
        );
        const set = getEffectiveViewsForThought(ndb, { id: thoughtId, type_id: type.id });
        // Типовой «Типовой» перекрыт одноимённым внетиповым и из набора ушёл
        // вместе с дефолтом; других дефолтов нет — при фокусе «Потомки».
        assert.deepEqual(
          set.map((v) => [v.name, v.is_default]),
          [
            ['Второй', false],
            ['типовой', false],
          ],
        );
        assert.equal(set.some((v) => v.is_default), false);
      } finally {
        ndb.close();
      }
    });

    it('удаление/переименование внетипового возвращает типовой отбор (с его дефолтом)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'task' }, USER);
        createThoughtTypeView(
          ndb,
          type.id,
          { name: 'Общий', definition: DEFINITION, position: 0, is_default: true },
          USER,
        );
        const thoughtId = seedThought(ndb, 'Мысль', type.id);
        const custom = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'общий', definition: DEFINITION, position: 0 },
          USER,
        );

        // Перекрытие: типовой ушёл, дефолта в наборе нет.
        const overlapped = getEffectiveViewsForThought(ndb, { id: thoughtId, type_id: type.id });
        assert.deepEqual(
          overlapped.map((v) => [v.name, v.scope, v.is_default]),
          [['общий', 'thought', false]],
        );

        // Удаление внетипового возвращает типовой вместе с пометкой дефолта.
        deleteThoughtCustomView(ndb, custom.id);
        const afterDelete = getEffectiveViewsForThought(ndb, { id: thoughtId, type_id: type.id });
        assert.deepEqual(
          afterDelete.map((v) => [v.name, v.scope, v.is_default]),
          [['Общий', 'type', true]],
        );

        // Переименование внетипового — то же: имя типового освободилось.
        const renamedTarget = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'общий', definition: DEFINITION, position: 0 },
          USER,
        );
        updateThoughtCustomView(ndb, renamedTarget.id, { name: 'Другой' }, undefined);
        const afterRename = getEffectiveViewsForThought(ndb, { id: thoughtId, type_id: type.id });
        assert.deepEqual(
          afterRename.map((v) => [v.name, v.scope, v.is_default]),
          [
            ['Общий', 'type', true],
            ['Другой', 'thought', false],
          ],
        );
      } finally {
        ndb.close();
      }
    });

    it('межслойные одноимённые живые схлопываются по name_key: побеждает первый position,name', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const thoughtId = seedThought(ndb, 'Мысль');
        seedCustomView(ndb, {
          thoughtId,
          name: 'Один',
          position: 5,
        });
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        const layerView = seedCustomView(ndb, {
          thoughtId,
          name: 'Один',
          position: 0,
        });
        const set = getEffectiveViewsForThought(ndb, { id: thoughtId, type_id: null });
        assert.deepEqual(set.map((v) => v.id), [layerView]);
        // В слое видны обе строки (разные id), имя одно — кнопка одна.
        assert.equal(listThoughtCustomViews(ndb, thoughtId).length, 2);
      } finally {
        ndb.close();
      }
    });

    it('в основе внетиповой отбор слоя не виден', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const thoughtId = seedThought(ndb, 'Мысль');
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'Из слоя', definition: DEFINITION },
          USER,
        );
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(listThoughtCustomViews(ndb, thoughtId), []);
        ndb.useLayer(layerId);
        assert.deepEqual(listThoughtCustomViews(ndb, thoughtId).map((v) => v.name), ['Из слоя']);
      } finally {
        ndb.close();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Domain: слои — набор строк, пара переноса, слияние/отказ, коллизии
// ---------------------------------------------------------------------------

describe(
  'thought_custom_views — слои (009f1136)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('collectThoughtLayerRows включает отборы мысли и пару переноса только при её наличии', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'task' }, USER);
        const thoughtId = seedThought(ndb, 'Мысль', type.id);
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        const customId = seedCustomView(ndb, { thoughtId, name: 'Из слоя' });

        // Пары нет — набор не падает и не требует соседней строки.
        const withoutPair = collectThoughtLayerRows(ndb, layerId, thoughtId);
        assert.deepEqual(withoutPair.thought_custom_views, [customId]);
        assert.equal(withoutPair.thought_type_views, undefined);

        // Пара переноса: тот же id физически в thought_type_views.
        ndb
          .prepare(
            `INSERT INTO thought_type_views
               (id, layer_id, deleted, thought_type_id, name, name_key, definition,
                position, is_default, version, created_at, updated_at, created_by)
             VALUES (?, ?, 1, ?, 'Из слоя', 'из слоя', '{}', 0, 0, 1,
                     '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'u')`,
          )
          .run(customId, layerId, type.id);
        const withPair = collectThoughtLayerRows(ndb, layerId, thoughtId);
        assert.deepEqual(withPair.thought_type_views, [customId]);
      } finally {
        ndb.close();
      }
    });

    it('частичное слияние внетипового тянет пару переноса; отбор без пары сливается без missing_closure', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'task' }, USER);
        const thoughtId = seedThought(ndb, 'Мысль', type.id);
        // Пара переноса существует в ОСНОВЕ: живой отбор типа, который слой
        // снял надгробием и превратил в внетиповой с тем же id.
        const withPair = randomUUID();
        ndb
          .prepare(
            `INSERT INTO thought_type_views
               (id, layer_id, deleted, thought_type_id, name, name_key, definition,
                position, is_default, version, created_at, updated_at, created_by)
             VALUES (?, ?, 0, ?, 'С парой', 'с парой', '{}', 0, 0, 1,
                     '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'u')`,
          )
          .run(withPair, BASE_LAYER_ID, type.id);
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        seedCustomView(ndb, { id: withPair, thoughtId, name: 'С парой' });
        ndb
          .prepare(
            `INSERT INTO thought_type_views
               (id, layer_id, deleted, base_version, thought_type_id, name, name_key, definition,
                position, is_default, version, created_at, updated_at, created_by)
             VALUES (?, ?, 1, 1, ?, 'С парой', 'с парой', '{}', 0, 0, 2,
                     '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'u')`,
          )
          .run(withPair, layerId, type.id);
        const withoutPair = seedCustomView(ndb, { thoughtId, name: 'Без пары' });

        // Частичное слияние только внетиповых строк: пара типа уезжает
        // автоматически (физически есть в слое).
        const report = mergeLayer(
          ndb,
          layerId,
          { thought_custom_views: [withPair, withoutPair] },
          USER,
        );
        assert.equal(report.applied.thought_custom_views, 2);
        assert.equal(report.applied.thought_type_views, 1, 'надгробие пары перенесено');
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(
          rowCount(ndb, 'thought_custom_views', 'id = ? AND layer_id = ?', withPair, BASE_LAYER_ID),
          1,
        );
        // Надгробие в цель-основу удаляет строку физически (бэкап остаётся
        // в служебном слое, в рабочих слоях её больше нет).
        assert.equal(
          rowCount(
            ndb,
            'thought_type_views',
            'id = ? AND layer_id = ?',
            withPair,
            BASE_LAYER_ID,
          ),
          0,
        );
      } finally {
        ndb.close();
      }
    });

    it('слияние/отказ одной мысли уносит внетиповые отборы', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const thoughtId = seedThought(ndb, 'Мысль');
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        const viewId = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'В слое', definition: DEFINITION },
          USER,
        ).id;
        mergeLayerThought(ndb, layerId, thoughtId, 'overwrite', USER);
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          listThoughtCustomViews(ndb, thoughtId).map((v) => v.id),
          [viewId],
        );

        const layer2 = seedLayer(ndb);
        ndb.useLayer(layer2);
        updateThoughtCustomView(ndb, viewId, { name: 'Отказ' }, undefined);
        const discarded = discardLayerThought(ndb, layer2, thoughtId);
        assert.equal(discarded.discarded.thought_custom_views, 1);
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          listThoughtCustomViews(ndb, thoughtId).map((v) => v.name),
          ['В слое'],
        );
      } finally {
        ndb.close();
      }
    });

    it('коллизия одноимённых строк двух слоёв при слиянии — 422 constraint', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const thoughtId = seedThought(ndb, 'Мысль');
        createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'Одинаковый', definition: DEFINITION },
          USER,
        );
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        seedCustomView(ndb, { thoughtId, name: 'Одинаковый', position: 1 });
        ndb.useLayer(BASE_LAYER_ID);
        assert.throws(
          () => mergeLayer(ndb, layerId, undefined, USER),
          (err: unknown) => {
            assert.ok(err instanceof EtnError);
            assert.equal(err.code, 'VALIDATION_ERROR');
            assert.match(err.message, /уникальный ключ/);
            return true;
          },
        );
      } finally {
        ndb.close();
      }
    });

    it('два дефолта после слияния: эффективный — первый по position, name', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const thoughtId = seedThought(ndb, 'Мысль');
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        seedCustomView(ndb, { thoughtId, name: 'Второй', position: 9, isDefault: true });
        seedCustomView(ndb, { thoughtId, name: 'Первый', position: 1, isDefault: true });
        ndb.useLayer(BASE_LAYER_ID);
        mergeLayer(ndb, layerId, undefined, USER);
        assert.equal(rowCount(ndb, 'thought_custom_views', 'is_default = 1'), 2);
        const set = getEffectiveViewsForThought(ndb, { id: thoughtId, type_id: null });
        assert.deepEqual(
          set.map((v) => [v.name, v.is_default]),
          [
            ['Первый', true],
            ['Второй', false],
          ],
        );
      } finally {
        ndb.close();
      }
    });

    it('коллизия тени предкового дефолта — DUPLICATE, не сырой constraint (Б1)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const thoughtId = seedThought(ndb, 'Мысль');
        const layerId = seedLayer(ndb);
        // Слой живёт своей жизнью: имя «A» занято его живой строкой.
        ndb.useLayer(layerId);
        const layerView = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'A', definition: DEFINITION, position: 0 },
          USER,
        );
        // В основе поверх появляется одноимённый ДЕФОЛТ (слой его не видел).
        ndb.useLayer(BASE_LAYER_ID);
        createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'A', definition: DEFINITION, position: 0, is_default: true },
          USER,
        );
        // Установка дефолта «B» в слое требует снять дефолт предка «A» —
        // материализация его тени упирается в живое имя слоя.
        ndb.useLayer(layerId);
        assert.throws(
          () =>
            createThoughtCustomView(
              ndb,
              thoughtId,
              { name: 'B', definition: DEFINITION, position: 1, is_default: true },
              USER,
            ),
          (err: unknown) => {
            assert.ok(err instanceof EtnError, 'домен отдаёт EtnError, не SqliteError');
            assert.equal(err.code, 'DUPLICATE');
            assert.equal(
              (err.details as { existing_id?: string }).existing_id,
              layerView.id,
            );
            return true;
          },
        );
        // Транзакция откатилась: «B» не создан ни в одном слое.
        assert.equal(
          rowCount(
            ndb,
            'thought_custom_views',
            'thought_id = ? AND name_key = ? AND deleted = 0',
            thoughtId,
            'b',
          ),
          0,
          '«B» не создан — транзакция откатилась',
        );
      } finally {
        ndb.close();
      }
    });

    it('в рабочем слое: delete/recreate того же имени и rename на имя с надгробием', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const thoughtId = seedThought(ndb, 'Мысль');
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        const first = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'A', definition: DEFINITION },
          USER,
        );
        deleteThoughtCustomView(ndb, first.id);
        // Надгробие не занимает имя: новая живая строка с новым id.
        const recreated = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'A', definition: DEFINITION },
          USER,
        );
        assert.notEqual(recreated.id, first.id);
        assert.equal(recreated.name_key, 'a');

        // Rename на имя, у которого в слое лежит надгробие, — можно.
        deleteThoughtCustomView(ndb, recreated.id);
        const b = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'B', definition: DEFINITION },
          USER,
        );
        const renamed = updateThoughtCustomView(ndb, b.id, { name: '  a ' }, undefined);
        assert.equal(renamed.name_key, 'a');
      } finally {
        ndb.close();
      }
    });

    it('удаление мысли: purge в основе физически, в слое — надгробия', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const thoughtId = seedThought(ndb, 'Мысль');
        const viewId = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'A', definition: DEFINITION },
          USER,
        ).id;
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);

        // В слое мысль удаляется надгробиями, основа не тронута.
        deleteThought(ndb, thoughtId, undefined, USER);
        assert.equal(listThoughtCustomViews(ndb, thoughtId).length, 0);
        assert.equal(
          rowCount(
            ndb,
            'thought_custom_views',
            'id = ? AND layer_id = ? AND deleted = 1',
            viewId,
            layerId,
          ),
          1,
        );
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(listThoughtCustomViews(ndb, thoughtId).length, 1);

        // Необратимое удаление в основе выметает строки всех слоёв.
        deleteThought(ndb, thoughtId, undefined, USER);
        assert.equal(rowCount(ndb, 'thought_custom_views', 'thought_id = ?', thoughtId), 0);
      } finally {
        ndb.close();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Слоевая видимость событий
// ---------------------------------------------------------------------------

describe(
  'thought-custom-view.* — видимость слоёв',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    function event(
      type: 'thought-custom-view.created' | 'thought-custom-view.updated' | 'thought-custom-view.deleted' | 'thought-custom-view.run',
      layerId: string,
      data: Record<string, unknown>,
    ): AnyRealtimeEvent {
      return {
        type,
        seq: 1,
        ts: '2026-01-01T00:00:00.000Z',
        actor: { user_id: 'u2', client_id: 'c2' },
        network_id: 'n1',
        audience: 'network',
        layer_id: layerId,
        data,
      } as unknown as AnyRealtimeEvent;
    }

    it('created/updated/deleted видны по ближайшей строке; run — всегда', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const thoughtId = seedThought(ndb, 'Мысль');
        const viewId = seedCustomView(ndb, { thoughtId, name: 'A' });
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        // Слой перекрывает отбор надгробием.
        ndb
          .prepare(
            `INSERT INTO thought_custom_views
               (id, layer_id, deleted, thought_id, name, name_key, description, definition,
                position, is_default, version, created_at, updated_at, created_by)
             VALUES (?, ?, 1, ?, 'A', 'a', NULL, '{}', 0, 0, 1,
                     '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'u')`,
          )
          .run(viewId, layerId, thoughtId);

        // Подписчик слоя: событие основы перекрыто — не видно.
        assert.equal(
          isEventVisibleInLayer(
            ndb,
            event('thought-custom-view.updated', BASE_LAYER_ID, { thought_id: thoughtId, view_id: viewId }),
            layerId,
          ),
          false,
        );
        // Собственное событие слоя — видно.
        assert.equal(
          isEventVisibleInLayer(
            ndb,
            event('thought-custom-view.updated', layerId, { thought_id: thoughtId, view_id: viewId }),
            layerId,
          ),
          true,
        );
        // Удаление в основе: строка на цепочке слоя есть (надгробие), но
        // событие не из её слоя — не доставляем.
        assert.equal(
          isEventVisibleInLayer(
            ndb,
            event('thought-custom-view.deleted', BASE_LAYER_ID, { thought_id: thoughtId, view_id: viewId }),
            layerId,
          ),
          false,
        );
        // Run — не правка ветвимой строки: виден в любом слое.
        assert.equal(
          isEventVisibleInLayer(
            ndb,
            event('thought-custom-view.run', BASE_LAYER_ID, { thought_id: thoughtId, view_id: viewId }),
            layerId,
          ),
          true,
        );
      } finally {
        ndb.close();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

describe(
  'thought_custom_views — REST (5e55b7bb)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('CRUD happy path с If-Match, чужим id — 404, идемпотентностью и пересозданием', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const typeId = await createType(ctx, 'task');
        const thoughtId = await createThought(ctx, 'Мысль', typeId);

        const created = await createCustomView(ctx, thoughtId, {
          name: 'Активные',
          description: 'd',
          definition: DEFINITION,
        });
        assert.equal(created.statusCode, 201, created.body);
        const view = created.json().data as {
          id: string;
          thought_id: string;
          name: string;
          name_key: string;
          position: number;
          version: number;
        };
        assert.equal(view.thought_id, thoughtId);
        assert.equal(view.name, 'Активные');
        assert.equal(view.name_key, 'активные');
        assert.equal(view.position, 0);

        // Список собственных отборов мысли.
        const list = await ctx.app.inject({
          method: 'GET',
          url: customViewsUrl(ctx, thoughtId),
          headers: h,
        });
        assert.equal(list.statusCode, 200);
        assert.equal((list.json().data as Array<{ id: string }>).length, 1);

        // Захват мысли не блокирует правку отборов (операция 5e55b7bb).
        const lock = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/locks`,
          headers: h,
          payload: { network_id: ctx.networkId, entity_type: 'thought', entity_id: thoughtId },
        });
        assert.equal(lock.statusCode, 200, lock.body?.toString());
        const underLock = await createCustomView(ctx, thoughtId, { name: 'Под захватом' });
        assert.equal(underLock.statusCode, 201);

        // GET по id.
        const one = await ctx.app.inject({
          method: 'GET',
          url: customViewsUrl(ctx, thoughtId, view.id),
          headers: h,
        });
        assert.equal(one.statusCode, 200);

        // Чужой viewId (отбор другой мысли) — 404, не 403.
        const other = await createThought(ctx, 'Другая');
        const foreign = await ctx.app.inject({
          method: 'GET',
          url: customViewsUrl(ctx, other, view.id),
          headers: h,
        });
        assert.equal(foreign.statusCode, 404);

        // PATCH с If-Match.
        const patched = await ctx.app.inject({
          method: 'PATCH',
          url: customViewsUrl(ctx, thoughtId, view.id),
          headers: { ...h, 'if-match': '1' },
          payload: { name: 'Активные 2' },
        });
        assert.equal(patched.statusCode, 200, patched.body?.toString());
        assert.equal((patched.json().data as { version: number }).version, 2);

        const conflict = await ctx.app.inject({
          method: 'PATCH',
          url: customViewsUrl(ctx, thoughtId, view.id),
          headers: { ...h, 'if-match': '1' },
          payload: { name: 'Ещё' },
        });
        assert.equal(conflict.statusCode, 409);
        assert.equal(conflict.json().error.code, 'VERSION_CONFLICT');

        // DELETE + повторное создание имени.
        const deleted = await ctx.app.inject({
          method: 'DELETE',
          url: customViewsUrl(ctx, thoughtId, view.id),
          headers: { ...h, 'if-match': '2' },
        });
        assert.equal(deleted.statusCode, 204);
        const recreated = await createCustomView(ctx, thoughtId, { name: 'Активные 2' });
        assert.equal(recreated.statusCode, 201);
        assert.notEqual(recreated.id, view.id);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('корзина мысли (marked_for_deletion) не трогает её отборы', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const typeId = await createType(ctx, 'task');
        await createTypeView(ctx, typeId, { name: 'Типовой', is_default: true });
        const thoughtId = await createThought(ctx, 'Мысль', typeId);
        const custom = await createCustomView(ctx, thoughtId, { name: 'Мой' });
        assert.equal(custom.statusCode, 201, custom.body);

        const trashed = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}`,
          headers: h,
          payload: { marked_for_deletion: true },
        });
        assert.equal(trashed.statusCode, 200, trashed.body?.toString());

        // Отборы остаются живыми: корзина мысли — не удаление зависимостей.
        const list = await ctx.app.inject({
          method: 'GET',
          url: customViewsUrl(ctx, thoughtId),
          headers: h,
        });
        assert.equal(list.statusCode, 200);
        assert.deepEqual(
          (list.json().data as Array<{ id: string; name: string }>).map((v) => [v.id, v.name]),
          [[custom.id, 'Мой']],
        );

        const effective = await ctx.app.inject({
          method: 'GET',
          url: `${customViewsUrl(ctx, thoughtId)}?include_effective=true`,
          headers: h,
        });
        assert.equal(effective.statusCode, 200);
        assert.deepEqual(
          (
            effective.json().meta as {
              effective: Array<{ name: string; scope: string; is_default: boolean }>;
            }
          ).effective.map((v) => [v.name, v.scope, v.is_default]),
          [
            ['Типовой', 'type', true],
            ['Мой', 'thought', false],
          ],
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('идемпотентность: повтор POST с Client-Request-Id отдаёт тот же отбор', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const thoughtId = await createThought(ctx, 'Мысль');
        const payload = { name: 'Идемпотентный', definition: EMPTY_DEFINITION };
        const headers = { ...h, 'client-request-id': `req-${randomUUID()}` };
        const first = await ctx.app.inject({
          method: 'POST',
          url: customViewsUrl(ctx, thoughtId),
          headers,
          payload,
        });
        assert.equal(first.statusCode, 201, first.body?.toString());
        const second = await ctx.app.inject({
          method: 'POST',
          url: customViewsUrl(ctx, thoughtId),
          headers,
          payload,
        });
        assert.equal(second.statusCode, 201, second.body?.toString());
        assert.equal(
          (second.json().data as { id: string }).id,
          (first.json().data as { id: string }).id,
        );
        const list = await ctx.app.inject({
          method: 'GET',
          url: customViewsUrl(ctx, thoughtId),
          headers: h,
        });
        assert.equal((list.json().data as unknown[]).length, 1);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('дубль имени — 409 DUPLICATE; materializeShadow-коллизия — 409, не 500', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const thoughtId = await createThought(ctx, 'Мысль');
        const base = await createCustomView(ctx, thoughtId, { name: 'Общий' });
        assert.equal(base.statusCode, 201);

        const dup = await createCustomView(ctx, thoughtId, { name: 'общий' });
        assert.equal(dup.statusCode, 409);
        assert.equal(dup.json().error!.code, 'DUPLICATE');
        assert.equal(
          (dup.json().error!.details as { existing_id: string }).existing_id,
          base.id,
        );

        // Слой: живое имя занято строкой слоя, затем независимо заводим
        // одноимённую строку в основе и правим её из слоя — materializeShadow
        // натыкается на UNIQUE, домен отдаёт 409, а не 500.
        const layerId = await createLayerViaRest(ctx, 'Слой коллизии');
        const layerHeaders = { ...h, 'client-id': 'layer-collision' };
        await selectLayer(ctx, layerId, 'layer-collision');
        const layerView = await createCustomView(
          ctx,
          thoughtId,
          { name: 'Слоёный' },
          layerHeaders,
        );
        assert.equal(layerView.statusCode, 201, layerView.body);

        // Базовая сессия слоя не видит — имя свободно (изоляция слоёв).
        const baseView = await createCustomView(ctx, thoughtId, { name: 'Слоёный' });
        assert.equal(baseView.statusCode, 201, baseView.body);

        const patchBase = await ctx.app.inject({
          method: 'PATCH',
          url: customViewsUrl(ctx, thoughtId, baseView.id!),
          headers: { ...layerHeaders, 'if-match': '1' },
          payload: { description: 'правка базовой строки в слое' },
        });
        assert.equal(patchBase.statusCode, 409, patchBase.body?.toString());
        assert.equal(patchBase.json().error.code, 'DUPLICATE');
        assert.equal(
          ((patchBase.json().error.details as { existing_id: string })).existing_id,
          layerView.id,
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('репро проверки раунда 1: POST дефолта в слое при живой одноимённой строке основы — 409, не 500', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const thoughtId = await createThought(ctx, 'Мысль');

        // (2) слой L, сессия A переключена в L.
        const layerId = await createLayerViaRest(ctx, 'Слой дефолта');
        const layerHeaders = { ...h, 'client-id': 'default-shadow-layer' };
        await selectLayer(ctx, layerId, 'default-shadow-layer');

        // (3) POST {name:'A'} в L → 201.
        const layerView = await createCustomView(ctx, thoughtId, { name: 'A' }, layerHeaders);
        assert.equal(layerView.statusCode, 201, layerView.body);

        // (4) сессия основы POST {name:'A', is_default:true} → 201 (слой не видит).
        const baseDefault = await createCustomView(ctx, thoughtId, {
          name: 'A',
          is_default: true,
        });
        assert.equal(baseDefault.statusCode, 201, baseDefault.body);

        // (5) сессия L POST {name:'B', is_default:true}: снятие дефолта предка
        // материализует его тень в слой и упирается в живое имя «A».
        const res = await createCustomView(
          ctx,
          thoughtId,
          { name: 'B', is_default: true },
          layerHeaders,
        );
        assert.equal(res.statusCode, 409, res.body);
        assert.equal(res.json().error!.code, 'DUPLICATE');
        assert.equal(res.json().error!.details!.existing_id, layerView.id);

        // Откат: «B» не создан, у слоя по-прежнему один живой отбор «A».
        const list = await ctx.app.inject({
          method: 'GET',
          url: customViewsUrl(ctx, thoughtId),
          headers: layerHeaders,
        });
        assert.deepEqual(
          (list.json().data as Array<{ name: string }>).map((v) => v.name),
          ['A'],
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('репро замечания проверки V1: UPDATE-путь коллизии тени дефолта — PATCH is_default в слое → 409, не 500', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const thoughtId = await createThought(ctx, 'Мысль');

        // Слой L видит свою живую строку «A»; в основе поверх неё появляется
        // одноимённый ДЕФОЛТ (слой его не видел).
        const layerId = await createLayerViaRest(ctx, 'Слой update-дефолта');
        const layerHeaders = { ...h, 'client-id': 'default-shadow-update' };
        await selectLayer(ctx, layerId, 'default-shadow-update');
        const layerA = await createCustomView(ctx, thoughtId, { name: 'A' }, layerHeaders);
        assert.equal(layerA.statusCode, 201, layerA.body);
        const baseA = await createCustomView(ctx, thoughtId, {
          name: 'A',
          is_default: true,
        });
        assert.equal(baseA.statusCode, 201, baseA.body);

        // В слое живёт не-дефолтный «B».
        const layerB = await createCustomView(ctx, thoughtId, { name: 'B' }, layerHeaders);
        assert.equal(layerB.statusCode, 201, layerB.body);

        // PATCH is_default:true на «B» обязан снять дефолт предка «A» — его
        // материализация в слой упирается в живое имя «A» слоя. Замечание
        // проверки V1: UPDATE-путь не был покрыт отдельным тестом (POST — да).
        const patched = await ctx.app.inject({
          method: 'PATCH',
          url: customViewsUrl(ctx, thoughtId, layerB.id!),
          headers: { ...layerHeaders, 'if-match': '1' },
          payload: { is_default: true },
        });
        assert.equal(patched.statusCode, 409, patched.body?.toString());
        assert.equal(patched.json().error.code, 'DUPLICATE');
        assert.equal(patched.json().error.details.existing_id, layerA.id);

        // Транзакция откатилась: «B» без пометки и с прежней версией.
        const after = await ctx.app.inject({
          method: 'GET',
          url: customViewsUrl(ctx, thoughtId, layerB.id!),
          headers: layerHeaders,
        });
        assert.equal(after.statusCode, 200);
        const row = after.json().data as {
          name: string;
          is_default: boolean;
          version: number;
        };
        assert.equal(row.name, 'B');
        assert.equal(row.is_default, false, 'пометка не поставлена — откат');
        assert.equal(row.version, 1, 'версия не сдвинулась — откат');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('include_effective отдаёт смешанный набор; type-views не содержит scope thought', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const parentType = await createType(ctx, 'parent-type');
        const typeId = await createType(ctx, 'child-type', parentType);
        await createTypeView(ctx, parentType, {
          name: 'Типовой',
          is_default: true,
          position: 0,
        });
        const thoughtId = await createThought(ctx, 'Мысль', typeId);
        const custom = await createCustomView(ctx, thoughtId, { name: 'Внетиповой' });
        assert.equal(custom.statusCode, 201);

        const res = await ctx.app.inject({
          method: 'GET',
          url: `${customViewsUrl(ctx, thoughtId)}?include_effective=true`,
          headers: h,
        });
        assert.equal(res.statusCode, 200);
        const meta = res.json().meta as {
          effective: Array<{
            id: string;
            name: string;
            scope: string;
            defined_on: string;
            inherited: boolean;
          }>;
        };
        assert.deepEqual(
          meta.effective.map((v) => [v.name, v.scope, v.defined_on]),
          [
            ['Типовой', 'type', parentType],
            ['Внетиповой', 'thought', thoughtId],
          ],
        );

        // Инвариант редактора типа: в отборах типа нет ни одного внетипового.
        const typeViews = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views?include_effective=true`,
          headers: h,
        });
        assert.equal(typeViews.statusCode, 200);
        const typeMeta = typeViews.json().meta as {
          effective: Array<{ name: string; scope?: string }>;
        };
        assert.deepEqual(typeMeta.effective.map((v) => v.name), ['Типовой']);
        assert.equal(typeMeta.effective.some((v) => v.scope === 'thought'), false);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('own_default: собственная пометка не зануляется внетиповым дефолтом (репро x6)', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        // У типа есть СОБСТВЕННЫЙ дефолт, у мысли — внетиповой дефолт. Сервер
        // снимает пометку при переносе по собственной, поэтому эффективная
        // строка типа обязана нести `own_default: true` даже при
        // `is_default: false` (дельта раунда 2 проверки c2bbffab).
        const typeId = await createType(ctx, 'тип-с-дефолтом');
        await createTypeView(ctx, typeId, { name: 'Работы типа', is_default: true });
        const thoughtId = await createThought(ctx, 'Мысль', typeId);
        const customDefault = await createCustomView(ctx, thoughtId, {
          name: 'В гараже',
          is_default: true,
        });
        assert.equal(customDefault.statusCode, 201, customDefault.body);
        const customPlain = await createCustomView(ctx, thoughtId, { name: 'Кому одолжил' });
        assert.equal(customPlain.statusCode, 201, customPlain.body);

        const res = await ctx.app.inject({
          method: 'GET',
          url: `${customViewsUrl(ctx, thoughtId)}?include_effective=true`,
          headers: h,
        });
        assert.equal(res.statusCode, 200);
        const effective = (res.json().meta as {
          effective: Array<{
            name: string;
            scope: string;
            is_default: boolean;
            own_default: boolean;
          }>;
        }).effective;
        const byName = new Map(effective.map((v) => [v.name, v]));

        const typeRow = byName.get('Работы типа');
        assert.ok(typeRow !== undefined, 'типовой отбор в наборе');
        assert.equal(typeRow.scope, 'type');
        assert.equal(typeRow.is_default, false, 'эффективный дефолт занулён внетиповым');
        assert.equal(typeRow.own_default, true, 'собственная пометка типа сохраняется');

        const customDefaultRow = byName.get('В гараже');
        assert.ok(customDefaultRow !== undefined);
        assert.equal(customDefaultRow.scope, 'thought');
        assert.equal(customDefaultRow.is_default, true);
        assert.equal(customDefaultRow.own_default, true);

        const customPlainRow = byName.get('Кому одолжил');
        assert.ok(customPlainRow !== undefined);
        assert.equal(customPlainRow.scope, 'thought');
        assert.equal(customPlainRow.is_default, false);
        assert.equal(customPlainRow.own_default, false);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('run внетипового по имени и id: meta.scope/defined_on без type_id, событие run', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const typeId = await createType(ctx, 'task');
        const thoughtId = await createThought(ctx, 'alphа-контекст', typeId);
        const custom = await createCustomView(ctx, thoughtId, { name: 'Мой отбор' });
        assert.equal(custom.statusCode, 201);

        const pubsub = ctx.app.pubsub;
        const received: AnyRealtimeEvent[] = [];
        const unsubscribe = pubsub.subscribe(ctx.networkId, (e: AnyRealtimeEvent) =>
          received.push(e),
        );
        try {
          const byName = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/views/${encodeURIComponent('Мой отбор')}/run`,
            headers: h,
            payload: {},
          });
          assert.equal(byName.statusCode, 200, byName.body?.toString());
          const meta = byName.json().meta as {
            view: { id: string; name: string; scope: string; defined_on: string; type_id?: string };
          };
          assert.equal(meta.view.scope, 'thought');
          assert.equal(meta.view.defined_on, thoughtId);
          assert.equal('type_id' in meta.view, false);

          const byId = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/views/${custom.id}/run`,
            headers: h,
            payload: {},
          });
          assert.equal(byId.statusCode, 200);
          assert.equal(
            (byId.json().meta as { view: { id: string } }).view.id,
            custom.id,
          );

          await new Promise((r) => setImmediate(r));
          const run = received.find((e) => e.type === 'thought-custom-view.run');
          assert.ok(run, 'thought-custom-view.run должен быть в событиях');
          assert.equal((run!.data as { view_id: string }).view_id, custom.id);
        } finally {
          unsubscribe();
        }
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('условие «Помечено на удаление» сохраняется в определении и фильтрует выдачу (9ddc488e)', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const typeId = await createType(ctx, 'trash-view-type');
        const ownerId = await createThought(ctx, 'владелец отбора', typeId);
        const liveId = await createThought(ctx, 'живая мысль', typeId);
        const trashedId = await createThought(ctx, 'мысль в корзине', typeId);
        updateThought(ctx.ndb, trashedId, { marked_for_deletion: true }, undefined, USER);

        // Определение ровно в той форме, которую печатает клиент: AST с явным
        // листом «Помечено на удаление = нет» (ошибка 9ddc488e).
        const notTrashed = JSON.stringify({
          version: FILTER_AST_VERSION,
          filter: { entity: { kind: 'trashed' }, operator: 'eq', value: false },
        });
        const created = await createCustomView(ctx, ownerId, {
          name: 'Только живые',
          definition: notTrashed,
        });
        assert.equal(created.statusCode, 201, created.body);

        // Хранение: определение возвращается байт в байт — валидация сервера
        // не срезает условие корзины.
        const stored = await ctx.app.inject({
          method: 'GET',
          url: customViewsUrl(ctx, ownerId, created.id!),
          headers: h,
        });
        assert.equal(stored.statusCode, 200, stored.body?.toString());
        assert.equal((stored.json().data as { definition: string }).definition, notTrashed);

        const run = async (viewId: string): Promise<string[]> => {
          const res = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thoughts/${ownerId}/views/${viewId}/run`,
            headers: h,
            payload: {},
          });
          assert.equal(res.statusCode, 200, res.body?.toString());
          return (res.json().data as Array<{ id: string }>).map((t) => t.id);
        };

        const liveOnly = await run(created.id!);
        assert.ok(liveOnly.includes(liveId), 'живая мысль в выдаче');
        assert.ok(!liveOnly.includes(trashedId), '«= нет» не возвращает помеченную на удаление');

        // Симметрично: явное «= да» возвращает ровно корзину — условие
        // реально участвует в исполнении, а не игнорируется движком.
        const trashedDefinition = JSON.stringify({
          version: FILTER_AST_VERSION,
          filter: { entity: { kind: 'trashed' }, operator: 'eq', value: true },
        });
        const onlyTrashed = await createCustomView(ctx, ownerId, {
          name: 'Только корзина',
          definition: trashedDefinition,
        });
        assert.equal(onlyTrashed.statusCode, 201, onlyTrashed.body);
        const trashOnly = await run(onlyTrashed.id!);
        assert.ok(trashOnly.includes(trashedId), '«= да» возвращает помеченную');
        assert.ok(!trashOnly.includes(liveId), '«= да» не возвращает живую');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('ИЛИ-корень определения: служебный лист «живые» обёртывает корень и сужает выдачу (a65d27d9)', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const typeId = await createType(ctx, 'or-view-type');
        const ownerId = await createThought(ctx, 'владелец ИЛИ-отбора', typeId);
        const alphaId = await createThought(ctx, 'альфа проба', typeId);
        const betaId = await createThought(ctx, 'бета проба', typeId);
        const otherId = await createThought(ctx, 'гамма проба', typeId);
        const trashedAlphaId = await createThought(ctx, 'альфа в корзине', typeId);
        updateThought(ctx.ndb, trashedAlphaId, { marked_for_deletion: true }, undefined, USER);

        // Определение ровно в той форме, которую печатает клиент после фикса:
        // ((альфа ИЛИ бета) И живые). До фикса клиент вливал служебный лист в
        // ИЛИ-корень — (альфа ИЛИ бета ИЛИ живые), и выдача расширялась до
        // ВСЕХ живых мыслей.
        const definition = JSON.stringify({
          version: FILTER_AST_VERSION,
          filter: {
            op: 'and',
            children: [
              {
                op: 'or',
                children: [
                  {
                    entity: { kind: 'keywords', scope: ['title', 'synonyms'] },
                    operator: 'matches',
                    value: 'альфа',
                  },
                  {
                    entity: { kind: 'keywords', scope: ['title', 'synonyms'] },
                    operator: 'matches',
                    value: 'бета',
                  },
                ],
              },
              { entity: { kind: 'trashed' }, operator: 'eq', value: false, service: true },
            ],
          },
        });
        const created = await createCustomView(ctx, ownerId, {
          name: 'ИЛИ-обёртка',
          definition,
        });
        assert.equal(created.statusCode, 201, created.body);
        const stored = await ctx.app.inject({
          method: 'GET',
          url: customViewsUrl(ctx, ownerId, created.id!),
          headers: h,
        });
        assert.equal(stored.statusCode, 200, stored.body?.toString());
        assert.equal(
          (stored.json().data as { definition: string }).definition,
          definition,
          'определение хранится байт в байт — обёртка и метка service не срезаются',
        );

        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ownerId}/views/${created.id!}/run`,
          headers: h,
          payload: {},
        });
        assert.equal(res.statusCode, 200, res.body?.toString());
        const ids = (res.json().data as Array<{ id: string }>).map((t) => t.id);
        assert.ok(ids.includes(alphaId), 'условие пользователя «альфа» в выдаче');
        assert.ok(ids.includes(betaId), 'условие пользователя «бета» в выдаче');
        assert.ok(
          !ids.includes(otherId),
          'живая мысль вне условий пользователя НЕ попала в выдачу (ИЛИ не расширен)',
        );
        assert.ok(!ids.includes(trashedAlphaId), 'служебное «живые» сужает выдачу');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('run типового отбора не изменился: scope type, defined_on/type_id — тип', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const typeId = await createType(ctx, 'task');
        const viewId = await createTypeView(ctx, typeId, { name: 'Типовой' });
        const thoughtId = await createThought(ctx, 'Мысль', typeId);
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/views/${viewId}/run`,
          headers: h,
          payload: {},
        });
        assert.equal(res.statusCode, 200, res.body?.toString());
        const meta = res.json().meta as {
          view: { scope: string; defined_on: string; type_id: string };
        };
        assert.equal(meta.view.scope, 'type');
        assert.equal(meta.view.defined_on, typeId);
        assert.equal(meta.view.type_id, typeId);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('события created/updated/deleted несут полную карточку', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const thoughtId = await createThought(ctx, 'Мысль');
        const pubsub = ctx.app.pubsub;
        const received: AnyRealtimeEvent[] = [];
        const unsubscribe = pubsub.subscribe(ctx.networkId, (e: AnyRealtimeEvent) =>
          received.push(e),
        );
        try {
          const created = await createCustomView(ctx, thoughtId, { name: 'Событие' });
          assert.equal(created.statusCode, 201);
          await ctx.app.inject({
            method: 'PATCH',
            url: customViewsUrl(ctx, thoughtId, created.id!),
            headers: { ...h, 'if-match': '1' },
            payload: { description: 'новое' },
          });
          await ctx.app.inject({
            method: 'DELETE',
            url: customViewsUrl(ctx, thoughtId, created.id!),
            headers: { ...h, 'if-match': '2' },
          });
          await new Promise((r) => setImmediate(r));

          const createdEvent = received.find((e) => e.type === 'thought-custom-view.created');
          assert.ok(createdEvent);
          const createdData = createdEvent!.data as {
            thought_id: string;
            view: { id: string; name: string; definition: string; scope: string };
          };
          assert.equal(createdData.thought_id, thoughtId);
          assert.equal(createdData.view.id, created.id);
          assert.equal(createdData.view.name, 'Событие');
          assert.equal(createdData.view.definition, EMPTY_DEFINITION);
          assert.equal(createdData.view.scope, 'thought');

          const updatedEvent = received.find((e) => e.type === 'thought-custom-view.updated');
          assert.ok(updatedEvent);
          const updatedData = updatedEvent!.data as {
            thought_id: string;
            view_id: string;
            version: number;
            view: { description: string; scope: string };
          };
          assert.equal(updatedData.view_id, created.id);
          assert.equal(updatedData.version, 2);
          assert.equal(updatedData.view.description, 'новое');

          const deletedEvent = received.find((e) => e.type === 'thought-custom-view.deleted');
          assert.ok(deletedEvent);
          const deletedData = deletedEvent!.data as {
            thought_id: string;
            view_id: string;
            view: {
              id: string;
              name: string;
              name_key: string;
              description: string | null;
              definition: string;
              position: number;
              is_default: boolean;
              version: number;
              created_at: string;
              updated_at: string;
              created_by: string;
              scope: string;
              defined_on: string;
              inherited: boolean;
            };
          };
          // Полная карточка удалённого отбора, как у created/updated (5d447380):
          // состояние на момент удаления — после PATCH (версия 2, новое описание).
          assert.equal(deletedData.thought_id, thoughtId);
          assert.equal(deletedData.view_id, created.id);
          assert.equal(deletedData.view.id, created.id);
          assert.equal(deletedData.view.name, 'Событие');
          assert.equal(deletedData.view.name_key, 'событие');
          assert.equal(deletedData.view.description, 'новое');
          assert.equal(deletedData.view.definition, EMPTY_DEFINITION);
          assert.equal(deletedData.view.position, 0);
          assert.equal(deletedData.view.is_default, false);
          assert.equal(deletedData.view.version, 2);
          assert.equal(deletedData.view.scope, 'thought');
          assert.equal(deletedData.view.defined_on, thoughtId);
          assert.equal(deletedData.view.inherited, false);
          assert.equal(typeof deletedData.view.created_at, 'string');
          assert.equal(typeof deletedData.view.updated_at, 'string');
          assert.equal(deletedData.view.created_by, ctx.adminId);
        } finally {
          unsubscribe();
        }
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('слои: отбор слоя не виден в основе до слияния, после merge виден всем', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const thoughtId = await createThought(ctx, 'Мысль');
        const layerId = await createLayerViaRest(ctx, 'Слой отборов');
        await selectLayer(ctx, layerId, 'views-layer-client');
        const layerHeaders = { ...h, 'client-id': 'views-layer-client' };
        const inLayer = await createCustomView(ctx, thoughtId, { name: 'Из слоя' }, layerHeaders);
        assert.equal(inLayer.statusCode, 201);

        // Клиент слоя видит свой отбор, клиент основы — нет.
        const layerList = await ctx.app.inject({
          method: 'GET',
          url: customViewsUrl(ctx, thoughtId),
          headers: layerHeaders,
        });
        assert.deepEqual(
          (layerList.json().data as Array<{ name: string }>).map((v) => v.name),
          ['Из слоя'],
        );
        const baseList = await ctx.app.inject({
          method: 'GET',
          url: customViewsUrl(ctx, thoughtId),
          headers: { ...h, 'client-id': 'base-client' },
        });
        assert.deepEqual(baseList.json().data, []);

        // Эффективный набор слоя видит и базовый/унаследованный, и свой.
        const layerEffective = await ctx.app.inject({
          method: 'GET',
          url: `${customViewsUrl(ctx, thoughtId)}?include_effective=true`,
          headers: layerHeaders,
        });
        assert.deepEqual(
          (layerEffective.json().meta as { effective: Array<{ name: string }> }).effective.map(
            (v) => v.name,
          ),
          ['Из слоя'],
        );

        const mergeRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/merge`,
          headers: h,
          payload: {},
        });
        assert.equal(mergeRes.statusCode, 200, mergeRes.body?.toString());
        const after = await ctx.app.inject({
          method: 'GET',
          url: customViewsUrl(ctx, thoughtId),
          headers: { ...h, 'client-id': 'base-client' },
        });
        assert.deepEqual(
          (after.json().data as Array<{ name: string }>).map((v) => v.name),
          ['Из слоя'],
        );
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);

