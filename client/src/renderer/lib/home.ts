/**
 * HOME сети — общий резолвер корневой мысли (0.15.4, тех.проект 43329662,
 * задача 33ed043c).
 *
 * **Зачем.** HOME нужен в разных местах рендерера: экран «Дневник» скрывает
 * первичную привязку записи (требование c81964c7), а строка дневниковой записи
 * в результатах поиска и на вкладке «Упоминания» — тот же фильтр видимых
 * привязок. Раньше резолвер жил модульной функцией `getHome()` внутри
 * `screens/chronicle/chronicle.ts`; копия во втором месте разошлась бы
 * (стандарт a2488f05), поэтому кеш вынесен в общий модуль.
 *
 * **Контракты, перенесённые из экрана (без изменения поведения):**
 *  * кеш привязан к сети: результат для прежней сети не публикуется, если сеть
 *    успела смениться, пока промис летел (ошибка ab4e499f);
 *  * сбой разрешения НЕ кешируется навсегда: промис сбрасывается, и следующее
 *    обращение делает новую попытку, а не живёт в fallback до перезагрузки
 *    (ошибка 810520c5).
 *
 * Синхронный доступ к уже разрешённому HOME — {@link cachedHomeId} (нужен
 * местам, которые рисуются до получения промиса: геттеры и обработчики).
 */

import { findRootThought } from './layer-resync.js';

/** Разрешённый HOME (id) и сеть, для которой он разрешён. */
let homeId: string | null = null;
let homeNetworkId: string | null = null;
/** Разрешение в полёте — один запрос на сеть, а не по одному на потребителя. */
let homePromise: Promise<string> | null = null;

/**
 * HOME указанной сети (id корневой мысли). Первый вызов делает запрос, дальше —
 * кеш; промис общий, повторные обращения во время полёта ждут его.
 */
export async function getHomeId(networkId: string): Promise<string> {
  if (homeId !== null && homeNetworkId === networkId) return homeId;
  if (homePromise === null || homeNetworkId !== networkId) {
    homeNetworkId = networkId;
    homePromise = findRootThought(networkId)
      .then((root) => {
        // Промис мог завершиться уже после смены сети: не затираем кеш HOME
        // чужой сети (ошибка ab4e499f).
        if (homeNetworkId === networkId) homeId = root.id;
        return root.id;
      })
      .catch((err: unknown) => {
        // Сбой разрешения HOME не кэшируем навсегда: сбрасываем промис, чтобы
        // следующее обращение сделало новую попытку (ошибка 810520c5).
        if (homeNetworkId === networkId) {
          homePromise = null;
          homeNetworkId = null;
        }
        throw err;
      });
  }
  return homePromise;
}

/**
 * Уже разрешённый HOME указанной сети или `null` (ещё не разрешён / разрешён
 * для другой сети). Синхронно — для геттеров и обработчиков, которым нельзя
 * ждать промис.
 */
export function cachedHomeId(networkId: string | null): string | null {
  if (homeId === null || homeNetworkId === null) return null;
  return homeNetworkId === networkId ? homeId : null;
}

/** Сброс кеша HOME (смена сети/пересборка экрана): следующее обращение — заново. */
export function resetHomeCache(): void {
  homeId = null;
  homeNetworkId = null;
  homePromise = null;
}
