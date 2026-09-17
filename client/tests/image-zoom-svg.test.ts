/**
 * Structural checks for the Ctrl-hover magnifier («лупа», `lib/image-zoom.ts`)
 * over SVG `<image>` anchors (ошибка e4ef6a27).
 *
 * Контракт: «лупа» работает на любой отрисованной картинке — не только на
 * HTML `<img>`, но и на SVG `<image>`. Единственное место клиента, где иконка
 * мысли рисуется SVG-элементом, — мини-граф редактора (`editor/mini-graph.ts`);
 * до фикса Ctrl+наведение на такую иконку не показывало ничего, потому что
 * магнификатор проверял `instanceof HTMLImageElement`.
 *
 * Модуль тянет DOM (делегированные слушатели на `document`, `Image()`,
 * `getBoundingClientRect`) — клиентские тесты идут без jsdom (см. конвенцию
 * в соседних тестах), поэтому проверяются якоря исходника: распознавание
 * SVG-якоря, чтение его URL, замер отображаемого/натурального размера и
 * единый предикат `zoomable`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const SRC = {
  zoom: resolve(import.meta.dirname, '..', 'src', 'renderer', 'lib', 'image-zoom.ts'),
  graph: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'mini-graph.ts'),
};

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('«лупа» на SVG-иконках (ошибка e4ef6a27)', () => {
  it('SVG <image> распознаётся как якорь магнификатора', () => {
    const src = readText(SRC.zoom);
    assert.ok(
      src.includes('type ZoomAnchor = HTMLImageElement | SVGImageElement'),
      'the anchor union covers HTML <img> and SVG <image>',
    );
    assert.ok(
      /isZoomAnchor\(node: EventTarget \| null\): node is ZoomAnchor \{\s*return node instanceof HTMLImageElement \|\| node instanceof SVGImageElement;/.test(
        src,
      ),
      'the runtime predicate checks SVGImageElement too',
    );
    // Оба пути открытия (mouseover и Ctrl уже зажат) идут через предикат, а не
    // через прямой instanceof HTMLImageElement — иначе восстановленный Ctrl не
    // сработал бы на SVG-иконке.
    assert.equal(
      (src.match(/isZoomAnchor\(/g) ?? []).length >= 3,
      true,
      'both open paths (mouseover, Ctrl keydown) use the shared predicate',
    );
    assert.ok(
      !/target instanceof HTMLImageElement/.test(src),
      'the old HTMLImageElement-only gate is gone',
    );
  });

  it('URL, отображаемый и натуральный размер берутся из SVG-элемента корректно', () => {
    const src = readText(SRC.zoom);
    // SVG <image> не имеет src/currentSrc — URL лежит в href (и xlink:href).
    assert.ok(
      /function anchorSrc\(/.test(src) && src.includes("getAttribute('href')"),
      'the source URL of an SVG anchor is read from its href attribute',
    );
    assert.ok(
      src.includes("getAttributeNS('http://www.w3.org/1999/xlink', 'href')"),
      'xlink:href is honoured as a fallback',
    );
    // У SVG-элемента нет width/height, о размере говорит отрисованный бокс
    // (он же учитывает зум мира графа).
    assert.ok(
      /function displayedSize\(/.test(src) &&
        src.includes('anchor.getBoundingClientRect()'),
      'the displayed size of an SVG anchor comes from its rendered box',
    );
    // Натуральный размер SVG-картинки элементу неизвестен — меряется загрузкой
    // того же URL, иначе решение «увеличивать ли» принять нечем.
    assert.ok(
      /function measureNaturalSize\(/.test(src) && src.includes('new Image()'),
      'the natural size of an SVG source is measured by loading the URL',
    );
    for (const anchor of ['zoomable(natural, displayedSize(anchor))']) {
      assert.ok(src.includes(anchor), `the zoomable gate is still applied: ${anchor}`);
    }
  });

  it('мини-граф помечает SVG-иконку данными вложения (полная картинка, L16)', () => {
    const src = readText(SRC.graph);
    assert.ok(
      /img\.dataset\['zoomThought'\] = node\.ref\.id/.test(src),
      'the SVG icon carries the thought id',
    );
    assert.ok(
      /img\.dataset\['zoomAttachment'\] = attachmentId/.test(src),
      'the SVG icon carries the backing attachment id',
    );
    assert.ok(
      /\?\? null;\s*if \(attachmentId !== null\)/.test(src),
      'the zoom data is set only when the icon is attachment-backed',
    );
  });
});
