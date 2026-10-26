/**
 * Сторож контракта моста «поле поиска → список» (стандарт b6b2821d,
 * задача 15236418).
 *
 * Правило: вызов `bindSearchNav(search, { handleKey })` обязан передавать
 * модификаторы нажатия в обработчик списка —
 * `handleKey: (key, modifiers) => target.handleKey(key, modifiers)`.
 * Иначе Ctrl+↑/↓ из поля поиска приходит в фасад как обычная ↑/↓ (или теряется
 * вовсе), и сворачивание группы/полки из поиска молча перестаёт работать.
 * Мост не разбирает клавиши повторно — он лишь пробрасывает событие.
 *
 * Почему отдельный сторож: тест моста (`lib-ui-list-nav.test.ts`) проверяет
 * сам мост, но не потребителей. Возврат к прежней форме
 * `handleKey: (key) => nav.handleKey(key)` в любом экране проходит остальные
 * тесты зелёными — ловится только структурной проверкой вызовов.
 *
 * Область — `src/renderer/**`, кроме самого моста (`lib/ui/search-nav.ts`,
 * там объявление функции, а не подключение). SAM-проверка: фикстура без
 * модификаторов обязана краснеть.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { listSourceFiles } from './guard-helpers.js';

const RENDERER = path.resolve(import.meta.dirname, '..', 'src', 'renderer');

/** Объявление моста: вызовы ищем только у потребителей. */
const BRIDGE_DECLARATION = 'lib/ui/search-nav.ts';

/**
 * Потребители моста: у каждого обязано быть подключение с модификаторами.
 * Перечень фиксирует охват явно — новый потребитель без записи сюда всё равно
 * проверяется сканированием каталога, но сломать существующий незаметно нельзя.
 */
const BRIDGE_CONSUMERS = [
  'lib/property-list.ts',
  'lib/saved-filter-bar.ts',
  'lib/entity-picker.ts',
  'screens/publications/publications.ts',
  'editor/attachment-picker.ts',
  'editor/attachments.ts',
  'trash.ts',
  'admin/admin.ts',
  'screens/type-manager.ts',
  'screens/property-manager.ts',
] as const;

/** Один вызов `bindSearchNav(` с номером строки и текстом до `);`. */
interface BridgeCall {
  line: number;
  chunk: string;
}

/** Все вызовы моста в исходнике. Аргументы вызова заканчиваются на `);`. */
export function bridgeCalls(source: string): BridgeCall[] {
  const out: BridgeCall[] = [];
  // `unbindSearchNav(` — не вызов моста: перед `bindSearchNav(` не должно быть
  // символа идентификатора (иначе снятие подписки считалось бы подключением).
  const call = /(?<![\w$])bindSearchNav\(/g;
  for (let match = call.exec(source); match !== null; match = call.exec(source)) {
    const start = match.index;
    const end = source.indexOf(');', start);
    const stop = end < 0 ? source.length : end + 2;
    out.push({
      line: source.slice(0, start).split('\n').length,
      chunk: source.slice(start, stop),
    });
  }
  return out;
}

/**
 * Нарушение контракта: обработчик не принимает `modifiers` либо не передаёт
 * их в `handleKey` цели. Проверяются обе половины — иначе форма
 * `(key, modifiers) => nav.handleKey(key)` потеряет Ctrl так же молча.
 */
export function violatesBridgeContract(chunk: string): boolean {
  if (!/handleKey:/.test(chunk)) return true;
  if (!/handleKey:\s*\([^)]*\bmodifiers\b[^)]*\)\s*=>/.test(chunk)) return true;
  return !/\.handleKey\(\s*key\s*,\s*modifiers\s*\)/.test(chunk);
}

/** Нарушения в каталоге: `путь:строка`. */
export function findBridgeContractViolations(rootDir: string): string[] {
  const out: string[] = [];
  for (const file of listSourceFiles(rootDir, { extensions: ['.ts'] })) {
    const rel = path.relative(rootDir, file).replace(/\\/g, '/');
    if (rel === BRIDGE_DECLARATION) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('bindSearchNav(')) continue;
    for (const call of bridgeCalls(source)) {
      if (violatesBridgeContract(call.chunk)) out.push(`${rel}:${call.line}`);
    }
  }
  return out.sort();
}

/** Файлы каталога, подключающие мост (для проверки охвата перечня). */
export function bridgeConsumerFiles(rootDir: string): string[] {
  const out: string[] = [];
  for (const file of listSourceFiles(rootDir, { extensions: ['.ts'] })) {
    const rel = path.relative(rootDir, file).replace(/\\/g, '/');
    if (rel === BRIDGE_DECLARATION) continue;
    if (bridgeCalls(fs.readFileSync(file, 'utf8')).length > 0) out.push(rel);
  }
  return out.sort();
}

describe('guard: мост поиска передаёт модификаторы (15236418, стандарт b6b2821d)', () => {
  it('все вызовы bindSearchNav передают модификаторы в handleKey', () => {
    const found = findBridgeContractViolations(RENDERER);
    assert.deepEqual(
      found,
      [],
      `Вызовы bindSearchNav без передачи модификаторов: ${found.join(', ')}. ` +
        'Форма обязательна: `handleKey: (key, modifiers) => target.handleKey(key, modifiers)` — ' +
        'иначе Ctrl+↑/↓ из поля поиска читается списком как обычная ↑/↓ (стандарт b6b2821d).',
    );
  });

  it('перечень потребителей моста полон и каждый подключает мост', () => {
    const files = bridgeConsumerFiles(RENDERER);
    for (const rel of BRIDGE_CONSUMERS) {
      assert.ok(files.includes(rel), `${rel}: перечень потребителей устарел — мост не найден`);
    }
  });

  it('правило краснеет на вызове без модификаторов (самопроверка)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-search-nav-mods-'));
    try {
      fs.mkdirSync(path.join(dir, 'fresh'));
      // Нарушение: модификаторы не принимаются и не передаются.
      fs.writeFileSync(
        path.join(dir, 'fresh', 'old-form.ts'),
        'bindSearchNav(input, { handleKey: (key) => table.handleKey(key) });\n',
        'utf8',
      );
      assert.deepEqual(
        findBridgeContractViolations(dir),
        ['fresh/old-form.ts:1'],
        'вызов без модификаторов обязан попадать в нарушение',
      );
      // Правильная форма — в том числе многострочная, как в живых потребителях.
      fs.writeFileSync(
        path.join(dir, 'fresh', 'new-form.ts'),
        'bindSearchNav(input, { handleKey: (key, modifiers) => table.handleKey(key, modifiers) });\n' +
          'bindSearchNav(search, {\n' +
          '  handleKey: (key, modifiers) => nav?.handleKey(key, modifiers) === true,\n' +
          '});\n',
        'utf8',
      );
      assert.deepEqual(findBridgeContractViolations(dir), ['fresh/old-form.ts:1']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
