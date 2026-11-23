#!/usr/bin/env node
/**
 * Сборка `etn-server-<version>.tar.gz` — серверной поставки для Linux.
 *
 * Композиция вынесена в общий модуль `server/scripts/lib/server-staging.mjs`
 * (задача 760402ba): тем же построителем пользуются npm-пакет `etn-mcp` и
 * MCPB-бандл. Здесь остаются только аргументы, smoke-тест и упаковка.
 *
 * Структура поставки:
 *
 *   etn-server-<version>/
 *     README.txt          краткая инструкция поставки
 *     package.json        server/package.json без изменений
 *     dist/               сборка @etn/server (включая dist/bin/etn-mcp.js)
 *     migrations/         миграции system/ и network/
 *     node_modules/       prod-зависимости + физические копии
 *                         @etn/shared и @etn/markdown
 *
 * Smoke-test: `etn init` во временном каталоге, затем `GET /api/v1/health`
 * с проверкой версии. Использование:
 *
 *   node server/scripts/build-server-tarball.mjs [--out <каталог>]
 *        [--version X.Y.Z] [--skip-smoke-test]
 *
 * Задача 6d93fe6f (0.15.1); разбор ошибок — грабли d9e2dcf8.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Предел ожидания health-check, мс (как в fetch-payload.ps1). */
const HEALTH_TIMEOUT_MS = 60_000;

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

/**
 * Запустить node с выводом в отчёт: `etn init` печатает API-key, который не
 * должен попасть в лог соборки. Вывод возвращается только при ошибке.
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
    fail('etn init не создал _system.db - миграции не применились');
  }
  console.log('  etn init: _system.db создан (миграции применены)');

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
        fail(
          `сервер завершился с кодом ${exitCode} до health-check. stderr: ${stderr.slice(-4000)}`,
        );
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
    if (health.status !== 'ok') fail(`health-check вернул status=${health.status}, ожидался ok`);
    if (health.version !== version) {
      fail(`health-check вернул версию ${health.version}, а в поставке ${version}`);
    }
    console.log(`  GET /api/v1/health: 200, status=ok, version=${health.version}`);
  } finally {
    // Сервер останавливается на любом выходе: и на успехе, и на ошибке.
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

  const serverPkg = readJson(path.join(REPO_ROOT, 'server', 'package.json'));
  const markdownPkg = readJson(path.join(REPO_ROOT, 'markdown', 'package.json'));
  const rootPkg = readJson(path.join(REPO_ROOT, 'package.json'));
  const version = options.version || String(rootPkg.version);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$/.test(version)) {
    fail(`некорректная версия: ${version}`);
  }
  if (String(serverPkg.version) !== version) {
    fail(`версия server/package.json (${serverPkg.version}) не равна версии ETN (${version})`);
  }

  step('Проверка сборки');
  const artifactCount = assertBuildArtifacts(REPO_ROOT);
  console.log(`  server/dist, shared/dist, markdown/dist на месте (${artifactCount} файлов)`);

  step('Prod-зависимости сервера');
  const dependencies = collectProdDependencies({ repoRoot: REPO_ROOT, serverPkg, markdownPkg });

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'etn-server-tarball-'));
  try {
    const rootName = `etn-server-${version}`;
    const tarballRoot = path.join(workDir, rootName);

    step('Установка prod-зависимостей в staging');
    const stagingNodeModules = prepareProdStaging({ workDir, dependencies });

    step('Сборка поставки');
    composeServerTree({
      repoRoot: REPO_ROOT,
      targetDir: tarballRoot,
      stagingNodeModules,
      copyServerPackageJson: true,
    });

    writeFileSync(
      path.join(tarballRoot, 'README.txt'),
      [
        `ETN server ${version}`,
        '='.repeat(`ETN server ${version}`.length),
        '',
        'Требуется Node.js 22 LTS.',
        '',
        'Первый запуск (создаёт администратора и печатает API-key):',
        '  ETN_DATA_DIR=/var/lib/etn node dist/cli.js init --username admin --display-name "Администратор"',
        '',
        'Запуск:',
        '  ETN_DATA_DIR=/var/lib/etn ETN_PORT=4321 node dist/index.js',
        '',
        'Проверка состояния:',
        '  curl http://127.0.0.1:4321/api/v1/health',
        '',
      ].join('\n'),
      'utf8',
    );

    assertServerTree(tarballRoot);
    for (const migrations of ['system', 'network']) {
      const dir = path.join(tarballRoot, 'migrations', migrations);
      const count = readdirSync(dir).filter((name) => name.endsWith('.sql')).length;
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
    // Архив открывается относительно outDir: GNU tar на Windows принимает
    // `C:\...` в -f без дополнительного экранирования.
    const tarResult = spawnSync('tar', tarArgs, { cwd: outDir, stdio: 'inherit' });
    if (tarResult.status !== 0) fail(`tar завершился с кодом ${tarResult.status}`);

    const size = statSync(outFile).size;
    if (size === 0) fail(`пустой файл архива: ${outFile}`);
    console.log(`  ${path.relative(REPO_ROOT, outFile)} - ${(size / 1024 / 1024).toFixed(1)} МБ`);
    console.log(`\nИтог: ${outFile}`);
  } finally {
    removeWorkDir(workDir);
  }
}

main().catch((error) => {
  console.error(
    `build-server-tarball: ошибка: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
