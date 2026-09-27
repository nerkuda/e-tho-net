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

import { parseUserDataDirArg, isDefaultUserDataDir } from '../src/main/db/paths.js';

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

test('isDefaultUserDataDir: совпадение с <appData>/<app name> → true (профиль не изолирован)', () => {
  const appData = path.join(path.sep, 'app', 'data');
  const appName = '@etn-dev';
  assert.equal(
    isDefaultUserDataDir(path.join(appData, appName), appData, appName),
    true,
  );
});

test('isDefaultUserDataDir: чужой профиль → false (профиль изолирован)', () => {
  const appData = path.join(path.sep, 'app', 'data');
  assert.equal(
    isDefaultUserDataDir(path.join(path.sep, 'tmp', 'verify', 'profile'), appData, '@etn-dev'),
    false,
  );
});

test('isDefaultUserDataDir: относительный путь резолвится перед сравнением', () => {
  const appData = path.join(path.sep, 'app', 'data');
  const appName = 'ETN';
  const relative = path.relative(process.cwd(), path.join(appData, appName));
  assert.equal(isDefaultUserDataDir(relative, appData, appName), true);
});

test('isDefaultUserDataDir: завершающий разделитель не меняет результат', () => {
  const appData = path.join(path.sep, 'app', 'data');
  const appName = 'ETN';
  assert.equal(
    isDefaultUserDataDir(path.join(appData, appName) + path.sep, appData, appName),
    true,
  );
});

test('isDefaultUserDataDir: на Windows сравнение регистронезависимо', () => {
  const appData = path.join(path.sep, 'App', 'Data');
  const appName = 'ETN';
  assert.equal(
    isDefaultUserDataDir(path.join(appData, appName).toUpperCase(), appData, appName),
    process.platform === 'win32',
  );
});
