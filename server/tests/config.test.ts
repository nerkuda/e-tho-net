/**
 * Unit tests for config validation (task B1).
 *
 * Covers the DoD: missing/invalid configuration surfaces a clear
 * {@link ConfigError} at startup.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('accepts a minimal valid environment', () => {
    const cfg = loadConfig({ ETN_DATA_DIR: '/tmp/etn-data' });
    assert.equal(cfg.dataDir, path.resolve('/tmp/etn-data'));
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 3000);
    assert.equal(cfg.logLevel, 'info');
    assert.equal(cfg.tls, null);
  });

  it('applies host/port/log-level overrides', () => {
    const cfg = loadConfig({
      ETN_DATA_DIR: '/tmp/etn-data',
      ETN_HOST: '0.0.0.0',
      ETN_PORT: '8443',
      ETN_LOG_LEVEL: 'DEBUG',
    });
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.port, 8443);
    assert.equal(cfg.logLevel, 'debug');
  });

  it('throws when ETN_DATA_DIR is missing', () => {
    assert.throws(
      () => loadConfig({}),
      (err: unknown) => {
        return err instanceof ConfigError && /ETN_DATA_DIR is required/.test(err.message);
      },
    );
  });

  it('throws when ETN_DATA_DIR is blank', () => {
    assert.throws(
      () => loadConfig({ ETN_DATA_DIR: '   ' }),
      (err: unknown) => err instanceof ConfigError,
    );
  });

  it('throws on non-numeric ETN_PORT', () => {
    assert.throws(
      () => loadConfig({ ETN_DATA_DIR: '/tmp/etn-data', ETN_PORT: 'abc' }),
      (err: unknown) => err instanceof ConfigError && /ETN_PORT/.test(err.message),
    );
  });

  it('throws on out-of-range ETN_PORT', () => {
    assert.throws(
      () => loadConfig({ ETN_DATA_DIR: '/tmp/etn-data', ETN_PORT: '99999' }),
      (err: unknown) => err instanceof ConfigError,
    );
  });

  it('throws when only one of ETN_TLS_CERT/ETN_TLS_KEY is set', () => {
    assert.throws(
      () => loadConfig({ ETN_DATA_DIR: '/tmp/etn-data', ETN_TLS_CERT: '/c.pem' }),
      (err: unknown) => err instanceof ConfigError && /together/.test(err.message),
    );
    assert.throws(
      () => loadConfig({ ETN_DATA_DIR: '/tmp/etn-data', ETN_TLS_KEY: '/k.pem' }),
      (err: unknown) => err instanceof ConfigError,
    );
  });

  it('accepts a TLS pair', () => {
    const cfg = loadConfig({
      ETN_DATA_DIR: '/tmp/etn-data',
      ETN_TLS_CERT: '/c.pem',
      ETN_TLS_KEY: '/k.pem',
    });
    assert.deepEqual(cfg.tls, { cert: '/c.pem', key: '/k.pem' });
  });

  it('throws on invalid ETN_LOG_LEVEL', () => {
    assert.throws(
      () => loadConfig({ ETN_DATA_DIR: '/tmp/etn-data', ETN_LOG_LEVEL: 'verbose' }),
      (err: unknown) => err instanceof ConfigError && /ETN_LOG_LEVEL/.test(err.message),
    );
  });
});
