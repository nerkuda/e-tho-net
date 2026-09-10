/**
 * 0.7.2 — `etn.instructions` (задача ba024a45, ADR 717f04df, спека 14b0cc4f).
 *
 * Витрина инструкций сети: три режима (по `instruction_id` / по `keywords`
 * / все) и четыре кейса:
 *   * сеть без роли `instructions` → `{ has_instructions: false, instructions: [] }`;
 *   * сеть с ролью и активными инструкциями → превью + список;
 *   * неактуальные (active = 0) или помеченные на удаление мысли скрыты;
 *   * по `instruction_id` — полный текст постоянного комментария без обрезки.
 *
 * Bootstrap — `mcp-helpers.ts` (тот же, что в `mcp-comments-edit.test.ts`):
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

interface InstructionSummary {
  id: string;
  title: string;
  synonyms: string[];
  preview: { id: string; body_md: string; truncated: boolean; chars_total?: number };
  type_id: string | null;
}

interface InstructionsList {
  network_id: string;
  has_instructions: boolean;
  instructions: InstructionSummary[];
  meta: { total: number; matched?: number };
}

interface InstructionFull {
  network_id: string;
  has_instructions: boolean;
  instruction_id: string;
  title: string;
  type_id: string | null;
  body_md: string | null;
}

interface InstructionsEmpty {
  network_id: string;
  has_instructions: false;
  instructions: [];
}

/** Insert a thought directly via the network DB. */
function makeThought(
  ndb: ReturnType<typeof openNetworkDb>,
  title: string,
  opts: { typeId: string | null; active?: number; trashed?: number },
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
               ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ndb.layerId,
      title,
      title.toLowerCase(),
      opts.typeId,
      opts.active ?? 1,
      opts.trashed ?? 0,
      now,
      now,
      userId,
      userId,
      Date.now(),
      Date.now(),
    );
  return id;
}

/** Insert a thought-type directly. */
function makeThoughtType(
  ndb: ReturnType<typeof openNetworkDb>,
  name: string,
  userId: string,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, name, name_key, is_root, version,
                                  created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?)`,
    )
    .run(id, name, name.toLowerCase(), now, now, userId, userId);
  return id;
}

/** Upsert a permanent comment through the public MCP tool
 *  (`etn.comments.upsert`) — keeps the test aligned with the real flow
 *  (which also renders and persists `body_html`). */
async function upsertPermanent(
  client: Client,
  networkId: string,
  thoughtId: string,
  body: string,
): Promise<string> {
  const result = await client.callTool({
    name: 'etn.comments.upsert',
    arguments: {
      network_id: networkId,
      owner_type: 'thought',
      owner_id: thoughtId,
      kind: 'permanent',
      body_md: body,
    },
  });
  return toolJson<{ id: string }>(result).id;
}

/** Set the network's `type_roles` via the system DB. */
function setTypeRoles(
  ctx: Awaited<ReturnType<typeof buildMcpContext>>,
  roles: Record<string, string | null>,
): void {
  ctx.sys.updateNetwork(ctx.networkId, {
    displayName: ctx.sys.getNetworkById(ctx.networkId)!.display_name,
    description: null,
    when_to_use: null,
    conventions: null,
    examples: null,
    type_roles: roles,
  });
}

describe('etn.instructions (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('has_instructions=false when the network has no `instructions` role', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<InstructionsEmpty>(result);
        assert.equal(data.network_id, ctx.networkId);
        assert.equal(data.has_instructions, false);
        assert.deepEqual(data.instructions, []);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('lists every active instruction with preview when the role is set', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);
      const otherTypeId = makeThoughtType(ndb, 'Заметка', ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const alpha = makeThought(ndb, 'Alpha', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanent(handle.client, ctx.networkId, alpha, 'Первая инструкция.');
        const beta = makeThought(ndb, 'Beta', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanent(handle.client, ctx.networkId, beta, 'Вторая инструкция.');
        makeThought(ndb, 'Noise', { typeId: otherTypeId }, ctx.adminId);

        setTypeRoles(ctx, { instructions: instructionsTypeId });

        const result = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<InstructionsList>(result);
        assert.equal(data.network_id, ctx.networkId);
        assert.equal(data.has_instructions, true);
        assert.equal(data.instructions.length, 2);
        assert.deepEqual(
          data.instructions.map((i) => i.title).sort(),
          ['Alpha', 'Beta'],
        );
        for (const item of data.instructions) {
          assert.ok(typeof item.preview.id === 'string');
          assert.ok(item.preview.body_md.length > 0);
        }
        assert.equal(data.meta.total, 2);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('hides inactive and trashed instructions', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const active = makeThought(
          ndb,
          'Active',
          { typeId: instructionsTypeId, active: 1 },
          ctx.adminId,
        );
        await upsertPermanent(handle.client, ctx.networkId, active, 'видимая');
        const inactive = makeThought(
          ndb,
          'Inactive',
          { typeId: instructionsTypeId, active: 0 },
          ctx.adminId,
        );
        await upsertPermanent(handle.client, ctx.networkId, inactive, 'скрытая');
        const trashed = makeThought(
          ndb,
          'Trashed',
          { typeId: instructionsTypeId, trashed: 1 },
          ctx.adminId,
        );
        await upsertPermanent(handle.client, ctx.networkId, trashed, 'удалено');

        setTypeRoles(ctx, { instructions: instructionsTypeId });

        const result = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<InstructionsList>(result);
        assert.deepEqual(
          data.instructions.map((i) => i.title),
          ['Active'],
        );
        assert.equal(data.meta.total, 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('by_id returns the FULL permanent comment without truncation', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const longBody = 'x'.repeat(8000);
        const thoughtId = makeThought(
          ndb,
          'Long',
          { typeId: instructionsTypeId },
          ctx.adminId,
        );
        await upsertPermanent(handle.client, ctx.networkId, thoughtId, longBody);

        setTypeRoles(ctx, { instructions: instructionsTypeId });

        const result = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId, instruction_id: thoughtId },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<InstructionFull>(result);
        assert.equal(data.network_id, ctx.networkId);
        assert.equal(data.has_instructions, true);
        assert.equal(data.instruction_id, thoughtId);
        assert.equal(data.title, 'Long');
        // FULL text — no truncation.
        assert.equal(data.body_md?.length, 8000);
        assert.equal(data.body_md, longBody);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('by_id rejects unknown / unrelated instructions with NOT_FOUND', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);
      setTypeRoles(ctx, { instructions: instructionsTypeId });
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const err = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: {
            network_id: ctx.networkId,
            instruction_id: '00000000-0000-4000-8000-0000000000aa',
          },
        });
        assert.equal(err.isError, true);
        assert.match(toolText(err), /NOT_FOUND/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Ошибка 18d7774a: union-схема заменена одним объектом со взаимоисключением
  // через `.refine()` — режимы обязаны остаться взаимоисключимыми.
  it('rejects instruction_id and keywords passed together', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);
      setTypeRoles(ctx, { instructions: instructionsTypeId });
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const err = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: {
            network_id: ctx.networkId,
            instruction_id: '00000000-0000-4000-8000-0000000000aa',
            keywords: 'up',
          },
        });
        assert.equal(err.isError, true);
        assert.match(toolText(err), /взаимоисключимы/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('by keywords filters by title + synonyms (mini-syntax)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const a = makeThought(ndb, 'Setup', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanent(handle.client, ctx.networkId, a, '...');
        const b = makeThought(ndb, 'Cleanup', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanent(handle.client, ctx.networkId, b, '...');
        const c = makeThought(ndb, 'Build', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanent(handle.client, ctx.networkId, c, '...');

        setTypeRoles(ctx, { instructions: instructionsTypeId });

        // One word matches both Setup and Cleanup (the common fragment `up`).
        const result = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId, keywords: 'up' },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<InstructionsList>(result);
        assert.deepEqual(
          data.instructions.map((i) => i.title).sort(),
          ['Cleanup', 'Setup'],
        );
        // Total matches what the keyword filter found.
        assert.equal(data.meta.total, 2);
        assert.equal(data.meta.matched, 2);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
