/**
 * Сторож единственного источника строки «Not connected…» (ошибка f803afb6,
 * круги 2–3).
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
 * сторож. Исключения задаются АБСОЛЮТНЫМИ путями: относительный
 * `rel === 'src/errors.ts'` разрешал одноимённый файл в каждом корне
 * сканирования, и `client/src/errors.ts` с литералом проходил сторожем
 * (замечание верификатора круга 3).
 *
 * Мутации, которые краснят: вернуть `throw new Error('Not connected: …')` в
 * `client/src/main/ipc/handlers.ts` или `connection-lifecycle.ts`; вернуть
 * литерал в любой тест; вернуть широкий `rel`-allow.
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
 * Ключ абсолютного пути для сравнения исключений: на Windows регистр не
 * значим (путь от `readdir` и от `import.meta.url` может отличаться регистром
 * диска или каталога).
 */
function pathKey(file: string): string {
  const abs = path.resolve(file);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * Правила для одного корня сканирования.
 *
 * @param root — корень сканирования (относительные пути helper'а считаются от него)
 * @param sourceFile — абсолютный путь единственного разрешённого источника строки
 * @param exemptFiles — абсолютные пути файлов, цитирующих литерал в объявлении правила
 */
function rulesFor(root: string, sourceFile: string, exemptFiles: readonly string[] = []): GuardRule[] {
  const allowedFiles = new Set([sourceFile, ...exemptFiles].map(pathKey));
  return [
    {
      name: 'not-connected-single-source',
      description:
        'канонический отказ «Not connected…» живёт только в shared/src/errors.ts; ' +
        'main, renderer и тесты обязаны брать NOT_CONNECTED_ERROR_TEXT/' +
        'NOT_CONNECTED_NETWORK_ERROR_TEXT, а не собственный литерал',
      pattern: LITERAL_RE,
      allow: (rel, line) =>
        isCommentLine(rel, line) || allowedFiles.has(pathKey(path.resolve(root, rel))),
    },
  ];
}

/** Единственный источник строки и файл, цитирующий её в объявлении правила. */
const SOURCE_FILE = path.resolve(SHARED_ROOT, 'src', 'errors.ts');
const GUARD_FILE = fileURLToPath(import.meta.url);

function rules(root: string): GuardRule[] {
  return rulesFor(root, SOURCE_FILE, [GUARD_FILE]);
}

describe('guard: строка «Not connected…» — один источник (f803afb6)', () => {
  it('в client и shared нет дубля литерала', () => {
    assertGuardClean(CLIENT_ROOT, rules(CLIENT_ROOT));
    assertGuardClean(SHARED_ROOT, rules(SHARED_ROOT));
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

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/handlers.ts:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('одноимённый client/src/errors.ts — нарушение: источник только в shared', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-roots-'));
    const clientRoot = path.join(dir, 'client');
    const sharedRoot = path.join(dir, 'shared');
    const source = path.join(sharedRoot, 'src', 'errors.ts');
    mkdirSync(path.dirname(source), { recursive: true });
    mkdirSync(path.join(clientRoot, 'src'), { recursive: true });

    // Источник строки — только shared.
    writeFileSync(
      source,
      "export const NOT_CONNECTED_ERROR_TEXT = 'Not connected: call etn.server.connect first';\n",
    );
    // Одноимённый файл в клиенте: широкий `rel === 'src/errors.ts'` пропускал его.
    writeFileSync(
      path.join(clientRoot, 'src', 'errors.ts'),
      "export const DUP = 'Not connected: call etn.server.connect first';\n",
    );

    const hits = collectViolations(clientRoot, rulesFor(clientRoot, source));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/errors.ts:1'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
    assert.deepEqual(collectViolations(sharedRoot, rulesFor(sharedRoot, source)), []);
  });
});
