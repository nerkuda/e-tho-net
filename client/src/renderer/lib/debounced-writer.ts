/**
 * Отложенная (debounced) запись, переживающая перемонтирование модуля.
 *
 * Зачем отдельный помощник. Строка поиска карты (`search/search.ts`) сохраняет
 * настройки в L4 `ui_state` с задержкой, а её панель пересобирается при каждом
 * открытии мыслесети. Прятать таймер в модуле и снимать его на сбросе нельзя:
 * настройка, изменённая меньше чем за задержку до ухода из сети, терялась бы
 * (ошибка 438092f6, замечание верификатора). Поэтому ключ (сеть) и полезная
 * нагрузка фиксируются В МОМЕНТ планирования, а сброс модуля отложенную запись
 * НЕ отменяет — она одноразово досылается в свою сеть и после перемонтирования.
 *
 * Схлопываются (перепланируются) только записи ОДНОГО ключа; запись чужого
 * ключа не трогается — иначе новое монтирование сорвало бы чужой досыл.
 */

/** Рукоятка отложенной записи (чистый модуль, без DOM/сети). */
export interface DebouncedWriter {
  /** Отложить запись `payload` под ключом `key` (обычно id сети). */
  schedule(key: string, payload: string): void;
  /** Есть ли сейчас запланированная (ещё не сработавшая) запись. */
  hasPending(): boolean;
}

/**
 * Создаёт отложенную запись с задержкой `delayMs` (по умолчанию 300 мс).
 * `write` зовётся один раз на запланированную пару `(key, payload)`.
 */
export function createDebouncedWriter(
  write: (key: string, payload: string) => void,
  delayMs = 300,
): DebouncedWriter {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingKey: string | null = null;
  return {
    schedule(key: string, payload: string): void {
      // Перепланируем только свою запись: чужой ключ не трогаем.
      if (timer !== null && pendingKey === key) clearTimeout(timer);
      pendingKey = key;
      const handle = setTimeout(() => {
        // Обнуляем ссылки только если это всё ещё наш таймер: новое
        // монтирование могло успеть поставить свой — его обнулять нельзя.
        if (timer === handle) {
          timer = null;
          pendingKey = null;
        }
        write(key, payload);
      }, delayMs);
      timer = handle;
    },
    hasPending(): boolean {
      return timer !== null;
    },
  };
}
