/**
 * «Открытые дела» и напоминания в карточке мысли (0.16.1, задача f34066e1,
 * операция 22f1ea95; ADR 43abd7dd «ростер MCP не растёт»).
 *
 * Паритет MCP без новых инструментов: «что открытого по мысли?» агент читает
 * из meta карточки (`etn.thoughts.get` / `etn.thoughts.resolve`), а полный
 * перебор — действиями `tasks.list` / `reminders.list` исполнителя `etn.ops`.
 *
 * Блоки собираются ТОЛЬКО по флагу `include_task_meta` на стороне фасада: здесь
 * нет решения «включать ли», есть сборка. Обе части читающие — ни задачная
 * проекция (`listTasks`), ни напоминания (`listReminders`) при чтении не пишут
 * (ленивое продвижение `next_at` считается в домене, строка БД не меняется).
 *
 * Бюджеты ({@link THOUGHT_META_TASKS_LIMIT}, {@link THOUGHT_META_REMINDERS_LIMIT})
 * держат карточку карточкой: `total` считает всё, `items` — ближайшее, признак
 * `truncated` говорит агенту, что остальное добирается списком. Замер бюджета
 * ответа — сторож `guard-mcp-list-projection`.
 */

import {
  THOUGHT_META_REMINDERS_LIMIT,
  THOUGHT_META_TASKS_LIMIT,
  type ThoughtOpenTaskItem,
  type ThoughtOpenTasksMeta,
  type ThoughtReminderItem,
  type ThoughtRemindersMeta,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { listReminders } from './reminder-service.js';
import { listTasks } from './task-service.js';

/** Параметры сборки блоков карточки. */
export interface ThoughtDealsMetaOptions {
  /** Владелец ключа — напоминания персональны (per-user). */
  userId: string;
  /** Настройка сети «Показывать неактуальные мысли и связи» владельца. */
  showInactive: boolean;
}

/** Блоки «Открытые дела» + напоминания карточки мысли. */
export interface ThoughtDealsMeta {
  open_tasks: ThoughtOpenTasksMeta;
  reminders: ThoughtRemindersMeta;
}

/**
 * Незакрытые задачи, где мысль — субъект строки (`thought_id` в
 * `task_row_subjects`). Видимость строк — как у `GET /tasks`: победитель цепочки
 * слоя, задачи постоянных комментариев помеченных на удаление сущностей не
 * возвращаются (`buildFilter`).
 */
function openTasksOf(ndb: NetworkDb, thoughtId: string): ThoughtOpenTasksMeta {
  const page = listTasks(ndb, {
    scope: 'open',
    thoughtId,
    limit: THOUGHT_META_TASKS_LIMIT,
    count: true,
  });
  const items: ThoughtOpenTaskItem[] = page.items.map((task) => ({
    comment_id: task.comment_id,
    line_no: task.line_no,
    text: task.text,
    due: task.due,
    period_from: task.period_from,
    period_to: task.period_to,
    owner_type: task.owner_type,
    owner_id: task.owner_id,
    subject_state: task.subject_state,
  }));
  const total = page.total ?? items.length;
  return {
    total,
    shown: items.length,
    truncated: total > items.length,
    items,
  };
}

/**
 * Напоминания ЗАПРОСИВШЕГО о мысли. Видимость субъекта — как у
 * `reminders.list`: помеченный на удаление субъект скрыт, неактуальный —
 * только по настройке сети `show_inactive`.
 */
function remindersOf(
  ndb: NetworkDb,
  thoughtId: string,
  options: ThoughtDealsMetaOptions,
): ThoughtRemindersMeta {
  const { reminders } = listReminders(ndb, options.userId, {
    subject_type: 'thought',
    subject_id: thoughtId,
    show_inactive: options.showInactive,
  });
  const items: ThoughtReminderItem[] = reminders
    .slice(0, THOUGHT_META_REMINDERS_LIMIT)
    .map((reminder) => ({
      id: reminder.id,
      kind: reminder.kind,
      next_at: reminder.next_at,
      subject_state: reminder.subject_state,
    }));
  return {
    total: reminders.length,
    shown: items.length,
    truncated: reminders.length > items.length,
    items,
  };
}

/** Собрать блоки «Открытые дела» и напоминания для одной карточки мысли. */
export function getThoughtDealsMeta(
  ndb: NetworkDb,
  thoughtId: string,
  options: ThoughtDealsMetaOptions,
): ThoughtDealsMeta {
  return {
    open_tasks: openTasksOf(ndb, thoughtId),
    reminders: remindersOf(ndb, thoughtId, options),
  };
}
