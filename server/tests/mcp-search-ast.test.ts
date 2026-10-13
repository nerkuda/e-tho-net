/**
 * Задача d5e8ddc1 (требование b91336e7, ADR 7581ac14): `etn.thoughts.search`
 * принимает `ast` мыслевых настроек (профиль `thoughts`).
 *
 * Проверяется через реальную MCP-сессию (production-фабрика `createMcpServer`):
 *   * `ast` исполняется единым движком (актуальность из AST, не плоский дефолт);
 *   * `ast` XOR плоские мыслевые параметры → `VALIDATION_ERROR`;
 *   * условие вне профиля `thoughts` → `VALIDATION_ERROR` (сценарий 55f31eee).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  nativeAvailable,
  toolText,
} from './mcp-helpers.js';

const skip = !nativeAvailable();

interface SearchHitJson {
  by_names: Array<{ thought_id: string; title: string }>;
  by_texts: unknown[];
}

describe('MCP etn.thoughts.search: ast-тело (d5e8ddc1)', { skip }, () => {
  it('ast принимается и исполняется; XOR и профиль валидируются', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const active = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Mcp active secret',
        });
        const inactive = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Mcp inactive secret',
          active: false,
        });

        // AST «только неактуальные»: единый движок чтит AST, а не плоский дефолт.
        const viaAst = await handle.client.callTool({
          name: 'etn.thoughts.search',
          arguments: {
            network_id: ctx.networkId,
            query: 'secret',
            scope: 'names',
            ast: {
              version: 1,
              filter: { entity: { kind: 'active' }, operator: 'eq', value: false },
            },
          },
        });
        assert.equal(viaAst.isError, undefined, toolText(viaAst));
        const parsed = JSON.parse(toolText(viaAst)) as SearchHitJson;
        assert.deepEqual(
          parsed.by_names.map((h) => h.thought_id),
          [inactive.id],
        );
        assert.ok(!parsed.by_names.some((h) => h.thought_id === active.id));

        // `ast` + плоский мыслевой параметр → VALIDATION_ERROR (XOR-схема).
        const conflict = await handle.client.callTool({
          name: 'etn.thoughts.search',
          arguments: {
            network_id: ctx.networkId,
            query: 'secret',
            ast: {
              version: 1,
              filter: { entity: { kind: 'active' }, operator: 'eq', value: true },
            },
            type_id: randomUUID(),
          },
        });
        assert.equal(conflict.isError, true);
        assert.match(toolText(conflict), /VALIDATION_ERROR/);

        // Условие вне профиля `thoughts` → VALIDATION_ERROR.
        const offProfile = await handle.client.callTool({
          name: 'etn.thoughts.search',
          arguments: {
            network_id: ctx.networkId,
            query: 'secret',
            ast: {
              version: 1,
              filter: { entity: { kind: 'record_title' }, operator: 'eq', value: 'x' },
            },
          },
        });
        assert.equal(offProfile.isError, true);
        assert.match(toolText(offProfile), /VALIDATION_ERROR/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
