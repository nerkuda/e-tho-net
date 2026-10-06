/**
 * Юнит-тесты сворачивания разделов комментария (0.12.1, задача 634f1412;
 * элемент интерфейса 826c4423, требования b482b36b/e04d84f7).
 *
 * Проверяются: локальное хранение состояния (localStorage, на сервер не едет),
 * разметка просмотра (индикаторы и скрытие тела), декорации live preview
 * CodeMirror 6, согласованный пропуск декораций внутри свёрнутого тела и
 * регресс-тест «на сервер не едет».
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';

import { ShimElement } from './dom-shim.js';
import { wikiLinkLanguage } from '../src/renderer/editor/wiki-link.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Устанавливает шим DOM, достаточный для импорта модуля сворачивания. */
function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    body: new ShimElement('body'),
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

/** Простое хранилище под интерфейс `Storage` (localStorage в Node недоступен). */
class FakeStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

type Module = typeof import('../src/renderer/editor/comment-collapse.js');

let mod: Module;

function installStorage(): FakeStorage {
  const storage = new FakeStorage();
  (globalThis as any).localStorage = storage;
  return storage;
}

/** Число элементов с классом (подстрока), включая вложенные. */
function countByClass(root: ShimElement, className: string): number {
  return root.findAll(className).length;
}

/** Прямые дети элемента (элементы, без текстовых узлов). */
function elementChildren(node: ShimElement): ShimElement[] {
  return node.children.filter((child) => child.tagName !== '#text');
}

describe('сворачивание разделов комментария (editor/comment-collapse.ts)', () => {
  it('чистые функции хранилища: ключ, разбор, сериализация', async () => {
    installShim();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    assert.equal(mod.commentCollapseStorageKey('net', 'comment:c1'), 'comment.collapse.net.comment:c1');
    assert.deepEqual(mod.parseCollapsedIds(null), []);
    assert.deepEqual(mod.parseCollapsedIds('не json'), []);
    assert.deepEqual(mod.parseCollapsedIds('{"a":1}'), []);
    assert.deepEqual(mod.parseCollapsedIds('["h2#1","", "n#2"]'), ['h2#1', 'n#2']);
    assert.equal(mod.serializeCollapsedIds(['n#2', 'h2#1']), '["h2#1","n#2"]');
  });

  it('состояние хранится локально по ключу «сеть + владелец» и переживает переоткрытие', async () => {
    installShim();
    const storage = installStorage();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    const first = mod.createCommentCollapseState('net', 'comment:c1');
    assert.equal(first.isCollapsed('h2#1'), false);
    first.setCollapsed('h2#1', true);
    first.setCollapsed('n#2', true);
    assert.equal(storage.getItem('comment.collapse.net.comment:c1'), '["h2#1","n#2"]');

    // Переоткрытие поля (новое состояние) видит прежние свёртки.
    const reopened = mod.createCommentCollapseState('net', 'comment:c1');
    assert.equal(reopened.isCollapsed('h2#1'), true);
    assert.equal(reopened.isCollapsed('n#2'), true);

    // Другой владелец — своё состояние.
    const other = mod.createCommentCollapseState('net', 'comment:c2');
    assert.equal(other.isCollapsed('h2#1'), false);

    // Без владельца состояние живёт только в памяти: записи в хранилище нет.
    const before = storage.length;
    const anonymous = mod.createCommentCollapseState('net', undefined);
    anonymous.setCollapsed('h2#1', true);
    assert.equal(anonymous.isCollapsed('h2#1'), true);
    assert.equal(storage.length, before, 'без владельца в localStorage не пишем');
  });

  it('просмотр: индикаторы у заголовков и вложенных блоков, скрытие тела', async () => {
    installShim();
    installStorage();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    const view = new ShimElement('div');
    const h2 = new ShimElement('h2');
    const p1 = new ShimElement('p');
    const h3 = new ShimElement('h3');
    const p2 = new ShimElement('p');
    const h2b = new ShimElement('h2');
    const p3 = new ShimElement('p');
    view.append(h2, p1, h3, p2, h2b, p3);

    // Вложенный список: внешний `ul` верхнего уровня, внутренний — в `li`.
    const outer = new ShimElement('ul');
    const li = new ShimElement('li');
    const inner = new ShimElement('ul');
    const innerLi = new ShimElement('li');
    inner.append(innerLi);
    li.append(inner);
    outer.append(li);
    view.append(outer);

    const state = mod.createCommentCollapseState('net', 'comment:c1');
    mod.decorateCommentView(view as unknown as HTMLElement, state);

    // 3 заголовка с непустым телом + 1 вложенный список.
    assert.equal(countByClass(view, mod.COLLAPSE_TOGGLE_CLASS), 4);
    assert.equal(elementChildren(h2)[0]?.className.includes(mod.COLLAPSE_TOGGLE_CLASS), true);
    assert.equal(elementChildren(inner)[0]?.className.includes(mod.COLLAPSE_TOGGLE_CLASS), true);

    // Идемпотентность: повторный вызов не плодит индикаторы.
    mod.decorateCommentView(view as unknown as HTMLElement, state);
    assert.equal(countByClass(view, mod.COLLAPSE_TOGGLE_CLASS), 4);

    // Свёрнутый H2#1 скрывает p1, h3, p2 — но не h2b и не вложенный список.
    state.setCollapsed('h2#1', true);
    mod.decorateCommentView(view as unknown as HTMLElement, state);
    assert.equal(p1.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), true);
    assert.equal(h3.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), true);
    assert.equal(p2.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), true);
    assert.equal(h2b.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), false);
    assert.equal(innerLi.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), false);

    // Свёрнутый вложенный блок скрывает своё содержимое.
    state.setCollapsed('n#1', true);
    mod.decorateCommentView(view as unknown as HTMLElement, state);
    assert.equal(innerLi.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), true);
    assert.equal(outer.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), false);
  });

  it('редактор: декорации заголовков и вложенных блоков, пропуск скрытых md-live', async () => {
    installShim();
    installStorage();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;
    const { livePreview } = (await import('../src/renderer/editor/md-live.js')) as typeof import(
      '../src/renderer/editor/md-live.js'
    );

    const doc = '## Раздел\n\nтекст\n\n### Подраздел\n\nподтекст\n\n## Второй\n\nещё\n';
    const makeState = (): EditorState => {
      const collapse = mod.createCommentCollapseState('net', undefined);
      return EditorState.create({
        doc,
        extensions: [
          markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] }),
          livePreview,
          mod.commentCollapseExtension(collapse),
        ],
      });
    };

    const field = mod.commentCollapseInternals.collapseDecoField;
    const counts = (state: EditorState): { widgets: number; replaces: number } => {
      let widgets = 0;
      let replaces = 0;
      const it = state.field(field).deco.iter();
      while (it.value !== null) {
        const spec = (it.value as unknown as { spec?: { widget?: unknown; block?: boolean } }).spec ?? {};
        if (spec.widget !== undefined) widgets += 1;
        if (spec.block === true) replaces += 1;
        it.next();
      }
      return { widgets, replaces };
    };

    const sections = mod.commentCollapseInternals.collectSections(makeState());
    assert.deepEqual(
      sections.map((s) => s.id),
      ['h2#1', 'h3#1', 'h2#2'],
    );

    const open = makeState();
    assert.deepEqual(counts(open), { widgets: 3, replaces: 0 });

    // Свёрнут H2#1: его тело — блок-замена, вложенный H3 внутри не строится.
    const collapsed = open.update({
      effects: mod.setCollapseEffect.of({ id: 'h2#1', collapsed: true }),
    }).state;
    assert.deepEqual(counts(collapsed), { widgets: 2, replaces: 1 });

    // Точка скрытого диапазона распознаётся (для пропуска в md-live).
    const bodyPos = doc.indexOf('подтекст');
    assert.equal(mod.isCollapsedHiddenAt(collapsed, bodyPos), true);
    assert.equal(mod.isCollapsedHiddenAt(collapsed, doc.indexOf('ещё')), false);

    // md-live не строит декорации внутри свёрнутого тела: класса H3 нет.
    const hasH3 = (state: EditorState): boolean => {
      let found = false;
      for (const it = state.field(livePreview).iter(); it.value !== null; it.next()) {
        const spec = (it.value as unknown as { spec?: { class?: string } }).spec ?? {};
        if (spec.class === 'cm-md-h3') found = true;
      }
      return found;
    };
    assert.equal(hasH3(open), true, 'развёрнутый H3 размечен md-live');
    assert.equal(hasH3(collapsed), false, 'свёрнутый H3 md-live пропускает');
  });

  it('редактор: свёрнутый вложенный список скрывает своё тело', async () => {
    installShim();
    installStorage();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    const doc = '## Список\n\n- один\n  - вложенный\n- два\n';
    const collapse = mod.createCommentCollapseState('net', undefined);
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] }),
        mod.commentCollapseExtension(collapse),
      ],
    });

    assert.equal(mod.isCollapsedHiddenAt(state, doc.indexOf('вложенный')), false);
    const collapsed = state.update({
      effects: mod.setCollapseEffect.of({ id: 'n#1', collapsed: true }),
    }).state;
    assert.equal(mod.isCollapsedHiddenAt(collapsed, doc.indexOf('вложенный')), true);
  });

  it('регресс: состояние не едет на сервер', async () => {
    installShim();
    installStorage();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    const source = fs.readFileSync(
      fileURLToPath(new URL('../src/renderer/editor/comment-collapse.ts', import.meta.url)),
      'utf8',
    );
    // Модуль не тянет сетевые/серверные зависимости и не ходит в API.
    assert.equal(/from\s+'[^']*(?:lib\/etn|app)\.js'/.test(source), false, 'нет импорта etn/app');
    assert.equal(/\bfetch\s*\(/.test(source), false, 'нет сетевых вызовов');
    assert.equal(/\betn\s*\./.test(source), false, 'нет обращений к API etn.*');

    // Переключение раздела пишет только в localStorage.
    const storage = installStorage();
    const state = mod.createCommentCollapseState('net', 'comment:c1');
    state.setCollapsed('h2#1', true);
    assert.equal(storage.getItem('comment.collapse.net.comment:c1'), '["h2#1"]');
  });
});
