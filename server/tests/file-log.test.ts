/**
 * Unit tests for the file journal (`server/src/log/file-log.ts`,
 * task 1dd33e23 §1): lazy directory creation, the always-on ERROR rule,
 * flag toggling, day rollover, retention cleanup, listing and deletion
 * (truncate the current day, unlink the rest). Pure fs, no native binding.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { FileLog, LOG_FILENAME_RE, RETENTION_DAYS } from '../src/log/file-log.js';

/** Temp dir per test (removed in afterEach). */
let dataDir: string;

function freshDir(): string {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-filelog-'));
  return dataDir;
}

afterEach(() => {
  if (dataDir !== undefined) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined as unknown as string;
  }
});

/** FileLog with a fixed clock (UTC noon of the given day). */
function logAt(isoDate: string): FileLog {
  return new FileLog(freshDir(), { now: () => new Date(`${isoDate}T12:00:00.000Z`) });
}

/** Today's file name for a date string. */
function fileNameOf(date: string): string {
  return `server-${date}.log`;
}

describe('FileLog', () => {
  it('creates the logs directory lazily, not at construction', () => {
    const log = logAt('2026-09-01');
    const logsDir = path.join(dataDir, 'logs');
    assert.equal(fs.existsSync(logsDir), false, 'no directory before the first write');
    log.error('test', 'boom');
    assert.equal(fs.existsSync(logsDir), true, 'directory exists after the first write');
  });

  it('writes ERROR while disabled, but not INFO/WARN/DEBUG', () => {
    const log = logAt('2026-09-01');
    assert.equal(log.enabled, false, 'flag is off at start');
    log.debug('c', 'd');
    log.info('c', 'i');
    log.warn('c', 'w');
    log.error('c', 'real failure');
    const content = log.readFile(fileNameOf('2026-09-01')) ?? '';
    assert.match(content, /ERROR \[c\] real failure/);
    assert.doesNotMatch(content, /INFO|WARN \[c\] w|DEBUG/);
  });

  it('writes all levels once enabled', () => {
    const log = logAt('2026-09-01');
    log.setEnabled(true, 'admin');
    log.info('c', 'hello');
    log.warn('c', 'careful');
    log.error('c', 'boom');
    const content = log.readFile(fileNameOf('2026-09-01')) ?? '';
    assert.match(content, /WARN \[logging\] file logging enabled user=admin enabled=true/);
    assert.match(content, /INFO \[c\] hello/);
    assert.match(content, /WARN \[c\] careful/);
    assert.match(content, /ERROR \[c\] boom/);
  });

  it('journals the disable toggle even though WARN is then filtered', () => {
    const log = logAt('2026-09-01');
    log.setEnabled(true, 'admin');
    log.setEnabled(false, 'admin');
    const content = log.readFile(fileNameOf('2026-09-01')) ?? '';
    assert.match(content, /WARN \[logging\] file logging disabled user=admin enabled=false/);
  });

  it('formats lines as ISO LEVEL [component] message key=value', () => {
    const log = logAt('2026-09-01');
    log.error('http', 'request failed', { method: 'GET', status: 500, duration_ms: 12, slow: false, client_id: null });
    const line = (log.readFile(fileNameOf('2026-09-01')) ?? '').trim();
    assert.match(
      line,
      /^2026-09-01T12:00:00\.000Z ERROR \[http\] request failed method=GET status=500 duration_ms=12 slow=false client_id=null$/,
    );
  });

  it('quotes values containing whitespace', () => {
    const log = logAt('2026-09-01');
    log.error('server', 'message', { path: '/a b' });
    assert.match(log.readFile(fileNameOf('2026-09-01')) ?? "", /path="\/a b"/);
  });

  it('rolls over to a new file at a UTC day change and keeps the old one', () => {
    let current = new Date('2026-09-01T23:59:30.000Z');
    const log = new FileLog(freshDir(), { now: () => current });
    log.error('c', 'day one');
    current = new Date('2026-09-02T00:00:30.000Z');
    log.error('c', 'day two');
    const day1 = log.readFile(fileNameOf('2026-09-01')) ?? '';
    const day2 = log.readFile(fileNameOf('2026-09-02')) ?? '';
    assert.match(day1, /day one/);
    assert.match(day2, /day two/);
  });

  it('removes files older than the retention window on rollover', () => {
    let current = new Date('2026-09-01T10:00:00.000Z');
    const log = new FileLog(freshDir(), { now: () => current });
    log.error('c', 'start');
    const logsDir = path.join(dataDir, 'logs');
    const oldDate = '2026-07-15'; // 48 days before 2026-09-01
    const edgeDate = '2026-08-03'; // 30 days before 2026-09-01 (kept: strictly older than 30d removed)
    fs.writeFileSync(path.join(logsDir, fileNameOf(oldDate)), 'old\n');
    fs.writeFileSync(path.join(logsDir, fileNameOf(edgeDate)), 'edge\n');
    current = new Date('2026-09-02T10:00:00.000Z');
    log.error('c', 'next day'); // triggers rollover + cleanup
    assert.equal(fs.existsSync(path.join(logsDir, fileNameOf(oldDate))), false, 'ancient file removed');
    assert.equal(fs.existsSync(path.join(logsDir, fileNameOf(edgeDate))), true, '30-day-old file kept');
    assert.equal(fs.existsSync(path.join(logsDir, fileNameOf('2026-09-01'))), true, 'recent file kept');
    assert.equal(RETENTION_DAYS, 30);
  });

  it('cleanupOldFiles is exposed for the startup sweep', () => {
    const log = logAt('2026-09-01');
    const logsDir = path.join(dataDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, fileNameOf('2020-01-01')), 'old\n');
    fs.writeFileSync(path.join(logsDir, fileNameOf('2026-08-31')), 'fresh\n');
    const removed = log.cleanupOldFiles();
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(path.join(logsDir, fileNameOf('2020-01-01'))), false);
    assert.equal(fs.existsSync(path.join(logsDir, fileNameOf('2026-08-31'))), true);
  });

  it('lists files oldest-first with size and date', () => {
    const log = logAt('2026-09-03');
    const logsDir = path.join(dataDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, fileNameOf('2026-09-02')), 'ab'); // 2 bytes
    fs.writeFileSync(path.join(logsDir, fileNameOf('2026-09-01')), 'a'); // 1 byte
    log.error('c', 'today entry'); // creates 2026-09-03
    const files = log.listFiles();
    assert.deepEqual(
      files.map((f) => f.name),
      [fileNameOf('2026-09-01'), fileNameOf('2026-09-02'), fileNameOf('2026-09-03')],
    );
    assert.equal(files[0]?.sizeBytes, 1);
    assert.equal(files[1]?.sizeBytes, 2);
    assert.equal(files[2]?.date, '2026-09-03');
  });

  it('listFiles tolerates a missing directory', () => {
    const log = logAt('2026-09-01');
    assert.deepEqual(log.listFiles(), []);
  });

  it('deleteFile: missing → null, past → deleted, current → truncated', () => {
    const log = logAt('2026-09-03');
    const logsDir = path.join(dataDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const pastFile = path.join(logsDir, fileNameOf('2026-09-02'));
    const currentFile = path.join(logsDir, fileNameOf('2026-09-03'));
    fs.writeFileSync(pastFile, 'past');
    fs.writeFileSync(currentFile, 'current');
    assert.equal(log.deleteFile(fileNameOf('2026-09-01')), null);
    assert.equal(log.deleteFile(fileNameOf('2026-09-02'), 'admin'), 'deleted');
    assert.equal(fs.existsSync(pastFile), false);
    assert.equal(log.deleteFile(fileNameOf('2026-09-03'), 'admin'), 'truncated');
    assert.equal(fs.existsSync(currentFile), true, 'current file survives');
    const current = log.readFile(fileNameOf('2026-09-03')) ?? '';
    assert.doesNotMatch(current, /current/, 'old contents gone');
    assert.match(current, /log file removed/);
  });

  it('deleteAll removes past files and truncates the current one', () => {
    const log = logAt('2026-09-03');
    const logsDir = path.join(dataDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, fileNameOf('2026-09-01')), 'a');
    fs.writeFileSync(path.join(logsDir, fileNameOf('2026-09-02')), 'b');
    fs.writeFileSync(path.join(logsDir, fileNameOf('2026-09-03')), 'c');
    const result = log.deleteAll('admin');
    assert.deepEqual(result, { deleted: 2, truncated: 1 });
    assert.equal(fs.existsSync(path.join(logsDir, fileNameOf('2026-09-01'))), false);
    assert.equal(fs.existsSync(path.join(logsDir, fileNameOf('2026-09-02'))), false);
    assert.equal(fs.existsSync(path.join(logsDir, fileNameOf('2026-09-03'))), true);
    const after = fs.readFileSync(path.join(logsDir, fileNameOf('2026-09-03')), 'utf8');
    assert.match(after, /all log files removed/);
    assert.doesNotMatch(after, /^c/);
  });

  it('validates file names strictly (path traversal guard)', () => {
    assert.equal(FileLog.isValidLogFilename('server-2026-09-04.log'), true);
    assert.equal(FileLog.isValidLogFilename('../_system.db'), false);
    assert.equal(FileLog.isValidLogFilename('..%2f..%2f_system.db'), false);
    assert.equal(FileLog.isValidLogFilename('server-2026-9-4.log'), false);
    assert.equal(FileLog.isValidLogFilename('server-2026-09-04.log.exe'), false);
    assert.equal(FileLog.isValidLogFilename('server-2026-09-04.logs'), false);
    assert.equal(FileLog.isValidLogFilename('C:\\etn\\logs\\server-2026-09-04.log'), false);
    assert.equal(LOG_FILENAME_RE.test('server-2026-09-04.log'), true);
  });

  it('never throws on write failures', () => {
    const log = new FileLog(path.join(freshDir(), 'file.log\u0000'), {
      now: () => new Date('2026-09-01T00:00:00Z'),
    });
    // dataDir contains a NUL byte → mkdir fails → swallowed, no throw.
    log.error('c', 'boom');
    assert.equal(log.enabled, false);
  });
});
