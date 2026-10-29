#!/usr/bin/env node
/**
 * Сид GUI-сценария ошибки 6d78ccab «Отбор по родителю выполняется слишком долго»
 * (клиентская часть): крупная ветка у засеянной мысли + три отбора на ней.
 *
 * Стенд `ui-probe-stand.mjs` засеивает сеть, HOME и одну мысль — она становится
 * фокусом сценария (её id стенд подставляет в `--delay-seed-path` через
 * `{{thoughtId}}`). Скрипт готовит:
 *   - у фокуса — БОЛЬШУЮ ветку (`CHILD_COUNT` детей): отбор «Родитель =
 *     $thought» возвращает длинную страницу, а зона нижней карты — тяжёлый
 *     результат;
 *   - внетиповые отборы мысли (владелец — сама мысль):
 *       «ParentsOf6d78ccab»    — AST-лист `parents eq $thought` (дети фокуса);
 *       «ChildrenOf6d78ccab»   — AST-лист `children eq $thought` (родители
 *                                 фокуса: в стенде это HOME — другой набор
 *                                 строк, по нему видно, чей ответ нарисован);
 *       «Сломанный отбор 6d78ccab» — отбор, сохранённый с условием по свойству,
 *                                 которое затем удалено из реестра: сервер
 *                                 отвечает 422 «Свойство удалено из реестра
 *                                 сети» при прогоне (проверка `errorState`
 *                                 нижней зоны). Такое состояние штатный API
 *                                 сохранить не даёт (красная диагностика на
 *                                 записи), поэтому строка правится в
 *                                 ИЗОЛИРОВАННОЙ БД стенда — как исторические
 *                                 данные, пережившие удаление свойства.
 *
 * Имена A/B — ЛАТИНИЦА без пробелов: путь прогона содержит `name_key`
 * (`encodeURIComponent`), и стенд адресует разные задержки правилами
 * `--delay-seed-rule` по подстроке пути (`views/parentsof6d78ccab`) — так
 * ответ B приходит раньше ответа A (гонка «поздний A», ошибка 6d78ccab, круг 2).
 *
 * Все запросы — REST напрямую (фикстура стенда идёт мимо замедляющего прокси).
 * Скрипт ИДЕМПОТЕНТЕН: повторный запуск на том же стенде переиспользует детей и
 * отборы по точным названиям и правит определение, только если оно разошлось.
 *
 * Использование:
 *   node client/scripts/ui-probe.6d78ccab-parent-filter-seed.mjs \
 *     --data-dir .tmp/6d78ccab/stand/data \
 *     --network-id <uuid> --center-id <uuid> \
 *     --api http://127.0.0.1:4417/api/v1 --api-key etn_…
 *
 * Печатает JSON: { networkId, focusId, children, views: { a, b, broken } }.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * `better-sqlite3` клиентского workspace собран под Electron и в обычном Node 22
 * не загружается — берём серверную копию (собрана под Node), как это делает
 * `ui-probe.42a7c0a1-seed.mjs`.
 */
function loadSqlite() {
  const serverCopy = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'server',
    'node_modules',
    'better-sqlite3',
  );
  try {
    return require(serverCopy);
  } catch {
    return require('better-sqlite3');
  }
}

const Database = loadSqlite();

/** Сколько детей у фокуса: длинная страница отбора и тяжёлая зона. */
const CHILD_COUNT = 60;
const CHILD_TITLE = (index) => `Ребёнок 6d78ccab ${index}`;

const VIEW_A_NAME = 'ParentsOf6d78ccab';
const VIEW_B_NAME = 'ChildrenOf6d78ccab';
const VIEW_BROKEN_NAME = 'Сломанный отбор 6d78ccab';

/** AST-лист структурного условия — ровно форма «Родитель = $thought». */
function astLeaf(kind, value) {
  return JSON.stringify({
    version: 1,
    filter: {
      op: 'and',
      children: [{ entity: { kind }, operator: 'eq', value }],
    },
  });
}

/**
 * «Сломанное» определение: условие по свойству реестра, которого больше нет.
 * Прогон такого отбора даёт 422 (`entity_deleted`, красная диагностика), как у
 * отбора, пережившего удаление свойства. Id заведомо не существует в стенде.
 */
const BROKEN_DEFINITION = JSON.stringify({
  version: 1,
  filter: {
    op: 'and',
    children: [
      {
        entity: { kind: 'property', property_id: '00000000-0000-4000-8000-0000000000ff' },
        operator: 'eq',
        value: 'удалённое свойство',
      },
    ],
  },
});

const VIEW_DEFINITIONS = [
  { name: VIEW_A_NAME, definition: astLeaf('parents', '$thought') },
  { name: VIEW_B_NAME, definition: astLeaf('children', '$thought') },
  // Валидное при создании определение; ниже строка правится в изолированной БД
  // до {@link BROKEN_DEFINITION} — штатный API такое состояние не сохраняет.
  { name: VIEW_BROKEN_NAME, definition: astLeaf('parents', '$thought') },
];

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

/** Дети мысли (актуальные, без корзины). */
async function childrenOf(opts, thoughtId) {
  const page = await rest(
    opts,
    'GET',
    `/networks/${opts.networkId}/thoughts/${thoughtId}/neighbors?dir=children&limit=200&show_trash=false`,
  );
  return Array.isArray(page) ? page : (page.items ?? []);
}

/** Создать ребёнка фокуса (идемпотентно по точному заголовку). */
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

/** Собственные внетиповые отборы мысли (без эффективного набора). */
async function ownViews(opts) {
  const page = await rest(
    opts,
    'GET',
    `/networks/${opts.networkId}/thoughts/${opts.centerId}/views`,
  );
  const rows = Array.isArray(page) ? page : (page.items ?? []);
  return rows;
}

/**
 * Довести отбор до целевого определения: создать недостающий, поправить
 * разошедшееся. Возвращает id.
 */
async function ensureView(opts, existing, spec) {
  const found = existing.find((view) => view.name === spec.name);
  if (found === undefined) {
    const created = await rest(opts, 'POST', `/networks/${opts.networkId}/thoughts/${opts.centerId}/views`, {
      name: spec.name,
      definition: spec.definition,
    });
    existing.push(created);
    return created.id;
  }
  if (found.definition !== spec.definition) {
    await rest(
      opts,
      'PATCH',
      `/networks/${opts.networkId}/thoughts/${opts.centerId}/views/${found.id}`,
      { definition: spec.definition },
    );
  }
  return found.id;
}

/**
 * Перевести сохранённый отбор в «историческое» состояние: определение ссылается
 * на удалённое свойство. Штатный API такую строку сохранить не даёт (красная
 * диагностика на записи) — это данные, пережившие удаление свойства, поэтому
 * правим ИЗОЛИРОВАННУЮ БД стенда напрямую (тот же приём, что у клонирования
 * рёбер в `ui-probe.42a7c0a1-seed.mjs`). Идемпотентно: значение стабильно.
 */
function patchBrokenDefinition(opts, viewId) {
  const dbPath = path.join(opts.dataDir, 'networks', opts.networkId, 'data.db');
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const row = db
      .prepare('SELECT definition FROM thought_custom_views WHERE id = ? AND deleted = 0')
      .get(viewId);
    if (row === undefined) {
      throw new Error(`отбор ${viewId} не найден в БД стенда — REST-создание не сработало`);
    }
    if (row.definition !== BROKEN_DEFINITION) {
      db.prepare('UPDATE thought_custom_views SET definition = ? WHERE id = ? AND deleted = 0').run(
        BROKEN_DEFINITION,
        viewId,
      );
    }
  } finally {
    db.close();
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      'node client/scripts/ui-probe.6d78ccab-parent-filter-seed.mjs ' +
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

  // 1. Крупная ветка фокуса: детей досоздаём только недостающих.
  const children = await childrenOf(opts, opts.centerId);
  for (let i = 1; i <= CHILD_COUNT; i += 1) {
    await ensureChild(opts, opts.centerId, CHILD_TITLE(i), children);
  }
  const childrenTotal = (await childrenOf(opts, opts.centerId)).length;
  if (childrenTotal < CHILD_COUNT) {
    throw new Error(`у фокуса ${childrenTotal} детей, ожидалось не меньше ${CHILD_COUNT}`);
  }

  // 2. Три отбора с нужными определениями (идемпотентно).
  const existing = await ownViews(opts);
  const ids = {};
  for (const spec of VIEW_DEFINITIONS) ids[spec.name] = await ensureView(opts, existing, spec);
  // 3. «Сломанный» отбор: ссылка на удалённое свойство — только прямым
  //    UPDATE изолированной БД (см. {@link patchBrokenDefinition}).
  patchBrokenDefinition(opts, ids[VIEW_BROKEN_NAME]);

  process.stdout.write(
    `${JSON.stringify({
      networkId: opts.networkId,
      focusId: opts.centerId,
      children: childrenTotal,
      views: {
        a: ids[VIEW_A_NAME],
        b: ids[VIEW_B_NAME],
        broken: ids[VIEW_BROKEN_NAME],
      },
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
      `ui-probe.6d78ccab-parent-filter-seed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);
