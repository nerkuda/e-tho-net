/**
 * Сторож паритета REST ↔ MCP отбора хроники (0.10.1, задача T3 e674d8cc;
 * требования c6ddc1ea «Порядок ленты хроники», 306f74cc «Критерии отбора»,
 * 91f8d8dd «Динамические токены дат»).
 *
 * Новый запрет: сортировка ленты и состав критериев НЕ имеют собственной
 * реализации на фасадах — оба фасада обязаны собирать тело и исполнять один
 * доменный `queryChronicle`. До 0.10.1 сортировка (valid_from, valid_to,
 * title) и разбор периода жили в домене, но MCP-фасад собирал тело вручную:
 * забытое поле (как `targets` или токены периода) молча расходилось бы с REST.
 *
 * Сторож статический: читает исходники фасадов и контракт, а не гоняет две
 * базы. Функциональная часть (порядок и состав) проверена в
 * `chronicle-service.test.ts` на одном домене — здесь гарантируется, что
 * фасады не разъедутся в делегировании и прокидывании полей.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { NetworkDb } from '../src/db/network-db.js';
import { createComment, createCommentWithTargets } from '../src/domain/comment-service.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  toolJson,
} from './mcp-helpers.js';
import { authHeaders, buildRestContext, closeRestContext } from './rest-helpers.js';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const ROUTE = fs.readFileSync(path.join(SERVER_SRC, 'routes', 'chronicle.ts'), 'utf8');
const MCP = fs.readFileSync(path.join(SERVER_SRC, 'mcp', 'tools', 'chronicle.ts'), 'utf8');
const DOMAIN = fs.readFileSync(path.join(SERVER_SRC, 'domain', 'chronicle-service.ts'), 'utf8');
const CONTRACTS = fs.readFileSync(path.join(SERVER_SRC, 'contracts.ts'), 'utf8');

/** Поля периода/критериев 0.10.1, которые оба фасада обязаны прокинуть. */
const T3_FIELDS = ['targets', 'date_from', 'date_to'] as const;

const USER = 'guard-parity-user';

/** Seed a thought directly (same shape as the chronicle-service tests). */
function seedThought(ndb: NetworkDb, title: string, home = false): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, ?, ?, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase(), home ? 1 : 0, home ? 1 : 0);
  return id;
}

describe('guard: паритет REST ↔ MCP отбора хроники (0.10.1, T3)', () => {
  it('оба фасада делегируют разбор и исполнение домену', () => {
    for (const [name, src] of [['routes/chronicle.ts', ROUTE], ['mcp/tools/chronicle.ts', MCP]] as const) {
      assert.match(src, /parseChronicleQueryBody/, `${name} обязан разбирать тело доменным парсером`);
      assert.match(src, /queryChronicle\(/, `${name} обязан исполнять доменный queryChronicle`);
    }
  });

  it('сортировка и SQL живут только в домене — на фасадах ORDER BY нет', () => {
    for (const [name, src] of [['routes/chronicle.ts', ROUTE], ['mcp/tools/chronicle.ts', MCP]] as const) {
      assert.ok(!/ORDER\s+BY/i.test(src), `${name} не должен содержать собственной сортировки`);
    }
  });

  it('ключ сортировки задан один раз и включает класс записи', () => {
    assert.match(DOMAIN, /RECORD_CLASS_SQL/, 'класс записи считается выражением RECORD_CLASS_SQL');
    const orderBy = DOMAIN.match(/ORDER BY[\s\S]*?LIMIT/);
    assert.ok(orderBy, 'в домене найден ORDER BY');
    assert.match(orderBy![0], /RECORD_CLASS_SQL/, 'ORDER BY обязан начинаться с класса записи');
    // Прежний тайбрейкер по title отменён (требование c6ddc1ea).
    assert.ok(!/c\.title COLLATE NOCASE/.test(orderBy![0]), 'тайбрейкер по title отменён');
  });

  it('MCP-фасад прокидывает все поля 0.10.1 из args в тело', () => {
    for (const field of T3_FIELDS) {
      assert.match(
        MCP,
        new RegExp(`body\\.${field}\\s*=\\s*args\\.${field}`),
        `MCP-инструмент обязан прокинуть ${field}`,
      );
    }
  });

  it('контракт etn.chronicle.query объявляет targets и период', () => {
    const block = CONTRACTS.slice(
      CONTRACTS.indexOf('export const ChronicleQuery'),
      CONTRACTS.indexOf('export const ChronicleQuery') + 2000,
    );
    assert.match(block, /targets\s*:/, 'контракт обязан объявлять targets');
    assert.match(block, /date_from\s*:/);
    assert.match(block, /date_to\s*:/);
  });

  it('REST и MCP дают одинаковый порядок и состав для одного отбора', async () => {
    const rest = await buildRestContext();
    const mcp = await buildMcpContext({
      dataDir: rest.dataDir,
      networkId: rest.networkId,
      systemDb: rest.sys,
    });
    const handle = await connectMcpClient(mcp, rest.adminKey);
    try {
      const ndb = rest.ndb as NetworkDb;
      const alpha = seedThought(ndb, 'Alpha');
      const beta = seedThought(ndb, 'Beta');
      const cAlpha = createComment(
        ndb,
        'thought',
        alpha,
        { kind: 'chronological', body_md: 'к альфе', valid_from: '2024-01-01' },
        USER,
      );
      const _cBeta = createComment(
        ndb,
        'thought',
        beta,
        { kind: 'chronological', body_md: 'к бете', valid_from: '2024-01-02' },
        USER,
      );
      const cBoth = createCommentWithTargets(
        ndb,
        [{ owner_type: 'thought', owner_id: rest.homeId }, { owner_type: 'thought', owner_id: alpha }],
        { kind: 'chronological', body_md: 'день+альфа', valid_from: '2024-01-03' },
        USER,
      );

      const filter = { targets: { keywords: 'Alpha' }, order: 'desc' };
      const restRes = await rest.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${rest.networkId}/chronicle/query`,
        headers: authHeaders(rest),
        payload: filter,
      });
      assert.equal(restRes.statusCode, 200);
      const restRows = restRes.json().data as Array<{ id: string; use_time: boolean }>;

      const mcpRes = await handle.client.callTool({
        name: 'etn.chronicle.query',
        arguments: { network_id: rest.networkId, ...filter },
      });
      const mcpRows = toolJson<{ rows: Array<{ id: string; use_time: boolean }> }>(mcpRes).rows;

      assert.deepEqual(
        mcpRows.map((r) => r.id),
        restRows.map((r) => r.id),
        'порядок строк обязан совпасть у REST и MCP',
      );
      assert.deepEqual(
        mcpRows.map((r) => r.use_time),
        restRows.map((r) => r.use_time),
        'состав и флаг use_time обязаны совпасть',
      );
      assert.deepEqual(
        restRows.map((r) => r.id).sort(),
        [cAlpha.id, cBoth.id].sort(),
        'targets отсёк запись, привязанную только к Beta',
      );
    } finally {
      await handle.close();
      await closeMcpContext(mcp, {
        dataDir: rest.dataDir,
        networkId: rest.networkId,
        systemDb: rest.sys,
      });
      await closeRestContext(rest);
    }
  });
});
