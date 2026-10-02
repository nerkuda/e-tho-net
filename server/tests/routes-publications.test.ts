/**
 * REST-фасады подсистемы «Публикации» (0.11.1, задача c59ce742; карточки
 * 5af247e4 CRUD, 200b87be жизненный цикл, 19d80dd2 сборка, f6b242fe порядок,
 * 109061e0 исключения, f9a20c3f пересборка/кандидаты, f49c6420 использование,
 * c80951ea полки; реальное время 67b8748e; журнал d4452908).
 *
 * Покрытие DoD:
 *   * сквозной сценарий маршрутов: создание → сборка → порядок → исключение →
 *     экспорт-заглушка (`.etnx`-экспорт сети несёт публикации) → корзина →
 *     восстановление → purge; полки и использование мысли;
 *   * журнал активности: entity_type `publication`/`shelf`;
 *   * real-time: события приходят тестовому WS-клиенту, включая видимость
 *     слоёв (запись в рабочем слое не видна подписчику основы).
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { WebSocket } from 'ws';
import type { RawData } from 'ws';

import { BASE_LAYER_ID } from '@etn/shared';

import { createThoughtType } from '../src/domain/thought-type-service.js';
import { resetPublicationMembershipCache } from '../src/domain/publication-assembly-service.js';
import { createLayer, setSessionLayer } from '../src/domain/layer-service.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

const skip = !nativeAvailable();
const NOW = '2024-01-01T00:00:00Z';

/** Seed a thought of `typeId` directly (no REST round-trip). */
function seedThought(ndb: NetworkDb, title: string, typeId: string | null, user: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, 1, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), typeId, NOW, user, NOW, user);
  return id;
}

/** Seed an untyped structural link source → target; returns the edge id. */
function seedLink(ndb: NetworkDb, source: string, target: string, position: number, user: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, layer_id, deleted, base_version, source_id, target_id, type_id,
                          position, active, marked_for_deletion, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, 0, 0, ?, ?, NULL, ?, 1, 0, 1, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, source, target, position, NOW, NOW, user, user);
  return id;
}

/** Seed a permanent comment. */
function seedComment(ndb: NetworkDb, thoughtId: string, bodyMd: string, user: string): void {
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, title, body_md, body_html,
                             valid_from, valid_to, version, created_at, updated_at, created_by, updated_by)
       VALUES (?, 'thought', ?, 'permanent', NULL, ?, '', ?, NULL, 1, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), thoughtId, bodyMd, NOW, NOW, NOW, user, user);
}

interface InjectOptions {
  payload?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** Inject a REST call under the context's network and admin authorization. */
async function api(
  ctx: RestTestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: InjectOptions = {},
) {
  return ctx.app.inject({
    method,
    url: `/api/v1/networks/${ctx.networkId}${path}`,
    headers: { ...authHeaders(ctx), ...(options.headers ?? {}) },
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
  });
}

/** Full REST chain: publications, shelves, export placeholder, trash. */
describe('routes-publications: REST-сценарий', { skip }, () => {
  it('создание → сборка → порядок → исключение → экспорт → корзина; полки и использование', async () => {
    const ctx = await buildRestContext();
    try {
      const type = createThoughtType(ctx.ndb, { name: 'Doc' }, ctx.adminId);
      const a = seedThought(ctx.ndb, 'Раздел A', type.id, ctx.adminId);
      const b = seedThought(ctx.ndb, 'Раздел B', type.id, ctx.adminId);
      const edgeAB = seedLink(ctx.ndb, a, b, 0, ctx.adminId);
      seedComment(ctx.ndb, a, '# Предисловие\n\nВводный текст', ctx.adminId);

      // --- создание ---------------------------------------------------------
      const created = await api(ctx, 'POST', '/publications', {
        payload: {
          title: 'Документ',
          subtitle: 'Подзаголовок',
          summary_md: 'Краткое резюме',
          title_recipe: { type_ids: [type.id], sort: 'alpha', order: 'asc' },
          numbering_from: 1,
          numbering_to: 6,
        },
      });
      assert.equal(created.statusCode, 201, created.body);
      const pub = created.json().data as { id: string; cover_kind: string; version: number };
      assert.equal(pub.cover_kind, 'none');

      // --- список и карточка -------------------------------------------------
      const list = await api(ctx, 'GET', '/publications');
      assert.equal(list.statusCode, 200, list.body);
      assert.equal(list.json().meta.total, 1);
      const card = await api(ctx, 'GET', `/publications/${pub.id}`);
      assert.equal(card.statusCode, 200, card.body);
      assert.equal((card.json().data as { title: string }).title, 'Документ');

      // --- правка настроек ---------------------------------------------------
      const patched = await api(ctx, 'PATCH', `/publications/${pub.id}`, {
        payload: { subtitle: 'Новый подзаголовок', authorship: 'Автор' },
      });
      assert.equal(patched.statusCode, 200, patched.body);
      const patchedData = patched.json().data as { subtitle: string; authorship: string };
      assert.equal(patchedData.subtitle, 'Новый подзаголовок');
      assert.equal(patchedData.authorship, 'Автор');
      const badPatch = await api(ctx, 'PATCH', `/publications/${pub.id}`, {
        payload: { summary_md: '# Заголовок\n\nтекст' },
      });
      assert.equal(badPatch.statusCode, 422, badPatch.body);

      // --- сборка -----------------------------------------------------------
      const assembly = await api(ctx, 'GET', `/publications/${pub.id}/assembly`);
      assert.equal(assembly.statusCode, 200, assembly.body);
      const doc = assembly.json().data as {
        publication: { title: string; new_candidates: number };
        sections: Array<{ thought_id: string; children: Array<{ thought_id: string }> }>;
      };
      assert.equal(doc.publication.title, 'Документ');
      assert.equal(doc.sections.length, 1);
      assert.equal(doc.sections[0]!.thought_id, a);
      assert.deepEqual(
        doc.sections[0]!.children.map((c) => c.thought_id),
        [b],
      );

      // --- кандидаты (временная семантика: всё отобранное при создании принято) --
      const candidates = await api(ctx, 'GET', `/publications/${pub.id}/candidates`);
      assert.equal(candidates.statusCode, 200, candidates.body);
      assert.equal((candidates.json().data as { total: number }).total, 0);

      // --- использование мысли ----------------------------------------------
      const usage = await api(ctx, 'GET', `/thoughts/${b}/publications`);
      assert.equal(usage.statusCode, 200, usage.body);
      const usageData = usage.json().data as {
        items: Array<{ publication_id: string; role: string }>;
      };
      assert.ok(usageData.items.length >= 1);
      assert.equal(usageData.items[0]!.publication_id, pub.id);
      assert.equal(usageData.items[0]!.role, 'section');

      // --- порядок (батч, один запрос) --------------------------------------
      const order = await api(ctx, 'PUT', `/publications/${pub.id}/order`, {
        payload: {
          items: [
            { node_key: a, position: 1 },
            { node_key: edgeAB, position: 2 },
          ],
        },
      });
      assert.equal(order.statusCode, 200, order.body);
      assert.equal((order.json().data as { items: unknown[] }).items.length, 2);

      // --- исключение мысли --------------------------------------------------
      const exclude = await api(ctx, 'POST', `/publications/${pub.id}/exclusions`, {
        payload: { thought_id: b },
      });
      assert.equal(exclude.statusCode, 200, exclude.body);
      const hidden = await api(ctx, 'GET', `/publications/${pub.id}/assembly`);
      const hiddenDoc = hidden.json().data as {
        sections: Array<{ children: unknown[] }>;
        excluded: Array<{ thought_id: string }>;
      };
      // В чтении исключённый раздел не попадает в дерево, но остаётся в
      // списке `excluded` (для пометки в редакторе).
      assert.deepEqual(hiddenDoc.sections[0]!.children, []);
      assert.deepEqual(
        hiddenDoc.excluded.map((e) => e.thought_id),
        [b],
      );

      const withExcluded = await api(
        ctx,
        'GET',
        `/publications/${pub.id}/assembly?include_excluded=true`,
      );
      const editorDoc = withExcluded.json().data as {
        excluded: Array<{ thought_id: string }>;
      };
      assert.deepEqual(
        editorDoc.excluded.map((e) => e.thought_id),
        [b],
      );

      const unexclude = await api(
        ctx,
        'DELETE',
        `/publications/${pub.id}/exclusions?thought_id=${b}`,
      );
      assert.equal(unexclude.statusCode, 200, unexclude.body);

      // --- пересборка --------------------------------------------------------
      const before = (await api(ctx, 'GET', `/publications/${pub.id}`)).json().data as {
        assembly_date: string | null;
        version: number;
      };
      assert.equal(before.assembly_date, null);
      const rebuilt = await api(ctx, 'POST', `/publications/${pub.id}/rebuild`);
      assert.equal(rebuilt.statusCode, 200, rebuilt.body);
      const after = rebuilt.json().data as { assembly_date: string | null; version: number };
      assert.ok(after.assembly_date !== null);
      assert.ok(after.version > before.version);

      // --- полки -------------------------------------------------------------
      // Сеть создаётся с дефолтной полкой «Полка» (0.11.1, задача 8c2660e6).
      const initialShelves = await api(ctx, 'GET', '/shelves');
      assert.equal(initialShelves.json().meta.total, 1, initialShelves.body);
      assert.equal(
        (initialShelves.json().data as Array<{ title: string }>)[0]?.title,
        'Полка',
      );
      const shelfCreated = await api(ctx, 'POST', '/shelves', { payload: { title: 'Избранное' } });
      assert.equal(shelfCreated.statusCode, 201, shelfCreated.body);
      const shelfId = (shelfCreated.json().data as { id: string }).id;
      const shelves = await api(ctx, 'GET', '/shelves');
      assert.equal(shelves.json().meta.total, 2);
      const put = await api(ctx, 'POST', `/shelves/${shelfId}/items`, {
        payload: { publication_id: pub.id, position: 1 },
      });
      assert.equal(put.statusCode, 200, put.body);
      assert.equal(
        (put.json().data as { items: unknown[] }).items.length,
        1,
      );
      const renamed = await api(ctx, 'PATCH', `/shelves/${shelfId}`, {
        payload: { title: 'Переименована' },
      });
      assert.equal(renamed.statusCode, 200, renamed.body);
      assert.equal((renamed.json().data as { title: string }).title, 'Переименована');
      const taken = await api(ctx, 'POST', '/shelves', { payload: { title: 'Переименована' } });
      assert.equal(taken.statusCode, 422, taken.body);
      const itemRemoved = await api(
        ctx,
        'DELETE',
        `/shelves/${shelfId}/items?publication_id=${pub.id}`,
      );
      assert.equal(itemRemoved.statusCode, 200, itemRemoved.body);
      assert.equal((itemRemoved.json().data as { items: unknown[] }).items.length, 0);
      const shelfDeleted = await api(ctx, 'DELETE', `/shelves/${shelfId}`);
      assert.equal(shelfDeleted.statusCode, 204, shelfDeleted.body);

      // --- экспорт-заглушка: .etnx сети несёт публикации (950e0a59) ----------
      const exportStart = await api(ctx, 'POST', '/export', {
        payload: {
          thought_ids: [a],
          format: 'etnx',
          etnx: { include_types: true, include_subtree: true, subtree_depth: 1 },
        },
      });
      assert.equal(exportStart.statusCode, 202, exportStart.body);
      const jobId = (exportStart.json().data as { job_id: string }).job_id;
      const job = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${jobId}`,
        headers: authHeaders(ctx),
      });
      assert.equal(job.statusCode, 200, job.body);
      assert.equal((job.json().data as { status: string }).status, 'done');
      const download = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${jobId}/download`,
        headers: authHeaders(ctx),
      });
      assert.equal(download.statusCode, 200, download.body);

      // --- корзина и purge ---------------------------------------------------
      const trashed = await api(ctx, 'POST', `/publications/${pub.id}/trash`);
      assert.equal(trashed.statusCode, 200, trashed.body);
      assert.equal((trashed.json().data as { marked_for_deletion: boolean }).marked_for_deletion, true);
      const visible = await api(ctx, 'GET', '/publications');
      assert.equal(visible.json().meta.total, 0);
      const withTrash = await api(ctx, 'GET', '/publications?include_trashed=true');
      assert.equal(withTrash.json().meta.total, 1);
      const restored = await api(ctx, 'POST', `/publications/${pub.id}/restore`);
      assert.equal(restored.statusCode, 200, restored.body);
      const purged = await api(ctx, 'DELETE', `/publications/${pub.id}`);
      assert.equal(purged.statusCode, 204, purged.body);
      const gone = await api(ctx, 'GET', `/publications/${pub.id}`);
      assert.equal(gone.statusCode, 404, gone.body);

      // --- журнал активности -------------------------------------------------
      const pubActivity = await api(
        ctx,
        'GET',
        '/activity?entity_type=publication&limit=200',
      );
      assert.equal(pubActivity.statusCode, 200, pubActivity.body);
      const rows = pubActivity.json().data as Array<{
        action: string;
        entity_type: string;
        entity_title: string;
      }>;
      assert.ok(rows.length >= 5, `activity rows: ${rows.length}`);
      const actions = new Set(rows.map((r) => r.action));
      for (const action of ['created', 'updated', 'trashed', 'restored', 'deleted']) {
        assert.ok(actions.has(action), `нет действия ${action}: ${[...actions].join(',')}`);
      }
      assert.ok(rows.every((r) => r.entity_type === 'publication'));
      assert.ok(rows.some((r) => r.entity_title.includes('Документ')));

      const shelfActivity = await api(ctx, 'GET', '/activity?entity_type=shelf&limit=200');
      const shelfRows = shelfActivity.json().data as Array<{ action: string }>;
      assert.ok(shelfRows.some((r) => r.action === 'created'));
      assert.ok(shelfRows.some((r) => r.action === 'deleted'));
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('временная семантика кандидатов: новая мысль → кандидат, «расставить»/«скрыть»', async () => {
    const ctx = await buildRestContext();
    try {
      const type = createThoughtType(ctx.ndb, { name: 'Doc' }, ctx.adminId);
      seedThought(ctx.ndb, 'Раздел A', type.id, ctx.adminId);
      const created = await api(ctx, 'POST', '/publications', {
        payload: {
          title: 'Док',
          title_recipe: { type_ids: [type.id], sort: 'alpha', order: 'asc' },
        },
      });
      assert.equal(created.statusCode, 201, created.body);
      const pub = created.json().data as { id: string };

      const total = async (): Promise<number> =>
        (
          (await api(ctx, 'GET', `/publications/${pub.id}/candidates`)).json().data as {
            total: number;
          }
        ).total;

      // При создании всё отобранное принято — плашки нет.
      assert.equal(await total(), 0);

      // Новые мысли под отбор — кандидаты. Изменение мыслей — не мутация
      // публикации, кеш явно не сбрасывается (TTL по ADR 7adf7778), поэтому
      // для проверки «появления» сбрасываем окно дебаунса вручную.
      const b = seedThought(ctx.ndb, 'Раздел B', type.id, ctx.adminId);
      const d = seedThought(ctx.ndb, 'Раздел C', type.id, ctx.adminId);
      resetPublicationMembershipCache();
      assert.equal(await total(), 2);

      // «расставить» b гасит его индивидуально, d остаётся.
      const accepted = await api(ctx, 'POST', `/publications/${pub.id}/candidates/accept`, {
        payload: { thought_id: b },
      });
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.equal(await total(), 1);
      assert.deepEqual(
        (accepted.json().data as { items: Array<{ node_key: string }> }).items.map(
          (i) => i.node_key,
        ),
        [b],
      );

      // «скрыть» d — исключение, кандидатов не остаётся.
      const hidden = await api(ctx, 'POST', `/publications/${pub.id}/exclusions`, {
        payload: { thought_id: d },
      });
      assert.equal(hidden.statusCode, 200, hidden.body);
      assert.equal(await total(), 0);
      const assembly = await api(ctx, 'GET', `/publications/${pub.id}/assembly`);
      assert.equal(
        (assembly.json().data as { publication: { new_candidates: number } }).publication
          .new_candidates,
        0,
      );
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('общая корзина: публикации и полки в GET /trash и POST /trash/purge', async () => {
    const ctx = await buildRestContext();
    try {
      const pubFree = (await api(ctx, 'POST', '/publications', { payload: { title: 'Свободная' } }))
        .json().data as { id: string };
      const pubHeld = (await api(ctx, 'POST', '/publications', { payload: { title: 'Удерживаемая' } }))
        .json().data as { id: string };

      // Блокировка публикации: живая теневая строка в рабочем слое удерживает
      // её от физического удаления (та же проверка, что у DELETE).
      const layer = createLayer(ctx.ndb, {
        parentId: BASE_LAYER_ID,
        title: 'Удерживающий слой',
        createdBy: ctx.adminId,
      });
      setSessionLayer(ctx.ndb, ctx.adminId, 'held', layer.id, 0);
      const shadowEdit = await api(ctx, 'PATCH', `/publications/${pubHeld.id}`, {
        payload: { subtitle: 'правка слоя' },
        headers: { 'client-id': 'held' },
      });
      assert.equal(shadowEdit.statusCode, 200, shadowEdit.body);

      // Полка с публикацией (непустая — блокирована).
      const shelf = (await api(ctx, 'POST', '/shelves', { payload: { title: 'Корзинная полка' } }))
        .json().data as { id: string };
      const addItem = await api(ctx, 'POST', `/shelves/${shelf.id}/items`, {
        payload: { publication_id: pubHeld.id, position: 1 },
      });
      assert.equal(addItem.statusCode, 200, addItem.body);

      // Пометить всё: публикации и полку.
      assert.equal((await api(ctx, 'POST', `/publications/${pubFree.id}/trash`)).statusCode, 200);
      assert.equal((await api(ctx, 'POST', `/publications/${pubHeld.id}/trash`)).statusCode, 200);
      assert.equal((await api(ctx, 'POST', `/shelves/${shelf.id}/trash`)).statusCode, 200);
      // Помеченная полка исчезает из библиотеки; дефолтная «Полка» остаётся
      // (0.11.1, задача 8c2660e6) — ленивое создание не срабатывает.
      assert.equal((await api(ctx, 'GET', '/shelves')).json().meta.total, 1);

      // GET /trash показывает оба раздела и честный blocked.
      const trash = (await api(ctx, 'GET', '/trash')).json().data as {
        publications: Array<{
          id: string;
          blocked: boolean;
          blocking: { properties: number; layers: Array<{ id: string }> };
        }>;
        shelves: Array<{ id: string; blocked: boolean; blocking: { items: number } }>;
      };
      assert.equal(trash.publications.length, 2);
      assert.equal(trash.shelves.length, 1);
      const freeEntry = trash.publications.find((p) => p.id === pubFree.id);
      assert.equal(freeEntry?.blocked, false);
      const heldEntry = trash.publications.find((p) => p.id === pubHeld.id);
      assert.equal(heldEntry?.blocked, true);
      assert.ok((heldEntry?.blocking.layers.length ?? 0) >= 1);
      const shelfEntry = trash.shelves.find((s) => s.id === shelf.id);
      // Собственных блокировок у полки нет (состав удаляется каскадом,
      // публикации живы) — в основе она не заблокирована.
      assert.equal(shelfEntry?.blocked, false);
      assert.equal(shelfEntry?.blocking.items, 1);

      // Purge: свободная публикация и полка (вместе с составом) уходят;
      // удержанная слоем публикация пропускается без ошибки.
      const sweep = await api(ctx, 'POST', '/trash/purge');
      assert.equal(sweep.statusCode, 200, sweep.body);
      const counts = sweep.json().data as { purged: number; skipped: number };
      assert.equal(counts.purged, 2);
      assert.equal(counts.skipped, 1);
      assert.equal((await api(ctx, 'GET', `/publications/${pubFree.id}`)).statusCode, 404);
      assert.equal((await api(ctx, 'GET', `/publications/${pubHeld.id}`)).statusCode, 200);
      const trashAfter = (await api(ctx, 'GET', '/trash')).json().data as {
        publications: unknown[];
        shelves: unknown[];
      };
      assert.equal(trashAfter.publications.length, 1);
      assert.equal(trashAfter.shelves.length, 0);

      // Пометка и восстановление полки — отдельный цикл.
      const restoredShelf = (await api(ctx, 'POST', '/shelves', { payload: { title: 'Возврат' } }))
        .json().data as { id: string };
      assert.equal((await api(ctx, 'POST', `/shelves/${restoredShelf.id}/trash`)).statusCode, 200);
      assert.equal((await api(ctx, 'GET', '/shelves')).json().meta.total, 1);
      assert.equal(
        (await api(ctx, 'POST', `/shelves/${restoredShelf.id}/restore`)).statusCode,
        200,
      );
      assert.equal((await api(ctx, 'GET', '/shelves')).json().meta.total, 2);

      // Журнал: purge публикаций и полок оставил строки.
      const pubActivity = (await api(ctx, 'GET', '/activity?entity_type=publication&limit=200'))
        .json().data as Array<{ action: string }>;
      assert.ok(pubActivity.some((r) => r.action === 'deleted'));
      const shelfLog = (await api(ctx, 'GET', '/activity?entity_type=shelf&limit=200'))
        .json().data as Array<{ action: string }>;
      assert.ok(shelfLog.some((r) => r.action === 'trashed'));
      assert.ok(shelfLog.some((r) => r.action === 'restored'));
      assert.ok(shelfLog.some((r) => r.action === 'deleted'));
    } finally {
      await closeRestContext(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Real-time: WS-клиент получает события публикаций, видимость слоёв
// ---------------------------------------------------------------------------

interface Received {
  type?: unknown;
  data?: unknown;
}

/** Collect the next WS frame matching `predicate`, or resolve `null` on timeout. */
function nextEvent(
  ws: WebSocket,
  predicate: (m: Received) => boolean,
  timeoutMs: number,
): Promise<Received | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve(null);
    }, timeoutMs);
    const onMessage = (raw: RawData): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) return;
      const msg = parsed as Received;
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
  });
}

/** Open a WS client and await its `open`. */
async function connectWs(
  ctx: RestTestContext,
  port: number,
  clientId: string,
): Promise<WebSocket> {
  const url = new URL(`ws://127.0.0.1:${port}/api/v1/realtime`);
  url.searchParams.set('network_id', ctx.networkId);
  url.searchParams.set('client_id', clientId);
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${ctx.adminKey}`, 'client-id': clientId },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

describe('routes-publications: real-time и видимость слоёв', { skip }, () => {
  const sockets: WebSocket[] = [];
  afterEach(() => {
    for (const ws of sockets.splice(0)) ws.close();
  });

  it('публикация в основе доходит до подписчиков, в слое — только до своего слоя', async () => {
    const ctx = await buildRestContext();
    let port = 0;
    try {
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });
      port = (ctx.app.server.address() as AddressInfo).port;

      const layer = createLayer(ctx.ndb, {
        parentId: BASE_LAYER_ID,
        title: 'Слой публикаций',
        createdBy: ctx.adminId,
      });
      // Subscriber B sits in the layer; the writing session of B's layer uses a
      // different client id so echo suppression does not hide its own event.
      setSessionLayer(ctx.ndb, ctx.adminId, 'b', layer.id, 0);
      setSessionLayer(ctx.ndb, ctx.adminId, 'b2', layer.id, 0);

      const base = await connectWs(ctx, port, 'a');
      const layered = await connectWs(ctx, port, 'b');
      sockets.push(base, layered);

      // --- запись в РАБОЧЕМ слое --------------------------------------------
      const inLayer = await api(ctx, 'POST', '/publications', {
        payload: { title: 'Слоевая' },
        headers: { 'client-id': 'b2' },
      });
      assert.equal(inLayer.statusCode, 201, inLayer.body);
      const layeredEvent = await nextEvent(
        layered,
        (m) => m.type === 'publication.updated',
        5000,
      );
      assert.ok(layeredEvent !== null, 'подписчик слоя не получил событие');
      const baseMissed = await nextEvent(base, (m) => m.type === 'publication.updated', 400);
      assert.equal(baseMissed, null, 'подписчик основы не должен видеть запись слоя');

      // --- запись в ОСНОВЕ (сессия без слоя, чужой client id) ----------------
      const inBase = await api(ctx, 'POST', '/publications', {
        payload: { title: 'Основная' },
        headers: { 'client-id': 'a2' },
      });
      assert.equal(inBase.statusCode, 201, inBase.body);
      const basePubId = (inBase.json().data as { id: string }).id;
      const baseEvent = await nextEvent(base, (m) => m.type === 'publication.updated', 5000);
      assert.ok(baseEvent !== null, 'подписчик основы не получил событие основы');
      const layeredSeesBase = await nextEvent(
        layered,
        (m) => m.type === 'publication.updated',
        5000,
      );
      assert.ok(layeredSeesBase !== null, 'подписчик слоя не видит запись основы');

      // --- исключения: снятие в ОСНОВЕ физически удаляет строку, подписчик
      // слоя обязан узнать об этом (fallback visibleWhenMissing) ------------
      const added = await api(ctx, 'POST', `/publications/${basePubId}/exclusions`, {
        payload: { thought_id: ctx.homeId },
        headers: { 'client-id': 'a2' },
      });
      assert.equal(added.statusCode, 200, added.body);
      const changeAdd = await nextEvent(
        layered,
        (m) =>
          m.type === 'publication.exclusions.changed' &&
          (m.data as { excluded?: boolean }).excluded === true,
        5000,
      );
      assert.ok(changeAdd !== null, 'подписчик слоя не получил добавление исключения');
      const removed = await api(
        ctx,
        'DELETE',
        `/publications/${basePubId}/exclusions?thought_id=${ctx.homeId}`,
        { headers: { 'client-id': 'a2' } },
      );
      assert.equal(removed.statusCode, 200, removed.body);
      const changeRemove = await nextEvent(
        layered,
        (m) =>
          m.type === 'publication.exclusions.changed' &&
          (m.data as { excluded?: boolean }).excluded === false,
        5000,
      );
      assert.ok(changeRemove !== null, 'подписчик слоя не узнал о снятии исключения');

      // --- полка: событие shelf.updated -------------------------------------
      const shelf = await api(ctx, 'POST', '/shelves', {
        payload: { title: 'Событийная полка' },
        headers: { 'client-id': 'a2' },
      });
      assert.equal(shelf.statusCode, 201, shelf.body);
      const shelfEvent = await nextEvent(base, (m) => m.type === 'shelf.updated', 5000);
      assert.ok(shelfEvent !== null, 'подписчик не получил событие полки');
    } finally {
      for (const ws of sockets.splice(0)) ws.close();
      await closeRestContext(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Дефолтная полка «Полка» (0.11.1, задача 8c2660e6; карточка c80951ea v2)
// ---------------------------------------------------------------------------

describe('routes-publications: дефолтная полка «Полка» (8c2660e6)', { skip }, () => {
  const sockets: WebSocket[] = [];
  afterEach(() => {
    for (const ws of sockets.splice(0)) ws.close();
  });

  it('новая сеть создаётся с полкой «Полка» в основе', async () => {
    const ctx = await buildRestContext();
    try {
      const res = await api(ctx, 'GET', '/shelves');
      assert.equal(res.statusCode, 200, res.body);
      const rows = res.json().data as Array<{ id: string; title: string }>;
      assert.equal(rows.length, 1, res.body);
      assert.equal(rows[0]?.title, 'Полка');
      const row = ctx.ndb
        .prepare('SELECT layer_id FROM shelves WHERE id = ?')
        .get(rows[0]!.id) as { layer_id: string } | undefined;
      assert.equal(row?.layer_id, BASE_LAYER_ID, 'дефолтная полка живёт в основе');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('сеть без живых полок: GET создаёт «Полку»; удаление последней → пересоздание', async () => {
    const ctx = await buildRestContext();
    try {
      const first = (await api(ctx, 'GET', '/shelves')).json().data as Array<{
        id: string;
        title: string;
      }>;
      const firstId = first[0]!.id;
      assert.equal((await api(ctx, 'DELETE', `/shelves/${firstId}`)).statusCode, 204);
      const after = (await api(ctx, 'GET', '/shelves')).json().data as Array<{
        id: string;
        title: string;
      }>;
      assert.equal(after.length, 1, 'дефолтная полка создана заново');
      assert.equal(after[0]?.title, 'Полка');
      // id дефолтной полки детерминирован (8c2660e6): пересоздание даёт тот же
      // id; важно, что строка снова живая и доступна.
      assert.equal(after[0]?.id, firstId, 'пересоздана с детерминированным id');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('одноимённая полка в корзине оживляется, а не дублируется', async () => {
    const ctx = await buildRestContext();
    try {
      const first = (await api(ctx, 'GET', '/shelves')).json().data as Array<{ id: string }>;
      const id = first[0]!.id;
      assert.equal((await api(ctx, 'POST', `/shelves/${id}/trash`)).statusCode, 200);
      const after = (await api(ctx, 'GET', '/shelves')).json().data as Array<{
        id: string;
        title: string;
        marked_for_deletion: boolean;
      }>;
      assert.equal(after.length, 1, after as unknown as string);
      assert.equal(after[0]?.id, id, 'имя удержано корзиной — полка восстановлена');
      assert.equal(after[0]?.marked_for_deletion, false);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('ленивое создание идёт в основу даже когда сессия в рабочем слое', async () => {
    const ctx = await buildRestContext();
    try {
      const first = (await api(ctx, 'GET', '/shelves')).json().data as Array<{ id: string }>;
      await api(ctx, 'DELETE', `/shelves/${first[0]!.id}`);
      const layer = createLayer(ctx.ndb, {
        parentId: BASE_LAYER_ID,
        title: 'Слой полки',
        createdBy: ctx.adminId,
      });
      setSessionLayer(ctx.ndb, ctx.adminId, 'lay', layer.id, 0);
      const res = await api(ctx, 'GET', '/shelves', { headers: { 'client-id': 'lay' } });
      const rows = res.json().data as Array<{ id: string; title: string }>;
      assert.equal(rows.length, 1, res.body);
      assert.equal(rows[0]?.title, 'Полка');
      const row = ctx.ndb
        .prepare('SELECT layer_id FROM shelves WHERE id = ?')
        .get(rows[0]!.id) as { layer_id: string } | undefined;
      assert.equal(row?.layer_id, BASE_LAYER_ID, 'создана в основе, не в рабочем слое');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('ленивое создание шлёт подписчику событие shelf.updated', async () => {
    const ctx = await buildRestContext();
    let port = 0;
    try {
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });
      port = (ctx.app.server.address() as AddressInfo).port;
      const first = (await api(ctx, 'GET', '/shelves')).json().data as Array<{ id: string }>;
      assert.equal((await api(ctx, 'DELETE', `/shelves/${first[0]!.id}`)).statusCode, 204);

      const ws = await connectWs(ctx, port, 'sub-default');
      sockets.push(ws);
      const res = await api(ctx, 'GET', '/shelves', { headers: { 'client-id': 'lazy-requester' } });
      assert.equal(res.statusCode, 200, res.body);
      const event = await nextEvent(ws, (m) => m.type === 'shelf.updated', 5000);
      assert.ok(event !== null, 'подписчик не получил событие создания дефолтной полки');
    } finally {
      for (const ws of sockets.splice(0)) ws.close();
      await closeRestContext(ctx);
    }
  });
});
