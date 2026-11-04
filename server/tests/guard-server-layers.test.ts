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
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const SERVER_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Файл принадлежит одному из фасадов (routes или mcp)? */
const inFacades = (rel: string): boolean => rel.startsWith('routes/') || rel.startsWith('mcp/');

/** Строка — вызов SQL-интерфейса БД (`.prepare(`/`.pragma(`). */
const PREPARE_CALL = /\.(prepare|pragma)\s*\(/;

/**
 * Строка содержит строковый SQL-фрагмент: в кавычках/бэктиках запрос
 * начинается с ключевого слова (SELECT/INSERT/UPDATE/DELETE) и содержит
 * структурный маркер (FROM/INTO/SET/VALUES/WHERE/JOIN/TABLE).
 *
 * Три условия отсекают английскую прозу, не ослабляя детектор:
 *  1. **Начало строкового литерала.** Реальный SQL — это литерал целиком
 *     (`'SELECT id FROM thoughts'`), а прозаические глаголы стоят в середине
 *     предложения («the server deletes the rows … from the layer»).
 *  2. **Ключевое слово целиком** (`\b`) — словоформы `deleted`/`deletes`/
 *     `selects`/`sub-selection` не считаются SQL.
 *  3. **Регистр.** SQL в этом репозитории пишется ключевыми словами в верхнем
 *     регистре (стиль домена), английская проза — в предложении с заглавной
 *     буквы (`Delete from the registry`, `Select a network from the list`).
 *     Регистрозависимость — то, что отличает `DELETE FROM` от прозы;
 *     строчный SQL в фасад по стилю попасть не должен.
 *
 * Между ключевым словом и маркером допускается `*` и звёздочный SQL-комментарий
 * без пробелов — так ловятся `SELECT*FROM` и `DELETE`, отделённый от `FROM`
 * комментарием (бывшая узкая версия с обязательным пробелом их пропускала).
 * Самотест — ниже.
 */
const SQL_FRAGMENT =
  /['"`]\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^'"`]*?(?:\*\/|\*|\s)\s*(?:FROM|INTO|SET|VALUES|WHERE|JOIN|TABLE)\b/;

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

/**
 * Самотест детектора SQL (задача 7e5099ed п. 5). Детектор — эвристика на
 * английской прозе, поэтому обе стороны проверяются явно: позитивы —
 * формы, которые пропускала сужённая версия с обязательным пробелом после
 * ключевого слова; негативы — реальные строки `server/src/mcp` после
 * перевода на английский (задача 720b71e5), включая предложения с глаголом
 * в начале. Негатив, который снова начнёт ловиться, — сигнал, что сторож
 * красит прозу, а не SQL.
 */
describe('guard: SQL_FRAGMENT — самотест детектора', () => {
  /** Настоящие SQL-фрагменты: детектор обязан их ловить. */
  const positives = [
    // Сужённая версия требовала пробел после ключевого слова и теряла эти две.
    "'SELECT*FROM thoughts'",
    "'DELETE/**/FROM thoughts'",
    // Обычные запросы с колонками, значениями и условием.
    '"SELECT id, title FROM thoughts"',
    "'INSERT INTO thoughts (id, title) VALUES (?, ?)'",
    "'UPDATE thoughts SET title = ? WHERE id = ?'",
    '`SELECT ${columns} FROM thoughts`',
    "'  SELECT id FROM thoughts'",
  ];
  /** Английская проза из MCP-описаний: детектор обязан молчать. */
  const negatives = [
    "'Reserve layer: if the merge overwrites or deletes anything, the server automatically creates a service reserve layer'",
    "'physically deletes the rows of the thought from the layer'",
    "': a sub-selection of THOUGHTS (the thoughts profile); targets in the network'",
    "'(including one deleted from the registry)'",
    "'… selects thoughts into sections; two forms: the old flat'",
    // Проза с глаголом в начале предложения — регистр отличает её от SQL.
    "'Delete from the registry after the check'",
    "'Select a network from the list'",
    "'Update the value in the table'",
    "'delete one ontology entity (thought_type / link_type / property)'",
    "'delete a comment (permanent or chronological) together with attachments'",
  ];

  for (const line of positives) {
    it(`ловит SQL: ${line}`, () => {
      assert.equal(SQL_FRAGMENT.test(line), true, 'SQL-фрагмент обязан ловиться');
    });
  }
  for (const line of negatives) {
    it(`не ловит прозу: ${line}`, () => {
      assert.equal(SQL_FRAGMENT.test(line), false, 'английская проза — не SQL');
    });
  }
});
