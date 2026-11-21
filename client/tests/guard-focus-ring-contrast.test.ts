/**
 * Сторож двойной рамки открытого в редакторе элемента (задача 3af98e31).
 *
 * Правило: сплошная рамка открытого в редакторе элемента рисуется ОДНИМ
 * механизмом — кольцо цвета `--frame-open` (его считает `lib/cloud-frames.ts`
 * как производное от полосы активного слоя или от токена курсора темы, задача
 * c6d74fd4) плюс внешний тонкий контрастный кант
 * (`--focus-ring-contrast`), иначе рамка сливается с фоном фокуса того же
 * цвета. В списках публикаций кольцо по-прежнему берётся прямо из цепочки
 * `--layer-focus-stripe` → `--focus-accent` → `--accent`. Контрастный кант — единый токен темы; его обязаны использовать ВСЕ
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

import { THEMES_DIR, THEME_MODES, readTheme, themeBlockBody } from './theme-css.js';

const RENDERER = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(RENDERER, ...parts), 'utf8');
}

/** Тело CSS-правила по точному селектору (первое совпадение). */
function ruleBody(css: string, selector: string): string {
  const rx = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const match = rx.exec(css);
  assert.ok(match !== null, `найдено правило ${selector}`);
  return match[1] ?? '';
}

/**
 * Все файлы тем версии (`lib/ui/themes/*.css`) — фокус-пара обязана быть в
 * КАЖДОЙ теме, а не только в `current` (карточка сторожа 642ff492).
 */
const THEMES = fs
  .readdirSync(THEMES_DIR)
  .filter((file) => file.endsWith('.css'))
  .map((file) => file.replace(/\.css$/, ''))
  .sort();

const CANVAS = read('styles', 'canvas.css');
const PUBLICATIONS = read('styles', 'screens', 'publications.css');
const STRUCTURES_VISUAL = read('screens', 'structures', 'visual-states.ts');

describe('guard: двойная рамка открытого — единый контрастный кант (3af98e31)', () => {
  it('токены фокуса объявлены в каждой теме в обоих режимах', () => {
    assert.ok(THEMES.length >= 2, `ожидались файлы тем, найдено: ${THEMES.join(', ')}`);
    for (const name of THEMES) {
      const css = readTheme(name);
      for (const mode of THEME_MODES) {
        const body = themeBlockBody(css, name, mode);
        assert.ok(body !== null, `${name}.css: нет блока режима '${mode}'`);
        assert.match(
          body!,
          /--focus-accent:\s*[^;]+;/i,
          `${name}.css [${mode}]: нет программного фокус-акцента основы (--focus-accent)`,
        );
        assert.match(
          body!,
          /--focus-ring-contrast:\s*#[0-9a-f]{6};/i,
          `${name}.css [${mode}]: кант объявлен`,
        );
      }
    }
  });

  it('гало карты и «Структур» (.cloud.halo) несёт контрастный кант', () => {
    const body = ruleBody(CANVAS, '.cloud.halo');
    assert.match(
      body,
      /var\(--frame-open,\s*var\(--focus-accent,\s*var\(--accent\)\)\)/,
      'кольцо — --frame-open (производное от полосы слоя/курсора темы)',
    );
    assert.match(body, /var\(--focus-ring-contrast\)/, 'внешний кант — общий токен контраста');
  });

  it('фокусное облачко (.cloud.focus-cloud.halo) не теряет двойную рамку', () => {
    // `.cloud.focus-cloud` ниже по модулю с той же специфичностью перебивает
    // `.cloud.halo` — рамка обязана быть переустановлена более специфичным
    // правилом, иначе у фокуса (обычный случай: редактор следует за фокусом)
    // двойного кольца нет (ошибка реализации задачи 3af98e31).
    const body = ruleBody(CANVAS, '.cloud.focus-cloud.halo');
    assert.match(
      body,
      /var\(--frame-open,\s*var\(--focus-accent,\s*var\(--accent\)\)\)/,
      'кольцо — --frame-open (производное от полосы слоя/курсора темы)',
    );
    assert.match(body, /var\(--focus-ring-contrast\)/, 'внешний кант — общий токен контраста');
  });

  it('строка библиотеки (.pub-open) и блок документа (.pub-doc-editor) — тот же кант', () => {
    for (const selector of ['.pub-open', '.pub-doc-editor']) {
      const body = ruleBody(PUBLICATIONS, selector);
      assert.match(
        body,
        /var\(--layer-focus-ring-screen,\s*var\(--focus-accent,\s*var\(--accent\)\)\)/,
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
