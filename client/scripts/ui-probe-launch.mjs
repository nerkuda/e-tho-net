#!/usr/bin/env node
/**
 * ui-probe-launch — запуск тестового клиента ETN для сценарных UI-проверок
 * (задача 5c5b30e2).
 *
 * Одна команда делает всё, что легко сделать неправильно вручную:
 *  - генерирует УНИКАЛЬНЫЙ изолированный профиль (`--user-data-dir`), поэтому
 *    тестовый экземпляр никогда не делит профиль, лок single-instance и БД с
 *    клиентом пользователя (именно из-за этого окно пользователя всплывало);
 *  - ставит `ETN_HIDDEN_WINDOW=1` — окно невидимо и фокус не забирает;
 *  - включает CDP на выбранном порту и ждёт его готовности;
 *  - печатает готовую команду прогона `ui-probe.mjs` и держит клиент живым до
 *    Ctrl+C (или до закрытия клиента).
 *
 * По умолчанию работает с СОБРАННЫМ клиентом (`client/out`) — так запуск
 * предсказуем и не конфликтует с Vite-сервером. Сборка: `npm -w @etn/client run
 * build`.
 *
 * Зависимостей нет — только встроенный `fetch` (Node 22).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(clientDir, '..');

const HELP = `ui-probe-launch — поднять невидимый тестовый клиент ETN для ui-probe.

Использование:
  node client/scripts/ui-probe-launch.mjs [опции]

Опции:
      --port <n>        Порт CDP (по умолчанию 9333).
      --profile <dir>   Каталог профиля (по умолчанию уникальный под .tmp/ui-probe).
      --app <dir>       Каталог собранного клиента (по умолчанию client/).
      --wait <ms>       Ждать готовности CDP не дольше (по умолчанию 30000).
  -h, --help            Эта справка.

Требуется собранный клиент: npm -w @etn/client run build.
Профиль всегда изолированный — тестовый режим откажется работать на дефолтном.
Код возврата: 0 — клиент завершился штатно; 1 — ошибка запуска/ожидания CDP;
иначе — код завершения клиента.
`;

/** Разбор аргументов; при ошибке бросает Error (код возврата 2). */
function parseArgs(argv) {
  const opts = {
    port: 9333,
    profile: path.join(repoRoot, '.tmp', 'ui-probe', `profile-${Date.now()}-${process.pid}`),
    app: clientDir,
    wait: 30000,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    const value = argv[i + 1];
    const need = () => {
      if (value === undefined) throw new Error(`аргумент ${arg} требует значения`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--port': {
        const n = Number(need());
        if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error('--port требует целое 1..65535');
        opts.port = n;
        break;
      }
      case '--profile':
        opts.profile = path.resolve(need());
        break;
      case '--app':
        opts.app = path.resolve(need());
        break;
      case '--wait': {
        const n = Number(need());
        if (!Number.isInteger(n) || n <= 0) throw new Error('--wait требует целое число больше нуля');
        opts.wait = n;
        break;
      }
      default:
        throw new Error(`неизвестный аргумент «${arg}»`);
    }
  }
  return opts;
}

/** Путь к бинарю Electron из node_modules (без импорта типов). */
async function resolveElectron() {
  try {
    const mod = await import('electron');
    const bin = mod.default;
    if (typeof bin !== 'string' || bin === '') throw new Error('пустой путь к Electron');
    return bin;
  } catch (err) {
    throw new Error(
      `не удалось найти Electron (${err instanceof Error ? err.message : String(err)}); ` +
        'выполните npm install в корне репозитория',
    );
  }
}

/** Ожидание готовности CDP: true — поднялся, false — истёк таймаут. */
async function waitForCdp(port, timeoutMs, isChildAlive) {
  const url = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isChildAlive()) return false;
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // ещё не поднялся — ждём
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const builtMain = path.join(opts.app, 'out', 'main', 'index.js');
  if (!existsSync(builtMain)) {
    process.stderr.write(
      `ui-probe-launch: нет собранного клиента (${builtMain}); ` +
        'выполните npm -w @etn/client run build\n',
    );
    return 1;
  }

  const electronBin = await resolveElectron();
  mkdirSync(opts.profile, { recursive: true });

  process.stdout.write(`ui-probe-launch: профиль ${opts.profile}\n`);
  process.stdout.write(`ui-probe-launch: CDP http://127.0.0.1:${opts.port}\n`);

  const child = spawn(
    electronBin,
    ['.', `--remote-debugging-port=${opts.port}`, `--user-data-dir=${opts.profile}`],
    {
      cwd: opts.app,
      env: { ...process.env, ETN_HIDDEN_WINDOW: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let alive = true;
  child.stdout?.on('data', (chunk) => process.stdout.write(`[client] ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`[client] ${chunk}`));
  child.on('exit', (code, signal) => {
    alive = false;
    if (signal !== null) process.stderr.write(`ui-probe-launch: клиент завершён сигналом ${signal}\n`);
  });

  const stop = () => {
    if (alive) child.kill();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const ready = await waitForCdp(opts.port, opts.wait, () => alive);
  if (!ready) {
    const reason = alive ? `CDP не ответил за ${opts.wait} мс` : 'клиент завершился до готовности CDP';
    process.stderr.write(`ui-probe-launch: ${reason}\n`);
    stop();
    return 1;
  }

  process.stdout.write(
    `ui-probe-launch: клиент готов. Прогон сценария:\n` +
      `  node client/scripts/ui-probe.mjs --scenario <file.json> --port ${opts.port}\n` +
      'ui-probe-launch: Ctrl+C — остановить клиент.\n',
  );

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
  });
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`ui-probe-launch: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
