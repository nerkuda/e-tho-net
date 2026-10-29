#!/usr/bin/env node
/**
 * Сид GUI-сценария ошибки 5768f479: полка/поиск публикаций не сверяют пару
 * «сеть + состояние» при смене сети.
 *
 * Стенд `ui-probe-stand.mjs` засеивает сеть A («GUI-стенд»), HOME и одну мысль.
 * Скрипт готовит данные ДВУХ сетей, чтобы смена сети была видна в библиотеке:
 *  - в A — полка «Полка A 5768f479» и публикация «Публикация A 5768f479» на ней
 *    (запрос библиотеки A с фильтром полки задерживается прокси стенда);
 *  - в B — отдельная сеть «Сеть B 5768f479 publications» с публикацией
 *    «Публикация B 5768f479» (в B другой список: A-публикации там нет).
 *
 * Все запросы — REST напрямую (шаги `api` стенда идут мимо замедляющего
 * прокси). Скрипт идемпотентен: повторный запуск на том же стенде переиспользует
 * найденные сущности по названию.
 *
 * Использование:
 *   node client/scripts/ui-probe.5768f479-publications-network-switch-seed.mjs \
 *     --data-dir .tmp/5768f479/stand/data \
 *     --network-id <uuid A> --center-id <uuid> \
 *     --api http://127.0.0.1:4417/api/v1 --api-key etn_…
 *
 * Печатает JSON: { networkB, shelfA, publicationA, publicationB }.
 */
import path from 'node:path';

const NETWORK_B_NAME = 'Сеть B 5768f479 publications';
const SHELF_A_TITLE = 'Полка A 5768f479';
const PUBLICATION_A_TITLE = 'Публикация A 5768f479';
const PUBLICATION_B_TITLE = 'Публикация B 5768f479';

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

/** Публикация по названию: переиспользует существующую (идемпотентность). */
async function ensurePublication(opts, networkId, title) {
  const found = (await listOf(opts, `/networks/${networkId}/publications?limit=200`)).filter(
    (item) => item.title === title,
  );
  if (found.length > 1) {
    throw new Error(`в сети ${networkId} ${found.length} публикаций «${title}» — каталог не чист`);
  }
  if (found.length === 1) return found[0];
  return rest(opts, 'POST', `/networks/${networkId}/publications`, { title });
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      'node client/scripts/ui-probe.5768f479-publications-network-switch-seed.mjs ' +
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

  // 1. Сеть B (отдельный список публикаций).
  const networks = await listOf(opts, '/networks');
  const existingB = networks.filter((item) => item.display_name === NETWORK_B_NAME);
  if (existingB.length > 1) {
    throw new Error(`в стенде ${existingB.length} сетей «${NETWORK_B_NAME}» — каталог не чист`);
  }
  const networkB =
    existingB.length === 1
      ? existingB[0]
      : await rest(opts, 'POST', '/networks', { display_name: NETWORK_B_NAME });

  // 2. Полка A и публикация A на ней.
  const shelves = await listOf(opts, `/networks/${opts.networkId}/shelves`);
  const existingShelf = shelves.filter((item) => item.title === SHELF_A_TITLE);
  if (existingShelf.length > 1) {
    throw new Error(`в сети A ${existingShelf.length} полок «${SHELF_A_TITLE}» — каталог не чист`);
  }
  const shelfA =
    existingShelf.length === 1
      ? existingShelf[0]
      : await rest(opts, 'POST', `/networks/${opts.networkId}/shelves`, { title: SHELF_A_TITLE });
  const publicationA = await ensurePublication(opts, opts.networkId, PUBLICATION_A_TITLE);
  const onShelf = (shelfA.items ?? []).some((item) => item.publication_id === publicationA.id);
  if (!onShelf) {
    await rest(opts, 'POST', `/networks/${opts.networkId}/shelves/${shelfA.id}/items`, {
      publication_id: publicationA.id,
    });
  }

  // 3. Публикация B в сети B.
  const publicationB = await ensurePublication(opts, networkB.id, PUBLICATION_B_TITLE);

  process.stdout.write(
    `${JSON.stringify({
      networkB: networkB.id,
      shelfA: shelfA.id,
      publicationA: publicationA.id,
      publicationB: publicationB.id,
    })}\n`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(
      `ui-probe.5768f479-publications-network-switch-seed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);
