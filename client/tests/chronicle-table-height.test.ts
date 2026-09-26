/**
 * Высота ленты «Дневника» — продолжение ошибки 78562781.
 *
 * Симптом прежней «Хроники»: перетаскивание границы между таблицей записей и
 * областью комментария визуально работало только во время драга, а после
 * отпускания высота возвращалась к прежней (240 px): сохранённая высота
 * применялась инлайном, но стилевой `max-height` снова обрезал её. Задача T6
 * заменила таблицу с нижним редактором на ленту, поэтому прежний сплиттер и
 * ключ `chronicle.table` из экрана ушли. Сторож сохраняет общий инвариант
 * (кламп-контейнеры снимают стилевой потолок) и фиксирует новую раскладку:
 * лента — стабильный контейнер на всю высоту центра, список внутри
 * перерисовывается `replaceChildren`, потолок 240px больше не возвращается.
 *
 * Тесты структурные (конвенция соседних клиентских тестов — без jsdom).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { assembledStylesFile } from './renderer-css.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const CHRONICLE_TS = resolve(RENDERER, 'screens', 'chronicle', 'chronicle.ts');
const ACTIVITY_TS = resolve(RENDERER, 'screens', 'activity', 'activity.ts');
const STRUCTURES_TS = resolve(RENDERER, 'screens', 'structures', 'structures.ts');
const FRAME_TS = resolve(RENDERER, 'lib', 'filter-panel-frame.ts');
const STYLES_CSS = assembledStylesFile();

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Разбирает CSS на блоки «селектор + тело» (без вложенности @media). */
function cssBlocks(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: match[1]!.trim().replace(/\s+/g, ' '), body: match[2]! });
  }
  return out;
}

/** Тело CSS-правил, у которых селектор содержит подстроку. */
function bodiesOf(css: string, selectorPart: string): string[] {
  return cssBlocks(css)
    .filter((b) => b.selector.includes(selectorPart))
    .map((b) => b.body);
}

describe('лента «Дневника»: высота не теряется (продолжение ошибки 78562781)', () => {
  it('каждый кламп-контейнер с фиксированной высотой снимает потолок базового правила', () => {
    const css = readText(STYLES_CSS);
    const clampBlocks = cssBlocks(css).filter((b) => /height:\s*var\(--clamp-/.test(b.body));
    assert.ok(clampBlocks.length > 0, 'кламп-контейнеры с height: var(--clamp-*) найдены');
    for (const block of clampBlocks) {
      assert.match(
        block.body,
        /max-height:\s*none/,
        `кламп-контейнер «${block.selector}» не снимает max-height — высота будет обрезана`,
      );
    }
    for (const selector of ['.admin-table-wrap.chrono-table', '.admin-table-wrap.prop-wrap']) {
      const bodies = bodiesOf(css, selector);
      assert.ok(bodies.length > 0, `правило ${selector} на месте`);
      assert.match(bodies.join('\n'), /max-height:\s*none/, `${selector} снимает потолок базового правила`);
    }
  });

  it('лента занимает высоту центра и не несёт стилевого потолка', () => {
    const css = readText(STYLES_CSS);
    const main = bodiesOf(css, '.chron-main').join('\n');
    assert.match(
      main,
      /flex-direction:\s*column/,
      'центр «Дневника» — колонка: сверху панель добавления, ниже лента',
    );

    const feed = bodiesOf(css, '.chron-feed-wrap').join('\n');
    assert.ok(feed.length > 0, 'правило .chron-feed-wrap на месте');
    assert.match(feed, /flex:\s*1 1 auto/, 'лента растягивается на остаток высоты');
    assert.match(feed, /max-height:\s*none/, 'лента снимает прежний потолок таблицы (240px)');
    assert.match(feed, /overflow:\s*auto/, 'лента — прокручиваемый контейнер');
  });

  it('контейнер ленты стабилен, список перерисовывается replaceChildren', () => {
    const src = readText(CHRONICLE_TS);
    assert.match(
      src,
      /feedWrap = div\('admin-table-wrap chron-table-wrap chron-feed-wrap'\)/,
      'контейнер ленты — стабильный элемент (в т.ч. цель drop для drag-cloud)',
    );
    assert.match(src, /feedList = div\('chron-feed'\)/, 'список ленты — отдельный стабильный элемент');
    assert.ok(
      !/wrap\.replaceChildren\(/.test(src),
      'контейнер ленты не пересобирают целиком — перерисовывается только список',
    );
    assert.match(src, /feedList\.replaceChildren\(\.\.\.nodes\)/, 'данные меняет список ленты');
    // Лента дневника: прокруточная догрузка «+50».
    assert.match(src, /shouldLoadMore\(counters, feedWrap\)/, 'дозагрузка «+50» привязана к контейнеру ленты');
  });

  it('каркас панели отбора не трогает высоту ленты', () => {
    const frame = readText(FRAME_TS);
    assert.ok(
      !/applyGroupClamp|saveListClamp|list-heights/.test(frame),
      'каркас панели не пишет в хранилище высот списков',
    );
    assert.ok(!/feedWrap|chron-feed/.test(frame), 'каркас панели не знает про ленту');
    assert.match(frame, /panel\.style\.flexBasis/, 'каркас меняет только размер самой панели');
  });

  it('«События» и «Структуры» такого сплиттера не имеют (проверка однотипности)', () => {
    for (const path of [ACTIVITY_TS, STRUCTURES_TS]) {
      assert.ok(
        !readText(path).includes('rowSplitter('),
        'на экране нет сплиттера высоты таблицы — чинить нечего',
      );
    }
    const activityWrap = bodiesOf(readText(STYLES_CSS), '.activity-table-wrap').join('\n');
    assert.match(activityWrap, /max-height:\s*none/, 'таблица «Событий» и так растягивается без потолка');
  });
});
