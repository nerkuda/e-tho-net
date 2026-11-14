/**
 * Флаг напоминаний в шапке редактора мысли (0.16.1, задача 173f1540; элемент
 * интерфейса 24ad3735).
 *
 * Рядом с отметкой «Актуально» показывается ЧЕЛОВЕКОЧИТАЕМОЕ представление
 * повтора («ежегодно 8 марта», «каждое 18-е»), а не просто признак «есть
 * напоминание» (решение пользователя 0.16.1). Несколько напоминаний
 * перечисляются через «·».
 *
 * Напоминаний нет — флаг показывает ghost-команду «Напомнить…»: это
 * ЕДИНСТВЕННАЯ точка создания первого напоминания из GUI (блокер приёмки
 * 173f1540), прятать её при нуле нельзя.
 *
 * Клик открывает меню действий по напоминаниям субъекта: создать, изменить
 * расписание, отложить ближайшее вхождение, убрать его и удалить напоминание.
 * «Отложить»/«Убрать» пишут только exceptions — расписание не меняется
 * (требование 86cb7451). «Отложить» считается от МОМЕНТА ВХОЖДЕНИЯ (как в
 * панели задач), адрес вхождения уходит на сервер (`occurrence_at`): `until` от
 * «сейчас» сервер отвергает для вхождений дальше суток.
 *
 * Подписи строит `lib/reminder-label.ts` (общий словарь с облачком и панелью);
 * формат меню — `lib/menu.ts`. Подписка на `reminders.changed` — одна на модуль
 * (реестр живых флагов), как у индикаторов облачков (`lib/cloud-indicators.ts`).
 */

import type { Reminder } from '@etn/shared';

import { shiftInstant } from '../lib/dates.js';
import { closeMenu, menuAction, menuSubmenu, showMenuAt, MENU_SEPARATOR } from '../lib/menu.js';
import { openReminderEditor } from '../lib/reminder-editor.js';
import { reminderLabel, remindersFlagText } from '../lib/reminder-label.js';
import { errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { onRoutedRealtimeEvent } from '../lib/live/index.js';
import { notice } from '../lib/notice.js';
import { uiButton } from '../lib/ui/button.js';
import { store } from '../state.js';

/** Класс флага (DOM-пробы и сторож). */
export const REMINDER_FLAG_CLASS = 'editor-reminder-flag';

/** Открытие редактора напоминания (шов подмены в тестах). */
export type ReminderEditorOpener = typeof openReminderEditor;

/** Опции создания флага. */
export interface ReminderFlagOptions {
  networkId: string;
  thoughtId: string;
  thoughtTitle: string;
  /** Напоминания субъекта изменились (открытые списки/бейдж перечитывают). */
  onChange?: () => void;
  /** Подмена редактора: тесты проверяют «клик ведёт в редактор» без диалога. */
  openEditor?: ReminderEditorOpener;
}

/** Рукоятка флага: перечитать после смены мысли в том же редакторе. */
export interface ReminderFlagHandle {
  root: HTMLButtonElement;
  /** Перечитать напоминания субъекта и обновить подпись. */
  refresh: () => Promise<void>;
  /** Перевести флаг на другую мысль (шапка редактора живёт при смене сущности). */
  setTarget: (thoughtId: string, thoughtTitle: string) => void;
}

/** Сдвиги «Отложить»: тот же набор, что у панели задач. */
const SNOOZE_SHIFTS: ReadonlyArray<{
  labelKey: 'tasks.shiftDay' | 'tasks.shiftWeek' | 'tasks.shiftMonth';
  shift: { days?: number; months?: number };
}> = [
  { labelKey: 'tasks.shiftDay', shift: { days: 1 } },
  { labelKey: 'tasks.shiftWeek', shift: { days: 7 } },
  { labelKey: 'tasks.shiftMonth', shift: { months: 1 } },
];

/** Живой флаг в реестре подписки `reminders.changed`. */
interface LiveFlag {
  networkId: string;
  root: HTMLElement;
  refresh: () => Promise<void>;
}

const liveFlags = new Set<LiveFlag>();
let flagsSubscription: (() => void) | null = null;

/**
 * Зарегистрировать флаг в ЕДИНОЙ подписке на `reminders.changed`: второй
 * клиент/панель меняет напоминания — шапка обновляет подпись без перезагрузки
 * редактора. Подписка одна на модуль: пересборка шапки создаёт новый флаг, а
 * старый узел отваливается и выпадает из реестра по `isConnected`.
 */
function watchFlag(flag: LiveFlag): void {
  liveFlags.add(flag);
  if (flagsSubscription !== null) return;
  flagsSubscription = onRoutedRealtimeEvent((event) => {
    if (event.type !== 'reminders.changed') return;
    for (const entry of [...liveFlags]) {
      if (entry.root.isConnected === false) {
        liveFlags.delete(entry);
        continue;
      }
      if (event.network_id !== entry.networkId) continue;
      void entry.refresh();
    }
  });
}

/** Сброс реестра подписки (тесты; в рантайме не вызывается). */
export function resetReminderFlagsForTests(): void {
  flagsSubscription?.();
  flagsSubscription = null;
  liveFlags.clear();
}

/**
 * Создать флаг напоминаний. `refresh()` вызывается при сборке шапки, смене
 * мысли (`headerRetarget`), после каждой команды меню и по `reminders.changed`.
 */
export function createReminderFlag(options: ReminderFlagOptions): ReminderFlagHandle {
  // Кнопка — фасад словаря `lib/ui/button.ts` (ghost): флаг выглядит как
  // текстовая команда рядом с отметкой «Актуально», своего контрола нет.
  const root = uiButton({ role: 'ghost', size: 's', class: REMINDER_FLAG_CLASS });
  root.hidden = true;
  const openEditor = options.openEditor ?? openReminderEditor;
  let subjectId = options.thoughtId;
  let subjectTitle = options.thoughtTitle;
  let reminders: Reminder[] = [];

  const notifyChanged = (): void => {
    options.onChange?.();
  };

  /** Перечитать напоминания субъекта. */
  const refresh = async (): Promise<void> => {
    try {
      const result = await etn.reminders.list(options.networkId, {
        subject_type: 'thought',
        subject_id: subjectId,
      });
      // Только живые строки: снятое напоминание не должно давать подпись,
      // пункт меню и «есть напоминания» — иначе пустое состояние не наступит.
      reminders = result.reminders.filter((reminder) => reminder.state === 'active');
      const text = remindersFlagText(reminders);
      // Ноль напоминаний — не пустое место, а команда создания первого: другой
      // точки `reminders.create` в клиенте нет (блокер приёмки 173f1540).
      const createLabel = t('reminder.addFlag');
      root.textContent = text === '' ? createLabel : text;
      root.hidden = false;
      root.title = t('reminder.flagTitle');
      root.setAttribute(
        'aria-label',
        text === '' ? createLabel : `${t('reminder.flagTitle')}: ${text}`,
      );
    } catch {
      // Недоступный сервер/сеть: флаг не мешает работе редактора и не предлагает
      // команду, которая гарантированно не сохранится.
      root.hidden = true;
    }
  };

  /** Выполнить команду и перечитать флаг. */
  const runAction = (action: () => Promise<unknown>): void => {
    void action()
      .then(() => refresh())
      .then(() => notifyChanged())
      .catch((err: unknown) => notice(t('reminder.actionFailed', [errText(err)]), 'error'));
  };

  /**
   * «Отложить» вхождение: `until` считается от МОМЕНТА ВХОЖДЕНИЯ, а не от
   * «сейчас» (сервер требует `until` строго позже вхождения — иначе 400,
   * блокер приёмки). Адрес вхождения — ближайшее необработанное (`next_at`),
   * тем же полем его адресует панель задач.
   */
  const snooze = (reminder: Reminder, shift: { days?: number; months?: number }): void => {
    const occurrence = reminder.next_at;
    if (occurrence === null) return;
    runAction(() =>
      etn.reminders.snooze(
        options.networkId,
        reminder.id,
        shiftInstant(occurrence, shift),
        occurrence,
      ),
    );
  };

  /** Меню действий одного напоминания. */
  const reminderMenu = (reminder: Reminder): ReturnType<typeof menuAction> => {
    // Подпись пункта — СВОЯ у каждого напоминания (повтор/момент), иначе подменю
    // нескольких напоминаний выглядели бы одинаково.
    const label = reminderLabel(reminder) || t('reminder.flagTitle');
    const hasOccurrence = reminder.next_at !== null;
    return menuSubmenu(label, [
      menuAction(t('reminder.editSchedule'), () => {
        void openEditor({
          subjectType: 'thought',
          subjectId: subjectId,
          reminder,
          subjectTitle: subjectTitle,
          onSaved: () => {
            void refresh().then(notifyChanged);
          },
        });
      }),
      menuSubmenu(
        t('reminder.snoozeOccurrence'),
        SNOOZE_SHIFTS.map((item) =>
          menuAction(t(item.labelKey), () => snooze(reminder, item.shift), {
            disabled: !hasOccurrence,
          }),
        ),
        { disabled: !hasOccurrence },
      ),
      menuAction(
        t('reminder.dismissOccurrence'),
        () =>
          runAction(() =>
            etn.reminders.dismiss(options.networkId, reminder.id, reminder.next_at ?? undefined),
          ),
        { disabled: !hasOccurrence },
      ),
      menuAction(t('reminder.remove'), () =>
        runAction(() => etn.reminders.remove(options.networkId, reminder.id)),
      ),
    ]);
  };

  /** Меню флага: создать + действия по каждому напоминанию субъекта. */
  const openMenu = (): void => {
    const rect = root.getBoundingClientRect();
    const items = [
      menuAction(t('reminder.create'), () => {
        void openEditor({
          subjectType: 'thought',
          subjectId: subjectId,
          subjectTitle: subjectTitle,
          onSaved: () => {
            void refresh().then(notifyChanged);
          },
        });
      }),
      MENU_SEPARATOR,
      ...reminders.map((reminder) => reminderMenu(reminder)),
    ];
    showMenuAt(rect.left, rect.bottom, items, { keyboard: true });
  };

  root.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (reminders.length === 0) {
      // Напоминаний нет — сразу редактор: меню из одного пункта бессмысленно.
      void openEditor({
        subjectType: 'thought',
        subjectId: subjectId,
        subjectTitle: subjectTitle,
        onSaved: () => {
          void refresh().then(notifyChanged);
        },
      });
      return;
    }
    if (store.state.networkId === null) return;
    openMenu();
  });

  // Клавиатура: `<button>` активируется Enter/Space нативно — локальный
  // keydown-перехват не нужен (единственная точка перехвата — lib/keymap.ts).

  watchFlag({ networkId: options.networkId, root, refresh });
  void refresh();

  return {
    root,
    refresh,
    setTarget: (thoughtId, thoughtTitle) => {
      subjectId = thoughtId;
      subjectTitle = thoughtTitle;
      closeMenu();
      void refresh();
    },
  };
}
