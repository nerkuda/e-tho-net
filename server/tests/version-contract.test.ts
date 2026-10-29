/**
 * Контракт `GET /api/v1/version` (задача 89a6ea40, 0.15.1).
 *
 * Нормативный источник — сущность «Ответ GET /version» (be07ca0f) и
 * требование e3ef572c: `version`, `api`, `min_client`, `client_compatibility`,
 * `recommended_client_version`, `client_download_url` (страница релиза, не
 * файл), `client_sha256` (хеш Linux-архива). Диапазон — minor-окно версии
 * сервера (`compatibilityRangeFor`), а не константа; каждый `ETN_CLIENT_*`
 * override проверяется, некорректная конфигурация — отказ старта
 * (`ConfigError` из `loadConfig`).
 *
 * Кейсы диапазона закреплены значением сервера 0.15.1 — тем же, что в
 * требовании 1f593647: 0.15.0 и 0.15.1-rc.1 внутри, 0.14.9, 0.16.0 и
 * 0.16.0-rc.1 (prerelease следующего minor) — вне.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compatibilityRangeFor, satisfiesRange, type VersionResponse } from '@etn/shared';

import { ConfigError, loadConfig } from '../src/config.js';
import {
  CLIENT_RELEASE_PAGE_BASE,
  SERVER_VERSION,
  VersionConfigError,
  buildVersionPayload,
  resolveClientChannel,
} from '../src/version.js';
import { buildRestContext, closeRestContext, nativeAvailable } from './rest-helpers.js';

/** 64 hex — валидный SHA-256 (буквы в верхнем регистре нормализуются). */
const SHA256_UPPER = 'A'.repeat(64);
const SHA256_LOWER = 'a'.repeat(64);

/** Верхний уровень ответа `/version` — ровно семь полей контракта. */
const VERSION_FIELDS = [
  'api',
  'client_compatibility',
  'client_download_url',
  'client_sha256',
  'min_client',
  'recommended_client_version',
  'version',
] as const;

describe('resolveClientChannel — значения по умолчанию (0.15.1)', () => {
  it('диапазон, min_client, рекомендация и страница релиза выводятся из версии сервера', () => {
    const channel = resolveClientChannel({}, '0.15.1');
    assert.deepEqual(channel, {
      client_compatibility: '>=0.15.0 <0.16.0',
      min_client: '0.15.0',
      recommended_client_version: '0.15.1',
      client_download_url: 'https://github.com/nerkuda/e-tho-net/releases/tag/v0.15.1',
      client_sha256: null,
    });
  });

  it('диапазон совпадает с compatibilityRangeFor и не является константой', () => {
    assert.equal(
      resolveClientChannel({}, '0.15.1').client_compatibility,
      compatibilityRangeFor('0.15.1'),
    );
    assert.equal(
      resolveClientChannel({}, '0.14.1').client_compatibility,
      '>=0.14.0 <0.15.0',
      'другая версия сервера — другое окно',
    );
    assert.equal(resolveClientChannel({}, '0.14.1').min_client, '0.14.0');
  });

  it('кейсы диапазона 0.15.x: границы и prerelease соседних minor', () => {
    const range = resolveClientChannel({}, '0.15.1').client_compatibility;
    assert.equal(range, '>=0.15.0 <0.16.0');
    assert.equal(satisfiesRange('0.15.0', range), true, 'нижняя граница внутри');
    assert.equal(satisfiesRange('0.15.1-rc.1', range), true, 'prerelease той же ветки внутри');
    assert.equal(satisfiesRange('0.16.0-rc.1', range), false, 'prerelease следующего minor вне');
    assert.equal(satisfiesRange('0.14.9', range), false, 'прошлый minor вне');
    assert.equal(satisfiesRange('0.16.0', range), false, 'следующий minor вне');
  });

  it('невалидная версия сервера — отказ, а не подстановка >=0.1.0', () => {
    assert.throws(
      () => resolveClientChannel({}, 'garbage'),
      (err: unknown) => err instanceof VersionConfigError && /not a valid semver/.test(err.message),
    );
  });

  it('пустые значения переменных равны их отсутствию', () => {
    const channel = resolveClientChannel(
      {
        ETN_CLIENT_COMPATIBILITY: '  ',
        ETN_RECOMMENDED_CLIENT_VERSION: '',
        ETN_CLIENT_DOWNLOAD_URL: ' ',
        ETN_CLIENT_SHA256: '',
      },
      '0.15.1',
    );
    assert.deepEqual(channel, resolveClientChannel({}, '0.15.1'));
  });

  it('buildVersionPayload отдаёт все семь полей контракта', () => {
    const payload = buildVersionPayload(resolveClientChannel({}, '0.15.1'));
    assert.deepEqual(Object.keys(payload).sort(), [...VERSION_FIELDS]);
    // Версия и `api` — фактические; канал — переданный (сервер 0.15.1).
    assert.equal(payload.version, SERVER_VERSION);
    assert.equal(payload.api, 'v1');
    assert.equal(payload.min_client, '0.15.0');
    assert.equal(payload.client_compatibility, '>=0.15.0 <0.16.0');
    assert.equal(payload.recommended_client_version, '0.15.1');
    assert.equal(
      payload.client_download_url,
      'https://github.com/nerkuda/e-tho-net/releases/tag/v0.15.1',
    );
    assert.equal(payload.client_sha256, null);
  });
});

describe('resolveClientChannel — каждый ETN_CLIENT_* override', () => {
  it('ETN_CLIENT_COMPATIBILITY заменяет диапазон; min_client — его нижняя граница', () => {
    const channel = resolveClientChannel(
      { ETN_CLIENT_COMPATIBILITY: '>=0.14.0 <0.16.0' },
      '0.15.1',
    );
    assert.equal(channel.client_compatibility, '>=0.14.0 <0.16.0');
    assert.equal(channel.min_client, '0.14.0');
  });

  it('ETN_RECOMMENDED_CLIENT_VERSION заменяет рекомендацию', () => {
    const channel = resolveClientChannel({ ETN_RECOMMENDED_CLIENT_VERSION: '0.15.0' }, '0.15.1');
    assert.equal(channel.recommended_client_version, '0.15.0');
  });

  it('ETN_CLIENT_DOWNLOAD_URL заменяет страницу релиза', () => {
    const channel = resolveClientChannel(
      { ETN_CLIENT_DOWNLOAD_URL: 'https://mirror.example/etn/releases/v0.15.1' },
      '0.15.1',
    );
    assert.equal(channel.client_download_url, 'https://mirror.example/etn/releases/v0.15.1');
  });

  it('ETN_CLIENT_SHA256 задаёт хеш Linux-архива и нормализуется в нижний регистр', () => {
    const channel = resolveClientChannel({ ETN_CLIENT_SHA256: SHA256_UPPER }, '0.15.1');
    assert.equal(channel.client_sha256, SHA256_LOWER);
  });

  it('prerelease нового minor стартует только с override нижней границы на X.Y.0-0', () => {
    // Без override каноническое окно `>=0.16.0 <0.17.0` не вмещает 0.16.0-rc.1,
    // а рекомендация обязана быть внутри — сервер со своей же RC не стартует.
    assert.throws(
      () => resolveClientChannel({}, '0.16.0-rc.1'),
      (err: unknown) =>
        err instanceof VersionConfigError && /outside client_compatibility/.test(err.message),
    );
    // Документированный выход (требование 1f593647): аварийный override.
    const channel = resolveClientChannel(
      { ETN_CLIENT_COMPATIBILITY: '>=0.16.0-0 <0.17.0' },
      '0.16.0-rc.1',
    );
    assert.equal(channel.client_compatibility, '>=0.16.0-0 <0.17.0');
    assert.equal(channel.min_client, '0.16.0-0');
    assert.equal(channel.recommended_client_version, '0.16.0-rc.1');
  });
});

describe('resolveClientChannel — некорректная конфигурация отклоняется', () => {
  const badRanges = [
    '>=0.1.0',
    'garbage',
    '>=0.15.0 <=0.16.0',
    '>= 0.15.0 < 0.16.0',
    '0.15.0',
    // Верхняя граница сравнивается по паре (major, minor): окно пустое.
    '>=0.15.0 <0.15.4',
  ];
  for (const range of badRanges) {
    it(`ETN_CLIENT_COMPATIBILITY ${JSON.stringify(range)} — отказ`, () => {
      assert.throws(
        () => resolveClientChannel({ ETN_CLIENT_COMPATIBILITY: range }, '0.15.1'),
        (err: unknown) =>
          err instanceof VersionConfigError && /ETN_CLIENT_COMPATIBILITY/.test(err.message),
      );
    });
  }

  it('рекомендованная версия вне диапазона — отказ', () => {
    assert.throws(
      () => resolveClientChannel({ ETN_RECOMMENDED_CLIENT_VERSION: '0.16.0' }, '0.15.1'),
      (err: unknown) =>
        err instanceof VersionConfigError &&
        /ETN_RECOMMENDED_CLIENT_VERSION/.test(err.message) &&
        /outside client_compatibility/.test(err.message),
    );
  });

  it('рекомендованная версия не semver — отказ', () => {
    assert.throws(
      () => resolveClientChannel({ ETN_RECOMMENDED_CLIENT_VERSION: 'banana' }, '0.15.1'),
      (err: unknown) =>
        err instanceof VersionConfigError && /ETN_RECOMMENDED_CLIENT_VERSION/.test(err.message),
    );
  });

  const badUrls = [
    'http://example.com/etn',
    '/releases/v0.15.1',
    'not a url',
    'ftp://example.com/',
  ];
  for (const url of badUrls) {
    it(`ETN_CLIENT_DOWNLOAD_URL ${JSON.stringify(url)} — отказ`, () => {
      assert.throws(
        () => resolveClientChannel({ ETN_CLIENT_DOWNLOAD_URL: url }, '0.15.1'),
        (err: unknown) =>
          err instanceof VersionConfigError && /ETN_CLIENT_DOWNLOAD_URL/.test(err.message),
      );
    });
  }

  const badHashes = ['abc', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64)];
  for (const hash of badHashes) {
    it(`ETN_CLIENT_SHA256 ${JSON.stringify(hash)} — отказ`, () => {
      assert.throws(
        () => resolveClientChannel({ ETN_CLIENT_SHA256: hash }, '0.15.1'),
        (err: unknown) =>
          err instanceof VersionConfigError && /ETN_CLIENT_SHA256/.test(err.message),
      );
    });
  }
});

describe('loadConfig — отказ старта на некорректных ETN_CLIENT_*', () => {
  const base = { ETN_DATA_DIR: '/tmp/etn-data' };

  it('по умолчанию канал выводится из версии сервера', () => {
    const cfg = loadConfig({ ...base });
    assert.deepEqual(cfg.clientChannel, resolveClientChannel({}, SERVER_VERSION));
    assert.equal(cfg.clientChannel.recommended_client_version, SERVER_VERSION);
    assert.equal(
      cfg.clientChannel.client_download_url,
      `${CLIENT_RELEASE_PAGE_BASE}${SERVER_VERSION}`,
    );
  });

  it('override-переменные доходят до config.clientChannel', () => {
    const cfg = loadConfig({
      ...base,
      ETN_CLIENT_COMPATIBILITY: '>=0.14.0 <0.16.0',
      ETN_RECOMMENDED_CLIENT_VERSION: '0.15.0',
      ETN_CLIENT_DOWNLOAD_URL: 'https://mirror.example/etn/releases/v0.15.0',
      ETN_CLIENT_SHA256: SHA256_UPPER,
    });
    assert.deepEqual(cfg.clientChannel, {
      client_compatibility: '>=0.14.0 <0.16.0',
      min_client: '0.14.0',
      recommended_client_version: '0.15.0',
      client_download_url: 'https://mirror.example/etn/releases/v0.15.0',
      client_sha256: SHA256_LOWER,
    });
  });

  const failures: Array<{ env: NodeJS.ProcessEnv; variable: string }> = [
    { env: { ETN_CLIENT_COMPATIBILITY: '>=0.1.0' }, variable: 'ETN_CLIENT_COMPATIBILITY' },
    { env: { ETN_CLIENT_COMPATIBILITY: '>=0.15.0 <0.15.4' }, variable: 'ETN_CLIENT_COMPATIBILITY' },
    {
      env: { ETN_RECOMMENDED_CLIENT_VERSION: '0.16.0' },
      variable: 'ETN_RECOMMENDED_CLIENT_VERSION',
    },
    { env: { ETN_CLIENT_DOWNLOAD_URL: 'http://example.com' }, variable: 'ETN_CLIENT_DOWNLOAD_URL' },
    { env: { ETN_CLIENT_SHA256: 'abc' }, variable: 'ETN_CLIENT_SHA256' },
  ];
  for (const { env, variable } of failures) {
    it(`${variable} некорректен — ConfigError и сервер не стартует`, () => {
      assert.throws(
        () => loadConfig({ ...base, ...env }),
        (err: unknown) => err instanceof ConfigError && err.message.includes(variable),
      );
    });
  }
});

describe(
  'GET /api/v1/version — тело ответа и неизменный /health',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('публичный ответ 200 со всеми полями контракта', async () => {
      const ctx = await buildRestContext();
      try {
        const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/version' });
        assert.equal(res.statusCode, 200);
        const body = res.json() as VersionResponse;
        assert.deepEqual(Object.keys(body).sort(), [...VERSION_FIELDS]);

        const channel = resolveClientChannel({}, SERVER_VERSION);
        assert.equal(body.version, SERVER_VERSION);
        assert.equal(body.api, 'v1');
        assert.equal(body.min_client, channel.min_client);
        assert.equal(body.client_compatibility, channel.client_compatibility);
        assert.equal(body.recommended_client_version, channel.recommended_client_version);
        assert.equal(body.client_download_url, channel.client_download_url);
        assert.equal(body.client_sha256, channel.client_sha256);
        // Клиент открывает страницу релиза, а не файл: прямой ссылки на
        // артефакт в контракте нет.
        assert.match(body.client_download_url ?? '', /\/releases\/tag\/v\d/);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('GET /api/v1/health не изменился: status/version/uptime', async () => {
      const ctx = await buildRestContext();
      try {
        const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
        assert.equal(res.statusCode, 200);
        const body = res.json() as { status: string; version: string; uptime: number };
        assert.deepEqual(Object.keys(body).sort(), ['status', 'uptime', 'version']);
        assert.equal(body.status, 'ok');
        assert.equal(body.version, SERVER_VERSION);
        assert.equal(typeof body.uptime, 'number');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
