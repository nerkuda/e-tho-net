/**
 * Сторож проводки предзаполнения подключения от установщика
 * (ошибка 0f8dd0f3, п.6 карточки 860def0d).
 *
 * Поведенческие тесты проверяют концы цепочки по отдельности:
 * `connect-prefill.test.ts` — разбор argv, `onboarding-connect-prefill.test.ts`
 * — заполнение формы при готовом ответе моста. Середина (main разбирает argv и
 * отдаёт значение через IPC, preload объявляет метод, контракт его описывает)
 * иначе рвётся молча: форма останется пустой, а оба теста — зелёными.
 *
 * Мутации, которые краснят: убрать `parseConnectArgs(process.argv)` из
 * `main/index.ts`; не передать `connectPrefill` в `registerIpc`; убрать
 * `handlers.set('server.connectPrefill'`; не объявить метод в preload или
 * контракте; перестать читать его на онбординге.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function read(rel: string): string {
  return readFileSync(path.join(SRC_ROOT, rel), 'utf8');
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

describe('проводка connect-предзаполнения установщика → клиент', () => {
  it('main разбирает argv и передаёт предзаполнение в IPC', () => {
    const main = code(read('main/index.ts'));
    assert.match(main, /parseConnectArgs\(process\.argv\)/);
    assert.match(main, /connectPrefill/);
    assert.match(main, /registerIpc\(\{/);
  });

  it('register отдаёт предзаполнение обработчику', () => {
    const register = code(read('main/ipc/register.ts'));
    assert.match(register, /connectPrefill/);
    assert.match(register, /getConnectPrefill:/);
  });

  it('handler server.connectPrefill существует', () => {
    const handlers = code(read('main/ipc/handlers.ts'));
    assert.match(handlers, /handlers\.set\(\s*'server\.connectPrefill'/);
    assert.match(handlers, /deps\.getConnectPrefill\(\)/);
  });

  it('preload и контракт объявляют server.connectPrefill', () => {
    const preload = code(read('preload/index.ts'));
    assert.match(preload, /connectPrefill:\s*\(\)\s*=>\s*invoke\('server\.connectPrefill'\)/);
    const contract = code(read('main/ipc/contract.ts'));
    assert.match(contract, /connectPrefill\(\):\s*Promise<ConnectPrefill \| null>/);
  });

  it('онбординг читает предзаполнение и заполняет поля', () => {
    const onboarding = code(read('renderer/screens/onboarding.ts'));
    assert.match(onboarding, /etn\.server\.connectPrefill\(\)/);
    assert.match(onboarding, /labelInput\.value = prefill\.name/);
    assert.match(onboarding, /urlInput\.value = prefill\.url/);
  });
});
