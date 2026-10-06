/**
 * Интеграционные тесты `GET /networks/:id/statistics` (задача c69b078d, 0.9.1).
 *
 * Проверяются все счётчики сводки: онтология (типы/свойства), мысли, связи и
 * публикации с разбивкой «всего/актуальные/неактуальные/в корзине», полки,
 * слои и вложения.
 * Ключевое свойство — числа суммируются ПО ВСЕМ слоям: теневая строка слоя
 * добавляется к «всего», надгробие — нет; сервисные (резервные) слои в счёт
 * слоёв не входят. Абсолютные значения онтологии зависят от сидинга сети,
 * поэтому проверяются приросты относительно базовой сводки.
 *
 * Требует нативного better-sqlite3; иначе пропускается.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, type NetworkStats } from '@etn/shared';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  createPlainUser,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** `GET /networks/:id/statistics` для админа контекста. */
async function fetchStats(ctx: RestTestContext): Promise<{ statusCode: number; data: NetworkStats }> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/statistics`,
    headers: authHeaders(ctx),
  });
  return { statusCode: res.statusCode, data: res.json().data as NetworkStats };
}

/** Создать мысль через API и вернуть её id. */
async function createThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201);
  return (res.json().data as { id: string }).id;
}

/** PATCH мысли (active / marked_for_deletion) без If-Match. */
async function patchThought(
  ctx: RestTestContext,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}`,
    headers: authHeaders(ctx),
    payload: body,
  });
  assert.equal(res.statusCode, 200);
}

/** Установить структурное свойство «Потомки» (создаёт/корзинит рёбра). */
async function setDescendants(
  ctx: RestTestContext,
  thoughtId: string,
  ids: string[],
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/properties/${encodeURIComponent('Потомки')}`,
    headers: authHeaders(ctx),
    payload: { value: ids },
  });
  assert.equal(res.statusCode, 200);
}

/** Прямая вставка строки в физическую ветвимую таблицу (слой/надгробие). */
function rawExec(ctx: RestTestContext, sql: string, ...params: unknown[]): void {
  ctx.ndb.prepare(sql).run(...params);
}

describe(
  'GET /networks/:id/statistics',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('считает онтологию, мысли/связи/публикации с разбивкой, полки, слои и вложения (сумма по слоям)', async () => {
      const ctx = await buildRestContext();
      try {
        // Базовая сводка: сеть только что создана (HOME + сидинг онтологии).
        const base = await fetchStats(ctx);
        assert.equal(base.statusCode, 200);
        assert.ok(base.data.thought_types >= 1, 'типы мыслей сети не пусты');
        assert.ok(base.data.link_types >= 0);
        assert.ok(base.data.properties >= 0);

        // --- Мысли: актуальная, неактуальная, корзинная --------------------
        const activeThought = await createThought(ctx, 'Актуальная');
        const inactiveThought = await createThought(ctx, 'Неактуальная');
        await patchThought(ctx, inactiveThought, { active: false });
        const trashedThought = await createThought(ctx, 'В корзине');
        await patchThought(ctx, trashedThought, { marked_for_deletion: true });

        // --- Слои и суммирование по ним ------------------------------------
        const userLayer = randomUUID();
        const serviceLayer = randomUUID();
        const now = new Date().toISOString();
        rawExec(
          ctx,
          `INSERT INTO layers (id, parent_id, title, is_service, is_base, depth, created_by, created_at, last_activity_at)
           VALUES (?, ?, 'Рабочий слой', 0, 0, 1, 'u', ?, ?)`,
          userLayer,
          BASE_LAYER_ID,
          now,
          now,
        );
        rawExec(
          ctx,
          `INSERT INTO layers (id, parent_id, title, is_service, is_base, depth, created_by, created_at, last_activity_at)
           VALUES (?, ?, 'Резервный слой', 1, 0, 1, 'u', ?, ?)`,
          serviceLayer,
          BASE_LAYER_ID,
          now,
          now,
        );
        // Теневая (живая) копия актуальной мысли в рабочем слое — это отдельная
        // физическая строка, значит «всего» растёт на 1 (сумма по слоям).
        rawExec(
          ctx,
          `INSERT INTO thoughts (id, layer_id, title, title_norm, active, deleted, version,
             created_at, created_by, updated_at, updated_by, marked_for_deletion, base_version)
           VALUES (?, ?, 'Актуальная (слой)', 'актуальная (слой)', 1, 0, 2, ?, 'u', ?, 'u', 0, 1)`,
          activeThought,
          userLayer,
          now,
          now,
        );
        // Надгробие в слое — скрытая строка, в счёт не входит.
        rawExec(
          ctx,
          `INSERT INTO thoughts (id, layer_id, title, title_norm, active, deleted, version,
             created_at, created_by, updated_at, updated_by, marked_for_deletion, base_version)
           VALUES (?, ?, 'Надгробие', 'надгробие', 1, 1, 2, ?, 'u', ?, 'u', 0, 1)`,
          randomUUID(),
          userLayer,
          now,
          now,
        );

        // --- Публикации и полки: разбивка, сумма по слоям ------------------
        const activePublication = randomUUID();
        rawExec(
          ctx,
          `INSERT INTO publications (id, layer_id, title, active, deleted, marked_for_deletion,
             base_version, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, 'Актуальная публикация', 1, 0, 0, 0, ?, 'u', ?, 'u')`,
          activePublication,
          BASE_LAYER_ID,
          now,
          now,
        );
        rawExec(
          ctx,
          `INSERT INTO publications (id, layer_id, title, active, deleted, marked_for_deletion,
             base_version, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, 'Неактуальная публикация', 0, 0, 0, 0, ?, 'u', ?, 'u')`,
          randomUUID(),
          BASE_LAYER_ID,
          now,
          now,
        );
        rawExec(
          ctx,
          `INSERT INTO publications (id, layer_id, title, active, deleted, marked_for_deletion,
             base_version, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, 'Публикация в корзине', 1, 0, 1, 0, ?, 'u', ?, 'u')`,
          randomUUID(),
          BASE_LAYER_ID,
          now,
          now,
        );
        // Живая теневая копия публикации в рабочем слое — «всего» растёт на 1.
        rawExec(
          ctx,
          `INSERT INTO publications (id, layer_id, title, active, deleted, marked_for_deletion,
             base_version, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, 'Актуальная публикация (слой)', 1, 0, 0, 1, ?, 'u', ?, 'u')`,
          activePublication,
          userLayer,
          now,
          now,
        );
        // Надгробие публикации в слое — скрытая строка, в счёт не входит.
        rawExec(
          ctx,
          `INSERT INTO publications (id, layer_id, title, active, deleted, marked_for_deletion,
             base_version, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, 'Надгробие публикации', 1, 1, 0, 1, ?, 'u', ?, 'u')`,
          randomUUID(),
          userLayer,
          now,
          now,
        );
        // Живая полка и её надгробие: считается только живая строка.
        // Имя уникально (в сети уже есть дефолтная полка «Полка»).
        rawExec(
          ctx,
          `INSERT INTO shelves (id, layer_id, title, title_key, position, deleted,
             created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, 'Тестовая полка', 'тестовая полка', 1, 0, ?, 'u', ?, 'u')`,
          randomUUID(),
          BASE_LAYER_ID,
          now,
          now,
        );
        rawExec(
          ctx,
          `INSERT INTO shelves (id, layer_id, title, title_key, position, deleted,
             created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, 'Тестовая полка-надгробие', 'тестовая полка-надгробие', 2, 1, ?, 'u', ?, 'u')`,
          randomUUID(),
          userLayer,
          now,
          now,
        );

        // --- Связи: одна актуальная, одна в корзине ------------------------
        await setDescendants(ctx, ctx.homeId, [activeThought, inactiveThought]);
        await setDescendants(ctx, ctx.homeId, [activeThought]);

        // --- Вложения: одна ссылка и один файл на 1500 байт ----------------
        rawExec(
          ctx,
          `INSERT INTO attachments (id, owner_type, owner_id, kind, url, created_at, created_by)
           VALUES (?, 'thought', ?, 'url', 'https://example.com', ?, 'u')`,
          randomUUID(),
          activeThought,
          now,
        );
        rawExec(
          ctx,
          `INSERT INTO attachments (id, owner_type, owner_id, kind, file_path, file_size, created_at, created_by)
           VALUES (?, 'thought', ?, 'file', 'C:/tmp/a.bin', 1500, ?, 'u')`,
          randomUUID(),
          activeThought,
          now,
        );

        const after = await fetchStats(ctx);
        assert.equal(after.statusCode, 200);

        // Мысли: +3 живых +1 теневой слой (надгробие не считается).
        assert.equal(after.data.thoughts.total - base.data.thoughts.total, 4);
        assert.equal(after.data.thoughts.active - base.data.thoughts.active, 2);
        assert.equal(after.data.thoughts.inactive - base.data.thoughts.inactive, 1);
        assert.equal(after.data.thoughts.trashed - base.data.thoughts.trashed, 1);

        // Связи: +2 всего, +1 актуальная, +1 в корзине.
        assert.equal(after.data.links.total - base.data.links.total, 2);
        assert.equal(after.data.links.active - base.data.links.active, 1);
        assert.equal(after.data.links.inactive - base.data.links.inactive, 0);
        assert.equal(after.data.links.trashed - base.data.links.trashed, 1);

        // Публикации: +3 живых в основе +1 теневой слой (надгробие не считается).
        assert.equal(after.data.publications.total - base.data.publications.total, 4);
        assert.equal(after.data.publications.active - base.data.publications.active, 2);
        assert.equal(after.data.publications.inactive - base.data.publications.inactive, 1);
        assert.equal(after.data.publications.trashed - base.data.publications.trashed, 1);

        // Полки: живая считается, надгробие — нет.
        assert.equal(after.data.shelves - base.data.shelves, 1);

        // Слои: пользовательский считается, сервисный — нет.
        assert.equal(after.data.layers - base.data.layers, 1);

        // Вложения.
        assert.equal(after.data.attachments.total - base.data.attachments.total, 2);
        assert.equal(after.data.attachments.files - base.data.attachments.files, 1);
        assert.equal(
          after.data.attachments.file_size_bytes - base.data.attachments.file_size_bytes,
          1500,
        );

        // Онтология не менялась — числа совпадают с базовыми.
        assert.equal(after.data.thought_types, base.data.thought_types);
        assert.equal(after.data.link_types, base.data.link_types);
        assert.equal(after.data.properties, base.data.properties);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('закрыт для пользователя без членства в сети', async () => {
      const ctx = await buildRestContext();
      try {
        const foreign = createPlainUser(ctx);
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/statistics`,
          headers: { authorization: `Bearer ${foreign.key}` },
        });
        assert.equal(res.statusCode, 403);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
