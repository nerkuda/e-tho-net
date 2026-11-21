/**
 * Индикатор напоминаний в облачке мысли (0.16.1, задача 173f1540; элемент
 * интерфейса ba827eb6).
 *
 * Один индикатор на ВСЕ напоминания субъекта, позиция — ПЕРЕД счётчиком
 * постоянного комментария (📝), как требует элемент. Клик по индикатору ведёт в
 * карточку мысли (секцию напоминаний), Ctrl-наведение открывает общий
 * предпросмотр `lib/hover-preview.ts` со списком всех напоминаний субъекта
 * (даты и повторы).
 *
 * Почему отдельный модуль, а не `lib/cloud-indicators.ts`: счётчики комментариев
 * и вложений читаются по одному запросу на мысль, а напоминания — ОДНИМ списком
 * владельца на сеть (`GET /reminders` без периода). Второй механизм подписок на
 * те же облачка ради другого источника данных только раздвоил бы жизненный
 * цикл; здесь источник один — кэш списка, обновляемый событием
 * `reminders.changed`.
 *
 * Напоминания per-user (ADR 03e429ed), поэтому в DOM они появляются только у
 * владельца — остальным сервер их не отдаёт.
 */

import type { Reminder } from '@etn/shared';

import { div, el, span } from './dom.js';
import { etn } from './etn.js';
import { registerHoverPreviewResolver, markReminderPreview } from './hover-preview.js';
import { t } from './i18n.js';
import { reminderPreviewLines } from './reminder-label.js';
import { onRoutedRealtimeEvent } from './live/index.js';
import { store } from '../state.js';

/** Класс ячейки индикатора напоминаний. */
export const REMINDER_INDICATOR_CLASS = 'ind ind-reminder';

/** Кэш: id мысли → её напоминания (только активные строки владельца). */
let remindersByThought = new Map<string, Reminder[]>();
/** Сеть, для которой загружен кэш. */
let cachedNetworkId: string | null = null;
/** Единственная подписка на события (ставится при первом запросе). */
let unsubscribe: (() => void) | null = null;
/** Запрос уже в полёте — коалесинг волн событий. */
let loading: Promise<void> | null = null;

/** Разложить список напоминаний по субъектам-мыслям. */
function groupByThought(reminders: readonly Reminder[]): Map<string, Reminder[]> {
  const map = new Map<string, Reminder[]>();
  for (const reminder of reminders) {
    if (reminder.state !== 'active' || reminder.subject_type !== 'thought') continue;
    const list = map.get(reminder.subject_id) ?? [];
    list.push(reminder);
    map.set(reminder.subject_id, list);
  }
  return map;
}

/** Покрасить ячейку облачка: есть напоминания — активна, нет — приглушена. */
function applyCell(cell: HTMLElement, has: boolean): void {
  cell.classList.toggle('dim', !has);
  cell.classList.toggle('active', has);
  cell.title = has ? t('reminder.flagTitle') : '';
}

/**
 * Применить кэш ко всем отрисованным облачкам. Вызывается после каждой
 * перерисовки холста (виртуализация пересоздаёт узлы) и после загрузки списка.
 */
export function syncReminderIndicatorCells(): void {
  // Юнит-тесты монтируют холст без документа/селекторов — покраске тогда
  // нечего обходить (не ошибка среды, а отсутствие облачков).
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  for (const cloud of document.querySelectorAll<HTMLElement>('.cloud[data-id]')) {
    const id = cloud.dataset['id'];
    if (id === undefined) continue;
    const cell = cloud.querySelector<HTMLElement>(
      `.cloud-ind .${REMINDER_INDICATOR_CLASS.split(' ').join('.')}`,
    );
    if (cell === null) continue;
    applyCell(cell, remindersByThought.has(id));
  }
}

/** Перечитать напоминания владельца и покрасить индикаторы. */
export async function refreshReminderIndicators(): Promise<void> {
  startReminderIndicatorEvents();
  const networkId = store.state.networkId;
  if (networkId === null) {
    remindersByThought = new Map();
    cachedNetworkId = null;
    syncReminderIndicatorCells();
    return;
  }
  if (loading !== null) return loading;
  // Смена сети: кэш прошлой сети не должен подкрашивать облачка новой —
  // сбрасываем сразу, не дожидаясь ответа.
  if (cachedNetworkId !== networkId) {
    remindersByThought = new Map();
    cachedNetworkId = null;
    syncReminderIndicatorCells();
  }
  // `etn.reminders` читается ВНУТРИ цепочки промисов: в юнит-тестах моста может
  // не быть вовсе (`window.etn` отсутствует), и отказ обязан попасть в `catch`,
  // а не вылететь синхронно из монтирования холста.
  loading = Promise.resolve()
    .then(() => etn.reminders.list(networkId))
    .then((result) => {
      // Смена сети во время запроса — ответ уже не про текущий контекст.
      if (store.state.networkId !== networkId) return;
      remindersByThought = groupByThought(result.reminders);
      cachedNetworkId = networkId;
      syncReminderIndicatorCells();
    })
    .catch(() => {
      // Недоступный сервер: индикаторы остаются приглушёнными, карта работает.
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/**
 * Подписка на события: `reminders.changed` приходит только владельцу и
 * перерисовывает индикаторы без захода в календарь (сценарий S4).
 */
export function startReminderIndicatorEvents(): void {
  if (unsubscribe !== null) return;
  unsubscribe = onRoutedRealtimeEvent((event) => {
    if (event.type !== 'reminders.changed') return;
    if (event.network_id !== store.state.networkId) return;
    void refreshReminderIndicators();
  });
}

/** Сброс кэша и подписки (смена сети/размонтирование/тесты). */
export function resetReminderIndicators(): void {
  unsubscribe?.();
  unsubscribe = null;
  remindersByThought = new Map();
  cachedNetworkId = null;
  loading = null;
}

/**
 * Создать ячейку индикатора для облачка мысли. Ставится ПЕРВОЙ в ряду
 * индикаторов — перед 📝 (элемент ba827eb6); начальное состояние — по кэшу.
 */
export function reminderIndicatorCell(thoughtId: string, thoughtTitle: string): HTMLElement {
  const cell = span('⏰', REMINDER_INDICATOR_CLASS);
  applyCell(cell, remindersByThought.has(thoughtId));
  // Клик — карточка мысли с секцией напоминаний: Ctrl-предпросмотр не мешает
  // обычному клику (он открывается только с зажатым Ctrl).
  markReminderPreview(cell, thoughtId, thoughtTitle);
  return cell;
}

/** Тело предпросмотра: список всех напоминаний субъекта. */
function previewBody(reminders: readonly Reminder[]): HTMLElement {
  const body = div('reminder-preview');
  for (const line of reminderPreviewLines(reminders))
    body.append(el('div', 'reminder-preview-row', line));
  return body;
}

// Резолвер Ctrl-предпросмотра регистрируется один раз при импорте модуля
// (его импортирует холст, владеющий ячейками).
registerHoverPreviewResolver('reminder', async (trigger) => {
  const thoughtId = trigger.dataset['hpOwnerId'];
  if (thoughtId === undefined) return null;
  const reminders = remindersByThought.get(thoughtId) ?? [];
  if (reminders.length === 0) return null;
  return {
    title: trigger.dataset['hpTitle'] ?? t('reminder.flagTitle'),
    body: previewBody(reminders),
  };
});

/** Тестовый шов: прямой набор кэша без сети. */
export const reminderIndicatorInternals = {
  setCache: (reminders: readonly Reminder[]): void => {
    remindersByThought = groupByThought(reminders);
  },
  cachedNetwork: (): string | null => cachedNetworkId,
};
