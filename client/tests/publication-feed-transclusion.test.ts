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
  htmlHasTransclusionMarkup,
  previewTextNeedsExpansion,
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
    assert.match(
      WS,
      /previewTextNeedsExpansion\(html, md\)/,
      'триггер досборки текста-блока учтён',
    );
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

describe('резюме и realtime-патч блока разворачивают вставки (ошибка 3b3035cf)', () => {
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

  test('резюме титула берёт серверный summary_html и достраивает вставки клиентом', () => {
    assert.match(
      WS,
      /assembly\?\.publication\.summary_html/,
      'серверный HTML резюме (сборка с развёрткой) используется в титуле',
    );
    assert.match(
      WS,
      /expandTextTransclusions\(block, summaryRaw\)/,
      'вставки живого снимка резюме достраиваются общим клиентским путём',
    );
  });

  test('realtime-патч блока идёт по НОВОМУ markdown-источнику', () => {
    assert.match(
      WS,
      /function patchBlockText\(thoughtId: string, md: string\)/,
      'точечный патч блока принимает markdown-источник, а не готовый HTML',
    );
    assert.match(WS, /patchBlockText\(ownerId, bodyMd\)/, 'realtime передаёт новый body_md');
    assert.match(WS, /block\.md = md/, 'модель блока синхронно обновляет md');
  });
});

/**
 * Поведенческий тест круга 3 (ошибка 3b3035cf): серверный превью-HTML текста,
 * собранный С резолвером публикационных ссылок, отдаёт трансклюзию как
 * `!Источник` — БЕЗ `!<span class="wiki-link">`. Прежний признак
 * {@link htmlHasTransclusionMarkup} её не ловил (регресс круга 2). Досборка
 * должна запускаться по СЫРОМУ markdown фрагмента, а итоговый HTML обязан нести
 * блок `md-transclusion` с содержимым источника. Тест краснеет, если выключить
 * триггер досборки или саму развёртку.
 */
describe('превью-текст публикации: досборка вставки (ошибка 3b3035cf, круг 3)', () => {
  test('сырой HTML с резолвером → досборка по сырому md даёт md-transclusion с источником', async () => {
    const md = `до ![[#${A}]] после`;
    // Форма серверного превью-текста с резолвером (так отдаёт сборка публикации).
    const rawWithResolver = '<p data-md-start="0" data-md-end="17">!Источник</p>';
    assert.equal(
      htmlHasTransclusionMarkup(rawWithResolver),
      false,
      'старый признак по HTML не сработал бы — это и был регресс круга 2',
    );
    assert.equal(
      previewTextNeedsExpansion(rawWithResolver, md),
      true,
      'досборка запускается по сырому markdown',
    );

    const html = await renderExpandedTransclusionHtml(md, NET, mapLoader({ [A]: 'тело A' }));
    assert.ok(html !== null, 'HTML развёртки получен');
    assert.ok(html!.includes('md-transclusion'), `в HTML нет блока md-transclusion: ${html}`);
    assert.ok(html!.includes('тело A'), 'в HTML нет содержимого источника');
    assert.ok(!html!.includes('![[#'), 'ссылка-трансклюзия не раскрыта');
  });

  test('HTML уже развёрнут / нет трансклюзий → досборка не запускается', () => {
    assert.equal(
      previewTextNeedsExpansion(
        '<div class="md-transclusion" data-transclusion-depth="1">x</div>',
        `до ![[#${A}]] после`,
      ),
      false,
      'развёрнутый HTML не пересобираем повторно',
    );
    assert.equal(
      previewTextNeedsExpansion('<p>обычный текст</p>', 'обычный текст'),
      false,
      'без трансклюзий досборка не нужна',
    );
  });
});
