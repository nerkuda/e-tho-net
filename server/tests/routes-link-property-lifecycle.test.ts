/**
 * Integration tests for the unified link-property ↔ link-type lifecycle
 * (задача d7177d1d, требование 09f692ff). Один POST свойства-связи
 * создаёт и свойство, и тип связи; один DELETE удаляет оба; ответ
 * несёт `links_becoming_structural` — число рёбер, ставших структурными
 * после удаления типа связи.
 *
 * Также покрывает контракты:
 *   * GET /properties для свойства-связи возвращает `types_source_count` /
 *     `types_target_count`;
 *   * POST /link-types → 422, DELETE /link-types → 422
 *     (служебный CRUD, пользовательский идёт через свойство);
 *   * PATCH /thought-types/{id}/properties/{pid} принимает `side` и
 *     `allowed_target_type_ids` / `allowed_source_type_ids`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

describe(
  '/properties link-property lifecycle (0.8.1, d7177d1d, 09f692ff)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('полный цикл: POST создаёт свойство + link_type, DELETE удаляет оба и возвращает links_becoming_structural', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;

        // Один POST = и свойство, и тип связи (требование 09f692ff).
        const createRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/properties`,
          headers: h,
          payload: {
            name: 'работает в',
            value_type: 'link',
            name_forward: 'работает в',
            name_reverse: 'сотрудники',
            link_color: '#abcdef',
          },
        });
        assert.equal(createRes.statusCode, 201, createRes.body?.toString());
        const created = createRes.json().data as {
          id: string;
          name: string;
          value_type: string;
          config: { link_type_id: string; direction?: string } | null;
        };
        assert.equal(created.name, 'работает в');
        assert.equal(created.value_type, 'link');
        assert.ok(created.config?.link_type_id, 'config.link_type_id заполнен');
        const linkTypeId = created.config.link_type_id;

        // Подтверждаем, что link_type существует через GET /link-types.
        const ltList = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/link-types`,
          headers: h,
        });
        assert.equal(ltList.statusCode, 200);
        const linkTypes = ltList.json().data as Array<{
          id: string;
          name_forward: string;
          name_reverse: string;
        }>;
        const lt = linkTypes.find((t) => t.id === linkTypeId);
        assert.ok(lt, 'link_type присутствует в каталоге');
        assert.equal(lt.name_forward, 'работает в');
        assert.equal(lt.name_reverse, 'сотрудники');

        // Подключаем свойство к типу мысли и создаём живое ребро.
        const personRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
          payload: { name: 'Персона' },
        });
        assert.equal(personRes.statusCode, 201, personRes.body?.toString());
        const person = (personRes.json().data as { id: string }).id;

        const companyRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
          payload: { name: 'Фирма' },
        });
        assert.equal(companyRes.statusCode, 201);
        const company = (companyRes.json().data as { id: string }).id;

        // Подключаем свойство к обоим типам (через property_id) — запоминаем
        // id привязок для отвязки перед DELETE.
        const attachP = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types/${person}/properties`,
          headers: h,
          payload: { property_id: created.id, required: false },
        });
        assert.equal(attachP.statusCode, 201, attachP.body?.toString());
        const personBindingId = (attachP.json().data as { id: string }).id;

        const attachC = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types/${company}/properties`,
          headers: h,
          payload: { property_id: created.id, required: false },
        });
        assert.equal(attachC.statusCode, 201, attachC.body?.toString());
        const companyBindingId = (attachC.json().data as { id: string }).id;

        // Создаём мысли и связь — она обнулит type_id после удаления свойства.
        const pRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts`,
          headers: h,
          payload: { title: 'Иванов', type_id: person },
        });
        assert.equal(pRes.statusCode, 201);
        const p = (pRes.json().data as { id: string }).id;

        const cRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts`,
          headers: h,
          payload: { title: '1С', type_id: company },
        });
        assert.equal(cRes.statusCode, 201);
        const c = (cRes.json().data as { id: string }).id;

        const linkRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts/batch`,
          headers: h,
          payload: {
            ids: [p],
            op: 'link_parents',
            args: { parent_ids: [c], link_type_id: linkTypeId },
          },
        });
        assert.equal(linkRes.statusCode, 200, linkRes.body?.toString());
        // Подтверждаем, что ребро создано: счётчик /link-types/counts равен 1.
        const ltCounts = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/link-types/counts`,
          headers: h,
        });
        assert.equal(ltCounts.statusCode, 200);
        const ltCount = (ltCounts.json().data as Record<string, number>)[linkTypeId];
        assert.equal(ltCount, 1, 'одно ребро с этим типом связи');
        void p; void c;

        // GET /properties: для свойства-связи — счётчики сторон.
        const getRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/properties/${created.id}`,
          headers: h,
        });
        assert.equal(getRes.statusCode, 200);
        const detail = getRes.json().data as {
          types_count: number;
          types_source_count?: number;
          types_target_count?: number;
          values_count: number;
        };
        assert.equal(detail.types_count, 2, 'оба типа подключили свойство');
        assert.equal(detail.types_source_count, 2, 'оба со стороны source');
        assert.equal(detail.types_target_count, 0, 'никто со стороны target');

        // Отвязываем свойство от обоих типов, чтобы DELETE прошёл. Маршрут
        // DELETE …/properties/:propertyId адресует привязку (binding id), не
        // реестровое свойство.
        for (const [typeId, bindingId] of [
          [person, personBindingId],
          [company, companyBindingId],
        ] as const) {
          const detach = await ctx.app.inject({
            method: 'DELETE',
            url: `/api/v1/networks/${nid}/thought-types/${typeId}/properties/${bindingId}`,
            headers: h,
          });
          assert.equal(detach.statusCode, 204, detach.body?.toString());
        }

        // DELETE свойства-связи: возвращает 200 + links_becoming_structural = 1.
        const delRes = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${nid}/properties/${created.id}`,
          headers: h,
        });
        assert.equal(delRes.statusCode, 200, delRes.body?.toString());
        const delBody = delRes.json().data as {
          id: string;
          links_becoming_structural: number | null;
        };
        assert.equal(delBody.id, created.id);
        assert.equal(delBody.links_becoming_structural, 1, 'ребро стало структурным');

        // Подтверждаем, что link_type тоже удалён.
        const ltListAfter = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/link-types`,
          headers: h,
        });
        const ltAfter = (ltListAfter.json().data as Array<{ id: string }>).find(
          (t) => t.id === linkTypeId,
        );
        assert.equal(ltAfter, undefined, 'link_type удалён вместе со свойством');

        // Счётчик /link-types/counts после удаления — 0 (ребро потеряло type_id).
        const ltCountsAfter = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/link-types/counts`,
          headers: h,
        });
        assert.equal(ltCountsAfter.statusCode, 200);
        const ltCountAfter = (ltCountsAfter.json().data as Record<string, number>)[
          linkTypeId
        ] ?? 0;
        assert.equal(ltCountAfter, 0, 'ребро обнулило type_id');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('POST /link-types → 422, DELETE /link-types → 422 (служебный CRUD)', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;

        const postRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/link-types`,
          headers: h,
          payload: { name_forward: 'foo', name_reverse: 'bar' },
        });
        assert.equal(postRes.statusCode, 422);
        const postErr = postRes.json() as { error: { code: string; details: { hint: string } } };
        assert.equal(postErr.error.code, 'VALIDATION_ERROR');
        assert.match(postErr.error.details.hint, /\/properties/);

        // Создаём link-type через свойство — нужен id для DELETE-проверки.
        const createRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/properties`,
          headers: h,
          payload: {
            name: 'служебный',
            value_type: 'link',
            name_forward: 'служебный',
            name_reverse: 'обратный',
          },
        });
        assert.equal(createRes.statusCode, 201);
        const ltId = (
          createRes.json().data as { config: { link_type_id: string } | null }
        ).config!.link_type_id;

        const delRes = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${nid}/link-types/${ltId}`,
          headers: h,
        });
        assert.equal(delRes.statusCode, 422);
        const delErr = delRes.json() as { error: { code: string; details: { hint: string } } };
        assert.equal(delErr.error.code, 'VALIDATION_ERROR');
        assert.match(delErr.error.details.hint, /\/properties/);

        // PATCH /link-types отвергает правку имён — 422.
        const patchRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/link-types/${ltId}`,
          headers: h,
          payload: { name_forward: 'новое' },
        });
        assert.equal(patchRes.statusCode, 422, patchRes.body?.toString());

        // Но оформление (color) — пропускает.
        const colorRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/link-types/${ltId}`,
          headers: h,
          payload: { color: '#ff0000' },
        });
        assert.equal(colorRes.statusCode, 200, colorRes.body?.toString());
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('PATCH /thought-types/{id}/properties/{pid} принимает side, allowed_target_type_ids и allowed_source_type_ids', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;

        const srcRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
          payload: { name: 'Источник' },
        });
        assert.equal(srcRes.statusCode, 201);
        const src = (srcRes.json().data as { id: string }).id;

        const tgtRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
          payload: { name: 'Назначение' },
        });
        assert.equal(tgtRes.statusCode, 201);
        const tgt = (tgtRes.json().data as { id: string }).id;

        // Создаём свойство-связь с указанием стороны source.
        const propRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/properties`,
          headers: h,
          payload: {
            name: 'связь',
            value_type: 'link',
            name_forward: 'связь',
            name_reverse: 'обратная',
          },
        });
        assert.equal(propRes.statusCode, 201);
        const prop = propRes.json().data as { id: string };

        const attachRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types/${src}/properties`,
          headers: h,
          payload: { property_id: prop.id, required: false },
        });
        assert.equal(attachRes.statusCode, 201);
        const bindingId = (attachRes.json().data as { id: string }).id;

        // PATCH side='source' + allowed_target_type_ids — должно сработать.
        const patchSide = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${src}/properties/${bindingId}`,
          headers: h,
          payload: { side: 'source', allowed_target_type_ids: [tgt] },
        });
        assert.equal(patchSide.statusCode, 200, patchSide.body?.toString());
        const sideBody = patchSide.json().data as {
          side: string | null;
          config: { allowed_target_type_ids?: string[] } | null;
        };
        assert.equal(sideBody.side, 'source');
        assert.deepEqual(sideBody.config?.allowed_target_type_ids, [tgt]);

        // Невалидный side → 422.
        const badSide = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${src}/properties/${bindingId}`,
          headers: h,
          payload: { side: 'sideways' },
        });
        assert.equal(badSide.statusCode, 422, badSide.body?.toString());

        // value_type / config / name в PATCH → 422 (только роль в типе).
        const natureRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${src}/properties/${bindingId}`,
          headers: h,
          payload: { value_type: 'text' },
        });
        assert.equal(natureRes.statusCode, 422, natureRes.body?.toString());
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('PATCH value_type скаляр ↔ связь возвращает 422 VALIDATION_ERROR (требование 5a82c709)', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;

        const createRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/properties`,
          headers: h,
          payload: { name: 'поле', value_type: 'text' },
        });
        assert.equal(createRes.statusCode, 201);
        const propId = (createRes.json().data as { id: string }).id;

        const patchRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/properties/${propId}`,
          headers: h,
          payload: { value_type: 'link' },
        });
        assert.equal(patchRes.statusCode, 422, patchRes.body?.toString());
        const body = patchRes.json() as {
          error: { code: string; details: { reason?: string } };
        };
        assert.equal(body.error.code, 'VALIDATION_ERROR');
        assert.match(body.error.details.reason ?? '', /связ|конверта/i);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
