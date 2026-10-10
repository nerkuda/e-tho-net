/**
 * История последних выбранных иконок диалога (задача 0fc95a2b,
 * `client/src/renderer/editor/recent-icons.ts`).
 *
 * Покрывается чистая логика (ключ storage, parse, merge «в начало без дублей,
 * кэп 10») и рендер строки над вкладками (виды ячеек, порядок, ленивый резолв
 * вложения с пропуском неразрешимого). DOM — минимальный шим, storage —
 * Map-подстановка (конвенция `recent-values.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** Простейшее Storage-хранилище (только используемые методы). */
class ShimStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function installDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
  };
}

installDom();

const {
  RECENT_ICONS_MAX,
  recentIconsStorageKey,
  recentIconKey,
  parseRecentIcons,
  mergeRecentIcon,
  loadRecentIcons,
  recordRecentIcon,
  renderRecentIcons,
} = await import('../src/renderer/editor/recent-icons.js');

const EMOJI = { kind: 'emoji', icon: '😀', color: null } as const;
const STAR = { kind: 'icon', icon: 'star', color: '#ff0000' } as const;
const URL_IMG = { kind: 'image-url', icon: 'https://example.test/a.png', color: null } as const;
const ATT = { kind: 'image-attachment', attachmentId: 'att-1', color: null } as const;

describe('recent-icons: чистая логика (0fc95a2b)', () => {
  it('ключ storage — в разрезе пользователя', () => {
    assert.equal(recentIconsStorageKey('user-1'), 'icons.recent.user-1');
    assert.equal(recentIconsStorageKey('user-2'), 'icons.recent.user-2');
  });

  it('идентичность записи различает вид, значение и цвет значка', () => {
    assert.notEqual(recentIconKey(EMOJI), recentIconKey(STAR));
    assert.notEqual(recentIconKey(STAR), recentIconKey({ kind: 'icon', icon: 'star', color: null }));
    assert.notEqual(recentIconKey(ATT), recentIconKey({ kind: 'image-attachment', attachmentId: 'att-2', color: null }));
  });

  it('parse: null/чужой JSON/не-массив → [], мусор отбрасывается, кэп 10', () => {
    assert.deepEqual(parseRecentIcons(null), []);
    assert.deepEqual(parseRecentIcons('not json'), []);
    assert.deepEqual(parseRecentIcons('{"a":1}'), []);
    assert.deepEqual(parseRecentIcons('[{"kind":"bogus"},1,null,{"kind":"emoji","icon":""}]'), []);
    const many = JSON.stringify(
      Array.from({ length: 12 }, (_v, i) => ({ kind: 'emoji', icon: `e${i}`, color: null })),
    );
    assert.equal(parseRecentIcons(many).length, RECENT_ICONS_MAX);
  });

  it('parse: дубли схлопываются (первое вхождение остаётся)', () => {
    const raw = JSON.stringify([EMOJI, EMOJI, STAR]);
    assert.deepEqual(parseRecentIcons(raw), [EMOJI, STAR]);
  });

  it('merge: свежая запись встаёт первой; повтор поднимается без дублей; кэп 10', () => {
    assert.deepEqual(mergeRecentIcon([STAR], EMOJI), [EMOJI, STAR]);
    assert.deepEqual(mergeRecentIcon([EMOJI, STAR], STAR), [STAR, EMOJI]);
    let history: any[] = [];
    for (let i = 1; i <= 11; i += 1) {
      history = mergeRecentIcon(history, { kind: 'emoji', icon: `e${i}`, color: null });
    }
    assert.equal(history.length, RECENT_ICONS_MAX);
    assert.equal(history[0].icon, 'e11', 'свежая запись первая');
    assert.ok(!history.some((e) => e.icon === 'e1'), 'самая старая выпадает');
    // Прежний массив не мутируется.
    const prev = [EMOJI];
    mergeRecentIcon(prev, STAR);
    assert.deepEqual(prev, [EMOJI]);
  });

  it('record/load: roundtrip и изоляция по пользователю', () => {
    const previous = (globalThis as any).localStorage;
    (globalThis as any).localStorage = new ShimStorage();
    try {
      recordRecentIcon('u1', EMOJI);
      recordRecentIcon('u1', STAR);
      recordRecentIcon('u1', EMOJI);
      assert.deepEqual(loadRecentIcons('u1'), [EMOJI, STAR]);
      assert.deepEqual(loadRecentIcons('u2'), [], 'история другого пользователя пуста');
    } finally {
      (globalThis as any).localStorage = previous;
    }
  });
});

/** Разрешает микрозадачи (ленивый резолв вложения). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('recent-icons: рендер строки над вкладками (0fc95a2b)', () => {
  it('рисует ячейки всех видов в порядке истории', async () => {
    const host = new ShimElement('div');
    const libraryCalls: Array<{ name: string; color: string | null }> = [];
    renderRecentIcons(host as unknown as HTMLElement, [EMOJI, STAR, URL_IMG], {
      renderLibrary: (_cell, name, color) => libraryCalls.push({ name, color }),
      resolveAttachment: () => Promise.resolve(null),
      onPick: () => undefined,
      labelFor: () => 'label',
    });
    const cells = host.children.filter((c) => c.classList.contains('recent-icon-cell'));
    assert.equal(cells.length, 3, 'три ячейки по числу записей');
    assert.equal(cells[0]!.textContent, '😀', 'эмодзи — текстом');
    assert.equal(libraryCalls.length, 1, 'значок рисует инъектируемый фасад');
    assert.equal(libraryCalls[0]!.name, 'star');
    assert.equal(libraryCalls[0]!.color, '#ff0000', 'цвет значка передан');
    assert.equal(cells[2]!.children[0]!.tagName, 'img', 'URL-картинка — <img>');
    assert.equal(cells[2]!.children[0]!.src, URL_IMG.icon);
  });

  it('вложение резолвится лениво; клик отдаёт запись и превью', async () => {
    const host = new ShimElement('div');
    const picked: Array<{ entry: any; preview?: string }> = [];
    renderRecentIcons(host as unknown as HTMLElement, [ATT], {
      renderLibrary: () => undefined,
      resolveAttachment: () => Promise.resolve('data:image/png;base64,AAAA'),
      onPick: (entry, preview) => picked.push({ entry, preview }),
      labelFor: () => 'label',
    });
    const cell = host.children[0]!;
    assert.ok(cell.classList.contains('recent-icon-cell-loading'), 'до резолва ячейка помечена');
    await flush();
    assert.ok(!cell.classList.contains('recent-icon-cell-loading'), 'после резолва пометка снята');
    assert.equal(cell.children[0]!.tagName, 'img');
    assert.equal(cell.children[0]!.src, 'data:image/png;base64,AAAA');
    cell.emit('click');
    assert.deepEqual(picked, [{ entry: ATT, preview: 'data:image/png;base64,AAAA' }]);
  });

  it('неразрешимое вложение пропускается при показе (ячейка убирается)', async () => {
    const host = new ShimElement('div');
    renderRecentIcons(host as unknown as HTMLElement, [ATT, EMOJI], {
      renderLibrary: () => undefined,
      resolveAttachment: () => Promise.resolve(null),
      onPick: () => undefined,
      labelFor: () => 'label',
    });
    assert.equal(host.children.length, 2);
    await flush();
    const cells = host.children.filter((c) => c.classList.contains('recent-icon-cell'));
    assert.equal(cells.length, 1, 'неразрешимое вложение убрано из строки');
    assert.equal(cells[0]!.textContent, '😀');
  });

  it('пустая история — строка скрыта (класс hidden)', () => {
    const host = new ShimElement('div');
    renderRecentIcons(host as unknown as HTMLElement, [], {
      renderLibrary: () => undefined,
      resolveAttachment: () => Promise.resolve(null),
      onPick: () => undefined,
      labelFor: () => 'label',
    });
    assert.ok(host.classList.contains('hidden'));
    assert.equal(host.children.length, 0);
  });
});
