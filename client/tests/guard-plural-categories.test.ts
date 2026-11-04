/**
 * Сторож категорий плюрализации (задача e6374cd1, доработан в 2014af4f).
 *
 * Правило: если файл языка объявляет формы `<код>Plurals`, в нём заполнены
 * ровно те категории, которые выбирает `Intl.PluralRules` этого языка
 * (ru `one/few/many/other`, en `one/other`, zh `other`), и форма находится
 * для любого числа. Пропущенная форма не падает в рантайме (fallback на
 * `other`), но даёт неверный текст — например «1,5 потомков» вместо
 * «1,5 потомка».
 *
 * Состав языков — динамический: сторож перебирает `lib/locales/*.ts`, кроме
 * тестовой фикстуры `test.ts` (она регистрируется только в `MODE=test` и
 * паритетом не покрывается — см. `TEST_LOCALE_FILE`), и читает объявленный
 * экспорт `<код>Plurals`; обязательные категории берутся из
 * `Intl.PluralRules('<код>').resolvedOptions()` — ручной таблицы в стороже
 * нет. Новый язык с формами (zh — задача f7dba88c) проверяется без правки
 * сторожа. Язык без объявленных форм здесь не проверяется: `tp()` добирает
 * формы `ru`, а регистрацию и паритет каталогов языков держит
 * `guard-i18n-parity.test.ts`.
 *
 * Паритет ключей и подстановок между языками здесь НЕ проверяется: это
 * отдельный сторож `guard-i18n-parity.test.ts` (задача 6c1b56f3).
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
 * Тестовая фикстура GUI-стенда: не пользовательский язык, поэтому из проверки
 * исключена. Свои формы она объявляет (`testPlurals` с `plurals.child`), но
 * регистрируется только в `MODE=test` и не имеет ICU-кода: `Intl.PluralRules`
 * по имени файла `test` бросил бы RangeError. `testPlurals` не читает ни один
 * сторож: `guard-i18n-parity.test.ts` исключает `test.ts` так же, как этот, —
 * формы фикстуры нужны только GUI-стенду.
 */
const TEST_LOCALE_FILE = 'test.ts';

/** Коды языков из файлов `lib/locales/*.ts`, кроме тестовой фикстуры. */
function localeCodes(): string[] {
  return fs
    .readdirSync(LOCALES_DIR)
    .filter((name) => name.endsWith('.ts') && name !== TEST_LOCALE_FILE)
    .map((name) => name.slice(0, -'.ts'.length))
    .sort();
}

/**
 * Обязательные категории языка — из ICU: правила языка не дублируются
 * таблицей в стороже. Неизвестный код — ошибка имени файла, а не молчаливый
 * пропуск.
 */
function requiredCategories(code: string): readonly string[] {
  try {
    return [...new Intl.PluralRules(code).resolvedOptions().pluralCategories].sort();
  } catch {
    assert.fail(
      `язык ${code}: Intl.PluralRules не знает код — проверь имя файла lib/locales/${code}.ts`,
    );
  }
}

/**
 * Формы всех языков, которые их объявили: `ruPlurals` — источник истины,
 * остальные — объявленный экспорт `<код>Plurals` из файла локали.
 */
async function loadPluralCatalogs(): Promise<Map<string, PluralCatalog>> {
  const catalogs = new Map<string, PluralCatalog>();
  catalogs.set('ru', ruPlurals as PluralCatalog);
  for (const code of localeCodes()) {
    if (code === 'ru') continue;
    const file = path.join(LOCALES_DIR, `${code}.ts`);
    const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const exported = module[`${code}Plurals`];
    if (exported === undefined) continue; // формы не объявлены — tp() использует ru
    catalogs.set(code, exported as PluralCatalog);
  }
  return catalogs;
}

describe('guard: категории плюрализации', () => {
  it('каждый язык заполняет обязательные категории и не заводит лишних', async () => {
    const catalogs = await loadPluralCatalogs();
    for (const [code, catalog] of catalogs) {
      const required = requiredCategories(code);
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
