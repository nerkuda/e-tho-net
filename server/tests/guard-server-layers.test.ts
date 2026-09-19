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

const SERVER_SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
);

/** Файл принадлежит одному из фасадов (routes или mcp)? */
const inFacades = (rel: string): boolean =>
  rel.startsWith('routes/') || rel.startsWith('mcp/');

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
});
