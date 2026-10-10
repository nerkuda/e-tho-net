#!/usr/bin/env node
/**
 * ui-probe-stand — подъём изолированного GUI-стенда клиента ETN ОДНОЙ командой
 * (задача 38ef87cc).
 *
 * Одна команда делает всё, что раньше делалось многошаговым ручным рецептом
 * (он перенесён в `client/scripts/ui-probe.md`):
 *   1. готовит ИЗОЛИРОВАННЫЙ каталог данных (`--data-from` — копия данных
 *      полигона, иначе свежая инициализация во временном `.tmp/ui-stand/<id>`);
 *   2. поднимает сервер ETN на этом каталоге и ждёт готовности (health);
 *   3. засеивает детерминированную пробную сеть (можно отключить `--no-seed`);
 *   4. поднимает СКРЫТЫЙ клиент обёрткой `ui-probe-launch.mjs` (невидимое окно,
 *      изолированный профиль — клиент пользователя не затрагивается,
 *      грабли 91720eda);
 *   5. по `--scenario <file>` прогоняет сценарий через `ui-probe.mjs`, подставив
 *      id засеянных сущностей (`--var`) и адрес/ключ стенда (`--api`), после
 *      чего всё гасит и возвращает код прогона; без `--scenario` — оставляет
 *      стенд живым до Ctrl+C и печатает готовую команду прогона.
 *
 * Данные стенда — только во временном каталоге (`.tmp/` в .gitignore), живые
 * данные полигона не изменяются. Никаких видимых окон.
 *
 * Зависимостей нет: встроенные `fetch` (Node 22) и `node:child_process`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(clientDir, '..');
const serverDir = path.join(repoRoot, 'server');

const HELP = `ui-probe-stand — изолированный GUI-стенд клиента ETN одной командой.

Использование:
  node client/scripts/ui-probe-stand.mjs [опции]

Опции:
      --scenario <file>  JSON-сценарий (шаблон с {{подстановками}}). Задан —
                         стенд поднимется, прогонит сценарий и погаснет.
      --data-from <dir>  Каталог данных для КОПИИ (полигон). Требует --api-key
                         (ключ того каталога); без него — свежая инициализация.
      --api-key <key>    API-key для копии данных (--data-from).
      --server-port <n>  Порт сервера (по умолчанию — свободный).
      --cdp-port <n>     Порт CDP клиента (по умолчанию — свободный).
      --out <dir>        Каталог отчёта прогона (по умолчанию <стенд>/out).
      --work <dir>       Каталог стенда (по умолчанию .tmp/ui-stand/<id>).
      --no-seed          Не засеивать пробную сеть.
      --seed-name <s>    Имя пробной сети (по умолчанию «GUI-стенд»).
      --seed-title <s>   Заголовок пробной мысли (по умолчанию «Проба стенда»).
      --seed-comment <s> Начальный текст постоянного комментария мысли.
      --keep             Не удалять каталог стенда после прогона сценария.
  -h, --help             Эта справка.

Требуется собранный сервер (npm -w @etn/server run build) и собранный клиент
(npm -w @etn/client run build). Сценарий запускается дочерним ui-probe.mjs.
Код возврата: код прогона сценария (0 — успех), либо 1/2 при ошибке стенда.
`;

/** Разбор аргументов стенда (ошибка → Error, код возврата 2). */
export function parseArgs(argv) {
  const opts = {
    scenario: null,
    dataFrom: null,
    apiKey: null,
    serverPort: 0,
    cdpPort: 0,
    out: null,
    work: null,
    seed: true,
    seedName: 'GUI-стенд',
    seedTitle: 'Проба стенда',
    seedComment: 'стартовый текст',
    keep: false,
    help: false,
  };
  const need = (value, flag) => {
    if (value === undefined) throw new Error(`аргумент ${flag} требует значения`);
    return value;
  };
  const int = (value, flag) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${flag} требует целое 0..65535`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--scenario':
        opts.scenario = path.resolve(need(argv[i + 1], arg));
        i += 1;
        break;
      case '--data-from':
        opts.dataFrom = path.resolve(need(argv[i + 1], arg));
        i += 1;
        break;
      case '--api-key':
        opts.apiKey = need(argv[i + 1], arg);
        i += 1;
        break;
      case '--server-port':
        opts.serverPort = int(need(argv[i + 1], arg), arg);
        i += 1;
        break;
      case '--cdp-port':
        opts.cdpPort = int(need(argv[i + 1], arg), arg);
        i += 1;
        break;
      case '--out':
        opts.out = path.resolve(need(argv[i + 1], arg));
        i += 1;
        break;
      case '--work':
        opts.work = path.resolve(need(argv[i + 1], arg));
        i += 1;
        break;
      case '--no-seed':
        opts.seed = false;
        break;
      case '--seed-name':
        opts.seedName = need(argv[i + 1], arg);
        i += 1;
        break;
      case '--seed-title':
        opts.seedTitle = need(argv[i + 1], arg);
        i += 1;
        break;
      case '--seed-comment':
        opts.seedComment = need(argv[i + 1], arg);
        i += 1;
        break;
      case '--keep':
        opts.keep = true;
        break;
      default:
        throw new Error(`неизвестный аргумент «${arg}» (справка: --help)`);
    }
  }
  return opts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Убрать каталог стенда не роняя прогон. Лок профиля Electron может держаться
 * ещё мгновение после `taskkill` (`EBUSY`/`EPERM` на leveldb) — повторяем с
 * паузой. Уборка НИКОГДА не бросает: её сбой не должен перекрывать код прогона
 * (успешный сценарий обязан вернуть 0). Недоступный каталог оставляем на диске.
 * @returns {Promise<boolean>} true — каталог удалён.
 */
async function removeDirWithRetry(dir, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      const code = err instanceof Error ? err.code : undefined;
      // Занят/нет прав — дать локену отпустить; прочие ошибки тоже не фатальны.
      if (attempt === attempts - 1) return false;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY' && code !== 'ENOENT') {
        return false;
      }
      await sleep(300);
    }
  }
  return false;
}

/** Свободный TCP-порт (0.0.0.0:0 → системный выбор). */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Погасить процесс и всё его дерево (важно: обёртка порождает Electron). */
function killTree(child) {
  if (child.pid === undefined || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    } catch {
      // taskkill недоступен — падать до обычного kill
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // процесс уже умер
  }
}

/** Запустить дочерний процесс node, транслируя его вывод с префиксом. */
function spawnNode(entry, args, { env = {} } = {}) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  const label = `[${path.basename(entry, '.mjs').replace(/\.js$/, '')}]`;
  const sink = (chunk) => {
    const text = chunk.toString();
    log += text;
    process.stdout.write(`${label} ${text}`);
  };
  child.stdout?.on('data', sink);
  child.stderr?.on('data', sink);
  return { child, getLog: () => log };
}

/** Ждать готовности HTTP-эндпоинта (health/CDP-version). */
async function waitHttp(url, timeoutMs, isAlive) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive()) return false;
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // ещё не поднялся
    }
    await sleep(250);
  }
  return false;
}

/** Выполнить REST-запрос к серверу стенда; вернуть развёрнутое `data`. */
async function rest(base, key, method, apiPath, body) {
  const headers = { authorization: `Bearer ${key}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // не-JSON — вернём строкой
  }
  if (!res.ok) {
    throw new Error(`REST ${method} ${apiPath}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  if (parsed !== null && typeof parsed === 'object' && 'data' in parsed) return parsed.data;
  return parsed;
}

/** Извлечь API-key из вывода `etn init`. */
export function parseInitKey(log) {
  const match = /etn_[0-9a-fA-F]{16,}/.exec(log);
  if (match === null) throw new Error('не удалось извлечь API-key из вывода etn init');
  return match[0];
}

/**
 * Засеять детерминированную пробную сеть: сеть → HOME → мысль с постоянным
 * комментарием (дочерняя HOME, чтобы попасть на холст фокуса).
 * @returns {{networkId:string, networkName:string, homeId:string, thoughtId:string}}
 */
async function seedStand(base, key, opts) {
  const network = await rest(base, key, 'POST', '/networks', { display_name: opts.seedName });
  const networkId = network.id;
  const items = await rest(base, key, 'POST', `/networks/${networkId}/thoughts/query`, { limit: 50 });
  const list = Array.isArray(items) ? items : items.items;
  const home = (list ?? []).find((item) => item.title === 'HOME');
  if (home === undefined) throw new Error('в новой сети не найдена корневая мысль HOME');
  const thought = await rest(base, key, 'POST', `/networks/${networkId}/thoughts`, {
    title: opts.seedTitle,
    comment: { body_md: opts.seedComment },
    create_link: { direction: 'parent', target_thought_id: home.id },
  });
  return { networkId, networkName: opts.seedName, homeId: home.id, thoughtId: thought.id };
}

/** Подтянуть id/ключ/адрес сценарию; собрать команду ui-probe. */
export function buildProbeArgs(opts, ports, seed, key) {
  const args = [path.join(clientDir, 'scripts', 'ui-probe.mjs')];
  // В интерактивном режиме сценария нет — не подставляем «--scenario null».
  if (opts.scenario !== null) args.push('--scenario', opts.scenario);
  if (opts.out !== null) args.push('--out', opts.out);
  args.push(
    '--port',
    String(ports.cdp),
    '--api',
    ports.apiBase,
    '--api-key',
    key,
    // Подстановки для онбординга и шагов api/селекторов сценария.
    '--var',
    `serverUrl=${ports.serverRoot}`,
    '--var',
    `apiKey=${key}`,
    '--var',
    `seedTitle=${opts.seedTitle}`,
    '--var',
    `seedComment=${opts.seedComment}`,
  );
  if (seed !== null) {
    args.push('--var', `networkId=${seed.networkId}`);
    args.push('--var', `networkName=${seed.networkName}`);
    args.push('--var', `thoughtId=${seed.thoughtId}`);
    args.push('--var', `homeId=${seed.homeId}`);
  }
  return args;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const cliEntry = path.join(serverDir, 'dist', 'cli.js');
  const serverEntry = path.join(serverDir, 'dist', 'index.js');
  if (!existsSync(cliEntry) || !existsSync(serverEntry)) {
    process.stderr.write('ui-probe-stand: нет собранного сервера; выполните npm -w @etn/server run build\n');
    return 1;
  }
  const launcherEntry = path.join(clientDir, 'scripts', 'ui-probe-launch.mjs');

  const stamp = `${Date.now()}-${process.pid}`;
  const work = opts.work ?? path.join(repoRoot, '.tmp', 'ui-stand', stamp);
  const dataDir = path.join(work, 'data');
  const profileDir = path.join(work, 'profile');
  const outDir = opts.out ?? path.join(work, 'out');
  mkdirSync(work, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  opts.out = outDir;

  const serverPort = opts.serverPort > 0 ? opts.serverPort : await freePort();
  const cdpPort = opts.cdpPort > 0 ? opts.cdpPort : await freePort();
  const serverRoot = `http://127.0.0.1:${serverPort}`;
  const apiBase = `${serverRoot}/api/v1`;

  const children = [];
  const stopAll = () => {
    for (const entry of children) killTree(entry.child);
  };
  process.on('SIGINT', () => {
    stopAll();
    process.exitCode = 130;
  });

  try {
    // --- 1. Данные: копия полигона либо свежая инициализация --------------
    let apiKey = opts.apiKey;
    if (opts.dataFrom !== null) {
      if (!existsSync(opts.dataFrom)) throw new Error(`--data-from: каталог не найден: ${opts.dataFrom}`);
      cpSync(opts.dataFrom, dataDir, { recursive: true });
      if (apiKey === null) {
        throw new Error('--data-from требует --api-key (ключ того каталога данных)');
      }
      process.stdout.write(`ui-probe-stand: данные скопированы из ${opts.dataFrom}\n`);
    } else {
      mkdirSync(dataDir, { recursive: true });
      const init = spawnNode(cliEntry, ['init', '--username', 'stand'], {
        env: { ETN_DATA_DIR: dataDir },
      });
      children.push(init);
      const code = await new Promise((resolve) => init.child.on('exit', resolve));
      if (code !== 0) throw new Error(`etn init завершился с кодом ${code}\n${init.getLog()}`);
      apiKey = parseInitKey(init.getLog());
      children.pop();
    }

    // --- 2. Сервер ---------------------------------------------------------
    const server = spawnNode(serverEntry, [], {
      env: { ETN_DATA_DIR: dataDir, ETN_PORT: String(serverPort), ETN_HOST: '127.0.0.1' },
    });
    children.push(server);
    if (!(await waitHttp(`${apiBase}/health`, 30000, () => server.child.exitCode === null))) {
      throw new Error(`сервер не поднялся на порту ${serverPort}\n${server.getLog().slice(-1000)}`);
    }
    process.stdout.write(`ui-probe-stand: сервер готов (${apiBase})\n`);

    // --- 3. Сид пробной сети ----------------------------------------------
    let seed = null;
    if (opts.seed) {
      seed = await seedStand(apiBase, apiKey, opts);
      process.stdout.write(
        `ui-probe-stand: сеть «${seed.networkName}» (${seed.networkId}), мысль ${seed.thoughtId}\n`,
      );
    }

    // --- 4. Скрытый клиент -------------------------------------------------
    const launcher = spawnNode(launcherEntry, ['--port', String(cdpPort), '--profile', profileDir]);
    children.push(launcher);
    if (
      !(await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`, 60000, () => launcher.child.exitCode === null))
    ) {
      throw new Error(`скрытый клиент не поднял CDP на порту ${cdpPort}\n${launcher.getLog().slice(-1000)}`);
    }
    process.stdout.write(`ui-probe-stand: клиент готов (CDP http://127.0.0.1:${cdpPort})\n`);

    const probeArgs = buildProbeArgs(opts, { cdp: cdpPort, apiBase, serverRoot }, seed, apiKey);

    // --- 5а. Прогон сценария ----------------------------------------------
    if (opts.scenario !== null) {
      const probe = spawnNode(probeArgs[0], probeArgs.slice(1));
      children.push(probe);
      const code = await new Promise((resolve) => probe.child.on('exit', resolve));
      process.stdout.write(
        `ui-probe-stand: сценарий завершён (код ${code}); стенд в ${work}\n`,
      );
      return code ?? 1;
    }

    // --- 5б. Интерактивный стенд ------------------------------------------
    const printable = probeArgs.filter((arg) => arg != null);
    process.stdout.write(
      'ui-probe-stand: стенд поднят. Прогон сценария:\n' +
        `  node ${printable.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}\n` +
        `ui-probe-stand: каталог стенда ${work}\n` +
        'ui-probe-stand: Ctrl+C — остановить стенд.\n',
    );
    await new Promise((resolve) => {
      process.on('SIGINT', resolve);
      launcher.child.on('exit', resolve);
    });
    return 0;
  } finally {
    stopAll();
    if (opts.scenario !== null && !opts.keep) {
      // Уборка не должна перекрывать код прогона: лок профиля после taskkill
      // может держаться ещё мгновение (EBUSY) — повторяем, но не бросаем.
      const removed = await removeDirWithRetry(work);
      if (!removed) {
        process.stderr.write(
          `ui-probe-stand: временный каталог занят, оставлен: ${work}\n`,
        );
      }
    }
  }
}

// Запуск только при прямом вызове (импорт из тестов не должен поднимать стенд).
const invokedScript = process.argv[1];
if (invokedScript !== undefined && path.resolve(invokedScript) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`ui-probe-stand: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    });
}