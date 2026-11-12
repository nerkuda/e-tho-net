/**
 * Оркестрация фоновой картинки в главном процессе (0.16.1, задача 80324150;
 * операции 31ef478a, сценарии 88a8879d и 0ec86f0b).
 *
 * Контракт сервиса:
 *   * онлайн — свежая картинка с сервера, локальный кэш обновляется;
 *   * `404` на метаданные/байты — картинки нет: кэш чистится, ошибки
 *     пользователю нет (штатное «без картинки»);
 *   * сеть недоступна — последняя известная картинка из кэша (`source:
 *     'cache'`), без кэша — `none`;
 *   * ошибки загрузки/удаления пробрасываются в UI (футер настроек).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { EtnError, type WallpaperInfo } from '@etn/shared';

import {
  loadWallpaper,
  removeWallpaper,
  uploadWallpaper,
  type WallpaperRemote,
  type WallpaperServiceDeps,
} from '../src/main/wallpaper/wallpaper-service.js';
import { readWallpaperCache, writeWallpaperCache } from '../src/main/wallpaper/wallpaper-cache.js';

/** Байты «картинки»: достаточно различимые, чтобы проверять base64-URL. */
const BYTES = Buffer.from([7, 8, 9, 10, 11]);

/** Метаданные сервера, соответствующие {@link BYTES}. */
function info(overrides: Partial<WallpaperInfo> = {}): WallpaperInfo {
  return {
    kind: 'map_wallpaper',
    mime_type: 'image/jpeg',
    file_size: BYTES.length,
    meta: { width: 4, height: 3, avg_luminance: 0.2 },
    url: '/api/v1/users/me/wallpaper/raw',
    ...overrides,
  };
}

/** Подменный сетевой слой: поведение каждого вызова задаётся тестом. */
function remote(overrides: Partial<WallpaperRemote> = {}): WallpaperRemote {
  return {
    getWallpaper: async () => info(),
    getWallpaperRaw: async () => ({
      contentType: 'image/jpeg',
      body: BYTES,
      etag: '"hash-from-etag"',
    }),
    uploadWallpaper: async () => info(),
    deleteWallpaper: async () => undefined,
    ...overrides,
  };
}

/** Свежий `userData` + `deps` c заданным сетевым слоем. */
function setup(net: WallpaperRemote | null): WallpaperServiceDeps & { userData: string } {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'etn-wallpaper-service-'));
  return {
    remote: net,
    cacheDir: path.join(userData, 'wallpaper', 'test'),
    now: () => 1_700_000_000_000,
    userData,
  };
}

/** Достать base64-полезную нагрузку из `data:`-URL. */
function base64Of(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

describe('loadWallpaper: сервер побеждает кэш', () => {
  it('онлайн: свежие байты, хеш из ETag, кэш записан', async () => {
    const deps = setup(remote());
    const view = await loadWallpaper(deps);
    assert.ok(view.status === 'ok');
    assert.equal(view.source, 'server');
    assert.equal(view.mime_type, 'image/jpeg');
    assert.equal(view.file_size, BYTES.length);
    assert.equal(view.content_hash, 'hash-from-etag', 'кавычки ETag сняты');
    assert.equal(base64Of(view.data_url), BYTES.toString('base64'));
    assert.deepEqual(view.meta, { width: 4, height: 3, avg_luminance: 0.2 });
    const cached = readWallpaperCache(deps.cacheDir);
    assert.ok(cached !== null, 'кэш обновлён чтением');
    assert.deepEqual([...cached.bytes], [...BYTES]);
    rmSync(deps.userData, { recursive: true, force: true });
  });

  it('без ETag хеш считается по байтам (тот же sha256, что у сервера)', async () => {
    const deps = setup(
      remote({
        getWallpaperRaw: async () => ({ contentType: 'image/png', body: BYTES, etag: null }),
      }),
    );
    const view = await loadWallpaper(deps);
    assert.ok(view.status === 'ok');
    assert.equal(view.content_hash.length, 64, 'sha256 в hex');
    assert.equal(view.mime_type, 'image/png');
    rmSync(deps.userData, { recursive: true, force: true });
  });
});

describe('loadWallpaper: «картинки нет» — штатное состояние', () => {
  it('404 на метаданные: none без ошибки, кэш очищается', async () => {
    const deps = setup(
      remote({
        getWallpaper: async () => {
          throw new EtnError('NOT_FOUND', 'wallpaper not found');
        },
      }),
    );
    writeWallpaperCache(deps.cacheDir, {
      bytes: BYTES,
      mime_type: 'image/jpeg',
      file_size: BYTES.length,
      content_hash: 'old',
      meta: { width: 1, height: 1, avg_luminance: 0 },
      updated_at: 1,
    });
    const view = await loadWallpaper(deps);
    assert.deepEqual(view, { status: 'none' }, 'картинки нет — цветовой фон и сетка');
    assert.equal(existsSync(deps.cacheDir), false, 'устаревший кэш удалён');
    rmSync(deps.userData, { recursive: true, force: true });
  });

  it('404 на байты (файл удалён на сервере): none и очистка кэша', async () => {
    const deps = setup(
      remote({
        getWallpaperRaw: async () => {
          throw new EtnError('NOT_FOUND', 'wallpaper file not found');
        },
      }),
    );
    writeWallpaperCache(deps.cacheDir, {
      bytes: BYTES,
      mime_type: 'image/jpeg',
      file_size: BYTES.length,
      content_hash: 'old',
      meta: { width: 1, height: 1, avg_luminance: 0 },
      updated_at: 1,
    });
    const view = await loadWallpaper(deps);
    assert.deepEqual(view, { status: 'none' });
    assert.equal(existsSync(deps.cacheDir), false);
    rmSync(deps.userData, { recursive: true, force: true });
  });
});

describe('loadWallpaper: офлайн (сценарий 0ec86f0b)', () => {
  it('сеть недоступна — последняя картинка из кэша, source=cache', async () => {
    const deps = setup(
      remote({
        getWallpaper: async () => {
          throw new Error('fetch failed');
        },
      }),
    );
    writeWallpaperCache(deps.cacheDir, {
      bytes: BYTES,
      mime_type: 'image/png',
      file_size: BYTES.length,
      content_hash: 'cached',
      meta: { width: 2, height: 2, avg_luminance: 0.7 },
      updated_at: 5,
    });
    const view = await loadWallpaper(deps);
    assert.ok(view.status === 'ok');
    assert.equal(view.source, 'cache');
    assert.equal(view.content_hash, 'cached');
    assert.equal(base64Of(view.data_url), BYTES.toString('base64'));
    assert.deepEqual(view.meta, { width: 2, height: 2, avg_luminance: 0.7 });
    rmSync(deps.userData, { recursive: true, force: true });
  });

  it('сеть недоступна и кэша нет — none (фон темы и сетка)', async () => {
    const deps = setup(
      remote({
        getWallpaper: async () => {
          throw new Error('fetch failed');
        },
      }),
    );
    assert.deepEqual(await loadWallpaper(deps), { status: 'none' });
    rmSync(deps.userData, { recursive: true, force: true });
  });

  it('подключения нет вовсе — читается только кэш', async () => {
    const deps = setup(null);
    assert.deepEqual(await loadWallpaper(deps), { status: 'none' }, 'кэша нет');
    writeWallpaperCache(deps.cacheDir, {
      bytes: BYTES,
      mime_type: 'image/jpeg',
      file_size: BYTES.length,
      content_hash: 'cached',
      meta: { width: 1, height: 1, avg_luminance: 0.5 },
      updated_at: 1,
    });
    const view = await loadWallpaper(deps);
    assert.ok(view.status === 'ok');
    assert.equal(view.source, 'cache');
    rmSync(deps.userData, { recursive: true, force: true });
  });
});

describe('uploadWallpaper: загрузка и перезапись', () => {
  it('отправляет подготовленные байты и метаданные, кэш — из отправленного', async () => {
    const sent: unknown[] = [];
    const deps = setup(
      remote({
        uploadWallpaper: async (input) => {
          sent.push(input);
          return info({ mime_type: input.mime_type, meta: input.meta });
        },
      }),
    );
    const view = await uploadWallpaper(deps, {
      data_base64: BYTES.toString('base64'),
      mime_type: 'image/jpeg',
      meta: { width: 1920, height: 1080, avg_luminance: 0.4, dominant_hue: 210 },
    });
    assert.equal(sent.length, 1, 'один PUT на загрузку');
    assert.deepEqual(sent[0], {
      data_base64: BYTES.toString('base64'),
      mime_type: 'image/jpeg',
      meta: { width: 1920, height: 1080, avg_luminance: 0.4, dominant_hue: 210 },
    });
    assert.ok(view.status === 'ok');
    assert.equal(view.source, 'server');
    const cached = readWallpaperCache(deps.cacheDir);
    assert.ok(cached !== null);
    assert.equal(cached.content_hash.length, 64, 'хеш отправленных байтов');
    rmSync(deps.userData, { recursive: true, force: true });
  });

  it('офлайн — ошибка наверх (повтор позже), кэш не подменяется', async () => {
    const deps = setup(null);
    await assert.rejects(
      () =>
        uploadWallpaper(deps, {
          data_base64: BYTES.toString('base64'),
          mime_type: 'image/jpeg',
          meta: { width: 1, height: 1, avg_luminance: 0 },
        }),
      /not connected/i,
    );
    assert.equal(existsSync(deps.cacheDir), false);
    rmSync(deps.userData, { recursive: true, force: true });
  });

  it('отказ сервера (422) пробрасывается вызывающему', async () => {
    const deps = setup(
      remote({
        uploadWallpaper: async () => {
          throw new EtnError('VALIDATION_ERROR', 'file too large', { field: 'file_size' });
        },
      }),
    );
    await assert.rejects(
      () =>
        uploadWallpaper(deps, {
          data_base64: BYTES.toString('base64'),
          mime_type: 'image/jpeg',
          meta: { width: 1, height: 1, avg_luminance: 0 },
        }),
      (err: unknown) =>
        err instanceof EtnError &&
        err.code === 'VALIDATION_ERROR' &&
        (err.details as { field?: string }).field === 'file_size',
    );
    rmSync(deps.userData, { recursive: true, force: true });
  });
});

describe('removeWallpaper: отказ от картинки', () => {
  it('DELETE и очистка кэша', async () => {
    let deleted = 0;
    const deps = setup(
      remote({
        deleteWallpaper: async () => {
          deleted += 1;
        },
      }),
    );
    writeWallpaperCache(deps.cacheDir, {
      bytes: BYTES,
      mime_type: 'image/jpeg',
      file_size: BYTES.length,
      content_hash: 'cached',
      meta: { width: 1, height: 1, avg_luminance: 0 },
      updated_at: 1,
    });
    await removeWallpaper(deps);
    assert.equal(deleted, 1);
    assert.equal(existsSync(deps.cacheDir), false);
    rmSync(deps.userData, { recursive: true, force: true });
  });

  it('офлайн: кэш чистится, сервер не тронут (ошибки нет)', async () => {
    const deps = setup(null);
    writeWallpaperCache(deps.cacheDir, {
      bytes: BYTES,
      mime_type: 'image/jpeg',
      file_size: BYTES.length,
      content_hash: 'cached',
      meta: { width: 1, height: 1, avg_luminance: 0 },
      updated_at: 1,
    });
    await removeWallpaper(deps);
    assert.equal(existsSync(deps.cacheDir), false);
    rmSync(deps.userData, { recursive: true, force: true });
  });

  it('сбой DELETE пробрасывается, кэш остаётся (картинка на сервере ещё есть)', async () => {
    const deps = setup(
      remote({
        deleteWallpaper: async () => {
          throw new EtnError('INTERNAL', 'server unavailable');
        },
      }),
    );
    writeWallpaperCache(deps.cacheDir, {
      bytes: BYTES,
      mime_type: 'image/jpeg',
      file_size: BYTES.length,
      content_hash: 'cached',
      meta: { width: 1, height: 1, avg_luminance: 0 },
      updated_at: 1,
    });
    await assert.rejects(() => removeWallpaper(deps), /server unavailable/);
    assert.ok(readWallpaperCache(deps.cacheDir) !== null, 'кэш не стёрт при неудаче');
    rmSync(deps.userData, { recursive: true, force: true });
  });
});
