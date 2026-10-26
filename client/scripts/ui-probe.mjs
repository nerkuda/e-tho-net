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
      --no-warmup        Не ждать готовности клиента (первый экран) перед
                         прогоном. По умолчанию раннер ждёт, пока документ
                         загрузится и приложение покажет экран, — это прогревает
                         холодный клиент (стенд поднимает его заново на каждый
                         прогон) и снимает гонку с первым рендером.
      --cold-start       Пометить прогон как холодный старт клиента (стенд
                         ставит флаг всегда: клиент поднимается с нуля на
                         изолированном профиле). Подсказка «холодный старт»
                         добавляется к таймаутам только при ДОКАЗАННОМ медленном
                         старте — если прогрев занял больше порога (1 с) или сам
                         прогрев не дождался экрана; при быстром прогреве условие
                         падает по своей причине, и подсказка не подмешивается.
  -h, --help             Эта справка.

Перед прогоном раннер по умолчанию «будит» скрытое окно обёртки через CDP
(Page.bringToFront, Emulation.setFocusEmulationEnabled,
Page.setWebLifecycleState('active')) — иначе rAF/layout заморожены и условия
не наступают (грабли 03e33360). Отключить: --no-wake.

Шаг «click» сверяет попадание точки с целью через «document.elementFromPoint»
непосредственно перед нажатием (грабли 7c521541): если разметка сдвинулась
между измерением прямоугольника и нажатием (первый рендер холодного клиента,
загрузка картинки, смена размера окна), точка перемеряется — «потерянный» клик
не превращается в молчаливый таймаут следующего «waitFor». Если попадания нет
и после перемеров, шаг ПАДАЕТ, а нажатие не выполняется. Клик по точке вне
элемента-якоря (особая точка холста, смещение за границы) разрешается явно:
{ "click": { "selector": ".canvas", "at": [300, 40], "allowMismatch": true } }
— только с этим флагом промах не валит шаг и виден в отчёте как разрешённый.

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
    warmup: true,
    coldStart: false,
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
      case '--no-warmup':
        opts.warmup = false;
        break;
      case '--cold-start':
        opts.coldStart = true;
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
async function waitForExpression(cdp, expression, timeout, coldStart = false) {
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
      throw new Error(
        `таймаут ${timeout} мс: условие не стало истинным${suffix}${coldStartHint(coldStart)}`,
      );
    }
    await sleep(50);
  }
}

/** Хвост диагностики «холодный старт» добавляется только при доказанном медленном старте. */
function coldStartHint(coldStart) {
  return coldStart
    ? ' — холодный старт клиента: стенд поднимает его заново; прогрейте и повторите прогон или увеличьте timeout'
    : '';
}

/** Порог прогрева, после которого старт считается действительно медленным, мс. */
const COLD_START_WARMUP_MS = 1000;

/**
 * Готовность клиента: документ загружен и приложение показывает ЭКРАН.
 *
 * `showScreen` (screens/screens.ts) очищает `#app` и вставляет ровно один
 * корневой контейнер, поэтому экранные корни перечислены явно:
 *   - `.screen`    — онбординг и список сетей (screens/onboarding.ts,
 *                    screens/networks.ts), а также аварийная заглушка boot;
 *   - `.workspace` — рабочий экран (screens/workspace.ts); «Структуры»,
 *                    «Хроника», «Публикации» и редактор — его внутренние виды,
 *                    собственного корня в `#app` у них нет.
 * Ждать `#app .screen` нельзя: после любого сценария, дошедшего до рабочего
 * экрана, повторный прогон на том же клиенте упирался в таймаут (блокер
 * проверки `af96d388`). Новый экранный корень в `showScreen` — добавь сюда.
 */
const SCREEN_CONTAINERS = '#app > .screen, #app > .workspace';
const READY_EXPRESSION = `document.readyState === 'complete' && document.querySelector(${JSON.stringify(SCREEN_CONTAINERS)}) !== null`;

async function warmupPage(cdp, timeout, coldStart) {
  const started = Date.now();
  try {
    await waitForExpression(cdp, READY_EXPRESSION, timeout, coldStart);
  } catch (err) {
    // Не дождались экрана — старт действительно медленный: подсказка уместна
    // независимо от порога.
    throw new Error(`прогрев: клиент не показал экран (${err.message})`);
  }
  await waitFrames(cdp, 2);
  return Date.now() - started;
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

/**
 * Ожидание шага: литерал `expect` либо снимок `expectFrom` — значение, прочитанное
 * РАНЕЕ выполненным шагом `probe`/`api` с этим именем (`context.values`). Снимок
 * делает сценарий самопроверяемым: «после = до» вместо зашитого списка.
 */
function resolveExpected(step, context) {
  if (step.expectFrom === undefined) {
    return { has: step.expect !== undefined, value: step.expect, from: null };
  }
  if (!context.values.has(step.expectFrom)) {
    throw new Error(
      `шаг «${step.name}»: expectFrom ссылается на шаг «${step.expectFrom}» — ` +
        'его значения нет (шаг не выполнен или не probe/api)',
    );
  }
  return { has: true, value: context.values.get(step.expectFrom), from: step.expectFrom };
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
  // Необязательное тело запроса (`step.api.body`): сценарий может не только
  // проверять эффект, но и засеивать данные (например, дневниковую запись).
  const init = { method: step.api.method, headers };
  if (step.api.body !== undefined && step.api.body !== null) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(step.api.body);
  }
  let response;
  let text;
  try {
    response = await fetch(url, init);
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

/** Точка клика/наведения в координатах вьюпорта по спецификации шага. */
async function resolvePoint(cdp, spec) {
  if (spec.selector !== null) {
    const rect = await elementRect(cdp, spec.selector);
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error(`элемент «${spec.selector}» имеет нулевой размер`);
    }
    const x = rect.x + (spec.at === null ? rect.width / 2 : spec.at[0]);
    const y = rect.y + (spec.at === null ? rect.height / 2 : spec.at[1]);
    return { px: Math.round(x), py: Math.round(y) };
  }
  return { px: Math.round(spec.x), py: Math.round(spec.y) };
}

/** Навести курсор (только `mouseMoved`) — включает CSS `:hover` без клика. */
async function doHover(cdp, spec) {
  const { px, py } = await resolvePoint(cdp, spec);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0 });
}

async function doClick(cdp, spec) {
  const point = await resolveCheckedPoint(cdp, spec);
  // Промах без явного разрешения: нажатия НЕТ, шаг падает (решение — в runStep,
  // чтобы диагностика попала в запись отчёта). Молчаливый клик по чужому
  // элементу запрещён (грабли 7c521541).
  if (point.mismatched === true && spec.allowMismatch !== true) return point;
  const { px, py } = point;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0 });
  // `count` последовательных нажатий: со второго браузер отдаёт `click` с
  // `detail = 2` — так прогоняется настоящий двойной клик (шаг `click`).
  const count = spec.count === undefined ? 1 : spec.count;
  for (let i = 1; i <= count; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: px,
      y: py,
      button: 'left',
      buttons: 1,
      clickCount: i,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: px,
      y: py,
      button: 'left',
      buttons: 0,
      clickCount: i,
    });
  }
  return point;
}

/** Сколько раз перемерить точку клика перед нажатием (сдвиг разметки). */
const CLICK_HIT_ATTEMPTS = 4;

/**
 * Точка клика с проверкой попадания НЕПОСРЕДСТВЕННО перед нажатием.
 *
 * Прямоугольник элемента и координаты нажатия разнесены по времени (hover,
 * постановка кадра); за это время разметка может сдвинуться — первый рендер
 * холодного клиента, загрузка картинки, смена размера окна. Нажатие в устаревшую
 * точку браузер доставит соседнему элементу, и клик молча пропадёт (симптом
 * `af96d388`: таймаут следующего `waitFor` без единого запроса на сервере).
 * Поэтому `elementFromPoint` сверяется с целью, при промахе прямоугольник
 * перемеряется (до {@link CLICK_HIT_ATTEMPTS} раз). Если попадания так и нет,
 * клик ПО УМОЛЧАНИЮ НЕ ВЫПОЛНЯЕТСЯ, а шаг падает (блокер проверки `af96d388`):
 * промах — дефект сценария или разметки, а не повод кликнуть в чужой элемент.
 * Точечные исключения (клик по особой точке холста, смещение за границы
 * элемента-якоря) разрешаются явно — `allowMismatch: true` в описании клика;
 * тогда нажатие выполняется, а расхождение видно в отчёте как разрешённый
 * промах (грабли 7c521541).
 */
async function resolveCheckedPoint(cdp, spec) {
  let point = await resolvePoint(cdp, spec);
  if (spec.selector === null) return { ...point, hit: null };
  let last = null;
  for (let attempt = 0; attempt < CLICK_HIT_ATTEMPTS; attempt += 1) {
    last = await hitAt(cdp, point.px, point.py, spec.selector);
    if (last !== null && last.matched === true) {
      return { ...point, retries: attempt, hit: last.element };
    }
    if (attempt + 1 < CLICK_HIT_ATTEMPTS) {
      await waitFrames(cdp, 1);
      point = await resolvePoint(cdp, spec);
    }
  }
  return {
    ...point,
    retries: CLICK_HIT_ATTEMPTS - 1,
    hit: last === null ? null : last.element,
    mismatched: true,
  };
}

/**
 * Текст провала шага `click`: куда целились, сколько раз перемеряли и что
 * оказалось под указателем. Промах без `allowMismatch` валит шаг (af96d388).
 */
function clickMismatchMessage(spec, point) {
  const under = point.hit;
  const fact =
    under === null || under === undefined
      ? 'под указателем пусто'
      : `${under.tag} class="${under.className}"`;
  const retries = point.retries ?? CLICK_HIT_ATTEMPTS - 1;
  return (
    `клик не выполнен: точка ${point.px},${point.py} не попадает в «${spec.selector}»` +
    ` за ${retries} перемеров — ${fact}`
  );
}

/**
 * Выражение проверки попадания: что лежит в точке и совпадает ли элемент (или
 * его предок) с ожидаемым селектором. Промах координат должен быть виден
 * текстом, а не молчаливым «ok» (грабли 7c521541).
 */
function hitExpression(px, py, selector) {
  return (
    '(() => { const el = document.elementFromPoint(' +
    `${px}, ${py}); ` +
    'if (el === null) return { matched: false, element: null }; ' +
    `const target = el.closest(${JSON.stringify(selector)}); ` +
    "const cls = el.getAttribute('class') || ''; " +
    'return { matched: target !== null, ' +
    "element: { tag: el.tagName, className: cls, text: (el.textContent || '').slice(0, 80) } }; })()"
  );
}

/** Факт попадания в точке (без ожидания). */
async function hitAt(cdp, px, py, selector) {
  return evaluate(cdp, hitExpression(px, py, selector));
}

/**
 * Дождаться попадания в ожидаемый селектор ПО УСЛОВИЮ (не по кадрам): в скрытом
 * окне rAF/layout заморожены, но после `wakePage` документ активен — опрос
 * `elementFromPoint` даёт стабильную картину (грабли 03e33360).
 */
async function waitForHit(cdp, px, py, selector, timeout) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await hitAt(cdp, px, py, selector);
    if (last !== null && last.matched === true) return last;
    if (Date.now() >= deadline) {
      const fact =
        last === null || last.element === null
          ? 'под указателем пусто'
          : `${last.element.tag} class="${last.element.className}"`;
      throw new Error(
        `drag: в точке отпускания (${px}, ${py}) нет «${selector}» — elementFromPoint: ${fact}`,
      );
    }
    await sleep(50);
  }
}

/**
 * Составной шаг `drag`: pointerdown в источнике, `steps` промежуточных
 * `mouseMoved`, ожидание целевого селектора под указателем и pointerup.
 * `modifiers` (битовая маска CDP) доносят Shift — копирование.
 */
async function doDrag(cdp, spec) {
  const from = await resolvePoint(cdp, spec.from);
  const to = await resolvePoint(cdp, spec.to);
  const modifiers = spec.modifiers;
  const send = (params) => cdp.send('Input.dispatchMouseEvent', { modifiers, ...params });
  // Наведение на источник: hover-состояние (ручка может быть видима только на
  // hover — drag-list) обязано включиться до нажатия.
  await send({ type: 'mouseMoved', x: from.px, y: from.py, button: 'none', buttons: 0 });
  await send({
    type: 'mousePressed',
    x: from.px,
    y: from.py,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  const stepDelay = spec.duration > 0 ? Math.max(0, Math.floor(spec.duration / spec.steps)) : 0;
  for (let i = 1; i <= spec.steps; i += 1) {
    const x = Math.round(from.px + ((to.px - from.px) * i) / spec.steps);
    const y = Math.round(from.py + ((to.py - from.py) * i) / spec.steps);
    await send({ type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    if (stepDelay > 0) await sleep(stepDelay);
  }
  // До отпускания цель обязана быть под указателем: иначе координаты промахнулись.
  await waitForHit(cdp, to.px, to.py, spec.expect, spec.targetTimeout);
  await send({
    type: 'mouseReleased',
    x: to.px,
    y: to.py,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  const hit = await hitAt(cdp, to.px, to.py, spec.expect);
  if (hit === null || hit.matched !== true) {
    throw new Error(
      `drag: после отпускания в точке (${to.px}, ${to.py}) ожидался «${spec.expect}»`,
    );
  }
  return {
    from: [from.px, from.py],
    to: [to.px, to.py],
    steps: spec.steps,
    modifiers,
    expect: spec.expect,
    hit: hit.element,
  };
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
    case 'click': {
      const point = await doClick(cdp, step.click);
      // Диагностика сдвига разметки: сколько раз точку пришлось перемерить,
      // чтобы попасть в цель (и попали ли вообще) — видно в отчёте.
      if (point.retries > 0 || point.mismatched === true) {
        entry.click = {
          x: point.px,
          y: point.py,
          retries: point.retries ?? 0,
          mismatched: point.mismatched === true,
          allowed: point.mismatched === true && step.click.allowMismatch === true,
          under: point.hit,
        };
      }
      if (point.mismatched === true && step.click.allowMismatch !== true) {
        // Нажатие уже не отправлено (doClick вышел до dispatch) — шаг падает.
        throw new Error(clickMismatchMessage(step.click, point));
      }
      await waitFrames(cdp, 2);
      break;
    }
    case 'hover':
      await doHover(cdp, step.hover);
      await waitFrames(cdp, 2);
      break;
    case 'drag':
      entry.drag = await doDrag(cdp, step.drag);
      break;
    case 'text':
      await cdp.send('Input.insertText', { text: step.text });
      await waitFrames(cdp, 2);
      break;
    case 'waitFor':
      if (step.waitFor.expression !== null) {
        await waitForExpression(cdp, step.waitFor.expression, step.timeout, context.coldStart);
      }
      if (step.waitFor.frames > 0) {
        await waitFrames(cdp, step.waitFor.frames);
      }
      break;
    case 'probe': {
      const value = await evaluate(cdp, step.probe.expression);
      entry.probe = { name: step.probe.name, value, expect: step.expect };
      report.probes[step.probe.name] = value;
      // Значение доступно шагам с `expectFrom` (снимок «до» для проверки «после»).
      context.values.set(step.name, value);
      const expected = resolveExpected(step, context);
      if (expected.has) {
        entry.expect = expected.value;
        if (expected.from !== null) entry.expectFrom = expected.from;
      }
      if (expected.has && !sameValue(value, expected.value)) {
        throw new Error(
          `проба «${step.probe.name}»: факт ${describeValue(value)} ≠ ожидание ${describeValue(expected.value)}`,
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
      // Значение доступно шагам с `expectFrom` (снимок «до» для проверки «после»).
      context.values.set(step.name, value);
      const expected = resolveExpected(step, context);
      if (expected.has) {
        entry.expect = expected.value;
        if (expected.from !== null) entry.expectFrom = expected.from;
      }
      if (expected.has && !sameValue(value, expected.value)) {
        throw new Error(
          `api «${step.api.name}»: факт ${describeValue(value)} ≠ ожидание ${describeValue(expected.value)}`,
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

function withTimeout(timeout, promise, label, coldStart = false) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`таймаут шага ${timeout} мс (${label})${coldStartHint(coldStart)}`)),
      timeout,
    );
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function formatStep(entry) {
  const status = entry.status === 'ok' ? 'ok  ' : 'FAIL';
  let detail = '';
  if (entry.probe !== undefined) {
    detail = ` ${entry.probe.name} = ${describeValue(entry.probe.value)}`;
    if (entry.expect !== undefined) {
      detail += ` (ожидание ${describeValue(entry.expect)}`;
      detail += entry.expectFrom === undefined ? ')' : ` — снимок шага «${entry.expectFrom}»)`;
    }
  } else if (entry.drag !== undefined) {
    detail =
      ` ${describeValue(entry.drag.from)} → ${describeValue(entry.drag.to)}` +
      ` (цель «${entry.drag.expect}», шагов ${entry.drag.steps})`;
  } else if (entry.assert !== undefined) {
    const checks = entry.assert.checks
      .map((check) => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.fact} — ожидание ${check.expect}`)
      .join('; ');
    detail = ` ${entry.assert.name}: ${checks}`;
  } else if (entry.api !== undefined) {
    detail = ` ${entry.api.name} ${entry.api.method} ${entry.api.path} = ${describeValue(entry.api.value)}`;
    if (entry.expect !== undefined) {
      detail += ` (ожидание ${describeValue(entry.expect)}`;
      detail += entry.expectFrom === undefined ? ')' : ` — снимок шага «${entry.expectFrom}»)`;
    }
  } else if (entry.shot !== undefined) {
    detail = ` → ${entry.shot}`;
  } else if (entry.eval !== undefined) {
    detail = ` ${entry.eval.name}`;
  }
  if (entry.click !== undefined) {
    const retries = entry.click.retries ?? 0;
    detail += ` [точка ${entry.click.x},${entry.click.y}`;
    detail += retries === 0 ? ']' : `, перемер ${retries}]`;
    if (entry.click.mismatched === true) {
      const under = entry.click.under;
      const fact =
        under === null || under === undefined
          ? 'под указателем пусто'
          : `${under.tag} class="${under.className}"`;
      detail +=
        entry.click.allowed === true
          ? ` — ПРОМАХ (разрешён allowMismatch): ${fact}`
          : ` — ПРОМАХ: ${fact}`;
    }
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
  // Время прогрева — в текстовом отчёте: по нему видно, был ли старт медленным
  // (и потому уместна ли подсказка «холодный старт» в таймаутах).
  if (typeof report.warmupMs === 'number') {
    lines.push(`прогрев: клиент готов за ${report.warmupMs} мс`);
  } else {
    lines.push('прогрев: отключён (--no-warmup)');
  }
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
      await withTimeout(
        step.timeout,
        runStep(cdp, step, outDir, entry, report, context),
        step.name,
        context.coldStart,
      );
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
  const context = { api: { base: opts.api, key: opts.apiKey }, values: new Map(), coldStart: false };
  let report;
  let warmupMs = null;
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    if (opts.wake) await wakePage(cdp);
    if (opts.warmup) {
      warmupMs = await warmupPage(cdp, 15000, opts.coldStart);
      // Подсказка «холодный старт» — только при ДОКАЗАННОМ медленном старте:
      // прогрев дольше порога. Быстрый прогрев значит, что клиент готов, и
      // таймаут условия — его собственная причина (блокер проверки af96d388).
      context.coldStart = opts.coldStart && warmupMs >= COLD_START_WARMUP_MS;
      process.stdout.write(
        `ui-probe: прогрев — клиент готов за ${warmupMs} мс` +
          (context.coldStart ? ' (медленный старт)' : '') +
          '\n',
      );
    } else {
      // Прогрев отключён: измерить старт нечем, поэтому гипотеза «клиент
      // свежий» (её и сообщает стенд флагом --cold-start) остаётся в силе.
      context.coldStart = opts.coldStart;
    }
    report = await runScenario(cdp, scenario, outDir, base, context);
  } finally {
    cdp.close();
  }
  if (warmupMs !== null) report.warmupMs = warmupMs;

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
