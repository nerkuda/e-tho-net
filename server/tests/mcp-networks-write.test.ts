/**
 * 0.7.2 — `etn.networks.write` + `etn.networks.delete` (задача ba024a45,
 * спека 26b2e83b).
 *
 * Сценарии:
 *   * создание сети без `network_id` — caller становится owner;
 *   * правка существующей (owner и admin; `member` → FORBIDDEN);
 *   * `type_roles` с известными ролями; неизвестный ключ → VALIDATION_ERROR;
 *   * удаление требует `confirm: true` (иначе VALIDATION_ERROR);
 *   * удаление: только admin; рядовой owner → FORBIDDEN;
 *   * удаление физически стирает запись сети и её каталог.
 *
 * Bootstrap — `mcp-helpers.ts`.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { networkDir } from '../src/paths.js';

interface NetworkCard {
  id: string;
  display_name: string;
  owner_id: string;
  description: string | null;
  when_to_use: string | null;
  conventions: string | null;
  examples: string | null;
  type_roles: Record<string, string | null>;
  has_structure: boolean;
  created_at: string;
  updated_at: string;
}

describe('etn.networks.write (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('creates a network when network_id is absent — caller becomes the owner', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.networks.write',
          arguments: {
            display_name: 'Fresh net',
            description: 'desc',
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<NetworkCard>(result);
        assert.equal(data.display_name, 'Fresh net');
        assert.equal(data.description, 'desc');
        assert.equal(data.owner_id, ctx.adminId);
        assert.deepEqual(data.type_roles, {});
        assert.equal(data.has_structure, false);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('patches an existing network — owner can update; member is rejected', async () => {
    const ctx = await buildMcpContext();
    try {
      // Add a second user — a `member` of the existing network.
      const memberId = randomUUID();
      ctx.sys.createUser({
        id: memberId,
        username: 'member',
        displayName: 'Member',
        isAdmin: false,
        isFirstUser: false,
      });
      const memberGen = generateApiKey();
      ctx.sys.createApiKey({
        id: randomUUID(),
        userId: memberId,
        label: 'member',
        keyHash: hashApiKey(memberGen.key),
        keyPrefix: memberGen.keyPrefix,
      });
      ctx.sys.addNetworkMember(ctx.networkId, memberId, 'member', ctx.adminId);

      const handleOwner = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handleOwner.client.callTool({
          name: 'etn.networks.write',
          arguments: {
            network_id: ctx.networkId,
            display_name: 'Renamed',
            conventions: 'New conventions.',
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<NetworkCard>(result);
        assert.equal(data.display_name, 'Renamed');
        assert.equal(data.conventions, 'New conventions.');
        assert.equal(data.owner_id, ctx.adminId);
      } finally {
        await handleOwner.close();
      }

      const handleMember = await connectMcpClient(ctx, memberGen.key);
      try {
        const err = await handleMember.client.callTool({
          name: 'etn.networks.write',
          arguments: {
            network_id: ctx.networkId,
            display_name: 'Hijacked',
          },
        });
        assert.equal(err.isError, true);
        assert.match(toolText(err), /FORBIDDEN/);
      } finally {
        await handleMember.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('rejects an unknown type_role key with VALIDATION_ERROR', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const err = await handle.client.callTool({
          name: 'etn.networks.write',
          arguments: {
            network_id: ctx.networkId,
            type_roles: { mystery_role: null },
          },
        });
        assert.equal(err.isError, true);
        assert.match(toolText(err), /VALIDATION_ERROR/);
        assert.match(toolText(err), /mystery_role/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('accepts a real type_roles.table_of_contents and rejects a stale id', async () => {
    const ctx = await buildMcpContext();
    try {
      // Create a thought type inside the existing network.
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const tt = await handle.client.callTool({
          name: 'etn.thoughts.types.list',
          arguments: { network_id: ctx.networkId },
        });
        // etн.thoughts.types.list — list empty for a fresh network; create one
        // through a different path. Use the direct DB so we don't depend on a
        // tool not exposed on the public surface.
        void tt;

        // Use createThoughtType via the system layer (test helper scope).
        const ndbModule = await import('../src/db/network-db.js');
        const ndb = ndbModule.openNetworkDb(ctx.dataDir, ctx.networkId);
        const typeId = randomUUID();
        ndb
          .prepare(
            `INSERT INTO thought_types (id, name, name_key, is_root, version,
                                        created_at, updated_at, created_by, updated_by)
             VALUES (?, 'Раздел', 'раздел', 1, 1, '2025', '2025', ?, ?)`,
          )
          .run(typeId, ctx.adminId, ctx.adminId);

        // Real id → accepted; has_structure flips true.
        const ok = await handle.client.callTool({
          name: 'etn.networks.write',
          arguments: {
            network_id: ctx.networkId,
            type_roles: { table_of_contents: typeId },
          },
        });
        assert.equal(ok.isError, undefined, toolText(ok));
        const okData = toolJson<NetworkCard>(ok);
        assert.equal(okData.type_roles.table_of_contents, typeId);
        assert.equal(okData.has_structure, true);

        // Stale id → VALIDATION_ERROR (the service validates type existence).
        const bad = await handle.client.callTool({
          name: 'etn.networks.write',
          arguments: {
            network_id: ctx.networkId,
            type_roles: { table_of_contents: '00000000-0000-4000-8000-0000000000aa' },
          },
        });
        assert.equal(bad.isError, true);
        assert.match(toolText(bad), /VALIDATION_ERROR/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('merge semantics: omitting a key preserves the existing role', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndbModule = await import('../src/db/network-db.js');
      const ndb = ndbModule.openNetworkDb(ctx.dataDir, ctx.networkId);
      const typeIdA = randomUUID();
      const typeIdB = randomUUID();
      for (const [id, name] of [
        [typeIdA, 'A'],
        [typeIdB, 'B'],
      ] as Array<[string, string]>) {
        ndb
          .prepare(
            `INSERT INTO thought_types (id, name, name_key, is_root, version,
                                        created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, 1, 1, '2025', '2025', ?, ?)`,
          )
          .run(id, name, name.toLowerCase(), ctx.adminId, ctx.adminId);
      }
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // First write: set both roles.
        const r1 = await handle.client.callTool({
          name: 'etn.networks.write',
          arguments: {
            network_id: ctx.networkId,
            type_roles: { table_of_contents: typeIdA, instructions: typeIdB },
          },
        });
        assert.equal(r1.isError, undefined, toolText(r1));
        // Second write: only set table_of_contents — instructions must stay.
        const r2 = await handle.client.callTool({
          name: 'etn.networks.write',
          arguments: {
            network_id: ctx.networkId,
            type_roles: { table_of_contents: typeIdB },
          },
        });
        assert.equal(r2.isError, undefined, toolText(r2));
        const data = toolJson<NetworkCard>(r2);
        assert.equal(data.type_roles.table_of_contents, typeIdB);
        assert.equal(data.type_roles.instructions, typeIdB);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

describe('etn.networks.delete (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('rejects a non-admin caller with FORBIDDEN', async () => {
    const ctx = await buildMcpContext();
    try {
      // The admin is the owner but not a server-level admin: even so, the
      // delete tool requires `isAdmin: true` per ADR 26b2e83b. Add a fresh
      // user with no admin role and a primary key.
      const userId = randomUUID();
      ctx.sys.createUser({
        id: userId,
        username: 'plain',
        displayName: 'Plain',
        isAdmin: false,
        isFirstUser: false,
      });
      const gen = generateApiKey();
      ctx.sys.createApiKey({
        id: randomUUID(),
        userId,
        label: 'plain',
        keyHash: hashApiKey(gen.key),
        keyPrefix: gen.keyPrefix,
      });
      const handle = await connectMcpClient(ctx, gen.key);
      try {
        const err = await handle.client.callTool({
          name: 'etn.networks.delete',
          arguments: { network_id: ctx.networkId, confirm: true },
        });
        assert.equal(err.isError, true);
        assert.match(toolText(err), /FORBIDDEN/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('rejects a missing confirm flag with VALIDATION_ERROR', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const err = await handle.client.callTool({
          name: 'etn.networks.delete',
          arguments: { network_id: ctx.networkId, confirm: false },
        });
        assert.equal(err.isError, true);
        assert.match(toolText(err), /VALIDATION_ERROR|Invalid/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('admin can delete a network — row + per-network dir disappear', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const dir = networkDir(ctx.dataDir, ctx.networkId);
        assert.ok(existsSync(dir), 'network dir must exist before delete');

        const result = await handle.client.callTool({
          name: 'etn.networks.delete',
          arguments: { network_id: ctx.networkId, confirm: true },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<{
          deleted: boolean;
          network_id: string;
        }>(result);
        assert.equal(data.deleted, true);
        assert.equal(data.network_id, ctx.networkId);

        // Registry row is gone.
        assert.equal(ctx.sys.getNetworkById(ctx.networkId), null);
        // Directory is removed.
        assert.equal(existsSync(dir), false);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
