/**
 * Сторож ошибки 3f535ae8 (версия 0.8.2): витрина инструкций и структура сети
 * читают **слой сессии**, а не основу.
 *
 * До правки три читателя открывали `data.db` напрямую, без слоя:
 *   * `etn.instructions` (MCP) — оба режима, список и полный текст;
 *   * `etn.networks.structure` (MCP) — разделы оглавления;
 *   * `GET /networks/:id/instructions` (REST) — паритет с витриной.
 *
 * Следствие было таким: правки инструкций и оглавления, сделанные в слое
 * (а в 0.8.2 именно там идут правки инструкций), агенту через витрину не
 * видны — он выполнял устаревшую процедуру из основы.
 *
 * Проверяется и обратная сторона: **без выбранного слоя поведение не
 * изменилось** — дефолт остаётся основой (сессия второго MCP-ключа / REST-запрос
 * без `Client-Id` и с чужим `Client-Id` видят основу).
 *
 * Приёмы бутстрапа — как в `mcp-instructions.test.ts`,
 * `mcp-layers.test.ts`, `routes-instructions.test.ts` и `layers-s7.test.ts`:
 * мысли и типы вставляются в `data.db` напрямую, роль сети правится через
 * system DB (`PATCH /networks/:id` в REST), переключение слоя — штатным
 * инструментом/маршрутом.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { openNetworkDb } from '../src/db/network-db.js';

import {
  callOp,
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
  upsertPermanentViaWrite,
  callWrite,
  type McpTestContext,
} from './mcp-helpers.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
} from './rest-helpers.js';
import { createCommentWithTargets } from '../src/domain/comment-service.js';

// ---------------------------------------------------------------------------
// Фикстуры (прямая вставка в data.db — тот же приём, что в соседних тестах)
// ---------------------------------------------------------------------------

type Ndb = ReturnType<typeof openNetworkDb>;

/** Вставить тип мысли напрямую: подтип корневого типа (корневой не назначается). */
function makeThoughtType(ndb: Ndb, name: string, userId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, name, name_key, parent_id, is_root, version,
                                  created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?)`,
    )
    .run(
      id,
      name,
      name.toLowerCase(),
      // Корневой тип иерархии, засеянный миграцией 021 (фиксированный id).
      '00000000-0000-4000-8000-000000000001',
      now,
      now,
      userId,
      userId,
    );
  return id;
}

/** Вставить мысль напрямую в слой соединения (по умолчанию — основа). */
function makeThought(ndb: Ndb, title: string, typeId: string | null, userId: string): string {
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
    .run(
      id,
      ndb.layerId,
      title,
      title.toLowerCase(),
      typeId,
      now,
      now,
      userId,
      userId,
      Date.now(),
      Date.now(),
    );
  return id;
}

/** Выставить роли сети через system DB (не ветвится, слой не влияет). */
function setRoles(ctx: McpTestContext, roles: Record<string, string | null>): void {
  const current = ctx.sys.getNetworkById(ctx.networkId)!;
  ctx.sys.updateNetwork(ctx.networkId, {
    displayName: current.display_name,
    description: null,
    when_to_use: null,
    conventions: null,
    examples: null,
    type_roles: roles,
  });
}

/** Выбрать слой для текущей MCP-сессии (ключ). */
async function selectMcpLayer(client: Client, networkId: string): Promise<string> {
  const created = toolJson<{ id: string; layer: { id: string } }>(
    await callOp(client, 'layers.create', { network_id: networkId, title: 'Правка в слое' }),
  );
  const picked = toolJson<{ id: string }>(
    await client.callTool({
      name: 'etn.layers.select',
      arguments: { network_id: networkId, layer_id: created.id },
    }),
  );
  assert.equal(picked.id, created.id);
  return created.id;
}

interface InstructionFull {
  instruction_id: string;
  title: string;
  body_md: string | null;
}

interface InstructionList {
  has_instructions: boolean;
  instructions: Array<{ id: string; title: string; preview: { body_md: string } | null }>;
}

interface SectionNode {
  id: string;
  title: string;
}

/** Витрина инструкций: полный текст одной инструкции. */
async function readInstruction(
  client: Client,
  networkId: string,
  instructionId: string,
): Promise<InstructionFull> {
  const result = await client.callTool({
    name: 'etn.instructions',
    arguments: { network_id: networkId, instruction_id: instructionId },
  });
  assert.equal(result.isError, undefined, toolText(result));
  return toolJson<InstructionFull>(result);
}

/** Разделы оглавления сети. */
async function readSections(client: Client, networkId: string): Promise<SectionNode[]> {
  const result = await client.callTool({
    name: 'etn.networks.structure',
    arguments: { network_id: networkId },
  });
  assert.equal(result.isError, undefined, toolText(result));
  return toolJson<{ sections: SectionNode[] }>(result).sections;
}

// ---------------------------------------------------------------------------
// MCP: etn.instructions
// ---------------------------------------------------------------------------

describe('ошибка 3f535ae8: витрина и структура читают слой сессии', { skip: !nativeAvailable() }, () => {
  it('etn.instructions в слое отдаёт правку слоя, на основе — прежний текст', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);
      const thoughtId = makeThought(ndb, 'Публикация релиза', instructionsTypeId, ctx.adminId);
      setRoles(ctx, { instructions: instructionsTypeId });

      const agent = await connectMcpClient(ctx, ctx.adminKey);
      // Второй ключ того же пользователя — независимая MCP-сессия: слой не
      // выбирала и остаётся на основе (как в `mcp-layers.test.ts`).
      const observer = await connectMcpClient(ctx, ctx.readOnlyKey);
      try {
        await upsertPermanentViaWrite(agent.client, ctx.networkId, thoughtId, 'Основа: шаг 1.');

        // До выбора слоя витрина отдаёт текст основы — поведение не изменилось.
        const onBase = await readInstruction(agent.client, ctx.networkId, thoughtId);
        assert.equal(onBase.title, 'Публикация релиза');
        assert.equal(onBase.body_md, 'Основа: шаг 1.');

        await selectMcpLayer(agent.client, ctx.networkId);
        // Правка инструкции в слое: пишущий инструмент ходит в слой сессии.
        await upsertPermanentViaWrite(agent.client, ctx.networkId, thoughtId, 'Слой: шаг 1, шаг 2.');

        // Регресс: витрина в слое обязана вернуть новый текст, а не основу.
        const inLayer = await readInstruction(agent.client, ctx.networkId, thoughtId);
        assert.equal(inLayer.body_md, 'Слой: шаг 1, шаг 2.');

        // Список в слое тоже несёт правку слоя (превью постоянного комментария).
        const listResult = await agent.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(listResult.isError, undefined, toolText(listResult));
        const list = toolJson<InstructionList>(listResult);
        assert.equal(list.instructions.length, 1);
        assert.equal(list.instructions[0]!.preview?.body_md, 'Слой: шаг 1, шаг 2.');

        // Сессия на основе (второй ключ) видит прежний текст и не видит правку.
        const observerView = await readInstruction(observer.client, ctx.networkId, thoughtId);
        assert.equal(observerView.body_md, 'Основа: шаг 1.');
      } finally {
        await agent.close();
        await observer.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // MCP: etn.networks.structure
  // -------------------------------------------------------------------------

  it('etn.networks.structure видит раздел, добавленный и скрытый в слое; основа чиста', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const sectionTypeId = makeThoughtType(ndb, 'Раздел', ctx.adminId);
      const baseSectionId = makeThought(ndb, 'Введение', sectionTypeId, ctx.adminId);
      setRoles(ctx, { table_of_contents: sectionTypeId });

      const agent = await connectMcpClient(ctx, ctx.adminKey);
      const observer = await connectMcpClient(ctx, ctx.readOnlyKey);
      try {
        // Основу видно обеим сессиям до выбора слоя.
        assert.deepEqual(
          (await readSections(agent.client, ctx.networkId)).map((s) => s.title),
          ['Введение'],
        );

        await selectMcpLayer(agent.client, ctx.networkId);

        // Правки оглавления только в слое: базовый раздел скрыт, добавлен новый.
        const hidden = await agent.client.callTool({
          name: 'etn.thoughts.bulk_update',
          arguments: {
            network_id: ctx.networkId,
            ids: [baseSectionId],
            op: 'set_inactive',
          },
        });
        assert.equal(hidden.isError, undefined, toolText(hidden));
        await callWrite(agent.client, ctx.networkId, [
          { ref: 'new', thought: { title: 'Новый раздел слоя', type_id: sectionTypeId } },
        ]);
        // Регресс: структура в слое обязана показать состояние слоя.
        assert.deepEqual(
          (await readSections(agent.client, ctx.networkId)).map((s) => s.title),
          ['Новый раздел слоя'],
        );
        // Основа не тронута — сессия без слоя видит прежний раздел.
        assert.deepEqual(
          (await readSections(observer.client, ctx.networkId)).map((s) => s.title),
          ['Введение'],
        );
      } finally {
        await agent.close();
        await observer.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // REST: GET /networks/:id/instructions
  // -------------------------------------------------------------------------

  it('GET /networks/:id/instructions читает слой сессии, дефолт — основа', async () => {
    const ctx = await buildRestContext();
    try {
      const instructionsTypeId = makeThoughtType(ctx.ndb, 'Инструкция', ctx.adminId);
      const instructionId = makeThought(ctx.ndb, 'Публикация релиза', instructionsTypeId, ctx.adminId);
      const comment = createCommentWithTargets(
        ctx.ndb,
        [{ owner_type: 'thought', owner_id: instructionId }],
        { kind: 'permanent', body_md: 'Основа: шаг 1.' },
        ctx.adminId,
      );

      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/networks/${ctx.networkId}`,
        headers: authHeaders(ctx),
        payload: { type_roles: { instructions: instructionsTypeId } },
      });
      assert.equal(patched.statusCode, 200);

      const created = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/layers`,
        headers: authHeaders(ctx),
        payload: { title: 'Правка инструкции' },
      });
      assert.equal(created.statusCode, 201, created.body?.toString());
      const layerId = (created.json().data as { id: string }).id;

      // Сессия слоя — свой `Client-Id` (13-layers.md §7.1).
      const layerClient = 'client-в-слое';
      const selected = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/select`,
        headers: { ...authHeaders(ctx), 'client-id': layerClient },
        payload: {},
      });
      assert.equal(selected.statusCode, 200);

      // Правка постоянного комментария инструкции **в слое**.
      const updated = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/networks/${ctx.networkId}/comments/${comment.id}`,
        headers: { ...authHeaders(ctx), 'client-id': layerClient },
        payload: { body_md: 'Слой: шаг 1, шаг 2.' },
      });
      assert.equal(updated.statusCode, 200, updated.body?.toString());

      const baseUrl = `/api/v1/networks/${ctx.networkId}/instructions`;

      // Регресс: витрина в слое обязана вернуть правку слоя.
      const inLayer = await ctx.app.inject({
        method: 'GET',
        url: `${baseUrl}?instruction_id=${instructionId}`,
        headers: { ...authHeaders(ctx), 'client-id': layerClient },
      });
      assert.equal(inLayer.statusCode, 200);
      assert.equal(inLayer.json().data.body_md, 'Слой: шаг 1, шаг 2.');

      // Список в слое несёт превью слоя.
      const listInLayer = await ctx.app.inject({
        method: 'GET',
        url: baseUrl,
        headers: { ...authHeaders(ctx), 'client-id': layerClient },
      });
      assert.equal(listInLayer.statusCode, 200);
      const listBody = listInLayer.json().data as {
        instructions: Array<{ preview: { body_md: string } | null }>;
      };
      assert.equal(listBody.instructions[0]?.preview?.body_md, 'Слой: шаг 1, шаг 2.');

      // Дефолт не изменился: сессия без `Client-Id` (основа) и чужая сессия
      // видят текст основы.
      for (const headers of [
        authHeaders(ctx),
        { ...authHeaders(ctx), 'client-id': 'другой-клиент' },
      ]) {
        const onBase = await ctx.app.inject({
          method: 'GET',
          url: `${baseUrl}?instruction_id=${instructionId}`,
          headers,
        });
        assert.equal(onBase.statusCode, 200);
        assert.equal(onBase.json().data.body_md, 'Основа: шаг 1.');
      }
    } finally {
      await closeRestContext(ctx);
    }
  });
});
