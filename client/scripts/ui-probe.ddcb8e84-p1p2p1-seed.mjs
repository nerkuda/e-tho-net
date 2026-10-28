#!/usr/bin/env node
/**
 * Фикстура GUI-сценария задачи ddcb8e84: путь P1→P2→P1 с задержкой REST.
 *
 * Стенд засеивает сеть и мысль P1 (`{{thoughtId}}`, заголовок «Проба стенда»).
 * Скрипт готовит на ней:
 *   - тип «T1 ddcb8e84» с типовым свойством «Tags-ddcb8e84» (text + multiple);
 *   - внетиповое скалярное свойство «Outside-ddcb8e84»;
 *   - значения P1: Tags = «срочно», Outside = «старое»;
 *   - вторую мысль «Person 2 ddcb8e84» под HOME того же типа со значениями
 *     Tags = «прочее», Outside = «второе».
 *
 * Внешняя запись в сценарии идёт прямыми REST-запросами (шаги `api`, мимо
 * прокси): это «второй клиент», без локального эха. Ошибка ddcb8e84 проверяет,
 * что после возврата на P1 панель «Свойства» показывает значения сервера, а не
 * снимок, прочитанный до внешней записи.
 *
 * Все запросы — REST напрямую (мимо прокси), как у других фикстур стенда.
 * Скрипт идемпотентен: повторный запуск переиспользует сущности по имени.
 */
import path from 'node:path';

const TYPE_NAME = 'T1 ddcb8e84';
const TAGS_NAME = 'Tags-ddcb8e84';
const OUTSIDE_NAME = 'Outside-ddcb8e84';
const P2_TITLE = 'Person 2 ddcb8e84';

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

/** Поставить значение свойства по имени (PUT, как это делает клиент). */
async function setValue(opts, thoughtId, name, value) {
  await rest(
    opts,
    'PUT',
    `/networks/${opts.networkId}/thoughts/${thoughtId}/properties/${encodeURIComponent(name)}`,
    { value },
  );
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      'node client/scripts/ui-probe.ddcb8e84-p1p2p1-seed.mjs ' +
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

  // 1. Тип мысли (идемпотентно по имени).
  const types = listOf(await rest(opts, 'GET', `/networks/${opts.networkId}/thought-types`));
  let type = types.find((item) => item.name === TYPE_NAME);
  if (type === undefined) {
    type = await rest(opts, 'POST', `/networks/${opts.networkId}/thought-types`, {
      name: TYPE_NAME,
    });
  }

  // 2. Свойства справочника.
  const registry = listOf(await rest(opts, 'GET', `/networks/${opts.networkId}/properties`));
  let tags = registry.find((item) => item.name === TAGS_NAME);
  if (tags === undefined) {
    tags = await rest(opts, 'POST', `/networks/${opts.networkId}/properties`, {
      name: TAGS_NAME,
      value_type: 'text',
      config: { multiple: true },
    });
  }
  let outside = registry.find((item) => item.name === OUTSIDE_NAME);
  if (outside === undefined) {
    outside = await rest(opts, 'POST', `/networks/${opts.networkId}/properties`, {
      name: OUTSIDE_NAME,
      value_type: 'text',
    });
  }

  // 3. Привязка «Tags» к типу (одна, без дублей).
  const bindings = listOf(
    await rest(opts, 'GET', `/networks/${opts.networkId}/thought-types/${type.id}/properties`),
  );
  if (!bindings.some((item) => item.property_id === tags.id)) {
    await rest(opts, 'POST', `/networks/${opts.networkId}/thought-types/${type.id}/properties`, {
      property_id: tags.id,
      required: false,
      position: 0,
    });
  }

  // 4. HOME — родитель второй мысли (как в засеве стенда).
  const page = await rest(opts, 'POST', `/networks/${opts.networkId}/thoughts/query`, {
    limit: 100,
  });
  const home = listOf(page).find((item) => item.title === 'HOME');
  if (home === undefined) throw new Error('в сети не найдена корневая мысль HOME');

  // 5. P2 того же типа под HOME (идемпотентно по заголовку).
  let p2 = listOf(page).find((item) => item.title === P2_TITLE);
  if (p2 === undefined) {
    p2 = await rest(opts, 'POST', `/networks/${opts.networkId}/thoughts`, {
      title: P2_TITLE,
      type_id: type.id,
      create_link: { direction: 'parent', target_thought_id: home.id },
    });
  } else if (p2.type_id !== type.id) {
    await rest(opts, 'PATCH', `/networks/${opts.networkId}/thoughts/${p2.id}`, {
      type_id: type.id,
    });
  }

  // 6. Значения P1 (засеянная мысль стенда) и P2.
  await rest(opts, 'PATCH', `/networks/${opts.networkId}/thoughts/${opts.centerId}`, {
    type_id: type.id,
  });
  await setValue(opts, opts.centerId, TAGS_NAME, 'срочно');
  await setValue(opts, opts.centerId, OUTSIDE_NAME, 'старое');
  await setValue(opts, p2.id, TAGS_NAME, 'прочее');
  await setValue(opts, p2.id, OUTSIDE_NAME, 'второе');

  process.stdout.write(
    `${JSON.stringify({
      networkId: opts.networkId,
      p1: opts.centerId,
      p2: p2.id,
      typeId: type.id,
      tagsPropertyId: tags.id,
      outsidePropertyId: outside.id,
    })}\n`,
  );
}

await main(process.argv.slice(2));
