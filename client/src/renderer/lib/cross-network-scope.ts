/**
 * Persistent state of the «по всем сетям» toggle in the entity picker
 * (задача eb1a3f43, требование 79755f76 «Переключатель «по всем сетям» в
 * диалоге выбора»).
 *
 * Состояние хранится на клиенте и переживает перезапуск. Умолчание —
 * ВЫКЛЮЧЕНО (поиск по текущей сети), как требует спека. Включённый
 * переключатель направляет живой поиск кандидатов и проверку дублей
 * диалога в веерный режим (см. `cross-network-search-service` на сервере
 * и `etn.thoughts.findDuplicatesAcrossNetworks` на клиенте). Сам охват в
 * каждом случае выбирает пользователь — модуль хранит только факт
 * включения.
 *
 * Сервер и API не задействованы: состояние полностью локальное,
 * переживает перезапуск приложения.
 */

const STORAGE_KEY = 'etn.crossNetworkScope';

/** localStorage за guard'ом: недоступен (Node-тесты, hardened-контексты) → null. */
function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Текущее значение переключателя. Если в storage ничего нет или значение
 * повреждено — `false` (умолчание спеки).
 */
export function loadCrossNetworkScope(): boolean {
  const ls = storage();
  if (ls === null) return false;
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (raw === null) return false;
    return raw === '1' || raw === 'true';
  } catch {
    return false;
  }
}

/**
 * Алиас для {@link loadCrossNetworkScope} — семантически «включён ли сейчас
 * кросс-сетевой режим». Имя подходит для мест, где важен именно факт
 * активного режима, а не источник значения.
 */
export function isCrossNetworkScopeEnabled(): boolean {
  return loadCrossNetworkScope();
}

/**
 * Сохранить значение и оповестить подписчиков. Best-effort: если storage
 * недоступен — тихо игнорируем (как и `recent-values`). Тогда переключатель
 * живёт только до перезапуска, но UI продолжает работать. Подписчики
 * вызываются в любом случае: они отражают «запрошенное пользователем
 * состояние» в `aria-pressed` (см. `makeCrossNetworkScopeToggle`), и без
 * оповещения UI останется со старой иконкой.
 */
export function saveCrossNetworkScope(value: boolean): void {
  const ls = storage();
  if (ls !== null) {
    try {
      ls.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch {
      // ignore — квота или privacy-mode
    }
  }
  // Оповещаем даже при отсутствии storage: подписчики могли инициализироваться
  // с реальным storage, а тест/среда выполнения — без него. Кроме того, это
  // дешевле, чем разделять «успех записи» и «смену состояния».
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      // Ошибка одного подписчика не должна ронять остальные (best-effort UI).
    }
  }
}

/**
 * Подписка на изменение состояния: вызывающий регистрирует колбэк, который
 * вызывается при каждом `saveCrossNetworkScope`. Возвращает функцию
 * отписки. Реализация — простой массив: подписчиков мало (один-два
 * диалога), заводить EventTarget смысла нет.
 */
export function subscribeCrossNetworkScope(
  listener: (value: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const listeners = new Set<(value: boolean) => void>();
