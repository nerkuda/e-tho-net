/**
 * Лента публикации: тексты с трансклюзиями разворачиваются (ошибка 075602b4,
 * 0.12.1).
 *
 * Серверный `body_html` текста собран из исходного `body_md` и ссылку-
 * трансклюзию не разворачивает — лента показывала ссылку вместо текста.
 * Развёртку и рендер выполняет ОБЩИЙ путь трансклюзий (`@etn/markdown` через
 * `editor/transclusion.ts`), тот же, что у комментария мысли.
 *
 * Часть 1 — юнит развёртки (`renderExpandedTransclusionHtml`, headless);
 * часть 2 — якоря исходника ленты (реальный DOM-рендер требует движка).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  renderExpandedTransclusionHtml,
  type TransclusionSourceLoader,
} from '../src/renderer/editor/transclusion.js';

const A = '11111111-1111-4111-8111-111111111111';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';

/** Загрузчик поверх карты `id → тело`. */
function mapLoader(bodies: Record<string, string>): TransclusionSourceLoader {
  return async (id) => {
    const body = bodies[id];
    return body === undefined
      ? { found: false, title: '', body_md: '' }
      : { found: true, title: id, body_md: body };
  };
}

describe('развёртка трансклюзий текста (ошибка 075602b4)', () => {
  test('ссылка-трансклюзия разворачивается в HTML с текстом источника', async () => {
    const html = await renderExpandedTransclusionHtml(
      `до ![[#${A}]] после`,
      NET,
      mapLoader({ [A]: 'тело A' }),
    );
    assert.ok(html !== null, 'HTML развёртки получен');
    assert.ok(html!.includes('тело A'), 'текст источника присутствует');
    assert.ok(
      !html!.includes('!<span class="wiki-link"'),
      'ссылка-трансклюзия развёрнута, а не осталась ссылкой',
    );
  });

  test('текст без трансклюзий — null (серверный HTML не трогаем)', async () => {
    const html = await renderExpandedTransclusionHtml('обычный текст', NET, mapLoader({}));
    assert.equal(html, null);
  });
});

describe('лента публикации использует общую развёртку (ошибка 075602b4)', () => {
  const WS = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'src',
      'renderer',
      'screens',
      'publications',
      'workspace.ts',
    ),
    'utf8',
  );

  test('текст-блок достраивается развёрнутым HTML по признаку ссылки', () => {
    assert.match(WS, /htmlHasTransclusionMarkup\(html\)/, 'признак неразвёрнутой ссылки учтён');
    assert.match(
      WS,
      /renderExpandedTransclusionHtml\(md, networkId\)/,
      'развёртка идёт общим путём (@etn/markdown), без своего парсера',
    );
    assert.match(WS, /function expandTextTransclusions\(/, 'есть отдельный шаг развёртки текста');
  });

  test('грип ручного порядка сохраняется после развёртки', () => {
    assert.match(
      WS,
      /classList\.contains\(DRAG_HANDLE_CLASS\)/,
      'грип находится по общему классу и возвращается на место',
    );
  });
});
