/**
 * Снятое с документа markdown-поле не коммитит правку (ошибка ecdb2e7a).
 *
 * Симптом заказчика: после обрыва связи во время правки комментария клик по
 * ЛЮБОЙ мысли давал «a permanent comment already exists for this owner» —
 * каждый раз, хотя правки давно нет. Причина: поле, оставшееся в режиме правки
 * после сбоя записи, держало глобальный слушатель «нажатие вне» и после
 * пересборки панели (поле уже снято с документа) продолжало коммитить на
 * каждое нажатие по интерфейсу — повторяя неудачное создание.
 *
 * Контракт:
 * 1. живое поле по-прежнему коммитит правку по нажатию вне;
 * 2. поле, снятое с документа, не коммитит;
 * 3. `disposeMarkdownField` отпускает глобальные слушатели поля.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Слушатели `document` (watchOutsideTap вешает capture-pointerdown). */
const docListeners: Record<string, Array<(event: any) => void>> = {};

function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).Node = ShimElement;
  // CodeMirror различает окно и узел через `instanceof Window`.
  (globalThis as any).Window = class Window {};
  const doc = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    head: new ShimElement('head'),
    body: new ShimElement('body'),
    addEventListener: (type: string, handler: (event: any) => void) => {
      (docListeners[type] ??= []).push(handler);
    },
    removeEventListener: (type: string, handler: (event: any) => void) => {
      docListeners[type] = (docListeners[type] ?? []).filter((fn) => fn !== handler);
    },
    activeElement: null,
    querySelectorAll: () => [],
    querySelector: () => null,
    defaultView: undefined as unknown,
    // CodeMirror читает выделение и фокус у документа/узла — шиму это не нужно.
    getSelection: () => null,
    hasFocus: () => false,
    nodeType: 9,
    contains: () => false,
    createTextNode: (text: string) => {
      const node = new ShimElement('#text');
      node.textContent = text;
      return node;
    },
    createRange: () => ({
      setStart: () => undefined,
      setEnd: () => undefined,
      getClientRects: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    }),
  };
  (globalThis as any).document = doc;
  // Шим-элементы не знают своего документа, а CodeMirror читает
  // `element.ownerDocument.defaultView` и `element.getSelection` — отдаём ему
  // общий шим-документ и пустое выделение.
  (ShimElement.prototype as any).ownerDocument = doc;
  (ShimElement.prototype as any).getSelection = () => null;
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['document'] = doc;
  // Выделение документу-шиму не нужно, но CodeMirror его спрашивает.
  win['getSelection'] = () => null;
  win['etn'] = { ui: { getState: async () => null, setState: async () => undefined } };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  // Раскладки в шиме нет: замеры CodeMirror по кадрам не запускаем (иначе его
  // измерительный проход падает на отсутствии реальных Range/Observer уже
  // после конца теста).
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.getComputedStyle = () => ({ getPropertyValue: () => '' });
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  // CodeMirror 6 (режим правки) обращается к `ownerDocument.defaultView` и
  // ставит MutationObserver: в шиме их нет, реальный DOM полю в тесте не нужен.
  (globalThis as any).document.defaultView = win;
  (globalThis as any).MutationObserver = class {
    observe(): void {
      /* раскладка/мутации в шиме не наблюдаются */
    }
    disconnect(): void {
      /* no-op */
    }
    takeRecords(): unknown[] {
      return [];
    }
  };
  const ls = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
    clear: () => ls.clear(),
    key: (i: number) => [...ls.keys()][i] ?? null,
    get length() {
      return ls.size;
    },
  };
}

installShim();

const { store } = await import('../src/renderer/state.js');
store.update({ networkId: 'net-1' });

const { createMarkdownField, disposeMarkdownField, editMarkdownField } = await import(
  '../src/renderer/editor/markdown-field.js'
);

/** Нажатие «вне поля»: слушатели документа получают capture-событие. */
function tapOutside(): void {
  const target = new ShimElement('div');
  for (const handler of [...(docListeners['pointerdown'] ?? [])]) handler({ target });
}

/** Даёт отработать async-цепочке коммита (`onSave` → `showView`). */
async function settleAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Поле с обязательным коммитом: `externalChanges` делает правку «грязной». */
function buildField(saves: string[]): HTMLElement {
  return createMarkdownField({
    md: 'текст',
    html: '<p>текст</p>',
    externalChanges: () => true,
    onSave: async (md: string) => {
      saves.push(md);
      return `<p>${md}</p>`;
    },
  });
}

describe('markdown-field: снятое с документа поле не коммитит', () => {
  it('живое поле коммитит по нажатию вне, снятое — нет', async () => {
    const saves: string[] = [];
    const host = new ShimElement('div');
    const root = buildField(saves);
    (globalThis as any).document.body.append(host);
    host.append(root as unknown as ShimElement);

    editMarkdownField(root);
    assert.ok(root.classList.contains('md-field--editing'), 'поле в режиме правки');

    tapOutside();
    await settleAsync();
    assert.deepEqual(saves, ['текст'], 'живое поле коммитит (штатный путь не сломан)');

    // Панель пересобрана: поле вынуто из документа, как при смене сущности.
    editMarkdownField(root);
    assert.ok(root.classList.contains('md-field--editing'), 'правка снова открыта');
    host.remove();
    // Шим считает `isConnected` по флагу корня цепочки: снятое поддерево
    // больше не в документе.
    host.isConnected = false;

    tapOutside();
    await settleAsync();
    assert.deepEqual(saves, ['текст'], 'снятое поле НЕ повторяет запись');
  });

  it('disposeMarkdownField отпускает глобальные слушатели поля', () => {
    const root = buildField([]);
    (globalThis as any).document.body.append(root);

    editMarkdownField(root);
    const attached = docListeners['pointerdown']?.length ?? 0;
    assert.ok(attached > 0, 'на живом поле слушатель «нажатие вне» есть');

    disposeMarkdownField(root);

    assert.equal(
      docListeners['pointerdown']?.length ?? 0,
      attached - 1,
      'слушатель поля снят — зависшая правка больше не реагирует на интерфейс',
    );
  });
});
