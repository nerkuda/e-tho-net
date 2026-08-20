/**
 * End-to-end REST scenario for the type hierarchy (L21): walks the whole
 * journey against a real Fastify app (throwaway data dir + network):
 *
 *   root seeding → typed hierarchy with parent_id → depth cap → root
 *   assignment ban (thoughts/links) → reparent guards (in-use, cycle) →
 *   delete guards (children, root) → effective property list → default
 *   override → untyped-owner resolution → subtree filter expansion (search).
 *
 * Skipped entirely when the `better-sqlite3` native binding is unavailable.
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
  'type hierarchy REST scenario (L21)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('creates a typed hierarchy, enforces the guards and resolves inherited properties', async () => {
      const ctx: RestTestContext = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;

        // --- catalogue: the migration seeds the root type -------------------
        const listRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
        });
        assert.equal(listRes.statusCode, 200);
        const seeded = listRes.json().data as Array<{ id: string; is_root: boolean; name: string }>;
        const root = seeded.find((t) => t.is_root)!;
        assert.equal(root.name, 'основной тип');

        const linkRootRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/link-types`,
          headers: h,
        });
        const linkRoot = (linkRootRes.json().data as Array<{ id: string; is_root: boolean }>).find(
          (t) => t.is_root,
        )!;
        assert.ok(linkRoot);

        // --- hierarchy: Персона → Коллега; properties on root and Персона --
        const personRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
          payload: { name: 'Персона', font_bold: true },
        });
        assert.equal(personRes.statusCode, 201);
        const person = personRes.json().data as { id: string; version: number; parent_id: string };
        assert.equal(person.parent_id, root.id);

        const colleagueRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
          payload: { name: 'Коллега', parent_id: person.id },
        });
        assert.equal(colleagueRes.statusCode, 201);
        const colleague = colleagueRes.json().data as { id: string; version: number };

        // The root is never assignable to a thought.
        const thoughtRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts`,
          headers: h,
          payload: { title: 'X', type_id: root.id },
        });
        assert.equal(thoughtRes.statusCode, 422);

        // Depth cap: root → Персона → Коллега → L4 fits; L5 is rejected.
        const l4Res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
          payload: { name: 'L4', parent_id: colleague.id },
        });
        assert.equal(l4Res.statusCode, 201);
        const l4 = l4Res.json().data as { id: string };
        const l5Res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
          payload: { name: 'L5', parent_id: l4.id },
        });
        assert.equal(l5Res.statusCode, 422);

        // Cycle: reparenting Персона under Коллега must be rejected.
        const cycleRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${person.id}`,
          headers: { ...h, 'If-Match': String(person.version) },
          payload: { parent_id: colleague.id },
        });
        assert.equal(cycleRes.statusCode, 422);

        // Reparenting a type in use is rejected.
        const thoughtOkRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts`,
          headers: h,
          payload: { title: 'Иванов', type_id: colleague.id },
        });
        assert.equal(thoughtOkRes.statusCode, 201);
        const inUseRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${colleague.id}`,
          headers: { ...h, 'If-Match': String(colleague.version) },
          payload: { parent_id: null },
        });
        assert.equal(inUseRes.statusCode, 422);

        // Deleting a type with children (Персона) or the root is rejected.
        const delParentRes = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${nid}/thought-types/${person.id}?force=1`,
          headers: { ...h, 'If-Match': String(person.version) },
        });
        assert.equal(delParentRes.statusCode, 422);
        const delRootRes = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${nid}/thought-types/${root.id}?force=1`,
          headers: h,
        });
        assert.equal(delRootRes.statusCode, 422);

        // --- properties: root-level + Персона-level + effective list --------
        const rootPropRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types/${root.id}/properties`,
          headers: h,
          payload: { key: 'заметка', value_type: 'text', config: { default_value: 'из корня' } },
        });
        assert.equal(rootPropRes.statusCode, 201);
        const personPropRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types/${person.id}/properties`,
          headers: h,
          payload: { key: 'пол', value_type: 'text', config: { default_value: 'мужской' } },
        });
        assert.equal(personPropRes.statusCode, 201);
        const personProp = personPropRes.json().data as { id: string };

        const effRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/thought-types/${colleague.id}/properties`,
          headers: h,
        });
        assert.equal(effRes.statusCode, 200);
        const effective = effRes.json().data as Array<{
          key: string;
          inherited: boolean;
          default_value: unknown;
          overridden_here: boolean;
        }>;
        assert.deepEqual(effective.map((d) => d.key).sort(), ['заметка', 'пол']);
        assert.ok(effective.every((d) => d.inherited));

        // Duplicate keys along the chain are rejected (DUPLICATE 409).
        const dupRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types/${colleague.id}/properties`,
          headers: h,
          payload: { key: 'пол', value_type: 'text' },
        });
        assert.equal(dupRes.statusCode, 409);

        // Override the inherited default on Коллега, then reset it.
        const overrideRes = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${nid}/thought-types/${colleague.id}/properties/${personProp.id}/default`,
          headers: h,
          payload: { value: 'женский' },
        });
        assert.equal(overrideRes.statusCode, 200);
        const afterOverride = (
          (
            await ctx.app.inject({
              method: 'GET',
              url: `/api/v1/networks/${nid}/thought-types/${colleague.id}/properties`,
              headers: h,
            })
          ).json().data as Array<{ key: string; default_value: unknown; overridden_here: boolean }>
        ).find((d) => d.key === 'пол')!;
        assert.equal(afterOverride.default_value, 'женский');
        assert.equal(afterOverride.overridden_here, true);

        const clearRes = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${nid}/thought-types/${colleague.id}/properties/${personProp.id}/default`,
          headers: h,
          payload: { value: null },
        });
        assert.equal(clearRes.statusCode, 200);

        // An untyped thought resolves the root type's properties.
        const untypedRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts`,
          headers: h,
          payload: { title: 'Без типа' },
        });
        const untyped = untypedRes.json().data as { id: string };
        const setValRes = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${nid}/thoughts/${untyped.id}/properties/заметка`,
          headers: h,
          payload: { value: 'значение' },
        });
        assert.equal(setValRes.statusCode, 200);

        // --- filters expand to subtrees: a link-type parent matches --------
        const ltRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/link-types`,
          headers: h,
          payload: { name_forward: 'работает с', name_reverse: 'работает с кем' },
        });
        assert.equal(ltRes.statusCode, 201);
        const ltParent = ltRes.json().data as { id: string; parent_id: string };
        assert.equal(ltParent.parent_id, linkRoot.id);

        // Search: the thought with type Коллега is found via Персона (ancestor).
        const searchRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/search?q=Иванов&scope=names&type_id=${encodeURIComponent(person.id)}`,
          headers: h,
        });
        assert.equal(searchRes.statusCode, 200);
        const hits = (searchRes.json().data as { by_names: Array<{ thought_id: string }> }).by_names;
        assert.ok(
          hits.some((hit) => hit.thought_id === (thoughtOkRes.json().data as { id: string }).id),
        );
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
