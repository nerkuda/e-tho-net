/**
 * Состояние сворачиваемой ЗАПИСИ ленты «Дневника» (0.10.2, задача 41ed99ab;
 * элемент «Лента дневных записей» e01f383a).
 *
 * Заголовок записи — сворачиваемая группа: одиночный клик по заголовку (или
 * ←/→, когда текущее поле — заголовок) скрывает/показывает ТОЛЬКО тело
 * комментария. Строка «период + мысли + меню» и сам заголовок остаются
 * видимыми всегда. Единица свёрнутости — ВХОЖДЕНИЕ «локальный день + id
 * записи»: копия длительной записи в другом дне сворачивается независимо.
 *
 * Переключение — НА МЕСТЕ: узлы карточки не пересобираются, поэтому
 * сохраняются фокус клавиатурной навигации и позиция прокрутки (те же грабли,
 * что у групп дня: ab78e7b5 — терялось выделение, 407b1827 — прыжок прокрутки
 * в начало). Свёрнутость переприменяется при keyed-обновлении карточки и
 * realtime, а не теряется вместе с пересборкой.
 *
 * Модуль оперирует только классами/атрибутами/`hidden` (без Electron и сети),
 * поэтому проверяется DOM-тестом на шиме и остаётся отделённым от крупного
 * `chronicle.ts`; зеркало группы дня — `./day-groups.js`.
 */

/** Подписи заголовка записи (берутся из словаря вызывающим). */
export interface RecordGroupLabels {
  /** Подсказка развёрнутой записи («Свернуть»). */
  collapse: string;
  /** Подсказка свёрнутой записи («Развернуть»). */
  expand: string;
}

/** Класс заголовка записи (кнопка в просмотре, поле ввода в правке). */
export const RECORD_TITLE_CLASS = 'diary-record-title';
/** Класс поля ввода заголовка в режиме правки. */
export const RECORD_TITLE_INPUT_CLASS = 'diary-record-title-input';

/**
 * Ключ вхождения записи для набора свёрнутых: «локальный день + id записи».
 * Разделитель `\u0000` не встречается ни в дате, ни в id.
 */
export function recordCollapseKey(day: string, id: string): string {
  return `${day}\u0000${id}`;
}

/** Секция дня карточки (ближайший предок с атрибутом `data-day`). */
export function dayOfCard(card: HTMLElement): string | null {
  let current: HTMLElement | null =
    (card as unknown as { parentElement?: HTMLElement | null }).parentElement ??
    (card as unknown as { parent?: HTMLElement | null }).parent ?? null;
  while (current !== null) {
    const value =
      current.dataset?.['day'] ?? current.getAttribute?.('data-day') ?? '';
    if (value !== '') return value;
    current =
      (current as unknown as { parentElement?: HTMLElement | null }).parentElement ??
      (current as unknown as { parent?: HTMLElement | null }).parent ?? null;
  }
  return null;
}

/** Карточка записи по вхождению «день + id» в текущем DOM ленты. */
export function findRecordCard(root: HTMLElement, day: string, id: string): HTMLElement | null {
  for (const section of Array.from(root.querySelectorAll<HTMLElement>('.diary-day'))) {
    const sectionDay = section.dataset?.['day'] ?? section.getAttribute?.('data-day') ?? '';
    if (sectionDay !== day) continue;
    for (const card of Array.from(section.querySelectorAll<HTMLElement>('.diary-record'))) {
      if ((card.getAttribute?.('data-row-key') ?? '') === id) return card;
    }
  }
  return null;
}

/**
 * Привести запись к состоянию `collapsed` НА МЕСТЕ: класс карточки, `hidden`
 * тела, `aria-expanded` и подсказка заголовка. Существующие узлы не
 * заменяются — фокус на заголовке и прокрутка не теряются.
 */
export function applyRecordCollapsed(
  card: HTMLElement,
  collapsed: boolean,
  labels: RecordGroupLabels,
): void {
  card.classList?.toggle('is-collapsed', collapsed);
  const title = card.querySelector<HTMLElement>(`.${RECORD_TITLE_CLASS}`);
  if (title !== null) {
    title.setAttribute?.('aria-expanded', collapsed ? 'false' : 'true');
    title.title = collapsed ? labels.expand : labels.collapse;
  }
  const body = card.querySelector<HTMLElement>('.diary-record-body');
  if (body !== null) body.hidden = collapsed;
}
