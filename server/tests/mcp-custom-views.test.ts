/**
 * 0.14.1 — `etn.custom_views.write` (задача 769fde88; операция 97d1a0d3,
 * ADR 2a758041, требование ad58f34b).
 *
 * Сценарий П5 «Агент MCP — видит, исполняет и пишет внетиповые отборы»
 * (2a18cbed), шаги 3–4 (1–2, 5 закрыты V1): создание одним вызовом с
 * проверкой через `meta.views`, обновление с `expected_version`, удаление —
 * один write-бюджет на batch; дубль имени — 409 `DUPLICATE` в MCP-обёртке
 * с `details.existing_id`.
 *
 * Тесты покрывают DoD: create/reuse/update/delete, `ref` (в т.ч. вперёд и
 * create+delete), `expected_version`, пустой патч, два create одного имени,
 * strict-ключи, чужой id, read-only ключ, бюджет и audit — одна запись на
 * батч, события — по одному на изменённый отбор.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent } from '@etn/shared';

import { openNetworkDb } from '../src/db/network-db.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
  type ClientCallToolResult,
  type McpTestContext,
} from './mcp-helpers.js';

/** Карточка отбора в ответе `items` (create/update/reuse). */
interface ViewCard {
  id: string;
  thought_id: string;
  name: string;
  name_key: string;
  description: string | null;
  definition: string;
  position: number;
  is_default: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
}

interface DeletedItem {
  action: 'deleted';
  id: string;
}

interface WriteResponse {
  items: Array<ViewCard | DeletedItem>;
  warnings: unknown[];
  layer: { id: string; title: string };
}

interface MetaView {
  id: string;
  name: string;
  name_key: string;
  description: string | null;
  defined_on: string;
  scope: 'type' | 'thought';
  inherited: boolean;
  is_default: boolean;
}

/** Прямая вставка мысли — MCP-инструмента создания мысли в тесте не нужно. */
function insertThought(ndb: ReturnType<typeof openNetworkDb>, title: string, userId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, icon, icon_kind,
                             icon_attachment_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, updated_at,
                             created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, NULL, NULL, 'emoji', NULL, 1, 0, 0, 0, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), now, now, userId, userId, Date.now(), Date.now());
  return id;
}

/** Вызвать `etn.custom_views.write`, ожидая успех. */
async function writeViews(
  client: Awaited<ReturnType<typeof connectMcpClient>>['client'],
  networkId: string,
  thoughtId: string,
  views: unknown[],
): Promise<WriteResponse> {
  const res = await client.callTool({
    name: 'etn.custom_views.write',
    arguments: { network_id: networkId, thought_id: thoughtId, views },
  });
  assert.equal(res.isError, undefined, toolText(res));
  return toolJson<WriteResponse>(res);
}

/** `meta.views` карточки мысли через `etn.thoughts.get`. */
async function metaViews(
  client: Awaited<ReturnType<typeof connectMcpClient>>['client'],
  networkId: string,
  thoughtId: string,
): Promise<MetaView[]> {
  const res = await client.callTool({
    name: 'etn.thoughts.get',
    arguments: { network_id: networkId, thought_id: thoughtId },
  });
  assert.equal(res.isError, undefined, toolText(res));
  return toolJson<{ meta: { views: MetaView[] } }>(res).meta.views;
}

/** Счётчик строк `audit_log` по инструменту и сети. */
function auditCount(ctx: McpTestContext, action: string): number {
  return (
    ctx.rawDb
      .prepare('SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND network_id = ?')
      .get(action, ctx.networkId) as { c: number }
  ).c;
}

/** Счётчик живых отборов мысли в БД. */
function liveViewCount(ctx: McpTestContext, thoughtId: string): number {
  const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
  return (
    ndb
      .prepare('SELECT COUNT(*) AS c FROM thought_custom_views_v WHERE thought_id = ?')
      .get(thoughtId) as { c: number }
  ).c;
}

const DEFINITION = JSON.stringify({ filters: [], sort: 'alpha', order: 'asc' });

function cardOf(item: ViewCard | DeletedItem): ViewCard {
  assert.equal('action' in item, false, 'create/update возвращают полную карточку, а не маркер');
  return item as ViewCard;
}

describe('etn.custom_views.write (0.14.1, 769fde88)', { skip: !nativeAvailable() }, () => {
  it('создание одним вызовом: карточки в items, meta.views, события, одна запись audit и бюджет', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = insertThought(ndb, 'Мысль с отборами', ctx.adminId);
      const events: AnyRealtimeEvent[] = [];
      const unsubscribe = ctx.pubsub.subscribe(ctx.networkId, (event) => {
        events.push(event as unknown as AnyRealtimeEvent);
      });
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await writeViews(handle.client, ctx.networkId, thoughtId, [
          { action: 'create', ref: 'a', name: 'Кому одолжил', definition: DEFINITION, position: 0 },
          {
            action: 'create',
            name: 'Кто одолжил мне',
            description: 'обратный отбор',
            definition: DEFINITION,
            position: 1,
            is_default: true,
          },
        ]);

        assert.equal(result.items.length, 2);
        const first = cardOf(result.items[0]!);
        const second = cardOf(result.items[1]!);
        assert.equal(first.name, 'Кому одолжил');
        assert.equal(first.thought_id, thoughtId);
        assert.equal(first.version, 1);
        assert.equal(second.is_default, true);
        assert.equal(second.description, 'обратный отбор');
        assert.deepEqual(result.warnings, []);
        assert.equal(typeof result.layer.id, 'string', 'эхо слоя в конверте');

        // Чтение агентом — через `meta.views` карточки (шаг 1 П5): оба
        // внетиповых со scope/defined_on и без «перекрытых» типовых.
        const views = await metaViews(handle.client, ctx.networkId, thoughtId);
        assert.equal(views.length, 2);
        assert.deepEqual(
          views.map((v) => [v.name, v.scope, v.defined_on, v.inherited]),
          [
            ['Кому одолжил', 'thought', thoughtId, false],
            ['Кто одолжил мне', 'thought', thoughtId, false],
          ],
        );

        // События — по одному на созданный отбор.
        const created = events.filter((e) => e.type === 'thought-custom-view.created');
        assert.equal(created.length, 2);
        const payload = created[0]!.data as { thought_id: string; view: { id: string; scope: string } };
        assert.equal(payload.thought_id, thoughtId);
        assert.equal(payload.view.scope, 'thought');

        // Один write-бюджет и одна строка audit на весь батч.
        assert.equal(auditCount(ctx, 'etn.custom_views.write'), 1);
      } finally {
        unsubscribe();
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('дубль имени — 409 DUPLICATE с details.existing_id; on_duplicate reuse без события', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = insertThought(ndb, 'Мысль-дубль', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = cardOf(
          (
            await writeViews(handle.client, ctx.networkId, thoughtId, [
              { action: 'create', name: 'Мой отбор', definition: DEFINITION },
            ])
          ).items[0]!,
        );

        // fail (по умолчанию) — DUPLICATE с existing_id в MCP-обёртке.
        const failRes: ClientCallToolResult = await handle.client.callTool({
          name: 'etn.custom_views.write',
          arguments: {
            network_id: ctx.networkId,
            thought_id: thoughtId,
            views: [{ action: 'create', name: '  мой ОТБОР ', definition: DEFINITION }],
          },
        });
        assert.equal(failRes.isError, true);
        const text = toolText(failRes);
        assert.match(text, /DUPLICATE/);
        assert.match(text, /existing_id/);
        assert.ok(text.includes(created.id), 'details.existing_id указывает на живой отбор');

        // reuse — та же карточка, без события и без изменения version.
        const events: AnyRealtimeEvent[] = [];
        const unsubscribe = ctx.pubsub.subscribe(ctx.networkId, (event) => {
          events.push(event as unknown as AnyRealtimeEvent);
        });
        try {
          const reused = await writeViews(handle.client, ctx.networkId, thoughtId, [
            { action: 'create', ref: 'same', name: 'Мой отбор', definition: DEFINITION, on_duplicate: 'reuse' },
          ]);
          const card = cardOf(reused.items[0]!);
          assert.equal(card.id, created.id);
          assert.equal(card.version, created.version);
          assert.equal(events.filter((e) => e.type.startsWith('thought-custom-view.')).length, 0);
        } finally {
          unsubscribe();
        }
        assert.equal(liveViewCount(ctx, thoughtId), 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('on_duplicate update правит существующий отбор и даёт событие updated', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = insertThought(ndb, 'Мысль-update-duplicate', ctx.adminId);
      const events: AnyRealtimeEvent[] = [];
      const unsubscribe = ctx.pubsub.subscribe(ctx.networkId, (event) => {
        events.push(event as unknown as AnyRealtimeEvent);
      });
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = cardOf(
          (
            await writeViews(handle.client, ctx.networkId, thoughtId, [
              { action: 'create', name: 'Сливаемый отбор', definition: DEFINITION },
            ])
          ).items[0]!,
        );
        events.length = 0;

        const updated = cardOf(
          (
            await writeViews(handle.client, ctx.networkId, thoughtId, [
              {
                action: 'create',
                name: 'Сливаемый отбор',
                description: 'новое описание',
                definition: JSON.stringify({ filters: [{ field: 'active', op: 'eq', value: true }] }),
                on_duplicate: 'update',
              },
            ])
          ).items[0]!,
        );
        assert.equal(updated.id, created.id);
        assert.equal(updated.version, created.version + 1);
        assert.equal(updated.description, 'новое описание');
        assert.notEqual(updated.definition, created.definition);

        const updatedEvents = events.filter((e) => e.type === 'thought-custom-view.updated');
        assert.equal(updatedEvents.length, 1);
        assert.equal((updatedEvents[0]!.data as { view_id: string }).view_id, created.id);
        assert.equal(liveViewCount(ctx, thoughtId), 1);
      } finally {
        unsubscribe();
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('update: expected_version, частичный патч, конфликт версий и ref вперёд', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = insertThought(ndb, 'Мысль-версии', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = cardOf(
          (
            await writeViews(handle.client, ctx.networkId, thoughtId, [
              { action: 'create', name: 'Черновик', description: 'старое', definition: DEFINITION },
            ])
          ).items[0]!,
        );

        // Частичный патч: меняется только имя, описание остаётся.
        const patched = cardOf(
          (
            await writeViews(handle.client, ctx.networkId, thoughtId, [
              { action: 'update', id: created.id, expected_version: 1, name: 'Финал' },
            ])
          ).items[0]!,
        );
        assert.equal(patched.id, created.id);
        assert.equal(patched.name, 'Финал');
        assert.equal(patched.description, 'старое');
        assert.equal(patched.version, 2);

        // Конфликт версий — устаревший expected_version.
        const conflict = await handle.client.callTool({
          name: 'etn.custom_views.write',
          arguments: {
            network_id: ctx.networkId,
            thought_id: thoughtId,
            views: [{ action: 'update', id: created.id, expected_version: 1, name: 'Ещё раз' }],
          },
        });
        assert.equal(conflict.isError, true);
        assert.match(toolText(conflict), /VERSION_CONFLICT/);

        // ref вперёд: update адресует отбор, который создаётся позже в батче;
        // items — по порядку входа.
        const forward = await writeViews(handle.client, ctx.networkId, thoughtId, [
          { action: 'update', ref: 'later', name: 'Обновлён вперёд' },
          { action: 'create', ref: 'later', name: 'Созданный позже', definition: DEFINITION },
        ]);
        assert.equal(forward.items.length, 2);
        const updatedCard = cardOf(forward.items[0]!);
        const createdCard = cardOf(forward.items[1]!);
        assert.equal(updatedCard.id, createdCard.id);
        assert.equal(updatedCard.name, 'Обновлён вперёд');
        assert.equal(liveViewCount(ctx, thoughtId), 2);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('delete по id и по ref; delete-then-create того же имени в одном батче', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = insertThought(ndb, 'Мысль-удаление', ctx.adminId);
      const events: AnyRealtimeEvent[] = [];
      const unsubscribe = ctx.pubsub.subscribe(ctx.networkId, (event) => {
        events.push(event as unknown as AnyRealtimeEvent);
      });
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const first = cardOf(
          (
            await writeViews(handle.client, ctx.networkId, thoughtId, [
              { action: 'create', name: 'Первый', definition: DEFINITION },
            ])
          ).items[0]!,
        );
        events.length = 0;

        // delete по id + create того же имени в том же батче (delete идёт
        // первым — имя освобождается), затем delete по ref созданного.
        const result = await writeViews(handle.client, ctx.networkId, thoughtId, [
          { action: 'delete', id: first.id },
          { action: 'create', ref: 'tmp', name: 'Первый', definition: DEFINITION },
          { action: 'delete', ref: 'tmp' },
        ]);
        assert.deepEqual(result.items[0], { action: 'deleted', id: first.id });
        const recreated = cardOf(result.items[1]!);
        assert.equal(recreated.name, 'Первый');
        assert.notEqual(recreated.id, first.id);
        assert.deepEqual(result.items[2], { action: 'deleted', id: recreated.id });

        // Итог: в мысли ни одного отбора (create+delete по ref схлопнулись).
        assert.equal(liveViewCount(ctx, thoughtId), 0);
        assert.deepEqual(await metaViews(handle.client, ctx.networkId, thoughtId), []);

        const deletedEvents = events.filter((e) => e.type === 'thought-custom-view.deleted');
        assert.equal(deletedEvents.length, 2, 'события по одному на удалённый отбор');
        const deletedIds = deletedEvents.map((e) => (e.data as { view_id: string }).view_id);
        assert.deepEqual(deletedIds, [first.id, recreated.id]);
      } finally {
        unsubscribe();
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('пустой патч, два create одного имени и неизвестный ключ — VALIDATION_ERROR', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = insertThought(ndb, 'Мысль-валидация', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = cardOf(
          (
            await writeViews(handle.client, ctx.networkId, thoughtId, [
              { action: 'create', name: 'A', definition: DEFINITION },
            ])
          ).items[0]!,
        );

        // Пустой патч update.
        const emptyPatch = await handle.client.callTool({
          name: 'etn.custom_views.write',
          arguments: {
            network_id: ctx.networkId,
            thought_id: thoughtId,
            views: [{ action: 'update', id: created.id }],
          },
        });
        assert.equal(emptyPatch.isError, true);
        assert.match(toolText(emptyPatch), /VALIDATION_ERROR/);
        assert.match(toolText(emptyPatch), /views\[0\]/);

        // Два create одного имени (регистр/пробелы нормализуются) в батче.
        const twoCreates = await handle.client.callTool({
          name: 'etn.custom_views.write',
          arguments: {
            network_id: ctx.networkId,
            thought_id: thoughtId,
            views: [
              { action: 'create', name: 'B', definition: DEFINITION },
              { action: 'create', name: '  b  ', definition: DEFINITION },
            ],
          },
        });
        assert.equal(twoCreates.isError, true);
        assert.match(toolText(twoCreates), /VALIDATION_ERROR/);
        assert.match(toolText(twoCreates), /views\[1\]\.name/);
        // Батч «всё или ничего»: ни один из двух не создан.
        assert.equal(liveViewCount(ctx, thoughtId), 1);

        // Неизвестный ключ элемента — strict-схема отвергает до записи.
        const unknownKey = await handle.client.callTool({
          name: 'etn.custom_views.write',
          arguments: {
            network_id: ctx.networkId,
            thought_id: thoughtId,
            views: [{ action: 'create', name: 'C', definition: DEFINITION, bogus: true }],
          },
        });
        assert.equal(unknownKey.isError, true);
        assert.match(toolText(unknownKey), /VALIDATION_ERROR/);
        assert.equal(liveViewCount(ctx, thoughtId), 1);

        // update без адреса (ни id, ни ref) — тоже VALIDATION_ERROR.
        const noAddress = await handle.client.callTool({
          name: 'etn.custom_views.write',
          arguments: {
            network_id: ctx.networkId,
            thought_id: thoughtId,
            views: [{ action: 'update', name: 'Без адреса' }],
          },
        });
        assert.equal(noAddress.isError, true);
        assert.match(toolText(noAddress), /VALIDATION_ERROR/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('неразрешённый ref — VALIDATION_ERROR views[i].ref', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = insertThought(ndb, 'Мысль-ref', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const res = await handle.client.callTool({
          name: 'etn.custom_views.write',
          arguments: {
            network_id: ctx.networkId,
            thought_id: thoughtId,
            views: [{ action: 'update', ref: 'nope', name: 'Некуда' }],
          },
        });
        assert.equal(res.isError, true);
        const text = toolText(res);
        assert.match(text, /VALIDATION_ERROR/);
        assert.match(text, /views\[0\]\.ref/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('чужой id — 404 NOT_FOUND, изменения не применены', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = insertThought(ndb, 'Мысль-владелец', ctx.adminId);
      const otherId = insertThought(ndb, 'Чужая мысль', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const foreign = cardOf(
          (
            await writeViews(handle.client, ctx.networkId, otherId, [
              { action: 'create', name: 'Чужой отбор', definition: DEFINITION },
            ])
          ).items[0]!,
        );

        for (const view of [
          { action: 'update', id: foreign.id, name: 'Захват' },
          { action: 'delete', id: foreign.id },
        ]) {
          const res = await handle.client.callTool({
            name: 'etn.custom_views.write',
            arguments: { network_id: ctx.networkId, thought_id: thoughtId, views: [view] },
          });
          assert.equal(res.isError, true, `чужой id должен падать: ${toolText(res)}`);
          assert.match(toolText(res), /NOT_FOUND/);
        }

        // Чужой отбор цел и принадлежит прежней мысли.
        assert.equal(liveViewCount(ctx, otherId), 1);
        assert.equal(liveViewCount(ctx, thoughtId), 0);
        const row = ndb
          .prepare('SELECT thought_id, name FROM thought_custom_views_v WHERE id = ?')
          .get(foreign.id) as { thought_id: string; name: string } | undefined;
        assert.equal(row?.thought_id, otherId);
        assert.equal(row?.name, 'Чужой отбор');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('read-only ключ — отказ FORBIDDEN', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = insertThought(ndb, 'Мысль-readonly', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.readOnlyKey);
      try {
        const res = await handle.client.callTool({
          name: 'etn.custom_views.write',
          arguments: {
            network_id: ctx.networkId,
            thought_id: thoughtId,
            views: [{ action: 'create', name: 'Нельзя', definition: DEFINITION }],
          },
        });
        assert.equal(res.isError, true);
        assert.match(toolText(res), /FORBIDDEN/);
        assert.equal(liveViewCount(ctx, thoughtId), 0);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('один write-бюджет на батч: при лимите 1 второй вызов отвергается', async () => {
    const ctx = await buildMcpContext();
    try {
      ctx.rawDb
        .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('mcp.max_writes_per_minute', '1', new Date().toISOString());
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = insertThought(ndb, 'Мысль-бюджет', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Три элемента одного батча — одна запись бюджета.
        const first = await writeViews(handle.client, ctx.networkId, thoughtId, [
          { action: 'create', name: 'Раз', definition: DEFINITION },
          { action: 'create', name: 'Два', definition: DEFINITION },
          { action: 'create', name: 'Три', definition: DEFINITION },
        ]);
        assert.equal(first.items.length, 3);

        const second = await handle.client.callTool({
          name: 'etn.custom_views.write',
          arguments: {
            network_id: ctx.networkId,
            thought_id: thoughtId,
            views: [{ action: 'create', name: 'Четыре', definition: DEFINITION }],
          },
        });
        assert.equal(second.isError, true);
        assert.match(toolText(second), /RATE_LIMITED|write limit/);
        assert.equal(liveViewCount(ctx, thoughtId), 3);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('исполнение через etn.views.run: по имени и id; промах несёт available_views со scope', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtId = insertThought(ndb, 'Мысль-исполнение', ctx.adminId);
      insertThought(ndb, 'Найдётся отбором', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const view = cardOf(
          (
            await writeViews(handle.client, ctx.networkId, thoughtId, [
              {
                action: 'create',
                name: 'Все мысли',
                definition: JSON.stringify({
                  filters: [{ field: 'active', op: 'eq', value: true }],
                  sort: 'alpha',
                  order: 'asc',
                }),
              },
            ])
          ).items[0]!,
        );

        for (const viewName of ['Все мысли', view.id]) {
          const runRes = await handle.client.callTool({
            name: 'etn.views.run',
            arguments: { network_id: ctx.networkId, thought_id: thoughtId, view_name: viewName },
          });
          assert.equal(runRes.isError, undefined, toolText(runRes));
          const run = toolJson<{
            view: { id: string; scope: string; defined_on: string };
            data: Array<{ id: string }>;
          }>(runRes);
          assert.equal(run.view.id, view.id);
          assert.equal(run.view.scope, 'thought');
          assert.equal(run.view.defined_on, thoughtId);
          assert.equal(run.data.length, 2);
        }

        const miss = await handle.client.callTool({
          name: 'etn.views.run',
          arguments: {
            network_id: ctx.networkId,
            thought_id: thoughtId,
            view_name: 'Нет такого',
          },
        });
        assert.equal(miss.isError, true);
        const text = toolText(miss);
        assert.match(text, /NOT_FOUND/);
        assert.match(text, /available_views/);
        assert.ok(
          text.includes('"scope":"thought"') && text.includes(`"defined_on":"${thoughtId}"`),
          `available_views обязан нести scope/defined_on: ${text}`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
