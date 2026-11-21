/**
 * Классификатор realtime-событий «изменилась видимость содержимого корзины»
 * (0.16.1, пачка 11, задача 173e8368: панели задач при удалении/корзине мысли).
 *
 * **Зачем отдельный признак.** Удаление мысли/связи, помещение в корзину и
 * возврат из неё не меняют ревизию комментариев-источников задач — значит,
 * обычное событие `comment.updated` молчит, а маркер проекции `max_revision`
 * стоит на месте. Но состав списков задач, «связей дня» и маркеров календаря
 * меняется СРАЗУ: у удалённого владельца комментарии физически/надгробием
 * исчезают, у помеченного — скрываются по настройке «показывать содержимое
 * корзины». Поэтому потребители проекции (единая панель `lib/ui/task-list.ts` и
 * экран «Дневник») обязаны перечитать свои выборки по ЭТИМ событиям, не
 * зажигая «Обновить» и не серея строки.
 *
 * **Штатные события (без новых типов).** Корзина мыслей и связей — это
 * `PATCH … { marked_for_deletion }`, фасад публикует стандартное
 * `thought.updated`/`link.updated` с этим полем в `changes`. Публикации имеют
 * собственные `publication.trashed`/`restored`/`purged`, физическое удаление —
 * `thought.deleted`/`link.deleted`. Смена самой настройки приходит
 * `user-preference.updated` (`show_trash`).
 */

import { PREF_KEY, type AnyRealtimeEvent } from '@etn/shared';

/**
 * Событие меняет видимость содержимого корзины для чтений проекции задач.
 * `true` — потребитель перечитывает списки (дебаунс — на его стороне).
 */
export function isTrashVisibilityEvent(event: AnyRealtimeEvent): boolean {
  switch (event.type) {
    case 'thought.deleted':
    case 'link.deleted':
    case 'publication.trashed':
    case 'publication.restored':
    case 'publication.purged':
      return true;
    case 'thought.updated':
    case 'link.updated':
      return Object.prototype.hasOwnProperty.call(event.data.changes, 'marked_for_deletion');
    case 'user-preference.updated':
      return event.data.key === PREF_KEY.SHOW_TRASH;
    default:
      return false;
  }
}
