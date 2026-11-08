/**
 * Сторож: сообщения серверных поверхностей — английские (ADR `daab6ac4`,
 * задача `4f6c972a`).
 *
 * Норма ADR: REST `error.message`, коды/`details`, тексты WebSocket-событий и
 * причин закрытия, вывод CLI, ошибки обновления и служебные сообщения
 * логгера — всегда английские. Язык сервера/сети/пользователя на серверные
 * тексты не влияет: перевод пользовательского текста — забота клиента по
 * `code`/`details.reason`. Русские комментарии в коде и русские ДАННЫЕ
 * (заголовок базового слоя «Основа», Markdown-экспорт, подписи трансклюзий,
 * описания MCP-инструментов — отдельная задача `720b71e5`) под правило не
 * попадают.
 *
 * Запрет, который можно нарушить кодом, действует только вместе со сторожем
 * (AGENTS.md §2 п.5). Сторож сканирует `server/src` и `shared/src` (общие
 * константы — тоже серверная поверхность) и краснеет на кириллице в
 * местах, которые становятся текстом для пользователя:
 *
 *   1. аргумент-сообщение `new EtnError(...)` и любого `new *Error(...)`;
 *   2. литеральные значения свойств `msg`/`message` (контракты, диагностики,
 *      предупреждения);
 *   3. литеральные аргументы вызова логгера (`logger.info/warn/error/...`);
 *   4. литеральное сообщение хелпера `fail(...)` (движок AST-фильтров) и
 *      `refuse(...)` (ожидаемый отказ инструмента БД);
 *   5. причина закрытия WebSocket (`socket.close(code, reason)`);
 *   6. экспортируемые константы с именем `*_MESSAGE`/`*_WARNING`/`*_TEXT`/
 *      `*_REASON`;
 *   7. любые литералы в `server/src/cli.ts` — это целиком пользовательский
 *      вывод CLI;
 *   8. литеральные аргументы `console.log/info/warn/error/debug(...)` —
 *      прямой вывод CLI и `etn-db-tool` установщика (в обход логгера).
 *
 * Литерал склеивается из конкатенации `+`, шаблонных фрагментов и
 * тернарников, а идентификатор резолвится в константу того же файла — иначе
 * сообщение, собранное из кусков, прошло бы мимо. Мутационная проверка
 * (последний тест) подаёт сканеру синтетический исходник с русским
 * сообщением и требует нарушения — правило не «мёртвое».
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_ROOTS = ['server/src', 'shared/src'] as const;
const CLI_FILE = 'server/src/cli.ts';

/** Кириллица (основной блок + дополнение). */
const CYRILLIC = /[\u0400-\u04FF]/;

/** Свойства, значение которых уходит пользователю как текст сообщения. */
const MESSAGE_PROPERTIES = new Set(['msg', 'message']);

/** Вызов логгера: `logger.info(...)`, `this.logger?.warn(...)`, `log?.error(...)`. */
const LOGGER_CALL =
  /(?:^|\.)(?:logger|log|fileLog)(?:\?)?\.(?:trace|debug|info|warn|error|fatal)$/;

/** Имя экспортируемой константы-сообщения. */
const MESSAGE_CONSTANT = /(?:MESSAGE|WARNING|TEXT|REASON)$/;

interface Violation {
  rule: string;
  file: string;
  line: number;
  text: string;
}

/** Все `.ts`-файлы под каталогом (без `node_modules`/`dist`). */
function listSourceFiles(dir: string): string[] {
  const result: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') stack.push(abs);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        result.push(abs);
      }
    }
  }
  return result.sort();
}

/** Склеенный литеральный текст выражения; `undefined` — не литерал. */
function literalText(
  node: ts.Expression | undefined,
  constStrings: ReadonlyMap<string, string>,
): string | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) text += span.literal.text;
    return text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(node.left, constStrings);
    const right = literalText(node.right, constStrings);
    if (left === null && right === null) return null;
    return (left ?? '') + (right ?? '');
  }
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression, constStrings);
  if (ts.isConditionalExpression(node)) {
    const whenTrue = literalText(node.whenTrue, constStrings);
    const whenFalse = literalText(node.whenFalse, constStrings);
    if (whenTrue === null && whenFalse === null) return null;
    return (whenTrue ?? '') + (whenFalse ?? '');
  }
  if (ts.isIdentifier(node)) return constStrings.get(node.text) ?? null;
  return null;
}

/** Константы файла: имя → литеральный текст (для сообщений из кусков). */
function collectConstStrings(source: ts.SourceFile): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const text = literalText(node.initializer, result);
      if (text !== null) result.set(node.name.text, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

/** Проверить один литерал и записать нарушение. */
function check(
  violations: Violation[],
  rule: string,
  rel: string,
  source: ts.SourceFile,
  node: ts.Node,
  text: string | null,
): void {
  if (text === null || !CYRILLIC.test(text)) return;
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  violations.push({
    rule,
    file: rel,
    line: line + 1,
    text: text.replace(/\s+/g, ' ').trim().slice(0, 160),
  });
}

/** Просканировать один исходник (вынесено ради мутационной проверки). */
function scanSource(rel: string, text: string): Violation[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const constStrings = collectConstStrings(source);
  const violations: Violation[] = [];
  const isCli = rel === CLI_FILE;

  const visit = (node: ts.Node): void => {
    // (1) Сообщение конструктора ошибки: `new EtnError(code, message)` или
    // `new *Error(message)` — текст попадает в REST/WS/CLI/лог.
    if (ts.isNewExpression(node)) {
      const className = node.expression.getText(source);
      if (className.endsWith('Error')) {
        for (const arg of node.arguments ?? []) {
          check(violations, 'error-message', rel, source, arg, literalText(arg, constStrings));
        }
      }
    }

    // (2) Свойство `msg`/`message` — контракт, диагностика, предупреждение.
    if (ts.isPropertyAssignment(node) && MESSAGE_PROPERTIES.has(node.name.getText(source))) {
      check(
        violations,
        'msg-property',
        rel,
        source,
        node,
        literalText(node.initializer, constStrings),
      );
    }

    // (3) Логгер: текст — последний аргумент.
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (LOGGER_CALL.test(callee)) {
        const last = node.arguments[node.arguments.length - 1];
        check(violations, 'logger-message', rel, source, node, literalText(last, constStrings));
      }
      // (4) `fail(message, details)` — общий отказ движка AST-фильтров.
      if (callee === 'fail') {
        check(
          violations,
          'fail-message',
          rel,
          source,
          node,
          literalText(node.arguments[0], constStrings),
        );
      }
      // (8) `refuse(message)` — ожидаемый отказ инструмента БД (db-backup).
      if (callee === 'refuse') {
        check(
          violations,
          'refuse-message',
          rel,
          source,
          node,
          literalText(node.arguments[0], constStrings),
        );
      }
      // (9) Прямой вывод консоли: CLI и etn-db-tool установщика.
      if (/^console\.(?:log|info|warn|error|debug)$/.test(callee)) {
        for (const arg of node.arguments) {
          check(violations, 'console-message', rel, source, arg, literalText(arg, constStrings));
        }
      }
      // (5) Причина закрытия WebSocket: `socket.close(code, reason)`.
      if (callee.endsWith('.close') || callee === 'close') {
        check(
          violations,
          'close-reason',
          rel,
          source,
          node,
          literalText(node.arguments[1], constStrings),
        );
      }
    }

    // (6) Экспортируемая константа-сообщение.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      MESSAGE_CONSTANT.test(node.name.text) &&
      (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0
    ) {
      check(
        violations,
        'message-constant',
        rel,
        source,
        node,
        literalText(node.initializer, constStrings),
      );
    }

    // (7) CLI: любой литерал — пользовательский вывод.
    if (
      isCli &&
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node))
    ) {
      check(violations, 'cli-text', rel, source, node, literalText(node, constStrings));
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

/** Ошибка-сообщение для падения сторожа. */
function report(violations: Violation[]): string {
  return (
    'Сообщения серверных поверхностей обязаны быть английскими (ADR daab6ac4):\n' +
    violations
      .map((v) => `  • ${v.file}:${v.line} [${v.rule}] — ${v.text}`)
      .join('\n')
  );
}

describe('guard: сообщения серверных поверхностей — английские (ADR daab6ac4)', () => {
  it('в server/src и shared/src нет кириллицы в сообщениях пользователю', () => {
    const violations: Violation[] = [];
    for (const root of SCAN_ROOTS) {
      for (const abs of listSourceFiles(path.join(REPO_ROOT, root))) {
        const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
        violations.push(...scanSource(rel, fs.readFileSync(abs, 'utf8')));
      }
    }
    assert.deepEqual(violations, [], report(violations));
  });

  it('мутационная проверка: русское сообщение EtnError краснит сторож', () => {
    const violations = scanSource(
      'server/src/synthetic.ts',
      "throw new EtnError('VALIDATION_ERROR', 'русское сообщение');\n",
    );
    assert.ok(
      violations.some((v) => v.rule === 'error-message'),
      'сканер обязан поймать кириллицу в сообщении new EtnError(...)',
    );
  });

  it('мутационная проверка: сообщение, склеенное из кусков и константы, тоже ловится', () => {
    const violations = scanSource(
      'server/src/synthetic.ts',
      [
        "const PROBLEM = 'русская причина';",
        "logger.warn({ id: 1 }, 'prefix: ' + PROBLEM);",
        '',
      ].join('\n'),
    );
    assert.ok(
      violations.some((v) => v.rule === 'logger-message'),
      'сканер обязан склеивать конкатенацию и резолвить константу файла',
    );
  });

  it('мутационная проверка: русский текст в refuse(...) и console.* краснит сторож', () => {
    const refuseViolations = scanSource(
      'server/src/synthetic.ts',
      "refuse('русская причина отказа');\n",
    );
    assert.ok(
      refuseViolations.some((v) => v.rule === 'refuse-message'),
      'сканер обязан поймать кириллицу в refuse(...) (etn-db-tool)',
    );
    const consoleViolations = scanSource(
      'server/src/synthetic.ts',
      "console.error('русская ошибка CLI');\n",
    );
    assert.ok(
      consoleViolations.some((v) => v.rule === 'console-message'),
      'сканер обязан поймать кириллицу в console.error(...)',
    );
  });
});
