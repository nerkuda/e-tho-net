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

import type { LinkPropertySide } from '@etn/shared';

import { etn } from './etn.js';
import { linkEntryMatchesPick } from './link-entry-match.js';
import { signalPublicationCompositionChanged } from './live/index.js';

/** Минимум выбранного свойства-связи, нужный для записи (совместим с LinkPropertyPick). */
export interface LinkPropertyWritePick {
  propertyId: string;
  key: string;
  /** Сторона выбранной строки: у двухстороннего свойства id общий (45248206). */
  side?: LinkPropertySide | null;
}

/**
 * Добавляет якорь в набор значения свойства-связи владельца (ошибка 1dd08949):
 * существующие цели ЧИТАЮТСЯ и объединяются с якорем — `properties.set`
 * заменяет набор целиком, а добавление не должно молча терять уже
 * проставленные значения. Ключ записи — display-имя выбранной стороны, и
 * `side` едет вместе с ним: при симметричном имени направление по одному
 * ключу не выводится (ошибка d9bc6012 — раньше адрес терялся, и рёбра ложились
 * по живым/привязке).
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
    // Обе стороны двухстороннего свойства несут один `property_id` (ошибка
    // 45248206): запись ищем по id + стороне, иначе берётся набор чужой
    // стороны. Легаси-ребро без реестрового свойства — по имени стороны.
    const entry = values.find((v) => 'values' in v && linkEntryMatchesPick(v, pick));
    if (entry !== undefined && 'values' in entry) {
      existing = entry.values.map((it) => it.target_id);
    }
  } catch {
    /* набор не прочитался — пишем только якорь (лучше связь, чем отказ) */
  }
  const targets = existing.includes(anchorId) ? existing : [...existing, anchorId];
  await etn.properties.set(networkId, 'thought', ownerId, pick.key, targets, pick.side ?? null);
  // Своё значение свойства-связи меняет состав публикации: сигнал слоя (до B1)
  // с владельцем и якорем.
  signalPublicationCompositionChanged([ownerId, anchorId]);
}
