/**
 * Зона «Результаты поиска» выпадающей панели строки поиска карты (задача
 * a1766c7d, 0.8.2).
 *
 * Контракт (элемент интерфейса «Строка поиска вида «Карта мыслей»»):
 *  - совпадение запроса подсвечивается прямо в названии облачка-результата
 *    (`highlightTerms` фабрики + `renderHighlightedText`), тем же видом
 *    `<mark>`, что серверные сниппеты; где совпадения в названии нет —
 *    название без подсветки;
 *  - Enter по выбранной строке делает РОВНО то же, что клик по ней: хит-мысль —
 *    в фокус, хит связи/хронологии — открыть хит, заголовок группы —
 *    свернуть/развернуть. Одна и та же функция активации обслуживает оба пути
 *    (реестр `rowActivations`), синтетический клик по строке не используется:
 *    у хита-мысли обработчик живёт на облачке-ребёнке и синтетического клика
 *    не получает;
 *  - строки не выбрана — Enter повторяет поиск (документация рекомендует Enter
 *    для крупных сетей).
 *
 * Клиентские тесты идут без jsdom (конвенция соседних тестов), поэтому привязка
 * слоёв проверяется по якорям исходника и стилей.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { assembledStylesFile } from './renderer-css.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const SEARCH_TS = resolve(RENDERER, 'search', 'search.ts');
const THOUGHT_CLOUD_TS = resolve(RENDERER, 'lib', 'thought-cloud.ts');
const DOM_TS = resolve(RENDERER, 'lib', 'dom.ts');
const STYLES_CSS = assembledStylesFile();

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('Enter по выбранной строке результатов (задача a1766c7d)', () => {
  it('Enter выполняет действие строки, а не синтетический клик по ней', () => {
    const src = readText(SEARCH_TS);
    assert.match(src, /row\.activate\(\);/, 'Enter запускает действие выбранной строки');
    assert.ok(
      !src.includes('row.el.click()'),
      'синтетический клик по строке убран: у хита-мысли он не доходит до облачка',
    );
  });

  it('действие строки регистрируется при рендере и то же обслуживает клик', () => {
    const src = readText(SEARCH_TS);
    assert.match(
      src,
      /const rowActivations = new WeakMap<HTMLElement, \(\) => void>\(\);/,
      'реестр активаций строк',
    );
    // Хиты: запись в реестре из рендера + та же функция на клик у простых строк.
    assert.match(src, /rowActivations\.set\(row, hit\.activate\);/, 'хиты групп в реестре');
    assert.match(src, /rowActivations\.set\(row, activate\);/, 'строка «Мысль по ID» в реестре');
    assert.match(
      src,
      /if \(!hit\.isThought\) row\.addEventListener\('click', hit\.activate\);/,
      'клик по строке связи/хронологии и Enter берут одну функцию',
    );
    // Мысль: ту же функцию получают жесты облачка (клик по облачку = Enter).
    assert.equal(
      (src.match(/actions: \{ onClick: activate, onCtrlClick: activate \},/g) ?? []).length,
      3,
      'все три облачка результатов активируются той же функцией, что и Enter',
    );
    // Строка без записи (заголовок группы) падает на обычный клик.
    assert.match(
      src,
      /function activateRow\(el: HTMLElement\): void \{\s*const activate = rowActivations\.get\(el\);\s*if \(activate !== undefined\) activate\(\);\s*else el\.click\(\);\s*\}/,
      'activateRow: реестр, иначе обычный клик (заголовок группы)',
    );
    assert.match(
      src,
      /rows\.push\(\{ el: header, kind: 'header', activate: \(\) => activateRow\(header\) \}\);/,
      'заголовок группы активируется тем же путём',
    );
    assert.match(
      src,
      /rows\.push\(\{ el: hit, kind: 'hit', activate: \(\) => activateRow\(hit\) \}\);/,
      'хит активируется тем же путём',
    );
  });

  it('хит-мысль ведёт в фокус, группа — сворачивается/разворачивается', () => {
    const src = readText(SEARCH_TS);
    assert.equal(
      (src.match(/const activate = activateHit\(key, \(\) => void setFocus\(hit\.thought_id\)\);/g) ?? [])
        .length,
      2,
      'обе группы мыслей (имена, тексты) ведут в фокус',
    );
    assert.match(
      src,
      /const activate = activateHit\(key, \(\) => void openLinkHit\(hit\.link_id\)\);/,
      'хит связи открывает связь',
    );
    assert.match(
      src,
      /const activate = activateHit\(key, \(\) => void openChronoHit\(hit\.owner, hit\.owner_id\)\);/,
      'хит хронологии открывает владельца',
    );
    // Заголовок группы сворачивает/разворачивает тело — обработчик на самом
    // заголовке (activateRow падает на el.click()).
    assert.match(
      src,
      /header\.addEventListener\('click', \(\) => \{\s*const collapsed = body\.classList\.toggle\('hidden'\);/,
      'клик по заголовку сворачивает/разворачивает группу',
    );
  });

  it('ни одна строка не выбрана — Enter повторяет поиск', () => {
    const src = readText(SEARCH_TS);
    const enter = /if \(event\.key === 'Enter'\) \{(?<body>[\s\S]*?)\n    \} else if/.exec(src);
    assert.ok(enter?.groups?.['body'] !== undefined, 'ветка Enter найдена');
    const body = enter.groups['body'] ?? '';
    assert.match(body, /row\.activate\(\);/, 'выбранная строка — её действие');
    assert.match(body, /void run\(\);/, 'без выбранной строки — повторный поиск');
  });
});

describe('подсветка совпадений в названии облачка-результата (задача a1766c7d)', () => {
  it('фабрика облачка принимает термы подсветки и рисует их в названии', () => {
    const cloud = readText(THOUGHT_CLOUD_TS);
    assert.match(cloud, /highlightTerms\?: readonly string\[\];/, 'опция фабрики');
    assert.match(
      cloud,
      /const titleEl = buildTitle\(profile, input\.title, options\.highlightTerms \?\? \[\]\);/,
      'термы доезжают до названия',
    );
    assert.match(cloud, /renderHighlightedText\(node, title, highlightTerms\);/, 'рисует название');
  });

  it('отрисовка <mark> — без innerHTML, только узлами', () => {
    const dom = readText(DOM_TS);
    const fn = /export function renderHighlightedText\((?<body>[\s\S]*?)\n\}/.exec(dom);
    assert.ok(fn?.groups?.['body'] !== undefined, 'хелпер найден');
    const body = fn.groups['body'] ?? '';
    assert.match(body, /node\.append\(el\('mark', undefined, run\.text\)\);/, 'совпадение — <mark>');
    assert.match(body, /node\.append\(document\.createTextNode\(run\.text\)\);/, 'остальное — текстом');
    assert.ok(!body.includes('innerHTML'), 'innerHTML не используется');
    assert.match(
      body,
      /if \(!runs\.some\(\(run\) => run\.hit\)\) \{\s*\/\/[^\n]*\n\s*node\.textContent = text;\s*return;\s*\}/,
      'совпадений нет — название как обычный текст, без разметки',
    );
  });

  it('термы берутся из текущего запроса и уходят во все три облачка', () => {
    const src = readText(SEARCH_TS);
    assert.match(
      src,
      /function currentHighlightTerms\(\): string\[\] \{\s*return chrome === null \? \[\] : searchHighlightTerms\(chrome\.input\.value\);\s*\}/,
      'термы — из текущего запроса строки поиска',
    );
    assert.match(src, /const highlightTerms = currentHighlightTerms\(\);/, 'термы группы');
    assert.equal(
      (src.match(/^\s*highlightTerms,\n/gm) ?? []).length,
      2,
      'обе группы мыслей передают термы в фабрику',
    );
    assert.match(src, /highlightTerms: currentHighlightTerms\(\),/, 'строка «Мысль по ID» тоже');
  });

  it('подсветка названия выглядит как серверный сниппет', () => {
    const css = readText(STYLES_CSS);
    const rule = /\.search-hit mark,\s*\.cloud-title mark \{(?<body>[^}]*)\}/.exec(css);
    assert.ok(rule?.groups?.['body'] !== undefined, 'общее правило подсветки');
    assert.match(rule.groups['body'] ?? '', /background: var\(--mark-bg\);/, 'фон подсветки');
  });
});
