#!/usr/bin/env node
/**
 * ui-probe — штатный стенд сценарных UI-проверок клиента ETN (задача 5c5b30e2).
 *
 * Подключается к УЖЕ ЗАПУЩЕННОМУ клиенту по Chrome DevTools Protocol, прогоняет
 * JSON-сценарий из нескольких шагов одним запуском и пишет JSON-отчёт и
 * скриншоты. Рассчитан на один вызов вместо череды одиночных команд: действия,
 * пробы и снимки — в одном прогоне.
 *
 * Зависимостей нет: CDP-клиент собран на встроенных `fetch` и `WebSocket`
 * (Node 22). Разбор сценария вынесен в `./ui-probe-scenario.mjs` и покрыт
 * юнит-тестами.
 *
 * Запуск клиента для проверок — только через обёртку `./ui-probe-launch.mjs`
 * (обёртка работает с СОБРАННЫМ клиентом `client/out`; сборка —
 * `npm -w @etn/client run build`): она сама генерирует изолированный профиль,
 * ставит `ETN_HIDDEN_WINDOW=1`, включает CDP и ждёт его готовности.
 *
 *   # клиент без окна и фокуса + порт отладки + УНИКАЛЬНЫЙ профиль
 *   node client/scripts/ui-probe-launch.mjs --port 9333
 *
 *   # прогон сценария (порт — тот же, что у клиента)
 *   node client/scripts/ui-probe.mjs --scenario scenario.json --out .tmp/verify/out --port 9333
 *
 * Изолированный профиль обязателен: без него `ETN_HIDDEN_WINDOW=1`
 * отказывается стартовать — дефолтный профиль общий с работающим клиентом
 * пользователя, и тестовый экземпляр поднял бы ЕГО окно и отобрал фокус.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ScenarioError,
  parseScenario,
} from './ui-probe-scenario.mjs';

/** Ошибки вызова/подключения — код возврата 2 (в отличие от провала шага, 1). */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const HELP = `ui-probe — сценарный прогон UI клиента ETN через CDP.

Использование:
  node client/scripts/ui-probe.mjs --scenario <file.json> [опции]

Опции:
  -s, --scenario <file>  JSON-сценарий (обязательно).
  -o, --out <dir>        Каталог отчёта и скриншотов (по умолчанию ui-probe-out).
      --host <host>      Хост CDP (по умолчанию 127.0.0.1).
      --port <n>         Порт CDP (по умолчанию 9222).
      --cdp <url>        Полный базовый URL CDP; перекрывает --host/--port
                         (например http://127.0.0.1:9333).
      --target <type>    Тип цели CDP (по умолчанию page).
      --timeout <ms>     Переопределить лимит на шаг для всего сценария.
  -h, --help             Эта справка.

Код возврата: 0 — все шаги прошли; 1 — провал/таймаут шага; 2 — ошибка
вызова, сценария или подключения к CDP.

Как запустить клиент для проверок (единственный штатный путь — обёртка):

  node client/scripts/ui-probe-launch.mjs --port 9333

  Обёртка работает с собранным клиентом (npm -w @etn/client run build),
  генерирует уникальный изолированный профиль, ставит ETN_HIDDEN_WINDOW=1,
  включает CDP и ждёт готовности.
  ETN_HIDDEN_WINDOW=1 — окно невидимо (opacity 0), не в панели задач и не
  забирает фокус; рендер при этом живой, Page.captureScreenshot даёт кадр.
  Изолированный профиль обязателен: на дефолтном (общем с клиентом
  пользователя) тестовый режим отказывается стартовать — иначе поднял бы
  окно пользователя и отобрал фокус.

Шаги сценария (ровно одно действие на шаг, плюс необязательные name/timeout):
  { "key": "ArrowDown", "modifiers": ["shift"] }   стрелки, Tab, Enter, Esc…
  { "click": "#sel" } | { "click": { "selector": "#sel", "at": [4, 4] } }
    | { "click": [640, 400] } | { "click": { "x": 10, "y": 20 } }
  { "text": "строка" }                              ввод текста (Input.insertText)
  { "waitFor": "expr" } | { "waitFor": { "expression": "…", "frames": 2 } }
    | { "waitFor": 2 }                              условие и/или N кадров rAF
  { "probe": "expr" } | { "probe": { "name": "rows", "expression": "…" } }
  { "shot": "01.png" } | { "shot": { "file": "01.png", "clip": "#sel" } }
    clip: селектор | [x, y, w, h] | { x, y, width, height }
  { "eval": "expr" } | { "eval": { "name": "focus", "expression": "…" } }

Ожидание — только по условию (поллинг выражения) или по кадрам отрисовки
(двойной requestAnimationFrame), фиксированных пауз нет. Отчёт: <out>/report.json.
Пример сценария: client/scripts/ui-probe.scenario.example.json.
`;

function parseArgs(argv) {
  const opts = {
    scenario: null,
    out: 'ui-probe-out',
    host: '127.0.0.1',
    port: 9222,
    cdp: null,
    target: 'page',
    timeout: null,
    help: false,
  };
  const need = (value, flag) => {
    if (value === undefined) throw new UsageError(`аргумент ${flag} требует значения`);
    return value;
  };
  const int = (value, flag) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new UsageError(`аргумент ${flag} требует целого числа больше нуля`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-s':
      case '--scenario':
        opts.scenario = need(argv[i + 1], arg);
        i += 1;
        break;
      case '-o':
      case '--out':
        opts.out = need(argv[i + 1], arg);
        i += 1;
        break;
      case '--host':
        opts.host = need(argv[i + 1], arg);
        i += 1;
        break;
      case '--port':
        opts.port = int(need(argv[i + 1], arg), arg);
        i += 1;
        break;
      case '--cdp':
        opts.cdp = need(argv[i + 1], arg);
        i += 1;
        break;
      case '--target':
        opts.target = need(argv[i + 1], arg);
        i += 1;
        break;
      case '--timeout':
        opts.timeout = int(need(argv[i + 1], arg), arg);
        i += 1;
        break;
      default:
        throw new UsageError(`неизвестный аргумент «${arg}» (справка: --help)`);
    }
  }
  if (!opts.help && opts.scenario === null) {
    throw new UsageError('не задан сценарий: --scenario <file> (справка: --help)');
  }
  return opts;
}

/** Минимальный CDP-клиент: send(method, params) с корреляцией по id. */
class CdpClient {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #closed = false;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => this.#onMessage(event));
    ws.addEventListener('close', () => this.#failAll('соединение CDP закрыто'));
  }

  static connect(url) {
    const ws = new globalThis.WebSocket(url);
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(new CdpClient(ws)));
      ws.addEventListener('error', () => reject(new UsageError(`не удалось открыть WebSocket CDP: ${url}`)));
    });
  }

  #failAll(message) {
    this.#closed = true;
    for (const { reject } of this.#pending.values()) reject(new Error(message));
    this.#pending.clear();
  }

  #onMessage(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof data.id !== 'number' || !this.#pending.has(data.id)) return;
    const { resolve, reject } = this.#pending.get(data.id);
    this.#pending.delete(data.id);
    if (data.error !== undefined) {
      const detail = data.error.data === undefined ? '' : ` (${data.error.data})`;
      reject(new Error(`${data.error.message ?? 'ошибка CDP'}${detail}`));
    } else {
      resolve(data.result);
    }
  }

  send(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error('соединение CDP закрыто'));
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      // закрытие уже мёртвого сокета не должно ронять прогон
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Найти цель CDP нужного типа или объяснить, что клиент не поднят. */
async function resolvePageTarget(base, targetType) {
  const url = `${base.replace(/\/+$/, '')}/json/list`;
  let list;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    list = await response.json();
  } catch (err) {
    throw new UsageError(
      `не удалось подключиться к CDP (${url}): ${err.message}. ` +
        'Клиент запущен с --remote-debugging-port?',
    );
  }
  if (!Array.isArray(list)) throw new UsageError(`CDP вернул не список целей: ${url}`);
  const target = list.find((item) => item.type === targetType && item.webSocketDebuggerUrl);
  if (target === undefined) {
    const kinds = list.map((item) => item.type).join(', ') || 'нет';
    throw new UsageError(`в CDP нет цели типа «${targetType}»; доступны: ${kinds}`);
  }
  return target;
}

async function evaluate(cdp, expression, { awaitPromise = true } = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (result.exceptionDetails !== undefined) {
    const exception = result.exceptionDetails.exception ?? {};
    const text = exception.description ?? result.exceptionDetails.text ?? 'исключение';
    throw new Error(`исключение в выражении: ${text}`);
  }
  return result.result?.value;
}

/** Подождать N кадров отрисовки (rAF-цепочка, без фиксированной паузы). */
function waitFrames(cdp, frames) {
  return evaluate(
    cdp,
    `new Promise((resolve) => { let left = ${frames}; const tick = () => { left -= 1; ` +
      'if (left <= 0) resolve(true); else requestAnimationFrame(tick); }; ' +
      'requestAnimationFrame(tick); })',
  );
}

/** Поллинг выражения до истины или таймаута (ожидание по условию). */
async function waitForExpression(cdp, expression, timeout) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  for (;;) {
    let truthy = false;
    try {
      truthy = Boolean(await evaluate(cdp, expression));
    } catch (err) {
      lastError = err;
    }
    if (truthy) return;
    if (Date.now() >= deadline) {
      const suffix = lastError === null ? '' : ` (последняя ошибка: ${lastError.message})`;
      throw new Error(`таймаут ${timeout} мс: условие не стало истинным${suffix}`);
    }
    await sleep(50);
  }
}

/** Прямоугольник элемента во вьюпорте; сам элемент подкручивается в вид. */
async function elementRect(cdp, selector) {
  const expression =
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
    'if (el === null) return null; ' +
    "el.scrollIntoView({ block: 'center', inline: 'nearest' }); " +
    'const r = el.getBoundingClientRect(); ' +
    'return { x: r.x, y: r.y, width: r.width, height: r.height }; })()';
  const rect = await evaluate(cdp, expression);
  if (rect === null || rect === undefined) throw new Error(`селектор не найден: ${selector}`);
  return rect;
}

async function doClick(cdp, spec) {
  let x;
  let y;
  if (spec.selector !== null) {
    const rect = await elementRect(cdp, spec.selector);
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error(`элемент «${spec.selector}» имеет нулевой размер`);
    }
    x = rect.x + (spec.at === null ? rect.width / 2 : spec.at[0]);
    y = rect.y + (spec.at === null ? rect.height / 2 : spec.at[1]);
  } else {
    x = spec.x;
    y = spec.y;
  }
  const px = Math.round(x);
  const py = Math.round(y);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: px,
    y: py,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: px,
    y: py,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

/** Печатный текст для клавиши (вставка — отдельным событием `char`). */
function printableText(key) {
  if ((key.modifiers & (1 | 2 | 4)) !== 0) return undefined;
  return key.key.length === 1 ? key.key : undefined;
}

async function doKey(cdp, key) {
  const base = {
    key: key.key,
    code: key.code,
    modifiers: key.modifiers,
    windowsVirtualKeyCode: key.keyCode,
    nativeVirtualKeyCode: key.keyCode,
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  const text = printableText(key);
  if (text !== undefined) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text });
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function doShot(cdp, shot, outDir) {
  const params = { format: 'png', fromSurface: true, captureBeyondViewport: false };
  if (shot.clip !== null) {
    let box;
    if (shot.clip.selector !== undefined) {
      const rect = await elementRect(cdp, shot.clip.selector);
      if (rect.width <= 0 || rect.height <= 0) {
        throw new Error(`обрезка: элемент «${shot.clip.selector}» нулевого размера`);
      }
      box = rect;
    } else {
      box = shot.clip;
    }
    params.clip = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.max(1, Math.round(box.width)),
      height: Math.max(1, Math.round(box.height)),
      scale: 1,
    };
  }
  const result = await cdp.send('Page.captureScreenshot', params);
  const absolute = path.join(outDir, shot.file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, Buffer.from(result.data, 'base64'));
  return shot.file;
}

/** Выполнить один шаг, сложив результат в запись отчёта `entry`. */
async function runStep(cdp, step, outDir, entry, report) {
  switch (step.kind) {
    case 'key':
      await doKey(cdp, step.key);
      await waitFrames(cdp, 2);
      break;
    case 'click':
      await doClick(cdp, step.click);
      await waitFrames(cdp, 2);
      break;
    case 'text':
      await cdp.send('Input.insertText', { text: step.text });
      await waitFrames(cdp, 2);
      break;
    case 'waitFor':
      if (step.waitFor.expression !== null) {
        await waitForExpression(cdp, step.waitFor.expression, step.timeout);
      }
      if (step.waitFor.frames > 0) {
        await waitFrames(cdp, step.waitFor.frames);
      }
      break;
    case 'probe': {
      const value = await evaluate(cdp, step.probe.expression);
      entry.probe = { name: step.probe.name, value };
      report.probes[step.probe.name] = value;
      break;
    }
    case 'eval':
      entry.eval = { name: step.eval.name, value: await evaluate(cdp, step.eval.expression) };
      break;
    case 'shot': {
      const file = await doShot(cdp, step.shot, outDir);
      entry.shot = file;
      report.shots.push(file);
      break;
    }
    default:
      throw new Error(`необработанное действие «${step.kind}»`);
  }
}

function withTimeout(timeout, promise, label) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`таймаут шага ${timeout} мс (${label})`)), timeout);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function formatStep(entry) {
  const status = entry.status === 'ok' ? 'ok  ' : 'FAIL';
  let detail = '';
  if (entry.probe !== undefined) detail = ` ${entry.probe.name} = ${JSON.stringify(entry.probe.value)}`;
  else if (entry.shot !== undefined) detail = ` → ${entry.shot}`;
  else if (entry.eval !== undefined) detail = ` ${entry.eval.name}`;
  else if (entry.error !== undefined) detail = ` — ${entry.error}`;
  return `${status} ${String(entry.index + 1).padStart(2)} ${entry.kind.padEnd(7)} ${entry.name}${detail} (${entry.ms} мс)`;
}

async function runScenario(cdp, scenario, outDir, base) {
  const report = {
    tool: 'ui-probe',
    scenario: scenario.name,
    cdp: base,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: 0,
    ok: false,
    steps: [],
    probes: {},
    shots: [],
  };
  const startedAt = Date.now();
  for (const step of scenario.steps) {
    const started = Date.now();
    const entry = { index: step.index, kind: step.kind, name: step.name, status: 'ok', ms: 0 };
    try {
      // Every step — including `waitFor` by frames — is bounded by the step
      // deadline, so a stalled frame supply cannot hang the run.
      await withTimeout(step.timeout, runStep(cdp, step, outDir, entry, report), step.name);
    } catch (err) {
      entry.status = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
    }
    entry.ms = Date.now() - started;
    report.steps.push(entry);
    process.stdout.write(`${formatStep(entry)}\n`);
    if (entry.status === 'failed') break;
  }
  report.ok = report.steps.every((entry) => entry.status === 'ok');
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  return report;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let scenario;
  try {
    scenario = parseScenario(readFileSync(opts.scenario, 'utf8'));
  } catch (err) {
    if (err instanceof ScenarioError) throw new UsageError(`сценарий не принят: ${err.message}`);
    throw new UsageError(`не удалось прочитать сценарий «${opts.scenario}»: ${err.message}`);
  }
  if (opts.timeout !== null) {
    scenario = {
      ...scenario,
      timeout: opts.timeout,
      steps: scenario.steps.map((step) => ({ ...step, timeout: opts.timeout })),
    };
  }

  const outDir = path.resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const base = opts.cdp ?? `http://${opts.host}:${opts.port}`;
  const target = await resolvePageTarget(base, opts.target);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  let report;
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    report = await runScenario(cdp, scenario, outDir, base);
  } finally {
    cdp.close();
  }

  const reportPath = path.join(outDir, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const passed = report.steps.filter((entry) => entry.status === 'ok').length;
  process.stdout.write(
    `ui-probe: сценарий «${scenario.name}» — ${passed}/${report.steps.length} ok за ${report.durationMs} мс\n` +
      `отчёт: ${reportPath}\n` +
      (report.shots.length > 0 ? `снимки: ${report.shots.join(', ')}\n` : ''),
  );
  return report.ok ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`ui-probe: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  });
