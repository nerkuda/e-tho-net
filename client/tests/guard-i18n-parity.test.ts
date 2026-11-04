/**
 * Сторож паритета локалей (задача 6c1b56f3; тех.проект 3690fc8f
 * «Локализация ETN: английский и китайский языки»; требование 0e5ff1c6
 * «Локализация: все строки интерфейса — из словаря, с подстановками
 * параметров»).
 *
 * Правило: `lib/locales/ru.ts` — источник истины для набора ключей и набора
 * подстановок. Любой другой каталог (`lib/locales/<код>.ts`) обязан:
 *
 * 1. **Совпадать по ключам с `ru` в обе стороны.** Нет перевода ключа —
 *    пользователь увидит русский fallback посреди переведённого экрана; лишний
 *    ключ — мёртвая строка, которой нет в исходном языке (и `MessageKey` её не
 *    знает).
 * 2. **Иметь непустые значения.** Пустая строка — заглушка вместо перевода;
 *    `t()` вернёт пустоту, и подпись исчезнет.
 * 3. **Не содержать дублей ключей.** Повтор в объектном литерале молча
 *    перекрывает предыдущее значение: правка «верхней» строки ничего не
 *    меняет, а typecheck на некоторых формах дубль не видит. Проверяются
 *    и каталог `<код>`, и формы `<код>Plurals` — ключи верхнего уровня и
 *    категории внутри ключа.
 * 4. **Совпадать по набору подстановок `%1…%n`.** Другой номер или пропущенный
 *    параметр — потерянный текст («Не удалось записать %1» без имени) либо
 *    лишний `%2` в строке, куда его никто не передаёт.
 * 5. **Быть зарегистрированным в `lib/i18n.ts`.** Файл языка без
 *    `registerLocale` недоступен для выбора; зарегистрированный код без файла —
 *    ошибка конфигурации. Тестовая фикстура `test.ts` — исключение: она
 *    регистрируется только в `MODE=test` (`app.ts`), а не в каркасе.
 * 6. **Иметь согласованные формы плюрализации, если они объявлены:** тот же
 *    набор ключей, что `ruPlurals`, категории — подмножество категорий `ru`
 *    (язык вправе выбирать меньше форм: en — `one`/`other`, zh — только
 *    `other`), подстановки — те же. Точный состав категорий по ICU проверяет
 *    отдельный сторож `guard-plural-categories.test.ts`; здесь — только
 *    паритет с исходным языком, без дублирования.
 *
 * Сторож сам подхватывает новые файлы `lib/locales/*.ts`: при появлении
 * `zh.ts` (задача f7dba88c) он начнёт проверять его без правки сторожа.
 * Импорт каталогов — динамический: значения читаются из самого модуля, а
 * дубли ключей — из AST исходника (рантайм их не сохраняет).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = path.join(CLIENT_ROOT, 'src', 'renderer', 'lib', 'locales');
const I18N_FILE = path.join(CLIENT_ROOT, 'src', 'renderer', 'lib', 'i18n.ts');

/** Исходный язык — источник истины для ключей и подстановок. */
const SOURCE_LOCALE = 'ru';

/** Тестовая фикстура GUI-стенда: не пользовательский язык, регистрируется в `MODE=test`. */
const TEST_LOCALE_FILE = 'test.ts';

/** Каталог языка: ключ → текст. */
type Catalog = Record<string, string>;

/** Каталог форм плюрализации: ключ → категория → текст. */
type PluralCatalog = Record<string, Record<string, string>>;

/** Загруженный каталог языка вместе с его формами плюрализации. */
interface Locale {
  /** Код языка (имя файла без `.ts`). */
  code: string;
  /** Путь к файлу относительно `lib/locales`. */
  file: string;
  /** Тексты языка. */
  catalog: Catalog;
  /** Формы плюрализации; `null` — каталог форм не объявлен. */
  plurals: PluralCatalog | null;
}

/** Коды языков из файлов `lib/locales/*.ts`, кроме тестовой фикстуры. */
function localeCodes(): string[] {
  return fs
    .readdirSync(LOCALES_DIR)
    .filter((name) => name.endsWith('.ts') && name !== TEST_LOCALE_FILE)
    .map((name) => name.slice(0, -'.ts'.length))
    .sort();
}

/** Проверяет, что значение — объект (каталог или формы), и возвращает его записи. */
function expectObject(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label}: ожидался объект каталога`,
  );
  return value as Record<string, unknown>;
}

/** Каталог языка из загруженного модуля: `<код>` — ключ → непустая строка. */
function expectCatalog(value: unknown, label: string): Catalog {
  const entries = expectObject(value, label);
  const catalog: Catalog = {};
  for (const [key, text] of Object.entries(entries)) {
    if (typeof text !== 'string') {
      assert.fail(`${label}: значение ключа «${key}» — не строка`);
    }
    catalog[key] = text;
  }
  return catalog;
}

/** Каталог форм языка из загруженного модуля: `<код>Plurals` — ключ → формы. */
function expectPlurals(value: unknown, label: string): PluralCatalog {
  const entries = expectObject(value, label);
  const plurals: PluralCatalog = {};
  for (const [key, forms] of Object.entries(entries)) {
    const formEntries = expectObject(forms, `${label}:${key}`);
    const formsByCategory: Record<string, string> = {};
    for (const [category, text] of Object.entries(formEntries)) {
      if (typeof text !== 'string') {
        assert.fail(`${label}:${key}: форма «${category}» — не строка`);
      }
      formsByCategory[category] = text;
    }
    plurals[key] = formsByCategory;
  }
  return plurals;
}

/** Загружает модуль языка: каталог `<код>` и необязательные формы `<код>Plurals`. */
async function loadLocale(code: string): Promise<Locale> {
  const file = `${code}.ts`;
  const module = (await import(pathToFileURL(path.join(LOCALES_DIR, file)).href)) as Record<
    string,
    unknown
  >;
  const catalog = expectCatalog(module[code], `lib/locales/${file}: экспорт ${code}`);
  const pluralsExport = module[`${code}Plurals`];
  return {
    code,
    file,
    catalog,
    plurals: pluralsExport === undefined ? null : expectPlurals(pluralsExport, `${code}Plurals`),
  };
}

/** Загружает все каталоги языков (по файлам, кроме тестовой фикстуры). */
async function loadLocales(): Promise<Map<string, Locale>> {
  const locales = new Map<string, Locale>();
  for (const code of localeCodes()) locales.set(code, await loadLocale(code));
  return locales;
}

/** Разбор исходника каталога для проверок, которые рантайм не сохраняет. */
function parseSource(file: string): { source: string; sf: ts.SourceFile } {
  const source = fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return { source, sf };
}

/** Инициализатор объекта без обёрток `as const` / `satisfies` / скобок. */
function unwrapExpression(init: ts.Expression | undefined): ts.Expression | undefined {
  let node = init;
  while (
    node !== undefined &&
    (ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node))
  ) {
    node = node.expression;
  }
  return node;
}

/** Имя свойства объектного литерала: идентификатор, строка или шаблон без подстановок. */
function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

/** Ключи объектного литерала в порядке исходника (с дублями). */
function objectLiteralKeys(node: ts.ObjectLiteralExpression): string[] {
  const keys: string[] = [];
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (name !== undefined) keys.push(name);
  }
  return keys;
}

/** Ключи объектного литерала экспорта `<exportName>` в порядке исходника (с дублями). */
function sourceKeys(sf: ts.SourceFile, exportName: string): string[] {
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === exportName) {
      const init = unwrapExpression(node.initializer);
      if (init !== undefined && ts.isObjectLiteralExpression(init)) {
        keys.push(...objectLiteralKeys(init));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys;
}

/** Ключи, встречающиеся в исходнике больше одного раза. */
function duplicateKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates].sort();
}

/**
 * Дубли в плюральном каталоге `<exportName>`: ключи верхнего уровня и
 * категории внутри ключа. Рантайм молча оставляет последнее значение —
 * ровно как в основном каталоге, но AST-проверка основных ключей вложенные
 * объекты не видела.
 */
function pluralDuplicateKeys(sf: ts.SourceFile, exportName: string): string[] {
  const duplicates = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === exportName) {
      const init = unwrapExpression(node.initializer);
      if (init !== undefined && ts.isObjectLiteralExpression(init)) {
        for (const key of duplicateKeys(objectLiteralKeys(init))) duplicates.add(key);
        for (const property of init.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const key = propertyName(property.name);
          const forms = unwrapExpression(property.initializer);
          if (key === undefined || forms === undefined || !ts.isObjectLiteralExpression(forms)) {
            continue;
          }
          for (const category of duplicateKeys(objectLiteralKeys(forms))) {
            duplicates.add(`${key}.${category}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...duplicates].sort();
}

/** Номера позиционных подстановок `%1`, `%2`, … в тексте (без повторов, по возрастанию). */
function placeholders(text: string): number[] {
  const indexes = new Set<number>();
  for (const match of text.matchAll(/%(\d+)/g)) indexes.add(Number(match[1]));
  return [...indexes].sort((a, b) => a - b);
}

/** Строковое представление набора подстановок для читаемого сообщения. */
function formatPlaceholders(indexes: readonly number[]): string {
  return indexes.length === 0 ? '—' : indexes.map((index) => `%${index}`).join(' ');
}

/** Все подстановки набора форм плюрализации ключа (объединение по категориям). */
function pluralPlaceholders(forms: Record<string, string>): number[] {
  const indexes = new Set<number>();
  for (const text of Object.values(forms)) {
    for (const index of placeholders(text)) indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b);
}

/** Один вызов `registerLocale` в `lib/i18n.ts`. */
interface Registration {
  /** Код языка — первый аргумент, разрешённый статически. */
  code: string;
  /** Второй аргумент — выражение каталога как в исходнике. */
  catalogArg: string;
  /** Третий аргумент — выражение форм плюрализации; `null` — не передан. */
  pluralsArg: string | null;
  /** Номер строки вызова (с 1). */
  line: number;
}

/** Импорт каталога языка в `lib/i18n.ts`. */
interface LocaleImport {
  /** Код языка из пути `./locales/<код>.js`. */
  code: string;
  /** Импортированное имя → локальное имя (`import { en as english }`). */
  symbols: Map<string, string>;
}

/** Статическая картина регистрации каталогов в `lib/i18n.ts`. */
interface RegistrationScan {
  registrations: Registration[];
  imports: Map<string, LocaleImport>;
  /** Регистрации, код которых не удалось разрешить статически. */
  unresolved: { line: number; text: string }[];
}

/** Путь импорта каталога языка: `./locales/<код>.js` (допускается `.ts`). */
const LOCALE_IMPORT = /(?:^|\/)locales\/([A-Za-z][\w-]*)\.(?:js|ts)$/;

/** Статический разбор `lib/i18n.ts`: импорты каталогов и вызовы `registerLocale`. */
function scanRegistrations(): RegistrationScan {
  const source = fs.readFileSync(I18N_FILE, 'utf8');
  const sf = ts.createSourceFile(I18N_FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = new Map<string, LocaleImport>();
  const stringConstants = new Map<string, string>();
  const registrations: Registration[] = [];
  const unresolved: { line: number; text: string }[] = [];
  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifier)) continue;
      const match = LOCALE_IMPORT.exec(specifier.text);
      if (match === null) continue;
      const code = match[1]!;
      const symbols = new Map<string, string>();
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          symbols.set((element.propertyName ?? element.name).text, element.name.text);
        }
      }
      imports.set(code, { code, symbols });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined &&
          ts.isStringLiteral(declaration.initializer)
        ) {
          stringConstants.set(declaration.name.text, declaration.initializer.text);
        }
      }
    }
  }

  const resolveString = (node: ts.Expression | undefined): string | undefined => {
    if (node === undefined) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node)) return stringConstants.get(node.text);
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'registerLocale'
    ) {
      const code = resolveString(node.arguments[0]);
      if (code === undefined) {
        unresolved.push({ line: lineOf(node), text: node.getText(sf).split('\n')[0]! });
      } else {
        const catalogArg = node.arguments[1]?.getText(sf) ?? '';
        const pluralsArg = node.arguments[2]?.getText(sf) ?? null;
        registrations.push({ code, catalogArg, pluralsArg, line: lineOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { registrations, imports, unresolved };
}

describe('guard: паритет локалей', () => {
  it('в каталогах lib/locales/*.ts нет дублей ключей и форм', () => {
    const violations: string[] = [];
    for (const code of localeCodes()) {
      const { sf } = parseSource(`${code}.ts`);
      const duplicates = [
        ...new Set([
          ...duplicateKeys(sourceKeys(sf, code)),
          ...pluralDuplicateKeys(sf, `${code}Plurals`),
        ]),
      ];
      if (duplicates.length > 0) {
        violations.push(`  • ${code}.ts — дубли: ${duplicates.join(', ')}`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      'Дубль ключа в объектном литерале молча перекрывает предыдущее значение — ' +
        'в каталоге и в формах плюрализации:\n' +
        violations.join('\n'),
    );
  });

  it('детектор дублей видит повтор в плюральном объекте', () => {
    const probe = [
      'export const en = {',
      "  'actions.save': 'Save',",
      '};',
      'export const enPlurals = {',
      "  'plurals.child': { one: 'child', other: 'children' },",
      "  'plurals.child': { one: 'child', other: 'children' },",
      "  'plurals.link': { one: 'link', one: 'link', other: 'links' },",
      '};',
    ].join('\n');
    const sf = ts.createSourceFile('probe.ts', probe, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    assert.deepEqual(
      pluralDuplicateKeys(sf, 'enPlurals'),
      ['plurals.child', 'plurals.link.one'],
      'повтор ключа плюрального каталога и повтор категории внутри формы — дубли',
    );
  });

  it('наборы ключей каждого каталога совпадают с ru в обе стороны', async () => {
    const locales = await loadLocales();
    const source = locales.get(SOURCE_LOCALE);
    assert.ok(source !== undefined, `нет каталога источника истины lib/locales/${SOURCE_LOCALE}.ts`);
    const sourceKeySet = new Set(Object.keys(source.catalog));
    assert.ok(sourceKeySet.size > 0, 'каталог ru пуст');

    const problems: string[] = [];
    for (const locale of locales.values()) {
      if (locale.code === SOURCE_LOCALE) continue;
      const keys = new Set(Object.keys(locale.catalog));
      const missing = [...sourceKeySet].filter((key) => !keys.has(key)).sort();
      const extra = [...keys].filter((key) => !sourceKeySet.has(key)).sort();
      if (missing.length > 0) {
        problems.push(`  • ${locale.file} — нет ключей ru (${missing.length}): ${missing.join(', ')}`);
      }
      if (extra.length > 0) {
        problems.push(`  • ${locale.file} — лишние ключи (${extra.length}): ${extra.join(', ')}`);
      }
    }
    assert.deepEqual(
      problems,
      [],
      'Каждый ключ ru обязан быть переведён, лишних ключей быть не должно ' +
        '(источник истины — lib/locales/ru.ts):\n' +
        problems.join('\n'),
    );
  });

  it('значения каждого каталога непустые', async () => {
    const locales = await loadLocales();
    const problems: string[] = [];
    for (const locale of locales.values()) {
      const empty = Object.entries(locale.catalog)
        .filter(([, text]) => typeof text !== 'string' || text.trim() === '')
        .map(([key]) => key)
        .sort();
      if (empty.length > 0) {
        problems.push(`  • ${locale.file} — пустые значения (${empty.length}): ${empty.join(', ')}`);
      }
    }
    assert.deepEqual(
      problems,
      [],
      'Пустое значение словаря — заглушка вместо перевода; t() вернёт пустую строку:\n' +
        problems.join('\n'),
    );
  });

  it('наборы подстановок %1…%n в переводах совпадают с ru', async () => {
    const locales = await loadLocales();
    const source = locales.get(SOURCE_LOCALE);
    assert.ok(source !== undefined, `нет каталога источника истины lib/locales/${SOURCE_LOCALE}.ts`);

    const problems: string[] = [];
    for (const locale of locales.values()) {
      if (locale.code === SOURCE_LOCALE) continue;
      for (const [key, text] of Object.entries(source.catalog)) {
        const translated = locale.catalog[key];
        if (translated === undefined) continue; // отдельная проверка полноты
        const expected = placeholders(text);
        const actual = placeholders(translated);
        if (expected.join(',') !== actual.join(',')) {
          problems.push(
            `  • ${locale.file}:${key} — в ru [${formatPlaceholders(expected)}], ` +
              `в переводе [${formatPlaceholders(actual)}]`,
          );
        }
      }
    }
    assert.deepEqual(
      problems,
      [],
      'Перевод обязан сохранять номера подстановок исходной строки: другой номер ' +
        'оставляет %n неподставленным или требует параметр, которого нет в вызове:\n' +
        problems.join('\n'),
    );
  });

  it('каталоги зарегистрированы в lib/i18n.ts и соответствуют файлам локалей', async () => {
    const scan = scanRegistrations();
    const files = localeCodes();

    assert.deepEqual(
      scan.unresolved.map((item) => `${item.line}: ${item.text}`),
      [],
      'Код языка в registerLocale должен разрешаться статически (строка или константа): ' +
        'иначе сторож не может сверить каталог с файлом.',
    );

    const registered = [...new Set(scan.registrations.map((item) => item.code))].sort();
    const missingRegistration = files.filter((code) => !registered.includes(code));
    const missingFile = registered.filter((code) => !files.includes(code));
    assert.deepEqual(
      { missingRegistration, missingFile },
      { missingRegistration: [], missingFile: [] },
      'Регистрация каталогов в lib/i18n.ts разошлась с файлами lib/locales/*.ts ' +
        `(кроме фикстуры ${TEST_LOCALE_FILE}): ` +
        `без регистрации — [${missingRegistration.join(', ')}]; ` +
        `без файла — [${missingFile.join(', ')}]`,
    );

    const problems: string[] = [];
    for (const registration of scan.registrations) {
      const localeImport = scan.imports.get(registration.code);
      if (localeImport === undefined) {
        problems.push(
          `  • ${registration.code}: нет импорта из ./locales/${registration.code}.js`,
        );
        continue;
      }
      const catalogBinding = localeImport.symbols.get(registration.code);
      if (catalogBinding === undefined) {
        problems.push(`  • ${registration.code}: из файла не импортирован каталог ${registration.code}`);
      } else if (catalogBinding !== registration.catalogArg) {
        problems.push(
          `  • ${registration.code}: registerLocale получает «${registration.catalogArg}», ` +
            `а из файла импортирован «${catalogBinding}»`,
        );
      }

      // Если язык объявил формы плюрализации, они обязаны попасть в реестр
      // вместе с каталогом: иначе tp() молча доберёт русские формы.
      const locale = await loadLocale(registration.code);
      if (locale.plurals !== null) {
        const pluralsBinding = localeImport.symbols.get(`${registration.code}Plurals`);
        if (pluralsBinding === undefined) {
          problems.push(
            `  • ${registration.code}: файл объявляет ${registration.code}Plurals, ` +
              'но формы не импортированы в lib/i18n.ts',
          );
        } else if (pluralsBinding !== registration.pluralsArg) {
          problems.push(
            `  • ${registration.code}: registerLocale получает формы ` +
              `«${registration.pluralsArg ?? '—'}», а импортированы «${pluralsBinding}»`,
          );
        }
      }
    }
    assert.deepEqual(
      problems,
      [],
      'Каталог регистрируется тем объектом, который импортирован из своего файла, ' +
        'вместе с объявленными формами плюрализации:\n' +
        problems.join('\n'),
    );
  });

  it('плюральные формы каталогов согласованы с ru', async () => {
    const locales = await loadLocales();
    const source = locales.get(SOURCE_LOCALE);
    assert.ok(source !== undefined, `нет каталога источника истины lib/locales/${SOURCE_LOCALE}.ts`);
    const sourcePlurals = source.plurals;
    assert.ok(sourcePlurals !== null, 'у каталога ru нет форм плюрализации (ruPlurals)');

    const problems: string[] = [];
    for (const locale of locales.values()) {
      if (locale.code === SOURCE_LOCALE || locale.plurals === null) continue;
      const expectedKeys = new Set(Object.keys(sourcePlurals));
      const keys = new Set(Object.keys(locale.plurals));
      const missing = [...expectedKeys].filter((key) => !keys.has(key)).sort();
      const extra = [...keys].filter((key) => !expectedKeys.has(key)).sort();
      if (missing.length > 0) {
        problems.push(`  • ${locale.file} — нет форм ключей ruPlurals: ${missing.join(', ')}`);
      }
      if (extra.length > 0) {
        problems.push(`  • ${locale.file} — формы для ключей вне ruPlurals: ${extra.join(', ')}`);
      }

      for (const [key, sourceForms] of Object.entries(sourcePlurals)) {
        const forms = locale.plurals[key];
        if (forms === undefined) continue; // отдельная проверка набора ключей выше
        const sourceCategories = new Set(Object.keys(sourceForms));
        const extraCategories = Object.keys(forms)
          .filter((category) => !sourceCategories.has(category))
          .sort();
        if (extraCategories.length > 0) {
          problems.push(
            `  • ${locale.file}:${key} — категории вне ru: ${extraCategories.join(', ')} ` +
              `(ru использует ${[...sourceCategories].join('/')})`,
          );
        }
        const emptyForms = Object.entries(forms)
          .filter(([, text]) => text.trim() === '')
          .map(([category]) => category)
          .sort();
        if (emptyForms.length > 0) {
          problems.push(`  • ${locale.file}:${key} — пустые формы: ${emptyForms.join(', ')}`);
        }
        const expected = pluralPlaceholders(sourceForms);
        const actual = pluralPlaceholders(forms);
        if (expected.join(',') !== actual.join(',')) {
          problems.push(
            `  • ${locale.file}:${key} — подстановки ru [${formatPlaceholders(expected)}], ` +
              `в переводе [${formatPlaceholders(actual)}]`,
          );
        }
      }
    }
    assert.deepEqual(
      problems,
      [],
      'Формы плюрализации — паритет с ruPlurals (точный состав категорий по ICU ' +
        'проверяет guard-plural-categories):\n' +
        problems.join('\n'),
    );
  });
});
