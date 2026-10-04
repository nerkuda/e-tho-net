/**
 * Сводный сторож дизайн-системы `lib/ui` (задача b1a1a1b7).
 *
 * Отвечает на вопрос «а сторожа дизайн-системы точно выполняются?». Сторож,
 * потерянный из каталога тестов, из-за опечатки в имени или пустой заглушки,
 * не защищает ничего — запрет без прогона не действует. Правила:
 *
 *  1. **Состав сторожей — снимок.** Набор `tests/guard-ui-*.test.ts` совпадает
 *     с явным списком: новый сторож добавляется в список, исчезнувший — краснеет.
 *  2. **Сторож выполняется.** Каждый файл — настоящий тест: импортирует
 *     `node:test`, объявляет `describe` и хотя бы один `it` (не заглушка).
 *  3. **Сторож попадает в `npm test`.** Скрипт `test` пакета клиента
 *     сканирует `tests/**\/*.test.ts` — файл под этим каталогом обязан
 *     совпадать с этой маской (иначе он молча не запускается).
 *
 * Целостность barrel `lib/ui/index.ts` (все модули реэкспортированы, CSS
 * подключены, нет мёртвых ссылок) сторожит `guard-ui-facades.test.ts`.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_ROOT = path.join(CLIENT_ROOT, 'tests');

/**
 * Явный снимок состава сторожей дизайн-системы. Новый `guard-ui-*` тест
 * добавляется сюда — тогда выпадение любого сторожа из набора краснеет.
 */
const EXPECTED_GUARD_UI = [
  'guard-ui-buttons.test.ts',
  'guard-ui-comment.test.ts',
  'guard-ui-container.test.ts',
  'guard-ui-dialog.test.ts',
  'guard-ui-discoverability.test.ts',
  'guard-ui-empty-state.test.ts',
  'guard-ui-facades.test.ts',
  'guard-ui-fields.test.ts',
  'guard-ui-hit-area.test.ts',
  'guard-ui-i18n.test.ts',
  'guard-ui-licenses.test.ts',
  'guard-ui-popover.test.ts',
  'guard-ui-run.test.ts',
  'guard-ui-slider.test.ts',
  'guard-ui-states.test.ts',
  'guard-ui-tables.test.ts',
  'guard-ui-tokens.test.ts',
  'guard-ui-tree.test.ts',
  'guard-ui-user-tokens.test.ts',
];

/** Маска прогона тестов клиента. */
const TEST_GLOB = 'tests/**/*.test.ts';

/** Имена `guard-ui-*.test.ts` в каталоге тестов (отсортированы). */
function guardUiFiles(testsDir: string): string[] {
  return fs
    .readdirSync(testsDir)
    .filter((name) => name.startsWith('guard-ui-') && name.endsWith('.test.ts'))
    .sort();
}

/** Файл — исполняемый тест: `describe` + хотя бы один `it`, импорт `node:test`. */
function isExecutableTest(text: string): boolean {
  return (
    /from\s+['"]node:test['"]/.test(text) && /\bdescribe\s*\(/.test(text) && /\bit\s*\(/.test(text)
  );
}

/** Совпадает ли имя файла с маской прогона (упрощённо для `tests/**\/*.test.ts`). */
function matchesTestGlob(name: string): boolean {
  return name.endsWith('.test.ts');
}

describe('guard: сторожей дизайн-системы (b1a1a1b7)', () => {
  it('состав guard-ui-* совпадает со снимком', () => {
    assert.deepEqual(
      guardUiFiles(TESTS_ROOT),
      [...EXPECTED_GUARD_UI].sort(),
      'состав сторожей дизайн-системы изменился: дополни EXPECTED_GUARD_UI ' +
        'при добавлении сторожа; исчезнувший сторож — регрессия защиты',
    );
  });

  it('каждый сторож — исполняемый тест, а не заглушка', () => {
    const hollow = guardUiFiles(TESTS_ROOT).filter(
      (name) => !isExecutableTest(fs.readFileSync(path.join(TESTS_ROOT, name), 'utf8')),
    );
    assert.deepEqual(
      hollow,
      [],
      `сторожа без describe/it или без импорта node:test: ${hollow.join(', ')}`,
    );
  });

  it('скрипт test клиента запускает tests/**/*.test.ts и покрывает каждый сторож', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const test = pkg.scripts?.test ?? '';
    assert.ok(
      test.includes(TEST_GLOB),
      `скрипт test обязан сканировать ${TEST_GLOB}, сейчас: ${test}`,
    );
    const uncovered = guardUiFiles(TESTS_ROOT).filter((name) => !matchesTestGlob(name));
    assert.deepEqual(uncovered, [], `сторожа вне маски прогона: ${uncovered.join(', ')}`);
  });

  it('правило «сторож — исполняемый тест» краснеет на заглушке', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-ui-run-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'guard-ui-broken.test.ts'),
        "import { describe, it } from 'node:test';\n",
        'utf8',
      );
      const hollow = fs
        .readdirSync(dir)
        .filter((name) => name.startsWith('guard-ui-'))
        .filter((name) => !isExecutableTest(fs.readFileSync(path.join(dir, name), 'utf8')));
      assert.deepEqual(hollow, ['guard-ui-broken.test.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
