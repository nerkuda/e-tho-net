/**
 * Сплиттер — единый разделитель/ресайзер `lib/ui` (задача 50f57b82, ADR
 * 03eb2c61, инвентаризация 3fc7c54d — раздел «Splitter»).
 *
 * В клиенте было шесть самостоятельных pointer-drag-реализаций разделителя
 * (`editor/splitter.rowSplitter` плюс `lib/filter-panel-frame`, `editor-resizer`,
 * `selection-resizer`, `event-area-resizer`, `canvas/zone-splitters`) с
 * разошедшимися политиками: ось, знак, min/max, персист и вид грипа у каждой
 * свои. Здесь — один компонент, который ведёт **жизненный цикл драга** и
 * **создаёт гриф**, а политику конкретного разделителя задаёт владелец:
 *
 *  - `plan()` вызывается на `pointerdown` и возвращает геометрию драга
 *    (ось, знак, стартовую метрику, границы); `null` отменяет драг — так
 *    молча игнорируются скрытая панель и отсутствующая цель;
 *  - `resolve()` превращает позицию указателя в «запрошенную» метрику (по
 *    умолчанию старт + знак × смещение по оси); разделители, работающие не в
 *    пикселях, а долей (зоны холста), задают свой расчёт;
 *  - `apply()` получает уже зажатую метрику на каждом тике драга;
 *  - `commit()` вызывается на отпускании и знает, был ли сдвиг (`moved`) —
 *    клик без движения драгом не считается.
 *
 * Минимум/максимум вычисляются на каждом тике (число или функция) — владелец
 * может пересчитывать их от текущего размера контейнера. Округление метрики
 * задаётся `plan.round` (по умолчанию — до целых пикселей; зоны холста
 * округляют долю до трёх знаков).
 *
 * **Клавиатурный контракт (задача e45ca252, усиление из находки A2).** Гриф
 * фокусируем (`tabindex=0`) и ведёт тот же драг с клавиатуры: стрелки по оси
 * драга сдвигают разделитель на `step` (по умолчанию {@link KEYBOARD_STEP}),
 * `Home`/`End` — в нижнюю/верхнюю границу, `Enter` — завершение (коммит),
 * `Esc` — отмена (возврат к стартовой метрике). Метрика применяется живьём
 * через `apply`; `commit` получает `moved=true` только при реальном сдвиге.
 * Доступное имя (`aria-label`) даёт владелец строкой локализации.
 *
 * Строк компонент не содержит: подсказку и доступное имя передаёт владелец
 * (из словаря локализации через `t`). Гриф — {@link GRIP_GLYPH} без глифа у
 * тонких шовных разделителей (`grip: null`); его вид — `./splitter.css`.
 *
 * Вид и положение элемента задаёт владелец классом `extraClass` (его
 * раскладка живёт в `styles.css`), как у прочих фасадов `lib/ui`.
 */

import { el } from '../dom.js';

/** Класс любого разделителя, созданного компонентом. */
export const SPLITTER_CLASS = 'ui-splitter';

/** Класс грипа — разделителя с видимым глифом (см. `./splitter.css`). */
export const SPLITTER_GRIP_CLASS = 'ui-splitter--grip';

/** Глиф грипа по умолчанию (наклонная решётка). */
export const GRIP_GLYPH = '⣿';

/** Ось, по которой измеряется смещение указателя. */
export type SplitterAxis = 'x' | 'y';

/** Направление роста метрики: `1` — за указателем, `-1` — навстречу. */
export type SplitterSign = 1 | -1;

/** Граница метрики: число или геттер, пересчитываемый на каждом тике. */
export type SplitterLimit = number | (() => number);

/** Геометрия одного драга, возвращаемая `plan()`. */
export interface SplitterPlan {
  /** Ось драга. */
  axis: SplitterAxis;
  /** Знак роста метрики (по умолчанию `1`). */
  sign?: SplitterSign;
  /** Метрика в начале драга (px или доля). */
  start: number;
  /** Нижняя граница (по умолчанию — без ограничения). */
  min?: SplitterLimit;
  /** Верхняя граница (по умолчанию — без ограничения). */
  max?: SplitterLimit;
  /** Округление метрики (по умолчанию — `Math.round`). */
  round?: (value: number) => number;
}

/** Опции драга — то, что нужно {@link wireSplitter} на готовом элементе. */
export interface SplitterDragOptions {
  /** Нативная подсказка (строка словаря у владельца). */
  title?: string;
  /** Доступное имя (`aria-label`, строка словаря у владельца). */
  ariaLabel?: string;
  /** Шаг клавиатурного сдвига, px (по умолчанию {@link KEYBOARD_STEP}). */
  step?: number;
  /** Делать ли гриф фокусируемым (`tabindex=0`); по умолчанию — да. */
  focusable?: boolean;
  /** Геометрия драга; `null` — драг не начинается. */
  plan: () => SplitterPlan | null;
  /** Запрошенная метрика по позиции указателя (по умолчанию старт + знак × смещение). */
  resolve?: (event: PointerEvent, plan: SplitterPlan) => number;
  /** Живое применение метрики (указателем или клавиатурой). */
  apply: (value: number, plan: SplitterPlan, event: PointerEvent | KeyboardEvent) => void;
  /** Отпускание указателя; `moved` — был ли сдвиг. */
  commit?: (value: number, plan: SplitterPlan, moved: boolean) => void;
  /** Дополнительный класс на время драга (например, курсор на всё тело). */
  stateClass?: string;
  /** Элемент, получающий `stateClass` на время драга. */
  stateHost?: HTMLElement | (() => HTMLElement | null);
}

/** Опции {@link uiSplitter}: драг плюс вид создаваемого элемента. */
export interface SplitterOptions extends SplitterDragOptions {
  /** Дополнительные классы-модификаторы владельца (раскладка, положение). */
  extraClass?: string;
  /** Глиф грипа: строка или `null` — тонкий шов без глифа (по умолчанию глиф). */
  grip?: string | null;
}

/** Класс, отмечающий разделитель в момент драга. */
const DRAGGING_CLASS = 'dragging';

/** Шаг клавиатурного сдвига по умолчанию, px (стрелки разделителя). */
export const KEYBOARD_STEP = 8;

/** Прижимает метрику к границам плана и округляет (общее для мыши и клавиатуры). */
function clampToPlan(raw: number, plan: SplitterPlan): number {
  const round = plan.round ?? Math.round;
  const min = limitOf(plan.min, Number.NEGATIVE_INFINITY);
  const max = limitOf(plan.max, Number.POSITIVE_INFINITY);
  // Нечисловая метрика (битый замер) прижимается к нижней границе — как
  // `clampFilterPanelSize`; без нижней границы считается нулём.
  if (!Number.isFinite(raw)) return round(Number.isFinite(min) ? min : 0);
  return round(Math.min(max, Math.max(min, raw)));
}

/** Активная клавиатурная сессия разделителя (между первым нажатием и Enter/Esc). */
interface KeyboardSession {
  plan: SplitterPlan;
  sign: SplitterSign;
  min: number;
  max: number;
  value: number;
  moved: boolean;
}

/** Элемент-аргумент: сам узел, геттер или `fallback`. */
function hostOf(
  host: HTMLElement | (() => HTMLElement | null) | undefined,
  fallback: HTMLElement | null,
): HTMLElement | null {
  if (host === undefined) return fallback;
  return typeof host === 'function' ? host() : host;
}

/** Значение границы: число как есть, функция — вызванная. */
function limitOf(limit: SplitterLimit | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  return typeof limit === 'function' ? limit() : limit;
}

/** Создаёт элемент разделителя (без драга) — для мест с раздельным монтажом. */
export function splitterElement(extraClass?: string): HTMLElement {
  const classes = [SPLITTER_CLASS];
  if (extraClass !== undefined && extraClass.trim() !== '') {
    classes.push(...extraClass.trim().split(/\s+/));
  }
  return el('div', classes.join(' '));
}

/**
 * Вешает драг на готовый элемент: захват указателя, класс `dragging`, вызовы
 * `apply` на каждом тике и `commit` на отпускании. Повторный вызов на том же
 * элементе не защищён — каждый монтаж даёт один обработчик.
 */
export function wireSplitter(element: HTMLElement, options: SplitterDragOptions): void {
  element.classList.add(SPLITTER_CLASS);
  if (options.title !== undefined) element.title = options.title;
  if (options.ariaLabel !== undefined) element.setAttribute('aria-label', options.ariaLabel);
  // Роль «оконного» разделителя: элемент фокусируем и управляется стрелками.
  element.setAttribute('role', 'separator');

  // Гриф достигается клавиатурой: без фокуса стрелочный контракт недоступен.
  if (options.focusable !== false && !element.hasAttribute('tabindex')) {
    element.setAttribute('tabindex', '0');
  }

  const step = options.step ?? KEYBOARD_STEP;
  let keyboard: KeyboardSession | null = null;

  /** Начинает клавиатурную сессию: геометрия — как у pointerdown. */
  const startKeyboard = (): KeyboardSession | null => {
    const plan = options.plan();
    if (plan === null) return null;
    return {
      plan,
      sign: plan.sign ?? 1,
      min: limitOf(plan.min, Number.NEGATIVE_INFINITY),
      max: limitOf(plan.max, Number.POSITIVE_INFINITY),
      value: plan.start,
      moved: false,
    };
  };

  /** Завершает сессию: `commit` вызывается с признаком реального сдвига. */
  const finishKeyboard = (session: KeyboardSession): void => {
    options.commit?.(session.value, session.plan, session.moved);
  };

  element.addEventListener('keydown', (event: KeyboardEvent) => {
    const key = event.key;
    if (key === 'Enter' || key === 'Escape') {
      if (keyboard === null) return;
      event.preventDefault();
      const session = keyboard;
      keyboard = null;
      if (key === 'Enter') {
        finishKeyboard(session);
      } else {
        // Отмена: метрика возвращается к стартовой, сдвига не было — владелец
        // не сохраняет «отменённый» размер.
        options.apply(session.plan.start, session.plan, event);
        options.commit?.(session.plan.start, session.plan, false);
      }
      return;
    }
    const isArrow =
      key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
    if (!isArrow && key !== 'Home' && key !== 'End') return;
    if (keyboard === null) {
      const started = startKeyboard();
      if (started === null) return;
      keyboard = started;
    }
    const session = keyboard;
    const alongAxis =
      session.plan.axis === 'x'
        ? key === 'ArrowLeft'
          ? -1
          : key === 'ArrowRight'
            ? 1
            : 0
        : key === 'ArrowUp'
          ? -1
          : key === 'ArrowDown'
            ? 1
            : 0;

    let target: number;
    if (key === 'Home') target = session.min;
    else if (key === 'End') target = session.max;
    else if (alongAxis !== 0) target = session.value + alongAxis * step * session.sign;
    else return; // стрелка поперёк оси драга — не наша

    if (!Number.isFinite(target)) return; // край без границы не достижим
    event.preventDefault();
    session.value = clampToPlan(target, session.plan);
    session.moved = true;
    options.apply(session.value, session.plan, event);
  });

  // Потеря фокуса завершает сессию: размер, выставленный клавиатурой, коммитится.
  element.addEventListener('blur', () => {
    if (keyboard === null) return;
    const session = keyboard;
    keyboard = null;
    finishKeyboard(session);
  });

  element.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return;
    const plan = options.plan();
    if (plan === null) return;
    const sign: SplitterSign = plan.sign ?? 1;
    event.preventDefault();

    const stateHost = hostOf(options.stateHost, null);
    element.setPointerCapture(event.pointerId);
    element.classList.add(DRAGGING_CLASS);
    if (stateHost !== null && options.stateClass !== undefined) {
      stateHost.classList.add(options.stateClass);
    }

    const startX = event.clientX;
    const startY = event.clientY;
    let value = plan.start;
    let moved = false;

    const requested = (ev: PointerEvent): number => {
      if (options.resolve !== undefined) return options.resolve(ev, plan);
      const delta = plan.axis === 'x' ? ev.clientX - startX : ev.clientY - startY;
      return plan.start + sign * delta;
    };

    const onMove = (ev: PointerEvent): void => {
      moved = true;
      value = clampToPlan(requested(ev), plan);
      options.apply(value, plan, ev);
    };
    const onUp = (ev: PointerEvent): void => {
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      try {
        element.releasePointerCapture(ev.pointerId);
      } catch {
        /* already released — ignore */
      }
      element.classList.remove(DRAGGING_CLASS);
      if (stateHost !== null && options.stateClass !== undefined) {
        stateHost.classList.remove(options.stateClass);
      }
      options.commit?.(value, plan, moved);
    };

    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
  });
}

/**
 * Создаёт разделитель и сразу вешает драг; возвращает элемент для разметки
 * владельца. Гриф добавляется, если `grip` не `null`.
 */
export function uiSplitter(options: SplitterOptions): HTMLElement {
  const element = splitterElement(options.extraClass);
  if (options.grip !== null) {
    element.classList.add(SPLITTER_GRIP_CLASS);
    element.textContent = options.grip ?? GRIP_GLYPH;
  }
  wireSplitter(element, options);
  return element;
}
