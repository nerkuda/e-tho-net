/**
 * Юнит-тесты чистых функций стенда (`client/scripts/ui-probe-stand.mjs`,
 * задача 38ef87cc): разбор аргументов и извлечение API-key из вывода `etn init`.
 * Импорт модуля не поднимает стенд — точка входа защищена проверкой прямого
 * вызова.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  buildProbeArgs,
  parseArgs,
  parseDelaySeedRule,
  parseInitKey,
  readScenarioLogRules,
  resolveDelaySeedPath,
  serverLogViolations,
} from '../scripts/ui-probe-stand.mjs';
import {
  delayForUrl,
  matchDelayRule,
  needsDelay,
  startDelayProxy,
} from '../scripts/ui-probe-delay-proxy.mjs';

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
  assert.deepEqual(opts.delaySeedRules, []);
  assert.equal(opts.failSeedPath, '');
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

test('parseArgs: --fail-seed-path (пусто по умолчанию, значение, пропущенное значение)', () => {
  assert.equal(parseArgs([]).failSeedPath, '');
  assert.equal(
    parseArgs(['--fail-seed-path', 'thoughts/resolve']).failSeedPath,
    'thoughts/resolve',
  );
  assert.throws(() => parseArgs(['--fail-seed-path']), /требует значения/);
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

test('resolveDelaySeedPath: id засеянных сущностей подставляются в путь фильтра', () => {
  const seed = {
    networkId: 'net-1',
    networkName: 'Сеть',
    homeId: 'home-1',
    thoughtId: 'thought-1',
  };
  // Сценарий гонки фокуса (1656ef58) знает мысль только как seed-id.
  assert.equal(
    resolveDelaySeedPath('/thoughts/{{thoughtId}}/focus', seed),
    '/thoughts/thought-1/focus',
  );
  assert.equal(
    resolveDelaySeedPath('/networks/{{networkId}}/thoughts/{{homeId}}/focus', seed),
    '/networks/net-1/thoughts/home-1/focus',
  );
  // Пустой фильтр и отсутствие сида (интерактивный стенд) — без изменений.
  assert.equal(resolveDelaySeedPath('', seed), '');
  assert.equal(resolveDelaySeedPath('/thoughts/resolve', null), '/thoughts/resolve');
});

test('parseDelaySeedRule: <ms>:<путь>, ошибки на пустом пути и мусоре', () => {
  assert.deepEqual(parseDelaySeedRule('6000:views/parentsof6d78ccab'), {
    delayMs: 6000,
    path: 'views/parentsof6d78ccab',
  });
  // Разделитель — ПЕРВОЕ двоеточие: остальное принадлежит пути.
  assert.deepEqual(parseDelaySeedRule('1500:a:b'), { delayMs: 1500, path: 'a:b' });
  assert.throws(() => parseDelaySeedRule('6000:'), /путь обязателен/);
  assert.throws(() => parseDelaySeedRule('views/x'), /<ms>:<путь>/);
  assert.throws(() => parseDelaySeedRule('x:views'), /целое/);
});

test('parseArgs: повторяемые --delay-seed-rule', () => {
  const opts = parseArgs([
    '--delay-seed-rule',
    '6000:views/a',
    '--delay-seed-rule',
    '1500:views/b',
  ]);
  assert.deepEqual(opts.delaySeedRules, [
    { delayMs: 6000, path: 'views/a' },
    { delayMs: 1500, path: 'views/b' },
  ]);
});

test('delayForUrl: правило B короче A, GET набора не задерживается', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const a = `/api/v1/networks/${id}/thoughts/f/views/parentsof6d78ccab/run`;
  const b = `/api/v1/networks/${id}/thoughts/f/views/childrenof6d78ccab/run`;
  const list = `/api/v1/networks/${id}/thoughts/f/views?include_effective=true`;
  const rules = [
    { delayMs: 6000, pathFilter: 'views/parentsof6d78ccab' },
    { delayMs: 1500, pathFilter: 'views/childrenof6d78ccab' },
  ];
  assert.equal(delayForUrl(a, id, rules), 6000);
  // B ждёт меньше A: при старте B после A ответ B приходит РАНЬШЕ — это и
  // есть воспроизведение гонки «поздний A» (замечание круга 2 к 6d78ccab).
  assert.equal(delayForUrl(b, id, rules), 1500);
  assert.equal(delayForUrl(list, id, rules), null, 'GET эффективного набора не задержан');
  assert.equal(matchDelayRule(a, id, rules), 0);
  assert.equal(matchDelayRule(b, id, rules), 1);
  assert.equal(matchDelayRule(list, id, rules), -1);
  // URL чужой сети — не задерживается ни одним правилом.
  assert.equal(delayForUrl(a, 'other-network', rules), null);
  // Первое совпадение выигрывает: широкое правило раньше узкого.
  assert.equal(delayForUrl(a, id, [{ delayMs: 100, pathFilter: 'views/' }, ...rules]), 100);
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

test('serverLogViolations: atMost — предел числа совпадений (b213cf60)', () => {
  const line = '{"url":"/api/v1/networks/n/thoughts/resolve","status":200}';
  const log = [line, line, line].join('\n');
  const pattern = '"url":"[^"]*/thoughts/resolve","status":200';
  // В пределах предела — нарушений нет; выше — нарушение с max и счётчиком.
  assert.deepEqual(serverLogViolations(log, { atMost: [{ pattern, max: 3 }] }), []);
  assert.deepEqual(serverLogViolations(log, { atMost: [{ pattern, max: 2 }] }), [
    { kind: 'atMost', pattern, max: 2, count: 3, matches: [line, line, line] },
  ]);
  // Чужие пути в счёт не идут.
  assert.deepEqual(
    serverLogViolations('{"url":"/api/v1/networks/n/thoughts","status":200}', {
      atMost: [{ pattern, max: 0 }],
    }),
    [],
  );
});

test('readScenarioLogRules: правила из сценария; без ключа — null', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'etn-stand-rules-'));
  try {
    const withRules = path.join(dir, 'with.json');
    const atMost = [{ pattern: 'resolve', max: 4 }];
    writeFileSync(
      withRules,
      JSON.stringify({ name: 's', serverLog: { absent: ['a'], present: ['b'], atMost } }),
      'utf8',
    );
    assert.deepEqual(readScenarioLogRules(withRules), {
      absent: ['a'],
      present: ['b'],
      atMost,
    });

    const without = path.join(dir, 'without.json');
    writeFileSync(without, JSON.stringify({ name: 's', steps: [] }), 'utf8');
    assert.equal(readScenarioLogRules(without), null);

    const broken = path.join(dir, 'broken.json');
    writeFileSync(broken, JSON.stringify({ serverLog: { absent: [1] } }), 'utf8');
    assert.throws(() => readScenarioLogRules(broken), /serverLog\.absent/);

    const brokenAtMost = path.join(dir, 'broken-atmost.json');
    writeFileSync(
      brokenAtMost,
      JSON.stringify({ serverLog: { atMost: [{ pattern: '', max: 2 }] } }),
      'utf8',
    );
    assert.throws(() => readScenarioLogRules(brokenAtMost), /serverLog\.atMost/);

    const brokenMax = path.join(dir, 'broken-max.json');
    writeFileSync(
      brokenMax,
      JSON.stringify({ serverLog: { atMost: [{ pattern: 'x', max: -1 }] } }),
      'utf8',
    );
    assert.throws(() => readScenarioLogRules(brokenMax), /serverLog\.atMost/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startDelayProxy: failPath — форвард + подмена статуса и счётчик (b213cf60)', async () => {
  const NET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  const upstreamPort = typeof address === 'object' && address !== null ? address.port : 0;
  // Без delay-правил: подмена статуса не должна задерживать запросы.
  const proxy = await startDelayProxy({
    targetPort: upstreamPort,
    networkId: NET,
    delayMs: 0,
    failPath: 'thoughts/resolve',
  });
  const get = (pathname: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: proxy.port, path: pathname }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });
  try {
    const injected = await get(`/api/v1/networks/${NET}/thoughts/resolve`);
    assert.equal(injected.status, 404, 'клиент получил подменённый статус');
    assert.match(injected.body, /PROBE_INJECTED/);
    assert.equal(proxy.failedCount(), 1);
    assert.equal(upstreamHits, 1, 'подменённый запрос всё равно ушёл на сервер');

    const normal = await get(`/api/v1/networks/${NET}/thoughts`);
    assert.equal(normal.status, 200, 'прочие пути идут обычным форвардом');
    assert.equal(normal.body, '{"ok":true}');
    assert.equal(proxy.failedCount(), 1, 'счётчик считает только подмены');
    assert.equal(upstreamHits, 2);
    assert.equal(proxy.delayedCount(), 0, 'без delay-правил задержки нет');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
