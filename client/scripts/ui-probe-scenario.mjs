/**
 * Разбор и валидация JSON-сценария для `client/scripts/ui-probe.mjs`
 * (задача 5c5b30e2, стенд UI-проверок).
 *
 * Модуль намеренно не тянет Electron, сеть и CDP: это чистая функция
 * «JSON → нормализованные шаги», чтобы её можно было проверить
 * юнит-тестами без запущенного клиента (`tests/ui-probe-scenario.test.ts`).
 * Раннер (`ui-probe.mjs`) исполняет уже проверенный набор шагов.
 *
 * Формат сценария:
 * {
 *   "name": "diary-smoke",            // необязательно
 *   "timeout": 8000,                  // необязательно, мс на шаг по умолчанию
 *   "steps": [ <шаг>, … ]             // непустой массив
 * }
 *
 * Шаг — объект ровно с одним действием (плюс необязательные `name`/`timeout`):
 *   { "key": "ArrowDown", "modifiers": ["shift"] }   — нажатие клавиши
 *   { "key": { "key": "a", "code": "KeyA" } }         — явный код/скан-код
 *   { "click": "#sel" } | { "click": { "selector": "#sel", "at": [4, 4] } }
 *     | { "click": [640, 400] } | { "click": { "x": 10, "y": 20 } }
 *     | { "click": { "selector": "#sel", "count": 2 } } — `count` задаёт число
 *       последовательных нажатий (2 — настоящий двойной клик, `click.detail=2`);
 *       `allowMismatch: true` (только с `selector`) разрешает нажать в точку,
 *       которая не попадает в элемент-якорь. По умолчанию промах после
 *       перемеров ВАЛИТ шаг, и нажатие не выполняется (ошибка af96d388).
 *   { "hover": "#sel" } | { "hover": { "selector": "#sel", "at": [4, 4] } }
 *     | { "hover": [640, 400] } | { "hover": { "x": 10, "y": 20 } }
 *     — навести курсор на точку/элемент БЕЗ клика: синтезирует `mouseMoved`,
 *     включает CSS `:hover` (проверка hover-видимости действий; форма точки —
 *     как у `click`, полей `count`/`allowMismatch` НЕТ). Точка наведения
 *     сверяется с целью `elementFromPoint`; промах валит шаг, и событие не
 *     отправляется (ошибка af96d388): наведение обязано попадать в свой
 *     элемент, «наведение по пустой точке» стенду не нужно.
 *   { "drag": { "from": "#handle", "to": { "selector": "#row", "at": [10, 2] },
 *               "expect": "#row", "steps": 8, "duration": 120,
 *               "modifiers": ["shift"], "targetTimeout": 2000 } }
 *     — составной жест: pointerdown в `from`, `steps` промежуточных
 *     `mouseMoved`, ожидание попадания `document.elementFromPoint` в `expect`
 *     и pointerup в `to`. `expect` обязателен: промах координат ПРОВАЛИВАЕТ
 *     шаг, а не даёт молчаливое «ok» (грабли 7c521541). Источник `from` тоже
 *     сверяется с целью ДО первого события: промах валит шаг, нажатия и
 *     перемещений нет (ошибка af96d388). `modifiers` — Shift для
 *     копирования; `duration` — мс на серию перемещений.
 *   { "text": "строка" }                              — ввод текста
 *   { "waitFor": "expr" } | { "waitFor": { "expression": "…", "frames": 2 } }
 *     | { "waitFor": { "frames": 2 } } | { "waitFor": 2 }
 *   { "probe": "expr" } | { "probe": { "name": "rows", "expression": "…" } }
 *     К пробе можно добавить `"expect": <значение>`: раннер сверит факт с
 *     ожиданием и покажет пару «факт/ожидание» в отчёте. Вместо литерала
 *     допустим `"expectFrom": "<имя шага>"` — ожиданием станет значение,
 *     прочитанное ранее выполненным шагом `probe`/`api` с этим именем (снимок
 *     «до» ↔ проверка «после»: например, паритет заголовков до и после правки).
 *   { "shot": "01.png" } | { "shot": { "file": "01.png", "clip": "#sel" } }
 *     clip: селектор | [x, y, w, h] | { x, y, width, height }
 *   { "assert": { "region": "#sel" | [x,y,w,h] | {x,y,width,height},
 *                 "checks": [ <проверка>, … ], "evidence": false } }
 *     — программный растровый ассерт: кроп региона, проверки по пикселям,
 *     результат ТЕКСТОМ (PNG до модели не доходит; `evidence: true` сохранит
 *     PNG — только как доказательство ошибки). Проверки:
 *       { "kind": "notBlank", "minRatio": 0.02, "tolerance": 16 }
 *       { "kind": "colorAt", "at": [dx, dy], "color": "#rrggbb", "tolerance": 8 }
 *       { "kind": "hasColor", "color": "#rrggbb", "tolerance": 8, "minPixels": 1 }
 *       { "kind": "distinct", "minColors": 2 }
 *   { "api": { "name": "…", "method": "GET", "path": "/networks/…",
 *              "expression": "data.body_md", "expect": "…" } }
 *     — HTTP-запрос к серверу стенда ИЗ РАННЕРА (не из рендерера): так
 *     проверяется эффект на сервере/в БД (грабли aa5cf162 — CDP не видит
 *     трафик main-процесса). `expression` вычисляется от распарсенного тела
 *     (обёртка `data` разворачивается); `expect` — необязательное ожидание,
 *     `expectFrom` — ожидание из значения ранее выполненного шага (см. `probe`).
 *   { "eval": "expr" } | { "eval": { "name": "focus", "expression": "…" } }
 *     — побочное действие без записи значения в отчёт (фокус, скролл, ввод).
 *
 * В строковых полях поддерживаются подстановки `{{имя}}` — значения задаются
 * раннеру через `--var имя=значение` (стенд подставляет id засеянных сущностей).
 */

/** Мс на шаг, если ни шаг, ни сценарий не задали свой предел. */
export const DEFAULT_STEP_TIMEOUT = 8000;

/** Клавиши, у которых код и виртуальный скан-код не выводятся из имени. */
const SPECIAL_KEYS = {
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Enter: { code: 'Enter', keyCode: 13 },
  NumpadEnter: { code: 'NumpadEnter', keyCode: 13 },
  Escape: { code: 'Escape', keyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  ' ': { key: ' ', code: 'Space', keyCode: 32 },
};

/** Имена действий шага: ровно одно на шаг. */
export const STEP_ACTION_KEYS = [
  'key',
  'click',
  'hover',
  'drag',
  'text',
  'waitFor',
  'probe',
  'shot',
  'assert',
  'api',
  'eval',
];

/** Виды растровых проверок региона (шаг `assert`). */
export const REGION_CHECK_KINDS = ['notBlank', 'colorAt', 'hasColor', 'distinct'];

/** Метаключи шага, допустимые вместе с любым действием. */
const STEP_META_KEYS = ['name', 'timeout', 'expect', 'expectFrom'];

/** Дополнительные поля шага, допустимые только у конкретного действия. */
const STEP_EXTRA_KEYS = { key: ['modifiers', 'code', 'keyCode'] };

/** Имена модификаторов → битовая маска CDP (alt|ctrl|meta|shift). */
const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };

/** Ошибка разбора/валидации сценария — отдельный тип, чтобы раннер её узнавал. */
export class ScenarioError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScenarioError';
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message) {
  throw new ScenarioError(message);
}

function asString(value, where) {
  if (typeof value !== 'string' || value === '') fail(`${where}: ожидается непустая строка`);
  return value;
}

function asPositiveInt(value, where) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`${where}: ожидается целое число больше нуля`);
  }
  return value;
}

/** Физический код клавиши для одиночного символа (KeyA / Digit1 / сам символ). */
function physicalCode(ch) {
  if (/[a-zA-Z]/.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/[0-9]/.test(ch)) return `Digit${ch}`;
  return ch;
}

/** Имя действия шага; бросает, если действий ноль или больше одного. */
export function stepKind(step) {
  if (!isPlainObject(step)) fail('шаг должен быть объектом');
  const found = STEP_ACTION_KEYS.filter((key) => step[key] !== undefined);
  if (found.length === 0) {
    fail(`не задано действие — ожидается одно из: ${STEP_ACTION_KEYS.join(', ')}`);
  }
  if (found.length > 1) {
    fail(`задано несколько действий (${found.join(', ')}) — допустимо ровно одно`);
  }
  return found[0];
}

/** Нормализовать модификаторы: массив имён или готовую битовую маску 0..15. */
export function normalizeModifiers(mods) {
  if (mods === undefined || mods === null) return 0;
  if (typeof mods === 'number') {
    if (!Number.isInteger(mods) || mods < 0 || mods > 15) {
      fail('modifiers: число должно быть целым в диапазоне 0..15');
    }
    return mods;
  }
  if (!Array.isArray(mods)) fail('modifiers: ожидается массив имён или число');
  let bits = 0;
  for (const name of mods) {
    if (typeof name !== 'string') fail('modifiers: имена должны быть строками');
    const bit = MODIFIER_BITS[name.toLowerCase()];
    if (bit === undefined) fail(`modifiers: неизвестный модификатор «${name}»`);
    bits |= bit;
  }
  return bits;
}

/**
 * Привести описание клавиши к `{ key, code, keyCode, modifiers }`.
 * Строка — имя клавиши или одиночный символ; объект позволяет задать
 * `code`/`keyCode` явно (нужно для клавиш вне карты {@link SPECIAL_KEYS}).
 */
export function resolveKey(spec) {
  if (typeof spec === 'string') {
    if (spec === '') fail('key: пустое имя клавиши');
    const special = SPECIAL_KEYS[spec];
    if (special !== undefined) {
      return {
        key: special.key ?? spec,
        code: special.code,
        keyCode: special.keyCode,
        modifiers: 0,
      };
    }
    if (spec.length === 1) {
      return {
        key: spec,
        code: physicalCode(spec),
        keyCode: spec.toUpperCase().charCodeAt(0),
        modifiers: 0,
      };
    }
    fail(`key: неизвестная клавиша «${spec}» (для редких клавиш задайте {key, code, keyCode})`);
  }
  if (!isPlainObject(spec)) fail('key: ожидается строка или объект');
  for (const extra of Object.keys(spec)) {
    if (!['key', 'code', 'keyCode', 'modifiers'].includes(extra)) {
      fail(`key: неизвестное поле «${extra}»`);
    }
  }
  const key = asString(spec.key, 'key.key');
  const modifiers = normalizeModifiers(spec.modifiers);
  const special = SPECIAL_KEYS[key];
  const code =
    spec.code !== undefined
      ? asString(spec.code, 'key.code')
      : special !== undefined
        ? special.code
        : key.length === 1
          ? physicalCode(key)
          : key;
  let keyCode;
  if (spec.keyCode !== undefined) {
    if (!Number.isInteger(spec.keyCode) || spec.keyCode < 0) {
      fail('key.keyCode: ожидается целое неотрицательное число');
    }
    keyCode = spec.keyCode;
  } else if (special !== undefined) {
    keyCode = special.keyCode;
  } else {
    keyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
  }
  return { key, code, keyCode, modifiers };
}

function normalizeClick(value, where, field = 'click', withCount = true) {
  // `count` — только у клика (у наведения его нет): число последовательных
  // нажатий, 2 — настоящий двойной клик (браузер отдаёт `click` с `detail = 2`).
  // `allowMismatch` — тоже только у клика: явное разрешение нажать в точку,
  // которая не попадает в элемент-якорь (особая точка холста, смещение за
  // границы). По умолчанию промах валит шаг (ошибка af96d388).
  // У `hover` и точек `drag` флага НЕТ (withCount = false): наведение и захват
  // обязаны попадать в свой элемент — «наведение по пустой точке» не нужно
  // (холст наводится на сам элемент холста), а у `drag.from` промах означает
  // захват чужого элемента. Промах там всегда валит шаг без события.
  const countField = withCount ? { count: 1, allowMismatch: false } : {};
  if (typeof value === 'string') {
    return { selector: asString(value, `${where}.${field}`), at: null, x: null, y: null, ...countField };
  }
  if (Array.isArray(value)) {
    if (value.length !== 2) fail(`${where}.${field}: координаты задаются парой [x, y]`);
    return { selector: null, at: null, x: asNumber(value[0], `${where}.${field}[0]`), y: asNumber(value[1], `${where}.${field}[1]`), ...countField };
  }
  if (!isPlainObject(value)) fail(`${where}.${field}: ожидается селектор, [x,y] или объект`);
  const allowed = withCount
    ? ['selector', 'x', 'y', 'at', 'count', 'allowMismatch']
    : ['selector', 'x', 'y', 'at'];
  for (const extra of Object.keys(value)) {
    if (!allowed.includes(extra)) fail(`${where}.${field}: неизвестное поле «${extra}»`);
  }
  if (withCount && value.count !== undefined) {
    countField.count = asPositiveInt(value.count, `${where}.${field}.count`);
  }
  if (withCount && value.allowMismatch !== undefined) {
    // Флаг имеет смысл только вместе с селектором: без него попадание не
    // проверяется и разрешать нечего.
    if (value.selector === undefined) {
      fail(`${where}.${field}.allowMismatch: допустим только вместе с «selector»`);
    }
    if (typeof value.allowMismatch !== 'boolean') {
      fail(`${where}.${field}.allowMismatch: ожидается булево`);
    }
    countField.allowMismatch = value.allowMismatch;
  }
  const hasSelector = value.selector !== undefined;
  const hasCoords = value.x !== undefined || value.y !== undefined;
  if (hasSelector && hasCoords) fail(`${where}.${field}: селектор и координаты взаимоисключающи`);
  if (hasSelector) {
    let at = null;
    if (value.at !== undefined) {
      if (!Array.isArray(value.at) || value.at.length !== 2) {
        fail(`${where}.${field}.at: ожидается пара [dx, dy] — смещение внутри элемента`);
      }
      at = [asNumber(value.at[0], `${where}.${field}.at[0]`), asNumber(value.at[1], `${where}.${field}.at[1]`)];
    }
    return { selector: asString(value.selector, `${where}.${field}.selector`), at, x: null, y: null, ...countField };
  }
  if (!hasCoords) fail(`${where}.${field}: нужен «selector» либо «x» и «y»`);
  return {
    selector: null,
    at: null,
    x: asNumber(value.x, `${where}.${field}.x`),
    y: asNumber(value.y, `${where}.${field}.y`),
    ...countField,
  };
}

function asNumber(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${where}: ожидается число`);
  return value;
}

/**
 * Нормализовать действие `drag` — составной жест перетаскивания:
 * pointerdown в `from`, `steps` промежуточных `mouseMoved`, pointerup в `to`.
 *
 * `expect` (обязателен) — селектор, которому ОБЯЗАН соответствовать
 * `document.elementFromPoint` в точке отпускания (сам элемент или его предок
 * через `closest`). Промах координат — провал шага, а не молчаливое «ok»
 * (грабли 7c521541).
 *
 * `modifiers` — массив имён или битовая маска (Shift — копирование),
 * `duration` — длительность серии перемещений, мс, `targetTimeout` — сколько
 * ждать попадания в цель до отпускания (ожидание по условию, грабли 03e33360).
 */
function normalizeDrag(value, where) {
  if (!isPlainObject(value)) fail(`${where}.drag: ожидается объект`);
  for (const extra of Object.keys(value)) {
    if (
      !['from', 'to', 'expect', 'steps', 'duration', 'modifiers', 'targetTimeout'].includes(extra)
    ) {
      fail(`${where}.drag: неизвестное поле «${extra}»`);
    }
  }
  if (value.from === undefined) fail(`${where}.drag: нужен «from» (источник жеста)`);
  if (value.to === undefined) fail(`${where}.drag: нужен «to» (точка отпускания)`);
  const from = normalizeClick(value.from, where, 'drag.from', false);
  const to = normalizeClick(value.to, where, 'drag.to', false);
  const expect = asString(value.expect, `${where}.drag.expect`);
  const steps = value.steps === undefined ? 8 : asPositiveInt(value.steps, `${where}.drag.steps`);
  const duration =
    value.duration === undefined ? 0 : asNonNegative(value.duration, `${where}.drag.duration`);
  const modifiers = normalizeModifiers(value.modifiers);
  const targetTimeout =
    value.targetTimeout === undefined
      ? 2000
      : asPositiveInt(value.targetTimeout, `${where}.drag.targetTimeout`);
  return { from, to, expect, steps, duration, modifiers, targetTimeout };
}

function normalizeClip(value, where, field = 'clip') {
  if (typeof value === 'string') return { selector: asString(value, `${where}.${field}`) };
  if (Array.isArray(value)) {
    if (value.length !== 4) fail(`${where}.${field}: ожидается [x, y, width, height]`);
    return {
      x: asNumber(value[0], `${where}.${field}[0]`),
      y: asNumber(value[1], `${where}.${field}[1]`),
      width: asPositive(value[2], `${where}.${field}[2]`),
      height: asPositive(value[3], `${where}.${field}[3]`),
    };
  }
  if (!isPlainObject(value)) fail(`${where}.${field}: селектор, [x,y,w,h] или {x,y,width,height}`);
  for (const extra of Object.keys(value)) {
    if (!['x', 'y', 'width', 'height'].includes(extra)) fail(`${where}.${field}: неизвестное поле «${extra}»`);
  }
  return {
    x: asNumber(value.x, `${where}.${field}.x`),
    y: asNumber(value.y, `${where}.${field}.y`),
    width: asPositive(value.width, `${where}.${field}.width`),
    height: asPositive(value.height, `${where}.${field}.height`),
  };
}

function asPositive(value, where) {
  const n = asNumber(value, where);
  if (n <= 0) fail(`${where}: ожидается положительное число`);
  return n;
}

/** Неотрицательное число (0 допустим). */
function asNonNegative(value, where) {
  const n = asNumber(value, where);
  if (n < 0) fail(`${where}: ожидается неотрицательное число`);
  return n;
}

/** Неотрицательное целое (0 допустим). */
function asNonNegativeInt(value, where) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`${where}: ожидается целое неотрицательное число`);
  }
  return value;
}

/** Нормализовать одну проверку региона шага `assert`. */
function normalizeCheck(raw, where, index) {
  const at = `${where}.checks[${index}]`;
  if (!isPlainObject(raw)) fail(`${at}: проверка должна быть объектом`);
  const kind = raw.kind;
  if (typeof kind !== 'string' || !REGION_CHECK_KINDS.includes(kind)) {
    fail(`${at}.kind: ожидается одно из: ${REGION_CHECK_KINDS.join(', ')}`);
  }
  const name = raw.name === undefined ? `${kind}${index + 1}` : asString(raw.name, `${at}.name`);
  const allowed = {
    notBlank: ['kind', 'name', 'minRatio', 'tolerance'],
    colorAt: ['kind', 'name', 'at', 'color', 'tolerance'],
    hasColor: ['kind', 'name', 'color', 'tolerance', 'minPixels'],
    distinct: ['kind', 'name', 'minColors'],
  }[kind];
  for (const extra of Object.keys(raw)) {
    if (!allowed.includes(extra)) fail(`${at}: поле «${extra}» недопустимо для проверки ${kind}`);
  }
  switch (kind) {
    case 'notBlank': {
      const minRatio = raw.minRatio === undefined ? 0.02 : asNumber(raw.minRatio, `${at}.minRatio`);
      if (minRatio < 0 || minRatio > 1) fail(`${at}.minRatio: ожидается доля 0..1`);
      return {
        kind,
        name,
        minRatio,
        tolerance: raw.tolerance === undefined ? 16 : asNonNegative(raw.tolerance, `${at}.tolerance`),
      };
    }
    case 'colorAt': {
      if (!Array.isArray(raw.at) || raw.at.length !== 2) fail(`${at}.at: ожидается пара [dx, dy]`);
      return {
        kind,
        name,
        at: [
          asNonNegativeInt(raw.at[0], `${at}.at[0]`),
          asNonNegativeInt(raw.at[1], `${at}.at[1]`),
        ],
        color: asString(raw.color, `${at}.color`),
        tolerance: raw.tolerance === undefined ? 8 : asNonNegative(raw.tolerance, `${at}.tolerance`),
      };
    }
    case 'hasColor':
      return {
        kind,
        name,
        color: asString(raw.color, `${at}.color`),
        tolerance: raw.tolerance === undefined ? 8 : asNonNegative(raw.tolerance, `${at}.tolerance`),
        minPixels: raw.minPixels === undefined ? 1 : asPositiveInt(raw.minPixels, `${at}.minPixels`),
      };
    default:
      return {
        kind: 'distinct',
        name,
        minColors: raw.minColors === undefined ? 2 : asPositiveInt(raw.minColors, `${at}.minColors`),
      };
  }
}

/** Нормализовать действие `assert` (растровый ассерт). */
function normalizeAssert(value, where, index) {
  if (!isPlainObject(value)) fail(`${where}.assert: ожидается объект`);
  for (const extra of Object.keys(value)) {
    if (!['name', 'region', 'checks', 'evidence'].includes(extra)) {
      fail(`${where}.assert: неизвестное поле «${extra}»`);
    }
  }
  const name = value.name === undefined ? `assert${index + 1}` : asString(value.name, `${where}.assert.name`);
  if (value.region === undefined) fail(`${where}.assert: нужен «region» (селектор или прямоугольник)`);
  const region = normalizeClip(value.region, where, 'assert.region');
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    fail(`${where}.assert.checks: непустой массив проверок`);
  }
  const checks = value.checks.map((c, i) => normalizeCheck(c, where, i));
  let evidence = false;
  if (value.evidence !== undefined) {
    if (typeof value.evidence !== 'boolean') fail(`${where}.assert.evidence: ожидается булево`);
    evidence = value.evidence;
  }
  return { name, region, checks, evidence };
}

/** Нормализовать действие `api` (HTTP-запрос раннера к серверу стенда). */
function normalizeApi(value, where, index) {
  if (!isPlainObject(value)) fail(`${where}.api: ожидается объект`);
  for (const extra of Object.keys(value)) {
    if (!['name', 'method', 'path', 'expression', 'body'].includes(extra)) {
      fail(`${where}.api: неизвестное поле «${extra}» (ожидание задаётся мета-полем «expect»)`);
    }
  }
  const name = value.name === undefined ? `api${index + 1}` : asString(value.name, `${where}.api.name`);
  const method = value.method === undefined ? 'GET' : asString(value.method, `${where}.api.method`).toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    fail(`${where}.api.method: недопустимый метод «${method}»`);
  }
  const path = asString(value.path, `${where}.api.path`);
  if (!path.startsWith('/')) fail(`${where}.api.path: путь должен начинаться с «/»`);
  const expression =
    value.expression === undefined ? null : asString(value.expression, `${where}.api.expression`);
  // Необязательное JSON-тело запроса: позволяет и ПРОВЕРЯТЬ эффект, и засеивать
  // данные (например, дневниковую запись перед прогоном сценария). Поле
  // добавляется только при наличии — форма без тела остаётся прежней.
  if (value.body !== undefined && value.body !== null && !isPlainObject(value.body)) {
    fail(`${where}.api.body: ожидается объект`);
  }
  const api = { name, method, path, expression };
  if (value.body !== undefined && value.body !== null) api.body = value.body;
  return api;
}

function normalizeWaitFor(value, where) {
  if (typeof value === 'string') {
    return { expression: asString(value, `${where}.waitFor`), frames: 0 };
  }
  if (typeof value === 'number') {
    return { expression: null, frames: asPositiveInt(value, `${where}.waitFor`) };
  }
  if (!isPlainObject(value)) fail(`${where}.waitFor: ожидается выражение, число кадров или объект`);
  for (const extra of Object.keys(value)) {
    if (!['expression', 'frames'].includes(extra)) fail(`${where}.waitFor: неизвестное поле «${extra}»`);
  }
  const expression = value.expression === undefined ? null : asString(value.expression, `${where}.waitFor.expression`);
  const frames = value.frames === undefined ? 0 : asPositiveInt(value.frames, `${where}.waitFor.frames`);
  if (expression === null && frames === 0) {
    // Пустой объект — «дать движку отрисоваться»: минимум два кадра.
    return { expression: null, frames: 2 };
  }
  return { expression, frames };
}

function normalizeExpressionStep(kind, value, where, index) {
  if (typeof value === 'string') {
    return { name: `${kind}${index + 1}`, expression: asString(value, `${where}.${kind}`) };
  }
  if (!isPlainObject(value)) fail(`${where}.${kind}: ожидается строка или объект`);
  for (const extra of Object.keys(value)) {
    if (!['name', 'expression'].includes(extra)) fail(`${where}.${kind}: неизвестное поле «${extra}»`);
  }
  return {
    name: value.name === undefined ? `${kind}${index + 1}` : asString(value.name, `${where}.${kind}.name`),
    expression: asString(value.expression, `${where}.${kind}.expression`),
  };
}

function normalizeText(value, where) {
  if (typeof value === 'string') {
    if (value === '') fail(`${where}.text: пустая строка — нечего вводить`);
    return value;
  }
  if (isPlainObject(value) && typeof value.text === 'string' && Object.keys(value).length === 1) {
    if (value.text === '') fail(`${where}.text: пустая строка — нечего вводить`);
    return value.text;
  }
  fail(`${where}.text: ожидается непустая строка`);
}

function normalizeFile(file, where) {
  const name = asString(file, `${where}.shot`);
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(name) || name.split(/[\\/]/).includes('..')) {
    fail(`${where}.shot: путь должен быть относительным и не выходить за каталог отчёта`);
  }
  return name;
}

function normalizeShot(value, where) {
  if (typeof value === 'string') return { file: normalizeFile(value, where), clip: null };
  if (!isPlainObject(value)) fail(`${where}.shot: ожидается имя файла или объект`);
  for (const extra of Object.keys(value)) {
    if (!['file', 'clip'].includes(extra)) fail(`${where}.shot: неизвестное поле «${extra}»`);
  }
  return {
    file: normalizeFile(value.file, `${where}`),
    clip: value.clip === undefined ? null : normalizeClip(value.clip, where),
  };
}

function validateStep(raw, index, defaultTimeout) {
  const where = `шаг ${index + 1}`;
  if (!isPlainObject(raw)) fail(`${where}: шаг должен быть объектом`);
  let kind;
  try {
    kind = stepKind(raw);
  } catch (err) {
    fail(`${where}: ${err.message}`);
  }
  const allowed = new Set([kind, ...(STEP_EXTRA_KEYS[kind] ?? []), ...STEP_META_KEYS]);
  for (const extra of Object.keys(raw)) {
    if (!allowed.has(extra)) {
      fail(`${where}: неизвестное поле «${extra}»`);
    }
  }
  if (raw.expect !== undefined && kind !== 'probe' && kind !== 'api') {
    fail(`${where}: поле «expect» допустимо только у шагов probe и api`);
  }
  if (raw.expectFrom !== undefined) {
    // Ожидание-снимок: значение берётся у РАНЕЕ выполненного шага probe/api с
    // этим именем. Так сценарий самопроверяем: «заголовки после правки равны
    // снимку до правки», а не зашитому списку (критерий «идентичен прежнему»).
    if (kind !== 'probe' && kind !== 'api') {
      fail(`${where}: поле «expectFrom» допустимо только у шагов probe и api`);
    }
    if (raw.expect !== undefined) {
      fail(`${where}: «expect» и «expectFrom» взаимоисключающи — задайте одно`);
    }
  }
  const name = raw.name === undefined ? `${index + 1}:${kind}` : asString(raw.name, `${where}.name`);
  const timeout = raw.timeout === undefined ? defaultTimeout : asPositiveInt(raw.timeout, `${where}.timeout`);
  const step = { index, kind, name, timeout };
  if (raw.expect !== undefined) step.expect = raw.expect;
  if (raw.expectFrom !== undefined) {
    step.expectFrom = asString(raw.expectFrom, `${where}.expectFrom`);
    // Ссылка на самого себя дала бы тавтологию: раннер кладёт значение шага в
    // `context.values` под его именем ДО проверки ожидания, поэтому шаг
    // «сверялся» бы с собственным значением и всегда был зелёным.
    if (step.expectFrom === step.name) {
      fail(
        `${where}: «expectFrom» ссылается на сам шаг «${step.name}» — сравнение стало бы ` +
          'тавтологичным (шаг сверяется с собственным значением)',
      );
    }
  }
  switch (kind) {
    case 'key': {
      // Строковая клавиша может нести модификаторы/код на уровне шага
      // (`{ "key": "a", "modifiers": ["ctrl"] }`); объектную форму не смешиваем.
      const extras = STEP_EXTRA_KEYS.key.filter((field) => raw[field] !== undefined);
      let spec = raw.key;
      if (typeof raw.key === 'string' && extras.length > 0) {
        spec = { key: raw.key };
        for (const field of extras) spec[field] = raw[field];
      } else if (typeof raw.key === 'object' && raw.key !== null && extras.length > 0) {
        fail(`${where}: модификаторы задаются либо в «key», либо рядом — не одновременно`);
      }
      step.key = resolveKey(spec);
      break;
    }
    case 'click':
      step.click = normalizeClick(raw.click, where);
      break;
    case 'hover':
      step.hover = normalizeClick(raw.hover, where, 'hover', false);
      break;
    case 'drag':
      step.drag = normalizeDrag(raw.drag, where);
      break;
    case 'text':
      step.text = normalizeText(raw.text, where);
      break;
    case 'waitFor':
      step.waitFor = normalizeWaitFor(raw.waitFor, where);
      break;
    case 'probe':
      step.probe = normalizeExpressionStep('probe', raw.probe, where, index);
      break;
    case 'eval':
      step.eval = normalizeExpressionStep('eval', raw.eval, where, index);
      break;
    case 'shot':
      step.shot = normalizeShot(raw.shot, where);
      break;
    case 'assert':
      step.assert = normalizeAssert(raw.assert, where, index);
      break;
    case 'api':
      step.api = normalizeApi(raw.api, where, index);
      break;
    default:
      fail(`${where}: необработанное действие «${kind}»`);
  }
  return step;
}

/** Провалидировать объект сценария и вернуть нормализованный вид. */
export function validateScenario(value) {
  if (!isPlainObject(value)) fail('сценарий должен быть JSON-объектом');
  for (const extra of Object.keys(value)) {
    if (!['name', 'description', 'steps', 'timeout'].includes(extra)) {
      fail(`неизвестное поле сценария «${extra}»`);
    }
  }
  const name = value.name === undefined ? 'scenario' : asString(value.name, 'name');
  const timeout = value.timeout === undefined ? DEFAULT_STEP_TIMEOUT : asPositiveInt(value.timeout, 'timeout');
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    fail('поле «steps» — непустой массив шагов');
  }
  const steps = value.steps.map((step, index) => validateStep(step, index, timeout));
  return { name, steps, timeout };
}

/** Разобрать текст JSON-сценария; ошибка JSON заворачивается в {@link ScenarioError}. */
export function parseScenario(text) {
  if (typeof text !== 'string') fail('текст сценария должен быть строкой');
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    fail(`не удалось разобрать JSON сценария: ${err.message}`);
  }
  return validateScenario(data);
}
