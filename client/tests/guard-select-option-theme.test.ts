/**
 * Сторож темы нативных выпадающих списков (ошибка d603d253, версия 0.14.1,
 * стандарт «Правило без теста-сторожа не считается введённым»).
 *
 * Правило: текст и фон опций нативного `<select>` задаются токенами темы
 * (`--surface`/`--text`, отключённый пункт — `--text-faint`), а не наследуются
 * от контрола. Иначе в тёмной теме popup на Windows остаётся системно-светлым,
 * а текст опций наследует светлый `color` и становится неразличимым (ошибка
 * d603d253). Требования:
 *   1. правило `select option` (потомковый селектор, не `select > option` —
 *      иначе опоры даты ВНУТРИ `<optgroup>` останутся без правила) задаёт
 *      `background-color: var(--surface)` и `color: var(--text)`;
 *   2. правило `select optgroup` — те же цвета (заголовок группы);
 *   3. правило `select option:disabled` — `color: var(--text-faint)`: без него
 *      глобальный `color` перебивает системный серый отключённого пункта;
 *   4. правила не обёрнуты в `@layer` (слоёные авторские правила проигрывают
 *      любым неслоёным и не гарантируют вид в popup);
 *   5. placeholder-опции (`value=''`) не стилизуются через
 *      `option[value='']` — под такой селектор попадают легитимные «любой»,
 *      «без полки», «Все категории».
 *
 * Сторож читает собранный CSS рендерера (`readRendererCss`, грабли 36889dd6)
 * и входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readRendererCss } from './renderer-css.js';

/** Правило CSS: нормализованный список селекторов, тело и объемлющие at-правила. */
interface CssRule {
  selectors: string[];
  body: string;
  atRules: string[];
}

/** Убирает блочные комментарии, сохраняя структуру скобок. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Пробельная нормализация одного селектора. */
function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Рекурсивный разбор CSS: обычные правила + вложенность at-правил. */
function parseBlock(text: string, atRules: string[], out: CssRule[]): void {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) return;
    const prelude = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    const body = text.slice(open + 1, j - 1);
    if (prelude.startsWith('@')) {
      // @media/@supports/@layer — разбираем вложенные правила; @font-face и
      // подобные объявления без вложенных правил в набор не попадают.
      parseBlock(body, [...atRules, normalizeSelector(prelude)], out);
    } else {
      out.push({
        selectors: prelude.split(',').map(normalizeSelector),
        body,
        atRules,
      });
    }
    i = j;
  }
}

/** Все правила CSS (с объёмлющими at-правилами). */
export function parseCssRules(css: string): CssRule[] {
  const out: CssRule[] = [];
  parseBlock(stripComments(css), [], out);
  return out;
}

/** Объявления правила: имя → значение (последнее выигрывает). */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim().replace(/\s+/g, ' ');
    if (name !== '') out.set(name, value);
  }
  return out;
}

/** Правило вне @layer, в списке селекторов которого есть ровно `selector`. */
function findUnlayeredRule(rules: readonly CssRule[], selector: string): CssRule | undefined {
  return rules.find(
    (rule) =>
      !rule.atRules.some((at) => at.startsWith('@layer')) &&
      rule.selectors.includes(selector),
  );
}

/** Нарушения темы списков: чего не хватает для читаемого popup обеих тем. */
export function selectOptionThemeViolations(rules: readonly CssRule[]): string[] {
  const out: string[] = [];

  const option = findUnlayeredRule(rules, 'select option');
  if (option === undefined) {
    out.push('нет правила `select option` (потомковый селектор) вне @layer');
  } else {
    const decl = declarations(option.body);
    if (decl.get('background-color') !== 'var(--surface)') {
      out.push('`select option` без `background-color: var(--surface)`');
    }
    if (decl.get('color') !== 'var(--text)') {
      out.push('`select option` без `color: var(--text)`');
    }
  }

  const group = findUnlayeredRule(rules, 'select optgroup');
  if (group === undefined) {
    out.push('нет правила `select optgroup` (потомковый селектор) вне @layer');
  } else {
    const decl = declarations(group.body);
    if (decl.get('background-color') !== 'var(--surface)') {
      out.push('`select optgroup` без `background-color: var(--surface)`');
    }
    if (decl.get('color') !== 'var(--text)') {
      out.push('`select optgroup` без `color: var(--text)`');
    }
  }

  const disabled = findUnlayeredRule(rules, 'select option:disabled');
  if (disabled === undefined) {
    out.push('нет правила `select option:disabled` вне @layer');
  } else if (declarations(disabled.body).get('color') !== 'var(--text-faint)') {
    out.push('`select option:disabled` без `color: var(--text-faint)`');
  }

  return out;
}

/** Селекторы, красящие опции по значению (ловушка placeholder-опций). */
export function valueTargetedOptionSelectors(rules: readonly CssRule[]): string[] {
  return rules.flatMap((rule) =>
    rule.selectors.filter((selector) => /option\[value/.test(selector)),
  );
}

describe('guard: тема нативных выпадающих списков (опции/optgroup)', () => {
  it('select option / select optgroup / option:disabled красятся токенами темы', () => {
    const violations = selectOptionThemeViolations(parseCssRules(readRendererCss()));
    assert.deepEqual(
      violations,
      [],
      `popup нативного <select> в тёмной теме не следует теме (ошибка d603d253):\n${violations.join('\n')}`,
    );
  });

  it('сторож краснеет на дофиксовом CSS (правил нет — есть нарушения)', () => {
    const before = parseCssRules('.select-input { background: var(--surface); }');
    assert.ok(
      selectOptionThemeViolations(before).length >= 3,
      'до фикса (без правил option/optgroup) сторож обязан быть красным',
    );
  });

  it('опции не красятся по значению (placeholder-опции «любой»/«без полки»)', () => {
    const violations = valueTargetedOptionSelectors(parseCssRules(readRendererCss()));
    assert.deepEqual(
      violations,
      [],
      `опции окрашены по значению — под правило попадут легитимные «любой»/«без полки»/«Все категории»:\n${violations.join('\n')}`,
    );
  });
});
