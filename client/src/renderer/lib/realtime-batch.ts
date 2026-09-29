/**
 * Коалессирование realtime-событий в одно применение за окно дебаунса
 * (задача afcfb144, уровень 3 тех.проекта `1d48df6d` «Инкрементальное
 * обновление списков UI»).
 *
 * **Зачем.** Экран «Структуры» и «Дневник» применяют чужие события к своему
 * локальному снимку. Применять по событию — значит дёргать сверку списка на
 * каждое из нескольких событий подряд (правка заголовка + её же связь и т.п.).
 * Здесь события копятся в очередь, и по истечении окна дебаунса применяются
 * ОДНИМ батчем → один `reconcileKeyed` на окно (требование задачи).
 *
 * **Fallback важнее экономии.** Если за окно пришло событие, которое нельзя
 * применить уверенно (влияет на состав отбора, порядок сортировки, структуру),
 * экран метит окно `markFull()` — тогда батч отбрасывается и вызывается полный
 * путь (`applyFull`). Так ошибка инкрементального пути не теряет данные.
 *
 * Таймер окна — «затухающий» (trailing): каждое новое событие отодвигает
 * применение, пока поток событий не затихнет.
 */

/** Очередь-коалессер, привязанная к таймеру окна дебаунса. */
export interface RealtimeBatch<T> {
  /** Добавить событие в окно (сдвигает таймер). */
  push(op: T): void;
  /** Пометить окно как требующее полного пути (отбрасывает батч). */
  markFull(): void;
  /** Число накопленных событий (для тестов и диагностики). */
  readonly pending: number;
}

/** Параметры {@link createRealtimeBatch}. */
export interface RealtimeBatchOptions<T> {
  /** Окно коалессирования, мс. */
  windowMs: number;
  /** Применить накопленный батч (вызывается не более раза на окно). */
  applyBatch: (ops: readonly T[]) => void;
  /** Полный путь: окно содержит неприменимое событие. */
  applyFull: () => void;
}

/**
 * Создать коалессер. Таймер — `window.setTimeout` (рендерер): модуль не
 * трогает DOM и не зависит от экранов, потому пригоден для юнит-теста под
 * DOM-шимом.
 */
export function createRealtimeBatch<T>(opts: RealtimeBatchOptions<T>): RealtimeBatch<T> {
  let ops: T[] = [];
  let needsFull = false;
  let timer: number | null = null;

  const flush = (): void => {
    timer = null;
    const full = needsFull;
    const batch = ops;
    needsFull = false;
    ops = [];
    // Полный путь поглощает окно: батч применять не нужно — перезапрос
    // прочитает актуальное состояние целиком.
    if (full) opts.applyFull();
    else if (batch.length > 0) opts.applyBatch(batch);
  };

  const schedule = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(flush, opts.windowMs);
  };

  return {
    push(op) {
      ops.push(op);
      schedule();
    },
    markFull() {
      needsFull = true;
      schedule();
    },
    get pending() {
      return ops.length;
    },
  };
}
