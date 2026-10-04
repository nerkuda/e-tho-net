/**
 * Сторож двойной рамки открытого в редакторе элемента (задача 3af98e31).
 *
 * Правило: сплошная рамка открытого в редакторе элемента рисуется ОДНИМ
 * механизмом — внутренняя полоса цветом фокуса активного слоя
 * (`--layer-focus-stripe`) плюс внешний тонкий контрастный кант
 * (`--focus-ring-contrast`), иначе рамка сливается с фоном фокуса того же
 * цвета. Контрастный кант — единый токен темы; его обязаны использовать ВСЕ
 * сплошные рамки открытого: гало карты и «Структур» (общий класс
 * `.cloud.halo`), строка библиотеки (`.pub-open`) и блок документа публикации
 * (`.pub-doc-editor`). Пунктирную рамку текущего (`.cloud.kbd-cursor`,
 * `.pub-current`, `.pub-doc-current`) трогать нельзя — она остаётся
 * одноцветной (ADR e6d48e09).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(RENDERER, ...parts), 'utf8');
}

/** Тело CSS-правила по точному селектору (первое совпадение). */
function ruleBody(css: string, selector: string): string {
  const rx = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}',
  );
  const match = rx.exec(css);
  assert.ok(match !== null, `найдено правило ${selector}`);
  return match[1] ?? '';
}

const TOKENS = read('styles', 'tokens.css');
const CANVAS = read('styles', 'canvas.css');
const PUBLICATIONS = read('styles', 'screens', 'publications.css');
const STRUCTURES_VISUAL = read('screens', 'structures', 'visual-states.ts');

describe('guard: двойная рамка открытого — единый контрастный кант (3af98e31)', () => {
  it('токен контраста объявлен в обеих темах', () => {
    const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(TOKENS)?.[1] ?? '';
    const darkBlock = /\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/.exec(TOKENS)?.[1] ?? '';
    assert.match(rootBlock, /--focus-ring-contrast:\s*#[0-9a-f]{6};/i, 'кант объявлен в :root');
    assert.match(
      darkBlock,
      /--focus-ring-contrast:\s*#[0-9a-f]{6};/i,
      'кант объявлен в тёмной теме',
    );
  });

  it('гало карты и «Структур» (.cloud.halo) несёт контрастный кант', () => {
    const body = ruleBody(CANVAS, '.cloud.halo');
    assert.match(body, /var\(--layer-focus-stripe/, 'внутренняя полоса — цвет фокуса слоя');
    assert.match(body, /var\(--focus-ring-contrast\)/, 'внешний кант — общий токен контраста');
  });

  it('фокусное облачко (.cloud.focus-cloud.halo) не теряет двойную рамку', () => {
    // `.cloud.focus-cloud` ниже по модулю с той же специфичностью перебивает
    // `.cloud.halo` — рамка обязана быть переустановлена более специфичным
    // правилом, иначе у фокуса (обычный случай: редактор следует за фокусом)
    // двойного кольца нет (ошибка реализации задачи 3af98e31).
    const body = ruleBody(CANVAS, '.cloud.focus-cloud.halo');
    assert.match(body, /var\(--layer-focus-stripe/, 'внутренняя полоса — цвет фокуса слоя');
    assert.match(body, /var\(--focus-ring-contrast\)/, 'внешний кант — общий токен контраста');
  });

  it('строка библиотеки (.pub-open) и блок документа (.pub-doc-editor) — тот же кант', () => {
    for (const selector of ['.pub-open', '.pub-doc-editor']) {
      const body = ruleBody(PUBLICATIONS, selector);
      assert.match(
        body,
        /var\(--layer-focus-stripe/,
        `${selector}: внутренняя полоса — цвет фокуса слоя`,
      );
      assert.match(body, /var\(--focus-ring-contrast\)/, `${selector}: внешний кант — общий токен`);
    }
  });

  it('«Структуры» переиспользуют общий класс гало (единый механизм)', () => {
    assert.match(
      STRUCTURES_VISUAL,
      /classList\.toggle\('halo'/,
      '«Структуры» ставят общий класс .halo — вид рамки общий с картой',
    );
  });

  it('пунктирная рамка текущего не получает контрастный кант', () => {
    assert.doesNotMatch(
      ruleBody(CANVAS, '.cloud.kbd-cursor'),
      /focus-ring-contrast/,
      'пунктир карты одноцветный',
    );
    for (const selector of ['.pub-current', '.pub-doc-current']) {
      assert.doesNotMatch(
        ruleBody(PUBLICATIONS, selector),
        /focus-ring-contrast/,
        `${selector}: пунктир одноцветный`,
      );
    }
  });
});
