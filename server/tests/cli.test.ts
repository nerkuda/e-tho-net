/**
 * Unit + integration tests for the ETN CLI (task B6).
 *
 * Pure argument-parsing tests always run. The end-to-end `etn init` test
 * requires the `better-sqlite3` native binding and is skipped otherwise.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { main, parseInitArgs } from '../src/cli.js';

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
    });
  });

  it('parses the --flag=value form', () => {
    assert.deepEqual(parseInitArgs(['--username=admin', '--display-name=Root User']), {
      username: 'admin',
      displayName: 'Root User',
    });
  });

  it('parses short -u / -d', () => {
    assert.deepEqual(parseInitArgs(['-u', 'bob', '-d', 'Bob']), {
      username: 'bob',
      displayName: 'Bob',
    });
  });

  it('returns null displayName when omitted', () => {
    assert.deepEqual(parseInitArgs(['--username', 'solo']), {
      username: 'solo',
      displayName: null,
    });
  });

  it('trims whitespace and nulls-out blank display name', () => {
    assert.deepEqual(parseInitArgs(['--username', '  x  ', '--display-name', '   ']), {
      username: 'x',
      displayName: null,
    });
  });

  it('throws when --username is missing', () => {
    assert.throws(() => parseInitArgs([]), /--username/);
  });

  it('throws on unknown argument', () => {
    assert.throws(() => parseInitArgs(['--username', 'a', '--bogus']), /Неизвестный аргумент/);
  });
});

describe('main (no native required)', () => {
  it('prints help and returns 1 when no command is given', async () => {
    const { result, stdout } = await captureConsole(() => main({ argv: ['node', 'etn'] }));
    assert.equal(result, 1);
    assert.ok(stdout.join('\n').includes('Использование'));
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
    assert.ok(stderr.join('\n').includes('Неизвестная команда'));
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
      assert.ok(out1.includes('один раз'));

      // Re-running must be refused (already initialised).
      const second = await captureConsole(() =>
        main({ argv: ['node', 'etn', 'init', '--username', 'other'], env }),
      );
      assert.equal(second.result, 1);
      assert.ok(second.stderr.join('\n').includes('уже инициализирован'));

      // The printed key must not appear in the re-init output.
      assert.doesNotMatch(second.stdout.join('\n'), /etn_[0-9a-f]{32}/);
    });
  },
);
