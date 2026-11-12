#!/usr/bin/env node
/**
 * Фикстура GUI-сценария ошибки 3ebb6512 «В дневниковых записях не отмечаются
 * ссылками синонимы мыслей».
 *
 * Воспроизведение заказчика: мысль с `*`-синонимами («Пасечн*», «Виктор*»,
 * «виктор* иванович*») и две дневниковые записи — ОДНА привязана к этой мысли
 * (чипс), вторая живёт только на HOME. В телах — словоформы, которые обязаны
 * подчёркиваться: «Пасечного», «Пасечный,», «Виктором Ивановичем».
 *
 * Разница между записями и есть предмет ошибки: лента передавала в скан
 * упоминаний исключением ПЕРВУЮ ПРИВЯЗАННУЮ мысль (`attachmentOwnerForRow`),
 * поэтому у привязанной записи исчезали ВСЕ упоминания этой мысли — имя, его
 * части и синонимы; непривязанная (исключался HOME) их показывала.
 *
 * Засеивается поверх штатной фикстуры стенда (`--seed-name`/`--seed-title`):
 *   - штатная мысль стенда (`--center-id`) переименовывается в «Пасечный Виктор
 *     Иванович» и получает `*`-синонимы;
 *   - запись 1 — цели HOME + эта мысль (чипс), тело с «Пасечного»/«Пасечный,»;
 *   - запись 2 — цель только HOME, тело с «Виктором Ивановичем».
 *
 * Обе записи датированы «сейчас», поэтому попадают в дневной период «Дневника»
 * по умолчанию. Скрипт идемпотентен: повторный запуск переиспользует мысль по
 * id и записи по телу.
 */
import path from 'node:path';

/** Заголовок мысли-владельца записи: имя заказчика из карточки ошибки. */
const OWNER_TITLE = 'Пасечный Виктор Иванович';
/** `*`-синонимы заказчика (карточка 3ebb6512). */
const OWNER_SYNONYMS = ['Пасечн*', 'Виктор*', 'Пасечн* Виктор*', 'виктор* иванович*'];

const ATTACHED_BODY =
  'Поздравление Пасечного 2026. Как сказал сам Пасечный, встречаемся в пятницу.';
const DETACHED_BODY = 'Созвон с Виктором Ивановичем — обсудили сроки.';

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

/** Требование изоляции стенда: каталог данных обязан быть внутри `.tmp/`. */
function assertIsolatedDataDir(dataDir) {
  const tmpMarker = `${path.sep}.tmp${path.sep}`;
  if (!`${dataDir}${path.sep}`.includes(tmpMarker)) {
    throw new Error(`отказ: каталог данных вне .tmp/: ${dataDir}`);
  }
}

/** Список из ответа (`sendList`: массив или `{ items }`). */
function listOf(page) {
  if (Array.isArray(page)) return page;
  return Array.isArray(page?.items) ? page.items : [];
}

/** Все активные мысли сети. Пустой отбор «Структур» отдаёт только HOME и сирот,
 *  поэтому критерий `active: true` задан явно (контракт `POST /thoughts/query`). */
async function loadThoughts(opts) {
  const all = [];
  for (let offset = 0; ; offset += 100) {
    const page = await rest(opts, 'POST', `/networks/${opts.networkId}/thoughts/query`, {
      active: true,
      limit: 100,
      offset,
    });
    const items = listOf(page);
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

/** Диапазон «целые сутки сегодня» в UTC-инстансах (ADR 994d076a). */
function todayPeriod() {
  const now = new Date();
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { from: from.toISOString(), to: to.toISOString(), now: now.toISOString() };
}

/** Есть ли уже хроно-запись с таким телом у любой цели HOME. */
async function findRecordByBody(opts, homeId, bodyMd) {
  const comments = listOf(
    await rest(opts, 'GET', `/networks/${opts.networkId}/thoughts/${homeId}/comments`),
  );
  return comments.find((c) => c.kind === 'chronological' && c.body_md === bodyMd) ?? null;
}

async function ensureRecord(opts, homeId, bodyMd, targetThoughtId) {
  const existing = await findRecordByBody(opts, homeId, bodyMd);
  if (existing !== null) return { comment: existing, created: false };
  const period = todayPeriod();
  const targets = [{ owner_type: 'thought', owner_id: homeId }];
  if (targetThoughtId !== null) {
    targets.push({ owner_type: 'thought', owner_id: targetThoughtId });
  }
  const comment = await rest(opts, 'POST', `/networks/${opts.networkId}/comments`, {
    kind: 'chronological',
    title: null,
    body_md: bodyMd,
    valid_from: period.now,
    valid_to: period.now,
    use_time: false,
    targets,
  });
  return { comment, created: true };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      'node client/scripts/ui-probe.3ebb6512-seed.mjs ' +
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

  const thoughts = await loadThoughts(opts);
  const home = thoughts.find((item) => item.title === 'HOME');
  if (home === undefined) throw new Error('в сети не найдена корневая мысль HOME');
  const owner = thoughts.find((item) => item.id === opts.centerId);
  if (owner === undefined) {
    throw new Error(`штатная мысль стенда ${opts.centerId} не найдена в сети`);
  }

  // 1. Мысль-владелец записи: имя и `*`-синонимы заказчика.
  const updated = await rest(opts, 'PATCH', `/networks/${opts.networkId}/thoughts/${owner.id}`, {
    title: OWNER_TITLE,
    synonyms: OWNER_SYNONYMS,
  });

  // 2. Запись, ПРИВЯЗАННАЯ к этой мысли (чипс) — воспроизведение ошибки.
  const attached = await ensureRecord(opts, home.id, ATTACHED_BODY, owner.id);
  // 3. Запись без привязки к мысли (только HOME) — контрольная.
  const detached = await ensureRecord(opts, home.id, DETACHED_BODY, null);

  process.stdout.write(
    `ui-probe-seed 3ebb6512: мысль «${updated.title}» (${updated.id}, ` +
      `синонимы ${OWNER_SYNONYMS.length}), запись с чипсом ${attached.comment.id} ` +
      `(${attached.created ? 'создана' : 'была'}), запись без чипса ${detached.comment.id} ` +
      `(${detached.created ? 'создана' : 'была'}), HOME ${home.id}\n`,
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(
      `ui-probe-seed 3ebb6512: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
