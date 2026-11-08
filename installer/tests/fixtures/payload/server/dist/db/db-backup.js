/**
 * Фикстура etn-db-tool для installer-тестов (задача 3acd9c3c).
 *
 * Настоящий инструмент — server/dist/db/db-backup.js (ZIP, better-sqlite3,
 * integrity_check); его поведение покрыто TS-тестами. Здесь проверяется
 * контракт установщика: аргументы backup/restore, код возврата, отчёт
 * key=value, путь архива в журнале и откат БД из архива этого запуска.
 *
 * «Архив» — JSON-манифест <to>\etn-backup-<версия>-<метка>.zip; копии баз
 * лежат рядом в <архив>.files. Формат фикстуры установщику не важен: он
 * передаёт путь обратно в restore.
 *
 * Режим задаётся файлом <data-dir>\.install\db-tool-mode.txt:
 *   fail-backup | fail-restore — отказ с причиной;
 *   no-report                  — отказ без отчёта (сломанный инструмент);
 *   warn                       — успех с предупреждением;
 *   no-archive                 — успех без архива («бэкапить нечего»).
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const command = argv[0];

function value(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : '';
}

const dataDir = path.resolve(value('--data-dir'));
const reportOut = value('--report-out');

function readMode() {
  try {
    return fs.readFileSync(path.join(dataDir, '.install', 'db-tool-mode.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

function writeReport(code, archive, databases, bytes, error, warnings) {
  if (!reportOut) return;
  const text = [
    `code=${code}`,
    `archive=${archive || ''}`,
    `databases=${databases || 0}`,
    `bytes=${bytes || 0}`,
    `error=${String(error || '').replace(/\r?\n/g, ' ')}`,
    `warnings=${(warnings || []).join(' | ')}`,
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(path.resolve(reportOut)), { recursive: true });
  fs.writeFileSync(reportOut, text, 'utf8');
}

function fail(code, message, withReport) {
  if (withReport) writeReport(code, '', 0, 0, message, []);
  console.error(message);
  process.exit(code);
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function version() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function listDatabases() {
  const files = [];
  const system = path.join(dataDir, '_system.db');
  if (fs.existsSync(system)) files.push({ entry: '_system.db', filePath: system });
  const networks = path.join(dataDir, 'networks');
  if (fs.existsSync(networks)) {
    for (const name of fs.readdirSync(networks)) {
      const filePath = path.join(networks, name, 'data.db');
      if (fs.existsSync(filePath)) {
        files.push({ entry: `networks/${name}/data.db`, filePath });
      }
    }
  }
  return files;
}

function runBackup() {
  const mode = readMode();
  if (mode === 'fail-backup') fail(1, 'fixture backup failure', true);
  if (mode === 'no-report') fail(1, 'fixture backup failure without report', false);
  const toDir = path.resolve(value('--to'));
  const databases = listDatabases();
  if (databases.length === 0 || mode === 'no-archive') {
    writeReport(0, '', 0, 0, '', databases.length === 0 ? ['no databases found'] : []);
    console.log('No databases to back up.');
    process.exit(0);
  }
  fs.mkdirSync(toDir, { recursive: true });
  const base = `etn-backup-${version()}-${stamp()}`;
  let archive = path.join(toDir, `${base}.zip`);
  let suffix = 2;
  while (fs.existsSync(archive)) {
    archive = path.join(toDir, `${base}-${suffix}.zip`);
    suffix += 1;
  }
  const filesDir = `${archive}.files`;
  fs.mkdirSync(filesDir, { recursive: true });
  const manifest = [];
  let bytes = 0;
  for (const database of databases) {
    const destination = path.join(filesDir, database.entry.replace(/\//g, path.sep));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(database.filePath, destination);
    bytes += fs.statSync(destination).size;
    manifest.push({ entry: database.entry });
  }
  fs.writeFileSync(archive, JSON.stringify({ files: manifest }), 'utf8');
  const warnings = mode === 'warn' ? ['fixture warning'] : [];
  writeReport(0, archive, manifest.length, bytes, '', warnings);
  console.log(`Backup created: ${archive}`);
  process.exit(0);
}

function runRestore() {
  const mode = readMode();
  if (mode === 'fail-restore') fail(1, 'fixture restore failure', true);
  const from = path.resolve(value('--from'));
  if (!fs.existsSync(from) || fs.statSync(from).isDirectory()) {
    fail(1, `fixture archive not found: ${from}`, true);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(from, 'utf8'));
  } catch {
    fail(1, 'fixture archive is not readable', true);
  }
  const filesDir = `${from}.files`;
  let count = 0;
  let bytes = 0;
  for (const entry of manifest.files || []) {
    const source = path.join(filesDir, entry.entry.replace(/\//g, path.sep));
    const destination = path.join(dataDir, entry.entry.replace(/\//g, path.sep));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${destination}${suffix}`, { force: true });
    fs.copyFileSync(source, destination);
    bytes += fs.statSync(source).size;
    count += 1;
  }
  writeReport(0, from, count, bytes, '', []);
  console.log(`Restore completed: ${count} database(s)`);
  process.exit(0);
}

if (command === 'backup') {
  runBackup();
} else if (command === 'restore') {
  runRestore();
} else if (command === '--help' || command === 'help' || command === '-h') {
  console.log('fixture etn-db-tool: backup|restore');
  process.exit(0);
} else {
  console.error(`unknown command: ${command || '(none)'}`);
  process.exit(1);
}
