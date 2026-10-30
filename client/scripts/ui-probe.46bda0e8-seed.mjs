#!/usr/bin/env node
/**
 * Фикстура GUI-сценария ошибки 46bda0e8 (клиентский N+1 индикаторов при
 * ресинке после смены слоя).
 *
 * Стенд засеивает сеть (HOME + мысль `{{thoughtId}}` с постоянным комментарием).
 * Скрипт готовит окрестность, на которой видно накопление подписок:
 *   - 10 групп «Группа 46bda0e8 K» под HOME, в каждой 8 детей
 *     «Проба 46bda0e8 K-N» (у всех — постоянный комментарий, чтобы счётчики
 *     индикаторов были ненулевыми);
 *   - слой «Слой 46bda0e8» под основой — его выбирает сценарий через меню
 *     «Основа», запуская настоящий `resyncAfterLayerSwitch`.
 *
 * Смысл: сценарий поочерёдно фокусирует группы (каждая — своя окрестность).
 * Старый клиент копил подписки индикаторов на все посещённые мысли — волна
 * `indicatorsAll` после смены слоя перечитывала их все. Исправленный клиент
 * держит подписки только по видимому набору. Число запросов `comments`/
 * `attachments` считает `serverLog` сценария.
 *
 * Все запросы — REST напрямую (мимо прокси). Скрипт идемпотентен: повторный
 * запуск переиспользует сущности по заголовку.
 */
import path from 'node:path';

const GROUP_COUNT = 10;
const CHILDREN_PER_GROUP = 8;
const GROUP_PREFIX = 'Группа 46bda0e8';
const CHILD_PREFIX = 'Проба 46bda0e8';
const LAYER_TITLE = 'Слой 46bda0e8';

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

/** Список из ответа `sendList` (массив или `{ items }`). */
function listOf(page) {
  if (Array.isArray(page)) return page;
  return Array.isArray(page?.items) ? page.items : [];
}

/** Создать мысль под родителем (идемпотентно по заголовку). */
async function ensureThought(opts, byTitle, title, parentId) {
  const existing = byTitle.get(title);
  if (existing !== undefined) return existing;
  const created = await rest(opts, 'POST', `/networks/${opts.networkId}/thoughts`, {
    title,
    comment: { body_md: `Индикаторы 46bda0e8: ${title}` },
    create_link: { direction: 'parent', target_thought_id: parentId },
  });
  byTitle.set(title, created);
  return created;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      'node client/scripts/ui-probe.46bda0e8-seed.mjs ' +
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

  // 1. Существующие мысли — карта «заголовок → мысль» (идемпотентность).
  // Контракт query: limit 1..100, поэтому листаем страницами.
  const thoughts = [];
  for (let offset = 0; ; offset += 100) {
    const page = await rest(opts, 'POST', `/networks/${opts.networkId}/thoughts/query`, {
      limit: 100,
      offset,
    });
    const items = listOf(page);
    thoughts.push(...items);
    if (items.length < 100) break;
  }
  const byTitle = new Map(thoughts.map((item) => [item.title, item]));
  const home = byTitle.get('HOME');
  if (home === undefined) throw new Error('в сети не найдена корневая мысль HOME');

  // 2. Группы и их дети.
  let created = 0;
  for (let k = 1; k <= GROUP_COUNT; k += 1) {
    const groupTitle = `${GROUP_PREFIX} ${k}`;
    const before = byTitle.size;
    const group = await ensureThought(opts, byTitle, groupTitle, home.id);
    if (byTitle.size !== before) created += 1;
    for (let n = 1; n <= CHILDREN_PER_GROUP; n += 1) {
      const childTitle = `${CHILD_PREFIX} ${k}-${n}`;
      const beforeChild = byTitle.size;
      await ensureThought(opts, byTitle, childTitle, group.id);
      if (byTitle.size !== beforeChild) created += 1;
    }
  }

  // 3. Слой под основой — цель переключения в сценарии.
  const layers = listOf(await rest(opts, 'GET', `/networks/${opts.networkId}/layers`));
  const layer =
    layers.find((item) => item.title === LAYER_TITLE) ??
    (await rest(opts, 'POST', `/networks/${opts.networkId}/layers`, { title: LAYER_TITLE }));

  process.stdout.write(
    `ui-probe-seed 46bda0e8: групп ${GROUP_COUNT}, детей ${GROUP_COUNT * CHILDREN_PER_GROUP}, ` +
      `создано мыслей ${created}, слой «${layer.title}» (${layer.id})\n`,
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`ui-probe-seed 46bda0e8: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
