/**
 * Проверка сборщика MCPB-бандла (задача d1feff33, DoD 1/2).
 *
 * Полная сборка (staging + нативный `better-sqlite3`) — это `build-mcpb.mjs` в
 * релизном конвейере и локальная приёмка; здесь проверяются операции над
 * деревом бандла, которые ломаются молча:
 *
 *   * архив `.mcpb` пишется с разделителями `/` и распаковывается обратно
 *     (регрессия: `System.IO.Compression` пишет `\`, и клиент видит один файл
 *     с именем `dist\cli.js`);
 *   * `assertBundleContents` краснеет, если в бандл не попал маркер целевой
 *     платформы или манифест (сборщик обязан писать оба);
 *   * `cleanEnv` для smoke-теста не съедает переданный `ETN_DATA_DIR`.
 *
 * Скрипт сборки — `.mjs` без типов, поэтому импортируется динамически.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildBundleTargetMarker,
  buildMcpbManifest,
  MCPB_BUNDLE_TARGET_FILENAME,
  MCPB_BUNDLE_TARGET_KIND,
} from '../src/mcpb/manifest.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Минимальный интерфейс модуля сборщика, который использует тест. */
interface McpbBundleLib {
  zipDirectory(dir: string, outFile: string): number;
  unzipArchive(file: string, destDir: string): void;
  writeBundleMetadata(
    dir: string,
    input: { manifest: object; marker: object },
  ): { manifestFile: string; markerFile: string };
  assertBundleContents(
    dir: string,
    input: { version: string; target: string; betterSqlite3Version: string },
  ): unknown;
  cleanEnv(home: string, extra?: Record<string, string>): NodeJS.ProcessEnv;
  MCPB_BUNDLE_TARGET_KIND: string;
}

const lib = (await import(
  pathToFileURL(path.join(SERVER_ROOT, 'scripts', 'lib', 'mcpb-bundle.mjs')).href
)) as McpbBundleLib;

const VERSION = '0.16.2';
const TARGET = 'win32-x64';
const SQLITE = '11.1.2';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Создать файл с родительскими каталогами. */
function writeFile(root: string, relative: string, content = 'x'): void {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

/** Собрать минимальное дерево бандла, проходящее все проверки. */
function fakeBundle(root: string, target = TARGET): void {
  writeFile(root, 'package.json', `${JSON.stringify({ name: 'etn-mcp', type: 'module' })}\n`);
  writeFile(root, 'dist/index.js');
  writeFile(root, 'dist/cli.js');
  writeFile(root, 'dist/bin/etn-mcp.js');
  writeFile(root, 'migrations/system/001_init.sql');
  writeFile(root, 'migrations/network/001_init.sql');
  writeFile(root, 'node_modules/@etn/shared/dist/index.js');
  writeFile(root, 'node_modules/@etn/markdown/dist/index.js');
  writeFile(
    root,
    'node_modules/better-sqlite3/package.json',
    `${JSON.stringify({ name: 'better-sqlite3', version: SQLITE })}\n`,
  );
  writeFile(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node', '\0binary');
  lib.writeBundleMetadata(root, {
    manifest: buildMcpbManifest({ version: VERSION, target }),
    marker: buildBundleTargetMarker({ version: VERSION, target }),
  });
}

describe('сборщик MCPB: дерево бандла и архив', () => {
  it('архив пишется с разделителями /, распаковывается и воспроизводим', () => {
    const root = tempDir('etn-mcpb-zip-');
    try {
      const tree = path.join(root, 'tree');
      writeFile(tree, 'dist/bin/etn-mcp.js', 'entry');
      writeFile(tree, 'manifest.json', '{}');

      const first = path.join(root, 'first.mcpb');
      const count = lib.zipDirectory(tree, first);
      assert.equal(count, 2);
      const raw = fs.readFileSync(first);
      assert.ok(raw.includes('dist/bin/etn-mcp.js'), 'имя записи несёт прямые слэши');
      assert.ok(!raw.includes('dist\\bin'), 'в архиве не должно быть разделителей \\');

      const unpacked = path.join(root, 'unpacked');
      lib.unzipArchive(first, unpacked);
      assert.equal(
        fs.readFileSync(path.join(unpacked, 'dist', 'bin', 'etn-mcp.js'), 'utf8'),
        'entry',
      );
      assert.equal(fs.readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'), '{}');

      const second = path.join(root, 'second.mcpb');
      lib.zipDirectory(tree, second);
      assert.ok(
        fs.readFileSync(first).equals(fs.readFileSync(second)),
        'архив одной сборки обязан быть одинаковым (фиксированная дата записей)',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('маркер и манифест обязательны: сборка без маркера краснеет', () => {
    const root = tempDir('etn-mcpb-tree-');
    try {
      const bundle = path.join(root, 'bundle');
      fakeBundle(bundle);
      const manifest = lib.assertBundleContents(bundle, {
        version: VERSION,
        target: TARGET,
        betterSqlite3Version: SQLITE,
      });
      assert.equal((manifest as { name: string }).name, 'etn-mcp-server');

      fs.rmSync(path.join(bundle, MCPB_BUNDLE_TARGET_FILENAME));
      assert.throws(
        () =>
          lib.assertBundleContents(bundle, {
            version: VERSION,
            target: TARGET,
            betterSqlite3Version: SQLITE,
          }),
        new RegExp(`нет обязательного файла: ${MCPB_BUNDLE_TARGET_FILENAME}`),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('маркер чужой цели, чужая версия и чужой манифест ловятся', () => {
    const root = tempDir('etn-mcpb-mismatch-');
    try {
      // Маркер чужой цели.
      const foreignTarget = path.join(root, 'foreign-target');
      fakeBundle(foreignTarget, 'darwin-arm64');
      assert.throws(
        () =>
          lib.assertBundleContents(foreignTarget, {
            version: VERSION,
            target: TARGET,
            betterSqlite3Version: SQLITE,
          }),
        /маркер бандла указывает darwin-arm64/,
      );

      // Версия маркера и манифеста не совпадает со сборкой.
      const foreignVersion = path.join(root, 'foreign-version');
      fakeBundle(foreignVersion);
      fs.writeFileSync(
        path.join(foreignVersion, MCPB_BUNDLE_TARGET_FILENAME),
        `${JSON.stringify({ ...buildBundleTargetMarker({ version: '0.0.1', target: TARGET }), kind: MCPB_BUNDLE_TARGET_KIND })}\n`,
        'utf8',
      );
      assert.throws(
        () =>
          lib.assertBundleContents(foreignVersion, {
            version: VERSION,
            target: TARGET,
            betterSqlite3Version: SQLITE,
          }),
        /маркер бандла указывает версию 0\.0\.1/,
      );

      const foreignManifest = path.join(root, 'foreign-manifest');
      fakeBundle(foreignManifest);
      const manifestPath = path.join(foreignManifest, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      fs.writeFileSync(
        manifestPath,
        `${JSON.stringify({ ...manifest, version: '0.0.1' }, null, 2)}\n`,
        'utf8',
      );
      assert.throws(
        () =>
          lib.assertBundleContents(foreignManifest, {
            version: VERSION,
            target: TARGET,
            betterSqlite3Version: SQLITE,
          }),
        /manifest\.json указывает версию 0\.0\.1/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('нативная платформа обязательна: нет бинарника и чужая версия better-sqlite3', () => {
    const root = tempDir('etn-mcpb-native-');
    try {
      const noBinary = path.join(root, 'no-binary');
      fakeBundle(noBinary);
      fs.rmSync(path.join(noBinary, 'node_modules', 'better-sqlite3', 'build'), {
        recursive: true,
        force: true,
      });
      assert.throws(
        () =>
          lib.assertBundleContents(noBinary, {
            version: VERSION,
            target: TARGET,
            betterSqlite3Version: SQLITE,
          }),
        /нет better-sqlite3\/build\/Release\/better_sqlite3\.node/,
      );

      const wrongVersion = path.join(root, 'wrong-version');
      fakeBundle(wrongVersion);
      fs.writeFileSync(
        path.join(wrongVersion, 'node_modules', 'better-sqlite3', 'package.json'),
        `${JSON.stringify({ name: 'better-sqlite3', version: '11.0.0' })}\n`,
        'utf8',
      );
      assert.throws(
        () =>
          lib.assertBundleContents(wrongVersion, {
            version: VERSION,
            target: TARGET,
            betterSqlite3Version: SQLITE,
          }),
        /better-sqlite3 11\.0\.0, ожидалась 11\.1\.2/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('cleanEnv стирает ETN_* процесса, но не переданные smoke-тесту', () => {
    const previous = process.env.ETN_DATA_DIR;
    process.env.ETN_DATA_DIR = 'C:/leftover';
    try {
      const env = lib.cleanEnv(path.join('C:', 'tmp', 'home'), { ETN_DATA_DIR: 'D:/data' });
      assert.equal(env.ETN_DATA_DIR, 'D:/data');
      assert.equal(env.ETN_LOG_LEVEL, 'error');
      assert.equal(env.HOME, path.join('C:', 'tmp', 'home'));
      const clean = lib.cleanEnv('C:/tmp/home2');
      assert.equal(clean.ETN_DATA_DIR, undefined, 'наследство процесса не протекает');
    } finally {
      if (previous === undefined) delete process.env.ETN_DATA_DIR;
      else process.env.ETN_DATA_DIR = previous;
    }
  });

  it('скрипт сборки пишет метку и проверяет дерево до упаковки', () => {
    const source = fs.readFileSync(path.join(SERVER_ROOT, 'scripts', 'build-mcpb.mjs'), 'utf8');
    assert.match(
      source,
      /writeBundleMetadata\(\s*bundleDir,\s*\{[\s\S]*?marker: buildBundleTargetMarker\(\{ version, target: options\.platform \}\)/s,
      'сборщик обязан писать маркер целевой платформы вместе с манифестом',
    );
    assert.match(source, /assertBundleContents\(bundleDir, \{/, 'дерево проверяется до упаковки');
    assert.match(source, /assertBuildArtifacts\(REPO_ROOT, \{ requireBin: true \}\)/);
    const assertAt = source.indexOf('assertBundleContents(bundleDir, {');
    const zipAt = source.indexOf('zipDirectory(bundleDir, assetPath)');
    assert.ok(assertAt > -1 && zipAt > assertAt, 'упаковка идёт после проверки дерева');
    assert.match(
      source,
      /if \(options\.platform !== host\) \{/,
      'кросс-сборка запрещена: бандл собирается на целевой ОС',
    );
    assert.match(
      source,
      /mcpbAssetName\(version, options\.platform\)/,
      'имя артефакта берётся из общего построителя имён',
    );
  });
});
