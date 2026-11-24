#!/usr/bin/env node
/**
 * Фикстура GUI-сценариев ошибки 39d78d2a (бейдж «сегодня» пересчитывался на
 * любой `comment.updated` в сети).
 *
 * Стенд засеивает сеть: HOME и мысль `{{thoughtId}}` с постоянным комментарием.
 * Фикстура готовит две вещи:
 *   - комментарий, который сценарий правит через REST как «посторонний»: у
 *     мысль-субъекта напоминания он не владелец, текст в счёт напоминаний не
 *     входит;
 *   - напоминание владельца о HOME с вхождением ЧАС НАЗАД — оно попадает в окно
 *     бейджа («просрочка…сегодня») и даёт счётчик 1 сразу при монтировании.
 *
 * `--no-reminder` — режим второго сценария (положительная ветка): напоминание
 * заводит сам сценарий шагом `api` (иначе событие `reminders.changed` случилось
 * бы ДО подключения клиента, и проверить реакцию бейджа было бы нечем). Тогда
 * фикстура печатает только id комментария и `anchorAt` для создания.
 *
 * Скрипт идемпотентен: повторный запуск переиспользует найденные сущности.
 */
import path from 'node:path';

/** Тело «постороннего» комментария до правки. */
const COMMENT_BODY = 'Посторонний комментарий стенда 39d78d2a';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    if (arg === '--no-reminder') {
      opts.noReminder = true;
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

/** Постоянный комментарий мысли; нет — создать. */
async function ensurePermanentComment(opts) {
  const existing = listOf(
    await rest(opts, 'GET', `/networks/${opts.networkId}/thoughts/${opts.centerId}/comments`),
  ).find((comment) => comment.kind === 'permanent');
  if (existing !== undefined) return existing.id;
  const created = await rest(
    opts,
    'POST',
    `/networks/${opts.networkId}/thoughts/${opts.centerId}/comments`,
    { kind: 'permanent', body_md: COMMENT_BODY },
  );
  return created.id;
}

/** Напоминание владельца о HOME с вхождением час назад; нет — создать. */
async function ensureReminder(opts, subjectId, anchorAt) {
  const list = await rest(opts, 'GET', `/networks/${opts.networkId}/reminders`);
  const rows = Array.isArray(list?.reminders) ? list.reminders : [];
  const existing = rows.find(
    (row) =>
      row.state === 'active' && row.subject_type === 'thought' && row.subject_id === subjectId,
  );
  if (existing !== undefined) return existing.id;
  const created = await rest(opts, 'POST', `/networks/${opts.networkId}/reminders`, {
    subject_type: 'thought',
    subject_id: subjectId,
    kind: 'one',
    schedule: { type: 'once' },
    anchor_at: anchorAt,
  });
  return created.id;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      'node client/scripts/ui-probe.39d78d2a-reminder-badge-seed.mjs ' +
        '--data-dir <dir> --network-id <uuid> --center-id <uuid> --api <url> --api-key <key> ' +
        '[--no-reminder]\n',
    );
    return 0;
  }
  for (const key of ['dataDir', 'networkId', 'centerId', 'api', 'apiKey']) {
    if (typeof opts[key] !== 'string' || opts[key] === '') {
      throw new Error(`не задан --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    }
  }
  assertIsolatedDataDir(opts.dataDir);

  // 1. HOME — субъект напоминания (сид стенда её не возвращает в переменных).
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
  const home = thoughts.find((item) => item.title === 'HOME');
  if (home === undefined) throw new Error('в сети не найдена корневая мысль HOME');

  // 2. Посторонний комментарий и опорный момент напоминания.
  const commentId = await ensurePermanentComment(opts);
  const anchorAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // 3. Напоминание (в положительной ветке его заводит сценарий событием).
  let reminderId = '';
  if (opts.noReminder !== true) {
    reminderId = await ensureReminder(opts, home.id, anchorAt);
  }

  process.stdout.write(
    `ui-probe-seed 39d78d2a: комментарий ${commentId}, ` +
      (reminderId === '' ? 'напоминание создаёт сценарий' : `напоминание ${reminderId}`) +
      `, якорь ${anchorAt}\n`,
  );
  // Сценарию нужны id и момент — стенд превращает скаляры в `--var`.
  process.stdout.write(`${JSON.stringify({ commentId, reminderId, anchorAt, homeId: home.id })}\n`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(
      `ui-probe-seed 39d78d2a: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
