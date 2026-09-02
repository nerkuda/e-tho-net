/**
 * Unit tests of the unified markdown renderer (task M1). Pure — no DOM, no DB.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_LENGTH,
  parseAltSize,
  renderMarkdown,
  WIKI_LINK_CLASS,
  WIKI_LINK_TARGET_ATTR,
  WIKI_LINK_ID_ATTR,
  WIKI_LINK_NETWORK_ATTR,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

test('базовые конструкции: заголовки, emphasis, списки, таблицы', () => {
  const html = renderMarkdown(
    [
      '# Заголовок',
      '',
      'Текст с **жирным**, *курсивом* и ~~зачёркиванием~~.',
      '',
      '- раз',
      '- два',
      '',
      '| А | Б |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n'),
  );
  assert.match(html, /<h1>Заголовок<\/h1>/);
  assert.match(html, /<strong>жирным<\/strong>/);
  assert.match(html, /<em>курсивом<\/em>/);
  assert.match(html, /<s>зачёркиванием<\/s>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>раз<\/li>/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>А<\/th>/);
});

test('raw HTML экранируется и не проходит насквозь', () => {
  const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;script&gt;/);
});

test('CRLF нормализуется', () => {
  assert.match(renderMarkdown('# а\r\n\r\nтекст'), /<h1>а<\/h1>/);
});

// ---------------------------------------------------------------------------
// Wiki-ссылки
// ---------------------------------------------------------------------------

test('[[имя]] рендерится как span с целевым именем и data-legacy-link', () => {
  const html = renderMarkdown('см. [[Мысль о главном]]');
  assert.ok(
    html.includes(
      `<span class="${WIKI_LINK_CLASS}" ${WIKI_LINK_TARGET_ATTR}="Мысль о главном" data-legacy-link="true">Мысль о главном</span>`,
    ),
    html,
  );
});

test('[[имя|синоним]] показывает синоним, цель — имя, маркер legacy', () => {
  const html = renderMarkdown('[[имя мысли|синоним]]');
  assert.ok(
    html.includes(
      `class="${WIKI_LINK_CLASS}" ${WIKI_LINK_TARGET_ATTR}="имя мысли" data-legacy-link="true">синоним</span>`,
    ),
    html,
  );
});

test('алиас экранируется, в т.ч. HTML-инъекция в имени', () => {
  const html = renderMarkdown('[[<b>x</b>|a"b]]');
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes(WIKI_LINK_TARGET_ATTR + '="&lt;b&gt;x&lt;/b&gt;"'));
  assert.ok(html.includes('>a&quot;b</span>'));
});

test('пробелы вокруг имени и алиаса обрезаются', () => {
  const html = renderMarkdown('[[ имя | метка ]]');
  assert.ok(html.includes(WIKI_LINK_TARGET_ATTR + '="имя"'));
  assert.ok(html.includes('>метка</span>'));
});

test('незакрытая, пустая и многострочная wiki-ссылка — обычный текст', () => {
  for (const source of ['[[незакрыто', '[[]]', '[[а\nб]]', '[[|алиас]]']) {
    assert.ok(!renderMarkdown(source).includes(WIKI_LINK_CLASS), source);
  }
});

test('[[…]] внутри code span и fenced-блока не интерпретируется', () => {
  assert.ok(renderMarkdown('`[[x]]`').includes('<code>[[x]]</code>'));
  const fenced = renderMarkdown('```\n[[x]]\n```');
  assert.ok(fenced.includes('[[x]]'));
  assert.ok(!fenced.includes(WIKI_LINK_CLASS));
});

test('[[#<uuid>]] — ID-форма, пустой body, data-wiki-id без data-wiki-network', () => {
  const id = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
  const html = renderMarkdown(`см. [[#${id}]]`);
  // span class=wiki-link с data-wiki-id, пустой body
  assert.match(html, new RegExp(`<span class="${WIKI_LINK_CLASS}"[^>]*${WIKI_LINK_ID_ATTR}="${id}"`));
  assert.match(html, new RegExp(`<span class="${WIKI_LINK_CLASS}"[^>]*${WIKI_LINK_TARGET_ATTR}="${id}"`));
  assert.ok(!html.includes(WIKI_LINK_NETWORK_ATTR + '='));
  assert.ok(!html.includes('>8e0d670e'), 'тело спана должно быть пустым, клиент заполнит');
});

test('[[#<uuid>|алиас]] — ID-форма с алиасом — клиент всё равно перезапишет body', () => {
  const id = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
  const html = renderMarkdown(`[[#${id}|мой алиас]]`);
  assert.match(html, new RegExp(`${WIKI_LINK_ID_ATTR}="${id}"`));
  // Тело пустое — клиент подтянет имя, alias не рендерим в HTML для ID-форм
  assert.ok(!html.includes('мой алиас'));
});

test('[[n:<net>#<id>]] — кросс-сеть: data-wiki-id + data-wiki-network', () => {
  const net = 'c4f9a3b2-1111-2222-3333-444455556666';
  const id = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
  const html = renderMarkdown(`[[n:${net}#${id}]]`);
  assert.match(html, new RegExp(`${WIKI_LINK_ID_ATTR}="${id}"`));
  assert.match(html, new RegExp(`${WIKI_LINK_NETWORK_ATTR}="${net}"`));
  assert.ok(!html.includes('>8e0d670e'));
});

test('[[n:<net>#<id>|alias]] — кросс-сеть с алиасом', () => {
  const net = 'c4f9a3b2-1111-2222-3333-444455556666';
  const id = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
  const html = renderMarkdown(`[[n:${net}#${id}|заметка]]`);
  assert.match(html, new RegExp(`${WIKI_LINK_ID_ATTR}="${id}"`));
  assert.match(html, new RegExp(`${WIKI_LINK_NETWORK_ATTR}="${net}"`));
  assert.ok(!html.includes('заметка'));
});

test('UUID в [[#…]] нормализуется в нижний регистр', () => {
  const idUpper = '8E0D670E-DE61-4DA7-B13E-9232CD1C6CA5';
  const idLower = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
  const html = renderMarkdown(`[[#${idUpper}]]`);
  assert.ok(html.includes(`${WIKI_LINK_ID_ATTR}="${idLower}"`));
});

test('невалидный UUID в [[#…]] — fallback на legacy name-form', () => {
  const html = renderMarkdown('[[#not-a-uuid]]');
  // Не должно быть data-wiki-id — это legacy
  assert.ok(!html.includes(WIKI_LINK_ID_ATTR + '='));
  // Target = "#not-a-uuid"
  assert.ok(html.includes(`${WIKI_LINK_TARGET_ATTR}="#not-a-uuid"`));
  // body содержит имя
  assert.ok(html.includes('>#not-a-uuid</span>'));
});

test('невалидный UUID в [[n:…#…]] — fallback на legacy', () => {
  const html = renderMarkdown('[[n:abc#xyz]]');
  assert.ok(!html.includes(WIKI_LINK_ID_ATTR + '='));
  assert.ok(!html.includes(WIKI_LINK_NETWORK_ATTR + '='));
  assert.ok(html.includes(`${WIKI_LINK_TARGET_ATTR}="n:abc#xyz"`));
});

test('кросс-сеть: невалидный network UUID при валидном id — fallback', () => {
  const id = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
  const html = renderMarkdown(`[[n:not-a-uuid#${id}]]`);
  assert.ok(!html.includes(WIKI_LINK_ID_ATTR + '='));
});

test('ID-форма: пробелы вокруг id триммятся', () => {
  const id = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
  const html = renderMarkdown(`[[# ${id} ]]`);
  assert.match(html, new RegExp(`${WIKI_LINK_ID_ATTR}="${id}"`));
});

test('ID-форма: [[#id]] внутри code span и fenced-блока не интерпретируется', () => {
  const id = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
  assert.ok(renderMarkdown(`\`[[#${id}]]\``).includes(`<code>[[#${id}]]</code>`));
  const fenced = renderMarkdown(`\`\`\`\n[[#${id}]]\n\`\`\``);
  assert.ok(fenced.includes(`[[#${id}]]`));
  assert.ok(!fenced.includes(WIKI_LINK_ID_ATTR));
});

test('обычные [текст](url) ссылки не задеваются', () => {
  assert.match(renderMarkdown('[пример](https://example.com)'), /<a href="https:\/\/example\.com">/);
});

// ---------------------------------------------------------------------------
// Ссылки и протоколы
// ---------------------------------------------------------------------------

test('javascript: в ссылках и картинках отклоняется', () => {
  assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('href='));
  assert.ok(!renderMarkdown('![x](javascript:alert(1))').includes('<img'));
});

test('data:/etnimg: разрешены только для картинок', () => {
  assert.ok(renderMarkdown('![x](data:image/png;base64,AAAA)').includes('<img'));
  assert.ok(renderMarkdown('![x](etnimg://c/a.png)').includes('<img src="etnimg://c/a.png"'));
  assert.ok(!renderMarkdown('[x](etnimg://c/a.png)').includes('href='));
});

test('сброшенная ссылка не оставляет паразитный </a> (карточка ETN 6cd0290f)', () => {
  // data: проходит общий validateLink (набор картинок), но сбрасывается
  // link-плагином — именно такие ссылки и дают паразитный </a>.
  const html = renderMarkdown('[плохо](data:text/plain,hi)');
  assert.ok(!html.includes('<a'), html);
  assert.ok(!html.includes('</a>'), html);
  assert.ok(html.includes('плохо'), 'текст сброшенной ссылки сохраняется');
});

test('картинка внутри сброшенной ссылки: <img> остаётся, </a> не эмитится', () => {
  const html = renderMarkdown('[![alt](https://e.com/i.png)](data:text/plain,hi)');
  assert.ok(html.includes('<img src="https://e.com/i.png"'), html);
  assert.ok(!html.includes('</a>'), html);
});

test('валидная ссылка с картинкой внутри — ровно одна пара <a>/</a>', () => {
  const html = renderMarkdown('[![alt](https://e.com/i.png)](https://e.com/)');
  assert.ok(html.includes('<a href="https://e.com/">'), html);
  assert.ok(html.includes('<img src="https://e.com/i.png"'), html);
  assert.equal(html.split('</a>').length - 1, 1, html);
});

test('сброшенная ссылка рядом с валидной не съедает чужой </a>', () => {
  const html = renderMarkdown('[плохо](data:text/plain,hi) и [хорошо](https://e.com)');
  assert.ok(!html.includes('href="data:'), html);
  assert.ok(html.includes('<a href="https://e.com">'), html);
  assert.equal(html.split('</a>').length - 1, 1, html);
});

test('ссылка в ссылке: внутренняя разбирается, внешняя остаётся текстом (CommonMark)', () => {
  const html = renderMarkdown('[a [b](https://e.com/1)](https://e.com/2)');
  assert.ok(html.includes('<a href="https://e.com/1">b</a>'), html);
  assert.ok(!html.includes('<a href="https://e.com/2"'), html);
  assert.equal(html.split('</a>').length - 1, 1, html);
});

// ---------------------------------------------------------------------------
// Размеры картинок
// ---------------------------------------------------------------------------

test('parseAltSize: px, px+высота, проценты, не-размер', () => {
  assert.deepEqual(parseAltSize('фото|600px'), { alt: 'фото', style: 'width:600px' });
  assert.deepEqual(parseAltSize('фото|600x400'), { alt: 'фото', style: 'width:600px;height:400px' });
  assert.deepEqual(parseAltSize('фото|50%'), { alt: 'фото', style: 'width:50%' });
  assert.deepEqual(parseAltSize('фото|не_размер'), { alt: 'фото|не_размер', style: null });
  assert.deepEqual(parseAltSize('без размера'), { alt: 'без размера', style: null });
});

test('![alt|600px](url) получает width в style', () => {
  const html = renderMarkdown('![alt|600px](https://e.com/a.png)');
  assert.ok(html.includes('alt="alt"'), html);
  assert.ok(html.includes('style="width:600px"'), html);
});

test('![alt|50%](url) и 600x400', () => {
  assert.ok(renderMarkdown('![alt|50%](https://e.com/a.png)').includes('style="width:50%"'));
  assert.ok(
    renderMarkdown('![alt|600x400](https://e.com/a.png)').includes(
      'style="width:600px;height:400px"',
    ),
  );
});

test('невалидный URL картинки — простой текст, без <img>', () => {
  assert.ok(!renderMarkdown('![alt](ftp://e.com/a.png)').includes('<img'));
});

// ---------------------------------------------------------------------------
// Блоки кода и подсветка
// ---------------------------------------------------------------------------

test('известный язык подсвечивается highlight.js', () => {
  const html = renderMarkdown('```ts\nconst x = 1;\n```');
  assert.match(html, /<pre><code class="hljs language-ts">/);
  assert.ok(html.includes('hljs-keyword'), html);
});

test('неизвестный язык — экранированный plain-блок', () => {
  const html = renderMarkdown('```zzz\n<x>\n```');
  assert.ok(!html.includes('<x>'));
  assert.match(html, /<pre><code class="hljs">/);
});

test('код без языка — экранированный блок', () => {
  const html = renderMarkdown('```\n<b>\n```');
  assert.ok(!html.includes('<b>'));
  assert.match(html, /&lt;b&gt;/);
});

test('незакрытый fence закрывается на EOF', () => {
  assert.match(renderMarkdown('```ts\nconst a = 1;'), /language-ts/);
});

test('```mermaid отдаётся блоком pre.mermaid для клиентского рендера (M7)', () => {
  const html = renderMarkdown('```mermaid\ngraph TD;\nA-->B;\n```');
  assert.match(html, /<pre class="mermaid"><code>/);
  assert.ok(html.includes('graph TD;'));
  assert.ok(!html.includes('hljs-'));
});

// ---------------------------------------------------------------------------
// Ограничения входа
// ---------------------------------------------------------------------------

test('лимит длины: превышение бросает ошибку', () => {
  assert.throws(() => renderMarkdown('x'.repeat(DEFAULT_MAX_LENGTH + 1)));
  assert.doesNotThrow(() => renderMarkdown('x'.repeat(DEFAULT_MAX_LENGTH)));
});

test('лимит длины можно поднять (экспорт документов)', () => {
  assert.doesNotThrow(() => renderMarkdown('x'.repeat(DEFAULT_MAX_LENGTH + 10), { maxLength: Infinity }));
});

test('не-строка бросает ошибку', () => {
  assert.throws(() => renderMarkdown(null));
  assert.throws(() => renderMarkdown(123));
});
