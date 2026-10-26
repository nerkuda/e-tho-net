/**
 * Юнит-тесты общего предиката «точкой владеет лупа» (ошибка d0338c48).
 *
 * Дефект: у облачка мысли с иконкой-вложением и заполненным постоянным
 * комментарием Ctrl+наведение на иконку показывало ДВА попапа одновременно —
 * лупу (`image-zoom.ts`) и панель постоянного комментария (`hover-preview.ts`).
 * Движки независимы (оба слушают документ), поэтому решение «кто владеет
 * точкой» вынесено в нейтральный `lib/zoom-anchor.ts`; здесь проверяется само
 * решение и его проводка в движок предпросмотра.
 *
 * Модуль не создаёт DOM: `pictureOwnsCtrlPreview` — чистая функция над
 * размерами/флагами, а `imageOwnsCtrlPreview` (DOM-адаптер) проверяется
 * структурно — клиентские тесты идут без jsdom (конвенция соседних тестов).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { pictureOwnsCtrlPreview, zoomable } from '../src/renderer/lib/zoom-anchor.js';
import { hoverPreviewInternals } from '../src/renderer/lib/hover-preview.js';

const { pictureTakesOverPoint } = hoverPreviewInternals;

test('pictureOwnsCtrlPreview: иконка-вложение владеет точкой всегда — даже показанная в натуральную величину', () => {
  // L16: у лупы есть полная картинка вложения, поэтому размер превью не
  // мешает ей открыться. Второй предпросмотр (комментарий) обязан уступить.
  assert.equal(
    pictureOwnsCtrlPreview({
      attachmentBacked: true,
      natural: { w: 512, h: 512 },
      displayed: { w: 512, h: 512 },
    }),
    true,
  );
  assert.equal(
    pictureOwnsCtrlPreview({
      attachmentBacked: true,
      natural: { w: 0, h: 0 },
      displayed: { w: 0, h: 0 },
    }),
    true,
  );
});

test('pictureOwnsCtrlPreview: обычная картинка владеет точкой только когда лупа реально покажет увеличение', () => {
  assert.equal(
    pictureOwnsCtrlPreview({
      attachmentBacked: false,
      natural: { w: 512, h: 512 },
      displayed: { w: 44, h: 44 },
    }),
    true,
    'уменьшенная картинка — лупа откроется',
  );
  assert.equal(
    pictureOwnsCtrlPreview({
      attachmentBacked: false,
      natural: { w: 512, h: 512 },
      displayed: { w: 512, h: 512 },
    }),
    false,
    'картинка в натуральную величину — лупа не откроется, комментарий остаётся единственным превью',
  );
  assert.equal(
    pictureOwnsCtrlPreview({
      attachmentBacked: false,
      natural: { w: 0, h: 0 },
      displayed: { w: 44, h: 44 },
    }),
    false,
    'незагруженная картинка — лупа не откроется',
  );
});

test('pictureOwnsCtrlPreview: SVG без вложения не владеет точкой (натуральный размер неизвестен синхронно)', () => {
  assert.equal(
    pictureOwnsCtrlPreview({ attachmentBacked: false, natural: null, displayed: null }),
    false,
  );
  assert.equal(
    pictureOwnsCtrlPreview({ attachmentBacked: true, natural: null, displayed: null }),
    true,
    'SVG-иконка с вложением владеет точкой по data-атрибутам',
  );
});

test('zoomable: предикат из нейтрального модуля не изменил контракт', () => {
  assert.equal(zoomable({ w: 512, h: 512 }, { w: 44, h: 44 }), true);
  assert.equal(zoomable({ w: 512, h: 512 }, { w: 512, h: 256 }), true);
  assert.equal(zoomable({ w: 32, h: 32 }, { w: 44, h: 44 }), false);
  assert.equal(zoomable({ w: 0, h: 0 }, { w: 44, h: 44 }), false);
});

/** Контейнер, который «содержит» только перечисленные узлы — зеркало
 *  `Element.contains` в объёме, нужном чистой функции. */
function container(...owned: object[]): { contains(node: object | null): boolean } {
  return { contains: (node) => node !== null && owned.includes(node) };
}

test('pictureTakesOverPoint: картинка внутри root-триггера забирает точку у облачного превью', () => {
  const icon = {};
  const root = container(icon);
  assert.equal(pictureTakesOverPoint(true, root, icon as never), true);
});

test('pictureTakesOverPoint: картинка вне root-триггера (например, внутри вложенного попапа) цепочку не закрывает', () => {
  const icon = {};
  const root = container(); // иконка не в root-триггере
  assert.equal(pictureTakesOverPoint(true, root, icon as never), false);
});

test('pictureTakesOverPoint: без открытой цепочки и без владения точкой — false', () => {
  const icon = {};
  assert.equal(pictureTakesOverPoint(true, null, icon as never), false);
  assert.equal(pictureTakesOverPoint(false, container(icon), icon as never), false);
  assert.equal(pictureTakesOverPoint(true, container(icon), null), false);
});

test('движок предпросмотра использует общий предикат и не открывает второе превью над картинкой', () => {
  const src = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'renderer', 'lib', 'hover-preview.ts'),
    'utf8',
  );
  assert.ok(
    src.includes("import { imageOwnsCtrlPreview } from './zoom-anchor.js'"),
    'hover-preview берёт решение у нейтрального zoom-anchor, а не дублирует его',
  );
  assert.ok(
    src.includes('const pictureOwnsPoint = event.ctrlKey && imageOwnsCtrlPreview(target)'),
    'mousemove распознаёт картинку под курсором',
  );
  assert.ok(
    src.includes('pictureTakesOverPoint(pictureOwnsPoint, rootTrigger, target)'),
    'root-попап облачка уступает точке картинки',
  );
  assert.ok(
    /if \(pictureOwnsPoint\) \{\s*abandonPendingOpen\(\);/.test(src),
    'над картинкой открытие второго превью отменяется вместе с идущим резолвером',
  );
  assert.ok(
    /if \(imageOwnsCtrlPreview\(at\)\) \{\s*abandonPendingOpen\(\);\s*if \(pictureTakesOverPoint\(true, rootTrigger, at\)\) closeChain\(\);/.test(
      src,
    ),
    'Ctrl, нажатый над картинкой, закрывает облачное превью сразу',
  );
});

test('лупа и предпросмотр используют ОДИН модуль предиката (движки не могут разойтись)', () => {
  const zoom = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'renderer', 'lib', 'image-zoom.ts'),
    'utf8',
  );
  assert.ok(
    zoom.includes("from './zoom-anchor.js'"),
    'image-zoom импортирует общий предикат якоря/зума',
  );
  assert.ok(
    !/export function zoomable\(/.test(zoom),
    'вторая копия zoomable в image-zoom не заведена',
  );
  // DOM-адаптер читает data-атрибуты иконки-вложения и размеры <img>.
  const anchor = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'renderer', 'lib', 'zoom-anchor.ts'),
    'utf8',
  );
  for (const needle of [
    "node.dataset['zoomThought']",
    "node.dataset['zoomAttachment']",
    'node.naturalWidth',
    'node.width',
    'pictureOwnsCtrlPreview',
  ]) {
    assert.ok(anchor.includes(needle), `DOM-адаптер использует ${needle}`);
  }
});
