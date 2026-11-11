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
import { resolveGlobalDateTokens } from '../src/domain/thought-type-view-tokens.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  toolJson,
  toolText,
} from './mcp-helpers.js';
import { authHeaders, buildRestContext, closeRestContext } from './rest-helpers.js';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const ROUTE = fs.readFileSync(path.join(SERVER_SRC, 'routes', 'chronicle.ts'), 'utf8');
const MCP = fs.readFileSync(path.join(SERVER_SRC, 'mcp', 'tools', 'chronicle.ts'), 'utf8');
const DOMAIN = fs.readFileSync(path.join(SERVER_SRC, 'domain', 'chronicle-service.ts'), 'utf8');
/** Нейтральный резолвер привязок — единственный держатель SQL строк целей (0.15.4). */
const TARGETS = fs.readFileSync(path.join(SERVER_SRC, 'domain', 'comment-targets.ts'), 'utf8');
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

  it('ключ сортировки задан один раз и не содержит класса записи', () => {
    const orderBy = DOMAIN.match(/ORDER BY[\s\S]*?LIMIT/);
    assert.ok(orderBy, 'в домене найден ORDER BY');
    // Ревизия 2026-10-09 (задача 5a002590): класс записи УДАЛЁН из сортировки —
    // порядок только по дате/времени, иначе запись «прыгает» при смене привязок.
    assert.ok(!/RECORD_CLASS_SQL/.test(DOMAIN), 'выражение класса записи удалено');
    assert.ok(!/CASE WHEN EXISTS/.test(orderBy![0]), 'ORDER BY не считает класс записи');
    assert.match(orderBy![0], /c\.valid_from/, 'ORDER BY начинается с даты записи');
    // Прежний тайбрейкер по title отменён (требование c6ddc1ea).
    assert.ok(!/c\.title COLLATE NOCASE/.test(orderBy![0]), 'тайбрейкер по title отменён');
  });

  it('MCP-фасад прокидывает все поля 0.10.1 из args в тело', () => {
    for (const field of T3_FIELDS) {
      assert.match(
        MCP,
        new RegExp(`payload\\.${field}\\s*=\\s*args\\.${field}`),
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
      /payload\.keyword_scope\s*=\s*args\.keyword_scope/,
      'MCP-инструмент обязан прокинуть keyword_scope — иначе путь Б не гейтится',
    );
  });

  it('словарь областей keyword_scope — один (shared-константа), без локальной копии', () => {
    // Требование 9e9d14dc: словарь областей закрытый. Локальный литерал в домене
    // отставал бы от shared-словаря: новая область (`diary`, ошибка 2bc251de)
    // молча отвергалась бы на входе хроники.
    assert.match(
      DOMAIN,
      /STRUCTURE_KEYWORD_SCOPES/,
      'хроника обязана валидировать области по shared-словарю',
    );
    assert.ok(
      !/'synonyms'\s*&&/.test(DOMAIN),
      'области не перечисляются литералами в домене',
    );
    assert.ok(
      !/allowed:\s*\[\s*'title'/.test(DOMAIN),
      'список допустимых областей не дублируется литералом',
    );
  });

  it('фаза 1 отбора хроники ставит контекст «comment + комментарии связей» (ошибка fc97548d)', () => {
    // Паритет с плоским `keyword_scope`: плоский компилятор эти комментарии
    // видит (требование ce111b0d), поэтому исполнитель целей обязан передать
    // контекст в движок мыслей — иначе AST-тело панели молча теряло бы мысли.
    assert.match(
      DOMAIN,
      /keywordCommentIncludesLinkComments:\s*true/,
      'targetsLeafClause обязан ставить keywordCommentIncludesLinkComments',
    );
    assert.match(
      DOMAIN,
      /buildThoughtIdSelect\(/,
      'подвыборка целей исполняется общим движком мыслей',
    );
    assert.match(
      DOMAIN,
      /comment_targets_v/,
      'плоский компилятор ищет комментарии связей через comment_targets_v',
    );
    // 0.15.4 (задача 6af1be50, ADR db88d819): привязки СТРОК выдачи разрешает
    // общий нейтральный резолвер, у домена по-строчного запроса не осталось.
    assert.match(
      DOMAIN,
      /resolveChronicleTargets\(/,
      'привязки строк хроники разрешает общий резолвер',
    );
    assert.match(
      TARGETS,
      /FROM comment_targets_v/,
      'SQL строк привязок живёт в резолвере — второй копии нет',
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

  it('REST и MCP: область diary отбирает мысль по её дневниковой записи (ошибка 2bc251de)', async () => {
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
      const rec = createComment(
        ndb,
        'thought',
        target,
        { kind: 'chronological', body_md: 'дневникслово в записи', valid_from: '2024-01-01' },
        USER,
      );

      const run = async (filter: Record<string, unknown>): Promise<string[]> => {
        const restRes = await rest.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${rest.networkId}/chronicle/query`,
          headers: authHeaders(rest),
          payload: filter,
        });
        assert.equal(restRes.statusCode, 200, JSON.stringify(restRes.json()));
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

      // `comment` выключен → путь «текст записи» отключён, запись находится
      // ТОЛЬКО областью `diary` (мысль отобрана по своей хроно-записи).
      assert.deepEqual(
        await run({ keywords: 'дневникслово', keyword_scope: ['title', 'synonyms', 'diary'] }),
        [rec.id],
        'область diary отбирает мысль по её дневниковой записи',
      );
      assert.deepEqual(
        await run({ keywords: 'дневникслово', keyword_scope: ['title', 'synonyms'] }),
        [],
        'без diary и comment запись не находится',
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

      // Только дата/время (требование c6ddc1ea, ревизия 2026-10-09): запись дня
      // (единственная цель — HOME) с РАННЕЙ датой при «убывании» обязана идти
      // ПОСЛЕДНЕЙ — класс записи в порядок не входит. Оба фасада совпадают.
      const cHome = createComment(
        ndb,
        'thought',
        rest.homeId,
        { kind: 'chronological', body_md: 'запись дня', valid_from: '2023-12-01' },
        USER,
      );
      const descFilter = { order: 'desc' };
      const expectedDesc = [cBoth.id, _cBeta.id, cAlpha.id, cHome.id];
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
      assert.deepEqual(restDescRows.map((r) => r.id), expectedDesc, 'REST: чистое убывание по дате');
      assert.deepEqual(mcpDescRows.map((r) => r.id), expectedDesc, 'MCP: чистое убывание по дате');
      assert.deepEqual(
        mcpDescRows.map((r) => r.id),
        restDescRows.map((r) => r.id),
        'порядок совпадает у REST и MCP',
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

  it('REST: ast-тело хроники — 200; XOR с плоскими критериями и link_scope!=both → 422 (задача 4752b065)', async () => {
    const rest = await buildRestContext();
    try {
      const inject = (payload: Record<string, unknown>) =>
        rest.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${rest.networkId}/chronicle/query`,
          headers: authHeaders(rest),
          payload,
        });

      const ast = {
        version: 1,
        filter: { entity: { kind: 'targets' }, operator: 'not_empty' },
      };
      // Валидное AST-тело профиля «хроника» принимается.
      const ok = await inject({ ast });
      assert.equal(ok.statusCode, 200, JSON.stringify(ok.json()));

      // XOR: `ast` несовместимо с плоскими критериями (keywords/date/targets/...).
      const conflict = await inject({ ast, keywords: 'x' });
      assert.equal(conflict.statusCode, 422, 'ast + плоские критерии → 422 (XOR)');

      // Плоское `link_scope != both` не выражается в AST — явный отказ, не подмена.
      const scope = await inject({ ast, link_scope: 'sources' });
      assert.equal(scope.statusCode, 422, 'ast + link_scope=sources → 422');

      // Плоский `link_scope != both` без ast тоже отвергается компилятором.
      const flatScope = await inject({ link_scope: 'sources' });
      assert.equal(flatScope.statusCode, 422, 'плоский link_scope=sources → 422 (компилятор)');
    } finally {
      await closeRestContext(rest);
    }
  });

  it('REST: первый день недели сети доходит в POST /chronicle/query (задача 7a798b17)', async () => {
    const rest = await buildRestContext();
    try {
      const ndb = rest.ndb as NetworkDb;
      const thought = seedThought(ndb, 'Хроника недели');
      // Границы недели для текущего момента при разных настройках сети.
      const now = new Date();
      const sundayStart = resolveGlobalDateTokens('$weekStart', {
        now: () => now,
        firstDayOfWeek: 7,
      }).value as string;
      const mondayStart = resolveGlobalDateTokens('$weekStart', {
        now: () => now,
        firstDayOfWeek: 1,
      }).value as string;
      assert.notEqual(sundayStart, mondayStart, 'воскресная и понедельничная недели различаются');
      // Запись на границе недели с началом в воскресенье.
      createComment(
        ndb,
        'thought',
        thought,
        { kind: 'chronological', body_md: 'Вс', valid_from: `${sundayStart}T12:00:00.000Z` },
        USER,
      );

      const payload = { date_from: '$weekStart', date_to: '$weekStart' };
      const record = rest.sys.getNetworkById(rest.networkId);
      assert.ok(record !== null, 'сеть должна читаться из системной БД');
      const setFirstDay = (firstDayOfWeek: number): void => {
        rest.sys.updateNetwork(rest.networkId, {
          displayName: record!.display_name,
          description: record!.description,
          when_to_use: record!.when_to_use,
          conventions: record!.conventions,
          examples: record!.examples,
          type_roles: record!.type_roles,
          first_day_of_week: firstDayOfWeek,
        });
      };
      const total = async (): Promise<number> => {
        const res = await rest.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${rest.networkId}/chronicle/query`,
          headers: authHeaders(rest),
          payload,
        });
        assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
        return (res.json().meta as { total: number }).total;
      };

      // Неделя с воскресенья → запись воскресенья входит.
      setFirstDay(7);
      assert.equal(await total(), 1, 'firstDayOfWeek=7 обязан учесть воскресную границу');
      // Неделя с понедельника → та же запись вне периода.
      setFirstDay(1);
      assert.equal(await total(), 0, 'firstDayOfWeek=1 обязан считать неделю с понедельника');
    } finally {
      await closeRestContext(rest);
    }
  });

  it('формат тела записи: MCP — md по умолчанию и html по запросу, REST — три значения с дефолтом html (ошибки 50a94510, 35e1319a)', async () => {
    const rest = await buildRestContext();
    const mcp = await buildMcpContext({
      dataDir: rest.dataDir,
      networkId: rest.networkId,
      systemDb: rest.sys,
    });
    const handle = await connectMcpClient(mcp, rest.adminKey);
    try {
      const ndb = rest.ndb as NetworkDb;
      const target = seedThought(ndb, 'Формат тела');
      const bodyMd = '## Итоги\n\n- первое\n\n**важно**';
      createComment(
        ndb,
        'thought',
        target,
        { kind: 'chronological', body_md: bodyMd, valid_from: '2024-01-01' },
        USER,
      );

      type Row = { id: string; snippet: string; body_md?: string; body_html?: string };
      const restRow = async (payload: Record<string, unknown>): Promise<Row> => {
        const res = await rest.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${rest.networkId}/chronicle/query`,
          headers: authHeaders(rest),
          payload,
        });
        assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
        return (res.json().data as Row[])[0]!;
      };
      const mcpRow = async (args: Record<string, unknown>): Promise<Row> => {
        const res = await handle.client.callTool({
          name: 'etn.chronicle.query',
          arguments: { network_id: rest.networkId, ...args },
        });
        assert.notEqual(res.isError, true, toolText(res));
        return toolJson<{ rows: Row[] }>(res).rows[0]!;
      };

      // MCP: дефолт — только markdown, HTML не собирается вовсе.
      const mcpDefault = await mcpRow({ thought_ids: [target] });
      assert.equal(mcpDefault.body_md, bodyMd, 'MCP по умолчанию отдаёт body_md');
      assert.ok(!('body_html' in mcpDefault), 'MCP по умолчанию не отдаёт body_html');

      // MCP: html — только HTML, markdown нет.
      const mcpHtml = await mcpRow({ thought_ids: [target], body: 'html' });
      assert.ok(!('body_md' in mcpHtml), 'MCP body=html не отдаёт body_md');
      assert.match(mcpHtml.body_html!, /<h2/, 'MCP body=html отдаёт отрендеренный HTML');

      // `snippet` не зависит от формата.
      assert.equal(mcpDefault.snippet, mcpHtml.snippet, 'MCP: snippet стабилен md ↔ html');

      // MCP-словарь закрыт: `both` агенту не предлагается.
      const both = await handle.client.callTool({
        name: 'etn.chronicle.query',
        arguments: { network_id: rest.networkId, thought_ids: [target], body: 'both' },
      });
      assert.equal(both.isError, true, 'MCP отвергает body=both (закрытый словарь)');

      // REST: дефолт — `html` (ровно прежний состав ответа: клиент читает
      // `body_html`; `body_md` на провод не идёт — ошибка 35e1319a).
      const restDefault = await restRow({ thought_ids: [target] });
      assert.match(restDefault.body_html!, /<h2/);
      assert.ok(!('body_md' in restDefault), 'REST-дефолт не отдаёт body_md');

      // REST: все три значения словаря.
      assert.equal((await restRow({ thought_ids: [target], body: 'md' })).body_md, bodyMd);
      assert.ok(!('body_html' in (await restRow({ thought_ids: [target], body: 'md' }))));
      assert.ok(!('body_md' in (await restRow({ thought_ids: [target], body: 'html' }))));
      assert.match(
        (await restRow({ thought_ids: [target], body: 'html' })).body_html!,
        /<h2/,
      );
      const restBoth = await restRow({ thought_ids: [target], body: 'both' });
      assert.equal(restBoth.body_md, bodyMd);
      assert.match(restBoth.body_html!, /<h2/, 'both: оба тела');

      // REST: недопустимое значение — 422 поля `body`.
      const invalid = await rest.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${rest.networkId}/chronicle/query`,
        headers: authHeaders(rest),
        payload: { thought_ids: [target], body: 'markdown' },
      });
      assert.equal(invalid.statusCode, 422, 'REST отвергает body вне словаря');
      assert.deepEqual(
        (invalid.json().error.details as { field?: string } | undefined)?.field,
        'body',
      );

      // REST: snippet стабилен между форматами.
      const snippets = await Promise.all(
        (['md', 'html', 'both'] as const).map((body) =>
          restRow({ thought_ids: [target], body }).then((r) => r.snippet),
        ),
      );
      assert.equal(new Set(snippets).size, 1, 'REST: snippet стабилен md/html/both');
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

  it('MCP отдаёт meta.warnings той же формы, что REST (ошибка 5c24af2f)', async (t) => {
    // Pin против удаления проброса (до фикса фасад вообще не упоминал warnings
    // — красный на дофиксовой сборке). Проверка допускает эквивалентные записи
    // условия («непустой список»): `warnings !== undefined && warnings.length > 0`
    // и `warnings?.length`; переноси pin вместе с рефакторингом фасада.
    // Семантику «пусто — поля нет» доказывает прогон ниже, не эта регулярка.
    assert.match(
      MCP,
      /warnings(?:\?\.|\.)length/,
      'MCP-фасад обязан проверять непустоту warnings перед добавлением в meta',
    );
    assert.match(
      MCP,
      /warnings\s*:\s*(?:result\.)?warnings\b/,
      'MCP-фасад обязан прокидывать результат домена в meta.warnings',
    );
    assert.match(
      MCP,
      /meta:\s*\{[\s\S]*warnings/,
      'warnings обязаны лежать в meta (конверт REST)',
    );

    const rest = await buildRestContext();
    const mcp = await buildMcpContext({
      dataDir: rest.dataDir,
      networkId: rest.networkId,
      systemDb: rest.sys,
    });
    const handle = await connectMcpClient(mcp, rest.adminKey);
    try {
      const ndb = rest.ndb as NetworkDb;
      const target = seedThought(ndb, 'Ast-фикстура');
      createComment(
        ndb,
        'thought',
        target,
        { kind: 'chronological', body_md: 'запись', valid_from: '2024-01-01' },
        USER,
      );
      const ast = {
        version: 1,
        filter: { entity: { kind: 'targets' }, operator: 'not_empty' },
      };

      const restRes = await rest.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${rest.networkId}/chronicle/query`,
        headers: authHeaders(rest),
        payload: { ast },
      });
      assert.equal(restRes.statusCode, 200, JSON.stringify(restRes.json()));
      const restMeta = restRes.json().meta as { total: number; warnings?: unknown[] };

      const mcpRes = await handle.client.callTool({
        name: 'etn.chronicle.query',
        arguments: { network_id: rest.networkId, ast },
      });
      const mcpMeta = toolJson<{ meta: { total: number; offset: number; limit: number; warnings?: unknown[] } }>(
        mcpRes,
      ).meta;

      // Жёлтое ядро хроники строится только с контекстом типа (требование
      // 0fd1dc5d), которого у записи нет: на штатной фикстуре warnings пуст у
      // ОБОИХ фасадов, и пустое поле не добавляется. Непустой случай проверяет
      // прогон с мутацией домена (отчёт работы 5c24af2f): REST↔MCP совпадают.
      // Семантика «пусто — поля нет» единая; при непустом ответе форма общая.
      if (restMeta.warnings === undefined) {
        assert.equal('warnings' in mcpMeta, false, 'REST: пусто — поля нет; MCP тоже');
      } else {
        assert.deepEqual(mcpMeta.warnings, restMeta.warnings, 'warnings совпадают по форме');
      }
      assert.equal(mcpMeta.total, restMeta.total, 'total совпадает');
      t.diagnostic(
        `warnings parity: REST=${JSON.stringify(restMeta.warnings)}, MCP=${JSON.stringify(mcpMeta.warnings)}`,
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

  it('замер: MCP-ответ на 50 записей в md меньше, чем в html (ошибка 50a94510)', async (t) => {
    const rest = await buildRestContext();
    const mcp = await buildMcpContext({
      dataDir: rest.dataDir,
      networkId: rest.networkId,
      systemDb: rest.sys,
    });
    const handle = await connectMcpClient(mcp, rest.adminKey);
    try {
      const ndb = rest.ndb as NetworkDb;
      const target = seedThought(ndb, 'Лента 50');
      for (let i = 0; i < 50; i += 1) {
        createComment(
          ndb,
          'thought',
          target,
          {
            kind: 'chronological',
            body_md:
              `## Запись ${i}\n\n- пункт один\n- пункт два\n\n` +
              `**важно** текст записи ${i} с несколькими словами для длины.`,
            valid_from: `2024-01-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
          },
          USER,
        );
      }
      const call = async (body: 'md' | 'html'): Promise<{ bytes: number; has: (key: string) => boolean }> => {
        const res = await handle.client.callTool({
          name: 'etn.chronicle.query',
          arguments: { network_id: rest.networkId, thought_ids: [target], limit: 50, body },
        });
        const text = toolText(res);
        const rows = (JSON.parse(text) as { rows: Array<Record<string, unknown>> }).rows;
        assert.equal(rows.length, 50, `50 записей (${body})`);
        return {
          bytes: Buffer.byteLength(text),
          has: (key) => key in rows[0]!,
        };
      };
      // Дефолт без параметра — md.
      const byDefault = await handle.client.callTool({
        name: 'etn.chronicle.query',
        arguments: { network_id: rest.networkId, thought_ids: [target], limit: 50 },
      });
      const defaultBytes = Buffer.byteLength(toolText(byDefault));
      const md = await call('md');
      const html = await call('html');
      assert.equal(defaultBytes, md.bytes, 'MCP-дефолт = md по размеру и составу');
      assert.equal(md.has('body_md'), true);
      assert.equal(md.has('body_html'), false);
      assert.equal(html.has('body_html'), true);
      assert.equal(html.has('body_md'), false);
      assert.ok(
        md.bytes < html.bytes,
        `md (${md.bytes} Б) обязан быть меньше html (${html.bytes} Б)`,
      );
      t.diagnostic(
        `50 записей: MCP md=${md.bytes} Б, html=${html.bytes} Б, ` +
          `экономия=${html.bytes - md.bytes} Б (${Math.round((1 - md.bytes / html.bytes) * 100)}%)`,
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
