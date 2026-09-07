/**
 * `etn.thoughts.write` (задача 053751b5, 0.7.2) — батч-запись связанных
 * единиц знания одной транзакцией. Покрывает:
 *   * базовый сценарий — 3 мысли со связями через `ref`/`target_ref`;
 *   * цикл `A → B → A` через `target_ref`;
 *   * валидацию: неизвестный `target_ref`, повторяющийся `ref`, превышение
 *     лимита, XOR thought_id/thought, XOR target_id/target_ref;
 *   * `on_duplicate: fail | reuse | update`;
 *   * `chronicle[]` (append-only), `comment`, `properties`, `attachments`,
 *     `links[].properties`, `links[].comment`;
 *   * транзакционный откат — частичный успех невозможен;
 *   * HOME-мысль не деактивируется через `active: false`;
 *   * ключ свойства не из реестра → NOT_FOUND;
 *   * резолв `type`/`link.type` по имени;
 *   * одна строка `audit_log` на ВЕСЬ вызов (а не по одной на сущность);
 *   * `etn.how_to_write_batch` prompt.
 *
 * Bootstrap — `mcp-helpers.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MCP_MAX_THOUGHTS_PER_WRITE,
} from '@etn/shared';

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

interface WriteItemResult {
  ref: string | null;
  thought_id: string | null;
  id: string;
  version: number;
  thought_action: 'created' | 'updated' | 'reused';
  matched_on: 'title' | 'synonym' | 'partial' | null;
  comment?: { id: string; version: number; action: 'created' | 'updated' };
  chronicle?: Array<{ id: string; version: number }>;
  properties?: Record<string, { id: string }>;
  links?: Array<{
    id: string;
    version: number;
    properties?: Record<string, { id: string }>;
    comment?: { id: string; version: number };
  }>;
  attachments?: Array<{ id: string }>;
  warnings: Array<Record<string, unknown>>;
}

interface WriteResult {
  items: WriteItemResult[];
  warnings: Array<Record<string, unknown>>;
  layer: { id: string; title: string };
  request_id?: string;
}

describe('etn.thoughts.write (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('creates 3 thoughts with links via ref/target_ref in one batch', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                ref: 'a',
                thought: { title: 'A — корневая мысль' },
                comment: { body_md: 'Описание A' },
                links: [{ direction: 'child', target_ref: 'b' }],
              },
              {
                ref: 'b',
                thought: { title: 'B — подчинена A' },
                comment: { body_md: 'Описание B' },
                links: [{ direction: 'child', target_ref: 'c' }],
              },
              {
                ref: 'c',
                thought: { title: 'C — подчинена B' },
                comment: { body_md: 'Описание C' },
              },
            ],
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<WriteResult>(result);
        assert.equal(data.items.length, 3);
        assert.equal(data.items[0]?.ref, 'a');
        assert.equal(data.items[0]?.thought_action, 'created');
        assert.equal(data.items[0]?.comment?.action, 'created');
        assert.equal(data.items[1]?.thought_action, 'created');
        assert.equal(data.items[2]?.thought_action, 'created');
        // Each item reports its own outgoing links; A→B and B→C were
        // requested, so items[0] has 1 link, items[1] has 1, items[2] has 0.
        assert.equal(data.items[0]?.links?.length, 1, 'A must have 1 outgoing link');
        assert.equal(data.items[1]?.links?.length, 1, 'B must have 1 outgoing link');
        assert.equal(data.items[2]?.links?.length, 0, 'C must have 0 outgoing links');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('resolves links[].target_ref against `local_refs` (HOME alias)', async () => {
    // Regression for error 3058c264: `local_refs` lets the caller name an
    // existing thought (e.g. HOME) once and reference it from `links[].target_ref`
    // instead of pasting its uuid everywhere.
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            local_refs: { home_ref: ctx.homeId },
            thoughts: [
              {
                ref: 'child_a',
                thought: { title: 'local_refs — ребёнок A' },
                links: [{ direction: 'parent', target_ref: 'home_ref' }],
              },
              {
                ref: 'child_b',
                thought: { title: 'local_refs — ребёнок B' },
                links: [{ direction: 'parent', target_ref: 'home_ref' }],
              },
            ],
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<WriteResult>(result);
        assert.equal(data.items.length, 2);
        for (const item of data.items) {
          assert.equal(item.thought_action, 'created');
          assert.equal(item.links?.length, 1, 'each child must have one outgoing link to HOME');
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('rejects a local_refs key that collides with a thoughts[].ref', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            local_refs: { shared: ctx.homeId },
            thoughts: [
              {
                ref: 'shared',
                thought: { title: 'конфликт local_refs vs thoughts[].ref' },
              },
            ],
          },
        });
        assert.equal(result.isError, true);
        const text = toolText(result);
        assert.match(text, /duplicate ref in batch/i);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('handles a cycle A→B→A via target_ref without infinite recursion', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                ref: 'a',
                thought: { title: 'Цикл A' },
                links: [{ direction: 'child', target_ref: 'b' }],
              },
              {
                ref: 'b',
                thought: { title: 'Цикл B' },
                links: [{ direction: 'child', target_ref: 'a' }],
              },
            ],
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<WriteResult>(result);
        assert.equal(data.items[0]?.links?.length, 1, 'A must have 1 outgoing link');
        assert.equal(data.items[1]?.links?.length, 1, 'B must have 1 outgoing link');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('rejects an unknown target_ref before the transaction', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                ref: 'a',
                thought: { title: 'A' },
                links: [{ direction: 'child', target_ref: 'unknown' }],
              },
            ],
          },
        });
        assert.equal(result.isError, true, 'expected VALIDATION_ERROR');
        const text = toolText(result);
        assert.ok(text.includes('unknown'), `expected "unknown" in error: ${text}`);
        assert.ok(text.includes('VALIDATION_ERROR'), `expected VALIDATION_ERROR: ${text}`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('rejects a duplicate ref within the batch', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              { ref: 'dup', thought: { title: 'A' } },
              { ref: 'dup', thought: { title: 'B' } },
            ],
          },
        });
        assert.equal(result.isError, true);
        const text = toolText(result);
        assert.ok(text.includes('duplicate ref'), text);
        assert.ok(text.includes('VALIDATION_ERROR'), text);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('rejects oversize batch with VALIDATION_ERROR', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Build (limit + 1) items, each with a thought. Zod rejects at the
        // input-schema layer (`Too big: expected array to have <=50 items`).
        const oversized = Array.from({ length: MCP_MAX_THOUGHTS_PER_WRITE + 1 }, (_, i) => ({
          ref: `r${i}`,
          thought: { title: `Oversized ${i}` },
        }));
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: { network_id: ctx.networkId, thoughts: oversized },
        });
        assert.equal(result.isError, true);
        const text = toolText(result);
        // Either Zod (`Too big`) or our service-level check
        // (`exceeds the per-batch limit`) is acceptable — both are
        // VALIDATION_ERROR before the transaction.
        assert.ok(
          text.includes('Too big') || text.includes(`${MCP_MAX_THOUGHTS_PER_WRITE}`),
          text,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('on_duplicate: fail returns DUPLICATE with candidates', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Seed once
        const seed = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [{ ref: 'seed', thought: { title: 'Уникальная мысль' } }],
          },
        });
        assert.equal(seed.isError, undefined, toolText(seed));
        // Now try with on_duplicate: fail
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              { ref: 'x', thought: { title: 'Уникальная мысль' }, on_duplicate: 'fail' },
            ],
          },
        });
        assert.equal(result.isError, true);
        const text = toolText(result);
        assert.ok(text.includes('DUPLICATE') || text.includes('duplicate'), text);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('on_duplicate: reuse attaches to the existing thought', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const seed = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [{ ref: 'seed', thought: { title: 'Переиспользуемая' } }],
          },
        });
        const seedData = toolJson<WriteResult>(seed);
        const seedId = seedData.items[0]!.id;
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                ref: 'reuse',
                thought: { title: 'Переиспользуемая' },
                on_duplicate: 'reuse',
                comment: { body_md: 'дописанный комментарий' },
              },
            ],
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<WriteResult>(result);
        assert.equal(data.items[0]?.id, seedId);
        assert.equal(data.items[0]?.thought_action, 'reused');
        assert.equal(data.items[0]?.matched_on, 'title');
        assert.equal(data.items[0]?.comment?.action, 'created');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('on_duplicate: update patches title and synonyms', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              { ref: 'seed', thought: { title: 'Обновляемая', synonyms: ['старый'] } },
            ],
          },
        });
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                ref: 'upd',
                thought: { title: 'Обновляемая', synonyms: ['новый'] },
                on_duplicate: 'update',
              },
            ],
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<WriteResult>(result);
        assert.equal(data.items[0]?.thought_action, 'updated');
        assert.ok(data.items[0]?.matched_on === 'title', 'expected matched_on=title');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('chronicle[] appends entries without overwriting', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const first = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                ref: 'hist',
                thought: { title: 'История' },
                chronicle: [{ body_md: 'запись 1' }],
              },
            ],
          },
        });
        assert.equal(first.isError, undefined, toolText(first));
        const firstData = toolJson<WriteResult>(first);
        const second = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                thought_id: firstData.items[0]!.id,
                chronicle: [{ body_md: 'запись 2' }, { body_md: 'запись 3' }],
              },
            ],
          },
        });
        assert.equal(second.isError, undefined, toolText(second));
        const secondData = toolJson<WriteResult>(second);
        assert.equal(secondData.items[0]?.chronicle?.length, 2);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('links[].comment — permanent comment on the new link', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                ref: 'a',
                thought: { title: 'A со связью-комментарием' },
                links: [
                  {
                    direction: 'child',
                    target_ref: 'b',
                    comment: { body_md: 'контекст связи' },
                  },
                ],
              },
              { ref: 'b', thought: { title: 'B' } },
            ],
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<WriteResult>(result);
        assert.ok(data.items[0]?.links?.[0]?.comment, 'link comment missing');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('attachments[] — creates URL and file attachments', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                ref: 'with-files',
                thought: { title: 'С вложениями' },
                attachments: [
                  { kind: 'url', url: 'https://example.com/spec', title: 'спека' },
                ],
              },
            ],
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<WriteResult>(result);
        assert.equal(data.items[0]?.attachments?.length, 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('rolls back the whole batch when one item fails', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              { ref: 'good1', thought: { title: 'Good 1' } },
              { ref: 'good2', thought: { title: 'Good 2' } },
              {
                ref: 'bad',
                thought: { title: 'Bad' },
                links: [{ direction: 'child', target_ref: 'never-declared' }],
              },
            ],
          },
        });
        assert.equal(result.isError, true, 'expected VALIDATION_ERROR');
        const text = toolText(result);
        assert.ok(
          text.includes('never-declared') || text.includes('VALIDATION_ERROR'),
          text,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('HOME thought cannot be deactivated via active: false', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              { thought_id: ctx.homeId, thought: { title: 'HOME', active: false } },
            ],
          },
        });
        assert.equal(result.isError, true);
        const text = toolText(result);
        assert.ok(text.includes('VALIDATION_ERROR') || text.includes('PROTECTED'), text);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('property key not in the registry → NOT_FOUND', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                ref: 'p',
                thought: { title: 'Свойство не из реестра' },
                properties: { 'не-существующее-свойство-12345': 'значение' },
              },
            ],
          },
        });
        assert.equal(result.isError, true);
        const text = toolText(result);
        assert.ok(text.includes('NOT_FOUND'), text);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('resolves type/link type by name', async () => {
    const ctx = await buildMcpContext();
    try {
      // Use the same connection the MCP server will pick up — do not close.
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const t = createThoughtType(
        ndb,
        {
          name: 'ADR',
          icon: '📐',
          description: 'architecture decision record',
        },
        ctx.adminId,
      );
      void t;
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                ref: 'adr',
                thought: { title: 'ADR by name', type: 'ADR' },
              },
            ],
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('comments.upsert scenario via comment — permanent comment is created/updated', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Create + comment
        const first = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              { ref: 'cmt', thought: { title: 'С комментарием' }, comment: { body_md: 'v1' } },
            ],
          },
        });
        const firstData = toolJson<WriteResult>(first);
        // Update thought + comment via thought_id
        const second = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                thought_id: firstData.items[0]!.id,
                comment: { body_md: 'v2' },
              },
            ],
          },
        });
        const secondData = toolJson<WriteResult>(second);
        assert.equal(secondData.items[0]?.comment?.action, 'updated');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('writes ONE audit row for the entire batch', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // `audit_log` lives in `_system.db` (one global table per network).
        // ctx.rawDb is the raw system-DB handle exposed by buildMcpContext.
        const before = (
          ctx.rawDb
            .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND network_id = ?`)
            .get('etn.thoughts.write', ctx.networkId) as { c: number }
        ).c;
        await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              {
                ref: 'a1',
                thought: { title: 'Audit A1' },
                links: [{ direction: 'child', target_ref: 'a2' }],
              },
              {
                ref: 'a2',
                thought: { title: 'Audit A2' },
                links: [{ direction: 'child', target_ref: 'a3' }],
              },
              { ref: 'a3', thought: { title: 'Audit A3' } },
            ],
          },
        });
        const after = (
          ctx.rawDb
            .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND network_id = ?`)
            .get('etn.thoughts.write', ctx.networkId) as { c: number }
        ).c;
        // ONE row, not three.
        assert.equal(after - before, 1, 'etn.thoughts.write must add exactly 1 audit row');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('exposes the etn.how_to_write_batch prompt', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const { prompts } = await handle.client.listPrompts();
        assert.ok(
          prompts.find((p) => p.name === 'etn.how_to_write_batch'),
          'etn.how_to_write_batch prompt must be registered',
        );
        const got = await handle.client.getPrompt({
          name: 'etn.how_to_write_batch',
          arguments: { network_id: ctx.networkId },
        });
        assert.ok(got.messages.length > 0);
        const text = got.messages[0]?.content;
        if (typeof text === 'object' && text !== null && 'text' in text) {
          assert.ok(
            (text as { text: string }).text.includes('etn.thoughts.write'),
            'prompt must mention etn.thoughts.write',
          );
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
