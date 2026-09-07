/**
 * 0.7.2 — графовые признаки для MCP-фасада (задача 327be956):
 *   * `etn.thoughts.get.meta.link_stats` — профиль влияния мысли;
 *   * флаги `has_properties` / `has_comment` на рёбрах выборок
 *     `etn.thoughts.subgraph` и `etn.thoughts.neighbors`;
 *   * `etn.thoughts.neighbors { dir: "both" }` — оба направления одним вызовом;
 *   * `etn.links.get { view: "full" }` — свойства, постоянный комментарий,
 *     превью хронологии и вложения связи.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 *
 * Доменные операции типа «создать link_type / property / value» через MCP
 * недоступны — пользуемся прямыми вызовами сервисов по образцу
 * `mcp-names-and-truncation.test.ts` / `mcp-telemetry.test.ts`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';
import { openNetworkDb } from '../src/db/network-db.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import {
  createTypeProperty,
  setPropertyValue,
} from '../src/domain/property-service.js';

/** Insert a thought directly via SQL (тестам нужны быстрые соседи без MCP). */
function insertThought(
  ndb: ReturnType<typeof openNetworkDb>,
  title: string,
  typeId: string | null,
  adminId: string,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, icon, icon_kind,
                             icon_attachment_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, updated_at,
                             created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, NULL, 'emoji', NULL, 1, 0, 0,
               0, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), typeId, now, now, adminId, adminId,
         Date.now(), Date.now());
  return id;
}

/** Insert a directed link directly via SQL. */
function insertLink(
  ndb: ReturnType<typeof openNetworkDb>,
  sourceId: string,
  targetId: string,
  typeId: string | null,
  adminId: string,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO links (id, layer_id, source_id, target_id, type_id, color, style, width,
                          position, active, marked_for_deletion, version,
                          created_at, updated_at, created_by, updated_by,
                          created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0, 1, 0, 1,
               ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, sourceId, targetId, typeId, now, now, adminId, adminId,
         Date.now(), Date.now());
  return id;
}

// ===========================================================================
// meta.link_stats (etn.thoughts.get, требование описано в 85f18572)
// ===========================================================================

describe('etn.thoughts.get.meta.link_stats (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('счётчики по типам в обоих направлениях + справочник link_types', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      // Два типа связей с AI-описанием — попадёт в link_types.
      const depends = createLinkType(
        ndb,
        {
          name_forward: 'зависит от',
          name_reverse: 'используется в',
          description: 'жёсткая зависимость',
        },
        ctx.adminId,
      );
      const applies = createLinkType(
        ndb,
        {
          name_forward: 'применяется к',
          name_reverse: 'применяется от',
          description: 'применимость',
        },
        ctx.adminId,
      );

      // Фокус-мысль + 3 «зависит от» (входящие) + 2 «применяется к» (исходящие).
      const focus = insertThought(ndb, 'Фокус', null, ctx.adminId);
      for (let i = 0; i < 3; i += 1) {
        const dep = insertThought(ndb, `Зависимость ${i}`, null, ctx.adminId);
        insertLink(ndb, dep, focus, depends.id, ctx.adminId);
      }
      for (let i = 0; i < 2; i += 1) {
        const target = insertThought(ndb, `Цель ${i}`, null, ctx.adminId);
        insertLink(ndb, focus, target, applies.id, ctx.adminId);
      }

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const compact = toolJson<{
          meta: {
            link_stats: {
              stats: Array<{
                link_type_id: string | null;
                direction: 'in' | 'out';
                count: number;
              }>;
              link_types: Record<
                string,
                { id: string; name_forward: string; name_reverse: string; description: string | null }
              >;
            };
          };
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.get',
            arguments: {
              network_id: ctx.networkId,
              thought_id: focus,
              view: 'compact',
            },
          }),
        );
        // Два направления × 2 типа = до 4 групп; здесь ровно 2 (по одному типу
        // на каждое направление).
        assert.equal(compact.meta.link_stats.stats.length, 2);
        const depEntry = compact.meta.link_stats.stats.find(
          (s) => s.link_type_id === depends.id && s.direction === 'in',
        );
        const appEntry = compact.meta.link_stats.stats.find(
          (s) => s.link_type_id === applies.id && s.direction === 'out',
        );
        assert.ok(depEntry, 'нет группы «зависит от / in»');
        assert.equal(depEntry!.count, 3);
        assert.ok(appEntry, 'нет группы «применяется к / out»');
        assert.equal(appEntry!.count, 2);

        // Справочник — оба типа, с name_forward/reverse и AI-описанием.
        assert.equal(
          Object.keys(compact.meta.link_stats.link_types).length,
          2,
        );
        assert.deepEqual(
          compact.meta.link_stats.link_types[depends.id],
          {
            id: depends.id,
            name_forward: 'зависит от',
            name_reverse: 'используется в',
            description: 'жёсткая зависимость',
          },
        );
        assert.deepEqual(
          compact.meta.link_stats.link_types[applies.id],
          {
            id: applies.id,
            name_forward: 'применяется к',
            name_reverse: 'применяется от',
            description: 'применимость',
          },
        );

        // `view: "full"` — поле тоже присутствует.
        const full = toolJson<{ meta: { link_stats: unknown } }>(
          await handle.client.callTool({
            name: 'etn.thoughts.get',
            arguments: {
              network_id: ctx.networkId,
              thought_id: focus,
              view: 'full',
            },
          }),
        );
        assert.ok(full.meta.link_stats, 'meta.link_stats есть в view=full');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('связь без типа (link_type_id = null) попадает в отдельную группу', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const focus = insertThought(ndb, 'Фокус', null, ctx.adminId);
      // Нетипизированное входящее и нетипизированное исходящее.
      const dep = insertThought(ndb, 'Нетипизированная зависимость', null, ctx.adminId);
      insertLink(ndb, dep, focus, null, ctx.adminId);
      const target = insertThought(ndb, 'Нетипизированная цель', null, ctx.adminId);
      insertLink(ndb, focus, target, null, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const got = toolJson<{
          meta: {
            link_stats: {
              stats: Array<{ link_type_id: string | null; direction: string; count: number }>;
              link_types: Record<string, unknown>;
            };
          };
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.get',
            arguments: { network_id: ctx.networkId, thought_id: focus },
          }),
        );
        assert.equal(got.meta.link_stats.stats.length, 2);
        const inNull = got.meta.link_stats.stats.find(
          (s) => s.link_type_id === null && s.direction === 'in',
        );
        const outNull = got.meta.link_stats.stats.find(
          (s) => s.link_type_id === null && s.direction === 'out',
        );
        assert.ok(inNull, 'нет группы null/in');
        assert.equal(inNull!.count, 1);
        assert.ok(outNull, 'нет группы null/out');
        assert.equal(outNull!.count, 1);
        // Справочник пуст — типов нет.
        assert.deepEqual(got.meta.link_stats.link_types, {});
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

// ===========================================================================
// Флаги has_properties / has_comment на рёбрах выборок (8ab42ea8)
// ===========================================================================

describe('edge flags has_properties / has_comment (0.7.2, 8ab42ea8)', { skip: !nativeAvailable() }, () => {
  it('ребро без свойств и комментариев: оба флага false', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const a = insertThought(ndb, 'A', null, ctx.adminId);
      const b = insertThought(ndb, 'B', null, ctx.adminId);
      insertLink(ndb, a, b, null, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const sg = toolJson<{
          edges: Array<{ has_properties: boolean; has_comment: boolean }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.subgraph',
            arguments: {
              network_id: ctx.networkId,
              seed_ids: [a],
              radius: 1,
            },
          }),
        );
        assert.equal(sg.edges.length, 1);
        assert.equal(sg.edges[0]!.has_properties, false);
        assert.equal(sg.edges[0]!.has_comment, false);

        const nb = toolJson<{
          neighbors: Array<{ has_properties: boolean; has_comment: boolean; link_id: string }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.neighbors',
            arguments: {
              network_id: ctx.networkId,
              thought_id: a,
              dir: 'children',
            },
          }),
        );
        assert.equal(nb.neighbors.length, 1);
        assert.equal(nb.neighbors[0]!.has_properties, false);
        assert.equal(nb.neighbors[0]!.has_comment, false);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('ребро со значением свойства: has_properties=true', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      // Подключаем свойство «статус» к root link_type — благодаря L21 оно
      // наследуется любым пользовательским типом связи, и `setPropertyValue`
      // примет значение для любого линка в сети.
      createTypeProperty(
        ndb,
        'link_type',
        await getRootLinkTypeId(ndb),
        { key: 'статус', value_type: 'text' },
        ctx.adminId,
      );

      const lt = createLinkType(
        ndb,
        { name_forward: 'связан с', name_reverse: 'связан с' },
        ctx.adminId,
      );

      const a = insertThought(ndb, 'A', null, ctx.adminId);
      const b = insertThought(ndb, 'B', null, ctx.adminId);
      const linkId = insertLink(ndb, a, b, lt.id, ctx.adminId);
      setPropertyValue(ndb, 'link', linkId, 'статус', 'открыто', ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const sg = toolJson<{
          edges: Array<{ id: string; has_properties: boolean; has_comment: boolean }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.subgraph',
            arguments: {
              network_id: ctx.networkId,
              seed_ids: [a],
              radius: 1,
            },
          }),
        );
        assert.equal(sg.edges.length, 1);
        assert.equal(sg.edges[0]!.id, linkId);
        assert.equal(sg.edges[0]!.has_properties, true);
        assert.equal(sg.edges[0]!.has_comment, false);

        const nb = toolJson<{
          neighbors: Array<{ has_properties: boolean; link_id: string }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.neighbors',
            arguments: {
              network_id: ctx.networkId,
              thought_id: a,
              dir: 'children',
            },
          }),
        );
        assert.equal(nb.neighbors.length, 1);
        assert.equal(nb.neighbors[0]!.has_properties, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('ребро с постоянным комментарием: has_comment=true', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const a = insertThought(ndb, 'A', null, ctx.adminId);
      const b = insertThought(ndb, 'B', null, ctx.adminId);
      const linkId = insertLink(ndb, a, b, null, ctx.adminId);
      await handleUpsertComment(ctx, { owner_type: 'link', owner_id: linkId, kind: 'permanent', body_md: 'note' });

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const sg = toolJson<{
          edges: Array<{ id: string; has_properties: boolean; has_comment: boolean }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.subgraph',
            arguments: {
              network_id: ctx.networkId,
              seed_ids: [a],
              radius: 1,
            },
          }),
        );
        assert.equal(sg.edges.length, 1);
        assert.equal(sg.edges[0]!.has_properties, false);
        assert.equal(sg.edges[0]!.has_comment, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('ребро только с хронологическим комментарием: has_comment=true', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const a = insertThought(ndb, 'A', null, ctx.adminId);
      const b = insertThought(ndb, 'B', null, ctx.adminId);
      const linkId = insertLink(ndb, a, b, null, ctx.adminId);
      const today = new Date().toISOString().slice(0, 10);
      await handleUpsertComment(ctx, {
        owner_type: 'link',
        owner_id: linkId,
        kind: 'chronological',
        body_md: 'хроно',
        valid_from: today,
      });

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const sg = toolJson<{
          edges: Array<{ has_comment: boolean }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.subgraph',
            arguments: {
              network_id: ctx.networkId,
              seed_ids: [a],
              radius: 1,
            },
          }),
        );
        assert.equal(sg.edges.length, 1);
        assert.equal(sg.edges[0]!.has_comment, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

// ===========================================================================
// dir: 'both' (etn.thoughts.neighbors)
// ===========================================================================

describe('etn.thoughts.neighbors dir=both (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('2 родителя + 3 ребёнка = 5 записей с direction in/out и корректными total/truncated', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const focus = insertThought(ndb, 'Фокус', null, ctx.adminId);
      for (let i = 0; i < 2; i += 1) {
        const p = insertThought(ndb, `Родитель ${i}`, null, ctx.adminId);
        insertLink(ndb, p, focus, null, ctx.adminId);
      }
      for (let i = 0; i < 3; i += 1) {
        const c = insertThought(ndb, `Ребёнок ${i}`, null, ctx.adminId);
        insertLink(ndb, focus, c, null, ctx.adminId);
      }

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const got = toolJson<{
          dir: string;
          total: number;
          truncated: boolean;
          neighbors: Array<{ id: string; title: string; direction: 'in' | 'out'; link_id: string }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.neighbors',
            arguments: {
              network_id: ctx.networkId,
              thought_id: focus,
              dir: 'both',
            },
          }),
        );
        assert.equal(got.dir, 'both');
        assert.equal(got.total, 5);
        assert.equal(got.truncated, false);
        assert.equal(got.neighbors.length, 5);
        const ins = got.neighbors.filter((n) => n.direction === 'in');
        const outs = got.neighbors.filter((n) => n.direction === 'out');
        assert.equal(ins.length, 2);
        assert.equal(outs.length, 3);
        // link_id уникален у каждой записи (5 разных рёбер).
        const linkIds = new Set(got.neighbors.map((n) => n.link_id));
        assert.equal(linkIds.size, 5);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('link_types и thought_types включают использованные типы', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const lt = createLinkType(
        ndb,
        { name_forward: 'с', name_reverse: 'с' },
        ctx.adminId,
      );
      const focus = insertThought(ndb, 'Фокус', null, ctx.adminId);
      const p = insertThought(ndb, 'P', null, ctx.adminId);
      const c = insertThought(ndb, 'C', null, ctx.adminId);
      insertLink(ndb, p, focus, lt.id, ctx.adminId);
      insertLink(ndb, focus, c, null, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const got = toolJson<{
          link_types: Record<string, unknown>;
          thought_types: Record<string, unknown>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.neighbors',
            arguments: {
              network_id: ctx.networkId,
              thought_id: focus,
              dir: 'both',
            },
          }),
        );
        assert.ok(got.link_types[lt.id], 'link_types содержит типизированную связь');
        // У нетипизированной нет ключа — справочник компактный.
        assert.equal(Object.keys(got.link_types).length, 1);
        assert.ok(got.thought_types === undefined || Object.keys(got.thought_types).length === 0);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

// ===========================================================================
// etn.links.get { view: 'full' }
// ===========================================================================

describe('etn.links.get view (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('view: compact — без properties/permanent/chrono/attachments', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const a = insertThought(ndb, 'A', null, ctx.adminId);
      const b = insertThought(ndb, 'B', null, ctx.adminId);
      const linkId = insertLink(ndb, a, b, null, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const got = toolJson<Record<string, unknown>>(
          await handle.client.callTool({
            name: 'etn.links.get',
            arguments: {
              network_id: ctx.networkId,
              link_id: linkId,
              view: 'compact',
            },
          }),
        );
        assert.equal(got.id, linkId);
        assert.equal(got.properties, undefined);
        assert.equal(got.permanent, undefined);
        assert.equal(got.chrono, undefined);
        assert.equal(got.attachments, undefined);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('view: full — пустые массивы/null для связи без наполнения', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const a = insertThought(ndb, 'A', null, ctx.adminId);
      const b = insertThought(ndb, 'B', null, ctx.adminId);
      const linkId = insertLink(ndb, a, b, null, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const got = toolJson<{
          id: string;
          properties: unknown[];
          permanent: null;
          chrono: {
            permanent: null;
            chronological: { entries: unknown[]; total: number; returned: number; truncated: boolean };
          };
          attachments: unknown[];
        }>(
          await handle.client.callTool({
            name: 'etn.links.get',
            arguments: {
              network_id: ctx.networkId,
              link_id: linkId,
              view: 'full',
            },
          }),
        );
        assert.equal(got.id, linkId);
        assert.deepEqual(got.properties, []);
        assert.equal(got.permanent, null);
        assert.equal(got.chrono.permanent, null);
        assert.deepEqual(got.chrono.chronological.entries, []);
        assert.equal(got.chrono.chronological.total, 0);
        assert.equal(got.chrono.chronological.returned, 0);
        assert.deepEqual(got.attachments, []);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('view: full — все блоки заполнены для связи с наполнением', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const rootLt = await getRootLinkTypeId(ndb);
      // Подключаем «статус» к root link_type — далее наследуется любым
      // пользовательским link_type (L21).
      createTypeProperty(
        ndb,
        'link_type',
        rootLt,
        { key: 'статус', value_type: 'text' },
        ctx.adminId,
      );
      const lt = createLinkType(
        ndb,
        { name_forward: 'связь', name_reverse: 'связь' },
        ctx.adminId,
      );
      const a = insertThought(ndb, 'A', null, ctx.adminId);
      const b = insertThought(ndb, 'B', null, ctx.adminId);
      const linkId = insertLink(ndb, a, b, lt.id, ctx.adminId);
      setPropertyValue(ndb, 'link', linkId, 'статус', 'сделано', ctx.adminId);
      await handleUpsertComment(ctx, {
        owner_type: 'link',
        owner_id: linkId,
        kind: 'permanent',
        body_md: 'постоянный',
      });
      await handleUpsertAttachment(ctx, {
        owner_type: 'link',
        owner_id: linkId,
        kind: 'url',
        url: 'https://example.com/spec',
        title: 'спека',
      });

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const got = toolJson<{
          id: string;
          properties: Array<{ property_name: string; value: unknown }>;
          permanent: { body_md: string } | null;
          chrono: { permanent: { body_md: string } | null; chronological: { entries: unknown[]; total: number } };
          attachments: Array<{ url: string; title: string | null }>;
        }>(
          await handle.client.callTool({
            name: 'etn.links.get',
            arguments: {
              network_id: ctx.networkId,
              link_id: linkId,
              view: 'full',
            },
          }),
        );
        assert.equal(got.id, linkId);
        assert.equal(got.properties.length, 1);
        assert.equal(got.properties[0]!.property_name, 'статус');
        assert.equal(got.properties[0]!.value, 'сделано');
        assert.ok(got.permanent, 'permanent не null');
        assert.equal(got.permanent!.body_md, 'постоянный');
        assert.ok(got.chrono.permanent, 'chrono.permanent не null');
        assert.equal(got.chrono.permanent!.body_md, 'постоянный');
        assert.equal(got.chrono.chronological.total, 0);
        assert.equal(got.attachments.length, 1);
        assert.equal(got.attachments[0]!.url, 'https://example.com/spec');
        assert.equal(got.attachments[0]!.title, 'спека');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Id корневого link_type — у сети всегда ровно один (L21). */
async function getRootLinkTypeId(ndb: ReturnType<typeof openNetworkDb>): Promise<string> {
  const row = ndb
    .prepare('SELECT id FROM link_types_v WHERE is_root = 1 LIMIT 1')
    .get() as { id: string } | undefined;
  assert.ok(row, 'корневой link_type не найден');
  return row.id;
}

/** Дёрнуть `etn.comments.upsert` через прямой open сети + клиента. */
async function handleUpsertComment(
  ctx: Awaited<ReturnType<typeof buildMcpContext>>,
  args: {
    owner_type: 'thought' | 'link';
    owner_id: string;
    kind: 'permanent' | 'chronological';
    body_md: string;
    valid_from?: string;
  },
): Promise<void> {
  const handle = await connectMcpClient(ctx, ctx.adminKey);
  try {
    const result = await handle.client.callTool({
      name: 'etn.comments.upsert',
      arguments: {
        network_id: ctx.networkId,
        owner_type: args.owner_type,
        owner_id: args.owner_id,
        kind: args.kind,
        body_md: args.body_md,
        ...(args.valid_from ? { valid_from: args.valid_from } : {}),
      },
    });
    if (result.isError) {
      throw new Error(`etn.comments.upsert failed: ${toolText(result)}`);
    }
  } finally {
    await handle.close();
  }
}

/** Дёрнуть `etn.attachments.add` через клиента. */
async function handleUpsertAttachment(
  ctx: Awaited<ReturnType<typeof buildMcpContext>>,
  args: {
    owner_type: 'thought' | 'link';
    owner_id: string;
    kind: 'url' | 'file';
    url?: string;
    file_path?: string;
    title?: string;
  },
): Promise<void> {
  const handle = await connectMcpClient(ctx, ctx.adminKey);
  try {
    const result = await handle.client.callTool({
      name: 'etn.attachments.add',
      arguments: {
        network_id: ctx.networkId,
        owner_type: args.owner_type,
        owner_id: args.owner_id,
        kind: args.kind,
        ...(args.url ? { url: args.url } : {}),
        ...(args.file_path ? { file_path: args.file_path } : {}),
        ...(args.title ? { title: args.title } : {}),
      },
    });
    if (result.isError) {
      throw new Error(`etn.attachments.add failed: ${toolText(result)}`);
    }
  } finally {
    await handle.close();
  }
}
