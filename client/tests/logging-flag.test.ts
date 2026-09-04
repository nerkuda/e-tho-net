/**
 * Tests for the `--logging` / `--no-logging` CLI switch parser
 * (`parseLoggingArg` in client/src/main/db/paths.ts, task f051bf95,
 * docs/07-client-electron.md §7).
 *
 * Only exact tokens match: Electron and Chromium inject their own arguments
 * (`--enable-logging` etc.), so a prefix match would misfire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLoggingArg } from '../src/main/db/paths.js';

test('parseLoggingArg: нет переключателей → null', () => {
  assert.equal(parseLoggingArg([]), null);
  assert.equal(parseLoggingArg(['ETN.exe', '--user-data-dir=C:\\p']), null);
});

test('parseLoggingArg: --logging → true, --no-logging → false', () => {
  assert.equal(parseLoggingArg(['ETN.exe', '--logging']), true);
  assert.equal(parseLoggingArg(['ETN.exe', '--no-logging']), false);
});

test('parseLoggingArg: только точные токены (аргументы Electron/Chromium)', () => {
  // Chromium's own switch — must NOT enable our journal.
  assert.equal(parseLoggingArg(['ETN.exe', '--enable-logging']), null);
  // Similar-looking junk / values must not match either.
  assert.equal(parseLoggingArg(['ETN.exe', '--logging=true']), null);
  assert.equal(parseLoggingArg(['ETN.exe', '--no-logging-x']), null);
  assert.equal(parseLoggingArg(['ETN.exe', '-logging']), null);
  assert.equal(parseLoggingArg(['ETN.exe', 'no-logging']), null);
});

test('parseLoggingArg: переключатель не первым среди аргументов', () => {
  assert.equal(parseLoggingArg(['ETN.exe', '--no-sandbox', '--logging', 'other']), true);
});

test('parseLoggingArg: оба переключателя — побеждает последний', () => {
  assert.equal(parseLoggingArg(['ETN.exe', '--logging', '--no-logging']), false);
  assert.equal(parseLoggingArg(['ETN.exe', '--no-logging', '--logging']), true);
});
