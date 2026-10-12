/**
 * Сторож: производный заголовок дневниковой ленты резолвит ID-формы wiki-ссылок
 * (ошибка 6b4e402a).
 *
 * Причина. `snippet` строки ленты (серверный `makeSnippet` либо клиентский
 * `recordTitleFromBody(body_md)`) несёт wiki-спан `[[…]]` целиком — имя мысли
 * подставляет клиент. Заголовок карточки — обычный ТЕКСТ (кнопка-заголовок
 * `record-title.ts`), DOM-декорации у него нет, поэтому ID-формы прогоняются
 * через общий резолвер сниппетов (`paintWikiIdsInSnippet` синхронно из кеша +
 * `resolveWikiIdsInSnippet` батчем), как в сниппетах поиска (ошибка 2a8181f4).
 * До фикса `recordTitleLabel` рисовал `recordDisplayTitle(row.title,
 * row.snippet)` как есть — в карточке был сырой `[[#<uuid>]]`.
 *
 * Сторож фиксирует ПРОВОДКУ (экран под Node не импортируется — тянет
 * Electron-каркас); поведенческий сквозной сценарий — GUI-стенд
 * (`client/scripts/ui-probe.chronicle-title-wiki-links.scenario.json`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const CHRONICLE = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'chronicle', 'chronicle.ts'),
  'utf8',
);

describe('сторож: резолв ID-форм в заголовке дневниковой ленты (6b4e402a)', () => {
  it('chronicle.ts подключает общий резолвер сниппетов, а не второй свой', () => {
    assert.match(
      CHRONICLE,
      /import\s*\{[^}]*paintWikiIdsInSnippet[^}]*\}\s*from\s*'\.\.\/\.\.\/editor\/wiki-link-resolver\.js'/,
      'синхронный резолвер сниппетов подключён из общего модуля',
    );
    assert.match(
      CHRONICLE,
      /import\s*\{[^}]*resolveWikiIdsInSnippet[^}]*\}\s*from\s*'\.\.\/\.\.\/editor\/wiki-link-resolver\.js'/,
      'батч-резолвер сниппетов подключён из общего модуля',
    );
  });

  it('derivedTitleLabel резолвит ID-формы синхронно через paintWikiIdsInSnippet', () => {
    const body = /function derivedTitleLabel\([\s\S]*?\n\}/.exec(CHRONICLE)?.[0] ?? '';
    assert.ok(body !== '', 'тело derivedTitleLabel найдено');
    assert.match(
      body.replace(/\/\/[^\n]*/g, ''),
      /paintWikiIdsInSnippet\(/,
      'заголовок проходит через резолвер, а не рисуется сырым',
    );
  });

  it('recordTitleLabel идёт через derivedTitleLabel (не сырой recordDisplayTitle)', () => {
    const body = /function recordTitleLabel\([\s\S]*?\n\}/.exec(CHRONICLE)?.[0] ?? '';
    assert.ok(body !== '', 'тело recordTitleLabel найдено');
    assert.match(body, /derivedTitleLabel\(/, 'надпись ленты резолвит ID-формы');
    assert.ok(
      !/recordDisplayTitle\(\s*row\.title\s*,\s*row\.snippet/.test(CHRONICLE),
      'нет сырого пути recordDisplayTitle(row.title, row.snippet)',
    );
  });

  it('карточка записи дорезолвит заголовок батчем (refreshDerivedTitle → resolveWikiIdsInSnippet)', () => {
    const fill = /function fillRecordCard\([\s\S]*?\n\}\n/.exec(CHRONICLE)?.[0] ?? '';
    assert.ok(fill !== '', 'тело fillRecordCard найдено');
    assert.match(
      fill.replace(/\/\/[^\n]*/g, ''),
      /refreshDerivedTitle\(\s*title\s*,\s*row\.title\s*,\s*row\.snippet\s*\)/,
      'карточка дорезолвит заголовок батчем',
    );
    const refresh = /function refreshDerivedTitle\([\s\S]*?\n\}/.exec(CHRONICLE)?.[0] ?? '';
    assert.ok(refresh !== '', 'тело refreshDerivedTitle найдено');
    assert.match(refresh, /resolveWikiIdsInSnippet\(/, 'батч-дорезолв через общий резолвер');
  });
});
