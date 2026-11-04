/**
 * Сторож: поверхность MCP — английская (ADR `daab6ac4`, задача `720b71e5`).
 *
 * Норма ADR: MCP — единый английский, язык сессии/ключа не вводится. Агент
 * видит `tools/list`, описания схем, справку `etn.guide`, каталог `etn.ops`,
 * промпты, ресурсы и тексты ошибок; кириллица в этих строках означает, что
 * поверхность снова стала двуязычной.
 *
 * Сканируются `server/src/mcp/**`, контракты инструментов
 * (`server/src/contracts.ts`) и общие типы MCP (`shared/src/types/mcp.ts`).
 * Комментарии и идентификаторы не проверяются — AST видит только строковые
 * литералы, включая шаблонные фрагменты. Русские комментарии в коде ADR не
 * нарушают (это не текст для агента).
 *
 * Мутационная проверка (последний тест) подаёт сканеру синтетическое описание
 * инструмента с русским текстом и требует нарушения — правило не «мёртвое».
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MCP_ROOT = path.join(REPO_ROOT, 'server', 'src', 'mcp');
const EXTRA_FILES = ['server/src/contracts.ts', 'shared/src/types/mcp.ts'] as const;

/** Кириллица (основной блок + дополнение). */
const CYRILLIC = /[\u0400-\u04FF]/;

interface Violation {
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

/** Просканировать один исходник (вынесено ради мутационной проверки). */
function scanSource(rel: string, text: string): Violation[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    // Строковый литерал и любой фрагмент шаблонной строки — потенциальный
    // текст для агента. `node.text` не содержит комментариев.
    const fragment =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
          ? node.text
          : null;
    if (fragment !== null && CYRILLIC.test(fragment)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push({
        file: rel,
        line: line + 1,
        text: fragment.replace(/\s+/g, ' ').trim().slice(0, 160),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

/** Ошибка-сообщение для падения сторожа. */
function report(violations: Violation[]): string {
  return (
    'Поверхность MCP обязана быть английской (ADR daab6ac4, задача 720b71e5):\n' +
    violations
      .map((v) => `  • ${v.file}:${v.line} — ${v.text}`)
      .join('\n')
  );
}

describe('guard: поверхность MCP — английская (daab6ac4, 720b71e5)', () => {
  it('в server/src/mcp, контрактах и общих типах MCP нет кириллицы в строках', () => {
    const violations: Violation[] = [];
    for (const abs of listSourceFiles(MCP_ROOT)) {
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      violations.push(...scanSource(rel, fs.readFileSync(abs, 'utf8')));
    }
    for (const rel of EXTRA_FILES) {
      violations.push(...scanSource(rel, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')));
    }
    assert.deepEqual(violations, [], report(violations));
  });

  it('мутационная проверка: русское описание инструмента краснит сторож', () => {
    const violations = scanSource(
      'server/src/mcp/synthetic.ts',
      "registerTool('etn.demo', { description: 'русское описание инструмента' }, () => undefined);\n",
    );
    assert.equal(violations.length, 1, 'сканер обязан поймать кириллицу в описании инструмента');
    assert.match(violations[0]!.text, /русское описание/);
  });

  it('мутационная проверка: русский фрагмент шаблонной строки тоже ловится', () => {
    const violations = scanSource(
      'server/src/mcp/synthetic.ts',
      'const text = `How to: ${action} — по-русски`;\n',
    );
    assert.equal(violations.length, 1, 'сканер обязан видеть фрагменты шаблонной строки');
    assert.match(violations[0]!.text, /по-русски/);
  });
});
