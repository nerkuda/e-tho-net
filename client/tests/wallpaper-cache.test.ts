/**
 * Локальный кэш фоновой картинки карты (0.16.1, задача 80324150; сценарий
 * офлайн-старта 0ec86f0b).
 *
 * Кэш — файл в `userData`, ключ каталога — профиль сервера + пользователь.
 * `wallpaper.json` — коммит-запись: недописанная картинка не должна выглядеть
 * валидным кэшем, поэтому несовпадение размера отбрасывает запись, а сбой
 * записи не оставляет полувалидного состояния.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  clearWallpaperCache,
  readWallpaperCache,
  wallpaperCacheBytesPath,
  wallpaperCacheDir,
  writeWallpaperCache,
  type WallpaperCacheEntry,
} from '../src/main/wallpaper/wallpaper-cache.js';

/** Свежий временный `userData`. */
function tmpUserData(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'etn-wallpaper-cache-'));
}

/** Запись кэша для тестов: 4 байта «картинки» и метаданные. */
function entry(overrides: Partial<WallpaperCacheEntry> = {}): WallpaperCacheEntry {
  const bytes = Buffer.from([1, 2, 3, 4]);
  return {
    bytes,
    mime_type: 'image/jpeg',
    file_size: bytes.length,
    content_hash: 'abc123',
    meta: { width: 2, height: 2, avg_luminance: 0.25 },
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

describe('каталог кэша', () => {
  it('ключ — профиль сервера + пользователь, имена не зависят от их вида', () => {
    const dir = tmpUserData();
    const a = wallpaperCacheDir(dir, 'profile-1', 'user-1');
    const b = wallpaperCacheDir(dir, 'profile-1', 'user-1');
    const otherUser = wallpaperCacheDir(dir, 'profile-1', 'user-2');
    const otherProfile = wallpaperCacheDir(dir, 'profile-2', 'user-1');
    assert.equal(a, b, 'один и тот же ключ — один каталог');
    assert.notEqual(a, otherUser, 'разные пользователи — разные каталоги');
    assert.notEqual(a, otherProfile, 'разные профили сервера — разные каталоги');
    assert.ok(a.startsWith(path.join(dir, 'wallpaper')), 'кэш живёт в <userData>/wallpaper');
    assert.equal(wallpaperCacheDir(dir, 'p', null), wallpaperCacheDir(dir, 'p', null));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('чтение/запись кэша', () => {
  it('запись читается обратно байт-в-байт с метаданными', () => {
    const dir = tmpUserData();
    const cacheDir = wallpaperCacheDir(dir, 'p', 'u');
    writeWallpaperCache(cacheDir, entry());
    assert.ok(existsSync(wallpaperCacheBytesPath(cacheDir)), 'байты записаны');
    const read = readWallpaperCache(cacheDir);
    assert.ok(read !== null);
    assert.deepEqual([...read.bytes], [1, 2, 3, 4]);
    assert.equal(read.mime_type, 'image/jpeg');
    assert.equal(read.content_hash, 'abc123');
    assert.deepEqual(read.meta, { width: 2, height: 2, avg_luminance: 0.25 });
    rmSync(dir, { recursive: true, force: true });
  });

  it('пустой каталог — кэша нет (штатная деградация, не ошибка)', () => {
    const dir = tmpUserData();
    assert.equal(readWallpaperCache(wallpaperCacheDir(dir, 'p', 'u')), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('несовпадение размера отбрасывает запись (недописанная картинка)', () => {
    const dir = tmpUserData();
    const cacheDir = wallpaperCacheDir(dir, 'p', 'u');
    writeWallpaperCache(cacheDir, entry());
    // Байты «потеряли» хвост — индекс обещает 4 байта.
    writeFileSync(wallpaperCacheBytesPath(cacheDir), Buffer.from([1, 2]));
    assert.equal(readWallpaperCache(cacheDir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('битый индекс — кэша нет, исключение наружу не летит', () => {
    const dir = tmpUserData();
    const cacheDir = wallpaperCacheDir(dir, 'p', 'u');
    writeWallpaperCache(cacheDir, entry());
    writeFileSync(path.join(cacheDir, 'wallpaper.json'), '{not json');
    assert.equal(readWallpaperCache(cacheDir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('перезапись заменяет картинку целиком', () => {
    const dir = tmpUserData();
    const cacheDir = wallpaperCacheDir(dir, 'p', 'u');
    writeWallpaperCache(cacheDir, entry());
    const bytes = Buffer.from([9, 9, 9, 9, 9]);
    writeWallpaperCache(
      cacheDir,
      entry({ bytes, file_size: bytes.length, mime_type: 'image/png', content_hash: 'z' }),
    );
    const read = readWallpaperCache(cacheDir);
    assert.ok(read !== null);
    assert.equal(read.file_size, 5);
    assert.equal(read.mime_type, 'image/png');
    assert.deepEqual([...read.bytes], [9, 9, 9, 9, 9]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('clear удаляет каталог целиком (картинки нет или файл пропал на сервере)', () => {
    const dir = tmpUserData();
    const cacheDir = wallpaperCacheDir(dir, 'p', 'u');
    writeWallpaperCache(cacheDir, entry());
    clearWallpaperCache(cacheDir);
    assert.equal(existsSync(cacheDir), false);
    assert.equal(readWallpaperCache(cacheDir), null);
    // Идемпотентность: удаление несуществующего кэша не падает.
    clearWallpaperCache(cacheDir);
    rmSync(dir, { recursive: true, force: true });
  });
});
