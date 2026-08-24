/**
 * Tests for the `--user-data-dir` CLI switch parser
 * (client/src/main/db/paths.ts, docs/07-client-electron.md §3).
 *
 * Pure helper — no Electron involved, so it runs under the plain `node --test`
 * harness like the other client tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { parseUserDataDirArg } from '../src/main/db/paths.js';

test('parseUserDataDirArg: без флага → null', () => {
  assert.equal(parseUserDataDirArg(['ETN.exe']), null);
  assert.equal(parseUserDataDirArg([]), null);
});

test('parseUserDataDirArg: --user-data-dir=путь → абсолютный путь', () => {
  const arg = 'C:\\etn\\profile1';
  assert.equal(
    parseUserDataDirArg(['ETN.exe', `--user-data-dir=${arg}`]),
    path.resolve(arg),
  );
});

test('parseUserDataDirArg: флаг не первый среди аргументов', () => {
  const arg = 'C:\\etn\\profile2';
  assert.equal(
    parseUserDataDirArg(['ETN.exe', '--some-other-flag', 'data', `--user-data-dir=${arg}`]),
    path.resolve(arg),
  );
});

test('parseUserDataDirArg: флаг без значения → null', () => {
  assert.equal(parseUserDataDirArg(['ETN.exe', '--user-data-dir=']), null);
  assert.equal(parseUserDataDirArg(['--user-data-dir=']), null);
});

test('parseUserDataDirArg: чужой флаг игнорируется', () => {
  assert.equal(parseUserDataDirArg(['ETN.exe', '--no-sandbox', '--user-data-dirx=C:\\x']), null);
  assert.equal(parseUserDataDirArg(['ETN.exe', '-user-data-dir=C:\\x']), null);
});

test('parseUserDataDirArg: относительный путь → абсолютный от process.cwd()', () => {
  assert.equal(
    parseUserDataDirArg(['ETN.exe', '--user-data-dir=profile-test']),
    path.resolve('profile-test'),
  );
});
