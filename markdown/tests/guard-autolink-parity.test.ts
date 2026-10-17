/**
 * Сторож ПАРИТЕТА АВТОЛИНКА с режимом правки (ошибка 37458cbc, круг 3).
 *
 * Правило. Строка СО СХЕМОЙ (`http://`, `https://`, `mailto:`), которую
 * редактор подсвечивает как ссылку, обязана быть ссылкой и в просмотре; и
 * обратно — то, что редактор ссылкой не считает (protocol-relative `//host`,
 * схемы вне allow-list), просмотр оставляет текстом. Исключение из правила —
 * «голые» домены, `www.` и адреса без `mailto:`, которые редактор подсвечивает,
 * а просмотр линковать не берётся (осознанно ВНЕ области просмотра, см.
 * `renderer.ts`); его пинит второй тест таблицы. Источник истины по формам —
 * редактор: markdown-поле собирается на `@codemirror/lang-markdown` с базой
 * `markdownLanguage` (Lezer extended + GFM), где Autolink подсвечивает явные
 * схемы `http://`, `https://`, `mailto:`, но НЕ подсвечивает protocol-relative
 * `//host` и «голые» домены. Ссылки в просмотре даёт единый `@etn/markdown`:
 * встроенное внутристрочное правило `linkify` (схема + `://`) и своё
 * `linkify_scheme` (схема без `//` — `mailto:`); ядровое правило `linkify`
 * выключено, иначе оно автолинкает `//host` (круг 2), а `mailto:` терялся
 * (круг 3).
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

  it('dotless-хост (`mailto:a@b`, `http://e`, `http://localhost:3000/x`) — просмотр линкует, редактор нет: осознанный won\'t-fix', () => {
    // Форма из замечания верификатора (задача 64b69eb3). Редактор (Lezer
    // markdown extended, GFM Autolink) ставит узел URL ТОЛЬКО при хосте с
    // точкой: `parse('mailto:a@b')`, `parse('http://e')` и
    // `parse('http://localhost:3000/x')` дают параграф БЕЗ узла URL, а
    // `parse('mailto:a@b.c')`, `parse('http://e.c')` и
    // `parse('http://127.0.0.1:3000/x')` — узел URL. Просмотр линкует: адрес
    // решает linkify-it, чьи схемы `mailto:` и `http:` принимают и
    // односоставный хост.
    assert.equal(isLink('mailto:a@b', 'mailto:a@b'), true, 'mailto:a@b');
    assert.equal(isLink('http://e', 'http://e'), true, 'http://e');
    assert.equal(isLink('http://localhost:3000/x', 'http://localhost:3000/x'), true, 'localhost');
    // ПОЧЕМУ НЕ ИСКЛЮЧАЕМ (решение задачи 64b69eb3, зафиксировано этим тестом):
    //  * аргумент ПОВЕДЕНЧЕСКИЙ. Щедрый linkify-it линкует практичные
    //    локальные адреса — `http://localhost:3000/…` — которые пользователю
    //    нужны; редактор не подсвечивает их только из-за своей строгой
    //    эвристики. Исключение dotless-хоста лишило бы просмотр этих ссылок:
    //    для пользователя это потеря, а не выигрыш;
    //  * расхождение КЛАССОВОЕ — и `mailto:`, и `http(s)://` — и живёт в
    //    движке (щедрый linkify-it против строгой эвристики Lezer), а не в
    //    правиле `linkify_scheme`: до всей этой работы то же делало ядровое
    //    правило markdown-it (`mailto:a@b` линковалось и тогда);
    //  * исключение потребовало бы СВОЕЙ валидации хоста поверх общего
    //    движка — это правка `markdown/src/autolink.ts`, вне границ задачи
    //    64b69eb3 (там можно менять только `markdown/tests/**`);
    //  * в СХЕМНЫХ формах расхождение односторонне: просмотр линкует то, что
    //    редактор лишь не подсвечивает. Обратное направление ДЛЯ СХЕМ —
    //    «схема подсвечена редактором, а в просмотре текст» — сторож
    //    запрещает строго (первый тест этой таблицы). Вне схемных форм оно
    //    осознанно допускается и запинено ниже: `www.example.com`,
    //    `example.com`, `user@example.com` редактор подсвечивает, а просмотр
    //    линковать не берётся (вне области — см. `renderer.ts`).
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
