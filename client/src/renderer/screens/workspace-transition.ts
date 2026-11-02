/**
 * Окно смены поколения рабочего пространства (ошибка f1febdfc).
 *
 * Пока `openNetwork` собирает новую сеть/вкладку, в DOM ещё живёт ПРЕЖНИЙ
 * workspace: пользователь видит старые закладки видов и может кликнуть по
 * «Дневнику»/«Структурам». Такой клик относится к уходящему поколению: без
 * окна он либо теряется (вид уже активен — ранний выход `setActiveView`,
 * `active-view.ts`), либо затирается публикацией `activeView` новой вкладки
 * (`app.ts`). Поэтому на время перехода клик по закладке вида не применяется
 * сразу, а запоминается последним намерением и применяется к НОВОМУ
 * поколению, когда оно опубликовано.
 *
 * Окно открывают входы, у которых между действием пользователя и вызовом
 * `openNetwork` есть собственный await: выбор сети в пикере (`tabs/picker.ts`)
 * и активация вкладки (`tabs/tabs.ts`). Вложенные окна складываются
 * (refcount): `openNetwork` открывает своё окно внутри уже открытого.
 *
 * Модуль нарочно не импортирует `active-view.ts` (цикл): применятель
 * регистрируется из `active-view.ts` при загрузке.
 */
import type { WorkspaceView } from '../state.js';

/** Номер текущего окна; `null` — перехода нет. */
let transition: number | null = null;
/** Сколько входов держат окно открытым (вложенные окна). */
let depth = 0;
let transitionSeq = 0;
/** Последнее намерение пользователя внутри окна (последний клик побеждает). */
let pendingView: WorkspaceView | null = null;
/** Применятель намерения — `setActiveView` без проверки окна (регистрирует active-view.ts). */
let applier: ((view: WorkspaceView) => void) | null = null;

/** Регистрирует применение намерения к текущему поколению workspace. */
export function registerWorkspaceViewApplier(fn: (view: WorkspaceView) => void): void {
  applier = fn;
}

/**
 * Открыть окно перехода. Вложенный вызов возвращает тот же номер — закрывать
 * окно обязаны все открывшие (`endWorkspaceTransition`), счётчик depth.
 */
export function beginWorkspaceTransition(): number {
  if (transition === null) transition = ++transitionSeq;
  depth += 1;
  return transition;
}

/** Идёт ли сейчас смена поколения workspace. */
export function isWorkspaceTransitionActive(): boolean {
  return transition !== null;
}

/** Запомнить намерение пользователя: применить его к новому поколению. */
export function queueWorkspaceView(view: WorkspaceView): void {
  pendingView = view;
}

/**
 * Применить накопленное намерение. Вызывается сразу после `showScreen`
 * (новое поколение уже в DOM и store опубликовал сеть/вкладку/вид).
 */
export function applyPendingWorkspaceView(): void {
  const view = pendingView;
  pendingView = null;
  if (view !== null) applier?.(view);
}

/** Закрыть окно (вложенный — только уменьшить счётчик); на последнем — применить намерение. */
export function endWorkspaceTransition(token: number): void {
  if (transition !== token) return;
  depth -= 1;
  if (depth > 0) return;
  transition = null;
  applyPendingWorkspaceView();
}
