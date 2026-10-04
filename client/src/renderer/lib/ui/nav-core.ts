/**
 * Ядро клавиатурной навигации `lib/ui` — ОДНИ правила для таблиц и списков
 * (ADR «Списки и таблицы: два компонента над общим ядром навигации» fadf99e0,
 * требование 93115633, задача 7893e429).
 *
 * **Зачем.** Навигация стрелками была продублирована по модулям по-разному:
 * таблица `table.ts` считала индексы сама, а списки «Дневника» и «Публикаций»
 * держали два независимых рукописных контроллера с одинаковым ядром. Здесь
 * собраны САМИ ПРАВИЛА — какие клавиши обрабатываются, как находится целевой
 * индекс (границы, Home/End, PgUp/PgDn, поведение без выделения), как отсекать
 * поля ввода, — без DOM-специфики представления. Изменение правила делается
 * здесь и применяется сразу ко всем таблицам и спискам.
 *
 * **Что не здесь.** Применение выделения, поиск узла по ключу, прокрутка,
 * фокус, отрисовка строк — это адаптер представления: у таблицы — над Vaadin
 * Grid (`table.ts`), у списка — общий компонент `list.ts`. Ядро лишь отдаёт
 * адаптеру решение «какой индекс/сущность становится текущей».
 *
 * Модуль чистый: ни DOM-узлов, ни слушателей, ни побочных эффектов (кроме
 * безопасного чтения свойств узла в {@link isEditingTarget}).
 */

/** Действие навигации, в которое раскладывается клавиша. */
export type NavAction =
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'pageUp'
  | 'pageDown'
  | 'collapse'
  | 'expand'
  | 'activate'
  /** Alt+↑ — сдвинуть текущую сущность на соседа вверх (порядок, не курсор). */
  | 'moveUp'
  /** Alt+↓ — сдвинуть текущую сущность на соседа вниз. */
  | 'moveDown';

/** Модификаторы клавиатурного события, влияющие на разбор действия. */
export interface NavKeyModifiers {
  /**
   * Удерживается Alt. Переводит ↑/↓ из «движения курсора» в «сдвиг порядка»
   * (жадный перебор соседей в группе) и глушит прочие стрелки навигации.
   */
  altKey?: boolean;
}

/**
 * Карта «клавиша → действие» — единая для таблиц и списков (правило
 * навигации живёт здесь). Клавиши, которых нет в карте (Tab, Escape, Ctrl+C,
 * Space и пр.), ядро не перехватывает: ими распоряжается представление.
 */
export const NAV_KEY_ACTIONS: Readonly<Record<string, NavAction>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
  PageUp: 'pageUp',
  PageDown: 'pageDown',
  ArrowLeft: 'collapse',
  ArrowRight: 'expand',
  Enter: 'activate',
};

/**
 * Действие клавиши или `null`, если клавиша навигацией не управляет.
 *
 * С Alt карта меняется: `Alt+↑/↓` — это «сдвинуть порядок» (действия
 * `moveUp`/`moveDown`), а не перемещение курсора, поэтому обычная навигация
 * по стрелкам с Alt молчит. Прочие стрелки с Alt навигацией не управляют.
 */
export function resolveNavAction(key: string, modifiers: NavKeyModifiers = {}): NavAction | null {
  if (modifiers.altKey === true) {
    if (key === 'ArrowUp') return 'moveUp';
    if (key === 'ArrowDown') return 'moveDown';
    return null;
  }
  const action = NAV_KEY_ACTIONS[key];
  return action ?? null;
}

/** Действие перестановки порядка (Alt+↑/↓) — `null` для прочих действий. */
export function isReorderAction(action: NavAction | null): action is 'moveUp' | 'moveDown' {
  return action === 'moveUp' || action === 'moveDown';
}

/** Настройки расчёта целевого индекса строки. */
export interface NavIndexOptions {
  /** Шаг PgUp/PgDn в строках (по умолчанию 10). */
  pageStep?: number;
  /**
   * Куда встаёт курсор БЕЗ текущего выделения:
   * • `'first'` (по умолчанию) — первая строка (End/PageDown — к своему краю);
   * • `'direction'` — по направлению: `up` — последняя, `down` — первая
   *   (правило списков «Дневника»/«Публикаций»).
   */
  emptyTarget?: 'first' | 'direction';
}

/**
 * Целевой индекс строки для действия навигации. Возвращает `-1`, если строк
 * нет (или для действий, не двигающих курсор, — текущий индекс).
 *
 * Границы НЕ заворачиваются: у края списка `up`/`down` остаются на месте.
 * Без текущей строки (`current < 0`) поведение задаёт {@link NavIndexOptions.emptyTarget}.
 */
export function nextNavIndex(
  action: NavAction,
  current: number,
  count: number,
  options: NavIndexOptions = {},
): number {
  if (count <= 0) return -1;
  const last = count - 1;
  const step = (options.pageStep ?? 10) >= 1 ? (options.pageStep ?? 10) : 1;
  if (current < 0) {
    if (action === 'end') return last;
    if (action === 'pageDown') return Math.min(last, step - 1);
    if (options.emptyTarget === 'direction' && action === 'up') return last;
    return 0;
  }
  switch (action) {
    case 'up':
      return Math.max(0, current - 1);
    case 'down':
      return Math.min(last, current + 1);
    case 'home':
      return 0;
    case 'end':
      return last;
    case 'pageDown':
      return Math.min(last, current + step);
    case 'pageUp':
      return Math.max(0, current - step);
    case 'collapse':
    case 'expand':
    case 'activate':
    case 'moveUp':
    case 'moveDown':
      // Перестановка порядка не двигает курсор — им распоряжается потребитель.
      return current;
  }
}

// ---------------------------------------------------------------------------
// Пространственная (2D) навигация — общая для карты мыслей и сеточных списков
// (задача 432ab7ba п.2: «Полки» ходят геометрически, как карта). Чистая
// геометрия без DOM: прямоугольники сущностей в координатах окна передаёт
// адаптер представления.
// ---------------------------------------------------------------------------

/** Прямоугольник сущности в координатах окна (viewport). */
export interface NavBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Рисовать ли ПУНКТИРНУЮ рамку текущего элемента (двухрамочная навигация,
 * ADR e6d48e09): она не рисуется, когда текущий совпадает с ОТКРЫТЫМ в
 * редакторе (остаётся только сплошная рамка). `null` текущий — рамки нет.
 * Общее правило для карты, «Структур» и библиотеки «Публикаций».
 */
export function shouldDrawCurrentFrame(
  currentKey: string | null,
  openedKey: string | null,
): boolean {
  return currentKey !== null && currentKey !== openedKey;
}

/** Минимальный «вперёд»-зазор, px — более близкие сущности не считаются целью. */
export const SPATIAL_FORWARD_EPS_PX = 2;
/** Вес бокового смещения против «вперёд»-расстояния при выборе цели. */
export const SPATIAL_LATERAL_WEIGHT = 2.5;

/**
 * Лучшая цель из `items` при шаге из `current` в единичном направлении
 * `(dx, dy)` — одна из четырёх стрелок. Среди сущностей, спроецированных
 * «вперёд», счёт штрафует боковое смещение: сущность на одной оси с текущей
 * выигрывает у более близкой по «вперёд», но смещённой вбок. `null` — в
 * направлении ничего нет. Сущность с ключом `currentKey` из выбора исключена.
 */
export function pickSpatialTarget<T extends NavBox>(
  items: readonly T[],
  current: NavBox,
  dx: -1 | 0 | 1,
  dy: -1 | 0 | 1,
  keyOf: (item: T) => string,
  currentKey: string,
): T | null {
  const cx = current.x + current.w / 2;
  const cy = current.y + current.h / 2;
  let best: T | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (keyOf(item) === currentKey) continue;
    const vx = item.x + item.w / 2 - cx;
    const vy = item.y + item.h / 2 - cy;
    const forward = vx * dx + vy * dy;
    if (forward <= SPATIAL_FORWARD_EPS_PX) continue;
    const lateral = Math.abs(vx * dy - vy * dx);
    const score = forward + lateral * SPATIAL_LATERAL_WEIGHT;
    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

/**
 * Целевой индекс для одношагового перемещения по списку (`delta = ±1`).
 * Без выделения (`current < 0`) встаёт на первую строку при движении вниз и на
 * последнюю при движении вверх. У границы возвращает `-1` — движение не
 * меняет выделение. Правило границ списков живёт здесь, а не в адаптере.
 */
export function listTargetIndex(current: number, count: number, delta: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  const next = current + delta;
  return next < 0 || next >= count ? -1 : next;
}

/**
 * Фокус в поле правки текста? Тогда стрелки/Tab/Enter принадлежат редактору и
 * навигация обязана молчать (общее правило таблиц и списков). Адаптер может
 * дополнить проверку (например, CM6-редактор в ленте «Дневника»).
 */
export function isEditingTarget(target: unknown | null): boolean {
  if (target === null || target === undefined) return false;
  const el = target as HTMLElement;
  const tag = (el.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if ((el as unknown as { isContentEditable?: boolean }).isContentEditable === true) return true;
  const attr = el.getAttribute?.('contenteditable');
  return attr !== null && attr !== undefined;
}
