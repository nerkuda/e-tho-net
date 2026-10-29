/**
 * Сторож проводки восстановления захватов (ошибка `0702efb6`, задача
 * `d3a30c3e`).
 *
 * `initLockReconnect()` (`lib/lock-guard.ts`) подписывается на переход
 * rt-статуса сети в `connected`: перечитывает кэш захватов с сервера и заново
 * берёт захваты открытых редакторов. Без вызова в `boot()` замочек
 * редактируемой мысли остаётся после переподключения — ровно симптом ошибки.
 * Юнит `lock-reconnect.test.ts` вызывает функцию САМ, поэтому удаление вызова
 * из `app.ts` он не ловит; здесь проверяется исходник: импорт и место вызова в
 * boot-последовательности.
 *
 * Контракт порядка: кэш захватов поднят (`initLockCache`) до подписки на
 * переподключение, а realtime-планировка (`initRealtime`) — после: подписка
 * читает текущий rt-статус и не должна терять первый переход из-за ещё не
 * установленного соединения.
 *
 * Мутации, которые краснят сторож: убрать вызов `initLockReconnect()`;
 * убрать его из импорта; переставить вызов после `initRealtime()` или до
 * `initLockCache()`. Комментарии правилом не считаются — пример в JSDoc
 * нарушением не будет.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
  'app.ts',
);
const APP = readFileSync(APP_PATH, 'utf8');

/** Строка — комментарий (JSDoc, блочный или однострочный). */
function isCommentLine(line: string): boolean {
  return /^\s*(?:\*|\/\/|\/\*)/.test(line);
}

/** Код исходника без строк-комментариев: пример в JSDoc правилом не считается. */
function codeLines(source: string): string[] {
  return source.split(/\r?\n/).filter((line) => !isCommentLine(line));
}

/**
 * Тело `boot()`: от сигнатуры до следующего top-level `export` (в `app.ts`
 * функции не вложены друг в друга, поэтому граница по `^export` надёжна).
 */
function bootBody(source: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('export async function boot('));
  assert.notEqual(start, -1, 'app.ts: не найдена сигнатура boot()');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^export\b/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

it('app.ts импортирует initLockReconnect из lib/lock-guard', () => {
  const importLine = codeLines(APP).find((line) => line.includes("from './lib/lock-guard.js'"));
  assert.notEqual(importLine, undefined, 'нет импорта из ./lib/lock-guard.js');
  assert.match(
    importLine ?? '',
    /\binitLockReconnect\b/,
    `импорт lock-guard не несёт initLockReconnect:\n${importLine ?? ''}`,
  );
});

it('boot() вызывает initLockReconnect между initLockCache и initRealtime', () => {
  const body = codeLines(bootBody(APP)).join('\n');
  const cacheAt = body.indexOf('initLockCache();');
  const reconnectAt = body.indexOf('initLockReconnect();');
  const realtimeAt = body.indexOf('initRealtime();');

  assert.notEqual(reconnectAt, -1, `boot() не вызывает initLockReconnect():\n${body}`);
  assert.notEqual(cacheAt, -1, `boot() не вызывает initLockCache():\n${body}`);
  assert.notEqual(realtimeAt, -1, `boot() не вызывает initRealtime():\n${body}`);
  assert.ok(
    cacheAt < reconnectAt,
    'initLockReconnect() стоит до initLockCache(): подписка на переподключение ' +
      'обязана видеть поднятый кэш захватов (ошибка 0702efb6)',
  );
  assert.ok(
    reconnectAt < realtimeAt,
    'initLockReconnect() стоит после initRealtime(): подписка на переподключение ' +
      'должна быть подключена до старта realtime-планировки (ошибка 0702efb6)',
  );
});
