/**
 * Сторож единственного источника строки «Not connected…» (ошибка f803afb6,
 * круг 2).
 *
 * Канонический отказ main до установки соединения — `NOT_CONNECTED_ERROR_TEXT`
 * и `NOT_CONNECTED_NETWORK_ERROR_TEXT` из `@etn/shared`. До этого литерал был
 * продублирован в `ipc/handlers.ts` (шесть мест), `ipc/connection-lifecycle.ts`,
 * регэкспе `renderer/lib/dom.ts` и в тестах: смена формулировки в main
 * проходила `npm test`, потому что тест сравнивал с СВОИМ литералом, а не с
 * источником.
 *
 * Правило: полного литерала `Not connected: call etn.server.connect…` нет нигде,
 * кроме `shared/src/errors.ts`. Main, renderer и тесты берут константу из
 * shared — поэтому «тест сравнивает с собственным литералом» тоже краснит
 * сторож.
 *
 * Мутации, которые краснят: вернуть `throw new Error('Not connected: …')` в
 * `client/src/main/ipc/handlers.ts` или `connection-lifecycle.ts`; вернуть
 * литерал в любой тест.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations, type GuardRule } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_ROOT = path.resolve(CLIENT_ROOT, '..', 'shared');

/** Полная каноническая строка: в коде допустима только в shared-источнике. */
const LITERAL_RE = /Not connected: call etn\.server\.connect/;

/** Строка — комментарий (JSDoc, блочный или однострочный). */
function isCommentLine(_rel: string, line: string): boolean {
  return /^\s*(?:\*|\/\/|\/\*)/.test(line);
}

/**
 * Файл-источник строки. `rel` считается от корня сканирования: для `shared`
 * это `src/errors.ts`, для `client` такого файла нет — правило безвредно.
 * Собственный файл сторожа цитирует шаблон в объявлении правила.
 */
function allowed(rel: string, line: string): boolean {
  return (
    rel === 'src/errors.ts' ||
    rel.endsWith('guard-not-connected-literal.test.ts') ||
    isCommentLine(rel, line)
  );
}

function rules(): GuardRule[] {
  return [
    {
      name: 'not-connected-single-source',
      description:
        'канонический отказ «Not connected…» живёт только в shared/src/errors.ts; ' +
        'main, renderer и тесты обязаны брать NOT_CONNECTED_ERROR_TEXT/' +
        'NOT_CONNECTED_NETWORK_ERROR_TEXT, а не собственный литерал',
      pattern: LITERAL_RE,
      allow: allowed,
    },
  ];
}

describe('guard: строка «Not connected…» — один источник (f803afb6)', () => {
  it('в client и shared нет дубля литерала', () => {
    assertGuardClean(CLIENT_ROOT, rules());
    assertGuardClean(SHARED_ROOT, rules());
  });

  it('ловит дубль, но пропускает источник и комментарий', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-'));
    mkdirSync(path.join(dir, 'src'));
    // Источник: единственное разрешённое место.
    writeFileSync(
      path.join(dir, 'src', 'errors.ts'),
      "export const NOT_CONNECTED_ERROR_PREFIX = 'Not connected: call etn.server.connect';\n",
    );
    // Дубль в коде — нарушение.
    writeFileSync(
      path.join(dir, 'src', 'handlers.ts'),
      "throw new Error('Not connected: call etn.server.connect first');\n",
    );
    // Цитата в комментарии — не источник строки.
    writeFileSync(
      path.join(dir, 'src', 'note.ts'),
      '/** Цитата: Not connected: call etn.server.connect first */\nexport const ok = 1;\n',
    );

    const hits = collectViolations(dir, rules());
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/handlers.ts:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });
});
