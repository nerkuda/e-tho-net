/**
 * Сторож слоёв сервера (ADR 8c93f03a, стандарт S5, требование a995045f —
 * задача 4449dced, веха 7 версии 0.8.2).
 *
 * Два запрета, проверяемые обычным прогоном `npm test`:
 *   1. **SQL в фасадах**: `ndb.prepare` (и любой `…prepare(` вызов) и
 *      строковые SQL-фрагменты в `server/src/routes/*` и `server/src/mcp/*`.
 *      SQL живёт только в домене и репозиториях (`src/domain`, `src/db`).
 *   2. **Импорты между фасадами**: `mcp/*` не импортирует `routes/*` и
 *      наоборот — фасады не зависят друг от друга (раньше `mcp/tools.ts`
 *      импортировал `normalizeOptionalText` из `routes/networks.ts` —
 *      единственная инверсия зависимости сервера).
 *
 * Инфраструктура — `guard-helpers.ts` (задача 8d1f8b79, веха 1). Сторож
 * вводится тем же изменением, которое делает его зелёным.
 */

import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const SERVER_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Файл принадлежит одному из фасадов (routes или mcp)? */
const inFacades = (rel: string): boolean => rel.startsWith('routes/') || rel.startsWith('mcp/');

/** Строка — вызов SQL-интерфейса БД (`.prepare(`/`.pragma(`). */
const PREPARE_CALL = /\.(prepare|pragma)\s*\(/;

/**
 * Строка содержит строковый SQL-фрагмент: в кавычках/бэктиках ключевое
 * слово запроса (SELECT/INSERT/UPDATE/DELETE) И структурный маркер
 * (FROM/INTO/SET/VALUES/WHERE/JOIN/TABLE). Двухмаркерность отсекает
 * описания инструментов («update … from» в прозе без структуры запроса).
 */
const SQL_FRAGMENT =
  /['"`][^'"`]*(?:SELECT|INSERT|UPDATE|DELETE)[^'"`]*(?:FROM\s+|INTO\s+|SET\s+|VALUES\s*\(|WHERE\s+|JOIN\s+|TABLE\s+)[^'"`]*['"`]/i;

describe('guard: слои сервера — фасады без SQL и взаимных импортов', () => {
  it('в routes/* и mcp/* нет ndb.prepare и сырого SQL', () => {
    assertGuardClean(SERVER_SRC_ROOT, [
      {
        name: 'sql-prepare-in-facades',
        description:
          'Запрещены вызовы `.prepare(`/`.exec(`/`.pragma(`/`.run(` в фасадах ' +
          '(server/src/routes и server/src/mcp): SQL живёт в домене и репозиториях.',
        pattern: PREPARE_CALL,
        filePattern: PREPARE_CALL,
        include: inFacades,
        // `mcp/http.ts` использует `endpoint.prepareRequest(...)` /
        // `session.transport.handleRequest(...)` — не SQL.
        allow: (rel, line) =>
          line.includes('prepareRequest') ||
          line.includes('handleRequest') ||
          line.includes('handleSession'),
      },
      {
        name: 'raw-sql-in-facades',
        description:
          'Запрещены строковые SQL-фрагменты (SELECT/INSERT/UPDATE/DELETE/… в ' +
          'кавычках) в фасадах (server/src/routes и server/src/mcp).',
        pattern: SQL_FRAGMENT,
        include: inFacades,
      },
    ]);
  });

  it('mcp/* не импортирует routes/* и наоборот', () => {
    assertGuardClean(SERVER_SRC_ROOT, [
      {
        name: 'mcp-does-not-import-routes',
        description:
          'Фасад MCP не импортирует фасад REST: `mcp/*` не может содержать ' +
          '`from "../routes/…"` (ADR 8c93f03a — фасады не зависят друг от друга).',
        pattern: /from\s+['"]\.\.\/routes\//,
        filePattern: /from\s+['"]\.\.\/routes\//,
        include: (rel) => rel.startsWith('mcp/'),
      },
      {
        name: 'routes-does-not-import-mcp',
        description:
          'Фасад REST не импортирует фасад MCP: `routes/*` не может содержать ' +
          '`from "../mcp/…"` (ADR 8c93f03a — фасады не зависят друг от друга).',
        pattern: /from\s+['"]\.\.\/mcp\//,
        filePattern: /from\s+['"]\.\.\/mcp\//,
        include: (rel) => rel.startsWith('routes/'),
      },
    ]);
  });

  it('в routes/* и mcp/* нет ручной оркестрации записи: события, журнал и аудит — только через обёртку runWrite', () => {
    assertGuardClean(SERVER_SRC_ROOT, [
      {
        name: 'no-deps-emit-in-routes',
        description:
          'В routes/* запрещён прямой `deps.emit(`: real-time-события публикует ' +
          'обёртка записи домена `runWrite` (ADR 162d8e7a); фасад только ' +
          'поставляет транспорт через `restWriteFx` (routes/helpers.ts).',
        pattern: /deps\.emit\(/,
        include: (rel) => rel.startsWith('routes/'),
        allow: (rel) => rel === 'routes/helpers.ts',
      },
      {
        name: 'no-agent-emit-in-mcp',
        description:
          'В mcp/* запрещены `emitAgentEvent(`/`emitAgentActivityEvent(`: ' +
          'события публикует обёртка `runWrite`; транспорт фасада — ' +
          '`mcpWriteFx` (mcp/context.ts).',
        pattern: /emitAgent(?:Activity)?Event\(/,
        include: (rel) => rel.startsWith('mcp/'),
      },
      {
        name: 'no-activity-in-facades',
        description:
          'В routes/* и mcp/* запрещены вызовы `record*Activity(`: журнал ' +
          'активности пишет обёртка `runWrite` из результата записи ' +
          '(требование 7f526da1); фасад собирает только исход записи.',
        pattern: /record[A-Z][A-Za-z]*Activity\(/,
        include: inFacades,
      },
      {
        name: 'no-audit-in-mcp-tools',
        description:
          'В mcp/tools/* запрещён прямой `auditAgentCall(`: аудит вызова ' +
          'исполняет обёртка `runWrite` через `mcpWriteFx` (mcp/context.ts). ' +
          'Исключение — инструменты жизненного цикла сетей (вне data.db); ' +
          '0.8.3 (задача 86ef2ff4) их дом — `mcp/tools/ops.ts` (действия ' +
          'networks.write/networks.delete).',
        pattern: /auditAgentCall\(/,
        include: (rel) => rel.startsWith('mcp/tools/'),
        allow: (rel) => rel === 'mcp/tools/networks.ts' || rel === 'mcp/tools/ops.ts',
      },
      {
        name: 'no-emit-domain-event-in-facades',
        description:
          'В routes/* и mcp/* запрещён прямой `emitDomainEvent(`: публикация ' +
          'событий — обязанность обёртки `runWrite`. Исключения — события ' +
          'жизненного цикла сетей (network/membership, вне data.db) в ' +
          'routes/networks.ts, routes/admin-networks.ts, mcp/tools/networks.ts, ' +
          'mcp/tools/ops.ts (0.8.3, задача 86ef2ff4 — сети упакованы в etn.ops) ' +
          'и сам транспорт (http/server.ts, mcp/context.ts).',
        pattern: /emitDomainEvent\(/,
        include: inFacades,
        allow: (rel) =>
          rel === 'routes/networks.ts' ||
          rel === 'routes/admin-networks.ts' ||
          rel === 'mcp/tools/networks.ts' ||
          rel === 'mcp/tools/ops.ts' ||
          rel === 'mcp/context.ts',
      },
    ]);
  });
});
