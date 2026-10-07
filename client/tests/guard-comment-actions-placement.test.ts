/**
 * Сторож расположения панели кнопок режима поля комментария (0.12.1, задача
 * `f65add20`, ошибка `ec215556`).
 *
 * Правило: кнопки «Отмена»/«Сохранить» живут в ОТДЕЛЬНОЙ панели
 * (`.md-field-actions`, узел `modeActions.root`) — ПРЯМОМ ребёнке корня поля
 * `.md-field`, сиблинге области правки `.md-field-area`. Документ редактора
 * обёрнут в контейнер прокрутки `.md-field-scroll`, который лежит ВНУТРИ
 * области правки. Прокручивается только текст — панель не должна оказаться
 * потомком ни области правки, ни контейнера прокрутки ни на одном уровне.
 *
 * Почему правило нужно. В ограниченном по высоте поле (оболочка комментария
 * `--fill`, вкладка «Комментарий») `.md-field-area` как flex-элемент ужималась
 * до пятистрочного минимума, редактор переполнял её, а панель кнопок вставала
 * посреди текста и уезжала вместе с прокруткой. Живая проверка: редактор 879px
 * внутри области 263px, панель — на уровне середины текста.
 *
 * Почему НЕ регэксп по тексту. Прежний сторож ловил панель регулярками вида
 * `area\.(append|…)\([^)]*modeActions\.root` — `[^)]*` не переживает вложенную
 * скобку (`area.replaceChildren(buildCommentToolbar(commandHost), scroller,
 * modeActions.root)` не матчился) и не видит вложения в ДРУГОЙ узел
 * (`scroller.append(modeActions.root)` оставался зелёным).
 *
 * Почему структурный анализ, а не DOM-проба. Реальная сборка узла прокрутки
 * живёт в `mountEditor` и требует настоящего CodeMirror-редактора
 * (`createMdEditor` → `EditorView`): в headless-шиме `tests/dom-shim.ts` он не
 * поднимается, а вход в правку без мока модуля `md-editor.js` недостижим
 * (мок модуля требует флага `--experimental-test-module-mocks` — repo-wide
 * правки тестового скрипта ради одного сторожа не оправданы). Поэтому сторож
 * разбирает исходник `markdown-field.ts` компилятором TypeScript в AST и
 * моделирует сборку DOM: правило формулируется инвариантом, а не формой записи.
 *
 * Инвариант: узел `modeActions.root` может быть аргументом ТОЛЬКО вызовов,
 * кладущих ребёнка в КОРЕНЬ поля (`root`). Любой иной получатель (`scroller`,
 * `area`, произвольный узел) — нарушение. Разбор идёт по AST, поэтому ловит
 * `scroller.append(modeActions.root)`, `area.replaceChildren(…, scroller,
 * modeActions.root)`, вложение через промежуточную переменную и любой другой
 * способ прикрепления — независимо от форматирования и скобок.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import ts from 'typescript';

import { readRendererCss } from './renderer-css.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKDOWN_FIELD = fs.readFileSync(
  path.join(CLIENT_ROOT, 'src', 'renderer', 'editor', 'markdown-field.ts'),
  'utf8',
);
const CSS = readRendererCss();

/** Методы DOM, которые кладут аргумент РЕБЁНКОМ в узел-получатель. */
const CHILD_ATTACH_METHODS = new Set([
  'append',
  'appendChild',
  'prepend',
  'replaceChildren',
  'insertBefore',
  'insertAdjacentElement',
]);

/** Текст-выражение узла панели кнопок. */
const PANEL_EXPR = 'modeActions.root';

/** Роль узла-получателя в сборке поля. */
type NodeRole = 'root' | 'area' | 'scroll';

/** Разбор исходника один раз на весь файл тестов. */
const SF = ts.createSourceFile('markdown-field.ts', MARKDOWN_FIELD, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** Обойти AST в глубину. */
function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}

/** Объявления `const <name> = <init>` с идентификатором-именем. */
interface Declarator {
  name: string;
  init: ts.Expression;
}

function collectDeclarators(): Declarator[] {
  const out: Declarator[] = [];
  walk(SF, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      out.push({ name: n.name.text, init: n.initializer });
    }
  });
  return out;
}

const DECLARATORS = collectDeclarators();

/** Класс элемента из инициализатора `div('<class>')` или `null`. */
function divClassName(init: ts.Expression): string | null {
  if (!ts.isCallExpression(init)) return null;
  if (!ts.isIdentifier(init.expression) || init.expression.text !== 'div') return null;
  const arg = init.arguments[0];
  if (arg === undefined || !ts.isStringLiteral(arg)) return null;
  return arg.text;
}

/** Имя переменной-корня поля (`.md-field`), области правки и контейнера прокрутки. */
function containerVar(className: string): string | null {
  for (const d of DECLARATORS) if (divClassName(d.init) === className) return d.name;
  return null;
}

const rootVar = containerVar('md-field');
const areaVar = containerVar('md-field-area');
const scrollVar = containerVar('md-field-scroll');

/** Псевдонимы узлов сборки: `const s = area` и т.п. (несколько проходов). */
function buildRoleAliases(): Map<string, NodeRole> {
  const aliases = new Map<string, NodeRole>();
  for (let pass = 0; pass < 4; pass += 1) {
    for (const d of DECLARATORS) {
      const role = roleOf(d.init, aliases);
      if (role !== null) aliases.set(d.name, role);
    }
  }
  return aliases;
}

/** Роль выражения-идентификатора (прямая или через псевдоним). */
function roleOf(expr: ts.Expression, aliases: Map<string, NodeRole>): NodeRole | null {
  if (!ts.isIdentifier(expr)) return null;
  if (expr.text !== '' && expr.text === rootVar) return 'root';
  if (expr.text !== '' && expr.text === areaVar) return 'area';
  if (expr.text !== '' && expr.text === scrollVar) return 'scroll';
  return aliases.get(expr.text) ?? null;
}

const ROLE_ALIASES = buildRoleAliases();

/** Псевдонимы узла панели: `const panel = modeActions.root` (несколько проходов). */
function buildPanelAliases(): Set<string> {
  const aliases = new Set<string>();
  for (let pass = 0; pass < 4; pass += 1) {
    for (const d of DECLARATORS) {
      const isPanel = d.init.getText(SF) === PANEL_EXPR || (ts.isIdentifier(d.init) && aliases.has(d.init.text));
      if (isPanel) aliases.add(d.name);
    }
  }
  return aliases;
}

const PANEL_ALIASES = buildPanelAliases();

/** Является ли выражение узлом панели кнопок (напрямую или через псевдоним). */
function isPanelExpr(expr: ts.Expression): boolean {
  if (expr.getText(SF) === PANEL_EXPR) return true;
  return ts.isIdentifier(expr) && PANEL_ALIASES.has(expr.text);
}

/** Одно прикрепление ребёнка к узлу сборки. */
interface Attach {
  role: NodeRole | null;
  /** Текст получателя (для сообщения об ошибке при неразрешённой роли). */
  receiverText: string;
  method: string;
  args: ts.Expression[];
  hasPanel: boolean;
  line: number;
}

/** Все вызовы методов-прикреплений ребёнка в исходнике поля. */
function collectAttaches(): Attach[] {
  const out: Attach[] = [];
  walk(SF, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = n.expression;
    if (!ts.isPropertyAccessExpression(callee)) return;
    const method = callee.name.text;
    if (!CHILD_ATTACH_METHODS.has(method)) return;
    const args = [...n.arguments];
    const line = SF.getLineAndCharacterOfPosition(n.getStart(SF)).line + 1;
    out.push({
      role: roleOf(callee.expression, ROLE_ALIASES),
      receiverText: callee.expression.getText(SF),
      method,
      args,
      hasPanel: args.some(isPanelExpr),
      line,
    });
  });
  return out;
}

const ATTACHES = collectAttaches();

/** Тело CSS-правила по селектору (от `{` до первой `}`). */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  if (at === -1) return '';
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

describe('guard: панель кнопок поля комментария — вне прокрутки (f65add20, ec215556)', () => {
  it('структура сборки поля распознана (корень, область правки, контейнер прокрутки)', () => {
    assert.notEqual(rootVar, null, 'не найден корень поля div("md-field") — сторож потерял ориентир');
    assert.notEqual(areaVar, null, 'не найдена область правки div("md-field-area")');
    assert.notEqual(scrollVar, null, 'не найден контейнер прокрутки div("md-field-scroll")');
  });

  it('документ редактора обёрнут в контейнер прокрутки (editor.dom внутри .md-field-scroll)', () => {
    const wrapsEditor = ATTACHES.some(
      (a) => a.role === 'scroll' && a.args.some((x) => x.getText(SF).includes('editor.dom')),
    );
    assert.ok(wrapsEditor, 'в .md-field-scroll обязан класться документ редактора (editor.dom)');
  });

  it('узел панели modeActions.root прикрепляется ТОЛЬКО к корню поля (не внутрь .md-field-scroll/.md-field-area)', () => {
    const panelCalls = ATTACHES.filter((a) => a.hasPanel);
    assert.ok(
      panelCalls.length >= 1,
      'панель кнопок modeActions.root не прикреплена к полю — кнопки режима пропали',
    );

    const offenders = panelCalls.filter((a) => a.role !== 'root');
    assert.deepEqual(
      offenders.map((a) => `${a.receiverText}.${a.method}(…) — строка ${a.line}`),
      [],
      'панель кнопок modeActions.root обязана быть прямым ребёнком корня поля (root); ' +
        'прикрепление к другому узлу (область правки, контейнер прокрутки или иной) ' +
        'вернёт баг f65add20 — панель уедет вместе с прокруткой текста',
    );
  });

  it('в просмотре (view-путь) панель присутствует как прямой ребёнок корня поля', () => {
    const viewAppend = ATTACHES.find((a) => a.role === 'root' && a.hasPanel);
    assert.ok(viewAppend !== undefined, 'root.append(…) поля обязан включать modeActions.root');
  });

  it('контейнер прокрутки действительно прокручивается', () => {
    const body = ruleBody('.md-field-scroll');
    assert.ok(body !== '', 'не найдено правило .md-field-scroll');
    assert.match(body, /overflow:\s*auto/, '.md-field-scroll обязан прокручиваться (overflow: auto)');
  });

  it('в ограниченном поле редактор прокручивается внутри области, не переполняя её', () => {
    const area = ruleBody(
      '.ui-comment--fill > .ui-comment__body > .md-field > .md-field-area',
    );
    assert.ok(area !== '', 'нет правила области правки для ограниченного (--fill) поля');
    assert.match(area, /flex:\s*1 1 auto/, 'область правки занимает остаток высоты поля');
    assert.match(area, /min-height:\s*0/, 'область правки должна ужиматься (min-height: 0)');
    const scroll = ruleBody(
      '.ui-comment--fill > .ui-comment__body > .md-field > .md-field-area > .md-field-scroll',
    );
    assert.ok(scroll !== '', 'нет правила контейнера прокрутки для ограниченного поля');
    assert.match(scroll, /flex:\s*1 1 auto/, 'контейнер прокрутки занимает область правки');
    assert.match(scroll, /min-height:\s*0/, 'контейнер прокрутки должен ужиматься');
  });

  it('в правке панель кнопок — в потоке под полем и не ужимается', () => {
    const body = ruleBody('.md-field--editing > .md-field-actions');
    assert.ok(body !== '', 'нет правила кнопок режима в правке');
    assert.match(body, /position:\s*static/, 'в правке панель — в потоке под полем');
    assert.match(body, /flex:\s*0 0 auto/, 'панель кнопок не должна ужиматься флексом');
  });
});
