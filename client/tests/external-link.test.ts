/**
 * Unit tests for `editor/external-link.ts` (ошибка 37458cbc): клик по ВНЕШНЕЙ
 * ссылке (`http:`/`https:`/`mailto:`) в просмотре не должен уводить окно ETN —
 * обработчик гасит событие и открывает адрес через `window.open(url, '_blank')`,
 * который доходит до главного процесса (`setWindowOpenHandler` → системный
 * браузер). Внутренние адреса (wiki-ссылки, `#anchor`, относительные) и
 * клики с модификаторами не перехватываются.
 *
 * jsdom в проекте нет (конвенция соседних тестов): минимальный DOM-шим
 * (`./dom-shim.js`) плюс подмена глобалей `document`/`HTMLAnchorElement`/
 * `window` ДО импорта модуля — слушатель навешивается в
 * `initExternalLinkNavigation()`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** Синтетическое событие клика, как его видит обработчик модуля. */
interface ClickEventLike {
  target: unknown;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

const clickListeners: Array<(event: ClickEventLike) => void> = [];
const opened: Array<{ url: string; target: string }> = [];

// Глобали ставим ДО динамического импорта: модуль трогает `document` в init,
// `HTMLAnchorElement` — при проверке цели клика, `window.open` — при открытии.
(globalThis as { document?: unknown }).document = {
  addEventListener: (type: string, fn: (event: ClickEventLike) => void): void => {
    if (type === 'click') clickListeners.push(fn);
  },
};
(globalThis as { HTMLAnchorElement?: unknown }).HTMLAnchorElement = ShimElement;
(globalThis as { window?: unknown }).window = {
  open: (url: string, target?: string): null => {
    opened.push({ url, target: target ?? '' });
    return null;
  },
};

const { initExternalLinkNavigation, externalLinkInternals } = await import(
  '../src/renderer/editor/external-link.js'
);
initExternalLinkNavigation();

const handler = clickListeners[0]!;

/** Минимальный якорь с href и (опционально) классом. */
function makeAnchor(href: string, className = ''): ShimElement {
  const anchor = new ShimElement('a');
  if (className !== '') anchor.className = className;
  anchor.setAttribute('href', href);
  return anchor;
}

/** Цель клика — произвольный узел, чей `closest('a[href]')` отдаёт `anchor`. */
function targetInside(anchor: ShimElement | null): unknown {
  return {
    closest: (selector: string): ShimElement | null =>
      selector === 'a[href]' ? anchor : null,
  };
}

/** Прогоняет клик через зарегистрированный обработчик; возвращает факт гашения. */
function click(target: unknown, init: Partial<ClickEventLike> = {}): boolean {
  let prevented = false;
  const event: ClickEventLike = {
    target,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: (): void => {
      prevented = true;
    },
    ...init,
  };
  handler(event);
  return prevented;
}

test('isExternalHref: только http/https/mailto (любой регистр)', () => {
  const { isExternalHref } = externalLinkInternals;
  for (const href of ['https://e.com', 'http://e.com', 'HTTPS://E.COM', 'mailto:a@b.c']) {
    assert.equal(isExternalHref(href), true, href);
  }
  for (const href of ['etnimg://c/a.png', '#pub-1', 'foo/bar', 'file:///c:/a.txt', 'javascript:alert(1)']) {
    assert.equal(isExternalHref(href), false, href);
  }
});

test('клик по внешней ссылке гасит событие и открывает её через window.open(_blank)', () => {
  const before = opened.length;
  const prevented = click(targetInside(makeAnchor('https://example.com/a?x=1')));
  assert.equal(prevented, true, 'событие обязано быть погашено — окно ETN не должно уйти на адрес');
  assert.deepEqual(opened.slice(before), [{ url: 'https://example.com/a?x=1', target: '_blank' }]);
});

test('mailto-ссылка открывается так же', () => {
  const before = opened.length;
  assert.equal(click(targetInside(makeAnchor('mailto:a@b.c'))), true);
  assert.deepEqual(opened.slice(before), [{ url: 'mailto:a@b.c', target: '_blank' }]);
});

test('wiki-ссылка не перехватывается (у неё свой обработчик)', () => {
  const before = opened.length;
  assert.equal(click(targetInside(makeAnchor('https://e.com', 'wiki-link'))), false);
  assert.equal(opened.length, before);
});

test('внутренние адреса (hash, относительный) не перехватываются', () => {
  const before = opened.length;
  assert.equal(click(targetInside(makeAnchor('#pub-1'))), false);
  assert.equal(click(targetInside(makeAnchor('foo'))), false);
  assert.equal(opened.length, before);
});

test('клик с модификатором и средней кнопкой уходит платформе (setWindowOpenHandler)', () => {
  const before = opened.length;
  assert.equal(click(targetInside(makeAnchor('https://e.com')), { ctrlKey: true }), false);
  assert.equal(click(targetInside(makeAnchor('https://e.com')), { metaKey: true }), false);
  assert.equal(click(targetInside(makeAnchor('https://e.com')), { shiftKey: true }), false);
  assert.equal(click(targetInside(makeAnchor('https://e.com')), { button: 1 }), false);
  assert.equal(opened.length, before);
});

test('уже погашенное событие и цель вне ссылки игнорируются', () => {
  const before = opened.length;
  assert.equal(
    click(targetInside(makeAnchor('https://e.com')), { defaultPrevented: true }),
    false,
  );
  assert.equal(click(targetInside(null)), false);
  assert.equal(opened.length, before);
});
