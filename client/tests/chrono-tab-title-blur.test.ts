/**
 * Вкладка «Дневник» редактора: псевдо-запись становится реальной по непустому
 * заголовку (ошибка 36b4d7b1). До правки метаданные сохранял `commitMeta`,
 * который для новой записи (`commentId === null`) выходил сразу, поэтому
 * заполненный заголовок при уходе фокуса терялся. Паритет с экраном «Дневник»:
 * непустой заголовок сам по себе — содержание (`hasRecordContent`, требование
 * 26f0aa52). Спека: 7310d077 «Вкладка «Дневник» редактора».
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

/** Тело функции `commitMeta` вкладки (до закрывающей `};` на её отступе). */
function commitMetaBody(src: string): string {
  const start = src.indexOf('const commitMeta = (): void => {');
  assert.notEqual(start, -1, 'commitMeta найдена в исходнике');
  return src.slice(start, src.indexOf('\n    };', start));
}

describe('вкладка «Дневник»: псевдо-запись по непустому заголовку (ошибка 36b4d7b1)', () => {
  it('blur заголовка создаёт новую запись при непустом заголовке', () => {
    const src = read('editor/chrono-tab.ts');
    assert.match(
      src,
      /titleInput\.addEventListener\('blur', commitMeta\)/,
      'заголовок сохраняется по blur',
    );
    const body = commitMetaBody(src);
    assert.match(body, /if \(title === null\) return;/, 'пустой заголовок запись не создаёт');
    assert.match(body, /etn\.comments\.create\(/, 'непустой заголовок новой записи создаёт её');
    assert.ok(body.includes("kind: 'chronological'"), 'создаётся дневниковая (chronological) запись');
    assert.ok(body.includes('selectedId = created.id'), 'новая запись становится текущей');
    assert.ok(body.includes('activeRowId = created.id'), 'новая запись связывается с областью правки');
  });

  it('для существующей записи по-прежнему update — дубля создания нет', () => {
    const body = commitMetaBody(read('editor/chrono-tab.ts'));
    assert.match(body, /etn\.comments\.update\(/, 'метаданные существующей записи обновляются');
  });
});
