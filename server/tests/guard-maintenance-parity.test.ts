/**
 * Сторож паритета двух классификаций «читающее/изменяющее» (ошибка 736969ab).
 *
 * Режим обслуживания сервера решает, что блокировать, по ДВУМ независимым
 * классификациям:
 *
 *   * REST — `isMutatingRequest` + allowlist `READ_ONLY_POST_ROUTES`
 *     (`server/src/auth/client-version-guard.ts`): читающие GET/HEAD/OPTIONS и
 *     перечисленные читающие POST проходят, прочие изменяющие методы получают
 *     426/503;
 *   * MCP — аннотация `readOnlyHint` инструмента (`MCP_TOOL_ANNOTATIONS` из
 *     `@etn/shared`, читает `server/src/mcp/server.ts`) и флаг `readOnly`
 *     действия диспетчера `etn.ops` (`OPS_ACTIONS` в
 *     `server/src/mcp/tools/ops-catalog.ts`).
 *
 * Соответствие наборов до этого сторожа ничем не гарантировалось: новый
 * read-only MCP-инструмент без `readOnlyHint` слепо блокировался бы на MCP,
 * хотя REST-чтение работает; обратная ошибка (пишущий помечен read-only) не
 * ловилась вовсе.
 *
 * Сторож держит ЯВНЫЙ ожидаемый состав обеих read-only классификаций. Для
 * каждой записи указан читающий REST-аналог (GET-маршрут или POST-маршрут из
 * allowlist) либо записанное исключение с причиной — административные и
 * системные операции, у которых читающего REST-двойника нет по устройству.
 *
 * Мутации, на которых сторож обязан краснеть:
 *   * снять `readOnlyHint: true` у read-only инструмента — запись таблицы
 *     останется без фактического признака → красный;
 *   * пометить пишущий инструмент `readOnlyHint: true` — фактический набор
 *     получит лишнее имя → красный;
 *   * удалить/добавить `readOnly` у действия `etn.ops` — расхождение с
 *     таблицей действий → красный;
 *   * сослаться на несуществующий или нечитающий REST-аналог — красный.
 *
 * ## Побочные эффекты read-only путей (ошибка df2d971f)
 *
 * Классификация «читающее» обязана означать «не пишет», иначе гейт пропускает
 * запись при `maintenance: updating`. Второй блок проверок:
 *   * read-only действие `etn.ops` не содержит пути записи (`runWrite`,
 *     `runWriteTool`, `requireWriteBudget`, `mcpWriteFx`) — кроме условно
 *     мутирующих действий (`mutatingParams` в реестре) и записанных исключений
 *     с причиной (`properties.resolve` — производные снапшоты);
 *   * read-only MCP-инструмент не содержит пути записи — исключений нет:
 *     инструмент — фасад одного действия, условная мутируемость живёт в
 *     реестре `etn.ops`;
 *   * условная мутируемость объявлена в реестре, названа в обработчике и
 *     реально применяется диспетчером (`isMutatingOpCall`): `mentions_scan`
 *     с `create_links: true` блокируется при обслуживании, без него — читает;
 *   * `shelves.list` не вставляет строки полок (повторный вызов + счётчик
 *     строк БД);
 *   * GET-маршруты REST (читающие безусловно) не вызывают обёртку записи, а
 *     читающий POST `POST /mentions/scan` не несёт мутирующего `create_links`
 *     — мутирующий режим живёт только в MCP-действии, где классификация идёт
 *     по аргументам.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { MCP_TOOL_ANNOTATIONS, MCP_TOOL_NAMES } from '@etn/shared';

import { READ_ONLY_POST_ROUTES } from '../src/auth/client-version-guard.js';
import { openNetworkDb } from '../src/db/network-db.js';
import type { MaintenanceState } from '../src/maintenance.js';
import { OPS_ACTIONS, OPS_ACTIONS_BY_NAME, isMutatingOpCall } from '../src/mcp/tools/ops-catalog.js';
import {
  buildMcpContext,
  callOp,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';
import { buildRestContext, closeRestContext } from './rest-helpers.js';

/** Читающий REST-аналог MCP-инструмента/действия. */
interface RestReadAnalog {
  method: 'GET' | 'POST';
  /** Шаблон маршрута Fastify с префиксом `/api/v1`. */
  path: string;
}

/**
 * Покрытие read-only классификации: либо читающий REST-аналог (один или
 * несколько — инструмент может объединять каталоги), либо записанное
 * исключение с причиной.
 */
interface ReadOnlyCoverage {
  rest?: RestReadAnalog | readonly RestReadAnalog[];
  exception?: string;
}

/**
 * Ожидаемый состав read-only MCP-инструментов (`readOnlyHint: true`).
 *
 * Источник истины — эта таблица: набор из `MCP_TOOL_ANNOTATIONS` обязан
 * совпасть с ней поключево. Инструмент, помеченный read-only, но отсутствующий
 * здесь, — либо забытая запись, либо ошибочная аннотация пишущего инструмента;
 * обратное расхождение — read-only инструмент без аннотации (на MCP его
 * заблокирует гейт обслуживания, хотя REST-чтение работает).
 */
const READ_ONLY_MCP_TOOLS: Readonly<Record<string, ReadOnlyCoverage>> = {
  // Прогрессивное раскрытие: витрина редких операций и тем гайда. Это
  // MCP-специфичная экономия контекста агента, REST-клиенту она не нужна;
  // сами операции доступны своими REST-эндпоинтами.
  'etn.guide': {
    exception:
      'MCP-витрина прогрессивного раскрытия (реестр редких операций и тем справки); ' +
      'REST-аналога нет — REST-клиент не экономит контекст агента, операции доступны своими эндпоинтами',
  },
  // Структура знаний по роли `table_of_contents`: MCP-форма с превью разделов.
  // REST получает те же разделы запросом мыслей по типу.
  'etn.networks.structure': {
    exception:
      'MCP-витрина структуры сети (TOC-разделы с превью постоянных комментариев); ' +
      'отдельного REST-эндпоинта нет — данные достижимы POST /thoughts/query по типу раздела',
  },
  'etn.instructions': { rest: { method: 'GET', path: '/api/v1/networks/:networkId/instructions' } },
  'etn.thoughts.search': { rest: { method: 'GET', path: '/api/v1/networks/:networkId/search' } },
  'etn.thoughts.query': {
    rest: { method: 'POST', path: '/api/v1/networks/:networkId/thoughts/query' },
  },
  'etn.thoughts.get': { rest: { method: 'GET', path: '/api/v1/networks/:networkId/thoughts/:id' } },
  'etn.thoughts.resolve': {
    rest: { method: 'POST', path: '/api/v1/networks/:networkId/thoughts/resolve' },
  },
  'etn.thoughts.neighbors': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/thoughts/:id/neighbors' },
  },
  'etn.thoughts.subgraph': {
    exception:
      'RAG-инструмент (радиус-ограниченный подграф с бюджетами `max_nodes`/`max_chars`); ' +
      'REST-двойника нет — данные достижимы thoughts/query + neighbors, но не одним вызовом',
  },
  'etn.thoughts.usage': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/thoughts/:id/usage' },
  },
  'etn.comments.get': { rest: { method: 'GET', path: '/api/v1/networks/:networkId/comments/:id' } },
  'etn.types.list': {
    rest: [
      { method: 'GET', path: '/api/v1/networks/:networkId/thought-types' },
      { method: 'GET', path: '/api/v1/networks/:networkId/link-types' },
    ],
  },
  'etn.types.get': {
    rest: [
      { method: 'GET', path: '/api/v1/networks/:networkId/thought-types/:id' },
      { method: 'GET', path: '/api/v1/networks/:networkId/link-types/:id' },
    ],
  },
  'etn.views.run': {
    rest: [
      {
        method: 'POST',
        path: '/api/v1/networks/:networkId/thoughts/:thoughtId/views/:view/run',
      },
      { method: 'POST', path: '/api/v1/networks/:networkId/thoughts/:thoughtId/views/run' },
    ],
  },
  'etn.chronicle.query': {
    rest: { method: 'POST', path: '/api/v1/networks/:networkId/chronicle/query' },
  },
  'etn.layers.list': { rest: { method: 'GET', path: '/api/v1/networks/:networkId/layers' } },
  'etn.activity.list': { rest: { method: 'GET', path: '/api/v1/networks/:networkId/activity' } },
  'etn.thoughts.find_duplicates': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/thoughts/duplicates' },
  },
};

/**
 * Ожидаемый состав read-only действий `etn.ops` (`readOnly: true`).
 *
 * Гейт обслуживания проверяет `etn.ops` по флагу действия, а не по аннотации
 * инструмента (`tools/ops.ts`): диспетчер смешивает чтение и запись, поэтому
 * тул-уровневый `readOnlyHint` ему противопоказан. Таблица фиксирует ровно те
 * действия, которые не блокируются при обслуживании.
 */
const READ_ONLY_OPS_ACTIONS: Readonly<Record<string, ReadOnlyCoverage>> = {
  'locks.list': { rest: { method: 'GET', path: '/api/v1/networks/:networkId/locks' } },
  'attachments.search': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/attachments' },
  },
  'attachments.usage': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/attachments/:id/usage' },
  },
  'layers.diff': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/layers/:layerId/diff' },
  },
  'layers.diff_doc': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/layers/:layerId/diff/doc' },
  },
  'layers.conflicts': {
    exception:
      'предпросмотр конфликтов слияния — MCP-only; REST-двойник `POST /layers/:layerId/merge` ' +
      'изменяет данные и блокируется при обслуживании, читающего эквивалента нет',
  },
  'thoughts.path': {
    exception:
      'кратчайший путь между мыслями (ненаправленные рёбра) — MCP-only; ' +
      'REST-эндпоинта пути нет, данные достижимы neighbors/query',
  },
  'thoughts.mentions': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/thoughts/:id/mentions' },
  },
  'thoughts.backlinks': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/thoughts/:id/backlinks' },
  },
  'thoughts.mentions_scan': {
    rest: { method: 'POST', path: '/api/v1/networks/:networkId/mentions/scan' },
  },
  'thoughts.deletion_check': {
    rest: {
      method: 'POST',
      path: '/api/v1/networks/:networkId/thoughts/deletion-check-batch',
    },
  },
  'properties.resolve': {
    rest: [
      {
        method: 'POST',
        path: '/api/v1/networks/:networkId/thoughts/:id/properties/:key/cross-resolve',
      },
      {
        method: 'POST',
        path: '/api/v1/networks/:networkId/links/:id/properties/:key/cross-resolve',
      },
    ],
  },
  'trash.list': { rest: { method: 'GET', path: '/api/v1/networks/:networkId/trash' } },
  'export.subgraph': {
    exception:
      'REST-двойник `POST /export` создаёт задачу экспорта (изменяющее по HTTP-классификации) и ' +
      'блокируется при обслуживании; MCP-действие отдаёт результат в ответе (или пишет файл по ' +
      'пути) без задачи и audit-строки — расхождение осознанное, читающего REST-аналога нет',
  },
  'import.dry_run': {
    rest: { method: 'POST', path: '/api/v1/networks/:networkId/import/preview' },
  },
  'metrics.reads': {
    exception:
      'телеметрия чтений мыслей — MCP-only (счётчики `top`/`cold` для агента); REST-эндпоинта нет',
  },
  'metrics.tools': {
    exception:
      'телеметрия вызовов инструментов MCP — MCP-only по устройству (база ревизии ростера); ' +
      'REST-двойника нет',
  },
  'networks.list': { rest: { method: 'GET', path: '/api/v1/networks' } },
  'members.list': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/members' },
  },
  'changes.list': {
    exception:
      'дельта событий сети для агента с собственным кэшем — MCP-only; REST получает real-time ' +
      'события через WebSocket, эндпоинта дельты нет',
  },
  'publications.list': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/publications' },
  },
  'publications.get': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/publications/:id' },
  },
  'publications.assembly': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/publications/:id/assembly' },
  },
  'publications.candidates': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/publications/:id/candidates' },
  },
  'publications.usage': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/thoughts/:id/publications' },
  },
  'publications.deletionCheck': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/publications/:id/deletion-check' },
  },
  'publications.export': {
    exception:
      'REST-двойник `POST /publications/:id/export` создаёт задачу экспорта (изменяющее по ' +
      'HTTP-классификации); MCP-действие отдаёт сборку в ответе без записи — читающего ' +
      'REST-аналога нет',
  },
  'publications.export_batch': {
    exception:
      'REST-двойник `POST /publications/export-batch` создаёт задачу пакетного экспорта ' +
      '(изменяющее по HTTP-классификации); MCP-действие отдаёт архив в ответе без записи',
  },
  'shelves.list': { rest: { method: 'GET', path: '/api/v1/networks/:networkId/shelves' } },
  'shelves.deletionCheck': {
    rest: { method: 'GET', path: '/api/v1/networks/:networkId/shelves/:id/deletion-check' },
  },
};

/** Корень исходников сервера, независимо от cwd прогона. */
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Нормализация шаблона маршрута: имена параметров не значимы, слеш — значим. */
function normalizeRoutePath(routePath: string): string {
  const withPrefix = routePath.startsWith('/api/v1') ? routePath : `/api/v1${routePath}`;
  return withPrefix.replace(/:[^/]+/g, ':').replace(/\/+$/, '');
}

/**
 * Зарегистрированные REST-маршруты: `нормализованный шаблон → множество
 * методов` из вызовов `app.<method>(...)` во всех файлах `server/src/routes`.
 *
 * Маршруты с динамическими шаблонными строками (`${base}/...`) в таблице
 * покрытия не используются: читающий аналог обязан быть зарегистрирован
 * буквальным шаблоном, иначе проверка существования ничего не доказывает.
 */
function collectRoutes(): Map<string, Set<string>> {
  const routesDir = path.join(SERVER_ROOT, 'src', 'routes');
  const routes = new Map<string, Set<string>>();
  for (const file of fs.readdirSync(routesDir)) {
    if (!file.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(routesDir, file), 'utf8');
    const matcher = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
    for (const match of source.matchAll(matcher)) {
      const method = match[1]!.toUpperCase();
      const routePath = normalizeRoutePath(match[2]!);
      const methods = routes.get(routePath) ?? new Set<string>();
      methods.add(method);
      routes.set(routePath, methods);
    }
  }
  return routes;
}

/** POST-маршруты allowlist — REST-классификация читающих запросов. */
const READ_ONLY_POST_ROUTES_NORMALIZED = new Set(
  READ_ONLY_POST_ROUTES.map((route) => normalizeRoutePath(route)),
);

/** Проверка одного REST-аналога: существует и классифицирован как читающий. */
function assertRestReadAnalog(
  owner: string,
  analog: RestReadAnalog,
  routes: Map<string, Set<string>>,
): void {
  const normalized = normalizeRoutePath(analog.path);
  if (analog.method === 'POST') {
    // Читающие POST регистрируются в том числе через шаблонные строки
    // (`${pathBase}/...`), поэтому источник истины для них — allowlist: он и
    // есть REST-классификация «читающее» (его записи — зарегистрированные
    // маршруты Fastify, см. контракт `READ_ONLY_POST_ROUTES`).
    assert.ok(
      READ_ONLY_POST_ROUTES_NORMALIZED.has(normalized),
      `${owner}: REST-аналог POST ${analog.path} отсутствует в READ_ONLY_POST_ROUTES — ` +
        'на обслуживании он блокируется; либо добавь маршрут в allowlist, либо запиши исключение',
    );
    return;
  }
  assert.ok(
    routes.get(normalized)?.has(analog.method) === true,
    `${owner}: REST-аналог ${analog.method} ${analog.path} не зарегистрирован в server/src/routes`,
  );
}

/** Проверка таблицы покрытия против фактического read-only набора. */
function assertCoverage(
  label: string,
  table: Readonly<Record<string, ReadOnlyCoverage>>,
  actualReadOnly: readonly string[],
  routes: Map<string, Set<string>>,
): void {
  const expected = Object.keys(table).sort();
  const actual = [...actualReadOnly].sort();
  assert.deepEqual(
    actual,
    expected,
    `${label}: фактический read-only набор разошёлся с явной таблицей сторожа. ` +
      'Лишнее имя — read-only без записи в таблице (или ошибочная аннотация пишущего); ' +
      'недостающее — read-only потерял признак, и гейт обслуживания заблокирует его как изменяющий.',
  );

  for (const [name, coverage] of Object.entries(table)) {
    const hasRest = coverage.rest !== undefined;
    const hasException = coverage.exception !== undefined;
    assert.ok(
      hasRest !== hasException,
      `${label} «${name}»: нужен ровно один вид покрытия — читающий REST-аналог ИЛИ исключение с причиной`,
    );
    if (hasException) {
      assert.ok(
        (coverage.exception ?? '').trim().length > 0,
        `${label} «${name}»: исключение обязано нести записанную причину`,
      );
    }
    if (coverage.rest !== undefined) {
      const analogs = Array.isArray(coverage.rest) ? coverage.rest : [coverage.rest as RestReadAnalog];
      assert.ok(analogs.length > 0, `${label} «${name}»: пустой список REST-аналогов`);
      for (const analog of analogs) assertRestReadAnalog(`${label} «${name}»`, analog, routes);
    }
  }
}

describe('паритет классификации обслуживания REST ↔ MCP (ошибка 736969ab)', () => {
  const routes = collectRoutes();

  it('read-only MCP-инструменты: явный список с REST-аналогами или исключениями', () => {
    const actualReadOnly = MCP_TOOL_NAMES.filter(
      (name) => MCP_TOOL_ANNOTATIONS[name]?.readOnlyHint === true,
    );
    assertCoverage('MCP-инструмент', READ_ONLY_MCP_TOOLS, actualReadOnly, routes);

    // Пишущий инструмент не имеет права быть помеченным read-only: гейт
    // обслуживания пропустил бы его, пока сервер обновляется.
    for (const name of MCP_TOOL_NAMES) {
      if (name in READ_ONLY_MCP_TOOLS) continue;
      assert.notEqual(
        MCP_TOOL_ANNOTATIONS[name]?.readOnlyHint,
        true,
        `MCP-инструмент «${name}» не входит в read-only таблицу, но помечен readOnlyHint: true`,
      );
    }

    // Диспетчер `etn.ops` смешивает чтение и запись: тул-уровневый read-only
    // ему противопоказан, классификация — на уровне действия (см. ниже).
    assert.equal(
      MCP_TOOL_ANNOTATIONS['etn.ops'],
      undefined,
      'etn.ops не должен нести тул-уровневые аннотации — роль играет флаг действия',
    );
  });

  it('read-only действия etn.ops: явный список с REST-аналогами или исключениями', () => {
    const actualReadOnly = OPS_ACTIONS.filter((entry) => entry.readOnly).map(
      (entry) => entry.action,
    );
    assertCoverage('etn.ops-действие', READ_ONLY_OPS_ACTIONS, actualReadOnly, routes);

    // Изменяющее действие не имеет права попасть в read-only таблицу.
    for (const entry of OPS_ACTIONS) {
      if (entry.readOnly) continue;
      assert.equal(
        entry.action in READ_ONLY_OPS_ACTIONS,
        false,
        `etn.ops-действие «${entry.action}» изменяющее (readOnly: false), но присутствует в ` +
          'read-only таблице сторожа',
      );
    }
  });

  it('allowlist читающих POST — только POST-маршруты, зарегистрированные в REST', async () => {
    assert.ok(READ_ONLY_POST_ROUTES.length > 0, 'allowlist читающих POST пуст');
    // Сверка с ФАКТИЧЕСКОЙ регистрацией: `hasRoute` смотрит в роутер собранного
    // приложения (включая маршруты, зарегистрированные шаблонными строками и
    // плагинами с префиксом) — опечатка или удалённый маршрут в allowlist
    // краснеют, а не проходят по одному префиксу `/api/v1/`. Отрицательную
    // проверку «не GET» не ставим: Fastify сопоставляет шаблон-запрос
    // структурно, и `:query`-сегмент ложно совпал бы с `GET …/thoughts/:id`.
    const rest = await buildRestContext();
    try {
      for (const route of READ_ONLY_POST_ROUTES) {
        assert.ok(route.startsWith('/api/v1/'), `allowlist: маршрут без префикса /api/v1 — ${route}`);
        assert.equal(
          rest.app.hasRoute({ method: 'POST', url: route }),
          true,
          `allowlist: ${route} не зарегистрирован как POST в собранном REST-приложении`,
        );
      }
    } finally {
      await closeRestContext(rest);
    }
  });
});

// ---------------------------------------------------------------------------
// Read-only не пишет: побочные эффекты и условная мутируемость (df2d971f)
// ---------------------------------------------------------------------------

/** Исходник диспетчера `etn.ops` — обработчики действий и гейт обслуживания. */
const OPS_TOOL_SOURCE = fs.readFileSync(
  path.join(SERVER_ROOT, 'src', 'mcp', 'tools', 'ops.ts'),
  'utf8',
);

/** Исходник фасада публикаций/полок — вторая карта обработчиков `etn.ops`. */
const PUBLICATIONS_TOOL_SOURCE = fs.readFileSync(
  path.join(SERVER_ROOT, 'src', 'mcp', 'tools', 'publications.ts'),
  'utf8',
);

/** Исходник контрактов REST — читающий POST-двойник `mentions.scan`. */
const CONTRACTS_SOURCE = fs.readFileSync(path.join(SERVER_ROOT, 'src', 'contracts.ts'), 'utf8');

/** Признаки пути записи в фасаде: обёртка записи, бюджет, контекст записи. */
const WRITE_PATH_RE = /runWriteTool\(|runWrite\(|requireWriteBudget\(|mcpWriteFx\(/;

/**
 * Read-only действия, которые пишут ПРОИЗВОДНЫЕ данные и остаются read-only по
 * бюджету/аудиту. Записанное исключение с причиной (ошибка df2d971f допускает
 * такие явные записи): снапшот cross_network_ref обновляется мимо обёртки
 * `runWrite` и является производным состоянием, а не знанием.
 */
const READ_ONLY_WRITE_EXCEPTIONS: Readonly<Record<string, string>> = {
  'properties.resolve':
    'служебное чтение (требование c104a0fc: без write-бюджета и audit-строки) обновляет ' +
    'снапшот значений cross_network_ref — производные данные, не знания',
};

/**
 * Тела обработчиков карты действий: имя действия → исходник блока.
 *
 * `etn.ops` собирает обработчики из ДВУХ карт (`HANDLERS` в `tools/ops.ts` и
 * `PUBLICATION_OPS_HANDLERS` в `tools/publications.ts`), поэтому парсер
 * вызывается дважды, а результаты сливаются. Границы — ключи первого уровня
 * (`  'action':`); вложенные объекты имеют бо́льший отступ и не попадают.
 */
function collectOpHandlerBodies(source: string, declaration: string): Map<string, string> {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `не найдена карта обработчиков «${declaration}»`);
  const end = source.indexOf('\n};', start);
  assert.notEqual(end, -1, `не найден конец карты «${declaration}»`);
  const block = source.slice(start, end);
  const marker = /^ {2}'([A-Za-z0-9_.]+)':/gm;
  const matches = [...block.matchAll(marker)];
  const bodies = new Map<string, string>();
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1]!.index! : block.length;
    bodies.set(match[1]!, block.slice(match.index!, bodyEnd));
  }
  return bodies;
}

/**
 * GET-обработчики, вызывающие обёртку записи: `файл GET путь`.
 *
 * GET классифицируется читающим БЕЗУСЛОВНО (`isMutatingRequest`), поэтому
 * запись в нём проходит гейт обслуживания при любом состоянии сервера — та же
 * ошибка класса df2d971f, что и `shelves.list`.
 */
function collectGetHandlersWithWrites(): string[] {
  const routesDir = path.join(SERVER_ROOT, 'src', 'routes');
  const routeStart = /app\.(get|post|put|patch|delete)\(\s*(?:'([^']+)'|`([^`]+)`)/g;
  const offenders: string[] = [];
  for (const file of fs.readdirSync(routesDir)) {
    if (!file.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(routesDir, file), 'utf8');
    const matches = [...source.matchAll(routeStart)];
    for (let i = 0; i < matches.length; i += 1) {
      const match = matches[i]!;
      if (match[1]!.toLowerCase() !== 'get') continue;
      const end = i + 1 < matches.length ? matches[i + 1]!.index! : source.length;
      const body = source.slice(match.index!, end);
      if (WRITE_PATH_RE.test(body)) offenders.push(`${file} GET ${match[2] ?? match[3]}`);
    }
  }
  return offenders;
}

/** Тела регистраций MCP-инструментов: имя инструмента → исходник блока. */
function collectMcpToolBodies(): Map<string, string> {
  const toolsDir = path.join(SERVER_ROOT, 'src', 'mcp', 'tools');
  const bodies = new Map<string, string>();
  for (const file of fs.readdirSync(toolsDir)) {
    if (!file.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(toolsDir, file), 'utf8');
    const matches = [...source.matchAll(/mcp\.registerTool\(\s*\n?\s*'([^']+)'/g)];
    for (let i = 0; i < matches.length; i += 1) {
      const match = matches[i]!;
      const end = i + 1 < matches.length ? matches[i + 1]!.index! : source.length;
      bodies.set(match[1]!, source.slice(match.index!, end));
    }
  }
  return bodies;
}

/** Состояние обслуживания, которое отдают провайдеры в поведенческих тестах. */
const UPDATING_STATE: MaintenanceState = {
  state: 'updating',
  reason: 'server-updating',
  since: '2026-10-29T12:00:00.000Z',
  retry_after: 60,
  target_version: '0.99.0',
};

describe('read-only не пишет: статические правила (ошибка df2d971f)', () => {
  it('read-only действия etn.ops не содержат пути записи (кроме условных и исключений)', () => {
    const bodies = new Map([
      ...collectOpHandlerBodies(OPS_TOOL_SOURCE, 'const HANDLERS'),
      ...collectOpHandlerBodies(PUBLICATIONS_TOOL_SOURCE, 'export const PUBLICATION_OPS_HANDLERS'),
    ]);
    for (const entry of OPS_ACTIONS) {
      if (!entry.readOnly) continue;
      const body = bodies.get(entry.action);
      assert.ok(body !== undefined, `нет обработчика «${entry.action}» в HANDLERS`);
      const writes = WRITE_PATH_RE.test(body);
      const exception = READ_ONLY_WRITE_EXCEPTIONS[entry.action];
      if (exception !== undefined) {
        assert.ok((exception).trim().length > 0, `«${entry.action}»: исключение без причины`);
        continue;
      }
      if ((entry.mutatingParams ?? []).length > 0) {
        assert.ok(
          writes,
          `«${entry.action}»: объявлена условная мутируемость, но ветки записи в обработчике нет — ` +
            'объявление протухло',
        );
        for (const rule of entry.mutatingParams!) {
          assert.ok(
            body.includes(rule.param),
            `«${entry.action}»: условный параметр «${rule.param}» не назван в обработчике — ` +
              'реестр и код разошлись',
          );
        }
        continue;
      }
      assert.equal(
        writes,
        false,
        `read-only действие «${entry.action}» содержит путь записи — гейт обслуживания пропустит ` +
          'его при обновлении сервера; пометь действие изменяющим, объяви mutatingParams ' +
          'или внеси исключение с причиной',
      );
    }
    // Исключения не протухают: имя обязано адресовать живое read-only действие.
    for (const name of Object.keys(READ_ONLY_WRITE_EXCEPTIONS)) {
      const entry = OPS_ACTIONS_BY_NAME.get(name);
      assert.ok(
        entry !== undefined && entry.readOnly,
        `исключение «${name}» адресует неизвестное или уже изменяющее действие`,
      );
    }
  });

  it('диспетчер etn.ops классифицирует условно мутирующие вызовы по аргументам', () => {
    // Гейт диспетчера обязан решать по реестру аргументов, а не только по
    // статическому флагу: иначе создание связей снова пройдёт при обслуживании.
    assert.match(
      OPS_TOOL_SOURCE,
      /isMutatingOpCall\(entry,\s*args\.params\s*\?\?\s*\{\}\)/,
      'диспетчер etn.ops обязан вызывать isMutatingOpCall(entry, args.params ?? {}) до обработчика',
    );
    const scan = OPS_ACTIONS_BY_NAME.get('thoughts.mentions_scan');
    assert.ok(scan !== undefined, 'в реестре нет thoughts.mentions_scan');
    assert.equal(isMutatingOpCall(scan!, {}), false, 'скан без create_links — чтение');
    assert.equal(isMutatingOpCall(scan!, { create_links: false }), false, 'create_links: false — чтение');
    assert.equal(isMutatingOpCall(scan!, { create_links: true }), true, 'create_links: true — изменяющее');
    for (const entry of OPS_ACTIONS) {
      if (entry.readOnly) continue;
      assert.equal(
        isMutatingOpCall(entry, {}),
        true,
        `изменяющее действие «${entry.action}» обязано блокироваться при обслуживании без аргументов`,
      );
    }
  });

  it('REST-паритет: GET не пишет, читающий POST /mentions/scan не несёт create_links', () => {
    assert.deepEqual(
      collectGetHandlersWithWrites(),
      [],
      'GET-маршрут вызывает обёртку записи: GET классифицируется читающим безусловно ' +
        '(ошибка df2d971f — так проходил lazy-create полки в GET /shelves)',
    );
    // Мутирующий режим скана живёт ТОЛЬКО в MCP-действии, где классификация
    // идёт по аргументам. REST-двойник — поиск упоминаний в присланных текстах
    // без записи; появление `create_links` в его контракте сделало бы
    // allowlist читающих POST дырой в гейте обслуживания.
    const block =
      /export const RestMentionsScan = defineContract\([\s\S]*?\n\);/.exec(CONTRACTS_SOURCE)?.[0] ?? '';
    assert.ok(block.length > 0, 'не найден контракт RestMentionsScan в contracts.ts');
    assert.equal(
      /\bcreate_links\b/.test(block),
      false,
      'читающий POST /mentions/scan не должен нести мутирующий create_links',
    );
  });

  it('read-only MCP-инструменты не содержат пути записи', () => {
    // Тул-уровневая аннотация read-onlyHint — единственная классификация
    // инструментов для гейта обслуживания; запись внутри тела такого инструмента
    // проходит гейт так же, как проходил lazy-create полки в shelves.list
    // (ошибка df2d971f). Исключений у инструментов нет: инструмент — фасад
    // одного действия, условная мутируемость живёт в реестре etn.ops.
    const bodies = collectMcpToolBodies();
    for (const name of Object.keys(READ_ONLY_MCP_TOOLS)) {
      const body = bodies.get(name);
      assert.ok(body !== undefined, `не найдена регистрация read-only инструмента «${name}»`);
      assert.equal(
        WRITE_PATH_RE.test(body),
        false,
        `read-only MCP-инструмент «${name}» содержит путь записи — гейт обслуживания пропустит ` +
          'его при обновлении сервера; инструмент без записи либо классификация «изменяющее»',
      );
    }
  });
});

describe('read-only не пишет: поведение (ошибка df2d971f)', { skip: !nativeAvailable() }, () => {
  it('при обслуживании mentions_scan{create_links:true} блокируется, чтение проходит', async () => {
    const ctx = await buildMcpContext();
    const handle = await connectMcpClient(ctx, ctx.adminKey, {
      maintenance: () => UPDATING_STATE,
    });
    try {
      // Чтение (без create_links и с явным false) не блокируется.
      for (const createLinks of [undefined, false]) {
        const read = await callOp(handle.client, 'thoughts.mentions_scan', {
          network_id: ctx.networkId,
          text: 'текст без упоминаний мыслей',
          ...(createLinks === undefined ? {} : { create_links: createLinks }),
        });
        assert.equal(read.isError, undefined, toolText(read));
      }
      // Мутирующий режим — SERVER_UPDATING ещё ДО валидации params: связь не
      // создаётся даже при неполном наборе аргументов.
      const blocked = await callOp(handle.client, 'thoughts.mentions_scan', {
        network_id: ctx.networkId,
        text: 'текст без упоминаний мыслей',
        create_links: true,
      });
      assert.equal(blocked.isError, true);
      assert.match(toolText(blocked), /ETN error \[SERVER_UPDATING\]/);
    } finally {
      await handle.close();
      await closeMcpContext(ctx);
    }
  });

  it('shelves.list не создаёт полку — проверка отсутствия вставки', async () => {
    const ctx = await buildMcpContext();
    const handle = await connectMcpClient(ctx, ctx.adminKey);
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const countShelves = (): number =>
        (ndb.prepare('SELECT COUNT(*) AS c FROM shelves').get() as { c: number }).c;

      const initial = toolJson<{ data: Array<{ id: string; title: string }> }>(
        await callOp(handle.client, 'shelves.list', { network_id: ctx.networkId }),
      );
      assert.equal(initial.data.length, 1, 'новая сеть создана с дефолтной «Полкой»');
      await callOp(
        handle.client,
        'shelves.delete',
        { network_id: ctx.networkId, shelf_id: initial.data[0]!.id },
        true,
      );
      const before = countShelves();
      assert.equal(before, 0, 'полка физически удалена');

      // Дважды: первый вызов ловил бы ленивое создание, второй — повторную
      // вставку после первого.
      for (const attempt of [1, 2]) {
        const page = toolJson<{ data: unknown[]; meta: { total: number } }>(
          await callOp(handle.client, 'shelves.list', { network_id: ctx.networkId }),
        );
        assert.equal(page.data.length, 0, `вызов ${attempt}: список пуст`);
        assert.equal(page.meta.total, 0);
        assert.equal(countShelves(), before, `вызов ${attempt}: shelves.list не вставил строку`);
      }
    } finally {
      await handle.close();
      await closeMcpContext(ctx);
    }
  });
});
