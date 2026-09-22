#!/usr/bin/env node
/**
 * Пересборка манифеста хешей выпущенных миграций
 * (`server/migrations/released-hashes.json`).
 *
 * Шаг процедуры «Публикация релиза на GitHub» (мыслесеть ETN, инструкция
 * 04f08f92): после того как состав релиза зафиксирован, манифест пересобирается
 * по содержимому выпускаемых файлов и коммитится вместе с релизным коммитом —
 * до постановки тега. Проверяет манифест сторож
 * `server/tests/guard-migrations-immutable.test.ts`.
 *
 * Запуск (из корня репозитория):
 *
 *   node server/scripts/release-migrations-hash.mjs
 *       # версия — из server/package.json, содержимое — из рабочего дерева
 *   node server/scripts/release-migrations-hash.mjs --version 0.8.1
 *       # версия задана явно (например, при подготовке релизного коммита)
 *   node server/scripts/release-migrations-hash.mjs --version 0.8.1 --ref v0.8.1
 *       # состав и содержимое — из git-ссылки: пересборка манифеста для уже
 *       # выпущенного тега (рабочее дерево может быть ушедшим вперёд)
 *
 * Хешируется содержимое с нормализацией переводов строк CRLF → LF: в
 * репозитории `.gitattributes` задаёт `* text=auto eol=lf`, но у чужой машины
 * `core.autocrlf` может дать CRLF в рабочей копии — хеш обязан совпасть.
 * Та же нормализация используется в сторожe; логика там написана независимо
 * (сторож сверяет манифест, а не доверяет коду, который его собрал).
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_ROOT = path.join(SERVER_ROOT, 'migrations');
const MANIFEST_PATH = path.join(MIGRATIONS_ROOT, 'released-hashes.json');

/** Каталоги миграций, которые покрывает манифест. */
const DIRECTORIES = ['network', 'system'];

/** Нормализация переводов строк: CRLF → LF (см. `.gitattributes`). */
function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

/** sha256 нормализованного содержимого файла миграции. */
function migrationHash(text) {
  return createHash('sha256').update(normalizeEol(text), 'utf8').digest('hex');
}

/** Разбор аргументов командной строки: `--version X.Y.Z` и `--ref <git-ref>`. */
function parseArgs(argv) {
  const options = { version: null, ref: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') {
      options.version = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--ref') {
      options.ref = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Использование: node server/scripts/release-migrations-hash.mjs ' +
          '[--version X.Y.Z] [--ref <git-ref>]',
      );
      process.exit(0);
    } else {
      console.error(`Неизвестный аргумент: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

/** Версия манифеста: из `--version`, иначе — из `server/package.json`. */
function resolveVersion(explicitVersion) {
  if (explicitVersion !== null && explicitVersion !== '') return explicitVersion;
  const pkg = JSON.parse(readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('Не удалось определить версию выпуска: передай --version X.Y.Z');
  }
  return pkg.version;
}

/** Имена `*.sql` каталога: из git-ссылки (`ref` задан) или из рабочего дерева. */
function listSqlFiles(dir, ref) {
  if (ref === null) {
    return readdirSync(path.join(MIGRATIONS_ROOT, dir))
      .filter((file) => file.endsWith('.sql'))
      .sort();
  }
  const prefix = `server/migrations/${dir}/`;
  return execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', prefix], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix) && line.endsWith('.sql'))
    .map((line) => line.slice(prefix.length))
    .sort();
}

/** Содержимое файла миграции: из git-ссылки (`ref` задан) или из рабочего дерева. */
function readMigration(dir, file, ref) {
  if (ref === null) return readFileSync(path.join(MIGRATIONS_ROOT, dir, file), 'utf8');
  return execFileSync('git', ['show', `${ref}:server/migrations/${dir}/${file}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

const { version: requestedVersion, ref } = parseArgs(process.argv.slice(2));
const version = resolveVersion(requestedVersion);

const manifest = {
  version,
  algorithm: 'sha256',
  normalize: 'lf',
  regenerate: 'node server/scripts/release-migrations-hash.mjs --version <X.Y.Z>',
  note:
    'Манифест хешей миграций, выпущенных в релизе v' +
    version +
    ': по одному sha256 на каждый файл каталогов network/ и system/ ' +
    '(содержимое нормализовано: CRLF → LF, как задаёт .gitattributes). ' +
    'Файл лежит РЯДОМ с каталогами миграций намеренно и не должен внутрь них переезжать: ' +
    'мигратор (server/src/db/migrator.ts) применяет только *.sql из переданного ему каталога ' +
    '(paths.ts: migrations/network, migrations/system), поэтому лежащий на уровень выше JSON ' +
    'не может быть прочитан как миграция. ' +
    'Источник истины сторожа server/tests/guard-migrations-immutable.test.ts: правка любого ' +
    'перечисленного здесь файла или новая миграция с номером не больше максимального — красный ' +
    'тест. Обновляется при выпуске версии: после фиксации состава релиза пересобери манифест ' +
    '(поле regenerate) и закоммить его вместе с релизным коммитом — до тега v' +
    version +
    '.',
};

for (const dir of DIRECTORIES) {
  const hashes = {};
  for (const file of listSqlFiles(dir, ref)) {
    hashes[file] = migrationHash(readMigration(dir, file, ref));
  }
  manifest[dir] = hashes;
}

writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const source = ref === null ? 'рабочее дерево' : `git-ссылка ${ref}`;
console.log(
  `Обновлён server/migrations/released-hashes.json: v${version}, ` +
    `network — ${Object.keys(manifest.network).length} файлов, ` +
    `system — ${Object.keys(manifest.system).length} файлов (источник: ${source}).`,
);
