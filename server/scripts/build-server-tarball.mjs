#!/usr/bin/env node
/**
 * Сборка `etn-server-<version>.tar.gz` — серверной поставки для Linux.
 *
 * Аналог `installer/fetch-payload.ps1` (там Windows-поставка с Node и WinSW):
 * здесь те же шаги раскладки серверной части, но без Windows-специфики —
 * Node 22 на целевой машине предполагается установленным (docs/userdocs/install.md),
 * поэтому в архив кладётся только то, что собирает репозиторий.
 *
 * Раскладка архива:
 *
 *   etn-server-<version>/
 *     README.txt          краткая инструкция запуска
 *     package.json        server/package.json без изменений
 *     dist/               сборка @etn/server
 *     migrations/         миграции system/ и network/
 *     node_modules/       prod-зависимости сервера плюс физические копии
 *                         @etn/shared и @etn/markdown (без npm-симлинков)
 *
 * Почему staging: prod-зависимости ставятся отдельным `npm install --omit=dev`
 * по точным версиям из дерева репозитория — состав поставки не «плывёт» от
 * диапазонов ^x.y.z. Workspace-пакеты @etn/* в npm не публикуются, их
 * package.json + dist копируются физически (как в fetch-payload.ps1).
 *
 * Проверки (по умолчанию): наличие сборки, обязательные файлы и миграции,
 * загрузка нативного better-sqlite3 и импорт @etn/* из архива, затем
 * smoke-test: `etn init` на временном каталоге данных, запуск сервера на
 * свободном порту и `GET /api/v1/health` с проверкой версии.
 *
 * Запуск (из корня репозитория, после `npm run build`):
 *
 *   node server/scripts/build-server-tarball.mjs [--out <каталог>]
 *        [--version X.Y.Z] [--skip-smoke-test]
 *
 * Задача 6d93fe6f (0.15.1); контракт имён ассетов — карточка задачи и
 * требование d9e2dcf8.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Версия better-sqlite3 у сервера жёстко зафиксирована (AGENTS.md). */
const BETTER_SQLITE3_VERSION = '11.1.2';

/** Предел ожидания health-check, мс (как в fetch-payload.ps1). */
const HEALTH_TIMEOUT_MS = 60_000;

/**
 * Ошибка сборки. Бросается, а не завершает процесс: `main` ловит её в
 * catch, а `finally` успевает убрать временный каталог.
 */
function fail(message) {
  throw new Error(message);
}

function step(text) {
  console.log(`\n== ${text}`);
}

function parseArgs(argv) {
  const options = { out: 'release', version: null, skipSmokeTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      options.out = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--version') {
      options.version = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--skip-smoke-test') {
      options.skipSmokeTest = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Использование: node server/scripts/build-server-tarball.mjs ' +
          '[--out <каталог>] [--version X.Y.Z] [--skip-smoke-test]',
      );
      process.exit(0);
    } else {
      fail(`неизвестный аргумент: ${arg}`);
    }
  }
  if (options.out === '') fail('для --out нужен каталог');
  return options;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Версия пакета, установленная в дереве репозитория (server/ или корень). */
function installedVersion(name) {
  const relative = name.split('/').join(path.sep);
  const candidates = [
    path.join(REPO_ROOT, 'server', 'node_modules', relative, 'package.json'),
    path.join(REPO_ROOT, 'node_modules', relative, 'package.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return String(readJson(candidate).version);
  }
  fail(`зависимость ${name} не установлена — выполните npm install (Node 22) и повторите`);
}

function runNpm(args, cwd) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    fail(`npm ${args.join(' ')} в ${cwd} завершился с кодом ${result.status}`);
  }
}

/**
 * Запуск node без вывода в консоль: `etn init` печатает первичный API-key,
 * которому не место в журнале сборки. Вывод показывается только при ошибке.
 */
function runNodeQuiet(args, cwd, env) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(
      `node ${args.join(' ')} в ${cwd} завершился с кодом ${result.status}: ` +
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

/** Свободный TCP-порт на loopback. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function smokeTest(tarballRoot, version, workDir) {
  const dataDir = path.join(workDir, 'smoke-data');
  rmSync(dataDir, { recursive: true, force: true });
  const port = await freePort();
  const env = {
    ...process.env,
    ETN_DATA_DIR: dataDir,
    ETN_PORT: String(port),
    ETN_HOST: '127.0.0.1',
  };

  step('Smoke-test: etn init + GET /api/v1/health');
  runNodeQuiet(
    ['dist/cli.js', 'init', '--username', 'admin', '--display-name', 'Smoke Test'],
    tarballRoot,
    env,
  );
  if (!existsSync(path.join(dataDir, '_system.db'))) {
    fail('etn init не создал _system.db — миграции не применились');
  }
  console.log('  etn init: _system.db создана (миграции найдены)');

  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: tarballRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on('data', () => {});

  let exited = false;
  let exitCode = null;
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = 'нет ответа';
  let health = null;
  try {
    while (Date.now() < deadline) {
      if (exited) {
        fail(`сервер завершился с кодом ${exitCode} до health-check. stderr: ${stderr.slice(-4000)}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
          signal: globalThis.AbortSignal.timeout(2000),
        });
        if (response.status === 200) {
          health = await response.json();
          break;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(500);
    }

    if (health === null) {
      fail(
        `health-check не прошёл за ${HEALTH_TIMEOUT_MS / 1000} с: ${lastError}. ` +
          `stderr: ${stderr.slice(-4000)}`,
      );
    }
    if (health.status !== 'ok') fail(`health-check вернул status=${health.status}, ожидалось ok`);
    if (health.version !== version) {
      fail(`health-check вернул версию ${health.version}, в поставке ${version}`);
    }
    console.log(`  GET /api/v1/health: 200, status=ok, version=${health.version}`);
  } finally {
    // Сервер останавливается при любом исходе: и при успехе, и при ошибке.
    if (!exited) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        if (exited) return resolve();
        child.once('exit', resolve);
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 10_000).unref();
      });
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const serverPkgPath = path.join(REPO_ROOT, 'server', 'package.json');
  const markdownPkgPath = path.join(REPO_ROOT, 'markdown', 'package.json');
  const serverPkg = readJson(serverPkgPath);
  const markdownPkg = readJson(markdownPkgPath);
  const version = options.version || String(serverPkg.version);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$/.test(version)) {
    fail(`некорректная версия: ${version}`);
  }

  const serverDir = path.join(REPO_ROOT, 'server');
  const sharedDir = path.join(REPO_ROOT, 'shared');
  const markdownDir = path.join(REPO_ROOT, 'markdown');

  step('Проверка сборки');
  for (const artifact of [
    path.join(serverDir, 'dist', 'index.js'),
    path.join(serverDir, 'dist', 'cli.js'),
    path.join(sharedDir, 'dist', 'index.js'),
    path.join(markdownDir, 'dist', 'index.js'),
  ]) {
    if (!existsSync(artifact)) {
      fail(`нет ${artifact} — сначала выполните npm run build:shared и npm -w @etn/server run build`);
    }
  }
  console.log('  server/dist, shared/dist, markdown/dist на месте');

  step('Prod-зависимости сервера');
  const dependencies = {};
  for (const name of Object.keys(serverPkg.dependencies ?? {})) {
    if (name.startsWith('@etn/')) continue;
    dependencies[name] = installedVersion(name);
  }
  for (const name of Object.keys(markdownPkg.dependencies ?? {})) {
    if (name.startsWith('@etn/') || name in dependencies) continue;
    dependencies[name] = installedVersion(name);
  }
  if (dependencies['better-sqlite3'] !== BETTER_SQLITE3_VERSION) {
    fail(
      `better-sqlite3 в server/package.json должен быть ${BETTER_SQLITE3_VERSION}, найдено ${dependencies['better-sqlite3']}`,
    );
  }

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'etn-server-tarball-'));
  try {
    const stagingDir = path.join(workDir, 'staging');
    const rootName = `etn-server-${version}`;
    const tarballRoot = path.join(workDir, rootName);

    step('Установка prod-зависимостей в staging');
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(
      path.join(stagingDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'etn-server-prod',
          private: true,
          description: 'Prod-зависимости ETN-сервера для релизного архива (задача 6d93fe6f)',
          dependencies,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    runNpm(['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], stagingDir);

    step('Сборка архива');
    cpSync(path.join(serverDir, 'package.json'), path.join(tarballRoot, 'package.json'));
    cpSync(path.join(serverDir, 'dist'), path.join(tarballRoot, 'dist'), { recursive: true });
    cpSync(path.join(serverDir, 'migrations'), path.join(tarballRoot, 'migrations'), {
      recursive: true,
    });
    cpSync(path.join(stagingDir, 'node_modules'), path.join(tarballRoot, 'node_modules'), {
      recursive: true,
    });
    // Служебные записи npm в поставке не нужны: .bin — симлинки на staging,
    // .package-lock.json — журнал установки.
    rmSync(path.join(tarballRoot, 'node_modules', '.bin'), { recursive: true, force: true });
    rmSync(path.join(tarballRoot, 'node_modules', '.package-lock.json'), { force: true });

    for (const workspace of [
      { name: 'shared', dir: sharedDir },
      { name: 'markdown', dir: markdownDir },
    ]) {
      const dest = path.join(tarballRoot, 'node_modules', '@etn', workspace.name);
      cpSync(path.join(workspace.dir, 'package.json'), path.join(dest, 'package.json'));
      cpSync(path.join(workspace.dir, 'dist'), path.join(dest, 'dist'), { recursive: true });
    }

    writeFileSync(
      path.join(tarballRoot, 'README.txt'),
      [
        `ETN server ${version}`,
        '='.repeat(`ETN server ${version}`.length),
        '',
        'Требуется Node.js 22 LTS.',
        '',
        'Первый запуск (создание администратора и первичного API-key):',
        '  ETN_DATA_DIR=/var/lib/etn node dist/cli.js init --username admin --display-name "Администратор"',
        '',
        'Запуск:',
        '  ETN_DATA_DIR=/var/lib/etn ETN_PORT=4321 node dist/index.js',
        '',
        'Проверка готовности:',
        '  curl http://127.0.0.1:4321/api/v1/health',
        '',
      ].join('\n'),
      'utf8',
    );

    const required = [
      path.join(tarballRoot, 'package.json'),
      path.join(tarballRoot, 'dist', 'index.js'),
      path.join(tarballRoot, 'dist', 'cli.js'),
      path.join(tarballRoot, 'node_modules', '@etn', 'shared', 'dist', 'index.js'),
      path.join(tarballRoot, 'node_modules', '@etn', 'markdown', 'dist', 'index.js'),
      path.join(tarballRoot, 'node_modules', 'better-sqlite3', 'package.json'),
    ];
    for (const file of required) {
      if (!existsSync(file)) fail(`в архиве нет обязательного файла: ${path.relative(workDir, file)}`);
    }
    for (const migrations of ['system', 'network']) {
      const dir = path.join(tarballRoot, 'migrations', migrations);
      if (!existsSync(dir)) fail(`в архиве нет migrations/${migrations}`);
      const count = readdirSync(dir).filter((name) => name.endsWith('.sql')).length;
      if (count < 1) fail(`в migrations/${migrations} нет ни одного .sql`);
      console.log(`  migrations/${migrations}: ${count} миграций`);
    }

    if (!options.skipSmokeTest) {
      await smokeTest(tarballRoot, version, workDir);
    } else {
      console.log('  smoke-test пропущен (--skip-smoke-test)');
    }

    step('Упаковка');
    const outDir = path.resolve(REPO_ROOT, options.out);
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${rootName}.tar.gz`);
    rmSync(outFile, { force: true });
    const tarArgs = ['-czf', `${rootName}.tar.gz`];
    if (process.platform === 'linux') {
      tarArgs.push('--owner=0', '--group=0', '--numeric-owner');
    }
    tarArgs.push('-C', workDir, rootName);
    // Архив называется относительным путём от outDir: GNU tar в Windows
    // принимает `C:\...` в -f за имя удалённого узла.
    const tarResult = spawnSync('tar', tarArgs, { cwd: outDir, stdio: 'inherit' });
    if (tarResult.status !== 0) fail(`tar завершился с кодом ${tarResult.status}`);

    const size = statSync(outFile).size;
    if (size === 0) fail(`получился пустой архив: ${outFile}`);
    console.log(`  ${path.relative(REPO_ROOT, outFile)} — ${(size / 1024 / 1024).toFixed(1)} МиБ`);
    console.log(`\nГотово: ${outFile}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    `build-server-tarball: ошибка: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
