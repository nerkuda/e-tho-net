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
import { decodePng, runRegionChecks } from './ui-probe-image.mjs';

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
  -o, --out <dir>        Каталог отчёта (по умолчанию ui-probe-out).
      --host <host>      Хост CDP (по умолчанию 127.0.0.1).
      --port <n>         Порт CDP (по умолчанию 9222).
      --cdp <url>        Полный базовый URL CDP; перекрывает --host/--port.
      --target <type>    Тип цели CDP (по умолчанию page).
      --timeout <ms>     Переопределить лимит на шаг для всего сценария.
      --var <имя=знач.>  Подстановка {{имя}} в строках сценария (можно
                         повторять). Значения подставляет стенд (id сущностей).
      --api <url>        Базовый URL REST стенда для шагов api.
      --api-key <key>    API-key для шагов api (заголовок Authorization).
      --no-wake          Не «будить» страницу через CDP перед прогоном.
  -h, --help             Эта справка.

Перед прогоном раннер по умолчанию «будит» скрытое окно обёртки через CDP
(Page.bringToFront, Emulation.setFocusEmulationEnabled,
Page.setWebLifecycleState('active')) — иначе rAF/layout заморожены и условия
не наступают (грабли 03e33360). Отключить: --no-wake.

Код возврата: 0 — все шаги прошли; 1 — провал/таймаут шага или несошедшееся
ожидание; 2 — ошибка вызова, сценария или подключения к CDP.

Шаги сценария — см. client/scripts/ui-probe.md и
client/scripts/ui-probe.scenario.example.json. Отчёт: <out>/report.json и
<out>/report.txt (текст «шаг → проба → факт/ожидание»).
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
    vars: {},
    api: null,
    apiKey: null,
    wake: true,
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
      case '--var': {
        const pair = need(argv[i + 1], arg);
        const eq = pair.indexOf('=');
        if (eq <= 0) throw new UsageError('--var требует «имя=значение»');
        opts.vars[pair.slice(0, eq)] = pair.slice(eq + 1);
        i += 1;
        break;
      }
      case '--api':
        opts.api = need(argv[i + 1], arg);
        i += 1;
        break;
      case '--api-key':
        opts.apiKey = need(argv[i + 1], arg);
        i += 1;
        break;
      case '--no-wake':
        opts.wake = false;
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

/**
 * Подставить значения `--var` в строки сценария (`{{имя}}`). Рекурсивно по
 * объектам/массивам; неизвестная переменная — ошибка вызова (код 2).
 */
function substituteVars(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{([^{}]+)\}\}/g, (_match, raw) => {
      const key = raw.trim();
      if (!Object.prototype.hasOwnProperty.call(vars, key)) {
        throw new UsageError(`в сценарии нет значения переменной {{${key}}} (задайте --var ${key}=…)`);
      }
      return vars[key];
    });
  }
  if (Array.isArray(value)) return value.map((item) => substituteVars(item, vars));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = substituteVars(item, vars);
    return out;
  }
  return value;
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

/**
 * «Разбудить» скрытое окно обёртки через CDP. Без этого документ остаётся
 * `hidden`, rAF/layout заморожены и условия не наступают (грабли 03e33360).
 * Методы необязательные для старых сборок — сбой каждого проглатывается.
 */
async function wakePage(cdp) {
  const calls = [
    ['Page.bringToFront', {}],
    ['Emulation.setFocusEmulationEnabled', { enabled: true }],
    ['Page.setWebLifecycleState', { state: 'active' }],
  ];
  for (const [method, params] of calls) {
    try {
      await cdp.send(method, params);
    } catch {
      // метод не поддержан этой сборкой — следующий
    }
  }
}

/** Стабильная сериализация значения для сравнения «факт ↔ ожидание». */
function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Показать значение компактно (для текстового отчёта). */
function describeValue(value) {
  const text = typeof value === 'string' ? JSON.stringify(value) : stableStringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** Совпадают ли факт и ожидание (порядок ключей объектов не важен). */
function sameValue(actual, expected) {
  return stableStringify(actual) === stableStringify(expected);
}

/**
 * Выполнить шаг `api`: HTTP-запрос к серверу стенда ИЗ РАННЕРА.
 * Проверка эффекта на сервере/в БД — обход граблей aa5cf162 (CDP не видит
 * HTTP main-процесса Electron).
 */
async function doApi(step, apiConfig) {
  if (apiConfig.base === null) {
    throw new Error('шаг api требует базовый URL стенда: запустите с --api <url>');
  }
  const url = `${apiConfig.base.replace(/\/+$/, '')}${step.api.path}`;
  const headers = {};
  if (apiConfig.key !== null) headers.authorization = `Bearer ${apiConfig.key}`;
  let response;
  let text;
  try {
    response = await fetch(url, { method: step.api.method, headers });
    text = await response.text();
  } catch (err) {
    throw new Error(`api ${step.api.method} ${step.api.path}: ${err.message}`);
  }
  if (!response.ok) {
    throw new Error(`api ${step.api.method} ${step.api.path}: HTTP ${response.status}`);
  }
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // не-JSON тело оставляем строкой
  }
  const data =
    body !== null && typeof body === 'object' && !Array.isArray(body) && 'data' in body
      ? body.data
      : body;
  if (step.api.expression === null) return data;
  try {
    // Выражение пишет автор сценария (инструмент разработки, локальный прогон).
    const fn = new Function('data', `return (${step.api.expression});`);
    return fn(data);
  } catch (err) {
    throw new Error(`api ${step.api.path}: выражение не вычислено: ${err instanceof Error ? err.message : String(err)}`);
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

/** Прямоугольник кропа во вьюпорте: селектор элемента либо явные координаты. */
async function resolveClipBox(cdp, clip) {
  if (clip.selector !== undefined) {
    const rect = await elementRect(cdp, clip.selector);
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error(`обрезка: элемент «${clip.selector}» нулевого размера`);
    }
    return rect;
  }
  return clip;
}

/** Снимок страницы (или кропа) как буфер PNG. */
async function screenshot(cdp, clip) {
  const params = { format: 'png', fromSurface: true, captureBeyondViewport: false };
  if (clip !== null) {
    const box = await resolveClipBox(cdp, clip);
    params.clip = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.max(1, Math.round(box.width)),
      height: Math.max(1, Math.round(box.height)),
      scale: 1,
    };
  }
  const result = await cdp.send('Page.captureScreenshot', params);
  return Buffer.from(result.data, 'base64');
}

/** Записать буфер PNG в каталог отчёта; вернуть относительный путь. */
function writeShot(outDir, file, buffer) {
  const absolute = path.join(outDir, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, buffer);
  return file;
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
  const buffer = await screenshot(cdp, shot.clip);
  return writeShot(outDir, shot.file, buffer);
}

/** Выполнить один шаг, сложив результат в запись отчёта `entry`. */
async function runStep(cdp, step, outDir, entry, report, context) {
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
      entry.probe = { name: step.probe.name, value, expect: step.expect };
      report.probes[step.probe.name] = value;
      if (step.expect !== undefined && !sameValue(value, step.expect)) {
        throw new Error(
          `проба «${step.probe.name}»: факт ${describeValue(value)} ≠ ожидание ${describeValue(step.expect)}`,
        );
      }
      break;
    }
    case 'assert': {
      const buffer = await screenshot(cdp, step.assert.region);
      const image = decodePng(buffer);
      const results = runRegionChecks(image, step.assert.checks);
      entry.assert = { name: step.assert.name, checks: results };
      if (step.assert.evidence) {
        const file = writeShot(outDir, `${step.assert.name}-evidence.png`, buffer);
        entry.shot = file;
        report.shots.push(file);
      }
      const failed = results.filter((check) => !check.ok);
      if (failed.length > 0) {
        const detail = failed
          .map((check) => `${check.name}: факт ${check.fact} — ожидание ${check.expect}`)
          .join('; ');
        throw new Error(`растровый ассерт «${step.assert.name}»: ${detail}`);
      }
      break;
    }
    case 'api': {
      const value = await doApi(step, context.api);
      entry.api = { name: step.api.name, method: step.api.method, path: step.api.path, value };
      if (step.expect !== undefined && !sameValue(value, step.expect)) {
        throw new Error(
          `api «${step.api.name}»: факт ${describeValue(value)} ≠ ожидание ${describeValue(step.expect)}`,
        );
      }
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
  if (entry.probe !== undefined) {
    detail = ` ${entry.probe.name} = ${describeValue(entry.probe.value)}`;
    if (entry.probe.expect !== undefined) {
      detail += ` (ожидание ${describeValue(entry.probe.expect)})`;
    }
  } else if (entry.assert !== undefined) {
    const checks = entry.assert.checks
      .map((check) => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.fact} — ожидание ${check.expect}`)
      .join('; ');
    detail = ` ${entry.assert.name}: ${checks}`;
  } else if (entry.api !== undefined) {
    detail = ` ${entry.api.name} ${entry.api.method} ${entry.api.path} = ${describeValue(entry.api.value)}`;
    if (entry.expect !== undefined) detail += ` (ожидание ${describeValue(entry.expect)})`;
  } else if (entry.shot !== undefined) {
    detail = ` → ${entry.shot}`;
  } else if (entry.eval !== undefined) {
    detail = ` ${entry.eval.name}`;
  }
  if (entry.error !== undefined) detail += ` — ${entry.error}`;
  return `${status} ${String(entry.index + 1).padStart(2)} ${entry.kind.padEnd(7)} ${entry.name}${detail} (${entry.ms} мс)`;
}

/** Текстовый отчёт прогона «шаг → проба → факт/ожидание». */
function renderTextReport(report) {
  const failed = report.steps.filter((entry) => entry.status !== 'ok').length;
  const lines = [
    `ui-probe: сценарий «${report.scenario}» через ${report.cdp}`,
    `итог: ${report.ok ? 'OK' : 'ПРОВАЛ'} — шагов ${report.steps.length}, провалено ${failed}, ${report.durationMs} мс`,
  ];
  for (const entry of report.steps) lines.push(formatStep(entry));
  if (report.shots.length > 0) {
    lines.push(`PNG (доказательства, не для модели): ${report.shots.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runScenario(cdp, scenario, outDir, base, context) {
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
    if (step.expect !== undefined) entry.expect = step.expect;
    try {
      // Every step — including `waitFor` by frames — is bounded by the step
      // deadline, so a stalled frame supply cannot hang the run.
      await withTimeout(step.timeout, runStep(cdp, step, outDir, entry, report, context), step.name);
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
  // Подстановки {{имя}} из --var (id сущностей стенда и т.п.).
  scenario = substituteVars(scenario, opts.vars);

  const outDir = path.resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const base = opts.cdp ?? `http://${opts.host}:${opts.port}`;
  const target = await resolvePageTarget(base, opts.target);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  const context = { api: { base: opts.api, key: opts.apiKey } };
  let report;
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    if (opts.wake) await wakePage(cdp);
    report = await runScenario(cdp, scenario, outDir, base, context);
  } finally {
    cdp.close();
  }

  const reportPath = path.join(outDir, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const textPath = path.join(outDir, 'report.txt');
  writeFileSync(textPath, renderTextReport(report));
  const passed = report.steps.filter((entry) => entry.status === 'ok').length;
  process.stdout.write(
    `ui-probe: сценарий «${scenario.name}» — ${passed}/${report.steps.length} ok за ${report.durationMs} мс\n` +
      `отчёт: ${textPath} (текст), ${reportPath} (json)\n` +
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
