/**
 * Источник мысли для копирования НА ТЕКУЩЕМ ЭКРАНЕ (ошибка 00275531).
 *
 * Ctrl+C/Ctrl+V копируют и вставляют МЫСЛЬ, но раньше источником был курсор
 * карты (`getCanvasCursor`) либо фокус холста — из-за чего на «Структурах»
 * копировалась мысль в фокусе КАРТЫ, а не выделенная на текущем экране. Здесь
 * экраны с мыслями регистрируют свой источник («какая мысль выделена у меня»),
 * а глобальный обработчик берёт цель по ТЕКУЩЕМУ виду. Экраны без мыслей
 * (Дневник, События, Публикации) источник не регистрируют — мысль не копируется
 * и не вставляется.
 *
 * Чистый резолвер {@link resolveThoughtCopyTarget} приоритетов — юнит-тест.
 */

import type { WorkspaceView } from '../state.js';

/** Функция экрана: id выделенной сейчас мысли (null — ничего не выделено). */
export type ScreenThoughtSource = () => string | null;

/** Источники по видам рабочей области (регистрируются экранами). */
const sources = new Map<WorkspaceView, ScreenThoughtSource>();

/** Зарегистрировать источник вида; `null` — снять регистрацию. */
export function setScreenThoughtSource(view: WorkspaceView, source: ScreenThoughtSource | null): void {
  if (source === null) sources.delete(view);
  else sources.set(view, source);
}

/** Источник вида (undefined — вид не умеет копировать мысли). */
export function screenThoughtSource(view: WorkspaceView): ScreenThoughtSource | undefined {
  return sources.get(view);
}

/** Входные данные резолвера цели копирования. */
export interface ThoughtCopyTargetInput {
  /** Текущий вид рабочей области. */
  view: WorkspaceView;
  /** Мысль, выделенная на текущем экране (источник вида), либо `null`. */
  screenId: string | null;
  /** Курсор карты (клик-синхронный сигнал «куда»); только для вида «карта». */
  cursorId: string | null;
  /** Фокус холста; только для вида «карта». */
  focusId: string | null;
}

/**
 * Цель копирования мысли для текущего вида. Приоритет — ТЕКУЩИЙ ЭКРАН:
 *   • `structures` — выделенная на экране мысль (карта не при чём);
 *   • `map` — курсор карты, иначе фокус холста;
 *   • прочие виды (Дневник, События, Публикации) — `null`: мысль не копируется.
 */
export function resolveThoughtCopyTarget(input: ThoughtCopyTargetInput): string | null {
  if (input.view === 'structures') return input.screenId;
  if (input.view === 'map') return input.cursorId ?? input.focusId;
  return null;
}
