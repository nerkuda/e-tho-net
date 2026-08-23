/**
 * Tests for the main-process deep-link dispatcher (task R11).
 *
 * `extractDeepLink` is a thin wrapper around the shared parser — these tests
 * double-check that argv handling is correct (the real parser tests live in
 * shared/tests/deep-link.test.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractDeepLink } from '../src/main/ipc/deep-link.js';

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const ID_B = '11111111-2222-3333-4444-555555555555';

test('extractDeepLink возвращает null на пустой argv', () => {
  assert.equal(extractDeepLink([]), null);
});

test('extractDeepLink находит etn://open в типичном Win-argv (после exe-флага)', () => {
  const argv = ['C:\\path\\to\\electron.exe', '--enable-logging', `etn://open?net=${ID_A}&thought=${ID_B}`];
  assert.deepEqual(extractDeepLink(argv), { networkId: ID_A, thoughtId: ID_B });
});

test('extractDeepLink находит первый валидный URL, игнорируя прочие etn://…', () => {
  const argv = [
    `etn://open?net=${ID_A}&thought=${ID_B}`,
    'etn://open?net=invalid&thought=also-invalid',
  ];
  assert.deepEqual(extractDeepLink(argv), { networkId: ID_A, thoughtId: ID_B });
});

test('extractDeepLink возвращает null когда нет валидного URL', () => {
  const argv = ['C:\\path\\to\\electron.exe', '--enable-logging'];
  assert.equal(extractDeepLink(argv), null);
});

test('extractDeepLink возвращает null когда URL есть, но UUID невалидные', () => {
  const argv = ['etn://open?net=not-a-uuid&thought=also-not-a-uuid'];
  assert.equal(extractDeepLink(argv), null);
});

test('extractDeepLink возвращает null для URL другой схемы', () => {
  assert.equal(extractDeepLink(['obsidian://open?vault=x&file=y']), null);
});
