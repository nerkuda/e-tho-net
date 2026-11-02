/**
 * Сторож локализации (задачи 57f09136, 3c9f23dc; требование 0e5ff1c6
 * «Локализация: все строки интерфейса — из словаря, с подстановками
 * параметров»).
 *
 * Правило: пользовательские строки берутся только из словаря (`lib/i18n.ts` +
 * каталоги `lib/locales/*`), а не пишутся литералами в разметке. Проверяются
 * четыре запрета/инварианта:
 *
 * 1. **Литералы в renderer.** Во всём `client/src/renderer` нет строковых
 *    литералов с кириллицей — только вызовы `t('…')`/`tp('…')`. Границы
 *    исключений минимальны и перечислены ниже.
 * 2. **Целостность словаря.** Каждый ключ из `t('…')`/`tp('…')` в исходниках
 *    рендерера есть в каталоге `ru` — опечатка не доедет до пользователя.
 * 3. **Полнота каталога.** У каждого ключа `ru` непустой русский текст —
 *    «перевод» не может остаться заглушкой.
 * 4. **Ленивое вычисление текста (ошибка ebed42d3).** `t()`/`tp()` не
 *    вызываются на верхнем уровне модуля (в инициализаторах констант, полях
 *    массивов/объектов, статических полях класса): такой текст фиксирует язык
 *    импорта и не следует живой смене языка. Текст вычисляется лениво —
 *    функцией/геттером в момент рендера. Проверка — по AST, а не по тексту:
 *    тело функции, стрелки, метода или геттера лениво по определению, а тело
 *    немедленно вызываемой функции (IIFE) — нет.
 *
 * Исключения (только они и ничего больше):
 * - `lib/locales/**` — сам словарь и тестовая локаль `zz`: там тексты и есть
 *   содержимое;
 * - строки-комментарии (`//`, `/*`, `*`) — в интерфейс не попадают;
 * - строки с маркером `// i18n: technical` — технические сообщения: тексты
 *   `throw new Error(…)` о контракте для разработчика и диагностика в
 *   `console.*`. Пользовательская строка маркером не прикрывается;
 * - модульный вызов с маркером `// i18n: module-level` (на строке вызова или
 *   на первой строке объявления) и обоснованием — осознанный случай, когда
 *   значение обязано быть снято именно при импорте (например, ключ словаря,
 *   а не текст). Пустого маркера без обоснования быть не должно.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { assertGuardClean, listSourceFiles } from './guard-helpers.js';
import { ru, ruPlurals } from '../src/renderer/lib/locales/ru.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Строковый литерал, содержащий кириллицу. */
const CYRILLIC_LITERAL = /['"`][^'"`\n]*[А-Яа-яЁё][^'"`\n]*['"`]/;

/** Маркер технической строки: осознанное исключение с обоснованием на месте. */
const TECHNICAL_MARKER = 'i18n: technical';

/** Маркер осознанного модульного вызова: обоснование обязательно на месте. */
const MODULE_LEVEL_MARKER = 'i18n: module-level';

/**
 * Область сканирования — весь renderer, кроме словаря и тестовой локали:
 * их содержимое — сами тексты, а не разметка.
 */
const SCANNED_FILES = (rel: string): boolean => !rel.startsWith('lib/locales/');

/** Комментарий (строчный, блочный или строка JSDoc) — не разметка. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Ключи, встречающиеся в коде как `t('ключ'…)`/`tp('ключ'…)` (комментарии не считаются). */
function collectUsedKeys(fn: 't' | 'tp'): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const call = new RegExp(`(?<![\\w$.])${fn}\\(\\s*'([^']+)'`, 'g');
  for (const abs of listSourceFiles(RENDERER_ROOT)) {
    const rel = path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/');
    if (rel.startsWith('lib/locales/')) continue; // сам словарь
    const source = fs.readFileSync(abs, 'utf8');
    for (const line of source.split('\n')) {
      if (isCommentLine(line)) continue; // примеры в JSDoc — не вызовы
      for (const match of line.matchAll(call)) {
        const key = match[1]!;
        const list = used.get(key) ?? [];
        list.push(rel);
        used.set(key, list);
      }
    }
  }
  return used;
}

/** Один вызов `t()`/`tp()`, выполняемый при импорте модуля. */
interface ModuleLevelCall {
  /** Номер строки (с 1). */
  line: number;
  /** Текст вызова (первая строка). */
  text: string;
}

/**
 * Имена `t`/`tp` из импорта `i18n` в файле — включая алиасы
 * (`import { t as tr }`): вызов ищется по имени, а не по тексту модуля.
 */
function i18nFunctionNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    // `./i18n.js`, `../lib/i18n.js`, `i18n` — путь заканчивается именем модуля.
    const spec = st.moduleSpecifier;
    if (!ts.isStringLiteral(spec) || !/(^|\/)i18n(\.js|\.ts)?$/.test(spec.text)) continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (imported === 't' || imported === 'tp') names.add(el.name.text);
    }
  }
  return names;
}

/**
 * Тело функции/метода выполняется при вызове, а не при импорте модуля —
 * `t()` в нём ленив по определению. Геттер тоже ленив: его тело исполняется
 * в момент чтения свойства.
 */
function isLazyBody(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * Вызовы `t()`/`tp()`, которые выполняются при импорте модуля (ошибка
 * ebed42d3): инициализаторы констант, элементы массивов/объектов,
 * статические поля класса и тело немедленно вызываемой функции. Тела
 * функций, стрелок, методов и геттеров, а также функции-аргументы вызовов
 * (`map(() => t(…))`, `onLangChange(() => …)`) — ленивы и не считаются.
 *
 * Разбор — AST: регэксп не отличает `const X = t('…')` от
 * `const X = () => t('…')` и ломается на многострочных литералах.
 */
function moduleLevelI18nCalls(fileName: string, source: string): ModuleLevelCall[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = i18nFunctionNames(sf);
  if (names.size === 0) return [];
  const lines = source.split('\n');
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  /** Исключение — маркер на строке вызова или в первой строке объявления. */
  const hasModuleLevelMarker = (node: ts.Node): boolean => {
    let top: ts.Node = node;
    while (top.parent !== undefined && !ts.isSourceFile(top.parent)) top = top.parent;
    return (
      (lines[lineOf(node) - 1] ?? '').includes(MODULE_LEVEL_MARKER) ||
      (lines[lineOf(top) - 1] ?? '').includes(MODULE_LEVEL_MARKER)
    );
  };

  const calls: ModuleLevelCall[] = [];
  const visitEager = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        names.has(node.expression.text) &&
        !hasModuleLevelMarker(node)
      ) {
        calls.push({ line: lineOf(node), text: node.getText(sf).split('\n')[0]! });
      }
      // Немедленно вызываемая функция (IIFE) выполняется при импорте.
      const callee = ts.isParenthesizedExpression(node.expression)
        ? node.expression.expression
        : node.expression;
      if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) visitEager(callee.body);
      // Аргументы вычисляются сразу; тела переданных функций — при вызове.
      for (const arg of node.arguments) {
        if (ts.isFunctionExpression(arg) || ts.isArrowFunction(arg)) continue;
        visitEager(arg);
      }
      return;
    }
    if (isLazyBody(node)) return;
    // Статические поля и статические блоки класса выполняются при объявлении.
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const member of node.members) {
        if (ts.isClassStaticBlockDeclaration(member)) visitEager(member.body);
        else if (ts.isPropertyDeclaration(member)) {
          const isStatic =
            member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
          if (isStatic && member.initializer !== undefined) visitEager(member.initializer);
        }
      }
      return;
    }
    ts.forEachChild(node, visitEager);
  };
  visitEager(sf);
  return calls;
}

describe('guard: локализация renderer', () => {
  it('в renderer нет русских строковых литералов вне словаря', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-russian-literals-outside-dictionary',
        description:
          'Пользовательские строки берутся из словаря `lib/i18n.ts` через ' +
          "`t('ключ')`/`tp('ключ')`: во всём `client/src/renderer`, кроме " +
          '`lib/locales/**`, комментариев и строк с маркером ' +
          '`// i18n: technical`, русских литералов в разметке нет ' +
          '(требование 0e5ff1c6).',
        pattern: CYRILLIC_LITERAL,
        include: SCANNED_FILES,
        allow: (_rel, line) => isCommentLine(line) || line.includes(TECHNICAL_MARKER),
      },
    ]);
  });

  it('каждый ключ из t(…) есть в словаре ru', () => {
    const missing = [...collectUsedKeys('t').keys()].filter(
      (key) => !(key in ru),
    );
    assert.deepEqual(
      missing,
      [],
      `Ключи без строки в словаре ru: ${missing.join(', ')}`,
    );
  });

  it('каждый ключ из tp(…) есть в каталоге форм ruPlurals', () => {
    const missing = [...collectUsedKeys('tp').keys()].filter(
      (key) => !(key in ruPlurals),
    );
    assert.deepEqual(
      missing,
      [],
      `Ключи без форм в ruPlurals: ${missing.join(', ')}`,
    );
  });

  it('каждый ключ словаря ru имеет непустой русский текст', () => {
    const empty = Object.entries(ru)
      .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
      .map(([key]) => key);
    assert.deepEqual(empty, [], `Пустые значения словаря ru: ${empty.join(', ')}`);
    const nonRussian = Object.entries(ru)
      .filter(([, value]) => !/[А-Яа-яЁё]/.test(value))
      .map(([key]) => key);
    assert.deepEqual(nonRussian, [], `Ключи без русского текста: ${nonRussian.join(', ')}`);
  });

  it('детектор модульных t()/tp() различает импорт и ленивое вычисление', () => {
    const probe = [
      "import { t, tp } from './lib/i18n.js';",
      "const SCALAR = t('actions.save');",
      "const PLURAL = tp('plurals.link', 2);",
      "const LAZY = () => t('actions.save');",
      "const GETTERS = { get save() { return t('actions.save'); } };",
      "const MAP = [1, 2].map((n) => tp('plurals.link', n));",
      "const IIFE = (() => t('actions.save'))();",
      "const MARKED = t('actions.save'); // i18n: module-level — ключ, а не текст",
    ].join('\n');
    const found = moduleLevelI18nCalls('probe.ts', probe).map((call) => call.line);
    assert.deepEqual(
      found,
      [2, 3, 7],
      'модульными считаются только вызовы, исполняемые при импорте (строки 2, 3 и IIFE 7); ' +
        'стрелки/геттеры/колбэки и строка с маркером — ленивы',
    );
  });

  it('в renderer нет t()/tp() на верхнем уровне модуля — текст вычисляется лениво', () => {
    const violations: string[] = [];
    for (const abs of listSourceFiles(RENDERER_ROOT)) {
      const rel = path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/');
      if (!SCANNED_FILES(rel)) continue;
      const source = fs.readFileSync(abs, 'utf8');
      for (const call of moduleLevelI18nCalls(rel, source)) {
        violations.push(`  • ${rel}:${call.line} — ${call.text}`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      't()/tp() на верхнем уровне модуля фиксируют язык импорта: живая смена языка ' +
        'их не перерисует (ошибка ebed42d3). Текст вычисляется лениво — функцией ' +
        'или геттером в момент рендера.\n' +
        violations.join('\n'),
    );
  });
});
