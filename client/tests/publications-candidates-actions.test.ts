/**
 * Действия плашки кандидатов рабочей области публикации (0.11.1, задача
 * e754527d; элемент интерфейса 43ec961f): «расставить (в конец)» и «скрыть».
 *
 * Проверяется контракт проводки (исходники модулей, как в сторожах `guard-*`):
 *  * «расставить» идёт через `etn.publications.acceptCandidate` — клиент
 *    семантику отбора/принятия не реплицирует (требование 6e8bc3f0);
 *  * «скрыть» — существующее исключение (`setExcluded` → addExclusion);
 *  * строки действий берутся из словаря `t('publications.ws.*')`;
 *  * мост preload пробрасывает `publications.acceptCandidate`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = path.join(
  CLIENT_ROOT,
  'src',
  'renderer',
  'screens',
  'publications',
  'workspace.ts',
);
const PRELOAD = path.join(CLIENT_ROOT, 'src', 'preload', 'index.ts');

describe('публикации: действия плашки кандидатов (e754527d)', () => {
  it('«расставить» и «скрыть» проводятся через API-фасады и словарь', () => {
    const source = fs.readFileSync(WORKSPACE, 'utf8');
    assert.ok(
      source.includes('etn.publications.acceptCandidate('),
      '«расставить» обязано вызывать etn.publications.acceptCandidate (сервер считает сам)',
    );
    assert.ok(
      source.includes("t('publications.ws.place')"),
      'подпись «расставить» берётся из словаря publications.ws.place',
    );
    assert.ok(
      source.includes("t('publications.ws.hide')"),
      'подпись «скрыть» берётся из словаря publications.ws.hide',
    );
    assert.ok(
      /setExcluded\(item\.thought_id, true\)/.test(source),
      'действие «скрыть» использует существующее исключение (setExcluded)',
    );
    assert.ok(
      source.includes('item.breadcrumbs'),
      'в строке кандидата отображается путь в дереве (breadcrumbs, спека 43ec961f)',
    );
  });

  it('мост preload пробрасывает publications.acceptCandidate', () => {
    const source = fs.readFileSync(PRELOAD, 'utf8');
    assert.ok(
      source.includes("'publications.acceptCandidate'"),
      'preload обязан пробрасывать publications.acceptCandidate',
    );
  });
});
