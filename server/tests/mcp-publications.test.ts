/**
 * MCP-операции подсистемы «Публикации» через `etn.ops` (0.11.1, задача
 * 094653b6; свернуто из собственных инструментов, ранее 8f6857f8; карточки
 * cab597a8 управление, f236bb22 чтение, a610c091 экспорт).
 *
 * Покрытие DoD:
 *   * каждое из 25 действий вызывается агентом в сквозном сценарии: создание →
 *     чтение (list/get) → сборка → порядок → исключение → использование →
 *     экспорт (content и artifact) → пакетный экспорт → корзина/purge; полки
 *     (CRUD, состав, корзина);
 *   * assembly большой публикации (55 корневых разделов, 50+) отдаётся страницами;
 *   * валидация и сообщения ошибок идентичны REST (общие контракты и домен);
 *   * негативные ветки: фиктивный `node_key` → 422, не-кандидат → 422,
 *     постороннее исключение → 422, деструктив без `confirm` → VALIDATION_ERROR;
 *   * экспорт детерминирован (повторный md-экспорт байтово идентичен).
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID } from '@etn/shared';

import { createThoughtType } from '../src/domain/thought-type-service.js';
import { openNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  callOp,
  toolJson,
  toolText,
} from './mcp-helpers.js';
import { authHeaders, buildRestContext, closeRestContext } from './rest-helpers.js';

const skip = !nativeAvailable();
const NOW = '2024-01-01T00:00:00Z';

/** Seed a thought of `typeId` directly (no MCP round-trip). */
function seedThought(ndb: NetworkDb, title: string, typeId: string | null, user: string): string {
  const id = randomUUID();
  const nowMs = Date.now();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, created_by, updated_at,
                             updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), typeId, NOW, user, NOW, user, nowMs, nowMs);
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

/** Seed a permanent comment (section preamble / text). */
function seedComment(ndb: NetworkDb, thoughtId: string, bodyMd: string, user: string): void {
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, title, body_md, body_html,
                             valid_from, valid_to, version, created_at, updated_at, created_by, updated_by)
       VALUES (?, 'thought', ?, 'permanent', NULL, ?, '', ?, NULL, 1, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), thoughtId, bodyMd, NOW, NOW, NOW, user, user);
}

/** Call an `etn.ops` action and fail the test on an MCP-visible error. */
async function call(
  client: Awaited<ReturnType<typeof connectMcpClient>>['client'],
  action: string,
  params: Record<string, unknown>,
  confirm = false,
): Promise<unknown> {
  const result = await callOp(client, action, params, confirm);
  assert.equal(result.isError, undefined, toolText(result));
  return toolJson(result);
}

/** Decode a base64 `artifact` and assert it is a zip. */
function assertZipArtifact(artifact: unknown): Buffer {
  assert.equal(typeof artifact, 'string', 'artifact должен быть base64-строкой');
  const bytes = Buffer.from(artifact as string, 'base64');
  assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK', 'artifact — zip (сигнатура PK)');
  return bytes;
}

describe('MCP-публикации (etn.ops): сквозной сценарий', { skip }, () => {
  it('создание → чтение → сборка → порядок → исключение → использование → экспорт → корзина', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const type = createThoughtType(ndb, { name: 'Doc' }, ctx.adminId);
      const a = seedThought(ndb, 'Раздел A', type.id, ctx.adminId);
      const b = seedThought(ndb, 'Раздел B', type.id, ctx.adminId);
      seedLink(ndb, a, b, 0, ctx.adminId);
      seedComment(ndb, a, '# Предисловие\n\nВводный текст', ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // --- создание ------------------------------------------------------
        const created = (await call(handle.client, 'publications.create', {
          network_id: ctx.networkId,
          title: 'Документ',
          subtitle: 'Подзаголовок',
          summary_md: 'Краткое резюме',
          title_recipe: { type_ids: [type.id], sort: 'alpha', order: 'asc' },
          numbering_from: 1,
          numbering_to: 6,
        })) as { id: string; cover_kind: string; version: number; layer: { id: string } };
        assert.equal(created.cover_kind, 'none');
        assert.ok(created.layer.id, 'мутация несёт эхо слоя');
        const pubId = created.id;

        // --- список и карточка --------------------------------------------
        const list = (await call(handle.client, 'publications.list', {
          network_id: ctx.networkId,
        })) as { data: Array<{ id: string; title: string }>; meta: { total: number } };
        assert.equal(list.meta.total, 1);
        assert.equal(list.data[0]?.title, 'Документ');

        const card = (await call(handle.client, 'publications.get', {
          network_id: ctx.networkId,
          publication_id: pubId,
        })) as {
          data: {
            title: string;
            cover_kind: string;
            created_by: string;
            created_at: string;
            updated_by: string;
            updated_at: string;
            assembly_date: string | null;
          };
        };
        assert.equal(card.data.title, 'Документ');
        // Полная карточка (паритет REST GET /publications/{id}): метаданные —
        // автор/дата создания, последний редактор/дата изменения, дата сборки.
        assert.equal(card.data.cover_kind, 'none');
        assert.equal(card.data.created_by, ctx.adminId);
        assert.ok(card.data.created_at, 'created_at заполнен');
        assert.equal(card.data.updated_by, ctx.adminId);
        assert.ok(card.data.updated_at, 'updated_at заполнен');
        assert.equal(card.data.assembly_date, null);

        // --- правка --------------------------------------------------------
        const patched = (await call(handle.client, 'publications.update', {
          network_id: ctx.networkId,
          publication_id: pubId,
          subtitle: 'Новый подзаголовок',
          authorship: 'Автор',
        })) as { subtitle: string; authorship: string };
        assert.equal(patched.subtitle, 'Новый подзаголовок');
        assert.equal(patched.authorship, 'Автор');

        // --- сборка --------------------------------------------------------
        const assembly = (await call(handle.client, 'publications.assembly', {
          network_id: ctx.networkId,
          publication_id: pubId,
        })) as {
          data: {
            publication: { title: string };
            sections: Array<{ thought_id: string; node_key: string; children: unknown[] }>;
            meta: { page: number; total_roots: number; has_more: boolean };
          };
        };
        assert.equal(assembly.data.publication.title, 'Документ');
        assert.equal(assembly.data.meta.total_roots, 1);
        assert.equal(assembly.data.sections[0]?.thought_id, a);
        assert.equal(assembly.data.sections[0]?.children.length, 1, 'B — вложенный раздел A');
        const rootNodeKey = assembly.data.sections[0]!.node_key;

        // --- порядок (идемпотентный батч) ---------------------------------
        const ordered = (await call(handle.client, 'publications.order', {
          network_id: ctx.networkId,
          publication_id: pubId,
          items: [{ node_key: rootNodeKey, position: 5 }],
        })) as { items: Array<{ node_key: string; position: number }> };
        assert.equal(ordered.items[0]?.position, 5);

        // --- исключение и возврат -----------------------------------------
        const excluded = (await call(handle.client, 'publications.exclusions', {
          network_id: ctx.networkId,
          publication_id: pubId,
          thought_id: b,
        })) as { exclusions: Array<{ thought_id: string }> };
        assert.deepEqual(
          excluded.exclusions.map((e) => e.thought_id),
          [b],
        );
        const included = (await call(handle.client, 'publications.exclusions', {
          network_id: ctx.networkId,
          publication_id: pubId,
          thought_id: b,
          excluded: false,
        })) as { exclusions: Array<{ thought_id: string }> };
        assert.deepEqual(included.exclusions, []);

        // --- кандидаты: временная семантика и «расставить» ----------------
        // Новая мысль под рецепт вошла в отбор позже принятого состояния.
        const c = seedThought(ndb, 'Раздел C', type.id, ctx.adminId);
        const candidates = (await call(handle.client, 'publications.candidates', {
          network_id: ctx.networkId,
          publication_id: pubId,
        })) as {
          data: {
            items: Array<{ thought_id: string; title: string; breadcrumbs: string[] }>;
            total: number;
            limit: number;
            offset: number;
            has_more: boolean;
          };
        };
        assert.equal(candidates.data.total, 1);
        assert.equal(candidates.data.items[0]?.thought_id, c);
        // «Путь в дереве после вставки» (элемент интерфейса 43ec961f).
        assert.deepEqual(candidates.data.items[0]?.breadcrumbs, ['Раздел C']);

        // Действие «расставить»: гасит кандидата и ставит его в конец порядка.
        const accepted = (await call(handle.client, 'publications.accept', {
          network_id: ctx.networkId,
          publication_id: pubId,
          thought_id: c,
        })) as { items: Array<{ node_key: string }> };
        assert.equal(accepted.items[accepted.items.length - 1]?.node_key, c);
        const afterAccept = (await call(handle.client, 'publications.candidates', {
          network_id: ctx.networkId,
          publication_id: pubId,
        })) as { data: { total: number } };
        // Кеш сброшен мутацией, счётчик свежий.
        assert.equal(afterAccept.data.total, 0);

        // --- использование мысли ------------------------------------------
        const usage = (await call(handle.client, 'publications.usage', {
          network_id: ctx.networkId,
          thought_id: a,
        })) as { data: { items: Array<{ role: string; publication_id: string }>; total: number } };
        assert.ok(usage.data.items.some((i) => i.role === 'section' && i.publication_id === pubId));

        // --- пересборка ----------------------------------------------------
        const rebuilt = (await call(handle.client, 'publications.rebuild', {
          network_id: ctx.networkId,
          publication_id: pubId,
        })) as { assembly_date: string | null };
        assert.ok(rebuilt.assembly_date, 'rebuild проставляет дату сборки');

        // --- экспорт: content (md), детерминизм ---------------------------
        const md1 = (await call(handle.client, 'publications.export', {
          network_id: ctx.networkId,
          publication_id: pubId,
          format: 'md',
        })) as { content: string; filename: string; warnings: string[] };
        assert.match(md1.filename, /\.md$/);
        assert.ok(md1.content.length > 0);
        const md2 = (await call(handle.client, 'publications.export', {
          network_id: ctx.networkId,
          publication_id: pubId,
          format: 'md',
        })) as { content: string };
        assert.equal(md2.content, md1.content, 'повторный md-экспорт байтово идентичен');

        // --- экспорт: content (html) --------------------------------------
        const html = (await call(handle.client, 'publications.export', {
          network_id: ctx.networkId,
          publication_id: pubId,
          format: 'html',
        })) as { content: string; filename: string };
        assert.match(html.filename, /\.html$/);
        assert.match(html.content, /<html|<!DOCTYPE|<h1/i);

        // --- экспорт: artifact (base64 zip) -------------------------------
        const artifact = (await call(handle.client, 'publications.export', {
          network_id: ctx.networkId,
          publication_id: pubId,
          format: 'md',
          with_assets: true,
        })) as { artifact: string; filename: string; files: string[] };
        assert.match(artifact.filename, /\.zip$/);
        assertZipArtifact(artifact.artifact);
        assert.ok(artifact.files.some((f) => f.endsWith('.md')));

        // --- пакетный экспорт: md и html (обе ветки format) ----------------
        const batch = (await call(handle.client, 'publications.export_batch', {
          network_id: ctx.networkId,
          ids: [pubId],
          format: 'md',
        })) as { artifact: string; report: { publications: Array<{ status: string }> } };
        assertZipArtifact(batch.artifact);
        assert.equal(batch.report.publications[0]?.status, 'ok');

        const batchHtml = (await call(handle.client, 'publications.export_batch', {
          network_id: ctx.networkId,
          ids: [pubId],
          format: 'html',
        })) as { artifact: string; report: { publications: Array<{ status: string }> } };
        assertZipArtifact(batchHtml.artifact);
        assert.equal(batchHtml.report.publications[0]?.status, 'ok');

        // --- корзина и purge ----------------------------------------------
        const trashed = (await call(handle.client, 'publications.trash', {
          network_id: ctx.networkId,
          publication_id: pubId,
        })) as { marked_for_deletion: boolean };
        assert.equal(trashed.marked_for_deletion, true);
        const restored = (await call(handle.client, 'publications.restore', {
          network_id: ctx.networkId,
          publication_id: pubId,
        })) as { marked_for_deletion: boolean };
        assert.equal(restored.marked_for_deletion, false);
        const deleted = (await call(handle.client, 'publications.delete', {
          network_id: ctx.networkId,
          publication_id: pubId,
        }, true)) as { deleted: boolean; publication_id: string };
        assert.equal(deleted.deleted, true);
        const afterDelete = await callOp(handle.client, 'publications.get', {
          network_id: ctx.networkId,
          publication_id: pubId,
        });
        assert.equal(afterDelete.isError, true, 'после purge карточки нет');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('assembly большой публикации (55 корневых разделов) отдаётся страницами 20+20+15', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const type = createThoughtType(ndb, { name: 'Big' }, ctx.adminId);
      for (let i = 1; i <= 55; i += 1) {
        seedThought(ndb, `Раздел ${String(i).padStart(2, '0')}`, type.id, ctx.adminId);
      }

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const pub = (await call(handle.client, 'publications.create', {
          network_id: ctx.networkId,
          title: 'Большая',
          title_recipe: { type_ids: [type.id], sort: 'alpha', order: 'asc' },
        })) as { id: string };

        const page1 = (await call(handle.client, 'publications.assembly', {
          network_id: ctx.networkId,
          publication_id: pub.id,
          page: 1,
        })) as { data: { sections: unknown[]; meta: { page: number; per_page: number; total_roots: number; has_more: boolean } } };
        assert.equal(page1.data.meta.total_roots, 55);
        assert.equal(page1.data.meta.per_page, 20);
        assert.equal(page1.data.sections.length, 20);
        assert.equal(page1.data.meta.has_more, true);

        const page2 = (await call(handle.client, 'publications.assembly', {
          network_id: ctx.networkId,
          publication_id: pub.id,
          page: 2,
        })) as { data: { sections: unknown[]; meta: { has_more: boolean } } };
        assert.equal(page2.data.sections.length, 20);
        assert.equal(page2.data.meta.has_more, true);

        const page3 = (await call(handle.client, 'publications.assembly', {
          network_id: ctx.networkId,
          publication_id: pub.id,
          page: 3,
        })) as { data: { sections: unknown[]; meta: { has_more: boolean } } };
        assert.equal(page3.data.sections.length, 15);
        assert.equal(page3.data.meta.has_more, false);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('полки: CRUD, состав, корзина', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const type = createThoughtType(ndb, { name: 'Doc' }, ctx.adminId);
      seedThought(ndb, 'Раздел', type.id, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const pub = (await call(handle.client, 'publications.create', {
          network_id: ctx.networkId,
          title: 'Документ',
        })) as { id: string };

        const shelf = (await call(handle.client, 'shelves.create', {
          network_id: ctx.networkId,
          title: 'Моя полка',
        })) as { id: string; title: string; items: unknown[] };
        assert.equal(shelf.title, 'Моя полка');

        const list = (await call(handle.client, 'shelves.list', {
          network_id: ctx.networkId,
        })) as { data: Array<{ id: string; title: string }>; meta: { total: number } };
        // Сеть создаётся с дефолтной полкой «Полка» (0.11.1, задача 8c2660e6).
        assert.equal(list.meta.total, 2);
        assert.ok(list.data.some((s) => s.title === 'Полка'), 'есть дефолтная полка');
        assert.ok(list.data.some((s) => s.id === shelf.id), 'есть созданная полка');

        const renamed = (await call(handle.client, 'shelves.update', {
          network_id: ctx.networkId,
          shelf_id: shelf.id,
          title: 'Переименованная',
        })) as { title: string };
        assert.equal(renamed.title, 'Переименованная');

        const assigned = (await call(handle.client, 'shelves.assign', {
          network_id: ctx.networkId,
          shelf_id: shelf.id,
          publication_id: pub.id,
        })) as { items: Array<{ publication_id: string; position: number }> };
        assert.equal(assigned.items.length, 1);
        assert.equal(assigned.items[0]?.publication_id, pub.id);
        assert.equal(assigned.items[0]?.position, 1);

        const unassigned = (await call(handle.client, 'shelves.assign', {
          network_id: ctx.networkId,
          shelf_id: shelf.id,
          publication_id: pub.id,
          assigned: false,
        })) as { items: unknown[] };
        assert.equal(unassigned.items.length, 0);

        const trashed = (await call(handle.client, 'shelves.trash', {
          network_id: ctx.networkId,
          shelf_id: shelf.id,
        })) as { marked_for_deletion: boolean };
        assert.equal(trashed.marked_for_deletion, true);
        const hidden = (await call(handle.client, 'shelves.list', {
          network_id: ctx.networkId,
        })) as { data: unknown[] };
        assert.equal(hidden.data.length, 1, 'помеченная полка скрыта, дефолтная «Полка» остаётся');
        const restoredShelf = (await call(handle.client, 'shelves.restore', {
          network_id: ctx.networkId,
          shelf_id: shelf.id,
        })) as { marked_for_deletion: boolean };
        assert.equal(restoredShelf.marked_for_deletion, false);

        const deletedShelf = (await call(handle.client, 'shelves.delete', {
          network_id: ctx.networkId,
          shelf_id: shelf.id,
        }, true)) as { deleted: boolean };
        assert.equal(deletedShelf.deleted, true);
        const pubStillAlive = (await call(handle.client, 'publications.get', {
          network_id: ctx.networkId,
          publication_id: pub.id,
        })) as { data: { id: string } };
        assert.equal(pubStillAlive.data.id, pub.id, 'публикация не тронута удалением полки');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('shelves.list лениво создаёт дефолтную «Полку» в основе (8c2660e6)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const initial = (await call(handle.client, 'shelves.list', {
          network_id: ctx.networkId,
        })) as { data: Array<{ id: string; title: string }> };
        assert.equal(initial.data.length, 1);
        assert.equal(initial.data[0]?.title, 'Полка', 'новая сеть создана с «Полкой»');

        // Убираем полку физически — следующий список обязан создать её заново
        // (паритет с REST GET /shelves, карточка c80951ea v2).
        const deleted = (await call(handle.client, 'shelves.delete', {
          network_id: ctx.networkId,
          shelf_id: initial.data[0]!.id,
        }, true)) as { deleted: boolean };
        assert.equal(deleted.deleted, true);

        const recreated = (await call(handle.client, 'shelves.list', {
          network_id: ctx.networkId,
        })) as { data: Array<{ id: string; title: string }> };
        assert.equal(recreated.data.length, 1, 'дефолтная полка создана заново');
        assert.equal(recreated.data[0]?.title, 'Полка');
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const row = ndb
          .prepare('SELECT layer_id FROM shelves WHERE id = ?')
          .get(recreated.data[0]!.id) as { layer_id: string } | undefined;
        assert.equal(row?.layer_id, BASE_LAYER_ID, 'полка создана в основе');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('негативные ветки: node_key/кандидат/исключение → 422, деструктив без confirm → VALIDATION_ERROR', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const type = createThoughtType(ndb, { name: 'Doc' }, ctx.adminId);
      seedThought(ndb, 'Раздел A', type.id, ctx.adminId);
      const outside = seedThought(ndb, 'Посторонняя', null, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const pub = (await call(handle.client, 'publications.create', {
          network_id: ctx.networkId,
          title: 'Документ',
          title_recipe: { type_ids: [type.id], sort: 'alpha', order: 'asc' },
        })) as { id: string };

        // 1. Фиктивный node_key → 422 (узел не принадлежит публикации).
        const badOrder = await callOp(handle.client, 'publications.order', {
          network_id: ctx.networkId,
          publication_id: pub.id,
          items: [{ node_key: randomUUID(), position: 1 }],
        });
        assert.equal(badOrder.isError, true);
        assert.match(toolText(badOrder), /VALIDATION_ERROR/);
        assert.match(toolText(badOrder), /не принадлежит публикации/);

        // 2. Не-кандидат → 422 (в отборе публикации нет).
        const notCandidate = await callOp(handle.client, 'publications.accept', {
          network_id: ctx.networkId,
          publication_id: pub.id,
          thought_id: outside,
        });
        assert.equal(notCandidate.isError, true);
        assert.match(toolText(notCandidate), /VALIDATION_ERROR/);
        assert.match(toolText(notCandidate), /не является кандидатом/);

        // 3. Постороннее исключение → 422 (мысль не входит в публикацию).
        const badExclusion = await callOp(handle.client, 'publications.exclusions', {
          network_id: ctx.networkId,
          publication_id: pub.id,
          thought_id: outside,
        });
        assert.equal(badExclusion.isError, true);
        assert.match(toolText(badExclusion), /VALIDATION_ERROR/);
        assert.match(toolText(badExclusion), /не входит в публикацию/);

        // 4. Деструктив без confirm → VALIDATION_ERROR, домен не вызван.
        const noConfirm = await callOp(handle.client, 'publications.delete', {
          network_id: ctx.networkId,
          publication_id: pub.id,
        });
        assert.equal(noConfirm.isError, true);
        assert.match(toolText(noConfirm), /VALIDATION_ERROR/);
        assert.match(toolText(noConfirm), /требуется confirm: true/);
        // Публикация не тронута.
        const still = (await call(handle.client, 'publications.get', {
          network_id: ctx.networkId,
          publication_id: pub.id,
        })) as { data: { id: string } };
        assert.equal(still.data.id, pub.id);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('валидация и сообщения ошибок идентичны REST (общий контракт и домен)', async () => {
    const rest = await buildRestContext();
    const mcp = await buildMcpContext();
    try {
      const restApi = async (
        method: 'POST',
        path: string,
        payload: Record<string, unknown>,
      ): Promise<{ statusCode: number; body: string }> => {
        const res = await rest.app.inject({
          method,
          url: `/api/v1/networks/${rest.networkId}${path}`,
          headers: authHeaders(rest),
          payload,
        });
        return { statusCode: res.statusCode, body: res.body };
      };

      const handle = await connectMcpClient(mcp, mcp.adminKey);
      try {
        // 1. Обязательный title: оба фасада отвергают вход 422/VALIDATION_ERROR
        //    и дают ОДИН канонический текст «title обязателен.» (ошибка
        //    8577d41d: MCP раньше отдавал текст zod-схемы «должен быть
        //    строкой.» на отсутствующее поле).
        const restMissing = await restApi('POST', '/publications', {});
        assert.equal(restMissing.statusCode, 422);
        const restMissingMessage = /title обязателен\./.exec(restMissing.body)?.[0];
        assert.ok(restMissingMessage, `REST: ожидался канонический текст, факт: ${restMissing.body}`);
        const mcpMissing = await callOp(handle.client, 'publications.create', {
          network_id: mcp.networkId,
        });
        assert.equal(mcpMissing.isError, true);
        assert.match(toolText(mcpMissing), /ETN error \[VALIDATION_ERROR\].*title обязателен\./s);
        assert.ok(
          toolText(mcpMissing).includes(restMissingMessage),
          `MCP и REST дают одинаковый текст «${restMissingMessage}», факт: ${toolText(mcpMissing)}`,
        );

        // 2. Доменное правило обложки: и REST, и MCP — `cover_conflict`.
        const bothCovers = {
          title: 'X',
          cover_attachment_id: randomUUID(),
          cover_url: 'https://example.test/a.png',
        };
        const restCover = await restApi('POST', '/publications', bothCovers);
        assert.equal(restCover.statusCode, 422);
        const mcpCover = await callOp(handle.client, 'publications.create', {
          network_id: mcp.networkId,
          ...bothCovers,
        });
        assert.equal(mcpCover.isError, true);
        const restCoverMessage = /только один источник обложки[^"]*/.exec(restCover.body)?.[0];
        const mcpCoverMessage = /только один источник обложки[^\n]*/.exec(toolText(mcpCover))?.[0];
        assert.ok(restCoverMessage, 'REST вернул сообщение о конфликте обложки');
        assert.equal(mcpCoverMessage, restCoverMessage, 'сообщения обложки совпадают');

        // 3. Резюме с заголовками отвергнуто одинаково.
        const badSummary = { title: 'X', summary_md: '# Заголовок\n\nтекст' };
        const restSummary = await restApi('POST', '/publications', badSummary);
        assert.equal(restSummary.statusCode, 422);
        const mcpSummary = await callOp(handle.client, 'publications.create', {
          network_id: mcp.networkId,
          ...badSummary,
        });
        assert.equal(mcpSummary.isError, true);
        const restSummaryMessage =
          /резюме публикации не может содержать заголовки[^"]*/.exec(restSummary.body)?.[0];
        const mcpSummaryMessage =
          /резюме публикации не может содержать заголовки[^\n]*/.exec(toolText(mcpSummary))?.[0];
        assert.ok(restSummaryMessage);
        assert.equal(mcpSummaryMessage, restSummaryMessage);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(mcp);
      await closeRestContext(rest);
    }
  });

  it('deletion-check: MCP дословно повторяет REST (blocked/blocking)', async () => {
    const rest = await buildRestContext();
    const mcp = await buildMcpContext({
      dataDir: rest.dataDir,
      networkId: rest.networkId,
      systemDb: rest.sys,
    });
    try {
      const handle = await connectMcpClient(mcp, rest.adminKey);
      try {
        // Публикация и полка в ОДНОЙ сети: REST — эталон, MCP поверх той же.
        const created = await rest.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${rest.networkId}/publications`,
          headers: authHeaders(rest),
          payload: { title: 'Проверка удаления' },
        });
        assert.equal(created.statusCode, 201);
        const publicationId = (created.json() as { data: { id: string } }).data.id;

        const shelvesRes = await rest.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${rest.networkId}/shelves`,
          headers: authHeaders(rest),
        });
        assert.equal(shelvesRes.statusCode, 200);
        const shelfId = (shelvesRes.json() as { data: Array<{ id: string }> }).data[0]!.id;

        const restPub = await rest.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${rest.networkId}/publications/${publicationId}/deletion-check`,
          headers: authHeaders(rest),
        });
        assert.equal(restPub.statusCode, 200);
        const restPubData = (restPub.json() as { data: unknown }).data;
        const mcpPub = (await call(handle.client, 'publications.deletionCheck', {
          network_id: rest.networkId,
          publication_id: publicationId,
        })) as { data: unknown };
        assert.deepEqual(mcpPub.data, restPubData, 'публикация: MCP = REST (blocked/blocking)');

        const restShelf = await rest.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${rest.networkId}/shelves/${shelfId}/deletion-check`,
          headers: authHeaders(rest),
        });
        assert.equal(restShelf.statusCode, 200);
        const restShelfData = (restShelf.json() as { data: unknown }).data;
        const mcpShelf = (await call(handle.client, 'shelves.deletionCheck', {
          network_id: rest.networkId,
          shelf_id: shelfId,
        })) as { data: unknown };
        assert.deepEqual(mcpShelf.data, restShelfData, 'полка: MCP = REST (blocked/blocking)');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(mcp, {
        dataDir: rest.dataDir,
        networkId: rest.networkId,
        systemDb: rest.sys,
      });
      await closeRestContext(rest);
    }
  });

  it('публикация живёт в слое: правка в рабочем слое и эхо слоя', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const pub = (await call(handle.client, 'publications.create', {
          network_id: ctx.networkId,
          title: 'В слое',
        })) as { id: string };

        // Рабочий слой: действие `layers.create` через `etn.ops`.
        const layer = toolJson<{ id: string }>(
          await callOp(handle.client, 'layers.create', {
            network_id: ctx.networkId,
            title: 'L-pub',
          }),
        );
        // `etn.layers.select` — постоянный инструмент (не действие ops).
        const sel = await handle.client.callTool({
          name: 'etn.layers.select',
          arguments: { network_id: ctx.networkId, layer_id: layer.id },
        });
        assert.equal(sel.isError, undefined, toolText(sel));

        const patched = (await call(handle.client, 'publications.update', {
          network_id: ctx.networkId,
          publication_id: pub.id,
          subtitle: 'В слое',
        })) as { subtitle: string; layer: { id: string } };
        assert.equal(patched.layer.id, layer.id, 'эхо слоя — выбранный рабочий слой');
        assert.equal(patched.subtitle, 'В слое');

        // Purge в рабочем слое недоступен — только пометка (паритет с REST).
        // `confirm: true` пропускает деструктивный гейт; отказ даёт домен.
        const purge = await callOp(
          handle.client,
          'publications.delete',
          { network_id: ctx.networkId, publication_id: pub.id },
          true,
        );
        assert.equal(purge.isError, true, 'в рабочем слое физическое удаление запрещено');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
