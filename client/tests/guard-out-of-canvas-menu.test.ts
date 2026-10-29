/**
 * Сторож единственного фасада меню мысли ВНЕ холста (задача d8941b76,
 * усилен задачей c7d5b9d4).
 *
 * Правило. Цепочка «прочитать сеть → `resolveSiblingParent` → после `await`
 * сверить сеть → открыть меню с явным `siblingParentId`/`siblingParentTitle`»
 * существует ровно в одном месте — фасаде
 * `canvas/context-menu.ts` → `showOutOfCanvasThoughtMenu`. Любой модуль вне
 * фасада зовёт фасад и больше ничего: своя копия резолва/сверки/передачи
 * родителя расходится с фасадом при первом же изменении правил «налево»
 * (так и появились шесть копий к `2baa78fb`), даёт разное поведение в разных
 * местах и теряет сверку сети (класс a3151e33).
 *
 * Прямое открытие меню мысли (`showThoughtContextMenu`/`showThoughtMenuUnder`)
 * вне фасада разрешено ровно одному модулю — холсту (`canvas/canvas.ts`):
 * на холсте `focus.parents[0]` и есть правильный родитель «налево» (зона
 * «Родственники» показывает детей этого родителя). В любом модуле вне холста
 * тот же неявный родитель — чужой (ошибка 2baa78fb): меню там открывает только
 * фасад.
 *
 * Прямая сборка меню (`buildThoughtMenuItems`) вне фасада разрешена ровно
 * одному модулю — экрану публикации (`screens/publications/workspace.ts`):
 * меню блока — подмножество общих команд мысли рядом с командами «В
 * публикации», без подменю «Добавить» (структурой разделов управляют команды
 * публикации, задача 7cfaba7c п.4). Поэтому такой вызов обязан передавать
 * `hideAddCommand: true`: без флага «налево (родственник)» возьмёт
 * `focus.parents[0]` и создаст мысль под родителем фокуса (регресс
 * 2baa78fb) — именно так верификатор обошёл прежнюю версию сторожа.
 *
 * Что краснит сторож:
 *  - вызов `resolveSiblingParent(` вне фасада;
 *  - прямой `showThoughtContextMenu(`/`showThoughtMenuUnder(` вне фасада, кроме
 *    `canvas/canvas.ts` (холстовые пути);
 *  - `buildThoughtMenuItems(` вне фасада, кроме
 *    `screens/publications/workspace.ts`;
 *  - `buildThoughtMenuItems(` в разрешённом модуле без `hideAddCommand: true`
 *    в том же вызове — подменю «Добавить» вернётся с чужим родителем;
 *  - модуль вне фасада, где одновременно есть резолв родителя и открытие меню
 *    (`showThoughtContextMenu(`/`showThoughtMenuUnder(`) — копия цепочки;
 *  - явная передача `siblingParentId` в цель меню вне фасада — конструктор
 *    начинает получать родителя мимо фасада;
 *  - обходной вход панели выделения `showSelectionThoughtContextMenu`: он
 *    открывал меню без резолва родителя и сверки сети, поэтому «налево» из
 *    строки панели создавало мысль под родителем фокуса (блокер верификатора
 *    к 245a1992); такого входа быть не должно нигде;
 *  - вне-холстовый потребитель из списка `OUT_OF_CANVAS_CONSUMERS` (включая
 *    панель выделения — десятое место) не зовёт фасад;
 *  - ориентиры сторожа пропали (фасад больше не объявляет API, холст перестал
 *    открывать меню напрямую, публикации перестали собирать меню) — иначе
 *    запреты становятся вакуумными и зелёный прогон ничего не доказывает.
 *
 * Вызовы ищутся по AST (компилятор TypeScript): упоминание имени в
 * комментарии или строке — не вызов, а `hideAddCommand: true` проверяется
 * структурно, в аргументах ИМЕННО этого вызова — регуляркой флаг не отличить
 * от соседнего вызова (прецедент — `guard-comment-actions-placement`).
 *
 * Сторож статический (читает исходники реестра), входит в обычный прогон
 * `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
/** Единственный владелец цепочки: фасад, резолвер и конструктор меню. */
const FACADE_REL = 'canvas/context-menu.ts';

/** Вызов резолвера родителя «налево» (комментарии без `(` не считаются). */
const RESOLVER_CALL_RE = /\bresolveSiblingParent\s*\(/;
/** Открытие меню мысли напрямую — входы конструктора. */
const MENU_OPEN_RES: readonly RegExp[] = [
  /\bshowThoughtContextMenu\s*\(/,
  /\bshowThoughtMenuUnder\s*\(/,
];
/** Те же входы по имени функции — для поиска вызовов по AST. */
const MENU_OPEN_NAMES: ReadonlySet<string> = new Set([
  'showThoughtContextMenu',
  'showThoughtMenuUnder',
]);
/** Имя единственного конструктора набора команд меню мысли. */
const MENU_BUILDER_NAME = 'buildThoughtMenuItems';
const MENU_BUILDER_NAMES: ReadonlySet<string> = new Set([MENU_BUILDER_NAME]);
/** Явная передача родителя в цель меню. */
const EXPLICIT_PARENT_RE = /\bsiblingParentId\b/;
/** Обходной вход панели выделения: меню без резолва родителя и сверки сети. */
const BYPASS_ENTRY_RE = /\bshowSelectionThoughtContextMenu\b/;
/** Вызов единого вне-холстового фасада. */
const FACADE_CALL_RE = /\bshowOutOfCanvasThoughtMenu\s*\(/;

/** Холст: единственный, кому разрешено прямое открытие меню мысли. */
const CANVAS = 'canvas/canvas.ts';
/** Экран публикации: единственный, кому разрешена прямая сборка меню. */
const PUBLICATION_WORKSPACE = 'screens/publications/workspace.ts';

/**
 * Прямое открытие меню мысли вне фасада: только холст. На холсте неявный
 * родитель «налево» — `focus.parents[0]` — и есть правильный родитель
 * (зона «Родственники»). Вне холста то же умолчание создаёт мысль под
 * родителем фокуса (ошибка 2baa78fb) — туда только фасад.
 */
const DIRECT_MENU_OPENERS: readonly string[] = [CANVAS];

/**
 * Прямая сборка меню мысли вне фасада: только экран публикации. Меню блока —
 * подмножество команд мысли (без «Добавить») рядом с командами «В публикации»
 * (задача 7cfaba7c п.4); обязательный `hideAddCommand: true` проверяется
 * отдельно — без него вернулся бы обход «налево» (регресс 2baa78fb).
 */
const DIRECT_MENU_BUILDERS: readonly string[] = [PUBLICATION_WORKSPACE];

/**
 * Вне-холстовые потребители меню мысли: каждый обязан ходить через фасад.
 * `selection/selection.ts` — десятое место (блокер верификатора к 245a1992:
 * строка панели выделения открывала меню обходным входом без родителя).
 *
 * `screens/publications/workspace.ts` сюда не входит: экран собирает меню
 * блока напрямую (`buildThoughtMenuItems`) как подмножество команд мысли без
 * «Добавить» — это не открытие полного меню и не потребитель фасада.
 */
const OUT_OF_CANVAS_CONSUMERS: readonly string[] = [
  'canvas/canvas.ts',
  'editor/editor.ts',
  'editor/links-tab.ts',
  'editor/mini-graph.ts',
  'editor/publication-card.ts',
  'editor/value-editor.ts',
  'lib/filter-value.ts',
  'screens/chronicle/chronicle.ts',
  'screens/history-bar.ts',
  'screens/pinned-bar.ts',
  'screens/structures/structures.ts',
  'screens/usage-panel.ts',
  'search/search.ts',
  'selection/selection.ts',
];

/** Рекурсивно собирает `.ts`-файлы под каталогом (posix-пути от `renderer/`). */
function collectTsFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(abs, rel));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

const SOURCES = new Map(
  collectTsFiles(RENDERER_ROOT).map((rel) => [
    rel,
    fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8'),
  ]),
);

/** Модули вне фасада (по возрастанию пути — стабильные сообщения). */
const CONSUMERS = [...SOURCES.keys()].filter((rel) => rel !== FACADE_REL).sort();

/** Разбор исходника один раз: файл маленький, а тестов в наборе много. */
const PARSED = new Map<string, ts.SourceFile>(
  [...SOURCES].map(([rel, source]) => [
    rel,
    ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  ]),
);

/** Обход AST в глубину. */
function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}

/** Имя вызванной функции: `f(…)` и `obj.f(…)` → `f`, иначе `null`. */
function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** Один вызов функции меню в модуле. */
interface MenuCall {
  /** Имя функции (как записано в коде). */
  callee: string;
  /** Номер строки (с 1). */
  line: number;
  /** Узел вызова — для структурной проверки аргументов. */
  node: ts.CallExpression;
}

/**
 * Все вызовы функций из `names` в модуле. По AST, поэтому упоминание имени в
 * комментарии или строковом литерале вызовом не считается.
 */
function callsOf(rel: string, names: ReadonlySet<string>): MenuCall[] {
  const sf = PARSED.get(rel);
  if (sf === undefined) return [];
  const out: MenuCall[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = calleeName(n.expression);
    if (callee === null || !names.has(callee)) return;
    out.push({
      callee,
      line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
      node: n,
    });
  });
  return out;
}

/**
 * Передан ли в вызов конструктора `hideAddCommand: true` — свойство объекта в
 * аргументах ИМЕННО этого вызова. Вложенные вызовы в аргументах не смотрятся
 * (их флаги — чужие). Переменная, `false` или отсутствие флага не считаются:
 * только явный `true` доказывает, что подменю «Добавить» в меню нет.
 */
function hasHideAddCommand(call: ts.CallExpression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // Чужие вызовы в аргументах — не аргументы этого конструктора.
    if (ts.isCallExpression(node)) return;
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'hideAddCommand' &&
      node.initializer.kind === ts.SyntaxKind.TrueKeyword
    ) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  for (const arg of call.arguments) visit(arg);
  return found;
}

describe('сторож: меню мысли вне холста — один фасад (задача d8941b76)', () => {
  it('резолвер родителя «налево» вызывается только в фасаде', () => {
    const offenders: string[] = [];
    for (const rel of CONSUMERS) {
      if (RESOLVER_CALL_RE.test(SOURCES.get(rel) ?? '')) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      `resolveSiblingParent вызывается только в ${FACADE_REL}: модули должны звать ` +
        `showOutOfCanvasThoughtMenu (иначе копия резолва расползается): ${offenders.join(', ')}`,
    );
  });

  it('ни один модуль вне фасада не собирает копию цепочки «резолв → меню»', () => {
    const offenders: string[] = [];
    for (const rel of CONSUMERS) {
      const source = SOURCES.get(rel) ?? '';
      const resolvesParent = RESOLVER_CALL_RE.test(source);
      const opensMenu = MENU_OPEN_RES.some((re) => re.test(source));
      if (resolvesParent && opensMenu) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      `цепочка «резолв родителя → открытие меню» живёт только в ${FACADE_REL}: ` +
        `вызывающий отдаёт цель/место/опции, а не повторяет шаги: ${offenders.join(', ')}`,
    );
  });

  it('родителя «налево» в меню вне фасада передаёт только фасад', () => {
    const offenders: string[] = [];
    for (const rel of CONSUMERS) {
      if (EXPLICIT_PARENT_RE.test(SOURCES.get(rel) ?? '')) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      `siblingParentId/siblingParentTitle выставляет только ${FACADE_REL} ` +
        `(иначе имя якоря и сверка сети расходятся с фасадом): ${offenders.join(', ')}`,
    );
  });

  it('обходного входа панели выделения нет ни в одном модуле', () => {
    const offenders: string[] = [];
    for (const rel of [...SOURCES.keys()].sort()) {
      if (BYPASS_ENTRY_RE.test(SOURCES.get(rel) ?? '')) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      'showSelectionThoughtContextMenu открывал меню без резолва родителя и сверки сети ' +
        `(блокер к 245a1992): такой вход запрещён, панель выделения ходит через фасад: ${offenders.join(', ')}`,
    );
  });

  it('меню мысли напрямую открывает только холст', () => {
    const offenders: string[] = [];
    for (const rel of CONSUMERS) {
      if (DIRECT_MENU_OPENERS.includes(rel)) continue;
      for (const call of callsOf(rel, MENU_OPEN_NAMES)) {
        offenders.push(`${rel}:${call.line} — ${call.callee}(…)`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `прямое открытие меню мысли вне фасада разрешено только ${CANVAS} ` +
        '(холстовые пути: неявный родитель «налево» — родитель фокуса): в остальных ' +
        `местах — только ${FACADE_REL} → showOutOfCanvasThoughtMenu: ${offenders.join('; ')}`,
    );
  });

  it('buildThoughtMenuItems вне фасада — только экран публикации и только с hideAddCommand: true', () => {
    const offenders: string[] = [];
    for (const rel of CONSUMERS) {
      const builderCalls = callsOf(rel, MENU_BUILDER_NAMES);
      if (builderCalls.length === 0) continue;
      const allowed = DIRECT_MENU_BUILDERS.includes(rel);
      for (const call of builderCalls) {
        if (!allowed) {
          offenders.push(`${rel}:${call.line} — ${MENU_BUILDER_NAME}(…) вне разрешённых модулей`);
        } else if (!hasHideAddCommand(call.node)) {
          offenders.push(
            `${rel}:${call.line} — ${MENU_BUILDER_NAME}(…) без hideAddCommand: true`,
          );
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `прямая сборка меню мысли разрешена только ${PUBLICATION_WORKSPACE} — это меню блока, ` +
        'подмножество команд мысли без «Добавить» (задача 7cfaba7c п.4); вызов обязан ' +
        'передавать hideAddCommand: true, иначе «налево (родственник)» возьмёт родителя ' +
        `фокуса (регресс 2baa78fb): ${offenders.join('; ')}`,
    );
  });

  it('ориентиры сторожа на месте (новые запреты не вакуумные)', () => {
    const facade = PARSED.get(FACADE_REL);
    assert.ok(facade !== undefined, `есть ${FACADE_REL}`);
    const declared = new Set<string>();
    walk(facade, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name !== undefined) declared.add(n.name.text);
    });
    for (const name of [
      'resolveSiblingParent',
      'showOutOfCanvasThoughtMenu',
      'showThoughtContextMenu',
      'showThoughtMenuUnder',
      MENU_BUILDER_NAME,
    ]) {
      assert.ok(
        declared.has(name),
        `фасад обязан объявлять ${name}: без него запрет проверяет пустоту`,
      );
    }
    assert.ok(
      callsOf(CANVAS, MENU_OPEN_NAMES).length >= 1,
      `${CANVAS} обязан прямо открывать меню мысли — иначе запрет «только холст» ничего не проверяет`,
    );
    assert.ok(
      callsOf(PUBLICATION_WORKSPACE, MENU_BUILDER_NAMES).length >= 1,
      `${PUBLICATION_WORKSPACE} обязан собирать меню напрямую — иначе проверка ` +
        'hideAddCommand ничего не проверяет',
    );
  });

  it('вне-холстовые потребители ходят через единый фасад (панель выделения — 10-й)', () => {
    const missing: string[] = [];
    for (const rel of OUT_OF_CANVAS_CONSUMERS) {
      const source = SOURCES.get(rel);
      assert.ok(source !== undefined, `потребитель ${rel} существует`);
      if (!FACADE_CALL_RE.test(source)) missing.push(rel);
    }
    assert.deepEqual(
      missing,
      [],
      `каждый вне-холстовый потребитель зовёт ${FACADE_REL} → showOutOfCanvasThoughtMenu: ` +
        `родитель и сверка сети живут только там: ${missing.join(', ')}`,
    );
    const selection = SOURCES.get('selection/selection.ts') ?? '';
    assert.ok(
      /hideSelectionCommand\s*:\s*true/.test(selection),
      'панель выделения скрывает команду выделения: запись уже выделена (§5.1)',
    );
  });

  it('фасад действительно держит цепочку целиком', () => {
    const facade = SOURCES.get(FACADE_REL);
    assert.ok(facade !== undefined, `есть ${FACADE_REL}`);
    const start = facade.indexOf('export async function showOutOfCanvasThoughtMenu(');
    assert.ok(start >= 0, 'фасад объявляет showOutOfCanvasThoughtMenu');
    const stop = facade.indexOf('\n}\n', start);
    assert.ok(stop > start, 'тело фасада закрыто');
    const body = facade.slice(start, stop);
    assert.ok(RESOLVER_CALL_RE.test(body), 'фасад резолвит родителя «налево»');
    assert.ok(
      /store\.state\.networkId\s*!==\s*networkId/.test(body),
      'фасад сверяет сеть ПОСЛЕ await (класс a3151e33)',
    );
    assert.ok(/siblingParentId/.test(body), 'фасад передаёт родителя в меню явно');
    assert.ok(/siblingParentTitle/.test(body), 'фасад передаёт имя родителя в меню явно');
    assert.ok(
      /'event' in place/.test(body) && /showThoughtMenuUnder\(place\.anchor/.test(body),
      'фасад открывает меню и по событию, и под якорем',
    );
  });
});
