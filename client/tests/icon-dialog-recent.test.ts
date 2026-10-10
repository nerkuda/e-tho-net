/**
 * Диалог выбора иконки: строка последних иконок и «Вставить из буфера»
 * (задачи 0fc95a2b, 78eaf07a).
 *
 * Проверяется проводка адаптера поверх универсального каркаса:
 *   1. Строка последних иконок из localStorage (ключ по пользователю, здесь —
 *      `anon`) строится НАД вкладками; клик по ячейке применяет тот же выбор и
 *      при успехе закрывает диалог.
 *   2. Успешный выбор иконки записывается в историю; на неудаче — нет.
 *   3. Кнопка «Вставить из буфера» доступна по эмодзи/картинке буфера и
 *      недоступна при пустом буфере; клик применяет эмодзи из буфера.
 *
 * jsdom в проекте нет — минимальный DOM-шим (конвенция `icon-dialog-restore.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

class ShimStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  raw(key: string): string | null {
    return this.map.get(key) ?? null;
  }
}

let storage: ShimStorage;

/** Что вернуть из `system.readClipboard` (по умолчанию — пустой буфер). */
let clipboardResult: { text: string | null; imagePngDataUrl: string | null } = {
  text: null,
  imagePngDataUrl: null,
};

function installShim(): void {
  storage = new ShimStorage();
  clipboardResult = { text: null, imagePngDataUrl: null };
  const body = new ShimElement('body');
  (globalThis as any).localStorage = storage;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    etn: { system: { readClipboard: () => Promise.resolve(clipboardResult) } },
    setTimeout: (fn: () => void, ms?: number) => (globalThis as any).setTimeout(fn, ms),
    clearTimeout: (handle: any) => (globalThis as any).clearTimeout(handle),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

installShim();

const { showIconDialog } = await import('../src/renderer/editor/icon-dialog.js');
const { t } = await import('../src/renderer/lib/i18n.js');

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Последний открытый диалог (стопкой — верхний в конце). */
function lastBox(): ShimElement {
  const backdrops = body().children.filter((c) => c.classList.contains('dialog-backdrop'));
  const backdrop = backdrops[backdrops.length - 1];
  assert.ok(backdrop !== undefined, 'диалог открыт');
  return backdrop.querySelector('.dialog-box') as ShimElement;
}

function findByTag(root: ShimElement, tag: string): ShimElement[] {
  const wanted = tag.toUpperCase();
  const hits: ShimElement[] = [];
  const walk = (node: ShimElement): void => {
    for (const child of node.children) {
      if ((child.tagName ?? '').toUpperCase() === wanted) hits.push(child);
      walk(child);
    }
  };
  walk(root);
  return hits;
}

function footerBtn(label: string): ShimElement {
  const footer = lastBox().querySelector('.dialog-footer');
  assert.ok(footer !== null, 'футер диалога построен');
  const btn = findByTag(footer as ShimElement, 'BUTTON').find((b) => b.textContent === label);
  assert.ok(btn !== undefined, `кнопка «${label}» в футере`);
  return btn;
}

function dialogOpen(): boolean {
  return body().children.some((c) => c.classList.contains('dialog-backdrop'));
}

/** Открывает диалог иконки; возвращает собранные результаты `onPick`. */
function open(
  opts: { ok?: boolean } = {},
): { results: any[]; promise: Promise<boolean> } {
  const results: any[] = [];
  const ok = opts.ok ?? true;
  showIconDialog({
    current: { icon: null, kind: 'emoji', color: null },
    onPick: (result) => {
      results.push(result);
      return Promise.resolve(ok);
    },
  });
  return { results, promise: Promise.resolve(ok) };
}

describe('диалог иконки: строка последних иконок (0fc95a2b)', () => {
  beforeEach(() => installShim());

  it('история из localStorage строится над вкладками; клик применяет иконку', async () => {
    storage.setItem(
      'icons.recent.anon',
      JSON.stringify([
        { kind: 'emoji', icon: '😀', color: null },
        { kind: 'emoji', icon: '🚀', color: null },
      ]),
    );
    const { results } = open();
    const row = lastBox().querySelector('.recent-icons');
    assert.ok(row !== null, 'строка последних иконок над вкладками построена');
    const cells = row!.querySelectorAll('.recent-icon-cell');
    assert.deepEqual(
      cells.map((c) => c.textContent),
      ['😀', '🚀'],
      'порядок — свежие первыми',
    );

    cells[0]!.emit('click');
    await flush();
    assert.equal(results.length, 1, 'клик применил выбор');
    assert.deepEqual(results[0], { icon: '😀', kind: 'emoji', color: null });
    assert.equal(dialogOpen(), false, 'успех закрыл диалог');
  });

  it('пустая история — строки нет', () => {
    open();
    assert.equal(lastBox().querySelector('.recent-icons'), null);
  });

  it('успешный выбор записывается в историю; неудачный — нет', async () => {
    const success = open();
    await flush();
    const emojiCells = lastBox().querySelectorAll('.emoji-cell');
    assert.ok(emojiCells.length > 0, 'сетка эмодзи построена');
    emojiCells[0]!.emit('click');
    await flush();
    assert.equal(success.results.length, 1);
    const stored = storage.raw('icons.recent.anon');
    assert.ok(stored !== null, 'успех записал иконку в историю');
    assert.equal((JSON.parse(stored!) as any[]).length, 1);

    // Неудача — запись молчит (отдельный прогон с прежней историей).
    const before = storage.raw('icons.recent.anon');
    const fail = open({ ok: false });
    await flush();
    const failCells = lastBox().querySelectorAll('.emoji-cell');
    failCells[1]!.emit('click');
    await flush();
    assert.equal(fail.results.length, 1);
    assert.equal(storage.raw('icons.recent.anon'), before, 'неудача историю не меняет');
    assert.equal(dialogOpen(), true, 'неудача оставляет диалог открытым');
  });
});

describe('диалог иконки: «Вставить из буфера» (78eaf07a)', () => {
  beforeEach(() => installShim());

  it('пустой буфер — кнопка недоступна', async () => {
    open();
    await flush();
    assert.equal(footerBtn(t('icons.clipboard.paste')).disabled, true);
  });

  it('эмодзи в буфере — кнопка доступна и применяет её', async () => {
    clipboardResult = { text: '  😀 ', imagePngDataUrl: null };
    const { results } = open();
    await flush();
    const btn = footerBtn(t('icons.clipboard.paste'));
    assert.equal(btn.disabled, false, 'буфер с эмодзи — кнопка доступна');
    btn.emit('click');
    await flush();
    assert.deepEqual(results[0], { icon: '😀', kind: 'emoji', color: null });
    assert.equal(dialogOpen(), false, 'успех закрыл диалог');
  });

  it('не-эмодзи текст — кнопка недоступна', async () => {
    clipboardResult = { text: 'обычный текст', imagePngDataUrl: null };
    open();
    await flush();
    assert.equal(footerBtn(t('icons.clipboard.paste')).disabled, true);
  });
});
