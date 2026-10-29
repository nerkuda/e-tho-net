/**
 * Сторож проводки сообщений об отказе подключения (ошибка 390e9746).
 *
 * Все три пути подключения обязаны называть адрес и фактическую причину через
 * `lib/connect-failure.ts::describeConnectFailure`:
 *
 *  1. выбор сохранённого сервера на экране подключения (`connectProfile`);
 *  2. форма нового подключения — после локальной валидации (`submitForm`);
 *  3. автоподключение при запуске (`boot`) — причина передаётся онбордингу,
 *     а не теряется молча (`takeBootConnectFailure`).
 *
 * Вернувшийся `errText(err)` в этих ветках — ровно регресс ошибки: «затычка»
 * «сервер недоступен, попробуйте позже» без адреса и причины. Юнит
 * `connect-failure.test.ts` проверяет сам форматтер, поэтому подмену вызова
 * ловит именно этот сторож.
 *
 * Мутации, которые краснят: вернуть `connectError.textContent = errText(err)`
 * в `connectProfile`; вернуть `formError.textContent = errText(err)` в
 * `submitForm`; убрать `bootConnectFailure = describeConnectFailure(...)` из
 * catch в `boot()`; убрать показ `takeBootConnectFailure()` на онбординге.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

function read(rel: string): string {
  return readFileSync(path.join(RENDERER_ROOT, rel), 'utf8');
}

/** Строка — комментарий (JSDoc, блочный или однострочный). */
function isCommentLine(line: string): boolean {
  return /^\s*(?:\*|\/\/|\/\*)/.test(line);
}

/** Код файла без комментариев: примеры в JSDoc правилом не считаются. */
function code(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !isCommentLine(line))
    .join('\n');
}

/** Отрезок кода от маркера до следующего маркера (или до конца файла). */
function slice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `не найден маркер «${startMarker}»`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

const ONBOARDING = code(read('screens/onboarding.ts'));
const APP = code(read('app.ts'));

describe('сторож: отказ подключения показывает адрес и причину (390e9746)', () => {
  it('выбор сохранённого сервера: describeConnectFailure, не errText', () => {
    const block = slice(ONBOARDING, 'async function connectProfile(', 'async function loadProfiles(');
    assert.match(block, /describeConnectFailure\(err,/, 'причина отказа сохранённого сервера');
    assert.doesNotMatch(block, /errText\(/, 'errText в ветке отказа сохранённого сервера');
  });

  it('форма нового подключения: describeConnectFailure, не errText', () => {
    const block = slice(ONBOARDING, 'async function submitForm(', 'void loadProfiles();');
    assert.match(block, /describeConnectFailure\(err,/, 'причина отказа формы подключения');
    assert.doesNotMatch(block, /errText\(/, 'errText в ветке отказа формы');
  });

  it('онбординг показывает отказ автоподключения при запуске', () => {
    assert.match(ONBOARDING, /takeBootConnectFailure\(\)/, 'сообщение автоподключения');
  });

  it('boot() запоминает причину отказа автоподключения', () => {
    const block = slice(APP, 'export async function boot(', 'export function initKeyboard(');
    assert.match(block, /bootConnectFailure = describeConnectFailure\(err,/, 'причина отказа в boot()');
  });
});
