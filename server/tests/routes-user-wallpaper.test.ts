/**
 * Integration tests for the server-level user files API
 * `/api/v1/users/me/wallpaper` (0.16.1, задача 8e007e63; операция API 31ef478a,
 * сущность 62fd29b5, ADR a5888535).
 *
 *   GET    /api/v1/users/me/wallpaper      — метаданные (404 — картинки нет)
 *   GET    /api/v1/users/me/wallpaper/raw  — байты: ETag, nosniff (404 — нет файла)
 *   PUT    /api/v1/users/me/wallpaper      — загрузка/перезапись (201/200)
 *   DELETE /api/v1/users/me/wallpaper      — удаление (204 всегда)
 *
 * Покрытие критериев приёмки: контракт операции целиком; перезапись удаляет
 * прежний файл с диска; отказ (лимит, mime, магические байты, битые метаданные)
 * отвечает 422 и не портит уже загруженную картинку — повтор отказа идемпотентен;
 * DELETE идемпотентен; файлы изолированы по пользователям; удаление
 * пользователя чистит его каталог.
 *
 * Требует нативную сборку `better-sqlite3` и настоящий временный `dataDir`
 * (файлы пишутся на диск); без нативной сборки группа пропускается.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import { USER_FILE_MAX_BYTES, USER_FILE_MIME_TYPES } from '@etn/shared';

import { DEFAULT_MCP_SESSION_IDLE_TTL_MS, DEFAULT_UPDATE_CONFIG } from '../src/config.js';
import type { ServerConfig } from '../src/config.js';
import { resolveClientChannel } from '../src/version.js';
import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir, userFilesDir } from '../src/paths.js';
import { createServer } from '../src/http/server.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { createLogger } from '../src/logger.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Базовый конфиг: `dataDir` подменяется на изолированный временный каталог. */
const BASE_CONFIG: Omit<ServerConfig, 'dataDir'> = {
  host: '127.0.0.1',
  port: 0,
  tls: null,
  logLevel: 'silent',
  mcp: { enabled: false, port: null, sessionIdleTtlMs: DEFAULT_MCP_SESSION_IDLE_TTL_MS },
  readerPool: { size: 1, taskTimeoutMs: 30000 },
  walCheckpoint: { intervalMs: 0 },
  writePool: { size: 0, taskTimeoutMs: 120000, idleEvictionMs: 30000 },
  clientChannel: resolveClientChannel({}),
  update: DEFAULT_UPDATE_CONFIG,
  deployment: 'standalone',
};

interface SeededUser {
  userId: string;
  key: string;
}

interface TestContext {
  app: FastifyInstance;
  sys: SystemDb;
  db: Database.Database;
  dataDir: string;
  alice: SeededUser;
  bob: SeededUser;
  admin: SeededUser;
}

/** Seed a user + one API key; returns the plaintext key for Authorization. */
function seedUser(sys: SystemDb, username: string, isAdmin = false): SeededUser {
  const userId = randomUUID();
  sys.createUser({ id: userId, username, displayName: username, isAdmin });
  const gen = generateApiKey();
  sys.createApiKey({
    id: randomUUID(),
    userId,
    label: 'primary',
    keyHash: hashApiKey(gen.key),
    keyPrefix: gen.keyPrefix,
  });
  return { userId, key: gen.key };
}

/** Build the app on an isolated temp data directory with three users. */
async function setup(): Promise<TestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), 'etn-wallpaper-'));
  const db: Database.Database = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, systemMigrationsDir());
  const sys = new SystemDb(db);
  const admin = seedUser(sys, 'admin', true);
  const alice = seedUser(sys, 'alice');
  const bob = seedUser(sys, 'bob');
  const app = await createServer({
    config: { ...BASE_CONFIG, dataDir },
    systemDb: sys,
    logger: createLogger('silent'),
  });
  return { app, sys, db, dataDir, alice, bob, admin };
}

/** Закрыть приложение, БД и убрать временный каталог данных. */
async function teardown(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  ctx.db.close();
  rmSync(ctx.dataDir, { recursive: true, force: true });
}

/** Байты «PNG»: сервер проверяет только магические байты (без image-зависимостей). */
function pngBytes(payload = 'png-payload'): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(payload),
  ]);
}

/** Байты «JPEG» (маркер SOI + APP0). */
function jpegBytes(payload = 'jpeg-payload'): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(payload)]);
}

/** Байты «WebP» (RIFF….WEBP). */
function webpBytes(payload = 'webp-payload'): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'),
    Buffer.from(payload),
  ]);
}

/** Корректные метаданные картинки — их считает клиент при загрузке. */
const META = { width: 1920, height: 1080, avg_luminance: 0.42 } as const;

function authHeaders(user: SeededUser): Record<string, string> {
  return { authorization: `Bearer ${user.key}` };
}

/** JSON-загрузка: `{data_base64, meta}` (+ необязательный `mime_type`). */
async function putJson(
  ctx: TestContext,
  user: SeededUser,
  bytes: Buffer,
  meta: unknown,
  mimeType?: string,
) {
  const payload: Record<string, unknown> = { data_base64: bytes.toString('base64'), meta };
  if (mimeType !== undefined) payload['mime_type'] = mimeType;
  return ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/users/me/wallpaper',
    headers: authHeaders(user),
    payload,
  });
}

async function getMeta(ctx: TestContext, user: SeededUser) {
  return ctx.app.inject({
    method: 'GET',
    url: '/api/v1/users/me/wallpaper',
    headers: authHeaders(user),
  });
}

async function getRaw(ctx: TestContext, user: SeededUser, ifNoneMatch?: string) {
  const headers: Record<string, string> = authHeaders(user);
  if (ifNoneMatch !== undefined) headers['if-none-match'] = ifNoneMatch;
  return ctx.app.inject({
    method: 'GET',
    url: '/api/v1/users/me/wallpaper/raw',
    headers,
  });
}

async function delWallpaper(ctx: TestContext, user: SeededUser) {
  return ctx.app.inject({
    method: 'DELETE',
    url: '/api/v1/users/me/wallpaper',
    headers: authHeaders(user),
  });
}

/** Одна часть multipart-тела: файл (есть `filename`) или текстовое поле. */
interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
}

/** Собрать `multipart/form-data` тело и его `content-type` с границей. */
function multipartPayload(parts: readonly MultipartPart[]): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = '----etn-wallpaper-test-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const isFile = part.filename !== undefined;
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"${
          isFile ? `; filename="${part.filename}"` : ''
        }\r\n`,
      ),
    );
    if (isFile) {
      chunks.push(
        Buffer.from(`Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n`),
      );
    }
    chunks.push(Buffer.from('\r\n'));
    chunks.push(isFile ? (part.data ?? Buffer.alloc(0)) : Buffer.from(part.value ?? ''));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** PUT `multipart/form-data` с частью `file` и текстовыми полями. */
async function putMultipart(ctx: TestContext, user: SeededUser, parts: readonly MultipartPart[]) {
  const { payload, contentType } = multipartPayload(parts);
  return ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/users/me/wallpaper',
    headers: { ...authHeaders(user), 'content-type': contentType },
    payload,
  });
}

/** Файлы, реально лежащие в каталоге пользователя (временных быть не должно). */
function storedFileNames(dataDir: string, userId: string): string[] {
  const dir = userFilesDir(dataDir, userId);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe(
  '/users/me/wallpaper routes',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('без картинки: GET метаданных и байтов — 404, DELETE — 204 (идемпотентно)', async () => {
      const ctx = await setup();
      try {
        assert.equal((await getMeta(ctx, ctx.alice)).statusCode, 404);
        assert.equal((await getRaw(ctx, ctx.alice)).statusCode, 404);
        assert.equal((await delWallpaper(ctx, ctx.alice)).statusCode, 204);
        assert.equal((await delWallpaper(ctx, ctx.alice)).statusCode, 204);
        assert.equal((await getMeta(ctx, ctx.alice)).statusCode, 404);
      } finally {
        await teardown(ctx);
      }
    });

    it('PUT создаёт картинку (201), GET отдаёт метаданные, raw — байты с ETag и nosniff', async () => {
      const ctx = await setup();
      try {
        const bytes = pngBytes();
        const put = await putJson(ctx, ctx.alice, bytes, META);
        assert.equal(put.statusCode, 201, put.body);
        const created = put.json().data as Record<string, unknown>;
        assert.equal(created['kind'], 'map_wallpaper');
        assert.equal(created['mime_type'], 'image/png');
        assert.equal(created['file_size'], bytes.length);
        assert.deepEqual(created['meta'], META);
        assert.equal(created['url'], '/api/v1/users/me/wallpaper/raw');

        const meta = await getMeta(ctx, ctx.alice);
        assert.equal(meta.statusCode, 200, meta.body);
        assert.deepEqual(meta.json().data, created);

        const raw = await getRaw(ctx, ctx.alice);
        assert.equal(raw.statusCode, 200);
        assert.deepEqual(raw.rawPayload, bytes);
        assert.equal(raw.headers['content-type'], 'image/png');
        assert.equal(raw.headers['x-content-type-options'], 'nosniff');
        assert.equal(raw.headers['content-length'], String(bytes.length));
        assert.match(String(raw.headers['etag']), /^"[0-9a-f]{64}"$/);
        assert.match(String(raw.headers['cache-control']), /private/);
        assert.match(String(raw.headers['content-disposition']), /^inline;/);
        // Расширение по фактическому mime (правки по вердикту проверки).
        assert.match(
          String(raw.headers['content-disposition']),
          /filename="wallpaper\.map_wallpaper\.png"/,
        );

        // Клиент повторяет запрос с ETag — получает 304 без тела.
        const etag = String(raw.headers['etag']);
        const notModified = await getRaw(ctx, ctx.alice, etag);
        assert.equal(notModified.statusCode, 304);
        assert.equal(notModified.rawPayload.length, 0);
        assert.equal((await getRaw(ctx, ctx.alice, '*')).statusCode, 304);
        assert.equal((await getRaw(ctx, ctx.alice, '"other"')).statusCode, 200);
      } finally {
        await teardown(ctx);
      }
    });

    it('mime без объявления определяется по магическим байтам (jpeg, webp)', async () => {
      const ctx = await setup();
      try {
        const jpeg = await putJson(ctx, ctx.alice, jpegBytes(), META);
        assert.equal(jpeg.statusCode, 201, jpeg.body);
        assert.equal((jpeg.json().data as { mime_type: string }).mime_type, 'image/jpeg');

        const webp = await putJson(ctx, ctx.alice, webpBytes(), META, 'image/webp');
        assert.equal(webp.statusCode, 200, webp.body);
        assert.equal((webp.json().data as { mime_type: string }).mime_type, 'image/webp');
        const raw = await getRaw(ctx, ctx.alice);
        assert.deepEqual(raw.rawPayload, webpBytes());
        assert.match(
          String(raw.headers['content-disposition']),
          /filename="wallpaper\.map_wallpaper\.webp"/,
        );
      } finally {
        await teardown(ctx);
      }
    });

    it('перезапись отдаёт 200 и физически удаляет прежний файл', async () => {
      const ctx = await setup();
      try {
        const first = pngBytes('first');
        const put1 = await putJson(ctx, ctx.alice, first, META);
        assert.equal(put1.statusCode, 201, put1.body);
        const etag1 = String((await getRaw(ctx, ctx.alice)).headers['etag']);
        const files1 = storedFileNames(ctx.dataDir, ctx.alice.userId);
        assert.equal(files1.length, 1);

        const second = jpegBytes('second');
        const put2 = await putJson(ctx, ctx.alice, second, { ...META, avg_luminance: 0.8 });
        assert.equal(put2.statusCode, 200, put2.body);
        const raw2 = await getRaw(ctx, ctx.alice);
        assert.deepEqual(raw2.rawPayload, second);
        assert.notEqual(String(raw2.headers['etag']), etag1);

        // Прежний файл удалён: в каталоге ровно один файл, и это новый.
        const files2 = storedFileNames(ctx.dataDir, ctx.alice.userId);
        assert.equal(files2.length, 1);
        assert.notDeepEqual(files2, files1);
        assert.equal(
          existsSync(join(userFilesDir(ctx.dataDir, ctx.alice.userId), files1[0]!)),
          false,
        );
      } finally {
        await teardown(ctx);
      }
    });

    it('отказы контракта — 422, прежняя картинка цела, повтор отказа идемпотентен', async () => {
      const ctx = await setup();
      try {
        const bytes = pngBytes('baseline');
        assert.equal((await putJson(ctx, ctx.alice, bytes, META)).statusCode, 201);
        const baseline = await getRaw(ctx, ctx.alice);
        const baselineEtag = String(baseline.headers['etag']);
        const baselineFiles = storedFileNames(ctx.dataDir, ctx.alice.userId);

        /** После любого отказа состояние картинки не изменилось. */
        const assertIntact = async (): Promise<void> => {
          const raw = await getRaw(ctx, ctx.alice);
          assert.equal(raw.statusCode, 200);
          assert.deepEqual(raw.rawPayload, bytes);
          assert.equal(String(raw.headers['etag']), baselineEtag);
          assert.deepEqual(storedFileNames(ctx.dataDir, ctx.alice.userId), baselineFiles);
        };

        // 1. mime не из белого списка — отказ по объявленному типу, независимо
        // от содержимого (в `details` — допустимый список).
        const gif = await putJson(ctx, ctx.alice, pngBytes('gif'), META, 'image/gif');
        assert.equal(gif.statusCode, 422, gif.body);
        assert.equal(gif.json().error.details.field, 'mime_type');
        assert.deepEqual(gif.json().error.details.allowed, [...USER_FILE_MIME_TYPES]);
        await assertIntact();

        // 2. Объявленный mime не совпал с магическими байтами.
        const mismatch = await putJson(ctx, ctx.alice, pngBytes('mismatch'), META, 'image/jpeg');
        assert.equal(mismatch.statusCode, 422, mismatch.body);
        assert.equal(mismatch.json().error.details.detected, 'image/png');
        await assertIntact();

        // 3. Содержимое не является картинкой поддерживаемого формата.
        const notImage = await putJson(ctx, ctx.alice, Buffer.from('plain text'), META);
        assert.equal(notImage.statusCode, 422, notImage.body);
        assert.equal(notImage.json().error.details.reason, 'not_an_image');
        await assertIntact();

        // 4. Превышение лимита 5 МиБ — доменный 422 (не 413).
        const tooLarge = Buffer.concat([pngBytes(), Buffer.alloc(USER_FILE_MAX_BYTES)]);
        const oversize = await putJson(ctx, ctx.alice, tooLarge, META);
        assert.equal(oversize.statusCode, 422, oversize.body);
        assert.equal(oversize.json().error.details.field, 'file_size');
        assert.equal(oversize.json().error.details.limit, USER_FILE_MAX_BYTES);
        await assertIntact();

        // 5. Битые метаданные: нет meta, не число, вне диапазона.
        const noMeta = await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/users/me/wallpaper',
          headers: authHeaders(ctx.alice),
          payload: { data_base64: pngBytes('no-meta').toString('base64') },
        });
        assert.equal(noMeta.statusCode, 422, noMeta.body);
        await assertIntact();

        for (const broken of [
          { width: '1920', height: 1080, avg_luminance: 0.4 },
          { width: 1920, height: 0, avg_luminance: 0.4 },
          { width: 1920, height: 1080, avg_luminance: 1.5 },
          { width: 1920, height: 1080, avg_luminance: 0.4, dominant_hue: 400 },
          { width: 1920, height: 1080, avg_luminance: 0.4, dominant_sat: -1 },
          [1, 2, 3],
        ]) {
          const bad = await putJson(ctx, ctx.alice, pngBytes('bad-meta'), broken);
          assert.equal(bad.statusCode, 422, `${JSON.stringify(broken)} → ${bad.statusCode}`);
          await assertIntact();
        }

        // 6. Пустой файл.
        const empty = await putJson(ctx, ctx.alice, Buffer.alloc(0), META);
        assert.equal(empty.statusCode, 422, empty.body);

        // Идемпотентность отказа: тот же невалидный запрос дважды — оба 422.
        const again1 = await putJson(ctx, ctx.alice, pngBytes('gif'), META, 'image/gif');
        const again2 = await putJson(ctx, ctx.alice, pngBytes('gif'), META, 'image/gif');
        assert.equal(again1.statusCode, 422);
        assert.equal(again2.statusCode, 422);
        await assertIntact();
      } finally {
        await teardown(ctx);
      }
    });

    it('multipart-загрузка: часть file + JSON-поле meta', async () => {
      const ctx = await setup();
      try {
        const bytes = jpegBytes('multipart');
        const upload = await putMultipart(ctx, ctx.bob, [
          { name: 'meta', value: JSON.stringify(META) },
          { name: 'file', filename: 'wallpaper.jpg', contentType: 'image/jpeg', data: bytes },
        ]);
        assert.equal(upload.statusCode, 201, upload.body);
        assert.equal((upload.json().data as { mime_type: string }).mime_type, 'image/jpeg');
        assert.deepEqual((await getRaw(ctx, ctx.bob)).rawPayload, bytes);

        // Перезапись тем же способом — 200; mime можно не объявлять: он берётся
        // из `content-type` файловой части.
        const second = webpBytes('multipart-2');
        const rewrite = await putMultipart(ctx, ctx.bob, [
          { name: 'meta', value: JSON.stringify(META) },
          { name: 'file', filename: 'wallpaper.webp', contentType: 'image/webp', data: second },
        ]);
        assert.equal(rewrite.statusCode, 200, rewrite.body);
        assert.deepEqual((await getRaw(ctx, ctx.bob)).rawPayload, second);

        // Неизвестное поле — 422 (неизвестный вход не игнорируется молча).
        const unknownField = await putMultipart(ctx, ctx.bob, [
          { name: 'meta', value: JSON.stringify(META) },
          { name: 'extra', value: 'x' },
          { name: 'file', filename: 'w.png', contentType: 'image/png', data: pngBytes('u') },
        ]);
        assert.equal(unknownField.statusCode, 422, unknownField.body);

        // Без файловой части — 422.
        const noFile = await putMultipart(ctx, ctx.bob, [
          { name: 'meta', value: JSON.stringify(META) },
        ]);
        assert.equal(noFile.statusCode, 422, noFile.body);

        // Без поля meta — 422.
        const noMeta = await putMultipart(ctx, ctx.bob, [
          { name: 'file', filename: 'w.png', contentType: 'image/png', data: pngBytes('n') },
        ]);
        assert.equal(noMeta.statusCode, 422, noMeta.body);

        // Битый JSON в meta — 422.
        const badMeta = await putMultipart(ctx, ctx.bob, [
          { name: 'meta', value: '{oops' },
          { name: 'file', filename: 'w.png', contentType: 'image/png', data: pngBytes('m') },
        ]);
        assert.equal(badMeta.statusCode, 422, badMeta.body);

        // Состояние не испорчено отказами.
        assert.deepEqual((await getRaw(ctx, ctx.bob)).rawPayload, second);
      } finally {
        await teardown(ctx);
      }
    });

    it('файлы изолированы по пользователям', async () => {
      const ctx = await setup();
      try {
        const aliceBytes = pngBytes('alice');
        const bobBytes = webpBytes('bob');
        assert.equal((await putJson(ctx, ctx.alice, aliceBytes, META)).statusCode, 201);
        assert.equal((await putJson(ctx, ctx.bob, bobBytes, META)).statusCode, 201);

        assert.deepEqual((await getRaw(ctx, ctx.alice)).rawPayload, aliceBytes);
        assert.deepEqual((await getRaw(ctx, ctx.bob)).rawPayload, bobBytes);

        assert.equal((await delWallpaper(ctx, ctx.bob)).statusCode, 204);
        assert.equal((await getMeta(ctx, ctx.bob)).statusCode, 404);
        const aliceRaw = await getRaw(ctx, ctx.alice);
        assert.equal(aliceRaw.statusCode, 200);
        assert.deepEqual(aliceRaw.rawPayload, aliceBytes);
      } finally {
        await teardown(ctx);
      }
    });

    it('DELETE удаляет строку и файл, повтор идемпотентен', async () => {
      const ctx = await setup();
      try {
        const bytes = pngBytes('to-delete');
        assert.equal((await putJson(ctx, ctx.alice, bytes, META)).statusCode, 201);
        const [stored] = storedFileNames(ctx.dataDir, ctx.alice.userId);
        assert.ok(stored !== undefined);

        assert.equal((await delWallpaper(ctx, ctx.alice)).statusCode, 204);
        assert.equal((await getMeta(ctx, ctx.alice)).statusCode, 404);
        assert.equal((await getRaw(ctx, ctx.alice)).statusCode, 404);
        assert.equal(ctx.sys.getUserFile(ctx.alice.userId, 'map_wallpaper'), null);
        assert.deepEqual(storedFileNames(ctx.dataDir, ctx.alice.userId), []);

        assert.equal((await delWallpaper(ctx, ctx.alice)).statusCode, 204);
      } finally {
        await teardown(ctx);
      }
    });

    it('строка есть, файла нет → raw 404, метаданные отдаются', async () => {
      const ctx = await setup();
      try {
        assert.equal((await putJson(ctx, ctx.alice, pngBytes('lost'), META)).statusCode, 201);
        const row = ctx.sys.getUserFile(ctx.alice.userId, 'map_wallpaper');
        assert.ok(row !== null);
        rmSync(row.file_path, { force: true });

        assert.equal((await getRaw(ctx, ctx.alice)).statusCode, 404);
        // Метаданные остаются: клиент видит запись и деградирует к типовому фону.
        assert.equal((await getMeta(ctx, ctx.alice)).statusCode, 200);
        // Повторная загрузка восстанавливает файл.
        assert.equal((await putJson(ctx, ctx.alice, pngBytes('restored'), META)).statusCode, 200);
        assert.equal((await getRaw(ctx, ctx.alice)).statusCode, 200);
      } finally {
        await teardown(ctx);
      }
    });

    it('удаление пользователя каскадом чистит строки и каталог файлов', async () => {
      const ctx = await setup();
      try {
        assert.equal((await putJson(ctx, ctx.bob, pngBytes('bob'), META)).statusCode, 201);
        const bobDir = join(ctx.dataDir, 'users', ctx.bob.userId);
        assert.ok(existsSync(bobDir));

        const res = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/users/${ctx.bob.userId}`,
          headers: authHeaders(ctx.admin),
        });
        assert.equal(res.statusCode, 204, res.body);
        assert.equal(ctx.sys.getUserFile(ctx.bob.userId, 'map_wallpaper'), null);
        assert.equal(existsSync(bobDir), false, 'каталог пользователя должен быть удалён');
      } finally {
        await teardown(ctx);
      }
    });

    it('без ключа все маршруты отвечают 401', async () => {
      const ctx = await setup();
      try {
        for (const method of ['GET', 'PUT', 'DELETE'] as const) {
          const res = await ctx.app.inject({
            method,
            url: '/api/v1/users/me/wallpaper',
            ...(method === 'PUT' ? { payload: {} } : {}),
          });
          assert.equal(res.statusCode, 401, `${method} → ${res.statusCode}`);
        }
        const raw = await ctx.app.inject({ method: 'GET', url: '/api/v1/users/me/wallpaper/raw' });
        assert.equal(raw.statusCode, 401);
      } finally {
        await teardown(ctx);
      }
    });

    it('meta хранится как есть: лишние ключи клиента остаются в JSON', async () => {
      const ctx = await setup();
      try {
        const meta = {
          width: 1920,
          height: 1080,
          avg_luminance: 0.42,
          dominant_hue: null,
          dominant_sat: 0.35,
          // Поля, которых нет в схеме сервера: сущность 62fd29b5 требует
          // «meta хранится как есть», поэтому они не отбрасываются.
          crop: 'cover',
          focal: { x: 0.5, y: 0.5 },
        };
        const put = await putJson(ctx, ctx.alice, pngBytes('meta-asis'), meta);
        assert.equal(put.statusCode, 201, put.body);
        const created = put.json().data as { meta: unknown };
        assert.deepEqual(created.meta, meta);

        const metaRes = await getMeta(ctx, ctx.alice);
        assert.equal(metaRes.statusCode, 200, metaRes.body);
        assert.deepEqual((metaRes.json().data as { meta: unknown }).meta, meta);
      } finally {
        await teardown(ctx);
      }
    });

    it('транспортный потолок отдаёт 422, как и доменный лимит (multipart и JSON)', async () => {
      const ctx = await setup();
      try {
        const oversize = Buffer.concat([pngBytes('huge'), Buffer.alloc(9 * 1024 * 1024)]);

        // multipart: файл больше транспортного потолка (8 МиБ) — отказ
        // multipart-парсера переводится в 422 с доменным details.
        const multipart = await putMultipart(ctx, ctx.alice, [
          { name: 'meta', value: JSON.stringify(META) },
          { name: 'file', filename: 'huge.png', contentType: 'image/png', data: oversize },
        ]);
        assert.equal(multipart.statusCode, 422, multipart.body);
        const multipartError = multipart.json().error;
        assert.equal(multipartError.code, 'VALIDATION_ERROR');
        assert.equal(multipartError.details.field, 'file_size');
        assert.equal(multipartError.details.limit, USER_FILE_MAX_BYTES);
        assert.equal(multipartError.details.reason, 'payload_too_large');

        // JSON: тело больше `bodyLimit` (8 МиБ, 5 МиБ в base64 ≈ 6.7 МиБ) —
        // тот же 422 и та же форма details.
        const json = await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/users/me/wallpaper',
          headers: authHeaders(ctx.alice),
          payload: { data_base64: 'A'.repeat(9 * 1024 * 1024), meta: META },
        });
        assert.equal(json.statusCode, 422, json.body);
        assert.equal(json.json().error.details.field, 'file_size');
        assert.equal(json.json().error.details.reason, 'payload_too_large');

        // После отказов картинки нет — запись не появилась.
        assert.equal((await getMeta(ctx, ctx.alice)).statusCode, 404);
      } finally {
        await teardown(ctx);
      }
    });

    it('белый список mime — jpeg/png/webp (контракт для клиента)', () => {
      assert.deepEqual([...USER_FILE_MIME_TYPES], ['image/jpeg', 'image/png', 'image/webp']);
    });
  },
);
