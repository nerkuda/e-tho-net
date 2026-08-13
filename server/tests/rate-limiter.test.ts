/**
 * Unit tests for the authentication brute-force limiter (task B8,
 * docs/06-auth.md §9). Pure in-memory logic — no native binding required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AUTH_DEFAULTS } from '@etn/shared';

import { AuthRateLimiter, bucketKey, NO_PREFIX } from '../src/auth/rate-limiter.js';

describe('bucketKey', () => {
  it('joins ip and prefix', () => {
    assert.equal(bucketKey('1.2.3.4', 'a1b2c3d4'), '1.2.3.4:a1b2c3d4');
  });
  it('uses the sentinel for a missing prefix', () => {
    assert.equal(bucketKey('1.2.3.4', null), `1.2.3.4:${NO_PREFIX}`);
    assert.equal(bucketKey('1.2.3.4', ''), `1.2.3.4:${NO_PREFIX}`);
  });
  it('falls back to a default ip when empty', () => {
    assert.equal(bucketKey('', 'a1b2c3d4'), '0.0.0.0:a1b2c3d4');
  });
});

describe('AuthRateLimiter', () => {
  it('does not ban within the threshold', () => {
    const lim = new AuthRateLimiter();
    const key = bucketKey('10.0.0.1', 'aaaaaaaa');
    for (let i = 0; i < AUTH_DEFAULTS.BAD_ATTEMPTS_PER_MINUTE; i++) {
      const r = lim.recordFailure(key);
      assert.equal(r.banned, false, `failure ${i} should not ban`);
    }
    assert.equal(lim.isBanned(key), false);
  });

  it('bans once the threshold is exceeded and reports retry-after', () => {
    const lim = new AuthRateLimiter();
    const key = bucketKey('10.0.0.2', 'bbbbbbbb');
    for (let i = 0; i < AUTH_DEFAULTS.BAD_ATTEMPTS_PER_MINUTE; i++) {
      lim.recordFailure(key);
    }
    const r = lim.recordFailure(key); // over the threshold
    assert.equal(r.banned, true);
    assert.equal(r.retryAfterSeconds, AUTH_DEFAULTS.BAN_MINUTES * 60);
    assert.equal(lim.isBanned(key), true);
    assert.ok(lim.retryAfterSeconds(key) > 0);
  });

  it('expires the ban after the ban window', () => {
    const lim = new AuthRateLimiter();
    const key = bucketKey('10.0.0.3', 'cccccccc');
    const t0 = 1_000_000;
    for (let i = 0; i <= AUTH_DEFAULTS.BAD_ATTEMPTS_PER_MINUTE; i++) {
      lim.recordFailure(key, t0);
    }
    assert.equal(lim.isBanned(key, t0), true);
    // One ms past the ban: no longer banned.
    const after = t0 + AUTH_DEFAULTS.BAN_MINUTES * 60_000 + 1;
    assert.equal(lim.isBanned(key, after), false);
    assert.equal(lim.retryAfterSeconds(key, after), 0);
  });

  it('clear() resets the bucket after a successful auth', () => {
    const lim = new AuthRateLimiter();
    const key = bucketKey('10.0.0.4', 'dddddddd');
    lim.recordFailure(key);
    lim.recordFailure(key);
    lim.clear(key);
    // After clear, the counter starts fresh and the next failure does not carry history.
    assert.equal(lim.recordFailure(key).banned, false);
  });

  it('starts a fresh window after 60 seconds', () => {
    const lim = new AuthRateLimiter();
    const key = bucketKey('10.0.0.5', 'eeeeeeee');
    lim.recordFailure(key, 0);
    lim.recordFailure(key, 0);
    // 61 seconds later — new window, count restarts at 1.
    const r = lim.recordFailure(key, 61_000);
    assert.equal(r.banned, false);
  });

  it('cleanup evicts expired entries', () => {
    const lim = new AuthRateLimiter();
    const key = bucketKey('10.0.0.6', 'ffffffff');
    for (let i = 0; i <= AUTH_DEFAULTS.BAD_ATTEMPTS_PER_MINUTE; i++) {
      lim.recordFailure(key, 0);
    }
    assert.equal(lim.isBanned(key, 0), true);
    lim.cleanup(AUTH_DEFAULTS.BAN_MINUTES * 60_000 + 1);
    assert.equal(lim.isBanned(key, AUTH_DEFAULTS.BAN_MINUTES * 60_000 + 1), false);
  });
});
