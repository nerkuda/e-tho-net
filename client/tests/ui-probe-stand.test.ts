/**
 * Юнит-тесты чистых функций стенда (`client/scripts/ui-probe-stand.mjs`,
 * задача 38ef87cc): разбор аргументов и извлечение API-key из вывода `etn init`.
 * Импорт модуля не поднимает стенд — точка входа защищена проверкой прямого
 * вызова.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { parseArgs, parseInitKey, buildProbeArgs } from '../scripts/ui-probe-stand.mjs';

test('parseArgs: значения по умолчанию', () => {
  const opts = parseArgs([]);
  assert.equal(opts.scenario, null);
  assert.equal(opts.dataFrom, null);
  assert.equal(opts.serverPort, 0);
  assert.equal(opts.cdpPort, 0);
  assert.equal(opts.seed, true);
  assert.equal(opts.seedName, 'GUI-стенд');
  assert.equal(opts.keep, false);
  assert.equal(opts.help, false);
});

test('parseArgs: сценарий, порты, флаги, сид', () => {
  const opts = parseArgs([
    '--scenario',
    's.json',
    '--server-port',
    '4405',
    '--cdp-port',
    '9340',
    '--no-seed',
    '--seed-name',
    'Проба',
    '--seed-title',
    'Мысль',
    '--seed-comment',
    'текст',
    '--keep',
  ]);
  assert.equal(opts.scenario, path.resolve('s.json'));
  assert.equal(opts.serverPort, 4405);
  assert.equal(opts.cdpPort, 9340);
  assert.equal(opts.seed, false);
  assert.equal(opts.seedName, 'Проба');
  assert.equal(opts.seedTitle, 'Мысль');
  assert.equal(opts.seedComment, 'текст');
  assert.equal(opts.keep, true);
});

test('parseArgs: --data-from и --api-key; ошибки на неизвестном и порте', () => {
  const opts = parseArgs(['--data-from', 'dir', '--api-key', 'etn_x']);
  assert.equal(opts.apiKey, 'etn_x');
  assert.throws(() => parseArgs(['--bogus']), /неизвестный аргумент/);
  assert.throws(() => parseArgs(['--server-port', '70000']), /65535/);
  assert.throws(() => parseArgs(['--scenario']), /требует значения/);
});

test('parseInitKey: извлекает ключ etn_… из вывода init', () => {
  const log = 'ETN инициализирован.\n\nПервичный API-key:\n  etn_0123456789abcdef0123456789abcdef\n';
  assert.equal(parseInitKey(log), 'etn_0123456789abcdef0123456789abcdef');
  assert.throws(() => parseInitKey('нет ключа'), /не удалось извлечь/);
});

test('buildProbeArgs: со сценарием содержит --scenario и подстановки id', () => {
  const opts = parseArgs(['--scenario', 's.json', '--out', 'out']);
  const seed = {
    networkId: 'n1',
    networkName: 'Сеть',
    homeId: 'h1',
    thoughtId: 't1',
  };
  const args = buildProbeArgs(
    opts,
    { cdp: 9455, serverRoot: 'http://127.0.0.1:4455', apiBase: 'http://127.0.0.1:4455/api/v1' },
    seed,
    'etn_key',
  );
  assert.ok(args.includes('--scenario'));
  assert.equal(args[args.indexOf('--scenario') + 1], opts.scenario);
  assert.ok(args.includes('--var'));
  assert.ok(args.includes('thoughtId=t1'));
  assert.equal(args.includes('--api-key') ? args[args.indexOf('--api-key') + 1] : null, 'etn_key');
  assert.equal(args.some((arg) => arg === null || arg === undefined), false);
});

test('buildProbeArgs: интерактив (scenario=null) без --scenario и без null-аргументов', () => {
  const opts = parseArgs([]);
  const args = buildProbeArgs(
    opts,
    { cdp: 9455, serverRoot: 'http://127.0.0.1:4455', apiBase: 'http://127.0.0.1:4455/api/v1' },
    null,
    'etn_key',
  );
  assert.equal(args.includes('--scenario'), false);
  assert.equal(args.some((arg) => arg === null || arg === undefined), false);
  // Печатная команда строится из тех же аргументов — «.includes» по null не падает.
  assert.doesNotThrow(() => args.map((arg) => arg.includes(' ')));
});
