/**
 * Локальные словари проверки орфографии (задача 68402877, 0.16.1).
 *
 * Chromium ищет Hunspell-словари в `<userData>/Dictionaries` по имени
 * `<language-region><version>.bdic`; если файла нет — идёт за ним на
 * redirector.gvt1.com. В рабочей сети TLS до этого хоста рвётся, поэтому
 * словари едут в поставке, а main копирует их в профиль при старте.
 *
 * Здесь проверяется чистая логика без Electron:
 *  - имена файлов — ровно те, что ждёт Chromium (подтверждены netlog-экспериментом);
 *  - пути источника в dev и в упаковке;
 *  - идемпотентное копирование (чистый профиль / уже есть / битый размер /
 *    нет ресурсов / каталог профиля не создаётся);
 *  - выбор языков: включаются только при наличии ВСЕХ словарей (иначе Chromium
 *    пошёл бы в сеть) и только из доступных сборке локалей;
 *  - связка с main: `configureSpellCheckerLanguages` копирует словари до
 *    `setSpellCheckerLanguages`;
 *  - реальные ресурсы и тексты лицензий в поставке.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DISABLED_DICTIONARY_DOWNLOAD_URL,
  PROFILE_DICTIONARIES_DIR,
  RESOURCE_DICTIONARIES_DIR,
  SPELLCHECK_DICTIONARIES,
  dictionariesSourceDir,
  ensureSpellcheckDictionaries,
  profileDictionariesDir,
  resolveSpellcheckLanguages,
} from '../src/main/spellcheck-dictionaries.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_RESOURCES = path.join(CLIENT_ROOT, 'resources', 'dictionaries');
const PUBLIC_LICENSES = path.join(CLIENT_ROOT, 'src', 'renderer', 'public', 'licenses');
const MAIN_INDEX = path.join(CLIENT_ROOT, 'src', 'main', 'index.ts');

/** Размеры словарей из поставки — фиксируем, чтобы подмена файла была видна. */
const EXPECTED_SIZES: Record<string, number> = {
  'ru-RU-3-0.bdic': 2309618,
  'en-US-10-1.bdic': 451968,
};

/** Временный каталог: профиль или каталог ресурсов для одного теста. */
function withTempDir<T>(prefix: string, run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Синтетический каталог ресурсов с файлами ожидаемых имён. */
function makeResourceDir(root: string, contents: Record<string, Buffer>): string {
  const dir = path.join(root, 'resources');
  fs.mkdirSync(dir, { recursive: true });
  for (const dict of SPELLCHECK_DICTIONARIES) {
    const body = contents[dict.fileName];
    if (body !== undefined) fs.writeFileSync(path.join(dir, dict.fileName), body);
  }
  return dir;
}

/** Все имена файлов словарей, которые ждёт Chromium. */
const DICTIONARY_NAMES = SPELLCHECK_DICTIONARIES.map((dict) => dict.fileName);

describe('spellcheck-dictionaries: имена и пути', () => {
  it('имена .bdic — ровно те, что ищет Chromium, языки — ru и en-US', () => {
    // GetVersionedFileName: `<language-region><version>.bdic`; для Electron 31
    // (Chromium 126) это ru-RU-3-0 и en-US-10-1 (подтверждено netlog-ом).
    assert.deepEqual(SPELLCHECK_DICTIONARIES, [
      { language: 'ru', fileName: 'ru-RU-3-0.bdic' },
      { language: 'en-US', fileName: 'en-US-10-1.bdic' },
    ]);
    assert.equal(PROFILE_DICTIONARIES_DIR, 'Dictionaries');
    assert.equal(RESOURCE_DICTIONARIES_DIR, 'dictionaries');
  });

  it('источник словарей: dev — resources репозитория, упаковка — resourcesPath', () => {
    assert.equal(
      dictionariesSourceDir(
        'C:\\repo\\client',
        false,
        'C:\\repo\\client\\release\\win-unpacked\\resources',
      ),
      path.join('C:\\repo\\client', 'resources', 'dictionaries'),
    );
    assert.equal(
      dictionariesSourceDir('C:\\repo\\client', true, 'C:\\app\\resources'),
      path.join('C:\\app\\resources', 'dictionaries'),
    );
  });

  it('каталог словарей профиля — <userData>/Dictionaries', () => {
    assert.equal(
      profileDictionariesDir('C:\\profile'),
      path.join('C:\\profile', PROFILE_DICTIONARIES_DIR),
    );
  });

  it('адрес-заглушка загрузчика не выходит в сеть', () => {
    const url = new URL(DISABLED_DICTIONARY_DOWNLOAD_URL);
    assert.equal(url.hostname, '127.0.0.1');
  });
});

describe('spellcheck-dictionaries: копирование в профиль', () => {
  it('чистый профиль: оба словаря копируются, языки готовы', () => {
    withTempDir('etn-spellcheck-', (root) => {
      const ru = Buffer.from('ru-dictionary-bytes');
      const en = Buffer.from('en-dictionary-bytes!');
      const source = makeResourceDir(root, {
        'ru-RU-3-0.bdic': ru,
        'en-US-10-1.bdic': en,
      });
      const target = path.join(root, 'profile', 'Dictionaries');

      const result = ensureSpellcheckDictionaries(source, target);

      assert.equal(result.sourceDir, source);
      assert.equal(result.targetDir, target);
      assert.deepEqual(
        result.files.map((file) => [file.fileName, file.status]),
        [
          ['ru-RU-3-0.bdic', 'copied'],
          ['en-US-10-1.bdic', 'copied'],
        ],
      );
      assert.deepEqual(result.readyLanguages, ['ru', 'en-US']);
      assert.deepEqual(fs.readFileSync(path.join(target, 'ru-RU-3-0.bdic')), ru);
      assert.deepEqual(fs.readFileSync(path.join(target, 'en-US-10-1.bdic')), en);
      // Временных файлов после атомарного копирования не остаётся.
      assert.deepEqual(fs.readdirSync(target).sort(), [...DICTIONARY_NAMES].sort());
    });
  });

  it('словари уже на месте: повторный запуск не перезаписывает файлы', () => {
    withTempDir('etn-spellcheck-', (root) => {
      const source = makeResourceDir(root, {
        'ru-RU-3-0.bdic': Buffer.from('same-ru'),
        'en-US-10-1.bdic': Buffer.from('same-en'),
      });
      const target = path.join(root, 'profile', 'Dictionaries');
      ensureSpellcheckDictionaries(source, target);

      // Метка времени в прошлом: перезапись через rename её бы сбросила.
      const stamp = new Date('2020-01-02T03:04:05Z');
      for (const name of DICTIONARY_NAMES) fs.utimesSync(path.join(target, name), stamp, stamp);

      const result = ensureSpellcheckDictionaries(source, target);

      assert.deepEqual(
        result.files.map((file) => file.status),
        ['unchanged', 'unchanged'],
      );
      assert.deepEqual(result.readyLanguages, ['ru', 'en-US']);
      for (const name of DICTIONARY_NAMES) {
        assert.equal(
          fs.statSync(path.join(target, name)).mtimeMs,
          stamp.getTime(),
          `${name} перезаписан, хотя содержимое совпадает`,
        );
      }
    });
  });

  it('битый файл в профиле (другой размер): перезаписывается ресурсом', () => {
    withTempDir('etn-spellcheck-', (root) => {
      const source = makeResourceDir(root, {
        'ru-RU-3-0.bdic': Buffer.from('correct-ru-dictionary'),
        'en-US-10-1.bdic': Buffer.from('correct-en'),
      });
      const target = path.join(root, 'profile', 'Dictionaries');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'ru-RU-3-0.bdic'), Buffer.from('trunc'));
      fs.writeFileSync(path.join(target, 'en-US-10-1.bdic'), Buffer.from('correct-en'));

      const result = ensureSpellcheckDictionaries(source, target);

      assert.deepEqual(
        result.files.map((file) => [file.fileName, file.status]),
        [
          ['ru-RU-3-0.bdic', 'copied'],
          ['en-US-10-1.bdic', 'unchanged'],
        ],
      );
      assert.equal(
        fs.readFileSync(path.join(target, 'ru-RU-3-0.bdic'), 'utf8'),
        'correct-ru-dictionary',
      );
    });
  });

  it('тот же размер, другое содержимое: сравнивается хэш, файл перезаписывается', () => {
    withTempDir('etn-spellcheck-', (root) => {
      const source = makeResourceDir(root, {
        'ru-RU-3-0.bdic': Buffer.from('aaaa'),
        'en-US-10-1.bdic': Buffer.from('bbbb'),
      });
      const target = path.join(root, 'profile', 'Dictionaries');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'ru-RU-3-0.bdic'), Buffer.from('zzzz'));
      fs.writeFileSync(path.join(target, 'en-US-10-1.bdic'), Buffer.from('bbbb'));

      const result = ensureSpellcheckDictionaries(source, target);

      assert.deepEqual(
        result.files.map((file) => file.status),
        ['copied', 'unchanged'],
      );
      assert.equal(fs.readFileSync(path.join(target, 'ru-RU-3-0.bdic'), 'utf8'), 'aaaa');
    });
  });

  it('нет ресурсов: не бросает, словари не готовы, профиль остаётся пустым', () => {
    withTempDir('etn-spellcheck-', (root) => {
      const source = path.join(root, 'missing-resources');
      const target = path.join(root, 'profile', 'Dictionaries');

      const result = ensureSpellcheckDictionaries(source, target);

      assert.deepEqual(
        result.files.map((file) => [file.status, typeof file.error]),
        [
          ['failed', 'string'],
          ['failed', 'string'],
        ],
      );
      assert.deepEqual(result.readyLanguages, []);
      assert.deepEqual(fs.readdirSync(target), []);
    });
  });

  it('пустой файл ресурса считается битым и не попадает в профиль', () => {
    withTempDir('etn-spellcheck-', (root) => {
      const source = makeResourceDir(root, {
        'ru-RU-3-0.bdic': Buffer.alloc(0),
        'en-US-10-1.bdic': Buffer.from('ok-en'),
      });
      const target = path.join(root, 'profile', 'Dictionaries');

      const result = ensureSpellcheckDictionaries(source, target);

      assert.deepEqual(
        result.files.map((file) => [file.fileName, file.status]),
        [
          ['ru-RU-3-0.bdic', 'failed'],
          ['en-US-10-1.bdic', 'copied'],
        ],
      );
      assert.deepEqual(result.readyLanguages, ['en-US']);
      assert.equal(fs.existsSync(path.join(target, 'ru-RU-3-0.bdic')), false);
    });
  });

  it('каталог профиля не создаётся: обе записи failed с причиной, старт не падает', () => {
    withTempDir('etn-spellcheck-', (root) => {
      const source = makeResourceDir(root, {
        'ru-RU-3-0.bdic': Buffer.from('ru'),
        'en-US-10-1.bdic': Buffer.from('en'),
      });
      // Родитель «каталога» — файл: mkdirSync упадёт с ENOTDIR.
      const blocker = path.join(root, 'blocker');
      fs.writeFileSync(blocker, 'not a directory');

      const result = ensureSpellcheckDictionaries(source, path.join(blocker, 'Dictionaries'));

      assert.equal(result.files.length, SPELLCHECK_DICTIONARIES.length);
      for (const file of result.files) {
        assert.equal(file.status, 'failed');
        assert.ok((file.error ?? '').length > 0, `${file.fileName}: нет причины отказа`);
      }
      assert.deepEqual(result.readyLanguages, []);
    });
  });
});

describe('spellcheck-dictionaries: выбор языков', () => {
  const available = ['en-US', 'ru'];

  it('оба словаря готовы и обе локали есть в сборке — включаем ru и en-US', () => {
    assert.deepEqual(resolveSpellcheckLanguages(available, ['ru', 'en-US']), ['ru', 'en-US']);
  });

  it('нет хотя бы одного словаря — языки не включаем (иначе Chromium пойдёт в сеть)', () => {
    assert.deepEqual(resolveSpellcheckLanguages(available, ['ru']), []);
    assert.deepEqual(resolveSpellcheckLanguages(available, ['en-US']), []);
    assert.deepEqual(resolveSpellcheckLanguages(available, []), []);
  });

  it('словари готовы, но сборка Chromium не знает локали — её отбрасываем', () => {
    assert.deepEqual(resolveSpellcheckLanguages(['en-US'], ['ru', 'en-US']), ['en-US']);
    assert.deepEqual(resolveSpellcheckLanguages([], ['ru', 'en-US']), []);
  });
});

describe('spellcheck-dictionaries: связка с main и поставка', () => {
  it('configureSpellCheckerLanguages копирует словари до включения языков', () => {
    const source = fs.readFileSync(MAIN_INDEX, 'utf8');
    const start = source.indexOf('function configureSpellCheckerLanguages(): void {');
    assert.ok(start >= 0, 'в main/index.ts нет configureSpellCheckerLanguages');
    const end = source.indexOf('\n}', start);
    const body = source.slice(start, end);

    const copyAt = body.indexOf('ensureSpellcheckDictionaries(');
    const languagesAt = body.indexOf('setSpellCheckerLanguages(');
    assert.ok(copyAt >= 0, 'функция не копирует словари в профиль');
    assert.ok(languagesAt > copyAt, 'языки включаются раньше копирования словарей');
    assert.match(
      body,
      /dictionariesSourceDir\(\s*app\.getAppPath\(\),\s*app\.isPackaged,\s*process\.resourcesPath,?\s*\)/,
      'источник словарей должен учитывать dev/упаковку',
    );
    assert.match(
      body,
      /profileDictionariesDir\(app\.getPath\('userData'\)\)/,
      'словари копируются не в <userData>/Dictionaries',
    );
    assert.match(
      body,
      /resolveSpellcheckLanguages\(/,
      'языки выбираются не через resolveSpellcheckLanguages',
    );
  });

  it('в resources/dictionaries лежат оба словаря ожидаемого размера и лицензии', () => {
    assert.deepEqual(fs.readdirSync(REAL_RESOURCES).sort(), [
      'LICENSE-en-US.txt',
      'LICENSE-ru-RU.txt',
      'en-US-10-1.bdic',
      'ru-RU-3-0.bdic',
    ]);
    for (const [name, size] of Object.entries(EXPECTED_SIZES)) {
      assert.equal(
        fs.statSync(path.join(REAL_RESOURCES, name)).size,
        size,
        `${name}: размер не совпадает с исходным словарём Chromium`,
      );
    }
  });

  it('тексты лицензий поставки полные и с правообладателями', () => {
    const ru = fs.readFileSync(path.join(REAL_RESOURCES, 'LICENSE-ru-RU.txt'), 'utf8');
    const en = fs.readFileSync(path.join(REAL_RESOURCES, 'LICENSE-en-US.txt'), 'utf8');
    assert.match(ru, /Copyright \(c\) 1997-2008, Alexander I\. Lebedev/);
    assert.match(ru, /Redistribution and use in source and binary forms/);
    assert.match(en, /Copyright 2000-2018 by Kevin Atkinson/);
    assert.match(en, /Geoff Kuenning/);
    assert.match(en, /AS IS/);

    // Копии для notices и диалога «О программе» — байт в байт те же тексты.
    for (const [from, to] of [
      ['LICENSE-ru-RU.txt', path.join(PUBLIC_LICENSES, 'dictionaries', 'ru-RU.txt')],
      ['LICENSE-en-US.txt', path.join(PUBLIC_LICENSES, 'dictionaries', 'en-US.txt')],
    ] as const) {
      assert.deepEqual(
        fs.readFileSync(to),
        fs.readFileSync(path.join(REAL_RESOURCES, from)),
        `${to}: текст лицензии разошёлся с ресурсом поставки`,
      );
    }
  });

  it('каталог словарей едет в упаковку через extraResources', () => {
    const builder = fs.readFileSync(path.join(CLIENT_ROOT, 'electron-builder.yml'), 'utf8');
    assert.match(
      builder,
      /- from: resources\/dictionaries\s*\n\s*to: dictionaries/,
      'electron-builder.yml не кладёт resources/dictionaries в <resources>/dictionaries',
    );
  });
});
