/**
 * Юнит-тесты сворачивания разделов комментария (0.12.1, задача 634f1412;
 * элемент интерфейса 826c4423, требования b482b36b/e04d84f7).
 *
 * Проверяются: локальное хранение состояния (localStorage, на сервер не едет),
 * разметка просмотра (индикаторы в полосе-гаттере, скрытие тела), маркеры
 * гаттера live preview CodeMirror 6, согласованный пропуск декораций внутри
 * свёрнутого тела, независимость сворачивания в правке блока трансклюзии
 * (ошибка 4204e34c) и регресс-тест «на сервер не едет».
 *
 * Модель индикатора (0.12.1, ошибки ce8e9f67/6007a6ec): индикатор живёт в
 * зарезервированной полосе-гаттере и НЕ участвует в потоке текста (правка —
 * CM6-гаттер, просмотр — полоса `.md-collapse-rail` в хосте). Тесты
 * фиксируют, что индикатора нет среди детей строки, а маркеры лежат в полосе;
 * якорь вложенного блока — РОДИТЕЛЬСКИЙ пункт (ошибка 6007a6ec).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';

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

/** Маркер-индикатор раздела по id (все маркеры хоста лежат в полосе-гаттере). */
function markerById(root: ShimElement, id: string): ShimElement | undefined {
  return root
    .findAll(mod.COLLAPSE_TOGGLE_CLASS)
    .find((btn) => btn.dataset['collapseId'] === id);
}

/** Полоса-гаттер хоста просмотра. */
function rail(root: ShimElement): ShimElement | undefined {
  return root.findAll(mod.COLLAPSE_RAIL_CLASS)[0];
}

/** Число маркеров в гаттере редактора (поле декораций). */
function gutterMarkerCount(state: EditorState): number {
  const field = mod.commentCollapseInternals.collapseDecoField;
  let count = 0;
  const it = state.field(field).markers.iter();
  while (it.value !== null) {
    count += 1;
    it.next();
  }
  return count;
}

/** Минимальный CM6-«view» для toggleCollapseAtCaret: состояние + dispatch. */
interface FakeView {
  state: EditorState;
  dispatch(spec: TransactionSpec): void;
}

/** Создаёт фейковый view (реальный EditorView в проекте недоступен — нет jsdom). */
function fakeView(state: EditorState): EditorView {
  const view: FakeView = {
    state,
    dispatch(spec) {
      view.state = view.state.update(spec).state;
    },
  };
  return view as unknown as EditorView;
}

/** Ставит каретку на позицию (для команд «под кареткой»). */
function caretAt(view: EditorView, pos: number): void {
  (view as unknown as FakeView).dispatch({ selection: { anchor: pos } });
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

    // Разные вертикальные позиции родительского пункта и вложенного блока:
    // маркер вложенного блока должен встать на строку РОДИТЕЛЯ (6007a6ec).
    li.rect = { left: 0, top: 40, right: 100, bottom: 60, width: 100, height: 20 };
    inner.rect = { left: 0, top: 60, right: 100, bottom: 80, width: 100, height: 20 };

    const state = mod.createCommentCollapseState('net', 'comment:c1');
    mod.decorateCommentView(view as unknown as HTMLElement, state);

    // 3 заголовка с непустым телом + 1 вложенный список.
    assert.equal(countByClass(view, mod.COLLAPSE_TOGGLE_CLASS), 4);

    // Гашение потока текста (ошибка ce8e9f67): хост резервирует полосу, а
    // маркеры лежат в ней, а НЕ первым ребёнком строки (текст вправо не едет).
    assert.equal(view.classList.contains(mod.COLLAPSE_HOST_CLASS), true);
    const hostRail = rail(view);
    assert.ok(hostRail, 'полоса-гаттер создана в хосте');
    assert.equal(countByClass(hostRail as ShimElement, mod.COLLAPSE_TOGGLE_CLASS), 4);
    assert.equal(
      elementChildren(h2).some((child) => child.classList.contains(mod.COLLAPSE_TOGGLE_CLASS)),
      false,
      'маркер не лежит в строке заголовка (текст вправо не сдвигается)',
    );
    assert.equal(markerById(view, 'h2#1')?.parent, hostRail);
    assert.equal(markerById(view, 'n#1')?.parent, hostRail);
    assert.equal(
      markerById(view, 'n#1')?.style.top,
      '40px',
      'маркер вложенного блока — на строке родительского пункта, а не вложенного',
    );

    // Идемпотентность: повторный вызов не плодит индикаторы и полосы.
    mod.decorateCommentView(view as unknown as HTMLElement, state);
    assert.equal(countByClass(view, mod.COLLAPSE_TOGGLE_CLASS), 4);
    assert.equal(countByClass(view, mod.COLLAPSE_RAIL_CLASS), 1);

    // Свёрнутый H2#1 скрывает p1, h3, p2 — но не h2b и не вложенный список.
    state.setCollapsed('h2#1', true);
    mod.decorateCommentView(view as unknown as HTMLElement, state);
    assert.equal(p1.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), true);
    assert.equal(h3.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), true);
    assert.equal(p2.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), true);
    assert.equal(h2b.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), false);
    assert.equal(inner.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), false);
    // Маркер скрытого раздела (h3#1, якорь внутри тела h2#1) прячется.
    assert.equal(
      markerById(view, 'h3#1')?.classList.contains(mod.COLLAPSE_HIDDEN_CLASS),
      true,
      'индикатор вложенного заголовка скрыт вместе с телом родителя',
    );

    // Свёрнутый вложенный блок (якорь — родительский пункт `li`) скрывает ВЕСЬ
    // вложенный список, оставляя родительский пункт видимым (ошибка 6007a6ec).
    state.setCollapsed('h2#1', false);
    state.setCollapsed('n#1', true);
    mod.decorateCommentView(view as unknown as HTMLElement, state);
    assert.equal(inner.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), true);
    assert.equal(outer.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), false);
    assert.equal(li.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), false, 'родительский пункт виден');
  });

  it('просмотр: несколько вложенных блоков в одном пункте → один маркер (6007a6ec)', async () => {
    installShim();
    installStorage();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    // Пункт `- один` держит ДВА вложенных блока: под-список и цитату.
    const view = new ShimElement('div');
    const outer = new ShimElement('ul');
    const li = new ShimElement('li');
    const inner = new ShimElement('ul');
    const innerLi = new ShimElement('li');
    inner.append(innerLi);
    const quote = new ShimElement('blockquote');
    const quoteP = new ShimElement('p');
    quote.append(quoteP);
    li.append(inner, quote);
    outer.append(li);
    view.append(outer);

    const state = mod.createCommentCollapseState('net', 'comment:c1');
    mod.decorateCommentView(view as unknown as HTMLElement, state);

    // Ровно ОДИН маркер на родительском пункте — без коллизии/перекрытия.
    assert.equal(countByClass(view, mod.COLLAPSE_TOGGLE_CLASS), 1);
    const marker = markerById(view, 'n#1');
    assert.ok(marker, 'маркер n#1 существует');
    assert.equal(marker?.parent, rail(view), 'маркер в полосе-гаттере');

    // Единственный маркер сворачивает ОБА вложенных блока, пункт виден.
    state.setCollapsed('n#1', true);
    mod.decorateCommentView(view as unknown as HTMLElement, state);
    assert.equal(inner.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), true, 'под-список скрыт');
    assert.equal(quote.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), true, 'цитата скрыта');
    assert.equal(li.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), false, 'пункт виден');
    assert.equal(outer.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), false);
  });

  it('редактор: несколько вложенных блоков в одном пункте → один маркер (6007a6ec)', async () => {
    installShim();
    installStorage();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    const doc = '- один\n  - вложенный\n  > цитата в пункте\n';
    const collapse = mod.createCommentCollapseState('net', undefined);
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] }),
        mod.commentCollapseExtension(collapse),
      ],
    });

    // Один раздел n#1 на родительский пункт; тело — объединение обоих блоков.
    const sections = mod.commentCollapseInternals.collectSections(state);
    assert.deepEqual(
      sections.map((s) => s.id),
      ['n#1'],
      'два вложенных блока одного пункта слиты в один раздел',
    );
    const section = sections[0];
    assert.equal(section?.anchorFrom, doc.indexOf('- один'), 'якорь — строка родителя');
    assert.equal(section?.bodyFrom, doc.indexOf('  - вложенный'), 'тело — с под-списка');
    assert.equal(
      section?.bodyTo,
      doc.indexOf('цитата в пункте') + 'цитата в пункте'.length,
      'тело — до конца цитаты (объединение)',
    );

    // Один маркер гаттера (без коллизии).
    assert.equal(gutterMarkerCount(state), 1);

    // Сворачивание скрывает ОБА вложенных блока, родительскую строку — нет.
    const collapsed = state.update({
      effects: mod.setCollapseEffect.of({ id: 'n#1', collapsed: true }),
    }).state;
    assert.equal(mod.isCollapsedHiddenAt(collapsed, doc.indexOf('вложенный')), true);
    assert.equal(mod.isCollapsedHiddenAt(collapsed, doc.indexOf('цитата')), true);
    assert.equal(mod.isCollapsedHiddenAt(collapsed, doc.indexOf('- один')), false);
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
      const state = EditorState.create({
        doc,
        extensions: [
          markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] }),
          livePreview,
          mod.commentCollapseExtension(collapse),
        ],
      });
      // Полный разбор до конца документа: `collectSections` читает `syntaxTree`,
      // который без явного `ensureSyntaxTree` может вернуть неполное дерево —
      // тогда разделы теряются (флейк `c543ea79`: 1 раздел вместо 3). Прогон
      // разбора до `doc.length` изолирует тест от тайминга/порядка парсера.
      ensureSyntaxTree(state, state.doc.length, 5_000);
      return state;
    };

    const field = mod.commentCollapseInternals.collapseDecoField;
    const replaces = (state: EditorState): number => {
      let count = 0;
      const it = state.field(field).deco.iter();
      while (it.value !== null) {
        const spec = (it.value as unknown as { spec?: { block?: boolean } }).spec ?? {};
        if (spec.block === true) count += 1;
        it.next();
      }
      return count;
    };

    const sections = mod.commentCollapseInternals.collectSections(makeState());
    assert.deepEqual(
      sections.map((s) => s.id),
      ['h2#1', 'h3#1', 'h2#2'],
    );

    const open = makeState();
    // Индикаторы — маркеры гаттера, а НЕ inline-виджеты в тексте (ce8e9f67):
    // в декорациях содержимого нет ни одного виджета.
    assert.equal(gutterMarkerCount(open), 3);
    assert.equal(replaces(open), 0);

    // Свёрнут H2#1: его тело — блок-замена, вложенный H3 внутри не строится.
    const collapsed = open.update({
      effects: mod.setCollapseEffect.of({ id: 'h2#1', collapsed: true }),
    }).state;
    assert.equal(gutterMarkerCount(collapsed), 2);
    assert.equal(replaces(collapsed), 1);

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

    // Индикатор вложенного блока — у строки РОДИТЕЛЬСКОГО пункта (`- один`),
    // а не у первой строки вложенного списка (ошибка 6007a6ec).
    const listSection = mod.commentCollapseInternals
      .collectSections(state)
      .find((s) => s.id === 'n#1');
    assert.ok(listSection, 'раздел вложенного списка собран');
    assert.equal(
      listSection.anchorFrom,
      doc.indexOf('- один'),
      'якорь — строка родительского пункта',
    );
    assert.equal(
      listSection.bodyFrom,
      doc.indexOf('  - вложенный'),
      'скрываемое тело начинается со строки вложенного списка',
    );

    assert.equal(mod.isCollapsedHiddenAt(state, doc.indexOf('вложенный')), false);
    const collapsed = state.update({
      effects: mod.setCollapseEffect.of({ id: 'n#1', collapsed: true }),
    }).state;
    assert.equal(mod.isCollapsedHiddenAt(collapsed, doc.indexOf('вложенный')), true);
    // Родительская строка не скрывается — прячется только вложенный блок.
    assert.equal(mod.isCollapsedHiddenAt(collapsed, doc.indexOf('- один')), false);
  });

  it('инвариант: id разделов совпадают в просмотре и правке при теле из HTML-комментария', async () => {
    installShim();
    installStorage();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    // Тело заголовка A — только HTML-комментарий: @etn/markdown не эмитит для
    // него узла, в просмотре у A видимого тела нет, в правке — есть строка.
    const doc = '## A\n<!-- hidden -->\n## B\nx\n';
    const editor = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] }),
        mod.commentCollapseExtension(mod.createCommentCollapseState('net', undefined)),
      ],
    });
    assert.deepEqual(
      mod.commentCollapseInternals.collectSections(editor).map((s) => s.id),
      ['h2#1', 'h2#2'],
      'в правке A = h2#1, B = h2#2',
    );

    // Просмотр: реальный HTML без узла под комментарий — h2 A, h2 B, p x.
    const view = new ShimElement('div');
    const h2a = new ShimElement('h2');
    const h2b = new ShimElement('h2');
    const p = new ShimElement('p');
    view.append(h2a, h2b, p);

    const state = mod.createCommentCollapseState('net', undefined);
    mod.decorateCommentView(view as unknown as HTMLElement, state);
    const toggles = view.findAll(mod.COLLAPSE_TOGGLE_CLASS);
    assert.equal(toggles.length, 1, 'у A сворачивать нечего — индикатор только у B');
    assert.equal(toggles[0]?.dataset['collapseId'], 'h2#2', 'B = h2#2, как и в правке');

    // Свёрнутость h2#2 из правки прячет тело B и в просмотре.
    state.setCollapsed('h2#2', true);
    mod.decorateCommentView(view as unknown as HTMLElement, state);
    assert.equal(p.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), true);
  });

  it('трансклюзии: ключ владельца «контейнер + путь вставки» разделяет состояние', async () => {
    installShim();
    const storage = installStorage();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    // Пустой путь — собственные разделы поля (владелец не расширяется).
    assert.equal(mod.transclusionCollapseOwnerKey('comment:cA', []), 'comment:cA');
    // Прямая вставка Б в А и вложенная C-в-Б-в-А — разные ключи (требование e04d84f7).
    assert.equal(mod.transclusionCollapseOwnerKey('comment:cA', ['B']), 'comment:cA|#B');
    assert.equal(mod.transclusionCollapseOwnerKey('comment:cA', ['B', 'C']), 'comment:cA|#B#C');

    // Свёртка раздела в Б, вставленном в А, живёт под ключом А+путь…
    const inA = mod.createCommentCollapseState(
      'net',
      mod.transclusionCollapseOwnerKey('comment:cA', ['B']),
    );
    inA.setCollapsed('h2#1', true);
    assert.equal(storage.getItem('comment.collapse.net.comment:cA|#B'), '["h2#1"]');

    // …не влияет на просмотр Б вне А (другой владелец)…
    const outside = mod.createCommentCollapseState('net', 'comment:cB');
    assert.equal(outside.isCollapsed('h2#1'), false);

    // …не влияет на вложенный путь C-в-Б-в-А…
    const nested = mod.createCommentCollapseState(
      'net',
      mod.transclusionCollapseOwnerKey('comment:cA', ['B', 'C']),
    );
    assert.equal(nested.isCollapsed('h2#1'), false);

    // …и переживает переоткрытие поля (новое состояние видит свёртку).
    const reopened = mod.createCommentCollapseState(
      'net',
      mod.transclusionCollapseOwnerKey('comment:cA', ['B']),
    );
    assert.equal(reopened.isCollapsed('h2#1'), true);
  });

  it('просмотр: сворачивание в трансклюзиях — своё состояние и нумерация на путь вставки', async () => {
    installShim();
    installStorage();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    // Дерево: собственный H2 поля, блок B (H2+тело) и вложенный в него блок C.
    const view = new ShimElement('div');
    const ownH2 = new ShimElement('h2');
    const ownP = new ShimElement('p');
    view.append(ownH2, ownP);

    const bBlock = new ShimElement('div', 'md-transclusion');
    bBlock.dataset.transclusionSource = 'B';
    const bH2 = new ShimElement('h2');
    const bP = new ShimElement('p');
    bBlock.append(bH2, bP);

    const cBlock = new ShimElement('div', 'md-transclusion');
    cBlock.dataset.transclusionSource = 'C';
    const cH2 = new ShimElement('h2');
    const cP = new ShimElement('p');
    cBlock.append(cH2, cP);

    view.append(bBlock);
    // Блок C вставлен внутрь блока B (путь вставки B→C).
    bBlock.append(cBlock);

    const paths: string[] = [];
    const stateB = mod.createCommentCollapseState(
      'net',
      mod.transclusionCollapseOwnerKey('comment:cA', ['B']),
    );
    const stateC = mod.createCommentCollapseState(
      'net',
      mod.transclusionCollapseOwnerKey('comment:cA', ['B', 'C']),
    );
    const ownState = mod.createCommentCollapseState('net', 'comment:cA');
    const factoryFor = (path: readonly string[]): ReturnType<Module['createCommentCollapseState']> => {
      paths.push(path.join('#'));
      if (path.length === 1) return stateB;
      return stateC;
    };

    ownState.setCollapsed('h2#1', true);
    mod.decorateCommentView(view as unknown as HTMLElement, ownState, factoryFor);

    // Блоки трансклюзий декорированы как отдельные области (пути B и B#C).
    assert.deepEqual(paths.sort(), ['B', 'B#C']);
    // Маркеры всех областей лежат в ОДНОЙ полосе-гаттере хоста (одна колонка,
    // ошибка ce8e9f67) и различаются ключом области (путь вставки).
    assert.ok(rail(view), 'полоса-гаттер хоста');
    const markers = view.findAll(mod.COLLAPSE_TOGGLE_CLASS);
    assert.deepEqual(
      markers
        .map((m) => `${m.dataset['collapseScope']}:${m.dataset['collapseId']}`)
        .sort(),
      [':h2#1', 'B#C:h2#1', 'B:h2#1'],
      'нумерация начинается заново в каждой области; маркеры — в полосе хоста',
    );
    for (const m of markers) assert.equal(m.parent, rail(view), 'маркер лежит в полосе');

    // Свёртка раздела в C прячет тело C, не трогая тело B.
    stateC.setCollapsed('h2#1', true);
    mod.decorateCommentView(view as unknown as HTMLElement, ownState, factoryFor);
    assert.equal(cP.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), true, 'тело C скрыто');
    assert.equal(bP.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), false, 'тело B не тронуто');

    // Свёртка того же id (h2#1) в B прячет тело B, не трогая тело C.
    stateC.setCollapsed('h2#1', false);
    stateB.setCollapsed('h2#1', true);
    mod.decorateCommentView(view as unknown as HTMLElement, ownState, factoryFor);
    assert.equal(bP.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), true, 'тело B скрыто');
    assert.equal(cP.classList.contains(mod.COLLAPSE_HIDDEN_CLASS), false, 'тело C не тронуто');
  });

  it('команды Ctrl+Up/Down: сворачивание/разворачивание раздела под кареткой (558cac34)', async () => {
    installShim();
    installStorage();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    const doc = '## Раздел\n\nтекст\n\n### Подраздел\n\nподтекст\n\n## Второй\n\nещё\n';
    const makeState = (): EditorState =>
      EditorState.create({
        doc,
        extensions: [
          markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] }),
          mod.commentCollapseExtension(mod.createCommentCollapseState('net', undefined)),
        ],
      });

    // Каретка на строке заголовка H2#1 — Ctrl+Up сворачивает его тело.
    const view = fakeView(makeState());
    caretAt(view, doc.indexOf('## Раздел') + 2);
    const body = doc.indexOf('текст\n');
    assert.equal(mod.toggleCollapseAtCaret(view, 'fold'), true, 'раздел под кареткой найден');
    assert.equal(mod.isCollapsedHiddenAt(view.state, body), true, 'Ctrl+Up свернул раздел');
    // Идемпотентность: повторный Ctrl+Up оставляет раздел свёрнутым.
    assert.equal(mod.toggleCollapseAtCaret(view, 'fold'), true);
    assert.equal(mod.isCollapsedHiddenAt(view.state, body), true, 'повторный fold — no-op по состоянию');
    // Ctrl+Down разворачивает.
    assert.equal(mod.toggleCollapseAtCaret(view, 'unfold'), true);
    assert.equal(mod.isCollapsedHiddenAt(view.state, body), false, 'Ctrl+Down развернул раздел');

    // Каретка внутри тела — сворачивается самый ВЛОЖЕННЫЙ раздел (H3#1, не H2#1).
    caretAt(view, doc.indexOf('подтекст'));
    assert.equal(mod.toggleCollapseAtCaret(view, 'fold'), true);
    assert.equal(mod.isCollapsedHiddenAt(view.state, doc.indexOf('подтекст')), true, 'H3#1 свёрнут');
    assert.equal(
      mod.isCollapsedHiddenAt(view.state, doc.indexOf('текст\n')),
      false,
      'внешний H2#1 не тронут — выбран вложенный раздел',
    );

    // `toggle` переключает то же состояние.
    const tView = fakeView(makeState());
    caretAt(tView, doc.indexOf('## Второй') + 2);
    assert.equal(mod.toggleCollapseAtCaret(tView, 'toggle'), true);
    assert.equal(mod.isCollapsedHiddenAt(tView.state, doc.indexOf('ещё')), true);
    assert.equal(mod.toggleCollapseAtCaret(tView, 'toggle'), true);
    assert.equal(mod.isCollapsedHiddenAt(tView.state, doc.indexOf('ещё')), false);
  });

  it('no-op, когда под кареткой нет сворачиваемого раздела или расширения нет (558cac34)', async () => {
    installShim();
    installStorage();
    mod = (await import('../src/renderer/editor/comment-collapse.js')) as Module;

    // Текст без заголовков/вложенных блоков — сворачивать нечего.
    const plain = EditorState.create({
      doc: 'просто текст без разметки\n',
      extensions: [
        markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] }),
        mod.commentCollapseExtension(mod.createCommentCollapseState('net', undefined)),
      ],
    });
    assert.equal(mod.toggleCollapseAtCaret(fakeView(plain), 'fold'), false);
    assert.equal(mod.toggleCollapseAtCaret(fakeView(plain), 'unfold'), false);

    // Расширение сворачивания к редактору не подключено (поле другого вида).
    const bare = EditorState.create({
      doc: '## Заголовок\nтело\n',
      extensions: [markdown({ base: markdownLanguage, extensions: [wikiLinkLanguage()] })],
    });
    assert.equal(
      mod.toggleCollapseAtCaret(fakeView(bare), 'fold'),
      false,
      'без расширения сворачивания — no-op, не падение',
    );
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
