/**
 * Сторож единой высоты однострочных полей ввода (требование b0e0e5a4, ошибки
 * 80871d3d / c9ef88e7).
 *
 * Правило: высота однострочного поля ввода задаётся ЕДИНЫМ токеном
 * дизайн-системы `--field-h` (styles/base.css — общее правило для
 * `input`/`select`, lib/ui/field.css — `.ui-input`), а композитное чип-поле
 * своей рамкой (`.st-f-chipfield` — `min-height: var(--field-h)`, растёт по
 * содержимому). Любое ОБЪЯВЛЕНИЕ `height`/`min-height` на однострочном поле
 * вне токена — обходной путь, который снова даст 40px вместо 30px: сторож
 * краснеет на нём.
 *
 * Разрешены только значения: `var(--field-h)`, `auto`, `100%`, `inherit` и
 * `calc(… var(--field-h) …)`. Многострочные поля (`textarea`, `.ui-textarea`)
 * и неполя (флажок, радио, файл, ползунок, свотч цвета) вне правила.
 *
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { readRendererCss } from './renderer-css.js';
import { collectViolations, type GuardRule } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Классы однострочных полей ввода (кроме `input`/`select` по элементу). */
const FIELD_CLASSES = [
  '.ui-input',
  '.select-input',
  '.st-f-input',
  '.st-f-search',
  '.search-input',
  '.value-combo-add',
  '.link-value-add',
  '.entity-combo-input',
  '.prop-editor',
  '.st-f-chipfield',
];

/** Селекторы, которые правилом не считаются (не однострочные поля). */
const EXEMPT = [
  'textarea',
  '.ui-textarea',
  '.editor-title-input',
  'color',
  'checkbox',
  'radio',
  'range',
  'file',
];

/** Разрешённые значения высоты (токен дизайн-системы либо естественные). */
const ALLOWED_VALUE = /^(?:auto|100%|inherit|var\(--field-h\)|calc\([^)]*var\(--field-h\)[^)]*\))$/;

/** Правило CSS: селектор + тело. */
export interface CssRule {
  selector: string;
  body: string;
}

/** Разбирает собранный CSS на правила (без вложенных @media-обёрток не бывает
 *  у полей; at-правила пропускаются). */
export function parseRules(css: string): CssRule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of withoutComments.matchAll(re)) {
    const selector = (match[1] ?? '').trim();
    const body = match[2] ?? '';
    if (selector.startsWith('@')) continue;
    rules.push({ selector, body });
  }
  return rules;
}

/** Однострочное ли поле описывает селектор (хоть одна часть списка). */
function targetsSingleLineField(selector: string): boolean {
  const lower = selector.toLowerCase();
  const parts = lower.split(',');
  return parts.some((part) => {
    if (EXEMPT.some((token) => part.includes(token))) return false;
    if (/\b(input|select)\b/.test(part)) return true;
    return FIELD_CLASSES.some((cls) =>
      new RegExp(`${cls.replace(/\./g, '\\.')}(?![\\w-])`).test(part),
    );
  });
}

/** Объявления высоты на однострочных полях вне токена (нарушения). */
export function fieldHeightViolations(rules: readonly CssRule[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (!targetsSingleLineField(rule.selector)) continue;
    for (const decl of rule.body.matchAll(/(?:^|;)\s*(height|min-height)\s*:\s*([^;]+)/g)) {
      const prop = decl[1] ?? '';
      const value = (decl[2] ?? '').trim();
      if (!ALLOWED_VALUE.test(value)) {
        out.push(`${rule.selector} { ${prop}: ${value} }`);
      }
    }
  }
  return out;
}

describe('guard: высота однострочных полей — только токен --field-h', () => {
  it('в стилях нет объявлений height/min-height полей вне токена', () => {
    const rules = parseRules(readRendererCss());
    const violations = fieldHeightViolations(rules);
    assert.deepEqual(
      violations,
      [],
      `высота однострочного поля задана вне токена --field-h (ошибки 80871d3d / c9ef88e7):\n${violations.join('\n')}`,
    );
  });

  it('правило краснеет на умышленном обходе (высота полем-литералом)', () => {
    const bad = parseRules('.table-list td input.ui-input { height: 40px; }');
    assert.deepEqual(
      fieldHeightViolations(bad),
      ['.table-list td input.ui-input { height: 40px }'],
      'литеральная высота поля обязана попадать в нарушение',
    );
    const ok = parseRules('.st-f-chipfield { min-height: var(--field-h); }');
    assert.deepEqual(fieldHeightViolations(ok), [], 'токен — не нарушение');
    const multiline = parseRules('.ui-textarea { min-height: var(--field-textarea-min-h); }');
    assert.deepEqual(fieldHeightViolations(multiline), [], 'многострочное поле вне правила');
  });

  it('глобальное правило высоты поля объявлено по токену (стили не отменяют его молча)', () => {
    const css = readRendererCss();
    assert.match(
      css,
      /\binput\b[\s\S]*?,\s*select\s*\{\s*height:\s*var\(--field-h\)/,
      'глобальная высота input/select обязана браться из токена --field-h',
    );
  });

  it('высота однострочного поля не задаётся инлайном в TS (обход CSS-правила)', () => {
    const rules: GuardRule[] = [
      {
        name: 'no-inline-field-height',
        description:
          'Высота однострочного поля не задаётся инлайном (`style.height`/`minHeight` ' +
          'на input/select) — только токен --field-h (ошибки 80871d3d / c9ef88e7).',
        pattern: /\b\w*(?:Input|Select)\b[^\n]*\.style\.(?:height|minHeight)\s*=/,
      },
    ];
    const violations = collectViolations(RENDERER_ROOT, rules, { extensions: ['.ts'] });
    assert.deepEqual(
      violations,
      [],
      `высота поля задана инлайном вне токена:\n${violations
        .map((v) => `  • ${v.file}:${v.line} — ${v.text}`)
        .join('\n')}`,
    );
  });
});
