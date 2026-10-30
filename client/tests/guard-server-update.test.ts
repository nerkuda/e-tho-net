/**
 * Сторож обновления сервера из клиента (элемент c9c96e5c, задача ca26c59d,
 * тех.проект 2d9f5cc7).
 *
 * Правила (DoD задачи):
 *
 * 1. **Одно место запуска.** `applyServerUpdate` (IPC → `systemUpdateApply`
 *    rest-клиента) вызывается РОВНО из диалога обновления
 *    (`lib/server-update-dialog.ts`), и в нём — ровно один вызов. Второй
 *    вызов «на всякий случай» создал бы второе задание и второе скачивание
 *    установщика.
 * 2. **Нет автоповтора.** У `systemUpdateApply` в rest-клиенте `retry: false`:
 *    повтор `POST /system/update/apply` неидемпотентен. Проверяется тело
 *    метода, а не файл целиком — `retry: false` других вызовов правила не
 *    нарушают.
 * 3. **Поднятый тайм-аут.** Тот же метод обязан передавать `timeoutMs` из
 *    `UPDATE_APPLY_TIMEOUT_MS`: сервер отвечает только после скачивания
 *    установщика и проверки SHA-256 (до 10 минут), общий тайм-аут 30 с дал бы
 *    ложный обрыв.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { listSourceFiles } from './guard-helpers.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');
const REST_CLIENT = path.join(CLIENT_ROOT, 'src', 'main', 'net', 'rest-client.ts');
const DIALOG_MODULE = path.join(RENDERER_ROOT, 'lib', 'server-update-dialog.ts');

/** Все вызовы `applyServerUpdate(` в исходнике. */
const APPLY_CALL = /\bapplyServerUpdate\s*\(/g;

/** Число совпадений регулярки в тексте. */
function countMatches(text: string, pattern: RegExp): number {
  return text.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))
    ?.length ?? 0;
}

describe('guard: обновление сервера — одно место запуска (ca26c59d)', () => {
  it('applyServerUpdate вызывается только из диалога обновления', () => {
    const callers: string[] = [];
    for (const abs of listSourceFiles(RENDERER_ROOT)) {
      const relative = path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/');
      const source = fs.readFileSync(abs, 'utf8');
      if (countMatches(source, APPLY_CALL) > 0) callers.push(relative);
    }
    assert.deepEqual(
      callers,
      ['lib/server-update-dialog.ts'],
      'запуск обновления — единственная точка входа в диалоге; второй вызов создал бы второе задание',
    );
  });

  it('в диалоге ровно один вызов applyServerUpdate (нет циклов автоповтора)', () => {
    const source = fs.readFileSync(DIALOG_MODULE, 'utf8');
    assert.equal(countMatches(source, APPLY_CALL), 1, 'один запуск на диалог');
  });

  it('systemUpdateApply в rest-клиенте идёт с retry: false и поднятым тайм-аутом', () => {
    const source = fs.readFileSync(REST_CLIENT, 'utf8');
    const start = source.indexOf('public async systemUpdateApply');
    assert.ok(start >= 0, 'метод systemUpdateApply найден');
    // Тело метода — до следующего объявления method-уровня (отступ 2 пробела).
    const rest = source.slice(start);
    const endMatch = /\n {2}\}\n/.exec(rest);
    const body = endMatch === null ? rest : rest.slice(0, endMatch.index + endMatch[0].length);
    assert.match(body, /retry:\s*false/, 'автоповтор apply запрещён на уровне клиента');
    assert.match(
      body,
      /timeoutMs:\s*opts\?\.timeoutMs\s*\?\?\s*UPDATE_APPLY_TIMEOUT_MS/,
    );
  });

  it('опрос прогресса — цепочка setTimeout, без setInterval-шторма', () => {
    const source = fs.readFileSync(DIALOG_MODULE, 'utf8');
    assert.equal(countMatches(source, /setInterval\s*\(/), 0, 'интервал-шторм запрещён');
    assert.ok(countMatches(source, /setTimeout\s*\(/) >= 1, 'следующий опрос планируется по таймеру');
  });
});
