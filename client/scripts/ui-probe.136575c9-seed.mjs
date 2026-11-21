#!/usr/bin/env node
/**
 * Фикстура GUI-сценария задачи 136575c9 (токен фокуса — полоса слоя и акцент
 * всех экранов; требование c19cbb81, сценарий ead5234d).
 *
 * Стенд засеивает сеть (HOME + мысль фокуса). Скрипт добавляет:
 *   - мысль «Мысль 136575c9» под HOME — сосед, видимый в «Структурах», его
 *     открывают двойным кликом на карте (гало = рамка открытого);
 *   - слой «Слой 136575c9» под основой с ЯВНЫМИ цветами пары
 *     `focus_stripe`/`background` (тёмный и светлый варианты): светлый режим
 *     стенда берёт `#0077c2` / `#e6f4fb`, тёмный — `#00b0ff` / `#0d2233`.
 *     Значения далеки от палитры темы `current`, поэтому пробы цвета
 *     однозначны (никаких совпадений с акцентом темы).
 *
 * Все запросы — REST напрямую (мимо прокси). Скрипт идемпотентен: повторный
 * запуск переиспользует сущности по заголовку и переустанавливает цвета слоя.
 */
import path from 'node:path';

const THOUGHT_TITLE = 'Мысль 136575c9';
const LAYER_TITLE = 'Слой 136575c9';

/** Пара цветов слоя (0.6.4, §2.2a): светлый режим стенда — `.light`. */
const LAYER_COLORS = {
  focus_stripe: { dark: '#00b0ff', light: '#0077c2' },
  background: { dark: '#0d2233', light: '#e6f4fb' },
};

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

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      'node client/scripts/ui-probe.136575c9-seed.mjs ' +
        '--data-dir <dir> --network-id <uuid> --center-id <uuid> --api <url> --api-key <key>\n',
    );
    return 0;
  }
  for (const required of ['dataDir', 'networkId', 'centerId', 'api', 'apiKey']) {
    if (opts[required] === undefined) throw new Error(`не задан --${required}`);
  }
  assertIsolatedDataDir(opts.dataDir);

  // 1. Мысль-сосед под HOME: строка «Структур» и цель двойного клика.
  // Контракт query: limit 1..100, поэтому листаем страницами (как 1ae1f9b8).
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
  let thought = thoughts.find((item) => item.title === THOUGHT_TITLE);
  if (thought === undefined) {
    thought = await rest(opts, 'POST', `/networks/${opts.networkId}/thoughts`, {
      title: THOUGHT_TITLE,
      comment: { body_md: `Сосед сценария 136575c9: ${THOUGHT_TITLE}` },
      create_link: { direction: 'parent', target_thought_id: opts.centerId },
    });
  }

  // 2. Слой под основой с явными цветами пары «полоса/фон».
  const layers = listOf(await rest(opts, 'GET', `/networks/${opts.networkId}/layers`));
  let layer = layers.find((item) => item.title === LAYER_TITLE);
  if (layer === undefined) {
    layer = await rest(opts, 'POST', `/networks/${opts.networkId}/layers`, { title: LAYER_TITLE });
  }
  await rest(opts, 'PATCH', `/networks/${opts.networkId}/layers/${layer.id}`, {
    colors: LAYER_COLORS,
  });

  process.stdout.write(
    `ui-probe-seed 136575c9: мысль «${thought.title}» (${thought.id}), ` +
      `слой «${layer.title}» (${layer.id}) цвета ${LAYER_COLORS.focus_stripe.light}/` +
      `${LAYER_COLORS.background.light}\n`,
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(
      `ui-probe-seed 136575c9: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
