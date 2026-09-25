/**
 * Высота таблицы хроно-комментариев на «Хронике» (ошибка 78562781).
 *
 * Симптом: перетаскивание границы между таблицей записей и областью
 * комментария визуально работало только во время драга, а после отпускания
 * высота возвращалась к прежней (240 px). Диагноз: сохранённая высота писалась
 * и читалась исправно (`saveListClamp('chronicle.table')` →
 * `chronicle_list_heights`), но применялась как точный инлайновый `height`, а
 * на элементе оставался **стилевой** `max-height: 240px` (`.chron-table-wrap`):
 * инлайновый потолок превью очищался на drag-end, и CSS-потолок снова обрезал
 * высоту — «граница возвращается».
 *
 * Тесты структурные (конвенция соседних клиентских тестов — без jsdom):
 * проверяют и сам механизм (фикс `max-height: none`), и что сплиттер «Хроники»
 * пишет в тот же ключ L4, применяет высоту при пересборке и не пересекается с
 * каркасом панели отбора (задача 2ebe4206). Заодно фиксируется вывод проверки
 * «Событий» и «Структур»: своего сплиттера высоты таблицы там нет.
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
const LIST_HEIGHTS_TS = resolve(RENDERER, 'editor', 'list-heights.ts');
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

describe('высота таблицы хроно-комментариев (ошибка 78562781)', () => {
  it('стилевой max-height не перекрывает высоту, выбранную перетаскиванием', () => {
    const heights = readText(LIST_HEIGHTS_TS);
    const idx = heights.indexOf('export function applyGroupClamp');
    assert.ok(idx >= 0, 'applyGroupClamp найден');
    const body = heights.slice(idx, heights.indexOf('/**', idx + 10));
    assert.match(
      body,
      /group\.style\.maxHeight\s*=\s*'none'/,
      'applyGroupClamp ставит max-height: none — иначе стилевой потолок обрезает сохранённую высоту',
    );

    const css = readText(STYLES_CSS);
    const chronWrap = bodiesOf(css, '.chron-table-wrap');
    assert.ok(chronWrap.length > 0, 'правило .chron-table-wrap на месте');
    assert.match(
      chronWrap.join('\n'),
      /max-height:\s*240px/,
      'до первого драга у таблицы остаётся CSS-умолчание (пять строк, §17)',
    );
  });

  it('каждый кламп-контейнер с фиксированной высотой снимает потолок базового правила', () => {
    const css = readText(STYLES_CSS);
    // Общий сторож: правило, задающее точный height через --clamp-*, обязано
    // нести и `max-height: none` — иначе `.admin-table-wrap` (380px) молча
    // обрезает высоту, вытянутую за его предел (та же ошибка 78562781).
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

  it('драг сплиттера сохраняет высоту в тот же ключ L4, что читается при старте', () => {
    const src = readText(CHRONICLE_TS);
    const idx = src.indexOf("persistKey: 'chronicle.table'");
    assert.ok(idx >= 0, 'сплиттер таблицы сохраняет высоту под ключом chronicle.table');
    const call = src.slice(idx - 400, idx);
    assert.match(call, /rowSplitter\(\(\) => wrap,/, 'высоту меняет сам разделитель таблицы');
    assert.match(call, /min:\s*48/, 'нижняя граница высоты сохранена');

    const heights = readText(LIST_HEIGHTS_TS);
    assert.match(
      heights,
      /CHRONICLE_KEY_PREFIX\s*=\s*'chronicle\.'/,
      'ключи chronicle.* пишутся в chronicle_list_heights',
    );
    assert.ok(
      'chronicle.table'.startsWith('chronicle.'),
      'ключ таблицы попадает в снимок экрана, а не редактора',
    );
  });

  it('высота переживает пересборку: применяется к стабильному элементу при монтировании', () => {
    const src = readText(CHRONICLE_TS);
    assert.match(
      src,
      /applyGroupClamp\(wrap, 'chronicle\.table'\)/,
      'высота применяется сразу при монтировании экрана',
    );
    // Обёртка таблицы не пересоздаётся при обновлении данных: таблица —
    // единый фасад (элемент создаётся один раз), обновление — `setRows`, поэтому
    // инлайновая высота не теряется.
    assert.match(src, /const wrap = div\('admin-table-wrap chron-table-wrap'\)/, 'обёртка таблицы — стабильный элемент');
    assert.match(src, /createTable<ChronicleRow>\(\{/, 'таблица — единый фасад lib/ui/table.ts');
    assert.match(src, /table\.setRows\(rows\)/, 'перерисовка меняет строки фасада, а не обёртку');
    assert.ok(
      !/wrap\.replaceChildren\(/.test(src),
      'обёртку таблицы никогда не пересобирают целиком',
    );
  });

  it('каркас панели отбора не трогает высоту таблицы', () => {
    const frame = readText(FRAME_TS);
    assert.ok(
      !/applyGroupClamp|saveListClamp|list-heights/.test(frame),
      'каркас панели не пишет в хранилище высот списков',
    );
    assert.ok(!/tableWrap|chron-table/.test(frame), 'каркас панели не знает про обёртку таблицы');
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
