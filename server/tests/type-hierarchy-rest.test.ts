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
        // Regression for 0ab4749b (font_bold должен быть логическим значением):
        // POST /thought-types must accept `null` for font_* — the client's
        // minimal-payload path sends `null` when the user did not override the
        // style. The server stores `null` and a follow-up PATCH with the same
        // null must succeed too (the inherited-from-parent semantics).
        const fontNullRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
          payload: {
            name: 'Стиль-нулевой',
            font_bold: null,
            font_italic: null,
            font_underline: null,
            font_strike: null,
            fg_color: null,
            bg_color: null,
          },
        });
        assert.equal(fontNullRes.statusCode, 201);
        const fontNull = fontNullRes.json().data as {
          id: string;
          version: number;
          font_bold: boolean | null;
          font_italic: boolean | null;
          font_underline: boolean | null;
          font_strike: boolean | null;
          fg_color: string | null;
          bg_color: string | null;
        };
        assert.equal(fontNull.font_bold, null);
        assert.equal(fontNull.font_italic, null);
        assert.equal(fontNull.font_underline, null);
        assert.equal(fontNull.font_strike, null);
        assert.equal(fontNull.fg_color, null);
        assert.equal(fontNull.bg_color, null);

        // PATCH on the same nulls stays legal.
        const fontNullPatchRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${fontNull.id}`,
          headers: { ...h, 'If-Match': String(fontNull.version) },
          payload: {
            font_bold: null,
            font_italic: null,
            font_underline: null,
            font_strike: null,
          },
        });
        assert.equal(fontNullPatchRes.statusCode, 200);
        const fontNullPatched = fontNullPatchRes.json().data as {
          font_bold: boolean | null;
          font_italic: boolean | null;
          font_underline: boolean | null;
          font_strike: boolean | null;
        };
        assert.equal(fontNullPatched.font_bold, null);
        assert.equal(fontNullPatched.font_italic, null);
        assert.equal(fontNullPatched.font_underline, null);
        assert.equal(fontNullPatched.font_strike, null);

        // The wrong-type 422 still fires — `font_bold: "yes"` is rejected.
        const badFontRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
          payload: { name: 'Стиль-плохой', font_bold: 'yes' },
        });
        assert.equal(badFontRes.statusCode, 422);

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
          value_type?: string;
        }>;
        // Структурные «Родители»/«Потомки» наследуются от корня — это свойства-
        // связи, а не скаляры: отфильтруем их для скалярного списка.
        assert.deepEqual(
          effective.filter((d) => d.value_type !== 'link').map((d) => d.key).sort(),
          ['заметка', 'пол'],
        );
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

        // --- description of a definition: registry-edited for own properties ---
        // (0.6.5): description is a property-level field, not a binding one.
        // For own bindings the description lives in the registry; inherited
        // bindings override it via PUT …/properties/{id}/description.
        const personEff = (
          (
            await ctx.app.inject({
              method: 'GET',
              url: `/api/v1/networks/${nid}/thought-types/${person.id}/properties`,
              headers: h,
            })
          ).json().data as Array<{ key: string; property_id: string }>
        ).find((d) => d.key === 'пол')!;
        const registryDescRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/properties/${personEff.property_id}`,
          headers: h,
          payload: { description: 'биологический пол человека' },
        });
        assert.equal(registryDescRes.statusCode, 200);
        assert.equal(
          (registryDescRes.json().data as { description: string | null }).description,
          'биологический пол человека',
        );
        // The binding-level PATCH with `description` is now a 422 (binding
        // changes only carry `required` / `position`).
        const bindingDescRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${person.id}/properties/${personProp.id}`,
          headers: h,
          payload: { description: 'не должно пройти' },
        });
        assert.equal(bindingDescRes.statusCode, 422);

        // The child inherits the description with the property.
        const inheritedDesc = (
          (
            await ctx.app.inject({
              method: 'GET',
              url: `/api/v1/networks/${nid}/thought-types/${colleague.id}/properties`,
              headers: h,
            })
          ).json().data as Array<{ key: string; description: string | null; description_overridden: boolean }>
        ).find((d) => d.key === 'пол')!;
        assert.equal(inheritedDesc.description, 'биологический пол человека');
        assert.equal(inheritedDesc.description_overridden, false);

        // The child overrides the description for itself, then resets it.
        const descOverrideRes = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${nid}/thought-types/${colleague.id}/properties/${personProp.id}/description`,
          headers: h,
          payload: { description: 'пол, указанный в личном деле' },
        });
        assert.equal(descOverrideRes.statusCode, 200);
        const afterDescOverride = (
          (
            await ctx.app.inject({
              method: 'GET',
              url: `/api/v1/networks/${nid}/thought-types/${colleague.id}/properties`,
              headers: h,
            })
          ).json().data as Array<{ key: string; description: string | null; description_overridden: boolean }>
        ).find((d) => d.key === 'пол')!;
        assert.equal(afterDescOverride.description, 'пол, указанный в личном деле');
        assert.equal(afterDescOverride.description_overridden, true);

        const descClearRes = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${nid}/thought-types/${colleague.id}/properties/${personProp.id}/description`,
          headers: h,
          payload: { description: null },
        });
        assert.equal(descClearRes.statusCode, 200);
        const afterDescClear = (
          (
            await ctx.app.inject({
              method: 'GET',
              url: `/api/v1/networks/${nid}/thought-types/${colleague.id}/properties`,
              headers: h,
            })
          ).json().data as Array<{ key: string; description: string | null; description_overridden: boolean }>
        ).find((d) => d.key === 'пол')!;
        assert.equal(afterDescClear.description, 'биологический пол человека');
        assert.equal(afterDescClear.description_overridden, false);

        // An own property's description is edited on the definition itself —
        // the override endpoint refuses it (422).
        const ownDescOverrideRes = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${nid}/thought-types/${person.id}/properties/${personProp.id}/description`,
          headers: h,
          payload: { description: 'nope' },
        });
        assert.equal(ownDescOverrideRes.statusCode, 422);

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
        // 0.8.1, задача d7177d1d: POST /link-types закрыт (422) — создание
        // типа связи идёт через POST свойства-связи с парой имён.
        const ltRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/properties`,
          headers: h,
          payload: {
            name: 'работает с',
            value_type: 'link',
            name_forward: 'работает с',
            name_reverse: 'работает с кем',
          },
        });
        assert.equal(ltRes.statusCode, 201, ltRes.body?.toString());
        // Подтверждаем, что link_type создан и его parent_id — корень.
        // Реестровое свойство содержит config.link_type_id, по нему
        // достаём сам link-type через GET /link-types.
        const createdProp = ltRes.json().data as { config: { link_type_id: string } | null };
        const linkTypeId = createdProp.config?.link_type_id;
        assert.ok(linkTypeId);
        const ltList = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/link-types`,
          headers: h,
        });
        assert.equal(ltList.statusCode, 200);
        const ltParent = (
          ltList.json().data as Array<{ id: string; parent_id: string }>
        ).find((t) => t.id === linkTypeId);
        assert.ok(ltParent);
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

        // --- record counts (task «Улучшить диалог редактирования типов
        // мыслей и связей»): own counts per type id, group summing is a
        // client-side concern (aggregateTypeCounts, type-tree.ts) ----------
        const ttCountsRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/thought-types/counts`,
          headers: h,
        });
        assert.equal(ttCountsRes.statusCode, 200);
        const ttCounts = ttCountsRes.json().data as Record<string, number>;
        // «Иванов» carries type Коллега; «X»/«Без типа» stayed untyped or
        // were rejected — Коллега is the only type with an own count here.
        assert.equal(ttCounts[colleague.id], 1);
        assert.equal(ttCounts[person.id] ?? 0, 0);

        const ltCountsRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/link-types/counts`,
          headers: h,
        });
        assert.equal(ltCountsRes.statusCode, 200);
        // No link was ever created with a type in this scenario.
        assert.deepEqual(ltCountsRes.json().data, {});
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('link-property default: override with a target set, apply on create, skip stale targets (bb67e546)', async () => {
      const ctx: RestTestContext = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;

        const mkType = async (name: string, parentId: string | null): Promise<string> => {
          const res = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${nid}/thought-types`,
            headers: h,
            payload: { name, parent_id: parentId },
          });
          assert.equal(res.statusCode, 201, res.body?.toString());
          return (res.json().data as { id: string }).id;
        };
        const person = await mkType('Персона', null);
        const colleague = await mkType('Коллега', person);
        const mkThought = async (title: string, typeId: string | null): Promise<string> => {
          const res = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${nid}/thoughts`,
            headers: h,
            payload: { title, ...(typeId === null ? {} : { type_id: typeId }) },
          });
          assert.equal(res.statusCode, 201, res.body?.toString());
          return (res.json().data as { id: string }).id;
        };

        // 0.8.1, задача d7177d1d: POST /link-types закрыт — создание типа
        // связи идёт через POST свойства-связи с парой имён.
        const ltRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/properties`,
          headers: h,
          payload: {
            name: 'работает в',
            value_type: 'link',
            name_forward: 'работает в',
            name_reverse: 'сотрудники',
          },
        });
        assert.equal(ltRes.statusCode, 201, ltRes.body?.toString());
        const ltProp = ltRes.json().data as {
          id: string;
          config: { link_type_id: string } | null;
        };
        const lt = { id: ltProp.config?.link_type_id, name_forward: 'работает в' };

        // Подключаем уже созданное свойство к Персоне (Коллега наследует).
        // 0.8.1: POST /thought-types/{id}/properties в форме `property_id`
        // подключает существующее реестровое свойство — повторно создавать
        // свойство с тем же config.link_type_id было бы ошибкой
        // (DUPLICATE — пара (link_type, side) адресует свойство однозначно).
        const propRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types/${person}/properties`,
          headers: h,
          payload: { property_id: ltProp.id, required: false },
        });
        assert.equal(propRes.statusCode, 201, propRes.body?.toString());
        const prop = propRes.json().data as { id: string; property_id: string };

        const firm = await mkThought('Фирма 1С', null);
        const firm2 = await mkThought('Фирка 2', null);

        // Override the default on Коллега with a target set.
        const overrideRes = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${nid}/thought-types/${colleague}/properties/${prop.property_id}/default`,
          headers: h,
          payload: { value: [firm, firm2, firm] }, // duplicate folds away
        });
        assert.equal(overrideRes.statusCode, 200, overrideRes.body?.toString());

        const eff = (
          (
            await ctx.app.inject({
              method: 'GET',
              url: `/api/v1/networks/${nid}/thought-types/${colleague}/properties`,
              headers: h,
            })
          ).json().data as Array<{ key: string; default_value: unknown; overridden_here: boolean }>
        ).find((d) => d.key === lt.name_forward)!;
        assert.ok(eff !== undefined, 'эффективный набор несёт свойство-связь под display-именем');
        assert.deepEqual(eff.default_value, [firm, firm2]);
        assert.equal(eff.overridden_here, true);

        // Unknown target id → 422.
        const badRes = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${nid}/thought-types/${colleague}/properties/${prop.property_id}/default`,
          headers: h,
          payload: { value: [firm, '00000000-0000-4000-8000-0000000000ff'] },
        });
        assert.equal(badRes.statusCode, 422);

        // Empty array resets the override (back to the registry's own null).
        const resetRes = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${nid}/thought-types/${colleague}/properties/${prop.property_id}/default`,
          headers: h,
          payload: { value: [] },
        });
        assert.equal(resetRes.statusCode, 200);
        const afterReset = (
          (
            await ctx.app.inject({
              method: 'GET',
              url: `/api/v1/networks/${nid}/thought-types/${colleague}/properties`,
              headers: h,
            })
          ).json().data as Array<{ key: string; default_value: unknown; overridden_here: boolean }>
        ).find((d) => d.key === lt.name_forward)!;
        assert.equal(afterReset.default_value, null);
        assert.equal(afterReset.overridden_here, false);

        // Registry-level default (the nature dialog's path): config.default_value.
        const regRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/properties/${prop.property_id}`,
          headers: h,
          payload: { config: { link_type_id: lt.id, direction: 'out', default_value: [firm] } },
        });
        assert.equal(regRes.statusCode, 200, regRes.body?.toString());
        const afterReg = (
          (
            await ctx.app.inject({
              method: 'GET',
              url: `/api/v1/networks/${nid}/thought-types/${person}/properties`,
              headers: h,
            })
          ).json().data as Array<{ key: string; default_value: unknown }>
        ).find((d) => d.key === lt.name_forward)!;
        assert.deepEqual(afterReg.default_value, [firm]);

        // A bad registry default (unknown id) is rejected.
        const badReg = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/properties/${prop.property_id}`,
          headers: h,
          payload: {
            config: { link_type_id: lt.id, direction: 'out', default_value: ['nope'] },
          },
        });
        assert.equal(badReg.statusCode, 422);

        // Applying on create: a new Коллега gets the edge to «Фирма 1С».
        const created = await mkThought('Новиков Семён', colleague);
        const grouped = (
          await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${nid}/thoughts/${created}/links?group=type`,
            headers: h,
          })
        ).json().data as {
          by_type: Array<{ items: Array<{ link: { target_id: string } }> }>;
        };
        const targets = grouped.by_type.flatMap((g) => g.items.map((i) => i.link.target_id));
        assert.deepEqual(targets, [firm]);

        // Stale target: trash «Фирма 1С» → a new thought is still created, the
        // dead default is skipped silently.
        const firmRow = (
          await ctx.app.inject({ method: 'GET', url: `/api/v1/networks/${nid}/thoughts/${firm}`, headers: h })
        ).json().data as { version: number };
        const trashRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thoughts/${firm}`,
          headers: { ...h, 'If-Match': String(firmRow.version) },
          payload: { marked_for_deletion: true },
        });
        assert.equal(trashRes.statusCode, 200);
        const created2 = await mkThought('Ещё коллега', colleague);
        const grouped2 = (
          await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${nid}/thoughts/${created2}/links?group=type`,
            headers: h,
          })
        ).json().data as { by_type: Array<{ items: unknown[] }> };
        assert.equal(grouped2.by_type.length, 0, 'протухшая цель не создаёт ребра и не валит создание');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
