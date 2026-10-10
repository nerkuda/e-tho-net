/**
 * Единая правка записи «Дневника» и инвариант 0757cd08 в новой модели
 * (0.12.1, ТП «Дневник без псевдослота»).
 *
 * Прежняя псевдозапись (слот) демонтирована: «Добавить» сразу создаёт запись, а
 * режим правки принадлежит карточке — заголовок и тело правятся вместе и
 * записываются ОДНИМ PATCH. Набранный текст не теряется в любом порядке ввода
 * (заголовок→тело и тело→заголовок): коммит читает ЖИВЫЕ значения обоих полей.
 *
 * Часть 1 — поведенческая: модель единого PATCH в обоих порядках ввода.
 * Часть 2 — структурная по исходнику экрана: модуль рендерера под Node без
 * Electron-каркаса не поднимается (конвенция `chronicle-home-mechanics`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { hasRowId } from '../src/renderer/screens/chronicle/diary.js';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const CHRONICLE = fs.readFileSync(
  path.join(RENDERER_ROOT, 'screens', 'chronicle', 'chronicle.ts'),
  'utf8',
);

/** Тело функции верхнего уровня по её объявлению (стиль файла: `}` в первой колонке). */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `исходник содержит «${signature}»`);
  const body = src.slice(start);
  const end = body.indexOf('\n}\n');
  assert.ok(end >= 0, `у «${signature}» найдено тело`);
  return body.slice(0, end);
}

/**
 * Модель единой записи: один PATCH несёт И заголовок, И тело — значения берутся
 * живьём в момент коммита (порядок ввода не важен).
 */
function unifiedSave(
  store: { title: string | null; body: string },
  title: string,
  body: string,
): void {
  store.title = title.trim() === '' ? null : title.trim();
  store.body = body;
}

describe('единая правка записи: оба поля пишутся одним PATCH (инвариант 0757cd08)', () => {
  it('заголовок → тело: сохраняются оба поля', () => {
    const store = { title: null as string | null, body: '' };
    unifiedSave(store, 'Встреча', 'обсудили план');
    assert.equal(store.title, 'Встреча');
    assert.equal(store.body, 'обсудили план');
  });

  it('тело → заголовок: правка заголовка не затирает текст', () => {
    const store = { title: null as string | null, body: '' };
    unifiedSave(store, '', 'обсудили план');
    assert.equal(store.title, null, 'пустой заголовок — null');
    assert.equal(store.body, 'обсудили план');
    unifiedSave(store, 'Встреча', 'обсудили план');
    assert.equal(store.title, 'Встреча');
    assert.equal(store.body, 'обсудили план', 'текст цел');
  });

  it('текст без заголовка сохраняется', () => {
    const store = { title: null as string | null, body: '' };
    unifiedSave(store, '', 'только текст');
    assert.equal(store.title, null);
    assert.equal(store.body, 'только текст');
  });
});

describe('структура экрана: единая правка и немедленное создание', () => {
  it('saveBoth шлёт один PATCH с заголовком и телом', () => {
    const fn = functionBody(CHRONICLE, 'const saveBoth = async (md: string)');
    assert.match(fn, /const nextTitle = /, 'читается живое значение заголовка');
    assert.match(
      fn,
      /\{ title: nextTitle === '' \? null : nextTitle, body_md: md \}/,
      'один PATCH несёт заголовок И тело',
    );
  });

  it('откат обоих полей — единый `cancelEdit`', () => {
    const fn = functionBody(CHRONICLE, 'const cancelEdit = (): void =>');
    assert.match(fn, /cancelMarkdownFieldEdit\(widget\)/, 'тело откатывается');
    assert.match(fn, /title\.endEdit\(false, false\)/, 'заголовок откатывается');
  });

  it('карточка в правке не пересобирается (текст не теряется)', () => {
    const fn = functionBody(CHRONICLE, 'function updateRecordCard(');
    assert.match(fn, /cardEditors\.get\(card\)\?\.editing\(\) === true\) return;/);
  });

  it('«Добавить» сразу создаёт запись и вставляет её локально', () => {
    assert.match(CHRONICLE, /^async function addRecord\(/m);
    assert.match(CHRONICLE, /kind: 'chronological',\s*\n\s*title: null,\s*\n\s*body_md: '',/);
    assert.match(CHRONICLE, /await insertCreatedRecord\(localRow\);/);
  });

  it('insertCreatedRecord дедуплицирует по id ДО вставки строки', () => {
    const fn = functionBody(CHRONICLE, 'async function insertCreatedRecord(');
    const guard = fn.indexOf('hasRowId(rows, row.id)');
    const insert = fn.indexOf('insertRowByDay(rows, row');
    assert.ok(guard >= 0 && insert >= 0 && guard < insert, 'дедуп стоит до вставки');
  });

  it('локальная вставка не добавляет вторую строку с тем же ключом', () => {
    const rows: { id: string }[] = [];
    const insertLocal = (row: { id: string }): void => {
      if (hasRowId(rows, row.id)) return;
      rows.push(row);
    };
    rows.push({ id: 'rec-1' });
    insertLocal({ id: 'rec-1' });
    assert.equal(rows.length, 1, 'дубль не появился');
    insertLocal({ id: 'rec-2' });
    assert.deepEqual(rows.map((r) => r.id), ['rec-1', 'rec-2']);
  });
});

describe('доводка цикла A: коммит только при реальном изменении', () => {
  const MARKDOWN_FIELD = fs.readFileSync(
    path.join(RENDERER_ROOT, 'editor', 'markdown-field.ts'),
    'utf8',
  );
  const CHRONO_TAB = fs.readFileSync(path.join(RENDERER_ROOT, 'editor', 'chrono-tab.ts'), 'utf8');

  it('поле коммитит при внешних изменениях (предикат), а не безусловно', () => {
    assert.match(
      MARKDOWN_FIELD,
      /if \(opts\.externalChanges\?\.\(\) === true && opts\.onSave !== undefined\) envChanged = true;/,
      'envChanged поднимается предикатом externalChanges',
    );
    assert.doesNotMatch(
      MARKDOWN_FIELD,
      /saveUnchanged/,
      'прежняя безусловная опция saveUnchanged удалена',
    );
  });

  it('экран «Дневник» коммитит только при изменении заголовка', () => {
    assert.match(
      CHRONICLE,
      /externalChanges: \(\) =>\s*\n\s*\(title !== null \? title\.value\(\)\.trim\(\) : row\.title \?\? ''\) !== \(row\.title \?\? ''\)/,
      'предикат сравнивает живой заголовок с сохранённым',
    );
  });

  it('вкладка «Дневник» коммитит только при изменении заголовка', () => {
    assert.match(
      CHRONO_TAB,
      /externalChanges: \(\) => currentTitle\(\)\.trim\(\) !== titleValue/,
      'предикат сравнивает живой заголовок с сохранённым',
    );
  });
});
