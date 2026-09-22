/**
 * Тест самой инфраструктуры сторожей (задача 8d1f8b79, веха 1).
 *
 * Проверяет, что скан действительно находит запрещённые конструкции:
 * фикстура собирается в temp-каталоге на время прогона, в репозиторий
 * нарушения не попадают. Дублирует ручную проверку «сторож обязан
 * краснеть на умышленно внесённом нарушении» — в постоянном, воспроизводимом
 * виде.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { assertGuardClean, collectViolations, formatViolations } from './guard-helpers.js';

const FORBIDDEN = /(?:from\s+|require\s*\(\s*)['"]electron['"]/;

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-test-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'clean.ts'), 'export const ok = 1;\n');
  // Однострочный импорт: ловится построчным pattern.
  fs.writeFileSync(path.join(dir, 'bad.ts'), "import { ipcRenderer } from 'electron';\n");
  // Многострочный импорт: построчно не виден, ловится filePattern.
  fs.writeFileSync(
    path.join(dir, 'sub', 'multiline.ts'),
    "import {\n  ipcRenderer,\n} from\n  'electron';\n",
  );
  // Неисходное расширение: не сканируется.
  fs.writeFileSync(path.join(dir, 'skipped.txt'), "from 'electron'");
  // Допустимая форма: import type разрешён allow-функцией.
  fs.writeFileSync(path.join(dir, 'allowed.ts'), "import type { IpcRenderer } from 'electron';\n");
  return dir;
}

const RULE_LINE = {
  name: 'no-electron',
  description: 'запрещён импорт "electron"',
  pattern: FORBIDDEN,
  allow: (_rel: string, line: string) => line.includes('import type'),
};

const RULE_FILE = {
  name: 'no-electron-multiline',
  description: 'запрещён импорт "electron" (многострочные конструкции)',
  filePattern: FORBIDDEN,
  allow: (_rel: string, line: string) => line.includes('import type'),
};

describe('guard-helpers: скан источников на запрещённые конструкции', () => {
  it('находит построчное совпадение и обходит неисходные расширения', () => {
    const dir = makeFixture();
    const hits = collectViolations(dir, [RULE_LINE]);
    const bad = hits.filter((v) => v.file === 'bad.ts');
    assert.equal(bad.length, 1);
    assert.equal(bad[0]!.line, 1);
    assert.ok(!hits.some((v) => v.file === 'skipped.txt'), 'неисходные файлы не сканируются');
    assert.ok(!hits.some((v) => v.file.startsWith('sub/')), 'многострочный импорт построчно не виден');
  });

  it('находит многострочный импорт через filePattern', () => {
    const dir = makeFixture();
    const hits = collectViolations(dir, [RULE_FILE]);
    const multi = hits.find((v) => v.file === 'sub/multiline.ts');
    assert.ok(multi, 'ожидалось нарушение в sub/multiline.ts');
    assert.equal(multi.line, 3); // строка `} from`
  });

  it('allow исключает import type, exclude убирает файлы и каталоги', () => {
    const dir = makeFixture();
    const hits = collectViolations(dir, [RULE_LINE]);
    assert.ok(!hits.some((v) => v.file === 'allowed.ts'), 'import type не считается нарушением');

    const excluded = collectViolations(dir, [RULE_LINE], { exclude: ['bad.ts', 'sub'] });
    assert.equal(excluded.length, 0);
  });

  it('assertGuardClean падает с перечислением нарушений и правил', () => {
    const dir = makeFixture();
    assert.throws(
      () => assertGuardClean(dir, [RULE_LINE, RULE_FILE]),
      (err: Error) =>
        err.message.includes('no-electron') &&
        err.message.includes('bad.ts:1') &&
        err.message.includes('sub/multiline.ts:3'),
    );
  });

  it('formatViolations форматирует файл, строку и правило', () => {
    const text = formatViolations([{ rule: 'r', file: 'a.ts', line: 2, text: 'x' }]);
    assert.ok(text.includes('a.ts:2') && text.includes('[r]'));
  });
});
