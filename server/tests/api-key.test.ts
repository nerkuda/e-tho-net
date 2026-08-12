/**
 * Unit tests for API-key generation/hashing (task B5). No native binding needed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { API_KEY_PREFIX, API_KEY_PREFIX_LENGTH, API_KEY_RANDOM_LENGTH } from '@etn/shared';

import {
  API_KEY_TOTAL_LENGTH,
  deriveApiKeyPrefix,
  generateApiKey,
  hashApiKey,
  isValidApiKeyFormat,
  parseApiKey,
} from '../src/auth/api-key.js';

describe('generateApiKey', () => {
  it('produces an etn_<32 hex> key of the expected length', () => {
    const { key } = generateApiKey();
    assert.equal(key.length, API_KEY_TOTAL_LENGTH);
    assert.ok(key.startsWith(API_KEY_PREFIX));
    assert.ok(isValidApiKeyFormat(key));
  });

  it('fills the random part with lowercase hex', () => {
    const { key } = generateApiKey();
    const hex = key.slice(API_KEY_PREFIX.length);
    assert.equal(hex.length, API_KEY_RANDOM_LENGTH);
    assert.match(hex, /^[0-9a-f]{32}$/);
  });

  it('generates distinct keys across calls (entropy)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateApiKey().key);
    }
    assert.equal(seen.size, 1000);
  });
});

describe('hashApiKey', () => {
  it('is stable: same key → same digest', () => {
    const key = API_KEY_PREFIX + 'a'.repeat(32);
    assert.equal(hashApiKey(key), hashApiKey(key));
  });

  it('produces a 64-char lowercase hex digest', () => {
    const key = API_KEY_PREFIX + '0'.repeat(32);
    const h = hashApiKey(key);
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it('differs for different keys', () => {
    const a = API_KEY_PREFIX + 'a'.repeat(32);
    const b = API_KEY_PREFIX + 'b'.repeat(32);
    assert.notEqual(hashApiKey(a), hashApiKey(b));
  });

  it('matches the canonical SHA-256 of a fixed input', () => {
    // sha256("etn_0123456789abcdef0123456789abcdef") — pinned so regressions in
    // the hashing path are caught.
    const key = API_KEY_PREFIX + '0123456789abcdef'.repeat(2);
    assert.equal(
      hashApiKey(key),
      '468f2bbaaab0a989ec9d908065f7a68adddb8fa21e16c84faeb31be132c85114',
    );
  });
});

describe('prefix and format', () => {
  it('deriveApiKeyPrefix returns the first 8 hex chars after the prefix', () => {
    const { key, keyPrefix } = generateApiKey();
    assert.equal(keyPrefix.length, API_KEY_PREFIX_LENGTH);
    assert.equal(deriveApiKeyPrefix(key), keyPrefix);
    assert.equal(
      key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + API_KEY_PREFIX_LENGTH),
      keyPrefix,
    );
  });

  it('isValidApiKeyFormat accepts well-formed keys', () => {
    assert.ok(isValidApiKeyFormat(API_KEY_PREFIX + '0'.repeat(32)));
    assert.ok(isValidApiKeyFormat(API_KEY_PREFIX + 'abcdef'.repeat(5) + 'ab'));
  });

  it('isValidApiKeyFormat rejects malformed input', () => {
    assert.equal(isValidApiKeyFormat(''), false);
    assert.equal(isValidApiKeyFormat('etn_short'), false);
    assert.equal(isValidApiKeyFormat('etn_' + 'g'.repeat(32)), false); // non-hex
    assert.equal(isValidApiKeyFormat('etn_' + 'A'.repeat(32)), false); // uppercase
    assert.equal(isValidApiKeyFormat('etn_' + '0'.repeat(31)), false); // too short
    assert.equal(isValidApiKeyFormat('etn_' + '0'.repeat(33)), false); // too long
    assert.equal(isValidApiKeyFormat('xxx_' + '0'.repeat(32)), false); // wrong prefix
  });

  it('parseApiKey returns the hex part or null', () => {
    const good = API_KEY_PREFIX + '1'.repeat(32);
    assert.deepEqual(parseApiKey(good), { hex: '1'.repeat(32) });
    assert.equal(parseApiKey('nope'), null);
  });
});
