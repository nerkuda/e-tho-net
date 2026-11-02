/**
 * Сторож порядка in-flight регистрации при сохранении заголовка мысли
 * (ошибка f537f56b).
 *
 * Регистрация поля `thought.title` обязана сниматься ТОЛЬКО после завершения
 * очистки черновика: старый вариант `.then` + `void clearDraft(...)` +
 * `.finally(releaseTitleWrite)` снимал ключ сразу после возврата `.then`, а
 * IPC-удаление строки ещё летело. В этом окне волна досыла отправляла второй
 * PATCH с той же `If-Match`-версией → ложный `VERSION_CONFLICT`-тост (проба
 * верификатора с задержкой `draftDelete` 20 мс: `updates=2, conflicts=1`).
 *
 * Тест читает исходник `editor.ts` (прецедент `guard-drafts-purge-wiring`):
 * поведение окна проверяется в `drafts-lifecycle.test.ts` на боевом хелпере
 * `withDraftFieldWrite`, а здесь фиксируется, что `commitTitle` использует
 * именно его и ждёт очистку.
 *
 * Мутации, которые краснят:
 * - возврат к `.finally(releaseTitleWrite)` и `void clearDraft(...)`;
 * - исчезновение `await clearDraft`/`await clearDraftsFor` из `run`.
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

/** Тело `commitTitle` до следующего обработчика заголовка. */
function commitTitleBody(source: string): string {
  const start = source.indexOf('const commitTitle = (): void => {');
  assert.notEqual(start, -1, 'найден commitTitle в editor.ts');
  const end = source.indexOf('titleArea.addEventListener(', start);
  assert.ok(end > start, 'тело commitTitle ограничено следующим обработчиком');
  return source.slice(start, end);
}

describe('guard: сохранение заголовка держит in-flight до очистки черновика (f537f56b)', () => {
  it('commitTitle идёт через withDraftFieldWrite и ждёт очистку черновиков', () => {
    const body = commitTitleBody(read('src/renderer/editor/editor.ts'));
    // Ветка «нечего отправлять» (value пуст/совпал) законно чистит черновик
    // через void — там нет PATCH и нет in-flight регистрации. Проверяем только
    // ветку сохранения.
    const saveStart = body.indexOf('withDraftFieldWrite(');
    assert.notEqual(saveStart, -1, 'регистрация заголовка — через withDraftFieldWrite');
    const save = body.slice(saveStart);
    assert.match(
      save,
      /\{[^}]*entityType: 'thought'[^}]*field: 'title'/,
      'ключ регистрации — поле заголовка мысли',
    );
    assert.match(save, /await saveThought\(\{ title: value \}\)/, 'PATCH ожидается внутри run');
    assert.match(save, /await clearDraft\(titleDraftId\)/, 'clearDraft ожидается до release');
    assert.match(
      save,
      /await clearDraftsFor\(networkId, 'thought', thought\.id\)/,
      'clearDraftsFor ожидается до release',
    );
    assert.doesNotMatch(
      body,
      /\.finally\(releaseTitleWrite\)/,
      'регистрация не снимается в .finally до очистки',
    );
    assert.doesNotMatch(save, /void clearDraft\(titleDraftId\)/, 'очистка не вызывается без ожидания');
  });

  it('хелпер withDraftFieldWrite снимает ключ только после run (включая очистку)', () => {
    const source = read('src/renderer/drafts.ts');
    const start = source.indexOf('export async function withDraftFieldWrite');
    assert.notEqual(start, -1, 'withDraftFieldWrite экспортируется');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    const awaitRun = body.indexOf('return await run();');
    const release = body.indexOf('release();');
    assert.ok(awaitRun >= 0, 'run ожидается');
    assert.ok(release > awaitRun, 'release идёт после await run()');
    assert.match(body, /finally \{/, 'release в finally — снимается и при исключении');
  });
});
