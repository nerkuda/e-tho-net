/**
 * `etn publications rebuild` (0.11.1, задача 07b09d8b; операция f7824d11).
 *
 * Покрытие DoD: повторный запуск без изменений в базе не меняет файлы
 * (содержимое и mtime); слой передаётся флагом; отсутствующая публикация —
 * предупреждение и код успеха. Плюс: выбор сети по id и по имени, форматы,
 * zip, отказы по ключу и доступу.
 *
 * Чистые тесты парсера идут всегда; интеграционные требуют нативной сборки
 * `better-sqlite3` и пропускаются без неё.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { BASE_LAYER_ID } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { main, parsePublicationsRebuildArgs } from '../src/cli.js';
import { SystemDb } from '../src/db/system-db.js';
import { closeAll, closeNetworkDb, openNetworkDb } from '../src/db/network-db.js';
import { NetworkServiceImpl } from '../src/domain/network-service.js';
import { createLayer } from '../src/domain/layer-service.js';
import { createPublication } from '../src/domain/publication-service.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { createLogger } from '../src/logger.js';

/** Capture console.{log,error,info} output during an async callback. */
async function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origInfo = console.info;
  console.log = (...a: unknown[]) => void stdout.push(a.join(' '));
  console.error = (...a: unknown[]) => void stderr.push(a.join(' '));
  console.info = (...a: unknown[]) => void stdout.push(a.join(' '));
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.info = origInfo;
  }
}

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe('parsePublicationsRebuildArgs', () => {
  it('parses the full flag set (space form)', () => {
    const parsed = parsePublicationsRebuildArgs([
      '--out',
      './docs',
      '--network',
      'net-1',
      '--layer',
      'layer-1',
      '--ids',
      'a, b ,c',
      '--format',
      'html',
      '--zip',
      '--api-key',
      'etn_x',
    ]);
    assert.equal(parsed.out, './docs');
    assert.equal(parsed.networkId, 'net-1');
    assert.equal(parsed.networkName, null);
    assert.equal(parsed.layerId, 'layer-1');
    assert.deepEqual(parsed.ids, ['a', 'b', 'c']);
    assert.equal(parsed.allActive, false);
    assert.equal(parsed.format, 'html');
    assert.equal(parsed.zip, true);
    assert.equal(parsed.apiKey, 'etn_x');
  });

  it('parses the --flag=value form and --all-active', () => {
    const parsed = parsePublicationsRebuildArgs([
      '--out=./out',
      '--network-name=Моя сеть',
      '--all-active',
    ]);
    assert.equal(parsed.out, './out');
    assert.equal(parsed.networkName, 'Моя сеть');
    assert.equal(parsed.allActive, true);
    assert.equal(parsed.format, 'md');
    assert.equal(parsed.zip, false);
  });

  it('rejects both --network and --network-name', () => {
    assert.throws(
      () => parsePublicationsRebuildArgs(['--out', 'o', '--network', 'a', '--network-name', 'b', '--all-active']),
      /--network/,
    );
  });

  it('requires a network selector', () => {
    assert.throws(() => parsePublicationsRebuildArgs(['--out', 'o', '--all-active']), /--network/);
  });

  it('rejects both --ids and --all-active, and neither', () => {
    assert.throws(
      () => parsePublicationsRebuildArgs(['--out', 'o', '--network', 'n', '--ids', 'x', '--all-active']),
      /--ids/,
    );
    assert.throws(() => parsePublicationsRebuildArgs(['--out', 'o', '--network', 'n']), /--ids/);
  });

  it('requires --out and rejects an unknown format', () => {
    assert.throws(() => parsePublicationsRebuildArgs(['--network', 'n', '--all-active']), /--out/);
    assert.throws(
      () => parsePublicationsRebuildArgs(['--out', 'o', '--network', 'n', '--all-active', '--format', 'pdf']),
      /формат/,
    );
  });

  it('shows help on --help', () => {
    assert.throws(() => parsePublicationsRebuildArgs(['--help']), /Использование/);
  });
});

const skip = !nativeAvailable();

interface CliFixture {
  dataDir: string;
  key: string;
  plainKey: string;
  adminId: string;
  networkId: string;
}

describe('etn publications rebuild (integration)', { skip }, () => {
  const roots: string[] = [];

  afterEach(() => {
    closeAll();
    while (roots.length) {
      const dir = roots.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Fresh data dir: admin + primary key, a plain (no-rights) user, one network. */
  async function setup(): Promise<CliFixture> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-cli-pub-'));
    roots.push(dataDir);

    const sys = SystemDb.open(dataDir, createLogger('silent'));
    const adminId = randomUUID();
    sys.createUser({
      id: adminId,
      username: 'admin',
      displayName: 'Admin',
      isAdmin: true,
      isFirstUser: true,
    });
    const gen = generateApiKey();
    sys.createApiKey({
      id: randomUUID(),
      userId: adminId,
      label: 'primary',
      keyHash: hashApiKey(gen.key),
      keyPrefix: gen.keyPrefix,
    });

    const plainId = randomUUID();
    sys.createUser({ id: plainId, username: 'plain', displayName: null });
    const plainGen = generateApiKey();
    sys.createApiKey({
      id: randomUUID(),
      userId: plainId,
      label: 'plain',
      keyHash: hashApiKey(plainGen.key),
      keyPrefix: plainGen.keyPrefix,
    });

    const svc = new NetworkServiceImpl(sys, dataDir, createLogger('silent'));
    const net = await svc.createNetwork(adminId, 'Test Net');
    sys.close();

    return { dataDir, key: gen.key, plainKey: plainGen.key, adminId, networkId: net.id };
  }

  /** Seed a publication into the network and release the DB handle. */
  function seedPublication(fx: CliFixture, title: string, layerId = BASE_LAYER_ID): string {
    const ndb = openNetworkDb(fx.dataDir, fx.networkId, createLogger('silent'), layerId);
    const pub = createPublication(ndb, { title }, fx.adminId);
    closeNetworkDb(fx.networkId);
    return pub.id;
  }

  /** Create a child layer of the base layer and return its id. */
  function seedLayer(fx: CliFixture): string {
    const ndb = openNetworkDb(fx.dataDir, fx.networkId, createLogger('silent'), BASE_LAYER_ID);
    const layer = createLayer(ndb, {
      parentId: BASE_LAYER_ID,
      title: 'Черновик',
      createdBy: fx.adminId,
    });
    closeNetworkDb(fx.networkId);
    return layer.id;
  }

  function env(fx: CliFixture, apiKey?: string | null): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = { ETN_DATA_DIR: fx.dataDir };
    if (apiKey !== undefined && apiKey !== null) out.ETN_API_KEY = apiKey;
    return out;
  }

  it('собирает каталог с детерминированным именем и повторный запуск не меняет файлы', async () => {
    const fx = await setup();
    const pubId = seedPublication(fx, 'Моя Публикация');
    const outDir = path.join(fx.dataDir, 'out');
    const argv = [
      'node',
      'etn',
      'publications',
      'rebuild',
      '--out',
      outDir,
      '--network',
      fx.networkId,
      '--ids',
      pubId,
    ];

    const first = await captureConsole(() => main({ argv, env: env(fx, fx.key) }));
    assert.equal(first.result, 0, first.stderr.join('\n'));
    const mdPath = path.join(outDir, 'moya-publikaciya.md');
    assert.ok(fs.existsSync(mdPath), first.stdout.join('\n'));
    const content = fs.readFileSync(mdPath, 'utf8');
    assert.match(content, /^# Моя Публикация/);
    assert.match(content, /\*\*Автор:\*\* Admin/);
    const mtimeFirst = fs.statSync(mdPath).mtimeMs;

    const second = await captureConsole(() => main({ argv, env: env(fx, fx.key) }));
    assert.equal(second.result, 0, second.stderr.join('\n'));
    assert.ok(second.stdout.join('\n').includes('без изменений 1'), second.stdout.join('\n'));
    assert.equal(fs.readFileSync(mdPath, 'utf8'), content, 'содержимое изменилось при повторном запуске');
    assert.equal(fs.statSync(mdPath).mtimeMs, mtimeFirst, 'файл перезаписан без изменений');
  });

  it('формат html и zip: пишется архив с тем же документом', async () => {
    const fx = await setup();
    const pubId = seedPublication(fx, 'Моя Публикация');
    const outDir = path.join(fx.dataDir, 'out-html');

    const html = await captureConsole(() =>
      main({
        argv: [
          'node', 'etn', 'publications', 'rebuild',
          '--out', outDir,
          '--network', fx.networkId,
          '--ids', pubId,
          '--format', 'html',
        ],
        env: env(fx, fx.key),
      }),
    );
    assert.equal(html.result, 0, html.stderr.join('\n'));
    assert.ok(fs.existsSync(path.join(outDir, 'moya-publikaciya.html')));

    const outZip = path.join(fx.dataDir, 'out-zip');
    const zip = await captureConsole(() =>
      main({
        argv: [
          'node', 'etn', 'publications', 'rebuild',
          '--out', outZip,
          '--network', fx.networkId,
          '--ids', pubId,
          '--zip',
        ],
        env: env(fx, fx.key),
      }),
    );
    assert.equal(zip.result, 0, zip.stderr.join('\n'));
    const zipPath = path.join(outZip, 'moya-publikaciya.zip');
    assert.ok(fs.existsSync(zipPath));
    const head = fs.readFileSync(zipPath).subarray(0, 2).toString('latin1');
    assert.equal(head, 'PK', 'файл не является zip-архивом');
  });

  it('слой передаётся флагом: дочерний слой видит публикацию основы, чужой слой — ошибка', async () => {
    const fx = await setup();
    const pubId = seedPublication(fx, 'Слойная публикация');
    const layerId = seedLayer(fx);
    const outDir = path.join(fx.dataDir, 'out-layer');

    const ok = await captureConsole(() =>
      main({
        argv: [
          'node', 'etn', 'publications', 'rebuild',
          '--out', outDir,
          '--network', fx.networkId,
          '--layer', layerId,
          '--ids', pubId,
        ],
        env: env(fx, fx.key),
      }),
    );
    assert.equal(ok.result, 0, ok.stderr.join('\n'));
    assert.ok(fs.existsSync(path.join(outDir, 'sloynaya-publikaciya.md')));

    const bad = await captureConsole(() =>
      main({
        argv: [
          'node', 'etn', 'publications', 'rebuild',
          '--out', outDir,
          '--network', fx.networkId,
          '--layer', randomUUID(),
          '--ids', pubId,
        ],
        env: env(fx, fx.key),
      }),
    );
    assert.equal(bad.result, 1);
    assert.ok(bad.stderr.join('\n').includes('не найден'), bad.stderr.join('\n'));
  });

  it('отсутствующая публикация — предупреждение и код успеха', async () => {
    const fx = await setup();
    const outDir = path.join(fx.dataDir, 'out-missing');

    const res = await captureConsole(() =>
      main({
        argv: [
          'node', 'etn', 'publications', 'rebuild',
          '--out', outDir,
          '--network', fx.networkId,
          '--ids', randomUUID(),
        ],
        env: env(fx, fx.key),
      }),
    );
    assert.equal(res.result, 0, res.stderr.join('\n'));
    const out = res.stdout.join('\n');
    assert.ok(out.includes('публикация не найдена'), out);
    assert.ok(out.includes('Публикаций для пересборки нет'), out);
  });

  it('--all-active берёт все актуальные публикации; --network-name выбирает сеть по имени', async () => {
    const fx = await setup();
    seedPublication(fx, 'Первая');
    seedPublication(fx, 'Вторая');
    const outDir = path.join(fx.dataDir, 'out-all');

    const res = await captureConsole(() =>
      main({
        argv: [
          'node', 'etn', 'publications', 'rebuild',
          '--out', outDir,
          '--network-name', 'Test Net',
          '--all-active',
        ],
        env: env(fx, fx.key),
      }),
    );
    assert.equal(res.result, 0, res.stderr.join('\n'));
    assert.ok(fs.existsSync(path.join(outDir, 'pervaya.md')));
    assert.ok(fs.existsSync(path.join(outDir, 'vtoraya.md')));
  });

  it('отказы: без API-key и без доступа к сети', async () => {
    const fx = await setup();
    seedPublication(fx, 'Закрытая');
    const outDir = path.join(fx.dataDir, 'out-denied');

    const noKey = await captureConsole(() =>
      main({
        argv: [
          'node', 'etn', 'publications', 'rebuild',
          '--out', outDir,
          '--network', fx.networkId,
          '--all-active',
        ],
        env: env(fx, null),
      }),
    );
    assert.equal(noKey.result, 1);
    assert.ok(noKey.stderr.join('\n').includes('API-key'), noKey.stderr.join('\n'));

    const noAccess = await captureConsole(() =>
      main({
        argv: [
          'node', 'etn', 'publications', 'rebuild',
          '--out', outDir,
          '--network', fx.networkId,
          '--all-active',
        ],
        env: env(fx, fx.plainKey),
      }),
    );
    assert.equal(noAccess.result, 1);
    assert.ok(noAccess.stderr.join('\n').includes('Нет доступа'), noAccess.stderr.join('\n'));
  });
});
