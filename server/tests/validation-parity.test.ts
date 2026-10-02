/**
 * Паритет ошибок валидации REST ↔ MCP (задача c9d5f21e, веха 8 версии 0.8.2).
 *
 * Одна схема на операцию: одинаковый невалидный вход даёт одинаковый код
 * (`VALIDATION_ERROR`) и одинаковое сообщение в обоих фасадах. REST шлёт
 * `{ error: { code, message } }` с HTTP 422; MCP — `isError` с текстом
 * `ETN error [CODE]: message` (префикс — стандарт MCP-фасада).
 *
 * Операции набора представительны: чтение с перечислением (слои, типы),
 * запись с обязательными полями (слои, свойства), вложенный объект
 * (правка мысли), XOR-пары (properties.set) и лимиты (types.list).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  callOp,
  buildMcpContext, closeMcpContext, connectMcpClient, toolText,
} from './mcp-helpers.js';
import { authHeaders, buildRestContext, closeRestContext } from './rest-helpers.js';

/** Совместить REST-мир с MCP-сервером поверх него (тот же admin + сеть). */
async function pairedWorld() {
  const rest = await buildRestContext();
  const mcp = await buildMcpContext({
    dataDir: rest.dataDir,
    networkId: rest.networkId,
    systemDb: rest.sys,
  });
  const handle = await connectMcpClient(mcp, rest.adminKey);
  return { rest, mcp, handle };
}

async function closeWorld(w: Awaited<ReturnType<typeof pairedWorld>>): Promise<void> {
  await w.handle.close();
  await closeMcpContext(w.mcp, { dataDir: w.rest.dataDir, networkId: w.rest.networkId, systemDb: w.rest.sys });
  await closeRestContext(w.rest);
}

interface RestError {
  error: { code: string; message: string };
}

/** МCP-текст `ETN error [CODE]: message` → { code, message }. */
function mcpErrorParts(text: string): { code: string; message: string } {
  const m = /^ETN error \[([A-Z_]+)\]: (.*)$/s.exec(text);
  assert.ok(m !== null, `ожидался канонический MCP-текст ошибки: ${text}`);
  return { code: m![1]!, message: m![2]!.split('\nDetails:')[0]! };
}

describe('паритет валидации REST ↔ MCP (c9d5f21e)', () => {
  it('etn.layers.create ↔ POST /layers: title не строкой — код и сообщение совпадают', async () => {
    const w = await pairedWorld();
    try {
      const restRes = await w.rest.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${w.rest.networkId}/layers`,
        headers: authHeaders(w.rest),
        payload: { title: 123 },
      });
      assert.equal(restRes.statusCode, 422);
      const restErr = restRes.json() as RestError;
      assert.equal(restErr.error.code, 'VALIDATION_ERROR');

      const mcpRes = await callOp(w.handle.client, 'layers.create', { network_id: w.rest.networkId, title: 123 });
      assert.equal(mcpRes.isError, true);
      const mcpErr = mcpErrorParts(toolText(mcpRes));
      assert.equal(mcpErr.code, restErr.error.code);
      assert.equal(mcpErr.message, restErr.error.message);
    } finally {
      await closeWorld(w);
    }
  });

  it('etn.layers.create ↔ POST /layers: title пустой — код и сообщение совпадают', async () => {
    const w = await pairedWorld();
    try {
      const restRes = await w.rest.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${w.rest.networkId}/layers`,
        headers: authHeaders(w.rest),
        payload: { title: '' },
      });
      assert.equal(restRes.statusCode, 422);
      const restErr = restRes.json() as RestError;

      const mcpRes = await callOp(w.handle.client, 'layers.create', { network_id: w.rest.networkId, title: '' });
      assert.equal(mcpRes.isError, true);
      const mcpErr = mcpErrorParts(toolText(mcpRes));
      assert.equal(mcpErr.code, restErr.error.code);
      assert.equal(mcpErr.message, restErr.error.message);
    } finally {
      await closeWorld(w);
    }
  });

  it('etn.instructions ↔ GET /instructions: XOR instruction_id+keywords — код и сообщение совпадают', async () => {
    const w = await pairedWorld();
    try {
      const restRes = await w.rest.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${w.rest.networkId}/instructions?instruction_id=x&keywords=y`,
        headers: authHeaders(w.rest),
      });
      assert.equal(restRes.statusCode, 422);
      const restErr = restRes.json() as RestError;
      assert.equal(restErr.error.code, 'VALIDATION_ERROR');

      const mcpRes = await w.handle.client.callTool({
        name: 'etn.instructions',
        arguments: { network_id: w.rest.networkId, instruction_id: 'x', keywords: 'y' },
      });
      assert.equal(mcpRes.isError, true);
      const mcpErr = mcpErrorParts(toolText(mcpRes));
      assert.equal(mcpErr.code, restErr.error.code);
      assert.equal(mcpErr.message, restErr.error.message);
    } finally {
      await closeWorld(w);
    }
  });

  it('etn.locks.acquire ↔ POST /locks: entity_type не строкой — код и сообщение совпадают', async () => {
    const w = await pairedWorld();
    try {
      const restRes = await w.rest.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${w.rest.networkId}/locks`,
        headers: authHeaders(w.rest),
        payload: { entity_type: 123, entity_id: 'x' },
      });
      assert.equal(restRes.statusCode, 422);
      const restErr = restRes.json() as RestError;

      const mcpRes = await callOp(w.handle.client, 'locks.acquire', { network_id: w.rest.networkId, entity_type: 123, entity_id: 'x' });
      assert.equal(mcpRes.isError, true);
      const mcpErr = mcpErrorParts(toolText(mcpRes));
      assert.equal(mcpErr.code, restErr.error.code);
      assert.equal(mcpErr.message, restErr.error.message);
    } finally {
      await closeWorld(w);
    }
  });

  it('etn.types.list: limit > 500 — канонический код и сообщение', async () => {
    const w = await pairedWorld();
    try {
      const mcpRes = await w.handle.client.callTool({
        name: 'etn.types.list',
        arguments: { network_id: w.rest.networkId, limit: 501 },
      });
      assert.equal(mcpRes.isError, true);
      const mcpErr = mcpErrorParts(toolText(mcpRes));
      assert.equal(mcpErr.code, 'VALIDATION_ERROR');
      assert.equal(mcpErr.message, 'limit должен быть целым числом не больше 500.');
    } finally {
      await closeWorld(w);
    }
  });

  // Ошибка 8577d41d: MCP на ОТСУТСТВУЮЩЕЕ обязательное поле отдавал текст
  // zod-схемы («должен быть строкой.»), а REST — каноническую «{key}
  // обязателен.». Отсутствие поля отличается от неверного типа по сырому
  // входу (zod 4 убрал признак `received`).
  it('etn.publications.create ↔ POST /publications: отсутствие title — каноническое «title обязателен.»', async () => {
    const w = await pairedWorld();
    try {
      const restRes = await w.rest.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${w.rest.networkId}/publications`,
        headers: authHeaders(w.rest),
        payload: {},
      });
      assert.equal(restRes.statusCode, 422);
      const restErr = restRes.json() as RestError;

      const mcpRes = await w.handle.client.callTool({
        name: 'etn.publications.create',
        arguments: { network_id: w.rest.networkId },
      });
      assert.equal(mcpRes.isError, true);
      const mcpErr = mcpErrorParts(toolText(mcpRes));
      assert.equal(mcpErr.code, restErr.error.code);
      assert.equal(mcpErr.message, 'title обязателен.');
      assert.equal(mcpErr.message, restErr.error.message, 'MCP и REST дают одинаковый текст');
    } finally {
      await closeWorld(w);
    }
  });

  it('etn.layers.select: отсутствие layer_id — «обязателен», неверный тип — прежний текст', async () => {
    const w = await pairedWorld();
    try {
      const missing = await w.handle.client.callTool({
        name: 'etn.layers.select',
        arguments: { network_id: w.rest.networkId },
      });
      assert.equal(missing.isError, true);
      assert.equal(mcpErrorParts(toolText(missing)).message, 'layer_id обязателен.');

      const wrongType = await w.handle.client.callTool({
        name: 'etn.layers.select',
        arguments: { network_id: w.rest.networkId, layer_id: 123 },
      });
      assert.equal(wrongType.isError, true);
      assert.equal(mcpErrorParts(toolText(wrongType)).message, 'layer_id должен быть строкой.');
    } finally {
      await closeWorld(w);
    }
  });
});
