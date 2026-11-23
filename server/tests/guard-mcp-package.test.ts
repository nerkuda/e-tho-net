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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MCP_REGISTRY_NAME, MCP_SERVER_NAME } from '../src/mcp/server.js';
import {
  buildBundleTargetMarker,
  buildMcpbManifest,
  githubSlugFromRegistryName,
  MCPB_AUTHOR,
  MCPB_BUNDLE_TARGET_FILENAME,
  MCPB_BUNDLE_TARGET_KIND,
  MCPB_CANONICAL_TARGET,
  MCPB_DISPLAY_NAME,
  MCPB_ENTRY_POINT,
  MCPB_EXTENSION,
  MCPB_MANIFEST_VERSION,
  MCPB_NODE_RUNTIME,
  MCPB_TARGETS,
  mcpbAssetName,
  mcpbReleaseUrl,
  parseMcpbTarget,
} from '../src/mcpb/manifest.js';
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
    const packages = committed.packages as Array<Record<string, unknown>>;
    const mcpbEntry = packages.find((item) => item.registryType === 'mcpb');
    assert.ok(mcpbEntry !== undefined, 'в packages обязана быть запись MCPB (задача d1feff33)');
    const generated = buildServerJson({
      version: rootVersion,
      mcpbSha256: String(mcpbEntry.fileSha256),
    });
    assert.deepEqual(
      committed,
      generated,
      'server.json устарел — выполните npm -w @etn/server run generate:server-json',
    );
    assert.equal(committed.name, MCP_REGISTRY_NAME);
    assert.equal(committed.version, rootVersion);
  });

  it('server.json: запись npm и запись канонического MCPB-бандла', () => {
    const committed = readJson(path.join(REPO_ROOT, 'server.json'));
    const packages = committed.packages as Array<Record<string, unknown>>;
    assert.deepEqual(
      packages.map((item) => item.registryType),
      ['npm', 'mcpb'],
      'packages: npm-пакет, затем канонический MCPB-бандл win32-x64',
    );

    const npmEntry = packages[0] as Record<string, unknown>;
    assert.equal(npmEntry.identifier, NPM_PACKAGE_NAME);
    assert.equal(npmEntry.version, rootVersion);
    assert.deepEqual(npmEntry.transport, { type: 'stdio' });

    const slug = githubSlugFromRegistryName(MCP_REGISTRY_NAME);
    assert.equal(slug, 'nerkuda/e-tho-net', 'GitHub-slug выводится из имени реестра');

    const mcpbEntry = packages[1] as Record<string, unknown>;
    assert.equal(
      mcpbEntry.identifier,
      mcpbReleaseUrl(rootVersion, MCPB_CANONICAL_TARGET, slug),
      'идентификатор — URL релиза канонического бандла win32-x64',
    );
    assert.equal(
      String(mcpbEntry.identifier),
      `https://github.com/nerkuda/e-tho-net/releases/download/v${rootVersion}/` +
        `etn-mcp-${rootVersion}-win32-x64.mcpb`,
    );
    assert.equal(mcpbEntry.version, rootVersion);
    assert.deepEqual(mcpbEntry.transport, { type: 'stdio' });
    assert.match(String(mcpbEntry.fileSha256), /^[a-f0-9]{64}$/);

    const built = path.join(
      REPO_ROOT,
      'release',
      `etn-mcp-${rootVersion}-win32-x64${MCPB_EXTENSION}`,
    );
    if (fs.existsSync(built)) {
      const actual = createHash('sha256').update(fs.readFileSync(built)).digest('hex');
      assert.equal(
        mcpbEntry.fileSha256,
        actual,
        'fileSha256 обязан совпадать с собранным каноническим бандлом',
      );
    }
  });

  it('манифест MCPB: идентичность, точка входа, user_config и платформы', () => {
    const manifest = buildMcpbManifest({ version: rootVersion, target: MCPB_CANONICAL_TARGET });
    assert.equal(manifest.manifest_version, MCPB_MANIFEST_VERSION);
    assert.equal(MCPB_MANIFEST_VERSION, '0.3');
    assert.equal(manifest.name, MCP_SERVER_NAME, 'имя манифеста — имя рукопожатия');
    assert.equal(manifest.display_name, MCPB_DISPLAY_NAME);
    assert.equal(manifest.version, rootVersion);
    assert.deepEqual(manifest.author, { ...MCPB_AUTHOR });

    const server = manifest.server as Record<string, unknown>;
    assert.equal(server.type, 'node');
    assert.equal(server.entry_point, MCPB_ENTRY_POINT);
    assert.equal(
      MCPB_ENTRY_POINT,
      NPM_BIN_PATH,
      'entry_point бандла и bin пакета — один и тот же файл обёртки',
    );
    const config = server.mcp_config as Record<string, unknown>;
    assert.equal(config.command, 'node');
    assert.deepEqual(config.args, [['${__dirname}', NPM_BIN_PATH].join('/')]);
    assert.deepEqual(config.env, {
      ETN_DATA_DIR: '${user_config.data_dir}',
      ETN_API_KEY: '${user_config.api_key}',
    });

    const compatibility = manifest.compatibility as Record<string, unknown>;
    assert.deepEqual(compatibility.platforms, ['win32']);
    assert.deepEqual(compatibility.runtimes, { node: MCPB_NODE_RUNTIME });
    assert.equal(MCPB_NODE_RUNTIME, '>=22.2.0');
    assert.equal(manifest.tools_generated, true);

    const userConfig = manifest.user_config as Record<string, Record<string, unknown>>;
    assert.equal(userConfig.data_dir?.type, 'directory');
    assert.equal(userConfig.data_dir?.required, false);
    assert.equal(userConfig.api_key?.type, 'string');
    assert.equal(userConfig.api_key?.sensitive, true);
    assert.equal(userConfig.api_key?.required, false);
  });

  it('манифест MCPB: любая цель матрицы даёт свою ОС, чужая цель отвергается', () => {
    for (const target of MCPB_TARGETS) {
      const manifest = buildMcpbManifest({ version: rootVersion, target });
      const compatibility = manifest.compatibility as Record<string, unknown>;
      assert.deepEqual(compatibility.platforms, [target.split('-')[0]]);
    }
    assert.deepEqual(
      [...MCPB_TARGETS],
      ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64'],
      'матрица бандлов — четыре цели из решения задачи',
    );
    assert.ok((MCPB_TARGETS as readonly string[]).includes(MCPB_CANONICAL_TARGET));
    assert.throws(() => parseMcpbTarget('win32-arm64'), /unsupported MCPB target/);
    assert.throws(
      () => buildMcpbManifest({ version: rootVersion, target: 'sunos-x64' }),
      /unsupported MCPB target/,
    );
  });

  it('маркер целевой платформы бандла собирается из той же цели', () => {
    const marker = buildBundleTargetMarker({ version: rootVersion, target: 'darwin-arm64' });
    assert.equal(marker.kind, MCPB_BUNDLE_TARGET_KIND);
    assert.equal(marker.version, rootVersion);
    assert.equal(marker.platform, 'darwin');
    assert.equal(marker.arch, 'arm64');
    assert.equal(marker.target, 'darwin-arm64');
    assert.equal(
      MCPB_BUNDLE_TARGET_FILENAME,
      'etn-mcp-target.json',
      'маркер читает bin/platform.ts по этому имени',
    );
    const lib = readText(path.join(SERVER_ROOT, 'scripts', 'lib', 'mcpb-bundle.mjs'));
    assert.ok(
      lib.includes(`export const MCPB_BUNDLE_TARGET_KIND = '${MCPB_BUNDLE_TARGET_KIND}';`),
      'идентификатор маркера в сборщике обязан совпадать с src/mcpb/manifest.ts',
    );
  });

  it('имена артефактов несут версию, платформу и архитектуру', () => {
    for (const target of MCPB_TARGETS) {
      assert.equal(mcpbAssetName(rootVersion, target), `etn-mcp-${rootVersion}-${target}.mcpb`);
    }
    assert.throws(() => mcpbAssetName(rootVersion, 'win32-arm64'), /unsupported MCPB target/);
    assert.match(mcpbAssetName(rootVersion, MCPB_CANONICAL_TARGET), /-win32-x64\.mcpb$/);
  });

  it('генератор server.json не принимает fileSha256 не в нижнем регистре', () => {
    assert.throws(
      () => buildServerJson({ version: rootVersion, mcpbSha256: 'A'.repeat(64) }),
      /fileSha256 must be a lowercase SHA-256 hex string/,
    );
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
