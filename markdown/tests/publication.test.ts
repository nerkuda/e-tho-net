/**
 * Unit tests of the publication toolkit (task d8ad884e, version 0.11.1):
 * heading shift, decapitation, anchors, TOC, numbering, `[[#pub:…]]` links and
 * byte-for-byte backward compatibility of the plain renderer. Pure — no DOM,
 * no DB (requirement [[#9969e586]], [[#7f583ef9]], [[#888453b6]],
 * [[#a33f7b0e]], DTO [[#8b849dfc]]).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildToc,
  formatSectionNumber,
  publicationAnchor,
  renderMarkdown,
  renderPublicationFragment,
  shortId,
  WIKI_LINK_MISSING_CLASS,
  type WikiLinkRef,
} from '../src/index.js';

const UUID = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';

// ---------------------------------------------------------------------------
// Смещение уровней и обезглавливание ([[#9969e586]])
// ---------------------------------------------------------------------------

test('смещение: базовый уровень N, крупнейший заголовок → N+1, остальные на разность', () => {
  const { html } = renderPublicationFragment(
    ['## Раз', '', 'текст', '', '#### Четыре'].join('\n'),
    { baseLevel: 2 },
  );
  assert.match(html, /<h3>Раз<\/h3>/);
  assert.match(html, /<h5>Четыре<\/h5>/);
  assert.ok(!html.includes('<h2>'), html);
  assert.ok(!html.includes('<h4>'), html);
});

test('смещение: пример требования — раздел H3 + H2/H3/H4 → H4/H5/H6', () => {
  const { html } = renderPublicationFragment(
    ['## Два', '', '### Три', '', '#### Четыре'].join('\n'),
    { baseLevel: 3 },
  );
  assert.match(html, /<h4>Два<\/h4>/);
  assert.match(html, /<h5>Три<\/h5>/);
  assert.match(html, /<h6>Четыре<\/h6>/);
});

test('смещение: заголовков нет — текст без изменений', () => {
  const { html, headings } = renderPublicationFragment('просто **текст**', { baseLevel: 3 });
  assert.equal(html, '<p>просто <strong>текст</strong></p>\n');
  assert.deepEqual(headings, []);
});

test('смещение: без baseLevel (0) заголовки остаются как есть', () => {
  const { html } = renderPublicationFragment('# Один\n\n## Два');
  assert.match(html, /<h1>Один<\/h1>/);
  assert.match(html, /<h2>Два<\/h2>/);
});

test('обезглавливание: заголовок за H6 → <p><strong>, не кламп', () => {
  const { html, headings } = renderPublicationFragment('# Один', { baseLevel: 6 });
  assert.match(html, /<p><strong>Один<\/strong><\/p>/);
  assert.ok(!html.includes('<h7>'), html);
  assert.ok(!html.includes('<h6>'), html);
  assert.equal(headings[0]?.decapitated, true);
});

test('обезглавливание: смешанный случай — H6 остаётся, H7 обезглавливается', () => {
  const { html } = renderPublicationFragment('### Три\n\n#### Четыре', { baseLevel: 5 });
  assert.match(html, /<h6>Три<\/h6>/);
  assert.match(html, /<p><strong>Четыре<\/strong><\/p>/);
});

// ---------------------------------------------------------------------------
// Якоря ([[#8b849dfc]])
// ---------------------------------------------------------------------------

test('якоря: headingAnchor задаёт id у заголовка', () => {
  const { html, headings } = renderPublicationFragment('## Модель данных', {
    baseLevel: 1,
    headingAnchor: () => publicationAnchor(UUID),
  });
  assert.match(html, new RegExp(`<h2 id="pub-${shortId(UUID)}">Модель данных</h2>`));
  assert.equal(headings[0]?.anchor, `pub-${shortId(UUID)}`);
});

test('якоря: обезглавленный заголовок якоря не получает', () => {
  let called = 0;
  const { headings } = renderPublicationFragment('# Один', {
    baseLevel: 6,
    headingAnchor: () => {
      called++;
      return 'pub-x';
    },
  });
  assert.equal(called, 0);
  assert.equal(headings[0]?.anchor, null);
});

test('якоря: без headingAnchor id не эмитится', () => {
  const { html } = renderPublicationFragment('## А', { baseLevel: 1 });
  assert.ok(!html.includes(' id="'), html);
});

test('якоря: значение экранируется', () => {
  const { html } = renderPublicationFragment('## А', {
    baseLevel: 1,
    headingAnchor: () => 'a"b',
  });
  assert.ok(html.includes('id="a&quot;b"'), html);
});

// ---------------------------------------------------------------------------
// Оглавление
// ---------------------------------------------------------------------------

test('оглавление: плоский список заголовков с уровнями, текстом и якорями', () => {
  const { headings } = renderPublicationFragment('# Один\n\n## Два\n\n### Три', {
    baseLevel: 2,
    headingAnchor: ({ index }) => `pub-h${index}`,
  });
  assert.deepEqual(headings, [
    { level: 3, text: 'Один', anchor: 'pub-h0', decapitated: false },
    { level: 4, text: 'Два', anchor: 'pub-h1', decapitated: false },
    { level: 5, text: 'Три', anchor: 'pub-h2', decapitated: false },
  ]);
});

test('оглавление: текст заголовка очищен от markdown и wiki-ссылок', () => {
  const { headings } = renderPublicationFragment('## **Жирный** [[Мысль|метка]]');
  assert.equal(headings[0]?.text, 'Жирный метка');
});

test('buildToc: вложенность по уровням заголовков', () => {
  const toc = buildToc([
    { level: 2, text: 'Раздел 1', anchor: 'pub-a', decapitated: false },
    { level: 3, text: 'Подраздел 1.1', anchor: 'pub-b', decapitated: false },
    { level: 3, text: 'Подраздел 1.2', anchor: 'pub-c', decapitated: false },
    { level: 2, text: 'Раздел 2', anchor: 'pub-d', decapitated: false },
  ]);
  assert.equal(toc.length, 2);
  assert.deepEqual(
    toc[0]?.children.map((n) => n.text),
    ['Подраздел 1.1', 'Подраздел 1.2'],
  );
  assert.deepEqual(toc[1]?.children, []);
});

test('buildToc: заголовок без предшественника старшего уровня становится корнем', () => {
  const toc = buildToc([
    { level: 4, text: 'Глубокий', anchor: null, decapitated: false },
    { level: 2, text: 'Верхний', anchor: null, decapitated: false },
  ]);
  assert.equal(toc.length, 2);
  assert.equal(toc[0]?.text, 'Глубокий');
});

// ---------------------------------------------------------------------------
// Нумерация ([[#a33f7b0e]])
// ---------------------------------------------------------------------------

test('нумерация: уровень в диапазоне нумеруется, вне — нет', () => {
  assert.equal(formatSectionNumber([1], { from: 1, to: 3 }), '1');
  assert.equal(formatSectionNumber([1, 2], { from: 1, to: 3 }), '1.2');
  // Задача 7cfaba7c, п.6: диапазон стартует с уровня `from` — счётчики уровней
  // выше отбрасываются, а не идут префиксом.
  assert.equal(formatSectionNumber([1, 2, 3], { from: 2, to: 3 }), '2.3');
  assert.equal(formatSectionNumber([2, 1], { from: 2, to: 5 }), '1');
  assert.equal(formatSectionNumber([1, 2], { from: 3, to: 4 }), null);
  assert.equal(formatSectionNumber([1, 2, 3, 4], { from: 2, to: 3 }), null);
});

test('нумерация: одиночный уровень и отсчёт с 1', () => {
  // Диапазон 2–2: разделы уровня 2 нумеруются «1», «2», … по позиции среди
  // братьев; вложенные (уровень 3) выпадают из диапазона.
  assert.equal(formatSectionNumber([1, 1], { from: 2, to: 2 }), '1');
  assert.equal(formatSectionNumber([1, 2], { from: 2, to: 2 }), '2');
  assert.equal(formatSectionNumber([1, 2, 1], { from: 2, to: 2 }), null);
  // Диапазон 2–5: вложенные разделы уровня 3 дают «1.1».
  assert.equal(formatSectionNumber([2, 1, 3], { from: 2, to: 5 }), '1.3');
});

test('нумерация: открытый диапазон и оба NULL', () => {
  assert.equal(formatSectionNumber([1, 2], { from: null, to: 2 }), '1.2');
  assert.equal(formatSectionNumber([1, 2], { from: 2, to: null }), '2');
  assert.equal(formatSectionNumber([1, 2], { from: null, to: null }), null);
  assert.equal(formatSectionNumber([1, 2], undefined), null);
  assert.equal(formatSectionNumber([], { from: 1, to: 3 }), null);
});

// ---------------------------------------------------------------------------
// Ссылки: [[#pub:…]] и подстановка названий ([[#7f583ef9]], [[#888453b6]])
// ---------------------------------------------------------------------------

test('pub-ссылка: название подставляется текстом', () => {
  const { html } = renderPublicationFragment(`см. [[#pub:${UUID}]]`, {
    resolveLink: () => ({ kind: 'text', text: 'Моя публикация' }),
  });
  assert.match(html, /см\. Моя публикация/);
  assert.ok(!html.includes('<span'), html);
});

test('pub-ссылка: префикс распознаётся, id и алиас доходят до резолвера', () => {
  const seen: WikiLinkRef[] = [];
  renderPublicationFragment(`[[#pub:${UUID}|Метка]]`, {
    resolveLink: (ref) => {
      seen.push(ref);
      return { kind: 'text', text: ref.alias ?? '?' };
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.kind, 'pub');
  assert.equal(seen[0]?.id, UUID);
  assert.equal(seen[0]?.alias, 'Метка');
});

test('ссылка на мысль в документе становится якорем', () => {
  const { html } = renderPublicationFragment(`см. [[#${UUID}]]`, {
    resolveLink: (ref) =>
      ref.kind === 'id'
        ? { kind: 'anchor', anchor: publicationAnchor(UUID), text: 'Модель данных' }
        : undefined,
  });
  assert.ok(html.includes(`<a href="#${publicationAnchor(UUID)}">Модель данных</a>`), html);
});

test('ссылка на сущность вне документа — названием текстом', () => {
  const { html } = renderPublicationFragment(`см. [[#${UUID}]]`, {
    resolveLink: () => ({ kind: 'text', text: 'Внешняя мысль' }),
  });
  assert.match(html, /см\. Внешняя мысль/);
  assert.ok(!html.includes('<a '), html);
});

test('удалённая цель — маркер «удалена», не ошибка рендера', () => {
  const { html } = renderPublicationFragment(`[[#pub:${UUID}]]`, {
    resolveLink: () => ({ kind: 'missing' }),
  });
  assert.ok(html.includes(WIKI_LINK_MISSING_CLASS), html);
  assert.ok(html.includes('удалена'), html);
});

test('резолвер вернул undefined — запасной текст (алиас или «удалена»)', () => {
  const withAlias = renderPublicationFragment(`[[#pub:${UUID}|Метка]]`, {
    resolveLink: () => undefined,
  });
  assert.match(withAlias.html, /Метка/);

  const withoutAlias = renderPublicationFragment(`[[#pub:${UUID}]]`, {
    resolveLink: () => undefined,
  });
  assert.match(withoutAlias.html, /удалена/);
  assert.ok(!withoutAlias.html.includes(WIKI_LINK_MISSING_CLASS));
});

test('legacy name-form в режиме публикации — запасной текст без span', () => {
  const { html } = renderPublicationFragment('см. [[Имя мысли]]', {
    resolveLink: () => undefined,
  });
  assert.match(html, /см\. Имя мысли/);
  assert.ok(!html.includes('<span'), html);
});

test('резолвер вызывается и для кросс-сетевых ссылок', () => {
  const net = 'c4f9a3b2-1111-2222-3333-444455556666';
  const seen: WikiLinkRef[] = [];
  renderPublicationFragment(`[[n:${net}#${UUID}]]`, {
    resolveLink: (ref) => {
      seen.push(ref);
      return { kind: 'text', text: 'кросс' };
    },
  });
  assert.equal(seen[0]?.kind, 'cross');
  assert.equal(seen[0]?.networkId, net);
});

// ---------------------------------------------------------------------------
// Обратная совместимость (без опций публикаций — как сегодня)
// ---------------------------------------------------------------------------

test('совместимость: renderMarkdown не знает про [[#pub:…]] — legacy name-form', () => {
  const html = renderMarkdown(`[[#pub:${UUID}]]`);
  assert.ok(html.includes('data-legacy-link="true"'), html);
  assert.ok(html.includes(`data-wiki-target="#pub:${UUID}"`), html);
  assert.ok(!html.includes('data-wiki-id='), html);
  assert.ok(!html.includes(WIKI_LINK_MISSING_CLASS), html);
});

test('совместимость: заголовки в renderMarkdown не смещаются', () => {
  assert.match(renderMarkdown('## А'), /<h2>А<\/h2>/);
});

test('совместимость: renderPublicationFragment без опций повторяет renderMarkdown', () => {
  const source = '# Заголовок\n\nтекст **жирный** [[Мысль|метка]]';
  assert.equal(renderPublicationFragment(source).html, renderMarkdown(source));
});

// ---------------------------------------------------------------------------
// Чистота и лимиты
// ---------------------------------------------------------------------------

test('лимит длины: превышение бросает ошибку, maxLength поднимается', () => {
  assert.throws(() => renderPublicationFragment('x'.repeat(300), { maxLength: 10 }));
  assert.doesNotThrow(() => renderPublicationFragment('x'.repeat(11), { maxLength: Infinity }));
});

test('не-строка бросает ошибку', () => {
  assert.throws(() => renderPublicationFragment(null));
  assert.throws(() => renderPublicationFragment(123));
});

test('shortId / publicationAnchor детерминированы', () => {
  assert.equal(shortId(UUID), UUID.replace(/-/g, '').slice(0, 8));
  assert.equal(publicationAnchor(UUID), `pub-${UUID.replace(/-/g, '').slice(0, 8)}`);
});

// ---------------------------------------------------------------------------
// ТП1: те же конструкции в текстах публикаций (задача 2fc28fa2)
// ---------------------------------------------------------------------------

test('публикация: HTML-комментарии скрыты, новые конструкции отрендерены', () => {
  const { html } = renderPublicationFragment(
    ['<!-- требование к разделу -->', '', '==акцент== и <u>подчёркнутое</u>', '', '- [x] готово'].join(
      '\n',
    ),
    { baseLevel: 1 },
  );
  assert.ok(!html.includes('требование к разделу'), html);
  assert.ok(!html.includes('<!--'), html);
  assert.ok(html.includes('<mark>акцент</mark>'), html);
  assert.ok(html.includes('<u>подчёркнутое</u>'), html);
  assert.ok(html.includes('type="checkbox" disabled checked>'), html);
});

