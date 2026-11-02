// Фикстура server/dist/cli.js для installer/tests/init-key.ps1.
//
// Заменяет настоящий CLI ETN в тестовой поставке: установщик вызывает её
// теми же аргументами и с тем же окружением, что и `node.exe server\dist\cli.js`.
// Поддерживаются только контракты, которые нужны установщику:
//
//   cli.js init --check
//       код 0 — первый администратор есть, 1 — нет, 2 — состояние не прочитать;
//   cli.js init --username <логин> [--display-name <имя>] --key-out <файл>
//       создаёт «администратора» и пишет ключ в файл (или печатает, если
//       --key-out не задан), как настоящий etn init.
//
// Состояние — <ETN_DATA_DIR>/_system.db (JSON: {"firstUser":true,...}) вместо
// SQLite; журнал вызовов — <ETN_DATA_DIR>/.fixture-invocations.jsonl, по
// строке JSON на вызов: аргументы и ETN_* окружение. Значение ключа в журнал
// не попадает никогда. Маркер <ETN_DATA_DIR>/.fixture-fail заставляет init
// завершиться сбоем (проверка обработки ошибки установщиком).
//
// Задача 686c5d76 (0.15.1). Не поставка.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = process.env.ETN_DATA_DIR || '';
if (!dataDir) {
  console.error('Фикстура: ETN_DATA_DIR не задан');
  process.exit(2);
}

const statePath = path.join(dataDir, '_system.db');
const tracePath = path.join(dataDir, '.fixture-invocations.jsonl');
const failMarker = path.join(dataDir, '.fixture-fail');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
}

function trace(argv) {
  fs.mkdirSync(dataDir, { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    argv,
    env: {
      ETN_DATA_DIR: process.env.ETN_DATA_DIR || '',
      ETN_PORT: process.env.ETN_PORT || '',
      ETN_HOST: process.env.ETN_HOST || '',
    },
  };
  fs.appendFileSync(tracePath, JSON.stringify(entry) + '\n', 'utf8');
}

function valueAfter(argv, flag) {
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const prefixed = argv.find((a) => a.startsWith(flag + '='));
  return prefixed ? prefixed.slice(flag.length + 1) : null;
}

function main(argv) {
  trace(argv);
  const command = argv[0];
  if (command !== 'init') {
    console.error(`Фикстура: неизвестная команда ${command}`);
    return 1;
  }

  if (argv.includes('--check')) {
    const state = readState();
    if (state === null) {
      console.log('Фикстура: _system.db нет — сервер не инициализирован');
      return 1;
    }
    if (state.firstUser === true) {
      console.log('Фикстура: сервер инициализирован (первый администратор есть)');
      return 0;
    }
    console.log('Фикстура: первого администратора нет');
    return 1;
  }

  const username = valueAfter(argv, '--username');
  if (!username) {
    console.error('Фикстура: аргумент --username обязателен');
    return 1;
  }
  const state = readState();
  if (state !== null && state.firstUser === true) {
    console.error('Фикстура: сервер ETN уже инициализирован (первый администратор существует).');
    return 1;
  }
  if (fs.existsSync(failMarker)) {
    console.error('Фикстура: сбой init по маркеру .fixture-fail');
    return 1;
  }

  const key = 'etn_' + crypto.randomBytes(16).toString('hex');
  writeState({ firstUser: true, username, label: 'primary' });
  const keyOut = valueAfter(argv, '--key-out');
  if (keyOut) {
    fs.mkdirSync(path.dirname(keyOut), { recursive: true });
    fs.writeFileSync(keyOut, key + '\n', { encoding: 'utf8', mode: 0o600 });
    console.log('Фикстура: ETN инициализирован; ключ записан в ' + keyOut);
  } else {
    console.log('Фикстура: ETN инициализирован.');
    console.log('Первичный API-key (показан один раз):');
    console.log('  ' + key);
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
