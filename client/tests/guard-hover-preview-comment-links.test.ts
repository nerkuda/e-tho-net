/**
 * Сторож и юнит-проверки разметки ссылок в превью ПОСТОЯННОГО комментария
 * (ошибка e08159c1).
 *
 * Симптом: Ctrl+наведение на облачко открывает попап постоянного комментария,
 * но wiki-ссылка внутри попапа не становится вложенным триггером — у неё нет
 * `data-hp-kind`. Причина: `resolveCommentContent` (`kind: 'comment'`) рендерит
 * серверный `body_html` в `.comment-view` и зовёт `resolveWikiLinksInDom`, но не
 * зовёт `wireCommentLinksInDom` — единственный проход, который проставляет
 * `data-hp-kind` (`wiki-thought`, `wiki-cross-network`, `wiki-legacy-name`,
 * `link`). Остальные резолверы, рендерящие `body_html`
 * (`resolveWikiThoughtContent`, `resolveWikiLegacyNameContent`,
 * `resolveCrossNetworkThoughtContent`), wire зовут — поэтому вложенный
 * предпросмотр там работает.
 *
 * Поведенческий сквозной сценарий (реальный клик/наведение в Electron) —
 * GUI-стенд `ui-probe.e08159c1-hover-comment-links.scenario.json`; здесь
 * фиксируется проводка разметки и её свойства. Поведенческий DOM-юнит на
 * шиме (`tests/dom-shim.ts`) невозможен: `innerHTML` там — строковое поле,
 * HTML не разбирается на узлы (намеренное расхождение шима), поэтому
 * отрендеренный сервером комментарий в тестовый DOM не переезжает. Проверки
 * `wireCommentLinksInDom` ниже подают узлы напрямую.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { WIKI_LINK_CLASS, WIKI_LINK_ID_ATTR } from '@etn/markdown';

import { wireCommentLinksInDom } from '../src/renderer/lib/hover-preview.js';
import { ShimElement } from './dom-shim.js';

const HOVER_PREVIEW = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'renderer', 'lib', 'hover-preview.ts'),
  'utf8',
);

/** Тело функции верхнего уровня по имени (закрывающая скобка в нулевой колонке). */
function functionBody(source: string, declaration: RegExp): string {
  const match = declaration.exec(source);
  assert.ok(match !== null, `тело функции найдено: ${declaration}`);
  return match[1] ?? '';
}

/** Тело без построчных комментариев — пояснение рядом может упоминать имя. */
function codeOnly(body: string): string {
  return body.replace(/\/\/[^\n]*/g, '');
}

/** Позиция вызова в теле без комментариев или -1. */
function callIndex(body: string, call: string): number {
  return codeOnly(body).indexOf(call);
}

const RENDER_BODY_HTML = /renderHtml\(view, permanent\.body_html\);/;

describe('сторож: превью постоянного комментария размечает ссылки (e08159c1)', () => {
  it('resolveCommentContent зовёт wireCommentLinksInDom(view)', () => {
    const body = functionBody(
      HOVER_PREVIEW,
      /async function resolveCommentContent\(trigger: HTMLElement\): Promise<HoverPreviewContent \| null> \{([\s\S]*?)\n\}/,
    );
    assert.ok(body !== '', 'тело resolveCommentContent найдено');
    assert.match(
      codeOnly(body),
      /wireCommentLinksInDom\(view\);/,
      'без разметки у ссылок нет data-hp-kind — вложенный предпросмотр из попапа постоянного комментария не открывается',
    );
  });

  it('разметка идёт ПОСЛЕ вставки отрендеренного HTML и на том же view', () => {
    const body = functionBody(
      HOVER_PREVIEW,
      /async function resolveCommentContent\(trigger: HTMLElement\): Promise<HoverPreviewContent \| null> \{([\s\S]*?)\n\}/,
    );
    const renderAt = RENDER_BODY_HTML.exec(body)?.index ?? -1;
    const wireAt = callIndex(body, 'wireCommentLinksInDom(view);');
    assert.ok(renderAt >= 0, 'renderHtml(view, permanent.body_html) найден');
    assert.ok(wireAt > renderAt, 'wire вызывается после вставки HTML: до неё ссылок в view ещё нет');
    // Ровно один вызов на один рендер: второй проход на том же view не нужен и
    // означал бы копию общего пути (wire идемпотентен, но дублировать не надо).
    assert.equal(codeOnly(body).split('wireCommentLinksInDom(view);').length - 1, 1);
  });

  it('все резолверы, рендерящие body_html, размечают ссылки', () => {
    const resolvers: Array<[string, RegExp]> = [
      [
        'resolveWikiThoughtContent',
        /async function resolveWikiThoughtContent\(trigger: HTMLElement\): Promise<HoverPreviewContent \| null> \{([\s\S]*?)\n\}/,
      ],
      [
        'resolveWikiLegacyNameContent',
        /async function resolveWikiLegacyNameContent\(trigger: HTMLElement\): Promise<HoverPreviewContent \| null> \{([\s\S]*?)\n\}/,
      ],
      [
        'resolveCrossNetworkThoughtContent',
        /async function resolveCrossNetworkThoughtContent\(([\s\S]*?)\n\}/,
      ],
    ];
    for (const [name, declaration] of resolvers) {
      const body = functionBody(HOVER_PREVIEW, declaration);
      assert.match(codeOnly(body), /wireCommentLinksInDom\(view\);/, `${name} размечает ссылки`);
    }
  });
});

describe('wireCommentLinksInDom: разметка и идемпотентность (e08159c1)', () => {
  /** Набор узлов, который отдаёт поддельный корень по тому же селектору, что
   *  ищет wire. Шим не умеет составные `tag.class[attr]` и `:not([…])`,
   *  поэтому поиск подменяем — проверяем саму разметку, а не движок селекторов. */
  function fakeRoot(parts: {
    idLinks?: ShimElement[];
    legacyLinks?: ShimElement[];
    anchors?: ShimElement[];
  }): HTMLElement {
    const root = new ShimElement('div');
    root.querySelectorAll = ((selector: string) => {
      if (selector === `span.${WIKI_LINK_CLASS}[${WIKI_LINK_ID_ATTR}]`) return parts.idLinks ?? [];
      if (selector === `span.${WIKI_LINK_CLASS}:not([${WIKI_LINK_ID_ATTR}])`) return parts.legacyLinks ?? [];
      if (selector === 'a[href]') return parts.anchors ?? [];
      return [];
    }) as ShimElement['querySelectorAll'];
    // Шим — структурная замена DOM-элемента, а не полный HTMLElement.
    return root as unknown as HTMLElement;
  }

  function wikiSpan(attrs: Record<string, string>, text = 'ссылка'): ShimElement {
    const span = new ShimElement('span', WIKI_LINK_CLASS, text);
    for (const [name, value] of Object.entries(attrs)) span.setAttribute(name, value);
    return span;
  }

  it('мыслевая ссылка своей сети → wiki-thought, чужой → wiki-cross-network', () => {
    const same = wikiSpan({ 'data-wiki-id': '11111111-1111-1111-1111-111111111111' });
    const cross = wikiSpan({
      'data-wiki-id': '22222222-2222-2222-2222-222222222222',
      'data-wiki-network': 'net-b',
    });
    wireCommentLinksInDom(fakeRoot({ idLinks: [same, cross] }));
    assert.equal(same.dataset['hpKind'], 'wiki-thought');
    assert.equal(cross.dataset['hpKind'], 'wiki-cross-network');
  });

  it('легаси-ссылка по имени → wiki-legacy-name, обычный <a href> → link', () => {
    const legacy = wikiSpan({ 'data-wiki-target': 'Имя мысли' }, 'Имя мысли');
    const anchor = new ShimElement('a', '', 'внешняя');
    anchor.setAttribute('href', 'https://example.com');
    wireCommentLinksInDom(fakeRoot({ legacyLinks: [legacy], anchors: [anchor] }));
    assert.equal(legacy.dataset['hpKind'], 'wiki-legacy-name');
    assert.equal(anchor.dataset['hpKind'], 'link');
  });

  it('<a> с картинкой не размечается — точкой владеет лупа (d0338c48)', () => {
    const anchor = new ShimElement('a');
    anchor.append(new ShimElement('img'));
    wireCommentLinksInDom(fakeRoot({ anchors: [anchor] }));
    assert.equal(anchor.dataset['hpKind'], undefined, 'картинка внутри ссылки — зона image-zoom');
  });

  it('двойной wire не плодит обработчиков и не меняет разметку', () => {
    const same = wikiSpan({ 'data-wiki-id': '33333333-3333-3333-3333-333333333333' });
    const anchor = new ShimElement('a', '', 'внешняя');
    anchor.setAttribute('href', 'https://example.com');
    const root = fakeRoot({ idLinks: [same], anchors: [anchor] });

    wireCommentLinksInDom(root);
    const kinds = JSON.stringify([same.dataset['hpKind'], anchor.dataset['hpKind']]);
    const keysAfterFirst = Object.keys(same.dataset).length;
    wireCommentLinksInDom(root);

    assert.equal(JSON.stringify([same.dataset['hpKind'], anchor.dataset['hpKind']]), kinds);
    assert.equal(Object.keys(same.dataset).length, keysAfterFirst, 'повторный проход не добавляет атрибутов');
    // wire только (пере)записывает data-атрибуты: повторный вызов не добавляет
    // слушателей, поэтому клик не может сработать дважды из-за двойной разметки.
    assert.equal(same.listeners['click']?.length ?? 0, 0);
    assert.equal(anchor.listeners['click']?.length ?? 0, 0);
  });
});
