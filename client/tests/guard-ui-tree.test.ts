/**
 * Сторож единого дерева списков `lib/ui` (задача d1c15a2d, требование 0086037c
 * «Единое дерево списков lib/ui», компонент 24a05c95, техпроект 78398ec5,
 * ADR 03eb2c61).
 *
 * Правила:
 * 1. **Деревья типов строятся только через `lib/ui/tree.ts`.** Самодельные
 *    классы строк дерева (`type-tree-toggle`, `type-tree-name`,
 *    `type-combo-toggle`) вне `lib/ui` запрещены. Allow-край —
 *    `lib/suggest-dropdown.ts`: это выпадашка-подсказчик (её toggle-строки —
 *    не компонент дерева, решение оркестратора задачи d1c15a2d).
 * 2. **Плоские строки дерева не собираются вручную.** `flattenTypeTree` —
 *    внутренность данных `lib/type-tree.ts`; рендер строк дерева идёт через
 *    компонент (иначе каретка/отступы снова разъедутся, ошибка 6925ffa0).
 * 3. **Размеры строки согласованы токеном `--hit-area`.** Высота строки,
 *    флажок и значок типа равны `--hit-area` (ошибка 6925ffa0 — дисбаланс
 *    размеров чекбокса и иконки в списках типов).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations, type GuardRule } from './guard-helpers.js';
import { assembledStylesFile } from './renderer-css.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Строка — комментарий? (имена классов в пояснениях допустимы). */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Выпадашка-подсказчик: её toggle-строки — не дерево-компонент. */
const SUGGEST_DROPDOWN = 'lib/suggest-dropdown.ts';

function rules(): GuardRule[] {
  const include = (rel: string): boolean => !rel.startsWith('lib/ui/');
  return [
    {
      name: 'no-manual-type-tree-classes',
      description:
        'Классы строк дерева типов (type-tree-toggle/type-tree-name/' +
        'type-combo-toggle) вне lib/ui запрещены: деревья типов строит единый ' +
        'компонент lib/ui/tree.ts (требование 0086037c).',
      pattern: /\btype-(?:tree-toggle|tree-name|combo-toggle)\b/,
      include,
      allow: (rel, line) => isComment(line) || rel === SUGGEST_DROPDOWN,
    },
    {
      name: 'no-manual-type-tree-flatten',
      description:
        'flattenTypeTree вне lib/type-tree.ts запрещён: плоские строки дерева ' +
        'не собираются вручную — рендер строк идёт через lib/ui/tree.ts ' +
        '(ошибка 6925ffa0).',
      pattern: /\bflattenTypeTree\s*\(/,
      include,
      allow: (rel, line) => isComment(line) || rel === 'lib/type-tree.ts',
    },
  ];
}

/** Достаёт тело CSS-правила по селектору (без вложенных `}`). */
function cssRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `правило ${selector} найдено`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('guard: единое дерево списков lib/ui (d1c15a2d)', () => {
  it('самодельных деревьев типов вне lib/ui нет', () => {
    assertGuardClean(RENDERER_ROOT, rules());
  });

  it('правило про классы дерева краснеет на умышленной копии', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-tree-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'screen.ts'),
        "const t = span('', 'type-tree-toggle');\nconst f = flattenTypeTree(x, y);\n",
        'utf8',
      );
      const violations = collectViolations(dir, rules(), { extensions: ['.ts'] });
      assert.ok(
        violations.some((v) => v.rule === 'no-manual-type-tree-classes'),
        'самодельный класс строки дерева обязан попадать в нарушение',
      );
      assert.ok(
        violations.some((v) => v.rule === 'no-manual-type-tree-flatten'),
        'ручной flattenTypeTree обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('размеры строки дерева согласованы токеном --hit-area', () => {
    const tokens = fs.readFileSync(assembledStylesFile(), 'utf8');
    assert.match(tokens, /--hit-area:\s*\d+px/, 'в токенах темы нет --hit-area');

    const css = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'tree.css'), 'utf8');
    const row = cssRule(css, '.ui-tree-row');
    assert.match(row, /min-height:\s*var\(--hit-area\)/, 'высота строки не равна --hit-area');

    const check = cssRule(css, '.ui-tree-row .ui-tree-check');
    assert.match(check, /inline-size:\s*var\(--hit-area\)/, 'ширина флажка не равна --hit-area');
    assert.match(check, /block-size:\s*var\(--hit-area\)/, 'высота флажка не равна --hit-area');

    const icon = cssRule(css, '.ui-tree-content > .mini-icon');
    assert.match(icon, /inline-size:\s*var\(--hit-area\)/, 'значок типа не равен --hit-area по ширине');
    assert.match(icon, /block-size:\s*var\(--hit-area\)/, 'значок типа не равен --hit-area по высоте');
  });

  // Ошибка d866bc65: колонки списков не переносят текст (обрезают многоточием),
  // каретка раскрытия — читаемый контрастный глиф, подпись строки даёт `title`.
  it('колонки дерева по умолчанию без переноса, каретка читаема', () => {
    const css = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'tree.css'), 'utf8');

    const cell = cssRule(css, '.ui-tree-cell');
    assert.match(cell, /white-space:\s*nowrap/, 'ячейка колонки обязана быть без переноса');
    assert.match(cell, /text-overflow:\s*ellipsis/, 'ячейка колонки обязана обрезать текст');

    const label = cssRule(css, '.ui-tree-content > .ui-tree-label');
    assert.match(label, /white-space:\s*nowrap/, 'подпись строки обязана быть без переноса');
    assert.match(label, /text-overflow:\s*ellipsis/, 'подпись строки обязана обрезать текст');

    const caret = cssRule(css, '.ui-tree-caret');
    assert.match(
      caret,
      /font-size:\s*var\(--font-size-/,
      'размер глифа каретки — токен шкалы шрифта (не магия)',
    );
    assert.match(caret, /color:\s*var\(--text\)/, 'цвет каретки — контрастный токен --text');
  });

  // Ошибка aada462a: строки дерева одной ширины (ширина контейнера), иначе
  // колонки «Комментарий»/«Количество» встают с разных позиций. `min-content`
  // у строки раздувает её по ПОЛНОЙ ширине nowrap-текста (имя/комментарий),
  // и строка с длинным текстом уводит свои колонки вправо.
  it('строки дерева одной ширины: без min-width: min-content', () => {
    const css = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'tree.css'), 'utf8');

    const row = cssRule(css, '.ui-tree-row');
    assert.match(row, /min-width:\s*0;/, 'строка дерева обязана иметь min-width: 0');
    assert.doesNotMatch(
      row,
      /min-width:\s*min-content/,
      'min-width: min-content у строки распускает её по полной ширине текста и ' +
        'разъезжаются колонки (ошибка aada462a)',
    );

    const head = cssRule(css, '.ui-tree-head');
    assert.doesNotMatch(
      head,
      /min-width:\s*min-content/,
      'шапка колонок шириной как строки — иначе заголовки встают не над данными',
    );
  });
});
