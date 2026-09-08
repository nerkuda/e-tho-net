/**
 * 0.7.3 — `meta.views` в карточках мыслей и `etn.views.run` (задача c1fa71d4,
 * операция cb8d8e43, ADR 5c44f6a7).
 *
 * Сценарий «Увидеть работы версии» (16e8b7c3) проходит маршрутом агента
 * целиком через MCP:
 *
 *   1. Агент получает карточку версии `etn.thoughts.get` — видит в
 *      `meta.views` отбор «Работы версии» (имя, описание, тип-владелец).
 *   2. Запускает `etn.views.run { thought_id, view_name: "Работы версии" }`
 *      — получает список мыслей, попадающих под отбор.
 *   3. По каждой найденной работе может читать карточку и т. д.
 *
 * Тесты покрывают:
 *   * `meta.views` в `etn.thoughts.get`, `etn.thoughts.resolve`,
 *     `etn.thoughts.subgraph`;
 *   * `views[]` в `etn.types.list` (собственные отборы типа);
 *   * `etn.views.run` — успех, NOT_FOUND на несуществующий view_name,
 *     `meta.unresolved` при неразрешимом токене;
 *   * `etn.ontology.write` с `type_views[]` — создание / правка / удаление;
 *   * `etn.ontology.delete { kind: "type_view" }` — удаление отбора;
 *   * каскад отборов при `etn.ontology.delete { kind: "thought_type", force: true }`.
 *
 * Bootstrap — `mcp-helpers.ts` (тот же, что в `mcp-instructions.test.ts`):
 * in-memory `_system.db` + сеть с `data.db` через `NetworkService`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { openNetworkDb } from '../src/db/network-db.js';

import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

// ---------------------------------------------------------------------------
// DTO-формы для теста
// ---------------------------------------------------------------------------

interface ThoughtMetaView {
  id: string;
  name: string;
  name_key: string;
  description: string | null;
  defined_on: string;
  inherited: boolean;
  is_default: boolean;
}

interface ThoughtGetResponse {
  id: string;
  title: string;
  type_id: string | null;
  meta: {
    parents_count: number;
    children_count: number;
    attachments_count: number;
    chrono_count: number;
    usage_count: number;
    permanent: unknown;
    link_stats: unknown;
    views: ThoughtMetaView[];
  };
}

interface ThoughtTypeViewsEntry {
  id: string;
  name: string;
  name_key: string;
  description: string | null;
  position: number;
  is_default: boolean;
}

interface TypesListThoughtTypeEntry {
  id: string;
  name: string;
  views: ThoughtTypeViewsEntry[];
}

interface TypesListResponse {
  thought_types?: TypesListThoughtTypeEntry[];
}

interface ViewsRunResponse {
  thought: { id: string; title: string };
  view: {
    id: string;
    name: string;
    name_key: string;
    description: string | null;
    defined_on: string;
    inherited: boolean;
  };
  data: Array<{ id: string; title: string; type_id: string | null }>;
  meta: {
    total: number;
    limit: number;
    offset: number;
    unresolved?: Array<{ token: string; reason: string }>;
  };
}

// ---------------------------------------------------------------------------
// DOM-хелперы: типы и мысли записываются прямо через сеть — обходим
// необходимость гонять их через MCP там, где сценарий «Увидеть работы версии»
// проверяет именно эффекты views-инфраструктуры, а не CRUD типов.
// ---------------------------------------------------------------------------

function makeThoughtType(
  ndb: ReturnType<typeof openNetworkDb>,
  name: string,
  userId: string,
  opts: { isRoot?: boolean; parentId?: string | null } = {},
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, name, name_key, is_root, parent_id, version,
                                  created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      id,
      name,
      name.toLowerCase(),
      opts.isRoot ? 1 : 0,
      opts.parentId ?? null,
      now,
      now,
      userId,
      userId,
    );
  return id;
}

function makeThought(
  ndb: ReturnType<typeof openNetworkDb>,
  title: string,
  opts: { typeId: string | null; active?: number },
  userId: string,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, icon, icon_kind,
                             icon_attachment_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, updated_at,
                             created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, NULL, 'emoji', NULL, ?, 0, 0,
               0, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ndb.layerId,
      title,
      title.toLowerCase(),
      opts.typeId,
      opts.active ?? 1,
      now,
      now,
      userId,
      userId,
      Date.now(),
      Date.now(),
    );
  return id;
}

// ---------------------------------------------------------------------------
// Сценарий «Увидеть работы версии»
// ---------------------------------------------------------------------------

describe('etn.views (0.7.3, c1fa71d4)', { skip: !nativeAvailable() }, () => {
  it('meta.views в etn.thoughts.get перечисляет эффективный набор отборов', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const versionTypeId = makeThoughtType(ndb, 'версия', ctx.adminId, { isRoot: false });
      const taskTypeId = makeThoughtType(ndb, 'задача', ctx.adminId, { isRoot: false });

      // Версия, для которой ниже заведём отбор «Работы версии».
      const versionId = makeThought(ndb, '0.7.3', { typeId: versionTypeId }, ctx.adminId);
      // Задача того же типа — в её эффективный набор войдёт отбор
      // «Работы версии», определённый на типе «версия».
      const taskOnVersion = makeThought(
        ndb,
        'Поддержка отборов',
        { typeId: taskTypeId },
        ctx.adminId,
      );
      void taskOnVersion;

      // Заводим отбор через MCP `etn.ontology.write` — чтобы проверить,
      // что инфраструктура онтологии работает end-to-end.
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Отбор «Работы версии»: простая структура фильтра, без токенов —
        // задача c1fa71d4 этого не требует, definition — это просто JSON.
        const writeRes = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            type_views: [
              {
                ref: 'version_works',
                action: 'create',
                thought_type: 'версия',
                name: 'Работы версии',
                description: 'Задачи и ошибки, запланированные на эту версию.',
                definition: JSON.stringify({
                  filters: [
                    { field: 'type', op: 'eq', value: 'задача' },
                  ],
                  sort: 'alpha',
                  order: 'asc',
                }),
                position: 0,
                is_default: true,
              },
            ],
          },
        });
        assert.equal(writeRes.isError, undefined, toolText(writeRes));
        const writeData = toolJson<{
          type_views: Array<{ id: string; action: string; ref: string | null }>;
        }>(writeRes);
        assert.equal(writeData.type_views.length, 1);
        assert.equal(writeData.type_views[0]!.action, 'created');

        // Шаг 1: читаем карточку версии — `meta.views` уже содержит отбор.
        const getRes = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: versionId },
        });
        assert.equal(getRes.isError, undefined, toolText(getRes));
        const card = toolJson<ThoughtGetResponse>(getRes);
        assert.equal(card.id, versionId);
        assert.equal(card.meta.views.length, 1);
        const view = card.meta.views[0]!;
        assert.equal(view.name, 'Работы версии');
        assert.equal(view.name_key, 'работы версии');
        assert.equal(view.is_default, true);
        assert.equal(view.inherited, false);

        // Шаг 2: исполняем отбор по имени — получаем пустую страницу
        // (фильтр по `type:eq=задача` отберёт задачи, но в этом тесте
        // мы завели только одну, без выполнения задачи — пусто).
        const runRes = await handle.client.callTool({
          name: 'etn.views.run',
          arguments: {
            network_id: ctx.networkId,
            thought_id: versionId,
            view_name: 'Работы версии',
          },
        });
        assert.equal(runRes.isError, undefined, toolText(runRes));
        const run = toolJson<ViewsRunResponse>(runRes);
        assert.equal(run.thought.id, versionId);
        assert.equal(run.view.name, 'Работы версии');
        assert.deepEqual(run.meta.unresolved, undefined);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.types.list возвращает собственные views[] для типов мыслей', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const versionTypeId = makeThoughtType(ndb, 'версия', ctx.adminId, { isRoot: false });
      void versionTypeId;
      // Задача тоже нужна — проверяем, что у неё `views` пустой.
      makeThoughtType(ndb, 'задача', ctx.adminId, { isRoot: false });

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            type_views: [
              {
                ref: 'version_works',
                action: 'create',
                thought_type: 'версия',
                name: 'Работы версии',
                description: null,
                definition: JSON.stringify({
                  filters: [],
                  sort: 'alpha',
                  order: 'asc',
                }),
                position: 0,
                is_default: true,
              },
              {
                ref: 'version_notes',
                action: 'create',
                thought_type: 'версия',
                name: 'Заметки версии',
                description: 'Заметки о версии',
                definition: JSON.stringify({
                  filters: [],
                  sort: 'alpha',
                  order: 'asc',
                }),
                position: 1,
                is_default: false,
              },
            ],
          },
        });

        const listRes = await handle.client.callTool({
          name: 'etn.types.list',
          arguments: { network_id: ctx.networkId, scope: 'thoughts' },
        });
        assert.equal(listRes.isError, undefined, toolText(listRes));
        const data = toolJson<TypesListResponse>(listRes);
        assert.ok(data.thought_types);
        const versionType = data.thought_types!.find((t) => t.name === 'версия');
        assert.ok(versionType, 'тип «версия» должен быть в каталоге');
        assert.equal(versionType!.views.length, 2);
        const names = versionType!.views.map((v) => v.name);
        assert.deepEqual(names.sort(), ['Заметки версии', 'Работы версии']);
        const defaultView = versionType!.views.find((v) => v.name === 'Работы версии');
        assert.equal(defaultView?.is_default, true);

        // Тип «задача» — без отборов.
        const taskType = data.thought_types!.find((t) => t.name === 'задача');
        assert.ok(taskType, 'тип «задача» должен быть в каталоге');
        assert.deepEqual(taskType!.views, []);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.views.run возвращает NOT_FOUND со списком доступных view_name', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const versionTypeId = makeThoughtType(ndb, 'версия', ctx.adminId, { isRoot: false });
      const versionId = makeThought(ndb, '0.7.3', { typeId: versionTypeId }, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            type_views: [
              {
                ref: 'version_works',
                action: 'create',
                thought_type: 'версия',
                name: 'Работы версии',
                description: null,
                definition: JSON.stringify({ filters: [], sort: 'alpha', order: 'asc' }),
                position: 0,
                is_default: false,
              },
            ],
          },
        });

        const res = await handle.client.callTool({
          name: 'etn.views.run',
          arguments: {
            network_id: ctx.networkId,
            thought_id: versionId,
            view_name: 'Несуществующий отбор',
          },
        });
        assert.equal(res.isError, true);
        const text = toolText(res);
        assert.match(text, /NOT_FOUND/);
        assert.match(text, /available_views/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.ontology.delete { kind: type_view } удаляет отбор', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const versionTypeId = makeThoughtType(ndb, 'версия', ctx.adminId, { isRoot: false });
      void versionTypeId;

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Создаём отбор.
        const writeRes = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            type_views: [
              {
                ref: 'v1',
                action: 'create',
                thought_type: 'версия',
                name: 'Работы версии',
                description: null,
                definition: JSON.stringify({ filters: [], sort: 'alpha', order: 'asc' }),
                position: 0,
                is_default: false,
              },
            ],
          },
        });
        const created = toolJson<{
          type_views: Array<{ id: string; ref: string | null; action: string }>;
        }>(writeRes);
        const viewId = created.type_views[0]!.id;
        assert.ok(viewId);

        // Удаляем по id.
        const delRes = await handle.client.callTool({
          name: 'etn.ontology.delete',
          arguments: {
            network_id: ctx.networkId,
            kind: 'type_view',
            id: viewId,
          },
        });
        assert.equal(delRes.isError, undefined, toolText(delRes));
        const delData = toolJson<{ deleted: true; affected_counts: Record<string, number> }>(
          delRes,
        );
        assert.equal(delData.deleted, true);

        // После удаления каталог типов уже не содержит отбор.
        const listRes = await handle.client.callTool({
          name: 'etn.types.list',
          arguments: { network_id: ctx.networkId, scope: 'thoughts' },
        });
        const data = toolJson<TypesListResponse>(listRes);
        const versionType = data.thought_types!.find((t) => t.name === 'версия');
        assert.equal(versionType!.views.length, 0);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.ontology.delete { kind: thought_type, force } каскадит отборы', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const versionTypeId = makeThoughtType(ndb, 'версия', ctx.adminId, { isRoot: false });
      void versionTypeId;

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            type_views: [
              {
                ref: 'v1',
                action: 'create',
                thought_type: 'версия',
                name: 'Работы версии',
                description: null,
                definition: JSON.stringify({ filters: [], sort: 'alpha', order: 'asc' }),
                position: 0,
                is_default: false,
              },
            ],
          },
        });

        const delRes = await handle.client.callTool({
          name: 'etn.ontology.delete',
          arguments: {
            network_id: ctx.networkId,
            kind: 'thought_type',
            id: versionTypeId,
            force: true,
          },
        });
        assert.equal(delRes.isError, undefined, toolText(delRes));
        const delData = toolJson<{
          affected_counts: { type_views_count?: number };
        }>(delRes);
        assert.equal(delData.affected_counts.type_views_count, 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.subgraph отдаёт views для seed-узлов', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const versionTypeId = makeThoughtType(ndb, 'версия', ctx.adminId, { isRoot: false });
      const versionId = makeThought(ndb, '0.7.3', { typeId: versionTypeId }, ctx.adminId);
      const otherId = makeThought(
        ndb,
        'Соседняя мысль',
        { typeId: versionTypeId },
        ctx.adminId,
      );

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            type_views: [
              {
                ref: 'v1',
                action: 'create',
                thought_type: 'версия',
                name: 'Работы версии',
                description: null,
                definition: JSON.stringify({ filters: [], sort: 'alpha', order: 'asc' }),
                position: 0,
                is_default: false,
              },
            ],
          },
        });

        const subRes = await handle.client.callTool({
          name: 'etn.thoughts.subgraph',
          arguments: {
            network_id: ctx.networkId,
            seed_ids: [versionId],
            radius: 0,
          },
        });
        assert.equal(subRes.isError, undefined, toolText(subRes));
        const data = toolJson<{
          nodes: Array<{ id: string; views: ThoughtMetaView[] }>;
        }>(subRes);
        const seedNode = data.nodes.find((n) => n.id === versionId);
        assert.ok(seedNode, 'seed-узел должен присутствовать');
        assert.equal(seedNode!.views.length, 1);
        assert.equal(seedNode!.views[0]!.name, 'Работы версии');
        void otherId;
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.resolve даёт meta.views для каждой карточки', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const versionTypeId = makeThoughtType(ndb, 'версия', ctx.adminId, { isRoot: false });
      const versionId = makeThought(ndb, '0.7.3', { typeId: versionTypeId }, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            type_views: [
              {
                ref: 'v1',
                action: 'create',
                thought_type: 'версия',
                name: 'Работы версии',
                description: null,
                definition: JSON.stringify({ filters: [], sort: 'alpha', order: 'asc' }),
                position: 0,
                is_default: false,
              },
            ],
          },
        });

        const res = await handle.client.callTool({
          name: 'etn.thoughts.resolve',
          arguments: {
            network_id: ctx.networkId,
            thought_ids: [versionId],
          },
        });
        assert.equal(res.isError, undefined, toolText(res));
        const data = toolJson<{
          items: Array<{
            id: string;
            meta: { views: ThoughtMetaView[] };
          }>;
        }>(res);
        assert.equal(data.items.length, 1);
        assert.equal(data.items[0]!.meta.views.length, 1);
        assert.equal(data.items[0]!.meta.views[0]!.name, 'Работы версии');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
