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
 *   { "text": "строка" }                              — ввод текста
 *   { "waitFor": "expr" } | { "waitFor": { "expression": "…", "frames": 2 } }
 *     | { "waitFor": { "frames": 2 } } | { "waitFor": 2 }
 *   { "probe": "expr" } | { "probe": { "name": "rows", "expression": "…" } }
 *   { "shot": "01.png" } | { "shot": { "file": "01.png", "clip": "#sel" } }
 *     clip: селектор | [x, y, w, h] | { x, y, width, height }
 *   { "eval": "expr" } | { "eval": { "name": "focus", "expression": "…" } }
 *     — побочное действие без записи значения в отчёт (фокус, скролл, ввод).
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
export const STEP_ACTION_KEYS = ['key', 'click', 'text', 'waitFor', 'probe', 'shot', 'eval'];

/** Метаключи шага, допустимые вместе с любым действием. */
const STEP_META_KEYS = ['name', 'timeout'];

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

function normalizeClick(value, where) {
  if (typeof value === 'string') {
    return { selector: asString(value, `${where}.click`), at: null, x: null, y: null };
  }
  if (Array.isArray(value)) {
    if (value.length !== 2) fail(`${where}.click: координаты задаются парой [x, y]`);
    return { selector: null, at: null, x: asNumber(value[0], `${where}.click[0]`), y: asNumber(value[1], `${where}.click[1]`) };
  }
  if (!isPlainObject(value)) fail(`${where}.click: ожидается селектор, [x,y] или объект`);
  for (const extra of Object.keys(value)) {
    if (!['selector', 'x', 'y', 'at'].includes(extra)) fail(`${where}.click: неизвестное поле «${extra}»`);
  }
  const hasSelector = value.selector !== undefined;
  const hasCoords = value.x !== undefined || value.y !== undefined;
  if (hasSelector && hasCoords) fail(`${where}.click: селектор и координаты взаимоисключающи`);
  if (hasSelector) {
    let at = null;
    if (value.at !== undefined) {
      if (!Array.isArray(value.at) || value.at.length !== 2) {
        fail(`${where}.click.at: ожидается пара [dx, dy] — смещение внутри элемента`);
      }
      at = [asNumber(value.at[0], `${where}.click.at[0]`), asNumber(value.at[1], `${where}.click.at[1]`)];
    }
    return { selector: asString(value.selector, `${where}.click.selector`), at, x: null, y: null };
  }
  if (!hasCoords) fail(`${where}.click: нужен «selector» либо «x» и «y»`);
  return {
    selector: null,
    at: null,
    x: asNumber(value.x, `${where}.click.x`),
    y: asNumber(value.y, `${where}.click.y`),
  };
}

function asNumber(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${where}: ожидается число`);
  return value;
}

function normalizeClip(value, where) {
  if (typeof value === 'string') return { selector: asString(value, `${where}.clip`) };
  if (Array.isArray(value)) {
    if (value.length !== 4) fail(`${where}.clip: ожидается [x, y, width, height]`);
    return {
      x: asNumber(value[0], `${where}.clip[0]`),
      y: asNumber(value[1], `${where}.clip[1]`),
      width: asPositive(value[2], `${where}.clip[2]`),
      height: asPositive(value[3], `${where}.clip[3]`),
    };
  }
  if (!isPlainObject(value)) fail(`${where}.clip: селектор, [x,y,w,h] или {x,y,width,height}`);
  for (const extra of Object.keys(value)) {
    if (!['x', 'y', 'width', 'height'].includes(extra)) fail(`${where}.clip: неизвестное поле «${extra}»`);
  }
  return {
    x: asNumber(value.x, `${where}.clip.x`),
    y: asNumber(value.y, `${where}.clip.y`),
    width: asPositive(value.width, `${where}.clip.width`),
    height: asPositive(value.height, `${where}.clip.height`),
  };
}

function asPositive(value, where) {
  const n = asNumber(value, where);
  if (n <= 0) fail(`${where}: ожидается положительное число`);
  return n;
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
  const name = raw.name === undefined ? `${index + 1}:${kind}` : asString(raw.name, `${where}.name`);
  const timeout = raw.timeout === undefined ? defaultTimeout : asPositiveInt(raw.timeout, `${where}.timeout`);
  const step = { index, kind, name, timeout };
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
