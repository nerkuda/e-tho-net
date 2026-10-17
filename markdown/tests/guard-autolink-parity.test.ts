/**
 * Сторож ПАРИТЕТА АВТОЛИНКА с режимом правки (ошибка 37458cbc, круг 3).
 *
 * Правило. Строка, которую редактор подсвечивает как ссылку, в просмотре тоже
 * обязана быть ссылкой, и наоборот — что ссылкой не считается, текстом и
 * остаётся. Источник истины по формам — редактор: markdown-поле собирается на
 * `@codemirror/lang-markdown` с базой `markdownLanguage` (Lezer extended + GFM),
 * где Autolink подсвечивает явные схемы `http://`, `https://`, `mailto:` (а
 * также `www.` и «голые» адреса — осознанно ВНЕ области просмотра, см.
 * `renderer.ts`), но НЕ подсвечивает protocol-relative `//host` и «голые»
 * домены. Ссылки в просмотре даёт единый `@etn/markdown`: встроенное
 * внутристрочное правило `linkify` (схема + `://`) и своё `linkify_scheme`
 * (схема без `//` — `mailto:`); ядровое правило `linkify` выключено, иначе оно
 * автолинкает `//host` (круг 2), а `mailto:` терялся (круг 3).
 *
 * Зачем сторож. Круг 1 потерял `mailto:` при выключении ядрового правила — ни
 * один тест этого не заметил, потому что паритет по формам URL нигде не был
 * зафиксирован таблицей. Теперь каждая форма закреплена, и удаление любой из
 * двух половин (встроенного правила, своего `linkify_scheme`) или расширение
 * области (появление `//host`/доменов) краснит сторож.
 *
 * Сторож прогоняется по ИСХОДНИКАМ пакета (`tests/**` → `src/index.ts`, tsx),
 * поэтому краснеет сразу на правку `markdown/src/**`, без пересборки.
 * Входит в обычный `npm -w @etn/markdown test`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { renderMarkdown } from '../src/index.js';

const MARKDOWN_ROOT = resolve(import.meta.dirname, '..');

/** Единый рендерер превратил строку в ссылку? */
function isLink(src: string, href: string): boolean {
  return renderMarkdown(src).includes(`<a href="${href}">`);
}

describe('паритет автолинка просмотра и правки: формы URL (37458cbc)', () => {
  it('явные схемы редактора (http/https/mailto) — ссылки в просмотре', () => {
    assert.equal(isLink('https://e.com', 'https://e.com'), true, 'https');
    assert.equal(isLink('http://e.com', 'http://e.com'), true, 'http');
    assert.equal(isLink('mailto:a@b.c', 'mailto:a@b.c'), true, 'mailto');
    // Внутри текста и внутри strong — тоже ссылки.
    assert.equal(isLink('см. https://e.com тут', 'https://e.com'), true);
    assert.equal(isLink('см. mailto:a@b.c тут', 'mailto:a@b.c'), true);
    assert.equal(isLink('**mailto:a@b.c**', 'mailto:a@b.c'), true);
  });

  it('вне области просмотра остаются текстом: //host, голые домены, www, адреса', () => {
    // `//host` — protocol-relative: редактор его не подсвечивает, просмотр не
    // линкует (иначе окно ETN уводилось с приложения — круг 2).
    assert.equal(renderMarkdown('//example.com/x').includes('<a'), false, '//host');
    assert.equal(renderMarkdown('a //example.com/x b').includes('<a'), false, '//host в тексте');
    assert.equal(renderMarkdown('www.example.com').includes('<a'), false, 'www.');
    assert.equal(renderMarkdown('example.com').includes('<a'), false, 'голый домен');
    assert.equal(renderMarkdown('user@example.com').includes('<a'), false, 'адрес без mailto:');
  });

  it('схемы вне allow-list и без схемы в linkify-it — текст', () => {
    for (const src of [
      'javascript:alert(1)',
      'data:text/plain,hi',
      'ftp://e.com/x',
      'tel:+70000000000',
      'http:foo',
      'mailto:',
    ]) {
      assert.equal(renderMarkdown(src).includes('<a'), false, src);
    }
  });

  it('dotless-хост (`mailto:a@b`, `http://e`) — просмотр линкует, редактор нет: осознанный won\'t-fix', () => {
    // Форма из замечания верификатора (задача 64b69eb3). Редактор (Lezer
    // markdown extended) ставит узел URL только при ХОСТЕ С ТОЧКОЙ — проверено
    // пробой `markdownLanguage.parser.parse('mailto:a@b')` (узлов URL нет) и
    // `…parse('http://e')` (тоже нет, а `…parse('http://e.c')` узел URL даёт).
    // Просмотр линкует: адрес решает linkify-it, чьи схемы `mailto:` и `http:`
    // принимают и односоставный хост.
    assert.equal(isLink('mailto:a@b', 'mailto:a@b'), true, 'mailto:a@b');
    assert.equal(isLink('http://e', 'http://e'), true, 'http://e');
    assert.equal(isLink('http://localhost:3000/x', 'http://localhost:3000/x'), true, 'localhost');
    // ПОЧЕМУ НЕ ИСКЛЮЧАЕМ (решение задачи 64b69eb3, зафиксировано этим тестом):
    //  * расхождение КЛАССОВОЕ — и `mailto:`, и `http(s)://` — и живёт в
    //    движке (щедрый linkify-it против строгой эвристики Lezer), а не в
    //    правиле `linkify_scheme`: до всей этой работы то же делало ядровое
    //    правило markdown-it (`mailto:a@b` линковалось и тогда);
    //  * исключение потребовало бы СВОЕЙ валидации хоста поверх общего движка
    //    и сделало бы просмотр СТРОЖЕ, чем он был когда-либо: `http://localhost:3000/…`
    //    перестал бы быть ссылкой — для пользователя это потеря, а не паритет;
    //  * расхождение односторонне и безвредно: просмотр линкует то, что
    //    редактор лишь не подсвечивает (клик открывает почту/браузер).
    //    Обратное направление — «редактор подсвечивает, просмотр нет», ради
    //    которого написан весь сторож, — по-прежнему запрещено строго.
    // Если кто-то всё же исключит dotless из правила, он обязан прийти сюда и
    // переписать решение осознанно.
  });

  it('обе половины автолинка на месте: встроенное linkify и своё linkify_scheme', () => {
    // Наличие обеих половин — это и есть паритет: без `linkify` пропадут
    // `http(s)://`, без `linkify_scheme` — `mailto:` (регресс круга 3).
    const renderer = readFileSync(resolve(MARKDOWN_ROOT, 'src', 'renderer.ts'), 'utf8');
    assert.match(
      renderer,
      /schemeAutolinkPlugin\(md\)/,
      'нет своего правила автолинка схем без `//` — `mailto:` снова станет текстом',
    );
    assert.match(
      renderer,
      /md\.core\.ruler\.disable\('linkify'\)/,
      'ядровое правило linkify обязано быть выключено — иначе автолинкается //host',
    );
    assert.match(renderer, /linkify: true/, 'внутристрочный автолинк выключен');
    const autolink = readFileSync(resolve(MARKDOWN_ROOT, 'src', 'autolink.ts'), 'utf8');
    assert.match(
      autolink,
      /md\.linkify\.matchAtStart/,
      'адрес в правиле обязан решать linkify-it — иначе разъедутся схемы и нормализация',
    );
    assert.match(autolink, /md\.validateLink\(fullUrl\)/, 'allow-list схем обязателен и для mailto');
    // Разметка позиций (sourceMap) навешена на ОБА правила автолинка.
    const sourceMap = readFileSync(resolve(MARKDOWN_ROOT, 'src', 'source-map.ts'), 'utf8');
    assert.match(
      sourceMap,
      /for \(const ruleName of \['linkify', SCHEME_AUTOLINK_RULE\]\)/,
      'оба правила автолинка обязаны быть обёрнуты разметкой позиций',
    );
  });
});
