/**
 * Юнит-тесты поиска в поле комментария (0.12.1, задача 045f98db, ТП1):
 * `editor/text-search.ts` (чистые преобразования) и `editor/comment-search.ts`
 * (контекст сочетаний панели). DOM-shimmed, как соседние тесты модулей поля.
 *
 * Проверяются контракты:
 *  - поиск обычной подстроки (регистр не важен, вхождения не перекрываются);
 *  - склейка текста просмотра и отображение совпадений на узлы, включая
 *    вхождение, перешагнувшее границу инлайн-узла, и запрет «протекания»
 *    через блочные контейнеры;
 *  - исключение виджетов wiki-ссылок из поиска (требование d72ea6eb);
 *  - маршрутизация F3/Shift+F3/Enter/Shift+Enter/Escape/Ctrl+F/Ctrl+H активной
 *    панели через контекст `comment-search` диспетчера `lib/keymap.ts`.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import type { CommentSearchKeys } from '../src/renderer/editor/comment-search.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Устанавливает шим DOM, достаточный для импорта модулей поля. */
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
  win.innerWidth = 1024;
  win.innerHeight = 768;
}

type TextSearch = typeof import('../src/renderer/editor/text-search.js');
type CommentSearch = typeof import('../src/renderer/editor/comment-search.js');
type Keymap = typeof import('../src/renderer/lib/keymap.js');

let textSearch: TextSearch;
let commentSearch: CommentSearch;
let keymap: Keymap;

function keyEvent(init: Record<string, unknown>): any {
  const event: any = {
    key: init['key'] ?? '',
    code: init['code'] ?? '',
    ctrlKey: init['ctrlKey'] ?? false,
    altKey: init['altKey'] ?? false,
    shiftKey: init['shiftKey'] ?? false,
    metaKey: init['metaKey'] ?? false,
    repeat: false,
    defaultPrevented: false,
    target: null,
    preventDefault(): void {
      event.defaultPrevented = true;
    },
  };
  return event;
}

describe('поиск по тексту (editor/text-search.ts)', () => {
  beforeEach(async () => {
    installShim();
    textSearch = (await import('../src/renderer/editor/text-search.js')) as TextSearch;
  });

  it('находит все неперекрывающиеся вхождения без учёта регистра', () => {
    assert.deepEqual(textSearch.findMatches('AaAa', 'aa'), [
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ]);
    assert.deepEqual(textSearch.findMatches('foo bar foo', 'FOO'), [
      { from: 0, to: 3 },
      { from: 8, to: 11 },
    ]);
    assert.deepEqual(textSearch.findMatches('абв абв', 'АБВ'), [
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ]);
  });

  it('пустой запрос и отсутствие вхождений дают пустой список', () => {
    assert.deepEqual(textSearch.findMatches('текст', ''), []);
    assert.deepEqual(textSearch.findMatches('текст', 'нет'), []);
  });

  it('регистр учитывается при caseSensitive', () => {
    assert.deepEqual(textSearch.findMatches('Aa', 'a', true), [{ from: 1, to: 2 }]);
  });
});

describe('карта текста просмотра (editor/text-search.ts)', () => {
  beforeEach(async () => {
    installShim();
    textSearch = (await import('../src/renderer/editor/text-search.js')) as TextSearch;
  });

  it('склеивает инлайн-узлы одного блока и находит вхождение на стыке', () => {
    const map = textSearch.buildSearchTextMap([
      { id: 0, text: 'foo', block: 1 },
      { id: 1, text: 'bar', block: 1 },
    ]);
    assert.equal(map.text, 'foobar');
    assert.deepEqual(textSearch.mapMatches(map, 'oob'), [
      { from: 1, to: 4, start: { id: 0, offset: 1 }, end: { id: 1, offset: 1 } },
    ]);
  });

  it('не «протекает» через границу блоков', () => {
    const map = textSearch.buildSearchTextMap([
      { id: 0, text: 'foo', block: 0 },
      { id: 1, text: 'bar', block: 1 },
    ]);
    assert.equal(map.text, 'foo\nbar');
    assert.deepEqual(textSearch.mapMatches(map, 'oob'), []);
    assert.deepEqual(textSearch.mapMatches(map, 'bar'), [
      { from: 4, to: 7, start: { id: 1, offset: 0 }, end: { id: 1, offset: 3 } },
    ]);
  });

  it('пустые сегменты не создают разделителя', () => {
    const map = textSearch.buildSearchTextMap([
      { id: 0, text: 'foo', block: 0 },
      { id: 1, text: '', block: 0 },
      { id: 2, text: 'bar', block: 0 },
    ]);
    assert.equal(map.text, 'foobar');
  });
});

describe('исключения поиска просмотра (editor/comment-search.ts)', () => {
  beforeEach(async () => {
    installShim();
    commentSearch = (await import('../src/renderer/editor/comment-search.js')) as CommentSearch;
  });

  it('виджеты wiki-ссылок и служебные теги исключены', () => {
    const wiki = new ShimElement('span');
    wiki.className = 'wiki-link';
    assert.equal(commentSearch.isExcludedSearchElement(wiki as unknown as Element), true);

    const missing = new ShimElement('span');
    missing.className = 'wiki-link-missing';
    assert.equal(commentSearch.isExcludedSearchElement(missing as unknown as Element), true);

    const byId = new ShimElement('span');
    byId.setAttribute('data-wiki-id', '00000000-0000-0000-0000-000000000000');
    assert.equal(commentSearch.isExcludedSearchElement(byId as unknown as Element), true);

    const script = new ShimElement('script');
    assert.equal(commentSearch.isExcludedSearchElement(script as unknown as Element), true);

    const paragraph = new ShimElement('p');
    paragraph.className = 'comment-view';
    assert.equal(commentSearch.isExcludedSearchElement(paragraph as unknown as Element), false);
  });
});

describe('контекст сочетаний панели поиска (editor/comment-search.ts)', () => {
  beforeEach(async () => {
    installShim();
    keymap = (await import('../src/renderer/lib/keymap.js')) as Keymap;
    keymap.keymapInternals.reset();
    commentSearch = (await import('../src/renderer/editor/comment-search.js')) as CommentSearch;
  });

  function fakeKeys(): { calls: string[]; api: CommentSearchKeys } {
    const calls: string[] = [];
    const api: CommentSearchKeys = {
      focusFind: () => {
        calls.push('find');
      },
      openReplace: () => {
        calls.push('replace');
      },
      next: () => {
        calls.push('next');
        return true;
      },
      previous: () => {
        calls.push('previous');
        return true;
      },
      close: () => {
        calls.push('close');
      },
    };
    return { calls, api };
  }

  it('F3/Shift+F3/Enter/Shift+Enter/Escape маршрутизируются панели', () => {
    const { calls, api } = fakeKeys();
    commentSearch.enterCommentSearchKeys(api);

    const f3 = keyEvent({ key: 'F3', code: 'F3' });
    assert.equal(keymap.dispatchKeyEvent(f3 as KeyboardEvent), true);
    const shiftF3 = keyEvent({ key: 'F3', code: 'F3', shiftKey: true });
    assert.equal(keymap.dispatchKeyEvent(shiftF3 as KeyboardEvent), true);
    const enter = keyEvent({ key: 'Enter', code: 'Enter' });
    assert.equal(keymap.dispatchKeyEvent(enter as KeyboardEvent), true);
    const shiftEnter = keyEvent({ key: 'Enter', code: 'Enter', shiftKey: true });
    assert.equal(keymap.dispatchKeyEvent(shiftEnter as KeyboardEvent), true);
    const escape = keyEvent({ key: 'Escape', code: 'Escape' });
    assert.equal(keymap.dispatchKeyEvent(escape as KeyboardEvent), true);

    assert.deepEqual(calls, ['next', 'previous', 'next', 'previous', 'close']);

    commentSearch.leaveCommentSearchKeys();
    const noContext = keyEvent({ key: 'F3', code: 'F3' });
    assert.equal(keymap.dispatchKeyEvent(noContext as KeyboardEvent), false);
  });

  it('Ctrl+F и Ctrl+H в панели не уходят в поле', () => {
    const { calls, api } = fakeKeys();
    commentSearch.enterCommentSearchKeys(api);

    const ctrlF = keyEvent({ key: 'f', code: 'KeyF', ctrlKey: true });
    assert.equal(keymap.dispatchKeyEvent(ctrlF as KeyboardEvent), true);
    const ctrlH = keyEvent({ key: 'h', code: 'KeyH', ctrlKey: true });
    assert.equal(keymap.dispatchKeyEvent(ctrlH as KeyboardEvent), true);

    assert.deepEqual(calls, ['find', 'replace']);
    commentSearch.leaveCommentSearchKeys();
  });
});

/* ------------------------------------------------------------------ *
 * Поиск и замена в правке — по ИСХОДНИКУ markdown (ошибка 3eb4d1d5).
 * ------------------------------------------------------------------ */

type Field = typeof import('../src/renderer/editor/markdown-field.js');
type I18n = typeof import('../src/renderer/lib/i18n.js');

/** Редактор-заглушка: держит markdown-исходник и записывает правки. */
interface FakeEditor {
  getValue(): string;
  setSearchHighlight(highlight: unknown): void;
  selectMatch(from: number, to: number): void;
  applyEdit(edit: {
    changes:
      | { from: number; to: number; insert: string }
      | ReadonlyArray<{ from: number; to: number; insert: string }>;
  }): void;
  readonly highlightCalls: unknown[];
}

function fakeEditor(initial: string): FakeEditor {
  let value = initial;
  const highlightCalls: unknown[] = [];
  return {
    getValue: () => value,
    setSearchHighlight: (highlight) => {
      highlightCalls.push(highlight);
    },
    selectMatch: () => undefined,
    applyEdit: (edit) => {
      const changes = Array.isArray(edit.changes) ? [...edit.changes] : [edit.changes];
      // Правки применяются справа налево, чтобы смещения не сдвигались.
      changes.sort((a, b) => b.from - a.from);
      for (const change of changes) {
        value = value.slice(0, change.from) + change.insert + value.slice(change.to);
      }
    },
    get highlightCalls() {
      return highlightCalls;
    },
  };
}

describe('панель поиска/замены в правке идёт по исходнику markdown (3eb4d1d5)', () => {
  beforeEach(() => {
    installShim();
  });

  async function panel(editor: FakeEditor | null, editing: boolean): Promise<{
    controller: CommentSearchShape;
    findInput: ShimElement;
    replaceInput: ShimElement;
    replaceButton: ShimElement;
    replaceAllButton: ShimElement;
    countLabel: ShimElement;
    replaceRow: ShimElement;
  }> {
    const commentSearch = (await import(
      '../src/renderer/editor/comment-search.js'
    )) as CommentSearch;
    const root = new ShimElement('div');
    const view = new ShimElement('div');
    root.append(view);
    const controller = commentSearch.createCommentSearch({
      root: root as unknown as HTMLElement,
      view: view as unknown as HTMLElement,
      getEditor: () => editor as unknown as import('../src/renderer/editor/md-editor.js').MdEditor | null,
      isEditing: () => editing,
      restoreFocus: () => undefined,
      highlightPort: { set: () => undefined, clear: () => undefined },
    });
    root.append(controller.element as unknown as ShimElement);
    const inputs = controller.element.querySelectorAll('input');
    const buttons = controller.element.querySelectorAll('button');
    return {
      controller: controller as unknown as CommentSearchShape,
      findInput: inputs[0]!,
      replaceInput: inputs[1]!,
      replaceButton: buttons[3]!,
      replaceAllButton: buttons[4]!,
      countLabel: controller.element.querySelector('.md-field-search__count')!,
      replaceRow: controller.element.querySelectorAll('.md-field-search__row')[1]!,
    };
  }

  /** Минимум панели, нужный тесту. */
  interface CommentSearchShape {
    element: ShimElement;
    open(mode: 'find' | 'replace'): void;
    isOpen(): boolean;
  }

  it('в правке находит текст, видимый только в исходнике (HTML-комментарий)', async () => {
    const source = '# Заголовок\n\n<!-- служебный -->\n\nПовтор поиск поиск.';
    // Просмотр HTML-комментарий скрывает — в его тексте «служебный» нет.
    const editor = fakeEditor(source);
    const p = await panel(editor, true);
    p.controller.open('replace');

    p.findInput.value = 'служебный';
    p.findInput.emit('input');

    const i18n = (await import('../src/renderer/lib/i18n.js')) as I18n;
    assert.equal(p.countLabel.textContent, i18n.t('comment.search.count', [1, 1]));
    assert.equal(p.replaceButton.disabled, false, 'замена доступна в правке');
    assert.equal(p.replaceAllButton.disabled, false);

    p.replaceInput.value = 'ОК';
    p.replaceButton.click();
    assert.match(editor.getValue(), /<!-- ОК -->/);
    assert.doesNotMatch(editor.getValue(), /служебный/);
  });

  it('«Заменить всё» меняет все вхождения исходника', async () => {
    const editor = fakeEditor('поиск и ПОИСК, поиск.');
    const p = await panel(editor, true);
    p.controller.open('replace');
    p.findInput.value = 'поиск';
    p.findInput.emit('input');
    p.replaceInput.value = 'найдено';
    p.replaceAllButton.click();
    assert.equal(editor.getValue(), 'найдено и найдено, найдено.');
  });

  it('в просмотре строка замены не показывается, режим деградирует к поиску', async () => {
    const p = await panel(null, false);
    p.controller.open('replace');
    assert.equal(p.replaceRow.hidden, true);
    assert.equal(p.replaceButton.disabled, true);
    assert.equal(p.replaceAllButton.disabled, true);
  });
});

/* ------------------------------------------------------------------ *
 * Коммит правки при уходе фокуса (ошибка 3eb4d1d5).
 * ------------------------------------------------------------------ */

describe('коммит правки при уходе фокуса из редактора (3eb4d1d5)', () => {
  beforeEach(() => {
    installShim();
  });

  it('фокус на собственном элементе поля (панель поиска) не коммитит правку', async () => {
    const field = (await import(
      '../src/renderer/editor/markdown-field.js'
    )) as Field;
    const root = new ShimElement('div');
    const panelInput = new ShimElement('input');
    const toolbar = new ShimElement('div');
    const outside = new ShimElement('div');
    root.append(panelInput, toolbar);

    assert.equal(
      field.editorBlurCommits(root as unknown as Node, panelInput as unknown as EventTarget),
      false,
      'фокус в панели поиска — поле остаётся в правке',
    );
    assert.equal(
      field.editorBlurCommits(root as unknown as Node, toolbar as unknown as EventTarget),
      false,
      'фокус в тулбаре — поле остаётся в правке',
    );
    assert.equal(
      field.editorBlurCommits(root as unknown as Node, outside as unknown as EventTarget),
      true,
      'фокус ушёл наружу — правка коммитится',
    );
    assert.equal(
      field.editorBlurCommits(root as unknown as Node, null),
      true,
      'программный blur (relatedTarget = null) — правка коммитится',
    );
  });
});
