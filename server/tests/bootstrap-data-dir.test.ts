/**
 * Bootstrap каталога данных пакета `etn-mcp` (задача 760402ba, ADR aa9507e6).
 *
 * Проверяется поведение, обещанное DoD 3/5:
 *   * пустой каталог инициализируется (администратор `etn-mcp`, маркер и ключ);
 *   * повторный запуск идемпотентен, ключ берётся из `mcp/key`;
 *   * БД + маркер без ключа → ключ перевыпускается;
 *   * каталог с администратором без маркера → только `ETN_API_KEY`;
 *   * чужой непустой каталог, повреждённый маркер и read-only каталог → отказ;
 *   * база от прерванной инициализации (`no-users-table`) и остаточный temp
 *     не мешают повторному запуску;
 *   * два параллельных запуска на пустом каталоге оба получают рабочий ключ.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import DatabaseConstructor from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { generateApiKey } from '../src/auth/api-key.js';
import {
  bootstrapDataDir,
  MCP_DIRNAME,
  MCP_KEY_FILENAME,
  MCP_OWNERSHIP_FILENAME,
  MCP_OWNERSHIP_KIND,
  MCP_TEMP_PREFIX,
  MCP_TEMP_SUFFIX,
  readOwnership,
} from '../src/bootstrap/data-dir.js';
import { initializeFirstUser } from '../src/bootstrap/first-user.js';
import { SystemDb } from '../src/db/system-db.js';
import { createApiKeyAuthProvider } from '../src/mcp/auth.js';
import { MCP_REGISTRY_NAME } from '../src/mcp/server.js';
import { SYSTEM_DB_FILENAME } from '../src/paths.js';
import { nativeAvailable } from './mcp-helpers.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR_MODULE = pathToFileURL(
  path.join(SERVER_ROOT, 'src', 'bootstrap', 'data-dir.ts'),
).href;

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function authWorks(dataDir: string, key: string): boolean {
  const sys = SystemDb.open(dataDir);
  try {
    return createApiKeyAuthProvider(sys)(key) !== null;
  } finally {
    sys.close();
  }
}

function initAdmin(dataDir: string): string {
  const sys = SystemDb.open(dataDir);
  const generated = generateApiKey();
  try {
    sys.transaction(() =>
      initializeFirstUser(sys, { username: 'admin', displayName: 'Admin' }, generated),
    );
  } finally {
    sys.close();
  }
  return generated.key;
}

function markerFile(dataDir: string): string {
  return path.join(dataDir, MCP_DIRNAME, MCP_OWNERSHIP_FILENAME);
}

/**
 * Запретить запись в каталог и вернуть функцию восстановления прав.
 *
 * Windows — через `icacls` (атрибут «только чтение» у каталога запись не
 * запрещает), POSIX — `chmod`. Тест «недоступный на запись» обязан проверять
 * штатный путь ошибки ФС, а не подмену.
 */
function denyWrite(dir: string): () => void {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME ?? '';
    if (user === '') throw new Error('не удалось определить пользователя для icacls');
    const result = spawnSync('icacls', [dir, '/deny', `${user}:W`], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`icacls /deny не сработал: ${result.stdout ?? ''}${result.stderr ?? ''}`);
    }
    return () => {
      spawnSync('icacls', [dir, '/remove:d', user], { encoding: 'utf8' });
    };
  }
  const mode = fs.statSync(dir).mode;
  fs.chmodSync(dir, 0o555);
  return () => fs.chmodSync(dir, mode);
}

function readMarker(dataDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(markerFile(dataDir), 'utf8')) as Record<string, unknown>;
}

describe('bootstrapDataDir (пакет etn-mcp)', { skip: !nativeAvailable() }, () => {
  it('инициализирует пустой каталог: маркер, ключ, администратор', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      const result = bootstrapDataDir({ dataDir, env: {}, serverVersion: '0.16.2' });
      assert.equal(result.source, 'created');
      assert.match(result.apiKey, /^etn_[0-9a-f]{32}$/);

      const marker = readMarker(dataDir);
      assert.equal(marker.kind, MCP_OWNERSHIP_KIND);
      assert.equal(marker.server_name, MCP_REGISTRY_NAME);
      assert.equal(marker.version, '0.16.2');

      const keyFile = path.join(dataDir, MCP_DIRNAME, MCP_KEY_FILENAME);
      assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), result.apiKey);
      assert.deepEqual(SystemDb.checkFirstUser(dataDir), { state: 'initialized' });
      assert.equal(authWorks(dataDir, result.apiKey), true);

      const leftovers = fs
        .readdirSync(dataDir)
        .filter((name) => name.startsWith(MCP_TEMP_PREFIX) && name.endsWith(MCP_TEMP_SUFFIX));
      assert.deepEqual(leftovers, [], 'temp-файлы после успешной записи не остаются');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('идемпотентен: второй запуск берёт mcp/key и ничего не перевыпускает', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      const first = bootstrapDataDir({ dataDir, env: {} });
      const second = bootstrapDataDir({ dataDir, env: {} });
      assert.equal(second.source, 'file');
      assert.equal(second.apiKey, first.apiKey);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('БД с администратором и маркером без ключа: ключ перевыпускается', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      const first = bootstrapDataDir({ dataDir, env: {} });
      fs.rmSync(path.join(dataDir, MCP_DIRNAME, MCP_KEY_FILENAME));
      const second = bootstrapDataDir({ dataDir, env: {} });
      assert.equal(second.source, 'reissued');
      assert.notEqual(second.apiKey, first.apiKey);
      assert.equal(authWorks(dataDir, second.apiKey), true);
      assert.equal(authWorks(dataDir, first.apiKey), true, 'старый ключ не отзывается');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('администратор без маркера: без ключа — отказ, mcp/ не создаётся', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      initAdmin(dataDir);
      assert.throws(() => bootstrapDataDir({ dataDir, env: {} }), /not owned by etn-mcp/);
      assert.equal(fs.existsSync(path.join(dataDir, MCP_DIRNAME)), false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('администратор без маркера + ETN_API_KEY: присоединение без mcp/', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      const key = initAdmin(dataDir);
      const result = bootstrapDataDir({ dataDir, env: { ETN_API_KEY: key } });
      assert.equal(result.source, 'environment');
      assert.equal(result.apiKey, key);
      assert.equal(fs.existsSync(path.join(dataDir, MCP_DIRNAME)), false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('ETN_API_KEY на неинициализированном каталоге — понятный отказ без создания БД', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      assert.throws(
        () =>
          bootstrapDataDir({
            dataDir,
            env: { ETN_API_KEY: 'etn_deadbeef000000000000000000000000' },
          }),
        /not initialized/,
      );
      assert.equal(fs.existsSync(path.join(dataDir, SYSTEM_DB_FILENAME)), false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('непустой чужой каталог: отказ, содержимое не меняется', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      fs.writeFileSync(path.join(dataDir, 'notes.txt'), 'keep me');
      assert.throws(() => bootstrapDataDir({ dataDir, env: {} }), /not empty/);
      assert.equal(fs.readFileSync(path.join(dataDir, 'notes.txt'), 'utf8'), 'keep me');
      assert.equal(fs.existsSync(path.join(dataDir, MCP_DIRNAME)), false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('пустая _system.db от прерванной попытки инициализируется заново', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      const db = new DatabaseConstructor(path.join(dataDir, SYSTEM_DB_FILENAME));
      db.close();
      assert.deepEqual(SystemDb.checkFirstUser(dataDir), {
        state: 'not-initialized',
        reason: 'no-users-table',
      });
      const result = bootstrapDataDir({ dataDir, env: {} });
      assert.equal(result.source, 'created');
      assert.deepEqual(SystemDb.checkFirstUser(dataDir), { state: 'initialized' });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('остаточный собственный temp-файл не делает каталог чужим', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      const leftover = path.join(
        dataDir,
        `${MCP_TEMP_PREFIX}ownership.json.1.dead${MCP_TEMP_SUFFIX}`,
      );
      fs.writeFileSync(leftover, 'stale');
      const result = bootstrapDataDir({ dataDir, env: {} });
      assert.equal(result.source, 'created');
      assert.equal(fs.existsSync(leftover), false, 'остаток удалён');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('повреждённый маркер без администратора = «маркера нет»: инициализация', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      fs.mkdirSync(path.join(dataDir, MCP_DIRNAME), { recursive: true });
      fs.writeFileSync(markerFile(dataDir), '{ broken json');
      assert.equal(readOwnership(dataDir).state, 'invalid');
      const result = bootstrapDataDir({ dataDir, env: {} });
      assert.equal(result.source, 'created');
      assert.equal(readOwnership(dataDir).state, 'own');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('повреждённый маркер при существующем администраторе: отказ, файл не перезаписан', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      initAdmin(dataDir);
      fs.mkdirSync(path.join(dataDir, MCP_DIRNAME), { recursive: true });
      fs.writeFileSync(markerFile(dataDir), JSON.stringify({ kind: 'other' }));
      assert.throws(() => bootstrapDataDir({ dataDir, env: {} }), /ownership marker is invalid/);
      assert.equal(fs.readFileSync(markerFile(dataDir), 'utf8'), JSON.stringify({ kind: 'other' }));
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('посторонний файл в mcp/ неинициализированного каталога: отказ, ничего не создаётся', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      fs.mkdirSync(path.join(dataDir, MCP_DIRNAME), { recursive: true });
      fs.writeFileSync(path.join(dataDir, MCP_DIRNAME, 'foreign.txt'), 'keep me');
      assert.throws(() => bootstrapDataDir({ dataDir, env: {} }), /not empty.*mcp\/foreign\.txt/s);
      assert.equal(
        fs.readFileSync(path.join(dataDir, MCP_DIRNAME, 'foreign.txt'), 'utf8'),
        'keep me',
      );
      assert.equal(fs.existsSync(markerFile(dataDir)), false);
      assert.equal(fs.existsSync(path.join(dataDir, SYSTEM_DB_FILENAME)), false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('неполный маркер без администратора = «маркера нет»: инициализация', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      fs.mkdirSync(path.join(dataDir, MCP_DIRNAME), { recursive: true });
      fs.writeFileSync(markerFile(dataDir), JSON.stringify({ kind: MCP_OWNERSHIP_KIND }));
      assert.equal(readOwnership(dataDir).state, 'invalid');
      const result = bootstrapDataDir({ dataDir, env: {} });
      assert.equal(result.source, 'created');
      assert.equal(readOwnership(dataDir).state, 'own');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('неполный маркер при администраторе: отказ без перезаписи', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      initAdmin(dataDir);
      fs.mkdirSync(path.join(dataDir, MCP_DIRNAME), { recursive: true });
      const original = JSON.stringify({
        kind: MCP_OWNERSHIP_KIND,
        server_name: 'io.github.nerkuda/e-tho-net',
      });
      fs.writeFileSync(markerFile(dataDir), original);
      assert.throws(
        () => bootstrapDataDir({ dataDir, env: {} }),
        /ownership marker is invalid: version is missing/,
      );
      assert.equal(fs.readFileSync(markerFile(dataDir), 'utf8'), original);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('присоединение к живому серверу: install.json и etn-service.xml не меняются, mcp/ нет', () => {
    const dataDir = tempDir('etn-mcp-boot-');
    const checksums = (): Record<string, string> => {
      const result: Record<string, string> = {};
      for (const name of ['install.json', 'etn-service.xml']) {
        result[name] = createHash('sha256')
          .update(fs.readFileSync(path.join(dataDir, name)))
          .digest('hex');
      }
      return result;
    };
    try {
      const key = initAdmin(dataDir);
      fs.writeFileSync(
        path.join(dataDir, 'install.json'),
        JSON.stringify({ port: 4321, mode: 'service' }),
      );
      fs.writeFileSync(path.join(dataDir, 'etn-service.xml'), '<service><id>ETN</id></service>');
      const before = checksums();
      const result = bootstrapDataDir({ dataDir, env: { ETN_API_KEY: key } });
      assert.equal(result.source, 'environment');
      assert.equal(result.apiKey, key);
      assert.deepEqual(checksums(), before, 'файлы установщика и конфиг службы не должны меняться');
      assert.equal(fs.existsSync(path.join(dataDir, MCP_DIRNAME)), false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('недоступный на запись каталог: понятный отказ, ничего не создаётся', (t) => {
    if (process.platform !== 'win32' && process.getuid?.() === 0) {
      t.skip('root игнорирует права каталога');
      return;
    }
    const dataDir = tempDir('etn-mcp-readonly-');
    const restore = denyWrite(dataDir);
    try {
      assert.throws(() => bootstrapDataDir({ dataDir, env: {} }), /not writable/);
    } finally {
      restore();
      // Только после снятия запрета можно убедиться, что каталог остался пустым:
      // deny-write закрывает и чтение списка на Windows.
      assert.deepEqual(fs.readdirSync(dataDir), [], 'в каталоге не должно появиться файлов');
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('недоступный каталог (путь через файл): понятный отказ', () => {
    const root = tempDir('etn-mcp-boot-');
    try {
      const blocker = path.join(root, 'blocker');
      fs.writeFileSync(blocker, 'file');
      const dataDir = path.join(blocker, 'data');
      assert.throws(() => bootstrapDataDir({ dataDir, env: {} }), /not available/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('два параллельных запуска: оба получают рабочий ключ, БД цела', async () => {
    const dataDir = tempDir('etn-mcp-boot-');
    try {
      const script =
        `import(${JSON.stringify(DATA_DIR_MODULE)}).then((m) => {` +
        `const r = m.bootstrapDataDir({ dataDir: ${JSON.stringify(dataDir)}, env: {} });` +
        `process.stdout.write(r.apiKey);` +
        `}).catch((e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1); });`;
      const runChild = () =>
        new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
          const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], {
            cwd: SERVER_ROOT,
            env: { ...process.env, ETN_DATA_DIR: '', ETN_API_KEY: '' },
          });
          let out = '';
          let err = '';
          child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
          child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
          child.on('exit', (code) => resolve({ code, out, err }));
        });

      const [a, b] = await Promise.all([runChild(), runChild()]);
      assert.equal(a.code, 0, a.err);
      assert.equal(b.code, 0, b.err);
      assert.match(a.out.trim(), /^etn_[0-9a-f]{32}$/);
      assert.match(b.out.trim(), /^etn_[0-9a-f]{32}$/);
      assert.deepEqual(SystemDb.checkFirstUser(dataDir), { state: 'initialized' });
      assert.equal(authWorks(dataDir, a.out.trim()), true);
      assert.equal(authWorks(dataDir, b.out.trim()), true);
      const db = new DatabaseConstructor(path.join(dataDir, SYSTEM_DB_FILENAME));
      try {
        const check = db.pragma('quick_check') as Array<{ quick_check: string }>;
        assert.equal(check[0]?.quick_check, 'ok');
      } finally {
        db.close();
      }
      assert.equal(readOwnership(dataDir).state, 'own');

      // DoD 5: ключ после гонки поднимает настоящую stdio-сессию.
      const client = new Client({ name: 'etn-boot-race', version: '1.0.0' }, { capabilities: {} });
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries({
        ...process.env,
        ETN_DATA_DIR: dataDir,
        ETN_API_KEY: a.out.trim(),
      })) {
        if (value !== undefined) env[name] = value;
      }
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', path.join(SERVER_ROOT, 'src', 'bin', 'etn-mcp.ts')],
          cwd: SERVER_ROOT,
          env,
          stderr: 'pipe',
        }),
      );
      try {
        const tools = await client.listTools();
        assert.ok(tools.tools.length > 0, 'после гонки сервер обязан отдать tools/list');
      } finally {
        await client.close();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
