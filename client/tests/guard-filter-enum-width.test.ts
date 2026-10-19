/**
 * Сторож ширины ячейки-перечисления в редакторе отбора (ошибка 1f3f0df5
 * «На экране "События" не отображаются значения для отбора "Тип действия"»).
 *
 * Причина дефекта: колонка значения `.ft-row__value` — flex-столбец с
 * `align-items: flex-start`, а чип-лист `lib/ui/chip-list.css` объявлен
 * контейнером (`container-type: inline-size`). При shrink-to-fit собственная
 * ширина чип-листа вырождалась в 0: чипы (обёртки) оставались шириной ~14px,
 * а подписи — 0 (не видны). Для пользовательского мультивыбора это уже
 * исправлено правилом `.fv-user` (ошибка 609deba0 п.6); перечисления
 * (`.fv-enum`: «Тип действия», «Вид сущности», виды вложений) обязаны
 * растягиваться тем же способом.
 *
 * По стандарту «Правило без теста-сторожа не считается введённым» сторож
 * краснеет на умышленном нарушении — самопроверка мутациями ниже. Входит в
 * обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STYLESHEET = path.join(CLIENT_ROOT, 'src', 'renderer', 'styles', 'filter-tree.css');

/** Селектор растяжения ячейки значения с перечислением. */
const ENUM_CELL_SELECTOR = '.ft-row__value .fv:has(> .fv-enum)';
/** Селектор заполнения ширины обёрткой перечисления. */
const ENUM_WRAP_SELECTOR = '.ft-row__value .fv-enum';

interface CssRule {
  readonly selector: string;
  readonly declarations: ReadonlyMap<string, string>;
}

/** Блочные комментарии → пробелы (структура CSS не меняется). */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

/** Разобрать CSS в плоский список правил «селектор → объявления». */
function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(stripComments(css))) !== null) {
    const [, selectors = '', body = ''] = match;
    const declarations = new Map<string, string>();
    for (const decl of body.matchAll(/([a-zA-Z-]+)\s*:\s*([^;]+);?/g)) {
      const [, key = '', rawValue = ''] = decl;
      declarations.set(key.trim().toLowerCase(), rawValue.trim());
    }
    for (const selector of selectors.split(',')) {
      rules.push({ selector: selector.trim(), declarations });
    }
  }
  return rules;
}

/** Объединить объявления набора правил (позднее перекрывает раннее). */
function mergedDeclarations(rules: readonly CssRule[]): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of rules) {
    for (const [key, value] of rule.declarations) merged.set(key, value);
  }
  return merged;
}

/** Нормализовать пробелы селектора для сравнения. */
function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim();
}

/**
 * Нарушения правила ширины ячейки-перечисления. Пустой массив — правило
 * соблюдено.
 */
export function collectEnumWidthViolations(css: string): string[] {
  const violations: string[] = [];
  const rules = parseRules(css);

  // 1. Ячейка `.fv` с перечислением растягивается на ширину колонки значения:
  //    иначе чип-лист (inline-size-контейнер) схлопывается при shrink-to-fit.
  const cellRules = rules.filter(
    (rule) => normalizeSelector(rule.selector) === ENUM_CELL_SELECTOR,
  );
  if (cellRules.length === 0) {
    violations.push(`нет правила «${ENUM_CELL_SELECTOR}» — ячейка перечисления не растягивается`);
  } else {
    const cell = mergedDeclarations(cellRules);
    if (cell.get('align-self') !== 'stretch') {
      violations.push(`у «${ENUM_CELL_SELECTOR}» нет align-self: stretch`);
    }
    if (cell.get('min-width') !== '0') {
      violations.push(`у «${ENUM_CELL_SELECTOR}» нет min-width: 0`);
    }
  }

  // 2. Обёртка перечисления заполняет растянутую ячейку целиком.
  const wrapRules = rules.filter(
    (rule) => normalizeSelector(rule.selector) === ENUM_WRAP_SELECTOR,
  );
  if (wrapRules.length === 0) {
    violations.push(`нет правила «${ENUM_WRAP_SELECTOR}» — обёртка не заполняет ширину ячейки`);
  } else {
    const wrap = mergedDeclarations(wrapRules);
    if (wrap.get('width') !== '100%') {
      violations.push(`у «${ENUM_WRAP_SELECTOR}» нет width: 100%`);
    }
  }

  return violations;
}

describe('guard: ширина ячейки-перечисления в редакторе отбора (1f3f0df5)', () => {
  const css = fs.readFileSync(STYLESHEET, 'utf8');

  it('filter-tree.css растягивает .fv-enum как .fv-user', () => {
    assert.deepEqual(collectEnumWidthViolations(css), []);
  });

  it('правило краснеет, если перечисление перестало растягиваться', () => {
    const withoutCell = css.replace(ENUM_CELL_SELECTOR, '.fv-enum-mutated');
    assert.ok(
      collectEnumWidthViolations(withoutCell).some((v) => v.includes('не растягивается')),
      'без растяжения ячейки чип-лист снова схлопнется в 0',
    );

    const withoutStretch = css.replace(
      /(\.ft-row__value \.fv:has\(> \.fv-enum\)[^{]*\{)([\s\S]*?)(\n\})/,
      (_all, head: string, body: string, tail: string) =>
        `${head}${body.replace(/\s*align-self:\s*stretch;/, '')}${tail}`,
    );
    assert.notEqual(withoutStretch, css, 'мутация обязана менять CSS');
    assert.ok(
      collectEnumWidthViolations(withoutStretch).some((v) => v.includes('align-self: stretch')),
      'потеря align-self: stretch обязана краснеть',
    );
  });

  it('правило краснеет, если обёртка перестала заполнять ширину', () => {
    const withoutWrap = css.replace(ENUM_WRAP_SELECTOR, '.fv-enum-mutated');
    assert.ok(
      collectEnumWidthViolations(withoutWrap).some((v) => v.includes('не заполняет ширину')),
      'без width: 100% обёртка не получает ширину колонки',
    );
  });
});
