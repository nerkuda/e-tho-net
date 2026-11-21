#!/usr/bin/env node
/**
 * Фикстура GUI-сценария `ui-probe.publication-recipe` (задача a0c071f8,
 * сценарий b0a50833, ТП 3e97b648).
 *
 * Сценарий работает с ДВУМЯ публикациями и мыслями по ключевому слову «проба»:
 *  - мысли «Проба альфа/бета/гамма» под HOME — кандидаты легаси-рецепта
 *    (`keywords: "проба"`, область `title`, сортировка по алфавиту);
 *  - публикация «РЕЦЕПТ-ПРОБА» — легаси-ПЛОСКИЙ рецепт заголовков: редактор
 *    обязан открыть его деревом, автосохранить правку как AST и пересобрать
 *    документ с ТЕМИ ЖЕ заголовками;
 *  - публикация «РЕЦЕПТ-БИТЫЙ» — рецепт с условием по несуществующему
 *    свойству: редактор показывает диагностику и НЕ перезаписывает определение.
 *
 * Причина существования: контракт `title_recipe` — свободный JSON, а сценарий
 * адресует публикацию по id в шагах `api`. Стенд передаёт сценарию переменные из
 * stdout фикстуры (`--var`), поэтому прогон остаётся одной командой:
 *
 *   node client/scripts/ui-probe-stand.mjs \
 *     --scenario client/scripts/ui-probe.publication-recipe.scenario.json \
 *     --scenario-seed client/scripts/ui-probe.publication-recipe-seed.mjs
 *
 * Все запросы — REST напрямую (мимо прокси задержки). Скрипт идемпотентен:
 * сущности находятся по названию, а рецепты ПЕРЕЗАПИСЫВАЮТСЯ — сценарий правит
 * рецепт «РЕЦЕПТ-ПРОБА» в AST, и повторный прогон на том же стенде обязан
 * начинать с легаси-формы.
 *
 * Печатает JSON: { pubId, brokenPubId }.
 */
import path from 'node:path';

const GOOD_TITLE = 'РЕЦЕПТ-ПРОБА';
const BROKEN_TITLE = 'РЕЦЕПТ-БИТЫЙ';
const SEEDED_THOUGHT_TITLES = ['Проба альфа', 'Проба бета', 'Проба гамма'];

/** Легаси-плоский рецепт: условия конструктора «Структур» + сортировка. */
const GOOD_RECIPE = {
  keywords: 'проба',
  keyword_scope: ['title'],
  // Сценарий ждёт строку «Помечено на удаление»: легаси-определение задаёт её
  // явно, как это делает сохранение отбора из конструктора «Структур».
  trashed: false,
  sort: 'alpha',
  order: 'asc',
};

/**
 * Битый рецепт: условие по свойству, которого в сети нет. Компилятор обязан
 * сообщить диагностику, редактор — показать её и не переписать определение.
 * `property_id` — заведомо отсутствующий UUID.
 */
const BROKEN_RECIPE = {
  properties: [
    {
      property_id: '00000000-0000-4000-8000-000000000000',
      op: 'eq',
      value: 'нет такого свойства',
    },
  ],
  sort: 'alpha',
  order: 'asc',
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

/** Все мысли сети (контракт query: limit 1..100, поэтому листаем). */
async function listThoughts(opts) {
  const items = [];
  for (let offset = 0; ; offset += 100) {
    const page = await rest(opts, 'POST', `/networks/${opts.networkId}/thoughts/query`, {
      limit: 100,
      offset,
    });
    const chunk = listOf(page);
    items.push(...chunk);
    if (chunk.length < 100) break;
  }
  return items;
}

/** Публикация по названию (сверяет дубли: неоднозначный стенд — отказ). */
async function findPublication(opts, title) {
  const found = listOf(
    await rest(opts, 'GET', `/networks/${opts.networkId}/publications?limit=200`),
  ).filter((item) => item.title === title);
  if (found.length > 1) {
    throw new Error(
      `в сети ${opts.networkId} ${found.length} публикаций «${title}» — каталог не чист`,
    );
  }
  return found[0] ?? null;
}

/**
 * Публикация с заказанным рецептом: создаёт либо перезаписывает рецепт.
 * Перезапись обязательна — сценарий меняет рецепт «РЕЦЕПТ-ПРОБА» на AST.
 */
async function ensurePublication(opts, title, titleRecipe) {
  const existing = await findPublication(opts, title);
  if (existing === null) {
    return rest(opts, 'POST', `/networks/${opts.networkId}/publications`, {
      title,
      title_recipe: titleRecipe,
    });
  }
  if (JSON.stringify(existing.title_recipe) === JSON.stringify(titleRecipe)) return existing;
  return rest(opts, 'PATCH', `/networks/${opts.networkId}/publications/${existing.id}`, {
    title_recipe: titleRecipe,
  });
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      'node client/scripts/ui-probe.publication-recipe-seed.mjs ' +
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

  // 1. Мысли-кандидаты легаси-рецепта (поиск идёт по заголовку).
  const byTitle = new Map((await listThoughts(opts)).map((item) => [item.title, item]));
  const home = byTitle.get('HOME');
  if (home === undefined) throw new Error('в сети не найдена корневая мысль HOME');
  for (const title of SEEDED_THOUGHT_TITLES) {
    if (byTitle.has(title)) continue;
    const created = await rest(opts, 'POST', `/networks/${opts.networkId}/thoughts`, {
      title,
      comment: { body_md: `Кандидат рецепта публикации: ${title}` },
      create_link: { direction: 'parent', target_thought_id: home.id },
    });
    byTitle.set(title, created);
  }

  // 2. Публикации: легаси-рецепт и рецепт с несуществующим свойством.
  const good = await ensurePublication(opts, GOOD_TITLE, GOOD_RECIPE);
  const broken = await ensurePublication(opts, BROKEN_TITLE, BROKEN_RECIPE);

  process.stdout.write(`${JSON.stringify({ pubId: good.id, brokenPubId: broken.id })}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(
      `ui-probe.publication-recipe-seed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);
