/**
 * Сторож локализации (задача 57f09136, требование 0e5ff1c6 «Локализация: все
 * строки интерфейса — из словаря, с подстановками параметров»).
 *
 * Правило: пользовательские строки берутся только из словаря (`lib/i18n.ts` +
 * каталоги `lib/locales/*`), а не пишутся литералами в разметке. Проверяются
 * три запрета/инварианта:
 *
 * 1. **Литералы в переведённых местах.** В `lib/ui/*`, `lib/dialog.ts` и в
 *    самом каркасе (`lib/i18n.ts`, `lib/lang.ts`) нет строковых литералов с
 *    кириллицей — только вызовы `t('…')`. Комментарии (в т.ч. JSDoc) не
 *    считаются: они не попадают в интерфейс.
 * 2. **Целостность словаря.** Каждый ключ из `t('…')` в исходниках рендерера
 *    есть в каталоге `ru` — опечатка не доедет до пользователя.
 * 3. **Полнота каталога.** У каждого ключа `ru` непустой русский текст —
 *    «перевод» не может остаться заглушкой.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, listSourceFiles } from './guard-helpers.js';
import { ru } from '../src/renderer/lib/locales/ru.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Строковый литерал, содержащий кириллицу. */
const CYRILLIC_LITERAL = /['"`][^'"`\n]*[А-Яа-яЁё][^'"`\n]*['"`]/;

/** Файлы, где пользовательских литералов быть не должно вовсе. */
const TRANSLATED_FILES = (rel: string): boolean =>
  rel.startsWith('lib/ui/') ||
  rel === 'lib/dialog.ts' ||
  rel === 'lib/i18n.ts' ||
  rel === 'lib/lang.ts';

/** Комментарий (строчный, блочный или строка JSDoc) — не разметка. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Ключи, встречающиеся в коде как `t('ключ'…)` (комментарии не считаются). */
function collectUsedKeys(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const call = /(?<![\w$.])t\(\s*'([^']+)'/g;
  for (const abs of listSourceFiles(RENDERER_ROOT)) {
    const rel = path.relative(RENDERER_ROOT, abs).replace(/\\/g, '/');
    if (rel.startsWith('lib/locales/')) continue; // сам словарь
    const source = fs.readFileSync(abs, 'utf8');
    for (const line of source.split('\n')) {
      if (isCommentLine(line)) continue; // примеры в JSDoc — не вызовы
      for (const match of line.matchAll(call)) {
        const key = match[1]!;
        const list = used.get(key) ?? [];
        list.push(rel);
        used.set(key, list);
      }
    }
  }
  return used;
}

describe('guard: локализация lib/ui и каркаса диалога', () => {
  it('в переведённых местах нет русских строковых литералов', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-russian-literals-outside-dictionary',
        description:
          'Пользовательские строки берутся из словаря `lib/i18n.ts` через ' +
          "`t('ключ')`: в `lib/ui/*`, `lib/dialog.ts`, `lib/i18n.ts` и " +
          '`lib/lang.ts` русских литералов в разметке нет (требование 0e5ff1c6).',
        pattern: CYRILLIC_LITERAL,
        include: TRANSLATED_FILES,
        allow: (_rel, line) => isCommentLine(line),
      },
    ]);
  });

  it('каждый ключ из t(…) есть в словаре ru', () => {
    const missing = [...collectUsedKeys().keys()].filter(
      (key) => !(key in ru),
    );
    assert.deepEqual(
      missing,
      [],
      `Ключи без строки в словаре ru: ${missing.join(', ')}`,
    );
  });

  it('каждый ключ словаря ru имеет непустой русский текст', () => {
    const empty = Object.entries(ru)
      .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
      .map(([key]) => key);
    assert.deepEqual(empty, [], `Пустые значения словаря ru: ${empty.join(', ')}`);
    const nonRussian = Object.entries(ru)
      .filter(([, value]) => !/[А-Яа-яЁё]/.test(value))
      .map(([key]) => key);
    assert.deepEqual(nonRussian, [], `Ключи без русского текста: ${nonRussian.join(', ')}`);
  });
});
