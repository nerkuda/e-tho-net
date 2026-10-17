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

import {
  assertGuardClean,
  collectViolations,
  type GuardRule,
} from './guard-helpers.js';

const SERVER_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Файл — читающий фасад транспорта (REST-маршрут, MCP-инструмент или ресурс). */
const inFacades = (rel: string): boolean =>
  rel.startsWith('routes/') || rel.startsWith('mcp/tools/') || rel === 'mcp/resources.ts';

/** Строка — комментарий: упоминание вызова в пояснении не является вызовом. */
const inComment = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line);

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
    allow: (rel, line) =>
      inComment(line) || (rel === 'mcp/tools/comments.ts' && /\blistComments\(/.test(line)),
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
});
