/**
 * Сторож локализации (задачи 57f09136, 3c9f23dc, 6c1b56f3; требование
 * 0e5ff1c6 «Локализация: все строки интерфейса — из словаря, с подстановками
 * параметров»).
 *
 * Правило: пользовательские строки берутся только из словаря (`lib/i18n.ts` +
 * каталоги `lib/locales/*`), а не пишутся литералами в разметке. Проверяются
 * пять запретов/инвариантов:
 *
 * 1. **Литералы в renderer.** Во всём `client/src/renderer` нет строковых
 *    литералов с кириллицей — только вызовы `t('…')`/`tp('…')`. Проверяются
 *    и однострочные литералы (regex по строкам), и многострочные шаблонные
 *    литералы (AST: физический перенос внутри литерала — иначе строка с
 *    кириллицей на одной из строк шаблона проходила мимо).
 * 2. **Целостность словаря.** Каждый ключ из `t('…')`/`tp('…')` в исходниках
 *    рендерера есть в каталоге `ru` — опечатка не доедет до пользователя.
 *    Сбор ключей — по AST, а не построчным regex: многострочный вызов
 *    (`tp(\n  'ключ', n)`) — обычная форма и тоже обязан проверяться.
 * 3. **Полнота каталога.** У каждого ключа `ru` непустой русский текст —
 *    «перевод» не может остаться заглушкой.
 * 4. **Ленивое вычисление текста (ошибка ebed42d3).** `t()`/`tp()` не
 *    вызываются на верхнем уровне модуля: такой текст фиксирует язык импорта
 *    и не следует живой смене языка. Текст вычисляется лениво — функцией или
 *    геттером в момент рендера. Проверка — по AST, а не по тексту:
 *    - тело функции, стрелки, метода или геттера лениво по определению, а
 *      тело немедленно вызываемой функции (IIFE) — нет;
 *    - колбэк известного синхронного метода массива (`map`, `forEach`,
 *      `filter`, `reduce`, …) исполняется при самом вызове: вызов внутри
 *      колбэка на верхнем уровне модуля тоже модульный;
 *    - модульный вызов производной обёртки того же файла (`const X =
 *      helper()`, где `helper` исполняет `t()`/`tp()`), включая цепочку
 *      таких функций, — тоже модульный: обёртка лишь прячет вызов.
 * 5. **Обоснованность маркеров.** Маркеры `// i18n: technical` и
 *    `// i18n: module-level` — осознанные исключения, а не способ заглушить
 *    проверку: в той же или следующей строке обязано быть текстовое
 *    обоснование. Пустой маркер — нарушение.
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
 * Вне статического анализа (осознанно): `t()` в теле метода класса, в
 * колбэке, переданном по имени (`arr.map(helper)`), и в функции другого
 * модуля — такие случаи не отличить от ленивых без межмодульного анализа;
 * типовые модульные формы (прямой вызов, синхронный колбэк, обёртка своего
 * файла) покрыты.
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

/** Кириллица в тексте литерала (AST-проверка многострочных шаблонов). */
const CYRILLIC = /[А-Яа-яЁё]/;

/** Маркер технической строки: осознанное исключение с обоснованием на месте. */
const TECHNICAL_MARKER = 'i18n: technical';

/** Маркер осознанного модульного вызова: обоснование обязательно на месте. */
const MODULE_LEVEL_MARKER = 'i18n: module-level';

/**
 * Область сканирования — весь renderer, кроме словаря и тестовой локали:
 * их содержимое — сами тексты, а не разметка.
 */
const SCANNED_FILES = (rel: string): boolean => !rel.startsWith('lib/locales/');

/**
 * Методы массива, которые вызывают колбэк синхронно, во время самого вызова.
 * Колбэк такого вызова на верхнем уровне модуля исполняется при импорте.
 */
const SYNC_CALLBACK_METHODS = new Set([
  'map',
  'flatMap',
  'forEach',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'reduce',
  'reduceRight',
  'sort',
  'toSorted',
]);

/** Комментарий (строчный, блочный или строка JSDoc) — не разметка. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Статический ключ вызова словаря в исходнике. */
interface UsedKey {
  /** Функция словаря, которой вызван ключ. */
  fn: 't' | 'tp';
  /** Ключ — строковый литерал первого аргумента. */
  key: string;
}

/** Разбор исходника для AST-проверок. */
function parseSource(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * Статические ключи `t()`/`tp()` одного исходника. Сбор — по AST: вызов
 * может быть многострочным (`tp(\n  'plurals.orphanedChildren', n)`), и
 * построчная регулярка такой ключ теряла. Комментарии и примеры в них
 * вызовами не считаются; динамический ключ (не литерал) здесь не проверяется —
 * его держит тип `MessageKey`. Локальная функция с именем `t`/`tp`,
 * вызываемая со строкой, от словарной не отличается; таких вызовов в
 * renderer нет (проверено при вводе AST-сбора).
 */
function sourceUsedKeys(fileName: string, source: string): UsedKey[] {
  const sf = parseSource(fileName, source);
  const bindings = i18nBindings(sf);
  if (bindings.direct.size === 0 && bindings.namespaces.size === 0) return [];
  const keys: UsedKey[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const fn = i18nCallName(node.expression, bindings);
      const arg = node.arguments[0];
      if (
        fn !== null &&
        arg !== undefined &&
        (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
      ) {
        keys.push({ fn, key: arg.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys;
}

/** Все статические ключи renderer (по AST) — собираются один раз на прогон. */
let usedKeysCache: (UsedKey & { file: string })[] | null = null;

/** Ключи `t()`/`tp()` во всём renderer, кроме самого словаря. */
function usedKeys(): (UsedKey & { file: string })[] {
  if (usedKeysCache !== null) return usedKeysCache;
  const occurrences: (UsedKey & { file: string })[] = [];
  for (const abs of listSourceFiles(RENDERER_ROOT)) {
    const rel = path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/');
    if (!SCANNED_FILES(rel)) continue; // сам словарь
    for (const used of sourceUsedKeys(rel, fs.readFileSync(abs, 'utf8'))) {
      occurrences.push({ ...used, file: rel });
    }
  }
  usedKeysCache = occurrences;
  return occurrences;
}

/** Ключи, встречающиеся в коде как `t('ключ'…)`/`tp('ключ'…)` (комментарии не считаются). */
function collectUsedKeys(fn: 't' | 'tp'): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const occurrence of usedKeys()) {
    if (occurrence.fn !== fn) continue;
    const list = used.get(occurrence.key) ?? [];
    list.push(occurrence.file);
    used.set(occurrence.key, list);
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

/** Имена `t`/`tp` из импорта `i18n` в файле. */
interface I18nBindings {
  /** Именованные импорты: локальное имя → `t` или `tp` (алиасы учтены). */
  direct: Map<string, 't' | 'tp'>;
  /** Namespace-импорты (`import * as i18n`) — вызовы `i18n.t(...)`. */
  namespaces: Set<string>;
}

/**
 * Имена `t`/`tp` из импорта `i18n` в файле — включая алиасы
 * (`import { t as tr }`) и namespace (`import * as i18n`): вызов ищется по
 * имени, а не по тексту модуля.
 */
function i18nBindings(sf: ts.SourceFile): I18nBindings {
  const bindings: I18nBindings = { direct: new Map(), namespaces: new Set() };
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    // `./i18n.js`, `../lib/i18n.js`, `i18n` — путь заканчивается именем модуля.
    const spec = statement.moduleSpecifier;
    if (!ts.isStringLiteral(spec) || !/(^|\/)i18n(\.js|\.ts)?$/.test(spec.text)) continue;
    const named = statement.importClause?.namedBindings;
    if (named === undefined) continue;
    if (ts.isNamespaceImport(named)) {
      bindings.namespaces.add(named.name.text);
      continue;
    }
    if (!ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === 't' || imported === 'tp') bindings.direct.set(element.name.text, imported);
    }
  }
  return bindings;
}

/**
 * `t`/`tp`, если выражение — вызов функции словаря (алиасы и namespace
 * учтены). `null` — не вызов словаря.
 */
function i18nCallName(expression: ts.Expression, bindings: I18nBindings): 't' | 'tp' | null {
  if (ts.isIdentifier(expression)) return bindings.direct.get(expression.text) ?? null;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    if (!bindings.namespaces.has(expression.expression.text)) return null;
    return expression.name.text === 't' || expression.name.text === 'tp'
      ? expression.name.text
      : null;
  }
  return null;
}

/** Вызов `t()`/`tp()` (включая `i18n.t(...)` для namespace-импорта). */
function isI18nCall(expression: ts.Expression, bindings: I18nBindings): boolean {
  return i18nCallName(expression, bindings) !== null;
}

/** Колбэк вызова исполняется синхронно при самом вызове (методы массива, `Array.from`). */
function callbackRunsDuringCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (SYNC_CALLBACK_METHODS.has(callee.name.text)) return true;
  return (
    callee.name.text === 'from' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Array'
  );
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

/** Что делать при обходе путей, исполняемых при импорте. */
interface EagerWalkVisitor {
  /** Вызов `t()`/`tp()`. */
  onI18nCall(node: ts.CallExpression): void;
  /** Вызов функции по имени — для поиска обёрток того же файла. */
  onFunctionCall?(name: string, node: ts.CallExpression): void;
}

/**
 * Обходит пути, исполняемые при импорте модуля: инициализаторы констант,
 * элементы массивов/объектов, статические поля класса и тело немедленно
 * вызываемой функции. Тела функций, стрелок, методов и геттеров ленивы;
 * исключение — колбэки известных синхронных методов (`map`, `forEach`, …),
 * которые исполняются во время вызова. Функции-аргументы прочих вызовов
 * (`onLangChange(() => …)`, `setTimeout(() => …)`) ленивы.
 */
function walkEager(root: ts.Node, bindings: I18nBindings, visitor: EagerWalkVisitor): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (isI18nCall(node.expression, bindings)) {
        visitor.onI18nCall(node);
      } else if (visitor.onFunctionCall !== undefined && ts.isIdentifier(node.expression)) {
        visitor.onFunctionCall(node.expression.text, node);
      }
      // Немедленно вызываемая функция (IIFE) выполняется при импорте.
      const callee = ts.isParenthesizedExpression(node.expression)
        ? node.expression.expression
        : node.expression;
      if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) visit(callee.body);
      // Аргументы вычисляются сразу; тела переданных функций — при вызове.
      const syncCallback = callbackRunsDuringCall(node);
      for (const arg of node.arguments) {
        if (ts.isFunctionExpression(arg) || ts.isArrowFunction(arg)) {
          if (syncCallback) visit(arg.body);
          continue;
        }
        visit(arg);
      }
      return;
    }
    if (isLazyBody(node)) return;
    // Статические поля и статические блоки класса выполняются при объявлении.
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const member of node.members) {
        if (ts.isClassStaticBlockDeclaration(member)) visit(member.body);
        else if (ts.isPropertyDeclaration(member)) {
          const isStatic =
            member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
          if (isStatic && member.initializer !== undefined) visit(member.initializer);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

/** Номер строки узла (с 1). */
function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * Маркер `// i18n: module-level` на строке вызова или в первой строке
 * объемлющего объявления — осознанное исключение из правила 4.
 */
function hasModuleLevelMarker(node: ts.Node, sf: ts.SourceFile, lines: string[]): boolean {
  let top: ts.Node = node;
  while (top.parent !== undefined && !ts.isSourceFile(top.parent)) top = top.parent;
  return (
    (lines[lineOf(sf, node) - 1] ?? '').includes(MODULE_LEVEL_MARKER) ||
    (lines[lineOf(sf, top) - 1] ?? '').includes(MODULE_LEVEL_MARKER)
  );
}

/**
 * Вызовы `t()`/`tp()`, которые выполняются при импорте модуля (ошибка
 * ebed42d3): инициализаторы констант, элементы массивов/объектов,
 * статические поля класса, тело немедленно вызываемой функции и колбэки
 * синхронных методов массива. Разбор — AST: регэксп не отличает
 * `const X = t('…')` от `const X = () => t('…')`, путает `map` с ленивым
 * колбэком и ломается на многострочных литералах.
 */
function moduleLevelI18nCalls(fileName: string, source: string): ModuleLevelCall[] {
  const sf = parseSource(fileName, source);
  const bindings = i18nBindings(sf);
  if (bindings.direct.size === 0 && bindings.namespaces.size === 0) return [];
  const lines = source.split('\n');
  const calls: ModuleLevelCall[] = [];
  walkEager(sf, bindings, {
    onI18nCall: (node) => {
      if (hasModuleLevelMarker(node, sf, lines)) return;
      calls.push({ line: lineOf(sf, node), text: node.getText(sf).split('\n')[0]! });
    },
  });
  return calls;
}

/** Функция того же файла: тело и пути исполнения при её вызове. */
interface SameFileFunction {
  /** Тело функции (Block или выражение стрелки). */
  body: ts.Node;
  /** При вызове исполняет `t()`/`tp()` на исполняемом пути. */
  direct: boolean;
  /** Имена функций, вызываемых на исполняемом пути. */
  calls: Set<string>;
}

/** Функции, объявленные в самом файле (`function f`, `const f = () => …`). */
function sameFileFunctions(sf: ts.SourceFile, bindings: I18nBindings): Map<string, SameFileFunction> {
  const functions = new Map<string, SameFileFunction>();
  const analyze = (body: ts.Node): SameFileFunction => {
    const info: SameFileFunction = { body, direct: false, calls: new Set() };
    walkEager(body, bindings, {
      onI18nCall: () => {
        info.direct = true;
      },
      onFunctionCall: (name) => info.calls.add(name),
    });
    return info;
  };

  for (const statement of sf.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      statement.body !== undefined
    ) {
      functions.set(statement.name.text, analyze(statement.body));
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      const init = declaration.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        functions.set(declaration.name.text, analyze(init.body));
      }
    }
  }
  return functions;
}

/**
 * Имена функций файла, исполняющих `t()`/`tp()` при вызове, — включая
 * цепочки обёрток (`helper() → label() → t()`). Обратный обход от прямых
 * производителей текста.
 */
function i18nProducingFunctions(functions: Map<string, SameFileFunction>): Set<string> {
  const producers = new Set<string>();
  const callers = new Map<string, string[]>();
  for (const [name, info] of functions) {
    if (info.direct) producers.add(name);
    for (const callee of info.calls) {
      const list = callers.get(callee) ?? [];
      list.push(name);
      callers.set(callee, list);
    }
  }
  const queue = [...producers];
  while (queue.length > 0) {
    const callee = queue.pop()!;
    for (const caller of callers.get(callee) ?? []) {
      if (producers.has(caller)) continue;
      producers.add(caller);
      queue.push(caller);
    }
  }
  return producers;
}

/**
 * Модульные вызовы производных обёрток того же файла (`const label =
 * helper()`, где `helper` исполняет `t()`): обёртка не делает текст ленивым,
 * он всё равно вычисляется при импорте. Прямые `t()`/`tp()` — отдельная
 * проверка, здесь они не дублируются.
 */
function derivedModuleLevelI18nCalls(fileName: string, source: string): ModuleLevelCall[] {
  const sf = parseSource(fileName, source);
  const bindings = i18nBindings(sf);
  if (bindings.direct.size === 0 && bindings.namespaces.size === 0) return [];
  const producers = i18nProducingFunctions(sameFileFunctions(sf, bindings));
  if (producers.size === 0) return [];
  const lines = source.split('\n');
  const calls: ModuleLevelCall[] = [];
  walkEager(sf, bindings, {
    onI18nCall: () => {
      // Прямой вызов ловит moduleLevelI18nCalls.
    },
    onFunctionCall: (name, node) => {
      if (!producers.has(name) || hasModuleLevelMarker(node, sf, lines)) return;
      calls.push({ line: lineOf(sf, node), text: node.getText(sf).split('\n')[0]! });
    },
  });
  return calls;
}

/** Многострочный литерал с кириллицей — пропуск однострочной regex-проверки. */
interface LiteralViolation {
  /** Номер строки начала литерала (с 1). */
  line: number;
  /** Текст первой строки (обрезан по краям). */
  text: string;
}

/** Путь модуля (`import '…'`) — не пользовательская строка. */
function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent) ||
    (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword)
  );
}

/**
 * Многострочные строковые и шаблонные литералы с кириллицей. Однострочную
 * проверку они обходят: закрывающая кавычка на другой строке, поэтому regex
 * по строке не срабатывает. Маркер `// i18n: technical` на любой строке
 * литерала — осознанное техническое сообщение.
 */
function multilineCyrillicLiterals(fileName: string, source: string): LiteralViolation[] {
  if (!CYRILLIC.test(source)) return [];
  const sf = parseSource(fileName, source);
  const lines = source.split('\n');
  const violations: LiteralViolation[] = [];

  const push = (node: ts.Node): void => {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
    if (start === end) return; // однострочные ловит regex-правило
    for (let i = start; i <= end; i++) {
      if ((lines[i] ?? '').includes(TECHNICAL_MARKER)) return;
    }
    violations.push({ line: start + 1, text: (lines[start] ?? '').trim() });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (CYRILLIC.test(node.text) && !isModuleSpecifier(node)) push(node);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
      if (parts.some((part) => CYRILLIC.test(part))) push(node);
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

/** Маркер исключения без обоснования. */
interface MarkerViolation {
  /** Текст маркера без обоснования. */
  marker: string;
  /** Номер строки (с 1). */
  line: number;
  /** Текст строки (обрезан по краям). */
  text: string;
}

/**
 * В тексте после маркера есть хотя бы слово — обоснование, а не пустая метка.
 * Другой маркер i18n обоснованием не является: иначе два пустых маркера
 * подряд «оправдывали» бы друг друга.
 */
function hasJustification(text: string): boolean {
  const withoutMarkers = text
    .split(TECHNICAL_MARKER)
    .join(' ')
    .split(MODULE_LEVEL_MARKER)
    .join(' ');
  const cleaned = withoutMarkers.replace(/^[\s/*<>\-—–:;,.()]+/u, '');
  return /\p{L}{2}/u.test(cleaned);
}

/**
 * Маркеры `// i18n: technical` и `// i18n: module-level` обязаны нести
 * обоснование в той же строке (после маркера) или в следующей строке
 * комментария. Пустой маркер — способ обойти запрет без причины, а не
 * осознанное исключение.
 */
function markerJustificationViolations(rel: string, source: string): MarkerViolation[] {
  if (!SCANNED_FILES(rel)) return [];
  const lines = source.split('\n');
  const violations: MarkerViolation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const marker of [TECHNICAL_MARKER, MODULE_LEVEL_MARKER]) {
      const index = line.indexOf(marker);
      if (index === -1) continue;
      if (hasJustification(line.slice(index + marker.length))) continue;
      const next = lines[i + 1];
      if (next !== undefined && isCommentLine(next) && hasJustification(next)) continue;
      violations.push({ marker, line: i + 1, text: line.trim() });
    }
  }
  return violations;
}

/** Обход renderer с чтением файла; `visit` получает относительный путь и текст. */
function forEachRendererFile(visit: (rel: string, source: string) => void): void {
  for (const abs of listSourceFiles(RENDERER_ROOT)) {
    const rel = path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/');
    if (!SCANNED_FILES(rel)) continue;
    visit(rel, fs.readFileSync(abs, 'utf8'));
  }
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

  it('в renderer нет многострочных литералов с кириллицей вне словаря', () => {
    const violations: string[] = [];
    forEachRendererFile((rel, source) => {
      for (const item of multilineCyrillicLiterals(rel, source)) {
        violations.push(`  • ${rel}:${item.line} — ${item.text}`);
      }
    });
    assert.deepEqual(
      violations,
      [],
      'Многострочный шаблонный литерал с русским текстом обходит построчную ' +
        'проверку, но в интерфейс попадает так же: текст берётся из словаря ' +
        '`t()`/`tp()`, техническое сообщение помечается `// i18n: technical` ' +
        'с обоснованием.\n' +
        violations.join('\n'),
    );
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

  it('сбор ключей видит многострочные вызовы t()/tp()', () => {
    const probe = [
      "import { t, tp } from './lib/i18n.js';",
      "const A = t('actions.save');",
      'const B = tp(',
      "  'plurals.orphanedChildren',",
      '  2,',
      ');',
      'const C = t(',
      '  `actions.cancel`,',
      ');',
      "// пример в комментарии: t('probe.notACall')",
      "const D = localT('probe.notI18n');",
    ].join('\n');
    assert.deepEqual(
      sourceUsedKeys('probe.ts', probe),
      [
        { fn: 't', key: 'actions.save' },
        { fn: 'tp', key: 'plurals.orphanedChildren' },
        { fn: 't', key: 'actions.cancel' },
      ],
      'ключ на следующей строке после t(/tp( — такой же вызов словаря; ' +
        'пример в комментарии и чужой localT — нет',
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
      "const EACH = [1, 2].forEach((n) => tp('plurals.link', n));",
      "const IIFE = (() => t('actions.save'))();",
      "const MARKED = t('actions.save'); // i18n: module-level — ключ, а не текст",
      "const ASYNC = onLangChange(() => t('actions.save'));",
      "const CUSTOM = builder.lazy(() => t('actions.save'));",
    ].join('\n');
    const found = moduleLevelI18nCalls('probe.ts', probe).map((call) => call.line);
    assert.deepEqual(
      found,
      [2, 3, 6, 7, 8],
      'модульными считаются прямые вызовы (2, 3), синхронные колбэки map/forEach ' +
        '(6, 7) и IIFE (8); стрелки/геттеры/асинхронные и незнакомые колбэки и ' +
        'строка с маркером — ленивы',
    );
  });

  it('детектор производных модульных обёрток видит цепочку своего файла', () => {
    const probe = [
      "import { t } from './lib/i18n.js';",
      "function label() { return t('actions.save'); }",
      "const DIRECT = label();",
      "const LAZY = () => label();",
      "function indirect() { return label(); }",
      "const TRANSITIVE = indirect();",
      "function factory() { return () => t('actions.save'); }",
      "const FACTORY = factory();",
      "const MARKED = label(); // i18n: module-level — ключ, а не текст",
    ].join('\n');
    const found = derivedModuleLevelI18nCalls('probe.ts', probe).map((call) => call.line);
    assert.deepEqual(
      found,
      [3, 6],
      'модульными считаются вызовы обёртки своего файла (3) и её цепочки (6); ' +
        'ленивая стрелка, фабрика, возвращающая функцию, и строка с маркером — нет',
    );
  });

  it('маркеры i18n обязаны нести обоснование', () => {
    const probe = [
      "const A = 1; // i18n: technical",
      "const B = 2; // i18n: technical — диагностика для разработчика",
      "const C = 3; // i18n: technical",
      '// причина: контракт для разработчика, не пользовательская строка',
      "const D = 4; // i18n: module-level — обосновано",
      "const E = 5; // i18n: module-level",
      '// i18n: technical',
      '// i18n: module-level',
      "const F = 6;",
    ].join('\n');
    const found = markerJustificationViolations('probe.ts', probe).map(
      (item) => `${item.line}:${item.marker}`,
    );
    assert.deepEqual(
      found,
      [
        '1:i18n: technical',
        '6:i18n: module-level',
        '7:i18n: technical',
        '8:i18n: module-level',
      ],
      'маркер без текста причины (на той же или следующей строке комментария) — ' +
        'нарушение; соседний пустой маркер обоснованием не считается',
    );
  });

  it('в renderer нет t()/tp() на верхнем уровне модуля — текст вычисляется лениво', () => {
    const violations: string[] = [];
    forEachRendererFile((rel, source) => {
      for (const call of moduleLevelI18nCalls(rel, source)) {
        violations.push(`  • ${rel}:${call.line} — ${call.text}`);
      }
    });
    assert.deepEqual(
      violations,
      [],
      't()/tp() на верхнем уровне модуля фиксируют язык импорта: живая смена языка ' +
        'их не перерисует (ошибка ebed42d3). Текст вычисляется лениво — функцией ' +
        'или геттером в момент рендера.\n' +
        violations.join('\n'),
    );
  });

  it('в renderer нет модульных вызовов производных обёрток текста', () => {
    const violations: string[] = [];
    forEachRendererFile((rel, source) => {
      for (const call of derivedModuleLevelI18nCalls(rel, source)) {
        violations.push(`  • ${rel}:${call.line} — ${call.text}`);
      }
    });
    assert.deepEqual(
      violations,
      [],
      'Обёртка того же файла не делает текст ленивым: `const label = helper()`, где ' +
        '`helper` исполняет `t()`/`tp()`, фиксирует язык импорта (ошибка ebed42d3). ' +
        'Текст вычисляется функцией или геттером в момент рендера.\n' +
        violations.join('\n'),
    );
  });

  it('маркеры исключений i18n имеют обоснование', () => {
    const violations: string[] = [];
    forEachRendererFile((rel, source) => {
      for (const item of markerJustificationViolations(rel, source)) {
        violations.push(`  • ${rel}:${item.line} — ${item.marker}: ${item.text}`);
      }
    });
    assert.deepEqual(
      violations,
      [],
      'Маркер `// i18n: technical` или `// i18n: module-level` без текста причины — ' +
        'не исключение, а заглушка: обоснование пишется в той же или следующей ' +
        'строке комментария.\n' +
        violations.join('\n'),
    );
  });
});
