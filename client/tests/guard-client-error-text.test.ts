/**
 * Сторож: клиент не показывает и не разбирает серверный `error.message`
 * (ADR daab6ac4 §4, задача 4f6c972a).
 *
 * Норма ADR: `error.message` — канонический английский диагностический текст
 * для разработчиков, агентов и журналов. Клиент строит пользовательский текст
 * по `code` → `details.reason`/`details.issue` → общий текст (`lib/dom.ts`,
 * `errText`) и НЕ определяет причину по тексту.
 *
 * Сторож проверяет места, где раньше показывался сырой `err.message`:
 * мастер публикации, футер диалога обновления, модель отказа `apply`,
 * обработчик deep-link. `lib/pure.ts::isNotFoundError` обязан читать только
 * machine-readable `code` — `reviveIpcError` восстанавливает его на границе
 * IPC (`lib/etn.ts`).
 *
 * Самодоказательство: синтетический исходник с показом `err.message`
 * детектируется, а комментарий о запрете — нет.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Модули, которые обязаны локализовать ошибку через `errText`. */
const ERR_TEXT_MODULES = [
  path.join(RENDERER_ROOT, 'screens', 'publications', 'wizard.ts'),
  path.join(RENDERER_ROOT, 'lib', 'server-update-dialog.ts'),
  path.join(RENDERER_ROOT, 'lib', 'server-update.ts'),
  path.join(RENDERER_ROOT, 'editor', 'deep-link-handler.ts'),
] as const;

const PURE_MODULE = path.join(RENDERER_ROOT, 'lib', 'pure.ts');

/** Вырезает комментарии, сохраняя переводы строк (номера строк не съезжают). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

/** Показ сырого серверного сообщения: `err.message`, `error?.message`. */
const RAW_MESSAGE = /\b(?:err|error)\s*\??\s*\.\s*message\b/;

/** Разбор серверного текста вместо кода. */
const MESSAGE_PARSING = /\.\s*message\s*\.\s*includes\s*\(/;

function findViolations(source: string): string[] {
  const clean = stripComments(source);
  const violations: string[] = [];
  if (RAW_MESSAGE.test(clean)) violations.push('raw-message');
  if (MESSAGE_PARSING.test(clean)) violations.push('message-parsing');
  return violations;
}

describe('сторож: серверный error.message не показывается и не разбирается', () => {
  it('самодоказательство: синтетический показ message ловится, комментарий — нет', () => {
    assert.deepEqual(findViolations("error.textContent = err.message;"), ['raw-message']);
    assert.deepEqual(findViolations('const x = err?.message ?? null;'), ['raw-message']);
    assert.deepEqual(findViolations("if (err.message.includes('not found')) return true;"), [
      'raw-message',
      'message-parsing',
    ]);
    assert.deepEqual(findViolations('// err.message пользователю не показываем'), []);
  });

  it('модули с ошибками действий используют локализацию, а не сырой message', () => {
    for (const file of ERR_TEXT_MODULES) {
      const clean = stripComments(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(
        findViolations(clean),
        [],
        `${path.relative(RENDERER_ROOT, file)}: серверный message не показывается`,
      );
      assert.match(
        clean,
        /import \{[^}]*\berrText\b[^}]*\} from '[^']*dom\.js'/,
        `${path.relative(RENDERER_ROOT, file)}: текст ошибки — через errText`,
      );
    }
  });

  it('isNotFoundError читает machine-readable code, а не текст', () => {
    const clean = stripComments(fs.readFileSync(PURE_MODULE, 'utf8'));
    assert.deepEqual(findViolations(clean), [], 'lib/pure.ts: текст ошибки не разбирается');
    const body = /export function isNotFoundError\([\s\S]*?\n\}/.exec(clean)?.[0] ?? '';
    assert.match(body, /code === 'NOT_FOUND'/, 'причина — по коду');
    assert.ok(!body.includes('.message'), 'сообщение в определении причины не участвует');
  });
});
