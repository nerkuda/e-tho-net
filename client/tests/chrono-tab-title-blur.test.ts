/**
 * Вкладка «Дневник» редактора: немедленное создание записи и единая правка
 * (0.12.1, ТП «Дневник без псевдослота»; ранее ошибка 36b4d7b1).
 *
 * Прежняя модель создавала запись по непустому заголовку при уходе фокуса
 * (`commitMeta`) — от неё отказ: «Добавить» СРАЗУ создаёт обычную пустую
 * хроно-запись владельца вкладки, а заголовок и тело правятся вместе и
 * записываются ОДНИМ PATCH (требование 26f0aa52).
 *
 * Проверка структурная по исходнику (DOM-монтирование вкладки требует сети и
 * store) — конвенция `chrono-tab-header.test.ts`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

describe('вкладка «Дневник»: немедленное создание и единая правка (26f0aa52)', () => {
  it('«Добавить» сразу создаёт пустую хроно-запись владельца вкладки', () => {
    const src = read('editor/chrono-tab.ts');
    assert.match(src, /async function startNew\(\): Promise<void>/, 'создание ведёт `startNew`');
    assert.match(
      src,
      /kind: 'chronological',\s*\n\s*title: null,\s*\n\s*body_md: '',/,
      'запись создаётся сразу, без заголовка и текста',
    );
    assert.ok(!/commitMeta/.test(src), 'прежний `commitMeta` (создание по blur) упразднён');
  });

  it('единая запись шлёт ОДИН PATCH с заголовком и телом', () => {
    const src = read('editor/chrono-tab.ts');
    assert.match(src, /const saveBoth = async \(md: string\)/, 'единая запись — `saveBoth`');
    assert.match(src, /title: nextTitle === '' \? null : nextTitle,/, 'заголовок в патче');
    assert.match(src, /body_md: md,/, 'тело в том же патче');
    assert.ok(
      !/md\.trim\(\) === '' && commentId === null/.test(src),
      'ветка «пусто и нет id — не создавать» убрана (запись уже создана)',
    );
  });

  it('заголовок: в просмотре — текст, в правке — поле ввода', () => {
    const src = read('editor/chrono-tab.ts');
    assert.match(src, /function showTitleView\(\): void \{/, 'просмотр заголовка');
    assert.match(src, /titleView\.textContent = titleLabel\(\)/, 'просмотр — текст');
    assert.match(src, /function showTitleEdit\(focus: boolean\): void \{/, 'правка заголовка — поле');
    assert.match(src, /titleBox\.replaceChildren\(titleInput\)/, 'в правке вместо текста — поле');
  });

  it('Esc/«Отменить» откатывают оба поля, Enter из заголовка ведёт в тело', () => {
    const src = read('editor/chrono-tab.ts');
    assert.match(src, /cancelMarkdownFieldEdit\(widget\)/, 'откат тела');
    assert.match(src, /if \(titleBox\.contains\(titleInput\)\) showTitleView\(\)/, 'откат заголовка');
    assert.match(src, /focusMarkdownFieldStart\(w\)/, 'Enter из заголовка — фокус в тело (позиция 0)');
    assert.match(src, /commitMarkdownField\(w\)/, 'Ctrl+Enter — запись обоих полей');
  });
});
