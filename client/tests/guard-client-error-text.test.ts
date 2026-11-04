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
 * обработчик deep-link, диалог фильтра типов связей, полоса отборов и
 * команды структурного фильтра. `lib/pure.ts::isNotFoundError` обязан читать
 * только machine-readable `code` — `reviveIpcError` восстанавливает его на
 * границе IPC (`lib/etn.ts`).
 *
 * Ловятся три формы: прямой `err.message`, приведение
 * `(err as { message }).message` и поле `message` серверного DTO
 * (`failure.message`, `failures[i].message`, алиас `first.message`).
 * Сканируются только модули, где `message` означал показ пользователю;
 * легитимные `Error.message` для журналов и отладки в других модулях не
 * затрагиваются. Модули переупаковки отказов DTO (`link-ops.ts`) дополнительно
 * обязаны бросать `EtnError` с кодом и `details`, а не plain-`Error` с
 * серверным текстом.
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
  path.join(RENDERER_ROOT, 'canvas', 'link-filter-dialog.ts'),
  path.join(RENDERER_ROOT, 'canvas', 'focus-filter-strip.ts'),
  path.join(RENDERER_ROOT, 'screens', 'structures', 'commands.ts'),
] as const;

const PURE_MODULE = path.join(RENDERER_ROOT, 'lib', 'pure.ts');

/**
 * Модули, которые пробрасывают отказ пакетной операции (`ThoughtBatchFailure`)
 * дальше в UI: обязаны бросать `EtnError` с кодом и `details`, а серверный
 * `message` — только как диагностику, не переупаковывая в plain-`Error`.
 */
const DTO_ERROR_MODULES = [path.join(RENDERER_ROOT, 'lib', 'link-ops.ts')] as const;

/** Вырезает комментарии, сохраняя переводы строк (номера строк не съезжают). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

/** Показ сырого серверного сообщения: `err.message`, `error?.message`. */
const RAW_MESSAGE = /\b(?:err|error)\s*\??\s*\.\s*message\b/;

/**
 * Приведение к структурному виду и чтение `message`:
 * `(err as { message?: unknown }).message`.
 */
const CAST_MESSAGE = /\bas\s*\{[^{}]*\bmessage\b[^{}]*\}\s*\)\s*\.\s*message\b/;

/**
 * Поле `message` серверного DTO (`failure.message`, `failures[0]?.message`,
 * `first.message`, `issue.message`, `warning.message`) — английский текст ADR
 * не для UI. Алиас `first` ловится так же, как `failure`: переименование
 * переменной не должно обходить запрет.
 */
const DTO_MESSAGE =
  /\b(?:failure|failures\s*\[[^\]]*\]|first|issue|diagnostic|warning)\s*\??\s*\.\s*message\b/;

/** Переупаковка отказа DTO в plain-`Error` (серверный текст попадёт в UI). */
const PLAIN_ERROR_WRAP = /\bnew\s+Error\s*\(/;

/** Разбор серверного текста вместо кода. */
const MESSAGE_PARSING = /\.\s*message\s*\.\s*includes\s*\(/;

function findViolations(source: string): string[] {
  const clean = stripComments(source);
  const violations: string[] = [];
  if (RAW_MESSAGE.test(clean)) violations.push('raw-message');
  if (CAST_MESSAGE.test(clean)) violations.push('cast-message');
  if (DTO_MESSAGE.test(clean)) violations.push('dto-message');
  if (MESSAGE_PARSING.test(clean)) violations.push('message-parsing');
  return violations;
}

describe('сторож: серверный error.message не показывается и не разбирается', () => {
  it('самодоказательство: синтетический показ message ловится, комментарий — нет', () => {
    assert.deepEqual(findViolations("error.textContent = err.message;"), ['raw-message']);
    assert.deepEqual(findViolations('const x = err?.message ?? null;'), ['raw-message']);
    assert.deepEqual(findViolations('const msg = (err as { message?: unknown }).message;'), [
      'cast-message',
    ]);
    assert.deepEqual(findViolations('const msg = (failure as { message: string }).message;'), [
      'cast-message',
    ]);
    assert.deepEqual(findViolations('notice(result.failures[0]?.message ?? "");'), [
      'dto-message',
    ]);
    assert.deepEqual(findViolations('notice(first.message);'), ['dto-message']);
    assert.deepEqual(findViolations('notice(failure.message);'), ['dto-message']);
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

  it('link-ops пробрасывает отказ DTO через EtnError, а не plain-Error', () => {
    for (const file of DTO_ERROR_MODULES) {
      const clean = stripComments(fs.readFileSync(file, 'utf8'));
      const relative = path.relative(RENDERER_ROOT, file);
      assert.deepEqual(
        findViolations(clean),
        [],
        `${relative}: серверный message не показывается и не переупаковывается`,
      );
      assert.ok(
        !PLAIN_ERROR_WRAP.test(clean),
        `${relative}: отказ DTO бросается как EtnError с кодом, plain-Error вернул бы английский текст в UI`,
      );
      assert.match(
        clean,
        /throw\s+new\s+EtnError\s*\(/,
        `${relative}: EtnError с кодом и details — единственная форма проброса`,
      );
    }
  });

  it('самодоказательство: new Error(first.message) и new Error(message) краснят', () => {
    const alias = 'const first = result.failures[0];\nthrow new Error(first.message);';
    assert.ok(findViolations(alias).includes('dto-message'), 'алиас first ловится как DTO');
    assert.ok(PLAIN_ERROR_WRAP.test(alias), 'plain-Error вокруг отказа DTO ловится');
    const destructured = 'const { message } = first;\nthrow new Error(message);';
    assert.ok(PLAIN_ERROR_WRAP.test(destructured), 'plain-Error с любым текстом ловится');
    const correct = 'const { code, message, details } = first;\nthrow new EtnError(code, message, details);';
    assert.ok(!findViolations(correct).includes('dto-message'));
    assert.ok(!PLAIN_ERROR_WRAP.test(correct));
  });
});
