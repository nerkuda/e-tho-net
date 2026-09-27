/**
 * Состояние группы дат ленты «Дневника» (0.10.1, итерация приёмки №11, задача
 * 45df70ed; требование 165323a7, «Устойчивость»).
 *
 * Свёрнутость группы переключается НА МЕСТЕ: узлы ленты не пересобираются,
 * поэтому сохраняются фокус клавиатурной навигации и позиция прокрутки
 * (ошибки ab78e7b5 — после разворачивания свёрнутой группы стрелки переставали
 * двигать выделение, и 407b1827 — список прыгал в начало). Полная пересборка
 * ленты при сворачивании группы теряла фокус и позицию.
 *
 * Модуль оперирует только классами/атрибутами/`hidden` (без Electron и сети),
 * поэтому проверяется DOM-тестом на шиме и остаётся отделённым от крупного
 * `chronicle.ts`.
 */

/** Подписи кнопки-заголовка группы (берутся из словаря вызывающим). */
export interface DayGroupLabels {
  /** Подсказка свёрнутой группы («Развернуть»). */
  expand: string;
  /** Подсказка развёрнутой группы («Свернуть»). */
  collapse: string;
}

/** Значение ключа дня секции (`null` — атрибут не задан). */
function sectionDay(section: HTMLElement): string | null {
  const value = section.dataset?.['day'] ?? section.getAttribute?.('data-day') ?? '';
  return value === '' ? null : value;
}

/** Секция дня по локальному ключу `YYYY-MM-DD` (или `null`, если её нет в ленте). */
export function findDaySection(root: HTMLElement, day: string): HTMLElement | null {
  for (const section of Array.from(root.querySelectorAll<HTMLElement>('.diary-day'))) {
    if (sectionDay(section) === day) return section;
  }
  return null;
}

/**
 * Привести группу дня к состоянию `collapsed` НА МЕСТЕ: класс секции, `hidden`
 * списка записей, подпись и `aria-expanded` заголовка. Существующие узлы не
 * заменяются, поэтому фокус и прокрутка не теряются.
 */
export function applyDayCollapsed(
  section: HTMLElement,
  collapsed: boolean,
  labels: DayGroupLabels,
): void {
  section.classList?.toggle('is-collapsed', collapsed);
  const head = section.querySelector<HTMLElement>('.diary-day-head');
  if (head !== null) {
    head.classList?.toggle('is-collapsed', collapsed);
    head.setAttribute?.('aria-expanded', collapsed ? 'false' : 'true');
    head.title = collapsed ? labels.expand : labels.collapse;
  }
  const list = section.querySelector<HTMLElement>('.diary-day-list');
  if (list !== null) list.hidden = collapsed;
}
