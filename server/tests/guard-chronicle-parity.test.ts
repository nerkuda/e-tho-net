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
    // 0.10.1, задача 46057359: область ключевых слов едет и через MCP —
    // без объявления в контракте (`.strict()`) MCP-вызов её отвергал бы.
    assert.match(block, /keyword_scope\s*:/, 'контракт обязан объявлять keyword_scope');
  });

  it('MCP-фасад прокидывает keyword_scope в тело (задача 46057359)', () => {
    assert.match(
      MCP,
      /body\.keyword_scope\s*=\s*args\.keyword_scope/,
      'MCP-инструмент обязан прокинуть keyword_scope — иначе путь Б не гейтится',
    );
  });

  it('REST и MCP: snippet хроники MCP согласован с развёрнутым телом, REST — без трансформа (ошибка a3fb62b6)', async () => {
    const rest = await buildRestContext();
    const mcp = await buildMcpContext({
      dataDir: rest.dataDir,
      networkId: rest.networkId,
      systemDb: rest.sys,
    });
    const handle = await connectMcpClient(mcp, rest.adminKey);
    try {
      const ndb = rest.ndb as NetworkDb;
      const source = seedThought(ndb, 'Источник сниппета');
      createComment(
        ndb,
        'thought',
        source,
        { kind: 'permanent', body_md: 'Текст источника с **жирным**.' },
        USER,
      );
      const box = seedThought(ndb, 'Контейнер сниппета');
      const rec = createComment(
        ndb,
        'thought',
        box,
        { kind: 'chronological', body_md: `Заметка. ![[#${source}]]`, valid_from: '2024-01-01' },
        USER,
      );

      const payload = { thought_ids: [box], order: 'asc' };
      const restRes = await rest.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${rest.networkId}/chronicle/query`,
        headers: authHeaders(rest),
        payload,
      });
      assert.equal(restRes.statusCode, 200);
      const restRow = (restRes.json().data as Array<{ id: string; snippet: string }>).find(
        (r) => r.id === rec.id,
      );
      assert.ok(restRow !== undefined, 'REST-строка хроники не найдена');
      assert.ok(
        restRow.snippet.includes('![[#'),
        `REST без трансформа обязан отдавать исходный литерал ссылки: ${restRow.snippet}`,
      );

      const mcpRes = await handle.client.callTool({
        name: 'etn.chronicle.query',
        arguments: { network_id: rest.networkId, ...payload },
      });
      const mcpRow = toolJson<{ rows: Array<{ id: string; snippet: string }> }>(mcpRes).rows.find(
        (r) => r.id === rec.id,
      );
      assert.ok(mcpRow !== undefined, 'MCP-строка хроники не найдена');
      assert.ok(
        !mcpRow.snippet.includes('![[#'),
        `MCP snippet содержит литерал трансклюзии: ${mcpRow.snippet}`,
      );
      assert.ok(
        !mcpRow.snippet.includes('etn:transclusion'),
        `служебные маркеры границ не должны попадать в сниппет: ${mcpRow.snippet}`,
      );
      assert.ok(
        mcpRow.snippet.includes('Текст источника'),
        `MCP snippet не развёрнут: ${mcpRow.snippet}`,
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

  it('REST и MCP: keyword_scope без comment отключает поиск по тексту записи', async () => {
    const rest = await buildRestContext();
    const mcp = await buildMcpContext({
      dataDir: rest.dataDir,
      networkId: rest.networkId,
      systemDb: rest.sys,
    });
    const handle = await connectMcpClient(mcp, rest.adminKey);
    try {
      const ndb = rest.ndb as NetworkDb;
      const target = seedThought(ndb, 'Alpha');
      const rec = createCommentWithTargets(
        ndb,
        [{ owner_type: 'thought', owner_id: target }],
        { kind: 'chronological', body_md: 'заметка про берёзу', valid_from: '2024-01-01' },
        USER,
      );

      const run = async (filter: Record<string, unknown>): Promise<string[]> => {
        const restRes = await rest.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${rest.networkId}/chronicle/query`,
          headers: authHeaders(rest),
          payload: filter,
        });
        assert.equal(restRes.statusCode, 200);
        const restRows = restRes.json().data as Array<{ id: string }>;
        const mcpRes = await handle.client.callTool({
          name: 'etn.chronicle.query',
          arguments: { network_id: rest.networkId, ...filter },
        });
        const mcpRows = toolJson<{ rows: Array<{ id: string }> }>(mcpRes).rows;
        assert.deepEqual(
          mcpRows.map((r) => r.id),
          restRows.map((r) => r.id),
          'состав обязан совпасть у REST и MCP',
        );
        return restRows.map((r) => r.id);
      };

      assert.deepEqual(
        await run({ keywords: 'берёзу', keyword_scope: ['title', 'synonyms'] }),
        [],
        'без comment текст записи не находит ни один фасад',
      );
      assert.deepEqual(
        await run({ keywords: 'берёзу', keyword_scope: ['title', 'synonyms', 'comment'] }),
        [rec.id],
        'с comment находит по тексту записи',
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

      // Класс-first при «убывании» (требование c6ddc1ea): запись дня (единственная
      // цель — HOME) обязана быть ПЕРВОЙ, хотя её дата позже всех. Оба фасада
      // должны вернуть один и тот же класс-first порядок.
      const cHome = createComment(
        ndb,
        'thought',
        rest.homeId,
        { kind: 'chronological', body_md: 'запись дня', valid_from: '2024-02-01' },
        USER,
      );
      const descFilter = { order: 'desc' };
      const restDesc = await rest.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${rest.networkId}/chronicle/query`,
        headers: authHeaders(rest),
        payload: descFilter,
      });
      assert.equal(restDesc.statusCode, 200);
      const restDescRows = restDesc.json().data as Array<{ id: string }>;
      const mcpDesc = await handle.client.callTool({
        name: 'etn.chronicle.query',
        arguments: { network_id: rest.networkId, ...descFilter },
      });
      const mcpDescRows = toolJson<{ rows: Array<{ id: string }> }>(mcpDesc).rows;
      assert.equal(restDescRows[0]!.id, cHome.id, 'REST: класс 0 первым при «убывании»');
      assert.equal(mcpDescRows[0]!.id, cHome.id, 'MCP: класс 0 первым при «убывании»');
      assert.deepEqual(
        mcpDescRows.map((r) => r.id),
        restDescRows.map((r) => r.id),
        'класс-first порядок совпадает у REST и MCP',
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
