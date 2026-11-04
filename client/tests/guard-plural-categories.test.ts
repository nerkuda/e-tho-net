/**
 * Сторож категорий плюрализации (задача e6374cd1).
 *
 * Правило: файл языка экспортирует типизированный `<код>Plurals`, и в нём
 * заполнены ровно те категории, которые выбирает `Intl.PluralRules` этого
 * языка (ru `one/few/many/other`, en `one/other`, zh `other`). Пропущенная
 * форма не падает в рантайме (fallback на `other`), но даёт неверный текст —
 * например «1,5 потомков» вместо «1,5 потомка».
 *
 * Паритет ключей и подстановок между языками здесь НЕ проверяется: это
 * отдельный сторож `guard-i18n-parity.test.ts` (задача 6c1b56f3). Сторож сам
 * подхватывает файлы локалей: он ищет `lib/locales/<код>.ts` и читает экспорт
 * `<код>Plurals`, поэтому новые языки (zh — задача f7dba88c) проверяются без
 * правки сторожа.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { pluralCategory, type PluralCatalog } from '../src/renderer/lib/plural.js';
import { ruPlurals } from '../src/renderer/lib/locales/ru.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = path.join(CLIENT_ROOT, 'src', 'renderer', 'lib', 'locales');

/**
 * Обязательные категории языка — по правилам ICU. Новый язык добавляется
 * сюда вместе со своим каталогом (en/zh — задачи 6c1b56f3/d08c422d).
 */
const REQUIRED: Record<string, readonly string[]> = {
  ru: ['one', 'few', 'many', 'other'],
  en: ['one', 'other'],
  zh: ['other'],
};

/** Найти каталоги форм всех языков, у которых есть файл локали. */
async function loadPluralCatalogs(): Promise<Map<string, PluralCatalog>> {
  const catalogs = new Map<string, PluralCatalog>();
  catalogs.set('ru', ruPlurals as PluralCatalog);
  for (const code of Object.keys(REQUIRED)) {
    if (code === 'ru') continue;
    const file = path.join(LOCALES_DIR, `${code}.ts`);
    if (!fs.existsSync(file)) continue;
    const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const exported = module[`${code}Plurals`];
    assert.ok(exported !== undefined, `lib/locales/${code}.ts не экспортирует ${code}Plurals`);
    catalogs.set(code, exported as PluralCatalog);
  }
  return catalogs;
}

describe('guard: категории плюрализации', () => {
  it('каждый язык заполняет обязательные категории и не заводит лишних', async () => {
    const catalogs = await loadPluralCatalogs();
    for (const [code, catalog] of catalogs) {
      const required = REQUIRED[code];
      assert.ok(required !== undefined, `язык ${code}: нет описания категорий в стороже`);
      const keys = Object.keys(catalog);
      assert.ok(keys.length > 0, `язык ${code}: каталог форм пуст`);
      for (const key of keys) {
        const forms = catalog[key] ?? {};
        for (const category of required) {
          assert.equal(
            typeof forms[category as Intl.LDMLPluralRule],
            'string',
            `${code}:${key} — нет формы ${category}`,
          );
        }
        for (const category of Object.keys(forms)) {
          assert.ok(
            required.includes(category),
            `${code}:${key} — лишняя категория ${category} (язык выбирает только ${required.join('/')})`,
          );
        }
      }
    }
  });

  it('выбор формы покрывает весь корпус чисел (категория всегда есть в формах)', async () => {
    const catalogs = await loadPluralCatalogs();
    // Корпус: целые 0–200 (все хвосты категорий) и дробные.
    const corpus = [...Array.from({ length: 201 }, (_, i) => i), 0.5, 1.5, 2.5, 11.5, 101.25];
    for (const [code, catalog] of catalogs) {
      for (const key of Object.keys(catalog)) {
        const forms = catalog[key] ?? {};
        for (const n of corpus) {
          const category = pluralCategory(code, n);
          assert.equal(
            typeof forms[category],
            'string',
            `${code}:${key} — для ${String(n)} выбрана категория ${category}, формы нет`,
          );
        }
      }
    }
  });
});
