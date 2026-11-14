/**
 * Флаг напоминаний в шапке редактора мысли (0.16.1, задача 173f1540; элемент
 * интерфейса 24ad3735).
 *
 * Рядом с отметкой «Актуально» показывается ЧЕЛОВЕКОЧИТАЕМОЕ представление
 * повтора («ежегодно 8 марта», «каждое 18-е»), а не просто признак «есть
 * напоминание» (решение пользователя 0.16.1). Несколько напоминаний
 * перечисляются через «·»; напоминаний нет — флага нет вовсе.
 *
 * Клик открывает меню действий по напоминаниям субъекта: создать, изменить
 * расписание, отложить текущее вхождение, убрать его и удалить напоминание.
 * «Отложить»/«Убрать» пишут только exceptions — расписание не меняется
 * (требование 86cb7451).
 *
 * Подписи строит `lib/reminder-label.ts` (общий словарь с облачком и панелью);
 * формат меню — `lib/menu.ts`.
 */

import type { Reminder } from '@etn/shared';

import { closeMenu, menuAction, menuSubmenu, showMenuAt, MENU_SEPARATOR } from '../lib/menu.js';
import { openReminderEditor } from '../lib/reminder-editor.js';
import { remindersFlagText } from '../lib/reminder-label.js';
import { errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { notice } from '../lib/notice.js';
import { uiButton } from '../lib/ui/button.js';
import { store } from '../state.js';

/** Класс флага (DOM-пробы и сторож). */
export const REMINDER_FLAG_CLASS = 'editor-reminder-flag';

/** Опции создания флага. */
export interface ReminderFlagOptions {
  networkId: string;
  thoughtId: string;
  thoughtTitle: string;
  /** Напоминания субъекта изменились (открытые списки/бейдж перечитывают). */
  onChange?: () => void;
}

/** Рукоятка флага: перечитать после смены мысли в том же редакторе. */
export interface ReminderFlagHandle {
  root: HTMLButtonElement;
  /** Перечитать напоминания субъекта и обновить подпись. */
  refresh: () => Promise<void>;
  /** Перевести флаг на другую мысль (шапка редактора живёт при смене сущности). */
  setTarget: (thoughtId: string, thoughtTitle: string) => void;
}

/** Сдвиг «сейчас» на N суток (для меню «Отложить»). */
function plusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** Сдвиг «сейчас» на N месяцев. */
function plusMonths(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return date.toISOString();
}

/**
 * Создать флаг напоминаний. `refresh()` вызывается при сборке шапки, смене
 * мысли (`headerRetarget`) и после каждой команды меню.
 */
export function createReminderFlag(options: ReminderFlagOptions): ReminderFlagHandle {
  // Кнопка — фасад словаря `lib/ui/button.ts` (ghost): флаг выглядит как
  // текстовая команда рядом с отметкой «Актуально», своего контрола нет.
  const root = uiButton({ role: 'ghost', size: 's', class: REMINDER_FLAG_CLASS });
  root.hidden = true;
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
      reminders = result.reminders;
      root.textContent = remindersFlagText(reminders);
      root.hidden = root.textContent === '';
      root.title = t('reminder.flagTitle');
      root.setAttribute('aria-label', `${t('reminder.flagTitle')}: ${root.textContent}`);
    } catch {
      // Недоступный сервер/сеть: флаг не мешает работе редактора.
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

  /** Меню действий одного напоминания. */
  const reminderMenu = (reminder: Reminder): ReturnType<typeof menuAction> =>
    menuSubmenu(root.textContent === '' ? t('reminder.flagTitle') : root.textContent, [
      menuAction(t('reminder.editSchedule'), () => {
        void openReminderEditor({
          subjectType: 'thought',
          subjectId: subjectId,
          reminder,
          subjectTitle: subjectTitle,
          onSaved: () => {
            void refresh().then(notifyChanged);
          },
        });
      }),
      menuSubmenu(t('reminder.snoozeOccurrence'), [
        menuAction(t('tasks.shiftDay'), () =>
          runAction(() => etn.reminders.snooze(options.networkId, reminder.id, plusDays(1))),
        ),
        menuAction(t('tasks.shiftWeek'), () =>
          runAction(() => etn.reminders.snooze(options.networkId, reminder.id, plusDays(7))),
        ),
        menuAction(t('tasks.shiftMonth'), () =>
          runAction(() => etn.reminders.snooze(options.networkId, reminder.id, plusMonths(1))),
        ),
      ]),
      menuAction(t('reminder.dismissOccurrence'), () =>
        runAction(() => etn.reminders.dismiss(options.networkId, reminder.id)),
      ),
      menuAction(t('reminder.remove'), () =>
        runAction(() => etn.reminders.remove(options.networkId, reminder.id)),
      ),
    ]);

  /** Меню флага: создать + действия по каждому напоминанию субъекта. */
  const openMenu = (): void => {
    const rect = root.getBoundingClientRect();
    const items = [
      menuAction(t('reminder.create'), () => {
        void openReminderEditor({
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
      // Напоминаний нет — сразу редактор, меню из одного пункта бессмысленно.
      void openReminderEditor({
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
