#!/usr/bin/env node
/**
 * Сид GUI-сценария ошибки 1656ef58: гонка установки фокуса A → B.
 *
 * Стенд `ui-probe-stand.mjs` засеивает сеть A («GUI-стенд»), HOME и одну мысль
 * (становится мыслью A — её id стенд подставляет в `--delay-seed-path` через
 * `{{thoughtId}}`). Скрипт готовит:
 *   - у A — БОЛЬШОЕ поддерево (`A_CHILD_COUNT` детей): поздний ответ фокуса A
 *     пересобирает тяжёлую зону — стенд честно проверяет отклик UI;
 *   - у HOME — сестру A `B 1656ef58` с ДВУМЯ реальными детьми: после фокуса B
 *     зона `Потомки` обязана показать именно их, а сама B — стоять в фокусе
 *     один раз.
 *
 * Все запросы — REST напрямую (шаги `api` стенда идут мимо замедляющего
 * прокси). Скрипт идемпотентен: повторный запуск на том же стенде
 * переиспользует найденные сущности по названию и досоздаёт только недостающие.
 *
 * Использование:
 *   node client/scripts/ui-probe.1656ef58-focus-race-seed.mjs \
 *     --data-dir .tmp/1656ef58/stand/data \
 *     --network-id <uuid> --center-id <uuid A> \
 *     --api http://127.0.0.1:4417/api/v1 --api-key etn_…
 *
 * Печатает JSON: { networkId, homeId, focusA, focusB, childrenA, childrenB }.
 */
import path from 'node:path';

const B_TITLE = 'B 1656ef58';
const B_CHILDREN = ['B-ребёнок 1 1656ef58', 'B-ребёнок 2 1656ef58'];
/** Сорок детей A: зона «Потомки» занимает несколько строк виртуализации. */
const A_CHILD_COUNT = 40;
const A_CHILD_TITLE = (index) => `A-потомок 1656ef58 ${index}`;

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

/** Все мысли сети (для поиска HOME/заголовков) — страницами (лимит API 100). */
async function allThoughts(opts) {
  const out = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const page = await rest(opts, 'POST', `/networks/${opts.networkId}/thoughts/query`, {
      limit: 100,
      offset,
    });
    const items = Array.isArray(page) ? page : (page.items ?? []);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

/** Дети мысли (актуальные, без корзины). */
async function childrenOf(opts, thoughtId) {
  const page = await rest(
    opts,
    'GET',
    `/networks/${opts.networkId}/thoughts/${thoughtId}/neighbors?network_id=${opts.networkId}` +
      '&dir=children&limit=200&show_trash=false',
  );
  return Array.isArray(page) ? page : (page.items ?? []);
}

/** Создать мысль под родителем (идемпотентно по точному заголовку среди детей). */
async function ensureChild(opts, parentId, title, knownChildren) {
  const found = knownChildren.find((item) => item.title === title);
  if (found !== undefined) return found;
  const created = await rest(opts, 'POST', `/networks/${opts.networkId}/thoughts`, {
    title,
    create_link: { direction: 'parent', target_thought_id: parentId },
  });
  knownChildren.push(created);
  return created;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      'node client/scripts/ui-probe.1656ef58-focus-race-seed.mjs ' +
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

  const thoughts = await allThoughts(opts);
  const home = thoughts.find((item) => item.title === 'HOME');
  if (home === undefined) throw new Error('в засеянной сети не найдена корневая мысль HOME');

  // 1. Большое поддерево A (она же засеянная мысль стенда).
  const aChildren = await childrenOf(opts, opts.centerId);
  for (let i = 1; i <= A_CHILD_COUNT; i += 1) {
    await ensureChild(opts, opts.centerId, A_CHILD_TITLE(i), aChildren);
  }

  // 2. Сестра A — мысль B под HOME с реальными детьми.
  const homeChildren = await childrenOf(opts, home.id);
  const focusB = await ensureChild(opts, home.id, B_TITLE, homeChildren);
  const bChildren = await childrenOf(opts, focusB.id);
  for (const title of B_CHILDREN) {
    await ensureChild(opts, focusB.id, title, bChildren);
  }

  process.stdout.write(
    `${JSON.stringify({
      networkId: opts.networkId,
      homeId: home.id,
      focusA: opts.centerId,
      focusB: focusB.id,
      childrenA: (await childrenOf(opts, opts.centerId)).length,
      childrenB: (await childrenOf(opts, focusB.id)).length,
    })}\n`,
  );
}

await main(process.argv.slice(2));
