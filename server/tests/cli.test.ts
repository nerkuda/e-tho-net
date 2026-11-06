/**
 * Unit + integration tests for the ETN CLI (task B6).
 *
 * Pure argument-parsing tests always run. The end-to-end `etn init` test
 * requires the `better-sqlite3` native binding and is skipped otherwise.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { main, parseInitArgs } from '../src/cli.js';
import { runMigrations } from '../src/db/migrator.js';
import { SystemDb } from '../src/db/system-db.js';
import { systemMigrationsDir } from '../src/paths.js';

/** Capture console.{log,error} output during an async callback. */
async function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origInfo = console.info;
  console.log = (...a: unknown[]) => void stdout.push(a.join(' '));
  console.error = (...a: unknown[]) => void stderr.push(a.join(' '));
  console.info = (...a: unknown[]) => void stdout.push(a.join(' '));
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.info = origInfo;
  }
}

describe('parseInitArgs', () => {
  it('parses --username and --display-name', () => {
    assert.deepEqual(parseInitArgs(['--username', 'admin', '--display-name', 'Admin']), {
      username: 'admin',
      displayName: 'Admin',
      check: false,
      keyOut: null,
    });
  });

  it('parses the --flag=value form', () => {
    assert.deepEqual(parseInitArgs(['--username=admin', '--display-name=Root User']), {
      username: 'admin',
      displayName: 'Root User',
      check: false,
      keyOut: null,
    });
  });

  it('parses short -u / -d', () => {
    assert.deepEqual(parseInitArgs(['-u', 'bob', '-d', 'Bob']), {
      username: 'bob',
      displayName: 'Bob',
      check: false,
      keyOut: null,
    });
  });

  it('returns null displayName when omitted', () => {
    assert.deepEqual(parseInitArgs(['--username', 'solo']), {
      username: 'solo',
      displayName: null,
      check: false,
      keyOut: null,
    });
  });

  it('trims whitespace and nulls-out blank display name', () => {
    assert.deepEqual(parseInitArgs(['--username', '  x  ', '--display-name', '   ']), {
      username: 'x',
      displayName: null,
      check: false,
      keyOut: null,
    });
  });

  it('parses --key-out in both forms', () => {
    assert.equal(
      parseInitArgs(['--username', 'a', '--key-out', 'C:\\data\\key.txt']).keyOut,
      'C:\\data\\key.txt',
    );
    assert.equal(
      parseInitArgs(['--username', 'a', '--key-out=C:\\data\\key.txt']).keyOut,
      'C:\\data\\key.txt',
    );
  });

  it('parses --check without a username', () => {
    assert.deepEqual(parseInitArgs(['--check']), {
      username: '',
      displayName: null,
      check: true,
      keyOut: null,
    });
  });

  it('rejects --check combined with initialisation arguments', () => {
    assert.throws(() => parseInitArgs(['--check', '--username', 'admin']), /--check/);
    assert.throws(() => parseInitArgs(['--check', '--key-out', 'x']), /--check/);
  });

  it('throws when --username is missing', () => {
    assert.throws(() => parseInitArgs([]), /--username/);
  });

  it('throws when --key-out has no value', () => {
    assert.throws(() => parseInitArgs(['--username', 'a', '--key-out']), /--key-out/);
  });

  it('throws on unknown argument', () => {
    assert.throws(() => parseInitArgs(['--username', 'a', '--bogus']), /Unknown argument/);
  });
});

describe('main (no native required)', () => {
  it('prints help and returns 1 when no command is given', async () => {
    const { result, stdout } = await captureConsole(() => main({ argv: ['node', 'etn'] }));
    assert.equal(result, 1);
    assert.ok(stdout.join('\n').includes('Usage'));
  });

  it('returns 0 on --help', async () => {
    const { result } = await captureConsole(() => main({ argv: ['node', 'etn', '--help'] }));
    assert.equal(result, 0);
  });

  it('returns 1 on an unknown command', async () => {
    const { result, stderr } = await captureConsole(() =>
      main({ argv: ['node', 'etn', 'frobnicate'] }),
    );
    assert.equal(result, 1);
    assert.ok(stderr.join('\n').includes('Unknown command'));
  });

  it('fails with a config error when ETN_DATA_DIR is missing', async () => {
    const { result, stderr } = await captureConsole(() =>
      main({ argv: ['node', 'etn', 'init', '--username', 'admin'], env: {} }),
    );
    assert.equal(result, 1);
    assert.ok(stderr.join('\n').includes('ETN_DATA_DIR'));
  });

  it('fails when --username is missing', async () => {
    const { result, stderr } = await captureConsole(() =>
      main({ argv: ['node', 'etn', 'init'], env: { ETN_DATA_DIR: '/tmp/etn-cli-test' } }),
    );
    assert.equal(result, 1);
    assert.ok(stderr.join('\n').includes('--username'));
  });
});

// --- integration (requires native binding) ---------------------------------

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe(
  'main init (integration)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const tmpRoots: string[] = [];

    afterEach(() => {
      while (tmpRoots.length) {
        const dir = tmpRoots.pop()!;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('creates the first admin, prints the key once, and refuses re-init', async () => {
      const dataDir = mkdtempSync(path.join(os.tmpdir(), 'etn-cli-'));
      tmpRoots.push(dataDir);

      const env = { ETN_DATA_DIR: dataDir };

      const first = await captureConsole(() =>
        main({
          argv: ['node', 'etn', 'init', '--username', 'admin', '--display-name', 'Admin'],
          env,
        }),
      );
      assert.equal(first.result, 0);
      assert.ok(existsSync(path.join(dataDir, '_system.db')), 'system db was created');
      const out1 = first.stdout.join('\n');
      assert.match(out1, /etn_[0-9a-f]{32}/);
      assert.ok(out1.includes('shown once'));

      // Re-running must be refused (already initialised).
      const second = await captureConsole(() =>
        main({ argv: ['node', 'etn', 'init', '--username', 'other'], env }),
      );
      assert.equal(second.result, 1);
      assert.ok(second.stderr.join('\n').includes('already initialized'));

      // The printed key must not appear in the re-init output.
      assert.doesNotMatch(second.stdout.join('\n'), /etn_[0-9a-f]{32}/);
    });

    it('--check reports the state without creating anything, then follows hasFirstUser', async () => {
      const dataDir = mkdtempSync(path.join(os.tmpdir(), 'etn-cli-check-'));
      tmpRoots.push(dataDir);

      // Чистый каталог: check не создаёт ни каталог, ни базу.
      const emptyDir = path.join(dataDir, 'not-created');
      const empty = await captureConsole(() =>
        main({ argv: ['node', 'etn', 'init', '--check'], env: { ETN_DATA_DIR: emptyDir } }),
      );
      assert.equal(empty.result, 1);
      assert.equal(existsSync(emptyDir), false, 'check must not create the data directory');

      // Прерванная попытка: _system.db есть, но таблицы users нет.
      const orphanDbDir = path.join(dataDir, 'orphan');
      mkdirSync(orphanDbDir, { recursive: true });
      writeFileSync(path.join(orphanDbDir, '_system.db'), '');
      const orphan = await captureConsole(() =>
        main({ argv: ['node', 'etn', 'init', '--check'], env: { ETN_DATA_DIR: orphanDbDir } }),
      );
      assert.equal(orphan.result, 1, 'база от прерванной попытки — не инициализировано');

      // init доинициализирует такую базу, после чего check даёт 0.
      const initOrphan = await captureConsole(() =>
        main({
          argv: ['node', 'etn', 'init', '--username', 'root'],
          env: { ETN_DATA_DIR: orphanDbDir },
        }),
      );
      assert.equal(initOrphan.result, 0);
      const after = await captureConsole(() =>
        main({ argv: ['node', 'etn', 'init', '--check'], env: { ETN_DATA_DIR: orphanDbDir } }),
      );
      assert.equal(after.result, 0);
      assert.match(after.stdout.join('\n'), /first administrator exists/);
    });

    it('--check на базе версии до 0.15.1 (нет update_jobs) даёт 0, а не 2', async () => {
      // Блокер приёмки 0a27a63b: checkFirstUser открывает БД предыдущей версии
      // строго на чтение и БЕЗ миграций. Готовить в конструкторе SystemDb
      // statements для всех таблиц текущей схемы нельзя — на базе 0.15.0
      // (миграции 001–015) падает `no such table: update_jobs`, и проверка
      // возвращает exit 2 вместо контрактного 0 (установщик etn.iss:1858,4429).
      const root = mkdtempSync(path.join(os.tmpdir(), 'etn-cli-check-old-'));
      tmpRoots.push(root);
      const dataDir = path.join(root, 'data');
      mkdirSync(dataDir, { recursive: true });

      // Схема 0.15.0: все системные миграции до 016_update_jobs.sql.
      const oldMigrationsDir = path.join(root, 'migrations-015');
      mkdirSync(oldMigrationsDir, { recursive: true });
      const oldMigrations = readdirSync(systemMigrationsDir())
        .filter((f) => f.endsWith('.sql') && f < '016')
        .sort();
      assert.ok(oldMigrations.length > 0, 'нет системных миграций до 016');
      for (const file of oldMigrations) {
        copyFileSync(path.join(systemMigrationsDir(), file), path.join(oldMigrationsDir, file));
      }

      const raw = new DatabaseConstructor(path.join(dataDir, '_system.db'));
      try {
        raw.pragma('journal_mode = WAL');
        raw.pragma('foreign_keys = ON');
        runMigrations(raw, oldMigrationsDir);
        // Первый администратор уже создан (`etn init` версии 0.15.0).
        raw.prepare(
          `INSERT INTO users (id, username, display_name, is_admin, is_first_user, created_at, updated_at)
           VALUES (?, 'admin', 'Admin', 1, 1, ?, ?)`,
        ).run(randomUUID(), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        const tables = (
          raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
            name: string;
          }[]
        ).map((r) => r.name);
        assert.ok(!tables.includes('update_jobs'), 'предусловие: схемы 0.15.0 без update_jobs');
      } finally {
        raw.close();
      }

      const check = await captureConsole(() =>
        main({ argv: ['node', 'etn', 'init', '--check'], env: { ETN_DATA_DIR: dataDir } }),
      );
      assert.equal(check.result, 0, `check: ${check.stderr.join('\n') || check.stdout.join('\n')}`);
      assert.match(check.stdout.join('\n'), /first administrator exists/);
      assert.doesNotMatch(check.stderr.join('\n'), /no such table/);
    });

    it('--key-out writes the key to a file once and never prints it', async () => {
      const dataDir = mkdtempSync(path.join(os.tmpdir(), 'etn-cli-keyout-'));
      tmpRoots.push(dataDir);
      const env = { ETN_DATA_DIR: dataDir };
      const keyPath = path.join(dataDir, '.install', 'primary-key.txt');

      const first = await captureConsole(() =>
        main({ argv: ['node', 'etn', 'init', '--username', 'admin', '--key-out', keyPath], env }),
      );
      assert.equal(first.result, 0);
      assert.ok(existsSync(keyPath), 'ключ записан в файл');
      const key = readFileSync(keyPath, 'utf8').trim();
      assert.match(key, /^etn_[0-9a-f]{32}$/);
      assert.doesNotMatch(first.stdout.join('\n'), /etn_[0-9a-f]{32}/, 'ключ не печатается');
      assert.ok(first.stdout.join('\n').includes(keyPath));

      // Повторный init ключ не перезаписывает и файл не портит.
      const second = await captureConsole(() =>
        main({ argv: ['node', 'etn', 'init', '--username', 'other', '--key-out', keyPath], env }),
      );
      assert.equal(second.result, 1);
      assert.equal(readFileSync(keyPath, 'utf8').trim(), key);
    });

    it('--key-out removes the key file when the database transaction fails', async () => {
      const dataDir = mkdtempSync(path.join(os.tmpdir(), 'etn-cli-keyfail-'));
      tmpRoots.push(dataDir);

      // Не первый пользователь с занятым логином: вставка первого
      // администратора в транзакции упадёт на UNIQUE(users.username).
      const sys = SystemDb.open(dataDir);
      try {
        sys.createUser({
          id: randomUUID(),
          username: 'clash',
          displayName: null,
          isAdmin: false,
          isFirstUser: false,
        });
      } finally {
        sys.close();
      }

      const keyPath = path.join(dataDir, '.install', 'primary-key.txt');
      await assert.rejects(
        captureConsole(() =>
          main({
            argv: ['node', 'etn', 'init', '--username', 'clash', '--key-out', keyPath],
            env: { ETN_DATA_DIR: dataDir },
          }),
        ),
        /UNIQUE|users\.username/,
      );
      assert.equal(existsSync(keyPath), false, 'ключ удалён после сбоя транзакции');

      // Первый администратор не создан: повторная инициализация по-прежнему нужна.
      const check = await captureConsole(() =>
        main({ argv: ['node', 'etn', 'init', '--check'], env: { ETN_DATA_DIR: dataDir } }),
      );
      assert.equal(check.result, 1);
    });

    it('--check leaves the database contents untouched (sidecars are normal SQLite files)', async () => {
      const dataDir = mkdtempSync(path.join(os.tmpdir(), 'etn-cli-sidecar-'));
      tmpRoots.push(dataDir);
      const env = { ETN_DATA_DIR: dataDir };
      const dbPath = path.join(dataDir, '_system.db');

      const init = await captureConsole(() =>
        main({ argv: ['node', 'etn', 'init', '--username', 'admin'], env }),
      );
      assert.equal(init.result, 0);
      const before = readFileSync(dbPath);

      // Открытие WAL-базы только на чтение может создать рядом служебные
      // файлы `_system.db-shm`/`_system.db-wal` — это нормальное поведение
      // SQLite, а не изменение базы (см. контракт `etn init --check`).
      const first = await captureConsole(() =>
        main({ argv: ['node', 'etn', 'init', '--check'], env }),
      );
      const second = await captureConsole(() =>
        main({ argv: ['node', 'etn', 'init', '--check'], env }),
      );
      assert.equal(first.result, 0);
      assert.equal(second.result, 0);
      assert.deepEqual(readFileSync(dbPath), before, 'содержимое _system.db не изменилось');
    });
  },
);
