/**
 * Сторож двухрамочной навигации (ADR e6d48e09, задачи bd6609b5 / 432ab7ba).
 *
 * Правило: «пунктир текущего элемента не рисуется, когда он совпадает с
 * открытым в редакторе» живёт ОДНИМ правилом в ядре навигации
 * `lib/ui/nav-core.ts::shouldDrawCurrentFrame` и применяется всеми
 * потребителями (карта `canvas/kbd-nav.ts`, «Структуры»
 * `screens/structures/kbd-nav.ts`, библиотека публикаций
 * `screens/publications/library-nav.ts`, тело документа публикации
 * `screens/publications/workspace.ts`). Ни один экран не имеет права писать
 * эту проверку собственной инлайн-логикой `id !== openedId` — иначе правило
 * разъезжается по экранам и снова расходится с ADR.
 *
 * Проверяются три инварианта:
 *  1) `shouldDrawCurrentFrame` определена ровно один раз — в ядре, и её тело
 *     буквально выражает правило (`currentKey !== null && currentKey !== openedKey`);
 *  2) каждый потребитель импортирует и вызывает функцию ядра;
 *  3) ни у одного потребителя нет инлайн-сравнения идентификатора текущего
 *     элемента с идентификатором открытого в редакторе.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { listSourceFiles } from './guard-helpers.js';

const RENDERER = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(RENDERER, ...parts), 'utf8');
}

/**
 * Инлайн-сравнение текущего элемента с открытым в редакторе. Допустимые
 * сравнения (например, `cursorId !== focusId` — фокус карты, или `=== null`)
 * под шаблон не подпадают: сопоставляются только связки «курсор/текущий» с
 * «открытый/цель редактора/текущая мысль».
 */
const INLINE_COMPARE: RegExp[] = [
  /\b(?:cursorId|cursorKey|currentKey|current\?\.key)\s*(?:===|!==)\s*(?:opened\w*|editorTarget\w*|currentThoughtId\s*\()/,
  /\b(?:opened\w*|editorTarget\w*|currentThoughtId\s*\(\s*\))\s*(?:===|!==)\s*(?:cursorId|cursorKey|currentKey|current\?\.key)/,
];

/** Найти нарушения «инлайн-логики двухрамочности» в исходнике потребителя. */
function findInlineTwoFrameCompare(source: string): string[] {
  return INLINE_COMPARE.filter((rx) => rx.test(source)).map((rx) => rx.source);
}

/** Потребители правила: файл → как он применяет ядро. */
const CONSUMERS: Array<{ file: string; calls: RegExp }> = [
  { file: 'canvas/kbd-nav.ts', calls: /shouldDrawCurrentFrame\(/ },
  { file: 'screens/structures/kbd-nav.ts', calls: /shouldDrawCurrentFrame\(/ },
  { file: 'screens/publications/library-nav.ts', calls: /shouldDrawCurrentFrame\(/ },
  { file: 'screens/publications/workspace.ts', calls: /shouldDrawCurrentFrame\(/ },
];

describe('guard: двухрамочность — единое правило ядра (ADR e6d48e09)', () => {
  const NAV_CORE = read('lib', 'ui', 'nav-core.ts');

  it('shouldDrawCurrentFrame определена ровно один раз — в ядре навигации', () => {
    assert.match(
      NAV_CORE,
      /export function shouldDrawCurrentFrame\(/,
      'ядро экспортирует общее правило двухрамочности',
    );
    assert.match(
      NAV_CORE,
      /return currentKey !== null && currentKey !== openedKey;/,
      'тело правила буквально: пунктир — только когда текущий не совпадает с открытым',
    );
    const definers = listSourceFiles(RENDERER, { extensions: ['.ts'] }).filter((file) =>
      /function shouldDrawCurrentFrame\s*\(/.test(fs.readFileSync(file, 'utf8')),
    );
    assert.deepEqual(
      definers.map((file) => path.relative(RENDERER, file).replace(/\\/g, '/')),
      ['lib/ui/nav-core.ts'],
      'правило двухрамочности определено только в lib/ui/nav-core.ts — экраны его не дублируют',
    );
  });

  it('карта, «Структуры» и библиотека применяют общее правило ядра', () => {
    for (const { file, calls } of CONSUMERS) {
      const source = read(...file.split('/'));
      assert.match(
        source,
        /shouldDrawCurrentFrame/,
        `${file} обязан опираться на общее правило ядра`,
      );
      assert.match(source, calls, `${file} вызывает shouldDrawCurrentFrame(...)`);
    }
  });

  it('ни один потребитель не пишет проверку двухрамочности инлайн', () => {
    const violations: string[] = [];
    for (const { file } of CONSUMERS) {
      const found = findInlineTwoFrameCompare(read(...file.split('/')));
      if (found.length > 0) violations.push(`${file}: ${found.join(' | ')}`);
    }
    assert.deepEqual(
      violations,
      [],
      `Инлайн-сравнение текущего с открытым в редакторе: ${violations.join('; ')}. ` +
        'Правило двухрамочности — только через `shouldDrawCurrentFrame` (ADR e6d48e09).',
    );
  });

  it('сторож краснеет на инлайн-логике вместо общего правила', () => {
    const bad =
      "import { shouldDrawCurrentFrame } from '../lib/ui/nav-core.js';\n" +
      'if (cursorId !== openedId) cursorEl.classList.add("kbd-cursor");\n';
    assert.equal(findInlineTwoFrameCompare(bad).length > 0, true);
    const good =
      "import { shouldDrawCurrentFrame } from '../lib/ui/nav-core.js';\n" +
      'if (shouldDrawCurrentFrame(cursorId, openedId)) cursorEl.classList.add("kbd-cursor");\n' +
      'if (cursorId !== null) cursorEl.classList.remove("kbd-cursor");\n';
    assert.deepEqual(findInlineTwoFrameCompare(good), []);
  });
});
