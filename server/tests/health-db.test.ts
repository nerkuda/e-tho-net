/**
 * Проверка БД в `GET /api/v1/health` (задача 0178253c, требование 0a79d9de,
 * операция `ae4ae06f`): лёгкое чтение через reader pool, кеш 1–2 с, 503 при
 * сбое; health не блокируется обслуживанием.
 *
 * Здесь проверяется РЕАЛЬНЫЙ путь: файловая системная БД (`_system.db`) и
 * процессный reader-пул. Остальные REST-тесты идут через `buildRestContext`,
 * который подменяет проверку: их системная БД — `:memory:`, вторым
 * соединением воркера она не открывается.
 *
 * Кеш проверяется с подменой часов: два вызова в пределах TTL дают одно
 * чтение (счётчик), после истечения — новое.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { HealthResponse } from '@etn/shared';

import { SystemDb } from '../src/db/system-db.js';
import { closeReaderPool, configureReaderPool } from '../src/db/reader-pool.js';
import {
  DB_HEALTH_CACHE_MAX_MS,
  DB_HEALTH_CACHE_TTL_MS,
  createDbHealthCheck,
  probeDbThroughReaderPool,
} from '../src/db/db-health.js';
import { createServer } from '../src/http/server.js';
import { createLogger } from '../src/logger.js';
import { nativeAvailable, testServerConfig } from './rest-helpers.js';

describe('health: кеш проверки БД (спека — 1–2 с)', () => {
  it('TTL не выходит за верхнюю границу спеки', () => {
    assert.ok(
      DB_HEALTH_CACHE_TTL_MS >= 1_000 && DB_HEALTH_CACHE_TTL_MS <= DB_HEALTH_CACHE_MAX_MS,
      `TTL ${DB_HEALTH_CACHE_TTL_MS} мс вне диапазона 1–2 с`,
    );
  });

  it('два вызова в пределах TTL дают одно чтение, после истечения — новое', async () => {
    let clock = 10_000;
    let reads = 0;
    const check = createDbHealthCheck({
      dbPath: 'unused',
      now: () => clock,
      probe: async () => {
        reads += 1;
      },
    });

    assert.equal(await check(), 'ok');
    assert.equal(reads, 1, 'первый вызов читает БД');

    clock += 1_000; // всё ещё внутри 1.5-секундного окна
    assert.equal(await check(), 'ok');
    assert.equal(reads, 1, 'в пределах TTL повторного чтения нет');

    clock += DB_HEALTH_CACHE_TTL_MS; // окно истекло
    assert.equal(await check(), 'ok');
    assert.equal(reads, 2, 'после истечения TTL — новое чтение');
  });

  it('ошибка чтения тоже кешируется: упавшую БД не долбят каждый опрос', async () => {
    let clock = 0;
    let reads = 0;
    const check = createDbHealthCheck({
      dbPath: 'unused',
      now: () => clock,
      probe: async () => {
        reads += 1;
        throw new Error('database is locked');
      },
    });

    assert.equal(await check(), 'error');
    clock += 500;
    assert.equal(await check(), 'error');
    assert.equal(reads, 1, 'ошибка в пределах TTL не перечитывается');

    clock += DB_HEALTH_CACHE_TTL_MS;
    assert.equal(await check(), 'error');
    assert.equal(reads, 2, 'после TTL проба повторяется');
  });

  it('одновременные вызовы на холодном кеше сливаются в одно чтение', async () => {
    let reads = 0;
    const releases: Array<() => void> = [];
    const check = createDbHealthCheck({
      dbPath: 'unused',
      probe: () =>
        new Promise<void>((resolve) => {
          reads += 1;
          releases.push(resolve);
        }),
    });

    const first = check();
    const second = check();
    assert.equal(reads, 1, 'пока чтение в полёте, второе не запускается');
    releases[0]?.();
    assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok']);
  });
});

describe(
  'health: реальный reader pool и файловая системная БД',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('200 db:"ok"; после закрытия пула — 503 db:"error"', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-health-'));
      const logger = createLogger('silent');
      const sys = SystemDb.open(dataDir, logger);
      const app = await createServer({
        config: testServerConfig(dataDir),
        systemDb: sys,
        logger,
      });
      try {
        configureReaderPool({ size: 1, taskTimeoutMs: 30_000 });

        const ok = await app.inject({ method: 'GET', url: '/api/v1/health' });
        assert.equal(ok.statusCode, 200, ok.body);
        const okBody = ok.json() as HealthResponse;
        assert.equal(okBody.status, 'ok');
        assert.equal(okBody.db, 'ok');

        // Пул закрыт — чтение БД невозможно. Ждём истечения кеша первого
        // ответа (он живёт не дольше 2 с).
        await closeReaderPool();
        await new Promise((resolve) => setTimeout(resolve, DB_HEALTH_CACHE_TTL_MS + 150));

        const failed = await app.inject({ method: 'GET', url: '/api/v1/health' });
        assert.equal(failed.statusCode, 503, failed.body);
        const failedBody = failed.json() as HealthResponse;
        assert.equal(failedBody.status, 'error');
        assert.equal(failedBody.db, 'error');
        assert.equal(failedBody.version, okBody.version);
        assert.equal(typeof failedBody.uptime, 'number');
      } finally {
        await app.close();
        await closeReaderPool();
        sys.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it('битый/отсутствующий файл БД через живой пул — db:"error"', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-health-bad-'));
      try {
        configureReaderPool({ size: 1, taskTimeoutMs: 30_000 });
        const check = createDbHealthCheck({ dbPath: path.join(dataDir, 'missing.db') });
        assert.equal(await check(), 'error');
      } finally {
        await closeReaderPool();
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it('probeDbThroughReaderPool без пула — отказ (health отдал бы 503)', async () => {
      await closeReaderPool();
      await assert.rejects(
        () => probeDbThroughReaderPool('unused'),
        (err: unknown) => err instanceof Error && /reader pool/.test(err.message),
      );
    });
  },
);
