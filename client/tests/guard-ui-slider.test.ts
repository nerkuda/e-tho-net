/**
 * Сторож общего ползунка `lib/ui` (задача ea1b5f14, дополнение пользователя
 * «ползунок ширины текста»).
 *
 * Правило: диапазонный регулятор (`<input type="range">`) собирается ТОЛЬКО
 * общим фасадом `lib/ui/slider.ts`; экраны берут `uiSlider`, а не строят
 * нативный контрол сами. Так вид, ARIA и показ текущего значения остаются в
 * одном месте.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations, type GuardRule } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Область правила: весь рендерер, кроме самого фасада ползунка. */
function outsideFacade(rel: string): boolean {
  return rel !== 'lib/ui/slider.ts';
}

/** Комментарий — упоминание конструкций в пояснении не является использованием. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Нативный диапазонный контрол: `type="range"` / `type = 'range'`. */
const RANGE_INPUT = /type\s*=\s*['"]range['"]/;

const RULES: GuardRule[] = [
  {
    name: 'no-own-range-input',
    description:
      'Диапазонный регулятор строится общим фасадом `lib/ui/slider.ts` ' +
      '(задача ea1b5f14): `<input type="range">` вне фасада запрещён.',
    pattern: RANGE_INPUT,
    include: outsideFacade,
    allow: (_rel, line) => isComment(line),
  },
];

describe('guard: общий ползунок lib/ui (ea1b5f14)', () => {
  it('фасад объявлен и экспортируется из barrel lib/ui', () => {
    const source = fs.readFileSync(
      path.join(RENDERER_ROOT, 'lib', 'ui', 'slider.ts'),
      'utf8',
    );
    assert.match(source, /export function uiSlider\s*\(/, 'фасад uiSlider объявлен');
    const index = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'ui', 'index.ts'), 'utf8');
    assert.match(index, /from '\.\/slider\.js'/, 'slider реэкспортируется из barrel');
  });

  it('рабочая область публикации берёт ползунок из фасада', () => {
    const workspace = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'publications', 'workspace.ts'),
      'utf8',
    );
    assert.match(workspace, /uiSlider\(/, 'ширина текста — фасадным ползунком');
    assert.match(
      workspace,
      /from '\.\.\/\.\.\/lib\/ui\/slider\.js'/,
      'ползунок импортируется из lib/ui',
    );
  });

  it('вне фасада нет собственного `<input type="range">`', () => {
    assertGuardClean(RENDERER_ROOT, RULES);
  });

  it('правило краснеет на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-slider-'));
    try {
      fs.mkdirSync(path.join(dir, 'screens', 'publications'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'screens', 'publications', 'workspace.ts'),
        "const range = el('input');\nrange.type = 'range';\n",
        'utf8',
      );
      const violations = collectViolations(dir, RULES);
      assert.ok(
        violations.some((v) => v.rule === 'no-own-range-input'),
        'собственный range-контрол обязан попадать в нарушение',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
