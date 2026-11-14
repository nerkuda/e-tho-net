/**
 * Сторож ряда индикаторов облачка (0.16.1, задача 173f1540, вердикт приёмки).
 *
 * Ряд `.cloud-ind` адресуется СМЫСЛОВЫМИ классами (`ind-reminder`,
 * `ind-comment`, `ind-chrono`, `ind-att`), а не позицией ребёнка: вставка ⏰
 * первой сдвигала бы позиционный патч счётчиков комментариев/хроники/вложений
 * (`lib/cloud-indicators.ts` → `canvas.ts`/`structures.ts`). Смысл проверяется
 * обычным прогоном `npm test`, а не ревью.
 *
 * Правила:
 *   1. в файлах, работающих с рядом, нет позиционного доступа к детям
 *      (`children[…]`, `:nth-child` по `.cloud-ind`);
 *   2. каждый селектор по `.cloud-ind` называет класс `ind-*` (или собирает его
 *      из константы модуля индикатора напоминаний);
 *   3. все четыре класса объявлены, ячейка напоминаний — ПЕРВАЯ в обоих рядах
 *      холста (`canvas.ts`), иначе ⏰ молча выпадет или уедет за 📝.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer');

/** Прочитать файл исходников рендерера (путь — от `src/renderer`). */
function read(rel: string): string {
  return fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');
}

/** Файлы, которые строят или красят ряд индикаторов облачка. */
const INDICATOR_FILES = [
  'lib/cloud-indicators.ts',
  'lib/reminder-indicators.ts',
  'canvas/canvas.ts',
  'screens/structures/structures.ts',
];

/** Объявлен ли смысловой класс ячейки напоминаний в модуле индикатора. */
function reminderClassDeclared(source: string): boolean {
  return source.includes("REMINDER_INDICATOR_CLASS = 'ind ind-reminder'");
}

describe('ряд индикаторов облачка — смысловые классы ind-*', () => {
  it('нет позиционной адресации ячеек и селекторов без ind-*', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'cloud-ind-positional-child',
        description:
          'Ряд `.cloud-ind` адресуется смысловыми классами `ind-*`, а не позицией ребёнка: ' +
          'позиционный доступ ломается при вставке индикатора напоминаний.',
        pattern: /\.cloud-ind[^\n]{0,80}(?:children\s*\[|:nth-child)/,
        include: (rel) => INDICATOR_FILES.includes(rel),
      },
      {
        name: 'cloud-ind-selector-semantic',
        description:
          'Селектор ячейки в ряду `.cloud-ind` обязан называть смысловой класс `ind-*` ' +
          '(ind-reminder/ind-comment/ind-chrono/ind-att), а не позицию.',
        filePattern: /\.cloud-ind\s+\.(?!ind-)/,
        include: (rel) => INDICATOR_FILES.includes(rel),
        // Шаблон собирает класс из константы модуля индикатора напоминаний.
        allow: (_rel, line) => line.includes('REMINDER_INDICATOR_CLASS'),
      },
    ]);
  });

  it('все четыре смысловых класса объявлены там, где строятся ячейки', () => {
    const cloudIndicators = read('lib/cloud-indicators.ts');
    for (const cls of ['ind-comment', 'ind-chrono', 'ind-att']) {
      assert.ok(
        cloudIndicators.includes(`.cloud-ind .${cls}`),
        `покраска счётчиков адресует ячейку по классу ${cls}`,
      );
    }
    assert.ok(
      reminderClassDeclared(read('lib/reminder-indicators.ts')),
      'индикатор напоминаний объявляет класс ячейки `ind-reminder`',
    );
    for (const rel of ['canvas/canvas.ts', 'screens/structures/structures.ts']) {
      const source = read(rel);
      for (const cls of ['ind ind-comment', 'ind ind-chrono', 'ind ind-att']) {
        assert.ok(source.includes(`'${cls}`), `${rel}: ячейка ряда объявлена как «${cls}»`);
      }
    }
  });

  it('ячейка напоминаний стоит первой в обоих рядах холста', () => {
    const canvas = read('canvas/canvas.ts');
    const rows = canvas.split("const ind = div('cloud-ind');");
    assert.equal(rows.length - 1, 2, 'холст строит два ряда индикаторов (фокус и обычное облачко)');
    rows.slice(1).forEach((row, index) => {
      const reminderAt = row.indexOf('reminderIndicatorCell(');
      const commentAt = row.indexOf("'ind ind-comment");
      assert.ok(reminderAt >= 0, `ряд ${index + 1}: ячейка ⏰ создана`);
      assert.ok(commentAt > reminderAt, `ряд ${index + 1}: ⏰ стоит ПЕРЕД 📝`);
    });
  });
});
