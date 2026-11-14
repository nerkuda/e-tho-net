/**
 * Движок повторов напоминаний — реэкспорт единственной реализации из
 * `@etn/shared` (0.16.1, задача b47f1fd2; требование bbca8f7d).
 *
 * Расчёт серии вхождений нужен обеим сторонам: серверу (`next_at`, раскрытие на
 * период, snooze/dismiss) и клиентскому редактору напоминания (preview первых
 * вхождений до сохранения). Реализация живёт в `@etn/shared`; здесь — только
 * прежняя точка импорта для домена и тестов сервера, чтобы не плодить вторую
 * реализацию грамматики (элемент 58cca4f7: preview и GET считает один
 * вычислитель).
 */

export {
  MS_PER_DAY,
  assertScheduleKind,
  computeNextAt,
  expandOccurrences,
  firstOccurrenceOnOrAfter,
  kindOfSchedule,
  nextCandidate,
  normalizeAnchor,
  parseInstant,
  validateSchedule,
} from '@etn/shared';
export type { ExceptionMap, ReminderNextCandidate } from '@etn/shared';
