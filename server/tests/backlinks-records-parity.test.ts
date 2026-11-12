/**
 * Сквозная проба 0.15.4 (задача 6af1be50, требования a9f455a4, 012b2dc6):
 * хроно-хиты поиска несут привязки записи (`targets`) и `use_time`, а
 * backlinks/mentions отдают union `MentionHit | RecordHit` с дискриминатором
 * `kind` у обоих вариантов — одна форма на MCP (инструмент, `etn.ops`, ресурс)
 * и REST (ADR db88d819).
 *
 * Почему in-process: полигон `etn-dev` исполняет СОБРАННЫЙ `server/dist` и
 * правок рабочей копии не видит — паритет контуров проверяется здесь реальным
 * MCP-клиентом поверх того же домена и REST-инъекцией (способ проверки указан
 * в отчёте задачи).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BacklinkHit, SearchChronoHit } from '@etn/shared';

import { createComment, createCommentWithTargets } from '../src/domain/comment-service.js';
import {
  apiCreateThought,
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable as restNativeAvailable,
  openNetworkDbSafe,
  type RestTestContext,
} from './rest-helpers.js';
import {
  buildMcpContext,
  callOp,
  closeMcpContext,
  connectMcpClient,
  toolJson,
} from './mcp-helpers.js';

const skip = !restNativeAvailable();

interface Scene {
  /** Мысль-цель: на неё ссылаются постоянный комментарий и дневниковая запись. */
  target: string;
  /** Владелец записи (первичная привязка). */
  owner: string;
  /** Вторая привязка записи. */
  second: string;
  /** Id дневниковой записи. */
  record: string;
}

/** Сцена: цель + запись с двумя привязками и `use_time` + постоянная ссылка. */
async function seedScene(rest: RestTestContext): Promise<Scene> {
  const create = async (title: string): Promise<string> => {
    const res = await apiCreateThought(rest, { title });
    assert.equal(res.statusCode, 201, JSON.stringify(res.data));
    return res.data['id'] as string;
  };
  const target = await create('Объект сцены');
  const owner = await create('Дневник сцены');
  const second = await create('Вторая привязка');

  const ndb = openNetworkDbSafe(rest.dataDir, rest.networkId);
  // Постоянный комментарий владельца — владельческая строка backlinks/mentions.
  createComment(
    ndb,
    'thought',
    owner,
    { kind: 'permanent', body_md: `постоянная ссылка [[#${target}]]` },
    rest.adminId,
  );
  const record = createCommentWithTargets(
    ndb,
    [
      { owner_type: 'thought', owner_id: owner },
      { owner_type: 'thought', owner_id: second },
    ],
    {
      kind: 'chronological',
      body_md: `запись про Объект сцены [[#${target}]]`,
      valid_from: '2024-02-02',
      use_time: true,
    },
    rest.adminId,
  );
  return { target, owner, second, record: record.id };
}

describe('backlinks/mentions: union и привязки в хроно-хитах (0.15.4)', { skip }, () => {
  it('MCP и REST отдают строки-записи рядом с владельческими строками', async () => {
    const rest = await buildRestContext();
    const mcp = await buildMcpContext({
      dataDir: rest.dataDir,
      networkId: rest.networkId,
      systemDb: rest.sys,
    });
    const handle = await connectMcpClient(mcp, rest.adminKey);
    try {
      const scene = await seedScene(rest);

      // --- MCP: etn.thoughts.search, группа by_chrono ----------------------
      const searchResult = await handle.client.callTool({
        name: 'etn.thoughts.search',
        arguments: { network_id: rest.networkId, query: 'Объект', scope: 'chronology' },
      });
      const search = toolJson<{ by_chrono: SearchChronoHit[] }>(searchResult);
      const hit = search.by_chrono.find((h) => h.comment_id === scene.record);
      assert.ok(hit !== undefined, 'хроно-хит представляет дневниковую запись');
      assert.equal(hit.use_time, true, 'MCP: use_time в хроно-хите');
      assert.deepEqual(
        hit.targets.map((t) => (t.kind === 'thought' ? t.thought.id : 'link')),
        [scene.owner, scene.second],
        'MCP: привязки записи, первичная первой',
      );

      // --- MCP: etn.ops thoughts.backlinks ---------------------------------
      const backlinks = toolJson<BacklinkHit[]>(
        await callOp(handle.client, 'thoughts.backlinks', {
          network_id: rest.networkId,
          thought_id: scene.target,
        }),
      );
      assert.deepEqual(
        backlinks.map((h) => h.kind),
        ['mention', 'record'],
        'MCP backlinks: владельческая строка + строка-запись',
      );
      const recordHit = backlinks[1]!;
      assert.equal(recordHit.kind, 'record');
      if (recordHit.kind === 'record') {
        assert.equal(recordHit.use_time, true);
        assert.equal(recordHit.valid_from, '2024-02-02T00:00:00.000Z');
        assert.equal(recordHit.owner_id, scene.owner);
        assert.equal(recordHit.targets.length, 2, 'привязки строки-записи');
      }

      // --- MCP: etn.ops thoughts.mentions ----------------------------------
      const mentions = toolJson<BacklinkHit[]>(
        await callOp(handle.client, 'thoughts.mentions', {
          network_id: rest.networkId,
          thought_id: scene.target,
        }),
      );
      assert.ok(
        mentions.every((h) => h.kind === 'mention' || h.kind === 'record'),
        'MCP mentions: дискриминатор kind у каждого варианта',
      );
      assert.ok(
        mentions.some((h) => h.kind === 'record' && h.comment_id === scene.record),
        'MCP mentions: дневниковая запись — строкой-записью',
      );

      // --- MCP: ресурс etn.thought.backlinks -------------------------------
      const resource = await handle.client.readResource({
        uri: `etn://networks/${rest.networkId}/thoughts/${scene.target}/backlinks`,
      });
      const block = resource.contents[0];
      assert.ok(block !== undefined && 'text' in block);
      const fromResource = JSON.parse(block.text) as BacklinkHit[];
      assert.deepEqual(
        fromResource.map((h) => h.kind),
        ['mention', 'record'],
        'MCP-ресурс отдаёт ту же union-форму',
      );

      // --- REST: та же форма ----------------------------------------------
      const restBacklinks = await rest.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${rest.networkId}/thoughts/${scene.target}/backlinks`,
        headers: authHeaders(rest),
      });
      assert.equal(restBacklinks.statusCode, 200);
      const restItems = (restBacklinks.json() as { data: BacklinkHit[] }).data;
      assert.deepEqual(
        restItems.map((h) => h.kind),
        ['mention', 'record'],
        'REST backlinks: union-форма паритетна MCP',
      );
      const restRecord = restItems[1]!;
      assert.equal(restRecord.kind, 'record');
      if (restRecord.kind === 'record') {
        assert.equal(restRecord.targets.length, 2, 'REST: привязки строки-записи на месте');
      }

      const restMentions = await rest.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${rest.networkId}/thoughts/${scene.target}/mentions`,
        headers: authHeaders(rest),
      });
      assert.equal(restMentions.statusCode, 200);
      const restMentionItems = (restMentions.json() as { data: BacklinkHit[] }).data;
      assert.ok(
        restMentionItems.some((h) => h.kind === 'record' && h.comment_id === scene.record),
        'REST mentions: дневниковая запись — строкой-записью',
      );
    } finally {
      await handle.close();
      await closeMcpContext(mcp);
      await closeRestContext(rest);
    }
  });
});
