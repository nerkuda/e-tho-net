/**
 * Tests for the client file journal `client/src/main/log/client-log.ts`
 * (task f051bf95, 07-client-electron.md §7).
 *
 * Pure Node — no Electron involved. The injectable clock simulates day
 * rollovers; a temp directory stands in for `userData`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ClientLog,
  RETENTION_DAYS,
  resolveLoggingFlag,
  truncateForLog,
} from '../src/main/log/client-log.js';

/** Fresh temp dir acting as `userData`. */
function tmpUserData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'etn-client-log-'));
}

/** Local `YYYY-MM-DD` of a Date (mirrors the journal's bucketing). */
function localDay(d: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Noon of `daysAfter` days from now — noon keeps local-date maths stable. */
function noonAfter(daysAfter: number): Date {
  const base = new Date();
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + daysAfter, 12, 0, 0);
  return d;
}

test('ClientLog: файлы вида client-YYYY-MM-DD.log в <userData>/logs', () => {
  const dir = tmpUserData();
  const log = new ClientLog(dir);
  log.setEnabled(true);
  log.info('test', 'hello');
  const expected = path.join(dir, 'logs', `client-${localDay(new Date())}.log`);
  assert.ok(fs.existsSync(expected), `expected ${expected}`);
  assert.ok(fs.statSync(expected).size > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ClientLog: формат строки ISO LEVEL [компонент] сообщение key=value', () => {
  const dir = tmpUserData();
  const log = new ClientLog(dir);
  log.setEnabled(true);
  log.info('rest', 'request completed', { method: 'GET', attempt: 1, status: 200 });
  const file = path.join(dir, 'logs', `client-${localDay(new Date())}.log`);
  const line = fs.readFileSync(file, 'utf8').trim().split('\n').pop() ?? '';
  assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO \[rest\] request completed method=GET attempt=1 status=200$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ClientLog: ERROR пишется всегда, INFO/WARN/DEBUG только при флаге', () => {
  const dir = tmpUserData();
  const log = new ClientLog(dir);
  log.setEnabled(false);
  log.error('test', 'boom error');
  log.warn('test', 'boom warn');
  log.info('test', 'boom info');
  log.debug('test', 'boom debug');
  const file = path.join(dir, 'logs', `client-${localDay(new Date())}.log`);
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('ERROR [test] boom error'));
  assert.ok(!content.includes('WARN [test] boom warn'));
  assert.ok(!content.includes('INFO [test] boom info'));
  assert.ok(!content.includes('DEBUG [test] boom debug'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ClientLog: суточная ротация по локальной дате', () => {
  const dir = tmpUserData();
  let clock = noonAfter(0);
  const log = new ClientLog(dir, { now: () => clock });
  log.setEnabled(true);
  log.info('test', 'day one');
  clock = noonAfter(1);
  log.info('test', 'day two');
  const day1 = path.join(dir, 'logs', `client-${localDay(noonAfter(0))}.log`);
  const day2 = path.join(dir, 'logs', `client-${localDay(noonAfter(1))}.log`);
  assert.ok(fs.existsSync(day1), 'day-1 file expected');
  assert.ok(fs.existsSync(day2), 'day-2 file expected');
  assert.ok(fs.readFileSync(day1, 'utf8').includes('day one'));
  assert.ok(fs.readFileSync(day2, 'utf8').includes('day two'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ClientLog: очистка старше 30 дней при старте и ротации', () => {
  const dir = tmpUserData();
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  // A file dated now → kept; one 31 days old → removed; one 30 days old → kept.
  const todayName = `client-${localDay(new Date())}.log`;
  const old31Name = `client-${localDay(noonAfter(-31))}.log`;
  const old30Name = `client-${localDay(noonAfter(-RETENTION_DAYS))}.log`;
  fs.writeFileSync(path.join(logsDir, todayName), 'today\n');
  fs.writeFileSync(path.join(logsDir, old31Name), 'ancient\n');
  fs.writeFileSync(path.join(logsDir, old30Name), 'edge\n');
  fs.writeFileSync(path.join(logsDir, 'notes.txt'), 'not a journal file\n');

  let clock = noonAfter(0);
  const log = new ClientLog(dir, { now: () => clock });
  // A write seeds `currentDate`, so the later clock jump counts as a rollover
  // (retention runs on rollover only after the first write, like the server).
  log.setEnabled(true);
  log.info('test', 'day zero');
  const removedOnStart = log.cleanupOldFiles();
  assert.equal(removedOnStart, 1);
  assert.ok(fs.existsSync(path.join(logsDir, todayName)));
  assert.ok(!fs.existsSync(path.join(logsDir, old31Name)));
  assert.ok(fs.existsSync(path.join(logsDir, old30Name)));
  assert.ok(fs.existsSync(path.join(logsDir, 'notes.txt')), 'non-journal files untouched');

  // Rollover also sweeps: after 31 more days the once-edge file becomes stale.
  clock = noonAfter(31);
  log.setEnabled(true);
  log.info('test', 'new day');
  assert.ok(!fs.existsSync(path.join(logsDir, old30Name)), 'edge file expired after rollover');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ClientLog: deleteAll — старые удаляются, текущий усекается', () => {
  const dir = tmpUserData();
  const log = new ClientLog(dir);
  log.setEnabled(true);
  log.info('test', 'current day entry');
  const logsDir = path.join(dir, 'logs');
  const oldName = `client-${localDay(noonAfter(-3))}.log`;
  fs.writeFileSync(path.join(logsDir, oldName), 'old\n');
  const currentName = `client-${localDay(new Date())}.log`;

  const result = log.deleteAll();
  assert.deepEqual(result, { deleted: 1, truncated: 1 });
  assert.ok(!fs.existsSync(path.join(logsDir, oldName)));
  assert.ok(fs.existsSync(path.join(logsDir, currentName)), 'current file kept');
  // The truncation summary lands in the fresh file; the old content is gone.
  const content = fs.readFileSync(path.join(logsDir, currentName), 'utf8');
  assert.ok(!content.includes('current day entry'));
  assert.ok(content.includes('all log files removed'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ClientLog: сбой записи не роняет процесс', () => {
  // `userData` pointing at an existing FILE makes mkdir of <file>/logs fail.
  const fileAsDir = path.join(os.tmpdir(), `etn-blocked-${Date.now()}.txt`);
  fs.writeFileSync(fileAsDir, 'not a directory');
  const log = new ClientLog(fileAsDir);
  log.setEnabled(true);
  assert.doesNotThrow(() => log.error('test', 'write into a broken location'));
  fs.rmSync(fileAsDir, { force: true });
});

test('ClientLog: getState отражает флаг и пути', () => {
  const dir = tmpUserData();
  const log = new ClientLog(dir);
  log.setEnabled(true);
  const state = log.getState();
  assert.equal(state.enabled, true);
  assert.equal(state.logDir, path.join(dir, 'logs'));
  assert.equal(state.logFile, path.join(dir, 'logs', `client-${localDay(new Date())}.log`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ClientLog: ensureCurrentFile создаёт файл при отсутствии', () => {
  const dir = tmpUserData();
  const log = new ClientLog(dir);
  const file = log.ensureCurrentFile();
  assert.ok(fs.existsSync(file));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveLoggingFlag / truncateForLog
// ---------------------------------------------------------------------------

test('resolveLoggingFlag: CLI-переключатель переопределяет сохранённое и фиксируется', () => {
  assert.deepEqual(resolveLoggingFlag(true, 'false'), { enabled: true, source: 'cli', persist: true });
  assert.deepEqual(resolveLoggingFlag(false, 'true'), { enabled: false, source: 'cli', persist: true });
  assert.deepEqual(resolveLoggingFlag(true, null), { enabled: true, source: 'cli', persist: true });
});

test('resolveLoggingFlag: без переключателя восстанавливается сохранённое', () => {
  assert.deepEqual(resolveLoggingFlag(null, 'true'), { enabled: true, source: 'stored', persist: false });
  assert.deepEqual(resolveLoggingFlag(null, 'false'), { enabled: false, source: 'stored', persist: false });
});

test('resolveLoggingFlag: нет ни переключателя, ни значения → выключено, без записи', () => {
  assert.deepEqual(resolveLoggingFlag(null, null), { enabled: false, source: 'default', persist: false });
  // Мусор в значении трактуется как отсутствие (не крашит восстановление).
  assert.deepEqual(resolveLoggingFlag(null, 'yes'), { enabled: false, source: 'default', persist: false });
});

test('truncateForLog: обрезает длинные данные и сжимает объекты', () => {
  assert.equal(truncateForLog(undefined), 'undefined');
  assert.equal(truncateForLog({ a: 1 }), '{"a":1}');
  const long = 'x'.repeat(500);
  const out = truncateForLog(long);
  assert.equal(out.length, 201); // 200 chars + ellipsis
  assert.ok(out.endsWith('…'));
});
