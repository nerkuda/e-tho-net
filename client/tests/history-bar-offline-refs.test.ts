/**
 * Панель истории: заголовки облачков не зависят от соединения (ошибка 90a92c82).
 *
 * `resolveRefs` обязан сначала смотреть в нормализованный кэш слоя
 * (`getEntity`), а серверный резолв лишь ДОПОЛНЯТЬ им (`commitEntity`). Иначе
 * при офлайне резолв падает, карта пуста, и облачко показывает сырой id вместо
 * заголовка. Тест-сторож — по исходнику: поведение `resolveRefs` требует живого
 * `window.etn`, а сам контракт «кэш раньше сервера» виден в коде.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const SRC = readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'history-bar.ts'),
  'utf8',
);

describe('панель истории: офлайн-заголовки из снапшота (90a92c82)', () => {
  it('резолв читает нормализованный кэш и дополняет его серверным ответом', () => {
    assert.match(
      SRC,
      /getEntity<[^>]*>\('thought', id\)/,
      'id ищется в нормализованном кэше слоя',
    );
    assert.match(
      SRC,
      /commitEntity\('thought', ref\.id, ref\)/,
      'серверный ответ кладётся в кэш для следующих (в том числе офлайн) рендеров',
    );
    assert.ok(
      !/return new Map\(resolved\.map/.test(SRC),
      'нельзя отдавать только серверную карту — при офлайне она пуста',
    );
  });
});
