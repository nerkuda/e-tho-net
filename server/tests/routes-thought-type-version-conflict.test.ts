/**
 * Регрессия ошибки 5bcfa04b — «Конфликт версий типа после создания свойства
 * с привязкой из редактора типа» (expected: 1, current: 3).
 *
 * Сценарий: редактор типа мысли создаёт тип (v1) → пользователь открывает
 * «Добавить свойство…» → «Создать свойство» (скалярное) с указанием
 * редактируемого типа в «Типах источников» → сохранение свойства идёт
 * через `applyTypeRows` в property-manager: сначала POST /properties
 * (создаёт реестровую запись), затем POST /thought-types/{id}/properties
 * (attach к типу). POST /properties для скаляра НЕ принимает
 * `allowed_source_type_ids` напрямую — этот список выводится сервером из
 * привязок (задача 298fe6f3, 09f692ff). Каждый attach вызывает
 * `createTypeProperty` → `touchType` → +1 к версии типа. К моменту возврата
 * в редактор черновик хранит `current.version = 1`, а на сервере уже 2.
 * Следующий PATCH /thought-types/{id} с `If-Match: 1` → 409 VERSION_CONFLICT.
 *
 * В пользовательском сценарии подъёмов два:
 *   1) POST /properties создаёт реестровую запись, но НЕ привязывает к типу —
 *      версия типа НЕ меняется;
 *   2) POST /thought-types/{id}/properties (attach) — `createTypeProperty` →
 *      `touchType` → версия типа с 1 на 2.
 * Если пользователь сделает ещё что-то через редактор (поменяет описание,
 * имя, …), а черновик хранит версию 1, PATCH провалится. Фикс —
 * `readFreshTypeVersion` (5bcfa04b): GET перед PATCH; снимок остаётся
 * запасным источником, конфликт остаётся только для реальной конкурентной
 * правки полей извне между чтением и записью.
 *
 * Серверный контракт здесь тот же, что в 33fdffb (link_type parent,
 * ошибка e7c077e4). Клиентский сценарий покрыт в
 * `client/tests/type-manager-fresh-version.test.ts` (модуль-уровень
 * хелперы `readFreshTypeVersion` / `readFreshTypeSnapshot`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
} from './rest-helpers.js';

interface ThoughtTypeCard {
  id: string;
  version: number;
}

interface PropertyCard {
  id: string;
  name: string;
}

async function createThoughtType(
  ctx: { app: { inject: (req: unknown) => Promise<{ statusCode: number; body?: string; json: () => unknown }> }; networkId: string },
  h: Record<string, string>,
  name: string,
): Promise<ThoughtTypeCard> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types`,
    headers: h,
    payload: { name },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json() as { data: ThoughtTypeCard }).data;
}

async function getThoughtType(
  ctx: { app: { inject: (req: unknown) => Promise<{ statusCode: number; body?: string; json: () => unknown }> }; networkId: string },
  h: Record<string, string>,
  id: string,
): Promise<ThoughtTypeCard> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/thought-types/${id}`,
    headers: h,
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
  return (res.json() as { data: ThoughtTypeCard }).data;
}

async function patchThoughtType(
  ctx: { app: { inject: (req: unknown) => Promise<{ statusCode: number; body?: string; json: () => unknown }> }; networkId: string },
  h: Record<string, string>,
  id: string,
  expectedVersion: number,
  patch: Record<string, unknown>,
): Promise<{ status: number; card: ThoughtTypeCard | null }> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/networks/${ctx.networkId}/thought-types/${id}`,
    headers: { ...h, 'if-match': String(expectedVersion) },
    payload: patch,
  });
  if (res.statusCode === 200) {
    return { status: res.statusCode, card: (res.json() as { data: ThoughtTypeCard }).data };
  }
  return { status: res.statusCode, card: null };
}

async function createScalarProperty(
  ctx: { app: { inject: (req: unknown) => Promise<{ statusCode: number; body?: string; json: () => unknown }> }; networkId: string },
  h: Record<string, string>,
  name: string,
): Promise<PropertyCard> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/properties`,
    headers: h,
    payload: { name, value_type: 'text' },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json() as { data: PropertyCard }).data;
}

async function attachPropertyToType(
  ctx: { app: { inject: (req: unknown) => Promise<{ statusCode: number; body?: string; json: () => unknown }> }; networkId: string },
  h: Record<string, string>,
  typeId: string,
  propertyId: string,
): Promise<number> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/properties`,
    headers: h,
    payload: { property_id: propertyId, required: false },
  });
  return res.statusCode;
}

describe(
  'PATCH /thought-types — версия поднимается на attach (5bcfa04b)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('полный сценарий: create → create property + attach → PATCH устаревший — 409, свежий — 200', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);

        // 1. Создаём тип мысли — сервер отдаёт version = 1.
        const created = await createThoughtType(ctx, h, 'мой тип');
        assert.equal(created.version, 1, 'свежесозданный тип — version 1');

        // 2. Вложенное создание скалярного свойства (как делает property-manager
        //    «Создать свойство»): POST /properties создаёт реестровую запись
        //    БЕЗ касания типа — версия типа остаётся 1.
        const propA = await createScalarProperty(ctx, h, 'приоритет');
        assert.ok(propA.id);
        const afterRegistry = await getThoughtType(ctx, h, created.id);
        assert.equal(afterRegistry.version, 1, 'POST /properties не меняет версию типа');

        // 3. attach свойства к типу (как делает applyTypeRows в property-manager:
        //    `createTypeProperty` → `touchType`). Версия типа поднимается с 1
        //    на 2.
        const attachStatus = await attachPropertyToType(ctx, h, created.id, propA.id);
        assert.equal(attachStatus, 201, attachStatus.toString());
        const afterAttach = await getThoughtType(ctx, h, created.id);
        assert.equal(afterAttach.version, 2, 'attach поднял версию типа до 2');

        // 4. PATCH со устаревшей версией 1 (как делал клиентский apply() до
        //    фикса) — 409 VERSION_CONFLICT, как у пользователя.
        const stale = await patchThoughtType(ctx, h, created.id, 1, {
          description: 'новое описание',
        });
        assert.equal(stale.status, 409, 'устаревшая версия даёт 409');

        // 5. PATCH со свежей версией (логика фикса: readFreshTypeVersion) — 200.
        const ok = await patchThoughtType(ctx, h, created.id, afterAttach.version, {
          description: 'новое описание',
        });
        assert.equal(ok.status, 200, 'свежая версия проходит');
        assert.ok(ok.card !== null);
        assert.equal(ok.card.version, afterAttach.version + 1, 'PATCH поднял версию ещё на +1');

        // 6. Реальная конкурентная правка между чтением и записью — по-прежнему
        //    409: фикс не должен превращать любой конфликт в молчаливый
        //    «обход».
        const before = await getThoughtType(ctx, h, created.id);
        // Имитируем конкурента: ещё один PATCH с той же версией проходит,
        // а повторный с уже устаревшей — 409.
        const competitor = await patchThoughtType(ctx, h, created.id, before.version, {
          icon: '🎯',
        });
        assert.equal(competitor.status, 200, 'первый из конкурентов проходит');
        const dup = await patchThoughtType(ctx, h, created.id, before.version, {
          icon: '⭐',
        });
        assert.equal(dup.status, 409, 'второй конкурент по-прежнему конфликтует');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('один attach — версия типа поднимается на +1 (5bcfa04b, шаг 3)', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const created = await createThoughtType(ctx, h, 'attach-only');
        assert.equal(created.version, 1);

        const prop = await createScalarProperty(ctx, h, 'tag');
        const status = await attachPropertyToType(ctx, h, created.id, prop.id);
        assert.equal(status, 201);
        const bumped = await getThoughtType(ctx, h, created.id);
        assert.equal(bumped.version, 2, 'один attach поднял версию на +1');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
