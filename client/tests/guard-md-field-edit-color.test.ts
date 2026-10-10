/**
 * Сторож цвета текста поля markdown по режимам (0.12.1, ошибка 61329f12
 * «Текст комментария в режиме правки должен быть бледнее основного текста»).
 *
 * Правила, которые обязан удерживать код:
 *   1. в режиме правки текст поля приглушён — приглушение задано токеном темы
 *      (`--text-dim`), а не hex-литералом;
 *   2. приглушение привязано к классу `.md-field--editing` — просмотр
 *      (`.comment-view` / `.md-field-view`) не затронут и остаётся обычного
 *      цвета (`--text`): базовое правило просмотра `color` не переопределяет;
 *   3. выход из правки снимает класс `.md-field--editing`, поэтому цвет
 *      возвращается к обычному механически.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { readRendererCss, RENDERER_ROOT } from './renderer-css.js';

interface Rule {
  prelude: string;
  body: string;
}

/** Все правила верхнего уровня собранного CSS (prelude → body). */
function parseRules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let depth = 0;
  let prelude = '';
  let body = '';
  for (const ch of text) {
    if (ch === '{') {
      if (depth === 0) {
        body = '';
      }
      depth++;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        rules.push({ prelude: prelude.trim(), body });
        prelude = '';
        body = '';
      }
      continue;
    }
    if (depth === 0) prelude += ch;
    else if (depth === 1) body += ch;
  }
  return rules;
}

const RULES = parseRules(readRendererCss());

/** Селекторы правила, разбитые по запятой (нормализованы). */
function selectors(rule: Rule): string[] {
  return rule.prelude.split(',').map((s) => s.trim());
}

describe('guard: цвет текста поля markdown по режимам (61329f12)', () => {
  it('в правке текст приглушён токеном темы --text-dim', () => {
    const rule = RULES.find(
      (r) => r.prelude.includes('.md-field--editing') && /color:\s*var\(--text-dim\)/.test(r.body),
    );
    assert.ok(
      rule !== undefined,
      'нет правила, приглушающего текст поля в правке через `color: var(--text-dim)` — ' +
        'правка перестанет отличаться по цвету от просмотра',
    );
    assert.ok(
      selectors(rule).some((s) => s.includes('.cm-editor')),
      'приглушение обязано бить по полю правки (`.cm-editor`), иначе текст останется обычным',
    );
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(rule.body),
      'приглушение задано hex-литералом — цвет должен идти из токена темы',
    );
  });

  it('приглушение ограничено правкой: просмотр не затронут', () => {
    const rule = RULES.find(
      (r) => r.prelude.includes('.md-field--editing') && /color:\s*var\(--text-dim\)/.test(r.body),
    );
    assert.ok(rule !== undefined, 'правило приглушения правки не найдено');
    for (const selector of selectors(rule)) {
      assert.doesNotMatch(
        selector,
        /\.(md-field-view|comment-view)\b/,
        `селектор «${selector}» накрывает просмотр — просмотр обязан остаться обычного цвета`,
      );
    }
  });

  it('базовые правила просмотра не задают приглушённый цвет', () => {
    // Базовый (не потомковый) селектор просмотра не должен сам переопределять
    // `color` на приглушённый — иначе просмотр тоже станет бледным.
    for (const rule of RULES) {
      for (const selector of selectors(rule)) {
        if (/\s/.test(selector)) continue; // потомковые правила не трогают базовый текст
        if (!/\.(md-field-view|comment-view)\b/.test(selector)) continue;
        assert.doesNotMatch(
          rule.body,
          /color:\s*var\(--text-(dim|faint)\)/,
          `базовый селектор «${selector}» приглушает текст просмотра`,
        );
      }
    }
  });

  it('выход из правки снимает класс .md-field--editing (цвет возвращается)', () => {
    const field = readFileSync(
      resolve(RENDERER_ROOT, 'editor', 'markdown-field.ts'),
      'utf8',
    );
    assert.match(
      field,
      /classList\.remove\('md-field--editing'\)/,
      'класс режима правки не снимается — после сохранения/отмены текст остался бы бледным',
    );
    assert.match(
      field,
      /classList\.add\('md-field--editing'\)/,
      'класс режима правки не ставится — правка не получит приглушённый цвет',
    );
  });
});
