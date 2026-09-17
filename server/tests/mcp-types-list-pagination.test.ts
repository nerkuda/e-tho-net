/**
 * `etn.types.list` pagination + soft-truncation budget (task f9c7dbc5, 0.7.4).
 *
 * Covers:
 *   * `limit`/`offset` — classic window over each (filtered) catalogue,
 *     paginated independently for `thought_types` and `link_types`;
 *   * `max_chars` — soft-then-hard shrinker fits the JSON envelope under
 *     the caller's byte budget; reports `meta.truncated` + `meta.reason`
 *     and never breaks the legacy contract (no `meta` block when the
 *     caller passed no new params).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 *
 * Setup note: `etn.types.create` через MCP-фасад не предусмотрен — типы и
 * реестровые свойства создаются напрямую через доменные сервисы
 * (см. mcp-telemetry.test.ts, mcp-views.test.ts).
 */

import assert from 'node:assert/strict';
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
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';

interface TypesListResponseWithMeta {
  thought_types?: Array<{ id: string; name: string; description: string | null }>;
  link_types?: Array<{ id: string; name_forward: string; name_reverse: string; description: string | null }>;
  meta?: {
    truncated?: boolean;
    reason?: 'max_chars_preview' | 'max_chars_items' | null;
    thought_types_total?: number;
    link_types_total?: number;
    limit?: number;
    offset?: number;
    max_chars?: number;
    original_chars?: number;
    final_chars?: number;
  };
}

describe('etn.types.list pagination + max_chars (f9c7dbc5)', {
  skip: !nativeAvailable(),
}, () => {
  it('limit/offset window through the (alphabetically sorted) catalogue', async () => {
    const ctx = await buildMcpContext();
    try {
      // Seed five thought types in reverse insertion order to verify the
      // catalogue is paginated by `name` (ascending), not by creation time.
      // The freshly-created network already seeds one root thought type
      // («основной тип»); with SQLite's default BINARY collation the cyrillic
      // «о» sorts AFTER the latin «Т», so the root type ends up at the tail
      // of the catalogue (not the head).
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      for (const name of ['Тип-5', 'Тип-3', 'Тип-1', 'Тип-4', 'Тип-2']) {
        createThoughtType(ndb, { name }, ctx.adminId);
      }
      const TOTAL = 6;

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // First page — `limit=2, offset=0` — alphabetical head.
        const first = toolJson<TypesListResponseWithMeta>(
          await handle.client.callTool({
            name: 'etn.types.list',
            arguments: {
              network_id: ctx.networkId,
              scope: 'thoughts',
              limit: 2,
              offset: 0,
            },
          }),
        );
        assert.equal(first.thought_types?.length, 2);
        assert.deepEqual(
          first.thought_types!.map((t) => t.name),
          ['Тип-1', 'Тип-2'],
        );
        assert.equal(first.meta?.limit, 2);
        assert.equal(first.meta?.offset, 0);
        // Total stays 6 (5 seeds + 1 root) — paging only trimmed the window.
        assert.equal(first.meta?.thought_types_total, TOTAL);
        // No shrinker ran — budget diagnostics are absent.
        assert.equal(first.meta?.max_chars, undefined);
        assert.equal(first.meta?.truncated, false);

        // Second page — same `limit=2`, `offset=2` — alphabetical middle.
        const second = toolJson<TypesListResponseWithMeta>(
          await handle.client.callTool({
            name: 'etn.types.list',
            arguments: {
              network_id: ctx.networkId,
              scope: 'thoughts',
              limit: 2,
              offset: 2,
            },
          }),
        );
        assert.deepEqual(
          second.thought_types!.map((t) => t.name),
          ['Тип-3', 'Тип-4'],
        );
        assert.equal(second.meta?.limit, 2);
        assert.equal(second.meta?.offset, 2);

        // Third page — remainder (Тип-5 + the cyrillic root at the tail).
        const third = toolJson<TypesListResponseWithMeta>(
          await handle.client.callTool({
            name: 'etn.types.list',
            arguments: {
              network_id: ctx.networkId,
              scope: 'thoughts',
              limit: 2,
              offset: 4,
            },
          }),
        );
        assert.deepEqual(
          third.thought_types!.map((t) => t.name),
          ['Тип-5', 'основной тип'],
        );
        assert.equal(third.meta?.offset, 4);

        // Out-of-range offset — empty page, totals still echo the full count.
        const empty = toolJson<TypesListResponseWithMeta>(
          await handle.client.callTool({
            name: 'etn.types.list',
            arguments: {
              network_id: ctx.networkId,
              scope: 'thoughts',
              limit: 2,
              offset: 10,
            },
          }),
        );
        assert.deepEqual(empty.thought_types, []);
        assert.equal(empty.meta?.thought_types_total, TOTAL);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('limit/offset paginate thought_types and link_types independently', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      // 3 thought types + 2 link types on top of the seeded roots
      // (1 default thought type + 1 default link type) → totals are +1.
      // Cyrillic «А»/«Б»/«В» sort before the root type name «основной тип»
      // because «о» > «В» in SQLite's default BINARY collation.
      for (const name of ['Б', 'В', 'А']) {
        createThoughtType(ndb, { name }, ctx.adminId);
      }
      createLinkType(ndb, { name_forward: 'foo', name_reverse: 'oof' }, ctx.adminId);
      createLinkType(ndb, { name_forward: 'bar', name_reverse: 'rab' }, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const page0 = toolJson<TypesListResponseWithMeta>(
          await handle.client.callTool({
            name: 'etn.types.list',
            arguments: {
              network_id: ctx.networkId,
              limit: 1,
              offset: 0,
            },
          }),
        );
        // Each catalogue contributes 1 entry (its alphabetical head).
        assert.equal(page0.thought_types?.length, 1);
        assert.equal(page0.link_types?.length, 1);
        // The cyrillic head — «А» sorts before any latin letter in BINARY.
        assert.equal(page0.thought_types![0]?.name, 'А');
        // Default root link type sorts after the latin «bar»/«foo» names.
        assert.equal(page0.link_types![0]?.name_forward, 'bar');
        assert.equal(page0.meta?.thought_types_total, 4);
        assert.equal(page0.meta?.link_types_total, 3);

        const page1 = toolJson<TypesListResponseWithMeta>(
          await handle.client.callTool({
            name: 'etn.types.list',
            arguments: {
              network_id: ctx.networkId,
              limit: 1,
              offset: 1,
            },
          }),
        );
        assert.equal(page1.thought_types![0]?.name, 'Б');
        assert.equal(page1.link_types![0]?.name_forward, 'foo');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('limit > 500 → Zod 422 (sane upper bound)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const tooBig = await handle.client.callTool({
          name: 'etn.types.list',
          arguments: {
            network_id: ctx.networkId,
            scope: 'thoughts',
            limit: 501,
          },
        });
        assert.equal(tooBig.isError, true);
        assert.match(toolText(tooBig), /Invalid arguments/);

        const negative = await handle.client.callTool({
          name: 'etn.types.list',
          arguments: {
            network_id: ctx.networkId,
            scope: 'thoughts',
            offset: -1,
          },
        });
        assert.equal(negative.isError, true);
        assert.match(toolText(negative), /Invalid arguments/);

        const tooSmall = await handle.client.callTool({
          name: 'etn.types.list',
          arguments: {
            network_id: ctx.networkId,
            scope: 'thoughts',
            max_chars: 500,
          },
        });
        assert.equal(tooSmall.isError, true);
        assert.match(toolText(tooSmall), /Invalid arguments/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('max_chars shrinks descriptions softly (reason=max_chars_preview)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      // Each type carries a 1500-char description; 3 such entries (+ the
      // seeded root type) easily exceed a 2000-char budget for the *whole*
      // JSON envelope — but the shrunk previews (≤200 chars) fit, so the
      // soft step alone is enough.
      //
      // 0.8.1: бюджет поднят с 6000 до 8000 — DTO каждого типа мысли
      // теперь несёт поле `side` привязки свойства-связи и более длинные
      // описания; soft shrink всё ещё укладывает, drop entries не нужен.
      const long = 'x'.repeat(1500);
      for (const name of ['Альфа', 'Бета', 'Гамма']) {
        createThoughtType(
          ndb,
          { name, description: long },
          ctx.adminId,
        );
      }

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const truncated = toolJson<TypesListResponseWithMeta>(
          await handle.client.callTool({
            name: 'etn.types.list',
            arguments: {
              network_id: ctx.networkId,
              scope: 'thoughts',
              max_chars: 8000,
            },
          }),
        );
        // Soft step landed — no entries dropped, every description clipped
        // to the budget preview floor (200 chars). The total catalogue is
        // 4 entries (3 seeds + 1 root; корень несёт структурные «Родители»/
        // «Потомки», поэтому бюджет поднят относительно доклада 0.7.3).
        assert.equal(truncated.thought_types?.length, 4, 'no entries dropped');
        for (const t of truncated.thought_types!) {
          if (t.description !== null) {
            assert.ok(
              t.description.length <= 200,
              `description must be <= 200 chars after shrink, got ${t.description.length}`,
            );
          }
        }
        assert.equal(truncated.meta?.truncated, true);
        assert.equal(truncated.meta?.reason, 'max_chars_preview');
        assert.equal(truncated.meta?.max_chars, 8000);
        assert.ok(
          (truncated.meta?.original_chars ?? 0) > 8000,
          'original_chars must exceed budget',
        );
        assert.ok(
          (truncated.meta?.final_chars ?? 0) <= 8000,
          'final_chars must fit under budget',
        );
        assert.equal(truncated.meta?.thought_types_total, 4);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('max_chars drops tail entries when soft shrink is not enough (reason=max_chars_items)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      // 5 thought types (plus the seeded root); each carries a moderate
      // description. A 1200-char budget is tight enough that even the
      // 200-char previews cannot fit — the shrinker must drop entries
      // from the tail.
      const desc = 'y'.repeat(1500);
      for (const name of ['Тип-1', 'Тип-2', 'Тип-3', 'Тип-4', 'Тип-5']) {
        createThoughtType(ndb, { name, description: desc }, ctx.adminId);
      }
      const TOTAL = 6;

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const truncated = toolJson<TypesListResponseWithMeta>(
          await handle.client.callTool({
            name: 'etn.types.list',
            arguments: {
              network_id: ctx.networkId,
              scope: 'thoughts',
              max_chars: 1200,
            },
          }),
        );
        assert.equal(truncated.meta?.truncated, true);
        assert.equal(truncated.meta?.reason, 'max_chars_items');
        assert.ok(
          (truncated.thought_types?.length ?? 0) < TOTAL,
          'tail entries must be dropped',
        );
        // Diagnostics echo the un-trimmed catalogue size.
        assert.equal(truncated.meta?.thought_types_total, TOTAL);
        assert.ok((truncated.meta?.final_chars ?? 0) <= 1200);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('legacy callers (no new params) get the original payload — no `meta` block', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      createThoughtType(
        ndb,
        { name: 'Наследие', description: 'старый контракт без пагинации' },
        ctx.adminId,
      );
      createLinkType(
        ndb,
        { name_forward: 'legacy', name_reverse: 'наследие' },
        ctx.adminId,
      );

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const listed = toolJson<TypesListResponseWithMeta>(
          await handle.client.callTool({
            name: 'etn.types.list',
            arguments: { network_id: ctx.networkId },
          }),
        );
        // The legacy envelope had no `meta` field — guard against
        // accidentally leaking it for callers that did not opt in.
        assert.equal(listed.meta, undefined, 'meta block must be absent without new params');
        // The catalogue itself is unchanged.
        assert.ok(
          (listed.thought_types ?? []).some((t) => t.name === 'Наследие'),
          'legacy thought_types catalogue must be returned verbatim',
        );
        assert.ok(
          (listed.link_types ?? []).some((t) => t.name_forward === 'legacy'),
          'legacy link_types catalogue must be returned verbatim',
        );
        // And the description on the seeded type is NOT clipped (it never
        // would have been by the legacy tool either).
        const наследие = listed.thought_types!.find((t) => t.name === 'Наследие')!;
        assert.equal(наследие.description, 'старый контракт без пагинации');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('limit without max_chars surfaces totals via `meta` but does not truncate', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      for (const name of ['Тип-A', 'Тип-B', 'Тип-C']) {
        createThoughtType(ndb, { name }, ctx.adminId);
      }

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const paged = toolJson<TypesListResponseWithMeta>(
          await handle.client.callTool({
            name: 'etn.types.list',
            arguments: {
              network_id: ctx.networkId,
              scope: 'thoughts',
              limit: 2,
              offset: 0,
            },
          }),
        );
        assert.equal(paged.thought_types?.length, 2);
        assert.equal(paged.meta?.limit, 2);
        assert.equal(paged.meta?.offset, 0);
        assert.equal(paged.meta?.truncated, false);
        assert.equal(paged.meta?.reason, null);
        assert.equal(paged.meta?.thought_types_total, 4);
        assert.equal(paged.meta?.max_chars, undefined, 'max_chars absent when not requested');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
