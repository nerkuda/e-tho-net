/**
 * Замер блокировки главного потока под нагрузкой и устойчивый критерий «пул
 * снимает блокировку главного потока».
 *
 * Один и тот же приём (сэмплер + критерий) используют нагрузочные тесты
 * `write-pool-load.test.ts`, `read-pool-load.test.ts`,
 * `rest-thought-create-pooled.test.ts` и `rest-thoughts-batch-pooled.test.ts`.
 * Критерий обязан быть единым, иначе сторожа разъезжаются; поэтому и сэмплер, и
 * порог, и сама проверка вынесены сюда (`assertPoolUnblocks`).
 *
 * Почему критерий ОТНОСИТЕЛЬНЫЙ (ошибки ea49a9b6, 23e0e0cf). Абсолютный порог
 * p99 = 50 мс не выдерживает конкуренции за CPU в полном прогоне
 * `npm -w @etn/server test`: `node --test` гоняет десятки файлов параллельно,
 * машина перегружена, и таймер пинга опаздывает даже при корректной работе пула
 * (наблюдалось 59 мс при пороге 50). В перегруженной машине абсолютное время
 * измеряет загрузку планировщика, а не блокировку кодом. Настоящий признак
 * работы пула — ОТНОШЕНИЕ к синхронному ориентиру: синхронный путь (без пула)
 * блокирует главный поток на всю длительность записи, пул — нет; поэтому замер
 * через пул сравнивается с синхронным ориентиром, снятым в ТОМ ЖЕ прогоне и при
 * той же загрузке (`poolCeiling`). Абсолютный потолок остаётся предохранителем
 * от катастрофической блокировки: он не ужесточается до уровня наблюдаемого шума,
 * но и не растёт бесконечно вместе с синхронным ориентиром.
 *
 * Почему задержка тика взвешивается CPU-временем главного потока (ошибка
 * 21a3be38). Лаг пинга фиксирует, что поток НЕ КРУТИЛ событийный цикл, и на
 * 2-vCPU Windows-ВМ это не одно и то же: занятый воркер насыщает процессор, и
 * простаивающий главный поток получает тик с опозданием на 250–300 мс, хотя сам
 * потребил за весь замер 31–112 мс CPU; синхронный путь в том же прогоне —
 * 700–1000 мс. То есть лаг описывает загрузку планировщика (вплоть до вытеснения
 * простаивающего потока), а не блокировку кодом. Поэтому для каждого тика
 * измеряется ещё и CPU-время ГЛАВНОГО потока, а в выборку блокировки идёт
 * `min(лаг, CPU за интервал)` — та часть задержки, которую объясняет реальная
 * работа потока. Вытеснение простаивающего потока даёт CPU ≈ 0 и в выборку не
 * попадает, синхронная запись (CPU + системное время того же потока, включая
 * работу внутри нативных вызовов) попадает целиком. Лаг пинга и суммарное
 * CPU-время остаются в отчёте (`p99`, `cpuMs`), плюс число пингов ловит
 * блокировку на всё окно.
 *
 * Рантайм без `process.threadCpuUsage` (Node < 22.9): выборка блокировки — сам
 * лаг, то есть прежний критерий, как было до этой правки.
 *
 * ГРАНИЦА КРИТЕРИЯ (осознанный компромисс, замечание верификатора по 21a3be38):
 * блокировку главного потока БЕЗ потребления им CPU критерий не видит. Пример —
 * `Atomics.wait` на 150 мс: лаг 146 мс, CPU главного потока 0, `min` даёт 0, замер
 * зелёный (прежний сырой лаг дал бы 146 > 50). Отличить такую блокировку от
 * вытеснения простаивающего потока планировщиком по доступным метрикам нельзя:
 * оба сценария — «спал, проснулся поздно, CPU не тратил», а на 2-vCPU ВМ второе
 * встречается штатно. Критерий покрывает рабочую нагрузку пула (SQLite-запись,
 * чтение карточек), где блокировка идёт через CPU и системное время потока; для
 * сценариев с ожиданием без CPU нужен другой сигнал (например, таймаут самой
 * задачи или проверка её длительности), а не лаг пинга.
 */

import assert from 'node:assert/strict';

/** Период пинга главного потока, мс. */
export const PING_PERIOD_MS = 5;
/** Базовый потолок незагруженной машины, мс (критерий ТП). */
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
 * Потолок блокировки через пул с учётом синхронного ориентира:
 * `clamp(syncP99 * POOL_BLOCK_SHARE, PING_P99_CEIL_MS, PING_P99_MAX_CEIL_MS)`.
 * При регрессии (работа снова в главном потоке) p99 блокировки через пул
 * сближается с синхронным ориентиром и выходит за потолок — сторож краснеет.
 */
export function poolCeiling(syncP99: number): number {
  return Math.min(
    PING_P99_MAX_CEIL_MS,
    Math.max(PING_P99_CEIL_MS, syncP99 * POOL_BLOCK_SHARE),
  );
}

/** CPU-время потока: микросекунды, как отдаёт `process.cpuUsage`. */
interface CpuUsage {
  user: number;
  system: number;
}

type ThreadCpuUsageFn = () => CpuUsage;

/** `process.threadCpuUsage` (Node 22.9+); `null` на более старом рантайме. */
function threadCpuUsage(): CpuUsage | null {
  const { threadCpuUsage: fn } = process as unknown as { threadCpuUsage?: ThreadCpuUsageFn };
  if (typeof fn !== 'function') return null;
  return fn.call(process);
}

/** CPU-время между снимками, мс; `null`, если снимки недоступны. */
function cpuDeltaMs(from: CpuUsage | null, to: CpuUsage | null): number | null {
  if (from === null || to === null) return null;
  return (to.user - from.user + (to.system - from.system)) / 1000;
}

/** Результат замера блокировки главного потока вокруг нагрузки. */
export interface PingLagResult {
  /** Сколько пингов успело отработать за нагрузку. */
  pings: number;
  /** p99 лага пинга главного потока, мс (диагностика и ориентир по времени). */
  p99: number;
  /**
   * p99 блокировки главного потока, мс: лаг тика, взвешенный CPU-временем
   * главного потока за тот же интервал (`min`). Без `process.threadCpuUsage`
   * совпадает с `p99`.
   */
  p99Blocked: number;
  /** Сколько пингов пришлось на время занятого воркера пула. */
  busy: number;
  /**
   * Суммарное CPU-время ГЛАВНОГО потока за окно, мс (user + system);
   * `null` — рантайм без `process.threadCpuUsage` (Node < 22.9).
   */
  cpuMs: number | null;
}

/**
 * Запустить сэмплер лага главного потока. Тик ставится с расчётом «предыдущий +
 * период»; разница с фактом — сколько поток не крутил событийный цикл
 * (просроченный тик на синхронном пути отчитывается длительностью всей записи).
 * Рядом с лагом снимается CPU-время потока — в выборку блокировки идёт меньшая
 * из двух величин (см. шапку модуля).
 *
 * `isBusy` опрашивается на каждом пинге — для проверки «окна перекрытия» с
 * занятым воркером пула. Вернуть — `stop()`: дожидается `PING_SETTLE_MS`, чтобы
 * просроченный тик успел отчитаться, останавливает замер и отдаёт статистику.
 */
export function startPingLag(
  isBusy: () => boolean = () => false,
): () => Promise<PingLagResult> {
  const cpuStart = threadCpuUsage();
  let cpuPrev = cpuStart;
  const lags: number[] = [];
  const blocked: number[] = [];
  let busy = 0;
  let expected = Date.now() + PING_PERIOD_MS;
  let stopped = false;
  let handle: NodeJS.Timeout | null = null;
  const tick = (): void => {
    if (stopped) return;
    const now = Date.now();
    const lag = now - expected;
    const cpuNow = threadCpuUsage();
    const cpuMs = cpuDeltaMs(cpuPrev, cpuNow);
    if (cpuNow !== null) cpuPrev = cpuNow;
    lags.push(lag);
    blocked.push(cpuMs === null ? lag : Math.min(lag, Math.max(0, cpuMs)));
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
    return {
      pings: lags.length,
      p99: p99(lags),
      p99Blocked: p99(blocked),
      busy,
      cpuMs: cpuDeltaMs(cpuStart, threadCpuUsage()),
    };
  };
}

/**
 * Проверка критерия «нагрузка через пул не блокирует главный поток»: сравнение
 * замера через пул с синхронным ориентиром того же прогона.
 *
 * Синхронный ориентир обязан быть реальной работой главного потока (блокировка
 * по CPU-взвешенной выборке не меньше базового порога), иначе потолок
 * относительного критерия съезжает вниз. Через пул p99 блокировки обязан
 * уложиться в `poolCeiling` синхронного ориентира.
 */
export function assertPoolUnblocks(sync: PingLagResult, pooled: PingLagResult): void {
  assert.ok(
    sync.p99Blocked >= PING_P99_CEIL_MS,
    `синхронный ориентир — работа главного потока (p99 блокировки ${sync.p99Blocked.toFixed(1)} мс, ` +
      `CPU ${sync.cpuMs === null ? '—' : sync.cpuMs.toFixed(1)} мс)`,
  );
  const ceiling = poolCeiling(sync.p99Blocked);
  assert.ok(
    pooled.p99Blocked <= ceiling,
    `p99 блокировки главного потока через пул ${pooled.p99Blocked.toFixed(1)} мс > потолка ` +
      `${ceiling.toFixed(1)} мс (синхронный ориентир ${sync.p99Blocked.toFixed(1)} мс, ` +
      `лаг пинга ${pooled.p99.toFixed(1)} мс, CPU ${pooled.cpuMs === null ? '—' : pooled.cpuMs.toFixed(1)} мс) — ` +
      `главный поток блокируется`,
  );
}
