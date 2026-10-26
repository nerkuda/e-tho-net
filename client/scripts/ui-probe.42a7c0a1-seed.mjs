#!/usr/bin/env node
/**
 * Сид GUI-сценария ошибки 42a7c0a1: массовые связи мини-графа.
 *
 * Стенд `ui-probe-stand.mjs` засеивает сеть, HOME и одну мысль. Этот скрипт
 * добавляет к засеянной мысли соседа и ДВЕНАДЦАТЬ однотипных (нетипизированных)
 * рёбер к нему — ровно столько, чтобы сработал порог MASS_LINK_THRESHOLD.
 * Одно ребро создаётся штатным REST-путём (`create_link`), остальные
 * клонируются в ИЗОЛИРОВАННОЙ БД стенда: серверный API не даёт создать дубль
 * тройки, а исторические данные (импорт/старые версии) такие рёбра содержат —
 * это и есть вход ошибки. У нетипизированных рёбер UNIQUE-индекс тройки не
 * срабатывает (SQLite считает NULL различными), поэтому клонирование не
 * требует правки схемы.
 *
 * Скрипт отказывается работать вне каталога `.tmp/` — живые данные пользователя
 * и полигон он трогать не должен.
 *
 * Использование:
 *   node client/scripts/ui-probe.42a7c0a1-seed.mjs \
 *     --data-dir .tmp/42a7c0a1/stand/data \
 *     --network-id <uuid> --center-id <uuid> \
 *     --api http://127.0.0.1:4417/api/v1 --api-key etn_…
 *
 * Печатает JSON: { neighbourId, linkId, cloned, total }.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * `better-sqlite3` клиентского workspace собран под Electron (ABI 125) и в
 * обычном Node 22 не загружается. Серверный workspace держит свою копию,
 * собранную под Node, — берём её; сценарий стенда не должен требовать
 * пересборки нативного модуля клиента.
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
    // Серверная копия собрана под обычный Node (11.1.2) — она и нужна.
    return require(serverCopy);
  } catch {
    return require('better-sqlite3');
  }
}

const Database = loadSqlite();

const MASS_LINK_TOTAL = 12;
const NEIGHBOUR_TITLE = 'Массовый сосед 42a7c0a1';

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

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      'node client/scripts/ui-probe.42a7c0a1-seed.mjs --data-dir <dir> --network-id <uuid> ' +
        '--center-id <uuid> --api <url> --api-key <key>\n',
    );
    return 0;
  }
  for (const key of ['dataDir', 'networkId', 'centerId', 'api', 'apiKey']) {
    if (typeof opts[key] !== 'string' || opts[key] === '') {
      throw new Error(`не задан --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    }
  }
  assertIsolatedDataDir(opts.dataDir);

  // 1. Сосед + одно живое нетипизированное ребро штатным REST-путём.
  //    Повторный запуск на том же стенде переиспользует соседа (иначе каждый
  //    прогон добавлял бы ещё одного и число линий в гейте «плыло»); больше
  //    одного соседа с нашим именем — стенд не чист, честно падаем.
  const existing = await rest(
    opts,
    'GET',
    `/networks/${opts.networkId}/thoughts/${opts.centerId}/neighbors?dir=children&limit=200`,
  );
  const candidates = (Array.isArray(existing) ? existing : (existing.items ?? [])).filter(
    (item) => item.title === NEIGHBOUR_TITLE,
  );
  if (candidates.length > 1) {
    throw new Error(
      `в стенде ${candidates.length} соседей «${NEIGHBOUR_TITLE}» — каталог не чист, поднимите свежий стенд`,
    );
  }
  const neighbour =
    candidates.length === 1
      ? candidates[0]
      : await rest(opts, 'POST', `/networks/${opts.networkId}/thoughts`, {
          title: NEIGHBOUR_TITLE,
          create_link: { direction: 'parent', target_thought_id: opts.centerId },
        });

  // 2. Клонируем ребро до порога MASS_LINK_THRESHOLD в изолированной БД.
  const dbPath = path.join(opts.dataDir, 'networks', opts.networkId, 'data.db');
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const base = db
      .prepare(
        'SELECT id FROM links WHERE source_id = ? AND target_id = ? AND type_id IS NULL AND deleted = 0 ORDER BY pk DESC LIMIT 1',
      )
      .get(opts.centerId, neighbour.id);
    if (base === undefined) {
      throw new Error('штатное ребро центра к соседу не найдено — REST create_link не сработал');
    }
    const columns = db
      .prepare('PRAGMA table_info(links)')
      .all()
      .map((column) => column.name)
      .filter((name) => name !== 'pk' && name !== 'id');
    const insert = db.prepare(
      `INSERT INTO links (id, ${columns.join(', ')})
       SELECT ?, ${columns.join(', ')} FROM links WHERE id = ?`,
    );
    const clone = db.transaction((count) => {
      for (let i = 0; i < count; i += 1) insert.run(randomUUID(), base.id);
    });
    clone(MASS_LINK_TOTAL - 1);
    const total = db
      .prepare(
        'SELECT COUNT(*) AS c FROM links WHERE source_id = ? AND target_id = ? AND type_id IS NULL AND deleted = 0',
      )
      .get(opts.centerId, neighbour.id).c;
    if (total < MASS_LINK_TOTAL) {
      throw new Error(`рёбер скопировано ${total}, ожидалось не меньше ${MASS_LINK_TOTAL}`);
    }
    process.stdout.write(
      `${JSON.stringify({
        neighbourId: neighbour.id,
        linkId: base.id,
        cloned: MASS_LINK_TOTAL - 1,
        total,
      })}\n`,
    );
  } finally {
    db.close();
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`ui-probe.42a7c0a1-seed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
