/**
 * Сторож разметки ссылок в СТАТИЧНОМ `body_html` экранов «Дневник» и
 * «Публикации» (ошибка a42c1896).
 *
 * Симптом: серверный `body_html` вставляется общим `renderHtml`, но без
 * `wireCommentLinksInDom` — у ссылок нет `data-hp-kind`, и Ctrl+наведение не
 * открывает вложенный предпросмотр. Клик при этом работает (делегированный
 * `initWikiLinkNavigation`), поэтому дефект незаметен без живой пробы.
 *
 * Инвариант: КАЖДЫЙ рендер `body_html`/markdown-HTML на этих экранах идёт в
 * паре «renderHtml → wireCommentLinksInDom на том же узле, после вставки».
 * Сторож читает исходники (экраны тянут Electron-каркас и под Node не
 * импортируются) и проверяет: пары вызовов в каждом месте, единый общий
 * проход (импорт из `lib/hover-preview.ts`, а не своя копия), отсутствие
 * второго прохода на том же DOM. Поведение самого прохода и его
 * идемпотентность проверяются ниже на узлах шима.
 *
 * Места (карточка a42c1896):
 *  - `screens/chronicle/record-body.ts` — тело записи ленты «Дневник»;
 *  - `screens/publications/workspace.ts` — текст (`renderTextBody`), его
 *    достройка трансклюзиями (`expandTextTransclusions`), предисловие раздела
 *    (`buildBlock`), резюме (`buildTitleBlock`) и точечная правка предисловия
 *    (`patchBlockText`).
 *
 * Поведенческий сквозной сценарий (реальное Ctrl+наведение в Electron) —
 * GUI-стенд `ui-probe.a42c1896-diary-publication-links.scenario.json`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { WIKI_LINK_CLASS, WIKI_LINK_ID_ATTR } from '@etn/markdown';

import { wireCommentLinksInDom } from '../src/renderer/lib/hover-preview.js';
import { ShimElement } from './dom-shim.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(...parts: string[]): string {
  return readFileSync(resolve(RENDERER, ...parts), 'utf8');
}

const RECORD_BODY = read('screens', 'chronicle', 'record-body.ts');
const CHRONICLE = read('screens', 'chronicle', 'chronicle.ts');
const WORKSPACE = read('screens', 'publications', 'workspace.ts');

/** Код без комментариев: пояснение рядом может упоминать имя вызова. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*/gm, '');
}

/** Тело функции/метода от заголовка до закрывающей скобки баланса. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `в исходнике нет «${header}»`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `у «${header}» нет тела`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`тело «${header}» не закрыто`);
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('сторож: body_html дневника и публикаций размечает ссылки (a42c1896)', () => {
  const places: Array<{ file: string; fn: string; render: string; wire: string }> = [
    {
      file: 'chronicle/record-body.ts — тело записи ленты',
      fn: 'export function renderRecordView(',
      render: 'renderHtml(view, row.body_html);',
      wire: 'wireCommentLinksInDom(view);',
    },
    {
      file: 'publications/workspace.ts — текст (`renderTextBody`)',
      fn: 'function renderTextBody(',
      render: 'renderHtml(node, html);',
      wire: 'wireCommentLinksInDom(node);',
    },
    {
      file: 'publications/workspace.ts — достройка трансклюзий текста/резюме',
      fn: 'async function expandTextTransclusions(',
      render: 'renderHtml(node, expanded);',
      wire: 'wireCommentLinksInDom(node);',
    },
    {
      file: 'publications/workspace.ts — предисловие раздела (`buildBlock`)',
      fn: 'function buildBlock(',
      render: 'renderHtml(preamble, block.preambleHtml);',
      wire: 'wireCommentLinksInDom(preamble);',
    },
    {
      file: 'publications/workspace.ts — резюме (`buildTitleBlock`)',
      fn: 'function buildTitleBlock(',
      render: 'renderHtml(block, summaryHtml);',
      wire: 'wireCommentLinksInDom(block);',
    },
    {
      file: 'publications/workspace.ts — точечная правка предисловия',
      fn: 'function patchBlockText(',
      render: 'renderHtml(target, html);',
      wire: 'wireCommentLinksInDom(target);',
    },
  ];

  const sources = new Map<string, string>([
    ['chronicle/record-body.ts', RECORD_BODY],
    ['publications/workspace.ts', WORKSPACE],
  ]);

  for (const place of places) {
    it(`${place.file}: wire после вставки HTML, один проход на рендер`, () => {
      const source = sources.get(place.file.split(' — ')[0]!);
      assert.ok(source !== undefined, `исходник ${place.file} прочитан`);
      const body = codeOnly(functionBody(source, place.fn));
      const renderAt = body.indexOf(place.render);
      const wireAt = body.indexOf(place.wire);
      assert.ok(renderAt >= 0, `${place.fn}: рендер HTML найден`);
      assert.ok(wireAt >= 0, `${place.fn}: без разметки у ссылок нет data-hp-kind`);
      assert.ok(wireAt > renderAt, `${place.fn}: wire ПОСЛЕ вставки — до неё ссылок нет`);
      assert.equal(
        count(body, 'wireCommentLinksInDom('),
        count(body, 'renderHtml('),
        `${place.fn}: ровно один wire на каждый рендер (второй проход не нужен)`,
      );
    });
  }

  it('оба экрана используют ОБЩИЙ проход, а не свою копию разметки', () => {
    for (const [name, source] of sources) {
      assert.match(
        source,
        /import \{ wireCommentLinksInDom \} from '\.\.\/\.\.\/lib\/hover-preview\.js';/,
        `${name}: wire — из единственного модуля предпросмотра`,
      );
      assert.ok(
        !codeOnly(source).includes("dataset['hpKind']"),
        `${name}: своя разметка hpKind запрещена — только общий проход`,
      );
    }
  });

  it('каждый renderHtml в этих модулях сопровождён wire (инвариант файла)', () => {
    for (const [name, source] of sources) {
      const code = codeOnly(source);
      assert.equal(
        count(code, 'renderHtml('),
        count(code, 'wireCommentLinksInDom('),
        `${name}: новый рендер HTML обязан получить разметку ссылок`,
      );
    }
  });

  it('дневник не размечает один DOM дважды', () => {
    // Разметка живёт в `record-body` (один вызов на рендер). Экран резолвит
    // ID-формы (`resolveWikiLinksInDom`), но второй wire на том же view не
    // заводит — иначе появился бы дублирующий путь декорации.
    assert.equal(
      count(codeOnly(CHRONICLE), 'wireCommentLinksInDom('),
      0,
      'chronicle.ts не дублирует разметку: единственная точка — renderRecordView',
    );
    assert.match(
      codeOnly(CHRONICLE),
      /void resolveWikiLinksInDom\(recordView, collapseNetworkId\);/,
      'резолв ID-форм сохранён: разметка не отменяет подстановку имён',
    );
  });
});

describe('wireCommentLinksInDom: разметка и идемпотентность (a42c1896)', () => {
  /** Поддельный корень по тем же селекторам, что ищет wire (шим не разбирает
   *  составные селекторы с `:not([…])`; проверяется разметка, не движок). */
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
    return root as unknown as HTMLElement;
  }

  function wikiSpan(attrs: Record<string, string>, text = 'ссылка'): ShimElement {
    const span = new ShimElement('span', WIKI_LINK_CLASS, text);
    for (const [name, value] of Object.entries(attrs)) span.setAttribute(name, value);
    return span;
  }

  it('wiki-ссылки получают вид триггера, обычный <a href> — link', () => {
    const same = wikiSpan({ 'data-wiki-id': '11111111-1111-1111-1111-111111111111' });
    const cross = wikiSpan({
      'data-wiki-id': '22222222-2222-2222-2222-222222222222',
      'data-wiki-network': 'net-b',
    });
    const legacy = wikiSpan({ 'data-wiki-target': 'Имя мысли' }, 'Имя мысли');
    const anchor = new ShimElement('a', '', 'внешняя');
    anchor.setAttribute('href', 'https://example.com');
    wireCommentLinksInDom(
      fakeRoot({ idLinks: [same, cross], legacyLinks: [legacy], anchors: [anchor] }),
    );
    assert.equal(same.dataset['hpKind'], 'wiki-thought');
    assert.equal(cross.dataset['hpKind'], 'wiki-cross-network');
    assert.equal(legacy.dataset['hpKind'], 'wiki-legacy-name');
    assert.equal(anchor.dataset['hpKind'], 'link');
  });

  it('<a> с картинкой не размечается — точкой владеет лупа (d0338c48)', () => {
    const anchor = new ShimElement('a');
    anchor.append(new ShimElement('img'));
    wireCommentLinksInDom(fakeRoot({ anchors: [anchor] }));
    assert.equal(anchor.dataset['hpKind'], undefined, 'картинка внутри ссылки — зона image-zoom');
  });

  it('повторный wire не дублирует атрибуты и не плодит слушателей', () => {
    const same = wikiSpan({ 'data-wiki-id': '33333333-3333-3333-3333-333333333333' });
    const anchor = new ShimElement('a', '', 'внешняя');
    anchor.setAttribute('href', 'https://example.com');
    const root = fakeRoot({ idLinks: [same], anchors: [anchor] });

    wireCommentLinksInDom(root);
    const kinds = JSON.stringify([same.dataset['hpKind'], anchor.dataset['hpKind']]);
    const keysAfterFirst = Object.keys(same.dataset).length;
    wireCommentLinksInDom(root);

    assert.equal(JSON.stringify([same.dataset['hpKind'], anchor.dataset['hpKind']]), kinds);
    assert.equal(Object.keys(same.dataset).length, keysAfterFirst, 'повтор не добавляет атрибутов');
    assert.equal(same.listeners['click']?.length ?? 0, 0, 'wire не вешает обработчиков');
    assert.equal(anchor.listeners['click']?.length ?? 0, 0, 'wire не вешает обработчиков');
  });
});
