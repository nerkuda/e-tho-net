/**
 * Замер лага главного потока под нагрузкой и устойчивый критерий «write-пул
 * снимает блокировку главного потока».
 *
 * Один и тот же приём (сэмплер «event loop lag» + порог) используют два
 * нагрузочных теста — `write-pool-load.test.ts` и
 * `rest-thought-create-pooled.test.ts`. Критерий обязан быть единым, иначе
 * сторожа разъезжаются; поэтому и сэмплер, и порог вынесены сюда.
 *
 * Почему критерий ОТНОСИТЕЛЬНЫЙ (ошибки ea49a9b6, 23e0e0cf). Абсолютный порог
 * p99 = 50 мс не выдерживает конкуренции за CPU в полном прогоне
 * `npm -w @etn/server test`: `node --test` гоняет десятки файлов параллельно,
 * машина перегружена, и таймер пинга опаздывает даже при корректной работе пула
 * (наблюдалось 59 мс при пороге 50). В перегруженной машине абсолютное время
 * измеряет загрузку планировщика, а не блокировку кодом. Настоящий признак
 * работы пула — ОТНОШЕНИЕ к синхронному ориентиру: синхронный путь (без пула)
 * блокирует главный поток на всю длительность записи, пул — нет; поэтому p99
 * через пул сравнивается с p99 синхронного ориентира, замеренным в ТОМ ЖЕ
 * прогоне и при той же загрузке (`pingP99Ceiling`). Абсолютный потолок остаётся
 * предохранителем от катастрофической блокировки: он не ужесточается до уровня
 * наблюдаемого шума, но и не растёт бесконечно вместе с синхронным ориентиром.
 */

/** Период пинга главного потока, мс. */
export const PING_PERIOD_MS = 5;
/** Базовый потолок p99 незагруженной машины, мс (критерий ТП). */
export const PING_P99_CEIL_MS = 50;
/** Верхняя граница потолка под конкуренцией за CPU, мс. */
export const PING_P99_MAX_CEIL_MS = 250;
/** Пул обязан снять не меньше этой доли синхронной блокировки. */
export const POOL_BLOCK_SHARE = 0.5;
/** Пауза после нагрузки, чтобы просроченный тик успел отчитаться, мс. */
export const PING_SETTLE_MS = 40;

/** p99 выборки (ближайший ранг, без интерполяции). */
export function p99(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(0.99 * sorted.length) - 1);
  return sorted[index] as number;
}

/**
 * Потолок p99 лага через пул с учётом синхронного ориентира:
 * `clamp(syncP99 * POOL_BLOCK_SHARE, PING_P99_CEIL_MS, PING_P99_MAX_CEIL_MS)`.
 * При регрессии (работа снова в главном потоке) p99 через пул сближается с
 * синхронным ориентиром и выходит за потолок — сторож краснеет.
 */
export function pingP99Ceiling(syncP99: number): number {
  return Math.min(
    PING_P99_MAX_CEIL_MS,
    Math.max(PING_P99_CEIL_MS, syncP99 * POOL_BLOCK_SHARE),
  );
}

/** Результат замера лага пинга вокруг нагрузки. */
export interface PingLagResult {
  /** Сколько пингов успело отработать за нагрузку. */
  pings: number;
  /** p99 лага пинга главного потока, мс. */
  p99: number;
  /** Сколько пингов пришлось на время занятого воркера пула. */
  busy: number;
}

/**
 * Запустить сэмплер лага главного потока. Тик ставится с расчётом «предыдущий +
 * период»; разница с фактом — сколько поток был занят (просроченный тик на
 * синхронном пути отчитывается длительностью всей записи).
 *
 * `isBusy` опрашивается на каждом пинге — для проверки «окна перекрытия» с
 * занятым воркером пула. Вернуть — `stop()`: дожидается `PING_SETTLE_MS`, чтобы
 * просроченный тик успел отчитаться, останавливает замер и отдаёт статистику.
 */
export function startPingLag(
  isBusy: () => boolean = () => false,
): () => Promise<PingLagResult> {
  const lags: number[] = [];
  let busy = 0;
  let expected = Date.now() + PING_PERIOD_MS;
  let stopped = false;
  let handle: NodeJS.Timeout | null = null;
  const tick = (): void => {
    if (stopped) return;
    const now = Date.now();
    lags.push(now - expected);
    if (isBusy()) busy += 1;
    expected = now + PING_PERIOD_MS;
    handle = setTimeout(tick, PING_PERIOD_MS);
    handle.unref?.();
  };
  handle = setTimeout(tick, PING_PERIOD_MS);
  handle.unref?.();

  return async (): Promise<PingLagResult> => {
    await new Promise((resolve) => setTimeout(resolve, PING_SETTLE_MS));
    stopped = true;
    if (handle !== null) clearTimeout(handle);
    return { pings: lags.length, p99: p99(lags), busy };
  };
}
