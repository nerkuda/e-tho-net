/**
 * Сторож reader-пула для точечных тяжёлых чтений (задача 514dc30f, ошибка
 * 49e05ea0, ADR bec191e6).
 *
 * Норма ADR: тяжёлое чтение исполняется в пуле reader-воркеров, а не в главном
 * потоке. До 0.13.2 выборки `resolve`, `neighbors`, `find_duplicates` и чтения
 * комментариев вызывались из фасадов синхронно: на большой сети они занимали
 * event loop кусками и удлиняли очереди всем клиентам (ошибка 49e05ea0).
 *
 * Запрет, который можно нарушить кодом, действует только вместе со сторожем
 * (AGENTS.md §2 п.5). Сторож краснеет, если в `routes/*` или `mcp/tools/*`
 * снова появился прямой вызов синхронной доменной функции вместо фасада
 * `domain/heavy-read.ts` (`*Async`). Дополнительно — позитивные проверки, что
 * переведённые фасады действительно зовут асинхронный фасад.
 *
 * Мутационная проверка: последний тест подаёт сторожу синтетический фасад с
 * прямым `getNeighbors(` и требует нарушения — правило не «мёртвое».
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  assertGuardClean,
  collectViolations,
  type GuardRule,
  type GuardViolation,
} from './guard-helpers.js';

const SERVER_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Файл — читающий фасад транспорта (REST-маршрут, MCP-инструмент или ресурс). */
const inFacades = (rel: string): boolean =>
  rel.startsWith('routes/') || rel.startsWith('mcp/tools/') || rel === 'mcp/resources.ts';

/** Строка — комментарий: упоминание вызова в пояснении не является вызовом. */
const inComment = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line);

/**
 * Единственное разрешённое синхронное чтение комментариев — в write-пути
 * `etn.comments.edit` (`mcp/tools/comments.ts`, внутри `runWriteTool`):
 * постоянный комментарий читается в той же транзакции, что и правка, иначе
 * reader-пул дал бы отдельное соединение и не увидел бы незакоммиченное
 * изменение. Исключение привязано к контексту (охватывающий `runWriteTool`,
 * зарегистрированный как `etn.comments.edit`) и к точной форме вызова, а не
 * к номеру строки: вставка кода выше не должна краснить сторож, а любой
 * другой `listComments(...)` в файле — должен.
 */
const COMMENTS_EDIT_TOOL = 'etn.comments.edit';
const COMMENTS_EDIT_TX_READ =
  /^\s*listComments\(ndb, 'thought', args\.thought_id\)\.find\(\(c\) => c\.kind === 'permanent'\)/;

/** Имя вызываемого выражения: `foo` или `obj.foo`. */
const calleeName = (node: ts.CallExpression, source: ts.SourceFile): string =>
  node.expression.getText(source);

/** Ближайший охватывающий вызов с именем `name` (по цепочке родителей). */
function enclosingCall(
  node: ts.Node,
  name: string,
  source: ts.SourceFile,
): ts.CallExpression | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current) && calleeName(current, source) === name) return current;
  }
  return undefined;
}

/**
 * `listComments` на строке `lineNo` лежит внутри `runWriteTool(...)`, который
 * передан в `mcp.registerTool('etn.comments.edit', ...)`. Разбор AST, а не
 * окно строк: исключение переживает сдвиг файла и не распространяется на
 * соседние блоки. Неразобранный или неоднозначный вызов нарушением и
 * остаётся — fail-closed.
 */
function inCommentsEditWritePath(content: string, lineNo: number): boolean {
  const source = ts.createSourceFile(
    'comments.ts',
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let target: ts.CallExpression | undefined;
  const findCall = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      calleeName(node, source) === 'listComments' &&
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 === lineNo
    ) {
      target = node;
    }
    ts.forEachChild(node, findCall);
  };
  findCall(source);
  if (target === undefined) return false;
  const writeTool = enclosingCall(target, 'runWriteTool', source);
  if (writeTool === undefined) return false;
  const registration = enclosingCall(writeTool, 'mcp.registerTool', source);
  const toolName = registration?.arguments[0];
  return toolName !== undefined && ts.isStringLiteral(toolName) && toolName.text === COMMENTS_EDIT_TOOL;
}

/**
 * Синхронные доменные чтения, которые обязаны идти через `heavy-read.ts`.
 * `getComment(` намеренно не в списке: точечное чтение по id остаётся
 * синхронным (комментарии-снапшоты внутри транзакций записи и импорта).
 */
export const READ_POOL_RULES: GuardRule[] = [
  {
    name: 'no-sync-resolve-in-facades',
    description:
      'Батч `resolve` идёт через `resolveThoughtRefsAsync`/`resolveThoughtCardsAsync`: ' +
      'короткие id резолвятся отдельными lookup-ами и на большой сети занимают event loop.',
    pattern: /(?:\bresolveThoughts|\bgetThoughtsByIdsResolved)\(/,
    include: inFacades,
    allow: (_rel, line) => inComment(line),
  },
  {
    name: 'no-sync-neighbors-in-facades',
    description:
      'Соседи и их `total` идут через `neighborsWithTotalAsync` (одна задача пула); ' +
      'синхронные `getNeighbors`/`countNeighbors` оставляют тяжёлый SQL в главном потоке.',
    pattern: /(?:\bgetNeighbors|\bcountNeighbors)\(/,
    include: inFacades,
    allow: (_rel, line) => inComment(line),
  },
  {
    name: 'no-sync-traverse-in-facades',
    description:
      'BFS-обход (`traverse`) выполняется в пуле через `traverseAsync`: обход рёбер — ' +
      'такое же тяжёлое чтение, как `subgraph`, и блокирует сервер целиком.',
    pattern: /\btraverse\(/,
    include: inFacades,
    allow: (_rel, line) => inComment(line),
  },
  {
    name: 'no-sync-find-duplicates-in-facades',
    description:
      'Кандидаты дублей идут через `findDuplicatesAsync` (диалог добавления мысли, MCP): ' +
      'поиск по синонимам и частичным совпадениям — тяжёлое чтение.',
    pattern: /\bfindDuplicates\(/,
    include: inFacades,
    allow: (_rel, line) => inComment(line),
  },
  {
    name: 'no-sync-comment-reads-in-facades',
    description:
      'Чтения комментариев идут через фасад пула (`listCommentsAsync`, ' +
      '`getVisibleCommentAsync`, `getPresentedCommentAsync`, ' +
      '`commentsPreviewBatchAsync`). Исключение — `listComments` в write-пути ' +
      '`etn.comments.edit`: чтение обязано видеть ту же транзакцию.',
    pattern:
      /(?:\blistComments|\bgetVisibleComment|\bgetPermanentComment|\bgetCommentsPreview)\(/,
    include: inFacades,
    allow: (rel, line, lineNo, content) =>
      inComment(line) ||
      (rel === 'mcp/tools/comments.ts' &&
        COMMENTS_EDIT_TX_READ.test(line) &&
        inCommentsEditWritePath(content, lineNo)),
  },
];

describe('guard: точечные тяжёлые чтения идут через reader-пул', () => {
  it('в routes/* и mcp/tools/* нет синхронных тяжёлых чтений', () => {
    assertGuardClean(SERVER_SRC_ROOT, READ_POOL_RULES);
  });

  it('переведённые фасады зовут асинхронный фасад пула', () => {
    const source = (rel: string): string =>
      fs.readFileSync(path.join(SERVER_SRC_ROOT, rel), 'utf8');

    const expectations: Array<{ file: string; needles: string[] }> = [
      {
        file: 'routes/thoughts.ts',
        needles: [
          'resolveThoughtRefsAsync(',
          'neighborsWithTotalAsync(',
          'findDuplicatesAsync(',
        ],
      },
      {
        file: 'routes/comments.ts',
        needles: ['listCommentsAsync(', 'getVisibleCommentAsync('],
      },
      {
        file: 'mcp/tools/thoughts-read.ts',
        needles: [
          'resolveThoughtCardsAsync(',
          'resolveThoughtRefsAsync(',
          'neighborsWithTotalAsync(',
          'traverseAsync(',
          'findDuplicatesAsync(',
          'commentsPreviewBatchAsync(',
        ],
      },
      {
        file: 'mcp/tools/comments.ts',
        needles: ['getPresentedCommentAsync(', 'getPermanentPresentedAsync('],
      },
      {
        file: 'mcp/resources.ts',
        needles: ['neighborsWithTotalAsync(', 'listCommentsAsync('],
      },
      {
        file: 'mcp/tools/ops.ts',
        needles: ['resolveThoughtRefsAsync('],
      },
    ];

    for (const { file, needles } of expectations) {
      const text = source(file);
      for (const needle of needles) {
        assert.ok(
          text.includes(needle),
          `${file} обязан вызывать фасад «${needle}»: иначе чтение исполняется ` +
            'в главном потоке в обход reader-пула.',
        );
      }
    }
  });

  it('мутационно краснеет: синтетический синхронный вызов ловится', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-read-'));
    try {
      fs.mkdirSync(path.join(fixtureRoot, 'routes'), { recursive: true });
      fs.writeFileSync(
        path.join(fixtureRoot, 'routes', 'bad.ts'),
        "const neighbors = getNeighbors(ndb, id, 'parents');\n",
        'utf8',
      );
      const violations = collectViolations(fixtureRoot, READ_POOL_RULES);
      assert.ok(
        violations.some((v) => v.rule === 'no-sync-neighbors-in-facades'),
        'сторож обязан поймать прямой getNeighbors( в фасаде',
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('listComments в транзакции etn.comments.edit — зелёный на старом месте', () => {
    assert.deepEqual(scanCommentsTool(commentsEditFixture()), []);
  });

  it('разрешённый listComments переживает сдвиг файла вставкой строк выше', () => {
    for (const fillerLines of [40, 177, 500]) {
      assert.deepEqual(
        scanCommentsTool(commentsEditFixture({ fillerLines })),
        [],
        `вставка ${fillerLines} строк выше не должна краснить исключение`,
      );
    }
  });

  it('listComments в другом месте файла — красный', () => {
    const other = "listComments(ndb, 'thought', otherId);";
    const lines = commentsEditFixture({ afterBlock: [other] });
    assert.deepEqual(
      scanCommentsTool(lines).map((v) => v.line),
      [lineOf(lines, 'otherId')],
      'вне write-пути etn.comments.edit синхронное чтение запрещено',
    );
  });

  it('другая форма listComments внутри того же блока — красный', () => {
    const other = "      listComments(ndb, 'thought', args.comment_id);";
    const lines = commentsEditFixture({ insideBlock: [other] });
    assert.deepEqual(
      scanCommentsTool(lines).map((v) => v.line),
      [lineOf(lines, 'args.comment_id')],
      'исключение привязано к точной форме вызова',
    );
  });

  it('мутационно краснеет: listComments без охватывающего runWriteTool', () => {
    const lines = commentsEditFixture({ wrapInWriteTool: false });
    assert.deepEqual(
      scanCommentsTool(lines).map((v) => v.line),
      [lineOf(lines, 'listComments(ndb')],
      'без runWriteTool контекст не подтверждён — вызов запрещён',
    );
  });

  it('мутационно краснеет: runWriteTool чужого инструмента не даёт исключения', () => {
    const lines = commentsEditFixture({ toolName: 'etn.comments.update' });
    assert.deepEqual(
      scanCommentsTool(lines).map((v) => v.line),
      [lineOf(lines, 'listComments(ndb')],
      'исключение действует только внутри etn.comments.edit',
    );
  });
});

/**
 * Фикстура `mcp/tools/comments.ts`: вызов `listComments` в транзакции
 * `etn.comments.edit`. Параметры позволяют сдвинуть файл, подложить вызов
 * в другой форме или сломать контекст.
 */
interface CommentsEditFixtureOptions {
  fillerLines?: number;
  insideBlock?: string[];
  afterBlock?: string[];
  toolName?: string;
  wrapInWriteTool?: boolean;
}

const LEGAL_CALL =
  "listComments(ndb, 'thought', args.thought_id).find((c) => c.kind === 'permanent') ??";

function commentsEditFixture(options: CommentsEditFixtureOptions = {}): string[] {
  const {
    fillerLines = 0,
    insideBlock = [],
    afterBlock = [],
    toolName = COMMENTS_EDIT_TOOL,
    wrapInWriteTool = true,
  } = options;
  const callback = wrapInWriteTool
    ? [
        '  (args, extra) =>',
        '    runWriteTool(rt, args.network_id, () => {',
        ...insideBlock,
        '      const permanent =',
        `        ${LEGAL_CALL}`,
        '          null;',
        '      return permanent;',
        '    }),',
      ]
    : [
        '  (args, extra) => {',
        ...insideBlock,
        '    const permanent =',
        `      ${LEGAL_CALL}`,
        '        null;',
        '    return permanent;',
        '  },',
      ];
  return [
    "import { listComments } from '../../../domain/comment-service.js';",
    ...Array.from({ length: fillerLines }, () => '// filler'),
    'mcp.registerTool(',
    `  '${toolName}',`,
    '  {},',
    ...callback,
    ');',
    ...afterBlock,
  ];
}

/** Номер строки (с 1), содержащей `needle`. */
function lineOf(lines: string[], needle: string): number {
  const index = lines.findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, `фикстура обязана содержать «${needle}»`);
  return index + 1;
}

/** Прогоняет правило комментариев по временной фикстуре. */
function scanCommentsTool(lines: string[]): GuardViolation[] {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-read-comments-'));
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'mcp', 'tools'), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureRoot, 'mcp', 'tools', 'comments.ts'),
      lines.join('\n'),
      'utf8',
    );
    return collectViolations(fixtureRoot, READ_POOL_RULES).filter(
      (v) => v.rule === 'no-sync-comment-reads-in-facades',
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
