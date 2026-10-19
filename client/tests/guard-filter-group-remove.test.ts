/**
 * Сторож видимости крестика удаления ГРУППЫ в редакторе отбора (ошибка
 * a398b169 «В редакторе отбора не убирается крестик с групп условий»).
 *
 * Правило (решение заказчика 2026-10-17): крестик группы виден только при
 * наведении на СВОЮ (глубочайшую) группу — одновременно с кнопками
 * «+ условие»/«+ группа» — и при клавиатурном фокусе внутри неё. Механизм —
 * ПАРА `opacity: 0` + `pointer-events: none` в покое и `opacity: 1` +
 * `pointer-events: auto` в `:hover`/`:focus-within`. `visibility`/`display`-
 * скрытие запрещено: оно убирает кнопку из порядка обхода Tab и ломает
 * доступность (стандарт 1b5f6200 «функция не живёт только на hover»).
 *
 * По стандарту f36a5207 «Правило без теста-сторожа не считается введённым»
 * запрет обязан краснеть на умышленном нарушении — самопроверка мутациями
 * ниже. Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STYLESHEET = path.join(CLIENT_ROOT, 'src', 'renderer', 'styles', 'filter-tree.css');

/** Класс крестика группы (без совпадения с однотипными `ft-group__remove-*`). */
const REMOVE_CLASS = /\.ft-group__remove(?![\w-])/;

/** Блочные комментарии → пробелы (структура CSS не меняется). */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

interface CssRule {
  /** Один селектор из списка (списки развёрнуты). */
  readonly selector: string;
  readonly declarations: ReadonlyMap<string, string>;
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

/**
 * Нарушения правила видимости крестика группы. Пустой массив — правило
 * соблюдено.
 */
export function collectGroupRemoveViolations(css: string): string[] {
  const violations: string[] = [];
  const removeRules = parseRules(css).filter((rule) => REMOVE_CLASS.test(rule.selector));

  // 1. Покой: крестик скрыт ПАРОЙ opacity + pointer-events.
  const baseRules = removeRules.filter(
    (rule) => !rule.selector.includes(':hover') && !rule.selector.includes(':focus-within'),
  );
  const base = mergedDeclarations(baseRules);
  if (base.get('opacity') !== '0') {
    violations.push('в покое у .ft-group__remove нет opacity: 0');
  }
  if (base.get('pointer-events') !== 'none') {
    violations.push('в покое у .ft-group__remove нет pointer-events: none');
  }

  // 2. Показ: и по наведению, и по клавиатурному фокусу — та же пара.
  for (const state of [':hover', ':focus-within']) {
    const shown = mergedDeclarations(removeRules.filter((rule) => rule.selector.includes(state)));
    if (shown.get('opacity') !== '1') {
      violations.push(`нет показа .ft-group__remove по ${state} (opacity: 1)`);
    }
    if (shown.get('pointer-events') !== 'auto') {
      violations.push(`нет кликабельности .ft-group__remove по ${state} (pointer-events: auto)`);
    }
  }

  // 3. Показ — только у ГЛУБОЧАЙШЕЙ группы: hover/focus всплывают к предкам,
  //    поэтому каждый показывающий селектор обязан отсекать предка с наведённой
  //    вложенной группой и адресовать крестик в заголовке СВОЕЙ группы.
  //    Без этого крестик родителя появляется при наведении на вложенную группу
  //    (регрессия из замечания verifier'а к a398b169).
  const deepestGuard: Readonly<Record<string, string>> = {
    ':hover': ':not(:has(.ft-group:hover))',
    ':focus-within': ':not(:has(.ft-group:focus-within))',
  };
  const headChain = '> .ft-group__head >';
  for (const [state, guard] of Object.entries(deepestGuard)) {
    for (const rule of removeRules.filter((r) => r.selector.includes(state))) {
      const selector = rule.selector.replace(/\s+/g, ' ');
      if (!selector.includes(guard)) {
        violations.push(`показ по ${state} без отсечения предка ${guard}: ${rule.selector}`);
      }
      if (!selector.includes(headChain)) {
        violations.push(`показ по ${state} без цепочки «${headChain}»: ${rule.selector}`);
      }
    }
  }

  // 4. Запрещённое скрытие: visibility/display ломают Tab-порядок.
  for (const rule of removeRules) {
    if (rule.declarations.get('visibility') === 'hidden') {
      violations.push(`.ft-group__remove скрыт через visibility: hidden (${rule.selector})`);
    }
    if (rule.declarations.get('display') === 'none') {
      violations.push(`.ft-group__remove скрыт через display: none (${rule.selector})`);
    }
  }

  return violations;
}

/** Заменить тело базового правила `.ft-group__remove { … }` (отдельного, не списка). */
function mutateBaseBody(css: string, mutate: (body: string) => string): string {
  // Отдельное правило узнаётся по первой строке объявлений `opacity: 0;`:
  // селектор в списке `.ft-row__remove, .ft-group__remove` тоже начинается
  // с `.ft-group__remove {`, но скрытия в нём нет.
  return css.replace(
    /(^\.ft-group__remove \{\r?\n)(?= {2}opacity: 0;)([\s\S]*?)(^})/m,
    (_all, head, body, tail) => `${head}${mutate(body)}${tail}`,
  );
}

describe('guard: крестик группы отбора — виден только по hover/focus (a398b169)', () => {
  const css = fs.readFileSync(STYLESHEET, 'utf8');

  it('filter-tree.css соблюдает пару opacity+pointer-events и не скрывает через visibility/display', () => {
    assert.deepEqual(collectGroupRemoveViolations(css), []);
  });

  it('правило краснеет, если из покоя пропала пара opacity+pointer-events', () => {
    const withoutOpacity = mutateBaseBody(css, (body) =>
      body.replace(/opacity:\s*0;/, ''),
    );
    assert.notDeepEqual(collectGroupRemoveViolations(withoutOpacity), []);

    const withoutPointerEvents = mutateBaseBody(css, (body) =>
      body.replace(/pointer-events:\s*none;/, ''),
    );
    assert.notDeepEqual(collectGroupRemoveViolations(withoutPointerEvents), []);
  });

  it('правило краснеет на visibility: hidden / display: none', () => {
    const hidden = mutateBaseBody(css, (body) => `${body}visibility: hidden;\n`);
    assert.ok(
      collectGroupRemoveViolations(hidden).some((v) => v.includes('visibility: hidden')),
      'visibility: hidden обязан попадать в нарушения',
    );

    const collapsed = mutateBaseBody(css, (body) => `${body}display: none;\n`);
    assert.ok(
      collectGroupRemoveViolations(collapsed).some((v) => v.includes('display: none')),
      'display: none обязан попадать в нарушения',
    );
  });

  it('правило краснеет, если пропал клавиатурный показ (:focus-within)', () => {
    const withoutFocus = css.replace(/\.ft-group:focus-within[^\n]*\n/, '');
    assert.ok(
      collectGroupRemoveViolations(withoutFocus).some((v) => v.includes(':focus-within')),
      'без правила :focus-within крестик недостижим с клавиатуры',
    );
  });

  it('правило краснеет на потере «глубочайшей группы» и цепочки заголовка (M6/M7)', () => {
    // M6: hover перестаёт отсекать предка с наведённой вложенной группой —
    // крестик родителя снова появляется при наведении на вложенную.
    const withoutDeepestHover = css.replace(
      '.ft-group:hover:not(:has(.ft-group:hover)) > .ft-group__head > .ft-group__remove',
      '.ft-group:hover > .ft-group__head > .ft-group__remove',
    );
    assert.notEqual(withoutDeepestHover, css, 'мутация M6 обязана менять CSS');
    assert.ok(
      collectGroupRemoveViolations(withoutDeepestHover).some(
        (v) => v.includes(':hover') && v.includes('отсечения предка'),
      ),
      'потеря :not(:has(.ft-group:hover)) обязана краснеть',
    );

    // M7: то же для клавиатурного фокуса.
    const withoutDeepestFocus = css.replace(
      '.ft-group:focus-within:not(:has(.ft-group:focus-within)) > .ft-group__head > .ft-group__remove',
      '.ft-group:focus-within > .ft-group__head > .ft-group__remove',
    );
    assert.notEqual(withoutDeepestFocus, css, 'мутация M7 обязана менять CSS');
    assert.ok(
      collectGroupRemoveViolations(withoutDeepestFocus).some(
        (v) => v.includes(':focus-within') && v.includes('отсечения предка'),
      ),
      'потеря :not(:has(.ft-group:focus-within)) обязана краснеть',
    );

    // Цепочка адресации крестика в заголовке СВОЕЙ группы.
    const withoutHeadChain = css.replaceAll(
      ' > .ft-group__head > .ft-group__remove',
      ' .ft-group__remove',
    );
    assert.notEqual(withoutHeadChain, css, 'мутация цепочки обязана менять CSS');
    const chainViolations = collectGroupRemoveViolations(withoutHeadChain);
    assert.ok(
      chainViolations.some((v) => v.includes(':hover') && v.includes('> .ft-group__head >')),
      'потеря цепочки в hover-правиле обязана краснеть',
    );
    assert.ok(
      chainViolations.some((v) => v.includes(':focus-within') && v.includes('> .ft-group__head >')),
      'потеря цепочки в focus-правиле обязана краснеть',
    );
  });
});
