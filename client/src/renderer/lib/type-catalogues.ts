/**
 * Перечитывание каталогов типов мыслей/связей в store (L21).
 *
 * Вынесено из снесённого `realtime-ui.ts` (G6 техпроекта 269016e2). Чужое
 * событие о типе приходит через роутер слоя и гасит ключ `types-catalog`;
 * подписчики ключа (редактор, менеджер свойств) и производные эффекты
 * (`realtime-effects.ts`) перечитывают каталоги этим вызовом.
 *
 * Параллельные перезапросы (одно realtime-событие о типе уведомляет несколько
 * слушателей, и редактору нужен именно ОБНОВЛЁННЫЙ каталог) делят один запрос:
 * пока перезапрос в полёте, повторный вызов возвращает тот же промис. Так
 * потребитель может дождаться свежего каталога, не порождая второй запрос.
 */

import { etn } from './etn.js';
import { store } from '../state.js';

/** In-flight перезапрос каталогов (см. {@link reloadTypeCatalogues}). */
let typeCataloguesReload: Promise<void> | null = null;

/** Reloads both type catalogues into the store (L21 — the hierarchy changed). */
export function reloadTypeCatalogues(): Promise<void> {
  if (typeCataloguesReload !== null) return typeCataloguesReload;
  const pending = (async () => {
    const networkId = store.state.networkId;
    if (networkId === null) return;
    try {
      const [thoughtTypes, linkTypes] = await Promise.all([
        etn.types.listThoughtTypes(networkId),
        etn.types.listLinkTypes(networkId),
      ]);
      store.update({ thoughtTypes, linkTypes });
    } catch {
      // The network may have just been closed — ignore.
    }
  })().finally(() => {
    typeCataloguesReload = null;
  });
  typeCataloguesReload = pending;
  return pending;
}
