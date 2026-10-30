/**
 * Сторож видимости чек-боксов task-списков (ошибка 5c6cc7d3, версия 0.15.1).
 *
 * Правило. Чек-бокс `- [ ]` / `- [x]` — это ИНДИКАТОР состояния, который рисует
 * единый рендерер `@etn/markdown` (`<input class="task-list-item-checkbox" …
 * disabled>`; класс правки `cm-md-task-checkbox` ставит `editor/md-live.ts`).
 * Его вид обязан задаваться токенами темы БЕЗ приглушения:
 *   1. `opacity: 1` — вендор (`@layer wa-native`) приглушает отключённый
 *      контрол до 0.5, и рамка `--border-strong` растворялась в фоне (в тёмной
 *      теме чек-боксы были не видны);
 *   2. контур — `--text-dim` (контраст как у вторичного текста), заливка —
 *      `--surface-2`, у отмеченного — `--accent` и галочка `--accent-fg`;
 *   3. цвета — только `var(--…)`, без hex-литералов;
 *   4. селектор — по классу рендерера БЕЗ класса-хоста: правило вида живёт в
 *      одном месте, а хостов просмотра много (просмотр комментария и
 *      хронологии через `.md-field-view.comment-view`, вложения, документ
 *      публикации, попап предпросмотра — `.comment-view`; лента «Дневника» —
 *      собственный `.diary-body`). Привязка к одному хосту оставила бы
 *      остальные с приглушённым вендорским видом (класс, а не случай — стандарт
 *      deb29881, прецедент 49ebba76).
 *
 * Поведенческая часть подтверждает, что класс в CSS — это именно класс,
 * который эмитит единый рендерер (рендерер переименует класс — сторож
 * покраснеет), и что список задач получает `contains-task-list`.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderMarkdown } from '@etn/markdown';

import { readRendererCss } from './renderer-css.js';

/** CSS рендерера в порядке манифеста (тот же бандл, что видит клиент). */
const CSS = readRendererCss();

/** Блочные комментарии → пробелы (номера строк сохраняются). */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

interface CssRule {
  /** Текст до `{` (селекторы через запятую). */
  prelude: string;
  /** Всё между `{` и `}`. */
  body: string;
}

/** Правила верхнего уровня, в чьём селекторе есть подстрока `needle`. */
function rulesWith(needle: string): CssRule[] {
  const code = stripComments(CSS);
  const out: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of code.matchAll(re)) {
    const prelude = m[1]!.trim();
    if (prelude.includes(needle)) out.push({ prelude, body: m[2]! });
  }
  return out;
}

/** Коллекция правил: склеенный prelude (нормализованные пробелы). */
function preludeOf(rule: CssRule): string {
  return rule.prelude.replace(/\s+/g, ' ').trim();
}

describe('guard: видимость чек-боксов task-списков (5c6cc7d3)', () => {
  const cssClass = 'task-list-item-checkbox';

  it('рендерер эмитит класс, на который опираются стили', () => {
    const html = renderMarkdown('- [ ] снятая\n- [x] отмеченная');
    assert.match(html, /class="task-list-item-checkbox"/, 'чек-бокс несёт класс рендерера');
    assert.match(html, /class="contains-task-list"/, 'список задач помечен contains-task-list');
    assert.match(html, /class="task-list-item"/, 'пункт задачи помечен task-list-item');
    assert.ok(
      html.includes('type="checkbox" disabled'),
      'чек-бокс задачи отключён (индикатор состояния, не контрол)',
    );
  });

  it('вид чек-бокса задан токенами без приглушения и без класса-хоста', () => {
    const rules = rulesWith(cssClass);
    assert.ok(rules.length > 0, `в CSS нет правил для .${cssClass}`);

    const base = rules.find((r) => preludeOf(r).includes(`input.${cssClass}`) && !preludeOf(r).includes(':checked'));
    assert.ok(base !== undefined, 'нет базового правила input.task-list-item-checkbox');
    const basePrelude = preludeOf(base);
    assert.ok(
      basePrelude.includes('.cm-md-task-checkbox'),
      'базовое правило обязано быть парным: класс правки cm-md-task-checkbox',
    );
    assert.ok(
      !basePrelude.includes('.comment-view') && !basePrelude.includes('.diary-body'),
      'селектор привязан к хосту: остальные места просмотра markdown останутся без вида',
    );
    assert.match(base.body, /(?:^|[\s;])opacity:\s*1\s*;/, 'приглушение disabled (opacity: 0.5) обязано быть снято');
    assert.match(
      base.body,
      /border-color:\s*var\(--text-dim\)/,
      'контур — токен --text-dim (контраст как у вторичного текста)',
    );
    assert.match(
      base.body,
      /background-color:\s*var\(--surface-2\)/,
      'заливка неотмеченного — токен --surface-2',
    );

    const checked = rules.find(
      (r) => preludeOf(r).includes(`input.${cssClass}:checked`) && preludeOf(r).includes('.cm-md-task-checkbox:checked'),
    );
    assert.ok(checked !== undefined, 'нет правила отмеченного состояния (просмотр + правка)');
    assert.match(
      checked.body,
      /border-color:\s*var\(--accent\)/,
      'контур отмеченного — токен --accent',
    );
    assert.match(
      checked.body,
      /background-color:\s*var\(--accent\)/,
      'заливка отмеченного — токен --accent (состояния различимы)',
    );
    assert.match(
      checked.body,
      /(?:^|[\s;])color:\s*var\(--accent-fg\)/,
      'галочка отмеченного — токен --accent-fg (currentColor вендорской :checked::after)',
    );
  });

  it('в правилах чек-бокса нет hex-литералов (цвет — только из темы)', () => {
    for (const rule of rulesWith(cssClass)) {
      assert.doesNotMatch(
        rule.body,
        /#[0-9a-fA-F]{3,8}\b/,
        `hex-литерал в правиле «${preludeOf(rule)}»: цвет обязан идти из токена`,
      );
    }
  });

  it('маркер списка задач снят во всех местах просмотра (без класса-хоста)', () => {
    const marker = rulesWith('contains-task-list').find((r) => /list-style:\s*none/.test(r.body));
    assert.ok(marker !== undefined, 'нет правила list-style: none для contains-task-list');
    assert.ok(
      !preludeOf(marker).includes('.comment-view') && !preludeOf(marker).includes('.diary-body'),
      'снятие маркера привязано к хосту: в остальных местах просмотра останется точка/номер',
    );
    const item = rulesWith('li.task-list-item').find((r) => /list-style:\s*none/.test(r.body));
    assert.ok(item !== undefined, 'нет правила list-style: none для li.task-list-item');
  });
});
