/**
 * Сопоставление записи значения-связи с выбранной строкой свойства
 * (ошибка 45248206). Чистый помощник без DOM и сети — общий для всех
 * потребителей, которые ищут набор целей по свойству и стороне.
 *
 * У свойства-связи две стороны (`source`/`target`) с разными display-именами,
 * но ОДНИМ реестровым `property_id`: после фикса внетиповой проекции сверять
 * только id нельзя — запись чужой стороны подменит набор (выбор `target`
 * вернул бы `source`). Поэтому при наличии `side` и у записи, и у выбора
 * id-совпадение уточняется стороной. Без стороны (легаси-вызов) — прежнее
 * поведение по id.
 *
 * Имя стороны (`key`/`property_name`) — запасной ключ для легаси-рёбер, у
 * которых реестрового свойства нет (`property_id: ''`, ошибка e5cfacb9).
 */

import type { LinkPropertySide } from '@etn/shared';

/** Минимум записи значения-связи, нужный для сопоставления. */
export interface LinkEntryLike {
  property_id: string;
  property_name: string;
  side?: LinkPropertySide | null;
}

/** Выбранное свойство: реестровый id, display-имя стороны и её сторона. */
export interface LinkEntryMatch {
  propertyId: string;
  key: string;
  side?: LinkPropertySide | null;
}

/**
 * Совпадает ли запись значения-связи с выбранным свойством-строкой.
 *
 * @param entry запись значения (серверная проекция ребра)
 * @param pick выбранная строка списка/`LinkPropertyPick`
 */
export function linkEntryMatchesPick(entry: LinkEntryLike, pick: LinkEntryMatch): boolean {
  if (entry.property_id !== '' && entry.property_id === pick.propertyId) {
    if (pick.side != null && entry.side != null) return entry.side === pick.side;
    return true;
  }
  return entry.property_name === pick.key;
}
