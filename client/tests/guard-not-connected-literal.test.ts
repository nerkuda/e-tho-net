/**
 * Сторож единственного источника строки «Not connected…» (ошибка f803afb6,
 * круги 2–4).
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
 * (замечание верификатора круга 2, закрыто в круге 3).
 *
 * Строки-комментарии разрешены по СОСТОЯНИЮ ЛЕКСЕРА, а не по первому символу
 * строки: продолжение шаблонной строки, начинающееся с `*`, — код, и дубль в
 * нём краснит сторож (замечание проверки круга 3, дефект с круга 2; закрыто в
 * круге 4). Расширения файлов сканируются без учёта регистра (`.TS` — тот же
 * исходник): это правка общего `guard-helpers.ts`, тоже круг 4.
 *
 * Мутации, которые краснят: вернуть `throw new Error('Not connected: …')` в
 * `client/src/main/ipc/handlers.ts` или `connection-lifecycle.ts`; вернуть
 * литерал в любой тест; вернуть широкий `rel`-allow; вернуть эвристику
 * «комментарий — по первому символу строки»; вернуть регистрозависимое
 * сравнение расширения в `guard-helpers.ts`.
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

/** Диапазон комментария в содержимом файла: `[start, end)`. */
interface CommentRange {
  start: number;
  end: number;
}

/** Кадр стека лексера: режим, глубина `{…}` интерполяции и начало комментария. */
interface LexFrame {
  mode: 'code' | 'template' | 'single' | 'double' | 'line' | 'block';
  /** Для `code` внутри `${…}`: сколько `{` ещё не закрыто (стартует с 1). */
  braces: number;
  /** Для `line`/`block`: смещение начала комментария; иначе -1. */
  commentStart: number;
}

/**
 * Диапазоны комментариев файла — по состоянию лексера, а не по первому символу
 * строки. Различаются `//`, `/* … *\/`, строки `'…'`/`"…"` и шаблоны `` `…` ``
 * с экранированием и вложенными `${…}` (в интерполяции комментарии настоящие).
 *
 * Намеренно простой лексер для тест-сторожа: регулярные литералы (`/…/`) не
 * распознаются, поэтому `//` и `/*` внутри них считаются комментарием. Это
 * безопасное направление: пропустить дубль так можно только в файле, где
 * регулярка с таким содержимым стоит ПЕРЕД литералом на той же строке; в
 * `client`/`shared` таких файлов нет. Строки и шаблоны при этом считаются
 * кодом — литерал в них нарушение, а не цитата.
 */
function commentRanges(content: string): CommentRange[] {
  const ranges: CommentRange[] = [];
  const stack: LexFrame[] = [{ mode: 'code', braces: 0, commentStart: -1 }];
  const top = (): LexFrame => stack[stack.length - 1]!;
  let i = 0;
  while (i < content.length) {
    const frame = top();
    const ch = content[i]!;
    switch (frame.mode) {
      case 'line':
        if (ch === '\n') {
          stack.pop();
          ranges.push({ start: frame.commentStart, end: i });
        }
        i += 1;
        break;
      case 'block':
        if (ch === '*' && content[i + 1] === '/') {
          stack.pop();
          ranges.push({ start: frame.commentStart, end: i + 2 });
          i += 2;
        } else {
          i += 1;
        }
        break;
      case 'single':
      case 'double':
        if (ch === '\\') {
          i += 2;
        } else {
          if (ch === (frame.mode === 'single' ? "'" : '"')) stack.pop();
          i += 1;
        }
        break;
      case 'template':
        if (ch === '\\') {
          i += 2;
        } else if (ch === '`') {
          stack.pop();
          i += 1;
        } else if (ch === '$' && content[i + 1] === '{') {
          stack.push({ mode: 'code', braces: 1, commentStart: -1 });
          i += 2;
        } else {
          i += 1;
        }
        break;
      case 'code':
        if (ch === '/' && content[i + 1] === '/') {
          stack.push({ mode: 'line', braces: 0, commentStart: i });
          i += 2;
        } else if (ch === '/' && content[i + 1] === '*') {
          stack.push({ mode: 'block', braces: 0, commentStart: i });
          i += 2;
        } else if (ch === "'") {
          stack.push({ mode: 'single', braces: 0, commentStart: -1 });
          i += 1;
        } else if (ch === '"') {
          stack.push({ mode: 'double', braces: 0, commentStart: -1 });
          i += 1;
        } else if (ch === '`') {
          stack.push({ mode: 'template', braces: 0, commentStart: -1 });
          i += 1;
        } else if (ch === '{' && frame.braces > 0) {
          frame.braces += 1;
          i += 1;
        } else if (ch === '}' && frame.braces > 0) {
          frame.braces -= 1;
          if (frame.braces === 0) stack.pop();
          i += 1;
        } else {
          i += 1;
        }
        break;
    }
  }
  // Комментарий, не закрытый до конца файла: `line` без перевода строки или
  // `block` без `*/` — тянется до EOF.
  const last = top();
  if (last.mode === 'line' || last.mode === 'block') {
    ranges.push({ start: last.commentStart, end: content.length });
  }
  return ranges;
}

/**
 * Все совпадения литерала на строке `lineNo` лежат внутри комментариев файла
 * (одна строка может содержать и цитату в комментарии, и дубль в коде — тогда
 * нарушение есть).
 */
function isOnlyInComments(content: string, lineNo: number, line: string): boolean {
  const ranges = commentRanges(content);
  let lineStart = 0;
  for (let n = 1; n < lineNo; n += 1) {
    const newline = content.indexOf('\n', lineStart);
    if (newline === -1) return false; // строка за пределами содержимого — не наша
    lineStart = newline + 1;
  }
  const matches = [...line.matchAll(new RegExp(LITERAL_RE.source, 'g'))];
  if (matches.length === 0) return false;
  return matches.every((match) => {
    const offset = lineStart + (match.index ?? 0);
    return ranges.some((range) => offset >= range.start && offset < range.end);
  });
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
      allow: (rel, line, lineNo, content) =>
        allowedFiles.has(pathKey(path.resolve(root, rel))) ||
        isOnlyInComments(content, lineNo, line),
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

  it('ловит литерал на строке продолжения шаблона, начинающейся с *', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-template-'));
    mkdirSync(path.join(dir, 'src'));
    // Строка продолжения шаблонной строки начинается с `*`: эвристика «первый
    // символ строки» принимала её за JSDoc и пропускала дубль (дыра круга 2).
    writeFileSync(
      path.join(dir, 'src', 'template.ts'),
      'const message = `\n * Not connected: call etn.server.connect first`;\n',
    );
    // Настоящий комментарий рядом остаётся разрешённым — правка не расширяет запрет.
    writeFileSync(
      path.join(dir, 'src', 'note.ts'),
      '/** Цитата: Not connected: call etn.server.connect first */\nexport const ok = 1;\n',
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/template.ts:2'],
      `нарушения: ${JSON.stringify(hits)}`,
    );
  });

  it('не зависит от регистра расширения: литерал в dup-upper.TS ловится', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-guard-not-connected-ext-'));
    mkdirSync(path.join(dir, 'src'));
    // Регистр расширения не должен прятать исходник от сторожа.
    writeFileSync(
      path.join(dir, 'src', 'dup-upper.TS'),
      "throw new Error('Not connected: call etn.server.connect first');\n",
    );

    const hits = collectViolations(dir, rulesFor(dir, path.join(dir, 'src', 'errors.ts')));
    assert.deepEqual(
      hits.map((v) => `${v.file}:${v.line}`),
      ['src/dup-upper.TS:1'],
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
