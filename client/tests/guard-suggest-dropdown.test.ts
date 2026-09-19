/**
 * Сторож стандарта «одна выпадашка подсказок» (ADR «одна
 * выпадашка-подсказчик, источник вариантов — её параметр»; стандарт S1
 * «представление мысли — только через общую фабрику облачка», задача
 * 07e54616 вехи 2 версии 0.8.2).
 *
 * Правила:
 * 1. Своя выпадашка подсказок не пишется вне `lib/suggest-dropdown.ts`:
 *    сборка списка-подсказчика (`div`/`el` с классом `type-combo-list`) —
 *    маркер такой выпадашки. Единственный разрешённый сосед —
 *    `lib/type-combobox.ts`: это не подсказчик значений, а иерархический
 *    пикер ТИПА мысли/связи (дерево с раскрытием и созданием нового), и его
 *    перевод в общую выпадашку — отдельная работа, не эта.
 * 2. Индексная арифметика ↑/↓ по строкам не копируется: хелпер `navIndex`
 *    существует только в общей выпадашке (до задачи у него было четыре
 *    копии — suggest-dropdown, thought-picker, recent-values, value-combo).
 *
 * Сторож вводится зелёным — в том же изменении, которое сводит все копии
 * выпадашки к одной (мета-стандарт «Правило без теста-сторожа не считается
 * введённым»).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Сборка списка-подсказчика: класс `type-combo-list` первым ИЛИ вторым
 *  аргументом `div`/`el` (класс может быть с дополнительными токенами). */
const LIST_BUILD =
  /\b(?:div|el)\(\s*(?:'(?:[^'\\]|\\.)*'\s*,\s*)?'(?:[^']*\s)?type-combo-list(?:\s[^']*)?'/;

/** Определение локальной копии индексной арифметики ↑/↓. */
const LOCAL_NAV = /\bfunction\s+navIndex\b|\bconst\s+navIndex\s*=/;

const RULES = [
  {
    name: 'no-own-suggest-dropdown',
    description:
      'Сборка списка-подсказчика (класс type-combo-list) вне lib/suggest-dropdown.ts ' +
      'запрещена: выпадашка подсказок одна, её источники — параметр (ADR «одна ' +
      'выпадашка-подсказчик…»). Исключение — иерархический пикер типа ' +
      'lib/type-combobox.ts (другой компонент, не подсказчик значений).',
    pattern: LIST_BUILD,
    allow: (rel: string) => rel === 'lib/suggest-dropdown.ts' || rel === 'lib/type-combobox.ts',
  },
  {
    name: 'no-own-suggest-nav',
    description:
      'Копия индексной арифметики ↑/↓ (navIndex) вне lib/suggest-dropdown.ts ' +
      'запрещена: навигация выпадашки существует в одном экземпляре.',
    pattern: LOCAL_NAV,
    allow: (rel: string) => rel === 'lib/suggest-dropdown.ts',
  },
];

describe('guard: выпадашка подсказок существует в одном экземпляре', () => {
  it('своя выпадашка и своя навигация ↑/↓ не пишутся вне общей', () => {
    assertGuardClean(RENDERER_ROOT, RULES);
  });

  it('каждое правило краснеет на умышленно добавленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-suggest-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'fake-dropdown.ts'),
        [
          "import { div } from './lib/dom.js';",
          'function navIndex(cursor: number | null, count: number): number | null {',
          '  return cursor === null ? 0 : Math.min(cursor, count - 1);',
          '}',
          "const list = div('type-combo-list');",
          "const other = div('x', 'type-combo-item');",
          'void list; void other; void navIndex;',
        ].join('\n'),
        'utf8',
      );
      const violations = collectViolations(dir, RULES);
      const names = new Set(violations.map((v) => v.rule));
      assert.ok(
        names.has('no-own-suggest-dropdown'),
        'сборка второго списка-подсказчика обязана попадать в нарушение',
      );
      assert.ok(
        names.has('no-own-suggest-nav'),
        'локальная копия navIndex обязана попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
