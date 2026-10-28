#!/usr/bin/env node
/**
 * Фикстура GUI-сценария ошибки d720265c: отказ чтения значений панели
 * «Свойства».
 *
 * Стенд засеивает сеть и одну мысль (`{{thoughtId}}`, заголовок «Проба
 * стенда»). Скрипт готовит на этой мысли:
 *   - тип «Т1 d720265c» с типовым свойством «Теги d720265c» (text + multiple);
 *   - внетиповое скалярное свойство «Внешнее d720265c»;
 *   - значения: «Теги» = ['срочно'], «Внешнее» = 'старое'.
 *
 * Клиент стенда ходит через прокси с `--fail-seed-path
 * 'thoughts/{{thoughtId}}/properties'`: чтение значений панели отвечает
 * отказом, а серверные данные остаются целы (проверяется шагом `api`).
 *
 * Все запросы — REST напрямую (мимо прокси), как у других фикстур стенда.
 * Скрипт идемпотентен: повторный запуск переиспользует сущности по имени.
 */
import path from 'node:path';

const TYPE_NAME = 'Т1 d720265c';
const TAGS_NAME = 'Теги d720265c';
const OUTSIDE_NAME = 'Внешнее d720265c';

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
      'node client/scripts/ui-probe.d720265c-properties-read-fail-seed.mjs ' +
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
  const types = listOf(
    await rest(opts, 'GET', `/networks/${opts.networkId}/thought-types`),
  );
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

  // 3. Привязка «Теги» к типу (одна, без дублей).
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

  // 4. Тип и значения на засеянной мысли стенда.
  await rest(opts, 'PATCH', `/networks/${opts.networkId}/thoughts/${opts.centerId}`, {
    type_id: type.id,
  });
  await rest(
    opts,
    'PUT',
    `/networks/${opts.networkId}/thoughts/${opts.centerId}/properties/${encodeURIComponent(TAGS_NAME)}`,
    { value: 'срочно' },
  );
  await rest(
    opts,
    'PUT',
    `/networks/${opts.networkId}/thoughts/${opts.centerId}/properties/${encodeURIComponent(OUTSIDE_NAME)}`,
    { value: 'старое' },
  );

  process.stdout.write(
    `${JSON.stringify({
      networkId: opts.networkId,
      thoughtId: opts.centerId,
      typeId: type.id,
      tagsPropertyId: tags.id,
      outsidePropertyId: outside.id,
    })}\n`,
  );
}

await main(process.argv.slice(2));
