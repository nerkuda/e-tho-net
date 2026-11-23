#!/usr/bin/env node
/**
 * Сборка MCPB-бандла ETN (задача d1feff33, ADR ad67950b / aa9507e6 / d17c3a29).
 *
 * Бандл — one-click поставка MCP-сервера в Claude Desktop и подобные клиенты:
 * тот же стейджинг, что npm-пакет и tar.gz (`lib/server-staging.mjs`), плюс
 * `manifest.json` формата MCPB 0.3 и маркер целевой платформы. Universal-бандла
 * нет: `better-sqlite3` — нативный модуль, поэтому артефакт собирается на
 * целевой ОС (матрица — `.github/workflows/release.yml`), а архитектуру несёт
 * имя файла `etn-mcp-<version>-<platform>-<arch>.mcpb` и маркер внутри бандла.
 *
 * Шаги:
 *   1. проверка аргументов, версий и того, что сборка выполнена;
 *   2. staging prod-зависимостей и композиция дерева (общий модуль);
 *   3. `manifest.json` + `etn-mcp-target.json` в корень, проверка содержимого;
 *   4. smoke-тест дерева: MCP-рукопожатие, личный каталог, присоединение по
 *      ключу, инициализация пустого каталога, отказ на чужом каталоге;
 *   5. zip в `.mcpb`, распаковка обратно, повторная проверка и рукопожатие из
 *      распакованного бандла (то, что сделает клиент).
 *
 * Публикации здесь нет: артефакт — ассет GitHub Release, запись реестра
 * готовит `generate-server-json.mjs` (публикация — c823f1df).
 *
 * Использование:
 *   node server/scripts/build-mcpb.mjs --platform win32-x64 [--out release] [--skip-smoke]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  assertBundleContents,
  cleanEnv,
  fail,
  unzipArchive,
  writeBundleMetadata,
  zipDirectory,
} from './lib/mcpb-bundle.mjs';
import {
  assertBuildArtifacts,
  assertServerTree,
  BETTER_SQLITE3_VERSION,
  collectProdDependencies,
  composeServerTree,
  prepareProdStaging,
  readJson,
  removeWorkDir,
} from './lib/server-staging.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { NPM_BIN_PATH, buildNpmPackageManifest } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'server', 'dist', 'npm', 'package-manifest.js')).href
);
const { MCPB_TARGETS, buildBundleTargetMarker, buildMcpbManifest, mcpbAssetName } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'server', 'dist', 'mcpb', 'manifest.js')).href
);
const { defaultDataDir } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'server', 'dist', 'bootstrap', 'personal-dir.js')).href
);

function step(text) {
  console.log(`\n== ${text}`);
}

function parseArgs(argv) {
  const options = { out: 'release', platform: null, skipSmoke: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--platform') {
      options.platform = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--out') {
      options.out = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--skip-smoke') {
      options.skipSmoke = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Использование: node server/scripts/build-mcpb.mjs --platform <platform>-<arch> ' +
          '[--out release] [--skip-smoke]',
      );
      process.exit(0);
    } else {
      fail(`неизвестный аргумент: ${arg}`);
    }
  }
  if (options.out === '') fail('для --out нужен каталог');
  if (options.platform === null || options.platform === '') {
    fail(`для --platform нужна цель: ${MCPB_TARGETS.join(', ')}`);
  }
  if (!MCPB_TARGETS.includes(options.platform)) {
    fail(`неизвестная цель ${options.platform}; поддержаны: ${MCPB_TARGETS.join(', ')}`);
  }
  return options;
}

/** Цель текущей машины: бандл собирается только на своей ОС и архитектуре. */
function hostTarget() {
  return `${process.platform}-${process.arch}`;
}

/**
 * MCP-рукопожатие с бандлом: `initialize` + `tools/list` + чтение инструмента.
 *
 * @returns {Promise<number>} число инструментов.
 */
async function handshake(entryPoint, env, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint],
    env: { ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'etn-mcpb-smoke', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    if (!names.includes('etn.guide')) {
      fail(`${label}: в tools/list нет etn.guide (получено ${names.length} инструментов)`);
    }
    const guide = await client.callTool({ name: 'etn.guide', arguments: {} });
    if (guide.isError === true) fail(`${label}: etn.guide вернул ошибку`);
    return names.length;
  } finally {
    await client.close();
  }
}

/** Личный каталог бандла: та же логика, что в обёртке пакета. */
function personalDataDir(env) {
  return defaultDataDir(env);
}

/**
 * Smoke-тест дерева бандла (DoD 2/4): рукопожатие и правила каталога данных.
 *
 * @param {string} bundleDir - корень (собранный или распакованный).
 * @param {string} workDir - каталог для подставных HOME.
 */
async function smokeTest(bundleDir, workDir) {
  const entryPoint = path.join(bundleDir, ...NPM_BIN_PATH.split('/'));
  if (!existsSync(entryPoint)) fail(`в бандле нет ${NPM_BIN_PATH}`);

  step('Smoke: MCP-рукопожатие из бандла (личный каталог)');
  const home = path.join(workDir, 'home-personal');
  const env = cleanEnv(home);
  const tools = await handshake(entryPoint, env, 'личный каталог');
  const dataDir = personalDataDir(env);
  const keyFile = path.join(dataDir, 'mcp', 'key');
  const markerFile = path.join(dataDir, 'mcp', 'ownership.json');
  if (!existsSync(markerFile)) fail(`нет маркера владения ${markerFile}`);
  if (!existsSync(keyFile)) fail(`нет ключа ${keyFile}`);
  const key = readFileSync(keyFile, 'utf8').trim();
  console.log(`  tools/list: ${tools} инструментов; личный каталог ${dataDir}`);

  step('Smoke: присоединение к каталогу по ключу (без перевыпуска)');
  await handshake(entryPoint, { ...env, ETN_DATA_DIR: dataDir, ETN_API_KEY: key }, 'присоединение');
  if (readFileSync(keyFile, 'utf8').trim() !== key) {
    fail('присоединение по ключу перевыпустило mcp/key');
  }
  console.log('  присоединение по ETN_API_KEY работает, ключ не изменился');

  step('Smoke: пустой ETN_DATA_DIR инициализируется');
  const emptyDir = path.join(workDir, 'data-empty');
  mkdirSync(emptyDir, { recursive: true });
  await handshake(
    entryPoint,
    cleanEnv(path.join(workDir, 'home-empty'), { ETN_DATA_DIR: emptyDir }),
    'пустой каталог',
  );
  if (!existsSync(path.join(emptyDir, 'mcp', 'ownership.json'))) {
    fail('пустой ETN_DATA_DIR не получил маркер владения');
  }
  console.log('  пустой каталог инициализирован как личный');

  step('Smoke: чужой непустой каталог отвергается');
  const foreignDir = path.join(workDir, 'data-foreign');
  mkdirSync(foreignDir, { recursive: true });
  writeFileSync(path.join(foreignDir, 'notes.txt'), 'not ours', 'utf8');
  const foreign = spawnSync(process.execPath, [entryPoint], {
    env: cleanEnv(path.join(workDir, 'home-foreign'), { ETN_DATA_DIR: foreignDir }),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (foreign.status === 0) fail('бандл принял чужой непустой каталог данных');
  if (!/does not belong to etn-mcp/.test(foreign.stderr ?? '')) {
    fail(`чужой каталог отвергнут без понятного текста: ${(foreign.stderr ?? '').slice(0, 400)}`);
  }
  console.log('  чужой каталог отвергнут с английским текстом');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const host = hostTarget();
  if (options.platform !== host) {
    fail(
      `бандл ${options.platform} собирается только на целевой машине (текущая — ${host}): ` +
        'better-sqlite3 ставится нативно, cross-сборка не даёт проверяемого артефакта. ' +
        'Матрица ОС — .github/workflows/release.yml.',
    );
  }

  const rootPkg = readJson(path.join(REPO_ROOT, 'package.json'));
  const serverPkg = readJson(path.join(REPO_ROOT, 'server', 'package.json'));
  const markdownPkg = readJson(path.join(REPO_ROOT, 'markdown', 'package.json'));
  const sharedPkg = readJson(path.join(REPO_ROOT, 'shared', 'package.json'));
  const version = String(rootPkg.version);
  if (String(serverPkg.version) !== version) {
    fail(`версия server/package.json (${serverPkg.version}) не равна версии ETN (${version})`);
  }
  if (String(sharedPkg.version) !== version || String(markdownPkg.version) !== version) {
    fail('версии workspace-библиотек не равны версии ETN — бандл должен повторять версию ETN');
  }

  step('Проверка сборки');
  assertBuildArtifacts(REPO_ROOT, { requireBin: true });
  console.log('  server/dist (включая bin), shared/dist, markdown/dist на месте');

  const prodDependencies = collectProdDependencies({ repoRoot: REPO_ROOT, serverPkg, markdownPkg });
  const dependencies = {
    ...prodDependencies,
    '@etn/shared': String(sharedPkg.version),
    '@etn/markdown': String(markdownPkg.version),
  };
  const packageJson = buildNpmPackageManifest({
    version,
    enginesNode: String(rootPkg.engines?.node ?? '>=22.2.0'),
    dependencies,
    bundleDependencies: Object.keys(dependencies),
  });

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'etn-mcp-mcpb-'));
  try {
    step('Установка prod-зависимостей в staging');
    const stagingNodeModules = prepareProdStaging({ workDir, dependencies: prodDependencies });

    step('Композиция бандла');
    const bundleDir = path.join(workDir, `etn-mcp-${version}-${options.platform}`);
    composeServerTree({
      repoRoot: REPO_ROOT,
      targetDir: bundleDir,
      stagingNodeModules,
      packageJson,
    });
    writeBundleMetadata(bundleDir, {
      manifest: buildMcpbManifest({ version, target: options.platform }),
      marker: buildBundleTargetMarker({ version, target: options.platform }),
    });
    assertServerTree(bundleDir, [NPM_BIN_PATH, 'manifest.json', 'etn-mcp-target.json']);
    assertBundleContents(bundleDir, {
      version,
      target: options.platform,
      betterSqlite3Version: BETTER_SQLITE3_VERSION,
    });
    console.log('  manifest.json, маркер цели, dist, migrations, node_modules на месте');

    if (!options.skipSmoke) {
      await smokeTest(bundleDir, workDir);
    } else {
      console.log('\n  smoke-тест пропущен (--skip-smoke)');
    }

    step(`Упаковка ${mcpbAssetName(version, options.platform)}`);
    const outDir = path.resolve(REPO_ROOT, options.out);
    const assetPath = path.join(outDir, mcpbAssetName(version, options.platform));
    zipDirectory(bundleDir, assetPath);
    const sizeMb = (readFileSync(assetPath).length / 1024 / 1024).toFixed(1);
    console.log(`  ${path.relative(REPO_ROOT, assetPath)} - ${sizeMb} МБ`);

    step('Проверка архива: распаковка и рукопожатие из распакованного бандла');
    const unpackedDir = path.join(workDir, 'unpacked');
    unzipArchive(assetPath, unpackedDir);
    assertBundleContents(unpackedDir, {
      version,
      target: options.platform,
      betterSqlite3Version: BETTER_SQLITE3_VERSION,
    });
    if (!options.skipSmoke) {
      const home = path.join(workDir, 'home-unpacked');
      const tools = await handshake(
        path.join(unpackedDir, ...NPM_BIN_PATH.split('/')),
        cleanEnv(home),
        'распакованный бандл',
      );
      console.log(`  распакованный бандл отвечает: ${tools} инструментов`);
    }

    console.log(`\nИтог: ${assetPath}`);
  } finally {
    removeWorkDir(workDir);
  }
}

main().catch((error) => {
  console.error(`build-mcpb: ошибка: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
