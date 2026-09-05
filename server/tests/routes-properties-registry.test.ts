/**
 * Integration tests for the property-registry REST routes (task 75404197):
 *   * `GET/POST/PATCH/DELETE /networks/{nid}/properties` + per-id GET
 *   * `GET /networks/{nid}/properties/{id}/usage`
 *   * the DUPLICATE-with-`details.property_id` semantics
 *   * the value-type migration counters (`converted` / `dropped`)
 *   * the 409 on DELETE when bindings / values still hold the property
 *   * the POST `property_id` form on type properties attaches an existing
 *     registry entry without creating a duplicate.
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

/** Create a thought under HOME and return its id. */
async function createChild(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: {
      title,
      create_link: { direction: 'parent', target_thought_id: ctx.homeId },
    },
  });
  assert.equal(res.statusCode, 201);
  return (res.json().data as { id: string }).id;
}

/** POST a fresh registry property, returning its id. */
async function createRegistryProperty(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/properties`,
    headers: authHeaders(ctx),
    payload,
  });
  assert.equal(res.statusCode, 201);
  const data = res.json().data as { id: string; name: string };
  return data;
}

describe(
  '/networks/{nid}/properties — registry routes',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('CRUD: create, list with counters, patch (no-op fields), get, delete', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);

        // Empty list at start.
        const emptyRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/properties`,
          headers: h,
        });
        assert.equal(emptyRes.statusCode, 200);
        assert.deepEqual(emptyRes.json().data, []);

        // Create one.
        const created = await createRegistryProperty(ctx, {
          name: 'вес',
          value_type: 'number',
          description: 'масса в граммах',
        });
        assert.ok(created.id);

        // List now contains exactly one entry with the expected counters.
        const listRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/properties`,
          headers: h,
        });
        assert.equal(listRes.statusCode, 200);
        const listed = listRes.json().data as Array<{
          id: string;
          name: string;
          types_count: number;
          values_count: number;
        }>;
        assert.equal(listed.length, 1);
        assert.equal(listed[0]!.id, created.id);
        assert.equal(listed[0]!.types_count, 0);
        assert.equal(listed[0]!.values_count, 0);

        // PATCH renames and adds description.
        const patchRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/properties/${created.id}`,
          headers: h,
          payload: { name: 'масса', description: 'масса в граммах (обновлено)' },
        });
        assert.equal(patchRes.statusCode, 200);
        const patched = patchRes.json().data as {
          name: string;
          description: string | null;
          converted: number;
          dropped: number;
        };
        assert.equal(patched.name, 'масса');
        assert.equal(patched.description, 'масса в граммах (обновлено)');
        assert.equal(patched.converted, 0);
        assert.equal(patched.dropped, 0);

        // Single GET.
        const oneRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/properties/${created.id}`,
          headers: h,
        });
        assert.equal(oneRes.statusCode, 200);
        const one = oneRes.json().data as {
          id: string;
          name: string;
          types_count: number;
          values_count: number;
        };
        assert.equal(one.name, 'масса');

        // Delete when unused → 204.
        const delRes = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/properties/${created.id}`,
          headers: h,
        });
        assert.equal(delRes.statusCode, 204);

        // Now GET → 404.
        const goneRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/properties/${created.id}`,
          headers: h,
        });
        assert.equal(goneRes.statusCode, 404);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('POST with a taken name → 409 DUPLICATE carrying details.property_id', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const first = await createRegistryProperty(ctx, { name: 'вес', value_type: 'number' });

        const dupRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/properties`,
          headers: h,
          payload: { name: 'ВЕС', value_type: 'text' },
        });
        assert.equal(dupRes.statusCode, 409);
        const body = dupRes.json() as {
          error: { code: string; details?: { property_id?: string } };
        };
        assert.equal(body.error.code, 'DUPLICATE');
        assert.equal(body.error.details?.property_id, first.id);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('PATCH value_type rewrites values and reports converted/dropped', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const thoughtType = (
          await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types`,
            headers: h,
            payload: { name: 'Объект' },
          })
        ).json().data as { id: string };
        const prop = await createRegistryProperty(ctx, { name: 'поле', value_type: 'text' });
        // Attach the property to the type.
        const attach = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${thoughtType.id}/properties`,
          headers: h,
          payload: { property_id: prop.id, required: false },
        });
        assert.equal(attach.statusCode, 201);

        // Two typed thoughts with one value each. Type is assigned FIRST so
        // the value lands inside the type's chain (otherwise the PUT writes
        // an outside-type value and the migration classifier sees it
        // through a different lens).
        const t1 = await createChild(ctx, 'A');
        await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${t1}`,
          headers: h,
          payload: { type_id: thoughtType.id },
        });
        await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${t1}/properties/${prop.name}`,
          headers: h,
          payload: { value: '42' }, // text "42" → number 42 (convertible)
        });
        const t2 = await createChild(ctx, 'B');
        await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${t2}`,
          headers: h,
          payload: { type_id: thoughtType.id },
        });
        await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${t2}/properties/${prop.name}`,
          headers: h,
          payload: { value: 'не-число' }, // unconvertible
        });

        // Change value_type to number: one converted, one dropped.
        const patchRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/properties/${prop.id}`,
          headers: h,
          payload: { value_type: 'number' },
        });
        assert.equal(patchRes.statusCode, 200);
        const patched = patchRes.json().data as {
          value_type: string;
          converted: number;
          dropped: number;
        };
        assert.equal(patched.value_type, 'number');
        assert.equal(patched.converted, 1);
        assert.equal(patched.dropped, 1);

        // The convertible value now reads as a number; the dropped one is gone.
        const readRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${t1}/properties`,
          headers: h,
        });
        const values = readRes.json().data as Array<{
          property_id: string;
          value: unknown;
          outside_type: boolean;
        }>;
        const ours = values.find((v) => v.property_id === prop.id);
        assert.ok(ours);
        assert.equal(ours!.value, 42);
        // The dropped one leaves no row at all.
        const readRes2 = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${t2}/properties`,
          headers: h,
        });
        const values2 = readRes2.json().data as Array<{ property_id: string }>;
        assert.equal(values2.find((v) => v.property_id === prop.id), undefined);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('DELETE refuses with 409 + types_count + values_count when the property is in use', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const thoughtType = (
          await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types`,
            headers: h,
            payload: { name: 'Задача' },
          })
        ).json().data as { id: string };

        const prop = await createRegistryProperty(ctx, { name: 'срок', value_type: 'date' });
        const attach = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${thoughtType.id}/properties`,
          headers: h,
          payload: { property_id: prop.id, required: false },
        });
        assert.equal(attach.statusCode, 201);
        const bindingId = (attach.json().data as { id: string }).id;

        const delRes = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/properties/${prop.id}`,
          headers: h,
        });
        assert.equal(delRes.statusCode, 409);
        const body = delRes.json() as {
          error: { code: string; details?: { types_count?: number; values_count?: number } };
        };
        assert.equal(body.error.code, 'DUPLICATE');
        assert.equal(body.error.details?.types_count, 1);
        assert.equal(body.error.details?.values_count, 0);

        // Detach the binding, then DELETE succeeds.
        const detach = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${thoughtType.id}/properties/${bindingId}`,
          headers: h,
        });
        assert.equal(detach.statusCode, 204);

        const delRes2 = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/properties/${prop.id}`,
          headers: h,
        });
        assert.equal(delRes2.statusCode, 204);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('usage endpoint reports bindings and per-type value counters', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const typeA = (
          await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types`,
            headers: h,
            payload: { name: 'A' },
          })
        ).json().data as { id: string };
        const typeB = (
          await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types`,
            headers: h,
            payload: { name: 'B' },
          })
        ).json().data as { id: string };
        const prop = await createRegistryProperty(ctx, { name: 'тег', value_type: 'text' });
        await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeA.id}/properties`,
          headers: h,
          payload: { property_id: prop.id, required: true },
        });
        await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeB.id}/properties`,
          headers: h,
          payload: { property_id: prop.id, required: false },
        });

        // Two thoughts of type A with values, one typed thought that loses
        // its type (so its stored value becomes outside-type). Type is
        // assigned BEFORE the value so the value is born inside the type's
        // binding set.
        const ta1 = await createChild(ctx, 'A1');
        await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ta1}`,
          headers: h,
          payload: { type_id: typeA.id },
        });
        await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ta1}/properties/${prop.name}`,
          headers: h,
          payload: { value: 'x' },
        });
        const ta2 = await createChild(ctx, 'A2');
        await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ta2}`,
          headers: h,
          payload: { type_id: typeA.id },
        });
        await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ta2}/properties/${prop.name}`,
          headers: h,
          payload: { value: 'y' },
        });
        // `tb1` starts as type A, gets a value, then detaches its type — the
        // stored value becomes outside-type (a fresh PUT against an
        // untyped owner would be refused with 422).
        const tb1 = await createChild(ctx, 'B1');
        const patchTypeRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${tb1}`,
          headers: h,
          payload: { type_id: typeA.id },
        });
        assert.equal(patchTypeRes.statusCode, 200);
        const putValRes = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${tb1}/properties/${prop.name}`,
          headers: h,
          payload: { value: 'z' },
        });
        assert.equal(putValRes.statusCode, 200);
        const detachTypeRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${tb1}`,
          headers: h,
          payload: { type_id: null },
        });
        assert.equal(detachTypeRes.statusCode, 200);

        const usageRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/properties/${prop.id}/usage`,
          headers: h,
        });
        assert.equal(usageRes.statusCode, 200);
        const usage = usageRes.json().data as {
          property_id: string;
          name: string;
          bindings: Array<{
            owner_type: string;
            owner_id: string;
            owner_name: string;
            required: boolean;
            values_in_type_count: number;
          }>;
          values_in_type_count: number;
          values_outside_type_count: number;
        };
        assert.equal(usage.property_id, prop.id);
        assert.equal(usage.name, 'тег');
        const bindingsByType = new Map(
          usage.bindings.map((b) => [b.owner_id, b] as const),
        );
        assert.equal(bindingsByType.get(typeA.id)?.values_in_type_count, 2);
        assert.equal(bindingsByType.get(typeB.id)?.values_in_type_count, 0);
        assert.equal(bindingsByType.get(typeA.id)?.required, true);
        assert.equal(usage.values_in_type_count, 2);
        assert.equal(usage.values_outside_type_count, 1);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('POST …/types/{id}/properties accepts {property_id} to attach an existing registry entry', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const type = (
          await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types`,
            headers: h,
            payload: { name: 'Люди' },
          })
        ).json().data as { id: string };
        const prop = await createRegistryProperty(ctx, { name: 'email', value_type: 'text' });

        // { property_id } attaches the existing entry.
        const attachRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${type.id}/properties`,
          headers: h,
          payload: { property_id: prop.id, required: true, position: 0 },
        });
        assert.equal(attachRes.statusCode, 201);
        const attached = attachRes.json().data as {
          property_id: string;
          key: string;
          required: boolean;
        };
        assert.equal(attached.property_id, prop.id);
        assert.equal(attached.key, 'email');
        assert.equal(attached.required, true);

        // GET effective list now contains the binding with property_id.
        const listRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${type.id}/properties`,
          headers: h,
        });
        const listed = listRes.json().data as Array<{
          property_id: string;
          key: string;
        }>;
        assert.equal(listed.length, 1);
        assert.equal(listed[0]!.property_id, prop.id);
        assert.equal(listed[0]!.key, 'email');

        // POST { property_id } together with key/value_type/config/description
        // is rejected with 422 (the registry is the source of truth).
        const badRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${type.id}/properties`,
          headers: h,
          payload: { property_id: prop.id, key: 'другое', value_type: 'text' },
        });
        assert.equal(badRes.statusCode, 422);

        // POST { key, value_type } again with the SAME name attaches the
        // existing registry entry instead of creating a new one.
        const secondRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${type.id}/properties`,
          headers: h,
          payload: { key: 'email', value_type: 'text' },
        });
        // Same property can't be attached twice to the same type → DUPLICATE
        // with details.property_id pointing at the existing registry entry.
        assert.equal(secondRes.statusCode, 409);
        const dup = secondRes.json() as {
          error: { code: string; details?: { property_id?: string } };
        };
        assert.equal(dup.error.code, 'DUPLICATE');
        assert.equal(dup.error.details?.property_id, prop.id);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('POST { key, value_type } with a name already taken returns 409 + property_id of the holder', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const type = (
          await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types`,
            headers: h,
            payload: { name: 'Люди' },
          })
        ).json().data as { id: string };

        const first = await createRegistryProperty(ctx, { name: 'зп', value_type: 'number' });

        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${type.id}/properties`,
          headers: h,
          payload: { key: 'зп', value_type: 'text' },
        });
        assert.equal(res.statusCode, 409);
        const body = res.json() as {
          error: { code: string; details?: { property_id?: string } };
        };
        assert.equal(body.error.code, 'DUPLICATE');
        assert.equal(body.error.details?.property_id, first.id);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('PATCH on a binding rejects nature fields (value_type, config, description) with 422', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const type = (
          await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types`,
            headers: h,
            payload: { name: 'Проект' },
          })
        ).json().data as { id: string };
        const prop = await createRegistryProperty(ctx, { name: 'код', value_type: 'text' });
        const attach = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${type.id}/properties`,
          headers: h,
          payload: { property_id: prop.id, required: false },
        });
        const bindingId = (attach.json().data as { id: string }).id;

        for (const payload of [
          { value_type: 'number' },
          { config: { multiple: true } },
          { description: 'описание' },
          { key: 'переименование' },
        ]) {
          const badRes = await ctx.app.inject({
            method: 'PATCH',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${type.id}/properties/${bindingId}`,
            headers: h,
            payload,
          });
          assert.equal(badRes.statusCode, 422, JSON.stringify(payload));
        }

        // The valid PATCH (required + position) still works.
        const okRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${type.id}/properties/${bindingId}`,
          headers: h,
          payload: { required: true, position: 3 },
        });
        assert.equal(okRes.statusCode, 200);
        const patched = okRes.json().data as { required: boolean; position: number };
        assert.equal(patched.required, true);
        assert.equal(patched.position, 3);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('DELETE …/types/{id}/properties keeps values as outside-type (read-only history)', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const type = (
          await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types`,
            headers: h,
            payload: { name: 'Задача' },
          })
        ).json().data as { id: string };
        const prop = await createRegistryProperty(ctx, { name: 'метка', value_type: 'text' });
        await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${type.id}/properties`,
          headers: h,
          payload: { property_id: prop.id, required: false },
        });

        // A typed thought with a value.
        const thought = await createChild(ctx, 'T1');
        await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thought}`,
          headers: h,
          payload: { type_id: type.id },
        });
        await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thought}/properties/${prop.name}`,
          headers: h,
          payload: { value: 'важно' },
        });

        // Detach the binding.
        const bindingId = (
          await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${type.id}/properties`,
            headers: h,
          })
        ).json().data[0].id as string;
        const detach = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${type.id}/properties/${bindingId}`,
          headers: h,
        });
        assert.equal(detach.statusCode, 204);

        // The value still exists, flagged outside_type.
        const listRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thought}/properties`,
          headers: h,
        });
        const values = listRes.json().data as Array<{
          property_id: string;
          property_name: string;
          value: unknown;
          value_type: string;
          outside_type: boolean;
        }>;
        const ours = values.find((v) => v.property_id === prop.id);
        assert.ok(ours, 'value must survive the detach');
        assert.equal(ours!.outside_type, true);
        assert.equal(ours!.property_name, 'метка');
        assert.equal(ours!.value_type, 'text');
        assert.equal(ours!.value, 'важно');

        // Re-attaching the same property (without renaming) to a DIFFERENT
        // type must not throw — `createTypeProperty` handles descendant
        // dedup and the registry entry is still there.

        // DELETE on the outside-type value works (the only action available).
        const delRes = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thought}/properties/${prop.name}`,
          headers: h,
        });
        assert.equal(delRes.statusCode, 204);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
