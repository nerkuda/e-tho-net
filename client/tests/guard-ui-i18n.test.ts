/**
 * Сторож локализации (задачи 57f09136, 3c9f23dc; требование 0e5ff1c6
 * «Локализация: все строки интерфейса — из словаря, с подстановками
 * параметров»).
 *
 * Правило: пользовательские строки берутся только из словаря (`lib/i18n.ts` +
 * каталоги `lib/locales/*`), а не пишутся литералами в разметке. Проверяются
 * три запрета/инварианта:
 *
 * 1. **Литералы в renderer.** Во всём `client/src/renderer` нет строковых
 *    литералов с кириллицей — только вызовы `t('…')`/`tp('…')`. Границы
 *    исключений минимальны и перечислены ниже.
 * 2. **Целостность словаря.** Каждый ключ из `t('…')`/`tp('…')` в исходниках
 *    рендерера есть в каталоге `ru` — опечатка не доедет до пользователя.
 * 3. **Полнота каталога.** У каждого ключа `ru` непустой русский текст —
 *    «перевод» не может остаться заглушкой.
 *
 * Исключения (только они и ничего больше):
 * - `lib/locales/**` — сам словарь и тестовая локаль `zz`: там тексты и есть
 *   содержимое;
 * - строки-комментарии (`//`, `/*`, `*`) — в интерфейс не попадают;
 * - строки с маркером `// i18n: technical` — технические сообщения: тексты
 *   `throw new Error(…)` о контракте для разработчика и диагностика в
 *   `console.*`. Пользовательская строка маркером не прикрывается.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, listSourceFiles } from './guard-helpers.js';
import { ru, ruPlurals } from '../src/renderer/lib/locales/ru.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Строковый литерал, содержащий кириллицу. */
const CYRILLIC_LITERAL = /['"`][^'"`\n]*[А-Яа-яЁё][^'"`\n]*['"`]/;

/** Маркер технической строки: осознанное исключение с обоснованием на месте. */
const TECHNICAL_MARKER = 'i18n: technical';

/**
 * Область сканирования — весь renderer, кроме словаря и тестовой локали:
 * их содержимое — сами тексты, а не разметка.
 */
const SCANNED_FILES = (rel: string): boolean => !rel.startsWith('lib/locales/');

/** Комментарий (строчный, блочный или строка JSDoc) — не разметка. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Ключи, встречающиеся в коде как `t('ключ'…)`/`tp('ключ'…)` (комментарии не считаются). */
function collectUsedKeys(fn: 't' | 'tp'): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const call = new RegExp(`(?<![\\w$.])${fn}\\(\\s*'([^']+)'`, 'g');
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

describe('guard: локализация renderer', () => {
  it('в renderer нет русских строковых литералов вне словаря', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-russian-literals-outside-dictionary',
        description:
          'Пользовательские строки берутся из словаря `lib/i18n.ts` через ' +
          "`t('ключ')`/`tp('ключ')`: во всём `client/src/renderer`, кроме " +
          '`lib/locales/**`, комментариев и строк с маркером ' +
          '`// i18n: technical`, русских литералов в разметке нет ' +
          '(требование 0e5ff1c6).',
        pattern: CYRILLIC_LITERAL,
        include: SCANNED_FILES,
        allow: (_rel, line) => isCommentLine(line) || line.includes(TECHNICAL_MARKER),
      },
    ]);
  });

  it('каждый ключ из t(…) есть в словаре ru', () => {
    const missing = [...collectUsedKeys('t').keys()].filter(
      (key) => !(key in ru),
    );
    assert.deepEqual(
      missing,
      [],
      `Ключи без строки в словаре ru: ${missing.join(', ')}`,
    );
  });

  it('каждый ключ из tp(…) есть в каталоге форм ruPlurals', () => {
    const missing = [...collectUsedKeys('tp').keys()].filter(
      (key) => !(key in ruPlurals),
    );
    assert.deepEqual(
      missing,
      [],
      `Ключи без форм в ruPlurals: ${missing.join(', ')}`,
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
