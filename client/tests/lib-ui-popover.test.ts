/**
 * Компонент всплывающей панели `lib/ui/popover` (задача dd1f47d4, требование
 * f74f1aae «Всплывающий предпросмотр — общий компонент lib/ui»).
 *
 * Что закрепляем (DoD задачи «тесты позиционирования и края окна»):
 *   • чистую геометрию `placeUnderAnchor` — постановку под якорем с переворотом
 *     наверх, прижатие к левому/правому и нижнему краю окна, хвостик;
 *   • `placeAtCursor` — постановку у курсора с разворотом к правому/нижнему краю;
 *   • `openPopover` — сборку панели (единые классы, заголовок, тело),
 *     монтирование, позиционирование, закрытие по Escape/клику вне/прокрутке.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`), конвенция
 * `lib-ui-fields.test.ts`; делегированные слушатели `document` перехватываются
 * мок-документом, что и позволяет «нажать Escape» и «кликнуть вне» без браузера.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import { ShimElement } from './dom-shim.js';

// Escape по панели идёт через диспетчер контекстов: стек между тестами чист.
beforeEach(() => keymap.keymapInternals.reset());

/** Событие, доставленное делегированному слушателю компонента. */
type Fired = { target?: unknown; key?: string };

/** Мок-документ: держит обработчики и умеет доставлять им события. */
interface MockDoc {
  createElement: (tag: string) => ShimElement;
  createElementNS: (ns: string, tag: string) => ShimElement;
  createTextNode: (text: string) => ShimElement;
  body: ShimElement;
  addEventListener: (type: string, handler: (event: Fired) => void) => void;
  removeEventListener: () => void;
  /** Тестовый драйвер: событие всем слушателям типа. */
  fire: (type: string, event: Fired) => void;
}

let doc: MockDoc;

function installDom(): void {
  const listeners: Record<string, Array<(event: Fired) => void>> = {};
  doc = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (_text: string) => new ShimElement('#text'),
    body: new ShimElement('body'),
    addEventListener: (type: string, handler: (event: Fired) => void) => {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener: () => undefined,
    fire: (type: string, event: Fired) => {
      for (const handler of [...(listeners[type] ?? [])]) handler(event);
    },
  };
  const win: any = {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  (globalThis as any).document = doc;
  (globalThis as any).window = win;
}

installDom();

type PopoverModule = typeof import('../src/renderer/lib/ui/popover.js');
let cached: PopoverModule | null = null;
async function popover(): Promise<PopoverModule> {
  if (cached === null) cached = await import('../src/renderer/lib/ui/popover.js');
  return cached;
}

/** Пустое окно и чистый `document.body` перед каждым сценарием. */
function resetBody(): void {
  doc.body.replaceChildren();
}

/**
 * Узел в типе `HTMLElement` для API компонента: тесты идут без jsdom, поэтому
 * фактически это `ShimElement` (как в остальных фасадах `lib/ui`).
 */
function elem(tag = 'div', className?: string): HTMLElement {
  return new ShimElement(tag, className) as unknown as HTMLElement;
}

/** Панель ещё смонтирована? */
function mounted(element: ShimElement): boolean {
  return doc.body.children.includes(element);
}

describe('lib/ui/popover: чистая геометрия у якоря', () => {
  it('placeUnderAnchor: по центру под якорем', async () => {
    const { placeUnderAnchor } = await popover();
    const placed = placeUnderAnchor(
      { left: 100, top: 100, width: 80, height: 20 },
      { width: 200, height: 100 },
      { width: 1000, height: 800 },
    );
    assert.deepEqual(placed, { left: 40, top: 130, side: 'top', arrowLeft: 100 });
  });

  it('placeUnderAnchor: нет места снизу — переворот наверх (side bottom)', async () => {
    const { placeUnderAnchor } = await popover();
    const placed = placeUnderAnchor(
      { left: 100, top: 700, width: 80, height: 20 },
      { width: 200, height: 100 },
      { width: 1000, height: 800 },
    );
    assert.equal(placed.top, 590);
    assert.equal(placed.side, 'bottom');
  });

  it('placeUnderAnchor: нет места ни снизу, ни сверху — прижатие к нижнему краю', async () => {
    const { placeUnderAnchor } = await popover();
    const placed = placeUnderAnchor(
      { left: 100, top: 20, width: 80, height: 20 },
      { width: 200, height: 100 },
      { width: 1000, height: 100 },
    );
    assert.equal(placed.top, 8, 'панель не выходит за нижний край');
    assert.equal(placed.side, 'top');
  });

  it('placeUnderAnchor: прижатие к правому краю, хвостик не уезжает за угол', async () => {
    const { placeUnderAnchor } = await popover();
    const placed = placeUnderAnchor(
      { left: 950, top: 100, width: 80, height: 20 },
      { width: 200, height: 100 },
      { width: 1000, height: 800 },
    );
    assert.equal(placed.left, 792);
    assert.equal(placed.arrowLeft, 186, 'хвостик прижат к правому краю панели');
  });
});

describe('lib/ui/popover: чистая геометрия у курсора', () => {
  it('placeAtCursor: справа-снизу от курсора', async () => {
    const { placeAtCursor } = await popover();
    const placed = placeAtCursor(
      { x: 100, y: 100 },
      { width: 200, height: 100 },
      { width: 1000, height: 800 },
    );
    assert.deepEqual(placed, { left: 114, top: 114 });
  });

  it('placeAtCursor: не хватает справа — разворот влево', async () => {
    const { placeAtCursor } = await popover();
    const placed = placeAtCursor(
      { x: 950, y: 100 },
      { width: 200, height: 100 },
      { width: 1000, height: 800 },
    );
    assert.equal(placed.left, 736);
  });

  it('placeAtCursor: не хватает снизу — разворот вверх', async () => {
    const { placeAtCursor } = await popover();
    const placed = placeAtCursor(
      { x: 100, y: 750 },
      { width: 200, height: 100 },
      { width: 1000, height: 800 },
    );
    assert.equal(placed.top, 636);
  });
});

describe('lib/ui/popover: жизненный цикл панели', () => {
  it('openPopover: единые классы, заголовок, тело, монтирование и позиция', async () => {
    resetBody();
    const p = await popover();
    const body = elem('div', 'content');
    const handle = p.openPopover({
      anchor: { element: elem('span') },
      content: { title: 'Заголовок', body },
      extraClass: 'hp-mode',
      dataset: { depth: '1' },
    });
    assert.ok(handle.element.classList.contains(p.POPOVER_CLASS));
    assert.ok(handle.element.classList.contains('hp-mode'));
    assert.equal(handle.element.dataset['depth'], '1');
    const head = (handle.element as unknown as ShimElement).children[0]!;
    const bodyWrap = (handle.element as unknown as ShimElement).children[1]!;
    assert.ok(head.classList.contains(p.POPOVER_HEAD_CLASS));
    assert.equal(head.textContent, 'Заголовок');
    assert.ok(bodyWrap.classList.contains(p.POPOVER_BODY_CLASS));
    assert.equal(bodyWrap.children[0], body as unknown as ShimElement);
    assert.equal(handle.element.dataset['arrow'], 'top', 'панель под якорем — хвостик сверху');
    assert.ok(handle.contains(body as unknown as Node), 'тело лежит внутри панели');
    handle.close();
  });

  it('Escape закрывает только верхнюю (последнюю открытую) панель', async () => {
    resetBody();
    const p = await popover();
    const mk = (): ReturnType<PopoverModule['openPopover']> =>
      p.openPopover({
        anchor: { element: elem('span') },
        content: { title: 't', body: elem('div') },
      });
    const first = mk();
    const second = mk();
    keymap.dispatchKeyEvent({
      key: 'Escape',
      preventDefault: () => undefined,
    } as unknown as KeyboardEvent);
    assert.equal(mounted(second.element as unknown as ShimElement), false, 'верхняя закрыта');
    assert.equal(mounted(first.element as unknown as ShimElement), true, 'нижняя осталась');
    first.close();
  });

  it('клик вне панели закрывает её, клик внутри — нет', async () => {
    resetBody();
    const p = await popover();
    const content = elem('div');
    const handle = p.openPopover({
      anchor: { element: elem('span') },
      content: { title: 't', body: content },
    });
    doc.fire('pointerdown', { target: content });
    assert.equal(
      mounted(handle.element as unknown as ShimElement),
      true,
      'клик внутри не закрывает',
    );
    doc.fire('pointerdown', { target: new ShimElement('span') });
    assert.equal(mounted(handle.element as unknown as ShimElement), false, 'клик вне закрывает');
  });

  it('closeOnOutsideClick: false — клик вне панель не закрывает', async () => {
    resetBody();
    const p = await popover();
    const handle = p.openPopover({
      anchor: { element: elem('span') },
      content: { title: 't', body: elem('div') },
      closeOnOutsideClick: false,
    });
    doc.fire('pointerdown', { target: new ShimElement('span') });
    assert.equal(mounted(handle.element as unknown as ShimElement), true);
    handle.close();
  });

  it('прокрутка вне панели закрывает её, прокрутка внутри — нет', async () => {
    resetBody();
    const p = await popover();
    const content = elem('div');
    const handle = p.openPopover({
      anchor: { element: elem('span') },
      content: { title: 't', body: content },
    });
    doc.fire('scroll', { target: content });
    assert.equal(
      mounted(handle.element as unknown as ShimElement),
      true,
      'прокрутка внутри панели',
    );
    doc.fire('scroll', { target: new ShimElement('section') });
    assert.equal(mounted(handle.element as unknown as ShimElement), false, 'прокрутка вне панели');
  });

  it('close() идемпотентен, onClose вызывается один раз', async () => {
    resetBody();
    const p = await popover();
    let closed = 0;
    const handle = p.openPopover({
      anchor: { element: elem('span') },
      content: { title: 't', body: elem('div') },
      onClose: () => {
        closed += 1;
      },
    });
    handle.close();
    handle.close();
    assert.equal(closed, 1);
    assert.equal(mounted(handle.element as unknown as ShimElement), false);
  });
});
