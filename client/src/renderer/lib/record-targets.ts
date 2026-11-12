/**
 * Видимые привязки дневниковой записи — ОДИН предикат для всех поверхностей
 * (0.15.4, тех.проект 43329662, задача 33ed043c, элемент 554e3129).
 *
 * **Зачем.** Строка дневниковой записи рисует чипы привязок (`comment_targets`)
 * и в поиске, и на вкладке «Упоминания», и в ленте экрана «Дневник». Правило
 * «что видно» обязано быть одним: домашняя мысль сети (HOME) — служебная
 * привязка, её не показывают (требование c81964c7), а неактуальные/помеченные
 * на удаление привязки прячутся по общим настройкам видимости клиента.
 * Предикат жил в `screens/chronicle/diary.ts` и фильтровал ТОЛЬКО HOME — вторая
 * копия в строке результата неизбежно разошлась бы (стандарт a2488f05,
 * сторож `guard-record-targets`).
 *
 * **Сужение K4 (решение пользователя 2026-11-10).** Настройка `show_trash`
 * действует ТОЛЬКО на чипы-МЫСЛИ (`ThoughtRef` несёт `marked_for_deletion`);
 * чипы-СВЯЗИ фильтруются только по `active` — в `ChronicleTargetLink` поля
 * пометки удаления нет, и оно не добавляется (контракт `chronicle/query` не
 * меняется). Паритет с чипами истории посещений: там тоже только мысли.
 *
 * Модуль чистый (без DOM и обращений к серверу) — правило проверяется
 * юнит-тестами.
 */

import type { ChronicleTarget } from '@etn/shared';

/**
 * Настройки видимости привязок.
 *
 * Значения по умолчанию у потребителей РАЗНЫЕ и это осознанно: строка
 * результата передаёт обе настройки клиента (паритет с историей посещений),
 * а лента экрана «Дневник» остаётся на прежнем видимом поведении (HOME-only,
 * граница версии) — она передаёт РАЗРЕШАЮЩИЕ флаги `true`/`true`.
 */
export interface RecordTargetsVisibility {
  /** HOME сети записи: служебная привязка, не показывается; `null` — не разрешён. */
  homeId: string | null;
  /** Показывать неактуальные привязки (мысли и связи). */
  showInactive: boolean;
  /** Показывать помеченные на удаление привязки-МЫСЛИ (K4: связи не касается). */
  showTrash: boolean;
}

/**
 * Видимые привязки записи в порядке модели (первичная привязка остаётся
 * первой, если видима). HOME скрывается всегда — это не пользовательская
 * привязка, а место хранения записи.
 */
export function visibleRecordTargets(
  targets: readonly ChronicleTarget[],
  visibility: RecordTargetsVisibility,
): ChronicleTarget[] {
  const { homeId, showInactive, showTrash } = visibility;
  return targets.filter((target) => {
    if (target.kind === 'thought') {
      const thought = target.thought;
      if (homeId !== null && thought.id === homeId) return false;
      if (!showInactive && !thought.active) return false;
      // K4: пометка удаления — только у мысли.
      if (!showTrash && thought.marked_for_deletion) return false;
      return true;
    }
    // K4: чип-связь — только по актуальности (поля пометки удаления у связи нет).
    return showInactive || target.link.active;
  });
}

/** Цель навигации из привязки: мысль или связь (редактор связи — без записи). */
export type RecordTargetRef = { kind: 'thought'; id: string } | { kind: 'link'; id: string };

/** Привязка → цель навигации (id мысли/связи, без доменных подробностей). */
export function recordTargetRef(target: ChronicleTarget): RecordTargetRef {
  return target.kind === 'thought'
    ? { kind: 'thought', id: target.thought.id }
    : { kind: 'link', id: target.link.id };
}
