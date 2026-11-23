/**
 * Сторож маркеров MCP-пакета `etn-mcp` (задача 760402ba, ADR d17c3a29).
 *
 * Проверяет **исходники в репозитории**, а не артефакт: константы идентичности
 * (`MCP_REGISTRY_NAME` / `MCP_SERVER_NAME`), шаблон манифеста пакета и
 * закоммиченный `server.json`. Красный, если имя реестра подменили в одном
 * месте, но не в другом, если сломали путь `bin` или если имя рукопожатия
 * уехало из `etn-mcp-server` (05 §9 не меняется).
 *
 * Полный прогон маркеров по всем каналам (LABEL образа, manifest MCPB,
 * реестр) — финальная проверка релиза после трёх задач упаковки; здесь только
 * npm-канал и общий каркас.
 *
 * Если в `PATH` есть официальный `mcp-publisher`, дополнительно выполняется
 * `mcp-publisher validate server.json`; без бинарника проверка пропускается
 * (сеть и установленный инструмент не являются требованием unit-тестов).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MCP_REGISTRY_NAME, MCP_SERVER_NAME } from '../src/mcp/server.js';
import {
  buildNpmPackageManifest,
  buildServerJson,
  NPM_BIN_PATH,
  NPM_MAIN_PATH,
  NPM_PACKAGE_NAME,
} from '../src/npm/package-manifest.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

/** Ожидаемое имя реестра: io.github.<владелец>/<репозиторий>. */
const EXPECTED_REGISTRY_NAME = 'io.github.nerkuda/e-tho-net';
/** Ожидаемое имя рукопожатия (05 §9, менять нельзя). */
const EXPECTED_SERVER_NAME = 'etn-mcp-server';

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function readText(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Значение `export const NAME = '...'` из исходника (без вычисления модуля). */
function sourceConst(file: string, name: string): string {
  const source = readText(file);
  const match = new RegExp(String.raw`export const ${name}\s*=\s*'([^']*)'`).exec(source);
  assert.ok(match !== null, `в ${file} не найдено объявление ${name} строковым литералом`);
  return match[1] as string;
}

const rootPackage = readJson(path.join(REPO_ROOT, 'package.json'));
const rootVersion = String(rootPackage.version);
const enginesNode = String((rootPackage.engines as { node?: unknown } | undefined)?.node ?? '');

describe('guard: маркеры MCP-пакета etn-mcp', () => {
  it('константы идентичности объявлены рядом и различаются по назначению', () => {
    const serverSource = path.join(SERVER_ROOT, 'src', 'mcp', 'server.ts');
    assert.equal(MCP_REGISTRY_NAME, EXPECTED_REGISTRY_NAME);
    assert.equal(MCP_SERVER_NAME, EXPECTED_SERVER_NAME);
    assert.equal(sourceConst(serverSource, 'MCP_REGISTRY_NAME'), EXPECTED_REGISTRY_NAME);
    assert.equal(sourceConst(serverSource, 'MCP_SERVER_NAME'), EXPECTED_SERVER_NAME);
    assert.notEqual(MCP_REGISTRY_NAME, MCP_SERVER_NAME, 'реестровое имя не подменяет serverInfo');
  });

  it('имя рукопожатия осталось контрактом теста mcp-stdio', () => {
    const testSource = readText(path.join(SERVER_ROOT, 'tests', 'mcp-stdio.test.ts'));
    assert.match(
      testSource,
      /etn-mcp-server/,
      'тест mcp-stdio.test.ts должен ожидать serverInfo.name = etn-mcp-server (05 §9)',
    );
  });

  it('шаблон манифеста ставит mcpName из константы и bin на обёртку', () => {
    const manifest = buildNpmPackageManifest({
      version: rootVersion,
      enginesNode,
      dependencies: { '@etn/shared': rootVersion, '@etn/markdown': rootVersion },
      bundleDependencies: ['@etn/shared', '@etn/markdown'],
    });

    assert.equal(manifest.name, NPM_PACKAGE_NAME);
    assert.equal(NPM_PACKAGE_NAME, 'etn-mcp');
    assert.equal(manifest.mcpName, MCP_REGISTRY_NAME);
    assert.deepEqual(manifest.bin, { 'etn-mcp': 'dist/bin/etn-mcp.js' });
    assert.equal(NPM_BIN_PATH, 'dist/bin/etn-mcp.js');
    assert.equal(NPM_MAIN_PATH, 'dist/index.js');
    assert.equal(manifest.version, rootVersion);
    assert.equal((manifest.engines as { node: string }).node, enginesNode);
    assert.notEqual(enginesNode, '', 'корневой package.json обязан объявлять engines.node');
    assert.ok(
      Array.isArray(manifest.bundleDependencies) &&
        (manifest.bundleDependencies as string[]).includes('@etn/shared') &&
        (manifest.bundleDependencies as string[]).includes('@etn/markdown'),
      'обе workspace-библиотеки обязаны быть bundled',
    );
    assert.ok(
      Array.isArray(manifest.os) && (manifest.os as string[]).length > 0,
      'матрица os ограничивает host-ы prebuilds',
    );
    assert.ok(
      Array.isArray(manifest.cpu) && (manifest.cpu as string[]).length > 0,
      'матрица cpu ограничивает host-ы prebuilds',
    );
  });

  it('шаблон манифеста отвергает bundled-зависимость без объявления', () => {
    assert.throws(
      () =>
        buildNpmPackageManifest({
          version: rootVersion,
          enginesNode,
          dependencies: {},
          bundleDependencies: ['@etn/shared'],
        }),
      /bundleDependencies entry @etn\/shared is missing/,
    );
  });

  it('исходник обёртки на месте и попадает в сборку пакета', () => {
    const wrapper = path.join(SERVER_ROOT, 'src', 'bin', 'etn-mcp.ts');
    assert.ok(
      fs.existsSync(wrapper),
      'нет server/src/bin/etn-mcp.ts — обёртку собирать не из чего',
    );
    const tsconfig = readJson(path.join(SERVER_ROOT, 'tsconfig.json'));
    assert.deepEqual(
      tsconfig.include,
      ['src/**/*'],
      'обёртка должна остаться под типами и сторожем',
    );
    const pkgBin = readJson(path.join(SERVER_ROOT, 'package.json')).bin as
      Record<string, string> | undefined;
    assert.equal(pkgBin?.etn, 'dist/cli.js', 'bin серверного workspace остаётся etn → dist/cli.js');
  });

  it('закоммиченный server.json совпадает с генератором', () => {
    const file = path.join(REPO_ROOT, 'server.json');
    assert.ok(fs.existsSync(file), 'server.json коммитится в корень репозитория');
    const committed = readJson(file);
    const generated = buildServerJson({ version: rootVersion });
    assert.deepEqual(
      committed,
      generated,
      'server.json устарел — выполните npm -w @etn/server run generate:server-json',
    );
    assert.equal(committed.name, MCP_REGISTRY_NAME);
    assert.equal(committed.version, rootVersion);
    const packages = committed.packages as Array<Record<string, unknown>>;
    assert.equal(packages.length, 1, 'у npm-задачи ровно одна запись packages — npm');
    const npmEntry = packages[0] as Record<string, unknown>;
    assert.equal(npmEntry.registryType, 'npm');
    assert.equal(npmEntry.identifier, NPM_PACKAGE_NAME);
    assert.equal(npmEntry.version, rootVersion);
    assert.deepEqual(npmEntry.transport, { type: 'stdio' });
  });

  it('официальный mcp-publisher принимает server.json (если бинарник в PATH)', (t) => {
    const probe = spawnSync('mcp-publisher', ['--version'], { encoding: 'utf8' });
    if (probe.error !== undefined || probe.status !== 0) {
      t.skip('mcp-publisher не установлен — проверка выполняется при приёмке релиза');
      return;
    }
    const result = spawnSync('mcp-publisher', ['validate', path.join(REPO_ROOT, 'server.json')], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    assert.equal(
      result.status,
      0,
      `mcp-publisher validate server.json: ${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  });

  it('маркер владения пишется до открытия системной БД', () => {
    const source = readText(path.join(SERVER_ROOT, 'src', 'bootstrap', 'data-dir.ts'));
    const start = source.indexOf('function initializeDataDir');
    assert.ok(start > -1, 'нет initializeDataDir');
    const writeAt = source.indexOf('writeOwnership(dataDir, version)', start);
    const openAt = source.indexOf('SystemDb.open(dataDir, log)', start);
    assert.ok(writeAt > start, 'writeOwnership обязан вызываться в initializeDataDir');
    assert.ok(openAt > start, 'SystemDb.open обязан вызываться в initializeDataDir');
    assert.ok(
      writeAt < openAt,
      'маркер владения обязан писаться ДО открытия БД (ADR aa9507e6 п. 3)',
    );
  });

  it('ключ mcp/key пишется с режимом 0600', () => {
    const source = readText(path.join(SERVER_ROOT, 'src', 'bootstrap', 'data-dir.ts'));
    assert.match(source, /const KEY_FILE_MODE = 0o600;/);
    const start = source.indexOf('function writeMcpKey');
    assert.ok(start > -1, 'нет writeMcpKey');
    assert.match(
      source.slice(start, start + 400),
      /KEY_FILE_MODE/,
      'writeMcpKey обязан передавать режим ключа в запись',
    );
  });

  it('обёртка вызывает стражи платформы и перехват нативной загрузки', () => {
    const source = readText(path.join(SERVER_ROOT, 'src', 'bin', 'etn-mcp.ts'));
    assert.match(source, /host = assertSupportedHost\(\);/);
    assert.match(source, /assertBundleTarget\(\s*readBundleTarget\(packageDir\),\s*host,?\s*\)/s);
    assert.match(source, /if \(isNativeLoadFailure\(err\)\) \{/);
  });
});
