/**
 * `parent_id` в REST-создании и правке мысли (ошибка d9ba9e68, 0.15.4).
 *
 * Симптом до фикса: `POST /thoughts` с `parent_id` отвечал `201`, но ребра
 * «родитель → мысль» не появлялось (поле молча отбрасывалось парсером тела);
 * `PATCH /thoughts/{id}` с `parent_id` — то же самое с `200`. Загрузчик
 * библиотеки из-за этого оставлял мысли-сироты.
 *
 * Покрытие DoD:
 *   * создание с `parent_id` даёт нетипизированное ребро родитель→мысль;
 *   * без `parent_id` — прежнее поведение (никаких рёбер);
 *   * `parent_id` вместе с `create_link` — 422 (неоднозначный вход);
 *   * `PATCH` с `parent_id` перемещает мысль: прежние структурные родители
 *     снимаются, дети не затрагиваются;
 *   * невалидный родитель (несуществующий, сама мысль) — 4xx;
 *   * неизвестное поле тела мысли — 422 со списком (не молчаливое игнорирование).
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
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

/** Ответ одной мысли POST/PATCH: `data` + версия из `meta`. */
interface ThoughtResponse {
  data: { id: string; version: number };
  meta: { version: number };
}

async function api(
  ctx: RestTestContext,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  options: { payload?: Record<string, unknown>; version?: number } = {},
) {
  return ctx.app.inject({
    method,
    url: `/api/v1/networks/${ctx.networkId}${path}`,
    headers: {
      ...authHeaders(ctx),
      ...(options.version === undefined ? {} : { 'if-match': String(options.version) }),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

async function createThought(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<ThoughtResponse> {
  const res = await api(ctx, 'POST', '/thoughts', { payload });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as ThoughtResponse;
}

/** Id мыслей в зоне `dir` (`parents`/`children`) по REST-соседям. */
async function neighborIds(
  ctx: RestTestContext,
  id: string,
  dir: 'parents' | 'children',
): Promise<string[]> {
  const res = await api(ctx, 'GET', `/thoughts/${id}/neighbors?dir=${dir}`);
  assert.equal(res.statusCode, 200, res.body);
  return (res.json().data as { id: string }[]).map((n) => n.id).sort();
}

/** Тело канонической ошибки REST. */
function errorBody(res: { json: () => unknown }): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  return (
    res.json() as { error: { code: string; message: string; details?: Record<string, unknown> } }
  ).error;
}

describe(
  'REST: parent_id при создании и правке мысли (d9ba9e68)',
  { skip: !nativeAvailable() },
  () => {
    it('создание с parent_id создаёт ребро родитель→мысль', async () => {
      const ctx = await buildRestContext();
      try {
        const parent = await createThought(ctx, { title: 'Родитель' });
        const child = await createThought(ctx, {
          title: 'Потомок',
          parent_id: parent.data.id,
        });

        assert.deepEqual(await neighborIds(ctx, child.data.id, 'parents'), [parent.data.id]);
        assert.deepEqual(await neighborIds(ctx, parent.data.id, 'children'), [child.data.id]);
        // Ребро нетипизированное (структурное), как у `create_link` по умолчанию.
        const linkTypeId = await ctx.ndb
          .prepare('SELECT type_id FROM links_v WHERE source_id = ? AND target_id = ?')
          .pluck()
          .get(parent.data.id, child.data.id);
        assert.equal(linkTypeId, null);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('создание без parent_id не создаёт рёбер (прежнее поведение)', async () => {
      const ctx = await buildRestContext();
      try {
        const thought = await createThought(ctx, { title: 'Одиночка' });
        assert.deepEqual(await neighborIds(ctx, thought.data.id, 'parents'), []);
        assert.deepEqual(await neighborIds(ctx, thought.data.id, 'children'), []);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('parent_id вместе с create_link — 422, мысль не создана', async () => {
      const ctx = await buildRestContext();
      try {
        const parent = await createThought(ctx, { title: 'Родитель' });
        const res = await api(ctx, 'POST', '/thoughts', {
          payload: {
            title: 'Неоднозначная',
            parent_id: parent.data.id,
            create_link: { direction: 'parent', target_thought_id: parent.data.id },
          },
        });
        assert.equal(res.statusCode, 422, res.body);
        assert.equal(errorBody(res).code, 'VALIDATION_ERROR');
        const remaining = await ctx.ndb
          .prepare("SELECT COUNT(*) FROM thoughts_v WHERE title = 'Неоднозначная'")
          .pluck()
          .get();
        assert.equal(remaining, 0);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('PATCH с parent_id перемещает мысль, дети не затрагиваются', async () => {
      const ctx = await buildRestContext();
      try {
        const oldParent = await createThought(ctx, { title: 'Старый родитель' });
        const newParent = await createThought(ctx, { title: 'Новый родитель' });
        const moved = await createThought(ctx, {
          title: 'Перемещаемая',
          parent_id: oldParent.data.id,
        });
        const child = await createThought(ctx, {
          title: 'Ребёнок перемещаемой',
          parent_id: moved.data.id,
        });
        assert.deepEqual(await neighborIds(ctx, moved.data.id, 'parents'), [oldParent.data.id]);

        const res = await api(ctx, 'PATCH', `/thoughts/${moved.data.id}`, {
          payload: { parent_id: newParent.data.id },
          version: moved.data.version,
        });
        assert.equal(res.statusCode, 200, res.body);

        // Ровно один структурный родитель — новый; прежний снят.
        assert.deepEqual(await neighborIds(ctx, moved.data.id, 'parents'), [newParent.data.id]);
        assert.deepEqual(await neighborIds(ctx, oldParent.data.id, 'children'), []);
        // Собственный ребёнок перемещаемой мысли остался на месте.
        assert.deepEqual(await neighborIds(ctx, moved.data.id, 'children'), [child.data.id]);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('PATCH parent_id: сама мысль — 422, несуществующий родитель — 404', async () => {
      const ctx = await buildRestContext();
      try {
        const thought = await createThought(ctx, { title: 'Мысль' });
        const self = await api(ctx, 'PATCH', `/thoughts/${thought.data.id}`, {
          payload: { parent_id: thought.data.id },
          version: thought.data.version,
        });
        assert.equal(self.statusCode, 422, self.body);
        assert.equal(errorBody(self).details?.['field'], 'parent_id');

        const missing = await api(ctx, 'PATCH', `/thoughts/${thought.data.id}`, {
          payload: { parent_id: '00000000-0000-4000-8000-000000000000' },
          version: thought.data.version,
        });
        assert.equal(missing.statusCode, 404, missing.body);
        assert.equal(errorBody(missing).code, 'NOT_FOUND');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('неизвестное поле тела мысли — 422 со списком допустимых', async () => {
      const ctx = await buildRestContext();
      try {
        const created = await api(ctx, 'POST', '/thoughts', {
          payload: { title: 'С лишним полем', parents: [] },
        });
        assert.equal(created.statusCode, 422, created.body);
        const error = errorBody(created);
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.deepEqual(error.details?.['fields'], ['parents']);
        assert.ok((error.details?.['allowed'] as string[]).includes('parent_id'));

        const thought = await createThought(ctx, { title: 'Правка с лишним полем' });
        const patched = await api(ctx, 'PATCH', `/thoughts/${thought.data.id}`, {
          payload: { parent_ids: [] },
          version: thought.data.version,
        });
        assert.equal(patched.statusCode, 422, patched.body);
        assert.deepEqual(errorBody(patched).details?.['fields'], ['parent_ids']);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
