/**
 * Покраска pub-ссылок резолвером просмотра (0.11.1, задача 3275fd8d,
 * элемент интерфейса d421c5d8, требование 7f583ef9).
 *
 * Серверный `renderMarkdown('[[#pub:<uuid>]]')` не резолвит публикации (ADR
 * 7168009e) и отдаёт legacy name-форму: текст span'а без алиаса РАВЕН сырому
 * `#pub:<uuid>`. Резолвер обязан это распознать (сверить с `data-wiki-target`)
 * и подставить название найденной публикации или «удалена» для отсутствующей,
 * сохранив явный алиас. Проверяется на РЕАЛЬНОМ HTML рендерера.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderMarkdown } from '@etn/markdown';

import { ShimElement } from './dom-shim.js';
import {
  __testing,
  paintPublicationLinksInDom,
  WIKI_LINK_PUB_ATTR,
} from '../src/renderer/editor/wiki-link-resolver.js';

const NET = 'c4f9a3b2-1111-2222-3333-444455556666';
const PUB = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';

/** Span из реального серверного HTML (`<span …>…</span>`). */
function spanFromServerHtml(html: string): ShimElement {
  const match = /<span([^>]*)>([\s\S]*?)<\/span>/.exec(html);
  assert.ok(match !== null, `span не найден в HTML: ${html}`);
  const span = new ShimElement('span');
  const attrs = match[1]!;
  for (const attr of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
    span.setAttribute(attr[1]!, attr[2]!);
  }
  span.textContent = match[2]!;
  return span;
}

function rootWith(span: ShimElement): ShimElement {
  const root = new ShimElement('div');
  root.appendChild(span);
  return root;
}

describe('покраска pub-ссылок на реальном серверном HTML', () => {
  it('без алиаса, публикация найдена → название', () => {
    const html = renderMarkdown(`см. [[#pub:${PUB}]]`);
    assert.ok(html.includes(`data-wiki-target="#pub:${PUB}"`), html);
    const span = spanFromServerHtml(html);
    assert.equal(span.textContent, `#pub:${PUB}`, 'сервер кладёт сырой target');

    const root = rootWith(span);
    __testing.pubCache.set(`${NET}:${PUB}`, { title: 'Название публикации', exists: true });
    paintPublicationLinksInDom(root as unknown as HTMLElement, NET);

    assert.equal(span.textContent, 'Название публикации', 'сырой #pub:… заменён названием');
    assert.equal(span.getAttribute(WIKI_LINK_PUB_ATTR), PUB, 'ссылка помечена для клика');
    assert.ok(!span.classList.contains('wiki-link-deleted'), 'найденная — без пометки');
  });

  it('без алиаса, публикация удалена → «удалена»', () => {
    const html = renderMarkdown(`[[#pub:${PUB}]]`);
    const span = spanFromServerHtml(html);
    const root = rootWith(span);
    __testing.pubCache.set(`${NET}:${PUB}`, { title: '', exists: false });
    paintPublicationLinksInDom(root as unknown as HTMLElement, NET);

    assert.equal(span.textContent, 'удалена');
    assert.ok(span.classList.contains('wiki-link-deleted'), 'удалённая помечена');
  });

  it('явный алиас сохраняется; отсутствующая — алиас + пометка', () => {
    const html = renderMarkdown(`[[#pub:${PUB}|Моя подпись]]`);
    assert.ok(html.includes(`data-wiki-target="#pub:${PUB}"`), html);
    const span = spanFromServerHtml(html);
    assert.equal(span.textContent, 'Моя подпись');

    const root = rootWith(span);
    __testing.pubCache.set(`${NET}:${PUB}`, { title: 'Название', exists: true });
    paintPublicationLinksInDom(root as unknown as HTMLElement, NET);
    assert.equal(span.textContent, 'Моя подпись', 'алиас не перетирается названием');

    __testing.pubCache.set(`${NET}:${PUB}`, { title: '', exists: false });
    paintPublicationLinksInDom(root as unknown as HTMLElement, NET);
    assert.equal(span.textContent, 'Моя подпись', 'алиас остаётся и у удалённой');
    assert.ok(span.classList.contains('wiki-link-deleted'));
  });
});
