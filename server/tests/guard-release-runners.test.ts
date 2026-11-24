/**
 * Сторож меток macOS-раннеров в релизных конвейерах (ошибка 96730412).
 *
 * GitHub вывел из Actions образы macOS 13 и все macOS 14 (02.11.2026,
 * actions/runner-images#15226): джобы `mcpb-bundles` падали с аннотацией
 * «The configuration 'macos-14-arm64-us-default' is not supported» или висели
 * в очереди без раннера, publish-джоба ждала всю матрицу — релиз не выходил, а
 * `.mcpb` под darwin не попадали в ассеты. Та же метка `macos-14` в
 * `npm-package.yml` сломала бы prebuild-джобу.
 *
 * `better-sqlite3` в бандле нативный, universal-сборки нет: артефакт обязан
 * собираться на целевой архитектуре. Поэтому метка `os` — часть контракта
 * конвейера: darwin-x64 → `macos-15-intel` (нативный x64, Rosetta не нужна),
 * darwin-arm64 → `macos-15`. Сторож читает матрицы обеих workflow и краснеет,
 * если вернулась выведенная метка или изменился состав платформ.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = path.resolve(SERVER_ROOT, '..', '.github', 'workflows');

/** Пара `os`/`target` из `matrix.include`. */
interface RunnerPair {
  os: string;
  target: string;
}

/** Метки, выведенные GitHub из Actions (macOS 13 и все macOS 14). */
const WITHDRAWN_MACOS = /macos-(?:13|14)\b/;

/** Текст workflow-файла. */
function workflow(name: string): string {
  return fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');
}

/** Секция джобы `job` — до следующей джобы верхнего уровня. */
function jobSection(text: string, job: string): string {
  const start = text.indexOf(`\n  ${job}:\n`);
  assert.notEqual(start, -1, `в workflow нет джобы «${job}»`);
  const rest = text.slice(start);
  const headerEnd = rest.indexOf('\n', 1);
  const body = rest.slice(headerEnd + 1);
  const next = body.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  return next === -1 ? rest : rest.slice(0, headerEnd + 1 + next);
}

/** Пары `os`/`target` из `matrix.include` джобы. */
function matrixPairs(section: string): RunnerPair[] {
  const includeIndex = section.indexOf('include:');
  assert.notEqual(includeIndex, -1, 'у джобы нет matrix.include');
  const pairs: RunnerPair[] = [];
  const pattern = /-\s+os:\s*(\S+)\s*\n\s+target:\s*(\S+)/g;
  for (const match of section.slice(includeIndex).matchAll(pattern)) {
    pairs.push({ os: match[1] ?? '', target: match[2] ?? '' });
  }
  assert.ok(pairs.length > 0, 'matrix.include пуст — разбор не нашёл ни одной пары os/target');
  return pairs;
}

describe('метки macOS-раннеров релизных конвейеров (ошибка 96730412)', () => {
  it('release.yml: mcpb-бандлы собираются на поддерживаемых macOS 15', () => {
    const section = jobSection(workflow('release.yml'), 'mcpb-bundles');
    assert.deepEqual(
      matrixPairs(section),
      [
        { os: 'windows-latest', target: 'win32-x64' },
        { os: 'macos-15-intel', target: 'darwin-x64' },
        { os: 'macos-15', target: 'darwin-arm64' },
        { os: 'ubuntu-latest', target: 'linux-x64' },
      ],
      'darwin-x64 — нативный macos-15-intel (Rosetta не нужна), darwin-arm64 — macos-15',
    );
    assert.doesNotMatch(
      section,
      WITHDRAWN_MACOS,
      'выведенные macOS 13/14 не возвращаются в матрицу бандлов',
    );
  });

  it('npm-package.yml: prebuild darwin-arm64 — на поддерживаемом macOS 15', () => {
    const section = jobSection(workflow('npm-package.yml'), 'package');
    assert.deepEqual(
      matrixPairs(section),
      [
        { os: 'windows-latest', target: 'win32-x64' },
        { os: 'macos-15', target: 'darwin-arm64' },
        { os: 'ubuntu-latest', target: 'linux-x64' },
      ],
      'prebuild darwin-arm64 собирается на macos-15',
    );
    assert.doesNotMatch(
      section,
      WITHDRAWN_MACOS,
      'выведенный macOS 14 не возвращается в матрицу prebuilds',
    );
  });

  it('release.yml: комментарий описывает новый план без Rosetta', () => {
    const text = workflow('release.yml');
    assert.match(
      text,
      /macos-15-intel[^\n]*нативный x64[^\n]*Rosetta не нужна/,
      'план объясняет нативный x64 без Rosetta',
    );
    assert.doesNotMatch(text, /arch -x86_64/, 'Rosetta-обход из прежнего плана не возвращается');
  });
});
