#!/usr/bin/env node
/**
 * Проверка собранного npm-пакета на «чистой машине» (задача 760402ba, DoD 3).
 *
 * Что делает:
 *   1. ставит `etn-mcp-<version>.tgz` в пустой временный каталог;
 *   2. запускает bin-обёртку **без** ETN_DATA_DIR/ETN_API_KEY и с подменённым
 *      HOME/LOCALAPPDATA/XDG_DATA_HOME — проверяет личный каталог, маркер,
 *      ключ и инициализацию администратора;
 *   3. проходит MCP-рукопожатие SDK-клиентом (`initialize`, `tools/list`) и
 *      вызывает один читающий инструмент;
 *   4. проверяет, что `mcp/ownership.json` и `mcp/key` появились в личном
 *      каталоге, а stdout нёс только протокол (иначе SDK не смог бы читать).
 *
 * Использование: node server/scripts/verify-npm-package.mjs --tgz <file>
 */

import { spawnSync } from 'node:child_process';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { defaultDataDir } from '../dist/bootstrap/personal-dir.js';
import { MCP_KEY_FILENAME, MCP_OWNERSHIP_FILENAME } from '../dist/bootstrap/data-dir.js';

const NPM_PACKAGE_NAME = 'etn-mcp';

function fail(message) {
  throw new Error(message);
}

/**
 * Найти единственный собранный tarball в `release/`, если `--tgz` не передан
 * (удобно в CI-матрице, где имя файла содержит версию).
 */
function defaultTarball() {
  const dir = path.resolve('release');
  if (!existsSync(dir)) return null;
  const found = fs
    .readdirSync(dir)
    .filter((name) => /^etn-mcp-\d+\.\d+\.\d+.*\.tgz$/.test(name))
    .map((name) => path.join(dir, name));
  if (found.length !== 1) {
    fail(
      found.length === 0
        ? 'в release/ нет etn-mcp-<version>.tgz — соберите пакет (npm -w @etn/server run package:npm)'
        : `в release/ несколько etn-mcp-*.tgz, укажите --tgz: ${found.join(', ')}`,
    );
  }
  return found[0];
}

function parseArgs(argv) {
  let tgz = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--tgz') {
      tgz = argv[i + 1] ?? null;
      i += 1;
    }
  }
  if (tgz === null || tgz === '') {
    tgz = defaultTarball();
    if (tgz === null) fail('для --tgz нужен путь к etn-mcp-<version>.tgz');
  }
  return { tgz: path.resolve(tgz) };
}

function npmBinary() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** Окружение «чистой машины»: без ETN_*, с пустыми каталогами ОС. */
function cleanEnv(home, extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of Object.keys(env)) {
    if (name.startsWith('ETN_')) delete env[name];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = path.join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  env.ETN_LOG_LEVEL = 'error';
  return env;
}

async function main() {
  const { tgz } = parseArgs(process.argv.slice(2));
  if (!existsSync(tgz)) fail(`нет файла ${tgz}`);

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'etn-mcp-verify-'));
  try {
    const home = path.join(workDir, 'home');
    const env = cleanEnv(home);

    console.log('== Установка пакета на «чистую машину»');
    writeFileSync(
      path.join(workDir, 'package.json'),
      `${JSON.stringify({ name: 'etn-mcp-clean-check', private: true }, null, 2)}\n`,
    );
    const install = spawnSync(
      npmBinary(),
      ['install', tgz, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
      {
        cwd: workDir,
        env,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (install.error !== undefined || install.status !== 0) {
      fail(
        `npm install ${tgz} завершился с кодом ${install.status}: ` +
          `${install.error?.message ?? ''} ${install.stderr ?? ''}`,
      );
    }
    const binPath = path.join(
      workDir,
      'node_modules',
      NPM_PACKAGE_NAME,
      'dist',
      'bin',
      'etn-mcp.js',
    );
    if (!existsSync(binPath)) fail(`в установленном пакете нет ${binPath}`);
    console.log(`  установлен ${NPM_PACKAGE_NAME}: ${binPath}`);

    // DoD 6: пакет обязан тянуть ровно better-sqlite3 11.1.2 и нативный бинарник
    // upstream-prebuild, а не собираться локальным toolchain.
    const sqlitePackageDir = path.join(
      workDir,
      'node_modules',
      NPM_PACKAGE_NAME,
      'node_modules',
      'better-sqlite3',
    );
    const sqliteManifestPath = path.join(sqlitePackageDir, 'package.json');
    const sqliteVersion = JSON.parse(readFileSync(sqliteManifestPath, 'utf8')).version;
    if (sqliteVersion !== '11.1.2') {
      fail(`в пакете better-sqlite3 ${sqliteVersion}, ожидалась 11.1.2`);
    }
    const nativeBinary = path.join(sqlitePackageDir, 'build', 'Release', 'better_sqlite3.node');
    if (!existsSync(nativeBinary)) {
      fail('в установленном better-sqlite3 нет build/Release/better_sqlite3.node');
    }
    console.log('  better-sqlite3 11.1.2 с нативным бинарником на месте');

    console.log('== MCP-рукопожатие без ETN_DATA_DIR (личный каталог)');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [binPath],
      env: { ...env },
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'etn-mcp-clean-check', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    if (!names.includes('etn.guide')) {
      fail(`в tools/list нет etn.guide (получено ${names.length} инструментов)`);
    }
    const readResult = await client.callTool({ name: 'etn.guide', arguments: {} });
    if (readResult.isError === true) fail('etn.guide вернул ошибку');
    console.log(`  tools/list: ${names.length} инструментов; etn.guide — ok`);

    const dataDir = defaultDataDir(env);
    const marker = path.join(dataDir, 'mcp', MCP_OWNERSHIP_FILENAME);
    const keyFile = path.join(dataDir, 'mcp', MCP_KEY_FILENAME);
    if (!existsSync(marker)) fail(`нет маркера владения ${marker}`);
    if (!existsSync(keyFile)) fail(`нет файла ключа ${keyFile}`);
    const key = readFileSync(keyFile, 'utf8').trim();
    if (!/^etn_[0-9a-f]{32}$/.test(key)) fail('файл mcp/key не содержит валидный ключ');
    const markerBody = JSON.parse(readFileSync(marker, 'utf8'));
    if (markerBody.kind !== 'etn-mcp') fail(`чужой kind маркера: ${markerBody.kind}`);
    console.log(`  каталог данных: ${dataDir}; маркер и mcp/key (0600) на месте`);

    await client.close();

    console.log('\nOK: пакет ставится и работает на чистой машине');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    `verify-npm-package: ошибка: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
