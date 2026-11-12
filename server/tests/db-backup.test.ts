/**
 * Тесты резервного копирования и восстановления баз (задача 3acd9c3c).
 *
 * Проверяются обе поверхности одного модуля: библиотечные `createBackup` /
 * `restoreBackup` и CLI `etn backup` / `etn restore` с отчётом `key=value`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import DatabaseConstructor from 'better-sqlite3';
import archiver from 'archiver';

import {
  DbToolError,
  backupTimestamp,
  compareVersions,
  createBackup,
  formatDbToolReport,
  readServerVersion,
  restoreBackup,
  runBackupCli,
  runRestoreCli,
  writeDbToolReport,
} from '../src/db/db-backup.js';

const SOURCE_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'db',
  'db-backup.ts',
);

const tmpRoots: string[] = [];

function makeRoot(name: string): string {
  // Пробелы и кириллица в пути — часть контракта (путь из установщика может
  // быть `%ProgramData%\ETN`, а каталог пользователя — русским).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `etn-db-backup ${name} — `));
  tmpRoots.push(root);
  return root;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop()!;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createDatabase(file: string, values: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseConstructor(file);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS t(v TEXT)');
    for (const value of values) db.prepare('INSERT INTO t(v) VALUES (?)').run(value);
  } finally {
    db.close();
  }
}

function readValues(file: string): string[] {
  const db = new DatabaseConstructor(file, { readonly: true });
  try {
    return (db.prepare('SELECT v FROM t ORDER BY rowid').all() as Array<{ v: string }>).map(
      (row) => row.v,
    );
  } finally {
    db.close();
  }
}

function makeDataDir(root: string, options: { system?: string[]; networks?: string[] }): string {
  const dataDir = path.join(root, 'данные ETN');
  if (options.system !== undefined) {
    createDatabase(path.join(dataDir, '_system.db'), options.system);
  }
  for (const id of options.networks ?? []) {
    createDatabase(path.join(dataDir, 'networks', id, 'data.db'), [`network-${id.slice(0, 4)}`]);
  }
  return dataDir;
}

async function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => void stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => void stderr.push(args.join(' '));
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

function backupFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.startsWith('etn-backup-'));
}

/** Собрать ZIP из готовых файлов (для «битого» архива). */
async function writeZip(zipPath: string, files: Array<{ filePath: string; name: string }>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip');
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const file of files) archive.file(file.filePath, { name: file.name });
    void archive.finalize();
  });
}

type LiveDatabase = InstanceType<typeof DatabaseConstructor>;

/**
 * База-источник с живым WAL-хвостом. Соединение возвращается открытым: на
 * последнем закрытии SQLite чекпойнтит и удаляет `-wal`, а тесту нужен
 * реальный WAL на диске.
 */
function openWalSource(file: string, values: string[]): LiveDatabase {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseConstructor(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t(v TEXT)');
  db.prepare('INSERT INTO t(v) VALUES (?)').run(values[0] ?? 'base');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.pragma('wal_autocheckpoint = 0');
  for (const value of values.slice(1)) db.prepare('INSERT INTO t(v) VALUES (?)').run(value);
  return db;
}

/** Скопировать живую WAL-базу вместе с `-wal`/`-shm` в целевой каталог. */
function copyLiveDatabase(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.copyFileSync(`${source}-wal`, `${destination}-wal`);
  if (fs.existsSync(`${source}-shm`)) fs.copyFileSync(`${source}-shm`, `${destination}-shm`);
}

/** Подменить функцию `node:fs` на время теста; возвращает восстановление. */
function patchFs(name: 'rmSync' | 'copyFileSync', replacement: unknown): () => void {
  const target = fs as unknown as Record<string, unknown>;
  const original = target[name];
  target[name] = replacement;
  return () => {
    target[name] = original;
  };
}

describe('db-backup: создание архива', () => {
  it('создаёт ZIP с _system.db и networks/<uuid>/data.db, не меняя _migrations', async () => {
    const root = makeRoot('create');
    const dataDir = path.join(root, 'данные ETN');
    fs.mkdirSync(dataDir, { recursive: true });
    const systemDb = path.join(dataDir, '_system.db');
    createDatabase(systemDb, ['alpha', 'beta']);
    const migrationDb = new DatabaseConstructor(systemDb);
    migrationDb.exec('CREATE TABLE _migrations(id TEXT PRIMARY KEY, applied_at TEXT)');
    migrationDb.prepare('INSERT INTO _migrations VALUES (?, ?)').run('001', 'now');
    migrationDb.close();
    const networkId = '11111111-2222-3333-4444-555555555555';
    createDatabase(path.join(dataDir, 'networks', networkId, 'data.db'), ['gamma']);
    const beforeDb = new DatabaseConstructor(systemDb, { readonly: true });
    const before = beforeDb.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number };
    beforeDb.close();

    const toDir = path.join(root, 'backups');
    const report = await createBackup({ dataDir, toDir, version: '0.15.3' });

    assert.equal(report.code, 0, report.error ?? '');
    assert.equal(report.databases, 2);
    assert.ok(report.bytes > 0);
    assert.ok(report.archive !== null);
    assert.match(path.basename(report.archive!), /^etn-backup-0\.15\.3-\d{8}-\d{6}\.zip$/);
    assert.ok(fs.existsSync(report.archive!));
    assert.equal(backupFiles(toDir).filter((name) => name.endsWith('.partial')).length, 0);

    const afterDb = new DatabaseConstructor(systemDb, { readonly: true });
    const after = afterDb.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number };
    afterDb.close();
    assert.equal(after.n, before.n, 'backup не применяет миграции');

    // Архив самодостаточен: восстанавливаем в чистый каталог и сверяем данные.
    const restoredDir = path.join(root, 'restored');
    const restoreReport = await restoreBackup({
      dataDir: restoredDir,
      from: report.archive!,
      force: true,
      currentVersion: '0.15.3',
    });
    assert.equal(restoreReport.code, 0, restoreReport.error ?? '');
    assert.deepEqual(readValues(path.join(restoredDir, '_system.db')), ['alpha', 'beta']);
    assert.deepEqual(readValues(path.join(restoredDir, 'networks', networkId, 'data.db')), [
      'gamma',
    ]);
    assert.equal(fs.existsSync(path.join(restoredDir, '_system.db-wal')), false);
    assert.equal(fs.existsSync(path.join(restoredDir, '_system.db-shm')), false);
  });

  it('переносит незачекпойнченный WAL-хвост в самодостаточную копию', async () => {
    const root = makeRoot('wal');
    const dataDir = makeDataDir(root, {});
    fs.mkdirSync(dataDir, { recursive: true });
    const systemDb = path.join(dataDir, '_system.db');
    const writer = new DatabaseConstructor(systemDb);
    writer.pragma('journal_mode = WAL');
    writer.exec('CREATE TABLE t(v TEXT)');
    writer.prepare('INSERT INTO t(v) VALUES (?)').run('alpha');
    writer.pragma('wal_checkpoint(TRUNCATE)');
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare('INSERT INTO t(v) VALUES (?)').run('wal-tail');
    assert.ok(fs.existsSync(`${systemDb}-wal`), 'WAL-хвост остался на диске');
    try {
      const report = await createBackup({
        dataDir,
        toDir: path.join(root, 'backups'),
        version: '0.15.3',
      });
      assert.equal(report.code, 0, report.error ?? '');
      const restoredDir = path.join(root, 'restored');
      await restoreBackup({
        dataDir: restoredDir,
        from: report.archive!,
        force: true,
        currentVersion: '0.15.3',
      });
      assert.deepEqual(readValues(path.join(restoredDir, '_system.db')), ['alpha', 'wal-tail']);
      assert.equal(fs.existsSync(path.join(restoredDir, '_system.db-wal')), false);
    } finally {
      writer.close();
    }
  });

  it('без баз возвращает успех и не создаёт каталог архивов', async () => {
    const root = makeRoot('empty');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const toDir = path.join(root, 'backups');
    const report = await createBackup({ dataDir, toDir, version: '0.15.3' });
    assert.equal(report.code, 0);
    assert.equal(report.archive, null);
    assert.equal(report.databases, 0);
    assert.ok(report.warnings.length > 0);
    assert.equal(fs.existsSync(toDir), false);
  });

  it('битая БД — ожидаемый отказ (код 1), архив и .partial удалены', async () => {
    const root = makeRoot('corrupt');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, '_system.db'), 'not a sqlite database at all');
    const toDir = path.join(root, 'backups');
    const before = backupFiles(toDir);
    await assert.rejects(
      () => createBackup({ dataDir, toDir, version: '0.15.3' }),
      (error: unknown) => error instanceof DbToolError && error.code === 1,
    );
    assert.deepEqual(backupFiles(toDir), before);
  });

  it('путь архивов занят файлом — ожидаемый отказ (код 1)', async () => {
    const root = makeRoot('to-file');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const toDir = path.join(root, 'backups');
    fs.writeFileSync(toDir, 'occupied');
    await assert.rejects(
      () => createBackup({ dataDir, toDir, version: '0.15.3' }),
      (error: unknown) => error instanceof DbToolError && error.code === 1,
    );
    assert.equal(fs.readFileSync(toDir, 'utf8'), 'occupied');
  });

  it('несуществующий каталог данных — код 2, а не «бэкапить нечего»', async () => {
    const root = makeRoot('missing-data');
    const dataDir = path.join(root, 'нет такого каталога');
    await assert.rejects(
      () => createBackup({ dataDir, toDir: path.join(root, 'backups'), version: '0.15.3' }),
      (error: unknown) =>
        error instanceof DbToolError &&
        error.code === 2 &&
        /data directory cannot be read/.test(error.message),
    );
    assert.equal(fs.existsSync(path.join(root, 'backups')), false);
  });

  it('каталог данных — файл — код 2', async () => {
    const root = makeRoot('data-is-file');
    const dataDir = path.join(root, 'data');
    fs.writeFileSync(dataDir, 'not a directory');
    await assert.rejects(
      () => createBackup({ dataDir, toDir: path.join(root, 'backups'), version: '0.15.3' }),
      (error: unknown) =>
        error instanceof DbToolError &&
        error.code === 2 &&
        /not a directory/.test(error.message),
    );
  });

  it('ошибка удаления старого архива — предупреждение и код 0', async () => {
    const root = makeRoot('rotate-fail');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const toDir = path.join(root, 'backups');
    fs.mkdirSync(toDir, { recursive: true });
    const oldest = 'etn-backup-0.15.3-20000101-000001.zip';
    for (const stamp of ['20000101-000001', '20000102-000002', '20000103-000003']) {
      fs.writeFileSync(path.join(toDir, `etn-backup-0.15.3-${stamp}.zip`), 'old');
    }
    const originalRm = (fs as unknown as { rmSync: typeof fs.rmSync }).rmSync;
    const restoreRm = patchFs('rmSync', ((file: fs.PathLike, options?: fs.RmOptions) => {
      if (String(file).endsWith(oldest)) {
        const error = new Error(`EBUSY: resource busy or locked, unlink '${String(file)}'`);
        (error as NodeJS.ErrnoException).code = 'EBUSY';
        throw error;
      }
      return originalRm(file, options);
    }) as typeof fs.rmSync);
    let report: Awaited<ReturnType<typeof createBackup>>;
    try {
      report = await createBackup({
        dataDir,
        toDir,
        version: '0.15.3',
        now: new Date(2026, 10, 6, 12, 0, 0),
      });
    } finally {
      restoreRm();
    }
    assert.equal(report.code, 0, report.error ?? '');
    assert.ok(fs.existsSync(path.join(toDir, oldest)), 'неудалённый архив остался');
    assert.equal(
      report.warnings.some((warning) => warning.includes('failed to delete old archive')),
      true,
      report.warnings.join(' | '),
    );
  });

  it('ротация: три новейших своих архива, чужие файлы не трогаются', async () => {
    const root = makeRoot('rotate');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const toDir = path.join(root, 'backups');
    fs.mkdirSync(path.join(toDir, 'manual-copy'), { recursive: true });
    fs.writeFileSync(path.join(toDir, 'notes.txt'), 'foreign');
    fs.writeFileSync(path.join(toDir, 'manual-copy', 'keep.txt'), 'foreign');
    for (const stamp of ['20000101-000001', '20000102-000002', '20000103-000003']) {
      fs.writeFileSync(path.join(toDir, `etn-backup-0.15.3-${stamp}.zip`), 'old');
    }
    const report = await createBackup({
      dataDir,
      toDir,
      version: '0.15.3',
      now: new Date(2026, 10, 6, 12, 0, 0),
    });
    assert.equal(report.code, 0, report.error ?? '');
    const own = backupFiles(toDir).sort();
    assert.equal(own.length, 3, own.join(', '));
    assert.equal(own.includes('etn-backup-0.15.3-20000101-000001.zip'), false);
    assert.ok(own.includes('etn-backup-0.15.3-20000102-000002.zip'));
    assert.ok(own.includes('etn-backup-0.15.3-20000103-000003.zip'));
    assert.ok(own.includes(path.basename(report.archive!)));
    assert.equal(fs.readFileSync(path.join(toDir, 'notes.txt'), 'utf8'), 'foreign');
    assert.equal(fs.readFileSync(path.join(toDir, 'manual-copy', 'keep.txt'), 'utf8'), 'foreign');
  });

  it('текущий архив не удаляется даже при переводе часов назад', async () => {
    const root = makeRoot('clock');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const toDir = path.join(root, 'backups');
    fs.mkdirSync(toDir, { recursive: true });
    for (const stamp of ['29990101-000001', '29990102-000002', '29990103-000003']) {
      fs.writeFileSync(path.join(toDir, `etn-backup-0.15.3-${stamp}.zip`), 'old');
    }
    const report = await createBackup({
      dataDir,
      toDir,
      version: '0.15.3',
      now: new Date(2020, 0, 1, 0, 0, 0),
    });
    assert.equal(report.code, 0, report.error ?? '');
    assert.ok(fs.existsSync(report.archive!), 'текущий архив на месте');
    assert.equal(backupFiles(toDir).length, 3);
    assert.equal(fs.existsSync(path.join(toDir, 'etn-backup-0.15.3-29990103-000003.zip')), true);
    assert.equal(fs.existsSync(path.join(toDir, 'etn-backup-0.15.3-29990101-000001.zip')), false);
  });

  it('совпадение секунды — суффикс -2 перед .zip', async () => {
    const root = makeRoot('same-second');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const toDir = path.join(root, 'backups');
    const now = new Date(2026, 10, 6, 12, 0, 0);
    const first = await createBackup({ dataDir, toDir, version: '0.15.3', now });
    const second = await createBackup({ dataDir, toDir, version: '0.15.3', now });
    assert.equal(first.code, 0, first.error ?? '');
    assert.equal(second.code, 0, second.error ?? '');
    assert.match(path.basename(second.archive!), /-20261106-120000-2\.zip$/);
    assert.equal(backupTimestamp(now), '20261106-120000');
  });
});

describe('db-backup: восстановление', () => {
  it('staged-восстановление возвращает данные и не оставляет временных файлов', async () => {
    const root = makeRoot('restore');
    const dataDir = makeDataDir(root, { system: ['alpha'], networks: ['22222222-3333-4444-5555-666666666666'] });
    const toDir = path.join(root, 'backups');
    const archive = await createBackup({ dataDir, toDir, version: '0.15.3' });
    assert.equal(archive.code, 0, archive.error ?? '');

    const systemDb = path.join(dataDir, '_system.db');
    const networkDb = path.join(dataDir, 'networks', '22222222-3333-4444-5555-666666666666', 'data.db');
    createDatabase(systemDb, ['after-backup']);
    createDatabase(networkDb, ['after-backup-network']);

    const report = await restoreBackup({
      dataDir,
      from: archive.archive!,
      force: true,
      currentVersion: '0.15.3',
    });
    assert.equal(report.code, 0, report.error ?? '');
    assert.equal(report.databases, 2);
    assert.deepEqual(readValues(systemDb), ['alpha']);
    assert.deepEqual(readValues(networkDb), ['network-2222']);
    assert.equal(fs.existsSync(`${systemDb}.restore-tmp`), false);
    assert.equal(fs.existsSync(`${systemDb}.restore-old`), false);
    assert.equal(fs.existsSync(`${networkDb}.restore-tmp`), false);
    assert.equal(fs.existsSync(`${networkDb}.restore-old`), false);
    assert.equal(fs.existsSync(`${systemDb}-wal`), false, 'журнал WAL удалён');
  });

  it('битый ZIP — отказ до изменения цели', async () => {
    const root = makeRoot('bad-zip');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const systemDb = path.join(dataDir, '_system.db');
    const before = fs.readFileSync(systemDb);
    const badZip = path.join(root, 'etn-backup-0.15.3-20261106-120000.zip');
    fs.writeFileSync(badZip, 'this is not a zip');
    await assert.rejects(
      () => restoreBackup({ dataDir, from: badZip, force: true, currentVersion: '0.15.3' }),
      (error: unknown) => error instanceof DbToolError && error.code === 1,
    );
    assert.deepEqual(fs.readFileSync(systemDb), before);
  });

  it('БД в архиве не проходит integrity_check — отказ до изменения цели', async () => {
    const root = makeRoot('bad-db');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const systemDb = path.join(dataDir, '_system.db');
    const before = fs.readFileSync(systemDb);
    const garbage = path.join(root, 'garbage.db');
    fs.writeFileSync(garbage, 'garbage database');
    const zipPath = path.join(root, 'etn-backup-0.15.3-20261106-120000.zip');
    await writeZip(zipPath, [{ filePath: garbage, name: '_system.db' }]);
    await assert.rejects(
      () => restoreBackup({ dataDir, from: zipPath, force: true, currentVersion: '0.15.3' }),
      (error: unknown) => error instanceof DbToolError && error.code === 1,
    );
    assert.deepEqual(fs.readFileSync(systemDb), before);
  });

  it('архив новее текущей версии — отказ с причиной', async () => {
    const root = makeRoot('newer');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const archive = await createBackup({
      dataDir,
      toDir: path.join(root, 'backups'),
      version: '99.0.0',
    });
    assert.equal(archive.code, 0, archive.error ?? '');
    await assert.rejects(
      () =>
        restoreBackup({
          dataDir,
          from: archive.archive!,
          force: true,
          currentVersion: '0.15.3',
        }),
      (error: unknown) =>
        error instanceof DbToolError &&
        error.code === 1 &&
        /newer server version/.test(error.message),
    );
  });

  it('--from — каталог данных: отказ', async () => {
    const root = makeRoot('from-dir');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    await assert.rejects(
      () => restoreBackup({ dataDir, from: dataDir, force: true, currentVersion: '0.15.3' }),
      (error: unknown) => error instanceof DbToolError && error.code === 1,
    );
  });

  it('занятая БД без --force — отказ без изменений (Windows)', { skip: process.platform !== 'win32' }, async () => {
    const root = makeRoot('busy');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const archive = await createBackup({
      dataDir,
      toDir: path.join(root, 'backups'),
      version: '0.15.3',
    });
    assert.equal(archive.code, 0, archive.error ?? '');
    const systemDb = path.join(dataDir, '_system.db');
    const holder = new DatabaseConstructor(systemDb);
    try {
      const before = fs.readFileSync(systemDb);
      await assert.rejects(
        () => restoreBackup({ dataDir, from: archive.archive!, currentVersion: '0.15.3' }),
        (error: unknown) => error instanceof DbToolError && error.code === 1,
      );
      assert.deepEqual(fs.readFileSync(systemDb), before);
    } finally {
      holder.close();
    }
  });

  it('restore удаляет прежние -wal/-shm цели: WAL-хвост не «воскресает»', async () => {
    const root = makeRoot('restore-live-wal');
    const archiveData = makeDataDir(root, { system: ['archived'] });
    const archive = await createBackup({
      dataDir: archiveData,
      toDir: path.join(root, 'backups'),
      version: '0.15.3',
    });
    assert.equal(archive.code, 0, archive.error ?? '');

    // Цель — база в WAL-режиме с незачекпойнченным хвостом: реальные -wal и
    // -shm. Если restore не удалит их, SQLite применит старые кадры к
    // подменённому файлу, и «архивные» данные смешаются с прежними.
    const dataDir = path.join(root, 'target');
    const target = path.join(dataDir, '_system.db');
    const live = path.join(root, 'live.db');
    const writer = openWalSource(live, ['base', 'stale-1', 'stale-2']);
    try {
      assert.ok(fs.existsSync(`${live}-wal`), 'у источника реальный WAL');
      copyLiveDatabase(live, target);
    } finally {
      writer.close();
    }
    assert.ok(fs.existsSync(`${target}-wal`), 'у цели реальный WAL');
    assert.ok(fs.existsSync(`${target}-shm`), 'у цели реальный SHM');

    const report = await restoreBackup({
      dataDir,
      from: archive.archive!,
      force: true,
      currentVersion: '0.15.3',
    });
    assert.equal(report.code, 0, report.error ?? '');
    assert.deepEqual(readValues(target), ['archived'], 'строки из прежнего WAL не воскресли');
    assert.equal(fs.existsSync(`${target}-wal`), false, 'WAL прежней цели удалён');
    assert.equal(fs.existsSync(`${target}-shm`), false, 'SHM прежней цели удалён');
    assert.equal(fs.existsSync(`${target}.restore-tmp`), false);
    assert.equal(fs.existsSync(`${target}.restore-old`), false);
  });

  it('сбой staged-копии не удаляет WAL цели (порядок restore)', async () => {
    const root = makeRoot('restore-order');
    const archiveData = makeDataDir(root, { system: ['archived'] });
    const archive = await createBackup({
      dataDir: archiveData,
      toDir: path.join(root, 'backups'),
      version: '0.15.3',
    });
    assert.equal(archive.code, 0, archive.error ?? '');

    const dataDir = path.join(root, 'target');
    const target = path.join(dataDir, '_system.db');
    const live = path.join(root, 'live.db');
    const writer = openWalSource(live, ['base', 'stale-1']);
    try {
      copyLiveDatabase(live, target);
    } finally {
      writer.close();
    }
    assert.ok(fs.existsSync(`${target}-wal`));

    const originalCopy = (fs as unknown as { copyFileSync: typeof fs.copyFileSync }).copyFileSync;
    const restoreCopy = patchFs('copyFileSync', ((source: fs.PathLike, destination: fs.PathLike, mode?: number) => {
      if (String(destination).endsWith('.restore-tmp')) {
        const error = new Error('ENOSPC: no space left on device, copyfile');
        (error as NodeJS.ErrnoException).code = 'ENOSPC';
        throw error;
      }
      return originalCopy(source, destination, mode);
    }) as typeof fs.copyFileSync);
    try {
      await assert.rejects(
        () => restoreBackup({ dataDir, from: archive.archive!, force: true, currentVersion: '0.15.3' }),
        (error: unknown) => error instanceof DbToolError && error.code === 1,
      );
    } finally {
      restoreCopy();
    }

    // Прежняя база не тронута: main-файл и WAL на месте, staged-копии нет.
    assert.ok(fs.existsSync(target), 'прежняя БД на месте');
    assert.ok(fs.existsSync(`${target}-wal`), 'WAL прежней БД не удалён до копии');
    assert.equal(fs.existsSync(`${target}.restore-tmp`), false, 'недоделанная копия удалена');
    assert.deepEqual(readValues(target), ['base', 'stale-1'], 'прежние данные целы');
  });

  it('посторонняя запись в архиве (_system.db-wal) — отказ (код 1)', async () => {
    const root = makeRoot('extra-entry');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const systemDb = path.join(dataDir, '_system.db');
    const before = fs.readFileSync(systemDb);
    const zipPath = path.join(root, 'etn-backup-0.15.3-20261106-120000.zip');
    await writeZip(zipPath, [
      { filePath: systemDb, name: '_system.db' },
      { filePath: systemDb, name: '_system.db-wal' },
    ]);
    await assert.rejects(
      () => restoreBackup({ dataDir, from: zipPath, force: true, currentVersion: '0.15.3' }),
      (error: unknown) =>
        error instanceof DbToolError &&
        error.code === 1 &&
        /unexpected entry in the archive/.test(error.message),
    );
    assert.deepEqual(fs.readFileSync(systemDb), before);
  });

  it('truncated ZIP — отказ до изменения цели (код 1)', async () => {
    const root = makeRoot('truncated');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const systemDb = path.join(dataDir, '_system.db');
    const before = fs.readFileSync(systemDb);
    const archive = await createBackup({
      dataDir,
      toDir: path.join(root, 'backups'),
      version: '0.15.3',
    });
    assert.equal(archive.code, 0, archive.error ?? '');
    const full = fs.readFileSync(archive.archive!);
    const truncated = path.join(root, 'etn-backup-0.15.3-20261106-120000.zip');
    fs.writeFileSync(truncated, full.subarray(0, Math.max(16, Math.floor(full.length / 2))));
    await assert.rejects(
      () => restoreBackup({ dataDir, from: truncated, force: true, currentVersion: '0.15.3' }),
      (error: unknown) => error instanceof DbToolError && error.code === 1,
    );
    assert.deepEqual(fs.readFileSync(systemDb), before);
  });
});

describe('db-backup: CLI и отчёт', () => {
  it('formatDbToolReport — key=value по строкам', () => {
    const text = formatDbToolReport({
      code: 1,
      archive: null,
      databases: 0,
      bytes: 0,
      error: 'boom\nline',
      warnings: ['first', 'second'],
    });
    assert.match(text, /^code=1\n/);
    assert.match(text, /\narchive=\n/);
    assert.match(text, /\nwarnings=first \| second\n/);
    assert.match(text, /\nerror=boom line\n/);
  });

  it('runBackupCli пишет отчёт и код 0', async () => {
    const root = makeRoot('cli-backup');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const toDir = path.join(root, 'backups');
    const reportPath = path.join(root, 'report.txt');
    const { result, stdout } = await captureConsole(() =>
      runBackupCli(['--to', toDir, '--data-dir', dataDir, '--report-out', reportPath], {}),
    );
    assert.equal(result, 0);
    assert.match(stdout.join('\n'), /Backup created:/);
    const report = fs.readFileSync(reportPath, 'utf8');
    assert.match(report, /^code=0$/m);
    // Версия в имени архива — из package.json; хардкод краснел на каждом bump
    // версии на старте релиза (0.15.4, a89d8760).
    const version = readServerVersion().replaceAll('.', '\\.');
    assert.match(report, new RegExp(`^archive=.*etn-backup-${version}-\\d{8}-\\d{6}\\.zip$`, 'm'));
    assert.match(report, /^databases=1$/m);
  });

  it('runBackupCli без ETN_DATA_DIR — код 1 и отчёт', async () => {
    const root = makeRoot('cli-nodir');
    const reportPath = path.join(root, 'report.txt');
    const { result } = await captureConsole(() =>
      runBackupCli(['--to', path.join(root, 'backups'), '--report-out', reportPath], {}),
    );
    assert.equal(result, 1);
    assert.match(fs.readFileSync(reportPath, 'utf8'), /^code=1$/m);
  });

  it('runRestoreCli восстанавливает архив и пишет отчёт', async () => {
    const root = makeRoot('cli-restore');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const toDir = path.join(root, 'backups');
    const archive = await createBackup({ dataDir, toDir, version: '0.15.3' });
    createDatabase(path.join(dataDir, '_system.db'), ['after']);
    const reportPath = path.join(root, 'restore-report.txt');
    const { result } = await captureConsole(() =>
      runRestoreCli(
        [
          '--from',
          archive.archive!,
          '--data-dir',
          dataDir,
          '--force',
          '--report-out',
          reportPath,
        ],
        {},
      ),
    );
    assert.equal(result, 0);
    assert.deepEqual(readValues(path.join(dataDir, '_system.db')), ['alpha']);
    assert.match(fs.readFileSync(reportPath, 'utf8'), /^code=0$/m);
  });

  it('writeDbToolReport создаёт каталог отчёта', () => {
    const root = makeRoot('report-dir');
    const file = path.join(root, 'nested', 'dir', 'report.txt');
    writeDbToolReport(file, {
      code: 0,
      archive: null,
      databases: 0,
      bytes: 0,
      error: null,
      warnings: [],
    });
    assert.ok(fs.existsSync(file));
  });

  it('сравнение версий', () => {
    assert.equal(compareVersions('0.15.3', '0.15.3'), 0);
    assert.equal(compareVersions('0.16.0', '0.15.9'), 1);
    assert.equal(compareVersions('0.14.9', '0.15.0'), -1);
    assert.equal(compareVersions('unknown', '0.15.3'), null);
  });

  it('runBackupCli с несуществующим каталогом данных — код 2 и отчёт', async () => {
    const root = makeRoot('cli-missing-dir');
    const reportPath = path.join(root, 'report.txt');
    const { result } = await captureConsole(() =>
      runBackupCli(
        [
          '--to',
          path.join(root, 'backups'),
          '--data-dir',
          path.join(root, 'нет такого каталога'),
          '--report-out',
          reportPath,
        ],
        {},
      ),
    );
    assert.equal(result, 2);
    assert.match(fs.readFileSync(reportPath, 'utf8'), /^code=2$/m);
  });

  it('инструмент без node_modules поставки — код 2', () => {
    // Самодостаточность проверяется сторожем guard-db-layer; здесь — реальный
    // запуск из каталога без node_modules: внешние библиотеки не разрешаются,
    // и это внутренняя ошибка (2), а не отказ бэкапа (1).
    const root = makeRoot('no-modules');
    const dataDir = makeDataDir(root, { system: ['alpha'] });
    const toolDir = path.join(root, 'tool');
    fs.mkdirSync(toolDir, { recursive: true });
    const tool = path.join(toolDir, 'db-backup.ts');
    fs.copyFileSync(SOURCE_FILE, tool);
    const result = spawnSync(
      process.execPath,
      [tool, 'backup', '--to', path.join(root, 'backups'), '--data-dir', dataDir],
      { cwd: toolDir, encoding: 'utf8' },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Required module "better-sqlite3" was not found/);
  });

  it('собранный модуль запускается напрямую как инструмент (dist или tsx)', () => {
    // Без сборки проверяем через tsx тот же файл: контракт `--help` и код 0.
    const repoRoot = path.resolve(path.dirname(SOURCE_FILE), '..', '..', '..');
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', SOURCE_FILE, 'backup', '--help'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    assert.match(output, /Usage: etn backup/);
  });
});
