/**
 * Паритет каталогов типов REST ↔ MCP.
 *
 * Сверяются два контура чтения онтологии сети:
 *
 *   * `GET /networks/:id/thought-types` ↔ `etn.types.list.thought_types`;
 *   * `GET /networks/:id/link-types` ↔ `etn.types.list.link_types`;
 *   * `GET /networks/:id/thought-types/:id` ↔ `etn.types.get { id, scope: thoughts }`;
 *   * `GET /networks/:id/link-types/:id` ↔ `etn.types.get { id, scope: links }`.
 *
 * Оба контура — фасады над одними доменными сервисами (`listThoughtTypes`,
 * `listLinkTypes`, `getThoughtType`, `getLinkType`), поэтому на одной фикстуре
 * обязаны совпадать набор id, порядок и пересекающиеся поля
 * (`id`/`name`/`parent_id`/`is_root`, у связи — `name_forward`/`name_reverse`).
 * Отдельно проверяется 404 на отсутствующем типе: `GET /link-types/:id` до
 * этого теста не покрывался вовсе.
 *
 * Пропускается, если нативный биндинг `better-sqlite3` недоступен.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
} from './rest-helpers.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  toolJson,
  toolText,
  type McpClientHandle,
  type McpTestContext,
} from './mcp-helpers.js';

/** Пересекающиеся поля типов мысли: REST row ↔ MCP entry. */
function pickThoughtType(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    parent_id: row.parent_id,
    is_root: row.is_root,
  };
}

/** Пересекающиеся поля типов связи: REST row ↔ MCP entry. */
function pickLinkType(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name_forward: row.name_forward,
    name_reverse: row.name_reverse,
    parent_id: row.parent_id,
    is_root: row.is_root,
  };
}

describe('паритет каталогов типов REST ↔ MCP', { skip: !nativeAvailable() }, () => {
  it('list и get совпадают по набору, порядку и полям; отсутствующий тип — 404 в обоих контурах', async () => {
    const restCtx = await buildRestContext();
    const overrides = {
      dataDir: restCtx.dataDir,
      systemDb: restCtx.sys,
      networkId: restCtx.networkId,
    };
    let mcpCtx: McpTestContext | undefined;
    let handle: McpClientHandle | undefined;
    try {
      // Фикстура — через доменные сервисы того же процесса: REST-маршруты
      // читают ту же `data.db`. Порядок создания намеренно не алфавитный:
      // совпадение порядка list-выдач обязано быть свойством сортировки, а
      // не порядка вставки.
      const ndb = restCtx.ndb;
      const alpha = createThoughtType(ndb, { name: 'Альфа' }, restCtx.adminId);
      const beta = createThoughtType(
        ndb,
        { name: 'Бета', parent_id: alpha.id, description: 'дочерний тип' },
        restCtx.adminId,
      );
      const zeta = createThoughtType(ndb, { name: 'Зета' }, restCtx.adminId);
      const linkForward = createLinkType(
        ndb,
        { name_forward: 'гамма-связь', name_reverse: 'гамма-обратная' },
        restCtx.adminId,
      );
      const linkChild = createLinkType(
        ndb,
        {
          name_forward: 'альфа-связь',
          name_reverse: 'альфа-обратная',
          parent_id: linkForward.id,
        },
        restCtx.adminId,
      );

      const restThoughtList = await restCtx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${restCtx.networkId}/thought-types`,
        headers: authHeaders(restCtx),
      });
      assert.equal(restThoughtList.statusCode, 200, restThoughtList.body);
      const restThoughts = restThoughtList.json().data as Array<Record<string, unknown>>;

      const restLinkList = await restCtx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${restCtx.networkId}/link-types`,
        headers: authHeaders(restCtx),
      });
      assert.equal(restLinkList.statusCode, 200, restLinkList.body);
      const restLinks = restLinkList.json().data as Array<Record<string, unknown>>;

      mcpCtx = await buildMcpContext(overrides);
      handle = await connectMcpClient(mcpCtx, restCtx.adminKey);

      // --- list: набор id и порядок -------------------------------------
      const listRes = await handle.client.callTool({
        name: 'etn.types.list',
        arguments: { network_id: restCtx.networkId },
      });
      assert.equal(listRes.isError, undefined, toolText(listRes));
      const mcpList = toolJson<{
        thought_types: Array<Record<string, unknown>>;
        link_types: Array<Record<string, unknown>>;
      }>(listRes);

      assert.deepEqual(
        mcpList.thought_types.map((t) => t.id),
        restThoughts.map((t) => t.id),
        'порядок id типов мыслей: REST и MCP совпадают',
      );
      assert.deepEqual(
        mcpList.link_types.map((t) => t.id),
        restLinks.map((t) => t.id),
        'порядок id типов связей: REST и MCP совпадают',
      );

      // Поля, которые обязаны совпадать у обоих контуров, — по каждому типу.
      assert.deepEqual(
        mcpList.thought_types.map(pickThoughtType),
        restThoughts.map(pickThoughtType),
        'пересекающиеся поля типов мыслей (id/name/parent_id/is_root)',
      );
      assert.deepEqual(
        mcpList.link_types.map(pickLinkType),
        restLinks.map(pickLinkType),
        'пересекающиеся поля типов связей (id/name_forward/name_reverse/parent_id/is_root)',
      );
      // Фикстура действительно попала в обе выдачи — иерархия проверена.
      for (const id of [alpha.id, beta.id, zeta.id]) {
        assert.ok(
          restThoughts.some((t) => t.id === id),
          `тип мысли ${id} отсутствует в REST-каталоге`,
        );
      }
      for (const id of [linkForward.id, linkChild.id]) {
        assert.ok(restLinks.some((t) => t.id === id), `тип связи ${id} отсутствует в REST-каталоге`);
      }
      assert.equal(
        restThoughts.find((t) => t.id === beta.id)?.parent_id,
        alpha.id,
        'иерархия типов мыслей сохранена (дочерний ссылается на родителя)',
      );
      assert.equal(
        restLinks.find((t) => t.id === linkChild.id)?.parent_id,
        linkForward.id,
        'иерархия типов связей сохранена',
      );

      // --- get по id: оба контура ---------------------------------------
      const restThought = await restCtx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${restCtx.networkId}/thought-types/${beta.id}`,
        headers: authHeaders(restCtx),
      });
      assert.equal(restThought.statusCode, 200, restThought.body);
      const thoughtRes = await handle.client.callTool({
        name: 'etn.types.get',
        arguments: { network_id: restCtx.networkId, id: beta.id, scope: 'thoughts' },
      });
      assert.equal(thoughtRes.isError, undefined, toolText(thoughtRes));
      const thoughtGet = toolJson<{ thought_types: Array<Record<string, unknown>> }>(thoughtRes);
      assert.equal(thoughtGet.thought_types.length, 1, 'ровно один тип мысли по id');
      assert.deepEqual(
        pickThoughtType(thoughtGet.thought_types[0]!),
        pickThoughtType(restThought.json().data as Record<string, unknown>),
        'GET /thought-types/:id ↔ etn.types.get: id/name/parent_id/is_root',
      );

      const restLink = await restCtx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${restCtx.networkId}/link-types/${linkChild.id}`,
        headers: authHeaders(restCtx),
      });
      assert.equal(restLink.statusCode, 200, restLink.body);
      const linkRes = await handle.client.callTool({
        name: 'etn.types.get',
        arguments: { network_id: restCtx.networkId, id: linkChild.id, scope: 'links' },
      });
      assert.equal(linkRes.isError, undefined, toolText(linkRes));
      const linkGet = toolJson<{ link_types: Array<Record<string, unknown>> }>(linkRes);
      assert.equal(linkGet.link_types.length, 1, 'ровно один тип связи по id');
      assert.deepEqual(
        pickLinkType(linkGet.link_types[0]!),
        pickLinkType(restLink.json().data as Record<string, unknown>),
        'GET /link-types/:id ↔ etn.types.get: id/name_forward/name_reverse/parent_id/is_root',
      );

      // --- отсутствующий тип: 404/NOT_FOUND в обоих контурах -------------
      const unknownId = randomUUID();
      const restMissingThought = await restCtx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${restCtx.networkId}/thought-types/${unknownId}`,
        headers: authHeaders(restCtx),
      });
      assert.equal(restMissingThought.statusCode, 404, 'GET /thought-types/:id — 404');
      assert.equal(restMissingThought.json().error.code, 'NOT_FOUND');

      // Ранее не покрытый маршрут: GET /link-types/:id.
      const restMissingLink = await restCtx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${restCtx.networkId}/link-types/${unknownId}`,
        headers: authHeaders(restCtx),
      });
      assert.equal(restMissingLink.statusCode, 404, 'GET /link-types/:id — 404');
      assert.equal(restMissingLink.json().error.code, 'NOT_FOUND');

      const mcpMissing = await handle.client.callTool({
        name: 'etn.types.get',
        arguments: { network_id: restCtx.networkId, id: unknownId },
      });
      assert.equal(mcpMissing.isError, true, 'etn.types.get по отсутствующему id — ошибка');
      assert.match(toolText(mcpMissing), /\[NOT_FOUND\]/);
    } finally {
      if (handle !== undefined) await handle.close();
      if (mcpCtx !== undefined) await closeMcpContext(mcpCtx, overrides);
      await closeRestContext(restCtx);
    }
  });
});
