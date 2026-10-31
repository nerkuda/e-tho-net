/**
 * Сторож проброса жёлтой диагностики ядра отбора в журнал активности и вложения
 * (ошибка b23a7104).
 *
 * До фикса оба домена вызывали `diagnoseFilterAst` без контекста типа и
 * выбрасывали `warnings`, а фасады (MCP и REST) не имели пути для поля вовсе.
 * Семантика общая с хроникой (`5c24af2f`) и `etn.views.run`: `FilterDiagnostic[]`
 * в `meta`/конверте, «пусто — поля нет».
 *
 * Профили «события» и «вложения» контекста типа мысли не несут, поэтому жёлтое
 * предупреждение «свойство отвязано от типа» (`property_detached`) для них
 * структурно недостижимо — путь проброса всё равно обязан существовать и быть
 * одинаковым в обоих контурах (требование задания: «верни пустой путь, но
 * конверт должен существовать»). Поэтому:
 *   * статический гейт держит выражения проброса в домене и обоих фасадах —
 *     удаление любого звена краснит тест;
 *   * runtime-паритет гоняет ОДИН `ast`-запрос через REST и MCP и сверяет
 *     страницы и наличие/значение `warnings` (на штатной фикстуре — поля нет в
 *     обоих, что и есть паритет «пусто — поля нет»).
 *
 * Проводку при непустом списке подтверждают мутацией домена (warning всегда) —
 * до фикса REST нёс его, MCP нет; после фикса оба совпадают. Мутация в
 * тестовый файл не входит: runtime-ветка проверяет согласованность контуров,
 * статическая — наличие пути.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FILTER_AST_VERSION, type FilterAst } from '@etn/shared';

import {
  buildMcpContext,
  callOp,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';
import {
  apiCreateThought,
  authHeaders,
  buildRestContext,
  closeRestContext,
  type RestTestContext,
} from './rest-helpers.js';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Исходник файла сервера без комментариев (проброс диагностики держится
 * текстом выражений; закомментированный код не считается реализацией —
 * мутационная проба не должна проходить статический гейт).
 */
function readSource(relativePath: string): string {
  const source = fs.readFileSync(path.join(SERVER_SRC, relativePath), 'utf8');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // `//` не считается комментарием внутри URL (`https://`) — перед ним `:`.
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

const ACTIVITY_DOMAIN = readSource(path.join('domain', 'activity-service.ts'));
const ACTIVITY_MCP = readSource(path.join('mcp', 'tools', 'activity.ts'));
const ACTIVITY_ROUTE = readSource(path.join('routes', 'activity.ts'));
const ATTACHMENT_DOMAIN = readSource(path.join('domain', 'attachment-service.ts'));
const OPS_MCP = readSource(path.join('mcp', 'tools', 'ops.ts'));
const ATTACHMENT_ROUTE = readSource(path.join('routes', 'attachments.ts'));

/** Тело обработчика действия `attachments.search` из диспетчера `etn.ops`. */
function attachmentSearchHandlerBody(): string {
  const start = OPS_MCP.indexOf("'attachments.search':");
  assert.notEqual(start, -1, 'в tools/ops.ts нет обработчика attachments.search');
  const next = OPS_MCP.indexOf("\n  '", start + 1);
  return OPS_MCP.slice(start, next === -1 ? OPS_MCP.length : next);
}

/** Пустое (но валидное) AST-тело профиля — обе ветки исполняют его одинаково. */
const EMPTY_AST: FilterAst = {
  version: FILTER_AST_VERSION,
  filter: { op: 'and', children: [] },
};

/** Наличие и значение `warnings`: паритет «пусто — поля нет» или равенство. */
function assertWarningsParity(
  label: string,
  restMeta: Record<string, unknown>,
  mcpMeta: Record<string, unknown>,
): void {
  const restHas = 'warnings' in restMeta;
  const mcpHas = 'warnings' in mcpMeta;
  assert.equal(
    restHas,
    mcpHas,
    `${label}: наличие warnings разошлось — REST=${String(restHas)}, MCP=${String(mcpHas)}`,
  );
  if (restHas) {
    assert.deepEqual(mcpMeta['warnings'], restMeta['warnings'], `${label}: warnings совпадают по форме`);
  }
}

/** REST GET-запрос с AST в query-параметре. */
async function restGetAst(
  ctx: RestTestContext,
  url: string,
  ast: FilterAst,
): Promise<{ data: Array<{ id: string }>; meta: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `${url}?ast=${encodeURIComponent(JSON.stringify(ast))}`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { data: Array<{ id: string }>; meta: Record<string, unknown> };
}

describe('warnings ядра отбора: путь проброса (ошибка b23a7104)', () => {
  it('домен журнала активности не теряет warnings и отдаёт конверт', () => {
    assert.match(
      ACTIVITY_DOMAIN,
      /warnings = diag\.warnings/,
      'listActivity обязан забирать diag.warnings (до фикса выбрасывал)',
    );
    assert.match(
      ACTIVITY_DOMAIN,
      /warnings\.length > 0 \? \{ warnings \}/,
      'ActivityListResult обязан нести warnings по семантике «пусто — поля нет»',
    );
  });

  it('MCP etn.activity.list кладёт warnings в meta', () => {
    assert.match(
      ACTIVITY_MCP,
      /result\.warnings/,
      'фасад etn.activity.list обязан читать warnings домена',
    );
    assert.match(
      ACTIVITY_MCP,
      /meta:\s*\{[\s\S]*warnings/,
      'warnings обязаны лежать в meta (конверт REST)',
    );
  });

  it('REST GET /activity кладёт warnings в конверт', () => {
    assert.match(ACTIVITY_ROUTE, /result\.warnings/, 'маршрут журнала обязан пробрасывать warnings');
  });

  it('домен вложений не теряет warnings, а оба фасада кладут их в meta', () => {
    assert.match(
      ATTACHMENT_DOMAIN,
      /diag\.warnings\.length > 0 \? \{ warnings: diag\.warnings \}/,
      'searchAttachmentsByAst обязан пробрасывать warnings (до фикса выбрасывал)',
    );
    const handler = attachmentSearchHandlerBody();
    assert.match(handler, /warnings/, 'attachments.search (MCP) обязан читать warnings домена');
    assert.match(handler, /meta:/, 'attachments.search (MCP) обязан отдавать конверт `{ data, meta }`');
    assert.match(
      ATTACHMENT_ROUTE,
      /warnings !== undefined && warnings\.length > 0 \? \{ warnings \}/,
      'GET /attachments обязан класть warnings в конверт',
    );
  });
});

describe('warnings ядра отбора: паритет REST ↔ MCP (ошибка b23a7104)', { skip: !nativeAvailable() }, () => {
  it('etn.activity.list и GET /activity отдают одну диагностику', async () => {
    const rest = await buildRestContext();
    const mcp = await buildMcpContext({
      dataDir: rest.dataDir,
      networkId: rest.networkId,
      systemDb: rest.sys,
    });
    const handle = await connectMcpClient(mcp, rest.adminKey);
    try {
      // Запись через REST пишет строку журнала активности — лента не пустая.
      const created = await apiCreateThought(rest, { title: 'Событие диагностики' });
      assert.equal(created.statusCode, 201, JSON.stringify(created.data));

      const restPage = await restGetAst(
        rest,
        `/api/v1/networks/${rest.networkId}/activity`,
        EMPTY_AST,
      );
      const mcpPage = toolJson<{
        data: Array<{ id: string }>;
        meta: Record<string, unknown>;
      }>(
        await handle.client.callTool({
          name: 'etn.activity.list',
          arguments: { network_id: rest.networkId, ast: EMPTY_AST },
        }),
      );
      assert.ok(restPage.data.length > 0, 'REST: лента не пуста');
      assert.deepEqual(
        mcpPage.data.map((row) => row.id),
        restPage.data.map((row) => row.id),
        'один ast — одна страница в обоих контурах',
      );
      assertWarningsParity('journals', restPage.meta, mcpPage.meta);
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

  it('attachments.search и GET /attachments отдают одну диагностику', async () => {
    const rest = await buildRestContext();
    const mcp = await buildMcpContext({
      dataDir: rest.dataDir,
      networkId: rest.networkId,
      systemDb: rest.sys,
    });
    const handle = await connectMcpClient(mcp, rest.adminKey);
    try {
      const created = await rest.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${rest.networkId}/thoughts/${rest.homeId}/attachments`,
        headers: authHeaders(rest),
        payload: { kind: 'url', url: 'https://example.test/diagnostics.png' },
      });
      assert.equal(created.statusCode, 201, created.body);

      const restPage = await restGetAst(
        rest,
        `/api/v1/networks/${rest.networkId}/attachments`,
        EMPTY_AST,
      );
      const mcpResult = await callOp(handle.client, 'attachments.search', {
        network_id: rest.networkId,
        ast: EMPTY_AST,
      });
      assert.equal(mcpResult.isError, undefined, toolText(mcpResult));
      const mcpPage = toolJson<{
        data: Array<{ id: string }>;
        meta: Record<string, unknown>;
      }>(mcpResult);
      assert.ok(restPage.data.length > 0, 'REST: вложение найдено');
      assert.deepEqual(
        mcpPage.data.map((item) => item.id),
        restPage.data.map((item) => item.id),
        'один ast — один набор вложений в обоих контурах',
      );
      assert.equal(mcpPage.meta['total'], restPage.meta['total'], 'meta.total совпадает');
      assertWarningsParity('attachments', restPage.meta, mcpPage.meta);
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
