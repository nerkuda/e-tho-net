#!/usr/bin/env node
/**
 * Сборка npm-пакета `etn-mcp` (задача 760402ba, ADR d17c3a29).
 *
 * Пакет — единственная публикуемая упаковка MCP-сервера ETN: полный рантайм
 * `@etn/server` из общего стейджинга (`lib/server-staging.mjs`), bundled
 * workspace-библиотеки (`@etn/shared`, `@etn/markdown`) и все prod-зависимости,
 * чтобы `npx` работал без сети и без toolchain.
 *
 * Публикация (`npm publish`) сюда НЕ входит: до заморозки версии и тега
 * релиза делается только `npm pack` и проверки (ADR, порядок публикации).
 *
 * Шаги:
 *   1. проверка сборки (нужен `dist/bin/etn-mcp.js`);
 *   2. staging prod-зависимостей и композиция дерева пакета;
 *   3. `npm pack` из стейджинга с ФИЗИЧЕСКИМИ копиями @etn/*;
 *   4. проверка списка файлов tarball и чистой установки (`npm ls` без UNMET).
 *
 * Использование:
 *   node server/scripts/build-npm-package.mjs [--out release] [--skip-install-check]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertBuildArtifacts,
  assertServerTree,
  collectProdDependencies,
  composeServerTree,
  fail,
  prepareProdStaging,
  readJson,
  removeWorkDir,
} from './lib/server-staging.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { NPM_PACKAGE_NAME, NPM_BIN_PATH, buildNpmPackageManifest } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'server', 'dist', 'npm', 'package-manifest.js')).href
);

/** Обязательные записи tarball (после проверки существования dist). */
const REQUIRED_TARBALL_PATHS = [
  'package.json',
  'README.md',
  'dist/index.js',
  'dist/cli.js',
  NPM_BIN_PATH,
  'node_modules/@etn/shared/package.json',
  'node_modules/@etn/shared/dist/index.js',
  'node_modules/@etn/markdown/package.json',
  'node_modules/@etn/markdown/dist/index.js',
  'node_modules/better-sqlite3/package.json',
];

function step(text) {
  console.log(`\n== ${text}`);
}

function parseArgs(argv) {
  const options = { out: 'release', skipInstallCheck: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      options.out = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--skip-install-check') {
      options.skipInstallCheck = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Использование: node server/scripts/build-npm-package.mjs [--out release] [--skip-install-check]',
      );
      process.exit(0);
    } else {
      fail(`неизвестный аргумент: ${arg}`);
    }
  }
  if (options.out === '') fail('для --out нужен каталог');
  return options;
}

function npmBinary() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** Запустить npm и вернуть stdout (stderr наследуется). */
function runNpmCapture(args, cwd) {
  const result = spawnSync(npmBinary(), args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    // `npm pack --json` печатает список всех файлов tarball: на полном рантайме
    // это несколько мегабайт, дефолтный maxBuffer обрывает процесс.
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(
      `npm ${args.join(' ')} в ${cwd} завершился с кодом ${result.status}: ` +
        `${(result.stdout ?? '').slice(0, 2000)}${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

/** Разобрать вывод `npm pack --json`. */
function parsePackJson(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start === -1 || end <= start) fail(`не разобран вывод npm pack: ${trimmed.slice(0, 400)}`);
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function assertPackContents(entries) {
  const paths = new Set(entries.map((entry) => entry.path));
  for (const required of REQUIRED_TARBALL_PATHS) {
    if (!paths.has(required)) fail(`в tarball нет обязательного файла: ${required}`);
  }
  if (![...paths].some((p) => /^migrations\/(system|network)\/[^/]+\.sql$/.test(p))) {
    fail('в tarball нет .sql-миграций');
  }
  const forbidden = [...paths].filter(
    (p) =>
      !p.startsWith('node_modules/') &&
      (p.startsWith('src/') || p.startsWith('tests/') || p.includes('.test.')),
  );
  if (forbidden.length > 0) fail(`в tarball попали исходники/тесты: ${forbidden.slice(0, 5)}`);
  console.log(`  tarball: ${paths.size} файлов, обязательные на месте, исходников и тестов нет`);
}

function assertCleanInstall(tarballPath, workDir) {
  step('Проверка чистой установки (npm install + npm ls)');
  const projectDir = path.join(workDir, 'install-check');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    path.join(projectDir, 'package.json'),
    `${JSON.stringify({ name: 'etn-mcp-install-check', private: true }, null, 2)}\n`,
    'utf8',
  );
  runNpmCapture(
    ['install', tarballPath, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
    projectDir,
  );
  const lsRaw = runNpmCapture(['ls', '--omit=dev', '--json'], projectDir);
  const tree = JSON.parse(lsRaw);
  const problems = Array.isArray(tree.problems) ? tree.problems : [];
  if (problems.length > 0) {
    fail(`npm ls нашёл проблемы: ${problems.slice(0, 5).join('; ')}`);
  }
  const installedManifest = readJson(
    path.join(projectDir, 'node_modules', NPM_PACKAGE_NAME, 'package.json'),
  );
  if (installedManifest.name !== NPM_PACKAGE_NAME) {
    fail(`установился не тот пакет: ${installedManifest.name}`);
  }
  const installedBin = path.join(projectDir, 'node_modules', NPM_PACKAGE_NAME, NPM_BIN_PATH);
  if (!existsSync(installedBin)) fail(`в установленном пакете нет ${NPM_BIN_PATH}`);
  console.log('  npm ls: проблем нет (UNMET DEPENDENCY отсутствует), bin на месте');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const rootPkg = readJson(path.join(REPO_ROOT, 'package.json'));
  const serverPkg = readJson(path.join(REPO_ROOT, 'server', 'package.json'));
  const markdownPkg = readJson(path.join(REPO_ROOT, 'markdown', 'package.json'));
  const sharedPkg = readJson(path.join(REPO_ROOT, 'shared', 'package.json'));
  const version = String(rootPkg.version);
  if (String(serverPkg.version) !== version) {
    fail(`версия server/package.json (${serverPkg.version}) не равна версии ETN (${version})`);
  }
  if (String(sharedPkg.version) !== version || String(markdownPkg.version) !== version) {
    fail('версии workspace-библиотек не равны версии ETN — пакет должен повторять версию ETN');
  }

  step('Проверка сборки');
  assertBuildArtifacts(REPO_ROOT, { requireBin: true });
  console.log('  server/dist (включая bin), shared/dist, markdown/dist на месте');

  const prodDependencies = collectProdDependencies({
    repoRoot: REPO_ROOT,
    serverPkg,
    markdownPkg,
  });
  const dependencies = {
    ...prodDependencies,
    '@etn/shared': String(sharedPkg.version),
    '@etn/markdown': String(markdownPkg.version),
  };
  const bundleDependencies = Object.keys(dependencies);
  const manifest = buildNpmPackageManifest({
    version,
    enginesNode: String(rootPkg.engines?.node ?? '>=22.2.0'),
    dependencies,
    bundleDependencies,
  });

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'etn-mcp-npm-'));
  try {
    step('Установка prod-зависимостей в staging');
    const stagingNodeModules = prepareProdStaging({ workDir, dependencies: prodDependencies });

    step('Композиция пакета');
    const packageDir = path.join(workDir, `${NPM_PACKAGE_NAME}-${version}`);
    composeServerTree({
      repoRoot: REPO_ROOT,
      targetDir: packageDir,
      stagingNodeModules,
      packageJson: manifest,
    });
    writeFileSync(
      path.join(packageDir, 'README.md'),
      [
        `# ${NPM_PACKAGE_NAME}`,
        '',
        'MCP server for ETN — a self-hosted graph-of-thoughts knowledge base.',
        '',
        '## Quick start',
        '',
        '```',
        'npx -y etn-mcp',
        '```',
        '',
        'Run without arguments starts the MCP server over stdio and initializes a',
        'personal data directory (`%LOCALAPPDATA%\\etn-mcp`,',
        '`~/Library/Application Support/etn-mcp`, `${XDG_DATA_HOME:-~/.local/share}/etn-mcp`).',
        'An API key is generated and stored in `<data dir>/mcp/key` (0600); it is',
        'included in backups of the data directory.',
        '',
        'To attach to an existing ETN server:',
        '',
        '```',
        'ETN_DATA_DIR=/path/to/etn/data ETN_API_KEY=etn_... npx -y etn-mcp',
        '```',
        '',
        'Other CLI commands are available as-is: `init`, `backup`, `restore`,',
        '`publications`.',
        '',
      ].join('\n'),
      'utf8',
    );
    assertServerTree(packageDir, [NPM_BIN_PATH]);

    step(`npm pack (${NPM_PACKAGE_NAME}@${version})`);
    const outDir = path.resolve(REPO_ROOT, options.out);
    mkdirSync(outDir, { recursive: true });
    const packRaw = runNpmCapture(['pack', '--json', '--pack-destination', outDir], packageDir);
    const packed = parsePackJson(packRaw);
    const record = Array.isArray(packed) ? packed[0] : packed;
    if (!record || typeof record.filename !== 'string') {
      fail(`npm pack не вернул имя файла: ${packRaw.slice(0, 400)}`);
    }
    assertPackContents(Array.isArray(record.files) ? record.files : []);
    const tarballPath = path.join(outDir, record.filename);
    const sizeMb = (Number(record.size ?? 0) / 1024 / 1024).toFixed(1);
    console.log(`  ${path.relative(REPO_ROOT, tarballPath)} - ${sizeMb} МБ`);

    if (!options.skipInstallCheck) {
      assertCleanInstall(tarballPath, workDir);
    } else {
      console.log('  проверка установки пропущена (--skip-install-check)');
    }

    console.log(`\nИтог: ${tarballPath}`);
  } finally {
    removeWorkDir(workDir);
  }
}

main().catch((error) => {
  console.error(
    `build-npm-package: ошибка: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
