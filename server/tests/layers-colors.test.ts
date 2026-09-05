/**
 * Integration tests for the layer colour indication (0.6.4,
 * docs/13-layers.md §2.2a «Цветовая индикация слоёв»).
 *
 *   * migration 031 adds the nullable `layers.colors` column (existing rows
 *     keep NULL — theme defaults);
 *   * `GET /layers` / POST / PATCH responses carry `colors` (`null` on the
 *     base, always);
 *   * `POST /layers` accepts a valid `colors` object;
 *   * `PATCH /layers/{id}` replaces the whole object, `null` clears it;
 *   * incomplete (`focus_stripe` without `background`, a theme missing) or
 *     malformed (not `#rrggbb`) objects are 422 VALIDATION_ERROR;
 *   * assigning `colors` on the base layer is 422 VALIDATION_ERROR;
 *   * colour edits participate in the optimistic `version` lock.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, type Layer, type LayerColors } from '@etn/shared';

import { runMigrations } from '../src/db/migrator.js';
import { createInMemoryNetworkDb, registerMigrationHelpers } from '../src/db/network-db.js';
import { networkMigrationsDir } from '../src/paths.js';
import { authHeaders, buildRestContext, closeRestContext, nativeAvailable, type RestTestContext } from './rest-helpers.js';

/** A complete, valid colours object. */
const COLORS: LayerColors = {
  focus_stripe: { dark: '#7e57c2', light: '#b39ddb' },
  background: { dark: '#141021', light: '#ece6f6' },
};

/** Patch a layer; returns the full injected response. */
function patchLayer(ctx: RestTestContext, layerId: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}`,
    headers: authHeaders(ctx),
    payload,
  });
}

/** Create a layer via the API; returns the parsed DTO. */
async function createLayer(ctx: RestTestContext, payload: Record<string, unknown>): Promise<Layer> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers`,
    headers: authHeaders(ctx),
    payload,
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return res.json().data as Layer;
}

/** List layers via the API. */
async function listLayers(ctx: RestTestContext): Promise<Layer[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/layers`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200);
  return res.json().data as Layer[];
}

describe(
  'layers.colors migration (031)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('adds a nullable colors column; rows migrated through 030 keep NULL', () => {
      // A database that has applied everything up to 030 — the state of every
      // real network before 0.6.4.
      const db = new DatabaseConstructor(':memory:');
      db.exec(
        'CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)',
      );
      registerMigrationHelpers(db);
      const files = readdirSync(networkMigrationsDir()).filter((f) => f.endsWith('.sql')).sort();
      const through030 = files.filter((f) => f <= '030_type_property_description.sql');
      for (const file of through030) {
        const sql = readFileSync(path.join(networkMigrationsDir(), file), 'utf8');
        db.transaction(() => {
          db.exec(sql);
          db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
            file,
            new Date().toISOString(),
          );
        })();
      }
      const before = db
        .prepare("SELECT count(*) AS c FROM pragma_table_info('layers') WHERE name = 'colors'")
        .get() as { c: number };
      assert.equal(before.c, 0);

      runMigrations(db, networkMigrationsDir());
      const after = db
        .prepare("SELECT count(*) AS c FROM pragma_table_info('layers') WHERE name = 'colors'")
        .get() as { c: number };
      assert.equal(after.c, 1);
      // The base layer row survived with NULL colors (theme defaults).
      const base = db
        .prepare('SELECT colors FROM layers WHERE id = ?')
        .get(BASE_LAYER_ID) as { colors: string | null };
      assert.equal(base.colors, null);
      db.close();
    });

    it('fresh in-memory network DB applies all migrations including 031', () => {
      const db = createInMemoryNetworkDb();
      const base = db
        .prepare('SELECT colors FROM layers WHERE id = ?')
        .get(BASE_LAYER_ID) as { colors: string | null };
      assert.equal(base.colors, null);
      db.close();
    });
  },
);

describe(
  'layers colors REST (0.6.4)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('base layer always reports colors: null', async () => {
      const ctx = await buildRestContext();
      try {
        const layers = await listLayers(ctx);
        const base = layers.find((l) => l.is_base);
        assert.notEqual(base, undefined);
        assert.equal(base?.colors, null);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('POST stores colors; PATCH replaces the whole object; null clears', async () => {
      const ctx = await buildRestContext();
      try {
        const created = await createLayer(ctx, { title: 'Правки августа', colors: COLORS });
        assert.deepEqual(created.colors, COLORS);

        const replaced: LayerColors = {
          focus_stripe: { dark: '#00695c', light: '#4db6ac' },
          background: { dark: '#0b1512', light: '#e0f2f1' },
        };
        const res = await patchLayer(ctx, created.id, { colors: replaced });
        assert.equal(res.statusCode, 200, res.body?.toString());
        assert.deepEqual((res.json().data as Layer).colors, replaced);

        const cleared = await patchLayer(ctx, created.id, { colors: null });
        assert.equal(cleared.statusCode, 200);
        assert.equal((cleared.json().data as Layer).colors, null);

        // The cleared state is what the list reports too.
        const layers = await listLayers(ctx);
        assert.equal(layers.find((l) => l.id === created.id)?.colors, null);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('incomplete or malformed colors objects are 422 VALIDATION_ERROR', async () => {
      const ctx = await buildRestContext();
      try {
        const created = await createLayer(ctx, { title: 'Слой' });
        const bad: unknown[] = [
          'not an object',
          { focus_stripe: COLORS.focus_stripe }, // background missing
          { background: COLORS.background }, // focus_stripe missing
          { ...COLORS, focus_stripe: { dark: '#7e57c2' } }, // light missing
          { ...COLORS, background: { dark: '#141021', light: 'blue' } }, // not hex
          { ...COLORS, focus_stripe: { dark: '#7e57c2ff', light: '#b39ddb' } }, // 8 digits
        ];
        for (const payload of bad) {
          const res = await patchLayer(ctx, created.id, { colors: payload });
          assert.equal(res.statusCode, 422, `expected 422 for ${JSON.stringify(payload)}`);
          assert.equal(res.json().error.code, 'VALIDATION_ERROR');
        }
        // POST validates the same way.
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/layers`,
          headers: authHeaders(ctx),
          payload: { title: 'Ещё слой', colors: { focus_stripe: COLORS.focus_stripe } },
        });
        assert.equal(res.statusCode, 422);
        assert.equal(res.json().error.code, 'VALIDATION_ERROR');
        // Nothing was written by the rejected calls.
        assert.equal((await listLayers(ctx)).find((l) => l.id === created.id)?.colors, null);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('assigning colors to the base layer is 422 VALIDATION_ERROR', async () => {
      const ctx = await buildRestContext();
      try {
        const res = await patchLayer(ctx, BASE_LAYER_ID, { colors: COLORS });
        assert.equal(res.statusCode, 422);
        assert.equal(res.json().error.code, 'VALIDATION_ERROR');
        const resNull = await patchLayer(ctx, BASE_LAYER_ID, { colors: null });
        assert.equal(resNull.statusCode, 422);
        assert.equal((await listLayers(ctx)).find((l) => l.is_base)?.colors, null);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('colour edits bump the row version (If-Match optimistic lock)', async () => {
      const ctx = await buildRestContext();
      try {
        const created = await createLayer(ctx, { title: 'Слой' });
        const res = await patchLayer(ctx, created.id, { colors: COLORS });
        assert.equal(res.statusCode, 200);
        const updated = res.json().data as Layer;
        assert.equal(updated.version, created.version + 1);
        // A stale If-Match against the pre-edit version conflicts.
        const stale = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/layers/${created.id}`,
          headers: { ...authHeaders(ctx), 'if-match': String(created.version) },
          payload: { colors: null },
        });
        assert.equal(stale.statusCode, 409);
        assert.equal(stale.json().error.code, 'VERSION_CONFLICT');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
