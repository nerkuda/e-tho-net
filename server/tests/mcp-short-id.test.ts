/**
 * Короткие id мыслей (ошибка d8893a1f-e35e-4b4a-af40-391f992d28fc).
 *
 * Агенты используют hex-префикс UUID вместо полного id. Проверяем:
 *   * доменный резолвер `resolveThoughtId` (полная/короткая/неоднозначная
 *     формы);
 *   * границу MCP: инструменты принимают обе формы (чтение и запись),
 *     неоднозначный префикс даёт ошибку со списком кандидатов.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import type { NetworkDb } from '../src/db/network-db.js';
import { resolveThoughtId, isIdPrefix, isFullUuid } from '../src/domain/thought-id.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

/** Фейковый NetworkDb: `prepare(...).all()` отдаёт подставленные строки id. */
function fakeDb(ids: string[]): NetworkDb {
  return {
    prepare: () => ({
      all: () => ids.map((id) => ({ id })),
    }),
  } as unknown as NetworkDb;
}

const FULL = 'ec5ba58c-7876-45b4-8e1d-1487eb767023';

describe('resolveThoughtId (domain)', () => {
  it('полный UUID возвращается нормализованным без обращения к БД', () => {
    const db = {
      prepare: () => {
        throw new Error('полный id не должен ходить в БД');
      },
    } as unknown as NetworkDb;
    assert.equal(resolveThoughtId(db, FULL.toUpperCase()), FULL);
    assert.equal(isFullUuid(FULL), true);
  });

  it('короткий однозначный префикс резолвится в полный id', () => {
    assert.equal(resolveThoughtId(fakeDb([FULL]), 'ec5ba58c'), FULL);
    assert.equal(isIdPrefix('ec5ba58c'), true);
  });

  it('короткий префикс без совпадений даёт null', () => {
    assert.equal(resolveThoughtId(fakeDb([]), 'ec5ba58c'), null);
  });

  it('неоднозначный префикс — VALIDATION_ERROR со списком кандидатов', () => {
    const a = 'ab12cd34-1111-4222-8333-444455556666';
    const b = 'ab12cd34-7777-4888-8999-aaaabbbbcccc';
    try {
      resolveThoughtId(fakeDb([a, b]), 'ab12cd34');
      assert.fail('ожидалась ошибка неоднозначности');
    } catch (err) {
      assert.ok(err instanceof EtnError);
      assert.equal(err.code, 'VALIDATION_ERROR');
      assert.deepEqual((err.details as { candidates: string[] }).candidates, [a, b]);
    }
  });

  it('строка, не похожая на id, возвращается как есть', () => {
    assert.equal(resolveThoughtId(fakeDb([]), 'мысль о море'), 'мысль о море');
    assert.equal(resolveThoughtId(fakeDb([]), 'abc'), 'abc');
  });
});

describe('MCP: короткие id мыслей', { skip: !nativeAvailable() }, () => {
  it('чтение по короткому префиксу находит ту же мысль, что по полному id', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Мысль для короткого id',
          link: { direction: 'parent', target_thought_id: ctx.homeId },
        });
        const full = created.id;
        const short = full.slice(0, 8);

        // Полный id — как раньше.
        const byFull = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: full },
        });
        assert.equal(toolJson<{ id: string }>(byFull).id, full);

        // Короткий префикс — та же мысль.
        const byShort = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: short },
        });
        assert.equal(toolJson<{ id: string }>(byShort).id, full);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('граница MCP нормализует prefixed id в скалярных и массивных слотах', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const parent = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Родитель',
          link: { direction: 'parent', target_thought_id: ctx.homeId },
        });
        const child = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Потомок',
          link: { direction: 'parent', target_thought_id: parent.id },
        });
        const shortParent = parent.id.slice(0, 8);

        // Скалярный слот `in_subtree_of`.
        const subtree = await handle.client.callTool({
          name: 'etn.thoughts.query',
          arguments: { network_id: ctx.networkId, in_subtree_of: shortParent, max_depth: 1 },
        });
        const ids = toolJson<{ hits: Array<{ id: string }> }>(subtree).hits.map((t) => t.id);
        assert.ok(ids.includes(child.id));

        // Массивный слот `thought_ids` (resolve).
        const resolved = await handle.client.callTool({
          name: 'etn.thoughts.resolve',
          arguments: { network_id: ctx.networkId, thought_ids: [shortParent] },
        });
        const payload = toolJson<{ items: Array<{ id: string }>; missing: string[] }>(resolved);
        assert.deepEqual(payload.items.map((t) => t.id), [parent.id]);
        assert.deepEqual(payload.missing, []);

        // Слот записи `thought_id` (правка существующей мысли).
        const patched = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [{ thought_id: shortParent, title: 'Родитель (правка)' }],
          },
        });
        assert.equal(patched.isError, undefined);

        // Отсутствующий префикс — понятная ошибка, а не «тихий» мисс.
        const missing = await handle.client.callTool({
          name: 'etn.thoughts.get',
          arguments: { network_id: ctx.networkId, thought_id: 'deadbeef' },
        });
        assert.equal(missing.isError, true);
        assert.match(toolText(missing), /NOT_FOUND/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
