/**
 * Композиция и проверка MCPB-бандла (задача d1feff33, ADR d17c3a29 п. 5).
 *
 * Бандл — тот же стейджинг, что npm-пакет (`lib/server-staging.mjs`), плюс
 * `manifest.json` формата MCPB 0.3 и маркер целевой платформы
 * `etn-mcp-target.json` в корне. Модуль не печатает шаги и не решает, что
 * собирать: это забота `build-mcpb.mjs`; здесь — операции над деревом бандла,
 * чтобы их можно было проверить тестом без полной сборки.
 *
 * Почему zip пишется своим кодом, а не библиотекой и не системной утилитой:
 * `.mcpb` — обычный zip, но лишняя зависимость релизного конвейера
 * (`archiver` и т.п.) потянула бы дерево пакетов в каждый матречный job;
 * `System.IO.Compression` на .NET Framework пишет в записях разделитель `\`
 * (архив ломается у клиента), а `zip` есть не на каждой машине. Свой писатель
 * ещё и воспроизводим: фиксированная дата записей — одинаковый SHA-256 у одной
 * и той же сборки. `unzipArchive` для проверки архива использует системный
 * распаковщик — это как раз то, что делает клиент.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/** Идентификатор нашего маркера (сверяется сторожем с `src/mcpb/manifest.ts`). */
export const MCPB_BUNDLE_TARGET_KIND = 'etn-mcp-bundle';

/** Ошибка шага сборки бандла. */
export function fail(message) {
  throw new Error(message);
}

/** Экранирование строки для PowerShell в одинарных кавычках. */
function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Запустить внешнюю команду и упасть с понятным текстом при ошибке. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error !== undefined) {
    fail(
      `${command} не запустился: ${result.error.message}. ` +
        (command === 'zip' || command === 'unzip'
          ? 'Для сборки MCPB на POSIX нужны утилиты zip и unzip.'
          : ''),
    );
  }
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} завершился с кодом ${result.status}: ` +
        `${(result.stdout ?? '').slice(0, 2000)}${(result.stderr ?? '').slice(0, 2000)}`,
    );
  }
  return result.stdout ?? '';
}

/**
 * Собрать zip-архив каталога.
 *
 * Пишем zip сами, а не системным инструментом: `System.IO.Compression`
 * на .NET Framework пишет разделители `\` (архив ломается у клиента), а
 * `zip`/`unzip` есть не везде. Плюс фиксированная дата записей (эпоха DOS) —
 * архив одной и той же сборки получается одинаковым, и SHA-256 в `server.json`
 * не «прыгает» без изменений содержимого.
 *
 * @param {string} dir - корень бандла.
 * @param {string} outFile - путь к `.mcpb`.
 */
export function zipDirectory(dir, outFile) {
  const files = [];
  collectFiles(dir, '', files);

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, absolute } of files) {
    const raw = readFileSync(absolute);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8); // flags
    entry.writeUInt16LE(useDeflate ? 8 : 0, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk
    entry.writeUInt16LE(0, 36); // internal attrs
    entry.writeUInt32LE(0, 38); // external attrs
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, Buffer.concat([...chunks, ...central, end]));
  return files.length;
}

/** Дата записей архива: 1 января 1980 (эпоха DOS) — архив воспроизводим. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0;

/** Собрать файлы каталога в порядке обхода (имена — через `/`). */
function collectFiles(root, prefix, out) {
  const entries = readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) collectFiles(root, relative, out);
    else out.push({ name: relative, absolute: path.join(root, relative) });
  }
}

/**
 * Распаковать zip в каталог.
 *
 * @param {string} file - архив.
 * @param {string} destDir - целевой каталог (создаётся).
 */
export function unzipArchive(file, destDir) {
  mkdirSync(path.dirname(destDir), { recursive: true });
  if (process.platform === 'win32') {
    run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
        `[System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(file)}, ${psQuote(destDir)})`,
    ]);
    return;
  }
  mkdirSync(destDir, { recursive: true });
  run('unzip', ['-q', file, '-d', destDir]);
}

/**
 * Записать манифест и маркер целевой платформы в корень бандла.
 *
 * Маркер пишется вместе с манифестом: забыть один из двух — значит получить
 * бандл, который на чужой ОС упадёт стеком загрузки `better-sqlite3`.
 *
 * @param {string} dir - корень бандла.
 * @param {{ manifest: object, marker: object }} input - из `src/mcpb/manifest.ts`.
 * @returns {{ manifestFile: string, markerFile: string }}
 */
export function writeBundleMetadata(dir, { manifest, marker }) {
  const manifestFile = path.join(dir, 'manifest.json');
  const markerFile = path.join(dir, 'etn-mcp-target.json');
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  return { manifestFile, markerFile };
}

/**
 * Проверить дерево бандла: обязательные файлы, манифест, маркер и нативный
 * модуль `better-sqlite3` ровно той версии, что закреплена в AGENTS.md.
 *
 * @param {string} dir - корень бандла.
 * @param {{ version: string, target: string, betterSqlite3Version: string }} input
 * @throws {Error} при первом несоответствии.
 */
export function assertBundleContents(dir, { version, target, betterSqlite3Version }) {
  const required = [
    'manifest.json',
    'etn-mcp-target.json',
    'package.json',
    'dist/index.js',
    'dist/cli.js',
    'dist/bin/etn-mcp.js',
    'node_modules/@etn/shared/dist/index.js',
    'node_modules/@etn/markdown/dist/index.js',
    'node_modules/better-sqlite3/package.json',
  ];
  for (const name of required) {
    if (!existsSync(path.join(dir, ...name.split('/')))) {
      fail(`в бандле нет обязательного файла: ${name}`);
    }
  }
  for (const database of ['system', 'network']) {
    const migrations = path.join(dir, 'migrations', database);
    const count = existsSync(migrations)
      ? readdirSync(migrations).filter((name) => name.endsWith('.sql')).length
      : 0;
    if (count < 1) fail(`в бандле нет migrations/${database}/*.sql`);
  }

  const nativeBinary = path.join(
    dir,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  if (!existsSync(nativeBinary)) {
    fail('в бандле нет better-sqlite3/build/Release/better_sqlite3.node');
  }
  const sqliteVersion = JSON.parse(
    readFileSync(path.join(dir, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8'),
  ).version;
  if (sqliteVersion !== betterSqlite3Version) {
    fail(`в бандле better-sqlite3 ${sqliteVersion}, ожидалась ${betterSqlite3Version}`);
  }

  const marker = JSON.parse(readFileSync(path.join(dir, 'etn-mcp-target.json'), 'utf8'));
  if (marker.kind !== MCPB_BUNDLE_TARGET_KIND) {
    fail(`чужой kind маркера бандла: ${String(marker.kind)}`);
  }
  if (marker.target !== target) {
    fail(`маркер бандла указывает ${String(marker.target)}, сборка целилась в ${target}`);
  }
  if (marker.version !== version) {
    fail(`маркер бандла указывает версию ${String(marker.version)}, ожидалась ${version}`);
  }

  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== '0.3') {
    fail(`manifest_version ${String(manifest.manifest_version)}, ожидалась 0.3`);
  }
  if (manifest.version !== version) {
    fail(`manifest.json указывает версию ${String(manifest.version)}, ожидалась ${version}`);
  }
  if (manifest.server?.entry_point !== 'dist/bin/etn-mcp.js') {
    fail(`manifest.json: неожиданный entry_point ${String(manifest.server?.entry_point)}`);
  }
  if (!(manifest.compatibility?.platforms ?? []).includes(target.split('-')[0])) {
    fail(`manifest.json: compatibility.platforms не содержит ${target.split('-')[0]}`);
  }
  return manifest;
}

/**
 * Окружение «чистой машины» для smoke-теста бандла: без `ETN_*`, с пустыми
 * каталогами ОС (личный каталог пакета создаётся заново).
 *
 * @param {string} home - подставной домашний каталог.
 * @param {Record<string, string>} [extra] - добавочные переменные.
 */
export function cleanEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('ETN_')) delete env[name];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = path.join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  env.ETN_LOG_LEVEL = 'error';
  return { ...env, ...extra };
}
