/**
 * Бейдж «сегодня» на закладке «Дневник» в навигации видов (0.16.1, задача
 * 173f1540; элемент интерфейса 23887005).
 *
 * Число бейджа — вхождения напоминаний «сегодня + просроченные»: момент показа
 * раньше конца местных суток (счёт — `dueReminderCount` из
 * `lib/ui/task-panel-model.ts`, та же формула, что у секций «Просрочено» и
 * «Сегодня» панели). Горизонт прошлого — `REMINDERS_OVERDUE_DAYS`, как у панели.
 *
 * Обновление: первая загрузка при монтировании рабочего пространства, каждое
 * событие `reminders.changed` (напоминания персональны — событие приходит только
 * владельцу, ADR 03e429ed), каждая смена видимости субъекта — корзина,
 * `active`, настройка `show_inactive` (общий классификатор
 * `lib/live/reminder-events.ts`, ошибка 71cb791e) — и смена активной сети;
 * волна событий коалесится в один запрос. `comment.*` в счёт не входит:
 * напоминание адресует мысль или публикацию (`reminders.subject_type`), а
 * видимость строки — `active`/`marked_for_deletion` субъекта
 * (`domain/reminder-service.ts`), поэтому ни правка, ни удаление комментария
 * набор строк владельца не меняют — подписка на `comment.updated` давала
 * сетевой запрос вхолостую на каждое событие каждого участника сети (ошибка
 * 39d78d2a). Ноль — бейдж скрыт. Клик — «Дневник» на сегодня (единый переход
 * `openChronicleDay`, второго пути нет).
 *
 * Сам бейдж — фасад `lib/ui/badge.ts`; модуль владеет только счётом, окном
 * запроса и подпиской.
 */

import { store } from '../../state.js';
import { etn } from '../../lib/etn.js';
import { t } from '../../lib/i18n.js';
import { onRoutedRealtimeEvent } from '../../lib/live/event-router.js';
import { isReminderSubjectVisibilityEvent } from '../../lib/live/reminder-events.js';
import { badge, setBadgeText } from '../../lib/ui/badge.js';
import {
  REMINDERS_OVERDUE_DAYS,
  dueReminderCount,
  shiftDay,
} from '../../lib/ui/task-panel-model.js';
import { localDayEnd, localDayStart, todayLocal } from './diary.js';

/** Класс бейджа (DOM-пробы и сторож). */
export const REMINDER_TODAY_BADGE_CLASS = 'view-tab-badge';

/** Опции монтирования. */
export interface ReminderTodayBadgeOptions {
  /** Переход в «Дневник» на сегодня (клик по бейджу). */
  openToday(): void;
}

/**
 * Смонтировать бейдж «сегодня» внутрь кнопки вида. Возвращает снятие подписок —
 * как прочие `mountX`: подписки живут ровно столько, сколько рабочее
 * пространство (ошибка 37b713de).
 */
export function mountReminderTodayBadge(
  button: HTMLElement,
  options: ReminderTodayBadgeOptions,
): () => void {
  const node = badge('', {
    kind: 'pill',
    tone: 'accent',
    // Класс `hidden` не заводим: видимостью владеет АТРИБУТ `hidden`, а
    // `.hidden` из `styles/tokens.css` (`display:none !important`) не снимался
    // вместе с атрибутом — бейдж оставался невидимым (блокер приёмки 173f1540).
    extraClass: REMINDER_TODAY_BADGE_CLASS,
  });
  node.hidden = true;
  node.setAttribute('aria-live', 'polite');
  button.append(node);

  let disposed = false;
  /** Запрос в полёте — коалесинг волны событий в один пересчёт. */
  let loading = false;
  /** Пересчёт запрошен, пока шёл запрос. */
  let pending = false;

  /** Покрасить бейдж по числу: ноль — скрыт (элемент 23887005). */
  const apply = (count: number): void => {
    setBadgeText(node, count === 0 ? '' : String(count));
    node.hidden = count === 0;
    const title = t('reminder.todayBadge', [count]);
    node.title = title;
    node.setAttribute('aria-label', title);
  };

  /** Перечитать напоминания владельца на окно «просрочка…сегодня». */
  const refresh = (): void => {
    if (disposed) return;
    const networkId = store.state.networkId;
    if (networkId === null) {
      apply(0);
      return;
    }
    if (loading) {
      pending = true;
      return;
    }
    const today = todayLocal();
    const from = localDayStart(shiftDay(today, -REMINDERS_OVERDUE_DAYS));
    const to = localDayEnd(today);
    loading = true;
    // `etn.reminders` читается ВНУТРИ цепочки: в юнит-тестах моста может не
    // быть, и отказ обязан попасть в `catch`, а не вылететь синхронно.
    void Promise.resolve()
      .then(() => etn.reminders.list(networkId, { from, to }))
      .then((result) => {
        // Смена сети во время запроса — ответ уже не про текущий контекст.
        if (disposed || store.state.networkId !== networkId) return;
        apply(dueReminderCount(result, Date.parse(to)));
      })
      .catch(() => {
        // Недоступный сервер: бейдж остаётся в прежнем состоянии — молчаливое
        // «0» скрыло бы напоминания, о которых мы просто не смогли спросить.
      })
      .finally(() => {
        loading = false;
        if (pending) {
          pending = false;
          refresh();
        }
      });
  };

  const onClick = (event: Event): void => {
    // Клик по бейджу — переход, а не повторный клик по закладке вида.
    event.stopPropagation();
    options.openToday();
  };
  node.addEventListener('click', onClick);

  const unsubscribeEvents = onRoutedRealtimeEvent((event) => {
    // `reminders.changed` — сам набор строк владельца. Видимость субъекта
    // (корзина, `active`, `show_inactive`) меняет его БЕЗ этого события — её
    // опознаёт общий классификатор (ошибка 71cb791e). `comment.*` набор не
    // меняет: строки считаются по субъекту-мысли/публикации, а не по тексту
    // комментария (ошибка 39d78d2a), поэтому подписка на них — запрос вхолостую.
    if (event.network_id !== store.state.networkId) return;
    if (event.type !== 'reminders.changed' && !isReminderSubjectVisibilityEvent(event)) return;
    refresh();
  });
  // Смена активной сети (вкладки) — другой список владельца: пересчитать.
  let lastNetworkId = store.state.networkId;
  const unsubscribeStore = store.subscribe(() => {
    if (store.state.networkId === lastNetworkId) return;
    lastNetworkId = store.state.networkId;
    apply(0);
    refresh();
  });

  refresh();

  return () => {
    disposed = true;
    node.removeEventListener('click', onClick);
    unsubscribeEvents();
    unsubscribeStore();
    node.remove();
  };
}
