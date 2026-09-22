/**
 * Чистая логика порционной подгрузки секторов карты мыслей (задача
 * c8fa74ba): размер порции, счётчики, решение «пора ли догружать» и модель
 * плавающего индикатора-числа.
 *
 * Без DOM — поэтому проверяется обычными юнит-тестами без DOM-шима
 * (`tests/zone-paging.test.ts`). Отрисовка секторов и сами запросы остаются
 * в `canvas/canvas.ts`; новые правила количества/порога клади сюда.
 */

/**
 * Размер порции облачков в секторе. Совпадает с дефолтом сервера для
 * `GET /thoughts/{id}/neighbors` (`getNeighbors`, docs/03-server-api.md §6.7):
 * сервер уже отдаёт первые 50 мыслей каждого сектора в ответе фокуса, поэтому
 * следующая порция запрашивается с `offset`, равным израсходованным строкам.
 */
export const ZONE_PAGE_SIZE = 50;

/** Порог близости к нижней границе сектора, px: ближе — догружаем порцию. */
export const ZONE_FETCH_THRESHOLD_PX = 200;

/** Счётчики порционной подгрузки одного сектора. */
export interface ZonePagingCounters {
  /** Сколько сырых строк сервера уже израсходовано (offset следующей порции). */
  loaded: number;
  /** Общее число мыслей сектора по серверу; -1 — ещё не известно. */
  total: number;
  /** Идёт ли запрос порции прямо сейчас. */
  loading: boolean;
}

/** Новые счётчики сектора: количество ещё не известно, порция не грузится. */
export function createZonePaging(): ZonePagingCounters {
  return { loaded: 0, total: -1, loading: false };
}

/** Известно ли общее количество мыслей сектора. */
export function totalKnown(c: ZonePagingCounters): boolean {
  return c.total >= 0;
}

/** Есть ли ещё неподгруженные мысли и не идёт ли запрос прямо сейчас. */
export function hasMore(c: ZonePagingCounters): boolean {
  return totalKnown(c) && !c.loading && c.loaded < c.total;
}

/**
 * Близко ли окно сектора к нижней границе контента. `scroll` — обычные
 * метрики скроллера (`scrollTop`/`clientHeight`/`scrollHeight`); остаток
 * меньше порога — пора догружать.
 */
export function isNearBottom(
  scroll: { scrollTop: number; clientHeight: number; scrollHeight: number },
  thresholdPx: number = ZONE_FETCH_THRESHOLD_PX,
): boolean {
  const remaining = scroll.scrollHeight - (scroll.scrollTop + scroll.clientHeight);
  return remaining <= thresholdPx;
}

/**
 * Итоговое решение: догружать ли следующую порцию при текущем состоянии
 * скролла сектора. Пиксельные метрики неотрицательны; порог по умолчанию —
 * {@link ZONE_FETCH_THRESHOLD_PX}.
 */
export function shouldLoadMore(
  c: ZonePagingCounters,
  scroll: { scrollTop: number; clientHeight: number; scrollHeight: number },
  thresholdPx: number = ZONE_FETCH_THRESHOLD_PX,
): boolean {
  return hasMore(c) && isNearBottom(scroll, thresholdPx);
}

/**
 * Подпись плавающего индикатора-числа: строка с общим количеством мыслей
 * сектора. `null` — индикатор не показывать (пустой сектор или количество ещё
 * неизвестно).
 */
export function zoneCountLabel(total: number): string | null {
  if (total <= 0) return null;
  return String(total);
}
