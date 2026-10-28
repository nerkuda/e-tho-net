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
import net from 'node:net';
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
  createWsMuteFilter,
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
  assert.equal(opts.muteWsEvent, '');
  assert.equal(opts.failSeedPath, '');
  assert.equal(opts.failSeedStatus, 404);
});

test('parseArgs: --fail-seed-status — статус подмены, только вместе с путём', () => {
  const opts = parseArgs(['--fail-seed-path', 'thoughts/x/focus', '--fail-seed-status', '500']);
  assert.equal(opts.failSeedPath, 'thoughts/x/focus');
  assert.equal(opts.failSeedStatus, 500);
  assert.throws(
    () => parseArgs(['--fail-seed-status', '500']),
    /требует --fail-seed-path/,
    'статус без пути не имеет смысла',
  );
  assert.throws(
    () => parseArgs(['--fail-seed-path', 'p', '--fail-seed-status', '302']),
    /400\.\.599/,
  );
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

test('parseArgs: --delay-seed-response-limit (0 по умолчанию, значение, требует правила)', () => {
  assert.equal(parseArgs([]).responseSeedLimit, 0);
  const opts = parseArgs([
    '--delay-seed-response-rule',
    '4000:thoughts/x/properties',
    '--delay-seed-response-limit',
    '2',
  ]);
  assert.equal(opts.responseSeedLimit, 2);
  assert.equal(opts.responseSeedRules.length, 1);
  assert.throws(
    () => parseArgs(['--delay-seed-response-limit', '2']),
    /--delay-seed-response-rule/,
  );
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

test('parseArgs: повторяемые --delay-seed-response-rule (задержка ответа)', () => {
  assert.deepEqual(parseArgs([]).responseSeedRules, []);
  assert.deepEqual(
    parseArgs([
      '--delay-seed-response-rule',
      '4000:thoughts/{{thoughtId}}/properties',
      '--delay-seed-response-rule',
      '1000:thought-types',
    ]).responseSeedRules,
    [
      { delayMs: 4000, path: 'thoughts/{{thoughtId}}/properties' },
      { delayMs: 1000, path: 'thought-types' },
    ],
  );
  assert.throws(() => parseArgs(['--delay-seed-response-rule']), /требует значения/);
  // Формат тот же: без пути — ошибка разбора, а не молчаливая задержка всех путей.
  assert.throws(
    () => parseArgs(['--delay-seed-response-rule', '4000']),
    /<ms>:<путь>/,
  );
});

test('matchDelayRule: rule.method сужает правило до метода запроса (da7bbb53)', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const read = `/api/v1/networks/${id}/thoughts/t1/properties`;
  const mutation = `/api/v1/networks/${id}/thoughts/t1/properties/Tags`;
  const rules = [{ delayMs: 5000, pathFilter: 'properties', method: 'GET' }];
  assert.equal(matchDelayRule(read, id, rules, 'GET'), 0, 'GET-чтение придержано');
  assert.equal(
    matchDelayRule(mutation, id, rules, 'DELETE'),
    -1,
    'DELETE «Очистить» не придержан: иначе мутация завершается после снимка',
  );
  assert.equal(delayForUrl(mutation, id, rules, 'DELETE'), null);
  // Правило без method совпадает с любым методом (поведение до круга 4).
  assert.equal(matchDelayRule(mutation, id, [{ delayMs: 1, pathFilter: 'properties' }], 'DELETE'), 0);
});

test('parseArgs: --delay-seed-response-method ограничивает правила ответа', () => {
  const opts = parseArgs([
    '--delay-seed-response-rule',
    '5000:thoughts/{{thoughtId}}/properties',
    '--delay-seed-response-method',
    'get',
  ]);
  assert.equal(opts.responseSeedMethod, 'GET');
  assert.throws(
    () => parseArgs(['--delay-seed-response-method', 'GET']),
    /требует --delay-seed-response-rule/,
  );
  assert.throws(
    () =>
      parseArgs([
        '--delay-seed-response-rule',
        '1:x',
        '--delay-seed-response-method',
        'G3T',
      ]),
    /HTTP-метод/,
  );
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
  // Чужие пути в счёт не идут — но ноль совпадений теперь НАРУШЕНИЕ:
  // вакуумный гейт (опечатка в pattern) не должен давать зелёный прогон
  // (замечание верификатора к b213cf60).
  assert.deepEqual(
    serverLogViolations('{"url":"/api/v1/networks/n/thoughts","status":200}', {
      atMost: [{ pattern, max: 0 }],
    }),
    [{ kind: 'atMost', pattern, max: 0, count: 0, matches: [] }],
  );
});

test('serverLogViolations: atMost без совпадений — вакуумный гейт (b213cf60)', () => {
  const pattern = '"url":"[^"]*/thoughts/resolve","status":200';
  const log = '{"url":"/api/v1/networks/n/thoughts","status":200}';
  // Правило с опечаткой/несовпавшим путём обязано краснеть: иначе гейт
  // «не больше N запросов» молча зелёный при нуле наблюдений.
  assert.deepEqual(serverLogViolations(log, { atMost: [{ pattern, max: 10 }] }), [
    { kind: 'atMost', pattern, max: 10, count: 0, matches: [] },
  ]);
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

test('parseArgs: --mute-ws-event — подстрока подавляемого realtime-события', () => {
  const opts = parseArgs(['--mute-ws-event', 'property-value.deleted']);
  assert.equal(opts.muteWsEvent, 'property-value.deleted');
  assert.throws(() => parseArgs(['--mute-ws-event']), /требует значения/);
});

/** Серверный (немаскированный) текстовый WebSocket-кадр RFC 6455. */
function wsTextFrame(text: string, fin = true): Buffer {
  const payload = Buffer.from(text, 'utf8');
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0x00) | 0x1, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0x00) | 0x1;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0x00) | 0x1;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Кадр-продолжение (opcode 0) текстового сообщения. */
function wsContinuationFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([0x80, payload.length]), payload]);
}

test('createWsMuteFilter: подавляет совпавшие сообщения, прочие кадры проходят (da7bbb53)', () => {
  const out: Buffer[] = [];
  const filter = createWsMuteFilter('property-value.deleted', (chunk: Buffer) => out.push(chunk));
  const handshake = Buffer.from(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    'latin1',
  );
  const keep = wsTextFrame('{"type":"property-value.set"}');
  const muted = wsTextFrame('{"type":"property-value.deleted","data":{}}');
  const ping = Buffer.from([0x89, 0x00]);
  // Один чанк: рукопожатие + проходящий кадр + подавляемый + ping.
  filter.push(Buffer.concat([handshake, keep, muted, ping]));
  filter.end();
  const bytes = Buffer.concat(out);
  assert.ok(bytes.subarray(0, handshake.length).equals(handshake), 'рукопожатие прошло как есть');
  assert.ok(bytes.includes(keep), 'чужое realtime-событие доставлено');
  assert.ok(!bytes.includes(muted.subarray(2)), 'совпавшее событие подавлено целиком');
  assert.ok(bytes.includes(ping), 'ping прошёл');
});

test('createWsMuteFilter: фрагментированное сообщение решается целиком (da7bbb53)', () => {
  const out: Buffer[] = [];
  const filter = createWsMuteFilter('property-value.deleted', (chunk: Buffer) => out.push(chunk));
  filter.push(
    Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n', 'latin1'),
  );
  // Подстрока разрезана между кадрами: по отдельности она бы не совпала.
  filter.push(wsTextFrame('{"type":"property-value.', false));
  filter.push(wsContinuationFrame('deleted"}'));
  filter.push(wsTextFrame('{"type":"keep"}'));
  filter.end();
  const bytes = Buffer.concat(out);
  assert.ok(!bytes.includes(Buffer.from('property-value.', 'utf8')), 'фрагменты подавлены все');
  assert.ok(bytes.includes(Buffer.from('{"type":"keep"}', 'utf8')), 'следующее сообщение прошло');
});

test('startDelayProxy: muteWsEvent не пропускает кадр через WS-апгрейд (da7bbb53)', async () => {
  const upgradedSockets: Array<{ destroy(): void }> = [];
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  upstream.on('upgrade', (_req, socket) => {
    upgradedSockets.push(socket);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.write(wsTextFrame('{"type":"keep"}'));
    socket.write(wsTextFrame('{"type":"property-value.deleted"}'));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  const upstreamPort = typeof address === 'object' && address !== null ? address.port : 0;
  const proxy = await startDelayProxy({
    targetPort: upstreamPort,
    networkId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    delayMs: 0,
    muteWsEvent: 'property-value.deleted',
  });
  const client = net.connect(proxy.port, '127.0.0.1');
  const received: Buffer[] = [];
  client.on('data', (chunk: Buffer) => received.push(chunk));
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.write(
      'GET /api/v1/realtime?network_id=n HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !Buffer.concat(received).includes(Buffer.from('"keep"'))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Дать доехать (или не доехать) второму кадру.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const bytes = Buffer.concat(received);
    assert.ok(bytes.includes(Buffer.from('101 Switching Protocols')), 'апгрейд состоялся');
    assert.ok(bytes.includes(Buffer.from('"keep"')), 'несовпавшее событие доставлено');
    assert.ok(
      !bytes.includes(Buffer.from('property-value.deleted')),
      'realtime-эхо подавлено, канал жив',
    );
  } finally {
    client.destroy();
    for (const socket of upgradedSockets) socket.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
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

test('startDelayProxy: responseRules придерживают ОТВЕТ, а не запрос (ddcb8e84)', async () => {
  const NET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  /** Момент, когда сервер реально прочитал запрос (данные — на этот момент). */
  let upstreamHitAt = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHitAt = Date.now();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  const upstreamPort = typeof address === 'object' && address !== null ? address.port : 0;
  const proxy = await startDelayProxy({
    targetPort: upstreamPort,
    networkId: NET,
    delayMs: 0,
    responseRules: [{ delayMs: 400, pathFilter: 'properties' }],
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
    const startedAt = Date.now();
    const held = await get(`/api/v1/networks/${NET}/thoughts/x/properties`);
    const elapsed = Date.now() - startedAt;
    assert.equal(held.status, 200);
    assert.ok(elapsed >= 350, `ответ придержан (${elapsed} мс ≥ 350)`);
    assert.ok(
      upstreamHitAt - startedAt < 200,
      'запрос дошёл до сервера сразу: снимок данных — на момент запроса',
    );
    assert.equal(proxy.delayedCount(), 0, 'отправка запроса не задерживалась');
    assert.equal(proxy.delayedResponseCount(), 1);
    assert.deepEqual(proxy.delayedResponseByRule(), [1]);

    const startedNorm = Date.now();
    await get(`/api/v1/networks/${NET}/thoughts`);
    const normalElapsed = Date.now() - startedNorm;
    assert.ok(normalElapsed < 300, `посторонний путь без задержки ответа (${normalElapsed} мс)`);
    assert.equal(proxy.delayedResponseCount(), 1, 'счётчик считает только совпавшие пути');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test('startDelayProxy: responseLimit придерживает только первые ответы (da7bbb53, круг 3)', async () => {
  const NET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  const upstreamPort = typeof address === 'object' && address !== null ? address.port : 0;
  const proxy = await startDelayProxy({
    targetPort: upstreamPort,
    networkId: NET,
    delayMs: 0,
    responseRules: [{ delayMs: 400, pathFilter: 'properties' }],
    responseLimit: 1,
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
    const firstStarted = Date.now();
    await get(`/api/v1/networks/${NET}/thoughts/x/properties`);
    const firstElapsed = Date.now() - firstStarted;
    assert.ok(firstElapsed >= 350, `первый ответ придержан (${firstElapsed} мс ≥ 350)`);

    // Лимит исчерпан — свежее чтение после правки приходит РАНЬШЕ устаревшего.
    const secondStarted = Date.now();
    await get(`/api/v1/networks/${NET}/thoughts/x/properties`);
    const secondElapsed = Date.now() - secondStarted;
    assert.ok(secondElapsed < 300, `второй ответ прошёл сразу (${secondElapsed} мс < 300)`);
    assert.equal(proxy.delayedResponseCount(), 1, 'придержан ровно один ответ');
    assert.deepEqual(proxy.delayedResponseByRule(), [1]);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
