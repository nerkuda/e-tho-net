/**
 * Входная точка npm-пакета `etn-mcp` (задача 760402ba, ADR ad67950b / aa9507e6).
 *
 * Проверяются обе обязанности обёртки `server/src/bin/etn-mcp.ts`:
 *
 * * **стражи платформы** — хост вне матрицы пакета и MCPB-бандл чужой
 *   архитектуры дают понятный английский текст, а не падение `require`
 *   (`platform.ts` — чистые функции, проверяются без нативной загрузки);
 * * **поведение bin** — без аргументов подставляется `mcp` и личный каталог
 *   данных (`ETN_DATA_DIR` не задан), знакомая подкоманда (`init`) проходит
 *   без подстановки, а stdio-сессия проходит `initialize` + `tools/list` и
 *   вызывает читающий инструмент, то есть stdout несёт только протокол.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { isEntryPoint } from '../src/bin/entry-point.js';
import { isNativeLoadFailure, nativeLoadErrorMessage, runEtnMcp } from '../src/bin/etn-mcp.js';
import {
  assertBundleTarget,
  assertSupportedHost,
  BUNDLE_TARGET_FILENAME,
  PlatformError,
  readBundleTarget,
  SUPPORTED_TARGETS,
  targetId,
} from '../src/bin/platform.js';
import {
  MCP_DIRNAME,
  MCP_KEY_FILENAME,
  MCP_OWNERSHIP_FILENAME,
} from '../src/bootstrap/data-dir.js';
import { defaultDataDir } from '../src/bootstrap/personal-dir.js';
import { nativeAvailable } from './mcp-helpers.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER_SOURCE = path.join(SERVER_ROOT, 'src', 'bin', 'etn-mcp.ts');

/** Окружение «чистой машины»: без ETN_*, каталоги ОС — во временном HOME. */
function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ETN_LOG_LEVEL: 'error' };
  for (const name of Object.keys(env)) {
    if (name.startsWith('ETN_')) delete env[name];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = path.join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  return env;
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

describe('стражи платформы etn-mcp', () => {
  it('личный каталог данных: пути для Windows, macOS и Linux', () => {
    assert.equal(
      defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u'),
      path.join('C:\\Users\\u\\AppData\\Local', 'etn-mcp'),
    );
    assert.equal(
      defaultDataDir({}, 'win32', 'C:\\Users\\u'),
      path.join('C:\\Users\\u', 'AppData', 'Local', 'etn-mcp'),
    );
    assert.equal(
      defaultDataDir({}, 'darwin', '/Users/u'),
      path.join('/Users/u', 'Library', 'Application Support', 'etn-mcp'),
    );
    assert.equal(
      defaultDataDir({ XDG_DATA_HOME: '/xdg' }, 'linux', '/home/u'),
      path.join('/xdg', 'etn-mcp'),
    );
    assert.equal(
      defaultDataDir({}, 'linux', '/home/u'),
      path.join('/home/u', '.local', 'share', 'etn-mcp'),
    );
  });

  it('darwin и linux-фолбэк следуют за env.HOME (подставной HOME smoke-теста)', () => {
    // macOS: путь строился от параметра homedir (os.homedir() вызывающего
    // процесса) и игнорировал HOME, поэтому smoke бандла проверял реальный дом
    // раннера, а не подставной каталог ребёнка (ошибка 40959532).
    assert.equal(
      defaultDataDir({ HOME: '/fake/home' }, 'darwin', '/Users/real'),
      path.join('/fake/home', 'Library', 'Application Support', 'etn-mcp'),
    );
    assert.equal(
      defaultDataDir({ HOME: '/fake/home' }, 'linux', '/home/real'),
      path.join('/fake/home', '.local', 'share', 'etn-mcp'),
    );
    // XDG_DATA_HOME остаётся приоритетнее HOME.
    assert.equal(
      defaultDataDir({ HOME: '/fake/home', XDG_DATA_HOME: '/xdg' }, 'linux', '/home/real'),
      path.join('/xdg', 'etn-mcp'),
    );
    // Пустой и пробельный HOME — прежний параметр homedir.
    for (const home of [undefined, '', '   ']) {
      const env: NodeJS.ProcessEnv = home === undefined ? {} : { HOME: home };
      assert.equal(
        defaultDataDir(env, 'darwin', '/Users/real'),
        path.join('/Users/real', 'Library', 'Application Support', 'etn-mcp'),
        `darwin без HOME (${JSON.stringify(home)}) — fallback на homedir`,
      );
      assert.equal(
        defaultDataDir(env, 'linux', '/home/real'),
        path.join('/home/real', '.local', 'share', 'etn-mcp'),
        `linux без HOME (${JSON.stringify(home)}) — fallback на homedir`,
      );
    }
    // Windows не меняется: LOCALAPPDATA, fallback — от параметра homedir.
    assert.equal(
      defaultDataDir({ HOME: '/fake/home' }, 'win32', 'C:\\Users\\u'),
      path.join('C:\\Users\\u', 'AppData', 'Local', 'etn-mcp'),
    );
  });

  it('хост из матрицы проходит, идентификатор цели стабилен', () => {
    assert.equal(targetId('win32', 'x64'), 'win32-x64');
    assert.ok((SUPPORTED_TARGETS as readonly string[]).includes('win32-x64'));
    assert.ok((SUPPORTED_TARGETS as readonly string[]).includes('darwin-arm64'));
    assert.ok((SUPPORTED_TARGETS as readonly string[]).includes('linux-x64'));
    const host = assertSupportedHost();
    assert.equal(host, targetId(process.platform, process.arch));
  });

  it('неподдержанный хост: PlatformError с матрицей, а не падение require', () => {
    assert.throws(
      () => assertSupportedHost('aix', 'ppc64'),
      (err: unknown) =>
        err instanceof PlatformError &&
        /Unsupported platform: aix-ppc64/.test(err.message) &&
        /win32-x64, win32-arm64, darwin-x64, darwin-arm64, linux-x64, linux-arm64, linux-arm/.test(
          err.message,
        ),
    );
  });

  it('isNativeLoadFailure распознаёт ошибку нативной загрузки', () => {
    const dlopen = Object.assign(new Error('dlopen failed'), { code: 'ERR_DLOPEN_FAILED' });
    assert.equal(isNativeLoadFailure(dlopen), true);
    assert.equal(
      isNativeLoadFailure(
        new Error('Cannot open C:\\pkg\\better_sqlite3.node: not a valid Win32 application'),
      ),
      true,
    );
    assert.equal(isNativeLoadFailure(new Error('database is locked')), false);
    assert.equal(isNativeLoadFailure('ERR_DLOPEN_FAILED'), false);
  });

  it('обёртка отказывает до загрузки сервера при чужой целевой платформе бандла', async () => {
    const dir = tempDir('etn-bin-target-');
    const hostTarget = targetId(process.platform, process.arch);
    const foreignTarget = hostTarget === 'darwin-arm64' ? 'linux-x64' : 'darwin-arm64';
    try {
      fs.writeFileSync(
        path.join(dir, BUNDLE_TARGET_FILENAME),
        JSON.stringify({ target: foreignTarget }),
      );
      const messages: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        messages.push(args.map((arg) => String(arg)).join(' '));
      };
      let code = -1;
      try {
        code = await runEtnMcp([process.execPath, 'etn-mcp'], {}, dir);
      } finally {
        console.error = originalError;
      }
      assert.equal(code, 1);
      assert.match(messages.join('\n'), /built for .* but the current host is/);
      assert.equal(fs.existsSync(path.join(dir, 'mcp')), false, 'до сервера дело не дошло');
    } finally {
      removeDir(dir);
    }
  });

  it('маркер бандла: нет файла — npm-пакет; свой маркер читается', () => {
    const dir = tempDir('etn-bundle-target-');
    try {
      assert.equal(readBundleTarget(dir), null);
      fs.writeFileSync(
        path.join(dir, BUNDLE_TARGET_FILENAME),
        JSON.stringify({ platform: 'darwin', arch: 'arm64' }),
      );
      assert.equal(readBundleTarget(dir), 'darwin-arm64');
      fs.writeFileSync(
        path.join(dir, BUNDLE_TARGET_FILENAME),
        JSON.stringify({ target: 'linux-x64' }),
      );
      assert.equal(readBundleTarget(dir), 'linux-x64');
      fs.writeFileSync(path.join(dir, BUNDLE_TARGET_FILENAME), '{ broken');
      assert.equal(readBundleTarget(dir), null, 'битый маркер = нет маркера');
    } finally {
      removeDir(dir);
    }
  });

  it('чужая целевая платформа бандла: PlatformError до загрузки модуля', () => {
    assert.doesNotThrow(() => assertBundleTarget(null, 'win32-x64'));
    assert.doesNotThrow(() => assertBundleTarget('win32-x64', 'win32-x64'));
    assert.throws(
      () => assertBundleTarget('darwin-arm64', 'win32-x64'),
      (err: unknown) =>
        err instanceof PlatformError &&
        /built for darwin-arm64, but the current host is win32-x64/.test(err.message),
    );
  });

  it('битый аддон настоящего better-sqlite3: единый текст, bootstrap не начат', () => {
    const root = tempDir('etn-bin-native-');
    const bundle = path.join(root, 'bundle');
    const modules = path.join(bundle, 'node_modules');
    /** Настоящий пакет из node_modules (server, затем корень) — не fake-заглушка. */
    const realModule = (name: string): string => {
      for (const base of [
        path.join(SERVER_ROOT, 'node_modules'),
        path.join(SERVER_ROOT, '..', 'node_modules'),
      ]) {
        const candidate = path.join(base, ...name.split('/'));
        if (fs.existsSync(candidate)) return candidate;
      }
      throw new Error(`нет ${name} в node_modules`);
    };
    try {
      // Нативный аддон ищется от файла обёртки, поэтому проверяем на копии
      // входа и его собственных импортов (до `../cli.js` дело не доходит).
      for (const relative of [
        'src/bin/etn-mcp.ts',
        'src/bin/entry-point.ts',
        'src/bin/platform.ts',
        'src/bootstrap/personal-dir.ts',
      ]) {
        const dest = path.join(bundle, ...relative.split('/'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(SERVER_ROOT, ...relative.split('/')), dest);
      }

      // Копия НАСТОЯЩЕГО пакета: package.json и lib/ берутся из node_modules,
      // испорчен только аддон. `better-sqlite3` грузит его в конструкторе
      // `Database`, поэтому импорт модуля сам по себе ничего не проверяет.
      const sqlite = path.join(modules, 'better-sqlite3');
      fs.mkdirSync(path.join(sqlite, 'build', 'Release'), { recursive: true });
      fs.copyFileSync(
        path.join(realModule('better-sqlite3'), 'package.json'),
        path.join(sqlite, 'package.json'),
      );
      fs.cpSync(path.join(realModule('better-sqlite3'), 'lib'), path.join(sqlite, 'lib'), {
        recursive: true,
      });
      fs.writeFileSync(path.join(sqlite, 'build', 'Release', 'better_sqlite3.node'), 'not native');
      for (const dependency of ['bindings', 'file-uri-to-path']) {
        fs.cpSync(realModule(dependency), path.join(modules, ...dependency.split('/')), {
          recursive: true,
        });
      }

      // Предпосылка теста: пакет ленивый — импорт проходит, конструктор падает.
      // Если better-sqlite3 начнёт грузить аддон жадно, эта проверка сообщит
      // об этом раньше, чем тест снова станет «зелёным на fake-поведении».
      const lazy = spawnSync(
        process.execPath,
        [
          '-e',
          `const Database = require(${JSON.stringify(sqlite)});` +
            `try { new Database(':memory:'); console.log('LOADED'); }` +
            ` catch (err) { console.log('imported'); console.log('code=' + err.code); }`,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );
      assert.match(
        lazy.stdout ?? '',
        /imported/,
        `настоящий пакет обязан импортироваться с битым аддоном: ${lazy.stdout ?? ''}${lazy.stderr ?? ''}`,
      );
      assert.match(lazy.stdout ?? '', /code=ERR_DLOPEN_FAILED/);

      const expected = nativeLoadErrorMessage(targetId(process.platform, process.arch));
      const home = path.join(root, 'home');
      // И режим `mcp` (подстановка), и `--help`: проверка нативной сборки идёт
      // до bootstrap, поэтому битый бандл не печатает ни справку, ни сырой стек.
      for (const args of [[], ['--help']]) {
        const run = spawnSync(
          process.execPath,
          ['--import', 'tsx', path.join(bundle, 'src', 'bin', 'etn-mcp.ts'), ...args],
          { cwd: SERVER_ROOT, env: cleanEnv(home), encoding: 'utf8', timeout: 60_000 },
        );
        const mode = args.join(' ') === '' ? 'mcp' : args.join(' ');
        assert.equal(run.status, 1, `${mode}: ожидался код 1, stderr: ${run.stderr ?? ''}`);
        assert.ok(
          (run.stderr ?? '').includes(expected),
          `${mode}: нет дружелюбного текста в stderr: ${run.stderr ?? ''}`,
        );
        assert.doesNotMatch(
          run.stderr ?? '',
          /not a valid Win32 application|invalid ELF header|ERR_DLOPEN_FAILED/,
          `${mode}: сырая ошибка загрузки нативного модуля не должна попадать в stderr`,
        );
      }
      assert.equal(
        fs.existsSync(path.join(home, 'AppData', 'Local', 'etn-mcp')),
        false,
        'bootstrap каталога данных не должен начаться при битом аддоне',
      );
    } finally {
      removeDir(root);
    }
  });
});

describe(
  'bin etn-mcp: подстановка подкоманды и личный каталог',
  { skip: !nativeAvailable() },
  () => {
    it('без аргументов: mcp + личный каталог, handshake и читающий инструмент', async () => {
      const root = tempDir('etn-bin-');
      const env = cleanEnv(path.join(root, 'home'));
      let client: Client | null = null;
      try {
        const spawnEnv: Record<string, string> = {};
        for (const [name, value] of Object.entries(env)) {
          if (value !== undefined) {
            spawnEnv[name] = value;
          }
        }
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', WRAPPER_SOURCE],
          cwd: SERVER_ROOT,
          env: spawnEnv,
          stderr: 'pipe',
        });
        client = new Client({ name: 'etn-bin-test', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);
        assert.ok(names.length > 0, 'tools/list обязан вернуть инструменты etn.*');
        assert.ok(
          names.every((name) => name.startsWith('etn.')),
          `инструменты вне пространства etn.*: ${names.filter((n) => !n.startsWith('etn.')).join(', ')}`,
        );
        assert.ok(
          names.includes('etn.guide'),
          'постоянный набор инструментов обязан включать etn.guide',
        );

        const read = await client.callTool({ name: 'etn.guide', arguments: {} });
        assert.notEqual(read.isError, true, 'etn.guide не должен падать');

        const dataDir = defaultDataDir(env);
        assert.equal(
          fs.existsSync(path.join(dataDir, '_system.db')),
          true,
          'база создана в личном каталоге',
        );
        assert.equal(fs.existsSync(path.join(dataDir, MCP_DIRNAME, MCP_OWNERSHIP_FILENAME)), true);
        const key = fs
          .readFileSync(path.join(dataDir, MCP_DIRNAME, MCP_KEY_FILENAME), 'utf8')
          .trim();
        assert.match(key, /^etn_[0-9a-f]{32}$/);
      } finally {
        if (client !== null) await client.close();
        removeDir(root);
      }
    });

    it('присоединение к живому серверу: ETN_DATA_DIR + ETN_API_KEY, mcp/ не создаётся', async () => {
      const root = tempDir('etn-bin-join-');
      const dataDir = path.join(root, 'data');
      const env = { ...cleanEnv(path.join(root, 'home')), ETN_DATA_DIR: dataDir };
      let client: Client | null = null;
      try {
        const init = spawnSync(
          process.execPath,
          ['--import', 'tsx', WRAPPER_SOURCE, 'init', '--username', 'join-admin'],
          { cwd: SERVER_ROOT, env, encoding: 'utf8' },
        );
        assert.equal(init.status, 0, init.stderr);
        const key = /^\s{2}(etn_[0-9a-f]{32})\s*$/m.exec(init.stdout)?.[1];
        assert.ok(key !== undefined, `нет ключа в выводе etn init: ${init.stdout}`);
        assert.equal(fs.existsSync(path.join(dataDir, 'mcp')), false);

        const spawnEnv: Record<string, string> = {};
        for (const [name, value] of Object.entries({ ...env, ETN_API_KEY: key })) {
          if (value !== undefined) spawnEnv[name] = value;
        }
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', WRAPPER_SOURCE],
          cwd: SERVER_ROOT,
          env: spawnEnv,
          stderr: 'pipe',
        });
        client = new Client({ name: 'etn-bin-join', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const tools = await client.listTools();
        assert.ok(tools.tools.some((tool) => tool.name === 'etn.guide'));
        assert.equal(
          fs.existsSync(path.join(dataDir, MCP_DIRNAME)),
          false,
          'присоединение не создаёт зону mcp/',
        );
      } finally {
        if (client !== null) await client.close();
        removeDir(root);
      }
    });

    it('знакомая подкоманда init проходит без подстановки mcp', () => {
      const root = tempDir('etn-bin-init-');
      const dataDir = path.join(root, 'data');
      const env = { ...cleanEnv(path.join(root, 'home')), ETN_DATA_DIR: dataDir };
      try {
        const run = spawnSync(
          process.execPath,
          ['--import', 'tsx', WRAPPER_SOURCE, 'init', '--username', 'bin-admin'],
          { cwd: SERVER_ROOT, env, encoding: 'utf8' },
        );
        assert.equal(run.status, 0, run.stderr);
        assert.equal(fs.existsSync(path.join(dataDir, '_system.db')), true);
        assert.equal(
          fs.existsSync(path.join(dataDir, MCP_DIRNAME)),
          false,
          'etn init не создаёт зону mcp/',
        );
      } finally {
        removeDir(root);
      }
    });

    it('ETN_API_KEY на неинициализированном каталоге: английский отказ, база не создаётся', () => {
      const root = tempDir('etn-bin-');
      const dataDir = path.join(root, 'data');
      const env = {
        ...cleanEnv(path.join(root, 'home')),
        ETN_DATA_DIR: dataDir,
        ETN_API_KEY: 'etn_deadbeef000000000000000000000000',
      };
      try {
        const run = spawnSync(process.execPath, ['--import', 'tsx', WRAPPER_SOURCE], {
          cwd: SERVER_ROOT,
          env,
          encoding: 'utf8',
        });
        assert.equal(run.status, 1);
        assert.match(run.stderr, /is not initialized/);
        assert.equal(fs.existsSync(path.join(dataDir, '_system.db')), false);
      } finally {
        removeDir(root);
      }
    });
  },
);

/**
 * Ошибка 06f03d71: точка входа сравнивалась по `path.resolve`, а ESM-загрузчик
 * Node раскрывает символические ссылки в `import.meta.url`. Запуск через
 * симлинк (macOS `/var/folders` во временном каталоге, npm-шим `.bin` на POSIX)
 * молча ничего не делал: процесс выходил с кодом 0 без вывода, MCP-клиент видел
 * `MCP error -32000: Connection closed`.
 */
describe('точка входа: распознавание через символическую ссылку в пути', () => {
  /** Ссылка на каталог: на Windows — junction (не требует прав администратора). */
  function linkDirectory(target: string, link: string): void {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }

  it('isEntryPoint: ссылка в пути не мешает, чужой файл — не точка входа', () => {
    const root = tempDir('etn-entry-');
    try {
      const real = path.join(root, 'real');
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, 'entry.js'), '// entry\n');
      const link = path.join(root, 'link');
      linkDirectory(real, link);

      const moduleFile = path.join(real, 'entry.js');
      assert.equal(
        isEntryPoint(path.join(link, 'entry.js'), moduleFile),
        true,
        'запуск через ссылку — та же точка входа',
      );
      assert.equal(isEntryPoint(moduleFile, moduleFile), true);
      assert.equal(isEntryPoint(path.join(link, 'other.js'), moduleFile), false);
      assert.equal(isEntryPoint(path.join(real, 'other.js'), moduleFile), false);
      assert.equal(isEntryPoint(undefined, moduleFile), false);
      assert.equal(isEntryPoint('', moduleFile), false);
      assert.equal(
        isEntryPoint('C:\\ETN\\ENTRY.JS', 'c:\\etn\\entry.js', 'win32'),
        true,
        'на Windows сравнение без учёта регистра',
      );
      assert.equal(
        isEntryPoint('C:\\ETN\\ENTRY.JS', 'c:\\etn\\entry.js', 'linux'),
        false,
        'на POSIX регистр значим',
      );
    } finally {
      removeDir(root);
    }
  });

  it(
    'bin через ссылку в пути исполняется, а не выходит молча',
    { skip: !nativeAvailable() },
    () => {
      const root = tempDir('etn-entry-bin-');
      try {
        const link = path.join(root, 'linked-bin');
        linkDirectory(path.join(SERVER_ROOT, 'src', 'bin'), link);
        const run = spawnSync(
          process.execPath,
          ['--import', 'tsx', path.join(link, 'etn-mcp.ts'), '--help'],
          { cwd: SERVER_ROOT, env: cleanEnv(path.join(root, 'home')), encoding: 'utf8' },
        );
        assert.equal(run.status, 0, run.stderr);
        assert.match(
          run.stdout,
          /Usage: etn <command>/,
          'обёртка обязана отработать: пустой вывод = точка входа не распознана',
        );
      } finally {
        removeDir(root);
      }
    },
  );
});
