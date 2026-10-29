/**
 * Сторож проводки чистки черновиков при старте (ошибка fb9d6058, п.5 и п.10
 * решений предполёта).
 *
 * Пурж обязан жить в main-процессе и срабатывать СРАЗУ после открытия local.db
 * и ДО регистрации IPC/создания окна: renderer не должен ни увидеть строку
 * прошлого запуска, ни досылать её. Тест читает исходник `client/src/main/index.ts`
 * (прецедент `guard-lock-reconnect-wiring.test.ts`): порядок вызовов проверяется
 * по позициям, а не по поведению — настоящий better-sqlite3 в клиентских тестах
 * не поднимается (Electron ABI).
 *
 * Мутации, которые краснят:
 * - перенос `purgeStaleDrafts` после `registerIpc`/`createWindow`;
 * - удаление записи счётчика в `client_meta` (сообщение пользователю пропадёт);
 * - появление зависимости `drafts-purge.ts` от `better-sqlite3`/`electron`
 *   (модуль перестаёт быть тестируемым швом);
 * - исчезновение вызова `reportStartupPurge` из `initDrafts` (счётчик никто не
 *   прочитает и не покажет).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(CLIENT_ROOT, rel), 'utf8');
}

/** Позиция обязательного фрагмента; отсутствие — читаемое падение. */
function position(source: string, needle: string, what: string): number {
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `не найден обязательный фрагмент (${what}): ${needle}`);
  return at;
}

describe('guard: чистка черновиков при старте (fb9d6058)', () => {
  it('main чистит черновики после открытия local.db и до registerIpc/createWindow', () => {
    const source = read('src/main/index.ts');
    const dbOpen = position(source, 'localDb = new LocalDb({', 'открытие локальной БД');
    const purge = position(source, 'purgeStaleDrafts(localDb)', 'вызов пуржа');
    const registerIpcCall = position(source, 'ipc = registerIpc({', 'регистрация IPC');
    const windowCreate = position(source, 'const win = createWindow(', 'создание окна');
    assert.ok(dbOpen < purge, 'пурж идёт после открытия local.db');
    assert.ok(purge < registerIpcCall, 'пурж идёт ДО регистрации IPC');
    assert.ok(purge < windowCreate, 'пурж идёт ДО создания окна');
    // Счётчик уезжает в client_meta — иначе стартовое сообщение не показать.
    assert.match(
      source,
      /localDb\.setMeta\(CLIENT_META_KEY\.DRAFTS_PURGED_COUNT/,
      'счётчик пуржа записывается в client_meta',
    );
  });

  it('модуль пуржа не тянет SQLite/Electron — остаётся тестируемым швом', () => {
    const source = read('src/main/db/drafts-purge.ts');
    assert.doesNotMatch(source, /from 'better-sqlite3'/, 'без better-sqlite3');
    assert.doesNotMatch(source, /from 'electron'/, 'без electron');
  });

  it('renderer сообщает о чистке из initDrafts и очищает ключ', () => {
    const source = read('src/renderer/drafts.ts');
    const init = position(source, 'export function initDrafts(): void {', 'initDrafts');
    const initBody = source.slice(init, source.indexOf('\nexport ', init + 1));
    assert.match(initBody, /void reportStartupPurge\(\);/, 'initDrafts зовёт reportStartupPurge');
    assert.match(
      source,
      /CLIENT_META_KEY\.DRAFTS_PURGED_COUNT,\s*''\)/,
      'прочитанный счётчик очищается — сообщение не повторяется',
    );
  });
});
