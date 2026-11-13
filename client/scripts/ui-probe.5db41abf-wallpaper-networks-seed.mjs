#!/usr/bin/env node
/**
 * Сид GUI-сценария задачи 5db41abf «Фоновая картинка — на каждую мыслесеть».
 *
 * Стенд `ui-probe-stand.mjs` уже засеял сеть A («GUI-стенд») и HOME. Скрипт
 * готовит ВТОРУЮ сеть того же пользователя: картинка должна быть своя в каждой
 * сети, поэтому сценарию нужны две сети с разными id.
 *
 * Сеть B создаётся REST-запросом от того же API-ключа (владелец — пользователь
 * стенда), поэтому она появляется в списке сетей и в пикере вкладок. Скрипт
 * идемпотентен: повторный запуск переиспользует сеть по названию.
 *
 * Использование:
 *   node client/scripts/ui-probe.5db41abf-wallpaper-networks-seed.mjs \
 *     --data-dir .tmp/5db41abf/stand/data \
 *     --network-id <uuid A> --center-id <uuid> \
 *     --api http://127.0.0.1:4417/api/v1 --api-key etn_…
 *
 * Печатает JSON: { networkB }.
 */
import path from 'node:path';

const NETWORK_B_NAME = 'Сеть B 5db41abf wallpaper';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    const need = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`аргумент ${arg} требует значения`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--data-dir':
        opts.dataDir = path.resolve(need());
        break;
      case '--network-id':
        opts.networkId = need();
        break;
      case '--center-id':
        opts.centerId = need();
        break;
      case '--api':
        opts.api = need().replace(/\/$/, '');
        break;
      case '--api-key':
        opts.apiKey = need();
        break;
      default:
        throw new Error(`неизвестный аргумент «${arg}»`);
    }
  }
  return opts;
}

async function rest(opts, method, apiPath, body) {
  const headers = { authorization: `Bearer ${opts.apiKey}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${opts.api}${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // не-JSON — оставим строкой для диагностики
  }
  if (!res.ok) {
    throw new Error(`REST ${method} ${apiPath}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return parsed !== null && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
}

function assertIsolatedDataDir(dataDir) {
  const tmpMarker = `${path.sep}.tmp${path.sep}`;
  if (!`${dataDir}${path.sep}`.includes(tmpMarker)) {
    throw new Error(`отказ: каталог данных вне .tmp/: ${dataDir}`);
  }
}

async function listOf(opts, apiPath) {
  const value = await rest(opts, 'GET', apiPath);
  return Array.isArray(value) ? value : (value.items ?? []);
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      'node client/scripts/ui-probe.5db41abf-wallpaper-networks-seed.mjs ' +
        '--data-dir <dir> --network-id <uuid> --center-id <uuid> --api <url> --api-key <key>\n',
    );
    return 0;
  }
  for (const key of ['dataDir', 'networkId', 'centerId', 'api', 'apiKey']) {
    if (typeof opts[key] !== 'string' || opts[key] === '') {
      throw new Error(`не задан --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    }
  }
  assertIsolatedDataDir(opts.dataDir);

  const networks = await listOf(opts, '/networks');
  const existing = networks.filter((item) => item.display_name === NETWORK_B_NAME);
  if (existing.length > 1) {
    throw new Error(`в стенде ${existing.length} сетей «${NETWORK_B_NAME}» — каталог не чист`);
  }
  const networkB =
    existing.length === 1
      ? existing[0]
      : await rest(opts, 'POST', '/networks', { display_name: NETWORK_B_NAME });

  process.stdout.write(`${JSON.stringify({ networkB: networkB.id })}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(
      `ui-probe.5db41abf-wallpaper-networks-seed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);
