/**
 * Чистые помощники проверки ТОЧКИ ВВОДА GUI-стенда (`ui-probe.mjs`).
 *
 * Один и тот же механизм обслуживает все шаги, которые целятся в точку по
 * селектору: `click`, `hover` и начало `drag` (`drag.from`). Точка сверяется с
 * целью через `document.elementFromPoint` + `closest(selector)` непосредственно
 * перед отправкой события; промах — провал шага, а не молчаливое «ok»
 * (грабли 7c521541, ошибка af96d388).
 *
 * Модуль намеренно без CDP и Electron: чистые функции проверяются юнит-тестами
 * (`tests/ui-probe-point.test.ts`) без запущенного клиента, раннер импортирует
 * их (`.d.mts` — типы для теста).
 */

/** Сколько раз перемерить точку перед отправкой события (сдвиг разметки). */
export const POINT_CHECK_ATTEMPTS = 4;

/**
 * Выражение проверки попадания: что лежит в точке и совпадает ли элемент (или
 * его предок) с ожидаемым селектором. Селектор подставляется через
 * `JSON.stringify` — кавычки и обратные слеши в нём безопасны.
 */
export function hitExpression(px, py, selector) {
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

/** Что оказалось под указателем — текстом для отчёта. */
export function describeUnder(element) {
  if (element === null || element === undefined) return 'под указателем пусто';
  return `${element.tag} class="${element.className}"`;
}

/**
 * Текст провала шага, целящегося в точку: действие, координата, селектор,
 * число перемеров и элемент под указателем. `action` — «клик не выполнен»,
 * «наведение не выполнено», «перетаскивание не начато».
 */
export function mismatchMessage(action, selector, point) {
  const retries = point.retries ?? POINT_CHECK_ATTEMPTS - 1;
  return (
    `${action}: точка ${point.px},${point.py} не попадает в «${selector}»` +
    ` за ${retries} перемеров — ${describeUnder(point.hit)}`
  );
}

/**
 * Диагностика точки в текстовом отчёте: `[точка x,y, перемер N]` и при промахе
 * `— ПРОМАХ: …` (для явно разрешённого промаха — `ПРОМАХ (разрешён allowMismatch)`).
 * Форма `check`: `{ x, y, retries, mismatched, under }`.
 */
export function pointCheckText(check, mismatchAllowed = false) {
  const retries = check.retries ?? 0;
  let text = ` [точка ${check.x},${check.y}`;
  text += retries === 0 ? ']' : `, перемер ${retries}]`;
  if (check.mismatched === true) {
    text += mismatchAllowed
      ? ` — ПРОМАХ (разрешён allowMismatch): ${describeUnder(check.under)}`
      : ` — ПРОМАХ: ${describeUnder(check.under)}`;
  }
  return text;
}
