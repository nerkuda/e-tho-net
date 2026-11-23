/**
 * Классификатор realtime-событий «изменилась видимость субъекта напоминания»
 * (ошибка `71cb791e`).
 *
 * **Зачем отдельный признак.** `listReminders`
 * (`server/src/domain/reminder-service.ts`) не отдаёт напоминание владельцу,
 * если субъект недоступен (нет живой строки в представлении слоя либо
 * `marked_for_deletion`) или неактуален при выключенной настройке сети
 * «показывать неактуальные» (`show_inactive`). Набор видимых строк меняется БЕЗ
 * события `reminders.changed`: сервер публикует его только на CRUD напоминаний.
 * Сигнал приходит штатными событиями данных — их и опознаёт классификатор,
 * чтобы счётчики (бейдж «сегодня», индикатор облачка, флаг шапки, панель
 * «Задачи и напоминания») перечитали список владельца.
 *
 * **Штатные события (без новых типов).** Корзина и возврат — `thought.updated`
 * с `marked_for_deletion`, у публикаций ещё собственные
 * `publication.trashed`/`.restored`/`.purged`; неактуальность — `thought.updated`/
 * `publication.updated` с `active`; смена настройки сети —
 * `user-preference.updated` с ключом `show_inactive`. События визуала (заголовок,
 * иконка) и правки комментариев видимость субъекта не меняют — классификатор их
 * пропускает (граница ошибки `39d78d2a`: лишних пересчётов не добавляем).
 *
 * Классификатор общий для всех потребителей счётчиков — как
 * `live/trash-events.ts` для проекции задач: правило видимости живёт в одном
 * месте, а не в четырёх подписках.
 */

import { PREF_KEY, type AnyRealtimeEvent } from '@etn/shared';

/**
 * Поля `changes`, от которых зависит видимость субъекта в `listReminders`:
 * корзина и неактуальность.
 */
const VISIBILITY_FIELDS = ['marked_for_deletion', 'active'] as const;

/** Затронуто ли в `changes` хоть одно из полей видимости. */
function touchesVisibility(changes: unknown): boolean {
  if (typeof changes !== 'object' || changes === null) return false;
  return VISIBILITY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(changes, field));
}

/**
 * Событие меняет состав напоминаний владельца через видимость субъекта.
 * `true` — потребитель перечитывает список (коалесинг/дебаунс — на его стороне).
 */
export function isReminderSubjectVisibilityEvent(event: AnyRealtimeEvent): boolean {
  switch (event.type) {
    case 'thought.deleted':
    case 'publication.trashed':
    case 'publication.restored':
    case 'publication.purged':
      return true;
    case 'thought.updated':
    case 'publication.updated':
      return touchesVisibility(event.data.changes);
    case 'user-preference.updated':
      return event.data.key === PREF_KEY.SHOW_INACTIVE;
    default:
      return false;
  }
}
