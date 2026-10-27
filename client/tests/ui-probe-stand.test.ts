/**
 * Юнит-тесты чистых функций стенда (`client/scripts/ui-probe-stand.mjs`,
 * задача 38ef87cc): разбор аргументов и извлечение API-key из вывода `etn init`.
 * Импорт модуля не поднимает стенд — точка входа защищена проверкой прямого
 * вызова.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildProbeArgs,
  parseArgs,
  parseInitKey,
  readScenarioLogRules,
  serverLogViolations,
} from '../scripts/ui-probe-stand.mjs';
import { needsDelay } from '../scripts/ui-probe-delay-proxy.mjs';

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

test('parseArgs: --delay-seed-ms (простой и с ошибкой)', () => {
  assert.equal(parseArgs([]).delaySeedMs, 0);
  assert.equal(parseArgs(['--delay-seed-ms', '3000']).delaySeedMs, 3000);
  assert.throws(() => parseArgs(['--delay-seed-ms', 'fast']), /0\.\.600000/);
  assert.throws(() => parseArgs(['--delay-seed-ms']), /требует значения/);
});

// Парное требование «--delay-seed-path требует --delay-seed-ms» проверяет
// `main` стенда (parseArgs значений не связывает) — здесь только разбор значения.
test('parseArgs: --delay-seed-path (пусто по умолчанию, значение, пропущенное значение)', () => {
  assert.equal(parseArgs([]).delaySeedPath, '');
  assert.equal(
    parseArgs(['--delay-seed-ms', '3000', '--delay-seed-path', '/thoughts/resolve']).delaySeedPath,
    '/thoughts/resolve',
  );
  assert.throws(() => parseArgs(['--delay-seed-path']), /требует значения/);
});

test('needsDelay: pathFilter сужает задержку до конкретного ожидания', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const resolve = `/api/v1/networks/${id}/thoughts/resolve`;
  const focus = `/api/v1/networks/${id}/thoughts/x/focus`;
  assert.equal(needsDelay(resolve, id, '/thoughts/resolve'), true);
  assert.equal(needsDelay(focus, id, '/thoughts/resolve'), false);
  // Без фильтра задерживается вся медленная сеть, как раньше.
  assert.equal(needsDelay(focus, id), true);
  assert.equal(needsDelay(focus, id, ''), true);
});

test('needsDelay: медленная сеть — только по сегменту /<networkId>/', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  assert.equal(needsDelay(`/api/v1/networks/${id}/thoughts`, id), true);
  assert.equal(needsDelay(`/api/v1/networks/${id}`, id), true);
  assert.equal(needsDelay('/api/v1/networks/other/thoughts', id), false);
  // Похожий префикс id не считается своей сетью (сегмент целиком).
  assert.equal(needsDelay(`/api/v1/networks/${id}x/thoughts`, id), false);
  assert.equal(needsDelay('/api/v1/health', id), false);
  assert.equal(needsDelay(undefined, id), false);
  assert.equal(needsDelay('/api/v1/networks/x/', ''), false);
});

test('serverLogViolations: absent/present и некорректная регулярка', () => {
  const bad = '{"url":"/api/v1/networks/b/chronicle/query","status":422}';
  const ok = '{"url":"/api/v1/networks/b/chronicle/query","status":200}';
  const log = [bad, ok].join('\n');
  assert.deepEqual(
    serverLogViolations(log, { absent: ['"status":500'], present: ['"status":200'] }),
    [],
  );
  // Нарушение несёт счётчик и первые совпавшие строки: по ним видно, СКОЛЬКО
  // и КАКИЕ запросы нарушили гейт (ошибка 58c55bb9).
  assert.deepEqual(serverLogViolations(log, { absent: ['"status":422'] }), [
    { kind: 'absent', pattern: '"status":422', count: 1, matches: [bad] },
  ]);
  assert.deepEqual(serverLogViolations(log, { present: ['"status":201'] }), [
    { kind: 'present', pattern: '"status":201', count: 0, matches: [] },
  ]);
  assert.throws(() => serverLogViolations(log, { absent: ['['] }), /некорректное регулярное/);
});

test('readScenarioLogRules: правила из сценария; без ключа — null', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-stand-rules-'));
  try {
    const withRules = path.join(dir, 'with.json');
    writeFileSync(
      withRules,
      JSON.stringify({ name: 's', serverLog: { absent: ['a'], present: ['b'] } }),
      'utf8',
    );
    assert.deepEqual(readScenarioLogRules(withRules), { absent: ['a'], present: ['b'] });

    const without = path.join(dir, 'without.json');
    writeFileSync(without, JSON.stringify({ name: 's', steps: [] }), 'utf8');
    assert.equal(readScenarioLogRules(without), null);

    const broken = path.join(dir, 'broken.json');
    writeFileSync(broken, JSON.stringify({ serverLog: { absent: [1] } }), 'utf8');
    assert.throws(() => readScenarioLogRules(broken), /serverLog\.absent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
