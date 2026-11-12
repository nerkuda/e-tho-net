/**
 * Общая измерительная обвязка переполнения и потолок строк-записей (0.15.4,
 * тех.проект 43329662, задача 33ed043c, ADR 8f0e9412).
 *
 * **Переполнение чипов.** Строка дневниковой записи показывает столько чипов
 * привязок, сколько помещается по ширине; остаток уходит в кнопку «+N» с
 * выпадающим меню — паттерн нижней строки истории посещений (элемент 554e3129).
 * Модуль создан ПО ОБРАЗЦУ экранного кода `screens/history-bar.ts`
 * (`layoutChips` + `ResizeObserver` + кнопка «+N»): сама полоса истории в этой
 * версии НЕ переделывается, поэтому в коде временно живут две копии обвязки —
 * осознанное дублирование до отдельной задачи унификации (граница задачи,
 * уточнение P1 карточки). Расчёт видимого набора — общий чистый
 * {@link planHistoryChips} (`lib/pure.ts`), он же используется полосой истории.
 *
 * **Потолок строк-записей.** Вкладка «Упоминания» рендерит не больше N
 * строк-записей и подписывает срез «Показано N из M» (визуальный паттерн
 * «Публикаций», НЕ серверный механизм: сервер отдаёт все строки). Срез и
 * подпись — {@link planRecordCap}; ключ подписи — отдельный `records.more`
 * (не `publications.mentions.more`: там M — серверный total публикаций).
 * Потребитель — задача ae72e47e; в группе поиска «Найдено в хронологии»
 * потолок не применяется (`by_chrono` схлопнут до одного хита на владельца,
 * N2 карточки).
 */

import { t } from './i18n.js';
import { HISTORY_BAR_MORE_RESERVE, planHistoryChips, type HistoryChipPlan } from './pure.js';

/** Ширина кнопки «+N» по умолчанию до измерения (запас как у полосы истории). */
const MORE_BUTTON_FALLBACK_WIDTH = HISTORY_BAR_MORE_RESERVE;

/** Опции полосы чипов с переполнением. */
export interface ChipOverflowOptions {
  /** Контейнер полосы (чипы + кнопка «+N»). */
  host: HTMLElement;
  /**
   * Кнопка «+N»: `count` — число непоместившихся чипов, `onOpen` — открыть их
   * меню. Кнопку строит потребитель (у полосы истории и у строки записи свои
   * подписи/виды), обвязка отвечает только за измерение и раскладку.
   */
  buildMore: (count: number, onOpen: () => void) => HTMLElement;
  /** Меню непоместившихся чипов: якорь — сама кнопка «+N». */
  openRest: (rest: readonly HTMLElement[], anchor: HTMLElement) => void;
}

/** Полоса чипов с переполнением: перерисовка набора и снятие наблюдателя. */
export interface ChipOverflowStrip {
  /** Показать новый набор чипов (элементы переиспользуются как есть). */
  paint(chips: readonly HTMLElement[]): void;
  /** Снять `ResizeObserver` и отменить запланированный пересчёт. */
  destroy(): void;
}

/** Полоса чипов с кнопкой «+N» и пересчётом по ширине контейнера. */
export function mountChipOverflow(options: ChipOverflowOptions): ChipOverflowStrip {
  const { host, buildMore, openRest } = options;
  let chips: readonly HTMLElement[] = [];
  let frame: number | null = null;

  /** Раскладка по измеренным ширинам: показать/свернуть по плану. */
  const mount = (plan: HistoryChipPlan): void => {
    host.replaceChildren();
    if (plan.restCount === 0) {
      // Всё помещается — кнопки нет (§11.1: нет N — нет «+N»).
      for (const chip of chips) host.append(chip);
      return;
    }
    if (!plan.moreFits || plan.shownCount === 0) {
      // Крайне узкая полоса: кнопка не оставляет места ни одному чипу —
      // показываем чипы с обрезкой по краю, а не одинокую «+N»
      // (регрессия a1c7c8dc).
      for (const chip of chips) host.append(chip);
      return;
    }
    const rest = chips.slice(plan.shownCount);
    for (const chip of chips.slice(0, plan.shownCount)) host.append(chip);
    const more = buildMore(rest.length, () => openRest(rest, more));
    host.append(more);
  };

  /** Пересчёт: ширина контейнера и естественные ширины чипов. */
  const render = (): void => {
    host.replaceChildren();
    if (chips.length === 0) return;
    // Чипы сначала попадают в контейнер: у них `flex: 0 0 auto`, поэтому каждая
    // сообщает ЕСТЕСТВЕННУЮ ширину, а не сжимается по полосе. `scrollWidth`
    // контейнера для замера не годится — у полосы `overflow: visible`, он не
    // растёт за `clientWidth` (класс ошибок 3ccacc1c).
    for (const chip of chips) host.append(chip);
    const hostWidth = host.clientWidth;
    // Не разложено (контейнер ещё вне документа) — оставляем всё видимым:
    // следующий тик наблюдателя пересчитает по реальной ширине.
    if (hostWidth <= 0) return;
    const widths = chips.map((chip) => chip.getBoundingClientRect().width);
    // Реальную ширину кнопки меряем пробой — запас не завышается и не занижается.
    const probe = buildMore(chips.length, () => undefined);
    host.append(probe);
    const moreWidth = probe.getBoundingClientRect().width || MORE_BUTTON_FALLBACK_WIDTH;
    host.replaceChildren();
    mount(planHistoryChips(widths, hostWidth, HISTORY_BAR_MORE_RESERVE, moreWidth));
  };

  /** Пересчёт не чаще одного кадра (наблюдатель шлёт пачки тиков). */
  const schedule = (): void => {
    if (frame !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      render();
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = null;
      render();
    });
  };

  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
  observer?.observe(host);

  return {
    paint(next: readonly HTMLElement[]): void {
      chips = next;
      render();
    },
    destroy(): void {
      observer?.disconnect();
      if (frame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frame);
      }
      frame = null;
    },
  };
}

/**
 * Потолок рендера строк-записей (N2): сколько строк-записей показывается без
 * подписи. Осознанно клиентская константа — сервер отдаёт все строки.
 */
export const RECORD_ROWS_LIMIT = 20;

/** План среза строк-записей и подписи «Показано N из M». */
export interface RecordCapPlan<T> {
  /** Показанные строки (при M > N — первые N в порядке ответа). */
  shown: readonly T[];
  /** Всего строк-записей в ответе (M). */
  total: number;
  /** Подпись среза; `null` — подписи нет (M ≤ N или потолок отключён). */
  caption: string | null;
}

/**
 * Срез строк-записей по клиентскому потолку. Подпись — ТОЛЬКО при M > N
 * (DoD задачи: «Показано N из M»); при M ≤ N строки идут как есть, без подписи.
 * `limit <= 0` — потолок отключён (отладка/будущие режимы).
 */
export function planRecordCap<T>(
  rows: readonly T[],
  limit: number = RECORD_ROWS_LIMIT,
): RecordCapPlan<T> {
  const total = rows.length;
  if (limit <= 0 || total <= limit) return { shown: rows, total, caption: null };
  return { shown: rows.slice(0, limit), total, caption: t('records.more', [limit, total]) };
}
