/**
 * Уровень 1 тех.проекта «Инкрементальное обновление списков UI» (задача
 * 3bfef1f7): проводка сохранения прокрутки в экранах «Структуры мыслей» и
 * «Дневник».
 *
 * Экраны в node-тесте не поднимаются (тянут `app.js`/холст/редактор), поэтому
 * расстановка семантики «сохранять или наверх» проверяется структурно по
 * исходникам — как и в `structures-visual-patch.test.ts` для уровня 0.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const STRUCTURES = fs.readFileSync(
  path.join(RENDERER, 'screens', 'structures', 'structures.ts'),
  'utf8',
);
const CHRONICLE = fs.readFileSync(
  path.join(RENDERER, 'screens', 'chronicle', 'chronicle.ts'),
  'utf8',
);

describe('Структуры: сохранение прокрутки при пересборке дерева', () => {
  it('renderTree оборачивает сборку в preserveScroll по параметру', () => {
    assert.match(STRUCTURES, /import \{ preserveScroll \} from '\.\.\/\.\.\/lib\/ui\/scroll-anchor\.js'/);
    assert.match(STRUCTURES, /function renderTree\(keepScroll = false\): void/);
    assert.match(
      STRUCTURES,
      /preserveScroll\(resultsHost,\s*\(\)\s*=>\s*renderTree\(false\)\)/,
      'сборка с сохранением идёт через хелпер',
    );
  });

  it('новый отбор и первый вход показывают список с начала', () => {
    // onApply панели отбора и первый вход — без сохранения.
    assert.match(STRUCTURES, /void applyQuery\(true\);/);
    assert.match(STRUCTURES, /await applyQuery\(true\);/);
    assert.ok(
      !/applyQuery\(true,\s*true\)(?![\s\S]*reloadAll)/.test(STRUCTURES.slice(0, STRUCTURES.indexOf('function reloadAll'))),
      'вход/новый отбор не просят сохранять позицию',
    );
  });

  it('realtime-перезапрос и дозагрузка сохраняют позицию', () => {
    assert.match(STRUCTURES, /await applyQuery\(true, true\);/, 'reloadAll сохраняет позицию');
    assert.match(STRUCTURES, /void applyQuery\(false, true\)/, '«Показать ещё» сохраняет позицию');
    // Раскрытие/свёртывание узла и дозагрузка соседей — через renderTree(true).
    assert.match(
      STRUCTURES,
      /function toggleExpand\([\s\S]*?renderTree\(true\)[\s\S]*?function loadMoreNeighbors/,
    );
    assert.match(STRUCTURES, /async function loadMoreNeighbors[\s\S]*?renderTree\(true\)/);
  });
});

describe('Дневник: прокрутка ленты при обновлении (уровень 2)', () => {
  it('renderFeed обновляет ленту инкрементально (keyed), без полной пересборки', () => {
    // Уровень 2 тех.проекта `1d48df6d`: полная пересборка ленты упразднена —
    // identity неизменных карточек и групп дней держит прокрутку сам, поэтому
    // `preserveScroll` в «Дневнике» больше не участвует.
    assert.match(
      CHRONICLE,
      /reconcileKeyed\(list,\s*days,\s*\{/,
      'внешний keyed-уровень — группы дней',
    );
    assert.match(
      CHRONICLE,
      /reconcileKeyed\(dayList,\s*day\.rows,\s*\{/,
      'внутренний keyed-уровень — карточки записей',
    );
    assert.ok(
      !/preserveScroll\(feedWrap/.test(CHRONICLE),
      'полная пересборка ленты через preserveScroll упразднена',
    );
    assert.ok(!/keepFeedScroll/.test(CHRONICLE), 'ручной флаг сохранения прокрутки упразднён');
  });

  it('смена отбора показывает ленту с начала, переход — позиционирует на записи', () => {
    assert.match(CHRONICLE, /feedWrap\.scrollTop = 0;/, 'applyFilter сбрасывает позицию');
    assert.match(
      CHRONICLE,
      /function focusRecord[\s\S]*?scrollIntoView\(\{ block: 'center' \}\)/,
      'переход к записи позиционируется на её карточке',
    );
  });
});
