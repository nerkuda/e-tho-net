/**
 * Запись значения свойства-связи (задача d144ef71). Общая для диалога
 * добавления с карты (`canvas/add-dialog.ts`) и дропа мысли на облачко
 * (`lib/thought-drop.ts`): раньше тела были продублированы, и дроп терял
 * сигнал о смене состава публикации.
 *
 * Модуль намеренно cycle-free (только `lib/etn`, `lib/live`) — его подключает
 * `lib/thought-drop.ts`, который импортируется из `canvas/drag-cloud.ts`
 * (грабли `b03595af`: lib-модуль, втянутый в канву, не должен тянуть
 * canvas/editor).
 */

import { etn } from './etn.js';
import { signalPublicationCompositionChanged } from './live/index.js';

/** Минимум выбранного свойства-связи, нужный для записи (совместим с LinkPropertyPick). */
export interface LinkPropertyWritePick {
  propertyId: string;
  key: string;
}

/**
 * Добавляет якорь в набор значения свойства-связи владельца (ошибка 1dd08949):
 * существующие цели ЧИТАЮТСЯ и объединяются с якорем — `properties.set`
 * заменяет набор целиком, а добавление не должно молча терять уже
 * проставленные значения. Ключ записи — display-имя выбранной стороны; сервер
 * сам выводит направление ребра, поэтому связь ложится в типизированное свойство.
 */
export async function addLinkPropertyValue(
  networkId: string,
  ownerId: string,
  pick: LinkPropertyWritePick,
  anchorId: string,
): Promise<void> {
  let existing: string[] = [];
  try {
    const values = await etn.properties.get(networkId, 'thought', ownerId);
    const entry = values.find((v) => 'values' in v && v.property_id === pick.propertyId);
    if (entry !== undefined && 'values' in entry) {
      existing = entry.values.map((it) => it.target_id);
    }
  } catch {
    /* набор не прочитался — пишем только якорь (лучше связь, чем отказ) */
  }
  const targets = existing.includes(anchorId) ? existing : [...existing, anchorId];
  await etn.properties.set(networkId, 'thought', ownerId, pick.key, targets);
  // Своё значение свойства-связи меняет состав публикации: сигнал слоя (до B1)
  // с владельцем и якорем.
  signalPublicationCompositionChanged([ownerId, anchorId]);
}
