/**
 * Unit tests for `replaceLegacyWikiLinks` (client/src/renderer/lib/pure.ts) —
 * the markdown-source rewrite behind the «создать отсутствующую мысль по
 * legacy-ссылке» flow (карточка ETN 34ffbd75): every same-named `[[имя]]` /
 * `[[имя|текст]]` becomes `[[#<id>]]` / `[[#<id>|текст]]`, each replacement
 * keeps its own alias, look-alike names and ID-form links stay untouched.
 *
 * Pure — no DOM, no network.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { replaceLegacyWikiLinks } from '../src/renderer/lib/pure.js';

const ID = '01234567-89ab-cdef-0123-456789abcdef';

describe('replaceLegacyWikiLinks: базовая замена', () => {
  it('заменяет все вхождения — и без алиаса, и с алиасом', () => {
    const md = 'Текст [[Иванов]] и [[Иванов|Ваня]] и снова [[Иванов]].';
    const res = replaceLegacyWikiLinks(md, 'Иванов', ID);
    assert.equal(res.count, 3);
    assert.equal(res.md, `Текст [[#${ID}]] и [[#${ID}|Ваня]] и снова [[#${ID}]].`);
  });

  it('каждое вхождение сохраняет СВОЙ текст ссылки', () => {
    const md = '[[Пётр|Петя]] ... [[Пётр|Petya]] ... [[Пётр]]';
    const res = replaceLegacyWikiLinks(md, 'Пётр', ID);
    assert.equal(res.md, `[[#${ID}|Петя]] ... [[#${ID}|Petya]] ... [[#${ID}]]`);
  });

  it('остальной текст комментария не меняется', () => {
    const md = '# Заголовок\n\nАбзац с [[цель|алиас]] и кодом `[[не трогать]]`-подобным текстом.\n\n- пункт [[цель]]\n';
    const res = replaceLegacyWikiLinks(md, 'цель', ID);
    assert.equal(res.count, 2);
    assert.equal(
      res.md,
      `# Заголовок\n\nАбзац с [[#${ID}|алиас]] и кодом \`[[не трогать]]\`-подобным текстом.\n\n- пункт [[#${ID}]]\n`,
    );
  });

  it('ничего не найдено — текст и count без изменений', () => {
    const md = '[[Другое]] [[#uuid|x]]';
    const res = replaceLegacyWikiLinks(md, 'Цель', ID);
    assert.equal(res.count, 0);
    assert.equal(res.md, md);
  });

  it('пустое имя цели — no-op', () => {
    const md = '[[x]]';
    assert.deepEqual(replaceLegacyWikiLinks(md, '   ', ID), { md, count: 0 });
  });
});

describe('replaceLegacyWikiLinks: точность совпадения', () => {
  it('не задевает ссылки с похожим началом имени (префикс ≠ имя)', () => {
    const md = '[[имя]] и [[имя с продолжением]] и [[имя2]]';
    const res = replaceLegacyWikiLinks(md, 'имя', ID);
    assert.equal(res.count, 1);
    assert.equal(res.md, `[[#${ID}]] и [[имя с продолжением]] и [[имя2]]`);
  });

  it('не трогает id-ссылки и кросс-сетевые ссылки', () => {
    const md = `[[#${ID}]] [[#${ID}|алиас]] [[n:11111111-2222-3333-4444-555555555555#${ID}|x]]`;
    const res = replaceLegacyWikiLinks(md, ID, ID);
    assert.equal(res.count, 0);
    assert.equal(res.md, md);
  });

  it('имя с регэксп-спецсимволами матчится точно и без ложных срабатываний', () => {
    const md = 'C++ (книга #1): [[C++ (книга #1)|справочник]] и [[C++ (книга #1)]] и [[C++ (книга #11)]] и [[C+]]';
    const res = replaceLegacyWikiLinks(md, 'C++ (книга #1)', ID);
    assert.equal(res.count, 2);
    assert.equal(
      res.md,
      `C++ (книга #1): [[#${ID}|справочник]] и [[#${ID}]] и [[C++ (книга #11)]] и [[C+]]`,
    );
  });

  it('имя, содержащее |, не может быть целью (первый | отделяет алиас)', () => {
    // `[[a|b|c]]` парсится рендером как target=a, alias=`b|c` — замена по имени
    // `a|b` не должна матчиться.
    const md = '[[a|b|c]]';
    const res = replaceLegacyWikiLinks(md, 'a|b', ID);
    assert.equal(res.count, 0);
  });

  it('регистр важен: Иванов ≠ иванов', () => {
    const md = '[[Иванов]] и [[иванов]]';
    const res = replaceLegacyWikiLinks(md, 'Иванов', ID);
    assert.equal(res.count, 1);
    assert.equal(res.md, `[[#${ID}]] и [[иванов]]`);
  });

  it('пробелы вокруг имени в ссылке тримятся как рендером', () => {
    const md = '[[  имя  |  текст  ]] и [[ имя ]]';
    const res = replaceLegacyWikiLinks(md, 'имя', ID);
    assert.equal(res.count, 2);
    // Алиас сохраняется дословно («текст после | остаётся прежним»).
    assert.equal(res.md, `[[#${ID}|  текст  ]] и [[#${ID}]]`);
  });
});

describe('replaceLegacyWikiLinks: краевые случаи', () => {
  it('пустой и пробельный алиас → короткая форма [[#<id>]]', () => {
    assert.equal(replaceLegacyWikiLinks('[[имя|]]', 'имя', ID).md, `[[#${ID}]]`);
    assert.equal(replaceLegacyWikiLinks('[[имя|   ]]', 'имя', ID).md, `[[#${ID}]]`);
  });

  it('многострочное содержимое [[...]] — не ссылка, не трогаем', () => {
    const md = '[[имя\n|текст]]';
    const res = replaceLegacyWikiLinks(md, 'имя', ID);
    assert.equal(res.count, 0);
    assert.equal(res.md, md);
  });

  it('незакрытая ссылка в конце текста — безопасный no-op', () => {
    const md = '[[имя и всё';
    assert.deepEqual(replaceLegacyWikiLinks(md, 'имя', ID), { md, count: 0 });
  });

  it('соседние замены не съедают текст между ними', () => {
    const md = '[[a]][[a]]x[[a|y]]';
    const res = replaceLegacyWikiLinks(md, 'a', ID);
    assert.equal(res.count, 3);
    assert.equal(res.md, `[[#${ID}]][[#${ID}]]x[[#${ID}|y]]`);
  });

  it('тройная скобка: target для рендера — «[имя», замена по «имя» не срабатывает', () => {
    // markdown-it матчит `[[…]]` с ПЕРВОГО `[[`: в `[[[имя]]]` target = `[имя`
    // (и data-wiki-target рендера это подтверждает) — имя «имя» не совпадает.
    const md = '[[[имя]]]';
    const res = replaceLegacyWikiLinks(md, 'имя', ID);
    assert.equal(res.count, 0);
    assert.equal(res.md, md);
  });

  it('крупный текст: замены по всему документу', () => {
    const parts: string[] = [];
    for (let i = 0; i < 500; i++) parts.push(`строка ${i}: [[цель|№${i}]]`);
    const md = parts.join('\n');
    const res = replaceLegacyWikiLinks(md, 'цель', ID);
    assert.equal(res.count, 500);
    assert.ok(res.md.includes(`строка 499: [[#${ID}|№499]]`));
    assert.ok(!res.md.includes('[[цель'));
  });
});
