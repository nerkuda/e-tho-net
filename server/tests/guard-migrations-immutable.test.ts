/**
 * Сторож неизменяемости выпущенных миграций (задача 569a4b84, версия 0.8.2).
 *
 * Правило «миграция только дописывается» (грабли 158523bf) держалось на
 * дисциплине: ничто не мешало отредактировать уже отданный файл миграции или
 * вставить новый перед применёнными. Прецедент — ошибка e7dfb36a: ранняя
 * редакция миграций 041/042 оставила двум сетям старый табличный
 * `UNIQUE (…, side, layer_id)`, код писал `ON CONFLICT` по новому набору
 * колонок, SQLite отдавал `SQLITE_ERROR`, привязка свойства к типу падала с 500
 * — и обнаружилось это только на живом полигоне.
 *
 * Манифест `server/migrations/released-hashes.json` фиксирует состав и
 * содержимое миграций последнего релиза (сейчас — v0.8.1; пересобирается
 * скриптом `server/scripts/release-migrations-hash.mjs` при выпуске версии).
 * Сторож проверяет два правила по обоим каталогам — `network/` и `system/`:
 *
 *   1. каждый файл из манифеста существует в дереве и совпадает с ним по
 *      sha256 (переводы строк нормализуются CRLF → LF): правка выпущенного
 *      файла меняет схему баз, где он уже применён, и расходится с базами,
 *      где он ещё не применён;
 *   2. новая миграция не появляется «в середине»: её номер обязан быть больше
 *      максимального номера в манифесте — файлы применяются по алфавиту, и на
 *      базе, где выпущенные файлы уже применены, вставленный перед ними файл
 *      выполнится не в том порядке, что на новой базе.
 *
 * Хеш и разбор номера посчитаны здесь независимо от скрипта пересборки:
 * сторож сверяет манифест, а не доверяет коду, который его собрал.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_ROOT = path.join(SERVER_ROOT, 'migrations');
const MANIFEST_PATH = path.join(MIGRATIONS_ROOT, 'released-hashes.json');

/** Каталоги миграций, которые обязан проверять сторож. */
const DIRECTORIES = ['network', 'system'] as const;

/** Форма манифеста `server/migrations/released-hashes.json`. */
interface ReleasedHashes {
  version: string;
  algorithm: string;
  normalize: string;
  network: Record<string, string>;
  system: Record<string, string>;
}

/** Прочитать манифест и проверить, что он не подменён урезанной формой. */
function readManifest(): ReleasedHashes {
  assert.ok(
    fs.existsSync(MANIFEST_PATH),
    `Нет манифеста выпущенных миграций ${MANIFEST_PATH} — без него сторож ` +
      'неизменяемости миграций не работает.',
  );
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as ReleasedHashes;
  assert.equal(
    manifest.algorithm,
    'sha256',
    'Манифест выпущенных миграций должен быть посчитан алгоритмом sha256.',
  );
  assert.equal(
    manifest.normalize,
    'lf',
    'Манифест выпущенных миграций должен быть посчитан по содержимому с ' +
      'нормализацией переводов строк CRLF → LF.',
  );
  return manifest;
}

/** sha256 содержимого с нормализацией CRLF → LF (как задаёт `.gitattributes`). */
function normalizedSha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Порядковый номер миграции из имени файла (`043_new.sql` → 43); нет номера — `null`. */
function migrationNumber(file: string): number | null {
  const digits = /^(\d+)_/.exec(file)?.[1];
  return digits === undefined ? null : Number(digits);
}

/** Имена `*.sql` каталога миграций — тот же фильтр, что у мигратора. */
function sqlFiles(dir: string): string[] {
  return fs
    .readdirSync(path.join(MIGRATIONS_ROOT, dir))
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

/** Упасть с читаемым перечислением нарушений (или пройти молча). */
function assertNoViolations(rule: string, violations: string[], howToFix: string): void {
  if (violations.length === 0) return;
  assert.fail(
    `${rule}: нарушений ${violations.length}\n` +
      `${violations.map((violation) => `  • ${violation}`).join('\n')}\n\n${howToFix}`,
  );
}

describe('guard: неизменяемость выпущенных миграций', () => {
  it('каждый выпущенный файл на месте и совпадает с манифестом по sha256', () => {
    const manifest = readManifest();
    const violations: string[] = [];

    for (const dir of DIRECTORIES) {
      const released = manifest[dir];
      for (const file of Object.keys(released).sort()) {
        const abs = path.join(MIGRATIONS_ROOT, dir, file);
        const expected = released[file];
        if (!fs.existsSync(abs)) {
          violations.push(
            `${dir}/${file}: файл из манифеста v${manifest.version} отсутствует в дереве — ` +
              'выпущенную миграцию нельзя удалять или переименовывать: базы, где она ' +
              'применена, останутся со своей схемой, а _migrations — с её именем',
          );
          continue;
        }
        const actual = normalizedSha256(fs.readFileSync(abs, 'utf8'));
        if (actual !== expected) {
          violations.push(
            `${dir}/${file}: файл миграции изменён после выпуска v${manifest.version} — ` +
              'изменение схемы оформляй НОВЫМ файлом со следующим номером ' +
              `(грабли 158523bf); ожидался sha256 ${expected}, получен ${actual}`,
          );
        }
      }
    }

    assertNoViolations(
      'Выпущенные миграции изменены или пропали',
      violations,
      'Выпущенный файл миграции неизменяем: он уже применён на живых базах. ' +
        'Нужна правка схемы — заведи новый файл со следующим номером. ' +
        'Манифест пересобирается только при выпуске версии: ' +
        'node server/scripts/release-migrations-hash.mjs --version <X.Y.Z>.',
    );
  });

  it('новые миграции идут только после выпущенных', () => {
    const manifest = readManifest();
    const violations: string[] = [];

    for (const dir of DIRECTORIES) {
      const released = manifest[dir];
      const releasedNumbers = Object.keys(released)
        .map((file) => migrationNumber(file))
        .filter((number): number is number => number !== null);
      const maxReleased = releasedNumbers.length === 0 ? 0 : Math.max(...releasedNumbers);

      for (const file of sqlFiles(dir)) {
        if (file in released) continue;

        const number = migrationNumber(file);
        if (number === null) {
          violations.push(
            `${dir}/${file}: у файла миграции нет числового префикса — порядок ` +
              'применения задаётся алфавитом, и такой файл встанет не туда, ' +
              'куда ты рассчитываешь',
          );
          continue;
        }
        if (number <= maxReleased) {
          violations.push(
            `${dir}/${file}: номер ${number} не больше максимального выпущенного ` +
              `(${maxReleased}, релиз v${manifest.version}) — на базе, где выпущенные ` +
              'файлы уже применены, этот файл выполнится не в том порядке, что на новой ' +
              `базе. Дай файлу номер ${maxReleased + 1} или выше`,
          );
        }
      }
    }

    assertNoViolations(
      'Новые миграции вставлены перед выпущенными',
      violations,
      'Миграции применяются по алфавиту, а _migrations помнит применённое по имени: ' +
        'файл, вставленный перед уже выпущенными, на старой базе выполнится позже ' +
        'других — схема разойдётся. Новый файл всегда получает следующий свободный номер.',
    );
  });
});
