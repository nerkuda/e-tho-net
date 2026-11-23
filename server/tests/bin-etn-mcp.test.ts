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

  it('мусорный better_sqlite3.node: дружелюбный текст вместо сырой ошибки загрузки', () => {
    const root = tempDir('etn-bin-native-');
    const tree = path.join(root, 'bundle');
    try {
      // Нативный модуль ищется от файла обёртки, поэтому подменить его можно
      // только рядом с её копией: копируем вход и его собственные импорты
      // (до `../cli.js` при падении предзагрузки дело не доходит).
      for (const relative of [
        'src/bin/etn-mcp.ts',
        'src/bin/platform.ts',
        'src/bootstrap/personal-dir.ts',
      ]) {
        const dest = path.join(tree, ...relative.split('/'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(SERVER_ROOT, ...relative.split('/')), dest);
      }
      const sqlite = path.join(tree, 'node_modules', 'better-sqlite3');
      fs.mkdirSync(path.join(sqlite, 'build', 'Release'), { recursive: true });
      fs.writeFileSync(
        path.join(sqlite, 'package.json'),
        `${JSON.stringify({ name: 'better-sqlite3', version: '11.1.2', main: 'index.js' })}\n`,
      );
      fs.writeFileSync(
        path.join(sqlite, 'index.js'),
        "module.exports = require('./build/Release/better_sqlite3.node');\n",
      );
      fs.writeFileSync(path.join(sqlite, 'build', 'Release', 'better_sqlite3.node'), 'not native');

      const env = cleanEnv(path.join(root, 'home'));
      const run = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join(tree, 'src', 'bin', 'etn-mcp.ts')],
        { cwd: SERVER_ROOT, env, encoding: 'utf8', timeout: 60_000 },
      );

      // Тот же текст, что и у стража целевой платформы бандла (DoD 2: обе
      // защиты дают понятное сообщение, а не стек `require`).
      const expected = nativeLoadErrorMessage(targetId(process.platform, process.arch));
      assert.equal(run.status, 1, `ожидался код 1, stderr: ${run.stderr ?? ''}`);
      assert.ok(
        (run.stderr ?? '').includes(expected),
        `нет дружелюбного текста в stderr: ${run.stderr ?? ''}`,
      );
      assert.doesNotMatch(
        run.stderr ?? '',
        /not a valid Win32 application|invalid ELF header|ERR_DLOPEN_FAILED/,
        'сырая ошибка загрузки нативного модуля не должна попадать в stderr',
      );
      assert.equal(
        fs.existsSync(path.join(env.HOME ?? '', 'AppData', 'Local', 'etn-mcp')),
        false,
        'до bootstrap каталога данных дело не дошло',
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
