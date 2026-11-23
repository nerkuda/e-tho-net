/**
 * Общий стейджинг серверной поставки (задача 760402ba, ADR ad67950b п. 3).
 *
 * Один построитель для трёх артефактов: `etn-server-<version>.tar.gz`, npm-пакет
 * `etn-mcp` и MCPB-бандл. Композиция одна — второй не писать.
 *
 * Стейдж:
 *   1. prod-зависимости сервера и markdown ставятся в отдельный `staging`
 *      каталог (`npm install --omit=dev`), версии фиксируются точные;
 *   2. в целевой каталог копируются `dist`, `migrations`, `node_modules`
 *      staging'а и физические копии workspace-библиотек `@etn/shared`/
 *      `@etn/markdown` (в рабочем дереве это junction'ы — `npm pack` их файлы
 *      не берёт, поэтому копии именно физические);
 *   3. служебные записи npm (`.bin`, `.package-lock.json`) удаляются.
 *
 * Модуль ничего не печатает сам: сообщения шагов — за скриптами.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Точная версия better-sqlite3 (AGENTS.md). */
export const BETTER_SQLITE3_VERSION = '11.1.2';

/** Workspace-библиотеки, попадающие в поставку физическими копиями. */
export const WORKSPACE_BUNDLES = [
  { name: 'shared', dir: 'shared' },
  { name: 'markdown', dir: 'markdown' },
];

/**
 * Удалить временный каталог сборки.
 *
 * На Windows свежесозданное дерево `node_modules` иногда остаётся под кратким
 * запретом (антивирус/индексатор), и `rmSync` падает `EBUSY` даже после
 * повторов. Сборка к этому моменту уже успешна: не валим её, а досоздаём
 * отдельный процесс удаления после выхода (он ретраит дольше).
 *
 * @param {string} dir - временный каталог сборки.
 */
export function removeWorkDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    return;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : 'unknown';
    const script =
      `require('node:fs').rmSync(${JSON.stringify(dir)},` +
      '{recursive:true,force:true,maxRetries:120,retryDelay:500})';
    try {
      spawn(process.execPath, ['-e', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      console.warn(`  временный каталог удаляется отдельным процессом (${code})`);
    } catch {
      console.warn(`  не удалось удалить временный каталог ${dir} (${code})`);
    }
  }
}

/** Прочитать JSON-файл. */
export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Ошибка шага сборки. */
export function fail(message) {
  throw new Error(message);
}

/**
 * Проверить, что сборка всех участников выполнена.
 *
 * @param {string} repoRoot - корень репозитория.
 * @param {{ requireBin?: boolean }} [options] - `requireBin` требует
 *   `dist/bin/etn-mcp.js` (npm-пакет и MCPB).
 */
export function assertBuildArtifacts(repoRoot, options = {}) {
  const artifacts = [
    path.join(repoRoot, 'server', 'dist', 'index.js'),
    path.join(repoRoot, 'server', 'dist', 'cli.js'),
    path.join(repoRoot, 'shared', 'dist', 'index.js'),
    path.join(repoRoot, 'markdown', 'dist', 'index.js'),
  ];
  if (options.requireBin === true) {
    artifacts.push(path.join(repoRoot, 'server', 'dist', 'bin', 'etn-mcp.js'));
  }
  for (const artifact of artifacts) {
    if (!existsSync(artifact)) {
      fail(
        `нет ${artifact} - сначала выполните npm run build:shared и npm -w @etn/server run build`,
      );
    }
  }
  return artifacts.length;
}

/**
 * Версия установленного пакета (server/node_modules, затем корневой).
 *
 * @param {string} repoRoot - корень репозитория.
 * @param {string} name - имя пакета.
 */
export function installedVersion(repoRoot, name) {
  const relative = name.split('/').join(path.sep);
  const candidates = [
    path.join(repoRoot, 'server', 'node_modules', relative, 'package.json'),
    path.join(repoRoot, 'node_modules', relative, 'package.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return String(readJson(candidate).version);
  }
  fail(`пакет ${name} не установлен - выполните npm install (Node 22) в корне`);
}

/**
 * Собрать карту prod-зависимостей с точными версиями.
 *
 * @param {{ repoRoot: string, serverPkg: object, markdownPkg: object }} input
 * @returns {Record<string, string>}
 */
export function collectProdDependencies({ repoRoot, serverPkg, markdownPkg }) {
  const dependencies = {};
  for (const name of Object.keys(serverPkg.dependencies ?? {})) {
    if (name.startsWith('@etn/')) continue;
    dependencies[name] = installedVersion(repoRoot, name);
  }
  for (const name of Object.keys(markdownPkg.dependencies ?? {})) {
    if (name.startsWith('@etn/') || name in dependencies) continue;
    dependencies[name] = installedVersion(repoRoot, name);
  }
  if (dependencies['better-sqlite3'] !== BETTER_SQLITE3_VERSION) {
    fail(
      `better-sqlite3 в server/package.json должен быть ${BETTER_SQLITE3_VERSION}, ` +
        `найден ${dependencies['better-sqlite3']}`,
    );
  }
  return dependencies;
}

/** Запустить npm с наследованием вывода. */
export function runNpm(args, cwd) {
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
 * Поставить prod-зависимости в отдельный staging-каталог.
 *
 * @param {{ workDir: string, dependencies: Record<string, string> }} input
 * @returns {string} путь к `node_modules` staging'а.
 */
export function prepareProdStaging({ workDir, dependencies }) {
  const stagingDir = path.join(workDir, 'staging');
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(
    path.join(stagingDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'etn-server-prod',
        private: true,
        description: 'Prod-зависимости ETN-сервера для релизной поставки (задача 6d93fe6f)',
        dependencies,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  runNpm(['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], stagingDir);
  return path.join(stagingDir, 'node_modules');
}

/**
 * Скомпоновать дерево поставки в `targetDir`.
 *
 * @param {{
 *   repoRoot: string,
 *   targetDir: string,
 *   stagingNodeModules: string,
 *   packageJson?: object,
 *   copyServerPackageJson?: boolean,
 * }} input
 *   `packageJson` — опубликованный манифест (npm/MCPB); иначе копируется
 *   `server/package.json` (tar.gz-поставка).
 */
export function composeServerTree({
  repoRoot,
  targetDir,
  stagingNodeModules,
  packageJson,
  copyServerPackageJson = false,
}) {
  const serverDir = path.join(repoRoot, 'server');
  mkdirSync(targetDir, { recursive: true });

  if (packageJson !== undefined && packageJson !== null) {
    writeFileSync(
      path.join(targetDir, 'package.json'),
      `${JSON.stringify(packageJson, null, 2)}\n`,
      'utf8',
    );
  } else if (copyServerPackageJson) {
    cpSync(path.join(serverDir, 'package.json'), path.join(targetDir, 'package.json'));
  } else {
    fail('composeServerTree: нужен packageJson или copyServerPackageJson=true');
  }

  cpSync(path.join(serverDir, 'dist'), path.join(targetDir, 'dist'), { recursive: true });
  cpSync(path.join(serverDir, 'migrations'), path.join(targetDir, 'migrations'), {
    recursive: true,
  });
  cpSync(stagingNodeModules, path.join(targetDir, 'node_modules'), { recursive: true });
  // Служебные записи npm в поставке не нужны: .bin - симлинки на staging,
  // .package-lock.json - история установки.
  rmSync(path.join(targetDir, 'node_modules', '.bin'), { recursive: true, force: true });
  rmSync(path.join(targetDir, 'node_modules', '.package-lock.json'), { force: true });

  for (const workspace of WORKSPACE_BUNDLES) {
    const sourceDir = path.join(repoRoot, workspace.dir);
    const dest = path.join(targetDir, 'node_modules', '@etn', workspace.name);
    cpSync(path.join(sourceDir, 'package.json'), path.join(dest, 'package.json'));
    cpSync(path.join(sourceDir, 'dist'), path.join(dest, 'dist'), { recursive: true });
  }
}

/**
 * Проверить обязательные файлы поставки.
 *
 * @param {string} root - корень дерева поставки.
 * @param {string[]} [extraRequired] - дополнительные абсолютные/относительные пути.
 */
export function assertServerTree(root, extraRequired = []) {
  const required = [
    path.join(root, 'package.json'),
    path.join(root, 'dist', 'index.js'),
    path.join(root, 'dist', 'cli.js'),
    path.join(root, 'node_modules', '@etn', 'shared', 'dist', 'index.js'),
    path.join(root, 'node_modules', '@etn', 'markdown', 'dist', 'index.js'),
    path.join(root, 'node_modules', 'better-sqlite3', 'package.json'),
    ...extraRequired.map((file) => (path.isAbsolute(file) ? file : path.join(root, file))),
  ];
  for (const file of required) {
    if (!existsSync(file)) fail(`в поставке нет обязательного файла: ${path.relative(root, file)}`);
  }
  for (const migrations of ['system', 'network']) {
    const dir = path.join(root, 'migrations', migrations);
    if (!existsSync(dir)) fail(`в поставке нет migrations/${migrations}`);
    const count = readdirSync(dir).filter((name) => name.endsWith('.sql')).length;
    if (count < 1) fail(`в migrations/${migrations} нет ни одного .sql`);
  }
}
