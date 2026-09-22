/**
 * Эффективный фильтр типов связей холста (задача 7e9ec8bf).
 *
 * Цепочка резолва повторяет серверную (`resolveCanvasLinkFilter` для
 * `POST /thoughts/{id}/focus`, требование «Дефолт и хранение фильтра типов
 * связей на карте»): явное сохранённое предпочтение пользователя
 * (`PREF_KEY.CANVAS_LINK_FILTER`) → живой дефолт из `show_on_map` реестра
 * свойств (`computeDefaultCanvasLinkFilter`; та же общая функция, что у сервера
 * и у диалога фильтра). Саму карту фильтрует сервер и отдаёт уже отфильтрованную
 * окрестность, поэтому клиенту резолв был не нужен — а вот превью Ctrl-наведения
 * ходит в `neighbors` напрямую и обязано нести ровно тот же набор `type_ids` +
 * `include_structural`: без этого при незаданном предпочтении карта рисует по
 * `show_on_map`, а превью показывает все связи (отчёт-ошибка e5cee08e, риск 2).
 *
 * Почему кэш живого дефолта привязан к СНИМКУ окрестности фокуса, а не к
 * времени/событиям реестра: сервер резолвит фильтр карты на каждый запрос
 * фокуса, и единственная гарантия «превью показывает то же, что карта» —
 * считать дефолт заново ровно тогда, когда карта получила свежий ответ.
 * Поэтому кэш хранит идентичность `store.state.focus`, для которого он посчитан,
 * и перечитывает реестр, как только окрестность перерисована (навигация,
 * realtime-пересчёт). Внутри одного снимка окрестности — ни одного лишнего
 * запроса: серия Ctrl-наведений делит один промис.
 *
 * Явное предпочтение кэша не требует: его синхронизирует realtime-канал
 * (`store.state.canvasLinkFilter`).
 */

import {
  computeDefaultCanvasLinkFilter,
  type FocusResponse,
  type LinkTypeFilterInput,
} from '@etn/shared';

import { etn } from './etn.js';
import { store } from '../state.js';

/** Кэш живого дефолта: значение действительно, пока жива та же окрестность. */
interface DefaultCacheEntry {
  /** `store.state.focus`, для которого посчитан дефолт (см. шапку модуля). */
  focus: FocusResponse | null;
  filter: Promise<LinkTypeFilterInput>;
}

const defaultFilters = new Map<string, DefaultCacheEntry>();

/** Живой дефолт из реестра свойств, кэшированный в пределах снимка фокуса. */
function defaultCanvasLinkFilter(networkId: string): Promise<LinkTypeFilterInput> {
  const focus = store.state.focus;
  const cached = defaultFilters.get(networkId);
  if (cached !== undefined && cached.focus === focus) return cached.filter;
  const filter = etn.propertyRegistry
    .list(networkId)
    .then((properties) => computeDefaultCanvasLinkFilter(properties))
    .catch((err: unknown) => {
      // Неудача не должна залипнуть в кэше — следующий резолв повторит запрос.
      if (defaultFilters.get(networkId)?.filter === filter) defaultFilters.delete(networkId);
      throw err;
    });
  defaultFilters.set(networkId, { focus, filter });
  return filter;
}

/**
 * Эффективный фильтр для холста: явное предпочтение пользователя, иначе живой
 * дефолт из `show_on_map` реестра свойств. Отклоняется, если реестр не удалось
 * прочитать (вызывающий решает, показывать ли превью без фильтра) — дефолт не
 * выдумываем: пустой фильтр означал бы другой набор связей, чем у карты.
 */
export function resolveEffectiveCanvasLinkFilter(
  networkId: string,
): Promise<LinkTypeFilterInput> {
  const stored = store.state.canvasLinkFilter;
  if (stored !== null) return Promise.resolve(stored);
  return defaultCanvasLinkFilter(networkId);
}
