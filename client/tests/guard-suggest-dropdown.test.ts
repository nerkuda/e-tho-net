/**
 * Сторож стандарта «одна выпадашка подсказок» (ADR «одна
 * выпадашка-подсказчик, источник вариантов — её параметр»; стандарт S1
 * «представление мысли — только через общую фабрику облачка», задача
 * 07e54616 вехи 2 версии 0.8.2).
 *
 * Правила:
 * 1. Своя выпадашка подсказок не пишется вне `lib/suggest-dropdown.ts`:
 *    сборка списка-подсказчика (`div`/`el` с классом `type-combo-list`) —
 *    маркер такой выпадашки. Иерархический пикер типа (`lib/type-combobox.ts`)
 *    поглощён общим пикером (задача ae0d4ffb, веха 3 версии 0.8.2) — файла
 *    больше нет, исключение снято.
 * 2. Индексная арифметика ↑/↓ по строкам не копируется: хелпер `navIndex`
 *    существует только в общей выпадашке (до задачи у него было четыре
 *    копии — suggest-dropdown, thought-picker, recent-values, value-combo).
 * 3. Список кандидатов диалога добавления мысли рисуется общей выпадашкой:
 *    классы прежней самодельной сборки (`dup-item`/`dup-list`/`dup-parent`/
 *    `dup-network`) упразднены (требование d1cd2095, задача f348e095) —
 *    строку собирает `buildSuggestRow` из `lib/suggest-dropdown.ts`.
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

import {
  assertGuardClean,
  collectViolations,
  DEFAULT_GUARD_EXTENSIONS,
  type GuardRule,
} from './guard-helpers.js';

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
      'выпадашка-подсказчик…»).',
    pattern: LIST_BUILD,
    allow: (rel: string) => rel === 'lib/suggest-dropdown.ts',
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

/** Классы прежнего самодельного списка кандидатов диалога добавления. */
const LEGACY_CANDIDATE_CLASSES: GuardRule = {
  name: 'no-legacy-candidate-classes',
  description:
    'Классы прежнего самодельного списка кандидатов (dup-item/dup-list/dup-parent/' +
    'dup-network) упразднены: строку списка найденных диалога добавления собирает ' +
    'общая выпадашка (buildSuggestRow в lib/suggest-dropdown.ts, требование d1cd2095).',
  pattern: /\bdup-(?:item|list|parent|network)\b/,
};

/** Расширения сканирования с CSS: классы-самоделки могут жить в стилях. */
const GUARD_EXTENSIONS_WITH_CSS = [...DEFAULT_GUARD_EXTENSIONS, '.css'];

describe('guard: выпадашка подсказок существует в одном экземпляре', () => {
  it('своя выпадашка и своя навигация ↑/↓ не пишутся вне общей', () => {
    assertGuardClean(RENDERER_ROOT, RULES);
  });

  it('список кандидатов рисует общая выпадашка — прежних классов нет', () => {
    // Классы dup-* (в т.ч. в styles.css) упразднены: строку собирает общая
    // выпадашка (требование d1cd2095, задача f348e095).
    assertGuardClean(RENDERER_ROOT, [LEGACY_CANDIDATE_CLASSES], {
      extensions: GUARD_EXTENSIONS_WITH_CSS,
    });
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

      // Прежний класс списка кандидатов — тоже нарушение (в т.ч. в CSS).
      fs.writeFileSync(
        path.join(dir, 'legacy.css'),
        '.dup-item { padding: 0 }',
        'utf8',
      );
      const legacy = collectViolations(dir, [LEGACY_CANDIDATE_CLASSES], {
        extensions: GUARD_EXTENSIONS_WITH_CSS,
      });
      assert.ok(
        legacy.some((v) => v.rule === 'no-legacy-candidate-classes'),
        'прежний класс dup-item обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
