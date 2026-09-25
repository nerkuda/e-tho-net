/**
 * Сторож тач-зон `lib/ui` (задача e45ca252, требование 5677bc3d «Тач-таргеты
 * не меньше токена --hit-area», стандарт «Правило без теста-сторожа не
 * считается введённым»).
 *
 * Правило: у компактных интерактивных контролов словаря эффективная зона
 * нажатия не меньше токена тач-таргета. Визуальный размер контрола остаётся
 * плотным — зона расширяется невидимым псевдоэлементом (`::after` с
 * `inline-size/block-size: max(100%, var(--hit-area-min))`), который
 * принадлежит самому контролу и потому принимает клик.
 *
 * **Почему отдельный токен `--hit-area-min`, а не рост `--hit-area`.** Значение
 * `--hit-area: 18px` задаёт высоту строки списка, размер флажка и значка дерева
 * — согласованный баланс требования 0086037c (ошибка 6925ffa0). Его рост до
 * 24 раздул бы строки и сместил детали. Тач-зона получает собственный минимум
 * (WCAG 2.5.8), не трогая плотность; `min ≥ --hit-area` — инвариант сторожа.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const STYLES_CSS = path.join(RENDERER_ROOT, 'styles.css');

const read = (rel: string): string => fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Значение токена-длины из `:root` styles.css. */
function rootLength(css: string, name: string): number | null {
  const rootEnd = css.indexOf("[data-theme='dark'] {");
  const root = css.slice(0, rootEnd === -1 ? css.length : rootEnd);
  const m = new RegExp(`${escapeRe(name)}\\s*:\\s*(\\d+)px`).exec(root);
  return m === null ? null : Number(m[1]);
}

/** Компактные контролы: визуальный глиф меньше тач-таргета, зона — псевдоэлемент. */
const COMPACT_CONTROLS: Array<{ file: string; selector: string }> = [
  { file: 'lib/ui/chip-list.css', selector: '.ui-chip-remove' },
  { file: 'lib/ui/tree.css', selector: '.ui-tree-caret' },
  { file: 'lib/ui/field.css', selector: '.ui-clearable-btn' },
  { file: 'styles.css', selector: '.tab-close' },
];

/**
 * Объявлено ли у контрола расширение зоны нажатия: псевдоэлемент
 * (`::after`/`::before`) с размером от токена тач-таргета.
 */
function hasHitAreaExpansion(css: string, selector: string): boolean {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = new RegExp(
    `${escapeRe(selector)}::(?:after|before)\\s*\\{[^{}]*(?:inline-size|block-size|width|height)\\s*:[^{}]*var\\(--hit-area`,
  );
  return re.test(code);
}

describe('guard: тач-зоны lib/ui (e45ca252, требование 5677bc3d)', () => {
  it('токен тач-таргета объявлен и не меньше токена геометрии строки', () => {
    const css = read('styles.css');
    const area = rootLength(css, '--hit-area');
    const min = rootLength(css, '--hit-area-min');
    assert.ok(area !== null, '--hit-area объявлен в :root styles.css');
    assert.ok(min !== null, '--hit-area-min объявлен в :root styles.css');
    assert.ok(
      min! >= area!,
      `тач-таргет --hit-area-min (${min}px) не меньше геометрии строки --hit-area (${area}px)`,
    );
  });

  it('компактные контролы расширяют зону нажатия псевдоэлементом', () => {
    const problems: string[] = [];
    for (const { file, selector } of COMPACT_CONTROLS) {
      if (!hasHitAreaExpansion(read(file), selector)) {
        problems.push(`  • ${file} «${selector}» — нет псевдоэлемента с var(--hit-area)`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `Компактные контролы без расширенной зоны нажатия (${problems.length}):\n` +
          `${problems.join('\n')}\n\n` +
          'Добавь `::after` с `inline-size/block-size: max(100%, var(--hit-area-min))` ' +
          '(требование 5677bc3d) либо обоснуй исключение в COMPACT_CONTROLS/шапке сторожа.',
      );
    }
  });

  it('проверка краснеет на контроле без расширения', () => {
    assert.equal(
      hasHitAreaExpansion('.ui-x { padding: 0; }', '.ui-x'),
      false,
      'контрол без псевдоэлемента не должен считаться расширенным',
    );
    assert.equal(
      hasHitAreaExpansion(
        '.ui-x::after { content: ""; inline-size: max(100%, var(--hit-area-min)); }',
        '.ui-x',
      ),
      true,
      'корректное расширение обязано распознаваться',
    );
  });
});
