/**
 * Сторож раскраски фразы-превью отбора (задача 58f77990, решение заказчика
 * 2026-10-14, п.12в; элемент интерфейса ca905fbc; требование 5ef1bce1 «тона
 * вложенности — цикл палитры», требование 0dddd939 «только токены»).
 *
 * Правило: каждое правило раскраски фразы — `.ff-ph-op--<and|or|not>` (оператор
 * коннекции) и `.ff-ph-paren--t<1..4>` (скобка уровня вложенности) — обязано
 * задавать `color: var(--<токен>)`. Цвет в этих ролях — только токен темы: без
 * сторожа правило держалось на честном слове (мутация «убрать `color` у
 * `.ff-ph-op--and`» оставляла весь набор клиентских тестов зелёным, а цвета
 * операторов/скобок — это ровно то, что проверяет заказчик).
 *
 * Что ловит:
 *   1. правило раскраски вообще без `color` (оператор/скобка перестал красить);
 *   2. `color` не токеном (`#…`, `rgb(…)`, имя цвета) — в паре с hex-сторожем
 *      (`client/tests/filter-footer.test.ts`, «нет hex-хардкода») закрывает и
 *      подмену токена на литерал;
 *   3. пропажу самих правил (ожидаемый набор ролей сверяется по числу).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const FILTER_EDITOR_CSS = path.join(RENDERER, 'styles', 'filter-editor.css');

/** Селектор роли раскраски: класс оператора или класс тона скобки. */
const PAINT_CLASS = /\.ff-ph-(?:op|paren)--[a-z0-9]+/;

/** Ожидаемое число ролей раскраски: 3 оператора + 4 тона скобок. */
const PAINT_RULE_COUNT = 7;

/** Токен темы в значении `color` — единственная допустимая форма. */
const TOKEN_COLOR = /\bcolor:\s*var\(--[a-z0-9-]+\)/;

/**
 * Нарушения раскраски в CSS-модуле: правила ролей без `color` токеном. Чистая
 * функция над текстом — красные фикстуры проверяют её саму, без правки файлов.
 */
export function paintViolations(css: string): string[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim().replace(/\s+/g, ' ');
    const body = match[2]!;
    if (!PAINT_CLASS.test(selector)) continue;
    if (TOKEN_COLOR.test(body)) continue;
    out.push(`${selector} — нет «color: var(--…)»`);
  }
  return out;
}

/** Число правил-ролей раскраски в модуле. */
export function paintRuleCount(css: string): number {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) =>
    PAINT_CLASS.test(match[1]!),
  ).length;
}

describe('guard: раскраска фразы-превью — только токены темы (58f77990)', () => {
  it('каждое правило оператора и скобки задаёт color токеном', () => {
    const css = fs.readFileSync(FILTER_EDITOR_CSS, 'utf8');
    assert.deepEqual(paintViolations(css), [], 'цвет роли раскраски — только var(--токен)');
    assert.equal(
      paintRuleCount(css),
      PAINT_RULE_COUNT,
      'набор ролей раскраски на месте: 3 оператора + 4 тона скобок',
    );
  });

  it('правила краснеют на умышленном нарушении', () => {
    // Снятый `color` — оператор/скобка перестали красить.
    assert.deepEqual(paintViolations('.ff-ph-op--and {\n  font-weight: 600;\n}'), [
      '.ff-ph-op--and — нет «color: var(--…)»',
    ]);
    // Литерал вместо токена (дополнительно ловится hex-сторожем футера).
    assert.equal(paintViolations('.ff-ph-paren--t2 {\n  color: #0f8f86;\n}').length, 1);
    assert.equal(paintViolations('.ff-ph-op--or {\n  color: rgb(15, 143, 134);\n}').length, 1);
    // Верная форма — чисто; имена класса вне ролей раскраски не считаются.
    assert.deepEqual(paintViolations('.ff-ph-op--not {\n  color: var(--danger);\n}'), []);
    assert.deepEqual(paintViolations('.ff-preview__tip {\n  color: var(--text);\n}'), []);
  });
});
